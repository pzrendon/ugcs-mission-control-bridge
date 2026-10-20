"use strict";

const http = require("node:http");
const https = require("node:https");
const { WebSocketServer, WebSocket } = require("ws");

const UGCS_HOST = process.env.UGCS_PROXY_TARGET || process.env.UGCS_HOST || "localhost:3334";
const MOCK_MODE = process.env.MOCK_MODE === "true";
const MAVLINK_MODE = process.env.MAVLINK_MODE === "true";
const MOCK_PORT = Number(process.env.MOCK_PORT) || 3335;
const MAVLINK_PORT = process.env.MAVLINK_PORT || "COM3";
const MAVLINK_BAUD = Number(process.env.MAVLINK_BAUD) || 57600;

let mockInstance = null;
let mavlinkInstance = null;
let httpBase;
let wsBackendBase;
let backendBase;
let currentMode = "live"; // "mock" | "mavlink" | "live"

if (MOCK_MODE) {
  const { startMock } = require("./mock-server");
  mockInstance = startMock(MOCK_PORT);
  httpBase = `http://127.0.0.1:${MOCK_PORT}`;
  wsBackendBase = `ws://127.0.0.1:${MOCK_PORT}`;
  backendBase = httpBase;
  currentMode = "mock";
} else if (MAVLINK_MODE) {
  httpBase = null;
  wsBackendBase = null;
  backendBase = null;
  currentMode = "mavlink";
} else {
  httpBase = UGCS_HOST.includes("://") ? UGCS_HOST : `http://${UGCS_HOST}`;
  wsBackendBase = UGCS_HOST.includes("://") ? UGCS_HOST.replace(/^http/, "ws") : `ws://${UGCS_HOST}`;
  backendBase = httpBase;
}

const apiPrefix = "/api/v1";

async function init() {
  if (!MAVLINK_MODE) return;
  const { startMavlinkBridge } = require("./mavlink-bridge");
  mavlinkInstance = await startMavlinkBridge(MAVLINK_PORT, MAVLINK_BAUD, MOCK_PORT);
  if (mavlinkInstance) {
    httpBase = `http://127.0.0.1:${MOCK_PORT}`;
    wsBackendBase = `ws://127.0.0.1:${MOCK_PORT}`;
    backendBase = httpBase;
  } else {
    console.warn("MAVLink bridge failed to open serial port; falling back to mock server.");
    const { startMock } = require("./mock-server");
    mockInstance = startMock(MOCK_PORT);
    httpBase = `http://127.0.0.1:${MOCK_PORT}`;
    wsBackendBase = `ws://127.0.0.1:${MOCK_PORT}`;
    backendBase = httpBase;
    currentMode = "mock";
  }
}

function proxyRequest(req, res, path, options = {}) {
  if (!backendBase) {
    res.status(503).json({ error: "UgCS backend not ready" });
    return;
  }
  const method = options.method || req.method;
  const body = options.body;
  const url = new URL(backendBase + path);
  const lib = url.protocol === "https:" ? https : http;
  const requestOptions = {
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname + url.search,
    method,
    headers: {
      "Content-Type": "application/json",
      ...(req.headers.host && { Host: req.headers.host }),
    },
  };
  if (body && (method === "POST" || method === "PUT")) {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    requestOptions.headers["Content-Length"] = Buffer.byteLength(data);
  }
  const proxyReq = lib.request(requestOptions, (proxyRes) => {
    res.status(proxyRes.statusCode || 500);
    Object.keys(proxyRes.headers).forEach((key) => {
      const v = proxyRes.headers[key];
      if (v !== undefined) res.setHeader(key, v);
    });
    proxyRes.pipe(res, { end: true });
  });
  proxyReq.on("error", (err) => {
    res.status(502).json({ error: err.message });
  });
  if (body && (method === "POST" || method === "PUT")) {
    proxyReq.write(typeof body === "string" ? body : JSON.stringify(body));
  }
  proxyReq.end();
}

function proxyJson(req, res, path, body) {
  const method = req.method;
  proxyRequest(req, res, path, { method, body });
}

async function checkConnected() {
  if (mavlinkInstance && currentMode === "mavlink") return mavlinkInstance.connected();
  if (mockInstance) return mockInstance != null;
  if (!backendBase) return false;
  return new Promise((resolve) => {
    const url = new URL(backendBase + apiPrefix + "/vehicles");
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "GET",
        timeout: 2000,
      },
      (res) => resolve(res.statusCode >= 200 && res.statusCode < 500)
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

const express = require("express");
const router = express.Router();
const db = require("./database");
const profilesStore = require("./profiles-store");
const laancStore = require("./laanc-store");
const laancClient = require("./laanc-client");

function laancDelay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

router.get("/laanc/config", (req, res) => {
  const mock = laancClient.isMockMode();
  const live = laancClient.hasLiveCredentials();
  res.json({
    mockMode: mock,
    live,
    liveAirmap: live,
    uss: laancClient.LAANC_USS,
    message: mock
      ? "MOCK_MODE=true — LAANC uses mock AirMap-style responses (no external USS calls)."
      : live
        ? null
        : "Set AIRMAP_CLIENT_ID and AIRMAP_CLIENT_SECRET (or AIRMAP_API_KEY / LAANC_USS_API_KEY) for live AirMap.",
  });
});

router.post("/laanc/check", async (req, res) => {
  try {
    const body = req.body || {};
    const r = await laancClient.searchAirspace({
      geometry: body.geometry,
      bbox: body.bbox,
      bufferMeters: body.bufferMeters != null ? Number(body.bufferMeters) : 0,
    });
    res.json({
      zones: r.zones,
      summary: r.summary,
      mode: r.mode,
      warning: r.warning || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.post("/laanc/submit", async (req, res) => {
  const body = req.body || {};
  try {
    if (laancClient.isMockMode()) await laancDelay(1200);

    let maxM = body.maxAltitudeAglM != null ? Number(body.maxAltitudeAglM) : null;
    if (maxM == null || Number.isNaN(maxM)) {
      const ft = body.maxAltitudeAglFt != null ? Number(body.maxAltitudeAglFt) : NaN;
      maxM = Number.isFinite(ft) ? ft * 0.3048 : 30;
    }

    const bufferM = body.bufferMeters != null ? Number(body.bufferMeters) : 50;
    const result = await laancClient.submitFlightPlan({
      geometry: body.geometry,
      bbox: body.bbox,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      maxAltitudeAglM: maxM,
      bufferMeters: bufferM,
      pilotId: body.pilotId || (body.operator && body.operator.remotePilotCertificateNumber),
      aircraftId: body.aircraftId || (body.aircraft && body.aircraft.registrationNumber),
      _forcePending: body._mockPending === true,
    });

    const planId = result.planId || result.authId;
    const loc = body.bboxBuffered || body.bbox;
    const rec = {
      authId: planId,
      authorizationNumber: result.authorizationNumber || planId,
      status: result.status,
      mode: laancClient.isMockMode() || !laancClient.hasLiveCredentials() ? "mock" : "live",
      provider: "airmap",
      startsAt: body.startsAt || null,
      endsAt: body.endsAt || null,
      expiresAt: result.expiresAt || body.endsAt || null,
      bbox: body.bbox || null,
      bboxBuffered: body.bboxBuffered || null,
      bufferM: Number.isFinite(bufferM) ? bufferM : 50,
      geometry: body.geometry || null,
      createdAt: new Date().toISOString(),
      providerRaw: result.raw,
      locationSummary: loc
        ? `${Number(loc.minLat).toFixed(4)},${Number(loc.minLon).toFixed(4)}`
        : null,
      payloadSummary: {
        maxAltitudeAglM: maxM,
        affectedZonesCheck: body.affectedZonesCheck,
      },
    };
    laancStore.save(rec);

    let deniedReason = null;
    if (result.status === "denied" && result.raw) {
      deniedReason =
        result.raw.reason ||
        result.raw.message ||
        (typeof result.raw.error === "string" ? result.raw.error : null);
    }

    res.json({
      success: true,
      mode: rec.mode,
      planId: rec.authId,
      authId: rec.authId,
      authorizationNumber: rec.authorizationNumber,
      status: rec.status,
      expiresAt: rec.expiresAt,
      pending: rec.status === "pending",
      deniedReason,
    });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message || String(e) });
  }
});

router.get("/laanc/status/:planId", async (req, res) => {
  const planId = req.params.planId;
  let rec = laancStore.get(planId);
  if (!rec) {
    res.status(404).json({ error: "Unknown plan id" });
    return;
  }
  const pendingMock = rec.status === "pending" && String(planId).startsWith("MOCK-PLAN");
  const shouldPoll = rec.status === "pending" && (laancClient.hasLiveCredentials() || pendingMock);
  if (shouldPoll) {
    try {
      const patch = await laancClient.refreshPlanStatus(rec);
      if (patch && patch.status) {
        laancStore.update(planId, {
          status: patch.status,
          authorizationNumber: patch.authorizationNumber || rec.authorizationNumber,
          providerRaw: patch.providerRaw,
        });
        rec = laancStore.get(planId);
      }
    } catch (_) {
      /* keep last known */
    }
  }
  const now = Date.now();
  let effectiveStatus = rec.status;
  if (rec.status === "cancelled") effectiveStatus = "cancelled";
  else   if (rec.endsAt && effectiveStatus === "authorized") {
    const endMs = Date.parse(rec.endsAt);
    if (!Number.isNaN(endMs) && now > endMs) effectiveStatus = "expired";
  }
  let deniedReason = null;
  const raw = rec.providerRaw;
  if (raw && typeof raw === "object") {
    deniedReason = raw.reason || raw.message || (typeof raw.error === "string" ? raw.error : null);
  }
  res.json({
    planId: rec.authId,
    authId: rec.authId,
    authorizationNumber: rec.authorizationNumber,
    status: effectiveStatus,
    storedStatus: rec.status,
    startsAt: rec.startsAt,
    endsAt: rec.endsAt,
    expiresAt: rec.expiresAt,
    bbox: rec.bbox,
    bboxBuffered: rec.bboxBuffered || null,
    bufferM: rec.bufferM,
    mode: rec.mode,
    provider: rec.provider || null,
    note: rec.note || null,
    deniedReason,
  });
});

router.delete("/laanc/cancel/:planId", async (req, res) => {
  const planId = req.params.planId;
  const rec = laancStore.get(planId);
  if (!rec) {
    res.status(404).json({ error: "Unknown plan id" });
    return;
  }
  try {
    await laancClient.cancelFlightPlan(planId);
    laancStore.update(planId, { status: "cancelled" });
    res.json({ success: true, planId });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message || String(e) });
  }
});

router.get("/laanc/history", (req, res) => {
  res.json({
    items: laancStore.listHistory(),
    clientStorageKey: "ugcs-laanc-history-v1",
  });
});

router.get("/status", async (req, res) => {
  const connected = await checkConnected();
  res.json({
    mode: MOCK_MODE ? "mock" : "live",
    ugcsHost: UGCS_HOST,
    connected,
  });
});

router.get("/vehicles", (req, res) => {
  proxyRequest(req, res, apiPrefix + "/vehicles");
});

router.post("/vehicles/create", (req, res) => {
  proxyJson(req, res, apiPrefix + "/vehicles/create", req.body);
});

router.post("/vehicles/:id/position", (req, res) => {
  const { id } = req.params;
  proxyJson(req, res, apiPrefix + "/vehicles/" + encodeURIComponent(id) + "/position", req.body);
});

router.get("/missions", (req, res) => {
  if (MOCK_MODE) {
    const { FAKE_MISSIONS } = require("./mock-server");
    const saved = db.missions.getAll().map((m) => ({
      id: m.id,
      name: m.name,
      waypointCount: Array.isArray(m.waypoints) ? m.waypoints.length : 0,
      lastModified: new Date(m.updatedAt).toISOString(),
    }));
    res.json([...FAKE_MISSIONS, ...saved]);
    return;
  }
  proxyRequest(req, res, apiPrefix + "/missions");
});

router.get("/missions/:id", (req, res) => {
  const { id } = req.params;
  if (MOCK_MODE) {
    const { FAKE_MISSIONS } = require("./mock-server");
    const fake = FAKE_MISSIONS.find((m) => String(m.id) === String(id));
    if (fake) {
      res.json({
        id: fake.id,
        name: fake.name,
        waypointCount: fake.waypointCount || 0,
        lastModified: fake.lastModified,
      });
      return;
    }
    const saved = db.missions.get(id);
    if (!saved) {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    res.json({
      id: saved.id,
      name: saved.name,
      waypointCount: Array.isArray(saved.waypoints) ? saved.waypoints.length : 0,
      lastModified: new Date(saved.updatedAt).toISOString(),
      waypoints: saved.waypoints,
    });
    return;
  }
  proxyRequest(req, res, apiPrefix + "/missions/" + encodeURIComponent(id));
});

router.delete("/missions/:id", (req, res) => {
  const { id } = req.params;
  if (MOCK_MODE) {
    const { FAKE_MISSIONS } = require("./mock-server");
    if (FAKE_MISSIONS.some((m) => String(m.id) === String(id))) {
      res.status(403).json({ error: "Cannot delete catalog mission" });
      return;
    }
    if (!db.missions.get(id)) {
      res.status(404).json({ error: "Mission not found" });
      return;
    }
    db.missions.delete(id);
    res.json({ success: true });
    return;
  }
  proxyRequest(req, res, apiPrefix + "/missions/" + encodeURIComponent(id), { method: "DELETE" });
});

router.post("/missions/upload", (req, res) => {
  proxyJson(req, res, apiPrefix + "/missions/upload", req.body);
});

router.post("/missions/save", (req, res) => {
  if (MOCK_MODE) {
    const { normalizeStoredWaypoint } = require("./mock-server");
    const data = req.body || {};
    const name = (data.name || "").trim() || "Unnamed route";
    const raw = Array.isArray(data.waypoints) ? data.waypoints : [];
    const waypoints = raw.map(normalizeStoredWaypoint).filter(Boolean);
    const mid = data.id && String(data.id).trim() ? String(data.id).trim() : "mission_" + Date.now();
    db.missions.save(mid, name, waypoints);
    res.json({ success: true, id: mid, name });
    return;
  }
  proxyJson(req, res, apiPrefix + "/missions/save", req.body);
});

router.post("/missions/:id/upload", (req, res) => {
  const { id } = req.params;
  proxyJson(req, res, apiPrefix + "/missions/" + encodeURIComponent(id) + "/upload", req.body);
});

router.post("/vehicles/:id/command", (req, res) => {
  const { id } = req.params;
  proxyJson(req, res, apiPrefix + "/vehicles/" + encodeURIComponent(id) + "/command", req.body);
});

router.get("/flight-logs", (req, res) => {
  if (MOCK_MODE) {
    res.json(db.flightLogs.getAll());
    return;
  }
  proxyRequest(req, res, apiPrefix + "/flight-logs");
});

router.get("/flight-logs/:vehicleId", (req, res) => {
  const { vehicleId } = req.params;
  if (MOCK_MODE) {
    const startTime = req.query.startTime || "";
    const log = db.flightLogs.get(vehicleId, startTime);
    if (!log) {
      res.status(404).json({ error: "Flight log not found" });
      return;
    }
    res.json(log);
    return;
  }
  const startQ = req.query.startTime ? "?startTime=" + encodeURIComponent(req.query.startTime) : "";
  proxyRequest(req, res, apiPrefix + "/flight-logs/" + encodeURIComponent(vehicleId) + startQ);
});

router.post("/vehicles/:id/profiles", (req, res) => {
  const { id } = req.params;
  proxyJson(req, res, apiPrefix + "/vehicles/" + encodeURIComponent(id) + "/profiles", req.body);
});

router.get("/drone-profiles", (req, res) => {
  res.json(profilesStore.listDroneProfiles());
});

router.post("/drone-profiles", (req, res) => {
  const p = profilesStore.createDroneProfile(req.body || {});
  res.status(201).json(p);
});

router.put("/drone-profiles/:id", (req, res) => {
  const p = profilesStore.updateDroneProfile(req.params.id, req.body || {});
  if (!p) {
    res.status(404).json({ error: "Drone profile not found" });
    return;
  }
  res.json(p);
});

router.delete("/drone-profiles/:id", (req, res) => {
  const id = req.params.id;
  const existed = profilesStore.getDroneProfile(id);
  const ok = profilesStore.deleteDroneProfile(id);
  if (!ok) {
    const forbidden = !!(existed && existed.builtIn);
    res.status(forbidden ? 403 : 404).json({
      error: forbidden ? "Cannot delete built-in profile" : "Drone profile not found",
    });
    return;
  }
  res.json({ success: true });
});

router.get("/payload-profiles", (req, res) => {
  const sampleAltM = req.query.sampleAltM != null ? req.query.sampleAltM : req.query.altM;
  res.json(profilesStore.listPayloadProfiles(sampleAltM));
});

router.get("/payload-profiles/:id", (req, res) => {
  const sampleAltM = req.query.sampleAltM != null ? req.query.sampleAltM : req.query.altM;
  const p = profilesStore.getPayloadProfile(req.params.id, sampleAltM);
  if (!p) {
    res.status(404).json({ error: "Payload profile not found" });
    return;
  }
  res.json(p);
});

router.post("/payload-profiles", (req, res) => {
  const p = profilesStore.createPayloadProfile(req.body || {});
  res.status(201).json(p);
});

router.put("/payload-profiles/:id", (req, res) => {
  const p = profilesStore.updatePayloadProfile(req.params.id, req.body || {});
  if (!p) {
    res.status(404).json({ error: "Payload profile not found" });
    return;
  }
  res.json(p);
});

router.delete("/payload-profiles/:id", (req, res) => {
  const id = req.params.id;
  const existed = profilesStore.getPayloadProfile(id);
  const ok = profilesStore.deletePayloadProfile(id);
  if (!ok) {
    const forbidden = !!(existed && existed.builtIn);
    res.status(forbidden ? 403 : 404).json({
      error: forbidden ? "Cannot delete built-in profile" : "Payload profile not found",
    });
    return;
  }
  res.json({ success: true });
});

const wss = new WebSocketServer({ noServer: true });
function getWsBackendUrl() {
  return wsBackendBase ? wsBackendBase + (wsBackendBase.endsWith("/") ? "" : "/") : null;
}

function handleUgcsUpgrade(request, socket, head) {
  const path = request.url?.split("?")[0] || "";
  if (path !== "/ugcs/telemetry") {
    socket.destroy();
    return;
  }
  const wsBackendUrl = getWsBackendUrl();
  if (!wsBackendUrl) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (clientWs) => {
    wss.emit("connection", clientWs, request);
    const backendWs = new WebSocket(wsBackendUrl);
    backendWs.on("open", () => {
      clientWs.on("message", (data) => {
        try {
          backendWs.send(data);
        } catch (_) {}
      });
      backendWs.on("message", (data) => {
        try {
          clientWs.send(data);
        } catch (_) {}
      });
    });
    backendWs.on("error", () => {
      try { clientWs.close(); } catch (_) {}
    });
    clientWs.on("close", () => {
      try { backendWs.close(); } catch (_) {}
    });
    backendWs.on("close", () => {
      try { clientWs.close(); } catch (_) {}
    });
  });
}

module.exports = { router, handleUgcsUpgrade, init };
