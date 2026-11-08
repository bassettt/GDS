// Nom de produit abrégé (dictionnaire) — fonction hissée + globale: utilisable partout, affichage/export uniquement
function _sfPn(n) { try { return (typeof NameDict !== "undefined" && n != null) ? NameDict.shortName(String(n)) : n; } catch (_) { return n; } }
window._sfPn = _sfPn;
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
      const rawName = m.product_id?.[1] || m.product_tmpl_id?.[1] || "—";
      const name = rawName === "—" ? rawName : (_sfPn(String(rawName).replace(/^\[.*?\]\s*/, "")) || rawName);   // nom abrégé (dictionnaire), sans [REF]
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

function _gdsTrInitDatePicker() {
  // The date field is a readonly text input showing d/m/Y; clicking it opens the shared AppDatePicker (mode "day").
  // The value stays "YYYY-MM-DD" in _gdsTransfertsFilters.date (_gdsTrSetDate), the display is rebuilt by renderGdsTransferts.
  const el = document.getElementById("gdsTrDateInput");
  if (!el || el._adpBound) return;
  el._adpBound = true;
  const open = () => AppDatePicker.open(el, {
    mode: "day", value: _gdsTransfertsFilters.date || "",
    onApply: (v) => _gdsTrSetDate(v)
  });
  el.addEventListener("click", open);
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") { e.preventDefault(); open(); } });
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
    if (typeof sfOnOpenTab === "function") sfOnOpenTab().catch(e => console.warn("sfOnOpenTab:", e));
    else if (typeof sfRenderFromCache === "function") sfRenderFromCache();
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
      aoa.push([_sfPn(l.name), cdn, l.qty]);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const maxLen = Math.max(7, ...filtered.map(l => String(_sfPn(l.name)).length));
    ws["!cols"] = [{ wch: Math.min(maxLen * 1.05, 80) }, { wch: 10 }, { wch: 12 }];
    ws["!merges"] = [{ s:{r:0,c:0}, e:{r:0,c:2} }];
    XLSX.utils.book_append_sheet(wb, ws, "Stock Final");
    XLSX.writeFile(wb, `stock_final_${vendorLabel.replace(/\s+/g,"_")}.xlsx`);
  } else {
    let csv = `"${title} (${today})"\n\nArticle,CDN,Quantité\n`;
    filtered.forEach(l => {
      const cdn = l.packaging_qty > 0 ? +(l.qty / l.packaging_qty).toFixed(2) : "";
      csv += `"${_sfPn(l.name)}",${cdn},${l.qty}\n`;
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
        return [_sfPn(l.name), cdn, l.qty];
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
    if (statusEl) uiStatus(statusEl, "ok", `${count} produits importés`);
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
        <div style="font-size:12px;font-weight:700;color:var(--text1);margin-bottom:10px;display:flex;align-items:center;gap:6px;">${icon("warehouse", 14)}<span>${wh.name}</span></div>
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
    if (msg) { uiStatus(msg, "ok", "Sauvegardé"); setTimeout(() => msg.textContent = "", 2000); }
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
  if (saveMsg) { uiStatus(saveMsg, "ok", "Sauvegardé"); saveMsg.className="save-msg ok"; setTimeout(()=>{ saveMsg.textContent=""; }, 2000); }
  addNotif("Paramètres sauvegardés", "success");
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
  // Permissions par rôle : chargées à l'ouverture de la fenêtre (carte) et via Actualiser
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

// ── Stock Final — Distributeurs (cloud, par entrepôt) ────────
// Nœud Firebase: sf_dists2_{whId} = { "<id>": { nom, ordre, hidden, src: "odoo"|"manual", onom? }, _meta: { lastSync, migrated } }
// • Firebase = source de vérité. localStorage = cache seulement (relu depuis Firebase à l'ouverture de l'onglet et des paramètres).
// • Toute modification = PATCH sur les clés touchées uniquement (jamais de PUT de la liste entière).
// • Les id sont toujours des String (comparaisons et clés).
// • onom = dernier nom vu dans Odoo: renomme seulement si Odoo a changé, sans écraser une édition manuelle faite entre-temps.
const SF_D2_PREFIX = "sf_dists2_";
const SF_SYNC_TTL  = 24 * 3600 * 1000;           // synchro auto si la dernière a plus de 24 h
const _sfD2 = new Map();                          // whId -> { map, meta }
const _sfD2Inflight = new Map();
const _sfSyncInflight = new Map();
const _sfAutoDone = new Set();                    // entrepôts déjà auto-synchronisés dans cette session
let _sfPending = 0;                               // écritures cloud en cours
let _sfDragId = null;

const _sfWh    = () => String(_getWarehouseId() || "default");
const _sfD2Url = (whId) => `${_FB_DB_URL}/${SF_D2_PREFIX}${whId}.json`;
const _sfIdOk  = (id) => !!id && id[0] !== "_" && !/[.$#\[\]\/\u0000-\u001f]/.test(id);   // clé Firebase valide
const _sfCmp   = (a, b) => (a.ordre - b.ordre) || String(a.nom).localeCompare(String(b.nom), "fr", { sensitivity: "base" });
const _sfTabVisible = () => { const el = document.getElementById("gdsStockFinalContent"); return !!el && el.style.display !== "none"; };
const _sfSettingsOpen = () => !!document.getElementById("modalStockFinal")?.classList.contains("open");
const _sfNotify = (m, t) => { try { addNotif(m, t || "info"); } catch (_) {} };

// ── Normalisation / cache local ──────────────────────────────
function _sfD2Norm(raw) {
  const map = {}; let meta = {};
  if (raw && typeof raw === "object") {
    const ents = Array.isArray(raw) ? raw.map((v, i) => [String(i), v]) : Object.entries(raw);
    ents.forEach(([k, v]) => {
      if (k === "_meta") { if (v && typeof v === "object") meta = v; return; }
      if (!v || typeof v !== "object") return;
      map[String(k)] = {
        nom: String(v.nom == null ? "" : v.nom),
        ordre: Number.isFinite(+v.ordre) ? +v.ordre : 0,
        hidden: v.hidden === true,
        src: v.src === "odoo" ? "odoo" : "manual",
        onom: v.onom == null ? undefined : String(v.onom),
      };
    });
  }
  return { map, meta };
}
function _sfD2State(whId) {
  whId = String(whId || _sfWh());
  let st = _sfD2.get(whId);
  if (!st) {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(SF_D2_PREFIX + whId) || "null"); } catch (_) {}
    st = _sfD2Norm(raw);
    _sfD2.set(whId, st);
  }
  return st;
}
function _sfD2Persist(whId, st) {
  try { localStorage.setItem(SF_D2_PREFIX + whId, JSON.stringify(Object.assign({}, st.map, { _meta: st.meta }))); } catch (_) {}
}

// Liste triée (ordre puis nom). withHidden=false => seulement les visibles.
function _sfD2List(whId, withHidden) {
  const st = _sfD2State(whId);
  return Object.keys(st.map)
    .map(id => Object.assign({ id }, st.map[id]))
    .filter(d => withHidden || !d.hidden)
    .sort(_sfCmp);
}
// ── Préférences LOCALES (cet appareil uniquement, jamais envoyées au cloud, prioritaires) ──
// localStorage "sf_local_prefs_<whId>" = { order: { id: n }, hidden: { id: true|false } }
const SF_LOCAL_PREFIX = "sf_local_prefs_";
function _sfLocalPrefs(whId) {
  whId = String(whId || _sfWh());
  let lp = null;
  try { lp = JSON.parse(localStorage.getItem(SF_LOCAL_PREFIX + whId) || "null"); } catch (_) {}
  if (!lp || typeof lp !== "object") lp = {};
  return { order: (lp.order && typeof lp.order === "object") ? lp.order : {}, hidden: (lp.hidden && typeof lp.hidden === "object") ? lp.hidden : {} };
}
function _sfLocalSave(lp, whId) {
  whId = String(whId || _sfWh());
  try {
    if (!Object.keys(lp.order).length && !Object.keys(lp.hidden).length) localStorage.removeItem(SF_LOCAL_PREFIX + whId);
    else localStorage.setItem(SF_LOCAL_PREFIX + whId, JSON.stringify(lp));
  } catch (_) {}
}
// Liste effective: valeurs locales prioritaires sur le cloud (ordre + masquage)
function _sfEffList(whId) {
  const lp = _sfLocalPrefs(whId);
  return _sfD2List(whId, true).map(d => Object.assign({}, d, {
    cloudHidden: d.hidden,
    ordre:  Number.isFinite(+lp.order[d.id]) && lp.order[d.id] !== null ? +lp.order[d.id] : d.ordre,
    hidden: lp.hidden[d.id] != null ? !!lp.hidden[d.id] : d.hidden,
    localHid: lp.hidden[d.id] != null,
  })).sort(_sfCmp);
}
window.sfGetDistributeurs = function sfGetDistributeurs() {
  return _sfEffList(null).filter(d => !d.hidden).map(d => ({ id: d.id, nom: d.nom }));
};
// Nom de produit: toujours la forme abrégée (dictionnaire), affichage/export uniquement


// ── Écriture: PATCH multi-chemins + application locale ───────
async function _sfD2Send(whId, patch) {
  const r = await fetch(_sfD2Url(whId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
}
function _sfD2ApplyLocal(st, patch) {
  Object.keys(patch).forEach(k => {
    const v = patch[k], parts = k.split("/");
    if (parts[0] === "_meta") { if (parts[1]) st.meta[parts[1]] = v; return; }
    if (parts.length === 1) {
      if (v === null) delete st.map[k];
      else st.map[k] = Object.assign({}, v);
    } else if (st.map[parts[0]]) {
      st.map[parts[0]][parts[1]] = v;
    }
  });
}
async function _sfD2Commit(patch, whId) {
  whId = String(whId || _sfWh());
  if (!Object.keys(patch).length) return true;
  const st = _sfD2State(whId);
  _sfD2ApplyLocal(st, patch);
  _sfD2Persist(whId, st);
  _sfPending++;
  try { await _sfD2Send(whId, patch); return true; }
  catch (e) { console.warn("SF dists2 sync failed:", e); _sfNotify("Échec de la sauvegarde cloud des distributeurs", "error"); return false; }
  finally { _sfPending--; }
}

// ── Lecture cloud (+ migration unique depuis l'ancienne liste) ─
async function _sfD2Migrate(whId, st) {
  let legacy = null;
  try {
    const r = await fetch(`${_FB_DB_URL}/sf_distributeurs_${whId}.json`, { cache: "no-store" });
    if (r.ok) legacy = await r.json();
  } catch (_) {}
  if (!legacy) { try { legacy = JSON.parse(localStorage.getItem(`sf_distributeurs_${whId}`) || "null"); } catch (_) {} }
  const seen = new Set();
  const rows = (Array.isArray(legacy) ? legacy : Object.values(legacy || {}))
    .map(x => { const id = String(x && x.id != null ? x.id : "").trim(); const nom = String(x && x.nom != null ? x.nom : "").trim(); return { id, nom: nom || id }; })
    .filter(x => _sfIdOk(x.id) && !seen.has(x.id) && seen.add(x.id))
    .sort((a, b) => a.nom.localeCompare(b.nom, "fr", { sensitivity: "base" }));
  if (!rows.length) return;
  const patch = {};
  rows.forEach((x, i) => { patch[x.id] = { nom: x.nom, ordre: i + 1, hidden: false, src: "manual" }; });
  patch["_meta/migrated"] = true;
  _sfD2ApplyLocal(st, patch);                    // l'ancienne liste n'est jamais supprimée
  try { await _sfD2Send(whId, patch); } catch (e) { console.warn("SF dists2 migration failed:", e); }
}
function _sfD2Load(whId) {
  whId = String(whId || _sfWh());
  if (_sfD2Inflight.has(whId)) return _sfD2Inflight.get(whId);
  const p = (async () => {
    const r = await fetch(_sfD2Url(whId), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const st = _sfD2Norm(await r.json());
    if (!Object.keys(st.map).length && !st.meta.migrated) await _sfD2Migrate(whId, st);
    _sfD2.set(whId, st);
    _sfD2Persist(whId, st);
    return st;
  })().finally(() => _sfD2Inflight.delete(whId));
  _sfD2Inflight.set(whId, p);
  return p;
}

// ── Temps réel (SSE, même principe que le dictionnaire de noms) ─
let _sfEs = null, _sfEsWh = null, _sfEsT = null;
function _sfD2Listen(whId) {
  whId = String(whId || _sfWh());
  if (typeof EventSource === "undefined" || (_sfEs && _sfEsWh === whId)) return;
  try { if (_sfEs) _sfEs.close(); } catch (_) {}
  try {
    const es = new EventSource(_sfD2Url(whId));
    let first = true;
    const kick = () => { if (first) { first = false; return; } clearTimeout(_sfEsT); _sfEsT = setTimeout(_sfD2Remote, 300); };
    es.addEventListener("put", kick);
    es.addEventListener("patch", kick);
    _sfEs = es; _sfEsWh = whId;
  } catch (_) {}
}
async function _sfD2Remote() {
  if (_sfPending || _sfDragId) { clearTimeout(_sfEsT); _sfEsT = setTimeout(_sfD2Remote, 400); return; }   // attendre la fin de nos propres écritures
  const whId = _sfEsWh;
  try { await _sfD2Load(whId); } catch (_) { return; }
  if (whId !== _sfWh()) return;
  if (_sfTabVisible()) sfRenderFromCache();
  _sfSettingsRefresh(false);
}

// ── Liaison entrepôt ↔ tournées (à définir après l'exploration) ─
// Termes de domaine Odoo ajoutés à la requête planning.planning (en plus de: 3 derniers mois + LIVREUR).
// Liaison validée: planning.planning.warehouse_id = entrepôt actif. null => synchro Odoo désactivée (aucune écriture).
function _sfWhDomain(whId) {
  const id = parseInt(whId, 10);
  return Number.isFinite(id) ? [["warehouse_id", "=", id]] : null;
}

// ── Synchro Odoo: ajoute seulement les nouveaux ──────────────
async function _sfOdooDists(whId) {
  const extra = _sfWhDomain(whId);
  if (!extra) return null;
  const since = new Date();
  since.setMonth(since.getMonth() - 3);
  const domain = [["date_start", ">=", since.toISOString().slice(0, 10)], ["user_id.name", "ilike", "LIVREUR"]].concat(extra);
  const res = await _rpc_call(ODOO_BASE, {
    model: "planning.planning", method: "search_read",
    args: [domain], kwargs: { fields: ["user_id"], limit: 2000 },
  }) || [];
  const seen = {};
  res.forEach(p => { if (p.user_id) seen[String(p.user_id[0])] = p.user_id[1]; });
  return Object.keys(seen)
    .map(id => ({ id, nom: _cleanPartnerName(seen[id]) }))
    .sort((a, b) => a.nom.localeCompare(b.nom, "fr", { sensitivity: "base" }));
}
async function _sfSyncRun(whId) {
  if (!_sfWhDomain(whId)) return { status: "blocked" };
  let list;
  try { list = await _sfOdooDists(whId); }
  catch (e) { return { status: "error", msg: (e && e.message) || String(e) }; }
  let st;
  try { st = await _sfD2Load(whId); }
  catch (e) { return { status: "error", msg: "Firebase indisponible" }; }
  const patch = {};
  let added = 0, renamed = 0;
  let last = Object.keys(st.map).reduce((m, k) => Math.max(m, st.map[k].ordre), 0);
  list.forEach(d => {
    const cur = st.map[d.id];
    if (!cur) {
      patch[d.id] = { nom: d.nom, ordre: ++last, hidden: false, src: "odoo", onom: d.nom };
      added++;
    } else if (cur.src === "odoo") {
      if (cur.onom === undefined) patch[d.id + "/onom"] = d.nom;
      else if (cur.onom !== d.nom) { patch[d.id + "/onom"] = d.nom; patch[d.id + "/nom"] = d.nom; renamed++; }
    }
  });
  patch["_meta/lastSync"] = Date.now();
  if (!(await _sfD2Commit(patch, whId))) return { status: "error", msg: "Échec de l'écriture Firebase" };
  return { status: "ok", added, renamed, total: list.length };
}
function _sfSync(whId) {
  whId = String(whId || _sfWh());
  if (_sfSyncInflight.has(whId)) return _sfSyncInflight.get(whId);
  const p = _sfSyncRun(whId).finally(() => _sfSyncInflight.delete(whId));
  _sfSyncInflight.set(whId, p);
  return p;
}

// ── Ouverture de l'onglet Stock Final ────────────────────────
window.sfOnOpenTab = async function sfOnOpenTab() {
  const whId = _sfWh();
  sfRenderFromCache();                           // affichage immédiat depuis le cache
  _sfD2Listen(whId);
  try { await _sfD2Load(whId); }
  catch (e) { console.warn("SF dists2 load failed:", e); return; }
  if (_sfWh() !== whId) return;
  if (_sfTabVisible()) sfRenderFromCache();
  // synchro auto légère: une fois par session et par entrepôt, si la dernière a plus de 24 h
  if (_sfAutoDone.has(whId)) return;
  _sfAutoDone.add(whId);
  if (!_sfWhDomain(whId)) return;
  if (Date.now() - (+_sfD2State(whId).meta.lastSync || 0) < SF_SYNC_TTL) return;
  const r = await _sfSync(whId);
  if (r.status === "ok" && (r.added || r.renamed) && _sfWh() === whId && _sfTabVisible()) sfRenderFromCache();
};

// ── Paramètres > Stock Final ─────────────────────────────────
const _SFD_P = {
  grip:  '<circle cx="9" cy="6" r="1.3" fill="currentColor"/><circle cx="15" cy="6" r="1.3" fill="currentColor"/><circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/><circle cx="9" cy="18" r="1.3" fill="currentColor"/><circle cx="15" cy="18" r="1.3" fill="currentColor"/>',
  up:    '<polyline points="18 15 12 9 6 15"/>',
  down:  '<polyline points="6 9 12 15 18 9"/>',
  eye:   '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff:'<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
};
const _sfdIc = (n, s) => _sfSvg(_SFD_P[n], s || 14);
const _sfStatus = (t, kind) => { const el = document.getElementById("sfImportStatus"); if (el) uiStatus(el, kind, t); };

window.sfOpenSettings = async function sfOpenSettings() {
  const whId = _sfWh();
  sfRenderDistributeursList();                   // cache d'abord
  _sfD2Listen(whId);
  try { await _sfD2Load(whId); }
  catch (e) { console.warn("SF dists2 load failed:", e); _sfStatus("Cloud indisponible — cache local affiché."); return; }
  if (_sfWh() === whId) sfRenderDistributeursList();
};

// rafraîchit la liste des paramètres si ouverts (sans casser une saisie ou un glisser en cours)
function _sfSettingsRefresh(force) {
  if (!_sfSettingsOpen()) return;
  const box = document.getElementById("sfDistributeursList");
  if (!force && box && (box.contains(document.activeElement) && document.activeElement.tagName === "INPUT")) return;
  sfRenderDistributeursList();
}
function _sfAfterChange() {
  _sfSettingsRefresh(true);
  if (_sfTabVisible()) sfRenderFromCache();
}

window.sfRenderDistributeursList = function sfRenderDistributeursList() {
  const container = document.getElementById("sfDistributeursList");
  if (!container) return;
  _sfBindSettings(container);
  const list = _sfD2List(null, true);
  if (!list.length) {
    container.innerHTML = `<div class="sfd-empty">Aucun distributeur.</div>`;
    return;
  }
  const nHidden = list.filter(d => d.hidden).length;
  container.innerHTML = `<div class="sfd-count">${list.length} distributeur(s)${nHidden ? ` · ${nHidden} masqué(s)` : ""}</div>` +
    list.map((d, i) => `
    <div class="sfd-row${d.hidden ? " sfd-row--hidden" : ""}" data-id="${escHtml(d.id)}">
      <span class="sfd-grip" draggable="true" title="Glisser pour réordonner" aria-label="Glisser pour réordonner">${_sfdIc("grip", 16)}</span>
      <span class="sfd-mv">
        <button type="button" class="sfd-ib" data-act="up" title="Monter" aria-label="Monter"${i === 0 ? " disabled" : ""}>${_sfdIc("up", 14)}</button>
        <button type="button" class="sfd-ib" data-act="down" title="Descendre" aria-label="Descendre"${i === list.length - 1 ? " disabled" : ""}>${_sfdIc("down", 14)}</button>
      </span>
      <input class="sfd-num" data-act="num" type="number" inputmode="numeric" min="1" max="${list.length}" value="${i + 1}" title="Position" aria-label="Position"/>
      <input class="sfd-nom sf-row-nom" data-act="nom" value="${escHtml(d.nom)}" aria-label="Nom"/>
      <span class="sfd-id" title="ID">${escHtml(d.id)}</span>
      <button type="button" class="sfd-ib" data-act="eye" title="${d.hidden ? "Afficher" : "Masquer"}" aria-label="${d.hidden ? "Afficher" : "Masquer"}">${_sfdIc(d.hidden ? "eyeoff" : "eye", 16)}</button>
      <button type="button" class="sfd-ib sfd-ib--del" data-act="del" title="Supprimer (réapparaît à la synchro s'il existe encore dans Odoo)" aria-label="Supprimer">${_sfdIc("trash", 15)}</button>
    </div>`).join("");
};

// réordonne: place `id` avant/après `targetId`; n'écrit que les ordre modifiés, en un seul PATCH
async function _sfReorder(id, targetId, after) {
  if (id === targetId) return;
  const ids = _sfD2List(null, true).map(d => d.id).filter(x => x !== id);
  const ti = ids.indexOf(targetId);
  if (ti < 0) return;
  ids.splice(ti + (after ? 1 : 0), 0, id);
  const st = _sfD2State();
  const patch = {};
  ids.forEach((x, i) => { if (st.map[x] && st.map[x].ordre !== i + 1) patch[x + "/ordre"] = i + 1; });
  if (!Object.keys(patch).length) return;
  await _sfD2Commit(patch);
  _sfAfterChange();
}
function _sfClearDragMarks(container) {
  container.querySelectorAll(".sfd-over-top,.sfd-over-bottom,.sfd-row--drag").forEach(n => n.classList.remove("sfd-over-top", "sfd-over-bottom", "sfd-row--drag"));
}
function _sfBindSettings(container) {
  if (container._sfBound) return;
  container._sfBound = true;

  container.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    const row = e.target.closest(".sfd-row");
    if (!b || !row || b.disabled || b.tagName === "INPUT") return;
    const id = row.dataset.id, st = _sfD2State(), cur = st.map[id];
    if (!cur) return;
    switch (b.dataset.act) {
      case "up":
      case "down": {
        const ids = _sfD2List(null, true).map(d => d.id);
        const i = ids.indexOf(id), j = b.dataset.act === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= ids.length) return;
        await _sfReorder(id, ids[j], b.dataset.act === "down");
        break;
      }
      case "eye":
        await _sfD2Commit({ [id + "/hidden"]: !cur.hidden });
        _sfAfterChange();
        break;
      case "del":
        await _sfD2Commit({ [id]: null });
        _sfAfterChange();
        break;
    }
  });

  container.addEventListener("change", async (e) => {
    const num = e.target.closest('input[data-act="num"]');
    if (num) {
      const nrow = num.closest(".sfd-row");
      if (nrow) await _sfMoveTo(nrow.dataset.id, parseInt(num.value, 10));
      return;
    }
    const inp = e.target.closest('input[data-act="nom"]');
    const row = e.target.closest(".sfd-row");
    if (!inp || !row) return;
    const id = row.dataset.id, cur = _sfD2State().map[id];
    const val = inp.value.trim();
    if (!cur || !val) { if (cur) inp.value = cur.nom; return; }     // nom vide refusé
    if (val === cur.nom) return;
    await _sfD2Commit({ [id + "/nom"]: val });
    if (_sfTabVisible()) sfRenderFromCache();
  });
  container.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches('input[data-act="nom"], input[data-act="num"]')) e.target.blur();
  });

  // Glisser-déposer (poignée) — sur mobile: boutons ↑ ↓
  container.addEventListener("dragstart", (e) => {
    const g = e.target.closest && e.target.closest(".sfd-grip");
    const row = g && g.closest(".sfd-row");
    if (!row) { e.preventDefault(); return; }
    _sfDragId = row.dataset.id;
    row.classList.add("sfd-row--drag");
    try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", _sfDragId); e.dataTransfer.setDragImage(row, 12, 12); } catch (_) {}
  });
  container.addEventListener("dragover", (e) => {
    if (!_sfDragId) return;
    const row = e.target.closest(".sfd-row");
    if (!row) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch (_) {}
    const r = row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    container.querySelectorAll(".sfd-over-top,.sfd-over-bottom").forEach(n => n.classList.remove("sfd-over-top", "sfd-over-bottom"));
    if (row.dataset.id !== _sfDragId) row.classList.add(after ? "sfd-over-bottom" : "sfd-over-top");
  });
  container.addEventListener("drop", async (e) => {
    if (!_sfDragId) return;
    e.preventDefault();
    const row = e.target.closest(".sfd-row");
    const id = _sfDragId;
    _sfDragId = null;
    if (row) {
      const r = row.getBoundingClientRect();
      await _sfReorder(id, row.dataset.id, e.clientY > r.top + r.height / 2);
    }
    _sfClearDragMarks(container);
  });
  container.addEventListener("dragend", () => { _sfDragId = null; _sfClearDragMarks(container); });
}

// place `id` à la position `pos` (1 = premier) — ordre cloud, un seul PATCH
async function _sfMoveTo(id, pos) {
  const ids = _sfD2List(null, true).map(d => d.id);
  if (!ids.includes(id)) return;
  if (!Number.isFinite(pos)) { _sfSettingsRefresh(true); return; }
  pos = Math.max(1, Math.min(ids.length, pos));
  const rest = ids.filter(x => x !== id);
  rest.splice(pos - 1, 0, id);
  const st = _sfD2State(), patch = {};
  rest.forEach((x, i) => { if (st.map[x] && st.map[x].ordre !== i + 1) patch[x + "/ordre"] = i + 1; });
  if (Object.keys(patch).length) await _sfD2Commit(patch);
  _sfAfterChange();
}

// ── Bouton ⚙ de la barre: ordre / masquage LOCAUX (tous les utilisateurs, non synchronisés) ──
function _sfEnsureLocalModal() {
  let ov = document.getElementById("modalSfLocal");
  if (ov) return ov;
  ov = document.createElement("div");
  ov.className = "smodal-overlay";
  ov.id = "modalSfLocal";
  ov.innerHTML = `<div class="smodal-box" role="dialog" aria-modal="true" aria-labelledby="sfLocalTitle" tabindex="-1">
    <div class="smodal-header">
      <span class="smodal-title" id="sfLocalTitle">Ordre et affichage</span>
      <button type="button" class="smodal-close" data-act="close" aria-label="Fermer">${_sfSvg(_SF_P.close, 16)}</button>
    </div>
    <div class="smodal-body">
      <p class="settings-hint" style="margin:0 0 8px;">Cet appareil uniquement — non synchronisé, prioritaire sur les réglages partagés. Saisissez un numéro pour placer un distributeur.</p>
      <div style="margin-bottom:8px;"><button type="button" class="gds-refresh-btn" data-act="reset" style="font-size:12px;">Réinitialiser</button></div>
      <div id="sfLocalList"></div>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (e.target === ov) { sfCloseLocalSettings(); return; }
    if (!b) return;
    const act = b.dataset.act;
    if (act === "close") { sfCloseLocalSettings(); return; }
    if (act === "reset") { _sfLocalSave({ order: {}, hidden: {} }); _sfLocalAfter(); return; }
    const row = b.closest(".sfd-row");
    if (act === "eye" && row) {
      const id = row.dataset.id, lp = _sfLocalPrefs();
      const cur = _sfEffList().find(d => d.id === id);
      lp.hidden[id] = !(cur && cur.hidden);
      _sfLocalSave(lp); _sfLocalAfter();
    }
  });
  ov.addEventListener("change", (e) => {
    const num = e.target.closest('input[data-act="num"]');
    const row = e.target.closest(".sfd-row");
    if (!num || !row) return;
    const ids = _sfEffList().map(d => d.id);
    const id = row.dataset.id, pos = parseInt(num.value, 10);
    if (!ids.includes(id) || !Number.isFinite(pos)) { _sfLocalRender(); return; }
    const rest = ids.filter(x => x !== id);
    rest.splice(Math.max(1, Math.min(ids.length, pos)) - 1, 0, id);
    const lp = _sfLocalPrefs();
    rest.forEach((x, i) => { lp.order[x] = i + 1; });      // numérotation locale complète
    _sfLocalSave(lp); _sfLocalAfter();
  });
  ov.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches('input[data-act="num"]')) e.target.blur();
    if (e.key === "Escape") { e.stopPropagation(); sfCloseLocalSettings(); }
  });
  return ov;
}
function _sfLocalRender() {
  const box = document.getElementById("sfLocalList");
  if (!box) return;
  const list = _sfEffList();
  if (!list.length) { box.innerHTML = `<div class="sfd-empty">Aucun distributeur.</div>`; return; }
  box.innerHTML = list.map((d, i) => `
    <div class="sfd-row${d.hidden ? " sfd-row--hidden" : ""}" data-id="${escHtml(d.id)}">
      <input class="sfd-num" data-act="num" type="number" inputmode="numeric" min="1" max="${list.length}" value="${i + 1}" title="Position" aria-label="Position"/>
      <span class="sfd-nom sfd-nom--ro" title="${escHtml(d.nom)}">${escHtml(d.nom)}</span>
      <button type="button" class="sfd-ib" data-act="eye" title="${d.hidden ? "Afficher" : "Masquer"}" aria-label="${d.hidden ? "Afficher" : "Masquer"}">${_sfdIc(d.hidden ? "eyeoff" : "eye", 16)}</button>
    </div>`).join("");
}
function _sfLocalAfter() {
  _sfLocalRender();
  if (_sfTabVisible()) sfRenderFromCache();
}
window.sfOpenLocalSettings = function sfOpenLocalSettings() {
  const ov = _sfEnsureLocalModal();
  _sfLocalRender();
  if (typeof _openSettingsModal === "function") _openSettingsModal("modalSfLocal"); else ov.classList.add("open");
  ov.querySelector(".smodal-box").focus({ preventScroll: true });
};
window.sfCloseLocalSettings = function sfCloseLocalSettings() {
  const ov = document.getElementById("modalSfLocal");
  if (!ov) return;
  if (typeof _closeSettingsModal === "function") _closeSettingsModal("modalSfLocal"); else ov.classList.remove("open");
};

// ── Ajout manuel / import Excel / effacement ─────────────────
window.sfAddDistributeurRow = function sfAddDistributeurRow() {
  const f = document.getElementById("sfAddForm");
  if (!f) return;
  f.style.display = "flex";
  const n = document.getElementById("sfAddNom");
  if (n) { n.value = ""; n.focus(); }
  const i = document.getElementById("sfAddId");
  if (i) i.value = "";
};
window.sfCancelAddDist = function sfCancelAddDist() {
  const f = document.getElementById("sfAddForm");
  if (f) f.style.display = "none";
};
window.sfConfirmAddDist = async function sfConfirmAddDist() {
  const nom = (document.getElementById("sfAddNom")?.value || "").trim();
  const id  = String(document.getElementById("sfAddId")?.value || "").trim();
  if (!nom || !id) { _sfStatus("Renseignez le NOM et l'ID."); return; }
  if (!_sfIdOk(id)) { _sfStatus("ID invalide (caractères interdits : . $ # [ ] /, ne doit pas commencer par _)."); return; }
  const st = _sfD2State();
  if (st.map[id]) { _sfStatus(`L'ID ${id} existe déjà (${st.map[id].nom}).`); return; }
  const last = Object.keys(st.map).reduce((m, k) => Math.max(m, st.map[k].ordre), 0);
  await _sfD2Commit({ [id]: { nom, ordre: last + 1, hidden: false, src: "manual" } });
  sfCancelAddDist();
  _sfStatus(`Ajouté : ${nom}`);
  _sfAfterChange();
};

window.sfImportDistributeurs = function sfImportDistributeurs(input) {
  const file = input.files[0];
  if (!file) return;
  const statusEl = document.getElementById("sfImportStatus");
  statusEl.textContent = "Lecture en cours…";

  const reader = new FileReader();
  reader.onload = async function(e) {
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

      if (!imported.length) { uiStatus(statusEl, "err", "Aucune ligne valide (vérifiez les colonnes NOM et ID)."); return; }

      // ajout des nouveaux seulement (src="manual"), à la suite de l'ordre existant
      const st = _sfD2State();
      let last = Object.keys(st.map).reduce((m, k) => Math.max(m, st.map[k].ordre), 0);
      const patch = {}; let skipped = 0;
      imported.forEach(imp => {
        if (!_sfIdOk(imp.id)) { skipped++; return; }
        if (st.map[imp.id] || patch[imp.id]) return;
        patch[imp.id] = { nom: imp.nom, ordre: ++last, hidden: false, src: "manual" };
      });
      await _sfD2Commit(patch);
      const total = Object.keys(_sfD2State().map).length;
      uiStatus(statusEl, "ok", `${imported.length} importé(s) — total: ${total}` + (skipped ? ` — ${skipped} ID invalide(s) ignoré(s)` : ""));
      _sfAfterChange();
    } catch(err) {
      uiStatus(statusEl, "err", "Erreur: " + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
  input.value = "";
};

window.sfClearDistributeurs = async function sfClearDistributeurs() {
  const ok = typeof appConfirm === "function"
    ? await appConfirm("Effacer tous les distributeurs de cet entrepôt ? (partagé avec tous les utilisateurs)", { danger: true, okText: "Effacer" })
    : true;
  if (!ok) return;
  const st = _sfD2State();
  const patch = { "_meta/migrated": true };       // évite de recopier l'ancienne liste après l'effacement
  Object.keys(st.map).forEach(id => { patch[id] = null; });
  await _sfD2Commit(patch);
  _sfStatus("Liste effacée.");
  _sfAfterChange();
};

window.sfSyncFromOdoo = async function sfSyncFromOdoo() {
  const btn = document.getElementById("sfSyncBtn");
  if (btn) btn.disabled = true;
  _sfStatus("Synchronisation avec Odoo…");
  try {
    const r = await _sfSync(_sfWh());
    if (r.status === "blocked") _sfStatus("Liaison entrepôt / tournées non définie : synchronisation Odoo désactivée.");
    else if (r.status === "error") _sfStatus(r.msg, "err");
    else _sfStatus(`Synchronisé — ${r.added} ajouté(s), ${r.renamed} renommé(s) (${r.total} trouvé(s) dans Odoo).`, "ok");
    _sfAfterChange();
  } finally { if (btn) btn.disabled = false; }
};

// ── Stock Final — UI (cartes + modale) ────────────────────────
// Interface seulement. Données: cache JSON structuré par (date, distributeur) sous la clé "sf2_<date>_<id>".
// Aucun appel réseau au changement de date / à l'ouverture de l'onglet: seulement Actualiser (tout) ou ↻ (une carte).
const SF_CACHE_PREFIX  = "sf2_";
const SF_LAST_DATE_KEY = "sf_cache_last_date";

const _sfSvg = (inner, size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" class="sf-ic">${inner}</svg>`;
const _SF_P = {
  refresh:  '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  print:    '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  search:   '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  close:    '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  user:     '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  layers:   '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  alert:    '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  box:      '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  clock:    '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  dash:     '<line x1="5" y1="12" x2="19" y2="12"/>',
  gear:     '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
};
const _SF_IC = {};
Object.keys(_SF_P).forEach(k => { _SF_IC[k] = _sfSvg(_SF_P[k]); });

// ── État en mémoire ──────────────────────────────────────────
const _sfRt  = new Map();   // "<date>|<id>" -> { status:"loading"|"error", msg }
const _sfMem = new Map();   // repli si localStorage est plein
let _sfDistMap = new Map(); // id -> distributeur
let _sfEls     = new Map(); // id -> élément carte
let _sfFilterQ = "";
let _sfHasData = false;     // au moins une carte non vide pour la date affichée
let _sfAllToken = 0, _sfAllDate = null;
let _sfModalCtx = null, _sfModalRet = null;
let _sfLblTimer = null, _sfLblLast = 0;

const _sfToday  = () => new Date().toISOString().slice(0, 10);
const _sfCurDate = () => window._sfSelectedDate || _sfToday();
const _sfNormTxt = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// ── Cache structuré ──────────────────────────────────────────
const _sfKey = (date, id) => `${SF_CACHE_PREFIX}${date}_${id}`;
function _sfCacheGet(date, id) {
  const k = _sfKey(date, id);
  if (_sfMem.has(k)) return _sfMem.get(k);
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    return (rec && rec.v === 1 && Array.isArray(rec.rounds)) ? rec : null;
  } catch (_) { return null; }
}
function _sfCacheSet(date, id, rec) {
  const k = _sfKey(date, id);
  try { localStorage.setItem(k, JSON.stringify(rec)); _sfMem.delete(k); }
  catch (_) { _sfMem.set(k, rec); }
}
function _sfCacheClearDate(date) {
  const pre = `${SF_CACHE_PREFIX}${date}_`;
  try {
    const del = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(pre)) del.push(k);
    }
    del.forEach(k => localStorage.removeItem(k));
  } catch (_) {}
  [..._sfMem.keys()].forEach(k => { if (k.startsWith(pre)) _sfMem.delete(k); });
}

// ── Valeurs affichées / résumé ───────────────────────────────
// Même valeur CDN que le tableau de la modale (y compris _cdn_override).
function _sfLineCdn(l) {
  if (l._cdn_override !== undefined && l._cdn_override !== null) return l._cdn_override;
  return l.packaging_qty > 0 ? +(l.qty / l.packaging_qty).toFixed(2) : "—";
}
function _sfPkgKind(name) {
  const n = _sfNormTxt(name);
  const f = n.indexOf("fardeau"), c = n.indexOf("carton");
  if (f < 0 && c < 0) return "autre";
  if (c < 0) return "fardeau";
  if (f < 0) return "carton";
  return f < c ? "fardeau" : "carton";
}
const _sfFmtN = (n) => String(+n.toFixed(2));
function _sfSummary(rec) {
  const t = { fardeau: 0, carton: 0, autre: 0 };
  rec.rounds.forEach(r => (r.lines || []).forEach(l => {
    const v = _sfLineCdn(l);
    if (v === "—" || v === "") return;
    const n = Number(v);
    if (!isFinite(n)) return;
    t[_sfPkgKind(l.packaging_name)] += n;
  }));
  return { fardeau: _sfFmtN(t.fardeau), carton: _sfFmtN(t.carton), autre: _sfFmtN(t.autre), autreN: t.autre, rounds: rec.rounds.length };
}
function _sfFmtTs(ts) {
  if (!ts) return "";
  const d  = new Date(ts);
  const hm = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? hm
    : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }) + " " + hm;
}

// ── Récupération Odoo (mêmes appels qu'avant) ────────────────
async function _sfFetchDist(baseUrl, dist, date) {
  const plannings = await _rpc_call(baseUrl, {
    model: "planning.planning", method: "search_read",
    args: [[["user_id.id", "=", parseInt(dist.id)], ["date_start", "=", date]]],
    kwargs: { fields: ["id", "name", "date_start"] },
  });
  const rec = { v: 1, ts: Date.now(), status: plannings?.length ? "ok" : "none", rounds: [] };
  for (const round of (plannings || [])) {
    const lines = await _rpc_fetchStockFinal(baseUrl, round.id);
    const roundDate = (round.date_start || date).slice(0, 10).split("-").reverse().join("/");
    rec.rounds.push({
      id: round.id,
      name: String(round.name || round.id),
      label: `${dist.nom} - ${round.name || round.id} - ${roundDate}`,
      lines: lines || [],
    });
  }
  return rec;
}
async function _sfLoadDist(dist, date, baseUrl) {
  const key = `${date}|${dist.id}`;
  _sfRt.set(key, { status: "loading" });
  _sfPaintCard(dist.id, date);
  try {
    const rec = await _sfFetchDist(baseUrl, dist, date);
    _sfCacheSet(date, dist.id, rec);
    _sfRt.delete(key);
    try { localStorage.setItem(SF_LAST_DATE_KEY, date); } catch (_) {}
  } catch (err) {
    _sfRt.set(key, { status: "error", msg: err?.message || String(err) });
  }
  if (date === _sfCurDate()) _sfHasData = true;
  _sfPaintCard(dist.id, date);
  _sfRefreshModalIf(dist.id, date);
}

// ── Cartes ───────────────────────────────────────────────────
function _sfCardState(date, id) {
  const rt = _sfRt.get(`${date}|${id}`);
  if (rt) return { kind: rt.status, msg: rt.msg };
  const rec = _sfCacheGet(date, id);
  if (!rec) return { kind: "idle" };
  return rec.rounds.length ? { kind: "ok", rec } : { kind: "none", rec };
}
function _sfCardHtml(dist, date, st) {
  st = st || _sfCardState(date, dist.id);
  const nom = escHtml(dist.nom == null ? "" : dist.nom);
  let body = "";
  if (st.kind === "ok") {
    const s = _sfSummary(st.rec);
    const z = (v) => (parseFloat(v) === 0 ? " sf-chip--z" : "");
    body = `<div class="sf-chips">
        <span class="sf-chip sf-chip--f${z(s.fardeau)}"><b>${s.fardeau}</b><span class="sf-chip-l">Fardeau</span></span>
        <span class="sf-chip sf-chip--c${z(s.carton)}"><b>${s.carton}</b><span class="sf-chip-l">Carton</span></span>
        ${s.autreN > 0 ? `<span class="sf-chip sf-chip--o"><b>${s.autre}</b><span class="sf-chip-l">Autre</span></span>` : ""}
      </div>
      <div class="sf-card-f">
        <span class="sf-meta">${_SF_IC.layers}<span>${s.rounds} tournée${s.rounds > 1 ? "s" : ""}</span></span>
        <span class="sf-meta sf-meta--ts" title="Dernier chargement">${_SF_IC.clock}<span>${escHtml(_sfFmtTs(st.rec.ts))}</span></span>
      </div>`;
  } else if (st.kind === "loading") {
    body = `<div class="sf-sk" style="width:62%"></div><div class="sf-sk" style="width:88%"></div>`;
  } else if (st.kind === "error") {
    body = `<div class="sf-err">${_SF_IC.alert}<span class="sf-err-t" title="${escHtml(st.msg || "")}">Erreur de chargement</span>
      <button type="button" class="sf-retry" data-sf="card-refresh" title="Réessayer" aria-label="Réessayer">${_SF_IC.refresh}<span>Réessayer</span></button></div>`;
  } else if (st.kind === "none") {
    body = `<div class="sf-mid">Aucune tournée</div>`;
  } else {
    body = `<div class="sf-mid">Non chargé</div>`;
  }
  const loading = st.kind === "loading";
  const clickable = st.kind === "ok";
  return `<div class="sf-card sf-card--${st.kind}" data-id="${escHtml(dist.id)}" data-search="${escHtml(_sfNormTxt(dist.nom))}"${clickable ? ' role="button" tabindex="0"' : ""}${loading ? ' aria-busy="true"' : ""}>
    <div class="sf-card-h">
      <span class="sf-card-ic">${_SF_IC.user}</span>
      <span class="sf-card-t"><span class="sf-card-n" title="${nom}">${nom}</span></span>
      <button type="button" class="sf-rf${loading ? " is-spin" : ""}" data-sf="card-refresh" title="Actualiser" aria-label="Actualiser ${nom}"${loading ? " disabled" : ""}>${_SF_IC.refresh}</button>
    </div>
    ${body ? `<div class="sf-card-b">${body}</div>` : ""}
  </div>`;
}
function _sfPaintCard(id, date) {
  if (_sfCurDate() !== date) return;
  const sid = String(id);
  const dist = _sfDistMap.get(sid), old = _sfEls.get(sid);
  if (!dist || !old || !old.isConnected) return;
  const t = document.createElement("template");
  t.innerHTML = _sfCardHtml(dist, date).trim();
  const n = t.content.firstElementChild;
  old.replaceWith(n);
  _sfEls.set(sid, n);
  _sfMatchCard(n);
  _sfUpdateNote();
}

// ── Recherche (masque/affiche, sans re-rendu) ────────────────
function _sfMatchCard(n) {
  const s = n.dataset.search || "";
  const ok = !_sfFilterQ || _sfFilterQ.split(/\s+/).every(tok => s.includes(tok));
  n.classList.toggle("sf-hide", !ok);
  return ok;
}
function _sfApplyFilter() {
  let shown = 0;
  _sfEls.forEach(n => { if (_sfMatchCard(n)) shown++; });
  const empty = document.getElementById("sfEmpty");
  if (empty) empty.hidden = !(_sfFilterQ && _sfEls.size && !shown);
}

// ── Message d'aide / colonnes / barre ────────────────────────
const _SF_HINT = `<span class="sf-note-ic">${_sfSvg(_SF_P.box, 22)}</span><span>Appuyez sur <b>Actualiser</b> pour charger le stock final.</span>`;
function _sfUpdateNote() {
  const note = document.getElementById("sfNote");
  if (!note || note.dataset.warn) return;
  const date = _sfCurDate();
  let busy = false;
  _sfRt.forEach((_, k) => { if (k.startsWith(date + "|")) busy = true; });
  note.hidden = _sfHasData || busy;
}
function _sfSyncBar(date) {
  const bar = document.getElementById("sfBar");
  if (!bar) return;
  const isToday = date >= _sfToday();
  bar.querySelector(".sf-date-t").textContent = date;
  bar.querySelector(".sf-date-lbl").classList.toggle("sf-date-lbl--today", isToday);
  bar.querySelector(".sf-pill").classList.toggle("sf-pill--off", !isToday);
  bar.querySelector('[data-sf="next"]').disabled = isToday;
}
function _sfShiftDate(days) {
  window.AppDatePicker?.close?.();
  window._sfSelectedDate = new Date(new Date(_sfCurDate()).getTime() + days * 86400000).toISOString().slice(0, 10);
  sfRenderFromCache();
}
function _sfGoToday() {
  clearTimeout(_sfLblTimer);
  window.AppDatePicker?.close?.();
  const t = _sfToday();
  if (_sfCurDate() === t) { window._sfSelectedDate = t; return; }
  window._sfSelectedDate = t;
  sfRenderFromCache();
}
// Clic simple = ouvre le calendrier après un court délai ; double clic / double tap = aujourd'hui.
function _sfDateClick(btn) {
  const now = Date.now();
  clearTimeout(_sfLblTimer);
  if (now - _sfLblLast < 300) { _sfLblLast = 0; _sfGoToday(); return; }
  _sfLblLast = now;
  _sfLblTimer = setTimeout(() => { _sfLblLast = 0; _sfOpenDatePicker(btn); }, 300);
}
window._sfOpenDatePicker = function (anchor) {
  const today = _sfToday();                      // même "aujourd'hui" que la flèche suivante (pas de jours futurs)
  AppDatePicker.open(anchor, {
    mode: "day", align: "center", value: _sfCurDate(), max: today,
    onApply: (v) => { window._sfSelectedDate = v; sfRenderFromCache(); }
  });
};

// ── Coque (barre unique + grille) ────────────────────────────
function _sfEnsureShell(el) {
  if (el.querySelector(":scope > .sf-root")) return;
  _sfFilterQ = "";
  el.innerHTML = `<div class="sf-root">
    <div class="sf-bar" id="sfBar">
      <div class="sf-search">
        ${_SF_IC.search}
        <input id="sfSearch" type="text" placeholder="Rechercher un distributeur" autocomplete="off" spellcheck="false" aria-label="Rechercher un distributeur"/>
        <button type="button" class="sf-search-x" data-sf="clear" aria-label="Effacer la recherche" hidden>${_sfSvg(_SF_P.close, 12)}</button>
      </div>
      <div class="sf-date" data-perm="sf_date_bar">
        <button type="button" class="sf-arrow" data-sf="prev" aria-label="Jour précédent">&#8249;</button>
        <button type="button" class="sf-date-lbl" data-sf="date" title="Choisir une date (double clic : aujourd'hui)"><span class="sf-date-t"></span><span class="sf-pill sf-pill--off">Auj</span></button>
        <button type="button" class="sf-arrow" data-sf="next" aria-label="Jour suivant">&#8250;</button>
      </div>
      <button type="button" class="sf-btn sf-btn--local" data-sf="local" title="Ordre et affichage (cet appareil uniquement)" aria-label="Paramètres locaux : ordre et affichage">${_SF_IC.gear}</button>
      <button type="button" class="sf-btn sf-btn--primary" data-perm="sf_btn_refresh" data-sf="refresh" title="Actualiser" aria-label="Actualiser">${_SF_IC.refresh}<span class="sf-btn-t">Actualiser</span></button>
      <button type="button" class="sf-btn sf-btn--xls" data-perm="sf_btn_export" data-sf="xlsx" title="Tout exporter — Excel" aria-label="Tout exporter en Excel">${_SF_IC.download}<span class="sf-btn-t">Excel</span></button>
      <button type="button" class="sf-btn sf-btn--pdf" data-perm="sf_btn_export" data-sf="pdf" title="Tout exporter — PDF" aria-label="Tout exporter en PDF">${_SF_IC.print}<span class="sf-btn-t">PDF</span></button>
    </div>
    <div class="sf-note" id="sfNote" hidden></div>
    <div class="sf-grid" id="sfResultsContainer"></div>
    <div class="sf-empty" id="sfEmpty" hidden>Aucun distributeur ne correspond à la recherche.</div>
  </div>`;

  const bar = document.getElementById("sfBar");
  const inp = document.getElementById("sfSearch");
  const clr = bar.querySelector('[data-sf="clear"]');
  const grid = document.getElementById("sfResultsContainer");

  inp.addEventListener("input", () => {
    _sfFilterQ = _sfNormTxt(inp.value).trim();
    clr.hidden = !inp.value;
    _sfApplyFilter();
  });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && inp.value) { inp.value = ""; inp.dispatchEvent(new Event("input")); e.stopPropagation(); }
  });
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sf]");
    if (!b || !bar.contains(b) || b.disabled) return;
    switch (b.dataset.sf) {
      case "prev":    _sfShiftDate(-1); break;
      case "next":    if (_sfCurDate() < _sfToday()) _sfShiftDate(1); break;
      case "date":    _sfDateClick(b); break;
      case "local":   sfOpenLocalSettings(); break;
      case "refresh": renderGdsStockFinal(); break;
      case "xlsx":    sfExportAll("xlsx"); break;
      case "pdf":     sfExportAll("pdf"); break;
      case "clear":   inp.value = ""; inp.dispatchEvent(new Event("input")); inp.focus(); break;
    }
  });
  bar.addEventListener("dblclick", (e) => { if (e.target.closest('[data-sf="date"]')) _sfGoToday(); });

  grid.addEventListener("click", (e) => {
    const card = e.target.closest(".sf-card");
    if (!card || !grid.contains(card)) return;
    const act = e.target.closest('[data-sf="card-refresh"]');
    if (act) {
      e.stopPropagation();
      const d = _sfDistMap.get(card.dataset.id);
      if (d && !act.disabled) sfRefreshDist(d.id, d.nom);
      return;
    }
    if (card.classList.contains("sf-card--ok")) sfOpenModal(card.dataset.id);
  });
  grid.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList?.contains("sf-card--ok")) {
      e.preventDefault();
      sfOpenModal(e.target.dataset.id);
    }
  });
}

// ── Rendu depuis le cache uniquement (aucun réseau) ──────────
window.sfRenderFromCache = function sfRenderFromCache() {
  const el = document.getElementById("gdsStockFinalContent");
  if (!el) return;
  _sfEnsureShell(el);
  const date = _sfCurDate();
  _sfSyncBar(date);

  const grid = document.getElementById("sfResultsContainer");
  const note = document.getElementById("sfNote");
  const dists = sfGetDistributeurs();                // déjà trié (ordre puis nom), masqués exclus
  _sfDistMap = new Map(dists.map(d => [String(d.id), d]));
  _sfEls = new Map();

  _sfHasData = false;
  grid.innerHTML = dists.map(d => {
    const st = _sfCardState(date, d.id);
    if (st.kind !== "idle") _sfHasData = true;
    return _sfCardHtml(d, date, st);
  }).join("");
  [...grid.children].forEach(n => _sfEls.set(n.dataset.id, n));

  delete note.dataset.warn;
  note.innerHTML = _SF_HINT;
  note.hidden = _sfHasData;
  _sfApplyFilter();
};

// ── Actualiser (tout): vide le cache de la date puis recharge ─
window.renderGdsStockFinal = async function renderGdsStockFinal() {
  if (!isAdmin() && !_hasTabPerm("stockfinal")) return;
  const whId = _sfWh();
  // 1) synchro des distributeurs de l'entrepôt (ajoute seulement les nouveaux), puis lecture cloud si pas déjà faite
  const sync = await _sfSync(whId);
  if (sync.status !== "ok") { try { await _sfD2Load(whId); } catch (e) { console.warn("SF dists2 load failed:", e); } }
  if (sync.status === "error") _sfNotify("Synchro distributeurs : " + sync.msg, "error");
  else if (sync.status === "ok" && sync.added) _sfNotify(`${sync.added} nouveau(x) distributeur(s) ajouté(s)`, "success");
  if (_sfWh() !== whId) return;
  // 2) distributeurs visibles, dans l'ordre choisi
  const distributeurs = sfGetDistributeurs();
  if (!distributeurs.length) {
    const el = document.getElementById("gdsStockFinalContent");
    if (el) {
      _sfEnsureShell(el);
      _sfSyncBar(_sfCurDate());
      _sfDistMap = new Map(); _sfEls = new Map();
      document.getElementById("sfResultsContainer").innerHTML = "";
      const note = document.getElementById("sfNote");
      note.dataset.warn = "1";
      const allHidden = _sfD2List(null, true).length > 0;
      const msg = allHidden
        ? `Tous les distributeurs sont masqués.<br><small>Réaffichez-les dans Paramètres → Stock Final.</small>`
        : sync.status === "blocked"
          ? `Liaison entrepôt ↔ tournées non définie.<br><small>Ajoutez les distributeurs manuellement ou par Excel (Paramètres → Stock Final).</small>`
          : `Aucun livreur trouvé dans Odoo.<br><small>Vérifiez que les utilisateurs ont le workflow LIVREUR.</small>`;
      note.innerHTML = `<span class="sf-note-ic">${_sfSvg(_SF_P.alert, 22)}</span><span>${msg}</span>`;
      note.hidden = false;
    }
    return;
  }
  const baseUrl = ODOO_BASE;
  if (!baseUrl) return;

  const date = _sfCurDate();
  _sfCacheClearDate(date);
  distributeurs.forEach(d => _sfRt.set(`${date}|${d.id}`, { status: "loading" }));
  sfRenderFromCache();

  const token = ++_sfAllToken;
  _sfAllDate = date;
  let i = 0;
  for (; i < distributeurs.length; i++) {
    if (token !== _sfAllToken) break;
    await _sfLoadDist(distributeurs[i], date, baseUrl);
  }
  // Interrompu par une nouvelle actualisation d'une autre date: libérer les cartes restées en attente
  if (token !== _sfAllToken && _sfAllDate !== date) {
    for (let j = i; j < distributeurs.length; j++) {
      const k = `${date}|${distributeurs[j].id}`;
      if (_sfRt.get(k)?.status === "loading") _sfRt.delete(k);
    }
  }
};

// ── ↻ d'une carte ────────────────────────────────────────────
window.sfRefreshDist = async function sfRefreshDist(distId, distNom, distSafeId) {
  const date = _sfCurDate();
  if (_sfRt.get(`${date}|${distId}`)?.status === "loading") return;
  const dist = _sfDistMap.get(String(distId)) || { id: distId, nom: distNom };
  const baseUrl = ODOO_BASE;
  if (!baseUrl) {
    _sfRt.set(`${date}|${distId}`, { status: "error", msg: "Odoo indisponible" });
    _sfPaintCard(distId, date);
    return;
  }
  await _sfLoadDist(dist, date, baseUrl);
};

// ── Modale (système smodal existant) ─────────────────────────
function _sfEnsureModal() {
  let ov = document.getElementById("modalSfDist");
  if (ov) return ov;
  ov = document.createElement("div");
  ov.className = "smodal-overlay";
  ov.id = "modalSfDist";
  ov.innerHTML = `<div class="smodal-box" role="dialog" aria-modal="true" aria-labelledby="sfModalTitle" tabindex="-1">
    <div class="smodal-header">
      <div class="sf-mh"><span class="smodal-title" id="sfModalTitle"></span><span class="sf-mh-sub" id="sfModalSub"></span></div>
      <button type="button" class="smodal-close" data-sf="close" aria-label="Fermer">${_sfSvg(_SF_P.close, 16)}</button>
    </div>
    <div class="smodal-body" id="sfModalBody"></div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sf]");
    if (!b) return;
    if (b.dataset.sf === "close") { sfCloseModal(); return; }
    if (b.dataset.sf === "exp" && _sfModalCtx) {
      const rec = _sfCacheGet(_sfModalCtx.date, _sfModalCtx.id);
      const r = rec?.rounds?.[parseInt(b.dataset.r)];
      if (!r) return;
      if (b.dataset.fmt === "pdf") exportStockFinalPdf(r.label, r.lines);
      else exportStockFinalXlsx(r.label, r.lines);
    }
  });
  return ov;
}
function _sfRenderModal() {
  const ctx = _sfModalCtx;
  if (!ctx) return;
  const dist = _sfDistMap.get(ctx.id);
  const rec  = _sfCacheGet(ctx.date, ctx.id);
  document.getElementById("sfModalTitle").textContent = dist ? dist.nom : ctx.id;
  document.getElementById("sfModalSub").textContent   = ctx.date.split("-").reverse().join("/");
  const body = document.getElementById("sfModalBody");
  if (!rec) { body.innerHTML = `<div class="sf-empty">Aucune donnée.</div>`; return; }
  body.innerHTML = rec.rounds.map((r, i) => {
    const lines = r.lines || [];
    const head = `<div class="sf-round-h">${_SF_IC.layers}<span>Tournée: ${escHtml(r.name)}</span></div>`;
    if (!lines.length) return `<section class="sf-round">${head}<div class="sf-round-empty">Stock final vide.</div></section>`;
    const rows = lines.map(l => `<tr><td class="sf-td-a">${escHtml(_sfPn(l.name))}</td><td class="sf-td-n">${escHtml(_sfLineCdn(l))}</td><td class="sf-td-q">${escHtml(l.qty)}</td></tr>`).join("");
    return `<section class="sf-round">${head}
      <div class="sf-tw"><table class="sf-tbl"><thead><tr><th>Article</th><th>CDN</th><th>Qté</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="sf-xrow">
        <button type="button" class="sf-x sf-x--pdf" data-sf="exp" data-fmt="pdf" data-r="${i}">${_SF_IC.print}<span>PDF</span></button>
        <button type="button" class="sf-x sf-x--xls" data-sf="exp" data-fmt="xlsx" data-r="${i}">${_SF_IC.download}<span>EXCEL</span></button>
      </div>
    </section>`;
  }).join("");
}
function _sfRefreshModalIf(id, date) {
  const ov = document.getElementById("modalSfDist");
  if (ov && ov.classList.contains("open") && _sfModalCtx && _sfModalCtx.id === String(id) && _sfModalCtx.date === date) _sfRenderModal();
}
window.sfOpenModal = function sfOpenModal(id) {
  const date = _sfCurDate();
  if (!_sfCacheGet(date, id)) return;
  _sfModalCtx = { id: String(id), date };
  _sfModalRet = document.activeElement;
  const ov = _sfEnsureModal();
  _sfRenderModal();
  document.getElementById("sfModalBody").scrollTop = 0;
  if (typeof _openSettingsModal === "function") _openSettingsModal("modalSfDist"); else ov.classList.add("open");
  ov.querySelector(".smodal-box").focus({ preventScroll: true });
};
window.sfCloseModal = function sfCloseModal() {
  const ov = document.getElementById("modalSfDist");
  if (ov) { if (typeof _closeSettingsModal === "function") _closeSettingsModal("modalSfDist"); else ov.classList.remove("open"); }
  _sfModalCtx = null;
  if (_sfModalRet && _sfModalRet.isConnected) { try { _sfModalRet.focus({ preventScroll: true }); } catch (_) {} }
  _sfModalRet = null;
};
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const ov = document.getElementById("modalSfDist");
  if (ov && ov.classList.contains("open")) { e.stopPropagation(); sfCloseModal(); }
});


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
            allRows.push([`  ${_sfPn(l.name)}`, cdn, l.qty]);
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
              return [_sfPn(l.name), cdn, l.qty];
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
            return [_sfPn(l.name), cdn, l.qty];
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
        name: _sfPn(nameRaw),
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