'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SqsQueue } = require('../src/queue/sqs');
const { BatchWriter } = require('../src/queue/batch');
const { MongoStore } = require('../src/store');
const { Metrics } = require('../src/telemetry');
const services = require('../infra/services.json');
const foundation = require('../infra/foundation.json');

function queueFixture(response) {
    const calls = [];
    const client = {
        async send(command) {
            calls.push(command);
            if (response) return response(command);
            return { Successful: command.input.Entries.map(entry => ({ Id: entry.Id })) };
        },
        destroy() {}
    };
    return { calls, queue: new SqsQueue({ client, urls: { checked: 'local-checked', aggregate: 'local-aggregate' }, batching: true }) };
}

test('twenty independent sends and deletes use four requests with exact payloads', async () => {
    const { calls, queue } = queueFixture();
    try {
        await Promise.all(Array.from({ length: 20 }, (_, id) => queue.send('checked', { id })));
        await Promise.all(Array.from({ length: 20 }, (_, id) => queue.remove('checked', 'receipt-' + id)));
        assert.equal(calls.length, 4);
        assert.deepEqual(calls.slice(0, 2).flatMap(call => call.input.Entries.map(e => JSON.parse(e.MessageBody).id)), Array.from({ length: 20 }, (_, i) => i));
        assert.ok(calls.every(call => call.input.Entries.length <= 10));
    } finally { await queue.close(); }
});

test('partial send success resolves only acknowledged entries', async () => {
    const { queue } = queueFixture(() => ({ Successful: [{ Id: '0' }], Failed: [{ Id: '1', Code: 'Throttled' }] }));
    try {
        const results = await Promise.allSettled([queue.send('checked', { id: 1 }), queue.send('checked', { id: 2 }), queue.send('checked', { id: 3 })]);
        assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected', 'rejected']);
        assert.equal(results[1].reason.code, 'Throttled');
        assert.equal(results[2].reason.code, 'missing_batch_acknowledgement');
        assert.equal(results[1].reason.permanent, undefined);
    } finally { await queue.close(); }
});

test('partial delete failure is exposed for safe redelivery', async () => {
    const { queue } = queueFixture(() => ({ Successful: [{ Id: '0' }], Failed: [{ Id: '1', Code: 'ReceiptHandleIsInvalid' }] }));
    try {
        const results = await Promise.allSettled([queue.remove('checked', 'a'), queue.remove('checked', 'b')]);
        assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']);
    } finally { await queue.close(); }
});

test('transport failure rejects every entry without acknowledging any', async () => {
    const { queue } = queueFixture(() => { throw new Error('network'); });
    try {
        const results = await Promise.allSettled([queue.send('checked', { id: 1 }), queue.send('checked', { id: 2 })]);
        assert.ok(results.every(r => r.status === 'rejected'));
    } finally { await queue.close(); }
});

test('shutdown flushes small batches and does not mix queue destinations', async () => {
    const { calls, queue } = queueFixture();
    const pending = [queue.send('checked', { id: 1 }), queue.send('aggregate', { id: 2 })];
    await queue.close();
    await Promise.all(pending);
    assert.deepEqual(calls.map(c => c.input.QueueUrl), ['local-checked', 'local-aggregate']);
    await assert.rejects(queue.send('checked', {}), /queue_closed/);
});

test('small batches finish on their timer and enforce byte limits', async () => {
    let requests = 0;
    const batch = new BatchWriter(async (_, entries) => { requests++; return { Successful: entries.map(e => ({ Id: e.Id })) }; }, { delayMs: 1, maxBytes: 40 });
    await Promise.all([batch.enqueue('q', { text: 'a'.repeat(20) }), batch.enqueue('q', { text: 'b'.repeat(20) })]);
    assert.equal(requests, 2);
    await assert.rejects(batch.enqueue('q', { text: 'a'.repeat(100) }), /too_large/);
    await batch.close();
});

test('fresh observation performs one write and no read', async () => {
    let writes = 0;
    const record = { _id: 'event', payload_hash: 'same' };
    const store = new MongoStore(null, { collection: () => ({ insertOne: async () => { writes++; }, findOne: async () => { throw new Error('unexpected_read'); } }) });
    assert.equal(await store.persist(record), record);
    assert.equal(writes, 1);
});

test('duplicate persistence preserves original timing and rejects conflicting content', async () => {
    const original = { _id: 'event', payload_hash: 'same', published_at: 'original' };
    const store = new MongoStore(null, { collection: () => ({ insertOne: async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); }, findOne: async () => original }) });
    assert.equal(await store.persist({ ...original, published_at: 'retry' }), original);
    await assert.rejects(store.persist({ ...original, payload_hash: 'changed' }), { code: 'event_id_conflict', permanent: true });
});

test('persistence propagates transient database failure', async () => {
    const store = new MongoStore(null, { collection: () => ({ insertOne: async () => { throw new Error('network'); } }) });
    await assert.rejects(store.persist({ _id: 'event' }), /network/);
});

test('raw timing samples retain every value and respect EMF array limits', () => {
    const original = console.log;
    const logs = [];
    console.log = line => logs.push(JSON.parse(line));
    const metrics = new Metrics('validator');
    try {
        for (let i = 0; i < 205; i++) metrics.observe('PersistenceMs', i);
        metrics.close();
        assert.equal(logs.flatMap(r => r.PersistenceMs).length, 205);
        assert.ok(logs.every(r => r.PersistenceMs.length <= 100));
        assert.ok(logs.every(r => r._aws.CloudWatchMetrics[0].Metrics[0].Unit === 'Milliseconds'));
    } finally { console.log = original; }
});

test('all processing stages have bounded scaling and one-period scale-out alarms', () => {
    const r = services.Resources;
    for (const [stage, target, queue] of [['NodeRed', 'NodeRedTarget', 'Raw'], ['Validator', 'ValidatorTarget', 'Checked'], ['Aggregator', 'AggregationTarget', 'Aggregate']]) {
        assert.equal(r[target].Properties.MaxCapacity, 4);
        assert.equal(services.Parameters[r[target].Properties.MinCapacity.Ref].Default, 1);
        for (const kind of ['Cpu', 'Depth', 'Age']) {
            const alarm = r[stage + kind + 'Alarm'];
            assert.equal(alarm.Condition, 'Responsive');
            assert.equal(alarm.Properties.Period, 60);
            assert.equal(alarm.Properties.EvaluationPeriods, 1);
        }
        const urgent = r[stage + 'BacklogPolicy'].Properties.StepScalingPolicyConfiguration;
        assert.equal(urgent.AdjustmentType, 'ExactCapacity');
        assert.equal(urgent.StepAdjustments[0].ScalingAdjustment, 4);
        const dimensions = JSON.stringify(r[stage + 'DepthAlarm'].Properties.Dimensions);
        assert.ok(dimensions.includes(queue + 'QueueArn'));
        assert.ok(Object.values(foundation.Outputs).some(o => JSON.stringify(o.Export).includes(queue + 'QueueArn')));
    }
});


test('stepped workload preserves exact cumulative counts at transitions', () => {
    const { workload } = require('../src/simulator/workload');
    const stepped = workload(require('../config/stepped.json'));
    assert.equal(stepped.total, 180000);
    assert.deepEqual([0, 120000, 240000, 360000, 480000, 600000].map(ms => stepped.target(ms)), [0, 12000, 48000, 168000, 180000, 180000]);
    assert.equal(workload(require('../config/baseline.json')).total, 60000);
    assert.equal(workload(require('../config/reconnect.json')).total, 12000);
});
