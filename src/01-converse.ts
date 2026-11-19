// Step 1: ask the Palmway Transfers assistant one question with the Converse API.
// The system prompt tells the model who it is and gives it a few facts about the
// business. The user message is the customer's question.
//
// Usage:
//   AWS_PROFILE=<your-aws-profile> npm run 01
//   AWS_PROFILE=<your-aws-profile> npm run 01 -- "your question"

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

// Credentials come from AWS_PROFILE (set it when you run the script).
const client = new BedrockRuntimeClient({ region: 'us-east-1' });

const MODEL_ID = 'us.amazon.nova-lite-v1:0';

const SYSTEM_PROMPT = `You are the customer assistant for Palmway Transfers, a fictional airport transfer company in Sri Lanka.
Facts you can use:
- We pick up from Bandaranaike International Airport (CMB) 24 hours a day.
- Vehicles: Mini car (up to 3 passengers, 2 suitcases), Sedan (up to 3 passengers, 3 suitcases), Van (up to 8 passengers, 8 suitcases).
- For airport pickups the driver tracks the flight and waits up to 60 minutes after the actual landing time at no extra cost.
- Child seats are free but must be requested when booking.
Answer in a friendly, short way (under 120 words). If you do not know something, say so.`;

const question =
  process.argv[2] ??
  'We are a family of four with three large suitcases, landing at 11pm. Which vehicle should we book, and what happens if our flight is late?';

async function main(): Promise<void> {
  console.log(`Customer: ${question}\n`);

  const response = await client.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: question }] }],
      inferenceConfig: { temperature: 0.5, maxTokens: 300 },
    })
  );

  console.log('Assistant:', response.output?.message?.content?.[0]?.text);
  console.log('\nTokens:', response.usage); // inputTokens, outputTokens, totalTokens
  console.log('Stop reason:', response.stopReason);
  console.log('Latency (ms):', response.metrics?.latencyMs);
}

main().catch((err) => {
  console.error('Converse call failed:', err);
  process.exit(1);
});
