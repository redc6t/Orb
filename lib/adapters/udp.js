'use strict';
// Generic JSON-over-UDP input for the simulator and future devices (e.g. an IMU impact node).
// One JSON object per datagram:
//   {"t":"lap","n":12,"ms":91234,"pitted":false}      {"t":"carstate","cs":"PITS"}
//   {"t":"flag","flag":"SC"}                          {"t":"fuel","litres":32.5}
//   {"t":"impact","g":4.2,"lat":-33.36,"lon":116.15}  {"t":"issue","cat":"engine","sev":"warn","text":"Oil temp high"}
const dgram = require('dgram');
const { EventEmitter } = require('events');

class UdpAdapter extends EventEmitter {
  constructor() { super(); this.sock = null; this.port = null; this.status = 'disabled'; this.lastRx = 0; this.rx = 0; }
  configure(cfg) {
    const port = cfg && cfg.enabled ? (+cfg.port || 47800) : null;
    if (port === this.port) return;
    if (this.sock) { try { this.sock.close(); } catch (e) { /* ignore */ } this.sock = null; }
    this.port = port;
    if (!port) { this.setStatus('disabled'); return; }
    const s = dgram.createSocket('udp4');
    s.on('error', e => { this.setStatus('error'); this.emit('note', 'UDP port ' + port + ' error: ' + e.message); });
    s.on('message', (buf, rinfo) => {
      let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
      this.lastRx = Date.now(); this.rx++; this.setStatus('listening');
      this.emit('msg', m, rinfo.address);
    });
    s.bind(port, () => this.setStatus('listening'));
    this.sock = s;
  }
  setStatus(s) { if (s !== this.status) { this.status = s; this.emit('status', s); } }
  snapshot() { return { status: this.status, port: this.port, lastRx: this.lastRx, rx: this.rx }; }
}
module.exports = UdpAdapter;
