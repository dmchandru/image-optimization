#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ImageOptimizationStack } from '../lib/image-optimization-stack';

const app = new cdk.App();

// Get configuration from context
const stage = app.node.tryGetContext('stage') || 'dev';
const existingSourceBucket = app.node.tryGetContext('sourceBucket');
const existingProcessedBucket = app.node.tryGetContext('processedBucket');

new ImageOptimizationStack(app, `ImageOptimization-${stage}`, {
  stage,
  existingSourceBucket,
  existingProcessedBucket,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  },
  description: `Image Optimization Stack (${stage})`
});
