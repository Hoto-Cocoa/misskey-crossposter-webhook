import { RedisClientType, SetOptions, createClient } from 'redis';

export class CacheService {
  private static instance: CacheService;
  private client: RedisClientType;

  private constructor() {
    this.client = createClient({
      url: process.env.REDIS_URL,
    });
  }

  public static async getInstance(): Promise<CacheService> {
    if (!CacheService.instance) {
      CacheService.instance = new CacheService();

      if (CacheService.instance.client.connect) {
        await CacheService.instance.client.connect();
      }
    }

    return CacheService.instance;
  }

  async get(type: string, key: string): Promise<string | null> {
    return await this.client.get(`hotomoe-crossposter-worker:${type}:${key}`) ?? null;
  }

  async set(type: string, key: string, value: string, options: SetOptions = {}): Promise<void> {
    await this.client.set(`hotomoe-crossposter-worker:${type}:${key}`, value, options);

    return;
  }

  async del(type: string, key: string): Promise<void> {
    await this.client.del(`hotomoe-crossposter-worker:${type}:${key}`);
  }
}
