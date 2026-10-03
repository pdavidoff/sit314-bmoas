'use strict';
const { MongoStore } = require('../src/store');
const { registryFor } = require('../src/simulator/model');
async function main() { const n = Number(process.env.DEVICE_COUNT || 10000), g = Number(process.env.GATEWAY_COUNT || 20); if (!Number.isSafeInteger(n) || n < 1 || n > 100000 || !Number.isSafeInteger(g) || g < 1 || g > n)
    throw new Error('Invalid device/gateway count'); const data = registryFor(n, g); const store = await MongoStore.open(); try {
    await store.initialise(data.list, data.sources);
    console.log(JSON.stringify({ initialised: true, devices: n, gateways: g }));
}
finally {
    await store.close();
} }
main().catch(e => { console.error(e.code || e.message); process.exit(1); });
