// public/src/admin.js
// منطق لوحة الأدمن المنفصلة (/admin.html). لا يلمس app.js/renderer.js
// ولا منطق تسجيل الدخول الرئيسي إطلاقًا — يتحقق فقط من app_session الموجودة
// عبر GET /api/sync/me.

(function () {
  "use strict";

  const gateEl = document.getElementById("admin-gate");
  const contentEl = document.getElementById("admin-content");
  const tbody = document.getElementById("users-tbody");
  const msgEl = document.getElementById("admin-msg");
  const addForm = document.getElementById("add-user-form");

  // بيانات ثابتة من GET /api/admin/permissions: { all: [...], roleDefaults: {...} }
  // تُحمَّل مرة واحدة عند init() وتُستخدم لبناء صفوف الصلاحيات الموسَّعة.
  let permissionsMeta = null;

  // أي logins مفتوح لها صف "تفاصيل الصلاحيات" حاليًا (يبقى مفتوحًا عبر
  // إعادة renderUsers بعد أي تحديث/حفظ).
  const expandedLogins = new Set();

  // آخر قائمة مستخدمين حُمّلت من السيرفر، تُستخدم لإعادة render عند فتح/إغلاق
  // صف تفاصيل الصلاحيات دون إعادة الطلب من الشبكة.
  let lastUsers = [];

  function showGate(html, isError) {
    gateEl.innerHTML = html;
    gateEl.hidden = false;
    gateEl.className = "admin-gate" + (isError ? " admin-gate--error" : "");
    contentEl.hidden = true;
  }

  function showMsg(text, ok) {
    msgEl.textContent = text;
    msgEl.hidden = false;
    msgEl.className = "admin-msg " + (ok ? "admin-msg--ok" : "admin-msg--error");
    // اختفاء تلقائي بعد قليل، لا تترك رسالة النجاح معلّقة للأبد
    clearTimeout(showMsg._t);
    showMsg._t = setTimeout(() => { msgEl.hidden = true; }, 4000);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  async function checkSession() {
    let res;
    try {
      res = await fetch("/api/sync/me", { credentials: "include" });
    } catch (e) {
      showGate("تعذّر الاتصال بالسيرفر. حاول تحديث الصفحة.", true);
      return null;
    }

    if (res.status === 401) {
      showGate(
        'الرجاء تسجيل الدخول من التطبيق الرئيسي أولاً. <a href="/index.html">الذهاب لصفحة الدخول</a>',
        true
      );
      return null;
    }

    if (!res.ok) {
      showGate("حدث خطأ غير متوقع أثناء التحقق من الجلسة.", true);
      return null;
    }

    const session = await res.json();
    if (session.role !== "admin") {
      showGate("هذه الصفحة للأدمن فقط.", true);
      return null;
    }

    gateEl.hidden = true;
    contentEl.hidden = false;
    return session;
  }

  async function loadPermissionsMeta() {
    try {
      const res = await fetch("/api/admin/permissions", { credentials: "include" });
      if (!res.ok) throw new Error("fetch_failed");
      permissionsMeta = await res.json();
    } catch (e) {
      console.error("[admin] تعذّر تحميل بيانات الصلاحيات:", e.message);
      permissionsMeta = { all: [], roleDefaults: {} };
    }
  }

  // ===== تجميع مفاتيح الصلاحيات بصريًا حسب البادئة =====
  // البادئة الرئيسية = الجزء قبل أول نقطة (مثلاً "card"، "agents").
  // إن وُجد مفتاح بعمق أكبر (نقطتان فأكثر، مثل "card.showBLs.scheduled")
  // يُجمَّع تحت عنوان فرعي = أول جزءين ("card.showBLs")، وإن كان هذا العنوان
  // الفرعي نفسه مفتاح صلاحية مستقل (مثل "card.showBLs" ذاتها) يُنقَل ليكون
  // أول عنصر داخل مجموعته الفرعية بدل تكراره خارجها.
  function groupPermissions(keys) {
    const top = {}; // top[topKey] = { direct: [keys], sub: { subKey: [keys] } }
    keys.forEach((k) => {
      const parts = k.split(".");
      const topKey = parts[0];
      if (!top[topKey]) top[topKey] = { direct: [], sub: {} };
      if (parts.length <= 2) {
        top[topKey].direct.push(k);
      } else {
        const subKey = parts[1];
        if (!top[topKey].sub[subKey]) top[topKey].sub[subKey] = [];
        top[topKey].sub[subKey].push(k);
      }
    });
    Object.keys(top).forEach((topKey) => {
      const data = top[topKey];
      Object.keys(data.sub).forEach((subKey) => {
        const parentKey = `${topKey}.${subKey}`;
        const idx = data.direct.indexOf(parentKey);
        if (idx !== -1) {
          data.direct.splice(idx, 1);
          data.sub[subKey].unshift(parentKey);
        }
      });
    });
    return top;
  }

  function defaultLabel(role, key) {
    const def = !!(permissionsMeta.roleDefaults[role] && permissionsMeta.roleDefaults[role][key]);
    return `افتراضي الدور: ${def ? "مفعّلة" : "معطّلة"}`;
  }

  function permItemHtml(key, role, overrides) {
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, key);
    const current = hasOverride ? (overrides[key] ? "true" : "false") : "default";
    return `
      <div class="perm-item" data-perm-key="${escapeHtml(key)}">
        <span class="perm-item-key">${escapeHtml(key)}</span>
        <span class="perm-default-hint" data-default-hint>${defaultLabel(role, key)}</span>
        <select data-perm-select data-key="${escapeHtml(key)}" data-current="${current}">
          <option value="default" ${current === "default" ? "selected" : ""}>افتراضي</option>
          <option value="true" ${current === "true" ? "selected" : ""}>مفعّلة</option>
          <option value="false" ${current === "false" ? "selected" : ""}>معطّلة</option>
        </select>
      </div>`;
  }

  function groupHtml(topKey, data, role, overrides) {
    const directHtml = data.direct.map((k) => permItemHtml(k, role, overrides)).join("");
    const subHtml = Object.keys(data.sub).map((subKey) => {
      const keys = data.sub[subKey];
      return `
        <details class="perm-subgroup">
          <summary>${escapeHtml(topKey + "." + subKey)}.*</summary>
          <div class="perm-sub-items">
            ${keys.map((k) => permItemHtml(k, role, overrides)).join("")}
          </div>
        </details>`;
    }).join("");

    return `
      <details class="perm-group" open>
        <summary>${escapeHtml(topKey)}</summary>
        <div class="perm-group-items">
          ${directHtml}
          ${subHtml}
        </div>
      </details>`;
  }

  function expandedRowHtml(u) {
    const login = escapeHtml(u.login);
    const overrides = u.permissionOverrides || {};
    const groups = permissionsMeta && permissionsMeta.all ? groupPermissions(permissionsMeta.all) : {};
    const groupsHtml = Object.keys(groups)
      .map((topKey) => groupHtml(topKey, groups[topKey], u.role, overrides))
      .join("");

    return `
      <tr class="perm-row" data-perm-row-for="${login}">
        <td colspan="6">
          <div class="perm-panel" data-login="${login}">
            ${groupsHtml || '<p class="admin-hint">لا توجد بيانات صلاحيات متاحة حاليًا.</p>'}
            <div class="perm-actions">
              <button type="button" data-save-perms>حفظ الصلاحيات</button>
              <button type="button" data-reset-perms class="perm-reset-btn">إعادة الكل للافتراضي</button>
            </div>
          </div>
        </td>
      </tr>`;
  }

  function updateDefaultHints(permRow, role) {
    if (!permRow) return;
    permRow.querySelectorAll("[data-perm-key]").forEach((itemEl) => {
      const key = itemEl.getAttribute("data-perm-key");
      const hintEl = itemEl.querySelector("[data-default-hint]");
      if (hintEl) hintEl.textContent = defaultLabel(role, key);
    });
  }

  function renderUsers(users) {
    lastUsers = users;

    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="admin-loading">لا يوجد مستخدمون بعد.</td></tr>';
      return;
    }

    tbody.innerHTML = users.map((u) => rowHtml(u)).join("");

    tbody.querySelectorAll("tr[data-login]").forEach((tr) => {
      const login = tr.getAttribute("data-login");
      const isEnv = tr.getAttribute("data-source") === "env";
      if (isEnv) return; // صفوف ADMIN_LOGINS معطّلة بالكامل

      const roleSelect = tr.querySelector("select[data-role]");
      const allowedCheckbox = tr.querySelector("input[data-allowed]");
      const noteInput = tr.querySelector("input[data-note]");
      const deleteBtn = tr.querySelector("button[data-delete]");
      const toggleBtn = tr.querySelector("button[data-toggle-perms]");

      roleSelect?.addEventListener("change", () => {
        saveUser(login, tr);
        const permRow = tr.nextElementSibling;
        if (permRow && permRow.classList.contains("perm-row")) {
          updateDefaultHints(permRow, roleSelect.value);
        }
      });
      allowedCheckbox?.addEventListener("change", () => saveUser(login, tr));
      noteInput?.addEventListener("blur", () => saveUser(login, tr));
      deleteBtn?.addEventListener("click", () => deleteUser(login));
      toggleBtn?.addEventListener("click", () => toggleExpand(login));
    });

    tbody.querySelectorAll("[data-save-perms]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const panel = btn.closest(".perm-panel");
        const permRow = panel.closest("tr");
        const ownerRow = permRow.previousElementSibling;
        savePermissions(ownerRow, panel);
      });
    });

    tbody.querySelectorAll("[data-reset-perms]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const panel = btn.closest(".perm-panel");
        const permRow = panel.closest("tr");
        const ownerRow = permRow.previousElementSibling;
        resetPermissions(ownerRow);
      });
    });
  }

  function toggleExpand(login) {
    if (expandedLogins.has(login)) {
      expandedLogins.delete(login);
    } else {
      expandedLogins.add(login);
    }
    renderUsers(lastUsers);
  }

  function rowHtml(u) {
    const isEnv = u.source === "env";
    const login = escapeHtml(u.login);
    const note = escapeHtml(u.note || "");
    const allowed = u.allowed !== false; // افتراضي true إن غير محدد

    const roleOptions = ["admin", "editor", "viewer"]
      .map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${r}</option>`)
      .join("");

    if (isEnv) {
      return `
        <tr data-login="${login}" data-source="env" class="row--env">
          <td>${login}</td>
          <td><span class="admin-badge">admin</span></td>
          <td>—</td>
          <td>—</td>
          <td><span class="admin-badge admin-badge--env">ثابت من ADMIN_LOGINS</span></td>
          <td></td>
        </tr>`;
    }

    const isExpanded = expandedLogins.has(u.login);
    const toggleLabel = isExpanded ? "تفاصيل الصلاحيات ▲" : "تفاصيل الصلاحيات ▾";

    const mainRow = `
      <tr data-login="${login}" data-source="firestore" class="${isExpanded ? "row--expanded" : ""}">
        <td>${login}</td>
        <td>
          <select data-role>${roleOptions}</select>
        </td>
        <td>
          <input type="checkbox" data-allowed ${allowed ? "checked" : ""} />
        </td>
        <td>
          <input type="text" data-note value="${note}" style="width:100%" />
        </td>
        <td><span class="admin-badge">Firestore</span></td>
        <td class="row-actions">
          <button type="button" class="perm-toggle-btn" data-toggle-perms>${toggleLabel}</button>
          <button data-delete class="admin-delete-btn" type="button">حذف</button>
        </td>
      </tr>`;

    if (!isExpanded) return mainRow;
    return mainRow + expandedRowHtml(u);
  }

  async function loadUsers() {
    tbody.innerHTML = '<tr><td colspan="6" class="admin-loading">جارِ التحميل…</td></tr>';
    try {
      const res = await fetch("/api/admin/users", { credentials: "include" });
      if (res.status === 403) {
        showGate("هذه الصفحة للأدمن فقط.", true);
        return;
      }
      if (!res.ok) throw new Error("fetch_failed");
      const data = await res.json();
      renderUsers(data.users || []);
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="6" class="admin-loading">تعذّر تحميل المستخدمين.</td></tr>';
    }
  }

  async function saveUser(login, tr) {
    const role = tr.querySelector("select[data-role]").value;
    const allowed = tr.querySelector("input[data-allowed]").checked;
    const note = tr.querySelector("input[data-note]").value;

    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login, role, allowed, note }),
      });
      const data = await res.json();

      if (res.status === 403) {
        showMsg("خطأ 403: لست أدمن فعليًا. تم رفض العملية.", false);
        return;
      }
      if (!res.ok) {
        showMsg(data.message || data.error || "فشل الحفظ.", false);
        return;
      }
      showMsg(`تم حفظ ${login} بنجاح.`, true);
    } catch (e) {
      showMsg("تعذّر الاتصال بالسيرفر.", false);
    }
  }

  // يجمع فقط المفاتيح المُغيَّرة عن "افتراضي" من الصف الموسَّع، ويرسلها مع
  // بقية بيانات صف المستخدم (login, role, allowed, note) كما هي حاليًا في
  // الصف الرئيسي — وليس من نسخة مخزَّنة قديمًا، لأن الأدمن قد يكون غيّرها
  // للتو قبل الضغط على "حفظ الصلاحيات".
  async function savePermissions(ownerRow, panel) {
    const login = ownerRow.getAttribute("data-login");
    const role = ownerRow.querySelector("select[data-role]").value;
    const allowed = ownerRow.querySelector("input[data-allowed]").checked;
    const note = ownerRow.querySelector("input[data-note]").value;

    const permissionOverrides = {};
    panel.querySelectorAll("select[data-perm-select]").forEach((sel) => {
      const key = sel.getAttribute("data-key");
      if (sel.value === "true") permissionOverrides[key] = true;
      else if (sel.value === "false") permissionOverrides[key] = false;
      // "default" → لا تُضاف للكائن (تعني: اتبع افتراضي الدور)
    });

    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login, role, allowed, note, permissionOverrides }),
      });
      const data = await res.json();

      if (res.status === 403) {
        showMsg("خطأ 403: لست أدمن فعليًا. تم رفض العملية.", false);
        return;
      }
      if (!res.ok) {
        showMsg(data.message || data.error || "فشل حفظ الصلاحيات.", false);
        return;
      }
      showMsg(`تم حفظ صلاحيات ${login} بنجاح. يسري التغيير من تسجيل دخوله التالي.`, true);
      loadUsers();
    } catch (e) {
      showMsg("تعذّر الاتصال بالسيرفر.", false);
    }
  }

  // يرسل permissionOverrides: {} صراحة (وليس حذف الحقل أو تجاهله) لمسح كل
  // الاستثناءات الفردية لهذا المستخدم والرجوع الكامل لافتراضي دوره.
  async function resetPermissions(ownerRow) {
    const login = ownerRow.getAttribute("data-login");
    if (!confirm(`تأكيد إعادة كل صلاحيات "${login}" لافتراضي دوره؟`)) return;

    const role = ownerRow.querySelector("select[data-role]").value;
    const allowed = ownerRow.querySelector("input[data-allowed]").checked;
    const note = ownerRow.querySelector("input[data-note]").value;

    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login, role, allowed, note, permissionOverrides: {} }),
      });
      const data = await res.json();

      if (res.status === 403) {
        showMsg("خطأ 403: لست أدمن فعليًا. تم رفض العملية.", false);
        return;
      }
      if (!res.ok) {
        showMsg(data.message || data.error || "فشلت إعادة الضبط.", false);
        return;
      }
      showMsg(`تمت إعادة صلاحيات ${login} لافتراضي دوره.`, true);
      loadUsers();
    } catch (e) {
      showMsg("تعذّر الاتصال بالسيرفر.", false);
    }
  }

  async function deleteUser(login) {
    if (!confirm(`تأكيد حذف المستخدم "${login}"؟`)) return;
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(login)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();

      if (res.status === 403) {
        showMsg("خطأ 403: لست أدمن فعليًا. تم رفض العملية.", false);
        return;
      }
      if (!res.ok) {
        showMsg(data.message || data.error || "فشل الحذف.", false);
        return;
      }
      expandedLogins.delete(login);
      showMsg(`تم حذف ${login}.`, true);
      loadUsers();
    } catch (e) {
      showMsg("تعذّر الاتصال بالسيرفر.", false);
    }
  }

  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const login = document.getElementById("new-login").value.trim();
    const role = document.getElementById("new-role").value;
    const note = document.getElementById("new-note").value.trim();

    if (!login) return;

    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login, role, note, allowed: true }),
      });
      const data = await res.json();

      if (res.status === 403) {
        showMsg("خطأ 403: لست أدمن فعليًا. تم رفض العملية.", false);
        return;
      }
      if (!res.ok) {
        showMsg(data.message || data.error || "فشلت الإضافة.", false);
        return;
      }

      addForm.reset();
      document.getElementById("new-role").value = "viewer";
      showMsg(`تمت إضافة ${login}.`, true);
      loadUsers();
    } catch (e) {
      showMsg("تعذّر الاتصال بالسيرفر.", false);
    }
  });

  (async function init() {
    const session = await checkSession();
    if (!session) return;
    await loadPermissionsMeta();
    loadUsers();
  })();
})();
