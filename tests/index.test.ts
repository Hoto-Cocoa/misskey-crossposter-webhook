import { APIGatewayEventRequestContextV2, APIGatewayProxyEventV2WithRequestContext } from 'aws-lambda';
import { handler } from '../index.js';
import { loadJsonAndAssign, mergeDeep } from '../utils.js';
import { WebhookNote } from '../types/webhook.js';
import { CacheService } from '../services/CacheService.js';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { sdkStreamMixin } from '@aws-sdk/util-stream-node';
import { User } from '../types/user.js';
import { Duplex } from 'stream';
import * as Misskey from 'misskey-js';
import nock from 'nock';
import { clear } from './_modules/redis.js';
import { SendTweetV1Params } from 'twitter-api-v2';
import querystring from 'querystring';

type WebhookIncomingMessage<Type extends string = string, BodyType extends object = {}> = {
  hookId: string;
  userId: string;
  eventId: string;
  createdAt: number;
  type: Type;
  body: {
    [key in Type]: BodyType;
  };
};

const baseRequestNote = await loadJsonAndAssign<WebhookNote>('./tests/fixtures/base-request-note.json');

const baseRequestContext = await loadJsonAndAssign<WebhookIncomingMessage<'note', WebhookNote>>(
  './tests/fixtures/base-request-context.json',
  {
    body: {
      note: baseRequestNote,
    },
  }
);

const baseRequest = await loadJsonAndAssign<APIGatewayProxyEventV2WithRequestContext<APIGatewayEventRequestContextV2>>(
  './tests/fixtures/base-request.json',
  {
    body: JSON.stringify(baseRequestContext),
  }
);

const baseUser: Partial<User> = {
  misskeyId: 'test-user-id@misskey.test',
  baseProfile: 'default',
  secret: 'test',
  twitterApiConfs: [
    {
      visibility: 'public',
      version: 'v1',
      tokens: {
        appKey: 'test',
        appSecret: 'test',
        accessToken: 'test',
        accessSecret: 'test',
      },
    },
  ],
};

function createRequest(note: Partial<WebhookNote>): typeof baseRequest {
  return {
    ...baseRequest,
    body: JSON.stringify({
      ...baseRequestContext,
      body: {
        note: mergeDeep({}, baseRequestNote, note),
      },
    }),
  };
}

const service = await CacheService.getInstance();

describe('When handler called', () => {
  beforeEach(async () => {
    clear();
  });

  it('should return HOST_NOT_FOUND error if called with invalid host', async () => {
    const request: typeof baseRequest = {
      ...baseRequest,
      headers: {
        ...baseRequest.headers,
        'x-misskey-host': undefined,
      },
      body: JSON.stringify(baseRequestContext),
    };

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'HOST_NOT_FOUND',
    }));
  });

  it('should return INVALID_REQUEST error if called with invalid type', async () => {
    const request: typeof baseRequest = {
      ...baseRequest,
      body: JSON.stringify({
        ...baseRequestContext,
        type: 'invalid',
      }),
    };

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'INVALID_REQUEST',
    }));
  });

  it('should return INVALID_REQUEST error if mentions exists', async () => {
    const request: typeof baseRequest = {
      ...baseRequest,
      body: JSON.stringify({
        ...baseRequestContext,
        body: {
          note: {
            ...baseRequestNote,
            mentions: [ 'test' ],
          } as WebhookNote,
        },
      }),
    };

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'INVALID_REQUEST',
    }));
  });

  it('should return INVALID_REQUEST error if reply to other user', async () => {
    const request: typeof baseRequest = {
      ...baseRequest,
      body: JSON.stringify({
        ...baseRequestContext,
        body: {
          note: {
            ...baseRequestNote,
            reply: {
              ...baseRequestNote,
              userId: 'test',
            }
          } as WebhookNote,
        },
      }),
    };

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'INVALID_REQUEST',
    }));
  });

  it('should return INVALID_REQUEST error if visibility is specified', async () => {
    const request: typeof baseRequest = {
      ...baseRequest,
      body: JSON.stringify({
        ...baseRequestContext,
        body: {
          note: {
            ...baseRequestNote,
            visibility: 'specified',
          } as WebhookNote,
        },
      }),
    };

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'INVALID_REQUEST',
    }));
  });

  // redis-mock is broken, skip the test.
  it('should return INVALID_REQUEST error if already posted', async () => {
    await service.set('posted-note-id', `${baseRequestNote.id}@${baseRequest.headers['x-misskey-host']}`, 'value');

    const request = createRequest({});

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'INVALID_REQUEST',
    }));
  });

  it('should return USER_NOT_FOUND error if user not found', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).rejects('error');

    const request = createRequest({});

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'USER_NOT_FOUND',
    }));
  });

  it('should return INVALID_SECRET error and send notification if secret is invalid', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify({
        ...baseUser,
        secret: 'invalid',
      } as User))),
    });

    const scope = nock(`https://${process.env.MISSKEY_INSTANCE}`);

    scope.post('/api/users/show').reply(200, {
      id: 'test-user-id',
      name: 'User',
      username: 'user',
      host: null,
      avatarUrl: '',
      avatarBlurhash: '',
      emojis: [],
      onlineStatus: 'online',
    } as Misskey.entities.User);

    scope.post('/api/notes/create').reply(200, (uri, body) => {
      const data = body as Misskey.Endpoints['notes/create']['req'];

      return {
        id: 'test',
        text: data.text,
        visibility: data.visibility,
      } as Misskey.entities.Note;
    });

    const request = createRequest({});

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'INVALID_SECRET',
    }));

    scope.done();
  });

  it('should return RENOTE_NOT_ENABLED code if has renote and not enabled it', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify(baseUser))),
    });

    const request = createRequest({
      renote: {
        ...baseRequestNote,
      },
    });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'RENOTE_NOT_ENABLED',
    }));
  });

  it('should return NOCP code if nocp hashtag is provided', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify(baseUser))),
    });

    const request = createRequest({
      tags: [
        'nocp',
      ],
    });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'NOCP',
    }));
  });

  it('should return TWITTER_API_CONF_NOT_FOUND code if conf not exists', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify(baseUser))),
    });

    const request = createRequest({
      visibility: 'home',
    });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'TWITTER_API_CONF_NOT_FOUND',
    }));
  });

  it('should return TWITTER_API_ERROR code and send notification if error occurs', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify(baseUser))),
    });

    const twitterApiScope = nock('https://api.twitter.com')
      .post('/1.1/statuses/update.json')
      .reply(500);

    const misskeyScope = nock(`https://${process.env.MISSKEY_INSTANCE}`);

    misskeyScope.post(`/api/users/show`).reply(200, {
      id: 'test-user-id',
      name: 'User',
      username: 'user',
      host: null,
      avatarUrl: '',
      avatarBlurhash: '',
      emojis: [],
      onlineStatus: 'online',
    } as Misskey.entities.User);

    misskeyScope.post(`/api/notes/create`).reply(200, (uri, body) => {
      const data = body as Misskey.Endpoints['notes/create']['req'];

      return {
        id: 'test',
        text: data.text,
        visibility: data.visibility,
      } as Misskey.entities.Note;
    });

    const request = createRequest({});

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'TWITTER_API_ERROR',
    }));

    twitterApiScope.done();

    misskeyScope.done();
  });

  it('should include link and use cw title as body if not configured cwTitleOnly: false', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify(baseUser))),
    });

    const request = createRequest({
      cw: 'test',
    });

    const scope = nock('https://api.twitter.com')
    .post('/1.1/statuses/update.json')
    .reply(200, (uri, body) => {
      const data = querystring.parse(body as string) as unknown as SendTweetV1Params;

      expect(data.status).toEqual(`test\n\n전체 내용 읽기: https://${process.env.MISSKEY_INSTANCE}/notes/${baseRequestNote.id}`);

      return { id_str: 'testTweetId' };
    });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'OK',
    }));

    scope.done();
  });

  it('should not include link and include all content if configured cwTitleOnly: false', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify({
        ...baseUser,
        confs: {
          cwTitleOnly: false,
        },
      } as User))),
    });

    const request = createRequest({
      cw: 'test',
    });

    const scope = nock('https://api.twitter.com')
    .post('/1.1/statuses/update.json')
    .reply(200, (uri, body) => {
      const data = querystring.parse(body as string) as unknown as SendTweetV1Params;

      expect(data.status).toEqual(`test\n\n${baseRequestNote.text}`);

      return { id_str: 'testTweetId' };
    });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'OK',
    }));

    scope.done();
  });

  it('should include link and include renote content if configured enableRenote: true', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify({
        ...baseUser,
        confs: {
          enableRenote: true,
        },
      } as User))),
    });

    const request = createRequest({
      renote: {
        ...baseRequestNote,
      },
    });

    const scope = nock('https://api.twitter.com')
    .post('/1.1/statuses/update.json')
    .reply(200, (uri, body) => {
      const data = querystring.parse(body as string) as unknown as SendTweetV1Params;

      expect(data.status).toEqual(`RENOTE @${baseRequestNote.user.username}@${process.env.MISSKEY_INSTANCE}: ${baseRequestNote.text}\n\n전체 내용 읽기: https://${process.env.MISSKEY_INSTANCE}/notes/${baseRequestNote.id}`);

      return { id_str: 'testTweetId' };
    });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'OK',
    }));

    scope.done();
  });

  it('should include link and truncate content if length is over 280', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify(baseUser))),
    });

    const request = createRequest({
      text: 'a'.repeat(300),
    });

    const scope = nock('https://api.twitter.com')
      .post('/1.1/statuses/update.json')
      .reply(200, (uri, body) => {
        const data = querystring.parse(body as string) as unknown as SendTweetV1Params;

        expect(data.status).toEqual(`${'a'.repeat(180)}…\n\n전체 내용 읽기: https://${process.env.MISSKEY_INSTANCE}/notes/${baseRequestNote.id}`);

        return { id_str: 'testTweetId' };
      });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'OK',
    }));

    scope.done();
  });

  it('should include link if note has poll', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify(baseUser))),
    });

    const request = createRequest({
      poll: {
        choices: [],
        expiresAt: '',
        multiple: false,
      },
    });

    const scope = nock('https://api.twitter.com')
      .post('/1.1/statuses/update.json')
      .reply(200, (uri, body) => {
        const data = querystring.parse(body as string) as unknown as SendTweetV1Params;

        expect(data.status).toEqual(`${baseRequestNote.text}\n\n전체 내용 읽기: https://${process.env.MISSKEY_INSTANCE}/notes/${baseRequestNote.id}`);

        return { id_str: 'testTweetId' };
      });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'OK',
    }));

    scope.done();
  });

  it('should include link if note has sensitive file', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify(baseUser))),
    });

    const request = createRequest({
      fileIds: [
        'test-file-id',
      ],
      files: [
        {
          createdAt: '',
          id: 'test-file-id',
          type: 'video/mp4',
          md5: '5cb6bd889c76748b063d57b445df4500',
          url: 'https://files.misskey.test/name.mp4',
          size: 0,
          blurhash: '',
          comment: '',
          isSensitive: true,
          name: 'name.mp4',
          properties: {},
          thumbnailUrl: 'https://files.misskey.test/name.mp4.jpg',
        },
      ],
    });

    const scope = nock('https://api.twitter.com')
      .post('/1.1/statuses/update.json')
      .reply(200, (uri, body) => {
        const data = querystring.parse(body as string) as unknown as SendTweetV1Params;

        expect(data.status).toEqual(`${baseRequestNote.text}\n\n전체 내용 읽기: https://${process.env.MISSKEY_INSTANCE}/notes/${baseRequestNote.id}`);

        return { id_str: 'testTweetId' };
      });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'OK',
    }));

    scope.done();
  });

  it('should include link if note has multiple video', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify(baseUser))),
    });

    const request = createRequest({
      fileIds: [
        'test-file-id',
        'test-file-id2',
      ],
      files: [
        {
          createdAt: '',
          id: 'test-file-id',
          type: 'video/mp4',
          md5: '5cb6bd889c76748b063d57b445df4500',
          url: 'https://files.misskey.test/name.mp4',
          size: 0,
          blurhash: '',
          comment: '',
          isSensitive: false,
          name: 'name.mp4',
          properties: {},
          thumbnailUrl: 'https://files.misskey.test/name.mp4.jpg',
        },
        {
          createdAt: '',
          id: 'test-file-id2',
          type: 'video/mp4',
          md5: '5cb6bd889c76748b063d57b445df4500',
          url: 'https://files.misskey.test/name.mp4',
          size: 0,
          blurhash: '',
          comment: '',
          isSensitive: false,
          name: 'name.mp4',
          properties: {},
          thumbnailUrl: 'https://files.misskey.test/name.mp4.jpg',
        },
      ],
    });

    const scope = nock('https://api.twitter.com')
      .post('/1.1/statuses/update.json')
      .reply(200, (uri, body) => {
        const data = querystring.parse(body as string) as unknown as SendTweetV1Params;

        expect(data.status).toEqual(`${baseRequestNote.text}\n\n전체 내용 읽기: https://${process.env.MISSKEY_INSTANCE}/notes/${baseRequestNote.id}`);

        return { id_str: 'testTweetId' };
      });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'OK',
    }));

    scope.done();
  });

  it('should include link if note has not twitter embedable file', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify(baseUser))),
    });

    const request = createRequest({
      fileIds: [
        'test-file-id',
      ],
      files: [
        {
          createdAt: '',
          id: 'test-file-id',
          type: 'application/octet-stream',
          md5: '5cb6bd889c76748b063d57b445df4500',
          url: 'https://files.misskey.test/name.bin',
          size: 0,
          blurhash: '',
          comment: '',
          isSensitive: false,
          name: 'name.bin',
          properties: {},
          thumbnailUrl: 'https://files.misskey.test/name.bin.jpg',
        },
      ],
    });

    const scope = nock('https://api.twitter.com')
      .post('/1.1/statuses/update.json')
      .reply(200, (uri, body) => {
        const data = querystring.parse(body as string) as unknown as SendTweetV1Params;

        expect(data.status).toEqual(`${baseRequestNote.text}\n\n전체 내용 읽기: https://${process.env.MISSKEY_INSTANCE}/notes/${baseRequestNote.id}`);

        return { id_str: 'testTweetId' };
      });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'OK',
    }));

    scope.done();
  });

  it('should include link if note has more than 4 media', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify(baseUser))),
    });

    const misskeyScope = nock(`https://files.misskey.test`)
      .get(`/name.png`)
      .times(4)
      .reply(200, Buffer.from('test'));

    const twitterUploadScope = nock('https://upload.twitter.com/1.1')
      .post('/media/upload.json')
      .times(12)
      .reply(200, { media_id_string: 'testMediaId' });

    const twitterScope = nock('https://api.twitter.com')
      .post('/1.1/statuses/update.json')
      .reply(200, (uri, body) => {
        const data = querystring.parse(body as string) as unknown as SendTweetV1Params;

        expect(data.status).toEqual(`${baseRequestNote.text}\n\n전체 내용 읽기: https://${process.env.MISSKEY_INSTANCE}/notes/${baseRequestNote.id}`);

        return { id_str: 'testTweetId' };
      });

    const request = createRequest({
      fileIds: [
        'test-file-id',
        'test-file-id2',
        'test-file-id3',
        'test-file-id4',
        'test-file-id5',
      ],
      files: [
        {
          createdAt: '',
          id: 'test-file-id',
          type: 'image/png',
          md5: '5cb6bd889c76748b063d57b445df4500',
          url: 'https://files.misskey.test/name.png',
          size: 0,
          blurhash: '',
          comment: '',
          isSensitive: false,
          name: 'name.png',
          properties: {},
          thumbnailUrl: 'https://files.misskey.test/name.png.jpg',
        },
        {
          createdAt: '',
          id: 'test-file-id2',
          type: 'image/png',
          md5: '5cb6bd889c76748b063d57b445df4500',
          url: 'https://files.misskey.test/name.png',
          size: 0,
          blurhash: '',
          comment: '',
          isSensitive: false,
          name: 'name.png',
          properties: {},
          thumbnailUrl: 'https://files.misskey.test/name.png.jpg',
        },
        {
          createdAt: '',
          id: 'test-file-id3',
          type: 'image/png',
          md5: '5cb6bd889c76748b063d57b445df4500',
          url: 'https://files.misskey.test/name.png',
          size: 0,
          blurhash: '',
          comment: '',
          isSensitive: false,
          name: 'name.png',
          properties: {},
          thumbnailUrl: 'https://files.misskey.test/name.png.jpg',
        },
        {
          createdAt: '',
          id: 'test-file-id4',
          type: 'image/png',
          md5: '5cb6bd889c76748b063d57b445df4500',
          url: 'https://files.misskey.test/name.png',
          size: 0,
          blurhash: '',
          comment: '',
          isSensitive: false,
          name: 'name.png',
          properties: {},
          thumbnailUrl: 'https://files.misskey.test/name.png.jpg',
        },
        {
          createdAt: '',
          id: 'test-file-id5',
          type: 'image/png',
          md5: '5cb6bd889c76748b063d57b445df4500',
          url: 'https://files.misskey.test/name.png',
          size: 0,
          blurhash: '',
          comment: '',
          isSensitive: false,
          name: 'name.png',
          properties: {},
          thumbnailUrl: 'https://files.misskey.test/name.png.jpg',
        },
      ],
    });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'OK',
    }));

    misskeyScope.done();

    twitterUploadScope.done();

    twitterScope.done();
  });

  it('should include media if included', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify(baseUser))),
    });

    const misskeyScope = nock(`https://files.misskey.test`)
      .get(`/name.mp4`)
      .reply(200, Buffer.from('test'));

    const twitterUploadScope = nock('https://upload.twitter.com/1.1')
      .post('/media/upload.json')
      .times(3)
      .reply(200, { media_id_string: 'testMediaId' });

    const twitterScope = nock('https://api.twitter.com')
      .post('/1.1/statuses/update.json')
      .reply(200, (uri, body) => {
        const data = querystring.parse(body as string) as unknown as SendTweetV1Params;

        expect(data.status).toEqual(baseRequestNote.text);

        return { id_str: 'testTweetId' };
      });

    const request = createRequest({
      fileIds: [
        'test-file-id',
      ],
      files: [
        {
          createdAt: '',
          id: 'test-file-id',
          type: 'video/mp4',
          md5: '5cb6bd889c76748b063d57b445df4500',
          url: 'https://files.misskey.test/name.mp4',
          size: 0,
          blurhash: '',
          comment: '',
          isSensitive: false,
          name: 'name.mp4',
          properties: {},
          thumbnailUrl: 'https://files.misskey.test/name.mp4.jpg',
        },
      ],
    });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'OK',
    }));

    misskeyScope.done();

    twitterUploadScope.done();

    twitterScope.done();
  });

  it('should not post link required tweet if configured skipLinkRequired: true', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify({
        ...baseUser,
        confs: {
          skipLinkRequired: true,
        },
      } as User))),
    });

    const request = createRequest({
      cw: 'test',
    });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'SKIP_LINK_REQUIRED',
    }));
  });

  it('should include tags in tweet if configured enableTags: true', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify({
        ...baseUser,
        confs: {
          enableTags: true,
        },
      } as User))),
    });

    const request = createRequest({
      cw: 'test',
    });

    const scope = nock('https://api.twitter.com')
      .post('/1.1/statuses/update.json')
      .reply(200, (uri, body) => {
        const data = querystring.parse(body as string) as unknown as SendTweetV1Params;

        expect(data.status).toEqual(`test\n\n(CW 설정된 글)\n\n전체 내용 읽기: https://${process.env.MISSKEY_INSTANCE}/notes/${baseRequestNote.id}`);

        return { id_str: 'testTweetId' };
      });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'OK',
    }));

    scope.done();
  });

  it('should rebuild tags if built tweet length is over 280 and configured enableTags: true', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify({
        ...baseUser,
        confs: {
          enableTags: true,
        },
      } as User))),
    });

    const request = createRequest({
      cw: 'a'.repeat(270),
    });

    const scope = nock('https://api.twitter.com')
      .post('/1.1/statuses/update.json')
      .reply(200, (uri, body) => {
        const data = querystring.parse(body as string) as unknown as SendTweetV1Params;

        expect(data.status).toEqual(`${'a'.repeat(215)}…\n\n(CW 설정된 글, 장문)\n\n전체 내용 읽기: https://${process.env.MISSKEY_INSTANCE}/notes/${baseRequestNote.id}`);

        return { id_str: 'testTweetId' };
      });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'OK',
    }));

    scope.done();
  });

  it('should return DUPLICATE_TWEET code if twitter returned duplicated tweet error', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from(JSON.stringify(baseUser))),
    });

    const request = createRequest({});

    const scope = nock('https://api.twitter.com')
      .post('/1.1/statuses/update.json')
      .reply(400, {
        errors: [
          {
            code: 187,
          },
        ],
      });

    const response = await handler(request);

    expect(response.body).toEqual(JSON.stringify({
      status: 'DUPLICATE_TWEET',
    }));

    scope.done();
  });
});
