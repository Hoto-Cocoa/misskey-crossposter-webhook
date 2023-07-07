import { APIGatewayEventRequestContextV2, APIGatewayProxyEventV2WithRequestContext, APIGatewayProxyResultV2 } from 'aws-lambda';
import { TwitterApi, TwitterApiTokens } from 'twitter-api-v2';
import fetch from 'node-fetch';
import * as Misskey from 'misskey-js';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import path from 'path';

type WebhookNote = Misskey.entities.Note & {
  tags?: string[];
  mentions?: string[];
};

interface User {
  misskeyId: string;
  secret: string;
  twitterApiConfs: UserTwitterApiConf[];
  confs: {
    enableRenote: boolean;
    enableTags: boolean;
    skipLinkRequired: boolean;
    alwaysIncludeLink: boolean;
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
  const chunks = [ note.text ];

  if (!isValidRequest(note)) {
    return buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'INVALID_REQUEST',
      }),
      contentType: 'application/json',
    });
  }

  if (note.tags?.find(tag => tag.toLowerCase() === 'nocp')) {
    return buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'NOCP',
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

  const tags = new Set<string>();

  if (getStringByteLength(note.text) > 280) {
    tags.add('장문');
  }

  if (note.poll) {
    tags.add('투표');
  }

  if (note.cw) {
    chunks[0] = note.cw;

    tags.add('CW 설정된 글');
  }

  if (note.files.find(file => file.isSensitive)) {
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
    return buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'TWITTER_API_CONF_NOT_FOUND',
      }),
      contentType: 'application/json',
    });
  }

  const client = new TwitterApi(twitterApiConf.tokens);

  const mediaList: string[] = [];

  chunks[0] = chunks[0].trim();

  let videoUploaded = false;

  for (const file of note.files.filter(file => !file.isSensitive).filter(isFileTwitterEmbedable)) {
    if (mediaList.length >= 4) {
      tags.add('5개 이상의 이미지');

      break;
    }

    if (isFileVideo(file) && videoUploaded) {
      continue;
    }

    const media = await uploadMediaToTwitter(client, file);

    mediaList.push(media);

    if (isFileVideo(file)) {
      videoUploaded = true;
    }
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

    chunks[1] = `(${joinTags(tags)})`;

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

  const text = buildTweetText(chunks);

  switch(twitterApiConf.version) {
    case 'v1': {
      const tweet = await client.v1.tweet(text, {
        media_ids: mediaList.length > 0 ? mediaList.join(',') : undefined,
      });

      console.log(tweet);

      break;
    }

    case 'v2': {
      const tweet = await client.v2.tweet(text, {
        media: mediaList.length > 0 ? {
          media_ids: mediaList,
        } : undefined,
      });

      console.log(tweet);

      break;
    }
  }

  return buildResponse({
    statusCode: 200,
    body: JSON.stringify({
      status: 'OK',
    }),
    contentType: 'application/json',
  });
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

  const { Body } = await s3.send(new GetObjectCommand({
    Bucket: `hotomoe-crossposter-${process.env.NODE_ENV}`,
    Key: `profiles/${hash}.json`,
  }));

  const user = JSON.parse(await Body.transformToString()) as User;

  if (user.misskeyId !== userId) {
    throw new Error('User file is invalid');
  }

  return Object.assign({}, await getBaseProfile('default'), user);
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
    return false
  }

  if (note.reply) {
    return false;
  }

  return true;
}
