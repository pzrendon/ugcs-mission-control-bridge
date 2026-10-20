"use strict";

/**
 * Loads environment variables from .env (if present).
 * This lets you keep local settings outside code.
 */
require("dotenv").config();

/**
 * Parse integer env values safely with fallback defaults.
 * If parsing fails, we still return a known-good default.
 */
function readInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Centralized config object used by the Node backend.
 */
const config = {
  nodePort: readInt("NODE_PORT", 3000),
  javaBridgeUrl: process.env.JAVA_BRIDGE_URL || "http://127.0.0.1:8090"
};

module.exports = { config };
