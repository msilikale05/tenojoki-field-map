/* Tenojoki field tools: track recording, waypoints & notes, compass, share / safety.
   Everything is stored on the phone (IndexedDB) and works offline. */
(() => {
  // ---------- tiny IndexedDB store
  const DB = new Promise((ok, bad) => {
    const r = indexedDB.open("teno-field", 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("tracks", { keyPath: "id" }); d.createObjectStore("points", { keyPath: "id" }); };
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  });
  const tx = async (store, mode, fn) => { const d = await DB; return new Promise((ok, bad) => {
    const t = d.transaction(store, mode), s = t.objectStore(store), req = fn(s); t.oncomplete = () => ok(req && req.result); t.onerror = () => bad(t.error); }); };
  const put = (s, v) => tx(s, "readwrite", st => st.put(v));
  const del = (s, k) => tx(s, "readwrite", st => st.delete(k));
  const all = s => tx(s, "readonly", st => st.getAll());
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  const $ = s => document.querySelector(s);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const hav = (a, b) => map.distance([a[0], a[1]], [b[0], b[1]]);
  const hhmm = ms => { const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${m} min` : `${m} min ${s % 60} s`; };
  const km = m => m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m";
  const stamp = t => new Date(t).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // keep toolbar just above the readout panel
  const ro = $("#readout"); new ResizeObserver(() => document.documentElement.style.setProperty("--ro", ro.offsetHeight + "px")).observe(ro);

  // ---------- bottom sheet
  const sheet = document.createElement("div"); sheet.className = "sheet"; document.body.appendChild(sheet);
  let tab = "tracks";
  const openSheet = t => { tab = t || tab; sheet.classList.add("open"); render(); };
  const closeSheet = () => sheet.classList.remove("open");
  $("#btnTools").onclick = () => sheet.classList.contains("open") ? closeSheet() : openSheet();
  async function render() {
    const tabs = `<div class="row"><b>Field tools</b><span class="muted" style="cursor:pointer;font-size:15px" id="shClose">✕ close</span></div>
      <div class="tabs">${[["tracks", "Tracks"], ["points", "Points"], ["share", "Share & safety"]].map(([k, l]) => `<button data-t="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join("")}</div>`;
    let body = "";
    if (tab === "tracks") body = await renderTracks(); else if (tab === "points") body = await renderPoints(); else body = renderShare();
    sheet.innerHTML = tabs + body;
    $("#shClose").onclick = closeSheet;
    sheet.querySelectorAll(".tabs button").forEach(b => b.onclick = () => { tab = b.dataset.t; render(); });
    sheet.querySelectorAll("[data-act]").forEach(b => b.onclick = () => actions[b.dataset.act](b.dataset.id, b));
  }

  // ---------- GPS fan-out
  let pos = null;                                       // latest GeolocationPosition
  document.addEventListener("gps", e => { pos = e.detail; onTrackPos(pos); updateHeadingMarker(); updateArrow(); });
  const needGPS = () => { if (!pos) startGPS(); return !!pos; };

  // =========================================================== TRACKS
  let rec = null, recLine = null, wake = null;          // rec = {id,name,start,pts:[[lat,lon,alt,t,acc]],dist,gain,paused,pausedMs,pauseAt}
  const trackLayers = {};                               // id -> polyline shown on map
  const recBtn = $("#btnRec");
  async function keepAwake(on) { try { if (on && "wakeLock" in navigator) wake = await navigator.wakeLock.request("screen"); else if (wake) { await wake.release(); wake = null; } } catch {} }
  document.addEventListener("visibilitychange", () => { if (rec && !rec.paused && document.visibilityState === "visible") keepAwake(true); });
  recBtn.onclick = () => { if (!rec) startRec(); else openSheet("tracks"); };
  function startRec() {
    startGPS();
    rec = { id: uid(), name: "Track " + stamp(Date.now()), start: Date.now(), pts: [], dist: 0, gain: 0, paused: false, pausedMs: 0 };
    recLine = L.polyline([], { color: "#e63946", weight: 4, opacity: .9 }).addTo(map);
    recBtn.classList.add("on"); recBtn.textContent = "■ REC 0 m"; keepAwake(true); put("tracks", rec);
    toast("Recording track — keep this page open");
  }
  function onTrackPos(p) {
    if (!rec || rec.paused) return;
    const c = p.coords; if (c.accuracy > 50) return;                       // ignore poor fixes
    const ll = [c.latitude, c.longitude], prev = rec.pts[rec.pts.length - 1];
    if (prev) { const d = hav(prev, ll); if (d < Math.max(4, c.accuracy / 3)) return; rec.dist += d;
      if (c.altitude != null && prev[2] != null && c.altitude - prev[2] > 2) rec.gain += c.altitude - prev[2]; }
    rec.pts.push([+ll[0].toFixed(6), +ll[1].toFixed(6), c.altitude != null ? Math.round(c.altitude) : null, Date.now(), Math.round(c.accuracy)]);
    recLine.addLatLng(ll); recBtn.textContent = "■ REC " + km(rec.dist);
    if (rec.pts.length % 5 === 1) put("tracks", rec);                       // save regularly (crash-safe)
    if (sheet.classList.contains("open") && tab === "tracks") render();
  }
  const moving = r => (r.end || Date.now()) - r.start - r.pausedMs - (r.paused && r.pauseAt ? Date.now() - r.pauseAt : 0);
  async function renderTracks() {
    const list = (await all("tracks")).filter(t => !rec || t.id !== rec.id).sort((a, b) => b.start - a.start);
    let h = "";
    if (rec) { const ms = moving(rec), spd = ms > 0 ? rec.dist / (ms / 3600000) / 1000 : 0;
      h += `<div class="item" style="border-color:#e63946"><b>● ${rec.paused ? "Paused" : "Recording"} — ${esc(rec.name)}</b>
        <div class="stats"><div><b>${km(rec.dist)}</b><span class="muted">distance</span></div><div><b>${hhmm(ms)}</b><span class="muted">moving time</span></div><div><b>${spd.toFixed(1)}</b><span class="muted">km/h avg</span></div></div>
        <div class="muted">${rec.pts.length} points · elevation gain ${Math.round(rec.gain)} m</div>
        <div class="acts"><button data-act="pause">${rec.paused ? "▶ Resume" : "❚❚ Pause"}</button><button class="btn danger" data-act="stop">■ Stop & save</button></div></div>`; }
    else h += `<button class="btn primary" style="width:100%;padding:11px" data-act="startrec">● Start recording a track</button>
      <div class="muted" style="margin-top:6px">Keep the screen on while recording: phones pause GPS for web pages when locked.</div>`;
    h += `<div style="margin-top:10px"><b>Saved tracks</b> <span class="muted">(${list.length})</span></div>`;
    if (!list.length) h += `<div class="muted">No saved tracks yet.</div>`;
    for (const t of list) h += `<div class="item"><div class="row"><b>${esc(t.name)}</b><span class="muted">${stamp(t.start)}</span></div>
      <div class="muted">${km(t.dist)} · ${hhmm(moving(t))} · gain ${Math.round(t.gain)} m · ${t.pts.length} pts</div>
      <div class="acts"><button data-act="showtrk" data-id="${t.id}">${trackLayers[t.id] ? "Hide" : "Show"}</button><button data-act="gpx" data-id="${t.id}">GPX</button>
      <button data-act="geojson" data-id="${t.id}">GeoJSON</button><button data-act="rentrk" data-id="${t.id}">Rename</button><button class="btn danger" data-act="deltrk" data-id="${t.id}">Delete</button></div></div>`;
    if (list.length) h += `<button class="btn" style="margin-top:4px" data-act="gpxall">Export all tracks + points (GPX)</button>`;
    return h;
  }

  // =========================================================== POINTS
  const CATS = { sample: ["Sample site", "#2a6fb0", "S"], obs: ["Observation", "#2b9348", "O"], photo: ["Photo point", "#7b2cbf", "P"],
                 hazard: ["Hazard", "#e63946", "!"], access: ["Parking / access", "#5d6b78", "A"], camp: ["Camp", "#e8891c", "C"], other: ["Other", "#1f3346", "•"] };
  const ptLayer = L.layerGroup().addTo(map); const ptMarkers = {};
  const ptIcon = c => L.divIcon({ className: "", iconSize: [26, 26], iconAnchor: [13, 26], popupAnchor: [0, -24],
    html: `<div style="width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${CATS[c][1]};border:2px solid #fff;box-shadow:0 2px 5px #0006;display:flex;align-items:center;justify-content:center"><span style="transform:rotate(45deg);color:#fff;font:700 12px sans-serif">${CATS[c][2]}</span></div>` });
  async function drawPoints() {
    ptLayer.clearLayers(); for (const p of await all("points")) {
      const m = L.marker([p.lat, p.lon], { icon: ptIcon(p.cat) }).addTo(ptLayer); ptMarkers[p.id] = m;
      m.bindPopup(() => { const u = toUTM([p.lat, p.lon]); return `<b>${esc(p.name || CATS[p.cat][0])}</b> <span class="muted">${CATS[p.cat][0]}</span><br>
        ${p.note ? esc(p.note) + "<br>" : ""}${p.photo ? `<img src="${URL.createObjectURL(p.photo)}" style="max-width:220px;border-radius:8px;margin:4px 0"><br>` : ""}
        <span class="mono">${p.lat.toFixed(5)}° N ${p.lon.toFixed(5)}° E<br>UTM 35W ${fmt(u[0])} E ${fmt(u[1])} N</span><br><span class="muted">${stamp(p.t)}${p.acc ? " · ±" + p.acc + " m" : ""}</span><br>
        <button class="popbtn" onclick="setTarget(${p.lat},${p.lon},'${esc(p.name || CATS[p.cat][0]).replace(/'/g, "")}')">Navigate here</button>
        <button class="popbtn" style="background:#5d6b78" onclick="editPoint('${p.id}')">Edit</button>`; });
    }
  }
  drawPoints();
  $("#btnPin").onclick = () => { if (!pos) { startGPS(); toast("Waiting for GPS… tap again, or tap the map to place a point"); return; }
    pointForm({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: Math.round(pos.coords.accuracy), alt: pos.coords.altitude != null ? Math.round(pos.coords.altitude) : null }); };
  window.addPointAt = (lat, lon) => { map.closePopup(); pointForm({ lat, lon, acc: null, alt: null }); };
  window.editPoint = async id => { map.closePopup(); const p = (await all("points")).find(x => x.id === id); if (p) pointForm(p); };
  async function shrink(file) {                         // resize photos to max 1600 px, JPEG
    const img = await createImageBitmap(file); const k = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); return new Promise(ok => c.toBlob(ok, "image/jpeg", .8));
  }
  function pointForm(p) {
    const isNew = !p.id; tab = "points";
    sheet.innerHTML = `<div class="row"><b>${isNew ? "New point" : "Edit point"}</b><span class="muted" style="cursor:pointer" id="pfX">✕ cancel</span></div>
      <div class="muted mono">${p.lat.toFixed(5)}° N ${p.lon.toFixed(5)}° E${p.acc ? " · ±" + p.acc + " m" : ""}</div>
      <div class="form"><label>Category</label><select id="pfCat">${Object.entries(CATS).map(([k, v]) => `<option value="${k}" ${p.cat === k ? "selected" : ""}>${v[0]}</option>`).join("")}</select>
      <label>Name / ID</label><input type="text" id="pfName" value="${esc(p.name)}" placeholder="e.g. S-01">
      <label>Note</label><textarea id="pfNote" rows="3" placeholder="What did you find here?">${esc(p.note)}</textarea>
      <label>Photo</label><input type="file" id="pfPhoto" accept="image/*" capture="environment">${p.photo ? '<div class="muted">A photo is attached; choose a new one to replace it.</div>' : ""}</div>
      <div class="acts" style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" id="pfSave" style="flex:1;padding:11px">Save point</button>${isNew ? "" : '<button class="btn danger" id="pfDel">Delete</button>'}</div>`;
    sheet.classList.add("open");
    $("#pfX").onclick = () => render();
    $("#pfSave").onclick = async () => {
      const f = $("#pfPhoto").files[0];
      const rec2 = { ...p, id: p.id || uid(), t: p.t || Date.now(), cat: $("#pfCat").value, name: $("#pfName").value.trim(), note: $("#pfNote").value.trim(), photo: f ? await shrink(f) : (p.photo || null) };
      await put("points", rec2); await drawPoints(); toast("Point saved"); render();
    };
    if (!isNew) $("#pfDel").onclick = async () => { if (confirm("Delete this point?")) { await del("points", p.id); await drawPoints(); render(); } };
  }
  async function renderPoints() {
    const list = (await all("points")).sort((a, b) => b.t - a.t);
    let h = `<button class="btn primary" style="width:100%;padding:11px" data-act="newpt">＋ Add point at my position</button>
      <div class="muted" style="margin-top:6px">Or tap anywhere on the map → “Add point here”.</div>
      <div style="margin-top:10px"><b>Saved points</b> <span class="muted">(${list.length})</span></div>`;
    if (!list.length) h += `<div class="muted">No points yet.</div>`;
    for (const p of list) { const d = pos ? " · " + km(hav([pos.coords.latitude, pos.coords.longitude], [p.lat, p.lon])) + " away" : "";
      h += `<div class="item"><div class="row"><b><span style="color:${CATS[p.cat][1]}">●</span> ${esc(p.name || CATS[p.cat][0])}</b><span class="muted">${stamp(p.t)}</span></div>
        <div class="muted">${CATS[p.cat][0]}${d}${p.photo ? " · 📷" : ""}</div>${p.note ? `<div>${esc(p.note)}</div>` : ""}
        <div class="acts"><button data-act="gopt" data-id="${p.id}">Show</button><button data-act="navpt" data-id="${p.id}">Navigate</button><button data-act="editpt" data-id="${p.id}">Edit</button></div></div>`; }
    if (list.length) h += `<div class="acts" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><button class="btn" data-act="ptgeojson">GeoJSON</button><button class="btn" data-act="ptcsv">CSV</button>
      <button class="btn" data-act="gpxall">GPX</button><button class="btn" data-act="ptphotos">Photos</button></div>`;
    return h;
  }

  // =========================================================== EXPORT helpers
  async function save(name, text, type) {
    const file = new File([text], name, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === "AbortError") return; } }
    const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const iso = t => new Date(t).toISOString();
  const gpxDoc = (tracks, points) => `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Tenojoki field map" xmlns="http://www.topografix.com/GPX/1/1">
${points.map(p => `<wpt lat="${p.lat}" lon="${p.lon}">${p.alt != null ? `<ele>${p.alt}</ele>` : ""}<time>${iso(p.t)}</time><name>${esc(p.name || CATS[p.cat][0])}</name><desc>${esc(p.note)}</desc><type>${CATS[p.cat][0]}</type></wpt>`).join("\n")}
${tracks.map(t => `<trk><name>${esc(t.name)}</name><trkseg>${t.pts.map(q => `<trkpt lat="${q[0]}" lon="${q[1]}">${q[2] != null ? `<ele>${q[2]}</ele>` : ""}<time>${iso(q[3])}</time></trkpt>`).join("")}</trkseg></trk>`).join("\n")}
</gpx>`;
  const fileDate = () => new Date().toISOString().slice(0, 10);
  const ptFeature = p => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { id: p.id, name: p.name, category: CATS[p.cat][0], note: p.note,
    time: iso(p.t), accuracy_m: p.acc, altitude_m: p.alt, utm35_e: Math.round(toUTM([p.lat, p.lon])[0]), utm35_n: Math.round(toUTM([p.lat, p.lon])[1]), photo: p.photo ? `photo_${p.id}.jpg` : null } });

  // =========================================================== ACTIONS
  const actions = {
    startrec: () => { startRec(); render(); },
    pause: () => { if (rec.paused) { rec.pausedMs += Date.now() - rec.pauseAt; rec.paused = false; keepAwake(true); } else { rec.paused = true; rec.pauseAt = Date.now(); keepAwake(false); } put("tracks", rec); render(); },
    stop: async () => { if (rec.paused) rec.pausedMs += Date.now() - rec.pauseAt; rec.paused = false; rec.end = Date.now(); await put("tracks", rec);
      trackLayers[rec.id] = recLine.setStyle({ color: "#7b2cbf", weight: 3 }); toast(`Track saved: ${km(rec.dist)}`);
      rec = null; recLine = null; keepAwake(false); recBtn.classList.remove("on"); recBtn.textContent = "● REC"; render(); },
    showtrk: async id => { if (trackLayers[id]) { map.removeLayer(trackLayers[id]); delete trackLayers[id]; }
      else { const t = (await all("tracks")).find(x => x.id === id); if (t && t.pts.length) { trackLayers[id] = L.polyline(t.pts.map(q => [q[0], q[1]]), { color: "#7b2cbf", weight: 3 }).addTo(map); map.fitBounds(trackLayers[id].getBounds(), { padding: [30, 30] }); } }
      render(); },
    rentrk: async id => { const t = (await all("tracks")).find(x => x.id === id); const n = prompt("Track name", t.name); if (n) { t.name = n; await put("tracks", t); render(); } },
    deltrk: async id => { if (!confirm("Delete this track?")) return; if (trackLayers[id]) { map.removeLayer(trackLayers[id]); delete trackLayers[id]; } await del("tracks", id); render(); },
    gpx: async id => { const t = (await all("tracks")).find(x => x.id === id); save(`${t.name.replace(/[^\w-]+/g, "_")}.gpx`, gpxDoc([t], []), "application/gpx+xml"); },
    geojson: async id => { const t = (await all("tracks")).find(x => x.id === id);
      save(`${t.name.replace(/[^\w-]+/g, "_")}.geojson`, JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { name: t.name, start: iso(t.start), end: t.end ? iso(t.end) : null, distance_m: Math.round(t.dist), elevation_gain_m: Math.round(t.gain) },
        geometry: { type: "LineString", coordinates: t.pts.map(q => q[2] != null ? [q[1], q[0], q[2]] : [q[1], q[0]]) } }] }), "application/geo+json"); },
    gpxall: async () => save(`tenojoki_field_${fileDate()}.gpx`, gpxDoc((await all("tracks")).filter(t => t.pts.length), await all("points")), "application/gpx+xml"),
    newpt: () => $("#btnPin").onclick(),
    gopt: async id => { const p = (await all("points")).find(x => x.id === id); closeSheet(); map.setView([p.lat, p.lon], Math.max(map.getZoom(), 14)); ptMarkers[id]?.openPopup(); },
    navpt: async id => { const p = (await all("points")).find(x => x.id === id); closeSheet(); setTarget(p.lat, p.lon, p.name || CATS[p.cat][0]); },
    editpt: id => editPoint(id),
    ptgeojson: async () => save(`tenojoki_points_${fileDate()}.geojson`, JSON.stringify({ type: "FeatureCollection", features: (await all("points")).map(ptFeature) }, null, 1), "application/geo+json"),
    ptcsv: async () => { const rows = (await all("points")).map(ptFeature).map(f => { const p = f.properties; return [p.id, p.name, p.category, f.geometry.coordinates[1], f.geometry.coordinates[0], p.utm35_e, p.utm35_n, p.altitude_m ?? "", p.accuracy_m ?? "", p.time, p.photo ?? "", p.note]; });
      const csv = [["id", "name", "category", "lat", "lon", "utm35_e", "utm35_n", "altitude_m", "accuracy_m", "time", "photo", "note"], ...rows].map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
      save(`tenojoki_points_${fileDate()}.csv`, csv, "text/csv"); },
    ptphotos: async () => { const ps = (await all("points")).filter(p => p.photo); if (!ps.length) return toast("No photos saved");
      const files = ps.map(p => new File([p.photo], `photo_${p.id}.jpg`, { type: "image/jpeg" }));
      if (navigator.canShare && navigator.canShare({ files })) { try { await navigator.share({ files }); return; } catch {} }
      for (const f of files) { const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); await new Promise(r => setTimeout(r, 300)); } },
    share: () => sharePos(), copy: () => sharePos(true),
    battery: (_, b) => { const low = !(window.gpsOptions && !window.gpsOptions.enableHighAccuracy);
      window.gpsOptions = low ? { enableHighAccuracy: false, maximumAge: 30000, timeout: 60000 } : { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 };
      if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; startGPS(); }
      toast(low ? "Battery saver on: GPS updates less often" : "High-accuracy GPS on"); render(); },
  };

  // =========================================================== SHARE & SAFETY
  function posText() {
    if (!pos) return null; const c = pos.coords, u = toUTM([c.latitude, c.longitude]);
    return `My position (Tenojoki fieldwork) ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}: ${c.latitude.toFixed(5)} N, ${c.longitude.toFixed(5)} E ` +
      `(${dms(c.latitude, "N", "S")} ${dms(c.longitude, "E", "W")}) · UTM 35W ${Math.round(u[0])} E ${Math.round(u[1])} N · ±${Math.round(c.accuracy)} m · https://maps.google.com/?q=${c.latitude.toFixed(5)},${c.longitude.toFixed(5)}`;
  }
  async function sharePos(copyOnly) {
    if (!needGPS()) return toast("Waiting for GPS… try again in a moment");
    const t = posText();
    if (copyOnly) { try { await navigator.clipboard.writeText(t); toast("Position copied"); } catch { prompt("Copy your position:", t); } return; }
    if (navigator.share) { try { await navigator.share({ text: t }); return; } catch (e) { if (e.name === "AbortError") return; } }
    location.href = "sms:?&body=" + encodeURIComponent(t);
  }
  function renderShare() {
    const t = posText(), enc = t ? encodeURIComponent(t) : "";
    const low = window.gpsOptions && !window.gpsOptions.enableHighAccuracy;
    return `<b>Send my position</b><div class="muted" style="margin:4px 0 8px">A text message works with very weak signal; the message includes coordinates and a map link.</div>
      ${t ? `<div class="item mono" style="font-size:12px">${esc(t)}</div>` : `<div class="muted">GPS not ready yet — tap ◎ first.</div>`}
      <div class="acts" style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn primary" data-act="share">Share…</button>
        <a class="btn" style="text-decoration:none" href="${t ? "sms:?&body=" + enc : "#"}">SMS</a>
        <a class="btn" style="text-decoration:none" target="_blank" rel="noopener" href="${t ? "https://wa.me/?text=" + enc : "#"}">WhatsApp</a>
        <button class="btn" data-act="copy">Copy</button></div>
      <div style="margin-top:14px"><b>Emergency</b></div>
      <div class="item"><div class="row"><b>112</b><a class="btn danger" style="text-decoration:none" href="tel:112">Call 112</a></div>
        <div class="muted">General emergency number in both Finland and Norway (police, ambulance, fire, rescue). Tell them your coordinates from the panel below the map.</div>
        <div class="muted" style="margin-top:4px">Norway also: 113 medical · 110 fire · 112 police. Finland: the “112 Suomi” app sends your location automatically.</div></div>
      <div style="margin-top:12px"><b>Battery</b></div>
      <div class="item"><div class="row"><span>${low ? "Battery saver is <b>on</b>" : "High-accuracy GPS is <b>on</b>"}</span><button class="btn" data-act="battery">${low ? "Use high accuracy" : "Battery saver"}</button></div>
        <div class="muted">Battery saver updates less often and may be less accurate. Lower screen brightness helps most. The saved Tenojoki map (⤓) uses no mobile data.</div></div>`;
  }

  // =========================================================== COMPASS
  let heading = null, compassOn = false;
  const cBtn = $("#btnCompass");
  function onOrient(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;          // iOS
    else if (e.absolute && e.alpha != null) h = (360 - e.alpha) % 360;                     // Android absolute
    if (h == null) return;
    const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0; heading = (h + so + 360) % 360;
    updateHeadingMarker(); updateArrow();
  }
  cBtn.onclick = async () => {
    if (compassOn) { compassOn = false; heading = null; cBtn.classList.remove("on"); window.removeEventListener("deviceorientationabsolute", onOrient); window.removeEventListener("deviceorientation", onOrient); updateHeadingMarker(); updateArrow(); return toast("Compass off"); }
    try { if (typeof DeviceOrientationEvent !== "undefined" && DeviceOrientationEvent.requestPermission) { const r = await DeviceOrientationEvent.requestPermission(); if (r !== "granted") return toast("Compass permission denied"); } } catch { return toast("Compass not available"); }
    window.addEventListener("ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation", onOrient);
    compassOn = true; cBtn.classList.add("on"); startGPS(); toast("Compass on — hold the phone flat, away from metal");
  };
  function currentHeading() {           // compass when on, otherwise GPS course while moving
    if (heading != null) return heading;
    if (pos && pos.coords.heading != null && !isNaN(pos.coords.heading) && (pos.coords.speed || 0) > 0.7) return pos.coords.heading;
    return null;
  }
  function updateHeadingMarker() {
    if (!me) return; const h = currentHeading(), el = me.getElement(); if (!el) return;
    let cone = el.querySelector(".head");
    if (h == null) { if (cone) cone.remove(); return; }
    if (!cone) { cone = document.createElement("div"); cone.className = "head"; el.firstChild.appendChild(cone); el.firstChild.style.position = "relative"; }
    cone.style.transform = `rotate(${h}deg)`;
  }
  // direction arrow inside the navigation box
  function updateArrow() {
    const box = $("#rTarget"); if (!target || !pos || box.style.display === "none") return;
    const h = currentHeading(), b = bearing([pos.coords.latitude, pos.coords.longitude], target.ll);
    let a = box.querySelector(".navarrow");
    if (!a) { a = document.createElement("div"); a.className = "navarrow"; a.style.cssText = "display:flex;align-items:center;gap:10px;margin-top:6px"; box.appendChild(a); }
    if (h == null) { a.innerHTML = `<span class="muted">Turn on 🧭 compass (or start walking) for a direction arrow.</span>`; return; }
    let rel = ((b - h + 540) % 360) - 180, side = Math.abs(rel) < 8 ? "straight ahead" : `${Math.round(Math.abs(rel))}° ${rel > 0 ? "right" : "left"}`;
    a.innerHTML = `<div style="width:44px;height:44px;border-radius:50%;background:#1f3346;display:flex;align-items:center;justify-content:center;transform:rotate(${rel}deg)"><div style="width:0;height:0;border-left:9px solid transparent;border-right:9px solid transparent;border-bottom:20px solid #fff"></div></div>
      <div><b>${side}</b><div class="muted">heading ${Math.round(h)}° · target bearing ${Math.round(b)}°</div></div>`;
  }
  // re-draw arrow after the main navigation box refreshes
  const _ut = window.updateTarget; if (typeof updateTarget === "function") {
    const box = $("#rTarget"); new MutationObserver(() => { if (!box.querySelector(".navarrow")) updateArrow(); }).observe(box, { childList: true });
  }

  // resume an unfinished recording after a reload/crash
  all("tracks").then(ts => { const open = ts.find(t => !t.end && t.pts.length);
    if (open && confirm(`Resume unfinished track “${open.name}” (${km(open.dist)})?`)) { rec = open; rec.paused = false;
      recLine = L.polyline(open.pts.map(q => [q[0], q[1]]), { color: "#e63946", weight: 4 }).addTo(map); recBtn.classList.add("on"); recBtn.textContent = "■ REC " + km(rec.dist); startGPS(); keepAwake(true); }
    else if (open) { open.end = open.pts[open.pts.length - 1][3]; put("tracks", open); } });
})();
