// ============================================================
// src/transfert-actions.js — GDS › Transferts : actions par ligne
//   1) Bouton d'état  (Marquer à faire / Vérifier la disponibilité / Valider)
//   2) Annuler
//   3) Télécharger « Bon de chargement VAN » (PDF, version Odoo)
//   4) Imprimer « Bon de chargement GDS » (version courte de l'app) + commutateur GDS / Odoo
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
    printer:  SVG('<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
  };

  // ── Permissions ───────────────────────────────────────────
  // admin → toujours. tr_state / tr_cancel : accordées explicitement (OFF par défaut).
  // tr_pdf_bc / tr_pdf_gds : rôle non configuré → autorisé, sinon doit figurer dans la liste.
  // tr_print_switch : jamais implicite (admin ou accordée explicitement).
  function can(perm) {
    if (typeof isAdmin === "function" && isAdmin()) return true;
    const role = (typeof AppAuth !== "undefined") && AppAuth.currentUser && AppAuth.currentUser.role;
    if (!role) return false;
    const list = (typeof _permCache !== "undefined" && _permCache)
      ? _decodePerm(_permCache[PERM_SECTION] && _permCache[PERM_SECTION][role])
      : undefined;
    if (perm === "tr_pdf_bc" || perm === "tr_pdf_gds") return list === undefined || list.includes(perm);
    return list !== undefined && list.includes(perm);
  }

  // ── Mode d'impression (GDS / Odoo) ────────────────────────
  // Défaut partagé : nœud Firebase indépendant `print_mode_default` ("gds" | "odoo"), hors settings.json
  // (celui-ci est réécrit par un PUT à champs fixes). Choix personnel : localStorage, par utilisateur.
  const FB_MODE_KEY = "print_mode_default";
  const LS_MODE_PREFIX = "gds_tr_print_mode:";
  const normMode = v => (v === "gds" || v === "odoo") ? v : null;
  let _defaultMode = "gds", _defaultAt = 0;

  async function loadDefaultMode(force) {
    if (!force && Date.now() - _defaultAt < 30000) return _defaultMode;
    try {
      const r = await fetch(`${_FB_DB_URL}/${FB_MODE_KEY}.json`, { cache: "no-store" });
      if (r.ok) _defaultMode = normMode(await r.json()) || "gds";
    } catch (_) { /* hors-ligne : on garde la dernière valeur connue */ }
    _defaultAt = Date.now();
    return _defaultMode;
  }
  async function saveDefaultMode(m) {
    if (!(typeof isAdmin === "function" && isAdmin())) return;
    m = normMode(m); if (!m) return;
    try {
      const r = await fetch(`${_FB_DB_URL}/${FB_MODE_KEY}.json`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(m),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      _defaultMode = m; _defaultAt = Date.now();
      refreshAllRows(); syncSwitch();
      if (typeof addNotif === "function") addNotif("Mode d'impression par défaut : " + (m === "gds" ? "App" : "Odoo"), "success");
    } catch (e) {
      if (typeof addNotif === "function") addNotif("Mode d'impression par défaut non enregistré : " + e.message, "error");
      const sel = document.getElementById("printModeDefault"); if (sel) sel.value = _defaultMode;
    }
  }
  const lsKey = () => LS_MODE_PREFIX + ((typeof AppAuth !== "undefined" && AppAuth.currentUser && AppAuth.currentUser.username) || "_");
  function getUserChoice() { try { return normMode(localStorage.getItem(lsKey())); } catch (_) { return null; } }
  function setUserChoice(m) { try { localStorage.setItem(lsKey(), m); } catch (_) {} }

  // Résolution : quels boutons / quel mode pour l'utilisateur courant
  function printState() {
    const g = can("tr_pdf_gds"), o = can("tr_pdf_bc");
    const sw = g && o && can("tr_print_switch");
    let mode = null;
    if (g && o) mode = (sw && getUserChoice()) || _defaultMode;
    else if (g) mode = "gds";
    else if (o) mode = "odoo";
    return { g, o, sw, mode };
  }

  function switchHtml() {
    const ps = printState();
    if (!ps.sw) return "";
    const b = (m, label, icon, tip) => {
      const t = escHtml(tip);
      return `<button type="button" class="gds-tr-modesw-btn${ps.mode === m ? " is-active" : ""}" data-mode="${m}" aria-pressed="${ps.mode === m}" title="${t}" aria-label="${t}" onclick="TrActions.setMode('${m}')">${icon}<span>${label}</span></button>`;
    };
    return `<span class="gds-tr-filter-label" style="margin-left:12px">Impression</span>
      <div class="gds-tr-modesw" id="gdsTrModeSw" role="group" aria-label="Mode d'impression">
        ${b("gds", "App", ICON.printer, "Bon de chargement App (version courte de l'application)")}
        ${b("odoo", "Odoo", ICON.pdf, "Bon de chargement Odoo (PDF du rapport Odoo)")}
      </div>`;
  }
  function syncSwitch() {
    const ps = printState();
    document.querySelectorAll("#gdsTrModeSw .gds-tr-modesw-btn").forEach(btn => {
      const on = btn.dataset.mode === ps.mode;
      btn.classList.toggle("is-active", on); btn.setAttribute("aria-pressed", String(on));
    });
  }
  // Redessine seulement les boutons d'action de chaque ligne (pas de rechargement du tableau, filtres conservés)
  function refreshAllRows() {
    document.querySelectorAll("#gdsTransfertsContent tr[data-tr-pid]").forEach(tr => {
      const box = tr.querySelector(".gds-tr-act"); if (!box) return;
      box.innerHTML = buttonsInner(Number(tr.dataset.trPid), tr.dataset.trState, tr.dataset.trName || "", tr.dataset.trPartner || "");
    });
  }
  function setMode(m) {
    m = normMode(m);
    if (!m || !printState().sw) return;
    setUserChoice(m);
    syncSwitch(); refreshAllRows();
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

  // Bouton GDS (version courte de l'app) : génère le PDF côté navigateur via gdsTrPrintGds
  function gdsBtnHtml(pid) {
    const t = escHtml("Imprimer Bon de chargement GDS (PDF)");
    return `<button type="button" class="gds-refresh-btn gds-tr-action-btn gds-tr-act-btn" data-tr-act="pdfgds" data-kind="gds" data-pid="${pid}" title="${t}" aria-label="${t}">${ICON.printer}</button>`;
  }

  function buttonsInner(pid, state, name, partner) {
    let h = "";
    const sa = STATE_ACTIONS[state];
    if (sa && can("tr_state")) h += btnHtml("state", pid, sa.label, ICON[sa.kind], sa.kind);
    if (CANCEL_STATES.includes(state) && can("tr_cancel")) h += btnHtml("cancel", pid, "Annuler le transfert", ICON.cancel, "cancel");
    const mode = printState().mode;
    if (mode === "gds") h += gdsBtnHtml(pid);
    else if (mode === "odoo") h += pdfLinkHtml(pid, name, partner);
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
    const sel = group === "pdfgds" ? '[data-tr-act="pdfgds"]' : group === "pdf" ? '[data-tr-act="pdf"]' : '[data-tr-act="state"],[data-tr-act="cancel"]';
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

  // ── Impression « Bon de chargement GDS » (version courte) ──
  // Indépendante de la préparation : tout est lu dans Odoo au clic.
  // Gabarit HTML propre à ce module ;
  // le rendu PDF passe par _downloadAsPdf (html2canvas + jsPDF) avec les mêmes App.settings.
  async function gdsTrPrintGds(pickingId) {
    if (typeof _downloadAsPdf !== "function") throw new Error("Module PDF indisponible — rechargez la page");
    pickingId = Number(pickingId);
    if (!pickingId) throw new Error("Transfert invalide");

    const pk = await callKw("stock.picking", "read",
      [[pickingId], ["id", "name", "partner_id", "location_id", "location_dest_id", "date_done", "scheduled_date"]], {});
    if (!pk || !pk[0]) throw new Error("Transfert introuvable");
    const p = pk[0];

    const mls = await callKw("stock.move.line", "search_read",
      [[["picking_id", "=", pickingId]]], { fields: ["product_id", "qty_done"], limit: 5000 });
    const qtyByPid = {}, order = [];
    (mls || []).forEach(m => {
      const id = m.product_id && m.product_id[0], q = Number(m.qty_done) || 0;
      if (!id || q <= 0) return;
      if (!(id in qtyByPid)) { qtyByPid[id] = 0; order.push(id); }
      qtyByPid[id] += q;
    });
    if (!order.length) throw new Error("Aucune quantité validée dans ce transfert");

    const [prods, pkgs] = await Promise.all([
      callKw("product.product", "search_read", [[["id", "in", order]]],
        { fields: ["id", "name", "default_code", "categ_id"], limit: 5000, context: { active_test: false } }),
      callKw("product.packaging", "search_read", [[["product_id", "in", order]]],
        { fields: ["product_id", "qty"], limit: 5000 }),
    ]);
    const prodMap = {}, unitMap = {};
    (prods || []).forEach(x => { prodMap[x.id] = x; });
    (pkgs || []).forEach(x => { const id = x.product_id && x.product_id[0]; if (id) unitMap[id] = x.qty; });

    // Même nom que les autres sections : nom perso > dictionnaire d'abréviations > nom Odoo ; sans [REF]
    const items = order.map(id => {
      const pr = prodMap[id];
      const raw = pr
        ? (typeof _productDisplayName === "function" ? _productDisplayName(pr, { short: true }) : pr.name)
        : "pid:" + id;
      return {
        name: String(raw || "pid:" + id).replace(/^\[.*?\]\s*/, ""),
        categ: (pr && pr.categ_id && pr.categ_id[1]) || "Autre",
        qty: qtyByPid[id],
        unit: unitMap[id] > 0 ? Math.round(unitMap[id]) : 0,
      };
    });
    const catOrder = (typeof App !== "undefined" && App.settings && App.settings.categoryOrder) || [];
    const rank = c => { const i = catOrder.indexOf(c); return i === -1 ? 9999 : i; };
    items.sort((a, b) => rank(a.categ) - rank(b.categ));   // tri stable : l'ordre d'origine est conservé dans la catégorie

    const S = (typeof App !== "undefined" && App.settings) || {};
    const fProd = S.pdfFontProduct ?? 10, fQty = S.pdfFontQty ?? 13;
    const showTotal = S.showTotalU !== false;
    const cols = S.pdfColumns ?? 2, rowPad = S.pdfRowPadding ?? 1;

    const rows = items.map((it, idx) => {
      const carton = it.unit > 0 ? Math.floor(it.qty / it.unit) : "—";
      const unite = it.unit > 0 ? Math.round(it.qty % it.unit) : Math.round(it.qty);
      return `<tr>
      <td style="text-align:center;color:#888">${idx + 1}</td>
      <td style="font-size:${fProd}px;">${escHtml(it.name)}</td>
      <td style="text-align:center;font-size:${fQty}px;font-weight:700;">${carton}</td>
      <td style="text-align:center;font-size:${fQty}px;font-weight:700;">${unite}</td>
      ${showTotal ? `<td style="text-align:center;font-size:${fQty}px;font-weight:700;">${Math.round(it.qty)}</td>` : ""}
    </tr>`;
    }).join("");

    const partner = (p.partner_id && p.partner_id[1]) || "—";
    const ref = p.name || "—";
    const stockId = (typeof _getStockLocationId === "function") ? Number(_getStockLocationId()) : null;
    // Van = destination ; si la destination est le stock (retour), on prend la source
    const vanLoc = (p.location_dest_id && stockId && p.location_dest_id[0] === stockId && p.location_id) ? p.location_id : p.location_dest_id;
    const van = ((vanLoc && vanLoc[1]) || "").split("/").pop().trim() || "—";
    const rawDate = p.date_done || p.scheduled_date;
    const d0 = rawDate ? new Date(String(rawDate).replace(" ", "T") + "Z") : null;   // Odoo stocke en UTC
    const dateStr = d0 && !isNaN(d0) ? d0.toLocaleString("fr-FR") : "—";

    const now = new Date();
    const dd = String(now.getDate()).padStart(2, "0"), mm = String(now.getMonth() + 1).padStart(2, "0"), yyyy = now.getFullYear();
    const refNum = (ref.split("/").pop() || ref).trim();
    const fileName = `${partner.replace(/[\\/:*?"<>|]+/g, "-")} (${dd}-${mm}-${yyyy}) REF${refNum}`;

    const tableBlock = `
    <table>
      <thead><tr>
        <th style="text-align:center;width:20px">#</th>
        <th>Produit</th>
        <th style="text-align:center;width:40px">Colis</th>
        <th style="text-align:center;width:40px">U</th>
        ${showTotal ? '<th style="text-align:center;width:45px">Total U</th>' : ""}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
    const infoBlock = `
    <h2>Chargement GDS</h2>
    <div class="info">
      <div><b>Contact :</b> ${escHtml(partner)}</div>
      <div><b>Van :</b> ${escHtml(van)}</div>
      <div><b>Référence :</b> ${escHtml(ref)}</div>
      <div><b>Date :</b> ${escHtml(dateStr)}</div>
    </div>`;
    const wrapperHtml = cols === 1
      ? `<div class="wrapper single">${infoBlock}${tableBlock}</div>`
      : `<div class="wrapper"><div class="col">${infoBlock}${tableBlock}</div><div class="col">${infoBlock}${tableBlock}</div></div>`;

    const html = `<html><head><meta charset="utf-8">
  <style>
    @page { size: A4 portrait; margin: 7mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 9.5px; margin: 0; padding: 0; color: #111; word-spacing: 1px; }
    h2 { font-size: 14px; color: #1a6b3a; margin: 0 0 4px; font-weight: 700; }
    .info { display: flex; flex-wrap: wrap; gap: 2px 12px; margin-bottom: 6px; font-size: 11px; color: #444; }
    .info div { white-space: nowrap; }
    .info b { color: #111; font-weight: 700; }
    .wrapper { display: flex; gap: 0; align-items: flex-start; width: 100%; }
    .wrapper.single { display: block; }
    .col { width: 50%; padding: 0 3mm; }
    .col:first-child { padding-left: 0; border-right: 1.5px dashed #bbb; }
    .col:last-child  { padding-right: 0; }
    table { border-collapse: collapse; width: 100%; table-layout: fixed; }
    thead { display: table-header-group; }
    th { background: #1a6b3a; color: #fff; padding: 4px 4px; text-align: left; font-size: 9px; font-weight: 700; border: 1px solid #1a6b3a; }
    td { padding: ${rowPad}px 4px; border: 1px solid #d0d0d0; font-size: 9px; white-space: normal; word-break: normal; overflow-wrap: break-word; line-height: 1.2; }
    tr:nth-child(even) td:not(.cat-row td) { background: #f0f7f3; }
    tr:nth-child(odd)  td { background: #fff; }
  </style></head><body>
  ${wrapperHtml}
  </body></html>`;

    _downloadAsPdf(html, fileName);
  }

  async function doPrintGds(tr, btn) {
    if (!can("tr_pdf_gds")) return;
    const pid = Number(tr.dataset.trPid), name = tr.dataset.trName || "";
    const unlock = lock(tr, "pdfgds", btn); if (!unlock) return;
    let hold = 0;
    try {
      await gdsTrPrintGds(pid);
      hold = 2500;   // _downloadAsPdf est asynchrone et ne renvoie rien : on garde le verrou le temps du rendu
    } catch (e) {
      addNotif("⚠ " + name + " : " + (e && e.message ? e.message : "Impression GDS impossible"), "error");
    } finally { hold ? setTimeout(unlock, hold) : unlock(); }
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
    else if (act === "pdfgds") doPrintGds(tr, btn);
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
    .gds-tr-table .gds-tr-act-btn[data-kind="gds"]      { color:#33c393; }
    .gds-tr-modesw { display:inline-flex; border:1px solid var(--border); border-radius:8px; overflow:hidden; }
    .gds-tr-modesw-btn { display:inline-flex; align-items:center; gap:4px; font-size:10px; font-weight:600;
      padding:3px 9px; border:none; background:var(--bg3); color:var(--text2); cursor:pointer; }
    .gds-tr-modesw-btn + .gds-tr-modesw-btn { border-left:1px solid var(--border); }
    .gds-tr-modesw-btn svg { width:11px; height:11px; display:block; }
    .gds-tr-modesw-btn.is-active { background:var(--accent,#33c393); color:#fff; font-weight:700; }
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
  window.gdsTrPrintGds = gdsTrPrintGds;
  window.TrActions = { can, pdfFileName, buttonsInner, switchHtml, setMode, loadDefaultMode, saveDefaultMode, printState };

  // ── Réglage partagé « Mode d'impression par défaut » (modalChargement, admin) ──
  function initDefaultSelect() {
    const sel = document.getElementById("printModeDefault");
    if (!sel) return;
    if (!sel.dataset.bound) { sel.dataset.bound = "1"; sel.addEventListener("change", () => saveDefaultMode(sel.value)); }
    loadDefaultMode(true).then(v => { sel.value = v; });
  }
  document.addEventListener("click", e => {
    const c = e.target.closest && e.target.closest('.settings-card[onclick*="modalChargement"]');
    if (c) initDefaultSelect();
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initDefaultSelect);
  else initDefaultSelect();
})();
