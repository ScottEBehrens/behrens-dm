Circles — Serverless Family Messaging Platform

A lightweight, AWS-native, privacy-focused messaging system designed for families and small groups.

This repository contains the complete backend and frontend implementation of Circles, including infrastructure as code (AWS CDK), Lambda functions, API Gateway routing, DynamoDB schemas, a PWA frontend, and the full push-notification system (web push with VAPID + SQS fan-out).

This README provides the engineering-facing documentation for the system.

1. Related Documents

Circles maintains several external documents for product vision, roadmap, architectural detail, and regression testing:

Product Vision
https://scott.behrens-hub.com/circles/circles-product-vision.html

Technical Deep Dive & Architecture Details
https://scott.behrens-hub.com/circles-technical-deep-dive.html

Architecture Diagram (PNG)
https://scott.behrens-hub.com/circles/circles_arch_diagram.png

Product Roadmap
https://scott.behrens-hub.com/circles/circles-roadmap.html

Regression Test Plan
https://scott.behrens-hub.com/circles/circles_regression_test_plan.html

2. Architecture Overview

Circles is implemented as a fully serverless application:

                        +-----------------------------+
                        |         CloudFront          |
                        |  (HTTPS CDN + SPA hosting)  |
                        +-------------+---------------+
                                      |
                                      v
                        +-----------------------------+
                        |     S3 Single Page App      |
                        |   index.html + JS + CSS     |
                        +-------------+---------------+
                                      |
                                      v
+----------------------+     +-------------------------+      +----------------------------+
|   Cognito Hosted UI  |<--->|      API Gateway        |----->|   Lambda: circles-api      |
| OAuth2 / JWT tokens  |     |   /api/... endpoints    |      | Message logic + auth       |
+----------------------+     +-------------------------+      +----------------------------+
                                                                      |        |
                                                                      |        |
                                                                      v        v
                                                           +----------------------------+
                                                           |       DynamoDB Tables      |
                                                           |  - Circles                 |
                                                           |  - Messages                |
                                                           |  - CircleMembers           |
                                                           |  - InviteTokens            |
                                                           |  - NotificationSubs        |
                                                           +----------------------------+

                                      (event fan-out)
                                              |
                                              v
                                    +----------------------+
                                    |      SQS Queue       |
                                    | PushEventQueue       |
                                    +----------+-----------+
                                               |
                                               v
                                    +----------------------+
                                    |  Lambda: PushSender  |
                                    |  web-push w/ VAPID   |
                                    +----------------------+
                                               |
                                               v
                                   Browser → Service Worker → System Notification


The frontend is a Progressive Web App, allowing:

Installable “app-like” experience

Background service worker

Push notifications

Local caching and offline support

3. Infrastructure Components (CDK)
CloudFront + S3 SPA

Serves the single-page application.

Handles deep links (/?circleId=...).

API Gateway

Routes authenticated requests to backend Lambdas:

/api/circles

/api/circles/tags

/api/circles/config

/api/circles/members

/api/circles/invitations

/api/prompts

/api/notifications/subscribe

/api/notifications/unsubscribe

Lambda Functions

circles-api-handler.js
Core API routing, business logic, message creation, membership validation.

push-sender.js
Consumes SQS push events and sends WebPush payloads.

DynamoDB Tables
Table	Purpose	Key Schema
Circles	Circle definitions	PK: circleId
CircleMembers	Users <→ Circles mapping	PK: circleId, SK: userId
Messages	Questions + answers	PK: familyId, SK: timestamp
InviteTokens	Invitation system	PK: invitationId
CircleNotificationSubscriptions	Push subscriptions	PK: userId, SK: subscriptionId
SQS Queue

PushEventQueue
Decouples message creation from notification delivery.

Cognito Hosted UI

OAuth2 implicit flow

ID and access tokens stored in localStorage

Tokens validated server-side in Lambda

4. Deployment Model

Deployment is fully performed through AWS CDK.

Deployment Steps
cd infra/
npm install
npm run build
cdk deploy CirclesStack

Required Environment Variables (values redacted)
PUSH_VAPID_PUBLIC_KEY=REDACTED
PUSH_VAPID_PRIVATE_KEY=REDACTED
PUSH_VAPID_SUBJECT=mailto:you@example.com


These are loaded by CDK from process.env and passed into the PushSender Lambda.

5. Data Model
Messages Table Structure
{
  familyId: "devteam",
  messageId: "msg_xxx",
  messageType: "question" | "answer",
  text: "...",
  author: "userId",
  createdAt: "ISO8601",
  questionId: "msg_abc123"   // for answers only
}


Rules:

messageType === "question" → no questionId

messageType === "answer" → must include questionId

UI automatically tracks the most recent question per circle

Notification Subscriptions
{
  userId: "cognito-sub",
  subscriptionId: "uuid",
  endpoint: "https://fcm.googleapis.com/fcm/send/....",
  p256dh: "...",
  auth: "...",
  createdAt: "...",
  userAgent: "Chrome/123.0..."
}


Users may have multiple subscriptions (desktop, phone, tablet).

6. API Specification
POST /api/circles

Create a question or answer.

Request:

{
  "familyId": "devteam",
  "text": "What’s your favorite…",
  "messageType": "question" | "answer",
  "questionId": "msg_123"        // answers only
}


Response:

{
  "item": { ...message object... }
}


A NEW_QUESTION or NEW_ANSWER event is emitted into SQS.

POST /api/notifications/subscribe

Registers a device for push notifications.

Request:

{
  subscription: { ...PushSubscription... },
  userAgent: "Chrome ..."
}

POST /api/notifications/unsubscribe

Removes a device subscription.

POST /api/prompts

Returns AI-generated conversation prompts via Bedrock (Claude Haiku).

Other Endpoints

All documented in circles-api-handler.js:

/api/circles/config

/api/circles/tags

/api/circles/members

/api/circles/.../invitations

7. Backend Event Processing

Circles uses a two-stage event model:

Stage 1 — Message Creation (API Lambda)

When a question or answer is posted:

Lambda writes to Messages DynamoDB

Determines event type:

NEW_QUESTION

NEW_ANSWER

Builds fan-out event:

{
  type: "NEW_ANSWER",
  circleId: "...",
  circleName: "...",
  questionId: "...",
  actorUserId: "user-id-of-poster",
  questionPreview: "Short snippet…"
}


Sends JSON to SQS PushEventQueue

Stage 2 — Push Notification Delivery (PushSender Lambda)

PushSender:

Receives SQS messages

Queries CircleNotificationSubscriptions for all circle members

Filters out:

the actor (poster)

users with no subscriptions

Constructs WebPush payload

Uses web-push and VAPID keys to deliver browser notifications

Example payload:

{
  title: "New answer in devteam",
  body: "Scott replied: 'Here’s my thought…'",
  circleId: "devteam",
  url: "/?circleId=devteam"
}


The service worker displays the notification and handles tap-to-open behavior.

8. Push Notification System
Flow

User clicks Enable Notifications

Browser prompts for permission

Service worker registers

Browser creates a PushSubscription (VAPID public key)

SPA POSTs subscription to backend

Backend stores subscription

Future events fan out to all devices

Service Worker Responsibilities

Handle "push" events

Parse payload

Display system notification

Handle "notificationclick" to open correct circle

9. Frontend Logic & State Model
Circle State

Selected circle stored in localStorage

Questions and answers tracked client-side

UI shows most recent question and optionally older ones

Authentication State

Tokens stored in localStorage

Automatic redirect to Cognito Hosted UI on token expiration

Invite State

Temporary invite tokens stored in localStorage as pending_invite

10. Security Model

Authentication: Cognito Hosted UI + ID Token (JWT)

Authorization:

Lambda validates JWT on all protected routes

Circle membership is verified before message access

Push notifications delivered only to circle members

Data Integrity:

Only questions can omit questionId

Answers always linked to a question

Service Worker Isolation

SW served from top-level origin

Cannot access cookies or non-explicit JS context

11. Operational Considerations
Logging

circles-api-handler.js logs major API actions

push-sender.js logs:

Module load diagnostics

Subscription lookup

Delivery attempts and failures

Error Handling

SQS retry semantics ensure delivery attempts are retried

Dead-letter queue can be added (future iteration)

Browser Considerations

Chrome desktop and Android supported

iOS Safari push supported when installed as PWA

VAPID Key Rotation

Keys stored in environment variables

Can rotate without redeploying entire stack (only rerunning CDK with new env vars)

12. Product Vision

See full product vision here:
https://scott.behrens-hub.com/circles/circles-product-vision.html

13. Roadmap

Current and future releases documented here:
https://scott.behrens-hub.com/circles/circles-roadmap.html

14. Regression Test Plan

Full test coverage and scenarios available here:
https://scott.behrens-hub.com/circles/circles_regression_test_plan.html

15. License

Private / personal project (not licensed for general reuse).