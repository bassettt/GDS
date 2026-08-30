// middleware/odooProxy.js
const https = require("https");
const { fixCookies } = require("../lib/fixCookies");

const TARGET_HOST = process.env.ODOO_HOST || "wafa.presalio.com";

// نقطة الدخول المستقبلية: أضف هنا middlewares فرعية
// (auth, permissions) قبل استدعاء proxyToOdoo، مثال:
// router.use('/api', authMiddleware, permissionsMiddleware, odooProxy);

module.exports = function odooProxy(req, res) {
  // req.url هنا هو ما تبقى بعد mount على "/api"، أي مساوٍ لِـ pathname.slice(4)
  // ⚠️ استثناء: مسارات "delivery-map" و "google-map" مسجّلة فعليًا على Odoo
  // تحت البادئة "/api/" ذاتها (وُثّق من تسجيل RPC حقيقي:
  // https://wafa.presalio.com/api/delivery-map/actor/788). بخلاف المسارات
  // العادية (مثل /web/dataset/call_kw) التي لا تحمل /api على Odoo، هذه
  // الوحدة المخصّصة تحتاج إعادة إضافة "/api" قبل إرسالها للخادم الفعلي،
  // وإلا يرجع Odoo 404 حقيقي (صفحة "Page introuvable" الخاصة به).
  const CUSTOM_API_PREFIXES = ["/delivery-map", "/google-map"];
  const needsApiPrefix = CUSTOM_API_PREFIXES.some(
    (p) => req.url === p || req.url.startsWith(p + "/") || req.url.startsWith(p + "?")
  );
  const odooPath = needsApiPrefix ? "/api" + req.url : req.url; // يشمل query string تلقائيًا لأن express يحافظ عليه

  const outHeaders = {
    ...req.headers,
    host: TARGET_HOST,
    origin: `https://${TARGET_HOST}`,
    referer: `https://${TARGET_HOST}/`,
  };
  delete outHeaders["accept-encoding"];
  delete outHeaders["connection"];
  delete outHeaders["transfer-encoding"];

  const options = {
    hostname: TARGET_HOST,
    port: 443,
    path: odooPath,
    method: req.method,
    headers: outHeaders,
    family: 4, // ⚠️ إجبار IPv4 صراحةً: يحل ETIMEDOUT الناتج عن محاولة IPv6 أولًا على بعض شبكات Windows
  };

  console.log(`[Proxy] ${req.method} ${odooPath}`);

  const proxy = https.request(options, (proxyRes) => {
    // ⚠️ Odoo يرد أحيانًا بـ 3xx (مثلاً لإضافة بادئة اللغة /fr/ للمسار).
    // إن مررنا Location المطلق (https://wafa.presalio.com/...) للمتصفح كما هو،
    // فالمتصفح يتبعه مباشرة خارج البروكسي المحلي => طلب cross-origin حقيقي
    // يفشل بـ CORS لأن Odoo يرجع Access-Control-Allow-Origin: * مع credentials.
    // الحل: نتبع الـ redirect من طرف السيرفر نفسه (Node)، وليس المتصفح.
    if (
      proxyRes.statusCode >= 300 &&
      proxyRes.statusCode < 400 &&
      proxyRes.headers.location
    ) {
      proxyRes.resume(); // نفرّغ body الرد الأصلي بدون استهلاكه بالمتصفح
      let redirectPath = proxyRes.headers.location;
      try {
        // location قد يكون مطلق (https://wafa.presalio.com/fr/...) أو نسبي (/fr/...)
        const u = new URL(redirectPath, `https://${TARGET_HOST}`);
        redirectPath = u.pathname + u.search;
      } catch (e) {}

      const redirectOptions = {
        ...options,
        path: redirectPath,
        method: "GET", // 302 بعد GET/POST يُتابَع عادة كـ GET من طرف Odoo نفسه
      };
      delete redirectOptions.headers["content-length"];

      const redirectProxy = https.request(redirectOptions, (redirectRes) => {
        const outResHeaders = {};
        for (const [k, v] of Object.entries(redirectRes.headers)) {
          if (
            [
              "access-control-allow-origin",
              "access-control-allow-headers",
              "access-control-allow-methods",
              "access-control-allow-credentials",
            ].includes(k)
          )
            continue;
          outResHeaders[k] = v;
        }
        if (outResHeaders["set-cookie"]) {
          outResHeaders["set-cookie"] = fixCookies(outResHeaders["set-cookie"]);
        }
        res.writeHead(redirectRes.statusCode, outResHeaders);
        redirectRes.pipe(res);
      });
      redirectProxy.on("error", (err) => {
        console.error("[Proxy Redirect Error]", err.message);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Proxy redirect error: " + err.message }));
        }
      });
      redirectProxy.end();
      return;
    }

    const outResHeaders = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (
        [
          "access-control-allow-origin",
          "access-control-allow-headers",
          "access-control-allow-methods",
          "access-control-allow-credentials",
        ].includes(k)
      )
        continue;
      outResHeaders[k] = v;
    }

    // إصلاح الكوكيز: إزالة Secure و SameSite=None، وإضافة SameSite=Lax
    if (outResHeaders["set-cookie"]) {
      outResHeaders["set-cookie"] = fixCookies(outResHeaders["set-cookie"]);
    }

    res.writeHead(proxyRes.statusCode, outResHeaders);
    proxyRes.pipe(res);
  });

  proxy.on("error", (err) => {
    console.error("[Proxy Error]", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Proxy error: " + err.message }));
    }
  });

  req.pipe(proxy);
};
