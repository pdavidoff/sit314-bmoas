'use strict';

// Cumulative counts avoid losing observations when the publisher briefly falls behind.
function workload(profile) {
    if (!Array.isArray(profile.steps)) {
        return {
            durationMs: profile.duration_seconds * 1000,
            total: Math.floor(profile.duration_seconds * 1000 / profile.interval_ms) * profile.devices,
            target(elapsedMs) {
                return Math.min(this.total, Math.floor(Math.max(0, elapsedMs) * profile.devices / profile.interval_ms));
            }
        };
    }
    let durationMs = 0;
    let total = 0;
    const steps = profile.steps.map(step => {
        if (!Number.isSafeInteger(step.duration_seconds) || step.duration_seconds < 1 ||
            !Number.isSafeInteger(step.events_per_second) || step.events_per_second < 1) {
            throw new Error('invalid_workload_step');
        }
        const segment = { startMs: durationMs, countBefore: total, rate: step.events_per_second, durationMs: step.duration_seconds * 1000 };
        durationMs += segment.durationMs;
        total += step.duration_seconds * step.events_per_second;
        return segment;
    });
    if (!steps.length) throw new Error('empty_workload_steps');
    return {
        durationMs, total,
        target(elapsedMs) {
            if (elapsedMs <= 0) return 0;
            for (const step of steps) {
                if (elapsedMs < step.startMs + step.durationMs) {
                    return step.countBefore + Math.floor((elapsedMs - step.startMs) * step.rate / 1000);
                }
            }
            return total;
        }
    };
}
module.exports = { workload };
