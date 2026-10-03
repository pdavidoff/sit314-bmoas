'use strict';

// Each caller waits for its own acknowledgement, including partial batch failures.
class BatchWriter {
    constructor(dispatch, { delayMs = 5, maxBytes = 240000 } = {}) {
        this.dispatch = dispatch;
        this.delayMs = delayMs;
        this.maxBytes = maxBytes;
        this.groups = new Map();
        this.active = new Set();
        this.closed = false;
    }

    enqueue(key, entry) {
        if (this.closed) return Promise.reject(new Error('queue_closed'));
        const bytes = Buffer.byteLength(JSON.stringify(entry));
        if (bytes > this.maxBytes) return Promise.reject(new Error('batch_entry_too_large'));
        let group = this.groups.get(key);
        if (group && group.bytes + bytes > this.maxBytes) {
            this.flush(key);
            group = undefined;
        }
        if (!group) {
            group = { entries: [], bytes: 0, timer: setTimeout(() => this.flush(key), this.delayMs) };
            this.groups.set(key, group);
        }
        const promise = new Promise((resolve, reject) => {
            group.entries.push({ entry, resolve, reject });
            group.bytes += bytes;
        });
        if (group.entries.length === 10) this.flush(key);
        return promise;
    }

    flush(key) {
        const group = this.groups.get(key);
        if (!group) return;
        clearTimeout(group.timer);
        this.groups.delete(key);
        const operation = this.deliver(key, group.entries);
        this.active.add(operation);
        operation.finally(() => this.active.delete(operation));
    }

    async deliver(key, items) {
        try {
            const entries = items.map((item, index) => ({ ...item.entry, Id: String(index) }));
            const response = await this.dispatch(key, entries);
            const successful = new Set((response.Successful || []).map(item => item.Id));
            const failed = new Map((response.Failed || []).map(item => [item.Id, item]));
            items.forEach((item, index) => {
                const id = String(index);
                if (successful.has(id) && !failed.has(id)) {
                    item.resolve();
                } else {
                    const error = new Error('queue_batch_entry_failed');
                    error.code = failed.get(id)?.Code || 'missing_batch_acknowledgement';
                    // Queue failures remain retryable. Never quarantine a valid observation here.
                    item.reject(error);
                }
            });
        } catch (error) {
            for (const item of items) item.reject(error);
        }
    }

    async close() {
        this.closed = true;
        for (const key of this.groups.keys()) this.flush(key);
        await Promise.all(this.active);
    }
}

module.exports = { BatchWriter };
