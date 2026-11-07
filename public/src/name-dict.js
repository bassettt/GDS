// ============================================================
// src/name-dict.js — Dictionnaire d'abréviations des noms de produits (GDS)
// ------------------------------------------------------------
// • Affichage uniquement : ne modifie jamais les noms Odoo, les RPC ni les clés de stockage.
// • Firebase : nœud indépendant `name_dict` (PAS dans settings.json, écrit par PUT à champs fixes).
//     { rules: { "<id>": { from, to, on } }, opts: { stripRef, stripParens }, by, ts }
//     to = "X" → supprimer la phrase.
// • Logique portée de public_3/utils.js (productLabel / _collapseAndTrim) — voir make().
// • Dépend de : _FB_DB_URL (auth.js), AppAuth/isAdmin (auth.js), escHtml (utils.js), XLSX.
// ============================================================
(function () {
  "use strict";

  const FB_KEY = "name_dict";
  const DEFAULT_OPTS = { stripRef: true, stripParens: true };

  // Règles par défaut = PRODUCT_NAME_DICT de public_3 (ordre et valeurs d'origine, y compris les espaces finaux).
  // Semées une seule fois, à la première utilisation, puis jamais réécrites.
  const DEFAULT_PAIRS = [["BARQUETTE ALUMINIUM", "BARQUETTE"], ["GRAND MODELE", "X"], ["MOYEN MODELE ", "X"], ["MOSAIQUE ", "X"], ["FEUILLES ", "X"], ["ALUMINIUM & COUVERCLE", "X"], ["& COUVERCLE", "X"], ["SHAMPOOING BRILISS A", "SHAM"], ["BRILISS LISSAGE ILLIM", "X"], ["DEPILATOIRE DAHLIA", "X"], ["PLATEAU ALUMINIUM P", "PLAT"], ["DE POCHE PARFUMÉE", "X"], ["PAPIER HYGIÉNIQUE", "PH"], ["PAPIER HYGIENIQUE", "PH"], ["PAPIER HYGENIQUE", "PH"], ["PAPIER CUISSON", "PC"], ["BOITE MOUCHOIR", "BM"], ["FILM ALIMENTAIRE", "FILM"], ["BRILISS A L'HUILE", "X"], ["BÉBÉ 80 DOUCE", "X"], ["ESSUIE TOUT", "ESS"], ["40X40cm / 45", "X"], ["40X40cm / 50", "X"], ["40X40cm /45", "X"], ["30X30cm / 80", "X"], ["30X30cm / 35", "X"], ["36X36 / 25", "X"], ["27X25cm /", "X"], ["mètres X 30cm", "X"], ["mètres X 30 cm", "X"], ["mètres X 28 cm", "X"], ["mètres X 30", "X"], ["BRILISS A", "X"], ["PARFUME", "X"], ["WARDA", "X"], ["WAFA", "X"], ["RLX", "X"]];

  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Réduit les espaces multiples et retire espaces / symboles ( / - , & ) aux extrémités (idem public_3)
  const collapseAndTrim = (s) => s.replace(/\s+/g, " ").replace(/^[\s/\-,&]+|[\s/\-,&]+$/g, "").trim();
  const isDel = (to) => { const t = String(to == null ? "" : to).trim(); return t === "" || t.toUpperCase() === "X"; };

  function defaultData() {
    const rules = {};
    DEFAULT_PAIRS.forEach(([from, to], i) => { rules["r" + String(i + 1).padStart(3, "0")] = { from, to, on: true }; });
    return { rules, opts: { ...DEFAULT_OPTS }, by: "system", ts: Date.now() };
  }

  // Construit une fonction shortName(raw) à partir de données de dictionnaire.
  // Les regex sont compilées UNE fois ici ; une nouvelle fonction n'est reconstruite que si le dictionnaire change.
  function make(data) {
    const opts = Object.assign({}, DEFAULT_OPTS, (data && data.opts) || {});
    const compiled = Object.entries((data && data.rules) || {})
      .filter(([, r]) => r && typeof r.from === "string" && r.from.trim() !== "" && r.on !== false)
      .map(([id, r]) => ({ id, len: r.from.length, re: new RegExp(escRe(r.from), "gi"), rep: isDel(r.to) ? " " : ` ${String(r.to).trim()} ` }))
      .sort((a, b) => b.len - a.len || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));   // le plus long d'abord
    const cache = new Map();
    return function shortName(raw) {
      const orig = raw == null ? "" : String(raw);
      if (cache.has(orig)) return cache.get(orig);
      let out = orig;
      try {
        let s = orig;
        if (opts.stripRef) { const i = s.indexOf("]"); if (i !== -1) s = s.slice(i + 1); }          // [REF] Nom → Nom
        s = collapseAndTrim(opts.stripParens ? s.replace(/[()]/g, " ") : s);                         // ( ) → espace
        for (const r of compiled) s = collapseAndTrim(s.replace(r.re, () => r.rep));                 // fonction : "$" littéral sûr
        s = collapseAndTrim(s);
        out = s === "" ? orig : s;                                                                   // jamais de nom vide
      } catch (_) { out = orig; }
      if (cache.size > 6000) cache.clear();
      cache.set(orig, out);
      return out;
    };
  }

  const normData = (d) => ({
    rules: (d && typeof d.rules === "object" && d.rules) || {},
    opts: Object.assign({}, DEFAULT_OPTS, (d && d.opts) || {}),
    by: (d && d.by) || "", ts: (d && d.ts) || 0,
  });

  // ── État partagé + chargement Firebase ────────────────────
  const ND = {
    data: null, _fn: null, ver: 0, error: null,
    DEFAULT_OPTS, make, defaultData,

    // Appelée partout à l'affichage. Échec/chargement absent → nom d'origine.
    shortName(raw) { return this._fn ? this._fn(raw) : (raw == null ? "" : String(raw)); },

    _apply(d) {
      this.data = normData(d); this._fn = make(this.data); this.ver++;
      try { window.dispatchEvent(new CustomEvent("namedict:changed", { detail: { ver: this.ver } })); } catch (_) {}
    },

    async load() {
      try {
        const r = await fetch(`${_FB_DB_URL}/${FB_KEY}.json`, { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = await r.json();
        if (d && typeof d === "object") this._apply(d);
        else { const seed = defaultData(); this._apply(seed); await this._seed(seed); }   // nœud vide → première utilisation
        this.error = null;
      } catch (e) { this.error = e; console.warn("[NameDict] load failed — noms d'origine utilisés:", e); }
      this.listen();
    },

    // Semis unique : PUT conditionnel (if-match: null_etag = seulement si le nœud est encore vide).
    async _seed(seed) {
      const url = `${_FB_DB_URL}/${FB_KEY}.json`;
      try {
        const r = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", "if-match": "null_etag" }, body: JSON.stringify(seed) });
        if (r.status === 412) await this.reload();                  // quelqu'un l'a déjà semé
      } catch (_) {                                                // en-tête refusé (CORS) → repli : revérifier puis PUT simple
        try {
          const d = await (await fetch(url, { cache: "no-store" })).json();
          if (d == null) await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(seed) });
        } catch (__) {}
      }
    },

    async reload() {
      try {
        const r = await fetch(`${_FB_DB_URL}/${FB_KEY}.json`, { cache: "no-store" });
        if (!r.ok) return;
        const d = await r.json();
        if (!d || typeof d !== "object") return;
        if (this.data && d.ts && d.ts === this.data.ts) return;     // déjà à jour (écho de notre propre sauvegarde)
        this._apply(d);
      } catch (_) {}
    },

    // Temps réel : tous les utilisateurs voient la mise à jour immédiatement (SSE, comme Preparation v2).
    listen() {
      if (this._es || typeof EventSource === "undefined") return;
      try {
        const es = new EventSource(`${_FB_DB_URL}/${FB_KEY}.json`);
        let first = true, t = null;
        const kick = () => { if (first) { first = false; return; } clearTimeout(t); t = setTimeout(() => this.reload(), 250); };
        es.addEventListener("put", kick); es.addEventListener("patch", kick);
        this._es = es;
      } catch (_) {}
    },

    // Permission : admin uniquement. Point d'extension unique si un rôle doit y accéder plus tard.
    canEdit() { return typeof isAdmin === "function" && isAdmin(); },
  };

  window.NameDict = ND;
  window.shortName = (n) => ND.shortName(n);

  // ============================================================
  // Interface « Paramètres » (admin) — brouillon local jusqu'à Enregistrer
  // ============================================================
  const IC = {
    tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><circle cx="7" cy="7" r="1.5"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    reset: '<polyline points="1 4 1 10 7 10"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    arrow: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  };
  const ic = (n, sz = 14) => `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n]}</svg>`;
  ND.icon = ic;

  const UI = { draft: null, baseTs: 0, baseSig: "", filter: "", catalog: null, catErr: null, imp: null, fn: null, timer: null, bound: false, saving: false };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (typeof escHtml === "function" ? escHtml(s) : String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])));
  const newId = () => "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const notify = (m, t) => { try { if (typeof addNotif === "function") addNotif(m, t || "success"); } catch (_) {} };
  const userName = () => { try { return AppAuth.currentUser.displayName || AppAuth.currentUser.username || ""; } catch (_) { return ""; } };

  const cleanRule = (r) => ({ from: String(r.from == null ? "" : r.from), to: isDel(r.to) ? "X" : String(r.to).trim(), on: r.on !== false });
  const sig = (d) => JSON.stringify([Object.keys(d.rules).sort().map((k) => [k, d.rules[k].from, isDel(d.rules[k].to) ? "X" : String(d.rules[k].to).trim(), d.rules[k].on !== false]), !!d.opts.stripRef, !!d.opts.stripParens]);
  const isDirty = () => !!UI.draft && sig(UI.draft) !== UI.baseSig;
  const sorted = (rules) => Object.entries(rules).map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => ((b.from.trim() === "") - (a.from.trim() === "")) || b.from.length - a.from.length || (a.id < b.id ? -1 : 1));   // vides d'abord, puis le plus long

  function initDraft() {
    const rules = {}; Object.entries(ND.data.rules).forEach(([id, r]) => { if (r) rules[id] = cleanRule(r); });
    UI.draft = { rules, opts: { stripRef: !!ND.data.opts.stripRef, stripParens: !!ND.data.opts.stripParens } };
    UI.baseTs = ND.data.ts || 0; UI.baseSig = sig(UI.draft); UI.imp = null; UI.filter = "";
  }

  function status(msg, kind) {
    const el = $("ndStatus"); if (!el) return;
    el.textContent = msg || ""; el.style.color = kind === "err" ? "var(--red,#dc2626)" : kind === "ok" ? "var(--accent,#1a6b3a)" : "var(--text2)";
  }
  function paintSave() {
    const b = $("ndSave"); if (!b) return;
    const d = isDirty(); b.disabled = !d || UI.saving; b.style.opacity = b.disabled ? ".5" : "1";
    if (d && !UI.saving) status("Modifications non enregistrées");
    else if (!UI.saving && !($("ndStatus") && $("ndStatus").dataset.keep)) status("");
  }

  // ── Construction de l'interface (une fois par ouverture) ──
  function buildShell() {
    const sw = (id, label) => `<div class="toggle-row"><label class="toggle-label" for="${id}">${label}</label>
      <label class="toggle-switch"><input type="checkbox" id="${id}"><span class="toggle-slider"></span></label></div>`;
    $("ndRoot").innerHTML = `
      <div class="nd-sec">${sw("ndStripRef", "Supprimer le code [REF] au début du nom")}${sw("ndStripParens", "Supprimer les parenthèses ( )")}</div>
      <div class="nd-sec"><div class="nd-h">Test en direct</div>
        <div class="nd-test"><input id="ndTest" class="nd-in" type="text" autocomplete="off" placeholder="Saisir un nom de produit…">
          <span class="nd-arrow">${ic("arrow")}</span><div id="ndTestOut" class="nd-out">—</div></div></div>
      <div class="nd-sec"><div class="nd-h">Règles <span id="ndCount" class="nd-cnt"></span></div>
        <div class="nd-bar"><div class="nd-sbox">${ic("search")}<input id="ndFilter" type="text" autocomplete="off" placeholder="Filtrer les règles…"></div>
          <button type="button" class="nd-btn nd-pri" data-act="add">${ic("plus")} Ajouter une règle</button></div>
        <div class="nd-thead"><span>Expression (de)</span><span>Remplacement (X = supprimer)</span><span>Actif</span><span></span></div>
        <div id="ndRules" class="nd-rules"></div>
        <div class="nd-hint">Tri automatique : l'expression la plus longue est appliquée en premier. Insensible à la casse. Les espaces en début/fin comptent (ex. « MOSAIQUE »).</div></div>
      <div class="nd-sec"><div class="nd-h">Import / export</div>
        <div class="nd-bar">
          <label class="nd-btn">${ic("upload")} Importer Excel / CSV<input type="file" id="ndFile" accept=".xlsx,.xls,.csv" hidden></label>
          <select id="ndMode" class="nd-sel"><option value="merge">Fusionner (ajoute / met à jour)</option><option value="replace">Remplacer tout</option></select>
          <button type="button" class="nd-btn" data-act="export">${ic("download")} Exporter</button>
          <button type="button" class="nd-btn nd-warn" data-act="reset">${ic("reset")} Dictionnaire par défaut</button></div>
        <div class="nd-hint">Colonnes : « ancien » et « nouveau » (X ou cellule vide = supprimer). L'export contient les règles actives.</div>
        <div id="ndImp"></div></div>
      <div class="nd-sec"><div class="nd-h">Aperçu sur le catalogue Odoo</div><div id="ndDup"></div><div id="ndSample" class="nd-sample"></div></div>`;
    $("ndStripRef").checked = UI.draft.opts.stripRef;
    $("ndStripParens").checked = UI.draft.opts.stripParens;
  }

  function renderRules() {
    const el = $("ndRules"); if (!el) return;
    const q = UI.filter.trim().toLowerCase(), all = sorted(UI.draft.rules);
    const seen = {}; all.forEach((r) => { const k = r.from.toLowerCase(); if (k.trim()) seen[k] = (seen[k] || 0) + 1; });
    const list = q ? all.filter((r) => r.from.trim() === "" || r.from.toLowerCase().includes(q) || String(r.to).toLowerCase().includes(q)) : all;
    $("ndCount").textContent = `${all.length} règles · ${all.filter((r) => r.on !== false).length} actives${q ? ` · ${list.length} affichées` : ""}`;
    el.innerHTML = list.length ? list.map((r) => {
      const bad = r.from.trim() === "" || seen[r.from.toLowerCase()] > 1;
      return `<div class="nd-row${bad ? " nd-bad" : ""}" data-id="${esc(r.id)}">
        <div class="nd-fw"><input class="nd-in" data-f="from" type="text" autocomplete="off" spellcheck="false" value="${esc(r.from)}" placeholder="Expression…">${r.from && r.from !== r.from.trim() ? `<span class="nd-sp" title="Espaces en début/fin pris en compte">esp.</span>` : ""}</div>
        <input class="nd-in" data-f="to" type="text" autocomplete="off" spellcheck="false" value="${esc(isDel(r.to) ? "X" : r.to)}" placeholder="X">
        <label class="toggle-switch"><input type="checkbox" data-f="on" ${r.on !== false ? "checked" : ""}><span class="toggle-slider"></span></label>
        <button type="button" class="nd-ico" data-act="del" aria-label="Supprimer la règle" title="Supprimer">${ic("trash")}</button></div>`;
    }).join("") : `<div class="nd-empty">${all.length ? "Aucune règle ne correspond." : "Aucune règle."}</div>`;
  }

  // ── Aperçus (test, échantillon, doublons) ─────────────────
  function schedulePreview() { clearTimeout(UI.timer); UI.timer = setTimeout(refreshPreview, 250); }
  function refreshPreview() {
    if (!UI.draft || !$("ndRoot")) return;
    UI.fn = make(UI.draft);
    updateTest(); renderSample(); renderDup();
  }
  function updateTest() {
    const i = $("ndTest"), o = $("ndTestOut"); if (!i || !o) return;
    const v = i.value;
    if (!v.trim()) { o.textContent = "—"; o.classList.remove("nd-same"); return; }
    const r = UI.fn ? UI.fn(v) : v; o.textContent = r; o.classList.toggle("nd-same", r === v);
  }
  function renderSample() {
    const el = $("ndSample"); if (!el) return;
    if (UI.catErr) { el.innerHTML = `<div class="nd-empty">Catalogue Odoo indisponible.</div>`; return; }
    if (!UI.catalog) { el.innerHTML = `<div class="nd-empty">Chargement du catalogue…</div>`; return; }
    const fn = UI.fn || make(UI.draft);
    el.innerHTML = `<div class="nd-srow nd-sh"><span>Nom d'origine</span><span></span><span>Nom abrégé</span></div>` +
      UI.catalog.slice(0, 20).map((p) => { const s = fn(p.full);
        return `<div class="nd-srow"><span title="${esc(p.full)}">${esc(p.full)}</span><span class="nd-arrow">${ic("arrow", 12)}</span><b class="${s === p.full ? "nd-same" : ""}" title="${esc(s)}">${esc(s)}</b></div>`; }).join("");
  }

  // Deux produits dont l'abrégé devient identique (alors que leurs noms d'origine diffèrent) → alerte
  function dupGroups() {
    if (!UI.catalog) return null;
    const fn = UI.fn || make(UI.draft), g = new Map();
    UI.catalog.forEach((p) => {
      const s = fn(p.full), k = s.toLowerCase();
      (g.get(k) || g.set(k, { s, items: [] }).get(k)).items.push(p);
    });
    return [...g.values()].filter((x) => new Set(x.items.map((p) => p.full.toLowerCase())).size > 1);
  }
  function renderDup() {
    const el = $("ndDup"); if (!el) return;
    const d = dupGroups(); if (d === null) { el.innerHTML = ""; return; }
    if (!d.length) { el.innerHTML = `<div class="nd-ok">${ic("check")} Aucun doublon de nom abrégé.</div>`; return; }
    el.innerHTML = `<div class="nd-dup"><div class="nd-dup-h">${ic("alert", 15)} ${d.length} nom(s) abrégé(s) en doublon — ajustez les règles</div>` +
      d.slice(0, 8).map((x) => `<div class="nd-dup-g"><b>${esc(x.s)}</b>${x.items.slice(0, 6).map((p) => `<div title="${esc(p.full)}">${esc(p.full)}</div>`).join("")}${x.items.length > 6 ? `<div>… +${x.items.length - 6}</div>` : ""}</div>`).join("") +
      (d.length > 8 ? `<div class="nd-hint">… et ${d.length - 8} autre(s) groupe(s)</div>` : "") + `</div>`;
  }

  async function loadCatalog() {
    if (UI.catalog) return;
    try {
      const res = await fetch("/api/web/dataset/call_kw", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(), params: { model: "product.product", method: "search_read", args: [[["active", "=", true]]], kwargs: { fields: ["id", "name", "default_code"], limit: 5000 } } }) });
      const j = await res.json();
      if (!Array.isArray(j && j.result)) throw new Error("catalogue");
      UI.catalog = j.result.map((p) => ({ id: p.id, full: typeof _productOdooName === "function" ? _productOdooName(p) : String(p.name || "") })); UI.catErr = null;
    } catch (e) { UI.catErr = e; }
    renderSample(); renderDup();
  }

  // ── Import / export Excel ─────────────────────────────────
  async function onFile(input) {
    const f = input.files && input.files[0]; input.value = ""; if (!f) return;
    try {
      const wb = /\.csv$/i.test(f.name) ? XLSX.read(await f.text(), { type: "string" }) : XLSX.read(await f.arrayBuffer(), { type: "array" });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
      const keys = rows.length ? Object.keys(rows[0]) : [];
      const kA = keys.find((k) => k.trim().toLowerCase() === "ancien"), kN = keys.find((k) => k.trim().toLowerCase() === "nouveau");
      if (!kA || !kN) { UI.imp = { file: f.name, items: [], errors: [{ line: 1, msg: "Colonnes « ancien » et « nouveau » introuvables" }], fatal: true }; return renderImp(); }
      const items = [], errors = [];
      rows.forEach((row, i) => {
        const line = i + 2, a = row[kA] == null ? "" : String(row[kA]), n = row[kN] == null ? "" : String(row[kN]);
        if (a.trim() === "" && n.trim() === "") return;                 // ligne vide : ignorée sans bruit
        if (a.trim() === "") { errors.push({ line, msg: "colonne « ancien » vide" }); return; }
        items.push({ line, from: a, to: isDel(n) ? "X" : n.trim() });
      });
      UI.imp = { file: f.name, items, errors }; renderImp();
    } catch (e) { console.error(e); UI.imp = { file: f.name, items: [], errors: [{ line: 0, msg: "fichier illisible" }], fatal: true }; renderImp(); }
  }

  function impPreview() {
    const mode = ($("ndMode") || {}).value || "merge", last = new Map(), ignored = [];
    UI.imp.items.forEach((it) => { const k = it.from.toLowerCase(); if (last.has(k)) ignored.push({ ...last.get(k), why: `doublon dans le fichier (ligne ${it.line} retenue)` }); last.set(k, it); });
    const exist = new Map(Object.entries(UI.draft.rules).map(([id, r]) => [r.from.toLowerCase(), id]));
    const added = [], updated = [];
    last.forEach((it, k) => {
      if (mode === "replace") { added.push(it); return; }
      const id = exist.get(k);
      if (!id) added.push(it);
      else { const r = UI.draft.rules[id]; if (r.to === it.to && r.on !== false) ignored.push({ ...it, why: "identique" }); else updated.push({ ...it, id, prev: r.to }); }
    });
    return { mode, added, updated, ignored };
  }
  function renderImp() {
    const el = $("ndImp"); if (!el) return;
    if (!UI.imp) { el.innerHTML = ""; return; }
    const P = UI.imp.fatal ? { mode: "merge", added: [], updated: [], ignored: [] } : impPreview(), E = UI.imp.errors;
    const line = (it, extra) => `<div class="nd-il"><span>${esc(it.from)}</span><span class="nd-arrow">${ic("arrow", 11)}</span><b>${esc(it.to)}</b>${extra || ""}</div>`;
    el.innerHTML = `<div class="nd-imp"><div class="nd-imp-h">${esc(UI.imp.file)}</div>
      <div class="nd-imp-s"><span>Ajoutées <b>${P.added.length}</b></span><span>Mises à jour <b>${P.updated.length}</b></span><span>Ignorées <b>${P.ignored.length}</b></span><span class="${E.length ? "nd-e" : ""}">Erreurs <b>${E.length}</b></span></div>
      ${P.mode === "replace" && !UI.imp.fatal ? `<div class="nd-note">${ic("alert", 13)} Remplacement complet : les ${Object.keys(UI.draft.rules).length} règles actuelles seront supprimées du brouillon.</div>` : ""}
      ${E.length ? `<div class="nd-errs">${E.slice(0, 10).map((e) => `<div>Ligne ${e.line} : ${esc(e.msg)}</div>`).join("")}${E.length > 10 ? `<div>… +${E.length - 10}</div>` : ""}</div>` : ""}
      ${P.added.length ? `<div class="nd-il-h">Ajoutées</div>${P.added.slice(0, 8).map((it) => line(it)).join("")}${P.added.length > 8 ? `<div class="nd-hint">… +${P.added.length - 8}</div>` : ""}` : ""}
      ${P.updated.length ? `<div class="nd-il-h">Mises à jour</div>${P.updated.slice(0, 8).map((it) => line(it, `<small>(avant : ${esc(it.prev)})</small>`)).join("")}${P.updated.length > 8 ? `<div class="nd-hint">… +${P.updated.length - 8}</div>` : ""}` : ""}
      <div class="nd-bar" style="margin-top:8px"><button type="button" class="nd-btn nd-pri" data-act="impapply" ${UI.imp.fatal || (!P.added.length && !P.updated.length && P.mode !== "replace") ? "disabled" : ""}>Appliquer au brouillon</button>
        <button type="button" class="nd-btn" data-act="impcancel">Annuler l'import</button></div></div>`;
  }
  async function applyImp() {
    if (!UI.imp || UI.imp.fatal) return;
    const P = impPreview();
    if (P.mode === "replace") {
      if (!P.added.length) { status("Fichier sans règle valide : remplacement refusé", "err"); return; }
      if (!(await appConfirm(`Remplacer les ${Object.keys(UI.draft.rules).length} règles actuelles par ${P.added.length} règles du fichier ?`, { title: "Remplacer les règles", okText: "Remplacer", danger: true }))) return;
      UI.draft.rules = {};
    }
    P.added.forEach((it) => { UI.draft.rules[newId()] = { from: it.from, to: it.to, on: true }; });
    P.updated.forEach((it) => { UI.draft.rules[it.id] = { from: UI.draft.rules[it.id].from, to: it.to, on: true }; });
    UI.imp = null; renderImp(); renderRules(); refreshPreview(); paintSave();
    status("Import appliqué au brouillon — cliquez sur Enregistrer", "ok");
  }
  function exportXlsx() {
    const rows = [["ancien", "nouveau"]];
    sorted(UI.draft.rules).filter((r) => r.on !== false && r.from.trim() !== "").forEach((r) => rows.push([r.from, isDel(r.to) ? "X" : r.to]));
    const ws = XLSX.utils.aoa_to_sheet(rows); ws["!cols"] = [{ wch: 38 }, { wch: 24 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Dictionnaire");
    XLSX.writeFile(wb, "dictionnaire_abreviations.xlsx");
  }

  // ── Sauvegarde ────────────────────────────────────────────
  async function save() {
    if (!ND.canEdit() || !UI.draft || UI.saving) return;
    const rules = {}, seen = new Map();
    for (const [id, r] of Object.entries(UI.draft.rules)) {
      if (r.from.trim() === "") { status("Une règle a une expression vide : renseignez-la ou supprimez-la", "err"); return; }   // règle vide refusée
      const k = r.from.toLowerCase();
      if (seen.has(k)) { status(`Règle en double : « ${r.from.trim()} »`, "err"); return; }
      seen.set(k, 1); rules[id] = cleanRule(r);
    }
    UI.saving = true; paintSave(); status("Enregistrement…");
    try {
      const url = `${_FB_DB_URL}/${FB_KEY}.json`;
      const cur = await (await fetch(url, { cache: "no-store" })).json().catch(() => null);
      if (cur && cur.ts && cur.ts !== UI.baseTs && !(await appConfirm(`Le dictionnaire a été modifié par ${cur.by || "un autre utilisateur"} depuis l'ouverture. Écraser ses modifications ?`, { title: "Conflit de modification", okText: "Écraser", danger: true }))) { UI.saving = false; paintSave(); status("Enregistrement annulé"); return; }
      const payload = { rules, opts: { stripRef: !!UI.draft.opts.stripRef, stripParens: !!UI.draft.opts.stripParens }, by: userName(), ts: Date.now() };
      const r = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      ND._apply(payload); initDraft(); UI.saving = false;
      if ($("ndRoot")) { buildShell(); renderRules(); refreshPreview(); }
      paintSave(); status("Enregistré", "ok"); $("ndStatus") && ($("ndStatus").dataset.keep = "1");
      notify("Dictionnaire d'abréviations enregistré", "success");
    } catch (e) {
      console.error("[NameDict] save:", e); UI.saving = false; paintSave(); status("Échec de l'enregistrement — réessayez", "err");
    }
  }

  async function cancel() {
    if (isDirty() && !(await appConfirm("Abandonner les modifications non enregistrées ?", { title: "Modifications non enregistrées", okText: "Abandonner", danger: true }))) return;
    UI.draft = null; UI.imp = null;
    if (typeof _closeSettingsModal === "function") _closeSettingsModal("modalNameDict");
  }

  // ── Événements (délégation, liés une seule fois) ──────────
  function bindUI() {
    if (UI.bound) return; const m = $("modalNameDict"); if (!m) return; UI.bound = true;
    m.addEventListener("input", (e) => {
      const t = e.target;
      if (t.id === "ndTest") return updateTest();
      if (t.id === "ndFilter") { UI.filter = t.value; return renderRules(); }
      const row = t.closest && t.closest(".nd-row"); if (!row || !t.dataset.f || t.type === "checkbox") return;
      const r = UI.draft.rules[row.dataset.id]; if (!r) return;
      r[t.dataset.f] = t.value; paintSave(); schedulePreview();
    });
    m.addEventListener("change", (e) => {
      const t = e.target;
      if (t.id === "ndStripRef" || t.id === "ndStripParens") { UI.draft.opts[t.id === "ndStripRef" ? "stripRef" : "stripParens"] = t.checked; paintSave(); return schedulePreview(); }
      if (t.id === "ndFile") return onFile(t);
      if (t.id === "ndMode") return renderImp();
      const row = t.closest && t.closest(".nd-row");
      if (row && t.dataset.f === "on") { const r = UI.draft.rules[row.dataset.id]; if (r) { r.on = t.checked; paintSave(); schedulePreview(); } }
    });
    m.addEventListener("focusout", (e) => {                       // re-trie le tableau seulement quand on quitte la zone d'édition
      const box = $("ndRules"); if (box && box.contains(e.target) && !box.contains(e.relatedTarget)) { renderRules(); }
    });
    m.addEventListener("click", async (e) => {
      const b = e.target.closest && e.target.closest("[data-act]"); if (!b) return;
      const a = b.dataset.act;
      if (a === "add") {
        const id = newId(); UI.draft.rules[id] = { from: "", to: "X", on: true }; UI.filter = ""; const f = $("ndFilter"); if (f) f.value = "";
        renderRules(); paintSave(); const i = document.querySelector(`#ndRules .nd-row[data-id="${id}"] [data-f="from"]`); if (i) { i.focus(); if (i.scrollIntoView) i.scrollIntoView({ block: "nearest" }); }
      } else if (a === "del") {
        const row = b.closest(".nd-row"); if (row) { delete UI.draft.rules[row.dataset.id]; renderRules(); paintSave(); schedulePreview(); }
      } else if (a === "export") exportXlsx();
      else if (a === "reset") {
        if (!(await appConfirm("Remplacer le brouillon par le dictionnaire par défaut ? (non enregistré tant que vous ne cliquez pas sur Enregistrer)", { title: "Dictionnaire par défaut", okText: "Remplacer" }))) return;
        const d = defaultData(); UI.draft = { rules: d.rules, opts: { ...d.opts } }; UI.imp = null; buildShell(); renderRules(); refreshPreview(); paintSave();
      } else if (a === "impapply") applyImp();
      else if (a === "impcancel") { UI.imp = null; renderImp(); }
    });
  }

  ND.openSettings = async function () {
    if (!ND.canEdit()) return;
    const root = $("ndRoot"); if (!root) return;
    if (typeof _openSettingsModal === "function") _openSettingsModal("modalNameDict");
    bindUI();
    if (!ND.data) { root.innerHTML = `<div class="nd-empty">Chargement…</div>`; await ND.load(); }
    if (!ND.data) { root.innerHTML = `<div class="nd-dup"><div class="nd-dup-h">${ic("alert", 15)} Impossible de charger le dictionnaire. Les noms d'origine restent affichés.</div></div>`; return; }
    if (!UI.draft) initDraft();                                   // un brouillon non enregistré est conservé si le modal a été refermé
    buildShell(); renderRules(); refreshPreview(); paintSave(); loadCatalog();
  };
  ND.cancel = cancel; ND.save = save;
  ND.initSettings = function () {                                 // appelée depuis app.js / auth.js : la carte n'existe que pour un utilisateur autorisé
    const c = $("nameDictContainer"); if (c) c.style.display = ND.canEdit() ? "" : "none";
  };

  // Chargement au démarrage (sans bloquer l'application)
  ND.load();
})();
