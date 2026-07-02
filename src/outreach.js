/**
 * Outreach rendering + delivery.
 *  - Email: personalised HTML quote sent via SMTP (nodemailer).
 *    Without SMTP config the system runs in dry-run mode: the send is
 *    simulated and recorded so the full pipeline can be exercised safely.
 *  - Letter: for leads with no email we render an A4 print-ready letter
 *    to post to the business address.
 */
import nodemailer from "nodemailer";
import dns from "node:dns";
import { money } from "./quoting.js";

/** Railway/cloud SMTP often resolves IPv6 first; many mail hosts reject it. */
function ipv4Lookup(hostname, _opts, callback) {
  dns.lookup(hostname, { family: 4 }, callback);
}

function envValue(name) {
  const raw = process.env[name];
  if (raw == null || raw === "") return raw;
  return String(raw).replace(/^["']|["']$/g, "").trim();
}

function smtpPassword() {
  const raw = process.env.SMTP_PASS;
  if (raw == null || raw === "") return raw;
  // Railway paste often adds a trailing newline — breaks auth while local .env works.
  return String(raw).replace(/^["']|["']$/g, "").replace(/\r?\n/g, "").trim();
}

function smtpUser() {
  return envValue("SMTP_USER");
}

function isRailway() {
  return Boolean(process.env.RAILWAY_ENVIRONMENT);
}

export function resendConfigured() {
  return Boolean(envValue("RESEND_API_KEY"));
}

/** True when email can be sent (Resend API or direct SMTP). */
export function emailConfigured() {
  return resendConfigured() || smtpConfigured();
}

export function emailProvider() {
  if (resendConfigured()) return "resend";
  if (smtpConfigured()) return "smtp";
  return null;
}

function emailFrom() {
  return (
    envValue("EMAIL_FROM") ||
    envValue("RESEND_FROM") ||
    envValue("SMTP_FROM") ||
    `"D&V Partners" <${envValue("REPLY_TO") || "rafi@dvpartners.org"}>`
  );
}

async function sendViaResend({ to, subject, html, text }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${envValue("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: emailFrom(),
      to: [to],
      reply_to: BRAND.replyTo,
      subject,
      html,
      text,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message || body.error || `Resend HTTP ${res.status}`);
  }
  return { delivered: true, dryRun: false, messageId: body.id, provider: "resend" };
}

async function verifyResend() {
  if (!resendConfigured()) {
    lastSmtpCheck = {
      ok: false,
      error: "RESEND_API_KEY is required",
      checkedAt: new Date().toISOString(),
      mode: null,
    };
    return lastSmtpCheck;
  }

  const key = envValue("RESEND_API_KEY");
  if (!key.startsWith("re_")) {
    lastSmtpCheck = {
      ok: false,
      error: "RESEND_API_KEY should start with re_",
      checkedAt: new Date().toISOString(),
      mode: null,
    };
    return lastSmtpCheck;
  }

  try {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body.message || body.error || `Resend HTTP ${res.status}`;
      // Send-only API keys cannot list domains — still valid for sending quotes.
      if (/restricted to only send/i.test(msg)) {
        lastSmtpCheck = {
          ok: true,
          error: null,
          checkedAt: new Date().toISOString(),
          mode: "resend",
        };
        console.log("Resend send-only API key ready");
        return lastSmtpCheck;
      }
      throw new Error(msg);
    }
    const verified = (body.data || []).some((d) => d.status === "verified");
    lastSmtpCheck = {
      ok: true,
      error: verified ? null : "Add/verify dvpartners.org in Resend if sends fail",
      checkedAt: new Date().toISOString(),
      mode: "resend",
    };
    console.log(`Resend API verified${verified ? " (domain verified)" : ""}`);
    return lastSmtpCheck;
  } catch (err) {
    lastSmtpCheck = {
      ok: false,
      error: err.message,
      checkedAt: new Date().toISOString(),
      mode: null,
    };
    return lastSmtpCheck;
  }
}

/** Prefer Resend on Railway (SMTP ports blocked on Hobby/Free). */
export async function verifyEmail() {
  if (resendConfigured()) return verifyResend();
  if (smtpConfigured()) {
    const result = await verifySmtp();
    if (!result.ok && isRailway()) {
      result.error +=
        " | Railway Hobby/Free blocks outbound SMTP (ports 465 & 587). Add RESEND_API_KEY instead, or upgrade to Railway Pro.";
    }
    return result;
  }
  lastSmtpCheck = {
    ok: false,
    error: "No email provider configured",
    checkedAt: new Date().toISOString(),
    mode: null,
  };
  return lastSmtpCheck;
}

const BRAND = {
  mint: "#0fbf94",
  dark: "#0a0f1e",
  muted: "#5b6478",
  company: "D&V Partners",
  site: "https://dvpartners.org",
  get replyTo() {
    return envValue("REPLY_TO") || "rafi@dvpartners.org";
  },
};

export function smtpConfigured() {
  return Boolean(envValue("SMTP_HOST") && smtpUser() && smtpPassword());
}

let transporter = null;
let activeTransportKey = null;
let lastSmtpCheck = { ok: false, error: null, checkedAt: null, mode: null };

function transportProfiles() {
  const preferred = Number(envValue("SMTP_PORT") || 465);
  const profiles = [
    { port: preferred, secure: preferred === 465, label: `env:${preferred}` },
    { port: 587, secure: false, requireTLS: true, label: "587-starttls" },
    { port: 465, secure: true, label: "465-ssl" },
  ];
  const seen = new Set();
  return profiles.filter((p) => {
    const key = `${p.port}/${p.secure}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildTransport(profile) {
  const { port, secure, requireTLS, label } = profile;
  return {
    transport: nodemailer.createTransport({
      host: envValue("SMTP_HOST"),
      port,
      secure,
      requireTLS: Boolean(requireTLS),
      auth: {
        user: smtpUser(),
        pass: smtpPassword(),
      },
      connectionTimeout: 25_000,
      greetingTimeout: 25_000,
      socketTimeout: 35_000,
      tls: { minVersion: "TLSv1.2", servername: envValue("SMTP_HOST") },
      lookup: ipv4Lookup,
    }),
    key: label || `${port}/${secure}`,
  };
}

export function smtpDiagnostics() {
  const pass = smtpPassword() || "";
  const user = smtpUser() || "";
  return {
    configured: emailConfigured(),
    provider: emailProvider(),
    resend: resendConfigured(),
    smtp: smtpConfigured(),
    railway: isRailway(),
    railwayBlocksSmtp: isRailway() && smtpConfigured() && !resendConfigured(),
    hint: isRailway() && smtpConfigured() && !resendConfigured()
      ? "Railway blocks SMTP ports 465/587 on Hobby & Free. Add RESEND_API_KEY."
      : null,
    host: envValue("SMTP_HOST") || null,
    port: Number(envValue("SMTP_PORT") || 465),
    user,
    userLength: user.length,
    passLength: pass.length,
    passHadNewline: Boolean(process.env.SMTP_PASS && /\r|\n/.test(process.env.SMTP_PASS)),
    from: emailFrom(),
    verified: lastSmtpCheck.ok,
    error: lastSmtpCheck.error,
    mode: lastSmtpCheck.mode,
    checkedAt: lastSmtpCheck.checkedAt,
  };
}

export function smtpStatus() {
  const d = smtpDiagnostics();
  return {
    configured: d.configured,
    provider: d.provider,
    verified: d.verified,
    error: d.error,
    checkedAt: d.checkedAt,
    host: d.host,
    port: d.port,
    user: d.user,
    mode: d.mode,
    railwayBlocksSmtp: d.railwayBlocksSmtp,
    hint: d.hint,
  };
}

function resetTransporter() {
  transporter = null;
  activeTransportKey = null;
}

function getTransporter() {
  if (!smtpConfigured()) throw new Error("SMTP is not configured");
  if (!transporter) {
    const profile = transportProfiles()[0];
    const built = buildTransport(profile);
    transporter = built.transport;
    activeTransportKey = built.key;
  }
  return transporter;
}

/** Try preferred port then Spacemail-compatible fallbacks (587 STARTTLS / 465 SSL). */
export async function verifySmtp() {
  if (!smtpConfigured()) {
    lastSmtpCheck = {
      ok: false,
      error: "SMTP_HOST, SMTP_USER and SMTP_PASS are required",
      checkedAt: new Date().toISOString(),
      mode: null,
    };
    return lastSmtpCheck;
  }

  const errors = [];
  for (const profile of transportProfiles()) {
    const { transport, key } = buildTransport(profile);
    try {
      await transport.verify();
      transporter = transport;
      activeTransportKey = key;
      lastSmtpCheck = { ok: true, error: null, checkedAt: new Date().toISOString(), mode: key };
      console.log(`SMTP verified via ${key} (${envValue("SMTP_HOST")}:${profile.port})`);
      return lastSmtpCheck;
    } catch (err) {
      errors.push(`${key}: ${err.message}`);
      try {
        transport.close();
      } catch {
        /* ignore */
      }
    }
  }

  resetTransporter();
  lastSmtpCheck = {
    ok: false,
    error: errors.join(" | "),
    checkedAt: new Date().toISOString(),
    mode: null,
  };
  return lastSmtpCheck;
}

/**
 * Merchant-facing quote rows deliberately show only the headline terms
 * (rate % and rental) plus the saving — never the absolute processing
 * cost, which reads as a big scary number out of context.
 */
function quoteRows(q) {
  return `
    <tr><td style="padding:9px 0;color:${BRAND.muted}">Estimated monthly card turnover</td><td align="right" style="padding:9px 0;font-weight:600">${money(q.monthlyCardTurnover)}</td></tr>
    <tr><td style="padding:9px 0;color:${BRAND.muted}">Your transaction rate</td><td align="right" style="padding:9px 0;font-weight:700;font-size:16px">${q.ratePct}%</td></tr>
    <tr><td style="padding:9px 0;color:${BRAND.muted}">Terminal rental (${q.recommendedTerminal})</td><td align="right" style="padding:9px 0;font-weight:600">${money(q.rental)}/month</td></tr>`;
}

export function renderQuoteEmail(lead) {
  const q = lead.quote;
  const firstLine = lead.name;
  const subject = `${firstLine} — a tailored card processing quote (save up to ${money(q.estAnnualSaving)}/year)`;

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f2f4f8;font-family:Segoe UI,Arial,sans-serif;color:#17203a">
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:${BRAND.dark};border-radius:16px 16px 0 0;padding:26px 30px">
    <span style="font-size:20px;font-weight:700;color:#ffffff">D&amp;V <span style="color:${BRAND.mint}">Partners</span></span>
    <span style="float:right;color:#8b93ad;font-size:12px;padding-top:6px">UK Payment Solutions</span>
  </div>
  <div style="background:#ffffff;padding:30px;border-radius:0 0 16px 16px">
    <h1 style="font-size:21px;margin:0 0 14px">Hello ${firstLine},</h1>
    <p style="line-height:1.65;margin:0 0 14px">We help ${q.categoryLabel.toLowerCase()}s across the UK cut what they pay to take card payments. Based on a business of your type and size, we've prepared an indicative quote — no obligation, and we'll confirm exact figures against your latest statement.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14.5px;margin:18px 0">
      ${quoteRows(q)}
    </table>
    <div style="background:#eefcf7;border:1px solid #b8f0dd;border-radius:12px;padding:16px 20px;margin:0 0 20px">
      <b style="color:${BRAND.mint};font-size:15px">Estimated saving: ${money(q.estMonthlySaving)}/month (${money(q.estAnnualSaving)}/year)</b>
      <div style="font-size:13px;color:${BRAND.muted};margin-top:4px">compared with a typical high-street provider at 1.1% + £25/month rental.</div>
    </div>
    <p style="line-height:1.65;margin:0 0 8px">Every quote includes:</p>
    <ul style="line-height:1.9;font-size:14.5px;margin:0 0 20px;padding-left:20px">
      <li>${q.recommendedTerminal} terminal with contactless, Apple Pay &amp; Google Pay</li>
      <li>WiFi &amp; GPRS connectivity, 24hr fault swap-out</li>
      <li>7-day support from a named contact — not a call centre</li>
      <li>No hidden fees; every cost explained before you sign</li>
    </ul>
    <a href="mailto:${BRAND.replyTo}?subject=${encodeURIComponent(`Quote for ${lead.name}`)}" style="display:inline-block;background:${BRAND.mint};color:#ffffff;font-weight:700;padding:13px 26px;border-radius:10px;text-decoration:none">Reply for your exact quote</a>
    <p style="font-size:12.5px;color:${BRAND.muted};line-height:1.6;margin:22px 0 0">This is an indicative estimate based on typical figures for your business type. Reply with a recent statement and we'll confirm your exact rates the same day.</p>
  </div>
  <p style="font-size:11.5px;color:#9aa2b8;text-align:center;line-height:1.7;margin:16px 0 0">
    ${BRAND.company} · ${BRAND.site} · ${BRAND.replyTo}<br/>
    You're receiving this one-off business enquiry because your details are publicly listed.
    Reply "unsubscribe" and we won't contact you again.
  </p>
</div>
</body></html>`;

  const text = [
    `Hello ${firstLine},`,
    ``,
    `We help ${q.categoryLabel.toLowerCase()}s cut card processing costs. Indicative quote:`,
    `- Estimated monthly card turnover: ${money(q.monthlyCardTurnover)}`,
    `- Transaction rate: ${q.ratePct}%`,
    `- Terminal rental (${q.recommendedTerminal}): ${money(q.rental)}/month`,
    `- Estimated saving vs typical provider: ${money(q.estMonthlySaving)}/month (${money(q.estAnnualSaving)}/year)`,
    ``,
    `Reply to ${BRAND.replyTo} for an exact quote. Reply "unsubscribe" to opt out.`,
    `${BRAND.company} · ${BRAND.site}`,
  ].join("\n");

  return { subject, html, text };
}

export function renderLetter(lead) {
  const q = lead.quote;
  const addr = [lead.name, lead.address?.line1, lead.address?.city, lead.address?.postcode].filter(Boolean);
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Letter — ${lead.name}</title>
<style>
  @page { size: A4; margin: 22mm; }
  body { font-family: Georgia, "Times New Roman", serif; color: #1a2238; font-size: 12.5pt; line-height: 1.6; max-width: 720px; margin: 40px auto; padding: 0 24px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 34px; }
  .brand { font-family: Arial, sans-serif; font-size: 19pt; font-weight: bold; }
  .brand span { color: ${BRAND.mint}; }
  .brand small { display: block; font-size: 9.5pt; font-weight: normal; color: ${BRAND.muted}; margin-top: 2px; }
  .from { text-align: right; font-size: 10pt; color: ${BRAND.muted}; }
  .addr { margin: 0 0 26px; white-space: pre-line; }
  table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 12pt; }
  td { padding: 7px 0; border-bottom: 1px solid #e3e7ef; }
  td:last-child { text-align: right; font-weight: bold; }
  .save { background: #eefcf7; border: 1px solid #b8f0dd; border-radius: 8px; padding: 12px 18px; margin: 16px 0; }
  .sig { margin-top: 34px; }
  .small { font-size: 9.5pt; color: ${BRAND.muted}; margin-top: 28px; border-top: 1px solid #e3e7ef; padding-top: 12px; }
  @media print { body { margin: 0; } .no-print { display: none; } }
  .no-print { background:#17203a; color:#fff; padding:10px 16px; border-radius:8px; font-family:Arial; font-size:10.5pt; margin-bottom:24px; }
</style></head>
<body>
  <div class="no-print">Print preview — use your browser's Print function (Ctrl/Cmd+P) to produce the posted letter.</div>
  <div class="head">
    <div class="brand">D&amp;V <span>Partners</span><small>UK Payment Solutions Specialists</small></div>
    <div class="from">${BRAND.site}<br>${BRAND.replyTo}<br>${today}</div>
  </div>
  <p class="addr">${addr.join("\n")}</p>
  <p><b>A tailored card processing quote for ${lead.name}</b></p>
  <p>Dear owner or manager,</p>
  <p>We're a UK merchant services partner helping ${q.categoryLabel.toLowerCase()}s pay less to take card payments. Based on typical figures for a business like yours, we've prepared the following indicative quote:</p>
  <table>
    <tr><td>Estimated monthly card turnover</td><td>${money(q.monthlyCardTurnover)}</td></tr>
    <tr><td>Transaction rate</td><td>${q.ratePct}%</td></tr>
    <tr><td>Terminal rental (${q.recommendedTerminal})</td><td>${money(q.rental)} / month</td></tr>
  </table>
  <div class="save"><b>Estimated saving: ${money(q.estMonthlySaving)} per month — around ${money(q.estAnnualSaving)} a year</b> compared with a typical high-street provider (1.1% + £25/month).</div>
  <p>Every solution includes a ${q.recommendedTerminal.toLowerCase()} terminal with contactless, Apple Pay and Google Pay, WiFi &amp; GPRS connectivity, a 24-hour fault swap-out service, and 7-day support from a named contact.</p>
  <p>If you'd like your exact figures, send a recent card statement to <b>${BRAND.replyTo}</b> or visit <b>${BRAND.site}</b> — we respond the same working day, with no obligation.</p>
  <p class="sig">Kind regards,<br><br><b>D&amp;V Partners</b><br>UK Payment Solutions Specialists</p>
  <p class="small">This indicative quote is based on publicly available information and typical trading figures for your business type; exact pricing is confirmed against your statement. If you'd prefer not to hear from us, email ${BRAND.replyTo} with "unsubscribe".</p>
</body></html>`;
}

/**
 * Send the quote email. Returns { delivered, dryRun, messageId? }.
 */
export async function sendQuoteEmail(lead) {
  const { subject, html, text } = renderQuoteEmail(lead);

  if (resendConfigured()) {
    try {
      if (!lastSmtpCheck.ok || lastSmtpCheck.mode !== "resend") await verifyResend();
      if (!lastSmtpCheck.ok) throw new Error(lastSmtpCheck.error || "Resend not ready");
      return await sendViaResend({ to: lead.email, subject, html, text });
    } catch (err) {
      throw new Error(err.message.startsWith("Resend") ? err.message : `Resend send failed: ${err.message}`);
    }
  }

  if (!smtpConfigured()) {
    console.log(`[dry-run] Would email ${lead.email}: "${subject}"`);
    return { delivered: false, dryRun: true };
  }
  try {
    if (!lastSmtpCheck.ok) await verifySmtp();
    const from = emailFrom();
    const info = await getTransporter().sendMail({
      from,
      to: lead.email,
      replyTo: BRAND.replyTo,
      subject,
      html,
      text,
    });
    return { delivered: true, dryRun: false, messageId: info.messageId, provider: "smtp" };
  } catch (err) {
    resetTransporter();
    const hint = isRailway()
      ? " (Railway Hobby/Free blocks SMTP — use RESEND_API_KEY)"
      : "";
    throw new Error(`SMTP send failed: ${err.message}${hint}`);
  }
}
