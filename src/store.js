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
    async aggregateBatch(ids, options = {}) {
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
            throw new Error('invalid_aggregation_batch');
        }
        if (ids.some(id => typeof id !== 'string')) {
            throw new Error('invalid_internal_reference');
        }
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.aggregateBatchOnce([...new Set(ids)], options);
            } catch (error) {
                if (error.code !== 11000 || attempt >= 7) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 5 + attempt * 10));
            }
        }
    }

    async aggregateBatchOnce(ids, { windowSeconds = 60, failBeforeCommit = false, shards = 1 } = {}) {
        const session = this.client.startSession();
        try {
            const result = await session.withTransaction(async () => {
                const observations = this.db.collection('observations');
                const records = await observations.find({ _id: { $in: ids } }, { session }).toArray();
                if (records.length !== ids.length) {
                    throw new Error('observation_not_ready');
                }
                const outcomes = new Map();
                const buckets = new Map();
                const memberships = new Map();
                const updates = [];
                const now = new Date();
                for (const record of records) {
                    if (record.completed_at) {
                        outcomes.set(record._id, { duplicate: true });
                        continue;
                    }
                    let disposition = 'counted';
                    let bucketId = null;
                    if (record.late) {
                        disposition = 'late_review';
                    } else if (record.event.media_source_id === null) {
                        disposition = 'no_media';
                    } else {
                        const bucket = bucketFor(record, windowSeconds);
                        bucketId = bucket._id;
                        if (!Number.isSafeInteger(shards) || shards < 1 || shards > 256) {
                            throw new Error('invalid_aggregation_shards');
                        }
                        let storageId = bucketId;
                        if (shards > 1) {
                            const shard = parseInt(hash(record.event.panel_id).slice(0, 8), 16) % shards;
                            storageId = hash([bucketId, shard]);
                            bucket.logical_bucket_id = bucketId;
                            bucket.shard = shard;
                            bucket._id = storageId;
                        }
                        if (!buckets.has(storageId)) {
                            buckets.set(storageId, { bucket, expiresAt: record.expires_at, observations: 0, participants: 0 });
                        }
                        buckets.get(storageId).observations++;
                        const membershipId = hash([bucketId, record.event.panel_id]);
                        if (!memberships.has(membershipId)) {
                            memberships.set(membershipId, { bucketId, storageId, panelId: record.event.panel_id, expiresAt: record.expires_at });
                        }
                    }
                    updates.push({ updateOne: {
                        filter: { _id: record._id },
                        update: { $set: { completed_at: now, disposition, bucket_id: bucketId, latency_ms: now - record.published_at } }
                    } });
                    outcomes.set(record._id, { duplicate: false, disposition });
                }
                // One membership write per distinct person and bucket in this batch.
                // The transaction makes concurrent batches retry before counts can diverge.
                const memberEntries = [...memberships.entries()];
                if (memberEntries.length) {
                    const writes = memberEntries.map(([id, member]) => ({ updateOne: {
                        filter: { _id: id },
                        update: { $setOnInsert: { bucket_id: member.bucketId, panel_id: member.panelId, expires_at: member.expiresAt } },
                        upsert: true
                    } }));
                    const inserted = await this.db.collection('memberships').bulkWrite(writes, { session });
                    for (const index of Object.keys(inserted.upsertedIds)) {
                        const member = memberEntries[Number(index)][1];
                        buckets.get(member.storageId).participants++;
                    }
                }
                if (buckets.size) {
                    const writes = [...buckets.values()].map(group => ({ updateOne: {
                        filter: { _id: group.bucket._id },
                        update: {
                            $setOnInsert: { ...group.bucket, expires_at: group.expiresAt },
                            $inc: { observation_count: group.observations, participant_count: group.participants },
                            $set: { updated_at: now }
                        },
                        upsert: true
                    } }));
                    await this.db.collection('aggregates').bulkWrite(writes, { session });
                }
                if (updates.length) {
                    await observations.bulkWrite(updates, { session });
                }
                if (failBeforeCommit) {
                    throw new Error('injected_transaction_failure');
                }
                return outcomes;
            }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000 });
            // Confirmation is written only after the whole transaction commits.
            // Redelivery repairs an interrupted confirmation without increasing ratings.
            const confirmed = new Date();
            await this.db.collection('observations').updateMany(
                { _id: { $in: ids }, confirmed_at: { $exists: false } },
                [{ $set: { confirmed_at: confirmed, processing_latency_ms: { $subtract: [confirmed, '$published_at'] } } }]
            );
            return result;
        } finally {
            await session.endSession();
        }
    }
    async reportRows(filter = {}, limit = 0) {
        const pipeline = [
            { $match: filter },
            { $group: {
                _id: { $ifNull: ['$logical_bucket_id', '$_id'] },
                record: { $first: '$$ROOT' },
                observation_count: { $sum: '$observation_count' },
                participant_count: { $sum: '$participant_count' },
                updated_at: { $max: '$updated_at' }
            } },
            { $replaceRoot: { newRoot: { $mergeObjects: ['$record', {
                _id: '$_id', observation_count: '$observation_count',
                participant_count: '$participant_count', updated_at: '$updated_at'
            }] } } },
            { $unset: ['logical_bucket_id', 'shard'] },
            { $sort: { window_start: 1, _id: 1 } }
        ];
        if (limit > 0) pipeline.push({ $limit: limit });
        return this.db.collection('aggregates').aggregate(pipeline).toArray();
    }
    async reports(filter = {}) { return this.reportRows(filter, 500); }
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
