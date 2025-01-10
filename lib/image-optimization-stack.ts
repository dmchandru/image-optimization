import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as certificateManager from 'aws-cdk-lib/aws-certificatemanager';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Duration } from 'aws-cdk-lib';

interface ImageOptimizationStackProps extends cdk.StackProps {
  readonly stage: string;
  readonly existingSourceBucket?: string;
  readonly existingProcessedBucket?: string;
  readonly domainName?: string;  // Optional custom domain name
  readonly certificateArn?: string;  // Optional ACM certificate ARN
}

export class ImageOptimizationStack extends cdk.Stack {
  public readonly distributionDomainName: string;  // Export CloudFront domain name

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
          bucketName: `${props.existingSourceBucket}-processed`,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          autoDeleteObjects: true,
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,  // Block all public access
          publicReadAccess: false,  // Ensure no public read access
          cors: [{
            allowedMethods: [s3.HttpMethods.GET],
            allowedOrigins: ['*'],
            allowedHeaders: ['*']
          }],
          lifecycleRules: [{
            transitions: [
              {
                storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                transitionAfter: Duration.days(90)  // Move to cheaper storage after 90 days
              }
            ]
          }]
        });

    // CloudFront Origin Access Identity
    const cloudfrontOAI = new cloudfront.OriginAccessIdentity(this, 'CloudFrontOAI', {
      comment: `OAI for ${id}`
    });

    // Grant CloudFront OAI read access to the processed bucket
    processedBucket.grantRead(cloudfrontOAI);

    // Create CloudFront Distribution
    const distribution = new cloudfront.Distribution(this, 'ImageDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(processedBucket, {
          originAccessIdentity: cloudfrontOAI
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: new cloudfront.CachePolicy(this, 'ImageCachePolicy', {
          defaultTtl: Duration.days(30),
          maxTtl: Duration.days(365),
          minTtl: Duration.days(1),
          queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
          headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Accept'),
          enableAcceptEncodingGzip: true,
          enableAcceptEncodingBrotli: true,
        }),
        originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
        compress: true,
      },
      domainNames: props.domainName ? [props.domainName] : undefined,
      certificate: props.certificateArn 
        ? certificateManager.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn)
        : undefined,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enabled: true,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    // Rest of your existing code...
    const imageProcessingQueue = new sqs.Queue(this, 'ImageProcessingQueue', {
      visibilityTimeout: Duration.minutes(5),
      retentionPeriod: Duration.days(1)
    });

    // Dead Letter Queue for failed tasks
    const dlq = new sqs.Queue(this, 'DeadLetterQueue');

    // Queue for size processing tasks
    const sizeProcessingQueue = new sqs.Queue(this, 'SizeProcessingQueue', {
      visibilityTimeout: Duration.minutes(4),
      retentionPeriod: Duration.days(1),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3
      }
    });

    // Initial processor Lambda
    const initialProcessor = new lambda.Function(this, 'InitialProcessor', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/initial-processor'),
      timeout: Duration.minutes(1),
      memorySize: 1024,
      environment: {
        QUEUE_URL: sizeProcessingQueue.queueUrl,
        SOURCE_BUCKET: sourceBucket.bucketName,
        PROCESSED_BUCKET: processedBucket.bucketName
      }
    });

    // Size processor Lambda
    const sizeProcessor = new lambda.Function(this, 'SizeProcessor', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/size-processor'),
      timeout: Duration.minutes(3),
      memorySize: 2048,
      environment: {
        SOURCE_BUCKET: sourceBucket.bucketName,
        PROCESSED_BUCKET: processedBucket.bucketName
      }
    });

    // Grant permissions
    if (!props.existingSourceBucket) {
      sourceBucket.grantRead(initialProcessor);
      sourceBucket.grantRead(sizeProcessor);
    } else {
      // Grant permissions for existing source bucket
      const sourcePermissions = new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`arn:aws:s3:::${props.existingSourceBucket}/*`]
      });
      initialProcessor.addToRolePolicy(sourcePermissions);
      sizeProcessor.addToRolePolicy(sourcePermissions);
    }

    if (!props.existingProcessedBucket) {
      processedBucket.grantWrite(sizeProcessor);
    } else {
      // Grant permissions for existing processed bucket
      sizeProcessor.addToRolePolicy(new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [`arn:aws:s3:::${props.existingProcessedBucket}/*`]
      }));
    }

    // Grant permissions
    imageProcessingQueue.grantSendMessages(initialProcessor);
    sizeProcessingQueue.grantSendMessages(initialProcessor);
    sizeProcessingQueue.grantConsumeMessages(sizeProcessor);

    // Add SQS trigger for size processor
    sizeProcessor.addEventSource(new SqsEventSource(sizeProcessingQueue, {
      batchSize: 1
    }));

    // Add S3 trigger for initial processor
    sourceBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(initialProcessor)
    );

    // Export CloudFront URL
    this.distributionDomainName = distribution.distributionDomainName;

    // Add stack outputs
    new cdk.CfnOutput(this, 'SourceBucketName', {
      value: sourceBucket.bucketName,
      description: 'Name of the source S3 bucket'
    });

    new cdk.CfnOutput(this, 'ProcessedBucketName', {
      value: processedBucket.bucketName,
      description: 'Name of the processed images S3 bucket'
    });

    // Stack Outputs
    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront Distribution ID'
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront Distribution Domain Name'
    });
  }
}