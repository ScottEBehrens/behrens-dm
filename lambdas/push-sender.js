// lambdas/push-sender.js

// --- Env vars ---
const subscriptionsTableName = process.env.CIRCLE_NOTIFICATION_SUBSCRIPTIONS_TABLE_NAME;
const preferencesTableName = process.env.CIRCLE_NOTIFICATION_PREFERENCES_TABLE_NAME; // not used yet
const vapidPublicKey = process.env.PUSH_VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.PUSH_VAPID_PRIVATE_KEY;
const vapidSubject = process.env.PUSH_VAPID_SUBJECT || "mailto:you@example.com";

// --- AWS SDK v3 DynamoDB client ---
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

// --- Diagnostics to understand module layout ---
const fs = require("fs");
try {
  console.log("PushSender init: cwd =", process.cwd());
  console.log("PushSender init: root files:", fs.readdirSync("."));
  if (fs.existsSync("./node_modules")) {
    console.log("PushSender init: node_modules entries:", fs.readdirSync("./node_modules"));
    if (fs.existsSync("./node_modules/web-push")) {
      console.log("PushSender init: web-push folder exists in node_modules");
    } else {
      console.log("PushSender init: web-push folder NOT found under node_modules");
    }
  } else {
    console.log("PushSender init: node_modules folder does NOT exist at root");
  }
} catch (diagErr) {
  console.error("PushSender init diagnostics failed:", diagErr);
}

// --- web-push setup with fallback require ---
let webpush = null;

try {
  // First try the normal module resolution
  webpush = require("web-push");
  console.log("web-push loaded via require('web-push')");
} catch (err1) {
  console.error("Failed to require('web-push'):", err1 && err1.message);
  try {
    // Fallback: explicitly load from local node_modules folder
    webpush = require("./node_modules/web-push");
    console.log("web-push loaded via require('./node_modules/web-push')");
  } catch (err2) {
    console.error("Also failed to require('./node_modules/web-push'):", err2 && err2.message);
    webpush = null;
  }
}

if (webpush && vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
} else if (!webpush) {
  console.warn("VAPID disabled: web-push library could not be loaded");
} else {
  console.warn("VAPID keys are not fully configured; push sending will be disabled.");
}

/**
 * @typedef {Object} NewQuestionPushEvent
 * @property {'NEW_QUESTION'} type
 * @property {string} circleId
 * @property {string} circleName
 * @property {string} questionId
 * @property {string} questionPreview
 * @property {string} actorUserId
 */

/**
 * Lambda handler for SQS events
 * @param {import('aws-lambda').SQSEvent} event
 */
exports.handler = async (event) => {
  console.log('PushSender invoked with', event.Records.length, 'records');

  for (const record of event.Records) {
    await handleRecord(record);
  }
};

/**
 * Process a single SQS record
 * @param {import('aws-lambda').SQSRecord} record
 */
async function handleRecord(record) {
  try {
    const body = record.body;
    console.log('Processing SQS record messageId:', record.messageId);

    /** @type {NewQuestionPushEvent} */
    const parsed = JSON.parse(body);

    if (parsed.type !== 'NEW_QUESTION') {
      console.warn('Unknown push event type:', parsed.type);
      return;
    }

    console.log('NEW_QUESTION push event:', {
      circleId: parsed.circleId,
      circleName: parsed.circleName,
      questionId: parsed.questionId,
      actorUserId: parsed.actorUserId,
      preview: parsed.questionPreview,
    });

    // V1 test: notify the ACTOR only (you),
    // so when you post a question, your own devices get a notification.
    // Later we'll expand to all circle members except the actor.
    if (!webpush) {
      console.warn('Skipping push send: web-push library could not be loaded');
      return;
    }
    
    if (!vapidPublicKey || !vapidPrivateKey) {
      console.warn('Skipping push send: VAPID keys not configured');
      return;
    }

    if (!subscriptionsTableName) {
      console.warn('Skipping push send: subscriptions table name not configured');
      return;
    }

    await sendNewQuestionNotificationToActor(parsed);
  } catch (err) {
    console.error('Error processing SQS record', {
      messageId: record.messageId,
      body: record.body,
      error: err,
    });
    throw err; // let SQS retry / DLQ handle it
  }
}

/**
 * Load subscriptions for the actorUserId and send a push notification to each.
 * @param {NewQuestionPushEvent} event
 */
async function sendNewQuestionNotificationToActor(event) {
  const userId = event.actorUserId;
  if (!userId) {
    console.warn('sendNewQuestionNotificationToActor called with no actorUserId');
    return;
  }

  // Query all subscriptions for this user
  let subscriptions;
  try {
    const resp = await ddb.send(
      new QueryCommand({
        TableName: subscriptionsTableName,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: {
          ':u': userId,
        },
      })
    );
    subscriptions = resp.Items || [];
    console.log(`Loaded ${subscriptions.length} subscriptions for user`, userId);
  } catch (err) {
    console.error('Failed to query subscriptions for user', userId, err);
    return;
  }

  if (!subscriptions.length) {
    console.log('No subscriptions found for user; nothing to send');
    return;
  }

  const payload = JSON.stringify({
    title: event.circleName
      ? `New question in ${event.circleName}`
      : 'New question in Circles',
    body: event.questionPreview || 'Someone posted a new question.',
    circleId: event.circleId,
    url: event.circleId
      ? `/?circleId=${encodeURIComponent(event.circleId)}`
      : '/',
  });

  for (const sub of subscriptions) {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth,
      },
    };

    try {
      console.log('Sending push to endpoint:', sub.endpoint);
      await webpush.sendNotification(pushSubscription, payload);
      console.log('Push sent successfully to subscriptionId', sub.subscriptionId);
    } catch (err) {
      console.error('Failed to send push to subscriptionId', sub.subscriptionId, err && err.statusCode, err && err.body);
      // Later: if statusCode 410/404, delete subscription as expired.
    }
  }
}
