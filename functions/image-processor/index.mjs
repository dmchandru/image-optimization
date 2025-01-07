// functions/image-processing/index.ts
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Sharp from 'sharp';

// Initialize S3 client
const s3Client = new S3Client({});

// Match Next.js default configurations
const DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
const IMAGE_SIZES = [16, 32, 48, 64, 96, 128, 256, 384];

// Combine all sizes for processing
const ALL_SIZES = [...IMAGE_SIZES, ...DEVICE_SIZES].sort((a, b) => a - b);

// Quality configuration based on size ranges
const getQualityConfig = (width) => {
  if (width <= 384) return { quality: 80, effort: 4 }; // Image sizes
  if (width <= 1080) return { quality: 85, effort: 5 }; // Mobile and tablet
  return { quality: 90, effort: 6 }; // Larger screens
};

async function processImage(buffer, key) {
  try {
    // Get image metadata
    const metadata = await Sharp(buffer).metadata();
    const { width: originalWidth, height: originalHeight } = metadata;
    const aspectRatio = originalHeight / originalWidth;

    // Create versions based on original size
    const versions = {};

    for (const targetWidth of ALL_SIZES) {
      // Skip sizes larger than original
      if (targetWidth > originalWidth) continue;

      const targetHeight = Math.round(targetWidth * aspectRatio);
      const qualityConfig = getQualityConfig(targetWidth);

      const processedImage = Sharp(buffer).resize({
        width: targetWidth,
        height: targetHeight,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      });

      // Process WebP version
      const webpVersion = await processedImage.clone()
        .webp({
          quality: qualityConfig.quality,
          effort: qualityConfig.effort,
          smartSubsample: true,
          mixed: true
        })
        .toBuffer({ resolveWithObject: true });

      versions[`${targetWidth}-webp`] = {
        data: webpVersion.data,
        info: {
          width: webpVersion.info.width,
          height: webpVersion.info.height,
          format: 'webp',
          size: webpVersion.data.length,
          quality: qualityConfig.quality
        }
      };

      // Process AVIF version
      const avifVersion = await processedImage.clone()
        .avif({
          quality: qualityConfig.quality,
          effort: qualityConfig.effort + 2, // Higher effort for AVIF
          chromaSubsampling: '4:4:4'
        })
        .toBuffer({ resolveWithObject: true });

      versions[`${targetWidth}-avif`] = {
        data: avifVersion.data,
        info: {
          width: avifVersion.info.width,
          height: avifVersion.info.height,
          format: 'avif',
          size: avifVersion.data.length,
          quality: qualityConfig.quality
        }
      };
    }

    return versions;
  } catch (error) {
    console.error('Error processing image:', error);
    throw error;
  }
}

export const handler = async (event) => {
  console.log('Event received:', JSON.stringify(event, null, 2));
  try {
    const record = event.Records[0];
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    console.log('Processing image from:', { bucket, key });

    // Get original image using SDK v3
    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: key
    });

    console.log('Fetching original image...');
    const originalImage = await s3Client.send(getCommand);
    const buffer = Buffer.from(await originalImage.Body.transformToByteArray());
    console.log('Original image fetched, size:', buffer.length);

    console.log('Starting image processing...');
    const processedVersions = await processImage(buffer, key);
    console.log('Image processing complete, versions:', Object.keys(processedVersions));

    // Upload versions using SDK v3
    console.log('Starting upload of processed versions...');
    const uploadPromises = Object.entries(processedVersions).map(([versionKey, version]) => {
      const [width, format] = versionKey.split('-');
      const newKey = `processed/w${width}/${key.replace(/\.[^/.]+$/, `.${format}`)}`;

      console.log('Uploading version:', { newKey, format, width });

      const putCommand = new PutObjectCommand({
        Bucket: process.env.PROCESSED_BUCKET,
        Key: newKey,
        Body: version.data,
        ContentType: `image/${format}`,
        Metadata: {
          'width': version.info.width.toString(),
          'height': version.info.height.toString(),
          'size': version.info.size.toString(),
          'quality': version.info.quality.toString(),
        },
        CacheControl: 'public, max-age=31536000, immutable'
      });

      return s3Client.send(putCommand);
    });

    console.log('Waiting for all uploads to complete...');
    await Promise.all(uploadPromises);
    console.log('All uploads complete');

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Image processing complete',
        versions: Object.keys(processedVersions)
      })
    };
  } catch (error) {
    console.error('Error: in handler', error);
    throw error;
  }
};