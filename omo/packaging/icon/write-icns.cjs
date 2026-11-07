'use strict';
/*
 * Pack PNGs into an Apple .icns file (used on Linux, where iconutil does not exist).
 *   node write-icns.cjs <out.icns> <dirWith 16.png 32.png 64.png 128.png 256.png 512.png 1024.png>
 * Element types are the PNG-capable ones iconutil writes for a full iconset.
 */
const fs = require('node:fs');
const path = require('node:path');

const TYPES = [
    ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
    ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]
];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function writeIcns(out, dir) {
    const chunks = [];
    for (const [type, size] of TYPES) {
        const png = fs.readFileSync(path.join(dir, `${size}.png`));
        if (!png.subarray(0, 8).equals(PNG_MAGIC)) throw new Error(`${size}.png is not a PNG`);
        const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
        if (width !== size || height !== size) throw new Error(`${size}.png is ${width}x${height}`);
        const header = Buffer.alloc(8);
        header.write(type, 0, 'ascii');
        header.writeUInt32BE(png.length + 8, 4);
        chunks.push(header, png);
    }
    const body = Buffer.concat(chunks);
    const head = Buffer.alloc(8);
    head.write('icns', 0, 'ascii');
    head.writeUInt32BE(body.length + 8, 4);
    fs.writeFileSync(out, Buffer.concat([head, body]));
}

/** Parse an .icns file into [{ type, width, height, bytes }] (used by the package tests). */
function readIcns(file) {
    const buf = fs.readFileSync(file);
    if (buf.toString('ascii', 0, 4) !== 'icns' || buf.readUInt32BE(4) !== buf.length) throw new Error('not an icns file');
    const out = [];
    for (let at = 8; at < buf.length;) {
        const type = buf.toString('ascii', at, at + 4), len = buf.readUInt32BE(at + 4);
        if (len < 8 || at + len > buf.length) throw new Error('corrupt icns element');
        const data = buf.subarray(at + 8, at + len);
        const png = data.subarray(0, 8).equals(PNG_MAGIC);
        out.push({ type, bytes: data.length, width: png ? data.readUInt32BE(16) : undefined, height: png ? data.readUInt32BE(20) : undefined });
        at += len;
    }
    return out;
}

module.exports = { writeIcns, readIcns };
if (require.main === module) {
    const [out, dir] = process.argv.slice(2);
    if (!out || !dir) { console.error('usage: write-icns.cjs <out.icns> <pngDir>'); process.exit(2); }
    writeIcns(out, dir);
}
