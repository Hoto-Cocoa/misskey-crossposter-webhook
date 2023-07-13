import axios from 'axios';
import * as Misskey from 'misskey-js';
import { CacheService } from './CacheService.js';

export class MisskeyService {
  private cacheService: CacheService;

  constructor(cacheService: CacheService) {
    this.cacheService = cacheService;
  }

  async createNote(text: string, options: Misskey.Endpoints['notes/create']['req']): Promise<Misskey.entities.Note> {
    const response = await axios.post<Misskey.entities.Note>(`https://${process.env.MISSKEY_INSTANCE}/api/notes/create`, JSON.stringify(Object.assign({}, {
      text,
      i: process.env.MISSKEY_API_TOKEN,
    }, options) as Misskey.Endpoints['notes/create']['req']), {
      headers: {
        'content-type': 'application/json',
      },
    });

    return response.data;
  }

  async getUserId(host: string, username: string): Promise<string> {
    const cachedId = await this.cacheService.get('user-id', `${username}@${host}`);

    if (cachedId) {
      return cachedId;
    }

    const response = await axios.post<Misskey.entities.User>(`https://${process.env.MISSKEY_INSTANCE}/api/users/show`, JSON.stringify({
      username,
      host,
      i: process.env.MISSKEY_API_TOKEN,
    }), {
      headers: {
        'content-type': 'application/json',
      },
    });

    await this.cacheService.set('user-id', `${username}@${host}`, response.data.id);

    return response.data.id;
  }
}
