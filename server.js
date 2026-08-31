// ============================================================
// server.js — Production Server (Static + Odoo Proxy)
// Node.js only — no Express — ready for Render
// ============================================================
const http  = require("http");
const https = require("https"); // تغيير مهم: استخدام https
const fs    = require("fs");
const path  = require("path");
const url   = require("url");

const PORT        = process.env.PORT || 3001;
const TARGET_HOST = process.env.ODOO_HOST || "wafa.presalio.com";
const PUBLIC_DIR  = path.join(__dirname, "public");

const MIME = {
 ".html":  "text/html; charset=utf-8",
 ".js":    "application/javascript; charset=utf-8",
 ".css":   "text/css; charset=utf-8",
 ".json":  "application/json; charset=utf-8",
 ".png":   "image/png",
 ".ico":   "image/x-icon",
 ".svg":   "image/svg+xml",
 ".woff2": "font/woff2",
};

function _setCors(req, res) {
  const origin = req.headers["origin"] || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",
    "Content-Type, x-openerp-session-id, Authorization, X-Requested-With");
}

function _serveStatic(res, filePath) {
  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fallback to index.html for SPA routing
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (err2, html) => {
        if (err2) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
}

function _proxyToOdoo(req, res, odooPath) {
  const outHeaders = {
    ...req.headers,
    host:    TARGET_HOST,
    origin:  `http://${TARGET_HOST}:8069`,
	referer: `http://${TARGET_HOST}:8069/`,
  };
  
  delete outHeaders["accept-encoding"];
  delete outHeaders["connection"];
  delete outHeaders["transfer-encoding"];

  const options = {
    hostname: TARGET_HOST,
    port:     443, // تغيير المنفذ إلى 443 لـ HTTPS
    path:     odooPath,
    method:   req.method,
    headers:  outHeaders,
  };

  console.log(`[Proxy] ${req.method} https://${TARGET_HOST}${odooPath}`);

  // استخدام https.request بدلاً من http.request
  const proxy = https.request(options, (proxyRes) => {
    const outResHeaders = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (["access-control-allow-origin",
      "access-control-allow-headers",
      "access-control-allow-methods",
      "access-control-allow-credentials"].includes(k.toLowerCase())) continue;
      outResHeaders[k] = v;
    }

    // Fix cookies
    if (outResHeaders["set-cookie"]) {
      const cookies = Array.isArray(outResHeaders["set-cookie"])
        ? outResHeaders["set-cookie"] : [outResHeaders["set-cookie"]];
      outResHeaders["set-cookie"] = cookies.map(c => {
        let cookie = c
          .replace(/;\s*SameSite=[^;]*/gi, "")
          .replace(/;\s*Secure/gi, "");
        cookie += "; SameSite=Lax";
        return cookie;
      });
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
}

const server = http.createServer((req, res) => {
  _setCors(req, res);
  
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed   = url.parse(req.url);
  const pathname = parsed.pathname || "/";

  // Proxy API requests to Odoo
  if (pathname.startsWith("/api/")) {
    const odooPath = pathname.slice(4) + (parsed.search || "");
    _proxyToOdoo(req, res, odooPath);
    return;
  }

  // Serve Static Files
  let filePath;
  if (pathname === "/" || pathname === "") {
    filePath = path.join(PUBLIC_DIR, "index.html");
  } else {
    filePath = path.join(PUBLIC_DIR, pathname);
    // Security check to prevent directory traversal
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); res.end("Forbidden"); return;
    }
  }
  _serveStatic(res, filePath);
});

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`Proxying /api/* → https://${TARGET_HOST}`);
  console.log(`Serving static files from: ${PUBLIC_DIR}`);
});