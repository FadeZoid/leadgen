/**
 * Lead enrichment: given a business website, try to find a contact email by
 * scanning the homepage and common contact pages for mailto: links and
 * email-shaped text.
 */

const UA = "Mozilla/5.0 (compatible; DVPartners-LeadGen/1.0; +https://dvpartners.org)";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** Emails that are never a real inbox for outreach purposes. */
const JUNK_PATTERNS = [
  /noreply|no-reply|donotreply/i,
  /@(example|sentry|wixpress|placeholder|domain)\./i,
  /\.(png|jpe?g|gif|svg|webp|css|js)$/i,
  /^[0-9a-f]{16,}@/i, // hashed/generated addresses
];

const CONTACT_PATHS = ["", "/contact", "/contact-us", "/contactus", "/about", "/about-us"];

async function fetchPage(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (!type.includes("text/html") && !type.includes("text/plain")) return null;
    return (await res.text()).slice(0, 500_000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractEmails(html) {
  const found = new Set();
  // mailto links first — highest confidence
  for (const m of html.matchAll(/mailto:([^"'?\s>]+)/gi)) {
    found.add(decodeURIComponent(m[1]).toLowerCase().trim());
  }
  for (const m of html.matchAll(EMAIL_RE)) {
    found.add(m[0].toLowerCase().trim());
  }
  return [...found].filter((e) => !JUNK_PATTERNS.some((p) => p.test(e)));
}

function rankEmail(email, siteHost) {
  let score = 0;
  const [local, domain] = email.split("@");
  if (siteHost && siteHost.endsWith(domain.replace(/^www\./, ""))) score += 5; // matches their own domain
  if (/^(info|hello|contact|enquiries|bookings|office|admin|sales)/.test(local)) score += 3;
  if (/gmail|outlook|hotmail|yahoo|icloud|btinternet/.test(domain)) score += 1; // plausible small-biz inbox
  return score;
}

/**
 * Try to find the best contact email for a business website.
 * @returns {Promise<{email: string|null, source: string|null}>}
 */
export async function findEmail(website) {
  if (!website) return { email: null, source: null };
  let base;
  try {
    base = new URL(website);
  } catch {
    return { email: null, source: null };
  }

  for (const p of CONTACT_PATHS) {
    const url = p ? new URL(p, base.origin).toString() : base.toString();
    const html = await fetchPage(url);
    if (!html) continue;
    const emails = extractEmails(html);
    if (emails.length) {
      emails.sort((a, b) => rankEmail(b, base.hostname) - rankEmail(a, base.hostname));
      return { email: emails[0], source: url };
    }
  }
  return { email: null, source: null };
}
