// functions/initial-processor/index.ts
import { S3Event } from 'aws-lambda';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import Sharp from 'sharp';

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

const DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
const IMAGE_SIZES = [16, 32, 48, 64, 96, 128, 256, 384];
const ALL_SIZES = [...IMAGE_SIZES, ...DEVICE_SIZES].sort((a, b) => a - b);

exports.handler = async (event: S3Event) => {
  const record = event.Records[0];
  const bucket = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

  try {
    // Get image metadata
    const originalImage = await s3Client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key
    }));
    
    const buffer = Buffer.from(await originalImage.Body!.transformToByteArray());
    const metadata = await Sharp(buffer).metadata();

    // Group sizes into chunks for processing
    const applicableSizes = ALL_SIZES.filter(size => size <= metadata.width!);
    
    // Send processing tasks to queue
    for (const size of applicableSizes) {
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: process.env.QUEUE_URL,
        MessageBody: JSON.stringify({
          sourceBucket: bucket,
          sourceKey: key,
          targetSize: size,
          originalWidth: metadata.width,
          originalHeight: metadata.height
        })
      }));
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Processing tasks queued',
        sizes: applicableSizes.length
      })
    };
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};