import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

export interface CirclesStackProps extends StackProps {}

export class CirclesStack extends Stack {
  constructor(scope: Construct, id: string, props?: CirclesStackProps) {
    super(scope, id, props);

    const domainRoot = 'behrens-hub.com';
    const circlesSubdomain = 'circles';
    const circlesDomain = `${circlesSubdomain}.${domainRoot}`;

    // --- Hosted Zone (reuse your existing zone) ---
    const hostedZone = route53.HostedZone.fromLookup(this, 'CirclesHostedZone', {
      domainName: domainRoot,
    });

    // --- ACM Certificate (must be in us-east-1 for CloudFront) ---
    const cert = new acm.DnsValidatedCertificate(this, 'CirclesCert', {
      domainName: circlesDomain,
      hostedZone,
      region: 'us-east-1',
    });

    // --- S3 Bucket for React SPA ---
    const siteBucket = new s3.Bucket(this, 'CirclesSiteBucket', {
      bucketName: `circles-behrens-hub-${process.env.CDK_DEFAULT_ACCOUNT}`,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    // --- DynamoDB Table (on-demand, dev-friendly) ---
    const table = new dynamodb.Table(this, 'CirclesTable', {
      tableName: 'CirclesMessages',
      partitionKey: { name: 'familyId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY, // fine for dev/personal project
    });

    // --- Lambda Function (API backend) ---
    const apiLambda = new lambda.Function(this, 'CirclesApiLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'circles-api-handler.handler',
      code: lambda.Code.fromAsset('lambdas'),
      environment: {
        TABLE_NAME: table.tableName,
      },
      timeout: Duration.seconds(10),
    });

    // Allow Lambda to read/write the table
    table.grantReadWriteData(apiLambda);

    // --- API Gateway (REST API for Circles) ---
    const api = new apigateway.RestApi(this, 'CirclesApi', {
      restApiName: 'CirclesApi',
      description: 'API backend for Circles family app',
      deployOptions: {
        stageName: 'prod',
      },
    });

    const apiBaseResource = api.root.addResource('api');
    const circlesResource = apiBaseResource.addResource('circles');
    circlesResource.addMethod('ANY', new apigateway.LambdaIntegration(apiLambda));

    // Base execute-api hostname for CloudFront origin
    const apiDomain = `${api.restApiId}.execute-api.${this.region}.amazonaws.com`;

    // --- CloudFront OAI for S3 ---
    const oai = new cloudfront.OriginAccessIdentity(this, 'CirclesOAI');
    siteBucket.grantRead(oai);

    // --- Cache Policies ---
    // SPA: small cache to avoid hammering S3, still friendly for development.
    const spaCachePolicy = new cloudfront.CachePolicy(this, 'CirclesSpaCachePolicy', {
      cachePolicyName: 'circles-spa-cache-policy',
      comment: 'Short cache for Circles SPA',
      defaultTtl: Duration.minutes(5),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.minutes(10),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // API: essentially no caching at CloudFront
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'CirclesApiCachePolicy', {
      cachePolicyName: 'circles-api-no-cache-policy',
      comment: 'Disable caching for Circles API',
      defaultTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // Origins
    const spaOrigin = new origins.S3Origin(siteBucket, {
      originAccessIdentity: oai,
    });

    const apiOrigin = new origins.HttpOrigin(apiDomain, {
      originPath: `/${api.deploymentStage.stageName}`,
    });

    // --- CloudFront Distribution ---
    const distribution = new cloudfront.Distribution(this, 'CirclesDistribution', {
      defaultRootObject: 'index.html',
      domainNames: [circlesDomain],
      certificate: cert,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: spaOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: spaCachePolicy,
      },
      additionalBehaviors: {
        'api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: apiCachePolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });

    // --- Route 53 DNS A-record (Alias) for circles.behrens-hub.com ---
    new route53.ARecord(this, 'CirclesAliasRecord', {
      zone: hostedZone,
      recordName: circlesDomain,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(distribution),
      ),
    });

    // --- Outputs ---
    new CfnOutput(this, 'CirclesSiteUrl', {
      value: `https://${circlesDomain}`,
      description: 'Public URL for Circles SPA',
    });

    new CfnOutput(this, 'CirclesCloudFrontDomain', {
      value: distribution.distributionDomainName,
      description: 'Circles CloudFront distribution domain',
    });

    new CfnOutput(this, 'CirclesApiUrl', {
      value: api.url,
      description: 'Base URL for Circles API (without CloudFront)',
    });
  }
}
