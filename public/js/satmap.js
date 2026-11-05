/* Orb satellite track map (Leaflet, bundled in /vendor so it works offline).
   One persistent map, moved into the Track card's #mm-sat holder whenever the card redraws, so the card's
   HTML-replacing render loop never destroys it. Imagery comes from the pit wall laptop's tile cache (/tiles/z/x/y),
   which fetches from the provider while online. The overlays are the same geometry the schematic draws (V.mapGeometry). */
(function () {
  'use strict';
  var Sat = {}, L = window.L;
  var map = null, el = null, tiles = null, over = null, car = null, trailLine = null, ctl = null;
  var sig = null, follow = false, userMoved = false, centred = false, src = { url: '', maxZoom: 19, attribution: '' };
  var ok = 0, err = 0, downSince = 0, health = null;
  var RETRY_MS = 60000;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function tileUrl() { var h = 0, s = src.url || ''; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return '/tiles/{z}/{x}/{y}?s=' + (h >>> 0).toString(36) + '.2'; }

  // no imagery at all (every tile failed, none loaded) -> the card falls back to the schematic for a minute, then retries
  Sat.unavailable = function () { return downSince && Date.now() - downSince < RETRY_MS ? 'offline' : false; };
  Sat.retry = function () { downSince = 0; };
  function checkHealth() {
    ok = 0; err = 0; clearTimeout(health);
    health = setTimeout(function () { if (ok === 0 && err > 0) downSince = Date.now(); }, 8000);
  }

  Sat.setSource = function (s) {
    if (!s) return;
    var changed = s.url !== src.url || s.maxZoom !== src.maxZoom || s.attribution !== src.attribution;
    src = { url: s.url, maxZoom: s.maxZoom || 19, attribution: s.attribution || '' };
    if (tiles && changed) {
      map.removeLayer(tiles); tiles = null; makeTiles(); downSince = 0; checkHealth();
    }
  };
  function makeTiles() {
    tiles = L.tileLayer(tileUrl(), { maxNativeZoom: src.maxZoom, maxZoom: 21, attribution: src.attribution, className: 'sat-tiles', keepBuffer: 3 }).addTo(map);
    tiles.bringToBack();
    var byZ = {};
    tiles.on('tileload', function (e) { ok++; var z = e.coords.z; (byZ[z] = byZ[z] || { ok: 0, err: 0 }).ok++; });
    tiles.on('tileerror', function (e) {
      err++;
      // the provider has no imagery at this zoom here (the server answers 404 for its placeholders):
      // step down to the zoom below and stretch its tiles instead of showing blanks
      var z = e.coords.z, s = byZ[z] = byZ[z] || { ok: 0, err: 0 }; s.err++;
      if (s.err >= 3 && !s.ok && z > 14 && tiles.options.maxNativeZoom >= z) { tiles.options.maxNativeZoom = z - 1; setTimeout(function () { tiles.redraw(); }, 0); }
    });
  }

  function create() {
    el = document.createElement('div'); el.className = 'satmap';
    map = L.map(el, { zoomControl: true, scrollWheelZoom: false, zoomSnap: 0.25, maxZoom: 21, attributionControl: true });
    map.setView([0, 0], 2);   // vector layers need a view before they are added; fit() moves to the track straight after
    makeTiles();
    over = L.layerGroup().addTo(map);
    trailLine = L.polyline([], { color: '#ffffff', opacity: 0.6, weight: 3, interactive: false }).addTo(map);
    car = L.circleMarker([0, 0], { radius: 7, color: '#000', weight: 2, fillColor: '#00C846', fillOpacity: 1, opacity: 0, interactive: false }).addTo(map);
    car.setStyle({ fillOpacity: 0 });
    // Fit / Follow buttons
    var C = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        var d = L.DomUtil.create('div', 'leaflet-bar sat-ctl');
        d.innerHTML = '<a href="#" role="button" data-sat="fit" title="Fit the whole track">Fit</a><a href="#" role="button" data-sat="follow" title="Keep the car centred">Follow</a>';
        L.DomEvent.disableClickPropagation(d);
        L.DomEvent.on(d, 'click', function (e) {
          L.DomEvent.preventDefault(e);
          var a = e.target.getAttribute('data-sat');
          if (a === 'fit') { follow = false; userMoved = false; fit(window.PWMapGeo); }
          if (a === 'follow') { follow = !follow; if (follow && car.getLatLng().lat) map.panTo(car.getLatLng()); }
          paintCtl();
        });
        return d;
      }
    });
    ctl = new C(); map.addControl(ctl);
    map.on('dragstart', function () { userMoved = true; follow = false; paintCtl(); });
    // turn numbers only when zoomed in enough to read them
    map.on('zoomend', function () { el.classList.toggle('far', map.getZoom() < 15); });
    if (window.ResizeObserver) new ResizeObserver(function () { map.invalidateSize(); }).observe(el);
    checkHealth();
  }
  function paintCtl() { var b = el && el.querySelector('[data-sat="follow"]'); if (b) b.classList.toggle('on', follow); }

  function fit(g) {
    if (!g || !map.getSize().x) return;
    var pts = g.pts.length >= 2 ? g.pts : g.trail;
    if (pts.length >= 2) { map.fitBounds(L.latLngBounds(pts), { padding: [14, 14] }); centred = true; }
  }

  function draw(g) {
    over.clearLayers();
    g.zones.forEach(function (z) {
      if (z.v.length >= 3) L.polygon(z.v, { color: z.c, weight: 1.5, opacity: 0.9, fillColor: z.c, fillOpacity: 0.22 }).bindTooltip(esc(z.label), { sticky: true }).addTo(over);
      else if (z.v.length === 2) L.polyline(z.v, { color: z.c, weight: 4 }).bindTooltip(esc(z.label), { sticky: true }).addTo(over);
    });
    if (g.pit) {
      if (g.pit.areas) {
        L.polygon(g.pit.pits, { color: '#4fc3f7', weight: 1.5, fillOpacity: 0.22 }).bindTooltip('Pits', { sticky: true }).addTo(over);
        L.polygon(g.pit.fuel, { color: '#CE93D8', weight: 1.5, fillOpacity: 0.26 }).bindTooltip('Fuel area', { sticky: true }).addTo(over);
        L.polyline(g.pit.entry, { color: '#FFA500', weight: 4 }).bindTooltip('Pit entry', { sticky: true }).addTo(over);
        L.polyline(g.pit.exit, { color: '#FFD54F', weight: 4 }).bindTooltip('Pit exit', { sticky: true }).addTo(over);
      }
      L.polyline(g.pit.lane, { color: '#b39ddb', weight: 2, dashArray: '5 4', interactive: false }).addTo(over);
    }
    if (g.path.length) {
      var loop = g.path.concat([g.path[0]]);
      L.polyline(loop, { color: '#000', weight: 5, opacity: 0.35, interactive: false }).addTo(over);
      L.polyline(loop, { color: '#ffffff', weight: 2, opacity: 0.85, interactive: false }).addTo(over);
    }
    if (g.sfLine) L.polyline(g.sfLine, { color: '#fff', weight: 3 }).bindTooltip('Start / finish line', { sticky: true }).addTo(over);
    if (g.sf) L.circleMarker(g.sf, { radius: 4, color: '#000', weight: 1, fillColor: '#fff', fillOpacity: 1 }).bindTooltip('Start / finish').addTo(over);
    g.turns.forEach(function (t) {
      L.marker(t.p, { interactive: false, keyboard: false, icon: L.divIcon({ className: 'sat-turn', html: esc(t.n), iconSize: [26, 14], iconAnchor: [13, -5] }) }).addTo(over);
    });
  }

  // called after every render: put the map in the card's holder and redraw the overlays when the geometry changed
  Sat.mount = function () {
    var holder = document.getElementById('mm-sat'), g = window.PWMapGeo;
    if (!holder || !g || !L) return;
    if (!map) create();
    if (el.parentNode !== holder) {
      holder.appendChild(el);
      map.invalidateSize();   // created detached (size 0): measure now, before fitting
      if (downSince) { downSince = 0; tiles.redraw(); }   // back after the retry wait: try the imagery again
      checkHealth();
      if (!centred) fit(g);
    }
    if (g.sig !== sig) { sig = g.sig; draw(g); if (!userMoved) fit(g); }
    if (!g.path.length && !userMoved) follow = true;
    paintCtl();
  };

  // live car position: pos {lat, lon}, fill colour, recent trail [[lat, lon]], stale
  Sat.update = function (pos, colour, trail, stale) {
    if (!map || !el.isConnected || !pos) return;
    var ll = L.latLng(pos.lat, pos.lon);
    car.setLatLng(ll); car.setStyle({ opacity: 1, fillOpacity: 1, fillColor: stale ? '#555' : colour });
    car.bringToFront();
    trailLine.setLatLngs(trail);
    if (!centred) { map.setView(ll, Math.min(17, src.maxZoom)); centred = true; }
    else if (follow) map.panTo(ll, { animate: false });
  };

  window.OrbSat = Sat;
})();
