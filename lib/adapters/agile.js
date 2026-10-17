'use strict';
// Agile (LapTimer v0.17.x) adapter.
// Agile is the WebSocket SERVER (ws://<ip>/ws, port 80). We connect as a client:
//   in : {"t":"live",...} 10 Hz, {"t":"flagstate",yellow,sc,red}, {"t":"pitshown",id}, {"t":"pitack",id,by}
//   out: {"t":"pitmsg",text,pri}, {"t":"pitflag",name,on}, {"t":"pitstate"}
// Completed lap time is not in the live frame; it is LATCHED in GET /data -> last_lap{n,ms,delta,promoted},
// so on every lap-number change we fetch /data once. Pit text is capped at 16 chars by firmware.
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const PIT_STATES = new Set(['PIT ENTRY', 'PITS', 'FUELLING']);
const FLAG_NAMES = { yellow: 'YELLOW FLAG', sc: 'SAFETY CAR', red: 'RED FLAG' };

class AgileAdapter extends EventEmitter {
  constructor() {
    super();
    this.host = null; this.ws = null; this.timer = null; this.backoff = 2000;
    this.status = 'disabled'; this.live = null; this.lastFrameTs = 0; this.info = null;
    this.lastLap = null; this.lastEl = 0; this.lapHadPit = false; this.lastCs = null; this.flags = null;
    this.pos = null; this.map = null; this.mapTs = 0; this.posTimer = null; this.posBusy = false;
  }
  configure(cfg) {
    const host = cfg && cfg.enabled ? String(cfg.host || '').trim() : null;
    if (host === this.host) return;
    this.stop();
    this.host = host;
    if (host) this.connect(); else this.setStatus('disabled');
  }
  setStatus(s) { if (s !== this.status) { this.status = s; this.emit('status', s); } }
  stop() {
    clearTimeout(this.timer); this.timer = null; clearInterval(this.posTimer); this.posTimer = null;
    if (this.ws) { try { this.ws.removeAllListeners(); this.ws.terminate(); } catch (e) { /* ignore */ } }
    this.ws = null;
  }
  connect() {
    if (!this.host) return;
    this.setStatus('connecting');
    const ws = new WebSocket('ws://' + this.host + '/ws', { handshakeTimeout: 4000 });
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = 2000; this.setStatus('connected');
      this.send({ t: 'pitstate' });
      this.fetchData().then(d => { if (d) { this.info = { lapM: d.synth && d.synth.lap_m, geo: d.geo_active, best: d.best_lap_ms }; this.lastLap = d.lap_number; this.emit('info', this.info); } });
      this.fetchMap();
      clearInterval(this.posTimer);
      this.posTimer = setInterval(() => this.pollPos(), 500);   // same rate Agile's own web page polls /data
    });
    ws.on('message', buf => { let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; } this.onMsg(m); });
    ws.on('close', () => this.retry());
    ws.on('error', () => { /* close follows */ });
  }
  retry() {
    this.ws = null;
    if (!this.host) return;
    this.setStatus('offline');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 1.5, 10000);
  }
  send(obj) { if (this.ws && this.ws.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(obj)); return true; } return false; }
  async getJson(path) {
    try {
      const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 2500);
      const r = await fetch('http://' + this.host + path, { signal: ac.signal }); clearTimeout(to);
      return await r.json();
    } catch (e) { return null; }
  }
  // Track outline (/refpath), geofences (/geozones) and S/F (/sf/get) for the mini map.
  async fetchMap() {
    const host = this.host;
    const [path, geo, sf] = await Promise.all([this.getJson('/refpath'), this.getJson('/geozones'), this.getJson('/sf/get')]);
    if (host !== this.host) return;
    const m = {
      path: Array.isArray(path) ? path.filter(p => p && p.lat && p.lon).map(p => [p.lat, p.lon]) : [],
      zones: geo && Array.isArray(geo.zones) ? geo.zones.map(z => ({ type: z.type, label: z.label, colour: z.colour, v: (z.vertices || []).map(v => [v.lat, v.lon]) })) : [],
      sf: sf && sf.valid ? [sf.lat, sf.lon] : null, ts: Date.now()
    };
    this.mapTs = Date.now();
    const sig = m.path.length + ':' + m.zones.length + ':' + (m.sf ? m.sf.join() : '');
    if (sig !== this.mapSig) { this.mapSig = sig; this.map = m; this.emit('map', m); }
  }
  async pollPos() {
    if (this.posBusy || !this.host) return;
    this.posBusy = true;
    const d = await this.fetchData();
    this.posBusy = false;
    if (d && typeof d.lat === 'number' && (d.lat !== 0 || d.lon !== 0)) this.pos = { lat: d.lat, lon: d.lon, sats: d.gnss_sats, pdop: d.gnss_pdop, spd: d.speed_kph, ts: Date.now() };
    // micro-sectors (sized by the Agile recon lap): colour 0 none, 1 green faster, 2 red slower, 3 purple best
    if (d && Array.isArray(d.sectors)) this.sectors = { n: d.sector_count || d.sectors.length, cur: d.current_sector, ts: Date.now(),
      cells: d.sectors.map(x => ({ c: x.completed ? x.colour : 0, d: x.delta_ms, done: !!x.completed })), last: (d.last_sectors || []).map(x => x.d) };
    // the reference path appears after the recon lap: re-check every 30 s until present, then every 10 min
    if (Date.now() - this.mapTs > (this.map && this.map.path.length ? 600000 : 30000)) this.fetchMap();
  }
  async fetchData() {
    try {
      const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 1500);
      const r = await fetch('http://' + this.host + '/data', { signal: ac.signal }); clearTimeout(to);
      return await r.json();
    } catch (e) { return null; }
  }
  onMsg(m) {
    if (m.t === 'live') {
      this.lastFrameTs = Date.now();
      if (this.status !== 'connected') this.setStatus('connected');
      this.live = { lap: m.lap, el: m.el, est: m.est, spd: m.spd, cs: m.cs, pit: m.pit, d: m.d, v: m.v, tl: m.tl, sec: m.sec, ts: this.lastFrameTs };
      if (PIT_STATES.has(m.cs)) this.lapHadPit = true;
      if (m.cs && m.cs !== this.lastCs) { const prev = this.lastCs; this.lastCs = m.cs; if (prev !== null) this.emit('carstate', m.cs); else this.emit('carstate-initial', m.cs); }
      if (typeof m.lap === 'number') {
        if (this.lastLap == null) this.lastLap = m.lap;
        else if (m.lap > this.lastLap) {
          const elBefore = this.lastEl, pitted = this.lapHadPit || PIT_STATES.has(m.cs);
          this.lastLap = m.lap; this.lapHadPit = PIT_STATES.has(m.cs);
          this.fetchData().then(d => {
            const ll = d && d.last_lap;
            if (ll && ll.n && ll.ms) this.emit('lap', { n: ll.n, ms: ll.ms, delta: ll.delta, pitted, src: 'agile' });
            else if (elBefore > 0) this.emit('lap', { n: m.lap - 1, ms: elBefore, pitted, src: 'agile-est' });
          });
        } else if (m.lap < this.lastLap) { this.lastLap = m.lap; this.emit('note', 'Agile lap counter reset (' + m.lap + ') - device restarted or S/F reset'); }
      }
      this.lastEl = m.el || 0;
      return;
    }
    if (m.t === 'flagstate') { this.flags = { yellow: !!m.yellow, sc: !!m.sc, red: !!m.red }; this.emit('flagstate', this.flags); return; }
    if (m.t === 'pitshown') { this.emit('pitshown', m.id); return; }
    if (m.t === 'pitack') { this.emit('pitack', { id: m.id, by: m.by }); return; }
  }
  pitMessage(text, pri) { return this.send({ t: 'pitmsg', text: String(text).slice(0, 16), pri: pri ? 1 : 0 }); }
  // Mirror a Pit Wall flag onto the Agile latched race-control flags.
  setFlag(flag) {
    const want = { yellow: flag === 'YELLOW' || flag === 'DOUBLE YELLOW', sc: flag === 'SC' || flag === 'FCY', red: flag === 'RED' };
    let sent = false;
    // switch the new flag ON before switching the old one OFF, so the dash never passes through "no flag" (= green)
    const keys = Object.keys(want).sort((a, b) => (want[b] ? 1 : 0) - (want[a] ? 1 : 0));
    for (const k of keys) {
      if (!this.flags || this.flags[k] !== want[k]) sent = this.send({ t: 'pitflag', name: FLAG_NAMES[k], on: want[k] }) || sent;
    }
    if (sent) this.flagSentAt = Date.now();
    return sent;
  }
  stale() { return this.status === 'connected' && Date.now() - this.lastFrameTs > 3000; }
  snapshot() { return { status: this.stale() ? 'stale' : this.status, host: this.host, live: this.live, info: this.info, flags: this.flags, pos: this.pos, sectors: this.sectors || null }; }
}

AgileAdapter.flagFromState = function (f) { if (!f) return null; return f.red ? 'RED' : f.sc ? 'SC' : f.yellow ? 'YELLOW' : 'GREEN'; };
module.exports = AgileAdapter;
