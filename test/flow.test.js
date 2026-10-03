'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const flow = require('../node-red/flows.json'), domain = require('../src/domain');
const { registryFor, eventFor, envelope } = require('../src/simulator/model');
function execute(id, msg) { const f = flow.find(n => n.id === id); return vm.runInNewContext('(function(msg){' + f.func + '})(msg)', { msg, global: { get: () => domain }, Buffer }); }
test('export includes meaningful decode, check, forwarding and error branches', () => { for (const id of ['raw', 'decode', 'check', 'checked', 'reject'])
    assert.ok(flow.some(n => n.id === id)); });
test('the exact exported decode/check functions route a valid observation', () => { const { list } = registryFor(1, 1); const msg = { payload: envelope(eventFor(list[0], 1, 'flow', Date.now())) }; const decoded = execute('decode', msg); assert.equal(decoded[1], null); const checked = execute('check', decoded[0]); assert.equal(checked[1], null); assert.equal(checked[0].payload.event.device_id, list[0]._id); });
test('the exported decode function routes invalid JSON to quarantine', () => { const r = execute('decode', { payload: envelope('{bad') }); assert.equal(r[0], null); assert.equal(r[1].payload.reason, 'invalid_json'); });
test('the exported check function routes malformed structure to quarantine', () => { const r = execute('check', { payload: { event: { event_id: 42 }, transport: {} } }); assert.equal(r[0], null); assert.equal(r[1].payload.reason, 'invalid_event_id'); });
test('flow functions preserve the completion callback needed for safe forwarding', () => { const { list } = registryFor(1, 1), finish = () => { }; const r = execute('decode', { payload: envelope(eventFor(list[0], 1, 'flow', Date.now())), _bmoasFinish: finish }); assert.equal(r[0]._bmoasFinish, finish); });
module.exports = { execute };
