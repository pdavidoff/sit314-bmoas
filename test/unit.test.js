'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const d = require('../src/domain');
const { registryFor, eventFor, envelope } = require('../src/simulator/model');
const { Spool } = require('../src/simulator/spool');
const data = registryFor(4, 2), now = Date.now();
const make = () => eventFor(data.list[0], 1, 'test-run', now - 1000, now - 500);
function validate(event, transport) { return d.validateObservation({ event, transport: transport || { gateway_id: event.gateway_id, received_at: new Date(now).toISOString() } }, data.registry, now); }
test('valid observation retains separate observation/publication/receipt times', () => { const r = validate(make()); assert.equal(r._id, make().event_id); assert.ok(r.received_at > r.published_at); });
test('raw MQTT bytes decode into the same observation', () => assert.deepEqual(d.decodeEnvelope(envelope(make())).event, make()));
test('malformed JSON is rejected before application validation', () => assert.throws(() => d.decodeEnvelope(envelope('{broken')), e => e.code === 'invalid_json'));
test('oversized observation is rejected', () => assert.throws(() => d.decodeEnvelope({ payload_b64: 'a'.repeat(12001) })));
test('unregistered device cannot supply observations', () => { const e = make(); e.device_id = 'unknown'; assert.throws(() => validate(e), x => x.code === 'unregistered_device'); });
test('gateway identity is checked against transport metadata', () => assert.throws(() => validate(make(), { gateway_id: 'gateway-999', received_at: new Date(now).toISOString() }), x => x.code === 'gateway_mismatch'));
test('participant and region cannot be changed by the device', () => { const e = make(); e.panel_id = 'someone-else'; assert.throws(() => validate(e), x => x.code === 'device_metadata_mismatch'); });
test('unknown media source is rejected', () => { const e = make(); e.media_source_id = 'SRC-999'; assert.throws(() => validate(e), x => x.code === 'unknown_media_source'); });
test('confidence must be a bounded number', () => { const e = make(); e.detection.confidence = 1.1; assert.throws(() => validate(e), x => x.code === 'confidence_range'); });
test('future device time is rejected outside tolerance', () => { const e = make(); e.observed_at = new Date(now + 60000).toISOString(); assert.throws(() => validate(e), x => x.code === 'future_time'); });
test('very old replay is rejected before the deduplication record can expire', () => { const e = make(); e.observed_at = new Date(now - 8 * 86400000).toISOString(); assert.throws(() => validate(e), x => x.code === 'event_too_old'); });
test('late event is preserved and flagged instead of silently reassigned', () => { const e = make(); e.observed_at = new Date(now - 3600000).toISOString(); assert.equal(validate(e).late, true); });
test('unknown top-level fields cannot store audio accidentally', () => { const e = make(); e.audio = 'abc'; assert.throws(() => validate(e), x => x.code === 'unknown_field'); });
test('nested unknown fields are rejected', () => { const e = make(); e.device.raw_audio = 'abc'; assert.throws(() => validate(e), x => x.code === 'device_status'); });
test('no-media observations are explicit rather than invented exposure', () => { const e = make(); e.media_source_id = null; e.detection = { method: 'none', confidence: 0 }; assert.equal(validate(e).event.media_source_id, null); });
test('same event content with a retry time has the same identity hash', () => { const a = make(), b = make(); b.published_at = new Date(now - 100).toISOString(); assert.equal(validate(a).payload_hash, validate(b).payload_hash); });
test('time bucket uses observation time, not arrival time', () => { const r = validate(make()); assert.equal(+d.bucketFor(r, 60).window_start, Math.floor(+r.observed_at / 60000) * 60000); });
test('p95 uses nearest rank and returns null for no samples', () => { assert.equal(d.percentile([]), null); assert.equal(d.percentile(Array.from({ length: 100 }, (_, i) => i + 1)), 95); });
test('registry and observations are deterministic for a fixed run and sequence', () => assert.equal(make().event_id, make().event_id));
test('spool preserves pending records and first publication time across restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmoas-spool-')), file = path.join(dir, 'ledger');
    try {
        let s = new Spool(file);
        const e = { ...make(), published_at: null };
        s.put(e);
        const first = s.prepare(e.event_id, now).published_at;
        s.close();
        s = new Spool(file);
        assert.equal(s.pending.size, 1);
        assert.equal(s.prepare(e.event_id, now + 9999).published_at, first);
        s.ack(e.event_id);
        s.close();
        s = new Spool(file);
        assert.equal(s.pending.size, 0);
        s.close();
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
