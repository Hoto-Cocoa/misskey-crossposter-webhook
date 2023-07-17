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
});
