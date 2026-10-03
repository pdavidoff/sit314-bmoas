'use strict';
const fs = require('node:fs'), path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { parseArgs } = require('node:util');
const { registryFor, eventFor } = require('./model');
const { workload } = require('./workload');
const { Spool } = require('./spool');
async function main() {
    const { values } = parseArgs({ options: { profile: { type: 'string', default: 'smoke' }, run: { type: 'string' }, 'confirm-load': { type: 'boolean', default: false }, resume: { type: 'boolean', default: false } } });
    if (!['smoke', 'baseline', 'scale', 'reconnect', 'stepped'].includes(values.profile))
        throw new Error('Unknown profile');
    const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../config/${values.profile}.json`), 'utf8'));
    // Registry assignment MUST match init-db: a profile selects a subset, not a different identity mapping.
    const registry = registryFor(Number(process.env.DEVICE_COUNT || 10000), Number(process.env.GATEWAY_COUNT || 20));
    const devices = registry.list.slice(0, cfg.devices);
    if (devices.length !== cfg.devices)
        throw new Error('Not enough registered devices');
    const ids = [...new Set(devices.map(d => d.gateway_id))];
    const run = values.run || `run-${Date.now()}`;
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(run))
        throw new Error('Invalid run id');
    const schedule = workload(cfg);
    const expected = schedule.total + cfg.burst_events;
    if (expected > 2000 && !values['confirm-load'])
        throw new Error('This is a large experiment. Review costs and use --confirm-load.');
    const dir = path.resolve('runs', run);
    fs.mkdirSync(dir, { recursive: true });
    const ledger = path.join(dir, 'spool.ndjson');
    if (fs.existsSync(ledger) && !values.resume)
        throw new Error('Run already exists; use --resume or a new --run');
    const spool = new Spool(ledger);
    const credentials = process.env.GATEWAY_CONFIG ? JSON.parse(fs.readFileSync(process.env.GATEWAY_CONFIG, 'utf8')) : {};
    const mqtt = require('mqtt'), clients = new Map(), inFlight = new Map(), perGateway = new Map();
    let stop = false, ledgerOpen = true;
    process.once('SIGINT', () => { stop = true; });
    try {
        for (const id of ids) {
            const config = credentials[id];
            const tls = process.env.MQTT_URL?.startsWith('mqtts://');
            if (tls && !config)
                throw new Error(`Missing certificate configuration for ${id}`);
            const client = await mqtt.connectAsync(process.env.MQTT_URL || 'mqtt://127.0.0.1:1883', { clientId: id, protocolVersion: 4, clean: true, connectTimeout: 10000, keepalive: 60, reconnectPeriod: 2000,
                ...(tls ? { rejectUnauthorized: true, ca: fs.readFileSync(config.ca), cert: fs.readFileSync(config.cert), key: fs.readFileSync(config.key) } : {}) });
            client.on('error', () => { });
            clients.set(id, client);
            await wait(75);
        }
        const manifest = { run_id: run, profile: values.profile, settings: cfg, registry_gateways: ids.length, expected_unique: expected, started_at: new Date().toISOString(), status: 'running', resumed: values.resume, simulation: 'logical devices across MQTT gateways; no BLE radio or watermark detection' };
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
        // On resume only replay remaining records. Never create a second dataset under an existing run id.
        const start = Date.now(), seq = new Map(devices.map(d => [d._id, 0]));
        let made = 0;
        const deadline = start + schedule.durationMs;
        const lastSent = new Map();
        let lastManifest = 0;
        if (!values.resume) {
            for (let i = 0; i < cfg.burst_events; i++) {
                const d = devices[i % devices.length], s = seq.get(d._id) + 1;
                seq.set(d._id, s);
                spool.put({ ...eventFor(d, s, run, start - 500000 + Math.floor(i / devices.length) * 10000, start), published_at: null });
                made++;
            }
        }
        while (!stop) {
            const now = Date.now();
            if (now - lastManifest >= 1000) {
                manifest.generated_unique = spool.enqueued;
                manifest.mqtt_acknowledged = spool.acked;
                manifest.pending_on_disk = spool.pending.size;
                fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
                lastManifest = now;
            }
            if (!values.resume && now < deadline) {
                const normalTarget = schedule.target(now - start);
                while (made - cfg.burst_events < normalTarget) {
                    const d = devices[(made - cfg.burst_events) % devices.length], s = seq.get(d._id) + 1;
                    seq.set(d._id, s);
                    spool.put({ ...eventFor(d, s, run, now, now), published_at: null });
                    made++;
                }
            }
            if (!values.resume && now >= deadline && made < expected) {
                while (made < expected) {
                    const d = devices[(made - cfg.burst_events) % devices.length], s = seq.get(d._id) + 1;
                    seq.set(d._id, s);
                    spool.put({ ...eventFor(d, s, run, deadline, now), published_at: null });
                    made++;
                }
            }
            const eligible = new Set(ids.filter(id => now - (lastSent.get(id) || 0) >= 20 && (perGateway.get(id) || 0) < 32));
            const used = new Set();
            for (const e of spool.pending.values()) {
                if (!eligible.size || used.size === eligible.size)
                    break;
                if (inFlight.has(e.event_id) || used.has(e.gateway_id) || !eligible.has(e.gateway_id))
                    continue;
                const client = clients.get(e.gateway_id);
                if (!client?.connected)
                    continue;
                used.add(e.gateway_id);
                lastSent.set(e.gateway_id, now);
                spool.prepare(e.event_id, now);
                // No retained MQTT events. QoS1 acknowledges the broker, not completion of aggregation.
                perGateway.set(e.gateway_id, (perGateway.get(e.gateway_id) || 0) + 1);
                const entry = { started: now };
                inFlight.set(e.event_id, entry);
                entry.promise = client.publishAsync(`${process.env.MQTT_TOPIC_PREFIX || 'bmoas'}/gateways/${e.gateway_id}/observations`, JSON.stringify(e), { qos: 1, retain: false })
                    .then(() => { if (ledgerOpen)
                    spool.ack(e.event_id); })
                    .catch(() => { manifest.publication_errors = (manifest.publication_errors || 0) + 1; })
                    .finally(() => { inFlight.delete(e.event_id); perGateway.set(e.gateway_id, (perGateway.get(e.gateway_id) || 1) - 1); });
            }
            if ([...inFlight.values()].some(x => Date.now() - x.started > 15000))
                throw new Error('MQTT acknowledgement timeout; pending events remain in the spool');
            if ((values.resume || Date.now() >= deadline) && spool.pending.size === 0 && inFlight.size === 0)
                break;
            await wait(5);
        }
        manifest.finished_at = new Date().toISOString();
        manifest.generated_unique = spool.enqueued;
        manifest.mqtt_acknowledged = spool.acked;
        manifest.pending_on_disk = spool.pending.size;
        manifest.status = stop ? 'interrupted' : 'published';
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
        console.log(JSON.stringify(manifest, null, 2));
    }
    finally {
        ledgerOpen = false;
        for (const c of clients.values())
            await c.endAsync(true);
        spool.close();
    }
}
main().catch(e => { console.error(e.code || e.message); process.exit(1); });
