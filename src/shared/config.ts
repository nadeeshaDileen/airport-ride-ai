// Settings shared by every step.

export const REGION = 'us-east-1';
export const MODEL_ID = 'us.amazon.nova-lite-v1:0';
export const COMPANY = 'Palmway Transfers';

// Read a required environment variable or stop with a clear message.
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      `Missing environment variable ${name}.\n` +
        'Steps 04-07 need a knowledge base and a guardrail. Create them with ' +
        'scripts/setup-aws.sh (see README), then set KNOWLEDGE_BASE_ID, GUARDRAIL_ID ' +
        'and GUARDRAIL_VERSION.'
    );
    process.exit(1);
  }
  return value;
}

// Nova Lite sometimes wraps its reasoning in <thinking> tags. Hide it from users.
export function stripThinking(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
}
