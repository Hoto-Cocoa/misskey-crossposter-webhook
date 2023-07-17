import { clear } from '../_modules/redis.js';
import { CacheService } from '../../services/CacheService.js';

describe('CacheService test', () => {
  beforeEach(async () => {
    clear();
  });

  it('should return value that configured', async () => {
    const service = await CacheService.getInstance();

    await service.set('profile', 'exists', 'test');

    const value = await service.get('profile', 'exists');
    const expected = 'test';

    expect(value).toEqual(expected);
  });

  it('should return undefined if key does not exist', async () => {
    const service = await CacheService.getInstance();

    const value = await service.get('profile', 'not-exists');

    expect(value).toBeUndefined();
  });
});
