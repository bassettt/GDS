// middleware/authGate.js
// يعترض فقط POST /web/session/authenticate
// كل مسار آخر يمر دون لمس (راجع routes/api.js)
const https = require("https");
const { db } = require("../lib/firebaseAdmin");
const { fixCookies } = require("../lib/fixCookies");
const { createSession } = require("../lib/sessions");
const { computePermissions } = require("../lib/permissions");

const TARGET_HOST = process.env.ODOO_HOST || "wafa.presalio.com";
const AUTH_PATH = "/web/session/authenticate";

function buildOutHeaders(req) {
  const h = {
    ...req.headers,
    host: TARGET_HOST,
    origin: `https://${TARGET_HOST}`,
    referer: `https://${TARGET_HOST}/`,
  };
  delete h["accept-encoding"];
  delete h["connection"];
  delete h["transfer-encoding"];
  return h;
}

module.exports = function authGate(req, res, next) {
  // فقط هذا المسار المحدد؛ أي شيء آخر → متابعة عادية (streaming proxy)
  if (req.method !== "POST" || req.url.split("?")[0] !== AUTH_PATH) {
    return next();
  }

  // 1) جمع (buffer) جسم الطلب القادم من المتصفح
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bodyBuffer = Buffer.concat(chunks);
    const outHeaders = buildOutHeaders(req);
    outHeaders["content-length"] = Buffer.byteLength(bodyBuffer);

    const options = {
      hostname: TARGET_HOST,
      port: 443,
      path: AUTH_PATH,
      method: "POST",
      headers: outHeaders,
    };

    console.log(`[AuthGate] POST ${AUTH_PATH}`);

    const odooReq = https.request(options, (odooRes) => {
      const resChunks = [];
      odooRes.on("data", (c) => resChunks.push(c));
      odooRes.on("end", async () => {
        const rawBody = Buffer.concat(resChunks);
        let parsed;
        try {
          parsed = JSON.parse(rawBody.toString("utf8"));
        } catch (e) {
          // رد غير JSON (نادر) → مرّره كما هو دون تعديل
          res.writeHead(odooRes.statusCode, odooRes.headers);
          return res.end(rawBody);
        }

        const uid = parsed && parsed.result && parsed.result.uid;

        // 2) لا uid → بيانات خاطئة، مرّر رد Odoo كما هو تمامًا
        if (!uid) {
          res.writeHead(odooRes.statusCode, odooRes.headers);
          return res.end(rawBody);
        }

        // 3) دخول ناجح فعليًا عند Odoo → تحقق من allowlist + احسب الدور/الصلاحيات
        const login =
          (parsed.result.username || parsed.result.login || "").toLowerCase();

        // حسابات الأدمن الثابتة (من متغيّر بيئة ADMIN_LOGINS، مفصولة بفواصل)
        // مسموحة دائمًا بدون أي اعتماد على Firestore — حتى لا يُقفَل صاحب
        // التطبيق خارجه أبدًا مهما حدث لقاعدة البيانات. تُعتبر دائمًا "admin".
        const ADMIN_LOGINS = (process.env.ADMIN_LOGINS || "")
          .split(",")
          .map(s => s.trim().toLowerCase())
          .filter(Boolean);

        let allowed = ADMIN_LOGINS.includes(login);
        let role = "viewer";
        let overrides = {};

        if (allowed) {
          // ADMIN_LOGINS يتجاوز كل شيء: دور admin بكل الصلاحيات true
          role = "admin";
        } else {
          try {
            const doc = await db.collection("authorized_users").doc(login).get();
            const data = doc.exists ? doc.data() : null;
            allowed = !!data && data.allowed === true;
            if (allowed) {
              role = data.role || "viewer";
              overrides = data.permissionOverrides || {};
            }
          } catch (e) {
            console.error("[AuthGate] Firestore error:", e.message);
            allowed = false; // فشل التحقق = رفض افتراضي (fail-closed)
          }
        }

        if (allowed) {
          const permissions = computePermissions(role, overrides);

          // مرّر رد Odoo كاملاً كما هو + إصلاح الكوكيز كالمعتاد
          const outResHeaders = { ...odooRes.headers };
          const odooCookies = outResHeaders["set-cookie"]
            ? fixCookies(outResHeaders["set-cookie"])
            : [];

          // أنشئ جلسة app_session خاصة بنا (منفصلة عن كوكيز Odoo)
          const token = createSession(login, role, permissions);
          const appCookie =
            `app_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`;

          outResHeaders["set-cookie"] = [...odooCookies, appCookie];
          res.writeHead(odooRes.statusCode, outResHeaders);
          return res.end(rawBody);
        }

        // 4) غير مصرَّح له → لا كوكيز إطلاقًا، ولا نُسرّب أي بيانات من Odoo
        //    (result.uid يجب ألا يظهر إطلاقًا، وإلا فالواجهة الأمامية —
        //    التي تتحقق فقط من d?.result?.uid — ستظن أن الدخول نجح).
        console.log(`[AuthGate] Blocked login: ${login}`);
        const denied = {
          jsonrpc: parsed.jsonrpc || "2.0",
          id: parsed.id,
          error: "not_authorized",
        };
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(denied));
      });
    });

    odooReq.on("error", (err) => {
      console.error("[AuthGate] Proxy Error:", err.message);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Proxy error: " + err.message }));
      }
    });

    odooReq.end(bodyBuffer);
  });
};
