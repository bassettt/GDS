// ============================================================
// src/auth.js — OwlGDS App Authentication Layer
// Layer 1: App login (Firebase) → Layer 2: Odoo session
// Roles: admin | user | group1 | group2 | group3
// ============================================================

const _FB_DB_URL = "https://owdoo-f265f-default-rtdb.europe-west1.firebasedatabase.app";

// ── Current session ───────────────────────────────────────────
const AppAuth = {
  currentUser: null, // { username, role }
};

// ── Hash password (SHA-256) ───────────────────────────────────
// Pure-JS SHA-256 fallback: crypto.subtle is undefined on non-secure origins (http://192.168.x.x)
function _sha256Fallback(bytes) {
  const K = new Uint32Array(64), H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  for (let i = 0, n = 2, c = 0; c < 64; n++) { let p = true; for (let d = 2; d * d <= n; d++) if (n % d === 0) { p = false; break; }
    if (p) { K[c++] = Math.floor((Math.cbrt(n) % 1) * 4294967296); } }
  const l = bytes.length, total = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(total);
  m.set(bytes); m[l] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(total - 8, Math.floor((l * 8) / 4294967296)); dv.setUint32(total - 4, (l * 8) >>> 0);
  const w = new Uint32Array(64), rr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) { const s0 = rr(w[i-15],7) ^ rr(w[i-15],18) ^ (w[i-15] >>> 3), s1 = rr(w[i-2],17) ^ rr(w[i-2],19) ^ (w[i-2] >>> 10); w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0; }
    let [a,b,c,d,e,f,g,h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rr(e,6) ^ rr(e,11) ^ rr(e,25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rr(a,2) ^ rr(a,13) ^ rr(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0]+=a; H[1]+=b; H[2]+=c; H[3]+=d; H[4]+=e; H[5]+=f; H[6]+=g; H[7]+=h;
  }
  return Array.from(H).map(x => x.toString(16).padStart(8, "0")).join("");
}

async function _hashPassword(password) {
  const enc = new TextEncoder().encode(password);
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  return _sha256Fallback(enc);
}

// ── Firebase helpers ──────────────────────────────────────────
async function _fbGet(path) {
  const r = await fetch(`${_FB_DB_URL}/${path}.json`);
  return r.json();
}
async function _fbSet(path, data) {
  await fetch(`${_FB_DB_URL}/${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
async function _fbPatch(path, data) {
  await fetch(`${_FB_DB_URL}/${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
async function _fbDelete(path) {
  await fetch(`${_FB_DB_URL}/${path}.json`, { method: "DELETE" });
}

// ── Initialize default admin if no users exist ────────────────
async function _ensureDefaultAdmin() {
  const users = await _fbGet("app_users");
  if (!users || Object.keys(users).length === 0) {
    const hash = await _hashPassword("admin123");
    await _fbSet("app_users/admin", {
      username: "admin",
      password: hash,
      role: "admin",
      createdAt: Date.now(),
    });
    console.log("Default admin created: admin / admin123");
  }
}

// ── App Login ─────────────────────────────────────────────────
async function appLogin(username, password) {
  const users = await _fbGet("app_users");
  if (!users) throw new Error("Aucun utilisateur trouvé");

  const user = users[username.toLowerCase()];
  if (!user) throw new Error("Identifiant ou mot de passe incorrect");

  const hash = await _hashPassword(password);
  if (hash !== user.password) throw new Error("Identifiant ou mot de passe incorrect");
  if (user.disabled) throw new Error("Ce compte est désactivé. Contactez l'administrateur.");

  AppAuth.currentUser = { username: user.username, displayName: user.displayName || user.username, role: user.role, passwordHash: hash, warehouses: user.warehouses || [] };
  localStorage.setItem("owlgds_app_user", JSON.stringify(AppAuth.currentUser));
  return AppAuth.currentUser;
}

// ── App Logout ────────────────────────────────────────────────
function appLogout() {
  AppAuth.currentUser = null;
  localStorage.removeItem("owlgds_app_user");
}

// ── Restore session ───────────────────────────────────────────
async function _restoreAppSession() {
  try {
    const saved = localStorage.getItem("owlgds_app_user");
    if (saved) {
      const parsed = JSON.parse(saved);
      // تحقق من الـ hash مقابل Firebase فقط للتأكد من أن الحساب لم يُحذف أو يُغيَّر أو يُعطَّل
      const fbUser = await _fbGet(`app_users/${parsed.username}`);
      if (!fbUser || fbUser.disabled || fbUser.password !== parsed.passwordHash) {
        // كلمة المرور تغيرت أو الحساب حُذف أو عُطِّل — تسجيل خروج
        localStorage.removeItem("owlgds_app_user");
        return false;
      }
      AppAuth.currentUser = { username: parsed.username, displayName: fbUser.displayName || parsed.username, role: fbUser.role, passwordHash: parsed.passwordHash, warehouses: fbUser.warehouses || [] };
      return true;
    }
  } catch (_) {}
  return false;
}

// ── Role checks ───────────────────────────────────────────────
function isAdmin()   { return AppAuth.currentUser?.role === "admin"; }
function isViewer()  { return ["group1","group2","group3"].includes(AppAuth.currentUser?.role); }
function canEdit()   { return ["admin", "user"].includes(AppAuth.currentUser?.role); }

// ── Permission map (matches data-perm attributes in app.js) ───
const ROLE_PERMISSIONS = {
  gds_stock: [
    { perm: "stock_actualiser", label: "Stock — Actualiser" },
    { perm: "stock_expand",     label: "Stock — Tout ouvrir" },
    { perm: "stock_collapse",   label: "Stock — Tout fermer" },
  ],
  gds_vans: [
    { perm: "vans_actualiser", label: "Vans — Actualiser" },
    { perm: "vans_expand",     label: "Vans — Tout ouvrir" },
    { perm: "vans_collapse",   label: "Vans — Tout fermer" },
  ],
  gds_transferts: [
    { perm: "transferts_actualiser", label: "Transferts — Actualiser" },
    { perm: "tr_state",  label: "Transferts — Bouton d'état (Marquer à faire / Vérifier / Valider)" },
    { perm: "tr_cancel", label: "Transferts — Annuler" },
    { perm: "tr_pdf_bc", label: "Transferts — Télécharger Bon de chargement (PDF)" },
    { perm: "tr_pdf_gds",       label: "Transferts — Imprimer Bon de chargement GDS" },
    { perm: "tr_print_switch",  label: "Transferts — Basculer l'impression App / Odoo" },
  ],
  gds_preparation: [
    { perm: "prep_nouvelle",          label: "Préparation — Nouvelle" },
    { perm: "prep_modifier",          label: "Préparation — Modifier" },
    { perm: "prep_terminer",          label: "Préparation — Terminer" },
    { perm: "prep_rapport",           label: "Préparation — Rapport" },
    { perm: "prep_charge_actualiser", label: "Préparation — Actualiser chargement" },
    { perm: "prep_depuis_a",          label: "Préparation — Depuis / À (dates)" },
    { perm: "prep_bon_toggle",        label: "Préparation — Activer/Désactiver bon" },
    { perm: "prep_hors_date",         label: "Préparation — Hors date" },
    { perm: "prep_hors_date_add",     label: "Préparation — Hors date (+)" },
    { perm: "prep_overstock",         label: "Préparation — Autoriser dépasser le stock" },
    { perm: "prep_mode",              label: "Préparation — Changer de mode (Odoo / Libre)" },
    { perm: "prep_visibility",        label: "Préparation — Masquer / afficher les produits" },
  ],
  gds_stock_final: [
    { perm: "sf_date_bar",    label: "Stock Final — Barre de date" },
    { perm: "sf_btn_today",   label: "Stock Final — Aujourd'hui" },
    { perm: "sf_btn_refresh", label: "Stock Final — Actualiser" },
    { perm: "sf_btn_export",  label: "Stock Final — Tout exporter" },
  ],
  gds_tabs: [
    { perm: "tab_stock",       label: "Onglet — Stock GDS" },
    { perm: "tab_vans",        label: "Onglet — Vans" },
    { perm: "tab_transferts",  label: "Onglet — Transferts" },
    { perm: "tab_preparation", label: "Onglet — Préparation" },
    { perm: "tab_stockfinal",  label: "Onglet — Stock Final" },
  ],
};

// Permissions OFF by default for non-admin roles (admin-only until explicitly granted)
const PERM_DEFAULT_OFF = ["prep_mode", "prep_visibility", "tr_state", "tr_cancel", "tr_print_switch"];

const ROLE_SECTION_LABELS = {
  gds_stock:       "GDS — Stock",
  gds_vans:        "GDS — Vans",
  gds_transferts:  "GDS — Transferts",
  gds_preparation: "GDS — Préparation",
  gds_stock_final: "GDS — Stock Final",
  gds_tabs:        "GDS — Onglets (accès sections)",
};

// ── Firebase helpers for permissions ─────────────────────────
// Firebase deletes keys with empty arrays [] automatically.
// We store "__none__" as sentinel when all perms are removed.
const _PERM_NONE = "__none__";

async function _loadRolePermissions() {
  try { const d = await _fbGet("role_permissions"); return d || {}; } catch(_) { return {}; }
}
async function _saveRolePermissions(perms) {
  // Replace empty arrays with sentinel before saving
  const safe = JSON.parse(JSON.stringify(perms));
  for (const section of Object.keys(safe)) {
    for (const role of Object.keys(safe[section])) {
      if (Array.isArray(safe[section][role]) && safe[section][role].length === 0) {
        safe[section][role] = _PERM_NONE;
      }
    }
  }
  await _fbSet("role_permissions", safe);
}

// Decode loaded perms: convert sentinel back to []
function _decodePerm(val) {
  if (val === _PERM_NONE) return [];
  if (Array.isArray(val)) return val;
  return undefined; // not configured
}

// ── Build flat lookup: perm → section ────────────────────────
function _permSectionMap() {
  const map = {};
  for (const [section, btns] of Object.entries(ROLE_PERMISSIONS))
    btns.forEach(b => { map[b.perm] = section; });
  return map;
}

// ── Core: hide/show [data-perm] for current role ─────────────
let _permCache = null;
let _permObserver = null;
let _permApplying = false;

async function applyRolePermissions() {
  if (isAdmin()) {
    const guardStyle = document.getElementById("tabGuardStyle");
    if (guardStyle) guardStyle.remove();
    return;
  }
  const role = AppAuth.currentUser?.role;
  if (!role) return;

  _permCache = await _loadRolePermissions();
  const sectionMap = _permSectionMap();

  function _applyPerms() {
    if (_permApplying) return;
    _permApplying = true;
    // Disconnect observer during apply to avoid infinite loop
    if (_permObserver) _permObserver.disconnect();

document.querySelectorAll("[data-perm]").forEach(el => {
      const perm    = el.dataset.perm;
      const section = sectionMap[perm];
      if (!section) return;
      const raw     = _permCache[section]?.[role];
      const allowed = _decodePerm(raw);
      // undefined = never configured → show by default
      // [] = all hidden (sentinel decoded) → hide all
      const visible = (allowed === undefined) || allowed.includes(perm);
      el.style.display = visible ? "" : "none";
    });

    // Reconnect observer after DOM changes are done
    requestAnimationFrame(() => {
      if (_permObserver) {
        _permObserver.observe(
          document.getElementById("app") || document.body,
          { childList: true, subtree: true }
        );
      }
      _permApplying = false;
    });
  }

  // Apply tab button visibility
  await _applyTabVisibility();

  _permObserver = new MutationObserver((mutations) => {
    // Only re-apply if new [data-perm] elements were added
    const hasNewPermEl = mutations.some(m =>
      [...m.addedNodes].some(n =>
        n.nodeType === 1 && (n.matches?.("[data-perm]") || n.querySelector?.("[data-perm]"))
      )
    );
    if (hasNewPermEl) _applyPerms();
  });

  _applyPerms();
  _permObserver.observe(
    document.getElementById("app") || document.body,
    { childList: true, subtree: true }
  );
}

// ── Hide tab buttons the user has no access to ────────────────
async function _applyTabVisibility() {
  if (isAdmin()) return;
  const role = AppAuth.currentUser?.role;
  if (!role) return;

  const perms = _permCache || await _loadRolePermissions();
  const tabMap = {
    gdsTabStock:       "tab_stock",
    gdsTabVans:        "tab_vans",
    gdsTabTransferts:  "tab_transferts",
    gdsTabPreparation: "tab_preparation",
    gdsTabStockFinal:  "tab_stockfinal",
  };

  const section = "gds_tabs";
  const raw     = perms[section]?.[role];
  const allowed = _decodePerm(raw); // undefined = all allowed

  let firstAllowedTab = null;

  for (const [btnId, perm] of Object.entries(tabMap)) {
    const btn = document.getElementById(btnId);
    if (!btn) continue;

    const hasAccess = allowed === undefined || allowed.includes(perm);
    btn.style.display = hasAccess ? "" : "none";

    if (hasAccess && !firstAllowedTab) {
      const tabKey = perm.replace("tab_", "").replace("stock", "stock").replace("stockfinal", "stockfinal");
      // Map perm to tab key used in gdsShowTab
      const permToTab = {
        tab_stock: "stock", tab_vans: "vans", tab_transferts: "transferts",
        tab_preparation: "preparation", tab_stockfinal: "stockfinal"
      };
      firstAllowedTab = permToTab[perm];
    }
  }

  // Remove the initial CSS guard that hid all tabs
  const guardStyle = document.getElementById("tabGuardStyle");
  if (guardStyle) guardStyle.remove();

  // Always auto-open first allowed tab
  if (firstAllowedTab) {
    setTimeout(() => {
      if (typeof gdsShowTab === "function") gdsShowTab(firstAllowedTab);
    }, 0);
  }
}

// Block click on hidden buttons forced visible via devtools
document.addEventListener("click", e => {
  const el = e.target.closest("[data-perm]");
  if (el && el.style.display === "none") {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
}, true);

// ── Admin UI : « Permissions par rôle » ───────────────────────
// • Un seul rôle affiché à la fois (segmented control), recherche, groupes repliables, switches.
// • Enregistrement automatique : chaque changement écrit UNIQUEMENT role_permissions/{section}/{role}
//   (tableau, ou "__none__" si vide) — « Copier depuis » = un PATCH multi-chemins.
// • Lecture complète de role_permissions : à l'ouverture de la fenêtre et via Actualiser seulement.
// • Écritures en file (queue) ; _permCache mis à jour immédiatement ; erreur => retour à l'état confirmé.
const RP_ROLES = [
  { id: "user",   label: "Utilisateur", color: "#22c55e" },
  { id: "group1", label: "Group 1",     color: "#f59e0b" },
  { id: "group2", label: "Group 2",     color: "#a78bfa" },
  { id: "group3", label: "Group 3",     color: "#f87171" },
];
const RP_GROUP_TITLES = {
  gds_stock: "Stock", gds_vans: "Vans", gds_transferts: "Transferts",
  gds_preparation: "Préparation", gds_stock_final: "Stock Final",
};
// Affichage uniquement : le switch de chaque onglet (stocké sous gds_tabs) est rendu comme 1re ligne du groupe de cet onglet.
const RP_TAB_SECTION   = "gds_tabs";
const RP_TAB_ROW_LABEL = "Accès à l'onglet";
const RP_TAB_GROUP = {
  tab_stock:       "gds_stock",
  tab_vans:        "gds_vans",
  tab_transferts:  "gds_transferts",
  tab_preparation: "gds_preparation",
  tab_stockfinal:  "gds_stock_final",
};
const RP_ROLE_LS_KEY = "owlgds_perm_ui_role";

const _RP = { role: "user", q: "", open: { gds_stock: true }, loaded: false, loading: false, bound: false };
let _permQueue     = Promise.resolve();   // file d'écritures (une à la fois, dans l'ordre)
let _permPending   = 0;                   // écritures en attente / en cours
const _permDirty   = new Set();           // chemins modifiés non encore écrits
let _permConfirmed = {};                  // chemin -> dernière valeur confirmée par Firebase
const _permFailed  = new Map();           // chemin -> valeur voulue (pour « Réessayer »)

const _permPath = (section, role) => `role_permissions/${section}/${role}`;
const _permRawOf = (arr) => (arr.length ? arr : _PERM_NONE);
const _rpRole = (id) => RP_ROLES.find(r => r.id === id);
const _rpEl = (id) => document.getElementById(id);
const _rpNorm = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

async function _fbWriteChecked(path, data, method) {
  const r = await fetch(`${_FB_DB_URL}/${path}.json`, {
    method: method || "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
}
async function _permFetchAllChecked() {
  const r = await fetch(`${_FB_DB_URL}/role_permissions.json`, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return (await r.json()) || {};
}

function _permGetRaw(section, role) {
  return (_permCache && _permCache[section]) ? _permCache[section][role] : undefined;
}
function _permSetRaw(section, role, raw) {
  if (raw === undefined) { if (_permCache && _permCache[section]) delete _permCache[section][role]; return; }
  if (!_permCache) _permCache = {};
  if (!_permCache[section]) _permCache[section] = {};
  _permCache[section][role] = Array.isArray(raw) ? [...raw] : raw;
}
// Liste autorisée telle qu'affichée : rôle jamais configuré => tout sauf PERM_DEFAULT_OFF
function _permEffective(section, role) {
  const d = _decodePerm(_permGetRaw(section, role));
  if (d !== undefined) return d;
  return ROLE_PERMISSIONS[section].map(b => b.perm).filter(p => !PERM_DEFAULT_OFF.includes(p));
}
function _permSameRaw(a, b) {
  const da = _decodePerm(a), db = _decodePerm(b);
  if (da === undefined || db === undefined) return da === db;
  return da.length === db.length && da.every(p => db.includes(p));
}

// ── Indicateur d'état (en-tête de la fenêtre) ─────────────────
function _permSetStatus(state) {
  const el = _rpEl("permStatus"); if (!el) return;
  el.dataset.state = state;
  el.disabled = state !== "error";
  if (state === "saving")     el.innerHTML = icon("loader", 13, "ui-spin") + "<span>Enregistrement…</span>";
  else if (state === "saved") el.innerHTML = icon("check", 13) + "<span>Enregistré</span>";
  else if (state === "error") el.innerHTML = icon("alert", 13) + "<span>Erreur — Réessayer</span>";
  else el.innerHTML = "";
}

// ── File d'écritures ──────────────────────────────────────────
function _permEnqueue(task) {
  _permPending++;
  _permSetStatus("saving");
  _permQueue = _permQueue.then(task).catch(() => {}).then(() => {
    _permPending--;
    if (_permPending === 0) _permSetStatus(_permFailed.size ? "error" : "saved");
  });
  return _permQueue;
}

// Écrit l'état COURANT du cache pour (section, role) — les écritures consécutives sur le même chemin fusionnent.
function _permQueueWrite(section, role) {
  const path = _permPath(section, role);
  _permDirty.add(path);
  return _permEnqueue(async () => {
    if (!_permDirty.has(path)) return;            // déjà écrit / annulé par une tâche précédente
    _permDirty.delete(path);
    const raw = _permGetRaw(section, role);
    try {
      await _fbWriteChecked(path, raw === undefined ? null : raw);
      _permConfirmed[path] = raw === undefined ? undefined : (Array.isArray(raw) ? [...raw] : raw);
    } catch (e) {
      console.warn("[perm] write failed:", path, e);
      _permFailed.set(path, raw);
      _permSetRaw(section, role, _permConfirmed[path]);   // retour à l'état précédent
      _permDirty.delete(path);
      _rpSyncAll();
    }
  });
}

function _permApplyLocal(section, role, arr) {
  _permSetRaw(section, role, _permRawOf(arr));
  return _permQueueWrite(section, role);
}
function _permToggle(section, role, perm, on) {
  let arr = [..._permEffective(section, role)];
  if (on) { if (!arr.includes(perm)) arr.push(perm); }
  else arr = arr.filter(p => p !== perm);
  _permApplyLocal(section, role, arr);
}
// Écrit plusieurs chemins d'un même rôle en un seul PATCH (atomique) ; retour à l'état confirmé si échec
function _permQueuePatch(role, changes) {
  const body = {};
  changes.forEach(c => {
    c.path = _permPath(c.section, role);
    c.raw  = _permRawOf(c.next);
    _permSetRaw(c.section, role, c.raw);          // optimiste
    _permDirty.delete(c.path);
    body[`${c.section}/${role}`] = Array.isArray(c.raw) ? [...c.raw] : c.raw;
  });
  _rpSyncAll();
  return _permEnqueue(async () => {
    try {
      await _fbWriteChecked("role_permissions", body, "PATCH");
      changes.forEach(c => { _permConfirmed[c.path] = Array.isArray(c.raw) ? [...c.raw] : c.raw; });
    } catch (e) {
      console.warn("[perm] bulk failed:", e);
      changes.forEach(c => {
        _permFailed.set(c.path, c.raw);
        _permSetRaw(c.section, role, _permConfirmed[c.path]);
      });
      _rpSyncAll();
    }
  });
}
// Tout / Aucun d'un groupe : section du groupe + (uniquement) la clé de son onglet dans gds_tabs
function _permBulk(section, role, all) {
  const changes = [];
  const arr = all ? ROLE_PERMISSIONS[section].map(b => b.perm) : [];
  const cur = _permEffective(section, role);
  if (!(cur.length === arr.length && cur.every(p => arr.includes(p)))) changes.push({ section, next: arr });   // rien à écrire sinon

  const tabPerm = _rpTabPermOf(section);
  if (tabPerm) {
    const tcur = _permEffective(RP_TAB_SECTION, role);
    if (tcur.includes(tabPerm) !== all) {
      changes.push({ section: RP_TAB_SECTION, next: all ? [...tcur, tabPerm] : tcur.filter(p => p !== tabPerm) });
    }
  }
  if (!changes.length) return;
  if (changes.length === 1) { _permApplyLocal(changes[0].section, role, changes[0].next); return; }
  _permQueuePatch(role, changes);
}
function _permRetry() {
  if (!_permFailed.size) return;
  const items = [..._permFailed.entries()];
  _permFailed.clear();
  items.forEach(([path, raw]) => {
    const [, section, role] = path.split("/");
    _permSetRaw(section, role, raw);
    _permQueueWrite(section, role);
  });
  _rpSyncAll();
}

// Copier les permissions d'un rôle vers le rôle affiché — PATCH multi-chemins (un seul appel)
async function _permCopyFrom(srcRole) {
  const dst = _RP.role;
  if (!srcRole || srcRole === dst) return;
  const ok = await appConfirm(
    `Copier les permissions de « ${_rpRole(srcRole).label} » vers « ${_rpRole(dst).label} » ? Les réglages actuels de « ${_rpRole(dst).label} » seront remplacés.`,
    { title: "Copier les permissions", okText: "Copier" });
  if (!ok) return;

  const body = {}, changes = [];
  for (const section of Object.keys(ROLE_PERMISSIONS)) {
    const sRaw = _permGetRaw(section, srcRole), dRaw = _permGetRaw(section, dst);
    if (_permSameRaw(sRaw, dRaw)) continue;
    body[`${section}/${dst}`] = sRaw === undefined ? null : (Array.isArray(sRaw) ? [...sRaw] : sRaw);
    changes.push({ section, path: _permPath(section, dst), next: sRaw });
  }
  if (!changes.length) { try { addNotif("Aucune différence à copier", "info"); } catch (_) {} return; }

  changes.forEach(c => { _permSetRaw(c.section, dst, c.next); _permDirty.delete(c.path); });   // optimiste
  _rpSyncAll();
  _permEnqueue(async () => {
    try {
      await _fbWriteChecked("role_permissions", body, "PATCH");
      changes.forEach(c => { _permConfirmed[c.path] = c.next === undefined ? undefined : (Array.isArray(c.next) ? [...c.next] : c.next); });
    } catch (e) {
      console.warn("[perm] copy failed:", e);
      changes.forEach(c => {
        _permFailed.set(c.path, c.next);
        _permSetRaw(c.section, dst, _permConfirmed[c.path]);
      });
      _rpSyncAll();
    }
  });
}

// ── Rendu ─────────────────────────────────────────────────────
function _rpSplitLabel(label) {
  const i = label.indexOf(" — ");
  const t = i >= 0 ? label.slice(i + 3) : label;       // la section est déjà dans le titre du groupe
  const m = t.match(/^(.*?)\s*(\([^()]*\))$/);
  return (m && m[1] && m[2].length > 4) ? { main: m[1], sub: m[2] } : { main: t, sub: "" };
}
function _rpTabPermOf(section) {
  return Object.keys(RP_TAB_GROUP).find(p => RP_TAB_GROUP[p] === section);
}
// Lignes d'un groupe : [clé d'onglet (section réelle gds_tabs)] + permissions du groupe. Chaque ligne porte sa vraie section.
function _rpGroupItems(section) {
  const items = ROLE_PERMISSIONS[section].map(b => ({ perm: b.perm, label: b.label, hay: "", section, isTab: false }));
  const tabPerm = _rpTabPermOf(section);
  const orig = tabPerm && ROLE_PERMISSIONS[RP_TAB_SECTION].find(b => b.perm === tabPerm);
  if (orig) items.unshift({ perm: tabPerm, label: RP_TAB_ROW_LABEL, hay: `${orig.label} Onglets`, section: RP_TAB_SECTION, isTab: true });
  return items;
}
function _rpHay(section, b) {
  return _rpNorm(`${RP_GROUP_TITLES[section]} ${b.label} ${b.hay || ""} ${b.perm}`);
}

function _rpRenderSeg() {
  const seg = _rpEl("rpSeg"); if (!seg) return;
  const root = _rpEl("rpRoot");
  if (root) root.style.setProperty("--rc", _rpRole(_RP.role).color);
  seg.innerHTML = RP_ROLES.map(r => {
    const on = r.id === _RP.role;
    return `<button type="button" role="tab" aria-selected="${on}" class="rp-seg-btn${on ? " on" : ""}" data-role="${r.id}"
      style="--c:${r.color};--ct:${r.color}22"><i></i><span>${r.label}</span></button>`;
  }).join("");
}
function _rpRenderCopy() {
  const sel = _rpEl("rpCopy"); if (!sel) return;
  sel.innerHTML = `<option value="">Copier depuis un autre rôle…</option>` +
    RP_ROLES.filter(r => r.id !== _RP.role).map(r => `<option value="${r.id}">${r.label}</option>`).join("");
  sel.value = "";
}

function _rpRenderGroups() {
  const box = _rpEl("rpGroups"); if (!box) return;
  const role = _RP.role;
  const toks = _rpNorm(_RP.q.trim()).split(/\s+/).filter(Boolean);
  let html = "", shown = 0;
  for (const section of Object.keys(ROLE_PERMISSIONS)) {
    if (section === RP_TAB_SECTION) continue;      // rendu dans les groupes de chaque onglet
    const items = _rpGroupItems(section);
    const rows = toks.length ? items.filter(b => { const h = _rpHay(section, b); return toks.every(t => h.includes(t)); }) : items;
    if (!rows.length) continue;
    shown++;
    const on = items.filter(b => _permEffective(b.section, role).includes(b.perm)).length;
    const open = toks.length ? true : !!_RP.open[section];
    html += `
      <div class="rp-group${open ? " open" : ""}" data-section="${section}">
        <div class="rp-gh">
          <button type="button" class="rp-gt" data-act="toggle" aria-expanded="${open}">
            <span class="rp-chev">${icon("chevron-right", 16)}</span>
            <span class="rp-gname">${escHtml(RP_GROUP_TITLES[section])}</span>
            <span class="rp-count${on === items.length ? " full" : on === 0 ? " zero" : ""}">${on}/${items.length}</span>
          </button>
          <div class="rp-gb">
            <button type="button" class="rp-mini" data-act="all">Tout</button>
            <button type="button" class="rp-mini" data-act="none">Aucun</button>
          </div>
        </div>
        <div class="rp-rows">
          ${rows.map(b => {
            const { main, sub } = _rpSplitLabel(b.label);
            const off = PERM_DEFAULT_OFF.includes(b.perm);
            const chk = _permEffective(b.section, role).includes(b.perm);
            return `<label class="rp-row${b.isTab ? " rp-row--tab" : ""}" data-section="${b.section}">
              <span class="rp-txt">${escHtml(main)}${off ? `<span class="rp-badge">Désactivée par défaut</span>` : ""}${sub ? `<span class="rp-sub">${escHtml(sub)}</span>` : ""}</span>
              <span class="rp-sw"><input type="checkbox" role="switch" data-btnperm="${b.perm}" ${chk ? "checked" : ""}/><i></i></span>
            </label>`;
          }).join("")}
        </div>
      </div>`;
  }
  box.innerHTML = shown ? html : `<div class="rp-empty">Aucune permission trouvée</div>`;
}

// Synchronise switches + compteurs avec le cache, sans reconstruire la liste (garde le défilement et l'animation)
function _rpSyncAll() {
  const role = _RP.role;
  document.querySelectorAll("#rpGroups .rp-group").forEach(g => {
    const section = g.dataset.section, items = _rpGroupItems(section);
    if (!ROLE_PERMISSIONS[section]) return;
    g.querySelectorAll(".rp-row[data-section]").forEach(row => {
      const cb = row.querySelector("input[data-btnperm]"); if (!cb) return;
      cb.checked = _permEffective(row.dataset.section, role).includes(cb.dataset.btnperm);
    });
    const on = items.filter(b => _permEffective(b.section, role).includes(b.perm)).length;
    const cnt = g.querySelector(".rp-count");
    if (cnt) {
      cnt.textContent = `${on}/${items.length}`;
      cnt.classList.toggle("full", on === items.length);
      cnt.classList.toggle("zero", on === 0);
    }
  });
}

function _rpRenderShell() {
  const c = _rpEl("rolePermissionsSection"); if (!c) return;
  c.innerHTML = `
    <div class="rp" id="rpRoot">
      <div class="rp-tools">
        <div class="rp-seg" id="rpSeg" role="tablist" aria-label="Rôle"></div>
        <div class="rp-search">
          <span class="rp-search-ic">${icon("search", 16)}</span>
          <input id="rpSearch" type="search" placeholder="Rechercher une permission…" autocomplete="off" autocapitalize="off" spellcheck="false" value="${escHtml(_RP.q)}"/>
          <button type="button" class="rp-clear" data-act="clear" aria-label="Effacer la recherche"${_RP.q ? "" : " hidden"}>${icon("x", 14)}</button>
        </div>
      </div>
      <div class="rp-copyrow">
        <span class="rp-copy-ic">${icon("copy", 15)}</span>
        <select id="rpCopy" aria-label="Copier les permissions depuis un autre rôle"></select>
      </div>
      <div id="rpGroups"></div>
    </div>`;
  _rpRenderSeg(); _rpRenderCopy(); _rpRenderGroups();
}

function _rpSetRole(id) {
  if (!_rpRole(id) || id === _RP.role) return;
  _RP.role = id;
  try { localStorage.setItem(RP_ROLE_LS_KEY, id); } catch (_) {}
  _rpRenderSeg(); _rpRenderCopy(); _rpRenderGroups();
}

function _rpBind() {
  if (_RP.bound) return;
  const c = _rpEl("rolePermissionsSection"); if (!c) return;
  _RP.bound = true;

  c.addEventListener("click", (e) => {
    const seg = e.target.closest(".rp-seg-btn");
    if (seg) { _rpSetRole(seg.dataset.role); return; }
    const a = e.target.closest("[data-act]");
    if (!a) return;
    const group = a.closest(".rp-group");
    const section = group && group.dataset.section;
    switch (a.dataset.act) {
      case "toggle": {
        const open = !group.classList.contains("open");
        group.classList.toggle("open", open);
        a.setAttribute("aria-expanded", String(open));
        if (!_RP.q.trim()) _RP.open[section] = open;
        break;
      }
      case "all":
      case "none":
        _permBulk(section, _RP.role, a.dataset.act === "all");
        _rpSyncAll();
        break;
      case "clear": {
        _RP.q = "";
        const inp = _rpEl("rpSearch"); if (inp) { inp.value = ""; inp.focus(); }
        a.hidden = true;
        _rpRenderGroups();
        break;
      }
      case "reload": renderRolePermissionsUI(); break;
    }
  });

  c.addEventListener("input", (e) => {
    if (e.target.id !== "rpSearch") return;
    _RP.q = e.target.value;
    const clr = c.querySelector(".rp-clear"); if (clr) clr.hidden = !_RP.q;
    _rpRenderGroups();
  });

  c.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches("input[data-btnperm]")) {
      const row = t.closest(".rp-row");      // la ligne porte sa vraie section (gds_tabs pour la clé d'onglet)
      _permToggle(row.dataset.section, _RP.role, t.dataset.btnperm, t.checked);
      _rpSyncAll();               // compteur du groupe
    } else if (t.id === "rpCopy") {
      const src = t.value;
      t.value = "";
      _permCopyFrom(src);
    }
  });

  const st = _rpEl("permStatus");
  if (st) st.addEventListener("click", () => { if (st.dataset.state === "error") _permRetry(); });
}

// Point d'entrée : appelé à l'ouverture de la fenêtre et par le bouton Actualiser (seules lectures complètes)
async function renderRolePermissionsUI() {
  const container = _rpEl("rolePermissionsSection");
  if (!container || !isAdmin()) return;
  if (_RP.loading) return;
  _RP.loading = true;
  _rpBind();
  if (!_RP.loaded) {
    try { const saved = localStorage.getItem(RP_ROLE_LS_KEY); if (_rpRole(saved)) _RP.role = saved; } catch (_) {}
    container.innerHTML = `<div class="rp-msg">Chargement…</div>`;
  }
  try {
    await _permQueue;                                   // laisser finir les écritures en cours
    const data = await _permFetchAllChecked();
    if (_permPending === 0) {                           // sinon: modifications locales plus récentes que cette lecture
      _permCache = data;
      _permConfirmed = {};
      for (const [section, byRole] of Object.entries(data)) {
        if (!byRole || typeof byRole !== "object") continue;
        for (const [role, raw] of Object.entries(byRole)) _permConfirmed[_permPath(section, role)] = raw;
      }
      _permFailed.clear();
      _permSetStatus("saved");
    }
    if (!_RP.loaded) { _RP.loaded = true; _rpRenderShell(); }
    else { _rpRenderGroups(); }
  } catch (e) {
    console.warn("[perm] load failed:", e);
    if (!_RP.loaded) {
      container.innerHTML = `<div class="rp-msg rp-msg--err">${icon("alert", 16)}<span>Impossible de charger les permissions.</span>
        <button type="button" class="rp-mini" data-act="reload">Réessayer</button></div>`;
    } else {
      try { addNotif("Actualisation des permissions impossible : " + e.message, "error"); } catch (_) {}
    }
  } finally {
    _RP.loading = false;
  }
}

// ── Viewer restrictions (kept for backward compat) ────────────
function _applyViewerRestrictions() {}

// ── Block settings for non-admins ─────────────────────────────
function _guardSettings() {
  const btn = document.getElementById("btnSettings");
  if (!btn) return;
  // إظهار الـ containers الخاصة بالأدمن فقط
  if (isAdmin()) {
    document.getElementById("warehouseSettingsContainer")?.style.setProperty("display", "");
    document.getElementById("rolePermissionsContainer")?.style.setProperty("display", "");
    document.getElementById("userManagementContainer")?.style.setProperty("display", "");
    if (typeof NameDict !== "undefined") NameDict.initSettings();
  }
  if (!isAdmin()) {
    btn.style.display = "none";
    // منع الوصول لصفحة الإعدادات بأي طريقة
    btn.onclick = e => { e.stopImmediatePropagation(); e.preventDefault(); };

    // مراقبة إذا ظهرت صفحة الإعدادات وإغلاقها فوراً
    const observer = new MutationObserver(() => {
      const vs = document.getElementById("viewSettings");
      if (vs && vs.style.display !== "none" && vs.style.display !== "") {
        vs.style.display = "none";
        const vm = document.getElementById("viewMain");
        if (vm) vm.style.display = "";
      }
    });
    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ["style"] });

    // تعطيل كل العناصر التفاعلية داخل الإعدادات
    const vs = document.getElementById("viewSettings");
    if (vs) {
      vs.querySelectorAll("input, select, button, textarea").forEach(el => {
        if (el.id === "btnBack") return; // اسمح بالرجوع فقط
        el.disabled = true;
        el.style.pointerEvents = "none";
        el.style.opacity = "0.4";
      });
    }
  }
}

// ── Build App Login Screen HTML ───────────────────────────────
function _buildAppLoginScreen() {
  const div = document.createElement("div");
  div.id = "appLoginScreen";
  div.style.cssText = "display:flex;position:fixed;inset:0;z-index:10000;background:#0f1117;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px";
  div.innerHTML = `
    <img src="icons/icon512.png" style="width:72px;height:72px;border-radius:18px;margin-bottom:4px;"/>
    <div style="color:#e2e8f0;font-size:17px;font-weight:700">OwlGDS</div>
    <div style="color:#64748b;font-size:12px;margin-bottom:4px">Connexion à l'application</div>
    <form onsubmit="event.preventDefault(); document.getElementById('appLoginBtn').click();" style="display:contents">
    <input id="appLoginUser" type="text" placeholder="Identifiant" autocomplete="username"
      style="width:min(320px,90vw);padding:14px 16px;border-radius:10px;border:1px solid #2a2f45;background:#1e2336;color:#e2e8f0;font-size:16px;outline:none"/>
    <input id="appLoginPass" type="password" placeholder="Mot de passe" autocomplete="current-password"
      style="width:min(320px,90vw);padding:14px 16px;border-radius:10px;border:1px solid #2a2f45;background:#1e2336;color:#e2e8f0;font-size:16px;outline:none"/>
    <button id="appLoginBtn" type="submit"
      style="width:min(320px,90vw);padding:14px;border-radius:10px;background:#33c393;color:#fff;font-size:16px;font-weight:700;border:none;cursor:pointer">
      Se connecter
    </button>
    </form>
    <div id="appLoginErr" style="color:#f87171;font-size:12px;min-height:16px"></div>
    <div style="color:#334155;font-size:11px;margin-top:4px">Étape 1/2 — Accès application</div>
  `;
  document.body.appendChild(div);
  return div;
}

// ── Step 1: App Login ─────────────────────────────────────────
async function _doAppLogin() {
  await _ensureDefaultAdmin();

  // Check existing session
  if (await _restoreAppSession()) return;

  const screen = _buildAppLoginScreen();

  await new Promise(resolve => {
    async function tryLogin() {
      const username = document.getElementById("appLoginUser").value.trim();
      const password = document.getElementById("appLoginPass").value.trim();
      const errEl    = document.getElementById("appLoginErr");
      const btn      = document.getElementById("appLoginBtn");

      if (!username || !password) { errEl.textContent = "Remplissez tous les champs"; return; }
      errEl.textContent = "";
      btn.textContent = "Vérification…";
      btn.disabled = true;

      try {
        await appLogin(username, password);
        screen.remove();
        resolve();
      } catch (e) {
        errEl.textContent = e.message;
        btn.textContent = "Se connecter";
        btn.disabled = false;
      }
    }

    document.getElementById("appLoginBtn").addEventListener("click", tryLogin);
    ["appLoginUser", "appLoginPass"].forEach(id => {
      document.getElementById(id).addEventListener("keydown", e => {
        if (e.key === "Enter") tryLogin();
      });
    });
  });
}

// ── Add user badge to header ──────────────────────────────────
function _addUserBadge() {
  const headerRight = document.querySelector(".header-right");
  if (!headerRight || !AppAuth.currentUser) return;

  const roleColors = { admin: "#33c393", user: "#22c55e", group1: "#f59e0b", group2: "#a78bfa", group3: "#f87171" };
  const roleLabels = { admin: "Admin", user: "Utilisateur", group1: "Group 1", group2: "Group 2", group3: "Group 3" };

  const badge = document.createElement("div");
  badge.id = "userBadge";
  badge.style.cssText = "display:flex;align-items:center;gap:5px;cursor:pointer;padding:3px 7px;border-radius:6px;border:1px solid var(--border);background:var(--bg2)";
  badge.title = "Se déconnecter de l'application";
  badge.innerHTML = `
    <span style="font-size:10px;color:${roleColors[AppAuth.currentUser.role]};font-weight:600">
      ${AppAuth.currentUser.displayName || AppAuth.currentUser.username}
    </span>
  `;
  badge.addEventListener("click", () => {
    const existing = document.getElementById("badgeMenu");
    if (existing) { existing.remove(); return; }
    const menu = document.createElement("div");
    menu.id = "badgeMenu";
    menu.style.cssText = "position:absolute;top:36px;right:8px;z-index:15000;background:#1e2336;border:1px solid #2a2f45;border-radius:8px;overflow:hidden;min-width:160px;box-shadow:0 4px 16px #0006;";
    const allowed = AppAuth.allowedWarehouseIds || [];
    const whs = (AppAuth.warehouseDetails || []).filter(w => allowed.includes(w.id));
    const whSwitcher = whs.length > 1 ? `
      <div style="padding:7px 14px;border-bottom:1px solid #2a2f45;">
        <div style="font-size:9px;color:#64748b;font-weight:600;margin-bottom:4px;">ENTREPÔT</div>
        ${whs.map(w => {
          const active = (AppAuth.activeWarehouseId || whs[0].id) === w.id;
          return `<div class="bm-wh-item" data-whid="${w.id}"
            style="padding:4px 6px;font-size:11px;border-radius:5px;cursor:pointer;
                   color:${active ? "#33c393" : "#94a3b8"};
                   background:${active ? "#33c39322" : "transparent"};
                   font-weight:${active ? "700" : "400"}">
            ${active ? "● " : "○ "}${w.name}
          </div>`;
        }).join("")}
      </div>` : "";

    menu.innerHTML = `
      ${whSwitcher}
      <div id="bmChangePwd" style="padding:9px 14px;font-size:12px;color:#e2e8f0;cursor:pointer;display:flex;align-items:center;gap:8px;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        Changer le mot de passe
      </div>
      ${isAdmin() ? `<div id="bmSwitchEnv" style="padding:9px 14px;font-size:12px;color:#fbbf24;cursor:pointer;display:flex;align-items:center;gap:8px;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        Changer d'environnement (${App.env === "training" ? "Test → Officiel" : "Officiel → Test"})
      </div>` : ""}
      <div id="bmLogout" style="padding:9px 14px;font-size:12px;color:#f87171;cursor:pointer;border-top:1px solid #2a2f45;display:flex;align-items:center;gap:8px;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Se déconnecter
      </div>
    `;
    document.querySelector(".header-right").style.position = "relative";
    document.querySelector(".header-right").appendChild(menu);
    menu.querySelectorAll(".bm-wh-item").forEach(el => {
      el.onclick = () => {
        const whId = parseInt(el.dataset.whid);
        if (!(AppAuth.allowedWarehouseIds || []).includes(whId)) return;
        AppAuth.activeWarehouseId = whId;
        menu.remove();
        // إعادة تحميل البيانات بالـ warehouse الجديد
        if (typeof loadData === "function") loadData().then(() => {
          if (typeof setMode === "function") setMode(App.currentMode);
        });
      };
    });
    document.getElementById("bmChangePwd").onclick = () => { menu.remove(); _showChangePasswordModal(); };
    const swEnv = document.getElementById("bmSwitchEnv");
    if (swEnv) swEnv.onclick = async () => {
      if (!(await appConfirm("Fermer la session Odoo et choisir l'environnement (Officiel / Test) ?", { title: "Changer d'environnement" }))) return;
      await _odooDestroySession();   // les sessions Officiel et Test sont différentes
      location.reload();
    };
    document.getElementById("bmLogout").onclick = async () => {
      if (await appConfirm(`Se déconnecter (${AppAuth.currentUser.displayName || AppAuth.currentUser.username}) ?`, { title: "Déconnexion", okText: "Se déconnecter" })) { appLogout(); await _odooDestroySession(); location.reload(); }
    };
    setTimeout(() => document.addEventListener("click", function h(e) {
      if (!menu.contains(e.target) && e.target !== badge) { menu.remove(); }
      document.removeEventListener("click", h);
    }), 10);
  });

  headerRight.insertBefore(badge, headerRight.firstChild);
}

// ── User Management (Admin only) ──────────────────────────────
async function getAppUsers() {
  const users = await _fbGet("app_users");
  return users ? Object.values(users) : [];
}

async function addAppUser(username, password, role, displayName) {
  if (!isAdmin()) throw new Error("Accès refusé");
  if (!username || !password || !role) throw new Error("Champs manquants");
  if (!["admin", "user", "group1", "group2", "group3"].includes(role)) throw new Error("Rôle invalide");

  const existing = await _fbGet(`app_users/${username.toLowerCase()}`);
  if (existing) throw new Error("Cet identifiant existe déjà");

  const hash = await _hashPassword(password);
  await _fbSet(`app_users/${username.toLowerCase()}`, {
    username: username.toLowerCase(),
    displayName: displayName || username.toLowerCase(),
    password: hash,
    role,
    createdAt: Date.now(),
  });
}

async function changeAppUserDisplayName(username, newDisplayName) {
  if (!isAdmin()) throw new Error("Accès refusé");
  await _fbPatch(`app_users/${username.toLowerCase()}`, { displayName: newDisplayName || username.toLowerCase() });
}

async function deleteAppUser(username) {
  if (!isAdmin()) throw new Error("Accès refusé");
  if (username.toLowerCase() === AppAuth.currentUser.username) throw new Error("Impossible de supprimer votre propre compte");
  await _fbDelete(`app_users/${username.toLowerCase()}`);
}

// Désactiver / réactiver un compte (le compte et ses données sont conservés ; seule la connexion est bloquée)
async function setAppUserDisabled(username, disabled) {
  if (!isAdmin()) throw new Error("Accès refusé");
  username = username.toLowerCase();
  if (disabled && username === AppAuth.currentUser.username) throw new Error("Impossible de désactiver votre propre compte");
  const r = await fetch(`${_FB_DB_URL}/app_users/${username}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ disabled: disabled ? true : null }),   // null => la clé est supprimée de Firebase
  });
  if (!r.ok) throw new Error("Échec de l'enregistrement (HTTP " + r.status + ")");
}

async function changeAppUserRole(username, newRole) {
  if (!isAdmin()) throw new Error("Accès refusé");
  await _fbPatch(`app_users/${username.toLowerCase()}`, { role: newRole });
}

async function adminEditUser(oldUsername, newUsername, newPassword) {
  if (!isAdmin()) throw new Error("Accès refusé");
  oldUsername = oldUsername.toLowerCase();
  newUsername = newUsername.toLowerCase();

  const users = await _fbGet("app_users");
  const user  = users?.[oldUsername];
  if (!user) throw new Error("Utilisateur introuvable");

  const patch = {};

  // تغيير اسم المستخدم
  if (newUsername && newUsername !== oldUsername) {
    if (users[newUsername]) throw new Error("Cet identifiant existe déjà");
    // Firebase لا يدعم rename مباشرة → نحذف القديم وننشئ جديد
    const newData = { ...user, username: newUsername };
    if (newPassword) newData.password = await _hashPassword(newPassword);
    await _fbSet(`app_users/${newUsername}`, newData);
    await _fbDelete(`app_users/${oldUsername}`);
    return;
  }

  // تغيير كلمة السر فقط
  if (newPassword) {
    patch.password = await _hashPassword(newPassword);
    await _fbPatch(`app_users/${oldUsername}`, patch);
  }
}

async function _showAdminEditModal(username, role) {
  const existing = document.getElementById("adminEditModal");
  if (existing) existing.remove();

  const isSelf = username === AppAuth.currentUser.username;

  // جلب warehouses من Firebase (يحتوي على كل الـ warehouses المعروفة)
  let allWarehouses = [];
  try {
    const r = await fetch(`${_FB_DB_URL}/warehouse_details.json`);
    const saved = (await r.json()) || {};
    allWarehouses = Object.values(saved).map(w => ({ id: w.id, name: w.name }));
  } catch(_) {}

  // fallback: Odoo إذا Firebase فارغ
  if (!allWarehouses.length) {
    try {
      const r = await fetch("/api/web/dataset/call_kw", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:0, params:{
          model:"stock.warehouse", method:"search_read",
          args:[[]], kwargs:{ fields:["id","name"], limit:100 }
        }})
      });
      allWarehouses = (await r.json())?.result || [];
    } catch(_) {}
  }

  // جلب warehouses المعينة للمستخدم من Firebase
  const fbUser = await _fbGet(`app_users/${username}`);
  const userWarehouses = fbUser?.warehouses || [];

  const whCheckboxes = allWarehouses.map(w => `
    <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:#94a3b8;cursor:pointer;">
      <input type="checkbox" data-whid="${w.id}" ${userWarehouses.includes(w.id) ? "checked" : ""}
        style="width:13px;height:13px;accent-color:#33c393;cursor:pointer;"/>
      ${w.name}
    </label>
  `).join("");

  const modal = document.createElement("div");
  modal.id = "adminEditModal";
  modal.style.cssText = "position:fixed;inset:0;z-index:20000;background:#0008;display:flex;align-items:center;justify-content:center;";
  modal.innerHTML = `
    <div style="background:#1e2336;border:1px solid #2a2f45;border-radius:12px;padding:20px;width:270px;display:flex;flex-direction:column;gap:10px;">
      <div style="font-size:13px;font-weight:700;color:#e2e8f0">Modifier — ${username}</div>
      <div style="font-size:11px;color:#94a3b8">Laisser vide pour ne pas modifier</div>
      <div style="border:1px solid #2a2f45;border-radius:7px;padding:8px;display:flex;flex-direction:column;gap:5px;">
        <div style="font-size:10px;font-weight:600;color:#33c393;margin-bottom:2px;">Entrepôts autorisés</div>
        ${whCheckboxes || '<div style="font-size:11px;color:#f87171;">Aucun entrepôt trouvé</div>'}
      </div>
      <input id="aeNewName" type="text" placeholder="Nouvel identifiant" value="${username}"
        style="padding:9px 12px;border-radius:7px;border:1px solid #2a2f45;background:#0f1117;color:#e2e8f0;font-size:12px;outline:none"/>
      <input id="aeDisplayName" type="text" placeholder="Nom affiché" value="${fbUser?.displayName || username}"
        style="padding:9px 12px;border-radius:7px;border:1px solid #2a2f45;background:#0f1117;color:#e2e8f0;font-size:12px;outline:none"/>
      <input id="aeNewPass" type="password" placeholder="Nouveau mot de passe"
        style="padding:9px 12px;border-radius:7px;border:1px solid #2a2f45;background:#0f1117;color:#e2e8f0;font-size:12px;outline:none"/>
      <input id="aeNewPass2" type="password" placeholder="Confirmer le mot de passe"
        style="padding:9px 12px;border-radius:7px;border:1px solid #2a2f45;background:#0f1117;color:#e2e8f0;font-size:12px;outline:none"/>
      <div id="aeErr" style="color:#f87171;font-size:11px;min-height:14px;"></div>
      <div style="display:flex;gap:8px;">
        <button id="aeCancel" style="flex:1;padding:8px;border-radius:7px;background:#2a2f45;color:#94a3b8;font-size:12px;border:none;cursor:pointer;">Annuler</button>
        <button id="aeSave" style="flex:1;padding:8px;border-radius:7px;background:#33c393;color:#fff;font-size:12px;font-weight:700;border:none;cursor:pointer;">Enregistrer</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById("aeCancel").onclick = () => modal.remove();
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  document.getElementById("aeSave").onclick = async () => {
    const newName = document.getElementById("aeNewName").value.trim();
    const newDisplayName = document.getElementById("aeDisplayName").value.trim();
    const newPass = document.getElementById("aeNewPass").value.trim();
    const newPass2= document.getElementById("aeNewPass2").value.trim();
    const err     = document.getElementById("aeErr");
    const btn     = document.getElementById("aeSave");

    if (!newName) { err.textContent = "L'identifiant ne peut pas être vide"; return; }
    if (newPass && newPass !== newPass2) { err.textContent = "Les mots de passe ne correspondent pas"; return; }
    if (newPass && newPass.length < 4) { err.textContent = "Mot de passe trop court (min 4)"; return; }

    btn.textContent = "…"; btn.disabled = true;
    try {
      await adminEditUser(username, newName, newPass || null);
      // حفظ warehouses + displayName
      const selectedWh = [...modal.querySelectorAll("input[data-whid]:checked")]
        .map(cb => parseInt(cb.dataset.whid));
      await _fbPatch(`app_users/${newName || username}`, { warehouses: selectedWh, displayName: newDisplayName || newName || username });
      err.style.color = "#22c55e";
      uiStatus(err, "ok", "Modifié");
      setTimeout(() => { modal.remove(); renderUserManagementUI(); }, 900);
    } catch(e) {
      err.style.color = "#f87171";
      err.textContent = e.message;
      btn.textContent = "Enregistrer"; btn.disabled = false;
    }
  };
}

// ── Render User Management UI (in settings) ───────────────────
async function renderUserManagementUI() {
  const container = document.getElementById("userManagementSection");
  if (!container || !isAdmin()) return;

  container.innerHTML = `<div style="font-size:11px;color:var(--text2)">Chargement…</div>`;

  const users = await getAppUsers();
  const roleColors = { admin: "#33c393", user: "#22c55e", group1: "#f59e0b", group2: "#a78bfa", group3: "#f87171" };
  const roleLabels = { admin: "Admin", user: "Utilisateur", group1: "Group 1", group2: "Group 2", group3: "Group 3" };

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">
      ${users.map(u => `
        <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;">
          <span style="flex:1;font-size:12px;color:var(--text1);${u.disabled ? "opacity:.5;" : ""}">${u.username}${u.disabled ? ` <span style="font-size:10px;color:#f87171;background:#f8717122;padding:1px 6px;border-radius:4px;opacity:1">Désactivé</span>` : ""}</span>
          <select onchange="changeAppUserRole('${u.username}', this.value)"
            style="font-size:11px;background:var(--bg3,#252a3d);color:var(--text1);border:1px solid var(--border);border-radius:5px;padding:2px 5px;">
            ${["admin","user","group1","group2","group3"].map(r => `
              <option value="${r}" ${u.role===r?"selected":""}>${roleLabels[r]}</option>
            `).join("")}
          </select>
          <span style="font-size:10px;color:${roleColors[u.role]};background:${roleColors[u.role]}22;padding:1px 6px;border-radius:4px;min-width:55px;text-align:center">
            ${roleLabels[u.role]}
          </span>
          <button onclick="_showAdminEditModal('${u.username}', '${u.role}')"
            style="background:none;border:none;cursor:pointer;color:#33c393;padding:2px 4px;border-radius:4px"
            title="Modifier">
            ${icon("edit", 14)}
          </button>
          ${u.username !== AppAuth.currentUser.username ? `
            <button onclick="_toggleUserDisabledUI('${u.username}', ${!u.disabled})"
              style="background:none;border:none;cursor:pointer;color:${u.disabled ? "#22c55e" : "#f59e0b"};padding:2px 4px;border-radius:4px"
              title="${u.disabled ? "Réactiver" : "Désactiver"}">
              ${icon(u.disabled ? "check" : "lock", 14)}
            </button>
            <button onclick="_deleteUserUI('${u.username}')"
              style="background:none;border:none;cursor:pointer;color:#f87171;padding:2px 4px;border-radius:4px"
              title="Supprimer">
              ${icon("trash", 14)}
            </button>
          ` : ""}
        </div>
      `).join("")}
    </div>

    <!-- Add user form -->
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:7px;">
      <div style="font-size:11px;font-weight:600;color:var(--text2)">Ajouter un utilisateur</div>
      <input id="newUserName" type="text" placeholder="Identifiant"
        style="padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg3,#252a3d);color:var(--text1);font-size:12px;outline:none"/>
      <input id="newUserDisplayName" type="text" placeholder="Nom affiché"
        style="padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg3,#252a3d);color:var(--text1);font-size:12px;outline:none"/>
      <input id="newUserPass" type="password" placeholder="Mot de passe"
        style="padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg3,#252a3d);color:var(--text1);font-size:12px;outline:none"/>
      <select id="newUserRole"
        style="padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg3,#252a3d);color:var(--text1);font-size:12px;outline:none">
        <option value="user">Utilisateur</option>
        <option value="group1">Group 1</option>
        <option value="group2">Group 2</option>
        <option value="group3">Group 3</option>
        <option value="admin">Admin</option>
      </select>
      <div id="addUserErr" style="color:#f87171;font-size:11px;min-height:14px;"></div>
      <button onclick="_addUserUI()"
        style="padding:8px;border-radius:6px;background:#33c393;color:#fff;font-size:12px;font-weight:700;border:none;cursor:pointer">
        Ajouter
      </button>
    </div>
  `;
}

async function _addUserUI() {
  const username    = document.getElementById("newUserName")?.value.trim();
  const displayName = document.getElementById("newUserDisplayName")?.value.trim();
  const password    = document.getElementById("newUserPass")?.value.trim();
  const role        = document.getElementById("newUserRole")?.value;
  const errEl       = document.getElementById("addUserErr");
  try {
    await addAppUser(username, password, role, displayName);
    errEl.style.color = "#22c55e";
    uiStatus(errEl, "ok", "Utilisateur ajouté");
    setTimeout(() => renderUserManagementUI(), 1000);
  } catch (e) {
    errEl.style.color = "#f87171";
    errEl.textContent = e.message;
  }
}

async function _toggleUserDisabledUI(username, disable) {
  if (disable && !(await appConfirm(`Désactiver l'utilisateur "${username}" ? Il ne pourra plus se connecter tant que le compte n'est pas réactivé.`, { title: "Désactiver l'utilisateur", okText: "Désactiver", danger: true }))) return;
  try {
    await setAppUserDisabled(username, disable);
    renderUserManagementUI();
  } catch (e) {
    await appAlert(e.message, { title: "Erreur" });
  }
}

async function _deleteUserUI(username) {
  if (!(await appConfirm(`Supprimer l'utilisateur "${username}" ?`, { title: "Supprimer l'utilisateur", okText: "Supprimer", danger: true }))) return;
  try {
    await deleteAppUser(username);
    renderUserManagementUI();
  } catch (e) {
    await appAlert(e.message, { title: "Erreur" });
  }
}

// ── MAIN: Two-step auth flow ──────────────────────────────────
// Call this instead of _checkAndLogin() in app.js DOMContentLoaded
async function checkAndLoginTwoStep() {
  // Step 1: App login
  await _doAppLogin();

  // Step 2: Odoo session (existing logic)
  await _checkOdooSession();

  // Step 2b: environnement (Officiel / Training) — fixe ODOO_BASE et la pastille TEST
  await _applyEnv();

  // Step 3: Load warehouse details from Odoo
  await _loadUserWarehouses();

  // Post-login setup
  _addUserBadge();
  _guardSettings();
  // Apply role-based permissions for all non-admin roles
  await applyRolePermissions();
}

// ── Load warehouse details from Odoo ──────────────────────────
async function _loadUserWarehouses() {
  try {
    const ids = AppAuth.currentUser?.warehouses || [];
    // الأدمن → كل الـ warehouses، غيره → فقط المعينة له
    const domain = isAdmin() ? [] : [["id", "in", ids]];
    if (!isAdmin() && !ids.length) {
      AppAuth.warehouseDetails = [];
      return;
    }

    const r = await fetch("/api/web/dataset/call_kw", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "call", id: 0,
        params: {
          model: "stock.warehouse", method: "search_read",
          args: [domain],
          kwargs: { fields: ["id", "name", "lot_stock_id", "view_location_id"], limit: 100 }
        }
      })
    });
    const j = await r.json();
    const fetched = j?.result || [];

    // فلترة حسب الـ ids المعينة للمستخدم (غير الأدمن)
    if (!isAdmin() && ids.length) {
      AppAuth.warehouseDetails = fetched.filter(w => ids.includes(w.id));
      // قائمة مقفلة نهائية للصلاحيات — لا يمكن تجاوزها
            AppAuth.allowedWarehouseIds = ids;
    } else {
      AppAuth.warehouseDetails = fetched;
      // دمج مع Firebase للأدمن
      try {
        const rFb = await fetch(`${_FB_DB_URL}/warehouse_details.json`);
        const saved = (await rFb.json()) || {};
        const currentIds = fetched.map(w => w.id);
        Object.values(saved).forEach(w => {
          if (w?.id && !currentIds.includes(w.id)) {
            AppAuth.warehouseDetails.push(w);
          }
        });
      } catch(_) {}
      AppAuth.allowedWarehouseIds = AppAuth.warehouseDetails.map(w => w.id);
    }

    // إذا الفلترة أفرغت القائمة → جلب من Firebase كـ fallback (فقط الـ ids المسموح بها)
    if (!AppAuth.warehouseDetails.length && ids.length) {
      try {
        const rFb = await fetch(`${_FB_DB_URL}/warehouse_details.json`);
        const saved = (await rFb.json()) || {};
        AppAuth.warehouseDetails = ids
          .map(id => saved[id])
          .filter(Boolean);
        // تحديث allowedWarehouseIds بناءً على ما وُجد فعلاً
        AppAuth.allowedWarehouseIds = AppAuth.warehouseDetails.map(w => w.id);
      } catch(_) {}
    } else if (AppAuth.warehouseDetails.length) {
      // دمج مع Firebase للحصول على بيانات كاملة للـ ids غير الموجودة في Odoo
      try {
        const rFb = await fetch(`${_FB_DB_URL}/warehouse_details.json`);
        const saved = (await rFb.json()) || {};
        const currentIds = AppAuth.warehouseDetails.map(w => w.id);
        ids.forEach(id => {
          if (!currentIds.includes(id) && saved[id]) {
            AppAuth.warehouseDetails.push(saved[id]);
          }
        });
      } catch(_) {}
    }

    // حفظ warehouse details سحابياً للرجوع إليها لاحقاً
    if (AppAuth.warehouseDetails.length) {
      // جلب ما هو محفوظ أولاً ثم دمج بدل استبدال
      try {
        const rExisting = await fetch(`${_FB_DB_URL}/warehouse_details.json`);
        const existing = (await rExisting.json()) || {};
        const merged = { ...existing };
        AppAuth.warehouseDetails.forEach(w => { merged[w.id] = w; });
        await fetch(`${_FB_DB_URL}/warehouse_details.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(merged),
        });
      } catch(e) {
        console.warn("warehouse_details save failed:", e);
      }
    }

    // جلب كل إعدادات warehouses من Firebase (بغض النظر عن الصلاحيات)
    try {
      const r2 = await fetch(`${_FB_DB_URL}/warehouse_settings.json`);
      AppAuth.warehouseSettings = (await r2.json()) || {};
    } catch(_) { AppAuth.warehouseSettings = {}; }

    // دمج warehouses من Firebase مع تلك التي عند المستخدم
    // لضمان أن الإعدادات المحفوظة تبقى حتى بعد تغيير الصلاحيات
    try {
      const r3 = await fetch(`${_FB_DB_URL}/warehouse_details.json`);
      const savedDetails = await r3.json();
      if (savedDetails && typeof savedDetails === "object") {
        // نضيف أي warehouse محفوظ غير موجود في القائمة الحالية
        const currentIds = (AppAuth.warehouseDetails || []).map(w => w.id);
        Object.values(savedDetails).forEach(w => {
          if (w?.id && !currentIds.includes(w.id)) {
            AppAuth.warehouseDetails.push(w);
          }
        });
      }
    } catch(_) {}

  } catch(e) {
    console.warn("_loadUserWarehouses failed:", e);
    AppAuth.warehouseDetails = [];
    AppAuth.warehouseSettings = {};
  }
}

// ── Odoo session check (extracted from old _checkAndLogin) ────
async function _checkOdooSession() {
  try {
    const r = await fetch("/api/web/dataset/call_kw", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "call", id: 0,
        params: { model: "res.users", method: "read", args: [[1], ["name"]], kwargs: {} }
      })
    });
    const j = await r.json();
    if (j?.result) return; // session valid ✓
  } catch (_) {}

  // Show Odoo login (existing screen in HTML)
  const screen = document.getElementById("loginScreen");
  if (screen) screen.style.display = "flex";

  // Sélecteur Officiel/Test : admin seulement. Choix NON persisté (défaut : Officiel).
  let selectedEnv = "prod";
  const envToggle = document.getElementById("loginEnvToggle");
  const envForLogin = () => (isAdmin() && selectedEnv === "training" ? "training" : "prod");
  if (envToggle) {
    envToggle.style.display = isAdmin() ? "flex" : "none";
    const paint = () => document.querySelectorAll(".loginEnvBtn").forEach(b => {
      const on = b.dataset.env === selectedEnv, test = b.dataset.env === "training";
      b.style.background  = on ? (test ? "#f59e0b" : "#714B67") : "#f9fafb";
      b.style.borderColor = on ? (test ? "#f59e0b" : "#714B67") : "#d1d5db";
      b.style.color       = on ? "#fff" : "#64748b";
    });
    if (isAdmin()) {
      document.querySelectorAll(".loginEnvBtn").forEach(b => { b.onclick = () => { selectedEnv = b.dataset.env; paint(); }; });
      paint();
    }
  }

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

      const envHdr = envForLogin();
      fetch("/api/web/database/list", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", "X-Odoo-Env": envHdr },
        body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 1, params: {} })
      })
      .then(r => r.json())
      .then(d => {
        const db = (d?.result || [])[0];
        if (!db) throw new Error("Base de données introuvable");
        return fetch("/api/web/session/authenticate", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json", "X-Odoo-Env": envHdr },
          body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 2, params: { db, login, password } })
        });
      })
      .then(r => r.json())
      .then(d => {
        if (d?.result?.uid) {
          // Add "Étape 2" label to existing Odoo login screen
          screen.style.display = "none";
          resolve();
        } else {
          throw new Error("Identifiants Odoo incorrects");
        }
      })
      .catch(e => {
        document.getElementById("loginErr").textContent = e.message;
        btn.textContent = "Se connecter";
        btn.disabled = false;
      });
    }

    document.getElementById("loginBtn").addEventListener("click", doLogin);
    ["loginUser", "loginPass"].forEach(id => {
      document.getElementById(id).addEventListener("keydown", e => {
        if (e.key === "Enter") doLogin();
      });
    });
  });
}

// ── Environnement Officiel / Training ─────────────────────────
// Le serveur choisit l'hôte Odoo via un cookie HttpOnly (gds_env) ; ici on ne fait que le lire.
async function _odooDestroySession() {
  try {
    await fetch("/api/web/session/destroy", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 9, params: {} })
    });
  } catch (_) {}
}

async function _applyEnv(depth = 0) {
  let info = { env: "prod", host: null };
  try {
    const r = await fetch("/api/env", { credentials: "include", cache: "no-store" });
    if (r.ok) { const j = await r.json(); if (j && (j.env === "prod" || j.env === "training")) info = j; }
  } catch (_) {}

  // Utilisateur non-admin : toujours Officiel. Si une session Training traîne (même navigateur), on la ferme.
  if (info.env === "training" && !isAdmin() && depth < 2) {
    await _odooDestroySession();
    await _checkOdooSession();   // réaffiche le login (Officiel, sans sélecteur)
    return _applyEnv(depth + 1);
  }

  App.env = (info.env === "training" && isAdmin()) ? "training" : "prod";
  if (info.host) ODOO_BASE = "https://" + info.host;
  const badge = document.getElementById("envBadge");
  if (badge) badge.style.display = App.env === "training" ? "" : "none";
}

async function changeOwnPassword(oldPassword, newPassword) {
  const username = AppAuth.currentUser.username;
  const users = await _fbGet("app_users");
  const user = users?.[username];
  if (!user) throw new Error("Utilisateur introuvable");

  const oldHash = await _hashPassword(oldPassword);
  if (oldHash !== user.password) throw new Error("Mot de passe actuel incorrect");

  if (newPassword.length < 4) throw new Error("Mot de passe trop court (min 4 caractères)");

  const newHash = await _hashPassword(newPassword);
  await _fbPatch(`app_users/${username}`, { password: newHash });
}

function _showChangePasswordModal() {
  const existing = document.getElementById("changePwdModal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "changePwdModal";
  modal.style.cssText = "position:fixed;inset:0;z-index:20000;background:#0008;display:flex;align-items:center;justify-content:center;";
  modal.innerHTML = `
    <div style="background:#1e2336;border:1px solid #2a2f45;border-radius:12px;padding:20px;width:260px;display:flex;flex-direction:column;gap:10px;">
      <div style="font-size:13px;font-weight:700;color:#e2e8f0">Changer le mot de passe</div>
      <input id="cpOld" type="password" placeholder="Mot de passe actuel"
        style="padding:9px 12px;border-radius:7px;border:1px solid #2a2f45;background:#0f1117;color:#e2e8f0;font-size:12px;outline:none"/>
      <input id="cpNew" type="password" placeholder="Nouveau mot de passe"
        style="padding:9px 12px;border-radius:7px;border:1px solid #2a2f45;background:#0f1117;color:#e2e8f0;font-size:12px;outline:none"/>
      <input id="cpNew2" type="password" placeholder="Confirmer le nouveau"
        style="padding:9px 12px;border-radius:7px;border:1px solid #2a2f45;background:#0f1117;color:#e2e8f0;font-size:12px;outline:none"/>
      <div id="cpErr" style="color:#f87171;font-size:11px;min-height:14px;"></div>
      <div style="display:flex;gap:8px;">
        <button id="cpCancel" style="flex:1;padding:8px;border-radius:7px;background:#2a2f45;color:#94a3b8;font-size:12px;border:none;cursor:pointer;">Annuler</button>
        <button id="cpSave" style="flex:1;padding:8px;border-radius:7px;background:#33c393;color:#fff;font-size:12px;font-weight:700;border:none;cursor:pointer;">Enregistrer</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById("cpCancel").onclick = () => modal.remove();
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  document.getElementById("cpSave").onclick = async () => {
    const old = document.getElementById("cpOld").value.trim();
    const n1  = document.getElementById("cpNew").value.trim();
    const n2  = document.getElementById("cpNew2").value.trim();
    const err = document.getElementById("cpErr");
    const btn = document.getElementById("cpSave");

    if (!old || !n1 || !n2) { err.textContent = "Remplissez tous les champs"; return; }
    if (n1 !== n2) { err.textContent = "Les mots de passe ne correspondent pas"; return; }

    btn.textContent = "…";
    btn.disabled = true;
    try {
      await changeOwnPassword(old, n1);
      err.style.color = "#22c55e";
      err.textContent = "Mot de passe changé ✓";
      setTimeout(() => modal.remove(), 1200);
    } catch(e) {
      err.style.color = "#f87171";
      err.textContent = e.message;
      btn.textContent = "Enregistrer";
      btn.disabled = false;
    }
  };
}