import { clear } from '../_modules/redis.js';
import { CacheService } from '../../services/CacheService.js';

describe('CacheService test', () => {
  beforeEach(async () => {
    clear();
  });

  it('should return instance', async () => {
    const service = await CacheService.getInstance();

    expect(service).toBeInstanceOf(CacheService);
  });

  it('should return same instance', async () => {
    const service1 = await CacheService.getInstance();
    const service2 = await CacheService.getInstance();

    expect(service1).toBe(service2);
  });

  it('should return value that configured', async () => {
    const service = await CacheService.getInstance();

    await service.set('profile', 'exists', 'test');

    const value = await service.get('profile', 'exists');
    const expected = 'test';

    expect(value).toEqual(expected);
  });

  it('should return null if key does not exist', async () => {
    const service = await CacheService.getInstance();

    const value = await service.get('profile', 'not-exists');

    expect(value).toBeNull();
  });
});
