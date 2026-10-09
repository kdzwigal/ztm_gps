import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(directory, "public");
const port = Number(process.env.PORT) || 10000;
const refreshIntervalMs = 10_000;
const feedUrl = "https://dane.um.warszawa.pl/api/action/get_ztm_lokalizacja_pojazdow";
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

let cachedFeed;
let feedRequest;

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
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
  const response = await fetch(feedUrl, {
    method: "POST",
    headers: {
      Authorization: `token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type }),
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    throw new Error(`ZTM feed returned HTTP ${response.status} for type ${type}.`);
  }

  const payload = await response.json();
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
      const apiKey = process.env.ZTM_API_KEY?.trim();
      if (!apiKey) {
        const error = new Error("ZTM_API_KEY is not configured on the server.");
        error.code = "MISSING_API_KEY";
        throw error;
      }

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
  if (requestUrl.pathname === "/api/vehicles") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }

    try {
      const feed = await getVehicles();
      sendJson(response, 200, {
        vehicles: feed.vehicles,
        updatedAt: new Date(feed.fetchedAt).toISOString(),
      });
    } catch (error) {
      console.error("Unable to load ZTM vehicle data:", error);
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
