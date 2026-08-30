// middleware/requireSession.js
// يُطبَّق الآن على /api/sync/* وأيضًا /api/web/* (راجع routes/api.js).
//
// ⚠️ استثناء ضروري: /web/database/list يُستدعى من شاشة تسجيل الدخول *قبل*
// وجود أي app_session (لمعرفة اسم قاعدة بيانات Odoo قبل authenticate).
// حراسته بنفس شرط الجلسة كان يمنع تسجيل الدخول نهائيًا (قفل كامل) —
// هذا المسار لا يكشف أي بيانات حساسة (فقط أسماء قواعد البيانات المتاحة).
const { getSession } = require("../lib/sessions");

const BYPASS_PATHS = ["/web/database/list"];

function parseCookie(header, name) {
  if (!header) return null;
  const parts = header.split(";");
  for (const part of parts) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

module.exports = function requireSession(req, res, next) {
  if (BYPASS_PATHS.includes(req.url.split("?")[0])) {
    return next();
  }

  const token = parseCookie(req.headers.cookie, "app_session");
  const session = token ? getSession(token) : null;

  if (!session) {
    return res.status(401).json({ error: "not_authenticated" });
  }

  req.login = session.login;
  req.role = session.role;
  req.permissions = session.permissions || {};
  next();
};
