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
let ODOO_BASE = "https://wafa.presalio.com"; // modifié par _applyEnv() (auth.js) en environnement Training

// ── App State ─────────────────────────────────────────────────
const App = {
  env:       "prod", // "prod" | "training" (défini par _applyEnv)
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

// ── Nettoyage unique des anciennes clés localStorage (Préparation v1) ──
(function _purgeLegacyPrepStorage() {
  try {
    if (localStorage.getItem("gds_v1_prep_purged") === "1") return;
    const del = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith("wafa_gds_preparation_") || k === "wafa_gds_cols" || k === "gds_prep_v2")) del.push(k);
    }
    del.forEach(k => localStorage.removeItem(k));
    // anciennes options de réglages (copie locale uniquement)
    const raw = localStorage.getItem("wafa_settings");
    if (raw) {
      const st = JSON.parse(raw);
      if (st && typeof st === "object") {
        Object.keys(st).forEach(k => {
          if (k === "showPrepQty" || k === "showPrepSearch" || k === "rapportRequireCheck" || /^rpt[A-Z]/.test(k)) delete st[k];
        });
        localStorage.setItem("wafa_settings", JSON.stringify(st));
      }
    }
    localStorage.setItem("gds_v1_prep_purged", "1");
  } catch (_) {}
})();

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
      { key: "confirmed", label: "Confirmé",   color: "#33c393" },
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
    // Mode d'impression par défaut (nœud Firebase partagé) : chargé avant de dessiner boutons et commutateur
    if (window.TrActions && TrActions.loadDefaultMode) await TrActions.loadDefaultMode();

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
        ${window.TrActions && TrActions.switchHtml ? TrActions.switchHtml() : ""}
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
      confirmed:   { label: "Confirmé",   color: "#33c393" },
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
      rows += `<tr data-tr-pid="${t.id}" data-tr-name="${escHtml(t.name)}" data-tr-partner="${escHtml(t.partner_id ? t.partner_id[1] : '')}" data-tr-state="${escHtml(t.state)}">
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
          ${typeof trActionsHtml === "function" ? trActionsHtml(t) : ""}
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
      byCategory[catName].push({ name: _productDisplayName(p, { short: true }), _ordre: _productCustomOrder(String(p.id)), qty: stockMap[pid].qty, carton: stockMap[pid].carton, reserved: stockMap[pid].reserved, unitSize: stockMap[pid].unitSize });
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
        name: _productDisplayName(p, { short: true }),
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


// Nom Odoo (avec suffixe de couleur) — base commune de l'affichage ET du dictionnaire d'abréviations.
function _productOdooName(p) {
  if (!p) return "";
  const code = (p.default_code || "").toUpperCase();
  const name = p.name || "";
  const colorMap = { "BLEU": "BLEU", "VERT": "VERT", "ROSE": "ROSE", "ROUGE": "ROUGE", "JAUNE": "JAUNE" };
  for (const [key, label] of Object.entries(colorMap)) {
    if (code.includes(key) && !name.toUpperCase().includes(key)) return `${name} (${label})`;
  }
  return name;
}

// Affichage uniquement. Priorité : (1) dictionnaire d'abréviations [short], (2) nom Odoo.
// `short` est opt-in : les appels existants (export modèle…) gardent le comportement d'origine.
function _productDisplayName(p, { short = false } = {}) {
  if (!p) return "—";
  const odooName = _productOdooName(p);
  return short && typeof NameDict !== "undefined" ? NameDict.shortName(odooName) : odooName;
}

// ── Ordre des produits ────────────────────────────────────────
const _PROD_NAMES_FB_KEY = "product_display_map";

function _getProdNamesMap() {
  return App.settings?.productNamesMap || {};
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
    const entries = Object.entries(map).slice(0, 50);
    const names = {};
    try {
      const res = await fetch("/api/web/dataset/call_kw", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", method: "call", id: Date.now(),
          params: {
            model: "product.product", method: "search_read",
            args: [[["id", "in", entries.map(([pid]) => parseInt(pid))]]],
            kwargs: { fields: ["id", "name", "default_code"], limit: 100, context: { active_test: false } }
          }
        })
      });
      const j = await res.json();
      (j?.result || []).forEach(p => { names[p.id] = _productDisplayName(p, { short: true }); });
    } catch (_) {}
    const rows = entries.map(([pid, v]) =>
      `<div style="display:flex;gap:8px;padding:3px 0;border-bottom:1px solid var(--border);">
        <span style="color:var(--text3);min-width:40px;">#${pid}</span>
        <span style="min-width:30px;text-align:center;">${v.ordre}</span>
        <span>${escHtml(names[pid] || "")}</span>
      </div>`
    ).join("");
    previewEl.innerHTML = `
      <div style="display:flex;gap:8px;padding:3px 0;font-weight:700;font-size:10px;color:var(--text2);border-bottom:2px solid var(--border);margin-bottom:4px;">
        <span style="min-width:40px;">ID</span>
        <span style="min-width:30px;">Ordre</span>
        <span>Produit</span>
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
    const rows = [["id", "nom_odoo", "ordre"]];
    products.forEach((p, i) => {
      const existing = map[p.id];
      rows.push([
        p.id,
        _productDisplayName(p),
        existing?.ordre ?? (i + 1)
      ]);
    });
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 8 }, { wch: 40 }, { wch: 8 }];
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
      const ordre = parseInt(row["ordre"]) || (i + 1);
      if (!pid) return;
      map[pid] = { ordre };
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
    _initProduitNamesModal();
    addNotif(`Ordre des produits mis à jour (${count})`, "success");
  } catch(e) {
    console.error(e);
    if (statusEl) statusEl.textContent = "Erreur lors de l'importation";
  }
}

async function _resetProdNames() {
  if (!(await appConfirm("Réinitialiser l'ordre des produits ?", { title: "Réinitialiser", okText: "Réinitialiser", danger: true }))) return;
  App.settings.productNamesMap = {};
  await Storage.saveSettings(App.settings);
  try {
    await fetch(`${_FB_DB_URL}/${_PROD_NAMES_FB_KEY}.json`, { method: "DELETE" });
  } catch(_) {}
  _initProduitNamesModal();
  addNotif("Ordre réinitialisé", "success");
}

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
      pdfColumns:          App.settings.pdfColumns          ?? 2,
      pdfFontProduct:      App.settings.pdfFontProduct      ?? 10,
      pdfFontQty:          App.settings.pdfFontQty          ?? 13,
      pdfRowPadding:       App.settings.pdfRowPadding       ?? 1,
      
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
            <input type="checkbox" id="whSplitSlash_${wh.id}" style="width:14px;height:14px;accent-color:#33c393;"/>
            Raccourcir après "/" (prendre dernière partie)
          </label>

        <button onclick="_saveWarehouseSettings(${wh.id})"
          style="margin-top:10px;padding:7px 14px;border-radius:6px;background:#33c393;color:#fff;font-size:11px;font-weight:700;border:none;cursor:pointer;">
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
  s.allowOverstock = document.getElementById("toggleAllowOverstock")?.checked ?? false;
  s.pdfColumns     = parseInt(document.getElementById("pdfColumns")?.value     || "2");
  s.pdfFontProduct = parseInt(document.getElementById("pdfFontProduct")?.value || "10");
  s.pdfFontQty     = parseInt(document.getElementById("pdfFontQty")?.value     || "13");
  s.pdfRowPadding    = parseInt(document.getElementById("pdfRowPadding")?.value  || "1");
  

  await Storage.saveSettings(s);
  // حفظ سحابي على Firebase
  try {
    await fetch(`${_FB_DB_URL}/settings.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        categoryOrder:   s.categoryOrder  || [],
        showTotalU:      s.showTotalU,
        pdfColumns:      s.pdfColumns,
        pdfFontProduct:  s.pdfFontProduct,
        pdfFontQty:      s.pdfFontQty,
        pdfRowPadding:    s.pdfRowPadding,
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
  document.getElementById("btnSettings")?.addEventListener("click", async () => {
  document.getElementById("viewMain").style.display = "none";
  document.getElementById("viewSettings").style.display = "flex";
  renderCategoryOrderUI();
  const tog = document.getElementById("toggleTotalU");
  const fb = await fetch(`${_FB_DB_URL}/settings.json`).then(r=>r.json()).catch(()=>null);
  if (fb) {
    if (fb.showTotalU          !== undefined) App.settings.showTotalU          = fb.showTotalU;
    if (fb.pdfColumns          !== undefined) App.settings.pdfColumns          = fb.pdfColumns;
    if (fb.pdfFontProduct      !== undefined) App.settings.pdfFontProduct      = fb.pdfFontProduct;
    if (fb.pdfFontQty          !== undefined) App.settings.pdfFontQty          = fb.pdfFontQty;
    if (fb.pdfRowPadding       !== undefined) App.settings.pdfRowPadding       = fb.pdfRowPadding;
    
  }
  if (tog) tog.checked = App.settings?.showTotalU !== false;
  const togOV = document.getElementById("toggleAllowOverstock");
  if (togOV) togOV.checked = App.settings?.allowOverstock === true;
  const s = App.settings || {};
  const elSet = (id, val) => { const e = document.getElementById(id); if(e) e.value = val; };
  elSet("pdfColumns",      s.pdfColumns      ?? 2);
  elSet("pdfFontProduct",  s.pdfFontProduct  ?? 10);
  elSet("pdfFontQty",      s.pdfFontQty      ?? 13);
  elSet("pdfRowPadding",   s.pdfRowPadding   ?? 1);
  
});
if (isAdmin()) {
  const container = document.getElementById("userManagementContainer");
  if (container) container.style.display = "";
  const rpc = document.getElementById("rolePermissionsContainer");
  if (rpc) rpc.style.display = "";
  if (typeof NameDict !== "undefined") NameDict.initSettings();
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
  document.getElementById("toggleAllowOverstock")?.addEventListener("change", e => {
    App.settings.allowOverstock = e.target.checked;
    saveSettings();
  });

  ["pdfColumns","pdfFontProduct","pdfFontQty","pdfRowPadding"
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
        name:           _productDisplayName(prodMap[pid], { short: true }) || (Array.isArray(l.product_id) ? l.product_id[1] : String(l.product_id)),
        qty:            l.product_uom_qty || 0,
        packaging_qty:  pkg?.qty || 0,
        packaging_name: pkg?.name || "",
      };
    });
}
}