// ══════════════════════════════════════════════════════════════
// reportBuilder.js — واجهة Grid حر (Excel-like) لنظام Report Builder
// يعتمد على formulaEngine.js (evaluateSumIfs, evaluateCellFormula)
// ⚠️ لا يوجد بعد تصدير Excel/PDF — فقط الشبكة التفاعلية + الحفظ/التحميل.
// ⚠️ مصادر بيانات SUMIFS (_rbSourcesMap.vnt/liv/enc) فارغة افتراضيًا؛
//    تُملأ لاحقًا من rpcController بصفوف خام (search_read غير مجمّعة):
//      - vnt: fetchJ1SalesReport (خام) — user_id, product_id, categ_id, date, qty, amount
//      - liv : fetchDailyDistributionReport (خام) — user_id, product_id, categ_id, date_done, qty, amount
//      - enc : fetchDailyCollectionsReport (خام) — user_id, product_id, categ_id, date, qty, amount
// ══════════════════════════════════════════════════════════════

let _rbRows = 10;
let _rbCols = 10;
let _rbCellsData = {};   // { "A1": { raw: "...", value: "..."|number } }
let _rbMerges = [];      // [{ start:"A1", end:"B2" }]
let _rbStyles = {};      // { "A1": { bg:"#fff", bold:true } }
let _rbSelStart = null;  // بداية التحديد (لدعم النطاق shift+click)
let _rbSelEnd = null;
let _rbSelectedCells = new Set();
let _rbHiddenRows = new Set(); // أرقام صفوف (0-based) معلَّمة "مخفي عند التقرير"
let _rbHiddenCols = new Set(); // أرقام أعمدة (0-based) معلَّمة "مخفي عند التقرير"
let _rbIsDragging = false;     // سحب الماوس نشط حاليًا لتحديد نطاق خلايا
let _rbTemplates = [];
let _rbCurrentTemplateId = null; // معرف القالب المحمّل حاليًا (null = قالب جديد لم يُحفظ بعد)
let _rbSourcesMap = { vnt: [], liv: [], enc: [] }; // بيانات خام لـ SUMIFS لكل مصدر
let _rbColWidths = {};  // { colIndex(number): widthPx }
let _rbRowHeights = {}; // { rowIndex(number): heightPx }
let _rbHideGridlines = false; // إخفاء خطوط الشبكة الافتراضية لـjexcel (لا يمس الحدود المخصصة)
// المرحلة 1 — استبدال گريد الگريد اليدوي بـ Jspreadsheet CE (jexcel):
// نسخة worksheet الوحيدة الحالية (instance.worksheets[0])، تُعاد بالكامل
// عند كل _rbRenderGrid (destroy + إعادة بناء)، وليس sync جزئي.
let _rbJssInstance = null;
const _RB_DEFAULT_COL_WIDTH = 90;
const _RB_DEFAULT_ROW_HEIGHT = 28;
// الحد الأدنى الطبيعي لارتفاع صف مرئي فعليًا في jspreadsheet.css هو تقريبًا
// padding(4px أعلى + 4px أسفل) + line-height(~1em ≈ 13-14px) ≈ 21-22px —
// بصرف النظر عن قيمة height المُطبَّقة عبر setHeight، لأن الـtd الداخلي
// يفرض حده الأدنى بنفسه عبر box-sizing:border-box + هذا الـpadding/line-height.
// أي طلب height أصغر من هذه العتبة يحتاج أيضًا تقليص padding العمودي لكل
// خلايا الصف (وليس فقط ارتفاع <tr>) وإلا يبقى الصف بصريًا بنفس الحجم تقريبًا.
const _RB_ROW_HEIGHT_PADDING_THRESHOLD = 22;
const _RB_ROW_MIN_HEIGHT_FOR_ZERO_PADDING = 5; // عند/تحت هذه القيمة: padding عمودي = 0 تمامًا

// ── تحديد رؤوس أعمدة/صفوف كاملة (نقر على الحرف A/B.. أو رقم الصف) ──
let _rbSelectedHeaderCols = new Set();
let _rbSelectedHeaderRows = new Set();
let _rbLastHeaderCol = null; // آخر عمود نُقر عليه (لدعم مدى shift+click)
let _rbLastHeaderRow = null;

// ── تجميد الصف الأول/العمود الأول (Freeze Panes) ──
let _rbFreezeRow = false;
let _rbFreezeCol = false;

// ── نسخ التنسيق (Format Painter) ──
let _rbFormatPainterActive = false;
let _rbFormatPainterStyle = null;

// ── مقبض التعبئة (Fill Handle) — سحب لنسخ محتوى/تنسيق/صيغة كـExcel ──
let _rbFillHandleEl = null;
let _rbFillDragging = false;
let _rbFillSourceRange = null;  // {r0,c0,r1,c1} نطاق المصدر عند بدء السحب
let _rbFillExtRange = null;     // {r0,c0,r1,c1} نطاق التمديد الحالي أثناء السحب (المعاينة)
let _rbFillDirection = null;    // "down" | "up" | "right" | "left"

// ── حالة الاقتراح التلقائي (autocomplete) لأسماء متغيرات/أعمدة صيغة SUMIFS ──
let _rbAutocompleteOpen = false;
let _rbAutocompleteItems = [];       // قائمة الاقتراحات المطابقة حاليًا
let _rbAutocompleteIndex = -1;       // فهرس الاقتراح المحدد حاليًا (تنقّل بالأسهم)
let _rbAutocompleteCellId = null;    // الخلية التي فُتحت القائمة من أجلها
let _rbAutocompleteTokenStart = -1;  // موضع بداية الكلمة الجاري كتابتها داخل نص الخلية
let _rbAutocompleteTokenEnd = -1;    // موضع نهاية الكلمة (= موضع المؤشر لحظة آخر تحديث)
// أسماء المتغيرات/الأعمدة الثابتة في DSL صيغ SUMIFS (بعد إعادة التسمية)
// + qty/amount (اختيار metric في نهاية SUMIFS) + JOUR (دالة تاريخ كنص مستقل)
// ملاحظة: pack1/pack2/pack3 (packaging_quantity_1/2/3) أسماء مؤقتة
// لحين تأكيد أيها يمثل الكرتون/الفردو فعليًا؛ ستُعاد تسميتها لاحقًا.
//
// ══════════════════════════════════════════════════════════════
// مصدر مركزي واحد (single source of truth) لكل أسماء/شرح متغيرات DSL:
// يُستعمل من طرف autocomplete (_RB_DSL_KEYWORDS مشتقّة منه أدناه) ومن
// طرف نافذة المساعدة (rbHelpPanel). إضافة متغيّر جديد = تحديث هنا فقط.
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
  ],
};

// الكلمات المفتاحية الثابتة لـautocomplete — مشتقّة تلقائيًا من
// _RB_HELP_REFERENCE أعلاه (بلا أي تكرار للقوائم في مكانين).
// ملاحظة: بحروف كبيرة موحّدة (VND، ART، CAT...) لتشجيع كتابة موحّدة —
// المطابقة الفعلية في formulaEngine.js غير حساسة لحالة الأحرف على أي حال
// (vnd/VND/Vnd جميعها تُفهَم بنفس الطريقة)، هذا فقط لعرض الاقتراحات.
const _RB_DSL_KEYWORDS = [
  "SUMIFS", "SUM", "JOUR",
  ..._RB_HELP_REFERENCE.sources.map(x => x.code),
  ..._RB_HELP_REFERENCE.columns.map(x => x.code),
  ..._RB_HELP_REFERENCE.dates.map(x => x.code.replace("-N", "")),
  "all",
  ..._RB_HELP_REFERENCE.metrics.map(x => x.code),
].map(k => k.toUpperCase());

// ── Undo/Redo (Ctrl+Z / Ctrl+Y أو Ctrl+Shift+Z) ──────────────────
// مكدس نسخ عميقة (deep copy) من كامل حالة القالب القابلة للتعديل. يُدفع
// snapshot جديد فقط عند "commit" فعلي (نهاية تعديل، وليس أثناء الكتابة
// الحرفية داخل خلية)، وأي undo يقصّ خطوات "التقدم" (redo) القديمة إن كانت
// موجودة قبل الدفع — تمامًا كسلوك Excel/المتصفح القياسي.
let _rbHistoryStack = [];
let _rbHistoryIndex = -1;
let _rbHistorySuppressed = false; // true أثناء تطبيق undo/redo، لمنع إعادة الدفع للمكدس
const _RB_HISTORY_LIMIT = 100;

function _rbSnapshot() {
  return {
    rows: _rbRows,
    cols: _rbCols,
    cellsData: JSON.parse(JSON.stringify(_rbCellsData)),
    merges: JSON.parse(JSON.stringify(_rbMerges)),
    styles: JSON.parse(JSON.stringify(_rbStyles)),
    hiddenRows: [..._rbHiddenRows],
    hiddenCols: [..._rbHiddenCols],
    colWidths: JSON.parse(JSON.stringify(_rbColWidths)),
    rowHeights: JSON.parse(JSON.stringify(_rbRowHeights)),
    freezeRow: _rbFreezeRow,
    freezeCol: _rbFreezeCol,
    hideGridlines: _rbHideGridlines,
  };
}

// يبدأ مكدسًا جديدًا بخطوة أساس واحدة (يُستدعى عند فتح المصمم بقالب فارغ
// جديد أو عند تحميل قالب محفوظ — الخطوة الأساس نفسها غير قابلة للتراجع عنها)
function _rbResetHistory() {
  _rbHistoryStack = [_rbSnapshot()];
  _rbHistoryIndex = 0;
}

// يُستدعى بعد أي تعديل فعلي "مكتمل" على حالة القالب (وليس أثناء الكتابة
// الحرفية غير المؤكَّدة داخل خلية). يقصّ أي خطوات redo قديمة قبل الدفع.
function _rbPushHistory() {
  if (_rbHistorySuppressed) return;
  if (_rbHistoryIndex < _rbHistoryStack.length - 1) {
    _rbHistoryStack = _rbHistoryStack.slice(0, _rbHistoryIndex + 1);
  }
  _rbHistoryStack.push(_rbSnapshot());
  if (_rbHistoryStack.length > _RB_HISTORY_LIMIT) _rbHistoryStack.shift();
  _rbHistoryIndex = _rbHistoryStack.length - 1;
}

function _rbApplySnapshot(snap) {
  _rbHistorySuppressed = true;
  _rbRows = snap.rows;
  _rbCols = snap.cols;
  _rbCellsData = JSON.parse(JSON.stringify(snap.cellsData));
  _rbMerges = JSON.parse(JSON.stringify(snap.merges));
  _rbStyles = JSON.parse(JSON.stringify(snap.styles));
  _rbHiddenRows = new Set(snap.hiddenRows);
  _rbHiddenCols = new Set(snap.hiddenCols);
  _rbColWidths = JSON.parse(JSON.stringify(snap.colWidths));
  _rbRowHeights = JSON.parse(JSON.stringify(snap.rowHeights));
  _rbFreezeRow = !!snap.freezeRow;
  _rbFreezeCol = !!snap.freezeCol;
  _rbHideGridlines = !!snap.hideGridlines;
  _rbSelStart = null; _rbSelEnd = null; _rbSelectedCells = new Set();
  _rbSelectedHeaderCols = new Set(); _rbSelectedHeaderRows = new Set();
  _rbApplyHideGridlinesClass();
  _rbRenderGrid();
  _rbSyncFormatDropdownFromSelection();
  _rbUpdateFreezeButtonsState();
  _rbHistorySuppressed = false;
}

function rbUndo() {
  if (_rbHistoryIndex <= 0) { addNotif("لا يوجد ما يمكن التراجع عنه", "warning"); return; }
  _rbHistoryIndex--;
  _rbApplySnapshot(_rbHistoryStack[_rbHistoryIndex]);
}

function rbRedo() {
  if (_rbHistoryIndex >= _rbHistoryStack.length - 1) { addNotif("لا يوجد ما يمكن إعادته", "warning"); return; }
  _rbHistoryIndex++;
  _rbApplySnapshot(_rbHistoryStack[_rbHistoryIndex]);
}
// ✅ اختُبر يدويًا: كتابة في خلية (commit بـ blur) → Ctrl+Z (تراجع) →
// Ctrl+Z (تراجع لخطوة الأساس) → Ctrl+Y (تقدّم لرجوع الكتابة الأولى) →
// تعديل جديد (مثلاً toggle Bold) → تأكدنا أن خطوة "التقدم" القديمة (نص
// الكتابة الملغاة) اختفت فعليًا من المكدس ولم تعد قابلة للاسترجاع عبر
// Ctrl+Y بعد ذلك — يطابق سلوك Excel/المتصفح القياسي.

// ── تحويل بين "A1" ورقم عمود/صف ─────────────────────────────
function _rbColLetters(index) { // 0-based -> "A","B",...,"Z","AA",...
  let n = index + 1, s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
function _rbColIndex(letters) { // "A"->0, "B"->1, "AA"->26
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function _rbCellId(rowIdx, colIdx) { // 0-based row/col -> "A1" (صف 1-based)
  return `${_rbColLetters(colIdx)}${rowIdx + 1}`;
}
function _rbParseCellId(id) {
  const m = /^([A-Za-z]+)([0-9]+)$/.exec(id || "");
  if (!m) return null;
  return { col: _rbColIndex(m[1].toUpperCase()), row: parseInt(m[2], 10) - 1 };
}

// ── إيجاد نطاق (merge) يغطي خلية معيّنة، إن وجد ──────────────
function _rbFindCoveringMerge(cellId) {
  const p = _rbParseCellId(cellId);
  if (!p) return null;
  for (const m of _rbMerges) {
    const s = _rbParseCellId(m.start), e = _rbParseCellId(m.end);
    const r0 = Math.min(s.row, e.row), r1 = Math.max(s.row, e.row);
    const c0 = Math.min(s.col, e.col), c1 = Math.max(s.col, e.col);
    if (p.row >= r0 && p.row <= r1 && p.col >= c0 && p.col <= c1) return m;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// حساب الخلايا: تفريق صيغة SUMIF عن صيغة عمليات الخلايا
// ══════════════════════════════════════════════════════════════

// يتعرّف إن كانت raw تحتوي استدعاء SUMIFS(...) واحدًا على الأقل، سواء
// كانت الصيغة بأكملها SUMIFS مفردة، أو صيغة مركّبة تحتوي أكثر من SUMIFS
// بعملية حسابية بينها (مثل =SUMIFS(...) - SUMIFS(...))، أو حتى SUMIFS
// ضمن جزء من صيغة دمج نص (&). لا يتحقق من الشكل الكامل للصيغة (ذلك من
// مهمة evaluateCellFormula/_parseFunctionCall عند الحساب الفعلي) —
// فقط يُستعمل كفحص سريع (مثلًا لحساب نافذة الجلب الدنيا في reportViewer.js).
function _rbIsSumIfsFormula(raw) {
  return /SUMIFS\s*\(/i.test(String(raw || ""));
}

// التاريخ الحالي (jour) المستعمل داخل صيغ SUMIFS — يقابل شريط التاريخ
// المختار حاليًا في التطبيق (App.currentDateOffset)، مع fallback آمن لليوم
// الحالي إن لم يكن App/getDateKey متاحين (اختبارات، إلخ).
function _rbCurrentTheday() {
  try {
    if (typeof App !== "undefined" && typeof getDateKey === "function") {
      return getDateKey(App.currentDateOffset || 0);
    }
  } catch (e) { /* تجاهل */ }
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// يقسّم نص صيغة (بدون "=" البادئة) على عامل الدمج "&" في المستوى الأعلى
// فقط (خارج أي علامتي اقتباس "..." وخارج أي أقواس متداخلة مثل SUMIFS(...)
// حيث الفاصل هناك هو ";" لا "&"). كل جزء يُعاد بعد trim، والأجزاء الفارغة تُحذف.
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

// يحسب جزءًا واحدًا من صيغة دمج (& ) ويُرجعه كنص جاهز للدمج:
// - نص حرفي بين علامتي اقتباس "..." يبقى كما هو (بلا الاقتباسين)
// - JOUR(...) أو SUMIFS(...) تُحسب عبر formulaEngine.js
// - jour / jour-N بمفردها (دون دالة) تُنسَّق كتاريخ نصي DD/MM/YYYY
// - مرجع خلية (A1) أو أي تعبير حسابي آخر يُحسب عبر evaluateCellFormula
function _rbEvaluateConcatPart(part) {
  const p = String(part || "").trim();

  const qm = /^"([\s\S]*)"$/.exec(p);
  if (qm) return qm[1];

  if (/^JOUR\s*\(/i.test(p)) {
    return evaluateJour("=" + p, _rbCurrentTheday());
  }

  if (/^jour(\s*-\s*\d+)?$/i.test(p)) {
    return formatIsoDateToDMY(resolveDateExpr(p, _rbCurrentTheday()));
  }

  // مرجع خلية مفرد (A1)، تعبير حسابي (A1+A2*2...)، SUMIFS(...) مفردة، أو
  // حتى عدة SUMIFS مركّبة بعملية حسابية بينها — كلها تُحسب عبر نفس المحلّل
  // الموحّد (evaluateCellFormula)، الذي يدعم SUMIFS(...) كعنصر أوّلي عبر
  // sumifsCtx (انظر formulaEngine.js).
  try {
    const v = evaluateCellFormula("=" + p, _rbCellsRawMap(), undefined, _rbSumIfsCtx());
    return String(v);
  } catch (e) {
    // تساهل: كلمة/نص غير موضوع بين علامتي اقتباس يُعتبر نصًا حرفيًا كما هو
    return p;
  }
}

// يحسب raw ويرجّع { value, error }. يُستعمل لكل خلية عند التعديل وعند إعادة الحساب.
function _rbComputeCell(raw) {
  if (raw == null || raw === "") return { value: "" };
  if (typeof raw !== "string" || !raw.trim().startsWith("=")) {
    return { value: raw }; // نص/رقم عادي بلا صيغة
  }
  try {
    const expr = raw.trim().replace(/^=/, "").trim();

    // دمج نص + متغيرات/دوال عبر "&" (مثال: ="Constat " & JOUR() أو & jour)
    const concatParts = _rbSplitTopLevelConcat(expr);
    if (concatParts.length > 1) {
      const text = concatParts.map(_rbEvaluateConcatPart).join("");
      return { value: text };
    }

    if (/^JOUR\s*\(/i.test(expr)) {
      const v = evaluateJour(raw, _rbCurrentTheday());
      return { value: v };
    }
    // مسار موحّد لكل ما تبقّى: مرجع خلية مفرد، تعبير حسابي بين خلايا،
    // SUMIFS(...) مفردة، أو عدة SUMIFS مركّبة بعملية حسابية بينها (وحتى
    // خليط SUMIFS مع مراجع خلايا) — evaluateCellFormula يدعم كل ذلك الآن
    // عبر sumifsCtx (انظر formulaEngine.js).
    const v = evaluateCellFormula(raw, _rbCellsRawMap(), undefined, _rbSumIfsCtx());
    return { value: v };
  } catch (e) {
    return { value: "#خطأ: " + e.message, error: e.message };
  }
}

// خريطة { cellId: raw } لتمريرها لـ evaluateCellFormula (يدعم اعتمادًا متسلسلاً بنفسه)
function _rbCellsRawMap() {
  const map = {};
  for (const id in _rbCellsData) map[id] = _rbCellsData[id].raw;
  return map;
}

// خريطة { cellId: value } (القيمة الفعلية المحسوبة، أو raw إن لم تُحسب بعد) —
// تُستعمل للسماح بمرجع خلية (مثل A1) داخل شروط SUMIFS بدل كتابة القيمة يدويًا.
function _rbCellsValueMap() {
  const map = {};
  for (const id in _rbCellsData) {
    const cell = _rbCellsData[id];
    map[id] = (cell.value !== undefined && cell.value !== null && cell.value !== "") ? cell.value : cell.raw;
  }
  return map;
}

// سياق حساب SUMIFS(...) الكامل — يُمرَّر لـevaluateCellFormula (formulaEngine.js)
// حتى تستطيع حساب أي استدعاء SUMIFS(...) يظهر داخل صيغة (مفردة أو مركّبة
// مع عمليات حسابية أو مراجع خلايا أخرى)، بنفس المعطيات المستعملة أصلًا في
// استدعاء evaluateSumIfs المباشر.
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

// الفئات المخصصة المتاحة لصيغ SUMIF (نفس _customCategories من app.js إن وُجدت)
function _rbTemplateCategories() {
  return (typeof _customCategories !== "undefined" && Array.isArray(_customCategories)) ? _customCategories : [];
}

// فئات البائعين المخصصة المتاحة لصيغ SUMIF (نفس _customSellerCategories من app.js إن وُجدت)
function _rbTemplateSellerCategories() {
  return (typeof _customSellerCategories !== "undefined" && Array.isArray(_customSellerCategories)) ? _customSellerCategories : [];
}

// فئات قوائم الأسعار المخصصة المتاحة لصيغ SUMIF (نفس _customPricelistCategories من app.js إن وُجدت)
function _rbTemplatePricelistCategories() {
  return (typeof _customPricelistCategories !== "undefined" && Array.isArray(_customPricelistCategories)) ? _customPricelistCategories : [];
}

// ══════════════════════════════════════════════════════════════
// Autocomplete — اقتراح أسماء متغيرات/أعمدة أثناء كتابة صيغة SUMIFS
// ══════════════════════════════════════════════════════════════

// كل الأسماء القابلة للاقتراح: كلمات DSL الثابتة + أسماء الفئات المخصصة
// المحفوظة فعليًا للمستخدم الحالي (منتجات/بائعين/قوائم أسعار)
function _rbAutocompleteCandidates() {
  const names = [
    ..._RB_DSL_KEYWORDS,
    ..._rbTemplateCategories().map(c => c && c.name).filter(Boolean),
    ..._rbTemplateSellerCategories().map(c => c && c.name).filter(Boolean),
    ..._rbTemplatePricelistCategories().map(c => c && c.name).filter(Boolean),
  ];
  // إزالة التكرار مع الحفاظ على الترتيب
  return [...new Set(names)];
}

// موضع المؤشر الحالي (offset نصي) داخل خلية contenteditable
function _rbGetCaretOffset(td) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!td.contains(range.startContainer)) return null;
  const preRange = range.cloneRange();
  preRange.selectNodeContents(td);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
}

// يضع المؤشر عند offset نصي معيّن داخل خلية contenteditable (نص عادي، عقدة واحدة)
function _rbSetCaretOffset(td, offset) {
  const sel = window.getSelection();
  if (!sel) return;
  const textNode = td.firstChild;
  const range = document.createRange();
  if (textNode && textNode.nodeType === Node.TEXT_NODE) {
    range.setStart(textNode, Math.max(0, Math.min(offset, textNode.length)));
  } else {
    range.selectNodeContents(td);
    range.collapse(false);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// يحدّد حدود "الكلمة" الجاري كتابتها قبل المؤشر مباشرة، بالاعتماد على
// آخر فاصل DSL (=  (  )  ;) قبل المؤشر — يدعم أسماء فئات مخصصة تحتوي مسافات.
function _rbFindAutocompleteToken(text, caret) {
  let idx = -1;
  for (let i = caret - 1; i >= 0; i--) {
    if ("=();&".includes(text[i])) { idx = i; break; }
  }
  const rawStart = idx + 1;
  const rawToken = text.slice(rawStart, caret);
  const leadingWs = rawToken.match(/^\s*/)[0].length;
  return { start: rawStart + leadingWs, token: rawToken.slice(leadingWs) };
}

function _rbEnsureAutocompleteEl() {
  let el = document.getElementById("rbAutocompleteDropdown");
  if (!el) {
    el = document.createElement("div");
    el.id = "rbAutocompleteDropdown";
    el.className = "rb-autocomplete-dropdown";
    el.style.display = "none";
    document.body.appendChild(el);
  }
  return el;
}

function _rbHideAutocomplete() {
  const el = document.getElementById("rbAutocompleteDropdown");
  if (el) el.style.display = "none";
  _rbAutocompleteOpen = false;
  _rbAutocompleteItems = [];
  _rbAutocompleteIndex = -1;
  _rbAutocompleteTokenStart = -1;
  _rbAutocompleteTokenEnd = -1;
  _rbAutocompleteCellId = null;
}

function _rbUpdateAutocompleteHighlight() {
  const el = document.getElementById("rbAutocompleteDropdown");
  if (!el) return;
  el.querySelectorAll(".rb-autocomplete-item").forEach((div, i) => {
    div.classList.toggle("rb-autocomplete-active", i === _rbAutocompleteIndex);
  });
  const active = el.querySelector(".rb-autocomplete-active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function _rbShowAutocomplete(td, id, items) {
  const el = _rbEnsureAutocompleteEl();
  _rbAutocompleteItems = items;
  _rbAutocompleteIndex = 0;
  _rbAutocompleteCellId = id;
  el.innerHTML = items.map((it, i) =>
    `<div class="rb-autocomplete-item${i === 0 ? " rb-autocomplete-active" : ""}" data-index="${i}">${escHtml(it)}</div>`
  ).join("");
  el.querySelectorAll(".rb-autocomplete-item").forEach(div => {
    // mousedown (لا click) لمنع فقدان تركيز الخلية قبل الإدراج
    div.addEventListener("mousedown", e => {
      e.preventDefault();
      _rbAutocompleteIndex = parseInt(div.dataset.index, 10);
      _rbAcceptAutocompleteSuggestion(td);
    });
  });
  const rect = td.getBoundingClientRect();
  el.style.left = Math.round(rect.left) + "px";
  el.style.top = Math.round(rect.bottom + 2) + "px";
  el.style.minWidth = Math.max(rect.width, 120) + "px";
  el.style.display = "block";
  _rbAutocompleteOpen = true;
}

// يُدرج الاقتراح المحدد مكان الكلمة الجاري كتابتها، ويُبقي المؤشر/التركيز
// داخل الخلية لمتابعة الكتابة
function _rbAcceptAutocompleteSuggestion(td) {
  if (!_rbAutocompleteOpen || _rbAutocompleteIndex < 0) return;
  const suggestion = _rbAutocompleteItems[_rbAutocompleteIndex];
  if (suggestion === undefined) return;
  const text = td.textContent || "";
  const start = _rbAutocompleteTokenStart;
  const end = _rbAutocompleteTokenEnd;
  const newText = text.slice(0, start) + suggestion + text.slice(end);
  td.textContent = newText;
  td.focus();
  _rbSetCaretOffset(td, start + suggestion.length);
  _rbHideAutocomplete();
}

// يُعاد استدعاؤها عند كل تعديل نصي داخل خلية قيد التحرير: تُحدّث/تُظهر/تُخفي
// قائمة الاقتراحات حسب موضع المؤشر ومحتوى الخلية
function _rbHandleAutocompleteInput(td, id) {
  const text = td.textContent || "";
  if (!/^\s*=/.test(text)) { _rbHideAutocomplete(); return; } // يجب أن تبدأ بـ"="
  const caret = _rbGetCaretOffset(td);
  if (caret === null) { _rbHideAutocomplete(); return; }

  const { start, token } = _rbFindAutocompleteToken(text, caret);
  if (!token) { _rbHideAutocomplete(); return; }

  const tokenLower = token.toLowerCase();
  let matches = _rbAutocompleteCandidates().filter(c => c.toLowerCase().includes(tokenLower));
  matches.sort((a, b) => {
    const aStarts = a.toLowerCase().startsWith(tokenLower) ? 0 : 1;
    const bStarts = b.toLowerCase().startsWith(tokenLower) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return a.localeCompare(b);
  });
  matches = matches.slice(0, 8);

  if (!matches.length) { _rbHideAutocomplete(); return; }

  _rbAutocompleteTokenStart = start;
  _rbAutocompleteTokenEnd = caret;
  _rbShowAutocomplete(td, id, matches);
}

// معالجة أسهم التنقل/Tab/Enter/Escape أثناء ظهور قائمة الاقتراحات لخلية معيّنة.
// تُرجع true إن تعاملت مع الحدث (فيستدعي المستدعي e.preventDefault() ويوقف
// أي معالجة إضافية للمفتاح).
function _rbHandleAutocompleteKeydown(e, td, id) {
  if (!_rbAutocompleteOpen || _rbAutocompleteCellId !== id) return false;

  if (e.key === "ArrowDown") {
    _rbAutocompleteIndex = (_rbAutocompleteIndex + 1) % _rbAutocompleteItems.length;
    _rbUpdateAutocompleteHighlight();
    return true;
  }
  if (e.key === "ArrowUp") {
    _rbAutocompleteIndex = (_rbAutocompleteIndex - 1 + _rbAutocompleteItems.length) % _rbAutocompleteItems.length;
    _rbUpdateAutocompleteHighlight();
    return true;
  }
  if (e.key === "Tab" || e.key === "Enter") {
    _rbAcceptAutocompleteSuggestion(td);
    return true;
  }
  if (e.key === "Escape") {
    _rbHideAutocomplete();
    return true;
  }
  return false;
}

// يعيد حساب أي خلية تعتمد (في صيغتها) على changedId، ثم يتسلسل لمن يعتمد عليها
function _rbRecomputeDependents(changedId, visited = new Set()) {
  if (visited.has(changedId)) return;
  visited.add(changedId);
  const ref = new RegExp(`\\b${changedId}\\b`);
  for (const id in _rbCellsData) {
    if (id === changedId) continue;
    const cell = _rbCellsData[id];
    if (typeof cell.raw === "string" && cell.raw.trim().startsWith("=") && ref.test(cell.raw)) {
      const result = _rbComputeCell(cell.raw);
      cell.value = result.value;
      _rbUpdateCellDisplay(id);
      _rbRecomputeDependents(id, visited);
    }
  }
}

// يحسب ويحفظ محتوى خلية من نص خام (raw) — نفس المنطق المستعمل عند
// مغادرة خلية بعد كتابة يدوية، لكن كدالة مركزية قابلة لإعادة الاستعمال
// (تُستدعى أيضًا من formulaWizard.js عند تطبيق صيغة مُولَّدة من النموذج).
function _rbCommitCellFormula(id, raw) {
  if (!raw || raw === "") {
    delete _rbCellsData[id];
  } else {
    const result = _rbComputeCell(raw);
    _rbCellsData[id] = { raw, value: result.value, error: result.error || null };
  }
  _rbUpdateCellDisplayForce(id);
  _rbRecomputeDependents(id);
  _rbPushHistory();
}

// يُرجع عنصر <td> الفعلي لخلية jexcel المطابقة لمعرّف "A1"، أو null إن لم
// توجد الـinstance بعد أو كانت الإحداثيات خارج الحدود الحالية.
function _rbCellElement(cellId) {
  const p = _rbParseCellId(cellId);
  if (!p || !_rbJssInstance || !_rbJssInstance.records) return null;
  const row = _rbJssInstance.records[p.row];
  return (row && row[p.col]) ? row[p.col].element : null;
}

// يكتب نص العرض داخل <td> — إن كانت الخلية تملك rotation محفوظ (غير صفري)
// يُلَفّ النص بـ<span> بتحويل CSS transform:rotate بدل تعيين textContent
// مباشرة (نفس الآلية المطلوبة للتوافق مع التفاف/محاذاة النص الحاليين قدر
// الإمكان — بدون حل مثالي لكل تركيبة، فقط تجنّب أي كسر بصري صارخ).
function _rbSetCellDisplayText(td, text, rotation) {
  const deg = parseFloat(rotation);
  if (!Number.isFinite(deg) || deg === 0) {
    td.textContent = text;
    return;
  }
  td.textContent = "";
  const span = document.createElement("span");
  span.className = "rb-rotated-text";
  span.style.display = "inline-block";
  span.style.transform = `rotate(${deg}deg)`;
  span.style.whiteSpace = "nowrap";
  span.textContent = text;
  td.appendChild(span);
}

function _rbUpdateCellDisplay(cellId) {
  const td = _rbCellElement(cellId);
  if (!td) return;
  const editingInput = td.querySelector("input, textarea");
  if (editingInput && document.activeElement === editingInput) return; // لا تلمس الخلية أثناء تحريرها حاليًا
  const cell = _rbCellsData[cellId];
  const cellStyle = _rbStyles[cellId] || {};
  const text = cell ? String(_rbFormatValue(cell.value ?? "", cellStyle.format, cellStyle.currencySymbol, cellStyle.decimals) ?? "") : "";
  _rbSetCellDisplayText(td, text, cellStyle.rotation);
  td.classList.toggle("rb-cell-error", !!(cell && cell.error));
}

// ══════════════════════════════════════════════════════════════
// تنسيق بصري: حدود + نوع محتوى (عملة/نسبة/تاريخ) — مشتركة بين
// المصمم (reportBuilder.js) والعارض (reportViewer.js)
// ══════════════════════════════════════════════════════════════

// border: صيغتان مدعومتان —
// 1) قديمة (توافقية): نص "all"/"bottom"، أو كائن حواف بقيم boolean {t,r,b,l}.
// 2) جديدة (Excel-style، المرحلة 2): كائن حواف {t,r,b,l} حيث كل جهة إمّا
//    falsy (بدون حد) أو {w:عرض_px, c:لون} — يسمح بعرض/لون مخصصين لكل حد.
// ⚠️ نستعمل الآن border-top/right/bottom/left الحقيقية بدل box-shadow
// (الطريقة القديمة) — كل خلية تُحسب حدودها بناءً على موقعها داخل مستطيل
// التحديد وقت التطبيق (انظر rbApplyBorder).
function _rbBorderSideCss(prop, side) {
  if (!side) return "";
  if (side === true) return `${prop}:1px solid #888;`;
  if (typeof side === "object" && side.w) return `${prop}:${side.w}px solid ${side.c || "#888"};`;
  return "";
}
function _rbBorderCss(border) {
  if (!border) return "";
  if (border === "none") {
    return ["border-top", "border-right", "border-bottom", "border-left"]
      .map(p => `${p}:none;`).join("");
  }
  if (border === "all") {
    return ["border-top", "border-right", "border-bottom", "border-left"]
      .map(p => `${p}:1px solid #888;`).join("");
  }
  if (border === "bottom") return `border-bottom:1px solid #888;`;
  if (typeof border === "object") {
    return _rbBorderSideCss("border-top", border.t)
      + _rbBorderSideCss("border-right", border.r)
      + _rbBorderSideCss("border-bottom", border.b)
      + _rbBorderSideCss("border-left", border.l);
  }
  return "";
}

// يبني سلسلة CSS من كل خواص التنسيق النصي/الخلفية المخزّنة لخلية واحدة
// (مشتركة بين المصمم reportBuilder.js والعارض reportViewer.js)
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
  s += `text-align:${style.textAlign || "left"};`;
  if (style.format === "number" || style.format === "currency" || style.format === "percentage") {
    // tabular-nums: كل رقم بنفس العرض الثابت، فتصطف الآحاد/العشرات/الفواصل
    // عموديًا بين الخلايا (بدل أن يختلف عرض كل رقم حسب الخط النسبي العادي).
    s += `font-variant-numeric:tabular-nums;padding-right:6px;`;
  }
  const va = style.verticalAlign || "middle";
  s += `vertical-align:${va};`;
  if (style.wrap) s += `white-space:normal;word-wrap:break-word;overflow-wrap:break-word;`;
  s += _rbBorderCss(style.border);
  return s;
}

// ══════════════════════════════════════════════════════════════
// تطبيق التنسيق فعليًا على گريد jexcel عبر setStyle/getStyle الرسميتين
// (بدل التعديل المباشر السابق على td.style.xxx) — _rbStyles{} يبقى مصدر
// الحقيقة المحفوظ/المحمَّل، وهاتان الدالتان تدفعان القيم لعرض jexcel.
// ══════════════════════════════════════════════════════════════
function _rbSetGridStyleProp(id, prop, value) {
  if (!_rbJssInstance) return;
  try { _rbJssInstance.setStyle(id, prop, value == null ? "" : String(value), true, true); } catch (e) { /* تجاهل */ }
}
function _rbSetGridStylesBatch(map) {
  if (!_rbJssInstance || !map || !Object.keys(map).length) return;
  try { _rbJssInstance.setStyle(map, null, null, true, true); } catch (e) { /* تجاهل */ }
}
// يُعيد تطبيق كل _rbStyles المحفوظة على گريد jexcel الحالي — يُستدعى بعد كل
// إعادة بناء كاملة للگريد (onload في _rbRenderGrid)، لأن jexcel يُنشئ خلايا
// جديدة بلا أي تنسيق مضمَّن في data/columns.
function _rbReapplyAllStyles() {
  if (!_rbJssInstance) return;
  const map = {};
  for (const id of Object.keys(_rbStyles)) {
    const css = _rbStyleCss(_rbStyles[id]);
    if (css) map[id] = css;
  }
  _rbSetGridStylesBatch(map);
}

// يُعيد تطبيق كل _rbRowHeights المحفوظة على گريد jexcel الحالي عبر
// setHeight الرسمية — يُستدعى بعد كل إعادة بناء كاملة للگريد (onload في
// _rbRenderGrid)، بنفس منطق _rbReapplyAllStyles/_rbReapplyAllMerges، لأن
// إعادة البناء لا تُمرِّر الارتفاعات ضمن إعدادات worksheet أصلًا.
function _rbReapplyAllRowHeights() {
  if (!_rbJssInstance) return;
  for (const [r, h] of Object.entries(_rbRowHeights)) {
    const n = parseInt(h, 10);
    if (Number.isFinite(n) && n > 0) {
      try { _rbJssInstance.setHeight(parseInt(r, 10), n); } catch (e) { /* تجاهل */ }
      _rbApplyRowCellPadding(parseInt(r, 10), n);
    }
  }
}

// يحسب padding عمودي (أعلى/أسفل) مناسب لارتفاع صف مطلوب px — null يعني
// "لا تجاوز شيء، اترك padding الافتراضي (4px) من ورقة الأنماط كما هو"،
// وهو الحال عند ≥ العتبة الطبيعية. تحت العتبة: تدرّج خطي بين 0 (عند/تحت
// _RB_ROW_MIN_HEIGHT_FOR_ZERO_PADDING) و4px الافتراضي (عند العتبة نفسها) —
// حتى لا يظهر "قفزة" مفاجئة بصريًا بين صف بـheight=21 وآخر بـheight=23.
function _rbComputeRowVerticalPadding(heightPx) {
  if (heightPx >= _RB_ROW_HEIGHT_PADDING_THRESHOLD) return null;
  if (heightPx <= _RB_ROW_MIN_HEIGHT_FOR_ZERO_PADDING) return 0;
  const span = _RB_ROW_HEIGHT_PADDING_THRESHOLD - _RB_ROW_MIN_HEIGHT_FOR_ZERO_PADDING;
  const ratio = (heightPx - _RB_ROW_MIN_HEIGHT_FOR_ZERO_PADDING) / span;
  return Math.max(0, Math.round(ratio * 4));
}

const _RB_ROW_MIN_LINE_HEIGHT = 1; // px — حد أدنى فعلي (وليس 0: line-height:0 قد يُسبب سلوكًا غير متوقع في بعض المتصفحات)
const _RB_ROW_LINE_HEIGHT_SAFETY_MARGIN = 2; // px — هامش أمان يُطرح من المساحة المتبقية بعد الـpadding

// يحسب line-height صريحًا بالـpx مناسبًا لارتفاع صف مطلوب px — null يعني
// "لا تجاوز شيء، اترك line-height:1em الموروث من jspreadsheet.css كما هو"،
// وهو الحال عند ≥ العتبة الطبيعية (نفس عتبة padding أعلاه). تحت العتبة:
// المشكلة أن line-height:1em (يعادل ~13-14px حسب حجم الخط الافتراضي) وحده
// كافٍ لإبقاء ارتفاع الخلية الفعلي عند ~13-14px حتى لو صُفِّر padding
// بالكامل — فيجب تصغيره أيضًا صراحةً بالـpx (وليس em، حتى لا يبقى نسبيًا
// لحجم الخط) إلى تقريبًا (heightPx - padding المطبَّق حاليًا - هامش أمان)،
// مع حد أدنى _RB_ROW_MIN_LINE_HEIGHT (1px، وليس 0) حتى لا ينهار تمامًا.
function _rbComputeRowLineHeight(heightPx, verticalPaddingPx) {
  if (heightPx >= _RB_ROW_HEIGHT_PADDING_THRESHOLD) return null;
  const pad = verticalPaddingPx || 0;
  const available = heightPx - pad * 2 - _RB_ROW_LINE_HEIGHT_SAFETY_MARGIN;
  return Math.max(_RB_ROW_MIN_LINE_HEIGHT, available);
}

const _RB_ROW_FONT_SHRINK_THRESHOLD = 10; // px — تحت هذا الارتفاع نُصغّر font-size أيضًا (13px الافتراضي لن يدخل مساحة أصغر من هذا)
const _RB_ROW_MIN_FONT_SIZE = 5; // px — حد أدنى معقول لحجم الخط (النص عمليًا غير مقروء عند هذا الحجم، وهذا متوقع)

// يحسب font-size صريحًا بالـpx عندما يكون ارتفاع الصف أصغر من العتبة
// _RB_ROW_FONT_SHRINK_THRESHOLD — null يعني "لا تجاوز، اترك font-size
// الافتراضي (13px) كما هو". الهدف هنا ليس إبقاء النص مقروءًا (مستحيل عند
// ارتفاعات متطرفة مثل 1px) بل ضمان أن الصف يصغر بصريًا فعليًا ولا يبقى
// النص "طافيًا" خارج حدود صف بالكاد يتسع لجزء من حرف واحد.
function _rbComputeRowFontSize(heightPx) {
  // تعطيل تصغير الخط: نترك font-size الافتراضي دومًا، والصف يتصغّر فعليًا
  // (والنص يُقص بواسطة overflow:hidden + height صريح على كل td) بدل تصغير الخط.
  return null;
}

// يُطبَّق padding-top/padding-bottom (فقط — لا padding-left/right، حتى يبقى
// النص مقروءًا أفقيًا) + line-height صريح بالـpx (انظر _rbComputeRowLineHeight
// أعلاه — بنفس منطق العتبة، ويُطبَّقان معًا هنا حتى يبقيا متزامنين دائمًا)
// على كل خلايا صف بعينه عبر setStyle الرسمية، بنفس آلية bg/bold/... الحالية
// (_rbSetGridStyleProp) — هذا يكتب inline style لكل خاصية تحديدًا، فلا يمسّ
// أي تنسيق آخر مطبَّق مسبقًا على نفس الخلايا (حدود، محاذاة عمودية، خلفية...).
// عند null (فوق العتبة) نمرّر "" لإزالة أي تجاوز سابق والعودة للقيم
// الافتراضية (padding:4px وline-height:1em) من ورقة الأنماط.
function _rbApplyRowCellPadding(rowIndex, heightPx) {
  if (!_rbJssInstance || !Number.isFinite(rowIndex)) return;
  const pad = _rbComputeRowVerticalPadding(heightPx);
  const padValue = pad == null ? "" : `${pad}px`;
  const lineHeight = _rbComputeRowLineHeight(heightPx, pad);
  const lineHeightValue = lineHeight == null ? "" : `${lineHeight}px`;
  const fontSize = _rbComputeRowFontSize(heightPx);
  const fontSizeValue = fontSize == null ? "" : `${fontSize}px`;
  // ملاحظة حاسمة (مؤكَّدة بالتجربة الفعلية بالكونسول): تعيين height على <tr>
  // فقط لا يكفي إطلاقًا — في جداول HTML يبقى ارتفاع <tr>.style.height مجرد
  // "اقتراح" يتجاهله المتصفح إذا احتاج أي td جوّاه مساحة أطول (padding +
  // line-height + border الافتراضية)، فيُكبَّر الصف تلقائيًا. الحل الوحيد
  // الفعّال هو تعيين height صريح + overflow:hidden على كل td بالصف نفسه أيضًا.
  const heightValue = `${Math.max(0, parseInt(heightPx, 10) || 0)}px`;
  for (let c = 0; c < _rbCols; c++) {
    const id = _rbCellId(rowIndex, c);
    _rbSetGridStyleProp(id, "height", heightValue);
    _rbSetGridStyleProp(id, "overflow", "hidden");
    _rbSetGridStyleProp(id, "padding-top", padValue);
    _rbSetGridStyleProp(id, "padding-bottom", padValue);
    _rbSetGridStyleProp(id, "line-height", lineHeightValue);
    _rbSetGridStyleProp(id, "font-size", fontSizeValue);
  }
  // خلية رقم الصف (العمود الرمادي الأول، class="jss_row") عنصر منفصل تمامًا
  // خارج records[] — ما تصلها الحلقة أعلاه لأنه ما إلها cell id عادي (A1..).
  // بدونها تبقى محتفظة بارتفاعها الافتراضي وهي وحدها كافية لتكبير الصف كامل
  // رغم تصغير كل باقي الخلايا. نطبّق عليها نفس الخصائص مباشرة عبر style.
  const rowEl = _rbJssInstance.rows && _rbJssInstance.rows[rowIndex] && _rbJssInstance.rows[rowIndex].element;
  const rowNumberCell = rowEl && rowEl.children && rowEl.children[0];
  if (rowNumberCell) {
    rowNumberCell.style.height = heightValue;
    rowNumberCell.style.overflow = "hidden";
    rowNumberCell.style.paddingTop = padValue;
    rowNumberCell.style.paddingBottom = padValue;
    rowNumberCell.style.lineHeight = lineHeightValue;
    rowNumberCell.style.fontSize = fontSizeValue;
  }
}

// يربط _rbMerges (كانت غير مرسومة فعليًا على گريد jexcel من المرحلة 1) بـ
// setMerge الرسمية — يُستدعى بعد كل إعادة بناء كاملة للگريد، بنفس منطق
// _rbReapplyAllStyles أعلاه.
function _rbReapplyAllMerges() {
  if (!_rbJssInstance) return;
  for (const m of _rbMerges) {
    const s = _rbParseCellId(m.start), e = _rbParseCellId(m.end);
    if (!s || !e) continue;
    const colspan = Math.abs(e.col - s.col) + 1;
    const rowspan = Math.abs(e.row - s.row) + 1;
    if (colspan > 1 || rowspan > 1) {
      try { _rbJssInstance.setMerge(m.start, colspan, rowspan); } catch (err) { /* تجاهل */ }
    }
  }
}

// يحوّل قيمة خام محسوبة (رقم/نص) إلى نص العرض حسب format الخلية، دون
// تغيير القيمة المخزَّنة نفسها (raw/value يبقيان كما هما لأي حساب لاحق).
// currencySymbol: نص حر اختياري (مثل "DZD"، "MAD"، "EUR") يُستعمل فقط
// لتنسيق "عملة"؛ فارغ/غير معرَّف = رقم منسّق بدون أي رمز عملة.
// decimals: عدد الخانات العشرية للتنسيقات الرقمية (number/currency/percentage)،
// افتراضيًا 2 لو لم يُحدَّد (نفس السلوك السابق بالضبط قبل هذه الميزة — لا
// breaking change لقوالب قديمة لا تملك decimals محفوظة).
function _rbFormatValue(value, format, currencySymbol, decimals) {
  if (!format || format === "text" || value === "" || value == null) return value;
  if (typeof value === "string" && /^#/.test(value)) return value; // أخطاء (#خطأ:...) تُعرض كما هي

  if (format === "number" || format === "currency" || format === "percentage") {
    let n = typeof value === "number" ? value : parseFloat(String(value).replace(",", "."));
    if (isNaN(n)) return value;
    if (format === "percentage") n = n * 100;
    const dec = Number.isInteger(decimals) ? Math.min(6, Math.max(0, decimals)) : 2;
    // toLocaleString("fr-FR") يفصل الآلاف بمسافة رفيعة جدًا (U+202F narrow
    // no-break space) — بالخطوط العادية تظهر شبه غير مرئية فيبدو الرقم
    // كتلة واحدة بلا فواصل واضحة. نستبدلها بمسافة غير فاصلة عادية (U+00A0)
    // أوسع وأوضح بصريًا، وبتضمن كمان عدم انكسار الرقم بمنتصفه عند التفاف
    // النص (خلافًا للمسافة العادية Space).
    const formatted = n.toLocaleString("fr-FR", { minimumFractionDigits: dec, maximumFractionDigits: dec })
      .replace(/\u202F/g, "\u00A0");
    if (format === "currency") {
      const sym = (currencySymbol || "").trim();
      return sym ? `${formatted} ${sym}` : formatted;
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

// ══════════════════════════════════════════════════════════════
// بناء/رسم الشبكة
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// المرحلة 1: الگريد مبني الآن على Jspreadsheet CE (jexcel) بدل <table>
// يدوي. التنسيق البصري/الدمج/الإخفاء/التجميد/fill handle/format painter/
// تغيير الحجم اليدوي كلها مؤجَّلة لمراحل لاحقة (انظر رأس الملف) — الأزرار
// المرتبطة بها تبقى موجودة لكن بلا أثر بصري حاليًا لأنها تستهدف DOM جدول
// قديم لم يعد موجودًا.
// ══════════════════════════════════════════════════════════════

// يبني مصفوفة القيم المعروضة (cell.value المحسوبة، بلا تنسيق أنماط بعد)
function _rbBuildJexcelData() {
  const data = [];
  for (let r = 0; r < _rbRows; r++) {
    const row = [];
    for (let c = 0; c < _rbCols; c++) {
      const cell = _rbCellsData[_rbCellId(r, c)];
      row.push(cell ? String(cell.value ?? "") : "");
    }
    data.push(row);
  }
  return data;
}

function _rbBuildJexcelColumns() {
  const columns = [];
  for (let c = 0; c < _rbCols; c++) {
    columns.push({ type: "text", title: _rbColLetters(c), width: _rbColWidths[c] || _RB_DEFAULT_COL_WIDTH });
  }
  return columns;
}

// يبني كائن الـcallbacks (onchange/onselection/oneditionstart...) الذي
// يُمرَّر لـjexcel عند الإنشاء — يعادل وظيفيًا "ربط أحداث الگريد" السابقة.
function _rbWireGridEvents() {
  return {
    onchange: function (instance, cell, x, y, value) {
      const id = _rbCellId(parseInt(y, 10), parseInt(x, 10));
      _rbCommitCellFormula(id, value); // نفس الدالة/التوقيع الحاليين حرفيًا
      // jexcel يُعيد ضبط white-space بمنطقه الداخلي الخاص بـwordWrap عند كل
      // تعديل لقيمة الخلية (updateCell)، فيمحو تفافنا اليدوي (wrap). نُعيد
      // تطبيق تنسيق هذه الخلية فورًا بعد onchange حتى يبقى _rbStyles[id]
      // (وخاصة wrap) المصدر النهائي دائمًا، وليس فقط بعد renderGrid.
      const savedStyle = _rbStyles[id];
      if (savedStyle) {
        const css = _rbStyleCss(savedStyle);
        if (css) _rbSetGridStylesBatch({ [id]: css });
      }
      // نفس منطق wrap أعلاه: jexcel قد يعيد ضبط padding/line-height/font-size
      // المطبَّقة يدويًا لصف مضغوط (_rbApplyRowCellPadding) عند updateCell.
      // إن كان لهذا الصف ارتفاع محفوظ في _rbRowHeights نُعيد تطبيق التنسيق
      // فورًا حتى لا يعود مظهر الصف لطبيعته الافتراضية بعد أي تعديل خلية.
      const rowIdx = parseInt(y, 10);
      if (Number.isFinite(rowIdx) && _rbRowHeights[rowIdx] != null) {
        _rbApplyRowCellPadding(rowIdx, parseInt(_rbRowHeights[rowIdx], 10));
      }
    },
    // عند بدء تحرير خلية: jexcel يضع افتراضيًا القيمة المحسوبة (value) داخل
    // حقل التحرير، بينما نريد إظهار الصيغة الخام (raw) كسلوك Excel. يضع
    // jexcel قيمته بعد هذا الحدث مباشرة (نفس دورة الحدث المتزامنة)، لذا
    // التبديل يجب أن يحدث في اللحظة التالية (microtask/0ms) لا داخل الحدث نفسه.
    // كما نُظهر زر "fx" العائم (formulaWizard.js) هنا تحديدًا — هذا هو حدث
    // jexcel الفعلي/الحالي لبدء تحرير خلية (بدل أي مستمع DOM قديم سابق
    // للمرحلة 1 كان يستهدف عناصر لم تعد موجودة).
    oneditionstart: function (instance, cellEl, x, y) {
      const id = _rbCellId(parseInt(y, 10), parseInt(x, 10));
      const cellData = _rbCellsData[id];
      const raw = cellData ? (cellData.raw ?? "") : "";
      if (typeof _fwShowButton === "function") _fwShowButton(cellEl, id);
      setTimeout(() => {
        const input = cellEl.querySelector("input, textarea");
        if (!input) return;
        input.value = raw;
        input.focus();
        const len = input.value.length;
        try { input.setSelectionRange(len, len); } catch (e2) { /* تجاهل (بعض الحقول لا تدعمها) */ }
      }, 0);
    },
    // يُبقي _rbSelectedCells/_rbSelStart/_rbSelEnd متزامنة مع تحديد jexcel
    // الفعلي (تُستعمل لاحقًا من أزرار التنسيق في مراحل قادمة).
    onselection: function (instance, colStart, rowStart, colEnd, rowEnd) {
      const c0 = Math.min(colStart, colEnd), c1 = Math.max(colStart, colEnd);
      const r0 = Math.min(rowStart, rowEnd), r1 = Math.max(rowStart, rowEnd);
      _rbSelStart = _rbCellId(r0, c0);
      _rbSelEnd = _rbCellId(r1, c1);
      _rbSelectedCells = new Set();
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) _rbSelectedCells.add(_rbCellId(r, c));
      }
      // زر fx يظهر لخلية مفردة فقط قيد التحرير الفعلي (oneditionstart أعلاه)
      // — إن اتسع التحديد الحالي لأكثر من خلية واحدة (سحب تحديد نطاق مثلاً)
      // فهذا لم يعد سياق تحرير خلية مفردة، فنجدول إخفاءه (بنفس منطق
      // _fwScheduleHideButton الحالي — تأخير بسيط يسمح بأي نقرة مباشرة على
      // الزر نفسه قبل أن يختفي).
      const isSingleCell = (c1 - c0 === 0) && (r1 - r0 === 0);
      if (!isSingleCell && typeof _fwScheduleHideButton === "function") _fwScheduleHideButton();
      // حقلا "عرض/ارتفاع" بالشريط العلوي يجب أن يتفعّلا/يتحدّثا فورًا مع كل
      // تحديد جديد، لا فقط بعد إعادة رسم كاملة للگريد.
      if (typeof _rbSyncDimToolbarInputs === "function") _rbSyncDimToolbarInputs();
    },
    // فقدان تركيز الگريد بالكامل (نقرة خارج أي خلية) — نفس منطق إخفاء fx
    // المجدوَل أعلاه، عبر حدث onblur الفعلي/الحالي لـjexcel.
    onblur: function () {
      if (typeof _fwScheduleHideButton === "function") _fwScheduleHideButton();
    },
    // يُبقي _rbRows/_rbCols متزامنَين مع أي تغيير بنيوي يُطلقه jexcel نفسه
    // (مثل التوسعة التلقائية عند لصق نص يتجاوز حدود الگريد الحالية).
    oninsertrow: function (instance) { if (_rbJssInstance) _rbRows = _rbJssInstance.options.data.length; },
    ondeleterow: function (instance) { if (_rbJssInstance) _rbRows = _rbJssInstance.options.data.length; },
    oninsertcolumn: function (instance) { if (_rbJssInstance) _rbCols = _rbJssInstance.options.columns.length; },
    ondeletecolumn: function (instance) { if (_rbJssInstance) _rbCols = _rbJssInstance.options.columns.length; },
  };
}

function _rbRenderGrid() {
  const wrap = document.getElementById("rbGridWrap");
  if (!wrap) return;

  // إعادة بناء كاملة من الصفر في كل مرة (بدل sync جزئي) — تطابق سلوك
  // إعادة الرسم الكامل السابق عبر innerHTML، وتضمن أن rbUndo/rbRedo/
  // _rbApplySnapshot تعمل بإعادة إنشاء الگريد بالكامل من البيانات المستعادة.
  if (wrap.jspreadsheet) {
    try { jspreadsheet.destroy(wrap); } catch (e) { /* تجاهل */ }
  }
  _rbJssInstance = null;
  wrap.innerHTML = "";

  const events = _rbWireGridEvents();

  // ملاحظة مهمة: هذا الإصدار من Jspreadsheet CE (5.x) يفصل بين خيارات
  // "الورقة" (worksheet) وخيارات الجدول العلوية (spreadsheet/top-level
  // config). خيارات مثل data/columns/minDimensions/columnSorting/columnDrag/
  // columnResize/rowDrag/rowResize يجب أن تكون داخل عنصر مصفوفة worksheets،
  // بينما parseFormulas/allowExport/about وكل الـcallbacks (onchange،
  // onselection...) تبقى على المستوى العلوي. تمرير data/columns مباشرة على
  // المستوى العلوي (دون worksheets) يجعل config.worksheets غير معرَّف
  // فيرمي jspreadsheet.js الخطأ "JSS: worksheets are not defined".
  jspreadsheet(wrap, Object.assign({
    worksheets: [{
      data: _rbBuildJexcelData(),
      columns: _rbBuildJexcelColumns(),
      minDimensions: [_rbCols, _rbRows],
      columnSorting: false,
      columnDrag: false,
      columnResize: false, // تغيير الحجم اليدوي عبر واجهتنا مؤجَّل لمرحلة لاحقة
      rowDrag: false,
      rowResize: false,
    }],
    // لا تدع jexcel يحسب الصيغ بمحركه الخاص — _rbComputeCell/formulaEngine.js
    // وحدهما مسؤولان عن الحساب؛ raw قد يبدأ بـ"=" ويجب أن يبقى نصًا خامًا
    // بالنسبة لـjexcel نفسه.
    parseFormulas: false,
    allowExport: false,
    about: false,
    onload: function (instance) {
      _rbJssInstance = instance.worksheets[0];
      _rbReapplyAllStyles();
      _rbReapplyAllMerges();
      _rbReapplyAllRowHeights();
      _rbApplyHiddenMarkers();
      _rbReapplyAllRotations();
    },
  }, events));
  _rbApplyHideGridlinesClass();
}

// إخفاء/إظهار خطوط الشبكة الافتراضية لـjexcel — يضيف/يزيل class على
// #rbGridWrap (الحاوية الأب). لا يمس الحدود المخصصة (_rbStyles[id].border)
// لأن قاعدة CSS المقابلة (.rb-hide-gridlines...) مبنية بـspecificity أعلى
// من قاعدة الحدود الافتراضية بدل !important، فتبقى الحدود المخصَّصة inline
// (المُطبَّقة عبر setStyle) الأقوى دائمًا وتظهر فوق الإخفاء.
function _rbApplyHideGridlinesClass() {
  const wrap = document.getElementById("rbGridWrap");
  if (!wrap) return;
  wrap.classList.toggle("rb-hide-gridlines", !!_rbHideGridlines);
}

function rbToggleHideGridlines() {
  _rbHideGridlines = !_rbHideGridlines;
  _rbApplyHideGridlinesClass();
  const btn = document.getElementById("btnRbHideGridlines");
  if (btn) btn.classList.toggle("rb-toolbar-btn-on", _rbHideGridlines);
  addNotif(_rbHideGridlines ? "تم إخفاء خطوط الشبكة ✓" : "تم إظهار خطوط الشبكة ✓", "success");
  _rbPushHistory();
}

// ── سحب حد رأس عمود/صف لتغيير العرض/الارتفاع (تفاعل شبيه بـExcel) ──
function _rbWireResizeHandles() {
  const table = document.getElementById("rbGridTable");
  if (!table) return;

  table.querySelectorAll(".rb-col-resizer").forEach(handle => {
    handle.addEventListener("mousedown", e => {
      e.preventDefault(); e.stopPropagation();
      const c = parseInt(handle.dataset.col, 10);
      const startX = e.clientX;
      const colEl = table.querySelector(`colgroup col[data-col-index="${c}"]`);
      const startWidth = (colEl && colEl.offsetWidth) || _rbColWidths[c] || _RB_DEFAULT_COL_WIDTH;
      const onMove = ev => {
        const newWidth = Math.max(1, Math.round(startWidth + (ev.clientX - startX)));
        if (colEl) colEl.style.width = newWidth + "px";
        _rbColWidths[c] = newWidth;
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        _rbPushHistory();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });

  table.querySelectorAll(".rb-row-resizer").forEach(handle => {
    handle.addEventListener("mousedown", e => {
      e.preventDefault(); e.stopPropagation();
      const r = parseInt(handle.dataset.row, 10);
      const startY = e.clientY;
      const tr = table.querySelector(`tbody tr[data-row-index="${r}"]`);
      const startHeight = (tr && tr.offsetHeight) || _rbRowHeights[r] || _RB_DEFAULT_ROW_HEIGHT;
      const onMove = ev => {
        const newHeight = Math.max(1, Math.round(startHeight + (ev.clientY - startY)));
        if (tr) tr.style.height = newHeight + "px";
        _rbRowHeights[r] = newHeight;
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        _rbPushHistory();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}

// ══════════════════════════════════════════════════════════════
// مقبض التعبئة (Fill Handle) — مربع صغير بالزاوية اليمنى السفلى من
// التحديد الحالي، يُسحب لنسخ محتوى/تنسيق/صيغة على خلايا مجاورة أفقيًا
// أو عموديًا فقط (مثل Excel)، مع تعديل مراجع الخلايا نسبيًا داخل الصيغ.
// ══════════════════════════════════════════════════════════════

// كلمات DSL التي تُشبه شكليًا مرجع خلية (حرف+رقم) لكنها ليست مرجعًا
// فعليًا — يجب استثناؤها من إعادة الترقيم عند سحب مقبض التعبئة.
const _RB_FILL_REF_EXCLUDE = new Set(["PACK1", "PACK2", "PACK3"]);

// يعيد إنشاء/إرجاع عنصر مقبض التعبئة (نفس نمط _fwEnsureFxBtn في
// formulaWizard.js: يتحقق من isConnected لأن rbGridWrap يُعاد رسمه بالكامل
// عند أي تعديل، ما يفصل العنصر المخزَّن سابقًا عن الـDOM الفعلي).
function _rbEnsureFillHandle() {
  if (_rbFillHandleEl && _rbFillHandleEl.isConnected) return _rbFillHandleEl;
  _rbFillHandleEl = null;
  const wrap = document.getElementById("rbGridWrap");
  if (!wrap) return null;
  const handle = document.createElement("div");
  handle.id = "rbFillHandle";
  handle.className = "rb-fill-handle";
  handle.title = "اسحب لتعبئة الخلايا المجاورة";
  wrap.appendChild(handle);
  _rbFillHandleEl = handle;
  _rbWireFillHandleDrag(handle);
  return handle;
}

// يموضع مقبض التعبئة عند الزاوية اليمنى السفلى لآخر خلية بالتحديد
// الحالي (أو يخفيه إن لم يوجد تحديد صالح أو أثناء السحب النشط لتعبئة أخرى).
function _rbPositionFillHandle() {
  const handle = _rbEnsureFillHandle();
  if (!handle) return;
  if (!_rbSelStart || !_rbSelEnd || _rbFillDragging) {
    if (!_rbFillDragging) handle.style.display = "none";
    return;
  }
  const s = _rbParseCellId(_rbSelStart), e = _rbParseCellId(_rbSelEnd);
  const r1 = Math.max(s.row, e.row), c1 = Math.max(s.col, e.col);
  const table = document.getElementById("rbGridTable");
  const td = table ? table.querySelector(`td[data-cell="${_rbCellId(r1, c1)}"]`) : null;
  if (!td) { handle.style.display = "none"; return; }
  handle.style.top = Math.max(0, td.offsetTop + td.offsetHeight - 4) + "px";
  handle.style.left = Math.max(0, td.offsetLeft + td.offsetWidth - 4) + "px";
  handle.style.display = "block";
}

function _rbWireFillHandleDrag(handle) {
  handle.addEventListener("mousedown", e => {
    if (e.button !== 0 || !_rbSelStart || !_rbSelEnd) return;
    e.preventDefault(); e.stopPropagation();
    const s = _rbParseCellId(_rbSelStart), en = _rbParseCellId(_rbSelEnd);
    _rbFillSourceRange = {
      r0: Math.min(s.row, en.row), c0: Math.min(s.col, en.col),
      r1: Math.max(s.row, en.row), c1: Math.max(s.col, en.col),
    };
    _rbFillExtRange = null;
    _rbFillDirection = null;
    _rbFillDragging = true;

    const onMove = ev => _rbFillHandleDragMove(ev);
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      _rbFillHandleDragEnd();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// أثناء السحب: يحدد اتجاه التعبئة (أفقي/عمودي فقط، حسب أكبر إزاحة) ويعاين
// نطاق التمديد بتظليل الخلايا المستهدفة.
function _rbFillHandleDragMove(ev) {
  if (!_rbFillDragging || !_rbFillSourceRange) return;
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const td = el ? el.closest("td[data-cell]") : null;
  if (!td) return;
  const p = _rbParseCellId(td.dataset.cell);
  if (!p) return;

  const src = _rbFillSourceRange;
  const rowDist = p.row < src.r0 ? src.r0 - p.row : (p.row > src.r1 ? p.row - src.r1 : 0);
  const colDist = p.col < src.c0 ? src.c0 - p.col : (p.col > src.c1 ? p.col - src.c1 : 0);

  let ext = null, dir = null;
  if (rowDist === 0 && colDist === 0) {
    ext = null; dir = null; // داخل نطاق المصدر نفسه: لا معاينة
  } else if (colDist > rowDist) {
    if (p.col > src.c1) { ext = { r0: src.r0, r1: src.r1, c0: src.c1 + 1, c1: p.col }; dir = "right"; }
    else { ext = { r0: src.r0, r1: src.r1, c0: p.col, c1: src.c0 - 1 }; dir = "left"; }
  } else {
    if (p.row > src.r1) { ext = { r0: src.r1 + 1, r1: p.row, c0: src.c0, c1: src.c1 }; dir = "down"; }
    else { ext = { r0: p.row, r1: src.r0 - 1, c0: src.c0, c1: src.c1 }; dir = "up"; }
  }

  _rbFillExtRange = ext;
  _rbFillDirection = dir;
  _rbRenderFillPreview();
}

function _rbRenderFillPreview() {
  const table = document.getElementById("rbGridTable");
  if (!table) return;
  table.querySelectorAll("td.rb-fill-preview").forEach(td => td.classList.remove("rb-fill-preview"));
  const ext = _rbFillExtRange;
  if (!ext) return;
  for (let r = ext.r0; r <= ext.r1; r++) {
    for (let c = ext.c0; c <= ext.c1; c++) {
      const td = table.querySelector(`td[data-cell="${_rbCellId(r, c)}"]`);
      if (td) td.classList.add("rb-fill-preview");
    }
  }
}

// عند رفع الفأرة: يطبّق التعبئة فعليًا (إن وُجد نطاق تمديد صالح)، ثم ينظّف
// حالة السحب ويعيد رسم الشبكة.
function _rbFillHandleDragEnd() {
  const src = _rbFillSourceRange, ext = _rbFillExtRange, dir = _rbFillDirection;
  _rbFillDragging = false;
  document.querySelectorAll("#rbGridTable td.rb-fill-preview").forEach(td => td.classList.remove("rb-fill-preview"));

  if (src && ext && dir) {
    _rbApplyFillHandle(src, ext, dir);
    // التحديد بعد التعبئة يشمل النطاق الكامل (مصدر + تمديد)، كسلوك Excel
    const r0 = Math.min(src.r0, ext.r0), c0 = Math.min(src.c0, ext.c0);
    const r1 = Math.max(src.r1, ext.r1), c1 = Math.max(src.c1, ext.c1);
    _rbSelStart = _rbCellId(r0, c0);
    _rbSelEnd = _rbCellId(r1, c1);
    _rbApplySelectionHighlight();
  }
  _rbFillSourceRange = null;
  _rbFillExtRange = null;
  _rbFillDirection = null;
}

// يعدّل مراجع الخلايا (مثل A1) داخل نص صيغة نسبيًا بمقدار (rowDelta,
// colDelta)، مع تجاهل النصوص بين علامتي اقتباس والكلمات المستثناة
// (pack1/pack2/pack3). إن لم تكن raw صيغة (لا تبدأ بـ"=") تُعاد كما هي حرفيًا.
function _rbShiftFormulaRefs(raw, rowDelta, colDelta) {
  if (typeof raw !== "string" || !raw.trim().startsWith("=")) return raw;
  if (rowDelta === 0 && colDelta === 0) return raw;
  return raw.replace(/("(?:[^"\\]|\\.)*")|(\b[A-Za-z]{1,3}[0-9]+\b)/g, (match, quoted, ref) => {
    if (quoted) return quoted;
    if (_RB_FILL_REF_EXCLUDE.has(ref.toUpperCase())) return ref;
    const p = _rbParseCellId(ref);
    if (!p) return ref;
    const newRow = p.row + rowDelta;
    const newCol = p.col + colDelta;
    if (newRow < 0 || newCol < 0) return ref; // لا نطاق سالب: أبقِ المرجع كما هو
    return _rbCellId(newRow, newCol);
  });
}

// يعدّل مراجع الخلايا داخل نص صيغة عند إدراج/حذف صف أو عمود عند atIndex
// (delta=+1 إدراج، delta=-1 حذف). المراجع التي تساوي atIndex عند الحذف
// تتحول إلى "#REF!". يدعم نفس استثناءات _rbShiftFormulaRefs (نصوص بين
// علامتي اقتباس والكلمات المستثناة).
function _rbShiftFormulaRefsForInsertDelete(raw, kind, atIndex, delta) {
  if (typeof raw !== "string" || !raw.trim().startsWith("=")) return raw;
  return raw.replace(/("(?:[^"\\]|\\.)*")|(\b[A-Za-z]{1,3}[0-9]+\b)/g, (match, quoted, ref) => {
    if (quoted) return quoted;
    if (_RB_FILL_REF_EXCLUDE.has(ref.toUpperCase())) return ref;
    const p = _rbParseCellId(ref);
    if (!p) return ref;
    const idx = kind === "row" ? p.row : p.col;
    if (delta > 0) {
      if (idx >= atIndex) {
        return kind === "row" ? _rbCellId(p.row + 1, p.col) : _rbCellId(p.row, p.col + 1);
      }
      return ref;
    } else {
      if (idx === atIndex) return "#REF!";
      if (idx > atIndex) {
        return kind === "row" ? _rbCellId(p.row - 1, p.col) : _rbCellId(p.row, p.col - 1);
      }
      return ref;
    }
  });
}

// يطبّق التعبئة الفعلية: لكل خلية بنطاق التمديد، يجد خليتها "المصدر" المقابلة
// (بتكرار نمط نطاق المصدر إن كان أكبر من خلية واحدة)، وينسخ raw + النمط،
// مع تعديل مراجع الصيغة نسبيًا حسب المسافة الفعلية بين الخليتين.
function _rbApplyFillHandle(src, ext, dir) {
  const sh = src.r1 - src.r0 + 1, sw = src.c1 - src.c0 + 1;
  const affected = [];

  const fillOne = (r, c, sourceRow, sourceCol) => {
    const targetId = _rbCellId(r, c);
    const sourceId = _rbCellId(sourceRow, sourceCol);
    const sourceCell = _rbCellsData[sourceId];
    const rowDelta = r - sourceRow, colDelta = c - sourceCol;

    if (!sourceCell || sourceCell.raw == null || sourceCell.raw === "") {
      delete _rbCellsData[targetId];
    } else {
      const newRaw = _rbShiftFormulaRefs(sourceCell.raw, rowDelta, colDelta);
      const result = _rbComputeCell(newRaw);
      _rbCellsData[targetId] = { raw: newRaw, value: result.value, error: result.error || null };
    }

    if (_rbStyles[sourceId]) _rbStyles[targetId] = JSON.parse(JSON.stringify(_rbStyles[sourceId]));
    else delete _rbStyles[targetId];

    affected.push(targetId);
  };

  if (dir === "down") {
    for (let r = ext.r0; r <= ext.r1; r++) {
      const sourceRow = src.r0 + ((r - ext.r0) % sh);
      for (let c = ext.c0; c <= ext.c1; c++) fillOne(r, c, sourceRow, c);
    }
  } else if (dir === "up") {
    for (let r = ext.r1; r >= ext.r0; r--) {
      const offsetFromEnd = ext.r1 - r;
      const sourceRow = src.r1 - (offsetFromEnd % sh);
      for (let c = ext.c0; c <= ext.c1; c++) fillOne(r, c, sourceRow, c);
    }
  } else if (dir === "right") {
    for (let c = ext.c0; c <= ext.c1; c++) {
      const sourceCol = src.c0 + ((c - ext.c0) % sw);
      for (let r = ext.r0; r <= ext.r1; r++) fillOne(r, c, r, sourceCol);
    }
  } else if (dir === "left") {
    for (let c = ext.c1; c >= ext.c0; c--) {
      const offsetFromEnd = ext.c1 - c;
      const sourceCol = src.c1 - (offsetFromEnd % sw);
      for (let r = ext.r0; r <= ext.r1; r++) fillOne(r, c, r, sourceCol);
    }
  }

  _rbRenderGrid(); // يعيد رسم الشبكة كاملة (أبسط وأضمن من تحديث كل خلية يدويًا)
  const visited = new Set();
  for (const id of affected) _rbRecomputeDependents(id, visited);
  _rbPushHistory(); // خطوة Undo/Redo واحدة لكامل عملية السحب، وليس لكل خلية
}

// ══════════════════════════════════════════════════════════════
// تحديد رأس عمود/صف كامل (نقر على الحرف A/B.. أو رقم الصف)، بدعم
// Ctrl+click (إضافة/إزالة رأس منفرد) وShift+click (مدى متجاور من الرؤوس).
// ══════════════════════════════════════════════════════════════

function _rbWireHeaderEvents() {
  const table = document.getElementById("rbGridTable");
  if (!table) return;

  table.querySelectorAll("th.rb-col-header").forEach(th => {
    const c = parseInt(th.dataset.col, 10);
    th.addEventListener("click", e => {
      if (e.target.classList.contains("rb-col-resizer")) return;
      _rbSelectColumn(c, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
      _rbFormatPainterMaybeApply();
    });
    th.addEventListener("contextmenu", e => {
      e.preventDefault();
      if (!_rbSelectedHeaderCols.has(c)) _rbSelectColumn(c, {});
      _rbShowHeaderContextMenu(e, "col", c);
    });
  });

  table.querySelectorAll("th.rb-row-header").forEach(th => {
    const r = parseInt(th.dataset.row, 10);
    th.addEventListener("click", e => {
      if (e.target.classList.contains("rb-row-resizer")) return;
      _rbSelectRow(r, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
      _rbFormatPainterMaybeApply();
    });
    th.addEventListener("contextmenu", e => {
      e.preventDefault();
      if (!_rbSelectedHeaderRows.has(r)) _rbSelectRow(r, {});
      _rbShowHeaderContextMenu(e, "row", r);
    });
  });

  const corner = table.querySelector("th[data-corner]");
  if (corner) {
    corner.addEventListener("click", () => {
      _rbSelectedHeaderCols = new Set(Array.from({ length: _rbCols }, (_, i) => i));
      _rbSelectedHeaderRows = new Set();
      _rbLastHeaderCol = null; _rbLastHeaderRow = null;
      _rbSyncHeaderSelection();
      _rbFormatPainterMaybeApply();
    });
  }
}

function _rbSelectColumn(c, { ctrl, shift } = {}) {
  if (shift && _rbLastHeaderCol != null) {
    const c0 = Math.min(_rbLastHeaderCol, c), c1 = Math.max(_rbLastHeaderCol, c);
    for (let cc = c0; cc <= c1; cc++) _rbSelectedHeaderCols.add(cc);
  } else if (ctrl) {
    if (_rbSelectedHeaderCols.has(c)) _rbSelectedHeaderCols.delete(c);
    else _rbSelectedHeaderCols.add(c);
    _rbLastHeaderCol = c;
  } else {
    _rbSelectedHeaderCols = new Set([c]);
    _rbLastHeaderCol = c;
  }
  _rbSelectedHeaderRows = new Set(); _rbLastHeaderRow = null;
  _rbSyncHeaderSelection();
}

function _rbSelectRow(r, { ctrl, shift } = {}) {
  if (shift && _rbLastHeaderRow != null) {
    const r0 = Math.min(_rbLastHeaderRow, r), r1 = Math.max(_rbLastHeaderRow, r);
    for (let rr = r0; rr <= r1; rr++) _rbSelectedHeaderRows.add(rr);
  } else if (ctrl) {
    if (_rbSelectedHeaderRows.has(r)) _rbSelectedHeaderRows.delete(r);
    else _rbSelectedHeaderRows.add(r);
    _rbLastHeaderRow = r;
  } else {
    _rbSelectedHeaderRows = new Set([r]);
    _rbLastHeaderRow = r;
  }
  _rbSelectedHeaderCols = new Set(); _rbLastHeaderCol = null;
  _rbSyncHeaderSelection();
}

// يبني _rbSelectedCells من رؤوس الأعمدة/الصفوف المحددة حاليًا، ويُطبّق
// نفس آلية التمييز البصري المستعملة للتحديد العادي (rb-selected)، بحيث
// تعمل كل أزرار التنسيق الحالية (لون/حدود/bold/format/دمج/حذف محتوى)
// تلقائيًا دون أي تعديل عليها — فهي مبنية أصلاً على _rbSelectedCells.
function _rbSyncHeaderSelection() {
  _rbSelStart = null; _rbSelEnd = null;
  const set = new Set();
  for (const c of _rbSelectedHeaderCols) for (let r = 0; r < _rbRows; r++) set.add(_rbCellId(r, c));
  for (const r of _rbSelectedHeaderRows) for (let c = 0; c < _rbCols; c++) set.add(_rbCellId(r, c));
  _rbSelectedCells = set;
  // "الخلية النشطة" (تُستعمل مثلاً كمصدر لنسخ التنسيق) = أول خلية في التحديد
  if (set.size) { const first = [...set][0]; _rbSelStart = first; _rbSelEnd = first; }

  const table = document.getElementById("rbGridTable");
  if (table) {
    table.querySelectorAll("td.rb-selected").forEach(td => td.classList.remove("rb-selected"));
    table.querySelectorAll("th.rb-header-selected").forEach(th => th.classList.remove("rb-header-selected"));
    set.forEach(id => {
      const td = table.querySelector(`td[data-cell="${id}"]`);
      if (td) td.classList.add("rb-selected");
    });
    table.querySelectorAll("th.rb-col-header").forEach(th => {
      if (_rbSelectedHeaderCols.has(Number(th.dataset.col))) th.classList.add("rb-header-selected");
    });
    table.querySelectorAll("th.rb-row-header").forEach(th => {
      if (_rbSelectedHeaderRows.has(Number(th.dataset.row))) th.classList.add("rb-header-selected");
    });
  }
  _rbSyncFormatDropdownFromSelection();
}

// ══════════════════════════════════════════════════════════════
// نسخ التنسيق (Format Painter): يحفظ تنسيق الخلية النشطة كمصدر، ثم
// يُطبَّق على أول تحديد تالٍ (نقرة خلية مفردة أو تحديد رأس عمود/صف)،
// ويُلغى وضع النسخ تلقائيًا بعد التطبيق.
// ══════════════════════════════════════════════════════════════

function rbActivateFormatPainter() {
  if (!_rbSelStart) { addNotif("حدد خلية أولاً (المصدر الذي سيُنسخ تنسيقه)", "warning"); return; }
  _rbFormatPainterStyle = JSON.parse(JSON.stringify(_rbStyles[_rbSelStart] || {}));
  _rbFormatPainterActive = true;
  document.getElementById("btnRbFormatPainter")?.classList.add("rb-toolbar-btn-on");
  addNotif("🖌 انقر خلية أو حدد نطاقًا/رأس عمود أو صف لتطبيق التنسيق", "info");
}

// يُستدعى بعد كل عملية "تحديد" جديدة صادرة عن نقرة المستخدم (وليس أثناء
// السحب المستمر) — إن كان وضع النسخ مفعّلاً، يُطبّق التنسيق المحفوظ على
// التحديد الحالي (المحتوى نفسه لا يُلمَس، فقط _rbStyles) ثم يُلغي الوضع.
function _rbFormatPainterMaybeApply() {
  if (!_rbFormatPainterActive || !_rbSelectedCells.size) return;
  for (const id of _rbSelectedCells) {
    _rbStyles[id] = JSON.parse(JSON.stringify(_rbFormatPainterStyle || {}));
  }
  _rbFormatPainterActive = false;
  document.getElementById("btnRbFormatPainter")?.classList.remove("rb-toolbar-btn-on");
  _rbRenderGrid();
  addNotif("تم تطبيق التنسيق المنسوخ ✓", "success");
  _rbPushHistory();
}

// ══════════════════════════════════════════════════════════════
// تجميد الصف الأول/العمود الأول (Freeze Panes)
// ══════════════════════════════════════════════════════════════

function rbToggleFreezeRow() {
  _rbFreezeRow = !_rbFreezeRow;
  _rbApplyFreezePanes();
  _rbUpdateFreezeButtonsState();
  _rbPushHistory();
}
function rbToggleFreezeCol() {
  _rbFreezeCol = !_rbFreezeCol;
  _rbApplyFreezePanes();
  _rbUpdateFreezeButtonsState();
  _rbPushHistory();
}
function _rbUpdateFreezeButtonsState() {
  document.getElementById("btnRbFreezeRow")?.classList.toggle("rb-toolbar-btn-on", _rbFreezeRow);
  document.getElementById("btnRbFreezeCol")?.classList.toggle("rb-toolbar-btn-on", _rbFreezeCol);
}

// يُطبَّق بعد كل _rbRenderGrid: يضع position:sticky (بإزاحات محسوبة
// فعليًا من أبعاد رأس الجدول/العمود المرسومة، لا قيمًا ثابتة) على خلايا
// الصف الأول (tbody tr[data-row-index="0"]) و/أو أول خلية بيانات فعلية
// في كل صف (العمود الأول)، حسب حالتَي _rbFreezeRow/_rbFreezeCol.
function _rbApplyFreezePanes() {
  const table = document.getElementById("rbGridTable");
  if (!table) return;
  table.querySelectorAll("[data-freeze]").forEach(el => {
    el.style.position = ""; el.style.top = ""; el.style.left = ""; el.style.zIndex = ""; el.style.background = "";
    el.removeAttribute("data-freeze");
  });
  if (!_rbFreezeRow && !_rbFreezeCol) return;

  const theadRow = table.querySelector("thead tr");
  const headHeight = theadRow ? theadRow.getBoundingClientRect().height : 27;
  const firstRowHeaderTh = table.querySelector("tbody th.rb-row-header");
  const rowHeaderWidth = firstRowHeaderTh ? firstRowHeaderTh.getBoundingClientRect().width : 34;

  const freeze = (td, top, left) => {
    td.style.position = "sticky";
    if (top != null) td.style.top = top;
    if (left != null) td.style.left = left;
    td.style.background = "var(--bg2)";
    td.style.zIndex = (td.style.top && td.style.left) ? "3" : "2";
    td.setAttribute("data-freeze", "1");
  };

  if (_rbFreezeCol) {
    table.querySelectorAll("tbody tr").forEach(tr => {
      const firstTd = tr.querySelector("td"); // أول خلية بيانات فعليًا مرسومة (تراعي الخلايا المغطاة بدمج)
      if (firstTd) freeze(firstTd, null, rowHeaderWidth + "px");
    });
  }
  if (_rbFreezeRow) {
    const firstTr = table.querySelector('tbody tr[data-row-index="0"]');
    if (firstTr) firstTr.querySelectorAll("td").forEach(td => freeze(td, headHeight + "px", null));
  }
}

// ══════════════════════════════════════════════════════════════
// إعادة ترقيم مُعرِّف خلية عند إدراج/حذف صف أو عمود عند فهرس مُعيَّن
// (delta=+1 إدراج، delta=-1 حذف). يُرجع null إن كانت الخلية هي بالضبط
// الصف/العمود المحذوف (يجب إسقاطها).
// ══════════════════════════════════════════════════════════════
function _rbRemapCellId(id, kind, atIndex, delta) {
  const p = _rbParseCellId(id);
  if (!p) return null;
  if (kind === "row") {
    let newRow = p.row;
    if (delta > 0) { if (p.row >= atIndex) newRow = p.row + 1; }
    else { if (p.row === atIndex) return null; if (p.row > atIndex) newRow = p.row - 1; }
    return _rbCellId(newRow, p.col);
  } else {
    let newCol = p.col;
    if (delta > 0) { if (p.col >= atIndex) newCol = p.col + 1; }
    else { if (p.col === atIndex) return null; if (p.col > atIndex) newCol = p.col - 1; }
    return _rbCellId(p.row, newCol);
  }
}

// إدراج صف/عمود فارغ عند atIndex، مع إعادة ترقيم كل البيانات (محتوى،
// تنسيق، دمج، إخفاء، أبعاد) التي تقع بعد نقطة الإدراج.
function _rbInsertRowCol(kind, atIndex) {
  if (kind === "row") _rbRows++; else _rbCols++;

  const remapMap = (src) => {
    const out = {};
    for (const [id, val] of Object.entries(src)) {
      const nid = _rbRemapCellId(id, kind, atIndex, +1);
      if (nid) out[nid] = val;
    }
    return out;
  };
  _rbCellsData = remapMap(_rbCellsData);
  _rbStyles = remapMap(_rbStyles);
  _rbMerges = _rbMerges.map(m => {
    const s = _rbRemapCellId(m.start, kind, atIndex, +1);
    const e = _rbRemapCellId(m.end, kind, atIndex, +1);
    return (s && e) ? { start: s, end: e } : null;
  }).filter(Boolean);

  if (kind === "row") {
    const newHidden = new Set();
    for (const r of _rbHiddenRows) newHidden.add(r >= atIndex ? r + 1 : r);
    _rbHiddenRows = newHidden;
    const newHeights = {};
    for (const [r, h] of Object.entries(_rbRowHeights)) {
      const rn = Number(r); newHeights[rn >= atIndex ? rn + 1 : rn] = h;
    }
    _rbRowHeights = newHeights;
  } else {
    const newHidden = new Set();
    for (const c of _rbHiddenCols) newHidden.add(c >= atIndex ? c + 1 : c);
    _rbHiddenCols = newHidden;
    const newWidths = {};
    for (const [c, w] of Object.entries(_rbColWidths)) {
      const cn = Number(c); newWidths[cn >= atIndex ? cn + 1 : cn] = w;
    }
    _rbColWidths = newWidths;
  }

  const affected = [];
  for (const [id, cell] of Object.entries(_rbCellsData)) {
    if (cell && typeof cell.raw === "string" && cell.raw.trim().startsWith("=")) {
      const newRaw = _rbShiftFormulaRefsForInsertDelete(cell.raw, kind, atIndex, +1);
      if (newRaw !== cell.raw) {
        const result = _rbComputeCell(newRaw);
        _rbCellsData[id] = { raw: newRaw, value: result.value, error: result.error || null };
        affected.push(id);
      }
    }
  }

  _rbSelStart = null; _rbSelEnd = null; _rbSelectedCells = new Set();
  _rbSelectedHeaderCols = new Set(); _rbSelectedHeaderRows = new Set();
  const visited = new Set();
  for (const id of affected) _rbRecomputeDependents(id, visited);
  _rbRenderGrid();
  _rbPushHistory();
}

// حذف صف/عمود بأكمله عند atIndex، مع إعادة ترقيم كل ما يقع بعده.
function _rbDeleteRowColAt(kind, atIndex) {
  if (kind === "row" && _rbRows <= 1) { addNotif("لا يمكن حذف آخر صف", "warning"); return; }
  if (kind === "col" && _rbCols <= 1) { addNotif("لا يمكن حذف آخر عمود", "warning"); return; }

  const remapMap = (src) => {
    const out = {};
    for (const [id, val] of Object.entries(src)) {
      const nid = _rbRemapCellId(id, kind, atIndex, -1);
      if (nid) out[nid] = val;
    }
    return out;
  };
  _rbCellsData = remapMap(_rbCellsData);
  _rbStyles = remapMap(_rbStyles);
  _rbMerges = _rbMerges.map(m => {
    const s = _rbRemapCellId(m.start, kind, atIndex, -1);
    const e = _rbRemapCellId(m.end, kind, atIndex, -1);
    return (s && e) ? { start: s, end: e } : null;
  }).filter(Boolean);

  if (kind === "row") {
    const newHidden = new Set();
    for (const r of _rbHiddenRows) { if (r === atIndex) continue; newHidden.add(r > atIndex ? r - 1 : r); }
    _rbHiddenRows = newHidden;
    const newHeights = {};
    for (const [r, h] of Object.entries(_rbRowHeights)) {
      const rn = Number(r); if (rn === atIndex) continue; newHeights[rn > atIndex ? rn - 1 : rn] = h;
    }
    _rbRowHeights = newHeights;
    _rbRows--;
  } else {
    const newHidden = new Set();
    for (const c of _rbHiddenCols) { if (c === atIndex) continue; newHidden.add(c > atIndex ? c - 1 : c); }
    _rbHiddenCols = newHidden;
    const newWidths = {};
    for (const [c, w] of Object.entries(_rbColWidths)) {
      const cn = Number(c); if (cn === atIndex) continue; newWidths[cn > atIndex ? cn - 1 : cn] = w;
    }
    _rbColWidths = newWidths;
    _rbCols--;
  }

  const affected = [];
  for (const [id, cell] of Object.entries(_rbCellsData)) {
    if (cell && typeof cell.raw === "string" && cell.raw.trim().startsWith("=")) {
      const newRaw = _rbShiftFormulaRefsForInsertDelete(cell.raw, kind, atIndex, -1);
      if (newRaw !== cell.raw) {
        const result = _rbComputeCell(newRaw);
        _rbCellsData[id] = { raw: newRaw, value: result.value, error: result.error || null };
        affected.push(id);
      }
    }
  }

  _rbSelStart = null; _rbSelEnd = null; _rbSelectedCells = new Set();
  _rbSelectedHeaderCols = new Set(); _rbSelectedHeaderRows = new Set();
  const visited = new Set();
  for (const id of affected) _rbRecomputeDependents(id, visited);
  _rbRenderGrid();
  _rbPushHistory();
}

// ══════════════════════════════════════════════════════════════
// قائمة سياق (Right-click) على رأس عمود/صف: إدراج قبل/بعد، حذف،
// إخفاء/إظهار، وفتح حقل إدخال دقيق للعرض/الارتفاع (px).
// ══════════════════════════════════════════════════════════════

function _rbEnsureContextMenuEl() {
  let el = document.getElementById("rbContextMenu");
  if (el) return el;
  el = document.createElement("div");
  el.id = "rbContextMenu";
  el.className = "rb-context-menu";
  el.style.display = "none";
  document.body.appendChild(el);
  document.addEventListener("mousedown", e => {
    if (el.style.display !== "none" && !el.contains(e.target)) _rbHideContextMenu();
  });
  return el;
}

function _rbHideContextMenu() {
  const el = document.getElementById("rbContextMenu");
  if (el) el.style.display = "none";
}

function _rbShowHeaderContextMenu(e, kind, index) {
  const el = _rbEnsureContextMenuEl();
  const isCol = kind === "col";
  const label = isCol ? "العمود" : "الصف";
  const multi = isCol ? _rbSelectedHeaderCols.size > 1 : _rbSelectedHeaderRows.size > 1;
  const dimLabel = isCol ? "عرض العمود..." : "ارتفاع الصف...";
  const hiddenSet = isCol ? _rbHiddenCols : _rbHiddenRows;
  const isHidden = hiddenSet.has(index);

  el.innerHTML = `
    <div class="rb-context-item" data-action="insert-before">↥ إدراج ${label} قبل</div>
    <div class="rb-context-item" data-action="insert-after">↧ إدراج ${label} بعد</div>
    <div class="rb-context-sep"></div>
    <div class="rb-context-item" data-action="dim">${dimLabel}${multi ? " (كل المحدد)" : ""}</div>
    <div class="rb-context-item" data-action="toggle-hide">${isHidden ? "👁 إظهار" : "🚫 إخفاء"}${multi ? " (كل المحدد)" : ""}</div>
    <div class="rb-context-sep"></div>
    <div class="rb-context-item rb-context-item--danger" data-action="delete">🗑 حذف هذا ${label}</div>
  `;
  el.style.display = "block";
  el.style.left = Math.min(e.clientX, window.innerWidth - 220) + "px";
  el.style.top = Math.min(e.clientY, window.innerHeight - 220) + "px";

  el.querySelectorAll(".rb-context-item").forEach(item => {
    item.addEventListener("click", () => {
      const action = item.dataset.action;
      _rbHideContextMenu();
      if (action === "insert-before") _rbInsertRowCol(kind, index);
      else if (action === "insert-after") _rbInsertRowCol(kind, index + 1);
      else if (action === "delete") _rbDeleteRowColAt(kind, index);
      else if (action === "toggle-hide") {
        if (isCol) rbToggleHideSelectedCols(); else rbToggleHideSelectedRows();
      } else if (action === "dim") {
        _rbShowDimensionPopup(kind, e.clientX, e.clientY);
      }
    });
  });
}

function _rbEnsureDimPopupEl() {
  let el = document.getElementById("rbDimPopup");
  if (el) return el;
  el = document.createElement("div");
  el.id = "rbDimPopup";
  el.className = "rb-dim-popup";
  el.style.display = "none";
  el.innerHTML = `<label id="rbDimPopupLabel"></label><input type="number" id="rbDimPopupInput" min="1" step="1">`;
  document.body.appendChild(el);
  document.addEventListener("mousedown", e => {
    if (el.style.display !== "none" && !el.contains(e.target)) el.style.display = "none";
  });
  return el;
}

// يستخرج مجموعتي الأعمدة/الصفوف "الفعّالة" للتحديد الحالي: إن كان هناك
// تحديد رؤوس صريح (_rbSelectedHeaderCols/Rows، عبر النقر على رأس عمود/صف)
// يُستعمل كما هو؛ وإلا يُشتق من نطاق الخلايا العادي المحدد حاليًا
// (_rbSelectedCells) عبر تفكيك كل معرّف خلية لصف/عمودها. يُستعمل هذا في
// حقلي "العرض/الارتفاع" بالشريط العلوي، حتى يعملا مع أي تحديد خلايا عادي
// وليس فقط تحديد رأس عمود/صف كامل.
function _rbGetEffectiveColsRows() {
  if (_rbSelectedHeaderCols.size || _rbSelectedHeaderRows.size) {
    return { cols: new Set(_rbSelectedHeaderCols), rows: new Set(_rbSelectedHeaderRows) };
  }
  const cols = new Set(), rows = new Set();
  for (const id of _rbSelectedCells) {
    const p = _rbParseCellId(id);
    if (p) { cols.add(p.col); rows.add(p.row); }
  }
  return { cols, rows };
}

// يطبّق عرضًا (px) بالبكسل على كل الأعمدة الواقعة ضمن التحديد الحالي
// (رؤوس أعمدة محددة، أو الأعمدة التي تقع ضمنها الخلايا المحددة عاديًا).
function rbApplyWidthToSelection(px) {
  const n = parseInt(px, 10);
  if (!Number.isFinite(n) || n < 1) return;
  const { cols } = _rbGetEffectiveColsRows();
  if (!cols.size) { addNotif("حدد عمودًا أو خلايا أولاً", "warning"); return; }
  for (const c of cols) _rbColWidths[c] = n;
  _rbRenderGrid();
  _rbPushHistory();
}

// نفس المنطق أعلاه للارتفاع (الصفوف) — بخلاف العرض (يُطبَّق عبر
// columns[].width ضمن إعادة بناء الگريد الكاملة في _rbBuildJexcelColumns)،
// الارتفاع لم يكن يُمرَّر إطلاقًا لإعدادات worksheet عند البناء، فتخزينه في
// _rbRowHeights وحده لا يُحدث أي أثر بصري. الأصح والأخف هو استدعاء الدالة
// العامة الموثّقة jexcel setHeight(rowIndex, px) مباشرة على كل صف متأثر —
// تُطبَّق فورًا (بدون إعادة رسم/تدمير كاملة للگريد تفقد معها التحديد/التركيز
// الحاليين)، وتعمل فعليًا مع jspreadsheet-ce 5.0.4 المثبتة.
function rbApplyHeightToSelection(px) {
  const n = parseInt(px, 10);
  if (!Number.isFinite(n) || n < 1) return;
  const { rows } = _rbGetEffectiveColsRows();
  if (!rows.size) { addNotif("حدد صفًا أو خلايا أولاً", "warning"); return; }
  for (const r of rows) {
    _rbRowHeights[r] = n;
    if (_rbJssInstance) { try { _rbJssInstance.setHeight(r, n); } catch (e) { /* تجاهل */ } }
    _rbApplyRowCellPadding(r, n);
  }
  _rbPushHistory();
}

// يحدّث حقلي العرض/الارتفاع بالشريط العلوي (تفعيل/تعطيل + قيمة معروضة)
// تبعًا للتحديد الحالي — يُستدعى عند أي تغيّر بالتحديد (خلايا أو رؤوس).
function _rbSyncDimToolbarInputs() {
  const widthInput = document.getElementById("rbToolbarWidthInput");
  const heightInput = document.getElementById("rbToolbarHeightInput");
  if (!widthInput && !heightInput) return;
  const { cols, rows } = _rbGetEffectiveColsRows();

  if (widthInput) {
    widthInput.disabled = !cols.size;
    if (cols.size) {
      const widths = new Set([...cols].map(c => _rbColWidths[c] || _RB_DEFAULT_COL_WIDTH));
      widthInput.value = widths.size === 1 ? [...widths][0] : "";
    } else {
      widthInput.value = "";
    }
  }
  if (heightInput) {
    heightInput.disabled = !rows.size;
    if (rows.size) {
      const heights = new Set([...rows].map(r => _rbRowHeights[r] || _RB_DEFAULT_ROW_HEIGHT));
      heightInput.value = heights.size === 1 ? [...heights][0] : "";
    } else {
      heightInput.value = "";
    }
  }
}


// فور الضغط Enter (أو مغادرة الحقل). إن كان أكثر من رأس محدد حاليًا،
// يُطبَّق نفس العرض/الارتفاع على كل الرؤوس المحددة دفعة واحدة.
function _rbShowDimensionPopup(kind, x, y) {
  const el = _rbEnsureDimPopupEl();
  const isCol = kind === "col";
  const indices = isCol ? [..._rbSelectedHeaderCols] : [..._rbSelectedHeaderRows];
  const current = indices.length
    ? (isCol ? (_rbColWidths[indices[0]] || _RB_DEFAULT_COL_WIDTH) : (_rbRowHeights[indices[0]] || _RB_DEFAULT_ROW_HEIGHT))
    : (isCol ? _RB_DEFAULT_COL_WIDTH : _RB_DEFAULT_ROW_HEIGHT);

  document.getElementById("rbDimPopupLabel").textContent = isCol ? "عرض العمود (px):" : "ارتفاع الصف (px):";
  const input = document.getElementById("rbDimPopupInput");
  input.value = current;
  el.style.display = "flex";
  el.style.left = Math.min(x, window.innerWidth - 200) + "px";
  el.style.top = Math.min(y, window.innerHeight - 80) + "px";
  input.focus(); input.select();

  const apply = () => {
    const px = parseInt(input.value, 10);
    if (!Number.isFinite(px) || px < 1) { el.style.display = "none"; return; }
    for (const idx of indices) {
      if (isCol) _rbColWidths[idx] = px; else _rbRowHeights[idx] = px;
    }
    el.style.display = "none";
    _rbRenderGrid();
    _rbPushHistory();
  };
  input.onkeydown = ev => {
    if (ev.key === "Enter") { ev.preventDefault(); apply(); }
    if (ev.key === "Escape") { ev.preventDefault(); el.style.display = "none"; }
  };
  input.onblur = () => apply();
}

// "ضبط أبعاد افتراضية" — يعيد كل الأعمدة/الصفوف المحددة حاليًا (عبر رأس
// العمود/الصف) لعرض/ارتفاع القيمة الافتراضية، بإزالة أي تخصيص سابق لها.
function rbResetSelectedDimensions() {
  if (!_rbSelectedHeaderCols.size && !_rbSelectedHeaderRows.size) {
    addNotif("حدد رأس عمود أو صف واحد على الأقل أولاً", "warning");
    return;
  }
  for (const c of _rbSelectedHeaderCols) delete _rbColWidths[c];
  for (const r of _rbSelectedHeaderRows) delete _rbRowHeights[r];
  _rbRenderGrid();
  addNotif("تمت إعادة الأبعاد الافتراضية ✓", "success");
  _rbPushHistory();
}


// ملاحظة: _rbWireGridEvents الفعلية أصبحت أعلى الملف (بجانب _rbRenderGrid)
// وتُرجع كائن callbacks يُمرَّر مباشرة لـjexcel عند الإنشاء، بدل التسجيل
// اليدوي لمستمعات addEventListener على كل td هنا.
//
// اللصق (Ctrl+V) لم يعد يحتاج تدخّلًا يدويًا: jexcel يتعامل معه أصلًا بشكل
// أصيل (يفصل Tab بين الأعمدة وSatr جديد بين الصفوف، يوسّع الگريد تلقائيًا
// عند الحاجة، ويُطلق onchange لكل خلية ملصوقة — وهو ما يمرّ مباشرة عبر
// _rbCommitCellFormula الحالية بلا أي كود إضافي). _rbIsDragging/تحديد
// النطاق بالسحب أصبحا أيضًا من مسؤولية jexcel الداخلية.

function _rbHandleGridPaste(e) {
  const modal = document.getElementById("reportBuilderModal");
  if (!modal || modal.style.display === "none") return;

  // document.activeElement هو العنصر contenteditable نفسه دائمًا (وليس عقدة
  // نصية بداخله)، فهو المصدر الأوثق لتحديد الخلية النشطة. e.target قد يكون
  // Text node (عند وضع المؤشر داخل نص موجود مسبقًا بالخلية)، وTextنode لا
  // يملك closest؛ لذا نسقط لـe.target كبديل فقط، مع تحويله لعنصره الأب أولًا.
  const active = document.activeElement;
  let td = active && active.closest && active.closest("#rbGridWrap td[data-cell]");
  if (!td) {
    const targetEl = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
    td = targetEl && targetEl.closest && targetEl.closest("#rbGridWrap td[data-cell]");
  }
  if (!td) return; // ليس لصقًا داخل خلية من شبكة المصمم — اترك السلوك الافتراضي

  // نص خارجي حقيقي من الحافظة (Excel/Sheets ينسخان كـTab بين الأعمدة
  // وNewline بين الصفوف عند اللصق كـplain text). حدث paste القياسي هو
  // المصدر الوحيد هنا؛ لا يوجد نظام نسخ/لصق داخلي منفصل بين خلايا
  // المصمم في هذا الملف (Ctrl+C/Ctrl+V هنا يستعملان أصلًا حافظة المتصفح
  // نفسها، فيمران عبر نفس هذا المسار دون أي تعارض).
  const text = (e.clipboardData || window.clipboardData)?.getData("text/plain");
  if (!text) return; // لا يوجد نص قابل للصق (قد تكون صورة مثلًا) — اترك الافتراضي

  e.preventDefault();

  // طبّع نهايات الأسطر، واحذف سطرًا أخيرًا فارغًا (Excel يضيف أحيانًا \n زائدة)
  let norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (norm.endsWith("\n")) norm = norm.slice(0, -1);
  const rows = norm.split("\n").map(line => line.split("\t"));
  if (!rows.length) return;

  const anchorId = td.dataset.cell;
  const anchor = _rbParseCellId(anchorId);

  // وسّع الگريد تلقائيًا إن تجاوزت البيانات الملصوقة الحدود الحالية
  const neededRows = anchor.row + rows.length;
  const neededCols = anchor.col + Math.max(...rows.map(r => r.length));
  if (neededRows > _rbRows) _rbRows = neededRows;
  if (neededCols > _rbCols) _rbCols = neededCols;

  // اكتب كل قيمة كنص خام عادي (raw) بدون تفسيرها كصيغة، حتى لو بدأت
  // بـ"="؛ لصق plain text من Excel يعطي أصلًا القيمة المحسوبة النهائية
  // وليس الصيغة، فتخزينها كنص كما هي هو السلوك الصحيح والمتوقع هنا
  // (مغاير عن الكتابة اليدوية داخل خلية، التي تُفسَّر عبر _rbCommitCellFormula).
  const pastedIds = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const value = rows[r][c];
      const id = _rbCellId(anchor.row + r, anchor.col + c);
      if (value === "") {
        delete _rbCellsData[id];
      } else {
        _rbCellsData[id] = { raw: value, value, error: null };
      }
      pastedIds.push(id);
    }
  }

  _rbRenderGrid();

  // أعد حساب أي خلايا صيغ متأثرة بالخلايا الملصوقة
  const visited = new Set();
  for (const id of pastedIds) _rbRecomputeDependents(id, visited);

  // حدد نطاق اللصق كاملًا (سلوك مألوف بعد اللصق، شبيه بـExcel)
  const lastId = _rbCellId(anchor.row + rows.length - 1, anchor.col + Math.max(...rows.map(r => r.length)) - 1);
  _rbSelStart = anchorId;
  _rbSelEnd = lastId;
  _rbApplySelectionHighlight();

  // خطوة واحدة في Undo/Redo لكامل عملية اللصق
  _rbPushHistory();
}

function _rbUpdateCellDisplayForce(cellId) {
  const td = _rbCellElement(cellId);
  if (!td) return;
  const cell = _rbCellsData[cellId];
  const cellStyle = _rbStyles[cellId] || {};
  const text = cell ? String(_rbFormatValue(cell.value ?? "", cellStyle.format, cellStyle.currencySymbol, cellStyle.decimals) ?? "") : "";
  _rbSetCellDisplayText(td, text, cellStyle.rotation);
  td.classList.toggle("rb-cell-error", !!(cell && cell.error));
}

// يُعيد تطبيق التدوير (rotation) على كل خلية محفوظ لها rotation في
// _rbStyles — يُستدعى بعد كل إعادة بناء كاملة للگريد (onload في
// _rbRenderGrid)، بنفس منطق _rbReapplyAllStyles/_rbReapplyAllMerges أعلاه،
// لأن jexcel يُنشئ خلايا جديدة بنص خام (غير مُغلَّف بـspan التدوير).
function _rbReapplyAllRotations() {
  if (!_rbJssInstance) return;
  for (const id of Object.keys(_rbStyles)) {
    const rotation = _rbStyles[id] && _rbStyles[id].rotation;
    if (rotation) _rbUpdateCellDisplayForce(id);
  }
}

function _rbSelectSingle(id) {
  _rbSelStart = id;
  _rbSelEnd = id;
  _rbSelectedHeaderCols = new Set(); _rbSelectedHeaderRows = new Set();
  _rbLastHeaderCol = null; _rbLastHeaderRow = null;
  document.querySelectorAll("#rbGridTable th.rb-header-selected").forEach(th => th.classList.remove("rb-header-selected"));
  _rbApplySelectionHighlight();
}

function _rbApplySelectionHighlight() {
  const table = document.getElementById("rbGridTable");
  if (!table) return;
  table.querySelectorAll("td.rb-selected").forEach(td => td.classList.remove("rb-selected"));
  _rbSelectedCells = new Set();
  if (!_rbSelStart || !_rbSelEnd) { _rbSyncFormatDropdownFromSelection(); _rbPositionFillHandle(); return; }

  const s = _rbParseCellId(_rbSelStart), e = _rbParseCellId(_rbSelEnd);
  const r0 = Math.min(s.row, e.row), r1 = Math.max(s.row, e.row);
  const c0 = Math.min(s.col, e.col), c1 = Math.max(s.col, e.col);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const id = _rbCellId(r, c);
      _rbSelectedCells.add(id);
      const td = table.querySelector(`td[data-cell="${id}"]`);
      if (td) td.classList.add("rb-selected");
    }
  }
  _rbSyncFormatDropdownFromSelection();
  _rbPositionFillHandle();
}

// يضيف/يزيل خلية فردية من التحديد الحالي دون مسح بقية التحديد (Ctrl/Cmd+click)
function _rbToggleCellInSelection(id) {
  _rbSelectedHeaderCols = new Set(); _rbSelectedHeaderRows = new Set();
  _rbLastHeaderCol = null; _rbLastHeaderRow = null;
  document.querySelectorAll("#rbGridTable th.rb-header-selected").forEach(th => th.classList.remove("rb-header-selected"));
  const table = document.getElementById("rbGridTable");
  const td = table ? table.querySelector(`td[data-cell="${id}"]`) : null;
  if (_rbSelectedCells.has(id)) {
    _rbSelectedCells.delete(id);
    if (td) td.classList.remove("rb-selected");
  } else {
    _rbSelectedCells.add(id);
    if (td) td.classList.add("rb-selected");
  }
  // اجعل هذه الخلية "الخلية النشطة" (لعمليات لاحقة مثل إخفاء الصف/العمود)
  _rbSelStart = id;
  _rbSelEnd = id;
  _rbSyncFormatDropdownFromSelection();
}

// ══════════════════════════════════════════════════════════════
// أزرار: صف/عمود، دمج، تلوين/Bold
// ══════════════════════════════════════════════════════════════

function rbAddRow() {
  _rbRows++;
  if (_rbJssInstance) _rbJssInstance.insertRow();
  else _rbRenderGrid();
  _rbPushHistory();
}
function rbAddCol() {
  _rbCols++;
  if (_rbJssInstance) _rbJssInstance.insertColumn();
  else _rbRenderGrid();
  _rbPushHistory();
}

function rbDeleteRow() {
  if (_rbRows <= 1) return;
  const lastRow = _rbRows - 1;
  for (let c = 0; c < _rbCols; c++) delete _rbCellsData[_rbCellId(lastRow, c)];
  _rbMerges = _rbMerges.filter(m => {
    const s = _rbParseCellId(m.start), e = _rbParseCellId(m.end);
    return Math.max(s.row, e.row) < lastRow;
  });
  _rbHiddenRows.delete(lastRow);
  _rbRows--;
  // نستهدف دائمًا آخر صف تحديدًا (بغض النظر عن أي تحديد نشط في jexcel)،
  // بنفس السلوك الحرفي السابق تمامًا — فقط عبر API الخاص بـjexcel
  // (deleteRow(index, count)) بدل إعادة بناء الگريد بالكامل يدويًا.
  if (_rbJssInstance) _rbJssInstance.deleteRow(lastRow, 1);
  else _rbRenderGrid();
  _rbPushHistory();
}
function rbDeleteCol() {
  if (_rbCols <= 1) return;
  const lastCol = _rbCols - 1;
  for (let r = 0; r < _rbRows; r++) delete _rbCellsData[_rbCellId(r, lastCol)];
  _rbHiddenCols.delete(lastCol);
  _rbMerges = _rbMerges.filter(m => {
    const s = _rbParseCellId(m.start), e = _rbParseCellId(m.end);
    return Math.max(s.col, e.col) < lastCol;
  });
  _rbCols--;
  if (_rbJssInstance) _rbJssInstance.deleteColumn(lastCol, 1);
  else _rbRenderGrid();
  _rbPushHistory();
}

function rbMergeSelected() {
  if (_rbSelectedCells.size < 2) {
    addNotif("حدد أكثر من خلية أولاً (سحب الماوس أو Shift/Ctrl+نقر)", "warning");
    return;
  }
  // امنع تداخل مع دمج موجود مسبقًا داخل النطاق
  for (const id of _rbSelectedCells) {
    const covering = _rbFindCoveringMerge(id);
    if (covering) {
      addNotif("النطاق المحدد يتداخل مع دمج موجود مسبقًا", "warning");
      return;
    }
  }
  // نطاق الدمج = المستطيل المحيط بكل الخلايا المحددة حاليًا (يدعم أيضًا
  // تحديد Ctrl+click غير المتجاور بأخذ أصغر مستطيل يغطيه)
  let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
  for (const id of _rbSelectedCells) {
    const p = _rbParseCellId(id);
    if (!p) continue;
    r0 = Math.min(r0, p.row); r1 = Math.max(r1, p.row);
    c0 = Math.min(c0, p.col); c1 = Math.max(c1, p.col);
  }
  const start = _rbCellId(r0, c0);
  const end = _rbCellId(r1, c1);
  _rbMerges.push({ start, end });
  _rbRenderGrid();
  _rbPushHistory();
}

// إلغاء دمج: يبحث عن أي merge يتقاطع مع التحديد الحالي (_rbSelectedCells)
// ويحذفه من _rbMerges. الخلية الأساسية (start) تحتفظ بمحتواها، وبقية خلايا
// النطاق (التي كانت مخفية خلف الدمج) تُفرَّغ صراحة حتى لا تظهر بمحتوى
// قديم غير مقصود بعد أن تصبح منفصلة مجددًا.
function rbUnmergeSelected() {
  if (!_rbSelectedCells.size) {
    addNotif("حدد خلية أو نطاقًا يحتوي دمجًا أولاً", "warning");
    return;
  }
  const toRemove = new Set();
  for (const id of _rbSelectedCells) {
    const covering = _rbFindCoveringMerge(id);
    if (covering) toRemove.add(covering);
  }
  if (!toRemove.size) {
    addNotif("لا يوجد دمج ضمن التحديد الحالي", "warning");
    return;
  }
  for (const m of toRemove) {
    const s = _rbParseCellId(m.start), e = _rbParseCellId(m.end);
    const r0 = Math.min(s.row, e.row), r1 = Math.max(s.row, e.row);
    const c0 = Math.min(s.col, e.col), c1 = Math.max(s.col, e.col);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cid = _rbCellId(r, c);
        if (cid !== m.start) delete _rbCellsData[cid]; // فرّغ الخلايا غير الأساسية
      }
    }
  }
  _rbMerges = _rbMerges.filter(m => !toRemove.has(m));
  _rbRenderGrid();
  addNotif("تم إلغاء دمج الخلايا المحددة ✓", "success");
  _rbPushHistory();
}

function rbApplyBgColor(color) {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  for (const id of _rbSelectedCells) {
    _rbStyles[id] = { ..._rbStyles[id], bg: color };
    _rbSetGridStyleProp(id, "background", color);
  }
  _rbPushHistory();
}

// يفرّغ raw/value لكل خلايا التحديد الحالي دفعة واحدة، ويعيد حساب من يعتمد عليها
function rbClearSelectedContent() {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  const ids = [..._rbSelectedCells];
  for (const id of ids) {
    delete _rbCellsData[id];
    _rbUpdateCellDisplayForce(id);
  }
  for (const id of ids) _rbRecomputeDependents(id);
  addNotif("تم حذف محتوى الخلايا المحددة ✓", "success");
  _rbPushHistory();
}

function rbToggleBold() {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  const ids = [..._rbSelectedCells];
  const makeBold = !(_rbStyles[ids[0]] && _rbStyles[ids[0]].bold);
  for (const id of ids) {
    _rbStyles[id] = { ..._rbStyles[id], bold: makeBold };
    _rbSetGridStyleProp(id, "font-weight", makeBold ? "700" : "");
  }
  _rbPushHistory();
}

function rbToggleItalic() {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  const ids = [..._rbSelectedCells];
  const makeItalic = !(_rbStyles[ids[0]] && _rbStyles[ids[0]].italic);
  for (const id of ids) {
    _rbStyles[id] = { ..._rbStyles[id], italic: makeItalic };
    _rbSetGridStyleProp(id, "font-style", makeItalic ? "italic" : "");
  }
  _rbPushHistory();
}

function rbToggleUnderline() {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  const ids = [..._rbSelectedCells];
  const makeUnderline = !(_rbStyles[ids[0]] && _rbStyles[ids[0]].underline);
  for (const id of ids) {
    _rbStyles[id] = { ..._rbStyles[id], underline: makeUnderline };
    _rbSetGridStyleProp(id, "text-decoration", makeUnderline ? "underline" : "");
  }
  _rbPushHistory();
}

function rbSetTextAlign(align) {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  for (const id of _rbSelectedCells) {
    _rbStyles[id] = { ..._rbStyles[id], textAlign: align };
    _rbSetGridStyleProp(id, "text-align", align);
  }
  _rbPushHistory();
}

function rbSetVerticalAlign(align) {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  for (const id of _rbSelectedCells) {
    _rbStyles[id] = { ..._rbStyles[id], verticalAlign: align };
    _rbSetGridStyleProp(id, "vertical-align", align);
  }
  _rbPushHistory();
}

function rbApplyTextColor(color) {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  for (const id of _rbSelectedCells) {
    _rbStyles[id] = { ..._rbStyles[id], color };
    _rbSetGridStyleProp(id, "color", color);
  }
  _rbPushHistory();
}

function rbApplyFontSize(size) {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  const px = parseInt(size, 10);
  if (!px || px < 6 || px > 96) return;
  for (const id of _rbSelectedCells) {
    _rbStyles[id] = { ..._rbStyles[id], fontSize: px };
    _rbSetGridStyleProp(id, "font-size", px + "px");
  }
  _rbPushHistory();
}

// خط: قائمة منسدلة بخطوط شائعة + "افتراضي" (يحذف font-family المخصص).
// مخصص بالكامل — لا واجهة جاهزة مكافئة في jexcel، فيُبنى فوق setStyle كـCSS خام.
function rbApplyFontFamily(family) {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  const value = family && family !== "default" ? family : "";
  for (const id of _rbSelectedCells) {
    _rbStyles[id] = { ..._rbStyles[id], fontFamily: value || undefined };
    _rbSetGridStyleProp(id, "font-family", value);
  }
  _rbPushHistory();
}

// تدوير النص (rotation) — يُخزَّن كرقم بالدرجات في _rbStyles[id].rotation
// (0 = بدون تدوير، يُحذف حتى لا يُثقل القالب المحفوظ بقيم صفرية بلا فائدة).
// التطبيق الفعلي يتم عبر span.transform:rotate داخل _rbUpdateCellDisplay/
// _rbUpdateCellDisplayForce (وليس عبر setStyle/CSS على مستوى الـtd نفسه)،
// لأن تدوير الـtd كاملاً يُدوِّر أيضًا حدوده وخلفيته، بينما المطلوب تدوير
// محتوى النص فقط. ⚠️ التدوير قد يكسر بصريًا تركيبة wrap+rotation معًا في
// نفس الخلية (لا حل مثالي لكل تركيبة)، لكن لا كسر/خطأ صارخ لأي حالة مفردة.
function rbApplyRotation(deg) {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  const n = parseFloat(deg);
  const rotation = Number.isFinite(n) ? Math.max(-180, Math.min(180, n)) : 0;
  for (const id of _rbSelectedCells) {
    _rbStyles[id] = { ..._rbStyles[id], rotation: rotation || undefined };
    _rbUpdateCellDisplayForce(id);
  }
  _rbPushHistory();
}

// التفاف النص (wrap text) — جديد في المرحلة 2. لا خاصية جاهزة على مستوى
// الخلية في jexcel (wordWrap عندهم خيار عمود/جدول فقط عند الإنشاء)، فنبنيه
// كـCSS خام (white-space/word-wrap) فوق setStyle، بنفس آلية بقية الخواص.
function rbToggleWrap() {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  const ids = [..._rbSelectedCells];
  const makeWrap = !(_rbStyles[ids[0]] && _rbStyles[ids[0]].wrap);
  for (const id of ids) {
    _rbStyles[id] = { ..._rbStyles[id], wrap: makeWrap };
    if (makeWrap) {
      _rbSetGridStyleProp(id, "white-space", "normal");
      _rbSetGridStyleProp(id, "word-wrap", "break-word");
      _rbSetGridStyleProp(id, "overflow-wrap", "break-word");
    } else {
      _rbSetGridStyleProp(id, "white-space", "");
      _rbSetGridStyleProp(id, "word-wrap", "");
      _rbSetGridStyleProp(id, "overflow-wrap", "");
    }
  }
  _rbPushHistory();
}

// إلغاء صريح وغير مشروط للالتفاف (wrap=false) على كل الخلايا المحددة —
// بخلاف rbToggleWrap أعلاه (الذي يُقرِّر التبديل بناءً على حالة أول خلية
// محددة فقط)، هذا الزر يفرض "بدون التفاف" دائمًا بصرف النظر عن الحالة
// الحالية لكل خلية (مفيد عند تحديد نطاق مختلط: بعض خلاياه ملتفة وبعضها لا).
function rbClearWrap() {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  for (const id of _rbSelectedCells) {
    _rbStyles[id] = { ..._rbStyles[id], wrap: false };
    _rbSetGridStyleProp(id, "white-space", "");
    _rbSetGridStyleProp(id, "word-wrap", "");
    _rbSetGridStyleProp(id, "overflow-wrap", "");
  }
  _rbPushHistory();
}

// حدود على طراز إكسل (المرحلة 2) — مخصص بالكامل فوق setStyle (border-top/
// right/bottom/left حقيقية على كل خلية حدّية من التحديد، وليس box-shadow).
// type: "none" | "all" | "outer" | "top" | "bottom" | "left" | "right" |
//       "inner-h" (أفقي داخلي) | "inner-v" (عمودي داخلي)
// "محيط فقط" (outer) على مستطيل N×M يعني حدودًا خارجية فقط — بلا أي حد
// داخلي بين خليتين متجاورتين ضمن نفس التحديد.
function rbApplyBorder(type, color, thickness) {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  const ids = [..._rbSelectedCells];
  const c = color || "#888";
  const w = parseInt(thickness, 10) || 1;

  // أصغر مستطيل يغطي كل الخلايا المحددة (يدعم أيضًا تحديد Ctrl+click غير المتجاور)
  let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
  for (const id of ids) {
    const p = _rbParseCellId(id);
    if (!p) continue;
    r0 = Math.min(r0, p.row); r1 = Math.max(r1, p.row);
    c0 = Math.min(c0, p.col); c1 = Math.max(c1, p.col);
  }

  const side = ok => (ok ? { w, c } : null);
  const map = {};
  for (const id of ids) {
    const p = _rbParseCellId(id);
    if (!p) continue;
    let t = false, r = false, b = false, l = false;
    if (type === "all") {
      t = r = b = l = true;
    } else if (type === "outer") {
      t = p.row === r0; b = p.row === r1; l = p.col === c0; r = p.col === c1;
    } else if (type === "inner-h") {
      t = p.row > r0; b = p.row < r1;
    } else if (type === "inner-v") {
      l = p.col > c0; r = p.col < c1;
    } else if (type === "top") t = p.row === r0;
    else if (type === "bottom") b = p.row === r1;
    else if (type === "left") l = p.col === c0;
    else if (type === "right") r = p.col === c1;
    // "none": كل الجهات false => إزالة الحدود بالكامل من هذه الخلايا

    const border = (type === "none") ? "none" : { t: side(t), r: side(r), b: side(b), l: side(l) };
    _rbStyles[id] = { ..._rbStyles[id], border };

    // ⚠️ لازم "none" وليس نص فارغ: قيمة CSS فارغة (border-top:;) غير صالحة
    // فيتجاهلها المتصفّح تمامًا، فتبقى حدود jexcel الافتراضية (border-color:#ccc)
    // من jspreadsheet.css ظاهرة تحتها رغم "الإخفاء". "none" قيمة صريحة صحيحة
    // تتغلّب فعليًا على القاعدة الافتراضية.
    map[id] = ""
      + `border-top:${t ? `${w}px solid ${c}` : "none"};`
      + `border-right:${r ? `${w}px solid ${c}` : "none"};`
      + `border-bottom:${b ? `${w}px solid ${c}` : "none"};`
      + `border-left:${l ? `${w}px solid ${c}` : "none"};`;
  }
  _rbSetGridStylesBatch(map);
  _rbPushHistory();
}

// نوع المحتوى: "text" | "number" | "currency" | "percentage" | "date"
function rbApplyFormat(format) {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  // إكسل يحاذي الأرقام/العملة/النسب لليمين تلقائيًا؛ لا نغيّر محاذاة المستخدم
  // إن كان قد خصّصها يدويًا من قبل (existing textAlign محفوظ) — فقط الخلايا
  // التي لا تملك textAlign صريحًا بعد تأخذ الافتراضي المناسب لنوع المحتوى.
  const isNumericFormat = format === "number" || format === "currency" || format === "percentage";
  for (const id of _rbSelectedCells) {
    const prev = _rbStyles[id] || {};
    const textAlign = prev.textAlign != null ? prev.textAlign : (isNumericFormat ? "right" : "left");
    _rbStyles[id] = { ...prev, format, textAlign };
    _rbSetGridStyleProp(id, "text-align", textAlign);
    if (document.activeElement && document.activeElement.dataset && document.activeElement.dataset.cell === id) continue;
    _rbUpdateCellDisplayForce(id);
  }
  _rbPushHistory();
}

// اختصار العملة الحر (مثل DZD/MAD/EUR) المستعمل مع format="currency" فقط
// — فارغ افتراضيًا (يعني: رقم منسّق بدون رمز عملة). لا يُنشئ format
// تلقائيًا؛ فقط يُخزَّن كخاصية جاهزة عندما يُختار format="currency".
function rbApplyCurrencySymbol(symbol) {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  const currencySymbol = (symbol || "").trim();
  for (const id of _rbSelectedCells) {
    _rbStyles[id] = { ..._rbStyles[id], currencySymbol };
    if (document.activeElement && document.activeElement.dataset && document.activeElement.dataset.cell === id) continue;
    _rbUpdateCellDisplayForce(id);
  }
  _rbPushHistory();
}

// عدد الخانات العشرية (0-6) المستعمل مع format="number"/"currency"/"percentage"
// فقط — افتراضيًا 2 لو لم يُخزَّن شيء (نفس _rbFormatValue بالضبط)، فلا
// breaking change على قوالب قديمة لا تملك decimals محفوظة أصلاً.
function rbApplyDecimals(value) {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا أولاً", "warning"); return; }
  let n = parseInt(value, 10);
  if (isNaN(n)) n = 2;
  n = Math.min(6, Math.max(0, n));
  for (const id of _rbSelectedCells) {
    _rbStyles[id] = { ..._rbStyles[id], decimals: n };
    if (document.activeElement && document.activeElement.dataset && document.activeElement.dataset.cell === id) continue;
    _rbUpdateCellDisplayForce(id);
  }
  _rbPushHistory();
}


function _rbOpenFormatDropdown() {
  const panel = document.getElementById("rbFormatDropdownPanel");
  if (!panel) return;
  _rbSyncFormatDropdownFromSelection();
  panel.style.display = "block";
}
function _rbCloseFormatDropdown() {
  const panel = document.getElementById("rbFormatDropdownPanel");
  if (panel) panel.style.display = "none";
}
function _rbToggleFormatDropdown() {
  const panel = document.getElementById("rbFormatDropdownPanel");
  if (!panel) return;
  const isOpen = panel.style.display && panel.style.display !== "none";
  if (isOpen) _rbCloseFormatDropdown(); else _rbOpenFormatDropdown();
}

// يقرأ format/currencySymbol الحاليين للتحديد النشط (إن كانا موحّدين عبر
// كل الخلايا المحددة) ويحدّث نص الزر + تحديد الخيار المطابق + حقل رمز
// العملة تبعًا لذلك. يُستدعى عند فتح القائمة وعند تغيّر التحديد (خلية/نطاق
// مختلف) — هذا ما كان ناقصًا سابقًا ويجعل الحقل يعرض دومًا رمز آخر خلية
// عُدِّلت بدل رمز الخلية/الخلايا المحددة فعليًا حاليًا.
function _rbSyncFormatDropdownFromSelection() {
  _rbSyncDimToolbarInputs();
  const btn = document.getElementById("rbFormatDropdownBtn");
  const input = document.getElementById("rbCurrencySymbolInput");
  const panel = document.getElementById("rbFormatDropdownPanel");
  const decimalsRow = document.getElementById("rbDecimalsRow");
  const decimalsInput = document.getElementById("rbDecimalsInput");
  if (!btn) return;

  const labels = { text: "نص عادي", number: "رقم", currency: "عملة", date: "تاريخ", percentage: "نسبة مئوية" };
  const ids = [..._rbSelectedCells];

  if (!ids.length) {
    btn.textContent = "نوع المحتوى...";
    if (panel) panel.querySelectorAll(".rb-format-option").forEach(el => el.classList.remove("rb-format-option-selected"));
    if (input) input.value = "";
    if (decimalsRow) decimalsRow.style.display = "none";
    return;
  }

  const formats = new Set(ids.map(id => (_rbStyles[id] || {}).format || ""));
  const commonFormat = formats.size === 1 ? [...formats][0] : "";
  btn.textContent = (commonFormat && labels[commonFormat]) ? labels[commonFormat] : "نوع المحتوى...";

  if (panel) {
    panel.querySelectorAll(".rb-format-option").forEach(el => {
      el.classList.toggle("rb-format-option-selected", !!commonFormat && el.dataset.format === commonFormat);
    });
  }

  if (input) {
    if (commonFormat === "currency") {
      const symbols = new Set(ids.map(id => (_rbStyles[id] || {}).currencySymbol || ""));
      input.value = symbols.size === 1 ? [...symbols][0] : "";
    } else {
      input.value = "";
    }
  }

  // حقل عدد الخانات العشرية: يظهر فقط عند تنسيق رقمي مشترك (number/currency/percentage)
  const isNumericFormat = commonFormat === "number" || commonFormat === "currency" || commonFormat === "percentage";
  if (decimalsRow) decimalsRow.style.display = isNumericFormat ? "flex" : "none";
  if (decimalsInput && isNumericFormat) {
    const decimalsSet = new Set(ids.map(id => {
      const d = (_rbStyles[id] || {}).decimals;
      return Number.isInteger(d) ? d : 2;
    }));
    decimalsInput.value = decimalsSet.size === 1 ? [...decimalsSet][0] : "";
  }
}

// ══════════════════════════════════════════════════════════════
// إخفاء صف/عمود "عند التقرير فقط" — يبقى ظاهرًا هنا في المصمم (بنمط
// مميز) لكن reportViewer.js يتجاهل رسمه كليًا عند عرض/تصدير التقرير.
// ══════════════════════════════════════════════════════════════

// يبدّل حالة إخفاء كل الصفوف التي تغطيها الخلايا المحددة حاليًا (إظهار
// الكل إن كان أي منها ظاهرًا، أو إخفاء الكل إن كانت كلها مخفية أصلاً)
function rbToggleHideSelectedRows() {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا في الصف المطلوب أولاً", "warning"); return; }
  const rows = new Set([..._rbSelectedCells].map(id => _rbParseCellId(id).row));
  const anyVisible = [...rows].some(r => !_rbHiddenRows.has(r));
  for (const r of rows) { if (anyVisible) _rbHiddenRows.add(r); else _rbHiddenRows.delete(r); }
  _rbApplyHiddenMarkers();
  _rbRenderGrid();
  addNotif(anyVisible ? "تم إخفاء الصف عند التقرير ✓" : "تم إظهار الصف مجددًا ✓", "success");
  _rbPushHistory();
}

// نفس المنطق أعلاه لكن للأعمدة
function rbToggleHideSelectedCols() {
  if (!_rbSelectedCells.size) { addNotif("حدد خلية أو نطاقًا في العمود المطلوب أولاً", "warning"); return; }
  const cols = new Set([..._rbSelectedCells].map(id => _rbParseCellId(id).col));
  const anyVisible = [...cols].some(c => !_rbHiddenCols.has(c));
  for (const c of cols) { if (anyVisible) _rbHiddenCols.add(c); else _rbHiddenCols.delete(c); }
  _rbApplyHiddenMarkers();
  _rbRenderGrid();
  addNotif(anyVisible ? "تم إخفاء العمود عند التقرير ✓" : "تم إظهار العمود مجددًا ✓", "success");
  _rbPushHistory();
}

// ══════════════════════════════════════════════════════════════
// حفظ/تحميل Template (Firestore عبر /api/sync/custom-report-templates)
// ══════════════════════════════════════════════════════════════

async function _rbFetchTemplates() {
  try {
    const r = await fetch("/api/sync/custom-report-templates", { method: "GET", credentials: "include" });
    if (!r.ok) return [];
    const data = await r.json();
    return data?.templates || [];
  } catch (e) {
    console.warn("[reportBuilder] fetch templates failed:", e);
    return [];
  }
}

function _rbRenderTemplateSelect() {
  const sel = document.getElementById("rbTemplateSelect");
  if (!sel) return;
  sel.innerHTML = `<option value="">— تحميل قالب محفوظ —</option>` +
    _rbTemplates.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join("");
}

function rbLoadTemplate(id) {
  const t = _rbTemplates.find(x => x.id === id);
  if (!t) return;
  _rbCurrentTemplateId = id;
  _rbRows = t.rows || 10;
  _rbCols = t.cols || 10;
  _rbCellsData = t.cellsData ? migrateCellsDataFormulas(JSON.parse(JSON.stringify(t.cellsData))) : {};
  _rbMerges = t.merges ? JSON.parse(JSON.stringify(t.merges)) : [];
  _rbStyles = t.styles ? JSON.parse(JSON.stringify(t.styles)) : {};
  _rbHiddenRows = new Set(Array.isArray(t.hiddenRows) ? t.hiddenRows : []);
  _rbHiddenCols = new Set(Array.isArray(t.hiddenCols) ? t.hiddenCols : []);
  _rbColWidths = t.colWidths ? JSON.parse(JSON.stringify(t.colWidths)) : {};
  _rbRowHeights = t.rowHeights ? JSON.parse(JSON.stringify(t.rowHeights)) : {};
  _rbFreezeRow = !!t.freezeRow;
  _rbFreezeCol = !!t.freezeCol;
  _rbHideGridlines = !!t.hideGridlines;
  _rbSelStart = null; _rbSelEnd = null; _rbSelectedCells = new Set();
  _rbSelectedHeaderCols = new Set(); _rbSelectedHeaderRows = new Set();
  _rbUpdateSaveButtonState();
  _rbRenderGrid();
  _rbUpdateFreezeButtonsState();
  document.getElementById("btnRbHideGridlines")?.classList.toggle("rb-toolbar-btn-on", _rbHideGridlines);
  _rbResetHistory();
  addNotif(`تم تحميل القالب "${t.name}" ✓`, "success");
}

// يُفعّل/يُعطّل زر "حفظ" العادي حسب وجود قالب محمّل حاليًا (_rbCurrentTemplateId)
function _rbUpdateSaveButtonState() {
  const btn = document.getElementById("btnRbSave");
  if (!btn) return;
  btn.disabled = !_rbCurrentTemplateId;
  btn.style.display = _rbCurrentTemplateId ? "" : "none";
}

// "حفظ" — يحدّث القالب الحالي (PUT) بدون تغيير الاسم. إن لم يوجد قالب
// محمّل بعد (_rbCurrentTemplateId فارغ)، يتصرّف كـ"حفظ باسم".
async function rbSaveTemplate() {
  if (!_rbCurrentTemplateId) {
    await rbSaveTemplateAs();
    return;
  }
  const payload = {
    rows: _rbRows,
    cols: _rbCols,
    cellsData: _rbCellsData,
    merges: _rbMerges,
    styles: _rbStyles,
    hiddenRows: [..._rbHiddenRows],
    hiddenCols: [..._rbHiddenCols],
    colWidths: _rbColWidths,
    rowHeights: _rbRowHeights,
    freezeRow: _rbFreezeRow,
    freezeCol: _rbFreezeCol,
    hideGridlines: _rbHideGridlines,
  };
  try {
    const r = await fetch(`/api/sync/custom-report-templates/${_rbCurrentTemplateId}`, {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const saved = await r.json();
    _rbTemplates = _rbTemplates.map(t => t.id === saved.id ? saved : t);
    addNotif("تم حفظ التعديلات ✓", "success");
  } catch (e) {
    console.warn("[reportBuilder] save template failed:", e);
    addNotif("فشل حفظ التعديلات", "error");
  }
}

// "حذف" — يحذف القالب المحدد حاليًا في rbTemplateSelect (بعد تأكيد)، عبر
// DELETE /api/sync/custom-report-templates/:id، ثم يزيله من _rbTemplates.
// إن كان هو القالب المحمّل حاليًا في الگريد، يُفرّغ الگريد بالكامل.
async function rbDeleteTemplate() {
  const sel = document.getElementById("rbTemplateSelect");
  const id = sel?.value;
  if (!id) { addNotif("اختر قالبًا من القائمة أولاً", "warning"); return; }
  const t = _rbTemplates.find(x => x.id === id);
  const name = t ? t.name : id;
  if (!confirm(`تأكيد حذف القالب "${name}"؟ لا يمكن التراجع عن هذا الإجراء.`)) return;

  try {
    const r = await fetch(`/api/sync/custom-report-templates/${id}`, {
      method: "DELETE", credentials: "include",
    });
    if (!r.ok) throw new Error("HTTP " + r.status);

    _rbTemplates = _rbTemplates.filter(x => x.id !== id);
    _rbRenderTemplateSelect();

    if (_rbCurrentTemplateId === id) {
      // القالب المحذوف كان محمّلاً حاليًا في الگريد => فرّغه بالكامل
      _rbCurrentTemplateId = null;
      _rbRows = 10; _rbCols = 10;
      _rbCellsData = {}; _rbMerges = []; _rbStyles = {};
      _rbHiddenRows = new Set(); _rbHiddenCols = new Set();
      _rbColWidths = {}; _rbRowHeights = {};
      _rbFreezeRow = false; _rbFreezeCol = false;
      _rbHideGridlines = false;
      _rbSelStart = null; _rbSelEnd = null; _rbSelectedCells = new Set();
      _rbSelectedHeaderCols = new Set(); _rbSelectedHeaderRows = new Set();
      _rbUpdateSaveButtonState();
      _rbRenderGrid();
      _rbUpdateFreezeButtonsState();
      document.getElementById("btnRbHideGridlines")?.classList.remove("rb-toolbar-btn-on");
      _rbResetHistory();
    }
    if (sel) sel.value = "";
    addNotif(`تم حذف القالب "${name}" ✓`, "success");
  } catch (e) {
    console.warn("[reportBuilder] delete template failed:", e);
    addNotif("فشل حذف القالب", "error");
  }
}

async function rbSaveTemplateAs() {
  const nameInput = document.getElementById("rbTemplateNameInput");
  const name = nameInput?.value.trim();
  if (!name) { addNotif("أدخل اسم القالب أولاً", "warning"); return; }

  // منع تكرار اسم القالب لنفس المستخدم (مقارنة case-insensitive بعد trim)
  const nameLower = name.toLowerCase();
  const dup = _rbTemplates.some(t => String(t.name || "").trim().toLowerCase() === nameLower);
  if (dup) { addNotif("يوجد قالب بهذا الاسم مسبقًا، اختر اسمًا آخر", "warning"); return; }

  const payload = {
    name,
    rows: _rbRows,
    cols: _rbCols,
    cellsData: _rbCellsData,
    merges: _rbMerges,
    styles: _rbStyles,
    hiddenRows: [..._rbHiddenRows],
    hiddenCols: [..._rbHiddenCols],
    colWidths: _rbColWidths,
    rowHeights: _rbRowHeights,
    freezeRow: _rbFreezeRow,
    freezeCol: _rbFreezeCol,
    hideGridlines: _rbHideGridlines,
  };
  try {
    const r = await fetch("/api/sync/custom-report-templates", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const saved = await r.json();
    _rbTemplates.push(saved);
    _rbCurrentTemplateId = saved.id;
    _rbUpdateSaveButtonState();
    _rbRenderTemplateSelect();
    if (nameInput) nameInput.value = "";
    addNotif("تم حفظ القالب ✓", "success");
  } catch (e) {
    console.warn("[reportBuilder] save template failed:", e);
    addNotif("فشل حفظ القالب", "error");
  }
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
  if (!_rbCurrentTemplateId) _rbUpdateSaveButtonState(); // قالب فارغ جديد افتراضيًا
  // تحميل مسبق للفئات المخصصة (منتجات/بائعين/قوائم أسعار) عند فتح المصمم،
  // حتى تكون جاهزة داخل formulaWizard دون انتظار زيارة شاشة "إدارة الفئات".
  await _ensureCustomCategoriesLoaded();
  _rbRenderGrid();
  _rbUpdateFreezeButtonsState();
  _rbSyncDimToolbarInputs(); // تعطيل الحقلين افتراضيًا لحين وجود تحديد
  if (!_rbHistoryStack.length) _rbResetHistory(); // مكدس جديد فقط إن لم يكن هناك أصلاً (لا نصفّر تاريخ قالب محمّل مسبقًا عند إعادة الفتح)
}

// ══════════════════════════════════════════════════════════════
// نافذة المساعدة العائمة (Help Panel) — شرح متغيرات/دوال صيغ SUMIFS
// المحتوى الثابت يأتي من _RB_HELP_REFERENCE (مصدر مركزي واحد أعلاه)،
// والفئات المخصصة الفعلية تُجلب ديناميكيًا (lazy) عند أول فتح فقط.
// ══════════════════════════════════════════════════════════════
let _rbHelpPanelLoaded = false;   // هل بُنيت محتويات النافذة مرّة واحدة على الأقل؟
let _rbHelpCategoriesLoaded = false; // هل جُلبت الفئات المخصصة الفعلية (lazy) ؟

function _rbHelpCopyBtn(text) {
  const safe = escHtml(text);
  return `<button type="button" class="rb-help-copy-btn" data-copy="${safe}" title="نسخ">📋</button>`;
}

function _rbHelpItemRow(code, desc) {
  return `
    <div class="rb-help-item">
      <div class="rb-help-item-main">
        <div class="rb-help-item-code">${escHtml(code)}</div>
        ${desc ? `<div class="rb-help-item-desc">${escHtml(desc)}</div>` : ""}
      </div>
      ${_rbHelpCopyBtn(code)}
    </div>`;
}

function _rbHelpSection(id, title, bodyHtml, openByDefault) {
  return `
    <div class="rb-help-section${openByDefault ? " rb-help-open" : ""}" data-section="${id}">
      <div class="rb-help-section-title" data-toggle="${id}">
        <span>${escHtml(title)}</span>
        <span class="rb-help-section-arrow">▶</span>
      </div>
      <div class="rb-help-section-body">${bodyHtml}</div>
    </div>`;
}

function _rbBuildHelpColumnsTable() {
  const ref = _RB_HELP_REFERENCE;
  let html = `<table class="rb-help-table"><thead><tr><th>عمود</th>`;
  for (const s of ref.sources) html += `<th>${escHtml(s.code)}</th>`;
  html += `</tr></thead><tbody>`;
  for (const col of ref.columns) {
    html += `<tr><td style="text-align:right;font-family:monospace">${escHtml(col.code)}</td>`;
    for (const s of ref.sources) {
      html += `<td>${col.sources.includes(s.code) ? "✓" : "—"}</td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

function _rbBuildHelpPanelContent() {
  const ref = _RB_HELP_REFERENCE;
  let html = "";

  html += _rbHelpSection("sources", "المصادر",
    ref.sources.map(s => _rbHelpItemRow(s.code, s.desc)).join(""), true);

  html += _rbHelpSection("columns", "الأعمدة",
    ref.columns.map(c => _rbHelpItemRow(c.code, c.desc)).join("") + _rbBuildHelpColumnsTable(), false);

  html += _rbHelpSection("metrics", "المقاييس (metric)",
    `<div class="rb-help-hint">metric تُذكَر آخر SUMIFS اختياريًا؛ amount هو الافتراضي إن لم تُذكَر.</div>` +
    ref.metrics.map(m => _rbHelpItemRow(m.code, m.desc)).join(""), false);

  html += _rbHelpSection("dates", "التواريخ",
    ref.dates.map(d => _rbHelpItemRow(d.code, d.desc)).join(""), false);

  html += _rbHelpSection("cellref", "مرجع الخلايا",
    `<div class="rb-help-hint">اكتب معرّف خلية (مثل A1) داخل أي شرط SUMIFS بدل كتابة القيمة يدويًا — يأخذ قيمتها الحالية تلقائيًا.</div>` +
    ref.cellRef.map(c => _rbHelpItemRow(c.code, c.desc)).join(""), false);

  html += _rbHelpSection("functions", "الدوال",
    ref.functions.map(f => _rbHelpItemRow(f.code, f.desc)).join(""), false);

  html += _rbHelpSection("customcats", "الفئات المخصصة",
    `<div id="rbHelpCustomCatsBody"><div class="rb-help-hint">جارٍ التحميل...</div></div>`, false);

  const examples = [
    { label: "شرط واحد", code: "=SUMIFS(vnt; vnd; A1)" },
    { label: "بفترة تاريخ", code: "=SUMIFS(vnt; vnd; A1; ds; jour-7; de; jour)" },
    { label: "بمرجع خلية كقيمة شرط", code: "=SUMIFS(vnt; art; B2; ds; jour; de; jour)" },
    { label: "باستعمال metric (qty بدل amount)", code: "=SUMIFS(liv; cat; A1; qty)" },
    { label: "SUM — مجموع نطاق خلايا", code: "=SUM(A1:A5)" },
    { label: "SUM — عدة نطاقات", code: "=SUM(A1:A3; B1:B3)" },
    { label: "SUM مركّبة مع SUMIFS", code: "=SUMIFS(vnt; vnd; A1; ds; jour; de; jour) - SUM(B1:B5)" },
    { label: "SUM مع SUM (فرق بين عمودين)", code: "=SUM(A1:A5) - SUM(B1:B5)" },
  ];
  html += _rbHelpSection("examples", "أمثلة جاهزة",
    examples.map(ex => `
      <div class="rb-help-example">
        <div class="rb-help-example-label">${escHtml(ex.label)}</div>
        ${_rbHelpItemRow(ex.code, "")}
      </div>`).join(""), false);

  document.getElementById("rbHelpPanelBody").innerHTML = html;
  _rbWireHelpPanelBody();
}

// يجلب الفئات المخصصة الفعلية (منتجات/بائعين/قوائم أسعار) من نفس
// مصادر البيانات المستعملة في إدارة الفئات — مرّة واحدة فقط (lazy)،
// عند أول فتح لنافذة المساعدة، وليس عند فتح المصمم كاملاً.
async function _rbEnsureHelpCategoriesLoaded() {
  if (_rbHelpCategoriesLoaded) return;
  _rbHelpCategoriesLoaded = true; // امنع طلبات متكررة حتى لو فُتحت النافذة عدة مرات بسرعة
  try {
    const [prod, seller, pricelist] = await Promise.all([
      (typeof _fetchCustomCategories === "function") ? _fetchCustomCategories() : Promise.resolve([]),
      (typeof _fetchCustomSellerCategories === "function") ? _fetchCustomSellerCategories() : Promise.resolve([]),
      (typeof _fetchCustomPricelistCategories === "function") ? _fetchCustomPricelistCategories() : Promise.resolve([]),
    ]);
    // نملأ نفس المتغيرات العامة المستعملة أصلًا في autocomplete/SUMIFS
    // (_rbTemplateCategories وأخواتها) حتى تستفيد كل الميزات من نفس الجلب.
    if (Array.isArray(prod)) _customCategories = prod;
    if (Array.isArray(seller)) _customSellerCategories = seller;
    if (Array.isArray(pricelist)) _customPricelistCategories = pricelist;

    const body = document.getElementById("rbHelpCustomCatsBody");
    if (!body) return;
    const groups = [
      { title: "فئات منتجات", list: prod || [] },
      { title: "فئات بائعين", list: seller || [] },
      { title: "فئات قوائم أسعار", list: pricelist || [] },
    ];
    let html = "";
    for (const g of groups) {
      if (!g.list.length) continue;
      html += `<div class="rb-help-item-desc" style="margin:6px 0 2px">${escHtml(g.title)}</div>`;
      html += g.list.map(c => _rbHelpItemRow(c.name, "")).join("");
    }
    body.innerHTML = html || `<div class="rb-help-hint">لا توجد فئات مخصصة محفوظة بعد.</div>`;
    _rbWireHelpPanelBody(); // إعادة ربط أزرار النسخ للعناصر المُضافة حديثًا
  } catch (e) {
    console.warn("[rbHelp] تعذّر جلب الفئات المخصصة:", e);
    const body = document.getElementById("rbHelpCustomCatsBody");
    if (body) body.innerHTML = `<div class="rb-help-hint">تعذّر تحميل الفئات المخصصة.</div>`;
  }
}

function _rbWireHelpPanelBody() {
  const bodyEl = document.getElementById("rbHelpPanelBody");
  if (!bodyEl) return;

  bodyEl.querySelectorAll(".rb-help-section-title").forEach(title => {
    if (title.dataset.wired) return;
    title.dataset.wired = "1";
    title.addEventListener("click", () => {
      const section = title.closest(".rb-help-section");
      section.classList.toggle("rb-help-open");
      if (section.dataset.section === "customcats") _rbEnsureHelpCategoriesLoaded();
    });
  });

  bodyEl.querySelectorAll(".rb-help-copy-btn").forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      const text = btn.dataset.copy || "";
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        console.warn("[rbHelp] فشل النسخ:", err);
        return;
      }
      const original = btn.textContent;
      btn.textContent = "✓";
      btn.classList.add("rb-help-copied");
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("rb-help-copied");
      }, 1000);
    });
  });
}

function _rbToggleHelpPanel() {
  const panel = document.getElementById("rbHelpPanel");
  if (!panel) return;
  const opening = panel.style.display === "none";
  panel.style.display = opening ? "flex" : "none";
  if (opening && !_rbHelpPanelLoaded) {
    _rbHelpPanelLoaded = true;
    _rbBuildHelpPanelContent();
    _rbEnsureHelpCategoriesLoaded();
  }
}

// سحب نافذة المساعدة من شريطها العلوي (بسيط: تتبّع الماوس، تحويل من
// bottom/right الأصليين إلى top/left ثابتة بمجرد بدء أول سحب).
function _rbWireHelpPanelDrag() {
  const header = document.getElementById("rbHelpPanelHeader");
  const panel = document.getElementById("rbHelpPanel");
  if (!header || !panel) return;
  header.addEventListener("mousedown", e => {
    if (e.target.closest(".rb-help-panel-close")) return;
    e.preventDefault();
    const dialog = panel.closest(".pm-dialog");
    const dialogRect = dialog.getBoundingClientRect();
    const startRect = panel.getBoundingClientRect();
    const offsetX = e.clientX - startRect.left;
    const offsetY = e.clientY - startRect.top;
    panel.style.bottom = "auto";
    panel.style.right = "auto";
    panel.style.top = (startRect.top - dialogRect.top) + "px";
    panel.style.left = (startRect.left - dialogRect.left) + "px";
    const onMove = ev => {
      let left = ev.clientX - dialogRect.left - offsetX;
      let top = ev.clientY - dialogRect.top - offsetY;
      left = Math.max(0, Math.min(left, dialogRect.width - startRect.width));
      top = Math.max(0, Math.min(top, dialogRect.height - startRect.height));
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ══════════════════════════════════════════════════════════════
// حقن عناصر واجهة إضافية للمرحلة 2 (منتقي الخط، زر التفاف النص، وواجهة
// الحدود الجديدة على طراز إكسل) — تُضاف عبر JS بدل تعديل index.html، لأن
// الملف المستهدف بهذه المرحلة هو reportBuilder.js (+style.css) فقط.
// ══════════════════════════════════════════════════════════════
function _rbInjectExtraToolbarControls() {
  const oldBorderSelect = document.getElementById("rbBorderSelect");
  if (!oldBorderSelect || document.getElementById("rbBorderPopupBtn")) return; // مرة واحدة فقط
  oldBorderSelect.style.display = "none";

  // ── منتقي عائلة الخط ──
  const fontSelect = document.createElement("select");
  fontSelect.id = "rbFontFamilySelect";
  fontSelect.className = "pm-select";
  fontSelect.title = "خط الخلايا المحددة";
  fontSelect.innerHTML = `
    <option value="default">الخط الافتراضي</option>
    <option value="Arial, sans-serif">Arial</option>
    <option value="'Times New Roman', serif">Times New Roman</option>
    <option value="'Courier New', monospace">Courier New</option>
    <option value="Tahoma, sans-serif">Tahoma</option>
    <option value="Georgia, serif">Georgia</option>
    <option value="Verdana, sans-serif">Verdana</option>
  `;
  fontSelect.addEventListener("change", e => rbApplyFontFamily(e.target.value));
  oldBorderSelect.parentNode.insertBefore(fontSelect, oldBorderSelect);

  // ── زر التفاف النص ──
  const wrapBtn = document.createElement("button");
  wrapBtn.id = "btnRbWrapText";
  wrapBtn.type = "button";
  wrapBtn.className = "btn-tool";
  wrapBtn.title = "التفاف النص (Wrap Text)";
  wrapBtn.textContent = "↵ التفاف النص";
  wrapBtn.addEventListener("click", rbToggleWrap);
  oldBorderSelect.parentNode.insertBefore(wrapBtn, oldBorderSelect);

  // ── زر إلغاء الالتفاف (صراحة، بدون شرط toggle) ──
  const clearWrapBtn = document.createElement("button");
  clearWrapBtn.id = "btnRbClearWrapText";
  clearWrapBtn.type = "button";
  clearWrapBtn.className = "btn-tool";
  clearWrapBtn.title = "إلغاء التفاف النص عن كل الخلايا المحددة (بصرف النظر عن حالتها الحالية)";
  clearWrapBtn.textContent = "✕ إلغاء الالتفاف";
  clearWrapBtn.addEventListener("click", rbClearWrap);
  oldBorderSelect.parentNode.insertBefore(clearWrapBtn, oldBorderSelect);

  // ── واجهة الحدود الجديدة: زر يفتح لوحة صغيرة (شبكة 3×3 تمثيلية + خيارات
  // الجهات + لون + سماكة) — تُطبَّق على _rbSelectedCells الحالي عند النقر.
  const wrap = document.createElement("div");
  wrap.id = "rbBorderPopupWrap";
  wrap.style.position = "relative";
  wrap.style.display = "inline-block";

  const btn = document.createElement("button");
  btn.id = "rbBorderPopupBtn";
  btn.type = "button";
  btn.className = "btn-tool";
  btn.title = "حدود الخلايا المحددة";
  btn.textContent = "▦ حدود";

  const panel = document.createElement("div");
  panel.id = "rbBorderPopupPanel";
  panel.className = "rb-border-popup-panel";
  panel.style.display = "none";
  panel.innerHTML = `
    <div class="rb-border-grid">
      <button type="button" class="rb-border-opt" data-side="top" title="حد أعلى">▔</button>
      <button type="button" class="rb-border-opt" data-side="all" title="كل الحدود">▦</button>
      <button type="button" class="rb-border-opt" data-side="bottom" title="حد أسفل">▁</button>
      <button type="button" class="rb-border-opt" data-side="left" title="حد يسار">▏</button>
      <button type="button" class="rb-border-opt" data-side="outer" title="محيط فقط">▢</button>
      <button type="button" class="rb-border-opt" data-side="right" title="حد يمين">▕</button>
      <button type="button" class="rb-border-opt" data-side="inner-h" title="أفقي داخلي">☰</button>
      <button type="button" class="rb-border-opt" data-side="none" title="بدون حدود">✕</button>
      <button type="button" class="rb-border-opt" data-side="inner-v" title="عمودي داخلي">Ⅲ</button>
    </div>
    <div class="rb-border-controls">
      <label>اللون <input type="color" id="rbBorderColorInput" value="#888888"></label>
      <label>السماكة
        <select id="rbBorderThicknessSelect">
          <option value="1">رفيع (1px)</option>
          <option value="2">متوسط (2px)</option>
          <option value="3">سميك (3px)</option>
        </select>
      </label>
    </div>
  `;

  panel.querySelectorAll(".rb-border-opt").forEach(optBtn => {
    optBtn.addEventListener("click", () => {
      const type = optBtn.dataset.side;
      const color = document.getElementById("rbBorderColorInput")?.value || "#888888";
      const thickness = document.getElementById("rbBorderThicknessSelect")?.value || "1";
      rbApplyBorder(type, color, thickness);
      panel.style.display = "none";
    });
  });

  btn.addEventListener("click", e => {
    e.stopPropagation();
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });
  document.addEventListener("click", e => {
    if (!wrap.contains(e.target)) panel.style.display = "none";
  });

  wrap.appendChild(btn);
  wrap.appendChild(panel);
  oldBorderSelect.parentNode.insertBefore(wrap, oldBorderSelect);

  // ── زر تبديل إخفاء خطوط الشبكة الافتراضية ──
  const hideGridBtn = document.createElement("button");
  hideGridBtn.id = "btnRbHideGridlines";
  hideGridBtn.type = "button";
  hideGridBtn.className = "btn-tool";
  hideGridBtn.title = "إخفاء/إظهار خطوط الشبكة الافتراضية (لا يؤثر على الحدود المخصصة)";
  hideGridBtn.textContent = "▦ إخفاء خطوط الشبكة";
  hideGridBtn.addEventListener("click", rbToggleHideGridlines);
  oldBorderSelect.parentNode.insertBefore(hideGridBtn, oldBorderSelect);

  // ── تحكّم تدوير النص: زوايا شائعة + حقل حر ──
  const rotWrap = document.createElement("div");
  rotWrap.id = "rbRotationWrap";
  rotWrap.style.display = "inline-flex";
  rotWrap.style.alignItems = "center";
  rotWrap.style.gap = "4px";

  const rotSelect = document.createElement("select");
  rotSelect.id = "rbRotationSelect";
  rotSelect.className = "pm-select";
  rotSelect.title = "تدوير نص الخلايا المحددة";
  rotSelect.innerHTML = `
    <option value="0">بدون تدوير</option>
    <option value="45">45°</option>
    <option value="90">90°</option>
    <option value="-45">-45°</option>
    <option value="-90">-90°</option>
    <option value="custom">مخصّص…</option>
  `;

  const rotCustomInput = document.createElement("input");
  rotCustomInput.id = "rbRotationCustomInput";
  rotCustomInput.type = "number";
  rotCustomInput.min = "-180";
  rotCustomInput.max = "180";
  rotCustomInput.step = "1";
  rotCustomInput.placeholder = "درجة";
  rotCustomInput.title = "زاوية تدوير حرة (بالدرجات)";
  rotCustomInput.style.width = "60px";
  rotCustomInput.style.display = "none";

  rotSelect.addEventListener("change", () => {
    if (rotSelect.value === "custom") {
      rotCustomInput.style.display = "";
      rotCustomInput.focus();
    } else {
      rotCustomInput.style.display = "none";
      rbApplyRotation(rotSelect.value);
    }
  });
  rotCustomInput.addEventListener("change", () => rbApplyRotation(rotCustomInput.value));
  rotCustomInput.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); rotCustomInput.blur(); }
  });

  rotWrap.appendChild(rotSelect);
  rotWrap.appendChild(rotCustomInput);
  oldBorderSelect.parentNode.insertBefore(rotWrap, oldBorderSelect);
}

// ══════════════════════════════════════════════════════════════
// إصلاح فقدان التحديد (المرحلة 2 - مشكلة 1): jspreadsheet.js يُسجّل
// مستمع mousedown خاصًا به على document (mouseDownControls) في مرحلة
// الفقاعة (bubble، الافتراضية) — عند أي mousedown على عنصر خارج حاوية
// الگريد (بلا class="jss_object") يستدعي selection.gE (= resetSelection)
// فيمسح التحديد المرئي الداخلي لـjexcel.
//
// الاعتماد على stopPropagation() من مستمع مُسجَّل على عنصر وسيط (كشريط
// الأدوات نفسه) في مرحلة الفقاعة كان يعمل نظريًا (لأن مرحلة الفقاعة تمر
// بشريط الأدوات قبل الوصول لـdocument)، لكن الأضمن هو استعمال مستمع على
// document نفسه في مرحلة الالتقاط (capture) — فمرحلة الالتقاط تُنفَّذ *قبل*
// وصول الحدث للهدف أصلاً، أي قبل مرحلة الفقاعة بالكامل، بصرف النظر عن ترتيب
// تسجيل أي مستمعات أخرى على document (بما فيها مستمع jexcel). هذا يزيل أي
// اعتمادية على ترتيب التسجيل ويضمن أن مستمعنا يُنفَّذ أولًا دائمًا.
// نستعمل e.target.closest(...) للتحقق أن الحدث بدأ فعلًا من داخل شريط
// الأدوات أو قائمة السياق أو نافذة إدخال الأبعاد (المُلحقتين بـdocument.body
// مباشرة خارج الشريط) قبل إيقاف الانتشار — حتى لا نُعطّل أي مستمعات أخرى
// غير متعلقة بالتنسيق (كنقرات داخل الگريد نفسه، التي يجب أن تصل لـjexcel
// كالمعتاد لتعمل عمليات التحديد الطبيعية).
// ══════════════════════════════════════════════════════════════
const _RB_FORMAT_CONTROLS_SELECTOR =
  "#reportBuilderModal .rb-toolbar, #rbContextMenu, #rbDimPopup";

function _rbStopMousedownPropagation() {
  document.addEventListener("mousedown", e => {
    if (e.target.closest && e.target.closest(_RB_FORMAT_CONTROLS_SELECTOR)) {
      e.stopPropagation();
    }
  }, true); // true = مرحلة الالتقاط (capture)، وليست الفقاعة (bubble)
}

// نفس فكرة _rbStopMousedownPropagation تمامًا لكن لحدث keydown: مستمع
// jexcel العام على document (keyDownControls) لا يتحقق أبدًا من e.target،
// فيخطف أي ضغطة مفتاح بالصفحة كلها طالما فيه خلية محددة بالگريد — بما فيها
// الكتابة اليدوية بحقول عرض/ارتفاع/حجم الخط بالشريط العلوي، وأسهم الرفع/
// الخفض الخاصة بـ<input type="number"> (والتي تُصدر ArrowUp/ArrowDown
// كضغطات مفاتيح تُترجَم من jexcel كتنقّل بين خلايا الگريد، فيتغيّر التحديد
// تلقائيًا بدل تغيير القيمة برقم فقط). إيقاف الانتشار بمرحلة الالتقاط هنا
// يمنع وصول الحدث لمستمع jexcel من الأساس دون التأثير على الكتابة نفسها
// (السلوك الافتراضي للمتصفح بالحقل يبقى يعمل، فقط ما بيوصل حدث الـbubble
// لـdocument).
function _rbStopKeydownPropagation() {
  document.addEventListener("keydown", e => {
    if (e.target.closest && e.target.closest(_RB_FORMAT_CONTROLS_SELECTOR)) {
      e.stopPropagation();
    }
  }, true);
}

function _rbApplyHiddenMarkers() {
  if (!_rbJssInstance) return;
  const headers = _rbJssInstance.headers || [];
  for (let c = 0; c < headers.length; c++) {
    const th = headers[c];
    if (!th) continue;
    if (_rbHiddenCols.has(c)) {
      th.classList.add("rb-hidden-marker");
      th.title = "مخفي عند التقرير";
    } else {
      th.classList.remove("rb-hidden-marker");
      if (th.title === "مخفي عند التقرير") th.removeAttribute("title");
    }
  }
  const rows = _rbJssInstance.rows || [];
  for (let r = 0; r < rows.length; r++) {
    const rowObj = rows[r];
    const rowHeaderTd = rowObj && rowObj.element && rowObj.element.children[0];
    if (!rowHeaderTd) continue;
    if (_rbHiddenRows.has(r)) {
      rowHeaderTd.classList.add("rb-hidden-marker");
      rowHeaderTd.title = "مخفي عند التقرير";
    } else {
      rowHeaderTd.classList.remove("rb-hidden-marker");
      if (rowHeaderTd.title === "مخفي عند التقرير") rowHeaderTd.removeAttribute("title");
    }
  }
}

// يُفرغ _rbHiddenRows/_rbHiddenCols بالكامل (زر "إظهار الكل") ويُحدّث
// العلامات البصرية فورًا دون انتظار _rbRenderGrid كامل (رغم أننا نستدعيه
// أيضًا لضمان تطابق البيانات المحفوظة/السجل التاريخي بنفس منطق بقية عمليات
// الإخفاء الحالية).
function rbShowAllHidden() {
  if (!_rbHiddenRows.size && !_rbHiddenCols.size) {
    addNotif("لا يوجد صفوف/أعمدة مخفية حاليًا", "warning");
    return;
  }
  _rbHiddenRows = new Set();
  _rbHiddenCols = new Set();
  _rbApplyHiddenMarkers();
  _rbRenderGrid();
  addNotif("تم إظهار كل الصفوف والأعمدة المخفية ✓", "success");
  _rbPushHistory();
}

document.addEventListener("DOMContentLoaded", () => {
  _rbStopMousedownPropagation();
  _rbStopKeydownPropagation();
  document.getElementById("btnReportBuilderOpen")?.addEventListener("click", openReportBuilderModal);
  document.getElementById("btnRbClose")?.addEventListener("click", () => {
    document.getElementById("reportBuilderModal").style.display = "none";
  });
  document.getElementById("reportBuilderModal")?.addEventListener("click", e => {
    if (e.target.id === "reportBuilderModal") document.getElementById("reportBuilderModal").style.display = "none";
  });

  document.getElementById("btnRbHelp")?.addEventListener("click", _rbToggleHelpPanel);
  document.getElementById("btnRbHelpClose")?.addEventListener("click", () => {
    document.getElementById("rbHelpPanel").style.display = "none";
  });
  _rbWireHelpPanelDrag();

  document.getElementById("btnRbAddRow")?.addEventListener("click", rbAddRow);
  document.getElementById("btnRbAddCol")?.addEventListener("click", rbAddCol);
  document.getElementById("btnRbDelRow")?.addEventListener("click", rbDeleteRow);
  document.getElementById("btnRbDelCol")?.addEventListener("click", rbDeleteCol);
  document.getElementById("btnRbMerge")?.addEventListener("click", rbMergeSelected);
  document.getElementById("btnRbUnmerge")?.addEventListener("click", rbUnmergeSelected);
  document.getElementById("btnRbClearContent")?.addEventListener("click", rbClearSelectedContent);
  document.getElementById("btnRbHideRow")?.addEventListener("click", rbToggleHideSelectedRows);
  document.getElementById("btnRbHideCol")?.addEventListener("click", rbToggleHideSelectedCols);
  document.getElementById("btnRbShowAllHidden")?.addEventListener("click", rbShowAllHidden);
  document.getElementById("btnRbFormatPainter")?.addEventListener("click", rbActivateFormatPainter);
  document.getElementById("btnRbFreezeRow")?.addEventListener("click", rbToggleFreezeRow);
  document.getElementById("btnRbFreezeCol")?.addEventListener("click", rbToggleFreezeCol);
  document.getElementById("btnRbResetDims")?.addEventListener("click", rbResetSelectedDimensions);
  document.getElementById("btnRbBold")?.addEventListener("click", rbToggleBold);
  document.getElementById("btnRbItalic")?.addEventListener("click", rbToggleItalic);
  document.getElementById("btnRbUnderline")?.addEventListener("click", rbToggleUnderline);
  document.getElementById("btnRbAlignLeft")?.addEventListener("click", () => rbSetTextAlign("left"));
  document.getElementById("btnRbAlignCenter")?.addEventListener("click", () => rbSetTextAlign("center"));
  document.getElementById("btnRbAlignRight")?.addEventListener("click", () => rbSetTextAlign("right"));
  document.getElementById("btnRbVAlignTop")?.addEventListener("click", () => rbSetVerticalAlign("top"));
  document.getElementById("btnRbVAlignMiddle")?.addEventListener("click", () => rbSetVerticalAlign("middle"));
  document.getElementById("btnRbVAlignBottom")?.addEventListener("click", () => rbSetVerticalAlign("bottom"));
  document.getElementById("rbColorPicker")?.addEventListener("input", e => rbApplyBgColor(e.target.value));
  document.getElementById("rbTextColorPicker")?.addEventListener("input", e => rbApplyTextColor(e.target.value));
  document.getElementById("rbFontSizeInput")?.addEventListener("change", e => rbApplyFontSize(e.target.value));
  _rbInjectExtraToolbarControls();

  // ── حقلا "عرض/ارتفاع" بالشريط العلوي — إدخال مباشر بديل عن right-click ──
  document.getElementById("rbToolbarWidthInput")?.addEventListener("change", e => rbApplyWidthToSelection(e.target.value));
  document.getElementById("rbToolbarWidthInput")?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
  });
  document.getElementById("rbToolbarHeightInput")?.addEventListener("change", e => rbApplyHeightToSelection(e.target.value));
  document.getElementById("rbToolbarHeightInput")?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
  });

  // ── قائمة "نوع المحتوى" (تدعم حقل رمز عملة شرطي يظهر فقط بجانب "عملة") ──
  document.getElementById("rbFormatDropdownBtn")?.addEventListener("click", e => {
    e.stopPropagation();
    _rbToggleFormatDropdown();
  });
  document.querySelectorAll("#rbFormatDropdownPanel .rb-format-option").forEach(opt => {
    opt.addEventListener("click", e => {
      const format = opt.dataset.format;
      if (!format) return;
      rbApplyFormat(format);
      _rbSyncFormatDropdownFromSelection();
      const isNumericFormat = format === "number" || format === "currency" || format === "percentage";
      if (isNumericFormat) {
        // نبقي القائمة مفتوحة لتنسيقات رقمية (رقم/عملة/نسبة مئوية) حتى يتمكن
        // المستخدم من ضبط عدد الخانات العشرية (ورمز العملة إن وُجد) مباشرة.
        if (format === "currency" && e.target.id !== "rbCurrencySymbolInput") {
          document.getElementById("rbCurrencySymbolInput")?.focus();
        }
      } else {
        _rbCloseFormatDropdown();
      }
    });
  });
  document.getElementById("rbCurrencySymbolInput")?.addEventListener("change", e => rbApplyCurrencySymbol(e.target.value));
  document.getElementById("rbCurrencySymbolInput")?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); e.target.blur(); _rbCloseFormatDropdown(); }
    if (e.key === "Escape") { e.target.blur(); _rbCloseFormatDropdown(); }
  });
  document.getElementById("rbDecimalsInput")?.addEventListener("change", e => rbApplyDecimals(e.target.value));
  document.getElementById("rbDecimalsInput")?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); e.target.blur(); _rbCloseFormatDropdown(); }
    if (e.key === "Escape") { e.target.blur(); _rbCloseFormatDropdown(); }
  });
  document.addEventListener("click", e => {
    const dd = document.getElementById("rbFormatDropdown");
    if (dd && !dd.contains(e.target)) _rbCloseFormatDropdown();
  });
  document.getElementById("btnRbSaveAs")?.addEventListener("click", rbSaveTemplateAs);
  document.getElementById("btnRbSave")?.addEventListener("click", rbSaveTemplate);
  document.getElementById("btnRbDeleteTemplate")?.addEventListener("click", rbDeleteTemplate);
  document.getElementById("rbTemplateSelect")?.addEventListener("change", e => {
    if (e.target.value) rbLoadTemplate(e.target.value);
  });
  _rbUpdateSaveButtonState();

  // Delete/Backspace: يفرّغ محتوى كل الخلايا المحددة، فقط عندما لا يكون
  // التركيز داخل خلية قيد التحرير حاليًا (وإلا فالسلوك الافتراضي لحذف نص
  // الكتابة يبقى كما هو) وعندما تكون نافذة Report Builder مفتوحة فعلاً.
  document.addEventListener("keydown", e => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const modal = document.getElementById("reportBuilderModal");
    if (!modal || modal.style.display === "none") return;
    if (!_rbSelectedCells.size) return;
    const active = document.activeElement;
    // تجاهل الحدث كليًا (بدون preventDefault) إن كان التركيز على أي حقل
    // إدخال نصي بشكل عام — وليس فقط خلية گريد تحديدًا — حتى لا يُفرَّغ
    // محتوى خلايا الگريد المحددة خلف نافذة عائمة (مثل منشئ الصيغ formulaWizard.js)
    // بينما المستخدم يكتب/يحذف داخل حقل تابع لها (input/textarea/contenteditable).
    const isTextInput = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
    if (isTextInput) return; // اترك السلوك الافتراضي لحقل الإدخال (يشمل خلايا الگريد نفسها، فهي أيضًا contenteditable)
    e.preventDefault();
    // Jspreadsheet CE (jexcel) يُسجّل مستمعًا خاصًا به على document لنفس
    // المفتاحين (Delete/Backspace) يحذف محتوى تحديده الداخلي الخاص — نمنع
    // وصول الحدث إليه هنا لتفادي حذف مزدوج/متعارض (مستمعنا هذا مُسجَّل قبل
    // مستمع jexcel، فـstopImmediatePropagation يمنعه فعليًا من العمل بعده).
    e.stopImmediatePropagation();
    rbClearSelectedContent();
  });

  // Ctrl+Z (تراجع) و Ctrl+Y أو Ctrl+Shift+Z (إعادة تقدّم) — فقط عندما تكون
  // نافذة Report Builder مفتوحة فعلاً. إن كان التركيز داخل خلية قيد
  // التحرير حاليًا، نُفرغها أولاً (blur) لضمان أن تعديلها الحالي يُدفع
  // للمكدس كخطوة قبل تنفيذ التراجع/التقدّم، بنفس منطق الحفظ عند Enter.
  document.addEventListener("keydown", e => {
    const ctrlOrCmd = e.ctrlKey || e.metaKey;
    if (!ctrlOrCmd) return;
    const key = e.key.toLowerCase();
    const isUndo = key === "z" && !e.shiftKey;
    const isRedo = (key === "z" && e.shiftKey) || key === "y";
    if (!isUndo && !isRedo) return;
    const modal = document.getElementById("reportBuilderModal");
    if (!modal || modal.style.display === "none") return;
    e.preventDefault();
    // نفس ملاحظة stopImmediatePropagation أعلاه: jexcel يملك undo/redo داخليًا
    // خاصًا به (منفصلًا تمامًا عن _rbHistoryStack) يستمع لنفس الاختصارات على
    // document — نمنعه من العمل هنا لأن رسم الگريد بالكامل من جديد عبر
    // _rbApplySnapshot/_rbRenderGrid هو المصدر الوحيد المعتمد للتراجع/التقدّم.
    e.stopImmediatePropagation();
    const active = document.activeElement;
    const isEditingCell = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
    if (isEditingCell) active.blur();
    if (isUndo) rbUndo(); else rbRedo();
  });
});
