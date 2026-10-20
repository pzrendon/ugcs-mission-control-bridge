"use strict";

const http = require("node:http");
const { WebSocketServer } = require("ws");
const db = require("./database");
const { getDroneProfile } = require("./profiles-store");

// Vehicle state machine: disarmed | landed → arming → armed → taking_off → flying → landing | (rtl) → landed → disarmed
const VALID_STATES = ["disarmed", "arming", "armed", "taking_off", "flying", "landing", "landed", "returning"];

/** Default home / spawn for simulated vehicles — neutral demonstration coordinates. */
const ASC_HOME = { lat: 34.000000, lon: -118.000000 };

const SEED_FAKE_VEHICLES = [
  { id: 1, name: "Phantom-01", type: "multirotor", status: "landed", batteryLevel: 98, serialNumber: "MOCK-P1-001" },
  { id: 2, name: "Phantom-02", type: "multirotor", status: "landed", batteryLevel: 87, serialNumber: "MOCK-P2-002" },
  { id: 3, name: "Mavic-Survey", type: "multirotor", status: "landed", batteryLevel: 72, serialNumber: "MOCK-M3-003" },
];

/** Mutable list: seed vehicles + persisted from SQLite (rebuilt in startMock). */
let FAKE_VEHICLES = [];

const FAKE_MISSIONS = [
  { id: 101, name: "Long Beach Corridor A", waypointCount: 24, lastModified: "2025-03-10T14:30:00Z" },
  { id: 102, name: "Utility Survey Grid B", waypointCount: 48, lastModified: "2025-03-11T09:15:00Z" },
  { id: 103, name: "Pipeline Inspection", waypointCount: 16, lastModified: "2025-03-12T16:45:00Z" },
];

/** vehicleId -> active mission/route name after upload */
const vehicleActiveMissions = {};
/** vehicleId -> uploaded waypoints [{ lat, lon }, ...] for flight after takeoff */
const vehicleUploadedWaypoints = {};
/** vehicleId -> { droneProfileId, payloadProfileId } (string ids for UI / planning) */
const vehicleProfileAssignments = {};
// Full profile catalogs and CRUD are in profiles-store.js; HTTP routes are on the app router at /ugcs/drone-profiles and /ugcs/payload-profiles.

/** Flight log: record telemetry every 2s when flying; persist to SQLite when landed */
const FLIGHT_LOG_INTERVAL_MS = 2000;
const currentFlightLogs = {};

function flightLogSnapshot(vehicleId, missionName, state, waypointLabel) {
  const r = state.rtkTelemetry || {};
  return {
    vehicleId,
    missionName: missionName || "—",
    timestamp: new Date().toISOString(),
    lat: state.lat,
    lon: state.lon,
    altitudeM: state.altitudeM != null ? Math.round(state.altitudeM * 10) / 10 : 0,
    headingDeg: state.headingDeg != null ? Math.round(state.headingDeg * 10) / 10 : 0,
    speedMs: state.speedMs != null ? Math.round(state.speedMs * 10) / 10 : 0,
    batteryPct: state.batteryPct != null ? Math.round(state.batteryPct * 10) / 10 : 0,
    signalStrength: state.signalStrength != null ? Math.round(state.signalStrength) : null,
    gpsFixType: r.gpsFixType != null ? r.gpsFixType : null,
    gpsSatellites: r.gpsSatellites != null ? r.gpsSatellites : null,
    hdop: r.hdop != null ? r.hdop : null,
    vdop: r.vdop != null ? r.vdop : null,
    rtkAge: r.rtkAge != null ? r.rtkAge : null,
    rtkRatio: r.rtkRatio != null ? r.rtkRatio : null,
    latitude_error_m: r.latitude_error_m != null ? r.latitude_error_m : null,
    altitude_error_m: r.altitude_error_m != null ? r.altitude_error_m : null,
    currentWaypoint: waypointLabel != null ? waypointLabel : "—",
    status: state.status != null ? state.status : "unknown",
  };
}

function distanceMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R * c;
}

function rtkQualityFromSnapshots(snapshots) {
  if (!snapshots || !snapshots.length) {
    return { rtkSummary: "—", rtkFixedPct: 0, rtkFloatPct: 0 };
  }
  let fixed = 0;
  let fl = 0;
  for (let i = 0; i < snapshots.length; i++) {
    const f = snapshots[i].gpsFixType;
    if (f === "RTK Fixed") fixed++;
    else if (f === "RTK Float") fl++;
  }
  const n = snapshots.length;
  const fp = Math.round((100 * fixed) / n);
  const ftp = Math.round((100 * fl) / n);
  return {
    rtkSummary: fp + "% RTK Fixed, " + ftp + "% Float",
    rtkFixedPct: fp,
    rtkFloatPct: ftp,
  };
}

function finalizeFlightLog(vehicleId) {
  const cur = currentFlightLogs[vehicleId];
  if (!cur || !cur.snapshots.length) return;
  const first = cur.snapshots[0];
  const last = cur.snapshots[cur.snapshots.length - 1];
  const startTime = new Date(first.timestamp).getTime();
  const endTime = new Date(last.timestamp).getTime();
  let distanceM = 0;
  let maxAlt = 0;
  let speedSum = 0;
  let minBat = first.batteryPct != null ? first.batteryPct : 100;
  for (let i = 0; i < cur.snapshots.length; i++) {
    const s = cur.snapshots[i];
    if (s.altitudeM != null && s.altitudeM > maxAlt) maxAlt = s.altitudeM;
    if (s.speedMs != null) speedSum += s.speedMs;
    if (s.batteryPct != null && s.batteryPct < minBat) minBat = s.batteryPct;
  }
  for (let i = 1; i < cur.snapshots.length; i++) {
    distanceM += distanceMeters(cur.snapshots[i - 1], cur.snapshots[i]);
  }
  const rq = rtkQualityFromSnapshots(cur.snapshots);
  const n = cur.snapshots.length;
  const durationSec = Math.round((endTime - startTime) / 1000);
  const startBat = cur.startBatteryPct != null ? cur.startBatteryPct : first.batteryPct;
  const endBat = last.batteryPct != null ? last.batteryPct : startBat;
  const usedBat = startBat != null && endBat != null ? Math.max(0, Math.round((startBat - endBat) * 10) / 10) : 0;
  const completionReason = cur.completionReason || "land_command";
  const v = FAKE_VEHICLES.find((x) => x.id === vehicleId);
  const logId = vehicleId + "_" + startTime;
  db.flightLogs.save({
    id: logId,
    vehicleId,
    vehicleName: v ? v.name : "Vehicle " + vehicleId,
    missionName: cur.missionName,
    startTime,
    endTime,
    durationSec,
    durationSeconds: durationSec,
    distanceM: Math.round(distanceM),
    totalDistanceM: Math.round(distanceM),
    maxAltitudeM: Math.round(maxAlt * 10) / 10,
    avgSpeedMs: n > 0 ? Math.round((speedSum / n) * 10) / 10 : 0,
    minBatteryPct: minBat != null ? Math.round(minBat * 10) / 10 : null,
    startBatteryPct: startBat != null ? Math.round(startBat * 10) / 10 : null,
    endBatteryPct: endBat != null ? Math.round(endBat * 10) / 10 : null,
    batteryUsedPct: usedBat,
    snapshots: cur.snapshots,
    rtkSummary: rq.rtkSummary,
    rtkFixedPct: rq.rtkFixedPct,
    rtkFloatPct: rq.rtkFloatPct,
    waypointsCompleted: cur.waypointsCompleted != null ? cur.waypointsCompleted : 0,
    totalWaypoints: cur.totalWaypoints != null ? cur.totalWaypoints : 0,
    completionReason,
    homeLat: cur.homeLat != null ? cur.homeLat : null,
    homeLon: cur.homeLon != null ? cur.homeLon : null,
  });
  delete currentFlightLogs[vehicleId];
}

/**
 * Telemetry + flight log: waypoint label, progress counts, mission leg vs RTL leg.
 */
function computeWaypointTelemetry(state, track, len) {
  if (state.status === "returning") {
    return {
      label: "RTL",
      currentWaypoint: "RTL",
      completed: len,
      total: len,
      progress01: len > 0 ? 1 : 0,
    };
  }
  if (state.status === "landing") {
    return {
      label: "Landing",
      currentWaypoint: "Landing",
      completed: len,
      total: len,
      progress01: len > 0 ? 1 : 0,
    };
  }
  if (len <= 0 || (state.status !== "flying" && state.status !== "taking_off")) {
    return {
      label: "—",
      currentWaypoint: "—",
      completed: 0,
      total: 0,
      progress01: 0,
    };
  }
  const lastIdx = len - 1;
  if (lastIdx === 0) {
    return {
      label: "1/1",
      currentWaypoint: "1/1",
      completed: 0,
      total: 1,
      progress01: 0,
    };
  }
  let target1 = state.trackIndex + 2;
  if (state.wpPhase === "hover_wait" || state.wpPhase === "turn_to_exit") {
    target1 = Math.min(len, state.trackIndex + 2);
  }
  if (target1 > len) target1 = len;
  if (target1 < 1) target1 = 1;
  const completed = Math.max(0, Math.min(len, target1 - 1));
  const progress01 = len > 0 ? completed / len : 0;
  return {
    label: target1 + "/" + len,
    currentWaypoint: target1 + "/" + len,
    completed,
    total: len,
    progress01,
  };
}

function setFlightLogCompletionReason(vehicleId, reason) {
  const log = currentFlightLogs[vehicleId];
  if (!log || log.completionReason) return;
  log.completionReason = reason;
}

// Grid survey waypoints – utility corridor style (lawnmower). Base lat/lon so each vehicle gets its own corridor.
// Corridors spaced at least 0.01° apart so they don't overlap on the map.
const CORRIDOR_SPACING = 0.01;
function buildSurveyTrack(baseLat, baseLon) {
  const legLength = 0.002;
  const spacing = 0.00025;
  const legs = 8;
  const points = [];
  for (let i = 0; i < legs; i++) {
    const lat = baseLat + i * spacing;
    const lonStart = baseLon;
    const lonEnd = baseLon + legLength;
    if (i % 2 === 0) {
      points.push({ lat, lon: lonStart });
      points.push({ lat, lon: lonEnd });
    } else {
      points.push({ lat, lon: lonEnd });
      points.push({ lat, lon: lonStart });
    }
  }
  return points;
}

// One track per vehicle, spaced 0.01° apart (e.g. by longitude). Rebuilt in startMock with FAKE_VEHICLES.
const BASE_LAT = 33.8;
const BASE_LON = -118.1;
let VEHICLE_TRACKS = [];
let nextVehicleId = 10;

FAKE_VEHICLES = SEED_FAKE_VEHICLES.map((v) => ({ ...v }));
VEHICLE_TRACKS = FAKE_VEHICLES.map((_, i) =>
  buildSurveyTrack(BASE_LAT, BASE_LON + i * CORRIDOR_SPACING)
);

function bearingDeg(from, to) {
  const dLon = ((to.lon - from.lon) * Math.PI) / 180;
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const x = Math.sin(dLon) * Math.cos(lat2);
  const y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const deg = (Math.atan2(x, y) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Simulation tick (seconds); must match WS telemetry interval */
const TICK_S = 0.5;
const CRUISE_MS = 5;
const ACCEL_TIME_S = 4;
/** Horizontal acceleration / deceleration (m/s²) — higher so fast missions reach cruise in reasonable time */
const ACCEL_MS2 = Math.min(2, CRUISE_MS / ACCEL_TIME_S);
const DECEL_MS2 = ACCEL_MS2;
const MAX_CLIMB_MS = 2;
const MAX_DESCENT_MS = 1.5;
/** Vertical velocity smoothing (m/s²) toward desired climb/descent rate */
const VERT_ACCEL_MS2 = 1;
const TAKEOFF_CLIMB_MS = MAX_CLIMB_MS;
const LAND_DESCENT_MS = MAX_DESCENT_MS;
/** Max heading change rate (deg/s) — smooth turns vs instant snap */
const HEADING_MAX_DEG_S = 45;
/** RTL: switch to landing when this close in degree space (~5 m at mid-lat; straight-line RTL) */
const RTL_HOME_DEG_EPS = 0.00005;
/** Mission complete: distance to final waypoint to start auto RTL (m) */
const MISSION_END_RADIUS_M = 5;
const FLY_THROUGH_ARRIVAL_M = 3;
const STOP_ARRIVAL_M = 1.2;
const HOVER_TURN_DEFAULT_S = 1;
/** Fly-through: blend from 30% cruise to full cruise between this distance and waypoint */
const TURN_SLOW_OUTER_M = 28;
const TURN_SLOW_INNER_M = 4;
const BATTERY_DRAIN_SCALE = 0.5;

function getMaxSpeedMsForVehicle(vehicleId) {
  const a = vehicleProfileAssignments[vehicleId];
  if (!a || !a.droneProfileId) return null;
  const p = getDroneProfile(a.droneProfileId);
  const m = p && p.maxSpeedMs != null ? Number(p.maxSpeedMs) : NaN;
  return Number.isFinite(m) && m > 0 ? m : null;
}

/** Preserve full client waypoint payload; normalize numbers only (no speed clamp). */
function normalizeStoredWaypoint(w) {
  if (!w || typeof w !== "object") return null;
  const o = { ...w };
  o.lat = Number(o.lat);
  o.lon = Number(o.lon);
  if (Number.isNaN(o.lat) || Number.isNaN(o.lon)) return null;
  if (o.altM != null && !Number.isNaN(Number(o.altM))) o.altM = Number(o.altM);
  if (o.altitudeM != null && !Number.isNaN(Number(o.altitudeM))) o.altitudeM = Number(o.altitudeM);
  if (o.speedMs != null && !Number.isNaN(Number(o.speedMs))) o.speedMs = Number(o.speedMs);
  else if (o.speed != null && !Number.isNaN(Number(o.speed))) o.speedMs = Number(o.speed);
  if (o.hoverTimeS != null && !Number.isNaN(Number(o.hoverTimeS))) o.hoverTimeS = Math.max(0, Number(o.hoverTimeS));
  return o;
}

/**
 * Mission leg speed from waypoint data. Optional maxSpeedMs from drone profile is the only cap.
 */
function waypointCruiseMs(wp, maxSpeedMs) {
  let raw = wp && (wp.speedMs != null ? Number(wp.speedMs) : wp.speed != null ? Number(wp.speed) : NaN);
  if (!Number.isFinite(raw) || raw <= 0) raw = 5;
  if (Number.isFinite(maxSpeedMs) && maxSpeedMs > 0) return Math.min(raw, maxSpeedMs);
  return raw;
}

function rtlReturnSpeedMs(state, track, len, maxSpeedMs) {
  if (!track || len <= 0) return waypointCruiseMs(null, maxSpeedMs);
  const lastIdx = len - 1;
  if (lastIdx === 0) return waypointCruiseMs(track[0], maxSpeedMs);
  if (state.trackIndex >= lastIdx) return waypointCruiseMs(track[lastIdx > 0 ? lastIdx - 1 : 0], maxSpeedMs);
  return waypointCruiseMs(track[state.trackIndex], maxSpeedMs);
}

function shouldTriggerMissionCompleteAutoRtl(state, track, len) {
  if (state.status !== "flying" || !state.hasBeenArmed) return false;
  const lastIdx = len - 1;
  if (lastIdx < 0) return false;
  if (lastIdx === 0) {
    const d = distanceMeters({ lat: state.lat, lon: state.lon }, track[0]);
    return d <= MISSION_END_RADIUS_M && (state.speedMs ?? 0) < 1.2;
  }
  if (state.trackIndex >= lastIdx) {
    const lp = track[lastIdx];
    const d = distanceMeters({ lat: state.lat, lon: state.lon }, lp);
    return d <= MISSION_END_RADIUS_M && (state.speedMs ?? 0) < 2.5;
  }
  return false;
}

function metersPerDegLat() {
  return 111320;
}

function metersPerDegLon(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

function moveByHeading(lat, lon, headingDeg, distanceM) {
  const rad = (headingDeg * Math.PI) / 180;
  const northM = distanceM * Math.cos(rad);
  const eastM = distanceM * Math.sin(rad);
  const dLat = northM / metersPerDegLat();
  const dLon = eastM / metersPerDegLon(lat);
  return { lat: lat + dLat, lon: lon + dLon };
}

function shortestHeadingDeltaDeg(fromDeg, toDeg) {
  return ((((toDeg - fromDeg) % 360) + 540) % 360) - 180;
}

function stepHeadingToward(currentDeg, targetDeg, maxStepDeg) {
  const d = shortestHeadingDeltaDeg(currentDeg, targetDeg);
  if (Math.abs(d) <= maxStepDeg) return (targetDeg + 360) % 360;
  return (currentDeg + Math.sign(d) * maxStepDeg + 360) % 360;
}

function clampSpeedToward(current, target, maxAccel, maxDecel, dt) {
  if (target > current) {
    return Math.min(target, current + maxAccel * dt);
  }
  return Math.max(target, current - maxDecel * dt);
}

/**
 * Smooth altitude toward target with separate climb/descent limits and vertical acceleration.
 * @param {object} state vehicle state (mutates altitudeM, altRateMs)
 */
function stepAltitudeToward(state, targetAlt, dt) {
  const cur = state.altitudeM ?? 0;
  let vz = state.altRateMs != null ? state.altRateMs : 0;
  const err = targetAlt - cur;
  const desiredVz =
    err > 0.001
      ? Math.min(MAX_CLIMB_MS, Math.abs(err) / dt)
      : err < -0.001
        ? -Math.min(MAX_DESCENT_MS, Math.abs(err) / dt)
        : 0;
  vz = clampSpeedToward(vz, desiredVz, VERT_ACCEL_MS2, VERT_ACCEL_MS2, dt);
  let next = cur + vz * dt;
  if ((err > 0 && next > targetAlt) || (err < 0 && next < targetAlt)) {
    next = targetAlt;
    vz = 0;
  }
  state.altitudeM = Math.max(0, next);
  state.altRateMs = vz;
}

function signalStrengthFromDistanceM(distM) {
  let base;
  if (distM <= 100) {
    base = 95 + (distM / 100) * 4;
  } else if (distM <= 500) {
    base = 80 + ((500 - distM) / 400) * 15;
  } else if (distM <= 1000) {
    base = 60 + ((1000 - distM) / 500) * 20;
  } else {
    const over = distM - 1000;
    base = 60 - Math.min(55, Math.pow(over / 250, 1.35) * 18);
  }
  const noise = (Math.random() - 0.5) * 4;
  return Math.max(0, Math.min(99, base + noise));
}

function batteryDrainPercentPerTick(state, speedMs, vzMs) {
  const frac10 = TICK_S / 10;
  if (state.status === "arming") {
    return 0.15 * frac10 * BATTERY_DRAIN_SCALE;
  }
  let drain = 0;
  const absVz = Math.abs(vzMs);
  const slow = speedMs < 0.6;
  const hovering = slow && absVz < 0.35 && state.altitudeM > 1;

  if (state.status === "taking_off") {
    drain += 0.6 * frac10 * 1.45;
  } else if (state.status === "flying" && vzMs > 0.8) {
    drain += 0.6 * frac10 * 1.25;
  } else if (vzMs > 0.5) {
    drain += 0.6 * frac10;
  } else if (hovering && state.status === "flying") {
    drain += 0.4 * frac10;
  } else if (vzMs < -0.4) {
    drain += 0.35 * frac10;
  } else {
    drain += 0.3 * frac10;
  }

  const drainRefSpeedMs = 8;
  if (speedMs > drainRefSpeedMs) {
    drain += (speedMs - drainRefSpeedMs) * 0.004 * frac10 * 10;
  }

  return drain * BATTERY_DRAIN_SCALE;
}

function motorRpmForState(state, speedMs, vzMs) {
  const s = state.status;
  if (s === "disarmed" || s === "landed") return 0;
  if (s === "arming") {
    const p = state.armTicksTotal > 0 ? 1 - state.armTicksRemaining / state.armTicksTotal : 0;
    return Math.round(800 + p * 2200);
  }
  if (s === "armed") return 2800;
  if (s === "taking_off") {
    return Math.round(4200 + Math.min(1, Math.abs(vzMs) / TAKEOFF_CLIMB_MS) * 2800);
  }
  if (s === "landing") {
    return Math.round(2600 + speedMs * 120 + Math.abs(vzMs) * 200);
  }
  if (s === "returning") {
    return Math.round(3400 + speedMs * 220 + Math.max(0, vzMs) * 250);
  }
  if (s === "flying") {
    return Math.round(3200 + speedMs * 240 + Math.max(0, vzMs) * 350);
  }
  return 0;
}

function roundGps(n, dec) {
  const p = 10 ** dec;
  return Math.round(n * p) / p;
}

/** Horizontal position noise in meters → deg offsets (north/east). */
function metersToLatLonNoise(latDeg, errM) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * errM;
  const northM = r * Math.cos(a);
  const eastM = r * Math.sin(a);
  return {
    dLat: northM / metersPerDegLat(),
    dLon: eastM / metersPerDegLon(latDeg),
  };
}

/**
 * Mock RTK acquisition after arm + telemetry GPS fields.
 * @returns {object} rtk fields + horizNoiseM for reported position
 */
function computeMockRtkTelemetry(state, nowMs, speedMs, altitudeM) {
  const r = (min, max) => min + Math.random() * (max - min);
  let gpsFixType = "3D Fix";
  let gpsSatellites = 9;
  let hdop = roundGps(r(1.5, 1.9), 2);
  let vdop = roundGps(r(1.6, 2.0), 2);
  let rtkAge = null;
  let rtkRatio = 1;
  let latitude_error_m = 3;
  let altitude_error_m = 4;
  let horizNoiseM = 3;

  const preArm = !state.hasBeenArmed || state.rtkArmWallMs == null;
  if (preArm) {
    gpsSatellites = Math.floor(r(8, 11));
    state.rtkTelemetry = {
      gpsFixType,
      gpsSatellites,
      hdop,
      vdop,
      rtkAge,
      rtkRatio: roundGps(1, 1),
      latitude_error_m,
      altitude_error_m,
    };
    return { ...state.rtkTelemetry, horizNoiseM };
  }

  if (!state.rtkNextDropoutAt) state.rtkNextDropoutAt = nowMs + 8000 + Math.random() * 12000;
  if (nowMs >= state.rtkNextDropoutAt && (state.rtkFloatDropoutUntil || 0) < nowMs) {
    state.rtkFloatDropoutUntil = nowMs + (5000 + Math.random() * 5000);
    state.rtkNextDropoutAt = nowMs + 12000 + Math.random() * 18000;
  }
  if (speedMs > 6 && Math.random() < 0.012) {
    state.rtkMultipathUntil = nowMs + (3000 + Math.random() * 5000);
  }

  const tSec = (nowMs - state.rtkArmWallMs) / 1000;
  const inDropout = nowMs < (state.rtkFloatDropoutUntil || 0) || nowMs < (state.rtkMultipathUntil || 0);

  if (tSec < 10) {
    gpsFixType = "3D Fix";
    gpsSatellites = Math.floor(r(8, 12));
    hdop = roundGps(r(1.5, 2.0), 2);
    vdop = roundGps(r(1.6, 2.2), 2);
    latitude_error_m = 3;
    altitude_error_m = 4;
    horizNoiseM = 3;
  } else if (tSec < 30) {
    gpsFixType = "GPS+DGPS";
    gpsSatellites = Math.floor(r(12, 17));
    hdop = roundGps(r(0.8, 1.2), 2);
    vdop = roundGps(r(0.9, 1.3), 2);
    latitude_error_m = 0.5;
    altitude_error_m = 1;
    horizNoiseM = 0.5;
  } else if (tSec < 60) {
    gpsFixType = "RTK Float";
    gpsSatellites = Math.floor(r(16, 21));
    hdop = roundGps(r(0.6, 0.9), 2);
    vdop = roundGps(r(0.65, 0.95), 2);
    const p = Math.min(1, (tSec - 30) / 30);
    rtkRatio = roundGps(1 + p * 2.5, 2);
    rtkAge = roundGps(r(0.2, 1.0), 2);
    latitude_error_m = 0.3;
    altitude_error_m = 0.45;
    horizNoiseM = 0.3;
  } else {
    if (inDropout) {
      gpsFixType = "RTK Float";
      gpsSatellites = Math.floor(r(16, 20));
      hdop = roundGps(r(0.65, 0.95), 2);
      vdop = roundGps(r(0.7, 1.0), 2);
      rtkRatio = roundGps(r(1.5, 3.2), 2);
      rtkAge = roundGps(r(0.5, 2.0), 2);
      latitude_error_m = 0.35;
      altitude_error_m = 0.5;
      horizNoiseM = 0.3;
    } else {
      gpsFixType = "RTK Fixed";
      gpsSatellites = Math.floor(r(18, 23));
      hdop = roundGps(r(0.5, 0.7), 2);
      vdop = roundGps(r(0.55, 0.75), 2);
      rtkRatio = roundGps(r(35, 120), 1);
      rtkAge = roundGps(r(0.1, 0.5), 2);
      latitude_error_m = 0.02;
      altitude_error_m = 0.03;
      horizNoiseM = 0.02;
    }
  }

  state.rtkTelemetry = {
    gpsFixType,
    gpsSatellites,
    hdop,
    vdop,
    rtkAge,
    rtkRatio: roundGps(rtkRatio, rtkRatio >= 100 ? 0 : 1),
    latitude_error_m: roundGps(latitude_error_m, 3),
    altitude_error_m: roundGps(altitude_error_m, 3),
  };
  return { ...state.rtkTelemetry, horizNoiseM };
}

function waypointAlt(wp, cruiseM) {
  if (wp && wp.altM != null && !Number.isNaN(Number(wp.altM))) {
    return Math.max(0, Number(wp.altM));
  }
  if (wp && wp.altitudeM != null && !Number.isNaN(Number(wp.altitudeM))) {
    return Math.max(0, Number(wp.altitudeM));
  }
  return cruiseM;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function route(req, res, ctx) {
  const method = req.method;
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const pathname = url.pathname;
  const pathParts = pathname.replace(/^\/+/, "").split("/");

  // GET /api/v1/vehicles – return vehicles with current status and active mission name
  if (method === "GET" && pathParts[0] === "api" && pathParts[1] === "v1" && pathParts[2] === "vehicles" && pathParts.length === 3) {
    const vehicles = FAKE_VEHICLES.map((v) => {
      const s = (ctx && ctx.vehicleStates && ctx.vehicleStates[v.id]) || null;
      const prof = vehicleProfileAssignments[v.id] || {};
      return {
        ...v,
        status: s ? s.status : v.status,
        activeMissionName: vehicleActiveMissions[v.id] || null,
        droneProfileId: prof.droneProfileId != null ? prof.droneProfileId : null,
        payloadProfileId: prof.payloadProfileId != null ? prof.payloadProfileId : null,
      };
    });
    sendJson(res, 200, vehicles);
    return;
  }

  const vehicleProfilesMatch = pathname.match(/^\/api\/v1\/vehicles\/([^/]+)\/profiles$/);
  if (method === "POST" && vehicleProfilesMatch) {
    parseBody(req).then((body) => {
      const vid = Number(vehicleProfilesMatch[1]);
      if (Number.isNaN(vid)) {
        sendJson(res, 400, { error: "Invalid vehicle id" });
        return;
      }
      const prev = vehicleProfileAssignments[vid] || {};
      vehicleProfileAssignments[vid] = {
        droneProfileId:
          body.droneProfileId !== undefined
            ? body.droneProfileId
              ? String(body.droneProfileId)
              : null
            : prev.droneProfileId ?? null,
        payloadProfileId:
          body.payloadProfileId !== undefined
            ? body.payloadProfileId
              ? String(body.payloadProfileId)
              : null
            : prev.payloadProfileId ?? null,
      };
      sendJson(res, 200, { success: true });
    }).catch(() => sendJson(res, 400, { error: "Invalid JSON body" }));
    return;
  }

  // POST /api/v1/vehicles/:id/position – set vehicle lat/lon and/or home (body: lat, lon, isHome?)
  const vehiclePositionMatch = pathname.match(/^\/api\/v1\/vehicles\/([^/]+)\/position$/);
  if (method === "POST" && vehiclePositionMatch) {
    const vehicleIdStr = vehiclePositionMatch[1];
    parseBody(req).then((body) => {
      const lat = body.lat != null ? Number(body.lat) : NaN;
      const lon = body.lon != null ? Number(body.lon) : NaN;
      const isHome = body.isHome === true;
      if (ctx && ctx.setVehiclePosition && !Number.isNaN(lat) && !Number.isNaN(lon)) {
        ctx.setVehiclePosition(vehicleIdStr, lat, lon, isHome);
      }
      sendJson(res, 200, { success: true });
    }).catch(() => sendJson(res, 400, { error: "Invalid JSON body" }));
    return;
  }

  // POST /api/v1/vehicles/create – name, type, serialNumber; add to FAKE_VEHICLES and state
  if (method === "POST" && pathname === "/api/v1/vehicles/create") {
    parseBody(req).then((body) => {
      const name = (body.name || "").trim() || "Unnamed";
      const type = (body.type || "multirotor").toLowerCase();
      const serialNumber = (body.serialNumber || "").trim() || "MOCK-" + nextVehicleId;
      const droneProfileId = body.droneProfileId != null && String(body.droneProfileId).trim() ? String(body.droneProfileId).trim() : null;
      const payloadProfileId = body.payloadProfileId != null && String(body.payloadProfileId).trim() ? String(body.payloadProfileId).trim() : null;
      const vehicle = {
        id: nextVehicleId++,
        name,
        type: ["multirotor", "fixed-wing", "vtol"].includes(type) ? type : "multirotor",
        status: "landed",
        batteryLevel: 100,
        serialNumber,
        droneProfileId,
        payloadProfileId,
      };
      vehicleProfileAssignments[vehicle.id] = { droneProfileId, payloadProfileId };
      db.vehicles.save(vehicle.id, vehicle);
      if (ctx && ctx.addVehicle) ctx.addVehicle(vehicle);
      sendJson(res, 200, { success: true, vehicle });
    }).catch(() => sendJson(res, 400, { error: "Invalid JSON body" }));
    return;
  }

  // GET /api/v1/missions – catalog + saved routes
  if (method === "GET" && pathParts[0] === "api" && pathParts[1] === "v1" && pathParts[2] === "missions" && pathParts.length === 3) {
    const saved = db.missions.getAll().map((m) => ({
      id: m.id,
      name: m.name,
      waypointCount: Array.isArray(m.waypoints) ? m.waypoints.length : 0,
      lastModified: new Date(m.updatedAt).toISOString(),
    }));
    const list = FAKE_MISSIONS.concat(saved);
    sendJson(res, 200, list);
    return;
  }

  // GET /api/v1/missions/:id – full mission (including waypoints for saved missions)
  const missionsByIdMatch = pathname.match(/^\/api\/v1\/missions\/([^/]+)$/);
  if (method === "GET" && missionsByIdMatch) {
    const missionIdRaw = missionsByIdMatch[1];
    const fake = FAKE_MISSIONS.find((m) => String(m.id) === String(missionIdRaw));
    if (fake) {
      const out = {
        id: fake.id,
        name: fake.name,
        waypointCount: fake.waypointCount || 0,
        lastModified: fake.lastModified,
      };
      sendJson(res, 200, out);
      return;
    }
    const saved = db.missions.get(missionIdRaw);
    if (!saved) {
      sendJson(res, 404, { error: "Mission not found" });
      return;
    }
    sendJson(res, 200, {
      id: saved.id,
      name: saved.name,
      waypointCount: Array.isArray(saved.waypoints) ? saved.waypoints.length : 0,
      lastModified: new Date(saved.updatedAt).toISOString(),
      waypoints: saved.waypoints,
    });
    return;
  }

  if (method === "DELETE" && missionsByIdMatch) {
    const missionIdRaw = missionsByIdMatch[1];
    if (FAKE_MISSIONS.some((m) => String(m.id) === String(missionIdRaw))) {
      sendJson(res, 403, { error: "Cannot delete catalog mission" });
      return;
    }
    if (!db.missions.get(missionIdRaw)) {
      sendJson(res, 404, { error: "Mission not found" });
      return;
    }
    db.missions.delete(missionIdRaw);
    sendJson(res, 200, { success: true });
    return;
  }

  // POST /api/v1/missions/save (name + waypoints) – store in memory
  if (method === "POST" && pathname === "/api/v1/missions/save") {
    parseBody(req).then((body) => {
      const name = (body.name || "").trim() || "Unnamed route";
      const raw = Array.isArray(body.waypoints) ? body.waypoints : [];
      const waypoints = raw.map(normalizeStoredWaypoint).filter(Boolean);
      const id = body.id && String(body.id).trim() ? String(body.id).trim() : "mission_" + Date.now();
      db.missions.save(id, name, waypoints);
      sendJson(res, 200, { success: true, id, name });
    }).catch(() => sendJson(res, 400, { error: "Invalid JSON body" }));
    return;
  }

  // POST /api/v1/missions/upload (planned waypoints JSON + vehicleId + routeName)
  if (method === "POST" && pathname === "/api/v1/missions/upload") {
    parseBody(req).then((body) => {
      const vehicleId = body.vehicleId != null ? Number(body.vehicleId) : null;
      const routeName = (body.routeName && String(body.routeName).trim()) || "Current plan";
      const rawWaypoints = Array.isArray(body.waypoints) ? body.waypoints : [];
      const waypoints = rawWaypoints.map(normalizeStoredWaypoint).filter(Boolean);
      if (vehicleId != null && !Number.isNaN(vehicleId)) {
        vehicleActiveMissions[vehicleId] = routeName;
        vehicleUploadedWaypoints[vehicleId] = waypoints.length ? waypoints : null;
      }
      setTimeout(() => {
        sendJson(res, 200, { success: true, vehicleId: body.vehicleId, waypointCount: waypoints.length });
      }, 800);
    }).catch(() => sendJson(res, 400, { error: "Invalid JSON body" }));
    return;
  }

  // POST /api/v1/missions/:id/upload (catalog or saved mission by id)
  const missionsUploadMatch = pathname.match(/^\/api\/v1\/missions\/([^/]+)\/upload$/);
  if (method === "POST" && missionsUploadMatch) {
    const missionIdRaw = missionsUploadMatch[1];
    parseBody(req).then((body) => {
      const vehicleId = body.vehicleId != null ? Number(body.vehicleId) : null;
      const fakeMission = FAKE_MISSIONS.find((m) => String(m.id) === String(missionIdRaw));
      const savedMission = fakeMission ? null : db.missions.get(missionIdRaw);
      const mission = fakeMission || savedMission;
      if (vehicleId != null && !Number.isNaN(vehicleId) && mission) {
        vehicleActiveMissions[vehicleId] = mission.name;
        if (mission.waypoints && Array.isArray(mission.waypoints) && mission.waypoints.length > 0) {
          const wps = mission.waypoints.map(normalizeStoredWaypoint).filter(Boolean);
          vehicleUploadedWaypoints[vehicleId] = wps.length ? wps : null;
        } else {
          vehicleUploadedWaypoints[vehicleId] = null;
        }
      }
      setTimeout(() => {
        sendJson(res, 200, { success: true, missionId: missionIdRaw });
      }, 800);
    }).catch(() => sendJson(res, 400, { error: "Invalid JSON body" }));
    return;
  }

  // GET /api/v1/flight-logs – list completed flights (no snapshots)
  if (method === "GET" && pathParts[0] === "api" && pathParts[1] === "v1" && pathParts[2] === "flight-logs" && pathParts.length === 3) {
    sendJson(res, 200, db.flightLogs.getAll());
    return;
  }

  // GET /api/v1/flight-logs/:vehicleId?startTime=ISO – single flight with snapshots
  if (method === "GET" && pathParts[0] === "api" && pathParts[1] === "v1" && pathParts[2] === "flight-logs" && pathParts.length === 4) {
    const vehicleIdStr = pathParts[3];
    const vehicleId = Number(vehicleIdStr);
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const startTime = url.searchParams.get("startTime") || "";
    const log = db.flightLogs.get(vehicleId, startTime);
    if (!log) {
      sendJson(res, 404, { error: "Flight log not found" });
      return;
    }
    sendJson(res, 200, log);
    return;
  }

  // POST /api/v1/vehicles/:id/command – state machine + camera/gimbal
  const vehiclesCommandMatch = pathname.match(/^\/api\/v1\/vehicles\/([^/]+)\/command$/);
  if (method === "POST" && vehiclesCommandMatch) {
    const vehicleId = vehiclesCommandMatch[1];
    parseBody(req).then((body) => {
      const command = (body.command || "").toLowerCase();
      const allowed = ["takeoff", "land", "rtl", "arm", "gimbal", "camera_trigger", "video_start", "video_stop", "photo_interval_start", "photo_interval_stop"];
      if (!allowed.includes(command)) {
        sendJson(res, 400, { error: "command must be one of: takeoff, land, rtl, arm, gimbal, camera_trigger, video_start, video_stop, photo_interval_start, photo_interval_stop" });
        return;
      }
      if (command === "gimbal") {
        if (ctx && ctx.setGimbal) {
          const pitch = body.pitch != null ? Number(body.pitch) : undefined;
          const yaw = body.yaw != null ? Number(body.yaw) : undefined;
          ctx.setGimbal(vehicleId, pitch, yaw);
        }
        sendJson(res, 200, { success: true, command, vehicleId });
        return;
      }
      if (command === "camera_trigger") {
        if (ctx && ctx.cameraTrigger) {
          const result = ctx.cameraTrigger(vehicleId);
          sendJson(res, 200, { success: true, command, vehicleId, photoIndex: result.photoIndex });
        } else {
          sendJson(res, 200, { success: true, command, vehicleId, photoIndex: 0 });
        }
        return;
      }
      if (command === "video_start" || command === "video_stop" || command === "photo_interval_start" || command === "photo_interval_stop") {
        if (ctx && ctx.applyCommand) {
          const result = ctx.applyCommand(vehicleId, command, body);
          if (result && result.error) {
            sendJson(res, 400, { error: result.error });
            return;
          }
        }
        sendJson(res, 200, { success: true, command, vehicleId });
        return;
      }
      if (ctx && ctx.applyCommand) {
        const result = ctx.applyCommand(vehicleId, command);
        if (result && result.error) {
          sendJson(res, 400, { error: result.error });
          return;
        }
      }
      setTimeout(() => {
        sendJson(res, 200, { success: true, command, vehicleId });
      }, 600);
    }).catch(() => sendJson(res, 400, { error: "Invalid JSON body" }));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function startMock(port = 3335) {
  const seedIds = new Set(SEED_FAKE_VEHICLES.map((v) => v.id));
  FAKE_VEHICLES = SEED_FAKE_VEHICLES.map((v) => ({ ...v }));
  VEHICLE_TRACKS = FAKE_VEHICLES.map((_, i) =>
    buildSurveyTrack(BASE_LAT, BASE_LON + i * CORRIDOR_SPACING)
  );
  db.vehicles.getAll().forEach((v) => {
    if (seedIds.has(v.id)) return;
    const i = FAKE_VEHICLES.length;
    FAKE_VEHICLES.push(v);
    VEHICLE_TRACKS.push(buildSurveyTrack(BASE_LAT, BASE_LON + i * CORRIDOR_SPACING));
  });
  const maxVid = FAKE_VEHICLES.map((x) => Number(x.id)).filter(Number.isFinite);
  nextVehicleId = (maxVid.length ? Math.max(...maxVid) : 9) + 1;
  if (nextVehicleId < 10) nextVehicleId = 10;

  const vehicleStates = {};
  FAKE_VEHICLES.forEach((v, i) => {
    const track = VEHICLE_TRACKS[i];
    const cruiseAlt = 30 + i * 5;
    const nextPt = track.length > 1 ? track[1] : track[0];
    const h0 = bearingDeg({ lat: ASC_HOME.lat, lon: ASC_HOME.lon }, nextPt);
    vehicleStates[v.id] = {
      status: "landed",
      altitudeM: 0,
      speedMs: 0,
      lat: ASC_HOME.lat,
      lon: ASC_HOME.lon,
      headingDeg: h0,
      trackIndex: 0,
      batteryPct: v.batteryLevel,
      signalStrength: 90,
      homeLat: ASC_HOME.lat,
      homeLon: ASC_HOME.lon,
      landedTicks: 0,
      hasBeenArmed: false,
      gimbalPitch: -90,
      gimbalYaw: 0,
      lastPhotoTimestamp: null,
      photoIndex: 0,
      isRecording: false,
      photoIntervalOn: false,
      photoIntervalSeconds: 2,
      armTicksRemaining: 0,
      armTicksTotal: 0,
      missionCruiseAltM: cruiseAlt,
      takeoffTargetAltM: cruiseAlt,
      wpPhase: "transit",
      hoverTicksRemaining: 0,
      rtlPhase: "straight",
      prevAltitudeM: 0,
      altRateMs: 0,
      motorRPM: 0,
      rtkArmWallMs: null,
      rtkFloatDropoutUntil: 0,
      rtkMultipathUntil: 0,
      rtkNextDropoutAt: 0,
      telemetryHoldLat: null,
      telemetryHoldLon: null,
      rtkTelemetry: {},
      clearUploadedMissionOnLanded: false,
      missionCompleteTelemetryOnce: false,
      rtlHorizSpeedMs: null,
    };
    FAKE_VEHICLES[i].status = "landed";
  });

  function addVehicle(vehicle) {
    FAKE_VEHICLES.push(vehicle);
    const i = VEHICLE_TRACKS.length;
    VEHICLE_TRACKS.push(buildSurveyTrack(BASE_LAT, BASE_LON + i * CORRIDOR_SPACING));
    const track = VEHICLE_TRACKS[i];
    vehicleStates[vehicle.id] = {
      status: "landed",
      altitudeM: 0,
      speedMs: 0,
      lat: ASC_HOME.lat,
      lon: ASC_HOME.lon,
      headingDeg: 0,
      trackIndex: 0,
      batteryPct: vehicle.batteryLevel || 100,
      signalStrength: 90,
      homeLat: ASC_HOME.lat,
      homeLon: ASC_HOME.lon,
      landedTicks: 0,
      hasBeenArmed: false,
      gimbalPitch: -90,
      gimbalYaw: 0,
      lastPhotoTimestamp: null,
      photoIndex: 0,
      isRecording: false,
      photoIntervalOn: false,
      photoIntervalSeconds: 2,
      armTicksRemaining: 0,
      armTicksTotal: 0,
      missionCruiseAltM: 30,
      takeoffTargetAltM: 30,
      wpPhase: "transit",
      hoverTicksRemaining: 0,
      rtlPhase: "straight",
      prevAltitudeM: 0,
      altRateMs: 0,
      motorRPM: 0,
      rtkArmWallMs: null,
      rtkFloatDropoutUntil: 0,
      rtkMultipathUntil: 0,
      rtkNextDropoutAt: 0,
      telemetryHoldLat: null,
      telemetryHoldLon: null,
      rtkTelemetry: {},
      clearUploadedMissionOnLanded: false,
      missionCompleteTelemetryOnce: false,
      rtlHorizSpeedMs: null,
    };
  }

  function setGimbal(vehicleIdStr, pitch, yaw) {
    const vid = Number(vehicleIdStr);
    const state = vehicleStates[vid];
    if (!state) return;
    if (pitch !== undefined && !Number.isNaN(pitch)) state.gimbalPitch = Math.max(-90, Math.min(0, pitch));
    if (yaw !== undefined && !Number.isNaN(yaw)) state.gimbalYaw = Math.max(-180, Math.min(180, yaw));
  }

  function cameraTrigger(vehicleIdStr) {
    const vid = Number(vehicleIdStr);
    const state = vehicleStates[vid];
    if (!state) return { photoIndex: 0 };
    state.lastPhotoTimestamp = Date.now();
    state.photoIndex = (state.photoIndex || 0) + 1;
    return { photoIndex: state.photoIndex };
  }

  /** Only uploaded mission waypoints — no default survey/demo track for flight simulation. */
  function getTrackForVehicle(vehicleId) {
    const uploaded = vehicleUploadedWaypoints[vehicleId];
    if (uploaded && uploaded.length > 0) return uploaded;
    return [];
  }

  function setVehiclePosition(vehicleIdStr, lat, lon, isHomeOnly) {
    const vid = Number(vehicleIdStr);
    const state = vehicleStates[vid];
    if (!state) return;
    if (isHomeOnly) {
      state.homeLat = lat;
      state.homeLon = lon;
    } else {
      state.lat = lat;
      state.lon = lon;
      state.homeLat = lat;
      state.homeLon = lon;
    }
  }

  function applyCommand(vehicleIdStr, command, body) {
    const vid = Number(vehicleIdStr);
    const idx = FAKE_VEHICLES.findIndex((v) => v.id === vid);
    if (idx < 0) return { error: "Vehicle not found" };
    const state = vehicleStates[vid];
    if (!state) return { error: "Vehicle not found" };
    const status = state.status;
    const track = getTrackForVehicle(vid);
    const hasMission = vehicleUploadedWaypoints[vid] && vehicleUploadedWaypoints[vid].length > 0;

    if (command === "arm") {
      if (status === "arming") {
        return { error: "Cannot arm: already arming" };
      }
      if (status !== "landed" && status !== "disarmed") {
        return { error: "Cannot arm: vehicle is " + status.replace(/_/g, " ") };
      }
      const armTicks = Math.max(1, Math.round(2 / TICK_S));
      state.hasBeenArmed = true;
      state.rtkArmWallMs = Date.now();
      state.rtkFloatDropoutUntil = 0;
      state.rtkMultipathUntil = 0;
      state.rtkNextDropoutAt = 0;
      state.telemetryHoldLat = null;
      state.telemetryHoldLon = null;
      state.status = "arming";
      state.armTicksRemaining = armTicks;
      state.armTicksTotal = armTicks;
      state.speedMs = 0;
      FAKE_VEHICLES[idx].status = "arming";
    } else if (command === "takeoff") {
      if (status !== "armed") {
        return { error: "Cannot takeoff: vehicle is " + status.replace(/_/g, " ") + " (must be armed)" };
      }
      if (!hasMission) {
        return { error: "Upload a mission before takeoff" };
      }
      state.trackIndex = 0;
      if (track.length > 0) {
        state.lat = track[0].lat;
        state.lon = track[0].lon;
        state.homeLat = track[0].lat;
        state.homeLon = track[0].lon;
      }
      const cruiseFromMission = track.map((w) => w.altM).find((a) => a != null && !Number.isNaN(a));
      state.missionCruiseAltM = cruiseFromMission != null ? Math.max(5, cruiseFromMission) : 30;
      state.takeoffTargetAltM = state.missionCruiseAltM;
      state.status = "taking_off";
      state.altitudeM = 0;
      state.prevAltitudeM = 0;
      state.altRateMs = 0;
      state.speedMs = 0;
      state.wpPhase = "transit";
      state.hoverTicksRemaining = 0;
      FAKE_VEHICLES[idx].status = "taking_off";
    } else if (command === "land") {
      if (status !== "flying" && status !== "taking_off") {
        return { error: "Cannot land: vehicle is " + status.replace(/_/g, " ") };
      }
      setFlightLogCompletionReason(vid, "land_command");
      state.status = "landing";
      FAKE_VEHICLES[idx].status = "landing";
    } else if (command === "rtl") {
      if (status !== "flying" && status !== "taking_off") {
        return { error: "Cannot RTL: vehicle is " + status.replace(/_/g, " ") };
      }
      setFlightLogCompletionReason(vid, "rtl_command");
      state.clearUploadedMissionOnLanded = false;
      state.missionCompleteTelemetryOnce = false;
      if (track.length > 0) {
        state.homeLat = track[0].lat;
        state.homeLon = track[0].lon;
      }
      state.status = "returning";
      state.rtlPhase = "straight";
      state.wpPhase = "transit";
      state.hoverTicksRemaining = 0;
      const rtlLen = track.length;
      const rtlCap = getMaxSpeedMsForVehicle(vid);
      state.rtlHorizSpeedMs = rtlReturnSpeedMs(state, track, rtlLen, rtlCap);
      FAKE_VEHICLES[idx].status = "returning";
    } else if (command === "video_start") {
      state.isRecording = true;
    } else if (command === "video_stop") {
      state.isRecording = false;
    } else if (command === "photo_interval_start") {
      state.photoIntervalOn = true;
      if (body && body.intervalSeconds != null && !Number.isNaN(Number(body.intervalSeconds))) state.photoIntervalSeconds = Math.max(0.5, Number(body.intervalSeconds));
    } else if (command === "photo_interval_stop") {
      state.photoIntervalOn = false;
    }
  }

  const server = http.createServer((req, res) => {
    if (req.url === "/" && req.headers["upgrade"] === "websocket") {
      return;
    }
    route(req, res, { vehicleStates, applyCommand, addVehicle, setVehiclePosition, setGimbal, cameraTrigger });
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    if (url.pathname === "/" || url.pathname === "") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws) => {
    const intervals = [];
    const sendTelemetry = () => {
      const t = Date.now();
      const maxTurnThisTick = HEADING_MAX_DEG_S * TICK_S;

      FAKE_VEHICLES.forEach((v, i) => {
        const state = vehicleStates[v.id];
        if (!state) return;
        const track = getTrackForVehicle(v.id);
        const len = track.length;
        const uploaded = len > 0;
        const maxCap = getMaxSpeedMsForVehicle(v.id);

        if (state.status === "arming") {
          state.armTicksRemaining = Math.max(0, (state.armTicksRemaining || 0) - 1);
          if (state.armTicksRemaining <= 0) {
            state.status = "armed";
            FAKE_VEHICLES[i].status = "armed";
          }
        }

        if (state.status === "landed") {
          state.landedTicks = (state.landedTicks || 0) + 1;
          if (state.landedTicks >= 2) {
            state.status = "disarmed";
            state.hasBeenArmed = false;
            state.rtkArmWallMs = null;
            state.rtkFloatDropoutUntil = 0;
            state.rtkMultipathUntil = 0;
            state.rtkNextDropoutAt = 0;
            state.telemetryHoldLat = null;
            state.telemetryHoldLon = null;
            state.missionCompleteTelemetryOnce = false;
            state.clearUploadedMissionOnLanded = false;
            state.rtlHorizSpeedMs = null;
            FAKE_VEHICLES[i].status = "disarmed";
          }
        }

        const altBefore = state.altitudeM ?? 0;

        if (state.status === "taking_off") {
          if (!uploaded || !state.hasBeenArmed) {
            state.status = "armed";
            state.altitudeM = 0;
            state.altRateMs = 0;
            state.speedMs = 0;
            FAKE_VEHICLES[i].status = "armed";
          } else {
            const targetAlt = state.takeoffTargetAltM ?? 30;
            stepAltitudeToward(state, targetAlt, TICK_S);
            state.speedMs = 0;
            if (len > 1) {
              const tg = track[1];
              const brg = bearingDeg({ lat: state.lat, lon: state.lon }, tg);
              state.headingDeg = stepHeadingToward(state.headingDeg ?? brg, brg, maxTurnThisTick);
            } else if (len === 1) {
              const brg = bearingDeg({ lat: state.lat, lon: state.lon }, track[0]);
              state.headingDeg = stepHeadingToward(state.headingDeg ?? brg, brg, maxTurnThisTick);
            }
            if (state.altitudeM >= targetAlt - 0.05) {
              state.altitudeM = targetAlt;
              state.altRateMs = 0;
              state.status = "flying";
              state.wpPhase = "transit";
              state.hoverTicksRemaining = 0;
              FAKE_VEHICLES[i].status = "flying";
            }
          }
        }

        if (state.status === "returning") {
          const hl = state.homeLat;
          const ho = state.homeLon;
          const dLat = hl - state.lat;
          const dLon = ho - state.lon;
          const distToHomeDeg = Math.sqrt(dLat * dLat + dLon * dLon);
          if (distToHomeDeg < RTL_HOME_DEG_EPS) {
            state.lat = hl;
            state.lon = ho;
            state.speedMs = 0;
            state.status = "landing";
            FAKE_VEHICLES[i].status = "landing";
          } else {
            const bearing = Math.atan2(dLon, dLat);
            const rtlMs = state.rtlHorizSpeedMs != null ? state.rtlHorizSpeedMs : CRUISE_MS;
            const degPerSec = rtlMs / 111320;
            const dist = degPerSec * TICK_S;
            const step = Math.min(dist, distToHomeDeg);
            state.lat += Math.cos(bearing) * step;
            state.lon += Math.sin(bearing) * step;
            state.headingDeg = ((bearing * 180) / Math.PI + 360) % 360;
            state.speedMs = rtlMs;
            const cruiseAlt = state.missionCruiseAltM ?? 30;
            stepAltitudeToward(state, cruiseAlt, TICK_S);
          }
        }

        if (state.status === "landing") {
          stepAltitudeToward(state, 0, TICK_S);
          state.speedMs = clampSpeedToward(state.speedMs ?? 0, 0, ACCEL_MS2, DECEL_MS2 * 1.4, TICK_S);
          if (state.altitudeM <= 0) {
            state.altitudeM = 0;
            state.altRateMs = 0;
            state.speedMs = 0;
            state.status = "landed";
            state.landedTicks = 0;
            state.motorRPM = 0;
            state.wpPhase = "transit";
            state.rtlHorizSpeedMs = null;
            FAKE_VEHICLES[i].status = "landed";
            if (state.clearUploadedMissionOnLanded) {
              vehicleUploadedWaypoints[v.id] = null;
              vehicleActiveMissions[v.id] = null;
              state.clearUploadedMissionOnLanded = false;
            }
          }
        } else if (state.status === "flying" && len > 0 && state.hasBeenArmed && uploaded) {
          const lastIdx = len - 1;
          const cruiseAlt = state.missionCruiseAltM ?? 30;

          if (lastIdx === 0) {
            const lp = track[0];
            const cruiseMs = waypointCruiseMs(lp, maxCap);
            const d = distanceMeters({ lat: state.lat, lon: state.lon }, lp);
            const brg = bearingDeg({ lat: state.lat, lon: state.lon }, lp);
            state.headingDeg = stepHeadingToward(state.headingDeg ?? brg, brg, maxTurnThisTick);
            const vCmd = Math.min(cruiseMs, Math.sqrt(Math.max(0, 2 * DECEL_MS2 * Math.max(0, d - 0.5))));
            state.speedMs = clampSpeedToward(state.speedMs ?? 0, vCmd, ACCEL_MS2, DECEL_MS2, TICK_S);
            const moved = moveByHeading(state.lat, state.lon, state.headingDeg, state.speedMs * TICK_S);
            state.lat = moved.lat;
            state.lon = moved.lon;
            stepAltitudeToward(state, waypointAlt(lp, cruiseAlt), TICK_S);
          } else if (state.trackIndex >= lastIdx) {
            const lp = track[lastIdx];
            const legFrom = lastIdx > 0 ? track[lastIdx - 1] : track[0];
            const cruiseMs = waypointCruiseMs(legFrom, maxCap);
            const d = distanceMeters({ lat: state.lat, lon: state.lon }, lp);
            const brg = bearingDeg({ lat: state.lat, lon: state.lon }, lp);
            state.headingDeg = stepHeadingToward(state.headingDeg ?? brg, brg, maxTurnThisTick);
            const vCmd = Math.min(cruiseMs, Math.sqrt(Math.max(0, 2 * DECEL_MS2 * Math.max(0, d - 0.5))));
            state.speedMs = clampSpeedToward(state.speedMs ?? 0, vCmd, ACCEL_MS2, DECEL_MS2, TICK_S);
            const moved = moveByHeading(state.lat, state.lon, state.headingDeg, state.speedMs * TICK_S);
            state.lat = moved.lat;
            state.lon = moved.lon;
            stepAltitudeToward(state, waypointAlt(lp, cruiseAlt), TICK_S);
          } else {
            const legWp = track[state.trackIndex];
            const targetWp = track[state.trackIndex + 1];
            const stopTurn = uploaded && targetWp.stopAndTurn === true;
            const cruiseMs = waypointCruiseMs(legWp, maxCap);
            const d = distanceMeters({ lat: state.lat, lon: state.lon }, targetWp);
            const brgToTarget = bearingDeg({ lat: state.lat, lon: state.lon }, targetWp);

            if (state.wpPhase === "hover_wait") {
              state.speedMs = clampSpeedToward(state.speedMs ?? 0, 0, ACCEL_MS2, DECEL_MS2 * 2.2, TICK_S);
              state.lat = targetWp.lat;
              state.lon = targetWp.lon;
              state.hoverTicksRemaining = (state.hoverTicksRemaining || 0) - 1;
              if (state.hoverTicksRemaining <= 0) {
                state.wpPhase = "turn_to_exit";
              }
            } else if (state.wpPhase === "turn_to_exit") {
              state.speedMs = clampSpeedToward(state.speedMs ?? 0, 0, ACCEL_MS2, DECEL_MS2 * 2.2, TICK_S);
              state.lat = targetWp.lat;
              state.lon = targetWp.lon;
              if (state.trackIndex + 1 >= lastIdx) {
                state.trackIndex = lastIdx;
                state.wpPhase = "transit";
              } else {
                const nextPt = track[state.trackIndex + 2];
                const brgNext = bearingDeg({ lat: state.lat, lon: state.lon }, nextPt);
                state.headingDeg = stepHeadingToward(state.headingDeg ?? brgNext, brgNext, maxTurnThisTick);
                if (Math.abs(shortestHeadingDeltaDeg(state.headingDeg, brgNext)) < 8) {
                  state.trackIndex += 1;
                  state.wpPhase = "transit";
                }
              }
            } else {
              let turnBlend = 1;
              if (!stopTurn && d < TURN_SLOW_OUTER_M) {
                turnBlend = d <= TURN_SLOW_INNER_M ? 0 : (d - TURN_SLOW_INNER_M) / (TURN_SLOW_OUTER_M - TURN_SLOW_INNER_M);
              }
              const cruiseTarget = stopTurn ? cruiseMs : cruiseMs * (0.3 + 0.7 * turnBlend);
              const decelDist = stopTurn ? 0.6 : 1.2;
              const vCmd = Math.min(cruiseTarget, Math.sqrt(Math.max(0, 2 * DECEL_MS2 * Math.max(0, d - decelDist))));
              state.speedMs = clampSpeedToward(state.speedMs ?? 0, vCmd, ACCEL_MS2, DECEL_MS2, TICK_S);
              state.headingDeg = stepHeadingToward(state.headingDeg ?? brgToTarget, brgToTarget, maxTurnThisTick);
              const moved = moveByHeading(state.lat, state.lon, state.headingDeg, state.speedMs * TICK_S);
              state.lat = moved.lat;
              state.lon = moved.lon;

              if (stopTurn && d < STOP_ARRIVAL_M && state.speedMs < 0.4) {
                state.speedMs = 0;
                state.lat = targetWp.lat;
                state.lon = targetWp.lon;
                const hovS = targetWp.hoverTimeS != null ? targetWp.hoverTimeS : HOVER_TURN_DEFAULT_S;
                state.hoverTicksRemaining = Math.max(1, Math.round(hovS / TICK_S));
                state.wpPhase = "hover_wait";
              } else if (!stopTurn && d < FLY_THROUGH_ARRIVAL_M) {
                state.trackIndex += 1;
                state.lat = targetWp.lat;
                state.lon = targetWp.lon;
              }
            }

            stepAltitudeToward(state, waypointAlt(targetWp, cruiseAlt), TICK_S);
          }
        }

        if (
          state.status === "flying" &&
          uploaded &&
          len > 0 &&
          shouldTriggerMissionCompleteAutoRtl(state, track, len)
        ) {
          setFlightLogCompletionReason(v.id, "mission_complete");
          state.rtlHorizSpeedMs = rtlReturnSpeedMs(state, track, len, maxCap);
          state.status = "returning";
          state.rtlPhase = "straight";
          state.wpPhase = "transit";
          state.hoverTicksRemaining = 0;
          state.clearUploadedMissionOnLanded = true;
          state.missionCompleteTelemetryOnce = true;
          FAKE_VEHICLES[i].status = "returning";
        }

        if (state.status === "flying" && (!state.hasBeenArmed || !uploaded || len === 0)) {
          state.speedMs = 0;
          state.lat = state.homeLat;
          state.lon = state.homeLon;
        }

        if (state.status === "armed" || state.status === "landed" || state.status === "disarmed") {
          state.speedMs = 0;
          if (state.status === "landed") state.altitudeM = 0;
        }

        if (state.status === "landed" || state.status === "disarmed") {
          state.lat = state.homeLat;
          state.lon = state.homeLon;
        }

        const vzMs = ((state.altitudeM ?? 0) - altBefore) / TICK_S;
        state.motorRPM = motorRpmForState(state, state.speedMs ?? 0, vzMs);

        const drainStates = ["flying", "returning", "landing", "taking_off", "arming"];
        if (drainStates.includes(state.status)) {
          const drain = batteryDrainPercentPerTick(state, state.speedMs ?? 0, vzMs);
          state.batteryPct = Math.max(0, (state.batteryPct ?? v.batteryLevel) - drain);
        }

        if (
          (state.status === "flying" || state.status === "taking_off") &&
          state.batteryPct != null &&
          state.batteryPct <= 12
        ) {
          setFlightLogCompletionReason(v.id, "battery_failsafe");
          state.clearUploadedMissionOnLanded = false;
          state.missionCompleteTelemetryOnce = false;
          state.rtlHorizSpeedMs = rtlReturnSpeedMs(state, track, len, maxCap);
          state.status = "returning";
          state.rtlPhase = "straight";
          state.wpPhase = "transit";
          state.hoverTicksRemaining = 0;
          FAKE_VEHICLES[i].status = "returning";
        }

        const distHome = distanceMeters({ lat: state.lat, lon: state.lon }, { lat: state.homeLat, lon: state.homeLon });
        state.signalStrength = Math.round(signalStrengthFromDistanceM(distHome));

        const rtkPack = computeMockRtkTelemetry(state, t, state.speedMs ?? 0, state.altitudeM ?? 0);
        const fixType = rtkPack.gpsFixType;
        let outLat;
        let outLon;
        if (fixType === "No GPS" || fixType === "No Fix") {
          if (state.telemetryHoldLat == null || state.telemetryHoldLon == null) {
            state.telemetryHoldLat = state.lat;
            state.telemetryHoldLon = state.lon;
          }
          outLat = state.telemetryHoldLat;
          outLon = state.telemetryHoldLon;
        } else {
          state.telemetryHoldLat = null;
          state.telemetryHoldLon = null;
          const jitter = metersToLatLonNoise(state.lat, rtkPack.horizNoiseM);
          outLat = state.lat + jitter.dLat;
          outLon = state.lon + jitter.dLon;
        }

        const wpInfo = computeWaypointTelemetry(state, track, len);

        const logActiveStatuses = ["flying", "returning", "landing"];
        if (logActiveStatuses.includes(state.status)) {
          if (!currentFlightLogs[v.id]) {
            currentFlightLogs[v.id] = {
              vehicleId: v.id,
              missionName: vehicleActiveMissions[v.id] || "—",
              startTime: new Date(t).toISOString(),
              snapshots: [],
              lastSnapshotTime: 0,
              startBatteryPct: state.batteryPct != null ? state.batteryPct : v.batteryLevel,
              totalWaypoints: len,
              waypointsCompleted: 0,
              homeLat: state.homeLat,
              homeLon: state.homeLon,
              completionReason: null,
            };
          }
          const log = currentFlightLogs[v.id];
          log.homeLat = state.homeLat;
          log.homeLon = state.homeLon;
          log.waypointsCompleted = wpInfo.completed;
          log.totalWaypoints = wpInfo.total;
          if (t - log.lastSnapshotTime >= FLIGHT_LOG_INTERVAL_MS) {
            log.snapshots.push(flightLogSnapshot(v.id, log.missionName, state, wpInfo.currentWaypoint));
            log.lastSnapshotTime = t;
          }
        } else if (state.status === "landed" && currentFlightLogs[v.id]) {
          finalizeFlightLog(v.id);
        }

        const missionCompleteFlag = !!state.missionCompleteTelemetryOnce;
        if (missionCompleteFlag) state.missionCompleteTelemetryOnce = false;

        const payload = {
          vehicleId: v.id,
          lat: Math.round(outLat * 1e7) / 1e7,
          lon: Math.round(outLon * 1e7) / 1e7,
          homeLat: state.homeLat,
          homeLon: state.homeLon,
          altitudeM: Math.round(state.altitudeM * 10) / 10,
          headingDeg: Math.round((state.headingDeg != null ? state.headingDeg : 0) * 10) / 10,
          speedMs: Math.round((state.speedMs ?? 0) * 10) / 10,
          batteryPct: Math.round(state.batteryPct * 10) / 10,
          signalStrength: state.signalStrength,
          motorRPM: state.motorRPM ?? 0,
          hdop: rtkPack.hdop,
          vdop: rtkPack.vdop,
          gpsFixType: rtkPack.gpsFixType,
          gpsSatellites: rtkPack.gpsSatellites,
          rtkAge: rtkPack.rtkAge,
          rtkRatio: rtkPack.rtkRatio,
          latitude_error_m: rtkPack.latitude_error_m,
          altitude_error_m: rtkPack.altitude_error_m,
          gpsDegraded: false,
          status: state.status,
          timestamp: new Date(t).toISOString(),
          gimbalPitch: state.gimbalPitch != null ? state.gimbalPitch : -90,
          gimbalYaw: state.gimbalYaw != null ? state.gimbalYaw : 0,
          lastPhotoTimestamp: state.lastPhotoTimestamp || null,
          photoIndex: state.photoIndex != null ? state.photoIndex : 0,
          isRecording: !!state.isRecording,
          photoIntervalOn: !!state.photoIntervalOn,
          currentWaypoint: wpInfo.currentWaypoint,
          totalWaypoints: wpInfo.total,
          waypointsCompleted: wpInfo.completed,
          waypointProgress: Math.round(wpInfo.progress01 * 1000) / 1000,
          missionComplete: missionCompleteFlag,
        };
        ws.send(JSON.stringify(payload));
      });
    };

    sendTelemetry();
    const id = setInterval(sendTelemetry, 500);
    intervals.push(id);

    ws.on("close", () => {
      intervals.forEach(clearInterval);
    });
  });

  server.listen(port, () => {
    console.log(`UgCS mock server: http://localhost:${port} (HTTP + WS /)`);
  });

  return { server, wss };
}

module.exports = {
  startMock,
  get FAKE_VEHICLES() {
    return FAKE_VEHICLES;
  },
  FAKE_MISSIONS,
  normalizeStoredWaypoint,
};

if (require.main === module) {
  const port = Number(process.env.MOCK_PORT) || 3335;
  startMock(port);
}
