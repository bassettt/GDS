// middleware/requireAdmin.js
// يُطبَّق دائمًا بعد requireSession (يحتاج req.role موجودًا ومضبوطًا مسبقًا).
module.exports = function requireAdmin(req, res, next) {
  if (req.role !== "admin") {
    return res.status(403).json({ error: "admin_only" });
  }
  next();
};
