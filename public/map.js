const mapContainer = document.getElementById("map");
const pillsEl = document.getElementById("speciesPills");
const opacityInput = document.getElementById("opacity");
const staticOnlyInput = document.getElementById("staticOnly");
const dateSlider = document.getElementById("dateSlider");
const dateLabel = document.getElementById("dateLabel");
const sensInput = document.getElementById("sens");
const sensLabel = document.getElementById("sensLabel");
const trailsInput = document.getElementById("trails");
const hillshadeInput = document.getElementById("hillshade");
const expertInput = document.getElementById("expertMode");
const basemapButtons = Array.from(document.querySelectorAll(".bm"));
const metaEl = document.getElementById("meta");
const speciesInfo = document.getElementById("speciesInfo");
const savePngBtn = document.getElementById("savePng");
const inspectEl = document.getElementById("inspect");
const carBtn = document.getElementById("carBtn");
const carInfo = document.getElementById("carInfo");

let carMarker = null;
let carPos = null;
let lastUser = null;
try {
  carPos = JSON.parse(localStorage.getItem("mushroom-car") || "null");
} catch {}

const haversineM = (a, b) => {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const la1 = a[1] * rad;
  const la2 = b[1] * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const bearingDeg = (a, b) => {
  const rad = Math.PI / 180;
  const dLon = (b[0] - a[0]) * rad;
  const la1 = a[1] * rad;
  const la2 = b[1] * rad;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (Math.atan2(y, x) / rad + 360) % 360;
};
const compass = (deg) => ["N", "NÖ", "Ö", "SÖ", "S", "SV", "V", "NV"][Math.round(deg / 45) % 8];

function updateCarInfo() {
  if (!carInfo) return;
  if (!carPos) {
    carInfo.textContent = "";
    return;
  }
  if (lastUser) {
    const d = haversineM(lastUser, carPos);
    const b = bearingDeg(lastUser, carPos);
    carInfo.textContent = `🚗 ${d < 1000 ? Math.round(d) + " m" : (d / 1000).toFixed(1) + " km"} åt ${compass(b)}`;
  } else {
    carInfo.textContent = "🚗 bilposition sparad";
  }
}

function drawCar() {
  if (!map) return;
  if (carMarker) {
    carMarker.remove();
    carMarker = null;
  }
  if (carPos) {
    carMarker = new maplibregl.Marker({ color: "#1d4ed8" }).setLngLat(carPos).addTo(map);
  }
  updateCarInfo();
}

const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
const seasonLabel = (s) => `${MONTHS[Math.max(0, Math.ceil(s[0]) - 1)]}–${MONTHS[Math.min(11, Math.ceil(s[1]) - 1)]}`;

let speciesList = null;
let onSpeciesChange = null;
function applySpeciesList(list) {
  if (!Array.isArray(list) || list.length === 0) return;
  speciesList = list;
  pillsEl.innerHTML = "";
  for (const s of list) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pill" + (s.id === "kantarell" ? " on" : "");
    b.dataset.id = s.id;
    if (s.expertMode) b.dataset.expert = "1";
    b.title = `${s.label} — ätvärde ${s.eatScore}/5, säsong ${seasonLabel(s.season)}${s.protected ? " — FRIDLYST" : ""}${s.expertMode ? " — EXPERT (dödligt giftiga förväxlingar)" : ""}`;
    b.textContent = `${s.label.split(" (")[0]} ★${s.eatScore}${s.expertMode ? " ⚠" : ""}${s.protected ? " 🚫" : ""}`;
    b.addEventListener("click", () => {
      const wasOn = b.classList.contains("on");
      const on = Array.from(pillsEl.querySelectorAll("button.on"));
      if (wasOn && on.length === 1) return;
      if (!wasOn && on.length >= 4) {
        on[0].classList.remove("on");
      }
      b.classList.toggle("on");
      updateSpeciesInfo();
      onSpeciesChange?.();
    });
    pillsEl.appendChild(b);
  }
  refreshExpertVisibility();
  updateSpeciesInfo();
}

function refreshExpertVisibility() {
  const showExpert = expertInput && expertInput.checked;
  for (const b of Array.from(pillsEl.querySelectorAll("button.pill"))) {
    const isExpert = b.dataset.expert === "1";
    b.style.display = isExpert && !showExpert ? "none" : "";
    if (isExpert && !showExpert && b.classList.contains("on")) b.classList.remove("on");
  }
  if (Array.from(pillsEl.querySelectorAll("button.on")).length === 0) {
    const k = pillsEl.querySelector('button[data-id="kantarell"]');
    if (k) k.classList.add("on");
  }
}

function updateSpeciesInfo() {
  if (!speciesInfo) return;
  const sel = selectedSpecies()
    .map((id) => speciesList?.find((x) => x.id === id))
    .filter(Boolean);
  if (sel.length === 0) return;
  speciesInfo.textContent = sel
    .map((s) => `${s.label.split(" (")[0]}: ★${s.eatScore}/5 · ${seasonLabel(s.season)} — ${s.note}${s.protected ? " ⚠ FRIDLYST" : ""}${s.expertMode ? " ⚠ EXPERT" : ""}`)
    .join("\n");
  speciesInfo.classList.toggle("warn", sel.some((s) => s.protected || s.expertMode));
}

let map = null;
const TILE_V = "r15";

function selectedDate() {
  const days = Number(dateSlider.value);
  if (days === 0) return null;
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

function updateDateLabel() {
  dateLabel.textContent = selectedDate() ?? "nu";
}

function habitatTileUrl(speciesId) {
  const q = new URLSearchParams();
  if (staticOnlyInput.checked) q.set("static", "1");
  const d = selectedDate();
  if (d) q.set("date", d);
  q.set("sens", String(Number(sensInput.value)));
  q.set("v", TILE_V);
  return `/api/tiles/habitat/${speciesId}/{z}/{x}/{y}.png?${q.toString()}`;
}

function selectedSpecies() {
  const on = Array.from(pillsEl.querySelectorAll("button.on")).map((b) => b.dataset.id);
  return on.length > 0 ? on : ["kantarell"];
}

function rebuildHabitat() {
  if (!map) return;
  for (const l of map.getStyle().layers ?? []) {
    if (l.id.startsWith("habitat-")) {
      if (map.getLayer(l.id)) map.removeLayer(l.id);
      if (map.getSource(l.id.slice(8))) map.removeSource(l.id.slice(8));
    }
  }
  for (const sp of selectedSpecies()) {
    const srcId = "hab-" + sp;
    const layerId = "habitat-" + sp;
    map.addSource(srcId, {
      type: "raster",
      tiles: [habitatTileUrl(sp)],
      tileSize: 256,
      maxzoom: 16,
    });
    map.addLayer({
      id: layerId,
      type: "raster",
      source: srcId,
      paint: {
        "raster-opacity": Number(opacityInput.value) / 100,
        "raster-resampling": "linear",
      },
    });
  }
  if (map.getLayer("trails")) map.moveLayer("trails");
}

function setBasemap(name) {
  if (!map) return;
  for (const key of ["topo", "osm", "sat"]) {
    const layerId = "bm-" + key;
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", key === name ? "visible" : "none");
    }
  }
  for (const btn of basemapButtons) {
    btn.classList.toggle("active", btn.dataset.basemap === name);
  }
}

function updateTrails() {
  if (!map) return;
  if (trailsInput.checked) {
    if (!map.getSource("trails")) {
      map.addSource("trails", {
        type: "raster",
        tiles: ["https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 18,
        attribution:
          'Hiking trails: <a href="https://waymarkedtrails.org">Waymarked Trails</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (CC-BY-SA)',
      });
    }
    if (!map.getLayer("trails")) {
      map.addLayer({
        id: "trails",
        type: "raster",
        source: "trails",
        paint: { "raster-opacity": 0.85 },
      });
    }
    map.setLayoutProperty("trails", "visibility", "visible");
    map.moveLayer("trails");
  } else if (map.getLayer("trails")) {
    map.setLayoutProperty("trails", "visibility", "none");
  }
}

function updateHillshade() {
  if (!map) return;
  if (hillshadeInput.checked) {
    if (!map.getSource("hillshade")) {
      map.addSource("hillshade", {
        type: "raster",
        tiles: [`/api/tiles/hillshade/{z}/{x}/{y}.png?v=${TILE_V}`],
        tileSize: 256,
        maxzoom: 17,
      });
    }
    if (!map.getLayer("hillshade")) {
      map.addLayer({
        id: "hillshade",
        type: "raster",
        source: "hillshade",
        minzoom: 12,
        paint: { "raster-opacity": 0.35, "raster-resampling": "linear" },
      });
    }
    map.setLayoutProperty("hillshade", "visibility", "visible");
    const firstHabitat = (map.getStyle().layers ?? []).find((l) => l.id.startsWith("habitat-"));
    if (firstHabitat) map.moveLayer("hillshade", firstHabitat.id);
  } else if (map.getLayer("hillshade")) {
    map.setLayoutProperty("hillshade", "visibility", "none");
  }
}

async function refreshMeta() {
  const q = new URLSearchParams({ species: selectedSpecies()[0] });
  const d = selectedDate();
  if (d) q.set("date", d);
  try {
    const r = await fetch("/api/meta?" + q);
    if (!r.ok) return;
    const m = await r.json();
    if (m.speciesList) applySpeciesList(m.speciesList);
    metaEl.textContent = `Regn 14 d: ${
      m.rain14 === null ? "okänt" : m.rain14.toFixed(1) + " mm"
    } · väder: ${m.rainFactor} · säsong: ${m.seasonFactor} · lager: ${(m.layersLoaded ?? []).length} · skog: ${
      m.forestAreas ?? 0
    } · exkl: ${m.excludedAreas ?? 0} · ${
      m.asOf ?? ""
    }${staticOnlyInput.checked ? " · (endast habitat)" : ""}`;
  } catch {
    metaEl.textContent = "Kunde inte hämta metadata.";
  }
}

function initMap(maplibregl) {
  map = new maplibregl.Map({
    container: "map",
    preserveDrawingBuffer: true,
    style: {
      version: 8,
      sources: {
        topo: {
          type: "raster",
          tiles: ["https://tile.opentopomap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          maxzoom: 17,
          attribution:
            'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
        },
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          maxzoom: 19,
          attribution:
            'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        },
        sat: {
          type: "raster",
          tiles: [
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
          maxzoom: 18,
          attribution:
            "Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
        },
      },
      layers: [
        { id: "bm-topo", type: "raster", source: "topo" },
        { id: "bm-osm", type: "raster", source: "osm", layout: { visibility: "none" } },
        { id: "bm-sat", type: "raster", source: "sat", layout: { visibility: "none" } },
      ],
    },
    center: [15.5, 62.0],
    zoom: 5,
  });

  map.addControl(new maplibregl.NavigationControl());
  const geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: false,
    showUserLocation: true,
  });
  map.addControl(geolocate);
  let autoZoomed = false;
  geolocate.on("geolocate", (e) => {
    lastUser = [e.coords.longitude, e.coords.latitude];
    updateCarInfo();
    if (autoZoomed) return;
    autoZoomed = true;
    map.flyTo({ center: [e.coords.longitude, e.coords.latitude], zoom: 11 });
  });

  carBtn.addEventListener("click", () => {
    if (carPos) {
      carPos = null;
      localStorage.removeItem("mushroom-car");
      drawCar();
      return;
    }
    const c = lastUser ?? [map.getCenter().lng, map.getCenter().lat];
    carPos = [Number(c[0]), Number(c[1])];
    localStorage.setItem("mushroom-car", JSON.stringify(carPos));
    drawCar();
    map.flyTo({ center: carPos, zoom: Math.max(map.getZoom(), 16) });
  });

  map.on("load", () => {
    setBasemap("topo");
    updateHillshade();
    rebuildHabitat();
    updateTrails();
    refreshMeta();
    drawCar();
    geolocate.trigger();
  });

  map.on("click", async (e) => {
    if (!inspectEl) return;
    const sp = selectedSpecies()[0];
    const d = selectedDate();
    const q = new URLSearchParams({
      lat: e.lngLat.lat.toFixed(5),
      lon: e.lngLat.lng.toFixed(5),
      species: sp,
    });
    if (d) q.set("date", d);
    let j = null;
    try {
      const r = await fetch("/api/debug/cell?" + q);
      if (r.ok) j = await r.json();
    } catch {}
    const meta = speciesList?.find((s) => s.id === sp);
    const rows = j
      ? [
          ["Score", String(j.score)],
          ["Säsong", String(j.seasonFactor)],
          ["Regn 14 d", j.rain14 === null ? "okänt" : j.rain14.toFixed(1) + " mm"],
          ["Frost", String(j.frost)],
          ["Skog", j.inForest ? "ja" : "nej"],
          ["Vatten/väg/bebyggelse", j.excluded ? "för nära (0)" : "ok"],
          ["GDD5 (eff.)", j.gddEff ?? "–"],
          ["Plasticity", j.plasticity ?? "–"],
          ["Fyndprior (Artportalen)", j.obsPrior ?? "–"],
          ["Säsong", meta?.season ? seasonLabel(meta.season) : "–"],
        ]
      : [["Score", "kunde inte beräknas"]];
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    inspectEl.innerHTML =
      `<button id="inspectClose" type="button" style="float:right">✕</button>` +
      `<b>${esc(meta?.label ?? sp)}</b> ★${meta?.eatScore ?? "?"} ${meta?.protected ? "🚫 FRIDLYST" : ""}${meta?.expertMode ? "⚠ EXPERT" : ""}` +
      `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join("")}</table>` +
      (meta?.note ? `<p class="insp-note">${esc(meta.note)}</p>` : "") +
      (meta?.lookalikes ? `<p class="insp-warn">⚠ Förväxlingsvarning: ${esc(meta.lookalikes)}</p>` : "") +
      `<p class="insp-small">Habitatkarta — inte en plockningsinstruktion. Ät aldrig svamp du inte är 100 % säker på.</p>`;
    inspectEl.hidden = false;
    document.getElementById("inspectClose").addEventListener("click", () => (inspectEl.hidden = true));
  });

  window.addEventListener("resize", () => map.resize());
  new ResizeObserver(() => map.resize()).observe(mapContainer);

  let rebuildTimer = null;
  function scheduleRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildHabitat();
      refreshMeta();
    }, 400);
  }
  onSpeciesChange = scheduleRebuild;
  savePngBtn.addEventListener("click", () => {
    if (!map) return;
    map.getCanvas().toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `svampkarta-${selectedSpecies().join("-")}-${selectedDate() ?? "nu"}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, "image/png");
  });
  staticOnlyInput.addEventListener("change", scheduleRebuild);
  dateSlider.addEventListener("input", () => {
    updateDateLabel();
    scheduleRebuild();
  });
  sensInput.addEventListener("input", () => {
    sensLabel.textContent = String(70 + Number(sensInput.value));
    scheduleRebuild();
  });
  opacityInput.addEventListener("input", () => {
    for (const sp of selectedSpecies()) {
      if (map.getLayer("habitat-" + sp)) {
        map.setPaintProperty("habitat-" + sp, "raster-opacity", Number(opacityInput.value) / 100);
      }
    }
  });
  trailsInput.addEventListener("change", updateTrails);
  hillshadeInput.addEventListener("change", updateHillshade);
  expertInput.addEventListener("change", () => {
    refreshExpertVisibility();
    updateSpeciesInfo();
    onSpeciesChange?.();
  });
  for (const btn of basemapButtons) {
    btn.addEventListener("click", () => setBasemap(btn.dataset.basemap));
  }
}

import("/vendor/maplibre/maplibre-gl.mjs")
  .then((mod) => initMap(mod.default ?? mod))
  .catch((err) => {
    console.error(err);
    mapContainer.textContent = `Kunde inte ladda kartbiblioteket: ${err.message}. Kör \`npm install\` i projektmappen och ladda om sidan.`;
    mapContainer.style.cssText =
      "display:flex;align-items:center;justify-content:center;text-align:center;padding:1rem;color:#842029;";
  });
