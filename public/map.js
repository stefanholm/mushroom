import maplibregl from "maplibre-gl";

const map = new maplibregl.Map({
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

new ResizeObserver(() => map.resize()).observe(document.getElementById("map"));

const speciesSelect = document.getElementById("species");
const opacityInput = document.getElementById("opacity");
const metaEl = document.getElementById("meta");
let refreshTimer = null;

function opacityExpression() {
  return [
    "interpolate",
    ["linear"],
    ["get", "score"],
    0,
    0,
    100,
    Number(opacityInput.value) / 100,
  ];
}

map.on("load", () => {
  map.addSource("hotspots", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "hotspots",
    type: "fill",
    source: "hotspots",
    paint: {
      "fill-color": [
        "interpolate",
        ["linear"],
        ["get", "score"],
        0,
        "rgba(0,0,0,0)",
        30,
        "#fee08b",
        60,
        "#fdae61",
        85,
        "#f46d43",
        100,
        "#d73027",
      ],
      "fill-opacity": opacityExpression(),
    },
  });
  refreshHotspots();
  map.on("moveend", () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshHotspots, 400);
  });
});

async function refreshHotspots() {
  if (!map.getSource("hotspots")) return;
  const b = map.getBounds();
  const q = new URLSearchParams({
    species: speciesSelect.value,
    minLon: b.getWest().toFixed(4),
    minLat: b.getSouth().toFixed(4),
    maxLon: b.getEast().toFixed(4),
    maxLat: b.getNorth().toFixed(4),
  });
  try {
    const r = await fetch("/api/hotspots?" + q);
    if (!r.ok) return;
    const gj = await r.json();
    map.getSource("hotspots").setData(gj);
    metaEl.textContent = gj.meta
      ? `Regn senaste 14 d: ${
          gj.meta.rain14 === null ? "okänt" : gj.meta.rain14.toFixed(1) + " mm"
        } · väderfaktor: ${gj.meta.rainFactor}`
      : "";
  } catch {
    metaEl.textContent = "Kunde inte hämta hotspots.";
  }
}

speciesSelect.addEventListener("change", refreshHotspots);
opacityInput.addEventListener("input", () => {
  if (map.getLayer("hotspots")) {
    map.setPaintProperty("hotspots", "fill-opacity", opacityExpression());
  }
});
