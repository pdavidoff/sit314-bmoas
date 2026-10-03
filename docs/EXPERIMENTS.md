# Experiments and evidence

The original experimental guidance follows. The current tutor feedback comparison and collection limits are recorded in [evaluation status](EVALUATION.md).

## Fixed settings

The approved workloads are encoded in `config/`. A device sends one observation every ten seconds for the baseline and scale profiles. The smoke profile is smaller and runs at one observation per device per second. Every run has a distinct `run_id`; use the same profile, code revision, database tier, region, window size and worker size when comparing configurations.

Run `npm run collect -- --run RUN_ID --seconds SECONDS` before starting the matching simulator. Add `--aws --cluster ... --service ...` for AWS metadata and CPU/memory/scale activity capture. For large workloads the simulator requires `--confirm-load`:

```sh
npm run simulate -- --profile baseline --run baseline-fixed1-001 --confirm-load
```

The 10,000-meter profile is 1,000 MQTT publications/s in total, spread across 20 gateway connections at a maximum of 50/s each. It is not a test of 10,000 simultaneous MQTT connections. Actual achieved publication rate can be lower if the generator, disk or network is the bottleneck; retain the manifest and queue samples rather than assuming the configured rate was reached.

## Comparison

First collect a fixed one-task baseline, then a fixed four-task baseline, then the elastic run. `scripts/scaling-mode.sh fixed 1` and `fixed 4` suspend scaling before setting desired count. `elastic` restores it. Set `CLUSTER` and `SERVICE` to the real aggregation service. Wait for service stability, warm the system, record the state, and repeat each run at least three times where budget permits. Never compare different code revisions without recording the difference.

The accepted CPU target is 60% with 60-second scale-out and 180-second scale-in cooldowns. Cooldowns are not promises of those response times; metric periods, target-tracking evaluation and task startup also affect response. Run sustained load long enough to observe those effects. Do not add a CPU-burning loop just to trigger the policy. Database-bound processing may not benefit from more tasks; that is an important result to diagnose, not a reason to label the targets as met.

## Metrics

**Publication time:** the simulator records `published_at` immediately before the first publication attempt and preserves it across retries. `observed_at` remains the simulated exposure time. Time spent deliberately offline is excluded from processing latency. Synchronise clocks before cloud testing and flag negative/implausible latencies.

**Completion:** the aggregate transaction commits the application marker and counts together. A subsequent `confirmed_at` records when the application knows it committed. The measured latency is conservative: it includes acknowledgement and a following read. A crash between commit and timing confirmation may make the later retry's latency longer; do not rewrite that time to make the result look better.

**p95:** nearest-rank 95th percentile across valid unique completed observations, with incomplete observations reported separately. Baseline target is <2,000 ms; scale target is <5,000 ms. The full completed distribution and clock checks must be available before treating a target as passed.

**Errors:** for the ordinary valid-input profiles, reconcile generated unique IDs with successfully confirmed observations after the drain period. Missing, failed or dead-lettered valid events are not successful. Intentional invalid input uses a separate run. Record transient retry errors separately from final completion failures. The evaluator reports both incompleteness and latency; a low p95 among only the fastest successful events is insufficient.

**Backlog:** record visible plus in-flight counts for the raw, checked and aggregate queues. Counts are approximate, so also compare published unique observations with confirmed records. Define the burst as finished at the simulator's final publication. The target is recovery within 120 seconds after that point. Keep an additional 120-second low-load period to observe scale-in. Queue expiry or deletion is not recovery.

The `reconnect` profile preloads 50,000 events aged about 10 minutes and releases them at the gateway rate cap alongside live events. This models stored observations being released, not physical Bluetooth networking or actual radio recovery.

## Minimum evidence before a status report

Save the source revision, dependency lockfile, container image tag/digest, device profile, schema, Node-RED export/screenshot, one observation traced by ID, database/index evidence, test output and remaining defects. Add AWS queue, ECS, policy, CloudWatch and security screenshots only after deployment. Redact secrets and credentials, not inconvenient measurements.

The submitted task is a report of progress. This repository does not make the project complete or prove the accepted performance targets. It provides a baseline to build, test and explain.

## High Distinction extension

Review the journal articles before committing to the research comparison. Record the research question, the selected approach and why it applies to this workload. Preserve this initial baseline and change one defined aspect for the comparison. A later queue-aware policy, processing strategy or allocation of work may be relevant, but no particular technique is labelled state of the art or implemented as a research contribution here. Successful CPU-based scaling alone is not the HD research result.
