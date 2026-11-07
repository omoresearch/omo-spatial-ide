'use strict';
/*
 * Download a pinned artifact once, verify its sha256, and keep it in omo/.cache/packaging/<sha256>.
 * A cached file is re-hashed before every use; a mismatch is deleted and re-downloaded.
 * Usage (CLI): node fetch-pinned.cjs <url> <sha256>   -> prints the verified cache path
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CACHE = process.env.OMO_PACKAGING_CACHE || path.resolve(__dirname, '..', '.cache', 'packaging');
const MAX_BYTES = 300 * 1024 * 1024;

const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function fetchPinned(asset) {
    if (!asset || !/^https:\/\//.test(asset.url) || !/^[0-9a-f]{64}$/.test(asset.sha256)) throw new Error(`Invalid pinned asset: ${JSON.stringify(asset)}`);
    fs.mkdirSync(CACHE, { recursive: true });
    const file = path.join(CACHE, asset.sha256);
    if (fs.existsSync(file)) {
        if (sha256File(file) === asset.sha256) return file;
        fs.rmSync(file, { force: true });
    }
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await fetch(asset.url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
            if (!response.ok) throw new Error(`HTTP ${response.status} for ${asset.url}`);
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length > MAX_BYTES) throw new Error(`Download too large: ${asset.url}`);
            const actual = crypto.createHash('sha256').update(bytes).digest('hex');
            if (actual !== asset.sha256) throw new Error(`sha256 mismatch for ${asset.url}: expected ${asset.sha256}, got ${actual}`);
            const tmp = `${file}.part-${process.pid}`;
            fs.writeFileSync(tmp, bytes);
            fs.renameSync(tmp, file);
            return file;
        } catch (error) {
            lastError = error;
            if (/sha256 mismatch/.test(error.message)) break;   // never retry a wrong artifact
        }
    }
    throw lastError;
}

module.exports = { fetchPinned, sha256File, CACHE };

if (require.main === module) {
    const [url, sha256] = process.argv.slice(2);
    fetchPinned({ url, sha256 }).then(file => console.log(file), error => { console.error(error.message); process.exitCode = 1; });
}
