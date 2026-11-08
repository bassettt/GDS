// ============================================================
// src/preparation.js — Preparation v2 (PHASE 1: saisie only)
// ------------------------------------------------------------
// Standalone module. Provides the global renderGdsPreparation() used by
// the Préparation tab (gdsShowTab in app.js).
//
// Firebase node:  wafa_gds_prep2_{warehouseId}
//   meta  : { mode: "odoo"|"libre", modeBy, modeTs }
//   meta/view : { mode: "smart"|"all"|"prepared"|"free" (absent = smart), base: "smart"|"all"|"prepared" (free only),
//                 hidden: { "<pid>": true }, shown: { "<pid>": true } (free only), by, ts }   — product visibility, shared per warehouse
//   items : { "<pid>": { c: cartons, u: units, ts: serverTs, by: username } }
//   meta/charge (phase 2, written by preparation-charge.js):
//     { from, to, by, ts, excluded: { "<pickingId>": true }, ood: { "<pickingId>": { ref, sd } } }   (bon included unless excluded)
//   meta/session (phase 3, « Terminer » / « Nouvelle préparation »):
//     { active: true|false, by, ts }   shared by all users. Node absent = active (existing warehouses keep working).
//     Terminer (after the report is generated) wipes items + meta/charge and sets active=false in ONE atomic multi-path PATCH on the
//     warehouse root; meta/mode and meta/view are never touched. active=false → every client shows the empty state.
//     Nouvelle préparation: active=true + meta/charge/from = now, to = same day 23:59:59 (+ items wiped again, defensive), also ONE atomic PATCH.
//
// Out of scope (phase 2+): Chargement, Reste, print/PDF/XLSX, history,
// finish/cancel.  See the "EXTENSION POINT" markers + GdsPrep2.ext / .on().
// ============================================================
(function () {
  "use strict";

  const DEBOUNCE = 500;                // ms, per edited field
  const MAX_VAL  = 999999;
  const CATALOG_TTL = 10 * 60 * 1000;  // re-fetch Odoo catalogue after 10 min

  // ── state ──────────────────────────────────────────────────
  const S = {
    wh: null, root: null, built: false, rendering: null,
    raw: [], size: {}, catalogAt: 0,        // Odoo catalogue
    stock: {}, stockLoaded: false, stockErr: null,
    items: {}, meta: { mode: "odoo" },       // shared Firebase state
    rows: {}, cats: {},                      // DOM refs
    timers: {}, inflight: 0, saveErr: false, // autosave
    errs: {},                                // invalid (over-stock) fields
    collapsed: {}, hiddenCats: {}, search: "", searchAll: false,
    draft: null, vis: {}, visPending: false, vq: "",   // product visibility: unsaved draft / per-row state / pending re-apply / hidden-list query
    es: null, esRetry: null, connected: false, firstPut: null,
    io: null,
    sess: null, wiping: false, starting: false,   // session: last painted active flag / Terminer wipe in progress / Nouvelle préparation in progress
  };

  // ── tiny helpers ───────────────────────────────────────────
  const esc = (s) => (typeof escHtml === "function" ? escHtml(String(s ?? "")) :
    String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const fmt  = (n) => Number(n || 0).toLocaleString("fr-FR");
  const AR_DIGITS = { "٠":0,"١":1,"٢":2,"٣":3,"٤":4,"٥":5,"٦":6,"٧":7,"٨":8,"٩":9,"۰":0,"۱":1,"۲":2,"۳":3,"۴":4,"۵":5,"۶":6,"۷":7,"۸":8,"۹":9 };
  const cleanDigits = (s) => String(s).replace(/[٠-٩۰-۹]/g, d => AR_DIGITS[d]).replace(/\D/g, "");
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
  const whId  = () => _getWarehouseId() || "default";
  // Training : nœud Firebase séparé (wafa_gds_prep2_training_{wh}) pour ne pas polluer Officiel
const envPart = () => (typeof App !== "undefined" && App.env === "training" ? "training_" : "");
  const base  = () => `${_FB_DB_URL}/wafa_gds_prep2_${envPart()}${S.wh}`;
  const userName = () => AppAuth.currentUser?.displayName || AppAuth.currentUser?.username || "inconnu";
  const notify = (m, t) => { try { if (typeof addNotif === "function") addNotif(m, t); else console.warn(m); } catch (_) {} };

  // ── inline SVG icons (no emoji / text symbols in the UI) ───
  const ICONS = {
    truck:   '<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    chevron: '<polyline points="6 9 12 15 18 9"/>',
    check:   '<polyline points="20 6 9 17 4 12"/>',
    flag:    '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
    x:       '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    warn:    '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    xcircle: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
    clock:   '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    plus:    '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    expand:  '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
    collapse:'<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>',
    calendar:'<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    list:    '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    clipboard:'<rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
    filedown:'<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/>',
    eye:     '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff:  '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
  };
  const ic = (name, cls) => `<svg class="gp2-ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;

  // ── permissions ────────────────────────────────────────────
  function permList() {
    const role = AppAuth.currentUser?.role;
    if (!role || typeof _permCache === "undefined" || !_permCache) return undefined;
    return _decodePerm(_permCache["gds_preparation"]?.[role]);
  }
  // Saisie: admin, or role holding prep_modifier (unconfigured role → allowed)
  function canEnter() {
    if (isAdmin()) return true;
    const l = permList();
    return l === undefined || l.includes("prep_modifier");
  }
  // Mode switch: admin only, unless prep_mode explicitly granted to the role
  function canSwitchMode() {
    if (isAdmin()) return true;
    const l = permList();
    return l !== undefined && l.includes("prep_mode");
  }
  // Product visibility (hide / show): admin, or role explicitly granted prep_visibility (others only see the result)
  function canView() {
    if (isAdmin()) return true;
    const l = permList();
    return l !== undefined && l.includes("prep_visibility");
  }

  // generic permission check (admin, or unconfigured role, or role holding the permission)
  function canDo(perm) { if (isAdmin()) return true; const l = permList(); return l === undefined || l.includes(perm); }

  // ── Odoo ───────────────────────────────────────────────────
  async function rpc(model, method, args, kwargs) {
    const r = await fetch("/api/web/dataset/call_kw", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(), params: { model, method, args, kwargs } }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error?.data?.message || j.error?.message || "Erreur Odoo");
    return j.result || [];
  }

  async function loadCatalog() {
    // active products, services excluded (works for Odoo 13→18: `type` values differ but 'service' is stable)
    const prods = await rpc("product.product", "search_read",
      [[["active", "=", true], ["type", "!=", "service"]]],
      { fields: ["id", "name", "default_code", "categ_id"], limit: 5000 });
    const pids = prods.map(p => p.id);
    const size = {};
    if (pids.length) {
      const pk = await rpc("product.packaging", "search_read",
        [[["product_id", "in", pids]]], { fields: ["product_id", "qty"], limit: 20000 });
      pk.forEach(x => { if (x.product_id && x.qty > 0) size[x.product_id[0]] = Math.round(x.qty); }); // last wins
    }
    S.raw = prods; S.size = size; S.catalogAt = Date.now();
  }

  async function loadStock() {
    S.stockErr = null;
    try {
      const loc = _getStockLocationId();
      if (!loc) throw new Error("Emplacement stock introuvable");
      const q = await rpc("stock.quant", "search_read",
        [[["location_id", "=", loc], ["quantity", ">", 0]]], { fields: ["product_id", "quantity"], limit: 20000 });
      const m = {};
      q.forEach(x => { const id = x.product_id[0]; m[id] = (m[id] || 0) + x.quantity; });
      S.stock = m; S.stockLoaded = true;
    } catch (e) { S.stockErr = e.message || "Erreur stock"; S.stockLoaded = false; }
  }

  // ── Firebase (REST + SSE) ──────────────────────────────────
  async function fbPatch(path, body) {
    const r = await fetch(`${base()}${path}.json`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("HTTP " + r.status);
  }

  function setDeep(obj, keys, data) {     // set / delete (data == null) a nested key, creating parents on demand
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (obj[k] == null || typeof obj[k] !== "object") { if (data == null) return; obj[k] = {}; }
      obj = obj[k];
    }
    const last = keys[keys.length - 1];
    if (data == null) delete obj[last]; else obj[last] = data;
  }

  function setAt(path, data) {            // returns changed key: pid | "all" | "meta" | null
    const p = path.split("/").filter(Boolean);
    if (!p.length) { S.items = (data && data.items) || {}; S.meta = Object.assign({ mode: "odoo" }, (data && data.meta) || {}); return "all"; }
    if (p[0] === "items") {
      if (p.length === 1) { S.items = data || {}; return "all"; }
      const pid = p[1];
      if (p.length === 2) { if (data == null) delete S.items[pid]; else S.items[pid] = data; return pid; }
      const it = S.items[pid] || (S.items[pid] = {});
      if (data == null) delete it[p[2]]; else it[p[2]] = data;
      return pid;
    }
    if (p[0] === "meta") {
      if (p.length === 1) S.meta = Object.assign({ mode: "odoo" }, data || {});
      else { setDeep(S.meta, p.slice(1), data); if (!S.meta.mode) S.meta.mode = "odoo"; }
      return p[1] === "charge" ? "charge" : p[1] === "view" ? "view" : p[1] === "session" ? "session" : "meta";   // "charge" → handled by preparation-charge.js via on("remote")
    }
    return null;
  }

  function onStream(kind, e) {
    let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (!msg) return;
    const changed = new Set();
    if (kind === "put") {
      const c = setAt(msg.path || "/", msg.data); if (c) changed.add(c);
    } else {
      const pre = (msg.path === "/" ? "" : msg.path || "");
      Object.keys(msg.data || {}).forEach(k => { const c = setAt(`${pre}/${k}`, msg.data[k]); if (c) changed.add(c); });
    }
    if (msg.path === "/" && S.firstPut) { S.firstPut(); S.firstPut = null; }
    if (S.built) applyChanges(changed);
  }

  function connect() {
    disconnect();
    if (typeof EventSource === "undefined") return;
    const es = new EventSource(`${base()}.json`);
    S.es = es;
    es.addEventListener("put",   (e) => onStream("put", e));
    es.addEventListener("patch", (e) => onStream("patch", e));
    es.addEventListener("cancel",       () => reconnectLater());
    es.addEventListener("auth_revoked", () => reconnectLater());
    es.onopen  = () => { S.connected = true;  paintConn(); };
    es.onerror = () => { S.connected = false; paintConn(); if (es.readyState === 2) reconnectLater(); };
  }
  function reconnectLater() { disconnect(); clearTimeout(S.esRetry); S.esRetry = setTimeout(() => { if (S.root && isVisible()) connect(); }, 3000); }
  function disconnect() {
    clearTimeout(S.esRetry);
    if (S.es) { try { S.es.close(); } catch (_) {} S.es = null; }
    S.connected = false; paintConn();
  }
  const isVisible = () => !!(S.root && S.root.offsetParent !== null);

  async function firstLoad() {           // wait for the initial "put /" (or GET fallback)
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      S.firstPut = fin;
      connect();
      setTimeout(async () => {
        if (done) return;
        try { const r = await fetch(`${base()}.json`); setAt("/", await r.json()); } catch (_) {}
        fin();
      }, 6000);
    });
  }

  // ── model ──────────────────────────────────────────────────
  const item  = (pid) => S.items[pid] || {};
  const getC  = (pid) => +item(pid).c || 0;
  const getU  = (pid) => +item(pid).u || 0;
  const sizeOf = (pid) => S.size[pid] || 0;
  const totalOf = (pid) => sizeOf(pid) * getC(pid) + getU(pid);
  const mode  = () => (S.meta.mode === "libre" ? "libre" : "odoo");
  const stockOf = (pid) => S.stock[pid] || 0;
  const stockActive = () => mode() === "odoo" && S.stockLoaded;   // validation applies
  const overStock = (pid, total) => stockActive() && total > stockOf(pid) + 1e-6;

  // catalogue grouped by category: UI category order (_sortCats) then product order — shared with the initial-stock export
  function catalogModel() {
    const byCat = {};
    S.raw.forEach(p => {
      const cat = p.categ_id ? p.categ_id[1] : "Autre";
      (byCat[cat] || (byCat[cat] = [])).push({
        pid: p.id, code: p.default_code || "",
        name: _productDisplayName(p, { short: true }),   // affichage : dictionnaire > Odoo
        full: _productOdooName(p),                                         // nom d'origine : la recherche couvre les deux
        order: _productCustomOrder(String(p.id)),
      });
    });
    Object.values(byCat).forEach(a => a.sort((x, y) => x.order - y.order || x.name.localeCompare(y.name)));
    return _sortCats(Object.keys(byCat)).map(cat => ({ cat, list: byCat[cat] }));
  }
  function buildModel() {
    const model = catalogModel();
    ext.model.forEach(fn => { try { fn(model); } catch (e) { console.error(e); } });   // phase 2: extra categories (Chargé sans préparation)
    return model;
  }

  // ── UI ─────────────────────────────────────────────────────
  function stockLabel(pid) {
    const st = stockOf(pid), sz = sizeOf(pid);
    if (sz > 0 && st >= sz) return `${fmt(Math.floor(st / sz))} C · ${fmt(Math.round(st % sz))} U`;
    return `${fmt(Math.round(st * 100) / 100)} U`;
  }

  function rowHtml(m) {
    const sz = sizeOf(m.pid), ro = !canEnter();
    const inp = (f, ph, dis) => `<input class="gp2-in" data-pid="${m.pid}" data-f="${f}" type="text" inputmode="numeric" pattern="[0-9]*"
      enterkeyhint="next" autocomplete="off" placeholder="${ph}" ${ro || dis ? "readonly" : ""} ${dis ? "tabindex=\"-1\"" : ""}>`;
    const cell = (k) => `<div class="gp2-ro gp2-dim" data-k="${k}">0</div>`;
    return `<div class="gp2-row${sz ? "" : " gp2-nosize"}" data-pid="${m.pid}" data-s="${esc(norm(m.name + " " + (m.full || "") + " " + m.code))}" data-nm="${esc(m.name)}">
      <div class="gp2-name gp2-nmcol"><button type="button" class="gp2-truck" data-act="truck" data-pid="${m.pid}" title="Détail chargement" aria-label="Détail chargement" disabled>${ic("truck")}</button><button type="button" class="gp2-truck gp2-hist" data-act="hist" data-pid="${m.pid}" title="Historique des modifications" aria-label="Historique des modifications" disabled>${ic("clock")}</button><button type="button" class="gp2-eye" data-act="roweye" aria-label="Masquer / afficher"></button><span class="gp2-nm" data-act="nmcard">${esc(m.name)}</span>
        <span class="gp2-sub"><span class="gp2-who"></span><span class="gp2-sz">${sz ? `×${sz}` : ""}</span><span class="gp2-stock"></span></span></div>
      <div class="gp2-g gp2-g-prep">
        <label class="gp2-f gp2-cell">${inp("c", "0", !sz)}</label>
        <label class="gp2-f gp2-cell">${inp("u", "0")}</label></div>
      <div class="gp2-g gp2-g-charge">${cell("chC")}${cell("chU")}</div>
      <div class="gp2-g gp2-g-reste">${cell("rsC")}${cell("rsU")}</div>
      <div class="gp2-extra">${ext.rowExtras.map(x => x.render(m.pid)).join("")}</div>
    </div>`;   // Chargement / Reste are drawn by paintSheet (below); .gp2-extra stays hidden (kept so phase-2 updates keep working)
  }

  // the table scrolls inside its own box (both axes) so the 2-level header + category stay pinned
  function fitScroll() {
    const sc = document.getElementById("gp2Scroll"), bar = S.root && S.root.querySelector(".gp2-bar"), r = S.root && S.root.querySelector(".gp2-root");
    if (!sc || !bar || !r) return;
    const h = Math.max(260, Math.floor(window.innerHeight - bar.getBoundingClientRect().bottom - 8));
    r.style.setProperty("--gp2-sh", h + "px");
    r.style.setProperty("--gp2-sw", sc.clientWidth + "px");
  }

  function buildUI() {
    const model = buildModel();
    S.collapsed  = lsGet(`gp2_collapsed_${S.wh}`, {});
    S.hiddenCats = lsGet(`gp2_hidden_${S.wh}`, {});
    const scroll = S.root.scrollTop;
    const oldSc = document.getElementById("gp2Scroll"), scTop = oldSc ? oldSc.scrollTop : 0, scLeft = oldSc ? oldSc.scrollLeft : 0;
    S.rows = {}; S.cats = {}; S.vis = {};

    let list = "";
    model.forEach(({ cat, list: rows }) => {
      list += `<section class="gp2-cat" data-cat="${esc(cat)}">
        <button type="button" class="gp2-cat-h" data-act="cat"><span class="gp2-arrow">${ic("chevron")}</span><span class="gp2-cat-t">${esc(cat)}</span><span class="gp2-cat-n"></span></button>
        <div class="gp2-cat-b">${rows.map(rowHtml).join("")}</div></section>`;
    });
    const catChecks = model.map(({ cat }) => `<label class="gp2-chk"><input type="checkbox" data-act="vis" data-cat="${esc(cat)}" ${S.hiddenCats[cat] ? "" : "checked"}> ${esc(cat)}</label>`).join("");
    const sw = canSwitchMode();

    S.root.innerHTML = `<div class="gp2-root" data-mode="${mode()}">
      <div class="gp2-bar">
        <div class="gp2-bar-r">
          <div class="gp2-bar-s">
            <input id="gp2Search" class="gp2-search" type="search" placeholder="Rechercher un produit…" value="${esc(S.search)}" autocomplete="off">
            <label class="gp2-chk gp2-tout" id="gp2ToutL" title="Inclure les produits masqués dans la recherche" hidden><input type="checkbox" data-act="searchall" ${S.searchAll ? "checked" : ""}> Tout</label>
            <button type="button" class="gp2-btn gp2-barbtn" data-act="barmin" aria-label="Masquer / afficher la barre" aria-expanded="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg></button>
            <span id="gp2Conn" class="gp2-conn" title="Synchronisation"></span>
            <span id="gp2Status" class="gp2-status"></span>
          </div>
          <div class="gp2-seg" role="group" aria-label="Mode">
            <button type="button" data-act="mode" data-m="odoo"  class="${mode() === "odoo" ? "on" : ""}" ${sw ? "" : "disabled"}>Odoo</button>
            <button type="button" data-act="mode" data-m="libre" class="${mode() === "libre" ? "on" : ""}" ${sw ? "" : "disabled"}>Libre</button>
          </div>
          <button type="button" class="gp2-btn gp2-btn-odoo" data-act="refresh" title="Actualiser les produits et le stock Odoo" aria-label="Actualiser les produits et le stock Odoo">${ic("refresh")}</button>
          <div class="gp2-menu"><button type="button" class="gp2-btn" data-act="catmenu">Catég. ${ic("chevron")}</button>
            <div class="gp2-panel" id="gp2CatPanel" hidden>
              <button type="button" class="gp2-btn gp2-btn-sm" data-act="visall">Tout afficher</button>${catChecks}</div></div>
          ${canView() ? `<div class="gp2-menu" id="gp2ViewMenu"><button type="button" class="gp2-btn" data-act="viewmenu" title="Affichage des produits" aria-label="Affichage des produits">${ic("eye")}</button>
            <div class="gp2-panel gp2-vpanel" id="gp2ViewPanel" hidden></div></div>
          <span class="gp2-vbar" id="gp2VisBar" hidden><span class="gp2-vtxt">${ic("eye")} Non enregistré</span>
            <button type="button" class="gp2-btn gp2-btn-sm gp2-vsave" data-act="vsave">Enregistrer</button>
            <button type="button" class="gp2-btn gp2-btn-sm" data-act="vcancel">Annuler</button></span>` : ""}
          <span class="gp2-ext" id="gp2BarExt">${ext.barExtras.map(x => x.render()).join("")}</span>
        </div>
        <div id="gp2Warn" class="gp2-warn" hidden></div>
        <div id="gp2VisWarn" class="gp2-warn gp2-vwarn" hidden></div>
        ${canEnter() ? "" : `<div class="gp2-warn">Lecture seule — saisie non autorisée pour votre rôle.</div>`}
      </div>
      <div class="gp2-scroll" id="gp2Scroll"><div class="gp2-sheet">
        <div class="gp2-head">
          <div class="gp2-nmcol gp2-hn"><span>Produit</span><button type="button" class="gp2-hbtn" id="gp2ToggleAll" data-act="toggleall"></button></div>
          ${[["prep", "Préparation"], ["charge", "Chargement"], ["reste", "Reste"]].map(([k, t]) =>
            `<div class="gp2-g gp2-g-${k} gp2-hg"><div class="gp2-gt">${t}</div><div class="gp2-gs"><span>Colisage</span><span>Unités</span></div></div>`).join("")}
          <div class="gp2-pnav" id="gp2PNav"><button type="button" class="gp2-pn-b" data-act="phprev" aria-label="Groupe précédent"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg></button><span class="gp2-pn-t" id="gp2PTitle">Préparation</span><button type="button" class="gp2-pn-b" data-act="phnext" aria-label="Groupe suivant"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg></button></div>
        </div>
        <div class="gp2-list">${list || `<div class="gp2-empty">Aucun produit.</div>`}</div>
      </div></div>
      <div class="gp2-idlebox" id="gp2Idle" hidden></div>
    </div>`;
    S.sess = sessionActive(); paintSession();

    S.root.querySelectorAll(".gp2-cat").forEach(sec => { S.cats[sec.dataset.cat] = sec; });
    S.root.querySelectorAll(".gp2-row").forEach(r => { S.rows[r.dataset.pid] = r; });
    S.built = true;
    refreshAll();
    applySearch(S.search);
    phAccordionInit();
    S.root.scrollTop = scroll;
    { const sc = document.getElementById("gp2Scroll"); if (sc) { sc.scrollTop = scTop; sc.scrollLeft = scLeft; } }
    const fitBar = () => { const b = S.root.querySelector(".gp2-bar"), r = S.root.querySelector(".gp2-root"); if (b && r) r.style.setProperty("--gp2-bar-h", b.offsetHeight + "px"); fitScroll(); };
    fitBar(); window.addEventListener("resize", fitBar); setTimeout(fitBar, 300);
    if (S.ro) { try { S.ro.disconnect(); } catch (_) {} S.ro = null; }
    if (typeof ResizeObserver !== "undefined") { const bar = S.root.querySelector(".gp2-bar"); if (bar) { S.ro = new ResizeObserver(fitScroll); S.ro.observe(bar); } }
    paintConn(); paintStatus(); paintToggleAll();
    renderViewPanel();
    emit("built", {});
  }

  function refreshRow(pid, bulk) {
    const row = S.rows[pid]; if (!row) return;
    const sz = sizeOf(pid), c = getC(pid), u = getU(pid), total = sz * c + u;
    row.querySelectorAll(".gp2-in").forEach(inp => {
      const f = inp.dataset.f, key = pid + ":" + f;
      if (document.activeElement === inp || S.timers[key] || S.errs[key]) return;   // never clobber what the user is typing
      const v = f === "c" ? c : u;
      inp.value = v ? String(v) : "";
    });
    row.classList.toggle("gp2-has", total > 0);
    row.classList.toggle("gp2-over", mode() === "odoo" && stockActive() && total > stockOf(pid));
    const st = row.querySelector(".gp2-stock");
    st.textContent = mode() === "odoo" ? (S.stockLoaded ? "Stock " + stockLabel(pid) : "") : "";
    const it = item(pid), who = row.querySelector(".gp2-who");
    if (it.by && it.ts) { const d = new Date(it.ts); who.textContent = `${it.by} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
    else who.textContent = "";
    const hb = row.querySelector(".gp2-hist"); if (hb) hb.disabled = !(it.by && it.ts);   // history button: active once the row was edited
    const nmc = row.querySelector(".gp2-nmcol");   // full name / editor / stock as tooltip (desktop); on phones the name opens a card
    if (nmc) nmc.title = [row.dataset.nm + (sz ? ` ×${sz}` : ""), who.textContent, st.textContent].filter(Boolean).join("\n");
    ext.rowExtras.forEach(x => { if (x.update) { try { x.update(pid, row); } catch (e) { console.error(e); } } });
    paintCatCount(row.closest(".gp2-cat"));
    if (!bulk) syncRowVis(pid);
  }
  function paintCatCount(sec) {             // counts the VISIBLE products only (hidden ones are not in the total)
    if (!sec) return;
    let n = 0, t = 0;
    sec.querySelectorAll(".gp2-row").forEach(r => { if (S.vis[r.dataset.pid] === "hide") return; t++; if (r.classList.contains("gp2-has")) n++; });
    sec.querySelector(".gp2-cat-n").textContent = `${n}/${t}`;
  }
  function refreshAll() { Object.keys(S.rows).forEach(pid => refreshRow(pid, true)); applyVisibility(); paintWarn(); }

  function applyChanges(changed) {
    if (changed.has("meta")) applyMode();
    if (changed.has("all")) refreshAll();
    else changed.forEach(k => { if (k !== "meta" && k !== "charge" && k !== "view" && k !== "session") refreshRow(k); });
    if (changed.has("view")) { applyVisibility(); renderViewPanel(); }      // another user saved a new view
    if (changed.has("all") || changed.has("meta") || changed.has("session")) syncSession();   // Terminer / Nouvelle préparation by someone else
    emit("remote", { changed: [...changed] });
  }

  function applyMode() {
    const root = S.root?.querySelector(".gp2-root"); if (!root) return;
    root.dataset.mode = mode();
    root.querySelectorAll('[data-act="mode"]').forEach(b => b.classList.toggle("on", b.dataset.m === mode()));
    if (!S.stockLoaded) loadStock().then(() => { refreshAll(); });
    else refreshAll();
  }

  function paintWarn() {
    const el = document.getElementById("gp2Warn"); if (!el) return;
    if (mode() === "odoo" && S.stockErr) { el.textContent = "Stock Odoo indisponible : " + S.stockErr + " — contrôle du stock désactivé."; el.hidden = false; }
    else if (S.stockErr && (activeView().mode === "smart" || (activeView().mode === "free" && activeView().base === "smart"))) {
      el.textContent = "Stock Odoo indisponible — le mode Intelligent affiche tous les produits."; el.hidden = false;
    }
    else el.hidden = true;
  }
  function paintConn() {
    const el = document.getElementById("gp2Conn"); if (!el) return;
    el.classList.toggle("on", S.connected);
    el.title = S.connected ? "Synchronisé en direct" : "Hors ligne / reconnexion…";
  }
  function paintStatus() {
    const el = document.getElementById("gp2Status"); if (!el) return;
    const busy = S.inflight > 0 || Object.keys(S.timers).length > 0;
    el.className = "gp2-status " + (busy ? "saving" : S.saveErr ? "err" : "ok");
    el.innerHTML = busy ? "Enregistrement…" : S.saveErr ? "Erreur — nouvel essai…" : (el.dataset.touched ? `Enregistré ${ic("check")}` : "");
    if (busy) el.dataset.touched = "1";
  }

  // ── session: Terminer wipes everything, then « Nouvelle préparation » (shared, Firebase meta/session) ──
  // meta/session absent = active, so warehouses created before this feature keep working.
  const sessionActive = () => !(S.meta.session && S.meta.session.active === false);
  const sessionInfo = () => S.meta.session || {};
  const p2d = (n) => String(n).padStart(2, "0");
  const fmtDT = (ts) => { const d = new Date(ts); return isNaN(d) ? "" : `${p2d(d.getDate())}/${p2d(d.getMonth() + 1)}/${d.getFullYear()} ${p2d(d.getHours())}:${p2d(d.getMinutes())}`; };
  const nowLocalIso = () => { const d = new Date(); return `${d.getFullYear()}-${p2d(d.getMonth() + 1)}-${p2d(d.getDate())}T${p2d(d.getHours())}:${p2d(d.getMinutes())}`; };

  function cancelPending() {                 // the session just ended: drop every unsaved / pending field save
    Object.keys(S.timers).forEach(k => clearTimeout(S.timers[k]));
    S.timers = {}; S.errs = {}; S.saveErr = false;
    const a = document.activeElement; if (a && a.classList && a.classList.contains("gp2-in")) a.blur();
    S.root && S.root.querySelectorAll(".gp2-in.gp2-err").forEach(i => { i.classList.remove("gp2-err"); i.title = ""; });
    paintStatus();
  }
  function closeSessionModals() { closeCard(); closeTruck(); closeHist(); }   // the Terminer / Bons modals are closed by preparation-charge.js (event "session")

  function paintSession() {
    const root = S.root && S.root.querySelector(".gp2-root"); if (!root) return;
    const act = sessionActive();
    root.classList.toggle("gp2-idle", !act);
    const box = byId("gp2Idle"); if (!box) return;
    box.hidden = act;
    if (act) { box.innerHTML = ""; return; }
    const s = sessionInfo(), who = [s.by ? `Terminée par ${esc(s.by)}` : "", s.ts ? fmtDT(s.ts) : ""].filter(Boolean).join(" · "), can = canDo("prep_nouvelle");
    box.innerHTML = `${ic("clipboard", "gp2-idle-ic")}
      <div class="gp2-idle-t">Aucune préparation en cours</div>
      ${who ? `<div class="gp2-idle-s">${who}</div>` : ""}
      ${can ? `<div class="gp2-idle-act"><button type="button" class="gp2-btn gp2-vsave gp2-idle-btn" data-act="newprep" ${S.starting ? "disabled" : ""}>${ic("plus")} Nouvelle préparation</button>
              <label class="gp2-sw" title="Télécharger une fiche vierge au démarrage"><input type="checkbox" data-act="blanksheet" ${blankSheetOn() ? "checked" : ""} ${S.starting ? "disabled" : ""}>${ic("filedown")}<span>Télécharger une fiche vierge au démarrage</span></label></div>`
            : `<div class="gp2-idle-s">En attente du démarrage d'une nouvelle préparation par un utilisateur autorisé.</div>`}`;
  }

  // called after any change of meta/session (remote stream or local action); emits "session" only on a real active ↔ idle transition
  function syncSession() {
    const act = sessionActive(), first = S.sess == null, changed = S.sess !== act;
    S.sess = act;
    if (changed && !act) { cancelPending(); closeSessionModals(); }
    paintSession();
    if (changed && !first) { if (act) refreshAll(); emit("session", { active: act }); }
  }

  // one atomic multi-path PATCH on the warehouse root. meta/mode, meta/view, users and permissions are not part of it.
  async function endSession() {
    if (!sessionActive()) return;
    const by = userName();
    S.wiping = true;                                       // pending field saves wait (they are dropped on success, resumed on failure)
    try { await fbPatch("", { "items": null, "hist": null, "meta/charge": null, "meta/session": { active: false, by, ts: { ".sv": "timestamp" } } }); }
    finally { S.wiping = false; }
    S.items = {}; delete S.meta.charge; S.meta.session = { active: false, by, ts: Date.now() };
    syncSession();
  }
  async function startSession() {
    if (!canDo("prep_nouvelle") || sessionActive() || S.starting) return;
    S.starting = true; paintSession();
    const by = userName(), from = nowLocalIso() + ":00", to = from.slice(0, 10) + "T23:59:59";   // défaut : maintenant → fin de la même journée (23:59:59)
    try {
      const r = await fetch(`${base()}/meta/session.json`); if (!r.ok) throw new Error("HTTP " + r.status);
      const cur = await r.json();
      if (cur && cur.active !== false) { S.meta.session = cur; syncSession(); notify(`Préparation déjà démarrée par ${cur.by || "un autre utilisateur"}`, "warning"); return; }
      await fbPatch("", { "items": null, "hist": null, "meta/charge": { from, to, by, ts: { ".sv": "timestamp" } }, "meta/session": { active: true, by, ts: { ".sv": "timestamp" } } });
      const now = Date.now();
      S.items = {}; S.meta.charge = { from, to, by, ts: now }; S.meta.session = { active: true, by, ts: now };
      return true;                                      // started by this call (used by newPrep)
    } catch (e) { console.error("[Prep2] new session:", e); notify("Échec du démarrage de la préparation", "error"); }
    finally { S.starting = false; syncSession(); }
  }

  // ── Fiche de préparation vierge (optional, per user + per browser; never blocks the start of a session) ──
  const blankSheetKey = () => `gp2_blanksheet_${AppAuth.currentUser?.username || "anon"}`;
  // Default ON: only an explicit saved false turns it off (unset ≠ false). Legacy key gp2_stockinit_{user} === false is still honoured.
  const blankSheetOn = () => {
    const v = lsGet(blankSheetKey(), undefined);
    if (typeof v === "boolean") return v;
    return lsGet(`gp2_stockinit_${AppAuth.currentUser?.username || "anon"}`, undefined) !== false;
  };
  // Source: same as the screen — S.stock (stock.quant at _getStockLocationId(), quantity > 0, summed per product) + catalogue S.raw / S.size.
  // Reused when already loaded (both modes load it); fetched only when missing. The file itself is written by preparation-charge.js (quantities only select the products; they are not written).
  async function downloadBlankSheet() {
    try {
      if (!S.raw.length) await loadCatalog();
      if (!S.stockLoaded) await loadStock();
      if (!S.stockLoaded) throw new Error(S.stockErr || "stock indisponible");
      const isNC = (c) => String(c).split("/").pop().replace(/[.\s]/g, "").toUpperCase() === "NC";     // catégorie « N.C » exclue de la fiche
      const cats = catalogModel().filter(({ cat }) => !isNC(cat)).map(({ cat, list }) => ({ cat, items: list.filter(m => stockOf(m.pid) > 0).map(m => ({ name: m.name, qty: stockOf(m.pid), sz: sizeOf(m.pid) })) })).filter(c => c.items.length);
      const W = window.GdsPrep2Charge;
      if (!W || typeof W.exportBlankSheet !== "function") throw new Error("module d'export indisponible");
      const r = W.exportBlankSheet(cats);
      if (!r) { notify("Fiche de préparation : aucun produit en stock", "warning"); return; }
      notify("Fiche de préparation téléchargée : " + r.file, "success");
    } catch (e) { console.error("[Prep2] fiche de préparation:", e); notify("Échec du téléchargement de la fiche : " + (e && e.message || e), "error"); }
  }
  // « Nouvelle préparation »: the session starts first (startSession, untouched), the file comes after and can only fail on its own.
  async function newPrep() {
    const want = blankSheetOn();
    const started = await startSession();
    if (started && want) await downloadBlankSheet();
  }

  // ── search / categories ────────────────────────────────────
  function applySearch(q) {
    S.search = q || "";
    const n = norm(S.search).trim(), root = S.root.querySelector(".gp2-root");
    root.classList.toggle("gp2-searching", !!n);
    Object.entries(S.cats).forEach(([cat, sec]) => {
      let vis = 0;
      sec.querySelectorAll(".gp2-row").forEach(r => {
        const ok = !n || r.dataset.s.includes(n), st = S.vis[r.dataset.pid], peek = st === "hide" && !!n && S.searchAll;   // "Tout": search also inside hidden products
        r.hidden = !(ok && (st !== "hide" || peek)); if (!r.hidden) vis++;
        r.classList.toggle("gp2-vpeek", peek && !r.hidden);
      });
      sec.hidden = !!S.hiddenCats[cat] || vis === 0;
      paintCatCount(sec);
      sec.classList.toggle("collapsed", !!S.collapsed[cat]);
    });
  }
  function setAllCollapsed(v) {
    Object.keys(S.cats).forEach(cat => { S.collapsed[cat] = v; S.cats[cat].classList.toggle("collapsed", v); });
    if (!isNarrow()) lsSet(`gp2_collapsed_${S.wh}`, S.collapsed);   // phone accordion state is session-only
    paintToggleAll();
  }
  // header button: one icon that flips between "collapse all" (arrows closing in) and "expand all" (arrows moving apart)
  function allCollapsed() {
    const cats = Object.keys(S.cats).filter(c => !S.hiddenCats[c]);
    return cats.length > 0 && cats.every(c => S.collapsed[c]);
  }
  function paintToggleAll() {
    const b = document.getElementById("gp2ToggleAll"); if (!b) return;
    const col = allCollapsed(), t = col ? "Tout ouvrir" : "Tout fermer";
    b.innerHTML = ic(col ? "expand" : "collapse"); b.title = t; b.setAttribute("aria-label", t);
  }

  // ── Phone: accordion — only the first (visible) category is open by default; opening another closes the rest.
  // Session-only (never written to localStorage), so desktop collapse state is untouched.
  function phAccordionInit() {
    if (!isNarrow()) return;
    const cats = Object.keys(S.cats).filter(c => !S.cats[c].hidden);
    if (!cats.length) return;
    const open = (S.phOpen && cats.includes(S.phOpen)) ? S.phOpen : (S.phOpen === null && S.phKeepClosed ? null : cats[0]);
    S.phOpen = open;
    Object.keys(S.cats).forEach(c => { const col = c !== open; S.collapsed[c] = col; S.cats[c].classList.toggle("collapsed", col); });
    paintToggleAll();
  }
  function phToggleCat(cat) {
    const sec = S.cats[cat]; if (!sec) return;
    const wasOpen = !S.collapsed[cat];
    if (wasOpen) { S.collapsed[cat] = true; sec.classList.add("collapsed"); S.phOpen = null; S.phKeepClosed = true; paintToggleAll(); return; }
    S.phKeepClosed = false; S.phOpen = cat;
    Object.keys(S.cats).forEach(c => { const col = c !== cat; S.collapsed[c] = col; S.cats[c].classList.toggle("collapsed", col); });
    paintToggleAll();
    const sc = document.getElementById("gp2Scroll");
    if (sc) sc.scrollTop = sec.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;   // bring the opened category to the top
  }

  // ── product visibility: hide / show (shared per warehouse, Firebase meta/view) ──
  const SPECIAL = "— Chargé sans préparation —";                       // always visible
  const VMODES = ["smart", "all", "prepared", "free"], BASES = ["smart", "all", "prepared"];
  const VOPTS = [["smart", "Intelligent", "Produits en stock (Odoo)"], ["all", "Tout afficher", "Aucun masquage"],
                 ["prepared", "Préparés uniquement", "Colisage ou unités saisis"], ["free", "Édition libre", "Masquer / afficher à la main"]];
  const BASE_LBL = { smart: "Intelligent", all: "Tout", prepared: "Préparés" };
  const byId = (id) => document.getElementById(id);
  const isNarrow = () => window.matchMedia("(max-width:719px)").matches;
  const toMap = (m) => { if (!m) return {}; if (Array.isArray(m)) { const o = {}; m.forEach((x, i) => { if (x) o[i] = true; }); return o; } return m; };   // Firebase turns dense numeric keys into arrays
  function normView(v, copy) {
    v = v || {};
    const h = toMap(v.hidden), s = toMap(v.shown);
    return { mode: VMODES.includes(v.mode) ? v.mode : "smart", base: BASES.includes(v.base) ? v.base : "smart",
             hidden: copy ? Object.assign({}, h) : h, shown: copy ? Object.assign({}, s) : s };
  }
  const committedView = () => normView(S.meta.view);
  const activeView = () => S.draft || committedView();
  const viewSig = (v) => v.mode + "|" + (v.mode === "free" ? v.base + "|" + Object.keys(v.hidden).sort() + "|" + Object.keys(v.shown).sort() : "");
  const viewDirty = () => !!S.draft && viewSig(S.draft) !== viewSig(committedView());
  const inSpecial = (row) => row.closest(".gp2-cat")?.dataset.cat === SPECIAL;
  const chargedQty = (pid) => { const cs = window.GdsPrep2Charge && window.GdsPrep2Charge.state; return cs && cs.loaded && cs.wh === S.wh ? (cs.agg[pid] || 0) : 0; };
  const hasQty = (pid) => getC(pid) > 0 || getU(pid) > 0 || chargedQty(pid) > 0;        // prepared or loaded
  function baseShows(pid, b) {
    if (b === "all") return true;
    if (b === "prepared") return getC(pid) > 0 || getU(pid) > 0;
    return !S.stockLoaded || !!S.stockErr || stockOf(pid) > 0;                          // smart; stock unavailable → behaves as "all"
  }
  const baseOnly = (pid, v) => hasQty(pid) || baseShows(pid, v.mode === "free" ? v.base : v.mode);   // quantities keep a product visible in every mode
  function shownIn(pid, v) {                                                             // order: hidden → shown → mode rule
    if (v.mode === "free") { if (v.hidden[pid]) return false; if (v.shown[pid]) return true; }
    return baseOnly(pid, v);
  }
  function rowState(pid, row, v, cv) {                                                   // "show" | "dim" (draft will hide it) | "hide"
    if (inSpecial(row) || shownIn(pid, v)) return "show";
    return S.draft && shownIn(pid, cv) ? "dim" : "hide";
  }
  function applyVisibility() {
    if (!S.built || !S.root) return;
    const v = activeView(), cv = S.draft ? committedView() : v, act = document.activeElement;
    const free = !!(S.draft && S.draft.mode === "free");
    let qtyHidden = 0, hid = 0;
    Object.keys(S.rows).forEach(pid => {
      const row = S.rows[pid], sp = inSpecial(row), shown = sp || shownIn(pid, v);
      let st = rowState(pid, row, v, cv);
      if (st === "hide" && S.vis[pid] && S.vis[pid] !== "hide" && act && row.contains(act)) { st = S.vis[pid]; S.visPending = true; }   // never hide the row being typed in
      S.vis[pid] = st;
      if (st === "hide") hid++;
      if (!shown && hasQty(pid)) qtyHidden++;
      row.classList.toggle("gp2-vdim", st === "dim");
      if (free && !sp) {
        const b = row.querySelector(".gp2-eye"), on = shown ? "1" : "0";
        if (b && b.dataset.v !== on) { b.dataset.v = on; b.innerHTML = ic(on === "1" ? "eye" : "eyeoff"); b.title = on === "1" ? "Masquer" : "Afficher"; }
      }
    });
    const r = S.root.querySelector(".gp2-root"); if (r) r.classList.toggle("gp2-vedit", free);
    const tl = byId("gp2ToutL"); if (tl) tl.hidden = !hid;
    applySearch(S.search);
    paintVisWarn(qtyHidden); paintVisBar();
  }
  function syncRowVis(pid) {                                    // one product changed (typing / remote edit)
    const row = S.rows[pid]; if (!row) return;
    const v = activeView(), st = rowState(pid, row, v, S.draft ? committedView() : v), old = S.vis[pid];
    if (st === old) return;
    if (st === "hide" && old && old !== "hide" && row.contains(document.activeElement)) { S.visPending = true; return; }   // re-applied on blur
    applyVisibility();
  }
  function paintVisWarn(n) {
    const el = byId("gp2VisWarn"); if (!el) return;
    if (!n) { el.hidden = true; el.innerHTML = ""; return; }
    el.innerHTML = `${ic("warn")}<span>${n} produit(s) masqué(s) avec quantités</span>${canView() ? `<button type="button" class="gp2-link" data-act="unhideqty">Afficher</button>` : ""}`;
    el.hidden = false;
  }
  function paintVisBar() {
    const b = byId("gp2VisBar"); if (!b) return;
    b.hidden = !S.draft;
    const sv = b.querySelector('[data-act="vsave"]'); if (sv) sv.disabled = !viewDirty();
  }

  // draft (local, not applied for others until « Enregistrer »)
  function markShown(d, pid, show) {                            // keeps the exception maps minimal
    const base = baseOnly(pid, d);
    if (show) { delete d.hidden[pid]; if (!base) d.shown[pid] = true; else delete d.shown[pid]; }
    else { delete d.shown[pid]; if (base) d.hidden[pid] = true; else delete d.hidden[pid]; }
  }
  function setRowShown(pid, show) {
    const d = S.draft; if (!d || d.mode !== "free") return;
    markShown(d, pid, show); applyVisibility(); renderViewPanel();
  }
  const toggleRowView = (pid) => { if (S.draft) setRowShown(pid, !shownIn(pid, S.draft)); };
  function setViewMode(m) {
    if (!canView()) return;
    if (!S.draft) { if (m === committedView().mode && m !== "free") return; S.draft = normView(S.meta.view, true); }
    if (m === "free" && S.draft.mode !== "free" && BASES.includes(S.draft.mode)) S.draft.base = S.draft.mode;   // free starts from the mode you were in
    S.draft.mode = m;
    applyVisibility(); renderViewPanel();
  }
  function unhideQty() {                                        // the "N masqué(s) avec quantités" link: restore them in a draft, saved with Enregistrer
    if (!canView()) return;
    if (!S.draft) S.draft = normView(S.meta.view, true);
    if (S.draft.mode !== "free") return;
    Object.keys(S.rows).forEach(pid => { if (!inSpecial(S.rows[pid]) && hasQty(pid) && !shownIn(pid, S.draft)) markShown(S.draft, pid, true); });
    applyVisibility(); renderViewPanel();
  }
  function cancelView() { S.draft = null; applyVisibility(); renderViewPanel(); }
  async function saveView() {
    if (!S.draft || !canView() || !viewDirty()) return;
    if (!(await appConfirm("Appliquer cet affichage des produits pour tous les utilisateurs ?", { title: "Affichage des produits", okText: "Appliquer" }))) return;
    const d = S.draft, free = d.mode === "free", hn = free && Object.keys(d.hidden).length, sn = free && Object.keys(d.shown).length;
    const body = { mode: d.mode, base: free ? d.base : null, hidden: hn ? d.hidden : null, shown: sn ? d.shown : null, by: userName(), ts: { ".sv": "timestamp" } };
    const nv = { mode: d.mode, by: userName(), ts: Date.now() };
    if (free) { nv.base = d.base; if (hn) nv.hidden = Object.assign({}, d.hidden); if (sn) nv.shown = Object.assign({}, d.shown); }
    try {
      await fbPatch("/meta/view", body);                        // ONE patch: replaces hidden and shown as a whole
      S.meta.view = nv; S.draft = null; applyVisibility(); renderViewPanel();
    } catch (e) { console.error("[Prep2] view:", e); notify("Échec de l'enregistrement de l'affichage", "error"); }
  }

  // panel
  function hiddenListHtml() {
    const v = activeView(), q = norm(S.vq || "").trim(), all = [];
    Object.keys(S.rows).forEach(pid => { const row = S.rows[pid]; if (!inSpecial(row) && !shownIn(pid, v)) all.push([pid, row]); });
    const hit = all.filter(([, row]) => !q || row.dataset.s.includes(q)), cut = hit.slice(0, 200);
    if (!all.length) return `<div class="gp2m-none">Aucun produit masqué</div>`;
    return `<div class="gp2-vcount">${all.length} masqué(s)${hit.length > cut.length ? ` — ${cut.length} affichés, affinez la recherche` : ""}</div>` +
      cut.map(([pid, row]) => `<div class="gp2-vi"><span class="gp2-vn" title="${esc(row.dataset.nm)}">${esc(row.dataset.nm)}</span>${hasQty(pid) ? `<span class="gp2-vq">quantités</span>` : ""}<button type="button" class="gp2-btn gp2-btn-sm" data-act="vrestore" data-pid="${pid}">${ic("eye")} Afficher</button></div>`).join("");
  }
  function renderViewPanel() {
    const p = byId("gp2ViewPanel"); if (!p || p.hidden) return;
    const v = activeView(), free = v.mode === "free";
    let h = `<div class="gp2-vh">Affichage des produits<span>Appliqué à tous après « Enregistrer »</span></div>` +
      VOPTS.map(([m, t, sub]) => `<button type="button" class="gp2-vopt${v.mode === m ? " on" : ""}" data-act="vmode" data-m="${m}"><span class="gp2-vck">${v.mode === m ? ic("check") : ""}</span><span><b>${t}</b><small>${sub}</small></span></button>`).join("");
    if (free) {
      if (S.draft) h += `<div class="gp2-vsub">Base de départ</div><div class="gp2-seg gp2-vbase">${BASES.map(b => `<button type="button" data-act="vbase" data-b="${b}" class="${v.base === b ? "on" : ""}">${BASE_LBL[b]}</button>`).join("")}</div>
        <div class="gp2-vsub">Produits masqués</div><input id="gp2VSearch" class="gp2-vs" type="search" placeholder="Rechercher…" value="${esc(S.vq)}" autocomplete="off"><div id="gp2VList" class="gp2-vlist">${hiddenListHtml()}</div>`;
      else h += `<button type="button" class="gp2-btn gp2-vedit-btn" data-act="vedit">Modifier la sélection</button>`;
    }
    p.innerHTML = h;
  }
  function placeView() {                                        // desktop: flip to the right edge if the panel would leave the screen (phones: CSS)
    const p = byId("gp2ViewPanel"); if (!p || p.hidden) return;
    p.style.left = ""; p.style.right = "";
    if (!isNarrow()) { const r = p.getBoundingClientRect(); if (r.right > window.innerWidth - 8) { p.style.left = "auto"; p.style.right = "0"; } }
  }
  function toggleViewPanel() {
    const p = byId("gp2ViewPanel"); if (!p) return;
    p.hidden = !p.hidden;
    if (!p.hidden) { renderViewPanel(); placeView(); }
  }

  // phones: tap on the product name → small card (tooltips do not work with touch)
  const whoText = (pid) => { const it = item(pid); if (!(it.by && it.ts)) return ""; const d = new Date(it.ts); return `${it.by} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  function closeCard() { byId("gp2Card")?.remove(); }
  function showNameCard(pid) {
    const row = S.rows[pid]; if (!row) return;
    const sz = sizeOf(pid), w = whoText(pid), lines = [];
    if (sz) lines.push(["Colisage", "×" + sz]);
    if (w) lines.push(["Modifié par", w]);
    if (mode() === "odoo" && S.stockLoaded) lines.push(["Stock", stockLabel(pid)]);
    closeCard();
    const m = document.createElement("div"); m.id = "gp2Card"; m.className = "gp2m";
    m.innerHTML = `<div class="gp2m-box gp2m-sm" role="dialog"><div class="gp2m-h"><span class="gp2m-ttl">${esc(row.dataset.nm)}</span><button type="button" class="gp2m-x" data-mclose aria-label="Fermer">${ic("x")}</button></div>
      <div class="gp2m-b">${lines.length ? lines.map(([k, val]) => `<div class="gp2-cl"><span>${k}</span><b>${esc(val)}</b></div>`).join("") : `<div class="gp2m-none">—</div>`}</div></div>`;
    m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-mclose]")) closeCard(); });
    document.body.appendChild(m);
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCard(); });

  // ── editing & autosave ─────────────────────────────────────
  function setLocal(pid, f, v) { (S.items[pid] || (S.items[pid] = {}))[f] = v; }

  function queueSave(pid, f) {
    if (!sessionActive()) return;                          // no session → nothing is ever written
    const key = pid + ":" + f;
    clearTimeout(S.timers[key]);
    S.timers[key] = setTimeout(() => flush(pid, f), DEBOUNCE);
    paintStatus();
  }
  async function flush(pid, f) {
    const key = pid + ":" + f;
    if (S.wiping) { S.timers[key] = setTimeout(() => flush(pid, f), 300); return; }   // Terminer is wiping: wait for the outcome
    delete S.timers[key];
    if (!sessionActive()) return;
    const val = f === "c" ? getC(pid) : getU(pid);
    S.inflight++; paintStatus();
    try {
      const by = userName(), ts = { ".sv": "timestamp" }, hk = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await fbPatch("", { [`items/${pid}/${f}`]: val, [`items/${pid}/ts`]: ts, [`items/${pid}/by`]: by,   // only the edited field
                          [`hist/${pid}/${hk}`]: { f, c: getC(pid), u: getU(pid), by, ts } });           // + one history entry
      S.saveErr = false;
      emit("saved", { pid, field: f, value: val });
    } catch (e) {
      console.error("[Prep2] save:", e);
      S.saveErr = true;
      if (!S.timers[key]) setTimeout(() => { if (!S.timers[key] && sessionActive()) queueSave(pid, f); }, 3000);   // retry (never after the session ended)
    } finally { S.inflight--; paintStatus(); }
  }

  function onInput(inp) {
    if (!canEnter() || !sessionActive()) return;
    const pid = inp.dataset.pid, f = inp.dataset.f, key = pid + ":" + f;
    const raw = cleanDigits(inp.value);
    const val = Math.min(MAX_VAL, parseInt(raw, 10) || 0);
    inp.value = raw === "" ? "" : String(val);
    // candidate total
    const c = f === "c" ? val : getC(pid), u = f === "u" ? val : getU(pid);
    const total = sizeOf(pid) * c + u;
    if (stockActive() && !_canOverstock() && total > stockOf(pid) + 1e-6) {   // Odoo mode: block over-stock
      S.errs[key] = true; clearTimeout(S.timers[key]); delete S.timers[key];
      inp.classList.add("gp2-err"); inp.title = `Dépasse le stock (${stockLabel(pid)})`;
      paintStatus(); return;
    }
    delete S.errs[key]; inp.classList.remove("gp2-err"); inp.title = "";
    setLocal(pid, f, val);
    refreshRow(pid);
    queueSave(pid, f);
  }

  function onCommit(inp) {                 // blur / Enter / Tab
    if (!canEnter() || !sessionActive()) return;
    const pid = inp.dataset.pid, f = inp.dataset.f, key = pid + ":" + f;
    if (S.errs[key]) {                     // revert to last valid value
      delete S.errs[key]; inp.classList.remove("gp2-err"); inp.title = "";
      const v = f === "c" ? getC(pid) : getU(pid); inp.value = v ? String(v) : "";   // force (input is still focused)
      refreshRow(pid); return;
    }
    const sz = sizeOf(pid);
    if (f === "u" && sz > 0 && getU(pid) >= sz) {            // units ≥ colisage → carry into cartons
      const u = getU(pid);
      setLocal(pid, "c", getC(pid) + Math.floor(u / sz));
      setLocal(pid, "u", Math.round(u % sz));
      const rem = getU(pid); inp.value = rem ? String(rem) : "";        // force (input may still be focused)
      refreshRow(pid); queueSave(pid, "c"); queueSave(pid, "u");
    }
  }

  function focusNext(inp, back) {
    const all = [...S.root.querySelectorAll(".gp2-row:not([hidden]) .gp2-in:not([readonly])")]
      .filter(i => i.closest(".gp2-cat") && !i.closest(".gp2-cat[hidden]") && i.offsetParent !== null);
    const i = all.indexOf(inp), nx = all[i + (back ? -1 : 1)];
    if (nx) { nx.focus(); nx.select?.(); }
  }

  // Excel-style arrow navigation between quantity cells. The cell list is rebuilt from the DOM on every key press.
  function arrowNav(e) {
    const k = e.key, inp = e.target;
    if (k !== "ArrowDown" && k !== "ArrowUp" && k !== "ArrowLeft" && k !== "ArrowRight") return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    const row = inp.closest(".gp2-row"); if (!row || !S.root) return;
    const navOk = (x) => !x.readOnly && !x.disabled && x.getAttribute("tabindex") !== "-1" && x.offsetParent !== null;
    let nx = null;
    if (k === "ArrowDown" || k === "ArrowUp") {
      const rows = [...S.root.querySelectorAll(".gp2-row")].filter(r => r === row || r.offsetParent !== null);
      const step = k === "ArrowDown" ? 1 : -1;
      for (let i = rows.indexOf(row) + step; i >= 0 && i < rows.length; i += step) {
        const c = [...rows[i].querySelectorAll(".gp2-in")].find(x => x.dataset.f === inp.dataset.f && navOk(x));
        if (c) { nx = c; break; }
      }
    } else {
      const fwd = k === "ArrowRight", len = inp.value.length, a = inp.selectionStart, b = inp.selectionEnd;
      const all = a === 0 && b === len, atEdge = fwd ? (a === len && b === len) : (a === 0 && b === 0);
      if (!all && !atEdge) return;
      const cells = [...row.querySelectorAll(".gp2-in")].filter(x => x === inp || navOk(x));
      nx = cells[cells.indexOf(inp) + (fwd ? 1 : -1)] || null;
    }
    if (!nx) return;
    e.preventDefault();
    onCommit(inp);
    nx.focus(); nx.select?.();
    nx.scrollIntoView?.({ block: "nearest" });
  }

  async function switchMode(m) {
    if (!canSwitchMode() || m === mode()) return;
    if (!(await appConfirm(`Passer en mode ${m === "libre" ? "Libre (sans stock)" : "Odoo (avec contrôle du stock)"} pour tous les utilisateurs ?`, { title: "Changer le mode", okText: "Passer" }))) return;
    S.meta.mode = m; applyMode();
    try { await fbPatch("/meta", { mode: m, modeBy: userName(), modeTs: { ".sv": "timestamp" } }); }
    catch (e) { notify("Échec changement de mode", "error"); }
  }

  async function reloadData() {
    const st = document.getElementById("gp2Status"); if (st) { st.className = "gp2-status saving"; st.textContent = "Actualisation…"; }
    try { await loadCatalog(); } catch (e) { notify("Erreur Odoo: " + e.message, "error"); }
    await loadStock();                                      // both modes: the "Intelligent" view needs it
    buildUI();
  }

  // ── events (delegated) ─────────────────────────────────────
  function bind() {
    const root = S.root;
    if (root._gp2) return; root._gp2 = true;
    root.addEventListener("input", (e) => {
      if (e.target.classList?.contains("gp2-in")) { e.target.dataset.typed = "1"; onInput(e.target); }
      else if (e.target.id === "gp2Search") applySearch(e.target.value);
      else if (e.target.id === "gp2VSearch") { S.vq = e.target.value; const l = byId("gp2VList"); if (l) l.innerHTML = hiddenListHtml(); }
    });
    root.addEventListener("change", (e) => {
      if (e.target.classList?.contains("gp2-in")) onCommit(e.target);
      else if (e.target.dataset?.col === "prep") applyPrepCol(e.target.checked);
      else if (e.target.dataset?.act === "searchall") { S.searchAll = e.target.checked; applySearch(S.search); }
      else if (e.target.dataset?.act === "blanksheet") lsSet(blankSheetKey(), !!e.target.checked);
      else if (e.target.dataset?.act === "vis") {
        S.hiddenCats[e.target.dataset.cat] = !e.target.checked;
        lsSet(`gp2_hidden_${S.wh}`, S.hiddenCats); applySearch(S.search); paintToggleAll();
      }
    });
    root.addEventListener("focusin", (e) => {
      const t = e.target; if (!t.classList?.contains("gp2-in")) return;
      t.dataset.typed = ""; setTimeout(() => { if (!t.dataset.typed) t.select?.(); }, 0);   // select-all unless already typing
    });
    root.addEventListener("keydown", (e) => {
      if (!e.target.classList?.contains("gp2-in")) return;
      if (e.key === "Enter") { e.preventDefault(); onCommit(e.target); focusNext(e.target, e.shiftKey); }
      else arrowNav(e);
    });
    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      const a = b.dataset.act;
      if (a === "cat") {
        const sec = b.closest(".gp2-cat"), cat = sec.dataset.cat;
        if (isNarrow() && !S.root.querySelector(".gp2-root.gp2-searching")) { phToggleCat(cat); return; }   // phone: accordion (one open category), not persisted
        S.collapsed[cat] = !S.collapsed[cat]; sec.classList.toggle("collapsed", S.collapsed[cat]); lsSet(`gp2_collapsed_${S.wh}`, S.collapsed); paintToggleAll();
      }
      else if (a === "truck") { if (!b.disabled) showTruck(+b.dataset.pid); }
      else if (a === "hist") { if (!b.disabled) showHist(+b.dataset.pid); }
      else if (a === "toggleall") setAllCollapsed(!allCollapsed());
      else if (a === "phprev" || a === "phnext") phStep(a === "phprev" ? -1 : 1);
      else if (a === "barmin") phBarToggle();
      else if (a === "newprep") newPrep();
      else if (a === "mode")  switchMode(b.dataset.m);
      else if (a === "refresh") reloadData();
      else if (a === "catmenu") { const p = document.getElementById("gp2CatPanel"); p.hidden = !p.hidden; }
      else if (a === "viewmenu") toggleViewPanel();
      else if (a === "vmode") setViewMode(b.dataset.m);
      else if (a === "vedit") setViewMode("free");
      else if (a === "vbase") { if (S.draft) { S.draft.base = b.dataset.b; applyVisibility(); renderViewPanel(); } }
      else if (a === "vrestore") setRowShown(b.dataset.pid, true);
      else if (a === "roweye") toggleRowView(b.closest(".gp2-row").dataset.pid);
      else if (a === "vsave") saveView();
      else if (a === "vcancel") cancelView();
      else if (a === "unhideqty") unhideQty();
      else if (a === "nmcard") { if (isNarrow()) showNameCard(b.closest(".gp2-row").dataset.pid); }
      else if (a === "visall") { S.hiddenCats = {}; lsSet(`gp2_hidden_${S.wh}`, S.hiddenCats); root.querySelectorAll('[data-act="vis"]').forEach(c => c.checked = true); applySearch(S.search); paintToggleAll(); }
    });
    document.addEventListener("click", (e) => {                 // close the categories / view panels on outside click
      const p = document.getElementById("gp2CatPanel");
      if (p && !p.hidden && !e.target.closest(".gp2-menu")) p.hidden = true;
      const vp = byId("gp2ViewPanel");                          // composedPath: the clicked node may already be re-rendered away
      if (vp && !vp.hidden && !e.composedPath().some(n => n && n.id === "gp2ViewMenu")) vp.hidden = true;
    });
    root.addEventListener("focusout", () => setTimeout(() => {   // a row hidden while it was being edited disappears once the field is left
      const a = document.activeElement;
      if (S.visPending && !(a && root.contains(a) && a.classList && a.classList.contains("gp2-in"))) { S.visPending = false; applyVisibility(); }
    }, 80));
    // pause the live stream while the tab is hidden, resume when shown
    if ("IntersectionObserver" in window) {
      S.io?.disconnect();
      S.io = new IntersectionObserver((en) => {
        const vis = en.some(x => x.isIntersecting);
        if (vis && !S.es && S.built) connect(); else if (!vis && S.es) disconnect();
      });
      S.io.observe(root);
    }
  }

  // ── extension points (phase 2) ─────────────────────────────
  const listeners = {};
  function on(evt, fn) { (listeners[evt] || (listeners[evt] = [])).push(fn); }
  function emit(evt, data) { (listeners[evt] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }
  const ext = {
    rowExtras: [],      // phase 2: [{ key, render(pid) → html }]  (Chargement, Reste…)
    barExtras: [],      // phase 2: [{ key, render() → html }]     (Imprimer, Terminer…)
    model: [],          // phase 2: [fn(model)] may push extra { cat, list:[{pid,code,name,order}] } categories
    afterFinish: [],    // phase 3: [fn(info)] called right after « Terminer » downloaded the report (reset / lock will plug in here).
                        //          info = { file, at, user, wh, mode, from, to, products, loaded, bons, bonsIncluded }
  };
  // Terminer → wipe. Called by preparation-charge.js ONLY after the report was generated and its download triggered; a rejection is reported there.
  ext.afterFinish.push((info) => endSession());

  // Chargement / Reste cells (read-only). Values come from the phase-2 module's cache; formulas unchanged:
  // chargement = qty_done of included (= not excluded) bons ÷ colisage ; reste = prepared − loaded.
  function splitQty(n, sz) { const c = sz > 0 ? Math.trunc(n / sz) : 0; return [c, Math.round(n - c * sz)]; }
  function paintSheet(pid, row) {
    const sz = sizeOf(pid), cs = window.GdsPrep2Charge && window.GdsPrep2Charge.state;
    const ready = !!(cs && cs.loaded && cs.wh === S.wh);
    const loaded = ready ? (cs.agg[pid] || 0) : 0, prep = totalOf(pid);
    const put = (k, v, neg) => {
      const el = row.querySelector(`[data-k="${k}"]`); if (!el) return;
      el.textContent = ready && v ? fmt(v) : "0";
      el.classList.toggle("gp2-dim", !(ready && v));
      el.classList.toggle("gp2-neg", !!(ready && neg && v < 0));
    };
    const [lc, lu] = splitQty(loaded, sz), [rc, ru] = splitQty(prep - loaded, sz);
    put("chC", lc); put("chU", lu); put("rsC", rc, true); put("rsU", ru, true);
    const tb = row.querySelector(".gp2-truck"); if (tb) tb.disabled = !(ready && loaded > 0);   // active only when included bons loaded this product
  }

  // ── Détail chargement (read-only modal) ──
  const hhmm = (d) => { if (!d) return "—"; const t = new Date(String(d).replace(" ", "T") + "Z"); return isNaN(t) ? String(d).slice(11, 16) : `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`; };
  const chL = () => { const c = window.GdsPrep2Charge; return c && c.labels ? c.labels() : { multi: false, byId: {} }; };
  const chTag = (id, L) => { const c = window.GdsPrep2Charge; return c && c.tag ? c.tag(id, L) : ""; };
  function truckRows(pid) {
    const cs = window.GdsPrep2Charge && window.GdsPrep2Charge.state; if (!cs || !cs.loaded) return [];
    const exc = (S.meta.charge && S.meta.charge.excluded) || {}, merged = {}, L = chL();
    cs.moves.forEach(m => {
      if (m.product_id?.[0] !== pid) return;
      const pk = cs.pickings[m.picking_id?.[0]]; if (!pk || exc[pk.id]) return;       // included (not excluded) bons only
      const r = { van: String(pk.van || "—").replace(/^"|"$/g, ""), partner: String(pk.partner_id?.[1] || "—").replace(/^"|"$/g, ""), id: pk.id,
                  ref: String(pk.name || pk.id).replace(/^"|"$/g, ""), qty: m.qty_done || 0, date: hhmm(m.date) };
      const lb = L.byId[pk.id], lk = L.multi && lb ? `_${lb.day}_${lb.jum}` : "";      // multi-day: lines of different day / JUM are not merged
      const key = `${r.qty}_${r.van}_${r.partner}_${r.date}${lk}`;                       // identical lines are merged
      if (!merged[key]) merged[key] = Object.assign({}, r, { refs: [r.ref], ids: [pk.id] });
      else { merged[key].qty += r.qty; if (!merged[key].refs.includes(r.ref)) { merged[key].refs.push(r.ref); merged[key].ids.push(pk.id); } }
    });
    return Object.values(merged);
  }
  function truckHtml(pid) {
    const rows = truckRows(pid), u = sizeOf(pid);
    if (!rows.length) return `<div class="gp2m-none">Aucun chargement trouvé</div>`;
    const L = chL(), dayOf = (r) => (L.multi ? "|" + (L.byId[r.ids[0]]?.day || "") : "");   // multi-day: jumlage counted per day
    const kv = (r) => r.van + dayOf(r), kp = (r) => r.partner + dayOf(r);
    const vc = {}, pc = {};
    rows.forEach(r => { vc[kv(r)] = (vc[kv(r)] || 0) + 1; pc[kp(r)] = (pc[kp(r)] || 0) + 1; });
    const C = (q) => u > 0 ? fmt(Math.floor(q / u)) : "—", U = (q) => u > 0 ? fmt(Math.round(q % u)) : fmt(q);
    const tot = rows.reduce((a, r) => a + r.qty, 0), w = `<span class="gp2m-w">${ic("warn")}</span>`;
    return `<div class="gp2m-wrap"><table class="gp2m-t"><thead><tr><th>Van</th><th>Livreur</th><th class="n">Colis</th><th class="n">U</th><th class="c">Heure</th><th>Transfert</th></tr></thead><tbody>
      ${rows.map(r => { const vj = vc[kv(r)] > 1, pj = pc[kp(r)] > 1;
        return `<tr class="${vj || pj ? "juml" : ""}"><td>${esc(r.van)}${chTag(r.ids[0], L)}${vj ? w : ""}</td><td>${esc(r.partner)}${pj ? w : ""}</td>
          <td class="n b">${C(r.qty)}</td><td class="n">${U(r.qty)}</td><td class="c">${esc(r.date)}</td><td>${r.refs.map((ref, i) => esc(ref) + chTag(r.ids[i], L)).join(", ")}</td></tr>`; }).join("")}
      </tbody><tfoot><tr><td colspan="2">Total</td><td class="n">${C(tot)}</td><td class="n">${U(tot)}</td><td colspan="2"></td></tr></tfoot></table></div>`;
  }
  let truckPid = null;
  // ── edit history of one product (who changed which quantity, when) ──
  let histPid = null;
  function closeHist() { histPid = null; byId("gp2Hist")?.remove(); }
  async function showHist(pid) {
    closeHist(); histPid = pid;
    const nm = S.rows[pid]?.querySelector(".gp2-nm")?.textContent || pid;
    const m = document.createElement("div"); m.id = "gp2Hist"; m.className = "gp2m";
    m.innerHTML = `<div class="gp2m-box" role="dialog"><div class="gp2m-h"><span>Historique — ${esc(nm)}</span><button type="button" class="gp2m-x" data-mclose aria-label="Fermer">${ic("x")}</button></div><div class="gp2m-b"><div class="gp2m-none">…</div></div></div>`;
    m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-mclose]")) closeHist(); });
    document.body.appendChild(m);
    let list = [];
    try { const r = await fetch(`${base()}/hist/${pid}.json`); if (r.ok) { const d = await r.json(); list = Object.values(d || {}).filter(x => x && x.ts); } }
    catch (e) { console.error("[Prep2] hist:", e); }
    if (histPid !== pid || !byId("gp2Hist")) return;                  // closed / another product opened meanwhile
    list.sort((a, b) => a.ts - b.ts);
    const last = { c: 0, u: 0 }, p2 = (n) => String(n).padStart(2, "0"), today = new Date().toDateString();
    const rows = list.map(e => {
      const v = Number(e.f === "c" ? e.c : e.u) || 0, d = v - last[e.f]; last[e.f] = v;
      const t = new Date(e.ts), hm = `${p2(t.getHours())}:${p2(t.getMinutes())}:${p2(t.getSeconds())}`;
      const when = t.toDateString() === today ? hm : `${p2(t.getDate())}/${p2(t.getMonth() + 1)} ${hm}`;
      return `<tr><td>${when}</td><td>${esc(e.by || "—")}</td><td>${e.f === "c" ? "Colisage" : "Unités"}</td><td class="n b">${fmt(v)}</td><td class="n">${d > 0 ? "+" : d < 0 ? "−" : ""}${d ? fmt(Math.abs(d)) : "0"}</td></tr>`;
    }).reverse().join("");
    const body = m.querySelector(".gp2m-b");
    if (rows) body.innerHTML = `<div class="gp2m-wrap"><table class="gp2m-t"><thead><tr><th>Heure</th><th>Utilisateur</th><th>Champ</th><th class="n">Valeur</th><th class="n">Écart</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    else { const it = item(pid); body.innerHTML = it.by && it.ts ? `<div class="gp2-cl"><span>Dernière modification</span><b>${esc(it.by)} ${p2(new Date(it.ts).getHours())}:${p2(new Date(it.ts).getMinutes())}</b></div>` : `<div class="gp2m-none">Aucune modification</div>`; }
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeHist(); });

  function closeTruck() { truckPid = null; document.getElementById("gp2Modal")?.remove(); }
  function showTruck(pid) {
    truckPid = pid;
    let m = document.getElementById("gp2Modal");
    if (!m) {
      m = document.createElement("div"); m.id = "gp2Modal"; m.className = "gp2m";
      m.innerHTML = `<div class="gp2m-box" role="dialog"><div class="gp2m-h"><span id="gp2MTitle"></span><button type="button" class="gp2m-x" data-mclose aria-label="Fermer">${ic("x")}</button></div><div class="gp2m-b" id="gp2MBody"></div></div>`;
      m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-mclose]")) closeTruck(); });
      document.body.appendChild(m);
    }
    const nm = S.rows[pid]?.querySelector(".gp2-nm")?.textContent || pid;
    m.querySelector("#gp2MTitle").textContent = `Chargement — ${nm}`;
    m.querySelector("#gp2MBody").innerHTML = truckHtml(pid);
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && truckPid != null) closeTruck(); });
  on("remote", () => setTimeout(() => { if (truckPid != null) { if (S.rows[truckPid]) showTruck(truckPid); else closeTruck(); } }, 0));   // after charge module has updated its cache
  ext.rowExtras.push({ key: "sheet", render: () => "", update: paintSheet });

  // "Colonnes" menu (owned by preparation-charge.js) gets a third entry: Préparation
  const prepOn = () => lsGet(`gp2_cols_${S.wh}`, {}).prep !== false;
  function applyPrepCol(v) { const r = S.root && S.root.querySelector(".gp2-root"); if (r) r.classList.toggle("gp2-hide-prep", !(v === undefined ? prepOn() : v)); }
  // ── Phone (≤719px): one group at a time (Préparation | Chargement | Reste). Display only: CSS class on the root, no re-render.
  const PH_KEYS = ["prep", "charge", "reste"], PH_LBL = { prep: "Préparation", charge: "Chargement", reste: "Reste" }, PH_LS = "gp2_phone_group";
  const phRoot = () => S.root && S.root.querySelector(".gp2-root");
  const phVisible = (r) => PH_KEYS.filter(k => !r.classList.contains("gp2-hide-" + k));
  function phCurrent(vis) {
    let g = null; try { g = localStorage.getItem(PH_LS); } catch (_) {}
    if (!PH_KEYS.includes(g)) g = "prep";
    if (vis.length && !vis.includes(g)) g = vis.find(k => PH_KEYS.indexOf(k) > PH_KEYS.indexOf(g)) || vis[vis.length - 1];   // skip groups hidden by the Colonnes menu
    return g;
  }
  function phApply() {
    const r = phRoot(); if (!r) return;
    const vis = phVisible(r), g = phCurrent(vis);
    PH_KEYS.forEach(k => { const want = k === g; if (r.classList.contains("gp2-ph-" + k) !== want) r.classList.toggle("gp2-ph-" + k, want); });
    const t = document.getElementById("gp2PTitle"); if (t && t.textContent !== PH_LBL[g]) t.textContent = PH_LBL[g];
    const i = vis.indexOf(g), pv = r.querySelector('[data-act="phprev"]'), nx = r.querySelector('[data-act="phnext"]');
    if (pv) pv.disabled = i <= 0;
    if (nx) nx.disabled = i < 0 || i >= vis.length - 1;
  }
  function phStep(d) {
    const r = phRoot(); if (!r) return;
    const vis = phVisible(r), i = vis.indexOf(phCurrent(vis)) + d;
    if (i < 0 || i >= vis.length) return;                  // no wrap-around
    try { localStorage.setItem(PH_LS, vis[i]); } catch (_) {}
    phApply();
  }
  let phMo = null;
  function phInit() {
    phApply();
    if (phMo) { try { phMo.disconnect(); } catch (_) {} phMo = null; }
    const r = phRoot();
    if (r && typeof MutationObserver !== "undefined") { phMo = new MutationObserver(phApply); phMo.observe(r, { attributes: true, attributeFilter: ["class"] }); }   // Colonnes menu toggles gp2-hide-* → re-sync
    phBarApply(); phBindSwipe();
  }
  const phIsPhone = () => !!(window.matchMedia && window.matchMedia("(max-width: 719px)").matches);

  // Phone: a button in the search row collapses the toolbar to "search + refresh" and expands it again (state kept on this device only).
  const PH_BAR_LS = "gp2_bar_min";
  function phBarApply() {
    const r = phRoot(); if (!r) return;
    let m = false; try { m = localStorage.getItem(PH_BAR_LS) === "1"; } catch (_) {}
    if (r.classList.contains("gp2-bar-min") !== m) r.classList.toggle("gp2-bar-min", m);
    const bt = r.querySelector('[data-act="barmin"]');
    if (bt) { bt.setAttribute("aria-expanded", m ? "false" : "true"); bt.title = m ? "Afficher la barre" : "Masquer la barre"; }
  }
  function phBarToggle() {
    const r = phRoot(); if (!r) return;
    try { localStorage.setItem(PH_BAR_LS, r.classList.contains("gp2-bar-min") ? "0" : "1"); } catch (_) {}
    phBarApply(); fitScroll();
  }

  // Phone: swipe on the group bar (header) → previous / next group (Préparation ⇄ Chargement ⇄ Reste), skipping hidden groups
  function phBindSwipe() {
    const hd = S.root && S.root.querySelector(".gp2-head");
    if (!hd) return;
    let x0 = 0, y0 = 0, on = false;
    hd.addEventListener("touchstart", (e) => { const t = e.touches[0]; if (!t || e.touches.length > 1) { on = false; return; } x0 = t.clientX; y0 = t.clientY; on = true; }, { passive: true });
    hd.addEventListener("touchend", (e) => {
      if (!on) return; on = false;
      const t = e.changedTouches[0]; if (!t || !phIsPhone()) return;
      const dx = t.clientX - x0, dy = t.clientY - y0;
      if (Math.abs(dx) >= 36 && Math.abs(dx) > Math.abs(dy) * 1.5) phStep(dx < 0 ? 1 : -1);   // swipe left → next
    }, { passive: true });
  }
  on("built", () => {
    const p = document.getElementById("gcColsPanel");
    if (p && !p.querySelector('[data-col="prep"]'))
      p.insertAdjacentHTML("afterbegin", `<label class="gp2-chk"><input type="checkbox" data-gc="col" data-col="prep" ${prepOn() ? "checked" : ""}> Préparation</label>`);
    applyPrepCol();
    phInit();
  });

  // rowExtras entries may also define update(pid, rowEl) — called after every refreshRow.
  // events: "built" (UI rebuilt), "remote" ({changed}), "saved".

  // small API for phase-2 modules (preparation-charge.js) — keeps helpers private otherwise
  const api = {
    rpc, fbPatch, esc, fmt, norm, lsGet, lsSet, notify, userName, canEnter, whId: () => S.wh,
    sizeOf, getC, getU, totalOf, mode,
    can: canDo, sessionActive, sessionInfo,
    refreshAll, refreshRow, buildUI, ic, applyVisibility, canView,
  };

  // ── public render ──────────────────────────────────────────
  async function render() {
    const el = document.getElementById("gdsPreparationContent");
    if (!el) return;
    if (S.rendering) return S.rendering;
    S.rendering = (async () => {
      const wh = whId();
      if (S.wh !== wh) {                                   // warehouse changed → reset everything
        disconnect();
        Object.assign(S, { wh, built: false, raw: [], size: {}, catalogAt: 0, stock: {}, stockLoaded: false, items: {}, meta: { mode: "odoo" }, timers: {}, errs: {}, draft: null, vis: {}, sess: null, wiping: false, starting: false });
      }
      S.root = el; S.built = false;
      el.innerHTML = `<div class="gp2-loading">Chargement…</div>`;
      try {
        const needCatalog = !S.raw.length || Date.now() - S.catalogAt > CATALOG_TTL;
        await Promise.all([needCatalog ? loadCatalog() : null, S.es ? null : firstLoad()]);
        if (!S.stockLoaded) await loadStock();            // both modes: needed by the "Intelligent" view (validation/display stay Odoo-only)
      } catch (e) {
        el.innerHTML = `<div class="gp2-loading gp2-fail">Erreur: ${esc(e.message)} <button class="gp2-btn" onclick="renderGdsPreparation()">Réessayer</button></div>`;
        return;
      }
      buildUI(); bind();
      if (!S.es) connect();
      emit("entered", {});                                 // phase-2 hook: automatic refresh when the section is opened
    })();
    try { await S.rendering; } finally { S.rendering = null; }
  }

  // Dictionnaire d'abréviations modifié (par moi ou par un autre utilisateur) → reconstruire l'affichage sans toucher aux données
  let ndTimer = null;
  window.addEventListener("namedict:changed", () => {
    clearTimeout(ndTimer);
    ndTimer = setTimeout(function again() {
      if (!S.built || !S.root || !document.body.contains(S.root)) return;
      const ae = document.activeElement;
      if (ae && ae.classList && ae.classList.contains("gp2-in")) { ndTimer = setTimeout(again, 1500); return; }   // ne pas casser une saisie en cours
      buildUI();
    }, 120);
  });

  window.GdsPrep2 = { render, on, ext, api, state: S };

  // Entry point used by gdsShowTab (app.js)
  window.renderGdsPreparation = function () {
    return render();
  };
})();
