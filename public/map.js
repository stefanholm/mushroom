const mapContainer = document.getElementById("map");
const speciesSelect = document.getElementById("species");
const opacityInput = document.getElementById("opacity");
const staticOnlyInput = document.getElementById("staticOnly");
const dateSlider = document.getElementById("dateSlider");
const dateLabel = document.getElementById("dateLabel");
const sensInput = document.getElementById("sens");
const sensLabel = document.getElementById("sensLabel");
const trailsInput = document.getElementById("trails");
const basemapButtons = Array.from(document.querySelectorAll(".bm"));
const metaEl = document.getElementById("meta");

let map = null;
const TILE_V = "r14";

function selectedDate() {
  const days = Number(dateSlider.value);
  if (days === 0) return null;
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

function updateDateLabel() {
  dateLabel.textContent = selectedDate() ?? "nu";
}

function habitatTileUrl() {
  const q = new URLSearchParams();
  if (staticOnlyInput.checked) q.set("static", "1");
  const d = selectedDate();
  if (d) q.set("date", d);
  q.set("sens", String(Number(sensInput.value)));
  q.set("v", TILE_V);
  return `/api/tiles/habitat/${speciesSelect.value}/{z}/{x}/{y}.png?${q.toString()}`;
}

function rebuildHabitat() {
  if (!map) return;
  if (map.getLayer("habitat")) map.removeLayer("habitat");
  if (map.getSource("habitat")) map.removeSource("habitat");
  map.addSource("habitat", {
    type: "raster",
    tiles: [habitatTileUrl()],
    tileSize: 256,
    maxzoom: 16,
  });
  map.addLayer({
    id: "habitat",
    type: "raster",
    source: "habitat",
    paint: {
      "raster-opacity": Number(opacityInput.value) / 100,
      "raster-resampling": "linear",
    },
  });
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

async function refreshMeta() {
  const q = new URLSearchParams({ species: speciesSelect.value });
  const d = selectedDate();
  if (d) q.set("date", d);
  try {
    const r = await fetch("/api/meta?" + q);
    if (!r.ok) return;
    const m = await r.json();
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
    if (autoZoomed) return;
    autoZoomed = true;
    map.flyTo({ center: [e.coords.longitude, e.coords.latitude], zoom: 11 });
  });

  map.on("load", () => {
    setBasemap("topo");
    rebuildHabitat();
    updateTrails();
    refreshMeta();
    geolocate.trigger();
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
  speciesSelect.addEventListener("change", scheduleRebuild);
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
    if (map.getLayer("habitat")) {
      map.setPaintProperty("habitat", "raster-opacity", Number(opacityInput.value) / 100);
    }
  });
  trailsInput.addEventListener("change", updateTrails);
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
