import { APIGatewayEventRequestContextV2, APIGatewayProxyEventV2WithRequestContext, APIGatewayProxyResultV2 } from 'aws-lambda';
import { TwitterApi, TwitterApiTokens } from 'twitter-api-v2';
import * as Misskey from 'misskey-js';

interface User {
  misskeyId: string;
  twitterApiTokens: TwitterApiTokens;
}

const usermap = JSON.parse(process.env.USERMAP) as User[];

async function handler(event: APIGatewayProxyEventV2WithRequestContext<APIGatewayEventRequestContextV2>) {
  const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  const note = JSON.parse(body.toString()).body.note as Misskey.entities.Note;

  let linkRequired = false;

  let text = note.text;

  let postfix = '';

  const host = event.headers['x-misskey-host'];

  if (event.headers['x-misskey-hook-secret'] !== process.env.MISSKEY_HOOK_SECRET) {
    throw new Error('Invalid secret.');
  }

  if (note.reply) {
    throw new Error('Reply is not supported.');
  }

  if (note.renote) {
    throw new Error('Renote is not supported.');
  }

  if (note.poll) {
    linkRequired = true;

    postfix = '(투표)';
  }

  if (note.cw) {
    linkRequired = true;

    postfix = '(CW 설정된 글)';
  }

  if (note.files.find(file => file.isSensitive)) {
    linkRequired = true;

    postfix = '(민감한 파일 포함)';
  }

  const client = getTwitterClient(note.userId);

  const mediaList: string[] = [];

  if (note.files.length > 4) {
    linkRequired = true;
  }

  if (note.text.length > 200) {
    linkRequired = true;

    text = note.text.slice(0, 200);

    text += '…';
  }

  if (linkRequired) {
    text += `\n\n전체 내용 읽기: https://${host}/notes/${note.id}`;
  }

  if (postfix) {
    text += `\n\n${postfix}`;
  }

  text = text.trim();

  for (const file of note.files.filter(file => !file.isSensitive).filter(file => file.type.startsWith('image/')).slice(0, 4)) {
    const media = await uploadMediaToTwitter(client, file);

    mediaList.push(media);
  }

  const tweet = await client.v1.tweet(text, {
    media_ids: mediaList.join(','),
  });

  console.log(tweet);

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

function getTwitterClient(userId: string): TwitterApi {
  const user = usermap.find(user => user.misskeyId === userId);

  if (!user) {
    throw new Error('User not found.');
  }

  return new TwitterApi(user.twitterApiTokens);
}

export { handler };
