import { APIGatewayEventRequestContextV2, APIGatewayProxyEventV2WithRequestContext, APIGatewayProxyResultV2 } from 'aws-lambda';
import { TwitterApi, TwitterApiTokens } from 'twitter-api-v2';
import fetch from 'node-fetch';
import * as Misskey from 'misskey-js';

interface User {
  misskeyId: string;
  secret: string;
  twitterApiVersion: 'v1' | 'v2';
  twitterApiTokens: TwitterApiTokens;
}

const usermap = JSON.parse(process.env.USERMAP) as User[];

export async function handler(event: APIGatewayProxyEventV2WithRequestContext<APIGatewayEventRequestContextV2>) {
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

  const note = data.body.note as Misskey.entities.Note & {
    tags?: string[];
    mentions?: string[];
  };
  let text = note.text;

  if (note.tags?.find(tag => tag.toLowerCase() === 'nocp')) {
    return buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'NOCP',
      }),
      contentType: 'application/json',
    });
  }

  if (note.mentions?.length > 0) {
    return buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'MENTION_NOT_SUPPORTED',
      }),
      contentType: 'application/json',
    });
  }

  if (note.visibility !== 'public') {
    return buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'VISIBILITY_NOT_PUBLIC',
      }),
      contentType: 'application/json',
    });
  }

  if (note.reply) {
    return buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'REPLY_NOT_SUPPORTED',
      }),
      contentType: 'application/json',
    });
  }

  if (note.renote) {
    return buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'RENOTE_NOT_SUPPORTED',
      }),
      contentType: 'application/json',
    });
  }

  const userId = `${note.userId}@${host}`;

  const user = getUser(userId);

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

  const tags: string[] = [];

  if (note.poll) {
    tags.push('투표');
  }

  if (note.cw) {
    text = note.cw;

    tags.push('CW 설정된 글');
  }

  if (note.files.find(file => file.isSensitive)) {
    tags.push('민감한 파일 포함');
  }

  if (note.files.filter(isFileVideo).length > 1) {
    tags.push('다중 동영상 포함');
  }

  if (note.files.find(file => !isFileTwitterEmbedable(file))) {
    tags.push('첨부 파일 포함');
  }

  const client = new TwitterApi(user.twitterApiTokens);

  const mediaList: string[] = [];

  if (note.text.length > 180) {
    tags.push('장문');

    text = note.text.slice(0, 180);

    text += '…';
  }

  text = text.trim();

  let videoUploaded = false;

  for (const file of note.files.filter(file => !file.isSensitive).filter(isFileTwitterEmbedable)) {
    if (mediaList.length >= 4) {
      tags.push('5개 이상의 이미지');

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

  if (tags.length > 0) {
    text += `\n\n(${tags.sort().join(', ')})`;

    text += `\n\n전체 내용 읽기: https://${host}/notes/${note.id}`;
  }

  switch(user.twitterApiVersion) {
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

function getUser(userId: string): User | null {
  const user = usermap.find(user => user.misskeyId === userId);

  if (!user) {
    return null;
  }

  return user;
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
