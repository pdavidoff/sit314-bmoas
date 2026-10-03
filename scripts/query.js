'use strict';
// Runs inside the reporting container without printing its bearer token.
const route = process.argv[2] || '/readyz';
fetch('http://127.0.0.1:8080' + route, { headers: { Authorization: 'Bearer ' + process.env.API_TOKEN } }).then(async (r) => { console.log(await r.text()); if (!r.ok)
    process.exitCode = 1; }).catch(() => { console.error('Query failed'); process.exitCode = 1; });
