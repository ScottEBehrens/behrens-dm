import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Identity, EmailIdentity } from "aws-cdk-lib/aws-ses";
import { HostedZone } from "aws-cdk-lib/aws-route53";

import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';

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

    // --- SES Domain Identity ---
    // This verifies behrens-hub.com and configures MAIL FROM = noreply.behrens-hub.com
    new EmailIdentity(this, "CirclesDomainIdentity", {
      identity: Identity.domain(domainRoot),
      mailFromDomain: `noreply.${domainRoot}`,
    });

    // --- S3 Bucket for SPA ---
    const siteBucket = new s3.Bucket(this, 'CirclesSiteBucket', {
      bucketName: `circles-behrens-hub-${process.env.CDK_DEFAULT_ACCOUNT}`,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    // --- DynamoDB Table ---
    const table = new dynamodb.Table(this, 'CirclesTable', {
      tableName: 'CirclesMessages',
      partitionKey: { name: 'familyId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- Circles metadata table (list of circles) ---
    const circlesMetaTable = new dynamodb.Table(this, 'CirclesMetaTable', {
      tableName: 'Circles',
      partitionKey: { name: 'circleId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- Circle membership table (which users belong to which circles) ---
    const circleMembershipsTable = new dynamodb.Table(this, 'CircleMembershipsTable', {
      tableName: 'CircleMemberships',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'circleId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const circlesInvitationsTable = new dynamodb.Table(this, 'CircleInvitationsTable', {
      tableName: 'CircleInvitations',
      partitionKey: {
        name: 'invitationId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY, // OK for dev; consider RETAIN in prod
    });

    // --- DynamoDB Table ---
    const circlesTagConfigTable = new dynamodb.Table(this, 'CircleTagConfigTable', {
      tableName: 'circles-tag-config',
      partitionKey: { name: 'tagKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- Lambda Function (API backend) ---
    const apiLambda = new lambda.Function(this, 'CirclesApiLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'circles-api-handler.handler',
      code: lambda.Code.fromAsset('../lambdas'),
      environment: {
        TABLE_NAME: table.tableName,                       // messages
        CIRCLES_TABLE_NAME: circlesMetaTable.tableName,   // circles metadata
        CIRCLE_MEMBERSHIPS_TABLE_NAME: circleMembershipsTable.tableName, // memberships
        INVITATIONS_TABLE_NAME: circlesInvitationsTable.tableName,
        CIRCLE_TAG_CONFIG_TABLE_NAME: circlesTagConfigTable.tableName,
        BEDROCK_MODEL_ID: 'anthropic.claude-3-haiku-20240307-v1:0',
        SES_FROM_EMAIL: 'no-reply-circles-invitation@behrens-hub.com',
        SES_REGION: 'us-east-1',
        BEDROCK_REGION: 'us-east-1',
      },
      timeout: Duration.seconds(10),
    });

    // Allow Lambda to read/write the table
    table.grantReadWriteData(apiLambda);
    circlesMetaTable.grantReadWriteData(apiLambda);
    circleMembershipsTable.grantReadWriteData(apiLambda);
    circlesInvitationsTable.grantReadWriteData(apiLambda);
    circlesTagConfigTable.grantReadData(apiLambda);

    apiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
        ],
        resources: ['*'], // you can tighten to specific model ARNs later
      }),
    );
    apiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "aws-marketplace:ViewSubscriptions",
          "aws-marketplace:Subscribe"
        ],  
        resources: ["*"]
      })
    );
    // --- SES permissions so Lambda can send invitation emails ---
    apiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ses:SendEmail',
          'ses:SendRawEmail',
        ],
        resources: ['*'],
      }),
    );

    // --- API Gateway (REST API for Circles) ---
    const api = new apigateway.RestApi(this, 'CirclesApi', {
      restApiName: 'CirclesApi',
      description: 'API backend for Circles family app',
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 5,   // 5 requests per second (average)
        throttlingBurstLimit: 20, // short bursts up to 20
      },
    });

    // --- Cognito User Pool + Client + Hosted UI ---
    const userPool = new cognito.UserPool(this, 'CirclesUserPool', {
      userPoolName: 'circles-user-pool',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: false,
        },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    });

    const userPoolClient = userPool.addClient('CirclesUserPoolClient', {
      userPoolClientName: 'circles-web-client',
      generateSecret: false, // SPA / static front-end
      oAuth: {
        flows: {
          implicitCodeGrant: true, // enables id_token in URL fragment
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: ['https://circles.behrens-hub.com/'],
        logoutUrls: ['https://circles.behrens-hub.com/'],
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
    });

    const userPoolDomain = userPool.addDomain('CirclesUserPoolDomain', {
      cognitoDomain: {
        domainPrefix: 'circles-behrens-hub', // must be globally unique
      },
    });

    // userPoolDomain.domainName is already the full Cognito domain host
    const hostedUiBaseUrl = `https://${userPoolDomain.domainName}`;

    // --- API Gateway Cognito Authorizer ---
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CirclesAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: 'circles-cognito-authorizer',
    });

    // --- /api/circles resource, secured by Cognito ---
    const apiBaseResource = api.root.addResource('api');
    const circlesResource = apiBaseResource.addResource('circles');

    const lambdaIntegration = new apigateway.LambdaIntegration(apiLambda);

    const methodOptions: apigateway.MethodOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // /api/circles (ANY – list/post messages, etc.)
    circlesResource.addMethod('ANY', lambdaIntegration, methodOptions);

    // /api/circles/config → returns circles the user belongs to
    const circlesConfigResource = circlesResource.addResource('config');
    circlesConfigResource.addMethod('GET', lambdaIntegration, methodOptions);

    // POST /api/circles/{circleId}/invitations  -> create invitation for a circle
    const circleIdResource = circlesResource.addResource('{circleId}');
    const circleInvitationsResource = circleIdResource.addResource('invitations');
    circleInvitationsResource.addMethod('POST', lambdaIntegration, methodOptions);

    // POST /api/circles/invitations/accept  -> accept an invitation
    const invitationsResource = circlesResource.addResource('invitations');
    const invitationsAcceptResource = invitationsResource.addResource('accept');
    invitationsAcceptResource.addMethod('POST', lambdaIntegration, methodOptions);

    // GET /api/circles/members → list members of a circle
    const circlesMembersResource = circlesResource.addResource('members');
    circlesMembersResource.addMethod('GET', lambdaIntegration, methodOptions);

    // --- /api/prompts (POST) ---
    // Bedrock-backed prompt suggestions for the currently selected circle
    const promptsResource = apiBaseResource.addResource('prompts');
    promptsResource.addMethod('POST', lambdaIntegration, methodOptions);

    circlesResource.addCorsPreflight({
      allowOrigins: ['https://circles.behrens-hub.com'], // or '*' while experimenting
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    });

    // /api/stats → analytics endpoint (authenticated)
    const statsResource = apiBaseResource.addResource('stats');
    statsResource.addMethod('GET', lambdaIntegration, methodOptions);
    statsResource.addCorsPreflight({
      allowOrigins: ['https://circles.behrens-hub.com'],
      allowMethods: ['GET', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    });


    // Base execute-api hostname for CloudFront origin
    const apiDomain = `${api.restApiId}.execute-api.${this.region}.amazonaws.com`;

    // --- CloudFront OAI for S3 ---
    const oai = new cloudfront.OriginAccessIdentity(this, 'CirclesOAI');
    siteBucket.grantRead(oai);

    // --- Cache Policies ---
    const spaCachePolicy = new cloudfront.CachePolicy(this, 'CirclesSpaCachePolicy', {
      cachePolicyName: 'circles-spa-cache-policy',
      comment: 'Short cache for Circles SPA',
      defaultTtl: Duration.minutes(5),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.minutes(10),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

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

    // --- ADD WAF Web ACL (rate limiting per IP) ---
    // (placeholder – not configured yet)

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

    new CfnOutput(this, 'CirclesUserPoolId', {
      value: userPool.userPoolId,
    });

    new CfnOutput(this, 'CirclesUserPoolClientId', {
      value: userPoolClient.userPoolClientId,
    });

    new CfnOutput(this, 'CirclesHostedUiBaseUrl', {
      value: hostedUiBaseUrl,
    });

    new CfnOutput(this, 'CirclesMetaTableName', {
      value: circlesMetaTable.tableName,
    });

    new CfnOutput(this, 'CircleMembershipsTableName', {
      value: circleMembershipsTable.tableName,
    });

  }
}
