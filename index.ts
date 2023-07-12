import { APIGatewayEventRequestContextV2, APIGatewayProxyEventV2WithRequestContext, APIGatewayProxyResultV2 } from 'aws-lambda';
import { TwitterApi, TwitterApiTokens } from 'twitter-api-v2';
import fetch from 'node-fetch';
import * as Misskey from 'misskey-js';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import path from 'path';
import axios from 'axios';

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

export async function handler(event: APIGatewayProxyEventV2WithRequestContext<APIGatewayEventRequestContextV2>): Promise<APIGatewayProxyResultV2> {
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  const data = JSON.parse(rawBody.toString());
  const host = event.headers['x-misskey-host'];

  if (data.type !== 'note') {
    return buildResponse({
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

  console.log(`Request from ${note.user.id}@${host} (@${note.user.username}@${host})`)

  if (!isValidRequest(note)) {
    return buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'INVALID_REQUEST',
      }),
      contentType: 'application/json',
    });
  }

  const user = await getUser(`${note.userId}@${host}`);

  if (!user) {
    return buildResponse({
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

    return buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'INVALID_SECRET',
      }),
      contentType: 'application/json',
    });
  }

  if (note.renote && !user.confs.enableRenote) {
    return buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'RENOTE_NOT_ENABLED',
      }),
      contentType: 'application/json',
    });
  }

  if (note.tags?.find(tag => tag.toLowerCase() === user.confs.skipHashtag.toLowerCase())) {
    return buildResponse({
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

    return buildResponse({
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
      return buildResponse({
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
    switch(twitterApiConf.version) {
      case 'v1': {
        const tweet = await client.v1.tweet(tweetContent, {
          media_ids: mediaList.length > 0 ? mediaList.join(',') : undefined,
        });

        console.log(tweet);

        break;
      }

      case 'v2': {
        const tweet = await client.v2.tweet(tweetContent, {
          media: mediaList.length > 0 ? {
            media_ids: mediaList,
          } : undefined,
        });

        console.log(tweet);

        break;
      }

      default: {
        throw new Error('Invalid Twitter API version');
      }
    }

    return buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'OK',
      }),
      contentType: 'application/json',
    });
  } catch (e) {
    console.error(e);

    await sendErrorNotification(note.user.username, host, `트위터 API 오류입니다. API 키 4개가 모두 정상적으로 구성되었는지 확인해주세요.\n\n만약 정상적으로 동작하다가 이 문제가 발생했다면, 해당 사실을 여기에 답글로 적어주신 뒤 웹훅을 비활성화 하시고 기다려주세요. 관리자가 곧 도와드리겠습니다. (수신자를 편집하지 마세요!)\n\n(오류 메시지: ${e.errors?.[0]?.message ?? e.message})`);

    return buildResponse({
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

function buildResponse({ statusCode, body, contentType }: { statusCode: number, body: string | Buffer, contentType: string }): APIGatewayProxyResultV2 {
  console.log(body);

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

    return Object.assign({}, await getBaseProfile(user.baseProfile), user);
  } catch (e) {
    console.error(e);

    return null;
  }
}

async function getBaseProfile(profileName: string): Promise<User> {
  return JSON.parse((await readFile(path.resolve(process.env.LAMBDA_TASK_ROOT ?? __dirname, `./base_profiles/${profileName}.json`))).toString()) as User;
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

  if (note.reply) {
    console.log('Reply found; skipping');

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
  const targetUserResponse = await axios.post(`https://${process.env.MISSKEY_INSTANCE}/api/users/show`, JSON.stringify({
    username,
    host,
    i: process.env.MISSKEY_API_TOKEN,
  }), {
    headers: {
      'content-type': 'application/json',
    },
  });

  const targetUser = targetUserResponse.data as Misskey.entities.User;

  const adminUserResponse = await axios.post(`https://${process.env.MISSKEY_INSTANCE}/api/users/show`, JSON.stringify({
    username: process.env.MISSKEY_ADMIN,
    host: process.env.MISSKEY_INSTANCE,
    i: process.env.MISSKEY_API_TOKEN,
  }), {
    headers: {
      'content-type': 'application/json',
    },
  });

  const adminUser = adminUserResponse.data as Misskey.entities.User;

  await axios.post(`https://${process.env.MISSKEY_INSTANCE}/api/notes/create`, JSON.stringify({
    visibility: 'specified',
    visibleUserIds: Array.from(new Set<string>([ targetUser.id, adminUser.id ]).values()),
    text: message,
    i: process.env.MISSKEY_API_TOKEN,
  }), {
    headers: {
      'content-type': 'application/json',
    },
  });
}
