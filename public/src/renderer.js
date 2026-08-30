// ============================================================
// src/renderer.js — PWA Rendering Layer
// ✅ No chrome.* calls — pure DOM + App state
// ✅ Date switcher: arrow bar + calendar picker + double-click
// ============================================================

// ── Layout helpers ────────────────────────────────────────────
function getCardWidth()  { return App.settings?.cardWidth  ?? 380; }
function getCardHeight() { return App.settings?.cardHeight ?? 160; }
function getIconCols()   { return App.settings?.iconCols   ?? 0;   }
function getCardColor()  { return App.settings?.cardColor  ?? "#ffffff"; }
function getCardScale()  { return (App.settings?.cardScale ?? 100) / 100; }

// allWorkers() and modeWorkers() are defined in app.js — no redefinition needed here


function buildBlUrl(tourUrl, role) {
  if (!tourUrl) return null;
  try {
    const hashStr = tourUrl.includes("#") ? tourUrl.split("#")[1] : "";
    const params  = {};
    hashStr.split("&").forEach(p => { const eq=p.indexOf("="); if(eq>-1) params[p.slice(0,eq)]=p.slice(eq+1); });
    const tourId = params["id"]; if (!tourId) return null;
    const cids   = params["cids"]    || "1";
    const menuId = params["menu_id"] || "336";
    const base   = tourUrl.split("#")[0];
    const blAction = role === "livraison" ? "547" : "526";
    return `${base}#action=${blAction}&active_id=${tourId}&model=stock.picking&view_type=list&cids=${cids}&menu_id=${menuId}`;
  } catch { return null; }
}

function getRoundState(has, odooState, userStatus) {
  if (!has)                                               return "absent";
  if (odooState === "draft")                              return "draft";
  if (odooState === "closed")                             return "closed";
  if (odooState === "open" && userStatus === "open_day")  return "open_day";
  if (odooState === "open" && userStatus === "close_day") return "close_day";
  if (odooState === "open" && !userStatus)                return "not_started";
  if (odooState === "open")                               return "not_started"; // unknown userStatus — treat as not started, not absent
  return "absent";
}

function dotClass(has, blUrl, role, roundStatus, odooState, userStatus) {
  const state = getRoundState(has, odooState, userStatus);
  switch (state) {
    case "open_day":    return "linked";
    case "close_day":   return "warning";
    case "not_started": return "purple";
    case "draft":       return "info";
    case "closed":      return "absent";
    default:            return "danger";
  }
}

// ── Display settings ──────────────────────────────────────────
function applyDisplaySettings() {
  const w = getCardWidth();
  const grid = document.getElementById("vendorsList");
  if (grid) {
    const activeCols = App.settings?.cols ?? 0;
    if (w === 0) {
      // عرض 0 = تمديد لملء الشاشة
      // إذا colonnes > 0 → تقسيم على العدد المحدد بالتساوي
      // إذا colonnes = 0 → عمود واحد يملأ كامل العرض
      grid.style.gridTemplateColumns = activeCols > 0 ? `repeat(${activeCols},1fr)` : "1fr";
    } else if (activeCols > 0) {
      grid.style.gridTemplateColumns = `repeat(${activeCols},${w}px)`;
    } else {
      grid.style.gridTemplateColumns = `repeat(auto-fill,${w}px)`;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────
function setFetchingUI(on) {
  const btnFetch = document.getElementById("btnFetch");
  const btnAbort = document.getElementById("btnAbort");
  if (!btnFetch) return;
  if (on) {
    btnFetch.disabled = true;
    btnFetch.innerHTML = `<div class="spinner"></div>`;
    if (btnAbort) btnAbort.style.display = "flex";
  } else {
    btnFetch.disabled = false;
    btnFetch.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/></svg>`;
    if (btnAbort) btnAbort.style.display = "none";
  }
}

function updateFetchBtn() {
  if (App.isFetching) return;
  const btn = document.getElementById("btnFetch");
  if (!btn) return;
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/></svg>`;
}

// Cloud buttons hidden in PWA
function updateCloudButton() {
  ["btnCloudPull","btnCloudPush"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
}

function addNotif(msg, type="info") {
  const list = document.getElementById("notifList"); if (!list) return;
  const time  = new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
  const item  = document.createElement("div"); item.className = `notif-item notif-${type}`;
  item.innerHTML = `<span class="notif-dot"></span><span class="notif-msg">${escHtml(msg)}</span><span class="notif-time">${time}</span>`;
  list.insertBefore(item, list.firstChild);
  while (list.children.length > 5) list.removeChild(list.lastChild);
}

// ── Main view ─────────────────────────────────────────────────
function renderMain() {
  renderDateSwitcher();
  renderVendors();
  updateFetchBtn();
}

function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById(name === "settings" ? "viewSettings" : "viewMain").classList.add("active");
  if (name === "settings") renderSettings();
}

// ── Format helpers ────────────────────────────────────────────
function formatCa(value) {
  if (value == null) return "—";
  let num   = value.toFixed(2);
  let parts = num.split(".");
  let int   = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return int + "," + parts[1];
}

// ── SVGs ──────────────────────────────────────────────────────
const _svgOpen  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
const _svgRoute = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17c5-10 13-10 18 0"/><circle cx="3" cy="17" r="2"/><circle cx="21" cy="17" r="2"/></svg>';
const _svgBl    = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
const _svgAnalyse = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="16" x2="12" y2="16"/></svg>';
const _svgCopy  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const _svgTrash = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
const _svgLink  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
const _svgPay   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>';
const _svgAcceptHors = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
const _svgClosePlan  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>';
const _svgOpenPlan = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M5 21V7l7-4 7 4v14"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="12" y1="9" x2="12" y2="15"/></svg>';
const _svgAddProduct = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/><line x1="12" y1="13" x2="12" y2="19"/><line x1="9" y1="16" x2="15" y2="16"/></svg>';
const _svgStockFinal = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 7H4a2 2 0 00-2 2v6a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>';
const _svgJournalStock = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>';
const _svgAddClient  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/></svg>';
const _svgDeleteClient = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><line x1="16" y1="11" x2="22" y2="11"/></svg>';

const _svgBLList   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>';
const _svgAllowAffect = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
const _svgPayList  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/><line x1="14" y1="15" x2="18" y2="15"/></svg>';
const _svgClients  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
const _svgMap       = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>';
const _svgReports  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v5h5"/><path d="M3.05 13a9 9 0 1 0 2.13-6.36L3 8"/><polyline points="12 7 12 12 15.5 14"/></svg>';
const _svgHorsZone = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>';
const _svgVentes   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>';
const _svgRetours  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H9"/></svg>';
const _svgChargement = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="6" width="14" height="12" rx="1"/><path d="M15 10h4l3 3v5h-7z"/><circle cx="6" cy="19" r="2"/><circle cx="17.5" cy="19" r="2"/></svg>';

// ── renderVendors ─────────────────────────────────────────────
function renderVendors() {
  const container = document.getElementById("vendorsList");
  if (!container) return;
  container.innerHTML = "";
  applyDisplaySettings();

  const workers = (() => {
    const base = modeWorkers();
    // الكروت ذات النقطة الحمراء (لا توجد جولة/بيانات اليوم) تُنقل لآخر القائمة
    return base
      .map((w, idx) => {
        const linkRaw = App.allLinks[w.id];
        const link    = Array.isArray(linkRaw) ? linkRaw[0] : linkRaw;
        const has     = !!link;
        const dc      = dotClass(has, null, w.role, App.allRoundStatus[w.id], (App.allOdooState||{})[w.id], (App.allUserStatus||{})[w.id]);
        return { w, idx, danger: dc === "danger" ? 1 : 0 };
      })
      .sort((a, b) => a.danger - b.danger || a.idx - b.idx) // ترتيب مستقر
      .map(item => item.w);
  })();
  if (workers.length === 0) {
    container.innerHTML = `<div class="empty-msg">Aucune entrée ${MODE_CFG[App.currentMode]?.label||App.currentMode}.<br>Ajoutez-les dans les Paramètres.</div>`;
    return;
  }

  const s           = App.settings || {};
  const cardH       = getCardHeight();
  const cardColor   = getCardColor();
  const showBtns    = s.showBtns !== false;
  const hideOpen       = s.hideBtn_open       === true;
  const hideRoute      = s.hideBtn_route      === true;
  const hideBl         = s.hideBtn_bl         === true;
  const hideAnalyse    = s.hideBtn_analyse    === true;
  const hideCopy       = s.hideBtn_copy       === true;
  const hideTrash      = s.hideBtn_trash      === true;
  const hideLink       = s.hideBtn_link       === true;
  const hidePay        = s.hideBtn_pay        === true;
  const hideAccepthors = s.hideBtn_accepthors === true;
  const hideClosep     = s.hideBtn_closep     === true;
  const hideOpenp      = s.hideBtn_openp      === true;
  const hideAddprod    = s.hideBtn_addprod    === true;
const hideStockfinal = s.hideBtn_stockfinal === true;
  const hideJournalstock = s.hideBtn_journalstock === true;
  const hideAddclient  = s.hideBtn_addclient  === true;
  const hideDeleteclient = s.hideBtn_deleteclient === true;
  const hideHorszone   = s.hideBtn_horszone  === true;
  const hideReports    = s.hideBtn_reports   === true;
  const hideVentes     = s.hideBtn_ventes    === true;
  const hideRetours    = s.hideBtn_retours   === true;
  const hideShowbls    = s.hideBtn_showbls   === true;
  const hideChargement = s.hideBtn_chargement === true;
  const hideShowpayments = s.hideBtn_showpayments === true;
  const hideShowclients  = s.hideBtn_showclients  === true;
  const hideShowmap      = s.hideBtn_showmap      === true;
  const hideAllowaffect  = s.hideBtn_allowaffect  === true;
  const menuOpen       = s.menuBtn_open       === true;
  const menuRoute      = s.menuBtn_route      === true;
  const menuBl         = s.menuBtn_bl         === true;
  const menuAnalyse    = s.menuBtn_analyse    === true;
  const menuCopy       = s.menuBtn_copy       === true;
  const menuTrash      = s.menuBtn_trash      === true;
  const menuLink       = s.menuBtn_link       === true;
  const menuPay        = s.menuBtn_pay        === true;
  const menuAccepthors = s.menuBtn_accepthors === true;
  const menuClosep     = s.menuBtn_closep     === true;
  const menuOpenp      = s.menuBtn_openp      === true;
  const menuAddprod    = s.menuBtn_addprod    === true;
  const menuStockfinal = s.menuBtn_stockfinal === true;
  const menuJournalstock = s.menuBtn_journalstock === true;
  const menuAddclient  = s.menuBtn_addclient  === true;
  const menuDeleteclient = s.menuBtn_deleteclient === true;
  const menuHorszone   = s.menuBtn_horszone  === true;
  const menuReports    = s.menuBtn_reports   === true;
  const menuVentes     = s.menuBtn_ventes    === true;
  const menuRetours    = s.menuBtn_retours   === true;
  const menuShowbls    = s.menuBtn_showbls   === true;
  const menuChargement = s.menuBtn_chargement === true;
  const menuShowpayments = s.menuBtn_showpayments === true;
  const menuShowclients  = s.menuBtn_showclients  === true;
  const menuShowmap      = s.menuBtn_showmap      === true;
  const menuAllowaffect  = s.menuBtn_allowaffect  === true;
  workers.forEach(worker => {
    const linkRaw = App.allLinks[worker.id];
    const roundsList = App.allStats[worker.id]?.rounds || null;
    const hasMultiRounds = roundsList && roundsList.length > 1;
    const link = Array.isArray(linkRaw) ? linkRaw[0] : linkRaw;
    const has   = !!link;
    const blUrl = buildBlUrl(link, worker.role);
    const op    = App.activeOps[worker.id];
    const dc    = dotClass(has, blUrl, worker.role, App.allRoundStatus[worker.id], (App.allOdooState||{})[worker.id], (App.allUserStatus||{})[worker.id]);
    const st    = App.allStats[worker.id];
    const vid   = worker.id;
    const hasHors = !!(st?.horsRoute);

    const card = document.createElement("div");
    const showHors = hasHors && dc !== "closed" && dc !== "absent";
card.className = `vc seller-card${has?" vc--linked":" vc--nolink"}${op?" vc--busy":""}${showHors?" vc--hors":""}${hasMultiRounds?" vc--multi-round":""}`;
    if (hasMultiRounds && !card._roundIdx) card._roundIdx = 0;
    card.title = worker.name;

    const lbl     = escHtml(worker.label || shortLabel(worker.name));
    const scale   = getCardScale();
    const dotSz   = Math.round(44  * scale);
    const nameFsz = Math.max(0.7, 1.1  * scale);
    const statFsz = Math.max(0.6, 0.85 * scale);
    const numFsz  = Math.max(0.7, 1.2  * scale);
    const iconSz  = Math.round(38  * scale);
    const iconSvg = Math.round(16  * scale);
    const isDarkTheme = document.documentElement.getAttribute("data-theme") === "dark";
    card.style.cssText = isDarkTheme
      ? `--card-scale:${scale};min-height:${cardH}px;`
      : `--card-bg:${cardColor};--card-scale:${scale};min-height:${cardH}px;background:var(--card-bg,#fff)`;

    // ── Hors Zone badge ───────────────────────────────────────
    const horsZoneHeaderHtml = (st?.horsZone)
      ? `<div class="hors-zone-badge vb" data-action="disableHorsZone" data-vendor="${vid}" title="Hors zone — Cliquer pour annuler">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
             <circle cx="12" cy="9" r="2.5"/>
             <line x1="3" y1="3" x2="21" y2="21"/>
           </svg>
         </div>`
      : "";

    // ── Pending BL badge ──────────────────────────────────────
    // شارات R/A للموزعين
    const showAlerts = App.settings?.showRoundAlerts && worker.role === "livraison";
    const _ralert = App._roundAlerts?.[vid];
    const _alertMatch = _ralert && _ralert.roundId === st?.roundId;
    const hasDelayedAlert  = showAlerts && !!(_alertMatch && _ralert.hasDelayed);
    const hasCanceledAlert = showAlerts && !!(_alertMatch && _ralert.hasCanceled);

    const pendingBLCount = st?.pendingBLs || 0;
    const pendingBLHtml = pendingBLCount > 0
      ? `<div class="pending-bl-badge" title="${pendingBLCount} BL non livré(s)">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px">
             <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
             <polyline points="14 2 14 8 20 8"/>
             <line x1="12" y1="11" x2="12" y2="17"/>
             <line x1="9" y1="14" x2="15" y2="14"/>
           </svg>
           <span>${pendingBLCount}</span>
         </div>`
      : "";

    // ── Times + CA ────────────────────────────────────────────
    const fv  = st?.firstVisit ?? null;
    const lv  = st?.lastVisit  ?? null;
    const upd = st?.updatedAt  ? new Date(st.updatedAt).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"}) : null;
    // CA: normal pour tous sauf merchandiseur
    const caRaw = worker.role === "merch" ? null : (st?.ca ?? null);
    const ca = caRaw;
    // ENC: élément séparé, affiché dès que encaissement a une valeur (≠ null, ≠ 0)
    const encRaw = st?.encaissement ?? null;
    const enc = (encRaw != null && encRaw !== 0) ? encRaw : null;

    const showUpd  = s.showUpdatedAt !== false;
    const updBadge = (upd && showUpd)
      ? `<span class="upd-badge" title="Dernière mise à jour">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:${Math.round(9*scale)}px;height:${Math.round(9*scale)}px"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/></svg>
           ${upd}
         </span>`
      : "";

    const fvBadge = fv ? `<span class="header-time-item"><span class="ht-icon">▶</span>${fv}</span>` : "";
    const lvBadge = lv ? `<span class="header-time-item"><span class="ht-icon">⏹</span>${lv}</span>` : "";
    const headerTimesHtml = (fv || lv) ? `<div class="header-times">${fvBadge}${lvBadge}</div>` : "";

    const headerHtml = `
      <div class="card-header">
        <div class="left-header">
          
          <div class="vc-dot ${dc}" style="width:${dotSz}px;height:${dotSz}px"></div>
          <div class="name-upd-group">
            <span class="seller-name" style="font-size:${nameFsz}rem">${lbl}${(worker.role==="merch"||worker.role==="recouvrement") ? `<span style="font-size:${Math.max(0.55,0.62*scale)}rem;font-weight:600;margin-left:4px;color:var(--mr-color,#8B5CF6);opacity:.8">${worker.role==="merch"?"Merch":"Recouv"}</span>` : ""}</span>
            ${headerTimesHtml}
            ${updBadge}
          </div>
        </div>
        ${horsZoneHeaderHtml}
        ${pendingBLHtml}
        ${hasDelayedAlert  ? `<span style="font-size:10px;font-weight:800;padding:1px 7px;border-radius:8px;background:#FFF7ED;border:1px solid #FED7AA;color:#F59E0B;animation:hz-blink 1.5s infinite;margin-left:2px">R</span>` : ""}
        ${hasCanceledAlert ? `<span style="font-size:10px;font-weight:800;padding:1px 7px;border-radius:8px;background:#FEF2F2;border:1px solid #FECACA;color:#EF4444;animation:hz-blink 1.5s infinite;margin-left:2px">A</span>` : ""}
      </div>`;

    const caHtml = (ca != null) ? `
      <div class="ca-block">
        <span class="ca-label">CA</span>
        <span class="ca-value">${formatCa(ca)}</span>
      </div>` : "";

    const encHtml = (enc != null) ? `
      <div class="ca-block enc-block">
        <span class="ca-label" style="color:#3b82f6">ENC</span>
        <span class="ca-value enc-value" style="color:#3b82f6">${formatCa(enc)}</span>
      </div>` : "";

    const cf = st?.cf;
    const cfHtml = cf ? `
      <div class="ca-block" style="cursor:pointer" data-action="showCF" data-vendor="${vid}">
        <span class="ca-label" style="color:#0f3b5f">C</span>
        <span class="ca-value" style="color:#0f3b5f">${+cf.c.toFixed(1)}</span>
      </div>
      <div class="ca-block" style="cursor:pointer" data-action="showCF" data-vendor="${vid}">
        <span class="ca-label" style="color:#b45309">F</span>
        <span class="ca-value ${!Number.isInteger(cf.f) ? 'cf-blink' : ''}" style="color:#b45309">${+cf.f.toFixed(1)}</span>
      </div>` : "";

    const infoRowHtml = (caHtml || encHtml || cfHtml) ? `<div class="info-row">${caHtml}${encHtml}${cfHtml}</div>` : "";

    // ── Stats row ─────────────────────────────────────────────
    const P    = st?.totalClients ?? "—";
    const vPct = st?.visitRate   != null ? st.visitRate.toFixed(0)   : "—";
    const vCnt = (st?.visitRate  != null && st?.totalClients != null) ? Math.round(st.visitRate/100*st.totalClients) : "—";
    const sPct = st?.successRate != null ? st.successRate.toFixed(0) : "—";
    const sCnt = (st?.successRate != null && st?.totalClients != null) ? Math.round(st.successRate/100*st.totalClients) : "—";

    const statsHtml = `
      <div class="stats-row">
        <div class="stat-card stat-primary">
          <div class="stat-key" style="color:var(--accent-p,#0f3b5f);font-size:${statFsz}rem">P</div>
          <div class="stat-number" style="font-size:${numFsz}rem">${P}</div>
        </div>
        <div class="stat-card stat-percent stat-v">
          <div class="stat-key" style="color:var(--accent-v,#2b5e3b);font-size:${statFsz}rem">V</div>
          <div class="percentage" style="font-size:${numFsz}rem">${vPct}${vPct!=="—"?"%":""}</div>
          <div class="sub-count" style="font-size:${Math.max(0.55,0.68*scale)}rem">${vCnt}</div>
        </div>
        <div class="stat-card stat-percent stat-s">
          <div class="stat-key" style="color:var(--accent-s,#b45309);font-size:${statFsz}rem">S</div>
          <div class="percentage" style="font-size:${numFsz}rem">${sPct}${sPct!=="—"?"%":""}</div>
          <div class="sub-count" style="font-size:${Math.max(0.55,0.68*scale)}rem">${sCnt}</div>
        </div>
      </div>`;

    // ── Action buttons ────────────────────────────────────────
    const disOpen  = (!has||op) ? " disabled" : "";
    const disBl    = (!blUrl||op) ? " disabled" : "";
    const disCopy  = (!has||op) ? " disabled" : "";
    const disTrash = (!has||op) ? " disabled" : "";
    const disLink  = op ? " disabled" : "";
    const hasRouteBtn = (worker.role === "prevente" || worker.role === "merch" || worker.role === "recouvrement") && !!worker.routeId;

    let btnsHtml = "";
    if (showBtns) {
      const iconCols = getIconCols();
      const gridStyle = iconCols > 0
        ? `grid-template-columns:repeat(${iconCols},${iconSz}px)`
        : `grid-template-columns:repeat(auto-fill,${iconSz}px)`;
      const iconBtnStyle = `width:${iconSz}px;height:${iconSz}px`;
      const iconSvgStyle = `width:${iconSvg}px;height:${iconSvg}px`;

      const mkBtn = (cls, action, extra, svg, ttl) =>
        `<button class="icon-btn ${cls} vb" data-action="${action}" data-vendor="${vid}"${extra} title="${ttl}" style="${iconBtnStyle}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="${iconSvgStyle}">${svg.replace(/^<svg[^>]*>/,'')}</svg></button>`;

      const CARD_BTN_ORDER_DEFAULT = ['open','open-route','analysebl','copyRef','clearRound','fetchLink',
        'acceptHors','planningCtrl','payment','addProduct','stockFinal','journalStock',
        'addClient','deleteClient','showBLs','bonChargement','showPayments','showClients','showMap','allowHorsZone','showReports','showVentes','showRetours'];
      const btnsOrder = (s.btnOrder && s.btnOrder.length)
        ? [...s.btnOrder, ...CARD_BTN_ORDER_DEFAULT.filter(k => !s.btnOrder.includes(k))]
        : CARD_BTN_ORDER_DEFAULT;
      const btnsMap = {};
      const isMrRole = (worker.role === "merch" || worker.role === "recouvrement");

      if (!isMrRole) {
        // Boutons standards (prevente / livraison)
        if (!hideOpen && !menuOpen)    btnsMap['open']       = mkBtn("icon-btn-open",    "open",        disOpen,  _svgOpen,    "Ouvrir tournée");
        if (!hideRoute && !menuRoute && hasRouteBtn) btnsMap['open-route'] = mkBtn("icon-btn-route","open-route","", _svgRoute, "Ouvrir route");
        if (!hideAnalyse && !menuAnalyse && App.allRefs[vid]) btnsMap['analysebl'] = mkBtn("icon-btn-analyse","analysebl","", _svgAnalyse, "Analyser BL");
        if (!hideCopy && !menuCopy)    btnsMap['copyRef']    = mkBtn("icon-btn-copy",    "copyRef",     disCopy,  _svgCopy,    "Copier référence");
        if (!hideTrash && !menuTrash)  btnsMap['clearRound'] = mkBtn("icon-btn-trash",   "clearRound",  disTrash, _svgTrash,   "Effacer lien");
        if (!hideLink && !menuLink)    btnsMap['fetchLink']  = mkBtn("icon-btn-link",    "fetchLink",   disLink,  _svgLink,    "Récupérer lien");
        if (!hideAccepthors && !menuAccepthors && showHors) btnsMap['acceptHors'] = mkBtn("icon-btn-hors","acceptHors",' style="animation:hz-blink 1s infinite"',_svgAcceptHors,"Valider hors tournée");
        if (!hideClosep && !menuClosep) {
          if (dc === "warning") btnsMap['planningCtrl'] = mkBtn("icon-btn-closep icon-btn-orange","closePlanning","",_svgClosePlan,"Fermer la tournée");
          else if (dc === "linked") btnsMap['planningCtrl'] = mkBtn("icon-btn-closep icon-btn-green","closePlanningConfirm","",_svgClosePlan,"Fermer la tournée");
          else if (dc === "purple") btnsMap['planningCtrl'] = mkBtn("icon-btn-closep icon-btn-purple","closePlanningConfirm","",_svgClosePlan,"Fermer la tournée");
        }
        if (!hideOpenp && !menuOpenp && dc === "info") btnsMap['planningCtrl'] = mkBtn("icon-btn-openp","openPlanning","",_svgOpenPlan,"Ouvrir la tournée");
        if (!hidePay && !menuPay && App.settings?.baseUrlPayment && App.currentDateOffset === 0)
          btnsMap['payment'] = mkBtn("icon-btn-pay", "payment", "", _svgPay, "Encaissement");
        if (!hideAddprod && !menuAddprod && (dc==="linked"||dc==="purple") && worker.role==="livraison")
          btnsMap['addProduct'] = mkBtn("icon-btn-addprod","addProduct","",_svgAddProduct,"Ajouter produit");
        if (!hideStockfinal && !menuStockfinal && worker.role==="livraison" && has)
          btnsMap['stockFinal'] = mkBtn("icon-btn-stockfinal","stockFinal","",_svgStockFinal,"Stock final");
        if (!hideJournalstock && !menuJournalstock && worker.role==="livraison" && App.allStats[vid]?.roundId)
          btnsMap['journalStock'] = mkBtn("icon-btn-journalstock","journalStock","",_svgJournalStock,"Journal Stock");
        const _isActiveDateForClient = App.currentDateOffset === 0 || (App.currentDateOffset === 1 && worker.role === "livraison");
        if (!hideAddclient && !menuAddclient && (dc==="linked"||dc==="purple") && _isActiveDateForClient && has)
          btnsMap['addClient'] = mkBtn("icon-btn-addclient","addClient","",_svgAddClient,"Ajouter client à la tournée");
        if (!hideDeleteclient && !menuDeleteclient && (dc==="linked"||dc==="purple") && _isActiveDateForClient && has)
          btnsMap['deleteClient'] = mkBtn("icon-btn-deleteclient","deleteClient","",_svgDeleteClient,"Supprimer client de la tournée");
        if (!hideShowbls && !menuShowbls && App.allStats[vid]?.roundId) btnsMap['showBLs']      = mkBtn("icon-btn-bllist",  "showBLs",      "", _svgBLList,   "Liste des BLs");
        if (!hideChargement && !menuChargement && worker.role === "livraison" && App.allStats[vid]?.roundId) btnsMap['bonChargement'] = mkBtn("icon-btn-chargement", "bonChargement", "", _svgChargement, "Bon de chargement");
        if (!hideAllowaffect && !menuAllowaffect && worker.role === "livraison" && dc === "linked" && App.allStats[vid]?.roundId) {
          btnsMap['allowAffect'] = `<button class="icon-btn icon-btn-allowaffect vb" data-action="allowAffect" data-vendor="${vid}"
            title="Autoriser l'affectation"
            style="${iconBtnStyle};border:1px solid #BBF7D0;background:#F0FDF4;color:#15803d"
            ><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="${iconSvgStyle}">${_svgAllowAffect.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'')}</svg></button>`;
        }
        if (!hideShowpayments && !menuShowpayments && App.allStats[vid]?.roundId) btnsMap['showPayments'] = mkBtn("icon-btn-paylist",  "showPayments", "", _svgPayList,  "Liste des paiements");
        if (!hideShowclients && !menuShowclients && App.allStats[vid]?.roundId) btnsMap['showClients']  = mkBtn("icon-btn-clients",  "showClients",  "", _svgClients,  "Liste des clients");
        if (!hideShowmap && !menuShowmap && App.allStats[vid]?.roundId) btnsMap['showMap']      = mkBtn("icon-btn-map",      "showMap",      "", _svgMap,      "Carte de la tournée");
        if (!hideHorszone && !menuHorszone && !st?.horsZone)
          btnsMap['allowHorsZone'] = mkBtn("icon-btn-horszone", "allowHorsZone", "", _svgHorsZone, "Autoriser hors zone");
        if (!hideReports && !menuReports && worker.role === "livraison" && App.allStats[vid]?.roundId) {
          const _dorders = App._delayedOrders?.[vid];
          const _dMatch = _dorders && _dorders.roundId === App.allStats[vid]?.roundId;
          const repCount = _dMatch ? (_dorders.picks || []).length : 0;
          const repDisabled = repCount === 0 ? " disabled" : "";
          btnsMap['showReports'] = `<button class="icon-btn icon-btn-reports vb" data-action="showReports" data-vendor="${vid}"${repDisabled}
            title="${repCount === 0 ? "Aucune commande reportée" : "Historique des reports de livraison"}"
            style="${iconBtnStyle};position:relative"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="${iconSvgStyle}">${_svgReports.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'')}</svg>${repCount > 0 ? `<span style="position:absolute;top:-3px;right:-3px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--bg3,#F1F5F9);border:1px solid var(--border,#E2E8F0);color:var(--text2,#475569);font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;line-height:1">${repCount}</span>` : ""}</button>`;
        }
        if (!hideVentes && !menuVentes && worker.role === "livraison" && App.allStats[vid]?.roundId) {
          const _sorders = App._soldOrders?.[vid];
          const _sMatch = _sorders && _sorders.roundId === App.allStats[vid]?.roundId;
          const venCount = _sMatch ? (_sorders.sales || []).length : 0;
          const venDisabled = venCount === 0 ? " disabled" : "";
          btnsMap['showVentes'] = `<button class="icon-btn icon-btn-ventes vb" data-action="showVentes" data-vendor="${vid}"${venDisabled}
            title="${venCount === 0 ? "Aucune vente" : "Ventes de la tournée"}"
            style="${iconBtnStyle};position:relative"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="${iconSvgStyle}">${_svgVentes.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'')}</svg>${venCount > 0 ? `<span style="position:absolute;top:-3px;right:-3px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--bg3,#F1F5F9);border:1px solid var(--border,#E2E8F0);color:var(--text2,#475569);font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;line-height:1">${venCount}</span>` : ""}</button>`;
        }
        if (!hideRetours && !menuRetours && worker.role === "livraison" && App.allStats[vid]?.roundId) {
          const _rorders = App._returnOrders?.[vid];
          const _rMatch = _rorders && _rorders.roundId === App.allStats[vid]?.roundId;
          const retCount = _rMatch ? (_rorders.returns || []).length : 0;
          const retDisabled = retCount === 0 ? " disabled" : "";
          btnsMap['showRetours'] = `<button class="icon-btn icon-btn-retours vb" data-action="showRetours" data-vendor="${vid}"${retDisabled}
            title="${retCount === 0 ? "Aucun retour" : "Retours client"}"
            style="${iconBtnStyle};position:relative"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="${iconSvgStyle}">${_svgRetours.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'')}</svg>${retCount > 0 ? `<span style="position:absolute;top:-3px;right:-3px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--bg3,#F1F5F9);border:1px solid var(--border,#E2E8F0);color:var(--text2,#475569);font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;line-height:1">${retCount}</span>` : ""}</button>`;
        }
      } else {
        // Boutons M&R (merchandiseur / recouvrement)
        btnsMap['open']       = mkBtn("icon-btn-open",  "open",       disOpen,  _svgOpen,  "Ouvrir tournée");
        if (!hideRoute && !menuRoute && hasRouteBtn) btnsMap['open-route'] = mkBtn("icon-btn-route","open-route","", _svgRoute, "Ouvrir route");
        btnsMap['copyRef']    = mkBtn("icon-btn-copy",  "copyRef",    disCopy,  _svgCopy,  "Copier référence");
        btnsMap['clearRound'] = mkBtn("icon-btn-trash", "clearRound", disTrash, _svgTrash, "Effacer lien");
        btnsMap['fetchLink']  = mkBtn("icon-btn-link",  "fetchLink",  disLink,  _svgLink,  "Récupérer lien");
        if (dc === "warning") btnsMap['planningCtrl'] = mkBtn("icon-btn-closep icon-btn-orange","closePlanning","",_svgClosePlan,"Fermer la tournée");
        else if (dc === "linked")  btnsMap['planningCtrl'] = mkBtn("icon-btn-closep icon-btn-green","closePlanningConfirm","",_svgClosePlan,"Fermer la tournée");
        else if (dc === "purple")  btnsMap['planningCtrl'] = mkBtn("icon-btn-closep icon-btn-purple","closePlanningConfirm","",_svgClosePlan,"Fermer la tournée");
        else if (dc === "info")    btnsMap['planningCtrl'] = mkBtn("icon-btn-openp","openPlanning","",_svgOpenPlan,"Ouvrir la tournée");
        if (App.settings?.baseUrlPayment && App.currentDateOffset === 0)
          btnsMap['payment'] = mkBtn("icon-btn-pay", "payment", "", _svgPay, "Encaissement");
        if (!hideAddclient && !menuAddclient && (dc==="linked"||dc==="purple") && App.currentDateOffset === 0 && has)
          btnsMap['addClient'] = mkBtn("icon-btn-addclient","addClient","",_svgAddClient,"Ajouter client à la tournée");
        if (!hideDeleteclient && !menuDeleteclient && (dc==="linked"||dc==="purple") && App.currentDateOffset === 0 && has)
          btnsMap['deleteClient'] = mkBtn("icon-btn-deleteclient","deleteClient","",_svgDeleteClient,"Supprimer client de la tournée");
        if (!hideShowpayments && !menuShowpayments && App.allStats[vid]?.roundId) btnsMap['showPayments'] = mkBtn("icon-btn-paylist","showPayments","",_svgPayList,"Liste des paiements");
        if (!hideShowclients && !menuShowclients && App.allStats[vid]?.roundId) btnsMap['showClients']  = mkBtn("icon-btn-clients","showClients", "",_svgClients, "Liste des clients");
        if (!hideShowmap && !menuShowmap && App.allStats[vid]?.roundId) btnsMap['showMap']      = mkBtn("icon-btn-map",    "showMap",     "",_svgMap,     "Carte de la tournée");
        if (!hideHorszone && !menuHorszone && !st?.horsZone)
          btnsMap['allowHorsZone'] = mkBtn("icon-btn-horszone", "allowHorsZone", "", _svgHorsZone, "Autoriser hors zone");
      }

      // ── فلترة أزرار الكرت حسب صلاحيات المستخدم (RBAC) ──────────
      // (الفرض الحقيقي موجود مسبقًا على السيرفر؛ هذا فقط يمنع ظهور زر
      // سيُرفض على أي حال، تحسينًا لتجربة الاستخدام)
      const CARD_BTN_PERMISSIONS = {
        'open':          'card.open',
        'open-route':    'card.openRoute',
        'analysebl':     'card.analyseBl',
        'copyRef':       'card.copyRef',
        'clearRound':    'card.clearRound',
        'fetchLink':     'card.fetchLink',
        'acceptHors':    'card.acceptHors',
        'addProduct':    'card.addProduct.submit',
        'stockFinal':    'card.stockFinal',
        'journalStock':  'card.journalStock',
        'addClient':     'card.addClient.submit',
        'deleteClient':  'card.deleteClient.submit',
        'showBLs':       'card.showBLs',
        'bonChargement': 'card.bonChargement',
        'showPayments':  'card.showPayments',
        'showClients':   'card.showClients',
        'showMap':       'card.showMap',
        'allowHorsZone': 'card.allowHorsZone',
        'showReports':   'card.showReports',
        'showVentes':    'card.showVentes',
        'showRetours':   'card.showRetours',
      };
      Object.keys(btnsMap).forEach(key => {
        if (key === 'planningCtrl') {
          const isOpen = btnsMap[key].includes('data-action="openPlanning"');
          const perm = isOpen ? 'card.planningCtrl.open' : 'card.planningCtrl.close';
          if (!hasPermission(perm)) delete btnsMap[key];
          return;
        }
        if (key === 'payment') {
          if (!hasPermission('card.payment.create') && !hasPermission('card.payment.autoFill')) delete btnsMap[key];
          return;
        }
        const perm = CARD_BTN_PERMISSIONS[key];
        if (perm && !hasPermission(perm)) delete btnsMap[key];
      });

      // أي مفتاح غير موجود في btnsOrder يُضاف في النهاية
      const orderedKeys = [...btnsOrder, ...Object.keys(btnsMap).filter(k => !btnsOrder.includes(k))];
      const btnsList = orderedKeys.filter(k => btnsMap[k]).map(k => btnsMap[k]);

      btnsHtml = `<div class="actions-icons" style="${gridStyle}">${btnsList.join("")}</div>`;
    }

    // ── Overlay ───────────────────────────────────────────────
    let overlayHtml = "";
    if (op) {
      const opLabel = op === "fetching" ? "Récupération…" : "Validation…";
      overlayHtml = `<div class="vc-overlay"><div class="spinner-sm"></div><span class="vc-op-label">${opLabel}</span><button class="vc-cancel-btn" data-vendor="${worker.id}" title="Annuler">✕</button></div>`;
    }

    card.dataset.vendorId = vid;
    const selBadge = `<div class="vc-sel-badge" style="display:none;position:absolute;
      top:0;right:0;width:26px;height:26px;background:var(--accent,#3B82F6);
      border-radius:0 8px 0 10px;align-items:center;justify-content:center;z-index:10">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" width="13" height="13">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>`;
    card.style.position = "relative";
    let dotsHtml = "";
    if (hasMultiRounds) {
      const dots = roundsList.map((r, i) => {
        const rDc = dotClass(true, buildBlUrl(r.url, worker.role), worker.role, null, r.state, r.user_status);
        return `<span class="round-dot round-dot--${rDc}${i===0?" round-dot--active":""}" data-ridx="${i}" title="Tournée ${i+1}"></span>`;
      }).join("");
      dotsHtml = `<div class="round-dots">${dots}</div>`;
    }

    card.innerHTML = selBadge + overlayHtml + headerHtml + infoRowHtml + statsHtml + btnsHtml + dotsHtml;
    card.dataset.roundIdx = "0";
    container.appendChild(card);
  });
  
// ── Swipe بين الجولات ─────────────────────────────────────────
container.querySelectorAll(".vc.vc--multi-round").forEach(card => {
  let _swTouchStartX = 0, _swTouchStartY = 0, _swMovedX = 0, _swMoving = false;
  let _swMouseStartX = 0, _swMouseDown = false, _swMouseMovedX = 0;

  function _switchRound(card, delta) {
    const vid    = card.dataset.vendorId;
    const rounds = App.allStats[vid]?.rounds;
    if (!rounds || rounds.length < 2) return;
    let idx = parseInt(card.dataset.roundIdx || "0") + delta;
    idx = ((idx % rounds.length) + rounds.length) % rounds.length;
    _applyRound(card, vid, idx, rounds);
  }

  function _applyRound(card, vid, idx, rounds) {
    const round = rounds[idx];
    card.dataset.roundIdx = String(idx);

    // تحديث dot active
    card.querySelectorAll(".round-dot").forEach((d, i) => {
  d.classList.toggle("round-dot--active", i === idx);
});

    // تحديث stats في الـ DOM
    const st = round.stats || {};
    const worker = allWorkers().find(v => v.id === vid);
    const scale  = getCardScale();
    const numFsz = Math.max(0.7, 1.2 * scale);
    const statFsz = Math.max(0.6, 0.85 * scale);

    const P    = st.totalClients ?? "—";
    const vPct = st.visitRate   != null ? st.visitRate.toFixed(0)   : "—";
    const vCnt = (st.visitRate  != null && st.totalClients != null) ? Math.round(st.visitRate/100*st.totalClients) : "—";
    const sPct = st.successRate != null ? st.successRate.toFixed(0) : "—";
    const sCnt = (st.successRate != null && st.totalClients != null) ? Math.round(st.successRate/100*st.totalClients) : "—";

    const sr = card.querySelector(".stats-row");
    if (sr) sr.innerHTML = `
      <div class="stat-card stat-primary">
        <div class="stat-key" style="color:var(--accent-p,#0f3b5f);font-size:${statFsz}rem">P</div>
        <div class="stat-number" style="font-size:${numFsz}rem">${P}</div>
      </div>
      <div class="stat-card stat-percent stat-v">
        <div class="stat-key" style="color:var(--accent-v,#2b5e3b);font-size:${statFsz}rem">V</div>
        <div class="percentage" style="font-size:${numFsz}rem">${vPct}${vPct!=="—"?"%":""}</div>
        <div class="sub-count" style="font-size:${Math.max(0.55,0.68*scale)}rem">${vCnt}</div>
      </div>
      <div class="stat-card stat-percent stat-s">
        <div class="stat-key" style="color:var(--accent-s,#b45309);font-size:${statFsz}rem">S</div>
        <div class="percentage" style="font-size:${numFsz}rem">${sPct}${sPct!=="—"?"%":""}</div>
        <div class="sub-count" style="font-size:${Math.max(0.55,0.68*scale)}rem">${sCnt}</div>
      </div>`;

    // تحديث CA
    const caRaw = worker?.role === "merch" ? null : (st.ca ?? null);
    const caEl = card.querySelector(".ca-value:not(.enc-value)");
    if (caEl && caRaw != null) caEl.textContent = formatCa(caRaw);

    // تحديث ENC
    const encRaw = (st.encaissement != null && st.encaissement !== 0) ? st.encaissement : null;
    const encEl = card.querySelector(".enc-value");
    if (encEl) encEl.textContent = encRaw != null ? formatCa(encRaw) : "";

    // تحديث firstVisit / lastVisit
    const htItems = card.querySelectorAll(".header-time-item");
if (htItems[0]) htItems[0].innerHTML = `<span class="ht-icon">▶</span>${st.firstVisit || ""}`;
if (htItems[1]) htItems[1].innerHTML = `<span class="ht-icon">⏹</span>${st.lastVisit  || ""}`;

    // تحديث data-roundid لأزرار البطاقة (open, showBLs, إلخ)
    card.querySelectorAll(".vb[data-action='open']").forEach(b => {
      b._roundUrl = round.url;
    });
    // حفظ الرابط الحالي على الكرت نفسه لاستخدامه عند الضغط
    card._currentRoundUrl = round.url;
    card._currentRoundId  = round.roundId;

    // تحديث لون الـ dot الرئيسي ليعكس حالة الجولة الحالية
    const mainDot = card.querySelector(".vc-dot");
    if (mainDot) {
      const rDc = dotClass(true, buildBlUrl(round.url, worker?.role), worker?.role, null, round.state, round.user_status);
      mainDot.className = `vc-dot ${rDc}`;
    }
  }

  // Touch swipe
  let _lpTimer = null;
  card.addEventListener("touchstart", e => {
    if (e.target.closest(".vb, .round-dot, .vc-cancel-btn")) return;
    _swTouchStartX = e.touches[0].clientX;
    _swTouchStartY = e.touches[0].clientY;
    _swMovedX = 0; _swMoving = false;
    _lpTimer = setTimeout(() => {
      _lpTimer = null;
      const touch = e.touches[0] || e.changedTouches[0];
      _showVcContextMenu({ clientX: touch.clientX, clientY: touch.clientY }, card);
    }, 500);
  }, { passive: true });

  card.addEventListener("touchmove", e => {
    const dx = e.touches[0].clientX - _swTouchStartX;
    const dy = Math.abs(e.touches[0].clientY - _swTouchStartY);
    if (Math.abs(dx) > 10 || dy > 10) { clearTimeout(_lpTimer); _lpTimer = null; }
    if (Math.abs(dx) > 12 && Math.abs(dx) > dy) _swMoving = true;
    _swMovedX = dx;
  }, { passive: true });

  card.addEventListener("touchend", () => {
    clearTimeout(_lpTimer); _lpTimer = null;
    if (!_swMoving) return;
    if (_swMovedX < -40) _switchRound(card, 1);
    else if (_swMovedX > 40) _switchRound(card, -1);
    _swMoving = false;
  });

  // Mouse swipe (desktop)
  card.addEventListener("mousedown", e => {
    if (e.target.closest(".vb, .round-dot, .vc-cancel-btn")) return;
    _swMouseDown = true; _swMouseStartX = e.clientX; _swMouseMovedX = 0;
  });
  card.addEventListener("mousemove", e => {
    if (!_swMouseDown) return;
    _swMouseMovedX = e.clientX - _swMouseStartX;
  });
  card.addEventListener("mouseup", () => {
    if (!_swMouseDown) return;
    _swMouseDown = false;
    if (_swMouseMovedX < -40) _switchRound(card, 1);
    else if (_swMouseMovedX > 40) _switchRound(card, -1);
  });
  card.addEventListener("mouseleave", () => { _swMouseDown = false; });

  // Dot click
  card.querySelectorAll(".round-dot").forEach(dot => {
    dot.addEventListener("click", e => {
      e.stopPropagation();
      const vid    = card.dataset.vendorId;
      const rounds = App.allStats[vid]?.rounds;
      if (!rounds) return;
      const idx = parseInt(dot.dataset.ridx);
      _applyRound(card, vid, idx, rounds);
    });
  });
});
// ── Double-click / Double-tap selection ──────────────────────
container.querySelectorAll(".vc").forEach(card => {
    const _isSelectionMode = () => document.querySelectorAll(".vc--selected").length > 0;

    // Double-click (desktop)
    card.addEventListener("dblclick", e => {
      if (card.closest(".sv-vendors-list")) return;
      if (e.target.closest(".vb, .vc-cancel-btn, .round-dot")) return;
      const vid = card.dataset.vendorId;
      if (vid) _toggleVendorCard(card, vid);
    });

    // Double-tap (mobile) — تحقق يدوي لأن dblclick لا يعمل دائماً على موبايل
    let _lastTap = 0;
    card.addEventListener("touchend", e => {
      if (card.closest(".sv-vendors-list")) return;
      if (e.target.closest(".vb, .vc-cancel-btn, .round-dot")) return;
      const now = Date.now();
      if (now - _lastTap < 350) {
        const vid = card.dataset.vendorId;
        if (vid) _toggleVendorCard(card, vid);
        _lastTap = 0;
      } else {
        _lastTap = now;
      }
    });

    // في وضع التحديد: كليك عادي يحدد/يلغي
    card.addEventListener("click", e => {
      if (!_isSelectionMode()) return;
      if (e.target.closest(".vb, .vc-cancel-btn, .round-dot")) return;
      e.stopPropagation();
      const vid = card.dataset.vendorId;
      if (vid) _toggleVendorCard(card, vid);
    }, true);
  });
  if (App.searchQuery || qbIsActive()) applySearch();
 if (typeof updateDashboardVisibility === "function") updateDashboardVisibility();
  if (typeof renderDashboard === "function") renderDashboard();

  // Context menu on click anywhere on card (including buttons)
  container.querySelectorAll(".vc").forEach(card => {
    card.addEventListener("contextmenu", e => {
      e.preventDefault();
      e.stopPropagation();
      _showVcContextMenu(e, card);
    });
  });
}

// ── Date Switcher — NEW PWA system ───────────────────────────
// Replaces the old today/tomorrow buttons with:
//   ← [label with current date] →
//   Single click on label → calendar popup
//   Double click on label → jump to today
let _dsClickTimer = null;
let _dsCalendarOpen = false;

function renderDateSwitcher() {
  const container = document.getElementById("dateSwitcher");
  if (!container) return;

  const mode    = App.currentMode;
  const today   = getTodayKey();
  const offset  = App.currentDateOffset;
  const curDate = getDateKey(offset);

  // Max dates: prevente = today, livraison = tomorrow
  const maxDate = mode === "livraison" ? getDateKey(1) : today;
  const minDate = "2024-01-01";

  const dateObj    = new Date(curDate);
  const isToday    = curDate === today;
  const dayLabel   = dateObj.toLocaleDateString("fr-FR", { weekday:"short", day:"numeric", month:"short" });
  const isMaxed    = curDate >= maxDate;
  const isMinned   = offset <= -90; // allow up to 90 days back

  container.style.display = "";
  container.innerHTML = `
    <button id="dsPrev" class="ds-arrow${isMinned?" ds-arrow--disabled":""}" title="Jour précédent" ${isMinned?"disabled":""}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
    <div id="dsLabel" class="ds-label${isToday?" ds-label--today":""}" title="Cliquer: calendrier · Double-cliquer: aujourd'hui">
      <span class="ds-date-text">${dayLabel}</span>
      ${isToday ? '<span class="ds-today-pill">Auj.</span>' : ''}
    </div>
    <button id="dsNext" class="ds-arrow${isMaxed?" ds-arrow--disabled":""}" title="Jour suivant" ${isMaxed?"disabled":""}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>
    </button>
  `;

  // ← previous day
  document.getElementById("dsPrev")?.addEventListener("click", () => {
    if (isMinned) return;
    setDateOffset(offset - 1);
  });

  // → next day
  document.getElementById("dsNext")?.addEventListener("click", () => {
    if (isMaxed) return;
    setDateOffset(offset + 1);
  });

  // Label: single click = calendar, double click = today
  const labelEl = document.getElementById("dsLabel");
  if (labelEl) {
    labelEl.addEventListener("click", () => {
      if (_dsClickTimer) {
        // double click: go to today
        clearTimeout(_dsClickTimer);
        _dsClickTimer = null;
        setDateOffset(0);
        return;
      }
      _dsClickTimer = setTimeout(() => {
        _dsClickTimer = null;
        _openDateCalendar(curDate, minDate, maxDate);
      }, 260);
    });
  }
}

function _openDateCalendar(currentVal, minDate, maxDate) {
  // Remove existing
  document.getElementById("dsCalendarOverlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "dsCalendarOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10000;display:flex;align-items:flex-start;justify-content:center;
    padding-top:80px;background:rgba(0,0,0,.5);
  `;

  overlay.innerHTML = `
    <div style="background:var(--bg1,#0f1117);border:1px solid var(--border,#2a2f45);border-radius:10px;padding:16px;min-width:240px;box-shadow:0 8px 32px rgba(0,0,0,.6)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <span style="font-size:12px;color:var(--text2,#94a3b8);font-weight:600">Choisir une date</span>
        <button id="dsCalClose" style="background:none;border:none;color:var(--text3,#64748b);cursor:pointer;font-size:16px;line-height:1">×</button>
      </div>
      <input type="date" id="dsCalInput"
        value="${currentVal}"
        min="${minDate}"
        max="${maxDate}"
        style="width:100%;padding:8px;background:var(--bg2,#1e2336);border:1px solid var(--border,#2a2f45);color:var(--text1,#e2e8f0);border-radius:6px;font-size:14px;cursor:pointer"
      />
      <div style="display:flex;gap:8px;margin-top:12px">
        <button id="dsCalToday" style="flex:1;padding:7px;background:var(--bg3,#252a3d);border:1px solid var(--border,#2a2f45);color:var(--text2,#94a3b8);border-radius:6px;cursor:pointer;font-size:11px">Aujourd'hui</button>
        <button id="dsCalOk" style="flex:2;padding:7px;background:var(--accent,#4f8ef7);border:none;color:#fff;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600">Confirmer</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const input = document.getElementById("dsCalInput");

  // Auto-open native date picker on mobile
  setTimeout(() => { try { input?.showPicker?.(); } catch(_) {} }, 100);

  const applyDate = (val) => {
    if (!val) return;
    const today = getTodayKey();
    const d1 = new Date(today), d2 = new Date(val);
    const diff = Math.round((d2 - d1) / 86400000);
    overlay.remove();
    setDateOffset(diff);
  };

  document.getElementById("dsCalClose")?.addEventListener("click",  () => overlay.remove());
  document.getElementById("dsCalToday")?.addEventListener("click",  () => { overlay.remove(); setDateOffset(0); });
  document.getElementById("dsCalOk")?.addEventListener("click",     () => applyDate(input?.value));
  input?.addEventListener("change", () => applyDate(input.value));
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
}

// ── renderSettings ────────────────────────────────────────────
function renderSettings() {
  const s = App.settings; if (!s) return;
  if (typeof applySettingsPermissions === "function") applySettingsPermissions();
  const set    = (id,val) => { const el=document.getElementById(id); if(el) el.value=val??""; };
  const setChk = (id,val) => { const el=document.getElementById(id); if(el) el.checked=!!val; };
  const setTxt = (id,val) => { const el=document.getElementById(id); if(el) el.textContent=val??""; };

  setTxt("cardWidthValue",  s.cardWidth  ?? 380);
  setTxt("cardHeightValue", s.cardHeight ?? 160);
  setTxt("cardScaleValue",  s.cardScale  ?? 100);
  setTxt("iconColsValue",   s.iconCols   ?? 0);
  set("cardColorPicker", s.cardColor ?? "#ffffff");
  setChk("showUpdatedAt",    s.showUpdatedAt    !== false);
  setChk("showRoundAlerts",  s.showRoundAlerts  === true);
  setChk("autoSyncEnabled",  s.autoSyncEnabled  === true);
  setTxt("colsValue",       s.cols        ?? 0);
  setTxt("svColsValue",     s.svCols      ?? 2);
  setTxt("svCardHeightValue", s.svCardHeight ?? 160);
  setTxt("svCardScaleValue",  s.svCardScale  ?? 80);

  // Auto-fetch
  setChk("afEnabled",          s.autoFetchEnabled         === true);
  setChk("afPauseBackground",  s.autoFetchPauseBackground === true);
  setTxt("afIntervalValue",    s.autoFetchInterval        ?? 5);

  _renderBtnVisibilityRows(s);
  _renderBtnOrderRows(s);

  set("settingUrlPayment", s.baseUrlPayment);
  App.pmRoutesDraft = (s.pmRoutes || []).map(r => ({ id: r.id, name: r.name, valid: true }));
  renderPmRoutesEditor();
  if (document.getElementById("constatCategList")) _renderCategCF();
  set("constatMaxFirstVisit", s.constatThresholds?.maxFirstVisit || "");
  set("constatMinLastVisit",  s.constatThresholds?.minLastVisit  || "");
  set("constatMinWorkTime",   s.constatThresholds?.minWorkTime   || "");
  App.pmLoadShortcuts(); pmUpdateCount();
  updateCloudButton(); renderVendorsManager();
}

// ── Routes prioritaires (recherche client paiement) — éditeur dynamique
function renderPmRoutesEditor() {
  const box = document.getElementById("pmRoutesContainer");
  const addBtn = document.getElementById("pmRoutesAddBtn");
  if (!box) return;
  const draft = App.pmRoutesDraft || (App.pmRoutesDraft = []);

  box.innerHTML = "";
  draft.forEach((row, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "pm-route-row";
    wrap.innerHTML = `
      <input type="text" class="settings-input pm-route-input ${row.valid ? "" : "pm-route-invalid"}"
             value="${row.valid ? (row.name || row.id) : (row.typed || "")}"
             placeholder="ID ou nom de route" autocomplete="off" />
      <button type="button" class="pm-route-remove" title="Supprimer">✕</button>
    `;
    const input = wrap.querySelector("input");
    const removeBtn = wrap.querySelector(".pm-route-remove");

    let timer = null;
    input.addEventListener("input", () => {
      row.valid = false; row.id = null; row.name = null; row.typed = input.value;
      input.classList.remove("pm-route-invalid");
      clearTimeout(timer);
      const term = input.value.trim();
      closePmRouteSuggestions(wrap);
      if (term.length < 1) { refreshPmRoutesAddBtn(); return; }
      timer = setTimeout(async () => {
        try {
          const baseUrl = (App.settings?.baseUrlPayment || "").replace(/\/$/, "");
          const results = await rpcController.searchRoutes(baseUrl, term);
          showPmRouteSuggestions(wrap, input, idx, results);
        } catch (err) { console.error("searchRoutes error:", err); }
      }, 300);
      refreshPmRoutesAddBtn();
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (!row.valid) input.classList.add("pm-route-invalid");
        closePmRouteSuggestions(wrap);
      }, 150);
    });
    removeBtn.addEventListener("click", () => {
      draft.splice(idx, 1);
      renderPmRoutesEditor();
    });

    box.appendChild(wrap);
  });

  refreshPmRoutesAddBtn();
  if (addBtn && !addBtn._pmBound) {
    addBtn._pmBound = true;
    addBtn.addEventListener("click", () => {
      if (addBtn.disabled) return;
      const liveDraft = App.pmRoutesDraft || (App.pmRoutesDraft = []);
      liveDraft.push({ id: null, name: null, valid: false, typed: "" });
      renderPmRoutesEditor();
    });
  }
}

function refreshPmRoutesAddBtn() {
  const addBtn = document.getElementById("pmRoutesAddBtn");
  if (!addBtn) return;
  const draft = App.pmRoutesDraft || [];
  const allValid = draft.every(r => r.valid);
  addBtn.disabled = !allValid;
  addBtn.style.opacity = allValid ? "1" : ".5";
  addBtn.style.cursor = allValid ? "pointer" : "not-allowed";
}

function closePmRouteSuggestions(wrap) {
  wrap.querySelector(".pm-suggestions")?.remove();
}

function showPmRouteSuggestions(wrap, input, idx, results) {
  closePmRouteSuggestions(wrap);
  if (!results || !results.length) return;
  const box = document.createElement("div");
  box.className = "pm-suggestions";
  results.forEach(r => {
    const item = document.createElement("div");
    item.className = "pm-sugg-item";
    item.innerHTML = `<span class="pm-sugg-key">${r.id}</span><span class="pm-sugg-name">${r.name}</span>`;
    item.addEventListener("mousedown", e => {
      e.preventDefault();
      const row = App.pmRoutesDraft[idx];
      row.id = r.id; row.name = r.name; row.valid = true; row.typed = "";
      renderPmRoutesEditor();
    });
    box.appendChild(item);
  });
  wrap.appendChild(box);
}

// ── Button visibility: 3-state (carte / menu / masqué) ────────
const BTN_DEFS = [
  { key:"open",         label:"Ouvrir tournée"    },
  { key:"route",        label:"Route"              },
  { key:"bl",           label:"BL"                 },
  { key:"analyse",      label:"Analyser BL"        },
  { key:"copy",         label:"Copier référence"   },
  { key:"trash",        label:"Supprimer lien"     },
  { key:"link",         label:"Récupérer lien"     },
  { key:"pay",          label:"Paiement"           },
  { key:"accepthors",   label:"Val. hors tournée"  },
  { key:"closep",       label:"Fermer tournée"     },
  { key:"openp",        label:"Ouvrir tournée"     },
  { key:"addprod",      label:"Ajouter produit"    },
  { key:"stockfinal",   label:"Stock final"        },
  { key:"journalstock", label:"Journal stock"      },
  { key:"addclient",    label:"Ajouter client"     },
  { key:"deleteclient", label:"Supprimer client"   },
  { key:"horszone",     label:"Hors zone"          },
  { key:"reports",      label:"Reports livraison"  },
  { key:"ventes",       label:"Ventes livraison"   },
  { key:"retours",      label:"Retours client"     },
  { key:"showbls",      label:"Liste des BLs"      },
  { key:"chargement",   label:"Bon de chargement"  },
  { key:"showpayments", label:"Liste des paiements"},
  { key:"showclients",  label:"Liste des clients"  },
  { key:"showmap",      label:"Carte de la tournée"},
  { key:"allowaffect",  label:"Autoriser l'affectation"},
];

// Get display mode for a button: "card" | "menu" | "hidden"
function _getBtnMode(s, key) {
  if (s[`menuBtn_${key}`] === true)  return "menu";
  if (s[`hideBtn_${key}`] === true)  return "hidden";
  return "card";
}

function _renderBtnVisibilityRows(s) {
  const container = document.getElementById("btnVisibilityRows");
  if (!container) return;
  container.innerHTML = "";
  BTN_DEFS.forEach(({ key, label }) => {
    const mode = _getBtnMode(s, key);
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:1fr 1fr 1fr;gap:2px 6px;align-items:center;margin-bottom:1px";

    ["card","menu","hidden"].forEach(val => {
      const lbl = document.createElement("label");
      const isActive = mode === val;
      const colors = {
        card:   isActive ? "background:var(--accent-light,#EFF6FF);color:var(--accent,#3B82F6);font-weight:600" : "color:var(--text3,#94A3B8)",
        menu:   isActive ? "background:var(--bg3,#F1F5F9);color:var(--text,#0F172A);font-weight:600"           : "color:var(--text3,#94A3B8)",
        hidden: isActive ? "background:var(--bg3,#F1F5F9);color:var(--text3,#94A3B8);font-weight:600"          : "color:var(--text3,#94A3B8)",
      };
      lbl.style.cssText = `display:flex;align-items:center;gap:5px;font-size:11px;cursor:pointer;padding:2px 4px;border-radius:4px;transition:background .1s;${colors[val]}`;

      const radio = document.createElement("input");
      radio.type  = "radio";
      radio.name  = `btnMode_${key}`;
      radio.value = val;
      radio.checked = isActive;
      radio.style.accentColor = val === "card" ? "var(--accent,#3B82F6)" : "var(--text3,#94A3B8)";

      radio.addEventListener("change", () => {
        // Update App.settings immediately
        App.settings[`hideBtn_${key}`] = val === "hidden";
        App.settings[`menuBtn_${key}`] = val === "menu";
        // Re-render just this row's labels
        row.querySelectorAll("label").forEach((l, i) => {
          const v = ["card","menu","hidden"][i];
          const active = val === v;
          const c = {
            card:   active ? "background:var(--accent-light,#EFF6FF);color:var(--accent,#3B82F6);font-weight:600" : "color:var(--text3,#94A3B8)",
            menu:   active ? "background:var(--bg3,#F1F5F9);color:var(--text,#0F172A);font-weight:600"            : "color:var(--text3,#94A3B8)",
            hidden: active ? "background:var(--bg3,#F1F5F9);color:var(--text3,#94A3B8);font-weight:600"           : "color:var(--text3,#94A3B8)",
          };
          l.style.cssText = `display:flex;align-items:center;gap:5px;font-size:11px;cursor:pointer;padding:2px 4px;border-radius:4px;transition:background .1s;${c[v]}`;
        });
      });

      lbl.appendChild(radio);
      lbl.appendChild(document.createTextNode(val === "card" ? label : val === "menu" ? "Menu" : "Masqué"));
      row.appendChild(lbl);
    });

    container.appendChild(row);
  });
}

// ── Ordre des boutons (drag & drop) ──────────────────────────
const CARD_BTN_LABELS = {
  'open':         'Ouvrir tournée',
  'open-route':   'Ouvrir route',
  'analysebl':    'Analyser BL',
  'copyRef':      'Copier référence',
  'clearRound':   'Effacer lien',
  'fetchLink':    'Récupérer lien',
  'acceptHors':   'Valider hors tournée',
  'planningCtrl': 'Fermer / Ouvrir tournée',
  'payment':      'Encaissement',
  'addProduct':   'Ajouter produit',
  'stockFinal':   'Stock final',
  'journalStock': 'Journal Stock',
  'addClient':    'Ajouter client',
  'deleteClient': 'Supprimer client',
  'showBLs':      'Liste des BLs',
  'showPayments': 'Liste des paiements',
  'showClients':  'Liste des clients',
  'showMap':      'Carte de la tournée',
  'allowAffect':  "Autoriser l'affectation",
  'allowHorsZone':'Autoriser hors zone',
  'showReports':  'Historique reports',
  'showVentes':   'Ventes tournée',
  'showRetours':  'Retours client',
};
const _BTN_ORDER_KEYS = Object.keys(CARD_BTN_LABELS);

function _renderBtnOrderRows(s) {
  const container = document.getElementById("btnOrderRows");
  if (!container) return;
  container.innerHTML = "";
  const order = (s.btnOrder && s.btnOrder.length) ? s.btnOrder : [..._BTN_ORDER_KEYS];
  let dragSrc = null;

  order.forEach(key => {
    const row = document.createElement("div");
    row.className = "btn-order-row";
    row.draggable = true;
    row.dataset.key = key;
    row.innerHTML = `<span class="btn-order-handle">⠿</span><span class="btn-order-label">${CARD_BTN_LABELS[key] || key}</span>`;
    container.appendChild(row);
  });

  container.querySelectorAll(".btn-order-row").forEach(row => {
    row.addEventListener("dragstart", e => {
      dragSrc = row; row.classList.add("btn-order-dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => row.classList.remove("btn-order-dragging"));
    row.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    row.addEventListener("dragenter", () => row.classList.add("btn-order-over"));
    row.addEventListener("dragleave", () => row.classList.remove("btn-order-over"));
    row.addEventListener("drop", e => {
      e.stopPropagation();
      row.classList.remove("btn-order-over");
      if (!dragSrc || dragSrc === row) return;
      const rows = [...container.querySelectorAll(".btn-order-row")];
      const fi = rows.indexOf(dragSrc), ti = rows.indexOf(row);
      container.insertBefore(dragSrc, fi < ti ? row.nextSibling : row);
      App.settings.btnOrder = [...container.querySelectorAll(".btn-order-row")].map(r => r.dataset.key);
      if (typeof saveSettings === "function") saveSettings();
      if (typeof renderCards   === "function") renderCards();
    });
  });
}


function _removeContextMenu() {
  document.getElementById("_vcContextMenu")?.remove();
}

function _showVcContextMenu(e, card) {
  _removeContextMenu();

  const vid    = card.dataset.vendorId;
  const worker = (App.settings?.vendors || []).find(v => String(v.id) === String(vid));
  if (!worker) return;

  const s   = App.settings || {};
  const st  = App.allStats[vid];
  const has = !!App.allLinks[vid];
  const blUrl = buildBlUrl(Array.isArray(App.allLinks[vid]) ? App.allLinks[vid][0] : App.allLinks[vid], worker.role);
  const op  = App.activeOps[vid];
  const dc  = dotClass(has, blUrl, worker.role, App.allRoundStatus[vid], (App.allOdooState||{})[vid], (App.allUserStatus||{})[vid]);
  const showHors = !!(st?.horsRoute) && dc !== "closed" && dc !== "absent";
  const isHorsZone = !!(st?.horsZone);
  const _ralert = App._roundAlerts?.[vid];
  const _alertMatch = _ralert && _ralert.roundId === st?.roundId;
  const _dorders = App._delayedOrders?.[vid];
  const _dMatch = _dorders && _dorders.roundId === st?.roundId;
  const repCount = _dMatch ? (_dorders.picks || []).length : 0;
  const _sorders = App._soldOrders?.[vid];
  const _sMatch = _sorders && _sorders.roundId === st?.roundId;
  const venCount = _sMatch ? (_sorders.sales || []).length : 0;
  const _rorders = App._returnOrders?.[vid];
  const _rMatch = _rorders && _rorders.roundId === st?.roundId;
  const retCount = _rMatch ? (_rorders.returns || []).length : 0;

  // Build menu items based on menuBtn_ settings
  const SVG_MAP = {
    open:         _svgOpen,
    route:        _svgRoute,
    bl:           _svgBl,
    analyse:      _svgAnalyse,
    copy:         _svgCopy,
    trash:        _svgTrash,
    link:         _svgLink,
    pay:          _svgPay,
    accepthors:   _svgAcceptHors,
    closep:       _svgClosePlan,
    openp:        _svgOpenPlan,
    addprod:      _svgAddProduct,
    stockfinal:   _svgStockFinal,
    journalstock: _svgJournalStock,
    addclient:    _svgAddClient,
    deleteclient: _svgDeleteClient,
    horszone:     _svgHorsZone,
    reports:      _svgReports,
    ventes:       _svgVentes,
    retours:      _svgRetours,
    showbls:      _svgBLList,
    chargement:   _svgChargement,
    showpayments: _svgPayList,
    showclients:  _svgClients,
    showmap:      _svgMap,
    allowaffect:  _svgAllowAffect,
  };

  const CSS_MAP = {
    open:         "icon-btn-open",
    route:        "icon-btn-route",
    bl:           "icon-btn-bl",
    analyse:      "icon-btn-analyse",
    copy:         "icon-btn-copy",
    trash:        "icon-btn-trash",
    link:         "icon-btn-link",
    pay:          "icon-btn-pay",
    accepthors:   "icon-btn-hors",
    closep:       dc==="warning" ? "icon-btn-closep icon-btn-orange" : dc==="linked" ? "icon-btn-closep icon-btn-green" : "icon-btn-closep icon-btn-purple",
    openp:        "icon-btn-openp",
    addprod:      "icon-btn-addprod",
    stockfinal:   "icon-btn-stockfinal",
    journalstock: "icon-btn-journalstock",
    addclient:    "icon-btn-addclient",
    deleteclient: "icon-btn-deleteclient",
    horszone:     "icon-btn-horszone",
    reports:      "icon-btn-reports",
    ventes:       "icon-btn-ventes",
    retours:      "icon-btn-retours",
    showbls:      "icon-btn-bllist",
    chargement:   "icon-btn-chargement",
    showpayments: "icon-btn-paylist",
    showclients:  "icon-btn-clients",
    showmap:      "icon-btn-map",
    allowaffect:  "icon-btn-allowaffect",
  };

  const ACTION_MAP = {
    open:         { label:"Ouvrir tournée",     cond: has && !op,                          action:"open"               },
    route:        { label:"Route",               cond: worker.role==="prevente"&&!!worker.routeId, action:"open-route"  },
    bl:           { label:"BL",                  cond: !!blUrl && !op,                      action:"open"               },
    analyse:      { label:"Analyser BL",         cond: !!App.allRefs[vid],                  action:"analysebl"          },
    copy:         { label:"Copier réf.",         cond: has && !op,                          action:"copyRef"            },
    trash:        { label:"Supprimer lien",      cond: has && !op,                          action:"clearRound"         },
    link:         { label:"Récupérer lien",      cond: !op,                                 action:"fetchLink"          },
    pay:          { label:"Paiement",            cond: !!s.baseUrlPayment && App.currentDateOffset===0, action:"payment" },
    accepthors:   { label:"Val. hors tournée",   cond: showHors,                            action:"acceptHors"         },
    closep:       { label:"Fermer tournée",      cond: dc==="warning"||dc==="linked"||dc==="purple", action: dc==="warning"?"closePlanning":"closePlanningConfirm" },
    openp:        { label:"Ouvrir tournée",      cond: dc==="info",                         action:"openPlanning"       },
    addprod:      { label:"Ajouter produit",     cond: (dc==="linked"||dc==="purple")&&worker.role==="livraison", action:"addProduct" },
    stockfinal:   { label:"Stock final",         cond: worker.role==="livraison"&&has,      action:"stockFinal"         },
    journalstock: { label:"Journal stock",       cond: worker.role==="livraison"&&!!st?.roundId, action:"journalStock"  },
    addclient:    { label:"Ajouter client",      cond: (dc==="linked"||dc==="purple")&&has, action:"addClient"          },
    deleteclient: { label:"Supprimer client",    cond: (dc==="linked"||dc==="purple")&&has, action:"deleteClient"       },
    horszone:     { label: "Autoriser hors zone", cond: !isHorsZone, action: "allowHorsZone" },
    reports:      { label: repCount>0 ? `Reports (${repCount})` : "Reports livraison", cond: worker.role==="livraison" && repCount>0, action: "showReports" },
    ventes:       { label: venCount>0 ? `Ventes (${venCount})` : "Ventes livraison", cond: worker.role==="livraison" && venCount>0, action: "showVentes" },
    retours:      { label: retCount>0 ? `Retours (${retCount})` : "Retours client", cond: worker.role==="livraison" && retCount>0, action: "showRetours" },
    showbls:      { label: "Liste des BLs",       cond: !!st?.roundId, action: "showBLs" },
    chargement:   { label: "Bon de chargement",   cond: worker.role==="livraison" && !!st?.roundId, action: "bonChargement" },
    showpayments: { label: "Liste des paiements", cond: !!st?.roundId, action: "showPayments" },
    showclients:  { label: "Liste des clients",   cond: !!st?.roundId, action: "showClients" },
    showmap:      { label: "Carte de la tournée", cond: !!st?.roundId, action: "showMap" },
    allowaffect:  { label: "Autoriser l'affectation", cond: worker.role==="livraison" && dc==="linked" && !!st?.roundId, action: "allowAffect" },
  };

  const items = BTN_DEFS
    .filter(({ key }) => _getBtnMode(s, key) === "menu")
    .map(({ key }) => ({ key, ...ACTION_MAP[key] }))
    .filter(item => item && item.cond);

  if (!items.length) return;

  const menu = document.createElement("div");
  menu.id = "_vcContextMenu";
  menu.style.cssText = `
    position:fixed;z-index:99999;
    background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
    border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.15);
    padding:6px;font-size:12px;
  `;

  const workerName = worker.label || worker.name;
  const title = document.createElement("div");
  title.style.cssText = "padding:4px 6px 6px;font-size:10px;font-weight:700;color:var(--text3,#94A3B8);border-bottom:1px solid var(--border,#E2E8F0);margin-bottom:6px";
  title.textContent = workerName.toUpperCase();
  menu.appendChild(title);

  const grid = document.createElement("div");
  grid.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;justify-content:center;padding:2px;";
  menu.appendChild(grid);

  items.forEach(item => {
    const svgEl = SVG_MAP[item.key] || "";
    const cssClass = CSS_MAP[item.key] || "";
    const svgInner = svgEl.replace(/^<svg[^>]*>/, "");
    const btn = document.createElement("button");
    btn.className = `icon-btn ${cssClass} vb`;
    btn.dataset.action = item.action;
    btn.dataset.vendor = vid;
    btn.title = item.label;
    btn.style.cssText = `width:36px;height:36px;`;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px">${svgInner}</svg>`;
    btn.addEventListener("click", () => {
      _removeContextMenu();
      // dispatch as if a .vb button was clicked
      const fake = document.createElement("button");
      fake.className = "vb";
      fake.dataset.action = item.action;
      fake.dataset.vendor = vid;
      card.appendChild(fake);
      fake.click();
      fake.remove();
    });
    grid.appendChild(btn);
  });

  // Position
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = e.clientX, y = e.clientY;
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  if (x + mw > vw - 8) x = vw - mw - 8;
  if (y + mh > vh - 8) y = vh - mh - 8;
  menu.style.left = x + "px";
  menu.style.top  = y + "px";

  // Close on outside click / scroll
  setTimeout(() => {
    document.addEventListener("click",  _removeContextMenu, { once:true });
    document.addEventListener("scroll", _removeContextMenu, { once:true, capture:true });
    document.addEventListener("keydown", e => { if (e.key==="Escape") _removeContextMenu(); }, { once:true });
  }, 0);
}

// ── renderVendorsManager ──────────────────────────────────────
function renderVendorsManager() {
  const container = document.getElementById("vendorsManager"); if (!container) return;
  container.innerHTML = "";
  let dragSrcIdx = null;
  let dragOverIdx = null;
  (App.settings?.vendors || []).forEach((worker, idx) => {
    const row = document.createElement("div"); row.className="vendor-row"; row.draggable=true; row.dataset.idx=idx; row.title=worker.name;
    const role = worker.role || "prevente";
    row.innerHTML = `
      <span class="vendor-drag-handle" title="Glisser"><svg width="9" height="13" viewBox="0 0 9 13" fill="none"><circle cx="2.5" cy="2" r="1.2" fill="#475569"/><circle cx="6.5" cy="2" r="1.2" fill="#475569"/><circle cx="2.5" cy="6.5" r="1.2" fill="#475569"/><circle cx="6.5" cy="6.5" r="1.2" fill="#475569"/><circle cx="2.5" cy="11" r="1.2" fill="#475569"/><circle cx="6.5" cy="11" r="1.2" fill="#475569"/></svg></span>
      <input type="checkbox" ${worker.enabled?"checked":""} data-idx="${idx}" class="vendor-toggle"/>
      <input type="text" value="${escHtml(worker.name)}" data-idx="${idx}" class="vendor-name-input" placeholder="Nom complet"/>
      <input type="text" value="${escHtml(worker.label||"")}" data-idx="${idx}" class="vendor-label-input" placeholder="Label" maxlength="12"/>
      <input type="text" inputmode="numeric" pattern="[0-9]*" value="${worker.workerId||""}" data-idx="${idx}" class="vendor-workerid-input vendor-label-input" placeholder="ID" maxlength="10"/>
      <select data-idx="${idx}" class="vendor-role-select">
        <option value="prevente"      ${role==="prevente"      ?"selected":""}>Prev.</option>
        <option value="livraison"     ${role==="livraison"     ?"selected":""}>Liv.</option>
        <option value="merch" ${role==="merch" ?"selected":""}>Merch.</option>
        <option value="recouvrement"  ${role==="recouvrement"  ?"selected":""}>Recouv.</option>
      </select>
      <button class="delete-vendor-btn" data-idx="${idx}" title="Supprimer"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
    row.addEventListener("dragstart", e => {
      dragSrcIdx = idx;
      dragOverIdx = null;
      e.dataTransfer.setData("text/plain", String(idx));
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("vendor-row--dragging");
    });
    row.addEventListener("dragend", () => {
      dragSrcIdx = null;
      dragOverIdx = null;
      container.querySelectorAll(".vendor-row").forEach(r => r.classList.remove("vendor-row--dragging","vendor-row--over"));
    });
    row.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      container.querySelectorAll(".vendor-row").forEach(r => r.classList.remove("vendor-row--over"));
      row.classList.add("vendor-row--over");
      dragOverIdx = idx;
    });
    row.addEventListener("drop", e => {
      e.preventDefault();
      e.stopPropagation();
      const si = parseInt(e.dataTransfer.getData("text/plain"));
      const ti = dragOverIdx;
      if (isNaN(si) || ti === null || si === ti) return;
      const vendors = App.settings.vendors;
      const tmp = vendors[si];
      vendors[si] = vendors[ti];
      vendors[ti] = tmp;
      dragSrcIdx = null;
      dragOverIdx = null;
      renderVendorsManager();
    });
    container.appendChild(row);
  });
  container.querySelectorAll(".vendor-toggle")     .forEach(cb  => cb.addEventListener("change", e  => { App.settings.vendors[+e.target.dataset.idx].enabled = e.target.checked; }));
  container.querySelectorAll(".vendor-name-input") .forEach(inp => inp.addEventListener("input",  e  => { App.settings.vendors[+e.target.dataset.idx].name  = e.target.value; }));
  container.querySelectorAll(".vendor-label-input").forEach(inp => inp.addEventListener("input",  e  => { App.settings.vendors[+e.target.dataset.idx].label = e.target.value; }));
  container.querySelectorAll(".vendor-role-select")    .forEach(sel => sel.addEventListener("change", e  => { App.settings.vendors[+e.target.dataset.idx].role     = e.target.value; }));
  container.querySelectorAll(".vendor-workerid-input").forEach(inp => inp.addEventListener("input", e => { const v=parseInt(e.target.value.replace(/\D/g,""),10); App.settings.vendors[+e.target.dataset.idx].workerId = v>0?v:null; }));
  container.querySelectorAll(".delete-vendor-btn") .forEach(btn => btn.addEventListener("click",  e  => { App.settings.vendors.splice(+e.currentTarget.dataset.idx,1); renderVendorsManager(); }));
}

// ── Payment modal ─────────────────────────────────────────────
function pmUpdateCount() {
  const el = document.getElementById("pmShortcutsCount"); if (el) el.textContent = App.pmShortcuts.length;
  const sc = document.getElementById("settingScCount");   if (sc) sc.textContent = App.pmShortcuts.length;
}

function pmShowShortcutsModal() {
  const list = document.getElementById("pmShortcutsList"); if (!list) return;
  if (!App.pmShortcuts.length) { list.innerHTML = '<div class="pm-empty">Aucun raccourci</div>'; return; }
  list.innerHTML = App.pmShortcuts.map((s,i) =>
    `<div class="pm-sc-row"><span class="pm-sc-key">${escHtml(s.shortcut||"")}</span><span class="pm-sc-name">${escHtml(s.fullName)}</span><button class="pm-sc-del" data-idx="${i}">×</button></div>`
  ).join("");
  list.querySelectorAll(".pm-sc-del").forEach(btn => btn.addEventListener("click", () => {
    App.pmShortcuts.splice(parseInt(btn.dataset.idx), 1);
    pmSaveShortcuts(); pmUpdateCount(); pmShowShortcutsModal();
  }));
}
// ── Payment List Modal ────────────────────────────────────────
async function showPaymentsModal(vendorId, _wmContainer = null) {
  const baseUrl = App.settings?.baseUrlPayment?.replace(/\/$/, "") || "";
  const roundId = App.allStats[vendorId]?.roundId;
  if (!roundId || !baseUrl) return;

  const isWM = !!_wmContainer;
  if (!isWM) document.getElementById("payListOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "payListOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.3);padding:16px;
  `;

  overlay.innerHTML = `
    <div id="payListBox" style="
      background:var(--bg2,#fff);
      border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:540px;max-height:85vh;min-height:380px;
      display:flex;flex-direction:column;
      box-shadow:0 8px 32px rgba(0,0,0,.12);overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;
        padding:12px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0;
        background:var(--bg2,#fff)">
        <div style="display:flex;align-items:center;gap:8px">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent,#3B82F6)" stroke-width="2"
            width="16" height="16"><rect x="2" y="5" width="20" height="14" rx="2"/>
            <line x1="2" y1="10" x2="22" y2="10"/></svg>
          <span style="font-size:12px;font-weight:700;color:var(--text,#0F172A)">Paiements de la tournée</span>
          <span id="payTotalBadge" style="display:none;font-size:11px;font-weight:700;padding:2px 8px;border-radius:9px;background:#EFF6FF;color:#3B82F6;border:1px solid #BFDBFE"></span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <div id="payQuickFilterWrap" style="position:relative">
            <button id="payQuickFilterBtn"
              style="background:none;border:1px solid var(--border,#E2E8F0);color:var(--text2,#475569);
              cursor:pointer;font-size:11px;font-weight:600;padding:4px 9px;border-radius:6px;
              display:flex;align-items:center;gap:5px;transition:background .12s"
              onmouseover="
                const m=this.parentElement.querySelector('#payQuickFilterMenu');
                if(m){m.style.display='block';}
                this.style.background='var(--bg3,#F1F5F9)'"
              onmouseout="this.style.background='none'">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
              </svg>
              <span id="payQuickFilterLabel">Filtre</span>
            </button>
            <div id="payQuickFilterMenu" style="display:none;position:absolute;top:100%;right:0;margin-top:4px;
              background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);border-radius:8px;
              box-shadow:0 4px 16px rgba(0,0,0,.15);padding:6px;min-width:170px;z-index:99999"
              onmouseleave="this.style.display='none'">
              ${[
                { key:"posted",     label:"Validé",       color:"#16a34a", bg:"#F0FDF4", border:"#BBF7D0" },
                { key:"draft",      label:"Brouillon",    color:"#2563EB", bg:"#EFF6FF", border:"#BFDBFE" },
                { key:"verified",   label:"Vérifié",      color:"#d97706", bg:"#FFFBEB", border:"#FDE68A" },
                { key:"unverified", label:"Non vérifié",  color:"#64748B", bg:"#F1F5F9", border:"#E2E8F0" },
                { key:"cancel",     label:"Annulé",       color:"#DC2626", bg:"#FEF2F2", border:"#FECACA" },
                { key:"banque",     label:"Banque",       color:"#0891B2", bg:"#ECFEFF", border:"#A5F3FC" },
                { key:"caisse",     label:"Caisse",       color:"#7C3AED", bg:"#F5F3FF", border:"#DDD6FE" },
              ].map(s => `
                <label data-qf-key="${s.key}" style="display:flex;align-items:center;gap:8px;
                  padding:5px 8px;border-radius:5px;cursor:pointer;user-select:none;
                  transition:background .1s"
                  onmouseover="this.style.background='var(--bg3,#F1F5F9)'"
                  onmouseout="this.style.background='none'">
                  <input type="checkbox" class="pay-qf-check" data-qf-key="${s.key}"
                    style="accent-color:${s.color};width:13px;height:13px;cursor:pointer;flex-shrink:0"/>
                  <span style="font-size:11px;font-weight:600;padding:1px 7px;border-radius:9px;
                    background:${s.bg};color:${s.color};border:1px solid ${s.border}">${s.label}</span>
                </label>`).join("")}
              <div style="border-top:1px solid var(--border,#E2E8F0);margin-top:5px;padding-top:5px">
                <button id="payQfClear" style="width:100%;font-size:10px;font-weight:600;
                  padding:4px 8px;border-radius:5px;border:1px solid var(--border,#E2E8F0);
                  background:var(--bg3,#F1F5F9);color:var(--text2,#475569);cursor:pointer">
                  Effacer filtres</button>
              </div>
            </div>
          </div>
          <button id="payListClose" style="background:none;border:none;color:var(--text3,#94A3B8);
            cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;border-radius:4px;
            transition:background .15s" onmouseover="this.style.background='var(--bg3,#F1F5F9)'"
            onmouseout="this.style.background='none'">×</button>
        </div>
      </div>
      <div style="padding:6px 14px;background:var(--bg2,#fff);border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:6px;background:var(--bg3,#F1F5F9);
          border:1px solid var(--border,#E2E8F0);border-radius:6px;padding:4px 8px">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text3,#94A3B8)" stroke-width="2" width="13" height="13">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input id="paySearchInput" type="text" placeholder="Rechercher un client…"
            style="border:none;background:transparent;outline:none;font-size:11px;
            color:var(--text,#0F172A);flex:1;min-width:0"
            oninput="window._payFilterPayments(this.value)"/>
        </div>
      </div>
      <div id="payBulkBar" style="display:none;padding:6px 14px;background:var(--bg2,#fff);
        border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
          <span id="payBulkCount" style="font-size:11px;font-weight:700;color:var(--accent,#3B82F6);
            margin-right:4px;white-space:nowrap">0 sélectionné(s)</span>
          <button class="pay-bulk-btn" data-bulk="draft"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #BFDBFE;background:#EFF6FF;color:#3B82F6;cursor:pointer">
            Brouillon</button>
          <button class="pay-bulk-btn" data-bulk="post"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #BBF7D0;background:#F0FDF4;color:#15803d;cursor:pointer">
            Confirmer</button>
          <button class="pay-bulk-btn" data-bulk="cancel"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #E2E8F0;background:var(--bg3,#F1F5F9);color:#6B7280;cursor:pointer">
            Annuler</button>
          <button id="payBulkSelectAll"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
            color:var(--text2,#475569);cursor:pointer;margin-left:auto">
            Tout sélect.</button>
          <button id="payBulkOpenLinks"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #FDE68A;background:#FFFBEB;color:#B45309;cursor:pointer;
            display:inline-flex;align-items:center;gap:4px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Ouvrir liens</button>
          <button class="pay-bulk-btn" id="payBulkJournalSwitch" data-bulk="journal-switch"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #C4B5FD;background:#F5F3FF;color:#6D28D9;cursor:pointer;
            display:inline-flex;align-items:center;gap:4px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11">
              <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>
              <polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
            </svg>
            Changer journal</button>
          <button class="pay-bulk-btn" id="payBulkTourneeSwitch" data-bulk="tournee-switch"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #C7D2FE;background:#EEF2FF;color:#4338CA;cursor:pointer;
            display:inline-flex;align-items:center;gap:4px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            Changer tournée</button>
        </div>
      </div>
      <div id="payListBody" style="overflow-y:auto;flex:1;padding:12px 14px;
        background:var(--bg,#F8FAFC)">
        <div style="text-align:center;padding:28px;color:var(--text3,#94A3B8)">
          <div class="spinner"></div>
        </div>
      </div>
    </div>
  `;

  if (!isWM) {
    document.body.appendChild(overlay);
    document.getElementById("payListClose")?.addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  } else {
    _wmContainer.innerHTML = overlay.querySelector('div').innerHTML;
  }

  window._payCtx = _wmContainer || document;

  let payments = [];
  try {
    payments = await rpcController.fetchPayments(baseUrl, roundId);
  } catch (e) {
    _payQ("payListBody").innerHTML =
      `<div style="color:var(--red,#ef4444);text-align:center;padding:20px;font-size:12px">
        Erreur: ${escHtml(e.message)}</div>`;
    return;
  }
  window._payAllPayments = payments;
  window._payBaseUrl     = baseUrl;
  _renderPayListBody(payments, baseUrl);

  // ── Quick Filter — bind une seule fois ───────────────────────
  window._payActiveQF = new Set();

  const _updatePayQFLabel = () => {
    const label = _payQ("payQuickFilterLabel");
    if (label) label.textContent = window._payActiveQF.size > 0
      ? `Filtre (${window._payActiveQF.size})` : "Filtre";
  };

  const qfMenuPay = _payQ("payQuickFilterMenu");
  if (qfMenuPay) {
    qfMenuPay.addEventListener("change", e => {
      const cb = e.target.closest(".pay-qf-check");
      if (!cb) return;
      if (cb.checked) window._payActiveQF.add(cb.dataset.qfKey);
      else            window._payActiveQF.delete(cb.dataset.qfKey);
      _updatePayQFLabel();
      _applyPayQF();
    });
  }

  const _clearAllPayQF = () => {
    window._payActiveQF.clear();
    _payQA(".pay-qf-check").forEach(c => { c.checked = false; });
    _updatePayQFLabel();
    _applyPayQF();
    _payQ("payQuickFilterMenu").style.display = "none";
  };

  _payQ("payQfClear")?.addEventListener("click", _clearAllPayQF);

  const _payQfEsc = e => {
    if (e.key !== "Escape") return;
    const menu = _payQ("payQuickFilterMenu");
    if (menu && menu.style.display !== "none") {
      menu.style.display = "none";
      e.stopPropagation();
    } else if (window._payActiveQF?.size > 0) {
      _clearAllPayQF();
      e.stopPropagation();
    }
  };
  document.addEventListener("keydown", _payQfEsc);

  _payQ("payQuickFilterBtn")?.addEventListener("dblclick", e => {
    e.preventDefault();
    _clearAllPayQF();
  });

  const _payQfCleanup = () => document.removeEventListener("keydown", _payQfEsc);
  _payQ("payListClose")?.addEventListener("click", _payQfCleanup, { once: true });
  overlay.addEventListener("remove", _payQfCleanup, { once: true });
}

// ── Payments Modal WM (multi-window) ─────────────────────────
async function showPaymentsModalWM(vendorId) {
  const lbl = (App.settings?.vendors || []).find(v => String(v.id) === String(vendorId))?.label || String(vendorId);
  const SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="var(--accent,#3B82F6)" stroke-width="2" width="15" height="15">
    <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`;
  const win = _wmCreateWindow("pay", vendorId, `Paiements — ${lbl}`, SVG, "560px");
  if (!win) return;
  const { body } = win;
  window._payCtx = body;
  body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text3,#94A3B8);
    font-size:12px;display:flex;align-items:center;justify-content:center;gap:8px">
    <div class="spinner-sm"></div>Chargement…</div>`;
  await showPaymentsModal(vendorId, body);
  win.el?.addEventListener("remove", () => { if (window._payCtx === body) window._payCtx = null; }, { once:true });
}

function _applyPayQF() {
  const allPays = window._payAllPayments || [];
  const baseUrl = window._payBaseUrl || "";
  const qf      = window._payActiveQF;
  const searchQ = (_payQ("paySearchInput")?.value || "").toLowerCase().trim();

  let filtered = allPays;

  if (qf?.size > 0) {
    filtered = filtered.filter(p => [...qf].some(key => {
      switch (key) {
        case "posted":   return p.state === "posted";
        case "draft":    return p.state === "draft";
        case "verified": return p.state === "in_payment" ||
                                p.verified_state === true ||
                                p.verified_state === "verified";
        case "unverified": return !(p.state === "in_payment" ||
                                p.verified_state === true ||
                                p.verified_state === "verified");
        case "cancel":   return p.state === "cancelled" || p.state === "cancel";
        case "banque":   return (Array.isArray(p.journal_id) ? p.journal_id[1] : "")
                                  .includes("Banque ORN WF");
        case "caisse":   return (Array.isArray(p.journal_id) ? p.journal_id[1] : "")
                                  .includes("Caisse Vendeur Oran");
        default:         return false;
      }
    }));
  }

  if (searchQ) {
    const tokens = searchQ.split(/\s+/).filter(Boolean);
    filtered = filtered.filter(p => {
      const partner = (Array.isArray(p.partner_id) ? p.partner_id[1] : "").toLowerCase();
      return tokens.every(t => partner.includes(t));
    });
  }

  _renderPayListBody(filtered, baseUrl);
}

// ── Changement de journal (Encaissement): Banque ORN WF ⇄ Caisse Vendeur Oran ──
// Uniquement autorisé quand le paiement est "Non vérifié" (verified_state !== true/"verified").
const PAY_JOURNAL_SWITCH_SRC = "Banque ORN WF (SARL WAFA FAILE)";
const PAY_JOURNAL_SWITCH_SRC_NAME    = "Banque ORN WF";
const PAY_JOURNAL_SWITCH_SRC_COMPANY = "SARL WAFA FAILE";
const PAY_JOURNAL_SWITCH_DST_NAME    = "Caisse Vendeur Oran";
const PAY_JOURNAL_SWITCH_DST_COMPANY = "SARL WAFA FAILE";
const PAY_JOURNAL_SWITCH_DST_LABEL   = "Caisse Vendeur Oran (SARL WAFA FAILE)";

// Table générique des deux sens de bascule (utilisée par le bouton par-ligne
// et par la bascule groupée). "cacheKey" mémorise l'ID résolu du journal
// cible sur window pour éviter un aller-retour RPC à chaque clic.
const PAY_JOURNAL_SWITCHES = [
  {
    key: "toCaisse",
    srcLabel: PAY_JOURNAL_SWITCH_SRC,
    dstName: PAY_JOURNAL_SWITCH_DST_NAME,
    dstCompany: PAY_JOURNAL_SWITCH_DST_COMPANY,
    dstLabel: PAY_JOURNAL_SWITCH_DST_LABEL,
    shortLabel: "Caisse",
    cacheKey: "_wafaCaisseVendeurOranJournalId",
  },
  {
    key: "toBanque",
    srcLabel: PAY_JOURNAL_SWITCH_DST_LABEL,
    dstName: PAY_JOURNAL_SWITCH_SRC_NAME,
    dstCompany: PAY_JOURNAL_SWITCH_SRC_COMPANY,
    dstLabel: PAY_JOURNAL_SWITCH_SRC,
    shortLabel: "Banque",
    cacheKey: "_wafaBanqueOrnWfJournalId",
  },
];

function _findPayJournalSwitch(journalLabel) {
  return PAY_JOURNAL_SWITCHES.find(cfg => cfg.srcLabel === journalLabel) || null;
}

async function _resolvePayJournalSwitchDstId(baseUrl, cfg) {
  if (!window[cfg.cacheKey]) {
    window[cfg.cacheKey] = await rpcController.resolveJournalId(
      baseUrl, cfg.dstName, cfg.dstCompany
    );
  }
  return window[cfg.cacheKey];
}

// Séquence complète: Brouillon → changement de journal → Confirmer.
// Utilisée par la bascule individuelle et par la bascule groupée (en parallèle).
async function _runPayJournalSwitchSequence(baseUrl, p, cfg) {
  const dstId = await _resolvePayJournalSwitchDstId(baseUrl, cfg);
  if (!dstId) throw new Error(`Journal introuvable: ${cfg.dstLabel}`);

  if (p.state !== "draft") {
    await _rpc_call("", {
      model: "account.payment", method: "action_draft",
      args: [[p.id]], kwargs: {},
    });
  }
  await rpcController.changePaymentJournal(baseUrl, p.id, dstId);
  await _rpc_call("", {
    model: "account.payment", method: "post",
    args: [[p.id]], kwargs: {},
  });

  p.journal_id = [dstId, cfg.dstLabel];
  p.state = "posted";
  return dstId;
}

// Exécute plusieurs bascules en parallèle par lots (pour accélérer le
// traitement groupé sans surcharger le serveur Odoo).
async function _runPayJournalSwitchBatch(baseUrl, items, cfg, concurrency, onItemDone) {
  let cursor = 0;
  const results = [];
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      const p = items[i];
      try {
        await _runPayJournalSwitchSequence(baseUrl, p, cfg);
        results[i] = { ok: true, p };
      } catch (e) {
        results[i] = { ok: false, p, error: e };
      }
      if (onItemDone) onItemDone();
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function _renderPayListBody(payments, baseUrl) {
  const body = _payQ("payListBody");
  if (!body) return;

  const totalBadge = _payQ("payTotalBadge");
  if (totalBadge) {
    if (payments.length) {
      totalBadge.style.display = "inline-block";
      totalBadge.textContent = formatCa(payments.reduce((s,p)=>s+(p.payment_type === "outbound" ? -(p.amount||0) : (p.amount||0)),0));
    } else {
      totalBadge.style.display = "none";
    }
  }

  if (!payments.length) {
    body.innerHTML = `<div style="text-align:center;color:var(--text3,#94A3B8);
      padding:24px;font-size:12px">Aucun paiement trouvé</div>`;
    return;
  }

  const stateLabel = {
    draft:      { label: "Brouillon", color: "#3B82F6", bg: "#EFF6FF" },
    posted:     { label: "Validé",    color: "#15803d", bg: "#F0FDF4" },
    sent:       { label: "Envoyé",    color: "#3B82F6", bg: "#EFF6FF" },
    reconciled: { label: "Lettré",    color: "#15803d", bg: "#F0FDF4" },
    cancelled:  { label: "Annulé",    color: "#6B7280", bg: "var(--bg3,#F1F5F9)" },
  };

  const typeLabel = {
    inbound:  { label: "Encaissement",  color: "#15803d" },
    outbound: { label: "Remboursement", color: "#DC2626" },
  };

  const _mkBtn = (idx, action, label, disabled) => {
    const colors = {
      draft:  { color: "#3B82F6", bg: "#EFF6FF", border: "#BFDBFE", hbg: "#DBEAFE" },
      post:   { color: "#15803d", bg: "#F0FDF4", border: "#BBF7D0", hbg: "#DCFCE7" },
      cancel: { color: "#6B7280", bg: "var(--bg3,#F1F5F9)", border: "#E2E8F0", hbg: "#E2E8F0" },
    };
    const c = colors[action] || colors.cancel;
    if (disabled) {
      return `<button disabled title="Action non disponible"
        style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:6px;
        border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
        color:var(--text3,#94A3B8);cursor:not-allowed">${label}</button>`;
    }
    return `<button class="pl-action-btn" data-idx="${idx}" data-action="${action}"
      style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:6px;
      border:1px solid ${c.border};background:${c.bg};color:${c.color};cursor:pointer;
      transition:background .15s"
      onmouseover="this.style.background='${c.hbg}'"
      onmouseout="this.style.background='${c.bg}'"
      >${label}</button>`;
  };

  body.innerHTML = payments.map((p, idx) => {
    const partner   = Array.isArray(p.partner_id) ? p.partner_id[1] : "—";
    const partnerId = Array.isArray(p.partner_id) ? p.partner_id[0] : null;
    const journal   = Array.isArray(p.journal_id) ? p.journal_id[1] : "—";
    const typeCfg   = typeLabel[p.payment_type]   || { label: p.payment_type || "—", color: "#94A3B8" };
    const st        = stateLabel[p.state]         || { label: p.state, color: "#6B7280", bg: "var(--bg3,#F1F5F9)" };
    const verified  = p.verified_state === true || p.verified_state === "verified";
    const amount    = typeof p.amount === "number"
      ? p.amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ") : "—";
    const payUrl    = `${ODOO_BASE}/web#id=${p.id}&action=267&model=account.payment&view_type=form&cids=1&menu_id=152`;

    const isDraft     = p.state === "draft";
    const isPosted    = p.state === "posted";
    const isCancelled = p.state === "cancelled";

    const btnDraft   = _mkBtn(idx, "draft",  "Brouillon", verified || isDraft);
    const btnConfirm = _mkBtn(idx, "post",   "Confirmer", verified || isPosted);
    const btnCancel  = _mkBtn(idx, "cancel", "Annuler",   verified || isCancelled);

    const swCfg = !verified ? _findPayJournalSwitch(journal) : null;
    const btnSwitch = swCfg ? `<button class="pl-journal-switch-btn" data-idx="${idx}" data-switch-key="${swCfg.key}"
      title="Passer en ${escHtml(swCfg.dstLabel)}"
      style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:6px;
      border:1px solid #FDE68A;background:#FFFBEB;color:#B45309;cursor:pointer;
      transition:background .15s"
      onmouseover="this.style.background='#FEF3C7'"
      onmouseout="this.style.background='#FFFBEB'"
      >${escHtml(swCfg.shortLabel)}</button>` : "";

    const btnOpen = `<a href="${payUrl}" target="_blank"
      style="width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;
      border-radius:6px;border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
      color:var(--accent,#3B82F6);text-decoration:none;flex-shrink:0;transition:background .15s"
      onmouseover="this.style.background='#DBEAFE'"
      onmouseout="this.style.background='var(--bg3,#F1F5F9)'"
      title="${verified ? "Voir" : "Modifier"}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
      </svg></a>`;

    const vendorHeader = p._vendorLabel
      ? `<div style="font-size:10px;font-weight:700;color:var(--text3,#94A3B8);
          text-align:center;padding:2px 8px;background:var(--bg3,#F1F5F9);
          border-radius:4px;margin-bottom:6px">${escHtml(p._vendorLabel)}</div>`
      : "";
    return `
      <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
        border-radius:8px;padding:10px 12px;margin-bottom:8px;
        box-shadow:0 1px 4px rgba(0,0,0,.04)" data-idx="${idx}">
        ${vendorHeader}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            <input type="checkbox" class="pay-row-check" data-idx="${idx}"
              style="width:15px;height:15px;cursor:pointer;accent-color:var(--accent,#3B82F6);flex-shrink:0"/>
            <span style="font-size:12px;font-weight:700;color:var(--text,#0F172A);overflow:hidden;
              text-overflow:ellipsis;white-space:nowrap">${escHtml(partner)}${_clientLinkIconHtml(partnerId, null)}</span>
            ${verified ? "" : `<button class="pl-name-edit" data-idx="${idx}" title="Modifier le client"
              style="width:18px;height:18px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;
              border-radius:5px;border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
              color:var(--text3,#94A3B8);cursor:pointer;padding:0;transition:background .15s,color .15s"
              onmouseover="this.style.background='#DBEAFE';this.style.color='#2563EB'"
              onmouseout="this.style.background='var(--bg3,#F1F5F9)';this.style.color='var(--text3,#94A3B8)'">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/>
              </svg></button>`}
          </div>
          <div style="display:flex;gap:4px;align-items:center;flex-shrink:0">
            <span style="font-size:10px;padding:2px 7px;border-radius:4px;font-weight:600;
              background:${st.bg};color:${st.color}">${st.label}</span>
            <span style="font-size:10px;padding:2px 7px;border-radius:4px;font-weight:600;
              background:${verified?"#F0FDF4":"var(--bg3,#F1F5F9)"};
              color:${verified?"#15803d":"#6B7280"}">
              ${verified ? "✓ Vérifié" : "Non vérifié"}
            </span>
          </div>
        </div>

        <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--text3,#94A3B8)">${escHtml(journal)}</span>
          <span style="font-size:11px;font-weight:600;color:${typeCfg.color}">${typeCfg.label}</span>
          <span id="payAmountDisplay-${idx}" style="font-size:13px;font-weight:700;color:var(--text,#0F172A);margin-left:auto;
            ${verified ? "" : "cursor:pointer;border-bottom:1px dashed var(--text3,#94A3B8)"}"
            ${verified ? "" : `class="pl-amount-edit" data-idx="${idx}" title="Modifier le montant"`}
            >${amount} DA</span>
        </div>

        <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap">
          ${btnDraft}${btnConfirm}${btnCancel}${btnSwitch}
          <button class="pl-tournee-btn" data-idx="${idx}"
            title="Changer la tournée"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:6px;
            border:1px solid #C7D2FE;background:#EEF2FF;color:#4338CA;cursor:pointer;
            transition:background .15s"
            onmouseover="this.style.background='#E0E7FF'"
            onmouseout="this.style.background='#EEF2FF'"
            >Tournée</button>
          <div style="flex:1"></div>
          ${btnOpen}
        </div>
      </div>`;
  }).join("");

  body.querySelectorAll(".pl-action-btn:not([disabled])").forEach(btn => {
    btn.addEventListener("click", () => _payListAction(btn, payments, baseUrl));
  });

  body.querySelectorAll(".pl-tournee-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = payments[parseInt(btn.dataset.idx)];
      if (p) _showChangePaymentTourneeModal([p], payments, baseUrl);
    });
  });

  body.querySelectorAll(".pl-amount-edit").forEach(el => {
    el.addEventListener("click", () => {
      const p = payments[parseInt(el.dataset.idx)];
      if (p) _showEditPaymentAmountModal(p, payments, baseUrl);
    });
  });

  body.querySelectorAll(".pl-name-edit").forEach(el => {
    el.addEventListener("click", () => {
      const p = payments[parseInt(el.dataset.idx)];
      if (p) _showEditPaymentNameModal(p, payments, baseUrl);
    });
  });

  body.querySelectorAll(".pl-journal-switch-btn").forEach(btn => {
    btn.addEventListener("click", () => _showPayJournalSwitchConfirm(btn, payments, baseUrl));
  });

  // ── Bulk selection ────────────────────────────────────────────
  const _updatePayBulkBar = () => {
    const checked = body.querySelectorAll(".pay-row-check:checked");
    const bar     = _payQ("payBulkBar");
    const count   = _payQ("payBulkCount");
    if (bar)   bar.style.display  = checked.length > 0 ? "" : "none";
    if (count) count.textContent  = `${checked.length} sélectionné(s)`;
    const hasVerified = [...checked].some(c => {
      const p = payments[parseInt(c.dataset.idx)];
      return p && (p.verified_state === true || p.verified_state === "verified");
    });
    _payQA(".pay-bulk-btn").forEach(btn => {
      btn.disabled = hasVerified;
      btn.style.opacity = hasVerified ? "0.4" : "1";
      btn.style.cursor  = hasVerified ? "not-allowed" : "pointer";
      btn.title = hasVerified ? "🚫 Un paiement vérifié est sélectionné" : "";
    });
  };

  body.querySelectorAll(".pay-row-check").forEach(cb => {
    cb.addEventListener("change", _updatePayBulkBar);
  });

  const _selectAllBtn = _payQ("payBulkSelectAll");
  if (_selectAllBtn) {
    const _fresh = _selectAllBtn.cloneNode(true);
    _selectAllBtn.replaceWith(_fresh);
    _fresh.addEventListener("click", () => {
      const visibleChecks = [...body.querySelectorAll(".pay-row-check")];
      const allChecked = visibleChecks.length > 0 && visibleChecks.every(c => c.checked);
      visibleChecks.forEach(c => { c.checked = !allChecked; });
      _updatePayBulkBar();
    });
  }

  _payQ("payBulkOpenLinks")?.addEventListener("click", () => {
    const checked = [...body.querySelectorAll(".pay-row-check:checked")];
    if (!checked.length) return;
    checked.forEach(c => {
      const p = payments[parseInt(c.dataset.idx)];
      if (!p) return;
      const url = `${ODOO_BASE}/web#id=${p.id}&action=267&model=account.payment&view_type=form&cids=1&menu_id=152`;
      window.open(url, "_blank");
    });
  });

  _payQA(".pay-bulk-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const action   = btn.dataset.bulk;
      const checked  = [...body.querySelectorAll(".pay-row-check:checked")];
      if (!checked.length) return;
      const selectedPayments = checked.map(c => payments[parseInt(c.dataset.idx)]);
      if (action === "journal-switch") {
        _showPayBulkJournalSwitchConfirm(selectedPayments, payments, baseUrl);
        return;
      }
      if (action === "tournee-switch") {
        _showChangePaymentTourneeModal(selectedPayments, payments, baseUrl);
        return;
      }
      _showPayBulkConfirm(selectedPayments, action, payments, baseUrl);
    });
  });
}

async function _payListAction(btn, payments, baseUrl) {
  const idx    = parseInt(btn.dataset.idx);
  const action = btn.dataset.action;
  const p      = payments[idx];
  if (!p) return;

  const methodMap = { draft: "action_draft", post: "post", cancel: "cancel" };
  const method    = methodMap[action];
  if (!method) return;

  btn.disabled = true;
  btn.style.opacity = "0.5";

  try {
    if (action === "cancel" && p.state !== "draft") {
      await _rpc_call("", {
        model: "account.payment", method: "action_draft",
        args: [[p.id]], kwargs: {},
      });
    }
    await _rpc_call("", {
      model: "account.payment", method: method,
      args: [[p.id]], kwargs: {},
    });
    const stateMap = { draft: "draft", post: "posted", cancel: "cancelled" };
    p.state = stateMap[action] || p.state;
    _renderPayListBody(payments, baseUrl);
  } catch (e) {
addNotif("Erreur: " + e.message, "error");
    btn.disabled = false;
    btn.style.opacity = "1";
  }
}
// ── Confirmation + exécution: changement de journal Banque → Caisse Vendeur ──
async function _showPayJournalSwitchConfirm(btn, payments, baseUrl) {
  const idx = parseInt(btn.dataset.idx);
  const p   = payments[idx];
  if (!p) return;
  const verified = p.verified_state === true || p.verified_state === "verified";
  const journal  = Array.isArray(p.journal_id) ? p.journal_id[1] : "";
  const cfg = _findPayJournalSwitch(journal);
  if (verified || !cfg) return; // garde-fou (re-vérifié au clic)

  document.getElementById("payJournalSwitchOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "payJournalSwitchOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.5);padding:16px;
  `;
  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:360px;padding:20px;
      box-shadow:0 8px 32px rgba(0,0,0,.2)">
      <div style="font-size:13px;font-weight:700;color:var(--text,#0F172A);margin-bottom:8px">
        Changer le journal de l'encaissement
      </div>
      <div style="font-size:11px;color:var(--text2,#475569);margin-bottom:14px;line-height:1.6">
        Passer ce paiement de <span style="font-weight:700">${escHtml(cfg.srcLabel)}</span>
        vers <span style="font-weight:700;color:#B45309">${escHtml(cfg.dstLabel)}</span> ?
        <br><span style="color:var(--text3,#94A3B8)">(Brouillon → changement de journal → Confirmer, automatique)</span>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="payJsNo"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
          color:var(--text2,#475569);cursor:pointer">Annuler</button>
        <button id="payJsYes"
          style="font-size:11px;font-weight:600;padding:6px 16px;border-radius:6px;
          border:none;background:#B45309;color:#fff;cursor:pointer">
          Confirmer</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById("payJsNo")?.addEventListener("click", () => overlay.remove());
  document.getElementById("payJsYes")?.addEventListener("click", async () => {
    const btnYes = document.getElementById("payJsYes");
    const btnNo  = document.getElementById("payJsNo");
    btnYes.disabled = true; btnNo.disabled = true; btnYes.style.opacity = "0.6";
    btnYes.textContent = "…";
    try {
      await _runPayJournalSwitchSequence(baseUrl, p, cfg);
      addNotif("Journal mis à jour → " + cfg.dstLabel, "success");
      overlay.remove();
      _renderPayListBody(payments, baseUrl);
    } catch (e) {
      addNotif("Erreur: " + e.message, "error");
      btnYes.disabled = false; btnNo.disabled = false; btnYes.style.opacity = "1";
      btnYes.textContent = "Confirmer";
    }
  });
}

// ── Lignes de commande (produits) pour les listes Reports/Ventes/Retours ──
// Cache global (survit à la fermeture/réouverture des modales)
window._orderLinesCache = window._orderLinesCache || {};

function _renderOrderLinesHtml(lines) {
  if (!lines || !lines.length) {
    return `<div style="padding:14px 16px;text-align:center;color:var(--text3,#94A3B8);font-size:11px">Aucun article</div>`;
  }
  const totalQty = lines.reduce((s, l) => s + (l.quantity_done || l.product_uom_qty || 0), 0);
  return `
    <div style="padding:6px 0 4px">
      ${lines.map(l => {
        const product = Array.isArray(l.product_id) ? l.product_id[1] : "—";
        const uom     = Array.isArray(l.product_uom) ? l.product_uom[1] : "";
        const qty     = l.quantity_done || l.product_uom_qty || 0;
        return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;
          padding:5px 16px 5px 38px;font-size:11px">
          <span style="color:var(--text2,#475569);flex:1;min-width:0;overflow:hidden;
            text-overflow:ellipsis;white-space:nowrap">${escHtml(productLabel(product))}</span>
          <span style="font-weight:600;color:var(--text,#0F172A);flex-shrink:0">${qty}
            <span style="font-weight:400;color:var(--text3,#94A3B8)">${escHtml(uom)}</span></span>
        </div>`;
      }).join("")}
    </div>
    <div style="padding:5px 16px 8px 38px;border-top:1px solid var(--border,#E2E8F0);margin-top:2px">
      <span style="font-size:10px;color:var(--text3,#94A3B8)">${lines.length} article(s) · Qté totale: ${totalQty}</span>
    </div>`;
}

async function _toggleOrderRowDetails(rowEl, pickingId, baseUrl) {
  const detailsEl = rowEl.querySelector(".order-row-details");
  const chevron   = rowEl.querySelector(".order-row-chevron");
  if (!detailsEl) return;

  const isOpen = rowEl.classList.contains("expanded");
  if (isOpen) {
    rowEl.classList.remove("expanded");
    detailsEl.style.maxHeight = "0px";
    if (chevron) chevron.style.transform = "rotate(0deg)";
    return;
  }

  rowEl.classList.add("expanded");
  if (chevron) chevron.style.transform = "rotate(90deg)";

  const cached = window._orderLinesCache[pickingId];
  if (cached) {
    detailsEl.innerHTML = _renderOrderLinesHtml(cached);
    detailsEl.style.maxHeight = detailsEl.scrollHeight + "px";
    return;
  }

  detailsEl.innerHTML = `<div style="padding:14px;text-align:center"><div class="spinner"></div></div>`;
  detailsEl.style.maxHeight = "50px";

  try {
    const lines = await rpcController.fetchBLLines(baseUrl, pickingId);
    window._orderLinesCache[pickingId] = lines || [];
    if (!rowEl.classList.contains("expanded")) return; // المستخدم أغلق السطر أثناء التحميل
    detailsEl.innerHTML = _renderOrderLinesHtml(lines);
    detailsEl.style.maxHeight = detailsEl.scrollHeight + "px";
  } catch (e) {
    if (!rowEl.classList.contains("expanded")) return;
    detailsEl.innerHTML = `<div style="padding:12px 16px;text-align:center;color:#ef4444;font-size:11px">Erreur: ${escHtml(e.message)}</div>`;
    detailsEl.style.maxHeight = "50px";
  }
}

// ربط التوسيع على كل الأسطر القابلة للضغط ضمن حاوية معيّنة
function _bindOrderRowsExpand(container, baseUrl) {
  container.querySelectorAll(".order-row[data-id]").forEach(row => {
    row.addEventListener("click", e => {
      if (e.target.closest("a,button")) return;
      const id = parseInt(row.dataset.id);
      if (!id) return;
      _toggleOrderRowDetails(row, id, baseUrl);
    });
  });
}

const _orderRowChevronSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
  <polyline points="9 18 15 12 9 6"/>
</svg>`;

// ── نافذة منبثقة لتفاصيل سطر (نفس أسلوب "Liste des BLs") ─────────
async function _showOrderRowDetailsPopup(item, baseUrl, iconSvg) {
  document.getElementById("orderRowDetailsOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "orderRowDetailsOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.45);padding:16px;
  `;
  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:480px;max-height:80vh;
      display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.18);overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;
        padding:12px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent,#3B82F6)" stroke-width="2" width="16" height="16" style="flex-shrink:0">${iconSvg.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'')}</svg>
          <div style="min-width:0">
            <div style="font-size:12px;font-weight:700;color:var(--accent,#3B82F6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(item.name || item.orderRef || "—")}</div>
            ${item.partner ? `<div style="font-size:11px;color:var(--text2,#475569);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(item.partner)}</div>` : ""}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
          ${item.id ? `<a href="${ODOO_BASE}/web#id=${item.id}&action=547&active_id=${item.id}&model=stock.picking&view_type=form&cids=1&menu_id=336"
            target="_blank" style="width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;
            border-radius:6px;border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);color:var(--text2,#475569);text-decoration:none"
            title="Ouvrir le transfert">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </a>` : ""}
          <button id="orderRowDetailsClose" style="background:none;border:none;color:var(--text3,#94A3B8);
            cursor:pointer;font-size:18px;padding:2px 6px;border-radius:4px"
            onmouseover="this.style.background='var(--bg3,#F1F5F9)'"
            onmouseout="this.style.background='none'">×</button>
        </div>
      </div>
      <div id="orderRowDetailsBody" style="overflow-y:auto;flex:1;padding:12px 14px;background:var(--bg,#F8FAFC)">
        <div style="text-align:center;padding:28px;color:var(--text3,#94A3B8)"><div class="spinner"></div></div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  document.getElementById("orderRowDetailsClose")?.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  const body = document.getElementById("orderRowDetailsBody");
  if (!item.id) {
    body.innerHTML = `<div style="text-align:center;color:var(--text3,#94A3B8);padding:24px;font-size:12px">Aucun transfert lié</div>`;
    return;
  }

  let lines = window._orderLinesCache[item.id];
  if (!lines) {
    try {
      lines = await rpcController.fetchBLLines(baseUrl, item.id);
      window._orderLinesCache[item.id] = lines || [];
    } catch(e) {
      body.innerHTML = `<div style="color:#ef4444;text-align:center;padding:20px;font-size:12px">Erreur: ${escHtml(e.message)}</div>`;
      return;
    }
  }

  if (!lines || !lines.length) {
    body.innerHTML = `<div style="text-align:center;color:var(--text3,#94A3B8);padding:24px;font-size:12px">Aucun article</div>`;
    return;
  }

  const totalQty = lines.reduce((s, l) => s + (l.product_uom_qty || l.quantity_done || 0), 0);
  body.innerHTML = `
    <div style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:11px;color:var(--text3,#94A3B8)">${lines.length} article(s)</span>
      <span style="font-size:11px;font-weight:700;color:var(--text,#0F172A)">Qté totale: ${totalQty}</span>
    </div>
    ${lines.map(l => {
      const product = Array.isArray(l.product_id) ? l.product_id[1] : "—";
      const uom     = Array.isArray(l.product_uom) ? l.product_uom[1] : "";
      const qty     = l.product_uom_qty || l.quantity_done || 0;
      const cdn     = l.packaging_quantity ?? 0;
      return `
        <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
          border-radius:8px;padding:10px 12px;margin-bottom:6px;
          display:flex;align-items:center;justify-content:space-between;gap:10px">
          <span style="font-size:11px;color:var(--text,#0F172A);flex:1;line-height:1.4">${escHtml(productLabel(product))}</span>
          <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
            ${cdn ? `<span style="font-size:11px;color:var(--text2,#475569)">${cdn} CDN</span>` : ""}
            <span style="font-size:11px;font-weight:600;color:var(--text,#0F172A)">${qty}
              <span style="font-weight:400;color:var(--text3,#94A3B8)">${escHtml(uom)}</span></span>
          </div>
        </div>`;
    }).join("")}
  `;
}

// ربط الأسطر لتفتح نافذة منبثقة (بدل التوسيع الداخلي) — أسلوب "Liste des BLs"
function _bindOrderRowsPopup(container, items, baseUrl, iconSvg) {
  container.querySelectorAll(".order-row[data-id]").forEach(row => {
    row.addEventListener("click", e => {
      if (e.target.closest("a,button")) return;
      const id = parseInt(row.dataset.id);
      if (!id) return;
      const item = items.find(it => it.id === id);
      if (item) _showOrderRowDetailsPopup(item, baseUrl, iconSvg);
    });
  });
}

// ── BL List Modal ─────────────────────────────────────────────
// ── نافذة: Historique des reports de livraison ────────────────
async function showDelayedOrdersModal(vendorId) {
  const vid = vendorId;
  const st  = App.allStats[vid];
  const _dorders = App._delayedOrders?.[vid];
  const _dMatch = _dorders && _dorders.roundId === st?.roundId;
  const picks = _dMatch ? (_dorders.picks || []) : [];

  document.getElementById("delayedOrdersOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "delayedOrdersOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.3);padding:16px;
  `;

  const rowsHtml = picks.length ? picks.map(p => {
    const url = `${ODOO_BASE}/web#id=${p.id}&action=547&active_id=${p.id}&model=stock.picking&view_type=form&cids=1&menu_id=336`;
    return `<div class="order-row" data-id="${p.id}" style="border-bottom:1px solid var(--border,#E2E8F0);cursor:pointer">
      <div style="display:flex;align-items:center;gap:10px;padding:8px 16px">
        <div class="order-row-chevron" style="width:12px;height:12px;flex-shrink:0;color:var(--text3,#94A3B8);
          transition:transform .18s">${_orderRowChevronSvg}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:600;color:var(--text,#0F172A);
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(p.name || "—")}</div>
          ${p.partner ? `<div style="font-size:11px;color:var(--text3,#94A3B8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(p.partner)}${p.origin ? " · " + escHtml(p.origin) : ""}</div>` : ""}
        </div>
        <a href="${url}" target="_blank" style="width:28px;height:28px;flex-shrink:0;display:inline-flex;
          align-items:center;justify-content:center;border-radius:6px;border:1px solid var(--border,#E2E8F0);
          background:var(--bg3,#F1F5F9);color:var(--text2,#475569);text-decoration:none"
          title="Ouvrir la commande">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </a>
      </div>
      <div class="order-row-details" style="max-height:0;overflow:hidden;transition:max-height .2s ease;background:var(--bg,#F8FAFC)"></div>
    </div>`;
  }).join("") : `<div style="padding:24px;text-align:center;color:var(--text3,#94A3B8);font-size:12px">Aucune commande reportée</div>`;

  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:480px;max-height:85vh;
      display:flex;flex-direction:column;
      box-shadow:0 8px 32px rgba(0,0,0,.12);overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;
        padding:12px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:8px">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent,#3B82F6)" stroke-width="2" width="16" height="16">${_svgReports.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'')}</svg>
          <span style="font-size:12px;font-weight:700;color:var(--text,#0F172A)">Historique des reports de livraison</span>
          ${picks.length ? `<span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:9px;background:#EFF6FF;color:#3B82F6;border:1px solid #BFDBFE">${picks.length}</span>` : ""}
        </div>
        <button id="delayedOrdersClose" style="background:none;border:none;color:var(--text3,#94A3B8);
          cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;border-radius:4px">×</button>
      </div>
      <div style="overflow-y:auto;flex:1">${rowsHtml}</div>
      <div style="padding:8px 16px;border-top:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <span style="font-size:11px;color:var(--text3,#94A3B8)">${picks.length} commande(s) reportée(s)</span>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById("delayedOrdersClose").addEventListener("click", () => overlay.remove());
  _bindOrderRowsPopup(overlay, picks, App.settings?.baseUrlPayment?.replace(/\/$/, "") || "", _svgReports);
}

async function showSoldOrdersModal(vendorId) {
  const vid = vendorId;
  const st  = App.allStats[vid];
  const _sorders = App._soldOrders?.[vid];
  const _sMatch = _sorders && _sorders.roundId === st?.roundId;
  const sales = _sMatch ? (_sorders.sales || []) : [];

  document.getElementById("soldOrdersOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "soldOrdersOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.3);padding:16px;
  `;

  const rowsHtml = sales.length ? sales.map(s => {
    const hasPick = !!s.id;
    const url = hasPick ? `${ODOO_BASE}/web#id=${s.id}&action=547&active_id=${s.id}&model=stock.picking&view_type=form&cids=1&menu_id=336` : null;
    return `<div class="order-row" ${hasPick ? `data-id="${s.id}"` : ""} style="border-bottom:1px solid var(--border,#E2E8F0);${hasPick ? "cursor:pointer" : ""}">
      <div style="display:flex;align-items:center;gap:10px;padding:8px 16px">
        ${hasPick ? `<div class="order-row-chevron" style="width:12px;height:12px;flex-shrink:0;color:var(--text3,#94A3B8);
          transition:transform .18s">${_orderRowChevronSvg}</div>` : `<div style="width:12px;flex-shrink:0"></div>`}
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:600;color:var(--text,#0F172A);
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(s.partner || "—")}</div>
          <div style="font-size:11px;color:var(--text3,#94A3B8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(s.name || s.orderRef || "—")}</div>
        </div>
        ${hasPick ? `<a href="${url}" target="_blank" style="width:28px;height:28px;flex-shrink:0;display:inline-flex;
          align-items:center;justify-content:center;border-radius:6px;border:1px solid var(--border,#E2E8F0);
          background:var(--bg3,#F1F5F9);color:var(--text2,#475569);text-decoration:none"
          title="Ouvrir le transfert">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </a>` : `<span style="width:28px;height:28px;flex-shrink:0;display:inline-flex;
          align-items:center;justify-content:center;border-radius:6px;border:1px solid var(--border,#E2E8F0);
          background:var(--bg3,#F1F5F9);color:var(--text3,#CBD5E1)" title="Aucun transfert lié">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </span>`}
      </div>
      ${hasPick ? `<div class="order-row-details" style="max-height:0;overflow:hidden;transition:max-height .2s ease;background:var(--bg,#F8FAFC)"></div>` : ""}
    </div>`;
  }).join("") : `<div style="padding:24px;text-align:center;color:var(--text3,#94A3B8);font-size:12px">Aucune vente</div>`;

  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:480px;max-height:85vh;
      display:flex;flex-direction:column;
      box-shadow:0 8px 32px rgba(0,0,0,.12);overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;
        padding:12px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:8px">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent,#3B82F6)" stroke-width="2" width="16" height="16">${_svgVentes.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'')}</svg>
          <span style="font-size:12px;font-weight:700;color:var(--text,#0F172A)">Ventes de la tournée</span>
          ${sales.length ? `<span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:9px;background:#EFF6FF;color:#3B82F6;border:1px solid #BFDBFE">${formatCa(sales.reduce((s,x)=>s+(x.amount||0),0))}</span>` : ""}
        </div>
        <button id="soldOrdersClose" style="background:none;border:none;color:var(--text3,#94A3B8);
          cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;border-radius:4px">×</button>
      </div>
      <div style="overflow-y:auto;flex:1">${rowsHtml}</div>
      <div style="padding:8px 16px;border-top:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <span style="font-size:11px;color:var(--text3,#94A3B8)">${sales.length} vente(s)</span>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById("soldOrdersClose").addEventListener("click", () => overlay.remove());
  _bindOrderRowsPopup(overlay, sales, App.settings?.baseUrlPayment?.replace(/\/$/, "") || "", _svgVentes);
}

async function showReturnOrdersModal(vendorId) {
  const vid = vendorId;
  const st  = App.allStats[vid];
  const _rorders = App._returnOrders?.[vid];
  const _rMatch = _rorders && _rorders.roundId === st?.roundId;
  const returns = _rMatch ? (_rorders.returns || []) : [];

  document.getElementById("returnOrdersOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "returnOrdersOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.3);padding:16px;
  `;

  const rowsHtml = returns.length ? returns.map(r => {
    const url = `${ODOO_BASE}/web#id=${r.id}&action=547&active_id=${r.id}&model=stock.picking&view_type=form&cids=1&menu_id=336`;
    return `<div class="order-row" data-id="${r.id}" style="border-bottom:1px solid var(--border,#E2E8F0);cursor:pointer">
      <div style="display:flex;align-items:center;gap:10px;padding:8px 16px">
        <div class="order-row-chevron" style="width:12px;height:12px;flex-shrink:0;color:var(--text3,#94A3B8);
          transition:transform .18s">${_orderRowChevronSvg}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:600;color:var(--text,#0F172A);
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(r.partner || "—")}</div>
          <div style="font-size:11px;color:var(--text3,#94A3B8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(r.name || "—")}</div>
        </div>
        <a href="${url}" target="_blank" style="width:28px;height:28px;flex-shrink:0;display:inline-flex;
          align-items:center;justify-content:center;border-radius:6px;border:1px solid var(--border,#E2E8F0);
          background:var(--bg3,#F1F5F9);color:var(--text2,#475569);text-decoration:none"
          title="Ouvrir le transfert">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </a>
      </div>
      <div class="order-row-details" style="max-height:0;overflow:hidden;transition:max-height .2s ease;background:var(--bg,#F8FAFC)"></div>
    </div>`;
  }).join("") : `<div style="padding:24px;text-align:center;color:var(--text3,#94A3B8);font-size:12px">Aucun retour</div>`;

  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:480px;max-height:85vh;
      display:flex;flex-direction:column;
      box-shadow:0 8px 32px rgba(0,0,0,.12);overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;
        padding:12px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:8px">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent,#3B82F6)" stroke-width="2" width="16" height="16">${_svgRetours.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'')}</svg>
          <span style="font-size:12px;font-weight:700;color:var(--text,#0F172A)">Retours client</span>
          ${returns.length ? `<span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:9px;background:#EFF6FF;color:#3B82F6;border:1px solid #BFDBFE">${formatCa(returns.reduce((s,x)=>s+(x.amount||0),0))}</span>` : ""}
        </div>
        <button id="returnOrdersClose" style="background:none;border:none;color:var(--text3,#94A3B8);
          cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;border-radius:4px">×</button>
      </div>
      <div style="overflow-y:auto;flex:1">${rowsHtml}</div>
      <div style="padding:8px 16px;border-top:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <span style="font-size:11px;color:var(--text3,#94A3B8)">${returns.length} retour(s)</span>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById("returnOrdersClose").addEventListener("click", () => overlay.remove());
  _bindOrderRowsPopup(overlay, returns, App.settings?.baseUrlPayment?.replace(/\/$/, "") || "", _svgRetours);
}

async function showBLsModal(vendorId, _wmContainer = null) {
  const baseUrl = App.settings?.baseUrlPayment?.replace(/\/$/, "") || "";
  const roundId = App.allStats[vendorId]?.roundId;
  if (!roundId || !baseUrl) return;

  const isWM = !!_wmContainer;
  if (!isWM) document.getElementById("blListOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "blListOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.3);padding:16px;
  `;

  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:540px;max-height:85vh;min-height:380px;
      display:flex;flex-direction:column;
      box-shadow:0 8px 32px rgba(0,0,0,.12);overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;
        padding:12px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:8px">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent,#3B82F6)" stroke-width="2"
            width="16" height="16"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/></svg>
          <span style="font-size:12px;font-weight:700;color:var(--text,#0F172A)">Bons de livraison</span>
          <span id="blTotalBadge" style="display:none;font-size:11px;font-weight:700;padding:2px 8px;border-radius:9px;background:#EFF6FF;color:#3B82F6;border:1px solid #BFDBFE"></span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;position:relative">
          <div id="blQuickFilterWrap" style="position:relative">
            <button id="blQuickFilterBtn"
              style="background:none;border:1px solid var(--border,#E2E8F0);color:var(--text2,#475569);
              cursor:pointer;font-size:11px;font-weight:600;padding:4px 9px;border-radius:6px;
              display:flex;align-items:center;gap:5px;transition:background .12s"
              onmouseover="
                const m=this.parentElement.querySelector('#blQuickFilterMenu');
                if(m){m.style.display='block';}
                this.style.background='var(--bg3,#F1F5F9)'"
              onmouseout="this.style.background='none'">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
              </svg>
              <span id="blQuickFilterLabel">Filtre</span>
            </button>
            <div id="blQuickFilterMenu" style="display:none;position:absolute;top:100%;right:0;margin-top:4px;
              background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);border-radius:8px;
              box-shadow:0 4px 16px rgba(0,0,0,.15);padding:6px;min-width:170px;z-index:99999"
              onmouseleave="this.style.display='none'">
              ${[
                { key:"scheduled", label:"Planifié",  color:"#8B5CF6", bg:"#F3E8FF", border:"#E9D5FF" },
                { key:"delayed",   label:"Reporté",   color:"#F59E0B", bg:"#FFF7ED", border:"#FED7AA" },
                { key:"canceled",  label:"Annulé",    color:"#DC2626", bg:"#FEF2F2", border:"#FECACA" },
                { key:"done",      label:"Livré",     color:"#16a34a", bg:"#F0FDF4", border:"#BBF7D0" },
                { key:"assigned",  label:"Prêt",      color:"#2563EB", bg:"#EFF6FF", border:"#BFDBFE" },
                { key:"waiting",   label:"En attente",color:"#d97706", bg:"#FFFBEB", border:"#FDE68A" },
                { key:"confirmed", label:"Confirmé",  color:"#7C3AED", bg:"#EDE9FE", border:"#DDD6FE" },
              ].map(s => `
                <label data-qf-key="${s.key}" style="display:flex;align-items:center;gap:8px;
                  padding:5px 8px;border-radius:5px;cursor:pointer;user-select:none;
                  transition:background .1s"
                  onmouseover="this.style.background='var(--bg3,#F1F5F9)'"
                  onmouseout="this.style.background='none'">
                  <input type="checkbox" class="bl-qf-check" data-qf-key="${s.key}"
                    style="accent-color:${s.color};width:13px;height:13px;cursor:pointer;flex-shrink:0"/>
                  <span style="font-size:11px;font-weight:600;padding:1px 7px;border-radius:9px;
                    background:${s.bg};color:${s.color};border:1px solid ${s.border}">${s.label}</span>
                </label>`).join("")}
              <div style="border-top:1px solid var(--border,#E2E8F0);margin-top:5px;padding-top:5px">
                <button id="blQfClear" style="width:100%;font-size:10px;font-weight:600;
                  padding:4px 8px;border-radius:5px;border:1px solid var(--border,#E2E8F0);
                  background:var(--bg3,#F1F5F9);color:var(--text2,#475569);cursor:pointer">
                  Effacer filtres</button>
              </div>
            </div>
          </div>
          <button id="blListClose" style="background:none;border:none;color:var(--text3,#94A3B8);
            cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;border-radius:4px"
            onmouseover="this.style.background='var(--bg3,#F1F5F9)'"
            onmouseout="this.style.background='none'">×</button>
        </div>
      </div>
      <div style="padding:8px 14px;border-bottom:1px solid var(--border,#E2E8F0);background:var(--bg2,#fff);flex-shrink:0">
        <a href="${ODOO_BASE}/web#action=547&active_id=${roundId}&model=stock.picking&view_type=list&cids=1&menu_id=336"
          target="_blank"
          style="display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;
          padding:5px 12px;border-radius:6px;border:1px solid #BFDBFE;background:#EFF6FF;
          color:#2563EB;text-decoration:none;transition:background .15s"
          onmouseover="this.style.background='#DBEAFE'"
          onmouseout="this.style.background='#EFF6FF'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
          
        </a>
      </div>
      <div style="padding:6px 14px;background:var(--bg2,#fff);border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:6px;background:var(--bg3,#F1F5F9);
          border:1px solid var(--border,#E2E8F0);border-radius:6px;padding:4px 8px">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text3,#94A3B8)" stroke-width="2" width="13" height="13">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input id="blSearchInput" type="text" placeholder="Rechercher un client…"
            style="border:none;background:transparent;outline:none;font-size:11px;
            color:var(--text,#0F172A);flex:1;min-width:0"
            oninput="window._blFilterBls(this.value)"/>
          <button id="blAdvSearchToggle" title="Recherche avancée"
            style="background:none;border:none;cursor:pointer;padding:2px;display:flex;
            align-items:center;color:var(--text3,#94A3B8);border-radius:4px;transition:color .15s"
            onmouseover="this.style.color='var(--accent,#3B82F6)'"
            onmouseout="this.style.color=window._blAdvOpen?'var(--accent,#3B82F6)':'var(--text3,#94A3B8)'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
            </svg>
          </button>
        </div>
        <div id="blAdvSearchPanel" style="display:none;margin-top:6px"></div>
      </div>
      <div id="blBulkBar" style="display:none;padding:6px 14px;background:var(--bg2,#fff);
        border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
          <span id="blBulkCount" style="font-size:11px;font-weight:700;color:var(--accent,#3B82F6);
            margin-right:4px;white-space:nowrap">0 sélectionné(s)</span>
          <button class="bl-bulk-btn" data-bulk="scheduled"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #E9D5FF;background:#F3E8FF;color:#8B5CF6;cursor:pointer">
            Planifié</button>
          <button class="bl-bulk-btn" data-bulk="delayed"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #FED7AA;background:#FFF7ED;color:#F59E0B;cursor:pointer">
            Reporté</button>
          <button class="bl-bulk-btn" data-bulk="canceled"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #E2E8F0;background:var(--bg3,#F1F5F9);color:#6B7280;cursor:pointer">
            Annulé</button>
          <button class="bl-bulk-btn" data-bulk="unlink"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #FECACA;background:#FEF2F2;color:#DC2626;cursor:pointer">
            Désaffecter</button>
          <button id="blBulkChangeTournee"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #BFDBFE;background:#EFF6FF;color:#2563EB;cursor:pointer">
            ⇄ Tournée</button>
          <button id="blBulkSelectAll"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
            color:var(--text2,#475569);cursor:pointer;margin-left:auto">
            Tout sélect.</button>
          <button id="blBulkOpenLinks"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #BBF7D0;background:#F0FDF4;color:#15803d;cursor:pointer;
            display:flex;align-items:center;gap:4px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            Ouvrir liens</button>
          <button id="blBulkPdfBtn"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #FECACA;background:#FEF2F2;color:#DC2626;cursor:pointer;
            display:flex;align-items:center;gap:4px">
            📄 PDF</button>
        </div>
      </div>
      <div id="blListBody" style="overflow-y:auto;flex:1;padding:12px 14px;background:var(--bg,#F8FAFC)">
        <div style="text-align:center;padding:28px;color:var(--text3,#94A3B8)">
          <div class="spinner"></div>
        </div>
      </div>
    </div>
  `;

  if (!isWM) {
    document.body.appendChild(overlay);
    document.getElementById("blListClose")?.addEventListener("click", () => overlay.remove());
  } else {
    // WM mode: inject full BL UI into container
    _wmContainer.innerHTML = overlay.querySelector('div').innerHTML;
  }

  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  overlay.addEventListener("remove", () => { window._blCtx = null; }, { once:true });

  window._blCtx = _wmContainer || document;

  let bls = [];
  try {
    bls = await rpcController.fetchBLs(baseUrl, roundId, App.currentMode);
  } catch(e) {
    _blQ("blListBody").innerHTML =
      `<div style="color:var(--red,#ef4444);text-align:center;padding:20px;font-size:12px">
        Erreur: ${escHtml(e.message)}</div>`;
    return;
  }

  try {
    if (rpcController.fetchAllBLsLines) {
      const linesMap = await rpcController.fetchAllBLsLines(baseUrl, bls.map(b => b.id));
      bls.forEach(b => { b._lines = linesMap[b.id] || []; });
    } else {
      bls.forEach(b => { b._lines = []; });
    }
  } catch(_) { bls.forEach(b => { b._lines = []; }); }
  window._currentBLs       = bls;
  window._currentBLBaseUrl = baseUrl;
  _renderBLListBody(bls, baseUrl);

  // ── Quick Filter — bind une seule fois ────────────────────────
  window._blActiveQF = new Set();

  const _updateQFLabel = () => {
    const label = _blQ("blQuickFilterLabel");
    if (label) label.textContent = window._blActiveQF.size > 0
      ? `Filtre (${window._blActiveQF.size})` : "Filtre";
  };

  // délégation sur le menu (pas de re-bind à chaque render)
  const qfMenu = _blQ("blQuickFilterMenu");
  if (qfMenu) {
    qfMenu.addEventListener("change", e => {
      const cb = e.target.closest(".bl-qf-check");
      if (!cb) return;
      if (cb.checked) window._blActiveQF.add(cb.dataset.qfKey);
      else            window._blActiveQF.delete(cb.dataset.qfKey);
      _updateQFLabel();
      _applyBLFilters(bls, baseUrl);
    });
  }

  _blQ("blQfClear")?.addEventListener("click", () => {
    window._blActiveQF.clear();
    _blQA(".bl-qf-check").forEach(c => { c.checked = false; });
    _updateQFLabel();
    _applyBLFilters(bls, baseUrl);
    _blQ("blQuickFilterMenu").style.display = "none";
  });

  // ── helper مشترك: إلغاء كل الفلاتر ─────────────────────────
  const _clearAllQF = () => {
    window._blActiveQF.clear();
    _blQA(".bl-qf-check").forEach(c => { c.checked = false; });
    _updateQFLabel();
    _applyBLFilters(bls, baseUrl);
    _blQ("blQuickFilterMenu").style.display = "none";
  };

  // Escape: إذا القائمة مفتوحة → أغلقها، إذا فلاتر نشطة → ألغها
  const _blQfEsc = e => {
    if (e.key !== "Escape") return;
    const menu = _blQ("blQuickFilterMenu");
    if (menu && menu.style.display !== "none") {
      menu.style.display = "none";
      e.stopPropagation();
    } else if (window._blActiveQF?.size > 0) {
      _clearAllQF();
      e.stopPropagation();
    }
  };
  document.addEventListener("keydown", _blQfEsc);

  // double-click على زر Filtre → إلغاء كل الفلاتر
  _blQ("blQuickFilterBtn")?.addEventListener("dblclick", e => {
    e.preventDefault();
    _clearAllQF();
  });

  // نظّف عند إغلاق النافذة
  overlay.addEventListener("remove", () => document.removeEventListener("keydown", _blQfEsc), { once: true });
  document.getElementById("blListClose")?.addEventListener("click", () => document.removeEventListener("keydown", _blQfEsc), { once: true });
}

// ── Carte de la tournée (Leaflet) ──────────────────────────────
async function showRoundMapModal(vendorIdOrIds) {
  const vendorIds = Array.isArray(vendorIdOrIds) ? vendorIdOrIds : [vendorIdOrIds];
  const baseUrl  = App.settings?.baseUrlPayment?.replace(/\/$/, "") || "";
  if (!baseUrl) return;
  const validIds = vendorIds.filter(vid => App.allStats[vid]?.roundId);
  if (!validIds.length) return;

  const _vendorOf = vid => (App.settings?.vendors || []).find(v => String(v.id) === String(vid));
  // اسم/شارة العنوان: اسم البائع الوحيد إن كانت تورنية واحدة، أو عدد التورنيات إن كانت مجموعة
  const _vendorLbl = validIds.length === 1
    ? ((_vendorOf(validIds[0])?.label) || String(validIds[0]))
    : `${validIds.length} tournées sélectionnées`;
  // الدور (prevente/recouvrement) يُحدَّد حسب أول تورنية محددة — يوحّد الألوان/الفلاتر عند تحديد عدة تورنيات
  const _isPrevendeur = _vendorOf(validIds[0])?.role === "prevente";
  const _isRecouvrement = _vendorOf(validIds[0])?.role === "recouvrement";

  let mapRef = null, groupRef = null; // مراجع مُعبّأة لاحقًا بعد إنشاء الخريطة — تُستعمل من زر التكبير المربوط مبكرًا

  // تحديث صامت لبيانات Vente/Reporté/Retour لكل تورنية محددة قبل بناء الخريطة (بدون إظهار أي مؤشر للمستخدم)
  for (const _vid of validIds) {
    const _rId = App.allStats[_vid]?.roundId;
    if (!_rId) continue;
    try {
      const [freshSales, freshDelays, freshReturns] = await Promise.all([
        rpcController.fetchSoldOrders(baseUrl, _rId).catch(() => null),
        rpcController.fetchDelayedOrders(baseUrl, _rId).catch(() => null),
        rpcController.fetchReturnOrders(baseUrl, _rId).catch(() => null),
      ]);
      if (freshSales) {
        if (!App._soldOrders) App._soldOrders = {};
        App._soldOrders[_vid] = { roundId: _rId, sales: freshSales };
      }
      if (freshDelays) {
        if (!App._delayedOrders) App._delayedOrders = {};
        App._delayedOrders[_vid] = { roundId: _rId, picks: freshDelays };
      }
      if (freshReturns) {
        if (!App._returnOrders) App._returnOrders = {};
        App._returnOrders[_vid] = { roundId: _rId, returns: freshReturns };
      }
    } catch (_) {}
  }

  document.getElementById("roundMapOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "roundMapOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.3);padding:16px;
  `;
  overlay.innerHTML = `
    <div id="roundMapBox" style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:720px;max-height:88vh;height:640px;
      display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.12);overflow:hidden;
      transition:max-width .18s ease,width .18s ease,height .18s ease,max-height .18s ease">
      <div style="display:flex;align-items:center;justify-content:space-between;
        padding:12px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent,#3B82F6)" stroke-width="2"
            width="16" height="16">${_svgMap.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'')}</svg>
          <span style="font-size:12px;font-weight:700;color:var(--text,#0F172A);flex-shrink:0">Carte de la tournée</span>
          <span id="roundMapVendor" style="font-size:11px;font-weight:700;padding:2px 8px;
            border-radius:9px;background:#F5F3FF;color:#7C3AED;border:1px solid #DDD6FE;max-width:150px;
            overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(_vendorLbl)}</span>
          <span id="roundMapCount" style="display:none;font-size:11px;font-weight:700;padding:2px 8px;
            border-radius:9px;background:#EFF6FF;color:#3B82F6;border:1px solid #BFDBFE;flex-shrink:0"></span>
          <div style="display:flex;align-items:center;gap:6px;background:var(--bg3,#F1F5F9);
            border:1px solid var(--border,#E2E8F0);border-radius:6px;padding:4px 8px;min-width:0;flex:1;max-width:180px">
            <svg viewBox="0 0 24 24" fill="none" stroke="var(--text3,#94A3B8)" stroke-width="2" width="13" height="13" style="flex-shrink:0">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input id="roundMapSearchInput" type="text" placeholder="Rechercher un client…"
              style="border:none;background:transparent;outline:none;font-size:11px;
              color:var(--text,#0F172A);flex:1;min-width:0"/>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:2px;flex-shrink:0">
          <button id="roundMapExpand" title="Agrandir" style="background:none;border:none;color:var(--text3,#94A3B8);
            cursor:pointer;line-height:1;padding:5px 6px;border-radius:4px;display:flex"
            onmouseover="this.style.background='var(--bg3,#F1F5F9)'"
            onmouseout="this.style.background='none'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15">
              <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
              <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
            </svg>
          </button>
          <button id="roundMapClose" style="background:none;border:none;color:var(--text3,#94A3B8);
            cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;border-radius:4px"
            onmouseover="this.style.background='var(--bg3,#F1F5F9)'"
            onmouseout="this.style.background='none'">×</button>
        </div>
      </div>
      <div id="roundMapBody" style="flex:1;position:relative;background:var(--bg,#F8FAFC)">
        <div id="roundMapLoading" style="position:absolute;inset:0;display:flex;align-items:center;
          justify-content:center;color:var(--text3,#94A3B8)"><div class="spinner"></div></div>
        <div id="roundMapEl" style="width:100%;height:100%"></div>
        <div id="roundMapNoResults" style="display:none;position:absolute;top:10px;left:50%;transform:translateX(-50%);
          z-index:500;font-size:11px;font-weight:700;color:#94A3B8;background:#fff;border:1px solid #E2E8F0;
          border-radius:8px;padding:5px 12px;box-shadow:0 2px 8px rgba(15,23,42,.08)">Aucun résultat</div>
        <div id="roundMapSelectRect" style="display:none;position:absolute;z-index:600;border:1.5px dashed #3B82F6;
          background:rgba(59,130,246,.12);pointer-events:none"></div>
        <div id="roundMapSelectPanel" style="display:none;position:absolute;top:10px;right:10px;z-index:650;
          width:220px;max-width:calc(100% - 20px);background:#0F172A;color:#fff;border-radius:12px;
          box-shadow:0 10px 30px rgba(15,23,42,.35);padding:10px 12px;font-family:inherit">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <span id="roundMapSelectCount" style="font-size:12px;font-weight:800"></span>
            <button id="roundMapSelectClear" title="Annuler la sélection" style="background:none;border:none;
              color:#94A3B8;cursor:pointer;font-size:15px;line-height:1;padding:2px 4px">×</button>
          </div>
          <div id="roundMapSelectStats" style="display:flex;flex-direction:column;gap:3px;font-size:11px"></div>
          <div id="roundMapSelectDistance" style="display:none;margin-top:7px;padding-top:7px;
            border-top:1px solid rgba(255,255,255,.12);font-size:11px;font-weight:700;color:#93C5FD;
            white-space:nowrap"></div>
        </div>
      </div>
      <div id="roundMapFilters" style="display:none;flex-shrink:0;max-height:200px;overflow-y:auto;
        border-top:1px solid var(--border,#E2E8F0);background:var(--bg2,#fff);padding:8px 10px"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  const _close = () => {
    if (typeof _rmapOnMouseMove === "function") document.removeEventListener("mousemove", _rmapOnMouseMove);
    if (typeof _rmapOnMouseUp === "function") document.removeEventListener("mouseup", _rmapOnMouseUp);
    overlay.remove();
  };
  document.getElementById("roundMapClose")?.addEventListener("click", _close);
  overlay.addEventListener("click", e => { if (e.target === overlay) _close(); });

  // ── زر تكبير/تصغير نافذة الخريطة ────────────────────────────
  const _expandIcon = `<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
    <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>`;
  const _collapseIcon = `<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/>
    <line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>`;
  document.getElementById("roundMapExpand")?.addEventListener("click", () => {
    const box = document.getElementById("roundMapBox");
    if (!box) return;
    const expanded = box.classList.toggle("rmap-expanded");
    const btn = document.getElementById("roundMapExpand");
    if (btn) {
      btn.title = expanded ? "Réduire" : "Agrandir";
      btn.querySelector("svg").innerHTML = expanded ? _collapseIcon : _expandIcon;
    }
    setTimeout(() => {
      try {
        mapRef?.invalidateSize();
        if (mapRef && groupRef) mapRef.fitBounds(groupRef.getBounds().pad(0.15));
      } catch (_) {}
    }, 190); // بعد انتهاء انتقال CSS الخاص بتغيير الحجم
  });

  // ── تصميم عصري لفقاعات الخريطة (leaflet popup) ─────────────
  if (!document.getElementById("rmapPopupStyle")) {
    const styleEl = document.createElement("style");
    styleEl.id = "rmapPopupStyle";
    styleEl.textContent = `
      .rmap-popup .leaflet-popup-content-wrapper{
        border-radius:14px;padding:0;box-shadow:0 10px 30px rgba(15,23,42,.18);
        border:1px solid rgba(226,232,240,.9);overflow:hidden;
      }
      .rmap-popup .leaflet-popup-content{margin:0;width:auto!important;min-width:180px}
      .rmap-popup .leaflet-popup-tip{box-shadow:0 4px 10px rgba(15,23,42,.1)}
      .rmap-popup-card{font-family:inherit}
      .rmap-popup-head{
        padding:10px 14px 8px;background:linear-gradient(135deg,#EFF6FF,#F8FAFC);
        border-bottom:1px solid #E2E8F0;display:flex;align-items:center;gap:6px;
      }
      .rmap-popup-head svg{flex-shrink:0}
      .rmap-popup-name{font-size:12.5px;font-weight:700;color:#0F172A;line-height:1.3}
      .rmap-popup-vendor{font-size:10px;font-weight:700;color:#7C3AED;background:#F5F3FF;
        border:1px solid #DDD6FE;border-radius:999px;padding:1px 7px;margin-left:auto;flex-shrink:0;
        max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .rmap-popup-body{padding:8px 10px;display:flex;flex-direction:column;gap:6px}
      .rmap-bl-chip{
        display:flex;align-items:center;justify-content:space-between;gap:8px;
        background:#F0F9FF;border:1px solid #BAE6FD;border-radius:10px;
        padding:7px 10px;text-decoration:none;transition:all .15s ease;cursor:pointer;
      }
      .rmap-bl-chip:hover{background:#E0F2FE;border-color:#7DD3FC;transform:translateY(-1px)}
      .rmap-bl-chip-left{display:flex;align-items:center;gap:6px}
      .rmap-bl-price{font-size:12.5px;font-weight:800;color:#0369A1}
      .rmap-bl-arrow{color:#38BDF8;font-size:12px}
      .rmap-status-chip{
        display:inline-flex;align-items:center;gap:5px;border-radius:999px;
        padding:4px 10px;font-size:11px;font-weight:700;width:fit-content;
      }
      .rmap-status-chip--pay{background:#DCFCE7;color:#15803D;border:1px solid #86EFAC}
      .rmap-status-chip--muted{background:#F1F5F9;color:#64748B;border:1px solid #E2E8F0}

      /* ── ألوان الحالات (livré/reporté/pret/retour/vente) — مطابقة لألوان الدبابيس ── */
      .rmap-status-chip--livre, .rmap-bl-chip--livre .rmap-bl-price{color:#15803D}
      .rmap-status-chip--livre{background:#DCFCE7;border:1px solid #86EFAC}
      .rmap-bl-chip--livre{background:#F0FDF4;border-color:#86EFAC}
      .rmap-bl-chip--livre:hover{background:#DCFCE7;border-color:#4ADE80}
      .rmap-bl-chip--livre .rmap-bl-arrow{color:#22C55E}

      .rmap-status-chip--reporte, .rmap-bl-chip--reporte .rmap-bl-price{color:#C2410C}
      .rmap-status-chip--reporte{background:#FFEDD5;border:1px solid #FDBA74}
      .rmap-bl-chip--reporte{background:#FFF7ED;border-color:#FED7AA}
      .rmap-bl-chip--reporte:hover{background:#FFEDD5;border-color:#FDBA74}
      .rmap-bl-chip--reporte .rmap-bl-arrow{color:#FB923C}

      .rmap-status-chip--pret, .rmap-bl-chip--pret .rmap-bl-price{color:#1D63C9}
      .rmap-status-chip--pret{background:#EAF3FF;border:1px solid #B9DBFF}
      .rmap-bl-chip--pret{background:#F2F8FF;border-color:#B9DBFF}
      .rmap-bl-chip--pret:hover{background:#DBEAFE;border-color:#5AA6FF}
      .rmap-bl-chip--pret .rmap-bl-arrow{color:#5AA6FF}

      .rmap-status-chip--retour, .rmap-bl-chip--retour .rmap-bl-price{color:#A21CAF}
      .rmap-status-chip--retour{background:#FAE8FF;border:1px solid #F0ABFC}
      .rmap-bl-chip--retour{background:#FDF4FF;border-color:#F0ABFC}
      .rmap-bl-chip--retour:hover{background:#FAE8FF;border-color:#E879F9}
      .rmap-bl-chip--retour .rmap-bl-arrow{color:#D946EF}

      .rmap-status-chip--vente, .rmap-bl-chip--vente .rmap-bl-price{color:#57534E}
      .rmap-status-chip--vente{background:#F5F5F4;border:1px solid #D6D3D1}
      .rmap-bl-chip--vente{background:#FAFAF9;border-color:#D6D3D1}
      .rmap-bl-chip--vente:hover{background:#F5F5F4;border-color:#A8A29E}
      .rmap-bl-chip--vente .rmap-bl-arrow{color:#A8A29E}

      /* ── دبوس الخريطة: تصميم عصري + انتقال لوني سلس بين الحالات ── */
      @property --pinclr{ syntax:'<color>'; inherits:true; initial-value:#ffffff; }
      .rmap-pin-wrap{ display:block; }
      .rmap-pin-wrap svg{ filter: drop-shadow(0 3px 5px rgba(15,23,42,.3)); }
      .rmap-pin-body{ transition: fill .25s ease; }
    `;
    document.head.appendChild(styleEl);
  }

  // ── تصميم عصري لشريط الفلاتر السفلي ─────────────────────────
  if (!document.getElementById("rmapFilterBarStyle")) {
    const fbStyle = document.createElement("style");
    fbStyle.id = "rmapFilterBarStyle";
    fbStyle.textContent = `
      .rmap-filters-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:6px}
      .rmap-filters-row:last-child{margin-bottom:0}
      .rmap-filters-label{font-size:10px;font-weight:800;color:var(--text3,#94A3B8);
        text-transform:uppercase;letter-spacing:.04em;flex-shrink:0;margin-right:2px}
      .rmap-filter-chip{
        display:inline-flex;align-items:center;gap:5px;border-radius:999px;border:1.5px solid transparent;
        padding:4px 9px 4px 6px;font-size:11px;font-weight:700;cursor:pointer;background:var(--bg3,#F1F5F9);
        color:var(--text2,#475569);transition:all .15s ease;max-width:150px;font-family:inherit;
      }
      .rmap-filter-chip:hover{transform:translateY(-1px);box-shadow:0 2px 6px rgba(15,23,42,.1)}
      .rmap-filter-chip span.rmap-filter-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .rmap-filter-count{font-size:9.5px;font-weight:800;opacity:.65}
      .rmap-filter-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;background:var(--chipclr,#94A3B8)}
      .rmap-filter-badge{width:16px;height:16px;border-radius:50%;flex-shrink:0;display:flex;
        align-items:center;justify-content:center;font-size:9.5px;font-weight:800;color:#fff;
        background:var(--chipclr,#94A3B8)}
      .rmap-filter-chip--active{border-color:var(--chipclr,#3B82F6);background:color-mix(in srgb, var(--chipclr,#3B82F6) 14%, #fff);color:#0F172A}
      .rmap-filters-clear{margin-left:auto;font-size:10.5px;font-weight:700;color:var(--accent,#3B82F6);
        background:none;border:none;cursor:pointer;padding:4px 4px;flex-shrink:0}
      .rmap-filters-clear:hover{text-decoration:underline}
      #roundMapBox.rmap-expanded{max-width:96vw!important;width:96vw!important;height:92vh!important;max-height:92vh!important}
    `;
    document.head.appendChild(fbStyle);
  }

  const STATE_LABELS = {
    sold: "Vente", success: "Visité", visited: "Visité", fail: "Échec",
    absent: "Absent", pending: "En attente", canceled: "Annulé", delayed: "Reporté",
  };

  const CLUSTER_LETTERS = { gms: "G", detail: "D", gros: "R", horeca: "H" };
  const CLUSTER_NAMES  = { gms: "GMS", detail: "Détail", gros: "Gros", horeca: "Horeca" };
  const CLUSTER_COLORS = { gms: "#2563EB", detail: "#DC2626", gros: "#059669", horeca: "#CA8A04" };
  const VENDEUR_PALETTE = ["#0EA5E9","#F97316","#8B5CF6","#10B981","#EC4899","#F59E0B","#6366F1","#14B8A6"];
  const _vendeurColor = id => VENDEUR_PALETTE[Math.abs(Number(id) || 0) % VENDEUR_PALETTE.length];

  const PREV_STATUS_COLORS = {
    vente:      "#16A34A", nonvente:   "#EA580C", avisiter:   "#94A3B8",
    nonvisiter: "#DC2626", enc:        "#0D9488",
  };
  const PREV_STATUS_ORDER = ["avisiter", "nonvisiter", "vente", "nonvente", "enc"];

  const BL_STATUS_COLORS = _isPrevendeur ? PREV_STATUS_COLORS : {
    livre:   "#16A34A", reporte: "#EA580C", pret:    "#5AA6FF",
    retour:  "#C026D3", vente:   "#78716C",
    ...(_isRecouvrement ? { enc: "#0D9488" } : {}),
  };
  const BL_STATUS_ORDER = _isPrevendeur
    ? PREV_STATUS_ORDER
    : ["livre", "reporte", "pret", "retour", "vente", ...(_isRecouvrement ? ["enc"] : [])];
  const BL_STATUS_FR_LABELS = _isPrevendeur
    ? { avisiter: "À visiter", nonvisiter: "Non visité", vente: "Vente", nonvente: "Non vente", enc: "Encaissé" }
    : { livre: "Livré", reporte: "Reporté", pret: "Prêt", retour: "Retour", vente: "Vente", ...(_isRecouvrement ? { enc: "Encaissé" } : {}) };

  const _injectedBlinkClasses = new Set();
  function _ensureBlinkClass(statuses) {
    const className = `rmap-blink-${statuses.join("_")}`;
    if (_injectedBlinkClasses.has(className)) return className;
    _injectedBlinkClasses.add(className);
    let styleEl = document.getElementById("rmapBlinkStyle");
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "rmapBlinkStyle";
      document.head.appendChild(styleEl);
    }
    const n = statuses.length;
    const step = 100 / n;
    const stops = [];
    statuses.forEach((s, i) => {
      const holdStart = i * step;
      const holdEnd   = holdStart + step * 0.65;
      const next       = statuses[(i + 1) % n];
      stops.push(`${holdStart.toFixed(2)}% { --pinclr: ${BL_STATUS_COLORS[s]}; }`);
      stops.push(`${holdEnd.toFixed(2)}% { --pinclr: ${BL_STATUS_COLORS[s]}; }`);
      stops.push(`${((i + 1) * step).toFixed(2)}% { --pinclr: ${BL_STATUS_COLORS[next]}; }`);
    });
    const dur = (n * 2.4).toFixed(1);
    styleEl.textContent += `
      @keyframes ${className}-kf {
        ${stops.join("\n        ")}
      }
      .${className} { animation: ${className}-kf ${dur}s ease-in-out infinite; }
    `;
    return className;
  }

  const _pinIconCache = new Map();
  function _clusterPinIcon(category, statuses) {
    const letter = CLUSTER_LETTERS[category] || "";
    const st = statuses || [];
    const cacheKey = `${category}|${st.join(",")}`;
    if (_pinIconCache.has(cacheKey)) return _pinIconCache.get(cacheKey);

    let wrapClass = "rmap-pin-wrap";
    let wrapStyle = "";
    if (st.length === 1) {
      wrapStyle = ` style="--pinclr:${BL_STATUS_COLORS[st[0]]}"`;
    } else if (st.length > 1) {
      wrapClass += " " + _ensureBlinkClass(st);
    }

    const noStatus = st.length === 0;
    const defaultClr = "#94A3B8";
    // لون النصف الفاتح (يسار الدبوس): مبني من نفس متغيّر --pinclr عبر color-mix — يتبع
    // اللون تلقائيًا حتى أثناء أنيميشن الوميض (تصميم دبوس Dispatch Planning: نصفان + دائرة بيضاء + ظل)
    const bodyClr  = noStatus ? defaultClr : "var(--pinclr,#94A3B8)";
    const lightClr = noStatus ? `color-mix(in srgb, ${defaultClr} 76%, #fff)` : "color-mix(in srgb, var(--pinclr,#94A3B8) 76%, #fff)";

    const icon = L.divIcon({
      className: "rmap-cluster-pin",
      html: `<div class="${wrapClass}"${wrapStyle}>
        <svg viewBox="0 0 48 56" width="36" height="42" style="display:block;overflow:visible">
          <ellipse cx="24" cy="52" rx="9" ry="2.6" fill="#000" opacity="0.15"/>
          <path class="rmap-pin-body" d="M24 2C13 2 5 10.5 5 20.5 5 34 24 50 24 50s19-16 19-29.5C43 10.5 35 2 24 2z"
            fill="${bodyClr}" stroke="#fff" stroke-width="2"/>
          <path d="M24 2C13 2 5 10.5 5 20.5 5 34 24 50 24 50V2z" fill="${lightClr}"/>
          <circle cx="24" cy="20" r="12" fill="#fff"/>
          <text x="24" y="20" text-anchor="middle" dominant-baseline="central"
            font-size="14" font-weight="800" font-family="inherit" fill="#0F172A">${letter}</text>
        </svg>
      </div>`,
      iconSize: [36, 42],
      iconAnchor: [18, 42],
      popupAnchor: [0, -38],
    });
    _pinIconCache.set(cacheKey, icon);
    return icon;
  }

  // ══════════════════════════════════════════════════════════════
  // ── جلب بيانات كل تورنية محددة (BLs/زبائن/مدفوعات/إحداثيات...)
  // وبناء نقاطها ودبابيسها فوق خريطة واحدة مشتركة ──
  // ══════════════════════════════════════════════════════════════
  let map = null;
  const points = [];         // نقاط كل التورنيات المجمّعة
  const markers = [];        // كل الدبابيس المجمّعة
  const markerEntries = [];  // { marker, statuses, cluster, vendeurId, vendeurName, name, vendorId, vendorLabel } — لشريط الفلاتر

  for (const vid of validIds) {
    const roundId = App.allStats[vid]?.roundId;
    if (!roundId) continue;
    const vendorRow = _vendorOf(vid);
    const vendorLbl = vendorRow?.label || String(vid);
    const isPrevendeurV = vendorRow?.role === "prevente";
    const isRecouvrementV = vendorRow?.role === "recouvrement";

    let bls = [], allClients = [], payments = [];
    try {
      [bls, allClients, payments] = await Promise.all([
        isPrevendeurV ? Promise.resolve([]) : rpcController.fetchBLs(baseUrl, roundId, App.currentMode),
        rpcController.fetchClients(baseUrl, roundId, App.currentMode).catch(() => []),
        rpcController.fetchPayments(baseUrl, roundId).catch(() => []),
      ]);
    } catch (e) {
      addNotif(`Erreur (${vendorLbl}): ${e.message}`, "error");
      continue; // نتخطى هذه التورنية عند الخطأ ونكمل الباقي
    }

    const byPartner = new Map();
    bls.forEach(bl => {
      const pid = Array.isArray(bl.partner_id) ? bl.partner_id[0] : bl.partner_id;
      if (!pid) return;
      if (!byPartner.has(pid)) byPartner.set(pid, { name: Array.isArray(bl.partner_id) ? bl.partner_id[1] : "—", bls: [] });
      byPartner.get(pid).bls.push(bl);
    });

    const paysByPartner = new Map();
    (payments || []).forEach(p => {
      const pid = Array.isArray(p.partner_id) ? p.partner_id[0] : p.partner_id;
      if (!pid) return;
      if (!paysByPartner.has(pid)) paysByPartner.set(pid, []);
      paysByPartner.get(pid).push(p);
    });

    const clientsById = new Map();
    (allClients || []).forEach(c => { if (c.id) clientsById.set(c.id, c); });

    const allPartnerIds = new Set([...byPartner.keys(), ...clientsById.keys()]);

    let coords = [];
    let clusterByPartner = {};
    try {
      const [coordsRes, clusterRes] = await Promise.all([
        rpcController.fetchPartnersCoords(baseUrl, [...allPartnerIds]),
        rpcController.fetchPartnersCluster(baseUrl, [...allPartnerIds]).catch(() => ({})),
      ]);
      coords = coordsRes;
      clusterByPartner = clusterRes || {};
    } catch (e) {
      addNotif(`Erreur (${vendorLbl}): ${e.message}`, "error");
      continue;
    }

    const vendorPoints = [];
    coords.forEach(c => {
      const lat = c.partner_latitude, lng = c.partner_longitude;
      if (!lat || !lng) return;
      const blInfo   = byPartner.get(c.id);
      const cliInfo  = clientsById.get(c.id);
      const pays     = paysByPartner.get(c.id) || [];
      const name     = c.name || blInfo?.name || cliInfo?.name || "—";
      vendorPoints.push({
        id: c.id, name, lat, lng,
        bls:   blInfo?.bls || [],
        state: cliInfo?.state || null,
        orderIds: cliInfo?.orderIds || [],
        pays,
        clusterCategory: clusterByPartner[c.id] || null,
        vendorId: vid,
        vendorLabel: vendorLbl,
      });
    });
    if (!vendorPoints.length) continue;

    if (!map) {
      map = L.map("roundMapEl", { zoomControl: true });
      mapRef = map;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors',
      }).addTo(map);
    }

    // فهرسة مبيعات/تأجيلات/إرجاعات هذه التورنية فقط
    const soldSales = App._soldOrders?.[vid]?.sales || [];
    const soldByOrderId = new Map();
    soldSales.forEach(s => { if (s.orderId != null) soldByOrderId.set(s.orderId, s); });

    const delayedPicks = App._delayedOrders?.[vid]?.picks || [];
    const delayedByPartner = new Map();
    delayedPicks.forEach(d => { if (d.partnerId != null) delayedByPartner.set(d.partnerId, d); });

    const returnPicks = App._returnOrders?.[vid]?.returns || [];
    const returnsByPartner = new Map();
    returnPicks.forEach(r => {
      const pid = r.partnerId != null ? r.partnerId : (Array.isArray(r.partner_id) ? r.partner_id[0] : null);
      if (pid != null) returnsByPartner.set(pid, r);
    });

    const _vendeurPickIds  = [...bls.map(b => b.id), ...delayedPicks.map(d => d.id), ...returnPicks.map(r => r.id)].filter(Boolean);
    const _vendeurOrderIds = soldSales.map(s => s.orderId).filter(Boolean);
    let vendeurByPicking = {}, vendeurByOrder = {};
    try {
      [vendeurByPicking, vendeurByOrder] = await Promise.all([
        rpcController.fetchPickingsVendeur(baseUrl, _vendeurPickIds).catch(() => ({})),
        rpcController.fetchOrdersVendeur(baseUrl, _vendeurOrderIds).catch(() => ({})),
      ]);
    } catch (_) {}

    vendorPoints.forEach(p => {
      const retourInfo = returnsByPartner.get(p.id);
      const _blStatusSet = new Set();
      if (isPrevendeurV) {
        if (p.state === "sold") { _blStatusSet.add("vente"); }
        else if (p.state === "success" || p.state === "visited" || p.state === "fail") { _blStatusSet.add("nonvente"); }
        else if (p.state === "absent") { _blStatusSet.add("nonvisiter"); }
        else { _blStatusSet.add("avisiter"); }
        if (p.pays.length) _blStatusSet.add("enc");
      } else {
        (p.bls || []).forEach(bl => {
          if (bl.state === "done") _blStatusSet.add("livre");
          else if (bl.state === "assigned") _blStatusSet.add("pret");
          else if (bl.planning_state === "delayed") _blStatusSet.add("reporte");
        });
        if (retourInfo) _blStatusSet.add("retour");
        if (p.state === "sold") _blStatusSet.add("vente");
        if (isRecouvrementV && p.pays.length) _blStatusSet.add("enc");
      }
      const pinStatuses = BL_STATUS_ORDER.filter(s => _blStatusSet.has(s));

      let _deliveryCat = null;
      if (!isPrevendeurV) {
        if (p.state === "canceled") _deliveryCat = "canceled";
        else if (_blStatusSet.has("livre")) _deliveryCat = "livre";
        else if (_blStatusSet.has("reporte")) _deliveryCat = "reporte";
        else if (_blStatusSet.has("pret")) _deliveryCat = "pret";
        else if (_blStatusSet.has("vente")) _deliveryCat = "vente";
      }
      p.deliveryCat = _deliveryCat;

      let _vInfo = null;
      for (const bl of (p.bls || [])) { if (vendeurByPicking[bl.id]) { _vInfo = vendeurByPicking[bl.id]; break; } }
      if (!_vInfo && p.state === "sold") {
        for (const oid of (p.orderIds || [])) { if (vendeurByOrder[oid]) { _vInfo = vendeurByOrder[oid]; break; } }
      }
      if (!_vInfo && p.state === "delayed") {
        const dInfo = delayedByPartner.get(p.id);
        if (dInfo && vendeurByPicking[dInfo.id]) _vInfo = vendeurByPicking[dInfo.id];
      }
      if (!_vInfo && retourInfo && vendeurByPicking[retourInfo.id]) _vInfo = vendeurByPicking[retourInfo.id];
      p.vendeurId   = _vInfo?.id || null;
      p.vendeurName = _vInfo?.name || null;

      p.visitCat = p.state === "sold" ? "vente"
        : (p.state === "success" || p.state === "visited" || p.state === "fail") ? "nonvente"
        : (p.state === "absent") ? "nonvisiter"
        : "avisiter";
      let _pointCA = (p.bls || []).reduce((s, bl) => s + (Number(bl.amount_total) || 0), 0);
      if (p.state === "sold") {
        _pointCA += (p.orderIds || []).reduce((s, oid) => {
          const so = soldByOrderId.get(oid);
          return s + (so ? (Number(so.amount) || 0) : 0);
        }, 0);
      }
      p.ca = _pointCA;
      p.encAmount = (p.pays || []).reduce((s, pay) => s + (pay.payment_type === "outbound" ? -(Number(pay.amount) || 0) : (Number(pay.amount) || 0)), 0);
      p.hasEnc = p.pays.length > 0;

      const m = L.marker([p.lat, p.lng], { icon: _clusterPinIcon(p.clusterCategory, pinStatuses) }).addTo(map);
      m._rmPoint = p;
      const nameIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="#3B82F6" stroke-width="2" width="13" height="13">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
      const vendorBadge = validIds.length > 1
        ? `<span class="rmap-popup-vendor" title="${escHtml(p.vendorLabel)}">${escHtml(p.vendorLabel)}</span>` : "";
      const header = `<div class="rmap-popup-head">${nameIcon}<span class="rmap-popup-name">${escHtml(p.name)}${_clientLinkIconHtml(p.id, null)}</span>${vendorBadge}</div>`;

      const links = p.bls.length ? p.bls.map(bl => {
        const price = Number(bl.amount_total || 0).toFixed(2);
        const stCls = bl.state === "done" ? " rmap-bl-chip--livre"
          : bl.state === "assigned" ? " rmap-bl-chip--pret"
          : bl.planning_state === "delayed" ? " rmap-bl-chip--reporte"
          : "";
        return `<a href="#" data-bl-id="${bl.id}" class="route-map-bl-link rmap-bl-chip${stCls}">
          <span class="rmap-bl-chip-left">
            <svg viewBox="0 0 24 24" fill="none" stroke="#0EA5E9" stroke-width="2" width="13" height="13">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
            </svg>
            <span class="rmap-bl-price">${price} DA</span>
          </span>
          <span class="rmap-bl-arrow">›</span>
        </a>`;
      }).join("") : "";

      const extras = [];
      if (p.pays.length) {
        const total = p.pays.reduce((s, pay) => s + (pay.payment_type === "outbound" ? -(Number(pay.amount) || 0) : (Number(pay.amount) || 0)), 0);
        extras.push(`<span class="rmap-status-chip rmap-status-chip--pay">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="11" height="11">
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
          </svg>${total.toFixed(2)} DA</span>`);
      }

      const venteLinks = p.state === "sold"
        ? p.orderIds.map(oid => soldByOrderId.get(oid)).filter(Boolean).map(s => {
            const price = Number(s.amount || 0).toFixed(2);
            if (s.id) {
              return `<a href="#" data-vente-pick-id="${s.id}" data-vente-name="${escHtml(s.name || s.orderRef || "")}" class="route-map-vente-link rmap-bl-chip rmap-bl-chip--vente">
                <span class="rmap-bl-chip-left">
                  <svg viewBox="0 0 24 24" fill="none" stroke="#1D4ED8" stroke-width="2" width="13" height="13">
                    <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>
                  </svg>
                  <span class="rmap-bl-price">${price} DA</span>
                </span>
                <span class="rmap-bl-arrow">›</span>
              </a>`;
            }
            return `<span class="rmap-status-chip rmap-status-chip--vente">Vente · ${price} DA</span>`;
          }).join("")
        : "";

      const delayInfo = p.state === "delayed" ? delayedByPartner.get(p.id) : null;
      const delayLink = delayInfo
        ? (delayInfo.id ? `<a href="#" data-delay-pick-id="${delayInfo.id}" data-delay-name="${escHtml(delayInfo.name || "")}" class="route-map-delay-link rmap-bl-chip rmap-bl-chip--reporte">
            <span class="rmap-bl-chip-left">
              <svg viewBox="0 0 24 24" fill="none" stroke="#D97706" stroke-width="2" width="13" height="13">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              <span class="rmap-bl-price">${Number(delayInfo.amount || 0).toFixed(2)} DA</span>
            </span>
            <span class="rmap-bl-arrow">›</span>
          </a>`
          : `<span class="rmap-status-chip rmap-status-chip--reporte">Reporté · ${Number(delayInfo.amount || 0).toFixed(2)} DA</span>`)
        : "";

      const retourLink = retourInfo
        ? (retourInfo.id ? `<a href="#" data-retour-pick-id="${retourInfo.id}" data-retour-name="${escHtml(retourInfo.name || "")}" class="route-map-retour-link rmap-bl-chip rmap-bl-chip--retour">
            <span class="rmap-bl-chip-left">
              <svg viewBox="0 0 24 24" fill="none" stroke="#C2410C" stroke-width="2" width="13" height="13">
                <path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H9"/>
              </svg>
              <span class="rmap-bl-price">${Number(retourInfo.amount || 0).toFixed(2)} DA</span>
            </span>
            <span class="rmap-bl-arrow">›</span>
          </a>`
          : `<span class="rmap-status-chip rmap-status-chip--retour">Retour · ${Number(retourInfo.amount || 0).toFixed(2)} DA</span>`)
        : "";

      if (p.state === "sold" && !venteLinks) {
        extras.push(`<span class="rmap-status-chip rmap-status-chip--vente">Vente</span>`);
      } else if (p.state === "delayed" && !delayLink) {
        extras.push(`<span class="rmap-status-chip rmap-status-chip--reporte">Reporté</span>`);
      } else if (p.state && p.state !== "sold" && p.state !== "delayed") {
        const lbl = STATE_LABELS[p.state] || p.state;
        extras.push(`<span class="rmap-status-chip rmap-status-chip--muted">${escHtml(lbl)}</span>`);
      }
      const extrasHtml = extras.length ? `<div class="rmap-popup-extras">${extras.join("")}</div>` : "";

      const body = (links || venteLinks || delayLink || retourLink || extrasHtml)
        ? `${links}${venteLinks}${delayLink}${retourLink}${extrasHtml}`
        : `<span class="rmap-status-chip rmap-status-chip--muted">—</span>`;

      m.bindPopup(`<div class="rmap-popup-card">${header}<div class="rmap-popup-body">${body}</div></div>`, { className: "rmap-popup" });
      if (p.bls.length || venteLinks || delayLink || retourLink) {
        m.on("popupopen", () => {
          document.querySelectorAll(`.route-map-bl-link`).forEach(a => {
            a.onclick = (e) => {
              e.preventDefault();
              const blId = parseInt(a.dataset.blId, 10);
              const bl = p.bls.find(b => b.id === blId);
              if (!bl) return;
              _showOrderRowDetailsPopup({ id: bl.id, name: bl.name, partner: p.name }, baseUrl, _svgBLList);
            };
          });
          document.querySelectorAll(`.route-map-vente-link`).forEach(a => {
            a.onclick = (e) => {
              e.preventDefault();
              const pickId = parseInt(a.dataset.ventePickId, 10);
              if (!pickId) return;
              _showOrderRowDetailsPopup({ id: pickId, name: a.dataset.venteName || "", partner: p.name }, baseUrl, _svgVentes);
            };
          });
          document.querySelectorAll(`.route-map-delay-link`).forEach(a => {
            a.onclick = (e) => {
              e.preventDefault();
              const pickId = parseInt(a.dataset.delayPickId, 10);
              if (!pickId) return;
              _showOrderRowDetailsPopup({ id: pickId, name: a.dataset.delayName || "", partner: p.name }, baseUrl, _svgReports);
            };
          });
          document.querySelectorAll(`.route-map-retour-link`).forEach(a => {
            a.onclick = (e) => {
              e.preventDefault();
              const pickId = parseInt(a.dataset.retourPickId, 10);
              if (!pickId) return;
              _showOrderRowDetailsPopup({ id: pickId, name: a.dataset.retourName || "", partner: p.name }, baseUrl, _svgRetours);
            };
          });
        });
      }
      markerEntries.push({ marker: m, statuses: pinStatuses, cluster: p.clusterCategory, vendeurId: p.vendeurId, vendeurName: p.vendeurName, name: p.name || "", vendorId: p.vendorId, vendorLabel: p.vendorLabel });

      m.off("click");
      m.on("click", (e) => {
        if (e.originalEvent?.shiftKey) {
          L.DomEvent.stopPropagation(e);
          if (_rmapSelected.has(p.id)) _rmapSelected.delete(p.id);
          else _rmapSelected.add(p.id);
          _rmapUpdateSelectionPanel();
        } else {
          m.openPopup();
        }
      });
      markers.push(m);
    });

    points.push(...vendorPoints);
  }

  document.getElementById("roundMapLoading")?.remove();

  const countEl = document.getElementById("roundMapCount");
  if (countEl) { countEl.style.display = "inline-block"; countEl.textContent = `${points.length} localisé(s)`; }

  if (!points.length || !map) {
    if (!map) map = null;
    document.getElementById("roundMapEl").innerHTML =
      `<div style="display:flex;align-items:center;justify-content:center;height:100%;
        color:var(--text3,#94A3B8);font-size:12px;text-align:center;padding:20px">
        Aucun client localisé pour cette sélection</div>`;
    return;
  }

  const group = L.featureGroup(markers);
  groupRef = group;
  map.fitBounds(group.getBounds().pad(0.15));

  // ══════════════════════════════════════════════════════════════
  // ── تحديد متعدد بالسحب (Shift + drag) على "Carte de la tournée" ──
  // نفس آلية "Carte de la route" (rrmap): يرسم مستطيل فوق الخريطة، يضيف كل
  // الزبائن ضمنه للتحديد، ويعرض نافذة عائمة (roundMapSelectPanel) بملخص حي:
  // عدد الزبائن + تفصيل Vente/Non vente/À visiter/Non visité + CA الكلي +
  // مسافة القيادة الحقيقية بين الزبائن المحددين (OSRM، بنفس منطق carte de
  // la route). النافذة تبقى مفتوحة أثناء العمل — يمكن متابعة السحب لإضافة
  // المزيد من الزبائن دون إغلاقها، وتتحدث كل الأرقام تلقائيًا.
  // ══════════════════════════════════════════════════════════════
  const _rmapSelected = new Set(); // partner ids
  let _rmapRouteLine = null;
  let _rmapDistanceToken = 0;

  // تنسيق مالي (فاصل الآلاف) لعرض CA في نافذة ملخص التحديد المتعدد
  function _rmapFmtMoney(n) {
    return (Number(n) || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  const _rmapCatLabels = _isPrevendeur
    ? { vente: "Vente", nonvente: "Non vente", avisiter: "À visiter", nonvisiter: "Non visité" }
    : { livre: "Livré", pret: "À livrer", reporte: "Reporté", vente: "Vente", canceled: "Annulé" };
  const _rmapCatColors = _isPrevendeur
    ? { vente: "#16A34A", nonvente: "#EA580C", avisiter: "#94A3B8", nonvisiter: "#DC2626" }
    : { livre: "#16A34A", pret: "#5AA6FF", reporte: "#EA580C", vente: "#78716C", canceled: "#6B7280" };

  function _rmapClearRouteLine() {
    if (_rmapRouteLine && mapRef) { try { mapRef.removeLayer(_rmapRouteLine); } catch (_) {} }
    _rmapRouteLine = null;
  }
  function _rmapDrawRouteLine(coordinates) {
    _rmapClearRouteLine();
    if (!mapRef || !coordinates?.length) return;
    _rmapRouteLine = L.polyline(coordinates, { color: "#3B82F6", weight: 3, opacity: .75, dashArray: "6 6" }).addTo(mapRef);
  }

  async function _rmapUpdateSelectionPanel() {
    const panel      = document.getElementById("roundMapSelectPanel");
    const countEl2   = document.getElementById("roundMapSelectCount");
    const statsEl    = document.getElementById("roundMapSelectStats");
    const distEl     = document.getElementById("roundMapSelectDistance");
    if (!panel) return;

    if (!_rmapSelected.size) {
      panel.style.display = "none";
      _rmapClearRouteLine();
      return;
    }

    const selPoints = points.filter(p => _rmapSelected.has(p.id));
    panel.style.display = "block";
    countEl2.textContent = `${selPoints.length} client(s) sélectionné(s)`;

    const catCounts = {};
    Object.keys(_rmapCatLabels).forEach(k => { catCounts[k] = 0; });
    let caTotal = 0, encCount = 0, encTotal = 0;
    selPoints.forEach(p => {
      const cat = _isPrevendeur ? p.visitCat : p.deliveryCat;
      if (cat != null && catCounts[cat] != null) catCounts[cat]++;
      caTotal += Number(p.ca) || 0;
      if (p.hasEnc) { encCount++; encTotal += Number(p.encAmount) || 0; }
    });
    statsEl.innerHTML = Object.keys(_rmapCatLabels).map(k => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span style="display:flex;align-items:center;gap:5px">
          <span style="width:8px;height:8px;border-radius:50%;background:${_rmapCatColors[k]};flex-shrink:0"></span>
          ${_rmapCatLabels[k]}
        </span>
        <span style="font-weight:700">${catCounts[k]}</span>
      </div>`).join("") + `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span style="display:flex;align-items:center;gap:5px">
          <span style="width:8px;height:8px;border-radius:50%;background:#0D9488;flex-shrink:0"></span>
          Encaissé (ENC)
        </span>
        <span style="font-weight:700">${encCount}</span>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;
        padding-top:4px;border-top:1px solid rgba(255,255,255,.12)">
        <span>Montant encaissé</span><span style="font-weight:800;color:#2DD4BF">${_rmapFmtMoney(encTotal)} DA</span>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;
        padding-top:4px;border-top:1px solid rgba(255,255,255,.12)">
        <span>CA total</span><span style="font-weight:800;color:#4ADE80">${_rmapFmtMoney(caTotal)} DA</span>
      </div>`;

    const myToken = ++_rmapDistanceToken;
    const geoPoints = selPoints.filter(p => p.lat && p.lng).map(p => ({ lat: p.lat, lng: p.lng, eventId: p.id }));
    if (geoPoints.length < 2) {
      distEl.style.display = "none";
      distEl.textContent = "";
      _rmapClearRouteLine();
      return;
    }
    distEl.style.display = "block";
    distEl.style.color = "#93C5FD";
    distEl.textContent = "⏳ Calcul distance…";
    try {
      const result = await _rrmapFetchDrivingRoute(geoPoints);
      if (myToken !== _rmapDistanceToken) return; // التحديد تغيّر أثناء الحساب
      distEl.style.color = "#93C5FD";
      distEl.textContent = `🚗 ${_rrmapFormatDistanceKm(result.distanceKm)} (~${_rrmapFormatDurationMin(result.durationMin)})`;
      _rmapDrawRouteLine(result.coordinates);
    } catch (err) {
      if (myToken !== _rmapDistanceToken) return;
      distEl.style.color = "#F87171";
      distEl.textContent = err.message || "Distance indisponible";
      _rmapClearRouteLine();
    }
  }

  document.getElementById("roundMapSelectClear")?.addEventListener("click", () => {
    _rmapSelected.clear();
    _rmapUpdateSelectionPanel();
  });

  const roundMapBodyEl  = document.getElementById("roundMapBody");
  const rmapRectEl      = document.getElementById("roundMapSelectRect");
  let _rmapDragStart = null; // {x,y} نسبة لحاوية roundMapBody

  const _rmapOnMouseDown = (e) => {
    if (!e.shiftKey || e.button !== 0 || !mapRef) return;
    e.preventDefault();
    e.stopPropagation();
    mapRef.dragging.disable();
    const boxRect = roundMapBodyEl.getBoundingClientRect();
    _rmapDragStart = { x: e.clientX - boxRect.left, y: e.clientY - boxRect.top };
    rmapRectEl.style.display = "block";
    rmapRectEl.style.left = _rmapDragStart.x + "px";
    rmapRectEl.style.top  = _rmapDragStart.y + "px";
    rmapRectEl.style.width  = "0px";
    rmapRectEl.style.height = "0px";
  };
  const _rmapOnMouseMove = (e) => {
    if (!_rmapDragStart) return;
    const boxRect = roundMapBodyEl.getBoundingClientRect();
    const curX = e.clientX - boxRect.left, curY = e.clientY - boxRect.top;
    const left = Math.min(_rmapDragStart.x, curX), top = Math.min(_rmapDragStart.y, curY);
    const w = Math.abs(curX - _rmapDragStart.x), h = Math.abs(curY - _rmapDragStart.y);
    rmapRectEl.style.left = left + "px";
    rmapRectEl.style.top  = top + "px";
    rmapRectEl.style.width  = w + "px";
    rmapRectEl.style.height = h + "px";
  };
  const _rmapOnMouseUp = (e) => {
    if (!_rmapDragStart || !mapRef) return;
    const boxRect = roundMapBodyEl.getBoundingClientRect();
    const endX = e.clientX - boxRect.left, endY = e.clientY - boxRect.top;
    const p1 = L.point(_rmapDragStart.x, _rmapDragStart.y);
    const p2 = L.point(endX, endY);
    _rmapDragStart = null;
    rmapRectEl.style.display = "none";
    mapRef.dragging.enable();

    // مستطيل صغير جدًا (نقرة عرضية) → تجاهل، لا تحديد
    if (Math.abs(p2.x - p1.x) < 4 && Math.abs(p2.y - p1.y) < 4) return;

    const bounds = L.bounds(p1, p2);
    let added = 0;
    markers.forEach(m => {
      if (!mapRef.hasLayer(m)) return; // يتجاهل الزبائن المخفيين بالفلترة/البحث الحالي
      const pt = mapRef.latLngToContainerPoint(m.getLatLng());
      if (bounds.contains(pt) && m._rmPoint) {
        _rmapSelected.add(m._rmPoint.id);
        added++;
      }
    });
    if (added) _rmapUpdateSelectionPanel();
  };
  roundMapBodyEl.addEventListener("mousedown", _rmapOnMouseDown, true);
  // يمنع فتح popup الزبون عرضيًا عند الضغط بـShift (حتى بدون سحب فعلي)
  roundMapBodyEl.addEventListener("click", (e) => {
    if (!e.shiftKey) return;
    // إن كان النقر على دبوس زبون (marker)، نترك حدث click الخاص بالـmarker (المُضاف أعلاه) يتولى
    // تبديل التحديد بنفسه؛ فقط نمنع فتح popup الخريطة الافتراضي بدون قطع الانتشار عن الـmarker.
    if (e.target.closest(".leaflet-marker-icon")) { e.preventDefault(); return; }
    e.preventDefault(); e.stopPropagation();
  }, true);
  document.addEventListener("mousemove", _rmapOnMouseMove);
  document.addEventListener("mouseup", _rmapOnMouseUp);

  // ── حقل البحث الذكي (يعمل بالتوازي مع شريط الفلاتر أدناه) ──
  // tokens: كل كلمات البحث يجب أن تكون موجودة في اسم الزبون، بغض النظر عن الترتيب
  const _noResultsEl = document.getElementById("roundMapNoResults");
  let _searchTokens = [];
  function _matchesSearch(me) {
    if (!_searchTokens.length) return true;
    const nameLc = (me.name || "").toLowerCase();
    return _searchTokens.every(t => nameLc.includes(t));
  }
  // مرجع تُستدعى من applyFilters() (المُعرّفة داخل _buildRoundMapFilterBar أدناه) عبر window._roundMapApplyAll
  // قيمة افتراضية (بحث فقط) تُستعمل إذا لم يُبنَ شريط الفلاتر (لا بيانات فلترة كافية)
  window._roundMapApplyAll = function () {
    let visible = 0;
    markerEntries.forEach(me => {
      const show = _matchesSearch(me);
      const onMap = map.hasLayer(me.marker);
      if (show && !onMap) me.marker.addTo(map);
      else if (!show && onMap) map.removeLayer(me.marker);
      if (show) visible++;
    });
    if (countEl) countEl.textContent = `${visible} localisé(s)`;
    if (_noResultsEl) _noResultsEl.style.display = visible === 0 ? "block" : "none";
  };
  const searchInputEl = document.getElementById("roundMapSearchInput");
  let _searchDebounce = null;
  searchInputEl?.addEventListener("input", () => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      _searchTokens = searchInputEl.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
      if (typeof window._roundMapApplyAll === "function") window._roundMapApplyAll();
    }, 180);
  });

  // ── شريط فلاتر خريطة الجولة: حالات الزبائن الخمس + البائع + Cluster ──
  // منطق: OR بين الفلاتر داخل نفس المجموعة، AND بين المجموعات المختلفة.
  // (دالة متداخلة عمدًا كي تبقى ضمن نطاق ثوابت هذه الدالة: BL_STATUS_*, CLUSTER_*, escHtml...)
  (function _buildRoundMapFilterBar() {
    const bar = document.getElementById("roundMapFilters");
    if (!bar || !markerEntries.length) return;

    // فهرسة القيم المتوفرة فعليًا (لا نعرض فلترًا فارغًا)
    const statusFacet  = new Map(); // status   -> count
    const clusterFacet = new Map(); // category -> count
    const vendeurFacet = new Map(); // vendeurId -> { name, count }
    const tourneeFacet = new Map(); // vendorId -> { name, count } — فلتر التورنية (فقط عند تجميع أكثر من تورنية)
    // إزالة كلمة "VENDEUR" المكرّرة من اسم البائع (تظهر في كل الأسماء فتضيع مساحة الفقاعة بلا فائدة)
    const _cleanVendeurName = raw => {
      const cleaned = String(raw || "")
        .replace(/vendeur/gi, "")
        .replace(/^[\s\-–:.,]+|[\s\-–:.,]+$/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      return cleaned || String(raw || "—").trim() || "—";
    };
    markerEntries.forEach(me => {
      (me.statuses || []).forEach(s => statusFacet.set(s, (statusFacet.get(s) || 0) + 1));
      if (me.cluster) clusterFacet.set(me.cluster, (clusterFacet.get(me.cluster) || 0) + 1);
      if (me.vendeurId) {
        const cur = vendeurFacet.get(me.vendeurId) || { name: _cleanVendeurName(me.vendeurName), count: 0 };
        cur.count++;
        vendeurFacet.set(me.vendeurId, cur);
      }
      if (validIds.length > 1 && me.vendorId != null) {
        const cur = tourneeFacet.get(me.vendorId) || { name: me.vendorLabel || String(me.vendorId), count: 0 };
        cur.count++;
        tourneeFacet.set(me.vendorId, cur);
      }
    });
    if (!statusFacet.size && !clusterFacet.size && !vendeurFacet.size && !tourneeFacet.size) return; // لا بيانات كافية لعرض الشريط

    const active = { status: new Set(), cluster: new Set(), vendeur: new Set(), tournee: new Set() };

    const chip = (ftype, fval, innerHtml, chipClr, count) => `
      <button type="button" class="rmap-filter-chip" data-ftype="${ftype}" data-fval="${escHtml(String(fval))}"
        style="--chipclr:${chipClr}">
        ${innerHtml}
        <span class="rmap-filter-count">${count}</span>
      </button>`;

    let statusHtml = "";
    BL_STATUS_ORDER.filter(s => statusFacet.has(s)).forEach(s => {
      statusHtml += chip("status", s,
        `<span class="rmap-filter-dot"></span><span class="rmap-filter-name">${BL_STATUS_FR_LABELS[s]}</span>`,
        BL_STATUS_COLORS[s], statusFacet.get(s));
    });

    let clusterHtml = "";
    Object.keys(CLUSTER_NAMES).filter(c => clusterFacet.has(c)).forEach(c => {
      clusterHtml += chip("cluster", c,
        `<span class="rmap-filter-badge">${CLUSTER_LETTERS[c]}</span><span class="rmap-filter-name">${CLUSTER_NAMES[c]}</span>`,
        CLUSTER_COLORS[c], clusterFacet.get(c));
    });

    let tourneeHtml = "";
    const _tourneeLabel = _isPrevendeur ? "Vendeur" : "Livreur";
    [...tourneeFacet.entries()].sort((a, b) => (a[1].name || "").localeCompare(b[1].name || "")).forEach(([vid, v]) => {
      const initial = (v.name || "—").trim().charAt(0).toUpperCase() || "?";
      tourneeHtml += chip("tournee", vid,
        `<span class="rmap-filter-badge">${escHtml(initial)}</span><span class="rmap-filter-name" title="${escHtml(v.name)}">${escHtml(v.name)}</span>`,
        _vendeurColor(vid), v.count);
    });

    let vendeurHtml = "";
    [...vendeurFacet.entries()].sort((a, b) => (a[1].name || "").localeCompare(b[1].name || "")).forEach(([vid, v]) => {
      const initial = (v.name || "—").trim().charAt(0).toUpperCase() || "?";
      vendeurHtml += chip("vendeur", vid,
        `<span class="rmap-filter-badge">${escHtml(initial)}</span><span class="rmap-filter-name" title="${escHtml(v.name)}">${escHtml(v.name)}</span>`,
        _vendeurColor(vid), v.count);
    });
    const _vendeurGroupLabel = _isPrevendeur ? "Livreur" : "Vendeur";

    // زر «Réinitialiser» يُلحق بآخر صف مبني فعليًا (حتى لا يتكرر ولا يختفي حسب توفر المجموعات)
    const _lastRowHasClear = clusterHtml ? "cluster" : (vendeurHtml ? "vendeur" : (tourneeHtml ? "tournee" : "status"));
    const _clearBtnHtml = `<button type="button" class="rmap-filters-clear" id="rmapFiltersClear" style="display:none">Réinitialiser</button>`;
    bar.innerHTML = `
      ${statusHtml  ? `<div class="rmap-filters-row"><span class="rmap-filters-label">État</span>${statusHtml}${_lastRowHasClear === "status" ? _clearBtnHtml : ""}</div>` : ""}
      ${tourneeHtml ? `<div class="rmap-filters-row"><span class="rmap-filters-label">${_tourneeLabel}</span>${tourneeHtml}${_lastRowHasClear === "tournee" ? _clearBtnHtml : ""}</div>` : ""}
      ${vendeurHtml ? `<div class="rmap-filters-row"><span class="rmap-filters-label">${_vendeurGroupLabel}</span>${vendeurHtml}${_lastRowHasClear === "vendeur" ? _clearBtnHtml : ""}</div>` : ""}
      ${clusterHtml ? `<div class="rmap-filters-row"><span class="rmap-filters-label">Cluster</span>${clusterHtml}${_lastRowHasClear === "cluster" ? _clearBtnHtml : ""}</div>` : ""}
    `;
    bar.style.display = "block";

    const clearBtn = bar.querySelector("#rmapFiltersClear");

    // مطابقة عنصر (marker) لمجموعة فلتر معيّنة بقيمها النشطة — تُستعمل للعدّ العابر للمجموعات
    function _matchGroup(me, groupKey, valSet) {
      if (!valSet || !valSet.size) return true;
      if (groupKey === "status")  return (me.statuses  || []).some(s => valSet.has(s));
      if (groupKey === "cluster") return !!me.cluster   && valSet.has(me.cluster);
      if (groupKey === "vendeur") return me.vendeurId != null && valSet.has(String(me.vendeurId));
      if (groupKey === "tournee") return me.vendorId != null && valSet.has(String(me.vendorId));
      return true;
    }
    function _matchesValue(me, groupKey, value) {
      if (groupKey === "status")  return (me.statuses || []).includes(value);
      if (groupKey === "cluster") return me.cluster === value;
      if (groupKey === "vendeur") return String(me.vendeurId) === String(value);
      if (groupKey === "tournee") return String(me.vendorId) === String(value);
      return false;
    }
    // عدد العناصر لقيمة فلتر معيّنة، بأخذ فلاتر المجموعات الأخرى النشطة بعين الاعتبار (AND بين المجموعات)
    // مع تجاهل تحديدات نفس المجموعة (OR داخل المجموعة الواحدة) — سلوك فلترة متعدد الأوجه قياسي
    function _countForValue(groupKey, value) {
      let n = 0;
      markerEntries.forEach(me => {
        if (!_matchesValue(me, groupKey, value)) return;
        for (const otherKey of ["status", "cluster", "vendeur", "tournee"]) {
          if (otherKey === groupKey) continue;
          if (!_matchGroup(me, otherKey, active[otherKey])) return;
        }
        n++;
      });
      return n;
    }
    // إعادة حساب وتحديث أرقام كل الفقاعات بحسب الفلاتر النشطة حاليًا
    function recomputeCounts() {
      bar.querySelectorAll(".rmap-filter-chip").forEach(btn => {
        const n = _countForValue(btn.dataset.ftype, btn.dataset.fval);
        const cEl = btn.querySelector(".rmap-filter-count");
        if (cEl) cEl.textContent = n;
      });
    }

    function applyFilters() {
      let visible = 0;
      markerEntries.forEach(me => {
        const matchStatus  = !active.status.size  || (me.statuses || []).some(s => active.status.has(s));
        const matchCluster = !active.cluster.size || (me.cluster && active.cluster.has(me.cluster));
        const matchVendeur = !active.vendeur.size || (me.vendeurId != null && active.vendeur.has(String(me.vendeurId)));
        const matchTournee = !active.tournee.size || (me.vendorId != null && active.tournee.has(String(me.vendorId)));
        const matchSearch  = _matchesSearch(me);
        const show = matchStatus && matchCluster && matchVendeur && matchTournee && matchSearch;
        const onMap = map.hasLayer(me.marker);
        if (show && !onMap) me.marker.addTo(map);
        else if (!show && onMap) map.removeLayer(me.marker);
        if (show) visible++;
      });
      if (countEl) countEl.textContent = `${visible} localisé(s)`;
      if (_noResultsEl) _noResultsEl.style.display = visible === 0 ? "block" : "none";
      const anyActive = active.status.size || active.cluster.size || active.vendeur.size || active.tournee.size;
      if (clearBtn) clearBtn.style.display = anyActive ? "inline-block" : "none";
      recomputeCounts();
    }
    window._roundMapApplyAll = applyFilters;

    bar.querySelectorAll(".rmap-filter-chip").forEach(btn => {
      btn.addEventListener("click", () => {
        const ftype = btn.dataset.ftype, fval = btn.dataset.fval;
        const set = active[ftype];
        if (set.has(fval)) { set.delete(fval); btn.classList.remove("rmap-filter-chip--active"); }
        else { set.add(fval); btn.classList.add("rmap-filter-chip--active"); }
        applyFilters();
      });
    });

    clearBtn?.addEventListener("click", () => {
      active.status.clear(); active.cluster.clear(); active.vendeur.clear(); active.tournee.clear();
      bar.querySelectorAll(".rmap-filter-chip--active").forEach(b => b.classList.remove("rmap-filter-chip--active"));
      applyFilters();
    });

    // الشريط أضاف ارتفاعًا جديدًا لأسفل الخريطة — أعِد حساب أبعاد Leaflet كي لا تبقى بلاطات مقصوصة
    requestAnimationFrame(() => { try { map.invalidateSize(); } catch (_) {} });
  })();

  overlay.addEventListener("remove", () => {
    try { map.remove(); } catch (_) {}
    if (window._roundMapApplyAll) window._roundMapApplyAll = null;
  }, { once: true });
}

// ── BLs Modal WM (multi-window) ───────────────────────────────
async function showBLsModalWM(vendorId) {
  const lbl = (App.settings?.vendors || []).find(v => String(v.id) === String(vendorId))?.label || String(vendorId);
  const SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="var(--accent,#3B82F6)" stroke-width="2" width="15" height="15">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/></svg>`;
  const win = _wmCreateWindow("bl", vendorId, `BLs — ${lbl}`, SVG, "560px");
  if (!win) return;
  const { body } = win;
  // Inject full BL UI — same as normal modal but scoped to WM body
  window._blCtx = body;
  body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text3,#94A3B8);
    font-size:12px;display:flex;align-items:center;justify-content:center;gap:8px">
    <div class="spinner-sm"></div>Chargement…</div>`;
  // Delegate to the shared showBLsModal with WM container
  await showBLsModal(vendorId, body);
  // Reset ctx if WM window is closed
  win.el?.addEventListener("remove", () => { if (window._blCtx === body) window._blCtx = null; }, { once:true });
}

// ── Context helpers for WM multi-window support ───────────────
// _blCtx / _payCtx: set to the WM window body when rendering inside WM
// Falls back to document for normal overlay mode
function _blQ(id)  { const ctx = window._blCtx  || document; return ctx === document ? ctx.getElementById(id) : ctx.querySelector('#' + id); }
function _blQA(sel){ return (window._blCtx  || document).querySelectorAll(sel); }
function _payQ(id)  { const ctx = window._payCtx || document; return ctx === document ? ctx.getElementById(id) : ctx.querySelector('#' + id); }
function _payQA(sel){ return (window._payCtx || document).querySelectorAll(sel); }


function _renderBLListBody(bls, baseUrl) {
  const body = _blQ("blListBody");
  if (!body) return;

  // استخراج المنتجات المحلية للـ autocomplete
  const productSet = new Map();
  bls.forEach(b => (b._lines || []).forEach(l => {
    if (l.productId && !productSet.has(l.productId))
      productSet.set(l.productId, l.productName);
  }));
  window._blLocalProducts = [...productSet.entries()]
    .sort((a,b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => ({ id, name }));

  // حالة البحث المتقدم
  window._blAdvOpen  = false;
  window._blRules    = [];
  window._blAllBls   = bls;
  window._blBaseUrl  = baseUrl;

  body.innerHTML = `
    <div id="blFiltCount" style="display:none"></div>
    <div id="blRowsContainer"></div>`;

  // ربط البحث النصي البسيط
  _blQ("blSearchInput")?.addEventListener("input",
    () => _applyBLFilters(bls, baseUrl));

  // ربط زر البحث المتقدم
  const toggleBtn = _blQ("blAdvSearchToggle");
  const panel     = _blQ("blAdvSearchPanel");
  if (toggleBtn && panel) {
    toggleBtn.addEventListener("click", () => {
      window._blAdvOpen = !window._blAdvOpen;
      toggleBtn.style.color = window._blAdvOpen ? "var(--accent,#3B82F6)" : "var(--text3,#94A3B8)";
      if (window._blAdvOpen) {
        panel.style.display = "block";
        _renderAdvSearchPanel(bls, baseUrl);
      } else {
        panel.style.display = "none";
        window._blRules = [];
        _applyBLFilters(bls, baseUrl);
      }
    });
  }

  if (!bls.length) {
    body.querySelector("#blRowsContainer").innerHTML =
      `<div style="text-align:center;color:var(--text3,#94A3B8);padding:24px;font-size:12px">Aucun BL trouvé</div>`;
    return;
  }

  _renderBLRows(bls, baseUrl);
  const countEl = _blQ("blFiltCount");
  if (countEl) { countEl.style.display="none"; }
}

// ── رسم الـ rows فقط (قابل للاستدعاء عند كل فلترة) ───────────
function _renderBLRows(bls, baseUrl) {
  const container = _blQ("blRowsContainer");
  if (!container) return;

  const totalBadge = _blQ("blTotalBadge");
  if (totalBadge) {
    if (bls.length) {
      totalBadge.style.display = "inline-block";
      totalBadge.textContent = formatCa(bls.reduce((s,b)=>s+(b.amount_total||0),0));
    } else {
      totalBadge.style.display = "none";
    }
  }

  const stateLabel = {
    draft:     { label: "Brouillon", color: "#3B82F6", bg: "#EFF6FF" },
    confirmed: { label: "Confirmé",  color: "#F59E0B", bg: "#FFF7ED" },
    assigned:  { label: "Prêt",      color: "#8B5CF6", bg: "#F3E8FF" },
    done:      { label: "Validé",    color: "#15803d", bg: "#F0FDF4" },
    cancel:    { label: "Annulé",    color: "#6B7280", bg: "var(--bg3,#F1F5F9)" },
  };

  const planningStateLabel = {
    scheduled: { label: "Planifié", color: "#3B82F6", bg: "#EFF6FF" },
    delivered: { label: "Livré",    color: "#15803d", bg: "#F0FDF4" },
    delayed:   { label: "Reporté",  color: "#F59E0B", bg: "#FFF7ED" },
    canceled:  { label: "Annulé",   color: "#6B7280", bg: "var(--bg3,#F1F5F9)" },
  };

  const _mkStateBtnEx = (idx, toState, label, currentPlanState, currentState, forceDisabled) => {
    if (forceDisabled) {
      return `<button disabled
        style="font-size:10px;font-weight:600;padding:3px 8px;border-radius:5px;
        border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
        color:var(--text3,#94A3B8);cursor:not-allowed"
        title="🚫 Désaffectez d'abord le livreur">Annulé</button>`;
    }
    return _mkStateBtn(idx, toState, label, currentPlanState, currentState);
  };
  const _mkStateBtn = (idx, toState, label, currentPlanState, currentState) => {
    const isDelivered = currentState === "done";
    const isCurrent   = currentPlanState === toState && !(currentState === "cancel" && toState === "canceled");
    const disabled    = isDelivered || isCurrent;
    const colors = {
      scheduled: { color: "#8B5CF6", bg: "#F3E8FF", border: "#E9D5FF", hbg: "#EDE9FE" },
      delayed:   { color: "#F59E0B", bg: "#FFF7ED", border: "#FED7AA", hbg: "#FFEDD5" },
      canceled:  { color: "#6B7280", bg: "var(--bg3,#F1F5F9)", border: "#E2E8F0", hbg: "#E2E8F0" },
    };
    const c = colors[toState] || colors.canceled;
    if (disabled) {
      return `<button disabled
        style="font-size:10px;font-weight:600;padding:3px 8px;border-radius:5px;
        border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
        color:var(--text3,#94A3B8);cursor:not-allowed"
        title="${isDelivered ? "🚫 BL livré — non modifiable" : "État actuel"}">${label}</button>`;
    }
    return `<button class="bl-state-btn" data-idx="${idx}" data-state="${toState}"
      style="font-size:10px;font-weight:600;padding:3px 8px;border-radius:5px;
      border:1px solid ${c.border};background:${c.bg};color:${c.color};
      cursor:pointer;transition:background .15s"
      onmouseover="this.style.background='${c.hbg}'"
      onmouseout="this.style.background='${c.bg}'"
      title="Passer à: ${label}">${label}</button>`;
  };

  container.innerHTML = bls.map((bl, idx) => {
    const partner  = Array.isArray(bl.partner_id) ? bl.partner_id[1] : "—";
    const partnerId = Array.isArray(bl.partner_id) ? bl.partner_id[0] : null;
    const st       = stateLabel[bl.state]          || { label: bl.state          || "—", color: "#6B7280", bg: "var(--bg3,#F1F5F9)" };
    const pst      = planningStateLabel[bl.planning_state] || { label: bl.planning_state || "—", color: "#6B7280", bg: "var(--bg3,#F1F5F9)" };
    const amount   = typeof bl.amount_total === "number"
      ? bl.amount_total.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ") : "—";
    const blUrl    = `${ODOO_BASE}/web#id=${bl.id}&action=547&active_id=${bl.id}&model=stock.picking&view_type=form&cids=1&menu_id=336`;

    const effectiveState = bl.state === "done" ? "delivered" : bl.planning_state;
    const hasDelivery   = !!(bl.delivery_planning_id || bl.delivery_user_id);
    const isOdooCancelled = bl.state === "cancel";
    const isPrevente    = App.currentMode === "prevente";

    const canCancel  = isPrevente ? !hasDelivery : true;
    const canUnlink  = hasDelivery && !isOdooCancelled;

    const btnScheduled = _mkStateBtn(idx, "scheduled", "Planifié", effectiveState, bl.state);
    const btnDelayed   = _mkStateBtn(idx, "delayed",   "Reporté",  effectiveState, bl.state);
    const btnCanceled  = _mkStateBtnEx(idx, "canceled", "Annulé", effectiveState, bl.state, !canCancel);
    const canChangeTournee = hasDelivery && !isOdooCancelled && bl.state !== "done";
    const btnChangeTournee = canChangeTournee ? `<button class="bl-change-tournee-btn" data-idx="${idx}"
      style="font-size:10px;font-weight:600;padding:3px 8px;border-radius:5px;
      border:1px solid #BFDBFE;background:#EFF6FF;color:#2563EB;cursor:pointer;transition:background .15s"
      onmouseover="this.style.background='#DBEAFE'"
      onmouseout="this.style.background='#EFF6FF'"
      title="Changer la tournée">⇄ Tournée</button>` : "";

    const blPdfUrl = `/api/report/pdf/stock.report_deliveryslip/${bl.id}`;
    const blPdfName = escHtml(String(bl.name || "BL").replace(/[\\/]+/g, "-")) + ".pdf";
    const btnPdf = `<a href="${blPdfUrl}" download="${blPdfName}" rel="noopener"
      style="font-size:10px;font-weight:600;padding:3px 8px;border-radius:5px;
      border:1px solid #FECACA;background:#FEF2F2;color:#DC2626;cursor:pointer;transition:background .15s;
      text-decoration:none;display:inline-flex;align-items:center;gap:3px"
      onmouseover="this.style.background='#FEE2E2'"
      onmouseout="this.style.background='#FEF2F2'"
      title="Télécharger le BL en PDF">📄 PDF</a>`;

    const btnOpen = `<a href="${blUrl}" target="_blank"
      style="width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;
      border-radius:6px;border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
      color:var(--accent,#3B82F6);text-decoration:none;flex-shrink:0;transition:background .15s"
      onmouseover="this.style.background='#DBEAFE'"
      onmouseout="this.style.background='var(--bg3,#F1F5F9)'"
      title="Ouvrir BL">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
      </svg></a>`;

    const vendorHeader = bl._vendorLabel
      ? `<div style="font-size:10px;font-weight:700;color:var(--text3,#94A3B8);
          text-align:center;padding:2px 8px;background:var(--bg3,#F1F5F9);
          border-radius:4px;margin-bottom:6px">${escHtml(bl._vendorLabel)}</div>`
      : "";
    return `
      <div class="bl-row" data-idx="${idx}" data-id="${bl.id}"
        style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
        border-radius:8px;padding:10px 12px;margin-bottom:8px;
        box-shadow:0 1px 4px rgba(0,0,0,.04)">
        ${vendorHeader}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
          <div style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" class="bl-row-check" data-idx="${idx}"
              style="width:15px;height:15px;cursor:pointer;accent-color:var(--accent,#3B82F6);flex-shrink:0"/>
            <span style="font-size:11px;font-weight:700;color:var(--accent,#3B82F6)">${escHtml(bl.name)}</span>
          </div>
          <div style="display:flex;gap:4px;align-items:center">
            <span style="font-size:10px;padding:2px 7px;border-radius:4px;font-weight:600;
              background:${pst.bg};color:${pst.color}">${pst.label}</span>
            <span style="font-size:10px;padding:2px 7px;border-radius:4px;font-weight:600;
              background:${st.bg};color:${st.color}">${st.label}</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;margin-bottom:8px;gap:10px">
          <span style="font-size:11px;color:var(--text2,#475569);flex:1">${escHtml(partner)}${_clientLinkIconHtml(partnerId, null)}</span>
          <span style="font-size:13px;font-weight:700;color:var(--text,#0F172A)">${amount} DA</span>
        </div>
        <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap">
          ${btnScheduled}${btnDelayed}${btnCanceled}${btnChangeTournee}${btnPdf}
          <div style="flex:1"></div>
          ${canUnlink ? `<button class="bl-unlink-btn" data-idx="${idx}"
            style="font-size:10px;font-weight:600;padding:3px 8px;border-radius:5px;
            border:1px solid #FECACA;background:#FEF2F2;color:#DC2626;cursor:pointer;transition:background .15s"
            onmouseover="this.style.background='#FECACA'"
            onmouseout="this.style.background='#FEF2F2'"
            title="Désaffecter livreur et tournée">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <line x1="18" y1="8" x2="23" y2="13"/><line x1="23" y1="8" x2="18" y2="13"/>
            </svg>
          </button>` : `<button disabled
            style="font-size:10px;padding:3px 8px;border-radius:5px;width:28px;height:28px;
            border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
            color:var(--text3,#94A3B8);cursor:not-allowed"
            title="🚫 Aucun livreur affecté">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <line x1="18" y1="8" x2="23" y2="13"/><line x1="23" y1="8" x2="18" y2="13"/>
            </svg>
          </button>`}
          ${btnOpen}
        </div>
      </div>`;
  }).join("");

  container.querySelectorAll(".bl-unlink-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      _showBLUnlinkConfirm(bls[idx], bls, baseUrl);
    });
  });
  container.querySelectorAll(".bl-change-tournee-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      _showChangeTourneeModal(bls[idx], bls, baseUrl);
    });
  });
  container.querySelectorAll(".bl-row").forEach(row => {
    row.addEventListener("click", e => {
      if (e.target.closest("button,a,input")) return;
      const idx = parseInt(row.dataset.idx);
      _showBLDetails(bls[idx], baseUrl, bls);
    });
  });
  container.querySelectorAll(".bl-state-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx     = parseInt(btn.dataset.idx);
      const toState = btn.dataset.state;
      _showBLStateConfirm(bls[idx], toState, bls, baseUrl);
    });
  });

  // ── Bulk selection ────────────────────────────────────────────
  const _updateBulkBar = () => {
    const checked = container.querySelectorAll(".bl-row-check:checked");
    const bar     = _blQ("blBulkBar");
    const count   = _blQ("blBulkCount");
    if (bar)   bar.style.display  = checked.length > 0 ? "" : "none";
    if (count) count.textContent  = `${checked.length} sélectionné(s)`;
    const hasValidated = [...checked].some(c => {
      const bl = bls[parseInt(c.dataset.idx)];
      return bl && bl.state === "done";
    });
    _blQA(".bl-bulk-btn").forEach(btn => {
      btn.disabled = hasValidated;
      btn.style.opacity = hasValidated ? "0.4" : "1";
      btn.style.cursor  = hasValidated ? "not-allowed" : "pointer";
      btn.title = hasValidated ? "🚫 Un BL livré est sélectionné" : "";
    });
  };

  container.querySelectorAll(".bl-row-check").forEach(cb => {
    cb.addEventListener("change", _updateBulkBar);
  });

  // استبدال الزر بنسخة جديدة لمسح أي listeners متراكمة
  const _selectAllBtn = _blQ("blBulkSelectAll");
  if (_selectAllBtn) {
    const _fresh = _selectAllBtn.cloneNode(true);
    _selectAllBtn.replaceWith(_fresh);
    _fresh.addEventListener("click", () => {
      const visibleChecks = [...container.querySelectorAll(".bl-row-check")];
      const allChecked = visibleChecks.length > 0 && visibleChecks.every(c => c.checked);
      visibleChecks.forEach(c => { c.checked = !allChecked; });
      _updateBulkBar();
    });
  }

  _blQ("blBulkOpenLinks")?.addEventListener("click", () => {
    const checked = [...container.querySelectorAll(".bl-row-check:checked")];
    if (!checked.length) return;
    const selectedBls = checked.map(c => bls[parseInt(c.dataset.idx)]).filter(Boolean);
    const base = (window._currentBLBaseUrl || "").replace(/\/$/, "");
    let opened = 0;
    selectedBls.forEach(bl => {
      if (!bl?.id) return;
      const url = `${base}/web#id=${bl.id}&model=stock.picking&view_type=form&cids=1`;
      window.open(url, `_bl_${bl.id}`);
      opened++;
    });
    if (!opened) addNotif("Aucun BL valide sélectionné", "warning");
  });

  _blQ("blBulkPdfBtn")?.addEventListener("click", () => {
    const checked = [...container.querySelectorAll(".bl-row-check:checked")];
    if (!checked.length) return;
    const ids = checked.map(c => bls[parseInt(c.dataset.idx)]?.id).filter(Boolean);
    if (!ids.length) { addNotif("Aucun BL valide sélectionné", "warning"); return; }
    const url = `/api/report/pdf/stock.report_deliveryslip/${ids.join(",")}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `BL_${ids.length}_documents.pdf`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  _blQA(".bl-bulk-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const action  = btn.dataset.bulk;
      const checked = [...container.querySelectorAll(".bl-row-check:checked")];
      if (!checked.length) return;
      const selectedBls = checked.map(c => bls[parseInt(c.dataset.idx)]);
      _showBLBulkConfirm(selectedBls, action, bls, baseUrl);
    });
  });

  _blQ("blBulkChangeTournee")?.addEventListener("click", () => {
    const checked = [...container.querySelectorAll(".bl-row-check:checked")];
    if (!checked.length) return;
    const selectedBls = checked.map(c => bls[parseInt(c.dataset.idx)]).filter(Boolean);
    const eligible = selectedBls.filter(bl =>
      !!(bl.delivery_planning_id || bl.delivery_user_id) && bl.state !== "cancel" && bl.state !== "done"
    );
    if (!eligible.length) {
      addNotif("Aucun BL sélectionné n'est éligible au changement de tournée", "warning");
      return;
    }
    if (eligible.length < selectedBls.length) {
      addNotif(`${selectedBls.length - eligible.length} BL(s) ignoré(s) (livré/annulé/sans tournée)`, "info");
    }
    _showChangeTourneeModal(eligible, bls, baseUrl);
  });
}

// ── تطبيق الفلاتر وإعادة الرسم ───────────────────────────────
function _applyBLFilters(allBls, baseUrl) {
  const searchQ    = (_blQ("blSearchInput")?.value || "").toLowerCase().trim();
  const rules      = window._blRules || [];
  const useOr      = (window._blAdvMode || "and") === "or";
  const activeQF   = window._blActiveQF;       // Set des états actifs (quick filter)

  const filtered = allBls.filter(bl => {
    // ── Quick Filter par état (OR) ──
    if (activeQF?.size > 0) {
      // effectiveState = même logique que l'affichage
      const effectiveState = bl.state === "done" ? "delivered" : (bl.planning_state || "");
      const odooState      = bl.state || "";
      const matchesQF = [...activeQF].some(key => {
        switch(key) {
          case "done":      return effectiveState === "delivered";
          case "scheduled": return effectiveState === "scheduled";
          case "delayed":   return effectiveState === "delayed";
          case "canceled":  return effectiveState === "canceled";
          case "assigned":  return odooState === "assigned"  && !["delivered","canceled","delayed"].includes(effectiveState);
          case "waiting":   return odooState === "waiting_another_move" || odooState === "waiting";
          case "confirmed": return odooState === "confirmed";
          default:          return false;
        }
      });
      if (!matchesQF) return false;
    }

    // ── بحث نصي بسيط (يعمل دائماً مع الـ rules) ──
    if (searchQ) {
      const tokens  = searchQ.split(/\s+/).filter(Boolean);
      const partner = (Array.isArray(bl.partner_id) ? bl.partner_id[1] : "").toLowerCase();
      const name    = (bl.name || "").toLowerCase();
      if (!tokens.every(t => partner.includes(t) || name.includes(t))) return false;
    }

    if (!rules.length) return true;

    const lines = bl._lines || [];
    const ca    = bl.amount_total || 0;

    const results = rules.map(r => {
      switch (r.type) {
        case "product": {
          if (!r.productId) return true;
          const line = lines.find(l => l.productId === r.productId);
          if (!line) return false;
          const qty = line.qty || 0;
          if (r.qtyMin > 0 && qty < r.qtyMin) return false;
          if (r.qtyMax > 0 && qty > r.qtyMax) return false;
          return true;
        }
        case "ca": {
          if (r.caMin > 0 && ca < r.caMin) return false;
          if (r.caMax > 0 && ca > r.caMax) return false;
          return true;
        }
        case "nb_articles": {
          if (r.min > 0 && lines.length < r.min) return false;
          if (r.max > 0 && lines.length > r.max) return false;
          return true;
        }
        case "planning_state": {
          if (!r.states || !r.states.length) return true;
          const effectiveState = bl.state === "done" ? "delivered" : (bl.planning_state || "");
          return r.states.includes(effectiveState);
        }
        case "odoo_state": {
          if (!r.states || !r.states.length) return true;
          return r.states.includes(bl.state || "");
        }
        default: return true;
      }
    });

    return useOr ? results.some(Boolean) : results.every(Boolean);
  });

  // عداد النتائج
  const countEl = _blQ("blAdvCount");
  if (countEl) countEl.textContent = `${filtered.length} / ${allBls.length}`;

  _renderBLRows(filtered, baseUrl);
}

// ── البحث المتقدم: رسم الـ panel ─────────────────────────────
function _renderAdvSearchPanel(allBls, baseUrl) {
  const panel = _blQ("blAdvSearchPanel");
  if (!panel) return;
  if (!window._blRules) window._blRules = [];
  if (!window._blAdvMode) window._blAdvMode = "and";

  const _iStyle = `font-size:10px;padding:4px 6px;border-radius:5px;
    border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
    color:var(--text,#0F172A);outline:none;`;

  const _ruleHtml = (rule, idx) => {
    let body = "";

    if (rule.type === "product") {
      const selectedName = rule.productName || "";
      body = `
        <div style="display:flex;flex-direction:column;gap:4px;flex:1">
          <div style="position:relative">
            <input class="adv-prod-input" data-idx="${idx}" type="text"
              placeholder="Nom du produit…" value="${escHtml(selectedName)}"
              style="${_iStyle}width:100%;box-sizing:border-box"/>
            <div class="adv-prod-suggest" data-idx="${idx}"
              style="display:none;position:absolute;left:0;right:0;top:100%;z-index:999;
              background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
              border-radius:0 0 6px 6px;max-height:140px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,.1)">
            </div>
          </div>
          <div style="display:flex;gap:4px;align-items:center">
            <span style="font-size:9px;color:var(--text3,#94A3B8);white-space:nowrap">Qté</span>
            <input class="adv-qty-min" data-idx="${idx}" type="number" min="0" placeholder="min"
              value="${rule.qtyMin || ""}"
              style="${_iStyle}width:52px"/>
            <span style="font-size:9px;color:var(--text3,#94A3B8)">–</span>
            <input class="adv-qty-max" data-idx="${idx}" type="number" min="0" placeholder="max"
              value="${rule.qtyMax || ""}"
              style="${_iStyle}width:52px"/>
          </div>
        </div>`;

    } else if (rule.type === "ca") {
      body = `
        <div style="display:flex;gap:4px;align-items:center;flex:1;flex-wrap:wrap">
          <span style="font-size:9px;color:var(--text3,#94A3B8)">CA</span>
          <input class="adv-ca-min" data-idx="${idx}" type="number" min="0" placeholder="min"
            value="${rule.caMin || ""}" style="${_iStyle}width:70px"/>
          <span style="font-size:9px;color:var(--text3,#94A3B8)">–</span>
          <input class="adv-ca-max" data-idx="${idx}" type="number" min="0" placeholder="max"
            value="${rule.caMax || ""}" style="${_iStyle}width:70px"/>
          <span style="font-size:9px;color:var(--text3,#94A3B8)">DA</span>
        </div>`;

    } else if (rule.type === "nb_articles") {
      body = `
        <div style="display:flex;gap:4px;align-items:center;flex:1;flex-wrap:wrap">
          <span style="font-size:9px;color:var(--text3,#94A3B8)">Nb articles</span>
          <input class="adv-nb-min" data-idx="${idx}" type="number" min="0" placeholder="min"
            value="${rule.min || ""}" style="${_iStyle}width:60px"/>
          <span style="font-size:9px;color:var(--text3,#94A3B8)">–</span>
          <input class="adv-nb-max" data-idx="${idx}" type="number" min="0" placeholder="max"
            value="${rule.max || ""}" style="${_iStyle}width:60px"/>
        </div>`;

    } else if (rule.type === "planning_state") {
      const opts = [
        { v:"scheduled", l:"Planifié",   c:"#8B5CF6", bg:"#F3E8FF" },
        { v:"delayed",   l:"Reporté",    c:"#F59E0B", bg:"#FFF7ED" },
        { v:"canceled",  l:"Annulé",     c:"#6B7280", bg:"var(--bg3,#F1F5F9)" },
        { v:"delivered", l:"Livré",      c:"#15803d", bg:"#F0FDF4" },
      ];
      body = `<div style="display:flex;gap:4px;flex-wrap:wrap;flex:1">` +
        opts.map(o => {
          const active = (rule.states || []).includes(o.v);
          return `<button class="adv-pstate-btn" data-idx="${idx}" data-val="${o.v}"
            style="font-size:9px;font-weight:600;padding:3px 8px;border-radius:4px;cursor:pointer;
            border:1px solid ${active ? o.c : "var(--border,#E2E8F0)"};
            background:${active ? o.bg : "var(--bg3,#F1F5F9)"};
            color:${active ? o.c : "var(--text3,#94A3B8)"}">${o.l}</button>`;
        }).join("") + `</div>`;

    } else if (rule.type === "odoo_state") {
      const opts = [
        { v:"draft",     l:"Brouillon",   c:"#3B82F6", bg:"#EFF6FF" },
        { v:"confirmed", l:"En attente",  c:"#F59E0B", bg:"#FFF7ED" },
        { v:"assigned",  l:"Prêt",        c:"#8B5CF6", bg:"#F3E8FF" },
        { v:"done",      l:"Fait",        c:"#15803d", bg:"#F0FDF4" },
        { v:"cancel",    l:"Annulé",      c:"#6B7280", bg:"var(--bg3,#F1F5F9)" },
      ];
      body = `<div style="display:flex;gap:4px;flex-wrap:wrap;flex:1">` +
        opts.map(o => {
          const active = (rule.states || []).includes(o.v);
          return `<button class="adv-ostate-btn" data-idx="${idx}" data-val="${o.v}"
            style="font-size:9px;font-weight:600;padding:3px 8px;border-radius:4px;cursor:pointer;
            border:1px solid ${active ? o.c : "var(--border,#E2E8F0)"};
            background:${active ? o.bg : "var(--bg3,#F1F5F9)"};
            color:${active ? o.c : "var(--text3,#94A3B8)"}">${o.l}</button>`;
        }).join("") + `</div>`;
    }

    const typeLabel = {
      product:"Produit", ca:"CA BL", nb_articles:"Nb articles",
      planning_state:"État planning", odoo_state:"État système"
    }[rule.type] || rule.type;

    return `
      <div class="adv-rule-row" data-idx="${idx}"
        style="display:flex;gap:6px;align-items:flex-start;padding:8px 10px;
        background:var(--bg3,#F1F5F9);border-radius:7px;border:1px solid var(--border,#E2E8F0);
        margin-bottom:5px">
        <span style="font-size:9px;font-weight:700;color:var(--accent,#3B82F6);
          white-space:nowrap;padding-top:5px;min-width:60px">${typeLabel}</span>
        ${body}
        <button class="adv-rule-del" data-idx="${idx}"
          style="background:none;border:none;cursor:pointer;color:var(--text3,#94A3B8);
          font-size:14px;padding:2px 4px;flex-shrink:0;border-radius:4px;line-height:1"
          onmouseover="this.style.color='#ef4444'"
          onmouseout="this.style.color='var(--text3,#94A3B8)'">×</button>
      </div>`;
  };

  const isOr = window._blAdvMode === "or";
  panel.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:8px;padding:10px;box-shadow:0 2px 8px rgba(0,0,0,.06)">

      <!-- header: mode + compteur -->
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
        <span style="font-size:9px;font-weight:700;color:var(--text3,#94A3B8);letter-spacing:.04em">MODE</span>
        <button id="blAdvModeAnd"
          style="font-size:9px;font-weight:700;padding:3px 8px;border-radius:4px;cursor:pointer;
          border:1px solid ${!isOr?"var(--accent,#3B82F6)":"var(--border,#E2E8F0)"};
          background:${!isOr?"#EFF6FF":"var(--bg3,#F1F5F9)"};
          color:${!isOr?"var(--accent,#3B82F6)":"var(--text3,#94A3B8)"}">ET</button>
        <button id="blAdvModeOr"
          style="font-size:9px;font-weight:700;padding:3px 8px;border-radius:4px;cursor:pointer;
          border:1px solid ${isOr?"#8B5CF6":"var(--border,#E2E8F0)"};
          background:${isOr?"#F3E8FF":"var(--bg3,#F1F5F9)"};
          color:${isOr?"#8B5CF6":"var(--text3,#94A3B8)"}">OU</button>
        <span style="flex:1"></span>
        <span id="blAdvCount" style="font-size:10px;font-weight:700;color:var(--accent,#3B82F6)"></span>
        <button id="blAdvReset"
          style="font-size:9px;padding:3px 8px;border-radius:4px;cursor:pointer;
          border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
          color:var(--text2,#475569)">Reset</button>
      </div>

      <!-- rules list -->
      <div id="blAdvRulesList">
        ${window._blRules.map((r,i) => _ruleHtml(r,i)).join("")}
      </div>

      <!-- add rule buttons -->
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px">
        ${[
          ["product","+ Produit","#EFF6FF","#3B82F6","#BFDBFE"],
          ["ca","+ CA BL","#F0FDF4","#15803d","#BBF7D0"],
          ["nb_articles","+ Nb art.","#FFF7ED","#F59E0B","#FED7AA"],
          ["planning_state","+ État plan.","#F3E8FF","#8B5CF6","#E9D5FF"],
          ["odoo_state","+ État sys.","var(--bg3,#F1F5F9)","#6B7280","#E2E8F0"],
        ].map(([t,l,bg,c,b]) =>
          `<button class="adv-add-rule" data-rtype="${t}"
            style="font-size:9px;font-weight:600;padding:3px 8px;border-radius:4px;cursor:pointer;
            border:1px solid ${b};background:${bg};color:${c}">${l}</button>`
        ).join("")}
      </div>
    </div>`;

  // ── ربط الأحداث ──
  const _refresh = () => {
    _renderAdvSearchPanel(allBls, baseUrl);
    _applyBLFilters(allBls, baseUrl);
  };

  // mode AND/OR
  panel.querySelector("#blAdvModeAnd")?.addEventListener("click", () => {
    window._blAdvMode = "and"; _refresh();
  });
  panel.querySelector("#blAdvModeOr")?.addEventListener("click", () => {
    window._blAdvMode = "or"; _refresh();
  });

  // reset
  panel.querySelector("#blAdvReset")?.addEventListener("click", () => {
    window._blRules = []; window._blAdvMode = "and"; _refresh();
  });

  // حذف rule
  panel.querySelectorAll(".adv-rule-del").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      window._blRules.splice(idx, 1);
      _refresh();
    });
  });

  // إضافة rule
  panel.querySelectorAll(".adv-add-rule").forEach(btn => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.rtype;
      const defaults = {
        product:        { type:"product",        productId:null, productName:"", qtyMin:0, qtyMax:0 },
        ca:             { type:"ca",             caMin:0, caMax:0 },
        nb_articles:    { type:"nb_articles",    min:0, max:0 },
        planning_state: { type:"planning_state", states:[] },
        odoo_state:     { type:"odoo_state",     states:[] },
      };
      window._blRules.push({ ...defaults[t] });
      _refresh();
    });
  });

  // تغيير قيم rules — product input
  panel.querySelectorAll(".adv-prod-input").forEach(inp => {
    const idx     = parseInt(inp.dataset.idx);
    const suggest = panel.querySelector(`.adv-prod-suggest[data-idx="${idx}"]`);

    inp.addEventListener("input", async () => {
      const q   = inp.value.trim().toLowerCase();
      window._blRules[idx].productId   = null;
      window._blRules[idx].productName = inp.value;

      // بحث محلي أولاً
      let hits = (window._blLocalProducts || []).filter(p => p.name.toLowerCase().includes(q));

      // إن لم يجد → Odoo
      if (!hits.length && q.length >= 2) {
        try {
          const baseUrl2 = window._blBaseUrl || "";
          const res = await rpcController.searchProducts(baseUrl2, q);
          hits = (res || []).map(p => ({ id: p.id, name: Array.isArray(p.name)?p.name[1]:p.name }));
        } catch(_) {}
      }

      suggest.style.display = hits.length ? "block" : "none";
      suggest.innerHTML = hits.slice(0,8).map(p =>
        `<div class="adv-suggest-item" data-id="${p.id}" data-name="${escHtml(p.name)}"
          style="padding:5px 8px;font-size:10px;cursor:pointer;border-bottom:1px solid var(--border,#E2E8F0)"
          onmouseover="this.style.background='var(--bg3,#F1F5F9)'"
          onmouseout="this.style.background=''">${escHtml(productLabel(p.name))}</div>`
      ).join("");

      suggest.querySelectorAll(".adv-suggest-item").forEach(item => {
        item.addEventListener("click", () => {
          window._blRules[idx].productId   = parseInt(item.dataset.id);
          window._blRules[idx].productName = item.dataset.name;
          inp.value = item.dataset.name;
          suggest.style.display = "none";
          _applyBLFilters(allBls, baseUrl);
        });
      });
    });

    // إخفاء الاقتراحات عند الخروج
    document.addEventListener("click", e => {
      if (!inp.contains(e.target) && !suggest.contains(e.target))
        suggest.style.display = "none";
    }, { once:false });
  });

  // qty min/max
  panel.querySelectorAll(".adv-qty-min").forEach(inp => {
    inp.addEventListener("input", () => {
      const idx = parseInt(inp.dataset.idx);
      window._blRules[idx].qtyMin = parseFloat(inp.value) || 0;
      _applyBLFilters(allBls, baseUrl);
    });
  });
  panel.querySelectorAll(".adv-qty-max").forEach(inp => {
    inp.addEventListener("input", () => {
      const idx = parseInt(inp.dataset.idx);
      window._blRules[idx].qtyMax = parseFloat(inp.value) || 0;
      _applyBLFilters(allBls, baseUrl);
    });
  });

  // ca min/max
  panel.querySelectorAll(".adv-ca-min").forEach(inp => {
    inp.addEventListener("input", () => {
      const idx = parseInt(inp.dataset.idx);
      window._blRules[idx].caMin = parseFloat(inp.value) || 0;
      _applyBLFilters(allBls, baseUrl);
    });
  });
  panel.querySelectorAll(".adv-ca-max").forEach(inp => {
    inp.addEventListener("input", () => {
      const idx = parseInt(inp.dataset.idx);
      window._blRules[idx].caMax = parseFloat(inp.value) || 0;
      _applyBLFilters(allBls, baseUrl);
    });
  });

  // nb articles min/max
  panel.querySelectorAll(".adv-nb-min").forEach(inp => {
    inp.addEventListener("input", () => {
      const idx = parseInt(inp.dataset.idx);
      window._blRules[idx].min = parseInt(inp.value) || 0;
      _applyBLFilters(allBls, baseUrl);
    });
  });
  panel.querySelectorAll(".adv-nb-max").forEach(inp => {
    inp.addEventListener("input", () => {
      const idx = parseInt(inp.dataset.idx);
      window._blRules[idx].max = parseInt(inp.value) || 0;
      _applyBLFilters(allBls, baseUrl);
    });
  });

  // planning state toggles
  panel.querySelectorAll(".adv-pstate-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      const val = btn.dataset.val;
      const arr = window._blRules[idx].states;
      const i   = arr.indexOf(val);
      if (i === -1) arr.push(val); else arr.splice(i,1);
      _refresh();
    });
  });

  // odoo state toggles
  panel.querySelectorAll(".adv-ostate-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      const val = btn.dataset.val;
      const arr = window._blRules[idx].states;
      const i   = arr.indexOf(val);
      if (i === -1) arr.push(val); else arr.splice(i,1);
      _refresh();
    });
  });

  // تحديث العداد مباشرة
  _applyBLFilters(allBls, baseUrl);
}

async function _showBLLineEditModal(line, bl, baseUrl, lines) {
  document.getElementById("blLineEditOverlay")?.remove();
  const product = Array.isArray(line.product_id) ? line.product_id[1] : "—";
  const cdn     = line.packaging_quantity ?? 0;
  const qty     = line.product_uom_qty ?? 0;
  const uom     = Array.isArray(line.product_uom) ? line.product_uom[1] : "";

  const overlay = document.createElement("div");
  overlay.id = "blLineEditOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10003;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.5);padding:16px;
  `;
  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:340px;padding:20px;
      box-shadow:0 8px 32px rgba(0,0,0,.2)">
      <div style="font-size:12px;font-weight:700;color:var(--text,#0F172A);margin-bottom:4px">Modifier la ligne</div>
      <div style="font-size:11px;color:var(--text3,#94A3B8);margin-bottom:16px">${escHtml(productLabel(product))}</div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div>
          <label style="font-size:10px;font-weight:600;color:var(--text2,#475569);display:block;margin-bottom:4px">CDN</label>
          <input id="editCdn" type="number" min="0" step="1" value="${cdn}"
            style="width:100%;padding:8px 10px;border:1px solid var(--border,#E2E8F0);
            border-radius:6px;background:var(--bg3,#F1F5F9);color:var(--text,#0F172A);
            font-size:13px;outline:none;box-sizing:border-box"/>
        </div>
        <div>
          <label style="font-size:10px;font-weight:600;color:var(--text2,#475569);display:block;margin-bottom:4px">Quantité (${escHtml(uom)})</label>
          <input id="editQty" type="number" min="0" step="0.001" value="${qty}"
            style="width:100%;padding:8px 10px;border:1px solid var(--border,#E2E8F0);
            border-radius:6px;background:var(--bg3,#F1F5F9);color:var(--text,#0F172A);
            font-size:13px;outline:none;box-sizing:border-box"/>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button id="blLineEditCancel"
          style="flex:1;padding:8px;border:1px solid var(--border,#E2E8F0);
          background:var(--bg3,#F1F5F9);color:var(--text2,#475569);
          border-radius:6px;cursor:pointer;font-size:12px">Annuler</button>
        <button id="blLineEditSave"
          style="flex:2;padding:8px;border:none;background:var(--accent,#3B82F6);
          color:#fff;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700">
          Enregistrer</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  document.getElementById("blLineEditCancel")?.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  document.getElementById("editQty")?.addEventListener("input", () => {
    document.getElementById("editCdn").value = 0;
  });

  document.getElementById("blLineEditSave")?.addEventListener("click", async () => {
    const newCdn = parseFloat(document.getElementById("editCdn").value) || 0;
    const newQty = parseFloat(document.getElementById("editQty").value) || 0;
    const saveBtn = document.getElementById("blLineEditSave");
    saveBtn.disabled = true;
    saveBtn.style.opacity = "0.6";
    try {
      await _rpc_call(baseUrl, {
        model: "stock.move", method: "write",
        args: [[line.id], { product_uom_qty: newQty, packaging_quantity: newCdn }],
        kwargs: {},
      });
      line.product_uom_qty    = newQty;
      line.packaging_quantity = newCdn;
      addNotif("Ligne modifiée ✓", "success");
      overlay.remove();
      _showBLDetails(bl, baseUrl, bls);
    } catch(e) {
      addNotif("Erreur: " + e.message, "error");
      saveBtn.disabled = false;
      saveBtn.style.opacity = "1";
    }
  });
}

// ______________________
function _fmtStock(s) {
  if (!s) return { text: "0", color: "#b91c1c" };
  const { free, packName, cartons, units } = s;
  const color = free > 0 ? "#15803d" : "#b91c1c";
  if (!packName || cartons === 0 && units === 0) {
    return { text: `${units} U`, color };
  }
  const abbr = packName.toLowerCase().startsWith("f") ? "F" : "C";
  if (cartons > 0 && units > 0) return { text: `${cartons} ${abbr} | ${units} U`, color };
  if (cartons > 0)              return { text: `${cartons} ${abbr}`, color };
  return { text: `${units} U`, color };
}
async function _showAddBLLineModal(bl, baseUrl) {
  document.getElementById("blAddLineOverlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "blAddLineOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10003;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.5);padding:16px;
  `;
  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:340px;padding:20px;
      box-shadow:0 8px 32px rgba(0,0,0,.2)">
      <div style="font-size:12px;font-weight:700;color:var(--text,#0F172A);margin-bottom:16px">Ajouter un article</div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div>
          <label style="font-size:10px;font-weight:600;color:var(--text2,#475569);display:block;margin-bottom:4px">Rechercher article</label>
          <input id="addLineSearch" type="text" placeholder="Nom du produit…"
            style="width:100%;padding:8px 10px;border:1px solid var(--border,#E2E8F0);
            border-radius:6px;background:var(--bg3,#F1F5F9);color:var(--text,#0F172A);
            font-size:12px;outline:none;box-sizing:border-box"/>
          <div id="addLineResults" style="margin-top:4px;max-height:140px;overflow-y:auto;
            border:1px solid var(--border,#E2E8F0);border-radius:6px;display:none;
            background:var(--bg2,#fff)"></div>
        </div>
        <div id="addLineSelected" style="display:none;font-size:11px;font-weight:600;
          color:var(--accent,#3B82F6);padding:6px 10px;background:#EFF6FF;
          border-radius:6px;border:1px solid #BFDBFE"></div>
        <div style="display:flex;gap:8px">
          <div style="flex:1">
            <label style="font-size:10px;font-weight:600;color:var(--text2,#475569);display:block;margin-bottom:4px">CDN</label>
            <input id="addLineCdn" type="number" min="0" step="1" value="0"
              style="width:100%;padding:8px 10px;border:1px solid var(--border,#E2E8F0);
              border-radius:6px;background:var(--bg3,#F1F5F9);color:var(--text,#0F172A);
              font-size:13px;outline:none;box-sizing:border-box"/>
          </div>
          <div style="flex:1">
            <label style="font-size:10px;font-weight:600;color:var(--text2,#475569);display:block;margin-bottom:4px">Quantité</label>
            <input id="addLineQty" type="number" min="0" step="0.001" value="0"
              style="width:100%;padding:8px 10px;border:1px solid var(--border,#E2E8F0);
              border-radius:6px;background:var(--bg3,#F1F5F9);color:var(--text,#0F172A);
              font-size:13px;outline:none;box-sizing:border-box"/>
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button id="addLineCancel"
          style="flex:1;padding:8px;border:1px solid var(--border,#E2E8F0);
          background:var(--bg3,#F1F5F9);color:var(--text2,#475569);
          border-radius:6px;cursor:pointer;font-size:12px">Annuler</button>
        <button id="addLineSave" disabled
          style="flex:2;padding:8px;border:none;background:#94A3B8;
          color:#fff;border-radius:6px;cursor:not-allowed;font-size:12px;font-weight:700">
          Ajouter</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  document.getElementById("addLineCancel")?.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  let selectedProduct = null;
  let searchTimer = null;

  // CDN → Qty
  document.getElementById("addLineCdn")?.addEventListener("input", () => {
    if (!selectedProduct?._qpb) return;
    const cdn = parseFloat(document.getElementById("addLineCdn").value) || 0;
    document.getElementById("addLineQty").value = cdn * selectedProduct._qpb;
  });

  // Qty → CDN reset
  document.getElementById("addLineQty")?.addEventListener("input", () => {
    document.getElementById("addLineCdn").value = 0;
  });

  // بحث عن منتج
  document.getElementById("addLineSearch")?.addEventListener("input", e => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (q.length < 2) { document.getElementById("addLineResults").style.display = "none"; return; }
    searchTimer = setTimeout(async () => {
      try {
        // بحث في المنتجات المحلية أولاً
        const imported = window._importedProducts || [];
        const ql = q.toLowerCase();
        let results = imported.filter(p =>
          (p.name || "").toLowerCase().includes(ql) ||
          (p.default_code || "").toLowerCase().includes(ql)
        ).slice(0, 15);

        // إذا لم يجد → بحث Odoo
        if (!results.length) {
          const odoo = await _rpc_call(baseUrl, {
            model: "product.product", method: "search_read",
            args: [[["name", "ilike", q], ["type", "!=", "service"]]],
            kwargs: { fields: ["id", "name", "default_code"], limit: 10 },
          });
          results = odoo || [];
        }

        const resDiv = document.getElementById("addLineResults");
        if (!results?.length) { resDiv.style.display = "none"; return; }
        resDiv.style.display = "";
        let _focusIdx = -1;
        // جلب الكمية المتوفرة
        const productIds = results.map(p => p.id).filter(Boolean);
        let stockMap = {};
        try {
          stockMap = await rpcController.getProductStock(baseUrl, productIds);
        } catch(_) {}

        resDiv.innerHTML = results.map(p =>
         `<div class="add-line-result" data-id="${p.id}" data-name="${escHtml(p.name)}" data-code="${escHtml(p.default_code||'')}"
            style="padding:7px 10px;font-size:11px;cursor:pointer;color:var(--text,#0F172A);
            border-bottom:1px solid var(--border,#E2E8F0);display:flex;justify-content:space-between;align-items:center"
            onmouseover="this.style.background='${stockMap[p.id]?.free === 0 ? "#fee2e2" : "var(--bg3,#F1F5F9)"}'"
            onmouseout="this.style.background='${stockMap[p.id]?.free === 0 ? "#fef2f2" : ""}'">
            <span>${p.default_code ? `<span style="color:var(--text3,#94A3B8)">[${escHtml(p.default_code)}]</span> ` : ""}${escHtml(p.name)}</span>
           ${(() => { const s = _fmtStock(stockMap[p.id]); return `
            <span style="font-size:10px;font-weight:700;white-space:nowrap;margin-left:8px;color:${s.color}">
              ${s.text}
            </span>`; })()}
          </div>`
        ).join("");
		const _getItems = () => [...resDiv.querySelectorAll(".add-line-result")];
        const _searchEl = document.getElementById("addLineSearch");
        if (_searchEl) _searchEl.onkeydown = e => {
          const items = _getItems();
          if (!items.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); _focusIdx = Math.min(_focusIdx+1, items.length-1); items.forEach((el,i) => el.style.background = i===_focusIdx?"var(--bg3,#F1F5F9)":""); }
          else if (e.key === "ArrowUp") { e.preventDefault(); _focusIdx = Math.max(_focusIdx-1, 0); items.forEach((el,i) => el.style.background = i===_focusIdx?"var(--bg3,#F1F5F9)":""); }
          else if (e.key === "Enter" && _focusIdx >= 0) { e.preventDefault(); items[_focusIdx]?.click(); }
          else if (e.key === "Escape") { resDiv.style.display = "none"; _focusIdx = -1; }
        };

        resDiv.querySelectorAll(".add-line-result").forEach(el => {
          el.addEventListener("click", async () => {
            const pid  = parseInt(el.dataset.id);
            const name = el.dataset.name;
            resDiv.style.display = "none";
            document.getElementById("addLineSearch").value = name;

            // جلب packaging
            const pkgs = await _rpc_call(baseUrl, {
              model: "product.packaging", method: "search_read",
              args: [[["product_id", "=", pid]]],
              kwargs: { fields: ["id", "qty"], limit: 1 },
            });
            selectedProduct = { id: pid, name, _qpb: pkgs?.[0]?.qty || null, _pkgId: pkgs?.[0]?.id || false };

            document.getElementById("addLineSelected").style.display = "";
            document.getElementById("addLineSelected").textContent   = name;
            const saveBtn = document.getElementById("addLineSave");
            saveBtn.disabled = false;
            saveBtn.style.background   = "var(--accent,#3B82F6)";
            saveBtn.style.cursor       = "pointer";
          });
        });
      } catch(_) {}
    }, 350);
  });

  document.getElementById("addLineSave")?.addEventListener("click", async () => {
    if (!selectedProduct) return;
    const qty    = parseFloat(document.getElementById("addLineQty").value) || 0;
    const cdn    = parseFloat(document.getElementById("addLineCdn").value) || 0;
    const saveBtn = document.getElementById("addLineSave");
    saveBtn.disabled = true; saveBtn.style.opacity = "0.6";
    try {
      await rpcController.addBLLine(baseUrl, bl.id, selectedProduct.id, qty, cdn, selectedProduct._pkgId);
      addNotif(`Article ajouté ✓`, "success");
      overlay.remove();
      _showBLDetails(bl, baseUrl);
    } catch(e) {
      addNotif("Erreur: " + e.message, "error");
      saveBtn.disabled = false; saveBtn.style.opacity = "1";
    }
  });
}
async function _showBLDetails(bl, baseUrl, bls) {
  document.getElementById("blDetailsOverlay")?.remove();
  const partner = Array.isArray(bl.partner_id) ? bl.partner_id[1]
    : (bl.partner_shipping_id?.name || bl.partner_shipping_id?.[1] || "—");
  const partnerId = Array.isArray(bl.partner_id) ? bl.partner_id[0]
    : (bl.partner_shipping_id?.id || (Array.isArray(bl.partner_shipping_id) ? bl.partner_shipping_id[0] : null));

  const overlay = document.createElement("div");
  overlay.id = "blDetailsOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.45);padding:16px;
  `;
  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:480px;max-height:80vh;
      display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.18);overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;
        padding:12px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div>
          <div style="font-size:12px;font-weight:700;color:var(--accent,#3B82F6)">${escHtml(bl.name)}</div>
          <div style="font-size:11px;color:var(--text2,#475569);margin-top:2px">${escHtml(partner)}${_clientLinkIconHtml(partnerId, null)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <button id="blDetailsOpenOdoo" title="Ouvrir dans Odoo"
            style="background:none;border:1px solid var(--border,#E2E8F0);color:var(--text2,#475569);
            cursor:pointer;padding:4px 8px;border-radius:6px;display:flex;align-items:center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </button>
${bl.show_mark_as_todo ? `
          <button id="blDetailsMarkTodo" title="Marquer à faire"
            style="background:none;border:1px solid #FED7AA;color:#F59E0B;
            cursor:pointer;padding:4px 8px;border-radius:6px;display:flex;align-items:center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <polyline points="9 11 12 14 22 4"/>
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
            </svg>
          </button>` : ""}
          ${bl.show_check_availability ? `
          <button id="blDetailsCheckAvail" title="Vérifier la disponibilité"
            style="background:none;border:1px solid #BBF7D0;color:#15803d;
            cursor:pointer;padding:4px 8px;border-radius:6px;display:flex;align-items:center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </button>` : ""}
          ${(bl.state !== "done" && bl.state !== "cancel") ? `
          <button id="blDetailsAddLine" title="Ajouter un article"
            style="background:none;border:1px solid #BFDBFE;color:#2563EB;
            cursor:pointer;padding:4px 8px;border-radius:6px;display:none;align-items:center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
          <button id="blDetailsEditToggle" title="Modifier"
            style="background:none;border:1px solid var(--border,#E2E8F0);color:var(--text2,#475569);
            cursor:pointer;padding:4px 8px;border-radius:6px;display:flex;align-items:center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>` : ""}
          <button id="blDetailsClose" style="background:none;border:none;color:var(--text3,#94A3B8);
            cursor:pointer;font-size:18px;padding:2px 6px;border-radius:4px"
            onmouseover="this.style.background='var(--bg3,#F1F5F9)'"
            onmouseout="this.style.background='none'">×</button>
        </div>
      </div>
      <div id="blDetailsBody" style="overflow-y:auto;flex:1;padding:12px 14px;background:var(--bg,#F8FAFC)">
        <div style="text-align:center;padding:28px;color:var(--text3,#94A3B8)">
          <div class="spinner"></div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
 document.getElementById("blDetailsClose")?.addEventListener("click", () => overlay.remove());
 document.getElementById("blDetailsOpenOdoo")?.addEventListener("click", () => {
   const base = getOdooBase ? getOdooBase() : baseUrl;
   if (!base) return;
   const url = `${base}/web#id=${bl.id}&action=547&active_id=${bl.id}&model=stock.picking&view_type=form&cids=1&menu_id=336`;
   window.open(url, "_blank");
 });
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  // ── Marquer à faire ──
  document.getElementById("blDetailsMarkTodo")?.addEventListener("click", async () => {
    const btn = document.getElementById("blDetailsMarkTodo");
    btn.style.opacity = "0.5";
    btn.style.pointerEvents = "none";
    try {
      await _rpc_call("", {
        model: "stock.picking", method: "action_confirm",
        args: [[bl.id]], kwargs: {},
      });
      // تحقق من الحالة الفعلية بعد العملية
      const updated = await _rpc_call("", {
        model: "stock.picking", method: "read",
        args: [[bl.id], ["state", "show_mark_as_todo", "show_check_availability"]],
        kwargs: {},
      });
      if (updated?.[0]) {
        bl.state = updated[0].state;
        bl.show_mark_as_todo = updated[0].show_mark_as_todo;
        bl.show_check_availability = updated[0].show_check_availability;
        // تحديث في bls array
        if (bls) {
          const i = bls.findIndex(b => b.id === bl.id);
          if (i >= 0) Object.assign(bls[i], bl);
        }
      }
      addNotif("Marqué à faire ✓", "success");
      if (bls) window._currentBLs ? _applyBLFilters(window._currentBLs, baseUrl) : _renderBLListBody(bls, baseUrl);
      _showBLDetails(bl, baseUrl, bls);
    } catch(e) {
      addNotif("Erreur: " + e.message, "error");
      btn.style.opacity = "1";
      btn.style.pointerEvents = "";
    }
  });

  // ── Vérifier disponibilité ──
 document.getElementById("blDetailsCheckAvail")?.addEventListener("click", async () => {
    const btn = document.getElementById("blDetailsCheckAvail");
    btn.style.opacity = "0.5";
    btn.style.pointerEvents = "none";
    try {
      await rpcController.checkAvailability(baseUrl, bl.id);
      // تحقق من الحالة الفعلية بعد العملية
      const updated = await _rpc_call("", {
        model: "stock.picking", method: "read",
        args: [[bl.id], ["state", "show_mark_as_todo", "show_check_availability"]],
        kwargs: {},
      });
      if (updated?.[0]) {
        bl.state = updated[0].state;
        bl.show_mark_as_todo = updated[0].show_mark_as_todo;
        bl.show_check_availability = updated[0].show_check_availability;
      }
      addNotif("Disponibilité vérifiée ✓", "success");
      if (bls) window._currentBLs ? _applyBLFilters(window._currentBLs, baseUrl) : _renderBLListBody(bls, baseUrl);
      _showBLDetails(bl, baseUrl, bls);
    } catch(e) {
      addNotif("Erreur: " + e.message, "error");
      btn.style.opacity = "1";
      btn.style.pointerEvents = "";
    }
  });

  // ── Ajouter un article ──
  document.getElementById("blDetailsAddLine")?.addEventListener("click", () => {
    _showAddBLLineModal(bl, baseUrl);
  });

  const body = document.getElementById("blDetailsBody");
  let lines = [];
  try {
    lines = await rpcController.fetchBLLines(baseUrl, bl.id);
  } catch(e) {
    body.innerHTML = `<div style="color:#ef4444;text-align:center;padding:20px;font-size:12px">Erreur: ${escHtml(e.message)}</div>`;
    return;
  }

  if (!lines.length) {
    body.innerHTML = `<div style="text-align:center;color:var(--text3,#94A3B8);padding:24px;font-size:12px">Aucune ligne trouvée</div>`;
    return;
  }

  const productCount = {};
  lines.forEach(l => {
    const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
    productCount[pid] = (productCount[pid] || 0) + 1;
  });

  const totalQty = lines.reduce((s, l) => s + (l.product_uom_qty || 0), 0);
  const totalST  = lines.reduce((s, l) => s + (l._price_subtotal || 0), 0);

  body.innerHTML = `
    <div style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:11px;color:var(--text3,#94A3B8)">${lines.length} article(s)</span>
      <span style="font-size:11px;font-weight:700;color:var(--text,#0F172A)">Qté: ${totalQty} · ${totalST.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} DA</span>
    </div>
    ${lines.map((l, idx) => {
      const pid     = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
      const product = Array.isArray(l.product_id) ? l.product_id[1] : "—";
      const isDup   = productCount[pid] > 1;
      const uom     = Array.isArray(l.product_uom) ? l.product_uom[1] : "";
      const cdn        = l.packaging_quantity ?? 0;
      const qty        = l.product_uom_qty ?? 0;
      const qtyPerBox  = l._qty_per_box ?? null;
      const sousTotal = typeof l._price_subtotal === "number"
        ? l._price_subtotal.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ")
        : "—";
      return `
        <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
          border-radius:8px;padding:10px 12px;margin-bottom:6px;
          display:flex;align-items:center;justify-content:space-between;gap:10px">
          <span style="font-size:11px;color:${isDup?"#3B82F6":"var(--text,#0F172A)"};flex:1;line-height:1.4;font-weight:${isDup?"700":"400"}">${escHtml(productLabel(product))}</span>
          <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
            <span class="bl-cdn-view" style="font-size:11px;color:var(--text2,#475569)">${cdn ? `${cdn} CDN` : ""}</span>
            <input class="bl-cdn-edit" data-idx="${idx}" type="number" min="0" step="1" value="${cdn}" data-qpb="${qtyPerBox ?? 0}"
              style="display:none;width:58px;padding:3px 6px;border:1px solid var(--border,#E2E8F0);
              border-radius:5px;font-size:11px;background:var(--bg3,#F1F5F9);color:var(--text,#0F172A);outline:none"/>
            <span class="bl-qty-view" style="font-size:11px;font-weight:600;color:var(--text,#0F172A)">${qty} <span style="font-weight:400;color:var(--text3,#94A3B8)">${escHtml(uom)}</span></span>
            <input class="bl-qty-edit" data-idx="${idx}" type="number" min="0" step="0.001" value="${qty}"
              style="display:none;width:68px;padding:3px 6px;border:1px solid var(--border,#E2E8F0);
              border-radius:5px;font-size:11px;background:var(--bg3,#F1F5F9);color:var(--text,#0F172A);outline:none"/>
            <span class="bl-st-view" style="font-size:12px;font-weight:700;color:var(--accent,#3B82F6)">${sousTotal}</span>
          </div>
        </div>`;
    }).join("")}
  `;

  let _editMode = false;

  // إذا تم تعديل qty، cdn يصبح 0
body.querySelectorAll(".bl-qty-edit").forEach(inp => {
    inp.addEventListener("input", () => {
      const idx    = inp.dataset.idx;
      const cdnInp = body.querySelector(`.bl-cdn-edit[data-idx="${idx}"]`);
      if (cdnInp) cdnInp.value = 0;
    });
  });

  body.querySelectorAll(".bl-cdn-edit").forEach(inp => {
    inp.addEventListener("input", () => {
      const idx      = inp.dataset.idx;
      const qpb      = parseFloat(inp.dataset.qpb) || 0;
      const newCdn   = parseFloat(inp.value) || 0;
      const qtyInp   = body.querySelector(`.bl-qty-edit[data-idx="${idx}"]`);
      if (qtyInp && qpb > 0) qtyInp.value = newCdn * qpb;
    });
  });

  document.getElementById("blDetailsEditToggle")?.addEventListener("click", () => {
    _editMode = !_editMode;
    const btn = document.getElementById("blDetailsEditToggle");

    if (_editMode) {
      // إظهار زر إضافة سلعة
      const addLineBtn = document.getElementById("blDetailsAddLine");
      if (addLineBtn) addLineBtn.style.display = "flex";
      // أيقونة حفظ + إلغاء
      btn.style.display = "none";
      const actionsDiv = btn.parentElement;
      actionsDiv.insertAdjacentHTML("afterbegin", `
        <button id="blEditCancel" title="Annuler"
          style="background:none;border:1px solid #FECACA;color:#DC2626;
          cursor:pointer;padding:4px 8px;border-radius:6px;display:flex;align-items:center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
        <button id="blEditSave" title="Enregistrer"
          style="background:none;border:1px solid #BBF7D0;color:#15803d;
          cursor:pointer;padding:4px 8px;border-radius:6px;display:flex;align-items:center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </button>
      `);
      // إظهار inputs
      body.querySelectorAll(".bl-cdn-view,.bl-qty-view,.bl-st-view").forEach(el => el.style.display = "none");
      body.querySelectorAll(".bl-cdn-edit,.bl-qty-edit").forEach(el => el.style.display = "");

      // إلغاء
      document.getElementById("blEditCancel")?.addEventListener("click", () => {
        _showBLDetails(bl, baseUrl, bls);
      });

      // حفظ
      document.getElementById("blEditSave")?.addEventListener("click", async () => {
        const saveBtn = document.getElementById("blEditSave");
        const cancelBtn = document.getElementById("blEditCancel");
        saveBtn.disabled = true; cancelBtn.disabled = true;
        saveBtn.style.opacity = "0.5";

        let errors = 0;
        for (let idx = 0; idx < lines.length; idx++) {
          const qtyInp = body.querySelector(`.bl-qty-edit[data-idx="${idx}"]`);
          const cdnInp = body.querySelector(`.bl-cdn-edit[data-idx="${idx}"]`);
          if (!qtyInp || !cdnInp) continue;
          const newQty = parseFloat(qtyInp.value) || 0;
          const newCdn = parseFloat(cdnInp.value) || 0;
          if (newQty === lines[idx].product_uom_qty && newCdn === (lines[idx].packaging_quantity ?? 0)) continue;
          try {
            await _rpc_call(baseUrl, {
              model: "stock.move", method: "write",
              args: [[lines[idx].id], { product_uom_qty: newQty, packaging_quantity: newCdn }],
              kwargs: {},
            });
            lines[idx].product_uom_qty    = newQty;
            lines[idx].packaging_quantity = newCdn;
          } catch(e) {
            errors++;
            addNotif(`Erreur ligne ${idx+1}: ${e.message}`, "error");
          }
        }
        if (!errors) addNotif("Modifications enregistrées ✓", "success");
        _showBLDetails(bl, baseUrl, bls);
      });
    }
  });
}

function _showBLStateConfirm(bl, toState, bls, baseUrl) {
  document.getElementById("blConfirmOverlay")?.remove();
  const partner     = Array.isArray(bl.partner_id) ? bl.partner_id[1] : "—";
  const stateNames  = { scheduled: "Planifié", delayed: "Reporté", canceled: "Annulé" };
  const targetLabel = stateNames[toState] || toState;
  const needRestore = bl.state === "cancel" && toState !== "canceled";

  const confirm = document.createElement("div");
  confirm.id = "blConfirmOverlay";
  confirm.style.cssText = `
    position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.4);padding:16px;
  `;
  confirm.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:340px;padding:20px;
      box-shadow:0 8px 32px rgba(0,0,0,.15)">
      <div style="font-size:13px;font-weight:700;color:var(--text,#0F172A);margin-bottom:8px">
        Confirmer le changement
      </div>
      <div style="font-size:11px;color:var(--text2,#475569);margin-bottom:${needRestore?12:16}px;line-height:1.6">
        Passer le BL <b>${escHtml(bl.name)}</b><br>
        (${escHtml(partner)})<br>
        vers l'état: <b>${targetLabel}</b> ?
      </div>
      ${needRestore ? `
      <div style="font-size:10px;color:#F59E0B;background:#FFF7ED;border:1px solid #FED7AA;
        border-radius:6px;padding:7px 10px;margin-bottom:12px">
        ⚠️ Ce BL est annulé — il sera restauré automatiquement.
      </div>` : ""}
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="blConfirmNo"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
          color:var(--text2,#475569);cursor:pointer">Non</button>
        <button id="blConfirmYes"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:none;background:var(--accent,#3B82F6);color:#fff;cursor:pointer">
          Confirmer</button>
      </div>
    </div>
  `;

  document.body.appendChild(confirm);
  document.getElementById("blConfirmNo")?.addEventListener("click", () => confirm.remove());
  confirm.addEventListener("click", e => { if (e.target === confirm) confirm.remove(); });

  document.getElementById("blConfirmYes")?.addEventListener("click", async () => {
    confirm.remove();
    try {
if (needRestore) {
        await rpcController.restoreBL(baseUrl, bl.id);
        bl.state = "assigned";
      }
      if (toState === "canceled" && bl.state !== "cancel") {
        await _rpc_call(baseUrl, {
          model: "stock.picking", method: "action_cancel",
          args: [[bl.id]],
          kwargs: {},
        });
        bl.state = "cancel";
      }
      const fields = { planning_state: toState };
      if (toState === "delayed") {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        fields.delayed_date = tomorrow.toISOString().slice(0, 10) + " 00:00:00";
      }
      if (toState === "scheduled") {
        await rpcController.resetDelayedBL(baseUrl, bl.id);
      } else {
        await _rpc_call(baseUrl, {
          model: "stock.picking", method: "write",
          args: [[bl.id], fields],
          kwargs: {},
        });
      }
      bl.planning_state = toState;
      // تحديث show_mark_as_todo و show_check_availability
      try {
        const updated = await _rpc_call("", {
          model: "stock.picking", method: "read",
          args: [[bl.id], ["state", "show_mark_as_todo", "show_check_availability"]],
          kwargs: {},
        });
        if (updated?.[0]) {
          bl.state = updated[0].state;
          bl.show_mark_as_todo = updated[0].show_mark_as_todo;
          bl.show_check_availability = updated[0].show_check_availability;
          if (bls) {
            const i = bls.findIndex(b => b.id === bl.id);
            if (i >= 0) Object.assign(bls[i], bl);
          }
        }
      } catch(_) {}
      addNotif(`BL ${bl.name} → ${targetLabel}`, "success");
      window._currentBLs ? _applyBLFilters(window._currentBLs, baseUrl) : _renderBLListBody(bls, baseUrl);
    } catch(e) {
      addNotif("Erreur: " + e.message, "error");
    }
  });
}

function _showBLCancelConfirm(bl, bls, baseUrl) {
  document.getElementById("blConfirmOverlay")?.remove();
  const partner = Array.isArray(bl.partner_id) ? bl.partner_id[1] : "—";

  const confirm = document.createElement("div");
  confirm.id = "blConfirmOverlay";
  confirm.style.cssText = `
    position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.4);padding:16px;
  `;
  confirm.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:340px;padding:20px;
      box-shadow:0 8px 32px rgba(0,0,0,.15)">
      <div style="font-size:13px;font-weight:700;color:var(--text,#0F172A);margin-bottom:8px">
        Confirmer l'annulation
      </div>
      <div style="font-size:11px;color:var(--text2,#475569);margin-bottom:16px;line-height:1.5">
        Voulez-vous annuler le BL <b>${escHtml(bl.name)}</b> pour <b>${escHtml(partner)}</b> ?
        <br>Cette action est irréversible.
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="blConfirmNo"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
          color:var(--text2,#475569);cursor:pointer">Non</button>
        <button id="blConfirmYes"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:none;background:#DC2626;color:#fff;cursor:pointer">
          Oui, annuler</button>
      </div>
    </div>
  `;

  document.body.appendChild(confirm);
  document.getElementById("blConfirmNo")?.addEventListener("click", () => confirm.remove());
  confirm.addEventListener("click", e => { if (e.target === confirm) confirm.remove(); });

  document.getElementById("blConfirmYes")?.addEventListener("click", async () => {
    confirm.remove();
    try {
      await rpcController.cancelBL(baseUrl, bl.id);
      bl.state = "cancel";
      addNotif(`BL annulé: ${bl.name}`, "success");
      window._currentBLs ? _applyBLFilters(window._currentBLs, baseUrl) : _renderBLListBody(bls, baseUrl);
    } catch(e) {
      addNotif("Erreur: " + e.message, "error");
    }
  });
}
function _showBLBulkConfirm(selectedBls, action, bls, baseUrl) {
  document.getElementById("blBulkConfirmOverlay")?.remove();

  const actionLabels = {
    scheduled: { label: "Planifié",    color: "#8B5CF6", bg: "#F3E8FF" },
    delayed:   { label: "Reporté",     color: "#F59E0B", bg: "#FFF7ED" },
    canceled:  { label: "Annulé",      color: "#6B7280", bg: "var(--bg3,#F1F5F9)" },
    unlink:    { label: "Désaffecter", color: "#DC2626", bg: "#FEF2F2" },
  };
  const cfg = actionLabels[action] || { label: action, color: "#3B82F6", bg: "#EFF6FF" };

  const overlay = document.createElement("div");
  overlay.id = "blBulkConfirmOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.5);padding:16px;
  `;

  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:360px;padding:20px;
      box-shadow:0 8px 32px rgba(0,0,0,.2)">
      <div style="font-size:13px;font-weight:700;color:var(--text,#0F172A);margin-bottom:8px">
        Confirmer l'action groupée
      </div>
      <div style="font-size:11px;color:var(--text2,#475569);margin-bottom:12px;line-height:1.6">
        Appliquer <span style="font-weight:700;color:${cfg.color}">${cfg.label}</span>
        sur <span style="font-weight:700">${selectedBls.length} BL(s)</span> ?
      </div>
      <div style="max-height:130px;overflow-y:auto;margin-bottom:14px;
        background:var(--bg3,#F1F5F9);border-radius:6px;padding:8px 10px;
        display:flex;flex-direction:column;gap:3px">
        ${selectedBls.map(bl => {
          const partner = Array.isArray(bl.partner_id) ? bl.partner_id[1] : "—";
          return `<div style="font-size:10px;color:var(--text2,#475569)">
            <span style="font-weight:600;color:var(--accent,#3B82F6)">${escHtml(bl.name)}</span>
            — ${escHtml(partner)}
          </div>`;
        }).join("")}
      </div>
      <div id="blBulkProgress" style="display:none;margin-bottom:12px;text-align:center">
        <svg viewBox="0 0 64 64" width="72" height="72" style="display:block;margin:0 auto 6px">
          <circle cx="32" cy="32" r="28" fill="none" stroke="var(--border,#E2E8F0)" stroke-width="6"/>
          <circle id="blBulkCircle" cx="32" cy="32" r="28" fill="none"
            stroke="${cfg.color}" stroke-width="6"
            stroke-linecap="round"
            stroke-dasharray="175.93"
            stroke-dashoffset="175.93"
            transform="rotate(-90 32 32)"
            style="transition:stroke-dashoffset 0.4s cubic-bezier(0.4,0,0.2,1)"/>
        </svg>
        <span id="blBulkProgressPct" style="font-size:13px;font-weight:700;color:${cfg.color}">0%</span>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="blBulkNo"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
          color:var(--text2,#475569);cursor:pointer">Annuler</button>
        <button id="blBulkYes"
          style="font-size:11px;font-weight:600;padding:6px 16px;border-radius:6px;
          border:none;background:${cfg.color};color:#fff;cursor:pointer">
          Confirmer</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  document.getElementById("blBulkNo")?.addEventListener("click", () => overlay.remove());

  document.getElementById("blBulkYes")?.addEventListener("click", async () => {
    const btnNo  = document.getElementById("blBulkNo");
    const btnYes = document.getElementById("blBulkYes");
    const progressBox = document.getElementById("blBulkProgress");

    btnNo.disabled  = true;
    btnYes.disabled = true;
    btnYes.style.opacity = "0.6";
    progressBox.style.display = "";

    // blur the modal content
    const modalCard = progressBox.closest("div[style*='border-radius:10px']");
    if (modalCard) modalCard.style.filter = "blur(2px)";
    progressBox.style.filter = "none";
    progressBox.style.position = "relative";
    progressBox.style.zIndex = "1";

    let done = 0; let errors = 0;
    const total = selectedBls.length;

    const _setCircle = (pct) => {
      const circle = document.getElementById("blBulkCircle");
      const label  = document.getElementById("blBulkProgressPct");
      const circumference = 175.93;
      if (circle) circle.style.strokeDashoffset = circumference * (1 - pct / 100);
      if (label)  label.textContent = `${Math.round(pct)}%`;
    };

    for (const bl of selectedBls) {
      try {
        const permKey = "card.showBLs." + action;
        if (action === "unlink") {
          await rpcController.unlinkBLDelivery(baseUrl, bl.id);
          bl.delivery_planning_id = false;
          bl.delivery_user_id     = false;
        } else {
          const needRestore = bl.state === "cancel" && action !== "canceled";
          if (needRestore) await rpcController.restoreBL(baseUrl, bl.id, permKey);
          if (action === "canceled" && bl.state !== "cancel") {
            await _rpc_call(baseUrl, {
              model: "stock.picking", method: "action_cancel",
              args: [[bl.id]], kwargs: {},
            }, permKey);
            bl.state = "cancel";
          }
          const fields = { planning_state: action };
          if (action === "delayed") {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            fields.delayed_date = tomorrow.toISOString().slice(0, 10) + " 00:00:00";
          }
          await _rpc_call(baseUrl, {
            model: "stock.picking", method: "write",
            args: [[bl.id], fields], kwargs: {},
          }, permKey);
          bl.planning_state = action;
        }
      done++;
      } catch(e) {
        errors++;
        addNotif(`Erreur ${bl.name}: ${e.message}`, "error");
      }
      _setCircle(((done + errors) / total) * 100);
      await new Promise(r => setTimeout(r, 30));
    }

    if (modalCard) modalCard.style.filter = "none";
    const pctLabel = document.getElementById("blBulkProgressPct");
    if (pctLabel) pctLabel.textContent = errors > 0 ? `${done}✓ ${errors}✗` : "✓";

    addNotif(`Groupé: ${done} BL(s) → ${cfg.label}${errors ? `, ${errors} erreur(s)` : ""}`, errors ? "warning" : "success");

    btnNo.disabled = false;
    btnNo.textContent = "Fermer";
    btnYes.style.display = "none";

    window._currentBLs ? _applyBLFilters(window._currentBLs, baseUrl) : _renderBLListBody(bls, baseUrl);
  });
}
function _showPayBulkConfirm(selectedPayments, action, payments, baseUrl) {
  document.getElementById("payBulkConfirmOverlay")?.remove();

  const actionLabels = {
    draft:  { label: "Brouillon", color: "#3B82F6", bg: "#EFF6FF" },
    post:   { label: "Confirmer", color: "#15803d", bg: "#F0FDF4" },
    cancel: { label: "Annuler",   color: "#6B7280", bg: "var(--bg3,#F1F5F9)" },
  };
  const cfg = actionLabels[action] || { label: action, color: "#3B82F6", bg: "#EFF6FF" };

  const overlay = document.createElement("div");
  overlay.id = "payBulkConfirmOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.5);padding:16px;
  `;

  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:360px;padding:20px;
      box-shadow:0 8px 32px rgba(0,0,0,.2)">
      <div style="font-size:13px;font-weight:700;color:var(--text,#0F172A);margin-bottom:8px">
        Confirmer l'action groupée
      </div>
<div style="font-size:11px;color:var(--text2,#475569);margin-bottom:14px;line-height:1.6">
        Appliquer <span style="font-weight:700;color:` + cfg.color + `">` + cfg.label + `</span>
        sur <span style="font-weight:700">` + selectedPayments.length + ` paiement(s)</span> ?
      </div>
      <div id="payBulkProgress" style="display:none;margin-bottom:12px;text-align:center">
        <svg viewBox="0 0 64 64" width="72" height="72" style="display:block;margin:0 auto 6px">
          <circle cx="32" cy="32" r="28" fill="none" stroke="var(--border,#E2E8F0)" stroke-width="6"/>
          <circle id="payBulkCircle" cx="32" cy="32" r="28" fill="none"
            stroke="${cfg.color}" stroke-width="6"
            stroke-linecap="round"
            stroke-dasharray="175.93"
            stroke-dashoffset="175.93"
            transform="rotate(-90 32 32)"
            style="transition:stroke-dashoffset 0.4s cubic-bezier(0.4,0,0.2,1)"/>
        </svg>
        <span id="payBulkProgressPct" style="font-size:13px;font-weight:700;color:${cfg.color}">0%</span>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="payBulkNo"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
          color:var(--text2,#475569);cursor:pointer">Annuler</button>
        <button id="payBulkYes"
          style="font-size:11px;font-weight:600;padding:6px 16px;border-radius:6px;
          border:none;background:${cfg.color};color:#fff;cursor:pointer">
          Confirmer</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  document.getElementById("payBulkNo")?.addEventListener("click", () => overlay.remove());

  document.getElementById("payBulkYes")?.addEventListener("click", async () => {
    const btnNo  = document.getElementById("payBulkNo");
    const btnYes = document.getElementById("payBulkYes");
    const progressBox = document.getElementById("payBulkProgress");

    btnNo.disabled  = true;
    btnYes.disabled = true;
    btnYes.style.opacity = "0.6";
    progressBox.style.display = "";

    const modalCard = overlay.querySelector("div[style*='border-radius:10px']");
    if (modalCard) modalCard.style.filter = "blur(2px)";
    progressBox.style.filter   = "none";
    progressBox.style.position = "relative";
    progressBox.style.zIndex   = "1";

    const methodMap = { draft: "action_draft", post: "post", cancel: "cancel" };
    const method    = methodMap[action];
    const stateMap  = { draft: "draft", post: "posted", cancel: "cancelled" };

    let done = 0; let errors = 0;
    const total = selectedPayments.length;

    const _setCircle = (pct) => {
      const circle = document.getElementById("payBulkCircle");
      const label  = document.getElementById("payBulkProgressPct");
      const circumference = 175.93;
      if (circle) circle.style.strokeDashoffset = circumference * (1 - pct / 100);
      if (label)  label.textContent = `${Math.round(pct)}%`;
    };

    for (const p of selectedPayments) {
      try {
        await _rpc_call(baseUrl, {
          model:  "account.payment",
          method: method,
          args:   [[p.id]],
          kwargs: {},
        }, "card.showPayments." + action);
        p.state = stateMap[action] || p.state;
        done++;
      } catch(e) {
        errors++;
        addNotif(`Erreur paiement ${p.id}: ${e.message}`, "error");
      }
      _setCircle(((done + errors) / total) * 100);
      await new Promise(r => setTimeout(r, 30));
    }

    if (modalCard) modalCard.style.filter = "none";
    const pctLabel = document.getElementById("payBulkProgressPct");
    if (pctLabel) pctLabel.textContent = errors > 0 ? `${done}✓ ${errors}✗` : "✓";

    addNotif(`Groupé: ${done} paiement(s) → ${cfg.label}${errors ? `, ${errors} erreur(s)` : ""}`, errors ? "warning" : "success");

    btnNo.disabled = false;
    btnNo.textContent = "Fermer";
    btnYes.style.display = "none";

    _renderPayListBody(payments, baseUrl);
  });
}

// ── Bascule groupée du journal (Banque ORN WF ⇄ Caisse Vendeur Oran) ──
// Convertit en une seule fois tous les paiements sélectionnés (non vérifiés)
// vers le journal cible choisi.
function _showPayBulkJournalSwitchConfirm(selectedPayments, payments, baseUrl) {
  document.getElementById("payBulkJournalSwitchOverlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "payBulkJournalSwitchOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.5);padding:16px;
  `;

  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:380px;padding:20px;
      box-shadow:0 8px 32px rgba(0,0,0,.2)">
      <div style="font-size:13px;font-weight:700;color:var(--text,#0F172A);margin-bottom:8px">
        Changer le journal — sélection groupée
      </div>
      <div style="font-size:11px;color:var(--text2,#475569);margin-bottom:12px;line-height:1.6">
        Choisissez le journal cible. Seuls les paiements <b>non vérifiés</b> actuellement
        dans le journal opposé seront convertis.
        <br><span style="color:var(--text3,#94A3B8)">Chaque paiement: Brouillon → changement de journal → Confirmer, traité automatiquement en parallèle.</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
        ${PAY_JOURNAL_SWITCHES.map(cfg => `
          <button class="payBulkJsTarget" data-key="${cfg.key}"
            style="font-size:11px;font-weight:600;padding:8px 12px;border-radius:6px;
            border:1px solid #DDD6FE;background:#F5F3FF;color:#6D28D9;cursor:pointer;
            text-align:left">
            → ${escHtml(cfg.dstLabel)}
          </button>`).join("")}
      </div>
      <div id="payBulkJsProgress" style="display:none;margin-bottom:12px;text-align:center">
        <svg viewBox="0 0 64 64" width="64" height="64" style="display:block;margin:0 auto 6px">
          <circle cx="32" cy="32" r="28" fill="none" stroke="var(--border,#E2E8F0)" stroke-width="6"/>
          <circle id="payBulkJsCircle" cx="32" cy="32" r="28" fill="none"
            stroke="#6D28D9" stroke-width="6" stroke-linecap="round"
            stroke-dasharray="175.93" stroke-dashoffset="175.93"
            transform="rotate(-90 32 32)"
            style="transition:stroke-dashoffset 0.4s cubic-bezier(0.4,0,0.2,1)"/>
        </svg>
        <span id="payBulkJsProgressPct" style="font-size:13px;font-weight:700;color:#6D28D9">0%</span>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="payBulkJsNo"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
          color:var(--text2,#475569);cursor:pointer">Fermer</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  document.getElementById("payBulkJsNo")?.addEventListener("click", () => overlay.remove());

  overlay.querySelectorAll(".payBulkJsTarget").forEach(targetBtn => {
    targetBtn.addEventListener("click", async () => {
      const cfg = PAY_JOURNAL_SWITCHES.find(c => c.key === targetBtn.dataset.key);
      if (!cfg) return;

      const isVerified = p => p.verified_state === true || p.verified_state === "verified";
      const journalOf  = p => Array.isArray(p.journal_id) ? p.journal_id[1] : "";
      const eligible = selectedPayments.filter(p => !isVerified(p) && journalOf(p) === cfg.srcLabel);
      const skipped  = selectedPayments.length - eligible.length;

      if (!eligible.length) {
        addNotif("Aucun paiement éligible (déjà vérifié ou pas dans " + cfg.srcLabel + ")", "warning");
        return;
      }

      overlay.querySelectorAll(".payBulkJsTarget").forEach(b => b.disabled = true);
      document.getElementById("payBulkJsNo").disabled = true;
      const progressBox = document.getElementById("payBulkJsProgress");
      progressBox.style.display = "";

      const _setCircle = (pct) => {
        const circle = document.getElementById("payBulkJsCircle");
        const label  = document.getElementById("payBulkJsProgressPct");
        const circumference = 175.93;
        if (circle) circle.style.strokeDashoffset = circumference * (1 - pct / 100);
        if (label)  label.textContent = `${Math.round(pct)}%`;
      };

      try {
        let finished = 0;
        const total = eligible.length;
        const CONCURRENCY = 4; // paiements traités en parallèle pour accélérer

        const results = await _runPayJournalSwitchBatch(baseUrl, eligible, cfg, CONCURRENCY, () => {
          finished++;
          _setCircle((finished / total) * 100);
        });

        let done = 0, errors = 0;
        results.forEach(r => {
          if (r.ok) { done++; }
          else {
            errors++;
            addNotif(`Erreur paiement ${r.p.id}: ${r.error.message}`, "error");
          }
        });

        addNotif(
          `Groupé: ${done} paiement(s) → ${cfg.dstLabel}` +
          `${errors ? `, ${errors} erreur(s)` : ""}` +
          `${skipped ? `, ${skipped} ignoré(s)` : ""}`,
          errors ? "warning" : "success"
        );
        _renderPayListBody(payments, baseUrl);
        overlay.remove();
      } catch (e) {
        addNotif("Erreur: " + e.message, "error");
        overlay.querySelectorAll(".payBulkJsTarget").forEach(b => b.disabled = false);
        document.getElementById("payBulkJsNo").disabled = false;
        progressBox.style.display = "none";
      }
    });
  });
}
// ── Clients Modal ─────────────────────────────────────────────
async function showClientsModal(vendorId) {
  const baseUrl = App.settings?.baseUrlPayment?.replace(/\/$/, "") || "";
  const roundId = App.allStats[vendorId]?.roundId;
  if (!roundId || !baseUrl) return;

  document.getElementById("clientsListOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "clientsListOverlay";
  overlay.style.cssText = `position:fixed;inset:0;z-index:10000;display:flex;align-items:center;
    justify-content:center;background:rgba(0,0,0,.3);padding:16px;`;

  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:480px;max-height:85vh;
      display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.12);overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;
        padding:12px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:8px">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent,#3B82F6)" stroke-width="2" width="16" height="16">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          <span style="font-size:12px;font-weight:700;color:var(--text,#0F172A)">Clients de la tournée</span>
        </div>
        <button id="clientsListClose" style="background:none;border:none;color:var(--text3,#94A3B8);
          cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;border-radius:4px"
          onmouseover="this.style.background='var(--bg3,#F1F5F9)'"
          onmouseout="this.style.background='none'">×</button>
      </div>
      <div style="padding:6px 14px;border-bottom:1px solid var(--border,#E2E8F0);background:var(--bg2,#fff);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:6px;background:var(--bg3,#F1F5F9);
          border:1px solid var(--border,#E2E8F0);border-radius:6px;padding:4px 8px">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text3,#94A3B8)" stroke-width="2" width="13" height="13">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input id="vcClientsModalSearchInput" type="text" placeholder="Rechercher un client…"
            style="border:none;background:transparent;outline:none;font-size:11px;
            color:var(--text,#0F172A);flex:1;min-width:0"/>
        </div>
      </div>
      <div id="clientsListBody" style="overflow-y:auto;flex:1;padding:8px 0">
        <div style="padding:24px;text-align:center;color:var(--text3,#94A3B8);font-size:12px">
          <div class="spinner-sm" style="margin:0 auto 8px"></div>
          Chargement…
        </div>
      </div>
      <div style="padding:8px 16px;border-top:1px solid var(--border,#E2E8F0);flex-shrink:0;
        display:flex;align-items:center;justify-content:space-between">
        <span id="clientsCount" style="font-size:11px;color:var(--text3,#94A3B8)"></span>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById("clientsListClose").addEventListener("click", () => overlay.remove());

  const searchInput = document.getElementById("vcClientsModalSearchInput");
  const body = document.getElementById("clientsListBody");
  const countEl = document.getElementById("clientsCount");

  let allClients = [];

  const isLiv = App.currentMode === "livraison";

  // شارات التنبيه
  const hasDelayed  = allClients.some(c => c.state === "delayed");
  const hasCanceled = allClients.some(c => c.state === "canceled");
  const alertsHtml  = (isLiv && (hasDelayed || hasCanceled)) ? `
    <div style="display:flex;gap:6px;padding:6px 14px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
      ${hasDelayed  ? `<span style="font-size:11px;font-weight:700;padding:2px 10px;border-radius:10px;
        background:#FFF7ED;border:1px solid #FED7AA;color:#F59E0B;
        animation:hz-blink 1.5s infinite">R</span>` : ""}
      ${hasCanceled ? `<span style="font-size:11px;font-weight:700;padding:2px 10px;border-radius:10px;
        background:#FEF2F2;border:1px solid #FECACA;color:#EF4444;
        animation:hz-blink 1.5s infinite">A</span>` : ""}
    </div>` : "";

  const stateLabel = {
    pending: "À visiter", visited: "Visité",
    success: isLiv ? "Livré" : "Vendu",
    sold:    "Vendu",
    fail:    "Sans vente", absent: "Non visité", delayed: "Reporté", canceled: "Annulé"
  };
  const stateColor = {
    pending: "#94a3b8", visited: "#3b82f6",
    success: "#22c55e", sold: "#8b5cf6",
    fail: "#f59e0b", absent: "#f87171", delayed: "#f59e0b", canceled: "#64748b"
  };

  function renderClientsList(filter = "", stateFilter = null) {
    const tokens = filter.toLowerCase().trim().split(/\s+/).filter(Boolean);
    let filtered = tokens.length
      ? allClients.filter(c => {
          const name = (c.name || "").toLowerCase();
          return tokens.every(t => name.includes(t));
        })
      : allClients;
    if (stateFilter) filtered = filtered.filter(c => c.state === stateFilter);
    countEl.textContent = `${filtered.length} client(s)`;
    if (!filtered.length) {
      body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text3,#94A3B8);font-size:12px">Aucun client trouvé</div>`;
      return;
    }
    body.innerHTML = filtered.map(c => {
      const sc = stateColor[c.state] || "#94a3b8";
      const sl = stateLabel[c.state] || c.state;
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 16px;
        border-bottom:1px solid var(--border,#E2E8F0)">
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:600;color:var(--text,#0F172A);
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.name}${_clientLinkIconHtml(c.id, c.ref)}</div>
        </div>
        <span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;
          background:${sc}22;color:${sc};white-space:nowrap">${sl}</span>
        ${c.visitTime ? `<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;
          background:var(--bg3,#F1F5F9);color:var(--text3,#64748B);white-space:nowrap"> ${c.visitTime}</span>` : ""}
      </div>`;
    }).join("");
  }

  let _activeAlertFilter = null;
  searchInput.addEventListener("input", () => renderClientsList(searchInput.value, _activeAlertFilter));

  try {
    allClients = await rpcController.fetchClients(baseUrl, roundId, App.currentMode);

    // شارات التنبيه
    if (isLiv) {
      const hasDelayed  = allClients.some(c => c.state === "delayed");
      const hasCanceled = allClients.some(c => c.state === "canceled");
      if (hasDelayed || hasCanceled) {
        const alertsDiv = document.createElement("div");
        alertsDiv.style.cssText = "display:flex;gap:6px;padding:6px 14px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0";
        alertsDiv.innerHTML = `
          ${hasDelayed  ? `<button id="clientsAlertDelayed" style="font-size:11px;font-weight:700;padding:2px 10px;border-radius:10px;
            background:#FFF7ED;border:1px solid #FED7AA;color:#F59E0B;cursor:pointer;
            animation:hz-blink 1.5s infinite">Reporté</button>` : ""}
          ${hasCanceled ? `<button id="clientsAlertCanceled" style="font-size:11px;font-weight:700;padding:2px 10px;border-radius:10px;
            background:#FEF2F2;border:1px solid #FECACA;color:#EF4444;cursor:pointer;
            animation:hz-blink 1.5s infinite">Annulé</button>` : ""}`;
        body.parentElement.insertBefore(alertsDiv, body);

        const applyAlertFilter = (state, btn) => {
          if (_activeAlertFilter === state) {
            _activeAlertFilter = null;
            btn.style.animation = "hz-blink 1.5s infinite";
            btn.style.opacity = "1";
          } else {
            activeAlertFilter = state;
            ["clientsAlertDelayed","clientsAlertCanceled"].forEach(id => {
              const el = document.getElementById(id);
              if (el) { el.style.animation = "none"; el.style.opacity = "0.4"; }
            });
            btn.style.animation = "hz-blink 1.5s infinite";
            btn.style.opacity = "1";
          }
          renderClientsList(searchInput.value, activeAlertFilter);
        };

        document.getElementById("clientsAlertDelayed")?.addEventListener("click", function() {
          applyAlertFilter("delayed", this);
        });
        document.getElementById("clientsAlertCanceled")?.addEventListener("click", function() {
          applyAlertFilter("canceled", this);
        });
      }
    }

    renderClientsList();
  } catch (err) {
    console.error("showClientsModal error:", err);
    body.innerHTML = `<div style="padding:24px;text-align:center;color:#f87171;font-size:12px">Erreur de chargement</div>`;
  }
}

// ── Clients Modal WM (multi-window) ───────────────────────────
async function showClientsModalWM(vendorId) {
  const baseUrl = App.settings?.baseUrlPayment?.replace(/\/$/, "") || "";
  const roundId = App.allStats[vendorId]?.roundId;
  if (!roundId || !baseUrl) return;
  const lbl = (App.settings?.vendors || []).find(v => String(v.id) === String(vendorId))?.label || String(vendorId);
  const SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="var(--accent,#3B82F6)" stroke-width="2" width="15" height="15">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
  const win = _wmCreateWindow("clients", vendorId, `Clients — ${lbl}`, SVG, "480px");
  if (!win) return;
  const { body } = win;
  body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text3,#94A3B8);
    font-size:12px;display:flex;align-items:center;justify-content:center;gap:8px">
    <div class="spinner-sm"></div>Chargement…</div>`;

  const isLiv = App.currentMode === "livraison";

  const stateLabel = {
    pending: "À visiter", visited: "Visité",
    success: isLiv ? "Livré" : "Vendu",
    sold:    "Vendu",
    fail:    "Sans vente", absent: "Non visité", delayed: "Reporté", canceled: "Annulé"
  };
  const stateColor = {
    pending: "#94a3b8", visited: "#3b82f6",
    success: "#22c55e", sold: "#8b5cf6",
    fail: "#f59e0b", absent: "#f87171", delayed: "#f59e0b", canceled: "#64748b"
  };

  try {
    const clients = await rpcController.fetchClients(baseUrl, roundId, App.currentMode);
    if (!clients?.length) {
      body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text3,#94A3B8);font-size:12px">Aucun client</div>`;
      return;
    }

    // Build scoped container with search + list
    body.innerHTML = `
      <div style="padding:6px 14px;border-bottom:1px solid var(--border,#E2E8F0);background:var(--bg2,#fff);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:6px;background:var(--bg3,#F1F5F9);
          border:1px solid var(--border,#E2E8F0);border-radius:6px;padding:4px 8px">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text3,#94A3B8)" stroke-width="2" width="13" height="13">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input id="wm-clients-search-${vendorId}" type="text" placeholder="Rechercher un client…"
            style="border:none;background:transparent;outline:none;font-size:11px;
            color:var(--text,#0F172A);flex:1;min-width:0"/>
        </div>
      </div>
      <div id="wm-clients-alerts-${vendorId}"></div>
      <div id="wm-clients-list-${vendorId}" style="overflow-y:auto;flex:1;padding:8px 0"></div>
      <div style="padding:8px 16px;border-top:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <span id="wm-clients-count-${vendorId}" style="font-size:11px;color:var(--text3,#94A3B8)"></span>
      </div>`;

    const listDiv   = body.querySelector(`#wm-clients-list-${vendorId}`);
    const countDiv  = body.querySelector(`#wm-clients-count-${vendorId}`);
    const searchEl  = body.querySelector(`#wm-clients-search-${vendorId}`);
    const alertsDiv = body.querySelector(`#wm-clients-alerts-${vendorId}`);

    let _activeFilter = null;

    const renderList = (q = "", stateFilter = null) => {
      const tokens = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
      let filtered = tokens.length
        ? clients.filter(c => {
            const name = (c.name || "").toLowerCase();
            return tokens.every(t => name.includes(t));
          })
        : clients;
      if (stateFilter) filtered = filtered.filter(c => c.state === stateFilter);
      countDiv.textContent = `${filtered.length} client(s)`;
      if (!filtered.length) {
        listDiv.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text3,#94A3B8);font-size:12px">Aucun client trouvé</div>`;
        return;
      }
      listDiv.innerHTML = filtered.map(c => {
        const sc = stateColor[c.state] || "#94a3b8";
        const sl = stateLabel[c.state] || c.state;
        return `<div style="display:flex;align-items:center;gap:10px;padding:8px 16px;
          border-bottom:1px solid var(--border,#E2E8F0)">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:600;color:var(--text,#0F172A);
              white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(c.name||"")}${_clientLinkIconHtml(c.id, c.ref)}</div>
          </div>
          <span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;
            background:${sc}22;color:${sc};white-space:nowrap">${sl}</span>
          ${c.visitTime ? `<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;
            background:var(--bg3,#F1F5F9);color:var(--text3,#64748B);white-space:nowrap"> ${c.visitTime}</span>` : ""}
        </div>`;
      }).join("");
    };

    searchEl.addEventListener("input", () => renderList(searchEl.value, _activeFilter));

    // Alert badges (livraison mode)
    if (isLiv) {
      const hasDelayed  = clients.some(c => c.state === "delayed");
      const hasCanceled = clients.some(c => c.state === "canceled");
      if (hasDelayed || hasCanceled) {
        alertsDiv.style.cssText = "display:flex;gap:6px;padding:6px 14px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0";
        alertsDiv.innerHTML = `
          ${hasDelayed  ? `<button id="wm-alert-delayed-${vendorId}" style="font-size:11px;font-weight:700;padding:2px 10px;border-radius:10px;
            background:#FFF7ED;border:1px solid #FED7AA;color:#F59E0B;cursor:pointer;
            animation:hz-blink 1.5s infinite">Reporté</button>` : ""}
          ${hasCanceled ? `<button id="wm-alert-canceled-${vendorId}" style="font-size:11px;font-weight:700;padding:2px 10px;border-radius:10px;
            background:#FEF2F2;border:1px solid #FECACA;color:#EF4444;cursor:pointer;
            animation:hz-blink 1.5s infinite">Annulé</button>` : ""}`;

        const applyFilter = (state, btn) => {
          if (_activeFilter === state) {
            _activeFilter = null;
            [hasDelayed && `wm-alert-delayed-${vendorId}`, hasCanceled && `wm-alert-canceled-${vendorId}`].filter(Boolean).forEach(id => {
              const el = body.querySelector(`#${id}`);
              if (el) { el.style.animation = "hz-blink 1.5s infinite"; el.style.opacity = "1"; }
            });
          } else {
            _activeFilter = state;
            [hasDelayed && `wm-alert-delayed-${vendorId}`, hasCanceled && `wm-alert-canceled-${vendorId}`].filter(Boolean).forEach(id => {
              const el = body.querySelector(`#${id}`);
              if (el) { el.style.animation = "none"; el.style.opacity = "0.4"; }
            });
            btn.style.animation = "hz-blink 1.5s infinite";
            btn.style.opacity = "1";
          }
          renderList(searchEl.value, _activeFilter);
        };

        body.querySelector(`#wm-alert-delayed-${vendorId}`)?.addEventListener("click", function() { applyFilter("delayed", this); });
        body.querySelector(`#wm-alert-canceled-${vendorId}`)?.addEventListener("click", function() { applyFilter("canceled", this); });
      }
    }

    renderList();
  } catch(err) {
    body.innerHTML = `<div style="padding:24px;text-align:center;color:#f87171;font-size:12px">Erreur: ${escHtml(err.message)}</div>`;
  }
}

// ── Bulk BLs Modal ────────────────────────────────────────────
async function showBulkBLsModal(vendors, baseUrl) {
  document.getElementById("blListOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "blListOverlay";
  overlay.style.cssText = `position:fixed;inset:0;z-index:10000;display:flex;align-items:center;
    justify-content:center;background:rgba(0,0,0,.3);padding:16px;`;

  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:560px;max-height:90vh;
      display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.12);overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;
        padding:12px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <span style="font-size:12px;font-weight:700;color:var(--text,#0F172A)">Bons de livraison — ${vendors.length} tournée(s)</span>
        <button id="blListClose" style="background:none;border:none;color:var(--text3,#94A3B8);
          cursor:pointer;font-size:18px;padding:2px 6px;border-radius:4px">×</button>
      </div>
      <div style="padding:8px 14px;border-bottom:1px solid var(--border,#E2E8F0);background:var(--bg2,#fff);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:6px;background:var(--bg3,#F1F5F9);
          border:1px solid var(--border,#E2E8F0);border-radius:6px;padding:4px 8px">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text3,#94A3B8)" stroke-width="2" width="13" height="13">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input id="blSearchInput" type="text" placeholder="Rechercher un client…"
            style="border:none;background:transparent;outline:none;font-size:11px;
            color:var(--text,#0F172A);flex:1;min-width:0"
            oninput="window._blFilterBls(this.value)"/>
          <button id="blAdvSearchToggle" title="Recherche avancée"
            style="background:none;border:none;cursor:pointer;padding:2px;display:flex;
            align-items:center;color:var(--text3,#94A3B8);border-radius:4px;transition:color .15s"
            onmouseover="this.style.color='var(--accent,#3B82F6)'"
            onmouseout="this.style.color=window._blAdvOpen?'var(--accent,#3B82F6)':'var(--text3,#94A3B8)'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
            </svg>
          </button>
        </div>
        <div id="blAdvSearchPanel" style="display:none;margin-top:6px"></div>
      </div>
      <div id="blBulkBar" style="display:none;padding:6px 14px;background:var(--bg2,#fff);
        border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
          <span id="blBulkCount" style="font-size:11px;font-weight:700;color:var(--accent,#3B82F6);
            margin-right:4px;white-space:nowrap">0 sélectionné(s)</span>
          <button class="bl-bulk-btn" data-bulk="scheduled"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #E9D5FF;background:#F3E8FF;color:#8B5CF6;cursor:pointer">Planifié</button>
          <button class="bl-bulk-btn" data-bulk="delayed"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #FED7AA;background:#FFF7ED;color:#F59E0B;cursor:pointer">Reporté</button>
          <button class="bl-bulk-btn" data-bulk="canceled"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #E2E8F0;background:var(--bg3,#F1F5F9);color:#6B7280;cursor:pointer">Annulé</button>
          <button class="bl-bulk-btn" data-bulk="unlink"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #FECACA;background:#FEF2F2;color:#DC2626;cursor:pointer">Désaffecter</button>
          <button id="blBulkChangeTournee"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #BFDBFE;background:#EFF6FF;color:#2563EB;cursor:pointer">⇄ Tournée</button>
          <button id="blBulkSelectAll"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
            color:var(--text2,#475569);cursor:pointer;margin-left:auto">Tout sélect.</button>
          <button id="blBulkPdfBtn"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #FECACA;background:#FEF2F2;color:#DC2626;cursor:pointer;
            display:flex;align-items:center;gap:4px">
            📄 PDF</button>
        </div>
      </div>
      <div id="blListBody" style="overflow-y:auto;flex:1;padding:12px 14px;background:var(--bg,#F8FAFC)">
        <div style="text-align:center;padding:28px"><div class="spinner"></div></div>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  document.getElementById("blListClose")?.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  const body = document.getElementById("blListBody");
  let allBls = [];

  for (const v of vendors) {
    try {
      const bls = await rpcController.fetchBLs(baseUrl, v.roundId, App.currentMode);
      bls.forEach(bl => { bl._vendorLabel = v.label; });
      allBls = allBls.concat(bls);
    } catch(e) {
      addNotif(`Erreur BLs ${v.label}: ${e.message}`, "error");
    }
  }

  if (!allBls.length) {
    body.innerHTML = `<div style="text-align:center;color:var(--text3);padding:24px;font-size:12px">Aucun BL trouvé</div>`;
    return;
  }

  try {
    const linesMap = await rpcController.fetchAllBLsLines(baseUrl, allBls.map(b => b.id));
    allBls.forEach(b => { b._lines = linesMap[b.id] || []; });
  } catch(_) { allBls.forEach(b => { b._lines = []; }); }

  window._currentBLs       = allBls;
  window._currentBLBaseUrl  = baseUrl;
  _renderBLListBody(allBls, baseUrl);
}

async function showBulkPaymentsModal(vendors, baseUrl) {
  document.getElementById("payListOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "payListOverlay";
  overlay.style.cssText = `position:fixed;inset:0;z-index:10000;display:flex;align-items:center;
    justify-content:center;background:rgba(0,0,0,.3);padding:16px;`;

  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:560px;max-height:90vh;
      display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.12);overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;
        padding:12px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <span style="font-size:12px;font-weight:700;color:var(--text,#0F172A)">Paiements — ${vendors.length} tournée(s)</span>
        <button id="payListClose" style="background:none;border:none;color:var(--text3,#94A3B8);
          cursor:pointer;font-size:18px;padding:2px 6px;border-radius:4px">×</button>
      </div>
      <div style="padding:6px 14px;background:var(--bg2,#fff);border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:6px;background:var(--bg3,#F1F5F9);
          border:1px solid var(--border,#E2E8F0);border-radius:6px;padding:4px 8px">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text3,#94A3B8)" stroke-width="2" width="13" height="13">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input id="paySearchInput" type="text" placeholder="Rechercher un client…"
            style="border:none;background:transparent;outline:none;font-size:11px;
            color:var(--text,#0F172A);flex:1;min-width:0"
            oninput="window._payFilterPayments(this.value)"/>
        </div>
      </div>
      <div id="payBulkBar" style="display:none;padding:6px 14px;background:var(--bg2,#fff);
        border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
          <span id="payBulkCount" style="font-size:11px;font-weight:700;color:var(--accent,#3B82F6);
            margin-right:4px;white-space:nowrap">0 sélectionné(s)</span>
          <button class="pay-bulk-btn" data-bulk="draft"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #BFDBFE;background:#EFF6FF;color:#3B82F6;cursor:pointer">Brouillon</button>
          <button class="pay-bulk-btn" data-bulk="post"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #BBF7D0;background:#F0FDF4;color:#15803d;cursor:pointer">Confirmer</button>
          <button class="pay-bulk-btn" data-bulk="cancel"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #E2E8F0;background:var(--bg3,#F1F5F9);color:#6B7280;cursor:pointer">Annuler</button>
          <button id="payBulkSelectAll"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
            color:var(--text2,#475569);cursor:pointer;margin-left:auto">Tout sélect.</button>
          <button id="payBulkOpenLinks"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #FDE68A;background:#FFFBEB;color:#B45309;cursor:pointer;
            display:inline-flex;align-items:center;gap:4px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Ouvrir liens</button>
          <button class="pay-bulk-btn" id="payBulkJournalSwitch" data-bulk="journal-switch"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #C4B5FD;background:#F5F3FF;color:#6D28D9;cursor:pointer;
            display:inline-flex;align-items:center;gap:4px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11">
              <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>
              <polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
            </svg>
            Changer journal</button>
          <button class="pay-bulk-btn" id="payBulkTourneeSwitch" data-bulk="tournee-switch"
            style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:5px;
            border:1px solid #C7D2FE;background:#EEF2FF;color:#4338CA;cursor:pointer;
            display:inline-flex;align-items:center;gap:4px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            Changer tournée</button>
        </div>
      </div>
      <div id="payListBody" style="overflow-y:auto;flex:1;padding:12px 14px;background:var(--bg,#F8FAFC)">
        <div style="text-align:center;padding:28px"><div class="spinner"></div></div>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  document.getElementById("payListClose")?.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  const body = document.getElementById("payListBody");
  let allPayments = [];

  for (const v of vendors) {
    try {
      const payments = await rpcController.fetchPayments(baseUrl, v.roundId);
      payments.forEach(p => { p._vendorLabel = v.label; });
      allPayments = allPayments.concat(payments);
    } catch(e) {
      addNotif(`Erreur paiements ${v.label}: ${e.message}`, "error");
    }
  }

  if (!allPayments.length) {
    body.innerHTML = `<div style="text-align:center;color:var(--text3);padding:24px;font-size:12px">Aucun paiement trouvé</div>`;
    return;
  }
  _renderPayListBody(allPayments, baseUrl);
}
window._blFilterBls = function(query) {
  // redirect vers le nouveau système de filtres
  if (window._currentBLs && window._currentBLBaseUrl) {
    _applyBLFilters(window._currentBLs, window._currentBLBaseUrl);
  }
};
window._payFilterPayments = function(query) {
  if (window._payAllPayments) {
    _applyPayQF();
    return;
  }
  const rows = document.querySelectorAll("#payListBody > div");
  const q = query.toLowerCase().trim();
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = (!q || text.includes(q)) ? "" : "none";
  });
};
function _showBLUnlinkConfirm(bl, bls, baseUrl) {
  document.getElementById("blConfirmOverlay")?.remove();
  const partner = Array.isArray(bl.partner_id) ? bl.partner_id[1] : "—";

  const confirm = document.createElement("div");
  confirm.id = "blConfirmOverlay";
  confirm.style.cssText = `
    position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.4);padding:16px;
  `;
  confirm.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:340px;padding:20px;
      box-shadow:0 8px 32px rgba(0,0,0,.15)">
      <div style="font-size:13px;font-weight:700;color:var(--text,#0F172A);margin-bottom:8px">
        Désaffecter le livreur
      </div>
      <div style="font-size:11px;color:var(--text2,#475569);margin-bottom:16px;line-height:1.6">
        Supprimer le livreur et la tournée de livraison du BL<br>
        <b>${escHtml(bl.name)}</b> (${escHtml(partner)}) ?
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="blConfirmNo"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
          color:var(--text2,#475569);cursor:pointer">Non</button>
        <button id="blConfirmYes"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:none;background:#DC2626;color:#fff;cursor:pointer">
          Désaffecter</button>
      </div>
    </div>
  `;

  document.body.appendChild(confirm);
  document.getElementById("blConfirmNo")?.addEventListener("click", () => confirm.remove());
  confirm.addEventListener("click", e => { if (e.target === confirm) confirm.remove(); });

  document.getElementById("blConfirmYes")?.addEventListener("click", async () => {
    confirm.remove();
    try {
      await rpcController.unlinkBLDelivery(baseUrl, bl.id);
      bl.delivery_planning_id = false;
      bl.delivery_user_id     = false;
      addNotif(`Livreur désaffecté: ${bl.name}`, "success");
      window._currentBLs ? _applyBLFilters(window._currentBLs, baseUrl) : _renderBLListBody(bls, baseUrl);
    } catch(e) {
      addNotif("Erreur: " + e.message, "error");
    }
  });
}

// ── Changer la tournée d'un ou plusieurs BL (recherche + sélection) ────
// `blOrBls` accepte un seul BL (compat. bouton par ligne) ou un tableau
// (sélection multiple depuis la barre d'actions groupées).
function _showChangeTourneeModal(blOrBls, bls, baseUrl) {
  document.getElementById("blTourneeOverlay")?.remove();
  const selection = Array.isArray(blOrBls) ? blOrBls : [blOrBls];
  if (!selection.length) return;
  const isBulk = selection.length > 1;
  const bl = selection[0]; // référence pour warehouse_id (partage le même dépôt)
  const partner = Array.isArray(bl.partner_id) ? bl.partner_id[1] : "—";
  const currentTournee = Array.isArray(bl.delivery_planning_id) ? bl.delivery_planning_id[1] : "—";
  const warehouseId = Array.isArray(bl.warehouse_id) ? bl.warehouse_id[0] : bl.warehouse_id;

  const overlay = document.createElement("div");
  overlay.id = "blTourneeOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.4);padding:16px;
  `;
  const headerHtml = isBulk
    ? `<b>${selection.length} BL(s) sélectionné(s)</b>`
    : `<b>${escHtml(bl.name)}</b> (${escHtml(partner)})<br>Tournée actuelle : <b>${escHtml(currentTournee)}</b>`;
  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:360px;padding:20px;
      box-shadow:0 8px 32px rgba(0,0,0,.15)">
      <div style="font-size:13px;font-weight:700;color:var(--text,#0F172A);margin-bottom:8px">
        Changer la tournée
      </div>
      <div style="font-size:11px;color:var(--text2,#475569);margin-bottom:12px;line-height:1.6">
        ${headerHtml}
      </div>
      <input id="tourneeSearchInput" type="text" placeholder="Réf. nouvelle tournée…"
        autocomplete="off"
        style="width:100%;box-sizing:border-box;font-size:12px;padding:7px 10px;border-radius:6px;
        border:1px solid var(--border,#E2E8F0);background:var(--bg,#F8FAFC);color:var(--text,#0F172A);
        margin-bottom:8px"/>
      <div id="tourneeResults" style="max-height:180px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;margin-bottom:12px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="tourneeCancelBtn"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
          color:var(--text2,#475569);cursor:pointer">Fermer</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById("tourneeCancelBtn")?.addEventListener("click", () => overlay.remove());

  const input   = document.getElementById("tourneeSearchInput");
  const results = document.getElementById("tourneeResults");
  input.focus();

  let debounceId = null;
  input.addEventListener("input", () => {
    clearTimeout(debounceId);
    const term = input.value.trim();
    if (!term) { results.innerHTML = ""; return; }
    debounceId = setTimeout(async () => {
      results.innerHTML = `<div style="text-align:center;padding:10px;color:var(--text3,#94A3B8);font-size:11px">Recherche…</div>`;
      try {
        const rows = await rpcController.searchTournee(baseUrl, term, warehouseId);
        if (!rows.length) {
          results.innerHTML = `<div style="text-align:center;padding:10px;color:var(--text3,#94A3B8);font-size:11px">Aucune tournée trouvée</div>`;
          return;
        }
        results.innerHTML = rows.map(r => `
          <button class="tournee-result-btn" data-id="${r.id}" data-name="${escHtml(r.name)}"
            style="text-align:left;font-size:11px;font-weight:600;padding:6px 10px;border-radius:6px;
            border:1px solid var(--border,#E2E8F0);background:var(--bg,#F8FAFC);color:var(--text,#0F172A);
            cursor:pointer">${escHtml(r.name)}</button>
        `).join("");
        results.querySelectorAll(".tournee-result-btn").forEach(btn => {
          btn.addEventListener("click", () => _confirmChangeTournee(selection, bls, baseUrl, parseInt(btn.dataset.id), btn.dataset.name, overlay));
        });
      } catch (e) {
        results.innerHTML = `<div style="text-align:center;padding:10px;color:#DC2626;font-size:11px">Erreur: ${escHtml(e.message)}</div>`;
      }
    }, 300);
  });
}

// ── Modifier le montant d'un paiement (uniquement si non vérifié) ──────
function _showEditPaymentAmountModal(p, payments, baseUrl) {
  if (p.verified_state === true || p.verified_state === "verified") return; // garde-fou
  document.getElementById("payAmountOverlay")?.remove();
  const partner = Array.isArray(p.partner_id) ? p.partner_id[1] : "—";

  const overlay = document.createElement("div");
  overlay.id = "payAmountOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.4);padding:16px;
  `;
  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:320px;padding:20px;
      box-shadow:0 8px 32px rgba(0,0,0,.15)">
      <div style="font-size:13px;font-weight:700;color:var(--text,#0F172A);margin-bottom:8px">
        Modifier le montant
      </div>
      <div style="font-size:11px;color:var(--text2,#475569);margin-bottom:12px;line-height:1.6">
        Paiement de <b>${escHtml(partner)}</b>
      </div>
      <input id="payAmountInput" type="number" step="0.01" value="${p.amount}"
        autocomplete="off"
        style="width:100%;box-sizing:border-box;font-size:13px;padding:7px 10px;border-radius:6px;
        border:1px solid var(--border,#E2E8F0);background:var(--bg,#F8FAFC);color:var(--text,#0F172A);
        margin-bottom:8px"/>
      <div id="payAmountStatus" style="font-size:11px;min-height:14px;color:#DC2626;margin-bottom:8px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="payAmountCancelBtn"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
          color:var(--text2,#475569);cursor:pointer">Fermer</button>
        <button id="payAmountSaveBtn"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:none;background:#2563EB;color:#fff;cursor:pointer">Enregistrer</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById("payAmountCancelBtn")?.addEventListener("click", () => overlay.remove());

  const input    = document.getElementById("payAmountInput");
  const status   = document.getElementById("payAmountStatus");
  const saveBtn  = document.getElementById("payAmountSaveBtn");
  input.focus();
  input.select();

  saveBtn.addEventListener("click", async () => {
    const newAmount = parseFloat(input.value);
    if (isNaN(newAmount) || newAmount <= 0) {
      status.textContent = "Montant invalide";
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "Enregistrement…";
    try {
      await rpcController.changePaymentAmount(baseUrl, p.id, newAmount);
      p.amount = newAmount;
      addNotif(`Montant modifié: ${escHtml(partner)} → ${newAmount} DA`, "success");
      overlay.remove();
      _renderPayListBody(payments, baseUrl);
    } catch (e) {
      status.textContent = "Erreur: " + e.message;
      saveBtn.disabled = false;
      saveBtn.textContent = "Enregistrer";
    }
  });
}

// ── Modifier la référence (nom/libellé) d'un paiement — même conditions et
// même mécanique que _showEditPaymentAmountModal (guard non-vérifié +
// cycle brouillon→écriture→confirmer automatique en arrière-plan) ──
function _showEditPaymentNameModal(p, payments, baseUrl) {
  if (p.verified_state === true || p.verified_state === "verified") return; // garde-fou
  document.getElementById("payNameOverlay")?.remove();
  const partner = Array.isArray(p.partner_id) ? p.partner_id[1] : "—";

  const overlay = document.createElement("div");
  overlay.id = "payNameOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.4);padding:16px;
  `;
  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:320px;padding:20px;
      box-shadow:0 8px 32px rgba(0,0,0,.15)">
      <div style="font-size:13px;font-weight:700;color:var(--text,#0F172A);margin-bottom:8px">
        Modifier le client
      </div>
      <div style="font-size:11px;color:var(--text2,#475569);margin-bottom:12px;line-height:1.6">
        Paiement de <b>${escHtml(partner)}</b>
      </div>
      <div style="position:relative;margin-bottom:8px">
        <input id="payNameInput" type="text" value="${escHtml(partner === "—" ? "" : partner)}"
          autocomplete="off" placeholder="Rechercher un client…"
          style="width:100%;box-sizing:border-box;font-size:13px;padding:7px 10px;border-radius:6px;
          border:1px solid var(--border,#E2E8F0);background:var(--bg,#F8FAFC);color:var(--text,#0F172A)"/>
        <div id="payNameSuggestions" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;
          z-index:10002;background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);border-radius:8px;
          box-shadow:0 8px 24px rgba(0,0,0,.12);max-height:220px;overflow-y:auto"></div>
      </div>
      <div id="payNameStatus" style="font-size:11px;min-height:14px;color:#DC2626;margin-bottom:8px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="payNameCancelBtn"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
          color:var(--text2,#475569);cursor:pointer">Fermer</button>
        <button id="payNameSaveBtn"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:none;background:#2563EB;color:#fff;cursor:pointer">Enregistrer</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById("payNameCancelBtn")?.addEventListener("click", () => overlay.remove());

  const input    = document.getElementById("payNameInput");
  const sugg     = document.getElementById("payNameSuggestions");
  const status   = document.getElementById("payNameStatus");
  const saveBtn  = document.getElementById("payNameSaveBtn");
  input.focus();
  input.select();

  let searchTimer = null;
  let activeIdx = -1;

  function hideSuggestions() { sugg.style.display = "none"; sugg.innerHTML = ""; activeIdx = -1; }

  function selectSuggestion(el) {
    input.value = el.dataset.name;
    input.dataset.partnerRef = el.dataset.ref || "";
    hideSuggestions();
    status.textContent = "";
  }

  input.addEventListener("input", () => {
    delete input.dataset.partnerRef; // toute frappe invalide la sélection précédente
    status.textContent = "";
    const term = input.value.trim();
    clearTimeout(searchTimer);
    if (term.length < 2) { hideSuggestions(); return; }

    sugg.innerHTML = `<div class="pm-sugg-item" style="opacity:.6;pointer-events:none">🔍 Recherche…</div>`;
    sugg.style.display = "block";

    searchTimer = setTimeout(async () => {
      try {
        // même recherche que le reste de l'app : ignore l'ordre et les espaces
        // (chaque mot est comparé séparément via ilike, indépendamment de sa
        // position dans le nom du client)
        const results = await rpcController.searchPartners(baseUrl, term, []);
        if (input.value.trim() !== term) return; // texte changé entretemps, résultat obsolète
        if (!results.length) {
          sugg.innerHTML = `<div class="pm-sugg-item" style="opacity:.6;pointer-events:none">Aucun résultat</div>`;
          sugg.style.display = "block";
          return;
        }
        sugg.innerHTML = results.map((r, i) => `
          <div class="pm-sugg-item" data-idx="${i}" data-name="${escHtml(r.fullName)}" data-ref="${escHtml(r.ref || "")}">
            <span class="pm-sugg-name">${escHtml(r.fullName)}</span>
          </div>
        `).join("");
        sugg.style.display = "block";
        activeIdx = -1;
        sugg.querySelectorAll(".pm-sugg-item[data-ref]").forEach(el => {
          el.addEventListener("mousedown", e => { e.preventDefault(); selectSuggestion(el); });
        });
      } catch (_) {
        hideSuggestions();
      }
    }, 300);
  });

  input.addEventListener("keydown", e => {
    const items = sugg.querySelectorAll(".pm-sugg-item[data-ref]");
    if (sugg.style.display === "none" || !items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = Math.min(items.length - 1, activeIdx + 1);
      items.forEach(el => el.classList.remove("pm-sugg-active"));
      items[activeIdx].classList.add("pm-sugg-active");
      items[activeIdx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = Math.max(0, activeIdx - 1);
      items.forEach(el => el.classList.remove("pm-sugg-active"));
      items[activeIdx].classList.add("pm-sugg-active");
      items[activeIdx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx >= 0) selectSuggestion(items[activeIdx]);
    } else if (e.key === "Escape") {
      hideSuggestions();
    }
  });

  input.addEventListener("blur", () => setTimeout(hideSuggestions, 150));

  saveBtn.addEventListener("click", async () => {
    const newName = input.value.trim();
    const partnerRef = input.dataset.partnerRef || "";
    if (!newName || !partnerRef) {
      status.textContent = "Sélectionnez un client dans la liste";
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "Enregistrement…";
    try {
      await rpcController.changePaymentPartner(baseUrl, p.id, partnerRef);
      p.partner_id = [p.partner_id?.[0] ?? null, newName];
      addNotif(`Client modifié: ${escHtml(partner)} → ${escHtml(newName)}`, "success");
      overlay.remove();
      _renderPayListBody(payments, baseUrl);
    } catch (e) {
      status.textContent = "Erreur: " + e.message;
      saveBtn.disabled = false;
      saveBtn.textContent = "Enregistrer";
    }
  });
}

// ── Changer la tournée d'un ou plusieurs paiements (modal Paiements de la
// tournée) — même principe que pour les BL, mais sans suppression du client
// de l'ancienne tournée (ce modal ne touche pas au calendar.event).
function _showChangePaymentTourneeModal(payOrPays, payments, baseUrl) {
  document.getElementById("payTourneeOverlay")?.remove();
  const selection = Array.isArray(payOrPays) ? payOrPays : [payOrPays];
  if (!selection.length) return;
  const isBulk = selection.length > 1;
  const p = selection[0];
  const partner = Array.isArray(p.partner_id) ? p.partner_id[1] : "—";

  const overlay = document.createElement("div");
  overlay.id = "payTourneeOverlay";
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.4);padding:16px;
  `;
  const headerHtml = isBulk
    ? `<b>${selection.length} paiement(s) sélectionné(s)</b>`
    : `Paiement de <b>${escHtml(partner)}</b>`;
  overlay.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:360px;padding:20px;
      box-shadow:0 8px 32px rgba(0,0,0,.15)">
      <div style="font-size:13px;font-weight:700;color:var(--text,#0F172A);margin-bottom:8px">
        Changer la tournée
      </div>
      <div style="font-size:11px;color:var(--text2,#475569);margin-bottom:12px;line-height:1.6">
        ${headerHtml}
      </div>
      <input id="payTourneeSearchInput" type="text" placeholder="Réf. nouvelle tournée…"
        autocomplete="off"
        style="width:100%;box-sizing:border-box;font-size:12px;padding:7px 10px;border-radius:6px;
        border:1px solid var(--border,#E2E8F0);background:var(--bg,#F8FAFC);color:var(--text,#0F172A);
        margin-bottom:8px"/>
      <div id="payTourneeResults" style="max-height:180px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;margin-bottom:12px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="payTourneeCancelBtn"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
          color:var(--text2,#475569);cursor:pointer">Fermer</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById("payTourneeCancelBtn")?.addEventListener("click", () => overlay.remove());

  const input   = document.getElementById("payTourneeSearchInput");
  const results = document.getElementById("payTourneeResults");
  input.focus();

  let debounceId = null;
  input.addEventListener("input", () => {
    clearTimeout(debounceId);
    const term = input.value.trim();
    if (!term) { results.innerHTML = ""; return; }
    debounceId = setTimeout(async () => {
      results.innerHTML = `<div style="text-align:center;padding:10px;color:var(--text3,#94A3B8);font-size:11px">Recherche…</div>`;
      try {
        const rows = await rpcController.searchTourneeForPayment(baseUrl, term);
        if (!rows.length) {
          results.innerHTML = `<div style="text-align:center;padding:10px;color:var(--text3,#94A3B8);font-size:11px">Aucune tournée trouvée</div>`;
          return;
        }
        results.innerHTML = rows.map(r => `
          <button class="tournee-result-btn" data-id="${r.id}" data-name="${escHtml(r.name)}"
            style="text-align:left;font-size:11px;font-weight:600;padding:6px 10px;border-radius:6px;
            border:1px solid var(--border,#E2E8F0);background:var(--bg,#F8FAFC);color:var(--text,#0F172A);
            cursor:pointer">${escHtml(r.name)}</button>
        `).join("");
        results.querySelectorAll(".tournee-result-btn").forEach(btn => {
          btn.addEventListener("click", () => _confirmChangePaymentTournee(selection, payments, baseUrl, parseInt(btn.dataset.id), btn.dataset.name, overlay));
        });
      } catch (e) {
        results.innerHTML = `<div style="text-align:center;padding:10px;color:#DC2626;font-size:11px">Erreur: ${escHtml(e.message)}</div>`;
      }
    }, 300);
  });
}

function _confirmChangePaymentTournee(payOrPays, payments, baseUrl, newPlanningId, newPlanningName, overlay) {
  overlay.remove();
  const selection = Array.isArray(payOrPays) ? payOrPays : [payOrPays];
  const isBulk = selection.length > 1;
  document.getElementById("payConfirmTourneeOverlay")?.remove();
  const confirm = document.createElement("div");
  confirm.id = "payConfirmTourneeOverlay";
  confirm.style.cssText = `
    position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.4);padding:16px;
  `;
  const partner = Array.isArray(selection[0].partner_id) ? selection[0].partner_id[1] : "—";
  const bodyHtml = isBulk
    ? `Déplacer <b>${selection.length} paiement(s)</b> vers la tournée<br><b>${escHtml(newPlanningName)}</b> ?`
    : `Déplacer le paiement de <b>${escHtml(partner)}</b> vers la tournée<br><b>${escHtml(newPlanningName)}</b> ?`;
  confirm.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:340px;padding:20px;
      box-shadow:0 8px 32px rgba(0,0,0,.15)">
      <div style="font-size:13px;font-weight:700;color:var(--text,#0F172A);margin-bottom:8px">
        Confirmer le changement
      </div>
      <div style="font-size:11px;color:var(--text2,#475569);margin-bottom:16px;line-height:1.6">
        ${bodyHtml}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="payTourneeConfirmNo"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
          color:var(--text2,#475569);cursor:pointer">Non</button>
        <button id="payTourneeConfirmYes"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:none;background:#2563EB;color:#fff;cursor:pointer">
          Confirmer</button>
      </div>
    </div>
  `;
  document.body.appendChild(confirm);
  document.getElementById("payTourneeConfirmNo")?.addEventListener("click", () => confirm.remove());
  confirm.addEventListener("click", e => { if (e.target === confirm) confirm.remove(); });

  document.getElementById("payTourneeConfirmYes")?.addEventListener("click", async () => {
    confirm.remove();
    const paymentIds = selection.map(p => p.id);
    try {
      await rpcController.changePaymentTournee(baseUrl, paymentIds, newPlanningId);
      // الجولة الحالية للمودال هي جولة واحدة محدَّدة سلفًا (roundId) — بعد النقل
      // لم تعد هذه الدفعات تنتمي إليها، لذا نزيلها من القائمة المعروضة محليًا
      const movedIds = new Set(paymentIds);
      const remaining = payments.filter(p => !movedIds.has(p.id));
      payments.length = 0;
      payments.push(...remaining);
      addNotif(
        isBulk
          ? `Tournée changée pour ${selection.length} paiement(s) → ${newPlanningName}`
          : `Tournée changée: paiement → ${newPlanningName}`,
        "success"
      );
      _renderPayListBody(payments, baseUrl);
    } catch(e) {
      addNotif("Erreur: " + e.message, "error");
    }
  });
}

function _confirmChangeTournee(blOrBls, bls, baseUrl, newPlanningId, newPlanningName, overlay) {
  overlay.remove();
  const selection = Array.isArray(blOrBls) ? blOrBls : [blOrBls];
  const isBulk = selection.length > 1;
  document.getElementById("blConfirmOverlay")?.remove();
  const confirm = document.createElement("div");
  confirm.id = "blConfirmOverlay";
  confirm.style.cssText = `
    position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.4);padding:16px;
  `;
  const bodyHtml = isBulk
    ? `Affecter <b>${selection.length} BL(s)</b> à la tournée<br>
       <b>${escHtml(newPlanningName)}</b> ? Le livreur sera mis à jour automatiquement.`
    : `Affecter le BL <b>${escHtml(selection[0].name)}</b> à la tournée<br>
       <b>${escHtml(newPlanningName)}</b> ? Le livreur sera mis à jour automatiquement.`;
  confirm.innerHTML = `
    <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
      border-radius:10px;width:100%;max-width:340px;padding:20px;
      box-shadow:0 8px 32px rgba(0,0,0,.15)">
      <div style="font-size:13px;font-weight:700;color:var(--text,#0F172A);margin-bottom:8px">
        Confirmer le changement
      </div>
      <div style="font-size:11px;color:var(--text2,#475569);margin-bottom:16px;line-height:1.6">
        ${bodyHtml}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="blConfirmNo"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
          color:var(--text2,#475569);cursor:pointer">Non</button>
        <button id="blConfirmYes"
          style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
          border:none;background:#2563EB;color:#fff;cursor:pointer">
          Confirmer</button>
      </div>
    </div>
  `;
  document.body.appendChild(confirm);
  document.getElementById("blConfirmNo")?.addEventListener("click", () => confirm.remove());
  confirm.addEventListener("click", e => { if (e.target === confirm) confirm.remove(); });

  document.getElementById("blConfirmYes")?.addEventListener("click", async () => {
    confirm.remove();
    const pickingIds = selection.map(b => b.id);
    try {
      const res = await rpcController.changeBLTournee(baseUrl, pickingIds, newPlanningId);
      selection.forEach(b => {
        b.delivery_planning_id = [res.planningId, res.planningName];
        b.delivery_user_id     = [res.deliveryUserId, res.deliveryUserName];
      });
      addNotif(
        isBulk
          ? `Tournée changée pour ${selection.length} BL(s) → ${res.planningName}`
          : `Tournée changée: ${selection[0].name} → ${res.planningName}`,
        "success"
      );
      window._currentBLs ? _applyBLFilters(window._currentBLs, baseUrl) : _renderBLListBody(bls, baseUrl);
    } catch(e) {
      addNotif("Erreur: " + e.message, "error");
    }
  });
}