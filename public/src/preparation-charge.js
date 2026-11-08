// ============================================================
// src/preparation-charge.js — Preparation v2, PHASE 2
// Chargement (loaded from Odoo) + Reste (= prepared − loaded) + bons panel.
// ------------------------------------------------------------
// Plugs into GdsPrep2 (preparation.js) only through its extension points:
//   ext.rowExtras / ext.barExtras / ext.model / on("built"|"remote")
// The save style of phase 1 (items/…) is untouched.
//
// Firebase (same node as phase 1, so Training stays isolated via base()):
//   wafa_gds_prep2_{training_}{wh}/meta/charge = {
//     from: "YYYY-MM-DDTHH:mm:ss" (local), to: same (always written; legacy values without seconds stay valid: from → :00, to → :59),
//     (legacy value without « to » = open-ended: still computed/displayed as before; the picker opens it with « À » = 23:59:59 of the start day)
//     by, ts,
//     excluded: { "<pickingId>": true }          // a bon is INCLUDED unless listed here (default = included)
//     (legacy "included" node, if present, is ignored: never read, never written)
//     ood:      { "<pickingId>": { ref, sd } }   // transferts hors date
//   Changing from/to never clears excluded / ood: they stay until the user removes them.
//   }
// Raw Odoo moves are kept in memory only: a toggle recomputes
// instantly with no Odoo call; "Actualiser" re-fetches.
// ============================================================
(function () {
  "use strict";
  const P = window.GdsPrep2;
  if (!P) return;
  const A = P.api, S = P.state;
  const SPECIAL = "— Chargé sans préparation —";
  // ── auto-refresh settings (edit here) ──────────────────────
  const AUTO_EVERY_MS = 3 * 60 * 1000;     // periodic refresh while the section is visible
  const AUTO_STALE_MS = 60 * 1000;         // on tab/page return: refresh only if the last update is older than this
  const NEW_BADGE_MS  = 5 * 60 * 1000;     // how long the "Nouveau" badge stays on a bon
  const TOAST_MS      = 6000;              // how long the "new bons" notice stays
  const LIM_MAIN = 20000, LIM_OOD = 10000;           // query limits (a warning is shown when reached, data is never cut silently)
  const MSG_ICON = { ok: "check", warn: "warn", err: "xcircle" };
  const STATE_FR = { draft: "Brouillon", waiting: "En attente", confirmed: "En attente", assigned: "Prêt", cancel: "Annulé" };

  // ── memory cache (per warehouse) ───────────────────────────
  const C = { wh: null, loaded: false, loading: false, moves: [], pickings: {}, info: {}, agg: {},
              from: null, to: null, at: 0, panelOpen: false, rangeOpen: false, oodRow: false, msg: "", msgK: "", warn: "", adding: false,
              gen: 0, queued: false, tryAt: 0, sync: { k: "idle", err: "" }, known: null, fresh: {}, toast: null, pendingBuild: false };
  function resetCache() {          // gen++ makes any fetch still in flight discard its (obsolete) result
    Object.assign(C, { loaded: false, moves: [], pickings: {}, info: {}, agg: {}, from: null, to: null, at: 0, msg: "", msgK: "", warn: "", gen: C.gen + 1, known: null, fresh: {} });
  }
  function ensureWh() { if (C.wh !== S.wh) { resetCache(); C.wh = S.wh; } }

  // ── shared state accessors ─────────────────────────────────
  const charge   = () => S.meta.charge || {};
  const excluded = () => charge().excluded || {};
  const oodMap   = () => charge().ood || {};
  const isInc    = (id) => !excluded()[id];          // included by default; only the worker's manual switch-offs are stored

  // ── column visibility (per browser/user, per warehouse) ────
  const colsKey = () => `gp2_cols_${S.wh}`;
  const cols = () => Object.assign({ charge: true, reste: true }, A.lsGet(colsKey(), {}));

  // ── helpers ────────────────────────────────────────────────
  // Canonical local period value: "YYYY-MM-DDTHH:mm:ss". A value saved before seconds existed ("…THH:mm") stays valid:
  // a start gets ":00", an end gets ":59" (so the end minute is fully included). Date-only: start 00:00:00, end 23:59:59.
  function normIso(iso, isEnd) {
    if (!iso) return "";
    const [dp, tp = ""] = String(iso).split("T");
    if (!tp) return `${dp}T${isEnd ? "23:59:59" : "00:00:00"}`;
    const [h = "0", mi = "0", sec] = tp.split(":");
    const ss = (sec == null || sec === "") ? (isEnd ? 59 : 0) : +sec;
    const p = (n) => String(n || 0).padStart(2, "0");
    return `${dp}T${p(+h)}:${p(+mi)}:${p(ss)}`;
  }
  const normFrom = (iso) => normIso(iso, false);
  const normTo = (iso) => normIso(iso, true);
  // « À » shown in the picker: a legacy period saved without « to » opens with 23:59:59 of the start day
  const pickerTo = (ch) => ch.to ? normTo(ch.to) : (ch.from ? normTo(normFrom(ch.from).slice(0, 10)) : "");
  // local "YYYY-MM-DDTHH:mm[:ss]" → UTC "YYYY-MM-DD HH:mm:ss" (second-accurate)
  function isoLocalToOdoo(iso, isEnd) {
    if (!iso) return null;
    const [dp, tp] = normIso(iso, !!isEnd).split("T");
    const [y, m, d] = dp.split("-"), [h, mi, sec] = tp.split(":");
    return new Date(+y, +m - 1, +d, +h, +mi, +sec).toISOString().replace("T", " ").slice(0, 19);
  }
  function qtyTxt(n, sz) {                       // "3 C · 5 U", "−2 C", "0"
    const neg = n < 0, a = Math.round(Math.abs(n) * 100) / 100;
    if (!a) return "0";
    let t;
    if (sz > 0 && a >= sz) {
      const c = Math.floor(a / sz), u = Math.round(a - c * sz);
      t = u ? `${A.fmt(c)} C · ${A.fmt(u)} U` : `${A.fmt(c)} C`;
    } else t = `${A.fmt(a)} U`;
    return neg ? "−" + t : t;
  }
  const catalogIds = () => new Set(S.raw.map(p => p.id));
  function extraPids() {                         // loaded products absent from the catalogue
    const cat = catalogIds(), out = new Set();
    C.moves.forEach(m => { const pid = m.product_id?.[0]; if (pid && !cat.has(pid)) out.add(pid); });
    return [...out].sort((a, b) => a - b);
  }
  const extraSig = () => extraPids().join(",");
  const rootEl = () => S.root?.querySelector(".gp2-root");
  const $ = (id) => document.getElementById(id);

  function recompute() {                         // instant, no Odoo
    const agg = {};
    C.moves.forEach(m => {
      const pk = C.pickings[m.picking_id?.[0]], pid = m.product_id?.[0];
      if (!pk || !pid || !isInc(pk.id)) return;
      agg[pid] = (agg[pid] || 0) + (m.qty_done || 0);
    });
    C.agg = agg;
  }

  // ── Odoo fetching ──
  async function fetchPickings(ids, ood) {
    const rows = await A.rpc("stock.picking", "search_read", [[["id", "in", ids]]],
      { fields: ["id", "name", "partner_id", "date_done", "location_dest_id"], limit: Math.max(500, ids.length) });
    const map = {};
    rows.forEach(p => { if (p.name) p.name = p.name.replace(/^"|"$/g, ""); if (ood) p._outOfDate = true; map[p.id] = p; });
    return map;
  }
  function tagVans(moves, map) {                 // van name from the first move of each picking
    moves.forEach(m => {
      const pk = map[m.picking_id?.[0]], full = m.location_dest_id?.[1] || "";
      if (pk && full && full !== "—" && (!pk.vanRaw || pk.vanRaw === "—")) { pk.vanRaw = full; pk.van = _cleanVanName(full); }
    });
    Object.values(map).forEach(p => { if (!p.van || p.van === "—") p.van = _cleanVanName(p.name || "—"); });
    // display only: time of the bon = earliest move date (fallback date_done), used for the day / JUM label
    const utc = (v) => new Date(String(v).replace(" ", "T") + "Z").getTime();
    moves.forEach(m => {
      const pk = map[m.picking_id?.[0]]; if (!pk || !m.date) return;
      const t = utc(m.date); if (!isNaN(t) && (pk._t == null || t < pk._t)) pk._t = t;
    });
    Object.values(map).forEach(p => { if (p._t == null && p.date_done) { const t = utc(p.date_done); if (!isNaN(t)) p._t = t; } });
  }
  async function fetchOod(ids) {                 // out-of-range transfers → treated like any other bon
    if (!ids.length) return { moves: [], map: {}, truncated: false };
    const moves = await A.rpc("stock.move.line", "search_read", [[["picking_id", "in", ids], ["state", "=", "done"]]],
      { fields: ["product_id", "qty_done", "picking_id", "location_dest_id", "date"], limit: LIM_OOD });
    const map = await fetchPickings(ids, true);
    tagVans(moves, map);
    return { moves, map, truncated: moves.length >= LIM_OOD };
  }
  // Nom affiché d'un produit « chargé sans préparation » : recalculé à la lecture pour suivre le dictionnaire
  const infoName = (i) => !i ? "" : (!i.full || typeof NameDict === "undefined") ? i.name : NameDict.shortName(i.full);
  async function ensureInfo(moves) {             // names + colisage for products missing from the catalogue
    const cat = catalogIds();
    const need = [...new Set(moves.map(m => m.product_id?.[0]).filter(pid => pid && !cat.has(pid) && !C.info[pid]))];
    if (!need.length) return;
    const [prods, pk] = await Promise.all([
      A.rpc("product.product", "search_read", [[["id", "in", need]]],
        { fields: ["id", "name", "default_code", "categ_id"], limit: 500, context: { active_test: false } }),
      A.rpc("product.packaging", "search_read", [[["product_id", "in", need]]], { fields: ["product_id", "qty"], limit: 2000 }),
    ]);
    prods.forEach(p => { C.info[p.id] = { name: _productDisplayName(p, { short: true }) || `pid:${p.id}`, full: _productOdooName(p), code: p.default_code || "", pkg: 0 }; });
    pk.forEach(x => { const pid = x.product_id?.[0]; if (!pid) return; (C.info[pid] || (C.info[pid] = { name: `pid:${pid}`, code: "", pkg: 0 })).pkg = Math.round(x.qty) || 0; });
    need.forEach(pid => { if (!C.info[pid]) C.info[pid] = { name: `pid:${pid}`, code: "", pkg: 0 }; });
  }

  // typing guard: never rebuild the table under a field the worker is typing in
  const isTyping = () => { const a = document.activeElement; return !!(a && S.root && S.root.contains(a) && a.classList && a.classList.contains("gp2-in")); };
  function rebuildOrRepaint(rebuild) {
    if (rebuild && isTyping()) { C.pendingBuild = true; repaintAll(); }      // deferred until the field loses focus
    else if (rebuild) { C.pendingBuild = false; A.buildUI(); }
    else repaintAll();
  }
  function setSync(k, err) { C.sync = { k, err: err || "" }; paintSync(); }

  // ONE fetch function: manual button and every automatic trigger call it (opts.auto = silent mode)
  async function fetchCharge(opts) {
    const auto = !!(opts && opts.auto);
    ensureWh();
    if (!A.can("prep_charge_actualiser") || !A.sessionActive()) return;      // no session → no loading
    const ch = charge();
    if (!ch.from) { if (!auto) setMsg("Choisir une date/heure de début", "warn"); return; }
    if (C.loading) { C.queued = true; return; }                  // never two requests at once: run once more when this one ends
    C.loading = true; C.tryAt = Date.now();
    const gen = C.gen, before = extraSig();
    setSync("loading"); if (!auto) setMsg("Chargement…");
    let done = false;
    try {
      const src = _getPrepSourceLocationId(), parent = _getVanLocationParent();
      if (!src) throw new Error("Emplacement source introuvable");
      const vanLocs = (await A.rpc("stock.location", "search_read",
        [[["location_id", "=", parent], ["usage", "=", "internal"]]], { fields: ["id"], limit: 200 })).map(l => l.id);
      if (!vanLocs.length) throw new Error("Aucun emplacement van trouvé");

      const odooFrom = isoLocalToOdoo(ch.from, false), odooTo = isoLocalToOdoo(ch.to, true);
      const moves = await A.rpc("stock.move.line", "search_read", [[
        ["location_id", "=", src], ["location_dest_id", "in", vanLocs], ["state", "=", "done"],
        ["date", ">=", odooFrom], ...(odooTo ? [["date", "<=", odooTo]] : []),
      ]], { fields: ["product_id", "qty_done", "product_uom_id", "date", "lot_id", "picking_id", "location_dest_id"], limit: LIM_MAIN });
      const warns = [];
      if (moves.length >= LIM_MAIN) warns.push(`Limite de ${A.fmt(LIM_MAIN)} lignes atteinte : les chargements sont incomplets. Réduisez la période.`);

      const pids = [...new Set(moves.map(m => m.picking_id?.[0]).filter(Boolean))];
      const map = pids.length ? await fetchPickings(pids, false) : {};
      tagVans(moves, map);

      const oodIds = Object.keys(oodMap()).map(Number).filter(Boolean);
      try {
        const o = await fetchOod(oodIds.filter(id => !map[id]));
        o.moves.forEach(m => moves.push(m)); Object.assign(map, o.map);
        if (o.truncated) warns.push(`Limite de ${A.fmt(LIM_OOD)} lignes atteinte pour les bons hors date : données incomplètes.`);
      } catch (e) { console.warn("[Prep2] hors date:", e); warns.push("Échec du chargement des bons hors date."); }

      await ensureInfo(moves);
      if (gen !== C.gen) return;                                 // range / warehouse changed meanwhile → obsolete result, drop it

      // new bons since the previous load of the same range → badge + light notice (hors date bons added by hand are not "new")
      const ids = Object.keys(map).map(Number), oodSet = new Set(oodIds);
      if (C.known) {
        const nu = ids.filter(id => !C.known.has(id) && !oodSet.has(id) && !map[id]._outOfDate);
        nu.forEach(id => { C.fresh[id] = Date.now(); });
        if (nu.length) showToast(`${nu.length} nouveau(x) bon(s) ajouté(s)`);
      }
      C.known = new Set([...(C.known || []), ...ids]);

      C.moves = moves.filter(m => m.picking_id?.[0]); C.pickings = map;
      C.from = ch.from; C.to = ch.to || null; C.loaded = true; C.at = Date.now();
      C.warn = warns.join(" ");
      recompute();
      setMsg(""); setSync("ok"); done = true;
      rebuildOrRepaint(extraSig() !== before);                   // current data is never cleared on failure (see catch)
    } catch (e) {
      console.error("[Prep2] charge:", e);
      setSync("err", e.message || String(e));                    // keep what is on screen, retry on the next cycle
      if (!auto) setMsg("Erreur : " + (e.message || e), "err");
    } finally {
      C.loading = false;
      if (!done && gen !== C.gen && !C.queued) setSync("idle");
      if (C.queued) { C.queued = false; setTimeout(() => fetchCharge({ auto: true }), 0); }
    }
  }

  // ── automatic refresh triggers ─────────────────────────────
  const rootVisible = () => !!(S.root && S.root.isConnected && S.built && S.root.offsetParent !== null);
  function autoRefresh(minAge) {
    ensureWh();
    if (document.hidden || !rootVisible()) return;
    if (minAge && Date.now() - C.tryAt < minAge) return;
    fetchCharge({ auto: true });
  }
  P.on("entered", () => autoRefresh(0));                                              // a) entering the section
  document.addEventListener("visibilitychange", () => { if (!document.hidden) autoRefresh(AUTO_STALE_MS); });   // b) back to the tab
  window.addEventListener("focus", () => autoRefresh(AUTO_STALE_MS));                 // b) back to the window
  window.addEventListener("online", () => autoRefresh(0));                            // f) connection is back
  setInterval(() => autoRefresh(AUTO_EVERY_MS / 2), AUTO_EVERY_MS);                   // c) periodic, only while visible

  // ── actions on shared state ────────────────────────────────
  async function toggleBon(id) {
    if (!A.can("prep_bon_toggle") || !A.sessionActive()) return;
    const on = !isInc(id);                       // on = worker switches it ON → leaves the excluded list
    const ch = S.meta.charge || (S.meta.charge = {});
    const exc = ch.excluded || (ch.excluded = {});
    if (on) delete exc[id]; else exc[id] = true;
    delete C.fresh[id];
    recompute(); repaintAll();                   // instant — no Odoo
    try { await A.fbPatch("/meta/charge/excluded", { [id]: on ? null : true }); }
    catch (e) {
      A.notify("Échec de l'enregistrement du bon", "error");
      if (on) exc[id] = true; else delete exc[id];
      recompute(); repaintAll();
    }
  }

  async function saveRange() {
    const fEl = $("gcFrom"), tEl = $("gcTo"); if (!fEl || !tEl) return;
    if (!A.sessionActive()) return;
    const from = fEl.value ? normFrom(fEl.value) : null, to = tEl.value ? normTo(tEl.value) : null, cur = charge();
    const revert = () => { fEl.value = normFrom(cur.from); tEl.value = pickerTo(cur); };
    const fail = (m) => { A.notify(m, "error"); setMsg(m, "err"); revert(); };
    if (!from) return fail("Date de début obligatoire");
    if (!to) return fail("Date de fin obligatoire");
    if (to <= from) return fail("« À » doit être strictement après « Depuis »");
    if (from === (normFrom(cur.from) || null) && to === (normTo(cur.to) || null)) return;
    // The range may span several days. Changing it NEVER wipes the excluded list or the hors-date transfers.
    const body = { from, to, by: A.userName(), ts: { ".sv": "timestamp" } };
    const nc = Object.assign({}, cur, { from, to, by: A.userName(), ts: Date.now() });
    S.meta.charge = nc;
    resetCache(); C.wh = S.wh; recompute();
    if (extraSig() !== "") A.buildUI(); else repaintAll();
    try { await A.fbPatch("/meta/charge", body); setMsg("Période enregistrée", "ok"); fetchCharge({ auto: true }); }     // d) refresh after a range change
    catch (e) { A.notify("Échec de l'enregistrement de la période", "error"); setMsg("Échec de l'enregistrement de la période", "err"); }
  }

  // ── hors date (out-of-range transfers) ─────────────────────
  async function addOod() {
    const inp = $("gcOodRef"), ref = (inp?.value || "").trim();
    if (!A.can("prep_hors_date_add") || C.adding || !A.sessionActive()) return;
    if (!ref) { setMsg("Saisissez la référence du bon", "err"); return; }
    C.adding = true; setMsg("Vérification…");
    let pk = null, ch = null;
    try {
      // no date condition. Some Odoo names are stored with surrounding quotes → try both forms
      const r = await A.rpc("stock.picking", "search_read", [[["name", "in", [ref, `"${ref}"`]]]],
        { fields: ["id", "name", "scheduled_date", "state"], limit: 5 });
      if (!r.length) { setMsg(`Bon introuvable : ${ref}`, "err"); return; }
      pk = r.find(x => x.state === "done") || r[0];
      const name = String(pk.name || ref).replace(/^"|"$/g, "");
      if (pk.state !== "done") { setMsg(`Bon non validé : ${name} (état : ${STATE_FR[pk.state] || pk.state})`, "err"); pk = null; return; }
      if (oodMap()[pk.id]) { setMsg(`Bon déjà ajouté hors date : ${name}`, "err"); pk = null; return; }
      if (C.pickings[pk.id] && !C.pickings[pk.id]._outOfDate) { setMsg(`Bon déjà dans la période : ${name} — utilisez son interrupteur`, "err"); pk = null; return; }
      const entry = { ref: name, sd: pk.scheduled_date || null };
      ch = S.meta.charge || (S.meta.charge = {});
      (ch.ood || (ch.ood = {}))[pk.id] = entry;
      try { await A.fbPatch("/meta/charge/ood", { [pk.id]: entry }); }
      catch (e) { delete ch.ood[pk.id]; setMsg("Échec de l'enregistrement du bon hors date", "err"); pk = null; return; }
      if (inp) inp.value = "";
      if (charge().from) { setMsg(`Bon ajouté hors date : ${name}`, "ok"); fetchCharge({ auto: true }); }    // e) refresh after adding (the bon is included by default)
      else setMsg(`Bon ajouté hors date : ${name} — choisissez la période`, "ok");
      renderOodModal();
    } catch (e) { setMsg("Erreur : " + (e.message || e), "err"); }
    finally { C.adding = false; }
  }

  // remove ids from the shared hors-date list (keeps an id that is also a normal in-period bon)
  function dropOodLocal(ids) {
    const ch = charge(), dropped = [];
    ids.forEach(id => {
      if (ch.ood) delete ch.ood[id];
      const pk = C.pickings[id];
      if (!pk || pk._outOfDate) { dropped.push(id); }
      if (ch.excluded) delete ch.excluded[id];                  // keep the excluded list clean
    });
    if (dropped.length) {
      C.moves = C.moves.filter(m => !dropped.includes(m.picking_id?.[0]));
      dropped.forEach(id => delete C.pickings[id]);
    }
    return dropped;
  }
  async function removeOod(id) {
    if (!A.can("prep_hors_date") || !A.sessionActive()) return;
    const before = extraSig(), dropped = dropOodLocal([id]);
    recompute();
    if (extraSig() !== before) A.buildUI(); else repaintAll();
    renderOodModal();
    try {
      await A.fbPatch("/meta/charge/ood", { [id]: null });
      await A.fbPatch("/meta/charge/excluded", { [id]: null });
      setMsg("Bon retiré de la liste hors date", "ok");
    } catch (e) { A.notify("Échec de la suppression", "error"); setMsg("Échec de la suppression", "err"); }
  }
  async function clearOod() {
    if (!A.can("prep_hors_date") || !A.sessionActive()) return;
    const ids = Object.keys(oodMap()).map(Number); if (!ids.length) return;
    if (!(await appConfirm(`Retirer les ${ids.length} bon(s) hors date de la liste pour tous les utilisateurs ?`, { title: "Retirer les bons hors date", okText: "Retirer", danger: true }))) return;
    const before = extraSig(), dropped = dropOodLocal(ids);
    recompute();
    if (extraSig() !== before) A.buildUI(); else repaintAll();
    renderOodModal();
    try {
      await A.fbPatch("/meta/charge", { ood: null });
      const nm = {}; ids.forEach(id => { nm[id] = null; }); await A.fbPatch("/meta/charge/excluded", nm);
      setMsg("Liste hors date vidée", "ok");
    } catch (e) { A.notify("Échec de la suppression", "error"); setMsg("Échec de la suppression", "err"); }
  }

  // ── hors date list (modal) ─────────────────────────────────
  const p2 = (n) => String(n).padStart(2, "0");

  // ── display labels (multi-day range): day + JUM, display only — pk.name / excluded keys are never touched ──
  const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  function parseLocal(iso) {
    const [dp, tp = "00:00"] = String(iso).split("T"), [y, m, d] = dp.split("-"), [h, mi, sc] = tp.split(":");
    return new Date(+y, +m - 1, +d, +h || 0, +mi || 0, +sc || 0);
  }
  function isMulti() {                              // range covers more than one local calendar day
    const ch = charge(); if (!ch.from) return false;
    const a = parseLocal(ch.from); let b = ch.to ? parseLocal(ch.to) : new Date();
    if (ch.to && b > a && b.getHours() === 0 && b.getMinutes() === 0) b = new Date(+b - 60000);   // ends exactly at midnight → previous day
    return ymd(a) !== ymd(b);
  }
  // ── period popover (calendar button) ───────────────────────
  const dm = (iso) => { const d = parseLocal(iso); return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`; };
  const dfull = (iso) => { const d = parseLocal(iso); return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
  function paintRange() {
    const t = $("gcRangeTxt"); if (!t) return;
    const ch = charge(), dot = $("gcRangeDot"), b = $("gcRangeBtn");
    t.textContent = ch.from ? `${dm(ch.from)} →${ch.to ? " " + dm(ch.to) : ""}` : "Période";
    if (dot) dot.hidden = !isMulti();
    if (b) { const tip = ch.from ? `Période : ${dfull(ch.from)} → ${ch.to ? dfull(ch.to) : "maintenant"}` : "Choisir la période"; b.title = tip; b.setAttribute("aria-label", tip); }
  }
  function rangeErr() {
    const f = $("gcFrom"), t = $("gcTo"); if (!f || !t) return "";
    if (!f.value) return "Date de début obligatoire";
    if (!t.value) return "Date de fin obligatoire";
    if (t.value <= f.value) return "« À » doit être strictement après « Depuis »";
    return "";
  }
  function validateRange() {
    const m = rangeErr(), e = $("gcRangeErr"), a = $("gcRangeApply");
    if (e) { e.textContent = m; e.hidden = !m; }
    if (a) a.disabled = !!m;
    return !m;
  }
  // The calendar itself (grid, month nav, « Depuis » / « À » badges, time fields, summary, bottom sheet…) is the shared
  // AppDatePicker (src/ui-datepicker.js, mode "range"). The hidden #gcFrom / #gcTo remain the single value carrier
  // ("YYYY-MM-DDTHH:mm:ss", local), so rangeErr / validateRange / saveRange / syncInputs (validation, save, fetch, remote guard) are unchanged.
  function openRange() {
    const b = $("gcRangeBtn"); if (!b || !window.AppDatePicker) return;
    syncInputs(true);                           // always start from the saved period
    AppDatePicker.open(b, {
      mode: "range", withTime: true,
      value: { from: $("gcFrom")?.value || "", to: $("gcTo")?.value || "" },
      onApply: applyRange,
      onClose: () => { C.rangeOpen = false; syncInputs(true); },   // closing without « Appliquer » discards the draft: nothing saved, nothing fetched
    });
    C.rangeOpen = AppDatePicker.isOpen();
  }
  function closeRange() { if (window.AppDatePicker) AppDatePicker.close(); }
  function applyRange(v) {                      // « Appliquer »: draft → carriers → same validation / save / refetch as before; the picker then closes (carriers re-synced)
    const f = $("gcFrom"), t = $("gcTo"); if (!f || !t) return;
    f.value = v.from; t.value = v.to;
    if (!validateRange()) return;
    return saveRange();                         // unchanged logic: validates, saves the shared period, then refetches
  }
  function vanKey(pk) {                             // same key as the jumlage detection: van name without "(n)"
    const clean = (v) => String(v || "").replace(/^"|"$/g, "").replace(/\s*\(\d+\)\s*$/, "").trim().toLowerCase();
    const v = clean(pk.van);
    return v && v !== "—" ? v : clean(pk.partner_id?.[1]);
  }
  function labels() {
    const multi = isMulti(), byId = {};
    if (!multi) return { multi, byId };
    const groups = {};
    Object.values(C.pickings).forEach(pk => {
      if (pk._t == null) return;
      const d = new Date(pk._t), day = ymd(d), key = vanKey(pk) + "|" + day;
      (groups[key] || (groups[key] = [])).push(pk);
      byId[pk.id] = { day, date: `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`, jum: 0 };
    });
    Object.values(groups).forEach(a => {            // per (distributor, day), by time: first = plain, then JUM 1, JUM 2…
      a.sort((x, y) => x._t - y._t || x.id - y.id);
      a.forEach((pk, i) => { byId[pk.id].jum = i; });
    });
    return { multi, byId };
  }
  function tagHtml(id, L) {
    const l = (L || labels()).byId[id]; if (!l) return "";
    return `<span class="gp2-bd">· ${l.date}</span>` + (l.jum ? `<span class="gp2-jum">JUM ${l.jum}</span>` : "");
  }
  function oodDate(sd) {
    if (!sd) return "";
    const t = new Date(String(sd).replace(" ", "T") + "Z");
    return isNaN(t) ? String(sd).slice(0, 16) : `${p2(t.getDate())}/${p2(t.getMonth() + 1)}/${t.getFullYear()} ${p2(t.getHours())}:${p2(t.getMinutes())}`;
  }
  function oodBody() {
    const m = oodMap(), ids = Object.keys(m), canR = A.can("prep_hors_date");
    if (!ids.length) return `<div class="gp2m-none">Aucun transfert hors date</div>`;
    return ids.map(id => {
      const e = m[id] || {}, pk = C.pickings[id];
      const st = pk ? (isInc(+id) ? "Inclus" : "Exclu") : "Pas encore chargé";
      const meta = [oodDate(e.sd), st].filter(Boolean).join(" · ");
      return `<div class="gp2o-row"><div class="gp2o-i"><span class="gp2o-ref">${A.ic("clock")} ${A.esc(e.ref || id)}${pk ? tagHtml(+id) : ""}</span><span class="gp2o-sub">${A.esc(meta)}</span></div>
        ${canR ? `<button type="button" class="gp2-btn gp2-btn-sm gp2o-rm" data-gc="oodrm" data-id="${A.esc(id)}">${A.ic("x")} Retirer</button>` : ""}</div>`;
    }).join("");
  }
  function renderOodModal() {
    const m = $("gp2OodModal"); if (!m) return;
    m.querySelector("#gp2OodBody").innerHTML = oodBody();
    const n = Object.keys(oodMap()).length, clr = m.querySelector('[data-gc="oodclear"]');
    if (clr) clr.hidden = !n || !A.can("prep_hors_date");
    paintOodBtn();
  }
  function closeOodModal() { $("gp2OodModal")?.remove(); }
  function openOodModal() {
    if (!A.can("prep_hors_date")) return;
    let m = $("gp2OodModal");
    if (!m) {
      m = document.createElement("div"); m.id = "gp2OodModal"; m.className = "gp2m";
      m.innerHTML = `<div class="gp2m-box" role="dialog"><div class="gp2m-h"><span>Transferts hors date</span><button type="button" class="gp2m-x" data-gc="oodclose" aria-label="Fermer">${A.ic("x")}</button></div>
        <div class="gp2m-b" id="gp2OodBody"></div>
        <div class="gp2m-f"><button type="button" class="gp2-btn" data-gc="oodclear">Tout retirer</button><button type="button" class="gp2-btn" data-gc="oodclose">Fermer</button></div></div>`;
      m.addEventListener("click", (e) => {
        if (e.target === m) { closeOodModal(); return; }
        const b = e.target.closest("[data-gc]"); if (!b) return;
        const a = b.dataset.gc;
        if (a === "oodclose") closeOodModal();
        else if (a === "oodrm") removeOod(+b.dataset.id);
        else if (a === "oodclear") clearOod();
      });
      document.body.appendChild(m);
    }
    renderOodModal();
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeOodModal(); });

  // ── UI pieces ──────────────────────────────────────────────
  const rowExtra = (key, label) => ({
    key,
    render: () => `<div class="gp2c gp2c-${key === "charge" ? "ch" : "re"}"><span class="gp2-cap">${label}</span><b></b></div>`,
    update(pid, row) {
      ensureWh();
      const sz = A.sizeOf(pid), loaded = C.agg[pid] || 0, prep = A.totalOf(pid);
      const el = row.querySelector(key === "charge" ? ".gp2c-ch b" : ".gp2c-re b"); if (!el) return;
      if (key === "charge") {
        el.textContent = loaded ? qtyTxt(loaded, sz) : "0";
        // product loaded from Odoo but not in the catalogue → lives under SPECIAL; hide while nothing is loaded/prepared
        row.classList.toggle("gp2-ghost", row.closest(".gp2-cat")?.dataset.cat === SPECIAL && !loaded && !prep);
      } else {
        const reste = prep - loaded;
        el.textContent = (!prep && !loaded) ? "0" : qtyTxt(reste, sz);
        el.parentElement.classList.toggle("gp2c-neg", reste < 0);
        el.parentElement.classList.toggle("gp2c-zero", reste === 0 && (prep || loaded) > 0);
      }
    },
  });
  P.ext.rowExtras.push(rowExtra("charge", "Chargement"), rowExtra("reste", "Reste"));

  // “— Chargé sans préparation —” category (products loaded but unknown to the catalogue)
  P.ext.model.push((model) => {
    ensureWh();
    const extra = extraPids(); if (!extra.length) return;
    extra.forEach(pid => { const i = C.info[pid]; if (i?.pkg) S.size[pid] = i.pkg; });
    model.push({ cat: SPECIAL, list: extra.map(pid => ({ pid, code: C.info[pid]?.code || "", name: infoName(C.info[pid]) || `pid:${pid}`, full: C.info[pid]?.full || "", order: 0 }))
      .sort((a, b) => a.name.localeCompare(b.name)) });
  });

  P.ext.barExtras.push({ key: "charge", render() {
    ensureWh();
    const ch = charge(), c = cols();
    return `
      <div class="gp2-menu"><button type="button" class="gp2-btn" data-gc="colsmenu">Colonnes ${A.ic("chevron")}</button>
        <div class="gp2-panel" id="gcColsPanel" hidden>
          <label class="gp2-chk"><input type="checkbox" data-gc="col" data-col="charge" ${c.charge ? "checked" : ""}> Chargement</label>
          <label class="gp2-chk"><input type="checkbox" data-gc="col" data-col="reste" ${c.reste ? "checked" : ""}> Reste</label></div></div>
      <div class="gp2c-bar">
        <div class="gc-range" data-perm="prep_depuis_a">
          <button type="button" class="gp2-btn gp2c-rbtn" id="gcRangeBtn" data-gc="rangemenu" aria-haspopup="dialog" aria-expanded="false">${A.ic("calendar")}<span class="gp2c-rtxt" id="gcRangeTxt"></span><i class="gp2c-dot" id="gcRangeDot" hidden></i></button>
          <input id="gcFrom" type="hidden" value="${A.esc(normFrom(ch.from))}"><input id="gcTo" type="hidden" value="${A.esc(pickerTo(ch))}">
        </div>
        <button type="button" class="gp2-btn gp2c-refbtn" id="gcRefreshBtn" data-perm="prep_charge_actualiser" data-gc="refresh" title="Actualiser le chargement depuis Odoo">Actualiser<span class="gp2c-sync" id="gcSync"></span></button>
        <button type="button" class="gp2-btn" data-gc="bons" id="gcBonsBtn">Bons</button>
        <button type="button" class="gp2-btn" data-perm="prep_rapport" data-gc="report" id="gcReportBtn" title="Rapport — télécharger un brouillon Excel (rien n'est effacé)" aria-label="Rapport — télécharger un brouillon Excel">${A.ic("filedown")} Rapport</button>
        <button type="button" class="gp2-btn" data-perm="prep_terminer" data-gc="finish" id="gcFinishBtn" title="Terminer — télécharger le rapport Excel" aria-label="Terminer — télécharger le rapport Excel">${A.ic("flag")} Terminer</button>
        <span class="gp2c-msg" id="gcStatus" hidden></span>
        <div class="gp2c-alert" id="gcAlert" hidden></div>
        <div class="gp2c-toast" id="gcToast" hidden></div>
      </div>
      <div class="gp2c-panel" id="gcPanel" hidden>
        <div class="gp2c-ood">
          <button type="button" class="gp2-btn gp2-btn-sm" data-perm="prep_hors_date_add" data-gc="oodshow">${A.ic("plus")} Hors date</button>
          <span id="gcOodRow" data-perm="prep_hors_date_add" hidden><input id="gcOodRef" class="gp2c-ref" type="text" placeholder="BT/26/WF/ORN/00001" autocomplete="off">
            <button type="button" class="gp2-btn gp2-btn-sm" data-gc="oodadd">Ajouter</button></span>
          <button type="button" class="gp2-btn gp2-btn-sm" data-perm="prep_hors_date" data-gc="oodlist" id="gcOodListBtn" disabled>${A.ic("list")} Liste (0)</button>
        </div>
        <div class="gp2c-bons" id="gcBons"></div>
      </div>`;
  } });

  function bonsHtml() {
    const entries = Object.values(C.pickings).sort((a, b) => new Date(a.date_done || 0) - new Date(b.date_done || 0));
    if (!entries.length) return `<div class="gp2c-none">${C.loaded ? "Aucun bon" : "Cliquez Actualiser"}</div>`;
    const cnt = {}, canT = A.can("prep_bon_toggle"), canR = A.can("prep_hors_date"), L = labels();
    return entries.map(pk => {
      const raw = pk.partner_id?.[1] || "Inconnu", clean = _cleanPartnerName(raw);
      let label = clean;
      if (!L.multi) { cnt[raw] = (cnt[raw] || 0) + 1; label = cnt[raw] === 1 ? clean : `${clean} (${cnt[raw]})`; }   // single day: unchanged
      const on = isInc(pk.id), lb = L.byId[pk.id];
      return `<div class="gp2c-bon${on ? " on" : ""}${canT ? "" : " ro"}" data-gc="bon" data-id="${pk.id}" title="${A.esc(pk.name)} — ${A.esc(pk.van || "")}${lb ? " — " + lb.date : ""}">
        <span class="gp2c-bn">${pk._outOfDate ? `<span class="gp2c-ood-tag" title="Hors date">${A.ic("clock")}</span>` : ""}<span class="gp2c-bt">${A.esc(label)}</span>${tagHtml(pk.id, L)}${C.fresh[pk.id] && Date.now() - C.fresh[pk.id] < NEW_BADGE_MS ? `<span class="gp2-new">Nouveau</span>` : ""}</span>
        ${pk._outOfDate && canR ? `<button type="button" class="gp2c-x" data-gc="oodrm" data-id="${pk.id}" title="Retirer" aria-label="Retirer">${A.ic("x")}</button>` : ""}
        <i class="gp2c-sw"></i></div>`;
    }).join("");
  }

  function setMsg(t, k) { C.msg = t || ""; C.msgK = t ? (k || "") : ""; paintStatus(); }
  function paintAlert() {
    const el = $("gcAlert"); if (!el) return;
    if (C.warn) { el.innerHTML = `${A.ic("warn")}<span>${A.esc(C.warn)}</span>`; el.hidden = false; }
    else { el.innerHTML = ""; el.hidden = true; }
  }
  function hhmm2(t) { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; }
  function fullDt(t) { const d = new Date(t); return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`; }
  function paintSync() {                      // hh:mm + state icon live INSIDE the Actualiser button; the full date goes in its tooltip
    const el = $("gcSync"); if (!el) return;
    const k = C.sync.k, hm = C.at ? hhmm2(C.at) : "";
    let icon = "", cls = "gp2c-sync", tip = "Actualiser le chargement depuis Odoo" + (C.at ? `\nDernière màj : ${fullDt(C.at)}` : "\nAucune mise à jour");
    if (k === "loading") { icon = A.ic("refresh", "gp2-spin"); cls += " busy"; tip += "\nActualisation en cours…"; }
    else if (k === "ok") { icon = A.ic("check"); cls += " ok"; }
    else if (k === "err") { icon = A.ic("xcircle"); cls += " err"; tip += "\nÉchec, nouvel essai" + (C.sync.err ? " : " + C.sync.err : ""); }
    el.className = cls;
    el.innerHTML = icon + (hm ? `<span>${hm}</span>` : "");
    const b = $("gcRefreshBtn"); if (b) b.title = tip;
  }
  function showToast(t) { C.toast = { t, until: Date.now() + TOAST_MS }; paintToast(); setTimeout(paintToast, TOAST_MS + 50); }
  function paintToast() {
    const el = $("gcToast"); if (!el) return;
    const on = C.toast && Date.now() < C.toast.until;
    if (on) { el.innerHTML = `${A.ic("check")}<span>${A.esc(C.toast.t)}</span>`; el.hidden = false; }
    else { el.innerHTML = ""; el.hidden = true; }
  }
  function paintOodBtn() {
    const b = $("gcOodListBtn"); if (!b) return;
    const n = Object.keys(oodMap()).length;
    b.innerHTML = `${A.ic("list")} Liste (${n})`; b.disabled = !n;
  }
  function paintStatus() {
    const el = $("gcStatus"); if (!el) return;
    const n = Object.keys(C.pickings).length, k = Object.keys(C.pickings).filter(id => isInc(+id)).length;
    const sum = C.loaded ? `${n} bon(s) — ${k} inclus — ${new Date(C.at).toLocaleTimeString("fr-FR")}` : (charge().from ? "Cliquez Actualiser" : "");
    const kind = C.msg && C.msgK ? C.msgK : "", loud = kind === "err" || kind === "warn";
    el.className = "gp2c-msg" + (loud ? " " + kind : "");      // errors / warnings stay visible; everything else moves to the Bons tooltip
    el.hidden = !loud;
    el.innerHTML = loud ? A.ic(MSG_ICON[kind]) + " " + A.esc(C.msg) : "";
    const b = $("gcBonsBtn");
    if (b) { b.textContent = C.loaded ? `Bons (${k}/${n})` : "Bons"; b.title = [!loud ? C.msg : "", sum].filter(Boolean).join(" — ") || "Bons"; }
    paintAlert(); paintOodBtn(); paintSync(); paintToast(); paintRange();
  }
  function paintBons() { const el = $("gcBons"); if (el) el.innerHTML = bonsHtml(); }
  function fitBar() {
    const bar = S.root?.querySelector(".gp2-bar"), r = rootEl();
    if (bar && r) r.style.setProperty("--gp2-bar-h", bar.offsetHeight + "px");
  }
  function applyCols() {
    const r = rootEl(); if (!r) return; const c = cols();
    r.classList.toggle("gp2-hide-charge", !c.charge); r.classList.toggle("gp2-hide-reste", !c.reste);
  }
  function repaintAll() {
    const r = rootEl(); if (!r) return;
    r.classList.toggle("gp2-nocharge", !C.loaded);
    Object.entries(S.rows).forEach(([pid, row]) => P.ext.rowExtras.forEach(x => x.update && x.update(+pid, row)));
    paintBons(); paintStatus();
    if (A.applyVisibility) A.applyVisibility();      // loaded quantities keep a product visible
  }
  function syncInputs(force) {
    if (C.rangeOpen && !force) return;          // the user is editing a draft in the popover: a remote update must not overwrite it
    const f = $("gcFrom"), t = $("gcTo"), ch = charge();
    if (f && (force || document.activeElement !== f)) f.value = normFrom(ch.from);
    if (t && (force || document.activeElement !== t)) t.value = pickerTo(ch);
  }

  // ── Terminer: Excel report (download only — nothing is cleared or locked) ──
  // Grouping by category, UI category order (_sortCats) and product order (_productCustomOrder) — both already in the DOM order.
  // The bundled SheetJS (0.18.5 community) cannot write cell styles nor frozen panes, so the workbook is written by a minimal OOXML writer (store-only zip).
  // Colisage (carton size) is NOT exported in any sheet.
  const X_HDR = ["Catégorie", "Produit", "Prép. Colis", "Prép. U", "Charg. Colis", "Charg. U", "Reste Colis", "Reste U"];     // sheet 1 « Tout »
  const X_W = [24, 40, 11, 11, 11, 11, 11, 11];
  const M_HDR = ["Produit", "Reste Colis", "Reste U"];                      // sheet 2 « Mouvement »: two blocks side by side
  const M_W = [32, 8, 8, 2, 32, 8, 8];                                      // [Produit | Colis | U] [gap] [Produit | Colis | U]
  const M_ROW_H = 13, M_TITLE_H = 36, M_HEAD_H = 26;                       // points (font 10); the title takes two lines
  const PAGE = { marginIn: 0.4, headIn: 0.2, a4PortraitH: 11.69, paperSize: 9 };   // A4, narrow margins
  const M_AVAIL_H = (PAGE.a4PortraitH - 2 * PAGE.marginIn) * 72;           // printable height (pt) of the portrait page
  const ST = { def: 0, head: 1, cat: 2, txt: 3, num: 4, neg: 5, lab: 6, val: 7, title: 8, title2: 9, title3: 10, valw: 11 };      // cellXfs indexes (see X_STYLES)
  const xEsc = (s) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const colL = (i) => { let n = i + 1, s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const X_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="7"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFC00000"/><name val="Calibri"/></font><font><b/><sz val="13"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="9"/><name val="Calibri"/></font></fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F2937"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1A6B3A"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD1D5DB"/></left><right style="thin"><color rgb="FFD1D5DB"/></right><top style="thin"><color rgb="FFD1D5DB"/></top><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="1" fontId="3" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  function xCell(r, c, cell) {
    if (!cell) return "";
    const ref = colL(c) + (r + 1), s = cell.s ? ` s="${cell.s}"` : "";
    if (typeof cell.v === "number" && isFinite(cell.v)) return `<c r="${ref}"${s}><v>${cell.v}</v></c>`;     // real numbers (sum / filter work)
    if (cell.v == null || cell.v === "") return `<c r="${ref}"${s}/>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xEsc(cell.v)}</t></is></c>`;
  }
  function xSheet(sh) {
    const rows = sh.rows.map((row, ri) => { const h = (sh.ht && sh.ht[ri]) || sh.rowH; return `<row r="${ri + 1}"${h ? ` ht="${h}" customHeight="1"` : ""}>${row.map((cell, ci) => xCell(ri, ci, cell)).join("")}</row>`; }).join("");
    const n = sh.freeze, last = sh.rows.length, nc = sh.widths.length, pr = sh.print, m = PAGE.marginIn;
    // print settings live in the sheet XML (element order matters): sheetPr/pageSetUpPr, …, printOptions, pageMargins, pageSetup.
    // « repeat header row » is NOT sheet XML: it is the workbook-level defined name _xlnm.Print_Titles (see xWorkbook).
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${colL(nc - 1)}${last}"/>
<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${n}" topLeftCell="A${n + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${n + 1}" sqref="A${n + 1}"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="${sh.rowH || 15}"${sh.rowH ? ' customHeight="1"' : ""}/><cols>${sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>
<sheetData>${rows}</sheetData>${sh.filter ? `<autoFilter ref="${sh.filter}"/>` : ""}${sh.merges && sh.merges.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map(x => `<mergeCell ref="${x}"/>`).join("")}</mergeCells>` : ""}
<printOptions horizontalCentered="1"/><pageMargins left="${m}" right="${m}" top="${m}" bottom="${m}" header="${PAGE.headIn}" footer="${PAGE.headIn}"/><pageSetup paperSize="${PAGE.paperSize}" orientation="${pr.orient}" fitToWidth="${pr.fitW}" fitToHeight="${pr.fitH}"/></worksheet>`;
  }
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zipStore(files) {                       // minimal zip, no compression (xlsx = zip of XML parts)
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    files.forEach(f => {
      const nm = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data), sz = data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(12, 0x21, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, sz, true); lh.setUint32(22, sz, true); lh.setUint16(26, nm.length, true);
      parts.push(new Uint8Array(lh.buffer), nm, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(14, 0x21, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), nm);
      off += 30 + nm.length + sz;
    });
    const csz = central.reduce((a, p) => a + p.length, 0), end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csz, true); end.setUint32(16, off, true);
    const out = new Uint8Array(off + csz + 22); let p = 0;
    [...parts, ...central, new Uint8Array(end.buffer)].forEach(a => { out.set(a, p); p += a.length; });
    return out;
  }
  function xWorkbook(sheets) {
    const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships", H = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const dn = sheets.map((s, i) => s.print && s.print.titleRows ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${xEsc(s.name)}'!$${s.print.titleRows[0]}:$${s.print.titleRows[1]}</definedName>` : "").join("");
    const titles = dn ? `<definedNames>${dn}</definedNames>` : "";
    const files = [
      { name: "[Content_Types].xml", text: H + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
      { name: "_rels/.rels", text: H + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: "xl/workbook.xml", text: H + `<workbook ${NS} xmlns:r="${R}"><sheets>${sheets.map((s, i) => `<sheet name="${xEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${titles}</workbook>` },
      { name: "xl/_rels/workbook.xml.rels", text: H + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="${R}/styles" Target="styles.xml"/></Relationships>` },
      { name: "xl/styles.xml", text: X_STYLES },
    ];
    sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, text: xSheet(s) }));
    return zipStore(files);
  }

  // ── report data (reads the screen model: all products, hidden ones included, UI order and names) ──
  function splitN(n, sz) { const c = sz > 0 ? Math.trunc(n / sz) : 0; return [c, Math.round(n - c * sz)]; }
  function reportData() {
    ensureWh();
    const ready = !!(C.loaded && C.wh === S.wh), cats = [];
    S.root.querySelectorAll(".gp2-cat").forEach(sec => {
      const items = [];
      sec.querySelectorAll(".gp2-row").forEach(r => {
        if (r.classList.contains("gp2-ghost")) return;              // loaded-but-unknown product with nothing loaded / prepared
        const pid = r.dataset.pid, sz = A.sizeOf(pid), pc = A.getC(pid), pu = A.getU(pid), prep = A.totalOf(pid), ld = ready ? (C.agg[pid] || 0) : 0;
        const [lc, lu] = splitN(ld, sz), [rc, ru] = ready ? splitN(prep - ld, sz) : [0, 0];     // same rule as the screen: no Chargement/Reste before the first load
        items.push({ name: r.dataset.nm, sz, pc, pu, lc, lu, rc, ru, prep, ld, mov: prep > 0 || ld > 0 });
      });
      if (items.length) cats.push({ cat: sec.dataset.cat === SPECIAL ? "Chargé sans préparation" : sec.dataset.cat, items });
    });
    const all = cats.flatMap(c => c.items);
    return { ready, cats, nPrep: all.filter(i => i.prep > 0).length, nLoad: all.filter(i => i.ld > 0).length, nMov: all.filter(i => i.mov).length };
  }
  function bonLabels() {                                            // same labels as the Bons panel; only included bons are listed
    const L = labels(), cnt = {}, out = []; let n = 0;
    Object.values(C.pickings).sort((a, b) => new Date(a.date_done || 0) - new Date(b.date_done || 0)).forEach(pk => {
      n++;
      const raw = pk.partner_id?.[1] || "Inconnu", clean = _cleanPartnerName(raw), lb = L.byId[pk.id];
      let label = clean;
      if (!L.multi) { cnt[raw] = (cnt[raw] || 0) + 1; if (cnt[raw] > 1) label = `${clean} (${cnt[raw]})`; }
      else if (lb) label += ` · ${lb.date}` + (lb.jum ? ` JUM ${lb.jum}` : "");
      if (pk._outOfDate) label += " (hors date)";
      if (isInc(pk.id)) out.push(label);
    });
    return { list: out, total: n };
  }
  function reportInfo() {
    const ch = charge(), d = new Date(), wh = typeof _getActiveWarehouse === "function" ? _getActiveWarehouse() : null, training = typeof App !== "undefined" && App.env === "training";
    const bons = C.loaded ? bonLabels() : { list: [], total: 0 };
    return { d, at: `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`,
      user: A.userName(), wh: (wh && (wh.name || wh.code)) || S.wh, training, mode: (A.mode() === "libre" ? "Libre" : "Odoo") + (training ? " — Training" : ""),
      from: ch.from ? dfull(ch.from) : "", to: ch.to ? dfull(ch.to) : "", bons };
  }
  const rangeTxt = (i) => i.from ? `${i.from} → ${i.to || "maintenant"}` : "—";
  function reportFile(i, draft) {
    const clean = String(i.wh).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "wh";
    const d = i.d, stamp = `${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${d.getFullYear()}_${p2(d.getHours())}${p2(d.getMinutes())}`;
    return `${i.training ? "training_" : ""}preparation_${clean}_${stamp}${draft ? "_brouillon" : ""}.xlsx`;
  }
  // mov = the product has a movement: zero is written as a real number 0; without movement a zero stays an empty cell.
  const numC = (v, st, mov) => (mov ? { v: Number(v) || 0, s: st || ST.num } : (v ? { v, s: st || ST.num } : { s: ST.num }));
  function tableRows(data) {                                         // sheet 1: category title row + product rows (all products)
    const rows = [];
    data.cats.forEach(c => {
      if (!c.items.length) return;
      rows.push({ cat: true, cells: [{ v: c.cat, s: ST.cat }, ...X_HDR.slice(1).map(() => ({ s: ST.cat }))] });
      c.items.forEach(i => {       // Prép.: 0 when there is a movement. Chargement / Reste: real values when the load is known (0 when there is a movement), otherwise always empty
        const ld = (v, st) => (data.ready ? numC(v, st, i.mov) : { s: ST.num });
        rows.push({ cells: [{ v: c.cat, s: ST.txt }, { v: i.name, s: ST.txt }, numC(i.pc, null, i.mov), numC(i.pu, null, i.mov), ld(i.lc), ld(i.lu), ld(i.rc, i.rc < 0 ? ST.neg : ST.num), ld(i.ru, i.ru < 0 ? ST.neg : ST.num)] }); });
    });
    return rows;
  }
  // sheet 2 layout: ONE flat list (category title rows + products with movement) cut into two row-balanced halves → left block / right block.
  // The cut never leaves a category title as the last row of the left block (a title is never separated from its first product);
  // if a category continues across the cut, the right block restarts with its title + « (suite) ».
  function mouvementLayout(data) {
    const entries = [];
    data.cats.forEach(c => { const its = c.items.filter(i => i.mov); if (!its.length) return; entries.push({ t: "cat", name: c.cat }); its.forEach(i => entries.push({ t: "prod", i, cat: c.cat })); });
    const n = entries.length; let best = null;
    for (let k = 1; k <= n; k++) {
      if (entries[k - 1].t === "cat") continue;
      const extra = k < n && entries[k].t === "prod" ? 1 : 0, big = Math.max(k, n - k + extra);
      if (!best || big < best.big || (big === best.big && extra < best.extra)) best = { k, big, extra };
    }
    if (!best) return { left: [], right: [], R: 0, scale: 1, pt: 10 };
    const left = entries.slice(0, best.k), right = entries.slice(best.k);
    if (best.extra) right.unshift({ t: "cat", name: right[0].cat + " (suite)" });
    const R = Math.max(left.length, right.length), scale = Math.min(1, M_AVAIL_H / (M_TITLE_H + M_HEAD_H + R * M_ROW_H));
    return { left, right, R, scale, pt: Math.round(100 * scale) / 10 };     // pt = effective font size once printed on ONE page (base 10pt)
  }
  function buildSheets(data, i, draft) {          // draft = « Rapport » (brouillon): same sheets / columns / print setup, only the labels differ
    const head = X_HDR.map(h => ({ v: h, s: ST.head })), lab = (v) => ({ v, s: ST.lab }), val = (v) => ({ v, s: ST.val });
    // ── sheet 1 « Tout »
    const b = tableRows(data), hr = 4, nc = X_HDR.length, merges1 = [];
    const bonsTxt = i.bons.list.join(", ") || "—", bonsLong = bonsTxt.length > 100;       // a long bons list would be cut at the right edge of the page: wrap it inside B:H
    const bonsVal = bonsLong ? { v: bonsTxt, s: ST.valw } : val(bonsTxt);
    const info1 = [      // full header block (single-line values overflow to the right, so the bons list is never cut)
      [lab("Date / heure"), val(i.at + (draft ? " — Brouillon" : "")), lab("Utilisateur"), lab(""), val(i.user)],
      [lab("Entrepôt"), val(i.wh), lab("Mode"), lab(""), val(i.mode)],
      [lab("Période"), val(rangeTxt(i))],
      [lab(`Bons inclus (${i.bons.list.length}/${i.bons.total})`), bonsVal],
    ];
    if (bonsLong) merges1.push("B4:H4");
    b.forEach((r, k) => { if (r.cat) merges1.push(`A${hr + 2 + k}:${colL(nc - 1)}${hr + 2 + k}`); });
    const rows1 = [...info1, head, ...b.map(r => r.cells)];
    const s1 = { name: "Tout", rows: rows1, widths: X_W, freeze: hr + 1, filter: `A${hr + 1}:${colL(nc - 1)}${rows1.length}`, merges: merges1, ht: bonsLong ? { 3: Math.ceil(bonsTxt.length / 100) * 13 + 2, [hr]: 26 } : { [hr]: 26 },
      print: { orient: "landscape", fitW: 1, fitH: 0, titleRows: [hr + 1, hr + 1] } };      // A4 landscape, 1 page wide, as many pages as needed, header row repeated
    // ── sheet 2 « Mouvement »: Reste only, two blocks side by side, ONE A4 portrait page
    const L = mouvementLayout(data), merges2 = ["A1:G1"], hd = M_HDR.map(h => ({ v: h, s: ST.head }));
    const tl1 = `Mouvement${draft ? " (Brouillon)" : ""} — ${i.wh}`, tl2 = `${i.at} — ${i.mode} — ${rangeTxt(i)}`, tlen = Math.max(tl1.length, tl2.length);
    const tst = tlen <= 82 ? ST.title : tlen <= 98 ? ST.title2 : ST.title3;      // long texts: smaller font, never cut
    const rows2 = [[{ v: tl1 + "\n" + tl2, s: tst }], [...hd, undefined, ...hd]];
    const cellsOf = (e, off, r1) => {
      if (!e) return [undefined, undefined, undefined];
      if (e.t === "cat") { merges2.push(`${colL(off)}${r1}:${colL(off + 2)}${r1}`); return [{ v: e.name, s: ST.cat }, { s: ST.cat }, { s: ST.cat }]; }
      const x = e.i, rs = (v) => (data.ready ? numC(v, v < 0 ? ST.neg : ST.num, true) : { s: ST.num });      // every product here has a movement: explicit 0 for Reste, empty when the load is unknown
      return [{ v: x.name, s: ST.txt }, rs(x.rc), rs(x.ru)];
    };
    for (let k = 0; k < L.R; k++) { const r1 = rows2.length + 1; rows2.push([...cellsOf(L.left[k], 0, r1), undefined, ...cellsOf(L.right[k], 4, r1)]); }
    const s2 = { name: "Mouvement", rows: rows2, widths: M_W, freeze: 2, filter: null, merges: merges2, rowH: M_ROW_H, ht: { 0: M_TITLE_H, 1: M_HEAD_H },
      print: { orient: "portrait", fitW: 1, fitH: 1 } };                                      // fitToPage: 1 wide × 1 tall; no autoFilter (two independent blocks)
    return [s1, s2];
  }
  // SheetJS (community 0.18.5) fallback — valid workbook, but print setup is only PARTIAL:
  //   supported : column widths, merges, autofilter (sheet 1), margins (!margins: 0.4 in), repeated header row (Print_Titles defined name)
  //   NOT supported (the community build cannot write them): paperSize A4, orientation, fitToPage / fitToWidth / fitToHeight,
  //   horizontal centering (printOptions), cell styles, frozen panes. Sheet 2 may then print on several pages / default paper.
  function fallbackXlsx(sheets, file) {
    const wb = XLSX.utils.book_new(), names = [];
    sheets.forEach((sh, idx) => {
      const ws = XLSX.utils.aoa_to_sheet(sh.rows.map(r => r.map(c => (c ? c.v : null))));
      ws["!cols"] = sh.widths.map(w => ({ wch: w }));
      if (sh.filter) ws["!autofilter"] = { ref: sh.filter };
      if (sh.merges && sh.merges.length) ws["!merges"] = sh.merges.map(m => XLSX.utils.decode_range(m));
      ws["!margins"] = { left: PAGE.marginIn, right: PAGE.marginIn, top: PAGE.marginIn, bottom: PAGE.marginIn, header: PAGE.headIn, footer: PAGE.headIn };
      XLSX.utils.book_append_sheet(wb, ws, sh.name);
      if (sh.print && sh.print.titleRows) names.push({ Name: "_xlnm.Print_Titles", Ref: `'${sh.name}'!$${sh.print.titleRows[0]}:$${sh.print.titleRows[1]}`, Sheet: idx });
    });
    if (names.length) wb.Workbook = { Names: names };
    XLSX.writeFile(wb, file);
  }
  function downloadBytes(bytes, file) {                             // blob + anchor: works on desktop and phones (no popup)
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = document.createElement("a"); a.href = url; a.download = file; a.style.display = "none";
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 5000);
  }

  // ── Terminer: confirmation + download ───────────────────────
  function closeFinish() { $("gp2FinModal")?.remove(); }
  // the session may already have been ended by someone else (live sync): never export / wipe twice
  function sessionGuard() {
    if (A.sessionActive()) return true;
    A.notify(`Préparation déjà terminée par ${A.sessionInfo().by || "un autre utilisateur"}`, "warning");
    closeFinish(); return false;
  }
  function openFinish() {
    if (!A.can("prep_terminer") || C.finishing || C.reporting) return;
    if (!sessionGuard()) return;
    const data = reportData();
    if (!data.nMov) { A.notify("Aucun mouvement : rien à exporter", "warning"); return; }       // no empty file
    const i = reportInfo(), cl = (k, v) => `<div class="gp2-cl"><span>${k}</span><b>${A.esc(v)}</b></div>`, ml = mouvementLayout(data);
    closeFinish();
    const m = document.createElement("div"); m.id = "gp2FinModal"; m.className = "gp2m";
    m.innerHTML = `<div class="gp2m-box gp2m-sm" role="dialog"><div class="gp2m-h"><span>Terminer — rapport Excel</span><button type="button" class="gp2m-x" data-gc="finclose" aria-label="Fermer">${A.ic("x")}</button></div>
      <div class="gp2m-b">${cl("Produits préparés", A.fmt(data.nPrep))}${cl("Produits chargés", data.ready ? A.fmt(data.nLoad) : "—")}${cl("Bons inclus", C.loaded ? `${i.bons.list.length}/${i.bons.total}` : "—")}${cl("Période", rangeTxt(i))}
        ${data.ready ? "" : `<div class="gp2-fwarn">Chargement non actualisé : les colonnes Chargement et Reste seront vides.</div>`}
        ${ml.pt < 9 ? `<div class="gp2-fwarn">Impression de « Mouvement » : ${ml.R} lignes sur une seule page A4, police réduite à environ ${String(ml.pt).replace(".", ",")} pt.</div>` : ""}
        <div class="gp2-fdanger">${A.ic("warn")}<span>Après le téléchargement, <b>toutes les données de préparation seront supprimées pour tous les utilisateurs</b> : quantités saisies, période, bons exclus et bons hors date. Cette action est irréversible.</span></div></div>
      <div class="gp2m-f"><button type="button" class="gp2-btn" data-gc="finclose">Annuler</button><button type="button" class="gp2-btn gp2-vsave" data-gc="finok">${A.ic("check")} Confirmer</button></div></div>`;
    m.addEventListener("click", (e) => {
      if (e.target === m) { closeFinish(); return; }
      const b = e.target.closest("[data-gc]"); if (!b) return;
      if (b.dataset.gc === "finclose") closeFinish(); else if (b.dataset.gc === "finok") doFinish();
    });
    document.body.appendChild(m);
  }
  // THE report generator, shared by « Terminer » and « Rapport »: same data, same two sheets, same columns, same A4 print setup.
  // Returns the `info` object once the download was triggered, or null when there is nothing to export (message already shown).
  // Throws when the generation fails. It never touches Firebase / the session: clearing is the business of P.ext.afterFinish only.
  function exportReport(draft) {
    const data = reportData(); if (!data.nMov) { A.notify("Aucun mouvement : rien à exporter", "warning"); return null; }
    const i = reportInfo(), file = reportFile(i, draft), sheets = buildSheets(data, i, draft);
    try { downloadBytes(xWorkbook(sheets), file); }
    catch (e) { console.error("[Prep2] xlsx writer, fallback:", e); fallbackXlsx(sheets, file); }
    return { file, at: i.d, user: i.user, wh: i.wh, mode: i.mode, from: charge().from || null, to: charge().to || null,
             products: data.nPrep, loaded: data.nLoad, bons: i.bons.total, bonsIncluded: i.bons.list.length };
  }
  // sequence: confirm → generate + trigger the download → ONLY THEN P.ext.afterFinish (wipe). Any failure before that = nothing is cleared.
  async function doFinish() {
    if (!A.can("prep_terminer") || C.finishing || C.reporting) return;
    if (!sessionGuard()) return;
    C.finishing = true;
    try {
      let info = null;
      try {
        info = exportReport(false);
        closeFinish(); if (!info) return;
        A.notify("Rapport téléchargé : " + info.file, "success");
      } catch (e) { console.error("[Prep2] finish:", e); A.notify("Échec de la génération du rapport — rien n'a été effacé", "error"); return; }
      // EXTENSION POINT — runs only after a successful generation. The wipe (preparation.js) is async and may fail: nothing is lost then,
      // the session stays active and « Terminer » can simply be run again.
      try { await Promise.all((P.ext.afterFinish || []).map(fn => Promise.resolve().then(() => fn(info)))); }
      catch (e) { console.error("[Prep2] afterFinish:", e); A.notify("Rapport téléchargé, mais l'effacement a échoué : rien n'a été supprimé, réessayez", "error"); }
    } finally { C.finishing = false; }
  }

  // ── Rapport: draft download at any time (no confirmation, no afterFinish, no clearing, no state change) ──
  const REPORT_STALE_MS = 5 * 60 * 1000;                           // loading data older than this is refreshed first
  function paintReportBtn() {
    const b = $("gcReportBtn"); if (!b) return;
    b.disabled = !!C.reporting; b.classList.toggle("gp2-busy", !!C.reporting);
    b.innerHTML = `${A.ic(C.reporting ? "refresh" : "filedown", C.reporting ? "gp2-spin" : "")} Rapport`;
  }
  async function refreshIfStale() {
    ensureWh();
    if (C.loaded && Date.now() - C.at <= REPORT_STALE_MS) return;
    const t0 = Date.now();
    while (C.loading && Date.now() - t0 < 20000) await new Promise(r => setTimeout(r, 150));    // a refresh is already running: wait for it
    if (C.loaded && Date.now() - C.at <= REPORT_STALE_MS) return;
    await fetchCharge({ auto: true });
    if (C.sync.k === "err") A.notify("Actualisation impossible : le rapport utilise les derniers chargements connus", "warning");
  }
  async function doReport() {
    if (!A.can("prep_rapport") || C.reporting || C.finishing) return;       // C.reporting also blocks the double click
    if (!sessionGuard()) return;
    C.reporting = true; paintReportBtn();
    try {
      await refreshIfStale();
      if (!sessionGuard()) return;                                          // the session may have ended while refreshing
      const info = exportReport(true);
      if (info) A.notify("Brouillon téléchargé : " + info.file, "success");
    } catch (e) { console.error("[Prep2] report:", e); A.notify("Échec de la génération du rapport", "error"); }
    finally { C.reporting = false; paintReportBtn(); }
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeFinish(); });

  // ── events ─────────────────────────────────────────────────
  function bind() {
    const root = S.root; if (!root || root._gp2c) return; root._gp2c = true;
    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-gc]"); if (!b) return;
      const a = b.dataset.gc, id = +b.dataset.id;
      if (a === "oodrm") { e.stopPropagation(); removeOod(id); }
      else if (a === "bon") toggleBon(id);
      else if (a === "refresh") fetchCharge();
      else if (a === "bons") { C.panelOpen = !C.panelOpen; $("gcPanel").hidden = !C.panelOpen; fitBar(); }
      else if (a === "oodshow") { C.oodRow = !C.oodRow; $("gcOodRow").hidden = !C.oodRow; if (C.oodRow) $("gcOodRef")?.focus(); fitBar(); }
      else if (a === "oodadd") addOod();
      else if (a === "finish") openFinish();
      else if (a === "report") doReport();
      else if (a === "oodlist") openOodModal();
      else if (a === "colsmenu") { const p = $("gcColsPanel"); p.hidden = !p.hidden; }
      else if (a === "rangemenu") { if (C.rangeOpen) closeRange(); else openRange(); }
    });
    root.addEventListener("input", (e) => { if (e.target.id === "gcFrom" || e.target.id === "gcTo") validateRange(); });
    root.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset?.gc === "col") { const c = cols(); c[t.dataset.col] = t.checked; A.lsSet(colsKey(), c); applyCols(); }
    });
    root.addEventListener("focusout", () => setTimeout(() => {          // deferred rebuild (new product) once the worker leaves the field
      if (C.pendingBuild && !isTyping()) { C.pendingBuild = false; A.buildUI(); }
    }, 60));
    root.addEventListener("keydown", (e) => {
      if (e.target.id === "gcOodRef" && e.key === "Enter") { e.preventDefault(); addOod(); }
      else if ((e.target.id === "gcFrom" || e.target.id === "gcTo") && e.key === "Enter") { e.preventDefault(); applyRange(); }
    });
    document.addEventListener("click", (e) => {
      const p = $("gcColsPanel"); if (p && !p.hidden && !e.target.closest(".gp2-menu")) p.hidden = true;
    });
  }

  P.on("built", () => {
    closeRange(); ensureWh(); bind(); recompute(); applyCols(); C.rangeOpen = false;      // a rebuilt UI always starts with the popover closed
    const pnl = $("gcPanel"); if (pnl) pnl.hidden = !C.panelOpen;
    const row = $("gcOodRow"); if (row) row.hidden = !C.oodRow;
    repaintAll(); fitBar(); setTimeout(fitBar, 300); paintReportBtn();
  });

  // another user changed the period / toggled a bon / added a hors-date transfer
  P.on("remote", ({ changed }) => {
    if (!changed.some(k => k === "all" || k === "meta" || k === "charge")) return;
    ensureWh(); syncInputs();
    const ch = charge();
    if (C.loaded && (normFrom(ch.from) !== normFrom(C.from) || (normTo(ch.to) || null) !== (normTo(C.to) || null))) {            // period changed elsewhere → cache is obsolete
      const before = extraSig(); resetCache(); C.wh = S.wh;
      recompute(); rebuildOrRepaint(!!before);
      fetchCharge({ auto: true });                                                     // d) range changed by someone else
      return;
    }
    if (C.loaded) {                                                                   // hors-date set changed elsewhere
      const ids = Object.keys(oodMap()).map(Number);
      const gone = Object.values(C.pickings).filter(p => p._outOfDate && !ids.includes(p.id)).map(p => p.id);
      if (gone.length) { C.moves = C.moves.filter(m => !gone.includes(m.picking_id?.[0])); gone.forEach(id => delete C.pickings[id]); }
      if (ids.some(id => !C.pickings[id])) fetchCharge({ auto: true });               // e) hors date added by someone else
    }
    recompute(); repaintAll(); renderOodModal();
  });

  // Terminer / Nouvelle préparation (any user): drop the Odoo cache, close the charge popups, rebuild; load the new period when a session starts
  P.on("session", ({ active }) => {
    ensureWh(); closeOodModal(); closeFinish(); if (C.rangeOpen) closeRange();
    resetCache(); C.wh = S.wh; C.panelOpen = false; C.oodRow = false;
    A.buildUI();                                                   // also removes the « Chargé sans préparation » rows of the ended session
    if (active) fetchCharge({ auto: true });
  });

  window.GdsPrep2Charge = { state: C, fetch: fetchCharge, recompute, labels, tag: tagHtml };
})();
