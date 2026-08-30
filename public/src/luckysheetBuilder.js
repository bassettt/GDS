// ══════════════════════════════════════════════════════════════
// luckysheetBuilder.js — واجهة Report Builder الجديدة، مبنية على مكتبة
// Luckysheet الخارجية (Excel-like حقيقية) بدل الشبكة اليدوية القديمة
// (reportBuilder.js — محذوف بالكامل).
//
// يعتمد على formulaEngine.js (evaluateSumIfs, evaluateCellFormula, JOUR..)
// ويوفّر لـ formulaWizard.js نفس الواجهة التي كان reportBuilder.js يوفّرها
// له سابقًا (_rbCellsData، _rbCommitCellFormula، #rbGridWrap، _RB_HELP_REFERENCE
// وثلاث دوال الفئات المخصصة) حتى يعمل المنشئ التفاعلي "fx" دون أي تعديل.
//
// ⚠️ Luckysheet هنا هو واجهة عرض/تحرير فقط: صيغ SUMIFS(...) الخاصة بنا
// (DSL مختلف تمامًا عن صيغ Excel: فواصل ";", مصادر vnt/liv/enc..) تُحسب
// دائمًا عبر formulaEngine.js (وليس محرك الصيغ الداخلي لـLuckysheet)،
// ثم تُكتب القيمة الناتجة مباشرة في الخلية. raw الصيغة نفسه يُحفظ بشكل
// منفصل في _rbCellsData (بصيغة الحفظ القديمة نفسها) حتى يبقى متوافقًا مع
// reportViewer.js وواجهة الحفظ في routes/sync.js دون أي تعديل هناك.
// ══════════════════════════════════════════════════════════════

// ── حالة القالب الحالي (نفس تسميات/شكل reportBuilder.js القديم) ──
let _rbRows = 20;
let _rbCols = 12;
let _rbCellsData = {};   // { "A1": { raw:"...", value:"..."|number } }
let _rbMerges = [];      // [{ start:"A1", end:"B2" }]
let _rbStyles = {};      // غير مُستعمل فعليًا (التنسيق أصبح كليًا من Luckysheet)، يُحفَظ فارغًا فقط للتوافق مع شكل الحفظ القديم
let _rbHiddenRows = new Set();
let _rbHiddenCols = new Set();
let _rbColWidths = {};
let _rbRowHeights = {};
let _rbFreezeRow = false;
let _rbFreezeCol = false;
let _rbHideGridlines = false;
let _rbTemplates = [];
let _rbCurrentTemplateId = null;
let _rbSourcesMap = { vnt: [], liv: [], enc: [] }; // بيانات خام SUMIFS — تُملأ لاحقًا من rpcController
let _rbSelfWriteCells = new Set(); // خلايا كُتبت برمجيًا (بانتظار استهلاك hook التعديل لها مرة واحدة)

// ══════════════════════════════════════════════════════════════
// مرجع مركزي واحد لأسماء/شرح متغيرات DSL صيغ SUMIFS — يُستعمل من طرف
// formulaWizard.js (نافذة "منشئ الصيغ التفاعلي fx") ونافذة المساعدة هنا.
// ══════════════════════════════════════════════════════════════
const _RB_HELP_REFERENCE = {
  sources: [
    { code: "vnt", desc: "مبيعات (فواتير البيع اليومية)" },
    { code: "liv", desc: "توزيع/تسليم (livraison اليومية)" },
    { code: "enc", desc: "تحصيل/دفعات (encaissement اليومية)" },
  ],
  columns: [
    { code: "vnd", desc: "البائع (user_id)", sources: ["vnt", "liv", "enc"] },
    { code: "art", desc: "المنتج (product_id)", sources: ["vnt", "liv", "enc"] },
    { code: "cat", desc: "فئة المنتج (categ_id)", sources: ["vnt", "liv", "enc"] },
    { code: "lp", desc: "قائمة السعر (pricelist_id)", sources: ["vnt", "liv"] },
    { code: "crt", desc: "منشئ السجل (create_uid)", sources: ["enc"] },
  ],
  metrics: [
    { code: "amount", desc: "المبلغ (المتغيّر الافتراضي إن لم يُذكَر metric)" },
    { code: "qty", desc: "الكمية" },
    { code: "pack1", desc: "تعبئة 1 — اسم مؤقت، لم يُحسم بعد أي تعبئة يمثّل فعليًا" },
    { code: "pack2", desc: "تعبئة 2 — اسم مؤقت، لم يُحسم بعد أي تعبئة يمثّل فعليًا" },
    { code: "pack3", desc: "تعبئة 3 — اسم مؤقت، لم يُحسم بعد أي تعبئة يمثّل فعليًا" },
  ],
  dates: [
    { code: "jour", desc: "التاريخ الحالي المختار في المصمم" },
    { code: "jour-N", desc: "قبل N يوم من jour (مثال: jour-7)" },
    { code: "ds", desc: "بداية فترة تاريخ (يُستعمل مع de)" },
    { code: "de", desc: "نهاية فترة تاريخ (يُستعمل مع ds)" },
  ],
  cellRef: [
    { code: "A1", desc: "مرجع خلية (يُستعمل كقيمة شرط بدل كتابتها يدويًا)" },
  ],
  functions: [
    { code: "SUMIFS(vnt; vnd; A1; ds; jour-7; de; jour)", desc: "مجموع بشروط (مصدر؛ عمود؛ قيمة؛ ...)" },
    { code: "SUM(A1:A5)", desc: "مجموع نطاق خلايا (مثل Excel)" },
    { code: "SUM(A1:A3; B1:B3)", desc: "مجموع عدة نطاقات خلايا" },
    { code: "SUM(A1:A5) - SUM(B1:B5)", desc: "SUM مركّبة في صيغة حسابية" },
    { code: "JOUR()", desc: "التاريخ الحالي كنص DD/MM/YYYY" },
    { code: "=\"نص \" & JOUR()", desc: "دمج نص ثابت مع متغيّر/دالة عبر &" },
    { code: "=\"oran \" & jour", desc: "مثال: نص ثابت + متغيّر jour (بدون أقواس) يُدمجان بـ & — يمكن بناؤها من المنشئ التفاعلي (fx) بكتلتين: \"نص ثابت\" و\"تاريخ (jour)\"" },
  ],
};

// ══════════════════════════════════════════════════════════════
// أدوات تحويل مرجع خلية "A1" <-> (صف/عمود) — نفس منطق reportBuilder.js
// ══════════════════════════════════════════════════════════════
function _rbColLetters(index) {
  let n = index, s = "";
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}
function _rbColIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}
function _rbCellId(rowIdx, colIdx) { return _rbColLetters(colIdx) + (rowIdx + 1); }
function _rbParseCellId(id) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(id || "").trim());
  if (!m) return null;
  return { row: parseInt(m[2], 10) - 1, col: _rbColIndex(m[1].toUpperCase()) };
}

// ══════════════════════════════════════════════════════════════
// حساب الصيغ (منقول كما هو من reportBuilder.js) — يعتمد على formulaEngine.js
// ══════════════════════════════════════════════════════════════
// ⚠️ ثابت مؤقتًا على 25/03/2026: أثناء إنشاء/معاينة القالب في Luckysheet
// تُحسب صيغ SUMIFS دائمًا كأن اليوم الحالي هو هذا التاريخ (بدل تاريخ اليوم
// الفعلي)، حتى تظهر بيانات حقيقية بدل أصفار عند عدم وجود بيانات لليوم الحالي.
// هذا لا يؤثر على reportViewer.js (عرض التقارير الفعلي للمستخدم يبقى بتاريخه الحقيقي).
const _RB_BUILDER_FIXED_THEDAY = "2026-08-11";

function _rbCurrentTheday() {
  return _RB_BUILDER_FIXED_THEDAY;
}

function _rbSplitTopLevelConcat(expr) {
  const parts = [];
  let depth = 0, inQuote = false, current = "";
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '"') { inQuote = !inQuote; current += ch; continue; }
    if (!inQuote) {
      if (ch === "(") { depth++; current += ch; continue; }
      if (ch === ")") { depth--; current += ch; continue; }
      if (ch === "&" && depth === 0) { parts.push(current); current = ""; continue; }
    }
    current += ch;
  }
  parts.push(current);
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

function _rbEvaluateConcatPart(part) {
  const p = String(part || "").trim();
  const qm = /^"([\s\S]*)"$/.exec(p);
  if (qm) return qm[1];
  if (/^JOUR\s*\(/i.test(p)) return evaluateJour("=" + p, _rbCurrentTheday());
  if (/^jour(\s*-\s*\d+)?$/i.test(p)) return formatIsoDateToDMY(resolveDateExpr(p, _rbCurrentTheday()));
  try {
    const v = evaluateCellFormula("=" + p, _rbCellsRawMap(), undefined, _rbSumIfsCtx());
    return String(v);
  } catch (e) {
    return p;
  }
}

function _rbComputeCell(raw) {
  if (raw == null || raw === "") return { value: "" };
  if (typeof raw !== "string" || !raw.trim().startsWith("=")) return { value: raw };
  try {
    const expr = raw.trim().replace(/^=/, "").trim();
    const concatParts = _rbSplitTopLevelConcat(expr);
    if (concatParts.length > 1) {
      return { value: concatParts.map(_rbEvaluateConcatPart).join("") };
    }
    if (/^JOUR\s*\(/i.test(expr)) return { value: evaluateJour(raw, _rbCurrentTheday()) };
    const v = evaluateCellFormula(raw, _rbCellsRawMap(), undefined, _rbSumIfsCtx());
    return { value: v };
  } catch (e) {
    return { value: "#خطأ: " + e.message, error: e.message };
  }
}

function _rbCellsRawMap() {
  const map = {};
  for (const id in _rbCellsData) map[id] = _rbCellsData[id].raw;
  return map;
}
// ⚠️ إصلاح: كانت _rbCellsValueMap تُبنى فقط من _rbCellsData، أي فقط من
// الخلايا التي تحتوي صيغة. مرجع خلية داخل SUMIFS (مثل vnd;J17) يُستبدل
// بالقيمة الفعلية عبر هذه الخريطة تحديدًا (_resolveSumIfsConditionValue في
// formulaEngine.js) — فإن كانت J17 خلية قيمة عادية (رقم بائع مكتوب يدويًا،
// وليست صيغة) لم تكن تظهر في هذه الخريطة إطلاقًا، فيبقى الشرط يقارن حرفيًا
// بالنص "J17" بدل الرقم الفعلي، ولا يتطابق أبدًا مع أي بيانات → نتيجة 0
// صامتة دائمًا. الآن نقرأ أولًا كل الخلايا مباشرة من شبكة Luckysheet
// الحيّة (flowdata) — تغطي أي خلية قيمة عادية، ثم نُطغّي فوقها بالقيم
// المحسوبة من _rbCellsData (أدق للخلايا-الصيغة نفسها لأنها القيمة
// المحسوبة فعليًا وليست ما هو معروض في الشبكة فقط).
function _rbGridValueMap() {
  const map = {};
  if (typeof luckysheet === "undefined" || typeof luckysheet.flowdata !== "function") return map;
  let flow;
  try { flow = luckysheet.flowdata(); } catch (e) { return map; }
  if (!Array.isArray(flow)) return map;
  for (let r = 0; r < flow.length; r++) {
    const rowArr = flow[r];
    if (!Array.isArray(rowArr)) continue;
    for (let c = 0; c < rowArr.length; c++) {
      const cell = rowArr[c];
      if (!cell) continue;
      const v = (cell.v !== undefined && cell.v !== null && cell.v !== "") ? cell.v : cell.m;
      if (v === undefined || v === null || v === "") continue;
      map[_rbCellId(r, c)] = v;
    }
  }
  return map;
}
function _rbCellsValueMap() {
  const map = _rbGridValueMap();
  for (const id in _rbCellsData) {
    const cell = _rbCellsData[id];
    map[id] = (cell.value !== undefined && cell.value !== null && cell.value !== "") ? cell.value : cell.raw;
  }
  return map;
}
function _rbSumIfsCtx() {
  return {
    sourcesMap: _rbSourcesMap,
    theday: _rbCurrentTheday(),
    customCategories: _rbTemplateCategories(),
    customSellerCategories: _rbTemplateSellerCategories(),
    customPricelistCategories: _rbTemplatePricelistCategories(),
    cellsValueMap: _rbCellsValueMap(),
  };
}
function _rbTemplateCategories() {
  return (typeof _customCategories !== "undefined" && Array.isArray(_customCategories)) ? _customCategories : [];
}
function _rbTemplateSellerCategories() {
  return (typeof _customSellerCategories !== "undefined" && Array.isArray(_customSellerCategories)) ? _customSellerCategories : [];
}
function _rbTemplatePricelistCategories() {
  return (typeof _customPricelistCategories !== "undefined" && Array.isArray(_customPricelistCategories)) ? _customPricelistCategories : [];
}

// إعادة حساب كل الخلايا التي تعتمد (مباشرة أو غير مباشرة) على خلية تغيّرت
function _rbRecomputeAll() {
  for (const id in _rbCellsData) _rbApplyComputedToGrid(id);
}

// ══════════════════════════════════════════════════════════════
// جلب البيانات الخام الثلاثة (vnt/liv/enc) عبر rpcController لتاريخ
// المعاينة الثابت في المصمم (_RB_BUILDER_FIXED_THEDAY)، بنفس منطق
// _rvFetchSourcesMap في reportViewer.js. كانت _rbSourcesMap تبقى فارغة
// دائمًا (لم تُملأ من قبل) فتظهر كل صيغ SUMIFS كـ 0 — هذا هو ما يملأها فعليًا.
// ══════════════════════════════════════════════════════════════
let _rbSourcesLoaded = false;
async function _rbFetchSourcesMap(theday, lookbackDays = 60) {
  if (typeof rpcController === "undefined" || typeof rpcController.fetchReportRawSources !== "function") {
    console.warn("[luckysheetBuilder] rpcController.fetchReportRawSources غير متوفر");
    return null; // null = فشل حقيقي (يُميَّز عن {vnt:[],liv:[],enc:[]} أي "لا بيانات" فعليًا)
  }
  const baseUrl = (typeof getOdooBase === "function") ? getOdooBase() : "";
  try {
    const map = await rpcController.fetchReportRawSources(baseUrl, theday, lookbackDays);
    console.log("[luckysheetBuilder] بيانات المعاينة لتاريخ", theday, "— vnt:", map?.vnt?.length || 0, "liv:", map?.liv?.length || 0, "enc:", map?.enc?.length || 0);
    return map;
  } catch (e) {
    console.warn("[luckysheetBuilder] فشل جلب البيانات الخام:", e);
    if (typeof addNotif === "function") addNotif("فشل جلب بيانات معاينة القالب: " + e.message, "error");
    return null;
  }
}

// ملاحظة أداء: هذا الجلب لا يُنتظر (await) عند فتح المصمم — كان ذلك يجمّد
// فتح النافذة/تحميل القالب لحين انتهاء read_group الثلاثي (قد يستغرق ثوانٍ
// طويلة). الآن يُطلق في الخلفية فورًا، وبمجرد وصول البيانات تُعاد حسبة كل
// الخلايا تلقائيًا (القيم تنتقل من فارغة/قديمة إلى الأرقام الحقيقية بمجرد
// وصولها، دون تجميد الواجهة).
// ⚠️ إصلاح مهم: كانت _rbSourcesLoaded تُضبط true حتى لو فشل الجلب فعليًا
// (أو لم يكن rpcController/الجلسة جاهزَين بعد وقت فتح المصمم لأول مرة)،
// فلا تُعاد أي محاولة لاحقًا أبدًا طوال الجلسة — يبقى المصمم يعرض 0 دائمًا
// رغم أن نفس البيانات تظهر بشكل صحيح في "المعرض" (reportViewer.js) لأنه
// يُعيد الجلب من جديد في كل مرة. الآن: نُعيد المحاولة في كل فتح للمصمم
// (الجلب غير محظور/non-blocking أصلاً فلا كلفة أداء ملموسة)، ولا نُخزّن
// "تم التحميل" إلا بعد نجاح فعلي.
let _rbSourcesLoadingPromise = null;
function _rbEnsureSourcesLoaded(force = false) {
  if (_rbSourcesLoadingPromise) return _rbSourcesLoadingPromise; // جلب قيد التنفيذ فعلًا، لا تُطلق آخر بالتوازي
  _rbSourcesLoadingPromise = _rbFetchSourcesMap(_rbCurrentTheday())
    .then(map => {
      _rbSourcesLoadingPromise = null;
      if (map === null) return; // فشل حقيقي: لا نستبدل البيانات القديمة، ونسمح بإعادة المحاولة في المرة القادمة
      _rbSourcesMap = map;
      _rbSourcesLoaded = true;
      _rbRecomputeAll();
    });
  return _rbSourcesLoadingPromise;
}

// أبعاد افتراضية للأعمدة/الصفوف — يعتمد عليها reportViewer.js أيضًا لعرض
// التقرير النهائي (كانت معرَّفة سابقًا داخل reportBuilder.js المحذوف)
// يُنسّق قيمة خلية للعرض حسب نوع محتواها المحفوظ (رقم/عملة/نسبة/تاريخ) —
// منقولة كما هي من reportBuilder.js القديم، يعتمد عليها reportViewer.js
function _rbFormatValue(value, format, currencySymbol, decimals) {
  if (!format || format === "text" || value === "" || value == null) return value;
  if (typeof value === "string" && /^#/.test(value)) return value; // أخطاء (#خطأ:...) تُعرض كما هي

  if (format === "number" || format === "currency" || format === "percentage") {
    let n = typeof value === "number" ? value : parseFloat(String(value).replace(",", "."));
    if (isNaN(n)) return value;
    if (format === "percentage") n = n * 100;
    const dec = Number.isInteger(decimals) ? Math.min(6, Math.max(0, decimals)) : 2;
    const formatted = n.toLocaleString("fr-FR", { minimumFractionDigits: dec, maximumFractionDigits: dec })
      .replace(/\u202F/g, "\u00A0");
    if (format === "currency") {
      const sym = (currencySymbol || "").trim();
      return sym ? `${formatted}\u00A0${sym}` : formatted;
    }
    if (format === "percentage") return `${formatted}%`;
    return formatted;
  }

  if (format === "date") {
    let d = null;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      d = new Date(value.slice(0, 10) + "T00:00:00");
    } else if (typeof value === "number") {
      d = new Date(value);
    } else {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) d = parsed;
    }
    if (!d || isNaN(d.getTime())) return value;
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  }

  return value;
}

// يشتق format/decimals/currencySymbol من نمط Luckysheet الأصلي (v.ct.fa)
// — نفس منطق التحليل المستعمل في _rbConvertNativeToLegacy، مستخرج هنا في
// دالة مشتركة لإعادة صياغة m (النص المعروض) بشكل صحيح عند إعادة حساب
// خلايا-الصيغ (انظر _rbApplyComputedToGrid: كانت تكتب String(value) خامًا
// بلا تنسيق، فتُفقَد تنسيقات الأرقام/العملة/النسبة عند كل تحميل قالب).
function _rbFormatByFa(value, fa) {
  if (value == null || value === "") return String(value ?? "");
  if (typeof value === "string" && /^#/.test(value)) return value; // أخطاء
  if (!fa || fa === "General" || fa === "@") return String(value);
  const decMatch = fa.match(/0\.(0+)/);
  const dec = decMatch ? decMatch[1].length : 0;
  if (fa.includes("%")) return _rbFormatValue(value, "percentage", null, dec);
  const symMatch = fa.match(/["']([^"']+)["']/) || fa.match(/([^\d#.,%\s"']+)/);
  if (symMatch && /[^\d#.,\s]/.test(fa.replace(/0+/g, ""))) {
    return _rbFormatValue(value, "currency", symMatch[1], dec);
  }
  if (/[0#]/.test(fa)) return _rbFormatValue(value, "number", null, dec);
  return String(value);
}

const _RB_DEFAULT_COL_WIDTH = 90;
const _RB_DEFAULT_ROW_HEIGHT = 28;

// دوال توليد CSS من كائن التنسيق المحفوظ لكل خلية (_rbStyles[id]) — يعتمد
// عليها reportViewer.js عند رسم التقرير النهائي (منقولة كما هي من
// reportBuilder.js القديم). ملاحظة: مصمم الشبكة الحالي (Luckysheet) لا
// يكتب داخل _rbStyles حاليًا (التنسيق يُدار كليًا من واجهة Luckysheet
// نفسها)، لكن الدوال تبقى ضرورية لأي قالب قديم محفوظ يحتوي بيانات _rbStyles.
function _rbBorderSideCss(prop, side, shadowParts) {
  if (!side) return "";
  const w = (typeof side === "object" && side.w) ? side.w : 1;
  const c = (typeof side === "object" && side.c) ? side.c : "#888";
  const inset = { "border-top": `inset 0 ${w}px 0 0 ${c}`, "border-bottom": `inset 0 -${w}px 0 0 ${c}`,
                   "border-left": `inset ${w}px 0 0 0 ${c}`, "border-right": `inset -${w}px 0 0 0 ${c}` }[prop];
  if (inset) shadowParts.push(inset);
  return `${prop}:${w}px solid ${c};`;
}
function _rbBorderCss(border) {
  if (!border) return "";
  if (border === "none") {
    return ["border-top", "border-right", "border-bottom", "border-left"]
      .map(p => `${p}:none;`).join("");
  }
  if (border === "all") {
    return ["border-top", "border-right", "border-bottom", "border-left"]
      .map(p => `${p}:1px solid #888;`).join("") + `box-shadow:inset 0 1px 0 0 #888,inset -1px 0 0 0 #888,inset 0 -1px 0 0 #888,inset 1px 0 0 0 #888;`;
  }
  if (border === "bottom") return `border-bottom:1px solid #888;box-shadow:inset 0 -1px 0 0 #888;`;
  if (typeof border === "object") {
    const shadowParts = [];
    const css = _rbBorderSideCss("border-top", border.t, shadowParts)
      + _rbBorderSideCss("border-right", border.r, shadowParts)
      + _rbBorderSideCss("border-bottom", border.b, shadowParts)
      + _rbBorderSideCss("border-left", border.l, shadowParts);
    // box-shadow: inset احتياطي إضافي — html2canvas (النسخ/التحميل كصورة)
    // لا يرسم border على <td> بموثوقية، لكنه يرسم box-shadow بشكل صحيح.
    // نُبقي border الحقيقي أيضًا للعرض العادي في المتصفح.
    return css + (shadowParts.length ? `box-shadow:${shadowParts.join(",")};` : "");
  }
  return "";
}
function _rbStyleCss(style) {
  if (!style) return "";
  let s = "";
  if (style.bg) s += `background:${style.bg};`;
  if (style.bold) s += `font-weight:700;`;
  if (style.italic) s += `font-style:italic;`;
  if (style.underline) s += `text-decoration:underline;`;
  if (style.color) s += `color:${style.color};`;
  if (style.fontSize) s += `font-size:${style.fontSize}px;`;
  if (style.fontFamily) s += `font-family:${style.fontFamily};`;
  const align = style.textAlign || "left";
  s += `text-align:${align};`;
  s += `font-variant-numeric:tabular-nums;direction:ltr;unicode-bidi:plaintext;white-space:nowrap;`;
  if (align === "right") s += `padding-right:6px;`;
  else if (align === "left") s += `padding-left:6px;`;
  const va = style.verticalAlign || "middle";
  s += `vertical-align:${va};`;
  if (style.wrap) s += `white-space:normal;word-wrap:break-word;overflow-wrap:break-word;`;
  // تدوير/تكديس النص — يُطبَّق بعد الأساسيات لأن بعض الحالات (التكديس
  // العمودي تحديدًا) تحتاج تجاوز white-space:nowrap المضبوط أعلاه، وإلا
  // ينحصر عرض الخلية على حرف واحد فقط قبل أن يُقصّ الباقي.
  if (style.textRotate === "vertical") {
    // تكديس عمودي: كل حرف بسطر منفصل، بلا إمالة للحروف نفسها (كما في
    // الكتابة العمودية لشرق آسيا) — هذا هو التطابق الأدق لخيار Luckysheet.
    s += `writing-mode:vertical-rl;text-orientation:upright;white-space:normal;letter-spacing:0;text-align:center;`;
  } else if (style.textRotate === "angleup") {
    s += `transform:rotate(-45deg);transform-origin:center;display:inline-block;`;
  } else if (style.textRotate === "angledown") {
    s += `transform:rotate(45deg);transform-origin:center;display:inline-block;`;
  } else if (style.textRotate === "rotationUp") {
    s += `writing-mode:vertical-rl;transform:rotate(180deg);text-orientation:mixed;`;
  } else if (style.textRotate === "rotationDown") {
    s += `writing-mode:vertical-rl;text-orientation:mixed;`;
  }
  s += _rbBorderCss(style.border);
  return s;
}

// يكتب القيمة المحسوبة لخلية واحدة داخل Luckysheet (نص/رقم عرض فقط، بلا صيغة حقيقية).
// لا نعيد الكتابة إلا للخلايا التي تحتوي فعلًا صيغة (raw يبدأ بـ"=") لأن هذه
// فقط تحتاج استبدال المعروض (raw الصيغة) بالقيمة المحسوبة؛ الخلايا العادية
// (قيمة مكتوبة يدويًا) تبقى كما كتبها المستخدم في Luckysheet أصلًا، فلا داعي
// لإعادة كتابتها — وهذا يتفادى أي احتمال حلقة تحديث (Luckysheet يُطلق حدث
// cellUpdated بشكل غير متزامن أحيانًا، فعلامة إيقاف متزامنة بسيطة لا تكفي).
function _rbApplyComputedToGrid(id) {
  const cell = _rbCellsData[id];
  if (!cell) return;
  const p = _rbParseCellId(id);
  if (!p) return;
  const computed = _rbComputeCell(cell.raw);
  cell.value = computed.value;
  cell.error = computed.error || null;
  const isFormula = typeof cell.raw === "string" && cell.raw.trim().startsWith("=");
  if (!isFormula) return; // القيمة المعروضة في Luckysheet مطابقة أصلًا، لا حاجة لإعادة الكتابة
  if (typeof luckysheet === "undefined" || !_rbLuckysheetReady) return;
  _rbSelfWriteCells.add(id);
  try {
    // ⚠️ getCellValue({type:"obj"}) غير مضمون في Luckysheet 2.1.13 (قد
    // يرجع قيمة خام فقط بلا تنسيق). نقرأ كائن الخلية الحقيقي مباشرة من
    // flowdata() — نفس المصدر المؤكد عمله في _rbCaptureNativeSheet —
    // وندمج القيمة الجديدة داخله بدل استبدال الخلية بالكامل، فلا يُمحى
    // تنسيقها (bg/fc/bl/...).
    let existing = null;
    try {
      const flow = luckysheet.flowdata();
      existing = (flow && flow[p.row] && flow[p.row][p.col]) ? flow[p.row][p.col] : null;
    } catch (e2) { existing = null; }
    // ⚠️ لا نكتب f (حقل الصيغة الحقيقي) — تجربة سابقة أثبتت أنها تُدخل
    // Luckysheet في حلقة إعادة حساب/تحديث ثقيلة جدًا (تجميد كامل للتطبيق)
    // لأنها لا تفهم دوالنا المخصصة (SUMIFS/liv/vnt) فتحاول تقييمها بنفسها
    // باستمرار. نكتفي بـv/m (القيمة المعروضة فقط)، والصيغة الحقيقية تبقى
    // محفوظة فقط داخل _rbCellsData[id].raw (خارج Luckysheet كليًا).
    // ⚠️ كنا نكتب m = String(computed.value) خامًا بلا أي تنسيق، فتُفقَد
    // تنسيقات الأرقام/العملة/النسبة المحفوظة (ct.fa) في كل خلية-صيغة عند
    // كل إعادة حساب — وهذا يحدث بالضبط عند تحميل القالب (rbLoadTemplate
    // تستدعي _rbRecomputeAll() مباشرة بعد التهيئة). نستعمل ct.fa الحالي
    // (يبقى محفوظًا داخل existing) لصياغة m بشكل صحيح بدل الخام.
    const fa = existing && existing.ct && existing.ct.fa;
    // ⚠️ نُضمّن الصيغة الخام (raw) أيضًا داخل خاصية مخصّصة على الخلية نفسها
    // (qkf — ليست f الحقيقية، فلا تُشغّل محرك صيغ Luckysheet كما هو موثّق
    // أعلاه). الفائدة: عند حذف/إدراج صف أو عمود من واجهة Luckysheet مباشرة
    // (لا يوجد hook متاح في هذا الإصدار لالتقاط هذه العملية بشكل مباشر)،
    // Luckysheet ينقل كائن الخلية v بكامل خصائصه (وقيمة qkf معه) مع الخلية
    // إلى موضعها الجديد تلقائيًا — فتبقى صيغتنا مرتبطة بالخلية الصحيحة دون
    // الحاجة لأي إعادة ربط يدوي. مصدر الحقيقة عند الحفظ يصبح qkf المُضمَّن
    // في الشبكة الحية نفسها (انظر _rbDslCellsFromNative) بدل _rbCellsData
    // الخارجي وحده، الذي كان يبقى في مواضعه القديمة عند أي حذف/إدراج فيسبب
    // فقدان الصيغ الفعلي (يظهر وكأن "الحذف يمسح المحتوى بدل الأعمدة").
    const merged = Object.assign({}, existing || {}, { v: computed.value, m: _rbFormatByFa(computed.value, fa), qkf: cell.raw });
    luckysheet.setCellValue(p.row, p.col, merged, { isRefresh: true });
  } catch (e) { _rbSelfWriteCells.delete(id); }
}

// ══════════════════════════════════════════════════════════════
// commit — يُستدعى من formulaWizard.js (_fwApply) عند تطبيق الصيغة
// المُنشأة تفاعليًا على خلية، وأيضًا من hook التعديل اليدوي داخل Luckysheet.
// ══════════════════════════════════════════════════════════════
function _rbCommitCellFormula(id, raw) {
  _rbCellsData[id] = _rbCellsData[id] || {};
  _rbCellsData[id].raw = raw;
  _rbApplyComputedToGrid(id);
}

// ══════════════════════════════════════════════════════════════
// تهيئة/تدمير Luckysheet داخل #rbLuckysheet، وربط hook التعديل + التحديد
// ══════════════════════════════════════════════════════════════
let _rbLuckysheetReady = false;

function _rbBuildLuckysheetData(nativeSheet) {
  if (nativeSheet) {
    // ورقة Luckysheet أصلية محفوظة مسبقًا (تحمل كل التنسيقات: ألوان، عريض،
    // دمج، عرض/ارتفاع الأعمدة والصفوف...) — نستعملها كما هي مباشرة.
    // تشخيص مؤقت: هل التنسيق فعلاً موجود باللحظة اللي بنسلّمها لـ create()؟
    console.log("[luckysheetBuilder][LOAD] nativeSheet.celldata (أول 3 خلايا):",
      JSON.stringify((nativeSheet.celldata || []).slice(0, 3), null, 2));
    console.log("[luckysheetBuilder][LOAD] nativeSheet.config:",
      JSON.stringify(nativeSheet.config || {}, null, 2));
    return [{ ...nativeSheet, name: "Sheet1", status: 1, order: 0 }];
  }
  const celldata = [];
  for (const id in _rbCellsData) {
    const p = _rbParseCellId(id);
    if (!p) continue;
    const cell = _rbCellsData[id];
    celldata.push({ r: p.row, c: p.col, v: { v: cell.value ?? "", m: String(cell.value ?? "") } });
  }
  return [{
    name: "Sheet1",
    status: 1,
    order: 0,
    row: Math.max(_rbRows, 30),
    column: Math.max(_rbCols, 20),
    celldata,
    config: {},
  }];
}

// يلتقط ورقة Luckysheet الحالية بكل تنسيقاتها (ألوان/عريض/دمج/أبعاد...) —
// يُستدعى قبل كل حفظ ليُحفظ ضمن القالب (انظر _rbSaveTemplatePayload)
// يحذف أي "مصفوفة داخل مصفوفة" بشكل عام (وليس فقط data) لأن Firestore
// يرفض أي بنية كهذه أينما وُجدت — احترازيًا لأي حقل آخر (صور/رسوم بيانية..)
// قد يحتوي بنية مشابهة لا نعرفها مسبقًا.
function _rbStripNestedArrays(node) {
  if (Array.isArray(node)) {
    if (node.some(Array.isArray)) return null; // مصفوفة تحوي مصفوفة مباشرة -> نحذفها بالكامل
    return node.map(_rbStripNestedArrays);
  }
  if (node && typeof node === "object") {
    const out = {};
    for (const k in node) {
      const cleaned = _rbStripNestedArrays(node[k]);
      if (cleaned !== null || node[k] === null) out[k] = cleaned;
    }
    return out;
  }
  return node;
}

// يُحوّل ورقة Luckysheet الأصلية (celldata + config) إلى الصيغة القديمة
// (تنسيق لكل خلية + قائمة دمج) التي يعتمد عليها reportViewer.js — بحيث
// يبقى ملف reportViewer.js دون أي تعديل، ونحصل على تنسيق مطابق فيه.
function _rbHtToTextAlign(ht) {
  // ⚠️ Luckysheet 2.1.13 يكتب ht كسلسلة نصية "0"/"1"/"2" عند الضبط عبر
  // شريط الأدوات (داخل updateFormatCell: a="1"/a="0"/a="2")، وليس كرقم JS —
  // لذا يجب التسامح مع النوعين (رقم أو نص) بدل مقارنة === الصارمة.
  const v = String(ht).trim();
  if (v === "1") return "left";
  if (v === "2") return "right";
  return "center"; // "0" أو أي قيمة أخرى = الافتراضي
}
function _rbVtToVerticalAlign(vt) {
  const v = String(vt).trim();
  if (v === "1") return "top";
  if (v === "2") return "bottom";
  return "middle";
}
function _rbConvertNativeToLegacy(nativeSheet) {
  const styles = {};
  const merges = [];
  const colWidths = {};
  const rowHeights = {};
  if (!nativeSheet) return { styles, merges, colWidths, rowHeights };

  // ⚠️ النطاق المُستخدم فعليًا (كما يفعل إكسل) — أي خلية تحمل محتوى أو
  // تنسيقًا حقيقيًا تُوسّع هذا الحد. أي شيء خارجه (مثل تحديد صف/عمود كامل
  // عند تطبيق حدود) يُقصّ ولا يُخزَّن كخلايا وهمية.
  let usedMaxRow = 0, usedMaxCol = 0;
  for (const cell of (nativeSheet.celldata || [])) {
    if (cell.r > usedMaxRow) usedMaxRow = cell.r;
    if (cell.c > usedMaxCol) usedMaxCol = cell.c;
  }

  for (const cell of (nativeSheet.celldata || [])) {
    const v = cell && cell.v;
    if (!v || typeof v !== "object") continue;
    const id = _rbCellId(cell.r, cell.c);
    const st = {};
    if (v.bg) st.bg = v.bg;
    if (v.bl === 1) st.bold = true;
    if (v.it === 1) st.italic = true;
    if (v.un === 1) st.underline = true;
    if (v.fc) st.color = v.fc;
    if (v.fs) st.fontSize = v.fs;
    if (v.ht != null) st.textAlign = _rbHtToTextAlign(v.ht);
    if (v.vt != null) st.verticalAlign = _rbVtToVerticalAlign(v.vt);
    if (v.tb === "2") st.wrap = true;
    // تدوير النص (tr): Luckysheet يخزّن "0"=بدون، "1"=إمالة لأعلى،
    // "2"=إمالة لأسفل، "3"=تكديس عمودي (كل حرف بسطر منفصل)، "4"=تدوير
    // 90° لأعلى، "5"=تدوير 90° لأسفل. لم تكن مُلتقَطة إطلاقًا سابقًا،
    // فكانت خيارات التدوير (وخصوصًا "تكديس عمودي") تُفقد كليًا في عارض
    // التقارير وتظهر كنص أفقي عادي مقصوص (حرف واحد فقط ظاهر بسبب اصطدام
    // النص الطويل بارتفاع/عرض الخلية الثابتين دون أي تنسيق تدوير يعوّضه).
    if (v.tr != null && String(v.tr) !== "0") {
      const trMap = { "1": "angleup", "2": "angledown", "3": "vertical", "4": "rotationUp", "5": "rotationDown" };
      const mapped = trMap[String(v.tr)];
      if (mapped) st.textRotate = mapped;
    }
    // تنسيق الأرقام/العملة/النسبة: Luckysheet يخزّنه في v.ct.fa (نمط رقمي
    // مثل "0.00%" أو "#,##0.00" أو "\"$\"#,##0.00")، بينما _rbFormatValue
    // (المستعملة في المعرض) تحتاج format/decimals/currencySymbol بصيغتنا
    // القديمة — نستنتجها هنا من النمط الأصلي.
    const fa = v.ct && v.ct.fa;
    if (fa && fa !== "General" && fa !== "@") {
      const decMatch = fa.match(/0\.(0+)/);
      const dec = decMatch ? decMatch[1].length : 0;
      if (fa.includes("%")) {
        st.format = "percentage"; st.decimals = dec;
      } else {
        const symMatch = fa.match(/["']([^"']+)["']/) || fa.match(/([^\d#.,%\s"']+)/);
        if (symMatch && /[^\d#.,\s]/.test(fa.replace(/0+/g, ""))) {
          st.format = "currency"; st.currencySymbol = symMatch[1]; st.decimals = dec;
        } else if (/[0#]/.test(fa)) {
          st.format = "number"; st.decimals = dec;
        }
      }
    }
    if (Object.keys(st).length) styles[id] = st;
  }

  const mergeCfg = (nativeSheet.config && nativeSheet.config.merge) || {};
  for (const key in mergeCfg) {
    const m = mergeCfg[key];
    if (!m) continue;
    merges.push({
      start: _rbCellId(m.r, m.c),
      end: _rbCellId(m.r + (m.rs || 1) - 1, m.c + (m.cs || 1) - 1),
    });
  }

  // borderInfo: تنسيق Luckysheet 2.1.13 الفعلي — كل عنصر عنده borderType
  // ("border-all"/"border-outside"/"border-top"/... ) يُطبَّق على range
  // (مصفوفة {row:[r1,r2], column:[c1,c2]}). نحوّلها لعلم بسيط لكل ضلع
  // (t/r/b/l) لكل خلية متأثرة، حسب موضعها داخل النطاق (حافة/داخل).
  const borderInfo = (nativeSheet.config && nativeSheet.config.borderInfo) || [];
  // كود نمط الخط الرقمي (Luckysheet style: 0..13) → عرض تقريبي بالبكسل؛
  // 2/3/8/9/11 هي الأنماط "الغليظة" في Luckysheet.
  const _rbBorderWidthFromStyle = (styleCode) => {
    const thick = new Set([2, 3, 8, 9, 11, 12, 13]);
    return thick.has(Number(styleCode)) ? 2 : 1;
  };
  const addBorderSide = (r, c, side, color, width) => {
    const id = _rbCellId(r, c);
    if (!styles[id]) styles[id] = {};
    if (!styles[id].border || typeof styles[id].border !== "object") styles[id].border = {};
    styles[id].border[side] = { c: color || "#000000", w: width || 1 };
  };
  for (const entry of (Array.isArray(borderInfo) ? borderInfo : [])) {
    if (!entry) continue;
    const type = entry.borderType || "border-all";
    const bColor = entry.color || "#000000";
    const bWidth = _rbBorderWidthFromStyle(entry.style);
    for (const rg of (entry.range || [])) {
      let [r1, r2] = rg.row || [0, 0];
      let [c1, c2] = rg.column || [0, 0];
      // ⚠️ تحديد صف/عمود كامل (Luckysheet يعطي نطاقًا ضخمًا وهميًا هنا) —
      // نقصّه على النطاق المُستخدم فعليًا بدل توليد ملايين الخلايا الوهمية.
      r2 = Math.min(r2, usedMaxRow);
      c2 = Math.min(c2, usedMaxCol);
      if (r1 > r2 || c1 > c2) continue;
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          const isTopEdge = r === r1, isBottomEdge = r === r2;
          const isLeftEdge = c === c1, isRightEdge = c === c2;
          if (type === "border-all") {
            addBorderSide(r, c, "t", bColor, bWidth); addBorderSide(r, c, "b", bColor, bWidth);
            addBorderSide(r, c, "l", bColor, bWidth); addBorderSide(r, c, "r", bColor, bWidth);
          } else if (type === "border-outside") {
            if (isTopEdge) addBorderSide(r, c, "t", bColor, bWidth);
            if (isBottomEdge) addBorderSide(r, c, "b", bColor, bWidth);
            if (isLeftEdge) addBorderSide(r, c, "l", bColor, bWidth);
            if (isRightEdge) addBorderSide(r, c, "r", bColor, bWidth);
          } else if (type === "border-inside") {
            if (!isTopEdge) addBorderSide(r, c, "t", bColor, bWidth);
            if (!isBottomEdge) addBorderSide(r, c, "b", bColor, bWidth);
            if (!isLeftEdge) addBorderSide(r, c, "l", bColor, bWidth);
            if (!isRightEdge) addBorderSide(r, c, "r", bColor, bWidth);
          } else if (type === "border-horizontal") {
            if (!isTopEdge) addBorderSide(r, c, "t", bColor, bWidth);
            if (!isBottomEdge) addBorderSide(r, c, "b", bColor, bWidth);
          } else if (type === "border-vertical") {
            if (!isLeftEdge) addBorderSide(r, c, "l", bColor, bWidth);
            if (!isRightEdge) addBorderSide(r, c, "r", bColor, bWidth);
          } else if (type === "border-top") { if (isTopEdge) addBorderSide(r, c, "t", bColor, bWidth); }
          else if (type === "border-bottom") { if (isBottomEdge) addBorderSide(r, c, "b", bColor, bWidth); }
          else if (type === "border-left") { if (isLeftEdge) addBorderSide(r, c, "l", bColor, bWidth); }
          else if (type === "border-right") { if (isRightEdge) addBorderSide(r, c, "r", bColor, bWidth); }
          else if (type === "border-none") {
            if (styles[_rbCellId(r, c)]) delete styles[_rbCellId(r, c)].border;
          } else {
            // نوع غير معروف — نطبّق حدًا كاملاً احتياطًا بدل تجاهله بصمت
            addBorderSide(r, c, "t", bColor, bWidth); addBorderSide(r, c, "b", bColor, bWidth);
            addBorderSide(r, c, "l", bColor, bWidth); addBorderSide(r, c, "r", bColor, bWidth);
          }
        }
      }
    }
  }

  const colLen = (nativeSheet.config && nativeSheet.config.columnlen) || {};
  for (const c in colLen) colWidths[c] = colLen[c];
  const rowLen = (nativeSheet.config && nativeSheet.config.rowlen) || {};
  for (const r in rowLen) rowHeights[r] = rowLen[r];

  return { styles, merges, colWidths, rowHeights };
}

function _rbCaptureNativeSheet() {
  if (typeof luckysheet === "undefined" || !_rbLuckysheetReady) return null;
  try {
    // ⚠️ getAllSheets() لا يُحدّث config (merge/borderInfo..) فورًا بعد
    // عمليات الدمج/الحدود بنفس الجلسة (مشكلة معروفة بالمكتبة) — بعكس
    // getluckysheetfile() التي ترجع الحالة الحية الكاملة دائمًا.
    const sheets = (typeof luckysheet.getluckysheetfile === "function")
      ? luckysheet.getluckysheetfile()
      : luckysheet.getAllSheets();
    if (!sheets || !sheets[0]) return null;
    const sheet = JSON.parse(JSON.stringify(sheets[0]));
    // ⚠️ حتى getluckysheetfile() قد لا يعكس فورًا بعض تعديلات config التي
    // تمت بنفس الجلسة (نفس مشكلة merge/borderInfo أعلاه) — ومنها تحديدًا
    // rowhidden/colhidden (إخفاء صف/عمود عبر كليك يمين -> "إخفاء" لا يظهر
    // أثره أحيانًا هنا رغم نجاحه فعليًا في واجهة Luckysheet نفسها). توثيق
    // المكتبة يوصي صراحة باستعمال luckysheet.getConfig() كمصدر حيّ دائمًا
    // محدَّث لإعدادات الورقة الحالية (merge/rowhidden/colhidden/borderInfo/
    // rowlen/columnlen..) بدل الاعتماد فقط على config المُرفَق ضمن
    // getluckysheetfile() — نستعملها هنا لتطغى فوقه كلما توفرت.
    if (typeof luckysheet.getConfig === "function") {
      try {
        const liveConfig = luckysheet.getConfig();
        if (liveConfig && typeof liveConfig === "object") {
          sheet.config = JSON.parse(JSON.stringify(liveConfig));
        }
      } catch (e) { /* نتجاهل ونكتفي بـ config الملتقط أعلاه */ }
    }
    // ⚠️ بعد التهيئة الأولى، Luckysheet يخزّن كل التعديلات الفعلية (قيم +
    // تنسيق) داخل الشبكة الحية (data)، بينما celldata من getAllSheets()
    // تبقى كما كانت عند أول تحميل فقط ولا تتحدث، وأحيانًا sheet.data من
    // getAllSheets() لا يرجع أصلاً. لذلك نلتقط الشبكة الحية مباشرة عبر
    // luckysheet.flowdata() (تُرجع دائمًا كل التنسيقات الحالية)، ثم نحوّلها
    // إلى celldata مسطّحة بأنفسنا هنا (تطغى على celldata القديمة) قبل حذف
    // data، لأن Firestore يرفض المصفوفات المتداخلة (مصفوفة داخل مصفوفة).
    const liveData = (typeof luckysheet.flowdata === "function") ? luckysheet.flowdata() : sheet.data;
    if (Array.isArray(liveData)) {
      const flat = [];
      for (let r = 0; r < liveData.length; r++) {
        const row = liveData[r];
        if (!Array.isArray(row)) continue;
        for (let c = 0; c < row.length; c++) {
          const v = row[c];
          if (v == null) continue;
          flat.push({ r, c, v });
        }
      }
      sheet.celldata = flat;
    }
    delete sheet.data;
    return _rbStripNestedArrays(sheet);
  } catch (e) {
    console.warn("[luckysheetBuilder] تعذّر التقاط تنسيق الورقة:", e);
    return null;
  }
}

function _rbDestroyHot() {
  try { if (typeof luckysheet !== "undefined" && _rbLuckysheetReady) luckysheet.destroy(); } catch (e) { /* تجاهل */ }
  _rbLuckysheetReady = false;
}

function _rbInitLuckysheet(nativeSheet) {
  _rbDestroyHot();
  if (typeof luckysheet === "undefined") {
    addNotif("تعذّر تحميل مكتبة Luckysheet (تحقق من الاتصال بالإنترنت)", "error");
    return;
  }
  luckysheet.create({
    container: "rbLuckysheet",
    lang: "en",
    showtoolbarConfig: { chart: false, image: false, print: false },
    showsheetbarConfig: { add: false, sheet: false },
    data: _rbBuildLuckysheetData(nativeSheet),
    hook: {
      cellUpdated: function (r, c, oldVal, newVal) {
        const id = _rbCellId(r, c);
        if (_rbSelfWriteCells.has(id)) { _rbSelfWriteCells.delete(id); return; }
        const raw = (newVal && typeof newVal === "object") ? (newVal.f || newVal.v) : newVal;
        if (raw == null || raw === "") {
          delete _rbCellsData[id];
          // ننظّف أي qkf (صيغة DSL سابقة) متبقٍّ فعليًا على الخلية بعد
          // المسح، وإلا يُعاد "بعثها" لاحقًا كخلية-شبح عند اشتقاق الصيغ من
          // الشبكة الحية وقت الحفظ (_rbDslCellsFromNative) رغم أن المستخدم
          // مسحها بالفعل. نقرأ الكائن الحي الحالي (بعد مسح Luckysheet
          // لمحتواه) ونُبقي كل خصائصه (تنسيق/حدود..) عدا qkf فقط.
          try {
            const flow = (typeof luckysheet.flowdata === "function") ? luckysheet.flowdata() : null;
            const existing = (flow && flow[r] && flow[r][c]) ? flow[r][c] : null;
            if (existing && existing.qkf) {
              _rbSelfWriteCells.add(id);
              const rest = { ...existing };
              delete rest.qkf;
              luckysheet.setCellValue(r, c, rest, { isRefresh: true });
            }
          } catch (e) { /* تجاهل */ }
          return;
        }
        _rbCommitCellFormula(id, String(raw));
      },
      rangeSelect: function (sheet, range) {
        _rbShowFxForSelection(range);
      },
    },
  });
  _rbLuckysheetReady = true;
}

// ══════════════════════════════════════════════════════════════
// "نسخ الصيغة للنطاق المحدد" — بديل آمن لمقبض التعبئة (fill handle) ديال
// Luckysheet (كتابة f الحقيقي جربناها وسبّبت تجميد كامل للتطبيق). نأخذ صيغة
// الخلية الأولى (أعلى-يسار) بالنطاق المحدد حاليًا، ونطبّقها على باقي خلايا
// نفس النطاق مع إزاحة المراجع تلقائيًا (shiftRefsForFill)، كليًا خارج
// Luckysheet — فقط عبر _rbCellsData + _rbCommitCellFormula.
// ══════════════════════════════════════════════════════════════
function rbFillFormulaToSelection() {
  if (typeof luckysheet === "undefined" || !_rbLuckysheetReady) return;
  let range;
  try { range = luckysheet.getRange(); } catch (e) { range = null; }
  if (!range || !range.length) { addNotif("حدّد نطاق خلايا أولاً (يشمل الخلية التي تحوي الصيغة)", "warning"); return; }
  const r1 = range[0].row[0], r2 = range[0].row[1];
  const c1 = range[0].column[0], c2 = range[0].column[1];
  if (r1 === r2 && c1 === c2) { addNotif("حدّد نطاقًا أكبر من خلية واحدة", "warning"); return; }
  // نبحث عن الخلية المصدر (التي تحوي صيغة) داخل النطاق المحدد — بأي اتجاه:
  // فوق/تحت/يمين/يسار، بدل افتراض أنها دائمًا أعلى-يسار النطاق. إذا وُجدت
  // أكثر من خلية بصيغة، نأخذ الأولى (الأعلى فالأيسر) وننبّه لذلك.
  let sourceR = null, sourceC = null, sourceRaw = null, foundCount = 0;
  for (let rr = r1; rr <= r2; rr++) {
    for (let cc = c1; cc <= c2; cc++) {
      const cell = _rbCellsData[_rbCellId(rr, cc)];
      const raw = cell && typeof cell.raw === "string" && cell.raw.trim().startsWith("=") ? cell.raw : null;
      if (raw) {
        foundCount++;
        if (sourceRaw == null) { sourceR = rr; sourceC = cc; sourceRaw = raw; }
      }
    }
  }
  if (!sourceRaw) { addNotif("لا توجد خلية بصيغة (تبدأ بـ=) داخل النطاق المحدد", "warning"); return; }
  if (foundCount > 1) addNotif(`وُجدت ${foundCount} خلايا بصيغ — سيتم استعمال أول واحدة فقط كمصدر`, "warning");
  let count = 0;
  for (let rr = r1; rr <= r2; rr++) {
    for (let cc = c1; cc <= c2; cc++) {
      if (rr === sourceR && cc === sourceC) continue; // الخلية المصدر نفسها
      const targetId = _rbCellId(rr, cc);
      const shifted = (typeof FormulaReferenceEngine !== "undefined")
        ? FormulaReferenceEngine.shiftRefsForFill(sourceRaw, rr - sourceR, cc - sourceC)
        : sourceRaw;
      _rbCommitCellFormula(targetId, shifted);
      count++;
    }
  }
  addNotif(`تم نسخ الصيغة إلى ${count} خلية`, "success");
}

// يعرض زر "fx" (من formulaWizard.js) فوق الخلية النشطة الحالية عبر عنصر
// وهمي (بدائل getBoundingClientRect: offsetTop/offsetLeft/offsetWidth
// نسبةً لـ#rbGridWrap، وهو نفس الحاوية الأب الذي كان reportBuilder.js
// يستعمله سابقًا)
function _rbShowFxForSelection(range) {
  if (typeof _fwShowButton !== "function") return;
  if (!range || !range.length) return;
  const r0 = range[0].row[0], c0 = range[0].column[0];
  if (r0 == null || c0 == null) return;
  const id = _rbCellId(r0, c0);
  // Luckysheet يطلق rangeSelect قبل رسم عنصر التحديد فعليًا في الـDOM أحيانًا
  // (سباق توقيت) — تأخير دورة واحدة (setTimeout 0) يضمن العثور عليه.
  setTimeout(() => {
    const selEl = document.querySelector("#rbLuckysheet .luckysheet-cell-selected-focus, #rbLuckysheet .luckysheet-cell-selected");
    const wrap = document.getElementById("rbGridWrap");
    if (!selEl || !wrap) return;
    const wrapRect = wrap.getBoundingClientRect();
    const selRect = selEl.getBoundingClientRect();
    const fakeTd = {
      offsetTop: selRect.top - wrapRect.top + wrap.scrollTop,
      offsetLeft: selRect.left - wrapRect.left + wrap.scrollLeft,
      offsetWidth: selRect.width,
    };
    _fwShowButton(fakeTd, id);
  }, 0);
}

// ══════════════════════════════════════════════════════════════
// حفظ/تحميل القوالب — بنفس شكل الحفظ القديم تمامًا (توافق كامل مع
// routes/sync.js وreportViewer.js دون أي تعديل هناك)
// ══════════════════════════════════════════════════════════════
async function _rbFetchTemplates() {
  try {
    const r = await fetch("/api/sync/custom-report-templates", { method: "GET", credentials: "include" });
    if (!r.ok) return [];
    const data = await r.json();
    return data?.templates || [];
  } catch (e) {
    console.warn("[luckysheetBuilder] fetch templates failed:", e);
    return [];
  }
}

function _rbRenderTemplateSelect() {
  const sel = document.getElementById("rbTemplateSelect");
  if (!sel) return;
  sel.innerHTML = `<option value="">— تحميل قالب محفوظ —</option>` +
    _rbTemplates.map(t => `<option value="${t.id}"${t.id === _rbCurrentTemplateId ? " selected" : ""}>${escHtml(t.name)}</option>`).join("");
}

function _rbUpdateSaveButtonState() {
  // لا حاجة لتعطيل/إخفاء الزر: rbSaveTemplate() يتحول تلقائيًا لحفظ
  // باسم إذا لم يوجد قالب محمّل بعد — إبقاؤه معطّلاً كان يسبب ضغطات
  // بلا أي أثر (بدون أي خطأ ظاهر في الـ Console) دون سبب واضح للمستخدم.
  const btn = document.getElementById("btnRbSave");
  if (!btn) return;
  btn.disabled = false;
  btn.style.display = "";
}

function rbLoadTemplate(id) {
  const t = _rbTemplates.find(x => x.id === id);
  if (!t) return;
  _rbCurrentTemplateId = id;
  _rbRows = t.rows || 20;
  _rbCols = t.cols || 12;
  _rbCellsData = t.cellsData ? migrateCellsDataFormulas(JSON.parse(JSON.stringify(t.cellsData))) : {};
  _rbMerges = t.merges ? JSON.parse(JSON.stringify(t.merges)) : [];
  _rbHiddenRows = new Set(Array.isArray(t.hiddenRows) ? t.hiddenRows : []);
  _rbHiddenCols = new Set(Array.isArray(t.hiddenCols) ? t.hiddenCols : []);
  _rbColWidths = t.colWidths ? JSON.parse(JSON.stringify(t.colWidths)) : {};
  _rbRowHeights = t.rowHeights ? JSON.parse(JSON.stringify(t.rowHeights)) : {};
  _rbFreezeRow = !!t.freezeRow;
  _rbFreezeCol = !!t.freezeCol;
  _rbHideGridlines = !!t.hideGridlines;
  // نُفضّل نسخة Luckysheet الأصلية المحفوظة (تحمل كل التنسيقات: ألوان،
  // عريض، دمج، أبعاد...) إن وُجدت — محفوظة سابقًا داخل styles.__luckysheetNative
  // (انظر _rbSaveTemplatePayload). القوالب القديمة (قبل هذا التحديث) لا
  // تملكها، فتُبنى الشبكة من _rbCellsData فقط (بلا تنسيق) كما كان سابقًا.
  const nativeSheet = t.luckysheetNative ? _rbExpandNativeSheet(t.luckysheetNative) : null;
  // تشخيص مؤقت: هل t.luckysheetNative وصل أصلاً من _rbTemplates (الكاش المحلي)؟
  console.log("[luckysheetBuilder][LOAD-RAW] t.luckysheetNative:", t.luckysheetNative);
  console.log("[luckysheetBuilder][LOAD-RAW] t keys:", Object.keys(t));
  _rbUpdateSaveButtonState();
  _rbInitLuckysheet(nativeSheet);
  // إعادة حساب قيم الخلايا-الصيغة فقط (SUMIFS/SUM..) لأنها تعتمد على بيانات
  // قد تكون تغيّرت منذ آخر حفظ؛ الخلايا العادية تبقى كما في الورقة الأصلية
  _rbRecomputeAll();
  addNotif(`تم تحميل القالب "${t.name}" ✓`, "success");
}

// ══════════════════════════════════════════════════════════════
// استخراج محتوى الخلايا (نص/رقم/صيغة Excel عادية) من نسخة Luckysheet
// الحية — احتياطي لـ _rbCellsData: تلك تُملأ فقط عبر hook cellUpdated
// (كتابة يدوية خلية-بخلية)، فأي محتوى وصل بطرق أخرى (لصق جماعي، أو خلايا
// كانت موجودة أصلاً في ورقة مستوردة قبل ربط الـhook) يبقى غائبًا عن
// cellsData ولا يظهر عند العارض رغم ظهوره في المصمم. هنا نلتقطه من
// نسخة Luckysheet الحية نفسها كمصدر حقيقة إضافي عند الحفظ.
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// جدول أنماط مشترك (شبيه بـ styles.xml في xlsx) — بدل تكرار كائن التنسيق
// الكامل (bg/fc/ff/fs/bl/it/un/ht/vt/tb/ct..) داخل كل خلية على حدة، يُستخرج
// الجزء المتعلق بالتنسيق فقط (وليس المحتوى v/m/f/mc) إلى جدول واحد، وتشير
// كل خلية لرقم النمط (s) بدل تكراره — يقلّص حجم luckysheetNative المحفوظ
// بشكل كبير في الأوراق التي تحوي تنسيقًا متكررًا (صفوف/أعمدة ملوّنة..).
// يُطبَّق فقط على النسخة المُرسَلة للحفظ؛ بقية الكود (legacy، cellsData..)
// يعمل دائمًا على النسخة الكاملة غير المضغوطة قبل هذا التحويل.
// ══════════════════════════════════════════════════════════════
const _RB_CELL_CONTENT_KEYS = new Set(["v", "m", "f", "mc", "qkf"]);

function _rbCompactNativeSheet(nativeSheet) {
  if (!nativeSheet || !Array.isArray(nativeSheet.celldata)) return nativeSheet;
  const styleTable = [];
  const styleIndex = new Map();
  const celldata = nativeSheet.celldata.map(cell => {
    const v = cell && cell.v;
    if (!v || typeof v !== "object") return cell;
    const content = {}, style = {};
    for (const k in v) {
      if (_RB_CELL_CONTENT_KEYS.has(k)) content[k] = v[k];
      else style[k] = v[k];
    }
    if (!Object.keys(style).length) return { r: cell.r, c: cell.c, v: content };
    const key = JSON.stringify(style);
    let idx = styleIndex.get(key);
    if (idx === undefined) {
      idx = styleTable.length;
      styleTable.push(style);
      styleIndex.set(key, idx);
    }
    return { r: cell.r, c: cell.c, v: { ...content, s: idx } };
  });
  return { ...nativeSheet, celldata, __styleTable: styleTable };
}

function _rbExpandNativeSheet(compact) {
  if (!compact || !Array.isArray(compact.celldata)) return compact;
  const styleTable = compact.__styleTable || [];
  const celldata = compact.celldata.map(cell => {
    const v = cell && cell.v;
    if (!v || typeof v !== "object" || v.s == null) return cell;
    const { s, ...content } = v;
    return { r: cell.r, c: cell.c, v: { ...content, ...(styleTable[s] || {}) } };
  });
  const out = { ...compact, celldata };
  delete out.__styleTable;
  return out;
}

function _rbCellsDataFromNative(nativeSheet) {
  const out = {};
  if (!nativeSheet || !Array.isArray(nativeSheet.celldata)) return out;
  for (const cell of nativeSheet.celldata) {
    const v = cell && cell.v;
    if (v == null) continue;
    const id = _rbCellId(cell.r, cell.c);
    // صيغة Excel عادية (نادرة هنا، غير DSL الخاص بنا) أو نص/رقم مباشر
    let raw;
    if (typeof v === "object") {
      if (v.f != null && v.f !== "") raw = v.f; // صيغة Excel حقيقية (=SUM(...))
      else if (v.v != null && v.v !== "") raw = v.v;
      else if (v.m != null && v.m !== "") raw = v.m;
    } else {
      raw = v;
    }
    if (raw == null || raw === "") continue;
    out[id] = { raw: String(raw), value: raw };
  }
  return out;
}

// ⚠️ مصدر الحقيقة الموثوق لصيغ DSL الخاصة بنا (SUMIFS/JOUR..) وقت الحفظ:
// نقرأها من الخاصية المخصّصة qkf المُضمَّنة داخل كل خلية-صيغة في الشبكة
// الحية نفسها (انظر _rbApplyComputedToGrid) بدل _rbCellsData الخارجي وحده.
// السبب: Luckysheet ينقل كائن الخلية بكامل خصائصه (qkf معها) تلقائيًا مع
// أي حذف/إدراج صف أو عمود يقوم به المستخدم من واجهته مباشرة — وهي عملية
// لا يوجد لها hook متاح نلتقطه في هذا الإصدار من المكتبة لنُحدّث معه
// _rbCellsData يدويًا. الاعتماد على qkf هنا يجعل الصيغ "تتبع" خلاياها
// الصحيحة دائمًا، مهما حدث من إزاحة، بدل أن تبقى مرتبطة بموضعها القديم
// (وهو بالضبط سبب ظهور الحذف وكأنه "يمسح المحتوى" بدل حذف العمود فعليًا).
function _rbDslCellsFromNative(nativeSheet) {
  const out = {};
  if (!nativeSheet || !Array.isArray(nativeSheet.celldata)) return out;
  for (const cell of nativeSheet.celldata) {
    const v = cell && cell.v;
    if (!v || typeof v !== "object" || v.qkf == null || v.qkf === "") continue;
    out[_rbCellId(cell.r, cell.c)] = { raw: String(v.qkf) };
  }
  return out;
}

function _rbSaveTemplatePayload(name) {
  // نلتقط ورقة Luckysheet الحالية بكل تنسيقاتها (luckysheetNative — لإعادة
  // فتحها بدقة كاملة في المصمم لاحقًا)، ونشتق منها أيضًا الصيغة القديمة
  // لكل خلية (styles/merges/colWidths/rowHeights) التي يعتمد عليها
  // reportViewer.js دون أي تعديل عليه.
  const nativeSheet = _rbCaptureNativeSheet();
  // ⚠️ مصدر الحقيقة الوحيد المُخزَّن هو luckysheetNative المضغوط (جدول
  // أنماط مُفهرس، بلا تكرار) — تمامًا كما يخزّن إكسل. لا نعود نحفظ نسخة
  // "legacy" مكررة (styles/merges/colWidths/rowHeights) ولا محتوى الخلايا
  // كاملاً؛ reportViewer.js يشتقّها هو نفسه وقت العرض عبر
  // _rbExpandNativeSheet + _rbConvertNativeToLegacy (نفس الدوال، بلا تخزين
  // مضاعف). هذا يقلّص حجم القالب المحفوظ بشكل كبير.
  //
  // النطاق الوحيد الذي يبقى منفصلاً هو _rbCellsData: صيغ DSL الخاصة بنا
  // (SUMIFS..) التي تحمل الـ raw الحقيقي للصيغة وليس القيمة المحسوبة —
  // هذه لا يمكن اشتقاقها من v/m/f العاديين، لذا تبقى محفوظة، لكن فقط
  // كـ "استثناءات" فوق المحتوى الأصلي (لا كنسخة كاملة مكررة منه).
  //
  // ⚠️ نُعيد بناء _rbCellsData بالكامل من qkf المُضمَّن في الشبكة الحية
  // (_rbDslCellsFromNative) بدل الاكتفاء بتقليم القديم — فهذا هو مصدر
  // الحقيقة الصحيح دائمًا بعد أي حذف/إدراج صف أو عمود قام به المستخدم
  // (انظر الشرح المفصّل أعلى _rbDslCellsFromNative).
  _rbCellsData = _rbDslCellsFromNative(nativeSheet);
  // ⚠️ الصفوف/الأعمدة المخفية: يخفيها المستخدم مباشرة من واجهة Luckysheet
  // نفسها (كليك يمين على رقم الصف/العمود -> "إخفاء")، وليس عبر
  // _rbHiddenRows/_rbHiddenCols (هذان لم يعودا يُحدَّثان من أي تفاعل فعلي
  // في الواجهة منذ التحول لـLuckysheet — كانا يبقيان دائمًا فارغين هنا رغم
  // إخفاء المستخدم لصفوف/أعمدة فعليًا، فتظهر كلها من جديد في عارض
  // التقارير). لذلك نشتقهما مباشرة من حالة الشبكة الحيّة نفسها
  // (nativeSheet.config.rowhidden/colhidden، بصيغة Luckysheet الرسمية:
  // كائن { "3": 0, "5": 0 } حيث المفتاح هو رقم الصف/العمود المخفي).
  const nativeRowHidden = (nativeSheet && nativeSheet.config && nativeSheet.config.rowhidden) || {};
  const nativeColHidden = (nativeSheet && nativeSheet.config && nativeSheet.config.colhidden) || {};
  _rbHiddenRows = new Set(Object.keys(nativeRowHidden).map(n => parseInt(n, 10)).filter(n => !isNaN(n)));
  _rbHiddenCols = new Set(Object.keys(nativeColHidden).map(n => parseInt(n, 10)).filter(n => !isNaN(n)));
  // ⚠️ نفس مشكلة hiddenRows/hiddenCols أعلاه تنطبق على _rbRows/_rbCols:
  // لم تكونا تُحدَّثان أبدًا من الشبكة الحية (فقط عند تحميل قالب أو "قالب
  // جديد")، فتبقيان على القيمة القديمة حتى لو أضاف/حذف المستخدم صفوفًا أو
  // أعمدة فعليًا من واجهة Luckysheet (كليك يمين -> إدراج/حذف N صف/عمود،
  // وهي عملية تُغيّر أبعاد الشيت الحقيقية nativeSheet.row/column، بعكس حذف
  // عمود واحد بمنطق إكسل المعتاد الذي يُبقي العدد الكلي ثابتًا). نشتقهما
  // هنا من أبعاد الشبكة الحيّة نفسها وقت كل حفظ.
  if (nativeSheet) {
    if (Number.isFinite(nativeSheet.row) && nativeSheet.row > 0) _rbRows = nativeSheet.row;
    if (Number.isFinite(nativeSheet.column) && nativeSheet.column > 0) _rbCols = nativeSheet.column;
  }
  const payload = {
    name,
    rows: _rbRows,
    cols: _rbCols,
    cellsData: { ..._rbCellsData }, // فقط استثناءات صيغ DSL، وليس نسخة كاملة
    luckysheetNative: _rbCompactNativeSheet(nativeSheet),
    hiddenRows: [..._rbHiddenRows],
    hiddenCols: [..._rbHiddenCols],
    freezeRow: _rbFreezeRow,
    freezeCol: _rbFreezeCol,
    hideGridlines: _rbHideGridlines,
  };
  return payload;
}

// ══════════════════════════════════════════════════════════════
// "قالب جديد" — يمسح الحالة الحالية بالكامل ويبدأ ورقة فارغة، بغض
// النظر عن كون Luckysheet مهيأ مسبقًا أو لا (خلافًا لمنطق rbTemplateSelect
// الفارغ الذي لا يعمل إلا في أول مرة فقط).
// ══════════════════════════════════════════════════════════════
function rbNewTemplate() {
  if (!confirm("بدء قالب جديد فارغ؟ أي تعديلات غير محفوظة في القالب الحالي ستُفقد.")) return;
  _rbCurrentTemplateId = null;
  _rbRows = 20;
  _rbCols = 12;
  _rbCellsData = {};
  _rbMerges = [];
  _rbHiddenRows = new Set();
  _rbHiddenCols = new Set();
  _rbColWidths = {};
  _rbRowHeights = {};
  _rbFreezeRow = false;
  _rbFreezeCol = false;
  _rbHideGridlines = false;
  const nameInput = document.getElementById("rbTemplateNameInput");
  if (nameInput) nameInput.value = "";
  const sel = document.getElementById("rbTemplateSelect");
  if (sel) sel.value = "";
  _rbUpdateSaveButtonState();
  _rbInitLuckysheet(null);
  addNotif("قالب جديد فارغ ✓", "success");
}

async function rbSaveTemplateAs() {
  const nameInput = document.getElementById("rbTemplateNameInput");
  const name = nameInput?.value.trim();
  if (!name) { addNotif("أدخل اسم القالب أولاً", "warning"); return; }
  const nameLower = name.toLowerCase();
  const dup = _rbTemplates.some(t => String(t.name || "").trim().toLowerCase() === nameLower);
  if (dup) { addNotif("يوجد قالب بهذا الاسم مسبقًا، اختر اسمًا آخر", "warning"); return; }
  try {
    const r = await fetch("/api/sync/custom-report-templates", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(_rbSaveTemplatePayload(name)),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const saved = await r.json();
    console.log("[luckysheetBuilder][SAVE-RESPONSE] has luckysheetNative:", !!saved.luckysheetNative, saved.luckysheetNative);
    _rbTemplates.push(saved);
    _rbCurrentTemplateId = saved.id;
    _rbUpdateSaveButtonState();
    _rbRenderTemplateSelect();
    if (nameInput) nameInput.value = "";
    addNotif("تم حفظ القالب ✓", "success");
  } catch (e) {
    console.warn("[luckysheetBuilder] save template failed:", e);
    addNotif("فشل حفظ القالب", "error");
  }
}

async function rbSaveTemplate() {
  if (!_rbCurrentTemplateId) { await rbSaveTemplateAs(); return; }
  const t = _rbTemplates.find(x => x.id === _rbCurrentTemplateId);
  const name = t ? t.name : (document.getElementById("rbTemplateNameInput")?.value.trim() || "قالب");
  try {
    const r = await fetch(`/api/sync/custom-report-templates/${_rbCurrentTemplateId}`, {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(_rbSaveTemplatePayload(name)),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const saved = await r.json();
    const idx = _rbTemplates.findIndex(x => x.id === _rbCurrentTemplateId);
    if (idx !== -1) _rbTemplates[idx] = saved;
    addNotif("تم تحديث القالب ✓", "success");
  } catch (e) {
    console.warn("[luckysheetBuilder] update template failed:", e);
    addNotif("فشل تحديث القالب", "error");
  }
}

async function rbDeleteTemplate() {
  const sel = document.getElementById("rbTemplateSelect");
  const id = sel?.value;
  if (!id) { addNotif("اختر قالبًا للحذف أولاً", "warning"); return; }
  if (!confirm("حذف هذا القالب نهائيًا؟")) return;
  try {
    const r = await fetch(`/api/sync/custom-report-templates/${id}`, { method: "DELETE", credentials: "include" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    _rbTemplates = _rbTemplates.filter(x => x.id !== id);
    if (_rbCurrentTemplateId === id) _rbCurrentTemplateId = null;
    _rbUpdateSaveButtonState();
    _rbRenderTemplateSelect();
    addNotif("تم حذف القالب ✓", "success");
  } catch (e) {
    console.warn("[luckysheetBuilder] delete template failed:", e);
    addNotif("فشل حذف القالب", "error");
  }
}

// ══════════════════════════════════════════════════════════════
// ملء الشاشة — نكبّر المودال بـCSS فقط (100vw/100vh) بدل Fullscreen API
// الحقيقي: Luckysheet يُلحق كل قوائمه المنبثقة (منتقي الألوان، قوائم
// التنسيق..) مباشرة بـdocument.body (انظر تعليق CSS أعلى الملف)، وواجهة
// Fullscreen API الحقيقية تُخفي أي عنصر خارج العنصر المكبَّر نفسه — فتصير
// تلك القوائم غير مرئية أثناء ملء الشاشة. التكبير بـCSS فقط يتفادى هذه
// المشكلة كليًا.
// ══════════════════════════════════════════════════════════════
const _RB_FULLSCREEN_ICONS = {
  enter: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`,
  exit: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>`,
};

function _rbSetFullscreenBtnState(isFullscreen) {
  const btn = document.getElementById("btnRbFullscreen");
  if (!btn) return;
  btn.innerHTML = isFullscreen ? _RB_FULLSCREEN_ICONS.exit : _RB_FULLSCREEN_ICONS.enter;
  btn.title = isFullscreen ? "تصغير" : "ملء الشاشة";
}

function _rbResizeLuckysheetSoon() {
  setTimeout(() => {
    try {
      if (typeof luckysheet !== "undefined" && _rbLuckysheetReady && typeof luckysheet.resize === "function") luckysheet.resize();
    } catch (e) { /* تجاهل */ }
  }, 60);
}

function _rbToggleFullscreen() {
  const modal = document.getElementById("reportBuilderModal");
  if (!modal) return;
  const entering = !modal.classList.contains("rb-fullscreen");
  modal.classList.toggle("rb-fullscreen", entering);
  _rbSetFullscreenBtnState(entering);
  _rbResizeLuckysheetSoon();
}

function _rbExitFullscreen() {
  const modal = document.getElementById("reportBuilderModal");
  if (!modal || !modal.classList.contains("rb-fullscreen")) return;
  modal.classList.remove("rb-fullscreen");
  _rbSetFullscreenBtnState(false);
}

// ══════════════════════════════════════════════════════════════
// فتح/إغلاق المودال
// ══════════════════════════════════════════════════════════════
async function openReportBuilderModal() {
  const modal = document.getElementById("reportBuilderModal");
  if (!modal) return;
  modal.style.display = "flex";
  if (!_rbTemplates.length) {
    _rbTemplates = await _rbFetchTemplates();
    _rbRenderTemplateSelect();
  }
  _rbUpdateSaveButtonState();
  await _ensureCustomCategoriesLoaded();
  _rbEnsureSourcesLoaded(); // بدون await عمدًا — انظر التعليق أعلى الدالة (أداء)
  // اختبار تشخيصي: لا نعمل create() فارغ تلقائيًا هنا إذا توجد قوالب محفوظة،
  // لتفادي تسلسل destroy()+create() فارغ ثم create() ثانية بالبيانات الحقيقية
  // عند اختيار القالب (rbLoadTemplate) — أول luckysheet.create() بالجلسة يصير
  // مباشرة بالبيانات الحقيقية. لو لا توجد قوالب أصلاً، لا داعي للاختبار.
  if (!_rbLuckysheetReady && !_rbTemplates.length) _rbInitLuckysheet();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btnReportBuilderOpen")?.addEventListener("click", openReportBuilderModal);
  document.getElementById("btnRbClose")?.addEventListener("click", () => {
    document.getElementById("reportBuilderModal").style.display = "none";
    _rbExitFullscreen();
  });
  document.getElementById("reportBuilderModal")?.addEventListener("click", e => {
    if (e.target.id === "reportBuilderModal") {
      document.getElementById("reportBuilderModal").style.display = "none";
      _rbExitFullscreen();
    }
  });
  document.getElementById("btnRbFullscreen")?.addEventListener("click", _rbToggleFullscreen);
  document.getElementById("btnRbNewTemplate")?.addEventListener("click", rbNewTemplate);
  document.getElementById("btnRbSaveAs")?.addEventListener("click", rbSaveTemplateAs);
  document.getElementById("btnRbSave")?.addEventListener("click", rbSaveTemplate);
  document.getElementById("btnRbDeleteTemplate")?.addEventListener("click", rbDeleteTemplate);
  document.getElementById("btnRbFillDown")?.addEventListener("click", rbFillFormulaToSelection);
  document.getElementById("rbTemplateSelect")?.addEventListener("change", e => {
    if (e.target.value) rbLoadTemplate(e.target.value);
    // اختيار "— تحميل قالب محفوظ —" (فارغة) = بدء قالب جديد؛ أول create() هنا فقط
    else if (!_rbLuckysheetReady) _rbInitLuckysheet();
  });

  // ── نافذة المساعدة العائمة (شرح متغيرات/دوال صيغ SUMIFS) ──
  document.getElementById("btnRbHelp")?.addEventListener("click", () => {
    const panel = document.getElementById("rbHelpPanel");
    if (!panel) return;
    if (panel.style.display === "none") _rbRenderHelpPanel();
    panel.style.display = panel.style.display === "none" ? "flex" : "none";
  });
  document.getElementById("btnRbHelpClose")?.addEventListener("click", () => {
    document.getElementById("rbHelpPanel").style.display = "none";
  });
});

function _rbRenderHelpPanel() {
  const body = document.getElementById("rbHelpPanelBody");
  if (!body) return;
  const section = (title, items) => `
    <div class="rb-help-section rb-help-open">
      <div class="rb-help-section-title">${escHtml(title)}</div>
      <div class="rb-help-section-body">
        ${items.map(it => `
          <div class="rb-help-item">
            <div class="rb-help-item-main">
              <div class="rb-help-item-code">${escHtml(it.code)}</div>
              ${it.desc ? `<div class="rb-help-item-desc">${escHtml(it.desc)}</div>` : ""}
            </div>
          </div>`).join("")}
      </div>
    </div>`;
  body.innerHTML =
    section("المصادر (sources)", _RB_HELP_REFERENCE.sources) +
    section("الأعمدة (columns)", _RB_HELP_REFERENCE.columns) +
    section("المقاييس (metrics)", _RB_HELP_REFERENCE.metrics) +
    section("التواريخ (dates)", _RB_HELP_REFERENCE.dates) +
    section("مرجع خلية", _RB_HELP_REFERENCE.cellRef) +
    section("الدوال (functions)", _RB_HELP_REFERENCE.functions);
}
