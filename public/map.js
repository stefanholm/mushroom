
const tabChat = document.getElementById("tab-chat");
const tabMap = document.getElementById("tab-map");
const tabSettings = document.getElementById("tab-settings");
const tabShop = document.getElementById("tab-shop");
const paneChat = document.getElementById("pane-chat");
const paneMap = document.getElementById("pane-map");
const paneSettings = document.getElementById("pane-settings");
const paneShop = document.getElementById("pane-shop");

function activatePane(target) {
  for (const [btn, pane] of [
    [tabChat, paneChat],
    [tabMap, paneMap],
    [tabSettings, paneSettings],
    [tabShop, paneShop],
  ]) {
    if (btn) btn.classList.toggle("active", btn === target);
    if (pane) pane.hidden = pane !== paneOf(target);
  }
  if (target === tabMap && map) {
    setTimeout(() => map.resize(), 50);
  }
  if (target === tabShop) renderShop();
}
function paneOf(target) {
  return target === tabChat ? paneChat : target === tabMap ? paneMap : target === tabSettings ? paneSettings : paneShop;
}

tabChat?.addEventListener("click", () => activatePane(tabChat));
tabMap?.addEventListener("click", () => activatePane(tabMap));
tabSettings?.addEventListener("click", () => activatePane(tabSettings));
tabShop?.addEventListener("click", () => activatePane(tabShop));

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
    const el = document.createElement("div");
    el.className = "car-map-pin";
    el.title = "Sparad bilposition";
    el.textContent = "🚗";
    carMarker = new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat(carPos).addTo(map);
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
    const locked = !isSpeciesUnlocked(s);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pill" + (s.id === "kantarell" ? " on" : "") + (locked ? " locked" : "");
    b.dataset.id = s.id;
    if (s.expertMode) b.dataset.expert = "1";
    b.title = `${s.label} — ätvärde ${s.eatScore}/5, säsong ${seasonLabel(s.season)}${s.protected ? " — FRIDLYST" : ""}${s.expertMode ? " — EXPERT (dödligt giftiga förväxlingar)" : ""}${locked ? " — 🔒 kräver pack (se 🛍️ Affär)" : ""}`;
    b.textContent = `${s.label.split(" (")[0]} ★${s.eatScore}${s.expertMode ? " ⚠" : ""}${s.protected ? " 🚫" : ""}${locked ? " 🔒" : ""}`;
    b.addEventListener("click", () => {
      if (locked) {
        activatePane(tabShop);
        renderShop();
        return;
      }
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
  const ents = activeEntitlements();
  if (ents.length > 0) {
    q.set("entitlements", ents.join(","));
    q.set("ents", ents.join(","));
  }
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
    if (m.reviewRewardSpecies) metaRewardSpecies = m.reviewRewardSpecies;
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
          ["Vatten/svacka (fWaterHollow)", typeof j.fWaterHollow === "number" ? j.fWaterHollow.toFixed(2) : (j.fWaterHollow ?? "–")],
          ["Skogsstruktur (fStandStruct)", typeof j.fStandStruct === "number" ? j.fStandStruct.toFixed(2) : (j.fStandStruct ?? "–")],
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
  try {
    const savedTrails = localStorage.getItem("mushroom-trails");
    if (savedTrails !== null && trailsInput) {
      trailsInput.checked = savedTrails === "1";
    }
  } catch {}
  trailsInput.addEventListener("change", () => {
    try {
      localStorage.setItem("mushroom-trails", trailsInput.checked ? "1" : "0");
    } catch {}
    updateTrails();
  });
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


let metaRewardSpecies = [];
const metaFreeSpecies = new Set();

function activeEntitlements() {
  try {
    return (localStorage.getItem("mushroom-ents") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function addEntitlement(e) {
  const ents = new Set(activeEntitlements());
  ents.add(e);
  localStorage.setItem("mushroom-ents", [...ents].join(","));
}

// Dev-läge för köp: pack läggs bara till lokalt; reward: går via serverns validering.
// I iOS-produktion ersätts detta av StoreKit 2-köp + server-validerat kvitto.
window.MushroomBilling = {
  async purchase(id) {
    if (id.startsWith("reward:")) {
      const r = await fetch("/api/reward/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ species: id.slice(7) }),
      });
      if (!r.ok) throw new Error("Belöningen kunde inte låsas upp (arten är inte i poolen).");
    } else if (id.startsWith("species:")) {
      const r = await fetch("/api/single/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ species: id.slice(8) }),
      });
      if (!r.ok) throw new Error("Arten kan inte köpas enskilt.");
    }
    addEntitlement(id);
    updateShopBadge();
  },
};

function updateShopBadge() {
  if (!tabShop) return;
  const n = activeEntitlements().filter((e) => !e.startsWith("reward:")).length;
  tabShop.textContent = n > 0 ? `🛍️ Affär (${n})` : "🛍️ Affär";
}

async function renderShop() {
  const grid = document.getElementById("shopGrid");
  if (!grid) return;
  let shop = null;
  try {
    const r = await fetch("/api/shop");
    if (r.ok) shop = await r.json();
  } catch {}
  if (!shop) {
    grid.textContent = "Kunde inte hämta affären ( är servern igång? )";
    return;
  }
  metaRewardSpecies = shop.reviewRewardSpecies ?? [];
  for (const id of shop.freeSpecies ?? []) metaFreeSpecies.add(id);
  const ents = new Set(activeEntitlements());
  const labelOf = (id) => speciesList?.find((s) => s.id === id)?.label.split(" (")[0] ?? id;
  grid.innerHTML = "";

  // ⭐ Topplista: 5 populära arter som enskilda köp (gratis eller 10 kr)
  if (Array.isArray(shop.topPicks) && shop.topPicks.length > 0) {
    const topWrap = document.createElement("div");
    topWrap.className = "shop-card";
    topWrap.style.gridColumn = "1 / -1";
    topWrap.innerHTML = `<h3>⭐ Topp ${shop.topPicks.length} — populäraste svamparna</h3>`;
    const row = document.createElement("div");
    row.className = "top-row";
    for (const t of shop.topPicks) {
      const owned = !t.free && (ents.has("species:" + t.id) || ents.has("pro") || ents.has("all") || (t.pack && ents.has(t.pack)));
      const card = document.createElement("div");
      card.className = "top-card";
      card.innerHTML =
        `<img class="shop-img" src="${t.image}" alt="" loading="lazy" onerror="this.style.display='none'" />` +
        `<div class="top-name">${t.label.split(" (")[0]} ★${t.eatScore}</div>`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "shop-buy-btn";
      if (t.free) {
        btn.textContent = "Ingår gratis ✓";
        btn.disabled = true;
      } else if (owned) {
        btn.textContent = "Ägd ✓";
        btn.disabled = true;
      } else {
        btn.textContent = `${t.priceSek} kr`;
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await window.MushroomBilling.purchase("species:" + t.id);
            renderShop();
            if (speciesList) applySpeciesList(speciesList);
            rebuildHabitat();
            refreshMeta();
          } catch (e) {
            alert(e.message);
            btn.disabled = false;
          }
        });
      }
      card.appendChild(btn);
      row.appendChild(card);
    }
    topWrap.appendChild(row);
    grid.appendChild(topWrap);
  }
  for (const p of shop.packs) {
    const owned = ents.has("pro") || ents.has("all") || ents.has(p.id);
    const card = document.createElement("div");
    card.className = "shop-card";
    const names = (p.species ?? []).slice(0, 8).map(labelOf).join(", ") + (p.species.length > 8 ? " …" : "");
    const imgHtml = p.image
      ? `<img class="shop-img" src="${p.image}" alt="" loading="lazy" onerror="this.style.display='none'" />`
      : "";
    card.innerHTML =
      imgHtml +
      `<h3>${p.label}</h3>` +
      `<div class="shop-price">${p.priceSek} kr${p.kind === "pro" ? " /år" : ""}</div>` +
      `<div class="shop-kind">${p.kind === "mixed" ? "Blandad korg" : p.kind === "regional" ? "Områdespack" : p.kind === "solo" ? "Solo-premium" : p.kind === "pro" ? "Prenumeration" : "Alla arter"} · ${p.species.length} arter</div>` +
      `<div class="shop-species">${names}</div>`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "shop-buy-btn";
    btn.textContent = owned ? "Ägd ✓" : `Köp — ${p.priceSek} kr`;
    btn.disabled = owned;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await window.MushroomBilling.purchase(p.id);
        renderShop();
        if (speciesList) applySpeciesList(speciesList);
        rebuildHabitat();
        refreshMeta();
      } catch (e) {
        alert(e.message);
        btn.disabled = false;
      }
    });
    card.appendChild(btn);
    grid.appendChild(card);
  }
  updateShopBadge();

  // Rullista: köp enskild svamp (10 kr) — alla låsta arter utom solo-only (jattemusseron)
  const singleWrap = document.createElement("div");
  singleWrap.className = "shop-card";
  singleWrap.style.gridColumn = "1 / -1";
  const sel = document.createElement("select");
  sel.id = "singleSpeciesSelect";
  for (const s of shop.singles ?? []) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = `${labelOf(s.id)} ★${s.eatScore}`;
    sel.appendChild(opt);
  }
  const buySingle = document.createElement("button");
  buySingle.type = "button";
  buySingle.className = "shop-buy-btn";
  buySingle.textContent = `Köp enskild svamp — ${shop.singlePriceSek ?? 10} kr`;
  buySingle.addEventListener("click", async () => {
    const id = sel.value;
    if (!id) return;
    buySingle.disabled = true;
    try {
      await window.MushroomBilling.purchase("species:" + id);
      renderShop();
      if (speciesList) applySpeciesList(speciesList);
      rebuildHabitat();
      refreshMeta();
    } catch (e) {
      alert(e.message);
      buySingle.disabled = false;
    }
  });
  singleWrap.innerHTML = `<h3>Köp en enskild svamp</h3><div class="shop-kind">${(shop.singles ?? []).length} arter à ${shop.singlePriceSek ?? 10} kr — ${shop.soloOnlySpecies?.join(", ") ?? ""} säljs bara via solo-paket</div>`;
  singleWrap.appendChild(sel);
  singleWrap.appendChild(buySingle);
  grid.appendChild(singleWrap);
}

function closeShop() {
  if (paneShop) paneShop.hidden = true;
}

function getClaimedRewardSpecies() {
  return activeEntitlements()
    .filter((e) => typeof e === "string" && e.startsWith("reward:"))
    .map((e) => e.slice("reward:".length));
}

function isSpeciesUnlocked(sp) {
  if (!sp) return false;
  if (sp.free === true || sp.pack === "free" || metaFreeSpecies.has(sp.id)) return true;
  if (sp.unlocked === true) return true;
  const ents = new Set(activeEntitlements());
  if (ents.has("pro") || ents.has("all")) return true;
  if (ents.has("reward:" + sp.id)) return true;
  if (sp.pack && ents.has(sp.pack)) return true;
  return false;
}

function normalizePacksList(packsData) {
  if (Array.isArray(packsData)) return packsData;
  if (packsData && typeof packsData === "object") {
    return Object.entries(packsData).map(([id, cfg]) => ({ id, ...(cfg || {}) }));
  }
  return [];
}

function openRewardModal() {
  const modal = document.getElementById("reviewRewardModal");
  const sel = document.getElementById("rewardSpeciesSelect");
  const status = document.getElementById("rewardStatus");
  const btn = document.getElementById("claimRewardBtn");
  if (!modal || !sel) return;

  const claimed = getClaimedRewardSpecies();
  const candidates = metaRewardSpecies.filter((id) => !isSpeciesUnlocked({ id }));
  sel.innerHTML = "";
  for (const id of metaRewardSpecies) {
    const opt = document.createElement("option");
    const found = speciesList?.find((x) => x.id === id);
    const label = found ? found.label.split(" (")[0] : id;
    opt.value = id;
    opt.textContent = isSpeciesUnlocked({ id }) ? `${label} (redan upplåst)` : label;
    sel.appendChild(opt);
  }
  if (candidates.length > 0) sel.value = candidates[0];

  const left = 3 - claimed.length;
  if (status) {
    status.textContent = claimed.length > 0
      ? `Upplåst via belöning: ${claimed.join(", ")} — ${Math.max(0, left)} gratis kvar (max 3), resten köps för 10 kr eller via pack.`
      : "Välj en art från poolen och skicka betyg/kommentar (max 3 gratis).";
  }
  if (btn) btn.disabled = left <= 0 || candidates.length === 0;
  modal.hidden = false;
}

function closeRewardModal() {
  const modal = document.getElementById("reviewRewardModal");
  if (modal) modal.hidden = true;
}

document.getElementById("openRewardBtn")?.addEventListener("click", () => {
  closeShop();
  openRewardModal();
});

function deviceId() {
  try {
    let d = localStorage.getItem("mushroom-device");
    if (!d) {
      d = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "web-" + Math.random().toString(36).slice(2);
      localStorage.setItem("mushroom-device", d);
    }
    return d;
  } catch {
    return "anon";
  }
}

document.getElementById("redeemBtn")?.addEventListener("click", async () => {
  const input = document.getElementById("redeemInput");
  const status = document.getElementById("redeemStatus");
  const btn = document.getElementById("redeemBtn");
  const code = (input?.value ?? "").trim();
  if (!code) {
    if (status) status.textContent = "Skriv in en kod först.";
    return;
  }
  if (btn) btn.disabled = true;
  if (status) status.textContent = "Löser in…";
  try {
    const r = await fetch("/api/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, device: deviceId() }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (status) status.textContent = j.error ?? "Kunde inte lösa in koden.";
    } else {
      addEntitlement(j.entitlement);
      if (status) status.textContent = "🎉 Upplåst: " + (j.label ?? j.entitlement) + (j.alreadyRedeemed ? " (redan inlöst på denna enhet)" : "");
      if (input) input.value = "";
      renderShop();
      if (typeof speciesList !== "undefined" && speciesList) applySpeciesList(speciesList);
      if (typeof rebuildHabitat === "function") rebuildHabitat();
      if (typeof refreshMeta === "function") refreshMeta();
      updateShopBadge();
    }
  } catch (e) {
    console.error("redeem fetch misslyckades:", e);
    if (status) status.textContent = "Servern svarar inte just nu. (se konsollen)";
  }
  if (btn) btn.disabled = false;
});
document.getElementById("closeRewardBtn")?.addEventListener("click", closeRewardModal);
document.getElementById("reviewRewardModal")?.addEventListener("click", (e) => {
  if (e.target.id === "reviewRewardModal") closeRewardModal();
});
document.getElementById("rewardType")?.addEventListener("change", (e) => {
  const row = document.getElementById("referralRow");
  if (row) row.hidden = e.target.value !== "referral";
});
document.getElementById("createReferralBtn")?.addEventListener("click", async () => {
  const r = await fetch("/api/referral/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device: localStorage.getItem("mushroom-device") || "web" }),
  });
  const j = await r.json();
  if (j.code && navigator.share) {
    await navigator.share({ title: "SvampRadar", text: j.shareText, url: location.origin }).catch(() => {});
  } else if (j.code) {
    prompt("Din referral-kod att dela:", j.code + " — " + j.shareText);
  }
});
document.getElementById("claimRewardBtn")?.addEventListener("click", async () => {
  const sel = document.getElementById("rewardSpeciesSelect");
  const ratingEl = document.getElementById("rewardRating");
  const commentEl = document.getElementById("rewardComment");
  const typeEl = document.getElementById("rewardType");
  const codeEl = document.getElementById("referralCode");
  if (!sel || !sel.value) return;
  const chosenId = sel.value;
  if (!metaRewardSpecies.includes(chosenId)) {
    alert("Ogiltig belöningsart.");
    return;
  }
  const type = typeEl?.value === "referral" ? "referral" : "review";
  const ents = activeEntitlements();
  const types = ents.filter((e) => e.startsWith("claim:")).map((e) => e.slice(6));
  const body = {
    species: chosenId,
    type,
    claimed: ents.filter((e) => e.startsWith("reward:")),
    types,
    rating: Number(ratingEl?.value || 0),
    comment: (commentEl?.value || "").trim(),
  };
  if (type === "referral") {
    body.code = (codeEl?.value || "").trim().toUpperCase();
    if (!body.code) {
      alert("Lös in en referral-kod först (eller skapa din egen att dela).");
      return;
    }
    const rr = await fetch("/api/referral/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: body.code, device: localStorage.getItem("mushroom-device") || "web" }),
    });
    if (!rr.ok) {
      const j = await rr.json().catch(() => ({}));
      alert(j.error || "Koden kunde inte lösas in.");
      return;
    }
  }
  const r = await fetch("/api/reward/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    alert(j.error || "Kunde inte låsa upp belöningen.");
    return;
  }
  addEntitlement("reward:" + chosenId);
  addEntitlement("claim:" + type);
  updateShopBadge();
  if (speciesList) applySpeciesList(speciesList);
  rebuildHabitat();
  refreshMeta();
  closeRewardModal();
});
