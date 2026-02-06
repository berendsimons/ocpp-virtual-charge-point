import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { chargerManager } from "./chargerManager";
import * as path from "node:path";
import * as fs from "node:fs";
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
  const { prefix, count, vendor, model, firmwareVersion, connectors } = body;

  if (!prefix || !count) {
    return c.json({ error: "prefix and count are required" }, 400);
  }

  const created = chargerManager.generateChargers(prefix, count, {
    vendor: vendor || "VirtualCharger",
    model: model || "VCP-1",
    firmwareVersion: firmwareVersion || "1.0.0",
    connectors: connectors || 1,
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
