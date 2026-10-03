'use strict';
const { bucketFor, hash, problem, percentile } = require('./domain');
// Serial test double, not a substitute for testing MongoDB transactions and write conflicts.
class MemoryStore {
    constructor(registry) { this.reg = registry; this.observations = new Map(); this.aggregates = new Map(); this.members = new Set(); }
    async registry() { return this.reg; }
    async persist(r) { const previous = this.observations.get(r._id); if (previous && previous.payload_hash !== r.payload_hash)
        throw problem('event_id_conflict'); if (!previous)
        this.observations.set(r._id, r); return previous || r; }
    async aggregate(id, { windowSeconds = 60, failBeforeCommit = false } = {}) {
        const r = this.observations.get(id);
        if (!r)
            throw new Error('observation_not_ready');
        if (r.completed_at)
            return { duplicate: true };
        if (failBeforeCommit)
            throw new Error('injected_transaction_failure');
        if (!r.late && r.event.media_source_id !== null) {
            const b = bucketFor(r, windowSeconds);
            const a = this.aggregates.get(b._id) || { ...b, observation_count: 0, participant_count: 0 };
            const member = hash([b._id, r.event.panel_id]);
            a.observation_count++;
            if (!this.members.has(member)) {
                a.participant_count++;
                this.members.add(member);
            }
            this.aggregates.set(b._id, a);
        }
        r.completed_at = new Date();
        r.latency_ms = r.completed_at - r.published_at;
        r.disposition = r.late ? 'late_review' : r.event.media_source_id === null ? 'no_media' : 'counted';
        return { duplicate: false, disposition: r.disposition };
    }
    async reports(filter = {}) { return [...this.aggregates.values()].filter(a => Object.entries(filter).every(([k, v]) => a[k] === v)); }
    async runSummary(runId) { const a = [...this.observations.values()].filter(o => o.run_id === runId), done = a.filter(o => o.completed_at); return { run_id: runId, stored: a.length, completed: done.length, pending: a.length - done.length, p95_processing_ms: percentile(done.map(o => o.latency_ms)) }; }
    async ping() { }
    async close() { }
}
module.exports = { MemoryStore };
