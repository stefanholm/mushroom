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

let map = null;

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
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        },
        hillshade: {
          type: "raster",
          tiles: ["/api/tiles/hillshade/{z}/{x}/{y}.png"],
          tileSize: 256,
        },
      },
      layers: [
        {
          id: "osm",
          type: "raster",
          source: "osm",
          paint: {
            "raster-saturation": -0.75,
            "raster-brightness-max": 0.92,
            "raster-contrast": 0.08,
          },
        },
        {
          id: "hillshade",
          type: "raster",
          source: "hillshade",
          paint: { "raster-opacity": 0.5 },
          layout: { visibility: hillshadeInput.checked ? "visible" : "none" },
        },
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
    rebuildHabitat();
    refreshMeta();
    geolocate.trigger();
  });

  window.addEventListener("resize", () => map.resize());
  new ResizeObserver(() => map.resize()).observe(mapContainer);

  speciesSelect.addEventListener("change", () => {
    rebuildHabitat();
    refreshMeta();
  });
  staticOnlyInput.addEventListener("change", () => {
    rebuildHabitat();
    refreshMeta();
  });
  dateSlider.addEventListener("input", () => {
    updateDateLabel();
    rebuildHabitat();
    refreshMeta();
  });
  sensInput.addEventListener("input", () => {
    sensLabel.textContent = String(50 + Number(sensInput.value));
    rebuildHabitat();
  });
  opacityInput.addEventListener("input", () => {
    if (map.getLayer("habitat")) {
      map.setPaintProperty("habitat", "raster-opacity", Number(opacityInput.value) / 100);
    }
  });
  hillshadeInput.addEventListener("change", () => {
    if (map.getLayer("hillshade")) {
      map.setLayoutProperty(
        "hillshade",
        "visibility",
        hillshadeInput.checked ? "visible" : "none",
      );
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
