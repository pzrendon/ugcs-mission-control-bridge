"use strict";

const Database = require("better-sqlite3");
const path = require("node:path");
const fs = require("node:fs");

const DB_PATH = path.join(__dirname, "..", "data", "ugcs.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    waypoints TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS flight_logs (
    id TEXT PRIMARY KEY,
    vehicle_id TEXT NOT NULL,
    vehicle_name TEXT NOT NULL,
    mission_name TEXT,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    duration_seconds INTEGER,
    total_distance_m REAL,
    max_altitude_m REAL,
    avg_speed_ms REAL,
    min_battery_pct INTEGER,
    rtk_fixed_pct REAL,
    waypoints_completed INTEGER,
    total_waypoints INTEGER,
    completion_reason TEXT,
    snapshots TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS drone_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payload_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vehicles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS laanc_authorizations (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

(function migrateFlightLogs() {
  const info = db.prepare("PRAGMA table_info(flight_logs)").all();
  const has = (n) => info.some((c) => c.name === n);
  const add = (coldef) => {
    try {
      db.exec("ALTER TABLE flight_logs ADD COLUMN " + coldef);
    } catch (_) {}
  };
  if (!has("rtk_float_pct")) add("rtk_float_pct REAL");
  if (!has("rtk_summary")) add("rtk_summary TEXT");
  if (!has("start_battery_pct")) add("start_battery_pct REAL");
  if (!has("end_battery_pct")) add("end_battery_pct REAL");
  if (!has("battery_used_pct")) add("battery_used_pct REAL");
  if (!has("home_lat")) add("home_lat REAL");
  if (!has("home_lon")) add("home_lon REAL");
})();

const missions = {
  getAll() {
    const rows = db.prepare("SELECT * FROM missions ORDER BY updated_at DESC").all();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      waypoints: JSON.parse(r.waypoints),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  },
  get(id) {
    const r = db.prepare("SELECT * FROM missions WHERE id = ?").get(String(id));
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      waypoints: JSON.parse(r.waypoints),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  },
  save(id, name, waypoints) {
    const now = Date.now();
    const sid = String(id);
    const existing = db.prepare("SELECT created_at FROM missions WHERE id = ?").get(sid);
    const createdAt = existing ? existing.created_at : now;
    db.prepare(
      `INSERT INTO missions (id, name, waypoints, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         waypoints = excluded.waypoints,
         updated_at = excluded.updated_at`
    ).run(sid, name, JSON.stringify(waypoints || []), createdAt, now);
    return { id: sid, name, waypoints: waypoints || [] };
  },
  delete(id) {
    db.prepare("DELETE FROM missions WHERE id = ?").run(String(id));
  },
};

function rowToFlightSummary(r) {
  const startIso = new Date(r.start_time).toISOString();
  const endIso = r.end_time != null ? new Date(r.end_time).toISOString() : null;
  const durationSec = r.duration_seconds != null ? r.duration_seconds : null;
  const dist = r.total_distance_m != null ? Math.round(r.total_distance_m) : null;
  return {
    vehicleId: Number(r.vehicle_id),
    vehicleName: r.vehicle_name,
    missionName: r.mission_name,
    startTime: startIso,
    endTime: endIso,
    durationSec,
    durationSeconds: durationSec,
    distanceM: dist,
    totalDistanceM: dist,
    snapshotCount: r.snapshots ? JSON.parse(r.snapshots).length : 0,
    rtkSummary:
      r.rtk_summary != null
        ? r.rtk_summary
        : r.rtk_fixed_pct != null
          ? `${Math.round(r.rtk_fixed_pct)}% RTK Fixed`
          : "—",
    rtkFixedPct: r.rtk_fixed_pct,
    maxAltitudeM: r.max_altitude_m,
    avgSpeedMs: r.avg_speed_ms,
    minBatteryPct: r.min_battery_pct,
    startBatteryPct: r.start_battery_pct,
    endBatteryPct: r.end_battery_pct,
    batteryUsedPct: r.battery_used_pct,
    waypointsCompleted: r.waypoints_completed,
    totalWaypoints: r.total_waypoints,
    completionReason: r.completion_reason || "land_command",
  };
}

const flightLogs = {
  getAll() {
    const rows = db.prepare("SELECT * FROM flight_logs ORDER BY start_time DESC").all();
    return rows.map(rowToFlightSummary);
  },
  get(vehicleId, startTime) {
    const vid = String(vehicleId);
    const startMs =
      typeof startTime === "number" && Number.isFinite(startTime)
        ? startTime
        : Date.parse(String(startTime));
    if (!Number.isFinite(startMs)) return null;
    const r = db
      .prepare("SELECT * FROM flight_logs WHERE vehicle_id = ? AND start_time = ?")
      .get(vid, startMs);
    if (!r) return null;
    const snapshots = r.snapshots ? JSON.parse(r.snapshots) : [];
    const durationSec = r.duration_seconds != null ? r.duration_seconds : null;
    const dist = r.total_distance_m != null ? Math.round(r.total_distance_m) : null;
    return {
      id: r.id,
      vehicleId: Number(r.vehicle_id),
      vehicleName: r.vehicle_name,
      missionName: r.mission_name,
      startTime: new Date(r.start_time).toISOString(),
      endTime: r.end_time != null ? new Date(r.end_time).toISOString() : null,
      durationSec,
      durationSeconds: durationSec,
      distanceM: dist,
      totalDistanceM: dist,
      maxAltitudeM: r.max_altitude_m,
      avgSpeedMs: r.avg_speed_ms,
      minBatteryPct: r.min_battery_pct,
      startBatteryPct: r.start_battery_pct,
      endBatteryPct: r.end_battery_pct,
      batteryUsedPct: r.battery_used_pct,
      rtkSummary:
        r.rtk_summary != null
          ? r.rtk_summary
          : r.rtk_fixed_pct != null
            ? `${Math.round(r.rtk_fixed_pct)}% RTK Fixed`
            : "—",
      rtkFixedPct: r.rtk_fixed_pct,
      rtkFloatPct: r.rtk_float_pct,
      waypointsCompleted: r.waypoints_completed,
      totalWaypoints: r.total_waypoints,
      completionReason: r.completion_reason || "land_command",
      homeLat: r.home_lat,
      homeLon: r.home_lon,
      snapshots,
    };
  },
  save(log) {
    const now = Date.now();
    const id = String(log.id);
    const vid = String(log.vehicleId);
    const startMs =
      typeof log.startTime === "number" && Number.isFinite(log.startTime)
        ? log.startTime
        : Date.parse(String(log.startTime));
    if (!Number.isFinite(startMs)) {
      throw new Error("flightLogs.save: invalid startTime");
    }
    const endMs =
      log.endTime == null
        ? null
        : typeof log.endTime === "number" && Number.isFinite(log.endTime)
          ? log.endTime
          : Date.parse(String(log.endTime));
    db.prepare(
      `INSERT INTO flight_logs
        (id, vehicle_id, vehicle_name, mission_name, start_time, end_time,
         duration_seconds, total_distance_m, max_altitude_m, avg_speed_ms,
         min_battery_pct, rtk_fixed_pct, rtk_float_pct, rtk_summary,
         waypoints_completed, total_waypoints, completion_reason, snapshots,
         start_battery_pct, end_battery_pct, battery_used_pct, home_lat, home_lon, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         end_time = excluded.end_time,
         duration_seconds = excluded.duration_seconds,
         total_distance_m = excluded.total_distance_m,
         max_altitude_m = excluded.max_altitude_m,
         avg_speed_ms = excluded.avg_speed_ms,
         min_battery_pct = excluded.min_battery_pct,
         rtk_fixed_pct = excluded.rtk_fixed_pct,
         rtk_float_pct = excluded.rtk_float_pct,
         rtk_summary = excluded.rtk_summary,
         waypoints_completed = excluded.waypoints_completed,
         total_waypoints = excluded.total_waypoints,
         completion_reason = excluded.completion_reason,
         snapshots = excluded.snapshots,
         start_battery_pct = excluded.start_battery_pct,
         end_battery_pct = excluded.end_battery_pct,
         battery_used_pct = excluded.battery_used_pct,
         home_lat = excluded.home_lat,
         home_lon = excluded.home_lon`
    ).run(
      id,
      vid,
      log.vehicleName || "Vehicle " + vid,
      log.missionName != null ? log.missionName : null,
      startMs,
      Number.isFinite(endMs) ? endMs : null,
      log.durationSeconds != null ? log.durationSeconds : log.durationSec ?? null,
      log.totalDistanceM != null ? log.totalDistanceM : log.distanceM ?? null,
      log.maxAltitudeM != null ? log.maxAltitudeM : null,
      log.avgSpeedMs != null ? log.avgSpeedMs : null,
      log.minBatteryPct != null ? Math.round(log.minBatteryPct) : null,
      log.rtkFixedPct != null ? log.rtkFixedPct : null,
      log.rtkFloatPct != null ? log.rtkFloatPct : null,
      log.rtkSummary != null ? String(log.rtkSummary) : null,
      log.waypointsCompleted != null ? log.waypointsCompleted : null,
      log.totalWaypoints != null ? log.totalWaypoints : null,
      log.completionReason != null ? log.completionReason : null,
      JSON.stringify(log.snapshots || []),
      log.startBatteryPct != null ? log.startBatteryPct : null,
      log.endBatteryPct != null ? log.endBatteryPct : null,
      log.batteryUsedPct != null ? log.batteryUsedPct : null,
      log.homeLat != null ? log.homeLat : null,
      log.homeLon != null ? log.homeLon : null,
      now
    );
  },
  delete(id) {
    db.prepare("DELETE FROM flight_logs WHERE id = ?").run(String(id));
  },
};

const droneProfiles = {
  getAll() {
    return db
      .prepare("SELECT * FROM drone_profiles ORDER BY name")
      .all()
      .map((r) => {
        const o = JSON.parse(r.data);
        return { ...o, id: r.id, name: r.name, builtIn: false };
      });
  },
  save(id, data) {
    const now = Date.now();
    const sid = String(id);
    const name = data.name != null ? String(data.name) : "Unnamed";
    const existing = db.prepare("SELECT created_at FROM drone_profiles WHERE id = ?").get(sid);
    const createdAt = existing ? existing.created_at : now;
    db.prepare(
      `INSERT INTO drone_profiles (id, name, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         data = excluded.data,
         updated_at = excluded.updated_at`
    ).run(sid, name, JSON.stringify({ ...data, id: sid, name }), createdAt, now);
  },
  delete(id) {
    db.prepare("DELETE FROM drone_profiles WHERE id = ?").run(String(id));
  },
};

const payloadProfiles = {
  getAll() {
    return db
      .prepare("SELECT * FROM payload_profiles ORDER BY name")
      .all()
      .map((r) => {
        const o = JSON.parse(r.data);
        return { ...o, id: r.id, name: r.name, builtIn: false };
      });
  },
  save(id, data) {
    const now = Date.now();
    const sid = String(id);
    const name = data.name != null ? String(data.name) : "Unnamed";
    const existing = db.prepare("SELECT created_at FROM payload_profiles WHERE id = ?").get(sid);
    const createdAt = existing ? existing.created_at : now;
    db.prepare(
      `INSERT INTO payload_profiles (id, name, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         data = excluded.data,
         updated_at = excluded.updated_at`
    ).run(sid, name, JSON.stringify({ ...data, id: sid, name }), createdAt, now);
  },
  delete(id) {
    db.prepare("DELETE FROM payload_profiles WHERE id = ?").run(String(id));
  },
};

const vehicles = {
  getAll() {
    return db
      .prepare("SELECT * FROM vehicles ORDER BY name")
      .all()
      .map((r) => {
        const o = JSON.parse(r.data);
        const idNum = Number(r.id);
        return { ...o, id: Number.isFinite(idNum) ? idNum : r.id, name: r.name };
      });
  },
  save(id, data) {
    const now = Date.now();
    const sid = String(id);
    const name = data.name != null ? String(data.name) : "Unnamed";
    const existing = db.prepare("SELECT created_at FROM vehicles WHERE id = ?").get(sid);
    const createdAt = existing ? existing.created_at : now;
    db.prepare(
      `INSERT INTO vehicles (id, name, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         data = excluded.data,
         updated_at = excluded.updated_at`
    ).run(sid, name, JSON.stringify(data), createdAt, now);
  },
  delete(id) {
    db.prepare("DELETE FROM vehicles WHERE id = ?").run(String(id));
  },
};

const settings = {
  get(key) {
    const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(String(key));
    return r ? JSON.parse(r.value) : null;
  },
  set(key, value) {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_at = excluded.updated_at`
    ).run(String(key), JSON.stringify(value), Date.now());
  },
};

module.exports = {
  db,
  missions,
  flightLogs,
  droneProfiles,
  payloadProfiles,
  vehicles,
  settings,
};
