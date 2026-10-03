'use strict';
const { getQueue } = require('../../src/queue/sqs');
const { integer } = require('../../src/config');
const { consume } = require('../../src/queue/consume');
module.exports = function (RED) {
    function In(config) {
        RED.nodes.createNode(this, config);
        const node = this, q = getQueue();
        const pending = new Set();
        const worker = consume(q, config.queue, async (payload) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error('flow_timeout')), 45000);
            const finish = err => { clearTimeout(timer); pending.delete(finish); err ? reject(err) : resolve(); };
            pending.add(finish);
            node.send({ payload, _bmoasFinish: finish });
        }), { parallel: integer('POLLERS', 2, 1, 8), onError: e => { node.status({ fill: 'red', shape: 'ring', text: e.code || e.name }); node.error(e.code || e.name); } });
        node.status({ fill: 'green', shape: 'dot', text: 'polling' });
        node.on('close', async (_removed, done) => { for (const f of pending)
            f(new Error('stopping')); await worker.stop(); done(); });
    }
    function Out(config) {
        RED.nodes.createNode(this, config);
        const node = this, q = getQueue();
        let count = 0;
        let lastStatus = 0;
        node.on('input', async (msg, send, done) => {
            if (typeof msg._bmoasFinish !== 'function') {
                done(new Error('Missing delivery context'));
                return;
            }
            try {
                await q.send(config.queue, msg.payload);
                msg._bmoasFinish();
                count++;
                if (Date.now() - lastStatus >= 1000) {
                    node.status({ fill: 'green', shape: 'dot', text: `forwarded ${count}` });
                    lastStatus = Date.now();
                }
                send({ payload: { queue: config.queue, forwarded: count } });
                done();
            }
            catch (e) {
                msg._bmoasFinish(e);
                node.status({ fill: 'red', shape: 'ring', text: 'send failed; input will retry' });
                done(e);
            }
        });
    }
    RED.nodes.registerType('bmoas-in', In);
    RED.nodes.registerType('bmoas-out', Out);
};
