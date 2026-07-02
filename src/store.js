/**
 * Tiny JSON-file data store with atomic writes.
 * Fine for a single-process approval dashboard; swap for a real DB if this
 * ever needs to scale past one instance.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const DB_FILE = path.join(DATA_DIR, "leads.json");

const DEFAULT_SETTINGS = {
  autoSendEmail: false, // when true, email-queue leads are sent without manual approval
};

let state = { leads: [], activity: [], autoSentLog: [], settings: { ...DEFAULT_SETTINGS } };

export function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    state = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    state.leads ??= [];
    state.activity ??= [];
    state.autoSentLog ??= [];
    state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
    // Migrate pre-queue leads (old `channel` field) to the queue model.
    for (const lead of state.leads) {
      if (!lead.queue) {
        lead.queue = lead.email ? "email" : lead.phone ? "call" : "letter";
      }
    }
  }
  persist();
}

function persist() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export function allLeads() {
  return state.leads;
}

export function getLead(id) {
  return state.leads.find((l) => l.id === id) || null;
}

export function upsertLead(lead) {
  const idx = state.leads.findIndex((l) => l.id === lead.id);
  if (idx >= 0) state.leads[idx] = lead;
  else state.leads.push(lead);
  persist();
  return lead;
}

export function updateLead(id, patch) {
  const lead = getLead(id);
  if (!lead) return null;
  Object.assign(lead, patch, { updatedAt: new Date().toISOString() });
  persist();
  return lead;
}

export function deleteLead(id) {
  state.leads = state.leads.filter((l) => l.id !== id);
  persist();
}

/** Dedupe key: a lead is "the same business" if OSM id matches, or name+postcode match. */
export function findExisting({ osmId, name, postcode }) {
  return state.leads.find((l) => {
    if (osmId && l.osmId === osmId) return true;
    if (name && postcode && l.name?.toLowerCase() === name.toLowerCase() && l.address?.postcode === postcode) return true;
    return false;
  });
}

export function getSettings() {
  return state.settings;
}

export function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  persist();
  return state.settings;
}

export function logActivity(message, leadId = null) {
  state.activity.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), message, leadId });
  state.activity = state.activity.slice(0, 400);
  persist();
}

export function recentActivity(limit = 60) {
  return state.activity.slice(0, limit);
}

export function logAutoSent({ leadId, name, email, dryRun = false, source = "auto" }) {
  state.autoSentLog.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    leadId,
    name,
    email,
    dryRun,
    source,
  });
  state.autoSentLog = state.autoSentLog.slice(0, 500);
  persist();
}

export function recentAutoSent(limit = 100) {
  return state.autoSentLog.slice(0, limit);
}

export function autoSentCount() {
  return state.autoSentLog.length;
}

export function newId() {
  return crypto.randomUUID();
}
