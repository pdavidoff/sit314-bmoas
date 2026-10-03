'use strict';
const { randomUUID } = require('node:crypto');
// TEST DOUBLE ONLY. This is not evidence that SQS was deployed or exercised.
class MemoryQueue {
    constructor() { this.queues = new Map(); this.failNextSend = false; }
    items(n) { if (!this.queues.has(n))
        this.queues.set(n, []); return this.queues.get(n); }
    async send(n, data) { if (this.failNextSend) {
        this.failNextSend = false;
        throw new Error('injected_send_failure');
    } this.items(n).push({ id: randomUUID(), body: JSON.stringify(data), visible: 0, attempt: 0, receipt: null }); }
    async receive(n, { max = 10, visibility = 60 } = {}) { return this.items(n).filter(m => m.visible <= Date.now()).slice(0, max).map(m => { m.visible = Date.now() + visibility * 1000; m.attempt++; m.receipt = randomUUID(); return { id: m.id, body: m.body, receipt: m.receipt, attempt: m.attempt }; }); }
    async remove(n, receipt) { const a = this.items(n), i = a.findIndex(m => m.receipt === receipt); if (i >= 0)
        a.splice(i, 1); }
    async extend(n, receipt, seconds) { const m = this.items(n).find(m => m.receipt === receipt); if (m)
        m.visible = Date.now() + seconds * 1000; }
    async stats(n) { return { visible: this.items(n).filter(m => m.visible <= Date.now()).length, in_flight: this.items(n).filter(m => m.visible > Date.now()).length }; }
    async close() { }
}
module.exports = { MemoryQueue };
