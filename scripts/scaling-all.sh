#!/usr/bin/env bash
set -euo pipefail
: "${CLUSTER:?Set CLUSTER}" "${AWS_REGION:?Set AWS_REGION explicitly}"
MODE="${1:-}"
COUNT="${2:-1}"
shift 2
[[ "$MODE" == fixed || "$MODE" == elastic ]] || { echo 'Use fixed|elastic COUNT SERVICE SERVICE SERVICE'; exit 1; }
[[ "$COUNT" =~ ^[1-4]$ && "$#" -eq 3 ]] || { echo 'Provide count 1..4 and exactly three processing service names'; exit 1; }
for STAGE_SERVICE in "$@"; do
    SERVICE="$STAGE_SERVICE" bash "$(dirname "$0")/scaling-mode.sh" "$MODE" "$COUNT"
done
