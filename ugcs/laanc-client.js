"use strict";

/* LAANC USS ROADMAP
 * Current: AirMap USS integration (consumer)
 * Potential future: FAA-authorized USS integration (not implemented)
 *
 * To swap in direct FAA integration:
 * 1. Replace submitFlightPlan() with FAA LAANC-AP POST /flight_plan
 * 2. Replace token fetch with FAA OAuth2 (UAS Common Auth Service)
 * 3. Add webhook receiver at POST /ugcs/laanc/webhook for
 *    FAA-initiated status updates
 * 4. Add GeoJSON validation against FAA UAS Facility Maps
 * 5. Implement Further Coordination workflow for non-instant zones
 *
 * FAA API docs provided after Formal Testing invitation:
 * Apply at: 9-AJM-USS-Applications@faa.gov
 * USS Performance Rules: https://www.faa.gov/uas/programs_partnerships/
 *   data_exchange/laanc_for_industry/
 */

require("dotenv").config();
const https = require("node:https");
const http = require("node:http");

const MOCK_MODE = process.env.MOCK_MODE === "true";
const LAANC_USS = (process.env.LAANC_USS || "airmap").toLowerCase().trim();

const AIRMAP_CLIENT_ID = (process.env.AIRMAP_CLIENT_ID || "").trim();
const AIRMAP_CLIENT_SECRET = (process.env.AIRMAP_CLIENT_SECRET || "").trim();
const AIRMAP_API_KEY = (process.env.AIRMAP_API_KEY || "").trim();
const LAANC_USS_API_KEY = (process.env.LAANC_USS_API_KEY || "").trim();

const AUTH_URL = "https://auth.airmap.com/realms/airmap/protocol/openid-connect/token";
const API_FLIGHT_BASE = "https://api.airmap.com/flight/v2";
const API_AIRSPACE_SEARCH = "https://api.airmap.com/airspace/v2/search";

/** Simplified zones for MOCK_MODE / offline check (aligns with ugcs-map.html model). */
const MOCK_ZONES = [
  { id: "klgb-d", name: "KLGB", class: "D", ceilingLabel: "SFC-2500ft", authType: "instant" },
  { id: "ksna-c-inner", name: "KSNA", class: "C", ceilingLabel: "1200-4200ft", authType: "instant" },
  { id: "ksna-c-outer", name: "KSNA", class: "C", ceilingLabel: "SFC-4200ft", authType: "instant" },
  { id: "klax-b-core", name: "KLAX", class: "B", ceilingLabel: "SFC-10000ft", authType: "instant" },
  { id: "klax-b-mid", name: "KLAX", class: "B", ceilingLabel: "2500-10000ft", authType: "manual" },
  { id: "klax-b-outer", name: "KLAX", class: "B", ceilingLabel: "SFC-10000ft", authType: "manual" },
  { id: "mock-prohibited", name: "MOCK Restricted", class: "R", ceilingLabel: "Prohibited", authType: "prohibited" },
];

let tokenCache = { accessToken: null, expiresAtMs: 0 };

function isMockMode() {
  return MOCK_MODE === true;
}

/**
 * Live AirMap API: OAuth2 client credentials and/or static API key fallback.
 */
function hasAirmapCredentials() {
  if (AIRMAP_CLIENT_ID && AIRMAP_CLIENT_SECRET) return true;
  if (AIRMAP_API_KEY) return true;
  if (LAANC_USS_API_KEY) return true;
  return false;
}

function hasLiveCredentials() {
  return !isMockMode() && hasAirmapCredentials() && LAANC_USS === "airmap";
}

function buildOperationPolygon(bbox) {
  if (!bbox || bbox.minLat == null) return null;
  const { minLat, maxLat, minLon, maxLon } = bbox;
  return {
    type: "Polygon",
    coordinates: [
      [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ],
    ],
  };
}

function expandBboxByBufferMeters(bbox, bufferM) {
  if (!bbox || bufferM == null || bufferM <= 0) return bbox;
  const latC = (bbox.minLat + bbox.maxLat) / 2;
  const cos = Math.cos((latC * Math.PI) / 180) || 1;
  const dLat = bufferM / 111320;
  const dLon = bufferM / (111320 * cos);
  return {
    minLat: bbox.minLat - dLat,
    maxLat: bbox.maxLat + dLat,
    minLon: bbox.minLon - dLon,
    maxLon: bbox.maxLon + dLon,
  };
}

function pointInBufferedZone(lat, lon, zone) {
  const centers = {
    "klgb-d": [33.8177, -118.1516],
    "ksna-c-inner": [33.6757, -117.8682],
    "ksna-c-outer": [33.6757, -117.8682],
    "klax-b-core": [33.9425, -118.4081],
    "klax-b-mid": [33.9425, -118.4081],
    "klax-b-outer": [33.9425, -118.4081],
  };
  const radiiM = {
    "klgb-d": 5 * 1852,
    "ksna-c-inner": 5 * 1852,
    "ksna-c-outer": 10 * 1852,
    "klax-b-core": 10 * 1852,
    "klax-b-mid": 20 * 1852,
    "klax-b-outer": 30 * 1852,
  };
  if (zone.id === "mock-prohibited") {
    return lat > 33.9 && lat < 33.95 && lon > -118.2 && lon < -118.15;
  }
  const c = centers[zone.id];
  const R = 6371000;
  if (!c) return false;
  const φ1 = (c[0] * Math.PI) / 180;
  const φ2 = (lat * Math.PI) / 180;
  const Δφ = ((lat - c[0]) * Math.PI) / 180;
  const Δλ = ((lon - c[1]) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const d = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  return d <= (radiiM[zone.id] || 0) + 1;
}

function mockAirspaceZonesForBbox(bbox) {
  if (!bbox) return { zones: [], summary: { allInstant: true, anyManual: false, anyProhibited: false } };
  const pts = [
    { lat: bbox.minLat, lon: bbox.minLon },
    { lat: bbox.minLat, lon: bbox.maxLon },
    { lat: bbox.maxLat, lon: bbox.minLon },
    { lat: bbox.maxLat, lon: bbox.maxLon },
    { lat: (bbox.minLat + bbox.maxLat) / 2, lon: (bbox.minLon + bbox.maxLon) / 2 },
  ];
  const hit = new Set();
  MOCK_ZONES.forEach((z) => {
    if (pts.some((p) => pointInBufferedZone(p.lat, p.lon, z))) hit.add(z.id);
  });
  const zones = MOCK_ZONES.filter((z) => hit.has(z.id)).map((z) => ({
    id: z.id,
    name: z.name,
    class: z.class,
    ceiling: z.ceilingLabel,
    authorizationType: z.authType,
  }));
  const anyProhibited = zones.some((z) => z.authorizationType === "prohibited");
  const anyManual = zones.some((z) => z.authorizationType === "manual");
  const allInstant = zones.length > 0 && zones.every((z) => z.authorizationType === "instant");
  return {
    zones,
    summary: {
      allInstant: zones.length === 0 ? true : allInstant,
      anyManual,
      anyProhibited,
    },
    mode: "mock",
  };
}

function fetchUrl(url, { method = "GET", headers = {}, body = null, formBody = null } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const lib = u.protocol === "https:" ? https : http;
    const payload =
      formBody != null
        ? formBody
        : body != null
          ? typeof body === "string"
            ? body
            : JSON.stringify(body)
          : null;
    const h = { ...headers };
    if (formBody != null) h["Content-Type"] = "application/x-www-form-urlencoded";
    else if (payload && method !== "GET") h["Content-Type"] = "application/json";
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: {
          ...(payload && method !== "GET" ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...h,
        },
        timeout: 60000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          let json = {};
          if (data) {
            try {
              json = JSON.parse(data);
            } catch (_) {
              json = { _raw: data };
            }
          }
          resolve({ status: res.statusCode || 500, json, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("AirMap request timeout"));
    });
    if (payload && method !== "GET") req.write(payload);
    req.end();
  });
}

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expiresAtMs - 60000) {
    return tokenCache.accessToken;
  }
  if (AIRMAP_CLIENT_ID && AIRMAP_CLIENT_SECRET) {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: AIRMAP_CLIENT_ID,
      client_secret: AIRMAP_CLIENT_SECRET,
    }).toString();
    const { status, json } = await fetchUrl(AUTH_URL, {
      method: "POST",
      formBody: form,
      headers: {},
    });
    if (status >= 400) {
      const msg = json.error_description || json.error || "AirMap OAuth failed";
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(json));
    }
    const tok = json.access_token;
    const expSec = Number(json.expires_in) || 3300;
    tokenCache = {
      accessToken: tok,
      expiresAtMs: now + expSec * 1000,
    };
    return tok;
  }
  return null;
}

function bearerForApi() {
  const staticKey = AIRMAP_API_KEY || LAANC_USS_API_KEY;
  return staticKey || null;
}

async function apiAuthorizationHeader() {
  const tok = await getAccessToken().catch(() => null);
  if (tok) return "Bearer " + tok;
  const k = bearerForApi();
  if (k) return "Bearer " + k;
  throw new Error("No AirMap credentials (set AIRMAP_CLIENT_ID/SECRET or AIRMAP_API_KEY)");
}

function mapUssStatus(s) {
  if (s == null) return "pending";
  const x = String(s).toLowerCase();
  if (x.includes("approv") || x.includes("authoriz") || x === "accepted" || x === "active") return "authorized";
  if (x.includes("denied") || x.includes("reject")) return "denied";
  if (x.includes("expired")) return "expired";
  if (x.includes("cancel")) return "cancelled";
  if (x.includes("pending") || x.includes("submitted") || x.includes("processing")) return "pending";
  return "pending";
}

function normalizeAirspaceResponse(json) {
  const zones = [];
  const list = json.data || json.features || json.airspaces || json.results || json.items || [];
  const arr = Array.isArray(list) ? list : [];
  arr.forEach((item, i) => {
    const props = item.properties || item;
    const name = props.name || props.title || props.id || "Zone " + (i + 1);
    const klass = props.class || props.type || props.category || "—";
    const ceiling = props.ceiling || props.altitude_ceiling || props.upper_limit || "—";
    let authorizationType = "manual";
    const rules = (props.rules || props.authorization || "").toString().toLowerCase();
    if (rules.includes("prohibit") || props.prohibited) authorizationType = "prohibited";
    else if (rules.includes("instant") || rules.includes("auto") || props.laanc_instant) authorizationType = "instant";
    zones.push({
      id: String(props.id || item.id || i),
      name: String(name),
      class: String(klass),
      ceiling: String(ceiling),
      authorizationType,
    });
  });
  const anyProhibited = zones.some((z) => z.authorizationType === "prohibited");
  const anyManual = zones.some((z) => z.authorizationType === "manual");
  const allInstant = zones.length === 0 ? true : zones.every((z) => z.authorizationType === "instant");
  return { zones, summary: { allInstant, anyManual, anyProhibited }, mode: "live" };
}

/**
 * Airspace check: POST /airspace/v2/search with GeoJSON body.
 * (Some docs reference GET with geometry; this integration uses POST for reliable GeoJSON payloads.)
 * Falls back to mock when MOCK_MODE or on request error in dev.
 */
async function searchAirspace({ geometry, bbox, bufferMeters }) {
  let poly = geometry;
  if (!poly && bbox) {
    const bb = expandBboxByBufferMeters(bbox, bufferMeters || 0);
    poly = buildOperationPolygon(bb);
  }
  if (isMockMode()) {
    const bb = bbox || (poly ? bboxFromPolygon(poly) : null);
    return mockAirspaceZonesForBbox(expandBboxByBufferMeters(bb, bufferMeters || 0));
  }
  if (!hasAirmapCredentials() || LAANC_USS !== "airmap") {
    const bb = bbox || (poly ? bboxFromPolygon(poly) : null);
    return mockAirspaceZonesForBbox(expandBboxByBufferMeters(bb, bufferMeters || 0));
  }
  try {
    const auth = await apiAuthorizationHeader();
    const { status, json } = await fetchUrl(API_AIRSPACE_SEARCH, {
      method: "POST",
      headers: { Authorization: auth, Accept: "application/json" },
      body: { geometry: poly },
    });
    if (status >= 400) {
      const bb = bbox || (poly ? bboxFromPolygon(poly) : null);
      const fallback = mockAirspaceZonesForBbox(expandBboxByBufferMeters(bb, bufferMeters || 0));
      fallback.mode = "mock";
      fallback.warning = "AirMap airspace search failed; using local model. " + (json.message || json.error || status);
      return fallback;
    }
    const norm = normalizeAirspaceResponse(json);
    norm.mode = "live";
    return norm;
  } catch (e) {
    const bb = bbox || (poly ? bboxFromPolygon(poly) : null);
    const fallback = mockAirspaceZonesForBbox(expandBboxByBufferMeters(bb, bufferMeters || 0));
    fallback.mode = "mock";
    fallback.warning = e.message || String(e);
    return fallback;
  }
}

function bboxFromPolygon(poly) {
  if (!poly || !poly.coordinates || !poly.coordinates[0]) return null;
  const ring = poly.coordinates[0];
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  ring.forEach((c) => {
    const lon = c[0];
    const lat = c[1];
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  });
  return { minLat, maxLat, minLon, maxLon };
}

function pickPlanId(json) {
  if (!json || typeof json !== "object") return "";
  return json.id || json.plan_id || (json.data && (json.data.id || json.data.plan_id)) || "";
}

function pickAuthNumber(json) {
  if (!json || typeof json !== "object") return "";
  return (
    json.authorization ||
    json.authorization_number ||
    (json.data && (json.data.authorization || json.data.authorization_number)) ||
    ""
  );
}

async function submitFlightPlan(payload) {
  const geometry = payload.geometry || buildOperationPolygon(payload.bbox);
  if (!geometry) throw new Error("Missing operation geometry");

  const body = {
    geometry,
    max_altitude_agl: payload.maxAltitudeAglM != null ? payload.maxAltitudeAglM : payload.max_altitude_agl,
    start_time: payload.startsAt || payload.start_time,
    end_time: payload.endsAt || payload.end_time,
    pilot_id: payload.pilotId || payload.pilot_id,
    aircraft_id: payload.aircraftId || payload.aircraft_id,
    buffer: payload.bufferMeters != null ? payload.bufferMeters : payload.buffer || 0,
  };

  if (isMockMode() || !hasLiveCredentials()) {
    const pending = payload._forcePending === true;
    const planId = "MOCK-PLAN-" + Math.random().toString(36).substring(2, 10).toUpperCase();
    if (pending) {
      return {
        planId,
        authId: planId,
        status: "pending",
        authorizationNumber: null,
        expiresAt: payload.endsAt,
        raw: { mock: true, pending: true },
      };
    }
    const authNum = "LAANC-" + Math.random().toString(36).substring(2, 8).toUpperCase();
    return {
      planId: authNum,
      authId: authNum,
      status: "authorized",
      authorizationNumber: authNum,
      expiresAt: payload.endsAt,
      raw: { mock: true },
    };
  }

  const auth = await apiAuthorizationHeader();
  const { status, json } = await fetchUrl(API_FLIGHT_BASE + "/plan", {
    method: "POST",
    headers: { Authorization: auth, Accept: "application/json" },
    body,
  });
  if (status >= 400) {
    const msg = json.message || json.error || json.detail || "Flight plan rejected (" + status + ")";
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  const planId = pickPlanId(json) || "AIRMAP-" + Date.now();
  const st = mapUssStatus(json.status || json.state || (json.data && json.data.status));
  return {
    planId,
    authId: planId,
    status: st,
    authorizationNumber: pickAuthNumber(json) || (st === "authorized" ? planId : null),
    expiresAt: payload.endsAt,
    raw: json,
  };
}

async function getFlightPlanStatus(planId, options = {}) {
  if (isMockMode() || !hasLiveCredentials()) {
    if (String(planId).startsWith("MOCK-PLAN")) {
      const t0 = options.createdAt ? Date.parse(options.createdAt) : 0;
      if (t0 && Date.now() - t0 > 12000) {
        return {
          status: "authorized",
          authorizationNumber: "LAANC-" + String(planId).replace(/^MOCK-PLAN-/, "").slice(0, 8),
          raw: { mock: true, simulatedApproval: true },
        };
      }
      return { status: "pending", authorizationNumber: null, raw: { mock: true } };
    }
    return { status: "authorized", authorizationNumber: planId, raw: { mock: true } };
  }
  const auth = await apiAuthorizationHeader();
  const { status, json } = await fetchUrl(API_FLIGHT_BASE + "/plan/" + encodeURIComponent(planId), {
    method: "GET",
    headers: { Authorization: auth, Accept: "application/json" },
  });
  if (status >= 400) throw new Error(json.message || json.error || "Status check failed");
  const st = mapUssStatus(json.status || json.state);
  return {
    status: st,
    authorizationNumber: pickAuthNumber(json) || null,
    raw: json,
  };
}

async function cancelFlightPlan(planId) {
  if (isMockMode() || !hasLiveCredentials()) {
    return { success: true, mock: true };
  }
  const auth = await apiAuthorizationHeader();
  const { status, json } = await fetchUrl(API_FLIGHT_BASE + "/plan/" + encodeURIComponent(planId), {
    method: "DELETE",
    headers: { Authorization: auth, Accept: "application/json" },
  });
  if (status >= 400 && status !== 404) {
    throw new Error(json.message || json.error || "Cancel failed");
  }
  return { success: true, raw: json };
}

async function refreshPlanStatus(record) {
  if (!record || !record.authId) return null;
  try {
    const r = await getFlightPlanStatus(record.authId, { createdAt: record.createdAt });
    return {
      status: r.status,
      providerRaw: r.raw,
      authorizationNumber: r.authorizationNumber || record.authorizationNumber,
    };
  } catch (_) {
    return null;
  }
}

module.exports = {
  LAANC_USS,
  isMockMode,
  hasAirmapCredentials,
  hasLiveCredentials,
  getAccessToken,
  buildOperationPolygon,
  expandBboxByBufferMeters,
  searchAirspace,
  submitFlightPlan,
  getFlightPlanStatus,
  cancelFlightPlan,
  refreshPlanStatus,
  mapUssStatus,
  mockAirspaceZonesForBbox,
};
