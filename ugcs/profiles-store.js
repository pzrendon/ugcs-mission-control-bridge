"use strict";

const db = require("./database");

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Ground footprint from pinhole model: coverage = (sensor_mm / focal_mm) * altitude_m */
function computePayloadGeometry(profile, altM) {
  if (altM == null || altM <= 0 || !profile) return null;
  const fl = Number(profile.focalLengthMm);
  const sw = Number(profile.sensorWidthMm);
  const sh = Number(profile.sensorHeightMm);
  const iw = Number(profile.imageWidthPx);
  const ih = Number(profile.imageHeightPx);
  if (!fl || fl <= 0 || !sw || sw <= 0 || !sh || sh <= 0 || !iw || iw <= 0 || !ih || ih <= 0) {
    return null;
  }
  const footprintWidthM = (sw / fl) * altM;
  const footprintHeightM = (sh / fl) * altM;
  const groundSamplingDistanceCm = (footprintWidthM * 100) / iw;
  return {
    sampleAltM: altM,
    groundSamplingDistanceCm: Math.round(groundSamplingDistanceCm * 10000) / 10000,
    footprintWidthM: Math.round(footprintWidthM * 100) / 100,
    footprintHeightM: Math.round(footprintHeightM * 100) / 100,
  };
}

const DEFAULT_DRONE_PROFILES = [
  {
    id: "mavic-3-enterprise",
    builtIn: true,
    name: "DJI Mavic 3 Enterprise",
    type: "multirotor",
    maxSpeedMs: 21,
    maxAltitudeM: 6000,
    maxRangeM: 32000,
    batteryCapacityMah: 5000,
    estimatedFlightTimeMin: 43,
    motorCount: 4,
    weightKg: 0.915,
    defaultCruiseSpeedMs: 12,
    defaultAltitudeM: 120,
    rtlAltitudeM: 40,
    maxWindSpeedMs: 12,
  },
  {
    id: "matrice-300-rtk",
    builtIn: true,
    name: "DJI Matrice 300 RTK",
    type: "multirotor",
    maxSpeedMs: 23,
    maxAltitudeM: 7000,
    maxRangeM: 15000,
    batteryCapacityMah: 11000,
    estimatedFlightTimeMin: 55,
    motorCount: 4,
    weightKg: 6.3,
    defaultCruiseSpeedMs: 10,
    defaultAltitudeM: 80,
    rtlAltitudeM: 30,
    maxWindSpeedMs: 15,
  },
  {
    id: "dragonfly-hexa-emu",
    builtIn: true,
    name: "Dragonfly Hexa Emu",
    type: "multirotor",
    maxSpeedMs: 15,
    maxAltitudeM: 4000,
    maxRangeM: 8000,
    batteryCapacityMah: 12000,
    estimatedFlightTimeMin: 35,
    motorCount: 6,
    weightKg: 4.2,
    defaultCruiseSpeedMs: 8,
    defaultAltitudeM: 60,
    rtlAltitudeM: 25,
    maxWindSpeedMs: 10,
  },
];

const DEFAULT_PAYLOAD_PROFILES = [
  {
    id: "zenmuse-p1",
    builtIn: true,
    name: "DJI Zenmuse P1",
    type: "camera",
    manufacturer: "DJI",
    model: "Zenmuse P1",
    weightKg: 0.73,
    sensorWidthMm: 35.7,
    sensorHeightMm: 23.8,
    focalLengthMm: 35,
    imageWidthPx: 8192,
    imageHeightPx: 5460,
  },
  {
    id: "zenmuse-l1",
    builtIn: true,
    name: "DJI Zenmuse L1",
    type: "lidar",
    manufacturer: "DJI",
    model: "Zenmuse L1",
    weightKg: 0.9,
    sensorWidthMm: null,
    sensorHeightMm: null,
    focalLengthMm: null,
    imageWidthPx: null,
    imageHeightPx: null,
  },
  {
    id: "flir-vue-pro-r",
    builtIn: true,
    name: "FLIR Vue Pro R",
    type: "thermal",
    manufacturer: "FLIR",
    model: "Vue Pro R 640",
    weightKg: 0.113,
    sensorWidthMm: 10.88,
    sensorHeightMm: 8.704,
    focalLengthMm: 9,
    imageWidthPx: 640,
    imageHeightPx: 512,
  },
];

let droneProfiles = deepClone(DEFAULT_DRONE_PROFILES);
let payloadProfiles = deepClone(DEFAULT_PAYLOAD_PROFILES);
let droneIdSeq = 1;
let payloadIdSeq = 1;

function listDroneProfiles() {
  return droneProfiles.map((p) => ({ ...p }));
}

function getDroneProfile(id) {
  return droneProfiles.find((p) => String(p.id) === String(id)) || null;
}

function normalizeDroneType(t) {
  const s = String(t || "multirotor")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace("fixed-wing", "fixed-wing");
  if (s === "fixedwing" || s === "fixed-wing") return "fixed-wing";
  if (s === "vtol") return "vtol";
  if (s === "helicopter") return "helicopter";
  if (s === "multirotor") return "multirotor";
  return "multirotor";
}

function coerceDrone(body, id, existing) {
  const type = normalizeDroneType(body.type ?? existing?.type);
  const customBuild =
    body.customBuild != null && typeof body.customBuild === "object" && !Array.isArray(body.customBuild)
      ? deepClone(body.customBuild)
      : existing?.customBuild != null && typeof existing.customBuild === "object"
        ? deepClone(existing.customBuild)
        : undefined;
  const out = {
    id,
    builtIn: existing?.builtIn === true,
    name: String(body.name != null ? body.name : existing?.name || "Unnamed").trim() || "Unnamed",
    type,
    maxSpeedMs: Number(body.maxSpeedMs ?? existing?.maxSpeedMs ?? 20) || 20,
    maxAltitudeM: Number(body.maxAltitudeM ?? existing?.maxAltitudeM ?? 500) || 500,
    maxRangeM: Number(body.maxRangeM ?? existing?.maxRangeM ?? 5000) || 5000,
    batteryCapacityMah: Number(body.batteryCapacityMah ?? existing?.batteryCapacityMah ?? 5000) || 5000,
    estimatedFlightTimeMin: Number(body.estimatedFlightTimeMin ?? existing?.estimatedFlightTimeMin ?? 30) || 30,
    motorCount: Math.max(1, Math.round(Number(body.motorCount ?? existing?.motorCount ?? 4)) || 4),
    weightKg: Number(body.weightKg ?? existing?.weightKg ?? 1) || 1,
    defaultCruiseSpeedMs: Number(body.defaultCruiseSpeedMs ?? existing?.defaultCruiseSpeedMs ?? 10) || 10,
    defaultAltitudeM: Number(body.defaultAltitudeM ?? existing?.defaultAltitudeM ?? 60) || 60,
    rtlAltitudeM: Number(body.rtlAltitudeM ?? existing?.rtlAltitudeM ?? 30) || 30,
    maxWindSpeedMs: Number(body.maxWindSpeedMs ?? existing?.maxWindSpeedMs ?? 12) || 12,
  };
  if (customBuild != null) out.customBuild = customBuild;
  return out;
}

function createDroneProfile(body) {
  const id = "drone-" + droneIdSeq++;
  const p = coerceDrone(body, id, null);
  p.builtIn = false;
  db.droneProfiles.save(id, p);
  droneProfiles.push(p);
  return p;
}

function updateDroneProfile(id, body) {
  const i = droneProfiles.findIndex((p) => String(p.id) === String(id));
  if (i < 0) return null;
  const existing = droneProfiles[i];
  const p = coerceDrone(body, existing.id, existing);
  p.builtIn = existing.builtIn === true;
  if (!p.builtIn) db.droneProfiles.save(p.id, p);
  droneProfiles[i] = p;
  return p;
}

function deleteDroneProfile(id) {
  const i = droneProfiles.findIndex((p) => String(p.id) === String(id));
  if (i < 0) return false;
  if (droneProfiles[i].builtIn) return false;
  droneProfiles.splice(i, 1);
  return true;
}

function coercePayload(body, id, existing) {
  const types = ["camera", "lidar", "multispectral", "thermal", "gas-sensor"];
  const t = (body.type || existing?.type || "camera").toLowerCase();
  const type = types.includes(t) ? t : "camera";
  const num = (v, d) => {
    if (v === "" || v === null || v === undefined) return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const optCam = (key) => {
    if (!Object.prototype.hasOwnProperty.call(body, key)) return existing?.[key] ?? null;
    const v = body[key];
    if (v === "" || v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    id,
    builtIn: existing?.builtIn === true,
    name: String(body.name != null ? body.name : existing?.name || "Unnamed").trim() || "Unnamed",
    type,
    manufacturer: String(body.manufacturer != null ? body.manufacturer : existing?.manufacturer || "").trim(),
    model: String(body.model != null ? body.model : existing?.model || "").trim(),
    weightKg: num(body.weightKg, existing?.weightKg ?? 0.2),
    sensorWidthMm: optCam("sensorWidthMm"),
    sensorHeightMm: optCam("sensorHeightMm"),
    focalLengthMm: optCam("focalLengthMm"),
    imageWidthPx: optCam("imageWidthPx"),
    imageHeightPx: optCam("imageHeightPx"),
  };
}

function listPayloadProfiles(sampleAltM) {
  const alt = sampleAltM != null && sampleAltM !== "" ? Number(sampleAltM) : null;
  return payloadProfiles.map((p) => {
    const out = { ...p };
    if (alt != null && Number.isFinite(alt) && alt > 0) {
      const c = computePayloadGeometry(p, alt);
      if (c) Object.assign(out, c);
    }
    return out;
  });
}

function getPayloadProfile(id, sampleAltM) {
  const p = payloadProfiles.find((x) => String(x.id) === String(id));
  if (!p) return null;
  const out = { ...p };
  const alt = sampleAltM != null ? Number(sampleAltM) : null;
  if (alt != null && Number.isFinite(alt) && alt > 0) {
    const c = computePayloadGeometry(p, alt);
    if (c) Object.assign(out, c);
  }
  return out;
}

function createPayloadProfile(body) {
  const id = "payload-" + payloadIdSeq++;
  const p = coercePayload(body, id, null);
  p.builtIn = false;
  db.payloadProfiles.save(id, p);
  payloadProfiles.push(p);
  return p;
}

function updatePayloadProfile(id, body) {
  const i = payloadProfiles.findIndex((p) => String(p.id) === String(id));
  if (i < 0) return null;
  const existing = payloadProfiles[i];
  const p = coercePayload(body, existing.id, existing);
  p.builtIn = existing.builtIn === true;
  if (!p.builtIn) db.payloadProfiles.save(p.id, p);
  payloadProfiles[i] = p;
  return p;
}

function deletePayloadProfile(id) {
  const i = payloadProfiles.findIndex((p) => String(p.id) === String(id));
  if (i < 0) return false;
  if (payloadProfiles[i].builtIn) return false;
  db.payloadProfiles.delete(id);
  payloadProfiles.splice(i, 1);
  return true;
}

module.exports = {
  computePayloadGeometry,
  listDroneProfiles,
  getDroneProfile,
  createDroneProfile,
  updateDroneProfile,
  deleteDroneProfile,
  listPayloadProfiles,
  getPayloadProfile,
  createPayloadProfile,
  updatePayloadProfile,
  deletePayloadProfile,
};
