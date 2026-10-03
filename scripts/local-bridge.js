'use strict';
const { getQueue } = require('../src/queue/sqs');
// Local equivalent of the IoT rule. This is not deployed to AWS.
async function main() {
    const mqtt = require('mqtt'), q = getQueue();
    const c = mqtt.connect(process.env.MQTT_URL || 'mqtt://127.0.0.1:1883', { clientId: 'bmoas-local-rule', clean: false, protocolVersion: 4 });
    c.on('error', () => console.error('MQTT bridge connection error'));
    c.handleMessage = function (packet, done) { const gateway = packet.topic.split('/')[2]; q.send('raw', { payload_b64: packet.payload.toString('base64'), gateway_id: gateway, received_ms: Date.now() }).then(() => done(), done); };
    c.on('connect', () => c.subscribe('bmoas/gateways/+/observations', { qos: 1 }));
    process.once('SIGTERM', () => c.end());
    process.once('SIGINT', () => c.end());
}
main().catch(() => { console.error('Local bridge startup failed'); process.exit(1); });
