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

/**
 * Central inboxes used across whole pub/restaurant chains — not the local manager.
 * Scraped from individual venue sites but useless for per-site quotes.
 */
const CORPORATE_EMAIL_DOMAINS = [
  "stonegategroup.co.uk",
  "greeneking.co.uk",
  "mbplc.com",
  "mitchells&butlers.com",
  "mitchellsandbutlers.com",
  "mab.co.uk",
  "spiritpubcompany.com",
  "shepherdneame.co.uk",
  "marstons.co.uk",
  "fullers.co.uk",
  "mcmullens.co.uk",
  "staustellbrewery.co.uk",
  "youngs.co.uk",
  "wetherspoon.co.uk",
  "jdwetherspoon.co.uk",
  "mccardles.co.uk",
  "brunningandprice.co.uk",
  "hall-woodhouse.co.uk",
  "candpubs.co.uk",
  "greatukpubs.co.uk",
  "ei-group.com",
  "eigroup.com",
];

const CONTACT_PATHS = ["", "/contact", "/contact-us", "/contactus", "/about", "/about-us"];

function emailDomain(email) {
  return email.split("@")[1]?.toLowerCase() || "";
}

function siteRootHost(hostname) {
  if (!hostname) return "";
  return hostname.replace(/^www\./i, "").toLowerCase();
}

/** True when the email domain matches the business website (or a clear subdomain). */
function emailMatchesSite(email, siteHost) {
  const domain = emailDomain(email);
  const host = siteRootHost(siteHost);
  if (!domain || !host) return false;
  return host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`);
}

/**
 * Parent-company / group enquiries address on a branded venue site
 * (e.g. stonegateenquiries@stonegategroup.co.uk on slugandlettuce.co.uk).
 */
export function isCorporateCentralInbox(email, website = null) {
  if (!email) return false;
  const lower = email.toLowerCase();
  const domain = emailDomain(lower);
  const local = lower.split("@")[0] || "";

  if (CORPORATE_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return true;
  }

  let siteHost = null;
  if (website) {
    try {
      siteHost = new URL(website).hostname;
    } catch {
      /* ignore */
    }
  }

  if (siteHost && !emailMatchesSite(lower, siteHost)) {
    if (/group\.co\.uk$|hospitality|pubcompany|brewery\.co\.uk$/i.test(domain)) return true;
    if (/^(enquir(y|ies)|customerservice|customerservices|central|headoffice|feedback)@/i.test(lower)) {
      return true;
    }
    if (/enquir(y|ies)/i.test(local) && /group|corp|central|plc/i.test(domain)) return true;
  }

  return false;
}

/** Suitable for a personalised quote to this specific business? */
export function isUsableOutreachEmail(email, website = null) {
  if (!email?.trim()) return false;
  const e = email.toLowerCase().trim();
  if (JUNK_PATTERNS.some((p) => p.test(e))) return false;
  if (isCorporateCentralInbox(e, website)) return false;
  return true;
}

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

function extractEmails(html, siteHost) {
  const found = new Set();
  for (const m of html.matchAll(/mailto:([^"'?\s>]+)/gi)) {
    found.add(decodeURIComponent(m[1]).toLowerCase().trim());
  }
  for (const m of html.matchAll(EMAIL_RE)) {
    found.add(m[0].toLowerCase().trim());
  }
  return [...found].filter((e) => isUsableOutreachEmail(e, `https://${siteHost}/`));
}

function rankEmail(email, siteHost) {
  let score = 0;
  const [local, domain] = email.split("@");
  if (emailMatchesSite(email, siteHost)) score += 5;
  if (/^(info|hello|contact|bookings|office|admin|sales|manager)@/i.test(local)) score += 3;
  if (/enquir(y|ies)/i.test(local) && emailMatchesSite(email, siteHost)) score += 2;
  if (/gmail|outlook|hotmail|yahoo|icloud|btinternet/.test(domain)) score += 1;
  if (isCorporateCentralInbox(email, `https://${siteHost}/`)) score -= 100;
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
    const emails = extractEmails(html, base.hostname);
    if (emails.length) {
      emails.sort((a, b) => rankEmail(b, base.hostname) - rankEmail(a, base.hostname));
      return { email: emails[0], source: url };
    }
  }
  return { email: null, source: null };
}
