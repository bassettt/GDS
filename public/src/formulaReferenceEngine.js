// ══════════════════════════════════════════════════════════════
// formulaReferenceEngine.js — Smart Cell References لـ Report Builder
// وحدة مستقلة (بدون تبعيات) تُحمَّل قبل reportBuilder.js.
// تغطي:
//   1) Formula Parser: استخراج مراجع الخلايا (A1, $A1, A$1, $A$1) من نص الصيغة.
//   2) Fill/Drag: تعديل المراجع نسبيًا حسب مسافة السحب، مع احترام $ (تجميد).
//   3) Insert/Delete: تعديل كل المراجع التي تقع بعد نقطة الإدراج/الحذف
//      بمقدار ±1 على المحور المعني، بغض النظر عن $.
// جميع الإحداثيات (row/col) هنا 0-based، مطابقةً لبقية reportBuilder.js.
// ══════════════════════════════════════════════════════════════

(function (global) {

  // كلمات تُستبعد من الاعتبار كمراجع خلايا (أسماء عناصر سياق داخلية،
  // وليست مراجع فعلية) — قابلة للتوسعة من الخارج عبر الخيار excludeSet.
  var DEFAULT_EXCLUDE = new Set(["PACK1", "PACK2", "PACK3"]);

  // ── تحويل بين حروف العمود ورقمه (0-based) ──────────────────
  function colLettersFromIndex(index) { // 0-based -> "A","B",...,"Z","AA",...
    var n = index + 1, s = "";
    while (n > 0) {
      var rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
  function colIndexFromLetters(letters) { // "A"->0, "B"->1, "AA"->26
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }

  // ══════════════════════════════════════════════════════════════
  // 1) Formula Parser
  // ══════════════════════════════════════════════════════════════

  // Regex يلتقط:
  //  - نصوصًا بين علامتي اقتباس كاملة (تُتجاهل بلا تفكيك)
  //  - أو مرجع خلية بأحد الأنماط الأربعة: A1 / $A1 / A$1 / $A$1
  // مع lookbehind/lookahead تمنعان التقاط جزء من اسم دالة أو معرّف أطول
  // (مثال: JOUR(...) لا يُلتقط كمرجع، وLOG10( لا تُلتقط لأنها متبوعة بـ"(").
  var REF_TOKEN_RE = /("(?:[^"\\]|\\.)*")|(?<![A-Za-z0-9_$])(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)(?![A-Za-z0-9_(])/g;

  /**
   * يحلل نص صيغة ويستخرج كل مراجع الخلايا الموجودة فيه (بترتيب ظهورها)،
   * متجاهلاً النصوص بين علامتي الاقتباس والكلمات المستثناة.
   * @param {string} raw نص الصيغة (يبدأ عادة بـ"=")
   * @param {Set<string>} [excludeSet] كلمات إضافية تُستبعد (حالة أحرف غير حساسة)
   * @returns {Array<{ref:string, index:number, length:number,
   *   col:number, row:number, colFrozen:boolean, rowFrozen:boolean}>}
   */
  function extractCellRefs(raw, excludeSet) {
    var exclude = excludeSet || DEFAULT_EXCLUDE;
    var out = [];
    if (typeof raw !== "string" || !raw) return out;
    REF_TOKEN_RE.lastIndex = 0;
    var m;
    while ((m = REF_TOKEN_RE.exec(raw)) !== null) {
      if (m[1] !== undefined) continue; // نص بين اقتباسين: تجاهل
      var whole = m[0];
      var colDollar = m[2], colLetters = m[3], rowDollar = m[4], rowDigits = m[5];
      if (exclude.has(whole.toUpperCase())) continue;
      out.push({
        ref: whole,
        index: m.index,
        length: whole.length,
        col: colIndexFromLetters(colLetters.toUpperCase()),
        row: parseInt(rowDigits, 10) - 1,
        colFrozen: colDollar === "$",
        rowFrozen: rowDollar === "$",
      });
    }
    return out;
  }

  /**
   * يبني نص مرجع خلية من إحداثيات 0-based وحالة التجميد لكل محور.
   */
  function buildRef(col, row, colFrozen, rowFrozen) {
    return (colFrozen ? "$" : "") + colLettersFromIndex(col) +
           (rowFrozen ? "$" : "") + String(row + 1);
  }

  // ══════════════════════════════════════════════════════════════
  // 2) Fill / Drag — إزاحة نسبية مع احترام تجميد $
  // ══════════════════════════════════════════════════════════════

  /**
   * يُنتج نص صيغة جديد بعد إزاحة مراجعها بمقدار (rowDelta, colDelta)،
   * ناتجة عن سحب/نسخ خلية عموديًا أو أفقيًا. المرجع المجمَّد بـ$ على محور
   * معيّن لا يتغيّر على ذلك المحور تحديدًا (السلوك القياسي في Excel/Sheets).
   * إن لم تكن raw صيغة (لا تبدأ بـ"=") تُعاد كما هي حرفيًا.
   * @param {string} raw
   * @param {number} rowDelta
   * @param {number} colDelta
   * @param {Set<string>} [excludeSet]
   */
  function shiftRefsForFill(raw, rowDelta, colDelta, excludeSet) {
    if (typeof raw !== "string" || !raw.trim().startsWith("=")) return raw;
    if (rowDelta === 0 && colDelta === 0) return raw;
    var exclude = excludeSet || DEFAULT_EXCLUDE;
    REF_TOKEN_RE.lastIndex = 0;
    return raw.replace(REF_TOKEN_RE, function (whole, quoted, colDollar, colLetters, rowDollar, rowDigits) {
      if (quoted !== undefined) return quoted;
      if (exclude.has(whole.toUpperCase())) return whole;
      var col = colIndexFromLetters(colLetters.toUpperCase());
      var row = parseInt(rowDigits, 10) - 1;
      var newCol = colDollar === "$" ? col : col + colDelta;
      var newRow = rowDollar === "$" ? row : row + rowDelta;
      if (newRow < 0 || newCol < 0) return whole; // لا نطاق سالب: أبقِ المرجع كما هو
      return buildRef(newCol, newRow, colDollar === "$", rowDollar === "$");
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 3) Insert / Delete — إزاحة كل المراجع بعد نقطة الإدراج/الحذف
  // ══════════════════════════════════════════════════════════════

  /**
   * يُحدّث كل مراجع الخلايا داخل صيغة عند إدراج/حذف صف أو عمود عند atIndex.
   * على عكس fill: التحديث هنا يشمل كل مرجع يقع عند/بعد atIndex على المحور
   * المعني (row أو col)، بصرف النظر تمامًا عن حالة $ (لأن هذا تحوّل هيكلي
   * في الشيت وليس نسخًا نسبيًا).
   * @param {string} raw نص الصيغة
   * @param {"row"|"col"} kind المحور المتأثر
   * @param {number} atIndex فهرس الإدراج/الحذف (0-based)
   * @param {1|-1} delta 1 = إدراج (زيادة)، -1 = حذف (نقصان)
   * @param {Set<string>} [excludeSet]
   * @returns {string} نص الصيغة بعد التحديث. عند الحذف، أي مرجع يشير بالضبط
   *   إلى الصف/العمود المحذوف يبقى بلا تغيير في رقمه (لا يوجد "مرجع محذوف"
   *   صالح رياضيًا)، فقط يُنقص كل ما بعده.
   */
  function shiftRefsForInsertDelete(raw, kind, atIndex, delta, excludeSet) {
    if (typeof raw !== "string" || !raw.trim().startsWith("=")) return raw;
    var exclude = excludeSet || DEFAULT_EXCLUDE;
    REF_TOKEN_RE.lastIndex = 0;
    return raw.replace(REF_TOKEN_RE, function (whole, quoted, colDollar, colLetters, rowDollar, rowDigits) {
      if (quoted !== undefined) return quoted;
      if (exclude.has(whole.toUpperCase())) return whole;
      var col = colIndexFromLetters(colLetters.toUpperCase());
      var row = parseInt(rowDigits, 10) - 1;
      var newCol = col, newRow = row;
      if (kind === "col") {
        if (delta > 0) { if (col >= atIndex) newCol = col + 1; }
        else { if (col > atIndex) newCol = col - 1; }
      } else {
        if (delta > 0) { if (row >= atIndex) newRow = row + 1; }
        else { if (row > atIndex) newRow = row - 1; }
      }
      return buildRef(newCol, newRow, colDollar === "$", rowDollar === "$");
    });
  }

  /**
   * يحدّث مراجع صيغة خلية واحدة عبر خريطة raw كاملة لشيت (cellId -> raw)
   * دفعة واحدة عند إدراج/حذف. دالة مساعدة تُستعمل من reportBuilder.js.
   * @param {Object<string,string>} rawByCellId
   * @param {"row"|"col"} kind
   * @param {number} atIndex
   * @param {1|-1} delta
   * @param {Set<string>} [excludeSet]
   * @returns {Object<string,string>} خريطة جديدة بنفس المفاتيح، بصيغ محدّثة
   */
  function remapAllFormulas(rawByCellId, kind, atIndex, delta, excludeSet) {
    var out = {};
    for (var id in rawByCellId) {
      if (!Object.prototype.hasOwnProperty.call(rawByCellId, id)) continue;
      out[id] = shiftRefsForInsertDelete(rawByCellId[id], kind, atIndex, delta, excludeSet);
    }
    return out;
  }

  var api = {
    colLettersFromIndex: colLettersFromIndex,
    colIndexFromLetters: colIndexFromLetters,
    extractCellRefs: extractCellRefs,
    buildRef: buildRef,
    shiftRefsForFill: shiftRefsForFill,
    shiftRefsForInsertDelete: shiftRefsForInsertDelete,
    remapAllFormulas: remapAllFormulas,
    DEFAULT_EXCLUDE: DEFAULT_EXCLUDE,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.FormulaReferenceEngine = api;

})(typeof window !== "undefined" ? window : globalThis);
