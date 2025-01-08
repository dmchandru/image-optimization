// functions/size-processor/index.ts
import { SQSEvent } from 'aws-lambda';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import Sharp from 'sharp';

const s3Client = new S3Client({});

const getQualityConfig = (width: number) => {
  if (width <= 384) return { quality: 80, effort: 4 };
  if (width <= 1080) return { quality: 85, effort: 5 };
  return { quality: 90, effort: 6 };
};

exports.handler = async (event: SQSEvent) => {
  const message = JSON.parse(event.Records[0].body);
  const {
    sourceBucket,
    sourceKey,
    targetSize,
    originalWidth,
    originalHeight
  } = message;

  try {
    // Get original image
    const originalImage = await s3Client.send(new GetObjectCommand({
      Bucket: sourceBucket,
      Key: sourceKey
    }));

    const buffer = Buffer.from(await originalImage.Body!.transformToByteArray());
    const qualityConfig = getQualityConfig(targetSize);
    const aspectRatio = originalHeight / originalWidth;
    const targetHeight = Math.round(targetSize * aspectRatio);

    // Process WebP version
    const processedImage = Sharp(buffer).resize({
      width: targetSize,
      height: targetHeight,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    });

    const webpVersion = await processedImage.clone()
      .webp({
        quality: qualityConfig.quality,
        effort: qualityConfig.effort,
        smartSubsample: true
      })
      .toBuffer({ resolveWithObject: true });

    // Upload WebP version
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.PROCESSED_BUCKET,
      Key: `processed/w${targetSize}/${sourceKey.replace(/\.[^/.]+$/, '.webp')}`,
      Body: webpVersion.data,
      ContentType: 'image/webp',
      Metadata: {
        'width': webpVersion.info.width.toString(),
        'height': webpVersion.info.height.toString(),
        'quality': qualityConfig.quality.toString()
      },
      CacheControl: 'public, max-age=31536000, immutable'
    }));

    // Process AVIF only for larger sizes
    if (targetSize >= 640) {
      const avifVersion = await processedImage.clone()
        .avif({
          quality: qualityConfig.quality,
          effort: qualityConfig.effort,
          chromaSubsampling: '4:4:4'
        })
        .toBuffer({ resolveWithObject: true });

      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.PROCESSED_BUCKET,
        Key: `processed/w${targetSize}/${sourceKey.replace(/\.[^/.]+$/, '.avif')}`,
        Body: avifVersion.data,
        ContentType: 'image/avif',
        Metadata: {
          'width': avifVersion.info.width.toString(),
          'height': avifVersion.info.height.toString(),
          'quality': qualityConfig.quality.toString()
        },
        CacheControl: 'public, max-age=31536000, immutable'
      }));
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Size ${targetSize} processed successfully`
      })
    };
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};