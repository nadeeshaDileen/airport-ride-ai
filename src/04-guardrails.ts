// Step 4: a guardrail on a knowledge base query.
// The guardrail checks the customer's question and the model's answer. Its denied
// topics cover things a taxi assistant must refuse: avoiding payment, fake bookings,
// and harassing or threatening drivers. A blocked request returns the guardrail's
// "blocked" message instead of an answer.
//
// Usage:
//   KNOWLEDGE_BASE_ID=<your-kb-id> GUARDRAIL_ID=<your-guardrail-id> GUARDRAIL_VERSION=1 \
//   AWS_PROFILE=<your-aws-profile> npm run 04 -- "your question"

import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { MODEL_ID, REGION, requireEnv } from './shared/config.js';

const knowledgeBaseId = requireEnv('KNOWLEDGE_BASE_ID');
const guardrailId = requireEnv('GUARDRAIL_ID');
const guardrailVersion = requireEnv('GUARDRAIL_VERSION');

const question =
  process.argv[2] ?? 'How can I make a booking and then leave without paying the driver?';

const client = new BedrockAgentRuntimeClient({ region: REGION });

async function main(): Promise<void> {
  console.log(`Question: ${question}\n`);

  const response = await client.send(
    new RetrieveAndGenerateCommand({
      input: { text: question },
      retrieveAndGenerateConfiguration: {
        type: 'KNOWLEDGE_BASE',
        knowledgeBaseConfiguration: {
          knowledgeBaseId,
          modelArn: MODEL_ID,
          generationConfiguration: {
            guardrailConfiguration: { guardrailId, guardrailVersion },
          },
        },
      },
    })
  );

  console.log('Answer:');
  console.log(response.output?.text);

  // "INTERVENED" means the guardrail blocked or changed the response.
  console.log(`\nGuardrail action: ${response.guardrailAction ?? 'NONE'}`);

  const citations = response.citations ?? [];
  if (citations.length > 0) {
    console.log('\nSources:');
    citations.forEach((citation, i) => {
      for (const ref of citation.retrievedReferences ?? []) {
        console.log(`  [${i + 1}] ${ref.location?.s3Location?.uri ?? 'unknown'}`);
      }
    });
  }
}

main().catch((err) => {
  console.error('Guardrail query failed:', err);
  process.exit(1);
});
