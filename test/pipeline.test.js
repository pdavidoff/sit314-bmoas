'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { MemoryQueue } = require('../src/queue/memory');
const { MemoryStore } = require('../src/memory-store');
const { validatorHandler, aggregatorHandler } = require('../src/handlers');
const { registryFor, eventFor, envelope } = require('../src/simulator/model');
const { decodeEnvelope, basicChecks } = require('../src/domain');
const { createApi } = require('../src/services/api');
function fixture() { const data = registryFor(2, 1), store = new MemoryStore(data.registry), queue = new MemoryQueue(); return { data, store, queue, v: validatorHandler(store, queue, data.registry), a: aggregatorHandler(store) }; }
function message(f, seq = 1) { return basicChecks(decodeEnvelope(envelope(eventFor(f.data.list[0], seq, 'pipeline', Date.now() - 100)))); }
async function drain(f) { const messages = await f.queue.receive('aggregate'); for (const m of messages) {
    await f.a(JSON.parse(m.body));
    await f.queue.remove('aggregate', m.receipt);
} }
test('normal event reaches stored observations and a report', async () => { const f = fixture(); await f.v(message(f)); await drain(f); assert.equal(f.store.observations.size, 1); assert.equal((await f.store.reports())[0].observation_count, 1); });
test('duplicate input forwards safely but changes the aggregate only once', async () => { const f = fixture(), m = message(f); await f.v(m); await f.v(m); await drain(f); assert.equal((await f.store.reports())[0].observation_count, 1); });
test('same participant is counted once within a source and period', async () => { const f = fixture(), m = message(f), n = structuredClone(m); n.event.sequence = 2; n.event.event_id = 'second-event'; await f.v(m); await f.v(n); await drain(f); const a = (await f.store.reports())[0]; assert.equal(a.observation_count, 2); assert.equal(a.participant_count, 1); });
test('conflicting content with a reused event ID is quarantined', async () => { const f = fixture(), m = message(f); await f.v(m); const changed = structuredClone(m); changed.event.detection.confidence = .4; await f.v(changed); assert.equal(f.queue.items('rejected').length, 1); });
test('failure between database insert and next queue can be retried', async () => { const f = fixture(), m = message(f); f.queue.failNextSend = true; await assert.rejects(f.v(m)); assert.equal(f.store.observations.size, 1); await f.v(m); await drain(f); assert.equal((await f.store.reports())[0].observation_count, 1); });
test('duplicate delivery after aggregation is harmless in the test double', async () => { const f = fixture(), m = message(f); await f.v(m); await drain(f); await f.a({ event_id: m.event.event_id }); assert.equal((await f.store.reports())[0].observation_count, 1); });
test('late observations are retained but excluded from current aggregates', async () => { const f = fixture(), m = message(f); m.event.observed_at = new Date(Date.now() - 3600000).toISOString(); await f.v(m); await drain(f); assert.equal(f.store.aggregates.size, 0); assert.equal([...f.store.observations.values()][0].disposition, 'late_review'); });
test('a failed aggregation does not mutate the test double', async () => { const f = fixture(), m = message(f); await f.v(m); await assert.rejects(f.store.aggregate(m.event.event_id, { failBeforeCommit: true })); assert.equal(f.store.aggregates.size, 0); await drain(f); assert.equal(f.store.aggregates.size, 1); });
test('invisible queue deliveries can be redelivered without deleting the original', async () => { const q = new MemoryQueue(); await q.send('x', { id: 1 }); const first = (await q.receive('x', { visibility: 0 }))[0]; const second = (await q.receive('x'))[0]; assert.equal(first.id, second.id); assert.notEqual(first.receipt, second.receipt); await q.remove('x', first.receipt); assert.equal(q.items('x').length, 1); await q.remove('x', second.receipt); assert.equal(q.items('x').length, 0); });
test('HTTP reporting rejects missing credentials and validates filters', async () => {
    const f = fixture(), token = 'a'.repeat(32), api = createApi(f.store, token);
    await new Promise(r => api.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${api.address().port}`;
    try {
        assert.equal((await fetch(url + '/v1/reports?run_id=pipeline')).status, 401);
        assert.equal((await fetch(url + '/v1/reports', { headers: { Authorization: 'Bearer ' + token } })).status, 400);
        assert.equal((await fetch(url + '/v1/reports?run_id=pipeline', { headers: { Authorization: 'Bearer ' + token } })).status, 200);
        assert.equal((await fetch(url + '/v1/reports?run_id=pipeline', { method: 'POST' })).status, 405);
    }
    finally {
        await new Promise(r => api.close(r));
    }
});
test('consumer acknowledges only after a successful handler and retries failure', async () => {
    const { consume } = require('../src/queue/consume'), { setTimeout: wait } = require('node:timers/promises');
    const queue = new MemoryQueue();
    await queue.send('work', { event: 'one' });
    let calls = 0, errors = 0;
    const consumer = consume(queue, 'work', async () => { calls++; if (calls === 1)
        throw new Error('injected'); }, { parallel: 1, visibility: 0.01, onError: () => { errors++; } });
    try {
        for (let i = 0; i < 50 && queue.items('work').length; i++)
            await wait(20);
        assert.equal(queue.items('work').length, 0);
        assert.equal(calls, 2);
        assert.equal(errors, 1);
    }
    finally {
        await consumer.stop();
    }
});
