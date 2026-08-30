// lib/fixCookies.js
function fixCookies(setCookieHeader) {
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return cookies.map((c) =>
    c.replace(/;\s*SameSite=[^;]*/gi, "").replace(/;\s*Secure/gi, "") + "; SameSite=Lax"
  );
}
module.exports = { fixCookies };
