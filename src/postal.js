/**
 * Print-and-post integration via Stannp (https://www.stannp.com) — a UK
 * direct-mail API that prints, envelopes and posts letters for ~80p each,
 * so nobody has to print and ship manually.
 *
 * Configure STANNP_API_KEY in .env to enable. Without a key the letter queue
 * still works: approval produces the print-ready HTML for manual posting.
 * Set STANNP_TEST=true to create sample PDFs on Stannp without dispatching
 * or being charged (their sandbox mode).
 */
import { renderLetter } from "./outreach.js";

const STANNP_ENDPOINT = "https://api-eu1.stannp.com/v1/letters/create";

export function stannpConfigured() {
  return Boolean(process.env.STANNP_API_KEY);
}

function splitName(businessName) {
  // Stannp requires a firstname/lastname; address the envelope to the business.
  return { firstname: "The Owner or Manager", lastname: `— ${businessName}`.slice(0, 60) };
}

/**
 * Letter body as simple HTML for Stannp's `pages` parameter (they render it
 * onto A4 with the recipient address in the window position automatically).
 */
function letterPagesHtml(lead) {
  // Reuse the full letter template but strip the on-screen preview banner.
  return renderLetter(lead).replace(/<div class="no-print">.*?<\/div>/s, "");
}

/**
 * Dispatch a letter through Stannp print-and-post.
 * @returns {Promise<{posted: boolean, test: boolean, id?: string, cost?: string, pdf?: string, error?: string}>}
 */
export async function postLetterViaStannp(lead) {
  if (!stannpConfigured()) return { posted: false, error: "Stannp not configured" };

  const addr = lead.address || {};
  if (!addr.line1 || !addr.postcode) {
    return { posted: false, error: "Lead is missing a street address or postcode — cannot post automatically" };
  }

  const { firstname, lastname } = splitName(lead.name);
  const test = String(process.env.STANNP_TEST || "").toLowerCase() === "true";

  const params = new URLSearchParams();
  params.set("test", test ? "true" : "false");
  params.set("pages", letterPagesHtml(lead));
  params.set("duplex", "false");
  params.set("post_unverified", "true");
  params.set("tags", "dv-leadgen");
  params.set("recipient[company]", lead.name.slice(0, 100));
  params.set("recipient[firstname]", firstname);
  params.set("recipient[lastname]", lastname);
  params.set("recipient[address1]", addr.line1);
  if (addr.city) params.set("recipient[city]", addr.city);
  params.set("recipient[postcode]", addr.postcode);
  params.set("recipient[country]", "GB");

  const auth = Buffer.from(`${process.env.STANNP_API_KEY}:`).toString("base64");
  const res = await fetch(STANNP_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) {
    return { posted: false, error: body.error || `Stannp returned ${res.status}` };
  }
  return {
    posted: true,
    test,
    id: body.data?.id,
    cost: body.data?.cost,
    pdf: body.data?.pdf,
  };
}
