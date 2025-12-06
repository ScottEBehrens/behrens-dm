# Circles – Serverless Messaging, AI Context-Aware Prompts & Email Invitations  
Circles is a cloud-native, serverless relationship-strengthening platform designed for small groups, families, and teams. It demonstrates modern end-to-end AWS engineering patterns while delivering a simple, meaningful user experience.

The app enables secure group messaging, one-click invitations, analytics, and context-aware AI-generated conversation starters using Amazon Bedrock.

👉 **Live Demo:** https://circles.behrens-hub.com  
👉 **Portfolio Page:** https://scott.behrens-hub.com/circles  

---

# 🌄 Overview

Circles is intentionally minimalist on the surface, but engineered for **real-world scale and clarity**, showcasing:

- Cognito authentication (Hosted UI)
- Zero-trust serverless API (API Gateway + Lambda)
- DynamoDB data modeling & role-based access
- One-time invitations & membership lifecycle
- Circle-level tagging for AI context
- SES-powered email onboarding
- AI-generated conversation starters (Claude 3 Haiku)
- SPA frontend deployed via CloudFront + S3 (no frameworks required)
- Fully IaC-managed architecture via AWS CDK

The entire system is production-shaped but compact, suitable as both a portfolio artifact and a foundation for expansion.

---

# 🧱 Architecture

![Architecture Diagram](https://scott.behrens-hub.com/circles/circles_arch_diagram.png)

---

# 🏗️ Architecture Summary

```
CloudFront → S3 (SPA Hosting)
        |
Cognito Hosted UI (Auth)
        |
API Gateway (JWT Authorizer)
        |
Lambda (Node.js 20)
        |
DynamoDB Tables
   - circles
   - messages
   - memberships
   - invitations
   - tag-config
        |
Amazon Bedrock (Claude 3 Haiku)
        |
Amazon SES (Email Invites)
```

---

# ✨ Features

## 🔐 Authentication (Cognito Hosted UI)
- Secure login using Cognito’s Hosted UI  
- Access tokens stored locally for SPA → API communication  

---

## 💬 Messaging
- Circle-based message feeds  
- Authenticated posting  
- Timestamped, newest-first sorting  
- Zero-trust design: Lambda validates membership before reading/writing  

---

## 🎟️ Invitations (DynamoDB + SES)
Circles supports frictionless onboarding via:

### **One-time invitation links**
- Generated per user per circle  
- Enforced TTL and one-use semantics  
- Stored in `invitations` DynamoDB table  

### **SES Email Delivery (new)**
When a user enters an email address, the system automatically:

1. Creates the invitation record  
2. Fetches circle details  
3. Generates the invite link  
4. Sends a branded HTML + text email using Amazon SES  

Failures to send email do **not** break the API flow — the invite is still created.

---

## 🏷️ Circle Tags (New V1 Feature)
Each circle can have one or more tags describing:

- Family structure  
- Life stages  
- Faith groups  
- Peer groups  
- Support groups  
- Dev/test circles  
- And more  

Tags are stored in a dedicated DynamoDB table (`circles-tag-config`) and mapped to:

- A user-friendly label  
- A model-friendly description used for LLM context  

This enables **context-aware prompt generation**.

---

## 🤖 AI Prompt Generation (Bedrock + Claude 3)
Users can request 3–5 short conversation starters tailored to their circle.

Prompts are influenced by:

- Active circle tags  
- Tag descriptions  
- Purpose of the circle  
- Tone and safety requirements  

Backend uses Amazon Bedrock with Claude 3 Haiku for fast, low-cost inference.

---

## 📊 Analytics
Lightweight dashboard that shows:

- Total circles  
- Total memberships  
- Total messages  
- Distribution across circles  

---

# 🧰 API Endpoints

| Method | Path | Description |
|--------|-------|-------------|
| GET | `/api/circles` | List all circles for the authenticated user |
| GET | `/api/messages?circleId=X` | List messages for a circle |
| POST | `/api/messages` | Post message to a circle |
| POST | `/api/circles/{circleId}/invitations` | Create a one-time invitation and send SES email |
| POST | `/api/circles/invitations/accept` | Accept invitation and create membership |
| GET | `/api/stats` | Analytics dashboard data |
| POST | `/api/prompts` | Generate AI conversation prompts (tag-aware) |
| GET | `/api/tag-config` | (Internal) list tag configuration entries |

---

# 🧰 CDK Deployment

Backend + infrastructure:

```bash
cd infra
npm install
cdk bootstrap
cdk deploy
```

Frontend deploy:

```bash
aws s3 sync ./frontend s3://<your-bucket> --delete
```

---

# ⚙️ Lambda Environment Variables

| Key | Purpose |
|-----|---------|
| `TABLE_NAME` | Messages table |
| `CIRCLES_TABLE_NAME` | Circle metadata table |
| `CIRCLE_MEMBERSHIPS_TABLE_NAME` | Membership mappings |
| `INVITATIONS_TABLE_NAME` | Invitations table |
| `CIRCLE_TAG_CONFIG_TABLE_NAME` | Tag metadata table |
| `SES_FROM_EMAIL` | From-address for Circles invites |
| `SES_REGION` | SES region (us-east-1) |
| `BEDROCK_MODEL_ID` | Claude model ID |
| `FRONTEND_BASE_URL` | Used to build invite URLs |

---

# 🔄 CI/CD (GitHub Actions)

Automated deploy pipeline:

```yaml
name: Deploy Circles

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
    - uses: actions/checkout@v3

    - name: Configure AWS Credentials
      uses: aws-actions/configure-aws-credentials@v4
      with:
        role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
        aws-region: us-east-1

    - name: Install CDK & Dependencies
      run: |
        npm install -g aws-cdk
        cd infra
        npm install

    - name: CDK Deploy
      run: |
        cd infra
        cdk deploy --require-approval never

    - name: Deploy Frontend
      run: |
        aws s3 sync frontend/ s3://$FRONTEND_BUCKET --delete
```

---

# 🔮 Future Enhancements

- Full UI redesign (toasts, layout, prompt cards)
- Circle creation from UI
- Per-circle settings UI
- Scheduled daily AI prompts
- Reactions / emojis
- PKCE OAuth
- Real-time presence/typing indicators
- Personalized long-form prompt templates

---

# 📜 License  
MIT  
