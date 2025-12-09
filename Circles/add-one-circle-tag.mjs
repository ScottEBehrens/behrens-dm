// seed-circle-tags.js
// Pure JavaScript version for Node.js ESM (no TypeScript syntax)

// execute this first:
// npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb 

// to execute:
// node seed-circle-tags.mjs

// Imports
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";

// Config
const REGION = "us-east-1";
const TABLE_NAME = "circles-tag-config";

// -------- TAG DATA --------
// (Same content as before; truncated here for space—you will paste the full list)
const tags = [
  {
    "tagKey": "politics",
    "displayLabel": "Politics",
    "category": "life_stage",
    "description": "Parents or caregivers of infants.",
    "toneGuidance": "Keep prompts simple, gentle, and understanding of exhaustion and limited time.",
    "active": true
  }
];

// Dynamo client
const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION })
);

// Utility: split into 25-item chunks
function chunkArray(arr, size = 25) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// Seed function
async function seed() {
  console.log(`Seeding ${tags.length} tags into ${TABLE_NAME}...`);

  const batches = chunkArray(tags, 25);

  for (const batch of batches) {
    const params = {
      RequestItems: {
        [TABLE_NAME]: batch.map((item) => ({
          PutRequest: { Item: item }
        }))
      }
    };

    await dynamo.send(new BatchWriteCommand(params));
    console.log(`Wrote ${batch.length} items...`);
  }

  console.log("✔ Done seeding tags.");
}

// Execute
seed().catch((err) => {
  console.error("❌ Error seeding tags:", err);
  process.exit(1);
});
