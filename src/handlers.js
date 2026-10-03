'use strict';
const { performance } = require('node:perf_hooks');
const { validateObservation } = require('./domain');
function validatorHandler(store, queue, registry, metrics = { add() { } }) {
    return async (message) => {
        const started = performance.now();
        try {
            const record = validateObservation(message, registry);
            const checked = performance.now();
            metrics.observe?.('ValidationCpuMs', checked - started);
            const stored = await store.persist(record);
            const persisted = performance.now();
            metrics.observe?.('PersistenceMs', persisted - checked);
            // Send before acknowledging input. Redelivery resends a reference, even after an earlier insert.
            // This closes the insert->publish crash gap without treating an existing record as "finished".
            await queue.send('aggregate', { schema_version: 1, event_id: stored._id, run_id: stored.run_id });
            metrics.observe?.('ForwardingMs', performance.now() - persisted);
            metrics.observe?.('ValidationHandlerMs', performance.now() - started);
            metrics.add('Validated');
        }
        catch (e) {
            if (!e.permanent)
                throw e;
            await queue.send('rejected', { stage: 'validation', reason: e.code, event_id: message.event?.event_id || null, run_id: message.event?.run_id || null });
            metrics.add('Rejected');
        }
    };
}
function aggregatorHandler(store, metrics = { add() { } }, options = {}) {
    return async (message) => {
        if (typeof message.event_id !== 'string')
            throw new Error('invalid_internal_reference');
        const r = await store.aggregate(message.event_id, options);
        metrics.add(r.duplicate ? 'DuplicateDeliveries' : 'Completed');
    };
}
module.exports = { validatorHandler, aggregatorHandler };
