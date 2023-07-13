import { createReadStream } from 'fs';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { readFile } from 'fs/promises';
import { S3Service } from '../../services/S3Service.js';
import { sdkStreamMixin } from '@aws-sdk/util-stream-node';
import path from 'path';

describe('When getFile called', () => {
  it('should return object buffer if exists', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(createReadStream(path.resolve('./base_profiles/default.json'))),
    });

    const service = new S3Service();
    const object = await service.getFile('profiles/user.json');
    const expected = await readFile(path.resolve('./base_profiles/default.json'));
    expect(object).toEqual(expected.toString());
  });

  it('should return undefined if object does not exist', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).resolves({});

    const service = new S3Service();
    const object = await service.getFile('profiles/user.json');
    expect(object).toBeUndefined();
  });

  it('should return undefined if error occurs', async () => {
    const mockedClient = mockClient(S3Client);
    mockedClient.on(GetObjectCommand).rejects('error');

    const service = new S3Service();
    const object = await service.getFile('profiles/user.json');
    expect(object).toBeUndefined();
  });
});
