# airport-ride-ai

Learn Amazon Bedrock with Node.js and TypeScript, one small script at a time, by building an AI assistant for **Palmway Transfers**, a fictional airport transfer company in Sri Lanka.

Blog series: [Building an AI assistant for an airport taxi company with Amazon Bedrock](<blog-series-link>) (link coming soon).

## The story

Palmway Transfers picks travellers up at Bandaranaike International Airport (CMB) and drives them to hotels across Sri Lanka. Customers book online, choose a Mini car, Sedan or Van, and then send the same questions again and again:

- "Will the driver wait if my flight is late?"
- "How much is it to Kandy for four people?"
- "Do you have child seats?"
- "What happens if I cancel?"

Each step in this repo adds one Bedrock feature to an assistant that answers these questions. By step 7 it remembers the conversation, calls tools for fares and flight status, answers from the company's own policy documents, and refuses abusive or fraudulent requests.

The company, its prices, its flights (airline code `FA`) and its contact details are all made up.

## Steps

| Step | Script | Bedrock feature | What the assistant learns |
|---|---|---|---|
| 01 | [`src/01-converse.ts`](src/01-converse.ts) | Converse API, system prompt, token usage | Answer one customer question |
| 02 | [`src/02-multi-turn.ts`](src/02-multi-turn.ts) | Conversation history | Take a booking over several messages |
| 03 | [`src/03-tool-use.ts`](src/03-tool-use.ts) | Tool use with a turn limit | Look up fares and flight arrival status |
| 04 | [`src/04-guardrails.ts`](src/04-guardrails.ts) | Guardrails on a knowledge base query | Refuse payment evasion, fake bookings, driver harassment |
| 05 | [`src/05-knowledge-base.ts`](src/05-knowledge-base.ts) | Knowledge Bases, RetrieveAndGenerate, citations | Answer from company policy documents |
| 06 | [`src/06-chatbot.ts`](src/06-chatbot.ts) | All of the above, hand-written loop | Full CLI chatbot |
| 07 | [`src/07-strands-agent.ts`](src/07-strands-agent.ts) | Strands Agents SDK | The same chatbot with the agent loop done for you |

Shared code lives in [`src/shared/`](src/shared/): settings (`config.ts`), mock fare and flight data (`taxi-tools.ts`), and the tool descriptions for the Converse API (`converse-tools.ts`). Steps 01 and 02 are fully self-contained so you can read them top to bottom.

## Prerequisites

- Node.js 20 or later (tested with Node.js 24)
- An AWS account and the AWS CLI v2
- A named AWS CLI profile with permission to call Bedrock in `us-east-1`
- Access to **Amazon Nova Lite** (`us.amazon.nova-lite-v1:0`) in `us-east-1`. Steps 04-07 also use **Titan Text Embeddings V2**. Check the Bedrock console's model access page if a call returns `AccessDeniedException`.

## Setup

```zsh
git clone <your-repo-url> airport-ride-ai
cd airport-ride-ai
npm install
aws sso login --profile <your-aws-profile>   # or however you sign in to your profile
```

Every command below passes the profile with `AWS_PROFILE=<your-aws-profile>`. Use a named profile, not `default`.

Copy `.env.example` to `.env` if you want to keep your values in one place (`.env` is git-ignored). The scripts read plain environment variables, so load it with `set -a; source .env; set +a`.

## Run steps 01-03 (no extra AWS resources)

```zsh
AWS_PROFILE=<your-aws-profile> npm run 01
AWS_PROFILE=<your-aws-profile> npm run 01 -- "Do you pick up from the airport at 3am?"
AWS_PROFILE=<your-aws-profile> npm run 02
AWS_PROFILE=<your-aws-profile> npm run 03
AWS_PROFILE=<your-aws-profile> npm run 03 -- "Is FA318 on time, and how much is a sedan to Negombo?"
```

### Sample output

Real output from Nova Lite. Your text will differ a little on every run.

Step 01:

```text
Customer: We are a family of four with three large suitcases, landing at 11pm. Which vehicle should we book, and what happens if our flight is late?
Assistant: Hi there! For a family of four with three large suitcases, I recommend booking our Van, which can accommodate up to 8 passengers and 8 suitcases. If your flight is delayed, our driver will track it and wait up to 60 minutes after the landing time at no extra cost. Safe travels!

Tokens: { inputTokens: 188, outputTokens: 66, totalTokens: 254 }
Stop reason: end_turn
Latency (ms): 952
```

Step 02 (input tokens grow because the whole history is sent each time):

```text
--- Turn 1 ---
Customer: Hi, I need a pickup from the airport to Kandy. I land on flight FA101 on 14 March at 8:40 in the morning.
Assistant: Thank you! We'll arrange a suitable vehicle for your 3 passengers and 2 suitcases. The team will send the price and confirmation by email shortly.
(input tokens: 179, output tokens: 34)
...
--- Turn 4 ---
Customer: Great, please summarise the whole booking (flight, date, destination, people, luggage, extras) so I can check it.
Assistant: Your booking: Flight FA101, 14 March, Kandy, 3 passengers, 3 suitcases, 1 child seat. The team will send the price and confirmation by email.
(input tokens: 353, output tokens: 42)
```

Look closely: in turn 1 the model guessed "3 passengers and 2 suitcases" before the customer said so, and the final summary says 3 suitcases instead of 2. Memory works (the flight, date and child seat carried over), but a small model can still get details wrong. Real booking systems should collect fields in a form or with a tool, and use the model for the conversation around it.

Step 03:

```text
Customer: My flight FA245 lands today. How much is a van from the airport to Galle, and is my flight on time?

[Call 1] stopReason: tool_use, tokens: 773
  Model wants: get_flight_status({"flightNumber":"FA 245"})
  Tool returned: {"flightNumber":"FA245","from":"Singapore","scheduled":"13:15","status":"Delayed","estimated":"13:55","timezone":"local airport time"}
  Model wants: estimate_fare({"destination":"Galle","vehicleType":"van"})
  Tool returned: {"vehicle":"Van","maxPassengers":8,"maxSuitcases":8,"distanceKm":150,"nightSurchargeApplied":false,"estimatedFareLkr":30000,"note":"Estimate only. The final price is confirmed at booking."}
[Call 2] stopReason: end_turn, tokens: 998

Assistant: Your flight FA245 is currently delayed and estimated to land at 13:55 local time. The estimated fare for a van from the airport to Galle is LKR 30,000. Please note that this is an estimate and the final price is confirmed at booking.
```

## Create the knowledge base and guardrail (steps 04-07)

Steps 04-07 need a Bedrock knowledge base built from [`knowledge-base-docs/`](knowledge-base-docs/) and a guardrail. [`scripts/setup-aws.sh`](scripts/setup-aws.sh) creates them:

- an S3 bucket holding the documents
- an S3 Vectors bucket and index (1024 dimensions, cosine distance) for Titan Text Embeddings V2
- an IAM role that the knowledge base uses, allowed only to read that bucket, use that index, and call the embedding model
- the knowledge base, an S3 data source, and a first sync
- a guardrail with denied topics (payment evasion, fake bookings, harassing drivers) and content filters, plus a published version

Read the script before you run it. It shows what it will create and asks you to type `yes`.

```zsh
AWS_PROFILE=<your-aws-profile> NAME_PREFIX=palmway-ai AWS_REGION=us-east-1 ./scripts/setup-aws.sh
set -a; source .aws-resources.env; set +a   # loads KNOWLEDGE_BASE_ID, GUARDRAIL_ID, GUARDRAIL_VERSION
```

If you change a document in `knowledge-base-docs/`, run the setup script again. It reuses existing resources, uploads the files, and starts a new sync.

## Run steps 04-07

All four read `KNOWLEDGE_BASE_ID`, `GUARDRAIL_ID` and `GUARDRAIL_VERSION` from the environment (step 05 needs only `KNOWLEDGE_BASE_ID`) and stop with a clear message if one is missing.

```zsh
# 04: a denied topic is blocked by the guardrail
AWS_PROFILE=<your-aws-profile> npm run 04
AWS_PROFILE=<your-aws-profile> npm run 04 -- "Can I cancel for free the day before?"

# 05: answer from the documents, with citations
AWS_PROFILE=<your-aws-profile> npm run 05
AWS_PROFILE=<your-aws-profile> npm run 05 -- "Do you provide booster seats?"

# 06: interactive chatbot (type "exit" to quit)
AWS_PROFILE=<your-aws-profile> npm run 06

# 06 also works with piped input
printf 'How long will the driver wait?\nHow much is a sedan to Colombo at 11pm?\nexit\n' | AWS_PROFILE=<your-aws-profile> npm run 06

# 07: the same assistant with the Strands Agents SDK (type "quit" to quit)
AWS_PROFILE=<your-aws-profile> npm run 07
```

## Type-check

```zsh
npm run build   # tsc --noEmit
```

## Cost notes

Prices change, so check the [Amazon Bedrock pricing page](https://aws.amazon.com/bedrock/pricing/) for current numbers.

- **Steps 01-03** only call Nova Lite. Each run uses a few hundred to about 1,500 tokens, which costs a small fraction of a cent.
- **Steps 04-07** also pay for embeddings (Titan Text Embeddings V2, very small for 10 short documents), guardrail text units on every checked call, and S3 Vectors and S3 storage while the resources exist.
- An S3 Vectors index has no hourly charge, unlike some other vector stores. You pay for storage and queries. Still, delete the resources when you finish.

## Cleanup

```zsh
AWS_PROFILE=<your-aws-profile> NAME_PREFIX=palmway-ai AWS_REGION=us-east-1 ./scripts/cleanup-aws.sh
```

It finds everything by `NAME_PREFIX`, asks you to type the prefix to confirm, and deletes the data source, knowledge base, vector index and bucket, docs bucket, IAM role and guardrail, in that order.

## Project layout

```text
src/                  one script per step, plus src/shared/
knowledge-base-docs/  fictional FAQ and policy documents for the knowledge base
scripts/              setup-aws.sh and cleanup-aws.sh
```

## License

No license has been chosen yet.
