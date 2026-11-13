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
const SILENT_MS = 10000;   // no live frame for this long on an open socket: reconnect
const FLAG_NAMES = { yellow: 'YELLOW FLAG', sc: 'SAFETY CAR', red: 'RED FLAG' };

class AgileAdapter extends EventEmitter {
  constructor() {
    super();
    this.host = null; this.ws = null; this.timer = null; this.backoff = 2000;
    this.status = 'disabled'; this.live = null; this.lastFrameTs = 0; this.info = null;
    this.lastLap = null; this.lastEl = 0; this.lapHadPit = false; this.lastCs = null; this.flags = null;
    this.pos = null; this.map = null; this.mapTs = 0; this.posTimer = null; this.posBusy = false;
    // link history for the event log: when the link went down, and the last pit message number Agile showed
    this.upTs = 0; this.downTs = 0; this.backTs = 0; this.lastPitId = null;
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
      this.backoff = 2000; this.openTs = Date.now(); this.lastPitId = null;   // compare pit message numbers within one connection only
      this.setStatus('connected');
      this.send({ t: 'pitstate' });
      const openTs = this.openTs;
      this.fetchData().then(d => {
        if (d) { this.info = { lapM: d.synth && d.synth.lap_m, geo: d.geo_active, best: d.best_lap_ms }; this.emit('info', this.info); }
        // a lap counter below the one before the drop: Agile restarted (or its lap count was reset) while the link was down
        const lapNow = d && typeof d.lap_number === 'number' ? d.lap_number : null;
        if (this.downTs) {
          const reset = lapNow != null && this.lastLap != null && lapNow < this.lastLap;
          this.emit('note', 'Agile link back after ' + dur(openTs - this.downTs) + (lapNow != null ? ', lap counter ' + lapNow : '') +
            (reset ? ' (was ' + this.lastLap + ': Agile restarted or its laps were reset while the link was down)' : ''));
          this.downTs = 0; this.backTs = openTs;
        } else this.emit('note', 'Agile connected (' + this.host + ')' + (lapNow != null ? ', lap counter ' + lapNow : ''));
        this.upTs = openTs;
        if (lapNow != null) this.lastLap = lapNow;
      });
      this.fetchMap();
      clearInterval(this.posTimer);
      this.posTimer = setInterval(() => this.pollPos(), 500);   // same rate Agile's own web page polls /data
    });
    ws.on('message', buf => { let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; } this.onMsg(m); });
    ws.on('close', () => { this.linkDown('connection closed'); this.retry(); });
    ws.on('error', () => { /* close follows */ });
  }
  // first moment the link is lost, logged once; the retries that follow are not
  linkDown(why) {
    if (this.downTs || !this.upTs) return;
    this.downTs = Date.now();
    this.emit('note', 'Agile link lost (' + why + ') after ' + dur(this.downTs - this.upTs) + ' up' + (this.lastLap != null ? ', lap counter ' + this.lastLap : '') + (this.lastCs ? ', car ' + this.lastCs : ''));
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
    // live stream silent (Agile's WebSocket can stall while its HTTP server keeps answering): /data carries the
    // same car state and lap counter, so keep following them from here, and drop the silent socket to reconnect
    if (d && this.stale()) this.track(d.car_state, d.lap_number, d.lap_elapsed_ms, d);
    if (this.ws && this.status === 'connected' && Date.now() - Math.max(this.lastFrameTs, this.openTs || 0) > SILENT_MS) {
      console.warn('Agile live stream silent for ' + Math.round(SILENT_MS / 1000) + ' s - reconnecting');
      this.linkDown('live stream silent ' + Math.round(SILENT_MS / 1000) + ' s, web page ' + (d ? 'still answering' : 'not answering'));
      this.stop(); this.retry(); return;
    }
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
      this.track(m.cs, m.lap, m.el);
      return;
    }
    if (m.t === 'flagstate') { this.flags = { yellow: !!m.yellow, sc: !!m.sc, red: !!m.red }; this.emit('flagstate', this.flags); return; }
    if (m.t === 'pitshown') {
      // Agile numbers pit messages from 1 after power-up: a number going back means the device rebooted
      if (typeof m.id === 'number') {
        if (this.lastPitId != null && m.id < this.lastPitId) this.emit('note', 'Agile rebooted: its pit message number went back to ' + m.id + ' (was ' + this.lastPitId + ')');
        this.lastPitId = m.id;
      }
      this.emit('pitshown', m.id); return;
    }
    if (m.t === 'pitack') { this.emit('pitack', { id: m.id, by: m.by }); return; }
  }
  // car state + lap counter, from a live frame or (stream silent) from /data, which also latches last_lap
  track(cs, lap, el, data) {
    if (PIT_STATES.has(cs)) this.lapHadPit = true;
    if (cs && cs !== this.lastCs) { const prev = this.lastCs; this.lastCs = cs; if (prev !== null) this.emit('carstate', cs); else this.emit('carstate-initial', cs); }
    if (typeof lap === 'number') {
      if (this.lastLap == null) this.lastLap = lap;
      else if (lap > this.lastLap) {
        const elBefore = this.lastEl, pitted = this.lapHadPit || PIT_STATES.has(cs);
        this.lastLap = lap; this.lapHadPit = PIT_STATES.has(cs);
        const emitLap = d => {
          const ll = d && d.last_lap;
          if (ll && ll.n && ll.ms) this.emit('lap', { n: ll.n, ms: ll.ms, delta: ll.delta, pitted, src: 'agile' });
          else if (elBefore > 0) this.emit('lap', { n: lap - 1, ms: elBefore, pitted, src: 'agile-est' });
        };
        if (data) emitLap(data); else this.fetchData().then(emitLap);
      } else if (lap < this.lastLap) {
        const afterDrop = this.downTs || (this.backTs && Date.now() - this.backTs < 120000);
        this.emit('note', 'Agile lap counter reset (' + this.lastLap + ' to ' + lap + ') - ' +
          (afterDrop ? 'just after a link drop: Agile likely restarted' : 'link stayed up: S/F or lap count reset on Agile, or a reboot quicker than the link noticed') + (cs ? ', car ' + cs : ''));
        this.lastLap = lap;
      }
    }
    this.lastEl = el || 0;
  }
  pitMessage(text, pri) { return this.send({ t: 'pitmsg', text: String(text).slice(0, 16), pri: pri ? 1 : 0 }); }
  // Mirror an Orb flag onto the Agile latched race-control flags.
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

function dur(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? s + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h'; }

AgileAdapter.flagFromState = function (f) { if (!f) return null; return f.red ? 'RED' : f.sc ? 'SC' : f.yellow ? 'YELLOW' : 'GREEN'; };
module.exports = AgileAdapter;
