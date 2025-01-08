// functions/initial-processor/index.mjs
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import sharp from 'sharp';

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

// const DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
// const IMAGE_SIZES = [16, 32, 48, 64, 96, 128, 256, 384];
const DEVICE_SIZES = [640, 828, 1200, 1920]; // Most common sizes
const IMAGE_SIZES = [64, 128, 384];          // Essential thumbnails
const ALL_SIZES = [...IMAGE_SIZES, ...DEVICE_SIZES].sort((a, b) => a - b);

export const handler = async (event) => {
  console.log('Event received:', JSON.stringify(event, null, 2));
  
  try {
    const record = event.Records[0];
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    
    console.log('Processing image from:', { bucket, key });

    // Get original image
    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: key
    });
    
    console.log('Fetching original image...');
    const originalImage = await s3Client.send(getCommand);
    const buffer = Buffer.from(await originalImage.Body.transformToByteArray());
    
    // Get image metadata
    const metadata = await sharp(buffer).metadata();
    const applicableSizes = ALL_SIZES.filter(size => size <= metadata.width);
    
    console.log('Queueing sizes for processing:', applicableSizes);

    // Queue processing tasks
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