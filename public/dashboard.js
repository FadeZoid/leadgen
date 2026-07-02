/* D&V Partners — Lead & Quote Dashboard */
(() => {
  "use strict";

  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => [...c.querySelectorAll(s)];
  const money = (n) => `£${Number(n || 0).toLocaleString("en-GB")}`;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let token = sessionStorage.getItem("dv_token");
  let meta = null;
  let leadsCache = [];
  let currentLead = null;
  let pollTimer = null;

  /* ---------------- API ---------------- */
  async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.headers || {}),
      },
    });
    if (res.status === 401) {
      logout();
      throw new Error("Session expired — sign in again.");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  /* ---------------- Toast ---------------- */
  let toastTimer;
  function toast(msg, isError = false) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.toggle("error", isError);
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
  }

  /* ---------------- Auth ---------------- */
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const { token: t } = await api("/login", {
        method: "POST",
        body: JSON.stringify({ password: $("#loginPassword").value }),
      });
      token = t;
      sessionStorage.setItem("dv_token", t);
      enterApp();
    } catch (err) {
      $("#loginError").textContent = err.message;
    }
  });

  function logout() {
    token = null;
    sessionStorage.removeItem("dv_token");
    $("#app").classList.add("hidden");
    $("#loginScreen").classList.remove("hidden");
    clearInterval(pollTimer);
  }
  $("#logoutBtn").addEventListener("click", logout);

  async function enterApp() {
    try {
      meta = await api("/meta");
    } catch {
      return; // token invalid — stay on login
    }
    $("#loginScreen").classList.add("hidden");
    $("#app").classList.remove("hidden");

    const smtp = $("#smtpPill");
    if (meta.smtpConfigured) { smtp.textContent = "SMTP: connected"; smtp.classList.add("ok"); }
    else { smtp.textContent = "SMTP: dry-run mode"; smtp.classList.add("warn"); }

    const post = $("#stannpPill");
    if (meta.stannpConfigured) { post.textContent = "Post: Stannp connected"; post.classList.add("ok"); }
    else { post.textContent = "Post: manual print"; post.classList.add("warn"); }

    $("#autoSendToggle").checked = Boolean(meta.settings?.autoSendEmail);

    buildCategoryChips();
    await refreshAll();
    pollTimer = setInterval(refreshAll, 5000);
  }

  /* ---------------- Settings ---------------- */
  $("#autoSendToggle").addEventListener("change", async (e) => {
    try {
      const settings = await api("/settings", {
        method: "PATCH",
        body: JSON.stringify({ autoSendEmail: e.target.checked }),
      });
      toast(settings.autoSendEmail
        ? "Auto-send ON — new email leads will send without approval"
        : "Auto-send OFF — email leads wait for approval");
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message, true);
    }
  });

  /* ---------------- Views ---------------- */
  $$(".nav-item[data-view]").forEach((btn) => btn.addEventListener("click", () => showView(btn.dataset.view)));
  $$("[data-goto]").forEach((btn) => btn.addEventListener("click", () => showView(btn.dataset.goto)));

  function showView(name) {
    $$(".nav-item[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  }

  /* ---------------- Overview ---------------- */
  function renderStats(stats) {
    $("#statCards").innerHTML = `
      <div class="stat-card"><b>${stats.total}</b><span>Total leads</span></div>
      <div class="stat-card"><b class="mint">${stats.queueEmail}</b><span>Email queue</span></div>
      <div class="stat-card"><b class="violet">${stats.queueCall}</b><span>Call queue</span></div>
      <div class="stat-card"><b class="violet">${stats.queueLetter}</b><span>Letter queue</span></div>
      <div class="stat-card"><b>${stats.sent}</b><span>Sent / contacted</span></div>
      <div class="stat-card"><b class="mint">${money(stats.pipelineValue)}</b><span>Est. monthly pipeline</span></div>`;
    $("#emailBadge").textContent = stats.queueEmail;
    $("#callBadge").textContent = stats.queueCall;
    $("#letterBadge").textContent = stats.queueLetter;
    const autoSentBadge = $("#autoSentBadge");
    if (autoSentBadge) autoSentBadge.textContent = stats.autoSentTotal ?? 0;

    const emailAllBtn = $("#emailAllBtn");
    if (emailAllBtn) {
      emailAllBtn.disabled = stats.queueEmail < 1;
      emailAllBtn.textContent = stats.queueEmail > 0 ? `Email all (${stats.queueEmail})` : "Email all";
    }

    if (stats.settings) $("#autoSendToggle").checked = Boolean(stats.settings.autoSendEmail);

    const list = $("#activityList");
    if (!list) return;
    if (stats.activity?.length) {
      list.innerHTML = stats.activity
        .map((a) => `<li><span>${esc(a.message)}</span><time>${new Date(a.at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</time></li>`)
        .join("");
    } else {
      list.innerHTML = `<li class="muted">Nothing yet — run a discovery to get started.</li>`;
    }
  }

  /* ---------------- Discover ---------------- */
  function buildCategoryChips() {
    const grid = $("#catGrid");
    grid.innerHTML = "";
    meta.categories.forEach((cat) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "cat-chip";
      chip.dataset.cat = cat;
      chip.textContent = meta.categoryProfiles[cat]?.label || cat;
      chip.addEventListener("click", () => chip.classList.toggle("on"));
      grid.appendChild(chip);
    });
    $("#catClear").addEventListener("click", () => $$(".cat-chip.on").forEach((c) => c.classList.remove("on")));
  }

  $("#discoverForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#jobError").classList.add("hidden");
    const categories = $$(".cat-chip.on").map((c) => c.dataset.cat);
    try {
      $("#dSubmit").disabled = true;
      await api("/discover", {
        method: "POST",
        body: JSON.stringify({
          place: $("#dPlace").value,
          radiusM: Number($("#dRadius").value),
          limit: Number($("#dLimit").value),
          categories,
        }),
      });
      $("#jobProgress").classList.remove("hidden");
      $(".spinner").style.display = "";
      trackJob();
    } catch (err) {
      $("#dSubmit").disabled = false;
      $("#jobError").textContent = err.message;
      $("#jobError").classList.remove("hidden");
    }
  });

  async function trackJob() {
    const job = await api("/discover/status").catch(() => null);
    if (!job) return;
    const phaseLabel = {
      discovering: "Searching OpenStreetMap for businesses…",
      enriching: `Visiting websites to find contact emails… (${job.enriched}/${job.enrichTotal})`,
      routing: "Routing leads to queues…",
      "auto-sending": "Auto-sending email quotes…",
      done: "Done — leads routed to their queues.",
    }[job.phase] || "Working…";
    $("#jobPhase").textContent = job.state === "error" ? "Failed" : phaseLabel;
    const q = job.queues || {};
    $("#jobStats").innerHTML = `
      <span>In area: <b>${job.found}</b></span>
      <span>New leads: <b>${job.added}</b></span>
      <span>Duplicates skipped: <b>${job.skipped}</b></span>
      <span>Emails found: <b>${job.emailsFound}</b></span>
      <span>→ Email: <b>${q.email ?? 0}</b></span>
      <span>→ Call: <b>${q.call ?? 0}</b></span>
      <span>→ Letter: <b>${q.letter ?? 0}</b></span>
      ${job.autoSent ? `<span>Auto-sent: <b>${job.autoSent}</b></span>` : ""}`;

    if (job.state === "running") {
      setTimeout(trackJob, 1200);
    } else {
      $("#dSubmit").disabled = false;
      $(".spinner").style.display = "none";
      if (job.state === "error") {
        $("#jobError").textContent = job.error;
        $("#jobError").classList.remove("hidden");
      } else {
        toast(`Discovery complete — ${job.added} new lead${job.added === 1 ? "" : "s"}${job.skipped ? ` (${job.skipped} duplicates skipped)` : ""}`);
        refreshAll();
      }
    }
  }

  /* ---------------- Lead tables ---------------- */
  function statusTag(lead) {
    if (lead.status === "sent") {
      const via = lead.deliveredVia || "";
      if (via.includes("dry-run")) return `<span class="tag dry">Email (dry-run)</span>`;
      if (via.startsWith("email")) return `<span class="tag sent">Emailed${via.includes("auto") ? " (auto)" : via.includes("bulk") ? " (bulk)" : ""}</span>`;
      if (via.includes("Stannp")) return `<span class="tag sent">Posted${via.includes("test") ? " (test)" : ""}</span>`;
      if (via.startsWith("letter")) return `<span class="tag letter">Letter ready</span>`;
      if (via.startsWith("call")) return `<span class="tag sent">Interested</span>`;
      return `<span class="tag sent">Sent</span>`;
    }
    if (lead.status === "rejected") return `<span class="tag rejected">Rejected</span>`;
    return { email: `<span class="tag email">@ Email</span>`, call: `<span class="tag call">☎ Call</span>`, letter: `<span class="tag letter">✉ Letter</span>` }[lead.queue] || "";
  }

  function contactCell(lead) {
    if (lead.queue === "call") return lead.phone ? `<b class="phone">${esc(lead.phone)}</b>` : `<span class="muted">no phone</span>`;
    if (lead.queue === "email") return lead.email ? esc(lead.email) : `<span class="muted">no email</span>`;
    const addr = [lead.address?.line1, lead.address?.postcode].filter(Boolean).join(", ");
    return addr ? esc(addr) : `<span class="muted">no address on file</span>`;
  }

  function rowActions(lead) {
    if (lead.status !== "review") return `<button class="btn btn-ghost btn-sm" data-open="${lead.id}">View</button>`;
    if (lead.queue === "email") {
      return `<button class="btn btn-primary btn-sm" data-approve="${lead.id}">Approve &amp; email</button>
              <button class="btn btn-danger btn-sm" data-reject="${lead.id}">✕</button>`;
    }
    if (lead.queue === "call") {
      return `<button class="btn btn-primary btn-sm" data-open="${lead.id}">Open call sheet</button>
              <button class="btn btn-danger btn-sm" data-reject="${lead.id}">✕</button>`;
    }
    return `<button class="btn btn-primary btn-sm" data-approve="${lead.id}">Approve &amp; post</button>
            <button class="btn btn-danger btn-sm" data-reject="${lead.id}">✕</button>`;
  }

  function renderTable(el, leads) {
    if (!leads.length) {
      el.innerHTML = `<div class="empty-state">Nothing here yet.</div>`;
      return;
    }
    el.innerHTML = leads
      .map((l) => `
      <div class="lead-row" data-id="${l.id}">
        <div class="lead-name"><b>${esc(l.name)}</b><small>${esc(l.quote?.categoryLabel || l.category)} · ${esc(l.address?.city || l.district || l.searchPlace || "")}</small></div>
        <div class="lead-cell">${contactCell(l)}</div>
        <div class="lead-cell">Est. turnover<br/><b>${money(l.quote?.monthlyCardTurnover)}/mo</b></div>
        <div class="lead-cell">Quote<br/><b>${l.quote?.ratePct}% + ${money(l.quote?.rental)}/mo</b></div>
        <div>${statusTag(l)}</div>
        <div class="row-actions">${rowActions(l)}</div>
      </div>`)
      .join("");

    $$(".lead-row", el).forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        openDrawer(row.dataset.id);
      });
    });
    $$("[data-approve]", el).forEach((b) => b.addEventListener("click", () => approveLead(b.dataset.approve, b)));
    $$("[data-reject]", el).forEach((b) => b.addEventListener("click", () => rejectLead(b.dataset.reject)));
    $$("[data-open]", el).forEach((b) => b.addEventListener("click", () => openDrawer(b.dataset.open)));
    $$("[data-restore]", el).forEach((b) => b.addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/leads/${b.dataset.restore}/restore`, { method: "POST" });
      toast("Lead restored to its queue");
      refreshAll();
    }));
  }

  const QUEUE_VIEWS = [
    { queue: "email", table: "#emailTable", search: "#searchEmail" },
    { queue: "call", table: "#callTable", search: "#searchCall" },
    { queue: "letter", table: "#letterTable", search: "#searchLetter" },
  ];
  QUEUE_VIEWS.forEach((v) => $(v.search).addEventListener("input", renderQueues));

  function matchesSearch(lead, q) {
    if (!q) return true;
    return `${lead.name} ${lead.address?.city || ""} ${lead.district || ""} ${lead.searchPlace || ""}`.toLowerCase().includes(q);
  }

  function renderQueues() {
    for (const v of QUEUE_VIEWS) {
      const q = $(v.search).value.trim().toLowerCase();
      renderTable($(v.table), leadsCache.filter((l) => l.status === "review" && l.queue === v.queue && matchesSearch(l, q)));
    }
  }

  function renderAutoSentLog(entries) {
    const el = $("#autoSentTable");
    if (!entries?.length) {
      el.innerHTML = `<div class="empty-state">No auto-sent emails yet — enable auto-send on discovery, or use Email all in the queue.</div>`;
      return;
    }
    el.innerHTML = entries
      .map((e) => `
        <div class="auto-sent-row" data-lead="${esc(e.leadId)}">
          <div><b>${esc(e.name)}</b><small>${e.source === "bulk" ? "Bulk send" : "Discovery auto-send"}</small></div>
          <div>${esc(e.email)}${e.dryRun ? ` <span class="tag dry">dry-run</span>` : ""}</div>
          <time>${new Date(e.at).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
          <button class="btn btn-ghost btn-sm" data-open="${esc(e.leadId)}">View</button>
        </div>`)
      .join("");
    $$("[data-open]", el).forEach((b) => b.addEventListener("click", () => openDrawer(b.dataset.open)));
  }

  async function emailAllQueued() {
    const pending = leadsCache.filter((l) => l.status === "review" && l.queue === "email" && l.email);
    if (!pending.length) {
      toast("Email queue is empty", true);
      return;
    }
    const smtpNote = meta.smtpConfigured ? "" : "\n\nSMTP is not configured — emails will be simulated (dry-run).";
    if (!confirm(`Send quotes to all ${pending.length} businesses in the email queue?${smtpNote}`)) return;

    const btn = $("#emailAllBtn");
    try {
      btn.disabled = true;
      btn.textContent = "Sending…";
      const summary = await api("/leads/email-all", { method: "POST" });
      if (summary.sent === 0 && summary.failed === 0) {
        toast("Nothing to send — queue may have changed");
      } else if (summary.dryRun === summary.sent) {
        toast(`Bulk complete — ${summary.sent} simulated (dry-run)`);
      } else {
        toast(`Bulk complete — ${summary.sent} sent${summary.failed ? `, ${summary.failed} failed` : ""}`);
      }
      refreshAll();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      refreshAll();
    }
  }
  $("#emailAllBtn")?.addEventListener("click", emailAllQueued);

  async function refreshAll() {
    try {
      const [stats, leads] = await Promise.all([api("/stats"), api("/leads")]);
      leadsCache = leads;
      renderStats(stats);
      renderQueues();
      renderTable($("#sentTable"), leads.filter((l) => l.status === "sent"));
      const rejected = leads.filter((l) => l.status === "rejected");
      renderTable($("#rejectedTable"), rejected);
      $$("#rejectedTable .lead-row").forEach((row) => {
        $(".row-actions", row).innerHTML = `<button class="btn btn-ghost btn-sm" data-restore="${row.dataset.id}">Restore</button>`;
        $("[data-restore]", row).addEventListener("click", async (e) => {
          e.stopPropagation();
          await api(`/leads/${row.dataset.id}/restore`, { method: "POST" });
          toast("Lead restored");
          refreshAll();
        });
      });

      // Optional — don't block queues/stats if this endpoint is missing (old server).
      try {
        renderAutoSentLog(await api("/auto-sent?limit=200"));
      } catch {
        renderAutoSentLog(stats.autoSent || []);
      }
    } catch (err) {
      console.error(err);
      toast(err.message || "Could not load dashboard — try signing in again", true);
    }
  }

  /* ---------------- Approve / reject / call ---------------- */
  async function approveLead(id, btn) {
    const lead = leadsCache.find((l) => l.id === id) || currentLead;
    if (!lead) return;
    const verb = lead.queue === "email"
      ? `email the quote to ${lead.email}`
      : meta.stannpConfigured
        ? "print & post the letter via Stannp"
        : "generate the letter for manual posting";
    if (!confirm(`Approve ${lead.name} — this will ${verb}. Continue?`)) return;
    try {
      if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
      const result = await api(`/leads/${id}/approve`, { method: "POST" });
      if (result.stannp?.posted) {
        toast(`Letter dispatched via Stannp${result.stannp.test ? " (test mode)" : ""} for ${lead.name}`);
      } else if (result.letter) {
        toast(`Letter ready for ${lead.name} — opening print view`);
        window.open(`/api/leads/${id}/letter?t=${Date.now()}`, "_blank");
      } else if (result.dryRun) {
        toast(`Approved (dry-run) — configure SMTP to actually send`);
      } else {
        toast(`Quote emailed to ${lead.email}`);
      }
      closeDrawer();
      refreshAll();
    } catch (err) {
      toast(err.message, true);
      if (btn) { btn.disabled = false; btn.textContent = "Approve"; }
    }
  }

  async function rejectLead(id) {
    try {
      await api(`/leads/${id}/reject`, { method: "POST" });
      toast("Lead rejected");
      closeDrawer();
      refreshAll();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function logCallOutcome(id, outcome) {
    const note = $("#callNote")?.value || "";
    try {
      await api(`/leads/${id}/call-outcome`, {
        method: "POST",
        body: JSON.stringify({ outcome, note }),
      });
      const labels = {
        interested: "Logged: interested — moved to Sent",
        callback: "Logged: callback requested",
        "no-answer": "Logged: no answer",
        "not-interested": "Logged: not interested — rejected",
      };
      toast(labels[outcome] || "Call outcome logged");
      if (outcome === "interested" || outcome === "not-interested") closeDrawer();
      else openDrawer(id); // refresh drawer to show the new note
      refreshAll();
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ---------------- Drawer ---------------- */
  function closeDrawer() {
    $("#drawer").classList.add("hidden");
    $("#drawerBackdrop").classList.add("hidden");
    currentLead = null;
  }
  $("#drawerClose").addEventListener("click", closeDrawer);
  $("#drawerBackdrop").addEventListener("click", closeDrawer);

  function estimateBasisHtml(quote) {
    if (!quote.estimateBasis?.length) return "";
    return `
      <div class="dr-section">
        <h3>How this estimate was built</h3>
        <div class="basis">
          ${quote.estimateBasis.map((b) => `
            <div class="basis-row">
              <span class="basis-factor">${esc(b.factor)}</span>
              <span class="basis-detail">${esc(b.detail)}</span>
              <b class="basis-effect">${esc(b.effect)}</b>
            </div>`).join("")}
        </div>
      </div>`;
  }

  function callSheetHtml(l) {
    const notes = (l.callNotes || []).slice().reverse();
    return `
      <div class="dr-section call-sheet">
        <h3>Call sheet</h3>
        <div class="call-number">${l.phone ? `<a href="tel:${esc(l.phone)}">${esc(l.phone)}</a>` : "No phone on file"}</div>
        <label class="dr-field">Call note (optional)
          <input type="text" id="callNote" placeholder="e.g. spoke to owner, wants a callback Friday" />
        </label>
        <div class="call-outcomes">
          <button class="btn btn-primary btn-sm" data-outcome="interested">Interested ✓</button>
          <button class="btn btn-ghost btn-sm" data-outcome="callback">Callback</button>
          <button class="btn btn-ghost btn-sm" data-outcome="no-answer">No answer</button>
          <button class="btn btn-danger btn-sm" data-outcome="not-interested">Not interested</button>
        </div>
        ${notes.length ? `
          <div class="call-history">
            ${notes.map((n) => `
              <div class="call-note">
                <span class="tag ${n.outcome === "interested" ? "sent" : n.outcome === "not-interested" ? "rejected" : "call"}">${esc(n.outcome)}</span>
                <span>${esc(n.note || "")}</span>
                <time>${new Date(n.at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</time>
              </div>`).join("")}
          </div>` : ""}
      </div>`;
  }

  async function openDrawer(id) {
    currentLead = await api(`/leads/${id}`);
    const l = currentLead;
    $("#drName").textContent = l.name;
    $("#drSub").textContent = `${l.quote.categoryLabel} · ${[l.address?.line1, l.address?.city, l.address?.postcode].filter(Boolean).join(", ") || l.searchPlace}`;

    const editable = l.status === "review";
    const isCall = l.queue === "call" && editable;
    const catOptions = Object.entries(meta.categoryProfiles)
      .map(([k, p]) => `<option value="${k}" ${k === l.category ? "selected" : ""}>${p.label}</option>`)
      .join("");

    $("#drawerBody").innerHTML = `
      <div class="dr-section">
        <h3>Business details</h3>
        <div class="kv">
          <div><small>Queue</small><b>${statusTag(l)}</b></div>
          <div><small>Website</small><b>${l.website ? `<a href="${esc(l.website)}" target="_blank" rel="noopener">${esc(l.website.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>` : "—"}</b></div>
          <div><small>Area</small><b>${esc([l.district, l.region].filter(Boolean).join(", ") || "—")}</b></div>
          <div><small>Discovered</small><b>${new Date(l.createdAt).toLocaleString("en-GB")}</b></div>
        </div>
      </div>

      ${isCall ? callSheetHtml(l) : ""}

      <div class="dr-section">
        <h3>Contact details ${editable ? "(editing re-routes the queue)" : ""}</h3>
        <div class="dr-grid-2">
          <label class="dr-field">Email address
            <input type="email" id="edEmail" value="${esc(l.email || "")}" placeholder="none — call or letter queue" ${editable ? "" : "disabled"} />
          </label>
          <label class="dr-field">Phone
            <input type="tel" id="edPhone" value="${esc(l.phone || "")}" placeholder="none found" ${editable ? "" : "disabled"} />
          </label>
        </div>
      </div>

      <div class="dr-section">
        <h3>Quote (editable before sending)</h3>
        <div class="dr-grid-2">
          <label class="dr-field">Business type
            <select id="edCategory" ${editable ? "" : "disabled"}>${catOptions}</select>
          </label>
          <label class="dr-field">Terminal
            <select id="edTerminal" ${editable ? "" : "disabled"}>
              ${["Mobile", "Portable", "Countertop"].map((t) => `<option ${t === l.quote.recommendedTerminal ? "selected" : ""}>${t}</option>`).join("")}
            </select>
          </label>
        </div>
        <div class="dr-grid-3">
          <label class="dr-field">Monthly card turnover (£)
            <input type="number" id="edTurnover" value="${l.quote.monthlyCardTurnover}" min="0" step="500" ${editable ? "" : "disabled"} />
          </label>
          <label class="dr-field">Rate (%)
            <input type="number" id="edRate" value="${l.quote.ratePct}" min="0.4" step="0.05" ${editable ? "" : "disabled"} />
          </label>
          <label class="dr-field">Rental (£/mo)
            <input type="number" id="edRental" value="${l.quote.rental}" min="15" step="1" ${editable ? "" : "disabled"} />
          </label>
        </div>
        <div class="floor-note">Company floors apply automatically: rate ≥ 0.4%, rental ≥ £15/month.</div>
        ${editable ? `<button class="btn btn-ghost btn-sm" id="edSave" style="margin-top:12px">Recalculate &amp; save</button>` : ""}
      </div>

      ${estimateBasisHtml(l.quote)}

      <div class="dr-section">
        <div class="quote-box" id="quoteBox">${quoteBoxHtml(l.quote)}</div>
      </div>

      <div class="dr-section">
        <h3>Preview — what will be sent</h3>
        <iframe class="preview-frame" id="previewFrame" title="Outreach preview"></iframe>
      </div>

      <div class="drawer-actions">
        ${editable && l.queue !== "call" ? `
          <div class="row">
            <button class="btn btn-primary" id="drApprove">${l.queue === "email" ? "Approve &amp; send email" : meta.stannpConfigured ? "Approve &amp; post via Stannp" : "Approve &amp; print letter"}</button>
            <button class="btn btn-danger" id="drReject">Reject</button>
          </div>` : ""}
        ${isCall ? `<button class="btn btn-danger" id="drReject">Reject lead</button>` : ""}
        ${l.status === "sent" && l.deliveredVia?.startsWith("letter") && !l.stannp ? `
          <button class="btn btn-ghost" id="drLetter">Open letter print view</button>` : ""}
        ${l.stannp?.pdf ? `<a class="btn btn-ghost" href="${esc(l.stannp.pdf)}" target="_blank" rel="noopener">View Stannp PDF proof</a>` : ""}
        ${l.status === "sent" ? `<div class="muted" style="font-size:13px">Sent ${new Date(l.sentAt).toLocaleString("en-GB")} via ${esc(l.deliveredVia)}${l.stannp?.cost ? ` · cost £${esc(l.stannp.cost)}` : ""}</div>` : ""}
      </div>`;

    $("#drawer").classList.remove("hidden");
    $("#drawerBackdrop").classList.remove("hidden");

    loadPreview(l.id);

    if (editable) {
      $("#edSave")?.addEventListener("click", saveEdits);
      $("#drApprove")?.addEventListener("click", () => approveLead(l.id, $("#drApprove")));
      $("#drReject")?.addEventListener("click", () => rejectLead(l.id));
      $$("[data-outcome]").forEach((b) => b.addEventListener("click", () => logCallOutcome(l.id, b.dataset.outcome)));
    }
    $("#drLetter")?.addEventListener("click", () => window.open(`/api/leads/${l.id}/letter?t=${Date.now()}`, "_blank"));
  }

  function quoteBoxHtml(q) {
    return `
      <div class="quote-line"><span>Estimated monthly card turnover</span><b>${money(q.monthlyCardTurnover)}</b></div>
      <div class="quote-line"><span>Transaction rate <span class="muted">(${esc(q.tierName)})</span></span><b>${q.ratePct}%</b></div>
      <div class="quote-line"><span>Terminal rental (${esc(q.recommendedTerminal)})</span><b>${money(q.rental)}/mo</b></div>
      <div class="quote-line"><span>Est. processing cost <span class="muted">(internal only)</span></span><b>${money(q.monthlyProcessing)}/mo</b></div>
      <div class="quote-line total"><span>Est. total (internal only)</span><b>${money(q.monthlyTotal)}/mo</b></div>
      <div class="save-line">Savings pitch: ${money(q.estMonthlySaving)}/mo (${money(q.estAnnualSaving)}/yr) vs a typical 1.1% + £25 provider</div>`;
  }

  async function loadPreview(id) {
    try {
      const preview = await api(`/leads/${id}/preview`);
      $("#previewFrame").srcdoc = preview.html;
    } catch {
      /* preview is best-effort */
    }
  }

  async function saveEdits() {
    if (!currentLead) return;
    try {
      const updated = await api(`/leads/${currentLead.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          email: $("#edEmail").value,
          phone: $("#edPhone").value,
          category: $("#edCategory").value,
          recommendedTerminal: $("#edTerminal").value,
          monthlyCardTurnover: Number($("#edTurnover").value),
          ratePct: Number($("#edRate").value),
          rental: Number($("#edRental").value),
        }),
      });
      const requeued = updated.queue !== currentLead.queue;
      currentLead = updated;
      $("#quoteBox").innerHTML = quoteBoxHtml(updated.quote);
      $("#edRate").value = updated.quote.ratePct;
      $("#edRental").value = updated.quote.rental;
      $("#edTurnover").value = updated.quote.monthlyCardTurnover;
      loadPreview(updated.id);
      toast(requeued ? `Saved — lead moved to the ${updated.queue} queue` : "Quote updated");
      refreshAll();
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ---------------- Boot ---------------- */
  if (token) enterApp();
})();
