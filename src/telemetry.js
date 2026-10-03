'use strict';
function log(type, fields = {}) { console.log(JSON.stringify({ time: new Date().toISOString(), type, ...fields })); }
function error(e) { log('error', { code: e.code || e.name || 'Error' }); } // Never print credentials, URIs or raw observations.
class Metrics {
    constructor(service) { this.service = service; this.counts = {}; this.timings = {}; this.timer = setInterval(() => this.flush(), 10000); this.timer.unref(); }
    add(key, n = 1) { this.counts[key] = (this.counts[key] || 0) + n; }
    observe(key, milliseconds) {
        if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
        if (!this.timings[key]) this.timings[key] = [];
        this.timings[key].push(milliseconds);
        if (this.timings[key].length === 100) this.flushTimings();
    }
    flushTimings() {
        const values = this.timings;
        this.timings = {};
        if (!Object.keys(values).length) return;
        log('stage_timings', { _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'BMOAS', Dimensions: [['Service']], Metrics: Object.keys(values).map(Name => ({ Name, Unit: 'Milliseconds' })) }] }, Service: this.service, ...values });
    }
    flush() {
        this.flushTimings();
        const counts = this.counts;
        this.counts = {};
        if (!Object.keys(counts).length)
            return;
        log('metrics', { _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'BMOAS', Dimensions: [['Service']], Metrics: Object.keys(counts).map(Name => ({ Name, Unit: 'Count' })) }] }, Service: this.service, ...counts });
    }
    close() { clearInterval(this.timer); this.flush(); }
}
module.exports = { log, error, Metrics };
