import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  loadEnvFile(path.join(__dirname, "..", ".env"));
} catch {
  // .env is optional; process.env / defaults still apply
}

import * as store from "./store.js";
import { runDiscoveryJob, jobStatus, routeQueue } from "./pipeline.js";
import { buildQuote, CATEGORY_PROFILES, PRICING_TIERS } from "./quoting.js";
import { DISCOVERABLE_CATEGORIES } from "./discovery.js";
import { renderQuoteEmail, renderLetter, smtpConfigured } from "./outreach.js";
import { dispatchQuoteEmail, sendAllEmailQueue } from "./emailDispatch.js";
import { postLetterViaStannp, stannpConfigured } from "./postal.js";

const PORT = Number(process.env.PORT || 4000);
const PASSWORD = process.env.DASH_PASSWORD || "dvpartners";

store.init();

const app = express();
app.use(express.json());

/* ---------------- Auth (simple token) ---------------- */
const tokens = new Set();

app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (password !== PASSWORD) return res.status(401).json({ error: "Wrong password" });
  const token = crypto.randomBytes(24).toString("hex");
  tokens.add(token);
  res.json({ token });
});

function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token || !tokens.has(token)) return res.status(401).json({ error: "Not authenticated" });
  next();
}

/* ---------------- Meta + settings ---------------- */
app.get("/api/meta", auth, (req, res) => {
  res.json({
    categories: DISCOVERABLE_CATEGORIES,
    categoryProfiles: CATEGORY_PROFILES,
    pricingTiers: PRICING_TIERS,
    smtpConfigured: smtpConfigured(),
    stannpConfigured: stannpConfigured(),
    settings: store.getSettings(),
  });
});

app.patch("/api/settings", auth, (req, res) => {
  const { autoSendEmail } = req.body || {};
  const patch = {};
  if (autoSendEmail !== undefined) patch.autoSendEmail = Boolean(autoSendEmail);
  const settings = store.updateSettings(patch);
  store.logActivity(`Settings updated: auto-send email ${settings.autoSendEmail ? "ON" : "OFF"}`);
  res.json(settings);
});

/* ---------------- Discovery pipeline ---------------- */
app.post("/api/discover", auth, (req, res) => {
  const { place, radiusM = 2000, categories = [], limit = 50 } = req.body || {};
  if (!place?.trim()) return res.status(400).json({ error: "Enter a town, city or postcode." });
  try {
    const job = runDiscoveryJob({
      place: place.trim(),
      radiusM: Math.min(10000, Math.max(250, Number(radiusM))),
      categories,
      limit: Math.min(200, Math.max(1, Number(limit))),
    });
    res.json(job);
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.get("/api/discover/status", auth, (req, res) => {
  res.json(jobStatus());
});

/* ---------------- Leads ---------------- */
app.get("/api/leads", auth, (req, res) => {
  const { status, queue } = req.query;
  let leads = store.allLeads();
  if (status) leads = leads.filter((l) => l.status === status);
  if (queue) leads = leads.filter((l) => l.queue === queue);
  leads = [...leads].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  res.json(leads);
});

/** Send every lead currently waiting in the email queue. */
app.post("/api/leads/email-all", auth, async (req, res) => {
  try {
    const summary = await sendAllEmailQueue();
    res.json(summary);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Log of automated quote emails (discovery auto-send + bulk email-all). */
app.get("/api/auto-sent", auth, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  res.json(store.recentAutoSent(limit));
});

app.get("/api/leads/:id", auth, (req, res) => {
  const lead = store.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  res.json(lead);
});

/** Edit lead details / override quote inputs; quote recomputed with floors enforced. */
app.patch("/api/leads/:id", auth, (req, res) => {
  const lead = store.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  if (lead.status === "sent") return res.status(400).json({ error: "Lead already sent" });

  const { email, phone, category, monthlyCardTurnover, ratePct, rental, recommendedTerminal } = req.body || {};
  const patch = {};

  if (email !== undefined) {
    patch.email = email?.trim() || null;
    if (patch.email) patch.emailSource = "manual";
  }
  if (phone !== undefined) patch.phone = phone?.trim() || null;
  if (category && CATEGORY_PROFILES[category]) patch.category = category;

  const merged = { ...lead, ...patch };
  patch.queue = routeQueue(merged);

  const categoryChanged = patch.category && patch.category !== lead.category;
  const overrides = {};
  if (monthlyCardTurnover !== undefined) overrides.monthlyCardTurnover = Math.max(0, Number(monthlyCardTurnover));
  else if (!categoryChanged) overrides.monthlyCardTurnover = lead.quote.monthlyCardTurnover;
  if (ratePct !== undefined) overrides.ratePct = Number(ratePct);
  else if (!categoryChanged) overrides.ratePct = lead.quote.ratePct;
  if (rental !== undefined) overrides.rental = Number(rental);
  else if (!categoryChanged) overrides.rental = lead.quote.rental;
  if (recommendedTerminal) overrides.recommendedTerminal = recommendedTerminal;

  patch.quote = buildQuote(patch.category || lead.category, overrides, lead.quoteCtx || {});
  const updated = store.updateLead(lead.id, patch);
  res.json(updated);
});

/** Preview the outbound email / letter exactly as it will be sent. */
app.get("/api/leads/:id/preview", auth, (req, res) => {
  const lead = store.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  if (lead.queue === "email" && lead.email) {
    const { subject, html } = renderQuoteEmail(lead);
    return res.json({ queue: "email", subject, html, to: lead.email });
  }
  return res.json({ queue: lead.queue, html: renderLetter(lead) });
});

/**
 * Approve a lead. Behaviour depends on its queue:
 *   email  → send the quote email
 *   letter → dispatch via Stannp print-and-post (or mark for manual posting)
 *   call   → not applicable (use /call-outcome), returns 400
 */
app.post("/api/leads/:id/approve", auth, async (req, res) => {
  const lead = store.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  if (lead.status === "sent") return res.status(400).json({ error: "Already sent" });

  try {
    if (lead.queue === "email" && lead.email) {
      const result = await dispatchQuoteEmail(lead, { source: "manual" });
      const updated = store.getLead(lead.id);
      return res.json({ lead: updated, ...result });
    }

    if (lead.queue === "call") {
      return res.status(400).json({ error: "Call-queue leads are closed via a call outcome, not approval." });
    }

    // Letter queue: try automated print-and-post first.
    if (stannpConfigured()) {
      const result = await postLetterViaStannp(lead);
      if (result.posted) {
        const updated = store.updateLead(lead.id, {
          status: "sent",
          sentAt: new Date().toISOString(),
          deliveredVia: result.test ? "letter (Stannp test)" : "letter (Stannp)",
          stannp: { id: result.id, cost: result.cost, pdf: result.pdf },
        });
        store.logActivity(
          `Approved ${lead.name} — letter dispatched via Stannp${result.test ? " (test mode)" : ""}` +
          (result.cost ? ` at £${result.cost}` : ""),
          lead.id
        );
        return res.json({ lead: updated, delivered: true, letter: true, stannp: result });
      }
      // Fall through to manual if Stannp rejected (e.g. missing address).
      store.logActivity(`Stannp dispatch failed for ${lead.name}: ${result.error} — marked for manual posting`, lead.id);
    }

    const updated = store.updateLead(lead.id, {
      status: "sent",
      sentAt: new Date().toISOString(),
      deliveredVia: "letter (manual print)",
    });
    store.logActivity(`Approved ${lead.name} — letter ready for manual printing/posting`, lead.id);
    return res.json({ lead: updated, delivered: true, letter: true, manual: true });
  } catch (err) {
    store.logActivity(`Send failed for ${lead.name}: ${err.message}`, lead.id);
    return res.status(502).json({ error: `Send failed: ${err.message}` });
  }
});

/** Log a sales-call outcome for a call-queue lead. */
app.post("/api/leads/:id/call-outcome", auth, (req, res) => {
  const lead = store.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const { outcome, note } = req.body || {};
  const valid = ["interested", "callback", "no-answer", "not-interested"];
  if (!valid.includes(outcome)) return res.status(400).json({ error: `Outcome must be one of: ${valid.join(", ")}` });

  const entry = { at: new Date().toISOString(), outcome, note: (note || "").slice(0, 500) };
  const callNotes = [...(lead.callNotes || []), entry];

  const patch = { callNotes };
  if (outcome === "interested") {
    patch.status = "sent";
    patch.sentAt = new Date().toISOString();
    patch.deliveredVia = "call (interested)";
  } else if (outcome === "not-interested") {
    patch.status = "rejected";
  }
  const updated = store.updateLead(lead.id, patch);
  store.logActivity(`Call: ${lead.name} — ${outcome}${note ? ` ("${note.slice(0, 60)}")` : ""}`, lead.id);
  res.json(updated);
});

app.post("/api/leads/:id/reject", auth, (req, res) => {
  const lead = store.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const updated = store.updateLead(lead.id, { status: "rejected" });
  store.logActivity(`Rejected ${lead.name}`, lead.id);
  res.json(updated);
});

app.post("/api/leads/:id/restore", auth, (req, res) => {
  const lead = store.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const updated = store.updateLead(lead.id, { status: "review" });
  store.logActivity(`Restored ${lead.name} to review queue`, lead.id);
  res.json(updated);
});

/** Printable letter (fallback for manual posting, and Stannp PDF reference). */
app.get("/api/leads/:id/letter", auth, (req, res) => {
  const lead = store.getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  res.type("html").send(renderLetter(lead));
});

/* ---------------- Stats + activity ---------------- */
app.get("/api/stats", auth, (req, res) => {
  const leads = store.allLeads();
  const by = (s) => leads.filter((l) => l.status === s).length;
  const inQueue = (q) => leads.filter((l) => l.queue === q && l.status === "review").length;
  res.json({
    total: leads.length,
    review: by("review"),
    sent: by("sent"),
    rejected: by("rejected"),
    queueEmail: inQueue("email"),
    queueCall: inQueue("call"),
    queueLetter: inQueue("letter"),
    pipelineValue: leads
      .filter((l) => l.status !== "rejected")
      .reduce((sum, l) => sum + (l.quote?.monthlyTotal || 0), 0),
    activity: store.recentActivity(30),
    autoSent: store.recentAutoSent(20),
    autoSentTotal: store.autoSentCount(),
    job: jobStatus(),
    settings: store.getSettings(),
  });
});

/* ---------------- Static dashboard ---------------- */
app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(PORT, () => {
  console.log(`D&V lead dashboard running on http://localhost:${PORT}`);
  if (!smtpConfigured()) console.log("SMTP not configured — outbound email is in dry-run mode.");
  if (!stannpConfigured()) console.log("Stannp not configured — letters fall back to manual print/post.");
  if (PASSWORD === "dvpartners") console.log('Using default password "dvpartners" — set DASH_PASSWORD in production.');
});
