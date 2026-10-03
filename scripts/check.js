'use strict';
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
let js = 0, json = 0;
function scan(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'runtime', 'runs', 'secrets'].includes(e.name))
        continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory())
        scan(p);
    else if (e.name.endsWith('.js')) {
        execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
        js++;
    }
    else if (e.name.endsWith('.json')) {
        JSON.parse(fs.readFileSync(p, 'utf8'));
        json++;
    }
} }
scan(path.resolve(__dirname, '..'));
console.log(JSON.stringify({ javascript_syntax_checked: js, json_parsed: json }));
