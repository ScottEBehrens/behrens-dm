# Circles – Serverless Family Messaging, Invitations & AI-Generated Prompts

Circles is a fully serverless, cloud-native messaging and family-engagement application demonstrating modern AWS design patterns.  
It includes authenticated messaging, invitations, analytics, and **AI-generated conversation starters** powered by Amazon Bedrock.

👉 **Live Demo:** https://circles.behrens-hub.com  
👉 **Portfolio Page:** https://scott.behrens-hub.com/circles

---

## 🌄 Overview

Circles is designed as a compact but complete demonstration of cloud engineering capabilities:

- Identity & Access Management (Cognito HostedUI + token handling)
- Secure serverless APIs (API Gateway + Lambda)
- DynamoDB data modeling  
- Role-based authorization via membership records  
- Invitation onboarding system  
- Analytics endpoints  
- On-demand AI prompt generation with Bedrock  
- SPA frontend delivered via CloudFront + S3 (zero dependencies)

---

# 📷 Screenshots

> Replace these with real screenshots once available.

### 🔐 Login
![Login Placeholder](docs/screenshots/login.png)

### 💬 Messaging
![Messaging Placeholder](docs/screenshots/messages.png)

### 🎟️ Invitations
![Invites Placeholder](docs/screenshots/invite.png)

### 📊 Analytics
![Analytics Placeholder](docs/screenshots/analytics.png)

### 🤖 AI Prompts
![AI Prompts Placeholder](docs/screenshots/ai-prompts.png)

---

# 🧱 Architecture

![Architecture Diagram](https://scott.behrens-hub.com/circles/circles_arch_diagram.png)

---

# 🏗️ Architecture Summary

```
SPA (CloudFront → S3) 
    |
Cognito Hosted UI
    |
API Gateway (JWT Auth)
    |
Lambda (Node.js 20)
    |
DynamoDB Tables
    |
Amazon Bedrock (Claude 3 Haiku)
```

---

# ✨ Features

## Messaging
- Authenticated users post and view messages.
- Messages sorted newest-first.

## Invitations
- One-time invite links with TTL and usage tracking.
- Accepting an invite automatically grants membership.

## Analytics
- Total circles, unique members, and member-count per circle.

## AI Prompt Generation
- Generates 3–5 short conversation prompts using Amazon Bedrock.
- Family-friendly and configurable.

---

# 🛠️ API Endpoints

| Method | Path | Description |
|--------|-------|-------------|
| GET | `/api/circles?familyId=X` | List messages |
| POST | `/api/circles` | Create message |
| GET | `/api/circles/config` | List user circles |
| POST | `/api/circles/{circleId}/invitations` | Create invite |
| POST | `/api/circles/invitations/accept` | Accept invite |
| GET | `/api/stats` | Analytics |
| POST | `/api/prompts` | AI prompt generation |

---

# 🧰 CDK Deployment

```bash
npm install
cdk bootstrap
cdk deploy
```

Frontend deploy:

```bash
aws s3 sync ./frontend s3://<your-bucket> --delete
```

---

# ⚙️ Environment Variables (Lambda)

| Key | Purpose |
|-----|---------|
| `TABLE_NAME` | Messages table |
| `CIRCLES_TABLE_NAME` | Circle metadata |
| `CIRCLE_MEMBERSHIPS_TABLE_NAME` | Membership tracking |
| `INVITATIONS_TABLE_NAME` | Invitations |
| `BEDROCK_MODEL_ID` | Model ID (Claude 3 Haiku) |
| `BEDROCK_REGION` | `us-east-1` |

---

# 🚀 GitHub Actions CI/CD

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

- Scheduled daily AI prompts  
- PKCE OAuth  
- Reactions / likes  
- Real-time features  
- Circle creation from UI  

---

# 📜 License  
MIT
