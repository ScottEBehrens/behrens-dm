# Circles — Serverless Family Messaging Platform  
_A lightweight, AWS-native messaging system for small, trusted groups._

Circles is a private, installable Progressive Web App (PWA) backed by a fully serverless AWS architecture.  
It provides fast, low-friction daily communication for families and small groups through:

- Lightweight question/answer interactions  
- Push notifications (Web Push + VAPID)  
- Secure authentication via Cognito Hosted UI  
- Invite-based onboarding with SES email support  
- A modern, offline-capable SPA frontend  

This repository contains the complete infrastructure-as-code, backend logic, and frontend implementation.

---

# 1. External Documentation

To avoid duplication, Circles maintains standalone documentation pages that this README links to:

- **Product Vision**  
  https://scott.behrens-hub.com/circles/circles-product-vision.html

- **Architecture Deep Dive (Design + Pseudocode + Sequence Diagrams)**  
  https://scott.behrens-hub.com/circles-technical-deep-dive.html

- **Architecture Diagram (PNG)**  
  https://scott.behrens-hub.com/circles/circles_arch_diagram.png

- **Product Roadmap**  
  https://scott.behrens-hub.com/circles/circles-roadmap.html

- **Regression Test Plan**  
  https://scott.behrens-hub.com/circles/circles_regression_test_plan.html

These documents cover:
- Vision and goals  
- Extended SDLC walkthrough  
- Full architectural increments  
- Deep implementation details  
- Planned features and dev backlog  

---

# 2. High-Level Architecture Overview

Circles is fully serverless on AWS:

```
CloudFront → S3 SPA hosting → Browser (PWA)
           |
           v
      API Gateway
           |
           v
     Lambda: circles-api
           |
           v
       DynamoDB Tables
           - Circles
           - Messages
           - CircleMembers
           - InviteTokens
           - CircleNotificationSubscriptions

Push Flow:
circles-api → SQS PushEventQueue → PushSender Lambda → WebPush (VAPID)
```

Authentication:
- Cognito Hosted UI (PKCE)
- Access/ID tokens stored client-side
- All protected API routes validate JWTs + circle membership

Email:
- SES domain-verified (`behrens-hub.com`)
- Custom MAIL FROM (`noreply.behrens-hub.com`)
- Invitation emails used for secure onboarding
- Sandbox-compatible; production access pending

Push:
- WebPush (VAPID)
- Service worker handles push + tap-to-open
- Tap opens directly to the correct circle (`/?circleId=xyz`)

PWA:
- Installable on mobile/desktop
- Offline-first caching  
- Works in iOS Safari when installed as a PWA  

---

# 3. Infrastructure (AWS CDK)

This repo contains a full CDK app defining:

### CloudFront + S3
- SPA hosting  
- Handles deep linking and client-side routing  

### API Gateway
Routes:
- `/api/circles`
- `/api/circles/members`
- `/api/circles/tags`
- `/api/circles/config`
- `/api/circles/invitations`
- `/api/notifications/subscribe`
- `/api/notifications/unsubscribe`
- `/api/prompts` (Bedrock: Claude Haiku)

### Lambda Functions

#### `circles-api-handler.js`
- Core business logic  
- JWT validation  
- Circle membership checks  
- Question/answer creation  
- Invitation generation & SES email dispatch  
- Event fan-out to SQS  

#### `push-sender.js`
- Consumes SQS push events  
- Looks up subscriptions in DynamoDB  
- Sends WebPush notifications via VAPID  
- Handles Chrome, Android, and iOS (PWA)  

### DynamoDB Tables

| Table                          | Purpose                          | Keys                      |
|-------------------------------|----------------------------------|---------------------------|
| **Circles**                   | Circle definitions               | PK: circleId              |
| **CircleMembers**             | User ↔ Circle mapping            | PK: circleId, SK: userId  |
| **Messages**                  | Questions & answers              | PK: familyId, SK: ts      |
| **InviteTokens**              | Secure onboarding/invites        | PK: invitationId          |
| **CircleNotificationSubscriptions** | Push subscriptions per device | PK: userId, SK: subId     |

### SQS Queue: `PushEventQueue`
- Decouples user actions from notification delivery  
- Supports retries & future DLQ  

### Cognito Hosted UI
- PKCE Auth Code flow  
- 12-hour session duration  
- ID + access tokens validated inside Lambda  

---

# 4. Deployment Workflow

All deployments are handled via CDK.

### Steps:
```bash
cd infra/
npm install
npm run build
cdk deploy CirclesStack
```

### Required Environment Variables
Values passed into CDK and Lambdas:

```
PUSH_VAPID_PUBLIC_KEY=...
PUSH_VAPID_PRIVATE_KEY=...
PUSH_VAPID_SUBJECT=mailto:you@example.com
```

These are injected into the PushSender Lambda at deploy time.

---

# 5. API Summary

### `POST /api/circles`
Create a question or answer.

Request:
```json
{
  "familyId": "mycircle",
  "text": "What's your favorite…",
  "messageType": "question" | "answer",
  "questionId": "msg_123"
}
```

Response:
```json
{ "item": { ... } }
```

Side effects:
- Writes message to DynamoDB  
- Emits NEW_QUESTION or NEW_ANSWER event to SQS  

---

### `POST /api/notifications/subscribe`
Register a device’s push subscription.

### `POST /api/notifications/unsubscribe`
Remove a push subscription.

### `POST /api/prompts`
Generate conversation prompts using Amazon Bedrock.

---

# 6. Event Model

### Stage 1 — API Lambda
- Saves question/answer  
- Determines event type  
- Emits fan-out event to SQS  

Example event:
```json
{
  "type": "NEW_ANSWER",
  "circleId": "devteam",
  "circleName": "Dev Team",
  "actorUserId": "abc123",
  "questionId": "msg_abc",
  "questionPreview": "Short snippet..."
}
```

### Stage 2 — PushSender Lambda
- Reads SQS message  
- Fetches all member subscriptions  
- Removes sender  
- Sends notifications using WebPush  

Example payload:
```json
{
  "title": "New answer in devteam",
  "body": "Scott replied: 'Here’s my thought…'",
  "circleId": "devteam",
  "url": "/?circleId=devteam"
}
```

---

# 7. Frontend Overview (PWA)

### Key features:
- Installable on iOS/Android/Desktop  
- Service worker handles caching + push  
- Maintains local UI state for:
  - Selected circle  
  - Latest question  
  - Question history  
  - Pending invite tokens  

### Authentication Flow:
- Redirect to Cognito Hosted UI  
- Tokens stored in localStorage  
- Auto-renew & session extension (12-hour max)  

---

# 8. Security

- JWT validation for every protected route  
- Circle membership enforced server-side  
- Invite tokens randomized + expiry support  
- SES sending uses domain-verified identity  
- Service worker sandboxing prevents unauthorized access  

---

# 9. Operational Notes

### Logging
- `circles-api`: Major API actions, membership validations  
- `push-sender`: Delivery attempts, subscription failures  

### Error Handling
- SQS retry semantics  
- Future: DLQ for failed push deliveries  

### Browser Support
- Chrome desktop & Android fully supported  
- iOS Safari supported when installed as a PWA  
- VAPID key rotation supported  

---

# 10. Links

- **Product Vision:**  
  https://scott.behrens-hub.com/circles/circles-product-vision.html

- **Architecture Deep Dive:**  
  https://scott.behrens-hub.com/circles-technical-deep-dive.html

- **Architecture Diagram:**  
  https://scott.behrens-hub.com/circles/circles_arch_diagram.png

- **Roadmap:**  
  https://scott.behrens-hub.com/circles/circles-roadmap.html

- **Regression Test Plan:**  
  https://scott.behrens-hub.com/circles/circles_regression_test_plan.html

---

# 11. License

Private / personal project.  
Not licensed for general reuse.
