'use strict';
// Satellite map tiles: a proxy and cache on the pit wall laptop.
// While online, each tile is fetched once from the imagery provider and kept in data/tiles/<source>/z/x/y,
// so the map keeps working when the internet drops. "Download track tiles" pre-fetches a track's area before the weekend.
// View-only devices on the LAN get their tiles from this laptop, so they need no internet of their own.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Default imagery source. Check the provider's terms of use for your team; the source can be changed in Setup.
const DEFAULT = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  maxZoom: 19
};
const MIN_PREFETCH_Z = 14, MAX_PREFETCH_TILES = 4000;

function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function lat2y(lat, z) { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z)); }
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

class Tiles {
  constructor(dataDir, store, userAgent) {
    this.root = path.join(dataDir, 'tiles');
    this.store = store;
    this.ua = userAgent;
    this.inflight = new Map();
    this.lastOk = 0; this.lastFail = 0;
    this.job = null;
  }
  source() {
    const s = Object.assign({}, DEFAULT, this.store.settings.tiles || {});
    s.maxZoom = Math.max(MIN_PREFETCH_Z, Math.min(20, +s.maxZoom || DEFAULT.maxZoom));
    s.isDefault = !this.store.settings.tiles;
    return s;
  }
  setSource(src) {
    if (!src || src.reset) { delete this.store.settings.tiles; this.store.saveSettings(); return this.source(); }
    const url = String(src.url || '').trim();
    if (!/^https?:\/\//i.test(url) || !/\{z\}/.test(url) || !/\{x\}/.test(url) || !/\{y\}/.test(url)) throw new Error('Tile URL must start with http(s):// and contain {z}, {x} and {y}');
    this.store.settings.tiles = { url, attribution: String(src.attribution || '').slice(0, 300), maxZoom: Math.max(MIN_PREFETCH_Z, Math.min(20, +src.maxZoom || DEFAULT.maxZoom)) };
    this.store.saveSettings();
    return this.source();
  }
  // each source gets its own folder, so changing provider never mixes imagery
  dir() { return path.join(this.root, crypto.createHash('sha1').update(this.source().url).digest('hex').slice(0, 10)); }
  file(z, x, y) { return path.join(this.dir(), String(z), String(x), String(y)); }
  online() { return this.lastOk >= this.lastFail && this.lastOk > 0 ? true : (this.lastFail ? false : null); }

  // returns { buf, type } from the cache, else from the provider (and caches it), else null
  async get(z, x, y) {
    const n = Math.pow(2, z);
    if (!(z >= 0 && z <= 20 && x >= 0 && x < n && y >= 0 && y < n)) return null;
    const f = this.file(z, x, y);
    try { const buf = fs.readFileSync(f); const type = imageType(buf); if (type) return { buf, type }; } catch (e) { /* not cached */ }
    if (this.isNone(f)) return null;
    const key = f;
    if (!this.inflight.has(key)) this.inflight.set(key, this.fetchTile(z, x, y, f).finally(() => this.inflight.delete(key)));
    return this.inflight.get(key);
  }
  async fetchTile(z, x, y, f) {
    const url = this.source().url.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'abc'[(x + y) % 3]);
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), 6000);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': this.ua }, signal: ac.signal });
      this.lastOk = Date.now();
      if (!r.ok) { if (r.status === 404) this.markNone(f); return null; }   // reachable, but no tile here
      const buf = Buffer.from(await r.arrayBuffer()), type = imageType(buf);
      if (!type) return null;
      if (this.isPlaceholder(buf, z, f)) { this.markNone(f); return null; }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, buf);
      return { buf, type };
    } catch (e) {
      this.lastFail = Date.now();
      return null;
    } finally { clearTimeout(to); }
  }

  // Tiles the provider does not have. Some providers answer with a "no imagery at this zoom" placeholder instead of
  // a 404 (Esri does at Collie above zoom 18); the same image coming back at two zoom levels marks it as one.
  // Those, and 404s, are remembered for 30 days with a .none marker so they are not asked for again.
  isNone(f) { try { return Date.now() - fs.statSync(f + '.none').mtimeMs < 30 * 86400000; } catch (e) { return false; } }
  markNone(f) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.none', ''); } catch (e) { /* read-only */ } }
  placeholders() {
    if (!this.ph || this.ph.dir !== this.dir()) {
      let list = []; try { list = JSON.parse(fs.readFileSync(path.join(this.dir(), 'placeholders.json'), 'utf8')); } catch (e) { /* none yet */ }
      this.ph = { dir: this.dir(), set: new Set(list), seen: new Map() };
    }
    return this.ph;
  }
  isPlaceholder(buf, z, f) {
    const ph = this.placeholders(), h = crypto.createHash('md5').update(buf).digest('hex');
    if (ph.set.has(h)) return true;
    const first = ph.seen.get(h);
    // the same image at two zoom levels, or for 8 different close-up tiles (zoom 17+), is a placeholder, not imagery
    if (first && (first.z !== z || (z >= 17 && first.files.length >= 7))) {
      ph.set.add(h); ph.seen.delete(h);
      try { fs.mkdirSync(ph.dir, { recursive: true }); fs.writeFileSync(path.join(ph.dir, 'placeholders.json'), JSON.stringify([...ph.set])); } catch (e) { /* read-only */ }
      first.files.forEach(g => { try { fs.unlinkSync(g); } catch (e) { /* gone */ } this.markNone(g); });
      return true;
    }
    if (first) { if (first.files.length < 8) first.files.push(f); }
    else { if (ph.seen.size > 20000) ph.seen.clear(); ph.seen.set(h, { z, files: [f] }); }
    return false;
  }

  // tiles covering bbox [south, west, north, east] from zoom 14 to the source's max zoom
  list(bbox) {
    const [s, w, n, e] = bbox.map(Number), out = [];
    if (![s, w, n, e].every(isFinite) || s >= n || w >= e || n - s > 0.2 || e - w > 0.2) throw new Error('Track area too large or invalid');
    for (let z = MIN_PREFETCH_Z; z <= this.source().maxZoom; z++) {
      const x0 = lon2x(w, z), x1 = lon2x(e, z), y0 = lat2y(n, z), y1 = lat2y(s, z);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
    }
    return out;
  }
  status(bbox) {
    const src = this.source(), out = { source: src, online: this.online(), job: this.job };
    if (bbox) {
      const t = this.list(bbox);
      out.total = t.length; out.have = 0; out.none = 0; out.maxImageryZoom = 0;
      t.forEach(([z, x, y]) => { const f = this.file(z, x, y); if (fs.existsSync(f)) { out.have++; out.maxImageryZoom = Math.max(out.maxImageryZoom, z); } else if (this.isNone(f)) out.none++; });
    }
    return out;
  }
  // download every missing tile of the area, four at a time; onProgress(job) after each tile
  prefetch(bbox, onProgress) {
    if (this.job && this.job.running) throw new Error('A download is already running');
    const all = this.list(bbox);
    if (all.length > MAX_PREFETCH_TILES) throw new Error('Track area needs ' + all.length + ' tiles (limit ' + MAX_PREFETCH_TILES + ')');
    const todo = all.filter(([z, x, y]) => { const f = this.file(z, x, y); return !fs.existsSync(f) && !this.isNone(f); });
    const none0 = all.filter(([z, x, y]) => this.isNone(this.file(z, x, y))).length;
    const job = this.job = { running: true, total: all.length, have: all.length - todo.length - none0, none: none0, failed: 0, started: Date.now() };
    let i = 0, last = 0;
    const worker = async () => {
      while (i < todo.length) {
        const [z, x, y] = todo[i++];
        const t = await this.get(z, x, y);
        if (t) job.have++; else if (this.isNone(this.file(z, x, y))) job.none++; else job.failed++;
        if (Date.now() - last > 400) { last = Date.now(); onProgress(job); }
      }
    };
    Promise.all([worker(), worker(), worker(), worker()]).then(() => { job.running = false; job.finished = Date.now(); onProgress(job); });
    return job;
  }
}

module.exports = Tiles;
