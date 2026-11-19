// Step 7: the same Palmway Transfers assistant, built with the Strands Agents SDK.
// Strands runs the tool loop and keeps the conversation history for you
// (compare with the hand-written loop in 06-chatbot.ts). The guardrail is set on the
// BedrockModel, so every model call is checked.
//
// Usage:
//   KNOWLEDGE_BASE_ID=<your-kb-id> GUARDRAIL_ID=<your-guardrail-id> GUARDRAIL_VERSION=1 \
//   AWS_PROFILE=<your-aws-profile> npm run 07
// Type "quit" to exit. Piped input also works.

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Agent, BedrockModel, tool } from '@strands-agents/sdk';
import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import z from 'zod';
import { MODEL_ID, REGION, requireEnv, stripThinking } from './shared/config.js';
import { estimateFare, getFlightStatus, VEHICLE_TYPES } from './shared/taxi-tools.js';

const knowledgeBaseId = requireEnv('KNOWLEDGE_BASE_ID');
const guardrailId = requireEnv('GUARDRAIL_ID');
const guardrailVersion = requireEnv('GUARDRAIL_VERSION');

// ============================================================
// Tool 1: retrieve (search the knowledge base with the Retrieve API)
// The JS SDK has no built-in retrieve tool, so we write a small one.
// ============================================================

const agentRuntime = new BedrockAgentRuntimeClient({ region: REGION });

const retrieve = tool({
  name: 'retrieve',
  description:
    'Search the Palmway Transfers policy and FAQ documents (booking, pricing rules, airport pickup, ' +
    'waiting time, cancellations, luggage, child seats, payments, safety, contact). ' +
    'Each result starts with its source file name.',
  inputSchema: z.object({
    query: z.string().describe('What to search for'),
  }),
  callback: async ({ query }) => {
    const res = await agentRuntime.send(
      new RetrieveCommand({
        knowledgeBaseId,
        retrievalQuery: { text: query },
        retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 3 } },
      })
    );

    const results = res.retrievalResults ?? [];
    if (results.length === 0) return 'No results found.';

    return results
      .map((r) => {
        const uri = r.location?.s3Location?.uri ?? 'unknown';
        const file = uri.split('/').pop() ?? uri;
        return `Source: ${file}\n${r.content?.text ?? ''}`;
      })
      .join('\n\n');
  },
});

// ============================================================
// Tools 2 and 3: fare estimate and flight status (mock data)
// ============================================================

const estimateFareTool = tool({
  name: 'estimate_fare',
  description:
    'Estimate the fare in LKR for a transfer from Bandaranaike International Airport (CMB). ' +
    'Needs a vehicle type and either a destination name or a distance in km.',
  inputSchema: z.object({
    vehicleType: z.enum(VEHICLE_TYPES).describe('mini, sedan or van'),
    destination: z.string().optional().describe('Destination town, e.g. "Kandy"'),
    distanceKm: z.number().optional().describe('Road distance in km, if the destination is not known'),
    pickupHour: z.number().int().min(0).max(23).optional().describe('Pickup hour in local time, 0-23'),
  }),
  callback: (args) => JSON.stringify(estimateFare(args)),
});

const flightStatusTool = tool({
  name: 'get_flight_status',
  description: 'Look up the arrival status of a flight landing at CMB, e.g. "FA101".',
  inputSchema: z.object({
    flightNumber: z.string().describe('Flight number, e.g. "FA 245"'),
  }),
  callback: (args) => JSON.stringify(getFlightStatus(args)),
});

// ============================================================
// Build the agent
// ============================================================

const SYSTEM_PROMPT = `You are the virtual assistant for Palmway Transfers, a fictional airport transfer company in Sri Lanka.
You help travellers book and plan rides from Bandaranaike International Airport (CMB).

How to answer:
- For policy questions (booking, waiting time, cancellations, luggage, child seats, payments, safety, contact), call the retrieve tool first and answer only from what it returns.
- Use estimate_fare for prices and get_flight_status for flights. Never guess a price or a flight time.
- When you use a policy, cite it as (Source: <file name>) using only file names that the retrieve tool returned in this conversation. Never invent a source. If no tool returned a source, do not cite one.
- If the tools do not have the answer, say you do not know and suggest contacting support.
- Be friendly and keep answers short. Travellers are often tired after a long flight.`;

function createAgent(): Agent {
  const model = new BedrockModel({
    region: REGION,
    modelId: MODEL_ID,
    temperature: 0.2,
    maxTokens: 1000,
    guardrailConfig: { guardrailIdentifier: guardrailId, guardrailVersion },
  });

  return new Agent({
    model,
    tools: [retrieve, estimateFareTool, flightStatusTool],
    systemPrompt: SYSTEM_PROMPT,
    printer: false, // we print the final answer ourselves
  });
}

// ============================================================
// Run the agent
// ============================================================

async function main(): Promise<void> {
  console.log('Palmway Transfers assistant (Strands)');
  console.log('='.repeat(50));
  console.log('Ask about bookings, fares, flights, waiting time, luggage and more.');
  console.log('Type "quit" to exit.\n');

  const agent = createAgent();
  const rl = readline.createInterface({ input, output });

  let closed = false;
  rl.on('close', () => {
    closed = true;
  });

  rl.setPrompt('You: ');
  rl.prompt();

  for await (const line of rl) {
    const userText = line.trim();
    if (!input.isTTY && userText) console.log(userText); // echo piped lines
    if (['quit', 'exit', 'q'].includes(userText.toLowerCase())) {
      console.log('Goodbye!');
      break;
    }

    if (userText) {
      try {
        const result = await agent.invoke(userText);
        console.log(`\nAssistant: ${stripThinking(String(result))}\n`);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : err);
      }
    }
    if (!closed) rl.prompt();
  }

  rl.close();
}

main().catch((err) => {
  console.error('Agent failed:', err);
  process.exit(1);
});
