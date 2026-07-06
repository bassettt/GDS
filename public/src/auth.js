// ============================================================
// src/auth.js — OwDoo App Authentication Layer
// Layer 1: App login (Firebase) → Layer 2: Odoo session
// Roles: admin | user | group1 | group2 | group3
// ============================================================

const _FB_DB_URL = "https://owdoo-f265f-default-rtdb.europe-west1.firebasedatabase.app";

// ── Current session ───────────────────────────────────────────
const AppAuth = {
  currentUser: null, // { username, role }
};

// ── Hash password (SHA-256) ───────────────────────────────────
async function _hashPassword(password) {
  const enc = new TextEncoder().encode(password);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
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

  AppAuth.currentUser = { username: user.username, displayName: user.displayName || user.username, role: user.role, passwordHash: hash, warehouses: user.warehouses || [] };
  localStorage.setItem("owdoo_app_user", JSON.stringify(AppAuth.currentUser));
  return AppAuth.currentUser;
}

// ── App Logout ────────────────────────────────────────────────
function appLogout() {
  AppAuth.currentUser = null;
  localStorage.removeItem("owdoo_app_user");
}

// ── Restore session ───────────────────────────────────────────
async function _restoreAppSession() {
  try {
    const saved = localStorage.getItem("owdoo_app_user");
    if (saved) {
      const parsed = JSON.parse(saved);
      // تحقق من الـ hash مقابل Firebase فقط للتأكد من أن الحساب لم يُحذف أو يُغيَّر
      const fbUser = await _fbGet(`app_users/${parsed.username}`);
      if (!fbUser || fbUser.password !== parsed.passwordHash) {
        // كلمة المرور تغيرت أو الحساب حُذف — تسجيل خروج
        localStorage.removeItem("owdoo_app_user");
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
  ],
  gds_preparation: [
    { perm: "prep_nouvelle",          label: "Préparation — Nouvelle" },
    { perm: "prep_modifier",          label: "Préparation — Modifier" },
    { perm: "prep_terminer",          label: "Préparation — Terminer" },
    { perm: "prep_annuler",           label: "Préparation — Annuler" },
    { perm: "prep_rapport",           label: "Préparation — Rapport" },
    { perm: "prep_reprendre",         label: "Préparation — Reprendre" },
    { perm: "prep_charge_actualiser", label: "Préparation — Actualiser chargement" },
    { perm: "prep_depuis_a",          label: "Préparation — Depuis / À (dates)" },
    { perm: "prep_bon_print",         label: "Préparation — Imprimer bon" },
    { perm: "prep_bon_toggle",        label: "Préparation — Activer/Désactiver bon" },
    { perm: "prep_hors_date",         label: "Préparation — Hors date" },
    { perm: "prep_hors_date_add",     label: "Préparation — Hors date (+)" },
    { perm: "prep_quick_add",         label: "Préparation — Ajout rapide (+)" },
    { perm: "prep_overstock",         label: "Préparation — Autoriser dépasser le stock" },
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

// ── Admin UI: render permissions panel in settings ────────────
async function renderRolePermissionsUI() {
  const container = document.getElementById("rolePermissionsSection");
  if (!container || !isAdmin()) return;
  container.innerHTML = `<div style="font-size:11px;color:var(--text2)">Chargement…</div>`;

  const perms      = await _loadRolePermissions();
  const roles      = ["user", "group1", "group2", "group3"];
  const roleLabels = { user: "Utilisateur", group1: "Group 1", group2: "Group 2", group3: "Group 3" };
  const roleColors = { user: "#22c55e", group1: "#f59e0b", group2: "#a78bfa", group3: "#f87171" };

  let html = "";
  for (const [section, buttons] of Object.entries(ROLE_PERMISSIONS)) {
    html += `
      <div style="margin-bottom:10px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px;">
        <div style="font-size:12px;font-weight:700;color:var(--text1);margin-bottom:8px">${ROLE_SECTION_LABELS[section]}</div>
        <div style="display:flex;flex-wrap:wrap;gap:12px;">
        ${roles.map(role => `
          <div style="flex:1;min-width:140px;margin-bottom:8px;">
            <div style="font-size:10px;font-weight:600;color:${roleColors[role]};margin-bottom:4px">${roleLabels[role]}</div>
            <div style="display:flex;flex-direction:column;gap:4px;">
              ${buttons.map(btn => {
                const raw     = perms[section]?.[role];
                const decoded = _decodePerm(raw);
                // undefined = not configured → checked. [] = all hidden → unchecked
                const checked = (decoded === undefined) || decoded.includes(btn.perm);
                return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:11px;color:var(--text2)">
                  <input type="checkbox"
                    data-section="${section}" data-role="${role}" data-btnperm="${btn.perm}"
                    ${checked ? "checked" : ""}
                    onchange="_onPermChange(this)"
                    style="width:14px;height:14px;cursor:pointer;accent-color:${roleColors[role]}"/>
                  ${btn.label}
                </label>`;
              }).join("")}
            </div>
          </div>`).join("")}
        </div>
      </div>`;
  }
  container.innerHTML = html;
}

let _permSaving = false;
let _permDirty = [];

async function _onPermChange(cb) {
  const section = cb.dataset.section;
  const role    = cb.dataset.role;
  const perm    = cb.dataset.btnperm;
  const perms   = await _loadRolePermissions();

  if (!perms[section]) perms[section] = {};

  // Decode current value (handle sentinel)
  const current = _decodePerm(perms[section][role]);
  // If undefined (never set), initialize with all allowed
  let arr = (current === undefined)
    ? ROLE_PERMISSIONS[section].map(b => b.perm)
    : [...current];

  if (cb.checked) {
    if (!arr.includes(perm)) arr.push(perm);
  } else {
    arr = arr.filter(p => p !== perm);
  }

  // Store array (sentinel applied inside _saveRolePermissions)
  perms[section][role] = arr;
  _permCache = perms;
  await _saveRolePermissions(perms);
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
    <div style="color:#e2e8f0;font-size:17px;font-weight:700">OwDoo</div>
    <div style="color:#64748b;font-size:12px;margin-bottom:4px">Connexion à l'application</div>
    <form onsubmit="event.preventDefault(); document.getElementById('appLoginBtn').click();" style="display:contents">
    <input id="appLoginUser" type="text" placeholder="Identifiant" autocomplete="username"
      style="width:min(320px,90vw);padding:14px 16px;border-radius:10px;border:1px solid #2a2f45;background:#1e2336;color:#e2e8f0;font-size:16px;outline:none"/>
    <input id="appLoginPass" type="password" placeholder="Mot de passe" autocomplete="current-password"
      style="width:min(320px,90vw);padding:14px 16px;border-radius:10px;border:1px solid #2a2f45;background:#1e2336;color:#e2e8f0;font-size:16px;outline:none"/>
    <button id="appLoginBtn" type="submit"
      style="width:min(320px,90vw);padding:14px;border-radius:10px;background:#4f8ef7;color:#fff;font-size:16px;font-weight:700;border:none;cursor:pointer">
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

  const roleColors = { admin: "#4f8ef7", user: "#22c55e", group1: "#f59e0b", group2: "#a78bfa", group3: "#f87171" };
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
                   color:${active ? "#4f8ef7" : "#94a3b8"};
                   background:${active ? "#4f8ef722" : "transparent"};
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
    document.getElementById("bmLogout").onclick = () => {
      if (confirm(`Se déconnecter (${AppAuth.currentUser.username}) ?`)) { appLogout(); location.reload(); }
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
        style="width:13px;height:13px;accent-color:#4f8ef7;cursor:pointer;"/>
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
        <div style="font-size:10px;font-weight:600;color:#4f8ef7;margin-bottom:2px;">Entrepôts autorisés</div>
        ${whCheckboxes || '<div style="font-size:11px;color:#f87171;">Aucun entrepôt trouvé</div>'}
      </div>
      <input id="aeNewName" type="text" placeholder="Nouvel identifiant" value="${username}"
        style="padding:9px 12px;border-radius:7px;border:1px solid #2a2f45;background:#0f1117;color:#e2e8f0;font-size:12px;outline:none"/>
      <input id="aeNewPass" type="password" placeholder="Nouveau mot de passe"
        style="padding:9px 12px;border-radius:7px;border:1px solid #2a2f45;background:#0f1117;color:#e2e8f0;font-size:12px;outline:none"/>
      <input id="aeNewPass2" type="password" placeholder="Confirmer le mot de passe"
        style="padding:9px 12px;border-radius:7px;border:1px solid #2a2f45;background:#0f1117;color:#e2e8f0;font-size:12px;outline:none"/>
      <div id="aeErr" style="color:#f87171;font-size:11px;min-height:14px;"></div>
      <div style="display:flex;gap:8px;">
        <button id="aeCancel" style="flex:1;padding:8px;border-radius:7px;background:#2a2f45;color:#94a3b8;font-size:12px;border:none;cursor:pointer;">Annuler</button>
        <button id="aeSave" style="flex:1;padding:8px;border-radius:7px;background:#4f8ef7;color:#fff;font-size:12px;font-weight:700;border:none;cursor:pointer;">Enregistrer</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById("aeCancel").onclick = () => modal.remove();
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  document.getElementById("aeSave").onclick = async () => {
    const newName = document.getElementById("aeNewName").value.trim();
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
      // حفظ warehouses
      const selectedWh = [...modal.querySelectorAll("input[data-whid]:checked")]
        .map(cb => parseInt(cb.dataset.whid));
      await _fbPatch(`app_users/${newName || username}`, { warehouses: selectedWh });
      err.style.color = "#22c55e";
      err.textContent = "Modifié ✓";
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
  const roleColors = { admin: "#4f8ef7", user: "#22c55e", group1: "#f59e0b", group2: "#a78bfa", group3: "#f87171" };
  const roleLabels = { admin: "Admin", user: "Utilisateur", group1: "Group 1", group2: "Group 2", group3: "Group 3" };

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">
      ${users.map(u => `
        <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;">
          <span style="flex:1;font-size:12px;color:var(--text1)">${u.username}</span>
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
            style="background:none;border:none;cursor:pointer;color:#4f8ef7;padding:2px 4px;border-radius:4px"
            title="Modifier">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          ${u.username !== AppAuth.currentUser.username ? `
            <button onclick="_deleteUserUI('${u.username}')"
              style="background:none;border:none;cursor:pointer;color:#f87171;padding:2px 4px;border-radius:4px"
              title="Supprimer">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
              </svg>
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
        style="padding:8px;border-radius:6px;background:#4f8ef7;color:#fff;font-size:12px;font-weight:700;border:none;cursor:pointer">
        Ajouter
      </button>
    </div>
  `;
}

async function _addUserUI() {
  const username = document.getElementById("newUserName")?.value.trim();
  const password = document.getElementById("newUserPass")?.value.trim();
  const role     = document.getElementById("newUserRole")?.value;
  const errEl    = document.getElementById("addUserErr");
  try {
    await addAppUser(username, password, role);
    errEl.style.color = "#22c55e";
    errEl.textContent = "Utilisateur ajouté ✓";
    setTimeout(() => renderUserManagementUI(), 1000);
  } catch (e) {
    errEl.style.color = "#f87171";
    errEl.textContent = e.message;
  }
}

async function _deleteUserUI(username) {
  if (!confirm(`Supprimer l'utilisateur "${username}" ?`)) return;
  try {
    await deleteAppUser(username);
    renderUserManagementUI();
  } catch (e) {
    alert(e.message);
  }
}

// ── MAIN: Two-step auth flow ──────────────────────────────────
// Call this instead of _checkAndLogin() in app.js DOMContentLoaded
async function checkAndLoginTwoStep() {
  // Step 1: App login
  await _doAppLogin();

  // Step 2: Odoo session (existing logic)
  await _checkOdooSession();

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

      fetch("/api/web/database/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 1, params: {} })
      })
      .then(r => r.json())
      .then(d => {
        const db = (d?.result || [])[0];
        if (!db) throw new Error("Base de données introuvable");
        return fetch("/api/web/session/authenticate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
        <button id="cpSave" style="flex:1;padding:8px;border-radius:7px;background:#4f8ef7;color:#fff;font-size:12px;font-weight:700;border:none;cursor:pointer;">Enregistrer</button>
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