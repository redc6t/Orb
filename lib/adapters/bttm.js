'use strict';
// BTTM v4.5.x adapter. The BTTM has no WebSocket: poll GET /data (1 Hz) and GET /config (thresholds).
// Temperatures arrive as strings, "---.-" = no data; TPMS psi "--" = untrusted/stale.
// Colour bands follow the BTTM firmware: blue <= t1 < green <= t2 < yellow <= t3 < red <= t4 < red flashing.
const { EventEmitter } = require('events');
const CORNERS = ['fl', 'fr', 'rl', 'rr'];

function f(v) { if (v === undefined || v === null) return null; const n = parseFloat(v); return isNaN(n) ? null : n; }

class BttmAdapter extends EventEmitter {
  constructor() {
    super();
    this.host = null; this.pollMs = 1000; this.timer = null; this.status = 'disabled'; this.live = null;
    this.thresh = { br: [100, 300, 500, 700], ty: [40, 70, 100, 130], pr: [20, 26, 29, 32] };
    this.level = {}; this.fails = 0; this.lastCfg = 0;
  }
  configure(cfg) {
    const host = cfg && cfg.enabled ? String(cfg.host || '').trim() : null;
    this.pollMs = Math.max(500, (cfg && cfg.pollMs) || 1000);
    if (host === this.host) return;
    clearTimeout(this.timer); this.host = host; this.level = {};
    if (host) { this.setStatus('connecting'); this.poll(); } else this.setStatus('disabled');
  }
  setStatus(s) { if (s !== this.status) { this.status = s; this.emit('status', s); } }
  async get(path) {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 1500);
    try { const r = await fetch('http://' + this.host + path, { signal: ac.signal }); return await r.json(); } finally { clearTimeout(to); }
  }
  async poll() {
    if (!this.host) return;
    const host = this.host;
    try {
      if (Date.now() - this.lastCfg > 300000) {
        const c = await this.get('/config');
        this.thresh = { br: [c.br_t1, c.br_t2, c.br_t3, c.br_t4], ty: [c.ty_t1, c.ty_t2, c.ty_t3, c.ty_t4], pr: [c.pr_t1, c.pr_t2, c.pr_t3, c.pr_t4] };
        this.lastCfg = Date.now();
      }
      const d = await this.get('/data');
      if (host !== this.host) return;
      const live = { ts: Date.now(), brake: {}, tyre: {}, press: {}, tpmsTemp: {}, tpmsTrusted: d.tpms_trusted === true, sats: d.sats, speed: f(d.speed), lat: f(d.lat), lon: f(d.lon), thresh: this.thresh };
      CORNERS.forEach(c => {
        live.brake[c] = f(d['br_' + c + '_temp']);
        live.tyre[c] = f(d['ti_' + c + '_temp']);
        live.press[c] = f(d['tp_' + c + '_psi']);
        live.tpmsTemp[c] = f(d['tp_' + c + '_tc']);
      });
      this.live = live; this.fails = 0; this.setStatus('connected');
      this.checkAlarms(live);
    } catch (e) {
      this.fails++;
      if (this.fails >= 3) this.setStatus('offline');
    }
    if (host === this.host) this.timer = setTimeout(() => this.poll(), this.status === 'offline' ? 4000 : this.pollMs);
  }
  band(v, t) { if (v == null) return null; if (v > t[3]) return 4; if (v > t[2]) return 3; if (v > t[1]) return 2; if (v > t[0]) return 1; return 0; }
  checkAlarms(live) {
    const now = Date.now();
    const evalKey = (key, value, kind, corner, high, warnTh, critTh, lowTh) => {
      if (value == null) return;
      let lvl = 0;
      if (high) { if (value > critTh) lvl = 2; else if (value > warnTh) lvl = 1; }
      if (lowTh != null && value < lowTh) lvl = Math.max(lvl, 1);
      const st = this.level[key] || { lvl: 0, since: now, emitted: 0 };
      // hysteresis: need 3 s above to raise; drop only when 5% below the threshold
      st.lastAt = st.lastAt || {};
      if (lvl > st.emitted) {
        if (st.pending !== lvl) { st.pending = lvl; st.since = now; }
        else if (now - st.since >= (lvl === 2 ? 3000 : 10000)) {
          st.emitted = lvl;
          if (now - (st.lastAt[lvl] || 0) > 300000) { st.lastAt[lvl] = now; this.emit('alarm', { corner, kind, value, level: lvl === 2 ? 'crit' : 'warn' }); }
        }
      } else if (lvl < st.emitted) {
        const th = st.emitted === 2 ? critTh : warnTh;
        if (!high || value < th * 0.9) { st.emitted = lvl; st.pending = lvl; }
      } else st.pending = lvl;
      this.level[key] = st;
    };
    const t = this.thresh;
    CORNERS.forEach(c => {
      evalKey('br' + c, live.brake[c], 'brake', c, true, t.br[2], t.br[3]);
      evalKey('ty' + c, live.tyre[c], 'tyre', c, true, t.ty[2], t.ty[3]);
      if (live.tpmsTrusted) evalKey('pr' + c, live.press[c], 'press', c, true, t.pr[3], t.pr[3] * 1.1, t.pr[0]);
    });
  }
  snapshot() { return { status: this.status, host: this.host, live: this.live }; }
}
module.exports = BttmAdapter;
