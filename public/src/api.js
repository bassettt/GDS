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

// GET /api/resolve-maps-url?url=... — résout les liens courts Google Maps
// (maps.app.goo.gl, goo.gl) côté serveur en suivant les redirections HTTP,
// car un fetch direct depuis le navigateur est bloqué par CORS sur ces domaines.
// Restreint volontairement aux domaines Google pour éviter tout usage comme
// proxy HTTP générique (SSRF).
router.get("/resolve-maps-url", async (req, res) => {
  const target = typeof req.query.url === "string" ? req.query.url : "";
  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    return res.status(400).json({ error: "URL invalide" });
  }
  const isAllowedHost = (h) => /(^|\.)goo\.gl$/i.test(h) || /(^|\.)app\.goo\.gl$/i.test(h) || /(^|\.)google\.[a-z.]+$/i.test(h);
  if (!isAllowedHost(parsed.hostname) || parsed.protocol !== "https:") {
    return res.status(400).json({ error: "Domaine non autorisé" });
  }

  const https = require("https");
  const followRedirects = (urlStr, hopsLeft) => new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error("URL invalide")); }
    if (!isAllowedHost(u.hostname) || u.protocol !== "https:") {
      return reject(new Error("Domaine non autorisé"));
    }
    if (hopsLeft <= 0) return reject(new Error("Trop de redirections"));
    const req2 = https.get(u, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 }, (r) => {
      r.resume(); // on ne lit pas le corps, seule la redirection nous intéresse
      const loc = r.headers.location;
      if (r.statusCode >= 300 && r.statusCode < 400 && loc) {
        const next = new URL(loc, u).toString();
        resolve(followRedirects(next, hopsLeft - 1));
      } else {
        resolve(u.toString());
      }
    });
    req2.on("timeout", () => req2.destroy(new Error("Délai dépassé")));
    req2.on("error", reject);
  });

  try {
    const finalUrl = await followRedirects(parsed.toString(), 6);
    res.json({ url: finalUrl });
  } catch (e) {
    res.status(502).json({ error: e.message || "Échec de résolution du lien" });
  }
});

router.use("/", odooProxy);

module.exports = router;
