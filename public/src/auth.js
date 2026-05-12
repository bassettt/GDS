// ============================================================
// src/auth.js — OwDoo App Authentication Layer
// Layer 1: App login (Firebase) → Layer 2: Odoo session
// Roles: admin | user | viewer
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

  AppAuth.currentUser = { username: user.username, role: user.role };
  sessionStorage.setItem("owdoo_app_user", JSON.stringify(AppAuth.currentUser));
  return AppAuth.currentUser;
}

// ── App Logout ────────────────────────────────────────────────
function appLogout() {
  AppAuth.currentUser = null;
  sessionStorage.removeItem("owdoo_app_user");
}

// ── Restore session ───────────────────────────────────────────
function _restoreAppSession() {
  try {
    const saved = sessionStorage.getItem("owdoo_app_user");
    if (saved) {
      AppAuth.currentUser = JSON.parse(saved);
      return true;
    }
  } catch (_) {}
  return false;
}

// ── Role checks ───────────────────────────────────────────────
function isAdmin()   { return AppAuth.currentUser?.role === "admin"; }
function isViewer()  { return AppAuth.currentUser?.role === "viewer"; }
function canEdit()   { return ["admin", "user"].includes(AppAuth.currentUser?.role); }

// ── Role-based permissions ────────────────────────────────────
// Default permissions per role (can be overridden via Firebase)
const DEFAULT_ROLE_PERMISSIONS = {
  admin: {}, // admin sees everything always
  user: {
    "stock-refresh": true,
    "stock-expand": true,
    "stock-collapse": true,
    "vans-refresh": true,
    "vans-expand": true,
    "vans-collapse": true,
    "vans-print": true,
    "transferts-refresh": true,
    "transferts-detail": true,
    "transferts-odoo-link": true,
    "preparation-refresh": true,
    "preparation-validate": true,
    "preparation-print": true,
  },
  viewer: {
    "stock-refresh": true,
    "stock-expand": true,
    "stock-collapse": true,
    "vans-refresh": false,
    "vans-expand": true,
    "vans-collapse": true,
    "vans-print": false,
    "transferts-refresh": true,
    "transferts-detail": true,
    "transferts-odoo-link": false,
    "preparation-refresh": true,
    "preparation-validate": false,
    "preparation-print": false,
  }
};

// Human-readable labels for permission keys
const PERMISSION_LABELS = {
  "stock-refresh":          { section: "Stock GDS",   label: "Actualiser" },
  "stock-expand":           { section: "Stock GDS",   label: "Tout développer" },
  "stock-collapse":         { section: "Stock GDS",   label: "Tout réduire" },
  "vans-refresh":           { section: "Vans",        label: "Actualiser" },
  "vans-expand":            { section: "Vans",        label: "Tout développer" },
  "vans-collapse":          { section: "Vans",        label: "Tout réduire" },
  "vans-print":             { section: "Vans",        label: "Imprimer PDF" },
  "transferts-refresh":     { section: "Transferts",  label: "Actualiser" },
  "transferts-detail":      { section: "Transferts",  label: "Voir détails" },
  "transferts-odoo-link":   { section: "Transferts",  label: "Ouvrir dans Odoo" },
  "preparation-refresh":    { section: "Préparation", label: "Actualiser" },
  "preparation-validate":   { section: "Préparation", label: "Valider" },
  "preparation-print":      { section: "Préparation", label: "Imprimer PDF" },
};

// Cache loaded permissions
let _loadedPermissions = null;

async function _loadRolePermissions() {
  try {
    const r = await fetch(`${_FB_DB_URL}/role_permissions.json`);
    const data = await r.json();
    if (data) { _loadedPermissions = data; return data; }
  } catch(_) {}
  _loadedPermissions = JSON.parse(JSON.stringify(DEFAULT_ROLE_PERMISSIONS));
  return _loadedPermissions;
}

async function _saveRolePermissions(perms) {
  _loadedPermissions = perms;
  await fetch(`${_FB_DB_URL}/role_permissions.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(perms),
  });
}

function _getPermForRole(role, key) {
  if (role === "admin") return true;
  const perms = _loadedPermissions || DEFAULT_ROLE_PERMISSIONS;
  const rolePerms = perms[role] || {};
  return rolePerms[key] !== undefined ? rolePerms[key] : (DEFAULT_ROLE_PERMISSIONS[role]?.[key] ?? true);
}

// Called with data-perm attribute on buttons to check if allowed
function hasPermission(key) {
  const role = AppAuth.currentUser?.role;
  if (!role) return false;
  return _getPermForRole(role, key);
}

// ── Apply role-based button restrictions ──────────────────────
function _applyRoleRestrictions() {
  const role = AppAuth.currentUser?.role;
  if (!role || role === "admin") return;

  // Apply data-perm buttons
  document.querySelectorAll("[data-perm]").forEach(el => {
    const key = el.getAttribute("data-perm");
    const allowed = _getPermForRole(role, key);
    _setElementAllowed(el, allowed);
  });

  // Legacy: viewer gets all inputs disabled
  if (role === "viewer") {
    document.querySelectorAll("input:not([type=checkbox]), select, textarea").forEach(el => {
      el.disabled = true;
    });
  }
}

function _setElementAllowed(el, allowed) {
  if (allowed) {
    el.disabled = false;
    el.style.display = "";
    el.style.opacity = "";
    el.style.cursor = "";
    el.removeAttribute("title");
  } else {
    el.disabled = true;
    el.style.display = "none"; // hide completely
  }
}

// Keep legacy name for compatibility
function _applyViewerRestrictions() {
  _applyRoleRestrictions();
}

// ── Render Role Permissions UI (admin settings) ───────────────
async function renderRolePermissionsUI() {
  const container = document.getElementById("rolePermissionsSection");
  if (!container || !isAdmin()) return;

  container.innerHTML = `<div style="font-size:11px;color:var(--text2)">Chargement…</div>`;
  await _loadRolePermissions();

  const roles = ["user", "viewer"];
  const roleLabels = { user: "Utilisateur", viewer: "Lecteur" };
  const roleColors = { user: "#22c55e", viewer: "#f59e0b" };

  // Group permissions by section
  const sections = {};
  for (const [key, meta] of Object.entries(PERMISSION_LABELS)) {
    if (!sections[meta.section]) sections[meta.section] = [];
    sections[meta.section].push({ key, label: meta.label });
  }

  let html = `<div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <thead>
        <tr style="background:var(--bg3,#252a3d);">
          <th style="text-align:left;padding:6px 10px;color:var(--text2);font-weight:600;border-bottom:1px solid var(--border);">Action</th>
          ${roles.map(r => `
            <th style="text-align:center;padding:6px 10px;color:${roleColors[r]};font-weight:600;border-bottom:1px solid var(--border);min-width:70px;">
              ${roleLabels[r]}
            </th>`).join("")}
        </tr>
      </thead>
      <tbody>`;

  for (const [section, items] of Object.entries(sections)) {
    html += `<tr>
      <td colspan="${roles.length + 1}" style="padding:8px 10px 2px;font-size:10px;font-weight:700;color:var(--text3,#64748b);text-transform:uppercase;letter-spacing:.05em;background:var(--bg2);">
        ${section}
      </td>
    </tr>`;
    items.forEach(({ key, label }) => {
      html += `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:5px 10px;color:var(--text1);">${label}</td>
        ${roles.map(r => {
          const allowed = _getPermForRole(r, key);
          return `<td style="text-align:center;padding:5px 10px;">
            <input type="checkbox"
              data-role="${r}" data-key="${key}"
              ${allowed ? "checked" : ""}
              onchange="_onPermCheckboxChange(this)"
              style="width:15px;height:15px;cursor:pointer;accent-color:${roleColors[r]}"/>
          </td>`;
        }).join("")}
      </tr>`;
    });
  }

  html += `</tbody></table></div>
  <div id="permSaveMsg" style="font-size:11px;color:#22c55e;min-height:14px;margin-top:6px;text-align:right;"></div>`;

  container.innerHTML = html;
}

async function _onPermCheckboxChange(checkbox) {
  const role = checkbox.dataset.role;
  const key  = checkbox.dataset.key;
  const val  = checkbox.checked;

  if (!_loadedPermissions) await _loadRolePermissions();
  if (!_loadedPermissions[role]) _loadedPermissions[role] = {};
  _loadedPermissions[role][key] = val;

  try {
    await _saveRolePermissions(_loadedPermissions);
    const msg = document.getElementById("permSaveMsg");
    if (msg) { msg.textContent = "Sauvegardé ✓"; setTimeout(() => { msg.textContent = ""; }, 1500); }
  } catch(e) {
    console.error("Failed to save permissions:", e);
  }
}

// ── Block settings for non-admins ─────────────────────────────
function _guardSettings() {
  const btn = document.getElementById("btnSettings");
  if (!btn) return;
  if (!isAdmin()) {
    btn.style.display = "none";
  }
}

// ── Build App Login Screen HTML ───────────────────────────────
function _buildAppLoginScreen() {
  const div = document.createElement("div");
  div.id = "appLoginScreen";
  div.style.cssText = "display:flex;position:fixed;inset:0;z-index:10000;background:#0f1117;flex-direction:column;align-items:center;justify-content:center;padding:24px;";
  div.innerHTML = `
    <div style="width:100%;max-width:360px;display:flex;flex-direction:column;align-items:center;gap:20px;">
      <img src="/icons/icon512.png" width="90" height="90" style="border-radius:22px;box-shadow:0 4px 24px #4f8ef740;"/>
      <div style="text-align:center;">
        <div style="color:#e2e8f0;font-size:22px;font-weight:800;letter-spacing:-.5px">OwDoo</div>
        <div style="color:#64748b;font-size:13px;margin-top:4px">Connectez-vous pour continuer</div>
      </div>
      <div style="width:100%;display:flex;flex-direction:column;gap:12px;">
        <input id="appLoginUser" type="text" placeholder="Identifiant" autocomplete="username"
          style="width:100%;padding:16px;border-radius:12px;border:1.5px solid #2a2f45;background:#1e2336;color:#e2e8f0;font-size:16px;outline:none;-webkit-appearance:none;"/>
        <input id="appLoginPass" type="password" placeholder="Mot de passe" autocomplete="current-password"
          style="width:100%;padding:16px;border-radius:12px;border:1.5px solid #2a2f45;background:#1e2336;color:#e2e8f0;font-size:16px;outline:none;-webkit-appearance:none;"/>
        <div id="appLoginErr" style="color:#f87171;font-size:12px;min-height:16px;text-align:center;"></div>
        <button id="appLoginBtn"
          style="width:100%;padding:16px;border-radius:12px;background:#4f8ef7;color:#fff;font-size:16px;font-weight:700;border:none;cursor:pointer;-webkit-appearance:none;">
          Se connecter
        </button>
      </div>
      <div style="color:#334155;font-size:11px;">Étape 1/2 — Accès application</div>
    </div>
  `;
  document.body.appendChild(div);
  return div;
}

// ── Step 1: App Login ─────────────────────────────────────────
async function _doAppLogin() {
  await _ensureDefaultAdmin();

  // Check existing session
  if (_restoreAppSession()) return;

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

  const roleColors = { admin: "#4f8ef7", user: "#22c55e", viewer: "#f59e0b" };
  const roleLabels = { admin: "Admin", user: "Utilisateur", viewer: "Lecteur" };

  const badge = document.createElement("div");
  badge.id = "userBadge";
  badge.style.cssText = "display:flex;align-items:center;gap:5px;cursor:pointer;padding:3px 7px;border-radius:6px;border:1px solid var(--border);background:var(--bg2)";
  badge.title = "Se déconnecter de l'application";
  badge.innerHTML = `
    <span style="font-size:10px;color:${roleColors[AppAuth.currentUser.role]};font-weight:600">
      ${AppAuth.currentUser.username}
    </span>
    <span style="font-size:9px;color:${roleColors[AppAuth.currentUser.role]};background:${roleColors[AppAuth.currentUser.role]}22;padding:1px 5px;border-radius:4px">
      ${roleLabels[AppAuth.currentUser.role]}
    </span>
  `;
  badge.addEventListener("click", () => {
    const existing = document.getElementById("badgeMenu");
    if (existing) { existing.remove(); return; }
    const menu = document.createElement("div");
    menu.id = "badgeMenu";
    menu.style.cssText = "position:absolute;top:36px;right:8px;z-index:15000;background:#1e2336;border:1px solid #2a2f45;border-radius:8px;overflow:hidden;min-width:160px;box-shadow:0 4px 16px #0006;";
    menu.innerHTML = `
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

async function addAppUser(username, password, role) {
  if (!isAdmin()) throw new Error("Accès refusé");
  if (!username || !password || !role) throw new Error("Champs manquants");
  if (!["admin", "user", "viewer"].includes(role)) throw new Error("Rôle invalide");

  const existing = await _fbGet(`app_users/${username.toLowerCase()}`);
  if (existing) throw new Error("Cet identifiant existe déjà");

  const hash = await _hashPassword(password);
  await _fbSet(`app_users/${username.toLowerCase()}`, {
    username: username.toLowerCase(),
    password: hash,
    role,
    createdAt: Date.now(),
  });
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

// ── Render User Management UI (in settings) ───────────────────
async function renderUserManagementUI() {
  const container = document.getElementById("userManagementSection");
  if (!container || !isAdmin()) return;

  container.innerHTML = `<div style="font-size:11px;color:var(--text2)">Chargement…</div>`;

  const users = await getAppUsers();
  const roleColors = { admin: "#4f8ef7", user: "#22c55e", viewer: "#f59e0b" };
  const roleLabels = { admin: "Admin", user: "Utilisateur", viewer: "Lecteur" };

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">
      ${users.map(u => `
        <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;">
          <span style="flex:1;font-size:12px;color:var(--text1)">${u.username}</span>
          <select onchange="changeAppUserRole('${u.username}', this.value)"
            style="font-size:11px;background:var(--bg3,#252a3d);color:var(--text1);border:1px solid var(--border);border-radius:5px;padding:2px 5px;">
            ${["admin","user","viewer"].map(r => `
              <option value="${r}" ${u.role===r?"selected":""}>${roleLabels[r]}</option>
            `).join("")}
          </select>
          <span style="font-size:10px;color:${roleColors[u.role]};background:${roleColors[u.role]}22;padding:1px 6px;border-radius:4px;min-width:55px;text-align:center">
            ${roleLabels[u.role]}
          </span>
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
        <option value="viewer">Lecteur</option>
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

  // Post-login setup
  _addUserBadge();
  _guardSettings();

  // Load permissions then apply restrictions for non-admins
  if (!isAdmin()) {
    await _loadRolePermissions();
    setTimeout(_applyRoleRestrictions, 600);
    // Re-apply on DOM changes (dynamically rendered content)
    const obs = new MutationObserver(() => {
      clearTimeout(obs._t);
      obs._t = setTimeout(_applyRoleRestrictions, 150);
    });
    obs.observe(document.getElementById("app") || document.body, { childList: true, subtree: true });
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
