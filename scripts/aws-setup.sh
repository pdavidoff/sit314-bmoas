#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[ ! -f config/cloud.env ] || source config/cloud.env
export AWS_REGION="${AWS_REGION:-ap-southeast-2}"
PROJECT="${PROJECT:-bmoas}"; FOUNDATION_STACK="${FOUNDATION_STACK:-bmoas-foundation}"; SERVICES_STACK="${SERVICES_STACK:-bmoas-services}"
command -v aws >/dev/null || { echo 'Install AWS CLI v2 and authenticate locally first'; exit 1; }
command -v python3 >/dev/null || { echo 'Python 3 is required'; exit 1; }
ACTION="${1:-preflight}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
printf 'Account: %s | Region: %s | Action: %s
' "$ACCOUNT" "$AWS_REGION" "$ACTION"
output() { aws cloudformation describe-stacks --stack-name "$FOUNDATION_STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue|[0]" --output text; }
if [ "$ACTION" = preflight ]; then
 aws cloudformation validate-template --template-body file://infra/foundation.json >/dev/null
 aws cloudformation validate-template --template-body file://infra/services.json >/dev/null
 echo 'Templates accepted by CloudFormation syntax validation. This does not prove account permissions or successful deployment.'
 exit 0
fi
if [ "${CONFIRM_ACCOUNT:-}" != "$ACCOUNT" ]; then
 echo 'This action creates or changes billable AWS resources.'
 echo 'Review docs/AWS_SETUP.md, then set CONFIRM_ACCOUNT to the account printed above.'
 exit 1
fi
case "$ACTION" in
 foundation)
  aws cloudformation deploy --stack-name "$FOUNDATION_STACK" --template-file infra/foundation.json --parameter-overrides "Project=$PROJECT" --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset
  aws cloudformation describe-stacks --stack-name "$FOUNDATION_STACK" --query 'Stacks[0].Outputs' --output table
  echo 'Add only the EgressIp /32 (and your laptop /32 for initialisation) to Atlas network access.'
  ;;
 image)
  [ -f package-lock.json ] || { echo 'Run npm install and review/commit package-lock.json first'; exit 1; }
  REPO="$(output RepositoryUri)"; REGISTRY="${REPO%%/*}"; TAG="$(date -u +%Y%m%dT%H%M%S)"
  aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY"
  docker build --platform linux/amd64 -t "$REPO:$TAG" .
  docker push "$REPO:$TAG"
  echo "Set IMAGE_URI=$REPO:$TAG in config/cloud.env"
  ;;
 services)
  : "${IMAGE_URI:?Set IMAGE_URI}" "${MONGO_WRITER_SECRET_ARN:?Set writer secret ARN}" "${MONGO_READER_SECRET_ARN:?Set reader secret ARN}" "${API_TOKEN_SECRET_ARN:?Set token secret ARN}"
  echo 'Atlas must already contain the seeded registry and indexes. See docs/AWS_SETUP.md.'
  aws cloudformation deploy --stack-name "$SERVICES_STACK" --template-file infra/services.json --parameter-overrides "FoundationStack=$FOUNDATION_STACK" "ImageUri=$IMAGE_URI" "MongoWriterSecretArn=$MONGO_WRITER_SECRET_ARN" "MongoReaderSecretArn=$MONGO_READER_SECRET_ARN" "ApiTokenSecretArn=$API_TOKEN_SECRET_ARN" --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset
  ;;
 *) echo 'Use preflight | foundation | image | services'; exit 1;;
esac
