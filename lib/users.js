// lib/users.js
// منطق مشترك لإدارة authorized_users في Firestore — يستخدمه كل من
// scripts/addUser.js (CLI) و routes/admin.js (لوحة الأدمن) لتجنّب تكرار الكود.
const { db } = require("./firebaseAdmin");
const { ALL_PERMISSIONS } = require("./permissions");

const VALID_ROLES = ["admin", "editor", "viewer"];
const COLLECTION = "authorized_users";
const PERMISSION_KEYS = new Set(ALL_PERMISSIONS);

function getAdminLogins() {
  return (process.env.ADMIN_LOGINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isEnvAdmin(login) {
  return getAdminLogins().includes((login || "").toLowerCase());
}

async function listUsers() {
  const snap = await db.collection(COLLECTION).get();
  return snap.docs.map((doc) => ({ login: doc.id, ...doc.data() }));
}

// upsertUser: تُستخدم من addUser.js (CLI) ومن POST /api/admin/users.
// role غير صالح → ترمي خطأً بدل الرجوع الصامت لـ "viewer" لأن مسار الـ API
// يحتاج يفرّق بين "افتراضي غير مُرسَل" و"قيمة خاطئة صريحة" (تحقق 400).
async function upsertUser({ login, role, note, allowed, permissionOverrides }) {
  if (!login) throw new Error("login_required");
  const cleanLogin = login.toLowerCase();

  if (role !== undefined && !VALID_ROLES.includes(role)) {
    throw new Error("invalid_role");
  }

  // permissionOverrides: undefined → لم يُرسَل إطلاقًا، تجاهله كليًا (لا تلمس
  // ما هو محفوظ مسبقًا). {} أو كائن → أُرسل صراحة، استبدل الحقل بالكامل.
  if (permissionOverrides !== undefined) {
    if (
      typeof permissionOverrides !== "object" ||
      permissionOverrides === null ||
      Array.isArray(permissionOverrides)
    ) {
      throw new Error("invalid_permission_key");
    }
    for (const [key, value] of Object.entries(permissionOverrides)) {
      if (!PERMISSION_KEYS.has(key) || typeof value !== "boolean") {
        throw new Error("invalid_permission_key");
      }
    }
  }

  const ref = db.collection(COLLECTION).doc(cleanLogin);
  const payload = {
    allowed: allowed === undefined ? true : !!allowed,
    role: role || "viewer",
    note: note || "",
    addedAt: new Date(),
  };
  await ref.set(payload, { merge: true });

  if (permissionOverrides !== undefined) {
    // مهم: نستخدم update() لا set(..., {merge:true}) لحقل permissionOverrides
    // تحديدًا، لأن set+merge يدمج مفاتيح الماب القديمة مع الجديدة دمجًا عميقًا
    // (فيبقى مفتاح قديم لم يُرسَل هذه المرة)، بينما update() يستبدل قيمة
    // الحقل بالكامل بالقيمة الجديدة — وهذا هو المطلوب هنا (استبدال كامل).
    await ref.update({ permissionOverrides });
    payload.permissionOverrides = permissionOverrides;
  }

  return { login: cleanLogin, ...payload };
}

async function removeUser(login) {
  if (!login) throw new Error("login_required");
  const cleanLogin = login.toLowerCase();
  await db.collection(COLLECTION).doc(cleanLogin).delete();
  return { login: cleanLogin };
}

module.exports = {
  VALID_ROLES,
  getAdminLogins,
  isEnvAdmin,
  listUsers,
  upsertUser,
  removeUser,
};
