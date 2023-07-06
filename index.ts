import { APIGatewayEventRequestContextV2, APIGatewayProxyEventV2WithRequestContext, APIGatewayProxyResultV2 } from 'aws-lambda';
import { TwitterApi, TwitterApiTokens } from 'twitter-api-v2';
import * as Misskey from 'misskey-js';

const twitter = new TwitterApi({
  appKey: process.env.TWITTER_APP_KEY,
  appSecret: process.env.TWITTER_APP_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
} as TwitterApiTokens);

async function handler(event: APIGatewayProxyEventV2WithRequestContext<APIGatewayEventRequestContextV2>) {
  const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  const note = JSON.parse(body.toString()).body.note as Misskey.entities.Note;

  if (event.headers['x-misskey-hook-secret'] !== process.env.MISSKEY_HOOK_SECRET) {
    throw new Error('Invalid secret.');
  }

  if (note.userId !== process.env.MISSKEY_USER_ID) {
    throw new Error('Invalid user.');
  }

  const mediaList: string[] = [];

  if (note.files.length > 4) {
    throw new Error('Too many files.');
  }

  for (const file of note.files) {
    const media = await uploadMediaToTwitter(file);

    mediaList.push(media);
  }

  const tweet = await twitter.v1.tweet(note.text, {
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

async function uploadMediaToTwitter(file: Misskey.entities.DriveFile): Promise<string> {
  const response = await fetch(file.url);
  const buffer = await response.arrayBuffer();

  const media = await twitter.v1.uploadMedia(Buffer.from(buffer), {
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

export { handler };
