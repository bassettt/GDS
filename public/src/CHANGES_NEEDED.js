// ============================================================
// CHANGES REQUIRED
// ============================================================

// ── 1. index.html ─────────────────────────────────────────────

// أضف قبل </body> مباشرة (قبل سطر app.js):
// <script src="/src/auth.js"></script>

// أضف في شاشة Odoo login (loginScreen) هذه الإضافة للتمييز بين الشاشتين:
// داخل div#loginScreen، بعد الـ logo، غير النص من:
//   "Connexion requise"
// إلى:
//   "Connexion Odoo — Étape 2/2"

// أضف هذا القسم في viewSettings، بعد settings-section الأول (Impression):
/*
<div class="settings-section" id="userManagementContainer" style="display:none">
  <div class="section-title-row">
    <label class="settings-label" style="margin:0">Gestion des utilisateurs</label>
    <button class="gds-refresh-btn" onclick="renderUserManagementUI()">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/>
      </svg>
      Actualiser
    </button>
  </div>
  <div id="userManagementSection" style="margin-top:8px;"></div>
</div>
*/

// ── 2. app.js ─────────────────────────────────────────────────

// REMPLACER dans DOMContentLoaded:
//   await _checkAndLogin();
// PAR:
//   await checkAndLoginTwoStep();

// REMPLACER la fonction _checkAndLogin() existante (lignes 8-81)
// PAR: rien — elle est désormais dans auth.js sous _checkOdooSession()

// DANS bindEvents(), ajouter après le bloc btnSettings:
/*
  // Show user management only for admins
  if (isAdmin()) {
    const container = document.getElementById("userManagementContainer");
    if (container) container.style.display = "";
    renderUserManagementUI();
  }
*/

// ── 3. sw.js (Service Worker cache) ──────────────────────────
// Ajouter "/src/auth.js" dans la liste des fichiers à cacher (CACHE_FILES)
