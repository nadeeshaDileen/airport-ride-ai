// Step 6: a CLI chatbot for Palmway Transfers that combines the earlier steps.
//   - memory (step 2): the `history` array is sent on every call
//   - tools (step 3): estimate_fare and get_flight_status
//   - knowledge base (step 5): the search_company_docs tool calls the Retrieve API
//   - guardrail (step 4): guardrailConfig on every Converse call
//
// Usage:
//   KNOWLEDGE_BASE_ID=<your-kb-id> GUARDRAIL_ID=<your-guardrail-id> GUARDRAIL_VERSION=1 \
//   AWS_PROFILE=<your-aws-profile> npm run 06
// Type "exit" to quit. Piped input also works:
//   printf 'Do you have child seats?\nexit\n' | npm run 06

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ContentBlock,
  Message,
  ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { MODEL_ID, REGION, requireEnv, stripThinking } from './shared/config.js';
import { TAXI_TOOLS, runTaxiTool } from './shared/converse-tools.js';

const MAX_TOOL_TURNS = 5;

const knowledgeBaseId = requireEnv('KNOWLEDGE_BASE_ID');
const guardrailId = requireEnv('GUARDRAIL_ID');
const guardrailVersion = requireEnv('GUARDRAIL_VERSION');

const runtime = new BedrockRuntimeClient({ region: REGION });
const agentRuntime = new BedrockAgentRuntimeClient({ region: REGION });

const SYSTEM = [
  {
    text:
      'You are the customer assistant for Palmway Transfers, a fictional airport transfer company in Sri Lanka. ' +
      'For questions about policies (booking, waiting time, cancellations, luggage, child seats, payments, safety, contact), ' +
      'call search_company_docs first and answer ONLY from its results. ' +
      'Use estimate_fare for prices and get_flight_status for flights. Never guess prices or flight times. ' +
      'If the tools do not give the answer, say you do not know and suggest contacting support. ' +
      'Keep answers short. Never show your reasoning or tool calls to the customer.',
  },
];

// ---------- Knowledge base search tool ----------

async function searchCompanyDocs({ query }: { query: string }) {
  const res = await agentRuntime.send(
    new RetrieveCommand({
      knowledgeBaseId,
      retrievalQuery: { text: query },
      retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 3 } },
    })
  );
  return {
    results: (res.retrievalResults ?? []).map((r) => ({
      text: r.content?.text ?? '',
      source: r.location?.s3Location?.uri ?? 'unknown',
    })),
  };
}

const toolConfig: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: 'search_company_docs',
        description:
          'Search the Palmway Transfers policy and FAQ documents (booking, pricing rules, airport pickup, ' +
          'waiting time, cancellations, luggage, child seats, payments, safety, contact).',
        inputSchema: {
          json: {
            type: 'object',
            properties: { query: { type: 'string', description: 'What to search for' } },
            required: ['query'],
          },
        },
      },
    },
    ...TAXI_TOOLS,
  ],
};

async function runTool(name: string, toolInput: unknown): Promise<Record<string, unknown>> {
  if (name === 'search_company_docs') return searchCompanyDocs(toolInput as { query: string });
  return runTaxiTool(name, toolInput);
}

// ---------- One chat turn ----------

function textOf(message: Message): string {
  return stripThinking(message.content?.map((b) => b.text ?? '').join('') ?? '');
}

async function chatTurn(history: Message[], userText: string): Promise<string> {
  history.push({ role: 'user', content: [{ text: userText }] });

  for (let i = 0; i < MAX_TOOL_TURNS; i++) {
    const response = await runtime.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: SYSTEM,
        messages: history,
        toolConfig,
        guardrailConfig: { guardrailIdentifier: guardrailId, guardrailVersion },
        inferenceConfig: { temperature: 0, maxTokens: 500 },
      })
    );

    const reply = response.output?.message;
    if (!reply) throw new Error('No message in response');
    history.push(reply);

    // The guardrail blocked the question or the answer: show its message.
    if (response.stopReason === 'guardrail_intervened') return textOf(reply);

    // Final answer.
    if (response.stopReason !== 'tool_use') return textOf(reply);

    // The model asked for tools: run them and send the results back.
    const results: ContentBlock[] = [];
    for (const block of reply.content ?? []) {
      if (!block.toolUse) continue;
      const { name, input: toolInput, toolUseId } = block.toolUse;
      console.log(`  [tool] ${name}(${JSON.stringify(toolInput)})`);
      const result = await runTool(name ?? '', toolInput);
      results.push({ toolResult: { toolUseId, content: [{ json: result as never }] } });
    }
    history.push({ role: 'user', content: results });
  }

  return 'Sorry, I got stuck. Please try again.';
}

// ---------- CLI loop ----------

async function main(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const history: Message[] = [];

  console.log('Palmway Transfers assistant. Type "exit" to quit.\n');

  // With piped input, stdin can close while a request is still running.
  // Track it so we never call prompt() on a closed interface.
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });

  rl.setPrompt('You: ');
  rl.prompt();

  // Iterating over lines works for both a terminal and piped input.
  for await (const line of rl) {
    const userText = line.trim();
    if (!input.isTTY && userText) console.log(userText); // echo piped lines
    if (userText.toLowerCase() === 'exit') break;

    if (userText) {
      try {
        const answer = await chatTurn(history, userText);
        console.log(`Assistant: ${answer}\n`);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : err);
      }
    }
    if (!closed) rl.prompt();
  }

  rl.close();
}

main().catch((err) => {
  console.error('Chatbot failed:', err);
  process.exit(1);
});
