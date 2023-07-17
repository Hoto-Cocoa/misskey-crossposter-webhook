import { CacheService } from '../../services/CacheService.js';
import { MisskeyService } from '../../services/MisskeyService.js';
import { ToTuple } from '../../types/utils.js';
import * as Misskey from 'misskey-js';
import nock from 'nock';
import { clear } from '../_modules/redis.js';

describe('When createNote called', () => {
  beforeEach(async () => {
    clear();
  });

  it('should create note as described', async () => {
    const service = new MisskeyService(await CacheService.getInstance());

    const scope = nock(`https://${process.env.MISSKEY_INSTANCE}`).post('/api/notes/create').reply(200, (uri, body) => {
      const data = body as Misskey.Endpoints['notes/create']['req'];

      return {
        id: 'test',
        text: data.text,
        visibility: data.visibility,
      };
    });

    const createdNote = await service.createNote('test', {
      visibility: 'home',
    });

    scope.done();

    expect(createdNote.text).toEqual('test');
    expect(createdNote.visibility).toEqual('home');
  });
});

describe('When getUserId called', () => {
  it('should return user id as described', async () => {
    const service = new MisskeyService(await CacheService.getInstance());

    const scope = nock(`https://${process.env.MISSKEY_INSTANCE}`).post('/api/users/show').reply(200, (uri, body) => {
      const data = body as ToTuple<Misskey.Endpoints['users/show']['req']>[0];

      return {
        id: 'test',
        username: data.username,
        host: data.host,
      };
    });

    const userId = await service.getUserId(process.env.MISSKEY_INSTANCE!, 'test');

    scope.done();

    expect(userId).toEqual('test');
  });
});
