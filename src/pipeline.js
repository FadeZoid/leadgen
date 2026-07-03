/**
 * The automated pipeline: discover → enrich → quote → route to a queue.
 *
 * Queue routing after enrichment:
 *   - email  → has an email address (auto-send optional, see settings)
 *   - call   → phone number but no email (manual sales-call queue)
 *   - letter → no email and no phone (print & post, via Stannp if configured)
 */
import { discover } from "./discovery.js";
import { findEmail, isUsableOutreachEmail } from "./enrichment.js";
import { buildQuote } from "./quoting.js";
import { dispatchQuoteEmail } from "./emailDispatch.js";
import * as store from "./store.js";

let currentJob = null;

export function jobStatus() {
  return currentJob;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function routeQueue(lead) {
  if (lead.email && isUsableOutreachEmail(lead.email, lead.website)) return "email";
  if (lead.phone) return "call";
  return "letter";
}

export function runDiscoveryJob({ place, radiusM, categories, limit }) {
  if (currentJob?.state === "running") {
    throw new Error("A discovery run is already in progress.");
  }
  currentJob = {
    id: store.newId(),
    state: "running",
    phase: "discovering",
    place,
    startedAt: new Date().toISOString(),
    found: 0,
    added: 0,
    skipped: 0,
    enriched: 0,
    enrichTotal: 0,
    emailsFound: 0,
    autoSent: 0,
    queues: { email: 0, call: 0, letter: 0 },
    error: null,
  };

  // fire and forget — caller polls jobStatus()
  (async () => {
    try {
      const { place: geo, businesses, categoryCounts } = await discover({ place, radiusM, categories });
      currentJob.found = businesses.length;

      const fresh = [];
      for (const biz of businesses) {
        if (fresh.length >= limit) break;
        if (store.findExisting({ osmId: biz.osmId, name: biz.name, postcode: biz.address?.postcode })) {
          currentJob.skipped++;
          continue;
        }
        const quoteCtx = {
          region: geo.region,
          district: geo.district,
          categoryCount: categoryCounts[biz.category],
          isChain: biz.isChain,
          openingHours: biz.openingHours,
        };
        const lead = {
          id: store.newId(),
          ...biz,
          status: "review",
          queue: null, // routed after enrichment
          emailSource: biz.email ? "osm" : null,
          quote: buildQuote(biz.category, {}, quoteCtx),
          quoteCtx,
          searchPlace: place,
          region: geo.region,
          district: geo.district,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sentAt: null,
          deliveredVia: null,
          callNotes: [],
        };
        store.upsertLead(lead);
        fresh.push(lead);
        currentJob.added++;
      }

      const area = geo.district || geo.region || "UK";
      let discoveryNote = `Discovery near "${place}" (${area}): ${currentJob.found} in area — ${currentJob.added} new, ${currentJob.skipped} duplicates skipped`;
      if (currentJob.added < limit && currentJob.found > 0) {
        discoveryNote += currentJob.added === 0 && currentJob.skipped > 0
          ? " — all matches already in your database"
          : " — no more new businesses in this area";
      }
      store.logActivity(discoveryNote);

      // Enrichment: find emails for leads that have a website but no email yet.
      // Set SKIP_ENRICHMENT=true to disable (faster runs, fewer emails found).
      const skipEnrich =
        process.env.SKIP_ENRICHMENT === "true" || process.env.SKIP_ENRICHMENT === "1";
      const toEnrich = skipEnrich ? [] : fresh.filter((l) => !l.email && l.website);
      currentJob.phase = skipEnrich ? "routing" : "enriching";
      currentJob.enrichTotal = toEnrich.length;

      if (toEnrich.length) {
        const CONCURRENCY = 4;
        let idx = 0;
        async function worker() {
          while (idx < toEnrich.length) {
            const lead = toEnrich[idx++];
            const { email, source } = await findEmail(lead.website);
            if (email && isUsableOutreachEmail(email, lead.website)) {
              store.updateLead(lead.id, { email, emailSource: source });
              currentJob.emailsFound++;
            }
            currentJob.enriched++;
            await sleep(250); // politeness between site fetches
          }
        }
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      }

      if (!skipEnrich) currentJob.phase = "routing";
      for (const lead of fresh) {
        const latest = store.getLead(lead.id);
        const queue = routeQueue(latest);
        store.updateLead(lead.id, { queue });
        currentJob.queues[queue]++;
      }

      // Auto-send: if enabled, email-queue leads go out immediately.
      if (store.getSettings().autoSendEmail) {
        currentJob.phase = "auto-sending";
        for (const lead of fresh) {
          const latest = store.getLead(lead.id);
          if (latest.queue !== "email" || latest.status !== "review") continue;
          try {
            const result = await dispatchQuoteEmail(latest, { source: "auto" });
            if (!result.dryRun) currentJob.autoSent++;
            await sleep(400); // gentle send pacing
          } catch (err) {
            store.logActivity(`Auto-send failed for ${latest.name}: ${err.message} — left in email queue`, latest.id);
          }
        }
      }

      currentJob.phase = "done";
      currentJob.state = "done";
      currentJob.finishedAt = new Date().toISOString();
      const q = currentJob.queues;
      store.logActivity(
        `Pipeline complete for "${place}": ${currentJob.added} new leads — ` +
        `${q.email} email, ${q.call} call, ${q.letter} letter` +
        (currentJob.autoSent ? ` (${currentJob.autoSent} auto-sent)` : "")
      );
    } catch (err) {
      currentJob.state = "error";
      currentJob.error = isTimeoutError(err)
        ? `Map search timed out — try radius 1 km, limit 20, and fewer categories. (${err.message})`
        : err.message;
      store.logActivity(`Pipeline failed for "${place}": ${currentJob.error}`);
    }
  })();

  return currentJob;
}

function isTimeoutError(err) {
  const msg = err?.message || "";
  return /timeout|aborted|timed out/i.test(msg);
}
