// middleware/enforcePermission.js
// يُطبَّق على POST /api/web/dataset/call_kw و /api/web/dataset/call_button
// (كلاهما مُسجَّل عليه في routes/api.js)، بعد requireSession وقبل odooProxy.

const PERMISSION_HEADER = "x-app-permission";
const { computePermissions } = require("../lib/permissions");

module.exports = function enforcePermission(req, res, next) {
  const key = req.headers[PERMISSION_HEADER];

  // لا هيدر → لا تصنيف بعد لهذا الطلب → يمر كالمعتاد (بحث/عرض/GDS/إلخ)
  if (!key) return next();

  const permissions = req.permissions || {};

  // إذا كان المفتاح غائبًا من الجلسة (جلسة قديمة أنشئت قبل إضافة المفتاح)،
  // نرجع للقيم الافتراضية لدور المستخدم كـ fallback بدلاً من الرفض التلقائي.
  let allowed = permissions[key];
  if (allowed === undefined && req.role) {
    const freshPerms = computePermissions(req.role, {});
    allowed = freshPerms[key];
  }

  if (allowed === true) {
    return next();
  }

  return res.status(403).json({
    jsonrpc: "2.0",
    id: null,
    error: {
      code: 403,
      message: "Permission refusée",
      data: { name: "not_authorized", permission: key },
    },
  });
};
