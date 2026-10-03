# Changes following tutor feedback

The tutor identified slow scaling and bottlenecks in Node-RED and validation. The revision addresses processing overhead and the capacity of each stage.

| Change | Reason | Files |
|---|---|---|
| Insert a new observation directly, then check existing records only after a duplicate key result | Avoid an additional database read for each new event while preserving duplicate and conflict checks | `src/store.js` |
| Batch SQS sends and deletions, with per-entry acknowledgements | Reduce request overhead while retaining retry behaviour | `src/queue/batch.js`, `src/queue/sqs.js` |
| Update successful Node-RED status less frequently | Reduce work that does not contribute to processing an observation | `node-red/nodes/queue-nodes.js` |
| Scale all three processing stages between one and four tasks | Allow capacity to increase where a queue develops | `infra/services.json` |
| Add CPU, queue depth and queue age scale-out alarms | Respond to developing pressure before the original target policy alone would react | `infra/services.json` |
| Measure validation CPU work, persistence and forwarding separately | Identify which operation contributes to delay | `src/handlers.js`, `src/telemetry.js` |
| Add a stepped publication schedule and collect task counts for every processing stage | Compare performance and resource use across changing load | `src/simulator/workload.js`, `scripts/collect.js`, `config/stepped.json` |

The initial queue thresholds are 1,000 visible messages or 30 seconds oldest-message age. These request four tasks. A one-minute CPU alarm at 60% requests an additional task. Scale-out cooldown is 60 seconds, and the CPU target policy retains a 180-second scale-in cooldown. Actual response also depends on metric availability, alarm evaluation and task startup.

The event contract, ratings rules, late-event handling, authenticated reporting and aggregation transactions are retained. Each processing stage responds independently to its own queue.

Automated checks include partial batch failure, missing acknowledgements, transport failure, duplicate identity, conflicting payloads, shutdown flushing, scaling configuration and workload boundaries. The real local integration test also checks duplicates and exact ratings counts with Node-RED, ElasticMQ and MongoDB.
