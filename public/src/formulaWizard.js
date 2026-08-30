// ══════════════════════════════════════════════════════════════
// formulaWizard.js — منشئ صيغ تفاعلي (Formula Wizard) لـReport Builder
// بديل عن كتابة SUMIFS(...) يدويًا: نموذج تسلسلي (dropdown + قوائم
// اختيار حقيقية من بيانات Odoo) يُولّد نص الصيغة النهائي تلقائيًا.
//
// يدعم تركيب أكثر من دالة SUMIFS بعملية حسابية بينها في نفس الخلية
// (مثال: =SUMIFS(...) - SUMIFS(...)): الحالة الداخلية أصبحت مصفوفة
// "كتل" (_fwBlocks)، كل كتلة تحمل نفس بيانات نموذج SUMIFS المفردة
// (مصدر، شروط، مقياس، فترة زمنية)، بينها مصفوفة عوامل ربط (_fwLinkOps).
// الصيغة المركّبة النهائية تُحسب وتُعرَض عبر نفس المحلّل الموحّد
// evaluateCellFormula في formulaEngine.js (يدعم SUMIFS(...) كعنصر أوّلي
// ضمن تعبير حسابي، بنفس مبدأ مراجع الخلايا A1+A2 الموجود أصلًا).
//
// يعتمد على:
//  - formulaEngine.js  (COLUMN_MAP، ودعم OR بقيم مفصولة بفاصلة داخل الشرط،
//    _parseFunctionCall/_parseSumIfsArgs لتفكيك صيغة محفوظة عند إعادة الفتح)
//  - reportBuilder.js  (_RB_HELP_REFERENCE مصدر مركزي واحد لأسماء/شرح
//    المصادر والأعمدة — بلا تكرار للقوائم هنا، _rbCommitCellFormula،
//    _rbCellsData لقراءة الصيغة الحالية للخلية عند إعادة الفتح،
//    _rbTemplateCategories/_rbTemplateSellerCategories/_rbTemplatePricelistCategories)
//  - controllers/rpcController.js (fetchProductList/fetchSellerList/fetchPricelistList)
// ══════════════════════════════════════════════════════════════

// أنواع الكتل المدعومة في المُنشئ — قابل للتوسعة لاحقًا (مثل COUNTIFS)
// بإضافة مدخل هنا فقط. "SUMIFS" كتلة دالة بشروط، "TEXT" نص ثابت يُدرَج
// حرفيًا (يُستعمل غالبًا مع عامل الربط "&" للدمج مع كتلة أخرى)، "CELL"
// مرجع خلية مفردة (مثل C17) يُدرَج كما هو ضمن الصيغة المركّبة.
const _FW_FUNCTIONS = [
  { code: "SUMIFS", label: "SUMIFS — مجموع بشروط" },
  { code: "TEXT", label: "نص ثابت" },
  { code: "CELL", label: "مرجع خلية" },
  { code: "DATE", label: "تاريخ (jour)" },
];

// تسميات واضحة للمصادر (تُستعمل في dropdown المصدر) — القيم (code) هي
// نفسها sources في _RB_HELP_REFERENCE (reportBuilder.js)، فقط بتسمية
// أوضح للعرض هنا.
const _FW_SOURCE_LABELS = {
  vnt: "مبيعات J-1 (vnt)",
  liv: "التوزيع (liv)",
  enc: "التحصيل (enc)",
};

// عوامل الربط الحسابية المسموحة بين كتلة ودالة SUMIFS التالية لها —
// نفس عوامل evaluateCellFormula في formulaEngine.js بالضبط (+ - * /).
const _FW_LINK_OP_LABELS = { "+": "+ (جمع)", "-": "- (طرح)", "*": "× (ضرب)", "/": "÷ (قسمة)", "&": "& (دمج نص)" };

// ── حالة زر "fx" العائم بجانب الخلية المركَّز عليها ──
let _fwFxBtn = null;
let _fwHideTimer = null;

function _fwEnsureFxBtn() {
  if (_fwFxBtn && _fwFxBtn.isConnected) return _fwFxBtn;
  _fwFxBtn = null;
  const wrap = document.getElementById("rbGridWrap");
  if (!wrap) return null;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "fwFxBtn";
  btn.className = "fw-fx-btn";
  btn.textContent = "fx";
  btn.title = "منشئ الصيغ التفاعلي";
  // mousedown بدل click + preventDefault: يمنع أن تفقد الخلية التركيز
  // (blur) قبل أن نلتقط أي cellId نحتاجه، ويمنع اختفاء الزر بسبب
  // مؤقّت الإخفاء المجدوَل من _fwScheduleHideButton أدناه.
  btn.addEventListener("mousedown", e => {
    e.preventDefault();
    e.stopPropagation();
    if (_fwHideTimer) { clearTimeout(_fwHideTimer); _fwHideTimer = null; }
    if (btn.dataset.cellId) _fwOpen(btn.dataset.cellId);
  });
  wrap.appendChild(btn);
  _fwFxBtn = btn;
  return btn;
}

function _fwShowButton(td, cellId) {
  const btn = _fwEnsureFxBtn();
  if (!btn) return;
  if (_fwHideTimer) { clearTimeout(_fwHideTimer); _fwHideTimer = null; }
  btn.dataset.cellId = cellId;
  // موضع الزر: أعلى-يمين الخلية، فوق كل شيء (offsetParent = rbGridWrap
  // المُعرَّف position:relative في style.css).
  btn.style.top = Math.max(0, td.offsetTop - 9) + "px";
  btn.style.left = Math.max(0, td.offsetLeft + td.offsetWidth - 22) + "px";
  btn.style.display = "flex";
}

function _fwScheduleHideButton() {
  if (_fwHideTimer) clearTimeout(_fwHideTimer);
  // تأخير بسيط: يسمح بالنقر (mousedown) على الزر نفسه قبل اختفائه
  // بسبب blur الخلية (الذي يحدث أولًا).
  _fwHideTimer = setTimeout(() => {
    if (_fwFxBtn) _fwFxBtn.style.display = "none";
  }, 200);
}

// ══════════════════════════════════════════════════════════════
// حالة النموذج أثناء بناء الصيغة
// _fwBlocks: مصفوفة كتل، كل كتلة = { func, source, conditions, metric, ds, de }
//   conditions: { [colCode]: { enabled, mode:"list"|"manual"|"cellref", manualValue, cellRef, selected:[{key,label}] } }
// _fwLinkOps: مصفوفة عوامل ربط بين كل كتلة والتالية لها، طولها = _fwBlocks.length - 1
// ══════════════════════════════════════════════════════════════
let _fwCellId = null;
let _fwBlocks = [];
let _fwLinkOps = [];
let _fwListCache = {}; // { colCode: [{key, label, group}] } — كاش مشترك بين كل الكتل (Odoo + فئات مخصصة)، يُجلب مرّة واحدة فقط لكل عمود
let _fwListFilter = {}; // { "blockIdx:colCode": "نص البحث الحالي" } — فلتر بحث فوري لكل (كتلة، عمود)

function _fwColumnsForSource(sourceCode) {
  return (typeof _RB_HELP_REFERENCE !== "undefined" ? _RB_HELP_REFERENCE.columns : [])
    .filter(c => c.sources.includes(sourceCode));
}

function _fwFreshBlock(type) {
  return {
    type: type || "SUMIFS",
    func: "SUMIFS", source: "vnt", conditions: {}, metric: "", ds: "jour", de: "jour", // خاص بـ SUMIFS
    textValue: "", // خاص بـ TEXT
    cellRef: "",   // خاص بـ CELL
    dateValue: "jour", // خاص بـ DATE (jour أو jour-N)
  };
}

function _fwResetState(cellId) {
  _fwCellId = cellId;
  _fwListFilter = {};

  // إن كانت الخلية تحتوي فعلاً صيغة (SUMIFS مفردة أو مركّبة)، نحاول
  // تفكيكها وإعادة ملء كل الكتل بها (بدل الاقتصار على الكتلة الأولى، أو
  // البدء من نموذج فارغ دائمًا كما في الإصدار السابق).
  const existingRaw = (typeof _rbCellsData !== "undefined" && _rbCellsData[cellId]) ? _rbCellsData[cellId].raw : null;
  const parsed = (typeof existingRaw === "string" && existingRaw.trim().startsWith("="))
    ? _fwParseComposedFormula(existingRaw)
    : null;

  if (parsed && parsed.blocks.length) {
    _fwBlocks = parsed.blocks;
    _fwLinkOps = parsed.ops;
  } else {
    _fwBlocks = [_fwFreshBlock()];
    _fwLinkOps = [];
  }
}

// ══════════════════════════════════════════════════════════════
// تفكيك صيغة محفوظة (SUMIFS مفردة أو عدة SUMIFS مركّبة بعملية حسابية
// بينها) إلى { blocks, ops } لإعادة ملء النموذج بها. يُرجع null إن كانت
// الصيغة بشكل غير مدعوم للتفكيك (مثلًا تحتوي مراجع خلايا أو أقواس أو
// نصوصًا خارج استدعاءات SUMIFS) — في هذه الحالة يبدأ المُنشئ من نموذج
// فارغ كسلوك احتياطي آمن (نفس السلوك القديم).
// ══════════════════════════════════════════════════════════════
function _fwParseComposedFormula(raw) {
  const expr = String(raw == null ? "" : raw).trim().replace(/^=/, "").trim();
  if (!expr) return null;

  const blocks = [];
  const ops = [];
  let pos = 0;
  const skipWs = () => { while (pos < expr.length && /\s/.test(expr[pos])) pos++; };

  const cellTokenRe = /^[A-Za-z]+[0-9]+/;
  const jourTokenRe = /^jour(\s*-\s*\d+)?\b/i;

  skipWs();
  while (pos < expr.length) {
    if (/^SUMIFS\s*\(/i.test(expr.slice(pos))) {
      // كتلة SUMIFS(...)
      const openIdx = expr.indexOf("(", pos);
      let depth = 0, i = openIdx;
      for (; i < expr.length; i++) {
        if (expr[i] === "(") depth++;
        else if (expr[i] === ")") { depth--; if (depth === 0) { i++; break; } }
      }
      if (depth !== 0) return null; // قوس غير مغلَق — شكل غير صالح، لا نحاول التخمين

      const callText = expr.slice(pos, i);
      const block = _fwParseSingleSumIfsCall(callText);
      if (!block) return null;
      blocks.push(block);
      pos = i;
    } else if (expr[pos] === '"') {
      // كتلة نص ثابت "..." (بلا دعم لهروب \" داخليًا — شكل بسيط كافٍ هنا)
      const closeIdx = expr.indexOf('"', pos + 1);
      if (closeIdx === -1) return null;
      const text = expr.slice(pos + 1, closeIdx);
      const block = _fwFreshBlock("TEXT");
      block.textValue = text;
      blocks.push(block);
      pos = closeIdx + 1;
    } else if (jourTokenRe.test(expr.slice(pos))) {
      // كتلة تاريخ (jour أو jour-N) مفردة — خارج ds/de داخل SUMIFS
      const m = jourTokenRe.exec(expr.slice(pos));
      const block = _fwFreshBlock("DATE");
      block.dateValue = m[0].trim().toLowerCase();
      blocks.push(block);
      pos += m[0].length;
    } else if (cellTokenRe.test(expr.slice(pos))) {
      // كتلة مرجع خلية مفردة (مثل C17) — وليست جزءًا من استدعاء دالة
      const m = cellTokenRe.exec(expr.slice(pos));
      const block = _fwFreshBlock("CELL");
      block.cellRef = m[0].toUpperCase();
      blocks.push(block);
      pos += m[0].length;
    } else {
      return null; // شكل غير مدعوم هنا
    }

    skipWs();
    if (pos >= expr.length) break;
    const opCh = expr[pos];
    if (!"+-*/&".includes(opCh)) return null; // أي شيء آخر غير عامل مدعوم = شكل غير مدعوم هنا
    ops.push(opCh);
    pos += 1;
    skipWs();
  }

  return blocks.length ? { blocks, ops } : null;
}

// يفكك استدعاء "SUMIFS(...)" واحدًا (نص كامل بأقواسه) إلى كتلة نموذج
// جاهزة للعرض. يُعيد null إن كان الاستدعاء غير صالح أو مصدره غير معروف.
function _fwParseSingleSumIfsCall(callText) {
  try {
    const { name, argsString } = _parseFunctionCall(callText);
    if (name !== "SUMIFS") return null;
    const { source, conditions, datestart, dateend, metric } = _parseSumIfsArgs(argsString);

    // توحيد حالة الأحرف: المصدر قد يكون مكتوبًا بأي حالة أحرف (VNT/vnt/Vnt).
    const sourceCode = String(source || "").trim().toLowerCase();
    if (!_RB_HELP_REFERENCE.sources.find(s => s.code === sourceCode)) return null;

    const block = {
      type: "SUMIFS",
      func: "SUMIFS",
      source: sourceCode,
      conditions: {},
      metric: "",
      ds: datestart || "jour",
      de: dateend || "jour",
      textValue: "",
      cellRef: "",
    };

    for (const cond of conditions) {
      const colCode = String(cond.column || "").trim().toLowerCase();
      const colDef = _RB_HELP_REFERENCE.columns.find(c => c.code === colCode);
      if (!colDef) continue; // عمود غير معروف ضمن هذا الاستدعاء — يُتجاهَل بصمت
      const rawVal = String(cond.value == null ? "" : cond.value).trim();
      if (!rawVal) continue;

      // مرجع خلية (A1) يُعاد كما هو (كتلة واحدة، بلا فاصلة) -> وضع cellref.
      // غير ذلك (قيمة واحدة أو عدة قيم OR مفصولة بفاصلة) -> وضع "كتابة
      // يدوية" افتراضيًا (القيمة الفعلية للصيغة تبقى محفوظة بالضبط؛ يمكن
      // للمستخدم التبديل لوضع "اختيار من قائمة" وإعادة التحديد لو أراد ذلك).
      if (/^[A-Za-z]+[0-9]+$/.test(rawVal)) {
        block.conditions[colCode] = { enabled: true, mode: "cellref", manualValue: "", cellRef: rawVal.toUpperCase(), selected: [] };
      } else {
        block.conditions[colCode] = { enabled: true, mode: "manual", manualValue: rawVal, cellRef: "", selected: [] };
      }
    }

    const metricCode = String(metric || "").trim().toLowerCase();
    if (metricCode && metricCode !== "amount") block.metric = metricCode;

    return block;
  } catch (e) {
    return null; // صيغة غير صالحة الشكل — لا نحاول التخمين
  }
}

// ══════════════════════════════════════════════════════════════
// إضافة/إزالة كتلة دالة
// ══════════════════════════════════════════════════════════════
function _fwAddBlock() {
  _fwBlocks.push(_fwFreshBlock());
  _fwLinkOps.push("+");
  _fwRenderBody();
}

function _fwRemoveBlock(idx) {
  if (_fwBlocks.length <= 1) return; // كتلة واحدة على الأقل يجب أن تبقى
  _fwBlocks.splice(idx, 1);
  const opIdx = idx === 0 ? 0 : idx - 1;
  if (opIdx >= 0 && opIdx < _fwLinkOps.length) _fwLinkOps.splice(opIdx, 1);
  _fwRenderBody();
}

// ══════════════════════════════════════════════════════════════
// فتح/إغلاق نافذة المُنشئ
// ══════════════════════════════════════════════════════════════
function _fwOpen(cellId) {
  _fwResetState(cellId);
  _fwRenderModal();
}

function _fwClose() {
  const overlay = document.getElementById("fwOverlay");
  if (overlay) overlay.remove();
}

function _fwRenderModal() {
  _fwClose();
  const overlay = document.createElement("div");
  overlay.id = "fwOverlay";
  overlay.className = "fw-overlay";
  overlay.addEventListener("mousedown", e => {
    if (e.target === overlay) _fwClose();
  });

  overlay.innerHTML = `
    <div class="fw-dialog">
      <div class="fw-header">
        <span>منشئ الصيغ التفاعلي — خلية ${escHtml(_fwCellId || "")}</span>
        <button type="button" id="fwCloseBtn" class="fw-header-close">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="fw-body" id="fwBody"></div>
      <div class="fw-footer">
        <div class="fw-preview" id="fwPreview">=</div>
      </div>
      <div class="fw-footer" style="border-top:none;padding-top:0">
        <span class="fw-error" id="fwError"></span>
        <div style="display:flex;gap:8px">
          <button type="button" id="fwCancelBtn" class="fw-btn">إلغاء</button>
          <button type="button" id="fwApplyBtn" class="fw-btn fw-btn-primary">تطبيق على الخلية</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  document.getElementById("fwCloseBtn").addEventListener("click", _fwClose);
  document.getElementById("fwCancelBtn").addEventListener("click", _fwClose);
  document.getElementById("fwApplyBtn").addEventListener("click", _fwApply);

  _fwRenderBody();
}

// ══════════════════════════════════════════════════════════════
// رسم جسم النافذة: كل كتل الدوال (SUMIFS)، عوامل الربط بينها،
// وزر "+ إضافة دالة أخرى" في الأسفل.
// ══════════════════════════════════════════════════════════════
function _fwRenderBody() {
  const body = document.getElementById("fwBody");
  if (!body) return;

  // أعمدة اختفت بعد تغيير مصدر كتلة ما: نظّف حالتها لتلك الكتلة فقط (حتى
  // لا تُقحَم بشرط لعمود غير مدعوم لمصدرها الحالي).
  _fwBlocks.forEach(block => {
    const cols = _fwColumnsForSource(block.source);
    Object.keys(block.conditions).forEach(c => {
      if (!cols.find(x => x.code === c)) delete block.conditions[c];
    });
  });

  let html = "";
  _fwBlocks.forEach((block, idx) => {
    html += _fwRenderBlockHtml(idx, block);
    if (idx < _fwBlocks.length - 1) html += _fwRenderLinkOpHtml(idx);
  });

  html += `
    <div class="fw-row fw-add-block-row">
      <button type="button" id="fwAddBlockBtn" class="fw-btn">+ إضافة دالة أخرى</button>
    </div>`;

  body.innerHTML = html;
  _fwWireBody();
  _fwUpdatePreview();
}

function _fwRenderBlockHtml(idx, block) {
  if (!block.type) block.type = "SUMIFS"; // توافق مع كتل قديمة قبل إضافة الأنواع
  let html = `<div class="fw-func-block" data-block-idx="${idx}">`;

  if (_fwBlocks.length > 1) {
    html += `
      <div class="fw-func-block-head">
        <span class="fw-func-block-title">الكتلة ${idx + 1}</span>
        <button type="button" class="fw-remove-block-btn" data-remove-block="${idx}" title="إزالة هذه الكتلة">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>`;
  }

  html += `
    <div class="fw-row">
      <label class="fw-row-label">نوع الكتلة</label>
      <select id="fwFuncSelect-${idx}" class="fw-select" data-block-idx="${idx}">
        ${_FW_FUNCTIONS.map(f => `<option value="${f.code}"${f.code === block.type ? " selected" : ""}>${escHtml(f.label)}</option>`).join("")}
      </select>
    </div>`;

  if (block.type === "TEXT") {
    html += _fwRenderTextBlockHtml(idx, block);
  } else if (block.type === "CELL") {
    html += _fwRenderCellBlockHtml(idx, block);
  } else if (block.type === "DATE") {
    html += _fwRenderDateBlockHtml(idx, block);
  } else {
    html += _fwRenderSumifsBlockHtml(idx, block);
  }

  html += `</div>`;
  return html;
}

// ── كتلة "نص ثابت" — قيمة نصية تُدرَج حرفيًا (بلا حاجة لكتابة علامات
// تنصيص يدويًا، تُضاف تلقائيًا عند بناء الصيغة). تُستعمل غالبًا مع عامل
// الربط "&" لدمجها مع كتلة أخرى (مثل مرجع خلية أو دالة SUMIFS). ──
function _fwRenderTextBlockHtml(idx, block) {
  return `
    <div class="fw-row">
      <label class="fw-row-label">النص</label>
      <input type="text" id="fwTextInput-${idx}" class="fw-input" data-block-idx="${idx}" placeholder="مثال: Total " value="${escHtml(block.textValue || "")}">
      <span class="fw-hint">يُدرَج كما هو بدون علامات تنصيص، استعمل عامل الربط "&" لدمجه مع كتلة أخرى</span>
    </div>`;
}

// ── كتلة "مرجع خلية" — خلية مفردة (مثل C17) تُدرَج كما هي ضمن الصيغة
// المركّبة، يمكن ربطها بعمليات حسابية (C17/C16) أو بـ "&" لدمجها كنص. ──
function _fwRenderCellBlockHtml(idx, block) {
  const v = (block.cellRef || "").trim();
  const valid = !v || /^[A-Za-z]+[0-9]+$/.test(v);
  return `
    <div class="fw-row">
      <label class="fw-row-label">مرجع الخلية</label>
      <input type="text" id="fwCellBlockInput-${idx}" class="fw-input" data-block-idx="${idx}" placeholder="مثال: C17" value="${escHtml(block.cellRef || "")}">
      <span class="fw-error" id="fwCellBlockErr-${idx}">${valid ? "" : 'صيغة غير صالحة (مثال صحيح: C17)'}</span>
    </div>`;
}

// ── كتلة "تاريخ (jour)" — متغيّر التاريخ الحالي المختار في المصمم (أو
// تاريخ قبله بـ N يوم)، يُدرَج كنص تاريخ DD/MM/YYYY. تُستعمل غالبًا مع
// عامل الربط "&" لدمجها مع كتلة نصية (مثال: "oran " & jour). ──
function _fwRenderDateBlockHtml(idx, block) {
  const v = (block.dateValue || "").trim();
  const valid = !v || /^jour(\s*-\s*\d+)?$/i.test(v);
  return `
    <div class="fw-row">
      <label class="fw-row-label">التاريخ</label>
      <input type="text" id="fwDateInput-${idx}" class="fw-input" data-block-idx="${idx}" placeholder="jour" value="${escHtml(block.dateValue || "")}">
      <span class="fw-hint">jour = التاريخ الحالي، jour-7 = قبل 7 أيام منه</span>
      <span class="fw-error" id="fwDateErr-${idx}">${valid ? "" : 'صيغة غير صالحة (مثال صحيح: jour أو jour-7)'}</span>
    </div>`;
}

function _fwRenderSumifsBlockHtml(idx, block) {
  const cols = _fwColumnsForSource(block.source);
  let html = `
    <div class="fw-row">
      <label class="fw-row-label">المصدر</label>
      <select id="fwSourceSelect-${idx}" class="fw-select" data-block-idx="${idx}">
        ${_RB_HELP_REFERENCE.sources.map(s => `<option value="${s.code}"${s.code === block.source ? " selected" : ""}>${escHtml(_FW_SOURCE_LABELS[s.code] || s.code)}</option>`).join("")}
      </select>
    </div>`;

  html += `<div class="fw-row"><label class="fw-row-label">الشروط (اختياري — اترك غير مفعّل = الكل)</label></div>`;
  for (const col of cols) {
    html += _fwRenderConditionBlock(idx, block, col);
  }

  html += `
    <div class="fw-row">
      <label class="fw-row-label">المقياس (metric) — اختياري، amount افتراضيًا</label>
      <select id="fwMetricSelect-${idx}" class="fw-select" data-block-idx="${idx}">
        <option value=""${!block.metric ? " selected" : ""}>amount (افتراضي)</option>
        <option value="qty"${block.metric === "qty" ? " selected" : ""}>qty</option>
        <option value="pack1"${block.metric === "pack1" ? " selected" : ""}>pack1</option>
        <option value="pack2"${block.metric === "pack2" ? " selected" : ""}>pack2</option>
        <option value="pack3"${block.metric === "pack3" ? " selected" : ""}>pack3</option>
      </select>
    </div>`;

  html += `
    <div class="fw-row">
      <label class="fw-row-label">الفترة الزمنية (ds / de)</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="fwDsInput-${idx}" class="fw-input" data-block-idx="${idx}" placeholder="ds (مثال: jour أو jour-7)" value="${escHtml(block.ds)}">
        <input type="text" id="fwDeInput-${idx}" class="fw-input" data-block-idx="${idx}" placeholder="de (مثال: jour)" value="${escHtml(block.de)}">
      </div>
      <span class="fw-hint">مسموح: jour، jour-N، أو تاريخ صريح YYYY-MM-DD</span>
    </div>`;

  return html;
}

// dropdown عامل الربط بين الكتلة idx والكتلة idx+1
function _fwRenderLinkOpHtml(idx) {
  const op = _fwLinkOps[idx] || "+";
  return `
    <div class="fw-row fw-link-op-row">
      <label class="fw-row-label">عملية الربط مع الدالة التالية</label>
      <select class="fw-select fw-link-op-select" data-link-idx="${idx}">
        ${Object.keys(_FW_LINK_OP_LABELS).map(k => `<option value="${k}"${k === op ? " selected" : ""}>${escHtml(_FW_LINK_OP_LABELS[k])}</option>`).join("")}
      </select>
    </div>`;
}

function _fwRenderConditionBlock(blockIdx, block, col) {
  const state = block.conditions[col.code] || { enabled: false, mode: "list", manualValue: "", cellRef: "", selected: [] };
  block.conditions[col.code] = state;

  let bodyHtml = "";
  if (state.enabled) {
    bodyHtml += `
      <div class="fw-cond-body">
        <div class="fw-mode-tabs">
          <div class="fw-mode-tab${state.mode === "list" ? " fw-mode-active" : ""}" data-block-idx="${blockIdx}" data-col="${col.code}" data-mode="list">اختيار من قائمة</div>
          <div class="fw-mode-tab${state.mode === "manual" ? " fw-mode-active" : ""}" data-block-idx="${blockIdx}" data-col="${col.code}" data-mode="manual">كتابة يدوية</div>
          <div class="fw-mode-tab${state.mode === "cellref" ? " fw-mode-active" : ""}" data-block-idx="${blockIdx}" data-col="${col.code}" data-mode="cellref">مرجع خلية</div>
        </div>`;

    if (state.mode === "list") {
      bodyHtml += `<input type="text" class="fw-list-search" id="fwListSearch-${blockIdx}-${col.code}" data-block-idx="${blockIdx}" data-col="${col.code}" placeholder="بحث..." autocomplete="off">`;
      bodyHtml += `<div class="fw-list-box" id="fwList-${blockIdx}-${col.code}"><div class="fw-hint">جارٍ التحميل...</div></div>`;
    } else if (state.mode === "manual") {
      bodyHtml += `<input type="text" class="fw-input" id="fwManual-${blockIdx}-${col.code}" data-block-idx="${blockIdx}" data-col="${col.code}" placeholder="قيمة أو عدة قيم مفصولة بفاصلة (OR): مثال أحمد,محمد" value="${escHtml(state.manualValue)}">`;
    } else if (state.mode === "cellref") {
      bodyHtml += `<input type="text" class="fw-input" id="fwCellRef-${blockIdx}-${col.code}" data-block-idx="${blockIdx}" data-col="${col.code}" placeholder="مثال: A1" value="${escHtml(state.cellRef)}">
        <span class="fw-error" id="fwCellRefErr-${blockIdx}-${col.code}"></span>`;
    }
    bodyHtml += `</div>`;
  }

  return `
    <div class="fw-cond-block" data-block-idx="${blockIdx}" data-col-block="${col.code}">
      <div class="fw-cond-head">
        <input type="checkbox" id="fwEnable-${blockIdx}-${col.code}" data-block-idx="${blockIdx}" data-col="${col.code}" ${state.enabled ? "checked" : ""}>
        <label for="fwEnable-${blockIdx}-${col.code}">${escHtml(col.code)} — ${escHtml(col.desc)}</label>
      </div>
      ${bodyHtml}
    </div>`;
}

function _fwWireBody() {
  document.getElementById("fwAddBlockBtn")?.addEventListener("click", _fwAddBlock);

  document.querySelectorAll("[data-remove-block]").forEach(btn => {
    btn.addEventListener("click", () => {
      _fwRemoveBlock(parseInt(btn.dataset.removeBlock, 10));
    });
  });

  document.querySelectorAll(".fw-link-op-select").forEach(sel => {
    sel.addEventListener("change", e => {
      const idx = parseInt(sel.dataset.linkIdx, 10);
      _fwLinkOps[idx] = e.target.value;
      _fwUpdatePreview();
    });
  });

  document.querySelectorAll("[id^='fwFuncSelect-']").forEach(sel => {
    sel.addEventListener("change", e => {
      const idx = parseInt(sel.dataset.blockIdx, 10);
      // تغيير نوع الكتلة (SUMIFS/TEXT/CELL) يبدّل شكل النموذج المعروض
      // بالكامل لهذه الكتلة، لذا نعيد رسم الجسم كله (وليس فقط المعاينة).
      _fwBlocks[idx].type = e.target.value;
      if (e.target.value === "SUMIFS") _fwBlocks[idx].func = "SUMIFS";
      _fwRenderBody();
    });
  });

  document.querySelectorAll("[id^='fwTextInput-']").forEach(inp => {
    inp.addEventListener("input", e => {
      const idx = parseInt(inp.dataset.blockIdx, 10);
      _fwBlocks[idx].textValue = e.target.value;
      _fwUpdatePreview();
    });
  });

  document.querySelectorAll("[id^='fwCellBlockInput-']").forEach(inp => {
    inp.addEventListener("input", e => {
      const idx = parseInt(inp.dataset.blockIdx, 10);
      _fwBlocks[idx].cellRef = e.target.value;
      const errEl = document.getElementById(`fwCellBlockErr-${idx}`);
      const v = e.target.value.trim();
      const valid = !v || /^[A-Za-z]+[0-9]+$/.test(v);
      if (errEl) errEl.textContent = valid ? "" : "صيغة غير صالحة (مثال صحيح: C17)";
      _fwUpdatePreview();
    });
  });

  document.querySelectorAll("[id^='fwDateInput-']").forEach(inp => {
    inp.addEventListener("input", e => {
      const idx = parseInt(inp.dataset.blockIdx, 10);
      _fwBlocks[idx].dateValue = e.target.value;
      const errEl = document.getElementById(`fwDateErr-${idx}`);
      const v = e.target.value.trim();
      const valid = !v || /^jour(\s*-\s*\d+)?$/i.test(v);
      if (errEl) errEl.textContent = valid ? "" : "صيغة غير صالحة (مثال صحيح: jour أو jour-7)";
      _fwUpdatePreview();
    });
  });

  document.querySelectorAll("[id^='fwSourceSelect-']").forEach(sel => {
    sel.addEventListener("change", e => {
      const idx = parseInt(sel.dataset.blockIdx, 10);
      _fwBlocks[idx].source = e.target.value;
      _fwRenderBody();
    });
  });

  document.querySelectorAll("[id^='fwMetricSelect-']").forEach(sel => {
    sel.addEventListener("change", e => {
      const idx = parseInt(sel.dataset.blockIdx, 10);
      _fwBlocks[idx].metric = e.target.value;
      _fwUpdatePreview();
    });
  });

  document.querySelectorAll("[id^='fwDsInput-']").forEach(inp => {
    inp.addEventListener("input", e => {
      const idx = parseInt(inp.dataset.blockIdx, 10);
      _fwBlocks[idx].ds = e.target.value;
      _fwUpdatePreview();
    });
  });
  document.querySelectorAll("[id^='fwDeInput-']").forEach(inp => {
    inp.addEventListener("input", e => {
      const idx = parseInt(inp.dataset.blockIdx, 10);
      _fwBlocks[idx].de = e.target.value;
      _fwUpdatePreview();
    });
  });

  document.querySelectorAll("[id^='fwEnable-']").forEach(cb => {
    cb.addEventListener("change", e => {
      const idx = parseInt(cb.dataset.blockIdx, 10);
      const col = cb.dataset.col;
      if (!_fwBlocks[idx].conditions[col]) _fwBlocks[idx].conditions[col] = { enabled: false, mode: "list", manualValue: "", cellRef: "", selected: [] };
      _fwBlocks[idx].conditions[col].enabled = e.target.checked;
      _fwRenderBody();
    });
  });

  document.querySelectorAll(".fw-mode-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const idx = parseInt(tab.dataset.blockIdx, 10);
      const col = tab.dataset.col;
      const mode = tab.dataset.mode;
      if (!_fwBlocks[idx].conditions[col]) _fwBlocks[idx].conditions[col] = { enabled: false, mode: "list", manualValue: "", cellRef: "", selected: [] };
      _fwBlocks[idx].conditions[col].mode = mode;
      _fwRenderBody();
    });
  });

  document.querySelectorAll("[id^='fwManual-']").forEach(inp => {
    inp.addEventListener("input", e => {
      const idx = parseInt(inp.dataset.blockIdx, 10);
      const col = inp.dataset.col;
      if (!_fwBlocks[idx].conditions[col]) _fwBlocks[idx].conditions[col] = { enabled: false, mode: "list", manualValue: "", cellRef: "", selected: [] };
      _fwBlocks[idx].conditions[col].manualValue = e.target.value;
      _fwUpdatePreview();
    });
  });

  document.querySelectorAll("[id^='fwCellRef-']").forEach(inp => {
    inp.addEventListener("input", e => {
      const idx = parseInt(inp.dataset.blockIdx, 10);
      const col = inp.dataset.col;
      if (!_fwBlocks[idx].conditions[col]) _fwBlocks[idx].conditions[col] = { enabled: false, mode: "list", manualValue: "", cellRef: "", selected: [] };
      _fwBlocks[idx].conditions[col].cellRef = e.target.value;
      const errEl = document.getElementById(`fwCellRefErr-${idx}-${col}`);
      const valid = /^[A-Za-z]+[0-9]+$/.test(e.target.value.trim());
      if (errEl) errEl.textContent = (e.target.value.trim() && !valid) ? "صيغة غير صالحة (مثال صحيح: A1)" : "";
      _fwUpdatePreview();
    });
  });

  document.querySelectorAll("[id^='fwListSearch-']").forEach(inp => {
    inp.addEventListener("input", e => {
      const idx = parseInt(inp.dataset.blockIdx, 10);
      const col = inp.dataset.col;
      _fwListFilter[`${idx}:${col}`] = e.target.value || "";
      _fwRenderListBox(idx, col);
    });
  });

  // قوائم "اختيار من قائمة" — تُجلب lazy عند ظهورها فعليًا فقط، لكل كتلة
  _fwBlocks.forEach((block, idx) => {
    Object.keys(block.conditions).forEach(col => {
      const st = block.conditions[col];
      if (st.enabled && st.mode === "list") _fwLoadListForColumn(idx, col);
    });
  });
}

// ══════════════════════════════════════════════════════════════
// جلب قوائم الاختيار الفعلية (Odoo + الفئات المخصصة) لكل عمود — lazy،
// مرّة واحدة فقط لكل عمود طوال جلسة فتح النافذة (كاش _fwListCache
// مشترك بين كل الكتل، حتى لا نُعيد جلب نفس القائمة إن استُعمل نفس
// العمود في أكثر من كتلة).
// ══════════════════════════════════════════════════════════════
async function _fwLoadListForColumn(blockIdx, col) {
  if (_fwListCache[col]) { _fwRenderListBox(blockIdx, col); return; }

  const baseUrl = (typeof getOdooBase === "function") ? getOdooBase() : "";
  try {
    let odooItems = [];
    let customCats = [];

    if (col === "vnd") {
      const [users, cats] = await Promise.all([
        baseUrl ? rpcController.fetchSellerList(baseUrl) : Promise.resolve([]),
        Promise.resolve((typeof _rbTemplateSellerCategories === "function") ? _rbTemplateSellerCategories() : []),
      ]);
      odooItems = (users || []).map(u => ({ key: String(u.id), label: (u.name || `#${u.id}`) + (u.active === false ? " [معطّل]" : ""), inactive: u.active === false }));
      customCats = cats || [];
    } else if (col === "crt") {
      // "منشئ السجل" (create_uid) يشير أيضًا إلى res.users مثل vnd (user_id)،
      // لذا نعيد استخدام نفس قائمة المستخدمين عبر fetchSellerList دون دالة RPC منفصلة.
      // لا نضيف فئات بائعين مخصصة هنا عمدًا: فئات البائعين مفهوم تجاري (تصنيف
      // بائعين حسب مناطق/فرق بيع)، ولا علاقة له بهوية من أنشأ السجل تقنيًا.
      const users = baseUrl ? await rpcController.fetchSellerList(baseUrl) : [];
      odooItems = (users || []).map(u => ({ key: String(u.id), label: (u.name || `#${u.id}`) + (u.active === false ? " [معطّل]" : ""), inactive: u.active === false }));
    } else if (col === "art") {
      const products = baseUrl ? await rpcController.fetchProductList(baseUrl) : [];
      odooItems = (products || []).map(p => ({ key: String(p.id), label: productLabel(p.name) || `#${p.id}` }));
    } else if (col === "cat") {
      const [products, cats] = await Promise.all([
        baseUrl ? rpcController.fetchProductList(baseUrl) : Promise.resolve([]),
        Promise.resolve((typeof _rbTemplateCategories === "function") ? _rbTemplateCategories() : []),
      ]);
      const seen = new Map();
      (products || []).forEach(p => {
        if (Array.isArray(p.categ_id)) seen.set(String(p.categ_id[0]), p.categ_id[1]);
      });
      odooItems = [...seen.entries()].map(([id, name]) => ({ key: id, label: name }));
      customCats = cats || [];
    } else if (col === "lp") {
      const [lists, cats] = await Promise.all([
        baseUrl ? rpcController.fetchPricelistList(baseUrl) : Promise.resolve([]),
        Promise.resolve((typeof _rbTemplatePricelistCategories === "function") ? _rbTemplatePricelistCategories() : []),
      ]);
      odooItems = (lists || []).map(l => ({ key: String(l.id), label: l.name || `#${l.id}` }));
      customCats = cats || [];
    }

    const items = [
      ...odooItems.map(it => ({ ...it, group: "odoo" })),
      ...customCats.filter(c => c && c.name).map(c => ({ key: `cc:${c.name}`, label: c.name, group: "custom" })),
    ];
    _fwListCache[col] = items;
  } catch (e) {
    console.warn(`[formulaWizard] فشل جلب قائمة العمود ${col}:`, e);
    _fwListCache[col] = [];
  }
  _fwRenderListBox(blockIdx, col);
}

function _fwRenderListBox(blockIdx, col) {
  const box = document.getElementById(`fwList-${blockIdx}-${col}`);
  if (!box) return;
  const allItems = _fwListCache[col] || [];
  const block = _fwBlocks[blockIdx];
  if (!block) return;
  const state = block.conditions[col];
  if (!state) return;
  const selectedKeys = new Set((state.selected || []).map(s => s.key));

  if (!allItems.length) {
    box.innerHTML = `<div class="fw-hint">لا توجد عناصر متاحة.</div>`;
    return;
  }

  const q = (_fwListFilter[`${blockIdx}:${col}`] || "").trim().toLowerCase();
  const items = q ? allItems.filter(it => (it.label || "").toLowerCase().includes(q)) : allItems;

  if (!items.length) {
    box.innerHTML = `<div class="fw-hint">لا نتائج مطابقة.</div>`;
    return;
  }

  const customItems = items.filter(i => i.group === "custom");
  const odooItems = items.filter(i => i.group === "odoo");
  let html = "";
  if (customItems.length) {
    html += `<div class="fw-list-group-label">فئات مخصصة</div>`;
    html += customItems.map(it => _fwListItemRow(it, selectedKeys.has(it.key))).join("");
  }
  if (odooItems.length) {
    html += `<div class="fw-list-group-label">من Odoo</div>`;
    html += odooItems.map(it => _fwListItemRow(it, selectedKeys.has(it.key))).join("");
  }
  box.innerHTML = html;

  box.querySelectorAll("input[type='checkbox']").forEach(cb => {
    cb.addEventListener("change", e => {
      const key = cb.dataset.key;
      const label = cb.dataset.label;
      if (!_fwBlocks[blockIdx].conditions[col]) _fwBlocks[blockIdx].conditions[col] = { enabled: false, mode: "list", manualValue: "", cellRef: "", selected: [] };
      const st = _fwBlocks[blockIdx].conditions[col];
      st.selected = st.selected || [];
      if (e.target.checked) {
        if (!st.selected.find(s => s.key === key)) st.selected.push({ key, label });
      } else {
        st.selected = st.selected.filter(s => s.key !== key);
      }
      _fwUpdatePreview();
    });
  });
}

function _fwListItemRow(item, checked) {
  return `
    <label class="fw-list-item">
      <input type="checkbox" data-key="${escHtml(item.key)}" data-label="${escHtml(item.label)}" ${checked ? "checked" : ""}>
      <span${item.inactive ? ' style="color:var(--text3)"' : ""}>${escHtml(item.label)}</span>
    </label>`;
}

// ══════════════════════════════════════════════════════════════
// بناء نص الصيغة النهائي (المركّبة) من الحالة الحالية
// ══════════════════════════════════════════════════════════════

// يحوّل قيمة عنصر مُختار من القائمة إلى نص شرط: عنصر من Odoo -> id
// رقمي (مطابقة دقيقة عبر resolveId)، فئة مخصصة -> اسمها (يُطابَق عبر
// _findCustomCategory بالاسم في formulaEngine.js).
function _fwSelectedItemToValueToken(item) {
  if (String(item.key).startsWith("cc:")) return item.label;
  return item.key;
}

function _fwBuildConditionValue(block, colCode) {
  const st = block.conditions[colCode];
  if (!st || !st.enabled) return null;
  if (st.mode === "manual") {
    const v = (st.manualValue || "").trim();
    return v || null;
  }
  if (st.mode === "cellref") {
    const v = (st.cellRef || "").trim();
    return /^[A-Za-z]+[0-9]+$/.test(v) ? v.toUpperCase() : null;
  }
  // mode === "list"
  const sel = st.selected || [];
  if (!sel.length) return null;
  return sel.map(_fwSelectedItemToValueToken).join(",");
}

// يبني نص استدعاء دالة واحدة (مثل "SUMIFS(vnt; vnd; أحمد; ds; jour; de; jour)") لكتلة واحدة
function _fwBuildSumifsBlockFormula(block) {
  const parts = [block.source];
  const cols = _fwColumnsForSource(block.source);
  for (const col of cols) {
    const val = _fwBuildConditionValue(block, col.code);
    if (val !== null) parts.push(col.code, val);
  }
  const ds = (block.ds || "").trim() || "jour";
  const de = (block.de || "").trim() || "jour";
  parts.push("ds", ds, "de", de);
  if (block.metric) parts.push(block.metric);
  return `${block.func || "SUMIFS"}(${parts.join("; ")})`;
}

// يبني نص كتلة واحدة بحسب نوعها: SUMIFS(...) / "نص ثابت" / مرجع خلية
function _fwBuildBlockFormula(block) {
  if (block.type === "TEXT") {
    // إفلات علامات التنصيص الداخلية (نادرة) بدلها بعلامة مفردة حتى لا تكسر الصيغة
    const safe = String(block.textValue || "").replace(/"/g, "'");
    return `"${safe}"`;
  }
  if (block.type === "CELL") {
    return (block.cellRef || "").trim().toUpperCase();
  }
  if (block.type === "DATE") {
    return (block.dateValue || "jour").trim().toLowerCase();
  }
  return _fwBuildSumifsBlockFormula(block);
}

// يبني نص الصيغة المركّبة الكاملة: كتلة1 [عامل1 كتلة2 [عامل2 كتلة3 ...]]
function _fwBuildFormula() {
  const parts = _fwBlocks.map(_fwBuildBlockFormula);
  let expr = parts[0] || "";
  for (let i = 1; i < parts.length; i++) {
    const op = _fwLinkOps[i - 1] || "+";
    expr += ` ${op} ${parts[i]}`;
  }
  return `=${expr}`;
}

function _fwUpdatePreview() {
  const el = document.getElementById("fwPreview");
  if (el) el.textContent = _fwBuildFormula();
}

function _fwValidate() {
  if (!_fwBlocks.length) return "لا توجد أي دالة في الصيغة";
  const multi = _fwBlocks.length > 1;
  for (let idx = 0; idx < _fwBlocks.length; idx++) {
    const block = _fwBlocks[idx];
    const suffix = multi ? ` (الكتلة ${idx + 1})` : "";

    if (block.type === "TEXT") {
      if (!String(block.textValue || "").length) return `النص فارغ${suffix}`;
      continue;
    }
    if (block.type === "CELL") {
      const v = (block.cellRef || "").trim();
      if (!v || !/^[A-Za-z]+[0-9]+$/.test(v)) return `مرجع الخلية غير صالح${suffix} (مثال صحيح: C17)`;
      continue;
    }
    if (block.type === "DATE") {
      const v = (block.dateValue || "").trim();
      if (!v || !/^jour(\s*-\s*\d+)?$/i.test(v)) return `صيغة التاريخ غير صالحة${suffix} (مثال صحيح: jour أو jour-7)`;
      continue;
    }

    // SUMIFS
    for (const col of Object.keys(block.conditions)) {
      const st = block.conditions[col];
      if (st.enabled && st.mode === "cellref") {
        const v = (st.cellRef || "").trim();
        if (!v || !/^[A-Za-z]+[0-9]+$/.test(v)) {
          return `مرجع الخلية غير صالح للعمود "${col}"${suffix} (مثال صحيح: A1)`;
        }
      }
      if (st.enabled && st.mode === "manual" && !(st.manualValue || "").trim()) {
        return `القيمة اليدوية فارغة للعمود "${col}"${suffix}`;
      }
      if (st.enabled && st.mode === "list" && !(st.selected || []).length) {
        return `لم يُحدَّد أي عنصر من القائمة للعمود "${col}"${suffix}`;
      }
    }
    if (!(block.ds || "").trim() || !(block.de || "").trim()) {
      return `يجب تحديد بداية ونهاية الفترة الزمنية (ds/de)${suffix}`;
    }
  }

  // توافق عامل الربط مع نوعَي الكتلتين المتجاورتين: عمليات حسابية (+ - * /)
  // لا تصلح إن كانت إحدى الكتلتين "نص ثابت" — يجب استعمال "&" للدمج حينها.
  for (let i = 0; i < _fwLinkOps.length; i++) {
    const op = _fwLinkOps[i];
    const left = _fwBlocks[i], right = _fwBlocks[i + 1];
    const hasText = left.type === "TEXT" || right.type === "TEXT" || left.type === "DATE" || right.type === "DATE";
    if (hasText && op !== "&") {
      return `استعمل عامل الربط "&" للدمج مع كتلة نصية (بين الكتلة ${i + 1} و${i + 2})`;
    }
  }

  return null;
}

function _fwApply() {
  const errEl = document.getElementById("fwError");
  const err = _fwValidate();
  if (err) {
    if (errEl) errEl.textContent = err;
    return;
  }
  const formula = _fwBuildFormula();
  if (_fwCellId) {
    _rbCommitCellFormula(_fwCellId, formula);
  }
  _fwClose();
}
