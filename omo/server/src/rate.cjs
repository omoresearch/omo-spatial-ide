'use strict';
// Token buckets keyed by string (ip, member, socket). Bounded map; idle buckets are swept.
class Buckets {
    constructor({ capacity, perSecond, maxKeys = 20000 }) { this.capacity = capacity; this.perSecond = perSecond; this.maxKeys = maxKeys; this.map = new Map(); }
    take(key, cost = 1) {
        const now = Date.now();
        let b = this.map.get(key);
        if (!b) {
            if (this.map.size >= this.maxKeys) this.sweep(now, true);
            b = { tokens: this.capacity, at: now }; this.map.set(key, b);
        } else {
            b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.perSecond); b.at = now;
        }
        if (b.tokens < cost) return false;
        b.tokens -= cost; return true;
    }
    sweep(now = Date.now(), hard = false) {
        for (const [k, b] of this.map) if (hard || b.tokens + ((now - b.at) / 1000) * this.perSecond >= this.capacity) this.map.delete(k);
    }
    forget(key) { this.map.delete(key); }
}
module.exports = { Buckets };
