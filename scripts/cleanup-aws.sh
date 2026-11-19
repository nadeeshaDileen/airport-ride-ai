#!/usr/bin/env bash
# Delete everything scripts/setup-aws.sh created, found by NAME_PREFIX.
# Order matters: data source -> knowledge base -> vector index -> vector bucket
# -> docs bucket -> IAM role -> guardrail. Missing resources are skipped.
#
# Usage:
#   AWS_PROFILE=<your-aws-profile> NAME_PREFIX=palmway-ai AWS_REGION=us-east-1 ./scripts/cleanup-aws.sh

set -euo pipefail
export AWS_PAGER=""

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

ACCOUNT_ID="$(aws sts get-caller-identity "${A[@]}" --query Account --output text)"

DOCS_BUCKET="${PREFIX}-kb-docs-${ACCOUNT_ID}-${REGION}"
VECTOR_BUCKET="${PREFIX}-kb-vectors-${ACCOUNT_ID}"
INDEX_NAME="${PREFIX}-index"
ROLE_NAME="${PREFIX}-kb-role"
POLICY_NAME="kb-access"
KB_NAME="${PREFIX}-kb"
GUARDRAIL_NAME="${PREFIX}-guardrail"

echo "This will DELETE these resources in account $ACCOUNT_ID ($REGION):"
echo "  Knowledge base $KB_NAME (and its data sources)"
echo "  Vector bucket $VECTOR_BUCKET and index $INDEX_NAME"
echo "  Docs bucket $DOCS_BUCKET (and all files in it)"
echo "  IAM role $ROLE_NAME"
echo "  Guardrail $GUARDRAIL_NAME"
read -r -p "Type the prefix ($PREFIX) to confirm: " answer
[[ "$answer" == "$PREFIX" ]] || { echo "Cancelled."; exit 1; }

echo "==> Knowledge base"
KB_ID="$(aws bedrock-agent list-knowledge-bases "${A[@]}" \
  --query "knowledgeBaseSummaries[?name=='${KB_NAME}'].knowledgeBaseId | [0]" --output text)"
if [[ "$KB_ID" != "None" && -n "$KB_ID" ]]; then
  for DS_ID in $(aws bedrock-agent list-data-sources --knowledge-base-id "$KB_ID" "${A[@]}" \
    --query "dataSourceSummaries[].dataSourceId" --output text); do
    aws bedrock-agent delete-data-source --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" "${A[@]}" >/dev/null
    echo "    deleted data source $DS_ID"
  done
  aws bedrock-agent delete-knowledge-base --knowledge-base-id "$KB_ID" "${A[@]}" >/dev/null
  while aws bedrock-agent get-knowledge-base --knowledge-base-id "$KB_ID" "${A[@]}" >/dev/null 2>&1; do
    echo "    waiting for the knowledge base to be deleted..."
    sleep 5
  done
  echo "    deleted knowledge base $KB_ID"
else
  echo "    not found, skipping"
fi

echo "==> Vector index and bucket"
aws s3vectors delete-index --vector-bucket-name "$VECTOR_BUCKET" --index-name "$INDEX_NAME" "${A[@]}" 2>/dev/null \
  && echo "    deleted index" || echo "    index not found, skipping"
aws s3vectors delete-vector-bucket --vector-bucket-name "$VECTOR_BUCKET" "${A[@]}" 2>/dev/null \
  && echo "    deleted vector bucket" || echo "    vector bucket not found, skipping"

echo "==> Docs bucket"
if aws s3api head-bucket --bucket "$DOCS_BUCKET" "${A[@]}" 2>/dev/null; then
  aws s3 rb "s3://$DOCS_BUCKET" --force "${A[@]}" >/dev/null
  echo "    deleted"
else
  echo "    not found, skipping"
fi

echo "==> IAM role"
if aws iam get-role --role-name "$ROLE_NAME" --profile "$AWS_PROFILE" >/dev/null 2>&1; then
  aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" --profile "$AWS_PROFILE" 2>/dev/null || true
  aws iam delete-role --role-name "$ROLE_NAME" --profile "$AWS_PROFILE"
  echo "    deleted"
else
  echo "    not found, skipping"
fi

echo "==> Guardrail"
GUARDRAIL_ID="$(aws bedrock list-guardrails "${A[@]}" \
  --query "guardrails[?name=='${GUARDRAIL_NAME}'].id | [0]" --output text)"
if [[ "$GUARDRAIL_ID" != "None" && -n "$GUARDRAIL_ID" ]]; then
  aws bedrock delete-guardrail --guardrail-identifier "$GUARDRAIL_ID" "${A[@]}"
  echo "    deleted $GUARDRAIL_ID"
else
  echo "    not found, skipping"
fi

rm -f "$SCRIPT_DIR/../.aws-resources.env"
echo
echo "Cleanup finished."
