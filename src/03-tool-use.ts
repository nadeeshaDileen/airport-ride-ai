// Step 3: tool use (function calling).
// The model never runs your code. It replies with a "toolUse" request, YOUR code runs
// the function, then you send the result back as a "toolResult" and the model writes
// the answer. A turn limit stops the loop if the model keeps asking for tools.
//
// Usage:
//   AWS_PROFILE=<your-aws-profile> npm run 03
//   AWS_PROFILE=<your-aws-profile> npm run 03 -- "your question"

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ContentBlock,
  Message,
} from '@aws-sdk/client-bedrock-runtime';
import { MODEL_ID, REGION, stripThinking } from './shared/config.js';
import { TAXI_TOOLS, runTaxiTool } from './shared/converse-tools.js';

const MAX_TOOL_TURNS = 5;

const client = new BedrockRuntimeClient({ region: REGION });

const SYSTEM = [
  {
    text:
      'You are the assistant for Palmway Transfers, a fictional airport transfer company in Sri Lanka. ' +
      'Use the tools for fares and flight status. Never guess a price or a flight time. ' +
      'Keep the answer under 100 words.',
  },
];

const question =
  process.argv[2] ??
  'My flight FA245 lands today. How much is a van from the airport to Galle, and is my flight on time?';

async function main(): Promise<void> {
  console.log(`Customer: ${question}\n`);

  const messages: Message[] = [{ role: 'user', content: [{ text: question }] }];

  for (let turn = 1; turn <= MAX_TOOL_TURNS; turn++) {
    const response = await client.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: SYSTEM,
        messages,
        toolConfig: { tools: TAXI_TOOLS },
        inferenceConfig: { temperature: 0, maxTokens: 400 },
      })
    );

    const reply = response.output?.message;
    if (!reply) throw new Error('No message in response');
    messages.push(reply);

    console.log(`[Call ${turn}] stopReason: ${response.stopReason}, tokens: ${response.usage?.totalTokens}`);

    // The model answered directly: we are done.
    if (response.stopReason !== 'tool_use') {
      const text = reply.content?.map((b) => b.text ?? '').join('') ?? '';
      console.log(`\nAssistant: ${stripThinking(text)}`);
      return;
    }

    // The model asked for one or more tools: run each one and collect the results.
    const results: ContentBlock[] = [];
    for (const block of reply.content ?? []) {
      if (!block.toolUse) continue;
      const { name, input, toolUseId } = block.toolUse;

      console.log(`  Model wants: ${name}(${JSON.stringify(input)})`);
      const result = runTaxiTool(name ?? '', input);
      console.log(`  Tool returned: ${JSON.stringify(result)}`);

      results.push({ toolResult: { toolUseId, content: [{ json: result as never }] } });
    }

    // Tool results go back to the model as a "user" message.
    messages.push({ role: 'user', content: results });
  }

  throw new Error(`Stopped after ${MAX_TOOL_TURNS} tool turns without a final answer.`);
}

main().catch((err) => {
  console.error('Tool use failed:', err);
  process.exit(1);
});
