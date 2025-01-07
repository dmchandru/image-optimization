// functions/image-processing/index.ts
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Sharp from 'sharp';

const s3Client = new S3Client({});

// Match Next.js default configurations
const DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
const IMAGE_SIZES = [16, 32, 48, 64, 96, 128, 256, 384];

// Combine all sizes for processing
const ALL_SIZES = [...IMAGE_SIZES, ...DEVICE_SIZES].sort((a, b) => a - b);

// Process images in smaller chunks to manage memory
const CHUNK_SIZE = 5;

const getQualityConfig = (width) => {
  if (width <= 384) return { quality: 80, effort: 4 };
  if (width <= 1080) return { quality: 85, effort: 5 };
  return { quality: 90, effort: 6 };
};

async function processImage(buffer, key) {
  try {
    const metadata = await Sharp(buffer).metadata();
    const { width: originalWidth, height: originalHeight } = metadata;
    const aspectRatio = originalHeight / originalWidth;

    console.log('Original image dimensions:', { width: originalWidth, height: originalHeight });

    // Filter sizes that are smaller than original
    const applicableSizes = ALL_SIZES.filter(size => size <= originalWidth);
    console.log('Processing sizes:', applicableSizes);

    // Process in chunks
    let processedCount = 0;
    for (let i = 0; i < applicableSizes.length; i += CHUNK_SIZE) {
      const chunk = applicableSizes.slice(i, i + CHUNK_SIZE);
      console.log(`Processing chunk ${Math.floor(i/CHUNK_SIZE) + 1}/${Math.ceil(applicableSizes.length/CHUNK_SIZE)}, sizes:`, chunk);

      const processedVersions = {};

      await Promise.all(chunk.map(async targetWidth => {
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

        processedVersions[`${targetWidth}-webp`] = {
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
            effort: qualityConfig.effort + 2,
            chromaSubsampling: '4:4:4'
          })
          .toBuffer({ resolveWithObject: true });

        processedVersions[`${targetWidth}-avif`] = {
          data: avifVersion.data,
          info: {
            width: avifVersion.info.width,
            height: avifVersion.info.height,
            format: 'avif',
            size: avifVersion.data.length,
            quality: qualityConfig.quality
          }
        };

        processedCount += 2; // Count both WebP and AVIF versions
      }));

      // Upload this chunk's versions
      await Promise.all(Object.entries(processedVersions).map(([versionKey, version]) => {
        const [width, format] = versionKey.split('-');
        const newKey = `processed/w${width}/${key.replace(/\.[^/.]+$/, `.${format}`)}`;
        
        console.log(`Uploading ${format} version for width ${width}`);

        return s3Client.send(new PutObjectCommand({
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
        }));
      }));

      console.log(`Chunk ${Math.floor(i/CHUNK_SIZE) + 1} complete: ${Object.keys(processedVersions).length} versions uploaded`);
    }

    return {
      message: 'Processing complete',
      totalVersions: processedCount
    };
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
    
    console.log('Processing image:', { bucket, key, size: record.s3.object.size });

    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: key
    });
    
    console.log('Fetching original image...');
    const originalImage = await s3Client.send(getCommand);
    const buffer = Buffer.from(await originalImage.Body.transformToByteArray());
    console.log('Original image fetched, size:', buffer.length);

    const result = await processImage(buffer, key);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Image processing complete',
        ...result
      })
    };
  } catch (error) {
    console.error('Error in handler:', error);
    throw error;
  }
};
