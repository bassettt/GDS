// ══════════════════════════════════════════════════════════════
// formulaEngine.js — محرك حساب Report Builder
// الجزء 1: DSL حقيقي لصيغ SUMIFS(source; col1; val1; ...; ds; X; de; Y)
// الجزء 2: عمليات حسابية بسيطة بين خلايا الجدول (+ - * /)
// ══════════════════════════════════════════════════════════════

// ── أدوات مساعدة: قراءة id/name من حقل Odoo (رقم أو [id, name]) ──
function _refId(field) {
  return Array.isArray(field) ? field[0] : field;
}
function _refName(field) {
  return Array.isArray(field) ? field[1] : field;
}

// ══════════════════════════════════════════════════════════════
// 1.1 — resolveDateExpr: "jour" / "jour-N" / "YYYY-MM-DD" -> "YYYY-MM-DD"
// ══════════════════════════════════════════════════════════════

/**
 * @param {string} expr - "jour", "jour-3"، أو تاريخ صريح "YYYY-MM-DD"
 * @param {string} theday - التاريخ الحالي المختار (YYYY-MM-DD)
 * @returns {string} YYYY-MM-DD
 */
function resolveDateExpr(expr, theday) {
  const e = String(expr || "").trim();
  if (!e) throw new Error("تعبير تاريخ فارغ");

  if (!theday || !/^\d{4}-\d{2}-\d{2}$/.test(theday)) {
    throw new Error(`jour غير صالح: "${theday}"`);
  }

  if (/^jour$/i.test(e)) return theday;

  const m = /^jour\s*-\s*(\d+)$/i.exec(e);
  if (m) {
    const n = parseInt(m[1], 10);
    const d = new Date(theday + "T00:00:00");
    d.setDate(d.getDate() - n);
    return d.getFullYear() + "-" +
           String(d.getMonth() + 1).padStart(2, "0") + "-" +
           String(d.getDate()).padStart(2, "0");
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(e)) return e; // تاريخ صريح مسموح به أيضًا

  throw new Error(`تعبير تاريخ غير مفهوم: "${expr}" (مسموح: jour, jour-N, YYYY-MM-DD)`);
}

// ══════════════════════════════════════════════════════════════
// 1.1ب — formatIsoDateToDMY: "YYYY-MM-DD" -> "DD/MM/YYYY" (نص للعرض)
// ══════════════════════════════════════════════════════════════

/**
 * @param {string} iso - تاريخ بصيغة "YYYY-MM-DD" (أو يبدأ بها)
 * @returns {string} "DD/MM/YYYY"، أو النص الأصلي كما هو إن لم يطابق النمط
 */
function formatIsoDateToDMY(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso == null ? "" : iso));
  if (!m) return String(iso == null ? "" : iso);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// ══════════════════════════════════════════════════════════════
// 1.2 — mapping الأعمدة المدعومة. إضافة عمود جديد = سطر واحد هنا.
// كل مدخل: resolve(row) -> القيمة الفعلية (id عادةً) لأغراض المطابقة،
// matchName(row) -> اسم معروض (اختياري) لدعم المطابقة بالاسم النصي أيضًا.
// ══════════════════════════════════════════════════════════════

const COLUMN_MAP = {
  vnd: {
    resolveId:   row => _refId(row.user_id),
    resolveName: row => _refName(row.user_id),
    // فئات بائعين مخصصة (Firestore): العضوية تُطابَق مباشرة على vnd (user_id) نفسه.
    supportsCustomCategories: true,
    customCategoryIdsField: "sellerIds",
    resolveMemberId: row => _refId(row.user_id),
  },
  art: {
    // موحَّد على product_tmpl_id (قالب المنتج): fetchProductList (rpcController.js)
    // يجلب من product.template، فمعرّفات القائمة/الاختيار في formulaWizard هي
    // معرّفات template دومًا. لو أعطينا الأولوية لـproduct_id (variant) هنا، فأي
    // منتج له أكثر من متغيّر (variant) سيُقارَن بمعرّف خاطئ تمامًا (نفس خطأ cat
    // المُصلَح أدناه) فلن يُطابق أي صف. لذلك: product_tmpl_id أولًا دومًا،
    // وproduct_id كـfallback فقط لو غاب product_tmpl_id من الصف لأي سبب.
    resolveId:   row => _refId(row.product_tmpl_id != null ? row.product_tmpl_id : row.product_id),
    resolveName: row => _refName(row.product_tmpl_id != null ? row.product_tmpl_id : row.product_id),
  },
  cat: {
    resolveId:   row => _refId(row.categ_id),
    resolveName: row => _refName(row.categ_id),
    // فئات منتجات مخصصة (Firestore): العضوية تُطابَق على product_tmpl_id
    // للصف (منتجات الفئة)، وليس على categ_id نفسه.
    // ⚠️ موحَّد على product_tmpl_id فقط (وليس product_id كأولوية): فئات
    // المنتجات المخصصة تُخزَّن بمعرّفات product.template (fetchProductList
    // يجلب من product.template)، بينما product_id على صف sale.report/
    // stock.picking.report هو معرّف product.product (variant) — معرّف مختلف
    // تمامًا عند وجود أي متغيرات على المنتج. مقارنته أولًا كان يُنتج صفرًا
    // دائمًا لأي فئة منتجات مخصصة. product_tmpl_id موجود في fields/groupby
    // لكل من _rpc_fetchSaleRawRows و_rpc_fetchDilRawRows (rpcController.js).
    supportsCustomCategories: true,
    customCategoryIdsField: "productIds",
    resolveMemberId: row => _refId(row.product_tmpl_id),
  },
  // lp: تعريفة السعر المستعملة في البيع (جملة/تفصيل/GMS...).
  // مدعوم لمصدرَي vnt و liv كلاهما (تأكيد فعلي عبر fields_get على
  // stock.picking.report: يملك pricelist_id مباشرة -> product.pricelist،
  // بلا أي حاجة لربط عبر sale.order). enc (account.payment) لا يملك
  // هذا الحقل — أي شرط lp على enc سيُقارَن بـ undefined فلن يطابق أي
  // صف (استعمل all).
  lp: {
    resolveId:   row => _refId(row.pricelist_id),
    resolveName: row => _refName(row.pricelist_id),
    // فئات قوائم أسعار مخصصة (Firestore): العضوية تُطابَق مباشرة على lp
    // (pricelist_id) نفسه، بنفس منطق vnd/sellerIds أعلاه.
    supportsCustomCategories: true,
    customCategoryIdsField: "pricelistIds",
    resolveMemberId: row => _refId(row.pricelist_id),
  },
  // crt: منشئ السجل (createur) — create_uid. مدعوم فعليًا فقط لمصدر
  // enc (account.payment)، حيث أُضيف create_uid إلى fields/groupby في
  // _rpc_fetchEncRawRows (rpcController.js). غير مدعوم لـvnt/liv: تينك
  // الصفوف لا تملك حقل create_uid في الصف المُرجَع (لم يُتأكَّد أن له
  // معنى مشابهًا مفيدًا على sale.report/stock.picking.report، وهما
  // SQL views، بنفس منطق عدم التخمين الموثّق في rpcController.js).
  // أي شرط SUMIFS(vnt أو liv; crt; ...) سيُقارَن دائمًا بـundefined
  // فلن يطابق أي صف إلا "all" — استعمل crt فقط مع مصدر enc.
  crt: {
    resolveId:   row => _refId(row.create_uid),
    resolveName: row => _refName(row.create_uid),
  },
  // ── لإضافة عمود جديد لاحقًا: أضف سطرًا هنا بنفس النمط، مثال:
  // client: { resolveId: row => _refId(row.partner_id), resolveName: row => _refName(row.partner_id) },
};

/**
 * resolveColumn — يُرجع القيمة الفعلية لعمود معيّن من صف بيانات (لأغراض العرض/الاستعمال الخارجي).
 * @param {string} colName - اسم العمود (vnd/art/cat/lp...)
 * @param {Object} row - صف بيانات خام
 * @param {Array<Object>} [customCategories] - فئات مخصصة (لعمود cat فقط)
 * @returns {*} قيمة العمود (id عادة)، أو undefined إن كان العمود غير معروف
 */
function resolveColumn(colName, row, customCategories = []) {
  const key = String(colName || "").trim().toLowerCase();
  const def = COLUMN_MAP[key];
  if (!def) return undefined;
  return def.resolveId(row);
}


// يبحث عن فئة مخصصة بالاسم أو بالـid
function _findCustomCategory(value, customCategories) {
  const v = String(value);
  return (customCategories || []).find(
    c => String(c.id) === v || String(c.name).toLowerCase() === v.toLowerCase()
  );
}

function _matchesSingleColumnValue(def, value, row, customCategories, customSellerCategories, customPricelistCategories) {
  // أعمدة تدعم فئات مخصصة (Firestore) بالإضافة إلى القيمة الأصلية من Odoo:
  // cat -> فئات منتجات (productIds)، vnd -> فئات بائعين (sellerIds)،
  // lp -> فئات قوائم أسعار (pricelistIds).
  if (def.supportsCustomCategories) {
    let categoriesSource;
    if (def.customCategoryIdsField === "sellerIds") categoriesSource = customSellerCategories;
    else if (def.customCategoryIdsField === "pricelistIds") categoriesSource = customPricelistCategories;
    else categoriesSource = customCategories;
    const customCat = _findCustomCategory(value, categoriesSource);
    if (customCat) {
      const memberIds = new Set(customCat[def.customCategoryIdsField] || []);
      const memberId = def.resolveMemberId(row);
      return memberIds.has(memberId);
    }
    // ليست فئة مخصصة => قارن مباشرة مع القيمة الأصلية في Odoo (id أو اسم)
  }

  const rowId = def.resolveId(row);
  const rowName = def.resolveName ? def.resolveName(row) : undefined;

  if (/^-?\d+$/.test(String(value).trim())) {
    return Number(rowId) === Number(value);
  }
  return String(rowName != null ? rowName : rowId) === String(value);
}

/**
 * _matchesColumnCondition — هل يطابق الصف شرط (عمود = قيمة)؟
 * كلمة القيمة "all" (بغض النظر عن حالة الأحرف) => تجاهل الشرط كليًا (مطابقة دائمًا).
 * القيمة قد تحتوي عدة قيم مفصولة بفاصلة (مثل "أحمد,محمد") => مطابقة الصف
 * لو ساوت قيمته **أي واحدة** من القيم المذكورة (منطق OR داخل نفس الشرط).
 * الشروط المختلفة عن بعضها (أعمدة مختلفة) تبقى AND كما هي (بلا تغيير).
 * @param {Array<Object>} customCategories - فئات منتجات مخصصة (لعمود cat)
 * @param {Array<Object>} [customSellerCategories] - فئات بائعين مخصصة (لعمود vnd)
 * @param {Array<Object>} [customPricelistCategories] - فئات قوائم أسعار مخصصة (لعمود lp)
 */
function _matchesColumnCondition(colName, value, row, customCategories, customSellerCategories, customPricelistCategories) {
  const key = String(colName || "").trim().toLowerCase();

  if (String(value).trim().toUpperCase() === "ALL") return true; // all => لا فلترة (غير حساس لحالة الأحرف)

  const def = COLUMN_MAP[key];
  if (!def) {
    throw new Error(`عمود غير معروف: "${colName}" (المدعوم: ${Object.keys(COLUMN_MAP).join(", ")})`);
  }

  // دعم عدة قيم مفصولة بفاصلة لنفس الشرط (OR) — قيمة واحدة بدون فاصلة
  // تسلك بالضبط نفس المسار السابق (توافق عكسي كامل).
  const values = String(value).split(",").map(v => v.trim()).filter(v => v.length > 0);
  if (!values.length) return false;

  return values.some(v => _matchesSingleColumnValue(def, v, row, customCategories, customSellerCategories, customPricelistCategories));
}

// ══════════════════════════════════════════════════════════════
// 1.3 — إعداد المصادر (sources) وحقل التاريخ لكل مصدر
// ══════════════════════════════════════════════════════════════

const SOURCE_DATE_FIELD = {
  vnt: "date",       // J-1 sales (sale.report)
  liv: "date_done",  // توزيع (stock.picking.report)
  enc: "date",       // تحصيل (account.payment)
};

function _getSourceRows(sourceName, sourcesMap) {
  const key = String(sourceName || "").trim().toLowerCase();
  if (!(key in SOURCE_DATE_FIELD)) {
    throw new Error(`مصدر غير معروف: "${sourceName}" (المدعوم: ${Object.keys(SOURCE_DATE_FIELD).join(", ")})`);
  }
  const rows = sourcesMap && sourcesMap[key];
  return { key, rows: Array.isArray(rows) ? rows : [] };
}

// ══════════════════════════════════════════════════════════════
// 1.4 — Parser عام: يفكك FUNC(args) لأي دالة مسجّلة (قابل للتوسعة)
// ══════════════════════════════════════════════════════════════

function _parseFunctionCall(formulaString) {
  const expr = String(formulaString || "").trim().replace(/^=/, "").trim();
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*$/.exec(expr);
  if (!m) throw new Error(`صيغة غير صالحة: "${formulaString}" (الشكل المتوقع: FUNC(...))`);
  return { name: m[1].toUpperCase(), argsString: m[2] };
}

// يفكك "source; col1; val1; col2; val2; ...; ds; X; de; Y[; metric]"
function _parseSumIfsArgs(argsString) {
  const tokens = String(argsString || "")
    .split(";")
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (!tokens.length) throw new Error("SUMIFS: لا يوجد مصدر بيانات (source) في الصيغة");

  const source = tokens[0];
  const rest = tokens.slice(1);

  const conditions = [];
  let datestart = null;
  let dateend = null;
  let metric = null;

  let i = 0;
  while (i < rest.length) {
    const key = rest[i];
    const val = rest[i + 1];

    if (val === undefined) {
      // رمز فردي زائد في النهاية => يُعتبر تخصيص metric (amount/qty)
      metric = key;
      i += 1;
      continue;
    }

    const keyLower = key.toLowerCase();
    if (keyLower === "ds") {
      datestart = val;
    } else if (keyLower === "de") {
      dateend = val;
    } else {
      conditions.push({ column: key, value: val });
    }
    i += 2;
  }

  if (!datestart || !dateend) {
    throw new Error("SUMIFS: يجب تحديد ds و de");
  }

  return { source, conditions, datestart, dateend, metric };
}

// ══════════════════════════════════════════════════════════════
// 1.5 — تنفيذ SUMIFS
// ══════════════════════════════════════════════════════════════

function _rowDateValue(row, dateField) {
  const raw = row[dateField];
  if (!raw) return null;
  // يقبل "YYYY-MM-DD" أو "YYYY-MM-DD HH:MM:SS"
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw));
  return m ? m[1] : null;
}

// نمط مرجع خلية بسيط: حرف/أحرف عمود متبوعة برقم صف (A1, B12, AA3...)
const _SUMIFS_CELL_REF_RE = /^[A-Za-z]+[0-9]+$/;

/**
 * _resolveSumIfsConditionValue — إن كانت قيمة الشرط تطابق نمط مرجع خلية
 * (مثل A1) وتوجد قيمة فعلية محسوبة لتلك الخلية ضمن cellsValueMap، تُستبدل
 * القيمة بالقيمة الفعلية لتلك الخلية. غير ذلك تُرجَع القيمة كما هي (نص
 * عادي، اسم بائع، ALL، ...).
 * @param {*} value - قيمة الشرط كما وردت في الصيغة
 * @param {Object} cellsValueMap - { cellId: value } (قيم خلايا الشبكة الحالية)
 */
function _resolveSumIfsConditionValue(value, cellsValueMap) {
  const v = String(value == null ? "" : value).trim();
  if (!v || !_SUMIFS_CELL_REF_RE.test(v)) return value;
  const ref = v.toUpperCase();
  if (!cellsValueMap || !Object.prototype.hasOwnProperty.call(cellsValueMap, ref)) return value;
  const resolved = cellsValueMap[ref];
  return (resolved === undefined || resolved === null) ? "" : resolved;
}

/**
 * evaluateSumIfs — يفسّر وينفّذ صيغة "SUMIFS(...)" كاملة.
 * @param {string} formulaString - مثل "=SUMIFS(vnt; vnd; أحمد; cat; all; ds; jour-1; de; jour)"
 * @param {Object} sourcesMap - { vnt: Array<row>, liv: Array<row>, enc: Array<row> } — صفوف خام (search_read/read_group)
 * @param {string} theday - التاريخ الحالي المختار (YYYY-MM-DD)، يقابل App.currentDateOffset محوّلاً لتاريخ
 * @param {Array<Object>} [customCategories] - فئات المنتجات المخصصة { id, name, productIds }
 * @param {Array<Object>} [customSellerCategories] - فئات البائعين المخصصة { id, name, sellerIds }
 * @param {Array<Object>} [customPricelistCategories] - فئات قوائم الأسعار المخصصة { id, name, pricelistIds }
 * @param {Object} [cellsValueMap] - { cellId: value } — يسمح بالإشارة لخلية أخرى (مثل A1)
 *   بدل كتابة قيمة الشرط يدويًا؛ تُستبدل تلقائيًا بالقيمة الفعلية المحسوبة لتلك الخلية.
 * @returns {number}
 * @throws {Error} رسالة خطأ محددة عند صيغة/مصدر/عمود/تاريخ غير صالح
 */
function evaluateSumIfs(formulaString, sourcesMap, theday, customCategories = [], customSellerCategories = [], customPricelistCategories = [], cellsValueMap = {}) {
  const { name, argsString } = _parseFunctionCall(formulaString);
  if (name !== "SUMIFS") {
    throw new Error(`دالة غير مدعومة: "${name}" (المدعوم حاليًا: SUMIFS فقط)`);
  }

  const { source, conditions, datestart, dateend, metric } = _parseSumIfsArgs(argsString);
  const { key: sourceKey, rows } = _getSourceRows(source, sourcesMap);
  const dateField = SOURCE_DATE_FIELD[sourceKey];

  const from = resolveDateExpr(datestart, theday);
  const to = resolveDateExpr(dateend, theday);
  // metricField: "amount" (افتراضي)، "qty"، أو "pack1"/"pack2"/"pack3"
  // (packaging_quantity_1/2/3 — حقول مؤكَّدة فعليًا على sale.report
  // وstock.picking.report، انظر _rpc_fetchSaleRawRows/_rpc_fetchDilRawRows
  // في rpcController.js). أسماء pack1/2/3 مؤقتة حتى تأكيد أيها يمثل
  // الكرتون/الفردو فعليًا؛ ستُعاد تسميتها لاحقًا لاسم DSL نهائي أوضح.
  // ⚠️ غير مدعومة على مصدر enc (account.payment لا يملك هذه الحقول
  // أصلاً) — استعمالها مع enc يُرجع دائمًا 0 دون خطأ صريح (نفس تحذير
  // "صفر خاطئ صامت" الموثّق لـlp/cdn في rpcController.js).
  const _KNOWN_METRICS = ["amount", "qty", "pack1", "pack2", "pack3"];
  // توحيد حالة الأحرف: metric قد يصل بأي حالة أحرف (QTY، Qty، qty...) —
  // من autocomplete (يعرض بحروف كبيرة الآن) أو كتابة يدوية، ويجب أن
  // تُطابَق جميعها بنفس الطريقة، ثم استعمالها كاسم حقل فعلي (row[metricField])
  // بصيغتها الصغيرة الموحّدة (حقول الصفوف الخام دائمًا lowercase).
  const metricField = String(metric || "amount").trim().toLowerCase();
  if (!_KNOWN_METRICS.includes(metricField)) {
    throw new Error(`SUMIFS: metric غير معروف: "${metricField}" (المدعوم: ${_KNOWN_METRICS.join(", ")})`);
  }

  // استبدل أي شرط قيمته مرجع خلية (A1...) بالقيمة الفعلية المحسوبة لتلك الخلية
  const resolvedConditions = conditions.map(c => ({
    column: c.column,
    value: _resolveSumIfsConditionValue(c.value, cellsValueMap),
  }));

  const filtered = rows.filter(row => {
    const rowDate = _rowDateValue(row, dateField);
    if (rowDate === null) return false;
    if (rowDate < from || rowDate > to) return false;
    return resolvedConditions.every(c => _matchesColumnCondition(c.column, c.value, row, customCategories, customSellerCategories, customPricelistCategories));
  });

  return filtered.reduce((sum, row) => {
    const v = Number(row[metricField]);
    return sum + (Number.isFinite(v) ? v : 0);
  }, 0);
}

// ══════════════════════════════════════════════════════════════
// 1.5ب — evaluateJour: "=JOUR()" أو "=JOUR(jour-1)" -> نص تاريخ منسّق
// (DD/MM/YYYY) بدل رقم. يُستعمل لإدراج قيمة jour كنص ثابت داخل خلية
// عادية دون أن تُفسَّر كجزء من صيغة حسابية (SUMIFS مثلاً).
// ══════════════════════════════════════════════════════════════

/**
 * @param {string} formulaString - مثل "=JOUR()" أو "=JOUR(jour-1)" أو "=JOUR(2026-07-01)"
 * @param {string} theday - التاريخ الحالي المختار (YYYY-MM-DD)
 * @returns {string} تاريخ منسّق "DD/MM/YYYY"
 */
function evaluateJour(formulaString, theday) {
  const { name, argsString } = _parseFunctionCall(formulaString);
  if (name !== "JOUR") {
    throw new Error(`دالة غير مدعومة: "${name}" (متوقع JOUR)`);
  }
  const arg = String(argsString || "").trim();
  const iso = resolveDateExpr(arg || "jour", theday);
  return formatIsoDateToDMY(iso);
}

// ── اختبارات يدوية (الجزء 1) ─────────────────────────────────
function _runSumIfsTests() {
  const theday = "2026-07-17";
  const sourcesMap = {
    vnt: [
      { user_id: [5, "أحمد"], product_id: [101, "منتج أ"], categ_id: [10, "فئة أودو"], date: "2026-07-16", qty: 3, amount: 300 },
      { user_id: [6, "سارة"], product_id: [102, "منتج ب"], categ_id: [10, "فئة أودو"], date: "2026-07-16", qty: 2, amount: 200 },
      { user_id: [5, "أحمد"], product_id: [103, "منتج ج"], categ_id: [11, "فئة أخرى"], date: "2026-07-10", qty: 5, amount: 500 },
    ],
    liv: [],
    enc: [],
  };
  const customCategories = [{ id: "cat1", name: "فئتي", productIds: [101, 103] }];

  console.log("── اختبار 1: بائع أحمد ضمن jour-1..jour ──");
  console.log(evaluateSumIfs(
    "=SUMIFS(vnt; vnd; أحمد; cat; all; ds; jour-1; de; jour)",
    sourcesMap, theday, customCategories
  )); // 300 فقط (صف أحمد الآخر خارج النطاق الزمني)

  console.log("── اختبار 2: فئة مخصصة cat1 (بدون قيد تاريخ يحصر الكل) ──");
  console.log(evaluateSumIfs(
    "=SUMIFS(vnt; cat; cat1; ds; jour-10; de; jour)",
    sourcesMap, theday, customCategories
  )); // 800

  console.log("── اختبار 3: OR داخل شرط واحد (أحمد,محمد) ضمن فئة Extra ──");
  const sourcesMapOr = {
    vnt: [
      { user_id: [5, "أحمد"], product_id: [101, "منتج أ"], categ_id: [11, "Extra"], date: "2026-07-17", qty: 3, amount: 300 },
      { user_id: [7, "محمد"], product_id: [104, "منتج د"], categ_id: [11, "Extra"], date: "2026-07-17", qty: 4, amount: 400 },
      { user_id: [6, "سارة"], product_id: [102, "منتج ب"], categ_id: [11, "Extra"], date: "2026-07-17", qty: 2, amount: 200 },
    ],
    liv: [], enc: [],
  };
  console.log(evaluateSumIfs(
    "=SUMIFS(vnt; vnd; أحمد,محمد; cat; Extra; ds; jour; de; jour)",
    sourcesMapOr, theday
  )); // 700 (300+400، سارة مستبعدة)

  console.log("── اختبار 3: مصدر غير معروف => خطأ ──");
  try {
    evaluateSumIfs("=SUMIFS(xxx; vnd; أحمد; ds; jour; de; jour)", sourcesMap, theday);
    console.log("❌ لم يُرمَ خطأ!");
  } catch (e) {
    console.log("✅ خطأ متوقع:", e.message);
  }

  console.log("── اختبار 3ب: مرجع خلية (A1) بدل كتابة القيمة يدويًا ──");
  console.log(evaluateSumIfs(
    "=SUMIFS(vnt; vnd; A1; cat; all; ds; jour-1; de; jour)",
    sourcesMap, theday, customCategories, [], [], { A1: "أحمد" }
  )); // 300 (نفس نتيجة الاختبار 1، لكن عبر مرجع خلية بدل النص المباشر)
}

// ══════════════════════════════════════════════════════════════
// 1.6 — Migration: تحويل صيغ SUMIFS القديمة (بالأسماء قبل إعادة
// التسمية) إلى الأسماء الجديدة. تُشغَّل تلقائيًا عند تحميل أي قالب
// محفوظ سابقًا في Firestore حتى لا تنكسر القوالب القديمة.
// جدول التحويل: sale→vnt, dil→liv, enc→enc (بدون تغيير), vendeur→vnd,
// article→art, categ→cat, listeprix→lp, datestart→ds, dateend→de,
// theday→jour, ALL→all.
// ══════════════════════════════════════════════════════════════

const _FORMULA_TOKEN_MIGRATION_MAP = {
  sale: "vnt",
  dil: "liv",
  vendeur: "vnd",
  article: "art",
  categ: "cat",
  listeprix: "lp",
  datestart: "ds",
  dateend: "de",
  theday: "jour",
  all: "all", // ALL -> all (توحيد الكتابة فقط؛ المطابقة أصلًا غير حساسة لحالة الأحرف)
};

// بحث بالكلمة الكاملة (\b) لتفادي استبدال جزئي خاطئ، مثل "articles" التي
// لا يجب أن تتحول لأن الحرف "s" يلي "article" مباشرة فيبقيها ضمن كلمة واحدة.
const _FORMULA_TOKEN_MIGRATION_RE = new RegExp(
  "\\b(" + Object.keys(_FORMULA_TOKEN_MIGRATION_MAP).join("|") + ")\\b",
  "gi"
);

/**
 * migrateFormulaSource — يستبدل الأسماء القديمة ضمن نص صيغة SUMIFS واحدة
 * بالأسماء الجديدة (بحث/استبدال بالكلمة الكاملة). صيغة لا تحتوي أسماء
 * قديمة تُعاد كما هي بدون تغيير.
 * @param {string} formulaString
 * @returns {string}
 */
function migrateFormulaSource(formulaString) {
  if (typeof formulaString !== "string" || !formulaString) return formulaString;
  return formulaString.replace(_FORMULA_TOKEN_MIGRATION_RE, m => _FORMULA_TOKEN_MIGRATION_MAP[m.toLowerCase()]);
}

/**
 * migrateCellsDataFormulas — يطبّق migrateFormulaSource على حقل raw لكل
 * خلية ضمن cellsData قالب محفوظ (Firestore)، ويُرجع نسخة جديدة (لا يُعدّل
 * الكائن الأصلي). يُستدعى عند تحميل أي قالب قديم في reportBuilder.js /
 * reportViewer.js.
 * @param {Object} cellsData - { cellId: { raw, value?, ... } }
 * @returns {Object}
 */
function migrateCellsDataFormulas(cellsData) {
  const out = {};
  for (const id in (cellsData || {})) {
    const cell = cellsData[id] || {};
    out[id] = { ...cell };
    if (typeof cell.raw === "string" && cell.raw.trim().startsWith("=")) {
      out[id].raw = migrateFormulaSource(cell.raw);
    }
  }
  return out;
}

// ── اختبار يدوي: تحويل قالب قديم ────────────────────────────
function _runMigrationTests() {
  const oldFormula = "=SUMIFS(sale; vendeur; أحمد; categ; ALL; datestart; theday-1; dateend; theday)";
  const migrated = migrateFormulaSource(oldFormula);
  console.log("── اختبار 7: تحويل صيغة قديمة كاملة ──");
  console.log(migrated); // =SUMIFS(vnt; vnd; أحمد; cat; all; ds; jour-1; de; jour)

  console.log("── اختبار 8: تفادي استبدال جزئي خاطئ (articles) ──");
  console.log(migrateFormulaSource("=SUMIFS(sale; article; articles; datestart; theday-1; dateend; theday)"));
  // =SUMIFS(vnt; art; articles; ds; jour-1; de; jour)  — "articles" (القيمة) لم تتغيّر

  console.log("── اختبار 9: تحويل قالب كامل عبر migrateCellsDataFormulas ثم حسابه ──");
  const oldCellsData = {
    A1: { raw: "=SUMIFS(sale; vendeur; أحمد; categ; ALL; datestart; theday-1; dateend; theday)" },
  };
  const migratedCells = migrateCellsDataFormulas(oldCellsData);
  const sourcesMap = {
    vnt: [{ user_id: [5, "أحمد"], product_id: [101, "منتج أ"], categ_id: [10, "فئة أودو"], date: "2026-07-16", qty: 3, amount: 300 }],
    liv: [], enc: [],
  };
  console.log(evaluateSumIfs(migratedCells.A1.raw, sourcesMap, "2026-07-17")); // 300
}

// ══════════════════════════════════════════════════════════════
// 1.5ج — evaluateSum: "=SUM(A1:A5)" أو "=SUM(A1:A5; B2:B3; C1)"
// تجمع نطاق خلايا (مثل Excel) وتعمل كعنصر أوّلي داخل صيغة مركّبة.
// تدعم:
//   - نطاق واحد:         SUM(A1:A5)
//   - عدة نطاقات:        SUM(A1:A3; B1:B3)
//   - خلايا مفردة:       SUM(A1; B2; C3)
//   - خليط:              SUM(A1:A3; B2; C1:C2)
//   - تركيب في صيغة:     =SUM(A1:A5) - SUM(B1:B3) + SUMIFS(...)
// ══════════════════════════════════════════════════════════════

/**
 * _expandCellRange — يُوسّع نطاق "A1:C3" إلى قائمة بمعرّفات الخلايا
 * ["A1","A2","A3","B1","B2","B3","C1","C2","C3"] (عمود أولًا مثل Excel).
 * @param {string} from - معرّف الخلية العلوية اليسرى (مثل "A1")
 * @param {string} to   - معرّف الخلية السفلية اليمنى (مثل "C3")
 * @returns {string[]}
 */
function _expandCellRange(from, to) {
  // يفكك "A1" إلى { col: "A", row: 1 }
  function parseRef(ref) {
    const m = /^([A-Za-z]+)(\d+)$/.exec(ref);
    if (!m) throw new Error(`مرجع خلية غير صالح: "${ref}"`);
    return { col: m[1].toUpperCase(), row: parseInt(m[2], 10) };
  }
  // تحويل سلسلة أحرف العمود إلى رقم (A=1, Z=26, AA=27, ...)
  function colToNum(col) {
    let n = 0;
    for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  }
  // تحويل رقم العمود إلى سلسلة أحرف
  function numToCol(n) {
    let s = "";
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  const f = parseRef(from);
  const t = parseRef(to);
  const colStart = Math.min(colToNum(f.col), colToNum(t.col));
  const colEnd   = Math.max(colToNum(f.col), colToNum(t.col));
  const rowStart = Math.min(f.row, t.row);
  const rowEnd   = Math.max(f.row, t.row);

  const ids = [];
  for (let c = colStart; c <= colEnd; c++) {
    for (let r = rowStart; r <= rowEnd; r++) {
      ids.push(numToCol(c) + r);
    }
  }
  return ids;
}

/**
 * _parseSumArgs — يفكّك وسيطات SUM (مفصولة بـ ";") إلى قائمة معرّفات خلايا.
 * كل وسيطة إمّا نطاق "A1:C3" أو خلية مفردة "A1" أو رقم مباشر "5".
 * @param {string} argsString
 * @returns {Array<{type:"range"|"cell"|"number", ids?:string[], value?:number}>}
 */
function _parseSumArgs(argsString) {
  const tokens = String(argsString || "")
    .split(";")
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (!tokens.length) throw new Error("SUM: لا توجد وسيطات");

  return tokens.map(tok => {
    // نطاق: A1:C3
    const rangeM = /^([A-Za-z]+[0-9]+)\s*:\s*([A-Za-z]+[0-9]+)$/.exec(tok);
    if (rangeM) {
      return { type: "range", ids: _expandCellRange(rangeM[1], rangeM[2]) };
    }
    // خلية مفردة: A1
    const cellM = /^[A-Za-z]+[0-9]+$/.exec(tok);
    if (cellM) {
      return { type: "cell", ids: [tok.toUpperCase()] };
    }
    // رقم مباشر
    const numM = /^-?\d+(?:\.\d+)?$/.exec(tok);
    if (numM) {
      return { type: "number", value: parseFloat(tok) };
    }
    throw new Error(`SUM: وسيطة غير صالحة: "${tok}" (المتوقع: نطاق A1:B3، أو خلية A1، أو رقم)`);
  });
}

// ══════════════════════════════════════════════════════════════
// الجزء 2: عمليات بين الخلايا — يُبنى فوق الجزء 1
// ══════════════════════════════════════════════════════════════

const _CELL_REF_RE = /^[A-Za-z]+[0-9]+$/;

// يجد نهاية استدعاء دالة (مثل SUMIFS(...)) بدءًا من موضع "(" بالضبط —
// عبر عدّاد عمق الأقواس (يدعم أي أقواس متداخلة نظريًا، رغم أن SUMIFS لا
// تحتوي عمليًا أقواسًا داخلية). يُرجع الموضع مباشرة بعد ")" المطابق،
// أو -1 إن لم يُغلَق القوس.
function _findMatchingParenEnd(text, openParenIdx) {
  let depth = 0;
  for (let i = openParenIdx; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * _extractSumIfsCalls — يستخرج كل استدعاءات "SUMIFS(...)" الكاملة (نصًا خامًا،
 * بأقواسها) الموجودة داخل نص صيغة، بغض النظر عمّا يحيط بها (عمليات حسابية،
 * مراجع خلايا، دوال أخرى...). يُستعمل مثلًا لفحص كل شروط ds/de في صيغة
 * مركّبة تحتوي أكثر من SUMIFS واحدة (بدل الاقتصار على صيغة SUMIFS مفردة).
 * @param {string} text
 * @returns {string[]} كل استدعاء كنص كامل "SUMIFS(...)"
 */
function _extractSumIfsCalls(text) {
  const expr = String(text || "");
  const calls = [];
  const re = /SUMIFS\s*\(/gi;
  let m;
  while ((m = re.exec(expr))) {
    const openIdx = expr.indexOf("(", m.index);
    const endIdx = _findMatchingParenEnd(expr, openIdx);
    if (endIdx === -1) break; // قوس غير مغلَق — توقف عن المسح
    calls.push(expr.slice(m.index, endIdx));
    re.lastIndex = endIdx;
  }
  return calls;
}

/**
 * evaluateCellFormula — يحسب قيمة صيغة نصية تعتمد على + - * / بين عناصر
 * أوّلية (لا دعم لصيغ Excel المعقدة مثل IF/VLOOKUP حاليًا). كل عنصر أوّلي
 * يمكن أن يكون: مرجع خلية (A1)، عدد، أو استدعاء "SUMIFS(...)" كامل (يُحسب
 * عبر evaluateSumIfs باستعمال sumifsCtx) — يسمح هذا بتركيب أكثر من SUMIFS
 * بعملية حسابية بينها في نفس الخلية (مثال: =SUMIFS(...) - SUMIFS(...)),
 * وبنفس المبدأ المستعمل أصلًا بين مراجع الخلايا (A1+A2)، هنا بين نتائج
 * SUMIFS بدل مراجع خلايا (أو خليط من الاثنين).
 * @param {string} formulaString - مثل "=A1+A2-A3"، أو "=SUMIFS(...)-SUMIFS(...)"
 * @param {Object} cellsMap - { cellId: value } — القيمة قد تكون رقمًا، أو نصًا
 *   يمثّل صيغة أخرى تبدأ بـ "=" (تُحسب تلقائيًا بشكل متكرر). أسماء مراجع
 *   الخلايا حساسة لحالة الأحرف في cellsMap (يجب أن تكون بأحرف كبيرة، كما
 *   تُولَّد فعليًا في reportBuilder.js)، لذا يُطابَق مرجع الخلية دومًا بعد
 *   تحويله لحروف كبيرة (a1 وA1 وa1 كلها نفس الخلية).
 * @param {Set<string>} [_visiting] - داخلي: لتتبّع الاعتماد الدائري، لا يُمرَّر يدويًا.
 * @param {Object|null} [sumifsCtx] - سياق حساب SUMIFS (مطلوب فقط إن كانت
 *   الصيغة تحتوي SUMIFS(...))؛ الشكل:
 *   { sourcesMap, theday, customCategories, customSellerCategories, customPricelistCategories, cellsValueMap }
 * @returns {number}
 * @throws {Error} عند اعتماد دائري أو صيغة/خلية غير صالحة، أو SUMIFS بلا sumifsCtx.
 */
function evaluateCellFormula(formulaString, cellsMap, _visiting = new Set(), sumifsCtx = null) {
  if (typeof formulaString !== "string") {
    throw new Error("الصيغة يجب أن تكون نصًا");
  }
  const expr = formulaString.trim().replace(/^=/, "");
  if (!expr.trim()) {
    throw new Error(`صيغة فارغة أو غير صالحة: "${formulaString}"`);
  }

  function resolveCell(ref) {
    // توحيد حالة الأحرف: a1 وA1 وA1 (بأي حالة) تُعتبر دومًا نفس الخلية
    // (مفاتيح cellsMap دائمًا أحرف كبيرة — انظر _rbCellId في reportBuilder.js).
    const key = String(ref).toUpperCase();
    if (_visiting.has(key)) {
      throw new Error(`اعتماد دائري (circular reference) عند الخلية ${key}`);
    }
    if (!cellsMap || !(key in cellsMap)) {
      throw new Error(`الخلية ${key} غير موجودة`);
    }
    const raw = cellsMap[key];
    if (typeof raw === "string" && raw.trim().startsWith("=")) {
      const nextVisiting = new Set(_visiting);
      nextVisiting.add(key);
      return evaluateCellFormula(raw, cellsMap, nextVisiting, sumifsCtx);
    }
    const num = Number(raw);
    if (Number.isNaN(num)) {
      throw new Error(`قيمة الخلية ${key} ليست رقمًا`);
    }
    return num;
  }

  function resolveSumIfsCall(callText) {
    if (!sumifsCtx) {
      throw new Error("SUMIFS غير مدعومة في هذا السياق");
    }
    return evaluateSumIfs(
      "=" + callText,
      sumifsCtx.sourcesMap,
      sumifsCtx.theday,
      sumifsCtx.customCategories,
      sumifsCtx.customSellerCategories,
      sumifsCtx.customPricelistCategories,
      sumifsCtx.cellsValueMap
    );
  }

  // حساب SUM(A1:A5; B2; ...) — يجمع نطاقات وخلايا مفردة (مثل Excel)
  function resolveSumCall(callText) {
    // callText مثل "SUM(A1:A5; B2)"
    const openIdx = callText.indexOf("(");
    const argsString = callText.slice(openIdx + 1, callText.length - 1); // بدون الأقواس
    const args = _parseSumArgs(argsString);
    let total = 0;
    for (const arg of args) {
      if (arg.type === "number") {
        total += arg.value;
      } else {
        // range أو cell
        for (const id of arg.ids) {
          const key = id.toUpperCase();
          if (!cellsMap || !(key in cellsMap)) continue; // خلية فارغة => 0
          const raw = cellsMap[key];
          if (typeof raw === "string" && raw.trim().startsWith("=")) {
            const nextVisiting = new Set(_visiting);
            nextVisiting.add(key);
            if (_visiting.has(key)) throw new Error(`اعتماد دائري (circular reference) عند الخلية ${key}`);
            total += evaluateCellFormula(raw, cellsMap, nextVisiting, sumifsCtx);
          } else {
            const num = Number(raw);
            if (Number.isFinite(num)) total += num;
          }
        }
      }
    }
    return total;
  }

  let pos = 0;
  function skipSpaces() { while (pos < expr.length && /\s/.test(expr[pos])) pos++; }

  function parsePrimary() {
    skipSpaces();
    if (pos >= expr.length) throw new Error("خطأ في الصيغة: رمز مفقود");

    // استدعاء SUMIFS(...) كامل — نجد قوس الإغلاق المطابق أولًا (بغض النظر
    // عمّا بداخله من فواصل منقوطة/شرطات/نص عربي، لا يُفسَّر كتوكِنات هنا).
    if (/^SUMIFS\s*\(/i.test(expr.slice(pos))) {
      const openIdx = expr.indexOf("(", pos);
      const endIdx = _findMatchingParenEnd(expr, openIdx);
      if (endIdx === -1) throw new Error("خطأ في الصيغة: قوس SUMIFS غير مغلَق");
      const callText = expr.slice(pos, endIdx);
      pos = endIdx;
      return resolveSumIfsCall(callText);
    }

    // استدعاء SUM(...) كامل — يجمع نطاق خلايا (مثل SUM(A1:A5) أو SUM(A1:A3; B2))
    // ⚠️ يجب أن يُفحص قبل مرجع الخلية لتفادي تفسير "SUM" كمرجع خلية غير صالح.
    // ويجب أن يكون "SUM" بدون "IFS" بعده (لتفادي تعارض مع SUMIFS أعلاه).
    if (/^SUM\s*\(/i.test(expr.slice(pos)) && !/^SUMIFS\s*\(/i.test(expr.slice(pos))) {
      const openIdx = expr.indexOf("(", pos);
      const endIdx = _findMatchingParenEnd(expr, openIdx);
      if (endIdx === -1) throw new Error("خطأ في الصيغة: قوس SUM غير مغلَق");
      const callText = expr.slice(pos, endIdx);
      pos = endIdx;
      return resolveSumCall(callText);
    }

    // مرجع خلية (A1)
    const cellM = /^[A-Za-z]+[0-9]+/.exec(expr.slice(pos));
    if (cellM) {
      pos += cellM[0].length;
      return resolveCell(cellM[0]);
    }

    // عدد
    const numM = /^\d+(?:\.\d+)?/.exec(expr.slice(pos));
    if (numM) {
      pos += numM[0].length;
      return parseFloat(numM[0]);
    }

    throw new Error(`خطأ في الصيغة: رمز غير معروف عند الموضع ${pos} ("${expr.slice(pos, pos + 12)}")`);
  }

  function parseTerm() {
    let value = parsePrimary();
    skipSpaces();
    while (expr[pos] === "*" || expr[pos] === "/") {
      const op = expr[pos]; pos++;
      skipSpaces();
      const rhs = parsePrimary();
      if (op === "/" && rhs === 0) throw new Error("خطأ في الصيغة: قسمة على صفر");
      value = op === "*" ? value * rhs : value / rhs;
      skipSpaces();
    }
    return value;
  }

  function parseExpression() {
    let value = parseTerm();
    skipSpaces();
    while (expr[pos] === "+" || expr[pos] === "-") {
      const op = expr[pos]; pos++;
      skipSpaces();
      const rhs = parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
      skipSpaces();
    }
    return value;
  }

  const result = parseExpression();
  skipSpaces();
  if (pos !== expr.length) {
    throw new Error(`صيغة غير صالحة: رموز زائدة بعد الموضع ${pos}`);
  }
  return result;
}

// ── اختبارات يدوية (الجزء 2) ─────────────────────────────────
function _runCellFormulaTests() {
  const cells = { A1: 10, A2: 5, A3: 2, A4: "=A1+A2" }; // A4 = 15 (اعتماد متسلسل)

  console.log("── اختبار 4: عملية بسيطة A1+A2-A3 ──");
  console.log(evaluateCellFormula("=A1+A2-A3", cells)); // 13

  console.log("── اختبار 5: اعتماد متسلسل A4*A3 (A4=A1+A2) ──");
  console.log(evaluateCellFormula("=A4*A3", cells)); // 30

  console.log("── اختبار 6: اعتماد دائري (يجب أن يرمي خطأ) ──");
  try {
    const circular = { A1: "=A2", A2: "=A1" };
    evaluateCellFormula("=A1", circular);
    console.log("❌ لم يُكتشف الاعتماد الدائري!");
  } catch (e) {
    console.log("✅ خطأ متوقع:", e.message);
  }

  console.log("── اختبار 7: مرجع خلية بحروف صغيرة (a1) — يجب أن يُطابَق A1 ──");
  console.log(evaluateCellFormula("=a1+a2", cells)); // 15 (a1->A1=10, a2->A2=5)

  console.log("── اختبار 8: تركيب أكثر من SUMIFS بعملية حسابية بينهما ──");
  const sumifsCtx = {
    sourcesMap: {
      vnt: [
        { user_id: [5, "أحمد"], categ_id: [10, "فئة"], date: "2026-07-17", qty: 3, amount: 300 },
        { user_id: [7, "محمد"], categ_id: [10, "فئة"], date: "2026-07-17", qty: 4, amount: 400 },
      ],
      liv: [], enc: [],
    },
    theday: "2026-07-17",
    customCategories: [], customSellerCategories: [], customPricelistCategories: [],
    cellsValueMap: {},
  };
  console.log(evaluateCellFormula(
    "=SUMIFS(vnt; vnd; أحمد; ds; jour; de; jour) - SUMIFS(vnt; vnd; محمد; ds; jour; de; jour)",
    {}, new Set(), sumifsCtx
  )); // 300 - 400 = -100

  console.log("── اختبار 9: metric بحروف كبيرة (QTY) — يجب أن يُطابَق qty ──");
  console.log(evaluateCellFormula(
    "=SUMIFS(vnt; vnd; أحمد; ds; jour; de; jour; QTY)",
    {}, new Set(), sumifsCtx
  )); // 3

  console.log("── اختبار 10: SUMIFS(...) بدون sumifsCtx — يجب أن يرمي خطأ واضح ──");
  try {
    evaluateCellFormula("=SUMIFS(vnt; vnd; أحمد; ds; jour; de; jour)", {});
    console.log("❌ لم يُرمَ خطأ!");
  } catch (e) {
    console.log("✅ خطأ متوقع:", e.message);
  }
}

// ── تصدير ─────────────────────────────────────────────────────
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    evaluateSumIfs,
    evaluateCellFormula,
    evaluateJour,
    resolveDateExpr,
    resolveColumn,
    formatIsoDateToDMY,
    migrateFormulaSource,
    migrateCellsDataFormulas,
    _expandCellRange,
    _parseSumArgs,
    _extractSumIfsCalls,
    _runSumIfsTests,
    _runCellFormulaTests,
    _runMigrationTests,
  };
}
