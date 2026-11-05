// ============================================================
// src/transfert-actions.js — GDS › Transferts : actions par ligne
//   1) Bouton d'état  (Marquer à faire / Vérifier la disponibilité / Valider)
//   2) Annuler
//   3) Télécharger « Bon de chargement VAN » (PDF)
// Chargé après app.js. Dépend (à l'exécution) de : isAdmin, AppAuth,
// _permCache, _decodePerm, addNotif, escHtml.
// Les appels passent par /api/* (même chemin en Officiel et en Training).
// ============================================================
(function () {
  "use strict";

  // ── Configuration ─────────────────────────────────────────
  const PERM_SECTION = "gds_transferts";

  const STATE_ACTIONS = {
    draft:     { kind: "confirm",  method: "action_confirm",  ctx: {},                          label: "Marquer à faire" },
    waiting:   { kind: "assign",   method: "action_assign",   ctx: { from_button: true },        label: "Vérifier la disponibilité" },
    confirmed: { kind: "assign",   method: "action_assign",   ctx: { from_button: true },        label: "Vérifier la disponibilité" },
    assigned:  { kind: "validate", method: "button_validate", ctx: { direct_validation: true },  label: "Valider" },
  };
  const CANCEL_STATES = ["draft", "waiting", "confirmed", "assigned", "partially_available"];
  const CANCEL_ACTION = { method: "action_cancel", ctx: { open_cancel_delivery_wizard: true } };

  const REPORT_NAME = "sig_stock.stock_loading_report";
  const REPORT_LANG = "fr";
  const SESSION_MSG = "Session expirée — reconnectez-vous puis réessayez";

  const STATE_LABEL = {
    draft:               { label: "Brouillon",  color: "#94a3b8" },
    waiting:             { label: "En attente", color: "#f59e0b" },
    confirmed:           { label: "Confirmé",   color: "#33c393" },
    assigned:            { label: "Prêt",       color: "#8b5cf6" },
    partially_available: { label: "Partiel",    color: "#f59e0b" },
    done:                { label: "Validé",     color: "#22c55e" },
    cancel:              { label: "Annulé",     color: "#ef4444" },
  };

  // ── Icônes SVG (stroke, 24x24) ────────────────────────────
  const SVG = (inner, cls) =>
    `<svg class="${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const ICON = {
    confirm:  SVG('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
    assign:   SVG('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/>'),
    validate: SVG('<polyline points="20 6 9 17 4 12"/>'),
    cancel:   SVG('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'),
    pdf:      SVG('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    spin:     SVG('<path d="M21 12a9 9 0 1 1-6.22-8.56"/>', "gds-tr-act-spin"),
  };

  // ── Permissions ───────────────────────────────────────────
  // admin → toujours. tr_state / tr_cancel : accordées explicitement (OFF par défaut).
  // tr_pdf_bc : rôle non configuré → autorisé, sinon doit figurer dans la liste.
  function can(perm) {
    if (typeof isAdmin === "function" && isAdmin()) return true;
    const role = (typeof AppAuth !== "undefined") && AppAuth.currentUser && AppAuth.currentUser.role;
    if (!role) return false;
    const list = (typeof _permCache !== "undefined" && _permCache)
      ? _decodePerm(_permCache[PERM_SECTION] && _permCache[PERM_SECTION][role])
      : undefined;
    if (perm === "tr_pdf_bc") return list === undefined || list.includes(perm);
    return list !== undefined && list.includes(perm);
  }

  // ── RPC ───────────────────────────────────────────────────
  async function callKw(model, method, args, kwargs) {
    let resp;
    try {
      resp = await fetch("/api/web/dataset/call_kw", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(),
          params: { model, method, args: args || [], kwargs: kwargs || {} } }),
      });
    } catch (_) { throw new Error("Connexion impossible"); }
    if (resp.status === 401 || resp.status === 403) throw new Error(SESSION_MSG);
    let j;
    try { j = await resp.json(); }
    catch (_) { throw new Error(resp.ok ? SESSION_MSG : "Erreur HTTP " + resp.status); }
    if (j && j.error) {
      const d = j.error.data || {};
      if (/session/i.test(d.name || "") || /session.?expired/i.test(d.message || "")) throw new Error(SESSION_MSG);
      throw new Error(d.message || j.error.message || "Erreur Odoo");
    }
    return j ? j.result : undefined;
  }

  async function readPicking(pid) {
    const r = await callKw("stock.picking", "read",
      [[pid], ["id", "name", "state", "partner_id"]], {});
    if (!r || !r[0]) throw new Error("Transfert introuvable");
    return r[0];
  }

  // ── Fenêtre de confirmation ───────────────────────────────
  // buttons: [{key,label,kind:'primary'|'danger'|'ghost'}] → Promise<key|null> (Échap / clic extérieur = null)
  function dialog({ title, message, buttons }) {
    return new Promise(resolve => {
      const ov = document.createElement("div");
      ov.style.cssText = "position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:12px;";
      const box = document.createElement("div");
      box.setAttribute("role", "dialog");
      box.style.cssText = "background:var(--bg2,#fff);color:var(--text,#0f172a);border:1px solid var(--border,#e2e8f0);border-radius:10px;width:100%;max-width:380px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);";
      const h = document.createElement("div");
      h.style.cssText = "font-weight:700;font-size:13px;margin-bottom:6px;";
      h.textContent = title;
      const p = document.createElement("div");
      p.style.cssText = "font-size:12px;color:var(--text2,#64748b);line-height:1.5;margin-bottom:12px;white-space:pre-line;";
      p.textContent = message;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;";
      const done = v => { document.removeEventListener("keydown", onKey, true); ov.remove(); resolve(v); };
      const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); done(null); } };
      buttons.forEach(b => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = b.label;
        const bg = b.kind === "danger" ? "#ef4444" : b.kind === "primary" ? "var(--accent,#33c393)" : "var(--bg3,#f1f5f9)";
        const fg = b.kind === "ghost" ? "var(--text,#0f172a)" : "#fff";
        btn.style.cssText = `padding:6px 12px;font-size:11px;font-weight:600;border:none;border-radius:6px;cursor:pointer;background:${bg};color:${fg};`;
        btn.addEventListener("click", () => done(b.key));
        row.appendChild(btn);
      });
      box.append(h, p, row);
      ov.appendChild(box);
      ov.addEventListener("click", e => { if (e.target === ov) done(null); });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(ov);
      const first = row.querySelector("button"); if (first) first.focus();
    });
  }

  // ── Assistants Odoo (wizards) renvoyés par une action ─────
  const ABORT = Symbol("abort");
  const isWindowAction = r => r && typeof r === "object" && r.type === "ir.actions.act_window" && r.res_model;

  async function runWizard(pid, name, act) {
    const model = act.res_model;
    const ctx = Object.assign({ active_model: "stock.picking", active_id: pid, active_ids: [pid] }, act.context || {});
    const make = async () => {
      const r = await callKw(model, "create", [{}], { context: ctx });
      return Array.isArray(r) ? r[0] : r;
    };

    if (model === "stock.backorder.confirmation") {
      const choice = await dialog({
        title: "Quantités incomplètes — " + name,
        message: "Certaines quantités ne sont pas complètes. Créer un reliquat pour le reste ?",
        buttons: [
          { key: "backorder",   label: "Créer un reliquat", kind: "primary" },
          { key: "nobackorder", label: "Pas de reliquat",   kind: "danger" },
          { key: "cancel",      label: "Annuler",           kind: "ghost" },
        ],
      });
      if (choice !== "backorder" && choice !== "nobackorder") return ABORT;
      const wid = await make();
      return callKw(model, choice === "backorder" ? "process" : "process_cancel_backorder", [[wid]], { context: ctx });
    }

    if (model === "stock.immediate.transfer") {
      const ok = await dialog({
        title: "Valider sans quantités saisies — " + name,
        message: "Aucune quantité n'a été saisie. Valider le transfert avec les quantités réservées ?",
        buttons: [
          { key: "ok",     label: "Valider",  kind: "primary" },
          { key: "cancel", label: "Annuler",  kind: "ghost" },
        ],
      });
      if (ok !== "ok") return ABORT;
      const wid = await make();
      return callKw(model, "process", [[wid]], { context: ctx });
    }

    throw new Error("Assistant Odoo « " + model + " » non pris en charge ici — utilisez ↗ pour ouvrir dans Odoo");
  }

  // Exécute une méthode de stock.picking puis enchaîne les assistants éventuels
  async function runPickingAction(pid, name, method, ctx) {
    let res = await callKw("stock.picking", method, [[pid]], { context: ctx });
    for (let i = 0; i < 4; i++) {
      if (!isWindowAction(res)) return { aborted: false };
      const out = await runWizard(pid, name, res);
      if (out === ABORT) return { aborted: true };
      res = out;
    }
    if (isWindowAction(res)) throw new Error("Assistant Odoo supplémentaire non pris en charge");
    return { aborted: false };
  }

  // ── Rendu des boutons ─────────────────────────────────────
  function btnHtml(act, pid, title, icon, kind) {
    const t = escHtml(title);
    return `<button type="button" class="gds-refresh-btn gds-tr-action-btn gds-tr-act-btn" data-tr-act="${act}" data-kind="${kind || ""}" data-pid="${pid}" title="${t}" aria-label="${t}">${icon}</button>`;
  }

  // Lien natif <a href download> — même principe que le bouton PDF des cartes « Bons de livraison » :
  // aucun JS dans le clic, le navigateur télécharge directement (pas d'appel RPC préalable, pas de Blob en mémoire).
  function pdfLinkHtml(pid, name, partner) {
    const t = escHtml("Télécharger Bon de chargement VAN (PDF)");
    // Préfixe de langue /fr/ inclus d'emblée : Odoo redirige sinon /report/... vers /fr/report/..., et cette
  // redirection est renvoyée au navigateur (qui ouvre le lien Odoo au lieu de télécharger). Sans redirection → téléchargement direct.
  const href = "/api/" + REPORT_LANG + "/report/pdf/" + REPORT_NAME + "/" + pid;
    return `<a class="gds-refresh-btn gds-tr-action-btn gds-tr-act-btn gds-tr-pdf-link" data-kind="pdf" data-tr-pdf="${pid}" href="${href}" download="${escHtml(pdfFileName(partner, name))}" rel="noopener" title="${t}" aria-label="${t}">${ICON.pdf}</a>`;
  }

  function buttonsInner(pid, state, name, partner) {
    let h = "";
    const sa = STATE_ACTIONS[state];
    if (sa && can("tr_state")) h += btnHtml("state", pid, sa.label, ICON[sa.kind], sa.kind);
    if (CANCEL_STATES.includes(state) && can("tr_cancel")) h += btnHtml("cancel", pid, "Annuler le transfert", ICON.cancel, "cancel");
    if (can("tr_pdf_bc")) h += pdfLinkHtml(pid, name, partner);
    return h;
  }

  // Utilisé par renderGdsTransferts (app.js) dans .gds-tr-action-cell
  function trActionsHtml(t) {
    return `<span class="gds-tr-act" data-pid="${t.id}">${buttonsInner(t.id, t.state, t.name, t.partner_id ? t.partner_id[1] : "")}</span>`;
  }

  function applyRow(tr, rec) {
    tr.dataset.trState = rec.state;
    if (rec.partner_id !== undefined) tr.dataset.trPartner = rec.partner_id ? rec.partner_id[1] : "";
    const st = STATE_LABEL[rec.state] || { label: rec.state, color: "#94a3b8" };
    const badge = tr.querySelector(".gds-tr-state");
    if (badge) { badge.textContent = st.label; badge.style.background = st.color + "20"; badge.style.color = st.color; }
    const box = tr.querySelector(".gds-tr-act");
    if (box) box.innerHTML = buttonsInner(Number(tr.dataset.trPid), rec.state, tr.dataset.trName || "", tr.dataset.trPartner || "");
  }

  // ── Verrouillage (anti double-clic) ───────────────────────
  const _busy = new Set();
  function lock(tr, group, clicked) {
    const key = tr.dataset.trPid + ":" + group;
    if (_busy.has(key)) return null;
    _busy.add(key);
    const sel = group === "pdf" ? '[data-tr-act="pdf"]' : '[data-tr-act="state"],[data-tr-act="cancel"]';
    const btns = [...tr.querySelectorAll(sel)];
    btns.forEach(b => { b.disabled = true; });
    const saved = clicked.innerHTML;
    clicked.innerHTML = ICON.spin;
    return () => {
      _busy.delete(key);
      // le bouton peut avoir été remplacé par applyRow : on ne restaure que s'il existe encore
      if (clicked.isConnected) { clicked.innerHTML = saved; }
      btns.forEach(b => { if (b.isConnected) b.disabled = false; });
    };
  }

  // ── Actions ───────────────────────────────────────────────
  async function doState(tr, btn) {
    if (!can("tr_state")) return;
    const pid = Number(tr.dataset.trPid), name = tr.dataset.trName || "";
    const sa = STATE_ACTIONS[tr.dataset.trState];
    if (!sa) return;
    const unlock = lock(tr, "act", btn); if (!unlock) return;
    try {
      const r = await runPickingAction(pid, name, sa.method, sa.ctx);
      if (r.aborted) { addNotif(name + " — opération annulée", "info"); return; }
      const rec = await readPicking(pid);
      if (sa.kind === "validate" && rec.state !== "done") {
        applyRow(tr, rec);
        throw new Error("Validation non effectuée (état actuel : " + ((STATE_LABEL[rec.state] || {}).label || rec.state) + ")");
      }
      applyRow(tr, rec);
      const lbl = (STATE_LABEL[rec.state] || {}).label || rec.state;
      if (sa.kind === "assign" && (rec.state === "waiting" || rec.state === "confirmed"))
        addNotif("✓ " + name + " — disponibilité vérifiée (état : " + lbl + ")", "warning");
      else
        addNotif("✓ " + name + " — " + (sa.kind === "validate" ? "validé" : sa.kind === "confirm" ? "marqué à faire" : "disponibilité vérifiée"), "success");
    } catch (e) {
      addNotif("⚠ " + name + " : " + e.message, "error");
    } finally { unlock(); }
  }

  async function doCancel(tr, btn) {
    if (!can("tr_cancel")) return;
    const pid = Number(tr.dataset.trPid), name = tr.dataset.trName || "";
    const ok = await dialog({
      title: "Annuler le transfert",
      message: "Annuler " + name + " ?\nCette action modifie les données dans Odoo.",
      buttons: [
        { key: "yes", label: "Annuler le transfert", kind: "danger" },
        { key: "no",  label: "Retour",               kind: "ghost" },
      ],
    });
    if (ok !== "yes") return;
    const unlock = lock(tr, "act", btn); if (!unlock) return;
    try {
      const r = await runPickingAction(pid, name, CANCEL_ACTION.method, CANCEL_ACTION.ctx);
      if (r.aborted) { addNotif(name + " — annulation abandonnée", "info"); return; }
      const rec = await readPicking(pid);
      applyRow(tr, rec);
      if (rec.state !== "cancel") throw new Error("Annulation non effectuée (état actuel : " + ((STATE_LABEL[rec.state] || {}).label || rec.state) + ")");
      addNotif("✓ " + name + " — annulé", "success");
    } catch (e) {
      addNotif("⚠ " + name + " : " + e.message, "error");
    } finally { unlock(); }
  }

  // Nom de fichier : retire les caractères interdits (Windows / Android / iOS)
  function fileBase(s) {
    return String(s || "")
      .replace(/[\u0000-\u001f]+/g, "")
      .replace(/\s*[\\/:*?"<>|]+\s*/g, "-")
      .replace(/\s+/g, " ")
      .trim().replace(/^[.\s-]+|[.\s]+$/g, "")
      .slice(0, 80);
  }
  function pdfFileName(partner, name) {
    const parts = ["Bon de Chargement"];
    const p = fileBase(partner), n = fileBase(name);
    if (p) parts.push(p);
    if (n) parts.push(n);
    return parts.join(" - ") + ".pdf";
  }

  // ── Délégation d'événements (survit au re-rendu d'une ligne) ──
  document.addEventListener("click", e => {
    const btn = e.target.closest && e.target.closest("[data-tr-act]");
    if (!btn || btn.disabled) return;
    const tr = btn.closest("tr[data-tr-pid]");
    if (!tr) return;
    e.preventDefault(); e.stopPropagation();
    const act = btn.dataset.trAct;
    if (act === "state") doState(tr, btn);
    else if (act === "cancel") doCancel(tr, btn);
  });

  // Lien PDF : on laisse le navigateur télécharger (pas de preventDefault), on affiche seulement une info.
  document.addEventListener("click", e => {
    const a = e.target.closest && e.target.closest("a[data-tr-pdf]");
    if (!a) return;
    e.stopPropagation();   // empêche d'éventuels handlers de ligne d'intercepter le clic
    if (typeof addNotif === "function") {
      const tr = a.closest("tr[data-tr-pid]");
      addNotif("⏳ " + (tr ? tr.dataset.trName : "") + " — Bon de chargement : téléchargement lancé (la génération peut prendre quelques secondes)", "info");
    }
  }, true);

  // ── Styles ────────────────────────────────────────────────
  const css = document.createElement("style");
  css.id = "trActionsStyle";
  css.textContent = `
    .gds-tr-act { display:inline-flex; gap:4px; align-items:center; }
    .gds-tr-table .gds-tr-act-btn { padding:3px 6px; line-height:0; justify-content:center;
      background:var(--bg3); color:var(--text2); }
    a.gds-tr-pdf-link { display:inline-flex; align-items:center; text-decoration:none; cursor:pointer; }
    .gds-tr-act-btn svg { width:13px; height:13px; display:block; }
    .gds-tr-table .gds-tr-act-btn[data-kind="validate"] { color:#22c55e; }
    .gds-tr-table .gds-tr-act-btn[data-kind="confirm"],
    .gds-tr-table .gds-tr-act-btn[data-kind="assign"]   { color:#3b82f6; }
    .gds-tr-table .gds-tr-act-btn[data-kind="cancel"]   { color:#ef4444; }
    .gds-tr-act-btn:disabled { opacity:.6; cursor:wait; }
    .gds-tr-act-spin { animation:gdsTrSpin .8s linear infinite; }
    @keyframes gdsTrSpin { to { transform:rotate(360deg); } }
    @media (max-width:600px) {
      .gds-tr-table .gds-tr-action-cell { flex-direction:row; flex-wrap:wrap; gap:2px; max-width:100px; }
      .gds-tr-act { display:contents; }
      .gds-tr-table .gds-tr-act-btn { padding:3px 4px; }
    }`;
  document.head.appendChild(css);

  // ── API publique ──────────────────────────────────────────
  window.trActionsHtml = trActionsHtml;
  window.TrActions = { can, pdfFileName, buttonsInner };
})();
