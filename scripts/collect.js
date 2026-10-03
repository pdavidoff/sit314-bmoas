'use strict';
const fs = require('node:fs'), path = require('node:path'), { parseArgs } = require('node:util'), { execFileSync } = require('node:child_process'), { setTimeout: wait } = require('node:timers/promises');
const { MongoStore } = require('../src/store'), { getQueue } = require('../src/queue/sqs'), { percentile, ID } = require('../src/domain');
async function main() {
    const { values } = parseArgs({ options: { run: { type: 'string' }, seconds: { type: 'string', default: '180' }, aws: { type: 'boolean', default: false }, cluster: { type: 'string' }, service: { type: 'string' }, services: { type: 'string' } } });
    if (!values.run || !ID.test(values.run))
        throw new Error('Supply --run with a valid run id');
    const seconds = Number(values.seconds);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 7200)
        throw new Error('seconds must be 1..7200');
    const dir = path.resolve('runs', values.run);
    fs.mkdirSync(dir, { recursive: true });
    const samplesFile = path.join(dir, 'samples.ndjson');
    if (fs.existsSync(samplesFile))
        throw new Error('Evidence already exists for this run; preserve it and use a new run id for another experiment');
    const store = await MongoStore.open(), queue = getQueue(), start = Date.now(), latencies = [];
    let after = new Date(0), afterId = '', completed = 0, clockAnomalies = 0, previous = 0, previousTime = start;
    function aws(...args) { return JSON.parse(execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8', timeout: 15000 })); }
    try {
        if (values.aws) {
            if (!values.cluster || !values.service)
                throw new Error('Supply --cluster and --service for AWS collection');
            const base = ['--service-namespace', 'ecs', '--resource-id', `service/${values.cluster}/${values.service}`];
            fs.writeFileSync(path.join(dir, 'scaling-policy-before.json'), JSON.stringify(aws('application-autoscaling', 'describe-scaling-policies', ...base), null, 2));
            fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify(aws('sts', 'get-caller-identity'), null, 2));
        }
        while (Date.now() - start < seconds * 1000) {
            const cursor = store.db.collection('observations').find({ run_id: values.run, confirmed_at: { $exists: true }, $or: [{ confirmed_at: { $gt: after } }, { confirmed_at: after, _id: { $gt: afterId } }] }, { projection: { _id: 1, confirmed_at: 1, processing_latency_ms: 1 } }).sort({ confirmed_at: 1, _id: 1 });
            for await (const o of cursor) {
                after = o.confirmed_at;
                afterId = o._id;
                completed++;
                if (o.processing_latency_ms < 0)
                    clockAnomalies++;
                else
                    latencies.push(o.processing_latency_ms);
            }
            const now = Date.now(), queues = {};
            for (const name of ['raw', 'checked', 'aggregate', 'rejected'])
                queues[name] = await queue.stats(name);
            let manifest = {};
            try {
                manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
            }
            catch { }
            const sample = { sampled_at: new Date(now).toISOString(), completed_observed: completed, throughput_observed_per_second: (completed - previous) / Math.max(.001, (now - previousTime) / 1000), queues,
                publication: { generated: manifest.generated_unique ?? null, mqtt_acknowledged: manifest.mqtt_acknowledged ?? null, pending_on_disk: manifest.pending_on_disk ?? null, status: manifest.status ?? 'unknown' } };
            if (values.aws) {
                const serviceNames = (values.services || values.service).split(',');
                const response = aws('ecs', 'describe-services', '--cluster', values.cluster, '--services', ...serviceNames);
                sample.stages = Object.fromEntries(response.services.map(stage => [stage.serviceName, { desired: stage.desiredCount, running: stage.runningCount, pending: stage.pendingCount }]));
                const r = response.services.find(stage => stage.serviceName === values.service);
                sample.ecs = { desired: r.desiredCount, running: r.runningCount, pending: r.pendingCount };
            }
            fs.appendFileSync(samplesFile, JSON.stringify(sample) + '\n');
            previous = completed;
            previousTime = now;
            await wait(5000);
        }
        // Final summary rescans the run to avoid missing confirmations between the last sample and completion.
        const summary = await store.runSummary(values.run);
        clockAnomalies = summary.clock_anomalies || clockAnomalies;
        let manifest = null;
        try {
            manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        }
        catch { }
        const expected = manifest?.generated_unique ?? null, terminal = (manifest?.status === 'published'), missing = expected === null ? null : Math.max(0, expected - summary.completed);
        const limit = manifest?.profile === 'scale' ? 5000 : 2000;
        const result = { environment: values.aws ? 'AWS run (operator must verify deployment metadata)' : 'local integration run', run_id: values.run, summary, manifest,
            validity: { publication_finished: terminal, configured_event_count_reached: expected === manifest?.expected_unique, resumed: manifest?.resumed || false, clock_anomalies: clockAnomalies, collector_seconds: seconds, timing_method: 'first publication attempt to application acknowledgement of aggregate commit' },
            evaluation: { p95_limit_ms: limit, p95_pass: terminal && clockAnomalies === 0 && summary.p95_processing_ms !== null ? summary.p95_processing_ms < limit : null,
                valid_unique_events_without_confirmation: missing, completion_failure_fraction: expected > 0 ? missing / expected : null, error_target_pass: terminal && expected > 0 ? missing / expected < .01 : null,
                backlog_recovery: 'Evaluate samples after the final publication. SQS values are approximate; also reconcile generated unique IDs with confirmed records. Missing metrics are not a pass.' },
            note: 'An event in a dead-letter queue or absent from storage is not counted as success. Deliberately invalid runs must be evaluated separately.' };
        fs.writeFileSync(path.join(dir, 'evaluation.json'), JSON.stringify(result, null, 2));
        if (values.aws) {
            const end = new Date().toISOString();
            fs.writeFileSync(path.join(dir, 'scaling-activities.json'), JSON.stringify(aws('application-autoscaling', 'describe-scaling-activities', '--service-namespace', 'ecs', '--resource-id', `service/${values.cluster}/${values.service}`), null, 2));
            for (const metric of ['CPUUtilization', 'MemoryUtilization']) {
                const data = aws('cloudwatch', 'get-metric-statistics', '--namespace', 'AWS/ECS', '--metric-name', metric, '--dimensions', `Name=ClusterName,Value=${values.cluster}`, `Name=ServiceName,Value=${values.service}`, '--start-time', new Date(start).toISOString(), '--end-time', end, '--period', '60', '--statistics', 'Average', 'Maximum');
                fs.writeFileSync(path.join(dir, metric + '.json'), JSON.stringify(data, null, 2));
            }
        }
        console.log(JSON.stringify(result, null, 2));
    }
    finally {
        await store.close();
        await queue.close();
    }
}
main().catch(e => { console.error(e.code || e.message); process.exit(1); });
