'use strict';
const { hash } = require('../domain');
function registryFor(devices = 10, gateways = 1) {
    const list = Array.from({ length: devices }, (_, i) => ({ _id: `meter-${String(i + 1).padStart(6, '0')}`, panel_id: `panel-${String(i + 1).padStart(6, '0')}`, gateway_id: `gateway-${String(i % gateways + 1).padStart(3, '0')}`, region: ['ACT', 'NSW', 'VIC'][i % 3], enabled: true }));
    const sources = Array.from({ length: 6 }, (_, i) => ({ _id: `SRC-${String(i + 1).padStart(3, '0')}`, name: `Simulated ${i < 3 ? 'radio' : 'television'} ${i + 1}`, enabled: true }));
    return { list, sources, registry: { devices: new Map(list.map(d => [d._id, d])), sources: new Set(sources.map(s => s._id)) } };
}
function eventFor(device, sequence, runId, observedAt, publishedAt = observedAt) {
    const number = Number(device._id.split('-')[1]);
    const source = (Math.floor(sequence / 6) + number) % 7;
    return { schema_version: 1, event_id: hash([runId, device._id, sequence]), event_type: 'media_observation', run_id: runId, device_id: device._id, panel_id: device.panel_id, gateway_id: device.gateway_id, sequence,
        observed_at: new Date(observedAt).toISOString(), published_at: new Date(publishedAt).toISOString(), media_source_id: source === 6 ? null : `SRC-${String(source + 1).padStart(3, '0')}`,
        detection: { method: source === 6 ? 'none' : 'simulated', confidence: source === 6 ? 0 : 0.96 }, device: { battery_percent: 75, wear_state: 'active' }, connectivity: { mode: number % 2 ? 'home_wifi' : 'ble_gateway' }, region: device.region };
}
function envelope(event) { return { payload_b64: Buffer.from(typeof event === 'string' ? event : JSON.stringify(event)).toString('base64'), gateway_id: typeof event === 'object' ? event.gateway_id : 'gateway-001', received_ms: Date.now() }; }
module.exports = { registryFor, eventFor, envelope };
