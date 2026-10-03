# Local verification

## Order

Use Node.js 22.16+ and Docker Compose. Keep all local service ports bound to `127.0.0.1`. Local Mosquitto and MongoDB deliberately have no authentication; **do not use their local configuration in AWS**. The production path uses IoT certificates, Atlas authentication and private ECS tasks.

Run `bash scripts/local-init.sh`, then start the five npm services listed in README. The bridge is only a local substitute for the IoT rule; never deploy it as the AWS broker.

`npm run test:integration` performs real MongoDB transaction, rollback and concurrent replay checks. It requires a replica set and installed dependencies and fails rather than silently skipping. It creates and removes an isolated database with a `bmoas_test_` prefix. Do not point it at an account without permission to create/remove that test database.

## First trace

Run `npm run simulate -- --profile smoke --run smoke-001`. Confirm:

- the simulator manifest records 200 generated unique observations and 200 MQTT acknowledgements;
- Node-RED shows messages through decode, structure checks and the forwarding output;
- MongoDB has 200 observations for that run and each has `confirmed_at` after processing;
- the aggregate observation counts equal only those observations with a detected source;
- `GET /v1/reports?run_id=smoke-001` returns matching summaries;
- a request without the token returns HTTP 401.

Use `mongosh` or Compass on `mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true`. Example query:

```javascript
db.getSiblingDB('bmoas').observations.findOne({run_id:'smoke-001'})
```

The same ID should appear in the spool and database. Debug output intentionally does not print entire observations or credentials.

## Failures

Run `node --env-file=.env scripts/faults.js` only when the normal simulator is stopped. It prints the expected outcomes for its separate run. Capture the Node-RED rejected branch, the quarantine queue, a late-review record and the aggregate count. Malformed JSON cannot reliably carry a run ID; run negative tests in isolation and record queue counts before and after.

Stop the aggregator, publish a small run, inspect the aggregate queue, restart the aggregator and confirm it drains. Then stop a consumer during processing and confirm redelivery does not change the final aggregate counts. Record the outcomes and compare the final identifiers and ratings counts.

The simulator's append-only spool persists queued events on disk and retains the first publication time. Use `--resume --run SAME_RUN --profile SAME_PROFILE` after interruption. Stop the original process first. Resume replays pending records; it does not create another full dataset. A partial final ledger line after storage failure needs preservation and manual repair; the program will stop rather than silently discard it.

## Clean up

`docker compose down` stops containers but retains data. `docker compose down -v` irreversibly removes the local database, MQTT state and volumes: use only after exporting evidence. Keep `runs/` outside Git; commit selected redacted evidence, not credentials or unreviewed raw data.
