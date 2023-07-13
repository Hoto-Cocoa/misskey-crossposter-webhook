import { APIGatewayEventRequestContextV2, APIGatewayProxyEventV2WithRequestContext, APIGatewayProxyResultV2 } from 'aws-lambda';
import * as Misskey from 'misskey-js';
import { getHash, getUrlFileBuffer } from './utils.js';
import { WebhookNote } from './types/webhook.js';
import { User } from './types/user.js';
import { CacheService } from './services/CacheService.js';
import { ProfileService } from './services/ProfileService.js';
import { TwitterService } from './services/TwitterService.js';
import { MisskeyService } from './services/MisskeyService.js';

const cacheService = await CacheService.getInstance();
const profileService = new ProfileService(cacheService);
const misskeyService = new MisskeyService(cacheService);

export async function handler(event: APIGatewayProxyEventV2WithRequestContext<APIGatewayEventRequestContextV2>): Promise<APIGatewayProxyResultV2> {
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body!, 'base64') : event.body!;
  const data = JSON.parse(rawBody.toString());
  const host = event.headers['x-misskey-host'];

  if (!host) {
    return await buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'HOST_NOT_FOUND',
      }),
      contentType: 'application/json',
    });
  }

  if (!await isValidRequest(data, host)) {
    return await buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'INVALID_REQUEST',
      }),
      contentType: 'application/json',
    });
  }

  const note = data.body.note as WebhookNote;
  const targetNote = note.renote ?? note;
  const chunks = [ note.renote?.text ?? note.text ?? '' ];

  console.log(`Request from ${note.user.id}@${host} (@${note.user.username}@${host})`);

  const user = await profileService.getUserProfile(`${note.userId}@${host}`);

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

  if (note.files.find(file => !isFileIncludable(file, user))) {
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

  const twitterService = new TwitterService(twitterApiConf.version, twitterApiConf.tokens);

  const uploadTarget: Misskey.entities.DriveFile[] = [];
  const mediaList: string[] = [];

  chunks[0] = chunks[0].trim();

  for (const file of note.files.filter(file => isFileIncludable(file, user)).filter(isFileTwitterEmbedable)) {
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
      const buffer = await getUrlFileBuffer(file.url);

      const media = await twitterService.uploadMedia(buffer);

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
    const replyToTweetId = note.reply ? await cacheService.get('posted-note-id', `${note.reply?.id}@${host}`) ?? undefined : undefined;

    const tweetId = await twitterService.tweet(tweetContent, {
      replyTo: replyToTweetId,
      mediaIds: mediaList,
    });

    await cacheService.set('posted-note-id', `${note.id}@${host}`, tweetId);

    return await buildResponse({
      statusCode: 200,
      body: JSON.stringify({
        status: 'OK',
      }),
      contentType: 'application/json',
    });
  } catch (_e) {
    const e = _e as any;

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
        await cacheService.del('profile', getHash(`${note.userId}@${host}`));

        message = 'API 키 4개가 모두 정상적으로 구성되었는지 확인해주세요.\n\n만약 정상적으로 동작하다가 이 문제가 발생했다면, 해당 사실을 여기에 답글로 적어주신 뒤 웹훅을 비활성화 하시고 기다려주세요. 관리자가 곧 도와드리겠습니다. (수신자를 편집하지 마세요!)';

        break;
      }

      case 403: {
        await cacheService.del('profile', getHash(`${note.userId}@${host}`));

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

async function buildResponse({ statusCode, body, contentType }: { statusCode: number, body: string | Buffer, contentType: string }): Promise<APIGatewayProxyResultV2> {
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

async function isValidRequest(data: any, host: string): Promise<boolean> {
  if (data.type !== 'note') {
    return false;
  }

  const note = data.body.note as WebhookNote;

  if (note.mentions?.length) {
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

  if (await cacheService.get('posted-note-id', `${note.id}@${host}`)) {
    console.log('Already posted; skipping');

    return false;
  }

  return true;
}

function isFileIncludable(file: Misskey.entities.DriveFile, user: User): boolean {
  if (file.isSensitive && user.confs.excludeNsfw) {
    return false;
  }

  return true;
}

async function sendErrorNotification(username: string, host: string, message: string): Promise<void> {
  const targetUserId =  await misskeyService.getUserId(host, username);
  const adminUserId = await misskeyService.getUserId(process.env.MISSKEY_INSTANCE!, process.env.MISSKEY_ADMIN!);

  await misskeyService.createNote(message, {
    visibility: 'specified',
    visibleUserIds: Array.from(new Set<string>([ targetUserId, adminUserId ]).values()),
  });
}
