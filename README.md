# Circles – Family Messaging Demo

Circles is a small serverless product I built to demonstrate how I design, secure, and deliver cloud-native web applications on AWS. It models a simple “family circles” messaging system with a modern authentication flow, fine-grained authorization, and a clean SPA experience.

The project exercises the full browser → CDN → API → data-store pipeline, centered around Cognito-backed JWT auth, API Gateway authorizers, and backend-enforced permissions.

Live demo: https://circles.behrens-hub.com

## Overview

Circles is a lightweight messaging app that uses:

- Frontend: static HTML/JS (no framework) hosted on S3
- Delivery: CloudFront CDN on a custom domain
- API: API Gateway + AWS Lambda (Node.js 20)
- Authorization: Cognito Hosted UI + User Pool + JWT + API authorizer
- Database: DynamoDB for messages, users, and circle membership
- Domain: circles.behrens-hub.com via Route 53 + ACM

The goal:
A clean, production-grade demonstration of how I design cloud architectures using serverless, identity, and zero-trust principles.

## Architecture

### Frontend (S3 + CloudFront + Custom Domain)

- SPA served from a private S3 bucket via an OAI.
- CloudFront handles:
  - / → S3 SPA
  - /api/* → API Gateway REST API
- Custom domain + HTTPS handled by:
  - Route 53 DNS
  - ACM certificate (us-east-1 for CloudFront)

### Backend (API Gateway + Lambda)

API Gateway (REST) exposes:

| Route | Method | Description |
|-------|--------|-------------|
| /api/circles | GET | List messages in a circle |
| /api/circles | POST | Create a message |
| /api/circles/config | GET | Return circles the current user belongs to |

### Cognito Authorizer

- Validates JWT (id_token) sent in Authorization: Bearer <token>
- Injects decoded claims into event.requestContext.authorizer
- Lambda uses the JWT’s sub and email/name to determine identity

## Lambda (Node.js 20)

- Uses AWS SDK v3 (@aws-sdk/client-dynamodb + lib-dynamodb)
- Implements:
  - Message reads/writes
  - Circle membership lookup
  - Authorization enforcement

### Backend Authorization Rules

1. User must be authenticated
2. User must be a member of the circle (CircleMemberships table)
3. If unauthorized → Lambda returns 403 Forbidden
4. Author name is taken from JWT claims, not the client body

This ensures zero-trust security whether the request comes from the SPA or a direct API call.

## DynamoDB Data Model

### CirclesMessages

Stores posts in a circle.

- PK: familyId (string)
- SK: createdAt (ISO string)
- Other fields: author, text

Example:
{
  "familyId": "behrens",
  "createdAt": "2025-12-04T18:22:11.123Z",
  "author": "Scott",
  "text": "Hello from the real Circles API!"
}

### Circles

Metadata about each circle:

- PK: circleId
- Fields: name, description

### CircleMemberships

Defines which users (Cognito sub) belong to which circles.

- PK: userId
- SK: circleId
- Fields: role, joinedAt

Backend enforces membership checks for every GET/POST /api/circles request.

## Authentication: Cognito + JWT + API Gateway Authorizer

### Cognito Setup

- User Pool + Hosted UI
- User Pool Client (no secret) for browser-based SPA
- Implicit Flow (response_type=token) for simplicity
- Redirect URI: https://circles.behrens-hub.com/

### Backend JWT Validation Flow

1. API Gateway uses Cognito Authorizer → validates token, signature, expiry.
2. Authorizer injects claims (email, username, sub, name) into event.requestContext.authorizer.claims.
3. Lambda extracts:
   - userId = claims.sub
   - author = claims.name || claims.email
4. Lambda queries CircleMemberships to determine allowed circles.
5. If a user requests a circle they do not belong to → return 403.

## Frontend Behavior

### On initial page load:

1. Parse JWT tokens (if returning from Cognito)
2. Update the UI to show signed in / not signed in
3. Call /api/circles/config to fetch:
   - Circles the user is a member of
   - Circle metadata
   - Role in each circle
4. Dynamically populate the <select> dropdown
5. Restore the last selected circle from localStorage
6. Load messages for that circle

### Message posting

- User selects circle
- Writes text
- SPA sends:
  { "familyId": "circleId", "text": "..." }
- Lambda:
  - Verifies membership
  - Uses the JWT author name
  - Writes the message to CirclesMessages

## Key Design Decisions

- Single-domain CloudFront routing keeps UX simple & avoids CORS issues.
- API Gateway Cognito Authorizer handles JWT validation so Lambda doesn’t have to.
- Backend membership enforcement ensures true access control (zero trust).
- DynamoDB chosen for:
  - Pay-per-request billing
  - Simple PK/SK message model
  - Natural fit for membership relationships
- Implicit Flow used initially; production version would use Authorization Code + PKCE.

## Future Work

- Move to Authorization Code + PKCE
- Add invite flow for adding new circle members
- Add owner/admin roles
- UI improvements
- Search, pagination, real-time updates (WebSockets/AppSync)

## Deployment

Deployable via CDK:

    cdk deploy CirclesStack

CDK provisions:

- S3 bucket (private)
- CloudFront distribution
- Route 53 record + ACM cert
- Lambda
- API Gateway REST API
- DynamoDB tables
- Cognito User Pool, Hosted UI domain, User Pool Client
- API Gateway Cognito Authorizer
