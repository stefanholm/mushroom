const mapContainer = document.getElementById("map");
const speciesSelect = document.getElementById("species");
const opacityInput = document.getElementById("opacity");
const staticOnlyInput = document.getElementById("staticOnly");
const dateSlider = document.getElementById("dateSlider");
const dateLabel = document.getElementById("dateLabel");
const metaEl = document.getElementById("meta");

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
  return {
    "heatmap-weight": ["interpolate", ["linear"], ["get", "score"], 0, 0, 100, 1],
    "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 5, 0.6, 9, 1.2, 12, 2.5, 16, 5],
    "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 5, 10, 9, 22, 12, 40, 16, 80],
    "heatmap-color": [
      "interpolate",
      ["linear"],
      ["heatmap-density"],
      0,
      "rgba(0,0,0,0)",
      0.2,
      "#fee08b",
      0.5,
      "#fdae61",
      0.75,
      "#f46d43",
      1,
      "#d73027",
    ],
    "heatmap-opacity": Number(opacityInput.value) / 100,
  };
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
        } · väder: ${gj.meta.rainFactor} · säsong: ${gj.meta.seasonFactor} · skogsområden: ${
          gj.meta.forestAreas
        } · ${gj.meta.asOf ?? ""}${gj.meta.staticOnly ? " · (endast habitat)" : ""}`
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
    geolocate.trigger();
    map.on("moveend", () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshHotspots, 400);
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
