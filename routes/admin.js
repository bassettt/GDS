// routes/admin.js
// يُركَّب على /api/admin في server.js/routes/api.js، محمي بـ
// requireSession + requireAdmin معًا (يُطبَّقان قبل هذا الراوتر، وليس هنا،
// حتى لا يُنسى تطبيقهما عند mount في مكان آخر مستقبلاً — راجع routes/api.js).
const express = require("express");
const {
  VALID_ROLES,
  getAdminLogins,
  isEnvAdmin,
  listUsers,
  upsertUser,
  removeUser,
} = require("../lib/users");
const { ALL_PERMISSIONS, ROLE_DEFAULTS } = require("../lib/permissions");

const router = express.Router();

// GET /api/admin/users
// يرجع كل مستخدمي Firestore + حسابات ADMIN_LOGINS الثابتة (موضّحة كـ
// source: "env" لأنها لا تملك مستند Firestore بالضرورة وغير قابلة للتعديل
// من اللوحة).
router.get("/users", async (req, res) => {
  try {
    const firestoreUsers = (await listUsers()).map((u) => ({
      ...u,
      source: "firestore",
    }));

    const firestoreLogins = new Set(firestoreUsers.map((u) => u.login));
    const envUsers = getAdminLogins()
      .filter((login) => !firestoreLogins.has(login)) // لا تكرار لو نفس login موجود بالفعل في Firestore
      .map((login) => ({ login, source: "env", role: "admin" }));

    res.json({ users: [...firestoreUsers, ...envUsers] });
  } catch (e) {
    console.error("[admin] GET /users failed:", e.message);
    res.status(500).json({ error: "users_read_failed" });
  }
});

// POST /api/admin/users
// body: { login, role, note, allowed }. ينشئ/يُحدّث مستند authorized_users
// عبر merge. لا يسمح بتعديل حسابات ADMIN_LOGINS من هنا (لا معنى لذلك، وقد
// يُنشئ مستند Firestore زائفًا يظنه المستخدم مصدر الصلاحية الحقيقي).
router.post("/users", async (req, res) => {
  try {
    const { login, role, note, allowed, permissionOverrides } = req.body || {};

    if (!login || typeof login !== "string") {
      return res.status(400).json({ error: "login_required" });
    }

    if (isEnvAdmin(login)) {
      return res.status(400).json({
        error: "env_admin_readonly",
        message: "هذا الحساب ثابت من ADMIN_LOGINS — عدّل ADMIN_LOGINS في إعدادات Render مباشرة",
      });
    }

    if (role !== undefined && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: "invalid_role" });
    }

    const user = await upsertUser({ login, role, note, allowed, permissionOverrides });
    res.json({ ok: true, user });
  } catch (e) {
    if (e.message === "invalid_role") {
      return res.status(400).json({ error: "invalid_role" });
    }
    if (e.message === "login_required") {
      return res.status(400).json({ error: "login_required" });
    }
    if (e.message === "invalid_permission_key") {
      return res.status(400).json({ error: "invalid_permission_key" });
    }
    console.error("[admin] POST /users failed:", e.message);
    res.status(500).json({ error: "user_write_failed" });
  }
});

// GET /api/admin/permissions
// يرجع كل مفاتيح الصلاحيات المتاحة (ALL_PERMISSIONS) وافتراضيات كل دور
// (ROLE_DEFAULTS) مباشرة من lib/permissions.js، لتبنيَ الواجهة عليها
// عناصر التحكم دون تكرار القائمة يدويًا في admin.js.
router.get("/permissions", (req, res) => {
  res.json({ all: ALL_PERMISSIONS, roleDefaults: ROLE_DEFAULTS });
});

// DELETE /api/admin/users/:login
// يمنع حذف/تعديل أي login ضمن ADMIN_LOGINS عبر هذا المسار.
router.delete("/users/:login", async (req, res) => {
  try {
    const { login } = req.params;

    if (isEnvAdmin(login)) {
      return res.status(400).json({
        error: "env_admin_readonly",
        message: "عدّل ADMIN_LOGINS في إعدادات Render مباشرة",
      });
    }

    const result = await removeUser(login);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("[admin] DELETE /users failed:", e.message);
    res.status(500).json({ error: "user_delete_failed" });
  }
});

module.exports = router;
