"use strict";

/** @typedef {{ lat: number, lon: number, altitudeM: number, speedMs: number, heading: number, hoverTimeSeconds: number, actions: unknown[], turnType?: string, altitudeMode?: string, headingMode?: string, gimbalAngle?: number, azimuth?: number, poiLat?: number|null, poiLon?: number|null, arduPilotCommand?: number }} MissionWaypoint */

const MAV_CMD_NAV_WAYPOINT = 16;
const MAV_CMD_NAV_RETURN_TO_LAUNCH = 20;
const MAV_CMD_NAV_TAKEOFF = 22;

function clampNumber(n, def) {
  const x = Number(n);
  return Number.isFinite(x) ? x : def;
}

/** Normalize parsed object to mission waypoint (no id). */
function normalizeWaypoint(w) {
  const actions = Array.isArray(w.actions) ? w.actions : [];
  return {
    lat: clampNumber(w.lat, 0),
    lon: clampNumber(w.lon, 0),
    altitudeM: w.altitudeM != null ? clampNumber(w.altitudeM, 30) : 30,
    speedMs: w.speedMs != null ? clampNumber(w.speedMs, 5) : 5,
    heading: w.heading != null ? clampNumber(w.heading, 0) : 0,
    hoverTimeSeconds: w.hoverTimeSeconds != null ? clampNumber(w.hoverTimeSeconds, 0) : 0,
    turnType: w.turnType || "stop",
    altitudeMode: w.altitudeMode || "amsl",
    headingMode: w.headingMode || "auto",
    poiLat: w.poiLat != null && Number.isFinite(Number(w.poiLat)) ? Number(w.poiLat) : null,
    poiLon: w.poiLon != null && Number.isFinite(Number(w.poiLon)) ? Number(w.poiLon) : null,
    gimbalAngle: w.gimbalAngle != null ? clampNumber(w.gimbalAngle, -90) : -90,
    azimuth: w.azimuth != null ? clampNumber(w.azimuth, 0) : 0,
    actions: actions.map((a) => (typeof a === "object" && a ? { ...a } : a)),
    arduPilotCommand: w.arduPilotCommand != null ? Number(w.arduPilotCommand) : undefined,
  };
}

function parseJsonMission(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("Invalid JSON: " + e.message);
  }
  let list;
  if (Array.isArray(data)) {
    list = data;
  } else if (data && Array.isArray(data.waypoints)) {
    list = data.waypoints;
  } else {
    throw new Error("JSON must be an array of waypoints or { waypoints: [...] }");
  }
  return list.map((w) => normalizeWaypoint(w));
}

function extractKmlText(tag, block) {
  const re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i");
  const m = re.exec(block);
  return m ? m[1].trim() : "";
}

function parseKmlExtendedData(block) {
  const out = {};
  const dataRe = /<Data\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/Data>/gi;
  let m;
  while ((m = dataRe.exec(block)) !== null) {
    const name = m[1].trim();
    const inner = m[2];
    const v = extractKmlText("value", inner) || inner.replace(/<[^>]+>/g, "").trim();
    out[name] = v;
  }
  const simpleRe = /<SimpleData\s+name=["']([^"']+)["'][^>]*>([^<]*)<\/SimpleData>/gi;
  while ((m = simpleRe.exec(block)) !== null) {
    out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function parseKml(text) {
  const waypoints = [];
  const pmRe = /<Placemark[^>]*>([\s\S]*?)<\/Placemark>/gi;
  let m;
  while ((m = pmRe.exec(text)) !== null) {
    const block = m[1];
    if (/<LineString/i.test(block)) continue;
    const coordInner = extractKmlText("coordinates", block);
    if (!coordInner) continue;
    const parts = coordInner.trim().split(/[\s,]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    const alt = parts.length >= 3 ? Number(parts[2]) : 0;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = extractKmlText("name", block) || "WP" + (waypoints.length + 1);
    const ext = parseKmlExtendedData(block);
    let actions = [];
    if (ext.actions) {
      try {
        actions = JSON.parse(ext.actions);
        if (!Array.isArray(actions)) actions = [];
      } catch (_) {
        actions = [];
      }
    }
    const speedMs = ext.speed_ms != null && ext.speed_ms !== "" ? Number(ext.speed_ms) : 5;
    const heading = ext.heading != null && ext.heading !== "" ? Number(ext.heading) : 0;
    const hover = ext.hover_time_s != null && ext.hover_time_s !== "" ? Number(ext.hover_time_s) : 0;
    waypoints.push(
      normalizeWaypoint({
        lat,
        lon,
        altitudeM: Number.isFinite(alt) ? alt : 30,
        speedMs: Number.isFinite(speedMs) ? speedMs : 5,
        heading: Number.isFinite(heading) ? heading : 0,
        hoverTimeSeconds: Number.isFinite(hover) ? hover : 0,
        actions,
        turnType: ext.turn_type || "stop",
        altitudeMode: ext.altitude_mode || "amsl",
      })
    );
  }
  if (!waypoints.length) throw new Error("No waypoint Placemarks found in KML");
  return waypoints;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if ((c === "," && !inQ) || c === "\t") {
      if (!inQ) {
        out.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function normHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) throw new Error("CSV is empty");
  const headers = parseCsvLine(lines[0]).map(normHeader);
  const idx = (aliases) => {
    for (let a = 0; a < aliases.length; a++) {
      const j = headers.indexOf(aliases[a]);
      if (j >= 0) return j;
    }
    return -1;
  };
  const iNum = idx(["waypoint_number", "wp", "waypoint", "index", "seq"]);
  const iLat = idx(["lat", "latitude"]);
  const iLon = idx(["lon", "lng", "longitude"]);
  const iAlt = idx(["altitude_m", "altitude", "alt"]);
  const iSpd = idx(["speed_ms", "speed"]);
  const iHdg = idx(["heading", "hdg"]);
  const iHover = idx(["hover_time_s", "hover", "hover_time"]);
  const iAct = idx(["actions"]);
  if (iLat < 0 || iLon < 0) throw new Error("CSV must include lat and lon columns");
  const out = [];
  for (let r = 1; r < lines.length; r++) {
    const cols = parseCsvLine(lines[r]);
    if (cols.length < 2) continue;
    const lat = Number(cols[iLat]);
    const lon = Number(cols[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    let actions = [];
    if (iAct >= 0 && cols[iAct]) {
      try {
        actions = JSON.parse(cols[iAct]);
        if (!Array.isArray(actions)) actions = [];
      } catch (_) {
        actions = [];
      }
    }
    out.push(
      normalizeWaypoint({
        lat,
        lon,
        altitudeM: iAlt >= 0 ? Number(cols[iAlt]) : 30,
        speedMs: iSpd >= 0 ? Number(cols[iSpd]) : 5,
        heading: iHdg >= 0 ? Number(cols[iHdg]) : 0,
        hoverTimeSeconds: iHover >= 0 ? Number(cols[iHover]) : 0,
        actions,
      })
    );
  }
  if (!out.length) throw new Error("No valid data rows in CSV");
  return out;
}

function parseArduPilotWaypoints(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length);
  if (!lines.length || !/^QGC\s+WPL/i.test(lines[0])) {
    throw new Error("Not a QGC WPL waypoint file (expected header QGC WPL …)");
  }
  const out = [];
  let lastLat = 0;
  let lastLon = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.includes("\t") ? line.split("\t") : line.split(/\s+/).filter(Boolean);
    if (parts.length < 12) continue;
    const cmd = Number(parts[3]);
    let lat = Number(parts[8]);
    let lon = Number(parts[9]);
    const alt = Number(parts[10]);
    if (cmd === MAV_CMD_NAV_RETURN_TO_LAUNCH) {
      if (!Number.isFinite(lat) || lat === 0) lat = lastLat;
      if (!Number.isFinite(lon) || lon === 0) lon = lastLon;
      out.push(
        normalizeWaypoint({
          lat,
          lon,
          altitudeM: Number.isFinite(alt) ? alt : 0,
          speedMs: 5,
          actions: [{ type: "rtl", params: {} }],
          arduPilotCommand: cmd,
        })
      );
      continue;
    }
    if (cmd === MAV_CMD_NAV_TAKEOFF || cmd === MAV_CMD_NAV_WAYPOINT) {
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        lastLat = lat;
        lastLon = lon;
      }
      out.push(
        normalizeWaypoint({
          lat,
          lon,
          altitudeM: Number.isFinite(alt) ? alt : 30,
          speedMs: 5,
          heading: 0,
          hoverTimeSeconds: 0,
          actions: cmd === MAV_CMD_NAV_TAKEOFF ? [{ type: "takeoff", params: {} }] : [],
          arduPilotCommand: cmd,
        })
      );
    }
  }
  if (!out.length) throw new Error("No NAV_WAYPOINT, NAV_TAKEOFF, or RTL commands found");
  return out;
}

/**
 * @param {string} text
 * @param {string} filename
 * @returns {MissionWaypoint[]}
 */
function parseMissionContent(text, filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  const t = (text || "").trim();
  if (ext === "waypoints" || /^QGC\s+WPL/im.test(t)) {
    return parseArduPilotWaypoints(text);
  }
  if (ext === "kml" || /<kml[\s>]/i.test(t)) {
    return parseKml(text);
  }
  if (ext === "csv") {
    return parseCsv(text);
  }
  if (ext === "json" || t.startsWith("{") || t.startsWith("[")) {
    return parseJsonMission(text);
  }
  throw new Error("Could not detect mission format (use .json, .kml, .csv, or .waypoints)");
}

module.exports = {
  parseMissionContent,
  parseJsonMission,
  parseKml,
  parseCsv,
  parseArduPilotWaypoints,
  normalizeWaypoint,
  MAV_CMD_NAV_WAYPOINT,
  MAV_CMD_NAV_RETURN_TO_LAUNCH,
  MAV_CMD_NAV_TAKEOFF,
};
