"use strict";

// Cache all UI elements once at startup for cleaner code below.
const elements = {
  vehicleSelect: document.getElementById("vehicleSelect"),
  missionSelect: document.getElementById("missionSelect"),
  takeoffAltitudeInput: document.getElementById("takeoffAltitudeInput"),
  healthOutput: document.getElementById("healthOutput"),
  missionOutput: document.getElementById("missionOutput"),
  commandOutput: document.getElementById("commandOutput"),
  telemetryOutput: document.getElementById("telemetryOutput"),
  refreshHealthButton: document.getElementById("refreshHealthButton"),
  refreshListsButton: document.getElementById("refreshListsButton"),
  uploadMissionButton: document.getElementById("uploadMissionButton"),
  refreshTelemetryButton: document.getElementById("refreshTelemetryButton"),
  autoRefreshToggle: document.getElementById("autoRefreshToggle")
};

let telemetryIntervalId = null;

/**
 * Generic helper to call backend API endpoints.
 */
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

/**
 * Render JS objects in a readable JSON block.
 */
function pretty(value) {
  return JSON.stringify(value, null, 2);
}

/**
 * Load backend + Java bridge health information.
 */
async function refreshHealth() {
  elements.healthOutput.textContent = "Checking health...";
  try {
    const data = await api("/api/health");
    elements.healthOutput.textContent = pretty(data);
  } catch (error) {
    elements.healthOutput.textContent = `Error: ${error.message}`;
  }
}

/**
 * Load available vehicles and mission plans from backend.
 */
async function refreshLists() {
  elements.missionOutput.textContent = "Loading vehicles and missions...";
  try {
    const [vehiclesResponse, missionsResponse] = await Promise.all([
      api("/api/vehicles"),
      api("/api/missions")
    ]);

    fillVehicleSelect(vehiclesResponse.vehicles || []);
    fillMissionSelect(missionsResponse.missions || []);

    elements.missionOutput.textContent = `Loaded ${
      (vehiclesResponse.vehicles || []).length
    } vehicles and ${(missionsResponse.missions || []).length} missions.`;
  } catch (error) {
    elements.missionOutput.textContent = `Error: ${error.message}`;
  }
}

function fillVehicleSelect(vehicles) {
  elements.vehicleSelect.innerHTML = "";
  if (!vehicles.length) {
    elements.vehicleSelect.innerHTML = `<option value="">No vehicles found</option>`;
    return;
  }

  for (const vehicle of vehicles) {
    const option = document.createElement("option");
    option.value = String(vehicle.id);
    option.textContent = `${vehicle.name} (tail: ${vehicle.tailNumber || "n/a"})`;
    elements.vehicleSelect.appendChild(option);
  }
}

function fillMissionSelect(missions) {
  elements.missionSelect.innerHTML = "";
  if (!missions.length) {
    elements.missionSelect.innerHTML = `<option value="">No missions found</option>`;
    return;
  }

  for (const mission of missions) {
    const option = document.createElement("option");
    option.value = String(mission.id);
    option.textContent = `${mission.name} [${mission.parentMissionName || "No mission group"}]`;
    elements.missionSelect.appendChild(option);
  }
}

/**
 * Upload selected mission to selected vehicle.
 */
async function uploadMission() {
  const missionId = Number.parseInt(elements.missionSelect.value, 10);
  const vehicleId = Number.parseInt(elements.vehicleSelect.value, 10);

  if (Number.isNaN(missionId) || Number.isNaN(vehicleId)) {
    elements.missionOutput.textContent = "Please select both a mission and a vehicle.";
    return;
  }

  elements.missionOutput.textContent = "Uploading mission...";
  try {
    const result = await api(`/api/missions/${missionId}/upload`, {
      method: "POST",
      body: JSON.stringify({ vehicleId })
    });
    elements.missionOutput.textContent = pretty(result);
  } catch (error) {
    elements.missionOutput.textContent = `Error: ${error.message}`;
  }
}

/**
 * Send one direct command to selected vehicle.
 */
async function sendCommand(command) {
  const vehicleId = Number.parseInt(elements.vehicleSelect.value, 10);
  if (Number.isNaN(vehicleId)) {
    elements.commandOutput.textContent = "Please select a vehicle first.";
    return;
  }

  const takeoffAltitudeM = Number(elements.takeoffAltitudeInput.value);
  const body = {
    vehicleId,
    // Include takeoff altitude (Java bridge will ignore it for non-takeoff commands).
    takeoffAltitudeM: Number.isFinite(takeoffAltitudeM) ? takeoffAltitudeM : undefined
  };

  elements.commandOutput.textContent = `Sending ${command} command...`;
  try {
    const result = await api(`/api/commands/${command}`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    elements.commandOutput.textContent = pretty(result);
  } catch (error) {
    elements.commandOutput.textContent = `Error: ${error.message}`;
  }
}

/**
 * Pull latest telemetry from backend.
 */
async function refreshTelemetry() {
  const selectedVehicleId = Number.parseInt(elements.vehicleSelect.value, 10);
  const path = Number.isNaN(selectedVehicleId)
    ? "/api/telemetry"
    : `/api/telemetry?vehicleId=${encodeURIComponent(selectedVehicleId)}`;

  try {
    const result = await api(path);
    elements.telemetryOutput.textContent = pretty(result);
  } catch (error) {
    elements.telemetryOutput.textContent = `Error: ${error.message}`;
  }
}

/**
 * Start/stop automatic telemetry polling every 2 seconds.
 */
function updateTelemetryAutoRefresh() {
  if (telemetryIntervalId) {
    clearInterval(telemetryIntervalId);
    telemetryIntervalId = null;
  }

  if (elements.autoRefreshToggle.checked) {
    telemetryIntervalId = setInterval(refreshTelemetry, 2000);
  }
}

// Bind UI events.
elements.refreshHealthButton.addEventListener("click", refreshHealth);
elements.refreshListsButton.addEventListener("click", refreshLists);
elements.uploadMissionButton.addEventListener("click", uploadMission);
elements.refreshTelemetryButton.addEventListener("click", refreshTelemetry);
elements.autoRefreshToggle.addEventListener("change", updateTelemetryAutoRefresh);

for (const button of document.querySelectorAll(".commandButton")) {
  button.addEventListener("click", () => sendCommand(button.dataset.command));
}

// Initial data load.
refreshHealth();
refreshLists();
refreshTelemetry();
updateTelemetryAutoRefresh();
