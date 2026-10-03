'use strict';
function integer(name, fallback, min = 1, max = 1000000) {
    const n = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(n) || n < min || n > max)
        throw new Error(`Invalid ${name}`);
    return n;
}
function required(name) { const v = process.env[name]; if (!v)
    throw new Error(`Set ${name}`); return v; }
module.exports = { integer, required };
