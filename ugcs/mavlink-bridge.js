"use strict";

const http = require("node:http");
const { WebSocketServer } = require("ws");
const { SerialPort } = require("serialport");
const {
  MavLinkPacketSplitter,
  MavLinkPacketParser,
  send,
  MavLinkProtocolV2,
  minimal,
  common,
} = require("node-mavlink");

const MAV_MODE_FLAG_ARMED = 128;

const REGISTRY = {
  ...minimal.REGISTRY,
  ...common.REGISTRY,
};

const GPS_FIX_TYPE_NAMES = ["No GPS", "No Fix", "2D Fix", "3D Fix", "GPS+DGPS", "RTK Float", "RTK Fixed"];

function mavlinkGpsFixTypeName(fixType) {
  const i = Math.max(0, Math.min(GPS_FIX_TYPE_NAMES.length - 1, Number(fixType) | 0));
  return GPS_FIX_TYPE_NAMES[i];
}

const HEARTBEAT_TIMEOUT_MS = 3000;
const TELEMETRY_INTERVAL_MS = 500;

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

/**
 * Start the MAVLink bridge: open serial port, parse incoming MAVLink, expose HTTP + WS API.
 * @param {string} serialPath - e.g. COM3
 * @param {number} baudRate - e.g. 57600
 * @param {number} httpPort - e.g. 3335
 * @returns {{ server: import('http').Server, connected: () => boolean, sysId: () => number } | null} null if serial port could not be opened
 */
function startMavlinkBridge(serialPath, baudRate, httpPort) {
  let serial = null;
  let lastHeartbeatAt = 0;
  let sysId = 1;
  let compId = 1;

  const state = {
    status: "disarmed",
    lat: null,
    lon: null,
    altitudeM: null,
    headingDeg: null,
    speedMs: null,
    batteryPct: null,
    signalStrength: 90,
    homeLat: null,
    homeLon: null,
    gimbalPitch: -90,
    gimbalYaw: 0,
    lastPhotoTimestamp: null,
    photoIndex: 0,
    isRecording: false,
    photoIntervalOn: false,
    gpsFixType: "No GPS",
    gpsSatellites: 0,
    hdop: null,
    vdop: null,
    rtkAge: null,
    rtkRatio: 1,
    latitude_error_m: null,
    altitude_error_m: null,
    gps2BaselineAge: null,
  };

  function connected() {
    return lastHeartbeatAt > 0 && (Date.now() - lastHeartbeatAt) < HEARTBEAT_TIMEOUT_MS;
  }

  const protocol = new MavLinkProtocolV2(254, 1);

  return new Promise((resolve) => {
    const port = new SerialPort(
      { path: serialPath, baudRate },
      (err) => {
        if (err) {
          console.error(`MAVLink port ${serialPath} not found. Check MAVLINK_PORT in .env`);
          console.error(err.message);
          resolve(null);
          return;
        }
        serial = port;

        const reader = port
          .pipe(new MavLinkPacketSplitter())
          .pipe(new MavLinkPacketParser());

        reader.on("data", (packet) => {
          const clazz = REGISTRY[packet.header.msgid];
          if (!clazz) return;
          try {
            const data = packet.protocol.data(packet.payload, clazz);
            sysId = packet.header.sysid;
            compId = packet.header.compid;

            if (packet.header.msgid === 0) {
              lastHeartbeatAt = Date.now();
              const armed = (data.baseMode & MAV_MODE_FLAG_ARMED) !== 0;
              state.status = armed ? "armed" : "disarmed";
            } else if (packet.header.msgid === 1) {
              if (data.batteryRemaining != null && data.batteryRemaining >= 0) {
                state.batteryPct = data.batteryRemaining;
              }
            } else if (packet.header.msgid === 30) {
              if (typeof data.yaw === "number") {
                state.headingDeg = (data.yaw * 180) / Math.PI;
                if (state.headingDeg < 0) state.headingDeg += 360;
              }
            } else if (packet.header.msgid === 33) {
              if (typeof data.lat === "number") state.lat = data.lat / 1e7;
              if (typeof data.lon === "number") state.lon = data.lon / 1e7;
              if (typeof data.alt === "number") state.altitudeM = data.alt / 1000;
              if (typeof data.relativeAlt === "number" && state.altitudeM == null) {
                state.altitudeM = data.relativeAlt / 1000;
              }
              if (typeof data.hdg === "number") state.headingDeg = data.hdg / 100;
            } else if (packet.header.msgid === 74) {
              if (typeof data.groundspeed === "number") state.speedMs = data.groundspeed;
              if (typeof data.alt === "number" && state.altitudeM == null) state.altitudeM = data.alt;
              if (typeof data.heading === "number") state.headingDeg = data.heading;
            } else if (packet.header.msgid === 24) {
              const fix = data.fixType != null ? Number(data.fixType) : 0;
              state.gpsFixType = mavlinkGpsFixTypeName(fix);
              if (data.satellitesVisible != null && data.satellitesVisible >= 0) {
                state.gpsSatellites = Math.min(24, data.satellitesVisible);
              }
              if (data.eph != null && data.eph !== 65535) {
                state.hdop = Math.min(5, Math.max(0.5, data.eph / 100));
              }
              if (data.epv != null && data.epv !== 65535) {
                state.vdop = Math.min(5, Math.max(0.5, data.epv / 100));
              }
              if (data.hAcc != null && data.hAcc > 0 && data.hAcc !== 4294967295) {
                state.latitude_error_m = Math.round((data.hAcc / 1000) * 1000) / 1000;
              }
              if (data.vAcc != null && data.vAcc > 0 && data.vAcc !== 4294967295) {
                state.altitude_error_m = Math.round((data.vAcc / 1000) * 1000) / 1000;
              }
            } else if (packet.header.msgid === 124) {
              if (data.dgpsAge != null && data.dgpsAge < 255) {
                state.gps2BaselineAge = data.dgpsAge;
                if (state.rtkAge == null) state.rtkAge = data.dgpsAge;
              }
              const fix2 = data.fixType != null ? Number(data.fixType) : -1;
              if (fix2 >= 5) {
                state.gpsFixType = mavlinkGpsFixTypeName(fix2);
              }
            } else if (packet.header.msgid === 127) {
              const iar = data.iarNumHypotheses != null ? Number(data.iarNumHypotheses) : 0;
              if (iar > 0) {
                state.gpsFixType = "RTK Fixed";
                state.rtkRatio = Math.min(999.9, Math.max(30, iar * 2.5));
              }
              if (data.accuracy != null && data.accuracy > 0) {
                state.latitude_error_m = Math.min(state.latitude_error_m != null ? state.latitude_error_m : 999, data.accuracy / 1000);
              }
              if (data.nsats != null && data.nsats > 0) {
                state.gpsSatellites = Math.min(24, Math.max(state.gpsSatellites || 0, data.nsats));
              }
            }
          } catch (e) {
            // ignore parse errors
          }
        });

        reader.on("error", (err) => {
          console.error("MAVLink reader error:", err.message);
        });

        port.on("error", (err) => {
          console.error("MAVLink serial error:", err.message);
        });

        const heartbeatCheck = setInterval(() => {
          if (lastHeartbeatAt > 0 && (Date.now() - lastHeartbeatAt) >= HEARTBEAT_TIMEOUT_MS) {
            console.warn("MAVLink: no HEARTBEAT received in 3 seconds; marking disconnected.");
          }
        }, 1000);

        const server = http.createServer((req, res) => {
          if (req.url === "/" && req.headers["upgrade"] === "websocket") {
            return;
          }
          route(req, res);
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

        const telemetryInterval = setInterval(() => {
          wss.clients.forEach((ws) => {
            if (ws.readyState !== 1) return;
            const hdopOut = state.hdop != null ? Math.round(state.hdop * 100) / 100 : 2;
            const vdopOut = state.vdop != null ? Math.round(state.vdop * 100) / 100 : 2;
            const latErr = state.latitude_error_m != null ? Math.round(state.latitude_error_m * 1000) / 1000 : null;
            const altErr = state.altitude_error_m != null ? Math.round(state.altitude_error_m * 1000) / 1000 : null;
            const payload = {
              vehicleId: 1,
              lat: state.lat != null ? state.lat : 0,
              lon: state.lon != null ? state.lon : 0,
              homeLat: state.homeLat != null ? state.homeLat : state.lat,
              homeLon: state.homeLon != null ? state.homeLon : state.lon,
              altitudeM: state.altitudeM != null ? Math.round(state.altitudeM * 10) / 10 : 0,
              headingDeg: state.headingDeg != null ? Math.round(state.headingDeg * 10) / 10 : 0,
              speedMs: state.speedMs != null ? Math.round(state.speedMs * 10) / 10 : 0,
              batteryPct: state.batteryPct != null ? Math.round(state.batteryPct * 10) / 10 : 0,
              signalStrength: state.signalStrength,
              status: state.status,
              timestamp: new Date().toISOString(),
              gimbalPitch: state.gimbalPitch,
              gimbalYaw: state.gimbalYaw,
              lastPhotoTimestamp: state.lastPhotoTimestamp,
              photoIndex: state.photoIndex,
              isRecording: state.isRecording,
              photoIntervalOn: state.photoIntervalOn,
              motorRPM: 0,
              hdop: hdopOut,
              vdop: vdopOut,
              gpsFixType: state.gpsFixType || "No GPS",
              gpsSatellites: state.gpsSatellites || 0,
              rtkAge: state.rtkAge,
              rtkRatio: Math.round(state.rtkRatio * 10) / 10,
              latitude_error_m: latErr,
              altitude_error_m: altErr,
              gpsDegraded: false,
            };
            try {
              ws.send(JSON.stringify(payload));
            } catch (_) {}
          });
        }, TELEMETRY_INTERVAL_MS);

        function route(req, res) {
          const method = req.method;
          const url = new URL(req.url || "/", `http://${req.headers.host}`);
          const pathname = url.pathname;
          const pathParts = pathname.replace(/^\/+/, "").split("/");

          if (method === "GET" && pathParts[0] === "api" && pathParts[1] === "v1" && pathParts[2] === "vehicles" && pathParts.length === 3) {
            const vehicle = {
              id: 1,
              name: "MAVLink Vehicle",
              type: "multirotor",
              status: state.status,
              batteryLevel: state.batteryPct != null ? Math.round(state.batteryPct) : 0,
              serialNumber: "MAVLINK-1",
              activeMissionName: null,
            };
            sendJson(res, 200, [vehicle]);
            return;
          }

          if (method === "GET" && pathParts[0] === "api" && pathParts[1] === "v1" && pathParts[2] === "missions" && pathParts.length === 3) {
            sendJson(res, 200, []);
            return;
          }

          if (method === "GET" && pathParts[0] === "api" && pathParts[1] === "v1" && pathParts[2] === "flight-logs" && pathParts.length === 3) {
            sendJson(res, 200, []);
            return;
          }

          if (method === "GET" && pathParts[0] === "api" && pathParts[1] === "v1" && pathParts[2] === "flight-logs" && pathParts.length === 4) {
            sendJson(res, 404, { error: "Flight log not found" });
            return;
          }

          const commandMatch = pathname.match(/^\/api\/v1\/vehicles\/([^/]+)\/command$/);
          if (method === "POST" && commandMatch) {
            const vehicleIdStr = commandMatch[1];
            if (vehicleIdStr !== "1") {
              sendJson(res, 404, { error: "Vehicle not found" });
              return;
            }
            parseBody(req).then((body) => {
              const command = (body.command || "").toLowerCase();
              let msg = null;
              if (command === "arm") {
                msg = new common.ComponentArmDisarmCommand(sysId, compId);
                msg.arm = 1;
              } else if (command === "disarm") {
                msg = new common.ComponentArmDisarmCommand(sysId, compId);
                msg.arm = 0;
              } else if (command === "takeoff") {
                msg = new common.NavTakeoffCommand(sysId, compId);
                const alt = (body.altitudeM != null ? Number(body.altitudeM) : NaN) || 30;
                msg.altitude = Number.isNaN(alt) ? 30 : alt;
              } else if (command === "rtl") {
                msg = new common.NavReturnToLaunchCommand(sysId, compId);
              } else if (command === "land") {
                msg = new common.NavLandCommand(sysId, compId);
              }
              if (!msg) {
                sendJson(res, 400, { error: "command must be one of: arm, disarm, takeoff, rtl, land" });
                return;
              }
              send(port, msg, protocol).then(() => {
                sendJson(res, 200, { success: true, command, vehicleId: "1" });
              }).catch((err) => {
                console.error("MAVLink send error:", err.message);
                sendJson(res, 502, { error: err.message });
              });
            }).catch(() => sendJson(res, 400, { error: "Invalid JSON body" }));
            return;
          }

          sendJson(res, 404, { error: "Not found" });
        }

        server.on("close", () => {
          clearInterval(heartbeatCheck);
          clearInterval(telemetryInterval);
        });

        server.listen(httpPort, () => {
          console.log(`MAVLink bridge: http://localhost:${httpPort} (serial ${serialPath} @ ${baudRate})`);
        });

        resolve({
          server,
          connected,
          sysId: () => sysId,
          compId: () => compId,
        });
      }
    );
  });
}

module.exports = { startMavlinkBridge };
