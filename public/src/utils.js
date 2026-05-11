// utils.js — GDS helpers
function escHtml(str) {
  return String(str)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function norm(s) {
  return (s||"").toUpperCase().replace(/\s+/g," ").trim();
}
