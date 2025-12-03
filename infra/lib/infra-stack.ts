import {
  Stack,
  StackProps,
  RemovalPolicy,
  CfnOutput,
  Duration,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';

export class InfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const domainRoot = 'behrens-hub.com';

    const familySites = [
      { id: 'Scott', subdomain: 'scott' },
      { id: 'Kat', subdomain: 'kat' },
      { id: 'Kacie', subdomain: 'kacie' },
      { id: 'Elizabeth', subdomain: 'elizabeth' },
    ];

    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: domainRoot,
    });

    // Wildcard cert for all subdomains (must be in us-east-1 for CloudFront)
    const wildcardCert = new acm.DnsValidatedCertificate(this, 'WildcardCert', {
      domainName: `*.${domainRoot}`,
      hostedZone,
      region: 'us-east-1',
    });

    familySites.forEach(({ id, subdomain }) => {
      const siteDomain = `${subdomain}.${domainRoot}`;

      // --- S3 Bucket (private, no versioning) ---
      const bucket = new s3.Bucket(this, `${id}Bucket`, {
        bucketName: `${subdomain}-behrens-hub-${process.env.CDK_DEFAULT_ACCOUNT}`,
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
      });

      // --- IAM User (per site) ---
      const user = new iam.User(this, `${id}s3User`, {
        userName: `${subdomain}-site-user`,
      });

      const policy = new iam.Policy(this, `${id}BucketPolicy`, {
        statements: [
          new iam.PolicyStatement({
            actions: ['s3:ListBucket'],
            resources: [bucket.bucketArn],
          }),
          new iam.PolicyStatement({
            actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
            resources: [`${bucket.bucketArn}/*`],
          }),
        ],
      });

      policy.attachToUser(user);

      new CfnOutput(this, `${id}IamUserName`, {
        value: user.userName,
        description: `${id}'s IAM Username`,
      });

      // --- CloudFront OAI ---
      const oai = new cloudfront.OriginAccessIdentity(this, `${id}OAI`);
      bucket.grantRead(oai);

      // --- CloudFront Cache Policy (short cache) ---
      const cachePolicy = new cloudfront.CachePolicy(this, `${id}CachePolicy`, {
        cachePolicyName: `${subdomain}-short-cache-policy`,
        comment: 'Short-lived cache for portfolio sites',
        defaultTtl: Duration.minutes(10),
        minTtl: Duration.seconds(0),
        maxTtl: Duration.hours(1),
        enableAcceptEncodingGzip: true,
        enableAcceptEncodingBrotli: true,
      });

      // --- Security Headers Policy ---
      const securityHeaders = new cloudfront.ResponseHeadersPolicy(
        this,
        `${id}SecurityHeaders`,
        {
          securityHeadersBehavior: { /* CSP removed fro outside css 
            contentSecurityPolicy: {
              contentSecurityPolicy: "default-src 'self';",
              override: true,
            }, */
            contentTypeOptions: { override: true },
            frameOptions: {
              frameOption: cloudfront.HeadersFrameOption.DENY,
              override: true,
            },
            referrerPolicy: {
              referrerPolicy: cloudfront.HeadersReferrerPolicy.SAME_ORIGIN,
              override: true,
            },
            strictTransportSecurity: {
              accessControlMaxAge: Duration.days(365),
              includeSubdomains: true,
              preload: true,
              override: true,
            },
            xssProtection: {
              protection: true,
              modeBlock: true,
              override: true,
            },
          },
        }
      );

      // --- CloudFront Distribution ---
      const distribution = new cloudfront.Distribution(
        this,
        `${id}Distribution`,
        {
          defaultRootObject: 'index.html',
          domainNames: [siteDomain],
          certificate: wildcardCert,
          priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US/Canada/Europe
          defaultBehavior: {
            origin: new origins.S3Origin(bucket, {
              originAccessIdentity: oai,
            }),
            viewerProtocolPolicy:
              cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            cachePolicy,
            originRequestPolicy:
              cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
            responseHeadersPolicy: securityHeaders,
          },
        }
      );

      // --- Route 53 DNS A-record (Alias) ---
      new route53.ARecord(this, `${id}AliasRecord`, {
        zone: hostedZone,
        recordName: siteDomain,
        target: route53.RecordTarget.fromAlias(
          new route53targets.CloudFrontTarget(distribution)
        ),
      });

      // --- Output URLs ---
      new CfnOutput(this, `${id}URL`, {
        value: `https://${siteDomain}`,
        description: `${id}'s site URL`,
      });

      new CfnOutput(this, `${id}CloudFrontURL`, {
        value: distribution.distributionDomainName,
        description: `${id}'s CF domain`,
      });
    });
  }
}
