'use strict';
const { setTimeout: wait } = require('node:timers/promises');
// Delete only after the handler resolves. A failed handler leaves the message for redelivery.
function consume(queue, name, handler, { parallel = 2, batch = 10, visibility = 60, onTiming = () => { }, onError = () => { } } = {}) {
    let running = true;
    const active = new Set();
    async function handle(m) {
        const heartbeat = setInterval(() => queue.extend(name, m.receipt, visibility).catch(onError), Math.max(1000, visibility * 400));
        heartbeat.unref();
        try {
            if (Number.isFinite(m.enqueuedAt)) onTiming('QueueResidenceMs', Math.max(0, Date.now() - m.enqueuedAt));
            await handler(JSON.parse(m.body), m);
            await queue.remove(name, m.receipt);
        }
        catch (e) {
            onError(e);
        }
        finally {
            clearInterval(heartbeat);
        }
    }
    const workers = Array.from({ length: parallel }, async () => {
        while (running) {
            try {
                const messages = await queue.receive(name, { max: batch, visibility, wait: 2 });
                if (!messages.length) {
                    await wait(40);
                    continue;
                }
                const p = Promise.all(messages.map(handle));
                active.add(p);
                await p;
                active.delete(p);
            }
            catch (e) {
                onError(e);
                await wait(500);
            }
        }
    });
    return { async stop() { running = false; await Promise.all(workers); await Promise.all(active); } };
}
module.exports = { consume };
