import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';  // Add this import

import { Duration } from 'aws-cdk-lib';

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
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          autoDeleteObjects: true,
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

    // Queue for image processing tasks
    const imageProcessingQueue = new sqs.Queue(this, 'ImageProcessingQueue', {
      visibilityTimeout: Duration.minutes(5),
      retentionPeriod: Duration.days(1)
    });

    // Dead Letter Queue for failed tasks
    const dlq = new sqs.Queue(this, 'DeadLetterQueue');

    // Queue for size processing tasks
    const sizeProcessingQueue = new sqs.Queue(this, 'SizeProcessingQueue', {
      visibilityTimeout: Duration.minutes(2),
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
  }
}