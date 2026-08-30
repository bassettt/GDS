// routes/api.js
const express = require("express");
const odooProxy = require("../middleware/odooProxy");
const authGate = require("../middleware/authGate");
const requireSession = require("../middleware/requireSession");
const requireAdmin = require("../middleware/requireAdmin");
const enforcePermission = require("../middleware/enforcePermission");
const syncRoutes = require("./sync");
const adminRoutes = require("./admin");

const router = express.Router();

// /api/sync/* — مسارات مزامنة agents الجديدة (JSON body، جلسة app_session).
// يجب أن تُطبَّق قبل authGate/odooProxy حتى لا تذهب إلى Odoo proxy.
// limit مرفوع (كان الافتراضي 100kb) لأن قوالب Report Builder (Luckysheet)
// تحمل luckysheetNative بكل التنسيقات وتتجاوز بسهولة الحد الافتراضي، ما
// كان يسبب 413 Payload Too Large عند الحفظ.
router.use("/sync", express.json({ limit: "20mb" }), syncRoutes);

// /api/admin/* — لوحة إدارة authorized_users. تحتاج جلسة صالحة (requireSession)
// ثم دور admin فعليًا (requireAdmin)، بهذا الترتيب. مُطبَّقة هنا (قبل
// authGate/odooProxy) حتى لا تذهب طلبات اللوحة إلى Odoo proxy أبدًا.
router.use("/admin", express.json(), requireSession, requireAdmin, adminRoutes);

// authGate يعترض فقط /web/session/authenticate، وينادي next()
// لأي مسار آخر فيمر مباشرة إلى requireSession.
router.use("/", authGate);

// ⚠️ تغيير سلوك: بعد هذا التعديل، أي طلب /api/web/* (بما فيه الاستعلامات
// العادية GDS/بحث/عرض) يتطلب جلسة app_session صالحة، وليس فقط عبور authGate
// كما كان سابقًا. طلب بلا جلسة صالحة → 401 قبل الوصول لـ Odoo.
router.use("/", requireSession);

// enforcePermission يُطبَّق على call_kw وأيضًا call_button (بعض الأزرار مثل
// فتح/إغلاق التخطيط وHors-zone تمر عبر call_button وليس call_kw)، ولا يفعل
// شيئًا إن لم يوجد هيدر X-App-Permission (يمرّ next() مباشرة).
router.post("/web/dataset/call_kw", enforcePermission);
router.post("/web/dataset/call_button", enforcePermission);

router.use("/", odooProxy);

module.exports = router;
