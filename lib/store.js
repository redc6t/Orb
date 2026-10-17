'use strict';
// Append-only event store.
//   data/settings.json                     server settings + last active event (auto-resume)
//   data/cars/<id>.json                    car library (persists across events)
//   data/events/<id>/config.json           weekend config as created
//   data/events/<id>/events.jsonl          every action, one JSON per line (source of truth, replay log)
//   data/events/<id>/car_config.json       readable snapshot of the current car config
//   data/events/<id>/driver_schedule.json  readable snapshot of roster, rotation and shifts
// Export/import bundle: <name>.pitwall.json = { format, version, config, events }
const fs = require('fs');
const path = require('path');
const R = require('../public/js/shared/reducer.js');

const FORMAT = 'mme-pitwall-event', VERSION = 1;

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    for (const d of ['', 'cars', 'events', 'branding']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.settings = Object.assign({ port: 8080, engineerHosts: [], lastEventId: null }, this.readJson(this.settingsFile) || {});
    this.saveSettings();
    this.eventId = null; this.config0 = null; this.events = []; this.state = null; this.seq = 0;
  }
  readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
  writeJson(f, o) { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o, null, 2)); fs.renameSync(tmp, f); }
  saveSettings() { this.writeJson(this.settingsFile, this.settings); }
  evDir(id) { return path.join(this.dir, 'events', id); }

  listEvents() {
    const root = path.join(this.dir, 'events');
    return fs.readdirSync(root).filter(id => fs.existsSync(path.join(root, id, 'config.json'))).map(id => {
      const c = this.readJson(path.join(root, id, 'config.json')) || {};
      let n = 0; try { n = fs.readFileSync(path.join(root, id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch (e) { /* none */ }
      return { id, name: c.name, date: c.date, team: c.team && c.team.name, rules: c.rules && c.rules.version, createdTs: c.createdTs, events: n };
    }).sort((a, b) => (b.createdTs || 0) - (a.createdTs || 0));
  }
  listCars() {
    const root = path.join(this.dir, 'cars');
    return fs.readdirSync(root).filter(f => f.endsWith('.json')).map(f => this.readJson(path.join(root, f))).filter(Boolean);
  }
  saveCar(car) {
    if (!car || !car.id) throw new Error('car.id required');
    const safe = String(car.id).replace(/[^a-z0-9_-]/gi, '_');
    this.writeJson(path.join(this.dir, 'cars', safe + '.json'), car);
  }

  create(config, events) {
    let id = String(config.id || ('evt-' + Date.now())).replace(/[^a-z0-9_-]/gi, '_');
    if (fs.existsSync(this.evDir(id))) id = id + '-' + Date.now().toString(36);
    config.id = id;
    fs.mkdirSync(this.evDir(id), { recursive: true });
    this.writeJson(path.join(this.evDir(id), 'config.json'), config);
    fs.writeFileSync(path.join(this.evDir(id), 'events.jsonl'), (events || []).map(e => JSON.stringify(e)).join('\n') + ((events && events.length) ? '\n' : ''));
    this.open(id);
    return id;
  }
  open(id) {
    const cfg = this.readJson(path.join(this.evDir(id), 'config.json'));
    if (!cfg) throw new Error('event not found: ' + id);
    const lines = fs.existsSync(path.join(this.evDir(id), 'events.jsonl')) ? fs.readFileSync(path.join(this.evDir(id), 'events.jsonl'), 'utf8').split('\n') : [];
    const events = [];
    for (const ln of lines) { if (!ln.trim()) continue; try { events.push(R.migrateEvent(JSON.parse(ln))); } catch (e) { /* torn last line after power loss: skip */ } }
    // old device keys (pltd/bttm): rewrite config.json once with the new ones; the append-only log is only mapped in memory
    const before = JSON.stringify(cfg.devices);
    R.migrateConfig(cfg);
    if (JSON.stringify(cfg.devices) !== before) this.writeJson(path.join(this.evDir(id), 'config.json'), cfg);
    this.eventId = id; this.config0 = cfg; this.events = events;
    this.seq = events.length ? events[events.length - 1].seq : 0;
    this.state = R.reduce(cfg, events);
    this.settings.lastEventId = id; this.saveSettings();
    this.snapshot();
    return this.state;
  }
  close() { this.eventId = null; this.config0 = null; this.events = []; this.state = null; this.seq = 0; this.settings.lastEventId = null; this.saveSettings(); }
  append(type, payload, by, src, ts) {
    if (!this.eventId) throw new Error('no active event');
    const e = { seq: ++this.seq, ts: ts || Date.now(), type, payload: payload || {}, by: by || 'system' };
    if (src) e.src = src;
    fs.appendFileSync(path.join(this.evDir(this.eventId), 'events.jsonl'), JSON.stringify(e) + '\n');
    this.events.push(e);
    R.apply(this.state, e);
    if (type === 'setup.update' || type === 'driver.queue' || type.startsWith('crew.')) this.snapshot();
    return e;
  }
  snapshot() {
    if (!this.eventId) return;
    const s = this.state;
    try {
      this.writeJson(path.join(this.evDir(this.eventId), 'car_config.json'), s.config.car);
      this.writeJson(path.join(this.evDir(this.eventId), 'driver_schedule.json'), { members: s.config.members, rotation: s.drivers.queue, shifts: s.crew.shifts, updated: new Date().toISOString() });
    } catch (e) { /* non-fatal */ }
  }
  bundle(id) {
    if (id && id !== this.eventId) {
      const cfg = this.readJson(path.join(this.evDir(id), 'config.json'));
      const ev = fs.readFileSync(path.join(this.evDir(id), 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      return { format: FORMAT, version: VERSION, exportedTs: Date.now(), config: cfg, events: ev };
    }
    return { format: FORMAT, version: VERSION, exportedTs: Date.now(), config: this.config0, events: this.events };
  }
  importBundle(b) {
    if (!b || b.format !== FORMAT || !b.config) throw new Error('Not a Pit Wall event file');
    return this.create(b.config, b.events || []);
  }
}
module.exports = Store;
