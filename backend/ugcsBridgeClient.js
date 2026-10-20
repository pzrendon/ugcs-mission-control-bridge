"use strict";

/**
 * Small HTTP client responsible for calling the Java bridge.
 * Keeping this in one file makes backend routes easier to read.
 */
function createUgcsBridgeClient(baseUrl) {
  /**
   * Helper that performs fetch with:
   * - JSON request/response handling
   * - timeout protection
   * - useful error messages
   */
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeoutMs = 10_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {})
        },
        signal: controller.signal
      });

      const text = await response.text();
      const body = text ? safeJsonParse(text) : {};

      if (!response.ok) {
        const message =
          body?.error ||
          body?.message ||
          `Java bridge request failed (${response.status})`;
        throw new Error(message);
      }

      return body;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Java bridge request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    health: () => request("/health"),
    listMissions: () => request("/api/missions"),
    listVehicles: () => request("/api/vehicles"),
    uploadMission: (missionId, vehicleId) =>
      request(`/api/missions/${missionId}/upload`, {
        method: "POST",
        body: JSON.stringify({ vehicleId })
      }),
    sendCommand: (command, vehicleId, takeoffAltitudeM) =>
      request("/api/commands", {
        method: "POST",
        body: JSON.stringify({ command, vehicleId, takeoffAltitudeM })
      }),
    getTelemetry: (vehicleId) =>
      request(
        vehicleId
          ? `/api/telemetry?vehicleId=${encodeURIComponent(vehicleId)}`
          : "/api/telemetry"
      )
  };
}

/**
 * Safe JSON parse helper so malformed responses do not crash parsing.
 */
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

module.exports = { createUgcsBridgeClient };
