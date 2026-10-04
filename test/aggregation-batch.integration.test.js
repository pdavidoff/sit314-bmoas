'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoStore } = require('../src/store');
const { registryFor, eventFor, envelope } = require('../src/simulator/model');
const { decodeEnvelope, validateObservation } = require('../src/domain');
const uri = process.env.MONGODB_TEST_URI || 'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true';

test('batched transactions preserve ratings during rollback, overlap and confirmation repair', async () => {
    const suffix = Date.now();
    const store = await MongoStore.open(uri, 'bmoas_batch_test_' + suffix);
    const reference = await MongoStore.open(uri, 'bmoas_reference_test_' + suffix);
    const data = registryFor(80, 1);
    const sharded = (ids, options = {}) => store.aggregateBatch(ids, { shards: 64, ...options });
    try {
        await store.initialise(data.list, data.sources);
        await reference.initialise(data.list, data.sources);
        const records = [];
        const at = Math.floor(Date.now() / 60000) * 60000 + 100;
        for (let index = 0; index < 240; index++) {
            const event = eventFor(data.list[index % data.list.length], index + 1, 'batch-check', at);
            const record = validateObservation(decodeEnvelope(envelope(event)), data.registry);
            if (index === 1) record.late = true;
            records.push(record);
            await store.persist(record);
            await reference.persist(record);
        }
        const ids = records.map(record => record._id);
        await assert.rejects(sharded(ids.slice(0, 10), { failBeforeCommit: true }), /injected_transaction_failure/);
        assert.equal(await store.db.collection('aggregates').countDocuments({}), 0);
        assert.equal(await store.db.collection('memberships').countDocuments({}), 0);
        assert.equal(await store.db.collection('observations').countDocuments({ completed_at: { $exists: true } }), 0);
        await assert.rejects(sharded([ids[0], 'missing']), /observation_not_ready/);
        // Concurrent transactions touch the same buckets and overlap event identifiers.
        await Promise.all([
            sharded(ids.slice(0, 80)),
            sharded(ids.slice(40, 120)),
            sharded(ids.slice(120, 200)),
            sharded([...ids.slice(180), ids[180]])
        ]);
        for (const id of ids) await reference.aggregate(id);
        function counts(rows) {
            return rows.map(row => ({ id: row._id, observations: row.observation_count, participants: row.participant_count }));
        }
        assert.deepEqual(counts(await store.reports()), counts(await reference.reports()));
        assert.equal((await store.runSummary('batch-check')).completed, 240);
        const first = await store.db.collection('observations').findOne({ _id: ids[0] });
        await sharded(ids.slice(0, 10));
        assert.equal(+(await store.db.collection('observations').findOne({ _id: ids[0] })).confirmed_at, +first.confirmed_at);
        // Model a process exit after commit but before timing confirmation.
        await store.db.collection('observations').updateMany({ _id: { $in: ids.slice(0, 10) } }, { $unset: { confirmed_at: '', processing_latency_ms: '' } });
        await sharded(ids.slice(0, 10));
        assert.deepEqual(counts(await store.reports()), counts(await reference.reports()));
        assert.equal((await store.runSummary('batch-check')).completed, 240);
        for (const record of records) {
            const actual = await store.db.collection('observations').findOne({ _id: record._id });
            const expected = await reference.db.collection('observations').findOne({ _id: record._id });
            assert.equal(actual.disposition, expected.disposition);
            assert.equal(actual.bucket_id, expected.bucket_id);
            assert.ok(actual.confirmed_at >= actual.completed_at);
        }
    } finally {
        await store.db.dropDatabase();
        await reference.db.dropDatabase();
        await store.close();
        await reference.close();
    }
});
