// lambdas/circles-api-handler.js

// Use AWS SDK v3, which is included in the Node.js 20 Lambda runtime
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  GetCommand,
  UpdateCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");

const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require("@aws-sdk/client-bedrock-runtime");

// SES v3 client for sending invitation emails
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

const { randomUUID } = require("crypto");

// CDK sets these env vars
const TABLE_NAME = process.env.TABLE_NAME || "CirclesMessages"; // messages
const CIRCLES_TABLE_NAME = process.env.CIRCLES_TABLE_NAME || "Circles"; // circles metadata
const CIRCLE_MEMBERSHIPS_TABLE_NAME =
  process.env.CIRCLE_MEMBERSHIPS_TABLE_NAME || "CircleMemberships"; // memberships

const INVITATIONS_TABLE_NAME =
  process.env.INVITATIONS_TABLE_NAME || "CircleInvitations"; // invitations

// Tag config table (for approved circle tags)
const CIRCLE_TAG_CONFIG_TABLE_NAME =
  process.env.CIRCLE_TAG_CONFIG_TABLE_NAME || "circles-tag-config";

// Optional: base URL to build invite links (fallback to your known domain)
const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL || "https://circles.behrens-hub.com";

// Bedrock config
const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID || "anthropic.claude-3-haiku-20240307-v1:0";
const BEDROCK_REGION =
  process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1";

// SES config
const SES_REGION =
  process.env.SES_REGION || process.env.AWS_REGION || "us-east-1";
// Support either SES_FROM_ADDRESS or SES_FROM_EMAIL from env
const SES_FROM_ADDRESS =
  process.env.SES_FROM_ADDRESS ||
  process.env.SES_FROM_EMAIL ||
  null;

// Set up DocumentClient-style wrapper
const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

// Bedrock client (on-demand prompts)
const bedrockClient = new BedrockRuntimeClient({
  region: BEDROCK_REGION,
});

// SES client (for email invites)
const sesClient = new SESClient({
  region: SES_REGION,
});

// -------------------------
// Helpers: HTTP response
// -------------------------
function makeResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    },
    body: JSON.stringify(body, null, 2),
  };
}

// -------------------------
// Helpers: user from JWT
// -------------------------
function getUserFromEvent(event) {
  const rc = event.requestContext || {};
  const authorizer = rc.authorizer || {};

  console.log("requestContext.authorizer:", JSON.stringify(authorizer));

  // REST API with CognitoUserPoolsAuthorizer typically puts claims here:
  const claims =
    authorizer.claims ||
    (authorizer.jwt && authorizer.jwt.claims) ||
    null;

  if (!claims) {
    console.warn("No Cognito claims found on requestContext.authorizer");
    return {
      claims: null,
      author: "unknown",
      userId: null,
    };
  }

  const userId =
    claims.sub ||
    claims["cognito:username"] ||
    claims.email ||
    null;

  const author =
    claims.name ||
    claims.email ||
    claims["cognito:username"] ||
    userId ||
    "unknown";

  return {
    claims,
    author,
    userId,
  };
}

// -------------------------
// Helpers: memberships
// -------------------------
async function getUserMembershipCircleIds(userId) {
  if (!userId) return [];

  console.log("Querying memberships for userId:", userId);

  const membershipsResult = await ddb.send(
    new QueryCommand({
      TableName: CIRCLE_MEMBERSHIPS_TABLE_NAME,
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: {
        ":u": userId,
      },
    })
  );

  const items = membershipsResult.Items || [];
  const circleIds = items.map((m) => m.circleId).filter(Boolean);

  console.log("User membership circleIds:", circleIds);

  return circleIds;
}

// -------------------------
// TagConfig loader + helpers
// -------------------------

// Cache of all active tags for this Lambda container
let cachedTagConfig = null;

/**
 * Load all active tag config items from the CircleTagConfig table.
 * Each item should resemble:
 *  {
 *    tagKey,
 *    displayLabel,
 *    category,       // e.g. "life_stage" | "relationship" | "support"
 *    description?,
 *    toneGuidance?,
 *    active: true
 *  }
 */
async function loadAllTagConfigs() {
  if (!CIRCLE_TAG_CONFIG_TABLE_NAME) {
    console.warn(
      "CIRCLE_TAG_CONFIG_TABLE_NAME is not set; returning empty tag config."
    );
    return [];
  }

  if (cachedTagConfig) {
    return cachedTagConfig;
  }

  console.log(
    "Scanning tag config table:",
    CIRCLE_TAG_CONFIG_TABLE_NAME,
    "for active tags"
  );

  const result = await ddb.send(
    new ScanCommand({
      TableName: CIRCLE_TAG_CONFIG_TABLE_NAME,
      // Only keep active tags if field exists; otherwise treat all as active
      FilterExpression: "attribute_not_exists(active) OR #active = :true",
      ExpressionAttributeNames: { "#active": "active" },
      ExpressionAttributeValues: { ":true": true },
    })
  );

  const items = result.Items || [];

  cachedTagConfig = items.map((item) => ({
    tagKey: item.tagKey,
    displayLabel: item.displayLabel || item.tagKey,
    category: item.category || "uncategorized",
    description: item.description || "",
    toneGuidance: item.toneGuidance || "",
    active:
      typeof item.active === "boolean" ? item.active : true,
  }));

  console.log("Loaded tag config count:", cachedTagConfig.length);

  return cachedTagConfig;
}

/**
 * Given a list of tag keys, return the matching TagConfig objects.
 */
async function getTagDetails(tagKeys) {
  if (!Array.isArray(tagKeys) || tagKeys.length === 0) {
    return [];
  }

  const all = await loadAllTagConfigs();
  const keySet = new Set(tagKeys);

  return all.filter((t) => keySet.has(t.tagKey));
}

/**
 * Fetch a circle by id and resolve its tag details (if any).
 */
async function getCircleAndTagContext(circleId) {
  if (!circleId) {
    return { circle: null, tagKeys: [], tagDetails: [] };
  }

  let circle = null;
  try {
    const res = await ddb.send(
      new GetCommand({
        TableName: CIRCLES_TABLE_NAME,
        Key: { circleId },
      })
    );
    circle = res.Item || null;
  } catch (e) {
    console.error("Error fetching circle for tag context:", e);
  }

  const tagKeys =
    circle && Array.isArray(circle.tags) ? circle.tags : [];

  const tagDetails = await getTagDetails(tagKeys);

  return { circle, tagKeys, tagDetails };
}

// -------------------------
// Email helper: send invitation email via SES
// -------------------------

async function sendInvitationEmail({
  toEmail,
  inviteUrl,
  circleName,
  inviterName,
}) {
  if (!SES_FROM_ADDRESS) {
    console.warn(
      "SES_FROM_ADDRESS is not set; skipping sending invitation email."
    );
    return {
      skipped: true,
      reason: "SES_FROM_ADDRESS not configured",
    };
  }

  const safeCircleName = circleName || "your circle";
  const safeInviterName = inviterName || "someone in your circle";

  const subject = `You’ve been invited to join ${safeCircleName}`;
  const textBody = [
    `Hi there,`,
    ``,
    `${safeInviterName} has invited you to join the circle "${safeCircleName}" on Circles.`,
    ``,
    `Click the link below to view the invitation and join:`,
    inviteUrl,
    ``,
    `If you weren’t expecting this, you can safely ignore this email.`,
  ].join("\n");

  const htmlBody = `
    <html>
      <body>
        <p>Hi there,</p>
        <p><strong>${safeInviterName}</strong> has invited you to join the circle "<strong>${safeCircleName}</strong>" on Circles.</p>
        <p>
          Click the link below to view the invitation and join:
          <br/>
          <a href="${inviteUrl}">${inviteUrl}</a>
        </p>
        <p>If you weren’t expecting this, you can safely ignore this email.</p>
      </body>
    </html>
  `;

  const params = {
    Source: SES_FROM_ADDRESS,
    Destination: {
      ToAddresses: [toEmail],
    },
    Message: {
      Subject: {
        Data: subject,
        Charset: "UTF-8",
      },
      Body: {
        Text: {
          Data: textBody,
          Charset: "UTF-8",
        },
        Html: {
          Data: htmlBody,
          Charset: "UTF-8",
        },
      },
    },
  };

  console.log("Sending SES invitation email:", {
    toEmail,
    subject,
    SES_REGION,
    SES_FROM_ADDRESS,
  });

  const result = await sesClient.send(new SendEmailCommand(params));
  console.log("SES SendEmail result:", result);

  return {
    skipped: false,
    messageId: result.MessageId,
  };
}

// -------------------------
// Invitation: create
// -------------------------
async function handleCreateInvitation(event, context) {
  const { userId, jwtAuthor, jwtClaims, userCircleSet } = context;

  if (!userId) {
    return makeResponse(401, {
      message: "Unauthorized: no userId in token",
    });
  }

  const circleId =
    event.pathParameters && event.pathParameters.circleId
      ? event.pathParameters.circleId
      : null;

  if (!circleId) {
    return makeResponse(400, { message: "Missing circleId in path" });
  }

  // Require caller to already be a member of the circle
  if (!userCircleSet.has(circleId)) {
    console.warn(
      "Forbidden createInvitation for circleId:",
      circleId,
      "userId:",
      userId
    );
    return makeResponse(403, {
      message:
        "Forbidden: user is not a member of this circle (cannot create invites)",
      circleId,
    });
  }

  if (!event.body) {
    return makeResponse(400, { message: "Request body is required" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    console.error("Invalid JSON body for createInvitation:", e);
    return makeResponse(400, { message: "Invalid JSON body" });
  }

  const email = payload.email && String(payload.email).trim();
  if (!email) {
    return makeResponse(400, { message: 'Field "email" is required' });
  }

  const role = payload.role || "member";
  const expiresInDays =
    payload.expiresInDays !== undefined
      ? Number(payload.expiresInDays)
      : 7;

  const now = new Date();
  const nowIso = now.toISOString();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const ttlSeconds = nowSeconds + expiresInDays * 24 * 3600;

  const invitationId = randomUUID();

  const item = {
    invitationId,
    circleId,
    invitedEmail: email,
    role,
    createdByUserId: userId,
    createdAt: nowIso,
    expiresAt: ttlSeconds,
    status: "PENDING",
    maxUses: 1,
    usesCount: 0,
  };

  console.log("Creating invitation item:", item);

  await ddb.send(
    new PutCommand({
      TableName: INVITATIONS_TABLE_NAME,
      Item: item,
      // Optionally enforce no overwrite:
      ConditionExpression: "attribute_not_exists(invitationId)",
    })
  );

  const inviteUrl = `${FRONTEND_BASE_URL}/?invite=${encodeURIComponent(
    invitationId
  )}`;

  // Optionally look up circle name for nicer email subject/body
  let circleName = circleId;
  try {
    const circleRes = await ddb.send(
      new GetCommand({
        TableName: CIRCLES_TABLE_NAME,
        Key: { circleId },
      })
    );
    if (circleRes.Item && circleRes.Item.name) {
      circleName = circleRes.Item.name;
    }
  } catch (e) {
    console.error("Error fetching circle metadata for invitation email:", e);
  }

  // Attempt to send email, but don't fail the whole request if SES errors
  let emailResult = {
    skipped: true,
    reason: "Not attempted",
  };

  try {
    emailResult = await sendInvitationEmail({
      toEmail: email,
      inviteUrl,
      circleName,
      inviterName: jwtAuthor || userId || "A circle member",
    });
  } catch (e) {
    console.error("Error sending invitation email via SES:", e);
    emailResult = {
      skipped: true,
      reason: `SES error: ${e.message || String(e)}`,
    };
  }

  return makeResponse(201, {
    message: "Invitation created",
    invitationId,
    inviteUrl,
    invitation: item,
    email: emailResult,
    user: {
      userId,
      author: jwtAuthor,
      claims: jwtClaims || undefined,
    },
  });
}

// -------------------------
// Invitation: accept
// -------------------------
async function handleAcceptInvitation(event, context) {
  const { userId, jwtAuthor, jwtClaims } = context;

  if (!userId) {
    return makeResponse(401, {
      message: "Unauthorized: no userId in token",
    });
  }

  if (!event.body) {
    return makeResponse(400, { message: "Request body is required" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    console.error("Invalid JSON body for acceptInvitation:", e);
    return makeResponse(400, { message: "Invalid JSON body" });
  }

  const invitationId =
    payload.invitationId && String(payload.invitationId).trim();
  if (!invitationId) {
    return makeResponse(400, { message: 'Field "invitationId" is required' });
  }

  console.log("Accepting invitation:", invitationId, "for userId:", userId);

  const invitationRes = await ddb.send(
    new GetCommand({
      TableName: INVITATIONS_TABLE_NAME,
      Key: { invitationId },
    })
  );

  const invitation = invitationRes.Item;
  if (!invitation) {
    return makeResponse(404, { message: "Invitation not found" });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const nowSeconds = Math.floor(now.getTime() / 1000);

  if (invitation.expiresAt && invitation.expiresAt <= nowSeconds) {
    console.warn("Invitation expired:", invitationId);
    return makeResponse(410, { message: "Invitation has expired" });
  }

  if (invitation.status && invitation.status !== "PENDING") {
    console.warn(
      "Invitation not pending:",
      invitationId,
      "status:",
      invitation.status
    );
    return makeResponse(400, {
      message: "Invitation is no longer pending",
      status: invitation.status,
    });
  }

  if (
    typeof invitation.maxUses === "number" &&
    typeof invitation.usesCount === "number" &&
    invitation.usesCount >= invitation.maxUses
  ) {
    console.warn("Invitation max uses reached:", invitationId);
    return makeResponse(400, {
      message: "Invitation has already been used",
    });
  }

  // Optional: enforce email match between invitation and current user
  const emailFromClaims =
    (jwtClaims && (jwtClaims.email || jwtClaims["email"])) || null;

  if (
    invitation.invitedEmail &&
    emailFromClaims &&
    invitation.invitedEmail.toLowerCase() !== emailFromClaims.toLowerCase()
  ) {
    console.warn(
      "Email mismatch on invitation accept:",
      invitationId,
      "invitedEmail:",
      invitation.invitedEmail,
      "userEmail:",
      emailFromClaims
    );
    // Currently only logging; can be tightened later.
  }

  const circleId = invitation.circleId;
  if (!circleId) {
    console.error("Invitation missing circleId:", invitationId);
    return makeResponse(500, {
      message: "Invitation is invalid (missing circleId)",
    });
  }

  // Create (or overwrite) membership record
  const membershipItem = {
    userId,
    circleId,
    role: invitation.role || "member",
    joinedAt: nowIso,
    displayName: jwtAuthor || userId, 
  };

  console.log("Creating/updating membership:", membershipItem);

  await ddb.send(
    new PutCommand({
      TableName: CIRCLE_MEMBERSHIPS_TABLE_NAME,
      Item: membershipItem,
    })
  );

  // Update invitation: mark as accepted + increment usesCount
  console.log("Updating invitation status to ACCEPTED:", invitationId);

  await ddb.send(
    new UpdateCommand({
      TableName: INVITATIONS_TABLE_NAME,
      Key: { invitationId },
      UpdateExpression:
        "SET #status = :s, acceptedByUserId = :u, acceptedAt = :a, usesCount = if_not_exists(usesCount, :zero) + :inc",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":s": "ACCEPTED",
        ":u": userId,
        ":a": nowIso,
        ":zero": 0,
        ":inc": 1,
      },
    })
  );

  // Optionally fetch circle metadata for nicer UX
  let circleName = circleId;
  try {
    const circleRes = await ddb.send(
      new GetCommand({
        TableName: CIRCLES_TABLE_NAME,
        Key: { circleId },
      })
    );
    if (circleRes.Item && circleRes.Item.name) {
      circleName = circleRes.Item.name;
    }
  } catch (e) {
    console.error("Error fetching circle metadata during accept:", e);
  }

  return makeResponse(200, {
    message: "Invitation accepted",
    circleId,
    circleName,
    user: {
      userId,
      author: jwtAuthor,
      claims: jwtClaims || undefined,
    },
  });
}

// -------------------------
// Stats: circles & users
// -------------------------
async function handleGetStats() {
  console.log("Handling GET /api/stats");

  // Scan Circles to count circles
  const circlesScan = await ddb.send(
    new ScanCommand({
      TableName: CIRCLES_TABLE_NAME,
    })
  );
  const circleItems = circlesScan.Items || [];
  const totalCircles = circleItems.length;

  // Scan CircleMemberships to count members
  const membershipsScan = await ddb.send(
    new ScanCommand({
      TableName: CIRCLE_MEMBERSHIPS_TABLE_NAME,
    })
  );
  const membershipItems = membershipsScan.Items || [];

  // Unique user count
  const userIdSet = new Set();
  // Members per circle
  const membersByCircleMap = new Map();

  for (const m of membershipItems) {
    if (!m) continue;
    const u = m.userId;
    const c = m.circleId;
    if (u) {
      userIdSet.add(u);
    }
    if (c) {
      if (!membersByCircleMap.has(c)) {
        membersByCircleMap.set(c, new Set());
      }
      membersByCircleMap.get(c).add(u);
    }
  }

  const totalMembers = userIdSet.size;

  const membersByCircle = [];
  for (const [circleId, userSet] of membersByCircleMap.entries()) {
    membersByCircle.push({
      circleId,
      memberCount: userSet.size,
    });
  }

  // Sort for stable UI
  membersByCircle.sort((a, b) => a.circleId.localeCompare(b.circleId));

  return makeResponse(200, {
    totalCircles,
    totalMemberships: membershipItems.length,
    totalMembers,
    membersByCircle,
  });
}

// -------------------------
// Circle members: list who’s in a circle
// GET /api/circles/members?familyId=... (or circleId=...)
// -------------------------
async function handleGetCircleMembers(event, context) {
  const { userId, jwtAuthor, userCircleSet } = context;

  if (!userId) {
    return makeResponse(401, {
      message: "Unauthorized: no userId in token",
    });
  }

  const qs = event.queryStringParameters || {};
  // Stay consistent with existing API that uses familyId as the circle key,
  // but also accept circleId as an alias.
  const circleId = qs.familyId || qs.circleId;

  if (!circleId) {
    return makeResponse(400, {
      message: 'Missing required query parameter "familyId" (or "circleId")',
    });
  }

  // Zero-trust: caller must already be a member of this circle
  if (!userCircleSet.has(circleId)) {
    console.warn(
      "Forbidden GET /api/circles/members for circleId:",
      circleId,
      "userId:",
      userId
    );
    return makeResponse(403, {
      message: "Forbidden: user is not a member of this circle",
      circleId,
    });
  }

  console.log(
    "Fetching members for circleId:",
    circleId,
    "requested by userId:",
    userId
  );

  // For now, use a Scan with filter on circleId.
  // This is fine at Circles scale and matches how stats currently work.
  const scanRes = await ddb.send(
    new ScanCommand({
      TableName: CIRCLE_MEMBERSHIPS_TABLE_NAME,
      FilterExpression: "circleId = :c",
      ExpressionAttributeValues: {
        ":c": circleId,
      },
    })
  );

  const membershipItems = scanRes.Items || [];

  const members = membershipItems.map((m) => ({

    userId: m.userId,
    role: m.role || "member",
    joinedAt: m.joinedAt || null,
    displayName: m.displayName || m.userId, 
  }));

  return makeResponse(200, {
    circleId,
    members,
    user: {
      userId,
      author: jwtAuthor,
    },
  });
}

// -------------------------
// Bedrock: generate conversation prompts
// POST /api/prompts
// -------------------------
async function handleGeneratePrompts(event, context) {
  const { userId, jwtAuthor, userCircleSet } = context;

  if (!userId) {
    return makeResponse(401, { message: "Unauthorized: no userId in token" });
  }

  let payload = {};
  if (event.body) {
    try {
      payload = JSON.parse(event.body);
    } catch (e) {
      console.warn("Invalid JSON body for /api/prompts, using defaults");
    }
  }

  // Allow caller to pass circleId/familyId so we can use tags
  const circleId = payload.familyId || payload.circleId || null;

  // Enforce that user is in the circle if one is provided
  if (circleId && !userCircleSet.has(circleId)) {
    console.warn(
      "Forbidden POST /api/prompts for circleId:",
      circleId,
      "userId:",
      userId
    );
    return makeResponse(403, {
      message: "Forbidden: user is not a member of this circle",
      circleId,
    });
  }

  // Allow caller to tweak count later; for now default 4, clipped 1–8.
  const countRaw = Number(payload.count || 4);
  const count = Math.min(Math.max(countRaw || 4, 1), 8);

  // -------------------------
  // Build tag-aware instructions
  // -------------------------

  let tagDetails = [];
  let circleNameForContext = null;

  if (circleId) {
    try {
      const res = await getCircleAndTagContext(circleId);
      tagDetails = res.tagDetails || [];
      circleNameForContext =
        (res.circle && res.circle.name) || circleId || null;
    } catch (e) {
      console.error("Error getting circle tag context:", e);
    }
  }

  const supportTags = tagDetails
    .filter((t) => t.category === "support")
    .map((t) => t.displayLabel);

  const nonSupportLabels = tagDetails
    .filter((t) => t.category !== "support")
    .map((t) => t.displayLabel);

  let tagContextLines = [];

  if (circleNameForContext) {
    tagContextLines.push(
      `The circle is called "${circleNameForContext}".`
    );
  }

  if (tagDetails.length > 0) {
    const allLabels = tagDetails.map((t) => t.displayLabel);
    tagContextLines.push(
      `This circle is described with the following tags: ${allLabels.join(
        ", "
      )}.`
    );
  }

  if (supportTags.length > 0) {
    tagContextLines.push(
      "Treat this as a support-oriented context. Be especially gentle and validating. Avoid giving medical or mental-health advice, and avoid anything that could reopen trauma or pressure people to share more than they want."
    );
  }

  if (nonSupportLabels.length > 0 && supportTags.length === 0) {
    tagContextLines.push(
      "Use these tags to tailor the tone and topics so prompts feel relevant and emotionally safe for this group."
    );
  }

  const tagContextInstruction =
    tagContextLines.length > 0
      ? tagContextLines.join(" ") + "\n\n"
      : "";

  const baseInstruction = `
Generate ${count} short, engaging conversation prompts for this private circle of families or close friends.

Each prompt should:
- Be 1–2 sentences max.
- Be warm and curious, not cheesy.
- Be suitable for older kids and adults (late PG-13), avoiding obviously sensitive topics (politics, explicit content, traumatic events) unless the tags clearly indicate a support context, in which case keep things very gentle and optional.
- Focus on reflection, memories, gentle check-ins, or light future plans.

Return ONLY a JSON array of strings.
For example:
["Prompt one...", "Prompt two...", "..."]

Do not include any extra text before or after the JSON.
`.trim();

  const userInstruction = `${tagContextInstruction}${baseInstruction}`;

  const nativeRequest = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 512,
    temperature: 0.7,
    top_p: 0.9,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: userInstruction,
          },
        ],
      },
    ],
  };

  console.log(
    "Invoking Bedrock model:",
    BEDROCK_MODEL_ID,
    "in region:",
    BEDROCK_REGION,
    "for userId:",
    userId,
    "circleId:",
    circleId,
    "tagCount:",
    tagDetails.length
  );

  try {
    const command = new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(nativeRequest),
    });

    const response = await bedrockClient.send(command);

    // In the JS v3 client, body is typically a Uint8Array
    const raw =
      response.body instanceof Uint8Array
        ? Buffer.from(response.body).toString("utf8")
        : String(response.body);

    let modelResult;
    try {
      modelResult = JSON.parse(raw);
    } catch (e) {
      console.error("Failed to parse Bedrock JSON response:", e, raw);
      return makeResponse(502, {
        message: "Failed to parse Bedrock response",
        raw,
      });
    }

    const textBlock =
      modelResult &&
      modelResult.content &&
      modelResult.content[0] &&
      modelResult.content[0].text
        ? String(modelResult.content[0].text).trim()
        : "";

    if (!textBlock) {
      console.warn("Empty text content from Bedrock:", modelResult);
      return makeResponse(502, {
        message: "Empty response from Bedrock",
      });
    }

    let prompts = [];
    try {
      const parsed = JSON.parse(textBlock);
      if (Array.isArray(parsed)) {
        prompts = parsed
          .map((p) => (typeof p === "string" ? p.trim() : ""))
          .filter(Boolean);
      }
    } catch (e) {
      // Fallback: split on newlines if model ignored JSON instruction.
      console.warn(
        "Bedrock did not return clean JSON array, falling back to line split"
      );
      prompts = textBlock
        .split("\n")
        .map((line) => line.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean);
    }

    // If somehow still empty, bail
    if (!prompts || prompts.length === 0) {
      return makeResponse(502, {
        message: "No prompts generated",
      });
    }

    // Truncate to requested count in case the model overshoots
    if (prompts.length > count) {
      prompts = prompts.slice(0, count);
    }

    return makeResponse(200, {
      message: "Prompts generated",
      prompts,
      modelId: BEDROCK_MODEL_ID,
      region: BEDROCK_REGION,
      circleId: circleId || null,
      tagsUsed: tagDetails.map((t) => t.tagKey),
      user: {
        userId,
        author: jwtAuthor,
      },
    });
  } catch (err) {
    console.error("Error invoking Bedrock:", {
      name: err.name,
      message: err.message,
      stack: err.stack,
      metadata: err.$metadata,
    });

    return makeResponse(502, {
      message: "Error invoking Bedrock",
      error: err.message || String(err),
      code: err.name || undefined,
    });
  }
}

// -------------------------
// Circle: create
// POST /api/circles with { action: "createCircle", ... }
// -------------------------
async function handleCreateCircle(payload, context) {
  const { userId, jwtAuthor, jwtClaims } = context;

  if (!userId) {
    return makeResponse(401, {
      message: "Unauthorized: no userId in token",
    });
  }

  const now = new Date();
  const nowIso = now.toISOString();

  const rawName = payload.name ?? payload.circleName;
  const name = rawName && String(rawName).trim();

  if (!name) {
    return makeResponse(400, {
      message: 'Field "name" (or "circleName") is required',
    });
  }

  const description =
    payload.description && String(payload.description).trim()
      ? String(payload.description).trim()
      : "";

  // Tags: expect an array of tag keys, filter to strings
  let tags = [];
  if (Array.isArray(payload.tags)) {
    tags = payload.tags
      .map((t) => String(t).trim())
      .filter((t) => t.length > 0);
  }

  // Optionally, validate tags against tag config (best-effort; non-fatal)
  if (tags.length > 0) {
    try {
      const validTagDetails = await getTagDetails(tags);
      const validKeys = new Set(validTagDetails.map((t) => t.tagKey));
      tags = tags.filter((t) => validKeys.has(t));
    } catch (e) {
      console.warn(
        "Error validating tags while creating circle; proceeding with raw tags",
        e
      );
    }
  }

  // Generate a circleId (random UUID-based)
  const circleId = `circle_${randomUUID()}`;

  const circleItem = {
    circleId,
    name,
    description,
    tags,
    createdAt: nowIso,
    createdByUserId: userId,
  };

  console.log("Creating circle:", circleItem);

  // Create circle metadata (fail if circleId somehow exists)
  await ddb.send(
    new PutCommand({
      TableName: CIRCLES_TABLE_NAME,
      Item: circleItem,
      ConditionExpression: "attribute_not_exists(circleId)",
    })
  );

  // Create creator membership with rich role info
  const membershipItem = {
    userId,
    circleId,
    role: "owner", // primary role
    joinedAt: nowIso,
    // additional flags so we can evolve roles later
    isCreator: true,
    isOwner: true,
    isAdmin: true,
    isMember: true,
    displayName: jwtAuthor || userId, 
  };

  console.log("Creating creator membership:", membershipItem);

  await ddb.send(
    new PutCommand({
      TableName: CIRCLE_MEMBERSHIPS_TABLE_NAME,
      Item: membershipItem,
    })
  );

  return makeResponse(201, {
    message: "Circle created",
    circle: circleItem,
    membership: membershipItem,
    user: {
      userId,
      author: jwtAuthor,
      claims: jwtClaims || undefined,
    },
  });
}


exports.handler = async (event) => {
  console.log("Incoming event:", JSON.stringify(event));

  const method = event.httpMethod || "GET";
  const path = event.path || "/";

  // Handle CORS preflight
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
      },
      body: "",
    };
  }

  try {
    // Pull user identity from JWT (if present)
    const userContext = getUserFromEvent(event);
    const jwtAuthor = userContext.author;
    const jwtClaims = userContext.claims;
    const userId = userContext.userId;

    // Load memberships once per request (for enforcement on circle routes)
    let userCircleIds = [];
    if (userId) {
      try {
        userCircleIds = await getUserMembershipCircleIds(userId);
      } catch (e) {
        console.error("Error loading memberships for userId:", userId, e);
      }
    }
    const userCircleSet = new Set(userCircleIds);

    // --------------------------------------------
    // Stats route (for dashboard)
    // GET /api/stats
    // --------------------------------------------
    if (method === "GET" && path.endsWith("/api/stats")) {
      // Note: currently no auth check; API Gateway may still require JWT
      return await handleGetStats();
    }

    // --------------------------------------------
    // Circle members route
    // GET /api/circles/members
    // --------------------------------------------
    if (method === "GET" && path.endsWith("/api/circles/members")) {
      return await handleGetCircleMembers(event, {
        userId,
        jwtAuthor,
        userCircleSet,
      });
    }

    // --------------------------------------------------
    // GET /api/circles/tags
    // Returns all active tag configs for use in UI
    // --------------------------------------------------
    if (method === "GET" && path.endsWith("/api/circles/tags")) {
      if (!userId) {
        return makeResponse(401, {
          message: "Unauthorized: no userId in token",
        });
      }

      try {
        const tags = await loadAllTagConfigs();

        // Optionally, trim fields to what the UI needs
        const simplified = tags.map((t) => ({
          tagKey: t.tagKey,
          displayLabel: t.displayLabel,
          category: t.category,
          description: t.description,
        }));

        return makeResponse(200, {
          tags: simplified,
        });
      } catch (err) {
        console.error("Error loading tag configs:", err);
        return makeResponse(500, {
          message: "Failed to load tag configs",
        });
      }
    }


    // --------------------------------------------
    // Bedrock prompts route
    // POST /api/prompts
    // --------------------------------------------
    if (method === "POST" && path.endsWith("/api/prompts")) {
      return await handleGeneratePrompts(event, {
        userId,
        jwtAuthor,
        userCircleSet,
      });
    }

    // --------------------------------------------
    // Invitation routes
    // --------------------------------------------
    // POST /api/circles/{circleId}/invitations
    if (
      method === "POST" &&
      path.startsWith("/api/circles/") &&
      path.endsWith("/invitations") &&
      event.pathParameters &&
      event.pathParameters.circleId
    ) {
      return await handleCreateInvitation(event, {
        userId,
        jwtAuthor,
        jwtClaims,
        userCircleSet,
      });
    }

    // POST /api/circles/invitations/accept
    if (method === "POST" && path === "/api/circles/invitations/accept") {
      return await handleAcceptInvitation(event, {
        userId,
        jwtAuthor,
        jwtClaims,
      });
    }

    // --------------------------------------------------
    // GET /api/circles/config
    // Returns circles the current user belongs to
    // --------------------------------------------------
    if (method === "GET" && path.endsWith("/api/circles/config")) {
      if (!userId) {
        return makeResponse(401, {
          message: "Unauthorized: no userId in token",
        });
      }

      console.log("Fetching circle memberships for userId (config):", userId);

      const membershipsResult = await ddb.send(
        new QueryCommand({
          TableName: CIRCLE_MEMBERSHIPS_TABLE_NAME,
          KeyConditionExpression: "userId = :u",
          ExpressionAttributeValues: {
            ":u": userId,
          },
        })
      );

      const membershipItems = membershipsResult.Items || [];
      const circleIds = membershipItems.map((m) => m.circleId).filter(Boolean);

      console.log("User circleIds (config):", circleIds);

      if (circleIds.length === 0) {
        return makeResponse(200, {
          circles: [],
          user: {
            userId,
            author: jwtAuthor,
          },
        });
      }

      // For each circleId, fetch metadata from Circles table
      const circles = [];
      for (const circleId of circleIds) {
        try {
          const circleRes = await ddb.send(
            new GetCommand({
              TableName: CIRCLES_TABLE_NAME,
              Key: { circleId },
            })
          );
          if (circleRes.Item) {
            circles.push({
              circleId,
              name: circleRes.Item.name || circleId,
              description: circleRes.Item.description || "",
              role:
                membershipItems.find((m) => m.circleId === circleId)?.role ||
                "member",
            });
          } else {
            circles.push({
              circleId,
              name: circleId,
              description: "",
              role:
                membershipItems.find((m) => m.circleId === circleId)?.role ||
                "member",
            });
          }
        } catch (e) {
          console.error("Error loading circle metadata for", circleId, e);
        }
      }

      return makeResponse(200, {
        circles,
        user: {
          userId,
          author: jwtAuthor,
        },
      });
    }

    // --------------------------------------------------
    // GET /api/circles (list messages) with membership enforcement
    // --------------------------------------------------
    if (method === "GET" && path.endsWith("/api/circles")) {
      const qs = event.queryStringParameters || {};
      const familyId = qs.familyId || "behrens"; // default while you're testing
      const limit = qs.limit ? Number(qs.limit) : 20;

      console.log(
        "GET /api/circles for familyId:",
        familyId,
        "limit:",
        limit,
        "user:",
        jwtAuthor,
        "userId:",
        userId
      );

      if (!userId) {
        return makeResponse(401, {
          message: "Unauthorized: no userId in token",
        });
      }

      if (!userCircleSet.has(familyId)) {
        console.warn(
          "Forbidden GET /api/circles for familyId:",
          familyId,
          "userId:",
          userId
        );
        return makeResponse(403, {
          message: "Forbidden: user is not a member of this circle",
          familyId,
        });
      }

      const result = await ddb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "familyId = :f",
          ExpressionAttributeValues: {
            ":f": familyId,
          },
          ScanIndexForward: false, // newest first
          Limit: limit,
        })
      );

      return makeResponse(200, {
        message: "OK",
        method,
        path,
        familyId,
        count: (result.Items || []).length,
        items: result.Items || [],
        user: {
          author: jwtAuthor,
          userId,
          claims: jwtClaims || undefined,
        },
      });
    }

    // --------------------------------------------------
    // POST /api/circles
    // - createCircle: create a new circle + membership
    // - default: create message in an existing circle
    // --------------------------------------------------
    if (method === "POST" && path.endsWith("/api/circles")) {
      if (!event.body) {
        return makeResponse(400, { message: "Request body is required" });
      }

      if (!userId) {
        return makeResponse(401, {
          message: "Unauthorized: no userId in token",
        });
      }

      let payload;
      try {
        payload = JSON.parse(event.body);
      } catch (e) {
        return makeResponse(400, { message: "Invalid JSON body" });
      }

      const action =
        payload.action && String(payload.action).trim().toLowerCase();

      // ---- NEW: circle creation branch ----
      if (action === "createcircle") {
        return await handleCreateCircle(payload, {
          userId,
          jwtAuthor,
          jwtClaims,
        });
      }

      // ---- Existing behavior: create a message in a circle ----

      const familyId = String(payload.familyId || "behrens").trim();
      const rawText = payload.text;
      const text = rawText && String(rawText).trim();

      if (!text) {
        return makeResponse(400, { message: 'Field "text" is required' });
      }

      if (!userCircleSet.has(familyId)) {
        console.warn(
          "Forbidden POST /api/circles for familyId:",
          familyId,
          "userId:",
          userId
        );
        return makeResponse(403, {
          message: "Forbidden: user is not a member of this circle",
          familyId,
        });
      }

      // Author from JWT claims, not the client body
      const author = jwtAuthor || "unknown";
      const createdAt = new Date().toISOString();

      // --- messageType / questionId / messageId handling ---

      // messageType: default to "answer" unless explicitly "question"
      const rawType =
        payload.messageType && String(payload.messageType).trim().toLowerCase();
      const messageType = rawType === "question" ? "question" : "answer";

      // questionId: only used for answers, points to the question's messageId
      const questionId =
        payload.questionId && String(payload.questionId).trim()
          ? String(payload.questionId).trim()
          : null;

      // messageId: always generate one if client didn't send it
      const messageId =
        payload.messageId && String(payload.messageId).trim()
          ? String(payload.messageId).trim()
          : `msg_${randomUUID()}`;

      const item = {
        familyId,
        createdAt,
        author,
        text,
        messageId,
        messageType,
      };

      // Only store questionId for non-question messages
      if (messageType !== "question" && questionId) {
        item.questionId = questionId;
      }

      console.log("Writing item:", item, "userId:", userId);

      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: item,
        })
      );

      return makeResponse(201, {
        message: "Message created",
        item,
        user: {
          author,
          userId,
          claims: jwtClaims || undefined,
        },
      });
    }

    // --------------------------------------------------
    // Fallback for any other route/method
    // --------------------------------------------------
    return makeResponse(404, {
      message: "Not found",
      method,
      path,
    });
  } catch (err) {
    console.error("Error handling request:", err);

    return makeResponse(500, {
      message: "Internal server error",
      error: err.message || String(err),
    });
  }
};
