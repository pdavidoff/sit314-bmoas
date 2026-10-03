'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
async function startNodeRed({ port = Number(process.env.NR_PORT || 1880), host = process.env.BIND_HOST || '127.0.0.1' } = {}) {
    const RED = require('node-red');
    const root = path.resolve(__dirname, '../..'), userDir = process.env.NR_USER_DIR || path.join(root, 'runtime/node-red');
    fs.mkdirSync(userDir, { recursive: true });
    const flow = path.join(userDir, 'flows.json');
    if (!fs.existsSync(flow))
        fs.copyFileSync(path.join(root, 'node-red/flows.json'), flow);
    const localEditor = process.env.NODE_ENV !== 'production';
    const settings = { userDir, flowFile: flow, nodesDir: path.join(root, 'node-red/nodes'), httpAdminRoot: localEditor ? '/red' : false, httpNodeRoot: '/nodes', disableEditor: !localEditor,
        functionGlobalContext: { bmoasDomain: require('../domain') }, logging: { console: { level: 'info', metrics: false, audit: false } }, editorTheme: { projects: { enabled: false } }, externalModules: { autoInstall: false, palette: { allowInstall: false }, modules: { allowInstall: false } } };
    // Local editor binds only to loopback by default; production disables it entirely.
    if (localEditor && host !== '127.0.0.1' && process.env.ALLOW_LOCAL_CONTAINER_EDITOR !== '1')
        throw new Error('Do not expose an unauthenticated editor');
    const app = require('express')();
    const server = http.createServer(app);
    RED.init(server, settings);
    app.get('/healthz', (_req, res) => res.json({ status: 'alive' }));
    if (localEditor)
        app.use(settings.httpAdminRoot, RED.httpAdmin);
    app.use(settings.httpNodeRoot, RED.httpNode);
    await RED.start();
    await new Promise(resolve => server.listen(port, host, resolve));
    return { RED, server, async close() { await RED.stop(); await new Promise(resolve => server.close(resolve)); } };
}
if (require.main === module)
    startNodeRed().then(app => { process.once('SIGINT', () => app.close()); process.once('SIGTERM', () => app.close()); }).catch(e => { console.error(e.code || e.message); process.exit(1); });
module.exports = { startNodeRed };
