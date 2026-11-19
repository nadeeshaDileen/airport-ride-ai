// Step 5: answer from the company's own documents (RAG) with RetrieveAndGenerate.
// Bedrock searches the knowledge base built from knowledge-base-docs/, passes the best
// chunks to the model, and returns an answer plus citations to the source files.
//
// Usage:
//   KNOWLEDGE_BASE_ID=<your-kb-id> AWS_PROFILE=<your-aws-profile> npm run 05 -- "your question"

import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { MODEL_ID, REGION, requireEnv } from './shared/config.js';

const knowledgeBaseId = requireEnv('KNOWLEDGE_BASE_ID');

const question =
  process.argv[2] ?? 'My flight is two hours late. Will the driver still wait, and do I pay extra?';

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
          retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 4 } },
        },
      },
    })
  );

  console.log('Answer:');
  console.log(response.output?.text);

  // Each citation links a part of the answer to the chunks it came from.
  const citations = response.citations ?? [];
  if (citations.length === 0) {
    console.log('\n(No citations returned.)');
    return;
  }

  console.log('\nSources:');
  citations.forEach((citation, i) => {
    const part = citation.generatedResponsePart?.textResponsePart?.text ?? '';
    console.log(`  [${i + 1}] "${part.slice(0, 80)}${part.length > 80 ? '...' : ''}"`);
    for (const ref of citation.retrievedReferences ?? []) {
      console.log(`       from ${ref.location?.s3Location?.uri ?? 'unknown'}`);
    }
  });
}

main().catch((err) => {
  console.error('Knowledge base query failed:', err);
  process.exit(1);
});
