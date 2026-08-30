// ══════════════════════════════════════════════════════════════
// reportViewer.js — عرض تقرير محسوب (Template + بيانات اليوم المحدد)
// يفصل بين تصميم القالب (reportBuilder.js — لا يُعدَّل هنا إطلاقًا) وعرضه
// الفعلي بأرقام حقيقية مبنية على شريط التاريخ الحالي (App.currentDateOffset).
//
// إعادة استخدام (بدون تكرار كود) لدوال عامة معرّفة في ملفات <script> أخرى
// (كلها في النطاق العام لأنها ليست ES Modules):
//   من reportBuilder.js: _rbFetchTemplates, _rbColLetters, _rbCellId,
//                        _rbParseCellId, _rbCurrentTheday, _rbTemplateCategories
//   من formulaEngine.js: evaluateCellFormula (يدعم SUMIFS(...) مفردة أو
//                        مركّبة عبر sumifsCtx)، _extractSumIfsCalls،
//                        _parseFunctionCall، _parseSumIfsArgs، resolveDateExpr
//   من utils.js/renderer.js: escHtml, addNotif, getDateKey
// _rbFindCoveringMerge لم يُعَد استعمالها مباشرة لأنها تعتمد على المتغير
// الخاص _rbMerges (حالة داخلية لمصمم القوالب) — بدلاً من ذلك نسخة محلية
// صغيرة (_rvFindCoveringMerge) تعمل على _rvMerges الخاصة بهذا الملف، حتى
// يمكن فتح "المصمم" و"العارض" معًا دون أي تعارض حالة.
// ══════════════════════════════════════════════════════════════

let _rvTemplates = [];
let _rvCurrentTemplate = null; // القالب الخام كما هو في Firestore (name, rows, cols, ...)
let _rvRows = 0;
let _rvCols = 0;
let _rvCellsData = {};  // { cellId: { raw, value, error } } بعد الحساب الفعلي
let _rvMerges = [];
let _rvStyles = {};
let _rvSourcesMap = { vnt: [], liv: [], enc: [] };
let _rvTheday = null;
let _rvHiddenRows = new Set(); // أرقام صفوف (0-based) معلَّمة "مخفي" — تُتجاهل كليًا هنا
let _rvHiddenCols = new Set(); // أرقام أعمدة (0-based) معلَّمة "مخفي" — تُتجاهل كليًا هنا
let _rvColWidths = {};
let _rvRowHeights = {};
let _rvHideGridlines = false; // إخفاء خطوط الشبكة — من إعداد القالب المحفوظ في reportBuilder

// ── حساب الحجم الفعلي الديناميكي للورقة (صفوف/أعمدة) بدل رقم ثابت ──
// يُفضَّل بُعد الورقة الحيّة (row/column من luckysheetNative، وهو ما
// ضبطه المستخدم فعليًا في المصمم Luckysheet)، ثم يُوسَّع إن لزم ليشمل
// أي محتوى/دمج/عرض-ارتفاع مضبوط يتجاوزه (احتياطًا)، وأخيرًا القوالب
// القديمة بلا luckysheetNative تعتمد فقط على امتداد المحتوى/الدمج.
function _rvComputeExtent(nativeSheet, cellsData, merges, colWidths, rowHeights) {
  let maxRow = -1, maxCol = -1;
  if (nativeSheet) {
    if (Number.isFinite(nativeSheet.row))    maxRow = Math.max(maxRow, nativeSheet.row - 1);
    if (Number.isFinite(nativeSheet.column)) maxCol = Math.max(maxCol, nativeSheet.column - 1);
  }
  for (const id of Object.keys(cellsData || {})) {
    const p = _rbParseCellId(id);
    if (!p) continue;
    if (p.row > maxRow) maxRow = p.row;
    if (p.col > maxCol) maxCol = p.col;
  }
  for (const m of (merges || [])) {
    const s = _rbParseCellId(m.start), e = _rbParseCellId(m.end);
    if (!s || !e) continue;
    maxRow = Math.max(maxRow, s.row, e.row);
    maxCol = Math.max(maxCol, s.col, e.col);
  }
  for (const key of Object.keys(colWidths || {})) {
    const c = parseInt(key, 10);
    if (Number.isFinite(c)) maxCol = Math.max(maxCol, c);
  }
  for (const key of Object.keys(rowHeights || {})) {
    const r = parseInt(key, 10);
    if (Number.isFinite(r)) maxRow = Math.max(maxRow, r);
  }
  return {
    rows: maxRow >= 0 ? maxRow + 1 : 0,
    cols: maxCol >= 0 ? maxCol + 1 : 0,
  };
}

// ── إيجاد نطاق (merge) يغطي خلية، بنفس منطق _rbFindCoveringMerge لكن
//    على حالة _rvMerges الخاصة بهذا الملف (نسخة صغيرة، انظر الشرح أعلاه) ──
function _rvFindCoveringMerge(cellId) {
  const p = _rbParseCellId(cellId);
  if (!p) return null;
  for (const m of _rvMerges) {
    const s = _rbParseCellId(m.start), e = _rbParseCellId(m.end);
    const r0 = Math.min(s.row, e.row), r1 = Math.max(s.row, e.row);
    const c0 = Math.min(s.col, e.col), c1 = Math.max(s.col, e.col);
    if (p.row >= r0 && p.row <= r1 && p.col >= c0 && p.col <= c1) return m;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// جلب البيانات الخام الثلاثة (vnt/liv/enc) عبر rpcController، بنفس
// jour المحسوب من App.currentDateOffset
// ══════════════════════════════════════════════════════════════
async function _rvFetchSourcesMap(theday, lookbackDays) {
  if (typeof rpcController === "undefined" || typeof rpcController.fetchReportRawSources !== "function") {
    console.warn("[reportViewer] rpcController.fetchReportRawSources غير متوفر");
    return { vnt: [], liv: [], enc: [] };
  }
  const baseUrl = (typeof getOdooBase === "function") ? getOdooBase() : "";
  try {
    return await rpcController.fetchReportRawSources(baseUrl, theday, lookbackDays);
  } catch (e) {
    console.warn("[reportViewer] فشل جلب البيانات الخام:", e);
    addNotif("فشل جلب بيانات التقرير: " + e.message, "error");
    return { vnt: [], liv: [], enc: [] };
  }
}

// ══════════════════════════════════════════════════════════════
// حساب الخلايا — نفس منطق _rbComputeCell في reportBuilder.js لكن بمصادر/
// تاريخ صريحين (سياق العارض) بدل الاعتماد على متغيرات حالة المصمم
// ══════════════════════════════════════════════════════════════
function _rvComputeCell(raw, cellsRawMap, cellsValueMap) {
  if (raw == null || raw === "") return { value: "" };
  if (typeof raw !== "string" || !raw.trim().startsWith("=")) {
    return { value: raw };
  }
  try {
    const sumifsCtx = {
      sourcesMap: _rvSourcesMap,
      theday: _rvTheday,
      customCategories: _rbTemplateCategories(),
      customSellerCategories: _rbTemplateSellerCategories(),
      customPricelistCategories: _rbTemplatePricelistCategories(),
      cellsValueMap: cellsValueMap || {},
    };

    // نفس منطق _rbComputeCell في reportBuilder.js: يجب فحص دمج النص عبر "&"
    // وصيغة JOUR(...) المفردة *قبل* المرور بالمسار الموحّد evaluateCellFormula،
    // لأن هذا الأخير رقمي فقط (لا يدعم نصوصًا حرفية أو "&" أو JOUR).
    const expr = raw.trim().replace(/^=/, "").trim();

    const concatParts = _rbSplitTopLevelConcat(expr);
    if (concatParts.length > 1) {
      const text = concatParts.map((p) => _rvEvaluateConcatPart(p, cellsRawMap, sumifsCtx)).join("");
      return { value: text };
    }

    if (/^JOUR\s*\(/i.test(expr)) {
      const v = evaluateJour(raw, _rvTheday);
      return { value: v };
    }

    const v = evaluateCellFormula(raw, cellsRawMap, undefined, sumifsCtx);
    return { value: v };
  } catch (e) {
    return { value: "#خطأ: " + e.message, error: e.message };
  }
}

// ── نسخة من _rbEvaluateConcatPart (reportBuilder.js) لكن بسياق العارض
//    الصريح (cellsRawMap/sumifsCtx بدل _rbCellsRawMap/_rbSumIfsCtx) ──
function _rvEvaluateConcatPart(part, cellsRawMap, sumifsCtx) {
  const p = String(part || "").trim();

  const qm = /^"([\s\S]*)"$/.exec(p);
  if (qm) return qm[1];

  if (/^JOUR\s*\(/i.test(p)) {
    return evaluateJour("=" + p, sumifsCtx.theday);
  }

  if (/^jour(\s*-\s*\d+)?$/i.test(p)) {
    return formatIsoDateToDMY(resolveDateExpr(p, sumifsCtx.theday));
  }

  try {
    const v = evaluateCellFormula("=" + p, cellsRawMap, undefined, sumifsCtx);
    return String(v);
  } catch (e) {
    return p;
  }
}

function _rvComputeAllCells(rawCellsData) {
  const cellsRawMap = {};
  for (const id in rawCellsData) cellsRawMap[id] = rawCellsData[id].raw;

  // خريطة قيم أولية (خلايا بلا صيغة فقط) تُستعمل لحلّ مراجع الخلايا (A1...)
  // داخل شروط SUMIFS — يغطي الاستعمال الشائع (خلية تحتوي قيمة/اسم/تاريخ
  // مكتوب مباشرة يُشار إليه من خلية أخرى)
  const cellsValueMap = {};
  for (const id in rawCellsData) {
    const raw = rawCellsData[id].raw;
    if (typeof raw !== "string" || !raw.trim().startsWith("=")) cellsValueMap[id] = raw;
  }

  _rvCellsData = {};
  for (const id in rawCellsData) {
    const raw = rawCellsData[id].raw;
    const result = _rvComputeCell(raw, cellsRawMap, cellsValueMap);
    _rvCellsData[id] = { raw, value: result.value, error: result.error || null };
  }
}

// ══════════════════════════════════════════════════════════════
// رسم الجدول (read-only — بدون contenteditable، بدون أحداث تحرير)
// ══════════════════════════════════════════════════════════════
function _rvRenderTable() {
  const wrap = document.getElementById("rvGridWrap");
  if (!wrap) return;
  if (!_rvRows || !_rvCols) { wrap.innerHTML = ""; return; }

  // الصفوف/الأعمدة المعلَّمة "مخفي عند التقرير" (من مصمم القوالب) تُتجاهل
  // كليًا هنا — لا تُرسم إطلاقًا، وليس فقط تضليلاً بصريًا.
  const visibleCols = [];
  for (let c = 0; c < _rvCols; c++) if (!_rvHiddenCols.has(c)) visibleCols.push(c);

  let html = `<table id="rvGridTable" class="rb-grid-table rv-grid-table" style="table-layout:fixed;"><colgroup>`;
  for (const c of visibleCols) html += `<col style="width:${_rvColWidths[c] || _RB_DEFAULT_COL_WIDTH}px">`;
  html += `</colgroup><tbody>`;

  for (let r = 0; r < _rvRows; r++) {
    if (_rvHiddenRows.has(r)) continue; // صف مخفي — تجاهل كامل الصف
    const rh = _rvRowHeights[r] || _RB_DEFAULT_ROW_HEIGHT;
    html += `<tr style="height:${rh}px">`;
    for (const c of visibleCols) {
      const id = _rbCellId(r, c);
      const merge = _rvMerges.find(m => m.start === id);
      const covering = _rvFindCoveringMerge(id);
      if (covering && covering.start !== id) continue; // خلية مغطاة بدمج، لا تُرسم

      let attrs = "";
      if (merge) {
        const s = _rbParseCellId(merge.start), e = _rbParseCellId(merge.end);
        const r0 = Math.min(s.row, e.row), r1 = Math.max(s.row, e.row);
        const c0 = Math.min(s.col, e.col), c1 = Math.max(s.col, e.col);
        let rowspan = 0, colspan = 0;
        for (let rr = r0; rr <= r1; rr++) if (!_rvHiddenRows.has(rr)) rowspan++;
        for (let cc = c0; cc <= c1; cc++) if (!_rvHiddenCols.has(cc)) colspan++;
        if (rowspan > 1) attrs += ` rowspan="${rowspan}"`;
        if (colspan > 1) attrs += ` colspan="${colspan}"`;
      }
      const style = _rvStyles[id] || {};
      const styleAttr = _rbStyleCss(style) + `height:${rh}px;overflow:hidden;`;
      const cellData = _rvCellsData[id];
      const rawValue = cellData ? (cellData.value ?? "") : "";
      const displayValue = _rbFormatValue(rawValue, style.format, style.currencySymbol, style.decimals);
      const errClass = cellData && cellData.error ? " rb-cell-error" : "";
      html += `<td data-cell="${id}" class="rv-cell${errClass}"${attrs} style="${styleAttr}">${escHtml(String(displayValue))}</td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  wrap.innerHTML = html;
  wrap.classList.toggle("rb-hide-gridlines", !!_rvHideGridlines);
  // ملاحظة: رؤوس الأعمدة (A/B/C...) وأرقام الصفوف (مساعدات خاصة بمصمم
  // القوالب فقط) لم تعد تُولَّد إطلاقًا هنا (بدل توليدها ثم إخفائها عبر
  // display:none) — إخفاء عناصر <thead>/<th> بهذه الطريقة في جدول
  // border-collapse:collapse يكسر رسم الحدود عند الخلايا المجاورة لها
  // (الحد العلوي لأول صف بيانات المجاور لـthead المخفي، والحد الأيمن لأول
  // عمود بيانات المجاور لعمود أرقام الصفوف المخفي في تخطيط RTL).
}

// ══════════════════════════════════════════════════════════════
// حساب نافذة الجلب الدنيا المطلوبة فعليًا (بدل 60 يومًا افتراضيًا) —
// يفحص كل صيغ SUMIFS في القالب ويستخرج أقصى إزاحة تاريخ (jour-N)
// مستعملة في ds/de، ثم يعيد أكبر قيمة كـ lookbackDays.
// يعيد استخدام _parseFunctionCall/_parseSumIfsArgs/resolveDateExpr من
// formulaEngine.js مباشرة (دوال عامة، بدون تكرار كود).
// ══════════════════════════════════════════════════════════════
function _rvDaysBetween(pastDateStr, theday) {
  const a = new Date(pastDateStr + "T00:00:00");
  const b = new Date(theday + "T00:00:00");
  return Math.round((b - a) / 86400000);
}

function _rvComputeRequiredLookbackDays(rawCellsData, theday) {
  let maxDays = 0;
  for (const id in rawCellsData) {
    const raw = rawCellsData[id] && rawCellsData[id].raw;
    if (typeof raw !== "string" || !raw.trim().startsWith("=")) continue;
    if (typeof _extractSumIfsCalls !== "function") continue;

    // يفحص كل استدعاء SUMIFS(...) على حدة (قد يكون هناك أكثر من واحد في
    // نفس الخلية إن كانت صيغة مركّبة مثل =SUMIFS(...) - SUMIFS(...))
    // بدل الاقتصار على حالة خلية تحتوي SUMIFS مفردة فقط.
    const calls = _extractSumIfsCalls(raw);
    for (const callText of calls) {
      let datestart, dateend;
      try {
        const { argsString } = _parseFunctionCall(callText);
        ({ datestart, dateend } = _parseSumIfsArgs(argsString));
      } catch (e) {
        continue; // صيغة غير صالحة الشكل — سيظهر الخطأ عند الحساب الفعلي للخلية، تجاهله هنا
      }

      for (const expr of [datestart, dateend]) {
        if (!expr) continue;
        try {
          const resolved = resolveDateExpr(expr, theday);
          const diffDays = _rvDaysBetween(resolved, theday);
          if (diffDays > maxDays) maxDays = diffDays;
        } catch (e) {
          continue; // تعبير تاريخ غير صالح — سيظهر الخطأ عند الحساب الفعلي للخلية أيضًا
        }
      }
    }
  }
  return Math.max(0, maxDays);
}

// تسمية عربية مبسطة لعدد الأيام (لرسالة التحميل)
function _rvArabicDaysLabel(n) {
  if (n === 1) return "يوم واحد";
  if (n === 2) return "يومين";
  if (n >= 3 && n <= 10) return `${n} أيام`;
  return `${n} يومًا`;
}


async function _rvLoadTemplateList() {
  const sel = document.getElementById("rvTemplateSelect");
  const empty = document.getElementById("rvEmptyState");
  const exportBtn = document.getElementById("btnRvExportExcel");
  if (!sel) return;

  sel.innerHTML = `<option value="">جاري التحميل...</option>`;
  sel.disabled = true;

  _rvTemplates = (typeof _rbFetchTemplates === "function") ? await _rbFetchTemplates() : [];

  if (!_rvTemplates.length) {
    sel.innerHTML = `<option value="">— لا توجد قوالب —</option>`;
    sel.disabled = true;
    if (empty) {
      empty.style.display = "block";
      empty.textContent = "لا توجد قوالب، أنشئ واحدًا من المصمم أولاً";
    }
    if (exportBtn) exportBtn.disabled = true;
    const imgBtn = document.getElementById("btnRvExportImage");
    const copyBtn = document.getElementById("btnRvCopyImage");
    if (imgBtn) imgBtn.disabled = true;
    if (copyBtn) copyBtn.disabled = true;
    document.getElementById("rvGridWrap").innerHTML = "";
    return;
  }

  sel.disabled = false;
  if (empty) empty.style.display = "none";
  sel.innerHTML = `<option value="">— اختر قالبًا —</option>` +
    _rvTemplates.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join("");
}

function _rvResetView() {
  _rvCurrentTemplate = null;
  _rvCellsData = {}; _rvMerges = []; _rvStyles = {}; _rvRows = 0; _rvCols = 0;
  _rvHiddenRows = new Set(); _rvHiddenCols = new Set();
  _rvColWidths = {}; _rvRowHeights = {}; _rvHideGridlines = false;
  const wrap = document.getElementById("rvGridWrap");
  if (wrap) wrap.innerHTML = "";
  const title = document.getElementById("rvReportTitle");
  if (title) title.textContent = "";
  const exportBtn = document.getElementById("btnRvExportExcel");
  if (exportBtn) exportBtn.disabled = true;
  const imgBtn = document.getElementById("btnRvExportImage");
  const copyBtn = document.getElementById("btnRvCopyImage");
  if (imgBtn) imgBtn.disabled = true;
  if (copyBtn) copyBtn.disabled = true;
}

// ⚠️ تصحيح تلقائي للقوالب المحفوظة قبل إصلاح _rbHtToTextAlign/_rbVtToVerticalAlign:
// legacy.styles القديمة قد تحمل "center"/"middle" خاطئة (لأن الاشتقاق تم
// وقت الحفظ بدالة كانت تقارن ht/vt بـ === صارمة مع أرقام، بينما Luckysheet
// يخزّنها كسلسلة نصية). بما أن luckysheetNative (ht/vt الخام) يُحفظ دائمًا
// مع القالب، نعيد اشتقاق المحاذاة فقط من جديد هنا في كل تحميل — دون الحاجة
// لإعادة فتح/حفظ كل قالب يدويًا من المصمم. يعتمد على _rbHtToTextAlign/
// _rbVtToVerticalAlign/_rbCellId المعرّفة في luckysheetBuilder.js (لازم أن
// يكون محمّلاً في نفس الصفحة قبل reportViewer.js).
function _rvRepairAlignmentFromNative(styles, nativeSheet) {
  if (!nativeSheet || !Array.isArray(nativeSheet.celldata)) return styles;
  if (typeof _rbHtToTextAlign !== "function" || typeof _rbVtToVerticalAlign !== "function") return styles;
  for (const cell of nativeSheet.celldata) {
    const v = cell && cell.v;
    if (!v || typeof v !== "object") continue;
    const id = _rbCellId(cell.r, cell.c);
    if (v.ht != null) {
      styles[id] = styles[id] || {};
      styles[id].textAlign = _rbHtToTextAlign(v.ht);
    }
    if (v.vt != null) {
      styles[id] = styles[id] || {};
      styles[id].verticalAlign = _rbVtToVerticalAlign(v.vt);
    }
  }
  return styles;
}

function _rvUpdateTitle(name) {
  const el = document.getElementById("rvReportTitle");
  if (!el) return;
  const dateFmt = _rvTheday ? _rvTheday.split("-").reverse().join("/") : "";
  el.textContent = `قالب: ${name} — بتاريخ ${dateFmt}`;
}

async function rvLoadAndRenderTemplate(templateId) {
  const t = _rvTemplates.find(x => x.id === templateId);
  if (!t) { _rvResetView(); return; }

  _rvCurrentTemplate = t;
  // القيمة الافتراضية (t.rows/t.cols) تُستعمل فقط كـ fallback للقوالب
  // القديمة بلا luckysheetNative؛ الحجم الحقيقي والديناميكي يُشتقّ أدناه
  // من الورقة الحية (أبعادها الفعلية كما ضبطها المستخدم في المصمم، أو
  // امتداد المحتوى/الدمج الفعلي إن غابت الأبعاد) بعد استبعاد المخفي.
  _rvRows = t.rows || 10;
  _rvCols = t.cols || 10;

  // ⚠️ luckysheetNative المضغوط هو مصدر الحقيقة الوحيد للقوالب الجديدة —
  // نفكّه (_rbExpandNativeSheet) ثم نشتقّ منه styles/merges/colWidths/
  // rowHeights ومحتوى الخلايا وقت العرض فقط (بلا تخزين مضاعف). القوالب
  // القديمة المحفوظة قبل هذا التغيير لا تزال تحمل هذه الحقول جاهزة في
  // t.* مباشرة، فنسقط عليها كـ fallback.
  let derivedLegacy = null, derivedContent = null, expandedSheet = null;
  if (t.luckysheetNative && typeof _rbExpandNativeSheet === "function" && typeof _rbConvertNativeToLegacy === "function") {
    expandedSheet = _rbExpandNativeSheet(t.luckysheetNative);
    derivedLegacy = _rbConvertNativeToLegacy(expandedSheet);
    derivedContent = _rbCellsDataFromNative(expandedSheet);
  }

  _rvMerges = derivedLegacy ? derivedLegacy.merges
    : (t.merges ? JSON.parse(JSON.stringify(t.merges)) : []);
  _rvStyles = derivedLegacy ? derivedLegacy.styles
    : (t.styles ? JSON.parse(JSON.stringify(t.styles)) : {});
  _rvStyles = _rvRepairAlignmentFromNative(_rvStyles, t.luckysheetNative);
  // ⚠️ الصفوف/الأعمدة المخفية: نأخذها أساسًا من t.hiddenRows/hiddenCols
  // (المُشتقّة الآن بشكل صحيح وقت الحفظ من luckysheetBuilder.js)، لكن
  // ندمج معها أيضًا ما هو مخزَّن مباشرة داخل حالة Luckysheet الحية نفسها
  // (expandedSheet.config.rowhidden/colhidden) كطبقة أمان إضافية — فهذه
  // الأخيرة كانت دائمًا صحيحة (المستخدم يخفي من واجهة Luckysheet مباشرة)
  // حتى في القوالب القديمة المحفوظة قبل إصلاح هذا الخلل، حيث كانت
  // t.hiddenRows/hiddenCols تُحفَظ فارغة رغم إخفاء المستخدم لصفوف/أعمدة
  // فعليًا. الدمج هنا يصلح تلقائيًا عرض القوالب القديمة أيضًا دون الحاجة
  // لإعادة حفظها.
  const nativeHiddenRows = (expandedSheet && expandedSheet.config && expandedSheet.config.rowhidden) || {};
  const nativeHiddenCols = (expandedSheet && expandedSheet.config && expandedSheet.config.colhidden) || {};
  _rvHiddenRows = new Set([
    ...(Array.isArray(t.hiddenRows) ? t.hiddenRows : []),
    ...Object.keys(nativeHiddenRows).map(n => parseInt(n, 10)).filter(n => !isNaN(n)),
  ]);
  _rvHiddenCols = new Set([
    ...(Array.isArray(t.hiddenCols) ? t.hiddenCols : []),
    ...Object.keys(nativeHiddenCols).map(n => parseInt(n, 10)).filter(n => !isNaN(n)),
  ]);
  _rvColWidths = derivedLegacy ? derivedLegacy.colWidths
    : (t.colWidths ? JSON.parse(JSON.stringify(t.colWidths)) : {});
  _rvRowHeights = derivedLegacy ? derivedLegacy.rowHeights
    : (t.rowHeights ? JSON.parse(JSON.stringify(t.rowHeights)) : {});
  _rvHideGridlines = !!t.hideGridlines;
  // محتوى الخلايا: المشتقّ من الشبكة الأصلية أولاً، ثم صيغ DSL (SUMIFS/JOUR
  // ..) من مصدرين يُدمَجان معًا: qkf المُضمَّن مباشرة داخل خلايا الشبكة
  // الحية نفسها (الأحدث دائمًا، ولاحقة لأي حذف/إدراج صف أو عمود — انظر شرح
  // _rbDslCellsFromNative في luckysheetBuilder.js) ثم t.cellsData (تبقى
  // مفيدة كـ fallback للقوالب القديمة المحفوظة قبل إضافة qkf) تطغى فوقها.
  const nativeDsl = (expandedSheet && typeof _rbDslCellsFromNative === "function")
    ? _rbDslCellsFromNative(expandedSheet) : {};
  const dslOverrides = t.cellsData ? migrateCellsDataFormulas(JSON.parse(JSON.stringify(t.cellsData))) : {};
  const rawCellsData = derivedContent ? { ...derivedContent, ...nativeDsl, ...dslOverrides } : { ...nativeDsl, ...dslOverrides };

  // ── الحجم الديناميكي الفعلي (بدل رقم ثابت 10/20) ─────────────────
  // المصدر الأول: أبعاد الورقة الحية كما ضبطها المستخدم فعليًا في
  // المصمم (nativeSheet.row / nativeSheet.column — تشمل صفوف/أعمدة فارغة
  // مقصودة كجزء من التصميم). إن غابت، نشتقّ الحد الأقصى من امتداد
  // المحتوى الفعلي (خلايا، دمج، عرض/ارتفاع مضبوط يدويًا) بدل الاعتماد
  // على t.rows/t.cols المخزّنة (قد تكون قديمة/افتراضية 10).
  const _rvDims = _rvComputeExtent(expandedSheet, rawCellsData, _rvMerges, _rvColWidths, _rvRowHeights);
  if (_rvDims.rows) _rvRows = _rvDims.rows;
  if (_rvDims.cols) _rvCols = _rvDims.cols;

  const wrap = document.getElementById("rvGridWrap");
  const exportBtn = document.getElementById("btnRvExportExcel");
  const imgBtn = document.getElementById("btnRvExportImage");
  const copyBtn = document.getElementById("btnRvCopyImage");
  if (exportBtn) exportBtn.disabled = true;
  if (imgBtn) imgBtn.disabled = true;
  if (copyBtn) copyBtn.disabled = true;

  _rvTheday = (typeof App !== "undefined") ? getDateKey(App.currentDateOffset) : getDateKey(0);
  _rvUpdateTitle(t.name); // عنوان مبدئي (بدون انتظار جلب البيانات)

  // نطاق الجلب الفعلي المطلوب من صيغ القالب نفسه (بدل 60 يومًا افتراضيًا)
  const lookbackDays = _rvComputeRequiredLookbackDays(rawCellsData, _rvTheday);
  const totalDaysSpan = lookbackDays + 1; // يشمل theday نفسه
  if (wrap) {
    wrap.innerHTML = `<p class="settings-hint" style="text-align:center;padding:20px 0">جاري تحميل بيانات ${_rvArabicDaysLabel(totalDaysSpan)}...</p>`;
  }

  _rvSourcesMap = await _rvFetchSourcesMap(_rvTheday, lookbackDays);

  _rvComputeAllCells(rawCellsData);
  _rvRenderTable();
  _rvUpdateTitle(t.name);

  if (exportBtn) exportBtn.disabled = false;
  if (imgBtn) imgBtn.disabled = false;
  if (copyBtn) copyBtn.disabled = false;
}

// ══════════════════════════════════════════════════════════════
// تصدير Excel للتقرير المحسوب حاليًا (نفس القيم والتنسيق الظاهر)
// ══════════════════════════════════════════════════════════════
function rvExportToExcel() {
  if (!_rvCurrentTemplate || !_rvRows || !_rvCols) {
    addNotif("لا يوجد تقرير محمّل للتصدير", "warning");
    return;
  }
  if (typeof XLSX === "undefined") {
    addNotif("مكتبة Excel غير متوفرة", "error");
    return;
  }

  // الصفوف/الأعمدة المخفية تُستبعد كليًا من التصدير أيضًا (نفس منطق العرض)
  const visibleRows = [];
  for (let r = 0; r < _rvRows; r++) if (!_rvHiddenRows.has(r)) visibleRows.push(r);
  const visibleCols = [];
  for (let c = 0; c < _rvCols; c++) if (!_rvHiddenCols.has(c)) visibleCols.push(c);
  const rowIndexMap = new Map(visibleRows.map((r, i) => [r, i])); // فهرس أصلي -> فهرس بعد الاستبعاد
  const colIndexMap = new Map(visibleCols.map((c, i) => [c, i]));

  const aoa = [];
  for (const r of visibleRows) {
    const row = [];
    for (const c of visibleCols) {
      const id = _rbCellId(r, c);
      const cell = _rvCellsData[id];
      row.push(cell ? (cell.value ?? "") : "");
    }
    aoa.push(row);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // دمج الخلايا (نفس دمج القالب المحفوظ) — يُعاد فهرستها بعد استبعاد
  // الصفوف/الأعمدة المخفية، وتُستبعد أي دمج تقع بداخل صف/عمود مخفي كليًا
  const merges = _rvMerges
    .map(m => {
      const s = _rbParseCellId(m.start), e = _rbParseCellId(m.end);
      const r0 = Math.min(s.row, e.row), r1 = Math.max(s.row, e.row);
      const c0 = Math.min(s.col, e.col), c1 = Math.max(s.col, e.col);
      if (!rowIndexMap.has(r0) || !colIndexMap.has(c0)) return null; // بداية الدمج نفسها مخفية
      let re = r1, ce = c1;
      while (re > r0 && !rowIndexMap.has(re)) re--;
      while (ce > c0 && !colIndexMap.has(ce)) ce--;
      return {
        s: { r: rowIndexMap.get(r0), c: colIndexMap.get(c0) },
        e: { r: rowIndexMap.get(re) ?? rowIndexMap.get(r0), c: colIndexMap.get(ce) ?? colIndexMap.get(c0) },
      };
    })
    .filter(Boolean);
  if (merges.length) ws["!merges"] = merges;

  // تنسيق (خط/لون/حدود/رقم) لكل خلية معرّفة في _rvStyles (تُتجاهل خلايا الصفوف/الأعمدة المخفية)
  // ملاحظة: تنسيق "عملة" لا يملك رمزًا ثابتًا بعد الآن — يُبنى ديناميكيًا
  // من st.currencySymbol (نص حر اختياري لكل خلية)، أو بدون رمز إن تُرك فارغًا.
  const numFmtByFormat = {
    number: "#,##0.00",
    percentage: "0.00%",
    date: "dd/mm/yyyy",
  };
  for (const id in _rvStyles) {
    const p = _rbParseCellId(id);
    if (!p || !rowIndexMap.has(p.row) || !colIndexMap.has(p.col)) continue;
    const ref = XLSX.utils.encode_cell({ r: rowIndexMap.get(p.row), c: colIndexMap.get(p.col) });
    if (!ws[ref]) continue;
    const st = _rvStyles[id];
    const s = {};
    const font = {};
    if (st.bold) font.bold = true;
    if (st.italic) font.italic = true;
    if (st.underline) font.underline = true;
    if (st.color) font.color = { rgb: String(st.color).replace("#", "").toUpperCase() };
    if (st.fontSize) font.sz = st.fontSize;
    if (Object.keys(font).length) s.font = font;
    if (st.bg) s.fill = { fgColor: { rgb: String(st.bg).replace("#", "").toUpperCase() } };
    if (st.border) {
      const edge = { style: "thin", color: { rgb: "888888" } };
      if (st.border === "all") s.border = { top: edge, bottom: edge, left: edge, right: edge };
      else if (st.border === "bottom") s.border = { bottom: edge };
      else if (typeof st.border === "object") {
        s.border = {};
        if (st.border.t) s.border.top = edge;
        if (st.border.b) s.border.bottom = edge;
        if (st.border.l) s.border.left = edge;
        if (st.border.r) s.border.right = edge;
      }
    }
    if (Object.keys(s).length) ws[ref].s = s;
    let numFmt = st.format && numFmtByFormat[st.format];
    if (st.format === "currency") {
      const sym = (st.currencySymbol || "").trim().replace(/"/g, "");
      numFmt = sym ? `#,##0.00 "${sym}"` : "#,##0.00";
    }
    if (numFmt && ws[ref].t === "n") {
      ws[ref].z = numFmt;
      if (st.format === "percentage") ws[ref].v = ws[ref].v / 100; // Excel ينسّق النسبة كجزء عشري
    }
  }

  // عرض الأعمدة المحفوظ (يُستبعد منه الأعمدة المخفية، بنفس منطق العرض)
  ws["!cols"] = visibleCols.map(c => ({ wpx: _rvColWidths[c] || _RB_DEFAULT_COL_WIDTH }));

  XLSX.utils.book_append_sheet(wb, ws, "Report");

  const safeName = (_rvCurrentTemplate.name || "report").replace(/[\\/:*?"<>|]/g, "_").trim() || "report";
  const dateForFile = (_rvTheday || "").replace(/-/g, "");
  XLSX.writeFile(wb, `${safeName}_${dateForFile}.xlsx`);
}

// ══════════════════════════════════════════════════════════════
// تصدير/نسخ التقرير كصورة (PNG) عبر html-to-image — يلتقط #rvGridWrap
// كما يظهر فعليًا (تنسيق/دمج/ألوان/حدود) بدل إعادة رسمه يدويًا. نستعمل
// html-to-image بدل html2canvas لأن الأخيرة كانت لا ترسم حدود الخلايا
// (border/box-shadow) بموثوقية على جداول <table>؛ html-to-image يسلسل
// DOM كـSVG <foreignObject> فيرسمه المتصفح نفسه (دقة مطابقة 100%).
// ══════════════════════════════════════════════════════════════
// الأبعاد الحقيقية للجدول تُحسب من بيانات القالب (عرض/ارتفاع كل عمود/صف
// كما هي محفوظة) بدل الاعتماد على table.scrollWidth/scrollHeight، لأن
// هذين الأخيرين قد يختلفان على الهاتف (تكبير الخط التلقائي للمتصفح
// text-size-adjust، تقريب الأبعاد الفرعية subpixel، اختلاف devicePixelRatio)
// فتخرج الصورة بأبعاد مختلفة عن نفس التقرير على الكمبيوتر رغم أنه نفس القالب.
function _rvComputeExactPixelSize() {
  const visibleCols = [];
  for (let c = 0; c < _rvCols; c++) if (!_rvHiddenCols.has(c)) visibleCols.push(c);
  let width = 0;
  for (const c of visibleCols) width += _rvColWidths[c] || _RB_DEFAULT_COL_WIDTH;
  let height = 0;
  for (let r = 0; r < _rvRows; r++) {
    if (_rvHiddenRows.has(r)) continue;
    height += _rvRowHeights[r] || _RB_DEFAULT_ROW_HEIGHT;
  }
  return { width, height };
}

async function _rvCaptureCanvas() {
  const table = document.getElementById("rvGridTable");
  if (!table || typeof htmlToImage === "undefined") {
    addNotif("تعذّر إنشاء الصورة: مكتبة التصدير غير متوفرة", "error");
    return null;
  }
  const { width, height } = _rvComputeExactPixelSize();
  // نفرض العرض/الارتفاع الحقيقيَّين على الجدول نفسه قبل الالتقاط (بدل
  // تركه يتأثر بعرض الشاشة/تكبير الخط على الهاتف)، حتى تتطابق الصورة
  // بكسل-ببكسل مع نفس التقرير عند تصديره من الكمبيوتر.
  const prevWidth = table.style.width, prevHeight = table.style.height;
  const prevTextAdjust = table.style.webkitTextSizeAdjust;
  table.style.width = width + "px";
  table.style.height = height + "px";
  table.style.webkitTextSizeAdjust = "100%";
  try {
    return await htmlToImage.toCanvas(table, {
      backgroundColor: "#ffffff",
      pixelRatio: 2,
      width,
      height,
      skipFonts: true,
    });
  } finally {
    table.style.width = prevWidth;
    table.style.height = prevHeight;
    table.style.webkitTextSizeAdjust = prevTextAdjust;
  }
}

async function rvExportToImage() {
  const canvas = await _rvCaptureCanvas();
  if (!canvas) return;
  const safeName = ((_rvCurrentTemplate && _rvCurrentTemplate.name) || "report").replace(/[\\/:*?"<>|]/g, "_").trim() || "report";
  const dateForFile = (_rvTheday || "").replace(/-/g, "");
  canvas.toBlob((blob) => {
    if (!blob) { addNotif("فشل إنشاء الصورة", "error"); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeName}_${dateForFile}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, "image/png");
}

async function rvCopyToImage() {
  const canvas = await _rvCaptureCanvas();
  if (!canvas) return;
  if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
    addNotif("النسخ كصورة غير مدعوم في هذا المتصفح، جرّب التحميل بدلًا من ذلك", "error");
    return;
  }
  canvas.toBlob(async (blob) => {
    if (!blob) { addNotif("فشل إنشاء الصورة", "error"); return; }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      addNotif("تم نسخ التقرير كصورة", "success");
    } catch (e) {
      addNotif("فشل النسخ: " + e.message, "error");
    }
  }, "image/png");
}

// ══════════════════════════════════════════════════════════════
// فتح/إغلاق المودال
// ══════════════════════════════════════════════════════════════
async function openReportViewerModal() {
  const modal = document.getElementById("reportViewerModal");
  if (!modal) return;
  modal.style.display = "flex";
  _rvResetView();
  // تحميل مسبق للفئات المخصصة (منتجات/بائعين/قوائم أسعار) قبل أي حساب
  // SUMIFS على القالب المحمّل — نفس المنطق المستعمل في openReportBuilderModal
  // (دالة مشتركة _ensureCustomCategoriesLoaded في app.js)، لتفادي ظهور 0
  // للفئات المخصصة عند فتح "تحميل تقرير" مباشرة دون المرور بالمصمم أولًا.
  await _ensureCustomCategoriesLoaded();
  await _rvLoadTemplateList();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btnLoadReport")?.addEventListener("click", openReportViewerModal);
  document.getElementById("btnRvClose")?.addEventListener("click", () => {
    document.getElementById("reportViewerModal").style.display = "none";
  });
  document.getElementById("reportViewerModal")?.addEventListener("click", e => {
    if (e.target.id === "reportViewerModal") document.getElementById("reportViewerModal").style.display = "none";
  });
  document.getElementById("rvTemplateSelect")?.addEventListener("change", e => {
    if (e.target.value) rvLoadAndRenderTemplate(e.target.value);
    else _rvResetView();
  });
  document.getElementById("btnRvExportExcel")?.addEventListener("click", rvExportToExcel);
  document.getElementById("btnRvExportImage")?.addEventListener("click", rvExportToImage);
  document.getElementById("btnRvCopyImage")?.addEventListener("click", rvCopyToImage);
});
