/* Pit Wall UI helpers */
(function () {
  'use strict';
  var U = {};
  U.esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  U.pad = function (n) { return (n < 10 ? '0' : '') + n; };
  // durations always carry their units, so 1h 55m can never be read as 1 min 55 s
  U.dur = function (ms, noSec) {
    if (ms == null || isNaN(ms)) return '--';
    var neg = ms < 0; ms = Math.abs(ms);
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    var out = noSec ? (h ? h + 'h ' + U.pad(m) + 'm' : m + 'm') : (h ? h + 'h ' + U.pad(m) + 'm ' + U.pad(x) + 's' : m + 'm ' + U.pad(x) + 's');
    return (neg ? '-' : '') + out;
  };
  U.mins = function (ms) { if (ms == null || isNaN(ms)) return '-'; var m = Math.round(ms / 60000); return m >= 60 ? Math.floor(m / 60) + 'h ' + U.pad(m % 60) + 'm' : m + 'm'; };
  // clock times: 24 h (13:00) by default, 12 h with am/pm from Setup
  U.clock24 = true;
  U.setClock24 = function (v) { U.clock24 = String(v) !== 'false'; };
  U.clock = function (ts, sec) {
    if (!ts) return '--:--'; var d = new Date(ts), h = d.getHours();
    var t = (sec ? ':' + U.pad(d.getSeconds()) : '');
    if (U.clock24) return U.pad(h) + ':' + U.pad(d.getMinutes()) + t;
    return ((h % 12) || 12) + ':' + U.pad(d.getMinutes()) + t + (h < 12 ? ' am' : ' pm');
  };
  U.dayClock = function (ts) { if (!ts) return '-'; var d = new Date(ts); return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + U.clock(ts); };
  U.lap = function (ms) { if (!ms) return '-:--.-'; var t = ms / 1000, m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); };
  U.L = function (v, d) { return v == null || isNaN(v) ? '-' : (+v).toFixed(d == null ? 1 : d); };
  U.toLocalInput = function (ts) { if (!ts) return ''; var d = new Date(ts); return d.getFullYear() + '-' + U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate()) + 'T' + U.pad(d.getHours()) + ':' + U.pad(d.getMinutes()); };
  U.fromLocalInput = function (v) { return v ? new Date(v).getTime() : null; };
  U.DRIVER_COLOURS = ['#00BCD4', '#FFD54F', '#8B5CF6', '#00C846', '#FD6220', '#4fc3f7', '#CE93D8', '#F06292', '#AED581', '#FFB74D'];
  U.driverColour = function (s, id) { var q = (s.config.driverOrder && s.config.driverOrder.length ? s.config.driverOrder : s.drivers.queue) || []; var i = q.indexOf(id); return U.DRIVER_COLOURS[(i < 0 ? 9 : i) % U.DRIVER_COLOURS.length]; };
  U.short = function (name) { if (!name) return '-'; name = String(name); return name.length <= 12 ? name : name.split(' ')[0]; };

  // presence icons (no emoji): colour disc + glyph
  var disc = function (c, g) { return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="' + c + '"/>' + g + '</svg>'; };
  var P = {
    available: disc('#00C846', '<path d="M7 12.5l3.2 3.2L17 8.8" stroke="#0e0e0e" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
    driving: disc('#00BCD4', '<path d="M5 15.5v-2.2l1.8-3.8c.3-.6.8-.9 1.5-.9h7.4c.7 0 1.2.3 1.5.9l1.8 3.8v2.2c0 .5-.4.9-.9.9h-.9a2 2 0 0 1-3.9 0H10.7a2 2 0 0 1-3.9 0h-.9c-.5 0-.9-.4-.9-.9zM7.6 12.6h8.8l-1.2-2.6H8.8z" fill="#0e0e0e"/>'),
    sleeping: disc('#6D5BD0', '<path d="M4.5 16.5v-6M4.5 14h15v2.5M19.5 16.5v-1.6" stroke="#0e0e0e" stroke-width="1.7" fill="none" stroke-linecap="round"/><rect x="5.5" y="10.6" width="3.6" height="3" rx="1.2" fill="#0e0e0e"/><path d="M10 13.6h7.6c1 0 1.9.8 1.9 1.8V14H10z" fill="#0e0e0e"/><path d="M13.2 6.2h3l-3 3h3" stroke="#0e0e0e" stroke-width="1.2" fill="none"/>'),
    resting: disc('#8B5CF6', '<path d="M14.6 5.6a6.6 6.6 0 1 0 3.8 11.3 7.6 7.6 0 0 1-3.8-11.3z" fill="#0e0e0e"/>'),
    mechanic: disc('#9aa0aa', '<path d="M15.8 4.8a4 4 0 0 0-3.9 5.3l-6.6 6.6a1.4 1.4 0 0 0 2 2l6.6-6.6a4 4 0 0 0 5.3-3.9l-2.3 2.3-2.4-.6-.6-2.4z" fill="#0e0e0e"/>'),
    refuel: disc('#CE93D8', '<path d="M8.6 5.5h5.2l3.2 3.2v8.9c0 .6-.5 1-1 1H8.6c-.6 0-1-.4-1-1v-11c0-.6.4-1.1 1-1.1z" fill="#0e0e0e"/><path d="M9.6 7.4h3" stroke="#CE93D8" stroke-width="1.3"/><path d="M9.6 10.5l5 5M14.6 10.5l-5 5" stroke="#CE93D8" stroke-width="1.2"/>'),
    offline: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="#888" stroke-width="2"/><path d="M8.2 8.2l7.6 7.6M15.8 8.2l-7.6 7.6" stroke="#888" stroke-width="2"/></svg>',
    flag: disc('#FD6220', '<path d="M8 18.5V5.5M8 6h8l-2 3 2 3H8" stroke="#0e0e0e" stroke-width="1.8" fill="#0e0e0e" stroke-linejoin="round"/>'),
    unavailable: disc('#E03030', '<path d="M6.5 12h11" stroke="#0e0e0e" stroke-width="3" stroke-linecap="round"/>')
  };
  U.STATUS_LABEL = { available: 'Available', driving: 'Driving', resting: 'Resting', sleeping: 'Sleeping', offline: 'Offline', flag: 'Flag duty', unavailable: 'Unavailable', mechanic: 'Available - in the garage', refuel: 'Available - refuel crew for the next stop' };
  U.presence = function (st) { return '<span class="presence" title="' + U.esc(U.STATUS_LABEL[st] || st) + '">' + (P[st] || P.offline) + '</span>'; };

  // BTTM colour band
  U.band = function (v, t) { if (v == null || !t) return ''; if (v > t[3]) return 'b4'; if (v > t[2]) return 'b3'; if (v > t[1]) return 'b2'; if (v > t[0]) return 'b1'; return 'b0'; };

  // toasts + sound
  var muted = false, actx = null;
  U.setMuted = function (m) { muted = m; };
  U.beep = function (level) {
    if (muted) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = level === 'crit' ? 880 : 660;
      g.gain.setValueAtTime(0.0001, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.12, actx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + (level === 'crit' ? 0.5 : 0.25));
      o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.55);
    } catch (e) { /* audio blocked until first click */ }
  };
  U.toast = function (text, level, ts, sound) {
    var box = document.getElementById('toasts');
    var el = document.createElement('div');
    el.className = 'toast ' + (level || 'info');
    el.innerHTML = '<div class="t">' + U.clock(ts || Date.now(), true) + '</div>' + U.esc(text);
    el.onclick = function () { el.remove(); };
    box.appendChild(el);
    while (box.children.length > 5) box.removeChild(box.firstChild);
    setTimeout(function () { el.remove(); }, level === 'crit' ? 25000 : level === 'warn' ? 15000 : 9000);
    if (sound !== false && level !== 'info') U.beep(level);
  };
  U.modal = function (html) { document.getElementById('modal-body').innerHTML = html; document.getElementById('modal').hidden = false; };
  U.closeModal = function () { document.getElementById('modal').hidden = true; document.getElementById('modal-body').innerHTML = ''; };
  U.download = function (name, text, type) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type || 'application/json' })); a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  };
  window.U = U;
})();
