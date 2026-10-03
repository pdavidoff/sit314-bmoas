'use strict';
const fs = require('node:fs'), path = require('node:path');
// Append-only ledger survives process restarts. Default fsync on every 100 writes and close;
// sudden power-loss durability is bounded by that interval and is not claimed as lossless.
class Spool {
    constructor(file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.file = file;
        this.pending = new Map();
        this.enqueued = 0;
        this.acked = 0;
        this.writes = 0;
        if (fs.existsSync(file)) {
            const lines = fs.readFileSync(file, 'utf8').split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (!lines[i])
                    continue;
                let r;
                try {
                    r = JSON.parse(lines[i]);
                }
                catch {
                    throw new Error(`Spool has an incomplete record at line ${i + 1}; preserve and repair it before replay`);
                }
                if (r.op === 'put') {
                    this.pending.set(r.event.event_id, r.event);
                    this.enqueued++;
                }
                else if (r.op === 'publish') {
                    const event = this.pending.get(r.id);
                    if (event)
                        event.published_at = r.published_at;
                }
                else if (r.op === 'ack') {
                    this.pending.delete(r.id);
                    this.acked++;
                }
            }
        }
        this.fd = fs.openSync(file, 'a', 0o600);
    }
    append(r) { fs.writeSync(this.fd, JSON.stringify(r) + '\n'); if (++this.writes % 100 === 0)
        fs.fsyncSync(this.fd); }
    put(event) { if (this.pending.has(event.event_id))
        throw new Error('duplicate_spool_id'); this.append({ op: 'put', event }); this.pending.set(event.event_id, event); this.enqueued++; }
    prepare(id, now = Date.now()) { const event = this.pending.get(id); if (!event)
        throw new Error('Missing spooled event'); if (!event.published_at) {
        event.published_at = new Date(now).toISOString();
        this.append({ op: 'publish', id, published_at: event.published_at });
    } return event; }
    ack(id) { if (!this.pending.has(id))
        return; this.append({ op: 'ack', id }); this.pending.delete(id); this.acked++; }
    close() { fs.fsyncSync(this.fd); fs.closeSync(this.fd); }
}
module.exports = { Spool };
