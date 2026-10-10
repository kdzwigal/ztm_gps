import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(directory, "public");
const port = Number(process.env.PORT) || 10000;
const refreshIntervalMs = 10_000;
const stopsRefreshIntervalMs = 6 * 60 * 60 * 1000;
const linesRefreshIntervalMs = 60 * 60 * 1000;
const vehicleFeedUrl = "https://dane.um.warszawa.pl/api/action/get_ztm_lokalizacja_pojazdow";
const stopsFeedUrl = "https://dane.um.warszawa.pl/api/action/get_ztm_przystanki_komunikacji_miejskiej";
const stopLinesFeedUrl = "https://dane.um.warszawa.pl/api/action/get_ztm_lista_linii_na_przystanku";
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

let cachedFeed;
let feedRequest;
let cachedStops;
let stopsRequest;
const stopLinesCache = new Map();
const stopLinesRequests = new Map();

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function getApiKey() {
  const apiKey = process.env.ZTM_API_KEY?.trim();
  if (!apiKey) {
    const error = new Error("ZTM_API_KEY is not configured on the server.");
    error.code = "MISSING_API_KEY";
    throw error;
  }
  return apiKey;
}

async function fetchApiJson(url, apiKey, body) {
  const headers = { Authorization: apiKey };
  const options = {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(15_000),
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`ZTM API returned HTTP ${response.status}.`);
  }
  return response.json();
}

function getValues(record) {
  if (!record || typeof record !== "object" || !Array.isArray(record.values)) {
    return null;
  }
  return Object.fromEntries(
    record.values
      .filter((entry) => entry && typeof entry.key === "string")
      .map((entry) => [entry.key, entry.value]),
  );
}

function getRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.values)) return [payload];
  throw new Error("ZTM API returned an invalid data structure.");
}

function normalizeStops(payload) {
  const stops = [];
  let invalidRecords = 0;
  for (const record of getRecords(payload)) {
    const values = getValues(record);
    if (!values) {
      invalidRecords += 1;
      continue;
    }

    const latitude = Number(values.szer_geo);
    const longitude = Number(values.dlug_geo);
    const team = String(values.zespol ?? "").trim();
    const pole = String(values.slupek ?? "").trim();
    const name = String(values.nazwa_zespolu ?? "").trim();
    if (
      !team ||
      !pole ||
      !name ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      invalidRecords += 1;
      continue;
    }
    stops.push({
      id: `${team}:${pole}`,
      team,
      pole,
      name,
      latitude,
      longitude,
    });
  }

  if (invalidRecords > 0) {
    console.warn(`Skipped ${invalidRecords} invalid ZTM stop records.`);
  }
  return stops;
}

function normalizeLines(payload) {
  const lines = new Set();
  for (const record of getRecords(payload)) {
    const values = getValues(record);
    const line = String(values?.linia ?? "").trim();
    if (line) lines.add(line);
  }
  return [...lines].sort((left, right) =>
    left.localeCompare(right, "pl", { numeric: true }),
  );
}

function normalizeVehicles(rows, type) {
  const vehicles = [];
  let invalidRows = 0;

  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object" ||
      row.Lat == null ||
      row.Lon == null ||
      String(row.Lat).trim() === "" ||
      String(row.Lon).trim() === ""
    ) {
      invalidRows += 1;
      continue;
    }

    const latitude = Number(row.Lat);
    const longitude = Number(row.Lon);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      invalidRows += 1;
      continue;
    }

    const line = String(row.Lines ?? "").trim();
    const brigade = String(row.Brigade ?? "").trim();
    const vehicleNumber = String(row.VehicleNumber ?? "").trim();
    vehicles.push({
      id: `${type}:${vehicleNumber || `${line}:${brigade}:${latitude}:${longitude}`}`,
      type: type === 1 ? "bus" : "tram",
      line,
      brigade,
      latitude,
      longitude,
      time: String(row.Time ?? ""),
      vehicleNumber,
    });
  }

  if (invalidRows > 0) {
    console.warn(`Skipped ${invalidRows} vehicle records with invalid coordinates.`);
  }
  return vehicles;
}

async function fetchVehicleType(type, apiKey) {
  const payload = await fetchApiJson(vehicleFeedUrl, apiKey, { type });
  if (!Array.isArray(payload.result)) {
    throw new Error(`ZTM feed returned an invalid result for type ${type}.`);
  }

  return normalizeVehicles(payload.result, type);
}

async function getVehicles() {
  const now = Date.now();
  if (cachedFeed && now - cachedFeed.fetchedAt < refreshIntervalMs) {
    return cachedFeed;
  }

  if (!feedRequest) {
    feedRequest = (async () => {
      const apiKey = getApiKey();
      const [buses, trams] = await Promise.all([
        fetchVehicleType(1, apiKey),
        fetchVehicleType(2, apiKey),
      ]);
      cachedFeed = {
        fetchedAt: Date.now(),
        vehicles: [...buses, ...trams],
      };
      return cachedFeed;
    })().finally(() => {
      feedRequest = undefined;
    });
  }

  return feedRequest;
}

async function getStops() {
  if (cachedStops && Date.now() - cachedStops.fetchedAt < stopsRefreshIntervalMs) {
    return cachedStops;
  }
  if (!stopsRequest) {
    stopsRequest = (async () => {
      const stops = normalizeStops(await fetchApiJson(stopsFeedUrl, getApiKey()));
      cachedStops = { fetchedAt: Date.now(), stops };
      return cachedStops;
    })().finally(() => {
      stopsRequest = undefined;
    });
  }
  return stopsRequest;
}

async function getStopLines(team, pole) {
  const cacheKey = `${team}:${pole}`;
  const cached = stopLinesCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < linesRefreshIntervalMs) {
    return cached.lines;
  }
  if (!stopLinesRequests.has(cacheKey)) {
    const request = (async () => {
      const payload = await fetchApiJson(stopLinesFeedUrl, getApiKey(), {
        busstopId: team,
        busstopNr: pole,
      });
      const lines = normalizeLines(payload);
      stopLinesCache.set(cacheKey, { fetchedAt: Date.now(), lines });
      return lines;
    })().finally(() => {
      stopLinesRequests.delete(cacheKey);
    });
    stopLinesRequests.set(cacheKey, request);
  }
  return stopLinesRequests.get(cacheKey);
}

async function serveStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }

  const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const filePath = path.resolve(publicDirectory, `.${requestedPath}`);
  if (!filePath.startsWith(`${publicDirectory}${path.sep}`)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    throw error;
  }

  if (!fileInfo.isFile()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Content-Length": fileInfo.size,
    "Content-Type": mimeTypes[path.extname(filePath)] ?? "application/octet-stream",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url, "http://localhost");
  if (
    requestUrl.pathname === "/api/vehicles" ||
    requestUrl.pathname === "/api/stops" ||
    requestUrl.pathname === "/api/stop-lines"
  ) {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }

    try {
      if (requestUrl.pathname === "/api/vehicles") {
        const feed = await getVehicles();
        sendJson(response, 200, {
          vehicles: feed.vehicles,
          updatedAt: new Date(feed.fetchedAt).toISOString(),
        });
      } else if (requestUrl.pathname === "/api/stops") {
        const feed = await getStops();
        sendJson(response, 200, {
          stops: feed.stops,
          updatedAt: new Date(feed.fetchedAt).toISOString(),
        });
      } else {
        const team = requestUrl.searchParams.get("busstopId")?.trim();
        const pole = requestUrl.searchParams.get("busstopNr")?.trim();
        if (!team || !pole || !/^\d+$/.test(team) || !/^\d+$/.test(pole)) {
          sendJson(response, 400, { error: "Nieprawidłowy identyfikator przystanku." });
          return;
        }
        const lines = await getStopLines(team, pole);
        sendJson(response, 200, { lines });
      }
    } catch (error) {
      console.error(`Unable to load ${requestUrl.pathname} data:`, error);
      const missingKey = error.code === "MISSING_API_KEY";
      sendJson(response, missingKey ? 503 : 502, {
        error: missingKey
          ? "Brak konfiguracji klucza API ZTM na serwerze."
          : "Nie udało się pobrać danych ZTM. Spróbuj ponownie za chwilę.",
      });
    }
    return;
  }

  try {
    await serveStatic(request, response, requestUrl.pathname);
  } catch (error) {
    console.error("Unable to serve request:", error);
    if (!response.headersSent) {
      response.writeHead(500);
      response.end("Internal server error");
    }
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`ZTM live map listening on port ${port}.`);
});
