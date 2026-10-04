'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { batchedAggregatorHandler } = require('../src/aggregation-batch');
test('batch handler waits for commit and acknowledges duplicate entries once', async () => {
    let release;
    const committed = new Promise(resolve => { release = resolve; });
    const counts = {};
    const handler = batchedAggregatorHandler({ async aggregateBatch(ids) {
        await committed;
        return new Map(ids.map(id => [id, { duplicate: false }]));
    } }, { add(key) { counts[key] = (counts[key] || 0) + 1; } });
    let settled = false;
    const deliveries = Promise.all(Array.from({ length: 10 }, () => handler({ event_id: 'same' })));
    deliveries.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    release();
    await deliveries;
    assert.deepEqual(counts, { Completed: 1, DuplicateDeliveries: 9 });
    await handler.close();
});
test('failed transaction rejects every delivery so input remains available for retry', async () => {
    const handler = batchedAggregatorHandler({ async aggregateBatch() { throw new Error('database_unavailable'); } }, { add() { assert.fail('No success metric before commit'); } });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => handler({ event_id: String(i) })));
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.message === 'database_unavailable'));
    await handler.close();
});
