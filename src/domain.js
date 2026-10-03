'use strict';
const { createHash } = require('node:crypto');
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const ALLOWED = new Set(['schema_version', 'event_id', 'event_type', 'run_id', 'device_id', 'panel_id', 'gateway_id', 'sequence', 'observed_at', 'published_at', 'media_source_id', 'detection', 'device', 'connectivity', 'region']);
const DAY = 86400000;
function stable(x) {
    if (Array.isArray(x))
        return x.map(stable);
    if (x && typeof x === 'object')
        return Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])]));
    return x;
}
function hash(x) { return createHash('sha256').update(JSON.stringify(stable(x))).digest('hex'); }
function iso(x) { return typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(x) && Number.isFinite(Date.parse(x)); }
function onlyKeys(x, keys) { return x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).every(k => keys.includes(k)); }
function problem(code) { const e = new Error(code); e.code = code; e.permanent = true; return e; }
function decodeEnvelope(envelope) {
    if (!envelope || typeof envelope.payload_b64 !== 'string' || envelope.payload_b64.length > 12000)
        throw problem('envelope_size_or_encoding');
    const bytes = Buffer.from(envelope.payload_b64, 'base64');
    if (!bytes.length || bytes.length > 8192)
        throw problem('payload_size');
    let event;
    try {
        event = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        throw problem('invalid_json');
    }
    if (!event || Array.isArray(event) || typeof event !== 'object')
        throw problem('not_an_object');
    if (!Number.isFinite(envelope.received_ms) || !ID.test(envelope.gateway_id || ''))
        throw problem('invalid_transport_metadata');
    return { event, transport: { gateway_id: envelope.gateway_id, received_at: new Date(envelope.received_ms).toISOString() } };
}
function basicChecks(message) {
    const e = message.event;
    if (!e || typeof e !== 'object' || Array.isArray(e))
        throw problem('not_an_object');
    for (const k of ['event_id', 'device_id', 'run_id'])
        if (typeof e[k] !== 'string' || !ID.test(e[k]))
            throw problem(`invalid_${k}`);
    if (e.event_type !== 'media_observation' || typeof e.observed_at !== 'string')
        throw problem('invalid_envelope_fields');
    return message;
}
function validateObservation(message, registry, now = Date.now(), options = {}) {
    basicChecks(message);
    const e = message.event;
    if (Object.keys(e).some(k => !ALLOWED.has(k)))
        throw problem('unknown_field');
    if (e.schema_version !== 1)
        throw problem('schema_version');
    for (const k of ['panel_id', 'gateway_id'])
        if (typeof e[k] !== 'string' || !ID.test(e[k]))
            throw problem(`invalid_${k}`);
    if (!Number.isSafeInteger(e.sequence) || e.sequence < 1)
        throw problem('invalid_sequence');
    for (const k of ['observed_at', 'published_at'])
        if (!iso(e[k]))
            throw problem(`invalid_${k}`);
    const observed = Date.parse(e.observed_at), published = Date.parse(e.published_at), received = Date.parse(message.transport?.received_at);
    if (!Number.isFinite(received))
        throw problem('invalid_received_at');
    if (observed > now + 30000 || published > now + 30000 || received > now + 30000 || observed > published + 30000)
        throw problem('future_time');
    if (now - observed > (options.maxAgeMs ?? 7 * DAY))
        throw problem('event_too_old');
    if (e.gateway_id !== message.transport.gateway_id)
        throw problem('gateway_mismatch');
    const d = registry.devices.get(e.device_id);
    if (!d || !d.enabled)
        throw problem('unregistered_device');
    if (d.gateway_id !== e.gateway_id || d.panel_id !== e.panel_id || d.region !== e.region)
        throw problem('device_metadata_mismatch');
    if (!onlyKeys(e.detection, ['method', 'confidence']) || !['simulated', 'none'].includes(e.detection.method))
        throw problem('detection_method');
    if (typeof e.detection.confidence !== 'number' || !Number.isFinite(e.detection.confidence) || e.detection.confidence < 0 || e.detection.confidence > 1)
        throw problem('confidence_range');
    if (e.media_source_id !== null && !registry.sources.has(e.media_source_id))
        throw problem('unknown_media_source');
    if ((e.media_source_id === null) !== (e.detection.method === 'none'))
        throw problem('inconsistent_detection');
    if (!onlyKeys(e.device, ['battery_percent', 'wear_state']) || !Number.isInteger(e.device.battery_percent) || e.device.battery_percent < 0 || e.device.battery_percent > 100 || !['active', 'inactive'].includes(e.device.wear_state))
        throw problem('device_status');
    if (!onlyKeys(e.connectivity, ['mode']) || !['home_wifi', 'ble_gateway'].includes(e.connectivity.mode))
        throw problem('connectivity_mode');
    const content = { ...e };
    delete content.published_at; // Retransmission time does not change event identity.
    return { _id: e.event_id, event: e, payload_hash: hash(content), received_at: new Date(received), observed_at: new Date(observed), published_at: new Date(published), run_id: e.run_id,
        late: received - observed > (options.lateMs ?? 1800000), expires_at: new Date(now + 30 * DAY) };
}
function bucketFor(record, windowSeconds = 60) {
    const start = new Date(Math.floor(+record.observed_at / (windowSeconds * 1000)) * windowSeconds * 1000);
    const e = record.event;
    const key = { run_id: e.run_id, source_id: e.media_source_id, region: e.region, window_start: start.toISOString(), window_seconds: windowSeconds };
    return { _id: hash(key), ...key, window_start: start };
}
function percentile(values, p = 0.95) {
    if (!values.length)
        return null;
    const a = [...values].sort((x, y) => x - y);
    return a[Math.max(0, Math.ceil(a.length * p) - 1)];
}
module.exports = { ID, hash, problem, iso, decodeEnvelope, basicChecks, validateObservation, bucketFor, percentile };
