'use strict';
const { BatchWriter } = require('./queue/batch');

function batchedAggregatorHandler(store, metrics, options = {}) {
    const writer = new BatchWriter(async (_key, entries) => {
        const outcomes = await store.aggregateBatch(entries.map(entry => entry.eventId), options);
        const seen = new Set();
        for (const entry of entries) {
            const outcome = outcomes.get(entry.eventId);
            if (outcome.duplicate || seen.has(entry.eventId)) {
                metrics.add('DuplicateDeliveries');
            } else {
                metrics.add('Completed');
            }
            seen.add(entry.eventId);
        }
        return { Successful: entries.map(entry => ({ Id: entry.Id })) };
    }, { delayMs: 5 });
    const handler = message => {
        if (typeof message.event_id !== 'string') {
            return Promise.reject(new Error('invalid_internal_reference'));
        }
        return writer.enqueue('aggregate', { eventId: message.event_id });
    };
    handler.close = () => writer.close();
    return handler;
}

module.exports = { batchedAggregatorHandler };
