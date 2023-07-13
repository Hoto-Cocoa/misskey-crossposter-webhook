import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

export class S3Service {
  private client: S3Client;

  constructor() {
    this.client = new S3Client({
      region: 'ap-northeast-2',
    });
  }

  async getFile(key: string): Promise<string | undefined> {
    const { Body } = await this.client.send(new GetObjectCommand({
      Bucket: `hotomoe-crossposter-${process.env.NODE_ENV}`,
      Key: key,
    }));

    return Body?.transformToString();
  }
}
