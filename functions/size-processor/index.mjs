// functions/size-processor/index.mjs
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from 'sharp';

const s3Client = new S3Client({});

const getQualityConfig = (width) => {
  if (width <= 384) return { quality: 80, effort: 4 };
  return { quality: 85, effort: 4 }; // Reduced effort level
};

export const handler = async (event) => {
  try {
    const message = JSON.parse(event.Records[0].body);
    const {
      sourceBucket,
      sourceKey,
      targetSize,
      originalWidth,
      originalHeight
    } = message;

    console.log('Processing:', { sourceKey, targetSize, originalWidth });

    // Get original image
    const originalImage = await s3Client.send(new GetObjectCommand({
      Bucket: sourceBucket,
      Key: sourceKey
    }));

    const buffer = Buffer.from(await originalImage.Body.transformToByteArray());
    const qualityConfig = getQualityConfig(targetSize);
    const aspectRatio = originalHeight / originalWidth;
    const targetHeight = Math.round(targetSize * aspectRatio);

    // Process image with optimized settings
    const processedImage = sharp(buffer, {
      failOn: 'none'
    }).resize({
      width: targetSize,
      height: targetHeight,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      fastShrinkOnLoad: true
    });

    // WebP only for better performance
    console.log('Processing WebP');
    const webpVersion = await processedImage
      .webp({
        quality: qualityConfig.quality,
        effort: qualityConfig.effort,
        mixed: true,
        force: true
      })
      .toBuffer({ resolveWithObject: true });

    console.log('Uploading WebP');
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