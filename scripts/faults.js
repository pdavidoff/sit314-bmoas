'use strict';
// Publish a small, clearly labelled negative-test dataset. It is separate from load experiments.
const fs = require('node:fs'), { registryFor, eventFor } = require('../src/simulator/model');
async function main() {
    const mqtt = require('mqtt');
    const { list } = registryFor(Number(process.env.DEVICE_COUNT || 10000), Number(process.env.GATEWAY_COUNT || 20));
    const device = list[0], id = device.gateway_id, run = 'faults-' + Date.now(), now = Date.now();
    const tls = process.env.MQTT_URL?.startsWith('mqtts://');
    let options = {};
    if (tls) {
        const c = JSON.parse(fs.readFileSync(process.env.GATEWAY_CONFIG, 'utf8'))[id];
        options = { cert: fs.readFileSync(c.cert), key: fs.readFileSync(c.key), ca: fs.readFileSync(c.ca), rejectUnauthorized: true };
    }
    const client = await mqtt.connectAsync(process.env.MQTT_URL || 'mqtt://127.0.0.1:1883', { clientId: id, protocolVersion: 4, ...options });
    client.on('error', () => { });
    try {
        const valid = eventFor(device, 1, run, now - 1000, now);
        const late = eventFor(device, 2, run, now - 3600000, now);
        const wrong = { ...eventFor(device, 3, run, now), panel_id: 'not-registered-to-this-device' };
        for (const payload of [JSON.stringify(valid), JSON.stringify(valid), JSON.stringify(late), JSON.stringify(wrong), '{invalid-json'])
            await client.publishAsync(`${process.env.MQTT_TOPIC_PREFIX || 'bmoas'}/gateways/${id}/observations`, payload, { qos: 1, retain: false });
        console.log(JSON.stringify({ run_id: run, sent: 5, expected: { stored_unique: 2, counted_observations: 1, late_review: 1, quarantined: 2 }, note: 'Stop the ordinary simulator first: MQTT client IDs must be unique while connected.' }, null, 2));
    }
    finally {
        await client.endAsync(true);
    }
}
main().catch(e => { console.error(e.code || e.message); process.exit(1); });
