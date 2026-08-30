// ============================================================
// src/app.js — Wafa PWA v1.0
// ORCHESTRATION: state + events + RPC calls (direct, no SW proxy)
// No chrome.* APIs. No alarms. No cloud. No injection.
// Auth via browser cookies (credentials: include in fetch).
// ============================================================
// ── RBAC: تحميل الدور/الصلاحيات مرة واحدة بعد تسجيل الدخول ─────
async function _loadPermissions() {
  try {
    const r = await fetch("/api/sync/me", { method: "GET", credentials: "include" });
    if (!r.ok) return;
    const j = await r.json();
    App.role = j.role || "viewer";
    App.permissions = j.permissions || {};
    if (typeof applySettingsPermissions === "function") applySettingsPermissions();
  } catch (_) {
    // فشل الجلب لا يوقف التطبيق — hasPermission() ستُرجع false افتراضيًا
    // (الفرض الحقيقي يبقى في السيرفر على أي حال)
  }
}

// ── Login guard ───────────────────────────────────────────────
async function _checkAndLogin() {
  // اختبر إذا كانت الـ session موجودة
  try {
    const r = await fetch("/api/web/dataset/call_kw", {
      method: "POST",
      credentials: "include",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        jsonrpc:"2.0", method:"call", id:0,
        params: { model:"res.users", method:"read", args:[[1],["name"]], kwargs:{} }
      })
    });
    const j = await r.json();
    if (j?.result) {
      // Session valid — استرجاع uid من localStorage
      const savedUid = parseInt(localStorage.getItem("owlrh_uid") || "0");
      if (savedUid) App.uid = savedUid;
      await _loadPermissions();
      return; // session valid ✓
    }
  } catch(_) {}

  // Session غير موجودة — اعرض شاشة Login
  const screen = document.getElementById("loginScreen");
  screen.style.display = "flex";

  await new Promise(resolve => {
    function doLogin() {
      const login    = document.getElementById("loginUser").value.trim();
      const password = document.getElementById("loginPass").value.trim();
      const errEl    = document.getElementById("loginErr");
      const btn      = document.getElementById("loginBtn");
      if (!login || !password) { errEl.textContent = "Remplissez tous les champs"; return; }
      errEl.textContent = "";
      btn.textContent = "Connexion…";
      btn.disabled = true;

      // جلب اسم قاعدة البيانات أولاً
      fetch("/api/web/database/list", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({jsonrpc:"2.0", method:"call", id:1, params:{}})
      })
      .then(r => r.json())
      .then(d => {
        const db = (d?.result || [])[0];
        if (!db) throw new Error("Base de données introuvable");
        return fetch("/api/web/session/authenticate", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            jsonrpc:"2.0", method:"call", id:2,
            params: { db, login, password }
          })
        });
      })
      .then(r => r.json())
      .then(async d => {
        if (d?.result?.uid) {
          App.uid = d.result.uid;
          localStorage.setItem("owlrh_uid", App.uid);
          await _loadPermissions();
          screen.style.display = "none";
          resolve();
        } else {
          throw new Error("Identifiants incorrects");
        }
      })
      .catch(e => {
        document.getElementById("loginErr").textContent = e.message;
        btn.textContent = "Se connecter";
        btn.disabled = false;
      });
    }

    document.getElementById("loginBtn").addEventListener("click", doLogin);
    ["loginUser","loginPass"].forEach(id => {
      document.getElementById(id).addEventListener("keydown", e => {
        if (e.key === "Enter") doLogin();
      });
    });
  });
}
const ODOO_BASE = "https://wafa.presalio.com";

// ── App State ─────────────────────────────────────────────────
const App = {
  uid:               null,
  settings:          null,
  allLinks:          {},
  allRefs:           {},
  allStats:          {},
  allRoundStatus:    {},
  allOdooState:      {},
  allUserStatus:     {},
  isFetching:        false,
  currentMode:       "prevente",
  currentDateOffset: 0,
  activeOps:         {},
  searchQuery:       "",
  filterFavourites:     [],
  routeFilterFavourites: [],
  pmShortcuts:       [],
  pmCurrentWorker:   null,
};

// ── Constants ─────────────────────────────────────────────────
const MODE_CFG = {
  prevente:  { label:"PRÉVENTE",  color:"var(--prev-color)" },
  livraison: { label:"LIVRAISON", color:"var(--liv-color)"  },
  mr:        { label:"M&R",       color:"var(--mr-color)"   },
  gds:       { label:"GDS",       color:"var(--gds-color)"  },
  clients:   { label:"CLIENTS",   color:"var(--accent, #2563EB)" },
};

const DEFAULT_CARD_LAYOUTS = {
  prevente: [
    {id:"dot",visible:true,size:7,x:4,y:6},{id:"label",visible:true,size:11,x:12,y:4},
    {id:"stat_p",visible:true,size:11,x:2,y:32},{id:"stat_v",visible:true,size:11,x:22,y:32},
    {id:"stat_s",visible:true,size:11,x:52,y:32},{id:"stat_ca",visible:true,size:11,x:2,y:58},
    {id:"stat_time",visible:true,size:10,x:52,y:58},{id:"stat_updated",visible:true,size:9,x:2,y:93},
    {id:"btns",visible:true,size:22,x:2,y:76},
  ],
  livraison: [
    {id:"dot",visible:true,size:7,x:4,y:6},{id:"label",visible:true,size:11,x:12,y:4},
    {id:"stat_p",visible:true,size:11,x:2,y:32},{id:"stat_v",visible:true,size:11,x:22,y:32},
    {id:"stat_s",visible:true,size:11,x:52,y:32},{id:"stat_time",visible:true,size:10,x:2,y:58},
    {id:"stat_updated",visible:true,size:9,x:2,y:93},{id:"btns",visible:true,size:22,x:2,y:76},
  ],
};
const DEFAULT_CARD_HEIGHTS = { prevente:110, livraison:100 };
const PM_SHORTCUTS_KEY = "wafa_pm_shortcuts";

// ── Context Cache ─────────────────────────────────────────────
const _contextCache = {};

function _cacheKey() {
  return App.currentMode + "_" + getDateKey(App.currentDateOffset);
}

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

function mergeStats(target, incoming) {
  for (const [id, s] of Object.entries(incoming || {})) {
    const copy   = deepCopy(s);
    const merged = Object.assign({}, target[id] || {});
    for (const key of Object.keys(copy)) merged[key] = copy[key];
    target[id] = merged;
  }
}

function updateCacheForContext(ck, partial) {
  if (!_contextCache[ck]) _contextCache[ck] = { links:{}, stats:{}, roundStatus:{}, refs:{}, odooState:{}, userStatus:{} };
  if (partial.links)       Object.assign(_contextCache[ck].links,       partial.links);
  if (partial.stats)       mergeStats(_contextCache[ck].stats,           partial.stats);
  if (partial.refs)        Object.assign(_contextCache[ck].refs,         partial.refs);
  if (partial.roundStatus) Object.assign(_contextCache[ck].roundStatus,  partial.roundStatus);
  if (partial.odooState)   Object.assign(_contextCache[ck].odooState,    partial.odooState);
  if (partial.userStatus)  Object.assign(_contextCache[ck].userStatus,   partial.userStatus);
}

function updateStats(partialStats) {
  const ck = _cacheKey();
  updateCacheForContext(ck, { stats: partialStats });
  App.allStats = deepCopy(_contextCache[ck].stats);
  _syncRoundExtrasIfStale(partialStats);
}

// إعادة جلب Reports/Ventes/Retours عندما يتغيّر roundId لعامل توصيل
// (كانت تُجلب مرة واحدة فقط عند فتح التطبيق/تغيير التاريخ، فتصبح قديمة
//  بعد أي تحديث لاحق للإحصائيات ويظهر الزر مجمّدًا "Aucune" رغم وجود بيانات)
// ملاحظة: هذه شبكة أمان فقط (fallback) — تجلب بصمت وبشكل مُحدَّد فقط للعمال
// الفعليين الذين أصبحت بياناتهم قديمة (stale)، وليس لكل الكروت دفعة واحدة.
let _extrasSyncTimer = null;
let _extrasSyncPending = new Set();
function _syncRoundExtrasIfStale(partialStats) {
  if (!partialStats) return;
  for (const wid in partialStats) {
    const w = allWorkers().find(x => x.id === wid);
    if (!w || w.role !== "livraison") continue;
    const roundId = App.allStats[wid]?.roundId;
    if (!roundId) continue;
    const cachedRoundIds = [
      App._delayedOrders?.[wid]?.roundId,
      App._soldOrders?.[wid]?.roundId,
      App._returnOrders?.[wid]?.roundId,
    ];
    if (cachedRoundIds.some(r => r !== roundId)) _extrasSyncPending.add(wid);
  }
  if (!_extrasSyncPending.size) return;
  clearTimeout(_extrasSyncTimer);
  _extrasSyncTimer = setTimeout(() => {
    const ids = [..._extrasSyncPending];
    _extrasSyncPending.clear();
    const staleWorkers = ids.map(id => allWorkers().find(w => w.id === id)).filter(Boolean);
    _fetchExtrasSilently(staleWorkers);
  }, 800);
}

// ── جلب صامت (بدون activeOps/loading) لـ Reports/Ventes/Retours لمجموعة عمال محدَّدة فقط ──
async function _fetchExtrasSilently(workersList) {
  const baseUrl = getOdooBase();
  if (!baseUrl) return;
  const livWorkers = (workersList || []).filter(w => w && w.role === "livraison" && App.allStats[w.id]?.roundId);
  if (!livWorkers.length) return;
  try { await _fetchRoundExtrasBulkFor(livWorkers, baseUrl); } catch (_) {}
}

function _loadDateContext(raw) {
  const ck = _cacheKey();
  if (_contextCache[ck] && Object.keys(_contextCache[ck].odooState || {}).length > 0) {
    App.allLinks       = { ...(_contextCache[ck].links   || {}) };
    App.allStats       = deepCopy(_contextCache[ck].stats || {});
    App.allRoundStatus = { ...(_contextCache[ck].roundStatus || {}) };
    App.allRefs        = { ...(_contextCache[ck].refs        || {}) };
    const _ckDateKey = getDateKey(App.currentDateOffset);
    const _ckMode    = App.currentMode;
    const _storedOdoo = (raw.odooState?.[_ckDateKey]?.[_ckMode]) || {};
    const _storedUser = (raw.userStatus?.[_ckDateKey]?.[_ckMode]) || {};
    App.allOdooState   = { ..._storedOdoo, ...(_contextCache[ck].odooState  || {}) };
    App.allUserStatus  = { ..._storedUser, ...(_contextCache[ck].userStatus || {}) };
    return;
  }
  const dateKey = getDateKey(App.currentDateOffset);
  const mode    = App.currentMode;
  const _linksDay  = (raw.vendorLinks || {})[dateKey] || {};
  const _statsDay  = (raw.vendorStats || {})[dateKey] || {};
  const _statusDay = (raw.roundStatus || {})[dateKey] || {};
  const _refsDay   = (raw.vendorRefs  || {})[dateKey] || {};

  const _isOldFormat = obj => obj && !obj.prevente && !obj.livraison && !obj.mr && Object.keys(obj).length > 0;

  App.allLinks       = _linksDay[mode]  ?? (_isOldFormat(_linksDay)  ? _linksDay  : {});
  App.allStats       = _statsDay[mode]  || {};
  App.allRoundStatus = _statusDay[mode] ?? (_isOldFormat(_statusDay) ? _statusDay : {});
  App.allRefs        = _refsDay[mode]   ?? (_isOldFormat(_refsDay)   ? _refsDay   : {});
  App.allOdooState   = (raw.odooState?.[dateKey]?.[mode])  || {};
  App.allUserStatus  = (raw.userStatus?.[dateKey]?.[mode]) || {};
  updateCacheForContext(ck, { links: App.allLinks, stats: App.allStats, refs: App.allRefs, roundStatus: App.allRoundStatus, odooState: App.allOdooState, userStatus: App.allUserStatus });
}

async function setDateOffset(offset) {
  // Max date enforcement
  const today    = getTodayKey();
  const maxDate  = App.currentMode === "livraison" ? getDateKey(1) : today;
  const minDate  = getDateKey(-90);
  const target   = getDateKey(offset);
  if (target > maxDate) return;
  if (target < minDate) return;

  if (App.currentDateOffset === offset) return;

  const oldKey = _cacheKey();
  App.currentDateOffset = offset;
  const raw = await Storage.getMany(["vendorLinks","vendorStats","vendorRefs","roundStatus"]);
  if (!_contextCache[oldKey]) _contextCache[oldKey] = {};
  _contextCache[oldKey].links       = { ...App.allLinks };
  _contextCache[oldKey].stats       = deepCopy(App.allStats);
  _contextCache[oldKey].refs        = { ...App.allRefs };
  _contextCache[oldKey].roundStatus = { ...App.allRoundStatus };
  _loadDateContext(raw);
  renderDateSwitcher();

  // مسح الـ multi-select عند تغيير التاريخ
  document.querySelectorAll(".vc--selected").forEach(card => {
    card.classList.remove("vc--selected");
    const badge = card.querySelector(".vc-sel-badge");
    if (badge) badge.style.display = "none";
  });
  const bar = document.getElementById("vendorBulkBar");
  if (bar) bar.style.display = "none";

  renderVendors();
  const label = offset === 0 ? "📅 Aujourd'hui" : `📅 ${getDateKey(offset)}`;
  addNotif(label, "info");
  _refreshRoundExtras();
}

// ── Rafraîchir badges R/A + bouton Reports pour la date affichée ──
async function _refreshRoundExtras() {
  const baseUrl = getOdooBase();
  if (!baseUrl) return;
  const livWorkers = allWorkers().filter(w => w.role === "livraison" && App.allStats[w.id]?.roundId);
  if (!livWorkers.length) return;

  let _rerenderTimer = null;
  const scheduleRender = () => {
    clearTimeout(_rerenderTimer);
    _rerenderTimer = setTimeout(renderVendors, 120);
  };

  await Promise.all(livWorkers.map(async w => {
    const roundId = App.allStats[w.id]?.roundId;

    const tasks = [
      rpcController.fetchDelayedOrders(baseUrl, roundId).catch(() => []),
      rpcController.fetchSoldOrders(baseUrl, roundId).catch(() => []),
      rpcController.fetchReturnOrders(baseUrl, roundId).catch(() => []),
    ];
    if (App.settings?.showRoundAlerts) {
      tasks.push(rpcController.fetchRoundAlerts(baseUrl, roundId).catch(() => ({})));
    }

    const [picks, sales, returns, alerts] = await Promise.all(tasks);

    if (!App._delayedOrders) App._delayedOrders = {};
    App._delayedOrders[w.id] = { roundId, picks };

    if (!App._soldOrders) App._soldOrders = {};
    App._soldOrders[w.id] = { roundId, sales };

    if (!App._returnOrders) App._returnOrders = {};
    App._returnOrders[w.id] = { roundId, returns };

    if (App.settings?.showRoundAlerts) {
      if (!App._roundAlerts) App._roundAlerts = {};
      App._roundAlerts[w.id] = {
        hasDelayed:  alerts?.hasDelayed  || false,
        hasCanceled: alerts?.hasCanceled || false,
        roundId,
      };
    }

    // رسم فوري تدريجي لكل عامل بمجرد وصول بياناته (بدل انتظار الجميع)
    scheduleRender();
  }));

  clearTimeout(_rerenderTimer);
  renderVendors();
}

// ── Helpers ───────────────────────────────────────────────────
function allWorkers()  { return (App.settings?.vendors || []).filter(v => v.enabled); }
function modeWorkers() {
  if (App.currentMode === "mr") {
    return allWorkers().filter(v => v.role === "merch" || v.role === "recouvrement");
  }
  return allWorkers().filter(v => v.role === App.currentMode);
}

function getOdooBase() {
  return ODOO_BASE;
}


function _getRoundId(workerId) {
  const ck = _cacheKey();
  return _contextCache[ck]?.stats?.[workerId]?.roundId
      ?? App.allStats[workerId]?.roundId;
}

function _getRoundIdFromLink(workerId) {
  const raw = App.allLinks[workerId];
  if (!raw) return null;
  // Support both single link (string) and multiple links (array)
  const links = Array.isArray(raw) ? raw : [raw];
  // Return the ID of the open round (prefer first match that has an id)
  for (const link of links) {
    if (typeof link !== "string") continue;
    const match = link.match(/[#&]id=(\d+)/);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  await _checkAndLogin();
  await loadData();
  if (App.settings?.autoSyncEnabled && typeof FirebaseSync !== "undefined") {
    await FirebaseSync.syncOnStartup().catch(e => console.error("[FirebaseSync] syncOnStartup:", e));
    App.settings = await Storage.getSettings();
    if (typeof loadFilterFavourites === "function") loadFilterFavourites();
  }
  if (typeof applyDisplaySettings === "function") applyDisplaySettings();
_initVendorBulkBar();  renderMain();
  renderSettings();
  updateCloudButton();
  bindEvents();
  bindUIActions();
  bindSearch();
  setupRpcEventListeners();
  App.pmLoadShortcuts();
  pmUpdateCount();
bindProductsImport();
  bindClientsImport();  // إظهار شريط الفلاتر المحفوظة عند التحميل
  loadFilterFavourites();
  renderFavChips();

  // جلب بيانات Reports/Ventes/Retours (badges livraison) عند فتح التطبيق مباشرة
  // (كانت تُجلب فقط عند تغيير التاريخ، فتبقى الكروت فارغة عند التحميل الأول)
  _refreshRoundExtras();

  // Init auto-fetch engine
  AutoFetch._lastFetch = Date.now();
  AutoFetch.init();

  // Register service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
});

// ── Load data ─────────────────────────────────────────────────
async function loadData() {
  const data = await Storage.getMany(["settings","vendorLinks","vendorStats","vendorRefs","roundStatus"]);
  data.odooState  = await Storage.getOdooState();
  data.userStatus = await Storage.getUserStatus();
  App.settings = data.settings || { ...Storage.DEFAULT_SETTINGS };
  // ضمان وجود هيكل constat
  if (!App.settings.constat) App.settings.constat = _defaultConstatSettings();

  const s = App.settings;
  (s.vendors || []).forEach(v => {
    if (!v.label) v.label = shortLabel(v.name);
    if (!v.role)  v.role  = "prevente";
    if (v.role === "m&r" || v.role === "merchandiseur") v.role = "merch"; // migration ancien role
  });
  (s.workflows || []).forEach(w => {
    if (w.role === "m&r" || w.role === "merchandiseur") w.role = "merch"; // migration ancien role
  });
  if (s.maxTabs      == null) s.maxTabs      = 3;
  if (s.cardWidth    == null) s.cardWidth    = 380;
  if (s.cardHeight   == null) s.cardHeight   = 160;
  if (s.cardScale    == null) s.cardScale    = 100;
  if (s.iconCols     == null) s.iconCols     = 0;
  if (s.cols         == null) s.cols         = 0;
  if (s.fontSize     == null) s.fontSize     = 11;
  if (!s.cardLayouts)          s.cardLayouts  = {};
  if (!s.cardHeights)          s.cardHeights  = {};
  if (!s.baseUrlPayment)       s.baseUrlPayment = "";
  if (!s.payShortcuts)         s.payShortcuts = [];
  if (s.svCols       == null) s.svCols       = 2;
  if (s.svCardHeight == null) s.svCardHeight = 160;
  if (s.svCardScale  == null) s.svCardScale  = 80;

  ["prevente","livraison","mr"].forEach(m => {
    if (!s.cardLayouts[m]) s.cardLayouts[m] = JSON.parse(JSON.stringify(DEFAULT_CARD_LAYOUTS[m] || DEFAULT_CARD_LAYOUTS["prevente"]));
    if (s.cardHeights[m] == null) s.cardHeights[m] = DEFAULT_CARD_HEIGHTS[m] || 110;
  });

  _loadDateContext(data);
}

// ── RPC event listeners (replaces chrome.runtime.onMessage) ──
function setupRpcEventListeners() {
  window.addEventListener("wafa:FETCH_STARTED", e => {
    const { mode } = e.detail;
    App.isFetching = true;
    setFetchingUI(true);
    addNotif(`Récupération ${MODE_CFG[mode]?.label || mode}…`, "info");
  });

  window.addEventListener("wafa:LINKS_UPDATED", e => {
    const msg = e.detail;
    const ck  = msg.mode + "_" + getDateKey(msg.dateOffset ?? 0);
    updateCacheForContext(ck, { links: msg.links, stats: msg.stats, refs: msg.refs, roundStatus: msg.roundStatus, odooState: msg.odooState, userStatus: msg.userStatus });
    if (msg.stats && ck === _cacheKey()) updateStats(msg.stats);

    if (msg.mode !== App.currentMode) {
      Object.keys(App.activeOps).forEach(id => { if (App.activeOps[id]==="fetching") delete App.activeOps[id]; });
      addNotif(`${MODE_CFG[msg.mode]?.label || "Rounds"} récupéré ✓`, "success");
      const stillFetching = Object.values(App.activeOps).some(v => v === "fetching");
      if (!stillFetching) { App.isFetching = false; setFetchingUI(false); }
      return;
    }

    if (ck === _cacheKey()) {
      App.allLinks       = { ..._contextCache[ck].links };
      App.allRefs        = { ..._contextCache[ck].refs };
      App.allRoundStatus = { ..._contextCache[ck].roundStatus };
      App.allOdooState   = { ..._contextCache[ck].odooState };
      App.allUserStatus  = { ..._contextCache[ck].userStatus };
    }
    App.isFetching = false; setFetchingUI(false);
    Object.keys(App.activeOps).forEach(id => { if (App.activeOps[id]==="fetching") delete App.activeOps[id]; });
    renderVendors();
    updateCloseAllBtn();
    addNotif(`${MODE_CFG[msg.mode]?.label || "Rounds"} récupéré ✓`, "success");

    // Hors zone warnings
    const horsZoneWorkers = allWorkers().filter(w => w.role === msg.mode && App.allStats[w.id]?.horsZone);
    if (horsZoneWorkers.length) {
      addNotif(`⚠ Hors zone: ${horsZoneWorkers.map(w => w.label||w.name).join(", ")}`, "warning");
    }
  });

  window.addEventListener("wafa:FETCH_ERROR", e => {
    App.isFetching = false; setFetchingUI(false);
    Object.keys(App.activeOps).forEach(id => delete App.activeOps[id]);
    addNotif(e.detail.msg || "Erreur fetch", "error");
    renderVendors();
  });

  window.addEventListener("wafa:STATS_REFRESH_STARTED", e => {
    const { mode, count } = e.detail;
    addNotif(`Rafraîchissement stats ${MODE_CFG[mode]?.label||""} (${count})…`, "info");
  });

  window.addEventListener("wafa:STATS_REFRESH_DONE", e => {
    const { mode, done, total } = e.detail;
    addNotif(`Stats ${MODE_CFG[mode]?.label||""} ✓ (${done}/${total})`, "success");
  });

  window.addEventListener("wafa:STATS_UPDATED", e => {
    const msg = e.detail;
    if ((msg.dateOffset ?? 0) !== App.currentDateOffset || msg.mode !== App.currentMode) return;
    if (msg.stats) updateStats({ [msg.vendorId]: msg.stats });
    if (msg.ref) updateCacheForContext(_cacheKey(), { refs: { [msg.vendorId]: msg.ref } });
    App.allRefs = { ..._contextCache[_cacheKey()].refs };
    renderVendors();
  });

  window.addEventListener("wafa:LINK_FOUND", e => {
    const msg = e.detail;
    const _ckLF = msg.mode + "_" + getDateKey(msg.dateOffset ?? 0);
    updateCacheForContext(_ckLF, {
      links:      { [msg.vendorId]: msg.url },
      refs:       msg.ref        ? { [msg.vendorId]: msg.ref }        : {},
      odooState:  msg.state      ? { [msg.vendorId]: msg.state }      : {},
      userStatus: msg.userStatus ? { [msg.vendorId]: msg.userStatus } : {},
    });
    if (msg.stats) updateCacheForContext(_ckLF, { stats: { [msg.vendorId]: msg.stats } });
    delete App.activeOps[msg.vendorId];
    const stillFetching = Object.values(App.activeOps).some(v => v === "fetching");
    if (!stillFetching) { App.isFetching = false; setFetchingUI(false); }
    if (msg.mode !== App.currentMode || (msg.dateOffset ?? 0) !== App.currentDateOffset) return;
    App.allLinks      = { ..._contextCache[_ckLF].links };
    App.allRefs       = { ..._contextCache[_ckLF].refs };
    App.allOdooState  = { ..._contextCache[_ckLF].odooState };
    App.allUserStatus = { ..._contextCache[_ckLF].userStatus };
    if (msg.stats) updateStats({ [msg.vendorId]: msg.stats });
    renderVendors();
    const w = allWorkers().find(v => v.id === msg.vendorId);
    addNotif(`Lien sauvegardé: ${w?.label||msg.vendorId} ✓`, "success");
  });

  window.addEventListener("wafa:BL_PENDING_UPDATE", e => {
    const { vendorId, count, mode, dateKey } = e.detail;
    if (mode !== App.currentMode) return;
    if (dateKey !== getDateKey(App.currentDateOffset)) return;
    updateStats({ [vendorId]: { pendingBLs: count } });
    renderVendors();
  });
}

// ── Window Manager — نوافذ متعددة قابلة للسحب ─────────────────
const WM = {
  _wins: new Map(),   // key → { el, overlay }
  _z: 200,

  // مفتاح فريد لكل نافذة
  key(type, vendorId) { return `${type}_${vendorId}`; },

  // هل النافذة مفتوحة؟
  isOpen(type, vendorId) { return this._wins.has(this.key(type, vendorId)); },

  // إبراز نافذة موجودة (bring to front)
  focus(type, vendorId) {
    const w = this._wins.get(this.key(type, vendorId));
    if (!w) return false;
    w.el.style.zIndex = ++this._z;
    w.el.classList.add("wm-flash");
    setTimeout(() => w.el.classList.remove("wm-flash"), 400);
    return true;
  },

  // تسجيل نافذة جديدة
  register(type, vendorId, el) {
    const k = this.key(type, vendorId);
    el.style.zIndex = ++this._z;
    this._wins.set(k, { el });
    // رفع للأمام عند الضغط
    el.addEventListener("pointerdown", () => { el.style.zIndex = ++this._z; }, true);
  },

  // إلغاء تسجيل
  unregister(type, vendorId) {
    this._wins.delete(this.key(type, vendorId));
  },

  // إغلاق آخر نافذة (للـ Escape)
  closeLast() {
    if (!this._wins.size) return false;
    // آخر نافذة = أعلى z-index
    let topK = null, topZ = -1;
    for (const [k, w] of this._wins) {
      const z = parseInt(w.el.style.zIndex) || 0;
      if (z > topZ) { topZ = z; topK = k; }
    }
    if (topK) {
      const w = this._wins.get(topK);
      w.el.remove();
      this._wins.delete(topK);
    }
    return true;
  },

  // إغلاق جميع النوافذ
  closeAll() {
    for (const [, w] of this._wins) w.el.remove();
    this._wins.clear();
  },
};

// ── CSS flash + drag ──────────────────────────────────────────
(function _wmInjectStyles() {
  const s = document.createElement("style");
  s.textContent = `
    .wm-win {
      position: fixed;
      box-shadow: 0 8px 32px rgba(0,0,0,.18);
      border-radius: 10px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--border,#E2E8F0);
      background: var(--bg2,#fff);
      min-width: 320px;
      min-height: 120px;
      max-height: 96vh;
    }
    @keyframes wm-flash-anim {
      0%,100% { box-shadow: 0 8px 32px rgba(0,0,0,.18); }
      40%      { box-shadow: 0 0 0 3px var(--accent,#3B82F6), 0 8px 32px rgba(0,0,0,.18); }
    }
    .wm-flash { animation: wm-flash-anim .4s ease; }
    .wm-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border,#E2E8F0);
      flex-shrink: 0;
      cursor: grab;
      user-select: none;
      background: var(--bg2,#fff);
    }
    .wm-header:active { cursor: grabbing; }
    .wm-body {
      flex: 1;
      overflow-y: auto;
      overflow-x: auto;
    }
    .wm-close-btn {
      background: none; border: none;
      color: var(--text3,#94A3B8);
      cursor: pointer; font-size: 18px;
      line-height: 1; padding: 2px 6px;
      border-radius: 4px; flex-shrink: 0;
    }
    .wm-close-btn:hover { background: var(--bg3,#F1F5F9); }

    /* ── Resize handles ── */
    .wm-rz {
      position: absolute;
      z-index: 10;
    }
    .wm-rz-e  { top:10px; right:0;  width:5px; bottom:10px; cursor:e-resize;  }
    .wm-rz-s  { left:10px; bottom:0; height:5px; right:10px; cursor:s-resize;  }
    .wm-rz-se { right:0;  bottom:0; width:14px; height:14px; cursor:se-resize; }
    .wm-rz-w  { top:10px; left:0;   width:5px;  bottom:10px; cursor:w-resize;  }
    .wm-rz-n  { left:10px; top:0;   height:5px; right:10px;  cursor:n-resize;  }
    .wm-rz-ne { right:0;  top:0;   width:14px; height:14px;  cursor:ne-resize; }
    .wm-rz-sw { left:0;  bottom:0; width:14px; height:14px;  cursor:sw-resize; }
    .wm-rz-nw { left:0;  top:0;   width:14px; height:14px;   cursor:nw-resize; }
  `;
  document.head.appendChild(s);
})();

// ── Escape → إغلاق آخر نافذة ─────────────────────────────────
document.addEventListener("keydown", e => {
  if (e.key === "Escape") WM.closeLast();
});

// ── دالة مساعدة: جعل نافذة قابلة للسحب ──────────────────────
function _wmMakeDraggable(el, handle) {
  let ox = 0, oy = 0, sx = 0, sy = 0, dragging = false;

  // تحويل من flex-center إلى fixed coords عند أول سحب
  const _initPos = () => {
    if (el.dataset.wmPositioned) return;
    const r = el.getBoundingClientRect();
    el.style.left   = r.left + "px";
    el.style.top    = r.top  + "px";
    el.style.right  = "auto";
    el.style.bottom = "auto";
    el.style.transform = "none";
    el.dataset.wmPositioned = "1";
  };

  handle.addEventListener("pointerdown", e => {
    if (e.target.closest(".wm-close-btn")) return;
    _initPos();
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    ox = el.offsetLeft; oy = el.offsetTop;
    handle.setPointerCapture(e.pointerId);
    el.style.zIndex = ++WM._z;
  });
  handle.addEventListener("pointermove", e => {
    if (!dragging) return;
    el.style.left = (ox + e.clientX - sx) + "px";
    el.style.top  = (oy + e.clientY - sy) + "px";
  });
  handle.addEventListener("pointerup",    () => { dragging = false; });
  handle.addEventListener("pointercancel",() => { dragging = false; });
}

// ── تغيير حجم النافذة بالسحب ─────────────────────────────────
function _wmMakeResizable(el) {
  // إضافة 8 مقابض
  const dirs = ["n","s","e","w","ne","nw","se","sw"];
  dirs.forEach(d => {
    const h = document.createElement("div");
    h.className = `wm-rz wm-rz-${d}`;
    h.dataset.rzDir = d;
    el.appendChild(h);
  });

  // _initPos مشتركة: تحوّل إلى إحداثيات ثابتة
  const _initPos = () => {
    if (el.dataset.wmPositioned) return;
    const r = el.getBoundingClientRect();
    el.style.left      = r.left + "px";
    el.style.top       = r.top  + "px";
    el.style.right     = "auto";
    el.style.bottom    = "auto";
    el.style.transform = "none";
    el.dataset.wmPositioned = "1";
  };

  el.addEventListener("pointerdown", e => {
    const handle = e.target.closest(".wm-rz");
    if (!handle) return;
    e.preventDefault();
    e.stopPropagation();
    _initPos();

    const dir = handle.dataset.rzDir;
    const startX = e.clientX, startY = e.clientY;
    const r = el.getBoundingClientRect();
    const startW = r.width, startH = r.height;
    const startL = r.left,  startT = r.top;

    el.style.zIndex = ++WM._z;
    handle.setPointerCapture(e.pointerId);

    const onMove = ev => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const MIN_W = 320, MIN_H = 120;

      // ── عرض ──
      if (dir.includes("e")) {
        el.style.width = Math.max(MIN_W, startW + dx) + "px";
      }
      if (dir.includes("w")) {
        const nw = Math.max(MIN_W, startW - dx);
        el.style.width = nw + "px";
        el.style.left  = (startL + startW - nw) + "px";
      }
      // ── ارتفاع ──
      if (dir.includes("s")) {
        el.style.height = Math.max(MIN_H, startH + dy) + "px";
        el.style.maxHeight = "none";
      }
      if (dir.includes("n")) {
        const nh = Math.max(MIN_H, startH - dy);
        el.style.height    = nh + "px";
        el.style.maxHeight = "none";
        el.style.top       = (startT + startH - nh) + "px";
      }
    };

    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup",   onUp);
      handle.removeEventListener("pointercancel", onUp);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup",   onUp);
    handle.addEventListener("pointercancel", onUp);
  });
}

// ── بناء نافذة WM جاهزة (يُعاد استخدامها في كل modal) ────────
function _wmCreateWindow(type, vendorId, title, svgIcon, width = "520px") {
  const k = WM.key(type, vendorId);

  // إذا مفتوحة → أبرزها
  if (WM.isOpen(type, vendorId)) { WM.focus(type, vendorId); return null; }

  const el = document.createElement("div");
  el.className = "wm-win";
  el.id = `wm-${k}`;
  el.style.cssText = `width:100%;max-width:${width};top:60px;left:50%;transform:translateX(-50%);`;

  el.innerHTML = `
    <div class="wm-header" id="wm-hdr-${k}">
      <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">
        ${svgIcon}
        <span style="font-size:12px;font-weight:700;color:var(--text,#0F172A);
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(title)}</span>
      </div>
      <button class="wm-close-btn" id="wm-x-${k}" title="Fermer (Esc)">×</button>
    </div>
    <div class="wm-body" id="wm-body-${k}"></div>`;

  document.body.appendChild(el);
  WM.register(type, vendorId, el);
  _wmMakeDraggable(el, el.querySelector(`#wm-hdr-${k}`));
  _wmMakeResizable(el);

  // زر الإغلاق
  el.querySelector(`#wm-x-${k}`).addEventListener("click", () => {
    el.remove();
    WM.unregister(type, vendorId);
  });

  // تقليل الـ offset لكل نافذة جديدة
  const count = WM._wins.size;
  el.style.top  = (60 + (count - 1) * 30) + "px";
  el.style.left = `calc(50% + ${(count - 1) * 30}px)`;

  return { el, body: el.querySelector(`#wm-body-${k}`) };
}

// ── bindUIActions — event delegation for vendor cards ─────────
function bindUIActions() {
  const list = document.getElementById("vendorsList");
  if (!list) return;

  let _lpTimer = null;
  list.addEventListener("pointerdown", e => {
    const btn = e.target.closest(".vb");
    if (!btn) return;
    _lpTimer = setTimeout(() => {
      _lpTimer = null;
      btn.dataset._longPress = "1";
      _dispatchAction(btn, { ctrlKey:false, metaKey:false, _longPress:true });
    }, 700);
  });
  list.addEventListener("pointerup",     () => { clearTimeout(_lpTimer); _lpTimer = null; });
  list.addEventListener("pointercancel", () => { clearTimeout(_lpTimer); _lpTimer = null; });
  list.addEventListener("pointermove",   () => { clearTimeout(_lpTimer); _lpTimer = null; });

  list.addEventListener("click", e => {
    const cancelBtn = e.target.closest(".vc-cancel-btn");
    if (cancelBtn) {
      e.stopPropagation();
      delete App.activeOps[cancelBtn.dataset.vendor];
      rpcController.abort();
      renderVendors();
      addNotif("Opération annulée", "warning");
      return;
    }
    const btn = e.target.closest(".vb");
    if (!btn) return;
    if (btn.dataset._longPress === "1") { delete btn.dataset._longPress; return; }
    _dispatchAction(btn, e);
  });
// ── Split View — أحداث البطاقات ──────────────────────────────
  document.getElementById("splitViewOverlay")?.addEventListener("click", async e => {
    const btn = e.target.closest(".vb"); if (!btn) return;
    const svList = btn.closest(".sv-vendors-list"); if (!svList) return;
    if (btn.dataset._longPress === "1") { delete btn.dataset._longPress; return; }
    const savedMode   = App.currentMode;
const savedOffset = App.currentDateOffset;
const savedLinks       = App.allLinks;
const savedStats       = App.allStats;
const savedRefs        = App.allRefs;
const savedRoundStatus = App.allRoundStatus;
const savedOdooState   = App.allOdooState;
const savedUserStatus  = App.allUserStatus;
App.currentMode       = svList.dataset.svMode   || savedMode;
App.currentDateOffset = parseInt(svList.dataset.svOffset || String(savedOffset));
const _clickCtx = await _svLoadContext(App.currentMode, App.currentDateOffset);
App.allLinks       = _clickCtx.links;
App.allStats       = _clickCtx.stats;
App.allRefs        = _clickCtx.refs;
App.allRoundStatus = _clickCtx.roundStatus;
App.allOdooState   = _clickCtx.odooState;
App.allUserStatus  = _clickCtx.userStatus;
    try {
      await _dispatchAction(btn, e);
    } finally {
  App.currentMode       = savedMode;
  App.currentDateOffset = savedOffset;
  App.allLinks       = savedLinks;
  App.allStats       = savedStats;
  App.allRefs        = savedRefs;
  App.allRoundStatus = savedRoundStatus;
  App.allOdooState   = savedOdooState;
  App.allUserStatus  = savedUserStatus;
      await renderSplitView();
      _svApplySearch();
    }
  });
}

// ══════════════════════════════════════════════════════════════
// نافذة "Route" — تعرض زبائن مسار معيّن (partner_id) + يوم/أيام الزيارة
// وأسابيع الزيارة (S1-S4)، مصدرها planning.template.event.
// ⚠️ بنية الحقول مؤكَّدة فعليًا عبر fields_get + فحص بيانات حقيقية (وليست
// تخمينًا): كل صف يحمل 28 حقل boolean مباشرة على الموديل نفسه، بصيغة
// w{رقم الأسبوع 1-4}{اختصار اليوم الإنجليزي: mon/tue/wed/thu/fri/sat/sun}
// (مثل w1mon، w3fri، w4wed...) — true تعني: هذا الزبون يُزار في ذلك
// الأسبوع وذلك اليوم تحديدًا. حقل "weeks" (selection) وvisit_days_ids
// (one2many فرعي) اللذان ظهرا في fields_get لم يكونا هما المصدر الفعلي.
// ══════════════════════════════════════════════════════════════
const _ROUTE_WEEKS = [1, 2, 3, 4];
const _ROUTE_DAYS  = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
// Aucune semaine cochée = toutes les semaines (S1 à S4) implicitement.
function _effectiveWeeks(weeks) { return (weeks && weeks.length) ? weeks : _ROUTE_WEEKS; }
const _ROUTE_DAY_LABELS_FR = { mon: "Lun", tue: "Mar", wed: "Mer", thu: "Jeu", fri: "Ven", sat: "Sam", sun: "Dim" };
const _ROUTE_DAY_LABELS_EN = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

// ══════════════════════════════════════════════════════════════
// ── حساب مسافة القيادة الحقيقية بين زبائن محددين على "Carte de la route" ──
// نفس آلية إضافة carte des clients: ترتيب أولي تقريبي (Haversine/أقرب جار) ثم
// إرسال النقاط بهذا الترتيب لخدمة توجيه مجانية (OSRM Demo Server) تُعيد المسافة
// والزمن الحقيقيين عبر شبكة الطرق + هندسة المسار الكاملة لرسمها على الخريطة.
// ══════════════════════════════════════════════════════════════
const _RRMAP_OSRM_URL = "https://router.project-osrm.org/route/v1/driving/";

function _rrmapHaversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _rrmapNearestNeighborOrder(points) {
  const remaining = points.slice(1);
  const ordered = [points[0]];
  while (remaining.length) {
    const last = ordered[ordered.length - 1];
    let bestIdx = 0, bestDist = Infinity;
    remaining.forEach((p, idx) => {
      const d = _rrmapHaversineKm(last.lat, last.lng, p.lat, p.lng);
      if (d < bestDist) { bestDist = d; bestIdx = idx; }
    });
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }
  return ordered;
}

function _rrmapFormatDistanceKm(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}
function _rrmapFormatDurationMin(min) {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return `${h} h ${m} min`;
}

/** points: [{lat,lng}, ...] (2 على الأقل) → {distanceKm, durationMin, coordinates:[[lat,lng],...]} */
async function _rrmapFetchDrivingRoute(points) {
  if (!points || points.length < 2) throw new Error("Sélectionnez au moins 2 clients");
  const ordered = _rrmapNearestNeighborOrder(points);
  const coordsParam = ordered.map(p => `${p.lng},${p.lat}`).join(";");
  const url = `${_RRMAP_OSRM_URL}${coordsParam}?overview=full&geometries=geojson`;

  let response;
  try { response = await fetch(url); }
  catch (_) { throw new Error("Service de routage injoignable (vérifiez la connexion)"); }
  if (!response.ok) throw new Error(`Erreur du service de routage (${response.status})`);

  const data = await response.json();
  if (data.code !== "Ok" || !Array.isArray(data.routes) || !data.routes.length) {
    throw new Error("Aucun itinéraire trouvé entre les clients sélectionnés");
  }
  const route = data.routes[0];
  return {
    distanceKm: route.distance / 1000,
    durationMin: route.duration / 60,
    coordinates: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
  };
}

function _rrmapClearRouteLine() {
  if (_rrmapRouteLine && _rrmapMap) { try { _rrmapMap.removeLayer(_rrmapRouteLine); } catch (_) {} }
  _rrmapRouteLine = null;
}

function _rrmapDrawRouteLine(coordinates) {
  _rrmapClearRouteLine();
  if (!_rrmapMap || !coordinates?.length) return;
  _rrmapRouteLine = L.polyline(coordinates, { color: "#3B82F6", weight: 3, opacity: .75, dashArray: "6 6" }).addTo(_rrmapMap);
}

/** يحسب مسافة القيادة بين الزبائن المحددين حاليًا ويعرضها في شريط التحديد. */
async function _rrmapUpdateDistance() {
  const st = _rrmapState;
  const distEl = document.getElementById("rrmapSelectDistance");
  if (!distEl) return;
  const myToken = ++_rrmapDistanceToken;

  if (st.selected.size < 2) {
    distEl.style.display = "none";
    distEl.textContent = "";
    _rrmapClearRouteLine();
    return;
  }

  const points = st.allPoints.filter(p => st.selected.has(p.eventId) && p.lat && p.lng);
  if (points.length < 2) {
    distEl.style.display = "inline";
    distEl.style.color = "#F87171";
    distEl.textContent = "Localisation manquante";
    _rrmapClearRouteLine();
    return;
  }

  distEl.style.display = "inline";
  distEl.style.color = "#93C5FD";
  distEl.textContent = "⏳ Calcul distance…";

  try {
    const result = await _rrmapFetchDrivingRoute(points);
    if (myToken !== _rrmapDistanceToken) return; // التحديد تغيّر أثناء الحساب
    distEl.style.color = "#93C5FD";
    distEl.textContent = `🚗 ${_rrmapFormatDistanceKm(result.distanceKm)} (~${_rrmapFormatDurationMin(result.durationMin)})`;
    _rrmapDrawRouteLine(result.coordinates);
  } catch (err) {
    if (myToken !== _rrmapDistanceToken) return;
    distEl.style.color = "#F87171";
    distEl.textContent = err.message || "Distance indisponible";
    _rrmapClearRouteLine();
  }
}
function _routeDaysActiveLabelEN(row) {
  const days = _ROUTE_DAYS.filter(d => _ROUTE_WEEKS.some(w => row[`w${w}${d}`] === true));
  return days.length ? days.map(d => _ROUTE_DAY_LABELS_EN[d]).join(", ") : "—";
}

// weeksActive: تُرجع مثلًا [1,3] إن كان الزبون يُزار في الأسبوعين 1 و3
// (بغض النظر عن اليوم). daysActiveLabel: تُرجع "Lun, Mer" إن كانت
// زياراته تقع أيام الاثنين والأربعاء (بغض النظر عن الأسبوع).
function _routeWeeksActive(row) {
  return _ROUTE_WEEKS.filter(w => _ROUTE_DAYS.some(d => row[`w${w}${d}`] === true));
}
function _routeDaysActiveLabel(row) {
  const days = _ROUTE_DAYS.filter(d => _ROUTE_WEEKS.some(w => row[`w${w}${d}`] === true));
  return days.length ? days.map(d => _ROUTE_DAY_LABELS_FR[d]).join(", ") : "—";
}

// ══════════════════════════════════════════════════════════════
// نظام تنقّل "Back" بسيط عبر مراحل تدفّق route: بدل إغلاق النافذة
// الحالية كليًا عند الانتقال للأمام، نُخفيها فقط (display:none) ونضعها
// في مكدّس (_routeNavStack). زر "Back" في الشاشة التالية يزيل نفسه
// ويُعيد إظهار الشاشة المخبَّأة السابقة — فتُستعاد حالتها (بحث/فلاتر/
// اختيارات) كما كانت تلقائيًا لأن الـDOM لم يُلمس. الإغلاق الكامل (×)
// يُفرّغ المكدّس بالكامل (يُزيل كل شيء دفعة واحدة). "routeCustomersModal"
// عنصر ثابت في index.html (لا يُنشأ ديناميكيًا) لذا لا يُزال أبدًا، فقط
// يُخفى/يُظهر.
// ══════════════════════════════════════════════════════════════
let _routeNavStack = [];
const _ROUTE_STATIC_MODAL_IDS = new Set(["routeCustomersModal"]);

function _routeNavRemoveOrHide(id) {
  const el = document.getElementById(id);
  if (!el) return;
  if (_ROUTE_STATIC_MODAL_IDS.has(id)) el.style.display = "none";
  else el.remove();
}
// يُخفي الشاشة الحالية (prevId) ويضعها في المكدّس قبل فتح الشاشة التالية
function _routeNavHide(prevId) {
  const el = document.getElementById(prevId);
  if (el) { el.style.display = "none"; _routeNavStack.push(prevId); }
}
// زر Back: يُزيل الشاشة الحالية (curId) ويُعيد إظهار ما فوقها في المكدّس
function _routeNavBack(curId) {
  document.getElementById(curId)?.remove();
  const prevId = _routeNavStack.pop();
  if (prevId) {
    const el = document.getElementById(prevId);
    if (el) el.style.display = "flex";
  }
}
// إغلاق كامل (×): يُزيل الشاشة الحالية + كل ما تراكم في المكدّس
function _routeNavCloseAll(curId) {
  _routeNavRemoveOrHide(curId);
  while (_routeNavStack.length) {
    _routeNavRemoveOrHide(_routeNavStack.pop());
  }
}

// ── زر تصميم أزرار الفلترة (Days/Weeks) — مشترك بين نافذة "Ouvrir route"
// ونافذة "Edit → Show all/By day/Search" (rfm) ──
function _btnStyle(active, disabled) {
  if (disabled) return "font-size:11px;padding:4px 9px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text3);opacity:.4;cursor:not-allowed";
  if (active)   return "font-size:11px;padding:4px 9px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;font-weight:600";
  return "font-size:11px;padding:4px 9px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);cursor:pointer";
}

// ── حالة نافذة "Ouvrir route" (routeCustomersModal) — بحث + فلترة يوم/
// أسبوع (AND/OR) بنفس منطق rfm، بالكامل client-side بدون طلب جديد للسيرفر.
// ══════════════════════════════════════════════════════════════
let _rcmState = {
  rows: [], worker: null, baseUrl: null, routeId: null,
  searchQuery: "", dayFilter: new Set(), dayMode: "OR",
  weekFilter: new Set(), weekMode: "OR",
};

// ── خزنة نتائج route لكل route لحالها (per-route cache) ──────────
// المفتاح: routeId. القيمة: { rows, promise, error }.
// - "rows": النتيجة الجاهزة (إن وُجدت) — تُعرض فورًا دون إعادة طلب.
// - "promise": الطلب الجاري حاليًا (إن وُجد) — يُكمل بالخلفية دون إلغاء
//   حتى لو المستخدم فتح route أخرى قبل اكتماله.
// - "error": رسالة الخطأ الأخيرة (لا تُخزَّن نتيجة فاشلة كـ"rows"، تُعاد
//   المحاولة تلقائيًا في المرة القادمة).
// ملاحظة: النافذة (routeCustomersModal) نفسها singleton (نافذة واحدة)،
// فهذه الخزنة لا "تفتح عدة نوافذ معًا" بل تمنع إعادة الانتظار عند
// الرجوع لاحقًا إلى route سبق تحميلها، وتسمح بتبديل سريع بين routes
// دون انتظار أو إلغاء أي طلب.
const _routeCustomersCache = new Map();

function _rcmFetchRoute(baseUrl, routeId) {
  let entry = _routeCustomersCache.get(routeId);
  if (entry && (entry.rows || entry.promise)) return entry;

  entry = { rows: null, promise: null, error: null };
  entry.promise = rpcController.fetchRouteCustomers(baseUrl, routeId)
    .then(rows => {
      entry.rows = rows;
      entry.promise = null;
      // إن كان المستخدم لا يزال واقفًا على نفس هذه الـroute → حدّث الشاشة فورًا
      if (_rcmState.routeId === routeId) {
        _rcmState.rows = rows;
        _renderRouteCustomersTable();
      }
      return rows;
    })
    .catch(e => {
      console.error("[route] échec fetchRouteCustomers (route " + routeId + "):", e);
      entry.error = e.message || String(e);
      entry.promise = null;
      if (_rcmState.routeId === routeId) {
        document.getElementById("routeCustomersCount").textContent = "Erreur de chargement";
        addNotif("Échec chargement route: " + entry.error, "error");
      }
      // لا نُخزّن الفشل بالخزنة (entry.rows تبقى null) → إعادة محاولة تلقائية لاحقًا
    });
  _routeCustomersCache.set(routeId, entry);
  return entry;
}

function _rcmRowActiveDays(r) {
  return _ROUTE_DAYS.filter(d => _ROUTE_WEEKS.some(w => r[`w${w}${d}`] === true));
}
function _rcmSearchFiltered() {
  return _rcmState.searchQuery ? rpcController.filterRouteClients(_rcmState.rows, _rcmState.searchQuery) : _rcmState.rows;
}
function _rcmByDay(rowsIn) {
  if (!_rcmState.dayFilter.size) return rowsIn;
  return rowsIn.filter(r => {
    const activeDays = _rcmRowActiveDays(r);
    return _rcmState.dayMode === "OR"
      ? [..._rcmState.dayFilter].some(d => activeDays.includes(d))
      : [..._rcmState.dayFilter].every(d => activeDays.includes(d));
  });
}
function _rcmByWeek(rowsIn) {
  if (!_rcmState.weekFilter.size) return rowsIn;
  return rowsIn.filter(r => {
    const activeWeeks = _routeWeeksActive(r);
    return _rcmState.weekMode === "OR"
      ? [..._rcmState.weekFilter].some(w => activeWeeks.includes(w))
      : [..._rcmState.weekFilter].every(w => activeWeeks.includes(w));
  });
}
function _rcmDisplayRows() {
  return _rcmByWeek(_rcmByDay(_rcmSearchFiltered()));
}

// ── تُنشئ شريط البحث/الفلترة وزر "Edit" مرة واحدة فقط (idempotent) ──
function _ensureRouteCustomersFilterBar() {
  const openLink = document.getElementById("btnRouteOpenInOdoo");
  if (openLink && !document.getElementById("rcmEditBtn")) {
    const editBtn = document.createElement("button");
    editBtn.id = "rcmEditBtn";
    editBtn.className = "btn-tool";
    editBtn.type = "button";
    editBtn.style.cssText = "font-size:11px;text-decoration:none;display:inline-flex;align-items:center;gap:5px;margin-left:6px";
    editBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
      </svg> Edit`;
    openLink.insertAdjacentElement("afterend", editBtn);
    editBtn.onclick = () => {
      const w = _rcmState.worker, baseUrl = _rcmState.baseUrl;
      if (!w || !baseUrl) return;
      _routeNavStack = []; // نقطة دخول جديدة (من "Ouvrir route" مباشرة)
      _routeNavHide("routeCustomersModal");
      openRouteFilteredResultsModal(w, [..._rcmState.rows], "Show all");
    };
  }

  if (document.getElementById("rcmFilterBar")) return;
  const countRow = document.getElementById("routeCustomersCount")?.closest("div");
  if (!countRow) return;

  // ملاحظة: "Sauvegarder filtre" غير متوفرة هنا (Ouvrir route / Show all) —
  // متوفرة فقط في قسم البحث عن كروت الـroute (Search customer)، انظر rfm أدناه.

  const bar = document.createElement("div");
  bar.id = "rcmFilterBar";
  bar.style.cssText = "padding:8px 14px 0";
  bar.innerHTML = `
    <div style="position:relative;margin:4px 0 8px">
      <input type="text" id="rcmSearchInput" class="ap-input" placeholder="Search by name or reference…" autocomplete="off"/>
    </div>
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:6px">
      <span style="font-size:10px;color:var(--text3);min-width:34px">Days</span>
      <div id="rcmDayBtns" style="display:flex;flex-wrap:wrap;gap:4px"></div>
      <button id="rcmDayMode" type="button" class="ap-btn" style="font-size:10px;padding:3px 8px;background:var(--bg3);border:1px solid var(--border);color:var(--text2)">OR</button>
    </div>
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:4px">
      <span style="font-size:10px;color:var(--text3);min-width:34px">Weeks</span>
      <div id="rcmWeekBtns" style="display:flex;flex-wrap:wrap;gap:4px"></div>
      <button id="rcmWeekMode" type="button" class="ap-btn" style="font-size:10px;padding:3px 8px;background:var(--bg3);border:1px solid var(--border);color:var(--text2)">OR</button>
    </div>`;
  countRow.insertAdjacentElement("afterend", bar);

  document.getElementById("rcmSearchInput").addEventListener("input", (e) => {
    _rcmState.searchQuery = e.target.value.trim();
    _renderRouteCustomersTable();
  });
}

function _renderRouteCustomersFilterButtons() {
  const baseAfterSearch = _rcmSearchFiltered();
  const dayAvailRows  = _rcmByWeek(baseAfterSearch);
  const weekAvailRows = _rcmByDay(baseAfterSearch);
  const availableDays  = new Set(dayAvailRows.flatMap(r => _rcmRowActiveDays(r)));
  const availableWeeks = new Set(weekAvailRows.flatMap(r => _routeWeeksActive(r)));

  const dayBtns = document.getElementById("rcmDayBtns");
  if (dayBtns) {
    dayBtns.innerHTML = _ROUTE_DAYS.map(d => {
      const active   = _rcmState.dayFilter.has(d);
      const disabled = !availableDays.has(d) && !active;
      return `<button type="button" class="rcm-day-btn" data-day="${d}" ${disabled ? "disabled" : ""}
        style="${_btnStyle(active, disabled)}">${_ROUTE_DAY_LABELS_EN[d]}</button>`;
    }).join("");
    dayBtns.querySelectorAll(".rcm-day-btn:not([disabled])").forEach(btn => {
      btn.onclick = () => {
        const d = btn.dataset.day;
        if (_rcmState.dayFilter.has(d)) _rcmState.dayFilter.delete(d); else _rcmState.dayFilter.add(d);
        _renderRouteCustomersTable();
      };
    });
  }

  const weekBtns = document.getElementById("rcmWeekBtns");
  if (weekBtns) {
    weekBtns.innerHTML = _ROUTE_WEEKS.map(w => {
      const active   = _rcmState.weekFilter.has(w);
      const disabled = !availableWeeks.has(w) && !active;
      return `<button type="button" class="rcm-week-btn" data-week="${w}" ${disabled ? "disabled" : ""}
        style="${_btnStyle(active, disabled)}">S${w}</button>`;
    }).join("");
    weekBtns.querySelectorAll(".rcm-week-btn:not([disabled])").forEach(btn => {
      btn.onclick = () => {
        const w = parseInt(btn.dataset.week, 10);
        if (_rcmState.weekFilter.has(w)) _rcmState.weekFilter.delete(w); else _rcmState.weekFilter.add(w);
        _renderRouteCustomersTable();
      };
    });
  }

  const dayModeBtn = document.getElementById("rcmDayMode");
  if (dayModeBtn) {
    dayModeBtn.textContent = _rcmState.dayMode;
    dayModeBtn.onclick = () => { _rcmState.dayMode = _rcmState.dayMode === "OR" ? "AND" : "OR"; _renderRouteCustomersTable(); };
  }
  const weekModeBtn = document.getElementById("rcmWeekMode");
  if (weekModeBtn) {
    weekModeBtn.textContent = _rcmState.weekMode;
    weekModeBtn.onclick = () => { _rcmState.weekMode = _rcmState.weekMode === "OR" ? "AND" : "OR"; _renderRouteCustomersTable(); };
  }
}

function _renderRouteCustomersTable() {
  _renderRouteCustomersFilterButtons();
  const displayRows = _rcmDisplayRows();
  const tbody   = document.getElementById("routeCustomersTbody");
  const emptyEl = document.getElementById("routeCustomersEmpty");
  const countEl = document.getElementById("routeCustomersCount");
  if (countEl) countEl.textContent = `${displayRows.length} client(s)`;
  if (!tbody) return;
  if (!displayRows.length) {
    tbody.innerHTML = "";
    if (emptyEl) emptyEl.style.display = "block";
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";
  tbody.innerHTML = displayRows.map(r => {
    const partner = Array.isArray(r.partner_id) ? r.partner_id[1] : "—";
    const ref = r._partnerRef || "—";
    const day = _routeDaysActiveLabel(r);
    const weeksActive = _routeWeeksActive(r);
    const weekCells = _ROUTE_WEEKS.map(w =>
      `<td style="padding:6px 8px;text-align:center">${weeksActive.includes(w) ? "✕" : ""}</td>`
    ).join("");
    return `<tr style="border-bottom:1px solid var(--border,#2a2a2a)">
      <td style="padding:6px 8px">${escHtml(partner)}</td>
      <td style="padding:6px 8px">${escHtml(String(ref))}</td>
      <td style="padding:6px 8px">${escHtml(day)}</td>
      ${weekCells}
    </tr>`;
  }).join("");
}

// ══════════════════════════════════════════════════════════════
// قسم "Route" — mode جديد يعرض كل الـroutes (planning.template)
// كـ"كروت" (بصريًا على غرار كروت العمال vc: عنوان + صف أزرار)، مع
// بحث/فلترة نصية client-side بالاسم أو الرقم فقط.
// ══════════════════════════════════════════════════════════════
let _routesViewState = { allRoutes: [], loaded: false, searchQuery: "", showHidden: false, selected: new Set() };

// ── إدارة routes المخفية (محفوظة في App.settings.hiddenRoutes) ──
function _getHiddenRoutes() {
  if (!App.settings.hiddenRoutes) App.settings.hiddenRoutes = [];
  return App.settings.hiddenRoutes;
}
function _isRouteHidden(id) {
  return _getHiddenRoutes().includes(String(id));
}
function _toggleRouteHidden(id) {
  const ids = _getHiddenRoutes();
  const sid = String(id);
  const idx = ids.indexOf(sid);
  if (idx >= 0) ids.splice(idx, 1);
  else ids.push(sid);
  App.settings.hiddenRoutes = ids;
  Storage.saveSettings(App.settings).catch(() => {});
  if (typeof FirebaseSync !== "undefined") {
    FirebaseSync.pushRouteSettings({ hiddenRoutes: ids })
      .catch(e => console.error("[FirebaseSync] hiddenRoutes:", e));
  }
}

// ── مفضلات فلاتر route (منفصلة عن مفضلات queryBuilder) ──────────
// تُخزَّن في App.settings.routeFilterFavourites وتُزامَن سحابيًا.
function _loadRouteFavourites() {
  if (!App.settings.routeFilterFavourites) App.settings.routeFilterFavourites = [];
  App.routeFilterFavourites = App.settings.routeFilterFavourites;
}
function _saveRouteFavourites() {
  App.settings.routeFilterFavourites = App.routeFilterFavourites;
  Storage.saveSettings(App.settings).catch(() => {});
  if (typeof FirebaseSync !== "undefined") {
    FirebaseSync.pushRouteSettings({ routeFilterFavourites: App.routeFilterFavourites })
      .catch(e => console.error("[FirebaseSync] routeFilterFavourites:", e));
  }
}

function _renderRouteFavBar(containerId, applyFav) {
  _loadRouteFavourites();
  const favs = App.routeFilterFavourites;
  const bar = document.getElementById(containerId);
  if (!bar) return;
  bar.innerHTML = "";
  if (!favs.length) { bar.style.display = "none"; return; }
  bar.style.display = "flex";
  bar.style.flexWrap = "wrap";
  bar.style.gap = "4px";
  favs.forEach((fav, i) => {
    const wrap = document.createElement("span");
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:1px";
    const chip = document.createElement("button");
    chip.className = "qb-fav-chip qb-fav-chip--bar";
    chip.textContent = fav.label;
    chip.title = fav.label;
    chip.onclick = () => { applyFav(fav); };
    const del = document.createElement("button");
    del.style.cssText = "border:none;background:none;color:var(--text3);cursor:pointer;padding:0 2px;font-size:11px;line-height:1";
    del.textContent = "✕";
    del.title = "Supprimer ce favori";
    del.onclick = (e) => {
      e.stopPropagation();
      App.routeFilterFavourites.splice(i, 1);
      _saveRouteFavourites();
      _renderRouteFavBar(containerId, applyFav);
    };
    wrap.appendChild(chip);
    wrap.appendChild(del);
    bar.appendChild(wrap);
  });
}

function _saveNewRouteFav(getSnapshot, containerId, applyFav) {
  _loadRouteFavourites();
  const label = prompt("Nom du favori:");
  if (!label?.trim()) return;
  const trimmed = label.trim();
  if (App.routeFilterFavourites.some(f => f.label.toLowerCase() === trimmed.toLowerCase())) {
    alert(`Un favori nommé "${trimmed}" existe déjà.`); return;
  }
  App.routeFilterFavourites.push({ label: trimmed, ...getSnapshot() });
  _saveRouteFavourites();
  _renderRouteFavBar(containerId, applyFav);
}

// ── فلترة بسيطة بنفس أسلوب البحث الذكي المستخدم بباقي المشروع (tokens،
// يتجاهل ترتيب/مسافات، ويطابق الاسم أو الرقم) ──
function _routesFilterList(rows, query) {
  const tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return rows;
  return (rows || []).filter(r => {
    const name = String(r.name || "").toLowerCase();
    const id   = String(r.id ?? "").toLowerCase();
    return tokens.every(t => name.includes(t) || id.includes(t));
  });
}

function _renderRoutesList() {
  const container = document.getElementById("routesListArea");
  if (!container) return;

  const allFiltered = _routesFilterList(_routesViewState.allRoutes, _routesViewState.searchQuery);
  const hiddenIds   = _getHiddenRoutes();
  const showHidden  = _routesViewState.showHidden;
  const visibleRows = allFiltered.filter(r => !_isRouteHidden(r.id));
  const hiddenRows  = allFiltered.filter(r => _isRouteHidden(r.id));
  const rows        = showHidden ? allFiltered : visibleRows;

  // ── شريط "إظهار المخفية" — فوق الشبكة مباشرةً ──
  let hiddenBar = document.getElementById("routesHiddenBar");
  if (!hiddenBar) {
    hiddenBar = document.createElement("div");
    hiddenBar.id = "routesHiddenBar";
    hiddenBar.style.cssText = "padding:0 14px 8px;display:flex;align-items:center;gap:8px;flex-shrink:0";
    container.parentElement?.insertBefore(hiddenBar, container);
  }
  if (hiddenRows.length) {
    hiddenBar.innerHTML = `
      <button id="routesToggleHidden" class="btn-tool" style="font-size:11px;display:flex;align-items:center;gap:5px;padding:5px 10px;
        ${showHidden ? "border-color:var(--accent);background:var(--accent);color:#fff" : ""}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          ${showHidden
            ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
              <line x1="1" y1="1" x2="23" y2="23"/>`
            : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`}
        </svg>
        ${showHidden ? "Masquer les cachées" : `Afficher les cachées (${hiddenRows.length})`}
      </button>`;
    document.getElementById("routesToggleHidden").onclick = () => {
      _routesViewState.showHidden = !_routesViewState.showHidden;
      _renderRoutesList();
    };
  } else {
    hiddenBar.innerHTML = "";
  }

  if (!rows.length) {
    container.innerHTML = `<div style="padding:30px;text-align:center;color:var(--text2);font-size:13px">
      ${_routesViewState.loaded ? "Aucune route trouvée." : "Chargement…"}
    </div>`;
    return;
  }

  const selCount = _routesViewState.selected.size;
  const bulkBarHtml = `
    <div id="routesBulkBar" style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;position:sticky;top:0;z-index:5;background:var(--bg,#F8FAFC);padding:6px 0">
      <button id="routesSelectAllBtn" class="btn-tool" style="font-size:11px;padding:5px 10px">Tout sélectionner</button>
      <button id="routesSelectNoneBtn" class="btn-tool" style="font-size:11px;padding:5px 10px" ${selCount ? "" : "disabled"}>Aucun</button>
      <button id="routesMultiMapBtn" class="btn-tool" style="font-size:11px;padding:5px 10px;display:flex;align-items:center;gap:5px;
        ${selCount ? "border-color:var(--accent);background:var(--accent);color:#fff" : "opacity:.5;cursor:not-allowed"}" ${selCount ? "" : "disabled"}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>
        </svg>
        Carte groupée${selCount ? ` (${selCount})` : ""}
      </button>
    </div>`;

  container.innerHTML = `
    ${bulkBarHtml}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">
      ${rows.map(r => {
        const hidden = _isRouteHidden(r.id);
        const checked = _routesViewState.selected.has(String(r.id));
        return `
        <div class="vc" data-route-id="${r.id}" style="border:1px solid var(--border);border-radius:10px;
          background:var(--bg2);padding:10px 12px;display:flex;flex-direction:column;gap:8px;
          ${hidden ? "opacity:0.5;border-style:dashed" : ""}">
          <div style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:var(--text)">
            ${hidden ? "" : `<input type="checkbox" class="rv-select-cb" data-route-id="${r.id}" ${checked ? "checked" : ""} title="Sélectionner" style="flex-shrink:0"/>`}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;color:var(--accent)">
              <path d="M3 17c5-10 13-10 18 0"/><circle cx="3" cy="17" r="2"/><circle cx="21" cy="17" r="2"/>
            </svg>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${escHtml(r.name || String(r.id))}</span>
            <button class="rv-hide icon-btn-sm" data-route-id="${r.id}" title="${hidden ? "Afficher" : "Masquer"}"
              style="flex-shrink:0;opacity:0.6;padding:2px">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                ${hidden
                  ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>`
                  : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`}
              </svg>
            </button>
          </div>
          ${hidden ? "" : `<div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn-tool rv-open" data-route-id="${r.id}" style="font-size:11px;flex:1;min-width:80px;display:flex;align-items:center;justify-content:center;gap:5px;padding:6px 8px">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Ouvrir
            </button>
            <button class="btn-tool rv-add" data-route-id="${r.id}" style="font-size:11px;flex:1;min-width:80px;display:flex;align-items:center;justify-content:center;gap:5px;padding:6px 8px">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
                <line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/>
              </svg>
              Ajouter
            </button>
            <button class="btn-tool rv-edit" data-route-id="${r.id}" style="font-size:11px;flex:1;min-width:80px;display:flex;align-items:center;justify-content:center;gap:5px;padding:6px 8px">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              Edit
            </button>
            <button class="btn-tool rv-map" data-route-id="${r.id}" title="Carte de la route" style="font-size:11px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;padding:6px 8px">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>
              </svg>
            </button>
          </div>`}
        </div>`;
      }).join("")}
    </div>`;

  container.querySelectorAll(".rv-hide").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      _toggleRouteHidden(btn.dataset.routeId);
      _renderRoutesList();
    };
  });
  container.querySelectorAll(".rv-open").forEach(btn => {
    btn.onclick = () => {
      const r = _routesViewState.allRoutes.find(x => String(x.id) === btn.dataset.routeId);
      if (r) openRouteCustomersModal({ routeId: r.id, routeName: r.name });
    };
  });
  container.querySelectorAll(".rv-add").forEach(btn => {
    btn.onclick = () => {
      const r = _routesViewState.allRoutes.find(x => String(x.id) === btn.dataset.routeId);
      if (r) openAddClientToRouteModal({ routeId: r.id, routeName: r.name });
    };
  });
  container.querySelectorAll(".rv-edit").forEach(btn => {
    btn.onclick = () => {
      const r = _routesViewState.allRoutes.find(x => String(x.id) === btn.dataset.routeId);
      if (!r) return;
      _routeNavStack = []; // نقطة دخول جديدة (من قسم Route مباشرة)
      openRouteEditHubModal({ routeId: r.id, routeName: r.name });
    };
  });
  container.querySelectorAll(".rv-map").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const r = _routesViewState.allRoutes.find(x => String(x.id) === btn.dataset.routeId);
      if (r) openRouteMapModal({ routeId: r.id, routeName: r.name });
    };
  });
  container.querySelectorAll(".rv-select-cb").forEach(cb => {
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => {
      const id = cb.dataset.routeId;
      if (cb.checked) _routesViewState.selected.add(id);
      else _routesViewState.selected.delete(id);
      _renderRoutesList();
    };
  });
  document.getElementById("routesSelectAllBtn").onclick = () => {
    rows.forEach(r => { if (!_isRouteHidden(r.id)) _routesViewState.selected.add(String(r.id)); });
    _renderRoutesList();
  };
  document.getElementById("routesSelectNoneBtn").onclick = () => {
    _routesViewState.selected.clear();
    _renderRoutesList();
  };
  document.getElementById("routesMultiMapBtn").onclick = () => {
    if (!_routesViewState.selected.size) return;
    const selRoutes = _routesViewState.allRoutes.filter(x => _routesViewState.selected.has(String(x.id)));
    if (selRoutes.length === 1) {
      openRouteMapModal({ routeId: selRoutes[0].id, routeName: selRoutes[0].name });
    } else {
      openRouteMapModal({
        routeId: selRoutes.map(r => r.id).join(","),
        routeName: `${selRoutes.length} routes sélectionnées`,
        _multiRoutes: selRoutes.map(r => ({ id: r.id, name: r.name })),
      });
    }
  };
}

async function renderRoutesView(forceReload) {
  const searchInput = document.getElementById("routesSearchInput");
  if (searchInput && !searchInput._wired) {
    searchInput._wired = true;
    searchInput.addEventListener("input", (e) => {
      _routesViewState.searchQuery = e.target.value.trim();
      _renderRoutesList();
    });
  }

  const saveFavBtn = document.getElementById("routesSaveFav");
  if (saveFavBtn && !saveFavBtn._wired) {
    saveFavBtn._wired = true;
    const _routesGetSnapshot = () => ({ searchQuery: _routesViewState.searchQuery });
    const _routesApplyFav = (fav) => {
      _routesViewState.searchQuery = fav.searchQuery || "";
      const inp = document.getElementById("routesSearchInput");
      if (inp) inp.value = _routesViewState.searchQuery;
      _renderRoutesList();
    };
    saveFavBtn.onclick = () => {
      _saveNewRouteFav(_routesGetSnapshot, "routesFavBar", _routesApplyFav);
    };
    _renderRouteFavBar("routesFavBar", _routesApplyFav);
  }

  if (_routesViewState.loaded && !forceReload) {
    _renderRoutesList();
    return;
  }
  const baseUrl = getOdooBase();
  if (!baseUrl) { addNotif("URL Odoo non configurée", "error"); return; }
  _renderRoutesList(); // "Chargement…"
  try {
    const rows = await rpcController.fetchAllRoutes(baseUrl);
    _routesViewState.allRoutes = rows;
    _routesViewState.loaded = true;
    _renderRoutesList();
  } catch (e) {
    console.error("[route] échec fetchAllRoutes:", e);
    addNotif("Échec chargement des routes: " + e.message, "error");
    const container = document.getElementById("routesListArea");
    if (container) container.innerHTML = `<div style="padding:30px;text-align:center;color:var(--red,#dc2626);font-size:13px">Erreur de chargement.</div>`;
  }
}

// ── نافذة "Route" — hub بأزرار (Ouvrir route / Ajouter client / ...)
// تظهر عند الضغط على زر route بدل عرض كل الزبائن مباشرة.
function openRouteHubModal(worker) {
  if (!worker?.routeId) { addNotif("Aucune route associée à cet agent", "error"); return; }
  _routeNavStack = []; // نقطة بداية جديدة لتدفّق route — لا رجوع قبلها
  document.getElementById("routeHubModal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "routeHubModal";
  overlay.className = "ap-overlay";
  overlay.innerHTML = `
    <div class="ap-modal" style="max-width:320px">
      <div class="ap-header">
        <span class="ap-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            style="margin-right:5px;vertical-align:middle">
            <path d="M3 17c5-10 13-10 18 0"/><circle cx="3" cy="17" r="2"/><circle cx="21" cy="17" r="2"/>
          </svg>
          Route — ${escHtml(worker.routeName || worker.routeId)}
        </span>
        <button class="ap-close" id="rhClose">×</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px">
        <button id="rhOpenRoute" class="btn-tool" style="font-size:12px;display:flex;align-items:center;gap:8px;padding:10px 12px;justify-content:flex-start">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
          Ouvrir route
        </button>
        <button id="rhAddClient" class="btn-tool" style="font-size:12px;display:flex;align-items:center;gap:8px;padding:10px 12px;justify-content:flex-start">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
            <line x1="19" y1="8" x2="19" y2="14"/>
            <line x1="16" y1="11" x2="22" y2="11"/>
          </svg>
          Ajouter un client
        </button>
        <button id="rhEditRoute" class="btn-tool" style="font-size:12px;display:flex;align-items:center;gap:8px;padding:10px 12px;justify-content:flex-start">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          Edit
        </button>
        <button id="rhShowMap" class="btn-tool" style="font-size:12px;display:flex;align-items:center;gap:8px;padding:10px 12px;justify-content:flex-start">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>
          </svg>
          Carte de la route
        </button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const closeModal = () => overlay.remove();
  document.getElementById("rhClose").onclick = closeModal;
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

  document.getElementById("rhOpenRoute").onclick = () => {
    closeModal();
    openRouteCustomersModal(worker);
  };
  document.getElementById("rhAddClient").onclick = () => {
    closeModal();
    openAddClientToRouteModal(worker);
  };
  document.getElementById("rhEditRoute").onclick = () => {
    _routeNavHide("routeHubModal");
    openRouteEditHubModal(worker);
  };
  document.getElementById("rhShowMap").onclick = () => {
    closeModal();
    openRouteMapModal(worker);
  };
}

// ══════════════════════════════════════════════════════════════
// "Carte de la route" — خريطة عامة لكل زبائن route معيّن (Leaflet)،
// بفلاتر: Days / Weeks / Cluster / Actif-Non actif. مستقلة عن أي
// جولة/BL — تعرض فقط موقع الزبون + جدول زيارته + حالته.
// ══════════════════════════════════════════════════════════════
const _RRMAP_CLUSTER_COLORS = { gms: "#2563EB", detail: "#DC2626", gros: "#059669", horeca: "#CA8A04" };
const _RRMAP_CLUSTER_NAMES  = { gms: "GMS", detail: "Détail", gros: "Gros", horeca: "Horeca" };
let _rrmapState = null; // { allPoints, searchQuery, dayFilter, weekFilter, dayMode, weekMode, clusterFilter, statusFilter }

function _rrmapEnsureStyle() {
  if (document.getElementById("rrmapStyle")) return;
  const s = document.createElement("style");
  s.id = "rrmapStyle";
  s.textContent = `
    .rrmap-popup .leaflet-popup-content-wrapper{border-radius:12px;padding:0;box-shadow:0 10px 30px rgba(15,23,42,.18);
      border:1px solid rgba(226,232,240,.9);overflow:hidden}
    .rrmap-popup .leaflet-popup-content{margin:0;width:auto!important;min-width:170px}
    .rrmap-popup-card{font-family:inherit}
    .rrmap-popup-head{padding:9px 12px 7px;background:linear-gradient(135deg,#EFF6FF,#F8FAFC);
      border-bottom:1px solid #E2E8F0;display:flex;align-items:center;gap:6px}
    .rrmap-popup-name{font-size:12.5px;font-weight:700;color:#0F172A;line-height:1.3}
    .rrmap-popup-body{padding:8px 10px;display:flex;flex-direction:column;gap:5px;font-size:11.5px;color:var(--text2,#475569)}
    .rrmap-popup-row{display:flex;align-items:center;gap:6px}
    .rrmap-chip{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 8px;font-size:10.5px;font-weight:700;width:fit-content}
    .rrmap-filters-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:6px}
    .rrmap-filters-row:last-child{margin-bottom:0}
    .rrmap-filters-label{font-size:10px;font-weight:800;color:var(--text3,#94A3B8);text-transform:uppercase;letter-spacing:.04em;flex-shrink:0;min-width:38px}
    .rrmap-chip-btn{display:inline-flex;align-items:center;gap:5px;border-radius:999px;border:1.5px solid var(--border,#E2E8F0);
      padding:4px 9px;font-size:11px;font-weight:700;cursor:pointer;background:var(--bg3,#F1F5F9);color:var(--text2,#475569);
      transition:all .15s ease;font-family:inherit}
    .rrmap-chip-btn:hover{transform:translateY(-1px)}
    .rrmap-chip-btn[disabled]{opacity:.35;cursor:not-allowed}
    .rrmap-chip-btn--active{border-color:var(--chipclr,#3B82F6);background:color-mix(in srgb, var(--chipclr,#3B82F6) 16%, #fff);color:#0F172A}
    .rrmap-filters-clear{margin-left:auto;font-size:10.5px;font-weight:700;color:var(--accent,#3B82F6);background:none;border:none;cursor:pointer}
    #rrmapBox.rrmap-expanded{max-width:96vw!important;width:96vw!important;height:92vh!important;max-height:92vh!important}
  `;
  document.head.appendChild(s);
}

const _rrmapIconCache = new Map();
function _rrmapPinIcon(color, dimmed, letter, selected) {
  const clr = color || "#94A3B8";
  const key = `${clr}|${dimmed ? 1 : 0}|${letter || ""}|${selected ? 1 : 0}`;
  if (_rrmapIconCache.has(key)) return _rrmapIconCache.get(key);
  // نفس تصميم دبوس Dispatch Planning: نصفان (فاتح/داكن) + دائرة بيضاء + ظل بيضاوي أسفل الدبوس
  const lightClr = `color-mix(in srgb, ${clr} 76%, #fff)`;
  const ring = selected ? `<circle cx="24" cy="20" r="19" fill="none" stroke="#3B82F6" stroke-width="3"/>` : "";
  const check = selected ? `<circle cx="36" cy="10" r="9" fill="#3B82F6" stroke="#fff" stroke-width="1.5"/>
      <path d="M32 10l2.5 2.5 5-5" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` : "";
  const icon = L.divIcon({
    className: "rrmap-pin",
    html: `<div style="opacity:${dimmed && !selected ? .45 : 1}">
      <svg viewBox="0 0 48 56" width="36" height="42" style="display:block;overflow:visible">
        <ellipse cx="24" cy="52" rx="9" ry="2.6" fill="#000" opacity="0.15"/>
        ${ring}
        <path d="M24 2C13 2 5 10.5 5 20.5 5 34 24 50 24 50s19-16 19-29.5C43 10.5 35 2 24 2z"
          fill="${clr}" stroke="#fff" stroke-width="2" ${dimmed ? 'stroke-dasharray="2,2"' : ""}/>
        <path d="M24 2C13 2 5 10.5 5 20.5 5 34 24 50 24 50V2z" fill="${lightClr}"/>
        <circle cx="24" cy="20" r="12" fill="#fff"/>
        <text x="24" y="20" text-anchor="middle" dominant-baseline="central" font-size="14" font-weight="800" font-family="inherit" fill="#0F172A">${letter || ""}</text>
        ${check}
      </svg>
    </div>`,
    iconSize: [36, 42], iconAnchor: [18, 42], popupAnchor: [0, -38],
  });
  _rrmapIconCache.set(key, icon);
  return icon;
}

function _rrmapFilteredPoints() {
  const st = _rrmapState;
  const q = st.searchQuery.trim().toLowerCase();
  return st.allPoints.filter(p => {
    if (q && !p.name.toLowerCase().includes(q) && !String(p.ref || "").toLowerCase().includes(q)) return false;
    if (st.dayFilter.size) {
      const ok = st.dayMode === "OR" ? [...st.dayFilter].some(d => p.activeDays.includes(d)) : [...st.dayFilter].every(d => p.activeDays.includes(d));
      if (!ok) return false;
    }
    if (st.weekFilter.size) {
      const ok = st.weekMode === "OR" ? [...st.weekFilter].some(w => p.weeksActive.includes(w)) : [...st.weekFilter].every(w => p.weeksActive.includes(w));
      if (!ok) return false;
    }
    if (st.clusterFilter.size && !st.clusterFilter.has(p.clusterCategory || "none")) return false;
    if (st.statusFilter.size) {
      const key = p.active ? "actif" : "nonactif";
      if (!st.statusFilter.has(key)) return false;
    }
    return true;
  });
}

function _rrmapRenderFilterBar() {
  const st = _rrmapState;
  const bar = document.getElementById("rrmapFilters");
  if (!bar) return;
  const preDay = _rrmapFilteredPointsExcept("day");
  const preWeek = _rrmapFilteredPointsExcept("week");
  const availDays = new Set(preDay.flatMap(p => p.activeDays));
  const availWeeks = new Set(preWeek.flatMap(p => p.weeksActive));

  const dayRow = `<div class="rrmap-filters-row">
    <span class="rrmap-filters-label">Jours</span>
    ${_ROUTE_DAYS.map(d => {
      const active = st.dayFilter.has(d), disabled = !availDays.has(d) && !active;
      return `<button type="button" class="rrmap-chip-btn rrmap-chip-btn--day${active ? " rrmap-chip-btn--active" : ""}" data-day="${d}" ${disabled ? "disabled" : ""}>${_ROUTE_DAY_LABELS_FR[d]}</button>`;
    }).join("")}
    <button type="button" id="rrmapDayMode" class="rrmap-chip-btn" style="font-size:10px;padding:3px 8px">${st.dayMode}</button>
  </div>`;

  const weekRow = `<div class="rrmap-filters-row">
    <span class="rrmap-filters-label">Sem.</span>
    ${_ROUTE_WEEKS.map(w => {
      const active = st.weekFilter.has(w), disabled = !availWeeks.has(w) && !active;
      return `<button type="button" class="rrmap-chip-btn rrmap-chip-btn--week${active ? " rrmap-chip-btn--active" : ""}" data-week="${w}" ${disabled ? "disabled" : ""}>S${w}</button>`;
    }).join("")}
    <button type="button" id="rrmapWeekMode" class="rrmap-chip-btn" style="font-size:10px;padding:3px 8px">${st.weekMode}</button>
  </div>`;

  const clustersPresent = [...new Set(st.allPoints.map(p => p.clusterCategory || "none"))];
  const clusterRow = clustersPresent.length ? `<div class="rrmap-filters-row">
    <span class="rrmap-filters-label">Cluster</span>
    ${clustersPresent.map(c => {
      const active = st.clusterFilter.has(c);
      const clr = _RRMAP_CLUSTER_COLORS[c] || "#94A3B8";
      const label = _RRMAP_CLUSTER_NAMES[c] || "Autre";
      return `<button type="button" class="rrmap-chip-btn rrmap-chip-btn--cluster${active ? " rrmap-chip-btn--active" : ""}" data-cluster="${c}" style="--chipclr:${clr}">
        <span style="width:8px;height:8px;border-radius:50%;background:${clr};flex-shrink:0"></span>${label}</button>`;
    }).join("")}
  </div>` : "";

  const statusRow = `<div class="rrmap-filters-row">
    <span class="rrmap-filters-label">État</span>
    <button type="button" class="rrmap-chip-btn rrmap-chip-btn--status${st.statusFilter.has("actif") ? " rrmap-chip-btn--active" : ""}" data-status="actif" style="--chipclr:#16A34A">Actif</button>
    <button type="button" class="rrmap-chip-btn rrmap-chip-btn--status${st.statusFilter.has("nonactif") ? " rrmap-chip-btn--active" : ""}" data-status="nonactif" style="--chipclr:#DC2626">Non actif</button>
    <button type="button" class="rrmap-filters-clear" id="rrmapClearFilters">Effacer</button>
  </div>`;

  bar.innerHTML = dayRow + weekRow + clusterRow + statusRow;

  bar.querySelectorAll(".rrmap-chip-btn--day:not([disabled])").forEach(b => b.onclick = () => {
    const d = b.dataset.day;
    st.dayFilter.has(d) ? st.dayFilter.delete(d) : st.dayFilter.add(d);
    _rrmapRefresh();
  });
  bar.querySelectorAll(".rrmap-chip-btn--week:not([disabled])").forEach(b => b.onclick = () => {
    const w = parseInt(b.dataset.week, 10);
    st.weekFilter.has(w) ? st.weekFilter.delete(w) : st.weekFilter.add(w);
    _rrmapRefresh();
  });
  bar.querySelectorAll(".rrmap-chip-btn--cluster").forEach(b => b.onclick = () => {
    const c = b.dataset.cluster;
    st.clusterFilter.has(c) ? st.clusterFilter.delete(c) : st.clusterFilter.add(c);
    _rrmapRefresh();
  });
  bar.querySelectorAll(".rrmap-chip-btn--status").forEach(b => b.onclick = () => {
    const k = b.dataset.status;
    st.statusFilter.has(k) ? st.statusFilter.delete(k) : st.statusFilter.add(k);
    _rrmapRefresh();
  });
  const dm = document.getElementById("rrmapDayMode");
  if (dm) dm.onclick = () => { st.dayMode = st.dayMode === "OR" ? "AND" : "OR"; _rrmapRefresh(); };
  const wm = document.getElementById("rrmapWeekMode");
  if (wm) wm.onclick = () => { st.weekMode = st.weekMode === "OR" ? "AND" : "OR"; _rrmapRefresh(); };
  document.getElementById("rrmapClearFilters").onclick = () => {
    st.dayFilter.clear(); st.weekFilter.clear(); st.clusterFilter.clear(); st.statusFilter.clear();
    _rrmapRefresh();
  };
}

// نفس _rrmapFilteredPoints لكن تتجاهل بُعد فلتر واحد (لتفعيل/تعطيل الأزرار حسب المتاح)
function _rrmapFilteredPointsExcept(skip) {
  const st = _rrmapState;
  const q = st.searchQuery.trim().toLowerCase();
  return st.allPoints.filter(p => {
    if (q && !p.name.toLowerCase().includes(q) && !String(p.ref || "").toLowerCase().includes(q)) return false;
    if (skip !== "day" && st.dayFilter.size) {
      const ok = st.dayMode === "OR" ? [...st.dayFilter].some(d => p.activeDays.includes(d)) : [...st.dayFilter].every(d => p.activeDays.includes(d));
      if (!ok) return false;
    }
    if (skip !== "week" && st.weekFilter.size) {
      const ok = st.weekMode === "OR" ? [...st.weekFilter].some(w => p.weeksActive.includes(w)) : [...st.weekFilter].every(w => p.weeksActive.includes(w));
      if (!ok) return false;
    }
    if (skip !== "cluster" && st.clusterFilter.size && !st.clusterFilter.has(p.clusterCategory || "none")) return false;
    if (skip !== "status" && st.statusFilter.size) {
      const key = p.active ? "actif" : "nonactif";
      if (!st.statusFilter.has(key)) return false;
    }
    return true;
  });
}

let _rrmapMap = null, _rrmapMarkers = [], _rrmapLayerGroup = null, _rrmapFittedOnce = false;
let _rrmapRouteLine = null, _rrmapDistanceToken = 0;
let _rrmapSearchDebounce = null;
function _rrmapRefresh() {
  const st = _rrmapState;
  _rrmapRenderFilterBar();
  const pts = _rrmapFilteredPoints();
  const countEl = document.getElementById("rrmapCount");
  if (countEl) countEl.textContent = `${pts.length} client(s)`;
  const noRes = document.getElementById("rrmapNoResults");
  if (noRes) noRes.style.display = pts.length ? "none" : "block";

  _rrmapLayerGroup.clearLayers();
  _rrmapMarkers = [];
  pts.forEach(p => {
    if (!p.lat || !p.lng) return;
    const color = _RRMAP_CLUSTER_COLORS[p.clusterCategory] || "#94A3B8";
    const letter = p.clusterCategory ? (_RRMAP_CLUSTER_NAMES[p.clusterCategory] || "?")[0] : "";
    const isSelected = st.selected.has(p.eventId);
    const marker = L.marker([p.lat, p.lng], { icon: _rrmapPinIcon(color, !p.active, letter, isSelected) });
    marker._rrmapPoint = p; // مرجع مباشر للنقطة — يُستعمل عند التحديد بالسحب (Shift+drag)

    // محتوى الـpopup يُبنى فقط عند فتحه فعليًا (lazy)
    marker.bindPopup(() => {
      const statusChip = p.active
        ? `<span class="rrmap-chip" style="background:#DCFCE7;color:#15803D;border:1px solid #86EFAC">Actif</span>`
        : `<span class="rrmap-chip" style="background:#FEE2E2;color:#B91C1C;border:1px solid #FCA5A5">Non actif</span>`;
      const clusterChip = p.cluster
        ? `<span class="rrmap-chip" style="background:#EFF6FF;color:#1D4ED8;border:1px solid #BFDBFE">${escHtml(p.cluster)}</span>` : "";
      return `
      <div class="rrmap-popup-card">
        <div class="rrmap-popup-head"><span class="rrmap-popup-name">${escHtml(p.name)}</span></div>
        <div class="rrmap-popup-body">
          ${p.routeName ? `<div class="rrmap-popup-row" style="color:var(--text3,#94A3B8);font-size:10.5px">Route: ${escHtml(p.routeName)}</div>` : ""}
          <div class="rrmap-popup-row">${statusChip}${clusterChip}</div>
          <div class="rrmap-popup-row">Jours: <b>${escHtml(p.daysLabel)}</b></div>
          <div class="rrmap-popup-row">Semaines: <b>${p.weeksActive.length ? p.weeksActive.map(w => "S" + w).join(", ") : "—"}</b></div>
          ${p.ref ? `<div class="rrmap-popup-row">Réf: <b>${escHtml(String(p.ref))}</b></div>` : ""}
        </div>
      </div>`;
    }, { className: "rrmap-popup" });

    // تحديد بالنقر (Shift+click بدون سحب): يُضيف/يُزيل هذا الزبون من التحديد مباشرة بدل فتح الـpopup.
    // نُلغي أولًا مستمع click الافتراضي الذي يفتح الـpopup (سجّلته bindPopup أعلاه) لنتحكم به يدويًا.
    marker.off("click");
    marker.on("click", (e) => {
      if (e.originalEvent?.shiftKey) {
        L.DomEvent.stopPropagation(e);
        if (_rrmapState.selected.has(p.eventId)) _rrmapState.selected.delete(p.eventId);
        else _rrmapState.selected.add(p.eventId);
        _rrmapRefresh();
      } else {
        marker.openPopup();
      }
    });

    _rrmapLayerGroup.addLayer(marker);
    _rrmapMarkers.push(marker);
  });

  // fitBounds فقط عند أول عرض — إعادته عند كل فلترة/بحث كانت السبب الرئيسي
  // للثقل (إعادة حساب + تحريك الخريطة عند كل ضغطة مفتاح/فلتر).
  if (!_rrmapFittedOnce && pts.length && _rrmapMarkers.length) {
    try { _rrmapMap.fitBounds(L.featureGroup(_rrmapMarkers).getBounds().pad(0.15), { animate: false }); } catch (_) {}
    _rrmapFittedOnce = true;
  }

  _rrmapRenderSelectionBar();
}

function _rrmapRenderSelectionBar() {
  const st = _rrmapState;
  const bar = document.getElementById("rrmapSelectBar");
  if (!bar) return;
  if (!st.selected.size) { bar.style.display = "none"; _rrmapUpdateDistance(); return; }
  bar.style.display = "flex";
  document.getElementById("rrmapSelectCount").textContent = `${st.selected.size} sélectionné(s)`;
  _rrmapUpdateDistance();
}

// ── تحديثات معلّقة (jours/semaines) بانتظار زر "Enregistrer" — لا شيء يُرسل لـOdoo قبل الحفظ الصريح ──
function _rrmapUpdateSaveBtn() {
  const st = _rrmapState;
  const btn = document.getElementById("rrmapSaveBtn");
  if (!btn) return;
  const n = st?.pendingEdits?.size || 0;
  btn.style.display = n ? "flex" : "none";
  const countEl = document.getElementById("rrmapSaveCount");
  if (countEl) countEl.textContent = n || "";
}

async function _rrmapCommitPendingEdits() {
  const st = _rrmapState;
  if (!st?.pendingEdits?.size) return;
  const baseUrl = getOdooBase();
  if (!baseUrl) { addNotif("URL Odoo non configurée", "error"); return; }
  const btn = document.getElementById("rrmapSaveBtn");
  if (btn) { btn.disabled = true; btn.style.opacity = ".6"; }

  // تجميع الزبائن حسب نفس الاختيار (semaines/jours) لتقليل عدد نداءات RPC
  const groups = new Map(); // key(JSON weeks+days) -> {weeks, days, ids:[]}
  st.pendingEdits.forEach((meta, eventId) => {
    const key = JSON.stringify([meta.weeks, meta.days]);
    if (!groups.has(key)) groups.set(key, { weeks: meta.weeks, days: meta.days, ids: [] });
    groups.get(key).ids.push(eventId);
  });

  let okCount = 0, failCount = 0;
  for (const g of groups.values()) {
    try {
      await rpcController.updateRouteClientSchedule(baseUrl, g.ids, g.weeks, g.days);
      okCount += g.ids.length;
    } catch (err) {
      failCount += g.ids.length;
      addNotif("✗ " + err.message, "error");
    }
  }
  st.pendingEdits.clear();
  if (btn) { btn.disabled = false; btn.style.opacity = "1"; }
  _rrmapUpdateSaveBtn();
  if (okCount) addNotif(`✓ ${okCount} changement(s) enregistré(s)`, "success");
  if (!failCount) { /* tout est passé */ }
}

async function openRouteMapModal(route) {
  const baseUrl = getOdooBase();
  if (!baseUrl) { addNotif("URL Odoo non configurée", "error"); return; }
  if (!route?.routeId) return;

  document.getElementById("rrmapOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "rrmapOverlay";
  // z-index أقل من ap-overlay (9999) عمدًا — كي تظهر نوافذ التعديل/الحذف
  // (مثل "Modifier les jours" ونافذة التأكيد) دائمًا فوق مودل الخريطة، لا تحته.
  overlay.style.cssText = `position:fixed;inset:0;z-index:9990;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.3);padding:16px`;
  overlay.innerHTML = `
    <div id="rrmapBox" style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);border-radius:10px;
      width:100%;max-width:720px;max-height:88vh;height:640px;display:flex;flex-direction:column;
      box-shadow:0 8px 32px rgba(0,0,0,.12);overflow:hidden;transition:max-width .18s ease,width .18s ease,height .18s ease,max-height .18s ease">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent,#3B82F6)" stroke-width="2" width="16" height="16">${_svgMap.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'')}</svg>
          <span style="font-size:12px;font-weight:700;color:var(--text,#0F172A);flex-shrink:0">Carte de la route</span>
          <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:9px;background:#F5F3FF;color:#7C3AED;
            border:1px solid #DDD6FE;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(route.routeName || String(route.routeId))}</span>
          <span id="rrmapCount" style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:9px;background:#EFF6FF;color:#3B82F6;border:1px solid #BFDBFE;flex-shrink:0"></span>
          <div style="display:flex;align-items:center;gap:6px;background:var(--bg3,#F1F5F9);border:1px solid var(--border,#E2E8F0);
            border-radius:6px;padding:4px 8px;min-width:0;flex:1;max-width:170px">
            <svg viewBox="0 0 24 24" fill="none" stroke="var(--text3,#94A3B8)" stroke-width="2" width="13" height="13" style="flex-shrink:0"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input id="rrmapSearchInput" type="text" placeholder="Rechercher un client…" style="border:none;background:transparent;outline:none;font-size:11px;color:var(--text,#0F172A);flex:1;min-width:0"/>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
          <button id="rrmapSaveBtn" style="display:none;align-items:center;gap:5px;font-size:11px;font-weight:700;background:#16A34A;color:#fff;border:none;border-radius:6px;padding:5px 10px;cursor:pointer">
            Enregistrer<span id="rrmapSaveCount" style="background:rgba(255,255,255,.25);border-radius:9px;padding:0 6px;font-size:10px"></span>
          </button>
          <button id="rrmapExpand" title="Agrandir" style="background:none;border:none;color:var(--text3,#94A3B8);cursor:pointer;padding:5px 6px;border-radius:4px;display:flex">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15">
              <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
            </svg>
          </button>
          <button id="rrmapClose" style="background:none;border:none;color:var(--text3,#94A3B8);cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;border-radius:4px">×</button>
        </div>
      </div>
      <div id="rrmapBody" style="flex:1;position:relative;background:var(--bg,#F8FAFC);overflow:hidden">
        <div id="rrmapLoading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text3,#94A3B8)"><div class="spinner"></div></div>
        <div id="rrmapEl" style="width:100%;height:100%"></div>
        <div id="rrmapNoResults" style="display:none;position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:500;font-size:11px;
          font-weight:700;color:#94A3B8;background:#fff;border:1px solid #E2E8F0;border-radius:8px;padding:5px 12px;box-shadow:0 2px 8px rgba(15,23,42,.08)">Aucun résultat</div>
        <div id="rrmapSelectRect" style="display:none;position:absolute;z-index:600;border:1.5px dashed #3B82F6;
          background:rgba(59,130,246,.12);pointer-events:none"></div>
        <div id="rrmapSelectBar" style="display:none;position:absolute;bottom:10px;left:50%;transform:translateX(-50%);z-index:500;align-items:center;gap:8px;
          background:#0F172A;color:#fff;border-radius:10px;padding:7px 10px;box-shadow:0 6px 18px rgba(15,23,42,.3)">
          <span id="rrmapSelectCount" style="font-size:11.5px;font-weight:700"></span>
          <span id="rrmapSelectDistance" style="display:none;font-size:11px;font-weight:600;color:#93C5FD;white-space:nowrap"></span>
          <button id="rrmapSelectEditDays" style="font-size:11px;font-weight:700;background:#3B82F6;color:#fff;border:none;border-radius:6px;padding:5px 10px;cursor:pointer">Modifier les jours</button>
          <button id="rrmapSelectDelete" style="font-size:11px;font-weight:700;background:#DC2626;color:#fff;border:none;border-radius:6px;padding:5px 10px;cursor:pointer">Supprimer</button>
          <button id="rrmapSelectClear" style="font-size:11px;font-weight:600;background:none;color:#CBD5E1;border:none;cursor:pointer;padding:5px 4px">Annuler</button>
        </div>
      </div>
      <div id="rrmapFilters" style="flex-shrink:0;max-height:200px;overflow-y:auto;border-top:1px solid var(--border,#E2E8F0);background:var(--bg2,#fff);padding:8px 10px"></div>
    </div>`;
  document.body.appendChild(overlay);
  _rrmapEnsureStyle();

  const _close = () => {
    if (_rrmapState?.pendingEdits?.size && !confirm(`${_rrmapState.pendingEdits.size} changement(s) non enregistré(s) seront perdus. Fermer quand même ?`)) return;
    clearTimeout(_rrmapSearchDebounce);
    document.removeEventListener("mousemove", _rrmapOnMouseMove);
    document.removeEventListener("mouseup", _rrmapOnMouseUp);
    overlay.remove();
    _rrmapMap = null; _rrmapMarkers = []; _rrmapLayerGroup = null; _rrmapRouteLine = null;
  };
  document.getElementById("rrmapClose").onclick = _close;
  document.getElementById("rrmapSaveBtn").onclick = _rrmapCommitPendingEdits;
  overlay.addEventListener("click", e => { if (e.target === overlay) _close(); });
  document.getElementById("rrmapSearchInput").addEventListener("input", e => {
    const val = e.target.value;
    clearTimeout(_rrmapSearchDebounce);
    // تأخير بسيط (250ms) قبل إعادة بناء الدبابيس — يمنع إعادة رسم الخريطة كاملة عند كل ضغطة مفتاح
    _rrmapSearchDebounce = setTimeout(() => {
      _rrmapState.searchQuery = val;
      _rrmapRefresh();
    }, 250);
  });
  document.getElementById("rrmapExpand").onclick = () => {
    const box = document.getElementById("rrmapBox");
    const expanded = box.classList.toggle("rrmap-expanded");
    document.getElementById("rrmapExpand").title = expanded ? "Réduire" : "Agrandir";
    setTimeout(() => { try { _rrmapMap?.invalidateSize(); } catch (_) {} }, 190);
  };

  // ── تحديد بالسحب (Shift + drag): تحديد زبون/مجموعة برسم مستطيل فوق الخريطة،
  // ثم تعديل أيام الزيارة أو الحذف من الـroute عبر الشريط السفلي ──
  const rrmapBody = document.getElementById("rrmapBody");
  const rrmapRectEl = document.getElementById("rrmapSelectRect");
  let _rrmapDragStart = null; // {x,y} نسبة لحاوية rrmapBody

  const _rrmapOnMouseDown = (e) => {
    if (!e.shiftKey || e.button !== 0 || !_rrmapMap) return;
    e.preventDefault();
    e.stopPropagation();
    _rrmapMap.dragging.disable();
    const boxRect = rrmapBody.getBoundingClientRect();
    _rrmapDragStart = { x: e.clientX - boxRect.left, y: e.clientY - boxRect.top };
    rrmapRectEl.style.display = "block";
    rrmapRectEl.style.left = _rrmapDragStart.x + "px";
    rrmapRectEl.style.top = _rrmapDragStart.y + "px";
    rrmapRectEl.style.width = "0px";
    rrmapRectEl.style.height = "0px";
  };
  const _rrmapOnMouseMove = (e) => {
    if (!_rrmapDragStart) return;
    const boxRect = rrmapBody.getBoundingClientRect();
    const curX = e.clientX - boxRect.left, curY = e.clientY - boxRect.top;
    const left = Math.min(_rrmapDragStart.x, curX), top = Math.min(_rrmapDragStart.y, curY);
    const w = Math.abs(curX - _rrmapDragStart.x), h = Math.abs(curY - _rrmapDragStart.y);
    rrmapRectEl.style.left = left + "px";
    rrmapRectEl.style.top = top + "px";
    rrmapRectEl.style.width = w + "px";
    rrmapRectEl.style.height = h + "px";
  };
  const _rrmapOnMouseUp = (e) => {
    if (!_rrmapDragStart || !_rrmapMap) return;
    const boxRect = rrmapBody.getBoundingClientRect();
    const endX = e.clientX - boxRect.left, endY = e.clientY - boxRect.top;
    const p1 = L.point(_rrmapDragStart.x, _rrmapDragStart.y);
    const p2 = L.point(endX, endY);
    _rrmapDragStart = null;
    rrmapRectEl.style.display = "none";
    _rrmapMap.dragging.enable();

    // مستطيل صغير جدًا (نقرة عرضية) → تجاهل، لا تحديد
    if (Math.abs(p2.x - p1.x) < 4 && Math.abs(p2.y - p1.y) < 4) return;

    const bounds = L.bounds(p1, p2);
    let added = 0;
    _rrmapMarkers.forEach(m => {
      const pt = _rrmapMap.latLngToContainerPoint(m.getLatLng());
      if (bounds.contains(pt)) {
        _rrmapState.selected.add(m._rrmapPoint.eventId);
        added++;
      }
    });
    if (added) _rrmapRefresh();
  };
  rrmapBody.addEventListener("mousedown", _rrmapOnMouseDown, true);
  // يمنع فتح popup الزبون عرضيًا عند الضغط بـShift (حتى بدون سحب فعلي)
  rrmapBody.addEventListener("click", (e) => {
    if (!e.shiftKey) return;
    // إن كان النقر على دبوس زبون (marker)، نترك حدث click الخاص بالـmarker (المُضاف أعلاه) يتولى
    // تبديل التحديد بنفسه؛ فقط نمنع فتح popup الخريطة الافتراضي بدون قطع الانتشار عن الـmarker.
    if (e.target.closest(".leaflet-marker-icon")) { e.preventDefault(); return; }
    e.preventDefault(); e.stopPropagation();
  }, true);
  document.addEventListener("mousemove", _rrmapOnMouseMove);
  document.addEventListener("mouseup", _rrmapOnMouseUp);

  document.getElementById("rrmapSelectClear").onclick = () => {
    _rrmapState.selected.clear();
    _rrmapRefresh();
  };
  document.getElementById("rrmapSelectEditDays").onclick = () => {
    if (!_rrmapState.selected.size) return;
    const selectedIds = [..._rrmapState.selected];
    const rowsToEdit = _rrmapState.allPoints
      .filter(p => _rrmapState.selected.has(p.eventId))
      .map(p => p._raw);
    // deferSave: لا حفظ مباشر في Odoo — التعديل يبقى مؤقتًا محليًا إلى أن يُضغط زر "Enregistrer"
    openRouteScheduleEditModal(_rrmapState.route, rowsToEdit, (newVals, meta) => {
      // مزامنة التعديل محليًا (أيام/أسابيع) دون إعادة جلب الـroute كاملة + تسجيله كمعلّق للحفظ اللاحق
      _rrmapState.allPoints.forEach(p => {
        if (!selectedIds.includes(p.eventId)) return;
        Object.assign(p._raw, newVals);
        p.activeDays  = _rcmRowActiveDays(p._raw);
        p.daysLabel   = _routeDaysActiveLabel(p._raw);
        p.weeksActive = _routeWeeksActive(p._raw);
        _rrmapState.pendingEdits.set(p.eventId, meta);
      });
      _rrmapState.selected.clear();
      _rrmapUpdateSaveBtn();
      _rrmapRefresh();
    }, { deferSave: true });
  };
  document.getElementById("rrmapSelectDelete").onclick = () => {
    if (!_rrmapState.selected.size) return;
    const ids = [..._rrmapState.selected];
    _confirmDangerAction(`Supprimer ${ids.length} client(s) de cette route ?`, async () => {
      const bUrl = getOdooBase();
      if (!bUrl) { addNotif("URL Odoo non configurée", "error"); return; }
      try {
        await rpcController.deleteRouteClients(bUrl, ids);
        _rrmapState.allPoints = _rrmapState.allPoints.filter(p => !ids.includes(p.eventId));
        _rrmapState.selected.clear();
        addNotif(`✓ ${ids.length} client(s) retiré(s) de la route`, "success");
        _rrmapRefresh();
      } catch (err) {
        addNotif("✗ " + err.message, "error");
      }
    });
  };

  // ── جلب زبائن الـroute (أو عدة routes محدَّدة) + إحداثياتهم/الكلستر/حالتهم ──
  let rows = [];
  try {
    if (route._multiRoutes?.length) {
      const chunks = await Promise.all(
        route._multiRoutes.map(mr => rpcController.fetchRouteCustomers(baseUrl, mr.id))
      );
      chunks.forEach((chunk, i) => {
        const mr = route._multiRoutes[i];
        chunk.forEach(r => { r._routeId = mr.id; r._routeName = mr.name; });
      });
      rows = chunks.flat();
    } else {
      rows = await rpcController.fetchRouteCustomers(baseUrl, route.routeId);
    }
  } catch (e) {
    document.getElementById("rrmapLoading").innerHTML = `<div style="color:var(--red,#ef4444);text-align:center;padding:20px;font-size:12px">Erreur: ${escHtml(e.message)}</div>`;
    return;
  }
  const partnerIds = [...new Set(rows.map(r => Array.isArray(r.partner_id) ? r.partner_id[0] : null).filter(Boolean))];
  let partnersInfo = [];
  try {
    partnersInfo = await rpcController.fetchPartnersForRouteMap(baseUrl, partnerIds);
  } catch (e) {
    document.getElementById("rrmapLoading").innerHTML = `<div style="color:var(--red,#ef4444);text-align:center;padding:20px;font-size:12px">Erreur: ${escHtml(e.message)}</div>`;
    return;
  }
  const infoById = new Map(partnersInfo.map(p => [p.id, p]));

  const allPoints = rows.map(r => {
    const pid = Array.isArray(r.partner_id) ? r.partner_id[0] : null;
    const info = pid ? infoById.get(pid) : null;
    return {
      id: pid,
      eventId: r.id, // معرّف planning.template.event — يُستعمل للتعديل/الحذف
      _raw: r,        // الصف الخام (يحوي حقول w{semaine}{jour}) — يُمرَّر مباشرة لنوافذ التعديل الموجودة
      name: (Array.isArray(r.partner_id) ? r.partner_id[1] : null) || info?.name || "—",
      ref: r._partnerRef || "",
      lat: info?.lat || null,
      lng: info?.lng || null,
      cluster: info?.cluster || "",
      clusterCategory: info?.clusterCategory || null,
      active: info ? info.active : true,
      activeDays: _rcmRowActiveDays(r),
      daysLabel: _routeDaysActiveLabel(r),
      weeksActive: _routeWeeksActive(r),
      routeName: r._routeName || null,
    };
  });

  _rrmapState = {
    allPoints,
    searchQuery: "",
    dayFilter: new Set(), weekFilter: new Set(), dayMode: "OR", weekMode: "OR",
    clusterFilter: new Set(), statusFilter: new Set(),
    selected: new Set(), // eventId set — تحديد زبون/مجموعة على الخريطة (Shift+drag)
    pendingEdits: new Map(), // eventId -> {weeks, days} — تعديلات جدول الزيارة غير محفوظة بعد (Enregistrer)
    route,
  };

  document.getElementById("rrmapLoading")?.remove();
  const located = allPoints.filter(p => p.lat && p.lng);
  if (!located.length) {
    document.getElementById("rrmapEl").innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;
      color:var(--text3,#94A3B8);font-size:12px;text-align:center;padding:20px">Aucun client localisé pour cette route</div>`;
    _rrmapRenderFilterBar();
    const countEl = document.getElementById("rrmapCount");
    if (countEl) countEl.textContent = "0 client(s)";
    return;
  }

  const map = L.map("rrmapEl", { zoomControl: true });
  _rrmapMap = map;
  _rrmapFittedOnce = false;
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
  map.setView([located[0].lat, located[0].lng], 12);
  // Marker clustering: يجمّع الدبابيس المتقاربة إلى كتلة واحدة عند التصغير —
  // هذا هو السبب الرئيسي للثقل عند routes بها عدد كبير من الزبائن (كل دبوس = عنصر DOM مستقل).
  _rrmapLayerGroup = (typeof L.markerClusterGroup === "function")
    ? L.markerClusterGroup({
        chunkedLoading: true,      // يبني الدبابيس على دفعات بدل حظر الواجهة دفعة واحدة
        animate: false,            // بلا حركات تكبير/تجميع (تخفّف من "التهنيج" أثناء التنقل)
        maxClusterRadius: 60,
        spiderfyOnMaxZoom: true,
        disableClusteringAtZoom: 17,
      })
    : L.layerGroup(); // احتياط إن فشل تحميل مكتبة التجميع (مثلاً بلا اتصال بـ jsdelivr)
  _rrmapLayerGroup.addTo(map);

  _rrmapRefresh();
}

// ── نافذة "إضافة زبون إلى route" — بحث ذكي (يتجاهل الترتيب والمسافات)
// متعدد الاختيار، ثم تحديد الأسبوع/الأيام قبل التأكيد.
function openAddClientToRouteModal(worker) {
  const baseUrl = getOdooBase();
  if (!baseUrl) { addNotif("URL Odoo non configurée", "error"); return; }
  if (!worker?.routeId) { addNotif("Aucune route associée à cet agent", "error"); return; }
  const routeId = worker.routeId;

  document.getElementById("addClientToRouteModal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "addClientToRouteModal";
  overlay.className = "ap-overlay";
  overlay.innerHTML = `
    <div class="ap-modal" style="max-width:380px">
      <div class="ap-header">
        <span class="ap-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            style="width:14px;height:14px;margin-right:5px;vertical-align:middle">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
            <line x1="19" y1="8" x2="19" y2="14"/>
            <line x1="16" y1="11" x2="22" y2="11"/>
          </svg>
          Ajouter client — ${escHtml(worker.routeName || worker.routeId)}
        </span>
        <button class="ap-close" id="acrClose">×</button>
      </div>
      <div style="position:relative;margin-top:2px">
        <input type="text" id="acrClientInput" class="ap-input"
          placeholder="Référence ou nom du client…" autocomplete="off"/>
        <div id="acrDropdown" class="ap-dropdown" style="display:none"></div>
      </div>
      <span id="acrCopyPlanningLink"
        style="display:inline-block;margin-top:5px;font-size:10px;color:var(--accent);cursor:pointer;text-decoration:underline">
        Copier planning d'un client existant
      </span>
      <div id="acrCopyPanel" style="display:none;position:relative;margin-top:5px">
        <input type="text" id="acrCopyInput" class="ap-input"
          placeholder="Chercher un client de cette route…" autocomplete="off"/>
        <div id="acrCopyDropdown" class="ap-dropdown" style="display:none"></div>
      </div>
      <div id="acrSelected"
        style="display:none;flex-direction:column;gap:4px;margin-top:4px;max-height:110px;overflow-y:auto"></div>

      <div id="acrSchedule" style="display:none;margin-top:10px;border-top:1px solid var(--border,#333);padding-top:8px">
        <div style="font-size:11px;color:var(--text2);margin-bottom:5px">Semaine(s)</div>
        <div id="acrWeeks" style="display:flex;gap:10px;margin-bottom:8px"></div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:5px">Jour(s)</div>
        <div id="acrDays" style="display:flex;flex-wrap:wrap;gap:8px"></div>
      </div>

      <div id="acrStatus"
        style="font-size:11px;min-height:14px;color:var(--text3);text-align:center;padding:3px 0"></div>
      <div class="ap-footer" style="margin-top:6px">
        <button class="ap-btn ap-btn-cancel" id="acrCancel">Annuler</button>
        <button class="ap-btn ap-btn-add" id="acrSubmit" disabled>Confirmer</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const input       = document.getElementById("acrClientInput");
  const dropdown    = document.getElementById("acrDropdown");
  const submitBtn   = document.getElementById("acrSubmit");
  const statusEl    = document.getElementById("acrStatus");
  const selectedEl  = document.getElementById("acrSelected");
  const scheduleEl  = document.getElementById("acrSchedule");
  const weeksEl     = document.getElementById("acrWeeks");
  const daysEl      = document.getElementById("acrDays");
  const copyLink    = document.getElementById("acrCopyPlanningLink");
  const copyPanel   = document.getElementById("acrCopyPanel");
  const copyInput   = document.getElementById("acrCopyInput");
  const copyDropdown = document.getElementById("acrCopyDropdown");

  let selectedClients = [];
  let selWeeks = [];
  let selDays  = [];

  weeksEl.innerHTML = _ROUTE_WEEKS.map(w => `
    <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
      <input type="checkbox" class="acr-week-chk" value="${w}"/> S${w}
    </label>`).join("");
  daysEl.innerHTML = _ROUTE_DAYS.map(d => `
    <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
      <input type="checkbox" class="acr-day-chk" value="${d}"/> ${_ROUTE_DAY_LABELS_FR[d]}
    </label>`).join("");

  function _updateSubmitState() {
    submitBtn.disabled = !(selectedClients.length && selDays.length);
  }
  weeksEl.querySelectorAll(".acr-week-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      selWeeks = [...weeksEl.querySelectorAll(".acr-week-chk:checked")].map(c => parseInt(c.value, 10));
      _updateSubmitState();
    });
  });
  daysEl.querySelectorAll(".acr-day-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      selDays = [...daysEl.querySelectorAll(".acr-day-chk:checked")].map(c => c.value);
      _updateSubmitState();
    });
  });

  const closeModal = () => overlay.remove();
  document.getElementById("acrClose").onclick  = closeModal;
  document.getElementById("acrCancel").onclick = closeModal;
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

  function _doSelectClient(client) {
    if (selectedClients.find(c => c.ref === client.ref)) {
      statusEl.textContent = "Client déjà ajouté";
      statusEl.style.color = "var(--orange)";
      input.value = "";
      dropdown.style.display = "none";
      return;
    }
    selectedClients.push(client);
    input.value = "";
    dropdown.style.display = "none";
    statusEl.textContent = "";
    statusEl.style.color = "var(--text3)";
    selectedEl.style.display = "flex";
    scheduleEl.style.display = "block";
    _renderSelectedList();
    _updateSubmitState();
  }

  function _renderSelectedList() {
    selectedEl.innerHTML = selectedClients.map((c, i) => `
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#166534;
        background:#dcfce7;border:1px solid #86efac;border-radius:6px;padding:5px 8px">
        <svg viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5"
          style="width:12px;height:12px;flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>
        <span style="flex:1">${escHtml(c.name || c.ref)} · Réf: ${escHtml(c.ref)}</span>
        <span data-ridx="${i}" style="cursor:pointer;font-size:14px;color:#dc2626;line-height:1">×</span>
      </div>`).join("");
    selectedEl.querySelectorAll("[data-ridx]").forEach(el => {
      el.onclick = () => {
        selectedClients.splice(parseInt(el.dataset.ridx), 1);
        if (!selectedClients.length) { selectedEl.style.display = "none"; scheduleEl.style.display = "none"; }
        _renderSelectedList();
        _updateSubmitState();
      };
    });
  }

  let _ddActiveIdx = -1;
  function _ddHighlight(idx) {
    const items = dropdown.querySelectorAll(".ap-dd-item");
    items.forEach(el => el.classList.remove("ap-dd-item--active"));
    if (idx >= 0 && idx < items.length) {
      _ddActiveIdx = idx;
      items[idx].classList.add("ap-dd-item--active");
      items[idx].scrollIntoView({ block: "nearest" });
    } else {
      _ddActiveIdx = -1;
    }
  }

  function showDropdown(items, fromOdoo = false) {
    dropdown.innerHTML = "";
    _ddActiveIdx = -1;
    if (!items.length) {
      dropdown.innerHTML = `<div class="ap-dd-empty">Aucun résultat</div>`;
      dropdown.style.display = "block"; return;
    }
    items.forEach(c => {
      const d = document.createElement("div");
      d.className = "ap-dd-item";
      const refHtml  = `<span style="font-weight:700;color:var(--accent);margin-right:4px">${escHtml(c.ref||"—")}</span>`;
      const nameHtml = escHtml(c.name || c.fullName || "");
      const badge    = fromOdoo
        ? `<span style="font-size:9px;color:var(--orange);background:#FFF7ED;border:1px solid #FED7AA;
             border-radius:3px;padding:1px 4px;margin-left:4px">Odoo</span>`
        : "";
      d.innerHTML = refHtml + nameHtml + badge;
      d.onmousedown = e => {
        e.preventDefault();
        const client = { ref: c.ref || String(c.id || ""), name: c.name || c.fullName || "" };
        _doSelectClient(client);
      };
      dropdown.appendChild(d);
    });
    dropdown.style.display = "block";
  }

  let _odooSearchTimer = null;

  input.addEventListener("input", () => {
    const q = input.value.trim();
    _ddActiveIdx = -1;
    clearTimeout(_odooSearchTimer);
    if (!q) { dropdown.style.display = "none"; statusEl.textContent = ""; return; }

    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const localResults = _importedClients.filter(c => {
      const ref = c.ref.toLowerCase();
      const name = (c.name || "").toLowerCase();
      return tokens.every(t => ref.includes(t) || name.includes(t));
    }).slice(0, 12);

    if (localResults.length) {
      showDropdown(localResults, false);
      statusEl.textContent = "";
      return;
    }

    dropdown.innerHTML = `<div class="ap-dd-empty" style="color:var(--accent)">🔍 Recherche dans Odoo…</div>`;
    dropdown.style.display = "block";
    statusEl.textContent = "Aucun résultat local — recherche Odoo…";

    _odooSearchTimer = setTimeout(async () => {
      try {
        const odooRes = await rpcController.searchClientsByName(baseUrl, q);
        statusEl.textContent = "";
        if (!odooRes.length) {
          dropdown.innerHTML = `<div class="ap-dd-empty">Aucun résultat dans Odoo</div>`;
          return;
        }
        showDropdown(odooRes, true);
      } catch (err) {
        statusEl.textContent = "Erreur Odoo: " + err.message;
        statusEl.style.color = "var(--red)";
        dropdown.style.display = "none";
      }
    }, 400);
  });

  input.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if (dropdown.style.display !== "none") {
        dropdown.style.display = "none";
        _ddActiveIdx = -1;
      } else {
        closeModal();
      }
      return;
    }
    if (dropdown.style.display === "none") return;
    const items = dropdown.querySelectorAll(".ap-dd-item");
    if (!items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      _ddHighlight(Math.min(_ddActiveIdx + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      _ddHighlight(Math.max(_ddActiveIdx - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (_ddActiveIdx >= 0 && items[_ddActiveIdx]) items[_ddActiveIdx].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }
  });
  input.addEventListener("blur", () => setTimeout(() => { dropdown.style.display = "none"; }, 150));
  input.focus();

  // ── نسخ الجدول (أسبوع/أيام) من زبون موجود مسبقًا في نفس الـ route ──
  copyLink.onclick = async () => {
    const show = copyPanel.style.display === "none";
    copyPanel.style.display = show ? "block" : "none";
    if (show) {
      if (!_copyRouteRows) {
        copyInput.disabled = true;
        copyInput.placeholder = "⏳ Chargement…";
        try {
          _copyRouteRows = await rpcController.fetchRouteCustomers(baseUrl, routeId);
        } catch (err) {
          addNotif("✗ " + err.message, "error");
          _copyRouteRows = [];
        }
        copyInput.disabled = false;
        copyInput.placeholder = "Chercher un client de cette route…";
      }
      copyInput.focus();
    } else {
      copyDropdown.style.display = "none";
      copyInput.value = "";
    }
  };

  let _copyRouteRows = null;
  let _copyDdActiveIdx = -1;

  function _copyDdHighlight(idx) {
    const items = copyDropdown.querySelectorAll(".ap-dd-item");
    items.forEach(el => el.classList.remove("ap-dd-item--active"));
    if (idx >= 0 && idx < items.length) {
      _copyDdActiveIdx = idx;
      items[idx].classList.add("ap-dd-item--active");
      items[idx].scrollIntoView({ block: "nearest" });
    } else {
      _copyDdActiveIdx = -1;
    }
  }

  function _applyCopiedSchedule(row) {
    const weeks = _routeWeeksActive(row);
    const days  = _ROUTE_DAYS.filter(d => _ROUTE_WEEKS.some(w => row[`w${w}${d}`] === true));
    selWeeks = [...weeks];
    selDays  = [...days];
    weeksEl.querySelectorAll(".acr-week-chk").forEach(chk => { chk.checked = weeks.includes(parseInt(chk.value, 10)); });
    daysEl.querySelectorAll(".acr-day-chk").forEach(chk => { chk.checked = days.includes(chk.value); });
    scheduleEl.style.display = "block";
    _updateSubmitState();
    copyPanel.style.display = "none";
    copyInput.value = "";
    copyDropdown.style.display = "none";
  }

  function _showCopyDropdown(rows) {
    copyDropdown.innerHTML = "";
    _copyDdActiveIdx = -1;
    if (!rows.length) {
      copyDropdown.innerHTML = `<div class="ap-dd-empty">Aucun résultat</div>`;
      copyDropdown.style.display = "block"; return;
    }
    rows.forEach(r => {
      const partnerName = Array.isArray(r.partner_id) ? r.partner_id[1] : "—";
      const partnerId = Array.isArray(r.partner_id) ? r.partner_id[0] : null;
      const ref = r._partnerRef || "—";
      const d = document.createElement("div");
      d.className = "ap-dd-item";
      d.innerHTML = `<span style="font-weight:700;color:var(--accent);margin-right:4px">${escHtml(String(ref))}</span>${escHtml(partnerName)}${_clientLinkIconHtml(partnerId, null)}`;
      d.onmousedown = e => { e.preventDefault(); _applyCopiedSchedule(r); };
      copyDropdown.appendChild(d);
    });
    copyDropdown.style.display = "block";
  }

  copyInput.addEventListener("input", () => {
    const q = copyInput.value.trim();
    if (!q || !_copyRouteRows) { copyDropdown.style.display = "none"; return; }
    const matches = rpcController.filterRouteClients(_copyRouteRows, q).slice(0, 12);
    _showCopyDropdown(matches);
  });
  copyInput.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if (copyDropdown.style.display !== "none") {
        copyDropdown.style.display = "none";
        _copyDdActiveIdx = -1;
      } else {
        closeModal();
      }
      return;
    }
    if (copyDropdown.style.display === "none") return;
    const items = copyDropdown.querySelectorAll(".ap-dd-item");
    if (!items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      _copyDdHighlight(Math.min(_copyDdActiveIdx + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      _copyDdHighlight(Math.max(_copyDdActiveIdx - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (_copyDdActiveIdx >= 0 && items[_copyDdActiveIdx]) items[_copyDdActiveIdx].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }
  });
  copyInput.addEventListener("blur", () => setTimeout(() => { copyDropdown.style.display = "none"; }, 150));

  submitBtn.addEventListener("click", async () => {
    if (!selectedClients.length || !selDays.length) return;
    submitBtn.disabled = true;
    submitBtn.textContent = "Ajout…";
    statusEl.textContent = "⏳ Ajout en cours…";
    statusEl.style.color = "var(--accent)";
    try {
      for (const client of selectedClients) {
        await rpcController.addClientToRoute(baseUrl, routeId, client.ref, _effectiveWeeks(selWeeks), selDays);
      }
      addNotif(`✓ ${selectedClients.length} client(s) ajouté(s) à la route`, "success");
      closeModal();
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Confirmer";
      statusEl.textContent = "✗ " + err.message;
      statusEl.style.color = "var(--red)";
    }
  });
}

// ── نافذة "إضافة زبون (من قسم Client) إلى route" — عكس النافذة أعلاه:
// الزبون ثابت هنا، والمستخدم يبحث عن اسم الـ route ثم يختار الأسبوع/الأيام.
// نفس منطق البحث (يتجاهل الترتيب والمسافات) + فقاعة استنساخ جدول زبون آخر
// من نفس الـ route بعد اختيارها.
function _openAddClientToRouteSearchFlow(client) {
  const baseUrl = getOdooBase();
  if (!baseUrl) { addNotif("URL Odoo non configurée", "error"); return; }
  if (!client?.id) { addNotif("Client invalide", "error"); return; }
  const clientRef   = String(client.ref || client.id);
  const clientLabel = client.name || clientRef;

  document.getElementById("addClientRouteFromClientModal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "addClientRouteFromClientModal";
  overlay.className = "ap-overlay";
  overlay.innerHTML = `
    <div class="ap-modal" style="max-width:380px">
      <div class="ap-header">
        <span class="ap-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            style="width:14px;height:14px;margin-right:5px;vertical-align:middle">
            <circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/>
            <path d="M8.5 19H15a4 4 0 0 0 4-4v0a4 4 0 0 0-4-4H9a4 4 0 0 1-4-4v0a4 4 0 0 1 4-4h6.5"/>
          </svg>
          Ajouter à une route — ${escHtml(clientLabel)}
        </span>
        <button class="ap-close" id="acrfClose">×</button>
      </div>
      <div style="position:relative;margin-top:2px">
        <input type="text" id="acrfRouteInput" class="ap-input"
          placeholder="Nom de la route…" autocomplete="off"/>
        <div id="acrfDropdown" class="ap-dropdown" style="display:none"></div>
      </div>
      <div id="acrfSelectedRoute" style="display:none;margin-top:4px"></div>

      <div id="acrfCopyWrap" style="display:none">
        <span id="acrfCopyPlanningLink"
          style="display:inline-block;margin-top:5px;font-size:10px;color:var(--accent);cursor:pointer;text-decoration:underline">
          Copier planning d'un client existant
        </span>
        <div id="acrfCopyPanel" style="display:none;position:relative;margin-top:5px">
          <input type="text" id="acrfCopyInput" class="ap-input"
            placeholder="Chercher un client de cette route…" autocomplete="off"/>
          <div id="acrfCopyDropdown" class="ap-dropdown" style="display:none"></div>
        </div>
      </div>

      <div id="acrfSchedule" style="display:none;margin-top:10px;border-top:1px solid var(--border,#333);padding-top:8px">
        <div style="font-size:11px;color:var(--text2);margin-bottom:5px">Semaine(s)</div>
        <div id="acrfWeeks" style="display:flex;gap:10px;margin-bottom:8px"></div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:5px">Jour(s)</div>
        <div id="acrfDays" style="display:flex;flex-wrap:wrap;gap:8px"></div>
      </div>

      <div id="acrfStatus"
        style="font-size:11px;min-height:14px;color:var(--text3);text-align:center;padding:3px 0"></div>
      <div class="ap-footer" style="margin-top:6px">
        <button class="ap-btn ap-btn-cancel" id="acrfCancel">Annuler</button>
        <button class="ap-btn ap-btn-add" id="acrfSubmit" disabled>Confirmer</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const input          = document.getElementById("acrfRouteInput");
  const dropdown       = document.getElementById("acrfDropdown");
  const selectedRouteEl= document.getElementById("acrfSelectedRoute");
  const copyWrap       = document.getElementById("acrfCopyWrap");
  const copyLink       = document.getElementById("acrfCopyPlanningLink");
  const copyPanel      = document.getElementById("acrfCopyPanel");
  const copyInput      = document.getElementById("acrfCopyInput");
  const copyDropdown   = document.getElementById("acrfCopyDropdown");
  const scheduleEl     = document.getElementById("acrfSchedule");
  const weeksEl        = document.getElementById("acrfWeeks");
  const daysEl         = document.getElementById("acrfDays");
  const statusEl       = document.getElementById("acrfStatus");
  const submitBtn      = document.getElementById("acrfSubmit");

  let selectedRoute = null; // { id, name }
  let selWeeks = [];
  let selDays  = [];
  let _routeRows = null; // cache fetchRouteCustomers للـ route المختارة (لأجل الاستنساخ)

  weeksEl.innerHTML = _ROUTE_WEEKS.map(w => `
    <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
      <input type="checkbox" class="acrf-week-chk" value="${w}"/> S${w}
    </label>`).join("");
  daysEl.innerHTML = _ROUTE_DAYS.map(d => `
    <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
      <input type="checkbox" class="acrf-day-chk" value="${d}"/> ${_ROUTE_DAY_LABELS_FR[d]}
    </label>`).join("");

  function _updateSubmitState() {
    submitBtn.disabled = !(selectedRoute && selDays.length);
  }
  weeksEl.querySelectorAll(".acrf-week-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      selWeeks = [...weeksEl.querySelectorAll(".acrf-week-chk:checked")].map(c => parseInt(c.value, 10));
      _updateSubmitState();
    });
  });
  daysEl.querySelectorAll(".acrf-day-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      selDays = [...daysEl.querySelectorAll(".acrf-day-chk:checked")].map(c => c.value);
      _updateSubmitState();
    });
  });

  const closeModal = () => overlay.remove();
  document.getElementById("acrfClose").onclick  = closeModal;
  document.getElementById("acrfCancel").onclick = closeModal;
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

  function _renderSelectedRoute() {
    if (!selectedRoute) { selectedRouteEl.style.display = "none"; return; }
    selectedRouteEl.style.display = "block";
    selectedRouteEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#166534;
        background:#dcfce7;border:1px solid #86efac;border-radius:6px;padding:5px 8px">
        <svg viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5"
          style="width:12px;height:12px;flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>
        <span style="flex:1">${escHtml(selectedRoute.name)}</span>
        <span id="acrfRouteClear" style="cursor:pointer;font-size:14px;color:#dc2626;line-height:1">×</span>
      </div>`;
    document.getElementById("acrfRouteClear").onclick = () => {
      selectedRoute = null; _routeRows = null;
      input.value = ""; selWeeks = []; selDays = [];
      weeksEl.querySelectorAll(".acrf-week-chk").forEach(c => c.checked = false);
      daysEl.querySelectorAll(".acrf-day-chk").forEach(c => c.checked = false);
      copyWrap.style.display = "none"; copyPanel.style.display = "none";
      copyInput.value = ""; copyDropdown.style.display = "none";
      scheduleEl.style.display = "none";
      _renderSelectedRoute();
      _updateSubmitState();
    };
  }

  function _selectRoute(route) {
    selectedRoute = route;
    _routeRows = null;
    input.value = "";
    dropdown.style.display = "none";
    statusEl.textContent = "";
    scheduleEl.style.display = "block";
    copyWrap.style.display = "block";
    _renderSelectedRoute();
    _updateSubmitState();
  }

  let _ddActiveIdx = -1;
  function _ddHighlight(idx) {
    const items = dropdown.querySelectorAll(".ap-dd-item");
    items.forEach(el => el.classList.remove("ap-dd-item--active"));
    if (idx >= 0 && idx < items.length) {
      _ddActiveIdx = idx;
      items[idx].classList.add("ap-dd-item--active");
      items[idx].scrollIntoView({ block: "nearest" });
    } else { _ddActiveIdx = -1; }
  }

  function showDropdown(items) {
    dropdown.innerHTML = "";
    _ddActiveIdx = -1;
    if (!items.length) {
      dropdown.innerHTML = `<div class="ap-dd-empty">Aucun résultat</div>`;
      dropdown.style.display = "block"; return;
    }
    items.forEach(r => {
      const d = document.createElement("div");
      d.className = "ap-dd-item";
      d.innerHTML = escHtml(r.name || "");
      d.onmousedown = e => { e.preventDefault(); _selectRoute({ id: r.id, name: r.name }); };
      dropdown.appendChild(d);
    });
    dropdown.style.display = "block";
  }

  let _routeSearchTimer = null;
  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(_routeSearchTimer);
    if (!q) { dropdown.style.display = "none"; return; }
    statusEl.textContent = "Recherche…";
    statusEl.style.color = "var(--text3)";
    _routeSearchTimer = setTimeout(async () => {
      try {
        const rows = await rpcController.searchRoutes(baseUrl, q);
        statusEl.textContent = "";
        showDropdown(rows || []);
      } catch (err) {
        statusEl.textContent = "Erreur: " + err.message;
        statusEl.style.color = "var(--red)";
        dropdown.style.display = "none";
      }
    }, 350);
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if (dropdown.style.display !== "none") { dropdown.style.display = "none"; _ddActiveIdx = -1; }
      else closeModal();
      return;
    }
    if (dropdown.style.display === "none") return;
    const items = dropdown.querySelectorAll(".ap-dd-item");
    if (!items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); _ddHighlight(Math.min(_ddActiveIdx + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); _ddHighlight(Math.max(_ddActiveIdx - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (_ddActiveIdx >= 0 && items[_ddActiveIdx]) items[_ddActiveIdx].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }
  });
  input.addEventListener("blur", () => setTimeout(() => { dropdown.style.display = "none"; }, 150));
  input.focus();

  // ── فقاعة استنساخ جدول (أسبوع/أيام) من زبون موجود مسبقًا داخل الـ route المختارة ──
  copyLink.onclick = async () => {
    if (!selectedRoute) return;
    const show = copyPanel.style.display === "none";
    copyPanel.style.display = show ? "block" : "none";
    if (show) {
      if (!_routeRows) {
        copyInput.disabled = true;
        copyInput.placeholder = "⏳ Chargement…";
        try {
          _routeRows = await rpcController.fetchRouteCustomers(baseUrl, selectedRoute.id);
        } catch (err) {
          addNotif("✗ " + err.message, "error");
          _routeRows = [];
        }
        copyInput.disabled = false;
        copyInput.placeholder = "Chercher un client de cette route…";
      }
      copyInput.focus();
    } else {
      copyDropdown.style.display = "none";
      copyInput.value = "";
    }
  };

  let _copyDdActiveIdx = -1;
  function _copyDdHighlight(idx) {
    const items = copyDropdown.querySelectorAll(".ap-dd-item");
    items.forEach(el => el.classList.remove("ap-dd-item--active"));
    if (idx >= 0 && idx < items.length) {
      _copyDdActiveIdx = idx;
      items[idx].classList.add("ap-dd-item--active");
      items[idx].scrollIntoView({ block: "nearest" });
    } else { _copyDdActiveIdx = -1; }
  }

  function _applyCopiedSchedule(row) {
    const weeks = _ROUTE_WEEKS.filter(w => _ROUTE_DAYS.some(d => row[`w${w}${d}`] === true));
    const days  = _ROUTE_DAYS.filter(d => _ROUTE_WEEKS.some(w => row[`w${w}${d}`] === true));
    selWeeks = [...weeks];
    selDays  = [...days];
    weeksEl.querySelectorAll(".acrf-week-chk").forEach(chk => { chk.checked = weeks.includes(parseInt(chk.value, 10)); });
    daysEl.querySelectorAll(".acrf-day-chk").forEach(chk => { chk.checked = days.includes(chk.value); });
    scheduleEl.style.display = "block";
    _updateSubmitState();
    copyPanel.style.display = "none";
    copyInput.value = "";
    copyDropdown.style.display = "none";
  }

  function _showCopyDropdown(rows) {
    copyDropdown.innerHTML = "";
    _copyDdActiveIdx = -1;
    if (!rows.length) {
      copyDropdown.innerHTML = `<div class="ap-dd-empty">Aucun résultat</div>`;
      copyDropdown.style.display = "block"; return;
    }
    rows.forEach(r => {
      const partnerName = Array.isArray(r.partner_id) ? r.partner_id[1] : "—";
      const partnerId = Array.isArray(r.partner_id) ? r.partner_id[0] : null;
      const ref = r._partnerRef || "—";
      const d = document.createElement("div");
      d.className = "ap-dd-item";
      d.innerHTML = `<span style="font-weight:700;color:var(--accent);margin-right:4px">${escHtml(String(ref))}</span>${escHtml(partnerName)}${_clientLinkIconHtml(partnerId, null)}`;
      d.onmousedown = e => { e.preventDefault(); _applyCopiedSchedule(r); };
      copyDropdown.appendChild(d);
    });
    copyDropdown.style.display = "block";
  }

  copyInput.addEventListener("input", () => {
    const q = copyInput.value.trim();
    if (!q || !_routeRows) { copyDropdown.style.display = "none"; return; }
    const matches = rpcController.filterRouteClients(_routeRows, q).slice(0, 12);
    _showCopyDropdown(matches);
  });
  copyInput.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if (copyDropdown.style.display !== "none") { copyDropdown.style.display = "none"; _copyDdActiveIdx = -1; }
      else closeModal();
      return;
    }
    if (copyDropdown.style.display === "none") return;
    const items = copyDropdown.querySelectorAll(".ap-dd-item");
    if (!items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); _copyDdHighlight(Math.min(_copyDdActiveIdx + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); _copyDdHighlight(Math.max(_copyDdActiveIdx - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (_copyDdActiveIdx >= 0 && items[_copyDdActiveIdx]) items[_copyDdActiveIdx].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }
  });
  copyInput.addEventListener("blur", () => setTimeout(() => { copyDropdown.style.display = "none"; }, 150));

  submitBtn.addEventListener("click", async () => {
    if (!selectedRoute || !selDays.length) return;
    submitBtn.disabled = true;
    submitBtn.textContent = "Ajout…";
    statusEl.textContent = "⏳ Ajout en cours…";
    statusEl.style.color = "var(--accent)";
    try {
      await rpcController.addClientToRoute(baseUrl, selectedRoute.id, clientRef, _effectiveWeeks(selWeeks), selDays);
      addNotif(`✓ Client ajouté à la route "${selectedRoute.name}"`, "success");
      closeModal();
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Confirmer";
      statusEl.textContent = "✗ " + err.message;
      statusEl.style.color = "var(--red)";
    }
  });
}

// ── نافذة الاختيار عند الضغط على زر Route من بطاقة زبون: إذا كان
// الزبون موجودًا مسبقًا في route، تُعرض خيارات "تعديل" و"حذف" إضافةً
// إلى "إضافة" (لإضافته إلى route أخرى) ─────────────────────────────
async function openAddClientToRouteFromClientModal(client) {
  const baseUrl = getOdooBase();
  if (!baseUrl) { addNotif("URL Odoo non configurée", "error"); return; }
  if (!client?.id) { addNotif("Client invalide", "error"); return; }
  const clientLabel = client.name || String(client.ref || client.id);

  document.getElementById("clientRouteChoiceModal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "clientRouteChoiceModal";
  overlay.className = "ap-overlay";
  overlay.innerHTML = `
    <div class="ap-modal" style="max-width:320px">
      <div class="ap-header">
        <span class="ap-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            style="width:14px;height:14px;margin-right:5px;vertical-align:middle">
            <circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/>
            <path d="M8.5 19H15a4 4 0 0 0 4-4v0a4 4 0 0 0-4-4H9a4 4 0 0 1-4-4v0a4 4 0 0 1 4-4h6.5"/>
          </svg>
          Route — ${escHtml(clientLabel)}
        </span>
        <button class="ap-close" id="crcClose">×</button>
      </div>
      <div id="crcBody" style="display:flex;flex-direction:column;gap:8px;margin-top:6px">
        <div style="font-size:11px;color:var(--text3);text-align:center;padding:10px 0">⏳ Chargement…</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const closeModal = () => overlay.remove();
  document.getElementById("crcClose").onclick = closeModal;
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

  const bodyEl = document.getElementById("crcBody");
  let info = null;
  try {
    info = await rpcController.findClientRoute(baseUrl, client.id);
  } catch (err) {
    addNotif("✗ " + err.message, "error");
  }

  const btnStyle = "font-size:12px;display:flex;align-items:center;gap:8px;padding:10px 12px;justify-content:flex-start";
  let html = `
    <button id="crcAdd" class="btn-tool" style="${btnStyle}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      Ajouter à une route
    </button>`;
  if (info && info.routeId) {
    html += `
    <div style="font-size:11px;color:var(--text2);padding:2px 2px 0">
      Actuellement dans : <strong>${escHtml(info.routeName || "")}</strong>
    </div>
    <button id="crcEdit" class="btn-tool" style="${btnStyle}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
      </svg>
      Modifier semaine / jour
    </button>
    <button id="crcRemove" class="btn-tool" style="${btnStyle};color:var(--red,#dc2626)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        <path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
      </svg>
      Retirer de la route actuelle
    </button>`;
  }
  bodyEl.innerHTML = html;

  document.getElementById("crcAdd").onclick = () => {
    closeModal();
    _openAddClientToRouteSearchFlow(client);
  };

  const editBtn = document.getElementById("crcEdit");
  if (editBtn) editBtn.onclick = () => {
    closeModal();
    openEditClientRouteScheduleModal(client, info);
  };

  const removeBtn = document.getElementById("crcRemove");
  if (removeBtn) removeBtn.onclick = () => {
    _confirmDangerAction(
      `Retirer ${clientLabel} de la route "${info.routeName || ""}" ?`,
      async () => {
        try {
          await rpcController.deleteRouteClients(baseUrl, info.eventIds);
          addNotif("✓ Client retiré de la route", "success");
          closeModal();
        } catch (err) {
          addNotif("✗ " + err.message, "error");
        }
      }
    );
  };
}

// ── modal تعديل semaine/jour لزبون واحد ضمن route حالية ─────────────
function openEditClientRouteScheduleModal(client, info) {
  const baseUrl = getOdooBase();
  const clientLabel = client.name || String(client.ref || client.id);

  document.getElementById("clientRouteScheduleModal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "clientRouteScheduleModal";
  overlay.className = "ap-overlay";
  overlay.innerHTML = `
    <div class="ap-modal" style="max-width:340px">
      <div class="ap-header">
        <span class="ap-title">Modifier — ${escHtml(clientLabel)}</span>
        <button class="ap-close" id="crsClose">×</button>
      </div>
      <div style="font-size:11px;color:var(--text2);margin:6px 0 5px">Semaine(s)</div>
      <div id="crsWeeks" style="display:flex;gap:10px;margin-bottom:8px"></div>
      <div style="font-size:11px;color:var(--text2);margin-bottom:5px">Jour(s)</div>
      <div id="crsDays" style="display:flex;flex-wrap:wrap;gap:8px"></div>
      <div id="crsStatus" style="font-size:11px;min-height:14px;color:var(--text3);text-align:center;padding:6px 0"></div>
      <div class="ap-footer" style="margin-top:4px">
        <button class="ap-btn ap-btn-cancel" id="crsCancel">Annuler</button>
        <button class="ap-btn ap-btn-add" id="crsSubmit">Confirmer</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const weeksEl = document.getElementById("crsWeeks");
  const daysEl  = document.getElementById("crsDays");
  const statusEl = document.getElementById("crsStatus");
  const submitBtn = document.getElementById("crsSubmit");

  weeksEl.innerHTML = _ROUTE_WEEKS.map(w => `
    <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
      <input type="checkbox" class="crs-week-chk" value="${w}" ${info.weeks.includes(w) ? "checked" : ""}/> S${w}
    </label>`).join("");
  daysEl.innerHTML = _ROUTE_DAYS.map(d => `
    <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
      <input type="checkbox" class="crs-day-chk" value="${d}" ${info.days.includes(d) ? "checked" : ""}/> ${_ROUTE_DAY_LABELS_FR[d]}
    </label>`).join("");

  let selWeeks = [...info.weeks];
  let selDays  = [...info.days];
  weeksEl.querySelectorAll(".crs-week-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      selWeeks = [...weeksEl.querySelectorAll(".crs-week-chk:checked")].map(c => parseInt(c.value, 10));
    });
  });
  daysEl.querySelectorAll(".crs-day-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      selDays = [...daysEl.querySelectorAll(".crs-day-chk:checked")].map(c => c.value);
    });
  });

  const closeModal = () => overlay.remove();
  document.getElementById("crsClose").onclick  = closeModal;
  document.getElementById("crsCancel").onclick = closeModal;
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

  submitBtn.addEventListener("click", async () => {
    if (!selDays.length) {
      statusEl.textContent = "Choisissez semaine(s) et jour(s)";
      statusEl.style.color = "var(--red)";
      return;
    }
    submitBtn.disabled = true;
    statusEl.textContent = "⏳ Mise à jour…";
    statusEl.style.color = "var(--accent)";
    try {
      await rpcController.updateRouteClientSchedule(baseUrl, info.eventIds, _effectiveWeeks(selWeeks), selDays);
      addNotif("✓ Planning mis à jour", "success");
      closeModal();
    } catch (err) {
      submitBtn.disabled = false;
      statusEl.textContent = "✗ " + err.message;
      statusEl.style.color = "var(--red)";
    }
  });
}

async function openRouteCustomersModal(worker) {
  const modal = document.getElementById("routeCustomersModal");
  if (!modal) return;
  const baseUrl = getOdooBase();
  if (!baseUrl) { addNotif("URL Odoo non configurée", "error"); return; }
  if (!worker?.routeId) { addNotif("Aucune route associée à cet agent", "error"); return; }
  _routeNavStack = []; // نقطة دخول جديدة (من route hub) — لا تراكم قديم

  document.getElementById("routeCustomersTitle").textContent = `Route — ${worker.routeName || worker.routeId}`;
  document.getElementById("routeCustomersCount").textContent = "Chargement…";
  document.getElementById("routeCustomersTbody").innerHTML = "";
  document.getElementById("routeCustomersEmpty").style.display = "none";
  const openLink = document.getElementById("btnRouteOpenInOdoo");
  if (openLink) openLink.href = `${baseUrl}/web#id=${worker.routeId}&model=planning.template&view_type=form`;
  modal.style.display = "flex";

  // إعادة تهيئة حالة البحث/الفلترة عند كل فتح للنافذة + إنشاء شريط
  // البحث/الفلترة وزر "Edit" (مرة واحدة فقط، idempotent).
  _rcmState.worker = worker;
  _rcmState.baseUrl = baseUrl;
  _rcmState.routeId = worker.routeId;
  _rcmState.rows = [];
  _rcmState.searchQuery = "";
  _rcmState.dayFilter = new Set();
  _rcmState.dayMode = "OR";
  _rcmState.weekFilter = new Set();
  _rcmState.weekMode = "OR";
  _ensureRouteCustomersFilterBar();
  const searchInput = document.getElementById("rcmSearchInput");
  if (searchInput) searchInput.value = "";

  // خزنة لكل route لحالها: لو route هذه محمَّلة مسبقًا → تظهر فورًا دون
  // انتظار. لو طلبها لا يزال جاريًا (بدأ من فتح سابق) → يكمل بالخلفية
  // دون إلغاء، ويُحدّث الشاشة تلقائيًا عند اكتماله إن كان المستخدم لا
  // يزال واقفًا على نفس هذه الـroute حينها.
  const entry = _rcmFetchRoute(baseUrl, worker.routeId);
  if (entry.rows) {
    _rcmState.rows = entry.rows;
    _renderRouteCustomersTable();
  } else if (entry.error) {
    document.getElementById("routeCustomersCount").textContent = "Erreur de chargement";
  }
  // وإلا (لا rows ولا error بعد): الشاشة تبقى بحالة "Chargement…" المضبوطة
  // أعلاه، وستُحدَّث تلقائيًا من داخل _rcmFetchRoute عند اكتمال الطلب.
}

// ══════════════════════════════════════════════════════════════
// "تعديل" — hub بمسارين (حسب اليوم / بحث عن زبون)، نتائج مُفلترة
// قابلة للتحديد المتعدد، مع تعديل/حذف فردي أو جماعي.
// ══════════════════════════════════════════════════════════════

// ── نافذة تأكيد عامة (خطر) — تُستخدم لتأكيد الحذف الفردي/الجماعي ──
function _confirmDangerAction(message, onConfirm) {
  const conf = document.createElement("div");
  conf.style.cssText = "position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)";
  conf.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;
      padding:20px;min-width:260px;max-width:320px;box-shadow:0 8px 32px rgba(0,0,0,.4)">
      <div style="font-size:12px;color:var(--text);margin-bottom:14px;line-height:1.5">${escHtml(message)}</div>
      <div style="display:flex;gap:8px">
        <button id="cdaNo" style="flex:1;padding:8px;background:var(--bg3);border:1px solid var(--border);
          color:var(--text2);border-radius:6px;cursor:pointer;font-size:12px">Cancel</button>
        <button id="cdaYes" style="flex:1;padding:8px;background:var(--red,#dc2626);border:none;color:#fff;
          border-radius:6px;cursor:pointer;font-size:12px;font-weight:700">Delete</button>
      </div>
    </div>`;
  document.body.appendChild(conf);
  document.getElementById("cdaYes").onclick = () => { conf.remove(); onConfirm(); };
  document.getElementById("cdaNo").onclick  = () => conf.remove();
  conf.addEventListener("click", e => { if (e.target === conf) conf.remove(); });
}

// ── hub "تعديل" — مسارين ────────────────────────────────────────
function openRouteEditHubModal(worker) {
  if (!worker?.routeId) { addNotif("No route associated with this agent", "error"); return; }
  document.getElementById("routeEditHubModal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "routeEditHubModal";
  overlay.className = "ap-overlay";
  overlay.innerHTML = `
    <div class="ap-modal" style="max-width:320px">
      <div class="ap-header">
        <span class="ap-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            style="margin-right:5px;vertical-align:middle">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          Edit — ${escHtml(worker.routeName || worker.routeId)}
        </span>
        <span style="display:flex;align-items:center;gap:4px">
          <button class="ap-close" id="rehBack" title="Back">←</button>
          <button class="ap-close" id="rehClose">×</button>
        </span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px">
        <button id="rehShowAll" class="btn-tool" style="font-size:12px;display:flex;align-items:center;gap:8px;padding:10px 12px;justify-content:flex-start">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
            <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
          </svg>
          Show all
        </button>
        <button id="rehByDay" class="btn-tool" style="font-size:12px;display:flex;align-items:center;gap:8px;padding:10px 12px;justify-content:flex-start">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          By day
        </button>
        <button id="rehBySearch" class="btn-tool" style="font-size:12px;display:flex;align-items:center;gap:8px;padding:10px 12px;justify-content:flex-start">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          Search customer
        </button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const closeModal = () => _routeNavCloseAll("routeEditHubModal");
  document.getElementById("rehClose").onclick = closeModal;
  document.getElementById("rehBack").onclick  = () => _routeNavBack("routeEditHubModal");
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

  document.getElementById("rehShowAll").onclick = async () => {
    const baseUrl = getOdooBase();
    if (!baseUrl) { addNotif("Odoo URL not configured", "error"); return; }
    try {
      const rows = await rpcController.fetchRouteCustomers(baseUrl, worker.routeId);
      _routeNavHide("routeEditHubModal");
      openRouteFilteredResultsModal(worker, rows, "Show all");
    } catch (err) {
      addNotif("✗ " + err.message, "error");
    }
  };
  document.getElementById("rehByDay").onclick = () => {
    _routeNavHide("routeEditHubModal");
    openRouteEditByDayModal(worker);
  };
  document.getElementById("rehBySearch").onclick = () => {
    _routeNavHide("routeEditHubModal");
    openRouteEditBySearchModal(worker);
  };
}

// ── مسار "حسب اليوم" — اختيار أيام متعدد، ثم فلترة زبائن الـroute
// بشرط OR (يوم واحد على الأقل من الأيام المختارة، بغض النظر عن الأسبوع) ──
function openRouteEditByDayModal(worker) {
  document.getElementById("routeEditByDayModal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "routeEditByDayModal";
  overlay.className = "ap-overlay";
  overlay.innerHTML = `
    <div class="ap-modal" style="max-width:340px">
      <div class="ap-header">
        <span class="ap-title">By day — ${escHtml(worker.routeName || worker.routeId)}</span>
        <span style="display:flex;align-items:center;gap:4px">
          <button class="ap-close" id="rebdBack" title="Back">←</button>
          <button class="ap-close" id="rebdClose">×</button>
        </span>
      </div>
      <div style="font-size:11px;color:var(--text2);margin:6px 0 5px">Select one or more days</div>
      <div id="rebdDays" style="display:flex;flex-wrap:wrap;gap:8px"></div>
      <div id="rebdStatus" style="font-size:11px;min-height:14px;color:var(--text3);text-align:center;padding:6px 0"></div>
      <div class="ap-footer" style="margin-top:4px">
        <button class="ap-btn ap-btn-cancel" id="rebdCancel">Cancel</button>
        <button class="ap-btn ap-btn-add" id="rebdSubmit" disabled>Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const daysEl    = document.getElementById("rebdDays");
  const submitBtn = document.getElementById("rebdSubmit");
  const statusEl  = document.getElementById("rebdStatus");

  daysEl.innerHTML = _ROUTE_DAYS.map(d => `
    <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
      <input type="checkbox" class="rebd-day-chk" value="${d}"/> ${_ROUTE_DAY_LABELS_EN[d]}
    </label>`).join("");

  let selDays = [];
  daysEl.querySelectorAll(".rebd-day-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      selDays = [...daysEl.querySelectorAll(".rebd-day-chk:checked")].map(c => c.value);
      submitBtn.disabled = !selDays.length;
    });
  });

  const closeModal = () => _routeNavCloseAll("routeEditByDayModal");
  document.getElementById("rebdClose").onclick  = closeModal;
  document.getElementById("rebdCancel").onclick = closeModal;
  document.getElementById("rebdBack").onclick   = () => _routeNavBack("routeEditByDayModal");
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

  submitBtn.addEventListener("click", async () => {
    const baseUrl = getOdooBase();
    if (!baseUrl) { addNotif("Odoo URL not configured", "error"); return; }
    submitBtn.disabled = true;
    statusEl.textContent = "⏳ Loading…";
    statusEl.style.color = "var(--accent)";
    try {
      const rows = await rpcController.fetchRouteCustomers(baseUrl, worker.routeId);
      const filtered = rows.filter(r => {
        const activeDays = _ROUTE_DAYS.filter(d => _ROUTE_WEEKS.some(w => r[`w${w}${d}`] === true));
        return selDays.some(d => activeDays.includes(d));
      });
      // نُخفي شاشة "By day" (لا نُزيلها) لتُحفظ اختيارات الأيام كما هي
      // إن رجع المستخدم إليها لاحقًا عبر زر Back من جدول النتائج.
      _routeNavHide("routeEditByDayModal");
      openRouteFilteredResultsModal(worker, filtered,
        `By day: ${selDays.map(d => _ROUTE_DAY_LABELS_EN[d]).join(", ")}`);
    } catch (err) {
      submitBtn.disabled = false;
      statusEl.textContent = "✗ " + err.message;
      statusEl.style.color = "var(--red)";
    }
  });
}

// ── مسار "بحث عن زبون" — بحث ذكي (يتجاهل الترتيب والمسافات) ضمن
// زبائن هذه الـroute فقط، اختيار متعدد → التأكيد يفتح جدول التعديل
// على هؤلاء الزبائن المحددين فقط (وليس من يشاركهم نفس اليوم) ──
function openRouteEditBySearchModal(worker) {
  const baseUrl = getOdooBase();
  if (!baseUrl) { addNotif("Odoo URL not configured", "error"); return; }

  document.getElementById("routeEditBySearchModal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "routeEditBySearchModal";
  overlay.className = "ap-overlay";
  overlay.innerHTML = `
    <div class="ap-modal" style="max-width:380px">
      <div class="ap-header">
        <span class="ap-title">Search customer — ${escHtml(worker.routeName || worker.routeId)}</span>
        <span style="display:flex;align-items:center;gap:4px">
          <button class="ap-close" id="rebsBack" title="Back">←</button>
          <button class="ap-close" id="rebsClose">×</button>
        </span>
      </div>
      <div style="position:relative;margin-top:2px">
        <input type="text" id="rebsInput" class="ap-input" placeholder="Client reference or name…"
          autocomplete="off" disabled/>
        <div id="rebsDropdown" class="ap-dropdown" style="display:none"></div>
      </div>
      <div id="rebsSelected"
        style="display:none;flex-direction:column;gap:4px;margin-top:6px;max-height:130px;overflow-y:auto"></div>
      <div id="rebsStatus" style="font-size:11px;min-height:14px;color:var(--text3);text-align:center;padding:6px 0"></div>
      <div class="ap-footer" style="margin-top:4px">
        <button class="ap-btn ap-btn-cancel" id="rebsCancel">Cancel</button>
        <button class="ap-btn ap-btn-add" id="rebsSubmit" disabled>Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const input      = document.getElementById("rebsInput");
  const dropdown   = document.getElementById("rebsDropdown");
  const statusEl   = document.getElementById("rebsStatus");
  const selectedEl = document.getElementById("rebsSelected");
  const submitBtn  = document.getElementById("rebsSubmit");

  const closeModal = () => _routeNavCloseAll("routeEditBySearchModal");
  document.getElementById("rebsClose").onclick  = closeModal;
  document.getElementById("rebsCancel").onclick = closeModal;
  document.getElementById("rebsBack").onclick   = () => _routeNavBack("routeEditBySearchModal");
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

  let routeRows = [];
  const selectedRows = [];

  statusEl.textContent = "⏳ Loading route clients…";
  statusEl.style.color = "var(--accent)";
  rpcController.fetchRouteCustomers(baseUrl, worker.routeId).then(rows => {
    routeRows = rows;
    statusEl.textContent = `${rows.length} client(s) — type to search`;
    statusEl.style.color = "var(--text3)";
    input.disabled = false;
    input.focus();
  }).catch(err => {
    statusEl.textContent = "✗ " + err.message;
    statusEl.style.color = "var(--red)";
  });

  function _renderSelectedList() {
    selectedEl.style.display = selectedRows.length ? "flex" : "none";
    selectedEl.innerHTML = selectedRows.map((r, i) => {
      const partnerName = Array.isArray(r.partner_id) ? r.partner_id[1] : "";
      const partnerId = Array.isArray(r.partner_id) ? r.partner_id[0] : null;
      const ref = r._partnerRef || "—";
      return `<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#166534;
        background:#dcfce7;border:1px solid #86efac;border-radius:6px;padding:5px 8px">
        <svg viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5"
          style="width:12px;height:12px;flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>
        <span style="flex:1">${escHtml(partnerName)}${_clientLinkIconHtml(partnerId, null)} · Ref: ${escHtml(String(ref))}</span>
        <span data-ridx="${i}" style="cursor:pointer;font-size:14px;color:#dc2626;line-height:1">×</span>
      </div>`;
    }).join("");
    selectedEl.querySelectorAll("[data-ridx]").forEach(el => {
      el.onclick = () => {
        selectedRows.splice(parseInt(el.dataset.ridx, 10), 1);
        submitBtn.disabled = !selectedRows.length;
        _renderSelectedList();
      };
    });
  }

  function _selectRow(r) {
    if (selectedRows.find(row => row.id === r.id)) {
      statusEl.textContent = "Client already added";
      statusEl.style.color = "var(--orange)";
      input.value = "";
      dropdown.style.display = "none";
      return;
    }
    selectedRows.push(r);
    input.value = "";
    dropdown.style.display = "none";
    statusEl.textContent = "";
    statusEl.style.color = "var(--text3)";
    submitBtn.disabled = false;
    _renderSelectedList();
    input.focus();
  }

  function showDropdown(items) {
    dropdown.innerHTML = "";
    _ddActiveIdx = -1;
    if (!items.length) {
      dropdown.innerHTML = `<div class="ap-dd-empty">No results</div>`;
      dropdown.style.display = "block"; return;
    }
    items.forEach(r => {
      const partnerName = Array.isArray(r.partner_id) ? r.partner_id[1] : "—";
      const partnerId = Array.isArray(r.partner_id) ? r.partner_id[0] : null;
      const ref = r._partnerRef || "—";
      const d = document.createElement("div");
      d.className = "ap-dd-item";
      d.innerHTML = `<span style="font-weight:700;color:var(--accent);margin-right:4px">${escHtml(String(ref))}</span>${escHtml(partnerName)}${_clientLinkIconHtml(partnerId, null)}`;
      d.onmousedown = e => { e.preventDefault(); _selectRow(r); };
      dropdown.appendChild(d);
    });
    dropdown.style.display = "block";
  }

  let _ddActiveIdx = -1;
  function _ddHighlight(idx) {
    const items = dropdown.querySelectorAll(".ap-dd-item");
    items.forEach(el => el.classList.remove("ap-dd-item--active"));
    if (idx >= 0 && idx < items.length) {
      _ddActiveIdx = idx;
      items[idx].classList.add("ap-dd-item--active");
      items[idx].scrollIntoView({ block: "nearest" });
    } else {
      _ddActiveIdx = -1;
    }
  }

  input.addEventListener("input", () => {
    const q = input.value.trim();
    _ddActiveIdx = -1;
    if (!q) { dropdown.style.display = "none"; return; }
    const matches = rpcController.filterRouteClients(routeRows, q).slice(0, 12);
    showDropdown(matches);
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if (dropdown.style.display !== "none") { dropdown.style.display = "none"; _ddActiveIdx = -1; }
      else closeModal();
      return;
    }
    if (dropdown.style.display === "none") return;
    const items = dropdown.querySelectorAll(".ap-dd-item");
    if (!items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      _ddHighlight(Math.min(_ddActiveIdx + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      _ddHighlight(Math.max(_ddActiveIdx - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (_ddActiveIdx >= 0 && items[_ddActiveIdx]) items[_ddActiveIdx].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }
  });
  input.addEventListener("blur", () => setTimeout(() => { dropdown.style.display = "none"; }, 150));

  submitBtn.addEventListener("click", () => {
    if (!selectedRows.length) return;
    // نُخفي شاشة البحث (لا نُزيلها) لتُحفظ الاختيارات/نص البحث كما هي
    // إن رجع المستخدم إليها لاحقًا عبر زر Back من جدول النتائج.
    _routeNavHide("routeEditBySearchModal");
    openRouteFilteredResultsModal(worker, [...selectedRows], `Search: ${selectedRows.length} customer(s)`);
  });
}

// ── نتيجة الفلترة (الخيارات الثلاثة: Show all / By day / Search) —
// جدول Client/Réf/Jour(s)/S1-S4 + بحث نصي وفلاتر أيام/أسابيع client-side
// فوق الصفوف الأصلية + checkbox لكل صف + أزرار تعديل/حذف فردي/جماعي ──
function openRouteFilteredResultsModal(worker, rows, contextLabel) {
  document.getElementById("routeFilteredModal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "routeFilteredModal";
  overlay.className = "ap-overlay";
  overlay.innerHTML = `
    <div class="ap-modal" style="max-width:960px;width:94vw">
      <div class="ap-header">
        <span class="ap-title">${escHtml(contextLabel)} — ${escHtml(worker.routeName || worker.routeId)}</span>
        <span style="display:flex;align-items:center;gap:4px">
          <button class="ap-close" id="rfmBack" title="Back">←</button>
          <button class="ap-close" id="rfmClose">×</button>
        </span>
      </div>

      <div style="position:relative;margin:4px 0 8px">
        <input type="text" id="rfmSearchInput" class="ap-input" placeholder="Search by name or reference…" autocomplete="off"/>
      </div>

      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:6px">
        <span style="font-size:10px;color:var(--text3);min-width:34px">Days</span>
        <div id="rfmDayBtns" style="display:flex;flex-wrap:wrap;gap:4px"></div>
        <button id="rfmDayMode" class="ap-btn" style="font-size:10px;padding:3px 8px;background:var(--bg3);border:1px solid var(--border);color:var(--text2)">OR</button>
      </div>
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:8px">
        <span style="font-size:10px;color:var(--text3);min-width:34px">Weeks</span>
        <div id="rfmWeekBtns" style="display:flex;flex-wrap:wrap;gap:4px"></div>
        <button id="rfmWeekMode" class="ap-btn" style="font-size:10px;padding:3px 8px;background:var(--bg3);border:1px solid var(--border);color:var(--text2)">OR</button>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0 8px;flex-wrap:wrap;gap:6px">
        <span id="rfmCount" style="font-size:11px;color:var(--text2)"></span>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <div id="rfmSaveBar" style="display:none;gap:6px;align-items:center">
            <span id="rfmSaveCount" style="font-size:11px;color:var(--accent,#3B82F6);font-weight:600"></span>
            <button id="rfmDiscard" class="ap-btn" style="font-size:11px;padding:4px 9px;background:var(--bg3);border:1px solid var(--border);color:var(--text2)">Discard</button>
            <button id="rfmSaveBtn" class="ap-btn" style="font-size:11px;padding:4px 9px;background:var(--accent,#3B82F6);color:#fff;font-weight:600">Save</button>
          </div>
          <div id="rfmBulkBar" style="display:none;gap:6px">
            <button id="rfmBulkEdit" class="ap-btn" style="background:var(--accent,#3B82F6);color:#fff">Change day</button>
            <button id="rfmBulkDelete" class="ap-btn" style="background:var(--red,#dc2626);color:#fff">Delete</button>
          </div>
        </div>
      </div>
      <div class="pm-body" style="max-height:55vh;overflow-y:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="text-align:right;border-bottom:1px solid var(--border,#333)">
              <th style="padding:6px 8px"><input type="checkbox" id="rfmSelectAll"/></th>
              <th style="padding:6px 8px">Client</th>
              <th style="padding:6px 8px">Ref</th>
              <th style="padding:6px 8px">Day(s)</th>
              <th style="padding:6px 8px;text-align:center">S1</th>
              <th style="padding:6px 8px;text-align:center">S2</th>
              <th style="padding:6px 8px;text-align:center">S3</th>
              <th style="padding:6px 8px;text-align:center">S4</th>
              <th style="padding:6px 8px;text-align:center">Actions</th>
            </tr>
          </thead>
          <tbody id="rfmTbody"></tbody>
        </table>
        <div id="rfmEmpty" style="display:none;padding:20px;text-align:center;color:var(--text2);font-size:12px">
          No clients found.
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // sourceRows: النسخة الأصلية (المصدر الحقيقي)؛ تُعدَّل فقط عند الحذف.
  let sourceRows = [...rows];
  const selected = new Set();

  let searchQuery = "";
  const dayFilter  = new Set();
  let   dayMode    = "OR";
  const weekFilter = new Set();
  let   weekMode   = "OR";

  // ── تعديلات محلية غير محفوظة بعد (id -> {days:[...], weeks:[...]}) —
  // يُملأ عند أول تفاعل (فتح dropdown الأيام أو الضغط على خانة أسبوع)
  // على صف معيّن، وتُطبَّق فعليًا على السيرفر فقط عند الضغط على Save ──
  const pendingEdits = new Map();

  function _effDays(row) {
    const p = pendingEdits.get(row.id);
    return p ? [...p.days] : _rowActiveDays(row);
  }
  function _effWeeks(row) {
    const p = pendingEdits.get(row.id);
    return p ? [...p.weeks] : _routeWeeksActive(row);
  }
  function _ensurePending(row) {
    if (!pendingEdits.has(row.id)) {
      pendingEdits.set(row.id, { days: _rowActiveDays(row), weeks: _routeWeeksActive(row) });
    }
    return pendingEdits.get(row.id);
  }
  function _updateSaveBar() {
    const bar = document.getElementById("rfmSaveBar");
    const n = pendingEdits.size;
    bar.style.display = n ? "flex" : "none";
    document.getElementById("rfmSaveCount").textContent = n ? `${n} unsaved change(s)` : "";
  }

  const closeModal = () => {
    document.getElementById("rfmDayDropdown")?.remove();
    document.getElementById("rfmDayDropdownBackdrop")?.remove();
    _routeNavCloseAll("routeFilteredModal");
  };
  document.getElementById("rfmClose").onclick = closeModal;
  document.getElementById("rfmBack").onclick  = () => _routeNavBack("routeFilteredModal");
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

  function _rowActiveDays(r) {
    return _ROUTE_DAYS.filter(d => _ROUTE_WEEKS.some(w => r[`w${w}${d}`] === true));
  }

  function _searchFiltered() {
    return searchQuery ? rpcController.filterRouteClients(sourceRows, searchQuery) : sourceRows;
  }
  function _byDay(rowsIn) {
    if (!dayFilter.size) return rowsIn;
    return rowsIn.filter(r => {
      const activeDays = _rowActiveDays(r);
      return dayMode === "OR"
        ? [...dayFilter].some(d => activeDays.includes(d))
        : [...dayFilter].every(d => activeDays.includes(d));
    });
  }
  function _byWeek(rowsIn) {
    if (!weekFilter.size) return rowsIn;
    return rowsIn.filter(r => {
      const activeWeeks = _routeWeeksActive(r);
      return weekMode === "OR"
        ? [...weekFilter].some(w => activeWeeks.includes(w))
        : [...weekFilter].every(w => activeWeeks.includes(w));
    });
  }

  function _displayRows() {
    return _byWeek(_byDay(_searchFiltered()));
  }

  function _updateBulkBar(displayRows) {
    document.getElementById("rfmBulkBar").style.display = selected.size > 1 ? "flex" : "none";
    const selectAll = document.getElementById("rfmSelectAll");
    if (selectAll) selectAll.checked = displayRows.length > 0 && displayRows.every(r => selected.has(r.id));
  }

  function _wireRowEvents(displayRows) {
    document.querySelectorAll(".rfm-row-chk").forEach(chk => {
      chk.onchange = () => {
        const eid = parseInt(chk.dataset.eid, 10);
        if (chk.checked) selected.add(eid); else selected.delete(eid);
        _updateBulkBar(displayRows);
      };
    });
    // خانة "Day(s)": الضغط يفتح dropdown يسمح باختيار أكثر من يوم؛ كل
    // تغيير يُطبَّق محليًا فورًا (بدون حفظ فعلي) عبر pendingEdits.
    document.querySelectorAll(".rfm-row-day").forEach(cell => {
      cell.onclick = (e) => {
        e.stopPropagation();
        const eid = parseInt(cell.dataset.eid, 10);
        const row = sourceRows.find(r => r.id === eid);
        if (!row) return;
        _openDayDropdown(cell, row, _effDays(row), (newDays) => {
          const p = _ensurePending(row);
          p.days = newDays;
          _updateSaveBar();
          _renderRows();
        });
      };
    });
    // خانات S1-S4: الضغط المباشر على الخلية يُبدّل حالتها (تحديد/إلغاء)
    // فورًا محليًا، دون فتح أي نافذة/dropdown.
    document.querySelectorAll(".rfm-row-week").forEach(cell => {
      cell.onclick = () => {
        const eid = parseInt(cell.dataset.eid, 10);
        const w   = parseInt(cell.dataset.week, 10);
        const row = sourceRows.find(r => r.id === eid);
        if (!row) return;
        const p = _ensurePending(row);
        if (p.weeks.includes(w)) p.weeks = p.weeks.filter(x => x !== w);
        else p.weeks = [...p.weeks, w].sort();
        _updateSaveBar();
        _renderRows();
      };
    });
    document.querySelectorAll(".rfm-row-del").forEach(btn => {
      btn.onclick = () => {
        const eid = parseInt(btn.dataset.eid, 10);
        const row = sourceRows.find(r => r.id === eid);
        if (!row) return;
        const partnerName = Array.isArray(row.partner_id) ? row.partner_id[1] : "";
        _confirmDangerAction(`Delete "${partnerName}" from this route?`, async () => {
          const baseUrl = getOdooBase();
          if (!baseUrl) { addNotif("Odoo URL not configured", "error"); return; }
          try {
            await rpcController.deleteRouteClients(baseUrl, [eid]);
            sourceRows = sourceRows.filter(r => r.id !== eid);
            selected.delete(eid);
            _renderAll();
            addNotif("✓ Client removed from route", "success");
          } catch (err) {
            addNotif("✗ " + err.message, "error");
          }
        });
      };
    });
  }

  function _renderRows() {
    const displayRows = _displayRows();
    const tbody   = document.getElementById("rfmTbody");
    const countEl = document.getElementById("rfmCount");
    const emptyEl = document.getElementById("rfmEmpty");
    countEl.textContent = `${displayRows.length} client(s)`;
    if (!displayRows.length) {
      tbody.innerHTML = "";
      emptyEl.style.display = "block";
    } else {
      emptyEl.style.display = "none";
      tbody.innerHTML = displayRows.map(r => {
        const partner = Array.isArray(r.partner_id) ? r.partner_id[1] : "—";
        const ref = r._partnerRef || "—";
        const isDirty = pendingEdits.has(r.id);
        const effDays  = _effDays(r);
        const effWeeks = _effWeeks(r);
        const day = effDays.length ? effDays.map(d => _ROUTE_DAY_LABELS_EN[d]).join(", ") : "—";
        const dirtyBg = isDirty ? "background:rgba(59,130,246,.12);" : "";
        const weekCells = _ROUTE_WEEKS.map(w =>
          `<td class="rfm-row-week" data-eid="${r.id}" data-week="${w}" style="padding:6px 8px;text-align:center;cursor:pointer;${dirtyBg}" title="Click to toggle S${w}">${effWeeks.includes(w) ? "✕" : ""}</td>`
        ).join("");
        return `<tr style="border-bottom:1px solid var(--border,#2a2a2a)">
          <td style="padding:6px 8px"><input type="checkbox" class="rfm-row-chk" data-eid="${r.id}" ${selected.has(r.id) ? "checked" : ""}/></td>
          <td style="padding:6px 8px">${escHtml(partner)}</td>
          <td style="padding:6px 8px">${escHtml(String(ref))}</td>
          <td class="rfm-row-day" data-eid="${r.id}" style="padding:6px 8px;cursor:pointer;${dirtyBg}" title="Click to edit visit day(s)">${escHtml(day)}${isDirty ? ' <span style="color:var(--accent,#3B82F6)">●</span>' : ""}</td>
          ${weekCells}
          <td style="padding:6px 8px;text-align:center;white-space:nowrap">
            <button class="rfm-row-del" data-eid="${r.id}" style="border:none;background:none;color:var(--red,#dc2626);cursor:pointer;font-size:11px;font-weight:600">Delete</button>
          </td>
        </tr>`;
      }).join("");
    }
    _wireRowEvents(displayRows);
    _updateBulkBar(displayRows);
    _updateSaveBar();
  }

  function _btnStyle(active, disabled) {
    if (disabled) return "font-size:11px;padding:4px 9px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text3);opacity:.4;cursor:not-allowed";
    if (active)   return "font-size:11px;padding:4px 9px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;font-weight:600";
    return "font-size:11px;padding:4px 9px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);cursor:pointer";
  }

  function _renderFilterButtons() {
    const baseAfterSearch = _searchFiltered();
    // إتاحة أزرار الأيام: تُحسب على الصفوف بعد البحث + فلتر الأسابيع فقط (باستثناء فلتر الأيام نفسه)
    const dayAvailRows  = _byWeek(baseAfterSearch);
    // إتاحة أزرار الأسابيع: تُحسب على الصفوف بعد البحث + فلتر الأيام فقط (باستثناء فلتر الأسابيع نفسه)
    const weekAvailRows = _byDay(baseAfterSearch);

    const availableDays  = new Set(dayAvailRows.flatMap(r => _rowActiveDays(r)));
    const availableWeeks = new Set(weekAvailRows.flatMap(r => _routeWeeksActive(r)));

    const dayBtns = document.getElementById("rfmDayBtns");
    dayBtns.innerHTML = _ROUTE_DAYS.map(d => {
      const active   = dayFilter.has(d);
      const disabled = !availableDays.has(d) && !active;
      return `<button type="button" class="rfm-day-btn" data-day="${d}" ${disabled ? "disabled" : ""}
        style="${_btnStyle(active, disabled)}">${_ROUTE_DAY_LABELS_EN[d]}</button>`;
    }).join("");
    dayBtns.querySelectorAll(".rfm-day-btn:not([disabled])").forEach(btn => {
      btn.onclick = () => {
        const d = btn.dataset.day;
        if (dayFilter.has(d)) dayFilter.delete(d); else dayFilter.add(d);
        _renderAll();
      };
    });

    const weekBtns = document.getElementById("rfmWeekBtns");
    weekBtns.innerHTML = _ROUTE_WEEKS.map(w => {
      const active   = weekFilter.has(w);
      const disabled = !availableWeeks.has(w) && !active;
      return `<button type="button" class="rfm-week-btn" data-week="${w}" ${disabled ? "disabled" : ""}
        style="${_btnStyle(active, disabled)}">S${w}</button>`;
    }).join("");
    weekBtns.querySelectorAll(".rfm-week-btn:not([disabled])").forEach(btn => {
      btn.onclick = () => {
        const w = parseInt(btn.dataset.week, 10);
        if (weekFilter.has(w)) weekFilter.delete(w); else weekFilter.add(w);
        _renderAll();
      };
    });

    const dayModeBtn = document.getElementById("rfmDayMode");
    dayModeBtn.textContent = dayMode;
    dayModeBtn.onclick = () => { dayMode = dayMode === "OR" ? "AND" : "OR"; _renderAll(); };

    const weekModeBtn = document.getElementById("rfmWeekMode");
    weekModeBtn.textContent = weekMode;
    weekModeBtn.onclick = () => { weekMode = weekMode === "OR" ? "AND" : "OR"; _renderAll(); };
  }

  function _renderAll() {
    _renderFilterButtons();
    _renderRows();
  }

  document.getElementById("rfmSearchInput").addEventListener("input", (e) => {
    searchQuery = e.target.value.trim();
    _renderAll();
  });

  document.getElementById("rfmSelectAll").onchange = (e) => {
    const displayRows = _displayRows();
    if (e.target.checked) displayRows.forEach(r => selected.add(r.id));
    else displayRows.forEach(r => selected.delete(r.id));
    _renderRows();
  };

  document.getElementById("rfmBulkEdit").onclick = () => {
    const rowsSel = sourceRows.filter(r => selected.has(r.id));
    if (!rowsSel.length) return;
    openRouteScheduleEditModal(worker, rowsSel, () => _renderAll());
  };

  document.getElementById("rfmDiscard").onclick = () => {
    pendingEdits.clear();
    _renderAll();
  };

  document.getElementById("rfmSaveBtn").onclick = async () => {
    const baseUrl = getOdooBase();
    if (!baseUrl) { addNotif("Odoo URL not configured", "error"); return; }
    const saveBtn = document.getElementById("rfmSaveBtn");
    const entries = [...pendingEdits.entries()];
    if (!entries.length) return;

    // نتحقّق أولًا أن كل تعديل معلَّق يملك يومًا وأسبوعًا واحدًا على الأقل
    // (استبدال كامل بدون أيام/أسابيع غير مسموح من طرف الـRPC نفسه).
    const invalid = entries.filter(([, v]) => !v.days.length || !v.weeks.length);
    if (invalid.length) {
      addNotif("✗ Each edited client needs at least one day and one week selected", "error");
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    let okCount = 0, failCount = 0;
    for (const [eid, v] of entries) {
      const row = sourceRows.find(r => r.id === eid);
      if (!row) { pendingEdits.delete(eid); continue; }
      try {
        const newVals = await rpcController.updateRouteClientSchedule(baseUrl, [eid], v.weeks, v.days);
        Object.assign(row, newVals);
        pendingEdits.delete(eid);
        okCount++;
      } catch (err) {
        failCount++;
      }
    }
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
    if (okCount)   addNotif(`✓ ${okCount} client(s) updated`, "success");
    if (failCount) addNotif(`✗ ${failCount} client(s) failed to update`, "error");
    _renderAll();
  };

  document.getElementById("rfmBulkDelete").onclick = () => {
    const ids = [...selected];
    if (!ids.length) return;
    _confirmDangerAction(`Delete ${ids.length} client(s) from this route?`, async () => {
      const baseUrl = getOdooBase();
      if (!baseUrl) { addNotif("Odoo URL not configured", "error"); return; }
      try {
        await rpcController.deleteRouteClients(baseUrl, ids);
        sourceRows = sourceRows.filter(r => !selected.has(r.id));
        selected.clear();
        _renderAll();
        addNotif("✓ Clients removed from route", "success");
      } catch (err) {
        addNotif("✗ " + err.message, "error");
      }
    });
  };

  _renderAll();
}

// ── نافذة اختيار أسبوع/يوم لتعديل جدول الزيارة (فردي أو جماعي) —
// التأكيد يستبدل جدول الزيارة بالكامل (28 boolean) لكل eventId مختار،
// وليس إضافة فوق القديم. عند صف واحد: تُعبَّأ الاختيارات الحالية مسبقًا
// كنقطة انطلاق مريحة، لكن التأكيد يبقى استبدالًا كاملًا ──
// ── تعديل فردي سريع (يوم/أسبوع) بالضغط على خانة الجدول مباشرة —
// popover صغير يظهر قرب الخانة المضغوطة، دون فتح نافذة كاملة.
// التعديل الجماعي (أكثر من زبون) يبقى عبر openRouteScheduleEditModal ──
// ── dropdown اختيار الأيام (متعدد) — يُفتح بالضغط على خانة "Day(s)"
// فقط. كل ضغطة على checkbox تستدعي onChange فورًا بقائمة الأيام
// الجديدة (تعديل محلي غير محفوظ بعد)؛ لا يوجد زر تأكيد هنا — الحفظ
// الفعلي على السيرفر يتم لاحقًا عبر زر "Save" العام في أعلى الجدول ──
function _openDayDropdown(anchorEl, row, currentDays, onChange) {
  document.getElementById("rfmDayDropdown")?.remove();
  document.getElementById("rfmDayDropdownBackdrop")?.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "rfmDayDropdownBackdrop";
  backdrop.style.cssText = "position:fixed;inset:0;z-index:9998;";
  document.body.appendChild(backdrop);

  const pop = document.createElement("div");
  pop.id = "rfmDayDropdown";
  pop.className = "ap-modal";
  pop.style.cssText = "position:fixed;z-index:9999;max-width:180px;width:180px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,.35)";

  const preDays = [...currentDays];

  pop.innerHTML = `
    <div style="font-size:11px;color:var(--text2);margin-bottom:6px">Day(s)</div>
    <div id="rddDays" style="display:flex;flex-direction:column;gap:6px"></div>`;
  document.body.appendChild(pop);

  // ── تموضع الـdropdown قرب الخانة المضغوطة، مع البقاء داخل الشاشة ──
  const r = anchorEl.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let top  = r.bottom + 6;
  let left = r.left;
  if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
  if (top + popRect.height > window.innerHeight - 8) top = r.top - popRect.height - 6;
  pop.style.top  = `${Math.max(8, top)}px`;
  pop.style.left = `${Math.max(8, left)}px`;

  const daysEl = document.getElementById("rddDays");
  daysEl.innerHTML = _ROUTE_DAYS.map(d => `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
      <input type="checkbox" class="rdd-day-chk" value="${d}" ${preDays.includes(d) ? "checked" : ""}/> ${_ROUTE_DAY_LABELS_EN[d]}
    </label>`).join("");

  daysEl.querySelectorAll(".rdd-day-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      const selDays = [...daysEl.querySelectorAll(".rdd-day-chk:checked")].map(c => c.value);
      onChange(selDays);
    });
  });

  const closeDropdown = () => { pop.remove(); backdrop.remove(); document.removeEventListener("keydown", escHandler); };
  backdrop.addEventListener("click", closeDropdown);
  const escHandler = (e) => { if (e.key === "Escape") closeDropdown(); };
  document.addEventListener("keydown", escHandler);
}

function openRouteScheduleEditModal(worker, rowsToEdit, onSuccess, opts = {}) {
  const baseUrl = getOdooBase();
  if (!baseUrl) { addNotif("Odoo URL not configured", "error"); return; }
  if (!rowsToEdit?.length) return;

  document.getElementById("routeScheduleEditModal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "routeScheduleEditModal";
  overlay.className = "ap-overlay";
  const single = rowsToEdit.length === 1;
  const label = single
    ? (Array.isArray(rowsToEdit[0].partner_id) ? rowsToEdit[0].partner_id[1] : "")
    : `${rowsToEdit.length} clients selected`;

  overlay.innerHTML = `
    <div class="ap-modal" style="max-width:340px">
      <div class="ap-header">
        <span class="ap-title">Change visit day — ${escHtml(label)}</span>
        <span style="display:flex;align-items:center;gap:4px">
          <button class="ap-close" id="rseBack" title="Back">←</button>
          <button class="ap-close" id="rseClose">×</button>
        </span>
      </div>
      <div style="font-size:11px;color:#c2410c;background:#FFF7ED;border:1px solid #FED7AA;
        border-radius:6px;padding:6px 8px;margin:6px 0;line-height:1.5">
        This will fully replace the visit schedule with what you select here.
      </div>
      <div style="font-size:11px;color:var(--text2);margin-bottom:5px">Week(s)</div>
      <div id="rseWeeks" style="display:flex;gap:10px;margin-bottom:8px"></div>
      <div style="font-size:11px;color:var(--text2);margin-bottom:5px">Day(s)</div>
      <div id="rseDays" style="display:flex;flex-wrap:wrap;gap:8px"></div>
      <div id="rseStatus" style="font-size:11px;min-height:14px;color:var(--text3);text-align:center;padding:6px 0"></div>
      <div class="ap-footer" style="margin-top:4px">
        <button class="ap-btn ap-btn-cancel" id="rseCancel">Cancel</button>
        <button class="ap-btn ap-btn-add" id="rseSubmit" disabled>Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const weeksEl   = document.getElementById("rseWeeks");
  const daysEl    = document.getElementById("rseDays");
  const submitBtn = document.getElementById("rseSubmit");
  const statusEl  = document.getElementById("rseStatus");

  let preWeeks = [], preDays = [];
  if (single) {
    const row = rowsToEdit[0];
    preWeeks = _routeWeeksActive(row);
    preDays  = _ROUTE_DAYS.filter(d => _ROUTE_WEEKS.some(w => row[`w${w}${d}`] === true));
  }

  weeksEl.innerHTML = _ROUTE_WEEKS.map(w => `
    <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
      <input type="checkbox" class="rse-week-chk" value="${w}" ${preWeeks.includes(w) ? "checked" : ""}/> S${w}
    </label>`).join("");
  daysEl.innerHTML = _ROUTE_DAYS.map(d => `
    <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
      <input type="checkbox" class="rse-day-chk" value="${d}" ${preDays.includes(d) ? "checked" : ""}/> ${_ROUTE_DAY_LABELS_EN[d]}
    </label>`).join("");

  let selWeeks = [...preWeeks];
  let selDays  = [...preDays];
  function _updateSubmitState() { submitBtn.disabled = !selDays.length; }
  _updateSubmitState();

  weeksEl.querySelectorAll(".rse-week-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      selWeeks = [...weeksEl.querySelectorAll(".rse-week-chk:checked")].map(c => parseInt(c.value, 10));
      _updateSubmitState();
    });
  });
  daysEl.querySelectorAll(".rse-day-chk").forEach(chk => {
    chk.addEventListener("change", () => {
      selDays = [...daysEl.querySelectorAll(".rse-day-chk:checked")].map(c => c.value);
      _updateSubmitState();
    });
  });

  // ملاحظة: هذه النافذة تُفتح فوق جدول النتائج (rfm) دون إخفائه، لذا
  // "Back"/"Cancel"/"×" الثلاثة تُغلق هذه النافذة فقط وتكشف عن جدول
  // النتائج كما كان (نفس تحديد الـcheckboxes) — لا حاجة لمكدّس تنقّل هنا.
  const closeModal = () => overlay.remove();
  document.getElementById("rseClose").onclick  = closeModal;
  document.getElementById("rseCancel").onclick = closeModal;
  document.getElementById("rseBack").onclick   = closeModal;
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

  submitBtn.addEventListener("click", async () => {
    const weeks = _effectiveWeeks(selWeeks);

    // deferSave: لا نداء RPC هنا — نبني القيم محليًا (نفس منطق الخادم) ونترك الحفظ الفعلي لزر "Enregistrer"
    if (opts.deferSave) {
      const vals = {};
      _ROUTE_WEEKS.forEach(w => _ROUTE_DAYS.forEach(d => { vals[`w${w}${d}`] = weeks.includes(w) && selDays.includes(d); }));
      rowsToEdit.forEach(r => Object.assign(r, vals));
      addNotif(`${rowsToEdit.length} changement(s) en attente — cliquez sur "Enregistrer" pour valider`, "info");
      closeModal();
      onSuccess?.(vals, { weeks, days: [...selDays] });
      return;
    }

    submitBtn.disabled = true;
    statusEl.textContent = "⏳ Updating…";
    statusEl.style.color = "var(--accent)";
    try {
      const ids = rowsToEdit.map(r => r.id);
      const newVals = await rpcController.updateRouteClientSchedule(baseUrl, ids, weeks, selDays);
      rowsToEdit.forEach(r => Object.assign(r, newVals));
      addNotif(`✓ Visit day(s) updated (${ids.length})`, "success");
      closeModal();
      onSuccess?.(newVals);
    } catch (err) {
      submitBtn.disabled = false;
      statusEl.textContent = "✗ " + err.message;
      statusEl.style.color = "var(--red)";
    }
  });
}

async function _dispatchAction(btn, e) {
  const action   = btn.dataset.action;
  const workerId = btn.dataset.vendor;
  const linkRaw  = App.allLinks[workerId];
  const link     = Array.isArray(linkRaw) ? linkRaw[0] : linkRaw;
  const worker   = allWorkers().find(v => v.id === workerId);
  const lbl      = worker?.label || worker?.name || workerId;

  switch (action) {

    case "open": {
      if (!link) { addNotif("Pas de lien", "error"); return; }
      const cardEl = document.querySelector(`.vc[data-vendor-id="${workerId}"]`);
      const activeUrl = cardEl?._currentRoundUrl || link;
      window.open(activeUrl, "_blank");
      addNotif(`Ouvert: ${lbl}`, "success");
      break;
    }

    case "payment": {
      if (!App.settings?.baseUrlPayment) { addNotif("URL paiement non configurée", "error"); return; }
      if (App.currentDateOffset !== 0)   { addNotif("Paiement disponible uniquement pour aujourd'hui", "warning"); return; }
      if (worker.role !== "prevente")     { openPaymentModal(worker.id); break; }

      // confirmation in-app pour prevente
      _showPayConfirm(worker, () => openPaymentModal(worker.id));
      break;
    }

    case "showClients": {
      const worker = allWorkers().find(w => String(w.id) === String(workerId));
      if (!worker) break;
      if (e?.ctrlKey || e?.metaKey) {
        showClientsModalWM(workerId);
      } else {
        showClientsModal(workerId);
      }
      break;
    }
    case "showReports": {
      showDelayedOrdersModal(workerId);
      break;
    }
    case "showVentes": {
      showSoldOrdersModal(workerId);
      break;
    }
    case "showRetours": {
      showReturnOrdersModal(workerId);
      break;
    }

    case "allowAffect": {
      const roundId = App.allStats[workerId]?.roundId;
      if (!roundId) { addNotif("Tournée non trouvée", "warning"); return; }
      btn.disabled = true;
      try {
        await _rpc_call("", {
          model: "planning.planning", method: "toggle_allow_open_affectation",
          args: [[roundId]], kwargs: {},
        });
        const updated = await _rpc_call("", {
          model: "planning.planning", method: "read",
          args: [[roundId], ["allow_open_affectation"]], kwargs: {},
        });
        const on = updated?.[0]?.allow_open_affectation ?? false;
        btn.style.border     = `1px solid ${on ? "#FECACA" : "#BBF7D0"}`;
        btn.style.background = on ? "#FEF2F2" : "#F0FDF4";
        btn.style.color      = on ? "#DC2626" : "#15803d";
        btn.title            = on ? "Affectation autorisée" : "Autoriser l'affectation";
        addNotif(on ? "Affectation autorisée ✓" : "Affectation restreinte ✓", "success");
      } catch(err) {
        addNotif("Erreur: " + err.message, "error");
      } finally {
        btn.disabled = false;
      }
      break;
    }

    case "showBLs": {
      const roundId = App.allStats[workerId]?.roundId;
      if (!roundId) { addNotif("Tournée non trouvée", "warning"); return; }
      if (e?.ctrlKey || e?.metaKey) {
        showBLsModalWM(workerId);
      } else {
        showBLsModal(workerId);
      }
      break;
    }

    case "bonChargement": {
      const baseUrl = getOdooBase();
      if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
      const roundId = App.allStats[workerId]?.roundId;
      if (!roundId) { addNotif("Tournée non trouvée", "warning"); return; }
      showBonChargementModal(workerId, lbl, roundId, baseUrl);
      break;
    }



    case "showMap": {
      const roundId = App.allStats[workerId]?.roundId;
      if (!roundId) { addNotif("Tournée non trouvée", "warning"); return; }
      showRoundMapModal(workerId);
      break;
    }
	case "showCF": {
      showCFModal(workerId);
      break;
    }

    case "showPayments": {
      if (!App.settings?.baseUrlPayment) { addNotif("URL paiement non configurée", "error"); return; }
      const roundId = App.allStats[workerId]?.roundId;
      if (!roundId) { addNotif("Tournée non trouvée", "warning"); return; }
      if (e?.ctrlKey || e?.metaKey) { showPaymentsModalWM(workerId); } else { showPaymentsModal(workerId); }
      break;
    }

    case "bl": {
      const blUrl = buildBlUrl(link, worker?.role);
      if (!blUrl) { addNotif("Impossible de créer le lien BL", "error"); return; }
      window.open(blUrl, "_blank");
      addNotif(`BL: ${lbl}`, "success");
      break;
    }

    case "analysebl": {
      const ref = App.allRefs[workerId];
      if (!ref) { addNotif("Référence non disponible", "warning"); return; }
      const baseUrl = getOdooBase();
      if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
      const fieldName = worker?.role === "livraison" ? "delivery_planning_id" : "planning_presale_id";
      const newDomain = `[["${fieldName}","ilike","${ref}"]]`;
      addNotif(`Analyse BL: ${lbl}…`, "info");
      try {
      const r = await fetch("/api/web/dataset/call_kw", {
        method: "POST",
          headers: { "Content-Type": "application/json", "X-App-Permission": "card.analyseBl" },
          body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:Date.now(),
            params: { model:"ir.filters", method:"write", args:[[675],{domain:newDomain}], kwargs:{} } }),
        });
        const data = await r.json();
        if (data.result === true) {
          addNotif(`✓ Filtre mis à jour: ${lbl}`, "success");
          window.open(`${baseUrl}/web#action=454&cids=1&menu_id=302`, "_blank");
        } else { addNotif("Erreur mise à jour filtre", "error"); }
      } catch { addNotif("Erreur réseau", "error"); }
      break;
    }

    case "copyRef": {
      const ref = App.allRefs[workerId];
      if (!ref) { addNotif("Référence non disponible", "warning"); return; }
      try {
        await navigator.clipboard.writeText(ref);
        btn.classList.add("vb-copy--copied"); setTimeout(() => btn.classList.remove("vb-copy--copied"), 1200);
        addNotif(`Copié: ${ref}`, "success");
      } catch(_) { addNotif("Copie échouée", "error"); }
      break;
    }

    case "copyLink": {
      if (!link) { addNotif("Pas de lien", "warning"); return; }
      try {
        await navigator.clipboard.writeText(link);
        btn.classList.add("vb-copy--copied"); setTimeout(() => btn.classList.remove("vb-copy--copied"), 1200);
        addNotif("Lien copié ✓", "success");
      } catch(_) { addNotif("Copie échouée", "error"); }
      break;
    }

    case "open-route": {
      openRouteHubModal(worker);
      break;
    }

    case "clearRound": {
      delete App.allLinks[workerId];
      delete App.allRefs[workerId];
      delete App.allStats[workerId];
      const ckClear = _cacheKey();
      if (_contextCache[ckClear]) {
        delete _contextCache[ckClear].links[workerId];
        delete _contextCache[ckClear].refs[workerId];
        delete _contextCache[ckClear].stats[workerId];
      }
      const dateKey = getDateKey(App.currentDateOffset);
      const _mode   = App.currentMode;
      Storage.getMany(["vendorLinks","vendorStats","vendorRefs"]).then(cur => {
        const links = cur.vendorLinks || {}; if (!links[dateKey]) links[dateKey]={}; if (!links[dateKey][_mode]) links[dateKey][_mode]={};
        const stats = cur.vendorStats || {}; if (!stats[dateKey]) stats[dateKey]={}; if (!stats[dateKey][_mode]) stats[dateKey][_mode]={};
        const refs  = cur.vendorRefs  || {}; if (!refs[dateKey])  refs[dateKey]={};  if (!refs[dateKey][_mode])  refs[dateKey][_mode]={};
        links[dateKey][_mode] = { ...App.allLinks };
        stats[dateKey][_mode] = JSON.parse(JSON.stringify(App.allStats));
        refs[dateKey][_mode]  = { ...App.allRefs };
        Storage.setMany({ vendorLinks: links, vendorStats: stats, vendorRefs: refs });
      });
      renderVendors();
      addNotif(`${lbl} effacé`, "warning");
      break;
    }

    case "disableHorsZone": {
      const baseUrl = getOdooBase();
      if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
      const roundId = _getRoundIdFromLink(workerId) || _getRoundId(workerId);
      if (!roundId) { addNotif("Round ID introuvable", "error"); return; }
      btn.disabled = true;
      addNotif(`Restriction hors zone: ${lbl}…`, "info");
      rpcController.disableHorsZone(baseUrl, roundId)
        .then(() => {
          btn.disabled = false;
          updateStats({ [workerId]: { horsZone: false } });
          addNotif(`✓ Hors zone désactivé: ${lbl}`, "success");
          renderVendors();
        })
        .catch(err => { btn.disabled = false; addNotif(`Erreur: ${err.message}`, "error"); });
      break;
    }

    case "enableHorsZone": {
      const baseUrl = getOdooBase();
      if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
      const roundId = _getRoundIdFromLink(workerId) || _getRoundId(workerId);
      if (!roundId) { addNotif("Round ID introuvable", "error"); return; }
      addNotif(`Activation hors zone: ${lbl}…`, "info");
      rpcController.enableHorsZone(baseUrl, roundId)
        .then(() => {
          updateStats({ [workerId]: { horsZone: true } });
          addNotif(`✓ Hors zone activé: ${lbl}`, "success");
          renderVendors();
        })
        .catch(err => { addNotif(`Erreur: ${err.message}`, "error"); });
      break;
    }

    case "allowHorsZone": {
      const baseUrl = getOdooBase();
      if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
      const roundId = _getRoundIdFromLink(workerId) || _getRoundId(workerId);
      if (!roundId) { addNotif("Round ID introuvable", "error"); return; }
      btn.disabled = true;
      addNotif(`Autorisation hors zone: ${lbl}…`, "info");
      rpcController.allowHorsZone(baseUrl, roundId)
        .then(() => {
          btn.disabled = false;
          updateStats({ [workerId]: { horsZone: true } });
          addNotif(`✓ Hors zone autorisé: ${lbl}`, "success");
          renderVendors();
        })
        .catch(err => { btn.disabled = false; addNotif(`Erreur: ${err.message}`, "error"); });
      break;
    }

case "openPlanning": {
      const baseUrl = getOdooBase();
      if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
      const roundId = _getRoundIdFromLink(workerId) || _getRoundId(workerId);
      if (!roundId) { addNotif("Round ID introuvable", "error"); return; }
      btn.disabled = true;
      addNotif(`Ouverture: ${lbl}…`, "info");
      const _ckOpen = _cacheKey();
      rpcController.openPlanning(baseUrl, roundId)
        .then(() => {
          btn.disabled = false;
          addNotif(`✓ Tournée ouverte: ${lbl}`, "success");
          updateCacheForContext(_ckOpen, { odooState: { [workerId]: "open" } });
          if (_ckOpen === _cacheKey()) App.allOdooState = { ..._contextCache[_ckOpen].odooState };
          renderVendors();
        })
        .catch(err => { btn.disabled = false; addNotif(`Erreur: ${err.message}`, "error"); });
      break;
    }

    case "closePlanning": {
      const baseUrl = getOdooBase();
      if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
      const roundId = _getRoundId(workerId);
      if (!roundId) { addNotif("Round ID introuvable", "error"); return; }
      btn.disabled = true;
      addNotif(`Fermeture: ${lbl}…`, "info");
      const _ckClose = _cacheKey();
      rpcController.closePlanning(baseUrl, roundId)
        .then(() => {
          btn.disabled = false;
          addNotif(`✓ Tournée fermée: ${lbl}`, "success");
          updateCacheForContext(_ckClose, { roundStatus: { [workerId]: "closed" }, odooState: { [workerId]: "closed" } });
          if (_ckClose === _cacheKey()) {
            App.allRoundStatus = { ..._contextCache[_ckClose].roundStatus };
            App.allOdooState   = { ..._contextCache[_ckClose].odooState };
          }
          renderVendors();
        })
        .catch(err => { btn.disabled = false; addNotif(`Erreur: ${err.message}`, "error"); });
      break;
    }
case "closePlanningConfirm": {
      const baseUrl = getOdooBase();
      if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
      const roundId = _getRoundId(workerId);
      if (!roundId) { addNotif("Round ID introuvable", "error"); return; }

      document.getElementById("closePlanConfirmOverlay")?.remove();
      const confirmOverlay = document.createElement("div");
      confirmOverlay.id = "closePlanConfirmOverlay";
      confirmOverlay.style.cssText = `
        position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;
        background:rgba(0,0,0,.5);padding:16px;
      `;
      confirmOverlay.innerHTML = `
        <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
          border-radius:10px;width:100%;max-width:340px;padding:20px;
          box-shadow:0 8px 32px rgba(0,0,0,.2)">
          <div style="font-size:13px;font-weight:700;color:var(--text,#0F172A);margin-bottom:8px">
            Fermer la tournée
          </div>
          <div style="font-size:11px;color:var(--text2,#475569);margin-bottom:16px;line-height:1.6">
            Tournée de <b>${escHtml(lbl)}</b> encore active.<br>
            <span style="color:#16a34a;font-weight:600">Étape 1:</span> Fermeture chez le vendeur<br>
            <span style="color:#F59E0B;font-weight:600">Étape 2:</span> Clôture définitive
          </div>
          <div id="closePlanStatus" style="font-size:10px;color:var(--text3);margin-bottom:10px;min-height:14px"></div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button id="closePlanNo"
              style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
              border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
              color:var(--text2,#475569);cursor:pointer">Annuler</button>
            <button id="closePlanYes"
              style="font-size:11px;font-weight:600;padding:6px 16px;border-radius:6px;
              border:none;background:#16a34a;color:#fff;cursor:pointer">
              Confirmer (2 étapes)</button>
          </div>
        </div>
      `;
      document.body.appendChild(confirmOverlay);
      document.getElementById("closePlanNo")?.addEventListener("click", () => confirmOverlay.remove());
      confirmOverlay.addEventListener("click", e => { if (e.target === confirmOverlay) confirmOverlay.remove(); });

      document.getElementById("closePlanYes")?.addEventListener("click", async () => {
        const statusEl = document.getElementById("closePlanStatus");
        document.getElementById("closePlanYes").disabled = true;
        document.getElementById("closePlanNo").disabled  = true;
        btn.disabled = true;
        const _ckClose = _cacheKey();
        try {
          // Étape 1: fermeture chez le vendeur
          statusEl.textContent = "⏳ Étape 1: Fermeture chez le vendeur…";
          await rpcController.closeVendorDay(baseUrl, roundId);
          statusEl.textContent = "✓ Étape 1 OK — ⏳ Étape 2: Clôture définitive…";
          // Étape 2: clôture définitive
          await rpcController.closePlanning(baseUrl, roundId);
          confirmOverlay.remove();
          btn.disabled = false;
          addNotif(`✓ Tournée fermée (2 étapes): ${lbl}`, "success");
          updateCacheForContext(_ckClose, { roundStatus: { [workerId]: "closed" }, odooState: { [workerId]: "closed" } });
          if (_ckClose === _cacheKey()) {
            App.allRoundStatus = { ..._contextCache[_ckClose].roundStatus };
            App.allOdooState   = { ..._contextCache[_ckClose].odooState };
          }
          renderVendors();
        } catch(err) {
          statusEl.style.color = "#f87171";
          statusEl.textContent = "✗ Erreur: " + err.message;
          document.getElementById("closePlanYes").disabled = false;
          document.getElementById("closePlanNo").disabled  = false;
          btn.disabled = false;
        }
      });
      break;
    }
case "acceptHors": {
  const baseUrl = getOdooBase();
  if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
  const roundId = _getRoundId(workerId);
  if (!roundId) { addNotif("Round ID introuvable", "error"); return; }

  const _acceptHorsAll = () => {
    btn.disabled = true;
    addNotif(`Validation totale: ${lbl}…`, "info");
    const _ck = _cacheKey();
    rpcController.acceptHorsTournee(baseUrl, roundId)
      .then(() => {
        btn.disabled = false;
        _afterAcceptHors(workerId, _ck);
        addNotif(`✓ Tous validés: ${lbl}`, "success");
      })
      .catch(err => { btn.disabled = false; addNotif(`Erreur: ${err.message}`, "error"); });
  };

  const _openHorsModal = () => {
    btn.disabled = true;
    addNotif(`Chargement hors-tournée: ${lbl}…`, "info");
    rpcController.openHorsWizard(baseUrl, roundId)
      .then(({ wizardId, wizModel }) =>
        rpcController.fetchHorsClients(baseUrl, wizModel, wizardId)
          .then(({ lines, lineModel }) => {
            btn.disabled = false;
            // نعرض المودال دائماً (حتى لو كانت القائمة فارغة) بدل القبول
            // التلقائي الصامت — لأن السيرفر قد يكون رجّع wizard فارغ بعد
            // معالجة تلقائية (validate_events)، والمستخدم يريد رؤية/تأكيد
            // الزبائن يدوياً دائماً.
            showHorsModal(workerId, lbl, baseUrl, wizModel, wizardId, lineModel, lines);
          })
      )
      .catch(err => { btn.disabled = false; addNotif(`Erreur: ${err.message}`, "error"); });
  };

  // ── تمييز يدوي بين ضغطة واحدة وضغطة مزدوجة ──────────────
  // (event.detail غير موثوق لأن الزر يُعطَّل فور الضغطة الأولى)
  // ضغطة واحدة = تفعيل مباشر (validation totale) — ضغطتان = فتح المودال
  if (btn._horsClickTimer) {
    clearTimeout(btn._horsClickTimer);
    btn._horsClickTimer = null;
    _openHorsModal();
  } else {
    btn._horsClickTimer = setTimeout(() => {
      btn._horsClickTimer = null;
      _acceptHorsAll();
    }, 300);
  }
  break;
}

    case "fetchLink": {
      App.activeOps[workerId] = "fetching";
      renderVendors();
      addNotif(`Récupération: ${lbl}…`, "info");
      const baseUrl = getOdooBase();
      if (!baseUrl) { delete App.activeOps[workerId]; renderVendors(); addNotif("URL non configurée", "error"); return; }
      rpcController.fetch([worker], baseUrl, App.currentMode, App.currentDateOffset)
        .then(() => {
          // إلغاء أي جلب Reports/Ventes/Retours معلّق لبقية الكروت — الفetch الحالي فردي فقط
          clearTimeout(_extrasSyncTimer);
          _extrasSyncPending.clear();
          // جلب صامت (بدون loading/تجميد) لهذا العامل فقط، بعد ظهور الكرت طبيعيًا
          if (worker.role === "livraison") _fetchExtrasSilently([worker]);
        })
        .catch(() => { delete App.activeOps[workerId]; renderVendors(); });
      break;
    }

    case "stockFinal": {
      const baseUrl = getOdooBase();
      if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
      const roundId = _getRoundIdFromLink(workerId) || _getRoundId(workerId);
      if (!roundId) { addNotif("Round ID introuvable", "error"); return; }
      btn.disabled = true;
      addNotif(`Stock final: ${lbl}…`, "info");
      rpcController.fetchStockFinal(baseUrl, roundId)
        .then(lines => {
          btn.disabled = false;
          if (!lines.length) { addNotif(`Stock final ${lbl}: vide`, "info"); return; }
          openStockFinalModal(lbl, lines);
        })
        .catch(err => { btn.disabled = false; addNotif(`Erreur: ${err.message}`, "error"); });
      break;
    }

    case "addProduct": {
      const baseUrl = getOdooBase();
      if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
      const roundId = _getRoundIdFromLink(workerId) || _getRoundId(workerId);
      if (!roundId) { addNotif("Round ID introuvable", "error"); return; }
      openAddProductModal(workerId, lbl, roundId, baseUrl);
      break;
    }
	case "addClient": {
      const baseUrl = getOdooBase();
      if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
      const roundId = _getRoundIdFromLink(workerId) || _getRoundId(workerId);
      if (!roundId) { addNotif("Round ID introuvable", "error"); return; }
      openAddClientModal(workerId, lbl, roundId, baseUrl);
      break;
	  }

    case "deleteClient": {
      const baseUrl = getOdooBase();
      if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
      const roundId = _getRoundIdFromLink(workerId) || _getRoundId(workerId);
      if (!roundId) { addNotif("Round ID introuvable", "error"); return; }
      openDeleteClientModal(workerId, lbl, roundId, baseUrl);
      break;
    }

    case "journalStock": {
      const baseUrl = getOdooBase();
      if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
      const roundId = App.allStats[workerId]?.roundId;
      if (!roundId) { addNotif("Round ID introuvable", "error"); return; }
      if (e?.ctrlKey || e?.metaKey) {
        showJournalStockModalWM(workerId, lbl, roundId, baseUrl);
      } else {
        showJournalStockModal(workerId, lbl, roundId, baseUrl);
      }
      break;
    }
  }
}
// ── Vendor Bulk Selection ─────────────────────────────────────
function _toggleVendorCard(card, vid) {
  const isSelected = card.classList.contains("vc--selected");
  if (isSelected) {
    card.classList.remove("vc--selected");
    const badge = card.querySelector(".vc-sel-badge");
    if (badge) badge.style.display = "none";
  } else {
    card.classList.add("vc--selected");
    const badge = card.querySelector(".vc-sel-badge");
    if (badge) badge.style.display = "flex";
  }
  // تحديث الـ checkbox المخفي
  const cb = card.querySelector(".vendor-card-check");
  if (cb) { cb.checked = !isSelected; cb.dispatchEvent(new Event("change", { bubbles: true })); }
  _refreshVendorBulkBar();
}

function _refreshVendorBulkBar() {
  const selected = [...document.querySelectorAll(".vc--selected")];
  const bar      = document.getElementById("vendorBulkBar");
  const count    = document.getElementById("vendorBulkCount");
  if (count) count.textContent = `${selected.length} sélectionné(s)`;
  if (bar)   bar.style.display = selected.length > 0 ? "block" : "none";

  const ids = selected.map(c => c.dataset.vendorId).filter(Boolean).map(id => isNaN(id) ? id : +id);
  const dcs = ids.map(id => getRoundState(!!App.allLinks[id], (App.allOdooState||{})[id], (App.allUserStatus||{})[id]));

  const hasOpen   = dcs.some(d => d === "open_day" || d === "not_started");
  const hasClosed = dcs.some(d => d === "closed");
  const anyLink   = ids.some(id => !!App.allLinks[id]);

  const btnOpen     = document.getElementById("vbBtnOpen");
  const btnClose    = document.getElementById("vbBtnClose");
  const btnOpenPlan = document.getElementById("vbBtnOpenPlan");

  if (btnOpen)     btnOpen.style.display     = anyLink                    ? "" : "none";
  if (btnClose)    btnClose.style.display    = (hasOpen && !hasClosed)    ? "" : "none";
  if (btnOpenPlan) btnOpenPlan.style.display = (hasClosed && !hasOpen)    ? "" : "none";
}
function _initVendorBulkBar() {
  const bar = document.getElementById("vendorBulkBar");
  if (!bar || bar.dataset.init) return;
  bar.dataset.init = "1";

  const _getChecked = () => [...document.querySelectorAll(".vc--selected")];

  const _updateBar = () => {
    const checked = _getChecked();
    const count   = document.getElementById("vendorBulkCount");
    if (count) count.textContent = `${checked.length} sélectionné(s)`;
    bar.style.display = checked.length > 0 ? "block" : "none";

    const ids = checked.map(c => c.dataset.vendorId).map(id => isNaN(id) ? id : +id);
    const workers = ids.map(id => allWorkers().find(w => String(w.id) === String(id))).filter(Boolean);

    // حساب حالات الجولات
    const dcs = ids.map(id => {
      const has   = !!App.allLinks[id];
      const odooState = (App.allOdooState||{})[id];
      const userStatus = (App.allUserStatus||{})[id];
      return getRoundState(has, odooState, userStatus);
    });

    const hasOpen   = dcs.some(d => d === "open_day" || d === "not_started");
    const hasClosed = dcs.some(d => d === "closed");
    const hasActive = dcs.some(d => d === "open_day");
    const hasNotStarted = dcs.some(d => d === "not_started");

    // زر الفتح: فقط إذا لم تكن كلها مغلقة
    const btnOpen     = document.getElementById("vbBtnOpen");
    const btnClose    = document.getElementById("vbBtnClose");
    const btnOpenPlan = document.getElementById("vbBtnOpenPlan");

    // إخفاء/إظهار زري الفتح والغلق
    const showClose    = hasOpen && !hasClosed;
    const showOpenPlan = hasClosed && !hasOpen;

    if (btnClose)    { btnClose.style.display    = showClose    ? "" : "none"; }
    if (btnOpenPlan) { btnOpenPlan.style.display  = showOpenPlan ? "" : "none"; }

    // زر الروابط: إخفاء إذا لا يوجد أي رابط
    const anyLink = ids.some(id => !!App.allLinks[id]);
    if (btnOpen) btnOpen.style.display = anyLink ? "" : "none";
  };

  // مراقبة التغييرات على checkboxes
  document.addEventListener("change", e => {
    if (e.target.classList.contains("vendor-card-check")) _updateBar();
  });

  // تحديد الكل
  document.getElementById("vbBtnSelectAll")?.addEventListener("click", () => {
    const all        = [...document.querySelectorAll(".vc")].filter(c => c.offsetParent !== null);
    const allSelected = all.every(c => c.classList.contains("vc--selected"));
    all.forEach(card => {
      const vid = card.dataset.vendorId;
      if (!vid) return;
      if (allSelected) {
        card.classList.remove("vc--selected");
        const badge = card.querySelector(".vc-sel-badge");
        if (badge) badge.style.display = "none";
      } else {
        card.classList.add("vc--selected");
        const badge = card.querySelector(".vc-sel-badge");
        if (badge) badge.style.display = "flex";
      }
    });
    _updateBar();
  });

  // ── فتح الروابط ───────────────────────────────────────────────
  document.getElementById("vbBtnOpen")?.addEventListener("click", () => {
    const ids = _getChecked().map(c => c.dataset.vendorId).map(id => isNaN(id) ? id : +id);
    ids.forEach(id => {
      const link = App.allLinks[id];
      if (link) window.open(link, "_blank");
    });
  });

  // ── غلق الجولات ───────────────────────────────────────────────
  document.getElementById("vbBtnClose")?.addEventListener("click", () => {
    const checked = _getChecked();
    const ids     = checked.map(c => c.dataset.vendor);
    const baseUrl = getOdooBase();
    if (!baseUrl) { addNotif("URL non configurée", "error"); return; }

    const dcs = ids.map(id => getRoundState(!!App.allLinks[id], (App.allOdooState||{})[id], (App.allUserStatus||{})[id]));
    const hasActiveOrNotStarted = dcs.some(d => d === "open_day" || d === "not_started");

    const _doCloseAll = async () => {
      for (const id of ids) {
        const roundId = _getRoundId(id);
        if (!roundId) continue;
        const w = allWorkers().find(w => String(w.id) === String(id));
        const lbl = w?.label || w?.name || id;
        try {
          const _ck = _cacheKey();
          await rpcController.closePlanning(baseUrl, roundId);
          addNotif(`✓ Tournée fermée: ${lbl}`, "success");
          updateCacheForContext(_ck, { roundStatus: { [id]: "closed" } });
          if (_ck === _cacheKey()) App.allRoundStatus = { ..._contextCache[_ck].roundStatus };
        } catch(err) {
          addNotif(`Erreur ${lbl}: ${err.message}`, "error");
        }
      }
      renderVendors();
    };

    if (hasActiveOrNotStarted) {
      // رسالة تأكيد
      document.getElementById("vbBulkConfirmOverlay")?.remove();
      const ov = document.createElement("div");
      ov.id = "vbBulkConfirmOverlay";
      ov.style.cssText = `position:fixed;inset:0;z-index:10002;display:flex;align-items:center;
        justify-content:center;background:rgba(0,0,0,.5);padding:16px;`;
      ov.innerHTML = `
        <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
          border-radius:10px;width:100%;max-width:340px;padding:20px;
          box-shadow:0 8px 32px rgba(0,0,0,.2)">
          <div style="font-size:13px;font-weight:700;color:var(--text,#0F172A);margin-bottom:8px">
            Fermer les tournées
          </div>
          <div style="font-size:11px;color:var(--text2,#475569);margin-bottom:16px;line-height:1.6">
            Certaines tournées sont encore <b>actives ou non démarrées</b>.<br>
            <span style="color:#F59E0B">⚠️ Confirmer la fermeture de ${ids.length} tournée(s) ?</span>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button id="vbConfirmNo"
              style="font-size:11px;font-weight:600;padding:6px 14px;border-radius:6px;
              border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);
              color:var(--text2,#475569);cursor:pointer">Annuler</button>
            <button id="vbConfirmYes"
              style="font-size:11px;font-weight:600;padding:6px 16px;border-radius:6px;
              border:none;background:#F59E0B;color:#fff;cursor:pointer">Confirmer</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      document.getElementById("vbConfirmNo")?.addEventListener("click", () => ov.remove());
      document.getElementById("vbConfirmYes")?.addEventListener("click", () => { ov.remove(); _doCloseAll(); });
    } else {
      _doCloseAll();
    }
  });

  // ── فتح الجولات ───────────────────────────────────────────────
  document.getElementById("vbBtnOpenPlan")?.addEventListener("click", async () => {
    const ids     = _getChecked().map(c => c.dataset.vendor);
    const baseUrl = getOdooBase();
    if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
    for (const id of ids) {
      const roundId = _getRoundId(id);
      if (!roundId) continue;
      const w   = allWorkers().find(w => String(w.id) === String(id));
      const lbl = w?.label || w?.name || id;
      try {
        const _ck = _cacheKey();
        await rpcController.openPlanning(baseUrl, roundId);
        addNotif(`✓ Tournée ouverte: ${lbl}`, "success");
        updateCacheForContext(_ck, { roundStatus: { [id]: "open" } });
        if (_ck === _cacheKey()) App.allRoundStatus = { ..._contextCache[_ck].roundStatus };
      } catch(err) {
        addNotif(`Erreur ${lbl}: ${err.message}`, "error");
      }
    }
    renderVendors();
  });

// ── Liste BLs جماعي ───────────────────────────────────────────
  document.getElementById("vbBtnBLs")?.addEventListener("click", () => {
    const baseUrl = App.settings?.baseUrlPayment?.replace(/\/$/, "") || "";
    if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
    // ملاحظة: نعرض دائماً BLs كل الموزعين (تورنيات نشطة) بغض النظر عن تحديد الموزع في القائمة،
    // حتى تتمكن من اختيار BLs من أي موزع ومعالجتها (Désaffecter...) مجتمعة أو بدون تحديد موزع أصلاً.
    const vendors = allWorkers().map(w => ({
      id: w.id, label: w?.label || w?.name || String(w.id), roundId: App.allStats[w.id]?.roundId
    })).filter(v => v.roundId);
    if (!vendors.length) { addNotif("Aucune tournée disponible", "warning"); return; }
    showBulkBLsModal(vendors, baseUrl);
  });

  // ── Paiements جماعي ───────────────────────────────────────────
  document.getElementById("vbBtnPay")?.addEventListener("click", () => {
    const checked = _getChecked();
    const baseUrl = App.settings?.baseUrlPayment?.replace(/\/$/, "") || "";
    if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
    const vendors = checked.map(c => {
      const id = isNaN(c.dataset.vendorId) ? c.dataset.vendorId : +c.dataset.vendorId;
      const w  = allWorkers().find(w => String(w.id) === String(id));
      return { id, label: w?.label || w?.name || String(id), roundId: App.allStats[id]?.roundId };
    }).filter(v => v.roundId);
    if (!vendors.length) { addNotif("Aucune tournée disponible", "warning"); return; }
    showBulkPaymentsModal(vendors, baseUrl);
  });

  // ── Stock Final جماعي ─────────────────────────────────────────
document.getElementById("vbBtnStock")?.addEventListener("click", async () => {
    const checked = _getChecked();
    const baseUrl = getOdooBase();
    if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
    const vendors = checked.map(c => {
      const id = isNaN(c.dataset.vendorId) ? c.dataset.vendorId : +c.dataset.vendorId;
      const w  = allWorkers().find(w => String(w.id) === String(id));
      return { id, label: w?.label || w?.name || String(id), roundId: App.allStats[id]?.roundId || _getRoundId(id) };
    }).filter(v => v.roundId);
    if (!vendors.length) { addNotif("Aucun round ID disponible", "warning"); return; }
    addNotif(`Stock final: ${vendors.length} tournée(s)…`, "info");
    const allLines = [];
    for (const v of vendors) {
      try {
        const lines = await rpcController.fetchStockFinal(baseUrl, v.roundId);
        lines.forEach(l => allLines.push({ ...l, _vendorLabel: v.label }));
      } catch(err) {
        addNotif(`Erreur ${v.label}: ${err.message}`, "error");
      }
    }
    if (!allLines.length) { addNotif("Stock final: vide", "info"); return; }
    exportStockFinalXlsxMulti(vendors.map(v => v.label).join(" + "), allLines);
    addNotif(`✓ Stock final groupé téléchargé`, "success");
  });

  // ── Analyse BLs جماعي ─────────────────────────────────────────
// ── Analyse BLs جماعي ─────────────────────────────────────────
  document.getElementById("vbBtnAnalyse")?.addEventListener("click", async () => {
    const checked = _getChecked();
    const baseUrl = getOdooBase();
    if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
    const ids = checked.map(c => isNaN(c.dataset.vendorId) ? c.dataset.vendorId : +c.dataset.vendorId);
    const workers = ids.map(id => allWorkers().find(w => String(w.id) === String(id))).filter(Boolean);
    const refs = workers.map(w => ({ ref: App.allRefs[w.id], role: w.role })).filter(r => r.ref);
    if (!refs.length) { addNotif("Aucune référence disponible", "warning"); return; }

    const fieldName = refs[0].role === "livraison" ? "delivery_planning_id" : "planning_presale_id";
    let domain;
    if (refs.length === 1) {
      domain = `[["${fieldName}","ilike","${refs[0].ref}"]]`;
    } else {
      const pipes = refs.slice(0, -1).map(() => `"|"`).join(",");
      const conditions = refs.map(r => `["${fieldName}","ilike","${r.ref}"]`).join(",");
      domain = `[${pipes},${conditions}]`;
    }

    try {
      const r = await fetch("/api/web/dataset/call_kw", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-App-Permission": "card.analyseBl" },
        body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:Date.now(),
          params: { model:"ir.filters", method:"write", args:[[675],{domain}], kwargs:{} } }),
      });
      const data = await r.json();
      if (data.result === true) {
        addNotif(`✓ Filtre mis à jour (${refs.length} tournées)`, "success");
        window.open(`${baseUrl}/web#action=454&cids=1&menu_id=302`, "_blank");
      } else { addNotif("Erreur mise à jour filtre", "error"); }
    } catch { addNotif("Erreur réseau", "error"); }
  });

  // ── Carte groupée (plusieurs tournées sur une seule carte — mêmes infos que la carte individuelle: BLs/visites/ventes) ──
  document.getElementById("vbBtnMap")?.addEventListener("click", () => {
    const checked = _getChecked();
    const ids = checked.map(c => isNaN(c.dataset.vendorId) ? c.dataset.vendorId : +c.dataset.vendorId);
    const withRound = ids.filter(id => App.allStats[id]?.roundId);
    if (!withRound.length) { addNotif("Aucune tournée disponible pour la sélection", "warning"); return; }
    showRoundMapModal(withRound);
  });
}

// ── Stock Final multi-vendor XLSX ─────────────────────────────
function exportStockFinalXlsxMulti(globalLabel, allLines) {
  const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  function cell(col,row,value,isNum){if(isNum)return `<c r="${col}${row}" t="n"><v>${value}</v></c>`;return `<c r="${col}${row}" t="inlineStr"><is><t>${esc(value)}</t></is></c>`;}

  // تجميع حسب البائع
  const byVendor = {};
  allLines.forEach(l => {
    const key = l._vendorLabel || "—";
    if (!byVendor[key]) byVendor[key] = [];
    byVendor[key].push(l);
  });

  let rows = "";
  let rowIdx = 1;
  rows += `<row r="${rowIdx}"><c r="A${rowIdx}" t="inlineStr"><is><t>${esc("STOCK FINAL: " + globalLabel)}</t></is></c></row>`;
  rowIdx++;
  rows += `<row r="${rowIdx}"></row>`; rowIdx++;

  Object.entries(byVendor).forEach(([label, lines]) => {
    rows += `<row r="${rowIdx}"><c r="A${rowIdx}" t="inlineStr"><is><t>${esc("── " + label + " ──")}</t></is></c></row>`; rowIdx++;
    rows += `<row r="${rowIdx}">${cell("A",rowIdx,"Article",false)}${cell("B",rowIdx,"CDN",false)}${cell("C",rowIdx,"Quantité",false)}</row>`; rowIdx++;
    lines.filter(l => l.qty > 0).forEach(l => {
      const cdn = l.packaging_qty > 0 ? +(l.qty/l.packaging_qty).toFixed(2) : "";
      rows += `<row r="${rowIdx}">${cell("A",rowIdx,l.name,false)}${cdn!==""?cell("B",rowIdx,cdn,true):`<c r="B${rowIdx}"/>`}${cell("C",rowIdx,l.qty,true)}</row>`;
      rowIdx++;
    });
    rows += `<row r="${rowIdx}"></row>`; rowIdx++;
  });

  const xml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Stock Final" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const sheet   = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + colDims + '<sheetData>' + rows + '</sheetData>' + merges + '</worksheet>';
  const rels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const contentTypes=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  if(typeof JSZip!=="undefined"){
    const zip=new JSZip();
    zip.file("[Content_Types].xml",contentTypes);
    zip.file("_rels/.rels",`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    zip.file("xl/workbook.xml",xml);zip.file("xl/_rels/workbook.xml.rels",rels);zip.file("xl/worksheets/sheet1.xml",sheet);
    zip.generateAsync({type:"blob",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}).then(blob=>_downloadBlob(blob,`stock_final_groupe.xlsx`));
  } else {
    let csv = `"STOCK FINAL: ${globalLabel}"\n\n`;
    Object.entries(byVendor).forEach(([label, lines]) => {
      csv += `"── ${label} ──"\nArticle,CDN,Quantité\n`;
      lines.filter(l=>l.qty>0).forEach(l=>{const cdn=l.packaging_qty>0?+(l.qty/l.packaging_qty).toFixed(2):"";csv+=`"${l.name}",${cdn},${l.qty}\n`;});
      csv += "\n";
    });
    _downloadBlob(new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8;"}),"stock_final_groupe.csv");
  }
}
// ── Auto-fetch Engine ─────────────────────────────────────────
const AutoFetch = {
  _timerId:    null,
  _counterId:  null,
  _lastFetch:  null,   // timestamp ms
  _paused:     false,
  _fetching:   false,

  /** Initialise selon les settings */
  init() {
    this.stop();
    const s = App.settings;
    if (!s?.autoFetchEnabled) { this._hideIndicator(); return; }
    this._paused  = false;
    this._fetching = false;
    this._scheduleNext();
    this._startCounterUI();
    this._showIndicator();
  },

  /** Appelé après chaque fetch (manuel ou auto) pour réinitialiser le compteur */
  notifyFetchDone() {
    if (!App.settings?.autoFetchEnabled) return;
    this._lastFetch = Date.now();
    this._fetching  = false;
    if (!this._paused) {
      clearTimeout(this._timerId);
      this._scheduleNext();
      this._updateIndicatorState("active");
    }
  },

  pause() {
    if (this._paused) return;
    this._paused = true;
    clearTimeout(this._timerId);
    this._updateIndicatorState("paused");
    addNotif("Fetch auto pausé", "info");
  },

  resume() {
    if (!this._paused) return;
    this._paused   = false;
    this._lastFetch = Date.now(); // repart de maintenant
    this._scheduleNext();
    this._updateIndicatorState("active");
    addNotif("Fetch auto repris", "info");
  },

  togglePause() {
    if (this._paused) this.resume(); else this.pause();
  },

  stop() {
    clearTimeout(this._timerId);
    clearInterval(this._counterId);
    this._timerId   = null;
    this._counterId = null;
    this._fetching  = false;
    this._hideIndicator();
  },

  _scheduleNext() {
    const intervalMs = Math.max(1, (App.settings?.autoFetchInterval ?? 5)) * 60 * 1000;
    const elapsed    = this._lastFetch ? (Date.now() - this._lastFetch) : 0;
    const delay      = Math.max(0, intervalMs - elapsed);
    this._timerId = setTimeout(() => this._doAutoFetch(), delay);
  },

  async _doAutoFetch() {
    if (this._paused || App.isFetching) {
      // réessaie dans 15 secondes si déjà en cours
      this._timerId = setTimeout(() => this._doAutoFetch(), 15000);
      return;
    }
    // Pause si onglet en arrière-plan
    if (App.settings?.autoFetchPauseBackground && document.hidden) {
      this._timerId = setTimeout(() => this._doAutoFetch(), 15000);
      return;
    }
    this._fetching = true;
    this._updateIndicatorState("fetching");
    addNotif("Fetch auto en cours…", "info");
    this._lastFetch = Date.now();
    await fetchAllModes(true);
    // notifyFetchDone() sera appelé par le wrapper fetchAllModesWrapped
  },

  _startCounterUI() {
    clearInterval(this._counterId);
    this._counterId = setInterval(() => this._refreshCountdown(), 1000);
    this._refreshCountdown();
  },

  _refreshCountdown() {
    const el = document.getElementById("afCountdown");
    if (!el) return;
    if (this._paused)  { el.textContent = "Pausé"; return; }
    if (this._fetching){ el.textContent = "…"; return; }
    const intervalMs = Math.max(1, (App.settings?.autoFetchInterval ?? 5)) * 60 * 1000;
    const elapsed    = this._lastFetch ? (Date.now() - this._lastFetch) : 0;
    const remaining  = Math.max(0, intervalMs - elapsed);
    const m  = Math.floor(remaining / 60000);
    const s  = Math.floor((remaining % 60000) / 1000);
    el.textContent = `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  },

  _showIndicator() {
    const el = document.getElementById("afIndicator");
    if (el) { el.style.display = "flex"; this._updateIndicatorState("active"); }
    this._startCounterUI();
  },

  _hideIndicator() {
    const el = document.getElementById("afIndicator");
    if (el) el.style.display = "none";
    clearInterval(this._counterId);
    this._counterId = null;
  },

  _updateIndicatorState(state) {
    // state: "active" | "paused" | "fetching"
    const el   = document.getElementById("afIndicator");
    const icon = document.getElementById("afPauseIcon");
    if (!el) return;
    el.classList.remove("af-indicator--active","af-indicator--paused","af-indicator--fetching");
    if (state === "active")   el.classList.add("af-indicator--active");
    if (state === "paused")   el.classList.add("af-indicator--paused");
    if (state === "fetching") el.classList.add("af-indicator--fetching");
    // icône pause/play
    if (icon) {
      if (this._paused) {
        // play icon
        icon.innerHTML = `<polygon points="5,3 19,12 5,21"/>`;
      } else {
        // pause icon
        icon.innerHTML = `<rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/>`;
      }
    }
  },
};

// ── جلب موحّد ودُفعة واحدة (bulk) لعمّال livraison: Alertes R/A + Reports + Ventes + Retours ──
async function _fetchRoundExtrasBulkFor(livWorkers, baseUrl) {
  if (!livWorkers.length) return;
  const wantAlerts = !!App.settings?.showRoundAlerts;
  const roundIdToWorker = {};
  const livCacheKey = "livraison_" + getDateKey(App.currentDateOffset);
  const livStats = _contextCache[livCacheKey]?.stats || App.allStats;
  livWorkers.forEach(w => {
    const roundId = livStats[w.id]?.roundId;
    if (roundId) roundIdToWorker[roundId] = w.id;
  });
  const roundIds = Object.keys(roundIdToWorker).map(Number);
  const bulk = roundIds.length ? await rpcController.fetchRoundExtrasBulk(baseUrl, roundIds).catch(() => ({})) : {};

  Object.entries(roundIdToWorker).forEach(([roundIdStr, wid]) => {
    const roundId = Number(roundIdStr); // Object.entries() يُرجع مفاتيح نصية دائمًا؛
    // يجب تحويلها لرقم لأن renderer.js يقارن بـ === مع App.allStats[wid].roundId (رقم)
    const extras = bulk[roundIdStr] || bulk[roundId];
    if (!extras) return;

    if (wantAlerts) {
      if (!App._roundAlerts) App._roundAlerts = {};
      App._roundAlerts[wid] = {
        hasDelayed:  extras.alerts?.hasDelayed  || false,
        hasCanceled: extras.alerts?.hasCanceled || false,
        roundId,
      };
    }
    if (!App._delayedOrders) App._delayedOrders = {};
    App._delayedOrders[wid] = { roundId, picks: extras.delayed || [] };

    if (!App._soldOrders) App._soldOrders = {};
    App._soldOrders[wid] = { roundId, sales: extras.sold || [] };

    if (!App._returnOrders) App._returnOrders = {};
    App._returnOrders[wid] = { roundId, returns: extras.returns || [] };
  });
  renderVendors();
}

// ── Fetch / Mode ──────────────────────────────────────────────
async function fetchCurrentMode() {
  if (App.isFetching) return;
  const baseUrl = getOdooBase();
  if (!baseUrl) { addNotif("URL Odoo non configurée", "error"); return; }
  const workers = modeWorkers();
  const modeLbl = App.currentMode === "mr" ? "M&R" : (MODE_CFG[App.currentMode]?.label || App.currentMode);
  if (!workers.length) { addNotif(`Aucune entrée ${modeLbl}`, "warning"); return; }
  workers.forEach(w => { App.activeOps[w.id] = "fetching"; });
  App.isFetching = true; setFetchingUI(true); renderVendors();
  rpcController.fetch(workers, baseUrl, App.currentMode, App.currentDateOffset)
    .then(() => {
      clearTimeout(_extrasSyncTimer);
      _extrasSyncPending.clear();
      if (App.currentMode === "livraison") _fetchRoundExtrasBulkFor(workers, baseUrl);
    })
    .catch(() => {
      App.isFetching = false; setFetchingUI(false);
      Object.keys(App.activeOps).forEach(id => delete App.activeOps[id]);
      renderVendors();
    })
    .finally(() => { AutoFetch.notifyFetchDone(); });
}

async function fetchAllModes(isAuto = false) {
  const baseUrl   = getOdooBase();
  if (!baseUrl) { addNotif("URL Odoo non configurée", "error"); return; }
  const prevWorkers = allWorkers().filter(w => w.role === "prevente");
  const livWorkers  = allWorkers().filter(w => w.role === "livraison");
  const mrWorkers   = allWorkers().filter(w => w.role === "merch" || w.role === "recouvrement");
  if (!prevWorkers.length && !livWorkers.length && !mrWorkers.length) { addNotif("Aucune entrée configurée", "warning"); AutoFetch.notifyFetchDone(); return; }
  App.isFetching = true; setFetchingUI(true);
  // Freeze manual btn during auto-fetch
  if (isAuto) {
    const btn = document.getElementById("btnFetch");
    if (btn) { btn.disabled = true; btn.title = "Fetch auto en cours…"; }
  }
  prevWorkers.forEach(w => { App.activeOps[w.id] = "fetching"; });
  livWorkers.forEach(w  => { App.activeOps[w.id] = "fetching"; });
  mrWorkers.forEach(w   => { App.activeOps[w.id] = "fetching"; });
  renderVendors();
  addNotif("Récupération PRÉVENTE + LIVRAISON + M&R…", "info");

  await Promise.all([
    prevWorkers.length ? rpcController.fetch(prevWorkers, baseUrl, "prevente",  App.currentDateOffset, true) : Promise.resolve(),
    livWorkers.length  ? rpcController.fetch(livWorkers,  baseUrl, "livraison", App.currentDateOffset, true) : Promise.resolve(),
    mrWorkers.length   ? rpcController.fetch(mrWorkers,   baseUrl, "mr",        App.currentDateOffset, true) : Promise.resolve(),
  ]).catch(() => {});

  // جلب موحّد ودُفعة واحدة (bulk) لكل العمال معًا: Alertes R/A + Reports + Ventes + Retours
  // بدل نداء RPC منفصل لكل عامل (كان يصطدم بحد اتصالات المتصفح المتزامنة مع 60+ عامل)
  clearTimeout(_extrasSyncTimer);
  _extrasSyncPending.clear();
  if (livWorkers.length) await _fetchRoundExtrasBulkFor(livWorkers, baseUrl);

  // Restore manual btn title
  if (isAuto) {
    const btn = document.getElementById("btnFetch");
    if (btn) btn.title = "";
  }

  // Notify AutoFetch engine — resets counter
  AutoFetch.notifyFetchDone();
}

function showCFModal(vendorId, selectedCategId = null) {
  const cf = App.allStats?.[vendorId]?.cf;
  if (!cf) return;

  const worker = allWorkers().find(w => w.id === vendorId);
  const name   = worker?.label || worker?.name || vendorId;

  let bodyHtml = "";
  let headerLeft = "";

  if (selectedCategId === null) {
    // --- عرض الكاتيقوريات ---
    headerLeft = `
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:36px;height:36px;border-radius:8px;background:#e8f0fe;display:flex;align-items:center;justify-content:center">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b5bdb" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        </div>
        <div>
          <div style="font-weight:700;font-size:15px;color:var(--text1,#111)">${name}</div>
          <div style="font-size:11px;color:var(--text3,#888);margin-top:1px">Emballage par catégorie</div>
        </div>
      </div>`;

    const categList = Object.entries(cf.byCateg || {}).sort((a, b) => (b[1].c + b[1].f) - (a[1].c + a[1].f));
    const rows = categList.map(([cid, cv]) => `
      <div onclick="showCFModal('${vendorId}','${cid}')" style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border,#eee);cursor:pointer;transition:background .15s" onmouseover="this.style.background='var(--bg3,#f8fafc)'" onmouseout="this.style.background=''">
        <div style="font-size:13px;font-weight:500;color:var(--text1,#111);flex:1">${cv.name}</div>
        <div style="display:flex;align-items:center;gap:16px">
          ${cv.c > 0 ? `<div style="display:flex;align-items:center;gap:4px"><span style="font-size:10px;font-weight:700;color:#3b5bdb;background:#e8f0fe;padding:1px 5px;border-radius:4px">C</span><span style="font-size:13px;font-weight:700;color:#3b5bdb">${+cv.c.toFixed(1)}</span></div>` : ""}
          ${cv.f > 0 ? `<div style="display:flex;align-items:center;gap:4px"><span style="font-size:10px;font-weight:700;color:#b45309;background:#fef3c7;padding:1px 5px;border-radius:4px">F</span><span class="${!Number.isInteger(cv.f) ? 'cf-blink' : ''}" style="font-size:13px;font-weight:700;color:#b45309">${+cv.f.toFixed(1)}</span></div>` : ""}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text3,#aaa)" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      </div>`).join("");

    const totalC = +cf.c.toFixed(1), totalF = +cf.f.toFixed(1);
    bodyHtml = `
      <div style="flex:1;overflow-y:auto">${rows}</div>
      <div style="padding:12px 16px;border-top:1px solid var(--border,#eee);display:flex;justify-content:space-between;align-items:center;background:var(--bg3,#f8fafc);border-radius:0 0 14px 14px">
        <span style="font-size:12px;font-weight:600;color:var(--text2,#555)">Total</span>
        <div style="display:flex;gap:16px">
          <div style="display:flex;align-items:center;gap:4px"><span style="font-size:10px;font-weight:700;color:#3b5bdb;background:#e8f0fe;padding:1px 5px;border-radius:4px">C</span><span style="font-size:13px;font-weight:700;color:#3b5bdb">${totalC}</span></div>
          <div style="display:flex;align-items:center;gap:4px"><span style="font-size:10px;font-weight:700;color:#b45309;background:#fef3c7;padding:1px 5px;border-radius:4px">F</span><span class="${!Number.isInteger(totalF) ? 'cf-blink' : ''}" style="font-size:13px;font-weight:700;color:#b45309">${totalF}</span></div>
        </div>
      </div>`;
  } else {
    // --- عرض منتجات كاتيقوري معينة ---
    const cv = cf.byCateg[selectedCategId];
    if (!cv) return;

    headerLeft = `
      <div style="display:flex;align-items:center;gap:10px">
        <button onclick="showCFModal('${vendorId}')" style="width:32px;height:32px;border-radius:8px;background:var(--bg3,#f0f0f0);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text2,#555)" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div>
          <div style="font-weight:700;font-size:15px;color:var(--text1,#111)">${cv.name}</div>
          <div style="font-size:11px;color:var(--text3,#888);margin-top:1px">${name}</div>
        </div>
      </div>`;

    const prodMap = {};
    for (const p of (cv.products || [])) {
      if (!prodMap[p.name]) prodMap[p.name] = { name: p.name, c: 0, f: 0 };
      prodMap[p.name][p.type] += p.qty;
    }
    const prods = Object.values(prodMap).sort((a, b) => (b.c + b.f) - (a.c + a.f));
    const rows = prods.map(p => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border,#eee)">
        <div style="font-size:12px;color:var(--text1,#111);flex:1;padding-right:8px;line-height:1.3">${escHtml(productLabel(p.name))}</div>
        <div style="display:flex;align-items:center;gap:16px;flex-shrink:0">
          ${p.c > 0 ? `<div style="display:flex;align-items:center;gap:4px"><span style="font-size:10px;font-weight:700;color:#3b5bdb;background:#e8f0fe;padding:1px 5px;border-radius:4px">C</span><span style="font-size:13px;font-weight:700;color:#3b5bdb">${+p.c.toFixed(1)}</span></div>` : ""}
          ${p.f > 0 ? `<div style="display:flex;align-items:center;gap:4px"><span style="font-size:10px;font-weight:700;color:#b45309;background:#fef3c7;padding:1px 5px;border-radius:4px">F</span><span class="${!Number.isInteger(p.f) ? 'cf-blink' : ''}" style="font-size:13px;font-weight:700;color:#b45309">${+p.f.toFixed(1)}</span></div>` : ""}
        </div>
      </div>`).join("");

    bodyHtml = `
      <div style="flex:1;overflow-y:auto">${rows}</div>
      <div style="padding:12px 16px;border-top:1px solid var(--border,#eee);display:flex;justify-content:space-between;align-items:center;background:var(--bg3,#f8fafc);border-radius:0 0 14px 14px">
        <span style="font-size:12px;font-weight:600;color:var(--text2,#555)">Total</span>
        <div style="display:flex;gap:16px">
          ${cv.c > 0 ? `<div style="display:flex;align-items:center;gap:4px"><span style="font-size:10px;font-weight:700;color:#3b5bdb;background:#e8f0fe;padding:1px 5px;border-radius:4px">C</span><span style="font-size:13px;font-weight:700;color:#3b5bdb">${+cv.c.toFixed(1)}</span></div>` : ""}
          ${cv.f > 0 ? `<div style="display:flex;align-items:center;gap:4px"><span style="font-size:10px;font-weight:700;color:#b45309;background:#fef3c7;padding:1px 5px;border-radius:4px">F</span><span class="${!Number.isInteger(cv.f) ? 'cf-blink' : ''}" style="font-size:13px;font-weight:700;color:#b45309">${+cv.f.toFixed(1)}</span></div>` : ""}
        </div>
      </div>`;
  }

  const html = `
    <div id="cfModal" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px" onclick="if(event.target===this)this.remove()">
      <div style="background:var(--bg2,#fff);border-radius:14px;width:min(440px,100%);max-height:85vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.18);overflow:hidden">
        <div style="padding:14px 16px;border-bottom:1px solid var(--border,#eee);display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
          ${headerLeft}
          <button onclick="document.getElementById('cfModal').remove()" style="width:28px;height:28px;border-radius:50%;background:var(--bg3,#f0f0f0);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-left:8px">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text2,#555)" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        ${bodyHtml}
      </div>
    </div>`;

  document.getElementById("cfModal")?.remove();
  document.body.insertAdjacentHTML("beforeend", html);
}

// ── Journal Stock Modal (WM — multi-window) ───────────────────
async function showJournalStockModal(vendorId, lbl, roundId, baseUrl) {
  document.getElementById("jsModal")?.remove();
  const html = `
    <div id="jsModal" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;
      display:flex;align-items:center;justify-content:center;padding:12px"
      onclick="if(event.target===this)document.getElementById('jsModal')?.remove()">
      <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
        border-radius:10px;width:100%;max-width:760px;max-height:88vh;
        display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.14);overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;
          padding:11px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
          <span style="font-size:12px;font-weight:700;color:var(--text,#0F172A)">
            Journal Stock — ${escHtml(lbl)}</span>
          <button onclick="document.getElementById('jsModal')?.remove()"
            style="background:none;border:none;color:var(--text3,#94A3B8);cursor:pointer;
            font-size:18px;line-height:1;padding:2px 6px;border-radius:4px"
            onmouseover="this.style.background='var(--bg3,#F1F5F9)'"
            onmouseout="this.style.background='none'">×</button>
        </div>
        <div id="jsModalBody" style="flex:1;overflow-y:auto;padding:12px 14px">
          <div style="display:flex;align-items:center;justify-content:center;
            padding:32px;color:var(--text3,#94A3B8);font-size:12px;gap:8px">
            <div class="spinner-sm"></div>Chargement…</div>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML("beforeend", html);
  const body = document.getElementById("jsModalBody");
  try {
    const lines = await rpcController.fetchJournalStock(baseUrl, roundId);
    _renderJournalStockTable(body, lines, vendorId, lbl);
  } catch(err) {
    body.innerHTML = `<div style="padding:24px;text-align:center;color:#f87171;font-size:12px">
      Erreur: ${escHtml(err.message)}</div>`;
  }
}

async function showJournalStockModalWM(vendorId, lbl, roundId, baseUrl) {
  const SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="var(--accent,#3B82F6)" stroke-width="2" width="15" height="15">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>
    <line x1="9" y1="3" x2="9" y2="21"/></svg>`;

  const win = _wmCreateWindow("js", vendorId, `Journal Stock — ${lbl}`, SVG, "760px");
  if (!win) return; // déjà ouverte → focus

  const { body } = win;
  body.style.padding = "12px 14px";
  body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;
    padding:32px;color:var(--text3,#94A3B8);font-size:12px;gap:8px">
    <div class="spinner-sm"></div>Chargement…</div>`;

  try {
    const lines = await rpcController.fetchJournalStock(baseUrl, roundId);
    _renderJournalStockTable(body, lines, vendorId, lbl);
  } catch(err) {
    body.innerHTML = `<div style="padding:24px;text-align:center;color:#f87171;font-size:12px">
      Erreur: ${escHtml(err.message)}</div>`;
  }
}

// ── render partagé entre modal normal et WM ───────────────────
function _renderJournalStockTable(body, lines, vendorId, lbl) {
  if (!lines.length) {
    body.innerHTML = `<div style="text-align:center;padding:32px;
      color:var(--text3,#94A3B8);font-size:12px">Aucune donnée disponible</div>`;
    return;
  }

  const fmtCFU = (qty, pkgQty) => {
    if (qty <= 0) return `<span style="color:var(--text3,#94A3B8)">—</span>`;
    if (!pkgQty || pkgQty <= 1)
      return `<span style="font-weight:600">${qty}</span><span style="font-size:9px;color:var(--text3,#94A3B8);margin-left:1px">U</span>`;
    const c = Math.floor(qty / pkgQty);
    const u = Math.round((qty % pkgQty) * 100) / 100;
    let parts = "";
    if (c > 0) parts += `<span style="font-weight:600">${c}</span><span style="font-size:9px;color:var(--text3,#94A3B8);margin-left:1px">C</span>`;
    if (u > 0) parts += `${c > 0 ? "<span style='color:var(--text3);margin:0 2px'>+</span>" : ""}<span style="font-weight:600">${u}</span><span style="font-size:9px;color:var(--text3,#94A3B8);margin-left:1px">U</span>`;
    return parts || `<span style="color:var(--text3,#94A3B8)">—</span>`;
  };

  // نفس ستايل C/U لكن مصدره نص جاهز من Odoo (stock_global_ledger) بدل qty/pkgQty
  const fmtDech = raw => {
    if (!raw) return `<span style="color:var(--text3,#94A3B8)">—</span>`;
    const c = parseInt((raw.match(/(\d+)\s*(?:CARTON|FARDEAU)/i) || [])[1] || 0, 10);
    const u = parseInt((raw.match(/(\d+)\s*Unit/i) || [])[1] || 0, 10);
    let parts = "";
    if (c > 0) parts += `<span style="font-weight:600">${c}</span><span style="font-size:9px;color:var(--text3,#94A3B8);margin-left:1px">C</span>`;
    if (u > 0) parts += `${c > 0 ? "<span style='color:var(--text3);margin:0 2px'>+</span>" : ""}<span style="font-weight:600">${u}</span><span style="font-size:9px;color:var(--text3,#94A3B8);margin-left:1px">U</span>`;
    return parts || `<span style="color:var(--text3,#94A3B8)">—</span>`;
  };

  const cellStyle = (color = "var(--text2,#475569)") =>
    `padding:7px 8px;font-size:11px;text-align:right;border-bottom:1px solid var(--border,#E2E8F0);color:${color};white-space:nowrap`;

  const enriched = lines.map(l => ({
    ...l,
    finalVal: l.final > 0 ? l.final : (l.initial + l.loading - l.delivery + l.returned),
  }));

  const COLS = [
    { key:"name",     label:"Product",       color:"var(--text2,#475569)", numeric:false },
    { key:"initial",  label:"Initial Stock",  color:"var(--text2,#475569)", numeric:true  },
    { key:"loading",  label:"Loading",        color:"#2563EB",              numeric:true  },
    { key:"delivery", label:"Distribution",   color:"#16a34a",              numeric:true  },
    { key:"returned", label:"Return",         color:"#d97706",              numeric:true  },
    { key:"dechargement", label:"Déchargement", color:"#dc2626",            numeric:false },
    { key:"finalVal", label:"Final",          color:"var(--text,#0F172A)",  numeric:true  },
  ];

  let sortCol = null, sortDir = 1;

  const render = () => {
    const sorted = [...enriched].sort((a,b) => {
      if (!sortCol) return 0;
      const col = COLS.find(c=>c.key===sortCol);
      return col.numeric ? (a[sortCol]-b[sortCol])*sortDir
        : a[sortCol].localeCompare(b[sortCol],"fr",{sensitivity:"base"})*sortDir;
    });
    const arrow = k => sortCol!==k
      ? `<span style="opacity:.3;margin-left:3px;font-size:9px">⇅</span>`
      : `<span style="margin-left:3px;font-size:9px">${sortDir===1?"↑":"↓"}</span>`;
    const thBase = `padding:8px 8px;font-size:10px;font-weight:700;border-bottom:2px solid var(--border,#E2E8F0);
      white-space:nowrap;cursor:pointer;user-select:none;text-align:right;transition:background .1s`;
    const thHtml = COLS.map(col=>{
      const bg = sortCol===col.key?"var(--bg3,#F1F5F9)":"";
      return `<th data-jscol="${col.key}" style="${thBase};color:${col.col};background:${bg}">${col.label}${arrow(col.key)}</th>`;
    }).join("");
    const rowsHtml = sorted.map(l=>`
      <tr onmouseover="this.style.background='var(--bg3,#F8FAFC)'" onmouseout="this.style.background=''">
        <td style="padding:7px 8px;font-size:11px;color:var(--text,#0F172A);
          border-bottom:1px solid var(--border,#E2E8F0);max-width:190px;
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          title="${escHtml(l.name)}">${escHtml(productLabel(l.name))}</td>
        <td style="${cellStyle()}">${fmtCFU(l.initial,  l.pkgQty)}</td>
        <td style="${cellStyle("#2563EB")}">${fmtCFU(l.loading,  l.pkgQty)}</td>
        <td style="${cellStyle("#16a34a")}">${fmtCFU(l.delivery, l.pkgQty)}</td>
        <td style="${cellStyle("#d97706")}">${fmtCFU(l.returned, l.pkgQty)}</td>
        <td style="${cellStyle("#dc2626")}">${fmtDech(l.dechargement)}</td>
        <td style="${cellStyle("var(--text,#0F172A)")};font-weight:700">${fmtCFU(l.finalVal,l.pkgQty)}</td>
      </tr>`).join("");
    const existing = body.querySelector("table");
    if (existing) {
      existing.querySelector("thead tr").innerHTML = thHtml;
      existing.querySelector("tbody").innerHTML = rowsHtml;
      body.querySelectorAll("th[data-jscol]").forEach((th,i)=>{ th.style.color=COLS[i].color; });
    } else {
      body.innerHTML = `
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <thead><tr style="background:var(--bg3,#F8FAFC)">${thHtml}</tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
        <div style="padding:8px 10px;font-size:10px;color:var(--text3,#94A3B8);
          border-top:1px solid var(--border,#E2E8F0);margin-top:4px;
          display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <span>${enriched.length} product(s)</span>
          <span>Final = Initial + Loading − Distribution + Return</span>
          <span style="margin-left:auto"><b>C</b> = carton &nbsp;·&nbsp; <b>U</b> = unit</span>
        </div>`;
      body.querySelectorAll("th[data-jscol]").forEach((th,i)=>{ th.style.color=COLS[i].color; });
    }
    body.querySelectorAll("th[data-jscol]").forEach(th => {
      th.addEventListener("click", () => {
        const k = th.dataset.jscol;
        if (sortCol===k) { sortDir*=-1; } else { sortCol=k; sortDir=COLS.find(c=>c.key===k)?.numeric?-1:1; }
        render();
      });
    });
  };
  render();
}

// ── Modale "Bon de chargement" ──────────────────────────────────
async function showBonChargementModal(vendorId, lbl, roundId, baseUrl) {
  document.getElementById("bcModal")?.remove();
  const html = `
    <div id="bcModal" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;
      display:flex;align-items:center;justify-content:center;padding:12px"
      onclick="if(event.target===this)document.getElementById('bcModal')?.remove()">
      <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
        border-radius:10px;width:100%;max-width:640px;max-height:88vh;
        display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.14);overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;
          padding:11px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
          <span style="font-size:12px;font-weight:700;color:var(--text,#0F172A)">
            Bon de chargement — ${escHtml(lbl)}</span>
          <button onclick="document.getElementById('bcModal')?.remove()"
            style="background:none;border:none;color:var(--text3,#94A3B8);cursor:pointer;
            font-size:18px;line-height:1;padding:2px 6px;border-radius:4px"
            onmouseover="this.style.background='var(--bg3,#F1F5F9)'"
            onmouseout="this.style.background='none'">×</button>
        </div>
        <div id="bcModalBody" style="flex:1;overflow-y:auto;padding:12px 14px">
          <div style="display:flex;align-items:center;justify-content:center;
            padding:32px;color:var(--text3,#94A3B8);font-size:12px;gap:8px">
            <div class="spinner-sm"></div>Chargement…</div>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML("beforeend", html);
  const body = document.getElementById("bcModalBody");
  try {
    const data = await rpcController.fetchBonChargement(baseUrl, roundId);
    _renderBonChargementTable(body, data, baseUrl);
  } catch (err) {
    body.innerHTML = `<div style="padding:24px;text-align:center;color:#f87171;font-size:12px">
      Erreur: ${escHtml(err.message)}</div>`;
  }
}

// حالات وألوان الشارة، مشتركة بين القائمة الرئيسية ومودل التفاصيل
const _BC_STATE_LABELS = {
  draft: "Brouillon", waiting: "En attente", confirmed: "Confirmé",
  assigned: "Prêt", done: "Fait", cancel: "Annulé",
};

// ── أزرار العمليات على الكرت مباشرة (بدون فتح التفاصيل) — نفس منطق الحالة، مختصر ──
function _bcCardButtonsHtml(p, idx) {
  const isDone = p?.state === "done";
  const cfg = !isDone ? _BC_STATE_ACTIONS[p?.state] : null;
  const showCancel = !isDone && _BC_CANCEL_VISIBLE_STATES.includes(p?.state);
  const btns = [];
  if (cfg) {
    btns.push(`<span class="bc-card-action-btn" data-idx="${idx}" data-method="${cfg.method}" role="button"
      style="display:inline-flex;align-items:center;justify-content:center;min-width:76px;padding:3px 9px;
      font-size:10px;font-weight:600;border-radius:5px;border:none;
      background:var(--accent,#3B82F6);color:#fff;cursor:pointer;white-space:nowrap">${escHtml(cfg.label)}</span>`);
  }
  if (showCancel) {
    btns.push(`<span class="bc-card-cancel-btn" data-idx="${idx}" role="button"
      style="display:inline-flex;align-items:center;justify-content:center;min-width:56px;padding:3px 9px;
      font-size:10px;font-weight:600;border-radius:5px;border:none;
      background:#dc2626;color:#fff;cursor:pointer;white-space:nowrap">Annuler</span>`);
  }
  if (p?.id) {
    btns.push(`<span class="bc-card-open-btn" data-id="${p.id}" role="button" title="Ouvrir dans Odoo"
      style="display:inline-flex;align-items:center;justify-content:center;min-width:24px;padding:3px 8px;
      font-size:10px;font-weight:600;border-radius:5px;
      border:1px solid var(--border,#EEF2F6);background:var(--bg2,#fff);color:var(--text2,#475569);
      cursor:pointer;white-space:nowrap">↗</span>`);
  }
  return btns.join("");
}

// ── إجراء حالة مباشرة من الكرت (بدون فتح مودل التفاصيل) — يعيد رسم القائمة كاملة بعد النجاح ──
async function _bcCardHandleAction(idx, baseUrl, method, context, spanEl) {
  const picking = window._bcPickings?.[idx];
  if (!picking) return;
  const originalHtml = spanEl.textContent;
  spanEl.style.pointerEvents = "none";
  spanEl.style.opacity = ".6";
  spanEl.textContent = "…";
  try {
    await rpcController.pickingAction(baseUrl, picking.id, method, context);
    const updated = await rpcController.fetchPickingDetail(baseUrl, picking.id);
    window._bcPickings[idx] = updated;
    const body = document.querySelector("#bcModalBody");
    if (body) _renderBonChargementTable(body, window._bcPickings, baseUrl);
    addNotif(`${updated.name || "Bon"} — état mis à jour ✓`, "success");
  } catch (err) {
    addNotif("Erreur: " + err.message, "error");
    spanEl.style.pointerEvents = "";
    spanEl.style.opacity = "1";
    spanEl.textContent = originalHtml;
  }
}

function _renderBonChargementTable(body, pickings, baseUrl) {
  if (!pickings || !pickings.length) {
    body.innerHTML = `<div style="text-align:center;padding:32px;
      color:var(--text3,#94A3B8);font-size:12px">Aucune donnée disponible</div>`;
    return;
  }
  window._bcPickings = pickings;
  window._bcBaseUrl = baseUrl;
  body.innerHTML = pickings.map((p, idx) => {
    const total = (p.categories || []).reduce((s, c) => s + c.lines.length, 0);
    return `
    <div class="bc-pick-row" data-idx="${idx}" style="width:100%;display:flex;
      align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg3,#F8FAFC);
      border:1px solid var(--border,#E2E8F0);border-radius:8px;cursor:pointer;text-align:left;
      margin-bottom:8px;gap:8px">
      <span style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;color:var(--text,#0F172A)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          width="12" height="12"><polyline points="9 18 15 12 9 6"/></svg>
        ${escHtml(p.name || "")}
      </span>
      <span style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end">
        <span class="bc-state-badge" data-idx="${idx}" style="display:inline-flex;align-items:center;justify-content:center;
          min-width:60px;font-size:10px;font-weight:600;padding:2px 8px;border-radius:9px;
          background:var(--bg2,#fff);color:var(--text2,#475569);border:1px solid var(--border,#EEF2F6)">
          ${escHtml(_BC_STATE_LABELS[p.state] || p.state || "")}</span>
        <span style="font-size:10px;color:var(--text3,#94A3B8)">${total} produit${total > 1 ? "s" : ""}</span>
        ${_bcCardButtonsHtml(p, idx)}
      </span>
    </div>`;
  }).join("");

  body.querySelectorAll(".bc-pick-row").forEach(row => {
    row.addEventListener("click", () => {
      const idx = Number(row.dataset.idx);
      _showBonChargementDetailModal(window._bcPickings[idx], idx, baseUrl);
    });
  });

  body.querySelectorAll(".bc-card-action-btn").forEach(span => {
    span.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(span.dataset.idx);
      const method = span.dataset.method;
      const cfg = _BC_STATE_ACTIONS[window._bcPickings[idx]?.state];
      if (!cfg) return;
      _bcCardHandleAction(idx, baseUrl, method, cfg.context, span);
    });
  });
  body.querySelectorAll(".bc-card-cancel-btn").forEach(span => {
    span.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(span.dataset.idx);
      _bcCardHandleAction(idx, baseUrl, _BC_CANCEL_ACTION.method, _BC_CANCEL_ACTION.context, span);
    });
  });
  body.querySelectorAll(".bc-card-open-btn").forEach(span => {
    span.addEventListener("click", (e) => {
      e.stopPropagation();
      window.open((getOdooBase() || "") + `/web#id=${span.dataset.id}&action=233&active_id=76&model=stock.picking&view_type=form&cids=1&menu_id=115`, "_blank");
    });
  });
}

// ── تحديث شارة الحالة في القائمة الرئيسية بعد نجاح إجراء ──
function _bcUpdateMainListBadge(idx, state) {
  const badge = document.querySelector(`#bcModalBody .bc-state-badge[data-idx="${idx}"]`);
  if (badge) badge.textContent = _BC_STATE_LABELS[state] || state || "";
}

// ── منطق أزرار الحالة (state buttons) لـ stock.picking، بنفس منطق Odoo ──
const _BC_STATE_ACTIONS = {
  draft:     { label: "Marquer à faire",         method: "action_confirm",  context: {} },
  waiting:   { label: "Vérifier la disponibilité", method: "action_assign", context: { from_button: true } },
  confirmed: { label: "Vérifier la disponibilité", method: "action_assign", context: { from_button: true } },
  assigned:  { label: "Valider",                  method: "button_validate", context: { direct_validation: true } },
};

// زر Annuler: يظهر ما دام state ضمن هذه القائمة (نفس منطق invisible المعطى في Odoo)
const _BC_CANCEL_VISIBLE_STATES = ["assigned", "confirmed", "partially_available", "draft", "waiting"];
const _BC_CANCEL_ACTION = { method: "action_cancel", context: { open_cancel_delivery_wizard: true } };

let _bcEditMode = false;
let _bcCurrentPicking = null; // مرجع وحيد ومحدَّث دائمًا لبيانات الـ picking المعروضة حاليًا

function _bcCategoriesBodyHtml(categories, editable, pickingState) {
  const isDone = pickingState === "done";
  const colgroup = `<colgroup>
    <col style="width:auto">
    <col style="width:64px"><col style="width:64px"><col style="width:64px"><col style="width:76px">
  </colgroup>`;
  return !categories?.length
    ? `<div style="text-align:center;padding:32px;color:var(--text3,#94A3B8);font-size:12px">Aucune donnée disponible</div>`
    : categories.map(cat => `
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--accent,#3B82F6);
          text-transform:uppercase;letter-spacing:.02em;margin-bottom:4px">${escHtml(cat.categ)}</div>
        <table style="width:100%;border-collapse:collapse;font-size:11px;table-layout:fixed">
          ${colgroup}
          <thead>
            <tr style="border-bottom:1px solid var(--border,#EEF2F6)">
              <th style="text-align:left;padding:6px 4px;color:var(--text2,#475569)">Produit</th>
              <th style="text-align:right;padding:6px 4px;color:var(--text2,#475569)">CND</th>
              <th style="text-align:right;padding:6px 4px;color:var(--text2,#475569)">Quantity</th>
              <th style="text-align:right;padding:6px 4px;color:var(--text2,#475569)">Réservé</th>
              <th style="text-align:right;padding:6px 4px;color:var(--text2,#475569)">CND Réservé</th>
            </tr>
          </thead>
          <tbody>
            ${cat.lines.map(l => {
              const short = !isDone && l.reserve < l.demande;
              const rowStyle = short
                ? "border-bottom:1px solid var(--border,#F5F7FA);background:#FEF2F2"
                : "border-bottom:1px solid var(--border,#F5F7FA)";
              const textColor = short ? "#DC2626" : "var(--text,#0F172A)";
              const canEdit = editable && (l.moveIds || []).length === 1;
              const mid = (l.moveIds || [])[0];
              if (canEdit) {
                return `
                <tr style="${rowStyle}" data-mid="${mid}" data-name="${escHtml(l.name || "")}"
                  data-qty-editable="true" data-cnd-editable="true"
                  data-orig-cnd="${l.cnd}" data-orig-qty="${l.demande}" data-ratio="${l.packagingRatio || 0}">
                  <td style="padding:6px 4px;color:${textColor};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(productLabel(l.name || ""))}</td>
                  <td style="padding:3px 4px;text-align:right">
                    <input type="number" class="bc-edit-cnd" value="${l.cnd}"
                      style="width:100%;max-width:52px;font-size:11px;text-align:right;padding:2px 4px;
                      border:1px solid var(--border,#EEF2F6);border-radius:4px;background:transparent"/></td>
                  <td style="padding:3px 4px;text-align:right">
                    <input type="number" class="bc-edit-qty" value="${l.demande}"
                      style="width:100%;max-width:52px;font-size:11px;text-align:right;padding:2px 4px;
                      border:1px solid var(--border,#EEF2F6);border-radius:4px;background:transparent"/></td>
                  <td style="padding:6px 4px;text-align:right;color:${textColor}">${l.reserve}</td>
                  <td style="padding:6px 4px;text-align:right;color:${textColor};font-weight:600">${l.cndReserve}</td>
                </tr>`;
              }
              return `
              <tr style="${rowStyle}">
                <td style="padding:6px 4px;color:${textColor};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(productLabel(l.name || ""))}</td>
                <td style="padding:6px 4px;text-align:right;color:${textColor};font-weight:600">${l.cnd}</td>
                <td style="padding:6px 4px;text-align:right;color:${textColor}">${l.demande}</td>
                <td style="padding:6px 4px;text-align:right;color:${textColor}">${l.reserve}</td>
                <td style="padding:6px 4px;text-align:right;color:${textColor};font-weight:600">${l.cndReserve}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`).join("");
}

function _bcRenderDetailBody(picking) {
  const bodyEl = document.querySelector("#bcDetailModal .bc-detail-body");
  if (!bodyEl) return;
  bodyEl.innerHTML = _bcCategoriesBodyHtml(picking?.categories, _bcEditMode, picking?.state);
  if (!_bcEditMode) return;

  // ربط حي بين CND وQuantity: تعديل أي حقل يحوّل الآخر تلقائيًا حسب نسبة التعبئة
  bodyEl.querySelectorAll("tr[data-mid]").forEach(row => {
    const ratio = Number(row.dataset.ratio) || 0;
    if (ratio <= 0) return; // لا توجد نسبة تعبئة معروفة لهذا المنتج — لا ربط ممكن
    const cndInput = row.querySelector(".bc-edit-cnd");
    const qtyInput = row.querySelector(".bc-edit-qty");
    if (!cndInput || !qtyInput) return;
    cndInput.addEventListener("input", () => {
      if (cndInput.disabled) return;
      const cnd = Number(cndInput.value) || 0;
      if (!qtyInput.disabled) qtyInput.value = _bcRound2(cnd * ratio);
    });
    qtyInput.addEventListener("input", () => {
      if (qtyInput.disabled) return;
      const qty = Number(qtyInput.value) || 0;
      // عدد كراتين كاملة فقط (Math.floor) — نفس مثال: 8 قطع من كرتون 10 = 0 CND
      if (!cndInput.disabled) cndInput.value = Math.floor(qty / ratio);
    });
  });
}

function _bcRound2(n) { return Math.round(n * 100) / 100; }

// يجمع كل الأسطر القابلة للتعديل من الجدول الحالي في DOM ويحفظها كلها تباعًا،
// ثم يعيد جلب البيانات المحدثة فعليًا من الخادم (مصدر الحقيقة الوحيد بعد الحفظ)
//
// الحقلان مرتبطان حيًّا في الواجهة أصلًا (انظر _bcRenderDetailBody)، لذا قيمهما هنا
// متزامنة دائمًا — نرسل الاثنين معًا إذا تغيّر أحدهما، مثل مودل "Ajouter produit".
async function _bcSaveAllLinesAndFinish(picking) {
  const bodyEl = document.querySelector("#bcDetailModal .bc-detail-body");
  const rows = bodyEl ? Array.from(bodyEl.querySelectorAll("tr[data-mid]")) : [];
  const baseUrl = window._bcBaseUrl;

  for (const row of rows) {
    const mid = Number(row.dataset.mid);
    const name = row.dataset.name || "";
    const qtyEditable = row.dataset.qtyEditable !== "false";
    const cndEditable = row.dataset.cndEditable !== "false";
    const ratio = Number(row.dataset.ratio) || 0;
    const origCnd = Number(row.dataset.origCnd) || 0;
    const origQty = Number(row.dataset.origQty) || 0;
    const qty = Number(row.querySelector(".bc-edit-qty")?.value) || 0;
    const cnd = Number(row.querySelector(".bc-edit-cnd")?.value) || 0;

    const cndChanged = cndEditable && cnd !== origCnd;
    const qtyChanged = qtyEditable && qty !== origQty;
    if (!cndChanged && !qtyChanged) continue; // لا تغيير في هذا السطر

    const vals = {};
    if (ratio > 0) {
      // الحقلان متزامنان أصلًا في الواجهة — نرسلهما معًا كما هما معروضان
      vals.packaging_quantity = cnd;
      vals.product_uom_qty = qty;
    } else {
      // لا نسبة تعبئة معروفة لهذا المنتج (بدون CND) — نرسل فقط الحقل الذي تغيّر
      if (cndChanged) vals.packaging_quantity = cnd;
      if (qtyChanged) vals.product_uom_qty = qty;
    }

    await rpcController.updateMoveQty(baseUrl, picking.id, mid, vals, name);
  }

  // بعد حفظ كل الأسطر، نجلب النسخة المحدثة فعليًا من الخادم — هذا يمنع رجوع القيم القديمة
  const updated = await rpcController.fetchPickingDetail(baseUrl, picking.id);
  const idx = (window._bcPickings || []).findIndex(p => p.id === picking.id);
  if (idx >= 0) { window._bcPickings[idx] = updated; _bcUpdateMainListBadge(idx, updated.state); }
  return updated;
}

function _renderBcActionButton(picking) {
  const wrap = document.getElementById("bcActionBtnWrap");
  if (!wrap) return;
  const isDone = picking?.state === "done";
  const cfg = !isDone ? _BC_STATE_ACTIONS[picking?.state] : null;
  const showCancel = !isDone && _BC_CANCEL_VISIBLE_STATES.includes(picking?.state);
  const btns = [];
  if (cfg) {
    btns.push(`<button id="bcActionBtn" style="display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:88px;padding:5px 12px;font-size:11px;font-weight:600;border-radius:5px;
      border:none;background:var(--accent,#3B82F6);color:#fff;cursor:pointer;white-space:nowrap"
      onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">
      ${escHtml(cfg.label)}</button>`);
  }
  if (showCancel) {
    btns.push(`<button id="bcCancelBtn" style="display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:88px;padding:5px 12px;font-size:11px;font-weight:600;border-radius:5px;
      border:none;background:#dc2626;color:#fff;cursor:pointer;white-space:nowrap"
      onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">Annuler</button>`);
  }
  if (picking?.id) {
    btns.push(`<button id="bcOpenOdooBtn" title="Ouvrir dans Odoo" style="display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:88px;padding:5px 12px;font-size:11px;font-weight:600;border-radius:5px;
      border:1px solid var(--border,#EEF2F6);background:var(--bg2,#fff);color:var(--text2,#475569);cursor:pointer;white-space:nowrap"
      onmouseover="this.style.background='var(--bg3,#F1F5F9)'" onmouseout="this.style.background='var(--bg2,#fff)'"
      onclick="window.open((getOdooBase()||'')+'/web#id=${picking.id}&action=233&active_id=76&model=stock.picking&view_type=form&cids=1&menu_id=115','_blank')">
      Ouvrir dans Odoo ↗</button>`);
  }
  if (!isDone) {
    btns.push(`<button id="bcEditBtn" style="display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:88px;padding:5px 12px;font-size:11px;font-weight:600;border-radius:5px;
      border:1px solid var(--border,#EEF2F6);background:var(--bg2,#fff);color:var(--text2,#475569);cursor:pointer;white-space:nowrap"
      onmouseover="this.style.background='var(--bg3,#F1F5F9)'" onmouseout="this.style.background='var(--bg2,#fff)'">
      ${_bcEditMode ? "Terminer" : "Modifier"}</button>`);
    if (_bcEditMode) {
      btns.push(`<button id="bcDiscardEditBtn" style="display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:88px;padding:5px 12px;font-size:11px;font-weight:600;border-radius:5px;
        border:1px solid var(--border,#EEF2F6);background:var(--bg2,#fff);color:#dc2626;cursor:pointer;white-space:nowrap"
        onmouseover="this.style.background='var(--bg3,#F1F5F9)'" onmouseout="this.style.background='var(--bg2,#fff)'">
        Annuler les modifications</button>`);
    }
  }

  wrap.innerHTML = btns.join("");

  if (cfg) document.getElementById("bcActionBtn").addEventListener("click", () => {
    _bcHandleAction(_bcCurrentPicking, cfg.method, cfg.context);
  });
  if (showCancel) document.getElementById("bcCancelBtn").addEventListener("click", () => {
    _bcHandleAction(_bcCurrentPicking, _BC_CANCEL_ACTION.method, _BC_CANCEL_ACTION.context);
  });
  document.getElementById("bcEditBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("bcEditBtn");
    if (_bcEditMode) {
      // Terminer: نحفظ كل الأسطر المعدّلة دفعة واحدة قبل إغلاق وضع التحرير
      btn.disabled = true;
      const originalLabel = btn.textContent;
      btn.textContent = "…";
      try {
        const updated = await _bcSaveAllLinesAndFinish(_bcCurrentPicking);
        _bcCurrentPicking = updated;
        addNotif("Modifications enregistrées ✓", "success");
      } catch (err) {
        addNotif("Erreur: " + err.message, "error");
        btn.disabled = false;
        btn.textContent = originalLabel;
        return; // نبقى في وضع التحرير إذا فشل الحفظ
      }
      _bcEditMode = false;
    } else {
      _bcEditMode = true;
    }
    _renderBcActionButton(_bcCurrentPicking);
    _bcRenderDetailBody(_bcCurrentPicking);
  });
  if (_bcEditMode) document.getElementById("bcDiscardEditBtn").addEventListener("click", () => {
    // إلغاء التعديلات غير المحفوظة: خروج من وضع التحرير وإعادة الرسم من آخر بيانات محفوظة فعلياً
    _bcEditMode = false;
    _renderBcActionButton(_bcCurrentPicking);
    _bcRenderDetailBody(_bcCurrentPicking);
  });
}

async function _bcHandleAction(picking, method, context) {
  // حماية: button_validate لا يُنفَّذ إلا إذا state === "assigned" فعليًا
  if (method === "button_validate" && picking.state !== "assigned") return;

  const btnId = method === "action_cancel" ? "bcCancelBtn" : "bcActionBtn";
  const btn = document.getElementById(btnId);
  const originalLabel = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = ".6";
    btn.style.cursor = "default";
    btn.innerHTML = `<div class="spinner-sm"></div>`;
  }
  try {
    const baseUrl = window._bcBaseUrl;
    await rpcController.pickingAction(baseUrl, picking.id, method, context);
    const updated = await rpcController.fetchPickingDetail(baseUrl, picking.id);

    // تحديث الحالة محلياً في window._bcPickings دون إعادة فتح المودل بالكامل
    const idx = (window._bcPickings || []).findIndex(p => p.id === picking.id);
    if (idx >= 0) window._bcPickings[idx] = updated;
    _bcCurrentPicking = updated;

    // إعادة رسم جسم الجدول (categories)
    _bcRenderDetailBody(updated);

    // إعادة رسم الأزرار حسب الحالة الجديدة
    _renderBcActionButton(updated);

    // تحديث الشارة في القائمة الرئيسية
    if (idx >= 0) _bcUpdateMainListBadge(idx, updated.state);

    addNotif(`${updated.name || "Bon"} — état mis à jour ✓`, "success");
  } catch (err) {
    addNotif("Erreur: " + err.message, "error");
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
      btn.innerHTML = originalLabel;
    }
  }
}

// ── Modale détail : produits d'un bon de chargement, groupés par catégorie ──
function _showBonChargementDetailModal(picking, idx, baseUrl) {
  document.getElementById("bcDetailModal")?.remove();
  if (baseUrl) window._bcBaseUrl = baseUrl;
  _bcEditMode = false;
  _bcCurrentPicking = picking;
  const bodyHtml = _bcCategoriesBodyHtml(picking?.categories, false, picking?.state);

  const html = `
    <div id="bcDetailModal" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10001;
      display:flex;align-items:center;justify-content:center;padding:12px"
      onclick="if(event.target===this)document.getElementById('bcDetailModal')?.remove()">
      <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
        border-radius:10px;width:100%;max-width:640px;max-height:88vh;
        display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.14);overflow:hidden">
        <div style="padding:11px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:12px;font-weight:700;color:var(--text,#0F172A)">
              ${escHtml(picking?.name || "")}</span>
            <button onclick="document.getElementById('bcDetailModal')?.remove()"
              style="background:none;border:none;color:var(--text3,#94A3B8);cursor:pointer;
              font-size:18px;line-height:1;padding:2px 6px;border-radius:4px"
              onmouseover="this.style.background='var(--bg3,#F1F5F9)'"
              onmouseout="this.style.background='none'">×</button>
          </div>
          <div id="bcActionBtnWrap" style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap"></div>
        </div>
        <div class="bc-detail-body" style="flex:1;overflow-y:auto;padding:12px 14px">${bodyHtml}</div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML("beforeend", html);
  _renderBcActionButton(_bcCurrentPicking);
}

async function showJournalStockModal(vendorId, lbl, roundId, baseUrl) {
  document.getElementById("jsModal")?.remove();

  const html = `
    <div id="jsModal" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;
      display:flex;align-items:center;justify-content:center;padding:12px"
      onclick="if(event.target===this)document.getElementById('jsModal')?.remove()">
      <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
        border-radius:10px;width:100%;max-width:760px;max-height:88vh;
        display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.14);overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;
          padding:11px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
          <div style="display:flex;align-items:center;gap:8px">
            <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent,#3B82F6)" stroke-width="2"
              width="15" height="15"><rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>
              <line x1="9" y1="3" x2="9" y2="21"/></svg>
            <span style="font-size:12px;font-weight:700;color:var(--text,#0F172A)">
              Journal Stock — ${escHtml(lbl)}
            </span>
          </div>
          <button onclick="document.getElementById('jsModal')?.remove()"
            style="background:none;border:none;color:var(--text3,#94A3B8);cursor:pointer;
            font-size:18px;line-height:1;padding:2px 6px;border-radius:4px"
            onmouseover="this.style.background='var(--bg3,#F1F5F9)'"
            onmouseout="this.style.background='none'">×</button>
        </div>
        <div id="jsModalBody" style="flex:1;overflow-y:auto;padding:12px 14px">
          <div style="display:flex;align-items:center;justify-content:center;
            padding:32px;color:var(--text3,#94A3B8);font-size:12px;gap:8px">
            <div class="spinner-sm"></div>
            Chargement…
          </div>
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML("beforeend", html);
  const body = document.getElementById("jsModalBody");

  try {
    const lines = await rpcController.fetchJournalStock(baseUrl, roundId);

    if (!lines.length) {
      body.innerHTML = `<div style="text-align:center;padding:32px;
        color:var(--text3,#94A3B8);font-size:12px">Aucune donnée disponible</div>`;
      return;
    }

    // ── helpers ──
    const fmtCFU = (qty, pkgQty) => {
      if (qty <= 0) return `<span style="color:var(--text3,#94A3B8)">—</span>`;
      if (!pkgQty || pkgQty <= 1)
        return `<span style="font-weight:600">${qty}</span><span style="font-size:9px;color:var(--text3,#94A3B8);margin-left:1px">U</span>`;
      const c = Math.floor(qty / pkgQty);
      const u = Math.round((qty % pkgQty) * 100) / 100;
      let parts = "";
      if (c > 0) parts += `<span style="font-weight:600">${c}</span><span style="font-size:9px;color:var(--text3,#94A3B8);margin-left:1px">C</span>`;
      if (u > 0) parts += `${c > 0 ? "<span style='color:var(--text3);margin:0 2px'>+</span>" : ""}<span style="font-weight:600">${u}</span><span style="font-size:9px;color:var(--text3,#94A3B8);margin-left:1px">U</span>`;
      return parts || `<span style="color:var(--text3,#94A3B8)">—</span>`;
    };

    // نفس ستايل C/U لكن مصدره نص جاهز من Odoo (stock_global_ledger) بدل qty/pkgQty
    const fmtDech = raw => {
      if (!raw) return `<span style="color:var(--text3,#94A3B8)">—</span>`;
      const c = parseInt((raw.match(/(\d+)\s*(?:CARTON|FARDEAU)/i) || [])[1] || 0, 10);
      const u = parseInt((raw.match(/(\d+)\s*Unit/i) || [])[1] || 0, 10);
      let parts = "";
      if (c > 0) parts += `<span style="font-weight:600">${c}</span><span style="font-size:9px;color:var(--text3,#94A3B8);margin-left:1px">C</span>`;
      if (u > 0) parts += `${c > 0 ? "<span style='color:var(--text3);margin:0 2px'>+</span>" : ""}<span style="font-weight:600">${u}</span><span style="font-size:9px;color:var(--text3,#94A3B8);margin-left:1px">U</span>`;
      return parts || `<span style="color:var(--text3,#94A3B8)">—</span>`;
    };

    const cellStyle = (color = "var(--text2,#475569)") =>
      `padding:7px 8px;font-size:11px;text-align:right;border-bottom:1px solid var(--border,#E2E8F0);color:${color};white-space:nowrap`;

    // ── enrich with finalVal ──
    const enriched = lines.map(l => ({
      ...l,
      finalVal: l.final > 0 ? l.final : (l.initial + l.loading - l.delivery + l.returned),
    }));

    const COLS = [
      { key: "name",     label: "Product",       color: "var(--text2,#475569)", numeric: false },
      { key: "initial",  label: "Initial Stock",  color: "var(--text2,#475569)", numeric: true  },
      { key: "loading",  label: "Loading",        color: "#2563EB",              numeric: true  },
      { key: "delivery", label: "Distribution",   color: "#16a34a",              numeric: true  },
      { key: "returned", label: "Return",         color: "#d97706",              numeric: true  },
      { key: "dechargement", label: "Déchargement", color: "#dc2626",            numeric: false },
      { key: "finalVal", label: "Final",          color: "var(--text,#0F172A)",  numeric: true  },
    ];

    let sortCol = null;
    let sortDir = 1;

    const renderTable = () => {
      const sorted = [...enriched].sort((a, b) => {
        if (!sortCol) return 0;
        const col = COLS.find(c => c.key === sortCol);
        if (!col) return 0;
        return col.numeric
          ? (a[sortCol] - b[sortCol]) * sortDir
          : a[sortCol].localeCompare(b[sortCol], "fr", { sensitivity: "base" }) * sortDir;
      });

      const arrow = key => sortCol !== key
        ? `<span style="opacity:.3;margin-left:3px;font-size:9px">⇅</span>`
        : `<span style="margin-left:3px;font-size:9px">${sortDir === 1 ? "↑" : "↓"}</span>`;

      const thBase = `padding:8px 8px;font-size:10px;font-weight:700;
        border-bottom:2px solid var(--border,#E2E8F0);white-space:nowrap;
        cursor:pointer;user-select:none;text-align:right;transition:background .1s`;

      const thHtml = COLS.map(col => {
        const active = sortCol === col.key;
        const bg = active ? "var(--bg3,#F1F5F9)" : "";
        return `<th data-jscol="${col.key}"
          style="${thBase};color:${col.col};background:${bg}"
          >${col.label}${arrow(col.key)}</th>`;
      }).join("");

      const rowsHtml = sorted.map(l => `
        <tr onmouseover="this.style.background='var(--bg3,#F8FAFC)'" onmouseout="this.style.background=''">
          <td style="padding:7px 8px;font-size:11px;color:var(--text,#0F172A);
            border-bottom:1px solid var(--border,#E2E8F0);max-width:190px;
            overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title="${escHtml(l.name)}">${escHtml(productLabel(l.name))}</td>
          <td style="${cellStyle()}">${fmtCFU(l.initial,  l.pkgQty)}</td>
          <td style="${cellStyle("#2563EB")}">${fmtCFU(l.loading,  l.pkgQty)}</td>
          <td style="${cellStyle("#16a34a")}">${fmtCFU(l.delivery, l.pkgQty)}</td>
          <td style="${cellStyle("#d97706")}">${fmtCFU(l.returned, l.pkgQty)}</td>
          <td style="${cellStyle("#dc2626")}">${fmtDech(l.dechargement)}</td>
          <td style="${cellStyle("var(--text,#0F172A)")};font-weight:700">${fmtCFU(l.finalVal, l.pkgQty)}</td>
        </tr>`).join("");

      const existing = body.querySelector("table");
      if (existing) {
        existing.querySelector("thead tr").innerHTML = thHtml;
        existing.querySelector("tbody").innerHTML = rowsHtml;
        // إعادة bind لون العناوين (col.color لم يُطبَّق)
        body.querySelectorAll("th[data-jscol]").forEach((th, i) => {
          th.style.color = COLS[i].color;
        });
      } else {
        body.innerHTML = `
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:11px">
              <thead><tr style="background:var(--bg3,#F8FAFC)">${thHtml}</tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
          <div style="padding:8px 10px;font-size:10px;color:var(--text3,#94A3B8);
            border-top:1px solid var(--border,#E2E8F0);margin-top:4px;
            display:flex;gap:12px;flex-wrap:wrap;align-items:center">
            <span>${enriched.length} product(s)</span>
            <span>Final = Initial + Loading − Distribution + Return</span>
            <span style="margin-left:auto"><b>C</b> = carton &nbsp;·&nbsp; <b>U</b> = unit</span>
          </div>`;
        body.querySelectorAll("th[data-jscol]").forEach((th, i) => {
          th.style.color = COLS[i].color;
        });
      }

      body.querySelectorAll("th[data-jscol]").forEach(th => {
        th.addEventListener("click", () => {
          const key = th.dataset.jscol;
          if (sortCol === key) {
            sortDir *= -1;
          } else {
            sortCol = key;
            sortDir = COLS.find(c => c.key === key)?.numeric ? -1 : 1;
          }
          renderTable();
        });
      });
    };

    renderTable();

  } catch (err) {
    body.innerHTML = `<div style="padding:24px;text-align:center;
      color:#f87171;font-size:12px">Erreur: ${escHtml(err.message)}</div>`;
  }
}

// ── helper: تحديث الحالة بعد قبول hors-tournée ───────────────
function _afterAcceptHors(workerId, _ck) {
  updateStats({ [workerId]: { horsRoute: false } });
  updateCacheForContext(_ck, { userStatus: { [workerId]: "normal" } });
  if (_ck === _cacheKey()) App.allUserStatus = { ..._contextCache[_ck].userStatus };
  Storage.getVendorStats().then(allStats => {
    const ck   = _cacheKey();
    const day  = ck.split("_")[1] || getTodayKey();
    const mode = App.currentMode;
    if (allStats?.[day]?.[mode]?.[workerId]) {
      allStats[day][mode][workerId].horsRoute = false;
      Storage.saveVendorStats(allStats);
    }
  });
  renderVendors();
}

// ── Modal hors-tournée ────────────────────────────────────────
function showHorsModal(workerId, lbl, baseUrl, wizModel, wizardId, lineModel, lines) {
  document.getElementById("horsModal")?.remove();

  // بناء قائمة الزبائن
  const itemsHtml = lines.map(l => {
    const name    = l.name || (Array.isArray(l.partner_id) ? l.partner_id[1] : "—");
    const partner = Array.isArray(l.partner_id) ? l.partner_id[1] : "";
    const partnerId = Array.isArray(l.partner_id) ? l.partner_id[0] : null;
    const date    = l.start ? new Date(l.start).toLocaleDateString("fr-FR", { day:"2-digit", month:"2-digit" }) : "";
    return `
      <div class="hors-item" data-lid="${l.id}" style="display:flex;align-items:center;gap:10px;
        padding:9px 12px;border-radius:7px;border:1px solid var(--border,#E2E8F0);
        background:var(--bg,#fff);cursor:pointer;transition:background .12s;margin-bottom:6px"
        onmouseover="this.style.background='var(--bg3,#F1F5F9)'"
        onmouseout="this.style.background='var(--bg,#fff)'">
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:600;color:var(--text,#0F172A);
            overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(name)}</div>
          ${partner && partner !== name ? `<div style="font-size:10px;color:var(--text3,#94A3B8)">${escHtml(partner)}${_clientLinkIconHtml(partnerId, null)}</div>` : ""}
        </div>
        ${date ? `<span style="font-size:10px;color:var(--text3,#94A3B8);white-space:nowrap">${date}</span>` : ""}
        <button class="hors-accept-btn" data-lid="${l.id}"
          style="padding:4px 10px;font-size:11px;font-weight:600;border-radius:5px;
          border:none;background:var(--accent,#3B82F6);color:#fff;cursor:pointer;white-space:nowrap;
          flex-shrink:0"
          onmouseover="this.style.opacity='.82'" onmouseout="this.style.opacity='1'">
          Valider
        </button>
        <button class="hors-refuse-btn" data-lid="${l.id}"
          style="padding:4px 10px;font-size:11px;font-weight:600;border-radius:5px;
          border:none;background:#dc2626;color:#fff;cursor:pointer;white-space:nowrap;
          flex-shrink:0"
          onmouseover="this.style.opacity='.82'" onmouseout="this.style.opacity='1'">
          Refuser
        </button>
      </div>`;
  }).join("");

  const html = `
    <div id="horsModal" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;
      display:flex;align-items:center;justify-content:center;padding:12px"
      onclick="if(event.target===this)document.getElementById('horsModal')?.remove()">
      <div style="background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);
        border-radius:10px;width:100%;max-width:420px;max-height:80vh;
        display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.14);overflow:hidden">

        <div style="display:flex;align-items:center;justify-content:space-between;
          padding:11px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
          <div>
            <div style="font-size:12px;font-weight:700;color:var(--text,#0F172A)">
              Hors-tournée — ${escHtml(lbl)}
            </div>
            <div style="font-size:10px;color:var(--text3,#94A3B8);margin-top:1px">
              ${lines.length} client(s) à valider
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <button id="horsAcceptAll"
              style="padding:5px 12px;font-size:11px;font-weight:600;border-radius:5px;
              border:none;background:#16a34a;color:#fff;cursor:pointer"
              onmouseover="this.style.opacity='.82'" onmouseout="this.style.opacity='1'">
              Tout valider
            </button>
            <button id="horsRefuseAll"
              style="padding:5px 12px;font-size:11px;font-weight:600;border-radius:5px;
              border:none;background:#dc2626;color:#fff;cursor:pointer"
              onmouseover="this.style.opacity='.82'" onmouseout="this.style.opacity='1'">
              Tout refuser
            </button>
            <button onclick="document.getElementById('horsModal')?.remove()"
              style="background:none;border:none;color:var(--text3,#94A3B8);cursor:pointer;
              font-size:18px;line-height:1;padding:2px 6px;border-radius:4px"
              onmouseover="this.style.background='var(--bg3,#F1F5F9)'"
              onmouseout="this.style.background='none'">×</button>
          </div>
        </div>

        <div id="horsModalBody" style="flex:1;overflow-y:auto;padding:12px">
          ${itemsHtml}
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML("beforeend", html);

  const modal   = document.getElementById("horsModal");
  const body    = document.getElementById("horsModalBody");
  const _ck     = _cacheKey();
  let   pending = new Set(lines.map(l => l.id));

  // ── قبول زبون واحد ──────────────────────────────────────
  const acceptOne = async (lineId) => {
    const item = body.querySelector(`.hors-item[data-lid="${lineId}"]`);
    const btn2 = body.querySelector(`.hors-accept-btn[data-lid="${lineId}"]`);
    if (btn2) { btn2.disabled = true; btn2.textContent = "…"; }
    try {
      await rpcController.acceptOneHors(baseUrl, wizModel, wizardId, lineId, lineModel);
      if (item) item.style.opacity = ".4";
      if (btn2) { btn2.textContent = "✓"; btn2.style.background = "#16a34a"; }
      pending.delete(lineId);
      if (pending.size === 0) {
        _afterAcceptHors(workerId, _ck);
        setTimeout(() => modal?.remove(), 600);
      }
    } catch (err) {
      if (btn2) { btn2.disabled = false; btn2.textContent = "Valider"; }
      addNotif(`Erreur: ${err.message}`, "error");
    }
  };

  // ── رفض زبون واحد ────────────────────────────────────────
  const refuseOne = async (lineId) => {
    const item = body.querySelector(`.hors-item[data-lid="${lineId}"]`);
    const btn2 = body.querySelector(`.hors-refuse-btn[data-lid="${lineId}"]`);
    if (btn2) { btn2.disabled = true; btn2.textContent = "…"; }
    try {
      await rpcController.refuseOneHors(baseUrl, wizModel, wizardId, lineId, lineModel);
      if (item) item.style.opacity = ".4";
      if (btn2) { btn2.textContent = "✓"; btn2.style.background = "#991b1b"; }
      pending.delete(lineId);
      if (pending.size === 0) {
        _afterAcceptHors(workerId, _ck);
        setTimeout(() => modal?.remove(), 600);
      }
    } catch (err) {
      if (btn2) { btn2.disabled = false; btn2.textContent = "Refuser"; }
      addNotif(`Erreur: ${err.message}`, "error");
    }
  };

  // ── قبول الكل ───────────────────────────────────────────
  document.getElementById("horsAcceptAll").addEventListener("click", async () => {
    document.getElementById("horsAcceptAll").disabled = true;
    addNotif(`Validation totale: ${lbl}…`, "info");
    try {
      await rpcController.acceptAllHors(baseUrl, wizModel, wizardId);
      _afterAcceptHors(workerId, _ck);
      addNotif(`✓ Tous validés: ${lbl}`, "success");
      modal?.remove();
    } catch (err) {
      document.getElementById("horsAcceptAll").disabled = false;
      addNotif(`Erreur: ${err.message}`, "error");
    }
  });

  // ── رفض الكل ────────────────────────────────────────────
  document.getElementById("horsRefuseAll").addEventListener("click", async () => {
    document.getElementById("horsRefuseAll").disabled = true;
    addNotif(`Refus total: ${lbl}…`, "info");
    try {
      await rpcController.refuseAllHors(baseUrl, wizModel, wizardId);
      _afterAcceptHors(workerId, _ck);
      addNotif(`✓ Tous refusés: ${lbl}`, "success");
      modal?.remove();
    } catch (err) {
      document.getElementById("horsRefuseAll").disabled = false;
      addNotif(`Erreur: ${err.message}`, "error");
    }
  });

  // ── bind أزرار الزبائن ──────────────────────────────────
  body.querySelectorAll(".hors-accept-btn").forEach(b => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      acceptOne(Number(b.dataset.lid));
    });
  });
  body.querySelectorAll(".hors-refuse-btn").forEach(b => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      refuseOne(Number(b.dataset.lid));
    });
  });
}


async function fetchEMBOnly() {
  const baseUrl = getOdooBase();
  if (!baseUrl) { addNotif("URL Odoo non configurée", "error"); return; }
  const prevWorkers = allWorkers().filter(w => w.role === "prevente");
  const livWorkers  = allWorkers().filter(w => w.role === "livraison");
  const mrWorkers   = allWorkers().filter(w => w.role === "merch" || w.role === "recouvrement");
  if (!prevWorkers.length && !livWorkers.length && !mrWorkers.length) { addNotif("Aucune entrée configurée", "warning"); return; }
  addNotif("Récupération EMB (C/F)…", "info");
  await Promise.all([
    prevWorkers.length ? rpcController.fetchEMB(prevWorkers, baseUrl, "prevente",  0) : Promise.resolve(),
    livWorkers.length  ? rpcController.fetchEMB(livWorkers,  baseUrl, "livraison", 0) : Promise.resolve(),
    livWorkers.length  ? rpcController.fetchEMB(livWorkers,  baseUrl, "livraison", 1) : Promise.resolve(),
    mrWorkers.length   ? rpcController.fetchEMB(mrWorkers,   baseUrl, "mr",        0) : Promise.resolve(),
  ]).catch(() => {});
  addNotif("EMB mis à jour ✓", "success");
}

function clearCurrentMode() {
  const workers = modeWorkers();
  if (!workers.length) { addNotif("Rien à effacer", "info"); return; }
  if (!confirm(`Effacer tous les liens ${MODE_CFG[App.currentMode]?.label} pour ${getDateKey(App.currentDateOffset)}?`)) return;
  const dateKey = getDateKey(App.currentDateOffset);
  const _modeC  = App.currentMode;
  const workerIds = new Set(workers.map(w => w.id));

  // مسح فقط بيانات العمّال المنتمين للـ mode الحالي
  workerIds.forEach(id => {
    delete App.allLinks[id];
    delete App.allRefs[id];
    delete App.allStats[id];
  });

  Storage.getMany(["vendorLinks","vendorStats","vendorRefs"]).then(cur => {
    const links = cur.vendorLinks||{}; if (!links[dateKey]) links[dateKey]={}; if (!links[dateKey][_modeC]) links[dateKey][_modeC]={};
    const stats = cur.vendorStats||{}; if (!stats[dateKey]) stats[dateKey]={}; if (!stats[dateKey][_modeC]) stats[dateKey][_modeC]={};
    const refs  = cur.vendorRefs ||{}; if (!refs[dateKey])  refs[dateKey]={};  if (!refs[dateKey][_modeC])  refs[dateKey][_modeC]={};
    // مسح فقط مفاتيح العمّال الخاصة بهذا الـ mode في storage
    workerIds.forEach(id => {
      delete links[dateKey][_modeC][id];
      delete stats[dateKey][_modeC][id];
      delete refs[dateKey][_modeC][id];
    });
    Storage.setMany({ vendorLinks: links, vendorStats: stats, vendorRefs: refs });
  });

  const _ck = _cacheKey();
  if (_contextCache[_ck]) {
    workerIds.forEach(id => {
      delete _contextCache[_ck].links[id];
      delete _contextCache[_ck].stats[id];
      delete _contextCache[_ck].refs[id];
    });
  }
  renderVendors();
  addNotif(`${MODE_CFG[_modeC]?.label} effacé`, "warning");
}

function closeAllOrange() {
  const baseUrl = getOdooBase();
  if (!baseUrl) { addNotif("URL non configurée", "error"); return; }
  const workers = modeWorkers().filter(w => {
    const odooState  = (App.allOdooState  || {})[w.id];
    const userStatus = (App.allUserStatus || {})[w.id];
    return odooState === "open" && userStatus === "close_day";
  });
  if (!workers.length) { addNotif("Aucune tournée orange", "info"); return; }
  const roundIds = workers.map(w => App.allStats[w.id]?.roundId).filter(Boolean);
  if (!roundIds.length) { addNotif("Round IDs introuvables", "error"); return; }
  const btn = document.getElementById("btnCloseAll");
  if (btn) { btn.disabled = true; btn.textContent = "Fermeture…"; }
  addNotif(`Fermeture de ${workers.length} tournée(s)…`, "info");
  rpcController.closeAllPlannings(baseUrl, roundIds)
    .then(() => {
      if (btn) { btn.disabled = false; btn.textContent = "Fermer tout"; }
      workers.forEach(w => updateCacheForContext(_cacheKey(), { odooState: { [w.id]: "closed" }, roundStatus: { [w.id]: "closed" } }));
      const _ck = _cacheKey();
      App.allRoundStatus = { ..._contextCache[_ck].roundStatus };
      App.allOdooState   = { ..._contextCache[_ck].odooState };
      addNotif(`✓ ${workers.length} tournée(s) fermée(s)`, "success");
      renderVendors(); updateCloseAllBtn();
    })
    .catch(err => {
      if (btn) { btn.disabled = false; btn.textContent = "Fermer tout"; }
      addNotif("Erreur fermeture: " + err.message, "error");
    });
}

function updateCloseAllBtn() {
  const btn = document.getElementById("btnCloseAll");
  if (!btn) return;
  const hasOrange = modeWorkers().some(w => {
    return (App.allOdooState||{})[w.id] === "open" && (App.allUserStatus||{})[w.id] === "close_day";
  });
  btn.style.display = hasOrange ? "flex" : "none";
}

const _DB_KEY = "wafa_dashboard_state"; // { hidden, width }

function _dbLoadState() {
  try { return JSON.parse(localStorage.getItem(_DB_KEY) || "{}"); } catch(_) { return {}; }
}
function _dbSaveState(patch) {
  const cur = _dbLoadState();
  localStorage.setItem(_DB_KEY, JSON.stringify({ ...cur, ...patch }));
}

function updateDashboardVisibility() {
  const panel  = document.getElementById("dashboardPanel");
  const handle = document.getElementById("dbResizeHandle");
  if (!panel) return;

  const cols  = App.settings?.cols  || 0;
  const cardW = App.settings?.cardWidth ?? 380;
  const cardsMinW = cols > 0 ? cols * cardW : cardW;
  const available = window.innerWidth;

  const state = _dbLoadState();
  const userHidden = state.hidden === true;
  const userWidth  = state.width  || null;

  // حساب الحالة التلقائية بناءً على العرض
  const canNormal  = available >= cardsMinW + 280 + 24;
  const canCompact = available >= cardsMinW + 60  + 24;

  let autoState = "hidden";
  if (canNormal)       autoState = "normal";
  else if (canCompact) autoState = "compact";

  // إذا المستخدم أخفاه يدوياً → مخفي دائماً (حتى لو الشاشة تتسع)
  // إذا الشاشة لا تتسع → مخفي بغض النظر عن رغبة المستخدم
  const finalState = (userHidden || autoState === "hidden") ? "hidden"
                   : autoState === "compact"               ? "compact"
                   :                                         "normal";

  panel.classList.remove("db--normal", "db--compact");

  if (finalState === "hidden") {
    panel.style.display = "none";
    if (handle) handle.classList.remove("db--visible");
    document.getElementById("app").style.paddingRight = "";
    const btnShow = document.getElementById("btnShowDashboard");
    if (btnShow) btnShow.style.display = canNormal || canCompact ? "flex" : "none";
    return;
  }

panel.style.display = "flex";
  // تأكد أن width مضبوطة دائماً على العنصر مباشرة
  const savedW = _dbLoadState().width;
  const defaultW = finalState === "compact" ? 60 : 280;
  const panelW = (savedW && savedW >= 180 && savedW <= 600) ? savedW : defaultW;
  if (!panel.style.width) panel.style.width = panelW + "px";
  const actualW = parseInt(panel.style.width) || panelW;
  if (handle) {
    handle.classList.add("db--visible");
    handle.style.right = actualW + "px";
  }
  document.getElementById("app").style.paddingRight = actualW + "px";
  const btnShow = document.getElementById("btnShowDashboard");
  if (btnShow) btnShow.style.display = "none";

  if (finalState === "compact") {
    panel.classList.add("db--compact");
    panel.style.width = "";
  } else {
    panel.classList.add("db--normal");
    // تطبيق العرض المخصص إذا وجد (من السحب)
    if (userWidth && userWidth >= 180 && userWidth <= 600) {
      panel.style.width = userWidth + "px";
    } else {
      panel.style.width = "";
    }
  }
}

function renderDashboard() {
  const el = document.getElementById("dashboardContent");
  if (!el) return;

  const workers = allWorkers();
  const prevW   = workers.filter(w => w.role === "prevente");
  const livW    = workers.filter(w => w.role === "livraison");

  // جلب stats من cache لكلا الـ mode بغض النظر عن الـ mode الحالي
  const todayKey = getDateKey(0);
  const ckPrev   = "prevente_"  + todayKey;
  const ckLiv    = "livraison_" + todayKey;

  const needPrev = !_contextCache[ckPrev]?.stats || !Object.keys(_contextCache[ckPrev].stats).length;
  const needLiv  = !_contextCache[ckLiv]?.stats  || !Object.keys(_contextCache[ckLiv].stats).length;

  if (needPrev || needLiv) {
    Storage.getMany(["vendorStats"]).then(raw => {
      const statsDay = (raw.vendorStats || {})[todayKey] || {};
      // نحدّث الـ cache فقط إذا في البيانات شيء — نتجنب loop لا نهائي
      let updated = false;
      if (needPrev && statsDay.prevente  && Object.keys(statsDay.prevente).length)  { updateCacheForContext(ckPrev, { stats: statsDay.prevente });  updated = true; }
      if (needLiv  && statsDay.livraison && Object.keys(statsDay.livraison).length) { updateCacheForContext(ckLiv,  { stats: statsDay.livraison }); updated = true; }
      if (updated) renderDashboard();
      // إذا لا بيانات — نرسم بما هو متاح بدون loop
      else {
        const el2 = document.getElementById("dashboardContent");
        if (el2 && !el2.innerHTML) el2.innerHTML = `<div style="color:var(--text3);font-size:11px;padding:12px">Aucune donnée aujourd'hui</div>`;
      }
    });
    return;
  }

  const statsPrev = _contextCache[ckPrev]?.stats || {};
  const statsLiv  = _contextCache[ckLiv]?.stats  || {};

  function calcCard(list, statsMap) {
    let totalP = 0, totalV = 0, totalS = 0, totalCA = 0;
    let countP = 0, countV = 0, countS = 0, countCA = 0;
    let totalVcount = 0, totalScount = 0;
    list.forEach(w => {
      const st = statsMap[w.id];
      if (!st) return;
      if (st.totalClients != null) { totalP += st.totalClients; countP++; }
      if (st.visitRate    != null && st.totalClients != null) {
        totalV += st.visitRate; countV++;
        totalVcount += Math.round(st.visitRate / 100 * st.totalClients);
      }
      if (st.successRate  != null && st.totalClients != null) {
        totalS += st.successRate; countS++;
        totalScount += Math.round(st.successRate / 100 * st.totalClients);
      }
      if (st.ca != null) { totalCA += st.ca; countCA++; }
    });
    return {
      P:       countP  ? totalP                        : null,
      V:       countV  ? (totalV / countV).toFixed(1)  : null,
      Vcount:  countV  ? totalVcount                   : null,
      S:       countS  ? (totalS / countS).toFixed(1)  : null,
      Scount:  countS  ? totalScount                   : null,
      CA:      countCA ? totalCA                       : null,
    };
  }

  const prev = calcCard(prevW, statsPrev);
  const liv  = calcCard(livW,  statsLiv);

  function mkCard(title, color, data, icon) {
    const pHtml  = data.P  != null ? `<div class="dbc-stat"><span class="dbc-key">P</span><span class="dbc-val">${data.P}</span></div>` : "";
    const vHtml  = data.V  != null ? `<div class="dbc-stat"><span class="dbc-key" style="color:#16a34a">V</span><span class="dbc-val">${data.V}%</span><span class="dbc-sub">${data.Vcount}</span></div>` : "";
    const sHtml  = data.S  != null ? `<div class="dbc-stat"><span class="dbc-key" style="color:#d97706">S</span><span class="dbc-val">${data.S}%</span><span class="dbc-sub">${data.Scount}</span></div>` : "";
    const caHtml = data.CA != null ? `<div class="dbc-ca"><span class="dbc-ca-label">CA</span><span class="dbc-ca-val">${formatCa(data.CA)}</span></div>` : "";
    return `
      <div class="dbc-card">
        <div class="dbc-header" style="border-left:3px solid ${color}">
          ${icon}
          <span class="dbc-title">${title}</span>
        </div>
        <div class="dbc-stats-row">${pHtml}${vHtml}${sHtml}</div>
        ${caHtml}
      </div>`;
  }

  function mkTable(prevWorkers, livWorkers, statsP, statsL) {
    const states = [
      { key: "green",  dot: "#22c55e", label: "En cours"  },
      { key: "orange", dot: "#f59e0b", label: "Fermé vend." },
      { key: "grey",   dot: "#94a3b8", label: "Tournée ferm." },
      { key: "h",      dot: null,      label: "Hors route" },
    ];

    function getStateKey(w, statsMap) {
      const st  = statsMap[w.id] || {};
      const os  = (App.currentMode === "prevente" ? _contextCache[ckPrev] : _contextCache[ckLiv])?.odooState?.[w.id]
                  || st.odooState || null;
      const us  = (App.currentMode === "prevente" ? _contextCache[ckPrev] : _contextCache[ckLiv])?.userStatus?.[w.id]
                  || st.userStatus || null;
      const odooStatePrev = _contextCache[ckPrev]?.odooState?.[w.id] || null;
      const userStatPrev  = _contextCache[ckPrev]?.userStatus?.[w.id] || null;
      const odooStateLiv  = _contextCache[ckLiv]?.odooState?.[w.id]  || null;
      const userStatLiv   = _contextCache[ckLiv]?.userStatus?.[w.id] || null;

      const getKey = (odooState, userStatus, stats) => {
        if (stats?.horsRoute) return "h";
        if (stats?.pendingBLs > 0) return "a";
        if (!odooState)                                         return null;
        if (odooState === "open" && userStatus === "open_day")  return "green";
        if (odooState === "open" && userStatus === "close_day") return "orange";
        if (odooState === "closed")                             return "grey";
        return null;
      };

      if (prevWorkers.find(x => x.id === w.id))
        return getKey(odooStatePrev, userStatPrev, statsP[w.id]);
      return getKey(odooStateLiv, userStatLiv, statsL[w.id]);
    }

    function getKeyForMode(w, odooStateMap, userStatusMap, statsMap) {
      const st = statsMap[w.id] || {};
      if (st.horsRoute) return "h";
      if (st.pendingBLs > 0) return "a";
      const os = odooStateMap?.[w.id] || null;
      const us = userStatusMap?.[w.id] || null;
      if (!os) return null;
      if (os === "open" && us === "open_day")  return "green";
      if (os === "open" && us === "close_day") return "orange";
      if (os === "closed")                     return "grey";
      return null;
    }

    const odooP = _contextCache[ckPrev]?.odooState  || {};
    const userP = _contextCache[ckPrev]?.userStatus || {};
    const odooL = _contextCache[ckLiv]?.odooState   || {};
    const userL = _contextCache[ckLiv]?.userStatus  || {};

    // تجميع البائعين حسب الحالة لكل mode
    function groupByState(workers, odooMap, userMap, statsMap) {
      const groups = { a: [], green: [], orange: [], grey: [], h: [] };
      workers.forEach(w => {
        const k = getKeyForMode(w, odooMap, userMap, statsMap);
        if (k && groups[k]) groups[k].push(w.label || w.name);
      });
      return groups;
    }

    const gP = groupByState(prevWorkers, odooP, userP, statsPrev);
    const gL = groupByState(livWorkers,  odooL, userL, statsLiv);

    const allKeys = ["a", "green", "orange", "grey", "h"];
    const dotHtml = {
      a:      `<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:#f59e0b;font-size:8px;font-weight:800;color:#fff;flex-shrink:0">A</span>`,
      green:  `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#22c55e;flex-shrink:0"></span>`,
      orange: `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#f59e0b;flex-shrink:0"></span>`,
      grey:   `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#94a3b8;flex-shrink:0"></span>`,
      h:      `<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:#e2e8f0;font-size:8px;font-weight:800;color:#475569;flex-shrink:0">H</span>`,
    };

    const hasAny = allKeys.some(k => gP[k].length || gL[k].length);
    if (!hasAny) return "";

    const mkNames = (arr) => {
      if (!arr.length) return "";
      const count = `<span class="dbt-names-header">${arr.length}</span>`;
      const names = arr.map(n =>
        `<span style="white-space:nowrap">${n}</span>`
      ).join(` <span style="color:var(--text3);font-size:9px">|</span> `);
      return count + names;
    };

    let rows = "";
    allKeys.forEach(k => {
      if (!gP[k].length && !gL[k].length) return;
      rows += `
        <tr>
          <td class="dbt-dot">${dotHtml[k]}</td>
          <td class="dbt-names">${mkNames(gP[k])}</td>
          <td class="dbt-names">${mkNames(gL[k])}</td>
        </tr>`;
    });

    return `
      <div class="dbt-wrap">
        <table class="dbt-table">
          <thead>
            <tr>
              <th class="dbt-dot"></th>
              <th class="dbt-names" style="color:var(--prev-color);text-align:left;padding:5px 6px">PRÉVENTE</th>
              <th class="dbt-names" style="color:var(--liv-color);text-align:left;padding:5px 6px">LIVRAISON</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  const svgPrev = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="${'var(--prev-color)'}" stroke-width="2"><path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>`;
  const svgLiv  = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="${'var(--liv-color)'}" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`;

  el.innerHTML =
    mkCard("PRÉVENTE",  "var(--prev-color)", prev, svgPrev) +
    mkCard("LIVRAISON", "var(--liv-color)",  liv,  svgLiv)  +
    mkTable(prevW, livW, statsPrev, statsLiv);
}

function _dbBindControls() {
  // زر الإخفاء
  document.getElementById("dbBtnHide")?.addEventListener("click", () => {
    _dbSaveState({ hidden: true });
    updateDashboardVisibility();
  });

  // السحب لتغيير العرض
  const handle = document.getElementById("dbResizeHandle");
  const panel  = document.getElementById("dashboardPanel");
  if (!handle || !panel) return;

  let _dragging = false, _startX = 0, _startW = 0;

  handle.addEventListener("pointerdown", e => {
    _dragging = true;
    _startX   = e.clientX;
    _startW   = panel.offsetWidth;
    handle.classList.add("db-resize-handle--active");
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  handle.addEventListener("pointermove", e => {
    if (!_dragging) return;
    // السحب لليسار يوسع، لليمين يضيق
    const delta = _startX - e.clientX;
    const newW = Math.min(600, Math.max(180, _startW + delta));
    panel.style.width = newW + "px";
    handle.style.right = newW + "px";
    document.getElementById("app").style.paddingRight = newW + "px";
  });

  handle.addEventListener("pointerup", e => {
    if (!_dragging) return;
    _dragging = false;
    handle.classList.remove("db-resize-handle--active");
    _dbSaveState({ width: panel.offsetWidth, hidden: false });
  });

  handle.addEventListener("pointercancel", () => {
    _dragging = false;
    handle.classList.remove("db-resize-handle--active");
  });

  // في الحالة compact، نقرة على الـ topbar تُظهر بالعرض الكامل
  panel.querySelector(".db-topbar")?.addEventListener("click", e => {
    if (!panel.classList.contains("db--compact")) return;
    _dbSaveState({ hidden: false });
    updateDashboardVisibility();
  });
}
// ── GDS Stock View ────────────────────────────────────────────
const GDS_WAREHOUSE_ID = 213;
const GDS_COLLAPSED_KEY = "wafa_gds_collapsed";
const GDS_VANS_COLLAPSED_KEY = "wafa_gds_vans_collapsed";
const GDS_VAN_LOCATION_PARENT = 212; // غيّر هذا إلى ID المجلد الأب لمواقع الفانات في Odoo

function _gdsGetCollapsed() {
  try { return JSON.parse(localStorage.getItem(GDS_COLLAPSED_KEY) || "{}"); } catch(_) { return {}; }
}
function _gdsSetCollapsed(obj) {
  try { localStorage.setItem(GDS_COLLAPSED_KEY, JSON.stringify(obj)); } catch(_) {}
}
function gdsToggleCategory(cat) {
  const collapsed = _gdsGetCollapsed();
  collapsed[cat] = !collapsed[cat];
  _gdsSetCollapsed(collapsed);
  // toggle DOM بدون re-render
  const safeId = CSS.escape(cat);
  const body   = document.getElementById("gdsbody_" + cat);
  const arrow  = document.getElementById("gdsarrow_" + cat);
  if (body)  body.style.display  = collapsed[cat] ? "none" : "";
  if (arrow) arrow.style.transform = collapsed[cat] ? "rotate(-90deg)" : "";
}
function gdsExpandAll() {
  _gdsSetCollapsed({});
  document.querySelectorAll("[id^='gdsbody_']").forEach(el => el.style.display = "");
  document.querySelectorAll("[id^='gdsarrow_']").forEach(el => el.style.transform = "");
}

function gdsCollapseAll() {
  const collapsed = {};
  document.querySelectorAll("[id^='gdsbody_']").forEach(el => {
    el.style.display = "none";
    const cat = el.id.replace("gdsbody_", "");
    collapsed[cat] = true;
  });
  document.querySelectorAll("[id^='gdsarrow_']").forEach(el => el.style.transform = "rotate(-90deg)");
  _gdsSetCollapsed(collapsed);
}
function _gdsVansGetCollapsed() {
  try { return JSON.parse(localStorage.getItem(GDS_VANS_COLLAPSED_KEY) || "{}"); } catch(_) { return {}; }
}
function _gdsVansSetCollapsed(obj) {
  try { localStorage.setItem(GDS_VANS_COLLAPSED_KEY, JSON.stringify(obj)); } catch(_) {}
}
function gdsVansToggleVan(vanId) {
  const collapsed = _gdsVansGetCollapsed();
  collapsed[vanId] = !collapsed[vanId];
  _gdsVansSetCollapsed(collapsed);
  const body  = document.getElementById("gdsvanbody_" + vanId);
  const arrow = document.getElementById("gdsvanarrow_" + vanId);
  if (body)  body.style.display    = collapsed[vanId] ? "none" : "";
  if (arrow) arrow.style.transform = collapsed[vanId] ? "rotate(-90deg)" : "";
}
function gdsVansExpandAll() {
  _gdsVansSetCollapsed({});
  document.querySelectorAll("[id^='gdsvanbody_']").forEach(el => el.style.display = "");
  document.querySelectorAll("[id^='gdsvanarrow_']").forEach(el => el.style.transform = "");
}
function gdsVansCollapseAll() {
  const collapsed = {};
  document.querySelectorAll("[id^='gdsvanbody_']").forEach(el => {
    el.style.display = "none";
    const id = el.id.replace("gdsvanbody_", "");
    collapsed[id] = true;
  });
  document.querySelectorAll("[id^='gdsvanarrow_']").forEach(el => el.style.transform = "rotate(-90deg)");
  _gdsVansSetCollapsed(collapsed);
}

const _gdsTransfertsFilters = {
  states: [],      // [] = الكل
  date: new Date().toISOString().slice(0,10),  // تاريخ اليوم افتراضياً
  limit: 20,
};

async function renderGdsTransferts() {
  const el = document.getElementById("gdsTransfertsContent");
  if (!el) return;
  el.innerHTML = `<div class="gds-refresh-bar">
    <button class="gds-refresh-btn" onclick="renderGdsTransferts()">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/>
      </svg>
      Actualiser
    </button>
    <span class="gds-last-updated">Chargement des transferts…</span>
  </div>
  <div class="gds-loading">Recherche des transferts…</div>`;

  try {
    // ── شريط الفلاتر ─────────────────────────────────
    const allStates = [
      { key: "draft",     label: "Brouillon",  color: "#94a3b8" },
      { key: "waiting",   label: "En attente", color: "#f59e0b" },
      { key: "confirmed", label: "Confirmé",   color: "#3b82f6" },
      { key: "assigned",  label: "Prêt",       color: "#8b5cf6" },
      { key: "done",      label: "Validé",     color: "#22c55e" },
    ];

    const f = _gdsTransfertsFilters;

    const stateBtns = allStates.map(s => {
      const active = f.states.includes(s.key);
      return `<button class="gds-tr-filter-btn ${active ? "gds-tr-filter-btn--active" : ""}"
        style="${active ? `background:${s.color}22;border-color:${s.color};color:${s.color}` : ""}"
        onclick="_gdsTrToggleState('${s.key}')">
        ${s.label}
      </button>`;
    }).join("");

    const dateVal = f.date || "";

    el.innerHTML = `<div class="gds-tr-filters" style="position:sticky;top:0;z-index:10;background:var(--bg2,#1e2336);">
      <div class="gds-tr-filter-row">
        <span class="gds-tr-filter-label">État</span>
        <div class="gds-tr-filter-states">${stateBtns}</div>
      </div>
      <div class="gds-tr-filter-row">
        <span class="gds-tr-filter-label">Date</span>
        <input type="text" id="gdsTrDateInput" class="gds-tr-date-input"
          placeholder="jj/mm/aaaa"
          value="${dateVal ? dateVal.split('-').reverse().join('/') : ''}"
          readonly style="cursor:pointer;min-width:110px;"/>
        ${dateVal ? `<button class="gds-tr-clear-date" onclick="_gdsTrSetDate(null)">✕</button>` : ""}
        <span class="gds-tr-filter-label" style="margin-left:12px">Max</span>
        <input type="number" class="gds-tr-limit-input" min="1" max="500" value="${f.limit}"
          onchange="_gdsTrSetLimit(this.value)"/>
      </div>
    </div>
    <div class="gds-loading">Chargement…</div>`;
    _gdsTrInitDatePicker(f.date);
    const resLoc = await fetch("/api/web/dataset/call_kw", {
      method: "POST", credentials: "include",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        jsonrpc:"2.0", method:"call", id:20,
        params: {
          model: "stock.location",
          method: "search_read",
          args: [[["location_id","=",GDS_VAN_LOCATION_PARENT],["usage","=","internal"]]],
          kwargs: { fields: ["id","name"], limit: 100 }
        }
      })
    });
    const locData = await resLoc.json();
    const vanIds = (locData?.result || []).map(l => l.id);
    const allIds = [...vanIds, GDS_WAREHOUSE_ID];

    // جلب التحويلات
    const resPick = await fetch("/api/web/dataset/call_kw", {
      method: "POST", credentials: "include",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        jsonrpc:"2.0", method:"call", id:21,
        params: {
          model: "stock.picking",
          method: "search_read",
          args: [(() => {
            const domain = [
              ["state","not in",["cancel"]],
              ["location_id","in",allIds],
              ["location_dest_id","in",allIds],
            ];
            if (f.states.length) domain.push(["state","in",f.states]);
            if (f.date) {
              domain.push(["scheduled_date",">=", f.date + " 00:00:00"]);
              domain.push(["scheduled_date","<=", f.date + " 23:59:59"]);
            }
            return domain;
          })()],
          kwargs: {
            fields: ["id","name","location_id","location_dest_id","partner_id","scheduled_date","state"],
            limit: f.limit,
            order: "id desc"
          }
        }
      })
    });
    const pickData = await resPick.json();
    const transfers = pickData?.result || [];

    const stateLabel = {
      draft:       { label: "Brouillon",  color: "#94a3b8" },
      waiting:     { label: "En attente", color: "#f59e0b" },
      confirmed:   { label: "Confirmé",   color: "#3b82f6" },
      assigned:    { label: "Prêt",       color: "#8b5cf6" },
      done:        { label: "Validé",     color: "#22c55e" },
    };

    const now = new Date().toLocaleTimeString("fr-FR");

    let rows = "";
    transfers.forEach(t => {
      const st    = stateLabel[t.state] || { label: t.state, color: "#94a3b8" };
      const date  = t.scheduled_date ? t.scheduled_date.slice(0,16).replace("T"," ") : "—";
      const from  = t.location_id      ? t.location_id[1].split("/").pop().trim()      : "—";
      const to    = t.location_dest_id ? t.location_dest_id[1].split("/").pop().trim() : "—";
      const partner = t.partner_id     ? t.partner_id[1]                               : "—";
      rows += `<tr>
        <td><span class="gds-tr-ref">${escHtml(t.name)}</span></td>
        <td>${escHtml(from)}</td>
        <td>${escHtml(to)}</td>
        <td style="color:var(--text2)">${escHtml(partner)}</td>
        <td style="color:var(--text3)">${date}</td>
        <td><span class="gds-tr-state" style="background:${st.color}20;color:${st.color}">${st.label}</span></td>
        <td style="display:flex;gap:4px;align-items:center;">
          <button class="gds-refresh-btn" onclick="window.open((getOdooBase()||'')+'/web#id=${t.id}&action=233&active_id=76&model=stock.picking&view_type=form&cids=1&menu_id=115','_blank')" style="padding:2px 8px;">↗</button>
          <button class="gds-refresh-btn" style="padding:2px 8px;background:var(--bg3);color:var(--text);" onclick="gdsShowPickingDetail(${t.id},'${escHtml(t.name)}')">☰</button>
        </td>
      </tr>`;
    });

    const filtersHtml = el.querySelector(".gds-tr-filters")?.outerHTML || "";
    // سيُعاد تهيئة picker بعد inject

    if (!rows) {
      el.innerHTML = filtersHtml + `<div class="gds-loading" style="position:sticky;top:0;">Aucun transfert trouvé.</div>`;
	        _gdsTrInitDatePicker(f.date);

      return;
    }

    el.innerHTML = filtersHtml + `<div class="gds-refresh-bar" style="position:sticky;top:0;z-index:9;background:var(--bg2,#1e2336);">
      <button class="gds-refresh-btn" onclick="renderGdsTransferts()">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/>
        </svg>
        Actualiser
      </button>
      <span class="gds-last-updated">Mis à jour : ${now} — ${transfers.length} transfert(s)</span>
    </div>
    <div style="overflow-x:auto">
      <table class="gds-table gds-tr-table">
        <thead><tr>
          <th>Référence</th>
          <th>De</th>
          <th>Vers</th>
          <th>Contact</th>
          <th>Date</th>
          <th>État</th>
          <th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
   </div>`;
    _gdsTrInitDatePicker(f.date);

  } catch(e) {
    el.innerHTML = `<div class="gds-loading" style="color:var(--danger)">Erreur: ${e.message}</div>`;
  }
}
async function gdsShowPickingDetail(pickingId, pickingName) {
  // إنشاء modal
  let modal = document.getElementById("gds-picking-detail-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "gds-picking-detail-modal";
    modal.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;";
    modal.innerHTML = `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;width:90%;max-width:600px;max-height:80vh;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);">
        <span id="gds-pd-title" style="font-weight:600;font-size:13px;"></span>
        <button onclick="document.getElementById('gds-picking-detail-modal').remove()" style="background:none;border:none;cursor:pointer;font-size:16px;color:var(--text2);">✕</button>
      </div>
      <div id="gds-pd-body" style="overflow-y:auto;padding:10px 14px;"></div>
    </div>`;
    document.body.appendChild(modal);
  }

  document.getElementById("gds-pd-title").textContent = pickingName;
  document.getElementById("gds-pd-body").innerHTML = `<div style="color:var(--text2);text-align:center;padding:20px;">Chargement…</div>`;
  modal.style.display = "flex";

  try {
    const baseUrl = getOdooBase() || "";
    const res = await fetch(`/api/web/dataset/call_kw`, {
      method: "POST",
      credentials: "include",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        jsonrpc:"2.0", method:"call", id:99,
        params: {
          model: "stock.move",
          method: "search_read",
          args: [[["picking_id","=",pickingId],["state","!=","cancel"]]],
          kwargs: {
            fields: ["product_id","product_uom_qty"],
            limit: 200
          }
        }
      })
    });
    const data = await res.json();
    const moves = data?.result || [];

    if (!moves.length) {
      document.getElementById("gds-pd-body").innerHTML = `<div style="color:var(--text2);text-align:center;padding:20px;">Aucun produit.</div>`;
      return;
    }

    const cartonSize = (m) => m.product_uom?.[1]?.includes("Carton") ? 1 : null;

    let html = `<table class="gds-table" style="width:100%">
      <thead><tr>
        <th>Produit</th>
        <th style="text-align:right">C/F</th>
        <th style="text-align:right">U</th>
      </tr></thead><tbody>`;

    // جلب packaging لكل product
    const productIds = [...new Set(moves.map(m => m.product_id?.[0]).filter(Boolean))];
    const resPkg = await fetch(`/api/web/dataset/call_kw`, {
      method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:100, params:{
        model:"product.packaging", method:"search_read",
        args:[[["product_id","in",productIds]]],
        kwargs:{ fields:["product_id","qty"], limit:1000 }
      }})
    });
    const pkgData = await resPkg.json();
    const pkgMap = {};
    (pkgData?.result || []).forEach(p => { pkgMap[p.product_id[0]] = p.qty || 0; });
	const dupProducts = new Set();
    const seenProducts = new Set();
    moves.forEach(m => {
      const pid = m.product_id?.[0];
      if (seenProducts.has(pid)) dupProducts.add(pid);
      seenProducts.add(pid);
    });

    moves.forEach(m => {
      const name = m.product_id?.[1] || "—";
      const pid = m.product_id?.[0];
      const qty = m.product_uom_qty || 0;
      const pkgQty = pkgMap[pid] || 0;
      const cf = pkgQty > 0 ? Math.floor(qty / pkgQty) : "—";
      const u = pkgQty > 0 ? Math.round(qty % pkgQty) : qty;
      html += `<tr style="${dupProducts.has(pid) ? 'background:var(--bg3);' : ''}">
        <td>${escHtml(productLabel(name))}</td>
        <td style="text-align:right">${cf}</td>
        <td style="text-align:right">${u}</td>
      </tr>`;
    });

    html += `</tbody></table>`;
    document.getElementById("gds-pd-body").innerHTML = html;

  } catch(e) {
    document.getElementById("gds-pd-body").innerHTML = `<div style="color:var(--danger)">Erreur: ${e.message}</div>`;
  }
}
function _gdsTrToggleState(key) {
  const f = _gdsTransfertsFilters;
  const i = f.states.indexOf(key);
  if (i === -1) f.states.push(key);
  else f.states.splice(i, 1);
  renderGdsTransferts();
}
function _gdsTrSetDate(val) {
  _gdsTransfertsFilters.date = val || null;
  renderGdsTransferts();
}

function _gdsTrInitDatePicker(currentVal) {
  function _load(cb) {
    if (window.flatpickr) { cb(); return; }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css";
    document.head.appendChild(link);
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/flatpickr";
    s.onload = cb;
    document.head.appendChild(s);
  }
  _load(() => {
    const el = document.getElementById("gdsTrDateInput");
    if (!el || el._flatpickr) return;
    flatpickr(el, {
      dateFormat: "d/m/Y",
      allowInput: false,
      locale: { firstDayOfWeek: 1 },
      defaultDate: currentVal ? (() => {
        const [y,m,d] = currentVal.split("-");
        return new Date(+y, +m-1, +d);
      })() : null,
      onChange: ([date]) => {
        if (!date) return;
        const y = date.getFullYear();
        const m = String(date.getMonth()+1).padStart(2,"0");
        const d = String(date.getDate()).padStart(2,"0");
        _gdsTrSetDate(`${y}-${m}-${d}`);
      }
    });
  });
}
function _gdsTrSetLimit(val) {
  const n = Math.min(500, Math.max(1, parseInt(val) || 100));
  _gdsTransfertsFilters.limit = n;
  renderGdsTransferts();
}
async function renderGdsStock() {
  const el = document.getElementById("gdsContent");
  if (!el) return;
  el.innerHTML = `<div class="gds-refresh-bar" style="position:sticky;top:0;z-index:11;background:var(--bg2,#1e2336);">
    <button class="gds-refresh-btn" onclick="renderGdsStock()">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/>
      </svg>
      Actualiser
    </button>
    <span class="gds-last-updated" id="gdsLastUpdated">Chargement…</span>
  </div>
  <div class="gds-loading">Chargement du stock…</div>`;

  try {
    const res = await fetch("/api/web/dataset/call_kw", {
      method: "POST", credentials: "include",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        jsonrpc:"2.0", method:"call", id:1,
        params: {
          model: "stock.quant",
          method: "search_read",
          args: [[["location_id","=",GDS_WAREHOUSE_ID],["quantity",">",0]]],
          kwargs: {
            fields: ["product_id","quantity","reserved_quantity","packaging_quantity_1","packaging_quantity_2"],
            limit: 2000,
          }
        }
      })
    });
    const data = await res.json();
    const quants = data?.result || [];

    const productIds = [...new Set(quants.map(q => q.product_id[0]))];
    const res2 = await fetch("/api/web/dataset/call_kw", {
      method: "POST", credentials: "include",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        jsonrpc:"2.0", method:"call", id:2,
        params: {
          model: "product.product",
          method: "search_read",
          args: [[["id","in",productIds]]],
          kwargs: { fields: ["id","name","categ_id","uom_id","uom_po_id"], limit: 2000 }
        }
      })
    });
    const data2 = await res2.json();
    const products = {};
    (data2?.result || []).forEach(p => { products[p.id] = p; });

    const stockMap = {};
    quants.forEach(q => {
      const pid = q.product_id[0];
      if (!stockMap[pid]) stockMap[pid] = { qty: 0, carton: 0, reserved: 0, unitSize: 0 };
      const unitSize = q.packaging_quantity_1 > 0 ? q.quantity / q.packaging_quantity_1 : 0;
      stockMap[pid].qty      += q.quantity;
      stockMap[pid].carton   += q.packaging_quantity_1 || 0;
      stockMap[pid].reserved += q.reserved_quantity || 0;
      if (unitSize > 0) stockMap[pid].unitSize = unitSize;
    });

    const byCategory = {};
    Object.entries(stockMap).forEach(([pid, s]) => {
      const p = products[pid];
      if (!p) return;
      const catName = p.categ_id ? p.categ_id[1] : "Autre";
      if (!byCategory[catName]) byCategory[catName] = [];
      byCategory[catName].push({ name: p.name, qty: stockMap[pid].qty, carton: stockMap[pid].carton, reserved: stockMap[pid].reserved, unitSize: stockMap[pid].unitSize });
    });

    const now        = new Date().toLocaleTimeString("fr-FR");
    const sortedCats = Object.keys(byCategory).sort();
    const collapsed  = _gdsGetCollapsed();

    let html = `<div class="gds-refresh-bar">
      <button class="gds-refresh-btn" onclick="renderGdsStock()">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/>
        </svg>
        Actualiser
      </button>
      <button class="gds-refresh-btn" onclick="gdsExpandAll()">▼ Tout ouvrir</button>
      <button class="gds-refresh-btn" onclick="gdsCollapseAll()">▲ Tout fermer</button>
      <span class="gds-last-updated">Mis à jour : ${now}</span>
    </div>`;

    sortedCats.forEach(cat => {
      const items     = byCategory[cat].sort((a,b) => a.name.localeCompare(b.name));
      const isCollapsed = !!collapsed[cat];
      const escapedCat  = escHtml(cat);
      // نستخدم data-cat بدل id للـ onclick لتجنب مشاكل الـ escaping
      html += `<div class="gds-category">
        <div class="gds-category-title gds-category-toggle" data-cat="${escapedCat}" onclick="gdsToggleCategory(this.dataset.cat)">
		<svg id="gdsarrow_${escapedCat}" class="gds-collapse-arrow" style="transform:${isCollapsed ? "rotate(-90deg)" : ""}" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          ${escapedCat}
        </div>
        <div id="gdsbody_${escapedCat}" style="display:${isCollapsed ? "none" : ""}">
          <table class="gds-table">
            <thead><tr>
              <th>Produit</th>
              <th style="text-align:right">Stock C/F</th>
              <th style="text-align:right">Stock U</th>
              <th style="text-align:right;font-size:9px;color:var(--text3)">qty</th>
              <th style="text-align:right">Réservé C/F</th>
              <th style="text-align:right">Réservé U</th>
              <th style="text-align:right;font-size:9px;color:var(--text3)">qty</th>
            </tr></thead>
            <tbody>`;
      items.forEach(item => {
        const carton    = Math.floor(item.carton);
        const uniteSize = item.carton > 0 ? item.qty / item.carton : 0;
        const uniteRest = item.carton > 0 ? Math.round(item.qty % uniteSize) : Math.round(item.qty);
        const unitSize  = item.unitSize > 0 ? item.unitSize : (item.carton > 0 ? item.qty / item.carton : 0);
        const resCarton = unitSize > 0 ? Math.floor(item.reserved / unitSize) : 0;
        const resUnite  = unitSize > 0 ? Math.round(item.reserved % unitSize) : Math.round(item.reserved);
        html += `<tr>
          <td>${escHtml(productLabel(item.name))}</td>
          <td class="gds-qty">${carton > 0 ? carton : "—"}</td>
          <td class="gds-qty">${uniteRest > 0 ? uniteRest : "—"}</td>
          <td class="gds-qty" style="opacity:0.7;font-size:10px;">${item.qty > 0 ? Math.round(item.qty) : "—"}</td>
          <td class="gds-qty gds-qty--reserved">${item.reserved > 0 ? (resCarton > 0 ? resCarton : "—") : "—"}</td>
          <td class="gds-qty gds-qty--reserved">${item.reserved > 0 ? (resUnite  > 0 ? resUnite  : "0") : "—"}</td>
          <td class="gds-qty gds-qty--reserved" style="opacity:0.7;font-size:10px;">${item.reserved > 0 ? Math.round(item.reserved) : "—"}</td>
        </tr>`;
      });
      html += `</tbody></table></div></div>`;
    });

    el.innerHTML = html;

  } catch(e) {
    el.innerHTML = `<div class="gds-loading" style="color:var(--danger)">Erreur: ${e.message}</div>`;
  }

}
async function renderGdsVans() {
  const el = document.getElementById("gdsVansContent");
  if (!el) return;
  el.innerHTML = `<div class="gds-refresh-bar">
    <button class="gds-refresh-btn" onclick="renderGdsVans()">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/>
      </svg>
      Actualiser
    </button>
    <span class="gds-last-updated">Chargement des vans…</span>
  </div>
  <div class="gds-loading">Recherche des véhicules…</div>`;

  try {
    // 1) جلب مواقع الفانات (child locations)
    const resLoc = await fetch("/api/web/dataset/call_kw", {
      method: "POST", credentials: "include",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        jsonrpc:"2.0", method:"call", id:10,
        params: {
          model: "stock.location",
          method: "search_read",
          args: [[["location_id","=",GDS_VAN_LOCATION_PARENT],["usage","=","internal"]]],
          kwargs: { fields: ["id","name","complete_name"], limit: 100 }
        }
      })
    });
    const locData = await resLoc.json();
    const vanLocations = locData?.result || [];

    if (!vanLocations.length) {
      el.innerHTML = `<div class="gds-loading">Aucun véhicule trouvé.</div>`;
      return;
    }

    // 2) جلب المخزون لكل المواقع دفعة واحدة
    const locIds = vanLocations.map(l => l.id).filter(id => id !== GDS_WAREHOUSE_ID);
    const resQuant = await fetch("/api/web/dataset/call_kw", {
      method: "POST", credentials: "include",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        jsonrpc:"2.0", method:"call", id:11,
        params: {
          model: "stock.quant",
          method: "search_read",
          args: [[["location_id","in",locIds],["quantity",">",0]]],
          kwargs: {
            fields: ["product_id","location_id","quantity","reserved_quantity","packaging_quantity_1"],
            limit: 5000,
          }
        }
      })
    });
    const quantData = await resQuant.json();
    const quants = quantData?.result || [];

    // 3) جلب معلومات المنتجات
    const productIds = [...new Set(quants.map(q => q.product_id[0]))];
    let products = {};
    if (productIds.length) {
      const resProd = await fetch("/api/web/dataset/call_kw", {
        method: "POST", credentials: "include",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          jsonrpc:"2.0", method:"call", id:12,
          params: {
            model: "product.product",
            method: "search_read",
            args: [[["id","in",productIds]]],
            kwargs: { fields: ["id","name","categ_id"], limit: 2000 }
          }
        })
      });
      const prodData = await resProd.json();
      (prodData?.result || []).forEach(p => { products[p.id] = p; });
    }

    // 4) تجميع المخزون حسب الفان ثم حسب الفئة
    const byVan = {}; // { locId: { name, categories: { catName: [items] } } }
    vanLocations.forEach(loc => {
      byVan[loc.id] = { name: loc.name, categories: {} };
    });
    quants.forEach(q => {
      const locId = q.location_id[0];
      if (!byVan[locId]) return;
      const p = products[q.product_id[0]];
      if (!p) return;
      const catName = p.categ_id ? p.categ_id[1] : "Autre";
      if (!byVan[locId].categories[catName]) byVan[locId].categories[catName] = [];
      const unitSize = q.packaging_quantity_1 > 0 ? q.quantity / q.packaging_quantity_1 : 0;
      byVan[locId].categories[catName].push({
        name: p.name,
        qty: q.quantity,
        reserved: q.reserved_quantity || 0,
        packaging: q.packaging_quantity_1 || 0,
        unitSize,
      });
    });

    const now = new Date().toLocaleTimeString("fr-FR");
    const collapsed = _gdsVansGetCollapsed();

    let html = `<div class="gds-refresh-bar">
      <button class="gds-refresh-btn" onclick="renderGdsVans()">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/>
        </svg>
        Actualiser
      </button>
      <button class="gds-refresh-btn" onclick="gdsVansExpandAll()">▼ Tout ouvrir</button>
      <button class="gds-refresh-btn" onclick="gdsVansCollapseAll()">▲ Tout fermer</button>
      <span class="gds-last-updated">Mis à jour : ${now}</span>
    </div>`;

    vanLocations.sort((a,b) => a.name.localeCompare(b.name)).filter(loc => {
  const cats = byVan[loc.id]?.categories || {};
  return Object.values(cats).some(arr => arr.length > 0);
}).forEach(loc => {
      const van = byVan[loc.id];
      const vanId = String(loc.id);
      const isCollapsed = !!collapsed[vanId];
      const cats = Object.keys(van.categories).sort();
      const totalItems = Object.values(van.categories).reduce((s,arr) => s + arr.length, 0);

      html += `<div class="gds-category">
        <div class="gds-category-title gds-category-toggle" onclick="gdsVansToggleVan('${vanId}')">
          <svg id="gdsvanarrow_${vanId}" class="gds-collapse-arrow"
               style="transform:${isCollapsed ? "rotate(-90deg)" : ""}"
               width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px">
            <rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>
            <circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>
          </svg>
          ${escHtml(van.name)}
          <span style="margin-left:auto;font-size:10px;font-weight:400;color:var(--text3)">${totalItems} réf.</span>
        </div>
        <div id="gdsvanbody_${vanId}" style="display:${isCollapsed ? "none" : ""}">`;

      if (!cats.length) {
        html += `<div style="padding:8px 12px;font-size:11px;color:var(--text3)">Aucun stock dans ce véhicule</div>`;
      } else {
        cats.forEach(cat => {
          const items = van.categories[cat].sort((a,b) => a.name.localeCompare(b.name));
          html += `<div class="gds-van-cat-label">${escHtml(cat)}</div>
            <table class="gds-table">
              <thead><tr>
                <th>Produit</th>
                <th style="text-align:right">Stock C/F</th>
                <th style="text-align:right">Stock U</th>
                <th style="text-align:right;font-size:9px;color:var(--text3)">qty</th>
                <th style="text-align:right">Réservé C/F</th>
                <th style="text-align:right">Réservé U</th>
                <th style="text-align:right;font-size:9px;color:var(--text3)">qty</th>
              </tr></thead>
              <tbody>`;
          items.forEach(item => {
            const carton   = item.packaging > 0 ? Math.floor(item.qty / item.packaging) : 0;
            const unite    = item.packaging > 0 ? Math.round(item.qty % item.packaging) : Math.round(item.qty);
            const resCarton = item.packaging > 0 ? Math.floor(item.reserved / item.packaging) : 0;
            const resUnite  = item.packaging > 0 ? Math.round(item.reserved % item.packaging) : Math.round(item.reserved);
            html += `<tr>
              <td>${escHtml(productLabel(item.name))}</td>
              <td class="gds-qty">${carton > 0 ? carton : "—"}</td>
              <td class="gds-qty">${unite  > 0 ? unite  : "—"}</td>
              <td class="gds-qty" style="opacity:0.7;font-size:10px;">${item.qty > 0 ? Math.round(item.qty) : "—"}</td>
              <td class="gds-qty gds-qty--reserved">${item.reserved > 0 ? (resCarton > 0 ? resCarton : "—") : "—"}</td>
              <td class="gds-qty gds-qty--reserved">${item.reserved > 0 ? resUnite : "—"}</td>
              <td class="gds-qty gds-qty--reserved" style="opacity:0.7;font-size:10px;">${item.reserved > 0 ? Math.round(item.reserved) : "—"}</td>
            </tr>`;
          });
          html += `</tbody></table>`;
        });
      }
      html += `</div></div>`;
    });

    el.innerHTML = html;

  } catch(e) {
    el.innerHTML = `<div class="gds-loading" style="color:var(--danger)">Erreur: ${e.message}</div>`;
  }
}

function gdsShowTab(tab) {
  const stockEl = document.getElementById("gdsContent");
  const vansEl  = document.getElementById("gdsVansContent");
  const trEl    = document.getElementById("gdsTransfertsContent");
  const prepEl  = document.getElementById("gdsPreparationContent");
  const btnStock = document.getElementById("gdsTabStock");
  const btnVans  = document.getElementById("gdsTabVans");
  const btnTr    = document.getElementById("gdsTabTransferts");
  const btnPrep  = document.getElementById("gdsTabPreparation");

  // إعادة فلاتر Transferts للافتراضي عند تغيير القسم
  _gdsTransfertsFilters.states = [];
  _gdsTransfertsFilters.date   = new Date().toISOString().slice(0, 10);
  _gdsTransfertsFilters.limit  = 20;

  [stockEl, vansEl, trEl, prepEl].forEach(e => { if (e) e.style.display = "none"; });
  [btnStock, btnVans, btnTr, btnPrep].forEach(b => b?.classList.remove("gds-tab--active"));

  if (tab === "stock") {
    if (stockEl) stockEl.style.display = "";
    btnStock?.classList.add("gds-tab--active");
  } else if (tab === "vans") {
    if (vansEl) vansEl.style.display = "";
    btnVans?.classList.add("gds-tab--active");
    if (!vansEl?.innerHTML || vansEl.innerHTML.includes("Chargement")) renderGdsVans();
  } else if (tab === "transferts") {
    if (trEl) trEl.style.display = "";
    btnTr?.classList.add("gds-tab--active");
    if (!trEl?.innerHTML || trEl.innerHTML.includes("Chargement")) renderGdsTransferts();
  } else if (tab === "preparation") {
    if (prepEl) prepEl.style.display = "";
    btnPrep?.classList.add("gds-tab--active");
    renderGdsPreparation();
  }
}
// ── GDS Preparation ───────────────────────────────────────────
const _gdsPrep = {
  lines:            [],
  loaded:           false,
  finished:         false,
  collapsed:        {},
  isEdit:           false,
  chargeFrom:       null,
  chargeTo:         null,
  chargeData:       {},
  pickingsMap:      {},
  byPicking:        {},
  suggested:        {},
 excludedPickings: [], // references exclus du calcul
  outOfDateTransferts: [], // transferts hors date ajoutés manuellement
};

const GDS_PREP_STORAGE_KEY = "wafa_gds_preparation";

// ── Datetime helpers dd/mm/yyyy ───────────────────────────────
function _gdsPrepFmtDt(isoStr) {
  if (!isoStr) return "";
  const sep = isoStr.includes("T") ? "T" : " ";
  const parts = isoStr.split(sep);
  const datePart = parts[0] || "";
  const timePart = parts[1] || "00:00";
  const dateParts = datePart.split("-");
  const y = dateParts[0], m = dateParts[1], d = dateParts[2];
  if (!y || !m || !d) return "";
  return `${d}/${m}/${y} ${timePart.slice(0,5)}`;
}

function _gdsPrepParseDt(str) {
  // "10/07/2025 08:30" → "2025-07-10T08:30"
  const match = str.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2})$/);
  if (!match) return "";
  return `${match[3]}-${match[2]}-${match[1]}T${match[4]}`;
}

let _gdsPrepPickerTarget = null;
let _gdsPrepPickerField  = null;

function _gdsPrepShowPicker(inputEl, field) {
  _gdsPrepPickerTarget = inputEl;
  _gdsPrepPickerField  = field;

  // إزالة picker سابق
  document.getElementById("gdsDtPickerOverlay")?.remove();

  // قراءة القيمة الحالية
  const now = new Date();
const rawIso = _gdsPrep[field] || `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}T${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
const isoMatch = rawIso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/);
const calYear0  = isoMatch ? parseInt(isoMatch[1]) : now.getFullYear();
const calMonth0 = isoMatch ? parseInt(isoMatch[2]) - 1 : now.getMonth();
const selDay0   = isoMatch ? parseInt(isoMatch[3]) : now.getDate();
const timePart  = isoMatch ? isoMatch[4] : `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;

  const overlay = document.createElement("div");
  overlay.id = "gdsDtPickerOverlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:9999;";
  overlay.addEventListener("mousedown", e => {
    if (!e.target.closest("#gdsDtPickerBox")) _gdsPrepClosePicker();
  });

  const box = document.createElement("div");
  box.id = "gdsDtPickerBox";
  box.style.cssText = `
    position:absolute;background:var(--bg2);border:1px solid var(--border);
    border-radius:10px;box-shadow:0 8px 24px #0004;padding:12px;
    min-width:260px;z-index:10000;font-family:inherit;
  `;

  // Position sous le champ
  const rect = inputEl.getBoundingClientRect();
  const top  = rect.bottom + 6;
  const left = Math.min(rect.left, window.innerWidth - 280);
  box.style.top  = top  + "px";
  box.style.left = left + "px";

  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
      <button id="gdsDtPrev" style="background:none;border:none;font-size:16px;cursor:pointer;color:var(--text);padding:2px 8px;">‹</button>
      <span id="gdsDtMonthYear" style="font-size:13px;font-weight:600;color:var(--text);"></span>
      <button id="gdsDtNext" style="background:none;border:none;font-size:16px;cursor:pointer;color:var(--text);padding:2px 8px;">›</button>
    </div>
    <div id="gdsDtCalGrid" style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;font-size:11px;"></div>
    <div style="margin-top:10px;display:flex;align-items:center;gap:6px;">
      <span style="font-size:11px;color:var(--text2);">Heure :</span>
      <input id="gdsDtTime" type="time" value="${timePart.slice(0,5)}"
        style="border:1px solid var(--border);border-radius:6px;padding:3px 6px;font-size:12px;background:var(--bg3);color:var(--text);"/>
    </div>
    <div style="margin-top:10px;text-align:right;">
      <button onclick="_gdsPrepPickerConfirm()" style="background:var(--gds-color);color:#fff;border:none;border-radius:6px;padding:5px 14px;font-size:12px;cursor:pointer;">OK</button>
    </div>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // ── Calendrier ──
  let calYear  = calYear0;
let calMonth = calMonth0;
let selDay   = selDay0;

  function _renderCal() {
    const MY = document.getElementById("gdsDtMonthYear");
    const grid = document.getElementById("gdsDtCalGrid");
    if (!MY || !grid) return;
    const mNames = ["Jan","Fév","Mar","Avr","Mai","Jun","Jul","Aoû","Sep","Oct","Nov","Déc"];
    MY.textContent = `${mNames[calMonth]} ${calYear}`;

    // Jours de la semaine
    const days = ["Lu","Ma","Me","Je","Ve","Sa","Di"];
    let html = days.map(d => `<div style="font-weight:600;color:var(--text3);font-size:10px;">${d}</div>`).join("");

    const firstDay = new Date(calYear, calMonth, 1);
    let startDow = firstDay.getDay(); // 0=Sun
    startDow = startDow === 0 ? 6 : startDow - 1; // → 0=Mon
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const today = new Date();

    for (let i = 0; i < startDow; i++) html += "<div></div>";
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday = d === today.getDate() && calMonth === today.getMonth() && calYear === today.getFullYear();
      const isSel = d === selDay;
      const bg = isSel ? "var(--gds-color)" : isToday ? "var(--accent)" : "transparent";
      const color = (isSel||isToday) ? "#fff" : "var(--text)";
      html += `<div onclick="_gdsPrepPickerSelDay(${d},${calMonth},${calYear})" style="cursor:pointer;border-radius:50%;padding:3px 0;background:${bg};color:${color};font-size:11px;transition:background .1s;">${d}</div>`;
    }
    grid.innerHTML = html;
  }

  window._gdsPrepPickerSelDay = function(d, m, y) {
    selDay   = d;
    calMonth = m;
    calYear  = y;
    // update stored iso
    const mm = String(m+1).padStart(2,"0"), dd = String(d).padStart(2,"0");
    const t  = (document.getElementById("gdsDtTime")?.value || "00:00");
    const iso = `${y}-${mm}-${dd}T${t}`;
    _gdsPrep[_gdsPrepPickerField] = iso;
    if (_gdsPrepPickerTarget) _gdsPrepPickerTarget.value = _gdsPrepFmtDt(iso);
    _renderCal();
  };

  document.getElementById("gdsDtPrev").addEventListener("click", () => {
    calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } _renderCal();
  });
  document.getElementById("gdsDtNext").addEventListener("click", () => {
    calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } _renderCal();
  });

  _renderCal();
}

function _gdsPrepPickerConfirm() {
  if (_gdsPrepPickerTarget && _gdsPrepPickerField) {
    const t   = document.getElementById("gdsDtTime")?.value || "00:00";
    const iso = _gdsPrep[_gdsPrepPickerField];
    if (iso) {
      const newIso = iso.slice(0,11) + t;
      _gdsPrep[_gdsPrepPickerField] = newIso;
      _gdsPrepPickerTarget.value = _gdsPrepFmtDt(newIso);
    }
  }
  _gdsPrepClosePicker();
}

function _gdsPrepClosePicker() {
  document.getElementById("gdsDtPickerOverlay")?.remove();
  _gdsPrepPickerTarget = null;
  _gdsPrepPickerField  = null;
}

function _gdsPrepSave() {
  try {
    const data = {
      lines:               _gdsPrep.lines,
      loaded:              _gdsPrep.loaded,
      finished:            _gdsPrep.finished,
      chargeFrom:          _gdsPrep.chargeFrom,
      chargeTo:            _gdsPrep.chargeTo,
      chargeData:          _gdsPrep.chargeData,
      pickingsMap:         _gdsPrep.pickingsMap,
      byPicking:           _gdsPrep.byPicking,
      excludedPickings:    _gdsPrep.excludedPickings,
      outOfDateTransferts: _gdsPrep.outOfDateTransferts,
      date:                new Date().toISOString().slice(0, 10),
    };
    localStorage.setItem(GDS_PREP_STORAGE_KEY, JSON.stringify(data));
  } catch(e) { console.error("[GdsPrep] save:", e); }
}

function _gdsPrepLoadFromStorage() {
  try {
    const raw = localStorage.getItem(GDS_PREP_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    const today = new Date().toISOString().slice(0, 10);
    if (data.date !== today) return; // données d'un autre jour, on ignore
    _gdsPrep.lines = (data.lines || []).map(line => {
      if (!line.unitSize && line.carton > 0) line.unitSize = line.qty / line.carton;
      return line;
    });
    _gdsPrep.loaded     = data.loaded     || false;
    _gdsPrep.finished   = data.finished   || false;
    _gdsPrep.chargeFrom  = data.chargeFrom  || null;
    _gdsPrep.chargeTo    = data.chargeTo    || null;
    _gdsPrep.chargeData = {};
// إعادة حساب chargeCarton/chargeUnite من chargeTotal المخزون
Object.entries(data.chargeData || {}).forEach(([pid, ch]) => {
  const line = _gdsPrep.lines.find(l => l.pid === Number(pid));
  const u = line ? _gdsPrepUnitSize(line) : 0;
  _gdsPrep.chargeData[Number(pid)] = {
    chargeCarton: u > 0 ? Math.floor(ch.chargeTotal / u) : 0,
    chargeUnite:  u > 0 ? Math.round(ch.chargeTotal % u) : Math.round(ch.chargeTotal),
    chargeTotal:  ch.chargeTotal,
  };
});
   _gdsPrep.pickingsMap         = data.pickingsMap         || {};
    _gdsPrep.byPicking           = data.byPicking           || {};
    _gdsPrep.excludedPickings    = data.excludedPickings    || [];
    _gdsPrep.outOfDateTransferts = data.outOfDateTransferts || [];
    _gdsPrepUpdateExcluBtn();
    _gdsPrepUpdateOutOfDateBtn();
    // تحديث الحقول النصية إن وُجدت
    const fromEl = document.getElementById("gdsPrepChargeFrom");
    const toEl   = document.getElementById("gdsPrepChargeTo");
    const _nowLocal = () => { const n=new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}T${String(n.getHours()).padStart(2,"0")}:${String(n.getMinutes()).padStart(2,"0")}`; };
if (fromEl) fromEl.value = _gdsPrepFmtDt(_gdsPrep.chargeFrom || _nowLocal());
if (toEl)   toEl.value   = _gdsPrepFmtDt(_gdsPrep.chargeTo   || _nowLocal());
  } catch(e) { console.error("[GdsPrep] load:", e); }
}

// ── helpers ──────────────────────────────────────────────────
function _gdsPrepUnitSize(line) {
  const u = line.unitSize > 0 ? line.unitSize : (line.carton > 0 ? line.qty / line.carton : 0);
  return Math.round(u);
}
function _gdsPrepTotalPrep(line) {
  const u = _gdsPrepUnitSize(line);
  return line.prepCarton * u + line.prepUnite;
}

// ── render conteneur principal ────────────────────────────────
async function renderGdsPreparation() {
  const el = document.getElementById("gdsPreparationContent");
  if (!el) return;

  _gdsPrepLoadFromStorage();
  const hasData = _gdsPrep.loaded && _gdsPrep.lines.length > 0;

  let barBtns = `<button class="gds-refresh-btn" onclick="gdsPrepOpenModal()">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      تحضير جديد
    </button>`;
  if (hasData) {
    barBtns = `<button class="gds-refresh-btn" onclick="gdsPrepOpenModal(true)">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        تعديل
      </button>
      <button class="gds-refresh-btn gds-prep-finish-btn" onclick="gdsPrepAskFinish()">✓ إنهاء</button>`;
  }

// Valeur datetime par défaut = maintenant (tronqué à la minute)
  const nowDt = new Date(); nowDt.setSeconds(0,0);
const dtDefault = `${nowDt.getFullYear()}-${String(nowDt.getMonth()+1).padStart(2,"0")}-${String(nowDt.getDate()).padStart(2,"0")}T${String(nowDt.getHours()).padStart(2,"0")}:${String(nowDt.getMinutes()).padStart(2,"0")}`;
  const dtStored   = _gdsPrep.chargeFrom || dtDefault;
const dtStoredTo = _gdsPrep.chargeTo   || dtDefault;

  el.innerHTML = `<div class="gds-refresh-bar" style="padding:8px 10px;flex-wrap:wrap;gap:6px;">
    ${hasData ? (
      _gdsPrep.finished
        ? `<button class="gds-refresh-btn" onclick="gdsPrepReprendre()">↩ Reprendre</button>
           <span class="gds-refresh-btn" style="background:var(--green);cursor:default;">✓ Terminée</span>`
        : `<button class="gds-refresh-btn" onclick="gdsPrepOpenModal(true)">
             <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
               <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
               <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
             </svg>
             Modifier
           </button>
           <button class="gds-refresh-btn gds-prep-finish-btn" onclick="gdsPrepAskFinish()">✓ Terminer</button>
<button class="gds-refresh-btn" style="background:var(--red);margin-left:4px;" onclick="gdsPrepAskCancel()">✕ Annuler</button>
           <button class="gds-refresh-btn" style="background:var(--accent);margin-left:4px;" onclick="gdsPrepExportCurrent()" title="Télécharger rapport actuel">⬇ Rapport</button>`    ) : `<button class="gds-refresh-btn" onclick="gdsPrepOpenModal()">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Nouvelle préparation
      </button>`}
    <span class="gds-last-updated" id="gdsPrepStatus">
      ${hasData ? _gdsPrep.lines.length + " produits" : "Cliquez sur Nouvelle préparation"}
    </span>
    <div id="gdsPrepNewBar" style="display:none;">
      <button class="gds-refresh-btn" style="background:var(--gds-color);" onclick="gdsPrepAskNew()">
        + Nouvelle préparation
      </button>
    </div>
</div>
  <!-- Barre chargement depuis -->
  <div style="display:${_gdsPrep.loaded ? 'flex' : 'none'};align-items:center;gap:8px;padding:6px 10px;background:var(--bg2);border-bottom:1px solid var(--border);flex-wrap:wrap;position:sticky;top:41px;z-index:18;margin-top:-1px;">
    <span style="font-size:11px;font-weight:600;color:var(--text2);">Chargements depuis :</span>
    <input type="text" id="gdsPrepChargeFrom" class="gds-prep-dt-input"
      placeholder="jj/mm/aaaa hh:mm"
      style="min-width:140px;cursor:pointer;"/>
    <span style="font-size:11px;font-weight:600;color:var(--text2);">A :</span>
    <input type="text" id="gdsPrepChargeTo" class="gds-prep-dt-input"
      placeholder="jj/mm/aaaa hh:mm"
      style="min-width:140px;cursor:pointer;"/>
    <button class="gds-refresh-btn" onclick="gdsPrepFetchCharge()" style="gap:4px;">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/>
      </svg>
      Actualiser chargements
    </button>
    <span class="gds-last-updated" id="gdsPrepChargeStatus"></span>
    <button class="gds-refresh-btn" id="gdsPrepExcluBtn" onclick="_gdsPrepShowExcludeList()" style="padding:2px 8px;font-size:11px;background:var(--red);opacity:${_gdsPrep.excludedPickings.length ? '1' : '0.4'};cursor:${_gdsPrep.excludedPickings.length ? 'pointer' : 'default'};" ${_gdsPrep.excludedPickings.length ? '' : 'disabled'}>Exclu (${_gdsPrep.excludedPickings.length})</button>
    <button class="gds-refresh-btn" onclick="_gdsPrepShowExcludeInput()" style="padding:2px 8px;font-size:11px;background:var(--red);" title="Exclure un transfert">+</button>
    <button class="gds-refresh-btn" id="gdsPrepOutOfDateBtn" onclick="_gdsPrepShowOutOfDateList()" style="padding:2px 8px;font-size:11px;background:var(--orange,#f59e0b);opacity:${_gdsPrep.outOfDateTransferts.length ? '1' : '0.4'};cursor:${_gdsPrep.outOfDateTransferts.length ? 'pointer' : 'default'};" ${_gdsPrep.outOfDateTransferts.length ? '' : 'disabled'}>Hors date (${_gdsPrep.outOfDateTransferts.length})</button>
    <button class="gds-refresh-btn" onclick="_gdsPrepShowOutOfDateInput()" style="padding:2px 8px;font-size:11px;background:var(--orange,#f59e0b);" title="Ajouter transfert hors date">+</button>
    <div id="gdsPrepExcluInputBar" style="display:none;"></div>
    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-left:8px;align-items:center;">
      <div id="gdsPrepPickingBtns" style="display:flex;flex-wrap:wrap;gap:4px;">
        ${_gdsPrepRenderPickingBtns()}
      </div>
      <button onclick="(()=>{const p=document.getElementById('gdsPrepPickingBtns');const hidden=p.style.display==='none';p.style.display=hidden?'flex':'none';this.style.opacity=hidden?'1':'0.5';})()" style="font-size:9px;padding:2px 7px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text3);cursor:pointer;margin-left:2px;" title="Afficher/Masquer les tournées">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
    </div>
  </div>
  <div id="gdsPrepTableWrap" style="padding:0 10px 20px;overflow-x:auto;-webkit-overflow-scrolling:touch;"></div>

  <!-- Barre Nouvelle préparation (visible après check complet) -->
  <div id="gdsPrepNewBar" style="display:none;padding:10px;border-top:1px solid var(--border);background:var(--bg2);">
    <button class="gds-refresh-btn" style="background:var(--gds-color);" onclick="gdsPrepAskNew()">
      + Nouvelle préparation
    </button>
  </div>

  <!-- Modal confirmation nouvelle préparation -->
  <div id="gdsPrepNewConfirmModal" class="gds-prep-modal" style="display:none;">
    <div class="gds-prep-modal-box" style="max-width:340px;text-align:center;">
      <div class="gds-prep-modal-header"><span>Nouvelle préparation</span></div>
      <div style="padding:20px 16px;font-size:13px;color:var(--text);">
        Un fichier Excel sera téléchargé et toutes les données seront effacées.<br>
        <span id="gdsPrepNewCountdown" style="display:block;margin-top:12px;font-size:26px;font-weight:700;color:var(--gds-color);">10</span>
      </div>
      <div class="gds-prep-modal-footer" style="justify-content:center;">
        <button id="gdsPrepNewConfirmBtn" class="gds-refresh-btn" disabled style="opacity:.4;" onclick="gdsPrepDoNew()">✓ Confirmer</button>
        <button class="gds-refresh-btn" style="background:var(--text3);" onclick="gdsPrepCloseNew()">Annuler</button>
      </div>
    </div>
  </div>

  <!-- Modal saisie / modification -->
  <div id="gdsPrepModal" class="gds-prep-modal" style="display:none;" onclick="if(event.target===this)gdsPrepCloseModal()">
    <div class="gds-prep-modal-box">
      <div class="gds-prep-modal-header">
        <span id="gdsPrepModalTitle">Saisie préparation</span>
        <button class="icon-btn-sm" onclick="gdsPrepCloseModal()">✕</button>
      </div>
      <div class="gds-prep-modal-body" id="gdsPrepModalBody">
        <div class="gds-loading">جارٍ التحميل…</div>
      </div>
      <div class="gds-prep-modal-footer">
        <button class="gds-refresh-btn" onclick="gdsPrepModalConfirm()">↵ Confirmer</button>
        <button id="gdsPrepAutoFillBtn" class="gds-refresh-btn" style="background:var(--accent);display:none;" onclick="gdsPrepAutoFill()" title="Remplir selon suggestions +20%">▢ Propos</button>
		<button class="gds-refresh-btn" style="background:var(--text2);" onclick="gdsPrepPrintPrep()" title="Imprimer la préparation">🖨 Imprimer</button>
        <button class="gds-refresh-btn" style="background:var(--text3);" onclick="gdsPrepCloseModal()">Annuler</button>
      </div>
    </div>
  </div>

  <!-- Modal historique -->
  <div id="gdsPrepHistModal" class="gds-prep-modal" style="display:none;" onclick="if(event.target===this)gdsPrepCloseHist()">
    <div class="gds-prep-modal-box" style="max-width:420px;">
      <div class="gds-prep-modal-header">
        <span id="gdsPrepHistTitle">Historique</span>
        <button class="icon-btn-sm" onclick="gdsPrepCloseHist()">✕</button>
      </div>
      <div class="gds-prep-modal-body" id="gdsPrepHistBody"></div>
      <div class="gds-prep-modal-footer">
        <button class="gds-refresh-btn" style="background:var(--text3);" onclick="gdsPrepCloseHist()">Fermer</button>
      </div>
    </div>
  </div>

  <!-- Modal confirmation fin -->
  <div id="gdsPrepCancelModal" class="gds-prep-modal" style="display:none;">
    <div class="gds-prep-modal-box" style="max-width:340px;text-align:center;">
      <div class="gds-prep-modal-header"><span>Annuler la préparation</span></div>
      <div style="padding:20px 16px;font-size:13px;color:var(--text);">
        Toutes les données seront supprimées définitivement.<br>
        <span id="gdsPrepCancelCountdown" style="display:block;margin-top:12px;font-size:26px;font-weight:700;color:var(--red);">10</span>
        <span style="font-size:10px;color:var(--text3);">secondes avant annulation</span>
      </div>
      <div class="gds-prep-modal-footer" style="justify-content:center;">
        <button id="gdsPrepCancelBtn" class="gds-refresh-btn" disabled style="opacity:.4;background:var(--red);" onclick="gdsPrepDoCancel()">✕ Annuler la prépa</button>
        <button class="gds-refresh-btn" style="background:var(--text3);" onclick="gdsPrepCloseCancel()">Fermer</button>
      </div>
    </div>
  </div>

  <div id="gdsPrepConfirmModal" class="gds-prep-modal" style="display:none;">
    <div class="gds-prep-modal-box" style="max-width:340px;text-align:center;">
      <div class="gds-prep-modal-header"><span>Confirmer la fin</span></div>
      <div style="padding:20px 16px;font-size:13px;color:var(--text);">
        Voulez-vous terminer cette préparation définitivement ?<br>
        <span id="gdsPrepCountdown" style="display:block;margin-top:12px;font-size:26px;font-weight:700;color:var(--gds-color);">5</span>
        <span style="font-size:10px;color:var(--text3);" id="gdsPrepCdHint">secondes avant confirmation</span>
      </div>
      <div class="gds-prep-modal-footer" style="justify-content:center;">
        <button id="gdsPrepConfirmBtn" class="gds-refresh-btn" disabled style="opacity:.4;" onclick="gdsPrepDoFinish()">✓ Confirmer</button>
        <button class="gds-refresh-btn" style="background:var(--text3);" onclick="gdsPrepCloseConfirm()">Annuler</button>
      </div>
    </div>
  </div>`;

  if (hasData) _gdsPrepRenderTable();
  _gdsPrepInitFlatpickr(dtStored, _gdsPrep.chargeTo || dtDefault);
}

function _gdsPrepInitFlatpickr(fromVal, toVal) {
  // تحميل Flatpickr إن لم يكن محملاً
  function _loadFp(cb) {
    if (window.flatpickr) { cb(); return; }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css";
    document.head.appendChild(link);
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/flatpickr";
    s.onload = cb;
    document.head.appendChild(s);
  }

  _loadFp(() => {
    const cfg = {
      enableTime: true,
      dateFormat: "d/m/Y H:i",
      time_24hr: true,
      allowInput: false,
      locale: { firstDayOfWeek: 1 },
      onReady: (_,__,fp) => { if(!fp.selectedDates.length) fp.setDate(new Date(), false); }
    };

    // تحويل ISO → Date لـ Flatpickr
    function isoToDate(iso) {
  if (!iso || !iso.includes("T")) return null;
  const [datePart, timePart] = iso.split("T");
  const dp = datePart.split("-");
  const tp = (timePart||"00:00").split(":");
  const y=parseInt(dp[0]), m=parseInt(dp[1]), d=parseInt(dp[2]);
  const h=parseInt(tp[0]||0), mi=parseInt(tp[1]||0);
  if (isNaN(y)||isNaN(m)||isNaN(d)) return null;
  return new Date(y, m-1, d, h||0, mi||0);
}

    flatpickr("#gdsPrepChargeFrom", {
      ...cfg,
      defaultDate: isoToDate(fromVal),
      onChange: ([date]) => {
        if (!date) return;
        const y=date.getFullYear(), m=String(date.getMonth()+1).padStart(2,"0"),
              d=String(date.getDate()).padStart(2,"0"),
              h=String(date.getHours()).padStart(2,"0"), mi=String(date.getMinutes()).padStart(2,"0");
        _gdsPrep.chargeFrom = `${y}-${m}-${d}T${h}:${mi}`;
      }
    });

    flatpickr("#gdsPrepChargeTo", {
      ...cfg,
      defaultDate: isoToDate(toVal),
      onChange: ([date]) => {
        if (!date) return;
        const y=date.getFullYear(), m=String(date.getMonth()+1).padStart(2,"0"),
              d=String(date.getDate()).padStart(2,"0"),
              h=String(date.getHours()).padStart(2,"0"), mi=String(date.getMinutes()).padStart(2,"0");
        _gdsPrep.chargeTo = `${y}-${m}-${d}T${h}:${mi}`;
      }
    });
  });
}

// ── فتح النافذة ───────────────────────────────────────────────
async function gdsPrepOpenModal(isEdit = false) {
  _gdsPrep.isEdit = isEdit;
  if (!_gdsPrep.loaded) await _gdsPrepLoadStock();
  const modal = document.getElementById("gdsPrepModal");
  if (!modal) return;
  // حقل delta مؤقت لكل سطر (للتعديل)
  _gdsPrep.lines.forEach(l => { l._deltaCarton = 0; l._deltaUnite = 0; });
  document.getElementById("gdsPrepModalTitle").textContent = isEdit ? "Modifier la préparation" : "Saisie préparation";
  modal.style.display = "flex";
  _gdsPrepRenderModalBody();
  const autoBtn = document.getElementById("gdsPrepAutoFillBtn");
  if (autoBtn) {
    autoBtn.style.display = isEdit ? "none" : "";
    autoBtn.disabled = true;
    autoBtn.style.opacity = ".4";
  }
  if (!isEdit) {
    if (Object.keys(_gdsPrep.suggested).length) {
      if (autoBtn) { autoBtn.disabled = false; autoBtn.style.opacity = "1"; }
    } else {
      _gdsPrepFetchSuggested().then(sugg => {
        _gdsPrep.suggested = sugg;
        if (autoBtn && Object.keys(sugg).length) { autoBtn.disabled = false; autoBtn.style.opacity = "1"; }
      });
    }
  }
}

function gdsPrepPrintPrep() {
  const now  = new Date();
  const date = now.toLocaleDateString("fr-FR");
  const time = now.toLocaleTimeString("fr-FR", { hour:"2-digit", minute:"2-digit" });

  // جمع المنتجات بالفئة (فقط التي فيها قيم)
  const byCateg = {};
  _gdsPrep.lines.forEach(line => {
    if (line.prepCarton <= 0 && line.prepUnite <= 0) return;
    const cat = line.categ || "—";
    if (!byCateg[cat]) byCateg[cat] = [];
    byCateg[cat].push(line);
  });

  if (!Object.keys(byCateg).length) {
    addNotif("Aucun produit en préparation", "warning");
    return;
  }

  let rows = "";
  Object.entries(byCateg).forEach(([cat, lines]) => {
    rows += `<tr class="cat-row"><td colspan="3">${cat}</td></tr>`;
    lines.forEach(line => {
      rows += `<tr>
        <td>${line.name}</td>
        <td class="num">${line.prepCarton > 0 ? line.prepCarton : "—"}</td>
        <td class="num">${line.prepUnite  > 0 ? line.prepUnite  : "—"}</td>
      </tr>`;
    });
  });

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Stock Préparation</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 12px; margin: 20px; color: #000; }
    h2 { font-size: 15px; margin: 0 0 4px; }
    .sub { font-size: 11px; color: #555; margin-bottom: 14px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f0f0f0; border: 1px solid #ccc; padding: 5px 8px; text-align: left; }
    td { border: 1px solid #ddd; padding: 4px 8px; }
    .num { text-align: center; width: 60px; }
    .cat-row td { background: #e8f5e9; font-weight: bold; font-size: 11px; color: #2e7d32; }
    @media print { body { margin: 10px; } }
  </style></head><body>
  <h2>STOCK PRÉPARATION</h2>
  <div class="sub">${date} — ${time}</div>
  <table>
    <thead><tr><th>Produit</th><th class="num">C/F</th><th class="num">U</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <script>window.onload=()=>{window.print();}<\/script>
  </body></html>`;

  const w = window.open("", "_blank");
  if (w) { w.document.write(html); w.document.close(); }
}

function gdsPrepDownloadPrepPdf() {
  const now  = new Date();
  const date = now.toLocaleDateString("fr-FR");
  const time = now.toLocaleTimeString("fr-FR", { hour:"2-digit", minute:"2-digit" });

  const byCateg = {};
  _gdsPrep.lines.forEach(line => {
    if (line.prepCarton <= 0 && line.prepUnite <= 0) return;
    const cat = line.categ || "—";
    if (!byCateg[cat]) byCateg[cat] = [];
    byCateg[cat].push(line);
  });
  if (!Object.keys(byCateg).length) return;

 let rows = "";
  Object.entries(byCateg).forEach(([cat, lines]) => {
    rows += `<tr class="cat-row"><td colspan="3">${cat}</td></tr>`;
    lines.forEach(line => {
      rows += `<tr>
        <td>${line.name}</td>
        <td class="num">${line.prepCarton > 0 ? line.prepCarton : "—"}</td>
        <td class="num">${line.prepUnite  > 0 ? line.prepUnite  : "—"}</td>
      </tr>`;
    });
  });

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>
    @page { size: A4; margin: 8mm; }
    body { font-family: Arial, sans-serif; font-size: 12px; margin: 0; color: #000; }
    h2 { font-size: 14px; margin: 0 0 2px; }
    .sub { font-size: 10px; color: #555; margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f0f0f0; border: 1px solid #ccc; padding: 4px 6px; text-align: left; font-size: 11px; }
    td { border: 1px solid #ddd; padding: 3px 6px; }
    .num { text-align: center; width: 35px; font-size: 14px; font-weight: bold; }
    th.num { font-size: 11px; font-weight: normal; }
    .cat-row td { background: #e8f5e9; font-weight: bold; font-size: 10px; color: #2e7d32; }
  </style></head><body>
  <h2>STOCK PRÉPARATION</h2>
  <div class="sub">${date} — ${time}</div>
  <table>
    <thead><tr><th>Produit</th><th class="num">C/F</th><th class="num">U</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <script>
    window.onload = () => {
      window.print();
      window.onafterprint = () => window.close();
    };
  <\/script>
  </body></html>`;

  // حساب حجم الخط بناءً على عدد الصفوف
  const totalRows = Object.values(byCateg).reduce((s, l) => s + l.length, 0)
                  + Object.keys(byCateg).length; // صفوف الفئات
  const fontSize  = totalRows > 60 ? 7 : totalRows > 40 ? 8 : totalRows > 25 ? 9 : 10;

  const blob = new Blob([html], { type: "text/html" });
  const url  = URL.createObjectURL(blob);
  const w    = window.open(url, "_blank");
  if (w) setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function gdsPrepAutoFill() {
  if (!Object.keys(_gdsPrep.suggested).length) return;
  _gdsPrep.lines.forEach(line => {
    const suggQty = _gdsPrep.suggested[line.pid] || 0;
    if (!suggQty) return;
    const u       = _gdsPrepUnitSize(line);
    const target  = Math.ceil(suggQty * 1.2);
    // تحويل لـ C/F فقط بدون U
    let cf = u > 0 ? Math.ceil(target / u) : 0;
    // لا تتجاوز المخزون
    if (u > 0 && cf * u > line.qty) cf = Math.floor(line.qty / u);
    line.prepCarton = cf;
    line.prepUnite  = 0;
    // تحديث الـ inputs في الـ DOM
    const inputs = document.querySelectorAll(`.gds-prep-input[data-pid="${line.pid}"]`);
    inputs.forEach(inp => {
      if (inp.dataset.field === "prepCarton") inp.value = cf;
      if (inp.dataset.field === "prepUnite")  inp.value = 0;
    });
  });
}

function gdsPrepCloseModal() {
  const m = document.getElementById("gdsPrepModal");
  if (m) m.style.display = "none";
}

// ── تحميل البيانات من Odoo ────────────────────────────────────
async function _gdsPrepLoadStock() {
  const statusEl = document.getElementById("gdsPrepStatus");
  if (statusEl) statusEl.textContent = "Chargement…";
  try {
    const r1 = await fetch("/api/web/dataset/call_kw", {
      method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:1, params:{
        model:"stock.quant", method:"search_read",
        args:[[["location_id","=",GDS_WAREHOUSE_ID],["quantity",">",0]]],
        kwargs:{ fields:["product_id","quantity","packaging_quantity_1"], limit:2000 }
      }})
    });
    const quants = (await r1.json())?.result || [];
    const pids = [...new Set(quants.map(q => q.product_id[0]))];
    const r2 = await fetch("/api/web/dataset/call_kw", {
      method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:2, params:{
        model:"product.product", method:"search_read",
        args:[[["id","in",pids]]],
        kwargs:{ fields:["id","name","categ_id","uom_id"], limit:2000 }
      }})
    });
    const prods = {};
    ((await r2.json())?.result || []).forEach(p => { prods[p.id] = p; });

    _gdsPrep.lines = [];
    quants.forEach(q => {
      const pid = q.product_id[0]; const p = prods[pid]; if (!p) return;
      const pkgCarton = q.packaging_quantity_1 || 0;
      const unitSize  = pkgCarton > 0 ? q.quantity / pkgCarton : 0;
      const ex = _gdsPrep.lines.find(l => l.pid === pid);
      if (ex) {
        ex.qty    += q.quantity;
        ex.carton += pkgCarton;
        if (ex.unitSize === 0 && unitSize > 0) ex.unitSize = unitSize;
      } else {
        _gdsPrep.lines.push({ pid, name:p.name,
          categ:    p.categ_id ? p.categ_id[1] : "Autre",
          uom:      p.uom_id   ? p.uom_id[1]   : "",
          qty:      q.quantity,
          carton:   pkgCarton,
          unitSize,
          prepCarton:0, prepUnite:0, history:[], _deltaCarton:0, _deltaUnite:0,
        });
      }
    });
    // تصحيح unitSize النهائي من المجموع
    _gdsPrep.lines.forEach(line => {
      if (line.unitSize === 0 && line.carton > 0) line.unitSize = line.qty / line.carton;
    });
    _gdsPrep.lines.sort((a,b) => a.categ.localeCompare(b.categ) || a.name.localeCompare(b.name));
    _gdsPrep.loaded = true;
    if (statusEl) statusEl.textContent = _gdsPrep.lines.length + " produits";
  } catch(e) {
    if (statusEl) statusEl.textContent = "Erreur: " + e.message;
  }
}

// ── عرض جسم النافذة ──────────────────────────────────────────
function _gdsPrepRenderModalBody() {
  const body = document.getElementById("gdsPrepModalBody");
  if (!body) return;
  const isEdit = _gdsPrep.isEdit;

  const byCateg = {};
  _gdsPrep.lines.forEach((line, i) => {
    if (!byCateg[line.categ]) byCateg[line.categ] = [];
    byCateg[line.categ].push({ line, i });
  });

  let html = "";
  Object.keys(byCateg).sort().forEach(cat => {
    const collapsed = !!_gdsPrep.collapsed["modal_" + cat];
    html += `<div class="gds-prep-modal-cat gds-category-toggle" style="cursor:pointer;" onclick="_gdsPrepToggleModalCat('${escHtml(cat)}')">
      <svg class="gds-collapse-arrow" style="transition:transform .2s;transform:${collapsed?"rotate(-90deg)":""}" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"/></svg>
      ${escHtml(cat)}
    </div>
    <div id="gdsPrepModalCat_${escHtml(cat)}" style="display:${collapsed?"none":""}">
    <table class="gds-table" style="margin-bottom:10px;">
      <thead><tr>
        <th>Produit</th>
        <th style="text-align:right">Stock C/F</th>
        <th style="text-align:right">Stock U</th>
        ${isEdit
          ? `<th style="text-align:right">Actuel C/F</th><th style="text-align:right">Actuel U</th>
             <th style="text-align:right">Δ C/F</th><th style="text-align:right">Δ U</th>`
          : `<th style="text-align:right">Prép. C/F</th><th style="text-align:right">Prép. U</th>`}
      </tr></thead><tbody>`;

    byCateg[cat].forEach(({ line, i }) => {
      const u = _gdsPrepUnitSize(line);
      const stockC = u > 0 ? Math.floor(line.qty / u) : 0;
      const stockU = u > 0 ? Math.round(line.qty % u) : Math.round(line.qty);

      if (!isEdit) {
        html += `<tr>
          <td style="font-size:10px;">${escHtml(line.name)}</td>
          <td class="gds-qty">${stockC > 0 ? stockC : "—"}</td>
          <td class="gds-qty">${stockU > 0 ? stockU : (stockC === 0 ? Math.round(line.qty) : "—")}</td>
          <td class="gds-qty">
            <input type="number" min="0" class="gds-prep-input" data-pid="${line.pid}" data-field="prepCarton"
              value="${line.prepCarton || ""}" placeholder="0"
              oninput="_gdsPrepValidateInput(${line.pid},'prepCarton',this)"
              onkeydown="if(event.key==='Enter'){_gdsPrepValidateInput(${line.pid},'prepCarton',this);this.closest('tr').nextElementSibling?.querySelector('[data-field=prepCarton]')?.focus();}"/>
          </td>
          <td class="gds-qty">
            <input type="number" min="0" class="gds-prep-input" data-pid="${line.pid}" data-field="prepUnite"
              value="${line.prepUnite || ""}" placeholder="0"
              oninput="_gdsPrepValidateInput(${line.pid},'prepUnite',this)"
              onkeydown="if(event.key==='Enter'){_gdsPrepValidateInput(${line.pid},'prepUnite',this);this.closest('tr').nextElementSibling?.querySelector('[data-field=prepUnite]')?.focus();}"/>
          </td>
        </tr>`;
      } else {
        const hasErrRow = !!line._hasError;
        html += `<tr style="${hasErrRow?"background:rgba(239,68,68,.10);":""}">
          <td style="font-size:10px;">${escHtml(line.name)}</td>
          <td class="gds-qty">${stockC > 0 ? stockC : "—"}</td>
          <td class="gds-qty">${stockU > 0 ? stockU : (stockC === 0 ? Math.round(line.qty) : "—")}</td>
          <td class="gds-qty" style="color:var(--gds-color)">${line.prepCarton || "—"}</td>
          <td class="gds-qty" style="color:var(--gds-color)">${line.prepUnite  || "—"}</td>
          <td class="gds-qty">
            <div style="display:flex;align-items:center;gap:2px;">
              <button class="gds-prep-delta-btn" onclick="_gdsPrepDelta(${line.pid},'prepCarton',-1,this)">−</button>
              <input type="number" class="gds-prep-input" style="width:50px;" data-idx="${line.pid}" data-field="deltaCarton"
                value="${line._deltaCarton || 0}"
                onchange="_gdsPrepDeltaInput(${line.pid},'prepCarton',this)"/>
              <button class="gds-prep-delta-btn" onclick="_gdsPrepDelta(${line.pid},'prepCarton',+1,this)">+</button>
            </div>
          </td>
          <td class="gds-qty">
            <div style="display:flex;align-items:center;gap:2px;">
              <button class="gds-prep-delta-btn" onclick="_gdsPrepDelta(${line.pid},'prepUnite',-1,this)">−</button>
              <input type="number" class="gds-prep-input" style="width:50px;" data-idx="${line.pid}" data-field="deltaUnite"
                value="${line._deltaUnite || 0}"
                onchange="_gdsPrepDeltaInput(${line.pid},'prepUnite',this)"/>
              <button class="gds-prep-delta-btn" onclick="_gdsPrepDelta(${line.pid},'prepUnite',+1,this)">+</button>
            </div>
          </td>
        </tr>`;
      }
    });
    html += `</tbody></table></div>`;
  });
  body.innerHTML = html;
}

// ── toggle مجموعة في النافذة ─────────────────────────────────
function _gdsPrepToggleModalCat(cat) {
  const key = "modal_" + cat;
  _gdsPrep.collapsed[key] = !_gdsPrep.collapsed[key];
  const body  = document.getElementById("gdsPrepModalCat_" + cat);
  const arrow = body?.previousElementSibling?.querySelector(".gds-collapse-arrow");
  if (body)  body.style.display = _gdsPrep.collapsed[key] ? "none" : "";
  if (arrow) arrow.style.transform = _gdsPrep.collapsed[key] ? "rotate(-90deg)" : "";
}

// ── التحقق من الحد عند الإدخال الأولي (لا يمرر القيمة إذا تجاوزت) ──
function _gdsPrepValidateInput(idx, field, inputEl) {
  const line = _gdsPrep.lines.find(l => l.pid === Number(idx)); if (!line) return;

const val  = parseFloat(inputEl.value) || 0;
  const u    = _gdsPrepUnitSize(line);
  if (val < 0) {
    inputEl.style.borderColor = "var(--red)";
    inputEl.title = "القيمة لا يمكن أن تكون سالبة";
    inputEl.value = 0;
    return;
  }
  const totalIfCarton = field === "prepCarton" ? val * u + line.prepUnite : line.prepCarton * u + val;
  if (totalIfCarton > line.qty) {
    inputEl.style.borderColor = "var(--red)";
    inputEl.title = "القيمة تتجاوز المخزون";
    return;
  }
inputEl.style.borderColor = "";
  inputEl.title = "";
  if (field === "prepCarton") {
    line.prepCarton = val;
  } else {
    // تحويل U إلى C/F إذا كانت تساوي أو تتجاوز حجم الـ fardeau
    if (u > 0 && val >= u) {
      const addCarton = Math.floor(val / u);
      const remUnite  = Math.round(val % u);
      line.prepCarton = (line.prepCarton || 0) + addCarton;
      line.prepUnite  = remUnite;
      // تحديث الـ inputs في الواجهة
      const row = inputEl.closest("tr");
      if (row) {
        const cartonInp = row.querySelector("[data-field='prepCarton']");
        if (cartonInp) cartonInp.value = line.prepCarton || "";
        inputEl.value = remUnite || "";
      }
    } else {
      line.prepUnite = val;
    }
  }
}

function gdsPrepShowCharge(pid) {
  const modal = document.getElementById("gdsPrepHistModal");
  const title = document.getElementById("gdsPrepHistTitle");
  const body  = document.getElementById("gdsPrepHistBody");
  if (!modal || !body) return;

  const line = _gdsPrep.lines.find(l => l.pid === pid);
  const u    = line ? _gdsPrepUnitSize(line) : 0;
  title.textContent = `Chargement — ${line?.name || pid}`;

  // جمع كل moves لهذا المنتج مع picking info
  const rows = [];
  Object.entries(_gdsPrep.byPicking).forEach(([pickId, moves]) => {
    const pick = _gdsPrep.pickingsMap[Number(pickId)] || {};
    moves.filter(m => m.product_id?.[0] === pid).forEach(m => {
      rows.push({
        van:     (pick.van     || "—").toString().replace(/^"|"$/g, ''),
      partner: (pick.partner_id?.[1] || "—").toString().replace(/^"|"$/g, ''),
      pickRef: (pick.name    || String(pickId)).replace(/^"|"$/g, ''),
        qty:     m.qty_done   || 0,
        date:    m.date       ? m.date.slice(11,16) : "—",
        pickRef: (pick.name || String(pickId)).replace(/^"|"$/g, ''),
      });
    });
  });

  // كشف jumlage = نفس الـ van ظهر أكثر من مرة
  // كشف jumlage = نفس الـ van أو نفس الـ partner له أكثر من picking
  // دمج rows بنفس الـ pickRef أولاً
  const merged = {};
  rows.forEach(r => {
    const key = r.qty + "_" + r.van + "_" + r.partner + "_" + r.date;
    if (!merged[key]) merged[key] = { ...r };
    else merged[key].qty += r.qty;
  });
  const mergedRows = Object.values(merged);
  console.log("mergedRows:", mergedRows.length, mergedRows.map(r=>({ref:r.pickRef, qty:r.qty})));
  console.log("merged keys:", Object.keys(merged));
  console.log("rows pickRefs:", rows.map(r => JSON.stringify(r.pickRef)));

  const vanCount     = {};
  const partnerCount = {};
  mergedRows.forEach(r => {
    vanCount[r.van]         = (vanCount[r.van]         || 0) + 1;
    partnerCount[r.partner] = (partnerCount[r.partner] || 0) + 1;
  });

  if (!rows.length) {
    body.innerHTML = `<div style="padding:16px;color:var(--text3);text-align:center;">Aucun chargement trouvé</div>`;
  } else {
    body.innerHTML = `<table class="gds-table" style="font-size:11px;">
      <thead><tr>
        <th>Van</th><th>Livreur</th><th>C/F</th><th>U</th><th>Heure</th><th>Transfert</th>
      </tr></thead><tbody>
${rows.map(r => {
        const vanJuml     = vanCount[r.van]         > 1;
        const partnerJuml = partnerCount[r.partner] > 1;
        const rowJuml     = vanJuml || partnerJuml;
        return `<tr style="${rowJuml ? 'background:rgba(251,146,60,.15);' : ''}">
          <td>${escHtml(r.van)}${vanJuml ? ' <span style="color:var(--orange);font-weight:700;" title=""></span>' : ''}</td>
          <td>${escHtml(r.partner)}${partnerJuml ? ' <span style="color:var(--orange);font-weight:700;" title=""></span>' : ''}</td>
          <td style="text-align:right;font-weight:600;">${u > 0 ? Math.floor(r.qty / u) : '—'}</td>
          <td style="text-align:right;">${u > 0 ? Math.round(r.qty % u) : r.qty}</td>
          <td style="text-align:center;">${r.date}</td>
          <td style="text-align:center;">${escHtml(r.pickRef)}</td>
        </tr>`;
      }).join("")}
      </tbody>
      <tfoot><tr>
        <td colspan="2" style="font-weight:700;">Total</td>
        <td style="text-align:right;font-weight:700;">${u > 0 ? Math.floor(mergedRows.reduce((s,r)=>s+r.qty,0) / u) : '—'}</td>
        <td style="text-align:right;font-weight:700;">${u > 0 ? Math.round(mergedRows.reduce((s,r)=>s+r.qty,0) % u) : mergedRows.reduce((s,r)=>s+r.qty,0)}</td>
        <td colspan="2"></td>
      </tr></tfoot>
    </table>`;
  }
  modal.style.display = "flex";
}

// ── زر +/− في وضع التعديل ────────────────────────────────────
function _gdsPrepDelta(pid, field, dir, btn) {
  const line = _gdsPrep.lines.find(l => l.pid === pid); if (!line) return;
  const deltaField = field === "prepCarton" ? "_deltaCarton" : "_deltaUnite";
  line[deltaField] = (line[deltaField] || 0) + dir;
  // تحديث input
  const row = btn.closest("tr");
  const inp = row.querySelector(`[data-field="${field === "prepCarton" ? "deltaCarton" : "deltaUnite"}"]`);
  if (inp) inp.value = line[deltaField];
}

function _gdsPrepDeltaInput(pid, field, inputEl) {
  const line = _gdsPrep.lines.find(l => l.pid === pid); if (!line) return;
  const val = parseFloat(inputEl.value) || 0;
  if (field === "prepUnite") {
    const u = _gdsPrepUnitSize(line);
    if (u > 0 && Math.abs(val) >= u) {
      const sign      = val >= 0 ? 1 : -1;
      const addCarton = sign * Math.floor(Math.abs(val) / u);
      const remUnite  = sign * Math.round(Math.abs(val) % u);
      line._deltaCarton = (line._deltaCarton || 0) + addCarton;
      line._deltaUnite  = remUnite;
      const row = inputEl.closest("tr");
      if (row) {
        const cartonInp = row.querySelector("[data-field='deltaCarton']");
        if (cartonInp) cartonInp.value = line._deltaCarton;
        inputEl.value = remUnite;
      }
      return;
    }
  }
  const deltaField = field === "prepCarton" ? "_deltaCarton" : "_deltaUnite";
  line[deltaField] = val;
}

// ── تأكيد النافذة ─────────────────────────────────────────────
function gdsPrepModalConfirm() {
  const isEdit = _gdsPrep.isEdit;
  const now    = new Date().toLocaleTimeString("fr-FR");
  let errors   = [];

  if (!isEdit) {
    // collect all values first, validate, then apply
    const vals = {};
    document.querySelectorAll(".gds-prep-input[data-field='prepCarton']").forEach(inp => {
      vals[inp.dataset.pid] = { c: parseFloat(inp.value) || 0 };
    });
    document.querySelectorAll(".gds-prep-input[data-field='prepUnite']").forEach(inp => {
      if (vals[inp.dataset.pid]) vals[inp.dataset.pid].u = parseFloat(inp.value) || 0;
    });
    Object.entries(vals).forEach(([pid, v]) => {
      const line = _gdsPrep.lines.find(l => l.pid === Number(pid)); if (!line) return;
      const unitSize = _gdsPrepUnitSize(line);
      if (v.c * unitSize + (v.u || 0) > line.qty) {
        errors.push(line.name);
      } else {
        const wasEmpty = line.prepCarton === 0 && line.prepUnite === 0;
        line.prepCarton = v.c;
        line.prepUnite  = v.u || 0;
        if (line.prepCarton > 0 || line.prepUnite > 0)
          line.history.push({ ts: now, type: "Ajout", carton: line.prepCarton, unite: line.prepUnite });
      }
    });
  } else {
    _gdsPrep.lines.forEach(line => {
      const dc = line._deltaCarton || 0;
      const du = line._deltaUnite  || 0;
      if (dc === 0 && du === 0) return;
      const u    = _gdsPrepUnitSize(line);
      const newC = line.prepCarton + dc;
      const newU = line.prepUnite  + du;
      if (newC < 0 || newU < 0 || newC * u + newU > line.qty) {
        errors.push(line.name);
        line._hasError = true;
        return;
      }
      line._hasError    = false;
      line.prepCarton   = newC;
      line.prepUnite    = newU;
      const type = dc > 0 || du > 0 ? "Augmentation" : "Réduction";
      line.history.push({ ts: now, type, carton: dc, unite: du });
      line._deltaCarton = 0;
      line._deltaUnite  = 0;
    });
  }

  if (errors.length) {
    addNotif(`⚠ Valeurs dépassant le stock: ${errors.slice(0,3).join(", ")}${errors.length>3?" …":""}`, "error");
    if (isEdit) {
      // re-render modal to show red rows, don't close
      _gdsPrepRenderModalBody();
    }
    return;
  }

  _gdsPrep.loaded = true;
  gdsPrepCloseModal();
  _gdsPrepSave();
  renderGdsPreparation();
  if (!isEdit) gdsPrepDownloadPrepPdf();
  addNotif("✓ Préparation enregistrée", "success");
}
async function _gdsPrepIsVanLocation(locId) {
  if (!locId) return false;
  try {
    const r = await fetch("/api/web/dataset/call_kw", {
      method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:74, params:{
        model:"stock.location", method:"search_read",
        args:[[["id","=",locId],["location_id","=",GDS_VAN_LOCATION_PARENT],["usage","=","internal"]]],
        kwargs:{ fields:["id"], limit:1 }
      }})
    });
    return ((await r.json())?.result || []).length > 0;
  } catch(_) { return false; }
}
// ── جلب تحركات الشحن من GDS → Vans ──────────────────────────
function _gdsPrepShowExcludeInput() {
  document.getElementById("gdsPrepExcluPopup")?.remove();
  const btn  = document.querySelector("[title='Exclure un transfert']");
  const rect = btn ? btn.getBoundingClientRect() : { bottom: 100, left: 100 };

  const popup = document.createElement("div");
  popup.id = "gdsPrepExcluPopup";
  popup.style.cssText = `position:fixed;top:${rect.bottom+6}px;left:${rect.left}px;
    background:var(--bg2);border:1px solid var(--border);border-radius:10px;
    box-shadow:0 8px 24px #0005;padding:14px;z-index:9999;min-width:280px;`;
  popup.innerHTML = `
    <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:8px;">Exclure un transfert</div>
    <input id="gdsPrepExcluRef" type="text" placeholder="BT/26/WF/ORN/00001"
      style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:6px;
      padding:5px 8px;font-size:12px;background:var(--bg3);color:var(--text);margin-bottom:8px;"/>
    <div style="display:flex;gap:6px;justify-content:flex-end;">
      <button class="gds-refresh-btn" onclick="_gdsPrepAddExclude()" style="font-size:11px;background:#f06060;color:white;">✓ Exclure</button>
      <button class="gds-refresh-btn" onclick="document.getElementById('gdsPrepExcluPopup')?.remove()" style="font-size:11px;background:var(--text3);">✕</button>
    </div>`;

  document.body.appendChild(popup);
  document.getElementById("gdsPrepExcluRef")?.focus();

  // إغلاق عند الضغط خارجها
  setTimeout(() => {
    document.addEventListener("mousedown", function _close(e) {
      if (!e.target.closest("#gdsPrepExcluPopup")) {
        document.getElementById("gdsPrepExcluPopup")?.remove();
        document.removeEventListener("mousedown", _close);
      }
    });
  }, 100);
}

async function _gdsPrepAddExclude() {
  const input = document.getElementById("gdsPrepExcluRef");
  const ref   = input?.value.trim();
  if (!ref) return;

  _gdsPrepExcluNotif("Vérification…", "info");
  try {
    const r = await fetch("/api/web/dataset/call_kw", {
      method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:70, params:{
        model:"stock.picking", method:"search_read",
        args:[[["name","=",ref]]],
        kwargs:{ fields:["id","name"], limit:1 }
      }})
    });
    const res = (await r.json())?.result || [];
    if (!res.length) {
      _gdsPrepExcluNotif(`✗ Référence introuvable: ${ref}`, "error");
      return;
    }
    const pick = res[0];
    const locSrc  = pick.location_id?.[0];
    const locDest = pick.location_dest_id?.[0];
    if (locSrc !== GDS_WAREHOUSE_ID || !_gdsPrepIsVanLocation(locDest)) {
      _gdsPrepExcluNotif(`✗ Ce transfert n'est pas de Stock → Van`, "error");
      return;
    }
    if (_gdsPrep.excludedPickings.includes(ref)) {
      _gdsPrepExcluNotif(`Déjà exclu: ${ref}`, "warning");
      return;
    }
    _gdsPrep.excludedPickings.push(ref);
    document.getElementById("gdsPrepExcluPopup")?.remove();
    _gdsPrepUpdateExcluBtn();
    _gdsPrepExcluNotif(`✓ Exclu: ${ref} — Actualisez les chargements`, "success");
  } catch(e) {
    _gdsPrepExcluNotif("Erreur: " + e.message, "error");
  }
}

function _gdsPrepExcluNotif(msg, type) {
  document.getElementById("gdsPrepExcluNotif")?.remove();
  const colors = { success:"var(--green)", error:"var(--red)", warning:"#f59e0b", info:"var(--text3)" };
  const n = document.createElement("div");
  n.id = "gdsPrepExcluNotif";
  n.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:99999;
    background:var(--bg2);border:1px solid ${colors[type]||"var(--border)"};
    border-left:4px solid ${colors[type]||"var(--border)"};
    border-radius:8px;padding:10px 16px;font-size:12px;color:var(--text);
    box-shadow:0 4px 16px #0004;max-width:320px;transition:opacity .3s;`;
  n.textContent = msg;
  document.body.appendChild(n);
  if (type !== "info") setTimeout(() => { n.style.opacity="0"; setTimeout(()=>n.remove(),300); }, 3000);
}

function _gdsPrepUpdateExcluBtn() {
  const btn = document.getElementById("gdsPrepExcluBtn");
  if (!btn) return;
  const n = _gdsPrep.excludedPickings.length;
  btn.textContent    = `Exclu (${n})`;
  btn.disabled       = n === 0;
  btn.style.opacity  = n ? "1" : "0.4";
  btn.style.cursor   = n ? "pointer" : "default";
}

function _gdsPrepShowExcludeList() {
  // إزالة modal سابق
  document.getElementById("gdsPrepExcluModal")?.remove();
  const modal = document.createElement("div");
  modal.id = "gdsPrepExcluModal";
  modal.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;";
  modal.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;min-width:320px;max-width:480px;box-shadow:0 8px 24px #0005;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);">
        <span style="font-weight:600;font-size:13px;">Transferts exclus</span>
        <button onclick="document.getElementById('gdsPrepExcluModal').remove()" style="background:none;border:none;cursor:pointer;font-size:16px;color:var(--text2);">✕</button>
      </div>
      <div style="padding:10px 14px;max-height:300px;overflow-y:auto;">
        ${_gdsPrep.excludedPickings.length === 0
          ? `<div style="color:var(--text3);font-size:12px;">Aucun transfert exclu</div>`
          : _gdsPrep.excludedPickings.map((ref,i) => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">
              <span style="font-size:12px;color:var(--text);">${ref}</span>
              <button onclick="_gdsPrepRemoveExclude(${i})" style="background:var(--red);border:none;border-radius:5px;color:#fff;font-size:11px;padding:2px 8px;cursor:pointer;">✕ Retirer</button>
            </div>`).join("")
        }
      </div>
      <div style="padding:10px 14px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;">
        ${_gdsPrep.excludedPickings.length ? `<button class="gds-refresh-btn" style="background:var(--red);" onclick="_gdsPrepClearExcludes()">Tout retirer</button>` : ""}
        <button class="gds-refresh-btn" style="background:var(--text3);" onclick="document.getElementById('gdsPrepExcluModal').remove()">Fermer</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function _gdsPrepRemoveExclude(i) {
  _gdsPrep.excludedPickings.splice(i, 1);
  _gdsPrepUpdateExcluBtn();
  _gdsPrepShowExcludeList(); // refresh modal
  const statusEl = document.getElementById("gdsPrepChargeStatus");
  if (statusEl) statusEl.textContent = "✓ Retiré — Actualisez les chargements";
}

function _gdsPrepClearExcludes() {
  _gdsPrep.excludedPickings = [];
  _gdsPrepUpdateExcluBtn();
  document.getElementById("gdsPrepExcluModal")?.remove();
  const statusEl = document.getElementById("gdsPrepChargeStatus");
  if (statusEl) statusEl.textContent = "✓ Tous retirés — Actualisez les chargements";
}

function _gdsPrepShowOutOfDateInput() {
  document.getElementById("gdsPrepOutOfDatePopup")?.remove();
  const btn  = document.querySelector("[title='Ajouter transfert hors date']");
  const rect = btn ? btn.getBoundingClientRect() : { bottom: 100, left: 100 };

  const popup = document.createElement("div");
  popup.id = "gdsPrepOutOfDatePopup";
  popup.style.cssText = `position:fixed;top:${rect.bottom+6}px;left:${rect.left}px;
    background:var(--bg2);border:1px solid var(--border);border-radius:10px;
    box-shadow:0 8px 24px #0005;padding:14px;z-index:9999;min-width:280px;`;
  popup.innerHTML = `
    <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:8px;">Ajouter transfert hors date</div>
    <input id="gdsPrepOutOfDateRef" type="text" placeholder="BT/26/WF/ORN/00001"
      style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:6px;
      padding:5px 8px;font-size:12px;background:var(--bg3);color:var(--text);margin-bottom:8px;"/>
    <div style="display:flex;gap:6px;justify-content:flex-end;">
      <button class="gds-refresh-btn" onclick="_gdsPrepAddOutOfDate()" style="font-size:11px;background:var(--orange,#f59e0b);color:white;">✓ Ajouter</button>
      <button class="gds-refresh-btn" onclick="document.getElementById('gdsPrepOutOfDatePopup')?.remove()" style="font-size:11px;background:var(--text3);">✕</button>
    </div>`;

  document.body.appendChild(popup);
  document.getElementById("gdsPrepOutOfDateRef")?.focus();

  setTimeout(() => {
    document.addEventListener("mousedown", function _close(e) {
      if (!e.target.closest("#gdsPrepOutOfDatePopup")) {
        document.getElementById("gdsPrepOutOfDatePopup")?.remove();
        document.removeEventListener("mousedown", _close);
      }
    });
  }, 100);
}

async function _gdsPrepAddOutOfDate() {
  const input = document.getElementById("gdsPrepOutOfDateRef");
  const ref   = input?.value.trim();
  if (!ref) return;

  _gdsPrepOutOfDateNotif("Vérification…", "info");
  try {
    const r = await fetch("/api/web/dataset/call_kw", {
      method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:71, params:{
        model:"stock.picking", method:"search_read",
        args:[[["name","=",ref]]],
        kwargs:{ fields:["id","name","scheduled_date","location_id","location_dest_id"], limit:1 }
      }})
    });
    const res = (await r.json())?.result || [];
if (!res.length) {
      _gdsPrepOutOfDateNotif(`✗ Référence introuvable: ${ref}`, "error");
      return;
    }
    const picking = res[0];
    const locSrc2  = picking.location_id?.[0];
    const locDest2 = picking.location_dest_id?.[0];
    if (locSrc2 !== GDS_WAREHOUSE_ID || !_gdsPrepIsVanLocation(locDest2)) {
      _gdsPrepOutOfDateNotif(`✗ Ce transfert n'est pas de Stock → Van`, "error");
      return;
    }
    // التحقق أن التحويل خارج التاريخ المحدد
    const chargeFrom = _gdsPrep.chargeFrom;
    const chargeTo   = _gdsPrep.chargeTo;
    if (chargeFrom && chargeTo && picking.scheduled_date) {
      const d = new Date(picking.scheduled_date);
      const from = new Date(chargeFrom);
      const to   = new Date(chargeTo);
      if (d >= from && d <= to) {
        _gdsPrepOutOfDateNotif(`⚠ Ce transfert est dans la plage de date — utilisez "Exclure" à la place`, "warning");
        return;
      }
    }
    _gdsPrep.outOfDateTransferts.push({ ref, id: picking.id, scheduledDate: picking.scheduled_date });
    document.getElementById("gdsPrepOutOfDatePopup")?.remove();
    _gdsPrepUpdateOutOfDateBtn();
    _gdsPrepOutOfDateNotif(`✓ Ajouté hors date: ${ref} — Actualisez les chargements`, "success");
  } catch(e) {
    _gdsPrepOutOfDateNotif("Erreur: " + e.message, "error");
  }
}

function _gdsPrepOutOfDateNotif(msg, type) {
  document.getElementById("gdsPrepOutOfDateNotif")?.remove();
  const colors = { success:"var(--green)", error:"var(--red)", warning:"#f59e0b", info:"var(--text3)" };
  const n = document.createElement("div");
  n.id = "gdsPrepOutOfDateNotif";
  n.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:99999;
    background:var(--bg2);border:1px solid ${colors[type]||"var(--border)"};
    border-left:4px solid ${colors[type]||"var(--border)"};
    border-radius:8px;padding:10px 16px;font-size:12px;color:var(--text);
    box-shadow:0 4px 16px #0004;max-width:320px;transition:opacity .3s;`;
  n.textContent = msg;
  document.body.appendChild(n);
  if (type !== "info") setTimeout(() => { n.style.opacity="0"; setTimeout(()=>n.remove(),300); }, 3000);
}

function _gdsPrepUpdateOutOfDateBtn() {
  const btn = document.getElementById("gdsPrepOutOfDateBtn");
  if (!btn) return;
  const n = _gdsPrep.outOfDateTransferts.length;
  btn.textContent   = `Hors date (${n})`;
  btn.disabled      = n === 0;
  btn.style.opacity = n ? "1" : "0.4";
  btn.style.cursor  = n ? "pointer" : "default";
}

function _gdsPrepShowOutOfDateList() {
  document.getElementById("gdsPrepOutOfDateModal")?.remove();
  const modal = document.createElement("div");
  modal.id = "gdsPrepOutOfDateModal";
  modal.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;";
  modal.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;min-width:320px;max-width:480px;box-shadow:0 8px 24px #0005;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);">
        <span style="font-weight:600;font-size:13px;">Transferts hors date</span>
        <button onclick="document.getElementById('gdsPrepOutOfDateModal').remove()" style="background:none;border:none;cursor:pointer;font-size:16px;color:var(--text2);">✕</button>
      </div>
      <div style="padding:10px 14px;max-height:300px;overflow-y:auto;">
        ${_gdsPrep.outOfDateTransferts.length === 0
          ? `<div style="color:var(--text3);font-size:12px;">Aucun transfert hors date</div>`
          : _gdsPrep.outOfDateTransferts.map((t,i) => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">
              <div>
                <span style="font-size:12px;color:var(--text);">${t.ref}</span>
                ${t.scheduledDate ? `<br><span style="font-size:10px;color:var(--text3);">${_gdsPrepFmtDt(t.scheduledDate)}</span>` : ""}
              </div>
              <button onclick="_gdsPrepRemoveOutOfDate(${i})" style="background:var(--orange,#f59e0b);border:none;border-radius:5px;color:#fff;font-size:11px;padding:2px 8px;cursor:pointer;">✕ Retirer</button>
            </div>`).join("")
        }
      </div>
      <div style="padding:10px 14px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;">
        ${_gdsPrep.outOfDateTransferts.length ? `<button class="gds-refresh-btn" style="background:var(--orange,#f59e0b);" onclick="_gdsPrepClearOutOfDate()">Tout retirer</button>` : ""}
        <button class="gds-refresh-btn" style="background:var(--text3);" onclick="document.getElementById('gdsPrepOutOfDateModal').remove()">Fermer</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function _gdsPrepRemoveOutOfDate(i) {
  _gdsPrep.outOfDateTransferts.splice(i, 1);
  _gdsPrepUpdateOutOfDateBtn();
  _gdsPrepShowOutOfDateList();
  const statusEl = document.getElementById("gdsPrepChargeStatus");
  if (statusEl) statusEl.textContent = "✓ Retiré — Actualisez les chargements";
}

function _gdsPrepClearOutOfDate() {
  _gdsPrep.outOfDateTransferts = [];
  _gdsPrepUpdateOutOfDateBtn();
  document.getElementById("gdsPrepOutOfDateModal")?.remove();
  const statusEl = document.getElementById("gdsPrepChargeStatus");
  if (statusEl) statusEl.textContent = "✓ Tous retirés — Actualisez les chargements";
}

async function gdsPrepFetchCharge() {
  const statusEl = document.getElementById("gdsPrepChargeStatus");
  const dtInput  = document.getElementById("gdsPrepChargeFrom");
  if (!dtInput) return;

  // لا نقرأ من input.value — نأخذ مباشرة من _gdsPrep (ISO مخزون بـ onChange)
  const dtVal = _gdsPrep.chargeFrom;
  if (!dtVal) { if (statusEl) statusEl.textContent = "Choisir une date/heure"; return; }

  const dtToVal = _gdsPrep.chargeTo || null;

  // Convertir ISO local → UTC pour Odoo
  function _isoLocalToOdoo(iso) {
    if (!iso) return null;
    const [dp, tp="00:00"] = iso.split("T");
    const [y,m,d] = dp.split("-");
    const [h,mi]  = tp.split(":");
    const local   = new Date(+y, +m-1, +d, +h, +mi);
    return local.toISOString().replace("T"," ").slice(0,19);
  }

  const odooFrom = _isoLocalToOdoo(dtVal);
  const odooTo   = _isoLocalToOdoo(dtToVal);

  if (statusEl) statusEl.textContent = "Chargement…";

  try {
    // 1) Récupérer les child locations des vans
    const rLoc = await fetch("/api/web/dataset/call_kw", {
      method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:50, params:{
        model:"stock.location", method:"search_read",
        args:[[["location_id","=",GDS_VAN_LOCATION_PARENT],["usage","=","internal"]]],
        kwargs:{ fields:["id"], limit:200 }
      }})
    });
    const vanLocIds = ((await rLoc.json())?.result || []).map(l => l.id);

    if (!vanLocIds.length) {
      if (statusEl) statusEl.textContent = "Aucun emplacement van trouvé";
      return;
    }

    // 2) Récupérer stock.move.line : GDS_WAREHOUSE_ID → vanLocIds, depuis dtVal
    const rMoves = await fetch("/api/web/dataset/call_kw", {
      method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:51, params:{
        model:"stock.move.line", method:"search_read",
        args:[[
          ["location_id",    "=",  GDS_WAREHOUSE_ID],
          ["location_dest_id","in", vanLocIds],
          ["state",          "=",  "done"],
          ["date",           ">=", odooFrom],
          ...(odooTo ? [["date", "<=", odooTo]] : []),
        ]],
        kwargs:{ fields:["product_id","qty_done","product_uom_id","date","lot_id","picking_id","location_dest_id"], limit:5000 }
      }})
    });
    const moves = (await rMoves.json())?.result || [];

    // 3b) جلب بيانات الـ pickings
    const pickingIds = [...new Set(moves.map(m => m.picking_id?.[0]).filter(Boolean))];
    let pickingsMap = {};
    if (pickingIds.length) {
      const rPick = await fetch("/api/web/dataset/call_kw", {
        method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:52, params:{
          model:"stock.picking", method:"search_read",
          args:[[["id","in",pickingIds]]],
          kwargs:{ fields:["id","name","partner_id","date_done"], limit:500 }
        }})
      });
      const pickRes = (await rPick.json())?.result || [];
    pickRes.forEach(p => {
      if (p.name) p.name = p.name.replace(/^"|"$/g, '');
      pickingsMap[p.id] = p;
    });
    // إضافة اسم الـ van من أول move لكل picking
    moves.forEach(m => {
      const pickId = m.picking_id?.[0];
      if (pickId && pickingsMap[pickId] && !pickingsMap[pickId].van) {
        const fullPath = m.location_dest_id?.[1] || "";
    const parts    = fullPath.split("/");
    pickingsMap[pickId].van = parts[parts.length - 1].trim() || "—";
      }
    });
    }

    // تطبيق الاستثناءات
    const excludedIds = new Set(
      Object.values(pickingsMap)
        .filter(p => _gdsPrep.excludedPickings.includes(p.name))
        .map(p => p.id)
    );
    const filteredMoves = moves.filter(m => !excludedIds.has(m.picking_id?.[0]));

    // تجميع الـ moves حسب picking
    const byPicking = {};
    filteredMoves.forEach(m => {
      const pickId = m.picking_id?.[0];
      if (!pickId) return;
      if (!byPicking[pickId]) byPicking[pickId] = [];
      byPicking[pickId].push(m);
    });

  // جلب unitSize من product.packaging للمنتجات غير الموجودة في lines
const allPids = [...new Set(filteredMoves.map(m => m.product_id[0]))];
const missingPids = allPids.filter(pid => !_gdsPrep.lines.find(l => l.pid === pid));

const pkgMap = {};
if (missingPids.length) {
  const rPkg = await fetch("/api/web/dataset/call_kw", {
    method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:55, params:{
      model:"product.packaging", method:"search_read",
      args:[[["product_id","in",missingPids]]],
      kwargs:{ fields:["product_id","qty"], limit:500 }
    }})
  });
  ((await rPkg.json())?.result || []).forEach(pkg => {
    const pid = pkg.product_id[0];
    if (!pkgMap[pid]) pkgMap[pid] = pkg.qty || 0;
  });
}
  // حفظ في _gdsPrep لاستخدامها في الأزرار
    _gdsPrep.pickingsMap = pickingsMap;
    _gdsPrep.byPicking   = byPicking;

    // 3) Agréger par product_id
    const agg = {};
    filteredMoves.forEach(m => {
      const pid = m.product_id[0];
      if (!agg[pid]) agg[pid] = 0;
      agg[pid] += m.qty_done || 0;
    });

    // جلب moves الخاصة بـ outOfDateTransferts وإضافتها
    if (_gdsPrep.outOfDateTransferts.length) {
      const outIds = _gdsPrep.outOfDateTransferts.map(t => t.id).filter(Boolean);
      if (outIds.length) {
        try {
          const rOut = await fetch("/api/web/dataset/call_kw", {
            method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:72, params:{
              model:"stock.move.line", method:"search_read",
              args:[[["picking_id","in",outIds],["state","=","done"]]],
              kwargs:{ fields:["product_id","qty_done","picking_id"], limit:2000 }
            }})
          });
          const outMoves = (await rOut.json())?.result || [];
          outMoves.forEach(m => {
            const pid = m.product_id?.[0]; if (!pid) return;
            if (!agg[pid]) agg[pid] = 0;
            agg[pid] += m.qty_done || 0;
          });
          // إضافة pickings hors date إلى pickingsMap وbyPicking
          const rOutPick = await fetch("/api/web/dataset/call_kw", {
            method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:73, params:{
              model:"stock.picking", method:"search_read",
              args:[[["id","in",outIds]]],
              kwargs:{ fields:["id","name","partner_id","date_done"], limit:200 }
            }})
          });
          ((await rOutPick.json())?.result || []).forEach(p => {
            if (p.name) p.name = p.name.replace(/^"|"$/g, '');
            p._outOfDate = true;
            pickingsMap[p.id] = p;
            const ms = outMoves.filter(m => m.picking_id?.[0] === p.id);
            if (ms.length) {
              if (!byPicking[p.id]) byPicking[p.id] = [];
              byPicking[p.id].push(...ms);
            }
          });
        } catch(e) {
          console.warn("[GdsPrep] outOfDate fetch error:", e);
        }
      }
    }



   _gdsPrep.chargeData = {};

   // إضافة المنتجات المشحونة غير الموجودة في lines
    const prepPids = new Set(
      _gdsPrep.lines
        .filter(l => l.prepCarton > 0 || l.prepUnite > 0)
        .map(l => String(l.pid))
    );
    const extraPids = Object.entries(agg)
      .filter(([pid, total]) => total > 0 && !prepPids.has(String(pid)))
      .map(([pid]) => Number(pid));

    if (extraPids.length) {
      // جلب أسماء المنتجات الإضافية
      const rExtra = await fetch("/api/web/dataset/call_kw", {
        method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:53, params:{
          model:"product.product", method:"search_read",
          args:[[["id","in",extraPids]]],
          kwargs:{ fields:["id","name","categ_id","packaging_quantity_1","quantity_svl"], limit:500 }
        }})
      });
      const extraProds = {};
((await rExtra.json())?.result || []).forEach(p => { extraProds[p.id] = p; });

// جلب unitSize من product.packaging
const rPkg = await fetch("/api/web/dataset/call_kw", {
  method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
  body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:54, params:{
    model:"product.packaging", method:"search_read",
    args:[[["product_id","in",extraPids]]],
    kwargs:{ fields:["product_id","qty"], limit:500 }
  }})
});
const extraPkgMap = {};
((await rPkg.json())?.result || []).forEach(pkg => {
  const pid = pkg.product_id[0];
  if (!extraPkgMap[pid]) extraPkgMap[pid] = pkg.qty || 0;
});

      extraPids.forEach(pid => {
        const total = agg[pid] || 0;
        const p     = extraProds[pid] || {};
        const name  = p.name || `pid:${pid}`;
        const categ = p.categ_id?.[1] || "— Chargé sans préparation —";
        // تحديث إذا موجود مسبقاً كـ extraCharge
        const existing = _gdsPrep.lines.find(l => l.pid === pid);
        if (existing) { existing._extraCharge = true; return; }
        const pkgQty = p.packaging_quantity_1 || 0;
_gdsPrep.lines.push({
  pid, name, categ,
  carton: pkgQty, qty: pkgQty, prepCarton: 0, prepUnite: 0, unitSize: pkgQty,
  history: [], check: false, ecart: 0, _extraCharge: true,
});
        // إضافة chargeData
        _gdsPrep.chargeData[pid] = {
          chargeCarton: 0,
          chargeUnite:  Math.round(total),
          chargeTotal:  total,
        };
      });
    }
    // 4) Mapper sur les lignes prep (avec unitSize pour calculer C/F et U)
    // 4) Mapper sur les lignes prep (avec unitSize pour calculer C/F et U)
Object.entries(agg).forEach(([pidStr, total]) => {
  const pid  = Number(pidStr);
  const line = _gdsPrep.lines.find(l => l.pid === pid);
  const u    = line ? _gdsPrepUnitSize(line) : (pkgMap[pid] || 0);
  _gdsPrep.chargeData[pid] = {
    chargeCarton: u > 0 ? Math.floor(total / u) : 0,
    chargeUnite:  u > 0 ? Math.round(total % u) : Math.round(total),
    chargeTotal:  total,
  };
});
    const nb = Object.values(agg).filter(v => v > 0).length;
    if (statusEl) statusEl.textContent = `${nb} article(s) chargé(s) — ${new Date().toLocaleTimeString("fr-FR")}`;
_gdsPrepSave();
    // تحديث أزرار الموزعين مباشرة بدون إعادة رندر كاملة
    const pickBtnsEl = document.getElementById("gdsPrepPickingBtns");
    if (pickBtnsEl) pickBtnsEl.innerHTML = _gdsPrepRenderPickingBtns();
 _gdsPrepFetchSuggested().then(sugg => {
      _gdsPrep.suggested = sugg;
      _gdsPrepRenderTable();
    });

  } catch(e) {
    if (statusEl) statusEl.textContent = "Erreur: " + e.message;
  }
}

// ── جلب الكميات المقترحة (BL assigned غير موزعة) ─────────────
async function _gdsPrepFetchSuggested() {
  try {
    const today = new Date().toISOString().slice(0,10);

    // 1) plannings مفتوحة اليوم
    const r1 = await fetch("/api/web/dataset/call_kw", {
      method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:60, params:{
        model:"planning.planning", method:"search_read",
        args:[[["date_start","=",today],["state","not in",["done","cancel"]]]],
        kwargs:{ fields:["id"], limit:500 }
      }})
    });
    const todayPlanningIds = new Set(((await r1.json())?.result||[]).map(p=>p.id));

    // 2) BLs prêt
    const r2 = await fetch("/api/web/dataset/call_kw", {
      method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:61, params:{
        model:"stock.picking", method:"search_read",
        args:[[["picking_type_id","=",75],["state","=","assigned"]]],
        kwargs:{ fields:["id","delivery_planning_id","move_lines"], limit:5000 }
      }})
    });
    const picks = (await r2.json())?.result || [];

    // 3) استثناء BLs في planning اليوم
    const filteredMoveIds = picks
      .filter(p => !p.delivery_planning_id || !todayPlanningIds.has(p.delivery_planning_id[0]))
      .flatMap(p => p.move_lines || []);
    if (!filteredMoveIds.length) return {};

    // 4) جلب moves
    const r3 = await fetch("/api/web/dataset/call_kw", {
      method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:62, params:{
        model:"stock.move", method:"search_read",
        args:[[["id","in",filteredMoveIds]]],
        kwargs:{ fields:["product_id","product_uom_qty"], limit:20000 }
      }})
    });
    const moves = (await r3.json())?.result || [];

    const agg = {};
    moves.forEach(m => {
      const pid = m.product_id?.[0]; if (!pid) return;
      agg[pid] = (agg[pid] || 0) + (m.product_uom_qty || 0);
    });
    return agg;
  } catch(e) {
    console.error("[GdsPrep] fetchSuggested:", e);
    return {};
  }
}

// ── جلب أسماء المنتجات المجهولة ──────────────────────────────
async function _gdsPrepFetchMissingNames() {
  const unknown = _gdsPrep.lines.filter(l => l.name.startsWith("pid:"));
  if (!unknown.length) return;
  const pids = unknown.map(l => l.pid);
  try {
    const r = await fetch("/api/web/dataset/call_kw", {
      method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:70, params:{
        model:"product.product", method:"search_read",
        args:[[["id","in",pids]]],
        kwargs:{ fields:["id","name","categ_id"], limit:500 }
      }})
    });
    const prods = (await r.json())?.result || [];
    prods.forEach(p => {
      const line = _gdsPrep.lines.find(l => l.pid === p.id);
      if (line) {
        line.name  = p.name;
        line.categ = p.categ_id?.[1] || line.categ;
      }
    });
    _gdsPrepSave();
    _gdsPrepRenderTable();
  } catch(e) { console.error("[GdsPrep] fetchMissingNames:", e); }
}

const _gdsPrepCols = (() => {
  const defaults = { stock:true, sugg:true, prep:true, charge:true, reste:true };
  try {
    const saved = JSON.parse(localStorage.getItem("wafa_gds_cols") || "{}");
    return Object.assign({}, defaults, saved);
  } catch(_) { return defaults; }
})();
function _gdsPrepToggleCol(col) {
  _gdsPrepCols[col] = !_gdsPrepCols[col];
  localStorage.setItem("wafa_gds_cols", JSON.stringify(_gdsPrepCols));
  const btn = document.getElementById("gdsPrepColBtn_" + col);
  if (btn) {
    btn.style.opacity = _gdsPrepCols[col] ? "1" : "0.45";
    btn.style.textDecoration = _gdsPrepCols[col] ? "none" : "line-through";
    btn.style.background = _gdsPrepCols[col] ? "var(--gds-color)" : "var(--bg3)";
    btn.style.color = _gdsPrepCols[col] ? "#fff" : "var(--text3)";
    btn.textContent = _gdsPrepCols[col] ? "Visible" : "Caché";
  }
  // حفظ الـ panel المفتوح قبل إعادة الرسم
  const openPanel = document.querySelector("[id^='gdsPrepColPanel_'][style*='flex']");
  const openCat   = openPanel ? openPanel.id.replace("gdsPrepColPanel_", "") : null;
  _gdsPrepRenderTable();
  // إعادة فتح الـ panel بعد الرسم
  if (openCat) {
    const restored = document.getElementById("gdsPrepColPanel_" + openCat);
    if (restored) restored.style.display = "flex";
  }
}
function _gdsPrepToggleColPanel(cat) {
  const panel = document.getElementById("gdsPrepColPanel_" + cat);
  if (!panel) return;
  const isOpen = panel.style.display !== "none";
  // أغلق كل الـ panels المفتوحة
  document.querySelectorAll("[id^='gdsPrepColPanel_']").forEach(p => p.style.display = "none");
  if (isOpen) return;
  panel.style.display = "flex";
  // listener للإغلاق عند الضغط خارج الإطار (مرة واحدة)
  setTimeout(() => {
    function _outsideClick(e) {
      if (!panel.contains(e.target) && !e.target.closest("button[onclick*='_gdsPrepToggleColPanel']")) {
        panel.style.display = "none";
        document.removeEventListener("click", _outsideClick);
      }
    }
    document.addEventListener("click", _outsideClick);
  }, 0);
}

// ── عرض الجدول الرئيسي ───────────────────────────────────────
function _gdsPrepRenderTable() {
  const wrap = document.getElementById("gdsPrepTableWrap");
  if (!wrap) return;

  // بناء nameMap من byPicking لمعرفة أسماء المنتجات المشحونة
  const nameMap = {};
  Object.values(_gdsPrep.byPicking || {}).forEach(moves => {
    moves.forEach(m => {
      if (m.product_id?.[0] && m.product_id?.[1]) nameMap[m.product_id[0]] = m.product_id[1];
    });
  });

  // المنتجات في preparation
  const prepSet = new Set(_gdsPrep.lines
    .filter(l => l.prepCarton > 0 || l.prepUnite > 0 || l._hasError)
    .map(l => l.pid));

  // المنتجات المشحونة غير الموجودة في preparation
  const extraLines = Object.entries(_gdsPrep.chargeData)
    .filter(([pid, ch]) => !prepSet.has(Number(pid)) && ch.chargeTotal > 0)
    .map(([pid], ei) => {
      const pidNum = Number(pid);
      const existingLine = _gdsPrep.lines.find(l => l.pid === pidNum);
      if (existingLine) {
        existingLine._extraCharge = true;
        return { line: existingLine, i: _gdsPrep.lines.indexOf(existingLine) };
      }
      const fromLine = _gdsPrep.lines.find(l => l.pid === pidNum);
      const name = nameMap[pidNum] || fromLine?.name || `pid:${pid}`;
      const newLine = {
        pid: pidNum, name, categ: "— Chargé sans préparation —",
        carton: 0, qty: 0, prepCarton: 0, prepUnite: 0, unitSize: extraPkgMap[pid] || 0,
        history: [], check: false, ecart: 0, _extraCharge: true,
      };
      _gdsPrep.lines.push(newLine);
      return { line: newLine, i: _gdsPrep.lines.length - 1 };
    });

const activeLines = [
    ..._gdsPrep.lines.map((line, i) => ({ line, i }))
      .filter(({ line }) => line.prepCarton > 0 || line.prepUnite > 0 || line._hasError),
    ...extraLines,
  ];

  if (!activeLines.length) {
    wrap.innerHTML = `<div class="gds-loading" style="color:var(--text3)">Aucun article préparé</div>`;
    return;
  }

  const byCateg = {};
  activeLines.forEach(({ line, i }) => {
    if (!byCateg[line.categ]) byCateg[line.categ] = [];
    byCateg[line.categ].push({ line, i });
  });

  const hasCharge = Object.keys(_gdsPrep.chargeData).length > 0;

  let html = "";
  Object.keys(byCateg).sort().forEach(cat => {
    const collapsed = !!_gdsPrep.collapsed["tbl_" + cat];
    html += `<div class="gds-category" style="margin:0 0 14px;">
      <div class="gds-category-title gds-category-toggle" onclick="_gdsPrepToggleTblCat('${escHtml(cat)}')">
        <svg id="gdsPrepArrow_${escHtml(cat)}" class="gds-collapse-arrow" style="transform:${collapsed?"rotate(-90deg)":""}" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"/></svg>
        ${escHtml(cat)}
      </div>
      <div id="gdsPrepTblCat_${escHtml(cat)}" style="display:${collapsed?"none":""}">
      <table class="gds-table" style="min-width:max-content;width:100%;">
        <thead>
          <tr>
            <th style="text-align:left;color:var(--text2)">Produit</th>
            ${_gdsPrepCols.stock ? `<th colspan="2" style="text-align:center;border-bottom:1px solid var(--border);color:var(--text3);">Stock</th>` : ""}
            ${Object.keys(_gdsPrep.suggested).length && _gdsPrepCols.sugg ? `<th colspan="2" style="text-align:center;border-bottom:1px solid var(--border);color:var(--text3);">Suggéré</th>` : ""}
            ${_gdsPrepCols.prep ? `<th colspan="3" style="text-align:center;border-bottom:1px solid var(--border);color:var(--gds-color)">Préparation</th>` : ""}
            ${hasCharge && _gdsPrepCols.charge ? `<th colspan="3" style="text-align:center;border-bottom:1px solid var(--border);color:var(--orange)">Chargement</th>` : ""}
            ${hasCharge && _gdsPrepCols.reste ? `<th colspan="3" style="text-align:center;border-bottom:1px solid var(--border);color:var(--accent)">Reste</th>` : ""}
            ${_gdsPrep.finished ? `<th colspan="2" style="text-align:center;border-bottom:1px solid var(--border);color:var(--text2)">Vérif.</th>` : ""}
            <th style="text-align:right;white-space:nowrap;position:relative;" rowspan="2">
              <button onclick="_gdsPrepToggleColPanel('${escHtml(cat)}')" style="font-size:9px;padding:2px 6px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text3);cursor:pointer;line-height:1.4;">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:2px;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>Col
              </button>
              <div id="gdsPrepColPanel_${escHtml(cat)}" style="display:none;position:absolute;top:100%;right:0;z-index:200;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;flex-direction:column;gap:6px;min-width:160px;box-shadow:0 4px 16px rgba(0,0,0,.5);">
                ${[
                  { key:"stock",  label:"Stock",       color:"var(--text3)"    },
                  { key:"sugg",   label:"Suggéré",     color:"var(--text3)"    },
                  { key:"prep",   label:"Préparation", color:"var(--gds-color)"},
                  { key:"charge", label:"Chargement",  color:"var(--orange)"   },
                  { key:"reste",  label:"Reste",       color:"var(--accent)"   },
                ].map(c => `
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
                    <span style="font-size:11px;font-weight:600;color:${c.color};">${c.label}</span>
                    <button id="gdsPrepColBtn_${c.key}" onclick="_gdsPrepToggleCol('${c.key}')"
                      style="font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid var(--border);
                             background:${_gdsPrepCols[c.key] ? "var(--gds-color)" : "var(--bg3)"};
                             color:${_gdsPrepCols[c.key] ? "#fff" : "var(--text3)"};cursor:pointer;
                             opacity:${_gdsPrepCols[c.key] ? "1" : "0.45"};
                             text-decoration:${_gdsPrepCols[c.key] ? "none" : "line-through"};">
                      ${_gdsPrepCols[c.key] ? "Visible" : "Caché"}
                    </button>
                  </div>`).join("")}
              </div>
            </th>
          </tr>
          <tr>
            <th></th>
            ${_gdsPrepCols.stock ? `<th style="text-align:right;color:var(--text3)">C/F</th><th style="text-align:right;color:var(--text3)">U</th>` : ""}
            ${Object.keys(_gdsPrep.suggested).length && _gdsPrepCols.sugg ? `<th style="text-align:right;color:var(--text3)">C/F</th><th style="text-align:right;color:var(--text3)">U</th>` : ""}
            ${_gdsPrepCols.prep ? `<th style="text-align:right;color:var(--gds-color)">C/F</th><th style="text-align:right;color:var(--gds-color)">U</th><th style="text-align:right;color:var(--gds-color);font-size:9px;">qty</th>` : ""}
            ${hasCharge && _gdsPrepCols.charge ? `<th style="text-align:right;color:var(--orange)">C/F</th><th style="text-align:right;color:var(--orange)">U</th><th style="text-align:right;color:var(--orange);font-size:9px;">qty</th>` : ""}
            ${hasCharge && _gdsPrepCols.reste ? `<th style="text-align:right;color:var(--accent)">C/F</th><th style="text-align:right;color:var(--accent)">U</th><th style="text-align:right;color:var(--accent);font-size:9px;">qty</th>` : ""}
            ${_gdsPrep.finished ? `<th style="text-align:center">✓</th><th style="text-align:center">Écart</th>` : ""}
          </tr>
        </thead><tbody>`;

    byCateg[cat].forEach(({ line, i }) => {
      const u        = _gdsPrepUnitSize(line);
      const stockC   = u > 0 ? Math.floor(line.qty / u) : 0;
      const stockU   = u > 0 ? Math.round(line.qty % u) : Math.round(line.qty);
      const ch         = _gdsPrep.chargeData[line.pid] || { chargeCarton:0, chargeUnite:0, chargeTotal:0 };
      const totalPrep  = _gdsPrepTotalPrep(line);
      const overStock  = totalPrep > line.qty;
      const overCharge = ch.chargeTotal > 0 && totalPrep === 0 && line._extraCharge;
      const hasErr     = !!line._hasError || overStock || overCharge;
      const rowErr     = hasErr;
      // Reste = prep − chargement (en unités brutes)
      const prepTotal = line.prepCarton * u + line.prepUnite;
      const resteTotal = prepTotal - ch.chargeTotal;
      const resteCarton = u > 0 ? Math.trunc(resteTotal / u) : 0;
      const resteUnite  = u > 0 ? Math.round(resteTotal - Math.trunc(resteTotal / u) * u) : Math.round(resteTotal);
      const chargeOverPrep = ch.chargeTotal > prepTotal && prepTotal > 0;

      html += `<tr style="${rowErr ? "background:rgba(239,68,68,.10);" : ""}">
        <td style="${rowErr ? "color:var(--red);font-weight:600;" : ""}font-size:11px;min-width:120px;max-width:180px;word-break:break-word;white-space:normal;" title="${escHtml(line.name)}">${escHtml(line.name)}
          ${overStock ? `<span style="font-size:9px;margin-left:4px;color:var(--red)">⚠ dépasse stock</span>` : ""}
          ${overCharge ? `<span style="font-size:9px;margin-left:4px;color:var(--red)">⚠ chargé sans prépa</span>` : ""}
        </td>
        ${_gdsPrepCols.stock ? `<td class="gds-qty" style="color:var(--text3)">${stockC > 0 ? stockC : "—"}</td><td class="gds-qty" style="color:var(--text3)">${stockU > 0 ? stockU : (stockC === 0 ? Math.round(line.qty) : "—")}</td>` : ""}
        ${Object.keys(_gdsPrep.suggested).length && _gdsPrepCols.sugg ? (() => {
          const suggQty = _gdsPrep.suggested[line.pid] || 0;
          const suggC   = u > 0 ? Math.floor(suggQty / u) : 0;
          const suggU   = u > 0 ? Math.round(suggQty % u) : Math.round(suggQty);
          return `<td class="gds-qty" style="color:var(--text3)">${suggC > 0 ? suggC : "—"}</td>
                  <td class="gds-qty" style="color:var(--text3)">${suggU > 0 ? suggU : (suggQty > 0 && suggC === 0 ? suggQty : "—")}</td>`;
        })() : ""}
        ${_gdsPrepCols.prep ? `
        <td class="gds-qty" style="color:${rowErr ? "var(--red)" : "var(--gds-color)"}">
          ${line.prepCarton > 0 ? line.prepCarton : "—"}
        </td>
        <td class="gds-qty" style="color:${rowErr ? "var(--red)" : "var(--gds-color)"}">
          ${line.prepUnite > 0 ? line.prepUnite : "—"}
        </td>
        <td class="gds-qty" style="color:${rowErr ? "var(--red)" : "var(--gds-color)"};opacity:0.7;font-size:10px;">
          ${prepTotal > 0 ? prepTotal : "—"}
        </td>` : ""}
        ${hasCharge && _gdsPrepCols.charge ? `
        <td class="gds-qty" style="color:${chargeOverPrep?"var(--red)":"var(--orange)"}">
          ${ch.chargeCarton > 0 ? ch.chargeCarton : "—"}
          ${chargeOverPrep ? `<span style="font-size:9px;color:var(--red)">⚠</span>` : ""}
        </td>
        <td class="gds-qty" style="color:${chargeOverPrep?"var(--red)":"var(--orange)"}">
          ${ch.chargeUnite > 0 ? ch.chargeUnite : "—"}
        </td>
        <td class="gds-qty" style="color:${chargeOverPrep?"var(--red)":"var(--orange)"};opacity:0.7;font-size:10px;">
          ${ch.chargeTotal > 0 ? ch.chargeTotal : "—"}
        </td>` : ""}
        ${hasCharge && _gdsPrepCols.reste ? `
        <td class="gds-qty" style="color:${resteTotal===0?"var(--green)":resteTotal<0?"var(--red)":"var(--accent)"}">
  ${resteCarton !== 0 ? resteCarton : (resteTotal===0 ? "0" : "—")}
</td>
<td class="gds-qty" style="color:${resteTotal===0?"var(--green)":resteTotal<0?"var(--red)":"var(--accent)"}">
  ${resteUnite !== 0 ? resteUnite : (resteTotal===0 ? "0" : "—")}
</td>
        <td class="gds-qty" style="color:${resteTotal===0?"var(--green)":resteTotal<0?"var(--red)":"var(--accent)"};opacity:0.7;font-size:10px;">
          ${resteTotal !== 0 ? Math.round(resteTotal) : "0"}
        </td>` : ""}
        ${_gdsPrep.finished ? `
        <td style="text-align:center;padding:2px;">
          <button class="gds-check-btn" data-pid="${line.pid}"
            onclick="_gdsPrepToggleCheck(${line.pid})"
            style="border:1px solid ${line.ecart !== null && line.ecart !== 0 ? 'var(--red)' : line.check ? 'var(--green)' : 'var(--border)'};
                   color:${line.ecart !== null && line.ecart !== 0 ? 'var(--red)' : line.check ? 'var(--green)' : 'var(--text3)'};
                   ...">
            ${line.ecart !== null && line.ecart !== 0 ? '✗' : '✓'}</button>
        </td>
        <td style="padding:2px;">
          <input type="number" step="any"
            class="gds-prep-input" style="width:54px;text-align:center;"
            value="${line.ecart != null ? line.ecart : 0}"
            placeholder="0"
            oninput="_gdsPrepEcartInput(${line.pid}, this.value)"/>
        </td>
        ` : `
        <td style="text-align:center;white-space:nowrap;min-width:40px;">
          ${line.history?.length
            ? `<button class="gds-prep-hist-btn" onclick="gdsPrepShowHist(${i})" title="Historique">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
               </button>`
            : ""}
          ${Object.values(_gdsPrep.byPicking).some(mv => mv.some(m => m.product_id?.[0] === line.pid))
            ? `<button class="gds-prep-hist-btn" onclick="gdsPrepShowCharge(${line.pid})" title="Détail chargement" style="margin-left:2px;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>
                  <circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>
                </svg>
               </button>`
            : ""}
        </td>`}
      </tr>`;
    });
    html += `</tbody></table></div></div>`;
  });

  wrap.innerHTML = html;
  if (_gdsPrep.finished) _gdsPrepCheckAllDone();
  _gdsPrepFetchMissingNames();
}

// ── toggle مجموعة في الجدول ───────────────────────────────────
function _gdsPrepToggleTblCat(cat) {
  const key = "tbl_" + cat;
  _gdsPrep.collapsed[key] = !_gdsPrep.collapsed[key];
  const body  = document.getElementById("gdsPrepTblCat_" + cat);
  const arrow = document.getElementById("gdsPrepArrow_" + cat);
  if (body)  body.style.display = _gdsPrep.collapsed[key] ? "none" : "";
  if (arrow) arrow.style.transform = _gdsPrep.collapsed[key] ? "rotate(-90deg)" : "";
}

// ── نافذة السجل ──────────────────────────────────────────────
function gdsPrepShowHist(idx) {
  const line = _gdsPrep.lines[idx]; if (!line) return;
  const modal = document.getElementById("gdsPrepHistModal");
  if (!modal) return;
  document.getElementById("gdsPrepHistTitle").textContent = "Historique: " + line.name;
  const body = document.getElementById("gdsPrepHistBody");

  if (!line.history || line.history.length === 0) {
    body.innerHTML = `<div class="gds-loading" style="color:var(--text3)">Aucun historique</div>`;
  } else {
    let html = `<table class="gds-table">
      <thead><tr>
        <th>Heure</th><th>Type</th><th style="text-align:right">C/F</th><th style="text-align:right">U</th>
      </tr></thead><tbody>`;
    line.history.forEach(h => {
      const color = h.type === "Augmentation" || h.type === "Ajout" ? "var(--green)" : h.type === "Réduction" ? "var(--red)" : "var(--gds-color)";
      html += `<tr>
        <td style="font-size:10px;color:var(--text3)">${h.ts}</td>
        <td style="font-weight:600;color:${color}">${h.type}</td>
        <td class="gds-qty">${h.carton > 0 ? "+"+h.carton : h.carton < 0 ? h.carton : "—"}</td>
        <td class="gds-qty">${h.unite > 0 ? "+"+h.unite : h.unite < 0 ? h.unite : "—"}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
    body.innerHTML = html;
  }
  modal.style.display = "flex";
}

function gdsPrepCloseHist() {
  const m = document.getElementById("gdsPrepHistModal");
  if (m) m.style.display = "none";
}

// ── تأكيد الإنهاء ─────────────────────────────────────────────
function gdsPrepAskFinish() {
  const modal = document.getElementById("gdsPrepConfirmModal");
  if (!modal) return;
  modal.style.display = "flex";
  const btn  = document.getElementById("gdsPrepConfirmBtn");
  const cd   = document.getElementById("gdsPrepCountdown");
  const hint = document.getElementById("gdsPrepCdHint");
  if (btn) { btn.disabled = true; btn.style.opacity = ".4"; }
  let sec = 5;
  if (cd) cd.textContent = sec;
  const t = setInterval(() => {
    sec--;
    if (cd) cd.textContent = sec;
    if (sec <= 0) {
      clearInterval(t);
      if (btn)  { btn.disabled = false; btn.style.opacity = "1"; }
      if (cd)   cd.textContent = "✓";
      if (hint) hint.textContent = "يمكنك التأكيد الآن";
    }
  }, 1000);
}

function gdsPrepCloseConfirm() {
  const m = document.getElementById("gdsPrepConfirmModal");
  if (m) m.style.display = "none";
}

function gdsPrepDoFinish() {
  gdsPrepCloseConfirm();
  _gdsPrep.finished = true;
  _gdsPrepSave();
  renderGdsPreparation();
  addNotif("✓ Préparation terminée", "success");
}
function gdsPrepAskCancel() {
  const modal = document.getElementById("gdsPrepCancelModal");
  if (!modal) return;
  modal.style.display = "flex";
  const btn = document.getElementById("gdsPrepCancelBtn");
  const cd  = document.getElementById("gdsPrepCancelCountdown");
  if (btn) { btn.disabled = true; btn.style.opacity = ".4"; }
  let sec = 10;
  if (cd) cd.textContent = sec;
  const t = setInterval(() => {
    sec--;
    if (cd) cd.textContent = sec;
    if (sec <= 0) {
      clearInterval(t);
      if (btn) { btn.disabled = false; btn.style.opacity = "1"; }
      if (cd)  cd.textContent = "✓";
    }
  }, 1000);
}

function gdsPrepCloseCancel() {
  const m = document.getElementById("gdsPrepCancelModal");
  if (m) m.style.display = "none";
}

function gdsPrepDoCancel() {
  gdsPrepCloseCancel();
 _gdsPrep.lines               = [];
  _gdsPrep.loaded              = false;
  _gdsPrep.finished            = false;
  _gdsPrep.collapsed           = {};
  _gdsPrep.chargeFrom          = null;
  _gdsPrep.chargeData          = {};
  _gdsPrep.pickingsMap         = {};
  _gdsPrep.byPicking           = {};
  _gdsPrep.excludedPickings    = [];
  _gdsPrep.outOfDateTransferts = [];
  localStorage.removeItem(GDS_PREP_STORAGE_KEY);
  renderGdsPreparation();
  addNotif("Préparation annulée", "warning");
}

function _gdsPrepToggleCheck(pid) {
  const line = _gdsPrep.lines.find(l => l.pid === pid); if (!line) return;
  if (line.ecart !== null && line.ecart !== 0) return; // فارق غير صفر → لا يمكن check
  line.check = !line.check;
  _gdsPrepSave();
  const btn = document.querySelector(`.gds-check-btn[data-pid="${line.pid}"]`);
  if (btn) {
    btn.style.color       = line.check ? "var(--green)" : "var(--text3)";
    btn.style.borderColor = line.check ? "var(--green)" : "var(--border)";
    btn.textContent       = "✓";
  }
  _gdsPrepCheckAllDone();
}

function _gdsPrepEcartInput(pid, val) {
  const line = _gdsPrep.lines.find(l => l.pid === pid); if (!line) return;
const parsed = val === "" ? null : parseFloat(val);
  line.ecart = parsed;
  // لا نمس line.check — يبقى كما هو (المستخدم يتحكم فيه بالضغط)
  // فقط إذا كان الفارق غير صفر نُجبر check=false
  if (parsed === null) {
    line.check = false;
  } else if (parsed === 0) {
    line.check = true;  // صفر = مخزون صحيح → check تلقائي
  } else {
    line.check = false; // فارق موجود → لا check
  }
  _gdsPrepSave();
  // تحديث زر ✓/✗
  const btn = document.querySelector(`.gds-check-btn[data-pid="${line.pid}"]`);
  if (btn) {
    if (parsed !== null && parsed !== 0) {
      // فارق موجود → ✗ أحمر
      btn.textContent = "✗"; btn.style.color = "var(--red)"; btn.style.borderColor = "var(--red)";
    } else if (line.check) {
      // check مفعّل (سواء بالضغط أو بإرجاع القيمة لصفر) → ✓ أخضر
      btn.textContent = "✓"; btn.style.color = "var(--green)"; btn.style.borderColor = "var(--green)";
    } else {
      // الحالة الافتراضية → ✓ رمادي
      btn.textContent = "✓"; btn.style.color = "var(--text3)"; btn.style.borderColor = "var(--border)";
    }
  }
  _gdsPrepCheckAllDone();
}

function _gdsPrepCheckAllDone() {
  const activeLines = _gdsPrep.lines.filter(l => l.prepCarton > 0 || l.prepUnite > 0 || l._extraCharge);
  const allDone = activeLines.length > 0 && activeLines.every(l => 
    l.check === true || (l.ecart !== null && l.ecart !== 0) ||
    (l._extraCharge && l.name.startsWith("pid:"))
  );
  const bar = document.getElementById("gdsPrepNewBar");
  if (bar) bar.style.display = allDone ? "flex" : "none";
}

function gdsPrepReprendre() {
  _gdsPrep.finished = false;
  // مسح بيانات التحقق
  _gdsPrep.lines.forEach(l => { l.check = false; l.ecart = 0; });
  _gdsPrepSave();
  renderGdsPreparation();
  addNotif("Préparation reprise", "info");
}

function gdsPrepAskNew() {
  const modal = document.getElementById("gdsPrepNewConfirmModal");
  if (!modal) return;
  modal.style.display = "flex";
  const btn  = document.getElementById("gdsPrepNewConfirmBtn");
  const cd   = document.getElementById("gdsPrepNewCountdown");
  if (btn) { btn.disabled = true; btn.style.opacity = ".4"; }
  let sec = 10;
  if (cd) cd.textContent = sec;
  const t = setInterval(() => {
    sec--;
    if (cd) cd.textContent = sec;
    if (sec <= 0) {
      clearInterval(t);
      if (btn) { btn.disabled = false; btn.style.opacity = "1"; }
      if (cd)  cd.textContent = "✓";
    }
  }, 1000);
}

function gdsPrepCloseNew() {
  const m = document.getElementById("gdsPrepNewConfirmModal");
  if (m) m.style.display = "none";
}

function gdsPrepDoNew() {
  gdsPrepCloseNew();
  _gdsPrepExportXlsx();
  // reset complet
  _gdsPrep.lines               = [];
  _gdsPrep.loaded              = false;
  _gdsPrep.finished            = false;
  _gdsPrep.collapsed           = {};
  _gdsPrep.chargeFrom          = null;
  _gdsPrep.chargeData          = {};
  _gdsPrep.excludedPickings    = [];
  _gdsPrep.outOfDateTransferts = [];
  localStorage.removeItem(GDS_PREP_STORAGE_KEY);
  renderGdsPreparation();
  addNotif("✓ Nouvelle préparation démarrée", "success");
}
function gdsPrepExportCurrent() {
  if (!_gdsPrep.lines.length) { addNotif("Aucune donnée à exporter", "warning"); return; }
  _gdsPrepExportXlsx();
}
function _gdsPrepExportXlsx() {
  const u_fn = line => _gdsPrepUnitSize(line);
  const rows = _gdsPrep.lines.filter(l => l.prepCarton > 0 || l.prepUnite > 0 || l._extraCharge).map(line => {
    const u         = u_fn(line);
    const ch        = _gdsPrep.chargeData[line.pid] || { chargeCarton:0, chargeUnite:0, chargeTotal:0 };
    const prepTotal = line.prepCarton * u + line.prepUnite;
    const resteTotal  = prepTotal - ch.chargeTotal;
    const resteCarton = u > 0 ? Math.trunc(resteTotal / u) : 0;
    const resteUnite  = u > 0 ? Math.round(resteTotal - Math.trunc(resteTotal / u) * u) : Math.round(resteTotal);
    return {
      Produit:          line.name,
      "Prép C/F":       line.prepCarton || 0,
      "Prép U":         line.prepUnite  || 0,
      "Charg C/F":      ch.chargeCarton || 0,
      "Charg U":        ch.chargeUnite  || 0,
      "Reste C/F":      resteCarton,
      "Reste U":        resteUnite,
      "Check":          line.check ? "✓" : "",
      "Écart":          line.ecart != null ? line.ecart : "",
    };
  });

  if (typeof XLSX !== "undefined") {
    const wb  = XLSX.utils.book_new();
    const ws  = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [
      {wch:30},{wch:10},{wch:8},{wch:10},{wch:8},{wch:10},{wch:8},{wch:8},{wch:10}
    ];
    XLSX.utils.book_append_sheet(wb, ws, "Préparation");
    const today = new Date().toISOString().slice(0,10);
    XLSX.writeFile(wb, `preparation_gds_${today}.xlsx`);
  } else {
    // CSV fallback
    const headers = Object.keys(rows[0] || {}).join(",");
    const lines   = rows.map(r => Object.values(r).map(v => `"${v}"`).join(","));
    const csv     = [headers, ...lines].join("\n");
    const blob    = new Blob(["\uFEFF"+csv], {type:"text/csv;charset=utf-8;"});
    _downloadBlob(blob, `preparation_gds_${new Date().toISOString().slice(0,10)}.csv`);
  }
}
function _gdsPrepRenderPickingBtns() {
  const pm = _gdsPrep.pickingsMap || {};
  const bp = _gdsPrep.byPicking   || {};
  if (!Object.keys(pm).length) return "";

  // تجميع حسب partner
  const byPartner = {};
  Object.entries(pm).forEach(([pickId, pick]) => {
    const partnerName = pick.partner_id?.[1] || "Inconnu";
    if (!byPartner[partnerName]) byPartner[partnerName] = [];
    byPartner[partnerName].push({ pickId: Number(pickId), pick });
  });

  let html = "";
  Object.entries(byPartner).forEach(([partner, entries]) => {
    entries.forEach((entry, idx) => {
      const label = idx === 0 ? partner : `${partner} jumlage (${idx})`;
      html += `<button class="gds-refresh-btn" style="font-size:10px;"
        onclick="_gdsPrepDownloadPickingPdf(${entry.pickId})">
        📄 ${escHtml(label)}
      </button>`;
    });
  });
  return html;
}

function _gdsPrepDownloadPickingPdf(pickId) {
  const pid_str = String(pickId);
  const pick  = _gdsPrep.pickingsMap[pid_str];
  const moves = _gdsPrep.byPicking[pid_str] || [];
  if (!pick) return;

  const partner  = pick.partner_id?.[1] || "—";
  const ref      = pick.name            || "—";
  const van      = pick.van             || "—";
  const dateDone = pick.date_done
    ? new Date(pick.date_done).toLocaleString("fr-FR")
    : "—";

  // تجميع الكميات حسب المنتج مع packaging
  const prodMap = {};
  moves.forEach(m => {
    const pid  = m.product_id?.[0];
    const name = m.product_id?.[1] || `pid:${pid}`;
    // مقارنة بـ Number لتجنب String/Number mismatch
    const line = _gdsPrep.lines.find(l => Number(l.pid) === Number(pid));
    const unitSize = (line?.unitSize > 0) ? line.unitSize : (line?.carton > 0 ? line.qty / line.carton : 0);
    if (!prodMap[name]) prodMap[name] = { qty: 0, unitSize };
    prodMap[name].qty += m.qty_done || 0;
  });

  const rows = Object.entries(prodMap).map(([name, d], idx) => {
    const u      = d.unitSize > 0 ? Math.round(d.unitSize) : 0;
    const carton = u > 0 ? Math.floor(d.qty / u) : "—";
    const unite  = u > 0 ? Math.round(d.qty % u) : Math.round(d.qty);
    return `<tr>
      <td style="text-align:center;color:#888">${idx + 1}</td>
      <td>${name}</td>
      <td style="text-align:center">${carton}</td>
      <td style="text-align:center">${unite}</td>
      <td style="text-align:center">${Math.round(d.qty)}</td>
    </tr>`;
  }).join("");

  const html = `<html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 8mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 10px; margin: 0; padding: 0; }
    h2 { font-size: 13px; color: #1a6b3a; margin: 0 0 6px; }
    .info { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 16px; margin-bottom: 8px; font-size: 10px; color: #333; }
    .info b { color: #000; }
// /table
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.875rem; /* بدل 14px */
  table-layout: fixed;
  break-inside: avoid;
}

/* خلايا النص */
td.text-cell {
  font-size: 0.75rem; /* أصغر */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* خلايا الأرقام */
td.num {
  font-size: 2rem; /* أكبر */
  font-weight: 600;
  text-align: center;
}
// /


    thead { display: table-header-group; }
    th { background: #1a6b3a; color: #fff; padding: 4px 5px; text-align: left; border: 1px solid #1a6b3a; }
    td { padding: 3px 5px; border: 1px solid #ccc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    tr:nth-child(even) td { background: #f0f7f3; }
    tr { page-break-inside: avoid; }
  </style></head><body>
    <h2>Chargement GDS</h2>
    <div class="info">
      <div><b>Contact :</b> ${partner}</div>
      <div><b>Van :</b> ${van}</div>
      <div><b>Référence :</b> ${ref}</div>
      <div><b>Date :</b> ${dateDone}</div>
    </div>
    <table>
      <thead><tr>
        <th style="text-align:center;width:24px">#</th>
        <th>Produit</th>
        <th style="text-align:center;width:50px">C/F</th>
        <th style="text-align:center;width:50px">U</th>
        <th style="text-align:center;width:55px">Total U</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </body></html>`;

  const win = window.open("", "_blank");
  if (!win) { addNotif("Autorisez les popups pour télécharger le PDF", "warning"); return; }
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); win.close(); }, 400);
}

//////////// fin prep
function setMode(mode) {
  // مسح التحديد عند تغيير القسم
  document.querySelectorAll(".vc--selected").forEach(card => {
    card.classList.remove("vc--selected");
    const badge = card.querySelector(".vc-sel-badge");
    if (badge) badge.style.display = "none";
  });
  const bar = document.getElementById("vendorBulkBar");
  if (bar) bar.style.display = "none";

  App.currentMode = mode;
  // Reset offset when switching to prevente (max = today)
  if (mode === "prevente" && App.currentDateOffset > 0) {
    App.currentDateOffset = 0;
  }
  Promise.all([
    Storage.getMany(["vendorLinks","vendorStats","vendorRefs","roundStatus"]),
    Storage.getOdooState(),
    Storage.getUserStatus(),
  ]).then(([raw, odooState, userStatus]) => {
    raw.odooState  = odooState;
    raw.userStatus = userStatus;
    _loadDateContext(raw); renderVendors(); updateFetchBtn(); updateCloseAllBtn();
  });
  if (App.searchQuery) { App.searchQuery=""; const inp=document.getElementById("searchInput"); if(inp) inp.value=""; }
 ["prevente","livraison","mr","gds","clients","sales","route","delivmap"].forEach(m => {
    const btnId = m === "mr" ? "btnModeMr" : m === "gds" ? "btnModeGds" : m === "clients" ? "btnModeClients" : m === "sales" ? "btnModeSales" : m === "route" ? "btnModeRoute" : m === "delivmap" ? "btnModeDeliveryMap" : `btnMode${m.charAt(0).toUpperCase()+m.slice(1)}`;
    document.getElementById(btnId)?.classList.toggle("mode-btn--active", m===mode);
  });

  // إظهار/إخفاء vendorsList و gdsView و clientsView و salesView و routesView
  const isGds = mode === "gds";
  const isClients = mode === "clients";
  const isSales = mode === "sales";
  const isRoute = mode === "route";
  const isDelivmap = mode === "delivmap";
  document.getElementById("scrollArea").style.display  = (isGds || isClients || isSales || isRoute || isDelivmap) ? "none" : "flex";
  document.getElementById("gdsView").style.display     = isGds ? "flex" : "none";
  const clientsViewEl = document.getElementById("clientsView");
  if (clientsViewEl) clientsViewEl.style.display = isClients ? "flex" : "none";
  const salesViewEl = document.getElementById("salesView");
  if (salesViewEl) salesViewEl.style.display = isSales ? "flex" : "none";
  const routesViewEl = document.getElementById("routesView");
  if (routesViewEl) routesViewEl.style.display = isRoute ? "flex" : "none";
  const delivmapViewEl = document.getElementById("deliveryMapView");
  if (delivmapViewEl) {
    delivmapViewEl.style.display = isDelivmap ? "flex" : "none";
    if (isDelivmap && !delivmapViewEl.innerHTML.trim() && window.DeliveryPlanner) {
      DeliveryPlanner.show();
    } else if (isDelivmap && window.google?.maps && window.DeliveryPlanner) {
      try { google.maps.event.trigger(window._dmMapRef, "resize"); } catch(_) {}
    }
  }
  if (isGds) { renderGdsStock(); renderGdsVans(); renderGdsTransferts(); }
  if (isClients && window.ClientsView) ClientsView.activate();
  if (!isClients && window.ClientsView) ClientsView.deactivate();
  if (isSales && window.SalesView) SalesView.activate();
  if (!isSales && window.SalesView) SalesView.deactivate();
  if (isRoute) renderRoutesView();
loadFilterFavourites(); renderFavChips(); qbReset();
qbActiveFavIndex = -1;
document.querySelectorAll("#favBarChips .qb-fav-chip").forEach(c => c.classList.remove("qb-fav-chip--active"));
renderDateSwitcher();
  const toolbarRowEl = document.getElementById("topToolbarRow");
  if (toolbarRowEl) toolbarRowEl.style.display = (isClients || isSales || isRoute || isDelivmap) ? "none" : "flex";
  const dsEl = document.getElementById("dateSwitcherWrap");
  if (dsEl) dsEl.style.display = (isGds || isClients || isSales || isRoute || isDelivmap) ? "none" : "";
  const sbEl = document.getElementById("searchBar");
  if (sbEl) sbEl.style.display = (isGds || isClients || isSales || isRoute || isDelivmap) ? "none" : "";
  ["btnFetch","btnCloseAll","btnExportExcel","btnClearMode"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = (isGds || isClients || isSales || isRoute || isDelivmap) ? "none" : "";
  });
  const abortEl = document.getElementById("btnAbort");
  if (abortEl) abortEl.style.display = isGds ? "none" : (App.isFetching ? "flex" : "none");}


// ── Constat default settings ──────────────────────────────────
const CONSTAT_ALL_COLS = [
  { key: "agent",      label: "Route",           modes: ["prevente","livraison"] },
  { key: "ca",         label: "CA",              modes: ["prevente","livraison"] },
  { key: "p",          label: "NCP",     modes: ["prevente","livraison"] },
  { key: "vPct",       label: "Visite",              modes: ["prevente","livraison"] },
  { key: "sPct",       label: "Succes",              modes: ["prevente","livraison"] },
  { key: "blCount",       label: "NBL",              modes: ["prevente","livraison"] },
  { key: "firstVisit", label: "First Visit",     modes: ["prevente","livraison"] },
  { key: "lastVisit",  label: "Last Visit",      modes: ["prevente","livraison"] },
  { key: "workTime",   label: "Work Time",        modes: ["prevente","livraison"] },
{ key: "skuCount",   label: "Nb SKUs",          modes: ["prevente","livraison"] },
  { key: "avgSku",     label: "Moy SKU/BL",       modes: ["prevente","livraison"] },
  { key: "dropSize",   label: "Drop Size",       modes: ["prevente","livraison"] },
];

function _defaultConstatSettings() {
  const makeModeConfig = () => ({
    cols: CONSTAT_ALL_COLS.map(c => ({ key: c.key, enabled: true })),
    customProducts: [],
  });
  return { prevente: makeModeConfig(), livraison: makeModeConfig() };
}
// ── Constat Modal ─────────────────────────────────────────────
function openConstatModal() {
  const modal = document.getElementById("constatModal");
  if (!modal) return;
  if (!App.settings.constat) App.settings.constat = _defaultConstatSettings();
  _renderConstatTab("prevente");
  _renderConstatTab("livraison");
  _renderCategCF();
  modal.style.display = "flex";
}

function _renderCategCF() {
  const el = document.getElementById("constatCategList");
  if (!el) return;
  const ALL_CATEGS = [
    { id: 88, name: "Aluminium" },
    { id: 91, name: "BARQUETTE ALUMINIUM & COUVERCLE" },
    { id: 92, name: "DAHLIA COSMETIQUE" },
    { id: 87, name: "Essuie Tout" },
    { id: 89, name: "Film Alimentaire" },
    { id: 84, name: "Lingettes Bébé" },
    { id: 83, name: "Mouchoir" },
    { id: 86, name: "PARAPHARM" },
    { id: 90, name: "Papier Cuisson" },
    { id: 85, name: "Papier Hygiénique" },
    { id: 82, name: "Serviette de table" },
  ];
  const cfg = App.settings.categCF || {};
  el.innerHTML = ALL_CATEGS.map(c => `
    <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--text2)">
      <span>${c.name}</span>
      <select onchange="App.settings.categCF=${JSON.stringify(cfg).replace(/"/g,"'")} || {}; App.settings.categCF[${c.id}]=this.value"
              style="font-size:11px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--bg2);color:var(--text)">
        <option value=""  ${!cfg[c.id]       ? "selected" : ""}>—</option>
        <option value="c" ${cfg[c.id]==="c"  ? "selected" : ""}>C</option>
        <option value="f" ${cfg[c.id]==="f"  ? "selected" : ""}>F</option>
      </select>
    </div>`).join("");

  // bind change events properly
  el.querySelectorAll("select").forEach((sel, i) => {
    const catId = ALL_CATEGS[i].id;
    sel.onchange = () => {
      if (!App.settings.categCF) App.settings.categCF = {};
      App.settings.categCF[catId] = sel.value;
    };
  });
}

function _renderConstatTab(mode) {
  const cfg = App.settings.constat[mode];
  const availCols = CONSTAT_ALL_COLS.filter(c => c.modes.includes(mode));

  // ── Colonnes ──
  const colsEl = document.getElementById(`constatCols-${mode}`);
  if (colsEl) {
    // Merge: garder l'ordre sauvegardé, ajouter les nouvelles colonnes à la fin
    const savedKeys = (cfg.cols || []).map(c => c.key);
    const allKeys   = availCols.map(c => c.key);
    const merged    = [
      ...cfg.cols.filter(c => allKeys.includes(c.key)),
      ...availCols.filter(c => !savedKeys.includes(c.key)).map(c => ({ key: c.key, enabled: true })),
    ];
    cfg.cols = merged;

    colsEl.innerHTML = merged.map((col, i) => {
      const meta = availCols.find(c => c.key === col.key);
      if (!meta) return "";
      return `
        <div class="constat-col-row" data-key="${col.key}" data-mode="${mode}" data-idx="${i}">
          <span class="constat-drag-handle">⠿</span>
          <input type="checkbox" class="constat-col-check" ${col.enabled ? "checked" : ""}
                 onchange="constatToggleCol('${mode}','${col.key}',this.checked)">
          <span class="constat-col-label">${meta.label}</span>
          <div class="constat-col-arrows">
            <button onclick="constatMoveCol('${mode}',${i},-1)">▲</button>
            <button onclick="constatMoveCol('${mode}',${i},+1)">▼</button>
          </div>
        </div>`;
    }).join("");
  }

  // ── Custom Products ──
  _renderConstatCustomProds(mode);
}

function constatToggleCol(mode, key, enabled) {
  const col = App.settings.constat[mode].cols.find(c => c.key === key);
  if (col) col.enabled = enabled;
}

function constatMoveCol(mode, idx, dir) {
  const cols = App.settings.constat[mode].cols;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= cols.length) return;
  [cols[idx], cols[newIdx]] = [cols[newIdx], cols[idx]];
  _renderConstatTab(mode);
}

function _renderConstatCustomProds(mode) {
  const container = document.getElementById(`constatCustomProds-${mode}`);
  if (!container) return;
  const prods = App.settings.constat[mode].customProducts || [];
  container.innerHTML = prods.map((cp, i) => _buildCustomProdRow(mode, cp, i)).join("");
}

function _buildCustomProdRow(mode, cp, i) {
  const tagsHtml = (cp.productIds || []).map((pid, pi) =>
    `<span class="constat-prod-tag">${productLabel(cp.productNames?.[pi]) || pid}
       <button onclick="constatRemoveProdTag('${mode}',${i},${pi})">✕</button>
     </span>`
  ).join("");
  return `
    <div class="constat-custom-prod-row" data-prod-idx="${i}">
      <div style="display:flex;gap:4px;align-items:center">
        <input type="text" placeholder="Libellé colonne" value="${cp.label||""}"
               style="flex:1" oninput="constatUpdateProdLabel('${mode}',${i},this.value)">
        <select onchange="constatUpdateProdUnit('${mode}',${i},this.value)"
                style="width:90px">
          <option value="piece"   ${cp.unit==="piece"   ?"selected":""}>Pièce</option>
          <option value="carton"  ${cp.unit==="carton"  ?"selected":""}>Carton</option>
          <option value="fardeau" ${cp.unit==="fardeau" ?"selected":""}>Fardeau</option>
        </select>
        <button class="constat-close-btn" onclick="constatRemoveCustomProd('${mode}',${i})">✕</button>
      </div>
      <input type="text" placeholder="Rechercher produit Odoo…"
             oninput="constatSearchProd('${mode}',${i},this.value)"
             id="constatProdSearch-${mode}-${i}">
      <div id="constatProdResults-${mode}-${i}" class="constat-prod-search-results" style="display:none"></div>
      <div class="constat-prod-group-list">${tagsHtml}</div>
    </div>`;
}

function constatUpdateProdLabel(mode, i, val) {
  App.settings.constat[mode].customProducts[i].label = val;
}
function constatUpdateProdUnit(mode, i, val) {
  App.settings.constat[mode].customProducts[i].unit = val;
}
function constatRemoveCustomProd(mode, i) {
  App.settings.constat[mode].customProducts.splice(i, 1);
  _renderConstatCustomProds(mode);
}
function constatRemoveProdTag(mode, i, pi) {
  const cp = App.settings.constat[mode].customProducts[i];
  cp.productIds.splice(pi, 1);
  cp.productNames.splice(pi, 1);
  _renderConstatCustomProds(mode);
}

let _constatSearchTimer = null;
function constatSearchProd(mode, i, query) {
  clearTimeout(_constatSearchTimer);
  const resEl = document.getElementById(`constatProdResults-${mode}-${i}`);
  if (!query || query.length < 2) { if (resEl) resEl.style.display = "none"; return; }
  _constatSearchTimer = setTimeout(async () => {
    const baseUrl = App.settings?.baseUrlPayment?.replace(/\/$/, "") || "";
    if (!baseUrl) return;
    try {
      const results = await rpcController.searchProducts(baseUrl, query);
      if (!resEl) return;
      if (!results?.length) { resEl.innerHTML = `<div class="constat-prod-result-item" style="color:var(--text3)">Aucun résultat</div>`; resEl.style.display = "block"; return; }
      resEl.innerHTML = results.slice(0, 10).map(p =>
        `<div class="constat-prod-result-item"
              onclick="constatAddProdTag('${mode}',${i},${p.id},'${(p.name||"").replace(/'/g,"\\'")}')">
           ${escHtml(productLabel(p.name)) || p.id}
         </div>`
      ).join("");
      resEl.style.display = "block";
    } catch(_) {}
  }, 350);
}

function constatAddProdTag(mode, i, productId, productName) {
  const cp = App.settings.constat[mode].customProducts[i];
  if (!cp.productIds)   cp.productIds   = [];
  if (!cp.productNames) cp.productNames = [];
  const numId = parseInt(productId, 10);          // ← toujours number
  if (!cp.productIds.includes(numId)) {
    cp.productIds.push(numId);
    cp.productNames.push(productName);
  }
  const resEl = document.getElementById(`constatProdResults-${mode}-${i}`);
  const searchEl = document.getElementById(`constatProdSearch-${mode}-${i}`);
  if (resEl) resEl.style.display = "none";
  if (searchEl) searchEl.value = "";
  _renderConstatCustomProds(mode);
}

function constatAddCustomProd(mode) {
  if (!App.settings.constat) App.settings.constat = _defaultConstatSettings();
  App.settings.constat[mode].customProducts.push({
    label: "", unit: "piece", productIds: [], productNames: [],
  });
  _renderConstatCustomProds(mode);
  // scroll pour montrer le nouveau
  const container = document.getElementById(`constatCustomProds-${mode}`);
  if (container) container.lastElementChild?.scrollIntoView({ behavior: "smooth" });
}

// ── تحميل موحّد للفئات المخصصة الثلاث (منتجات/بائعين/قوائم أسعار) ──
// دالة مشتركة واحدة يستدعيها كل مكان يحتاج هذه البيانات قبل حساب SUMIFS
// (مصمم التقارير reportBuilder.js، عارض التقارير reportViewer.js، وأي
// مكان ثالث مستقبلي)، بدل تكرار نفس منطق "تحقق من الطول ثم اجلب" في
// كل ملف على حدة.
async function _ensureCustomCategoriesLoaded() {
  if (!_customCategories.length) _customCategories = await _fetchCustomCategories();
  if (!_customSellerCategories.length) _customSellerCategories = await _fetchCustomSellerCategories();
  if (!_customPricelistCategories.length) _customPricelistCategories = await _fetchCustomPricelistCategories();
}


let _customCategories = [];      // { id, name, productIds, createdAt, updatedAt }[]
let _customCategEditingId = null; // null = إنشاء جديد، غير null = تعديل فئة موجودة
let _customCategProdIds = [];
let _customCategProdNames = [];
let _customCategAllProducts = null; // cache لقائمة منتجات Odoo (product.template)

async function _fetchCustomCategories() {
  try {
    const r = await fetch("/api/sync/custom-categories", { method: "GET", credentials: "include" });
    if (!r.ok) return [];
    const data = await r.json();
    return data?.categories || [];
  } catch (e) {
    console.warn("[customCateg] fetch list failed:", e);
    return [];
  }
}

function _renderCustomCategList() {
  const el = document.getElementById("customCategList");
  if (!el) return;
  if (!_customCategories.length) {
    el.innerHTML = `<p class="settings-hint" style="color:var(--text3)">لا توجد فئات بعد.</p>`;
    return;
  }
  el.innerHTML = _customCategories.map(c => `
    <div class="constat-custom-prod-row" data-categ-id="${c.id}" style="flex-direction:row;align-items:center;justify-content:space-between">
      <span style="font-size:11px">${escHtml(c.name)} <span style="color:var(--text3)">(${(c.productIds||[]).length} منتج)</span></span>
      <div style="display:flex;gap:4px">
        <button class="btn-tool" onclick="customCategStartEdit('${c.id}')">✎ تعديل</button>
        <button class="btn-tool btn-tool--danger" onclick="customCategDelete('${c.id}')">✕ حذف</button>
      </div>
    </div>
  `).join("");
}

function _renderCustomCategProdTags() {
  const el = document.getElementById("customCategProdTags");
  if (!el) return;
  el.innerHTML = _customCategProdIds.map((pid, i) => `
    <span class="constat-prod-tag">${escHtml(productLabel(_customCategProdNames[i])) || String(pid)}
      <button onclick="customCategRemoveProdTag(${i})">✕</button>
    </span>
  `).join("");
}

function customCategRemoveProdTag(i) {
  _customCategProdIds.splice(i, 1);
  _customCategProdNames.splice(i, 1);
  _renderCustomCategProdTags();
}

function _customCategResetForm() {
  _customCategEditingId = null;
  _customCategProdIds = [];
  _customCategProdNames = [];
  const nameInput = document.getElementById("customCategNameInput");
  if (nameInput) nameInput.value = "";
  const searchInput = document.getElementById("customCategProdSearch");
  if (searchInput) searchInput.value = "";
  const catSel = document.getElementById("customCategOdooCategFilter");
  if (catSel) catSel.value = "";
  const cancelBtn = document.getElementById("btnCustomCategCancelEdit");
  if (cancelBtn) cancelBtn.style.display = "none";
  _renderCustomCategProdTags();
  _renderCustomCategProdResults();
}

function customCategStartEdit(id) {
  const c = _customCategories.find(x => x.id === id);
  if (!c) return;
  _customCategEditingId = id;
  _customCategProdIds = (c.productIds || []).slice();
  // لا نملك أسماء المنتجات محليًا دومًا؛ نعرض المعرف إلى أن يُحلّ عبر القائمة المحمّلة
  _customCategProdNames = _customCategProdIds.map(pid => {
    const found = (_customCategAllProducts || []).find(p => p.id === pid);
    return found ? found.name : String(pid);
  });
  const nameInput = document.getElementById("customCategNameInput");
  if (nameInput) nameInput.value = c.name || "";
  const cancelBtn = document.getElementById("btnCustomCategCancelEdit");
  if (cancelBtn) cancelBtn.style.display = "inline-flex";
  _renderCustomCategProdTags();
  _renderCustomCategProdResults();
}

async function customCategDelete(id) {
  try {
    const r = await fetch(`/api/sync/custom-categories/${id}`, { method: "DELETE", credentials: "include" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    _customCategories = _customCategories.filter(c => c.id !== id);
    _renderCustomCategList();
    if (_customCategEditingId === id) _customCategResetForm();
    addNotif("تم حذف الفئة", "success");
  } catch (e) {
    console.warn("[customCateg] delete failed:", e);
    addNotif("فشل حذف الفئة", "error");
  }
}

async function customCategSave() {
  const name = document.getElementById("customCategNameInput")?.value.trim();
  if (!name) { addNotif("أدخل اسم الفئة", "warning"); return; }
  if (!_customCategProdIds.length) { addNotif("اختر منتجًا واحدًا على الأقل", "warning"); return; }

  const payload = { name, productIds: _customCategProdIds.slice() };
  try {
    let r;
    if (_customCategEditingId) {
      r = await fetch(`/api/sync/custom-categories/${_customCategEditingId}`, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      r = await fetch("/api/sync/custom-categories", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    const saved = await r.json();
    if (_customCategEditingId) {
      _customCategories = _customCategories.map(c => c.id === saved.id ? saved : c);
    } else {
      _customCategories.push(saved);
    }
    _renderCustomCategList();
    _customCategResetForm();
    addNotif("تم حفظ الفئة ✓", "success");
  } catch (e) {
    console.warn("[customCateg] save failed:", e);
    addNotif("فشل حفظ الفئة", "error");
  }
}

async function _ensureCustomCategProductList() {
  if (_customCategAllProducts) return _customCategAllProducts;
  const baseUrl = App.settings?.baseUrlPayment?.replace(/\/$/, "") || "";
  if (!baseUrl) { _customCategAllProducts = []; return _customCategAllProducts; }
  try {
    _customCategAllProducts = await rpcController.fetchProductList(baseUrl);
  } catch (e) {
    console.warn("[customCateg] fetchProductList failed:", e);
    _customCategAllProducts = [];
  }
  return _customCategAllProducts;
}

function customCategAddProdTag(id, name) {
  const numId = parseInt(id, 10);
  if (!_customCategProdIds.includes(numId)) {
    _customCategProdIds.push(numId);
    _customCategProdNames.push(name);
  }
  _renderCustomCategProdTags();
}

function customCategToggleProd(id, name, checked) {
  const numId = parseInt(id, 10);
  if (checked) {
    if (!_customCategProdIds.includes(numId)) {
      _customCategProdIds.push(numId);
      _customCategProdNames.push(name);
    }
  } else {
    const idx = _customCategProdIds.indexOf(numId);
    if (idx !== -1) {
      _customCategProdIds.splice(idx, 1);
      _customCategProdNames.splice(idx, 1);
    }
  }
  _renderCustomCategProdTags();
}

// تحديد/إلغاء تحديد كل منتجات فئة Odoo دفعة واحدة
function customCategToggleWholeCategory(catId, checked) {
  const all = _customCategAllProducts || [];
  const numCatId = parseInt(catId, 10);
  all.forEach(p => {
    const pCatId = Array.isArray(p.categ_id) ? p.categ_id[0] : null;
    if (pCatId !== numCatId) return;
    const numId = p.id;
    const idx = _customCategProdIds.indexOf(numId);
    if (checked) {
      if (idx === -1) {
        _customCategProdIds.push(numId);
        _customCategProdNames.push(p.name);
      }
    } else if (idx !== -1) {
      _customCategProdIds.splice(idx, 1);
      _customCategProdNames.splice(idx, 1);
    }
  });
  _renderCustomCategProdTags();
  _renderCustomCategProdResults();
}

// يملأ قائمة فئات Odoo (select) اعتمادًا على categ_id المرفق مع كل منتج
function _populateCustomCategOdooFilter() {
  const sel = document.getElementById("customCategOdooCategFilter");
  if (!sel) return;
  const all = _customCategAllProducts || [];
  const map = new Map(); // catId -> catName
  all.forEach(p => {
    if (Array.isArray(p.categ_id)) map.set(p.categ_id[0], p.categ_id[1]);
  });
  const sorted = [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], "fr"));
  sel.innerHTML = `<option value="">— كل فئات Odoo —</option>` +
    sorted.map(([id, name]) => `<option value="${id}">${escHtml(name)}</option>`).join("");
}

// يعرض نتائج البحث/الفلترة الحالية (دائم الظهور، يُحدَّث عند كل تغيير)
function _renderCustomCategProdResults() {
  const resEl = document.getElementById("customCategProdResults");
  const input = document.getElementById("customCategProdSearch");
  const catSel = document.getElementById("customCategOdooCategFilter");
  if (!resEl) return;

  const q = (input?.value || "").trim().toLowerCase();
  const catId = catSel?.value ? parseInt(catSel.value, 10) : null;
  const all = _customCategAllProducts || [];
  const tokens = q.split(/\s+/).filter(Boolean);

  let results = all.filter(p => {
    if (catId != null) {
      const pCatId = Array.isArray(p.categ_id) ? p.categ_id[0] : null;
      if (pCatId !== catId) return false;
    }
    if (tokens.length) {
      const name = (p.name || "").toLowerCase();
      if (!tokens.every(t => name.includes(t))) return false;
    }
    return true;
  });

  const total = results.length;
  results = results.slice(0, 200); // حد أقصى لتفادي إبطاء العرض

  let html = "";
  // شريط "تحديد الفئة كاملة" يظهر فقط عند اختيار فئة Odoo محددة
  if (catId != null) {
    const allChecked = total > 0 && results.every(p => _customCategProdIds.includes(p.id));
    html += `<label class="constat-prod-result-item" style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:700;background:var(--bg)">
       <input type="checkbox" ${allChecked ? "checked" : ""}
              onchange="customCategToggleWholeCategory(${catId},this.checked)">
       <span>تحديد الفئة كاملة (${total} منتج)</span>
     </label>`;
  }

  if (!results.length) {
    html += `<div class="constat-prod-result-item" style="color:var(--text3)">لا نتائج</div>`;
  } else {
    html += results.map(p => {
      const checked = _customCategProdIds.includes(p.id) ? "checked" : "";
      const safeName = (p.name || "").replace(/'/g, "\\'");
      const catLabel = Array.isArray(p.categ_id) ? p.categ_id[1] : "";
      return `<label class="constat-prod-result-item" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
         <input type="checkbox" ${checked}
                onchange="customCategToggleProd(${p.id},'${safeName}',this.checked)">
         <span style="flex:1">${escHtml(productLabel(p.name)) || String(p.id)}</span>
         ${catLabel ? `<span style="color:var(--text3);font-size:9px">${escHtml(catLabel)}</span>` : ""}
       </label>`;
    }).join("");
  }
  resEl.innerHTML = html;
}

async function _wireCustomCategProdSearch() {
  const input = document.getElementById("customCategProdSearch");
  const resEl = document.getElementById("customCategProdResults");
  const catSel = document.getElementById("customCategOdooCategFilter");
  if (!input || !resEl) return;

  await _ensureCustomCategProductList();
  _populateCustomCategOdooFilter();
  _renderCustomCategProdResults(); // القائمة تظهر فورًا وتبقى مفتوحة دائمًا

  input.addEventListener("input", () => _renderCustomCategProdResults());
  if (catSel) catSel.addEventListener("change", () => _renderCustomCategProdResults());
}

async function openCustomCategModal() {
  const modal = document.getElementById("customCategModal");
  if (!modal) return;
  modal.style.display = "flex";
  _customCategResetForm();
  _customCategories = await _fetchCustomCategories();
  _renderCustomCategList();
  await _wireCustomCategProdSearch(); // تحميل المنتجات + الفئات + عرض القائمة فورًا
}

// ── فئات بائعين مخصصة (Custom Seller Categories — Report Builder) ──
// نفس مبدأ "فئات مخصصة" أعلاه لكن كل فئة = مجموعة بائعين (res.users id)
// بدل منتجات. لا تُغيّر أي شيء في منطق customCategories أعلاه.
let _customSellerCategories = [];      // { id, name, sellerIds, createdAt, updatedAt }[]
let _customSellerCategEditingId = null; // null = إنشاء جديد، غير null = تعديل فئة موجودة
let _customSellerCategIds = [];
let _customSellerCategNames = [];
let _customSellerCategAllSellers = null; // cache لقائمة بائعي Odoo (res.users)

async function _fetchCustomSellerCategories() {
  try {
    const r = await fetch("/api/sync/custom-seller-categories", { method: "GET", credentials: "include" });
    if (!r.ok) return [];
    const data = await r.json();
    return data?.categories || [];
  } catch (e) {
    console.warn("[customSellerCateg] fetch list failed:", e);
    return [];
  }
}

function _renderCustomSellerCategList() {
  const el = document.getElementById("customSellerCategList");
  if (!el) return;
  if (!_customSellerCategories.length) {
    el.innerHTML = `<p class="settings-hint" style="color:var(--text3)">لا توجد فئات بعد.</p>`;
    return;
  }
  el.innerHTML = _customSellerCategories.map(c => `
    <div class="constat-custom-prod-row" data-categ-id="${c.id}" style="flex-direction:row;align-items:center;justify-content:space-between">
      <span style="font-size:11px">${escHtml(c.name)} <span style="color:var(--text3)">(${(c.sellerIds||[]).length} بائع)</span></span>
      <div style="display:flex;gap:4px">
        <button class="btn-tool" onclick="customSellerCategStartEdit('${c.id}')">✎ تعديل</button>
        <button class="btn-tool btn-tool--danger" onclick="customSellerCategDelete('${c.id}')">✕ حذف</button>
      </div>
    </div>
  `).join("");
}

function _renderCustomSellerCategTags() {
  const el = document.getElementById("customSellerCategTags");
  if (!el) return;
  el.innerHTML = _customSellerCategIds.map((sid, i) => `
    <span class="constat-prod-tag">${escHtml(_customSellerCategNames[i] || String(sid))}
      <button onclick="customSellerCategRemoveTag(${i})">✕</button>
    </span>
  `).join("");
}

function customSellerCategRemoveTag(i) {
  _customSellerCategIds.splice(i, 1);
  _customSellerCategNames.splice(i, 1);
  _renderCustomSellerCategTags();
}

function _customSellerCategResetForm() {
  _customSellerCategEditingId = null;
  _customSellerCategIds = [];
  _customSellerCategNames = [];
  const nameInput = document.getElementById("customSellerCategNameInput");
  if (nameInput) nameInput.value = "";
  const searchInput = document.getElementById("customSellerCategSearch");
  if (searchInput) searchInput.value = "";
  const cancelBtn = document.getElementById("btnCustomSellerCategCancelEdit");
  if (cancelBtn) cancelBtn.style.display = "none";
  _renderCustomSellerCategTags();
  _renderCustomSellerCategResults();
}

function customSellerCategStartEdit(id) {
  const c = _customSellerCategories.find(x => x.id === id);
  if (!c) return;
  _customSellerCategEditingId = id;
  _customSellerCategIds = (c.sellerIds || []).slice();
  // لا نملك أسماء البائعين محليًا دومًا؛ نعرض المعرف إلى أن يُحلّ عبر القائمة المحمّلة
  _customSellerCategNames = _customSellerCategIds.map(sid => {
    const found = (_customSellerCategAllSellers || []).find(s => s.id === sid);
    return found ? found.name : String(sid);
  });
  const nameInput = document.getElementById("customSellerCategNameInput");
  if (nameInput) nameInput.value = c.name || "";
  const cancelBtn = document.getElementById("btnCustomSellerCategCancelEdit");
  if (cancelBtn) cancelBtn.style.display = "inline-flex";
  _renderCustomSellerCategTags();
  _renderCustomSellerCategResults();
}

async function customSellerCategDelete(id) {
  try {
    const r = await fetch(`/api/sync/custom-seller-categories/${id}`, { method: "DELETE", credentials: "include" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    _customSellerCategories = _customSellerCategories.filter(c => c.id !== id);
    _renderCustomSellerCategList();
    if (_customSellerCategEditingId === id) _customSellerCategResetForm();
    addNotif("تم حذف الفئة", "success");
  } catch (e) {
    console.warn("[customSellerCateg] delete failed:", e);
    addNotif("فشل حذف الفئة", "error");
  }
}

async function customSellerCategSave() {
  const name = document.getElementById("customSellerCategNameInput")?.value.trim();
  if (!name) { addNotif("أدخل اسم الفئة", "warning"); return; }
  if (!_customSellerCategIds.length) { addNotif("اختر بائعًا واحدًا على الأقل", "warning"); return; }

  const payload = { name, sellerIds: _customSellerCategIds.slice() };
  try {
    let r;
    if (_customSellerCategEditingId) {
      r = await fetch(`/api/sync/custom-seller-categories/${_customSellerCategEditingId}`, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      r = await fetch("/api/sync/custom-seller-categories", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    const saved = await r.json();
    if (_customSellerCategEditingId) {
      _customSellerCategories = _customSellerCategories.map(c => c.id === saved.id ? saved : c);
    } else {
      _customSellerCategories.push(saved);
    }
    _renderCustomSellerCategList();
    _customSellerCategResetForm();
    addNotif("تم حفظ الفئة ✓", "success");
  } catch (e) {
    console.warn("[customSellerCateg] save failed:", e);
    addNotif("فشل حفظ الفئة", "error");
  }
}

async function _ensureCustomSellerCategSellerList() {
  if (_customSellerCategAllSellers) return _customSellerCategAllSellers;
  const baseUrl = App.settings?.baseUrlPayment?.replace(/\/$/, "") || "";
  if (!baseUrl) { _customSellerCategAllSellers = []; return _customSellerCategAllSellers; }
  try {
    _customSellerCategAllSellers = await rpcController.fetchSellerList(baseUrl);
  } catch (e) {
    console.warn("[customSellerCateg] fetchSellerList failed:", e);
    _customSellerCategAllSellers = [];
  }
  return _customSellerCategAllSellers;
}

function customSellerCategToggle(id, name, checked) {
  const numId = parseInt(id, 10);
  if (checked) {
    if (!_customSellerCategIds.includes(numId)) {
      _customSellerCategIds.push(numId);
      _customSellerCategNames.push(name);
    }
  } else {
    const idx = _customSellerCategIds.indexOf(numId);
    if (idx !== -1) {
      _customSellerCategIds.splice(idx, 1);
      _customSellerCategNames.splice(idx, 1);
    }
  }
  _renderCustomSellerCategTags();
}

// يعرض نتائج البحث/الفلترة الحالية (دائم الظهور، يُحدَّث عند كل تغيير)
function _renderCustomSellerCategResults() {
  const resEl = document.getElementById("customSellerCategResults");
  const input = document.getElementById("customSellerCategSearch");
  if (!resEl) return;

  const q = (input?.value || "").trim().toLowerCase();
  const all = _customSellerCategAllSellers || [];
  const tokens = q.split(/\s+/).filter(Boolean);

  let results = all.filter(s => {
    if (tokens.length) {
      const name = (s.name || "").toLowerCase();
      if (!tokens.every(t => name.includes(t))) return false;
    }
    return true;
  });

  results = results.slice(0, 200); // حد أقصى لتفادي إبطاء العرض

  let html = "";
  if (!results.length) {
    html += `<div class="constat-prod-result-item" style="color:var(--text3)">لا نتائج</div>`;
  } else {
    html += results.map(s => {
      const checked = _customSellerCategIds.includes(s.id) ? "checked" : "";
      const safeName = (s.name || "").replace(/'/g, "\\'");
      return `<label class="constat-prod-result-item" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
         <input type="checkbox" ${checked}
                onchange="customSellerCategToggle(${s.id},'${safeName}',this.checked)">
         <span style="flex:1">${escHtml(s.name || String(s.id))}</span>
       </label>`;
    }).join("");
  }
  resEl.innerHTML = html;
}

async function _wireCustomSellerCategSearch() {
  const input = document.getElementById("customSellerCategSearch");
  const resEl = document.getElementById("customSellerCategResults");
  if (!input || !resEl) return;

  await _ensureCustomSellerCategSellerList();
  _renderCustomSellerCategResults(); // القائمة تظهر فورًا وتبقى مفتوحة دائمًا

  input.addEventListener("input", () => _renderCustomSellerCategResults());
}

async function openCustomSellerCategModal() {
  const modal = document.getElementById("customSellerCategModal");
  if (!modal) return;
  modal.style.display = "flex";
  _customSellerCategResetForm();
  _customSellerCategories = await _fetchCustomSellerCategories();
  _renderCustomSellerCategList();
  await _wireCustomSellerCategSearch(); // تحميل البائعين + عرض القائمة فورًا
}

// ── فئات قوائم أسعار مخصصة (Custom Pricelist Categories — Report Builder) ──
// نفس مبدأ "فئات بائعين مخصصة" أعلاه لكن كل فئة = مجموعة قوائم أسعار
// (product.pricelist id) بدل بائعين. لا تُغيّر أي شيء في منطق
// customSellerCategories أعلاه.
let _customPricelistCategories = [];      // { id, name, pricelistIds, createdAt, updatedAt }[]
let _customPricelistCategEditingId = null; // null = إنشاء جديد، غير null = تعديل فئة موجودة
let _customPricelistCategIds = [];
let _customPricelistCategNames = [];
let _customPricelistCategAllPricelists = null; // cache لقائمة قوائم أسعار Odoo (product.pricelist)

async function _fetchCustomPricelistCategories() {
  try {
    const r = await fetch("/api/sync/custom-pricelist-categories", { method: "GET", credentials: "include" });
    if (!r.ok) return [];
    const data = await r.json();
    return data?.categories || [];
  } catch (e) {
    console.warn("[customPricelistCateg] fetch list failed:", e);
    return [];
  }
}

function _renderCustomPricelistCategList() {
  const el = document.getElementById("customPricelistCategList");
  if (!el) return;
  if (!_customPricelistCategories.length) {
    el.innerHTML = `<p class="settings-hint" style="color:var(--text3)">لا توجد فئات بعد.</p>`;
    return;
  }
  el.innerHTML = _customPricelistCategories.map(c => `
    <div class="constat-custom-prod-row" data-categ-id="${c.id}" style="flex-direction:row;align-items:center;justify-content:space-between">
      <span style="font-size:11px">${escHtml(c.name)} <span style="color:var(--text3)">(${(c.pricelistIds||[]).length} قائمة سعر)</span></span>
      <div style="display:flex;gap:4px">
        <button class="btn-tool" onclick="customPricelistCategStartEdit('${c.id}')">✎ تعديل</button>
        <button class="btn-tool btn-tool--danger" onclick="customPricelistCategDelete('${c.id}')">✕ حذف</button>
      </div>
    </div>
  `).join("");
}

function _renderCustomPricelistCategTags() {
  const el = document.getElementById("customPricelistCategTags");
  if (!el) return;
  el.innerHTML = _customPricelistCategIds.map((pid, i) => `
    <span class="constat-prod-tag">${escHtml(_customPricelistCategNames[i] || String(pid))}
      <button onclick="customPricelistCategRemoveTag(${i})">✕</button>
    </span>
  `).join("");
}

function customPricelistCategRemoveTag(i) {
  _customPricelistCategIds.splice(i, 1);
  _customPricelistCategNames.splice(i, 1);
  _renderCustomPricelistCategTags();
}

function _customPricelistCategResetForm() {
  _customPricelistCategEditingId = null;
  _customPricelistCategIds = [];
  _customPricelistCategNames = [];
  const nameInput = document.getElementById("customPricelistCategNameInput");
  if (nameInput) nameInput.value = "";
  const searchInput = document.getElementById("customPricelistCategSearch");
  if (searchInput) searchInput.value = "";
  const cancelBtn = document.getElementById("btnCustomPricelistCategCancelEdit");
  if (cancelBtn) cancelBtn.style.display = "none";
  _renderCustomPricelistCategTags();
  _renderCustomPricelistCategResults();
}

function customPricelistCategStartEdit(id) {
  const c = _customPricelistCategories.find(x => x.id === id);
  if (!c) return;
  _customPricelistCategEditingId = id;
  _customPricelistCategIds = (c.pricelistIds || []).slice();
  // لا نملك أسماء قوائم الأسعار محليًا دومًا؛ نعرض المعرف إلى أن يُحلّ عبر القائمة المحمّلة
  _customPricelistCategNames = _customPricelistCategIds.map(pid => {
    const found = (_customPricelistCategAllPricelists || []).find(p => p.id === pid);
    return found ? found.name : String(pid);
  });
  const nameInput = document.getElementById("customPricelistCategNameInput");
  if (nameInput) nameInput.value = c.name || "";
  const cancelBtn = document.getElementById("btnCustomPricelistCategCancelEdit");
  if (cancelBtn) cancelBtn.style.display = "inline-flex";
  _renderCustomPricelistCategTags();
  _renderCustomPricelistCategResults();
}

async function customPricelistCategDelete(id) {
  try {
    const r = await fetch(`/api/sync/custom-pricelist-categories/${id}`, { method: "DELETE", credentials: "include" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    _customPricelistCategories = _customPricelistCategories.filter(c => c.id !== id);
    _renderCustomPricelistCategList();
    if (_customPricelistCategEditingId === id) _customPricelistCategResetForm();
    addNotif("تم حذف الفئة", "success");
  } catch (e) {
    console.warn("[customPricelistCateg] delete failed:", e);
    addNotif("فشل حذف الفئة", "error");
  }
}

async function customPricelistCategSave() {
  const name = document.getElementById("customPricelistCategNameInput")?.value.trim();
  if (!name) { addNotif("أدخل اسم الفئة", "warning"); return; }
  if (!_customPricelistCategIds.length) { addNotif("اختر قائمة سعر واحدة على الأقل", "warning"); return; }

  const payload = { name, pricelistIds: _customPricelistCategIds.slice() };
  try {
    let r;
    if (_customPricelistCategEditingId) {
      r = await fetch(`/api/sync/custom-pricelist-categories/${_customPricelistCategEditingId}`, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      r = await fetch("/api/sync/custom-pricelist-categories", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    const saved = await r.json();
    if (_customPricelistCategEditingId) {
      _customPricelistCategories = _customPricelistCategories.map(c => c.id === saved.id ? saved : c);
    } else {
      _customPricelistCategories.push(saved);
    }
    _renderCustomPricelistCategList();
    _customPricelistCategResetForm();
    addNotif("تم حفظ الفئة ✓", "success");
  } catch (e) {
    console.warn("[customPricelistCateg] save failed:", e);
    addNotif("فشل حفظ الفئة", "error");
  }
}

async function _ensureCustomPricelistCategPricelistList() {
  if (_customPricelistCategAllPricelists) return _customPricelistCategAllPricelists;
  const baseUrl = App.settings?.baseUrlPayment?.replace(/\/$/, "") || "";
  if (!baseUrl) { _customPricelistCategAllPricelists = []; return _customPricelistCategAllPricelists; }
  try {
    _customPricelistCategAllPricelists = await rpcController.fetchPricelistList(baseUrl);
  } catch (e) {
    console.warn("[customPricelistCateg] fetchPricelistList failed:", e);
    _customPricelistCategAllPricelists = [];
  }
  return _customPricelistCategAllPricelists;
}

function customPricelistCategToggle(id, name, checked) {
  const numId = parseInt(id, 10);
  if (checked) {
    if (!_customPricelistCategIds.includes(numId)) {
      _customPricelistCategIds.push(numId);
      _customPricelistCategNames.push(name);
    }
  } else {
    const idx = _customPricelistCategIds.indexOf(numId);
    if (idx !== -1) {
      _customPricelistCategIds.splice(idx, 1);
      _customPricelistCategNames.splice(idx, 1);
    }
  }
  _renderCustomPricelistCategTags();
}

// يعرض نتائج البحث/الفلترة الحالية (دائم الظهور، يُحدَّث عند كل تغيير)
function _renderCustomPricelistCategResults() {
  const resEl = document.getElementById("customPricelistCategResults");
  const input = document.getElementById("customPricelistCategSearch");
  if (!resEl) return;

  const q = (input?.value || "").trim().toLowerCase();
  const all = _customPricelistCategAllPricelists || [];
  const tokens = q.split(/\s+/).filter(Boolean);

  let results = all.filter(p => {
    if (tokens.length) {
      const name = (p.name || "").toLowerCase();
      if (!tokens.every(t => name.includes(t))) return false;
    }
    return true;
  });

  results = results.slice(0, 200); // حد أقصى لتفادي إبطاء العرض

  let html = "";
  if (!results.length) {
    html += `<div class="constat-prod-result-item" style="color:var(--text3)">لا نتائج</div>`;
  } else {
    html += results.map(p => {
      const checked = _customPricelistCategIds.includes(p.id) ? "checked" : "";
      const safeName = (p.name || "").replace(/'/g, "\\'");
      return `<label class="constat-prod-result-item" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
         <input type="checkbox" ${checked}
                onchange="customPricelistCategToggle(${p.id},'${safeName}',this.checked)">
         <span style="flex:1">${escHtml(p.name || String(p.id))}</span>
       </label>`;
    }).join("");
  }
  resEl.innerHTML = html;
}

async function _wireCustomPricelistCategSearch() {
  const input = document.getElementById("customPricelistCategSearch");
  const resEl = document.getElementById("customPricelistCategResults");
  if (!input || !resEl) return;

  await _ensureCustomPricelistCategPricelistList();
  _renderCustomPricelistCategResults(); // القائمة تظهر فورًا وتبقى مفتوحة دائمًا

  input.addEventListener("input", () => _renderCustomPricelistCategResults());
}

async function openCustomPricelistCategModal() {
  const modal = document.getElementById("customPricelistCategModal");
  if (!modal) return;
  modal.style.display = "flex";
  _customPricelistCategResetForm();
  _customPricelistCategories = await _fetchCustomPricelistCategories();
  _renderCustomPricelistCategList();
  await _wireCustomPricelistCategSearch(); // تحميل قوائم الأسعار + عرض القائمة فورًا
}

function saveConstatSettings() {
  if (!App.settings.categCF) App.settings.categCF = {};
  if (!App.settings.constatThresholds) App.settings.constatThresholds = {};
  App.settings.constatThresholds.maxFirstVisit = document.getElementById("constatMaxFirstVisit")?.value || "";
  App.settings.constatThresholds.minLastVisit  = document.getElementById("constatMinLastVisit")?.value  || "";
  App.settings.constatThresholds.minWorkTime   = document.getElementById("constatMinWorkTime")?.value   || "";
  Storage.saveSettings(App.settings).then(() => {
    addNotif("Config Constat sauvegardée ✓", "success");
  });
}

// ── Save settings ─────────────────────────────────────────────
async function saveSettings() {
  const s = App.settings;
  const saveMsg = document.getElementById("saveMsg");
  const getVal  = id => document.getElementById(id)?.value.trim() || "";

  s.baseUrlPayment = getVal("settingUrlPayment");

  const colorPicker = document.getElementById("cardColorPicker");
  if (colorPicker) s.cardColor = colorPicker.value;

  const showUpdChk = document.getElementById("showUpdatedAt");
  if (showUpdChk) s.showUpdatedAt = showUpdChk.checked;

  const alertsChk = document.getElementById("showRoundAlerts");
  if (alertsChk) s.showRoundAlerts = alertsChk.checked;

  const autoSyncChk = document.getElementById("autoSyncEnabled");
  if (autoSyncChk) s.autoSyncEnabled = autoSyncChk.checked;

  // Auto-fetch settings
  const afEnabledChk = document.getElementById("afEnabled");
  if (afEnabledChk) s.autoFetchEnabled = afEnabledChk.checked;
  const afPauseBgChk = document.getElementById("afPauseBackground");
  if (afPauseBgChk) s.autoFetchPauseBackground = afPauseBgChk.checked;
  // autoFetchInterval is managed by stepper directly on App.settings

  // Save 3-state button visibility
  const btnKeys = ["open","route","bl","analyse","copy","trash","link","pay","accepthors","closep","openp","addprod","stockfinal","journalstock","addclient","horszone"];
  btnKeys.forEach(k => {
    const radios = document.querySelectorAll(`input[name="btnMode_${k}"]`);
    if (!radios.length) return;
    let mode = "card";
    radios.forEach(r => { if (r.checked) mode = r.value; });
    s[`hideBtn_${k}`] = mode === "hidden";
    s[`menuBtn_${k}`] = mode === "menu";
  });

  s.vendors = (s.vendors||[]).filter(v => v.name);
  s.vendors.forEach(v => { if (!v.label) v.label=shortLabel(v.name); if (!v.role) v.role="prevente"; });

  // Routes prioritaires (recherche client paiement)
  if (document.getElementById("pmRoutesContainer")) {
    const draft = App.pmRoutesDraft || [];
    const allValid = draft.every(r => r.valid);
    if (allValid) {
      s.pmRoutes = draft.map(r => ({ id: r.id, name: r.name }));
    } else {
      addNotif("Routes prioritaires: une ou plusieurs entrées invalides — section ignorée", "warning");
      renderPmRoutesEditor();
    }
  }

  await Storage.saveSettings(s);
  if (s.autoSyncEnabled) pushSettingsToCloud();
  if (saveMsg) { saveMsg.textContent="Sauvegardé ✓"; saveMsg.className="save-msg ok"; setTimeout(()=>{ saveMsg.textContent=""; }, 2000); }
  applyDisplaySettings(); renderVendors(); addNotif("Paramètres sauvegardés ✓", "success");

  // Re-init auto-fetch with new settings
  AutoFetch.init();
}

// ── Stepper helper ────────────────────────────────────────────
function bindStepper(minusId, plusId, valueId, key, min, max, step=1) {
  const el = document.getElementById(valueId);
  document.getElementById(minusId)?.addEventListener("click", () => {
    App.settings[key] = Math.max(min, (App.settings[key]??min)-step);
    if (el) el.textContent = App.settings[key]; applyDisplaySettings();
  });
  document.getElementById(plusId)?.addEventListener("click", () => {
    const v = (App.settings[key]??min)+step;
    App.settings[key] = max===Infinity ? v : Math.min(max, v);
    if (el) el.textContent = App.settings[key]; applyDisplaySettings();
  });
  if (el) {
    el.contentEditable="true";
    el.addEventListener("keydown", e => { if(e.key==="Enter"){e.preventDefault();el.blur();} });
    el.addEventListener("blur", () => {
      const v = parseInt(el.textContent, 10);
      if (!isNaN(v)) { App.settings[key]=max===Infinity?Math.max(min,v):Math.min(max,Math.max(min,v)); el.textContent=App.settings[key]; applyDisplaySettings(); }
      else el.textContent = App.settings[key] ?? min;
    });
  }
}

// ── Workflows Manager ──────────────────────────────────────────
const DEFAULT_WORKFLOWS = [
  { name: "Prevendeur",    role: "prevente"  },
  { name: "Livreur",       role: "livraison" },
  { name: "Merchandiseur", role: "merch"       },
];

const ROLE_OPTIONS = [
  { value: "prevente",     label: "Prévente"      },
  { value: "livraison",    label: "Livraison"      },
  { value: "merch",          label: "Merch."         },
  { value: "recouvrement", label: "Recouvrement"   },
];

function _ensureWorkflows() {
  if (!App.settings.workflows || !App.settings.workflows.length) {
    App.settings.workflows = DEFAULT_WORKFLOWS.map(w => ({
      id: "wf" + Date.now() + Math.random().toString(36).slice(2,5),
      name: w.name, role: w.role, enabled: true
    }));
  }
}

function renderWorkflowsManager() {
  _ensureWorkflows();
  const container = document.getElementById("workflowsManager");
  if (!container) return;
  container.innerHTML = (App.settings.workflows || []).map((wf, i) => `
    <div class="wf-row" data-wf-id="${wf.id}">
      <input class="wf-name-input" type="text" value="${wf.name||""}" placeholder="Nom workflow" data-idx="${i}"/>
      <select class="wf-role-select" data-idx="${i}">
        ${ROLE_OPTIONS.map(r => `<option value="${r.value}"${wf.role===r.value?" selected":""}>${r.label}</option>`).join("")}
      </select>
      <label class="wf-toggle">
        <input type="checkbox" ${wf.enabled?"checked":""} data-idx="${i}" class="wf-enabled-chk"/>
        <span></span>
      </label>
      <button class="delete-vendor-btn wf-del-btn" data-idx="${i}" title="Supprimer">✕</button>
    </div>
  `).join("");

  container.querySelectorAll(".wf-name-input").forEach(inp => {
    inp.addEventListener("input", e => {
      App.settings.workflows[+e.target.dataset.idx].name = e.target.value.trim();
    });
  });
  container.querySelectorAll(".wf-role-select").forEach(sel => {
    sel.addEventListener("change", e => {
      App.settings.workflows[+e.target.dataset.idx].role = e.target.value;
    });
  });
  container.querySelectorAll(".wf-enabled-chk").forEach(chk => {
    chk.addEventListener("change", e => {
      App.settings.workflows[+e.target.dataset.idx].enabled = e.target.checked;
    });
  });
  container.querySelectorAll(".wf-del-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      App.settings.workflows.splice(+e.target.dataset.idx, 1);
      renderWorkflowsManager();
    });
  });
}

// ── Agents Manager (drag & drop) ──────────────────────────────
// ── Vendors (agents) → Firebase sync ───────────────────────────
// Toute modification d'ordre / label / rôle / activation des agents doit
// être répercutée sur Firebase (pas seulement lors du clic sur "Sauvegarder").
function _vendorsSharedPatch() {
  const vendors = App.settings.vendors || [];
  return {
    vendorOrder:   vendors.map(v => v.workerId).filter(Boolean),
    vendorLabels:  Object.fromEntries(vendors.filter(v => v.workerId && v.label).map(v => [v.workerId, v.label])),
    vendorEnabled: Object.fromEntries(vendors.filter(v => v.workerId).map(v => [v.workerId, v.enabled ?? true])),
  };
}

function syncVendorsNow(permission) {
  Storage.saveSettings(App.settings);
  if (App.settings.autoSyncEnabled && typeof FirebaseSync !== "undefined") {
    FirebaseSync.pushSharedUpdate(_vendorsSharedPatch(), permission)
      .catch(e => console.error("[FirebaseSync] pushSharedUpdate (vendors):", e));
  }
}

// ── رفع/تحميل يدوي للسحابة (زرّا "Envoyer au cloud" / "Charger du cloud") ─
// يشمل: agents (vendors) + workflows + favoris des filtres (favBar).
// لا يشمل أبدًا: إعدادات العرض (Affichage — Cartes / Vue Partagée — Cartes)
// التي تبقى محلية على كل جهاز فقط.
async function pushSettingsToCloud() {
  if (typeof FirebaseSync === "undefined") return;
  const patch = { ..._vendorsSharedPatch(), workflows: App.settings.workflows || [], filterFavourites: App.settings.filterFavourites || {} };
  const ok = await FirebaseSync.pushSharedUpdate(patch, "settings.workflows");
  addNotif(ok ? "Envoyé vers le cloud ✓" : "Échec de l'envoi vers le cloud", ok ? "success" : "error");
}

async function pullSettingsFromCloud() {
  if (typeof FirebaseSync === "undefined") return;
  const ok = await FirebaseSync.pullNow();
  if (ok) {
    App.settings = await Storage.getSettings();
    applyDisplaySettings();
    renderVendors();
    renderWorkflowsManager();
    renderSettings();
    if (typeof loadFilterFavourites === "function") loadFilterFavourites();
    if (typeof renderFavChips === "function") renderFavChips();
    addNotif("Chargé depuis le cloud ✓", "success");
  } else {
    addNotif("Échec du chargement depuis le cloud", "error");
  }
}

let _syncVendorsTimer = null;
function syncVendorsDebounced(delay = 600, permission) {
  clearTimeout(_syncVendorsTimer);
  _syncVendorsTimer = setTimeout(() => syncVendorsNow(permission), delay);
}

// Déplace un agent vers un RANG précis (1-based) dans l'ordre AFFICHÉ.
// Les éléments entre l'ancienne et la nouvelle position sont décalés d'un
// rang (comportement "insertion", comme demandé) — ex: 10 éléments, on tape
// 4 sur un agent qui est en position 8 → il devient le 4e, et les agents qui
// étaient en 4,5,6,7 deviennent 5,6,7,8.
function moveVendorTo(realIdx, targetPos1Based) {
  if (!hasPermission("agents.reorder")) { addNotif("Permission refusée", "error"); return; }
  const vendors = App.settings.vendors;
  if (!Array.isArray(vendors) || !vendors.length) return;
  const ord = vendors.map((v, idx) => idx)
    .sort((a, b) => (vendors[b].enabled ? 1 : 0) - (vendors[a].enabled ? 1 : 0));
  const curPos = ord.indexOf(realIdx);
  const target = Math.max(1, Math.min(vendors.length, Math.round(targetPos1Based))) - 1; // 0-based
  if (target === curPos) { renderVendorsManager(); return; }
  ord.splice(curPos, 1);
  ord.splice(target, 0, realIdx);
  App.settings.vendors = ord.map(idx => vendors[idx]);
  renderVendorsManager();
  syncVendorsNow("agents.reorder");
}

// Déplace un agent d'une position dans l'ordre AFFICHÉ (haut/bas), en tenant
// compte du tri visuel (actifs d'abord). Alternative simple au glisser-déposer
// pour les listes longues.
function moveVendorDisplay(realIdx, dir) {
  if (!hasPermission("agents.reorder")) { addNotif("Permission refusée", "error"); return; }
  const vendors = App.settings.vendors;
  if (!Array.isArray(vendors) || !vendors.length) return;
  const ord = vendors.map((v, idx) => idx)
    .sort((a, b) => (vendors[b].enabled ? 1 : 0) - (vendors[a].enabled ? 1 : 0));
  const pos = ord.indexOf(realIdx);
  const targetPos = dir === "up" ? pos - 1 : pos + 1;
  if (targetPos < 0 || targetPos >= ord.length) return;
  const otherRealIdx = ord[targetPos];
  [vendors[realIdx], vendors[otherRealIdx]] = [vendors[otherRealIdx], vendors[realIdx]];
  renderVendorsManager();
  syncVendorsNow("agents.reorder");
}

function renderVendorsManager() {
  const container = document.getElementById("vendorsManager");
  if (!container) return;
  const vendors = App.settings.vendors || [];
  const count = document.getElementById("agentsCount");
  if (count) count.textContent = `${vendors.length} agent(s)`;

  if (!vendors.length) {
    container.innerHTML = `<p class="settings-hint" style="text-align:center;padding:10px">Aucun agent. Importez depuis Odoo.</p>`;
    return;
  }

  const order = vendors.map((v, i) => i)
    .sort((a, b) => (vendors[b].enabled ? 1 : 0) - (vendors[a].enabled ? 1 : 0));

  container.innerHTML = order.map((i, pos) => { const v = vendors[i]; return `
    <div class="agent-row" draggable="true" data-idx="${i}">
      <div class="drag-handle" title="Déplacer (glisser)">⠿</div>
      <input type="number" class="agent-pos-input" data-idx="${i}" value="${pos+1}" min="1" max="${order.length}" title="Position (tapez un numéro pour sauter directement)"/>
      <div class="agent-move-btns">
        <button class="agent-move-btn" data-idx="${i}" data-dir="top"    title="Tout en haut"  ${pos===0?"disabled":""}>⏫</button>
        <button class="agent-move-btn" data-idx="${i}" data-dir="up"     title="Monter"        ${pos===0?"disabled":""}>▲</button>
        <button class="agent-move-btn" data-idx="${i}" data-dir="down"   title="Descendre"     ${pos===order.length-1?"disabled":""}>▼</button>
        <button class="agent-move-btn" data-idx="${i}" data-dir="bottom" title="Tout en bas"    ${pos===order.length-1?"disabled":""}>⏬</button>
      </div>
      <span class="agent-name" title="${v.name||''}"><span>${v.name||"—"}</span><br><small class="agent-id" style="font-size:9px;color:var(--text3)">${v.workerId||""}</small></span>
      <input type="text" class="agent-label-input" data-idx="${i}" value="${v.label||""}" placeholder="Label…"/>
      <button class="agent-label-reset btn-tool" data-idx="${i}" title="Réinitialiser le label" style="padding:0 3px;font-size:11px;line-height:1.4;flex-shrink:0;min-width:unset">↺</button>
      <select class="agent-role-select" data-idx="${i}">
        ${ROLE_OPTIONS.map(r => `<option value="${r.value}"${v.role===r.value?" selected":""}>${r.label}</option>`).join("")}
      </select>
      <label class="agent-toggle" title="${v.enabled?"Désactiver":"Activer"}">
        <input type="checkbox" ${v.enabled?"checked":""} data-idx="${i}" class="agent-enabled-chk"/>
        <span></span>
      </label>
    </div>
  `; }).join("");

  // Label change
  container.querySelectorAll(".agent-label-input").forEach(inp => {
    inp.addEventListener("input", e => {
      if (!hasPermission("agents.editLabels")) { addNotif("Permission refusée", "error"); renderVendorsManager(); return; }
      const idx = +e.target.dataset.idx;
      App.settings.vendors[idx].label = e.target.value.trim();
      syncVendorsDebounced(600, "agents.editLabels");
    });
  });
  // Reset label per card
  container.querySelectorAll(".agent-label-reset").forEach(btn => {
    btn.addEventListener("click", e => {
      if (!hasPermission("agents.editLabels")) { addNotif("Permission refusée", "error"); return; }
      const idx = +e.target.dataset.idx;
      const defaultLabel = shortLabel(App.settings.vendors[idx].displayName || App.settings.vendors[idx].name || "");
      App.settings.vendors[idx].label = defaultLabel;
      const inp = container.querySelector(`.agent-label-input[data-idx="${idx}"]`);
      if (inp) inp.value = defaultLabel;
      syncVendorsNow("agents.editLabels");
    });
  });
  // Role change
  container.querySelectorAll(".agent-role-select").forEach(sel => {
    sel.addEventListener("change", e => {
      const idx = +e.target.dataset.idx;
      App.settings.vendors[idx].role = e.target.value;
    });
  });
  // Toggle
  container.querySelectorAll(".agent-enabled-chk").forEach(chk => {
    chk.addEventListener("change", e => {
      if (!hasPermission("agents.toggle")) { addNotif("Permission refusée", "error"); renderVendorsManager(); return; }
      const idx = +e.target.dataset.idx;
      App.settings.vendors[idx].enabled = e.target.checked;
      renderVendorsManager();
      syncVendorsNow("agents.toggle");
    });
  });

  // Move up/down/top/bottom (alternative facile au drag&drop pour les longues listes)
  container.querySelectorAll(".agent-move-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      const realIdx = +e.currentTarget.dataset.idx;
      const dir = e.currentTarget.dataset.dir;
      if (dir === "up" || dir === "down") {
        moveVendorDisplay(realIdx, dir);
      } else if (dir === "top") {
        moveVendorTo(realIdx, 1);
      } else if (dir === "bottom") {
        moveVendorTo(realIdx, vendors.length);
      }
    });
  });

  // Position numérique — taper un rang saute directement à cette position,
  // en décalant l'élément qui l'occupait (et les suivants) d'un rang.
  container.querySelectorAll(".agent-pos-input").forEach(inp => {
    inp.addEventListener("mousedown", e => e.stopPropagation());
    const commit = e => {
      const realIdx = +e.target.dataset.idx;
      const val = parseInt(e.target.value, 10);
      if (!val || Number.isNaN(val)) { renderVendorsManager(); return; }
      moveVendorTo(realIdx, val);
    };
    inp.addEventListener("change", commit);
    inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.target.blur(); } });
  });

  // Drag & drop
  let dragSrcIdx = null;
  container.querySelectorAll(".agent-row").forEach(row => {
    // Disable row drag while interacting with inputs
    row.querySelectorAll("input, select, textarea").forEach(inp => {
      inp.addEventListener("mousedown", () => { row.draggable = false; });
      inp.addEventListener("mouseup",   () => { row.draggable = true; });
      inp.addEventListener("blur",      () => { row.draggable = true; });
    });

    row.addEventListener("dragstart", e => {
      if (!row.draggable) { e.preventDefault(); return; }
      dragSrcIdx = +row.dataset.idx;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", e => { e.preventDefault(); row.classList.add("drag-over"); });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", e => {
      e.preventDefault();
      row.classList.remove("drag-over");
      if (!hasPermission("agents.reorder")) { addNotif("Permission refusée", "error"); return; }
      const targetIdx = +row.dataset.idx;
      if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;
      const arr = App.settings.vendors;
      const [moved] = arr.splice(dragSrcIdx, 1);
      arr.splice(targetIdx, 0, moved);
      dragSrcIdx = null;
      renderVendorsManager();
      syncVendorsNow("agents.reorder");
    });
  });
}

// ── Import agents from Odoo ────────────────────────────────────
// Applique le dernier ordre/labels/enabled reçus de Firebase (mis en cache
// localement dans App.settings.vendorOrder/vendorLabels/vendorEnabled lors
// du syncOnStartup) sur une liste d'agents — utile après un import Odoo sur
// un appareil qui n'avait encore aucun agent local au moment du sync.
function applyCachedVendorSync(vendors) {
  const vendorOrder   = App.settings.vendorOrder;
  const vendorLabels  = App.settings.vendorLabels  || {};
  const vendorEnabled = App.settings.vendorEnabled || {};
  if (!Array.isArray(vendors) || !vendors.length) return vendors;

  const applySync = v => ({
    ...v,
    label:   vendorLabels[v.workerId]  ?? v.label,
    enabled: vendorEnabled[v.workerId] ?? v.enabled,
  });

  if (!Array.isArray(vendorOrder) || !vendorOrder.length) {
    return vendors.map(applySync);
  }
  const vendorsMap = new Map(vendors.map(v => [v.workerId, v]));
  const ordered    = vendorOrder.map(id => vendorsMap.get(id)).filter(Boolean).map(applySync);
  const remaining  = vendors.filter(v => !vendorOrder.includes(v.workerId)).map(applySync);
  return [...ordered, ...remaining];
}

async function importAgentsFromOdoo() {
  if (!hasPermission("agents.import")) { addNotif("Permission refusée", "error"); return; }
  const baseUrl = getOdooBase();
  if (!baseUrl) { addNotif("URL Odoo non configurée", "error"); return; }
  _ensureWorkflows();
  const activeWFs = (App.settings.workflows || []).filter(w => w.enabled && w.name);
  if (!activeWFs.length) { addNotif("Aucun workflow actif", "warning"); return; }

  const btn = document.getElementById("btnImportFromOdoo");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Import…"; }

  try {
    const wfNames = activeWFs.map(w => w.name);
    console.log("[import] baseUrl:", baseUrl, "wfNames:", wfNames);
    const results = await rpcController.fetchAgentsFromOdoo(baseUrl, wfNames, App.uid);
    console.log("[import] results:", results);
    if (!results.length) { addNotif("Aucun agent trouvé", "warning"); return; }

    if (!App.settings.vendors) App.settings.vendors = [];
    const vendorByOdooId = new Map(App.settings.vendors.map(v => [v.workerId, v]));
    let added = 0, updated = 0;

    results.forEach(agent => {
      const existing = vendorByOdooId.get(agent.odooId);
      if (existing) {
        // déjà présent: on met quand même à jour route(s) (ne remplace pas
        // le rôle/label déjà personnalisés par l'utilisateur)
        const newRouteIds = agent.routeIds || [];
        if (existing.routeId !== (agent.routeId ?? null) ||
            JSON.stringify(existing.routeIds || []) !== JSON.stringify(newRouteIds)) {
          existing.routeId    = agent.routeId ?? null;
          existing.routeName  = agent.routeName ?? null;
          existing.routeIds   = newRouteIds;
          existing.routeNames = agent.routeNames || [];
          updated++;
        }
        return;
      }
      // trouver le premier workflow actif qui correspond
      const matchedWF = activeWFs.find(wf => agent.workflows.includes(wf.name));
      const role = matchedWF ? matchedWF.role : "prevente";
      App.settings.vendors.push({
        id:          "v" + Date.now() + Math.random().toString(36).slice(2,5),
        name:        agent.name,
        displayName: agent.displayName || agent.name,
        label:       shortLabel(agent.displayName || agent.name),
        role,
        workerId:    agent.odooId,
        // routeId/routeName: premier mesar (planning_template_ids) du
        // vendeur (n'a de sens réel que pour le rôle prevente). routeIds/
        // routeNames: liste complète (un vendeur peut avoir plusieurs
        // routes) — voir _rpc_fetchAgentsFromOdoo.
        routeId:     agent.routeId ?? null,
        routeName:   agent.routeName ?? null,
        routeIds:    agent.routeIds || [],
        routeNames:  agent.routeNames || [],
        enabled:     true,
      });
      added++;
    });


    App.settings.vendors = applyCachedVendorSync(App.settings.vendors);

    await Storage.saveSettings(App.settings);
    if (App.settings.autoSyncEnabled && typeof FirebaseSync !== "undefined") {
      FirebaseSync.pushSharedUpdate(_vendorsSharedPatch(), "agents.import")
        .catch(e => console.error("[FirebaseSync] pushSharedUpdate (import):", e));
    }
    renderVendorsManager();
    const parts = [];
    if (added)   parts.push(`${added} ajouté(s)`);
    if (updated) parts.push(`${updated} route(s) mise(s) à jour`);
    addNotif(`✓ ${parts.length ? parts.join(", ") : "Rien à mettre à jour"}`, (added || updated) > 0 ? "success" : "info");
  } catch(err) {
    addNotif("Erreur import: " + err.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "↓ Importer depuis Odoo"; }
  }
}

function exportCurrentModeToExcel() {
  const mode = App.currentMode;
  const cfg  = App.settings?.constat?.[mode];
  if (cfg && (cfg.cols || []).some(c => c.enabled)) {
    exportConstatToExcel(mode);
    return;
  }
  // export basique original
  const workers = modeWorkers();
  if (!workers.length) { addNotif("Aucune donnée à exporter","warning"); return; }
  const today = getTodayKey();
  const rows  = workers.map(worker => {
    const st = App.allStats[worker.id] || {};
    const rs = App.allRoundStatus[worker.id] || "—";
    const row = {
      "Nom": worker.name, "Label": worker.label||shortLabel(worker.name),
      "Mode": worker.role, "Statut": rs, "P (Clients)": st.totalClients??"",
      "V% (Visite)":  st.visitRate   != null ? st.visitRate.toFixed(1)   : "",
      "S% (Succès)":  st.successRate != null ? st.successRate.toFixed(1) : "",
    };
    if (worker.role === "prevente") { row["CA"] = st.ca != null ? st.ca.toFixed(2) : ""; }
    row["Première visite"] = st.firstVisit||""; row["Dernière visite"] = st.lastVisit||""; row["Référence"] = App.allRefs[worker.id]||"";
    return row;
  });
  exportToExcel(rows, `wafa-${App.currentMode}-${today}.csv`);
  addNotif(`Excel exporté: ${rows.length} agents ✓`, "success");
}

// ── Rapport de distribution du jour (groupé par vendeur) ────────
let _dailyDistribExtraGroupBy = null; // "product_tmpl_id" | "categ_id" | null

async function _loadDailyDistribExtraGroupBySetting() {
  try {
    const r = await fetch("/api/sync/report-settings/daily-distribution", {
      method: "GET", credentials: "include",
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data?.extraGroupBy || null;
  } catch (e) {
    console.warn("[dailyDistrib] load setting failed:", e);
    return null;
  }
}

async function _saveDailyDistribExtraGroupBySetting(extraGroupBy) {
  try {
    await fetch("/api/sync/report-settings/daily-distribution", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extraGroupBy: extraGroupBy || null }),
    });
  } catch (e) {
    console.warn("[dailyDistrib] save setting failed:", e);
  }
}

async function openDailyDistribReport() {
  const modal = document.getElementById("dailyDistribModal");
  const body  = document.getElementById("dailyDistribBody");
  const dateLabel = document.getElementById("dailyDistribDateLabel");
  const select = document.getElementById("dailyDistribExtraGroupBy");
  if (!modal || !body) return;

  const dateLabelText = App.currentDateOffset === 0
    ? "Aujourd'hui — " + getDateKey(App.currentDateOffset).split("-").reverse().join("/")
    : getDateKey(App.currentDateOffset).split("-").reverse().join("/");
  dateLabel.textContent = dateLabelText;

  // استرجاع آخر إعداد محفوظ للمستخدم وتطبيقه على الـdropdown
  _dailyDistribExtraGroupBy = await _loadDailyDistribExtraGroupBySetting();
  if (select) select.value = _dailyDistribExtraGroupBy || "";

  modal.style.display = "flex";
  await _fetchAndRenderDailyDistribReport();
}

async function _fetchAndRenderDailyDistribReport() {
  const body = document.getElementById("dailyDistribBody");
  if (!body) return;

  const baseUrl       = getOdooBase();
  const targetDateKey = getDateKey(App.currentDateOffset);
  body.innerHTML = `<p class="settings-hint" style="text-align:center;padding:20px 0">Chargement…</p>`;

  let distribData, j1Data, collectionsData;
  try {
    [distribData, j1Data, collectionsData] = await Promise.all([
      rpcController.fetchDailyDistributionReport(baseUrl, targetDateKey, _dailyDistribExtraGroupBy),
      rpcController.fetchJ1SalesReport(baseUrl, targetDateKey, _dailyDistribExtraGroupBy),
      rpcController.fetchDailyCollectionsReport(baseUrl, targetDateKey),
    ]);
  } catch (e) {
    body.innerHTML = `<p class="settings-hint" style="text-align:center;padding:20px 0;color:var(--red)">Erreur: ${escHtml(e.message)}</p>`;
    return;
  }

  renderDailyDistribReport(distribData, j1Data, collectionsData);
}

function renderDailyDistribReport(data, j1Data, collectionsData) {
  const body = document.getElementById("dailyDistribBody");
  if (!body) return;
  const distribRows     = data?.rows            || [];
  const j1Rows          = j1Data?.rows          || [];
  const collectionsRows = collectionsData?.rows || [];

  if (!distribRows.length && !j1Rows.length && !collectionsRows.length) {
    body.innerHTML = `<p class="settings-hint" style="text-align:center;padding:20px 0">Aucune distribution ni vente J-1 trouvée pour cette date.</p>`;
    return;
  }

  const extraGroupBy = _dailyDistribExtraGroupBy;
  // مفتاح الدمج: بائع فقط (بدون تجميع إضافي)، أو بائع+extraId (معه)
  const keyOf = r => extraGroupBy ? `${r.vendeurId}::${r.extraId ?? "none"}` : `${r.vendeurId}`;

  // ── دمج الصفوف حسب (البائع[+تفصيل إضافي]) — اتحاد المعرّفات من 3 مصادر ──
  const byKey = {};
  const blank = (r) => ({
    vendeurId: r.vendeurId, vendeurName: r.vendeurName,
    extraId: r.extraId ?? null, extraName: r.extraName ?? null,
    qtyLivree: 0, qtyFacturee: 0, montantHT: 0, montantTTC: 0, remise: 0,
    qtyVendueJ1: 0, montantHTJ1: 0, montantTTCJ1: 0,
    montantEncaisse: 0,
  });
  for (const r of distribRows) {
    const k = keyOf(r);
    byKey[k] = { ...blank(r),
      qtyLivree: r.qtyLivree, qtyFacturee: r.qtyFacturee,
      montantHT: r.montantHT, montantTTC: r.montantTTC, remise: r.remise,
    };
  }
  for (const r of j1Rows) {
    const k = keyOf(r);
    if (!byKey[k]) byKey[k] = blank(r);
    byKey[k].qtyVendueJ1  = r.qtyVendueJ1;
    byKey[k].montantHTJ1  = r.montantHTJ1;
    byKey[k].montantTTCJ1 = r.montantTTCJ1;
  }
  // التحصيلات ليست مجمّعة حسب extra، فتُضاف فقط على مستوى البائع (بدون extra)
  const encaisseByVendeur = {};
  for (const r of collectionsRows) encaisseByVendeur[r.vendeurId] = r.montantEncaisse;
  if (!extraGroupBy) {
    for (const r of collectionsRows) {
      const k = keyOf(r);
      if (!byKey[k]) byKey[k] = blank(r);
      byKey[k].montantEncaisse = r.montantEncaisse;
    }
  }

  const rows = Object.values(byKey).sort((a, b) => {
    const byV = a.vendeurName.localeCompare(b.vendeurName, "fr");
    if (byV !== 0 || !extraGroupBy) return byV;
    return (a.extraName || "").localeCompare(b.extraName || "", "fr");
  });

  const totals = rows.reduce((acc, r) => {
    acc.qtyLivree    += r.qtyLivree;
    acc.qtyFacturee  += r.qtyFacturee;
    acc.montantHT    += r.montantHT;
    acc.montantTTC   += r.montantTTC;
    acc.remise       += r.remise;
    acc.qtyVendueJ1  += r.qtyVendueJ1;
    acc.montantHTJ1  += r.montantHTJ1;
    acc.montantTTCJ1 += r.montantTTCJ1;
    return acc;
  }, { qtyLivree: 0, qtyFacturee: 0, montantHT: 0, montantTTC: 0, remise: 0, qtyVendueJ1: 0, montantHTJ1: 0, montantTTCJ1: 0 });
  const totalEncaisse = Object.values(encaisseByVendeur).reduce((s, v) => s + (v || 0), 0);

  const fmt = n => (n || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const extraLabel = extraGroupBy === "product_tmpl_id" ? "Produit" : extraGroupBy === "categ_id" ? "Catégorie" : null;

  body.innerHTML = `
    <div style="overflow-x:auto">
    <table class="gds-table" id="dailyDistribTable" style="width:100%;min-width:900px">
      <thead>
        <tr>
          <th style="white-space:nowrap;min-width:140px">Vendeur</th>
          ${extraLabel ? `<th style="white-space:nowrap;min-width:140px">${extraLabel}</th>` : ""}
          <th style="white-space:nowrap">Qté livrée</th>
          <th style="white-space:nowrap">Qté facturée</th>
          <th style="white-space:nowrap">Montant HT</th>
          <th style="white-space:nowrap">Montant TTC</th>
          <th style="white-space:nowrap">Remise</th>
          <th style="white-space:nowrap">Qté vendue J-1</th>
          <th style="white-space:nowrap">Montant HT J-1</th>
          <th style="white-space:nowrap">Montant TTC J-1</th>
          ${!extraGroupBy ? `<th style="white-space:nowrap">Montant encaissé</th>` : ""}
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td style="white-space:nowrap;min-width:140px">${escHtml(r.vendeurName)}</td>
            ${extraLabel ? `<td style="white-space:nowrap;min-width:140px">${escHtml(r.extraName || "—")}</td>` : ""}
            <td>${fmt(r.qtyLivree)}</td>
            <td>${fmt(r.qtyFacturee)}</td>
            <td>${fmt(r.montantHT)}</td>
            <td>${fmt(r.montantTTC)}</td>
            <td>${fmt(r.remise)}</td>
            <td>${fmt(r.qtyVendueJ1)}</td>
            <td>${fmt(r.montantHTJ1)}</td>
            <td>${fmt(r.montantTTCJ1)}</td>
            ${!extraGroupBy ? `<td>${fmt(r.montantEncaisse)}</td>` : ""}
          </tr>
        `).join("")}
      </tbody>
      <tfoot>
        <tr style="font-weight:700">
          <td style="white-space:nowrap">Total</td>
          ${extraLabel ? `<td></td>` : ""}
          <td>${fmt(totals.qtyLivree)}</td>
          <td>${fmt(totals.qtyFacturee)}</td>
          <td>${fmt(totals.montantHT)}</td>
          <td>${fmt(totals.montantTTC)}</td>
          <td>${fmt(totals.remise)}</td>
          <td>${fmt(totals.qtyVendueJ1)}</td>
          <td>${fmt(totals.montantHTJ1)}</td>
          <td>${fmt(totals.montantTTCJ1)}</td>
          ${!extraGroupBy ? `<td>${fmt(totalEncaisse)}</td>` : ""}
        </tr>
      </tfoot>
    </table>
    </div>
  `;
}

// ── Export Constat ─────────────────────────────────────────────
async function exportConstatToExcel(mode) {
  if (typeof XLSX === "undefined") { addNotif("SheetJS non chargé", "error"); return; }
  const baseUrl = (App.settings?.baseUrlPayment || "").replace(/\/$/, "");
  if (!baseUrl) { addNotif("URL Odoo non configurée", "error"); return; }

  const cfg = App.settings?.constat?.[mode];
  if (!cfg) { addNotif("Config Constat manquante", "error"); return; }

  const workers = modeWorkers().filter(w => w.role === mode);
  if (!workers.length) { addNotif(`Aucun agent ${mode}`, "warning"); return; }

  addNotif("Récupération données Constat…", "info");

  // ── 1. Récupérer BL IDs + partners non-annulés par worker ──
  const workerPickingIds = {}; // { workerId: [pickingId...] }
  const workerPartners   = {}; // { workerId: Set(partnerId) } — non-cancel uniquement
  const allPickingIds    = [];

  await Promise.all(workers.map(async w => {
    const st = App.allStats[w.id];
    if (!st) return;

    const roundIds = [];
    if (Array.isArray(st.rounds) && st.rounds.length)
      st.rounds.forEach(r => { if (r?.roundId) roundIds.push(r.roundId); });
    else if (st.roundId)
      roundIds.push(st.roundId);
    if (!roundIds.length) return;

    const ids      = [];
    const partners = new Set();
    await Promise.all(roundIds.map(async rid => {
      try {
        const bls = await rpcController.fetchBLs(baseUrl, rid, mode);
        (bls || []).forEach(b => {
          if (typeof b.id !== "number" || b.id <= 0) return;
          if (!ids.includes(b.id)) ids.push(b.id);
          if (b.state !== "cancel") {
            const pId = Array.isArray(b.partner_id) ? b.partner_id[0] : b.partner_id;
            if (pId) partners.add(pId);
          }
        });
      } catch(e) { console.warn(`[Constat] fetchBLs rid=${rid} w=${w.id}`, e); }
    }));

    workerPickingIds[w.id] = ids;
    workerPartners[w.id]   = partners;
    ids.forEach(id => { if (!allPickingIds.includes(id)) allPickingIds.push(id); });
  }));

  // ── 2. Fetch SKUs + custom products via fetchConstatData ──
  let constatData = { byPicking: {} };
  if (allPickingIds.length) {
    try {
      constatData = await rpcController.fetchConstatData(
        baseUrl, allPickingIds, cfg.customProducts || []
      );
    } catch(e) {
      addNotif("Erreur fetchConstatData: " + e.message, "error");
      console.error("[Constat]", e);
    }
  }

  // ── 3. Agréger par worker ──
  const workerConstat = {};
  workers.forEach(w => {
    const pickIds    = workerPickingIds[w.id] || [];
    const customQtys = {};
    let   totalSkus  = 0;
    let   sCount     = 0;

    pickIds.forEach(pid => {
      const d = constatData.byPicking[pid];
      if (!d) return;
      totalSkus += (d.skuCount || 0);
      sCount++;
      Object.entries(d.customQtys || {}).forEach(([label, qty]) => {
        customQtys[label] = (customQtys[label] || 0) + qty;
      });
    });

    const blCount = workerPartners[w.id]?.size ?? 0;
    // union حقيقية لكل SKUs اليوم بدون تكرار
    const globalSkuSet = new Set();
    pickIds.forEach(pid => {
      const d = constatData.byPicking[pid];
      if (d?.skuSet) d.skuSet.forEach(id => globalSkuSet.add(id));
    });

    workerConstat[w.id] = {
      skuCount:     globalSkuSet.size,
      globalSkuSet: globalSkuSet,
      avgSku:       sCount > 0 ? +(totalSkus / sCount).toFixed(2) : 0,
      customQtys,
      sCount,
      blCount,
    };
  });

  // ── 4. Colonnes actives ──
  const enabledCols      = (cfg.cols || []).filter(c => c.enabled);
  const customProdLabels = (cfg.customProducts || []).map(cp => cp.label).filter(Boolean);
  const headers          = [
    ...enabledCols.map(c => CONSTAT_ALL_COLS.find(x => x.key === c.key)?.label || c.key),
    ...customProdLabels,
  ];

  // ── 5. Rows ──
  const dataRows = workers.map(w => {
    const st = App.allStats[w.id] || {};
    const wc = workerConstat[w.id] || { skuCount: 0, customQtys: {}, sCount: 0, blCount: 0 };

    const sCount = wc.sCount > 0
      ? wc.sCount
      : (st.successRate != null && st.totalClients != null
          ? Math.round(st.successRate / 100 * st.totalClients) : 0);

    const dropSize = (sCount > 0 && st.ca != null && st.ca > 0)
      ? +(st.ca / sCount).toFixed(2) : 0;

    const stdVals = enabledCols.map(c => {
      switch (c.key) {
        case "agent":      return w.label || w.name;
        case "ca":         return st.ca         != null ? +st.ca.toFixed(2)          : 0;
        case "p":          return st.totalClients                                    ?? 0;
        case "vPct":       return st.visitRate   != null ? +st.visitRate.toFixed(1)   : 0;
        case "sPct":       return st.successRate != null ? +st.successRate.toFixed(1) : 0;
        case "blCount":    return wc.blCount                                         ?? 0;
        case "firstVisit": return st.firstVisit  || "";
        case "lastVisit":  return st.lastVisit   || "";
        case "workTime": {
          if (!st.firstVisit || !st.lastVisit) return "";
          const toMin = t => { const [h,m] = t.split(":").map(Number); return h*60+m; };
          const diff = toMin(st.lastVisit) - toMin(st.firstVisit);
          if (diff <= 0) return "";
          return `${String(Math.floor(diff/60)).padStart(2,"0")}:${String(diff%60).padStart(2,"0")}`;
        }
        case "skuCount":   return wc.skuCount ?? 0;
        case "avgSku":     return wc.avgSku   ?? 0;
        case "dropSize":   return dropSize;
        default:           return 0;
      }
    });

    const customVals = customProdLabels.map(label =>
      +((wc.customQtys[label] || 0).toFixed(3))
    );

    return [...stdVals, ...customVals];
  });

// ── 6. Export XLSX avec ExcelJS ──
  const dateKey  = getDateKey(App.currentDateOffset);
  const today    = new Date();
  const dateStr  = `${String(today.getDate()).padStart(2,"0")}/${String(today.getMonth()+1).padStart(2,"0")}/${today.getFullYear()}`;
  const title    = `Oran – Sales & SKU Tracking Report – ${dateStr}`;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Constat");

  const colCount = headers.length;

  // ── Ligne titre ──
  ws.mergeCells(1, 1, 1, colCount);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = title;
  titleCell.font  = { bold: true, size: 16, color: { argb: "FF16365C" } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  titleCell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } };
  ws.getRow(1).height = 32;

  // ── Ligne header ──
  const headerRow = ws.addRow(headers);
  headerRow.height = 20;
  headerRow.eachCell(cell => {
    cell.value     = cell.value;
    cell.font      = { bold: true, size: 11, color: { argb: "FFFFFFFF" } };
    cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16365C" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border    = {
      top:    { style: "thin", color: { argb: "FF000000" } },
      bottom: { style: "thin", color: { argb: "FF000000" } },
      left:   { style: "thin", color: { argb: "FF000000" } },
      right:  { style: "thin", color: { argb: "FF000000" } },
    };
  });

  // ── index des colonnes pour formats spéciaux ──
  const caIdx    = enabledCols.findIndex(c => c.key === "ca");
  const dropIdx  = enabledCols.findIndex(c => c.key === "dropSize");
  const vPctIdx  = enabledCols.findIndex(c => c.key === "vPct");
  const sPctIdx  = enabledCols.findIndex(c => c.key === "sPct");

  // ── Lignes données ──
  dataRows.forEach((row, ri) => {
    const dataRow = ws.addRow(row);
    const isEven  = ri % 2 === 0;
    const bgColor = isEven ? "FFFFFFFF" : "FFDCE6F1";

    dataRow.height = 16;
    dataRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
      const idx = colNum - 1; // 0-based

      // Format numérique spécial
      if (idx === caIdx || idx === dropIdx) {
        cell.numFmt = "#,##0.00";
} else if (idx === vPctIdx || idx === sPctIdx) {
        cell.numFmt = "0%";
        if (typeof cell.value === "number") cell.value = cell.value / 100;
      }

      // ── Alert thresholds ──
      const thr = App.settings?.constatThresholds || {};
      const workerSt = App.allStats[workers[ri]?.id] || {};
      const toMin = t => { if (!t) return null; const [h,m] = t.split(":").map(Number); return h*60+m; };
      let alertCell = false;
      const col = enabledCols[idx];
      if (col?.key === "firstVisit" && thr.maxFirstVisit && workerSt.firstVisit) {
        alertCell = toMin(workerSt.firstVisit) > toMin(thr.maxFirstVisit);
      } else if (col?.key === "lastVisit" && thr.minLastVisit && workerSt.lastVisit) {
        alertCell = toMin(workerSt.lastVisit) < toMin(thr.minLastVisit);
      } else if (col?.key === "workTime" && thr.minWorkTime && typeof cell.value === "string" && cell.value) {
        alertCell = toMin(cell.value) < toMin(thr.minWorkTime);
      }
      cell.fill = alertCell
        ? { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } }
        : { type: "pattern", pattern: "solid", fgColor: { argb: bgColor } };
      if (alertCell) cell.font = { ...(cell.font || {}), color: { argb: "FF9C0006" }, bold: true };
      cell.alignment = { horizontal: idx === 0 ? "left" : "center", vertical: "middle" };
      cell.border = {
        top:    { style: "thin", color: { argb: "FF000000" } },
        bottom: { style: "thin", color: { argb: "FF000000" } },
        left:   { style: "thin", color: { argb: "FF000000" } },
        right:  { style: "thin", color: { argb: "FF000000" } },
      };
    });
  });

  // ── Ligne totaux/moyennes ──
  const numRows  = dataRows.length;

  // définir le type d'agrégation par colonne
    const allWorkersSkuUnion = new Set();
  workers.forEach(w => {
    workerConstat[w.id]?.globalSkuSet?.forEach(id => allWorkersSkuUnion.add(id));
  });

  const aggType = (key) => {
    switch(key) {
      case "agent":      return "label";
      case "ca":         return "sum";
      case "p":          return "sum";
      case "vPct":       return "avg";
      case "sPct":       return "avg";
      case "blCount":    return "avg";
      case "firstVisit": return "none";
      case "lastVisit":  return "none";
      case "workTime":   return "none";
      case "skuCount":   return "sku_union";
      case "avgSku":     return "avg";
      case "dropSize":   return "sum";
      default:           return "sum"; // custom products
    }
  };

  const totalRow = enabledCols.map(c => {
    const type = aggType(c.key);
    if (type === "label")     return "TOTAL";
    if (type === "none")      return "/";
    if (type === "sku_union") return allWorkersSkuUnion.size;
    const vals = dataRows.map(r => {
      const v = r[enabledCols.indexOf(c)];
      return typeof v === "number" ? v : 0;
    });
    const sum = vals.reduce((a, b) => a + b, 0);
    if (type === "sum") return +sum.toFixed(2);
    if (type === "avg") return numRows > 0 ? +(sum / numRows).toFixed(2) : 0;
    return "";
  });

  // custom products → sum
  const customTotals = customProdLabels.map((_, li) => {
    const colIdx = enabledCols.length + li;
    const sum = dataRows.reduce((a, r) => a + (typeof r[colIdx] === "number" ? r[colIdx] : 0), 0);
    return +sum.toFixed(3);
  });

  const totalRowFull = [...totalRow, ...customTotals];
  const totRow = ws.addRow(totalRowFull);
  totRow.height = 20;

  totRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    const idx    = colNum - 1;
    const colKey = enabledCols[idx]?.key || "custom";

    // formats numériques
    if (colKey === "ca" || colKey === "dropSize") {
      cell.numFmt = "#,##0.00";
    } else if (colKey === "vPct" || colKey === "sPct") {
      cell.numFmt = "0.0%";
      if (typeof cell.value === "number") cell.value = cell.value / 100;
    }

    // même style que header
    cell.font      = { bold: true, size: 11, color: { argb: "FFFFFFFF" } };
    cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16365C" } };
    cell.alignment = { horizontal: idx === 0 ? "left" : "center", vertical: "middle" };
    cell.border    = {
      top:    { style: "thin", color: { argb: "FF000000" } },
      bottom: { style: "thin", color: { argb: "FF000000" } },
      left:   { style: "thin", color: { argb: "FF000000" } },
      right:  { style: "thin", color: { argb: "FF000000" } },
    };
  });

  // ── Largeur des colonnes ──
  ws.columns = headers.map((h, i) => ({
    width: i === 0 ? 24 : Math.max((h||"").length + 4, 12)
  }));

  // ── Figer la ligne header ──
  ws.views = [{ state: "frozen", ySplit: 2 }];

  // ── Télécharger ──
  const buffer = await wb.xlsx.writeBuffer();
  const blob   = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement("a");
  a.href       = url;
  a.download   = `constat_${mode}_${dateKey}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
  addNotif(`✓ Constat ${mode} exporté (${workers.length} agents)`, "success");
}

// ── Export / Import settings ──────────────────────────────────
function _loadFavKey(mode) {
  try { return JSON.parse(localStorage.getItem("wafa_qb_favs_" + mode) || "[]"); }
  catch(_) { return []; }
}

function exportSettings() {
  const keys = ["vendors","workflows","baseUrlPayment","payShortcuts","cardLayouts","cardHeights","cardWidth","cardHeight","cardScale","iconCols","cols","fontSize","cardColor","showUpdatedAt","svCols","svCardHeight","svCardScale",
    "hideBtn_open","hideBtn_route","hideBtn_bl","hideBtn_analyse","hideBtn_copy","hideBtn_trash","hideBtn_link","hideBtn_pay"];
  const data = {};
  keys.forEach(k => { if (App.settings[k] !== undefined) data[k]=App.settings[k]; });
  data._importedProducts = _importedProducts;
  // ── فلاتر محفوظة لكل mode ──
App.pmLoadShortcuts();
  data._pmShortcuts = App.pmShortcuts;
  data._filterFavourites = {
    prevente:  _loadFavKey("prevente"),
    livraison: _loadFavKey("livraison"),
  };
  const blob = new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
  const url  = URL.createObjectURL(blob), a=document.createElement("a");
  a.href=url; a.download=`wafa-settings-${getTodayKey()}.json`; a.click(); URL.revokeObjectURL(url);
  addNotif("Paramètres exportés ✓","success");
}

async function importSettings(file) {
  if (!file) return;
  try {
    const text = await file.text(), data = JSON.parse(text);
    const allowed = ["vendors","workflows","baseUrlPayment","payShortcuts","cardLayouts","cardHeights","cardWidth","cardHeight","cardScale","iconCols","cols","fontSize","cardColor","showUpdatedAt","svCols","svCardHeight","svCardScale",
      "hideBtn_open","hideBtn_route","hideBtn_bl","hideBtn_analyse","hideBtn_copy","hideBtn_trash","hideBtn_link","hideBtn_pay"];
    allowed.forEach(k => { if (data[k] !== undefined) App.settings[k]=data[k]; });
    if (Array.isArray(data._importedProducts) && data._importedProducts.length) {
      _importedProducts = data._importedProducts;
      Storage.set("wafaImportedProducts", _importedProducts);
      const countEl = document.getElementById("settingProductsCount");
      if (countEl) countEl.textContent = `${_importedProducts.length} produits chargés`;
    }
// بعد — أضف هذا البلوك قبله مباشرةً:
    if (Array.isArray(data._pmShortcuts) && data._pmShortcuts.length) {
      App.pmShortcuts = data._pmShortcuts;
      pmSaveShortcuts();
      const scStatus = document.getElementById("settingScImportStatus");
      if (scStatus) scStatus.textContent = `✓ ${App.pmShortcuts.length} raccourcis importés`;
      pmUpdateCount();
    }
    if (data._filterFavourites) {
      ["prevente","livraison"].forEach(mode => {
        const favs = data._filterFavourites[mode];
        if (Array.isArray(favs)) {
          try { localStorage.setItem("wafa_qb_favs_" + mode, JSON.stringify(favs)); }
          catch(_) {}
        }
      });
      loadFilterFavourites();
      renderFavChips();
    }
    await Storage.saveSettings(App.settings);
    renderSettings(); renderVendors(); addNotif("Paramètres importés ✓","success");
  } catch(e){ addNotif("Import échoué: "+e.message,"error"); }
  document.getElementById("inputImportSettings").value="";
}

// ── bindEvents ────────────────────────────────────────────────
function bindEvents() {
  document.getElementById("btnModePrevente") ?.addEventListener("click", () => setMode("prevente"));
  document.getElementById("btnModeLivraison")?.addEventListener("click", () => setMode("livraison"));
  document.getElementById("btnModeMr")       ?.addEventListener("click", () => setMode("mr"));
  document.getElementById("btnModeGds")      ?.addEventListener("click", () => setMode("gds"));
  document.getElementById("btnModeClients")  ?.addEventListener("click", () => setMode("clients"));
  document.getElementById("btnModeSales")    ?.addEventListener("click", () => setMode("sales"));
  document.getElementById("btnModeRoute")    ?.addEventListener("click", () => setMode("route"));
  document.getElementById("btnModeDeliveryMap")?.addEventListener("click", () => setMode("delivmap"));
document.getElementById("btnSettings")    ?.addEventListener("click", () => showView("settings"));

  // ── Constat Modal ──────────────────────────────────────────
  document.getElementById("btnConstatSettings")?.addEventListener("click", openConstatModal);
  document.getElementById("btnCustomCategSettings")?.addEventListener("click", openCustomCategModal);
  document.getElementById("btnCustomCategClose")?.addEventListener("click", () => {
    document.getElementById("customCategModal").style.display = "none";
  });
  document.getElementById("customCategModal")?.addEventListener("click", e => {
    if (e.target.id === "customCategModal") document.getElementById("customCategModal").style.display = "none";
  });
  document.getElementById("btnCustomCategSave")?.addEventListener("click", customCategSave);
  document.getElementById("btnCustomCategCancelEdit")?.addEventListener("click", _customCategResetForm);

  document.getElementById("btnCustomSellerCategSettings")?.addEventListener("click", openCustomSellerCategModal);
  document.getElementById("btnCustomSellerCategClose")?.addEventListener("click", () => {
    document.getElementById("customSellerCategModal").style.display = "none";
  });
  document.getElementById("customSellerCategModal")?.addEventListener("click", e => {
    if (e.target.id === "customSellerCategModal") document.getElementById("customSellerCategModal").style.display = "none";
  });
  document.getElementById("btnCustomSellerCategSave")?.addEventListener("click", customSellerCategSave);
  document.getElementById("btnCustomSellerCategCancelEdit")?.addEventListener("click", _customSellerCategResetForm);

  document.getElementById("btnCustomPricelistCategSettings")?.addEventListener("click", openCustomPricelistCategModal);
  document.getElementById("btnCustomPricelistCategClose")?.addEventListener("click", () => {
    document.getElementById("customPricelistCategModal").style.display = "none";
  });
  document.getElementById("customPricelistCategModal")?.addEventListener("click", e => {
    if (e.target.id === "customPricelistCategModal") document.getElementById("customPricelistCategModal").style.display = "none";
  });
  document.getElementById("btnCustomPricelistCategSave")?.addEventListener("click", customPricelistCategSave);
  document.getElementById("btnCustomPricelistCategCancelEdit")?.addEventListener("click", _customPricelistCategResetForm);
  _wireCustomCategProdSearch();
 document.getElementById("btnConstatClose")?.addEventListener("click", () => {
    saveConstatSettings();   // حفظ تلقائي عند الإغلاق
    document.getElementById("constatModal").style.display = "none";
  });

  document.getElementById("constatModal")?.addEventListener("click", e => {
    if (e.target === e.currentTarget) {
      saveConstatSettings(); // حفظ تلقائي عند click overlay
      e.currentTarget.style.display = "none";
    }
  });
  document.getElementById("btnConstatSave")?.addEventListener("click", () => {
    saveConstatSettings();
    document.getElementById("constatModal").style.display = "none";
  });
  document.getElementById("btnConstatExportPrev")?.addEventListener("click", () => exportConstatToExcel("prevente"));
  document.getElementById("btnConstatExportLiv") ?.addEventListener("click", () => exportConstatToExcel("livraison"));

  // Tabs
  document.querySelectorAll(".constat-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".constat-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".constat-tab-content").forEach(el => el.style.display = "none");
      document.getElementById(`constatTab-${tab}`).style.display = "block";
    });
  });

  // Add custom product buttons
  document.getElementById("btnAddCustomProd-prevente") ?.addEventListener("click", () => constatAddCustomProd("prevente"));
  document.getElementById("btnAddCustomProd-livraison")?.addEventListener("click", () => constatAddCustomProd("livraison"));

  // Fermer modal en cliquant l'overlay
  document.getElementById("constatModal")?.addEventListener("click", e => {
    if (e.target === e.currentTarget)
      e.currentTarget.style.display = "none";
  });  document.getElementById("btnBack")        ?.addEventListener("click", () => { renderMain(); showView("main"); });
  document.getElementById("btnFetch")       ?.addEventListener("click", fetchAllModes);
  document.getElementById("btnEMB")         ?.addEventListener("click", fetchEMBOnly);
  document.addEventListener("click", e => {
    const el = e.target.closest("[data-action='showCF']");
    if (!el) return;
    const vid = el.dataset.vendor;
    if (vid) showCFModal(vid);
  });
  document.getElementById("btnEMB")         ?.addEventListener("click", fetchEMBOnly);
  document.getElementById("btnCloseAll")    ?.addEventListener("click", closeAllOrange);
  document.getElementById("btnClearMode")   ?.addEventListener("click", clearCurrentMode);
  document.getElementById("btnAbort")       ?.addEventListener("click", () => { rpcController.abort(); addNotif("Annulation…","warning"); });
  document.getElementById("btnExportExcel") ?.addEventListener("click", exportCurrentModeToExcel);
  document.getElementById("btnDailyDistribReport") ?.addEventListener("click", openDailyDistribReport);
  document.getElementById("dailyDistribExtraGroupBy") ?.addEventListener("change", async (e) => {
    _dailyDistribExtraGroupBy = e.target.value || null;
    await _saveDailyDistribExtraGroupBySetting(_dailyDistribExtraGroupBy);
    await _fetchAndRenderDailyDistribReport();
  });
  document.getElementById("btnDailyDistribClose")  ?.addEventListener("click", () => {
    document.getElementById("dailyDistribModal").style.display = "none";
  });
  document.getElementById("btnRouteCustomersClose") ?.addEventListener("click", () => {
    document.getElementById("routeCustomersModal").style.display = "none";
  });
  document.getElementById("btnClearNotifs") ?.addEventListener("click", () => { const l=document.getElementById("notifList"); if(l) l.innerHTML=""; });
  document.getElementById("btnExportSettings")?.addEventListener("click", exportSettings);
  document.getElementById("inputImportSettings")?.addEventListener("change", e => importSettings(e.target.files[0]));
  document.getElementById("btnSaveSettings") ?.addEventListener("click", saveSettings);
  document.getElementById("btnPushSettingsCloud")?.addEventListener("click", pushSettingsToCloud);
  document.getElementById("btnPullSettingsCloud")?.addEventListener("click", pullSettingsFromCloud);
  document.getElementById("btnAddWorkflow")  ?.addEventListener("click", () => {
    _ensureWorkflows();
    App.settings.workflows.push({ id:"wf"+Date.now(), name:"", role:"prevente", enabled:true });
    renderWorkflowsManager();
    renderVendorsManager();
  });
  document.getElementById("btnImportFromOdoo")?.addEventListener("click", importAgentsFromOdoo);

  // Toggle Workflows
  document.getElementById("btnToggleWorkflows")?.addEventListener("click", () => {
    const el = document.getElementById("workflowsManager");
    const btn = document.getElementById("btnToggleWorkflows");
    const hidden = el.style.display === "none";
    el.style.display = hidden ? "" : "none";
    btn.textContent = hidden ? "▲ Masquer" : "▼ Afficher";
    if (hidden) renderWorkflowsManager(); // ← يملأ الـ container عند أول ظهور
  });

  // Toggle Agents
  document.getElementById("btnToggleAgents")?.addEventListener("click", () => {
    const el = document.getElementById("vendorsManager");
    const btn = document.getElementById("btnToggleAgents");
    const hidden = el.style.display === "none";
    el.style.display = hidden ? "" : "none";
    btn.textContent = hidden ? "▲ Masquer" : "▼ Afficher";
  });
  document.getElementById("btnResetAllLabels")?.addEventListener("click", () => {
    if (!hasPermission("agents.editLabels")) { addNotif("Permission refusée", "error"); return; }
    if (!App.settings.vendors?.length) return;
    App.settings.vendors.forEach(v => { v.label = shortLabel(v.displayName || v.name || ""); });
    renderVendorsManager();
    syncVendorsNow("agents.editLabels");
    addNotif("Labels réinitialisés", "info");
  });

  document.getElementById("btnClearVendors") ?.addEventListener("click", () => {
    if (!hasPermission("agents.clearAll")) { addNotif("Permission refusée", "error"); return; }
    if (!App.settings.vendors?.length){ addNotif("Rien à effacer","info"); return; }
    if (!confirm(`Supprimer tous les ${App.settings.vendors.length} agents?`)) return;
    App.settings.vendors=[]; renderVendorsManager(); addNotif("Agents effacés","warning");
    syncVendorsNow("agents.clearAll");
  });

  // Split View button
  document.getElementById("btnSplitView")?.addEventListener("click", openSplitView);
  document.getElementById("btnCloseSplitView")?.addEventListener("click", closeSplitView);

  // Steppers
  bindStepper("btnCardWidthMinus", "btnCardWidthPlus", "cardWidthValue", "cardWidth",  0, 9999, 10);
  bindStepper("btnCardHeightMinus","btnCardHeightPlus","cardHeightValue","cardHeight",  50, 9999, 10);
  bindStepper("btnCardScaleMinus", "btnCardScalePlus", "cardScaleValue", "cardScale",   50,  300,  5);
  bindStepper("btnIconColsMinus",  "btnIconColsPlus",  "iconColsValue",  "iconCols",     0,   10,  1);
  bindStepper("btnColsMinus",      "btnColsPlus",      "colsValue",      "cols",          0,    8,  1);
  bindStepper("btnSvColsMinus",       "btnSvColsPlus",       "svColsValue",       "svCols",        0,  8,  1);
  bindStepper("btnSvCardHeightMinus", "btnSvCardHeightPlus", "svCardHeightValue", "svCardHeight",  50, 9999, 10);
  bindStepper("btnSvCardScaleMinus",  "btnSvCardScalePlus",  "svCardScaleValue",  "svCardScale",   30, 200,  5);
  bindStepper("btnAfIntervalMinus",   "btnAfIntervalPlus",   "afIntervalValue",   "autoFetchInterval", 1, 120, 1);

  // Auto-fetch pause button
  document.getElementById("afPauseBtn")?.addEventListener("click", () => AutoFetch.togglePause());

  // Card color
  window.addEventListener("resize", () => updateDashboardVisibility());
  _dbBindControls();
  document.getElementById("btnShowDashboard")?.addEventListener("click", () => {
    _dbSaveState({ hidden: false });
    updateDashboardVisibility();
  });
  document.getElementById("cardColorPicker")?.addEventListener("input", e => {
    App.settings.cardColor = e.target.value;
    const hex = document.getElementById("cardColorHex");
    if (hex) hex.textContent = e.target.value;
    renderVendors();
  });
}

// ── Split View ─────────────────────────────────────────────────
function _svApplySearch() {
  const q = (document.getElementById("svSearchInput")?.value || "").trim().toLowerCase();
  document.querySelectorAll("#splitViewOverlay .seller-card").forEach(card => {
    card.style.display = (!q || (card.title||"").toLowerCase().includes(q)) ? "" : "none";
  });
}

function openSplitView() {
  const overlay = document.getElementById("splitViewOverlay");
  if (!overlay) return;
  overlay.style.display = "flex";
  const fmt = k => k.slice(5).replace("-","/");
  const $ = id => document.getElementById(id);
  if ($("svDatePrev"))     $("svDatePrev").textContent     = fmt(getDateKey(0));
  if ($("svDateLiv"))      $("svDateLiv").textContent      = fmt(getDateKey(0));
  if ($("svDateTomorrow")) $("svDateTomorrow").textContent = fmt(getDateKey(1));

  renderSplitView();

  // بحث
  $("svSearchInput").oninput = _svApplySearch;

  // Fetch — يحافظ على البحث بعد إعادة الرسم
  $("svBtnFetch").onclick = async () => {
    const baseUrl = getOdooBase();
    if (!baseUrl) { addNotif("URL non configurée","error"); return; }
    const btn = $("svBtnFetch");
    btn.disabled = true; btn.textContent = "…";
    const prevW = allWorkers().filter(w => w.role === "prevente");
    const livW  = allWorkers().filter(w => w.role === "livraison");
    await Promise.allSettled([
      prevW.length ? rpcController.fetch(prevW, baseUrl, "prevente",  0) : Promise.resolve(),
      livW.length  ? rpcController.fetch(livW,  baseUrl, "livraison", 0) : Promise.resolve(),
      livW.length  ? rpcController.fetch(livW,  baseUrl, "livraison", 1) : Promise.resolve(),
    ]);
    btn.disabled = false;
    btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/></svg> Fetch Tout`;
    await renderSplitView();
    _svApplySearch();
  };

  // مفضلات البحث
  const _svFavsKey = "sv_search_favs";
  let _svFavs = JSON.parse(localStorage.getItem(_svFavsKey) || "[]");

  function _svRenderFavs() {
    const bar = $("svFavBar"); if (!bar) return;
    bar.innerHTML = _svFavs.length ? _svFavs.map(f =>
      `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;background:var(--bg3);border:1px solid var(--border);border-radius:10px;font-size:10px;cursor:pointer;color:var(--text2);" data-q="${f}">
        ${f}
        <span data-del="${f}" style="color:var(--text3);font-size:12px;line-height:1;margin-left:1px;">×</span>
      </span>`
    ).join("") : "";
    bar.querySelectorAll("span[data-q]").forEach(chip => {
      chip.addEventListener("click", e => {
        const del = e.target.closest("[data-del]");
        if (del) {
          _svFavs = _svFavs.filter(f => f !== del.dataset.del);
          localStorage.setItem(_svFavsKey, JSON.stringify(_svFavs));
          _svRenderFavs(); return;
        }
        $("svSearchInput").value = chip.dataset.q;
        _svApplySearch();
      });
    });
  }

  $("svBtnSaveFav").onclick = () => {
    const q = ($("svSearchInput")?.value || "").trim();
    if (!q || _svFavs.includes(q)) return;
    _svFavs.push(q);
    localStorage.setItem(_svFavsKey, JSON.stringify(_svFavs));
    _svRenderFavs();
  };

  _svRenderFavs();
}

function closeSplitView() {
  const overlay = document.getElementById("splitViewOverlay");
  if (overlay) overlay.style.display = "none";
}

async function _svLoadContext(mode, dateOffset) {
  const dateKey = getDateKey(dateOffset);
  const ck = mode + "_" + dateKey;
  if (_contextCache[ck] && Object.keys(_contextCache[ck].links || {}).length) {
    return {
      links:       _contextCache[ck].links       || {},
      stats:       _contextCache[ck].stats        || {},
      roundStatus: _contextCache[ck].roundStatus  || {},
      refs:        _contextCache[ck].refs          || {},
      odooState:   _contextCache[ck].odooState    || {},
      userStatus:  _contextCache[ck].userStatus   || {},
    };
  }
  const raw = await Storage.getMany(["vendorLinks","vendorStats","vendorRefs","roundStatus"]);
  const _linksDay  = (raw.vendorLinks || {})[dateKey] || {};
  const _statsDay  = (raw.vendorStats || {})[dateKey] || {};
  const _statusDay = (raw.roundStatus || {})[dateKey] || {};
  const _refsDay   = (raw.vendorRefs  || {})[dateKey] || {};
  const _isOld = obj => obj && !obj.prevente && !obj.livraison && Object.keys(obj).length > 0;
  return {
    links:       _linksDay[mode]  ?? (_isOld(_linksDay)  ? _linksDay  : {}),
    stats:       _statsDay[mode]  || {},
    roundStatus: _statusDay[mode] ?? (_isOld(_statusDay) ? _statusDay : {}),
    refs:        _refsDay[mode]   ?? (_isOld(_refsDay)   ? _refsDay   : {}),
    odooState:   _contextCache[ck]?.odooState  || {},
    userStatus:  _contextCache[ck]?.userStatus || {},
  };
}

async function renderSplitView() {
  const prevWorkers = allWorkers().filter(w => w.role === "prevente");
  const livWorkers  = allWorkers().filter(w => w.role === "livraison");
  const [ctxPrev, ctxLiv, ctxTomorrow] = await Promise.all([
    _svLoadContext("prevente",  0),
    _svLoadContext("livraison", 0),
    _svLoadContext("livraison", 1),
  ]);
  _svRenderColNative("svGridPrev",     prevWorkers, ctxPrev,     "prevente",  0);
  _svRenderColNative("svGridLiv",      livWorkers,  ctxLiv,      "livraison", 0);
  _svRenderColNative("svGridTomorrow", livWorkers,  ctxTomorrow, "livraison", 1);
}

function _svRenderColNative(gridId, workers, ctx, mode, dateOffset) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  const list = grid.querySelector(".sv-vendors-list");
  if (!list) return;

  list.dataset.svMode   = mode;
  list.dataset.svOffset = dateOffset;

  const savedMode        = App.currentMode;
  const savedOffset      = App.currentDateOffset;
  const savedLinks       = App.allLinks;
  const savedStats       = App.allStats;
  const savedRoundStatus = App.allRoundStatus;
  const savedRefs        = App.allRefs;
  const savedOdooState   = App.allOdooState;
  const savedUserStatus  = App.allUserStatus;

  App.currentMode        = mode;
  App.currentDateOffset  = dateOffset;
  App.allLinks           = ctx.links;
  App.allStats           = ctx.stats;
  App.allRoundStatus     = ctx.roundStatus;
  App.allRefs            = ctx.refs;
  App.allOdooState       = ctx.odooState  || {};
  App.allUserStatus      = ctx.userStatus || {};

  const savedCols   = App.settings.cols;
  const savedW      = App.settings.cardWidth;
  const savedH      = App.settings.cardHeight;
  const savedScale  = App.settings.cardScale;
  App.settings.cols       = App.settings.svCols      ?? 2;
  App.settings.cardWidth  = 0;
  App.settings.cardHeight = App.settings.svCardHeight ?? 160;
  App.settings.cardScale  = App.settings.svCardScale  ?? 80;

  const realList = document.getElementById("vendorsList");
  if (realList) realList.id = "_vendorsList_bak";
  list.id = "vendorsList";

  renderVendors();

  list.id = "";
  if (realList) realList.id = "vendorsList";

  App.settings.cols       = savedCols;
  App.settings.cardWidth  = savedW;
  App.settings.cardHeight = savedH;
  App.settings.cardScale  = savedScale;
  App.currentMode        = savedMode;
  App.currentDateOffset  = savedOffset;
  App.allLinks           = savedLinks;
  App.allStats           = savedStats;
  App.allRoundStatus     = savedRoundStatus;
  App.allRefs            = savedRefs;
  App.allOdooState       = savedOdooState;
  App.allUserStatus      = savedUserStatus;
}

// ── Search ────────────────────────────────────────────────────
function applySearch() {
  const q=normalizeStr(App.searchQuery.trim());
  const cards=document.querySelectorAll("#vendorsList .vc"), workers=modeWorkers();
  let visible=0;
  cards.forEach((card) => {
    const vid=card.dataset.vendorId;
    const worker=workers.find(w => String(w.id)===String(vid)); if (!worker) return;
    const haystack=normalizeStr([worker.name||"",worker.label||""].join(" "));
    const textMatch=!q||haystack.includes(q), filterMatch=!qbIsActive()||qbMatchesWorker(worker);
    const match=textMatch&&filterMatch;
    card.classList.toggle("vc--hidden",!match); card.classList.toggle("vc--match",!!(q&&match));
    if(match) visible++;
  });
  const countEl=document.getElementById("searchCount"), clearEl=document.getElementById("searchClear");
const hasFilters=qbIsActive()||qbActiveFavIndex>=0;
if(countEl){ const hasAny=q||qbIsActive(); countEl.textContent=hasAny?`${visible}/${workers.length}`:""; }
if(clearEl){
  const show = App.searchQuery || hasFilters;
  clearEl.style.display = show ? "flex" : "none";
  clearEl.style.color = hasFilters && !App.searchQuery ? "#f87171" : "";
}
}

function normalizeStr(s) { return s.toLowerCase().replace(/[-_\/\\. ]/g,""); }

function bindSearch() {
  bindQb();
  const input=document.getElementById("searchInput"), clear=document.getElementById("searchClear");
  input?.addEventListener("input",  () => { App.searchQuery=input.value; applySearch(); });
  input?.addEventListener("keydown", e => { if(e.key==="Escape"){ resetAllFilters(); input.blur(); } });
  clear?.addEventListener("click", () => { resetAllFilters(); input.focus(); });

  function resetAllFilters() {
    App.searchQuery = "";
    const inp = document.getElementById("searchInput");
    if (inp) inp.value = "";
    const inpM = document.getElementById("searchInputMobile");
    if (inpM) inpM.value = "";
    const clrM = document.getElementById("searchClearMobile");
    if (clrM) clrM.style.display = "none";
    qbReset();
    qbActiveFavIndex = -1;
    document.querySelectorAll("#favBarChips .qb-fav-chip").forEach(c => c.classList.remove("qb-fav-chip--active"));
    const panel = document.getElementById("filterPanel");
    if (panel) panel.style.display = "none";
    applySearch();
  }

  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (document.querySelector("#blListOverlay, #payListOverlay")) return;
    const hasAny = App.searchQuery || qbIsActive() || qbActiveFavIndex >= 0;
    if (hasAny) resetAllFilters();
  });
  document.getElementById("btnFilterToggle")?.addEventListener("click", () => {
    const panel=document.getElementById("filterPanel"); if(!panel) return;
    const open=panel.style.display==="none"; panel.style.display=open?"block":"none";
    if(open){ renderFavChips(); }
  });
  document.getElementById("btnSaveFav")?.addEventListener("click", () => qbSaveFavourite());
  // Mobile search toggle
  const btnSearchToggle = document.getElementById("btnSearchToggle");
  const searchBarMobile = document.getElementById("searchBarMobile");
  const inputMobile     = document.getElementById("searchInputMobile");
  const clearMobile     = document.getElementById("searchClearMobile");

  btnSearchToggle?.addEventListener("click", () => {
    const open = searchBarMobile.style.display === "none";
    searchBarMobile.style.display = open ? "block" : "none";
    if (open) inputMobile?.focus();
  });

  inputMobile?.addEventListener("input", () => {
    App.searchQuery = inputMobile.value;
    const inp = document.getElementById("searchInput");
    if (inp) inp.value = inputMobile.value;
    if (clearMobile) clearMobile.style.display = inputMobile.value ? "flex" : "none";
    applySearch();
  });

  clearMobile?.addEventListener("click", () => {
    App.searchQuery = ""; inputMobile.value = "";
    const inp = document.getElementById("searchInput");
    if (inp) inp.value = "";
    clearMobile.style.display = "none";
    applySearch();
  });

  document.getElementById("btnFilterToggleMobile")?.addEventListener("click", () => {
    const panel = document.getElementById("filterPanel"); if (!panel) return;
    const open = panel.style.display === "none";
    panel.style.display = open ? "block" : "none";
    if (open) renderFavChips();
  });
  // ── PWA Install ──────────────────────────────────────────────
  let _pwaPrompt = null;
  const btnInstall = document.getElementById("btnInstallPwa");
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    _pwaPrompt = e;
    if (btnInstall) btnInstall.style.display = "flex";
  });
  window.addEventListener("appinstalled", () => {
    _pwaPrompt = null;
    if (btnInstall) btnInstall.style.display = "none";
  });
  btnInstall?.addEventListener("click", async () => {
    if (!_pwaPrompt) return;
    _pwaPrompt.prompt();
    const { outcome } = await _pwaPrompt.userChoice;
    if (outcome === "accepted") {
      _pwaPrompt = null;
      btnInstall.style.display = "none";
    }
  });

}




// ── Product catalogue ─────────────────────────────────────────
let _importedProducts = [];
Object.defineProperty(window, '_importedProducts', { get: () => _importedProducts });

function bindProductsImport() {
  const fileInput = document.getElementById("settingProductsFile");
  const clearBtn  = document.getElementById("settingProductsClear");
  if (fileInput) fileInput.addEventListener("change", apHandleExcelImport);
  if (clearBtn)  clearBtn.addEventListener("click", () => {
    _importedProducts = [];
    Storage.remove("wafaImportedProducts");
    const countEl = document.getElementById("settingProductsCount");
    if (countEl) countEl.textContent = "";
    addNotif("Catalogue produits effacé", "warning");
  });
  // Load on startup
  Storage.get("wafaImportedProducts", null).then(raw => {
    if (Array.isArray(raw)) {
      _importedProducts = raw;
      const countEl = document.getElementById("settingProductsCount");
      if (countEl) countEl.textContent = `${_importedProducts.length} produits chargés`;
    }
  });
}

function apHandleExcelImport(e) {
  const file = e.target.files?.[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      if (typeof XLSX === "undefined") { addNotif("SheetJS non chargé — rechargez la page","error"); return; }
      const wb = XLSX.read(ev.target.result,{type:"array"}), ws=wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws,{header:1,defval:""});
      const products=[];
      for (let i=1;i<rows.length;i++) {
        const row=rows[i]; const name=(row[0]||"").toString().trim(); const code=(row[1]||"").toString().trim(); const id=parseInt(row[2],10);
        if(!name||!id) continue;
        products.push({id,name,default_code:code||null});
      }
      _importedProducts=products;
      Storage.set("wafaImportedProducts",products);
      const countEl=document.getElementById("settingProductsCount"); if(countEl) countEl.textContent=`${products.length} produits chargés`;
      addNotif(`✓ ${products.length} produits importés`,"success");
    } catch(err){ addNotif("Erreur Excel: "+err.message,"error"); }
  };
  reader.readAsArrayBuffer(file); e.target.value="";
}

// ── Add Product Modal ─────────────────────────────────────────
function openAddProductModal(vendorId, vendorLabel, planningId, baseUrl) {
  document.getElementById("addProductModal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "addProductModal";
  overlay.className = "ap-overlay";
  overlay.innerHTML = `
    <div class="ap-modal">
      <div class="ap-header">
        <span class="ap-title">Ajouter produit — ${escHtml(vendorLabel)}</span>
        <button class="ap-close" id="apClose">×</button>
      </div>
      <div class="ap-search-row" style="position:relative">
        <input type="text" id="apProductInput" class="ap-input" placeholder="Rechercher produit…" autocomplete="off"/>
        <div id="apDropdown" class="ap-dropdown" style="display:none"></div>
      </div>
      <div class="ap-row2">
        <div class="ap-field-group"><label class="ap-label">CDN (boites)</label><input type="number" id="apQtyCdn" class="ap-input" min="0" value="0"></div>
        <div class="ap-field-group"><label class="ap-label">Pièces</label><input type="number" id="apQtyPiece" class="ap-input" min="0" value="0"></div>
      </div>
      <button class="ap-btn ap-btn-addline" id="apAddLine">+ Ajouter à la liste</button>
      <div id="apLinesList" class="ap-lines-list"></div>
      <div class="ap-footer">
        <button class="ap-btn ap-btn-cancel" id="apCancel">Annuler</button>
        <button class="ap-btn ap-btn-add" id="apSubmit" disabled>Confirmer tout</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let pendingLines = [], selectedProduct = null;
  const input=document.getElementById("apProductInput"), dropdown=document.getElementById("apDropdown");
  const submitBtn=document.getElementById("apSubmit"), qtyCdn=document.getElementById("apQtyCdn"), qtyPiece=document.getElementById("apQtyPiece");
  const linesList=document.getElementById("apLinesList");
  const closeModal = () => overlay.remove();
  document.getElementById("apClose").onclick  = closeModal;
  document.getElementById("apCancel").onclick = closeModal;
  overlay.addEventListener("click", e => { if (e.target===overlay) closeModal(); });

  function renderLines() {
    linesList.innerHTML="";
    pendingLines.forEach((line,i) => {
      const row=document.createElement("div"); row.className="ap-line-row";
      row.innerHTML=`<span class="ap-line-name">${escHtml(productLabel(line.product.name))}</span><input type="number" class="ap-line-cdn" value="${line.cdn}" min="0" data-i="${i}" placeholder="CDN"><input type="number" class="ap-line-piece" value="${line.piece}" min="0" data-i="${i}" placeholder="Pcs"><button class="ap-line-del" data-i="${i}">✕</button>`;
      linesList.appendChild(row);
    });
   // بعد — استبدل "change" بـ "input":
    linesList.querySelectorAll(".ap-line-cdn").forEach(el=>el.addEventListener("input",e=>{pendingLines[+e.target.dataset.i].cdn=parseInt(e.target.value)||0;}));
    linesList.querySelectorAll(".ap-line-piece").forEach(el=>el.addEventListener("input",e=>{pendingLines[+e.target.dataset.i].piece=parseInt(e.target.value)||0;}));
    linesList.querySelectorAll(".ap-line-del").forEach(el=>el.addEventListener("click",e=>{pendingLines.splice(+e.target.dataset.i,1);renderLines();submitBtn.disabled=!pendingLines.length;}));
    submitBtn.disabled=!pendingLines.length;
  }

  document.getElementById("apAddLine").addEventListener("click",()=>{
    if(!selectedProduct){addNotif("Sélectionnez un produit","warning");return;}
    const cdn=parseInt(qtyCdn.value,10)||0, piece=parseInt(qtyPiece.value,10)||0;
    if(cdn===0&&piece===0){addNotif("Quantité requise","warning");return;}
    pendingLines.push({product:selectedProduct,cdn,piece}); renderLines();
    selectedProduct=null; input.value=""; qtyCdn.value="0"; qtyPiece.value="0"; dropdown.style.display="none"; input.focus();
  });

  function selectProduct(p){selectedProduct=p;input.value=productLabel(p.name);dropdown.style.display="none";}
  async function showDropdown(products, fromOdoo=false){
    dropdown.innerHTML="";
    if(!products.length){dropdown.innerHTML=`<div class="ap-dd-empty">Aucun résultat</div>`;dropdown.style.display="block";return;}
    const ids = products.map(p => p.id || p.product_id).filter(Boolean);
    let stockMap = {};
    try { stockMap = await rpcController.getProductStock(baseUrl, ids); } catch(_) {}
    products.forEach(p=>{
      const pid   = p.id || p.product_id;
      const stock = stockMap[pid] ?? null;
      const item=document.createElement("div");
      item.className="ap-dd-item";
      const _st = stockMap[pid];
      item.style.cssText=`display:flex;justify-content:space-between;align-items:center;gap:8px;${_st?.free === 0 ? "background:#fef2f2;" : ""}`;
      const badge = fromOdoo
        ? `<span style="font-size:9px;color:var(--orange);background:#FFF7ED;border:1px solid #FED7AA;border-radius:3px;padding:1px 4px;margin-left:4px">Odoo</span>`
        : "";
      item.innerHTML = `
        <span>${escHtml(productLabel(p.name))}${badge}</span>
        ${stockMap[pid] != null ? (() => { const s = _fmtStock(stockMap[pid]); return `<span style="font-size:10px;font-weight:700;white-space:nowrap;color:${s.color}">${s.text}</span>`; })() : ""}
      `;
      item.onmousedown=e=>{e.preventDefault();selectProduct(p);};
      dropdown.appendChild(item);
    });
    dropdown.style.display="block";
  }

   let _ddActiveIdx = -1;

  function _ddHighlight(idx) {
    const items = dropdown.querySelectorAll(".ap-dd-item");
    items.forEach(el => el.classList.remove("ap-dd-item--active"));
    if (idx >= 0 && idx < items.length) {
      _ddActiveIdx = idx;
      items[idx].classList.add("ap-dd-item--active");
      items[idx].scrollIntoView({ block: "nearest" });
    } else {
      _ddActiveIdx = -1;
    }
  }

  let _ddProductSearchTimer = null;

  input.addEventListener("input", () => {
    const q = input.value.trim(); selectedProduct = null; _ddActiveIdx = -1;
    clearTimeout(_ddProductSearchTimer);
    if (!q) { dropdown.style.display = "none"; return; }

    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const localResults = _importedProducts.filter(p => {
      const name = (p.name || "").toLowerCase();
      const code = (p.default_code || "").toLowerCase();
      return tokens.every(t => name.includes(t) || code.includes(t));
    }).slice(0, 15);

    showDropdown(localResults, false);

    _ddProductSearchTimer = setTimeout(async () => {
      try {
        const odooRes = await rpcController.searchProductsTokenized(baseUrl, q);
        if (input.value.trim() !== q) return; // النص تغيّر، تجاهل النتيجة القديمة
        const localKeys = new Set(localResults.map(p => p.id || p.default_code));
        const merged = localResults.concat(
          (odooRes || []).filter(p => !localKeys.has(p.id) && !localKeys.has(p.default_code))
            .map(p => Object.assign({}, p, { _fromOdoo: true }))
        );
        if (!merged.length) { showDropdown([], false); return; }
        dropdown.innerHTML = "";
        const ids = merged.map(p => p.id || p.product_id).filter(Boolean);
        let stockMap = {};
        try { stockMap = await rpcController.getProductStock(baseUrl, ids); } catch(_) {}
        merged.forEach(p => {
          const pid = p.id || p.product_id;
          const _st = stockMap[pid];
          const item = document.createElement("div");
          item.className = "ap-dd-item";
          item.style.cssText = `display:flex;justify-content:space-between;align-items:center;gap:8px;${_st?.free === 0 ? "background:#fef2f2;" : ""}`;
          const badge = p._fromOdoo
            ? `<span style="font-size:9px;color:var(--orange);background:#FFF7ED;border:1px solid #FED7AA;border-radius:3px;padding:1px 4px;margin-left:4px">Odoo</span>`
            : "";
          item.innerHTML = `
            <span>${escHtml(productLabel(p.name))}${badge}</span>
            ${stockMap[pid] != null ? (() => { const s = _fmtStock(stockMap[pid]); return `<span style="font-size:10px;font-weight:700;white-space:nowrap;color:${s.color}">${s.text}</span>`; })() : ""}
          `;
          item.onmousedown = e => { e.preventDefault(); selectProduct(p); };
          dropdown.appendChild(item);
        });
        dropdown.style.display = "block";
      } catch(_) { /* تجاهل خطأ Odoo، النتائج المحلية تبقى ظاهرة */ }
    }, 380);

    if (!localResults.length && !_importedProducts.length) {
      dropdown.innerHTML = `<div class="ap-dd-empty">بحث Odoo…</div>`;
      dropdown.style.display = "block";
    }
  });

  input.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if (dropdown.style.display !== "none") { dropdown.style.display = "none"; _ddActiveIdx = -1; }
      else closeModal();
      return;
    }
    if (dropdown.style.display === "none") return;
    const items = dropdown.querySelectorAll(".ap-dd-item");
    if (!items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      _ddHighlight(Math.min(_ddActiveIdx + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      _ddHighlight(Math.max(_ddActiveIdx - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (_ddActiveIdx >= 0 && items[_ddActiveIdx]) items[_ddActiveIdx].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }
  });

  input.addEventListener("blur", () => setTimeout(() => { dropdown.style.display = "none"; _ddActiveIdx = -1; }, 150));

  submitBtn.addEventListener("click", async ()=>{
    if(!pendingLines.length) return;
    // sync any unsaved input values before submit
    linesList.querySelectorAll(".ap-line-cdn").forEach(el=>{pendingLines[+el.dataset.i].cdn=parseInt(el.value)||0;});
    linesList.querySelectorAll(".ap-line-piece").forEach(el=>{pendingLines[+el.dataset.i].piece=parseInt(el.value)||0;});
    submitBtn.disabled=true; submitBtn.textContent="Ajout en cours…";
    let ok=0,fail=0;
    for(const line of pendingLines){
      try{
        await rpcController.addProductToRound(baseUrl,planningId,line.product,line.cdn,line.piece);
        ok++;
      }catch(err){ fail++; addNotif(`Erreur: ${line.product.name} — ${err.message}`,"error"); }
    }
    submitBtn.textContent="Confirmer tout";
    if(ok) addNotif(`✓ ${ok} produit(s) ajouté(s)`,"success");
    if(!fail) closeModal();
    else{pendingLines=pendingLines.slice(ok);renderLines();submitBtn.disabled=!pendingLines.length;}
  });
}

// ── Add Client Modal ──────────────────────────────────────────
let _importedClients = [];

function bindClientsImport() {
  const fileInput = document.getElementById("settingClientsFile");
  const clearBtn  = document.getElementById("settingClientsClear");
  if (fileInput) fileInput.addEventListener("change", acHandleExcelImport);
  if (clearBtn)  clearBtn.addEventListener("click", () => {
    _importedClients = [];
    Storage.remove("wafaImportedClients");
    const el = document.getElementById("settingClientsCount");
    if (el) el.textContent = "";
    addNotif("Liste clients effacée", "warning");
  });
  Storage.get("wafaImportedClients", null).then(raw => {
    if (Array.isArray(raw)) {
      _importedClients = raw;
      const el = document.getElementById("settingClientsCount");
      if (el) el.textContent = `${_importedClients.length} clients chargés`;
    }
  });
}

function acHandleExcelImport(e) {
  const file = e.target.files?.[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      if (typeof XLSX === "undefined") { addNotif("SheetJS non chargé","error"); return; }
      const wb = XLSX.read(ev.target.result,{type:"array"}), ws=wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws,{header:1,defval:""});
      const clients=[];
      for (let i=1;i<rows.length;i++) {
        const row=rows[i];
        const ref =(row[0]||"").toString().trim();
        const name=(row[1]||"").toString().trim();
        if(!ref) continue;
        clients.push({ref, name});
      }
      _importedClients=clients;
      Storage.set("wafaImportedClients",clients);
      const el=document.getElementById("settingClientsCount");
      if(el) el.textContent=`${clients.length} clients chargés`;
      addNotif(`✓ ${clients.length} clients importés`,"success");
    } catch(err){ addNotif("Erreur Excel: "+err.message,"error"); }
  };
  reader.readAsArrayBuffer(file); e.target.value="";
}

function openAddClientModal(vendorId, vendorLabel, roundId, baseUrl) {
  document.getElementById("addClientModal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "addClientModal";
  overlay.className = "ap-overlay";
  overlay.innerHTML = `
    <div class="ap-modal" style="max-width:360px">
      <div class="ap-header">
        <span class="ap-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            style="width:14px;height:14px;margin-right:5px;vertical-align:middle">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
            <line x1="19" y1="8" x2="19" y2="14"/>
            <line x1="16" y1="11" x2="22" y2="11"/>
          </svg>
          Ajouter client — ${escHtml(vendorLabel)}
        </span>
        <button class="ap-close" id="acClose">×</button>
      </div>
      <div style="position:relative;margin-top:2px">
        <input type="text" id="acClientInput" class="ap-input"
          placeholder="Référence ou nom du client…" autocomplete="off"/>
        <div id="acDropdown" class="ap-dropdown" style="display:none"></div>
      </div>
<div id=\"acSelected\"
        style=\"display:none;flex-direction:column;gap:4px;margin-top:4px;max-height:120px;overflow-y:auto\">
      </div>
      <div id="acStatus"
        style="font-size:11px;min-height:14px;color:var(--text3);text-align:center;padding:3px 0">
      </div>
      <div class="ap-footer" style="margin-top:6px">
        <button class="ap-btn ap-btn-cancel" id="acCancel">Annuler</button>
        <button class="ap-btn ap-btn-add" id="acSubmit" disabled>Confirmer</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let selectedClients = [];
  const input      = document.getElementById("acClientInput");
  const dropdown   = document.getElementById("acDropdown");
  const submitBtn  = document.getElementById("acSubmit");
  const statusEl   = document.getElementById("acStatus");
  const selectedEl = document.getElementById("acSelected");

  const closeModal = () => overlay.remove();
  document.getElementById("acClose").onclick  = closeModal;
  document.getElementById("acCancel").onclick = closeModal;
  overlay.addEventListener("click", e => { if(e.target===overlay) closeModal(); });

  function _doSelectClient(client) {
    if (selectedClients.find(c => c.ref === client.ref)) {
      statusEl.textContent = "Client déjà ajouté";
      statusEl.style.color = "var(--orange)";
      input.value = "";
      dropdown.style.display = "none";
      return;
    }
    selectedClients.push(client);
    input.value = "";
    dropdown.style.display = "none";
    statusEl.textContent = "";
    statusEl.style.color = "var(--text3)";
    submitBtn.disabled = false;
    selectedEl.style.display = "flex";
    _renderSelectedList();
  }

  function _renderSelectedList() {
    selectedEl.innerHTML = selectedClients.map((c, i) => `
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#166534;
        background:#dcfce7;border:1px solid #86efac;border-radius:6px;padding:5px 8px">
        <svg viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5"
          style="width:12px;height:12px;flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>
        <span style="flex:1">${escHtml(c.name||c.ref)} · Réf: ${escHtml(c.ref)}</span>
        <span data-ridx="${i}" style="cursor:pointer;font-size:14px;color:#dc2626;line-height:1">×</span>
      </div>`).join("");
    selectedEl.querySelectorAll("[data-ridx]").forEach(el => {
      el.onclick = () => {
        selectedClients.splice(parseInt(el.dataset.ridx), 1);
        if (!selectedClients.length) { selectedEl.style.display = "none"; submitBtn.disabled = true; }
        _renderSelectedList();
      };
    });
  }

  function _showOdooConfirm(client) {
    const conf = document.createElement("div");
    conf.style.cssText = "position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)";
    conf.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;
        padding:20px;min-width:260px;max-width:300px;box-shadow:0 8px 32px rgba(0,0,0,.4)">
        <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:5px">
          Client Odoo — Confirmer
        </div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:10px;line-height:1.5">
          Ce client provient de Odoo et n'est pas dans la liste importée.
        </div>
        <div style="font-size:13px;font-weight:700;color:var(--accent);background:var(--bg3);
          border-radius:6px;padding:8px 10px;margin-bottom:14px;word-break:break-word">
          ${escHtml(client.name)}
          <div style="font-size:10px;color:var(--text3);font-weight:400;margin-top:2px">
            Réf: ${escHtml(client.ref||"—")}
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <button id="acConfNo"
            style="flex:1;padding:8px;background:var(--bg3);border:1px solid var(--border);
              color:var(--text2);border-radius:6px;cursor:pointer;font-size:12px">
            Annuler
          </button>
          <button id="acConfOk"
            style="flex:2;padding:8px;background:var(--accent);border:none;color:#fff;
              border-radius:6px;cursor:pointer;font-size:12px;font-weight:700">
            Confirmer
          </button>
        </div>
      </div>`;
    document.body.appendChild(conf);
    document.getElementById("acConfOk").onclick = () => { conf.remove(); _doSelectClient(client); };
    document.getElementById("acConfNo").onclick  = () => conf.remove();
    conf.addEventListener("click", e => { if(e.target===conf) conf.remove(); });
  }

  function showDropdown(items, fromOdoo=false) {
    dropdown.innerHTML = "";
    if (!items.length) {
      dropdown.innerHTML = `<div class="ap-dd-empty">Aucun résultat</div>`;
      dropdown.style.display = "block"; return;
    }
    items.forEach(c => {
      const d = document.createElement("div");
      d.className = "ap-dd-item";
      const refHtml  = `<span style="font-weight:700;color:var(--accent);margin-right:4px">${escHtml(c.ref||"—")}</span>`;
      const nameHtml = escHtml(c.name||c.fullName||"");
      const badge    = fromOdoo
        ? `<span style="font-size:9px;color:var(--orange);background:#FFF7ED;border:1px solid #FED7AA;
             border-radius:3px;padding:1px 4px;margin-left:4px">Odoo</span>`
        : "";
      d.innerHTML = refHtml + nameHtml + badge;
      d.onmousedown = e => {
        e.preventDefault();
        const client = { ref: c.ref||String(c.id||""), name: c.name||c.fullName||"" };
        if (fromOdoo) _showOdooConfirm(client);
        else _doSelectClient(client);
      };
      dropdown.appendChild(d);
    });
    dropdown.style.display = "block";
  }

  let _odooSearchTimer = null;

  input.addEventListener("input", () => {
    const q = input.value.trim();
    selectedClient = null;
    submitBtn.disabled = true;
    selectedEl.style.display = "none";
    statusEl.style.color = "var(--text3)";
    clearTimeout(_odooSearchTimer);

    if (!q) { dropdown.style.display="none"; statusEl.textContent=""; return; }

    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const localResults = _importedClients.filter(c => {
      const ref = c.ref.toLowerCase();
      const name = (c.name||"").toLowerCase();
      return tokens.every(t => ref.includes(t) || name.includes(t));
    }).slice(0, 12);

    if (localResults.length) {
      showDropdown(localResults, false);
      statusEl.textContent = "";
      return;
    }

    dropdown.innerHTML = `<div class="ap-dd-empty" style="color:var(--accent)">🔍 Recherche dans Odoo…</div>`;
    dropdown.style.display = "block";
    statusEl.textContent = "Aucun résultat local — recherche Odoo…";

    _odooSearchTimer = setTimeout(async () => {
      try {
        const odooRes = await rpcController.searchClientsByName(baseUrl, q);
        statusEl.textContent = "";
        if (!odooRes.length) {
          dropdown.innerHTML = `<div class="ap-dd-empty">Aucun résultat dans Odoo</div>`;
          return;
        }
        showDropdown(odooRes, true);
      } catch(err) {
        statusEl.textContent = "Erreur Odoo: " + err.message;
        statusEl.style.color = "var(--red)";
        dropdown.style.display = "none";
      }
    }, 400);
  });

  input.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if (dropdown.style.display !== "none") dropdown.style.display = "none";
      else closeModal();
    }
  });
  input.addEventListener("blur", () => setTimeout(()=>{ dropdown.style.display="none"; }, 150));
  input.focus();

  submitBtn.addEventListener("click", async () => {
    if (!selectedClients.length) return;
    submitBtn.disabled = true;
    submitBtn.textContent = "Ajout…";
    statusEl.textContent = "⏳ Ajout en cours…";
    statusEl.style.color = "var(--accent)";
    try {
      for (const client of selectedClients) {
        await rpcController.addClientToRound(baseUrl, roundId, client.ref, App.currentMode);
      }
      addNotif(`✓ ${selectedClients.length} client(s) ajouté(s)`, "success");
      closeModal();
    } catch(err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Confirmer";
      statusEl.textContent = "✗ " + err.message;
      statusEl.style.color = "var(--red)";
    }
  });
}

// ── Delete Client Modal ───────────────────────────────────────
function openDeleteClientModal(vendorId, vendorLabel, roundId, baseUrl) {
  document.getElementById("deleteClientModal")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "deleteClientModal";
  overlay.className = "ap-overlay";
  overlay.innerHTML = `
    <div class="ap-modal" style="max-width:360px">
      <div class="ap-header">
        <span class="ap-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            style="width:14px;height:14px;margin-right:5px;vertical-align:middle">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
            <line x1="16" y1="11" x2="22" y2="11"/>
          </svg>
          Supprimer client — ${escHtml(vendorLabel)}
        </span>
        <button class="ap-close" id="dcClose">×</button>
      </div>
      <div style="position:relative;margin-top:2px">
        <input type="text" id="dcClientInput" class="ap-input"
          placeholder="Rechercher un client de la tournée…" autocomplete="off"/>
      </div>
      <div id="dcList" style="max-height:260px;overflow-y:auto;margin-top:6px;display:flex;flex-direction:column;gap:4px"></div>
      <div id="dcStatus"
        style="font-size:11px;min-height:14px;color:var(--text3);text-align:center;padding:3px 0">
      </div>
      <div class="ap-footer" style="margin-top:6px">
        <button class="ap-btn ap-btn-cancel" id="dcCancel">Annuler</button>
        <button class="ap-btn ap-btn-add" id="dcSubmit" disabled style="background:var(--red,#dc2626)">Supprimer</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let roundClients   = [];
  let selectedEvents = [];
  const input     = document.getElementById("dcClientInput");
  const listEl    = document.getElementById("dcList");
  const submitBtn = document.getElementById("dcSubmit");
  const statusEl  = document.getElementById("dcStatus");

  const closeModal = () => overlay.remove();
  document.getElementById("dcClose").onclick  = closeModal;
  document.getElementById("dcCancel").onclick = closeModal;
  overlay.addEventListener("click", e => { if(e.target===overlay) closeModal(); });

  function _renderList() {
    const q = input.value.trim().toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    const filtered = tokens.length
      ? roundClients.filter(c => tokens.every(t => (c.name||"").toLowerCase().includes(t)))
      : roundClients;
    if (!filtered.length) {
      listEl.innerHTML = `<div style="padding:16px;text-align:center;color:var(--text3);font-size:12px">Aucun client trouvé</div>`;
      return;
    }
    listEl.innerHTML = filtered.map(c => {
      const checked = selectedEvents.includes(c.id);
      return `<label style="display:flex;align-items:center;gap:8px;font-size:12px;padding:6px 8px;
        border:1px solid var(--border);border-radius:6px;cursor:pointer">
        <input type="checkbox" data-eid="${c.id}" ${checked ? "checked" : ""}/>
        <span style="flex:1">${escHtml(c.name||"")}</span>
      </label>`;
    }).join("");
    listEl.querySelectorAll("input[type=checkbox]").forEach(chk => {
      chk.onchange = () => {
        const eid = parseInt(chk.dataset.eid, 10);
        if (chk.checked) { if (!selectedEvents.includes(eid)) selectedEvents.push(eid); }
        else selectedEvents = selectedEvents.filter(id => id !== eid);
        submitBtn.disabled = !selectedEvents.length;
      };
    });
  }

  input.addEventListener("input", _renderList);

  statusEl.textContent = "⏳ Chargement…";
  rpcController.fetchRoundClientsForDelete(baseUrl, roundId)
    .then(clients => {
      roundClients = clients || [];
      statusEl.textContent = "";
      _renderList();
    })
    .catch(err => {
      statusEl.textContent = "✗ " + err.message;
      statusEl.style.color = "var(--red)";
    });

  submitBtn.addEventListener("click", async () => {
    if (!selectedEvents.length) return;
    submitBtn.disabled = true;
    submitBtn.textContent = "Suppression…";
    statusEl.textContent = "⏳ Suppression en cours…";
    statusEl.style.color = "var(--accent)";
    try {
      await rpcController.deleteClientFromRound(baseUrl, selectedEvents);
      addNotif(`✓ ${selectedEvents.length} client(s) supprimé(s) de la tournée`, "success");
      closeModal();
    } catch(err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Supprimer";
      statusEl.textContent = "✗ " + err.message;
      statusEl.style.color = "var(--red)";
    }
  });
}

// ── Payment Modal ─────────────────────────────────────────────
App.pmLoadShortcuts = function() {
  try { App.pmShortcuts=JSON.parse(localStorage.getItem(PM_SHORTCUTS_KEY)||"[]"); } catch(_){ App.pmShortcuts=[]; }
};
function pmSaveShortcuts() { try{ localStorage.setItem(PM_SHORTCUTS_KEY,JSON.stringify(App.pmShortcuts)); }catch(_){} }

function _showPayConfirm(worker, onConfirm) {
  document.getElementById("payConfirmOverlay")?.remove();
  const lbl = worker.label || worker.name;
  const el  = document.createElement("div");
  el.id     = "payConfirmOverlay";
  el.style.cssText = "position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,0.45)";
  el.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px 22px;max-width:280px;width:90%;box-shadow:0 16px 48px rgba(0,0,0,0.18);display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;align-items:center;gap:8px">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r=".5" fill="#f59e0b"/></svg>
        <span style="font-size:13px;font-weight:700;color:var(--text)">Confirmer paiement</span>
      </div>
      <p style="font-size:12px;color:var(--text2);margin:0;line-height:1.5">
        Enregistrer un encaissement pour <b>${escHtml(lbl)}</b> ?
      </p>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="payConfirmNo"  style="padding:6px 14px;border-radius:7px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);font-size:12px;cursor:pointer">Annuler</button>
        <button id="payConfirmYes" style="padding:6px 14px;border-radius:7px;border:none;background:var(--accent);color:#fff;font-size:12px;font-weight:700;cursor:pointer">Confirmer</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  document.getElementById("payConfirmYes").onclick = () => { el.remove(); onConfirm(); };
  document.getElementById("payConfirmNo").onclick  = () => el.remove();
  el.addEventListener("click", e => { if (e.target === el) el.remove(); });
}
async function _pmShowBalance(refOrName) {
  const balEl = document.getElementById("pmBalanceDisplay");
  if (!balEl) return;
  balEl.textContent = "…";
  balEl.style.color = "var(--text3,#94A3B8)";
  try {
    const baseUrl = "";
    // البحث بالـ ref أولاً ثم بالاسم
    let partners = await _rpc_call(baseUrl, {
      model: "res.partner", method: "search_read",
      args: [[["ref", "=", refOrName]]],
      kwargs: { fields: ["id", "name", "current_balance"], limit: 1 },
    });
    if (!partners?.length) {
      partners = await _rpc_call(baseUrl, {
        model: "res.partner", method: "search_read",
        args: [[["name", "=", refOrName]]],
        kwargs: { fields: ["id", "name", "current_balance"], limit: 1 },
      });
    }
    if (!partners?.length) { balEl.textContent = "—"; return; }
    const bal = partners[0].current_balance || 0;
    balEl.textContent = bal.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " DA";
    balEl.style.color = bal > 0 ? "#DC2626" : "#15803d";
  } catch(e) {
    balEl.textContent = "—";
  }
}
function openPaymentModal(workerId) {
  const worker=allWorkers().find(w=>w.id===workerId); if(!worker) return;
  App.pmCurrentWorker=worker; App.pmLoadShortcuts();
  const pmInp=document.getElementById("pmPartner"); pmInp.value=""; delete pmInp.dataset.odooRef;
  document.getElementById("pmAmount").value=""; document.getElementById("pmRef").value=""; document.getElementById("pmStatus").textContent="";
  const sugg=document.getElementById("pmPartnerSuggestions"); if(sugg) sugg.style.display="none";
  pmValidate(); pmUpdateCount(); pmShowShortcutsModal();
  const modal=document.getElementById("paymentModal");
  if(modal){modal.style.display="flex";modal.style.position="fixed";modal.style.inset="0";modal.style.zIndex="9999";}
  setTimeout(()=>{ const inp=document.getElementById("pmPartner"); if(inp) inp.focus(); },100);
}

function closePaymentModal() { const m=document.getElementById("paymentModal"); if(m) m.style.display="none"; App.pmCurrentWorker=null; }

function pmValidate() {
  const partner=document.getElementById("pmPartner")?.value.trim(), amount=document.getElementById("pmAmount")?.value.trim();
  const valid=partner&&amount&&/^[0-9]+(\.[0-9]{1,2})?$/.test(amount);
  ["pmBtnCreate","pmBtnFill"].forEach(id=>{ const el=document.getElementById(id); if(el) el.disabled=!valid; });
}

function pmSearch(term) { if(!term||term.length<2) return []; const t=term.toLowerCase(); return App.pmShortcuts.filter(s=>s.fullName?.toLowerCase().includes(t)).slice(0,10); }
let pmSuggActiveIdx=-1;
function pmSelectSuggestion(el, fromOdoo=false) {
  const name = el.dataset.name;
  const ref  = el.dataset.ref || "";
  document.getElementById("pmPartnerSuggestions").style.display="none";
  pmSuggActiveIdx=-1;
  if(fromOdoo) {
    const modal = document.getElementById("pmConfirmModal");
    document.getElementById("pmConfirmName").textContent = name;
    modal.style.display = "flex";
    document.getElementById("pmConfirmOk").onclick = () => {
      modal.style.display = "none";
      const inp = document.getElementById("pmPartner");
      inp.value = name;
      if (ref) inp.dataset.odooRef = ref;
      pmValidate();
      _pmShowBalance(ref || name);
      document.getElementById("pmAmount")?.focus();
    };
    document.getElementById("pmConfirmCancel").onclick = () => {
      modal.style.display = "none";
    };
  } else {
    const inp = document.getElementById("pmPartner");
    inp.value = name;
    if (ref) inp.dataset.odooRef = ref;
    pmValidate();
    _pmShowBalance(ref || name);
  }
}

let _pmSearchTimer = null;

function pmShowSuggestions(term) {
  const box=document.getElementById("pmPartnerSuggestions"); if(!box) return;
  pmSuggActiveIdx=-1;
  clearTimeout(_pmSearchTimer);

  if (!term || term.length < 2) { box.style.display="none"; return; }

  box.innerHTML=`<div class="pm-sugg-item" style="opacity:.6;pointer-events:none">🔍 Recherche Odoo…</div>`;
  box.style.display="block";

  _pmSearchTimer = setTimeout(async () => {
    try {
      const baseUrl  = (App.settings?.baseUrlPayment || "").replace(/\/$/, "");
      const routeIds = (App.settings?.pmRoutes || []).map(r => r.id).filter(Boolean);
      const results  = await rpcController.searchPartners(baseUrl, term, routeIds);
      if (document.getElementById("pmPartner")?.value.trim() !== term) return; // النص تغيّر، تجاهل نتيجة قديمة
      if (!results.length) { box.style.display="none"; return; }

      const routeNameById = {};
      (App.settings?.pmRoutes || []).forEach(r => { if (r.id) routeNameById[r.id] = r.name || String(r.id); });

      box.innerHTML = results.map((s,i) => {
        let badge = "";
        let fromRoute = false;
        if (Array.isArray(s.matchedRouteIds) && s.matchedRouteIds.length) {
          const matchedId = routeIds.find(id => s.matchedRouteIds.includes(id));
          const routeName = matchedId ? (routeNameById[matchedId] || String(matchedId)) : null;
          if (routeName) { badge = `<span class="pm-sugg-key" style="color:var(--accent)">${escHtml(routeName)}</span>`; fromRoute = true; }
        }
        if (!badge) badge = `<span class="pm-sugg-key">Odoo</span>`;
        return `<div class="pm-sugg-item" data-name="${escHtml(s.fullName)}" data-ref="${escHtml(s.ref||"")}" data-idx="${i}" data-from-route="${fromRoute?"1":"0"}"><span class="pm-sugg-name">${escHtml(s.fullName)}</span>${badge}</div>`;
      }).join("");
      box.style.display="block";
      box.querySelectorAll(".pm-sugg-item").forEach(el=>el.addEventListener("mousedown",e=>{e.preventDefault();pmSelectSuggestion(el, el.dataset.fromRoute!=="1");}));
    } catch(_) {
      box.style.display="none";
    }
  }, 380);
}
function pmSuggHighlight(delta) {
  const box=document.getElementById("pmPartnerSuggestions"); if(!box||box.style.display==="none") return false;
  const items=box.querySelectorAll(".pm-sugg-item"); if(!items.length) return false;
  items.forEach(el=>el.classList.remove("pm-sugg-active")); pmSuggActiveIdx=Math.max(0,Math.min(items.length-1,pmSuggActiveIdx+delta));
  items[pmSuggActiveIdx].classList.add("pm-sugg-active"); items[pmSuggActiveIdx].scrollIntoView({block:"nearest"}); return true;
}

// Payment execute — "Créer & Ouvrir": ينشئ الدفعة ويفتح السجل في Odoo
async function pmExecuteFill() {
  const statusEl=document.getElementById("pmStatus");
  if(!App.pmCurrentWorker||!statusEl) return;
  const partner=document.getElementById("pmPartner").value.trim();
  const journal=document.getElementById("pmJournal").value;
const paymentType=document.getElementById("pmPaymentType")?.value||"inbound";
const amount =document.getElementById("pmAmount").value.trim();
const ref    =document.getElementById("pmRef").value.trim();
  const sc     =App.pmShortcuts.find(s=>s.fullName===partner);
  const partnerRef=sc?.ref||document.getElementById("pmPartner").dataset.odooRef||"";
  if(!partnerRef){statusEl.textContent="✗ Référence client introuvable";statusEl.className="pm-status err";return;}
  const worker=App.pmCurrentWorker;
  const odooUserId=App.allStats[worker.id]?.odooUserId||null;
  const planningId=App.allStats[worker.id]?.roundId||null;
  statusEl.textContent="⏳ Création en cours…"; statusEl.className="pm-status info";
  try {
    const recordId=await rpcController.createPayment("",{
  journalId:parseInt(journal), partnerRef, amount, communication:ref||false,
  odooUserId, planningId, paymentDate:new Date().toISOString().slice(0,10),
  paymentType, partnerType: paymentType,
},"card.payment.autoFill");
    // ── Confirmer automatiquement la تحصيلة الجديدة، exactement comme le bouton
    // "Confirmer" par-ligne dans le modal "Paiements de la tournée" (post RPC) ──
    let _confirmOk = true;
    try {
      await _rpc_call("", { model:"account.payment", method:"post", args:[[recordId]], kwargs:{} });
      statusEl.textContent="✓ Créé et confirmé";
      statusEl.className="pm-status ok";
    } catch(confirmErr) {
      _confirmOk = false;
      statusEl.textContent="✓ Créé — échec confirmation auto ("+confirmErr.message+"), confirmez manuellement";
      statusEl.className="pm-status err";
    }
    setTimeout(()=>{
      document.getElementById("pmPartner").value="";
      document.getElementById("pmAmount").value="";
      document.getElementById("pmRef").value="";
      const ptFill=document.getElementById("pmPaymentType"); if(ptFill) ptFill.value="inbound";
      const jFill=document.getElementById("pmJournal"); if(jFill) jFill.selectedIndex=0;
      // لا نخفي رسالة فشل التأكيد التلقائي بإعادة التعيين السريعة — تبقى ظاهرة
      // حتى يتصرّف المستخدم يدوياً (فتح السجل مفتوح أصلاً في التبويب الجديد).
      if (_confirmOk) { statusEl.textContent="✓ Prêt pour le suivant"; statusEl.className="pm-status ok"; }
      pmValidate();
    }, _confirmOk ? 2000 : 6000);
  } catch(e){ statusEl.textContent="✗ "+e.message; statusEl.className="pm-status err"; }
}

// Payment execute — "Nouveau": ينشئ الدفعة فقط بدون فتح نافذة
async function pmExecuteCreate() {
  const statusEl=document.getElementById("pmStatus");
  if(!App.pmCurrentWorker||!statusEl) return;
  const partner=document.getElementById("pmPartner").value.trim();
  const journal=document.getElementById("pmJournal").value;
  const paymentType=document.getElementById("pmPaymentType")?.value||"inbound";
  const amount =document.getElementById("pmAmount").value.trim();
  const ref    =document.getElementById("pmRef").value.trim();
  const sc     =App.pmShortcuts.find(s=>s.fullName===partner);
  const partnerRef=sc?.ref||"";
  if(!partnerRef){statusEl.textContent="✗ Référence client introuvable";statusEl.className="pm-status err";return;}
  const worker=App.pmCurrentWorker;
  const odooUserId=App.allStats[worker.id]?.odooUserId||null;
  const planningId=App.allStats[worker.id]?.roundId||null;
  statusEl.textContent="⏳ Création en cours…"; statusEl.className="pm-status info";
  try {
    const recordId=await rpcController.createPayment("",{
      journalId:parseInt(journal), partnerRef, amount, communication:ref||false,
      odooUserId, planningId, paymentDate:new Date().toISOString().slice(0,10),
      paymentType, partnerType: paymentType,
    },"card.payment.create");
    // ── Confirmer automatiquement la تحصيلة الجديدة، exactement comme le bouton
    // "Confirmer" par-ligne dans le modal "Paiements de la tournée" (post RPC) ──
    let _confirmOk = true;
    try {
      await _rpc_call("", { model:"account.payment", method:"post", args:[[recordId]], kwargs:{} });
      statusEl.textContent="✓ Créé et confirmé avec succès";
      statusEl.className="pm-status ok";
    } catch(confirmErr) {
      _confirmOk = false;
      statusEl.textContent="✓ Créé — échec confirmation auto ("+confirmErr.message+"), confirmez manuellement";
      statusEl.className="pm-status err";
    }
    setTimeout(()=>{
      document.getElementById("pmPartner").value="";
      document.getElementById("pmAmount").value="";
      document.getElementById("pmRef").value="";
      const ptCreate=document.getElementById("pmPaymentType"); if(ptCreate) ptCreate.value="inbound";
      const jCreate=document.getElementById("pmJournal"); if(jCreate) jCreate.selectedIndex=0;
      if (_confirmOk) { statusEl.textContent="✓ Prêt pour le suivant"; statusEl.className="pm-status ok"; }
      pmValidate();
    }, _confirmOk ? 2000 : 6000);
  } catch(e){ statusEl.textContent="✗ "+e.message; statusEl.className="pm-status err"; }
}

document.addEventListener("DOMContentLoaded",()=>{
  document.getElementById("pmBtnClose")?.addEventListener("click",closePaymentModal);
  document.getElementById("pmBtnFill") ?.addEventListener("click",pmExecuteFill);    // Créer & Ouvrir
  document.getElementById("pmBtnCreate")?.addEventListener("click",pmExecuteCreate); // Nouveau (sans ouvrir)
  document.getElementById("paymentModal")?.addEventListener("click",e=>{if(e.target===document.getElementById("paymentModal"))closePaymentModal();});
  document.getElementById("pmPartner")?.addEventListener("input",function(){const v=this.value;pmValidate();pmSuggActiveIdx=-1;pmShowSuggestions(v.trim());});
  document.getElementById("pmPartner")?.addEventListener("keydown",function(e){
    const box=document.getElementById("pmPartnerSuggestions");if(!box||box.style.display==="none") return;
    if(e.key==="ArrowDown"){e.preventDefault();pmSuggHighlight(1);}else if(e.key==="ArrowUp"){e.preventDefault();pmSuggHighlight(-1);}
    else if(e.key==="Enter"){const active=box.querySelector(".pm-sugg-active");if(active){e.preventDefault();pmSelectSuggestion(active, true);}}
    else if(e.key==="Escape"){box.style.display="none";pmSuggActiveIdx=-1;}
  });
  document.getElementById("pmPartner")?.addEventListener("blur",()=>{setTimeout(()=>{const b=document.getElementById("pmPartnerSuggestions");if(b)b.style.display="none";pmSuggActiveIdx=-1;},200);});
  document.getElementById("pmAmount")?.addEventListener("input",function(){this.value=this.value.replace(/[^\d.]/g,"");pmValidate();});
  document.getElementById("pmRef")?.addEventListener("input",pmValidate);

  document.getElementById("settingScImportFile")?.addEventListener("change",e=>{
    const file=e.target.files[0];if(!file) return;
    App.pmLoadShortcuts();const reader=new FileReader();
    reader.onload=ev=>{
      const lines=ev.target.result.split(/\r?\n/);let added=0;
      const seen=new Set(App.pmShortcuts.map(s=>s.fullName.toLowerCase()));
      for(const line of lines){const t=line.trim();if(!t||t.startsWith("#")) continue;const sep=t.includes(";")?";":(t.includes(",")?"," :"\t");const parts=t.split(sep).map(p=>p.trim());const fullName=parts[0]||"",ref=parts[2]||"";if(fullName&&!seen.has(fullName.toLowerCase())){seen.add(fullName.toLowerCase());App.pmShortcuts.push({fullName,ref});added++;}}
      pmSaveShortcuts();const st=document.getElementById("settingScImportStatus");if(st)st.textContent=`✓ ${added} raccourcis ajoutés (total: ${App.pmShortcuts.length})`;pmUpdateCount();e.target.value="";
    };reader.readAsText(file,"UTF-8");
  });
  document.getElementById("settingScClearBtn")?.addEventListener("click",()=>{
    if(confirm("Supprimer TOUS les raccourcis?")){App.pmShortcuts=[];pmSaveShortcuts();const st=document.getElementById("settingScImportStatus");if(st)st.textContent="Raccourcis supprimés";pmUpdateCount();}
  });
});

// ── Stock Final — modal ─────────────────────────────────────
function openStockFinalModal(vendorLabel, lines) {
  document.getElementById("stockFinalModal")?.remove();
  const filtered = lines.filter(l => l.qty > 0);

  const bodyHtml = !filtered.length
    ? `<div style="padding:16px;text-align:center;color:var(--text3,#888);font-size:13px;">Stock final vide.</div>`
    : `<table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border,#ddd);">Article</th>
          <th style="text-align:center;padding:6px 8px;border-bottom:1px solid var(--border,#ddd);">CDN</th>
          <th style="text-align:center;padding:6px 8px;border-bottom:1px solid var(--border,#ddd);">Qté</th>
        </tr></thead>
        <tbody>
          ${filtered.map(l => {
            const cdn = l.packaging_qty > 0 ? +(l.qty / l.packaging_qty).toFixed(2) : "—";
            return `<tr>
              <td style="padding:5px 8px;border-bottom:1px solid var(--border,#eee);" title="${escHtml(l.name)}">${escHtml(productLabel(l.name))}</td>
              <td style="padding:5px 8px;text-align:center;border-bottom:1px solid var(--border,#eee);">${cdn}</td>
              <td style="padding:5px 8px;text-align:center;font-weight:600;border-bottom:1px solid var(--border,#eee);">${l.qty}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;

  const overlay = document.createElement("div");
  overlay.id = "stockFinalModal";
  overlay.className = "ap-overlay";
  overlay.innerHTML = `
    <div class="ap-modal">
      <div class="ap-header">
        <span class="ap-title">Stock Final — ${escHtml(vendorLabel)}</span>
        <button class="ap-close" id="sfClose">×</button>
      </div>
      <div id="sfBody" style="max-height:60vh;overflow-y:auto;">${bodyHtml}</div>
      <div class="ap-footer">
        <button class="ap-btn ap-btn-add" id="sfExportBtn" ${!filtered.length ? "disabled" : ""}>Exporter XLSX</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const closeModal = () => overlay.remove();
  document.getElementById("sfClose").onclick = closeModal;
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
  document.getElementById("sfExportBtn").onclick = () => {
    exportStockFinalXlsx(vendorLabel, lines, lines.ref, lines.date);
    closeModal();
  };
}

// ── Stock Final XLSX export ───────────────────────────────────
function exportStockFinalXlsx(vendorLabel, lines, ref, dateStr) {
  const dateFmt  = dateStr ? dateStr.split("-").reverse().join("/") : new Date().toLocaleDateString("fr-FR");
  const title    = `STOCK FINAL: ${vendorLabel} ${dateFmt}${ref ? " (" + ref + ")" : ""}`;
  const filtered = lines.filter(l => l.qty > 0);

  if (typeof XLSX !== "undefined") {
    // ── SheetJS ──────────────────────────────────────────────
    const wb   = XLSX.utils.book_new();
    const aoa  = [];
    aoa.push([title, "", ""]);
    aoa.push([]);
    aoa.push(["Article", "CDN", "Quantit\u00e9"]);
    filtered.forEach(l => {
      const cdn = l.packaging_qty > 0 ? +(l.qty / l.packaging_qty).toFixed(2) : "";
      aoa.push([l.name, cdn, l.qty]);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // عرض الأعمدة
    const maxLen = Math.max(7, ...filtered.map(l => l.name.length));
    ws["!cols"] = [
      { wch: Math.min(maxLen * 1.05, 80) },
      { wch: 10 },
      { wch: 12 },
    ];

    // دمج خلايا العنوان
    ws["!merges"] = [{ s:{r:0,c:0}, e:{r:0,c:2} }];

    // تنسيق الخلايا
    const thinBorder = { left:{style:"thin"}, right:{style:"thin"}, top:{style:"thin"}, bottom:{style:"thin"} };
    const titleStyle = { font:{bold:true,sz:14,color:{rgb:"1F3864"}}, alignment:{horizontal:"center",vertical:"center"}, fill:{fgColor:{rgb:"FFFFFF"}}, border:thinBorder };
    const hdrStyle   = { font:{bold:true,sz:10,color:{rgb:"FFFFFF"}}, alignment:{horizontal:"center",vertical:"center"}, fill:{fgColor:{rgb:"1F3864"}}, border:thinBorder };
    const rowEven    = { font:{sz:10}, fill:{fgColor:{rgb:"DCE6F1"}}, border:{left:{style:"thin"},right:{style:"thin"},top:{style:"thin"},bottom:{style:"thin"}} };
    const rowOdd     = { font:{sz:10}, fill:{fgColor:{rgb:"FFFFFF"}}, border:{left:{style:"thin"},right:{style:"thin"},top:{style:"thin"},bottom:{style:"thin"}} };
    const numEven    = { ...rowEven, alignment:{horizontal:"center"} };
    const numOdd     = { ...rowOdd,  alignment:{horizontal:"center"} };

    if (ws["A1"]) ws["A1"].s = titleStyle;
    ["A3","B3","C3"].forEach(ref => { if (ws[ref]) ws[ref].s = hdrStyle; });
    filtered.forEach((l, i) => {
      const r    = i + 4;
      const even = i % 2 === 0;
      const ref  = (col, r) => col + r;
      if (ws[ref("A",r)]) ws[ref("A",r)].s = even ? rowEven : rowOdd;
      if (ws[ref("B",r)]) ws[ref("B",r)].s = even ? numEven : numOdd;
      if (ws[ref("C",r)]) ws[ref("C",r)].s = even ? numEven : numOdd;
    });

    ws["!rows"] = [{ hpt:24 }, { hpt:6 }, { hpt:18 }];

    XLSX.utils.book_append_sheet(wb, ws, "Stock Final");
    XLSX.writeFile(wb, `stock_final_${vendorLabel.replace(/\s+/g,"_")}.xlsx`);

  } else {
    // ── CSV fallback ─────────────────────────────────────────
    let csv = `"${title}"\n\nArticle,CDN,Quantit\u00e9\n`;
    filtered.forEach(l => {
      const cdn = l.packaging_qty > 0 ? +(l.qty / l.packaging_qty).toFixed(2) : "";
      csv += `"${l.name}",${cdn},${l.qty}\n`;
    });
    _downloadBlob(new Blob(["\uFEFF"+csv], { type:"text/csv;charset=utf-8;" }), `stock_final_${vendorLabel.replace(/\s+/g,"_")}.csv`);
  }
}
function _downloadBlob(blob,filename){const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
