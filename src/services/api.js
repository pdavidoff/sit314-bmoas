'use strict';
const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { ID, iso } = require('../domain');
function authorised(actual, token) { const a = Buffer.from(actual || ''), b = Buffer.from('Bearer ' + token); return a.length === b.length && timingSafeEqual(a, b); }
function createApi(store, token) {
    if (!token || token.length < 24 || token.startsWith('REPLACE_'))
        throw new Error('API_TOKEN must contain at least 24 characters');
    return http.createServer(async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const send = (status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
        if (req.method !== 'GET')
            return send(405, { error: 'method_not_allowed' });
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/healthz')
            return send(200, { status: 'alive' });
        if (!authorised(req.headers.authorization, token))
            return send(401, { error: 'unauthorised' });
        try {
            if (url.pathname === '/readyz') {
                await store.ping();
                return send(200, { status: 'ready' });
            }
            const match = url.pathname.match(/^\/v1\/runs\/([A-Za-z0-9_-]{1,80})$/);
            if (match)
                return send(200, await store.runSummary(match[1]));
            if (url.pathname === '/v1/reports') {
                const run = url.searchParams.get('run_id');
                if (!run || !ID.test(run))
                    return send(400, { error: 'run_id_required' });
                const filter = { run_id: run };
                for (const [param, key] of [['source', 'source_id'], ['region', 'region']]) {
                    const v = url.searchParams.get(param);
                    if (v) {
                        if (!ID.test(v))
                            return send(400, { error: 'invalid_filter' });
                        filter[key] = v;
                    }
                }
                const from = url.searchParams.get('from'), to = url.searchParams.get('to');
                if (from || to) {
                    if (!iso(from) || !iso(to) || Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 31 * 86400000)
                        return send(400, { error: 'invalid_period' });
                    filter.window_start = { $gte: new Date(from), $lt: new Date(to) };
                }
                return send(200, { results: await store.reports(filter), limit: 500, note: 'A participant can occur in several periods. Do not sum participant_count to infer unique people over multiple periods.' });
            }
            return send(404, { error: 'not_found' });
        }
        catch {
            return send(503, { error: 'storage_unavailable' });
        }
    });
}
async function main() {
    const { MongoStore } = require('../store');
    const store = await MongoStore.open();
    const server = createApi(store, process.env.API_TOKEN);
    server.listen(Number(process.env.PORT || 8080), process.env.BIND_HOST || '127.0.0.1', () => console.log('BMOAS API listening'));
    async function close() { server.close(); await store.close(); }
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
}
if (require.main === module)
    main().catch(() => { console.error('API startup failed; check configuration and database access'); process.exit(1); });
module.exports = { createApi, authorised };
