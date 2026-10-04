'use strict';
const { MongoStore } = require('../store');
const { getQueue } = require('../queue/sqs');
const { consume } = require('../queue/consume');
const { batchedAggregatorHandler } = require('../aggregation-batch');
const { Metrics, error, log } = require('../telemetry');
const { integer } = require('../config');
async function main() {
    const store = await MongoStore.open(), queue = getQueue(), metrics = new Metrics('aggregator');
    const handler = batchedAggregatorHandler(store, metrics, { windowSeconds: integer('WINDOW_SECONDS', 60, 1, 3600), shards: integer('AGGREGATE_SHARDS', 64, 1, 256) });
    const worker = consume(queue, 'aggregate', handler, { parallel: integer('POLLERS', 2, 1, 8), onError: e => { metrics.add('TransientErrors'); error(e); } });
    log('ready', { service: 'aggregator' });
    async function close() { await worker.stop(); await handler.close(); metrics.close(); await store.close(); await queue.close(); process.exit(0); }
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
}
if (require.main === module)
    main().catch(e => { error(e); process.exit(1); });
module.exports = { main };
