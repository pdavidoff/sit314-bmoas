'use strict';
const { bucketFor, hash, problem, percentile } = require('./domain');
class MongoStore {
    constructor(client, db) { this.client = client; this.db = db; }
    static async open(uri = process.env.MONGODB_URI, name = process.env.MONGODB_DATABASE || 'bmoas') {
        if (!uri)
            throw new Error('Set MONGODB_URI');
        const { MongoClient } = require('mongodb');
        const c = new MongoClient(uri, { maxPoolSize: 20, minPoolSize: 0, serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 30000, writeConcern: { w: 'majority' } });
        await c.connect();
        return new MongoStore(c, c.db(name));
    }
    async initialise(devices, sources) {
        const d = this.db;
        await d.collection('observations').createIndex({ run_id: 1, confirmed_at: 1, _id: 1 });
        await d.collection('observations').createIndex({ observed_at: 1 });
        await d.collection('observations').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
        await d.collection('aggregates').createIndex({ run_id: 1, window_start: 1, source_id: 1, region: 1 });
        await d.collection('memberships').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
        await d.collection('aggregates').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
        // Create a unique index explicitly matching the agreed event_id contract as well as _id.
        await d.collection('observations').createIndex({ 'event.event_id': 1 }, { unique: true });
        if (devices.length)
            await d.collection('devices').bulkWrite(devices.map(v => ({ updateOne: { filter: { _id: v._id }, update: { $set: v }, upsert: true } })));
        if (sources.length)
            await d.collection('media_sources').bulkWrite(sources.map(v => ({ updateOne: { filter: { _id: v._id }, update: { $set: v }, upsert: true } })));
    }
    async registry() { return { devices: new Map((await this.db.collection('devices').find({}).toArray()).map(d => [d._id, d])), sources: new Set((await this.db.collection('media_sources').find({ enabled: true }).toArray()).map(s => s._id)) }; }
    async persist(record) {
        try {
            // A new event needs only one majority-acknowledged write.
            await this.db.collection('observations').insertOne(record);
            return record;
        }
        catch (e) {
            if (e.code !== 11000)
                throw e;
        }
        const stored = await this.db.collection('observations').findOne({ _id: record._id });
        if (!stored || stored.payload_hash !== record.payload_hash)
            throw problem('event_id_conflict');
        return stored;
    }
    async aggregate(id, options = {}) {
        for (let attempt = 0;; attempt++) {
            try {
                return await this.aggregateOnce(id, options);
            }
            catch (e) {
                if (e.code !== 11000 || attempt >= 7)
                    throw e;
                // Concurrent first upserts may raise duplicate-key errors instead of a transient label.
                await new Promise(resolve => setTimeout(resolve, 5 + attempt * 10));
            }
        }
    }
    async aggregateOnce(id, { windowSeconds = 60, failBeforeCommit = false } = {}) {
        const session = this.client.startSession();
        try {
            const result = await session.withTransaction(async () => {
                const c = this.db.collection('observations'), r = await c.findOne({ _id: id }, { session });
                if (!r)
                    throw new Error('observation_not_ready');
                if (r.completed_at)
                    return { duplicate: true };
                const now = new Date();
                let bucket = null;
                if (!r.late && r.event.media_source_id !== null) {
                    bucket = bucketFor(r, windowSeconds);
                    const membership = hash([bucket._id, r.event.panel_id]);
                    const m = await this.db.collection('memberships').updateOne({ _id: membership }, { $setOnInsert: { bucket_id: bucket._id, panel_id: r.event.panel_id, expires_at: r.expires_at } }, { upsert: true, session });
                    await this.db.collection('aggregates').updateOne({ _id: bucket._id }, { $setOnInsert: { ...bucket, expires_at: r.expires_at }, $inc: { observation_count: 1, participant_count: m.upsertedCount ? 1 : 0 }, $set: { updated_at: now } }, { upsert: true, session });
                }
                if (failBeforeCommit)
                    throw new Error('injected_transaction_failure');
                await c.updateOne({ _id: id }, { $set: { completed_at: now, disposition: r.late ? 'late_review' : r.event.media_source_id === null ? 'no_media' : 'counted', bucket_id: bucket ? bucket._id : null, latency_ms: now - r.published_at } }, { session });
                return { duplicate: false, disposition: r.late ? 'late_review' : r.event.media_source_id === null ? 'no_media' : 'counted' };
            }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000 });
            // We now know the transaction committed. Record a conservative latency that includes
            // the acknowledgement of that commit. A retry fills this field if a crash interrupted it.
            const r = await this.db.collection('observations').findOne({ _id: id }, { projection: { published_at: 1, confirmed_at: 1 } });
            const confirmed = new Date();
            await this.db.collection('observations').updateOne({ _id: id, confirmed_at: { $exists: false } }, { $set: { confirmed_at: confirmed, processing_latency_ms: confirmed - r.published_at } });
            return result;
        }
        finally {
            await session.endSession();
        }
    }
    async reports(filter = {}) { return this.db.collection('aggregates').find(filter).sort({ window_start: 1, _id: 1 }).limit(500).toArray(); }
    async runSummary(runId) {
        const c = this.db.collection('observations');
        const filter = { run_id: runId };
        const n = await c.countDocuments(filter);
        let completed = 0, late = 0, negatives = 0, clockAnomalies = 0;
        const latencies = [];
        // confirmed_at is written only after the aggregate transaction has acknowledged its commit.
        for await (const r of c.find(filter, { projection: { confirmed_at: 1, processing_latency_ms: 1, disposition: 1 } })) {
            if (r.confirmed_at) {
                completed++;
                if (r.processing_latency_ms >= 0)
                    latencies.push(r.processing_latency_ms);
                else
                    clockAnomalies++;
                if (r.disposition === 'late_review')
                    late++;
                if (r.disposition === 'no_media')
                    negatives++;
            }
        }
        return { run_id: runId, stored: n, completed, pending: n - completed, late_review: late, no_media: negatives, clock_anomalies: clockAnomalies, p95_processing_ms: percentile(latencies), timing_note: 'first MQTT publication attempt to application acknowledgement of aggregate commit; offline storage time excluded' };
    }
    async ping() { await this.db.command({ ping: 1 }); }
    async close() { await this.client.close(); }
}
module.exports = { MongoStore };
