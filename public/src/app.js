// ============================================================
// src/app.js — Wafa PWA v1.0
// ORCHESTRATION: state + events + RPC calls (direct, no SW proxy)
// No chrome.* APIs. No alarms. No cloud. No injection.
// Auth via browser cookies (credentials: include in fetch).
// ============================================================
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
    if (j?.result) return; // session valid ✓
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
      .then(d => {
        if (d?.result?.uid) {
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
  settings:  null,
  currentMode: "gds",
};

// ── Constants ─────────────────────────────────────────────────
const MODE_CFG = {
  gds: { label:"GDS", color:"var(--gds-color)" },
};

// ── Category order helper ──────────────────────────────────────
function _getCatOrder() {
  return (App.settings?.categoryOrder) || [];
}
function _sortCats(cats) {
  const order = _getCatOrder();
  if (!order.length) return [...cats].sort();
  return [...cats].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}






// ── Init ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  await checkAndLoginTwoStep();
  await loadData();
  setMode("gds");
  renderSettings();
  bindEvents();

  // Register service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
});

// ── Load data ─────────────────────────────────────────────────
async function loadData() {
  App.settings = await Storage.getSettings();
  // جلب الإعدادات من Firebase
  try {
    const r = await fetch(`${_FB_DB_URL}/settings.json`);
    const fb = await r.json();
    if (fb) {
      if (fb.categoryOrder?.length)      App.settings.categoryOrder       = fb.categoryOrder;
      if (fb.showTotalU          !== undefined) App.settings.showTotalU          = fb.showTotalU;
      if (fb.showPrepQty         !== undefined) App.settings.showPrepQty         = fb.showPrepQty;
      if (fb.rapportRequireCheck !== undefined) App.settings.rapportRequireCheck = fb.rapportRequireCheck;
      if (fb.rptColumns          !== undefined) App.settings.rptColumns          = fb.rptColumns;
      if (fb.rptFontProduct      !== undefined) App.settings.rptFontProduct      = fb.rptFontProduct;
      if (fb.rptFontQty          !== undefined) App.settings.rptFontQty          = fb.rptFontQty;
      if (fb.rptRowPadding       !== undefined) App.settings.rptRowPadding       = fb.rptRowPadding;
      if (fb.rptColPrepCarton    !== undefined) App.settings.rptColPrepCarton    = fb.rptColPrepCarton;
      if (fb.rptColPrepUnite     !== undefined) App.settings.rptColPrepUnite     = fb.rptColPrepUnite;
      if (fb.rptColChargCarton   !== undefined) App.settings.rptColChargCarton   = fb.rptColChargCarton;
      if (fb.rptColChargUnite    !== undefined) App.settings.rptColChargUnite    = fb.rptColChargUnite;
      if (fb.rptColResteCarton   !== undefined) App.settings.rptColResteCarton   = fb.rptColResteCarton;
      if (fb.rptColResteUnite    !== undefined) App.settings.rptColResteUnite    = fb.rptColResteUnite;
      if (fb.rptColCheck         !== undefined) App.settings.rptColCheck         = fb.rptColCheck;
      if (fb.rptColEcart         !== undefined) App.settings.rptColEcart         = fb.rptColEcart;
      

      if (fb.pdfColumns          !== undefined) App.settings.pdfColumns          = fb.pdfColumns;
      if (fb.pdfFontProduct      !== undefined) App.settings.pdfFontProduct      = fb.pdfFontProduct;
      if (fb.pdfFontQty          !== undefined) App.settings.pdfFontQty          = fb.pdfFontQty;
      if (fb.pdfRowPadding       !== undefined) App.settings.pdfRowPadding       = fb.pdfRowPadding;
    }
   } catch(e) { console.warn("Firebase load failed:", e); }

  // جلب خريطة أسماء المنتجات من Firebase
  try {
    const rProd = await fetch(`${_FB_DB_URL}/${_PROD_NAMES_FB_KEY}.json`);
    const fbProd = await rProd.json();
    if (fbProd && typeof fbProd === "object") App.settings.productNamesMap = fbProd;
  } catch(_) {}

  // جلب قائمة الموزعين من Firebase
  try {
    // جلب distributeurs لكل warehouse عند المستخدم
    const whIds = (AppAuth.warehouseDetails || []).map(w => w.id);
    for (const whId of whIds) {
      const rDist = await fetch(`${_FB_DB_URL}/sf_distributeurs_${whId}.json`);
      const fbDist = await rDist.json();
      if (Array.isArray(fbDist) && fbDist.length) {
        localStorage.setItem(`sf_distributeurs_${whId}`, JSON.stringify(fbDist));
      }
    }
  } catch(e) { console.warn("SF distributeurs load failed:", e); }

  // جلب إعدادات Stock Final من Firebase
  try {
    const r3 = await fetch(`${_FB_DB_URL}/sf_settings.json`);
    const fbSf = await r3.json();
    if (fbSf?.columnsPerRow) {
      localStorage.setItem("sf_columns_per_row", String(fbSf.columnsPerRow));
    }
  } catch(e) { console.warn("SF settings load failed:", e); }
}

// ── GDS Stock View ────────────────────────────────────────────
const GDS_COLLAPSED_KEY = "wafa_gds_collapsed";
const GDS_VANS_COLLAPSED_KEY = "wafa_gds_vans_collapsed";

function _getActiveWarehouse() {
  const details = AppAuth.warehouseDetails || [];
  if (!details.length) return null;
  const allowed = AppAuth.allowedWarehouseIds || details.map(w => w.id);
  // التحقق أن الـ activeWarehouseId مسموح به
  const activeId = allowed.includes(AppAuth.activeWarehouseId)
    ? AppAuth.activeWarehouseId
    : allowed[0];
  AppAuth.activeWarehouseId = activeId;
  return details.find(w => w.id === activeId) || null;
}

function _getWarehouseId() {
  return _getActiveWarehouse()?.id || null;
}

// موقع الـ stock الرئيسي (كان GDS_WAREHOUSE_ID = 213)
function _getStockLocationId() {
  const wh = _getActiveWarehouse();
  if (!wh) return null;
  const saved = AppAuth.warehouseSettings?.[wh.id];
  return saved?.stockLocationId || wh.lot_stock_id?.[0] || null;
}
function _cleanName(name, useVanStrip = false) {
  const wh = _getActiveWarehouse();
  const saved = wh ? (AppAuth.warehouseSettings?.[wh.id] || {}) : {};

  let result = name || "";

  // أخذ آخر جزء بعد / أولاً
  if (saved.splitSlash && result.includes("/")) {
    result = result.split("/").pop().trim();
  }

  // حذف الكلمات المحددة (تطبّق على partner و van معاً)
  const stripSource = useVanStrip ? saved.stripVanWords : saved.stripWords;
  if (stripSource) {
    stripSource.split(/[\n,]/).forEach(word => {
      const w = word.trim();
      if (w) result = result.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").trim();
    });
  }

  return result.trim() || name;
}

// للتوافق مع الاستخدامات السابقة
function _cleanPartnerName(name) { return _cleanName(name, false); }
function _cleanVanName(name)     { return _cleanName(name, true);  }
// المجلد الأب لمواقع الفانات (كان GDS_VAN_LOCATION_PARENT = 212)
function _getVanLocationParent() {
  return _getActiveWarehouse()?.view_location_id?.[0] || null;
}

// موقع مصدر الـ préparation (مختار في الإعدادات، وإلا lot_stock_id)
function _getPrepSourceLocationId() {
  const wh = _getActiveWarehouse();
  if (!wh) return null;
  const saved = AppAuth.warehouseSettings?.[wh.id];
  return saved?.prepSourceId || wh.lot_stock_id?.[0] || null;
}

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
  if (!isAdmin() && !_hasTabPerm("transferts")) return;
  const el = document.getElementById("gdsTransfertsContent");
  if (!el) return;
  el.innerHTML = `<div class="gds-refresh-bar">
    <button class="gds-refresh-btn" data-perm="transferts_actualiser" onclick="renderGdsTransferts()">
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
          args: [[["location_id","=",_getVanLocationParent()],["usage","=","internal"]]],
          kwargs: { fields: ["id","name"], limit: 100 }
        }
      })
    });
    const locData = await resLoc.json();
    const vanIds = (locData?.result || []).map(l => l.id);
    const allIds = [...vanIds, _getStockLocationId()];

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
      const from  = t.location_id      ? _cleanVanName(t.location_id[1])      : "—";
      const to    = t.location_dest_id ? _cleanVanName(t.location_dest_id[1]) : "—";
      const partner = t.partner_id     ? t.partner_id[1]                               : "—";
      rows += `<tr>
        <td><span class="gds-tr-ref gds-tr-ref-full">${escHtml(t.name)}</span><span class="gds-tr-ref gds-tr-ref-short">${escHtml(t.name.split('/').pop())}</span></td>
        <td>${escHtml(from)}</td>
        <td>${escHtml(to)}</td>
        <td style="color:var(--text2)">${escHtml(partner)}</td>
        <td style="color:var(--text3)">${date}</td>
        <td><span class="gds-tr-state" style="background:${st.color}20;color:${st.color}">${st.label}</span></td>
        <td class="gds-tr-action-cell">
          <button class="gds-refresh-btn gds-tr-action-btn" onclick="window.open((ODOO_BASE||'')+'/web#id=${t.id}&action=233&active_id=76&model=stock.picking&view_type=form&cids=1&menu_id=115','_blank')">↗</button>
          <button class="gds-refresh-btn gds-tr-action-btn" style="background:var(--bg3);color:var(--text);" onclick="gdsShowPickingDetail(${t.id},'${escHtml(t.name)}')">☰</button>
          <button class="gds-refresh-btn gds-tr-action-btn" title="Copier la référence" style="background:var(--bg3);color:var(--text2);" onclick="(b=>{navigator.clipboard.writeText('${escHtml(t.name)}').then(()=>{b.textContent='✓';b.style.color='#22c55e';setTimeout(()=>{b.textContent='⎘';b.style.color='';},1200)})})(this)">⎘</button>
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
      <button class="gds-refresh-btn" data-perm="transferts_actualiser" onclick="renderGdsTransferts()">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/>
        </svg>
        Actualiser
      </button>
      <span class="gds-last-updated">Mis à jour : ${now} — ${transfers.length} transfert(s)</span>
    </div>
    <style>
      .gds-tr-ref-short { display:none; }
      .gds-tr-action-cell { display:flex; gap:4px; align-items:center; }
      .gds-tr-action-btn  { padding:2px 8px; }
      .gds-tr-date-input.flatpickr-input:not(.flatpickr-mobile) { display:none !important; }
      @media (max-width:600px) {
        .gds-tr-action-cell { flex-direction:column; gap:2px; }
        .gds-tr-action-btn  { padding:2px 4px; font-size:11px; }
        .gds-tr-table th, .gds-tr-table td { padding:3px 4px !important; font-size:10px; }
        .gds-tr-ref-full { display:none; }
        .gds-tr-ref-short { display:inline; }
        .gds-tr-state { padding:1px 4px !important; font-size:9px; }
      }
    </style>
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
    const baseUrl = ODOO_BASE;
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
        <th style="text-align:right">Colis</th>
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
      const name = m.product_id?.[1] || m.product_tmpl_id?.[1] || "—";
      const pid = m.product_id?.[0];
      const qty = m.product_uom_qty || 0;
      const pkgQty = pkgMap[pid] || 0;
      const cf = pkgQty > 0 ? Math.floor(qty / pkgQty) : "—";
      const u = pkgQty > 0 ? Math.round(qty % pkgQty) : qty;
      html += `<tr style="${dupProducts.has(pid) ? 'background:var(--bg3);' : ''}">
        <td>${escHtml(name)}</td>
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
  if (!isAdmin() && !_hasTabPerm("stock")) return;
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
          args: [[["location_id","=",_getStockLocationId()],["quantity",">",0]]],
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
          kwargs: { fields: ["id","name","default_code","categ_id","uom_id","uom_po_id"], limit: 2000 }
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
      byCategory[catName].push({ name: _productDisplayName(p), _ordre: _productCustomOrder(String(p.id)), qty: stockMap[pid].qty, carton: stockMap[pid].carton, reserved: stockMap[pid].reserved, unitSize: stockMap[pid].unitSize });
    });

    const now        = new Date().toLocaleTimeString("fr-FR");
    const sortedCats = _sortCats(Object.keys(byCategory));
    const collapsed  = _gdsGetCollapsed();

    let html = `<div class="gds-refresh-bar">
      <button class="gds-refresh-btn" data-perm="stock_actualiser" onclick="renderGdsStock()">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/>
        </svg>
        Actualiser
      </button>
      <button class="gds-refresh-btn" data-perm="stock_expand" onclick="gdsExpandAll()">▼ Tout ouvrir</button>
      <button class="gds-refresh-btn" data-perm="stock_collapse" onclick="gdsCollapseAll()">▲ Tout fermer</button>
      <span class="gds-last-updated">Mis à jour : ${now}</span>
    </div>`;
    sortedCats.forEach(cat => {
      const items     = byCategory[cat].sort((a,b) => a._ordre - b._ordre);
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
          <table class="gds-table" style="table-layout:fixed;width:100%">
            <colgroup>
              <col style="width:35%"/>
              <col style="width:65px"/>
              <col style="width:55px"/>
              <col style="width:40px"/>
              <col style="width:80px"/>
              <col style="width:60px"/>
              <col style="width:40px"/>
            </colgroup>
            <thead><tr>
              <th>Produit</th>
              <th style="text-align:right">Stock Colis</th>
              <th style="text-align:right">Stock U</th>
              <th style="text-align:right;font-size:9px;color:var(--text3)">qty</th>
              <th style="text-align:right">Réservé Colis</th>
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
          <td>${escHtml(item.name)}</td>
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
  if (!isAdmin() && !_hasTabPerm("vans")) return;
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
          args: [[["location_id","=",_getVanLocationParent()],["usage","=","internal"]]],
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
    const locIds = vanLocations.map(l => l.id).filter(id => id !== _getStockLocationId());
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
            kwargs: { fields: ["id","name","default_code","categ_id"], limit: 2000 }
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
      const carton = q.packaging_quantity_1 || 0;
      const unitSize = carton > 0 ? q.quantity / carton : 0;
      byVan[locId].categories[catName].push({
        name: _productDisplayName(p),
        qty: q.quantity,
        reserved: q.reserved_quantity || 0,
        carton,
        unitSize,
      });
    });

    const now = new Date().toLocaleTimeString("fr-FR");
    const collapsed = _gdsVansGetCollapsed();

    let html = `<div class="gds-refresh-bar">
      <button class="gds-refresh-btn" data-perm="vans_actualiser" onclick="renderGdsVans()">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/>
        </svg>
        Actualiser
      </button>
      <button class="gds-refresh-btn" data-perm="vans_expand" onclick="gdsVansExpandAll()">▼ Tout ouvrir</button>
      <button class="gds-refresh-btn" data-perm="vans_collapse" onclick="gdsVansCollapseAll()">▲ Tout fermer</button>
      <span class="gds-last-updated">Mis à jour : ${now}</span>
    </div>`;

    vanLocations.sort((a,b) => a.name.localeCompare(b.name)).filter(loc => {
  const cats = byVan[loc.id]?.categories || {};
  return Object.values(cats).some(arr => arr.length > 0);
}).forEach(loc => {
      const van = byVan[loc.id];
      const vanId = String(loc.id);
      const isCollapsed = !!collapsed[vanId];
      const cats = _sortCats(Object.keys(van.categories));
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
            <table class="gds-table" style="table-layout:fixed;width:100%">
              <colgroup>
                <col style="width:35%"/>
                <col style="width:65px"/>
                <col style="width:55px"/>
                <col style="width:40px"/>
                <col style="width:80px"/>
                <col style="width:60px"/>
                <col style="width:40px"/>
              </colgroup>
              <thead><tr>
                <th>Produit</th>
                <th style="text-align:right">Stock Colis</th>
                <th style="text-align:right">Stock U</th>
                <th style="text-align:right;font-size:9px;color:var(--text3)">qty</th>
                <th style="text-align:right">Réservé Colis</th>
                <th style="text-align:right">Réservé U</th>
                <th style="text-align:right;font-size:9px;color:var(--text3)">qty</th>
              </tr></thead>
              <tbody>`;
          items.forEach(item => {
            const carton    = Math.floor(item.carton);
            const unite     = item.unitSize > 0 ? Math.round(item.qty % item.unitSize) : Math.round(item.qty);
            const resCarton = item.unitSize > 0 ? Math.floor(item.reserved / item.unitSize) : 0;
            const resUnite  = item.unitSize > 0 ? Math.round(item.reserved % item.unitSize) : Math.round(item.reserved);
            html += `<tr>
              <td>${escHtml(item.name)}</td>
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

function _hasTabPerm(tab) {
  const permMap = {
    stock: "tab_stock", vans: "tab_vans",
    transferts: "tab_transferts", preparation: "tab_preparation", stockfinal: "tab_stockfinal"
  };
  const perm = permMap[tab];
  if (!perm || !_permCache) return true;
  const section = _permSectionMap()[perm];
  const role = AppAuth.currentUser?.role;
  if (!section || !role) return true;
  const allowed = _decodePerm(_permCache[section]?.[role]);
  return allowed === undefined || allowed.includes(perm);
}

function _canOverstock() {
  if (typeof isAdmin === "function" && isAdmin()) return App.settings?.allowOverstock === true;
  if (!_permCache) return false;
  const role = AppAuth.currentUser?.role;
  if (!role) return false;
  const allowed = _decodePerm(_permCache["gds_preparation"]?.[role]);
  return allowed === undefined || allowed.includes("prep_overstock");
}

async function gdsShowTab(tab) {
  if (!isAdmin() && !_hasTabPerm(tab)) return;
  const stockEl     = document.getElementById("gdsContent");
  const vansEl      = document.getElementById("gdsVansContent");
  const trEl        = document.getElementById("gdsTransfertsContent");
  const prepEl      = document.getElementById("gdsPreparationContent");
  const sfEl        = document.getElementById("gdsStockFinalContent");
  const btnStock    = document.getElementById("gdsTabStock");
  const btnVans     = document.getElementById("gdsTabVans");
  const btnTr       = document.getElementById("gdsTabTransferts");
  const btnPrep     = document.getElementById("gdsTabPreparation");
  const btnSF       = document.getElementById("gdsTabStockFinal");

  [stockEl, vansEl, trEl, prepEl, sfEl].forEach(e => { if (e) e.style.display = "none"; });
  [btnStock, btnVans, btnTr, btnPrep, btnSF].forEach(b => b?.classList.remove("gds-tab--active"));

  if (tab === "stock") {
    if (stockEl) stockEl.style.display = "";
    btnStock?.classList.add("gds-tab--active");
    if (!stockEl?.innerHTML || stockEl.innerHTML.trim() === "" || stockEl.innerHTML.includes("Chargement")) renderGdsStock();
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
    await renderGdsPreparation();
  } else if (tab === "stockfinal") {
    if (sfEl) sfEl.style.display = "";
    btnSF?.classList.add("gds-tab--active");
    if (typeof sfRenderFromCache === "function") sfRenderFromCache();
  }
}

// ── Stock Final XLSX export ───────────────────────────────────
function exportStockFinalXlsx(vendorLabel, lines) {
  const title    = `STOCK FINAL: ${vendorLabel}`;
  const today    = new Date().toLocaleDateString("fr-FR");
  const filtered = lines.filter(l => l.qty > 0);

  if (typeof XLSX !== "undefined") {
    const wb  = XLSX.utils.book_new();
    const aoa = [];
    aoa.push([`${title} (${today})`, "", ""]);
    aoa.push([]);
    aoa.push(["Article", "CDN", "Quantité"]);
    filtered.forEach(l => {
      const cdn = l.packaging_qty > 0 ? +(l.qty / l.packaging_qty).toFixed(2) : "";
      aoa.push([l.name, cdn, l.qty]);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const maxLen = Math.max(7, ...filtered.map(l => l.name.length));
    ws["!cols"] = [{ wch: Math.min(maxLen * 1.05, 80) }, { wch: 10 }, { wch: 12 }];
    ws["!merges"] = [{ s:{r:0,c:0}, e:{r:0,c:2} }];
    XLSX.utils.book_append_sheet(wb, ws, "Stock Final");
    XLSX.writeFile(wb, `stock_final_${vendorLabel.replace(/\s+/g,"_")}.xlsx`);
  } else {
    let csv = `"${title} (${today})"\n\nArticle,CDN,Quantité\n`;
    filtered.forEach(l => {
      const cdn = l.packaging_qty > 0 ? +(l.qty / l.packaging_qty).toFixed(2) : "";
      csv += `"${l.name}",${cdn},${l.qty}\n`;
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\uFEFF"+csv], {type:"text/csv;charset=utf-8;"}));
    a.download = `stock_final_${vendorLabel.replace(/\s+/g,"_")}.csv`;
    a.click();
  }
}
function exportStockFinalPdf(vendorLabel, lines) {
  const title = `STOCK FINAL: ${vendorLabel}`;
  const today = new Date().toLocaleDateString("fr-FR");
  const filtered = lines.filter(l => l.qty > 0);
  function _load(cb) {
    if (window.jspdf) { cb(); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    s.onload = () => {
      const s2 = document.createElement("script");
      s2.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js";
      s2.onload = cb;
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
  }
  _load(() => {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    doc.setFontSize(13); doc.setFont(undefined, "bold");
    doc.text(`${title} (${today})`, 14, 15);
    doc.autoTable({
      startY: 22,
      head: [["Article", "CDN", "Quantité"]],
      body: filtered.map(l => {
        const cdn = l.packaging_qty > 0 ? +(l.qty / l.packaging_qty).toFixed(2) : "";
        return [l.name, cdn, l.qty];
      }),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [26, 107, 58] },
      columnStyles: { 1: { halign: "center" }, 2: { halign: "center" } },
    });
    doc.save(`stock_final_${vendorLabel.replace(/\s+/g, "_")}.pdf`);
  });
}
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
 includedPickings: [], // references INCLUS au calcul (nouveau système toggle, défaut = tout exclu)
  outOfDateTransferts: [], // transferts hors date ajoutés manuellement
};

function _getPrepStorageKey() {
  const whId = _getWarehouseId() || "default";
  return `wafa_gds_preparation_${whId}`;
}

function _productDisplayName(p, { useCustom = false } = {}) {
  if (!p) return "—";
  const code = (p.default_code || "").toUpperCase();
  const name = p.name || "";
  const colorMap = { "BLEU": "BLEU", "VERT": "VERT", "ROSE": "ROSE", "ROUGE": "ROUGE", "JAUNE": "JAUNE" };
  let odooName = name;
  for (const [key, label] of Object.entries(colorMap)) {
    if (code.includes(key) && !name.toUpperCase().includes(key)) {
      odooName = `${name} (${label})`;
      break;
    }
  }
  if (!useCustom) return odooName;
  const map = _getProdNamesMap();
  return map[p.id]?.nom || odooName;
}

// ── Noms & Ordre personnalisés des produits ───────────────────
const _PROD_NAMES_FB_KEY = "product_display_map";

function _getProdNamesMap() {
  return App.settings?.productNamesMap || {};
}

function _productCustomName(pid, originalName) {
  const map = _getProdNamesMap();
  return map[pid]?.nom || originalName;
}

function _productCustomOrder(pid) {
  const map = _getProdNamesMap();
  return map[String(pid)]?.ordre ?? 9999;
}

async function _initProduitNamesModal() {
  const statusEl  = document.getElementById("prodNamesStatus");
  const previewEl = document.getElementById("prodNamesPreview");
  const map = _getProdNamesMap();
  const count = Object.keys(map).length;
  if (statusEl) statusEl.textContent = count > 0 ? `${count} produits configurés` : "Aucune configuration importée";
  if (previewEl) {
    if (count === 0) { previewEl.innerHTML = ""; return; }
    const rows = Object.entries(map).slice(0, 50).map(([pid, v]) =>
      `<div style="display:flex;gap:8px;padding:3px 0;border-bottom:1px solid var(--border);">
        <span style="color:var(--text3);min-width:40px;">#${pid}</span>
        <span style="min-width:30px;text-align:center;">${v.ordre}</span>
        <span>${v.nom}</span>
      </div>`
    ).join("");
    previewEl.innerHTML = `
      <div style="display:flex;gap:8px;padding:3px 0;font-weight:700;font-size:10px;color:var(--text2);border-bottom:2px solid var(--border);margin-bottom:4px;">
        <span style="min-width:40px;">ID</span>
        <span style="min-width:30px;">Ordre</span>
        <span>Nom affiché</span>
      </div>${rows}
      ${count > 50 ? `<div style="color:var(--text3);margin-top:4px;">… et ${count-50} autres</div>` : ""}`;
  }

  
}

async function _downloadProdTemplate() {
  const statusEl = document.getElementById("prodNamesStatus");
  if (statusEl) statusEl.textContent = "Chargement des produits…";

  try {
    // جلب كل المنتجات من Odoo
    const res = await fetch("/api/web/dataset/call_kw", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc:"2.0", method:"call", id: Date.now(),
        params: {
          model: "product.product", method: "search_read",
          args: [[["active","=",true]]],
          kwargs: { fields: ["id","name","default_code","categ_id"], limit: 5000 }
        }
      })
    });
    const j = await res.json();
    const products = j?.result || [];
    if (!products.length) { if (statusEl) statusEl.textContent = "Aucun produit trouvé"; return; }

    const map = _getProdNamesMap();
    const wb = XLSX.utils.book_new();
    const rows = [["id", "nom_odoo", "nom_affiche", "ordre"]];
    products.forEach((p, i) => {
      const existing = map[p.id];
      rows.push([
        p.id,
        _productDisplayName(p),
        existing?.nom || _productDisplayName(p),
        existing?.ordre ?? (i + 1)
      ]);
    });
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 8 }, { wch: 40 }, { wch: 40 }, { wch: 8 }];
    XLSX.utils.book_append_sheet(wb, ws, "Produits");
    XLSX.writeFile(wb, "produits_template.xlsx");
    if (statusEl) statusEl.textContent = `${products.length} produits exportés`;
  } catch(e) {
    console.error(e);
    if (statusEl) statusEl.textContent = "Erreur lors du chargement";
  }
}

async function _onProdNamesFileImport(input) {
  const file = input.files?.[0];
  if (!file) return;
  const statusEl = document.getElementById("prodNamesStatus");
  if (statusEl) statusEl.textContent = "Importation…";

  try {
    const buf  = await file.arrayBuffer();
    const wb   = XLSX.read(buf, { type: "array" });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

    const map = {};
    rows.forEach((row, i) => {
      const pid  = parseInt(row["id"]);
      const nom  = String(row["nom_affiche"] || row["nom_odoo"] || "").trim();
      const ordre = parseInt(row["ordre"]) || (i + 1);
      if (!pid || !nom) return;
      map[pid] = { nom, ordre };
    });

    App.settings.productNamesMap = map;
    await Storage.saveSettings(App.settings);
    // حفظ في Firebase
    try {
      await fetch(`${_FB_DB_URL}/${_PROD_NAMES_FB_KEY}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(map)
      });
    } catch(_) {}

    input.value = "";
    const count = Object.keys(map).length;
    if (statusEl) statusEl.textContent = `✓ ${count} produits importés`;
    // تحديث أسماء الـ lines الحالية في الـ prep
    if (_gdsPrep?.lines?.length) {
      _gdsPrep.lines.forEach(l => {
        l.name = map[l.pid]?.nom || l._origName || l.name;
      });
      _gdsPrepRenderTable();
    }
    _initProduitNamesModal();
    addNotif(`Noms produits mis à jour (${count})`, "success");
  } catch(e) {
    console.error(e);
    if (statusEl) statusEl.textContent = "Erreur lors de l'importation";
  }
}

async function _resetProdNames() {
  if (!confirm("Réinitialiser tous les noms personnalisés ?")) return;
  App.settings.productNamesMap = {};
  await Storage.saveSettings(App.settings);
  try {
    await fetch(`${_FB_DB_URL}/${_PROD_NAMES_FB_KEY}.json`, { method: "DELETE" });
  } catch(_) {}
  _initProduitNamesModal();
  addNotif("Noms réinitialisés", "success");
}

// ── Firebase Realtime Database ────────────────────────────────
// const _FB_DB_URL = "https://owdoo-f265f-default-rtdb.europe-west1.firebasedatabase.app";
function _getFbPrepKey() {
  const whId = _getWarehouseId() || "default";
  return `wafa_gds_preparation_${whId}`;
}

let _gdsPrepSaving = false;

async function _gdsPrepSaveCloud() {
  _gdsPrepSaving = true;
  try {
    // 1) جلب النسخة الحالية من Cloud
    let remote = null;
    try {
      const res = await fetch(`${_FB_DB_URL}/${_getFbPrepKey()}.json`);
      remote = await res.json();
    } catch(_) {}

    // 2) دمج الـ lines: الأحدث _ts يفوز، مع دمج history دائماً
    let mergedLines = _gdsPrep.lines.map(local => {
      if (!remote?.lines) return local;
      const rem = remote.lines.find(r => r.pid === local.pid);
      if (!rem) return local;
      // الأحدث يفوز بالقيم (prepCarton, prepUnite, ...)
      const base = (local._ts || 0) >= (rem._ts || 0)
        ? { ...rem, ...local }
        : { ...local, ...rem };
      // دمج history دائماً بدون تكرار
      const allHist = [...(local.history || []), ...(rem.history || [])];
      const seen = new Set();
      base.history = allHist.filter(h => {
        const k = `${h.ts}|${h.type}|${h.carton}|${h.unite}|${h.by}`;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
      base._ts = Math.max(local._ts || 0, rem._ts || 0);
      return base;
    });

    // 3) أضف lines الموجودة في remote فقط (غير موجودة locally)
    if (remote?.lines) {
      remote.lines.forEach(rem => {
        if (!mergedLines.find(l => l.pid === rem.pid)) mergedLines.push(rem);
      });
    }

    // 4) دمج includedPickings و outOfDateTransferts (union)
    const mergeArr = (a, b) => [...new Set([...(a||[]), ...(b||[])])];

    const data = {
      lines:               mergedLines,
      loaded:              _gdsPrep.loaded,
	  finished: 		   _gdsPrep.finished,
      chargeFrom:          _gdsPrep.chargeFrom || remote?.chargeFrom || null,
      chargeTo:            _gdsPrep.chargeTo   || remote?.chargeTo   || null,
      chargeData:          _gdsPrep.chargeData,
      pickingsMap:         _gdsPrep.pickingsMap,
      byPicking:           _gdsPrep.byPicking,
      includedPickings:    _gdsPrep.includedPickings,
      outOfDateTransferts: mergeArr(_gdsPrep.outOfDateTransferts, remote?.outOfDateTransferts),
      date:                new Date().toISOString().slice(0, 10),
      savedBy:             AppAuth.currentUser?.username || "inconnu",
    };

    // 5) تحديث الحالة المحلية بالبيانات المدمجة
    _gdsPrep.lines               = mergedLines;
    _gdsPrep.includedPickings    = data.includedPickings || [];
    _gdsPrep.outOfDateTransferts = data.outOfDateTransferts;

    await fetch(`${_FB_DB_URL}/${_getFbPrepKey()}.json`, {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(data),
    });
  } catch(e) { console.error("[GdsPrep] saveCloud:", e); }
  finally { _gdsPrepSaving = false; }
}

async function _gdsPrepLoadFromCloud() {
  if (_gdsPrepSaving) return false;
  try {
    const res  = await fetch(`${_FB_DB_URL}/${_getFbPrepKey()}.json`);
    const data = await res.json();
    if (!data) return false;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);
    if (data.date !== today && data.date !== yesterdayStr) return false;
    _gdsPrep.lines = (data.lines || []).map(line => {
      if (!line.unitSize && line.carton > 0) line.unitSize = line.qty / line.carton;
      return line;
    });
    _gdsPrep.loaded     = data.loaded     || false;
    _gdsPrep.finished   = data.finished   || false;
    _gdsPrep.chargeFrom = data.chargeFrom || null;
    _gdsPrep.chargeTo   = data.chargeTo   || null;
    _gdsPrep.chargeData = {};
    Object.entries(data.chargeData || {}).forEach(([pid, ch]) => {
      const line = _gdsPrep.lines.find(l => l.pid === Number(pid));
      const u    = line ? _gdsPrepUnitSize(line) : 0;
      _gdsPrep.chargeData[Number(pid)] = {
        chargeCarton: u > 0 ? Math.floor(ch.chargeTotal / u) : 0,
        chargeUnite:  u > 0 ? Math.round(ch.chargeTotal % u) : Math.round(ch.chargeTotal),
        chargeTotal:  ch.chargeTotal,
      };
    });
    _gdsPrep.pickingsMap         = data.pickingsMap         || {};
    _gdsPrep.byPicking           = data.byPicking           || {};
    _gdsPrep.includedPickings    = data.includedPickings    || [];
    _gdsPrep.outOfDateTransferts = data.outOfDateTransferts || [];
    _gdsPrep.savedBy = data.savedBy || "";
    return true;
  } catch(e) { console.error("[GdsPrep] loadCloud:", e); return false; }
}

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
    const now = Date.now();
    _gdsPrep.lines.forEach(l => { if (!l._ts) l._ts = now; });
    const data = {
      lines:               _gdsPrep.lines,
      loaded:              _gdsPrep.loaded,
      finished:            _gdsPrep.finished,
      chargeFrom:          _gdsPrep.chargeFrom,
      chargeTo:            _gdsPrep.chargeTo,
      chargeData:          _gdsPrep.chargeData,
      pickingsMap:         _gdsPrep.pickingsMap,
      byPicking:           _gdsPrep.byPicking,
      includedPickings:    _gdsPrep.includedPickings,
      outOfDateTransferts: _gdsPrep.outOfDateTransferts,
      date:                new Date().toISOString().slice(0, 10),
    };
    localStorage.setItem(_getPrepStorageKey(), JSON.stringify(data));
    _gdsPrepSaveCloud();
  } catch(e) { console.error("[GdsPrep] save:", e); }
}

function _gdsPrepLoadFromStorage() {
  try {
    const raw = localStorage.getItem(_getPrepStorageKey());
    if (!raw) return;
    const data = JSON.parse(raw);
    const today = new Date().toISOString().slice(0, 10);
    const yesterday2 = new Date(); yesterday2.setDate(yesterday2.getDate() - 1);
    const yesterdayStr2 = yesterday2.toISOString().slice(0, 10);
    if (data.date !== today && data.date !== yesterdayStr2) return; // données d'un autre jour, on ignore
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
    _gdsPrep.includedPickings    = data.includedPickings    || [];
    _gdsPrep.outOfDateTransferts = data.outOfDateTransferts || [];
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
  if (line.unitSize > 0) return Math.round(line.unitSize);
  if (line.carton > 0 && line.qty > 0) return Math.round(line.qty / line.carton);
  // استخراج unitSize من byPicking إذا كان المخزون صفر
  const byP = _gdsPrep.byPicking || {};
  for (const picking of Object.values(byP)) {
    const mv = (picking.moves || []).find(m => m.pid === line.pid);
    if (mv && mv.unitSize > 0) return Math.round(mv.unitSize);
  }
  return 0;
}
function _gdsPrepTotalPrep(line) {
  const u = _gdsPrepUnitSize(line);
  return line.prepCarton * u + line.prepUnite;
}

// ── render conteneur principal ────────────────────────────────
async function renderGdsPreparation() {
  if (!isAdmin() && !_hasTabPerm("preparation")) return;
  const el = document.getElementById("gdsPreparationContent");
  if (!el) return;

  const _cloudLoaded = _gdsPrep._skipCloudReload ? false : await _gdsPrepLoadFromCloud();
  _gdsPrep._skipCloudReload = false;
  if (!_cloudLoaded) {
    _gdsPrepLoadFromStorage();
  } else {
    try { localStorage.setItem(_getPrepStorageKey(), JSON.stringify({
      lines: _gdsPrep.lines, loaded: _gdsPrep.loaded, finished: _gdsPrep.finished,
      chargeFrom: _gdsPrep.chargeFrom, chargeTo: _gdsPrep.chargeTo,
      chargeData: _gdsPrep.chargeData, pickingsMap: _gdsPrep.pickingsMap,
      byPicking: _gdsPrep.byPicking, includedPickings: _gdsPrep.includedPickings,
      outOfDateTransferts: _gdsPrep.outOfDateTransferts,
      date: new Date().toISOString().slice(0,10)
    })); } catch(_) {}
    _gdsPrepUpdateOutOfDateBtn();
  }
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
        ? `<button class="gds-refresh-btn" data-perm="prep_reprendre" onclick="gdsPrepReprendre()">↩ Reprendre</button>
           <span class="gds-refresh-btn" style="background:var(--green);cursor:default;">✓ Terminée</span>`
        : `<button class="gds-refresh-btn" data-perm="prep_modifier" onclick="gdsPrepOpenModal(true)">
             <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
               <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
               <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
             </svg>
             Modifier
           </button>
           <button class="gds-refresh-btn gds-prep-finish-btn" data-perm="prep_terminer" onclick="gdsPrepAskFinish()">✓ Terminer</button>
<button class="gds-refresh-btn" data-perm="prep_annuler" style="background:var(--red);margin-left:4px;" onclick="gdsPrepAskCancel()">✕ Annuler</button>
           <button class="gds-refresh-btn" data-perm="prep_rapport" style="background:var(--accent);margin-left:4px;" onclick="gdsPrepExportCurrent()" title="Télécharger rapport actuel">⬇ Rapport</button>`    ) : `<button class="gds-refresh-btn" data-perm="prep_nouvelle" onclick="gdsPrepOpenModal()">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Nouvelle préparation
      </button>`}
    <span class="gds-last-updated" id="gdsPrepStatus">
  <!--    ${hasData ? _gdsPrep.lines.length + " produits" : ""}-->
    </span>
    <div id="gdsPrepNewBar" style="display:none;">
      <button class="gds-refresh-btn" data-perm="prep_rapport" style="background:var(--accent);" onclick="gdsPrepExportCurrent()">⬇ Rapport</button>
      <button class="gds-refresh-btn" data-perm="prep_nouvelle" style="background:var(--gds-color);" onclick="gdsPrepAskNew()">
        + Nouvelle préparation
      </button>
    </div>
    ${hasData && App.settings?.showPrepSearch !== false ? `
    <div id="gdsPrepSearchFloatWrap" style="position:fixed;bottom:18px;right:18px;z-index:999;display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
      <div id="gdsPrepSearchPopup" style="display:none;align-items:center;gap:6px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:6px 10px;box-shadow:0 4px 20px rgba(0,0,0,.5);">
        <input id="gdsPrepSearchInput" type="text" placeholder="Rechercher…"
          oninput="_gdsPrepApplySearch(this.value)"
          style="width:180px;max-width:55vw;padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text1);font-size:13px;outline:none;"/>
        <button id="gdsPrepSearchClear" onclick="_gdsPrepClearSearch()" title="Effacer"
          style="font-size:13px;padding:2px 8px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text3);cursor:pointer;">✕</button>
      </div>
      <button id="gdsPrepSearchBtn" onclick="_gdsPrepToggleSearch()" title="Rechercher"
        style="width:44px;height:44px;border-radius:50%;background:var(--gds-color);border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.4);">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </button>
    </div>` : ""}
    ${hasData ? `<div style="position:relative;">
      <button onclick="_gdsPrepToggleColPanel('__global__')" style="font-size:9px;padding:2px 8px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text3);cursor:pointer;display:flex;align-items:center;gap:4px;">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>Col
      </button>
      <div id="gdsPrepColPanel___global__" style="display:none;position:absolute;top:100%;right:0;z-index:200;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;flex-direction:column;gap:6px;min-width:160px;box-shadow:0 4px 16px rgba(0,0,0,.5);">
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
    </div>` : ""}
</div>
  <!-- Barre chargement depuis -->
<div style="display:${_gdsPrep.loaded && !_gdsPrep.finished ? 'flex' : 'none'};align-items:center;gap:8px;padding:6px 10px;background:var(--bg2);border-bottom:1px solid var(--border);flex-wrap:wrap;position:sticky;top:41px;z-index:18;margin-top:-1px;">
    <span data-perm="prep_depuis_a" style="font-size:11px;font-weight:600;color:var(--text2);">Depuis :</span>
    <input data-perm="prep_depuis_a" type="text" id="gdsPrepChargeFrom" class="gds-prep-dt-input"
      placeholder="jj/mm/aaaa hh:mm"
      style="width:130px;min-width:0;cursor:pointer;"/>
    <span data-perm="prep_depuis_a" style="font-size:11px;font-weight:600;color:var(--text2);">A :</span>
    <input data-perm="prep_depuis_a" type="text" id="gdsPrepChargeTo" class="gds-prep-dt-input"
      placeholder="jj/mm/aaaa hh:mm"
      style="width:130px;min-width:0;cursor:pointer;"/>
    <button class="gds-refresh-btn" data-perm="prep_charge_actualiser" onclick="gdsPrepFetchCharge()" style="gap:4px;">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/>
      </svg>
      Actualiser
    </button>
    <span class="gds-last-updated" id="gdsPrepChargeStatus"></span>
    <button class="gds-refresh-btn" data-perm="prep_hors_date" id="gdsPrepOutOfDateBtn" onclick="_gdsPrepShowOutOfDateList()" style="padding:2px 8px;font-size:11px;background:var(--orange,#f59e0b);opacity:${_gdsPrep.outOfDateTransferts.length ? '1' : '0.4'};cursor:${_gdsPrep.outOfDateTransferts.length ? 'pointer' : 'default'};" ${_gdsPrep.outOfDateTransferts.length ? '' : 'disabled'}>Hors date (${_gdsPrep.outOfDateTransferts.length})</button>
    <button class="gds-refresh-btn" data-perm="prep_hors_date_add" onclick="_gdsPrepShowOutOfDateInput()" style="padding:2px 8px;font-size:11px;background:var(--orange,#f59e0b);" title="Ajouter transfert hors date">+</button>
    
  </div>
  <div style="display:flex;align-items:flex-start;gap:0;">
    <div id="gdsPrepTableWrap" style="flex:1;min-width:0;padding:0 10px 20px;overflow-x:auto;-webkit-overflow-scrolling:touch;"></div>
    <div id="gdsPrepPickingPanel" class="gds-prep-picking-panel">
      <div id="gdsPrepPickingBtns" class="gds-prep-picking-panel-inner">
        ${_gdsPrepRenderPickingBtns()}
      </div>
    </div>
  </div>

  <!-- Barre Nouvelle préparation (visible après check complet) -->
  

  <!-- Modal confirmation nouvelle préparation -->
  <div id="gdsPrepNewConfirmModal" class="gds-prep-modal" style="display:none;">
    <div class="gds-prep-modal-box" style="max-width:340px;text-align:center;">
      <div class="gds-prep-modal-header"><span>Nouvelle préparation</span></div>
      <div style="padding:20px 16px;font-size:13px;color:var(--text);">
        Un fichier PDF sera téléchargé et toutes les données seront effacées.<br>
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
      <div class="gds-prep-modal-body" id="gdsPrepModalBody" style="overflow-x:auto;-webkit-overflow-scrolling:touch;">
        <div class="gds-loading">جارٍ التحميل…</div>
      </div>
      <div class="gds-prep-modal-footer">
        <button class="gds-refresh-btn" onclick="gdsPrepModalConfirm()">↵ Confirmer</button>
        <button id="gdsPrepAutoFillBtn" class="gds-refresh-btn" style="background:var(--accent);display:none;" onclick="gdsPrepAutoFill()" title="Remplir selon suggestions +20%">▢ Propos</button>
		<button class="gds-refresh-btn" style="background:var(--text2);" onclick="gdsPrepDownloadPrepPdf()" title="Télécharger la préparation en PDF">🖨 Imprimer</button>
        <button class="gds-refresh-btn" style="background:var(--red);margin-left:auto;" onclick="gdsPrepAskReset()">⊘ Réinitialiser</button>
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

  <!-- Modal réinitialisation -->
  <div id="gdsPrepResetModal" class="gds-prep-modal" style="display:none;">
    <div class="gds-prep-modal-box" style="max-width:320px;text-align:center;">
      <div class="gds-prep-modal-header"><span>Réinitialiser</span></div>
      <div style="padding:20px 16px;font-size:13px;color:var(--text);">
        Toutes les quantités seront remises à zéro.<br>Confirmer ?
      </div>
      <div class="gds-prep-modal-footer" style="justify-content:center;gap:8px;">
        <button class="gds-refresh-btn" style="background:var(--red);" onclick="gdsPrepDoReset()">⊘ Confirmer</button>
        <button class="gds-refresh-btn" style="background:var(--text3);" onclick="gdsPrepCloseReset()">Annuler</button>
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
        _gdsPrep.includedPickings    = [];
        _gdsPrep.outOfDateTransferts = [];
        _gdsPrepUpdateOutOfDateBtn();
        _gdsPrepSave();
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
        _gdsPrep.includedPickings    = [];
        _gdsPrep.outOfDateTransferts = [];
        _gdsPrepUpdateOutOfDateBtn();
        _gdsPrepSave();
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
  _sortCats(Object.keys(byCateg)).forEach(cat => {
    const lines = byCateg[cat];
    rows += `<tr class="cat-row"><td colspan="3">${cat}</td></tr>`;
    lines.forEach(line => {
      rows += `<tr>
        <td>${_productCustomName(line.pid, line.name)}</td>
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
    <thead><tr><th>Produit</th><th class="num">Colis</th><th class="num">U</th></tr></thead>
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

 const allRows = [];
  _sortCats(Object.keys(byCateg)).forEach(cat => {
    const lines = byCateg[cat];
    allRows.push({ isCat: true, cat });
    lines.forEach(line => allRows.push({ isCat: false, line }));
  });

  const half   = Math.ceil(allRows.length / 2);
  const left   = allRows.slice(0, half);
  const right  = allRows.slice(half);

  function buildRows(arr) {
    return arr.map(r => r.isCat
      ? `<tr class="cat-row"><td colspan="3">${r.cat}</td></tr>`
      : `<tr>
          <td>${_productCustomName(r.line.pid, r.line.name)}</td>
          <td class="num">${r.line.prepCarton > 0 ? r.line.prepCarton : "—"}</td>
          <td class="num">${r.line.prepUnite  > 0 ? r.line.prepUnite  : "—"}</td>
        </tr>`
    ).join("");
  }

  function buildCol(arr, label) {
    return `
      <div class="copy-header">
        <strong>STOCK PRÉPARATION</strong>
        <span class="sub">${label} — ${date} — ${time}</span>
      </div>
      <table>
        <thead><tr><th>Produit</th><th class="num">Colis</th><th class="num">U</th></tr></thead>
        <tbody>${buildRows(arr)}</tbody>
      </table>`;
  }

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 10px; margin: 6mm; color: #000; }
    .wrapper { display: flex; gap: 5mm; align-items: flex-start; }
    .col { width: calc(50% - 2.5mm); border-right: 1px dashed #aaa; padding-right: 4mm; }
    .col:last-child { border-right: none; padding-right: 0; }
    .copy-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 3mm; }
    .copy-header strong { font-size: 11px; }
    .sub { font-size: 9px; color: #555; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f0f0f0; border: 1px solid #ccc; padding: 2px 4px; font-size: 9px; text-align: left; }
    td { border: 1px solid #ddd; padding: 2px 4px; font-size: 10px; word-break: break-word; white-space: normal; }
    .num { text-align: center; width: 28px; font-weight: bold; font-size: 11px; }
    th.num { font-size: 9px; font-weight: normal; }
    .cat-row td { background: #e8f5e9; font-weight: bold; font-size: 9px; color: #2e7d32; }
  </style></head><body>
  <div class="wrapper">
    <div class="col">${buildCol(left, "1/2")}</div>
    <div class="col">${buildCol(right, "2/2")}</div>
  </div>
  </body></html>`;

  const today = new Date();
  const dd    = String(today.getDate()).padStart(2,"0");
  const mm    = String(today.getMonth()+1).padStart(2,"0");
  const yyyy  = today.getFullYear();
  _downloadAsPdf(html, `preparation_gds_${dd}-${mm}-${yyyy}`);
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
        args:[[["location_id","=",_getStockLocationId()],["quantity",">",0]]],
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
        kwargs:{ fields:["id","name","default_code","categ_id","uom_id"], limit:2000 }
      }})
    });
    const prods = {};
    ((await r2.json())?.result || []).forEach(p => { prods[p.id] = p; });

   // جلب packaging CARTON لكل المنتجات
    const r3 = await fetch("/api/web/dataset/call_kw", {
      method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:3, params:{
        model:"product.packaging", method:"search_read",
        args:[[["product_id","in",pids]]],
        kwargs:{ fields:["product_id","qty"], limit:2000 }
      }})
    });
    const packagingMap = {};
    ((await r3.json())?.result || []).forEach(pk => { packagingMap[pk.product_id[0]] = pk.qty; });

    _gdsPrep.lines = [];
    quants.forEach(q => {
      const pid = q.product_id[0]; const p = prods[pid]; if (!p) return;
      const pkgCarton = q.packaging_quantity_1 || 0;
      const unitSize  = packagingMap[q.product_id[0]] > 0 ? packagingMap[q.product_id[0]] : (pkgCarton > 0 ? q.quantity / pkgCarton : 0);
      const ex = _gdsPrep.lines.find(l => l.pid === pid);
      if (ex) {
        ex.qty    += q.quantity;
        ex.carton += pkgCarton;
        if (ex.unitSize === 0 && unitSize > 0) ex.unitSize = unitSize;
      } else {
        _gdsPrep.lines.push({ pid, name:_productDisplayName(p, {useCustom:true}), _origName:_productDisplayName(p, {useCustom:false}),
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
      if (line.unitSize === 0) line.unitSize = packagingMap[line.pid] || (line.carton > 0 ? line.qty / line.carton : 0);
    });
   _gdsPrep.lines.sort((a,b) => {
      const order = _getCatOrder();
      if (order.length) {
        const ia = order.indexOf(a.categ), ib = order.indexOf(b.categ);
        const ca = ia === -1 ? 9999 : ia, cb = ib === -1 ? 9999 : ib;
        if (ca !== cb) return ca - cb;
      } else {
        const cmp = a.categ.localeCompare(b.categ);
        if (cmp !== 0) return cmp;
      }
      // ترتيب مخصص داخل الفئة
      const oa = _productCustomOrder(a.pid), ob = _productCustomOrder(b.pid);
      if (oa !== ob) return oa - ob;
      return a.name.localeCompare(b.name);
    });
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

  let html = `<div style="display:none;justify-content:flex-end;margin-bottom:6px;position:relative;">
    <button onclick="_gdsPrepToggleColPanel('__global__')" style="font-size:9px;padding:2px 8px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text3);cursor:pointer;display:flex;align-items:center;gap:4px;">
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>Col
    </button>
    <div id="gdsPrepColPanel___global__" style="display:none;position:absolute;top:100%;right:0;z-index:200;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;flex-direction:column;gap:6px;min-width:160px;box-shadow:0 4px 16px rgba(0,0,0,.5);">
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
  </div>`;
  _sortCats(Object.keys(byCateg)).forEach(cat => {
    const collapsed = !!_gdsPrep.collapsed["modal_" + cat];
    html += `<div class="gds-prep-modal-cat gds-category-toggle" style="cursor:pointer;" onclick="_gdsPrepToggleModalCat('${escHtml(cat)}')">
      <svg class="gds-collapse-arrow" style="transition:transform .2s;transform:${collapsed?"rotate(-90deg)":""}" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"/></svg>
      ${escHtml(cat)}
    </div>
    <div id="gdsPrepModalCat_${escHtml(cat)}" style="display:${collapsed?"none":""}">
    <div style="-webkit-overflow-scrolling:touch;">
    <table class="gds-table ${isEdit ? "edit-mode" : ""}" style="margin-bottom:10px;">
      <thead><tr>
        <th style="min-width:80px;">Produit</th>
        <th style="text-align:right;white-space:nowrap;font-size:9px;padding:4px 3px;">Stock.C</th>
        <th style="text-align:right;white-space:nowrap;font-size:9px;padding:4px 3px;">Stock.U</th>
        ${isEdit
          ? `<th style="text-align:right;white-space:nowrap;font-size:9px;padding:4px 3px;">Prepa.C</th><th style="text-align:right;white-space:nowrap;font-size:9px;padding:4px 3px;">Prepa.U</th>
             <th style="text-align:right;white-space:nowrap;font-size:9px;padding:4px 3px;">Reste.C</th><th style="text-align:right;white-space:nowrap;font-size:9px;padding:4px 3px;">Reste.U</th>
             <th style="text-align:right;white-space:nowrap;font-size:9px;padding:4px 3px;">Δ Colis</th><th style="text-align:right;white-space:nowrap;font-size:9px;padding:4px 3px;">Δ U</th>`
          : `<th style="text-align:right;white-space:nowrap;font-size:9px;padding:4px 3px;">Prép. Colis</th><th style="text-align:right;white-space:nowrap;font-size:9px;padding:4px 3px;">Prép. U</th>`}
      </tr></thead><tbody>`;

    byCateg[cat]
  .sort((a, b) => _productCustomOrder(a.line.pid) - _productCustomOrder(b.line.pid))
  .forEach(({ line, i }) => {
      const u = _gdsPrepUnitSize(line);
      const stockC = u > 0 ? Math.floor(line.qty / u) : 0;
      const stockU = u > 0 ? Math.round(line.qty % u) : Math.round(line.qty);

      if (!isEdit) {
        html += `<tr>
          <td style="font-size:10px;">${escHtml(_productCustomName(line.pid, line.name))}</td>
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
        const newC     = line.prepCarton + (line._deltaCarton || 0);
        const newU     = line.prepUnite  + (line._deltaUnite  || 0);
        const prepTotal = newC * u + newU;
        const ch        = _gdsPrep.chargeData[line.pid] || { chargeTotal: 0 };
        const restQty   = prepTotal - ch.chargeTotal;
        const restC     = u > 0 ? Math.trunc(restQty / u) : 0;
        const restU     = u > 0 ? Math.round(restQty - Math.trunc(restQty / u) * u) : Math.round(restQty);
        const restColor = restQty <= 0 ? (restQty < 0 ? "color:#f5ac2f;" : "color:#5794f7;") : "color:#5794f7;";
        html += `<tr style="${hasErrRow?"background:rgba(239,68,68,.10);":""}">
          <td style="font-size:10px;">${escHtml(_productCustomName(line.pid, line.name))}</td>
          <td class="gds-qty">${stockC > 0 ? stockC : "—"}</td>
          <td class="gds-qty">${stockU > 0 ? stockU : (stockC === 0 ? Math.round(line.qty) : "—")}</td>
          <td class="gds-qty" style="color:var(--gds-color)">${line.prepCarton || "—"}</td>
          <td class="gds-qty" style="color:var(--gds-color)">${line.prepUnite  || "—"}</td>
          <td class="gds-qty" style="text-align:right;white-space:nowrap;padding:4px 3px;width:36px;font-weight:700;${restColor}">${restC !== 0 ? restC : (restQty === 0 ? "—" : "—")}</td>
          <td class="gds-qty" style="text-align:right;white-space:nowrap;padding:4px 3px;width:36px;font-weight:700;${restColor}">${restU !== 0 ? restU : "—"}</td>
          <td class="gds-qty">
            <input type="number" class="gds-prep-input" style="width:38px;text-align:center;padding:2px;" data-idx="${line.pid}" data-field="deltaCarton"
              value="${line._deltaCarton || 0}"
              onchange="_gdsPrepDeltaInput(${line.pid},'prepCarton',this)"/>
          </td>
          <td class="gds-qty">
            <input type="number" class="gds-prep-input" style="width:38px;text-align:center;padding:2px;" data-idx="${line.pid}" data-field="deltaUnite"
              value="${line._deltaUnite || 0}"
              onchange="_gdsPrepDeltaInput(${line.pid},'prepUnite',this)"/>
          </td>
          </tr>`;
      }
    });
    html += `</tbody></table></div></div>`;
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
  if (totalIfCarton > line.qty && !_canOverstock()) {
    inputEl.style.borderColor = "var(--red)";
    inputEl.title = "القيمة تتجاوز المخزون";
    line._hasError = true;
    _gdsPrepUpdateConfirmBtn();
    return;
  }
  line._hasError = false;
inputEl.style.borderColor = "";
  inputEl.title = "";
  line._hasError = false;
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
  _gdsPrepUpdateConfirmBtn();
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
  

  const vanCount     = {};
  const partnerCount = {};
  mergedRows.forEach(r => {
    vanCount[r.van]         = (vanCount[r.van]         || 0) + 1;
    partnerCount[r.partner] = (partnerCount[r.partner] || 0) + 1;
  });

  if (!rows.length) {
    body.innerHTML = `<div style="padding:16px;color:var(--text3);text-align:center;">Aucun chargement trouvé</div>`;
  } else {
body.innerHTML = `<div><table class="gds-table" style="font-size:11px;width:100%;table-layout:fixed;border-collapse:collapse;">
      <colgroup>
        <col style="width:22%">
        <col style="width:28%">
        <col style="width:9%">
        <col style="width:7%">
        <col style="width:10%">
        <col style="width:24%">
      </colgroup>
      <thead><tr>
        <th style="white-space:normal;word-break:break-word;">Van</th>
        <th style="white-space:normal;word-break:break-word;">Livreur</th>
        <th style="text-align:right;white-space:normal;">Colis</th>
        <th style="text-align:right;white-space:normal;">U</th>
        <th style="text-align:center;white-space:normal;">Heure</th>
        <th style="white-space:normal;word-break:break-word;">Transfert</th>
      </tr></thead><tbody>
	  ${rows.map(r => {
        const vanJuml     = vanCount[r.van]         > 1;
        const partnerJuml = partnerCount[r.partner] > 1;
        const rowJuml     = vanJuml || partnerJuml;
        return `<tr style="${rowJuml ? 'background:rgba(251,146,60,.15);' : ''}">
          <td style="white-space:normal;word-break:break-word;overflow:hidden;">${escHtml(r.van)}${vanJuml ? ' <span style="color:var(--orange);font-weight:700;">⚠</span>' : ''}</td>
          <td style="white-space:normal;word-break:break-word;overflow:hidden;">${escHtml(r.partner)}${partnerJuml ? ' <span style="color:var(--orange);font-weight:700;">⚠</span>' : ''}</td>
          <td style="text-align:right;font-weight:600;">${u > 0 ? Math.floor(r.qty / u) : '—'}</td>
          <td style="text-align:right;">${u > 0 ? Math.round(r.qty % u) : r.qty}</td>
          <td style="text-align:center;">${r.date}</td>
          <td style="white-space:normal;word-break:break-word;overflow:hidden;">${escHtml(r.pickRef)}</td>
        </tr>`;
      }).join("")}
      </tbody>
      <tfoot><tr>
        <td colspan="2" style="font-weight:700;">Total</td>
        <td style="text-align:right;font-weight:700;">${u > 0 ? Math.floor(mergedRows.reduce((s,r)=>s+r.qty,0) / u) : '—'}</td>
        <td style="text-align:right;font-weight:700;">${u > 0 ? Math.round(mergedRows.reduce((s,r)=>s+r.qty,0) % u) : mergedRows.reduce((s,r)=>s+r.qty,0)}</td>
        <td colspan="2"></td>
      </tr></tfoot>
    </table></div>`;
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
  // تحقق مباشر لتجميد/تفعيل زر Confirmer
  const u = _gdsPrepUnitSize(line);
  const newC = line.prepCarton + (line._deltaCarton || 0);
  const newU = line.prepUnite  + (line._deltaUnite  || 0);
  line._hasError = newC < 0 || newU < 0 || newC * u + newU > line.qty;
  _gdsPrepUpdateConfirmBtn();
}

function _gdsPrepUpdateConfirmBtn() {
  const btn = document.querySelector("#gdsPrepModal .gds-prep-modal-footer .gds-refresh-btn");
  if (!btn) return;
    const hasErr = !_canOverstock() && _gdsPrep.lines.some(l => l._hasError);
  btn.disabled = hasErr;
  btn.style.opacity = hasErr ? ".4" : "1";
}

// ── Quick Add mini-modal ──────────────────────────────────────
function _gdsPrepQuickAdd(pid, anchorEl) {
  // أغلق أي mini-modal مفتوح مسبقاً
  document.getElementById("gdsPrepQuickAddPopup")?.remove();

  const line = _gdsPrep.lines.find(l => l.pid === pid);
  if (!line) return;

  const u         = _gdsPrepUnitSize(line);
  const stockC    = u > 0 ? Math.floor(line.qty / u) : 0;
  const stockU    = u > 0 ? Math.round(line.qty % u) : Math.round(line.qty);
  if (_gdsPrep.finished) return;
  const allowOver = _canOverstock();

  const popup = document.createElement("div");
  popup.id = "gdsPrepQuickAddPopup";
  popup.style.cssText = `
    position:fixed;z-index:99999;
    background:var(--bg2);border:1px solid var(--border);
    border-radius:10px;padding:10px 12px;min-width:200px;
    box-shadow:0 8px 24px rgba(0,0,0,.5);
  `;

  // تحديد الموضع بجانب الزر
  const rect = anchorEl.getBoundingClientRect();
  const top  = Math.min(rect.bottom + 4, window.innerHeight - 160);
  const left = Math.max(4, Math.min(rect.left, window.innerWidth - 220));
  popup.style.top  = top  + "px";
  popup.style.left = left + "px";

  // آخر قيم مُدخلة في الجلسة
  const last = (window._gdsPrepQuickLast = window._gdsPrepQuickLast || {});
  const lastC = "";
  const lastU = "";

  popup.innerHTML = `
    <div style="font-size:10px;font-weight:600;color:var(--text1);margin-bottom:6px;max-width:180px;word-break:break-word;">${escHtml(_productCustomName(line.pid, line.name))}</div>
    <div style="font-size:9px;color:var(--text3);margin-bottom:8px;">
      Stock: ${stockC > 0 ? stockC+"C" : ""} ${stockU > 0 ? stockU+"U" : ""} ${line.qty === 0 ? "0" : ""}
      ${line.prepCarton > 0 || line.prepUnite > 0 ? `· Prép: ${line.prepCarton||0}C ${line.prepUnite||0}U` : ""}
    </div>
    <div style="display:flex;gap:6px;margin-bottom:8px;">
      <div style="flex:1;">
        <div style="font-size:9px;color:var(--text3);margin-bottom:2px;">Colis</div>
        <input id="gdsPrepQACarton" type="number" min="0" placeholder="0"
          value="${lastC}"
          style="width:100%;padding:4px 6px;border-radius:6px;border:1px solid var(--border);
                 background:var(--bg3);color:var(--text1);font-size:13px;text-align:center;"/>
      </div>
      <div style="flex:1;">
        <div style="font-size:9px;color:var(--text3);margin-bottom:2px;">Unité</div>
        <input id="gdsPrepQAUnite" type="number" min="0" placeholder="0"
          value="${lastU}"
          style="width:100%;padding:4px 6px;border-radius:6px;border:1px solid var(--border);
                 background:var(--bg3);color:var(--text1);font-size:13px;text-align:center;"/>
      </div>
    </div>
    <div id="gdsPrepQAErr" style="font-size:9px;color:var(--red);margin-bottom:4px;display:none;"></div>
    <button id="gdsPrepQAConfirm"
      style="width:100%;padding:6px;border-radius:7px;border:none;cursor:pointer;
             background:var(--gds-color);color:#fff;font-size:11px;font-weight:600;">
      ＋ Ajouter
    </button>
  `;

  document.body.appendChild(popup);

  const inpC   = popup.querySelector("#gdsPrepQACarton");
  const inpU   = popup.querySelector("#gdsPrepQAUnite");
  const errEl  = popup.querySelector("#gdsPrepQAErr");
  const btnOk  = popup.querySelector("#gdsPrepQAConfirm");

  inpC.focus();
  inpC.select();

  function _validate() {
    let c = parseFloat(inpC.value) || 0;
    let uv = parseFloat(inpU.value) || 0;

    // auto-convert U → C si ≥ unitSize
    if (u > 0 && uv >= u) {
      const addC = Math.floor(uv / u);
      uv = Math.round(uv % u);
      c += addC;
      inpC.value = c;
      inpU.value = uv;
    }

    const addTotal  = c * u + uv;
    const newTotal  = line.prepCarton * u + line.prepUnite + addTotal;

    if (c < 0 || uv < 0) {
      errEl.textContent = "Valeur négative non autorisée";
      errEl.style.display = "";
      inpC.style.borderColor = inpU.style.borderColor = "var(--red)";
      return null;
    }
    if (!allowOver && newTotal > line.qty) {
      errEl.textContent = `Dépasse le stock (max +${line.qty - (line.prepCarton * u + line.prepUnite)})`;
      errEl.style.display = "";
      inpC.style.borderColor = inpU.style.borderColor = "var(--red)";
      return null;
    }
    errEl.style.display = "";
    inpC.style.borderColor = inpU.style.borderColor = "";
    return { c, uv, addTotal };
  }

  function _confirm() {
    const res = _validate();
    if (!res) return;
    const { c, uv, addTotal } = res;
    if (addTotal === 0) { popup.remove(); return; }

    // حفظ آخر قيمة
    last[pid] = { c, u: uv };

    // تطبيق الإضافة
    line.prepCarton += c;
    line.prepUnite  += uv;
    line._ts = Date.now();
    if (line._hasError && !_canOverstock()) {
      line._hasError = false;
    }
    const now = new Date().toLocaleTimeString("fr-FR");
    if (!line.history) line.history = [];
    line.history.push({ ts: now, type: "Ajout rapide", carton: c, unite: uv, by: AppAuth.currentUser?.username || "" });

    _gdsPrepSave();
    _gdsPrepRenderTable();
    _gdsPrepUpdateConfirmBtn();

    // flash vert sur la ligne
    setTimeout(() => {
      const rows = document.querySelectorAll(`[data-pid="${pid}"]`);
      rows.forEach(el => {
        const tr = el.closest("tr");
        if (tr) {
          tr.style.transition = "background .1s";
          tr.style.background = "rgba(34,197,94,.25)";
          setTimeout(() => { tr.style.background = ""; tr.style.transition = ""; }, 700);
        }
      });
    }, 50);

    popup.remove();
  }

  btnOk.addEventListener("click", _confirm);

  [inpC, inpU].forEach(inp => {
    inp.addEventListener("input", _validate);
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter") _confirm();
      if (e.key === "Escape") popup.remove();
    });
  });

  // إغلاق عند الضغط خارج الـ popup
  setTimeout(() => {
    function _outside(e) {
      if (!popup.contains(e.target) && e.target !== anchorEl) {
        popup.remove();
        document.removeEventListener("click", _outside);
      }
    }
    document.addEventListener("click", _outside);
  }, 0);
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
      if (v.c * unitSize + (v.u || 0) > line.qty && !_canOverstock()) {
        errors.push(line.name);
      } else {
        const wasEmpty = line.prepCarton === 0 && line.prepUnite === 0;
        line.prepCarton = v.c;
        line.prepUnite  = v.u || 0;
        line._ts = Date.now();
        if (line.prepCarton > 0 || line.prepUnite > 0)
          if (!line.history) line.history = [];
line.history.push({ ts: now, type: "Ajout", carton: line.prepCarton, unite: line.prepUnite, by: AppAuth.currentUser?.username || "" });
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
      if (newC < 0 || newU < 0 || (newC * u + newU > line.qty && !_canOverstock())) {
        errors.push(line.name);
        line._hasError = true;
        return;
      }
      line._hasError    = false;
      line.prepCarton   = newC;
      line.prepUnite    = newU;
      line._ts = Date.now();
      const type = dc > 0 || du > 0 ? "Augmentation" : "Réduction";
      if (!line.history) line.history = [];
line.history.push({ ts: now, type, carton: dc, unite: du, by: AppAuth.currentUser?.username || "" });
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
  _gdsPrep._skipCloudReload = true;
  gdsPrepCloseModal();
  _gdsPrepSave();
  gdsShowTab("preparation");
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
        args:[[["id","=",locId],["location_id","=",_getVanLocationParent()],["usage","=","internal"]]],
        kwargs:{ fields:["id"], limit:1 }
      }})
    });
    return ((await r.json())?.result || []).length > 0;
  } catch(_) { return false; }
}
// ── جلب تحركات الشحن من GDS → Vans ──────────────────────────


function _gdsPrepTogglePickingInclude(ref) {
  const isIncluded = _gdsPrep.includedPickings.includes(ref);
  if (isIncluded) {
    _gdsPrep.includedPickings = _gdsPrep.includedPickings.filter(r => r !== ref);
  } else {
    _gdsPrep.includedPickings.push(ref);
  }
  _gdsPrepRecalcCharge();
}

// إعادة حساب فورية (بدون طلب Odoo) بناءً على includedPickings الحالية
function _gdsPrepRecalcCharge() {
  const moves = _gdsPrep.allMoves || [];
  const pm    = _gdsPrep.pickingsMap || {};
  const cache = _gdsPrep._prodInfoCache || {};

  if (!moves.length) {
    // لا توجد بيانات خام محمّلة بعد (مثلاً بعد إعادة تحميل الصفحة) — يُطلب Actualiser أولاً
    _gdsPrepSave();
    const panelEl0 = document.getElementById("gdsPrepPickingBtns");
    if (panelEl0) panelEl0.innerHTML = _gdsPrepRenderPickingBtns();
    const statusEl0 = document.getElementById("gdsPrepChargeStatus");
    if (statusEl0) statusEl0.textContent = "Cliquez Actualiser pour recalculer";
    return;
  }

  const filteredMoves = moves.filter(m => {
    const pk = pm[m.picking_id?.[0]];
    return pk && _gdsPrep.includedPickings.includes(pk.name);
  });

  const agg = {};
  filteredMoves.forEach(m => {
    const pid = m.product_id?.[0];
    if (!pid) return;
    agg[pid] = (agg[pid] || 0) + (m.qty_done || 0);
  });

  _gdsPrep.chargeData = {};
  const prepPids = new Set(
    _gdsPrep.lines.filter(l => l.prepCarton > 0 || l.prepUnite > 0).map(l => String(l.pid))
  );

  Object.entries(agg).forEach(([pidStr, total]) => {
    if (!(total > 0)) return;
    const pid = Number(pidStr);
    const existing = _gdsPrep.lines.find(l => l.pid === pid);
    if (existing || prepPids.has(pidStr)) { if (existing) existing._extraCharge = true; return; }
    const info = cache[pid] || {};
    _gdsPrep.lines.push({
      pid, name: info.name || `pid:${pid}`, categ: info.categ || "— Chargé sans préparation —",
      carton: info.pkgQty || 0, qty: info.pkgQty || 0, prepCarton: 0, prepUnite: 0, unitSize: info.pkgQty || 0,
      history: [], check: false, ecart: 0, _extraCharge: true,
    });
  });

  Object.entries(agg).forEach(([pidStr, total]) => {
    const pid  = Number(pidStr);
    const line = _gdsPrep.lines.find(l => l.pid === pid);
    const info = cache[pid] || {};
    const u    = line ? (_gdsPrepUnitSize(line) || info.pkgQty || 0) : (info.pkgQty || 0);
    _gdsPrep.chargeData[pid] = {
      chargeCarton: u > 0 ? Math.floor(total / u) : 0,
      chargeUnite:  u > 0 ? Math.round(total % u) : Math.round(total),
      chargeTotal:  total,
    };
  });

  _gdsPrepSave();
  const panelEl = document.getElementById("gdsPrepPickingBtns");
  if (panelEl) panelEl.innerHTML = _gdsPrepRenderPickingBtns();
  _gdsPrepRenderTable();
}

function _gdsPrepShowOutOfDateInput() {
  document.getElementById("gdsPrepOutOfDatePopup")?.remove();
  const btn  = document.querySelector("[title='Ajouter transfert hors date']");
  const rect = btn ? btn.getBoundingClientRect() : { bottom: 100, left: 100 };

  const popup = document.createElement("div");
  popup.id = "gdsPrepOutOfDatePopup";
  popup.style.cssText = `position:fixed;top:${rect.bottom+6}px;left:50%;transform:translateX(-50%);
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
    // تحقق إذا كان محسوباً أصلاً (موجود في pickingsMap)
    const isAlreadyCalculated = Object.values(_gdsPrep.pickingsMap).some(p => p.name === ref);
    if (isAlreadyCalculated) {
      _gdsPrepOutOfDateNotif(`⚠ Ce transfert est déjà calculé dans la période — utilisez "Exclure" à la place`, "warning");
      return;
    }
    _gdsPrep.outOfDateTransferts.push({ ref, id: picking.id, scheduledDate: picking.scheduled_date });
    document.getElementById("gdsPrepOutOfDatePopup")?.remove();
    _gdsPrepUpdateOutOfDateBtn();
    _gdsPrepSave();
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
  _gdsPrepSave();
  _gdsPrepShowOutOfDateList();
  const statusEl = document.getElementById("gdsPrepChargeStatus");
  if (statusEl) statusEl.textContent = "✓ Retiré — Actualisez les chargements";
}

function _gdsPrepClearOutOfDate() {
  _gdsPrep.outOfDateTransferts = [];
  _gdsPrepUpdateOutOfDateBtn();
  _gdsPrepSave();
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
        args:[[["location_id","=",_getVanLocationParent()],["usage","=","internal"]]],
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
          ["location_id",    "=",  _getPrepSourceLocationId()],
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
          kwargs:{ fields:["id","name","partner_id","date_done","location_dest_id"], limit:500 }
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
      if (pickId && pickingsMap[pickId]) {
        const fullPath = m.location_dest_id?.[1] || "";
        // نحفظ الاسم الكامل ونطبّق التنظيف لاحقاً عند الـ render
        if (fullPath && fullPath !== "—" && (!pickingsMap[pickId].vanRaw || pickingsMap[pickId].vanRaw === "—")) {
          pickingsMap[pickId].vanRaw = fullPath;
          pickingsMap[pickId].van = _cleanVanName(fullPath);
        }
      }
    });
    // fallback: استخدام اسم الـ picking نفسه إذا لم يُعثر على van
    Object.values(pickingsMap).forEach(p => {
      if (!p.van || p.van === "—") {
        p.van = _cleanVanName(p.name || "—");
      }
    });
    }

    // جلب moves الخاصة بـ outOfDateTransferts ودمجها مع moves العادية (تُعامل كأي bon: قابلة للـ toggle)
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
          });
          moves.push(...outMoves);
        } catch(e) {
          console.warn("[GdsPrep] outOfDate fetch error:", e);
        }
      }
    }

    // تجميع كل الـ moves حسب picking (بدون تصفية — الاستثناء الآن عبر toggle حيّ في الـpanel)
    const byPicking = {};
    moves.forEach(m => {
      const pickId = m.picking_id?.[0];
      if (!pickId) return;
      if (!byPicking[pickId]) byPicking[pickId] = [];
      byPicking[pickId].push(m);
    });

    // جلب أسماء ووحدات المنتجات غير الموجودة في lines (كاش يُستعمل عند كل toggle بدون إعادة طلب Odoo)
    const allPids     = [...new Set(moves.map(m => m.product_id?.[0]).filter(Boolean))];
    const missingPids  = allPids.filter(pid => !_gdsPrep.lines.find(l => l.pid === pid));
    const prodInfoCache = {};

    if (missingPids.length) {
      const [rPkg, rProd] = await Promise.all([
        fetch("/api/web/dataset/call_kw", {
          method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:55, params:{
            model:"product.packaging", method:"search_read",
            args:[[["product_id","in",missingPids]]],
            kwargs:{ fields:["product_id","qty"], limit:500 }
          }})
        }),
        fetch("/api/web/dataset/call_kw", {
          method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:53, params:{
            model:"product.product", method:"search_read",
            args:[[["id","in",missingPids]]],
            kwargs:{ fields:["id","name","categ_id","packaging_quantity_1"], limit:500 }
          }})
        }),
      ]);
      const pkgRes  = (await rPkg.json())?.result  || [];
      const prodRes = (await rProd.json())?.result || [];
      prodRes.forEach(p => {
        prodInfoCache[p.id] = {
          name: _productDisplayName(p) || `pid:${p.id}`,
          categ: p.categ_id?.[1] || "— Chargé sans préparation —",
          pkgQty: p.packaging_quantity_1 || 0,
        };
      });
      pkgRes.forEach(pkg => {
        const pid = pkg.product_id[0];
        if (!prodInfoCache[pid]) prodInfoCache[pid] = { name: `pid:${pid}`, categ: "— Chargé sans préparation —", pkgQty: 0 };
        if (!prodInfoCache[pid].pkgQty) prodInfoCache[pid].pkgQty = pkg.qty || 0;
      });
    }

    // حفظ الحالة الخام في _gdsPrep (تُستعمل من طرف _gdsPrepRecalcCharge عند كل toggle)
    _gdsPrep.pickingsMap      = pickingsMap;
    _gdsPrep.byPicking        = byPicking;
    _gdsPrep.allMoves         = moves;
    _gdsPrep._prodInfoCache   = prodInfoCache;

    // إعادة الحساب حسب includedPickings الحالية (bon جديد = مستثنى افتراضياً)
    _gdsPrepRecalcCharge();

    const nbIncluded = _gdsPrep.includedPickings.length;
    if (statusEl) statusEl.textContent = `${Object.keys(pickingsMap).length} bon(s) — ${nbIncluded} inclus — ${new Date().toLocaleTimeString("fr-FR")}`;
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
        line.name  = _productDisplayName(p, {useCustom:true});
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
  _sortCats(Object.keys(byCateg)).forEach(cat => {
const collapsed = !!_gdsPrep.collapsed["tbl_" + cat];
    html += `<div class="gds-catery" style="margin:0 0 14px;">
      <div class="gds-category-title gds-category-toggle" onclick="_gdsPrepToggleTblCat('${escHtml(cat)}')">
        <svg id="gdsPrepArrow_${escHtml(cat)}" class="gds-collapse-arrow" style="transform:${collapsed?"rotate(-90deg)":""}" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"/></svg>
        ${escHtml(cat)}
      </div>
      <div id="gdsPrepTblCat_${escHtml(cat)}" style="display:${collapsed?"none":""}">
      <table class="gds-table gds-prep-main-table" style="width:100%;border-spacing:0;border-collapse:collapse;table-layout:fixed;">
        <thead>
          <tr>
            <th style="text-align:left;color:var(--text2);padding:2px 3px;font-size:10px;">Produit</th>
            ${_gdsPrepCols.stock ? `<th colspan="2" style="text-align:center;border-bottom:1px solid var(--border);color:var(--text3);">Stock</th>` : ""}
            ${Object.keys(_gdsPrep.suggested).length && _gdsPrepCols.sugg ? `<th colspan="2" style="text-align:center;border-bottom:1px solid var(--border);color:var(--text3);">Suggéré</th>` : ""}
            ${_gdsPrepCols.prep ? `<th colspan="${App.settings?.showPrepQty !== false ? 3 : 2}" style="text-align:center;border-bottom:1px solid var(--border);color:var(--gds-color)">Préparation</th>` : ""}
            ${hasCharge && _gdsPrepCols.charge ? `<th colspan="${App.settings?.showPrepQty !== false ? 3 : 2}" style="text-align:center;border-bottom:1px solid var(--border);color:var(--orange)">Chargement</th>` : ""}
            ${hasCharge && _gdsPrepCols.reste ? `<th colspan="${App.settings?.showPrepQty !== false ? 3 : 2}" style="text-align:center;border-bottom:1px solid var(--border);color:var(--accent)">Reste</th>` : ""}
            ${_gdsPrep.finished ? `<th colspan="2" style="text-align:center;border-bottom:1px solid var(--border);color:var(--text2)">Vérif.</th><th class="no-print" style="width:40px;"></th>` : ""}
          </tr>
          <tr>
            <th></th>
            ${_gdsPrepCols.stock ? `<th style="text-align:right;color:var(--text3);padding:2px 3px;font-size:9px;">Colis</th><th style="text-align:right;color:var(--text3);padding:2px 3px;font-size:9px;">U</th>` : ""}
            ${Object.keys(_gdsPrep.suggested).length && _gdsPrepCols.sugg ? `<th style="text-align:right;color:var(--text3);padding:2px 3px;font-size:9px;">Colis</th><th style="text-align:right;color:var(--text3);padding:2px 3px;font-size:9px;">U</th>` : ""}
            ${_gdsPrepCols.prep ? `<th style="text-align:right;color:var(--gds-color);padding:2px 3px;font-size:9px;">Colis</th><th style="text-align:right;color:var(--gds-color);padding:2px 3px;font-size:9px;">U</th>${App.settings?.showPrepQty !== false ? `<th style="text-align:right;color:var(--gds-color);font-size:8px;padding:2px 2px;">qty</th>` : ""}` : ""}
            ${hasCharge && _gdsPrepCols.charge ? `<th style="text-align:right;color:var(--orange);padding:2px 3px;font-size:9px;">Colis</th><th style="text-align:right;color:var(--orange);padding:2px 3px;font-size:9px;">U</th>${App.settings?.showPrepQty !== false ? `<th style="text-align:right;color:var(--orange);font-size:8px;padding:2px 2px;">qty</th>` : ""}` : ""}
            ${hasCharge && _gdsPrepCols.reste ? `<th style="text-align:right;color:var(--accent);padding:2px 3px;font-size:9px;">Colis</th><th style="text-align:right;color:var(--accent);padding:2px 3px;font-size:9px;">U</th>${App.settings?.showPrepQty !== false ? `<th style="text-align:right;color:var(--accent);font-size:8px;padding:2px 2px;">qty</th>` : ""}` : ""}
            ${_gdsPrep.finished ? `<th style="text-align:center;padding:2px 3px;font-size:9px;">✓</th><th style="text-align:center;padding:2px 3px;font-size:9px;">Écart</th>` : ""}
          </tr>
        </thead><tbody>`;

    byCateg[cat]
  .sort((a, b) => _productCustomOrder(a.line.pid) - _productCustomOrder(b.line.pid))
  .forEach(({ line, i }) => {
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

      html += `<tr style="${rowErr ? "background:rgba(239,68,68,.10);" : ""}" data-orig-name="${escHtml(line._origName || line.name).toLowerCase()}">
        <td style="${rowErr ? "color:var(--red);font-weight:600;" : ""}font-size:10px;min-width:80px;max-width:120px;word-break:break-word;white-space:normal;" title="${escHtml(_productCustomName(line.pid, line.name))}">${escHtml(_productCustomName(line.pid, line.name))}
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
        ${App.settings?.showPrepQty !== false ? `<td class="gds-qty" style="color:${rowErr ? "var(--red)" : "var(--gds-color)"};opacity:0.7;font-size:10px;">${prepTotal > 0 ? prepTotal : "—"}</td>` : ""}
        ` : ""}
        ${hasCharge && _gdsPrepCols.charge ? `
        <td class="gds-qty" style="color:${chargeOverPrep?"var(--red)":"var(--orange)"}">
          ${ch.chargeCarton > 0 ? ch.chargeCarton : "—"}
          ${chargeOverPrep ? `<span style="font-size:9px;color:var(--red)">⚠</span>` : ""}
        </td>
        <td class="gds-qty" style="color:${chargeOverPrep?"var(--red)":"var(--orange)"}">
          ${ch.chargeUnite > 0 ? ch.chargeUnite : "—"}
        </td>
        ${App.settings?.showPrepQty !== false ? `<td class="gds-qty" style="color:${chargeOverPrep?"var(--red)":"var(--orange)"};opacity:0.7;font-size:10px;">${ch.chargeTotal > 0 ? ch.chargeTotal : "—"}</td>` : ""}
        ` : ""}
        ${hasCharge && _gdsPrepCols.reste ? `
        <td class="gds-qty" style="color:${resteTotal===0?"var(--green)":resteTotal<0?"var(--red)":"var(--accent)"}">
  ${resteCarton !== 0 ? resteCarton : (resteTotal===0 ? "0" : "—")}
</td>
<td class="gds-qty" style="color:${resteTotal===0?"var(--green)":resteTotal<0?"var(--red)":"var(--accent)"}">
  ${resteUnite !== 0 ? resteUnite : (resteTotal===0 ? "0" : "—")}
</td>
        ${App.settings?.showPrepQty !== false ? `<td class="gds-qty" style="color:${resteTotal===0?"var(--green)":resteTotal<0?"var(--red)":"var(--accent)"};opacity:0.7;font-size:10px;">${resteTotal !== 0 ? Math.round(resteTotal) : "0"}</td>` : ""}
        ` : ""}
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
       <td style="text-align:center;min-width:40px;" class="no-print"><div class="gds-prep-action-cell">
          <span data-perm="prep_quick_add">
          <button class="gds-prep-hist-btn" onclick="_gdsPrepQuickAdd(${line.pid}, this)" title="Ajout rapide"
            style="background:${_gdsPrep.finished ? 'var(--border)' : 'var(--gds-color)'};color:#fff;font-weight:700;font-size:13px;padding:0 5px;${_gdsPrep.finished || (!_canOverstock() && line.qty === 0) ? 'opacity:.35;cursor:not-allowed;' : ''}">
            ＋
          </button>
          </span>
          ${line.history?.length
            ? `<button class="gds-prep-hist-btn" onclick="gdsPrepShowHist(${i})" title="Historique">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
               </button>`
            : ""}
          ${(() => {
            const hasChg = Object.values(_gdsPrep.byPicking).some(mv => mv.some(m => m.product_id?.[0] === line.pid));
            return `<button class="gds-prep-hist-btn" onclick="${hasChg ? `gdsPrepShowCharge(${line.pid})` : ''}" title="Détail chargement" style="${!hasChg ? 'opacity:.3;cursor:not-allowed;' : ''}" ${!hasChg ? 'disabled' : ''}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>
                <circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>
              </svg>
            </button>`;
          })()}
        </div></td>
        ` : `
        <td style="text-align:center;min-width:40px;"><div class="gds-prep-action-cell">
          <span data-perm="prep_quick_add">
          <button class="gds-prep-hist-btn" onclick="_gdsPrepQuickAdd(${line.pid}, this)" title="Ajout rapide"
            style="padding:0 5px;${_gdsPrep.finished ? 'opacity:.35;cursor:not-allowed;' : (!_canOverstock() && line.qty === 0 ? 'opacity:.35;cursor:not-allowed;' : '')}">
            ＋
          </button>
          </span>
          ${line.history?.length
            ? `<button class="gds-prep-hist-btn" onclick="gdsPrepShowHist(${i})" title="Historique">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
               </button>`
            : ""}
          ${(() => {
            const hasChg = Object.values(_gdsPrep.byPicking).some(mv => mv.some(m => m.product_id?.[0] === line.pid));
            return `<button class="gds-prep-hist-btn" onclick="${hasChg ? `gdsPrepShowCharge(${line.pid})` : ''}" title="Détail chargement" style="${!hasChg ? 'opacity:.3;cursor:not-allowed;' : ''}" ${!hasChg ? 'disabled' : ''}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>
                <circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>
              </svg>
            </button>`;
          })()}
        </div></td>`}
      </tr>`;
    });
    html += `</tbody></table></div></div>`;
  });

  wrap.innerHTML = html;
  _gdsPrepApplyColWidths();
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
function _gdsPrepApplyColWidths() {
  const hasCharge = Object.keys(_gdsPrep.chargeData).length > 0;
  const hasSugg   = Object.keys(_gdsPrep.suggested).length > 0;

  // احسب عدد الأعمدة الظاهرة
  const groups = [
    { key: "prod",   span: 1, always: true },
    { key: "stock",  span: 2, vis: _gdsPrepCols.stock },
    { key: "sugg",   span: 2, vis: hasSugg && _gdsPrepCols.sugg },
    { key: "prep",   span: App.settings?.showPrepQty !== false ? 3 : 2, vis: _gdsPrepCols.prep },
{ key: "charge", span: App.settings?.showPrepQty !== false ? 3 : 2, vis: hasCharge && _gdsPrepCols.charge },
{ key: "reste",  span: App.settings?.showPrepQty !== false ? 3 : 2, vis: hasCharge && _gdsPrepCols.reste },
    { key: "verif",  span: 2, vis: _gdsPrep.finished },
    { key: "action", span: 1, always: true },
  ].filter(g => g.always || g.vis);

  const totalCols = groups.reduce((s, g) => s + g.span, 0);
  const W = Math.min(window.innerWidth, document.documentElement.clientWidth);
  const isMobile = W < 600;

  // عرض عمود المنتج: ثابت نسبياً، الباقي يتوزع
  const prodPct   = isMobile ? 28 : 22;
  const actionPct = 6;
  const numCols   = totalCols - 1; // بدون prod فقط
  const numPct    = (100 - prodPct) / Math.max(numCols, 1);

  // بناء colgroup HTML
  let colgroupHtml = `<colgroup>`;
  groups.forEach(g => {
    if (g.key === "prod")   { colgroupHtml += `<col style="width:${prodPct}%">`; return; }
    if (g.key === "action") { colgroupHtml += `<col style="width:${actionPct}%">`; return; }
    for (let s = 0; s < g.span; s++) {
      colgroupHtml += `<col style="width:${numPct.toFixed(2)}%">`;
    }
  });
  colgroupHtml += `</colgroup>`;

  // تطبيق على كل الجداول
  document.querySelectorAll(".gds-prep-main-table").forEach(tbl => {
    tbl.querySelector("colgroup")?.remove();
    tbl.insertAdjacentHTML("afterbegin", colgroupHtml);
  });

  // منع تكسير النصوص في خلايا الأرقام
  document.querySelectorAll(".gds-prep-main-table td.gds-qty, .gds-prep-main-table th").forEach(el => {
    el.style.whiteSpace = "nowrap";
    el.style.overflow   = "hidden";
    el.style.textOverflow = "ellipsis";
  });
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
        <th style="width:20%">Heure</th><th style="width:20%">Type</th><th style="width:20%;text-align:right">Colis</th><th style="width:20%;text-align:right">U</th><th style="width:20%">Par</th>
      </tr></thead><tbody>`;
    line.history.forEach(h => {
      const color = h.type === "Augmentation" || h.type === "Ajout" ? "var(--green)" : h.type === "Réduction" ? "var(--red)" : "var(--gds-color)";
      html += `<tr>
        <td style="font-size:10px;color:var(--text3)">${h.ts}</td>
        <td style="font-weight:600;color:${color}">${h.type}</td>
        <td class="gds-qty">${h.carton > 0 ? "+"+h.carton : h.carton < 0 ? h.carton : "—"}</td>
        <td class="gds-qty">${h.unite > 0 ? "+"+h.unite : h.unite < 0 ? h.unite : "—"}</td>
        <td style="font-size:10px;color:var(--text3)">${h.by || "—"}</td>
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

// ── بحث في جدول التحضير ──────────────────────────────────────
function _gdsPrepToggleSearch() {
  const popup = document.getElementById("gdsPrepSearchPopup");
  const inp   = document.getElementById("gdsPrepSearchInput");
  if (!popup) return;
  const visible = popup.style.display === "flex";
  popup.style.display = visible ? "none" : "flex";
  if (!visible) {
    const reposition = () => {
      const vv = window.visualViewport;
      if (!vv) return;
      const bottom = window.innerHeight - vv.offsetTop - vv.height;
      const wrap = document.getElementById("gdsPrepSearchFloatWrap");
      if (wrap) wrap.style.bottom = (bottom + 12) + "px";
    };
    window.visualViewport?.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("scroll", reposition);
    reposition();
    popup._vpCleanup = () => {
      window.visualViewport?.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("scroll", reposition);
      const wrap = document.getElementById("gdsPrepSearchFloatWrap");
      if (wrap) wrap.style.bottom = "18px";
    };
  } else {
    popup._vpCleanup?.();
  }
  const btn = document.getElementById("gdsPrepSearchBtn");
  if (btn) {
    btn.innerHTML = visible
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    btn.style.background = visible ? "var(--gds-color)" : "var(--red)";
  }
  if (!visible) { inp?.focus(); inp?.select(); }
  else { _gdsPrepClearSearch(); }
}

function _gdsPrepClearSearch() {
  const inp = document.getElementById("gdsPrepSearchInput");
  if (inp) inp.value = "";
  _gdsPrepApplySearch("");
}

function _gdsPrepApplySearch(q) {
  const raw  = (q || "").trim().toLowerCase();
  const term = raw.replace(/%/g, ".*");
  const useRegex = raw.includes("%");
  const regex = useRegex ? new RegExp(term) : null;
  document.querySelectorAll("#gdsPrepTableWrap tbody tr").forEach(tr => {
    const name = tr.querySelector("td:first-child")?.textContent?.toLowerCase() || "";
    const origName = tr.dataset.origName || "";
    const match = !raw || (useRegex ? regex.test(name) || regex.test(origName) : name.includes(raw) || origName.includes(raw));
    tr.style.display = match ? "" : "none";
  });
  // إخفاء/إظهار headers الفئات إذا كل منتجاتها مخفية
  document.querySelectorAll("#gdsPrepTableWrap table").forEach(tbl => {
    const rows = tbl.querySelectorAll("tbody tr");
    const allHidden = [...rows].every(r => r.style.display === "none");
    const section = tbl.closest("div[style*='margin-bottom']") || tbl.parentElement;
    if (section) section.style.display = allHidden ? "none" : "";
  });
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
      if (hint) hint.textContent = "Vous pouvez le confirmer maintenant";
    }
  }, 1000);
}

function gdsPrepCloseConfirm() {
  const m = document.getElementById("gdsPrepConfirmModal");
  if (m) m.style.display = "none";
}

function gdsPrepDoFinish() {
  gdsPrepCloseConfirm();
  _gdsPrep.lines.forEach(l => { if (l.ecart === null || l.ecart === undefined) l.ecart = 0; });
  _gdsPrep.finished = true;
  _gdsPrepSave();
  _gdsPrep._skipCloudReload = true;
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

function gdsPrepAskReset() {
  const m = document.getElementById("gdsPrepResetModal");
  if (m) m.style.display = "flex";
}
function gdsPrepCloseReset() {
  const m = document.getElementById("gdsPrepResetModal");
  if (m) m.style.display = "none";
}
function gdsPrepDoReset() {
  const isEdit = _gdsPrep.isEdit;
  _gdsPrep.lines.forEach(l => {
    if (isEdit) {
      l._deltaCarton = 0;
      l._deltaUnite  = 0;
      l._hasError    = false;
    } else {
      l.prepCarton = 0;
      l.prepUnite  = 0;
      l._hasError  = false;
    }
  });
  gdsPrepCloseReset();
  _gdsPrepRenderModalBody();
  _gdsPrepUpdateConfirmBtn();
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
  _gdsPrep.allMoves            = [];
  _gdsPrep._prodInfoCache      = {};
  _gdsPrep.includedPickings    = [];
  _gdsPrep.outOfDateTransferts = [];
  localStorage.removeItem(_getPrepStorageKey());
  _gdsPrepSaveCloud();
  _gdsPrep._skipCloudReload = true;
  renderGdsPreparation();
  addNotif("Préparation annulée", "warning");
}

function _gdsPrepToggleCheck(pid) {
  const line = _gdsPrep.lines.find(l => l.pid === pid); if (!line) return;
  if (line.ecart !== null && line.ecart !== 0) return;
  if (line.ecart === null || line.ecart === 0) line.ecart = 0; // القيمة الافتراضية عند الضغط بدون كتابة
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
    line.ecart = 0;
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
    l.check === true || (l.ecart !== null && l.ecart !== undefined && l.ecart !== 0) ||
    (l._extraCharge && l.name.startsWith("pid:"))
  );
  fetch(`${_FB_DB_URL}/settings.json`)
    .then(r => r.json())
    .then(fb => {
      if (fb?.rapportRequireCheck !== undefined) {
        App.settings.rapportRequireCheck = fb.rapportRequireCheck;
      } else {
        App.settings.rapportRequireCheck = false;
      }
      const requireCheck = App.settings.rapportRequireCheck === true;
      const rapportBtn   = document.querySelector("#gdsPrepNewBar button[onclick='gdsPrepExportCurrent()']");
      const nouvelleBtn  = document.querySelector("#gdsPrepNewBar button[onclick='gdsPrepAskNew()']");
      const bar          = document.getElementById("gdsPrepNewBar");
      if (bar) bar.style.display = "flex";
      if (rapportBtn) rapportBtn.style.display = (!requireCheck || allDone) ? "" : "none";
      if (nouvelleBtn) nouvelleBtn.style.display = allDone ? "" : "none";
    }).catch(() => {
      const requireCheck = App.settings.rapportRequireCheck === true;
      const rapportBtn   = document.querySelector("#gdsPrepNewBar button[onclick='gdsPrepExportCurrent()']");
      const nouvelleBtn  = document.querySelector("#gdsPrepNewBar button[onclick='gdsPrepAskNew()']");
      const bar          = document.getElementById("gdsPrepNewBar");
      if (bar) bar.style.display = "flex";
      if (rapportBtn) rapportBtn.style.display = (!requireCheck || allDone) ? "" : "none";
      if (nouvelleBtn) nouvelleBtn.style.display = allDone ? "" : "none";
    });
}

function gdsPrepReprendre() {
  _gdsPrep.finished = false;
  // مسح بيانات التحقق
  _gdsPrep.lines.forEach(l => { l.check = false; l.ecart = 0; });
  _gdsPrepSave();
  _gdsPrep._skipCloudReload = true;
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
  _gdsPrep.allMoves            = [];
  _gdsPrep._prodInfoCache      = {};
  _gdsPrep.includedPickings    = [];
  _gdsPrep.outOfDateTransferts = [];
  localStorage.removeItem(_getPrepStorageKey());
  _gdsPrepSaveCloud();
  _gdsPrep._skipCloudReload = true;
  renderGdsPreparation();
  addNotif("✓ Nouvelle préparation démarrée", "success");
}
function gdsPrepExportCurrent() {
  if (!_gdsPrep.lines.length) { addNotif("Aucune donnée à exporter", "warning"); return; }
  _gdsPrepExportXlsx();
}
function _gdsPrepExportXlsx() {
  const u_fn = line => _gdsPrepUnitSize(line);
  const now  = new Date();
  const date = now.toLocaleDateString("fr-FR");
  const time = now.toLocaleTimeString("fr-FR", { hour:"2-digit", minute:"2-digit" });
  const dd   = String(now.getDate()).padStart(2,"0");
  const mm   = String(now.getMonth()+1).padStart(2,"0");
  const yyyy = now.getFullYear();

  const byCateg = {};
  _gdsPrep.lines.filter(l => l.prepCarton > 0 || l.prepUnite > 0 || l._extraCharge).forEach(line => {
    const cat = line.categ || "—";
    if (!byCateg[cat]) byCateg[cat] = [];
    const u         = u_fn(line);
    const ch        = _gdsPrep.chargeData[line.pid] || { chargeCarton:0, chargeUnite:0, chargeTotal:0 };
    const prepTotal = line.prepCarton * u + line.prepUnite;
    const resteTotal  = prepTotal - ch.chargeTotal;
    const resteCarton = u > 0 ? Math.trunc(resteTotal / u) : 0;
    const resteUnite  = u > 0 ? Math.round(resteTotal - Math.trunc(resteTotal / u) * u) : Math.round(resteTotal);
    byCateg[cat].push({ line, u, ch, prepTotal, resteCarton, resteUnite, resteTotal });
  });

  if (!Object.keys(byCateg).length) return;

  const rs = App.settings || {};
  const rC = (k, def=true) => rs[k] ?? def;
  const _rptFontP  = rs.rptFontProduct ?? 10;
  const _rptFontQ  = rs.rptFontQty     ?? 11;
  const _rptPad    = rs.rptRowPadding  ?? 3;
  const _rptCols   = rs.rptColumns     ?? 1;

  // عدد الأعمدة الديناميكي لـ colspan
  const colCount = 1
    + (rC("rptColPrepCarton") ? 1:0) + (rC("rptColPrepUnite")  ? 1:0)
    + (rC("rptColChargCarton")? 1:0) + (rC("rptColChargUnite") ? 1:0)
    + (rC("rptColResteCarton")? 1:0) + (rC("rptColResteUnite") ? 1:0)
    + (rC("rptColCheck")      ? 1:0) + (rC("rptColEcart")      ? 1:0)
    ;

  const thead = `<thead><tr>
    <th>Produit</th>
    ${rC("rptColPrepCarton")  ? '<th class="num">Prép C</th>'   : ''}
    ${rC("rptColPrepUnite")   ? '<th class="num">Prép U</th>'   : ''}
    ${rC("rptColChargCarton") ? '<th class="num">Charg C</th>'  : ''}
    ${rC("rptColChargUnite")  ? '<th class="num">Charg U</th>'  : ''}
    ${rC("rptColResteCarton") ? '<th class="num">Reste C</th>'  : ''}
    ${rC("rptColResteUnite")  ? '<th class="num">Reste U</th>'  : ''}
    ${rC("rptColCheck")       ? '<th class="num">✓</th>'        : ''}
    ${rC("rptColEcart")       ? '<th class="num">Écart</th>'    : ''}
    
  </tr></thead>`;

  let allRows = [];
_sortCats(Object.keys(byCateg)).forEach(cat => {
    allRows.push({ type: "cat", cat });
    byCateg[cat]
      .sort((a, b) => _productCustomOrder(a.line.pid) - _productCustomOrder(b.line.pid))
      .forEach(item => allRows.push({ type: "row", ...item }));
});

  const buildRow = (item, idx) => {
    if (item.type === "cat") {
      return `<tr class="cat-row"><td colspan="${colCount}" style="background:#1a6b3a!important;color:#fff!important;font-weight:bold;">${item.cat}</td></tr>`;
    }
    const { line, ch, resteCarton, resteUnite, resteTotal } = item;
    const resteColor = resteTotal === 0 ? "#16a34a" : resteTotal < 0 ? "#dc2626" : "#0ea5e9";
    return `<tr>
      <td style="font-size:${_rptFontP}px">${_productCustomName(line.pid, line.name)}</td>
      ${rC("rptColPrepCarton")  ? `<td class="num" style="font-size:${_rptFontQ}px">${line.prepCarton||"—"}</td>` : ''}
      ${rC("rptColPrepUnite")   ? `<td class="num" style="font-size:${_rptFontQ}px">${line.prepUnite ||"—"}</td>` : ''}
      ${rC("rptColChargCarton") ? `<td class="num" style="font-size:${_rptFontQ}px">${ch.chargeCarton||"—"}</td>` : ''}
      ${rC("rptColChargUnite")  ? `<td class="num" style="font-size:${_rptFontQ}px">${ch.chargeUnite ||"—"}</td>` : ''}
      ${rC("rptColResteCarton") ? `<td class="num" style="font-size:${_rptFontQ}px;color:${resteColor};font-weight:700">${resteCarton!==0?resteCarton:(resteTotal===0?"0":"—")}</td>` : ''}
      ${rC("rptColResteUnite")  ? `<td class="num" style="font-size:${_rptFontQ}px;color:${resteColor};font-weight:700">${resteUnite !==0?resteUnite :(resteTotal===0?"0":"—")}</td>` : ''}
      ${rC("rptColCheck")       ? `<td class="num" style="font-size:${_rptFontQ}px">${line.check?"✓":""}</td>`    : ''}
      ${rC("rptColEcart")       ? `<td class="num" style="font-size:${_rptFontQ}px">${line.ecart!=null?line.ecart:""}</td>` : ''}
      
    </tr>`;
  };

  let bodyHtml;
  if (_rptCols === 2) {
    const half = Math.ceil(allRows.length / 2);
let splitIdx = half;
while (splitIdx < allRows.length && allRows[splitIdx].type !== "cat") splitIdx++;
if (splitIdx >= allRows.length) {
  splitIdx = half;
  while (splitIdx > 0 && allRows[splitIdx].type !== "cat") splitIdx--;
}
const left  = allRows.slice(0, splitIdx).map(buildRow).join("");
const right = allRows.slice(splitIdx).map(buildRow).join("");
    bodyHtml = `
      <div style="display:flex;gap:4mm;align-items:flex-start;">
        <div style="width:calc(50% - 2mm);border-right:1px dashed #aaa;padding-right:4mm;">
          <table><${thead}<tbody>${left}</tbody></table>
        </div>
        <div style="width:calc(50% - 2mm);">
          <table><${thead}<tbody>${right}</tbody></table>
        </div>
      </div>`;
  } else {
    const rows = allRows.map(buildRow).join("");
    bodyHtml = `<table><${thead}<tbody>${rows}</tbody></table>`;
  }

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>
    @page { size: A4; margin: 8mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: ${_rptFontP}px; margin: 0; color: #000; }
    h2 { font-size: 14px; margin: 0 0 2px; color: #1a6b3a; }
    .sub { font-size: 10px; color: #555; margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th { background: #1a6b3a; color: #fff; border: 1px solid #1a6b3a; padding: ${_rptPad}px 4px; text-align: left; font-size: ${_rptFontP}px; }
    td { border: 1px solid #ccc; padding: ${_rptPad}px 4px; word-break: break-word; white-space: normal; }
    .num { text-align: center; width: 36px; }
    tr:nth-child(even) td { background: #f0f7f3; }
    .cat-row td { background: #1a6b3a !important; color: #fff !important; font-weight: bold; font-size: ${_rptFontP}px; }
    tr { page-break-inside: avoid; }
    thead { display: table-header-group; }
  </style></head><body>
  <h2>RAPPORT PRÉPARATION GDS</h2>
  <div class="sub">${date} — ${time}</div>
  ${bodyHtml}
  </body></html>`;

  _downloadAsPdf(html, `rapport_preparation_gds_${dd}-${mm}-${yyyy}`);
}
function _gdsPrepRenderPickingBtns() {
  const pm = _gdsPrep.pickingsMap || {};
  if (!Object.keys(pm).length) return `<div style="font-size:11px;color:var(--text3);padding:6px;">Aucun bon</div>`;

  // ترتيب حسب وقت الـ validation في Odoo (date_done) — الأقدم أولاً
  const entries = Object.entries(pm)
    .map(([pickId, pick]) => ({ pickId: Number(pickId), pick }))
    .sort((a, b) => new Date(a.pick.date_done || 0) - new Date(b.pick.date_done || 0));

  const partnerCount = {};
  let html = "";
  entries.forEach(({ pickId, pick }) => {
    const partnerRaw   = pick.partner_id?.[1] || "Inconnu";
    const partnerClean = _cleanPartnerName(partnerRaw);
    partnerCount[partnerRaw] = (partnerCount[partnerRaw] || 0) + 1;
    const idx   = partnerCount[partnerRaw];
    const label = idx === 1 ? partnerClean : `${partnerClean} (${idx})`;
    const isOn  = _gdsPrep.includedPickings.includes(pick.name);
    const safeName = String(pick.name || "").replace(/'/g, "\\'");

    html += `
      <div class="gds-prep-bon-card" style="opacity:${isOn ? '1' : '0.55'};background:${isOn ? 'var(--bg)' : 'var(--bg3)'};">
        <span style="flex:1;min-width:0;font-size:11px;color:${isOn ? 'var(--text)' : 'var(--text3)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(pick.name || '')}">${escHtml(label)}</span>
        <button title="Imprimer" onclick="event.stopPropagation();_gdsPrepDownloadPickingPdf(${pickId})" style="background:none;border:none;cursor:pointer;font-size:13px;padding:0 3px;color:var(--text2);flex-shrink:0;">🖨</button>
        <div class="gds-prep-toggle" onclick="_gdsPrepTogglePickingInclude('${safeName}')" style="position:relative;width:30px;height:16px;border-radius:20px;background:${isOn ? 'var(--green)' : 'var(--border)'};cursor:pointer;flex-shrink:0;">
          <div style="position:absolute;top:2px;left:${isOn ? '16px' : '2px'};width:12px;height:12px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 1px 3px #0004;"></div>
        </div>
      </div>`;
  });
  return html;
}

function _gdsPrepDownloadPickingPdf(pickId) {
  const pid_str = String(pickId);
  const pick  = _gdsPrep.pickingsMap[pid_str];
  const moves = _gdsPrep.byPicking[pid_str] || [];
  if (!pick) return;

  const partner    = pick.partner_id?.[1] || "—";
  const ref        = pick.name            || "—";
  const van        = pick.van && pick.van !== "—"
    ? pick.van
    : (pick.location_dest_id?.[1] || "").split("/").pop().trim() || "—";
  const dateDone   = pick.date_done
    ? new Date(pick.date_done).toLocaleString("fr-FR")
    : "—";
  // بناء اسم الملف: "LIVREUR RDP 01-01 (11-05-2026) REF00001"
  const _now       = new Date();
  const _dd        = String(_now.getDate()).padStart(2,"0");
  const _mm        = String(_now.getMonth()+1).padStart(2,"0");
  const _yyyy      = _now.getFullYear();
  const _refNum    = (ref.split("/").pop() || ref).trim();
  const _partnerSafe = partner.replace(/\//g,"-");
  const _fileName  = `${_partnerSafe} (${_dd}-${_mm}-${_yyyy}) REF${_refNum}`;

  // تجميع الكميات حسب المنتج مع packaging
  const prodMap = {};
  moves.forEach(m => {
    const pid  = m.product_id?.[0];
    const line = _gdsPrep.lines.find(l => Number(l.pid) === Number(pid));
    const name = line?.name || m.product_id?.[1] || `pid:${pid}`;
    const unitSize = (line?.unitSize > 0) ? line.unitSize : (line?.carton > 0 ? line.qty / line.carton : 0);
    if (!prodMap[name]) prodMap[name] = { qty: 0, unitSize };
    prodMap[name].qty += m.qty_done || 0;
  });

  const categoryOrder = App.settings?.categoryOrder || [];

  const sortedEntries = Object.entries(prodMap).sort(([nameA], [nameB]) => {
    const lineA = _gdsPrep.lines.find(l => l.name === nameA);
    const lineB = _gdsPrep.lines.find(l => l.name === nameB);
    const catA  = lineA?.categ || "";
    const catB  = lineB?.categ || "";
    const idxA  = categoryOrder.indexOf(catA);
    const idxB  = categoryOrder.indexOf(catB);
    const rankA = idxA === -1 ? 9999 : idxA;
    const rankB = idxB === -1 ? 9999 : idxB;
    return rankA - rankB;
  });

  const rows = sortedEntries.map(([name, d], idx) => {
    const u      = d.unitSize > 0 ? Math.round(d.unitSize) : 0;
    const carton = u > 0 ? Math.floor(d.qty / u) : "—";
    const unite  = u > 0 ? Math.round(d.qty % u) : Math.round(d.qty);
    const cleanName = name.replace(/^\[.*?\]\s*/, "");
    return `<tr>
      <td style="text-align:center;color:#888">${idx + 1}</td>
      <td style="font-size:${App.settings?.pdfFontProduct??10}px;">${cleanName}</td>
      <td style="text-align:center;font-size:${App.settings?.pdfFontQty??13}px;font-weight:700;">${carton}</td>
      <td style="text-align:center;font-size:${App.settings?.pdfFontQty??13}px;font-weight:700;">${unite}</td>
      ${App.settings?.showTotalU !== false ? `<td style="text-align:center;font-size:${App.settings?.pdfFontQty??13}px;font-weight:700;">${Math.round(d.qty)}</td>` : ''}
    </tr>`;
  }).join("");

  const tableBlock = `
    <table>
      <thead><tr>
        <th style="text-align:center;width:20px">#</th>
        <th>Produit</th>
        <th style="text-align:center;width:40px">Colis</th>
        <th style="text-align:center;width:40px">U</th>
        ${App.settings?.showTotalU !== false ? '<th style="text-align:center;width:45px">Total U</th>' : ''}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  const infoBlock = `
    <h2>Chargement GDS</h2>
    <div class="info">
      <div><b>Contact :</b> ${partner}</div>
      <div><b>Van :</b> ${van}</div>
      <div><b>Référence :</b> ${ref}</div>
      <div><b>Date :</b> ${dateDone}</div>
    </div>`;

 const _cols     = App.settings?.pdfColumns ?? 2;
  const _rowPad   = App.settings?.pdfRowPadding ?? 1;

  const wrapperHtml = _cols === 1
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
    td { padding: ${_rowPad}px 4px; border: 1px solid #d0d0d0; font-size: 9px; white-space: normal; word-break: normal; overflow-wrap: break-word; line-height: 1.2; }
    tr:nth-child(even) td:not(.cat-row td) { background: #f0f7f3; }
    tr:nth-child(odd)  td { background: #fff; }
  </style></head><body>
  ${wrapperHtml}
  </body></html>`;

  _downloadAsPdf(html, _fileName);
}

// ── PDF download helper (print dialog) ───────────────────────
function _downloadAsPdf(htmlContent, fileName) {
  function _loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) return res();
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  addNotif("⏳ Génération du PDF...", "info");

  Promise.all([
    _loadScript("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"),
    _loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js")
  ]).then(() => {
    const A4_W = 794, A4_H = 1123; // A4 portrait px at 96dpi
const A4_MM_W = 210, A4_MM_H = 297; // A4 in mm

    const iframe = document.createElement("iframe");
    iframe.style.cssText = `position:fixed;top:-9999px;left:-9999px;width:${A4_W}px;height:1px;border:none;`;
    document.body.appendChild(iframe);
    iframe.contentDocument.open();
    iframe.contentDocument.write(htmlContent);
    iframe.contentDocument.close();

    setTimeout(() => {
      const body = iframe.contentDocument.body;
      // انتظار تحميل الخطوط
      (iframe.contentDocument.fonts ? iframe.contentDocument.fonts.ready : Promise.resolve()).then(() => {
      const totalH = body.scrollHeight;
      iframe.style.height = totalH + "px";

      html2canvas(body, { scale: 2, useCORS: true, width: A4_W, windowWidth: A4_W }).then(canvas => {
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
const imgData = canvas.toDataURL("image/jpeg", 0.95);
const imgH_mm = (canvas.height * A4_MM_W) / canvas.width;
let y = 0;
while (y < imgH_mm) {
  if (y > 0) pdf.addPage("a4", "portrait");
  pdf.addImage(imgData, "JPEG", 0, -y, A4_MM_W, imgH_mm);
  y += A4_MM_H;
}
        pdf.save(fileName.endsWith(".pdf") ? fileName : fileName + ".pdf");
        document.body.removeChild(iframe);
        addNotif("✓ PDF téléchargé", "success");
      });
      }); // fonts.ready
    }, 800);
  }).catch(() => {
    addNotif("⚠ Erreur chargement librairies PDF", "error");
  });
}

//////////// fin prep
function setMode(mode) {
  // guard: لا render بدون warehouse
  if (!_getStockLocationId()) {
    const gv = document.getElementById("gdsView");
    if (gv) gv.innerHTML = `
      <div style="padding:40px;text-align:center;color:var(--text3);font-size:13px;">
        ⚠⚠<br>
        <span style="font-size:11px;"></span>
      </div>`;
    if (gv) gv.style.display = "flex";
    return;
  }
  App.currentMode = mode;
  const gv = document.getElementById("gdsView");
  if (gv) gv.style.display = "flex";

  // Open first allowed tab instead of blindly calling all render functions
  if (typeof _applyTabVisibility === "function") {
    _applyTabVisibility(); // will auto-open first allowed tab
  }

  // For admin, default to stock tab
  if (typeof isAdmin === "function" && isAdmin()) {
    renderGdsStock();
    renderGdsVans();
    renderGdsTransferts();
  }
}


function showView(viewName) {
  const views = ["main", "settings"];
  views.forEach(v => {
    const el = document.getElementById(v + "View");
    if (el) el.style.display = (v === viewName) ? "" : "none";
  });
  if (viewName === "settings") renderCategoryOrderUI();
}

function renderMain() {
  setMode(App.currentMode);
}

// ── Category order UI ─────────────────────────────────────────
async function renderCategoryOrderUI() {
  const el = document.getElementById("categoryOrderList");
  if (!el) return;
  // جمع كل الفئات من Odoo
  try {
    const r = await fetch("/api/web/dataset/call_kw", {
      method:"POST", credentials:"include", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:99, params:{
        model:"product.category", method:"search_read",
        args:[[]], kwargs:{ fields:["id","name"], limit:200 }
      }})
    });
    const cats = ((await r.json())?.result || []).map(c => c.name).sort();
    const saved = App.settings?.categoryOrder || [];
    // الفئات المحفوظة أولاً، ثم الباقية
    const ordered = [...saved.filter(c => cats.includes(c)), ...cats.filter(c => !saved.includes(c))];
    _renderCatOrderList(el, ordered);
  } catch(e) {
    el.innerHTML = `<div style="color:var(--danger);font-size:11px;">Erreur: ${e.message}</div>`;
  }
}

function _renderCatOrderList(el, cats) {
  el.innerHTML = cats.map((cat, i) => `
    <div class="cat-order-item" data-cat="${escHtml(cat)}"
      style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;cursor:grab;user-select:none;">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;opacity:.5"><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
      <span style="font-size:11px;flex:1;">${escHtml(cat)}</span>
      <span style="font-size:10px;color:var(--text3);">${i + 1}</span>
    </div>`).join("");
  _initCatOrderDrag(el);
}

function _initCatOrderDrag(container) {
  let dragEl = null, dragOver = null;
  container.querySelectorAll(".cat-order-item").forEach(item => {
    item.addEventListener("dragstart", e => { dragEl = item; item.style.opacity = ".4"; e.dataTransfer.effectAllowed = "move"; });
    item.addEventListener("dragend",   () => { if(dragEl) dragEl.style.opacity = ""; dragEl = null; _saveCatOrder(container); });
    item.addEventListener("dragover",  e => { e.preventDefault(); if (item !== dragEl) { dragOver = item; container.insertBefore(dragEl, item); } });
    item.draggable = true;
  });
}

function _saveCatOrder(container) {
  const order = [...container.querySelectorAll(".cat-order-item")].map(el => el.dataset.cat);
  if (!App.settings) App.settings = {};
  App.settings.categoryOrder = order;
  Storage.saveSettings(App.settings);
  
  // حفظ سحابي
  fetch(`${_FB_DB_URL}/settings.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      categoryOrder:       order,
      showTotalU:          App.settings.showTotalU          ?? true,
      showPrepQty:         App.settings.showPrepQty         ?? true,
      rapportRequireCheck: App.settings.rapportRequireCheck ?? false,
      pdfColumns:          App.settings.pdfColumns          ?? 2,
      pdfFontProduct:      App.settings.pdfFontProduct      ?? 10,
      pdfFontQty:          App.settings.pdfFontQty          ?? 13,
      pdfRowPadding:       App.settings.pdfRowPadding       ?? 1,
      rptColumns:          App.settings.rptColumns          ?? 1,
      rptFontProduct:      App.settings.rptFontProduct      ?? 10,
      rptFontQty:          App.settings.rptFontQty          ?? 11,
      rptRowPadding:       App.settings.rptRowPadding       ?? 3,
      rptColPrepCarton:    App.settings.rptColPrepCarton    ?? true,
      rptColPrepUnite:     App.settings.rptColPrepUnite     ?? true,
      rptColChargCarton:   App.settings.rptColChargCarton   ?? true,
      rptColChargUnite:    App.settings.rptColChargUnite    ?? true,
      rptColResteCarton:   App.settings.rptColResteCarton   ?? true,
      rptColResteUnite:    App.settings.rptColResteUnite    ?? true,
      rptColCheck:         App.settings.rptColCheck         ?? true,
      rptColEcart:         App.settings.rptColEcart         ?? true,
      
    })
  }).catch(e => console.warn("Firebase save failed:", e));
  // تحديث الأرقام
  container.querySelectorAll(".cat-order-item").forEach((el, i) => {
    const numEl = el.querySelector("span:last-child");
    if (numEl) numEl.textContent = i + 1;
  });
}

// ── Save settings ─────────────────────────────────────────────
async function renderWarehouseSettingsUI() {
  const container = document.getElementById("warehouseSettingsSection");
  if (!container) return;
  container.innerHTML = `<div style="font-size:11px;color:var(--text2)">Chargement…</div>`;

  const whs = AppAuth.warehouseDetails || [];
  if (!whs.length) {
    container.innerHTML = `<div style="color:#f87171;font-size:12px;">Aucun entrepôt disponible.</div>`;
    return;
  }

  // جلب إعدادات محفوظة من Firebase
  let saved = {};
  try {
    const r = await fetch(`${_FB_DB_URL}/warehouse_settings.json`);
    saved = (await r.json()) || {};
  } catch(_) {}

  // جلب كل المواقع الداخلية من Odoo لكل warehouse
  let html = "";
  for (const wh of whs) {
    const whSaved = saved[wh.id] || {};
    let locations = [];
    try {
      const viewLocId = wh.view_location_id?.[0];
      const r = await fetch("/api/web/dataset/call_kw", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:0, params:{
          model: "stock.location", method: "search_read",
          args: [[["location_id", "=", viewLocId],["usage","=","internal"]]],
          kwargs: { fields: ["id","name","complete_name"], limit: 100 }
        }})
      });
      const j = await r.json();
      locations = j?.result || [];

      // حفظ المواقع سحابياً إذا نجح الجلب
      if (locations.length) {
        fetch(`${_FB_DB_URL}/warehouse_locations/${wh.id}.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(locations),
        }).catch(() => {});
      }

      // إذا فشل Odoo → جلب من Firebase
      if (!locations.length) {
        try {
          const rFb = await fetch(`${_FB_DB_URL}/warehouse_locations/${wh.id}.json`);
          locations = (await rFb.json()) || [];
        } catch(_) {}
      }
    } catch(e) {
      // Odoo فشل → جلب من Firebase
      try {
        const rFb = await fetch(`${_FB_DB_URL}/warehouse_locations/${wh.id}.json`);
        locations = (await rFb.json()) || [];
      } catch(_) {}
    }

    const opts = locations.map(l =>
      `<option value="${l.id}">${l.complete_name}</option>`
    ).join("");

    html += `
      <div style="margin-bottom:14px;padding:12px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;">
        <div style="font-size:12px;font-weight:700;color:var(--text1);margin-bottom:10px;">🏭 ${wh.name}</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <div>
            <div style="font-size:10px;font-weight:600;color:var(--text2);margin-bottom:4px;">Stock GDS (emplacement affiché)</div>
            <select id="whStock_${wh.id}"
              style="width:100%;padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text1);font-size:11px;">
              <option value="">-- Défaut (lot_stock_id) --</option>
              ${opts}
            </select>
          </div>
          <div>
            <div style="font-size:10px;font-weight:600;color:var(--text2);margin-bottom:4px;">Source Préparation (origine des transferts)</div>
            <select id="whPrep_${wh.id}"
              style="width:100%;padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text1);font-size:11px;">
              <option value="">-- Défaut (lot_stock_id) --</option>
              ${opts}
            </select>
          </div>
        </div>
        <div>
            <div style="font-size:10px;font-weight:600;color:var(--text2);margin-bottom:4px;">Mots à supprimer du nom partenaire</div>
            <textarea id="whStripWords_${wh.id}" rows="3" placeholder="ex:&#10;LIVREUR&#10;ORAN&#10;GDS"
              style="width:100%;padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text1);font-size:11px;box-sizing:border-box;resize:vertical;"></textarea>
            <div style="font-size:10px;color:var(--text3);margin-top:3px;">Un mot/expression par ligne. Insensible à la casse.</div>
          </div>
          <div>
            <div style="font-size:10px;font-weight:600;color:var(--text2);margin-bottom:4px;">Mots à supprimer du nom van/emplacement</div>
            <textarea id="whStripVanWords_${wh.id}" rows="3" placeholder="ex:&#10;Stock.Préparation&#10;Physical Locations&#10;ORAN"
              style="width:100%;padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);color:var(--text1);font-size:11px;box-sizing:border-box;resize:vertical;"></textarea>
            <div style="font-size:10px;color:var(--text3);margin-top:3px;">Un mot/expression par ligne. Insensible à la casse.</div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text2);cursor:pointer;">
            <input type="checkbox" id="whSplitSlash_${wh.id}" style="width:14px;height:14px;accent-color:#4f8ef7;"/>
            Raccourcir après "/" (prendre dernière partie)
          </label>

        <button onclick="_saveWarehouseSettings(${wh.id})"
          style="margin-top:10px;padding:7px 14px;border-radius:6px;background:#4f8ef7;color:#fff;font-size:11px;font-weight:700;border:none;cursor:pointer;">
          Enregistrer
        </button>
        <span id="whSaveMsg_${wh.id}" style="font-size:11px;color:#22c55e;margin-left:8px;"></span>
      </div>`;
  }
  container.innerHTML = html;

  // تعبئة القيم المحفوظة
  for (const wh of whs) {
    const whSaved = saved[wh.id] || {};
    if (whSaved.stockLocationId) {
      const sel = document.getElementById(`whStock_${wh.id}`);
      if (sel) sel.value = whSaved.stockLocationId;
    }
    if (whSaved.prepSourceId) {
      const sel = document.getElementById(`whPrep_${wh.id}`);
      if (sel) sel.value = whSaved.prepSourceId;
    }
   const stripEl = document.getElementById(`whStripWords_${wh.id}`);
    if (stripEl && whSaved.stripWords) stripEl.value = whSaved.stripWords;
    const stripVanEl = document.getElementById(`whStripVanWords_${wh.id}`);
    if (stripVanEl && whSaved.stripVanWords) stripVanEl.value = whSaved.stripVanWords;
    const slashEl = document.getElementById(`whSplitSlash_${wh.id}`);
    if (slashEl) slashEl.checked = !!whSaved.splitSlash;
  }
}

async function _saveWarehouseSettings(whId) {
  const stockSel = document.getElementById(`whStock_${whId}`);
  const prepSel  = document.getElementById(`whPrep_${whId}`);
  const msg      = document.getElementById(`whSaveMsg_${whId}`);
  const stripEl = document.getElementById(`whStripWords_${whId}`);
  const slashEl = document.getElementById(`whSplitSlash_${whId}`);
  const data = {
    stockLocationId: stockSel?.value ? parseInt(stockSel.value) : null,
    prepSourceId:    prepSel?.value  ? parseInt(prepSel.value)  : null,
    stripWords:      stripEl?.value.trim() || "",
    stripVanWords:   document.getElementById(`whStripVanWords_${whId}`)?.value.trim() || "",
    splitSlash:      slashEl?.checked || false,
  };
  try {
    await fetch(`${_FB_DB_URL}/warehouse_settings/${whId}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    // تحديث الـ cache المحلي فوراً
    if (!AppAuth.warehouseSettings) AppAuth.warehouseSettings = {};
    AppAuth.warehouseSettings[whId] = data;
    if (msg) { msg.textContent = "Sauvegardé ✓"; setTimeout(() => msg.textContent = "", 2000); }
  } catch(e) {
    if (msg) { msg.style.color = "#f87171"; msg.textContent = "Erreur: " + e.message; }
  }
}

async function saveSettings() {
  const s = App.settings;
  const saveMsg = document.getElementById("saveMsg");

s.vendors        = (s.vendors||[]).filter(v => v.name.trim());
  s.showTotalU     = document.getElementById("toggleTotalU")?.checked ?? true;
  s.showPrepQty        = document.getElementById("togglePrepQty")?.checked ?? true;
  s.rapportRequireCheck = document.getElementById("toggleRapportCheck")?.checked ?? false;
  s.allowOverstock = document.getElementById("toggleAllowOverstock")?.checked ?? false;
  s.showPrepSearch = document.getElementById("togglePrepSearch")?.checked ?? true;
  s.pdfColumns     = parseInt(document.getElementById("pdfColumns")?.value     || "2");
  s.pdfFontProduct = parseInt(document.getElementById("pdfFontProduct")?.value || "10");
  s.pdfFontQty     = parseInt(document.getElementById("pdfFontQty")?.value     || "13");
  s.pdfRowPadding    = parseInt(document.getElementById("pdfRowPadding")?.value  || "1");
  s.rptColumns       = parseInt(document.getElementById("rptColumns")?.value     || "1");
  s.rptFontProduct   = parseInt(document.getElementById("rptFontProduct")?.value || "10");
  s.rptFontQty       = parseInt(document.getElementById("rptFontQty")?.value     || "11");
  s.rptRowPadding    = parseInt(document.getElementById("rptRowPadding")?.value  || "3");
  s.rptColPrepCarton = document.getElementById("rptColPrepCarton")?.checked ?? true;
  s.rptColPrepUnite  = document.getElementById("rptColPrepUnite")?.checked  ?? true;
  s.rptColChargCarton= document.getElementById("rptColChargCarton")?.checked?? true;
  s.rptColChargUnite = document.getElementById("rptColChargUnite")?.checked ?? true;
  s.rptColResteCarton= document.getElementById("rptColResteCarton")?.checked?? true;
  s.rptColResteUnite = document.getElementById("rptColResteUnite")?.checked ?? true;
  s.rptColCheck      = document.getElementById("rptColCheck")?.checked      ?? true;
  s.rptColEcart      = document.getElementById("rptColEcart")?.checked      ?? true;
  

  await Storage.saveSettings(s);
  // حفظ سحابي على Firebase
  try {
    await fetch(`${_FB_DB_URL}/settings.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        categoryOrder:   s.categoryOrder  || [],
        showTotalU:      s.showTotalU,
        showPrepQty:     s.showPrepQty,
        pdfColumns:      s.pdfColumns,
        pdfFontProduct:  s.pdfFontProduct,
        pdfFontQty:      s.pdfFontQty,
        pdfRowPadding:    s.pdfRowPadding,
        rptColumns:       s.rptColumns,
        rptFontProduct:   s.rptFontProduct,
        rptFontQty:       s.rptFontQty,
        rptRowPadding:    s.rptRowPadding,
        rptColPrepCarton: s.rptColPrepCarton,
        rptColPrepUnite:  s.rptColPrepUnite,
        rptColChargCarton:s.rptColChargCarton,
        rptColChargUnite: s.rptColChargUnite,
        rptColResteCarton:s.rptColResteCarton,
        rptColResteUnite: s.rptColResteUnite,
        rptColCheck:      s.rptColCheck,
        rptColEcart:      s.rptColEcart,
        rapportRequireCheck: s.rapportRequireCheck
        , showPrepSearch: s.showPrepSearch
      })
    });
  } catch(e) { console.warn("Firebase save failed:", e); }
  if (saveMsg) { saveMsg.textContent="Sauvegardé ✓"; saveMsg.className="save-msg ok"; setTimeout(()=>{ saveMsg.textContent=""; }, 2000); }
  addNotif("Paramètres sauvegardés ✓", "success");
}




// ── View switcher ─────────────────────────────────────────────
function showView(viewName) {
  const views = ["main", "settings"];
  views.forEach(v => {
    const el = document.getElementById(v + "View");
    if (el) el.style.display = (v === viewName) ? "" : "none";
  });
  if (viewName === "settings") renderCategoryOrderUI();
}

function renderMain() {
  setMode(App.currentMode);
}

// ── bindEvents ────────────────────────────────────────────────
function bindEvents() {
  window.addEventListener("resize", () => {
    if (document.querySelector(".gds-prep-main-table")) _gdsPrepApplyColWidths();
  });
  document.getElementById("btnSettings")?.addEventListener("click", async () => {
  document.getElementById("viewMain").style.display = "none";
  document.getElementById("viewSettings").style.display = "flex";
  renderCategoryOrderUI();
  const tog = document.getElementById("toggleTotalU");
  const fb = await fetch(`${_FB_DB_URL}/settings.json`).then(r=>r.json()).catch(()=>null);
  if (fb) {
    if (fb.showTotalU          !== undefined) App.settings.showTotalU          = fb.showTotalU;
    if (fb.showPrepQty         !== undefined) App.settings.showPrepQty         = fb.showPrepQty;
    if (fb.rapportRequireCheck !== undefined) App.settings.rapportRequireCheck = fb.rapportRequireCheck;
	if (fb.showPrepSearch !== undefined) App.settings.showPrepSearch = fb.showPrepSearch;
    if (fb.pdfColumns          !== undefined) App.settings.pdfColumns          = fb.pdfColumns;
    if (fb.pdfFontProduct      !== undefined) App.settings.pdfFontProduct      = fb.pdfFontProduct;
    if (fb.pdfFontQty          !== undefined) App.settings.pdfFontQty          = fb.pdfFontQty;
    if (fb.pdfRowPadding       !== undefined) App.settings.pdfRowPadding       = fb.pdfRowPadding;
    if (fb.rptColumns          !== undefined) App.settings.rptColumns          = fb.rptColumns;
    if (fb.rptFontProduct      !== undefined) App.settings.rptFontProduct      = fb.rptFontProduct;
    if (fb.rptFontQty          !== undefined) App.settings.rptFontQty          = fb.rptFontQty;
    if (fb.rptRowPadding       !== undefined) App.settings.rptRowPadding       = fb.rptRowPadding;
    if (fb.rptColPrepCarton    !== undefined) App.settings.rptColPrepCarton    = fb.rptColPrepCarton;
    if (fb.rptColPrepUnite     !== undefined) App.settings.rptColPrepUnite     = fb.rptColPrepUnite;
    if (fb.rptColChargCarton   !== undefined) App.settings.rptColChargCarton   = fb.rptColChargCarton;
    if (fb.rptColChargUnite    !== undefined) App.settings.rptColChargUnite    = fb.rptColChargUnite;
    if (fb.rptColResteCarton   !== undefined) App.settings.rptColResteCarton   = fb.rptColResteCarton;
    if (fb.rptColResteUnite    !== undefined) App.settings.rptColResteUnite    = fb.rptColResteUnite;
    if (fb.rptColCheck         !== undefined) App.settings.rptColCheck         = fb.rptColCheck;
    if (fb.rptColEcart         !== undefined) App.settings.rptColEcart         = fb.rptColEcart;
    
  }
  if (tog) tog.checked = App.settings?.showTotalU !== false;
  const togPQ = document.getElementById("togglePrepQty");
  if (togPQ) togPQ.checked = App.settings?.showPrepQty !== false;
  const togRC = document.getElementById("toggleRapportCheck");
  if (togRC) togRC.checked = App.settings?.rapportRequireCheck === true;
  const togOV = document.getElementById("toggleAllowOverstock");
  if (togOV) togOV.checked = App.settings?.allowOverstock === true;
  const togPS = document.getElementById("togglePrepSearch");
  if (togPS) togPS.checked = App.settings?.showPrepSearch !== false;
  const s = App.settings || {};
  const elSet = (id, val) => { const e = document.getElementById(id); if(e) e.value = val; };
  elSet("pdfColumns",      s.pdfColumns      ?? 2);
  elSet("pdfFontProduct",  s.pdfFontProduct  ?? 10);
  elSet("pdfFontQty",      s.pdfFontQty      ?? 13);
  elSet("pdfRowPadding",   s.pdfRowPadding   ?? 1);
  elSet("rptColumns",      s.rptColumns      ?? 1);
  elSet("rptFontProduct",  s.rptFontProduct  ?? 10);
  elSet("rptFontQty",      s.rptFontQty      ?? 11);
  elSet("rptRowPadding",   s.rptRowPadding   ?? 3);
  const chk = (id, val) => { const e = document.getElementById(id); if(e) e.checked = val; };
  chk("rptColPrepCarton",  s.rptColPrepCarton  ?? true);
  chk("rptColPrepUnite",   s.rptColPrepUnite   ?? true);
  chk("rptColChargCarton", s.rptColChargCarton ?? true);
  chk("rptColChargUnite",  s.rptColChargUnite  ?? true);
  chk("rptColResteCarton", s.rptColResteCarton ?? true);
  chk("rptColResteUnite",  s.rptColResteUnite  ?? true);
  chk("rptColCheck",       s.rptColCheck       ?? true);
  chk("rptColEcart",       s.rptColEcart       ?? true);
  
});
if (isAdmin()) {
  const container = document.getElementById("userManagementContainer");
  if (container) container.style.display = "";
  const rpc = document.getElementById("rolePermissionsContainer");
  if (rpc) rpc.style.display = "";
  renderUserManagementUI();
  renderRolePermissionsUI();
}
  document.getElementById("btnBack")?.addEventListener("click", () => {
  document.getElementById("viewSettings").style.display = "none";
  document.getElementById("viewMain").style.display = "";
});
  document.getElementById("btnClearNotifs")?.addEventListener("click", () => { const l=document.getElementById("notifList"); if(l) l.innerHTML=""; });
  document.getElementById("btnSaveSettings")?.addEventListener("click", saveSettings);
  document.getElementById("btnRefreshCats")?.addEventListener("click", renderCategoryOrderUI);
  document.getElementById("toggleTotalU")?.addEventListener("change", e => {
    App.settings.showTotalU = e.target.checked;
    saveSettings();
  });
  document.getElementById("togglePrepQty")?.addEventListener("change", e => {
    App.settings.showPrepQty = e.target.checked;
    saveSettings();
  });
  document.getElementById("toggleRapportCheck")?.addEventListener("change", e => {
    App.settings.rapportRequireCheck = e.target.checked;
    saveSettings();
  });
  document.getElementById("toggleAllowOverstock")?.addEventListener("change", e => {
    App.settings.allowOverstock = e.target.checked;
    saveSettings();
  });
  document.getElementById("togglePrepSearch")?.addEventListener("change", e => {
    App.settings.showPrepSearch = e.target.checked;
    saveSettings();
    renderGdsPreparation();
  });

  ["pdfColumns","pdfFontProduct","pdfFontQty","pdfRowPadding",
   "rptColumns","rptFontProduct","rptFontQty","rptRowPadding",
   "rptColPrepCarton","rptColPrepUnite","rptColChargCarton","rptColChargUnite",
   "rptColResteCarton","rptColResteUnite","rptColCheck","rptColEcart"
  ].forEach(id => {
    document.getElementById(id)?.addEventListener("change", () => saveSettings());
  });
// ── RPC helper (used by Stock Final) ─────────────────────────
async function _rpc_call(baseUrl, payload) {
  const base = (baseUrl || "").replace(/\/$/, "");
  const resp = await fetch("/api/web/dataset/call_kw", {
    method:      "POST",
    credentials: "include",
    headers:     { "Content-Type": "application/json" },
    body:        JSON.stringify({ jsonrpc:"2.0", method:"call", id:Date.now(), params:payload }),
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const json = await resp.json().catch(() => ({}));
  if (json?.error) throw new Error(json.error?.data?.message || "Odoo error");
  return json.result;
}

// ── Stock Final — Gestion distributeurs ──────────────────────
function _sfDistKey() {
  const whId = _getWarehouseId() || "default";
  return `sf_distributeurs_${whId}`;
}
window.sfGetDistributeurs = function sfGetDistributeurs() {
  try { return JSON.parse(localStorage.getItem(_sfDistKey()) || "[]"); } catch { return []; }
}
window.sfSaveDistributeurs = function sfSaveDistributeurs(list) {
  localStorage.setItem(_sfDistKey(), JSON.stringify(list));
  fetch(`${_FB_DB_URL}/${_sfDistKey()}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(list),
  }).catch(e => console.warn("SF distributeurs sync failed:", e));
}
window.sfClearDistributeurs = function sfClearDistributeurs() {
  sfSaveDistributeurs([]);
  document.getElementById("sfImportStatus").textContent = "Liste effacée.";
  sfRenderDistributeursList([]);
}

window.sfImportDistributeurs = function sfImportDistributeurs(input) {
  const file = input.files[0];
  if (!file) return;
  const statusEl = document.getElementById("sfImportStatus");
  statusEl.textContent = "Lecture en cours…";

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const wb   = XLSX.read(e.target.result, { type: "array" });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

      const imported = rows
        .map(r => ({
          nom: String(r["NOM"] || r["nom"] || r["Nom"] || "").trim(),
          id:  String(r["ID"]  || r["id"]  || r["Id"]  || "").trim(),
        }))
        .filter(r => r.nom && r.id);

      if (!imported.length) { statusEl.textContent = "❌ Aucune ligne valide (vérifiez les colonnes NOM et ID)."; return; }

      // دمج مع القائمة الموجودة (تجنب التكرار)
      const existing = sfGetDistributeurs();
      const merged = [...existing];
      imported.forEach(imp => {
        if (!merged.find(e => e.id === imp.id)) merged.push(imp);
      });

      sfSaveDistributeurs(merged);
      statusEl.textContent = `✓ ${imported.length} importé(s) — total: ${merged.length}`;
      sfRenderDistributeursList(merged);
    } catch(err) {
      statusEl.textContent = "❌ Erreur: " + err.message;
    }
  };
  reader.readAsArrayBuffer(file);
  input.value = "";
}

window.sfAddDistributeurRow = function sfAddDistributeurRow() {
  const list = sfGetDistributeurs();
  list.push({ nom: "", id: "" });
  sfSaveDistributeurs(list);
  sfRenderDistributeursList(list);
  // focus sur le dernier input NOM
  setTimeout(() => {
    const inputs = document.querySelectorAll(".sf-row-nom");
    inputs[inputs.length - 1]?.focus();
  }, 50);
}

window.sfDeleteDistributeur = function sfDeleteDistributeur(idx) {
  const list = sfGetDistributeurs();
  list.splice(idx, 1);
  sfSaveDistributeurs(list);
  sfRenderDistributeursList(list);
}

window.sfUpdateDistributeur = function sfUpdateDistributeur(idx, field, value) {
  const list = sfGetDistributeurs();
  if (!list[idx]) return;
  list[idx][field] = value.trim();
  sfSaveDistributeurs(list);
}

window.sfRenderDistributeursList = function sfRenderDistributeursList(list) {
  const container = document.getElementById("sfDistributeursList");
  if (!container) return;
  if (!list.length) {
    container.innerHTML = `<div style="font-size:11px;color:var(--text3);padding:8px 0;">Aucun distributeur.</div>`;
    return;
  }
  container.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <thead><tr style="background:var(--bg3);">
        <th style="padding:5px 8px;text-align:left;color:var(--text2);">NOM</th>
        <th style="padding:5px 8px;text-align:left;color:var(--text2);">ID</th>
        <th style="padding:5px 8px;width:28px;"></th>
      </tr></thead>
      <tbody>
        ${list.map((r, i) => `
        <tr style="background:${i%2===0?"var(--bg1)":"var(--bg2)"};">
          <td style="padding:3px 6px;">
            <input class="sf-row-nom" value="${r.nom.replace(/"/g,'&quot;')}"
              onchange="sfUpdateDistributeur(${i},'nom',this.value)"
              style="width:100%;background:transparent;border:none;border-bottom:1px solid var(--border);color:var(--text1);font-size:11px;padding:2px 2px;outline:none;"/>
          </td>
          <td style="padding:3px 6px;">
            <input value="${r.id.replace(/"/g,'&quot;')}"
              onchange="sfUpdateDistributeur(${i},'id',this.value)"
              style="width:100%;background:transparent;border:none;border-bottom:1px solid var(--border);color:var(--text2);font-size:11px;padding:2px 2px;outline:none;"/>
          </td>
          <td style="padding:3px 4px;text-align:center;">
            <button onclick="sfDeleteDistributeur(${i})"
              style="background:none;border:none;cursor:pointer;color:#f87171;font-size:13px;line-height:1;padding:0;">✕</button>
          </td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

// ── Stock Final — toggle distributor panel ────────────────────
window.sfToggleDist = function(id) {
  const body  = document.getElementById(id);
  const arrow = document.getElementById("arrow_" + id);
  if (!body) return;
  const isOpen = body.style.display === "block";
  body.style.display  = isOpen ? "none" : "block";
  if (arrow) arrow.style.transform = isOpen ? "" : "rotate(90deg)";
};

window.sfRefreshDist = async function(distId, distNom, distSafeId) {
  const body = document.getElementById(distSafeId);
  if (!body) return;
  body.style.display = "block";
  const arrow = document.getElementById("arrow_" + distSafeId);
  if (arrow) arrow.style.transform = "rotate(90deg)";
  body.innerHTML = `<div style="color:var(--text3);font-size:11px;padding:6px;">Chargement…</div>`;

  const baseUrl = ODOO_BASE;
  const targetDate = window._sfSelectedDate || new Date().toISOString().slice(0, 10);
  try {
    const plannings = await _rpc_call(baseUrl, {
      model: "planning.planning", method: "search_read",
      args: [[["user_id.id", "=", parseInt(distId)], ["date_start", "=", targetDate]]],
      kwargs: { fields: ["id", "name", "date_start"] },
    });
    if (!plannings?.length) { body.innerHTML = `<div style="padding:6px;font-size:11px;color:var(--text3);">Aucune tournée trouvée.</div>`; return; }

    let bodyHtml = "";
    for (const round of plannings) {
      const lines = await _rpc_fetchStockFinal(baseUrl, round.id);
      if (!lines.length) {
        bodyHtml += `<div style="margin-bottom:10px;">
          <div style="margin-bottom:4px;color:var(--text2);font-size:10px;font-weight:600;">🔄 Tournée: ${round.name || round.id}</div>
          <div style="color:var(--text3);font-size:11px;">Stock final vide.</div>
        </div>`;
        continue;
      }
      let tableHtml = `
        <div style="margin-bottom:10px;">
          <div style="margin-bottom:4px;color:var(--text2);font-size:10px;font-weight:600;">🔄 Tournée: ${round.name || round.id}</div>
          <table style="width:100%;border-collapse:collapse;font-size:11px;">
            <thead><tr style="background:var(--bg3);">
              <th style="padding:4px 6px;text-align:left;color:var(--text2);">Article</th>
              <th style="padding:4px 6px;text-align:center;color:var(--text2);">CDN</th>
              <th style="padding:4px 6px;text-align:center;color:var(--text2);">Qté</th>
            </tr></thead><tbody>`;
      lines.forEach((l, i) => {
        const cdn = l._cdn_override !== undefined && l._cdn_override !== null
          ? l._cdn_override
          : (l.packaging_qty > 0 ? +(l.qty / l.packaging_qty).toFixed(2) : "—");
        tableHtml += `<tr style="background:${i%2===0?"var(--bg1)":"var(--bg2)"};">
          <td style="padding:3px 6px;color:var(--text1);">${l.name}</td>
          <td style="padding:3px 6px;text-align:center;color:var(--text2);">${cdn}</td>
          <td style="padding:3px 6px;text-align:center;font-weight:600;color:var(--text1);">${l.qty}</td>
        </tr>`;
      });
      const roundLabel = `${distNom} - ${round.name || round.id}`;
      tableHtml += `</tbody></table>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button onclick='exportStockFinalXlsx("${roundLabel}", ${JSON.stringify(lines)})' style="flex:1;padding:10px;font-size:13px;font-weight:700;letter-spacing:1px;background:#22c55e;color:#fff;border:none;border-radius:6px;cursor:pointer;">EXPORT</button>
          <button onclick='exportStockFinalPdf("${roundLabel}", ${JSON.stringify(lines)})' style="flex:1;padding:10px;font-size:13px;font-weight:700;letter-spacing:1px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;">EXPORT</button>
        </div>
      </div>`;
      bodyHtml += tableHtml;
    }
    body.innerHTML = bodyHtml;
    body.style.padding = "8px";
  } catch(err) {
    body.innerHTML = `<span style="color:#f87171;">Erreur: ${err.message}</span>`;
  }
};

// ── Stock Final — جلب الليفرورين من Odoo تلقائياً ────────────
async function _sfFetchLivreurs() {
  try {
    const since = new Date();
    since.setMonth(since.getMonth() - 3);
    const sinceStr = since.toISOString().slice(0, 10);

    const r = await fetch("/api/web/dataset/call_kw", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:0, params:{
        model: "planning.planning", method: "search_read",
        args: [[["date_start", ">=", sinceStr], ["user_id.name", "ilike", "LIVREUR"]]],
        kwargs: { fields: ["user_id"], limit: 2000 }
      }})
    });
    const result = (await r.json())?.result || [];

    // تجميع فريد بـ user_id
    const seen = {};
    result.forEach(p => {
      if (p.user_id) seen[p.user_id[0]] = p.user_id[1];
    });

    return Object.entries(seen).map(([id, nom]) => ({
      id: parseInt(id),
      nom: _cleanPartnerName(nom)
    })).sort((a, b) => a.nom.localeCompare(b.nom, "fr", { sensitivity: "base" }));
  } catch(e) {
    console.warn("_sfFetchLivreurs failed:", e);
    return [];
  }
}

// ── Stock Final — render tab ──────────────────────────────────
// الدالة الموحدة: تتحقق من cache أولاً، وتجلب من الشبكة إذا لم يوجد
window.sfRenderFromCache = async function sfRenderFromCache() {
  const el = document.getElementById("gdsStockFinalContent");
  if (!el) return;

  const today     = new Date().toISOString().slice(0, 10);
  const savedDate = window._sfSelectedDate || today;
  const isToday   = savedDate === today;

  // ── رسم الهيكل دائماً (date bar + أزرار)
  el.innerHTML = `
    <div class="date-switcher-bar" data-perm="sf_date_bar" style="flex-shrink:0;">
      <button class="ds-arrow" onclick="window._sfSelectedDate=new Date(new Date(window._sfSelectedDate||new Date().toISOString().slice(0,10)).getTime()-86400000).toISOString().slice(0,10); sfRenderFromCache();">&#8249;</button>
      <div class="ds-label ${isToday ? 'ds-label--today' : ''}" style="position:relative;" onclick="document.getElementById('sfHiddenDate').showPicker()">
        <span class="ds-date-text">${savedDate}</span>
        ${isToday ? '<span class="ds-today-pill">Auj</span>' : ''}
        <input type="date" id="sfHiddenDate" value="${savedDate}"
          style="position:absolute;opacity:0;width:0;height:0;pointer-events:none;"
          onchange="window._sfSelectedDate=this.value; sfRenderFromCache();" />
      </div>
      <button class="ds-arrow" ${isToday ? 'disabled' : ''} onclick="window._sfSelectedDate=new Date(new Date(window._sfSelectedDate||new Date().toISOString().slice(0,10)).getTime()+86400000).toISOString().slice(0,10); sfRenderFromCache();">&#8250;</button>
    </div>
    <div style="display:flex;gap:6px;padding:6px 10px;flex-shrink:0;border-bottom:1px solid var(--border);flex-wrap:wrap;align-items:center;">
      <button class="gds-refresh-btn" data-perm="sf_btn_refresh" onclick="renderGdsStockFinal()">↻ Actualiser</button>
      <button class="gds-refresh-btn" data-perm="sf_btn_today" onclick="window._sfSelectedDate=new Date().toISOString().slice(0,10); sfRenderFromCache();">📅 Aujourd'hui</button>
      <button class="gds-refresh-btn" data-perm="sf_btn_export" onclick="sfExportAll('xlsx')">⬇ Tout exporter Excel</button>
      <button class="gds-refresh-btn" data-perm="sf_btn_export" style="background:var(--red);" onclick="sfExportAll('pdf')">🖨 Tout exporter PDF</button>
    </div>
    <div id="sfResultsContainer" style="padding:8px;display:grid;align-items:start;gap:10px;"></div>`;

  let distributeurs = sfGetDistributeurs();
  const container   = document.getElementById("sfResultsContainer");
  if (!container) return;

  // إذا القائمة فارغة → جلب تلقائي من Odoo
  if (!distributeurs.length) {
    container.innerHTML = `<div style="padding:20px;color:var(--text3);font-size:12px;text-align:center;">Chargement des livreurs…</div>`;
    distributeurs = await _sfFetchLivreurs();
    if (distributeurs.length) sfSaveDistributeurs(distributeurs);
  }

  // ترتيب أبجدي دائماً
  distributeurs.sort((a, b) => a.nom.localeCompare(b.nom, "fr", { sensitivity: "base" }));

  const sfMaxCols  = parseInt(localStorage.getItem("sf_columns_per_row") || "1");
  const screenW    = window.innerWidth;
  const actualCols = screenW < 480 ? 1 : screenW < 768 ? Math.min(sfMaxCols, 2) : sfMaxCols;
  container.style.gridTemplateColumns = `repeat(${actualCols},1fr)`;

  // ── تحقق من cache لكل موزع
  const missing = []; // موزعين ليس لهم cache في هذا التاريخ
  distributeurs.forEach(dist => {
    const cached     = localStorage.getItem(`sf_cache_${savedDate}_${dist.id}`);
    const distSafeId = "sf_dist_" + dist.id;
    const section    = document.createElement("div");
    section.style.cssText = "border:1px solid var(--border);border-radius:8px;overflow:hidden;";
    section.innerHTML = `
      <div style="padding:7px 12px;background:var(--bg2);font-size:12px;font-weight:600;color:var(--text1);display:flex;justify-content:space-between;align-items:center;cursor:pointer;"
        onclick="sfToggleDist('${distSafeId}')">
        <span>📦 ${dist.nom}</span>
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="gds-refresh-btn" style="font-size:10px;padding:2px 7px;" onclick="event.stopPropagation(); sfRefreshDist('${dist.id}','${dist.nom}','${distSafeId}')">↻</button>
          <span id="arrow_${distSafeId}" style="font-size:11px;color:var(--text3);transition:transform 0.2s;">▶</span>
        </div>
      </div>
      <div id="${distSafeId}" class="sf-dist-body" style="display:none;padding:8px;">
        ${cached || '<span style="color:var(--text3);font-size:11px;">Chargement…</span>'}
      </div>`;
    container.appendChild(section);
    if (!cached) missing.push(dist);
  });

  if (!distributeurs.length) {
    container.innerHTML = `<div style="padding:20px;color:var(--text3);font-size:12px;text-align:center;">Appuyez sur <b>↻ Actualiser</b> pour charger le stock final.</div>`;
    return;
  }

  // ── جلب من الشبكة فقط للموزعين الغائبين عن cache
  if (missing.length) {
    const baseUrl = ODOO_BASE;
    if (!baseUrl) return;
    for (const dist of missing) {
      const distSafeId = "sf_dist_" + dist.id;
      const body = document.getElementById(distSafeId);
      try {
        const plannings = await _rpc_call(baseUrl, {
          model: "planning.planning", method: "search_read",
          args: [[["user_id.id", "=", parseInt(dist.id)], ["date_start", "=", savedDate]]],
          kwargs: { fields: ["id", "name", "date_start"] },
        });
        if (!plannings?.length) { if (body) body.textContent = "Aucune tournée trouvée."; continue; }

        let allDistLines = [];
        let bodyHtml = "";
        for (const round of plannings) {
          const lines = await _rpc_fetchStockFinal(baseUrl, round.id);
          if (!lines.length) {
            bodyHtml += `<div style="margin-bottom:10px;">
              <div style="margin-bottom:4px;color:var(--text2);font-size:10px;font-weight:600;">🔄 Tournée: ${round.name || round.id}</div>
              <div style="color:var(--text3);font-size:11px;">Stock final vide.</div>
            </div>`;
            continue;
          }
          let tableHtml = `
            <div style="margin-bottom:10px;">
              <div style="margin-bottom:4px;color:var(--text2);font-size:10px;font-weight:600;">🔄 Tournée: ${round.name || round.id}</div>
              <table style="width:100%;border-collapse:collapse;font-size:11px;">
                <thead><tr style="background:var(--bg3);">
                  <th style="padding:4px 6px;text-align:left;color:var(--text2);">Article</th>
                  <th style="padding:4px 6px;text-align:center;color:var(--text2);">CDN</th>
                  <th style="padding:4px 6px;text-align:center;color:var(--text2);">Qté</th>
                </tr></thead><tbody>`;
          lines.forEach((l, i) => {
            const cdn = l._cdn_override !== undefined && l._cdn_override !== null
              ? l._cdn_override
              : (l.packaging_qty > 0 ? +(l.qty / l.packaging_qty).toFixed(2) : "—");
            tableHtml += `<tr style="background:${i%2===0?"var(--bg1)":"var(--bg2)"};">
              <td style="padding:3px 6px;color:var(--text1);">${l.name}</td>
              <td style="padding:3px 6px;text-align:center;color:var(--text2);">${cdn}</td>
              <td style="padding:3px 6px;text-align:center;font-weight:600;color:var(--text1);">${l.qty}</td>
            </tr>`;
          });
          const roundDate = (round.date_start || savedDate).slice(0, 10).split("-").reverse().join("/");
          const roundLabel = `${dist.nom} - ${round.name || round.id} - ${roundDate}`;
          tableHtml += `</tbody></table>
            <div style="display:flex;gap:6px;margin-top:6px;">
            
            <button class="gds-refresh-btn" style="flex:1;padding:10px;font-size:13px;font-weight:700;letter-spacing:1px;background:var(--red);" onclick='exportStockFinalPdf("${roundLabel}", ${JSON.stringify(lines)})'>🖨 PDF</button>
			<button class="gds-refresh-btn" style="flex:1;padding:10px;font-size:13px;font-weight:700;letter-spacing:1px;" onclick='exportStockFinalXlsx("${roundLabel}", ${JSON.stringify(lines)})'>📊 EXCEL</button>
          </div>
          </div>`;
          bodyHtml += tableHtml;
          lines.forEach(l => allDistLines.push({ ...l, _roundLabel: round.name || round.id }));
        }
        if (body) { body.innerHTML = bodyHtml; body.style.padding = "8px"; }
        try { localStorage.setItem(`sf_cache_${savedDate}_${dist.id}`, bodyHtml); } catch(_) {}
      } catch(err) {
        if (body) body.innerHTML = `<span style="color:#f87171;">Erreur: ${err.message}</span>`;
      }
    }
    try { localStorage.setItem("sf_cache_last_date", savedDate); } catch(_) {}
  }
};

// ── Force refresh: يمسح cache اليوم الحالي ويعيد الجلب من الشبكة
window.renderGdsStockFinal = async function renderGdsStockFinal() {
  if (!isAdmin() && !_hasTabPerm("stockfinal")) return;
  let distributeurs = sfGetDistributeurs();
  if (!distributeurs.length) {
    distributeurs = await _sfFetchLivreurs();
    if (distributeurs.length) sfSaveDistributeurs(distributeurs);
  }
  if (!distributeurs.length) {
    const el = document.getElementById("gdsStockFinalContent");
    if (el) el.innerHTML = `<div style="padding:20px;color:var(--text3);font-size:13px;text-align:center;">
      ⚠ Aucun livreur trouvé dans Odoo.<br>
      <span style="font-size:11px;">Vérifiez que les utilisateurs ont le workflow LIVREUR.</span>
    </div>`;
    return;
  }
  const baseUrl = ODOO_BASE;
  if (!baseUrl) return;
  // مسح cache التاريخ الحالي لإجبار إعادة الجلب
  const targetDate = window._sfSelectedDate || new Date().toISOString().slice(0, 10);
  distributeurs.forEach(dist => {
    try { localStorage.removeItem(`sf_cache_${targetDate}_${dist.id}`); } catch(_) {}
  });
  // تفويض لـ sfRenderFromCache التي ستجلب من الشبكة لأن الـ cache فارغ
  await sfRenderFromCache();
}


window.sfExportAll = async function sfExportAll(format = 'xlsx') {
  const distributeurs = sfGetDistributeurs();
  const baseUrl = ODOO_BASE;
  if (!baseUrl || !distributeurs.length) return;

  const savedDate = window._sfSelectedDate || new Date().toISOString().slice(0, 10);
  addNotif(`Export en cours…`, "info");

  if (format === 'xlsx') {
    // تحميل SheetJS
    if (!window.XLSX) {
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    const wb = window.XLSX.utils.book_new();
    const allRows = [];
    for (const dist of distributeurs) {
      try {
        const plannings = await _rpc_call(baseUrl, {
          model: "planning.planning", method: "search_read",
          args: [[["user_id.id", "=", parseInt(dist.id)], ["date_start", "=", savedDate]]],
          kwargs: { fields: ["id", "name", "date_start"] },
        });
        if (!plannings?.length) continue;
        let distHasData = false;
        for (const round of plannings) {
          const lines = await _rpc_fetchStockFinal(baseUrl, round.id);
          if (!lines.length) continue;
          if (!distHasData) {
            // عنوان الموزع
            allRows.push([`▶ ${dist.nom}`, "", ""]);
            distHasData = true;
          }
          const roundDate = (round.date_start || savedDate).slice(0, 10).split("-").reverse().join("/");
          allRows.push([`  Tournée: ${round.name || round.id} — ${roundDate}`, "", ""]);
          allRows.push(["  Article", "CDN", "Quantité"]);
          lines.forEach(l => {
            const cdn = l._cdn_override != null ? l._cdn_override
              : (l.packaging_qty > 0 ? +(l.qty / l.packaging_qty).toFixed(2) : "");
            allRows.push([`  ${l.name}`, cdn, l.qty]);
          });
          allRows.push(["", "", ""]);
        }
      } catch(err) { addNotif(`Erreur ${dist.nom}: ${err.message}`, "error"); }
    }
    if (allRows.length) {
      const ws = window.XLSX.utils.aoa_to_sheet(allRows);
      window.XLSX.utils.book_append_sheet(wb, ws, "Stock Final");
      const dateLabel = savedDate.split("-").reverse().join("-");
      window.XLSX.writeFile(wb, `stock_final_${dateLabel}.xlsx`);
    }
    addNotif(`✓ Export Excel terminé`, "success");
    return;
  }

  // PDF: ملف واحد لكل موزع يضم جميع جولاته
  function _loadPdfLibs(cb) {
    if (window.jspdf?.jsPDF?.prototype?.autoTable) { cb(); return; }
    const s1 = document.createElement("script");
    s1.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    s1.onload = () => {
      const s2 = document.createElement("script");
      s2.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js";
      s2.onload = cb;
      document.head.appendChild(s2);
    };
    document.head.appendChild(s1);
  }

  _loadPdfLibs(async () => {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    let isFirst = true;

    for (const dist of distributeurs) {
      try {
        const plannings = await _rpc_call(baseUrl, {
          model: "planning.planning", method: "search_read",
          args: [[["user_id.id", "=", parseInt(dist.id)], ["date_start", "=", savedDate]]],
          kwargs: { fields: ["id", "name", "date_start"] },
        });
        if (!plannings?.length) continue;

        for (const round of plannings) {
          const lines = await _rpc_fetchStockFinal(baseUrl, round.id);
          if (!lines.length) continue;
          const roundDate = (round.date_start || savedDate).slice(0, 10).split("-").reverse().join("/");
          const filtered = lines.filter(l => l.qty > 0);

          if (!isFirst) doc.addPage();
          isFirst = false;

          // عنوان الموزع
          doc.setFontSize(13); doc.setFont(undefined, "bold");
          doc.text(dist.nom, 14, 14);
          // عنوان الـ tournée
          doc.setFontSize(10); doc.setFont(undefined, "normal");
          doc.text(`Tournée: ${round.name || round.id} — ${roundDate}`, 14, 21);

          doc.autoTable({
            startY: 26,
            head: [["Article", "CDN", "Quantité"]],
            body: filtered.map(l => {
              const cdn = l._cdn_override != null ? l._cdn_override
                : (l.packaging_qty > 0 ? +(l.qty / l.packaging_qty).toFixed(2) : "");
              return [l.name, cdn, l.qty];
            }),
            styles: { fontSize: 8, cellPadding: 2 },
            headStyles: { fillColor: [26, 107, 58] },
            columnStyles: { 1: { halign: "center" }, 2: { halign: "center" } },
          });
        }
      } catch(err) { addNotif(`Erreur ${dist.nom}: ${err.message}`, "error"); }
    }

    if (!isFirst) {
      const dateLabel = savedDate.split("-").reverse().join("-");
      doc.save(`stock_final_${dateLabel}.pdf`);
    }
    addNotif(`✓ Export PDF terminé`, "success");
  });
};
window.sfExportDistPdf = async function sfExportDistPdf(distId, distNom) {
  const baseUrl = ODOO_BASE;
  const savedDate = window._sfSelectedDate || new Date().toISOString().slice(0, 10);

  function _loadPdfLibs(cb) {
    if (window.jspdf?.jsPDF?.prototype?.autoTable) { cb(); return; }
    const s1 = document.createElement("script");
    s1.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    s1.onload = () => {
      const s2 = document.createElement("script");
      s2.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js";
      s2.onload = cb;
      document.head.appendChild(s2);
    };
    document.head.appendChild(s1);
  }

  _loadPdfLibs(async () => {
    const { jsPDF } = window.jspdf;
    try {
      const plannings = await _rpc_call(baseUrl, {
        model: "planning.planning", method: "search_read",
        args: [[["user_id.id", "=", parseInt(distId)], ["date_start", "=", savedDate]]],
        kwargs: { fields: ["id", "name", "date_start"] },
      });
      if (!plannings?.length) { addNotif(`Aucune tournée pour ${distNom}`, "info"); return; }

      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      let isFirst = true;

      for (const round of plannings) {
        const lines = await _rpc_fetchStockFinal(baseUrl, round.id);
        if (!lines.length) continue;
        const roundDate = (round.date_start || savedDate).slice(0, 10).split("-").reverse().join("/");
        const filtered = lines.filter(l => l.qty > 0);

        if (!isFirst) doc.addPage();
        isFirst = false;

        doc.setFontSize(13); doc.setFont(undefined, "bold");
        doc.text(distNom, 14, 14);
        doc.setFontSize(10); doc.setFont(undefined, "normal");
        doc.text(`Tournee: ${round.name || round.id} - ${roundDate}`, 14, 21);

        doc.autoTable({
          startY: 26,
          head: [["Article", "CDN", "Quantite"]],
          body: filtered.map(l => {
            const cdn = l._cdn_override != null ? l._cdn_override
              : (l.packaging_qty > 0 ? +(l.qty / l.packaging_qty).toFixed(2) : "");
            return [l.name, cdn, l.qty];
          }),
          styles: { fontSize: 8, cellPadding: 2 },
          headStyles: { fillColor: [26, 107, 58] },
          columnStyles: { 1: { halign: "center" }, 2: { halign: "center" } },
        });
      }

      if (!isFirst) doc.save(`stock_final_${distNom.replace(/\s+/g,"_")}.pdf`);
      else addNotif(`Aucune donnee pour ${distNom}`, "info");
    } catch(err) { addNotif(`Erreur ${distNom}: ${err.message}`, "error"); }
  });
};

function sfSaveColumnsPerRow(val) {
  localStorage.setItem("sf_columns_per_row", val);
  fetch(`${_FB_DB_URL}/sf_settings.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columnsPerRow: parseInt(val) }),
  }).catch(e => console.warn("SF settings sync failed:", e));
}
window.sfSaveColumnsPerRow = sfSaveColumnsPerRow;
// ── Stock final ───────────────────────────────────────────────
async function _rpc_fetchStockFinal(baseUrl, roundId) {
  const plannings = await _rpc_call(baseUrl, {
    model: "planning.planning", method: "read",
    args:  [[roundId], ["final_stock_line_ids", "stock_global_ledger"]], kwargs: {},
  });
  if (!plannings?.length) throw new Error("Planning introuvable");
  const lineIds = plannings[0].final_stock_line_ids || [];

  // جولة مفتوحة: نستخرج من stock_global_ledger HTML
  if (!lineIds.length) {
    const html = plannings[0].stock_global_ledger || "";
    if (!html) return [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const rows = doc.querySelectorAll("tbody tr");
    const results = [];
    rows.forEach(row => {
      const cells = row.querySelectorAll("td");
      if (cells.length < 7) return;
      const nameRaw = cells[0].textContent.trim();
      const sfRaw   = cells[6].textContent.trim();
      if (!nameRaw || !sfRaw || nameRaw.toLowerCase() === "total") return;
      // استخراج CARTON/FARDEAU كـ CDN و Units كـ qty
      let cdn = 0, units = 0;
      const cartonMatch = sfRaw.match(/(\d+)\s*(CARTON|FARDEAU)/i);
      const unitMatch   = sfRaw.match(/(\d+)\s*Unit/i);
      if (cartonMatch) cdn   = parseInt(cartonMatch[1]);
      if (unitMatch)   units = parseInt(unitMatch[1]);
      // إذا لا يوجد units وفيه carton فقط → qty=0, cdn=carton
      // إذا لا يوجد carton وفيه units فقط → cdn=—, qty=units
      results.push({
        name: nameRaw,
        qty: units,
        packaging_qty: cdn > 0 ? 1 : 0,  // trick: نجعل cdn يظهر مباشرة
        packaging_name: cartonMatch?.[2] || "",
        _cdn_override: cdn > 0 ? cdn : null,
      });
    });
    return results;
  }

  const lines = await _rpc_call(baseUrl, {
    model: "planning.initial_final_stock_line", method: "read",
    args:  [lineIds, ["product_id", "product_uom_qty", "uom_id"]],
    kwargs: {},
  });

  const productIds = (lines || []).map(l =>
    Array.isArray(l.product_id) ? l.product_id[0] : l.product_id
  ).filter(Boolean);

  // جلب بيانات المنتج الكاملة للحصول على display name صحيح
  const prodRecords = productIds.length ? await _rpc_call(baseUrl, {
    model: "product.product", method: "search_read",
    args: [[["id", "in", productIds]]],
    kwargs: { fields: ["id", "name", "default_code"], limit: 500 },
  }).catch(() => []) : [];
  const prodMap = {};
  (prodRecords || []).forEach(p => { prodMap[p.id] = p; });

  const pkgs = productIds.length ? await _rpc_call(baseUrl, {
    model: "product.packaging", method: "search_read",
    args:  [[["product_id", "in", productIds]]],
    kwargs: { fields: ["product_id", "name", "qty"], limit: 200 },
  }).catch(() => []) : [];

  const packagingMap = {};
  (pkgs || []).forEach(p => {
    const pid = Array.isArray(p.product_id) ? p.product_id[0] : p.product_id;
    if (!packagingMap[pid]) packagingMap[pid] = { qty: p.qty || 1, name: p.name || "" };
  });

  return (lines || [])
    .filter(l => (l.product_uom_qty || 0) !== 0)
    .map(l => {
      const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
      const pkg = packagingMap[pid];
      return {
        name:           _productDisplayName(prodMap[pid]) || (Array.isArray(l.product_id) ? l.product_id[1] : String(l.product_id)),
        qty:            l.product_uom_qty || 0,
        packaging_qty:  pkg?.qty || 0,
        packaging_name: pkg?.name || "",
      };
    });
}
}