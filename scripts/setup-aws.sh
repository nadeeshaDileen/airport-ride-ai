#!/usr/bin/env bash
# Create the AWS resources that steps 04-07 need:
#   1. S3 bucket with the documents from knowledge-base-docs/
#   2. S3 Vectors bucket + index (1024 dimensions, cosine) for Titan Text Embeddings V2
#   3. IAM role for the knowledge base (least privilege)
#   4. Bedrock knowledge base + S3 data source, then a sync (ingestion job)
#   5. Bedrock guardrail with taxi-specific denied topics, plus a published version
#
# Everything is named from NAME_PREFIX, so cleanup-aws.sh can find and delete it.
# These resources cost money while they exist (small amounts for this demo). See README.
#
# Usage:
#   AWS_PROFILE=<your-aws-profile> NAME_PREFIX=palmway-ai AWS_REGION=us-east-1 ./scripts/setup-aws.sh
#
# Output: prints the IDs and writes them to .aws-resources.env (git-ignored).

set -euo pipefail
export AWS_PAGER=""

# ---------- Settings ----------

if [[ -z "${AWS_PROFILE:-}" || "${AWS_PROFILE}" == "default" ]]; then
  echo "Set AWS_PROFILE to a named profile (not \"default\")." >&2
  exit 1
fi

REGION="${AWS_REGION:-us-east-1}"
PREFIX="${NAME_PREFIX:-palmway-ai}"

if [[ ! "$PREFIX" =~ ^[a-z0-9][a-z0-9-]{1,19}$ ]]; then
  echo "NAME_PREFIX must be 2-20 characters: lowercase letters, numbers and hyphens." >&2
  exit 1
fi

A=(--profile "$AWS_PROFILE" --region "$REGION")
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCS_DIR="$SCRIPT_DIR/../knowledge-base-docs"
OUT_FILE="$SCRIPT_DIR/../.aws-resources.env"

ACCOUNT_ID="$(aws sts get-caller-identity "${A[@]}" --query Account --output text)"

DOCS_BUCKET="${PREFIX}-kb-docs-${ACCOUNT_ID}-${REGION}"
VECTOR_BUCKET="${PREFIX}-kb-vectors-${ACCOUNT_ID}"
INDEX_NAME="${PREFIX}-index"
ROLE_NAME="${PREFIX}-kb-role"
POLICY_NAME="kb-access"
KB_NAME="${PREFIX}-kb"
DS_NAME="${PREFIX}-docs"
GUARDRAIL_NAME="${PREFIX}-guardrail"

EMBED_MODEL_ARN="arn:aws:bedrock:${REGION}::foundation-model/amazon.titan-embed-text-v2:0"
VECTOR_BUCKET_ARN="arn:aws:s3vectors:${REGION}:${ACCOUNT_ID}:bucket/${VECTOR_BUCKET}"
INDEX_ARN="${VECTOR_BUCKET_ARN}/index/${INDEX_NAME}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "This will create Bedrock knowledge base and guardrail resources:"
echo "  Account:        $ACCOUNT_ID"
echo "  Region:         $REGION"
echo "  Docs bucket:    $DOCS_BUCKET"
echo "  Vector bucket:  $VECTOR_BUCKET (index $INDEX_NAME)"
echo "  IAM role:       $ROLE_NAME"
echo "  Knowledge base: $KB_NAME"
echo "  Guardrail:      $GUARDRAIL_NAME"
read -r -p "Type yes to continue: " answer
[[ "$answer" == "yes" ]] || { echo "Cancelled."; exit 1; }

# ---------- 1. S3 bucket for documents ----------

echo "==> Docs bucket"
if aws s3api head-bucket --bucket "$DOCS_BUCKET" "${A[@]}" 2>/dev/null; then
  echo "    exists"
else
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$DOCS_BUCKET" "${A[@]}" >/dev/null
  else
    aws s3api create-bucket --bucket "$DOCS_BUCKET" "${A[@]}" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "$DOCS_BUCKET" "${A[@]}" \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  echo "    created"
fi
aws s3 sync "$DOCS_DIR" "s3://$DOCS_BUCKET/" "${A[@]}" --exclude "*" --include "*.txt" --delete

# ---------- 2. S3 Vectors bucket and index ----------

echo "==> Vector bucket and index"
if aws s3vectors get-vector-bucket --vector-bucket-name "$VECTOR_BUCKET" "${A[@]}" >/dev/null 2>&1; then
  echo "    vector bucket exists"
else
  aws s3vectors create-vector-bucket --vector-bucket-name "$VECTOR_BUCKET" "${A[@]}" >/dev/null
  echo "    vector bucket created"
fi

if aws s3vectors get-index --vector-bucket-name "$VECTOR_BUCKET" --index-name "$INDEX_NAME" "${A[@]}" >/dev/null 2>&1; then
  echo "    index exists"
else
  # Bedrock stores the chunk text in AMAZON_BEDROCK_TEXT. Marking it non-filterable
  # avoids the size limit on filterable metadata.
  aws s3vectors create-index "${A[@]}" \
    --vector-bucket-name "$VECTOR_BUCKET" \
    --index-name "$INDEX_NAME" \
    --data-type float32 \
    --dimension 1024 \
    --distance-metric cosine \
    --metadata-configuration '{"nonFilterableMetadataKeys":["AMAZON_BEDROCK_TEXT","AMAZON_BEDROCK_METADATA"]}' >/dev/null
  echo "    index created"
fi

# ---------- 3. IAM role for the knowledge base ----------

echo "==> IAM role"
cat >"$TMP_DIR/trust.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "bedrock.amazonaws.com" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "${ACCOUNT_ID}" },
        "ArnLike": { "aws:SourceArn": "arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:knowledge-base/*" }
      }
    }
  ]
}
EOF

cat >"$TMP_DIR/policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Embeddings",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "${EMBED_MODEL_ARN}"
    },
    {
      "Sid": "ListDocs",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::${DOCS_BUCKET}",
      "Condition": { "StringEquals": { "aws:ResourceAccount": "${ACCOUNT_ID}" } }
    },
    {
      "Sid": "ReadDocs",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${DOCS_BUCKET}/*",
      "Condition": { "StringEquals": { "aws:ResourceAccount": "${ACCOUNT_ID}" } }
    },
    {
      "Sid": "Vectors",
      "Effect": "Allow",
      "Action": [
        "s3vectors:GetIndex",
        "s3vectors:PutVectors",
        "s3vectors:GetVectors",
        "s3vectors:DeleteVectors",
        "s3vectors:QueryVectors"
      ],
      "Resource": "${INDEX_ARN}"
    }
  ]
}
EOF

if aws iam get-role --role-name "$ROLE_NAME" --profile "$AWS_PROFILE" >/dev/null 2>&1; then
  echo "    role exists"
else
  aws iam create-role --role-name "$ROLE_NAME" --profile "$AWS_PROFILE" \
    --assume-role-policy-document "file://$TMP_DIR/trust.json" >/dev/null
  echo "    role created (waiting 15s for IAM to propagate)"
  sleep 15
fi
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" --profile "$AWS_PROFILE" \
  --policy-document "file://$TMP_DIR/policy.json"
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --profile "$AWS_PROFILE" --query Role.Arn --output text)"

# ---------- 4. Knowledge base, data source, sync ----------

echo "==> Knowledge base"
KB_ID="$(aws bedrock-agent list-knowledge-bases "${A[@]}" \
  --query "knowledgeBaseSummaries[?name=='${KB_NAME}'].knowledgeBaseId | [0]" --output text)"

if [[ "$KB_ID" == "None" || -z "$KB_ID" ]]; then
  KB_CONFIG="{\"type\":\"VECTOR\",\"vectorKnowledgeBaseConfiguration\":{\"embeddingModelArn\":\"${EMBED_MODEL_ARN}\",\"embeddingModelConfiguration\":{\"bedrockEmbeddingModelConfiguration\":{\"dimensions\":1024}}}}"
  STORAGE_CONFIG="{\"type\":\"S3_VECTORS\",\"s3VectorsConfiguration\":{\"indexArn\":\"${INDEX_ARN}\"}}"

  # A new IAM role can take a little longer to be usable, so retry a few times.
  for attempt in 1 2 3 4 5; do
    if KB_ID="$(aws bedrock-agent create-knowledge-base "${A[@]}" \
      --name "$KB_NAME" \
      --description "Palmway Transfers FAQ and policies (tutorial)" \
      --role-arn "$ROLE_ARN" \
      --knowledge-base-configuration "$KB_CONFIG" \
      --storage-configuration "$STORAGE_CONFIG" \
      --query knowledgeBase.knowledgeBaseId --output text)"; then
      break
    fi
    [[ $attempt -eq 5 ]] && { echo "Could not create the knowledge base." >&2; exit 1; }
    echo "    retrying in 10s ($attempt/5)"
    sleep 10
  done
  echo "    created $KB_ID"
else
  echo "    exists $KB_ID"
fi

until [[ "$(aws bedrock-agent get-knowledge-base --knowledge-base-id "$KB_ID" "${A[@]}" \
  --query knowledgeBase.status --output text)" == "ACTIVE" ]]; do
  echo "    waiting for ACTIVE..."
  sleep 5
done

echo "==> Data source"
DS_ID="$(aws bedrock-agent list-data-sources --knowledge-base-id "$KB_ID" "${A[@]}" \
  --query "dataSourceSummaries[?name=='${DS_NAME}'].dataSourceId | [0]" --output text)"
if [[ "$DS_ID" == "None" || -z "$DS_ID" ]]; then
  DS_ID="$(aws bedrock-agent create-data-source --knowledge-base-id "$KB_ID" "${A[@]}" \
    --name "$DS_NAME" \
    --data-source-configuration "{\"type\":\"S3\",\"s3Configuration\":{\"bucketArn\":\"arn:aws:s3:::${DOCS_BUCKET}\"}}" \
    --query dataSource.dataSourceId --output text)"
  echo "    created $DS_ID"
else
  echo "    exists $DS_ID"
fi

echo "==> Sync (ingestion job)"
JOB_ID="$(aws bedrock-agent start-ingestion-job --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" "${A[@]}" \
  --query ingestionJob.ingestionJobId --output text)"
while true; do
  STATUS="$(aws bedrock-agent get-ingestion-job --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" \
    --ingestion-job-id "$JOB_ID" "${A[@]}" --query ingestionJob.status --output text)"
  echo "    $STATUS"
  [[ "$STATUS" == "COMPLETE" ]] && break
  [[ "$STATUS" == "FAILED" || "$STATUS" == "STOPPED" ]] && {
    aws bedrock-agent get-ingestion-job --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" \
      --ingestion-job-id "$JOB_ID" "${A[@]}" --query ingestionJob.failureReasons
    exit 1
  }
  sleep 5
done

# ---------- 5. Guardrail ----------

echo "==> Guardrail"
cat >"$TMP_DIR/guardrail.json" <<EOF
{
  "name": "${GUARDRAIL_NAME}",
  "description": "Palmway Transfers assistant guardrail (tutorial)",
  "blockedInputMessaging": "Sorry, I can't help with that. I can help you book a ride, check a fare, or answer questions about our service.",
  "blockedOutputsMessaging": "Sorry, I can't help with that. I can help you book a ride, check a fare, or answer questions about our service.",
  "topicPolicyConfig": {
    "topicsConfig": [
      {
        "name": "Payment evasion",
        "definition": "Requests for help avoiding payment for a ride, paying with someone else's card, or getting money back by lying to the driver or the company.",
        "examples": [
          "How can I leave the taxi without paying the driver?",
          "Can I book with a card that is not mine?",
          "How do I get a refund for a ride I actually took?"
        ],
        "type": "DENY"
      },
      {
        "name": "Fake bookings",
        "definition": "Requests to create false, prank or fraudulent bookings, book with fake names or flight details, or tie up drivers with rides the person will not take.",
        "examples": [
          "Book ten fake pickups to keep the drivers busy.",
          "Make a booking under a fake name so it cannot be traced to me."
        ],
        "type": "DENY"
      },
      {
        "name": "Harassing drivers",
        "definition": "Requests to harass, threaten, stalk or take revenge on a driver or passenger, or to find a driver's home address or other private details.",
        "examples": [
          "Give me my driver's home address so I can find him.",
          "How can I scare the driver who was late?"
        ],
        "type": "DENY"
      }
    ]
  },
  "contentPolicyConfig": {
    "filtersConfig": [
      { "type": "HATE", "inputStrength": "HIGH", "outputStrength": "HIGH" },
      { "type": "INSULTS", "inputStrength": "HIGH", "outputStrength": "HIGH" },
      { "type": "SEXUAL", "inputStrength": "HIGH", "outputStrength": "HIGH" },
      { "type": "VIOLENCE", "inputStrength": "HIGH", "outputStrength": "HIGH" },
      { "type": "MISCONDUCT", "inputStrength": "HIGH", "outputStrength": "HIGH" },
      { "type": "PROMPT_ATTACK", "inputStrength": "HIGH", "outputStrength": "NONE" }
    ]
  }
}
EOF

GUARDRAIL_ID="$(aws bedrock list-guardrails "${A[@]}" \
  --query "guardrails[?name=='${GUARDRAIL_NAME}'].id | [0]" --output text)"
if [[ "$GUARDRAIL_ID" == "None" || -z "$GUARDRAIL_ID" ]]; then
  GUARDRAIL_ID="$(aws bedrock create-guardrail "${A[@]}" --cli-input-json "file://$TMP_DIR/guardrail.json" \
    --query guardrailId --output text)"
  echo "    created $GUARDRAIL_ID"
else
  echo "    exists $GUARDRAIL_ID"
fi

GUARDRAIL_VERSION="$(aws bedrock list-guardrails --guardrail-identifier "$GUARDRAIL_ID" "${A[@]}" \
  --query "guardrails[?version!='DRAFT'].version | [-1]" --output text)"
if [[ "$GUARDRAIL_VERSION" == "None" || -z "$GUARDRAIL_VERSION" ]]; then
  GUARDRAIL_VERSION="$(aws bedrock create-guardrail-version --guardrail-identifier "$GUARDRAIL_ID" "${A[@]}" \
    --description "v1" --query version --output text)"
  echo "    published version $GUARDRAIL_VERSION"
fi

# ---------- Done ----------

cat >"$OUT_FILE" <<EOF
KNOWLEDGE_BASE_ID=${KB_ID}
GUARDRAIL_ID=${GUARDRAIL_ID}
GUARDRAIL_VERSION=${GUARDRAIL_VERSION}
EOF

echo
echo "Done. Values saved to .aws-resources.env (git-ignored). Load them with:"
echo "  set -a; source .aws-resources.env; set +a"
cat "$OUT_FILE"
