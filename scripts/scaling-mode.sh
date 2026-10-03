#!/usr/bin/env bash
set -euo pipefail
: "${CLUSTER:?Set CLUSTER}" "${SERVICE:?Set SERVICE to the aggregation service name}"
MODE="${1:-}"; N="${2:-1}"; RID="service/$CLUSTER/$SERVICE"
case "$MODE" in
 fixed)
  [[ "$N" =~ ^[1-4]$ ]] || { echo 'Fixed count must be 1..4';exit 1; }
  aws application-autoscaling register-scalable-target --service-namespace ecs --resource-id "$RID" --scalable-dimension ecs:service:DesiredCount --min-capacity 1 --max-capacity 4 --suspended-state DynamicScalingInSuspended=true,DynamicScalingOutSuspended=true,ScheduledScalingSuspended=true
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count "$N" >/dev/null
  ;;
 elastic)
  aws application-autoscaling register-scalable-target --service-namespace ecs --resource-id "$RID" --scalable-dimension ecs:service:DesiredCount --min-capacity 1 --max-capacity 4 --suspended-state DynamicScalingInSuspended=false,DynamicScalingOutSuspended=false,ScheduledScalingSuspended=false
  ;;
 *) echo 'Use fixed 1 | fixed 4 | elastic';exit 1;;
esac
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
