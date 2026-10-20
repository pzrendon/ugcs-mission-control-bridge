require("dotenv").config();
"use strict";

const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { config } = require("./config");
const { createUgcsBridgeClient } = require("./ugcsBridgeClient");
const { router: ugcsRouter, handleUgcsUpgrade, init: initUgcs } = require("../ugcs/router");
const missionIo = require("../ugcs/mission-io");

const app = express();
const ugcsBridge = createUgcsBridgeClient(config.javaBridgeUrl);

/**
 * Parse incoming JSON request bodies (generous limit for mission file import).
 */
app.use(express.json({ limit: "15mb" }));

/**
 * Cesium Ion access token (from env; never embed in frontend source).
 */
app.get("/ugcs/cesium-token", (req, res) => {
  res.json({ token: process.env.CESIUM_ION_TOKEN || "" });
});

/**
 * UgCS proxy routes (mock or live), drone/payload profiles, LAANC (AirMap USS via ugcs/laanc-client.js), etc.
 * Drone profiles may include a customBuild object from the vehicle builder UI.
 * WS /ugcs/telemetry handled in server upgrade.
 */
app.use("/ugcs", ugcsRouter);

/**
 * Serve the frontend files (index.html, app.js, styles.css) from /frontend.
 * This keeps deployment simple: one Node server for both UI and API.
 */
app.use(express.static(path.join(__dirname, "..", "frontend")));

/**
 * Serve public assets (e.g. ugcs-map.html) from /public.
 */
app.use(express.static(path.join(__dirname, "..", "public")));

/**
 * Basic health endpoint for quick troubleshooting.
 */
app.get("/api/health", async (req, res) => {
  try {
    const javaHealth = await ugcsBridge.health();
    res.json({
      status: "ok",
      node: "up",
      javaBridge: javaHealth
    });
  } catch (error) {
    res.status(502).json({
      status: "degraded",
      node: "up",
      javaBridge: "down",
      error: error.message
    });
  }
});

/**
 * Mission list endpoint (proxied to Java bridge).
 */
app.get("/api/missions", async (req, res) => {
  try {
    const payload = await ugcsBridge.listMissions();
    res.json(payload);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

/**
 * Vehicle list endpoint (proxied to Java bridge).
 */
app.get("/api/vehicles", async (req, res) => {
  try {
    const payload = await ugcsBridge.listVehicles();
    res.json(payload);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

/**
 * Upload selected mission to selected vehicle.
 */
app.post("/api/missions/:missionId/upload", async (req, res) => {
  try {
    const missionId = Number.parseInt(req.params.missionId, 10);
    const vehicleId = Number.parseInt(req.body.vehicleId, 10);

    if (Number.isNaN(missionId) || Number.isNaN(vehicleId)) {
      res.status(400).json({ error: "missionId and vehicleId must be numbers" });
      return;
    }

    const payload = await ugcsBridge.uploadMission(missionId, vehicleId);
    res.json(payload);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

/**
 * Send direct vehicle commands (arm/takeoff/rth/land).
 */
app.post("/api/commands/:command", async (req, res) => {
  try {
    const command = String(req.params.command || "").trim().toLowerCase();
    const vehicleId = Number.parseInt(req.body.vehicleId, 10);
    const takeoffAltitudeM =
      req.body.takeoffAltitudeM === undefined || req.body.takeoffAltitudeM === null
        ? undefined
        : Number(req.body.takeoffAltitudeM);

    if (Number.isNaN(vehicleId)) {
      res.status(400).json({ error: "vehicleId must be a number" });
      return;
    }

    const payload = await ugcsBridge.sendCommand(command, vehicleId, takeoffAltitudeM);
    res.json(payload);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

/**
 * Get latest telemetry. If vehicleId is provided, return only that vehicle.
 */
app.get("/api/telemetry", async (req, res) => {
  try {
    const vehicleId = req.query.vehicleId;
    const payload = await ugcsBridge.getTelemetry(vehicleId);
    res.json(payload);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

/**
 * Parse mission files (.json, .kml, .csv, ArduPilot .waypoints) to waypoint objects.
 * Used by ugcs-map import; same logic as ugcs/mission-io.js.
 */
app.post("/api/missions/parse", (req, res) => {
  try {
    const content = req.body && req.body.content;
    const filename = (req.body && req.body.filename) || "";
    if (typeof content !== "string") {
      res.status(400).json({ error: "Request body must include content (string)" });
      return;
    }
    const waypoints = missionIo.parseMissionContent(content, filename);
    res.json({ waypoints, count: waypoints.length });
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

/**
 * SPA fallback: if user refreshes a route, still serve index.html.
 * Using app.use here avoids Express 5 wildcard route syntax issues.
 */
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
});

const server = http.createServer(app);
server.on("upgrade", (request, socket, head) => {
  const pathname = request.url?.split("?")[0] || "";
  if (pathname === "/ugcs/telemetry") {
    handleUgcsUpgrade(request, socket, head);
  } else {
    socket.destroy();
  }
});

(async () => {
  await initUgcs();
  server.listen(config.nodePort, () => {
    console.log(`Node backend listening on http://localhost:${config.nodePort}`);
    console.log(`Using Java bridge at ${config.javaBridgeUrl}`);
  });
})();
