import got from 'got';
import * as Misskey from 'misskey-js';
import { CacheService } from './CacheService.js';

export class MisskeyService {
  private cacheService: CacheService;

  constructor(cacheService: CacheService) {
    this.cacheService = cacheService;
  }

  async createNote(text: string, options: Misskey.Endpoints['notes/create']['req']): Promise<Misskey.entities.Note> {
    const data = await got.post(`https://${process.env.MISSKEY_INSTANCE}/api/notes/create`, {
      json: Object.assign({}, {
        text,
        i: process.env.MISSKEY_API_TOKEN,
      }, options) as Misskey.Endpoints['notes/create']['req'],
    }).json<Misskey.entities.Note>();

    return data;
  }

  async getUserId(host: string, username: string): Promise<string> {
    const cachedId = await this.cacheService.get('user-id', `${username}@${host}`);

    if (cachedId) {
      return cachedId;
    }

    const data = await got.post(`https://${process.env.MISSKEY_INSTANCE}/api/users/show`, {
      json: {
        username,
        host,
        i: process.env.MISSKEY_API_TOKEN,
      },
    }).json<Misskey.entities.User>();

    await this.cacheService.set('user-id', `${username}@${host}`, data.id);

    return data.id;
  }
}
