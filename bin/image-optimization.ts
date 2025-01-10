#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ImageOptimizationStack } from '../lib/image-optimization-stack';

const app = new cdk.App();

// Get configuration from context
const stage = app.node.tryGetContext('stage') || 'dev';
const existingSourceBucket = app.node.tryGetContext('sourceBucket');
const existingProcessedBucket = existingSourceBucket ? `${existingSourceBucket}-processed` : undefined;

// Validate required parameters
if (!existingSourceBucket) {
  throw new Error('Source bucket name must be provided via context (-c sourceBucket=your-bucket-name)');
}

// Create stack with validated parameters
new ImageOptimizationStack(app, `ImageOptimization-${stage}`, {
  stage,
  existingSourceBucket,
  existingProcessedBucket,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-south-1'  // Default to ap-south-1 if not specified
  },
  description: `Image Optimization Stack (${stage}) - Source: ${existingSourceBucket}, Processed: ${existingProcessedBucket}`
});

// Add tags to all resources in the stack
cdk.Tags.of(app).add('Environment', stage);
cdk.Tags.of(app).add('Project', 'ImageOptimization');