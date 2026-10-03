'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { MongoStore: RevisedStore } = require('../src/store');
const { registryFor, eventFor, envelope } = require('../src/simulator/model');
const { decodeEnvelope, validateObservation, percentile } = require('../src/domain');

async function main() {
    if (!process.env.BASELINE_SOURCE) throw new Error('Set BASELINE_SOURCE to preserved application directory');
    const { MongoStore: BaselineStore } = require(path.join(process.env.BASELINE_SOURCE, 'src/store.js'));
    const result = { environment: 'local MongoDB replica set on existing development host', scope: 'new-event persistence only; no cloud, SQS or aggregation timing', observations_per_trial: 1000, concurrent_writers: 20, trials: [] };
    const data = registryFor(20, 2);
    for (let repetition = 1; repetition <= 3; repetition++) {
        let modes = ['baseline', 'revised'];
        if (repetition % 2 === 0) modes = ['revised', 'baseline'];
        for (const mode of modes) {
            let Store = BaselineStore;
            if (mode === 'revised') Store = RevisedStore;
            const run = 'persist-' + mode + '-' + Date.now();
            const store = await Store.open('mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true', run);
            try {
                await store.initialise(data.list, data.sources);
                const records = Array.from({ length: 1000 }, (_, i) => validateObservation(decodeEnvelope(envelope(eventFor(data.list[i % 20], Math.floor(i / 20) + 1, run, Date.now() - 100))), data.registry));
                const samples = [];
                let next = 0;
                const start = performance.now();
                await Promise.all(Array.from({ length: 20 }, async () => {
                    while (next < records.length) {
                        const record = records[next++];
                        const began = performance.now();
                        await store.persist(record);
                        samples.push(performance.now() - began);
                    }
                }));
                const elapsed = performance.now() - start;
                assert.equal(await store.db.collection('observations').countDocuments({}), 1000);
                result.trials.push({ mode, repetition, elapsed_ms: elapsed, observations_per_second: 1000000 / elapsed, p95_persistence_ms: percentile(samples) });
            } finally { await store.db.dropDatabase(); await store.close(); }
        }
    }
    console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
