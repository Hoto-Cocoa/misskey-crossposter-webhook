import { CacheService } from '../../services/CacheService.js';
import { createReadStream } from 'fs';
import { Duplex } from 'stream';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getHash, mergeDeep } from '../../utils.js';
import { mockClient } from 'aws-sdk-client-mock';
import { ProfileService } from '../../services/ProfileService.js';
import { readFile } from 'fs/promises';
import { sdkStreamMixin } from '@aws-sdk/util-stream-node';
import path from 'path';
import { clear } from '../_modules/redis.js';

const baseProfile = JSON.parse((await readFile(path.resolve('./base_profiles/default.json'))).toString());
const mockProfile = {
  misskeyId: 'test',
  baseProfile: 'default',
};

describe('When getUserProfile called', () => {
  beforeEach(async () => {
    clear();
  });

  it('should return user profile if exists', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from([JSON.stringify(mockProfile)])),
    });

    const service = new ProfileService(await CacheService.getInstance());
    const profile = await service.getUserProfile('test');
    const expected = JSON.stringify(mergeDeep({}, baseProfile, mockProfile));
    expect(profile).toEqual(JSON.parse(expected));
  });

  it('should return null if user profile does not exist', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({});

    const service = new ProfileService(await CacheService.getInstance());
    const profile = await service.getUserProfile('test');
    expect(profile).toBeNull();
  });

  it('should return null if error occurs', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).rejects('error');

    const service = new ProfileService(await CacheService.getInstance());
    const profile = await service.getUserProfile('test');
    expect(profile).toBeNull();
  });

  it('should return null if user profile is invalid', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from([JSON.stringify({})])),
    });

    const service = new ProfileService(await CacheService.getInstance());
    const profile = await service.getUserProfile('test');
    expect(profile).toBeNull();
  });

  it('should return null if base profile is not found', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Duplex.from([JSON.stringify({
        ...mockProfile,
        baseProfile: 'not-exists',
      })])),
    });

    const service = new ProfileService(await CacheService.getInstance());
    const profile = await service.getUserProfile('test');
    expect(profile).toBeNull();
  });

  it('should return user profile if exists in cache', async () => {
    const cacheService = await CacheService.getInstance();

    const service = new ProfileService(cacheService);

    const userProfile = {
      misskeyId: 'test',
      baseProfile: 'default',
    };

    await cacheService.set('profile', getHash('test'), JSON.stringify(userProfile));

    const profile = await service.getUserProfile('test');
    expect(profile).toEqual(userProfile);
  });
});

describe('When getBaseProfile called', () => {
  beforeEach(async () => {
    const cacheService = await CacheService.getInstance();

    await cacheService.del('profile', 'test');
  });

  it('should return base profile if exists', async () => {
    const service = new ProfileService(await CacheService.getInstance());
    const profile = await service.getBaseProfile('default');
    expect(profile).toEqual(baseProfile);
  });

  it('should return null if base profile does not exist', async () => {
    const service = new ProfileService(await CacheService.getInstance());
    const profile = await service.getBaseProfile('not-exists');
    expect(profile).toBeNull();
  });
});
