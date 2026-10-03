'use strict';
const { MongoStore } = require('../store');
const { getQueue } = require('../queue/sqs');
const { consume } = require('../queue/consume');
const { validatorHandler } = require('../handlers');
const { Metrics, error, log } = require('../telemetry');
const { integer } = require('../config');
async function main() {
    const store = await MongoStore.open(), queue = getQueue(), registry = await store.registry(), metrics = new Metrics('validator');
    if (!registry.devices.size)
        throw new Error('Run database initialisation first');
    const worker = consume(queue, 'checked', validatorHandler(store, queue, registry, metrics), { onTiming: (name, value) => metrics.observe(name, value), parallel: integer('POLLERS', 2, 1, 8), onError: e => { metrics.add('TransientErrors'); error(e); } });
    log('ready', { service: 'validator', registered_devices: registry.devices.size });
    async function close() { await worker.stop(); metrics.close(); await store.close(); await queue.close(); process.exit(0); }
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
}
if (require.main === module)
    main().catch(e => { error(e); process.exit(1); });
module.exports = { main };
