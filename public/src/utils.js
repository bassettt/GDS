// ============================================================
// utils.js — دوال مساعدة مشتركة
// ============================================================

function getDateKey(offset = 0) {
  const d = new Date();
  if (offset) d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function getTodayKey() {
  return getDateKey(0);
}

function shortLabel(name) {
  const p = (name||"").trim().split(/\s+/);
  return p.length >= 2 ? p.slice(-2).join(" ") : (name||"");
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function norm(s) {
  return (s||"").toUpperCase().replace(/\s+/g," ").trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// قاموس اختصار أسماء المنتجات — للعرض فقط (لا يغيّر البحث أو RPC/Odoo)
// استعمال: productLabel(name) عند العرض في DOM فقط، أبداً عند الإرسال/البحث
// ============================================================
const PRODUCT_NAME_DICT = [
  ["BARQUETTE ALUMINIUM", "BARQUETTE"],
  ["ALUMINIUM & COUVERCLE", "X"],
  ["& COUVERCLE", "X"],
  ["SHAMPOOING BRILISS A", "SHAM"],
  ["BRILISS LISSAGE ILLIM", "X"],
  ["DEPILATOIRE DAHLIA", "X"],
  ["PLATEAU ALUMINIUM P", "PLAT"],
  ["DE POCHE PARFUMÉE", "X"],
  ["PAPIER HYGIÉNIQUE", "PH"],
  ["PAPIER HYGIENIQUE", "PH"],
  ["PAPIER HYGENIQUE", "PH"],
  ["PAPIER CUISSON", "PC"],
  ["BOITE MOUCHOIR", "BM"],
  ["FILM ALIMENTAIRE", "FILM"],
  ["BRILISS A L'HUILE", "X"],
  ["BÉBÉ 80 DOUCE", "X"],
  ["ESSUIE TOUT", "ESS"],
  ["40X40cm / 45", "X"],
  ["40X40cm / 50", "X"],
  ["40X40cm /45", "X"],
  ["30X30cm / 80", "X"],
  ["30X30cm / 35", "X"],
  ["36X36 / 25", "X"],
  ["27X25cm /", "X"],
  ["mètres X 30cm", "X"],
  ["mètres X 30 cm", "X"],
  ["mètres X 28 cm", "X"],
  ["mètres X 30", "X"],
  ["BRILISS A", "X"],
  ["PARFUME", "X"],
  ["WARDA", "X"],
  ["WAFA", "X"],
  ["RLX", "X"],
].sort((a, b) => b[0].length - a[0].length); // الأطول أولاً لتفادي التداخل

function _escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ينظّف الفراغات: يجمع أي تسلسل فراغات في فراغ واحد، ويحذف الفراغات
// والرموز الزائدة من البداية/النهاية (TRIM)
function _collapseAndTrim(s) {
  return s.replace(/\s+/g, " ").replace(/^[\s/\-,&]+|[\s/\-,&]+$/g, "").trim();
}

// يبني اسماً مختصراً للعرض فقط. لا يستعمل أبداً كمعرّف بحث أو مفتاح إرسال.
function productLabel(rawName) {
  let s = String(rawName || "");
  // 1) حذف كود Odoo البادئ: كل ما قبل "]" مع "]" نفسها (مثال: "[REF123] Nom" → "Nom")
  const bIdx = s.indexOf("]");
  if (bIdx !== -1) s = s.slice(bIdx + 1);
  // 2) استبدال الأقواس بمسافة (وليس حذفها بدون مسافة) حتى لا تلتصق الكلمات ببعضها
  //    عند إزالتها، ثم TRIM فوري لتفادي فراغين متتاليين
  s = _collapseAndTrim(s.replace(/[()]/g, " "));
  // 3) تطبيق قاموس الاختصار — X تعني حذف العبارة كاملة. كل استبدال يُتبع
  //    بمسافة صريحة بدل الالتصاق المباشر، ثم TRIM لتفادي الفراغات المزدوجة
  for (const [oldTxt, newTxt] of PRODUCT_NAME_DICT) {
    const replacement = newTxt === "X" ? " " : ` ${newTxt} `;
    s = _collapseAndTrim(s.replace(new RegExp(_escRe(oldTxt), "gi"), replacement));
  }
  // 4) TRIM نهائي للتأكد من عدم وجود فراغات مزدوجة أو زائدة في البداية/النهاية
  return _collapseAndTrim(s);
}

// ── RBAC: طبقة تجربة استخدام فقط (الفرض الحقيقي دائمًا في السيرفر) ──
// App.permissions تُعبَّى مرة واحدة بعد تسجيل الدخول عبر GET /api/sync/me
function hasPermission(key) {
  return !!(typeof App !== "undefined" && App.permissions && App.permissions[key]);
}

// ── RBAC: إخفاء/إظهار أقسام كاملة في لوحة الإعدادات حسب settings.* ──
// (نفس منطق hasPermission أعلاه، لكن على مستوى أقسام DOM كاملة بدل أزرار
// الكرت فقط. الفرض الحقيقي يبقى غائبًا هنا عمدًا لأن أغلب هذه الأقسام
// localStorage محلي وليس عمليات Odoo على السيرفر)
function applySettingsPermissions() {
  document.querySelectorAll('[data-settings-perm]').forEach(el => {
    const perm = el.getAttribute('data-settings-perm');
    el.style.display = hasPermission(perm) ? '' : 'none';
  });
  const exportBtn = document.getElementById('btnExportExcel');
  if (exportBtn) exportBtn.style.display = hasPermission('export.excel') ? '' : 'none';
}

// ── Icône "Voir la fiche client" (inline, à côté de tout nom de zbon) ──
function _clientLinkIconHtml(clientId, clientRef) {
  const id  = clientId != null && clientId !== "" && +clientId > 0 ? +clientId : null;
  const ref = clientRef != null && clientRef !== "" ? String(clientRef) : "";
  if (!id && !ref) return "";
  const attr = id ? `data-client-id="${id}"` : `data-client-ref="${escHtml(ref)}"`;
  return `<svg class="client-link-icon" ${attr} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" style="display:inline-block;vertical-align:-2px;margin-left:4px;cursor:pointer;flex-shrink:0;opacity:.75" title="Voir la fiche client"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>`;
}

// يفتح بروفايل الزبون: يغلق أي نوافذ BL/Clients مفتوحة، يبدّل القسم إلى Clients، ثم يعرضه
function openClientProfileGlobal(clientId, clientRef) {
  ["blDetailsOverlay", "blListOverlay", "clientsListOverlay", "payListOverlay", "roundMapOverlay"].forEach(id => {
    document.getElementById(id)?.remove();
  });
  setMode("clients");
  setTimeout(() => {
    if (window.ClientsView?.openProfileById) {
      window.ClientsView.openProfileById(clientId, clientRef);
    }
  }, 60);
}

// تفويض النقر على أيقونة "Voir la fiche client" من أي مكان بالتطبيق
document.addEventListener("click", (e) => {
  const icon = e.target.closest(".client-link-icon");
  if (!icon) return;
  e.preventDefault();
  e.stopPropagation();
  const id  = icon.getAttribute("data-client-id");
  const ref = icon.getAttribute("data-client-ref");
  openClientProfileGlobal(id ? +id : null, ref || null);
});

// ── Excel export helper ──────────────────────────────────────
// تحويل مصفوفة من الكائنات إلى ملف Excel بسيط (CSV بامتداد .xlsx)
function exportToExcel(rows, filename) {
  if (!rows || !rows.length) return;
  const headers = Object.keys(rows[0]);
  const csvRows = [
    headers.join(";"),
    ...rows.map(r => headers.map(h => {
      const v = r[h] ?? "";
      const s = String(v).replace(/"/g, '""');
      return s.includes(";") || s.includes("\n") ? `"${s}"` : s;
    }).join(";"))
  ];
  const bom  = "\uFEFF"; // UTF-8 BOM for Excel Arabic support
  const blob = new Blob([bom + csvRows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename || `wafa-export-${getTodayKey()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
