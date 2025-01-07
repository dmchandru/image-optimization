import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Duration } from 'aws-cdk-lib';
import * as path from 'path';

interface ImageOptimizationStackProps extends cdk.StackProps {
  readonly stage: string;
  readonly existingSourceBucket?: string;
  readonly existingProcessedBucket?: string;
}

export class ImageOptimizationStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: ImageOptimizationStackProps) {
    super(scope, id, props);

    // Source bucket setup
    const sourceBucket = props.existingSourceBucket 
      ? s3.Bucket.fromBucketName(this, 'ExistingSourceBucket', props.existingSourceBucket)
      : new s3.Bucket(this, 'SourceBucket', {
          removalPolicy: cdk.RemovalPolicy.RETAIN,
          autoDeleteObjects: false,
          cors: [{
            allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
            allowedOrigins: ['*'],
            allowedHeaders: ['*']
          }],
          encryption: s3.BucketEncryption.S3_MANAGED,
          versioned: true
        });

    // Processed bucket setup
    const processedBucket = props.existingProcessedBucket
      ? s3.Bucket.fromBucketName(this, 'ExistingProcessedBucket', props.existingProcessedBucket)
      : new s3.Bucket(this, 'ProcessedBucket', {
          removalPolicy: cdk.RemovalPolicy.RETAIN,
          autoDeleteObjects: false,
          cors: [{
            allowedMethods: [s3.HttpMethods.GET],
            allowedOrigins: ['*'],
            allowedHeaders: ['*']
          }],
          lifecycleRules: [{
            expiration: Duration.days(30),
            prefix: 'processed/'
          }]
        });

    // Sharp Layer
    // const sharpLayer = new lambda.LayerVersion(this, 'SharpLayer', {
    //   code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-layer/sharp')),
    //   compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
    //   description: 'Sharp image processing library'
    // });

    // Image processor Lambda
    const imageProcessor = new lambda.Function(this, 'ImageProcessor', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/image-processor'),
      timeout: Duration.seconds(60),
      memorySize: 2048,
      environment: {
        STAGE: props.stage,
        PROCESSED_BUCKET: processedBucket.bucketName
      },
      logRetention: logs.RetentionDays.ONE_DAY,
      // bundling: {
      //   minify: true,
      //   sourceMap: true,
      //   externalModules: ['sharp']
      // },
      // layers: [sharpLayer]
    });

    // Grant permissions
    if (!props.existingSourceBucket) {
      sourceBucket.grantRead(imageProcessor);
    } else {
      // Grant permissions for existing source bucket
      imageProcessor.addToRolePolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`arn:aws:s3:::${props.existingSourceBucket}/*`]
      }));
    }

    if (!props.existingProcessedBucket) {
      processedBucket.grantWrite(imageProcessor);
    } else {
      // Grant permissions for existing processed bucket
      imageProcessor.addToRolePolicy(new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [`arn:aws:s3:::${props.existingProcessedBucket}/*`]
      }));
    }

    // S3 trigger for image processing
    sourceBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(imageProcessor)
    );

    // CloudFront distribution
    const cloudfrontOAI = new cloudfront.OriginAccessIdentity(this, 'CloudFrontOAI');

    // Grant CloudFront access to processed bucket
    if (!props.existingProcessedBucket) {
      processedBucket.addToResourcePolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [processedBucket.arnForObjects('*')],
        principals: [
          new iam.CanonicalUserPrincipal(
            cloudfrontOAI.cloudFrontOriginAccessIdentityS3CanonicalUserId
          )
        ]
      }));
    }

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(processedBucket, {
          originAccessIdentity: cloudfrontOAI
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        compress: true,
        cachePolicy: new cloudfront.CachePolicy(this, 'CachePolicy', {
          defaultTtl: Duration.days(30),
          minTtl: Duration.days(1),
          maxTtl: Duration.days(365),
          enableAcceptEncodingGzip: true,
          enableAcceptEncodingBrotli: true
        })
      }
    });

    // Stack outputs
    new cdk.CfnOutput(this, 'SourceBucketName', {
      value: sourceBucket.bucketName,
      description: 'Source bucket name'
    });

    new cdk.CfnOutput(this, 'ProcessedBucketName', {
      value: processedBucket.bucketName,
      description: 'Processed bucket name'
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution domain name'
    });
  }
}
