/**
 * Shared quote-email dispatch — used for manual approve, discovery auto-send,
 * and bulk "email all" from the queue.
 */
import { sendQuoteEmail } from "./outreach.js";
import * as store from "./store.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} lead
 * @param {{ source?: "manual" | "auto" | "bulk" }} opts
 */
export async function dispatchQuoteEmail(lead, { source = "manual" } = {}) {
  const result = await sendQuoteEmail(lead);
  const automated = source === "auto" || source === "bulk";

  if (result.dryRun) {
    const msg = automated
      ? `${source === "bulk" ? "Bulk-send" : "Auto-send"} skipped for ${lead.name} — no email provider (add RESEND_API_KEY on Railway)`
      : `Approve skipped for ${lead.name} — no email provider configured`;
    store.logActivity(msg, lead.id);
    if (automated) {
      store.logAutoSent({
        leadId: lead.id,
        name: lead.name,
        email: lead.email,
        dryRun: true,
        source,
      });
    }
    return result;
  }

  const via = automated ? `email (${source})` : "email";
  store.updateLead(lead.id, {
    status: "sent",
    sentAt: new Date().toISOString(),
    deliveredVia: via,
  });

  if (automated) {
    store.logAutoSent({
      leadId: lead.id,
      name: lead.name,
      email: lead.email,
      dryRun: false,
      source,
    });
    const verb = source === "bulk" ? "Bulk-sent" : "Auto-sent";
    store.logActivity(`${verb} quote to ${lead.name} <${lead.email}>`, lead.id);
  } else {
    store.logActivity(`Approved ${lead.name} — quote emailed to ${lead.email}`, lead.id);
  }

  return result;
}

/** Send every lead currently waiting in the email queue. */
export async function sendAllEmailQueue({ delayMs = 400 } = {}) {
  const leads = store
    .allLeads()
    .filter((l) => l.status === "review" && l.queue === "email" && l.email);

  const summary = { total: leads.length, sent: 0, failed: 0, dryRun: 0, skipped: 0, errors: [] };

  for (const lead of leads) {
    const latest = store.getLead(lead.id);
    if (!latest || latest.status !== "review" || latest.queue !== "email" || !latest.email) continue;
    try {
      const result = await dispatchQuoteEmail(latest, { source: "bulk" });
      if (result.dryRun) {
        summary.skipped++;
        summary.dryRun++;
      } else {
        summary.sent++;
      }
      await sleep(delayMs);
    } catch (err) {
      summary.failed++;
      summary.errors.push({ leadId: lead.id, name: lead.name, error: err.message });
      store.logActivity(`Bulk-send failed for ${lead.name}: ${err.message} — left in email queue`, lead.id);
    }
  }

  if (summary.total > 0) {
    store.logActivity(
      `Bulk email complete: ${summary.sent} sent` +
        (summary.skipped ? `, ${summary.skipped} skipped (SMTP not ready)` : "") +
        (summary.failed ? `, ${summary.failed} failed` : "")
    );
  }

  return summary;
}
