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

const { randomUUID } = require("crypto");

// CDK sets these env vars
const TABLE_NAME = process.env.TABLE_NAME || "CirclesMessages"; // messages
const CIRCLES_TABLE_NAME = process.env.CIRCLES_TABLE_NAME || "Circles"; // circles metadata
const CIRCLE_MEMBERSHIPS_TABLE_NAME =
  process.env.CIRCLE_MEMBERSHIPS_TABLE_NAME || "CircleMemberships"; // memberships

const INVITATIONS_TABLE_NAME =
  process.env.INVITATIONS_TABLE_NAME || "CircleInvitations"; // invitations

// Optional: base URL to build invite links (fallback to your known domain)
const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL || "https://circles.behrens-hub.com";

// Set up DocumentClient-style wrapper
const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

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

// Extract user info from Cognito JWT claims
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

// Load all circleIds this user is a member of
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

  return makeResponse(201, {
    message: "Invitation created",
    invitationId,
    inviteUrl,
    invitation: item,
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

  const invitationId = payload.invitationId && String(payload.invitationId).trim();
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
    // POST /api/circles (create message) with membership enforcement
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

      const familyId = payload.familyId || "behrens";
      const text = payload.text && String(payload.text).trim();

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

      const item = {
        familyId,
        createdAt,
        author,
        text,
      };

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
