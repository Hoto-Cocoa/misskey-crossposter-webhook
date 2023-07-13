import { APIGatewayEventRequestContextV2, APIGatewayProxyEventV2WithRequestContext, APIGatewayProxyResultV2 } from 'aws-lambda';
import { TwitterApi, TwitterApiTokens } from 'twitter-api-v2';
import fetch from 'node-fetch';
import * as Misskey from 'misskey-js';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import path from 'path';
import axios from 'axios';
import { createClient } from 'redis';

type WebhookNote = Misskey.entities.Note & {
  tags?: string[];
  mentions?: string[];
};

interface User {
  misskeyId: string;
  secret: string;
  baseProfile: string;
  twitterApiConfs: UserTwitterApiConf[];
  confs: {
    enableRenote: boolean;
    enableTags: boolean;
    skipLinkRequired: boolean;
    alwaysIncludeLink: boolean;
    skipHashtag: string;
    cwTitleOnly: boolean;
    excludeNsfw: boolean;
  }
}

interface UserTwitterApiConf {
  visibility: Misskey.entities.Note['visibility'];
  version: 'v1' | 'v2';
  tokens: TwitterApiTokens;
}

const redisClient = createClient({
  url: process.env.REDIS_URL,
});

export async function handler(event: APIGatewayProxyEventV2WithRequestContext<APIGatewayEventRequestContextV2>): Promise<APIGatewayProxyResultV2> {
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  const data = JSON.parse(rawBody.toString());
  const host = event.headers['x-misskey-host'];

  if (data.type !== 'note') {
    return await buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'NOT_NOTE',
      }),
      contentType: 'application/json',
    });
  }

  const note = data.body.note as WebhookNote;
  const targetNote = note.renote ?? note;
  const chunks = [ note.renote?.text ?? note.text ?? '' ];

  console.log(`Request from ${note.user.id}@${host} (@${note.user.username}@${host})`);

  await redisClient.connect();

  if (await redisClient.get(`hotomoe-crossposter-worker:posted-note-id:${note.id}@${host}`)) {
    console.log('Already posted; skipping');

    return await buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'ALREADY_POSTED',
      }),
      contentType: 'application/json',
    });
  }

  if (!isValidRequest(note)) {
    return await buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'INVALID_REQUEST',
      }),
      contentType: 'application/json',
    });
  }

  const user = await getUser(`${note.userId}@${host}`);

  if (!user) {
    return await buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'USER_NOT_FOUND',
      }),
      contentType: 'application/json',
    });
  }

  if (event.headers['x-misskey-hook-secret'] !== user.secret) {
    console.log(`Invalid secret; Expected ${user.secret}, got ${event.headers['x-misskey-hook-secret']}`);

    await sendErrorNotification(note.user.username, host, `웹훅 Secret 설정 오류입니다. https://cp.hoto.moe 페이지를 참고해서 설정을 변경해주세요. 만약 정상적으로 사용하다 이 문제가 발생했으면, 누군가 악의적인 목적을 가지고 해킹을 시도중일 수 있습니다. 이 경우 여기에 답글을 달아 관리자에게 알려주세요. (수신자를 편집하지 마세요!)`);

    return await buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'INVALID_SECRET',
      }),
      contentType: 'application/json',
    });
  }

  if (note.renote && !user.confs.enableRenote) {
    return await buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'RENOTE_NOT_ENABLED',
      }),
      contentType: 'application/json',
    });
  }

  if (note.tags?.find(tag => tag.toLowerCase() === user.confs.skipHashtag.toLowerCase())) {
    return await buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'NOCP',
      }),
      contentType: 'application/json',
    });
  }

  const tags = new Set<string>();

  if (targetNote.cw) {
    if (user.confs.cwTitleOnly) {
      chunks[0] = targetNote.cw;

      tags.add('CW 설정된 글');
    } else {
      chunks[0] = `${targetNote.cw}\n\n${chunks[0]}`;
    }
  }

  if (note.renote) {
    chunks[0] = `RENOTE @${targetNote.user.username}@${targetNote.user.host ?? host}: ${chunks[0]}`;

    tags.add('리노트');
  }

  if (getStringByteLength(chunks[0]) > 280) {
    tags.add('장문');
  }

  if (note.poll) {
    tags.add('투표');
  }

  if (note.files.find(file => isFileShouldNotIncluded(file, user))) {
    tags.add('민감한 파일 포함');
  }

  if (note.files.filter(isFileVideo).length > 1) {
    tags.add('다중 동영상 포함');
  }

  if (note.files.find(file => !isFileTwitterEmbedable(file))) {
    tags.add('첨부 파일 포함');
  }

  const twitterApiConf = user.twitterApiConfs.find(conf => conf.visibility === note.visibility);

  if (!twitterApiConf) {
    console.log(`Twitter API conf not found for visibility ${note.visibility}`);

    return await buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'TWITTER_API_CONF_NOT_FOUND',
      }),
      contentType: 'application/json',
    });
  }

  const client = new TwitterApi(twitterApiConf.tokens);

  const uploadTarget: Misskey.entities.DriveFile[] = [];
  const mediaList: string[] = [];

  chunks[0] = chunks[0].trim();

  for (const file of note.files.filter(file => !isFileShouldNotIncluded(file, user)).filter(isFileTwitterEmbedable)) {
    if (uploadTarget.length >= 4) {
      tags.add('5개 이상의 이미지');

      break;
    }

    if (isFileVideo(file) && uploadTarget.filter(isFileVideo).length > 0) {
      continue;
    }

    uploadTarget.push(file);
  }

  try {
    await Promise.all(uploadTarget.map(async (file, index) => {
      const media = await uploadMediaToTwitter(client, file);

      mediaList[index] = media;
    }));
  } catch (e) {
    console.error(e);

    tags.add('업로드 불가능한 미디어');
  }

  if (tags.size > 0) {
    if (user.confs.skipLinkRequired) {
      return await buildResponse({
        statusCode: 200,
        body: JSON.stringify({
          status: 'SKIP_LINK_REQUIRED',
        }),
        contentType: 'application/json',
      });
    }

    if (user.confs.enableTags) {
      chunks.push(`(${joinTags(tags)})`);
    }
  }

  if (tags.size > 0 || user.confs.alwaysIncludeLink) {
    chunks.push(`전체 내용 읽기: https://${host}/notes/${note.id}`);
  }

  let currentLength = getStringByteLength(buildTweetText(chunks));

  if (currentLength > 280) {
    tags.add('장문');

    if (user.confs.enableTags) {
      chunks[1] = `(${joinTags(tags)})`;
    }

    const maxLength =
      280 // Max tweet length
      - getStringByteLength('…') // Ellipsis
      - getStringByteLength(chunks[1]) // Tags
      - getStringByteLength(`전체 내용 읽기: `) // Link prefix
      - 23 // Link length
      - 4; // Newlines

    let text = '';

    for (const char of chunks[0]) {
      if (getStringByteLength(text) + getStringByteLength(char) > maxLength) {
        break;
      }

      text += char;
    }

    chunks[0] = text + '…';
  }

  const tweetContent = buildTweetText(chunks);

  try {
    const replyToTweetId = await redisClient.get(`hotomoe-crossposter-worker:posted-note-id:${note.reply?.id}@${host}`) ?? undefined;

    const tweetId = await sendTweet(client, twitterApiConf.version, tweetContent, mediaList, replyToTweetId);

    await redisClient.set(`hotomoe-crossposter-worker:posted-note-id:${note.id}@${host}`, tweetId);

    return await buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'OK',
      }),
      contentType: 'application/json',
    });
  } catch (e) {
    console.error(e);

    if (
      e.errors?.[0]?.code === 187 ||
      e.data?.detail === 'You are not allowed to create a Tweet with duplicate content.'
    ) {
      return await buildResponse({
        statusCode: 200,
        body: JSON.stringify({
          status: 'DUPLICATE_TWEET',
        }),
        contentType: 'application/json',
      });
    }

    let message = '';

    switch (e.data?.status) {
      case 401: {
        await redisClient.del(`hotomoe-crossposter-worker:profile:${createHash('md5').update(`${note.userId}@${host}`).digest('hex')}`);

        message = 'API 키 4개가 모두 정상적으로 구성되었는지 확인해주세요.\n\n만약 정상적으로 동작하다가 이 문제가 발생했다면, 해당 사실을 여기에 답글로 적어주신 뒤 웹훅을 비활성화 하시고 기다려주세요. 관리자가 곧 도와드리겠습니다. (수신자를 편집하지 마세요!)';

        break;
      }

      case 403: {
        await redisClient.del(`hotomoe-crossposter-worker:profile:${createHash('md5').update(`${note.userId}@${host}`).digest('hex')}`);

        message = 'API 키 4개가 모두 정상적으로 구성되었는지 확인해주세요.\n\n만약 정상적으로 동작하다가 이 문제가 발생했다면, 해당 사실을 여기에 답글로 적어주신 뒤 웹훅을 비활성화 하시고 기다려주세요. 관리자가 곧 도와드리겠습니다. (수신자를 편집하지 마세요!)';

        break;
      }

      case 503: {
        message = '트위터 API가 일시적으로 불안정합니다. 잠시 후 다시 시도해주세요.';

        break;
      }
    }

    await sendErrorNotification(note.user.username, host, `트위터 API 오류입니다. ${message}\n\n(오류 메시지: ${e.data?.detail ?? e.errors?.[0]?.message ?? e.message})`);

    return await buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'TWITTER_API_ERROR',
      }),
      contentType: 'application/json',
    });
  }
}

async function uploadMediaToTwitter(client: TwitterApi, file: Misskey.entities.DriveFile): Promise<string> {
  const response = await fetch(file.url);
  const buffer = await response.arrayBuffer();

  const media = await client.v1.uploadMedia(Buffer.from(buffer), {
    mimeType: file.type,
  });

  return media;
}

async function buildResponse({ statusCode, body, contentType }: { statusCode: number, body: string | Buffer, contentType: string }): Promise<APIGatewayProxyResultV2> {
  console.log(body);

  await redisClient.disconnect();

  return {
    statusCode,
    headers: {
      'content-type': contentType
    },
    body: Buffer.from(body).toString('base64'),
    isBase64Encoded: true,
  }
}

async function getUser(userId: string): Promise<User | null> {
  const hash = createHash('md5').update(userId).digest('hex');

  const cachedProfile = await redisClient.get(`hotomoe-crossposter-worker:profile:${hash}`);

  if (cachedProfile) {
    return JSON.parse(cachedProfile) as User;
  }

  const s3 = new S3Client({
    region: 'ap-northeast-2',
  });

  try {
    const { Body } = await s3.send(new GetObjectCommand({
      Bucket: `hotomoe-crossposter-${process.env.NODE_ENV}`,
      Key: `profiles/${hash}.json`,
    }));

    const user = JSON.parse(await Body.transformToString()) as User;

    if (user.misskeyId !== userId) {
      throw new Error(`User file is invalid; Expected ${userId}, got ${user.misskeyId}`);
    }

    const profile = mergeDeep(await getBaseProfile(user.baseProfile), user);

    await redisClient.set(`hotomoe-crossposter-worker:profile:${hash}`, JSON.stringify(profile), {
      EX: 60 * 5,
    });

    return profile;
  } catch (e) {
    console.error(e);

    return null;
  }
}

async function getBaseProfile(profileName: string): Promise<User> {
  return JSON.parse((await readFile(path.resolve(`./base_profiles/${profileName}.json`))).toString()) as User;
}

function isFileTwitterEmbedable(file: Misskey.entities.DriveFile): boolean {
  return isFileImage(file) || isFileVideo(file);
}

function isFileImage(file: Misskey.entities.DriveFile): boolean {
  return file.type.startsWith('image/');
}

function isFileVideo(file: Misskey.entities.DriveFile): boolean {
  return file.type.startsWith('video/');
}

function getStringByteLength(content: string): number {
  let ret = 0;

  for (const char of content) {
    const escaped = escape(char);
    if (escaped.startsWith('%u')) ret += (escaped.length - 2) / 2;
    else ret++;
  }

  return ret;
}

function buildTweetText(chunks: string[]): string {
  return chunks.join('\n\n');
}

function joinTags(tags: Set<string>): string {
  return Array.from(tags.values()).sort().join(', ');
}

function isValidRequest(note: WebhookNote): boolean {
  if (note.mentions?.length > 0) {
    console.log('Mentions found; skipping');

    return false;
  }

  if (note.reply && note.reply.userId !== note.userId) {
    console.log('Reply to other user found; skipping');

    return false;
  }

  if (note.visibility === 'specified') {
    console.log('Specified visibility found; skipping');

    return false;
  }

  return true;
}

function isFileShouldNotIncluded(file: Misskey.entities.DriveFile, user: User): boolean {
  if (file.isSensitive && user.confs.excludeNsfw) {
    return true;
  }

  return false;
}

async function sendErrorNotification(username: string, host: string, message: string): Promise<void> {
  const targetUserId =  await getMisskeyUserId(host, username);
  const adminUserId = await getMisskeyUserId(process.env.MISSKEY_INSTANCE, process.env.MISSKEY_ADMIN);

  await axios.post(`https://${process.env.MISSKEY_INSTANCE}/api/notes/create`, JSON.stringify({
    visibility: 'specified',
    visibleUserIds: Array.from(new Set<string>([ targetUserId, adminUserId ]).values()),
    text: message,
    i: process.env.MISSKEY_API_TOKEN,
  }), {
    headers: {
      'content-type': 'application/json',
    },
  });
}

async function getMisskeyUserId(host: string, username: string): Promise<string> {
  const cachedId = await redisClient.get(`hotomoe-crossposter-worker:user-id:${username}@${host}`);

  if (cachedId) {
    return cachedId;
  }

  const response = await axios.post(`https://${process.env.MISSKEY_INSTANCE}/api/users/show`, JSON.stringify({
    username,
    host,
    i: process.env.MISSKEY_API_TOKEN,
  }), {
    headers: {
      'content-type': 'application/json',
    },
  });

  const user = response.data as Misskey.entities.User;

  await redisClient.set(`hotomoe-crossposter-worker:user-id:${username}@${host}`, user.id, {
    EX: 60 * 60 * 24,
  });

  return user.id;
}

function isObject(item: any) {
  return (item && typeof item === 'object' && !Array.isArray(item));
}

function mergeDeep<T = object>(target: T, ...sources: T[]): T {
  if (!sources.length) return target;
  const source = sources.shift();

  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        mergeDeep(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }

  return mergeDeep(target, ...sources);
}

async function sendTweet(client: TwitterApi, version: 'v1' | 'v2', content: string, mediaIds: string[], replyTo?: string | undefined, retry?: boolean | undefined): Promise<string> {
  try {
    let tweetId: string;

    switch(version) {
      case 'v1': {
        const tweet = await client.v1.tweet(content, {
          in_reply_to_status_id: replyTo,
          media_ids: mediaIds.length > 0 ? mediaIds.join(',') : undefined,
        });

        console.log(tweet);

        tweetId = tweet.id_str;

        break;
      }

      case 'v2': {
        const tweet = await client.v2.tweet(content, {
          reply: replyTo ? {
            in_reply_to_tweet_id: replyTo,
          } : undefined,
          media: mediaIds.length > 0 ? {
            media_ids: mediaIds,
          } : undefined,
        });

        console.log(tweet);

        tweetId = tweet.data.id;

        break;
      }

      default: {
        throw new Error('Invalid Twitter API version');
      }
    }

    return tweetId;
  } catch (e) {
    if (e.response?.statusCode === 503 && !retry) {
      return await sendTweet(client, version, content, mediaIds, replyTo, true);
    }

    throw e;
  }
}
