// Step 2: a booking-style conversation over several turns.
// The model has no memory. Every call must include the FULL history, so we keep a
// messages array and append each user message and each assistant reply to it.
// Later turns ("that", "make it", "both of us") only make sense because of the history.
//
// Usage: AWS_PROFILE=<your-aws-profile> npm run 02

import { BedrockRuntimeClient, ConverseCommand, Message } from '@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient({ region: 'us-east-1' });

const MODEL_ID = 'us.amazon.nova-lite-v1:0';

const SYSTEM = [
  {
    text:
      'You are the booking assistant for Palmway Transfers, a fictional airport transfer company in Sri Lanka. ' +
      'Collect the details for a transfer from Bandaranaike International Airport (CMB): flight number, ' +
      'arrival date and time, destination, number of passengers, suitcases, and child seats. ' +
      'Vehicles: Mini car (3 passengers, 2 suitcases), Sedan (3 passengers, 3 suitcases), Van (8 passengers, 8 suitcases). ' +
      'Remember everything the customer already told you and do not ask for it again. ' +
      'You have no price list and cannot confirm bookings: never mention a price or currency amount, ' +
      'and say the team will send the price and confirmation by email. ' +
      'Keep each reply under 80 words.',
  },
];

const userTurns = [
  'Hi, I need a pickup from the airport to Kandy. I land on flight FA101 on 14 March at 8:40 in the morning.',
  'It will be me and my wife, plus our 4-year-old son. We have two big suitcases.',
  'Can you add a child seat for him? And which vehicle would you suggest?',
  'Great, please summarise the whole booking (flight, date, destination, people, luggage, extras) so I can check it.',
];

async function main(): Promise<void> {
  const history: Message[] = [];

  for (const [i, userText] of userTurns.entries()) {
    console.log(`\n--- Turn ${i + 1} ---`);
    console.log(`Customer: ${userText}`);

    // 1. Add the customer's message to the history.
    history.push({ role: 'user', content: [{ text: userText }] });

    // 2. Send the whole history.
    const response = await client.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: SYSTEM,
        messages: history,
        inferenceConfig: { temperature: 0.3, maxTokens: 250 },
      })
    );

    const reply = response.output?.message;
    if (!reply) throw new Error('No message in response');

    console.log(`Assistant: ${reply.content?.[0]?.text}`);
    console.log(`(input tokens: ${response.usage?.inputTokens}, output tokens: ${response.usage?.outputTokens})`);

    // 3. Add the reply to the history so the next turn can see it.
    history.push(reply);
  }

  console.log('\nNote: input tokens grow every turn because the full history is sent again.');
}

main().catch((err) => {
  console.error('Multi-turn failed:', err);
  process.exit(1);
});
