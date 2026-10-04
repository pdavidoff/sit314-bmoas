# Further changes to meet processing targets

The first revision reduced validation work and added scaling across Node-RED, validation and aggregation. Its eight trials improved throughput and recovery while preserving exact ratings, but larger workloads still had delays of several minutes.

## Batching aggregation and preparing capacity

The next version grouped up to ten observations into one MongoDB transaction. It grouped membership checks and ratings updates, then confirmed each observation after the transaction committed. Scheduled capacity was demonstrated by reducing all three processing stages to one task and using a scheduled action to increase them to four. All stages reached four running tasks 63.84 seconds after the scheduled time, before the next workload began.

With this capacity already available, 60,000 observations at 100 per second completed with p95 latency of 228 milliseconds. Identifiers and ratings matched exactly. This met the original baseline target of under two seconds.

The 900,000 observation trial configured 1,000 observations per second for 900 seconds. It completed with exact identifiers and ratings, but p95 was 242.231 seconds. Throughput over the full processing interval was 732.66 observations per second. The aggregator queue grew while Node-RED and validation remained close to the arrival rate. Aggregator CPU was around 42 to 45% in sampled minutes. Continuous collection ended before full recovery, so the original collection and the later unchanged drain are recorded separately.

## Partitioning the ratings updates

Multiple aggregation workers can otherwise update the same ratings record at the same time. The further revision divides each logical ratings bucket into 64 storage groups. A stable hash of the participant identifier determines the group. This spreads counter writes while keeping every participant in a consistent group for that bucket.

Membership identifiers still use the logical bucket and participant identifier. A transaction inserts each membership once and increments the participant count only when that insertion is new. The observation count includes every valid distinct observation. Applied markers and counters commit together. Redelivery repairs missing confirmation without increasing the ratings again.

The reporting query combines the storage groups into the original logical bucket. The API returns the same source, region, reporting period, observation count and participant count. This is partitioning within the application on the existing Atlas replica set. It does not add MongoDB cluster shards or replace the event contract.

Real MongoDB tests compare the reported ratings with the original single-observation implementation. They cover overlapping concurrent batches, duplicate observations, rollback, missing records, late observations, no-media observations and confirmation repair. The final local verification passed 58 unit tests and two integration tests. A benchmark with eight concurrent workers completed 3,000 observations in each case. Two paired tests measured 305 and 464 observations per second for shared counters, compared with 871 and 912 for partitioned counters. Cloud evaluation is recorded separately.

## Workload generation and further evaluation

The generator previously limited each of 20 gateways to one publication per 20 milliseconds. That set its theoretical ceiling at exactly 1,000 observations per second before execution overhead. The further version allows one publication per 12 milliseconds to provide headroom, while preserving the configured generation rate, durable spool, event identifiers and MQTT acknowledgements.

The remaining evaluation uses 60,000 baseline observations, 120,000 higher-load observations over 120 seconds and a reconnect workload of 50,000 buffered plus 12,000 regular observations. The higher-load duration is shorter than the original 900 seconds to fit the approved evaluation budget. Report the duration alongside any result. A successful short trial supports performance over that measured interval and does not establish prolonged operation.

The task limit remains four per processing stage. Node-RED and validation each receive one vCPU and 2 GiB per task, and aggregation receives half a vCPU and 1 GiB per task. These resource allocations differ from the earlier revision and must accompany comparisons. Scheduled preparation and software changes are evaluated together. Their individual contributions are not isolated by these trials.

## Final cloud results

All three final trials passed exact observation identifiers and independently calculated ratings. Baseline60000 observations: p95 226ms, completed throughput99.98/s. Higher load120000 over120seconds: p95 288ms, completed throughput998.05/s. Reconnect62000: p95 506ms, final confirmation0.149s after publication, first empty-queue sample28.32s. No service error codes were recorded. Four tasks remained running at each processing stage. These are one trial per workload, and the two-minute higher-load result has a shorter duration than the earlier fifteen-minute test. The first two original p95 targets and reconnect recovery target were met under these measured conditions.
