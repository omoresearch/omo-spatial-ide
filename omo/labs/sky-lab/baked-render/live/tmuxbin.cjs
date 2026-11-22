'use strict';
// Finds a tmux binary: $OMO_TMUX, then PATH, then the static build Omo ships in ~/.local/share/omo/bin.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
function tmuxBin() {
    const c = [process.env.OMO_TMUX, ...String(process.env.PATH || '').split(':').map(d => d && path.join(d, 'tmux')), path.join(os.homedir(), '.local/share/omo/bin/tmux')];
    for (const p of c) { try { if (p) { fs.accessSync(p, fs.constants.X_OK); return p; } } catch {} }
    throw new Error('tmux not found: set OMO_TMUX=/path/to/tmux');
}
module.exports = { tmuxBin };
