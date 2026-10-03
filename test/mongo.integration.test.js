'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const uri = process.env.MONGODB_TEST_URI || 'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true';
// This deliberately fails when MongoDB/dependencies are unavailable. It never masquerades as passed.
test('real MongoDB transaction, duplicate and failure behaviour', async () => {
    const { MongoStore } = require('../src/store'), { registryFor, eventFor, envelope } = require('../src/simulator/model'), { decodeEnvelope, validateObservation } = require('../src/domain');
    const name = 'bmoas_test_' + Date.now(), store = await MongoStore.open(uri, name), data = registryFor(2, 1);
    try {
        await store.initialise(data.list, data.sources);
        const e = eventFor(data.list[0], 1, 'mongo-integration', Date.now() - 100), r = validateObservation(decodeEnvelope(envelope(e)), data.registry);
        await Promise.all([store.persist(r), store.persist(r), store.persist(r)]);
        const retry = { ...r, published_at: new Date() };
        const stored = await store.persist(retry);
        assert.equal(+stored.published_at, +r.published_at);
        await assert.rejects(store.persist({ ...r, payload_hash: 'conflicting' }), { code: 'event_id_conflict' });
        await assert.rejects(store.aggregate(r._id, { failBeforeCommit: true }));
        assert.equal(await store.db.collection('aggregates').countDocuments({}), 0);
        await Promise.all([store.aggregate(r._id), store.aggregate(r._id), store.aggregate(r._id)]);
        const results = await store.reports({ run_id: 'mongo-integration' });
        assert.equal(results[0].observation_count, 1);
        assert.equal(results[0].participant_count, 1);
        const summary = await store.runSummary('mongo-integration');
        assert.equal(summary.completed, 1);
        assert.ok(summary.p95_processing_ms >= 0);
    }
    finally {
        await store.db.dropDatabase();
        await store.close();
    }
});
