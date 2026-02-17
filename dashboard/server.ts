import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { chargerManager } from "./chargerManager";
import * as path from "node:path";
import * as fs from "node:fs";
import * as https from "node:https";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = new Hono();

// Enable CORS
app.use("/*", cors());

// API Routes
const api = new Hono();

// Get dashboard status
api.get("/status", (c) => {
  const chargers = chargerManager.getAllChargers();
  const connected = chargers.filter((ch) => ch.connected).length;
  return c.json({
    wsUrl: chargerManager.getWsUrl(),
    totalChargers: chargers.length,
    connectedChargers: connected,
  });
});

// Get all chargers
api.get("/chargers", (c) => {
  return c.json(chargerManager.getAllChargers());
});

// Get single charger
api.get("/chargers/:cpId", (c) => {
  const cpId = c.req.param("cpId");
  const charger = chargerManager.getCharger(cpId);
  if (!charger) {
    return c.json({ error: "Charger not found" }, 404);
  }
  return c.json({
    cpId,
    config: charger.config,
    connected: charger.connected,
    connectors: charger.connectors.map((conn) =>
      chargerManager.serializeConnector(cpId, conn)
    ),
  });
});

// Add a charger
api.post("/chargers", async (c) => {
  const body = await c.req.json();
  const config = {
    cpId: body.cpId,
    vendor: body.vendor || "VirtualCharger",
    model: body.model || "VCP-1",
    serialNumber: body.serialNumber || body.cpId,
    firmwareVersion: body.firmwareVersion || "1.0.0",
    connectors: body.connectors || 1,
    phases: body.phases === 1 ? 1 : 3 as 1 | 3,
    meterType: body.meterType,
    meterSerialNumber: body.meterSerialNumber,
    iccid: body.iccid,
    imsi: body.imsi,
  };

  if (!config.cpId) {
    return c.json({ error: "cpId is required" }, 400);
  }

  if (chargerManager.addCharger(config)) {
    return c.json({ success: true, cpId: config.cpId });
  }
  return c.json({ error: "Charger already exists" }, 400);
});

// Generate multiple chargers
api.post("/chargers/generate", async (c) => {
  const body = await c.req.json();
  const { prefix, count, vendor, model, firmwareVersion, connectors, phases } = body;

  if (!prefix || !count) {
    return c.json({ error: "prefix and count are required" }, 400);
  }

  const created = chargerManager.generateChargers(prefix, count, {
    vendor: vendor || "VirtualCharger",
    model: model || "VCP-1",
    firmwareVersion: firmwareVersion || "1.0.0",
    connectors: connectors || 1,
    phases: phases === 1 ? 1 : 3,
  });

  return c.json({ success: true, created, count: created.length });
});

// Delete a charger
api.delete("/chargers/:cpId", (c) => {
  const cpId = c.req.param("cpId");
  if (chargerManager.removeCharger(cpId)) {
    return c.json({ success: true });
  }
  return c.json({ error: "Charger not found" }, 404);
});

// Connect a charger
api.post("/chargers/:cpId/connect", async (c) => {
  const cpId = c.req.param("cpId");
  const result = await chargerManager.connectCharger(cpId);
  if (result) {
    return c.json({ success: true });
  }
  return c.json({ error: "Failed to connect" }, 500);
});

// Connect all chargers
api.post("/chargers/connect-all", async (c) => {
  const result = await chargerManager.connectAll();
  return c.json({ success: true, ...result });
});

// Disconnect a charger
api.post("/chargers/:cpId/disconnect", async (c) => {
  const cpId = c.req.param("cpId");
  const result = chargerManager.disconnectCharger(cpId);
  if (result) {
    return c.json({ success: true });
  }
  return c.json({ error: "Failed to disconnect" }, 500);
});

// Set connector status
api.post("/chargers/:cpId/connectors/:connectorId/status", async (c) => {
  const cpId = c.req.param("cpId");
  const connectorId = parseInt(c.req.param("connectorId"), 10);
  const body = await c.req.json();

  if (
    chargerManager.setConnectorStatus(
      cpId,
      connectorId,
      body.status,
      body.errorCode || "NoError"
    )
  ) {
    return c.json({ success: true });
  }
  return c.json({ error: "Failed to set status" }, 400);
});

// Set charging current
api.post("/chargers/:cpId/connectors/:connectorId/current", async (c) => {
  const cpId = c.req.param("cpId");
  const connectorId = parseInt(c.req.param("connectorId"), 10);
  const body = await c.req.json();

  if (chargerManager.setChargingCurrent(cpId, connectorId, body.currentAmps)) {
    return c.json({ success: true });
  }
  return c.json({ error: "Failed to set current" }, 400);
});

// Set transaction ID for a connector
api.post("/chargers/:cpId/connectors/:connectorId/transaction", async (c) => {
  const cpId = c.req.param("cpId");
  const connectorId = parseInt(c.req.param("connectorId"), 10);
  const body = await c.req.json();

  if (chargerManager.setTransactionId(cpId, connectorId, body.transactionId)) {
    return c.json({ success: true });
  }
  return c.json({ error: "Failed to set transaction" }, 400);
});

// Start transaction (Authorize + StartTransaction OCPP flow)
api.post(
  "/chargers/:cpId/connectors/:connectorId/start-transaction",
  async (c) => {
    const cpId = c.req.param("cpId");
    const connectorId = parseInt(c.req.param("connectorId"), 10);
    const body = await c.req.json().catch(() => ({}));
    const idTag = body.idTag || "VIRTUAL001";

    const result = await chargerManager.startTransaction(cpId, connectorId, idTag);
    if (result) {
      return c.json({ success: true });
    }
    return c.json({ error: "Failed to start transaction" }, 400);
  }
);

// Stop transaction
api.post(
  "/chargers/:cpId/connectors/:connectorId/stop-transaction",
  async (c) => {
    const cpId = c.req.param("cpId");
    const connectorId = parseInt(c.req.param("connectorId"), 10);

    const result = await chargerManager.stopTransaction(cpId, connectorId);
    if (result) {
      return c.json({ success: true });
    }
    return c.json({ error: "Failed to stop transaction" }, 400);
  }
);

// Reset energy counter
api.post("/chargers/:cpId/connectors/:connectorId/reset-energy", async (c) => {
  const cpId = c.req.param("cpId");
  const connectorId = parseInt(c.req.param("connectorId"), 10);

  if (chargerManager.resetEnergy(cpId, connectorId)) {
    return c.json({ success: true });
  }
  return c.json({ error: "Failed to reset energy" }, 400);
});

// Get all car profiles
api.get("/car-profiles", (c) => {
  return c.json(chargerManager.getCarProfiles());
});

// Plug in a car to a connector
api.post(
  "/chargers/:cpId/connectors/:connectorId/plug-car",
  async (c) => {
    const cpId = c.req.param("cpId");
    const connectorId = parseInt(c.req.param("connectorId"), 10);
    const body = await c.req.json();

    const profileId = body.profileId;
    const initialSoc = body.initialSoc !== undefined ? body.initialSoc : 0.2;

    if (!profileId) {
      return c.json({ error: "profileId is required" }, 400);
    }

    if (chargerManager.plugInCar(cpId, connectorId, profileId, initialSoc)) {
      return c.json({ success: true });
    }
    return c.json({ error: "Failed to plug in car" }, 400);
  }
);

// Unplug a car from a connector
api.post(
  "/chargers/:cpId/connectors/:connectorId/unplug-car",
  async (c) => {
    const cpId = c.req.param("cpId");
    const connectorId = parseInt(c.req.param("connectorId"), 10);

    if (chargerManager.unplugCar(cpId, connectorId)) {
      return c.json({ success: true });
    }
    return c.json({ error: "Failed to unplug car" }, 400);
  }
);

// Get car status for a connector
api.get(
  "/chargers/:cpId/connectors/:connectorId/car-status",
  (c) => {
    const cpId = c.req.param("cpId");
    const connectorId = parseInt(c.req.param("connectorId"), 10);

    const status = chargerManager.getCarStatus(cpId, connectorId);
    if (status === undefined) {
      return c.json({ error: "Connector not found" }, 404);
    }
    return c.json(status);
  }
);

// Bulk set connector status
api.post("/bulk/status", async (c) => {
  const body = await c.req.json();
  const { cpIds, connectorId, status, errorCode } = body;

  if (!cpIds || !status) {
    return c.json({ error: "cpIds and status are required" }, 400);
  }

  const result = await chargerManager.bulkSetConnectorStatus(
    cpIds,
    connectorId || "all",
    status,
    errorCode || "NoError"
  );
  return c.json({ success: true, ...result });
});

// Bulk set charging current
api.post("/bulk/current", async (c) => {
  const body = await c.req.json();
  const { cpIds, connectorId, currentAmps } = body;

  if (!cpIds || currentAmps === undefined) {
    return c.json({ error: "cpIds and currentAmps are required" }, 400);
  }

  const result = await chargerManager.bulkSetChargingCurrent(
    cpIds,
    connectorId || "all",
    currentAmps
  );
  return c.json({ success: true, ...result });
});

// Bulk send configuration
api.post("/bulk/config", async (c) => {
  const body = await c.req.json();
  const { cpIds, key, value } = body;

  if (!cpIds || !key || value === undefined) {
    return c.json({ error: "cpIds, key, and value are required" }, 400);
  }

  const result = await chargerManager.bulkSendChangeConfiguration(
    cpIds,
    key,
    value
  );
  return c.json({ success: true, ...result });
});

// Set WebSocket URL
api.post("/settings/ws-url", async (c) => {
  const body = await c.req.json();
  if (!body.wsUrl) {
    return c.json({ error: "wsUrl is required" }, 400);
  }
  chargerManager.setWsUrl(body.wsUrl);
  return c.json({ success: true, wsUrl: body.wsUrl });
});

// --- Plugchoice API Proxy ---

const plugchoiceTokenPath = path.join(__dirname, "plugchoice.json");

function loadPlugchoiceToken(): string | null {
  try {
    if (fs.existsSync(plugchoiceTokenPath)) {
      const data = JSON.parse(fs.readFileSync(plugchoiceTokenPath, "utf-8"));
      return data.token || null;
    }
  } catch {}
  return null;
}

function savePlugchoiceToken(token: string): void {
  fs.writeFileSync(plugchoiceTokenPath, JSON.stringify({ token }, null, 2), "utf-8");
}

function plugchoiceFetch(
  method: string,
  apiPath: string,
  body?: any
): Promise<any> {
  const token = loadPlugchoiceToken();
  if (!token) {
    return Promise.reject(new Error("No Plugchoice token configured"));
  }

  const url = new URL("https://app.plugchoice.com/api/v3" + apiPath);
  const postData = body ? JSON.stringify(body) : undefined;

  const options: https.RequestOptions = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname + url.search,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(postData ? { "Content-Length": Buffer.byteLength(postData) } : {}),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (res.statusCode && res.statusCode >= 400) {
          try {
            const parsed = JSON.parse(raw);
            reject(new Error(parsed.message || `HTTP ${res.statusCode}: ${raw}`));
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
          }
          return;
        }
        // Handle 204 No Content or empty body
        if (!raw || raw.trim() === "") {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`Failed to parse JSON: ${raw}`));
        }
      });
    });
    req.on("error", reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function plugchoiceFetchAllPages(apiPath: string): Promise<any[]> {
  const allItems: any[] = [];
  let page = 1;
  while (true) {
    const separator = apiPath.includes("?") ? "&" : "?";
    const res = await plugchoiceFetch("GET", `${apiPath}${separator}page=${page}`);
    const items = res.data || [];
    allItems.push(...items);
    // Handle both pagination formats: links.next (sites) and next_page_url (team chargers)
    const hasMore = (res.links && res.links.next) || res.next_page_url;
    if (!hasMore || items.length === 0) break;
    page++;
  }
  return allItems;
}

let cachedTeamUuid: string | null = null;

// Token management
api.get("/plugchoice/token", (c) => {
  const token = loadPlugchoiceToken();
  return c.json({ hasToken: !!token });
});

api.post("/plugchoice/token", async (c) => {
  const body = await c.req.json();
  if (!body.token) {
    return c.json({ error: "token is required" }, 400);
  }
  savePlugchoiceToken(body.token);
  cachedTeamUuid = null; // reset cache when token changes
  return c.json({ success: true });
});

// List all sites (auto-paginated)
api.get("/plugchoice/sites", async (c) => {
  try {
    const sites = await plugchoiceFetchAllPages("/sites");
    return c.json(sites);
  } catch (err: any) {
    if (err.message === "No Plugchoice token configured") {
      return c.json({ error: err.message }, 401);
    }
    return c.json({ error: err.message }, 500);
  }
});

// Create a site
api.post("/plugchoice/sites", async (c) => {
  try {
    const body = await c.req.json();
    const result = await plugchoiceFetch("POST", "/sites", body);
    return c.json(result);
  } catch (err: any) {
    if (err.message === "No Plugchoice token configured") {
      return c.json({ error: err.message }, 401);
    }
    return c.json({ error: err.message }, 500);
  }
});

// Delete a site
api.delete("/plugchoice/sites/:uuid", async (c) => {
  try {
    const uuid = c.req.param("uuid");
    const result = await plugchoiceFetch("DELETE", `/sites/${uuid}`);
    return c.json(result ?? { success: true });
  } catch (err: any) {
    if (err.message === "No Plugchoice token configured") {
      return c.json({ error: err.message }, 401);
    }
    return c.json({ error: err.message }, 500);
  }
});

// List all team chargers (auto-paginated)
api.get("/plugchoice/team-chargers", async (c) => {
  try {
    if (!cachedTeamUuid) {
      const teamsRes = await plugchoiceFetch("GET", "/teams");
      const teams = teamsRes.data || [];
      if (teams.length === 0) {
        return c.json({ error: "No teams found" }, 404);
      }
      cachedTeamUuid = teams[0].uuid;
    }
    const chargers = await plugchoiceFetchAllPages(`/teams/${cachedTeamUuid}/chargers`);
    return c.json(chargers);
  } catch (err: any) {
    if (err.message === "No Plugchoice token configured") {
      return c.json({ error: err.message }, 401);
    }
    return c.json({ error: err.message }, 500);
  }
});

// Attach a charger to a site (auto-fetches pincode)
api.post("/plugchoice/sites/:uuid/chargers", async (c) => {
  try {
    const siteUuid = c.req.param("uuid");
    const body = await c.req.json();
    const { identity } = body;

    if (!identity) {
      return c.json({ error: "identity is required" }, 400);
    }

    // Find charger UUID from team chargers
    if (!cachedTeamUuid) {
      const teamsRes = await plugchoiceFetch("GET", "/teams");
      const teams = teamsRes.data || [];
      if (teams.length === 0) {
        return c.json({ error: "No teams found" }, 404);
      }
      cachedTeamUuid = teams[0].uuid;
    }

    const teamChargers = await plugchoiceFetchAllPages(`/teams/${cachedTeamUuid}/chargers`);
    const charger = teamChargers.find((ch: any) => ch.identity === identity);
    if (!charger) {
      return c.json({ error: `Charger with identity '${identity}' not found in team` }, 404);
    }

    // Get pincode from charger detail
    const chargerDetail = await plugchoiceFetch("GET", `/chargers/${charger.uuid}`);
    const pincode = chargerDetail.data.pincode;

    // Attach charger to site
    const result = await plugchoiceFetch("POST", `/sites/${siteUuid}/chargers`, {
      identity,
      pincode,
    });
    return c.json(result);
  } catch (err: any) {
    if (err.message === "No Plugchoice token configured") {
      return c.json({ error: err.message }, 401);
    }
    return c.json({ error: err.message }, 500);
  }
});

// Batch attach multiple chargers to a site
api.post("/plugchoice/sites/:uuid/chargers/batch", async (c) => {
  try {
    const siteUuid = c.req.param("uuid");
    const body = await c.req.json();
    const { identities } = body;

    if (!identities || !Array.isArray(identities) || identities.length === 0) {
      return c.json({ error: "identities array is required" }, 400);
    }

    // Ensure team UUID is cached
    if (!cachedTeamUuid) {
      const teamsRes = await plugchoiceFetch("GET", "/teams");
      const teams = teamsRes.data || [];
      if (teams.length === 0) {
        return c.json({ error: "No teams found" }, 404);
      }
      cachedTeamUuid = teams[0].uuid;
    }

    // Fetch all team chargers once
    const teamChargers = await plugchoiceFetchAllPages(`/teams/${cachedTeamUuid}/chargers`);

    const results: { identity: string; success: boolean; error?: string }[] = [];

    for (const identity of identities) {
      try {
        const charger = teamChargers.find((ch: any) => ch.identity === identity);
        if (!charger) {
          results.push({ identity, success: false, error: `Charger not found in team` });
          continue;
        }

        // Get pincode from charger detail
        const chargerDetail = await plugchoiceFetch("GET", `/chargers/${charger.uuid}`);
        const pincode = chargerDetail.data.pincode;

        // Attach charger to site
        await plugchoiceFetch("POST", `/sites/${siteUuid}/chargers`, {
          identity,
          pincode,
        });

        results.push({ identity, success: true });
      } catch (err: any) {
        results.push({ identity, success: false, error: err.message });
      }
    }

    return c.json({ results });
  } catch (err: any) {
    if (err.message === "No Plugchoice token configured") {
      return c.json({ error: err.message }, 401);
    }
    return c.json({ error: err.message }, 500);
  }
});

// Mount API
app.route("/api", api);

// Serve static files from public directory
app.get("/", (c) => {
  const htmlPath = path.join(__dirname, "public", "index.html");
  const html = fs.readFileSync(htmlPath, "utf-8");
  return c.html(html);
});

app.get("/static/*", serveStatic({ root: "./dashboard" }));

// Start server
const PORT = parseInt(process.env.DASHBOARD_PORT || "8080", 10);

console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   OCPP Virtual Charge Point - Dashboard                   ║
║                                                           ║
║   Open in browser: http://localhost:${PORT}                 ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);

serve({
  fetch: app.fetch,
  port: PORT,
});
