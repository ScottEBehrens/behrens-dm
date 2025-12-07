# Circles – A Lightweight Family Messaging & Conversation App

Circles is a lightweight, serverless web application designed to help families stay connected through structured conversation prompts and threaded question–answer discussions.

The app supports:

- Circle-based messaging
- Threaded questions and answers
- AI-generated prompts (AWS Bedrock)
- Secure authentication (AWS Cognito)
- Invite-only access (AWS SES + invitation flows)
- A simple UI served from S3/CloudFront with no build step

---

## Features

### Circle-Based Messaging

Each family or group is represented as a *circle*, with its own message timeline. Users can switch between circles and see only the messages that belong to that circle.

### Threaded Questions & Answers

Messages now support question threads:

- **Questions** are first-class messages, tagged with:
  - `messageType = "question"`
  - A unique `messageId` (e.g., `"Q3"` or `"msg_<uuid>"`)
- **Answers** link back to a question using:
  - `questionId = <question.messageId>`

The UI groups messages into threads and displays:

- The **latest question** and its answers by default
- Older questions on demand via a “Show previous question” control

Older data may use human-readable message IDs like `"Q1"` / `"Q2"`, while newer messages typically use generated IDs such as `msg_<uuid>`. The system only cares that `questionId` matches the corresponding `messageId`.

### AI-Powered Prompt Suggestions

Circles integrates with **AWS Bedrock** (Claude 3 Haiku) to generate short, engaging conversation prompts for each circle. Prompts are:

- Tailored based on optional circle tags (e.g., life stage, relationship, support)
- Lightweight and family-friendly
- Returned as a JSON array for simple consumption by the frontend

### Authentication & Authorization

- Users authenticate using **Amazon Cognito Hosted UI**
- API Gateway validates JWT tokens
- The backend enforces **membership-based access**:
  - Users can only view or post messages in circles they belong to
  - Certain actions (e.g., creating invitations) are restricted to members

### Invitations

Circle owners (or authorized members) can invite others:

- An invitation record is stored in DynamoDB
- An email invitation is sent via **AWS SES**
- Accepting an invitation:
  - Validates the token and expiration
  - Creates or updates a membership record in `CircleMemberships`

### UI/UX

- Dark blue theme (Option A) with a clean, minimal layout
- Messages styled with subtle borders, with questions visually highlighted
- The latest question appears at the top; users can reveal older question threads
- Invite section and analytics are accessible but not visually dominant

---

## Architecture Overview

Circles is implemented as a fully serverless application using AWS.

High-level architecture:

- **Frontend**
  - Static site hosted on **S3**
  - Delivered via **CloudFront**
  - A single `index.html` with inline CSS and JavaScript (no frontend framework)
- **Backend**
  - **API Gateway (REST)** fronting a single Lambda handler:
    - `lambdas/circles-api-handler.js`
  - **Lambda** (Node.js 20) using AWS SDK v3
  - **DynamoDB** for messages, circles, memberships, invitations, and tag configuration
  - **Bedrock** for AI prompt generation
  - **SES** for email invitations
  - **Cognito** for authentication

Conceptual flow:

```text
Browser
  ↓ (HTTPS)
CloudFront (CDN)
  ↓
S3 (Static Frontend: index.html, JS, CSS)

Browser
  ↓ (JWT in Authorization header)
API Gateway (REST)
  ↓
Lambda (circles-api-handler.js)
  ↳ DynamoDB (CirclesMessages, Circles, CircleMemberships, CircleInvitations, circles-tag-config)
  ↳ Bedrock (prompt generation)
  ↳ SES (email invitations)
  ↳ Cognito (authentication, identity via JWT claims)
Data Model
Messages Table: CirclesMessages
Table name: CirclesMessages

Partition key: familyId

Sort key: createdAt

Each message is stored with fields similar to:

json
Copy code
{
  "familyId": "behrens",
  "createdAt": "2025-12-07T04:14:00.895Z",
  "author": "ScottEBehrens@yahoo.com",
  "text": "What's one thing you've learned from a younger or older family member that's stuck with you?",
  "messageId": "Q3",
  "messageType": "question"
}
For answers:

json
Copy code
{
  "familyId": "behrens",
  "createdAt": "2025-12-07T04:22:10.123Z",
  "author": "someone@example.com",
  "text": "Grandpa taught me how to listen first before speaking.",
  "messageId": "msg_b13f8c1e-3ef2-4f97-9e87-abc123def456",
  "messageType": "answer",
  "questionId": "Q3"
}
Message Model Rules
Questions

messageType = "question"

messageId must be present and unique (e.g., "Q1", "Q2", "Q3", or "msg_<uuid>")

questionId is typically not set on question rows

Answers

messageType = "answer"

questionId points to the messageId of the corresponding question

messageId is also generated and stored for the answer itself

Legacy Data

Some older records may have:

No messageType (implicitly treated as answers)

No messageId

Human-readable messageId values like "Q1" / "Q2"

The frontend logic is robust to these differences but the long-term direction is for all messages to have a consistent messageId format.

Circles Table: Circles
Stores basic metadata about each circle:

circleId (primary key)

name

description

Optional:

tags (array of tag keys used for AI prompt context)

Circle Memberships Table: CircleMemberships
Represents which users belong to which circles:

userId (partition key)

circleId

role (e.g., "owner", "member")

joinedAt

Memberships are used to enforce access to circle messages and to power /api/circles/config and /api/circles/members.

Circle Invitations Table: CircleInvitations
Handles invitation lifecycle:

invitationId (primary key)

circleId

invitedEmail

role

createdByUserId

createdAt

expiresAt (epoch seconds, TTL-style)

status (e.g., "PENDING", "ACCEPTED")

maxUses

usesCount

Tag Config Table: circles-tag-config
Stores configuration for circle tags used to tailor AI prompt generation:

tagKey

displayLabel

category (e.g., "life_stage", "relationship", "support")

description

toneGuidance

active (boolean)

Backend API
All routes are handled by lambdas/circles-api-handler.js behind API Gateway.

Authentication Context
The handler extracts user identity from the JWT claims supplied by API Gateway’s authorizer:

userId from sub / cognito:username / email

author (display name) from name / email / cognito:username

A set of circles the user belongs to via CircleMemberships

Most routes require:

A valid JWT

That the user is a member of the relevant circle

GET /api/circles?familyId=<circleId>
List messages for a circle.

Query parameters:

familyId – The circle ID (e.g., "behrens").

limit – Optional, defaults to 20. Retrieved in newest-first order.

Behavior:

Requires user to be a member of familyId

Queries CirclesMessages by familyId, sorted by createdAt (descending)

Returns an array of message items

Sample response:

json
Copy code
{
  "message": "OK",
  "familyId": "behrens",
  "count": 14,
  "items": [
    {
      "familyId": "behrens",
      "createdAt": "2025-12-07T04:22:10.123Z",
      "author": "someone@example.com",
      "text": "Grandpa taught me how to listen first before speaking.",
      "messageId": "msg_b13f8c1e-3ef2-4f97-9e87-abc123def456",
      "messageType": "answer",
      "questionId": "Q3"
    }
  ],
  "user": {
    "author": "Some User",
    "userId": "abc-123"
  }
}
POST /api/circles
Create a new message (question or answer).

Request body:

json
Copy code
{
  "familyId": "behrens",
  "text": "What's your favorite childhood memory?",
  "messageType": "question",
  "questionId": null
}
Backend behavior:

Validates that the user:

Has a valid token

Is a member of the target circle (familyId)

Normalizes/derives:

messageType (defaults to "answer" if not "question")

messageId (generates msg_<uuid> if none provided)

questionId (stored only for non-question messages, if provided)

Writes the item into CirclesMessages

Returns the saved item (including generated messageId)

Sample response:

json
Copy code
{
  "message": "Message created",
  "item": {
    "familyId": "behrens",
    "createdAt": "2025-12-07T04:14:00.895Z",
    "author": "ScottEBehrens@yahoo.com",
    "text": "What's one thing you've learned from a younger or older family member that's stuck with you?",
    "messageId": "msg_f0123abc-4567-890d-ef01-23456789abcd",
    "messageType": "question"
  },
  "user": {
    "author": "Scott Behrens",
    "userId": "user-123"
  }
}
POST /api/prompts
Generates conversation prompts via AWS Bedrock.

Request body:

json
Copy code
{
  "familyId": "behrens",
  "count": 4
}
Behavior:

Validates user and circle membership (for the given familyId / circleId)

Loads circle tags from circles-tag-config (if configured)

Builds a tag-aware instruction prompt for the model

Calls Bedrock using InvokeModelCommand

Attempts to parse the model’s response as a JSON array of strings

Falls back to line-splitting if the model ignores the JSON instruction

Sample response:

json
Copy code
{
  "message": "Prompts generated",
  "prompts": [
    "What is a small moment this week that made you smile?",
    "What is a favorite memory you share with someone in this circle?",
    "Is there something you're looking forward to in the next month?",
    "What is a piece of advice someone in the family gave you that stuck?"
  ],
  "modelId": "anthropic.claude-3-haiku-20240307-v1:0",
  "region": "us-east-1",
  "circleId": "behrens",
  "tagsUsed": [],
  "user": {
    "userId": "user-123",
    "author": "Scott Behrens"
  }
}
GET /api/circles/config
Returns the list of circles the current user belongs to.

Behavior:

Queries CircleMemberships for userId

For each circleId, loads metadata from the Circles table

Returns circles with name, description, and role

GET /api/circles/members?familyId=<circleId>
Lists members of a circle.

Behavior:

Requires user to be a member of the circle

Scans CircleMemberships for the given circleId

Returns an array of { userId, role, joinedAt }

POST /api/circles/{circleId}/invitations
Creates an invitation and (if configured) sends an email via SES.

Behavior:

Requires the caller to be a member of the circle

Writes an invitation record to CircleInvitations

Generates an invite link using FRONTEND_BASE_URL

Attempts to send an email (if SES_FROM_ADDRESS is configured)

POST /api/circles/invitations/accept
Accepts an invitation and adds the user to the circle.

Behavior:

Validates the invitation:

Exists

Not expired

Status is PENDING

Under maxUses (if set)

Creates/updates the membership record

Updates the invitation status to ACCEPTED and increments usesCount

Frontend Overview
The frontend is a single static-page app: index.html, containing:

HTML structure for:

Header with logo and circle selector

Message composer

Messages list

Suggest prompts section

Invite section

Lightweight footer

CSS for:

Dark blue theme

Question highlighting (borders, labels)

Message hover styling

JavaScript for:

Cognito authentication integration

Token handling and localStorage persistence

Circle switching

Loading and rendering messages

Posting messages and questions

Handling prompt suggestions

Handling invite flows

Multi-Question Rendering
The rendering logic:

Loads all messages for the selected circle via GET /api/circles.

Identifies all questions where messageType === "question".

Sorts questions newest → oldest by createdAt.

Displays:

The latest question labeled “Current Question”, plus its answers.

Any previously revealed questions labeled “Previous Question”, each with their respective answers.

Adds a “Show previous question” button when there are older questions available:

Clicking reveals one more question thread at a time.

Answers for a given question are identified by matching questionId to that question’s messageId and are typically sorted so the newest answers appear first.

Local Development
High-level steps:

Make frontend changes in index.html (HTML, CSS, JS).

Update backend code in lambdas/circles-api-handler.js if needed.

Deploy using AWS CDK, e.g.:

bash
Copy code
cdk deploy CirclesStack
Open the CloudFront URL.

Authenticate via Cognito Hosted UI.

Interact with circles, questions, answers, prompts, and invitations.

Roadmap
Recently Completed
Introduced a threaded Q&A message model:

messageType, messageId, and questionId

Updated the backend to:

Generate messageId for new messages

Respect messageType and questionId from the client

Updated the frontend to:

Highlight the current question and its answers

Allow revealing previous question threads

Performed a targeted data cleanup in DynamoDB to align older messages with the new schema.

Upcoming Iterations
1. Create a Circle (Backend + Frontend)
Add an API route to create new circles (e.g., POST /api/circles/create).

Insert:

A Circles row for the new circle.

A CircleMemberships row for the creator as owner.

Add a UI flow to:

Name a circle

Optionally describe it and choose tags

Automatically switch to the new circle after creation.

2. Refactor and Standardize the Codebase
Normalize naming:

Align usage of familyId vs. circleId.

Standardize messageId format going forward.

Clean up legacy assumptions and inline JS.

Consider splitting index.html into index.html, app.js, and app.css while preserving functionality.

3. Improved Auth Experience
Automatically redirect to Cognito Hosted UI on 401 (expired tokens).

Replace the composer and empty-state view with a friendly signed-out splash screen when no valid token is present.

4. Question History View
Offer a dedicated sidebar or page listing past questions.

Allow users to click a past question to focus on its thread (question + answers only).

License
This is a private, personal project.

It is not licensed for redistribution or commercial use without explicit permission.