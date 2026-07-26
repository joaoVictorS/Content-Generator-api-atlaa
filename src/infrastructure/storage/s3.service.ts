import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../../config/env';

export class S3Service {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string = env.S3_BUCKET,
    private readonly publicUrl: string = env.S3_PUBLIC_URL,
  ) {}

  async uploadTextFile(key: string, content: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: content,
        ContentType: 'text/plain; charset=utf-8',
      }),
    );

    return `${this.publicUrl.replace(/\/$/, '')}/${key}`;
  }
}
