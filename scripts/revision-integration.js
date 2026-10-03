'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { SQSClient, CreateQueueCommand, DeleteQueueCommand } = require('@aws-sdk/client-sqs');
const { SqsQueue, setQueue } = require('../src/queue/sqs');
const { consume } = require('../src/queue/consume');
const { MongoStore } = require('../src/store');
const { MemoryStore } = require('../src/memory-store');
const { startNodeRed } = require('../src/services/node-red');
const { createApi } = require('../src/services/api');
const { validatorHandler, aggregatorHandler } = require('../src/handlers');
const { registryFor, eventFor, envelope } = require('../src/simulator/model');
const { validateObservation, decodeEnvelope, percentile } = require('../src/domain');

async function main() {
    const run = 'revision-local-' + Date.now();
    const endpoint = 'http://127.0.0.1:9324';
    const client = new SQSClient({ region: 'ap-southeast-2', endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
    const urls = {};
    let queue, store, nodeRed, validator, aggregator, api;
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmoas-revision-'));
    const errors = [];
    const samples = {};
    const metrics = { add() {}, observe(name, value) { if (!samples[name]) samples[name] = []; samples[name].push(value); } };
    try {
        for (const name of ['raw', 'checked', 'aggregate', 'rejected']) {
            const result = await client.send(new CreateQueueCommand({ QueueName: run + '-' + name }));
            urls[name] = result.QueueUrl;
        }
        queue = new SqsQueue({ endpoint, urls });
        setQueue(queue);
        store = await MongoStore.open('mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true', run);
        const data = registryFor(20, 2);
        await store.initialise(data.list, data.sources);
        const expected = new MemoryStore(data.registry);
        process.env.NR_USER_DIR = userDir;
        process.env.NODE_ENV = 'production';
        nodeRed = await startNodeRed({ port: 0, host: '127.0.0.1' });
        validator = consume(queue, 'checked', validatorHandler(store, queue, data.registry, metrics), { onError: e => errors.push(e.code || e.message), onTiming: (name, value) => metrics.observe(name, value) });
        aggregator = consume(queue, 'aggregate', aggregatorHandler(store), { onError: e => errors.push(e.code || e.message) });
        const events = [];
        const now = Date.now();
        for (let i = 0; i < 500; i++) {
            const event = eventFor(data.list[i % data.list.length], Math.floor(i / data.list.length) + 1, run, now - 1000, now);
            events.push(envelope(event));
            const record = validateObservation(decodeEnvelope(envelope(event)), data.registry);
            await expected.persist(record);
            await expected.aggregate(record._id);
        }
        // Deliberate duplicate deliveries accompany the 500 unique observations.
        const deliveries = [...events, ...events.slice(0, 25)];
        for (let i = 0; i < deliveries.length; i += 20) await Promise.all(deliveries.slice(i, i + 20).map(e => queue.send('raw', e)));
        const deadline = Date.now() + 90000;
        let summary;
        while (Date.now() < deadline) {
            summary = await store.runSummary(run);
            const stats = await Promise.all(['raw', 'checked', 'aggregate'].map(name => queue.stats(name)));
            if (summary.completed === 500 && stats.every(s => s.visible === 0 && s.in_flight === 0)) break;
            await wait(200);
        }
        assert.equal(summary.completed, 500);
        const actual = await store.reports({ run_id: run });
        const normalise = rows => rows.map(r => ({ id: r._id, observations: r.observation_count, participants: r.participant_count })).sort((a, b) => a.id.localeCompare(b.id));
        assert.deepEqual(normalise(actual), normalise(await expected.reports()));
        assert.deepEqual(errors, []);
        api = createApi(store, 'local-test-token-'.repeat(3));
        await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
        const url = 'http://127.0.0.1:' + api.address().port + '/v1/reports?run_id=' + run;
        assert.equal((await fetch(url)).status, 401);
        assert.equal((await fetch(url, { headers: { Authorization: 'Bearer ' + 'local-test-token-'.repeat(3) } })).status, 200);
        console.log(JSON.stringify({ type: 'revision_integration_result', environment: 'existing development host, real Node-RED, ElasticMQ and MongoDB replica set; ingress injected at raw queue', unique: 500, duplicate_deliveries: 25, summary, exact_aggregate_and_participant_counts: true, auth_statuses: [401, 200], transient_errors: errors, stage_p95_ms: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, percentile(values)])) }));
    } finally {
        if (api) await new Promise(resolve => api.close(resolve));
        if (nodeRed) await nodeRed.close();
        if (validator) await validator.stop();
        if (aggregator) await aggregator.stop();
        if (queue) await queue.close();
        if (store) { await store.db.dropDatabase(); await store.close(); }
        for (const QueueUrl of Object.values(urls)) await client.send(new DeleteQueueCommand({ QueueUrl }));
        client.destroy();
        fs.rmSync(userDir, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
