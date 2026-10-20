"use strict";

/** In-memory LAANC records (replace with DB for production). */
const byAuthId = new Map();
const history = [];

function summaryRecord(r) {
  return {
    planId: r.authId,
    authId: r.authId,
    authorizationNumber: r.authorizationNumber,
    status: r.status,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    mode: r.mode,
    provider: r.provider || null,
    locationSummary: r.locationSummary || null,
    bufferM: r.bufferM != null ? r.bufferM : null,
  };
}

function save(rec) {
  byAuthId.set(rec.authId, rec);
  history.unshift(summaryRecord(rec));
  if (history.length > 200) history.length = 200;
}

function get(authId) {
  return byAuthId.get(authId) || null;
}

function update(authId, patch) {
  const r = byAuthId.get(authId);
  if (!r) return null;
  Object.assign(r, patch, { updatedAt: new Date().toISOString() });
  const idx = history.findIndex((h) => h.authId === authId);
  if (idx >= 0) history[idx] = summaryRecord(r);
  return r;
}

function listHistory() {
  return history.slice();
}

module.exports = { save, get, update, listHistory };
