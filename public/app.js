const map = L.map("map", {
  zoomControl: false,
}).setView([52.2297, 21.0122], 13);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);
L.control.zoom({ position: "bottomright" }).addTo(map);

const vehicleLayer = L.layerGroup().addTo(map);
map.createPane("stops-pane").style.zIndex = 410;
const stopsRenderer = L.canvas({ pane: "stops-pane" });
const stopLayer = L.layerGroup().addTo(map);
const feedStatus = document.querySelector("#feed-status");
const feedIndicator = document.querySelector("#feed-indicator");
const locationStatus = document.querySelector("#location-status");
const stopsStatus = document.querySelector("#stops-status");
const locateButton = document.querySelector("#locate-button");
const stopsToggle = document.querySelector("#stops-toggle");
let vehicles = [];
let stops = [];
let updatedAt;
let loading = false;
let stopsVisible = true;
let locationMarker;
let feedState = "loading";
const stopLinesCache = new Map();
const stopLinesRequests = new Map();

function setFeedStatus(message, state) {
  feedStatus.textContent = message;
  feedIndicator.classList.toggle("is-live", state === "live");
  feedIndicator.classList.toggle("is-error", state === "error");
}

function visibleVehicles() {
  const bounds = map.getBounds();
  return vehicles.filter((vehicle) =>
    bounds.contains([vehicle.latitude, vehicle.longitude]),
  );
}

function addVehicleMarker(vehicle) {
  const isBus = vehicle.type === "bus";
  const marker = L.circleMarker([vehicle.latitude, vehicle.longitude], {
    color: "#ffffff",
    fillColor: isBus ? "#2284e5" : "#ef7847",
    fillOpacity: 1,
    radius: 7,
    weight: 2,
  });
  const popup = document.createElement("div");
  const title = document.createElement("p");
  const details = document.createElement("p");
  title.className = "popup-title";
  details.className = "popup-detail";
  title.textContent = `${isBus ? "Autobus" : "Tramwaj"} ${vehicle.line || ""}`.trim();
  details.textContent = [
    vehicle.vehicleNumber ? `Pojazd ${vehicle.vehicleNumber}` : "",
    vehicle.brigade ? `Brygada ${vehicle.brigade}` : "",
    vehicle.time ? `Dane z ${vehicle.time}` : "",
  ].filter(Boolean).join(" · ");
  popup.append(title, details);
  marker.bindPopup(popup);
  marker.addTo(vehicleLayer);
}

function renderVehicles() {
  const visible = visibleVehicles();
  vehicleLayer.clearLayers();
  visible.forEach(addVehicleMarker);

  const buses = visible.filter((vehicle) => vehicle.type === "bus").length;
  const trams = visible.length - buses;
  if (updatedAt && feedState === "live") {
    const time = new Intl.DateTimeFormat("pl-PL", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(updatedAt));
    setFeedStatus(`Autobusy: ${buses} · Tramwaje: ${trams} · aktualizacja ${time}`, "live");
  }
}

function stopPopup(stop) {
  const popup = document.createElement("div");
  const title = document.createElement("p");
  const details = document.createElement("p");
  const lines = document.createElement("p");
  title.className = "popup-title";
  details.className = "popup-detail";
  lines.className = "popup-detail stop-lines";
  title.textContent = stop.name;
  details.textContent = `Zespół ${stop.team}, słupek ${stop.pole}`;
  lines.textContent = "Pobieranie linii…";
  popup.append(title, details, lines);
  return { popup, lines };
}

async function loadStopLines(stop, container) {
  const cacheKey = `${stop.team}:${stop.pole}`;
  const cachedLines = stopLinesCache.get(cacheKey);
  if (cachedLines) {
    renderStopLines(container, cachedLines);
    return;
  }

  container.textContent = "Pobieranie linii…";
  try {
    let request = stopLinesRequests.get(cacheKey);
    if (!request) {
      const query = new URLSearchParams({
        busstopId: stop.team,
        busstopNr: stop.pole,
      });
      request = fetch(`/api/stop-lines?${query}`)
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || "Nie udało się pobrać linii.");
          }
          if (!Array.isArray(payload.lines)) {
            throw new Error("Serwer zwrócił nieprawidłową listę linii.");
          }
          stopLinesCache.set(cacheKey, payload.lines);
          return payload.lines;
        })
        .finally(() => stopLinesRequests.delete(cacheKey));
      stopLinesRequests.set(cacheKey, request);
    }
    renderStopLines(container, await request);
  } catch (error) {
    container.textContent = error.message || "Nie udało się pobrać linii.";
  }
}

function renderStopLines(container, lines) {
  container.textContent = lines.length ? `Linie: ${lines.join(", ")}` : "Brak przypisanych linii.";
}

function renderStops() {
  stopLayer.clearLayers();
  if (!stopsVisible) return;

  const bounds = map.getBounds();
  for (const stop of stops) {
    if (!bounds.contains([stop.latitude, stop.longitude])) continue;

    const marker = L.circleMarker([stop.latitude, stop.longitude], {
      color: "#ffffff",
      fillColor: "#7546c8",
      fillOpacity: 0.95,
      radius: 4,
      renderer: stopsRenderer,
      weight: 1,
    });
    const { popup, lines } = stopPopup(stop);
    marker.bindPopup(popup);
    marker.on("popupopen", () => loadStopLines(stop, lines));
    marker.addTo(stopLayer);
  }
}

async function loadStops() {
  stopsStatus.textContent = "Ładowanie przystanków…";
  try {
    const response = await fetch("/api/stops");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Nie udało się pobrać przystanków.");
    }
    if (!Array.isArray(payload.stops)) {
      throw new Error("Serwer zwrócił nieprawidłową listę przystanków.");
    }
    stops = payload.stops;
    renderStops();
    stopsStatus.textContent = `Przystanki: ${stops.length.toLocaleString("pl-PL")}`;
  } catch (error) {
    stopsStatus.textContent = error.message || "Nie udało się pobrać przystanków.";
  }
}

async function loadVehicles() {
  if (loading) return;
  loading = true;

  try {
    const response = await fetch("/api/vehicles");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Nie udało się pobrać danych ZTM.");
    }
    if (!Array.isArray(payload.vehicles) || !payload.updatedAt) {
      throw new Error("Serwer zwrócił nieprawidłowe dane pojazdów.");
    }
    vehicles = payload.vehicles;
    updatedAt = payload.updatedAt;
    feedState = "live";
    renderVehicles();
  } catch (error) {
    feedState = "error";
    setFeedStatus(error.message || "Nie udało się pobrać danych ZTM.", "error");
  } finally {
    loading = false;
  }
}

function locateUser() {
  if (!navigator.geolocation) {
    locationStatus.textContent = "Ta przeglądarka nie obsługuje lokalizacji.";
    return;
  }

  locateButton.disabled = true;
  locationStatus.textContent = "Pobieranie lokalizacji…";
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const position = [coords.latitude, coords.longitude];
      if (locationMarker) {
        locationMarker.setLatLng(position);
      } else {
        locationMarker = L.circleMarker(position, {
          color: "#ffffff",
          fillColor: "#18a879",
          fillOpacity: 1,
          radius: 9,
          weight: 3,
        }).addTo(map).bindPopup("Twoja lokalizacja");
      }
      map.setView(position, Math.max(map.getZoom(), 15));
      locationStatus.textContent = "Pokazuję Twoją lokalizację na mapie.";
      locateButton.disabled = false;
    },
    (error) => {
      const messages = {
        1: "Brak zgody na lokalizację. Zmień uprawnienia w przeglądarce.",
        2: "Nie udało się ustalić lokalizacji urządzenia.",
        3: "Pobieranie lokalizacji przekroczyło limit czasu.",
      };
      locationStatus.textContent = messages[error.code] || "Nie udało się pobrać lokalizacji.";
      locateButton.disabled = false;
    },
    {
      enableHighAccuracy: true,
      maximumAge: 30_000,
      timeout: 12_000,
    },
  );
}

map.on("moveend", () => {
  renderVehicles();
  renderStops();
});
stopsToggle.addEventListener("click", () => {
  stopsVisible = !stopsVisible;
  stopsToggle.setAttribute("aria-pressed", String(stopsVisible));
  if (stopsVisible) renderStops();
  else stopLayer.clearLayers();
});
locateButton.addEventListener("click", locateUser);
loadVehicles();
loadStops();
window.setInterval(loadVehicles, 10_000);
