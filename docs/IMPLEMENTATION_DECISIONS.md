# Implementation decisions

## Preserved decisions

The approved design uses simulated meters, Node.js, Node-RED, AWS IoT Core, MongoDB Atlas on AWS and automatic scaling of the aggregation service on ECS/Fargate. The submitted project plan is the academic baseline. Tutor-accepted targets remain design targets, not measured capacities.

The system measures **detected exposure**, not a participant's attention or population audience ratings. It does not recognise real watermarks. Each logical meter follows a deterministic schedule of synthetic sources. `null` source plus detection method `none` means no media was detected. The `confidence` value is generated, not the output of a measured audio recogniser.

## ADR-001: durable queues after MQTT

This is a new implementation refinement, not a decision already approved by the tutor:

```text
Node.js logical meters / simulated gateways
  -> MQTT/TLS -> AWS IoT Core
  -> IoT rule -> raw SQS queue
  -> Node-RED decode / basic checks
  -> checked SQS queue
  -> Node.js validation -> MongoDB observations
  -> aggregate SQS queue (references, not whole observations)
  -> Node.js aggregation on ECS (1–4 tasks)
  -> MongoDB aggregates -> reporting API
```

Invalid input is routed to a separate quarantine queue. Each processing queue has a dead-letter queue in AWS. The IoT rule also has an action for delivery failures. There are no direct synchronous calls between processing services.

Why this refinement is needed: AWS IoT Core limits each MQTT connection to 100 publishes per second, including incoming/outgoing traffic. Queued shared subscriptions also have specific queuing and dequeue limits. One MQTT connection per aggregation task would constrain the accepted 1,000-observations/s experiment independently of CPU. AWS supports routing MQTT messages into standard SQS queues directly. SQS lets consumers divide work while retaining a visible backlog and delivery retries. Node-RED remains a real processing stage; only its input adapter changes from a direct MQTT subscription to the queue populated by IoT Core.

Alternatives were multiple MQTT connections per worker or lower backend batching rates. They were not chosen because connection pools and delivery recovery would obscure the initial experiment. SQS adds a service and request cost; record that trade-off in the progress report rather than presenting this as the unchanged original diagram.

Sources: [AWS IoT quotas](https://docs.aws.amazon.com/general/latest/gr/iot-core.html), [MQTT sessions/shared subscriptions](https://docs.aws.amazon.com/iot/latest/developerguide/mqtt.html), [IoT SQS rule action](https://docs.aws.amazon.com/iot/latest/developerguide/sqs-rule-action.html).

## Delivery and duplicate correctness

A worker deletes an input message only after its durable next step succeeds. The validator writes the observation, then sends its ID to the aggregation queue, then acknowledges input. If it fails between the first two operations, replay sends the reference again. An existing observation is not treated as proof that downstream work completed.

Aggregation uses a MongoDB transaction to update the observation's applied marker, summary counts and participant membership together. A repeated reference sees the marker and does not reapply counts. The database must support transactions; the local setup therefore creates a replica set. This is **idempotent application processing**, not an exactly-once network guarantee. Broker acknowledgements confirm MQTT receipt, not successful execution of an IoT rule or aggregation.

Source: [MongoDB transactions](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/).

## Data model

`observations` embeds the immutable observation plus receipt/processing metadata; `_id` and `event.event_id` are unique. `devices` references panel and gateway IDs. `media_sources` holds the synthetic catalogue. `aggregates` groups by run, period, media source and region. `memberships` gives one count per panel within each such group. Do not add the participant counts from multiple periods and call the sum unique people over the entire period.

Events delayed by more than 30 minutes are retained as `late_review` rather than included in current summaries. Events older than 7 days are rejected. Observations, aggregates and membership receipts expire after 30 days. SQS retention is 14 days. Keep these horizons consistent; shortening deduplication retention below the supported replay horizon could allow double counting. Reconciliation of old late events is explicitly future work.

## Devices versus connections

The profiles represent logical meters, not one operating-system process or network connection per meter. The registry assigns 10,000 meters to 20 synthetic gateways. Each gateway publishes no faster than 50 messages/s. Home Wi-Fi and BLE labels model topology; no radio stack or phone application is built. This tests the backend's event workload, not the ability to hold 10,000 MQTT connections. A separate test would be needed for that claim.

## AWS and Atlas

Default region is **Sydney (`ap-southeast-2`)**, a configurable assumption, not a confirmed detail of your account. ECS tasks run in private subnets and use one NAT gateway with a fixed public address. That address can be allow-listed in Atlas. The single NAT gateway is a cost-conscious prototype choice, not multi-zone high availability.

Atlas Free limits operations to 100/s and storage to 0.5 GB. This transaction-based pipeline performs several database operations per observation. Free is therefore a functional smoke-test environment, not evidence that the baseline/high-load targets are feasible on that tier. Use an appropriate existing tier or deliberately provision one after reviewing cost; no tier capacity is guaranteed in this package.

Source: [Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/).
