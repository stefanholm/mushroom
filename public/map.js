const mapContainer = document.getElementById("map");
const speciesSelect = document.getElementById("species");
const opacityInput = document.getElementById("opacity");
const staticOnlyInput = document.getElementById("staticOnly");
const dateSlider = document.getElementById("dateSlider");
const dateLabel = document.getElementById("dateLabel");
const sensInput = document.getElementById("sens");
const sensLabel = document.getElementById("sensLabel");
const hillshadeInput = document.getElementById("hillshade");
const metaEl = document.getElementById("meta");

function sensitivityThreshold() {
  return 60 + Number(sensInput.value);
}

function selectedDate() {
  const days = Number(dateSlider.value);
  if (days === 0) return null;
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

function updateDateLabel() {
  dateLabel.textContent = selectedDate() ?? "nu";
}

let map = null;
let refreshTimer = null;

function heatmapPaint() {
  const t = sensitivityThreshold();
  return {
    "heatmap-weight": ["interpolate", ["linear"], ["get", "score"], t, 0, 100, 1],
    "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 5, 0.5, 9, 1, 12, 2, 16, 4],
    "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 5, 18, 9, 40, 12, 80, 16, 160],
    "heatmap-color": [
      "interpolate",
      ["linear"],
      ["heatmap-density"],
      0,
      "rgba(0,0,0,0)",
      0.08,
      "#ffffcc",
      0.2,
      "#ffeda0",
      0.32,
      "#fed976",
      0.45,
      "#feb24c",
      0.58,
      "#fd8d3c",
      0.72,
      "#f46d43",
      0.85,
      "#d73027",
      1,
      "#bd0026",
    ],
    "heatmap-opacity": Number(opacityInput.value) / 100,
  };
}

function updateHillshade() {
  if (map.getLayer("hillshade")) map.removeLayer("hillshade");
  if (map.getSource("hillshade")) map.removeSource("hillshade");
  if (!hillshadeInput.checked || !map.loaded()) return;
  const b = map.getBounds();
  const url =
    "/api/hillshade?minLon=" +
    b.getWest().toFixed(5) +
    "&minLat=" +
    b.getSouth().toFixed(5) +
    "&maxLon=" +
    b.getEast().toFixed(5) +
    "&maxLat=" +
    b.getNorth().toFixed(5);
  map.addSource("hillshade", {
    type: "image",
    url,
    coordinates: [
      [b.getWest(), b.getSouth()],
      [b.getEast(), b.getSouth()],
      [b.getEast(), b.getNorth()],
      [b.getWest(), b.getNorth()],
    ],
  });
  map.addLayer(
    { id: "hillshade", type: "raster", source: "hillshade", paint: { "raster-opacity": 0.5 } },
    "hotspots",
  );
}

async function refreshHotspots() {
  if (!map || !map.getSource("hotspots")) return;
  const b = map.getBounds();
  const q = new URLSearchParams({
    species: speciesSelect.value,
    minLon: b.getWest().toFixed(4),
    minLat: b.getSouth().toFixed(4),
    maxLon: b.getEast().toFixed(4),
    maxLat: b.getNorth().toFixed(4),
  });
  if (staticOnlyInput.checked) q.set("static", "1");
  const d = selectedDate();
  if (d) q.set("date", d);
  try {
    const r = await fetch("/api/hotspots?" + q);
    if (!r.ok) return;
    const gj = await r.json();
    map.getSource("hotspots").setData(gj);
    metaEl.textContent = gj.meta
      ? `Regn 14 d: ${
          gj.meta.rain14 === null ? "okänt" : gj.meta.rain14.toFixed(1) + " mm"
        } · väder: ${gj.meta.rainFactor} · säsong: ${gj.meta.seasonFactor} · skog: ${
          gj.meta.forestAreas
        } · exkl: ${gj.meta.excludedAreas ?? 0} · ${gj.meta.asOf ?? ""}${
          gj.meta.staticOnly ? " · (endast habitat)" : ""
        }`
      : "";
  } catch {
    metaEl.textContent = "Kunde inte hämta hotspots.";
  }
}

function initMap(maplibregl) {
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        },
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }],
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
    map.addSource("hotspots", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: "hotspots",
      type: "heatmap",
      source: "hotspots",
      paint: heatmapPaint(),
    });
    refreshHotspots();
    updateHillshade();
    geolocate.trigger();
    map.on("moveend", () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshHotspots();
        updateHillshade();
      }, 400);
    });
  });

  window.addEventListener("resize", () => map.resize());
  new ResizeObserver(() => map.resize()).observe(mapContainer);

  speciesSelect.addEventListener("change", refreshHotspots);
  staticOnlyInput.addEventListener("change", refreshHotspots);
  dateSlider.addEventListener("input", () => {
    updateDateLabel();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshHotspots, 400);
  });
  sensInput.addEventListener("input", () => {
    sensLabel.textContent = String(sensitivityThreshold());
    if (map.getLayer("hotspots")) {
      map.setPaintProperty("hotspots", "heatmap-weight", [
        "interpolate",
        ["linear"],
        ["get", "score"],
        sensitivityThreshold(),
        0,
        100,
        1,
      ]);
    }
  });
  hillshadeInput.addEventListener("change", updateHillshade);
  opacityInput.addEventListener("input", () => {
    if (map.getLayer("hotspots")) {
      map.setPaintProperty("hotspots", "heatmap-opacity", Number(opacityInput.value) / 100);
    }
  });
}

import("/vendor/maplibre/maplibre-gl.mjs")
  .then((mod) => initMap(mod.default ?? mod))
  .catch((err) => {
    console.error(err);
    mapContainer.textContent = `Kunde inte ladda kartbiblioteket: ${err.message}. Kör \`npm install\` i projektmappen och ladda om sidan.`;
    mapContainer.style.cssText =
      "display:flex;align-items:center;justify-content:center;text-align:center;padding:1rem;color:#842029;";
  });
