import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import { mergeDeep } from '../utils.js';
import { User } from '../types/user.js';
import { CacheService } from './CacheService.js';
import { S3Service } from './S3Service.js';

export class ProfileService {
  private cacheService: CacheService;
  private s3Service: S3Service;

  constructor(cacheService: CacheService) {
    this.cacheService = cacheService;
    this.s3Service = new S3Service();
  }

  async getUserProfile(userId: string): Promise<User | null> {
    const hash = createHash('md5').update(userId).digest('hex');

    const cachedProfile = await this.cacheService.get('profile', hash);

    if (cachedProfile) {
      return JSON.parse(cachedProfile) as User;
    }

    try {
      const body = await this.s3Service.getFile(`profiles/${hash}.json`);

      if (!body) {
        throw new Error('User profile not found');
      }

      const user = JSON.parse(body) as User;

      if (user.misskeyId !== userId) {
        throw new Error(`User file is invalid; Expected ${userId}, got ${user.misskeyId}`);
      }

      const baseProfile = await this.getBaseProfile(user.baseProfile);

      if (!baseProfile) {
        throw new Error(`Base profile not found: ${user.baseProfile}`);
      }

      const profile = mergeDeep(baseProfile, user);

      await this.cacheService.set('profile', hash, JSON.stringify(profile), {
        EX: 60 * 5,
      });

      return profile;
    } catch (e) {
      console.error(e);

      return null;
    }
  }

  public async getBaseProfile(profileName: string): Promise<User | null> {
    try {
      return JSON.parse((await readFile(path.resolve(`./base_profiles/${profileName}.json`))).toString()) as User;
    } catch {
      return null;
    }
  }
}
