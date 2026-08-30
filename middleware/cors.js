// middleware/cors.js
module.exports = function cors(req, res, next) {
  const origin = req.headers["origin"] || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-openerp-session-id, Authorization, X-Requested-With"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
};
