'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const domain = require('../src/domain'), flow = require('../node-red/flows.json'), { registryFor, eventFor, envelope } = require('../src/simulator/model');
const { MemoryQueue } = require('../src/queue/memory'), { MemoryStore } = require('../src/memory-store'), { validatorHandler, aggregatorHandler } = require('../src/handlers');
async function main() {
    const data = registryFor(10, 2), store = new MemoryStore(data.registry), queue = new MemoryQueue(), v = validatorHandler(store, queue, data.registry), a = aggregatorHandler(store), now = Date.now(), run = 'offline-functional-demo';
    function stage(id, msg) { return vm.runInNewContext('(function(msg){' + flow.find(f => f.id === id).func + '})(msg)', { msg, global: { get: () => domain }, Buffer }); }
    let published = 0;
    const sample = [];
    for (let i = 0; i < 100; i++) {
        const e = eventFor(data.list[i % 10], Math.floor(i / 10) + 1, run, now - 1000, now - 500);
        sample.push(e);
        for (let repeat = 0; repeat < (i % 10 === 0 ? 2 : 1); repeat++) {
            published++;
            const decoded = stage('decode', { payload: envelope(e) })[0];
            const checked = stage('check', decoded)[0];
            await v(checked.payload);
        }
    }
    const bad = stage('decode', { payload: envelope('{broken') });
    await queue.send('rejected', bad[1].payload);
    while (queue.items('aggregate').length) {
        const messages = await queue.receive('aggregate');
        for (const m of messages) {
            await a(JSON.parse(m.body));
            await queue.remove('aggregate', m.receipt);
        }
    }
    const reports = await store.reports(), observations = [...store.observations.values()];
    const output = { test_environment: 'offline logic only: in-memory queue/store; exported Node-RED function bodies executed in a VM', not_demonstrated: ['MQTT networking', 'live Node-RED runtime', 'MongoDB transactions', 'AWS deployment', 'automatic scaling', 'approved latency and throughput targets'],
        unique_events: sample.length, delivered_valid_messages: published, stored_events: store.observations.size, duplicate_deliveries: published - sample.length, malformed_messages_quarantined: queue.items('rejected').length,
        expected_detected_observations: sample.filter(e => e.media_source_id !== null).length, actual_counted_observations: reports.reduce((n, r) => n + r.observation_count, 0), all_events_finalised: observations.every(r => r.completed_at), sample_report: reports[0] };
    if (output.actual_counted_observations !== output.expected_detected_observations || !output.all_events_finalised)
        throw new Error('Functional check failed');
    fs.mkdirSync('evidence', { recursive: true });
    fs.writeFileSync(path.resolve('evidence/offline-demo.json'), JSON.stringify(output, null, 2) + '\n');
    console.log(JSON.stringify(output, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
