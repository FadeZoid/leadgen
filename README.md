# D&V Partners — Lead & Quote Engine

Automated prospecting for card machine customers, with a three-queue outreach workflow.

The pipeline:

1. **Discover** — finds named, card-machine-relevant businesses (restaurants, cafés, salons, shops, pharmacies, gyms…) in any UK town/postcode via OpenStreetMap (postcodes.io + Nominatim geocoding, Overpass search). Free, no API keys. Postcodes with or without spaces both work (`OL81QN` → `OL8 1QN`).
2. **Enrich** — visits each business's website (homepage + common contact pages) and scrapes a contact email, ranked by quality (own-domain and `info@`/`hello@` style inboxes preferred).
3. **Quote** — estimates monthly card turnover from real signals (see below) and prices it on a tier ladder. **Company floors: 0.4% transaction rate and £15/month rental**, reserved for the highest-volume tier; smaller businesses price higher.
4. **Route** — every lead lands in the right queue:
   - **Email queue** — has a contact email. Approve each one manually, or flip the **auto-send toggle** and new email leads go out without approval.
   - **Call queue** — phone number but no email. Your sales team opens the call sheet, dials, and logs the outcome (interested / callback / no answer / not interested) with notes.
   - **Letter queue** — no email and no phone. Approval dispatches the letter through **Stannp print-and-post** (they print, envelope and mail it — nothing manual), or falls back to a print-ready A4 letter if Stannp isn't configured.

## How turnover is estimated

Each estimate starts from a category baseline and is adjusted by evidence about the specific business and area — and the full breakdown is shown in the dashboard so staff can see exactly how the number was built:

| Signal | Source | Effect |
| --- | --- | --- |
| Category baseline | typical £/day × trading days for the business type | e.g. restaurant ~£1,800/day × 26 days |
| Local area | region resolved from coordinates via postcodes.io | ×0.85 (North East) to ×1.35 (London) |
| Competition density | same-category businesses found nearby in the same search | ×0.85 (crowded) to ×1.12 (few rivals) |
| Brand/chain | OSM `brand` tag | ×1.25 for recognised chains |
| Opening pattern | OSM `opening_hours` | ×1.2 (24/7), ×1.08 (7 days), ×0.92 (weekdays only) |
| Card share | assumed 85% of takings by card | ×0.85 |

Every figure remains editable per lead before sending, and manual overrides are labelled as such.

## Pricing tiers (defaults, editable per lead in the dashboard)

| Est. monthly card turnover | Rate | Rental |
| --- | --- | --- |
| £80k+ | **0.40%** | **£15** |
| £40k–£80k | 0.50% | £15 |
| £20k–£40k | 0.60% | £18 |
| £8k–£20k | 0.75% | £20 |
| under £8k | 0.95% | £22 |

The 0.4% / £15 floors are enforced server-side regardless of edits.

## Run it

```bash
cd leadgen
npm install
cp .env.example .env   # set DASH_PASSWORD and (optionally) SMTP credentials
npm start
# open http://localhost:4000
```

Without SMTP credentials the app runs in **dry-run mode**: approvals are recorded and the email is rendered/logged, but nothing is actually delivered — safe for testing the whole flow.

## Configuration (`.env`)

| Variable | Purpose |
| --- | --- |
| `PORT` | Server port (default 4000) |
| `DASH_PASSWORD` | Dashboard login password |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Outbound mail server |
| `SMTP_FROM` | From header, e.g. `"D&V Partners <rafi@dvpartners.org>"` |
| `REPLY_TO` | Reply-to address shown on quotes |
| `STANNP_API_KEY` | [Stannp](https://www.stannp.com) key for automated letter print-and-post (~80p/letter) |
| `STANNP_TEST` | `true` = create sample PDFs on Stannp without dispatching or charges |

## Architecture

```
leadgen/
  src/
    server.js     Express API + static dashboard + auth + settings
    pipeline.js   Background job: discover → enrich → quote → route to queues (+ auto-send)
    discovery.js  postcodes.io/Nominatim geocoding + Overpass business search + area lookup
    enrichment.js Website email scraping & ranking
    quoting.js    Evidence-based volume estimation + tier pricing (0.4% / £15 floors)
    outreach.js   Email template, A4 letter template, SMTP sending
    postal.js     Stannp print-and-post dispatch for the letter queue
    store.js      JSON-file data store (atomic writes) + settings
  public/         Dashboard SPA (vanilla JS, no build step)
  data/           leads.json lives here (gitignored)
```

Data is a JSON file — no database to set up. If volume grows, `store.js` is the single module to swap for SQLite/Postgres.

## Compliance notes (UK)

- B2B cold email to companies is permitted under PECR, but sole traders and partnerships are treated like consumers — review each lead before approving (that's what the queue is for).
- Every email includes an identification footer and an unsubscribe route; honour "unsubscribe" replies by rejecting the lead.
- Data comes from public sources (OpenStreetMap, business websites). Keep the stored data minimal and delete rejected leads periodically.
- Nominatim/Overpass usage policies: the app sends a proper User-Agent, runs one job at a time, and throttles website scraping (4 concurrent fetches, 250ms gaps).
