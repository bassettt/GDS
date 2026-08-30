// ============================================================
// src/controllers/rpcController.js — PWA version
// Remplace chrome.runtime.sendMessage par dispatchEvent
// ============================================================

let _rpc_aborted = false;

// ── Event helper (remplace safeMsg) ──────────────────────────
function _emit(type, detail = {}) {
  window.dispatchEvent(new CustomEvent("wafa:" + type, { detail }));
}

// ── الدالة الأساسية: إرسال طلب لـ Odoo ──────────────────────
// permission (اختياري): مفتاح صلاحية RBAC → يُرسَل كهيدر X-App-Permission
// ليتحقق منه السيرفر (middleware/enforcePermission.js). بدون هذا الوسيط
// الطلب يمر دون أي تصنيف صلاحية (نفس السلوك القديم تمامًا).
async function _rpc_call(baseUrl, payload, permission) {
const base = (baseUrl || "").replace(/\/$/, "");
const headers = { "Content-Type": "application/json" };
if (permission) headers["X-App-Permission"] = permission;
const resp = await fetch("/api/web/dataset/call_kw", {
    method:      "POST",
    credentials: "include",
    headers,
    body:        JSON.stringify({ jsonrpc:"2.0", method:"call", id:Date.now(), params:payload }),
  });
  if (!resp.ok) {
    if (resp.status === 403) {
      const permLabel = permission || "inconnue";
      throw new Error(`Permission refusée [${permLabel}] — demandez à l'administrateur d'activer cette permission pour votre compte.`);
    }
    throw new Error("HTTP " + resp.status);
  }
  const json = await resp.json().catch(() => ({}));
  if (json?.error) throw new Error(json.error?.data?.message || "Odoo error");
  return json.result;
}

// ── جلب بيانات المبيعات من sale.order ────────────────────────
async function _rpc_fetchSales(baseUrl, today, tomorrow) {
  let rows;
  try {
    rows = await _rpc_call(baseUrl, {
      model:  "sale.order",
      method: "search_read",
      args:   [[
        ["date_order", ">=", today    + " 00:00:00"],
        ["date_order", "<",  tomorrow + " 00:00:00"],
        ["state",      "!=", "cancel"],
      ]],
      kwargs: { fields: ["user_id", "date_order", "amount_total"], limit: 2000 },
    });
  } catch (e) { return {}; }

  if (!Array.isArray(rows)) return {};

  const salesMap = {};
  for (const row of rows) {
    if (!Array.isArray(row.user_id) || !row.user_id[0]) continue;
    const uid = row.user_id[0];
    if (!salesMap[uid]) salesMap[uid] = { ca: 0, firstVisit: null, lastVisit: null };
    salesMap[uid].ca += (row.amount_total || 0);
    const rawDate = row.date_order ? new Date(row.date_order.replace(" ", "T") + "Z") : null;
    const d = rawDate || null;
    if (d) {
      if (!salesMap[uid].firstVisit || d < salesMap[uid].firstVisit) salesMap[uid].firstVisit = d;
      if (!salesMap[uid].lastVisit  || d > salesMap[uid].lastVisit)  salesMap[uid].lastVisit  = d;
    }
  }
  const tzOptions = { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" };
  for (const uid of Object.keys(salesMap)) {
    const s = salesMap[uid];
    s.firstVisit = s.firstVisit ? s.firstVisit.toLocaleTimeString("fr-FR", tzOptions) : null;
    s.lastVisit  = s.lastVisit  ? s.lastVisit.toLocaleTimeString("fr-FR",  tzOptions) : null;
  }
  return salesMap;
}

// ── جلب CA + first/last time للـ livraison ──────────────────
async function _rpc_fetchDeliveriesByPlanning(baseUrl, mapping) {
  const delivMap = {};
  const planningIds = Object.values(mapping)
    .flatMap(d => Array.isArray(d) ? d.map(r => r.roundId) : [d?.roundId])
    .filter(Boolean);
  if (!planningIds.length) return delivMap;

  let plannings;
  try {
    plannings = await _rpc_call(baseUrl, {
      model:  "planning.planning",
      method: "read",
      args:   [planningIds, ["id", "delivery_picking_ids"]],
      kwargs: {},
    });
  } catch(e) { return delivMap; }

  const planToVendor = {};
  for (const [vid, data] of Object.entries(mapping)) {
    const rounds = Array.isArray(data) ? data : [data];
    for (const r of rounds) { if (r?.roundId) planToVendor[r.roundId] = vid; }
  }

  const pickingToVendor = {};
  for (const plan of (plannings || [])) {
    const vid = planToVendor[plan.id];
    if (!vid) continue;
    for (const pid of (plan.delivery_picking_ids || [])) pickingToVendor[pid] = vid;
  }

  const allPickingIds = Object.keys(pickingToVendor).map(Number);
  if (!allPickingIds.length) return delivMap;

  let picks;
  try {
    picks = await _rpc_call(baseUrl, {
      model:  "stock.picking",
      method: "read",
      args:   [allPickingIds, ["id", "amount_total", "scheduled_date", "date_done", "state"]],
      kwargs: {},
    });
  } catch(e) { return delivMap; }

  const tzOptions = { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" };
  for (const pick of (picks || [])) {
    const vid = pickingToVendor[pick.id];
    if (!vid) continue;
    if (!delivMap[vid]) delivMap[vid] = { caDelivery: 0, firstTransfer: null, lastTransfer: null };
    delivMap[vid].caDelivery += (pick.amount_total || 0);
    const rawDate = pick.date_done ? new Date(pick.date_done.replace(" ", "T") + "Z") : null;
    const d = rawDate || null;
    if (d) {
      if (!delivMap[vid].firstTransfer || d < delivMap[vid].firstTransfer) delivMap[vid].firstTransfer = d;
      if (!delivMap[vid].lastTransfer  || d > delivMap[vid].lastTransfer)  delivMap[vid].lastTransfer  = d;
    }
  }
  for (const vid of Object.keys(delivMap)) {
    const d = delivMap[vid];
    d.firstTransfer = d.firstTransfer ? d.firstTransfer.toLocaleTimeString("fr-FR", tzOptions) : null;
    d.lastTransfer  = d.lastTransfer  ? d.lastTransfer.toLocaleTimeString("fr-FR",  tzOptions) : null;
  }
  return delivMap;
}

// ── جلب جولات اليوم ──────────────────────────────────────────
async function _rpc_fetchToday(baseUrl, workers, mode, targetDateKey) {
  const today    = targetDateKey || getTodayKey();
  const tomorrow = (() => {
    const d = new Date(today); d.setDate(d.getDate() + 1);
    return d.getFullYear() + "-" +
           String(d.getMonth() + 1).padStart(2, "0") + "-" +
           String(d.getDate()).padStart(2, "0");
  })();

  const rows = await _rpc_call(baseUrl, {
    model:  "planning.planning",
    method: "search_read",
    args:   [[
      ["date_start", ">=", today    + " 00:00:00"],
      ["date_start", "<",  tomorrow + " 00:00:00"],
    ]],
    kwargs: {
      fields: ["id", "name", "user_id", "date_start", "state", "user_status",
               "visits_rate", "visits_success_rate", "event_ids",
               "user_has_radius_role", "allow_open_affectation"],
      limit: 500,
    },
  });

  if (!Array.isArray(rows)) return { mapping: {}, today, tomorrow };

  const byUserId = {};
  for (const row of rows) {
    const uid = Array.isArray(row.user_id) ? row.user_id[0] : null;
    if (!uid) continue;
    if (!byUserId[uid]) byUserId[uid] = [];
    byUserId[uid].push(row);
  }

  const mapping = {};
  for (const w of workers) {
    if (!w.workerId) {
      _emit("FETCH_ERROR", { msg: `⚠️ "${w.name}" — Odoo ID manquant.` });
      continue;
    }
    const rowsForUser = byUserId[w.workerId];
    if (!rowsForUser || !rowsForUser.length) continue;
    // ترتيب الجولات حسب date_start تصاعدياً
    const sorted = [...rowsForUser].sort((a, b) => (a.date_start || "").localeCompare(b.date_start || ""));
    mapping[w.id] = sorted.map(row => {
      const odooUserId = Array.isArray(row.user_id) ? row.user_id[0] : null;
      return {
        roundId:      row.id,
        ref:          row.name || null,
        visits_rate:  row.visits_rate           ?? null,
        success_rate: row.visits_success_rate   ?? null,
        totalClients: Array.isArray(row.event_ids) ? row.event_ids.length : null,
        eventIds:     Array.isArray(row.event_ids) ? row.event_ids : [],
        state:        row.state       || "open",
        user_status:  row.user_status || null,
        horsZone:     !!row.user_has_radius_role,
        odooUserId,
      };
    });
  }
  return { mapping, today, tomorrow };
}

// ── تقرير التوزيع اليومي: كل ما تم توزيعه اليوم (livré & facturé) ─
// مجمّع حسب البائع (vnd/user_id). تاريخ التوزيع = date_done (وليس تاريخ البيع)
// ملاحظة: read_group على stock.picking.report وفق منطق الفلتر المرجعي
// (state=done, invoice_state=invoiced). عند توفر اسم الموديل المخصص الجاهز
// في Odoo يمكن استبدال هذا الاستدعاء بسهولة لاحقًا.
async function _rpc_fetchDailyDistributionReport(baseUrl, targetDateKey, extraGroupBy) {
  const today    = targetDateKey || getTodayKey();
  const tomorrow = (() => {
    const d = new Date(today); d.setDate(d.getDate() + 1);
    return d.getFullYear() + "-" +
           String(d.getMonth() + 1).padStart(2, "0") + "-" +
           String(d.getDate()).padStart(2, "0");
  })();

  const groupby = extraGroupBy ? ["user_id", extraGroupBy] : ["user_id"];

  let groups;
  try {
    groups = await _rpc_call(baseUrl, {
      model:  "stock.picking.report",
      method: "read_group",
      args:   [
        [
          ["state",         "=",  "done"],
          ["invoice_state", "=",  "invoiced"],
          ["date_done",     ">=", today    + " 00:00:00"],
          ["date_done",     "<",  tomorrow + " 00:00:00"],
        ],
        ["product_uom_qty:sum", "qty_invoiced:sum", "price_subtotal:sum", "price_total:sum", "discount_amount:sum"],
        groupby,
      ],
      kwargs: { lazy: false },
    });
  } catch (e) {
    _emit("FETCH_ERROR", { msg: "⚠️ تعذّر جلب تقرير التوزيع اليومي: " + e.message });
    return { date: today, rows: [] };
  }

  if (!Array.isArray(groups)) return { date: today, rows: [] };

  const rows = groups
    .filter(g => Array.isArray(g.user_id) && g.user_id[0])
    .map(g => ({
      vendeurId:   g.user_id[0],
      vendeurName: g.user_id[1] || "—",
      extraId:     extraGroupBy && Array.isArray(g[extraGroupBy]) ? g[extraGroupBy][0] : null,
      extraName:   extraGroupBy ? (Array.isArray(g[extraGroupBy]) ? g[extraGroupBy][1] : "—") || "—" : null,
      qtyLivree:   g["product_uom_qty"] || 0,
      qtyFacturee: g["qty_invoiced"]    || 0,
      montantHT:   g["price_subtotal"]  || 0,
      montantTTC:  g["price_total"]     || 0,
      remise:      g["discount_amount"] || 0,
      nbLignes:    g["__count"] || 0,
    }))
    .sort((a, b) => a.vendeurName.localeCompare(b.vendeurName, "fr"));

  return { date: today, rows };
}

// ── تقرير مبيعات J-1: مبيعات اليوم السابق لتاريخ التوزيع المحدد ─
// نفس بنية _rpc_fetchDailyDistributionReport تمامًا، لكن على sale.report
// وبتاريخ بيع = targetDateKey - يوم واحد (J-1)، مجمّع حسب البائع.
//
// ⚠️ افتراضات حول حقول sale.report (لم يتم التحقق منها مباشرة على قاعدة
// Odoo الفعلية — إذا اختلفت التسميات، عدّل القيم أدناه فقط):
//   - date : تاريخ الطلب في sale.report (بخلاف sale.order الذي يستعمل
//     date_order — تم تصحيح هذا بعد خطأ Invalid field 'date_order')
//   - state      : "cancel" هي حالة الإلغاء القياسية في sale.report
//     (بعض إصدارات Odoo لا تملك حالة "done" في sale.report، فاكتفينا
//      باستثناء "cancel" فقط كما طُلب صراحةً)
//   - qty_invoiced : موجود في sale.report بدءًا من Odoo 15+، إن لم يكن
//     متوفرًا في نسختك سيُرجعه Odoo كـ 0 أو يرمي خطأ يجب عندها حذفه من fields
//   - "discount" في sale.report هو نسبة مئوية (%) وليس مبلغ (على خلاف
//     discount_amount في stock.picking.report) — لذا لم يُدرَج هنا لتفادي
//     الخلط؛ يمكن إضافته لاحقًا كـ "discount:avg" إذا لزم عرضه كنسبة
async function _rpc_fetchJ1SalesReport(baseUrl, targetDateKey, extraGroupBy) {
  const today = targetDateKey || getTodayKey();
  const j1 = (() => {
    const d = new Date(today); d.setDate(d.getDate() - 1);
    return d.getFullYear() + "-" +
           String(d.getMonth() + 1).padStart(2, "0") + "-" +
           String(d.getDate()).padStart(2, "0");
  })();

  const groupby = extraGroupBy ? ["user_id", extraGroupBy] : ["user_id"];

  let groups;
  try {
    groups = await _rpc_call(baseUrl, {
      model:  "sale.report",
      method: "read_group",
      args:   [
        [
          ["state", "!=", "cancel"],
          ["date",  ">=", j1    + " 00:00:00"],
          ["date",  "<",  today + " 00:00:00"],
        ],
        ["product_uom_qty:sum", "qty_invoiced:sum", "price_subtotal:sum", "price_total:sum"],
        groupby,
      ],
      kwargs: { lazy: false, context: { lang: "en_US", tz: false } },
    });
  } catch (e) {
    // رسالة مفصّلة تتضمن نص خطأ Odoo كاملاً (بدل فشل صامت) — مفيدة لتشخيص
    // أي حقل آخر غير موجود فعليًا في sale.report (state, user_id,
    // product_uom_qty, qty_invoiced, price_subtotal, price_total)
    _emit("FETCH_ERROR", { msg: "⚠️ تعذّر جلب تقرير مبيعات J-1 (sale.report): " + e.message });
    return { date: j1, rows: [] };
  }

  if (!Array.isArray(groups)) return { date: j1, rows: [] };

  const rows = groups
    .filter(g => Array.isArray(g.user_id) && g.user_id[0])
    .map(g => ({
      vendeurId:     g.user_id[0],
      vendeurName:   g.user_id[1] || "—",
      extraId:       extraGroupBy && Array.isArray(g[extraGroupBy]) ? g[extraGroupBy][0] : null,
      extraName:     extraGroupBy ? (Array.isArray(g[extraGroupBy]) ? g[extraGroupBy][1] : "—") || "—" : null,
      qtyVendueJ1:   g["product_uom_qty"] || 0,
      qtyFactureeJ1: g["qty_invoiced"]    || 0,
      montantHTJ1:   g["price_subtotal"]  || 0,
      montantTTCJ1:  g["price_total"]     || 0,
      nbLignesJ1:    g["__count"] || 0,
    }))
    .sort((a, b) => a.vendeurName.localeCompare(b.vendeurName, "fr"));

  return { date: j1, rows };
}

// ── تقرير التحصيلات اليومية: مدفوعات نفس تاريخ التوزيع (targetDateKey) ─
// نفس بنية _rpc_fetchDailyDistributionReport/_rpc_fetchJ1SalesReport، لكن
// على account.payment، مجمّعة حسب البائع.
//
// ملاحظات حول الحقول المستعملة (تم التحقق منها ضمن هذا الملف نفسه، وليس
// افتراضًا مباشرًا):
//   - تاريخ الدفع: "payment_date" — هذا هو الحقل الفعلي المستعمل في
//     account.payment ضمن هذا المشروع (انظر _rpc_createPayment أعلاه حيث
//     يُرسَل payment_date عند create، و_rpc_fetchPayments حيث يُطلب ضمن
//     fields عند search_read وينجح). لذا اعتُمد "payment_date" بدل "date".
//   - user_id: حقل موجود فعليًا في account.payment (مستعمل في
//     _rpc_createPayment أعلاه: user_id: fields.odooUserId)، لذا استُعمل
//     مباشرة كـ groupby دون الحاجة لبديل create_uid.
//   - state: استثناء 'draft' و'cancelled' كما طُلب صراحةً (بخلاف باقي
//     الدوال في هذا الملف التي تستثني 'cancel' فقط — هنا الاسم مختلف
//     بحسب الطلب).
async function _rpc_fetchDailyCollectionsReport(baseUrl, targetDateKey) {
  const today    = targetDateKey || getTodayKey();
  const tomorrow = (() => {
    const d = new Date(today); d.setDate(d.getDate() + 1);
    return d.getFullYear() + "-" +
           String(d.getMonth() + 1).padStart(2, "0") + "-" +
           String(d.getDate()).padStart(2, "0");
  })();

  let groups;
  try {
    groups = await _rpc_call(baseUrl, {
      model:  "account.payment",
      method: "read_group",
      args:   [
        [
          ["state",        "not in", ["draft", "cancel", "cancelled"]],
          ["payment_date", ">=", today    + " 00:00:00"],
          ["payment_date", "<",  tomorrow + " 00:00:00"],
        ],
        ["amount:sum"],
        ["user_id", "payment_type"],
      ],
      kwargs: { lazy: false, context: { lang: "en_US", tz: false } },
    });
  } catch (e) {
    _emit("FETCH_ERROR", { msg: "⚠️ تعذّر جلب تقرير التحصيلات اليومية: " + e.message });
    return { date: today, rows: [] };
  }

  if (!Array.isArray(groups)) return { date: today, rows: [] };

  // تجميع بإشارة صحيحة: inbound موجب، outbound سالب (مدفوعات الموردين تُطرح)
  const byVendeur = {};
  groups
    .filter(g => Array.isArray(g.user_id) && g.user_id[0])
    .forEach(g => {
      const id = g.user_id[0];
      const signed = g["payment_type"] === "outbound" ? -(g["amount"] || 0) : (g["amount"] || 0);
      if (!byVendeur[id]) byVendeur[id] = { vendeurId: id, vendeurName: g.user_id[1] || "—", montantEncaisse: 0, nbPaiements: 0 };
      byVendeur[id].montantEncaisse += signed;
      byVendeur[id].nbPaiements    += g["__count"] || 0;
    });

  const rows = Object.values(byVendeur)
    .sort((a, b) => a.vendeurName.localeCompare(b.vendeurName, "fr"));

  return { date: today, rows };
}

// ══════════════════════════════════════════════════════════════
// بيانات "شبه خام" (مجمّعة بأدنى تفصيل ممكن: بائع+منتج+فئة+يوم) لـ
// Report Viewer — تُستهلك عبر formulaEngine.js (evaluateSumIfs).
// ⚠️ استُبدل search_read بـ read_group هنا (نفس نمط
// fetchDailyDistributionReport السريعة أعلاه): sale.report/
// stock.picking.report SQL views، وsearch_read عليها بطيء ببنيته لأنه
// يُرجع صفًا لكل عملية بيع/توزيع فردية. read_group بـgroupby يشمل
// user_id+product_id+categ_id+date:day يُرجع صفًا واحدًا فقط لكل
// تركيبة (بائع+منتج+يوم) — تجميع منفّذ على مستوى قاعدة البيانات
// (SQL GROUP BY)، وكافٍ تمامًا لمطابقة شروط SUMIF لأن evaluateSumIfs
// يفلتر بنفس هذا المستوى من التفصيل (لا يحتاج كل عملية بيع منفردة).
// نافذة الجلب الافتراضية: آخر 60 يومًا حتى jour (يشمل).
// ⚠️ account.payment (enc) لا يملك product_id/categ_id في Odoo، لذا هذان
// الحقلان يُعادان فارغين لصفوف enc — أي صيغة SUMIFS تفلتر enc حسب art/
// cat لن تُطابق أي صف (سلوك متوقع بحسب نموذج البيانات، وليس خطأ).
// ══════════════════════════════════════════════════════════════

function _rpc_dateWindow(theday, lookbackDays) {
  const to = theday || getTodayKey();
  const from = (() => {
    const d = new Date(to); d.setDate(d.getDate() - lookbackDays);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  })();
  const toExclusive = (() => {
    const d = new Date(to); d.setDate(d.getDate() + 1);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  })();
  return { from, toExclusive };
}

// يستخرج تاريخ اليوم (YYYY-MM-DD) من مجموعة read_group مُجمّعة بـ"field:day".
// المصدر الموثوق: g.__range[groupKey].from (تاريخ ISO حقيقي من أودو).
// fallback: تحليل القيمة النصية المعروضة (مثل "17 Jul 2026" بلغة en_US)
// في حال عدم توفر __range (نُسخ أودو الأقدم).
function _rpc_extractGroupDayISO(g, groupKey) {
  const range = g && g.__range && g.__range[groupKey];
  if (range && range.from) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(range.from));
    if (m) return m[1];
  }
  const label = g && g[groupKey];
  if (label) {
    const d = new Date(label);
    if (!isNaN(d.getTime())) {
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }
  }
  return null;
}

// ── vnt (مصدر DSL): مجمّعة (بائع+منتج+فئة+تعريفة سعر+يوم) من sale.report ─
// ⚠️ pricelist_id: حقل many2one قياسي في sale.report (يُسقَط من
// sale_order.pricelist_id عبر الـ SQL view) — موجود بنفس الاسم في
// كل إصدارات Odoo المعروفة (8+). لم يُختبر مباشرة على قاعدتك؛ إن
// رمى Odoo خطأ "Invalid field 'pricelist_id'" فهذا يعني أن التسمية
// اختلفت في نسختك، وعندها فقط عدّل الاسم أدناه (في fields وgroupby
// وفي resolveColumn بـ formulaEngine.js).
async function _rpc_fetchSaleRawRows(baseUrl, theday, lookbackDays = 60) {
  const { from, toExclusive } = _rpc_dateWindow(theday, lookbackDays);
  const timerLabel = `[reportViewer] sale read_group (${lookbackDays}j)`;
  console.time(timerLabel);
  let groups;
  try {
    groups = await _rpc_call(baseUrl, {
      model:  "sale.report",
      method: "read_group",
      args:   [
        [
          ["state", "!=", "cancel"],
          ["date",  ">=", from        + " 00:00:00"],
          ["date",  "<",  toExclusive + " 00:00:00"],
        ],
        ["product_uom_qty:sum", "price_total:sum", "packaging_quantity_1:sum", "packaging_quantity_2:sum", "packaging_quantity_3:sum"],
        ["user_id", "product_id", "product_tmpl_id", "categ_id", "pricelist_id", "date:day"],
      ],
      kwargs: { lazy: false, context: { lang: "en_US", tz: false } },
    });
  } catch (e) {
    console.timeEnd(timerLabel);
    _emit("FETCH_ERROR", { msg: "⚠️ تعذّر جلب بيانات المبيعات (sale.report): " + e.message });
    return [];
  }
  console.timeEnd(timerLabel);
  if (!Array.isArray(groups)) return [];
  return groups
    .map(g => ({
      user_id: g.user_id, product_id: g.product_id, product_tmpl_id: g.product_tmpl_id, categ_id: g.categ_id,
      pricelist_id: g.pricelist_id,
      date: _rpc_extractGroupDayISO(g, "date:day"),
      qty: g["product_uom_qty"] || 0, amount: g["price_total"] || 0,
      // pack1/pack2/pack3: الكمية بالحزمة (packaging_quantity_1/2/3) —
      // حقول مؤكَّدة فعليًا على sale.report (وstock.picking.report، انظر
      // _rpc_fetchDilRawRows أدناه). الأسماء مؤقتة (pack1/2/3) حتى تأكيد
      // أيها يمثل الكرتون/الفردو فعليًا؛ عندها تُعاد تسميتها لاسم DSL
      // نهائي واضح (formulaEngine.js + reportBuilder.js) في جولة قادمة.
      pack1: g["packaging_quantity_1"] || 0,
      pack2: g["packaging_quantity_2"] || 0,
      pack3: g["packaging_quantity_3"] || 0,
    }))
    .filter(r => r.date); // استبعاد أي مجموعة تعذّر استخراج تاريخها (نادر جدًا)
}

// ══════════════════════════════════════════════════════════════
// تشخيص: fields_get على stock.picking.report — لدعم عمود "lp"
// (listeprix) في مصدر DSL "liv" مستقبلاً.
// ──────────────────────────────────────────────────────────────
// ⚠️ لم يُفعَّل دعم lp لمصدر liv بعد. السبب التقني:
// stock.picking.report هو نموذج SQL view (وليس جدول حقيقي)، وأعمدته
// المتاحة فعليًا تختلف باختلاف نسخة Odoo والتخصيصات المثبتة على كل
// قاعدة على حدة — لا توجد طريقة موثوقة لتخمين اسم الحقل الصحيح من
// الكود وحده (مثل sale_line_id مقابل sale_id مقابل group_id مقابل
// origin نصي بسيط بلا علاقة). تخمين اسم خاطئ قد لا يُنتج خطأ صريحًا؛
// أسوأ سيناريو هو أن يُرجع Odoo قيمة undefined لكل الصفوف بصمت فتُقارَن
// شروط lp دائمًا بـundefined ولا تُطابق أي صف — تقرير يبدو "يعمل" لكنه
// يعطي صفرًا خاطئًا دائمًا لأي صيغة SUMIFS(liv; lp; ...)، وهذا أخطر من
// عدم دعم الميزة إطلاقًا. لذلك لن يُضاف related field تخمينًا.
//
// الحل: استدعِ الدالة التالية من console المتصفح (بعد فتح التطبيق
// وتسجيل الدخول) وأرسل لي الناتج المطبوع، فأربط lp بالحقل الصحيح:
//   await rpcController.debugInspectPickingReportFields(getOdooBase())
// تبحث الدالة عن أي حقل في stock.picking.report اسمه أو نوعه يوحي
// بعلاقة بالمبيعات (sale_id, sale_line_id, group_id, procurement_group_id،
// أو أي many2one آخر باسم يحتوي "sale")، وتطبعها كاملة بنوعها والموديل
// الذي تشير إليه (relation). إن ظهر حقل many2one فعلي يشير لـ
// sale.order أو sale.order.line، يمكن حينها إضافة related field بصيغة
// "الحقل.pricelist_id" إلى fields في _rpc_fetchDilRawRows (إن كان
// Odoo يدعم dotted path في read_group لهذا النموذج تحديدًا — هذا أيضًا
// يحتاج تأكيدًا فعليًا لأن read_group لا يدعم dotted paths دائمًا على
// كل الحقول/الموديلات، وقد يتطلب الأمر بدلاً من ذلك نداءً منفصلاً
// يربط صفوف liv بـsale.order عبر origin (نصي) كما هو مستعمل فعلاً في
// دوال أخرى بهذا الملف، ثم دمج pricelist_id يدويًا بعد الجلب).
// ──────────────────────────────────────────────────────────────
async function _rpc_debugInspectPickingReportFields(baseUrl) {
  let allFields;
  try {
    allFields = await _rpc_call(baseUrl, {
      model:  "stock.picking.report",
      method: "fields_get",
      args:   [],
      kwargs: { attributes: ["string", "type", "relation"] },
    });
  } catch (e) {
    console.error("[reportBuilder debug] fields_get فشل على stock.picking.report:", e.message);
    return null;
  }
  const candidates = {};
  for (const [name, def] of Object.entries(allFields || {})) {
    const looksRelevant =
      /sale|pricelist|group|origin/i.test(name) ||
      (def.relation && /sale/i.test(def.relation));
    if (looksRelevant) candidates[name] = { type: def.type, relation: def.relation || null, label: def.string };
  }
  console.log("[reportBuilder debug] كل حقول stock.picking.report:", allFields);
  console.log("[reportBuilder debug] حقول مرشّحة للربط بـ sale.order (لدعم lp لاحقًا):", candidates);
  return candidates;
}

// ── liv (مصدر DSL): مجمّعة (بائع+منتج+فئة+تعريفة سعر+يوم) من stock.picking.report (date_done) ──
// ✅ عمود "lp" (pricelist_id) مدعوم لمصدر liv: تأكّدنا فعليًا (عبر
// _rpc_debugInspectPickingReportFields، انظر التعليق أعلاه) أن
// stock.picking.report يملك حقل pricelist_id مباشرة
// (many2one -> product.pricelist)، بلا أي حاجة لربط عبر sale.order.
async function _rpc_fetchDilRawRows(baseUrl, theday, lookbackDays = 60) {
  const { from, toExclusive } = _rpc_dateWindow(theday, lookbackDays);
  const timerLabel = `[reportViewer] dil read_group (${lookbackDays}j)`;
  console.time(timerLabel);
  let groups;
  try {
    groups = await _rpc_call(baseUrl, {
      model:  "stock.picking.report",
      method: "read_group",
      args:   [
        [
          ["state",         "=",  "done"],
          ["invoice_state", "=",  "invoiced"],
          ["date_done",     ">=", from        + " 00:00:00"],
          ["date_done",     "<",  toExclusive + " 00:00:00"],
        ],
        ["product_uom_qty:sum", "price_total:sum", "packaging_quantity_1:sum", "packaging_quantity_2:sum", "packaging_quantity_3:sum"],
        ["user_id", "product_id", "product_tmpl_id", "categ_id", "pricelist_id", "date_done:day"],
      ],
      kwargs: { lazy: false, context: { lang: "en_US", tz: false } },
    });
  } catch (e) {
    console.timeEnd(timerLabel);
    _emit("FETCH_ERROR", { msg: "⚠️ تعذّر جلب بيانات التوزيع (stock.picking.report): " + e.message });
    return [];
  }
  console.timeEnd(timerLabel);
  if (!Array.isArray(groups)) return [];
  return groups
    .map(g => ({
      user_id: g.user_id, product_id: g.product_id, product_tmpl_id: g.product_tmpl_id, categ_id: g.categ_id,
      pricelist_id: g.pricelist_id,
      date_done: _rpc_extractGroupDayISO(g, "date_done:day"),
      qty: g["product_uom_qty"] || 0, amount: g["price_total"] || 0,
      // pack1/pack2/pack3: انظر التعليق المطابق في _rpc_fetchSaleRawRows أعلاه.
      pack1: g["packaging_quantity_1"] || 0,
      pack2: g["packaging_quantity_2"] || 0,
      pack3: g["packaging_quantity_3"] || 0,
    }))
    .filter(r => r.date_done);
}

// ══════════════════════════════════════════════════════════════
// ✅ محدَّث: تأكّد فعليًا وجود ثلاثة حقول "packaging_quantity_1/2/3"
// بنفس الاسم على كل من sale.report وstock.picking.report. فُعِّلت
// كـmetrics في SUMIFS تحت الأسماء المؤقتة pack1/pack2/pack3 (انظر
// _rpc_fetchSaleRawRows وrsc_fetchDilRawRows أعلاه، وformulaEngine.js).
// الأسماء pack1/2/3 مؤقتة عمدًا حتى تحديد أيها يمثل الكرتون/الفردو
// فعليًا في الاستعمال، وستُعاد تسميتها لاحقًا لاسم DSL نهائي أوضح.
// غير مفعّلة على enc (account.payment لا يملك هذه الحقول أصلاً).
// دالة التشخيص أدناه أُبقيَت لأغراض تشخيصية مستقبلية (حقول أخرى محتملة).
// ──────────────────────────────────────────────────────────────
// تشخيص: fields_get على sale.report وstock.picking.report — للبحث
// عن الحقل الصحيح لـ"الكمية بالحزمة" (carton/fardeau/colis) لدعم
// metric ثالث في SUMIFS (بجانب amount وqty الحاليين)، اسمه المقترَح
// في صيغ DSL: "cdn" (نفس الاختصار المستعمل فعليًا في هذا الملف لكمية
// الكرتون/الطرد في أماكن أخرى غير متعلقة بالتقارير، انظر مثلاً
// addProductToRound/qtyCdn وaddBLLine/cdn أعلاه — لكن هذا لا يعني أن
// اسم الحقل نفسه في sale.report/stock.picking.report هو نفسه، فتلك
// دوال RPC مختلفة كليًا على موديلات مختلفة stock.move/account.move).
// ──────────────────────────────────────────────────────────────
// (ملاحظة تاريخية: الفقرة أدناه وُضعت قبل تأكيد الحقول، وأُبقيت لتوثيق
// سبب عدم التخمين وقتها. تأكّدت packaging_quantity_1/2/3 لاحقًا وفُعِّلت
// كما هو موثّق أعلاه.)
// - sale.report وstock.picking.report كلاهما SQL views، وأعمدتهما
//   المتاحة فعليًا تعتمد على نسخة Odoo والتخصيصات المثبتة على القاعدة.
// - وُجد فعليًا في هذا الملف أن نموذج stock.move (وليس stock.picking.report
//   المُجمَّع) يملك حقلاً حقيقيًا باسم "packaging_quantity" (مستعمل في
//   _rpc_fetchBLLines/_rpc_addBLLine/إلخ أعلاه على stock.move مباشرة) —
//   وهذا لم يكن كافيًا وحده لتأكيد وجود packaging_quantity_1/2/3 على
//   sale.report/stock.picking.report قبل التحقق الفعلي عبر fields_get.
//
// الحل (لا يزال متاحًا لتشخيص حقول أخرى مستقبلاً): استدعِ الدالة التالية
// من console المتصفح وأرسل لي الناتج:
//   await rpcController.debugInspectPackagingFields(getOdooBase())
// تبحث الدالة عن أي حقل في sale.report وstock.picking.report اسمه أو
// نوعه يوحي بعلاقة بالتعبئة/الحزمة (packaging, colis, carton, fardeau,
// package, qty_delivered بوحدات مختلفة عبر product_uom_id)، وتطبعها
// كاملة مع نوعها.
// ──────────────────────────────────────────────────────────────
async function _rpc_debugInspectPackagingFields(baseUrl) {
  const re = /packag|colis|carton|fardeau|caisse|box|uom/i;
  const result = {};
  for (const model of ["sale.report", "stock.picking.report"]) {
    let allFields;
    try {
      allFields = await _rpc_call(baseUrl, {
        model, method: "fields_get", args: [],
        kwargs: { attributes: ["string", "type", "relation"] },
      });
    } catch (e) {
      console.error(`[reportBuilder debug] fields_get فشل على ${model}:`, e.message);
      result[model] = null;
      continue;
    }
    const candidates = {};
    for (const [name, def] of Object.entries(allFields || {})) {
      if (re.test(name) || re.test(def.string || "")) {
        candidates[name] = { type: def.type, relation: def.relation || null, label: def.string };
      }
    }
    console.log(`[reportBuilder debug] كل حقول ${model}:`, allFields);
    console.log(`[reportBuilder debug] حقول مرشّحة للكمية بالحزمة على ${model}:`, candidates);
    result[model] = candidates;
  }
  return result;
}

// ── تشخيص: بحث عن حقل route/planning على res.users (طلب المستخدم: زر
// "Route" بالكرت). لا نخمّن الاسم — نستدعي fields_get فعليًا ونطبع أي حقل
// اسمه أو وصفه يوحي بعلاقة بمسار/تخطيط/جولة. يُستدعى من Console:
//   await rpcController.debugInspectRouteFields(getOdooBase())
async function _rpc_debugInspectRouteFields(baseUrl) {
  const re = /route|planning|template|tourn[ée]e|zone|secteur|circuit/i;
  let allFields;
  try {
    allFields = await _rpc_call(baseUrl, {
      model: "res.users", method: "fields_get", args: [],
      kwargs: { attributes: ["string", "type", "relation"] },
    });
  } catch (e) {
    console.error("[rpc debug] fields_get فشل على res.users:", e.message);
    return null;
  }
  const candidates = {};
  for (const [name, def] of Object.entries(allFields || {})) {
    if (re.test(name) || re.test(def.string || "")) {
      candidates[name] = { type: def.type, relation: def.relation || null, label: def.string };
    }
  }
  console.log("[rpc debug] كل حقول res.users:", allFields);
  console.log("[rpc debug] حقول مرشّحة لـroute/planning على res.users:", candidates);
  return candidates;
}


async function _rpc_fetchEncRawRows(baseUrl, theday, lookbackDays = 60) {
  const { from, toExclusive } = _rpc_dateWindow(theday, lookbackDays);
  const timerLabel = `[reportViewer] enc read_group (${lookbackDays}j)`;
  console.time(timerLabel);
  let groups;
  try {
    groups = await _rpc_call(baseUrl, {
      model:  "account.payment",
      method: "read_group",
      args:   [
        [
          ["state",        "not in", ["draft", "cancel", "cancelled"]],
          ["payment_date", ">=", from        + " 00:00:00"],
          ["payment_date", "<",  toExclusive + " 00:00:00"],
        ],
        ["amount:sum"],
        ["user_id", "create_uid", "payment_date:day", "payment_type"],
      ],
      kwargs: { lazy: false, context: { lang: "en_US", tz: false } },
    });
  } catch (e) {
    console.timeEnd(timerLabel);
    _emit("FETCH_ERROR", { msg: "⚠️ تعذّر جلب بيانات التحصيلات (account.payment): " + e.message });
    return [];
  }
  console.timeEnd(timerLabel);
  if (!Array.isArray(groups)) return [];
  return groups
    .map(g => ({
      user_id: g.user_id, product_id: null, categ_id: null,
      // create_uid: مُنشئ سجل الدفعة (account.payment) — [id, name] كـuser_id.
      // مضاف فقط لدعم عمود DSL الجديد "crt" (createur). مدعوم لمصدر enc
      // فقط لأن account.payment يملك create_uid ذا معنى واضح (من أنشأ
      // الدفعة فعليًا، وقد يختلف عن user_id/البائع المسؤول). لم يُضَف
      // لـvnt (sale.report) أو liv (stock.picking.report) لأنهما SQL
      // views، وتأكّد وجود create_uid ذي معنى مشابه فيهما لم يُثبَت بعد
      // (بنفس منطق "لا نخمّن اسم/وجود حقل دون تأكيد فعلي" المتبع أعلاه
      // في _rpc_debugInspectPickingReportFields). إن تأكّد لاحقًا وجوده
      // بمعنى صحيح على أحدهما، يكفي تكرار نفس السطر (create_uid: g.create_uid)
      // في _rpc_fetchSaleRawRows/_rpc_fetchDilRawRows بعد إضافته لـfields/groupby هناك.
      create_uid: g.create_uid,
      date: _rpc_extractGroupDayISO(g, "payment_date:day"),
      qty: null, amount: g["payment_type"] === "outbound" ? -(g["amount"] || 0) : (g["amount"] || 0),
    }))
    .filter(r => r.date);
}

// ── يجلب الثلاث مصادر معًا بالتوازي، بنفس theday ──────────────
// ⚠️ مفاتيح الكائن المُعاد (vnt/liv/enc) هي أسماء مصادر DSL صيغ SUMIFS
// (انظر SOURCE_DATE_FIELD في formulaEngine.js) — وليست أسماء حقول Odoo.
async function _rpc_fetchReportRawSources(baseUrl, theday, lookbackDays = 60) {
  const [vnt, liv, enc] = await Promise.all([
    _rpc_fetchSaleRawRows(baseUrl, theday, lookbackDays),
    _rpc_fetchDilRawRows(baseUrl, theday, lookbackDays),
    _rpc_fetchEncRawRows(baseUrl, theday, lookbackDays),
  ]);
  return { vnt, liv, enc };
}

// ── حفظ roundIds في storage ───────────────────────────────────
async function _rpc_saveIds(mapping, today, mode) {
  const raw = await Storage.get("wafa_roundIds", {});
  const all = raw || {};
  if (!all[today])        all[today]        = {};
  if (!all[today][mode])  all[today][mode]  = {};
  for (const [vid, data] of Object.entries(mapping)) all[today][mode][vid] = data.roundId;
  return Storage.set("wafa_roundIds", all);
}

async function _rpc_loadIds(today, mode) {
  const raw = await Storage.get("wafa_roundIds", {});
  return ((raw || {})[today] || {})[mode] || {};
}

// ── Fetch كامل ──────────────────────────────────────────────
async function _rpc_triggerFetch(workers, baseUrl, mode, dateOffset = 0, skipCF = false) {
  _rpc_aborted = false;
  _emit("FETCH_STARTED", { mode });

  const targetDateKey = getDateKey(dateOffset);

  let mapping, today, tomorrow;
  try {
    ({ mapping, today, tomorrow } = await _rpc_fetchToday(baseUrl, workers, mode, targetDateKey));
  } catch (e) {
    _emit("FETCH_ERROR", { msg: "RPC: " + e.message });
    _emit("LINKS_UPDATED", { mode, links: {}, stats: {}, refs: {}, roundStatus: {}, odooState: {}, userStatus: {}, dateOffset });
    return { rpcFailed: true };
  }

  // بعد: sales + delivery + encaissement لا يعتمد أحدها على الآخر → تشغيل بالتوازي
  const roundIdToWorkers = {}; // roundId -> [workerId, ...]
  workers.forEach(w => {
    const rounds = mapping[w.id];
    const data = Array.isArray(rounds) ? rounds[0] : rounds;
    if (!data?.roundId) return;
    if (!roundIdToWorkers[data.roundId]) roundIdToWorkers[data.roundId] = [];
    roundIdToWorkers[data.roundId].push(w.id);
  });
  const encRoundIds = Object.keys(roundIdToWorkers).map(Number);

  const [salesMap, delivMap, encPayments] = await Promise.all([
    mode === "mr" ? Promise.resolve({}) : _rpc_fetchSales(baseUrl, targetDateKey, tomorrow),
    mode === "livraison" ? _rpc_fetchDeliveriesByPlanning(baseUrl, mapping) : Promise.resolve({}),
    encRoundIds.length ? _rpc_call(baseUrl, {
      model: "account.payment", method: "search_read",
      args: [[["planning_id","in",encRoundIds],["state","!=","cancel"]]],
      kwargs: { fields: ["planning_id","amount","state","payment_type"], limit: 20000 },
    }).catch(() => []) : Promise.resolve([]),
  ]);

  // Encaissements: توزيع نتائج نداء bulk واحد على العمال
  let encaissementMap = {};
  {
    const totalsByRound = {};
    (encPayments || []).forEach(p => {
      const rid = Array.isArray(p.planning_id) ? p.planning_id[0] : p.planning_id;
      if (rid == null) return;
      const amt = p.amount || 0;
      const signed = p.payment_type === "outbound" ? -amt : amt;
      totalsByRound[rid] = (totalsByRound[rid] || 0) + signed;
    });
    Object.entries(roundIdToWorkers).forEach(([rid, wids]) => {
      const total = totalsByRound[rid] || 0;
      wids.forEach(wid => { encaissementMap[wid] = total || null; });
    });
  }

  const allLinks = await Storage.getVendorLinks();
  const allRefs  = await Storage.getVendorRefs();
  const allStats = await Storage.getVendorStats();

  if (!allLinks[targetDateKey])              allLinks[targetDateKey]              = {};
  if (!allLinks[targetDateKey][mode])        allLinks[targetDateKey][mode]        = {};
  if (!allRefs[targetDateKey])               allRefs[targetDateKey]               = {};
  if (!allRefs[targetDateKey][mode])         allRefs[targetDateKey][mode]         = {};
  if (!allStats[targetDateKey])              allStats[targetDateKey]              = {};
  allStats[targetDateKey][mode] = {};

  let found = 0;
  for (const w of workers) {
    if (_rpc_aborted) {
      _emit("FETCH_ERROR", { msg: "Opération annulée" });
      return { aborted: true };
    }
    const rounds = mapping[w.id]; // الآن مصفوفة
    if (!rounds || !rounds.length) continue;

    const cleanBase = baseUrl.replace(/\/$/, "");
    let actionId = 527;
    if (mode === "livraison") actionId = 549;

    // بناء مصفوفة الجولات مع stats لكل منها
    const roundsData = rounds.map(data => {
      const url = `${cleanBase}/web#id=${data.roundId}&action=${actionId}&model=planning.planning&view_type=form&cids=1&menu_id=336`;
      const sales = (data.odooUserId && salesMap[data.odooUserId]) || {};
      const deliv = (mode === "livraison" ? delivMap[w.id] : null) || {};
      const ca = mode === "livraison"
        ? (((sales.ca ?? 0) + (deliv.caDelivery ?? 0)) || null)
        : (mode === "mr" ? null : (sales.ca ?? null));
      const firstVisit = mode === "livraison"
        ? (deliv.firstTransfer ?? sales.firstVisit ?? null)
        : (sales.firstVisit ?? null);
      const lastVisit = mode === "livraison"
        ? (deliv.lastTransfer ?? sales.lastVisit ?? null)
        : (sales.lastVisit ?? null);
      const encaissement = encaissementMap[w.id] ?? null;
      return {
        url, roundId: data.roundId, ref: data.ref,
        state: data.state, user_status: data.user_status,
        visits_rate: data.visits_rate, success_rate: data.success_rate,
        totalClients: data.totalClients, horsZone: data.horsZone,
        odooUserId: data.odooUserId,
        stats: {
          visitRate: data.visits_rate, successRate: data.success_rate,
          totalClients: data.totalClients, ca, encaissement,
          firstVisit, lastVisit, updatedAt: Date.now(),
          roundId: data.roundId, horsZone: data.horsZone ?? false,
          odooUserId: data.odooUserId ?? null,
        },
      };
    });

    // الجولة المفتوحة هي الأولوية، وإلا أول جولة
    const openStates = ["sale", "in_progress", "open", "done"];
    const primary = roundsData.find(r => openStates.includes(r.state)) ?? roundsData[0];
    allLinks[targetDateKey][mode][w.id] = roundsData.length > 1
      ? roundsData.map(r => r.url)  // مصفوفة روابط إذا أكثر من جولة
      : primary.url;
    if (primary.ref) allRefs[targetDateKey][mode][w.id] = primary.ref;
allStats[targetDateKey][mode][w.id] = {
      ...primary.stats,
      rounds: roundsData.map(r => ({ url: r.url, roundId: r.roundId, ref: r.ref, state: r.state, user_status: r.user_status, stats: r.stats })),
    };

    found++;
  }

  // Hors Tournée detection
  const allEventIds = Object.values(mapping).flatMap(rounds =>
    Array.isArray(rounds) ? rounds.flatMap(r => Array.isArray(r.eventIds) ? r.eventIds : []) : []
  );
  if (allEventIds.length) {
    try {
      const pending = await _rpc_call(baseUrl, {
        model:  "calendar.event",
        method: "search_read",
        args:   [[
          ["id", "in", allEventIds],
          ["in_template", "=", false],
          ["validation_state", "=", "to_validate"],
        ]],
        kwargs: { fields: ["id"], limit: 500 },
      });
      const pendingSet = new Set(Array.isArray(pending) ? pending.map(e => e.id) : []);
      for (const w of workers) {
        const rounds = mapping[w.id];
        if (!Array.isArray(rounds)) continue;
        const hasHors = rounds.some(r => (r.eventIds || []).some(eid => pendingSet.has(eid)));
        if (allStats[targetDateKey][mode][w.id]) {
          allStats[targetDateKey][mode][w.id].horsRoute = hasHors;
        }
      }
    } catch (_) {}
  }

  // ── BL pending detection ──────────────────────────────────
  try {
    const allRoundIds = Object.values(mapping)
      .flatMap(rounds => Array.isArray(rounds) ? rounds.map(r => r.roundId) : [rounds?.roundId])
      .filter(Boolean);
    if (allRoundIds.length) {
      const pendingBLs = await _rpc_call(baseUrl, {
        model: "stock.picking",
        method: "search_read",
        args: [[["planning_id", "in", allRoundIds], ["state", "not in", ["done", "cancel", "assigned", "draft"]]]],
        kwargs: { fields: ["id", "planning_id", "state", "delivery_planning_id", "delivery_user_id"], limit: 500 },
      });
      const blByRound = {};
      for (const bl of (Array.isArray(pendingBLs) ? pendingBLs : [])) {
        const pid = Array.isArray(bl.planning_id) ? bl.planning_id[0] : bl.planning_id;
        // تجاهل BL إذا كان في جولة prevente ولديه tournée livraison + livreur محددان
        if (mode === "prevente" && bl.delivery_planning_id && bl.delivery_user_id) continue;
        if (!blByRound[pid]) blByRound[pid] = 0;
        blByRound[pid]++;
      }
      for (const w of workers) {
        const rounds = mapping[w.id];
        if (!Array.isArray(rounds)) continue;
        const count = rounds.reduce((s, r) => s + (blByRound[r.roundId] || 0), 0);
        if (allStats[targetDateKey][mode][w.id]) {
          allStats[targetDateKey][mode][w.id].pendingBLs = count;
        }
      }
    }
} catch(_) {}

  // ── BL polling (auto-refresh every 30s) ──────────────────────
  // ── C/F detection ─────────────────────────────────────────────
  if (!skipCF) try {
    {
      const allRoundIds = Object.values(mapping)
        .flatMap(rounds => Array.isArray(rounds) ? rounds.map(r => r.roundId) : [rounds?.roundId])
        .filter(Boolean);
      if (allRoundIds.length) {
        const moves = await _rpc_call(baseUrl, {
          model: "stock.move",
          method: "search_read",
          args: [[["picking_id.planning_id", "in", allRoundIds]]],
          kwargs: { fields: ["product_id", "product_uom_qty", "picking_id"], limit: 2000 },
        });
        if (Array.isArray(moves) && moves.length) {
          const productIds = [...new Set(moves.map(m => Array.isArray(m.product_id) ? m.product_id[0] : m.product_id))];

// جلب packaging + categ + tmpl لكل منتج
          const products = await _rpc_call(baseUrl, {
            model: "product.product",
            method: "search_read",
            args: [[["id", "in", productIds]]],
            kwargs: { fields: ["id", "packaging_ids", "product_tmpl_id", "categ_id"], limit: 500 },
          });
          const allPackIds = [];
          const tmplIds = [];
          const productCateg = {}; // productId → { id, name }
          const productTmpl  = {}; // productId → tmplId
          for (const p of (products || [])) {
            allPackIds.push(...(p.packaging_ids || []));
            const tmplId = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id;
            productTmpl[p.id] = tmplId;
            tmplIds.push(tmplId);
            const cid   = Array.isArray(p.categ_id) ? p.categ_id[0] : p.categ_id;
            const cname = Array.isArray(p.categ_id) ? p.categ_id[1] : String(p.categ_id || "");
            productCateg[p.id] = { id: cid, name: cname };
          }

          const [packagings, templates] = await Promise.all([
            _rpc_call(baseUrl, {
              model: "product.packaging", method: "search_read",
              args: [[["id", "in", allPackIds]]],
              kwargs: { fields: ["id", "qty", "product_id"], limit: 500 },
            }),
            _rpc_call(baseUrl, {
              model: "product.template", method: "read",
              args: [tmplIds, ["id", "product_custom_attribute_1"]],
              kwargs: {},
            }),
          ]);

          // نوع C/F من product_custom_attribute_1
          const cfTypeByProduct = {};
          for (const tmpl of (templates || [])) {
            const prodId = Object.keys(productTmpl).find(k => productTmpl[k] === tmpl.id);
            if (!prodId) continue;
            const val  = Array.isArray(tmpl.product_custom_attribute_1) ? tmpl.product_custom_attribute_1[1] : null;
            const type = val?.toUpperCase().includes("CARTON") ? "c"
                       : val?.toUpperCase().includes("FARDEAU") ? "f" : null;
            if (type) cfTypeByProduct[parseInt(prodId)] = type;
          }

          // qty per pack من packaging
          const cfInfoByProduct = {};
          for (const pk of (packagings || [])) {
            const prodId = Array.isArray(pk.product_id) ? pk.product_id[0] : pk.product_id;
            const type   = cfTypeByProduct[prodId];
            if (!type) continue;
            cfInfoByProduct[prodId] = { type, qty: pk.qty || 1 };
          }

          const cfByPicking = {};
          for (const m of moves) {
            const pid      = Array.isArray(m.picking_id) ? m.picking_id[0] : m.picking_id;
            const prodId   = Array.isArray(m.product_id) ? m.product_id[0] : m.product_id;
            const prodName = Array.isArray(m.product_id) ? m.product_id[1] : String(m.product_id);
            const info     = cfInfoByProduct[prodId];
            if (!info) continue;
            if (!cfByPicking[pid]) cfByPicking[pid] = { c: 0, f: 0, byCateg: {} };
            const qty    = (m.product_uom_qty || 0) / info.qty;
            cfByPicking[pid][info.type] += qty;
            const categ  = productCateg[prodId] || { id: 0, name: "Autre" };
            if (!cfByPicking[pid].byCateg[categ.id])
              cfByPicking[pid].byCateg[categ.id] = { name: categ.name, c: 0, f: 0, products: [] };
            cfByPicking[pid].byCateg[categ.id][info.type] += qty;
            cfByPicking[pid].byCateg[categ.id].products.push({
              name: prodName, type: info.type, qty
            });
          }

          // ربط بالـ vendor عبر planning_id
          const planningToVendor = {};
          for (const [vid, rounds] of Object.entries(mapping)) {
            if (!Array.isArray(rounds)) continue;
            for (const r of rounds) planningToVendor[r.roundId] = vid;
          }
          const pickingToPlanningMap = {};
          for (const m of moves) {
            const pickId = Array.isArray(m.picking_id) ? m.picking_id[0] : m.picking_id;
            // نحتاج planning_id للـ picking — نستخدم allRoundIds وnested mapping
          }

          // نجلب planning_id للـ pickings
          const pickingIds = Object.keys(cfByPicking).map(Number);
          if (pickingIds.length) {
            const pickings = await _rpc_call(baseUrl, {
              model: "stock.picking",
              method: "read",
              args: [pickingIds, ["id", "planning_id"]],
              kwargs: {},
            });
		const cfByVendor = {};
            for (const pick of (pickings || [])) {
              const planId = Array.isArray(pick.planning_id) ? pick.planning_id[0] : pick.planning_id;
              const vid = planningToVendor[planId];
              if (!vid) continue;
              const pickCF = cfByPicking[pick.id];
              if (!pickCF) continue;
              if (!cfByVendor[vid]) cfByVendor[vid] = { c: 0, f: 0, byCateg: {} };
              cfByVendor[vid].c += pickCF.c || 0;
              cfByVendor[vid].f += pickCF.f || 0;
              for (const [cid, cv] of Object.entries(pickCF.byCateg || {})) {
                if (!cfByVendor[vid].byCateg[cid])
                  cfByVendor[vid].byCateg[cid] = { name: cv.name, c: 0, f: 0, products: [] };
                cfByVendor[vid].byCateg[cid].c += cv.c || 0;
                cfByVendor[vid].byCateg[cid].f += cv.f || 0;
                cfByVendor[vid].byCateg[cid].products.push(...(cv.products || []));
              }
            }
            for (const [vid, cf] of Object.entries(cfByVendor)) {
              if (allStats[targetDateKey][mode][vid]) {
                allStats[targetDateKey][mode][vid].cf = cf;
              }
            }
          }
        }
      }
    }
  } catch(_) {}

  if (window._blPollTimer) clearInterval(window._blPollTimer);
  window._blSnap = { mapping, baseUrl, workers, targetDateKey, mode };
  window._blPollTimer = setInterval(async () => {
    try {
      const allRoundIds = Object.values(window._blSnap.mapping)
        .flatMap(rounds => Array.isArray(rounds) ? rounds.map(r => r.roundId) : [rounds?.roundId])
        .filter(Boolean);
      if (!allRoundIds.length) return;
      const pendingBLs = await _rpc_call(window._blSnap.baseUrl, {
        model: "stock.picking",
        method: "search_read",
        args: [[["planning_id", "in", allRoundIds], ["state", "not in", ["done", "cancel", "assigned", "draft"]]]],
        kwargs: { fields: ["id", "planning_id", "state"], limit: 500 },
      });
      const blByRound = {};
      for (const bl of (pendingBLs || [])) {
        const pid = Array.isArray(bl.planning_id) ? bl.planning_id[0] : bl.planning_id;
        if (!blByRound[pid]) blByRound[pid] = 0;
        blByRound[pid]++;
      }
      for (const w of window._blSnap.workers) {
        const rounds = window._blSnap.mapping[w.id];
        if (!Array.isArray(rounds)) continue;
        const count = rounds.reduce((s, r) => s + (blByRound[r.roundId] || 0), 0);
        _emit("BL_PENDING_UPDATE", { vendorId: w.id, count, mode: window._blSnap.mode, dateKey: window._blSnap.targetDateKey });
      }
    } catch(_) {}
  }, 30000);

  for (const w of workers) {
    const rounds = mapping[w.id];
    if (!rounds || !rounds.length) continue;
    const primary = rounds[0];
    _emit("LINK_FOUND", {      vendorId: w.id,
      url: Array.isArray(allLinks[targetDateKey][mode][w.id])
        ? allLinks[targetDateKey][mode][w.id][0]
        : allLinks[targetDateKey][mode][w.id],
      urls: Array.isArray(allLinks[targetDateKey][mode][w.id])
        ? allLinks[targetDateKey][mode][w.id]
        : [allLinks[targetDateKey][mode][w.id]],
      ref: primary.ref,
      stats: allStats[targetDateKey][mode][w.id],
      roundId: primary.roundId,
      state: primary.state,
      userStatus: primary.user_status,
      dateOffset, mode,
    });
  }

  // round status
  const allRoundStatus = await Storage.getRoundStatus();
  if (!allRoundStatus[targetDateKey])        allRoundStatus[targetDateKey]        = {};
  if (!allRoundStatus[targetDateKey][mode])  allRoundStatus[targetDateKey][mode]  = {};
  for (const w of workers) {
    const rounds = mapping[w.id];
    if (!rounds || !rounds.length) continue;
    const primary = rounds[0];
    if (primary.state === "closed") allRoundStatus[targetDateKey][mode][w.id] = "closed";
    else if (primary.state === "open") allRoundStatus[targetDateKey][mode][w.id] = "active";
  }
  await Storage.saveRoundStatus(allRoundStatus);
  await Storage.saveVendorLinks(allLinks);
  await Storage.saveVendorRefs(allRefs);
  await Storage.saveVendorStats(allStats);
  await _rpc_saveIds(mapping, targetDateKey, mode);

  const odooStateMap  = {};
  const userStatusMap = {};
  for (const w of workers) {
    const rounds = mapping[w.id];
    if (!rounds || !rounds.length) continue;
    const primary = rounds[0];
    odooStateMap[w.id]  = primary.state       || null;
    userStatusMap[w.id] = primary.user_status || null;
  }

  const _allOdooState = await Storage.getOdooState();
  const _allUserStatus = await Storage.getUserStatus();
  if (!_allOdooState[targetDateKey]) _allOdooState[targetDateKey] = {};
  if (!_allUserStatus[targetDateKey]) _allUserStatus[targetDateKey] = {};
  _allOdooState[targetDateKey][mode] = odooStateMap;
  _allUserStatus[targetDateKey][mode] = userStatusMap;
  await Storage.saveOdooState(_allOdooState);
  await Storage.saveUserStatus(_allUserStatus);
  _emit("LINKS_UPDATED", {
    mode,
    links:       (allLinks[targetDateKey]       || {})[mode] || {},
    stats:       (allStats[targetDateKey]       || {})[mode] || {},
    refs:        (allRefs[targetDateKey]        || {})[mode] || {},
    roundStatus: (allRoundStatus[targetDateKey] || {})[mode] || {},
    odooState:   odooStateMap,
    userStatus:  userStatusMap,
    dateOffset,
  });
}

// ── Refresh stats ─────────────────────────────────────────────
async function _rpc_refreshStats(workers, baseUrl, mode, dateOffset = 0) {
  _rpc_aborted = false;
  _emit("STATS_REFRESH_STARTED", { count: workers.length, mode });

  const targetDateKey = getDateKey(dateOffset);
  let mapping, today, tomorrow;
  try {
    ({ mapping, today, tomorrow } = await _rpc_fetchToday(baseUrl, workers, mode, targetDateKey));
  } catch (e) {
    _emit("FETCH_ERROR", { msg: "RPC stats: " + e.message });
    _emit("STATS_REFRESH_DONE", { done: 0, total: workers.length, mode });
    return;
  }

  const salesMap = await _rpc_fetchSales(baseUrl, today, tomorrow);
  const delivMap = mode === "livraison"
    ? await _rpc_fetchDeliveriesByPlanning(baseUrl, mapping)
    : {};

  const allStats = await Storage.getVendorStats();
  if (!allStats[targetDateKey])             allStats[targetDateKey]             = {};
  if (!allStats[targetDateKey][mode])       allStats[targetDateKey][mode]       = {};

  let done = 0;
  for (const w of workers) {
    const rounds = mapping[w.id];
    if (!Array.isArray(rounds) || !rounds.length) continue;
    const primary = rounds[0]; // نأخذ الجولة الأولى كمرجع للـ stats
    const sales = (primary.odooUserId && salesMap[primary.odooUserId]) || {};
    const deliv = (mode === "livraison" ? delivMap[w.id] : null) || {};
    const ca = mode === "livraison"
      ? (((sales.ca ?? 0) + (deliv.caDelivery ?? 0)) || null)
      : (sales.ca ?? null);
    const firstVisit = mode === "livraison"
      ? (deliv.firstTransfer ?? sales.firstVisit ?? null)
      : (sales.firstVisit ?? null);
    const lastVisit = mode === "livraison"
      ? (deliv.lastTransfer ?? sales.lastVisit ?? null)
      : (sales.lastVisit ?? null);
    const stats = {
      visitRate: primary.visits_rate, successRate: primary.success_rate,
      totalClients: primary.totalClients, ca, firstVisit, lastVisit,
      updatedAt: Date.now(), roundId: primary.roundId,
    };
    allStats[targetDateKey][mode][w.id] = stats;
    _emit("STATS_UPDATED", { vendorId: w.id, stats, ref: primary.ref || null, mode, dateOffset });
    done++;
  }
  await Storage.saveVendorStats(allStats);
  _emit("STATS_REFRESH_DONE", { done, total: workers.length, mode, dateOffset });
}

// ── Hors Tournée ─────────────────────────────────────────────
// لا يوجد wizard منفصل: الأزرار كلها على planning.planning مباشرة،
// وقائمة الزيارات المعلّقة تُقرأ من الحقل event_ids_in_validation_state.
async function _rpc_openHorsWizard(baseUrl, roundId) {
  await _rpc_call(baseUrl, {
    model: "planning.planning", method: "validate_events",
    args: [[roundId]], kwargs: {},
  });
  // نُبقي شكل الإرجاع كما هو متوقَّع من بقية الكود، لكن wizardId هنا
  // هو roundId نفسه ووizModel هو planning.planning دائماً.
  return { wizardId: roundId, wizModel: "planning.planning" };
}

// ── جلب قائمة الزبائن (من planning.planning مباشرة) ──────────
async function _rpc_fetchHorsClients(baseUrl, wizModel, wizardId) {
  const wiz = await _rpc_call(baseUrl, {
    model: "planning.planning", method: "read",
    args: [[wizardId], ["event_ids_in_validation_state"]],
    kwargs: {},
  }).catch(() => []);
  const rec = wiz?.[0] || {};
  const eventIds = rec.event_ids_in_validation_state || [];
  if (!eventIds.length) return { lines: [], lineModel: null };

  const rows = await _rpc_call(baseUrl, {
    model: "calendar.event", method: "read",
    args: [eventIds, ["id", "name", "partner_id", "start", "stop"]],
    kwargs: {},
  }).catch(() => []);
  return { lines: rows || [], lineModel: "calendar.event" };
}

// ── قبول/رفض زبون واحد ─────────────────────────────────────────
// accept_event / refuse_event على planning.planning بنفس توقيع الأزرار
// الجماعية: args:[[roundId], lineId] (roundId = wizardId هنا).
async function _rpc_acceptOneHors(baseUrl, wizModel, wizardId, lineId, lineModel) {
  return _rpc_call(baseUrl, {
    model: lineModel || "calendar.event", method: "accept_event",
    args: [[lineId]],
    kwargs: {},
  }, "card.acceptHors");
}

async function _rpc_refuseOneHors(baseUrl, wizModel, wizardId, lineId, lineModel) {
  return _rpc_call(baseUrl, {
    model: lineModel || "calendar.event", method: "refuse_event",
    args: [[lineId]],
    kwargs: {},
  }, "card.acceptHors");
}

// ── قبول كل الزبائن ─────────────────────────────────────────
async function _rpc_acceptHorsTournee(baseUrl, roundId) {
  const { wizardId, wizModel } = await _rpc_openHorsWizard(baseUrl, roundId);
  await _rpc_call(baseUrl, { model:"planning.planning", method:"accept_all_events", args:[[wizardId]], kwargs:{} }, "card.acceptHors");
}

// ── accept_all من wizard موجود مسبقاً ───────────────────────
async function _rpc_acceptAllHors(baseUrl, wizModel, wizardId) {
  await _rpc_call(baseUrl, { model:"planning.planning", method:"accept_all_events", args:[[wizardId]], kwargs:{} }, "card.acceptHors");
}

// ── رفض كل الزبائن ───────────────────────────────────────────
async function _rpc_refuseAllHors(baseUrl, wizModel, wizardId) {
  await _rpc_call(baseUrl, { model:"planning.planning", method:"refuse_all_events", args:[[wizardId]], kwargs:{} }, "card.acceptHors");
}

// ── call_button helper ────────────────────────────────────────
// permission (اختياري): نفس آلية _rpc_call — يُرسَل كهيدر X-App-Permission
// ليتحقق منه enforcePermission.js (يجب أيضًا حراسة /web/dataset/call_button
// على السيرفر، راجع تعليق مهم في هذا الرد).
async function _call_button(baseUrl, model, method, args, permission) {
  const headers = { "Content-Type": "application/json" };
  if (permission) headers["X-App-Permission"] = permission;
  const resp = await fetch("/api/web/dataset/call_button", {
    method: "POST", credentials: "include",
    headers,
    body: JSON.stringify({ jsonrpc:"2.0", method:"call", id:Date.now(),
      params: { model, method, args, kwargs:{} } }),
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const json = await resp.json().catch(() => ({}));
  if (json?.error) throw new Error(json.error?.data?.message || "Odoo error");
  return json.result;
}

async function _rpc_openPlanning(baseUrl, roundId)    { return _call_button(baseUrl, "planning.planning", "open_planning",  [[roundId]], "card.planningCtrl.open"); }
async function _rpc_closePlanning(baseUrl, roundId)   { return _call_button(baseUrl, "planning.planning", "close_planning", [[roundId]], "card.planningCtrl.close"); }
async function _rpc_closeVendorDay(baseUrl, roundId)  { return _call_button(baseUrl, "planning.planning", "btn_force_close_user_planning_event", [[roundId]], "card.planningCtrl.close"); }
async function _rpc_disableHorsZone(baseUrl, roundId) { return _call_button(baseUrl, "planning.planning", "disable_act_ouside_radius_button", [[roundId]], "card.allowHorsZone"); }
async function _rpc_enableHorsZone(baseUrl, roundId)  { return _call_button(baseUrl, "planning.planning", "enable_act_ouside_radius_button",  [[roundId]], "card.allowHorsZone"); }
async function _rpc_allowHorsZone(baseUrl, roundId)   { return _call_button(baseUrl, "planning.planning", "allow_act_ouside_radius_button",   [[roundId]], "card.allowHorsZone"); }

async function _rpc_closeAllPlannings(baseUrl, roundIds) {
  for (const roundId of roundIds) { try { await _rpc_closePlanning(baseUrl, roundId); } catch (_) {} }
}

// ── إنشاء دفعة ───────────────────────────────────────────────
async function _rpc_createPayment(baseUrl, fields, permission) {
  const perm = permission || "card.payment.create";
  const partners = await _rpc_call(baseUrl, {
    model:  "res.partner", method: "search_read",
    args:   [["|", ["ref", "=", fields.partnerRef], ["id", "=", parseInt(fields.partnerRef, 10) || 0]]],
    kwargs: { fields: ["id", "name"], limit: 1 },
  }, perm);
  if (!partners?.length) throw new Error(`Partenaire introuvable: ${fields.partnerRef}`);
  const partnerId = partners[0].id;
  const recordId = await _rpc_call(baseUrl, {
    model:  "account.payment", method: "create",
    args:   [{
      journal_id: fields.journalId, partner_id: partnerId,
      partner_type: "customer",
payment_type: fields.paymentType || "inbound",
      payment_method_id: 1, amount: parseFloat(fields.amount),
      payment_reference: fields.communication || false,
      user_id:     fields.odooUserId  || false,
      planning_id: fields.planningId  || false,
      payment_date: fields.paymentDate || new Date().toISOString().slice(0, 10),
      brand_id: 3,
    }],
    kwargs: {},
  }, perm);
  if (!recordId) throw new Error("Échec de la création");
  return recordId;
}

// ── جلب مدفوعات الجولة ───────────────────────────────────────
async function _rpc_fetchPayments(baseUrl, planningId) {
  const rows = await _rpc_call(baseUrl, {
    model:  "account.payment",
    method: "search_read",
    args:   [[["planning_id", "=", planningId]]],
    kwargs: {
      fields: [
        "id", "partner_id", "journal_id", "payment_type",
        "amount", "state", "payment_reference", "payment_date", "verified_state"
      ],
      limit: 100,
    },
  });
  return rows || [];
}

// ── Changement de journal d'un paiement (Encaissement) ─────────
// Utilisé pour: Banque ORN WF (SARL WAFA FAILE) → Caisse Vendeur Oran
// (SARL WAFA FAILE), uniquement quand le paiement est "Non vérifié"
// (contrôle déjà fait côté UI avant l'appel — voir renderer.js).
// resolveJournalId: cherche account.journal par name (+ société optionnelle
// company_id.name) — évite de coder un ID en dur (peut différer d'une base à l'autre).
async function _rpc_resolveJournalId(baseUrl, journalName, companyName) {
  const domain = companyName
    ? [["name", "=", journalName], ["company_id.name", "=", companyName]]
    : [["name", "=", journalName]];
  const rows = await _rpc_call(baseUrl, {
    model:  "account.journal", method: "search_read",
    args:   [domain],
    kwargs: { fields: ["id", "name"], limit: 1 },
  });
  return rows?.[0]?.id || null;
}

// ── Changer la tournée (planning_id) d'un ou plusieurs paiements ──
// Simple write sur account.payment.planning_id — sans toucher au client
// (pas de suppression/archivage de calendar.event ici, contrairement à
// changeBLTournee).
async function _rpc_changePaymentTournee(baseUrl, paymentId, newPlanningId) {
  const paymentIds = Array.isArray(paymentId) ? paymentId : [paymentId];
  if (!paymentIds.length) throw new Error("Aucun paiement sélectionné");

  const plannings = await _rpc_call(baseUrl, {
    model: "planning.planning", method: "read",
    args: [[newPlanningId], ["id", "name"]],
    kwargs: {},
  });
  const planning = plannings?.[0];
  if (!planning) throw new Error("Tournée introuvable");

  await _rpc_call(baseUrl, {
    model: "account.payment", method: "write",
    args: [paymentIds, { planning_id: newPlanningId }],
    kwargs: {},
  }, "card.showPayments.editJournal");

  return { planningId: newPlanningId, planningName: planning.name };
}

// ── Modifier le montant d'un paiement (compte, DA) ─────────────
// عند تعديل المبلغ يجب أولاً إعادة الدفعة إلى brouillon (Odoo يمنع الكتابة
// على amount في حالة posted)، ثم الكتابة، ثم إعادة تأكيدها (confirmer) تلقائيًا
// إن كانت مؤكدة أصلاً — كل هذا يحدث في الخلفية دون تدخّل المستخدم.
async function _rpc_changePaymentAmount(baseUrl, paymentId, newAmount) {
  const rows = await _rpc_call(baseUrl, {
    model: "account.payment", method: "read",
    args: [[paymentId], ["state"]],
    kwargs: {},
  });
  const wasPosted = rows?.[0]?.state === "posted";

  // 1. إعادة الدفعة لحالة brouillon (فقط إن كانت مؤكدة) لفتح إمكانية التعديل
  if (wasPosted) {
    await _rpc_call(baseUrl, {
      model: "account.payment", method: "action_draft",
      args: [[paymentId]],
      kwargs: {},
    }, "card.showPayments.editJournal");
  }

  // 2. كتابة المبلغ الجديد
  await _rpc_call(baseUrl, {
    model:  "account.payment", method: "write",
    args:   [[paymentId], { amount: newAmount }],
    kwargs: {},
  }, "card.showPayments.editJournal");

  // 3. إعادة تأكيد (confirmer) الدفعة تلقائيًا إن كانت مؤكدة قبل التعديل
  if (wasPosted) {
    await _rpc_call(baseUrl, {
      model: "account.payment", method: "action_post",
      args: [[paymentId]],
      kwargs: {},
    }, "card.showPayments.editJournal");
  }
}

// ── Modifier la référence (payment_reference) d'un paiement — même mécanique
// que _rpc_changePaymentAmount (cycle brouillon→écriture→confirmer auto) ──
async function _rpc_changePaymentName(baseUrl, paymentId, newName) {
  const rows = await _rpc_call(baseUrl, {
    model: "account.payment", method: "read",
    args: [[paymentId], ["state"]],
    kwargs: {},
  });
  const wasPosted = rows?.[0]?.state === "posted";

  if (wasPosted) {
    await _rpc_call(baseUrl, {
      model: "account.payment", method: "action_draft",
      args: [[paymentId]],
      kwargs: {},
    }, "card.showPayments.editJournal");
  }

  await _rpc_call(baseUrl, {
    model:  "account.payment", method: "write",
    args:   [[paymentId], { payment_reference: newName }],
    kwargs: {},
  }, "card.showPayments.editJournal");

  if (wasPosted) {
    await _rpc_call(baseUrl, {
      model: "account.payment", method: "action_post",
      args: [[paymentId]],
      kwargs: {},
    }, "card.showPayments.editJournal");
  }
}

// ── Modifier le client (partner_id) d'un paiement — même mécanique
// que _rpc_changePaymentAmount/_rpc_changePaymentName (cycle
// brouillon→écriture→confirmer auto). partnerRef accepte soit le ref
// (code client) soit l'id interne, comme _rpc_createPayment. ──
async function _rpc_changePaymentPartner(baseUrl, paymentId, partnerRef) {
  const partners = await _rpc_call(baseUrl, {
    model: "res.partner", method: "search_read",
    args:  [["|", ["ref", "=", partnerRef], ["id", "=", parseInt(partnerRef, 10) || 0]]],
    kwargs: { fields: ["id", "name"], limit: 1 },
  });
  if (!partners?.length) throw new Error(`Client introuvable: ${partnerRef}`);
  const partnerId = partners[0].id;

  const rows = await _rpc_call(baseUrl, {
    model: "account.payment", method: "read",
    args: [[paymentId], ["state"]],
    kwargs: {},
  });
  const wasPosted = rows?.[0]?.state === "posted";

  if (wasPosted) {
    await _rpc_call(baseUrl, {
      model: "account.payment", method: "action_draft",
      args: [[paymentId]],
      kwargs: {},
    }, "card.showPayments.editJournal");
  }

  await _rpc_call(baseUrl, {
    model:  "account.payment", method: "write",
    args:   [[paymentId], { partner_id: partnerId }],
    kwargs: {},
  }, "card.showPayments.editJournal");

  if (wasPosted) {
    await _rpc_call(baseUrl, {
      model: "account.payment", method: "action_post",
      args: [[paymentId]],
      kwargs: {},
    }, "card.showPayments.editJournal");
  }
  return { id: partnerId, name: partners[0].name };
}

async function _rpc_changePaymentJournal(baseUrl, paymentId, journalId) {
  return _rpc_call(baseUrl, {
    model:  "account.payment", method: "write",
    args:   [[paymentId], { journal_id: journalId }],
    kwargs: {},
  }, "card.showPayments.editJournal");
}

// ── Recherche produits ────────────────────────────────────────
async function _rpc_searchProducts(baseUrl, query) {
  return _rpc_call(baseUrl, {
    model: "product.product", method: "search_read",
    args:  [["|", ["name", "ilike", query], ["default_code", "ilike", query]]],
    kwargs: { fields: ["id", "name", "default_code"], limit: 15 },
  });
}

// ── Recherche produits par tokens (AND, multi-mots) ────────────
async function _rpc_searchProductsTokenized(baseUrl, query) {
  const tokens = String(query || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const domain = [];
  tokens.forEach(t => {
    domain.push("|", ["name", "ilike", t], ["default_code", "ilike", t]);
  });
  return _rpc_call(baseUrl, {
    model: "product.product", method: "search_read",
    args:  [domain],
    kwargs: { fields: ["id", "name", "default_code"], limit: 15 },
  });
}

// ── جلب قائمة منتجات Odoo (للفئات المخصصة / Custom Categories) ──
// ⚠️ نستعمل هنا "product.template" وليس "product.product" (المستعمل في
// searchProducts/searchProductsTokenized أعلاه): الفئات المخصصة تخزّن
// product_tmpl_id (منتج بمعناه العام، بدون تفرّع المتغيّرات) — فقراءة
// product.template تطابق تمامًا ما يُخزَّن في customCategories/*/productIds.
async function _rpc_fetchProductList(baseUrl) {
  const rows = await _rpc_call(baseUrl, {
    model:  "product.template",
    method: "search_read",
    args:   [[]],
    kwargs: { fields: ["id", "name", "categ_id"], limit: 0, order: "name asc" },
  });
  return Array.isArray(rows) ? rows : [];
}

// ── جلب قائمة بائعين Odoo (للفئات المخصصة / Custom Seller Categories) ──
// نفس نمط _rpc_fetchProductList أعلاه لكن على res.users: تُستعمل فئات
// البائعين المخصصة لتخزين sellerIds (= res.users id) بدل productIds.
async function _rpc_fetchSellerList(baseUrl) {
  // ⚠️ نتفادى قراءة حقل "name" على res.users: هذا الحقل مفوَّض (delegate) إلى
  // res.partner.name عبر _inherits، فطلبه يستدعي ضمنيًا صلاحية قراءة سجل
  // res.partner الخاص بكل مستخدم — وهو ما ترفضه قواعد الصلاحيات لمستخدمين
  // غير مرتبطين بنفس الفريق/الشركة (خطأ "L'opération demandée... rejetée").
  // "login" مخزّن مباشرة على res.users فلا يحتاج هذه الصلاحية الإضافية.
  // نجلب كل المستخدمين (نشطين وغير نشطين معًا) عبر active_test: false في
  // context، بدل تقييد domain على النشطين فقط — مستخدمون معطّلون قد يكونوا
  // مرجعيين في بيانات تاريخية (create_uid/user_id) أو ضمن فئات بائعين
  // مخصصة محفوظة سابقًا (sellerIds).
  const rows = await _rpc_call(baseUrl, {
    model:  "res.users",
    method: "search_read",
    args:   [[]],
    kwargs: { fields: ["id", "login", "active"], limit: 0, order: "login asc", context: { active_test: false } },
  });
  return Array.isArray(rows)
    ? rows.map(r => ({ id: r.id, name: r.login, active: r.active !== false }))
    : [];
}

// ── جلب قائمة قوائم أسعار Odoo (للفئات المخصصة / Custom Pricelist Categories) ──
// نفس نمط _rpc_fetchSellerList أعلاه لكن على product.pricelist: تُستعمل فئات
// قوائم الأسعار المخصصة لتخزين pricelistIds (= product.pricelist id).
async function _rpc_fetchPricelistList(baseUrl) {
  const rows = await _rpc_call(baseUrl, {
    model:  "product.pricelist",
    method: "search_read",
    args:   [[]],
    kwargs: { fields: ["id", "name"], limit: 0, order: "name asc" },
  });
  return Array.isArray(rows) ? rows : [];
}

// ── Ajout produit à la tournée ────────────────────────────────
async function _rpc_getPickingInfo(baseUrl, planningId) {
  const plannings = await _rpc_call(baseUrl, {
    model: "planning.planning", method: "read",
    args:  [[planningId], ["id","name","loading_picking_ids","lot_stock_id","fleet_vehicle_location_id","user_id","warehouse_ids"]],
    kwargs: {},
  });
  if (!plannings?.length) throw new Error("Planning introuvable");
  const planning = plannings[0];
  const lotStockId  = Array.isArray(planning.lot_stock_id) ? planning.lot_stock_id[0] : null;
  const deliveryIds = planning.loading_picking_ids || [];

  if (deliveryIds.length) {
    const pickings = await _rpc_call(baseUrl, {
      model: "stock.picking", method: "read",
      args:  [deliveryIds, ["id","name","location_id","location_dest_id","picking_type_id","partner_id","state"]],
      kwargs: {},
    });
    const draftPicking = (pickings || []).find(p => p.state === "draft");
    if (draftPicking) return { picking: draftPicking, lotStockId };
  }

  const warehouseId    = (planning.warehouse_ids || [])[0] || 19;
  const locationDestId = Array.isArray(planning.fleet_vehicle_location_id) ? planning.fleet_vehicle_location_id[0] : null;
  const partnerSearch  = await _rpc_call(baseUrl, {
    model: "res.partner", method: "search_read",
    args:  [[["user_ids", "in", [Array.isArray(planning.user_id) ? planning.user_id[0] : 0]]]],
    kwargs: { fields: ["id","name"], limit: 1 },
  });
  const partnerId = partnerSearch?.length ? partnerSearch[0].id : false;
  if (!locationDestId) throw new Error("Emplacement VAN introuvable");

  const ptypes = await _rpc_call(baseUrl, {
    model: "stock.picking.type", method: "search_read",
    args:  [[["warehouse_id","=",warehouseId],["code","=","internal"]]],
    kwargs: { fields: ["id","name"], limit: 1 },
  });
  if (!ptypes?.length) throw new Error("Type d'opération introuvable");
  const pickingTypeId = ptypes[0].id;

  const newPickingId = await _rpc_call(baseUrl, {
    model: "stock.picking", method: "create",
    args:  [{ picking_type_id: pickingTypeId, location_id: lotStockId,
               location_dest_id: locationDestId, partner_id: partnerId || false,
               origin: planning.name, warehouse_id: warehouseId }],
    kwargs: {},
  });
  if (!newPickingId) throw new Error("Échec création bon de chargement");

  await _rpc_call(baseUrl, {
    model: "planning.planning", method: "write",
    args:  [[planningId], { loading_picking_ids: [[4, newPickingId, false]] }],
    kwargs: {},
  });

  const newPickings = await _rpc_call(baseUrl, {
    model: "stock.picking", method: "read",
    args:  [[newPickingId], ["id","name","location_id","location_dest_id","picking_type_id","partner_id"]],
    kwargs: {},
  });
  return { picking: newPickings[0], lotStockId };
}

async function _rpc_addProductToRound(baseUrl, planningId, product, qtyCdn, qtyPiece) {
  const { picking, lotStockId } = await _rpc_getPickingInfo(baseUrl, planningId);
  const locationId     = lotStockId || (Array.isArray(picking.location_id) ? picking.location_id[0] : picking.location_id);
  const locationDestId = Array.isArray(picking.location_dest_id) ? picking.location_dest_id[0] : picking.location_dest_id;
  if (!picking.id) throw new Error("Aucun bon de chargement disponible");

  let packagingId = false, packagingQty = 1;
  if (qtyCdn > 0) {
    const packagings = await _rpc_call(baseUrl, {
      model: "product.packaging", method: "search_read",
      args:  [[["product_id","=",product.id]]],
      kwargs: { fields: ["id","qty"], limit: 1 },
    });
    if (packagings?.length) { packagingId = packagings[0].id; packagingQty = packagings[0].qty || 1; }
  }

  const totalQty = (qtyCdn * packagingQty) + (qtyPiece || 0);
  const moveName = product.default_code ? `[${product.default_code}] ${product.name}` : product.name;

  const result = await _rpc_call(baseUrl, {
    model: "planning.planning", method: "write",
    args:  [[planningId], {
      loading_move_ids: [[0, 0, {
        picking_id: picking.id, name: moveName, product_id: product.id,
        product_uom: 1, product_uom_qty: totalQty,
        packaging_quantity: qtyCdn || 0, product_packaging: packagingId || false,
        location_id: locationId, location_dest_id: locationDestId, additional: true,
      }]]
    }],
    kwargs: {},
  }, "card.addProduct.submit");
  if (!result) throw new Error("Échec création stock.move");
  return result;
}

// ── Stock final ───────────────────────────────────────────────
async function _rpc_fetchStockFinal(baseUrl, roundId) {
  const plannings = await _rpc_call(baseUrl, {
    model: "planning.planning", method: "read",
    args:  [[roundId], ["final_stock_line_ids", "name", "date_start"]], kwargs: {},
  }, "card.stockFinal");
if (!plannings?.length) throw new Error("Planning introuvable");
  const planning = plannings[0];
  const ref  = planning.name || "";
  const date = planning.date_start ? planning.date_start.slice(0, 10) : "";
  const lineIds = planning.final_stock_line_ids || [];
  if (!lineIds.length) {
    const empty = [];
    empty.ref = ref; empty.date = date;
    return empty;
  }

  const lines = await _rpc_call(baseUrl, {
    model: "planning.initial_final_stock_line", method: "read",
    args:  [lineIds, ["product_id", "product_uom_qty", "uom_id"]],
    kwargs: {},
  }, "card.stockFinal");

  const productIds = (lines || []).map(l =>
    Array.isArray(l.product_id) ? l.product_id[0] : l.product_id
  ).filter(Boolean);

  const pkgs = productIds.length ? await _rpc_call(baseUrl, {
    model: "product.packaging", method: "search_read",
    args:  [[["product_id", "in", productIds]]],
    kwargs: { fields: ["product_id", "name", "qty"], limit: 200 },
  }, "card.stockFinal").catch(() => []) : [];

  const packagingMap = {};
  (pkgs || []).forEach(p => {
    const pid = Array.isArray(p.product_id) ? p.product_id[0] : p.product_id;
    if (!packagingMap[pid]) packagingMap[pid] = { qty: p.qty || 1, name: p.name || "" };
  });

  const result = (lines || [])
    .filter(l => (l.product_uom_qty || 0) !== 0)
    .map(l => {
      const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
      const pkg = packagingMap[pid];
      return {
        name:          Array.isArray(l.product_id) ? l.product_id[1] : String(l.product_id),
        qty:           l.product_uom_qty || 0,
        packaging_qty: pkg?.qty || 0,
        packaging_name: pkg?.name || "",
      };
    });
  result.ref = ref; result.date = date;
  return result;
}

// ── Journal Stock (حركات المخزون بالجولة) ──────────────────────
async function _rpc_fetchJournalStock(baseUrl, roundId) {
  // جلب الحقول الأساسية من planning.planning
  const plannings = await _rpc_call(baseUrl, {
    model: "planning.planning", method: "read",
    args: [[roundId], [
      "initial_stock_line_ids",
      "final_stock_line_ids",
      "loading_picking_ids",
      "delivery_picking_ids",
      "stock_global_ledger",
    ]],
    kwargs: {},
  }, "card.journalStock");
  if (!plannings?.length) throw new Error("Planning introuvable");
  const plan = plannings[0];

  // ── Déchargement: عمود موجود جاهزاً داخل جدول Odoo (stock_global_ledger)
  // Article(0) | Stock initial(1) | Chargement(2) | Livraisons clients(3) |
  // Retours clients(4) | Déchargement(5) | Stock final(6)
  const dechargementByName = {};
  if (plan.stock_global_ledger) {
    try {
      const doc = new DOMParser().parseFromString(plan.stock_global_ledger, "text/html");
      doc.querySelectorAll("tbody tr").forEach(row => {
        const cells = row.querySelectorAll("td");
        if (cells.length < 6) return;
        const name = cells[0].textContent.trim();
        const dech = cells[5].textContent.trim();
        if (name && name.toLowerCase() !== "total") dechargementByName[name] = dech;
      });
    } catch (_) { /* ledger HTML absent/invalide → colonne vide */ }
  }

  const initialLineIds = plan.initial_stock_line_ids || [];
  const finalLineIds   = plan.final_stock_line_ids   || [];
  const loadingPickIds = plan.loading_picking_ids     || [];
  const delivPickIds   = plan.delivery_picking_ids    || [];

  // ── initial & final lines ──
  const initialLines = initialLineIds.length ? await _rpc_call(baseUrl, {
    model: "planning.initial_final_stock_line", method: "read",
    args: [initialLineIds, ["product_id", "product_uom_qty"]],
    kwargs: {},
  }).catch(() => []) : [];

  const finalLines = finalLineIds.length ? await _rpc_call(baseUrl, {
    model: "planning.initial_final_stock_line", method: "read",
    args: [finalLineIds, ["product_id", "product_uom_qty"]],
    kwargs: {},
  }).catch(() => []) : [];

  // ── loading stock.move ──
  const loadingMoves = loadingPickIds.length ? await _rpc_call(baseUrl, {
    model: "stock.picking", method: "read",
    args: [loadingPickIds, ["move_lines"]],
    kwargs: {},
  }).catch(() => []) : [];
  const loadingMoveIds = (loadingMoves || []).flatMap(p => p.move_lines || []);

  const loadMoveLines = loadingMoveIds.length ? await _rpc_call(baseUrl, {
    model: "stock.move", method: "read",
    args: [loadingMoveIds, ["product_id", "product_uom_qty", "packaging_quantity", "state"]],
    kwargs: {},
  }).catch(() => []) : [];

  // ── delivery stock.move (توزيع + استرجاع) ──
  const delivPickings = delivPickIds.length ? await _rpc_call(baseUrl, {
    model: "stock.picking", method: "read",
    args: [delivPickIds, ["move_lines", "picking_type_code", "state"]],
    kwargs: {},
  }).catch(() => []) : [];

  const returnPickIds = (delivPickings || []).filter(p => p.picking_type_code === "incoming").map(p => p.id);
  const delivMoveIds  = (delivPickings || []).filter(p => !returnPickIds.includes(p.id)).flatMap(p => p.move_lines || []);
  const returnMoveIds = (delivPickings || []).filter(p => returnPickIds.includes(p.id)).flatMap(p => p.move_lines || []);

  const delivMoveLines = delivMoveIds.length ? await _rpc_call(baseUrl, {
    model: "stock.move", method: "read",
    args: [delivMoveIds, ["product_id", "product_uom_qty", "packaging_quantity", "state"]],
    kwargs: {},
  }).catch(() => []) : [];

  const returnMoveLines = returnMoveIds.length ? await _rpc_call(baseUrl, {
    model: "stock.move", method: "read",
    args: [returnMoveIds, ["product_id", "product_uom_qty", "packaging_quantity", "state"]],
    kwargs: {},
  }).catch(() => []) : [];

  // ── جلب product.packaging لكل المنتجات ──
  const getPid  = l => Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
  const getName = l => Array.isArray(l.product_id) ? l.product_id[1] : String(l.product_id);

  const allLines = [
    ...(initialLines || []), ...(finalLines || []),
    ...(loadMoveLines || []), ...(delivMoveLines || []), ...(returnMoveLines || []),
  ];
  const allPids = [...new Set(allLines.map(getPid).filter(Boolean))];

  const pkgs = allPids.length ? await _rpc_call(baseUrl, {
    model: "product.packaging", method: "search_read",
    args: [[ ["product_id", "in", allPids] ]],
    kwargs: { fields: ["product_id", "name", "qty"], limit: 500 },
  }).catch(() => []) : [];

  // packagingMap: { pid → { qty, name } }  — premier packaging par produit
  const packagingMap = {};
  (pkgs || []).forEach(p => {
    const pid = Array.isArray(p.product_id) ? p.product_id[0] : p.product_id;
    if (!packagingMap[pid]) packagingMap[pid] = { qty: p.qty || 1, name: p.name || "" };
  });

  // ── تجميع حسب product_id ──
  const byProduct = {};
  const ensure = (pid, name) => {
    if (!byProduct[pid]) {
      const pkg = packagingMap[pid];
      byProduct[pid] = {
        name,
        pkgQty:   pkg?.qty  || 0,   // قطع في الحزمة
        pkgName:  pkg?.name || "",
        initial:  0, loading: 0, delivery: 0, returned: 0, final: 0,
        dechargement: "",          // نص جاهز من stock_global_ledger (Odoo)
      };
    }
  };

  // helper: أضف qty خام إلى حقل معين
  const add = (lines, field, doneOnly = false) => {
    (lines || [])
      .filter(l => !doneOnly || l.state === "done")
      .forEach(l => {
        const pid = getPid(l); if (!pid) return;
        ensure(pid, getName(l));
        byProduct[pid][field] += l.product_uom_qty || 0;
      });
  };

  add(initialLines,    "initial",  false);
  add(loadMoveLines,   "loading",  true);
  add(delivMoveLines,  "delivery", true);
  add(returnMoveLines, "returned", true);
  add(finalLines,      "final",    false);

  // ربط Déchargement (نص جاهز من Odoo) بكل منتج حسب نفس الاسم المعروض
  Object.values(byProduct).forEach(r => {
    r.dechargement = dechargementByName[r.name] || "";
  });

  return Object.values(byProduct)
    .filter(r => r.initial > 0 || r.loading > 0 || r.delivery > 0 || r.returned > 0 || r.final > 0 || r.dechargement)
    .sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));
}

// ── Bon de chargement : quantités par produit sur le(s) picking(s) de
// chargement de la tournée (planning.planning.loading_picking_ids).
// Retourne les lignes groupées par picking, puis par catégorie d'article.
async function _rpc_fetchBonChargement(baseUrl, roundId) {
  const plannings = await _rpc_call(baseUrl, {
    model: "planning.planning", method: "read",
    args: [[roundId], ["loading_picking_ids", "name"]],
    kwargs: {},
  }, "card.bonChargement");
  if (!plannings?.length) throw new Error("Planning introuvable");
  const plan = plannings[0];
  const loadingPickIds = plan.loading_picking_ids || [];
  if (!loadingPickIds.length) return [];

  const pickings = await _rpc_call(baseUrl, {
    model: "stock.picking", method: "read",
    args: [loadingPickIds, ["name", "state", "scheduled_date", "move_lines"]],
    kwargs: {},
  });

  const allMoveIds = (pickings || []).flatMap(p => p.move_lines || []);
  const allMoveLines = allMoveIds.length ? await _rpc_call(baseUrl, {
    model: "stock.move", method: "read",
    args: [allMoveIds, ["product_id", "product_uom_qty", "packaging_quantity", "reserved_availability", "packaging_quantity_reserved", "state", "is_initial_demand_editable", "is_initial_demand_packaging_editable"]],
    kwargs: {},
  }) : [];
  const moveById = {};
  (allMoveLines || []).forEach(m => { moveById[m.id] = m; });

  const getPid  = l => Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
  const getName = l => Array.isArray(l.product_id) ? l.product_id[1] : String(l.product_id);
  const allPids = [...new Set((allMoveLines || []).map(getPid).filter(Boolean))];

  // ── catégorie d'article par produit (product.template.categ_id via product_tmpl_id) ──
  const products = allPids.length ? await _rpc_call(baseUrl, {
    model: "product.product", method: "read",
    args: [allPids, ["categ_id"]],
    kwargs: {},
  }).catch(() => []) : [];
  const categByPid = {};
  (products || []).forEach(p => {
    categByPid[p.id] = Array.isArray(p.categ_id) ? p.categ_id[1] : "Sans catégorie";
  });

  // نسبة التعبئة (عدد القطع في كرتون CND واحد) — نفس مصدر مودل Ajouter produit
  const allPackagings = allPids.length ? await _rpc_call(baseUrl, {
    model: "product.packaging", method: "search_read",
    args: [[["product_id", "in", allPids]]],
    kwargs: { fields: ["product_id", "qty"], limit: 500 },
  }).catch(() => []) : [];
  const packagingRatioByPid = {};
  (allPackagings || []).forEach(pk => {
    const pid = Array.isArray(pk.product_id) ? pk.product_id[0] : pk.product_id;
    if (!(pid in packagingRatioByPid)) packagingRatioByPid[pid] = pk.qty || 0;
  });

  return (pickings || []).map(p => {
    const byProduct = {};
    (p.move_lines || []).forEach(mid => {
      const l = moveById[mid]; if (!l) return;
      const pid = getPid(l); if (!pid) return;
      if (!byProduct[pid]) {
        byProduct[pid] = {
          name: getName(l),
          categ: categByPid[pid] || "Sans catégorie",
          demande: 0, cnd: 0, reserve: 0, cndReserve: 0, moveIds: [],
          qtyEditable: !!l.is_initial_demand_editable,
          cndEditable: !!l.is_initial_demand_packaging_editable,
          packagingRatio: packagingRatioByPid[pid] || 0,
        };
      }
      byProduct[pid].demande    += l.product_uom_qty || 0;
      byProduct[pid].cnd        += l.packaging_quantity || 0;
      byProduct[pid].reserve    += l.reserved_availability || 0;
      byProduct[pid].cndReserve += l.packaging_quantity_reserved || 0;
      byProduct[pid].moveIds.push(mid);
    });

    // ── grouper par catégorie ──
    const byCateg = {};
    Object.values(byProduct).forEach(row => {
      if (!byCateg[row.categ]) byCateg[row.categ] = [];
      byCateg[row.categ].push(row);
    });
    const categories = Object.keys(byCateg)
      .sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }))
      .map(categ => ({
        categ,
        lines: byCateg[categ].sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" })),
      }));

    return { id: p.id, name: p.name, state: p.state, scheduled_date: p.scheduled_date, categories };
  });
}

// ── جلب زبائن مسار (route) معيّن + أيام الزيارة، عبر الجدول الوسيط
// planning.template.event (نفس الموديل المستعمل في _rpc_searchPartners).
// ⚠️ لا نحدّد kwargs.fields عمدًا (نتركها فارغة) لنحصل على كل الحقول
// المتوفرة على الموديل دفعة واحدة، بما فيها حقل "يوم الزيارة" الذي لم يُؤكَّد
// اسمه التقني بعد — يُستعمل هذا أولًا للتشخيص عبر Console، ثم يُحدَّد اسم
// الحقل النهائي بدقة ويُستبدل fields:[] بقائمة صريحة.
async function _rpc_fetchRouteCustomers(baseUrl, routeId) {
  if (!routeId) return [];
  const rows = await _rpc_call(baseUrl, {
    model:  "planning.template.event",
    method: "search_read",
    args:   [[["planning_template_id", "=", routeId]]],
    kwargs: { limit: 500 }, // بدون fields: يرجع Odoo كل الحقول تلقائيًا
  });
  console.log("[rpc] planning.template.event rows (route " + routeId + "):", rows);
  if (!Array.isArray(rows) || !rows.length) return [];

  // ref الزبون: حقل "ref" الحقيقي على res.partner نفسه (رقم/كود الزبون)،
  // وليس partner_id[0] (الذي هو الـID الداخلي في Odoo فقط، وليس الـref).
  const partnerIds = [...new Set(rows.map(r => Array.isArray(r.partner_id) ? r.partner_id[0] : null).filter(Boolean))];
  let refByPartnerId = {};
  if (partnerIds.length) {
    try {
      const partnerRows = await _rpc_call(baseUrl, {
        model: "res.partner", method: "search_read",
        args: [[["id", "in", partnerIds]]],
        kwargs: { fields: ["id", "ref"], limit: 1000 },
      });
      (partnerRows || []).forEach(p => { refByPartnerId[p.id] = p.ref || ""; });
    } catch (e) {
      console.warn("[rpc] échec chargement ref partenaires:", e.message);
    }
  }
  return rows.map(r => ({
    ...r,
    _partnerRef: Array.isArray(r.partner_id) ? (refByPartnerId[r.partner_id[0]] || "") : "",
  }));
}

// ── تشخيص: fields_get على planning.template.event — لتحديد الاسم التقني
// الدقيق لحقول "يوم الزيارة" و"أسبوع الزيارة" (S1..S4 في دورة 4 أسابيع)،
// بدل التخمين. يُستدعى من Console:
//   await rpcController.debugInspectPlanningEventFields(getOdooBase())
async function _rpc_debugInspectPlanningEventFields(baseUrl) {
  let allFields;
  try {
    allFields = await _rpc_call(baseUrl, {
      model: "planning.template.event", method: "fields_get", args: [],
      kwargs: { attributes: ["string", "type", "relation", "selection"] },
    });
  } catch (e) {
    console.error("[rpc debug] fields_get فشل على planning.template.event:", e.message);
    return null;
  }
  console.log("[rpc debug] كل حقول planning.template.event:", allFields);
  const re = /day|jour|week|semaine|dow/i;
  const candidates = {};
  for (const [name, def] of Object.entries(allFields || {})) {
    if (re.test(name) || re.test(def.string || "")) candidates[name] = def;
  }
  console.log("[rpc debug] حقول مرشّحة ليوم/أسبوع الزيارة:", candidates);

  // إن وُجد visit_days_ids (one2many)، افحص موديله الفرعي أيضًا مباشرة —
  // هو الأرجح لاحتواء يوم الزيارة الفعلي.
  const subModel = candidates.visit_days_ids?.relation;
  if (subModel) {
    try {
      const subFields = await _rpc_call(baseUrl, {
        model: subModel, method: "fields_get", args: [],
        kwargs: { attributes: ["string", "type", "relation", "selection"] },
      });
      console.log(`[rpc debug] كل حقول ${subModel} (الموديل الفرعي لـvisit_days_ids):`, subFields);
    } catch (e) {
      console.error(`[rpc debug] fields_get فشل على ${subModel}:`, e.message);
    }
  }
  return candidates;
}


async function _rpc_searchPartners(baseUrl, term, routeIds = []) {
  const tokens = String(term || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const nameDomain = [];
  tokens.forEach(t => nameDomain.push(["name", "ilike", t]));

  // المرحلة 1: ضمن routes محفوظة بالإعدادات (عبر الجدول الوسيط planning.template.event)
  if (routeIds && routeIds.length) {
    const partnerNameDomain = [];
    tokens.forEach(t => partnerNameDomain.push(["partner_id.name", "ilike", t]));
    const domain1 = [["planning_template_id", "in", routeIds], ...partnerNameDomain];
    const rows1 = await _rpc_call(baseUrl, {
      model: "planning.template.event", method: "search_read",
      args: [domain1],
      kwargs: { fields: ["partner_id", "planning_template_id"], limit: 20 },
    });
    if (rows1 && rows1.length) {
      const byPartner = new Map();
      for (const r of rows1) {
        if (!r.partner_id) continue;
        const pid = r.partner_id[0];
        const pname = r.partner_id[1];
        const routeId = r.planning_template_id ? r.planning_template_id[0] : null;
        if (!byPartner.has(pid)) {
          byPartner.set(pid, { fullName: pname, ref: String(pid), matchedRouteIds: [] });
        }
        if (routeId != null && !byPartner.get(pid).matchedRouteIds.includes(routeId)) {
          byPartner.get(pid).matchedRouteIds.push(routeId);
        }
      }
      let unique = Array.from(byPartner.values()).slice(0, 10);

      // تحقق customer_rank > 0 لمن نتج عن المرحلة 1
      if (unique.length) {
        const ids = unique.map(p => parseInt(p.ref, 10));
        const validRows = await _rpc_call(baseUrl, {
          model: "res.partner", method: "search_read",
          args: [[["id", "in", ids], ["customer_rank", ">", 0]]],
          kwargs: { fields: ["id"] },
        });
        const validIds = new Set((validRows || []).map(r => r.id));
        unique = unique.filter(p => validIds.has(parseInt(p.ref, 10)));
      }

      if (unique.length) return unique;
    }
  }

  // المرحلة 2: بحث عام بدون قيد planning_template_ids
  const domain2 = [["customer_rank", ">", 0], ...nameDomain];
  const rows2 = await _rpc_call(baseUrl, {
    model: "res.partner", method: "search_read",
    args: [domain2],
    kwargs: { fields: ["id", "name", "ref"], limit: 10 },
  });
  return (rows2 || []).map(r => ({ fullName: r.name, ref: r.ref || String(r.id) }));
}

// ── جلب route (planning.template) بالاسم ────────────────────────
async function _rpc_resolveRouteByName(baseUrl, name) {
  const rows = await _rpc_call(baseUrl, {
    model: "planning.template", method: "search_read",
    args: [[["name", "=", name]]],
    kwargs: { fields: ["id", "name"], limit: 1 },
  });
  return rows && rows.length ? { id: rows[0].id, name: rows[0].name } : null;
}
// ── بحث routes (planning.template) للـ autocomplete ────────────
async function _rpc_searchRoutes(baseUrl, term) {
  const t = String(term || "").trim();
  if (!t) return [];
  const domain = /^\d+$/.test(t) ? [["id", "=", parseInt(t, 10)]] : [["name", "ilike", t]];
  const rows = await _rpc_call(baseUrl, {
    model: "planning.template", method: "search_read",
    args: [domain],
    kwargs: { fields: ["id", "name"], limit: 8 },
  });
  return rows || [];
}

// ── جلب كل routes (planning.template) بدون قيد نصي — تُستخدم لعرض
// قسم "Route" الجديد (كروت كل الـroutes المتوفرة) ────────────────
async function _rpc_fetchAllRoutes(baseUrl) {
  const rows = await _rpc_call(baseUrl, {
    model: "planning.template", method: "search_read",
    args: [[]],
    kwargs: { fields: ["id", "name"], order: "name asc" },
  });
  return rows || [];
}

// ── إضافة زبون لجولة ─────────────────────────────────────────
async function _rpc_addClientToRound(baseUrl, roundId, partnerRef, mode) {
  const partners = await _rpc_call(baseUrl, {
    model: "res.partner", method: "search_read",
    args: [["|", ["ref", "=", partnerRef], ["id", "=", parseInt(partnerRef, 10) || 0]]],
    kwargs: { fields: ["id", "name", "ref"], limit: 1 },
  });
  if (!partners?.length) throw new Error(`Client introuvable (réf: ${partnerRef})`);
  const partner = partners[0];

  const plannings = await _rpc_call(baseUrl, {
    model: "planning.planning", method: "read",
    args: [[roundId], ["id", "name", "date_start", "date_end"]],
    kwargs: {},
  });
  if (!plannings?.length) throw new Error("Tournée introuvable");
  const planning = plannings[0];

  const dateStr = planning.date_start?.slice(0, 10) || "";
  const dayStr  = dateStr.slice(8, 10);

  const eventId = await _rpc_call(baseUrl, {
    model: "calendar.event", method: "create",
    args: [{
      name:                partner.name,
      partner_customer_id: partner.id,
      start:               dateStr,
      stop:                (planning.date_end || planning.date_start)?.slice(0, 10) || dateStr,
      planning_id:         parseInt(roundId, 10),
      in_template:         false,
      day:                 dayStr,
      date:                dateStr,
    }],
    kwargs: {},
  }, "card.addClient.submit");
  if (!eventId) throw new Error("Échec création visite");
  return { eventId, partnerName: partner.name, partnerId: partner.id };
}

// ── حذف زبون/زبائن من تورنيه ─────────────────────────────────
// الخطوة 1 (إلزامية): soft-delete عبر write active=false — تعمل حتى
// مع صلاحيات محدودة (write فقط).
// الخطوة 2 (محاولة إضافية، صامتة): unlink حقيقي — إذا نجحت الصلاحية
// يُحذف السجل نهائيًا (يختفي حتى من تطبيقات تتجاهل active)؛ إذا فشلت
// (رفض صلاحية) تُتجاهل بصمت ويبقى فقط الأرشفة من الخطوة 1، دون كسر العملية.
async function _rpc_deleteClientFromRound(baseUrl, eventIds) {
  const ids = (Array.isArray(eventIds) ? eventIds : [eventIds]).map(id => parseInt(id, 10)).filter(Boolean);
  if (!ids.length) throw new Error("Aucun client sélectionné");

  const ok = await _rpc_call(baseUrl, {
    model: "calendar.event", method: "write",
    args: [ids, { active: false }],
    kwargs: {},
  }, "card.deleteClient.submit");
  if (!ok) throw new Error("Échec suppression du client");

  let hardDeleted = false;
  try {
    hardDeleted = await _rpc_call(baseUrl, {
      model: "calendar.event", method: "unlink",
      args: [ids],
      kwargs: {},
    }, "card.deleteClient.submit");
  } catch (_) {
    // صلاحية unlink مرفوضة — لا مشكلة، السجل يبقى مؤرشفًا (active=false)
  }
  return { archived: true, hardDeleted: !!hardDeleted };
}

// ── جلب زبائن تورنيه لغرض الحذف — search_read مباشر على calendar.event
// بالدومين planning_id فقط (بدون قراءة planning.planning بالـ id، لتفادي
// رفض ir.rule على بعض الحسابات) ───────────────────────────────
async function _rpc_fetchRoundClientsForDelete(baseUrl, roundId) {
  const rows = await _rpc_call(baseUrl, {
    model: "calendar.event", method: "search_read",
    args: [[["planning_id", "=", parseInt(roundId, 10)]]],
    kwargs: { fields: ["id", "partner_customer_id", "visited"], order: "sequence asc", limit: 300 },
  });
  return (rows || [])
    .filter(r => r.partner_customer_id)
    .map(r => ({
      id: r.id,
      name: Array.isArray(r.partner_customer_id) ? r.partner_customer_id[1] : "",
      visited: r.visited,
    }));
}

// ── إضافة زبون إلى route (planning.template.event) مع اختيار
// الأسبوع/الأيام — ينشئ صفًّا واحدًا فيه w{أسبوع}{يوم}=true لكل تركيبة
// (أسبوع × يوم) مختارة.
async function _rpc_addClientToRoute(baseUrl, routeId, partnerRef, weeks, days) {
  const partners = await _rpc_call(baseUrl, {
    model: "res.partner", method: "search_read",
    args: [["|", ["ref", "=", partnerRef], ["id", "=", parseInt(partnerRef, 10) || 0]]],
    kwargs: { fields: ["id", "name", "ref"], limit: 1 },
  });
  if (!partners?.length) throw new Error(`Client introuvable (réf: ${partnerRef})`);
  const partner = partners[0];

  const vals = {
    planning_template_id: parseInt(routeId, 10),
    partner_id: partner.id,
  };
  (weeks || []).forEach(w => (days || []).forEach(d => { vals[`w${w}${d}`] = true; }));

  const eventId = await _rpc_call(baseUrl, {
    model: "planning.template.event", method: "create",
    args: [vals],
    kwargs: {},
  }, "card.addRouteClient.submit");
  if (!eventId) throw new Error("Échec ajout client à la route");
  return { eventId, partnerName: partner.name, partnerId: partner.id };
}

// ── ثوابت محلية لأسماء حقول w{أسبوع}{يوم} (نفس بنية planning.template.event
// المستخدمة أعلاه في addClientToRoute) — أسماء مختلفة عن ثوابت app.js
// (_ROUTE_WEEKS/_ROUTE_DAYS) عمدًا لتفادي تضارب إعلانات const بين ملفين
// يُحمَّلان كـ scripts عادية (نفس النطاق العام).
const _RC_WEEKS = [1, 2, 3, 4];
const _RC_DAYS  = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// ── تعديل جدول زيارة زبون/زبائن route — استبدال كامل (وليس إضافة):
// تُعاد كتابة كل الـ28 حقل boolean دفعة واحدة لكل eventIds (write جماعي)،
// المختار true والباقي false. تُرجع كائن القيم المكتوبة كي تُطبَّق محليًا
// على الصفوف بدل إعادة الجلب.
async function _rpc_updateRouteClientSchedule(baseUrl, eventIds, weeks, days) {
  const ids = (eventIds || []).map(id => parseInt(id, 10)).filter(Boolean);
  if (!ids.length) throw new Error("Aucun client sélectionné");
  if (!(weeks || []).length || !(days || []).length) throw new Error("Semaine(s)/Jour(s) requis");

  const vals = {};
  _RC_WEEKS.forEach(w => _RC_DAYS.forEach(d => {
    vals[`w${w}${d}`] = weeks.includes(w) && days.includes(d);
  }));

  const ok = await _rpc_call(baseUrl, {
    model: "planning.template.event", method: "write",
    args: [ids, vals],
    kwargs: {},
  }, "card.editRouteClient.submit");
  if (!ok) throw new Error("Échec mise à jour du jour de visite");
  return vals;
}

// ── حذف زبون/زبائن من route (unlink صف planning.template.event) ─
async function _rpc_deleteRouteClients(baseUrl, eventIds) {
  const ids = (eventIds || []).map(id => parseInt(id, 10)).filter(Boolean);
  if (!ids.length) throw new Error("Aucun client sélectionné");
  const ok = await _rpc_call(baseUrl, {
    model: "planning.template.event", method: "unlink",
    args: [ids],
    kwargs: {},
  }, "card.deleteRouteClient.submit");
  if (!ok) throw new Error("Échec suppression");
  return true;
}

// ── إيجاد route(s) الحالية لزبون معيّن (عبر planning.template.event) —
// تُرجع الصفوف الخام + اسم الـ route الأول (عادةً زبون في route واحدة).
async function _rpc_findClientRoute(baseUrl, partnerId) {
  const id = parseInt(partnerId, 10);
  if (!id) return null;
  const rows = await _rpc_call(baseUrl, {
    model: "planning.template.event", method: "search_read",
    args: [[["partner_id", "=", id]]],
    kwargs: { limit: 200 },
  });
  if (!Array.isArray(rows) || !rows.length) return null;

  const routeId = Array.isArray(rows[0].planning_template_id) ? rows[0].planning_template_id[0] : rows[0].planning_template_id;
  const routeName = Array.isArray(rows[0].planning_template_id) ? rows[0].planning_template_id[1] : "";
  const eventIds = rows.map(r => r.id);

  const weeksSet = new Set();
  const daysSet = new Set();
  rows.forEach(r => {
    _RC_WEEKS.forEach(w => _RC_DAYS.forEach(d => { if (r[`w${w}${d}`] === true) { weeksSet.add(w); daysSet.add(d); } }));
  });

  return {
    routeId,
    routeName,
    eventIds,
    weeks: [...weeksSet],
    days: [...daysSet],
  };
}

// ── بحث ضمن زبائن route واحدة فقط (وليس كل زبائن Odoo) — نفس منطق
// البحث الحالي: يتجاهل الترتيب والمسافات (tokens، كل توكن يجب أن يطابق
// الاسم أو الـref). تُطبَّق محليًا على صفوف مُحمَّلة مسبقًا عبر
// fetchRouteCustomers، دون طلب شبكة إضافي لكل ضغطة مفتاح.
function _rpc_filterRouteClients(rows, query) {
  const tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  return (rows || []).filter(r => {
    const ref  = String(r._partnerRef || "").toLowerCase();
    const name = (Array.isArray(r.partner_id) ? r.partner_id[1] : "").toLowerCase();
    return tokens.every(t => ref.includes(t) || name.includes(t));
  });
}

// ── بحث زبائن بالاسم في Odoo ──────────────────────────────────
async function _rpc_searchClientsByName(baseUrl, name) {
  const tokens = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const domain = [["customer_rank", ">", 0]];
  tokens.forEach(t => domain.push("|", ["name", "ilike", t], ["ref", "ilike", t]));
  const rows = await _rpc_call(baseUrl, {
    model: "res.partner", method: "search_read",
    args: [domain],
    kwargs: { fields: ["id", "name", "ref"], limit: 10 },
  });
  return (rows || []).map(r => ({ id: r.id, fullName: r.name, ref: r.ref || "" }));
}
async function _rpc_checkAvailability(baseUrl, pickingId) {
  return _rpc_call(baseUrl, {
    model: "stock.picking", method: "action_assign",
    args: [[pickingId]],
    kwargs: { context: { from_button: true } },
  });
}

// ── إجراء حالة عام على stock.picking (action_confirm / action_assign / button_validate / action_cancel) ──
async function _rpc_pickingAction(baseUrl, pickingId, method, context = {}) {
  return await _rpc_call(baseUrl, {
    model: "stock.picking", method,
    args: [[pickingId]], kwargs: { context },
  }, "card.bonChargement");
}

// ── تعديل الكمية (Quantity) وCND — عبر stock.picking.write بأمر one2many
// (1, moveId, vals) على move_ids_without_package، بنفس ما يفعله فورم Odoo،
// لأن الكتابة المباشرة على stock.move تُلغى لاحقاً بإعادة حساب الفورم.
// ⚠️ لا نُرسل إلا الحقول المسموح بتعديلها فعليًا (is_initial_demand_editable /
// is_initial_demand_packaging_editable) — إرسال product_uom_qty حين تكون غير
// قابلة للتعديل يجعل Odoo يعيد حسابها تلقائيًا من packaging_quantity، فتبدو
// وكأنها "رجعت" لقيمتها الأصلية ──
async function _rpc_updateMoveQty(baseUrl, pickingId, moveId, vals, name) {
  const writeVals = { ...vals };
  if (name) writeVals.name = name;
  return _rpc_call(baseUrl, {
    model: "stock.picking", method: "write",
    args: [[pickingId], { move_ids_without_package: [[1, moveId, writeVals]] }],
    kwargs: {},
  }, "card.bonChargement");
}

// ── إعادة جلب بيانات bon de chargement لِـ picking واحد فقط (بعد إجراء حالة) ──
// يعيد نفس شكل الكائن الذي يُنتِجه _rpc_fetchBonChargement لكل عنصر واحد فقط.
async function _rpc_fetchPickingDetail(baseUrl, pickingId) {
  const pickings = await _rpc_call(baseUrl, {
    model: "stock.picking", method: "read",
    args: [[pickingId], ["name", "state", "scheduled_date", "move_lines"]],
    kwargs: {},
  });
  const p = pickings?.[0];
  if (!p) throw new Error("Picking introuvable");

  const moveIds = p.move_lines || [];
  const moveLines = moveIds.length ? await _rpc_call(baseUrl, {
    model: "stock.move", method: "read",
    args: [moveIds, ["product_id", "product_uom_qty", "packaging_quantity", "reserved_availability", "packaging_quantity_reserved", "state", "is_initial_demand_editable", "is_initial_demand_packaging_editable"]],
    kwargs: {},
  }) : [];

  const getPid  = l => Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
  const getName = l => Array.isArray(l.product_id) ? l.product_id[1] : String(l.product_id);
  const pids = [...new Set((moveLines || []).map(getPid).filter(Boolean))];

  const products = pids.length ? await _rpc_call(baseUrl, {
    model: "product.product", method: "read",
    args: [pids, ["categ_id"]],
    kwargs: {},
  }).catch(() => []) : [];
  const categByPid = {};
  (products || []).forEach(pr => {
    categByPid[pr.id] = Array.isArray(pr.categ_id) ? pr.categ_id[1] : "Sans catégorie";
  });

  // نسبة التعبئة الحقيقية (عدد القطع في كرتون CND واحد) — من product.packaging،
  // نفس المصدر الذي يعتمده مودل "Ajouter produit". هذه هي مرجعية التحويل
  // بين CND وQuantity، وليست مُشتقة من القيم الحالية (التي قد تكون CND = 0).
  const packagings = pids.length ? await _rpc_call(baseUrl, {
    model: "product.packaging", method: "search_read",
    args: [[["product_id", "in", pids]]],
    kwargs: { fields: ["product_id", "qty"], limit: 500 },
  }).catch(() => []) : [];
  const packagingRatioByPid = {};
  (packagings || []).forEach(pk => {
    const pid = Array.isArray(pk.product_id) ? pk.product_id[0] : pk.product_id;
    if (!(pid in packagingRatioByPid)) packagingRatioByPid[pid] = pk.qty || 0;
  });

  const byProduct = {};
  (moveLines || []).forEach(l => {
    const pid = getPid(l); if (!pid) return;
    if (!byProduct[pid]) {
      byProduct[pid] = {
        name: getName(l),
        categ: categByPid[pid] || "Sans catégorie",
        demande: 0, cnd: 0, reserve: 0, cndReserve: 0, moveIds: [],
        qtyEditable: !!l.is_initial_demand_editable,
        cndEditable: !!l.is_initial_demand_packaging_editable,
        packagingRatio: packagingRatioByPid[pid] || 0,
      };
    }
    byProduct[pid].demande    += l.product_uom_qty || 0;
    byProduct[pid].cnd        += l.packaging_quantity || 0;
    byProduct[pid].reserve    += l.reserved_availability || 0;
    byProduct[pid].cndReserve += l.packaging_quantity_reserved || 0;
    byProduct[pid].moveIds.push(l.id);
  });

  const byCateg = {};
  Object.values(byProduct).forEach(row => {
    if (!byCateg[row.categ]) byCateg[row.categ] = [];
    byCateg[row.categ].push(row);
  });
  const categories = Object.keys(byCateg)
    .sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }))
    .map(categ => ({
      categ,
      lines: byCateg[categ].sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" })),
    }));

  return { id: p.id, name: p.name, state: p.state, scheduled_date: p.scheduled_date, categories };
}

async function _rpc_addBLLine(baseUrl, pickingId, productId, qty, cdn, packagingId) {
  // جلب location_id و location_dest_id من الـ BL
  const picks = await _rpc_call(baseUrl, {
    model: "stock.picking", method: "read",
    args: [[pickingId], ["location_id", "location_dest_id", "picking_type_id"]],
    kwargs: {},
  });
  const pick         = picks?.[0] || {};
  const locationId     = Array.isArray(pick.location_id)      ? pick.location_id[0]      : pick.location_id      || 8;
  const locationDestId = Array.isArray(pick.location_dest_id) ? pick.location_dest_id[0] : pick.location_dest_id || 5;
  const pickingTypeId  = Array.isArray(pick.picking_type_id)  ? pick.picking_type_id[0]  : pick.picking_type_id  || false;

  return _rpc_call(baseUrl, {
    model: "stock.move", method: "create",
    args: [{
      picking_id:         pickingId,
      product_id:         productId,
      product_uom_qty:    qty,
      product_uom:        1,
      packaging_quantity: cdn || 0,
      product_packaging:  packagingId || false,
      name:               "/",
      location_id:        locationId,
      location_dest_id:   locationDestId,
      picking_type_id:    pickingTypeId,
    }],
    kwargs: {},
  });
}
async function _rpc_fetchBLLines(baseUrl, pickingId) {
  const picks = await _rpc_call(baseUrl, {
    model: "stock.picking", method: "read",
    args: [[pickingId], ["move_lines"]],
    kwargs: {},
  });
  const moveIds = picks?.[0]?.move_lines || [];
  if (!moveIds.length) return [];
  const lines = await _rpc_call(baseUrl, {
    model: "stock.move", method: "read",
    args: [moveIds, ["product_id", "product_uom_qty", "quantity_done", "product_uom", "packaging_quantity", "product_packaging", "sale_line_id"]],
    kwargs: {},
  });
// جلب أسعار السطور بدون sale_line_id من pricelist أو product
  const noSolLines = (lines || []).filter(l => !l.sale_line_id || (Array.isArray(l.sale_line_id) && !l.sale_line_id[0]));
  if (noSolLines.length) {
    const productIds = noSolLines.map(l => Array.isArray(l.product_id) ? l.product_id[0] : l.product_id).filter(Boolean);
    if (productIds.length) {
      try {
        const priceData = await _rpc_call(baseUrl, {
          model: "product.product", method: "read",
          args: [productIds, ["id", "lst_price"]],
          kwargs: {},
        });
        const priceMap = {};
        (priceData || []).forEach(p => { priceMap[p.id] = p.lst_price; });
        noSolLines.forEach(l => {
          const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
          l._price_subtotal = (priceMap[pid] || 0) * (l.product_uom_qty || 0);
        });
      } catch(_) {}
    }
  }

  const saleLineIds = (lines || []).map(l => Array.isArray(l.sale_line_id) ? l.sale_line_id[0] : l.sale_line_id).filter(Boolean);
  if (saleLineIds.length) {
    const solData = await _rpc_call(baseUrl, {
      model: "sale.order.line", method: "read",
      args: [saleLineIds, ["id", "price_subtotal", "price_unit", "product_uom_qty"]],
      kwargs: {},
    });
    const solMap = {};
    (solData || []).forEach(s => { solMap[s.id] = s; });
    (lines || []).forEach(l => {
      const solId = Array.isArray(l.sale_line_id) ? l.sale_line_id[0] : l.sale_line_id;
      if (solId && solMap[solId]) {
        l._price_subtotal = solMap[solId].price_subtotal;
        l._price_unit     = solMap[solId].price_unit;
      }
    });
  }
// جلب عدد القطع في كل علبة
  const productIds = (lines || []).map(l => Array.isArray(l.product_id) ? l.product_id[0] : l.product_id).filter(Boolean);
  if (productIds.length) {
    const packagings = await _rpc_call(baseUrl, {
      model: "product.packaging", method: "search_read",
      args: [[["product_id", "in", productIds]]],
      kwargs: { fields: ["product_id", "qty"], limit: 200 },
    });
    const packMap = {};
    (packagings || []).forEach(p => {
      const pid = Array.isArray(p.product_id) ? p.product_id[0] : p.product_id;
      packMap[pid] = p.qty || 1;
    });
    (lines || []).forEach(l => {
      const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
      l._qty_per_box = packMap[pid] || null;
    });
  }
  return lines || [];
}
// ── جلب lines كل BLs دفعة واحدة ────────────────────────────────
async function _rpc_fetchAllBLsLines(baseUrl, pickingIds) {
  if (!pickingIds || !pickingIds.length) return {};
  const picks = await _rpc_call(baseUrl, {
    model: "stock.picking", method: "read",
    args: [pickingIds, ["id", "move_lines"]],
    kwargs: {},
  });
  const allMoveIds = [];
  const moveToPicking = {};
  (picks || []).forEach(p => {
    (p.move_lines || []).forEach(mid => {
      allMoveIds.push(mid);
      moveToPicking[mid] = p.id;
    });
  });
  if (!allMoveIds.length) return {};

  const moves = await _rpc_call(baseUrl, {
    model: "stock.move", method: "read",
    args: [allMoveIds, ["id", "product_id", "product_uom_qty", "sale_line_id"]],
    kwargs: {},
  });

  // أسعار من sale.order.line
  const saleLineIds = (moves || [])
    .map(m => Array.isArray(m.sale_line_id) ? m.sale_line_id[0] : m.sale_line_id)
    .filter(Boolean);
  const solMap = {};
  if (saleLineIds.length) {
    const solData = await _rpc_call(baseUrl, {
      model: "sale.order.line", method: "read",
      args: [saleLineIds, ["id", "price_subtotal"]],
      kwargs: {},
    }).catch(() => []);
    (solData || []).forEach(s => { solMap[s.id] = s.price_subtotal; });
  }

  // تجميع بحسب picking
  const result = {};
  (moves || []).forEach(m => {
    const pid = moveToPicking[m.id];
    if (!pid) return;
    if (!result[pid]) result[pid] = [];
    const solId = Array.isArray(m.sale_line_id) ? m.sale_line_id[0] : m.sale_line_id;
    result[pid].push({
      productName: Array.isArray(m.product_id) ? m.product_id[1] : String(m.product_id || ""),
      productId:   Array.isArray(m.product_id) ? m.product_id[0] : m.product_id,
      qty:         m.product_uom_qty || 0,
      subtotal:    solId ? (solMap[solId] ?? null) : null,
    });
  });
  return result;
}

// ── جلب بيانات Constat (SKUs + منتجات مخصصة) ─────────────────
/**
 * @param {string} baseUrl
 * @param {number[]} pickingIds  — IDs لجميع BLs في الجولة
 * @param {Array<{productIds:number[], label:string, unit:'piece'|'carton'|'fardeau'}>} customProducts
 * @returns {Object} { byPicking: { [pickingId]: { skuCount, customQtys:{[label]:qty} } } }
 */


// ── جلب BLs الجولة ───────────────────────────────────────────
async function _rpc_fetchBLs(baseUrl, roundId, mode) {
  if (mode === "prevente") {
    const rows = await _rpc_call(baseUrl, {
      model: "stock.picking", method: "search_read",
      args: [[["planning_presale_id", "=", roundId]]],
      kwargs: { fields: ["id", "name", "state", "partner_id", "amount_total", "scheduled_date", "planning_state", "delivery_planning_id", "delivery_user_id", "show_mark_as_todo", "show_check_availability", "warehouse_id"], limit: 100 },
    });
    return rows || [];
  } else {
const plannings = await _rpc_call(baseUrl, {
      model: "planning.planning", method: "read",
      args: [[roundId], ["delivery_picking_ids", "allow_open_affectation", "state"]],
      kwargs: {},
    });
    const pickingIds = plannings?.[0]?.delivery_picking_ids || [];
    if (!pickingIds.length) return [];
    const rows = await _rpc_call(baseUrl, {
      model: "stock.picking", method: "read",
      args: [pickingIds, ["id", "name", "state", "partner_id", "amount_total", "scheduled_date", "planning_state", "delivery_planning_id", "delivery_user_id", "show_mark_as_todo", "show_check_availability", "warehouse_id"]],
      kwargs: {},
    });
const result = rows || [];
    result._allowAffectation = plannings?.[0]?.allow_open_affectation ?? false;
    return result;
  }
}

// ── جلب إحداثيات الزبائن (خريطة الجولة) ────────────────────────
async function _rpc_fetchPartnersCoords(baseUrl, partnerIds) {
  const ids = [...new Set((partnerIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const rows = await _rpc_call(baseUrl, {
    model: "res.partner", method: "read",
    args: [ids, ["id", "name", "partner_latitude", "partner_longitude"]],
    kwargs: {},
  });
  return rows || [];
}

// ── تصنيف Cluster الزبون إلى فئة لونية للدبابيس على الخريطة ──
// partner_custom_attribute_1 (Cluster) — نفس الحقل والقيم المعروضة في clientsView.js
// (GMS A, GMS B, GROS A, GROS B, HORECA, DÉTAIL...) — بترتيب أولوية بحث نصي بسيط.
function _clusterNameToCategory(name) {
  const n = String(name || "").toLowerCase();
  if (!n) return null;
  if (n.includes("gms")) return "gms";
  if (n.includes("gros")) return "gros";
  if (n.includes("horeca")) return "horeca";
  if (n.includes("détail") || n.includes("detail")) return "detail";
  return null;
}

// ── جلب بيانات الخريطة لزبائن route (إحداثيات + cluster + actif) دفعة واحدة ──
// تُستعمل من "Carte de la route" (خريطة عامة لكل زبائن مسار معيّن، بدون ارتباط بجولة/BL).
async function _rpc_fetchPartnersForRouteMap(baseUrl, partnerIds) {
  const ids = [...new Set((partnerIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const rows = await _rpc_call(baseUrl, {
    model: "res.partner", method: "read",
    args: [ids, ["id", "name", "partner_latitude", "partner_longitude", "partner_custom_attribute_1", "active"]],
    kwargs: { context: { active_test: false } }, // نريد أيضًا الزبائن المؤرشفين (Non actif)
  });
  return (rows || []).map(p => {
    const clusterName = Array.isArray(p.partner_custom_attribute_1) ? p.partner_custom_attribute_1[1] : "";
    return {
      id: p.id,
      name: p.name,
      lat: p.partner_latitude,
      lng: p.partner_longitude,
      cluster: clusterName || "",
      clusterCategory: _clusterNameToCategory(clusterName),
      active: p.active !== false,
    };
  });
}

// ── جلب فئة Cluster لكل زبون (batch واحد) ──
// partner_custom_attribute_1 حقل many2one عادي (غير company_dependent)، فقراءة
// دفعة واحدة عبر res.partner كافية وموثوقة (بلا حاجة لـ ir.property).
async function _rpc_fetchPartnersClusterCategory(baseUrl, partnerIds) {
  const ids = [...new Set((partnerIds || []).filter(Boolean))];
  const catMap = {};
  if (!ids.length) return catMap;

  try {
    const partners = await _rpc_call(baseUrl, {
      model:  "res.partner",
      method: "read",
      args:   [ids, ["id", "partner_custom_attribute_1"]],
      kwargs: {},
    }).catch(() => []);
    (partners || []).forEach(p => {
      const clusterName = Array.isArray(p.partner_custom_attribute_1) ? p.partner_custom_attribute_1[1] : "";
      catMap[p.id] = _clusterNameToCategory(clusterName);
    });
  } catch (_) {}
  return catMap;
}

// ── جلب "البائع" (Vendeur) — الشخص الذي أنشأ الطلبية، وليس الموزّع/الليفرور ──
// ⚠️ اسم الحقل الفعلي قد يختلف حسب إعداد الأودو (user_id / prevendeur_id / vendeur_id ...).
// _rpc_fetchPickingsVendeur يجرّب عدة أسماء بالترتيب ويتوقف عند أول حقل يُرجع بيانات فعلية.
// تحقق عبر console من الحقل الصحيح إن لزم تعديل القائمة أدناه.
const SALE_ORDER_VENDEUR_FIELD = "user_id";
const PICKING_VENDEUR_FIELDS   = ["user_id", "prevendeur_id", "vendeur_id", "livreur_id"];

async function _rpc_fetchOrdersVendeur(baseUrl, orderIds) {
  const ids = [...new Set((orderIds || []).filter(Boolean))];
  const map = {};
  if (!ids.length) return map;
  try {
    const rows = await _rpc_call(baseUrl, {
      model: "sale.order", method: "read",
      args: [ids, ["id", SALE_ORDER_VENDEUR_FIELD]],
      kwargs: {},
    });
    (rows || []).forEach(r => {
      const v = r[SALE_ORDER_VENDEUR_FIELD];
      if (Array.isArray(v) && v[0]) map[r.id] = { id: v[0], name: v[1] || "—" };
    });
  } catch (_) {}
  return map;
}

async function _rpc_fetchPickingsVendeur(baseUrl, pickingIds) {
  const ids = [...new Set((pickingIds || []).filter(Boolean))];
  const map = {};
  if (!ids.length) return map;
  for (const field of PICKING_VENDEUR_FIELDS) {
    try {
      const rows = await _rpc_call(baseUrl, {
        model: "stock.picking", method: "read",
        args: [ids, ["id", field]],
        kwargs: {},
      });
      let found = false;
      (rows || []).forEach(r => {
        const v = r[field];
        if (Array.isArray(v) && v[0]) { map[r.id] = { id: v[0], name: v[1] || "—" }; found = true; }
      });
      if (found) return map; // أول حقل ينجح فعليًا نتوقف عنده
    } catch (_) { /* الحقل غير موجود على الموديل — نجرّب التالي */ }
  }
  return map;
}

// ── إلغاء BL ─────────────────────────────────────────────────
async function _rpc_cancelBL(baseUrl, pickingId) {
  return _rpc_call(baseUrl, {
    model: "stock.picking", method: "action_cancel",
    args: [[pickingId]],
    kwargs: {},
  });
}


// ── إرجاع BL من cancel ───────────────────────────────────────
async function _rpc_restoreBL(baseUrl, pickingId, permission) {
  // 1. جلب معلومات BL الحالية
  const pickings = await _rpc_call(baseUrl, {
    model: "stock.picking", method: "read",
    args: [[pickingId], ["move_lines", "delivery_planning_id", "delivery_user_id"]],
    kwargs: {},
  });
  const bl              = pickings?.[0] || {};
  const moveIds         = bl.move_lines || [];
  const originalPlanId  = Array.isArray(bl.delivery_planning_id) ? bl.delivery_planning_id[0] : bl.delivery_planning_id;
  const deliveryUserId  = Array.isArray(bl.delivery_user_id)     ? bl.delivery_user_id[0]     : bl.delivery_user_id;

  // 2. تغيير state الـ picking
  await _rpc_call(baseUrl, {
    model: "stock.picking", method: "write",
    args: [[pickingId], { state: "confirmed" }],
    kwargs: {},
  }, permission);

  // 3. تغيير state الـ moves
  if (moveIds.length) {
    await _rpc_call(baseUrl, {
      model: "stock.move", method: "write",
      args: [moveIds, { state: "confirmed" }],
      kwargs: {},
    }, permission);
  }

  // 4. حجز المنتجات
  await _rpc_call(baseUrl, {
    model: "stock.picking", method: "action_assign",
    args: [[pickingId]],
    kwargs: {},
  });

  // 5. إعادة تعيين BL عبر delivery map لتصفير delayed_delivery_ids
  if (originalPlanId && deliveryUserId) {
    try {
      // désaffecter أولاً
      await fetch("/api/delivery-map/assign-deliveries", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planning_id:              originalPlanId,
          delivery_user_id:         deliveryUserId,
          deliveries_to_add_ids:    [],
          deliveries_to_delete_ids: [pickingId],
        }),
      });
      // affecter مرة أخرى
      await fetch("/api/delivery-map/assign-deliveries", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planning_id:              originalPlanId,
          delivery_user_id:         deliveryUserId,
          deliveries_to_add_ids:    [{ delivery_id: pickingId, delivery_rotation: "1" }],
          deliveries_to_delete_ids: [],
        }),
      });
    } catch(_) {}
  }

  // 6. حذف /cancel وما بعده من الاسم
  const pickingData = await _rpc_call(baseUrl, {
    model: "stock.picking", method: "read",
    args: [[pickingId], ["name"]],
    kwargs: {},
  });
  const currentName = pickingData?.[0]?.name || "";
  const cleanName   = currentName.replace(/\/cancel\d*$/i, "");
  if (cleanName !== currentName) {
    await _rpc_call(baseUrl, {
      model: "stock.picking", method: "write",
      args: [[pickingId], { name: cleanName }],
      kwargs: {},
    });
  }
}
// ── حذف Livreur و Tournée من BL ──────────────────────────────
async function _rpc_unlinkBLDelivery(baseUrl, pickingId) {
  return _rpc_call(baseUrl, {
    model: "stock.picking", method: "write",
    args: [[pickingId], { delivery_planning_id: false, delivery_user_id: false }],
    kwargs: {},
  }, "card.showBLs.unlink");
}
// ── بحث عن جولة (tournée) بالمرجع لتغيير جولة BL ─────────────
// نفس دومين name_search في Odoo: جولات livraison مفتوحة/مسودة فقط،
// مفلترة على مستودع الـ BL إن توفر
async function _rpc_searchTournee(baseUrl, term, warehouseId) {
  const t = String(term || "").trim();
  const domain = [
    ["workflow_type", "=", "delivery"],
    "|", ["state", "=", "draft"],
    "&", ["state", "=", "open"], ["allow_open_affectation", "=", true],
  ];
  if (warehouseId) domain.push(["warehouse_ids", "in", warehouseId]);

  const results = await _rpc_call(baseUrl, {
    model: "planning.planning", method: "name_search",
    args: [],
    kwargs: { name: t, args: domain, operator: "ilike", limit: 8 },
  });
  return (results || []).map(([id, name]) => ({ id, name }));
}
// ── بحث عن جولة (tournée) بالمرجع لتغيير جولة دفعة (account.payment) ─────
// بدون قيد workflow_type=delivery (الدفعات ترتبط بأي planning.planning
// وليس فقط جولات التوصيل)، فقط draft/open كما في البحث الأصلي.
async function _rpc_searchTourneeForPayment(baseUrl, term) {
  const t = String(term || "").trim();
  const results = await _rpc_call(baseUrl, {
    model: "planning.planning", method: "name_search",
    args: [],
    kwargs: { name: t, args: [], operator: "ilike", limit: 8 },
  });
  return (results || []).map(([id, name]) => ({ id, name }));
}
// ── تغيير جولة الموزع لـ BL واحد أو عدة BL (تحديد متعدد) ──────
// livreur (delivery_user_id) يُؤخذ تلقائيًا من user_id الخاص بالجولة الجديدة
// pickingId: id واحد أو مصفوفة ids (تغيير جماعي)
async function _rpc_changeBLTournee(baseUrl, pickingId, newPlanningId) {
  const pickingIds = Array.isArray(pickingId) ? pickingId : [pickingId];
  if (!pickingIds.length) throw new Error("Aucun BL sélectionné");

  const plannings = await _rpc_call(baseUrl, {
    model: "planning.planning", method: "read",
    args: [[newPlanningId], ["id", "name", "user_id"]],
    kwargs: {},
  });
  const planning = plannings?.[0];
  if (!planning) throw new Error("Tournée introuvable");
  const deliveryUserId = Array.isArray(planning.user_id) ? planning.user_id[0] : planning.user_id;
  if (!deliveryUserId) throw new Error("Aucun livreur affecté à cette tournée");

  // ── جلب الجولة القديمة + العميل لكل BL قبل التغيير، لغرض حذف
  // العميل من الجولة القديمة بعد نجاح التغيير (خطوة اختيارية صامتة)
  let oldInfo = [];
  try {
    oldInfo = await _rpc_call(baseUrl, {
      model: "stock.picking", method: "read",
      args: [pickingIds, ["id", "partner_id", "delivery_planning_id"]],
      kwargs: {},
    });
  } catch (_) { /* تجاهل — ليست حرجة */ }

  await _rpc_call(baseUrl, {
    model: "stock.picking", method: "write",
    args: [pickingIds, { delivery_planning_id: newPlanningId, delivery_user_id: deliveryUserId }],
    kwargs: {},
  }, "card.showBLs.unlink");

  // ── محاولة حذف العميل من الجولة القديمة (لا تُفشل العملية إن تعذّر) ──
  try {
    await _rpc_removeClientFromOldTournee(baseUrl, oldInfo, newPlanningId);
  } catch (_) { /* نتجاهل الأمر إن لم نتمكن */ }

  return { planningId: newPlanningId, planningName: planning.name, deliveryUserId, deliveryUserName: Array.isArray(planning.user_id) ? planning.user_id[1] : "—" };
}

// ── حذف (أرشفة) الزبون من الجولة (tournée) القديمة بعد تغيير جولته ────
// يعمل بأفضل جهد: لكل BL نأخذ (partner_id, ancienne delivery_planning_id)،
// نبحث عن calendar.event المطابق (planning_id=ancienne، partner_customer_id=العميل،
// active=true) ونؤرشفه (active=false). أي فشل (صلاحية/سجل غير موجود/الخ) يُتجاهل
// بصمت لكل عنصر على حدة دون التأثير على نجاح تغيير الجولة نفسه.
async function _rpc_removeClientFromOldTournee(baseUrl, oldInfo, newPlanningId) {
  const rows = (oldInfo || []).filter(r => {
    const oldPlanId = Array.isArray(r.delivery_planning_id) ? r.delivery_planning_id[0] : r.delivery_planning_id;
    return oldPlanId && oldPlanId !== newPlanningId && r.partner_id;
  });
  if (!rows.length) return;

  for (const r of rows) {
    const oldPlanId  = Array.isArray(r.delivery_planning_id) ? r.delivery_planning_id[0] : r.delivery_planning_id;
    const partnerId  = Array.isArray(r.partner_id) ? r.partner_id[0] : r.partner_id;
    try {
      const events = await _rpc_call(baseUrl, {
        model: "calendar.event", method: "search_read",
        args: [[
          ["planning_id", "=", oldPlanId],
          ["partner_customer_id", "=", partnerId],
          ["active", "=", true],
        ]],
        kwargs: { fields: ["id"], limit: 20 },
      });
      const eventIds = (events || []).map(e => e.id);
      if (!eventIds.length) continue;
      await _rpc_call(baseUrl, {
        model: "calendar.event", method: "write",
        args: [eventIds, { active: false }],
        kwargs: {},
      });
    } catch (_) {
      // نتجاهل الأمر إن لم نتمكن من حذف هذا العميل بالذات
      continue;
    }
  }
}
// ── إعادة تعيين BL من delayed إلى scheduled ──────────────────
async function _rpc_resetDelayedBL(baseUrl, pickingId) {
  // 1. إزالة motif de non livraison
  await _rpc_call(baseUrl, {
    model: "stock.picking", method: "write",
    args: [[pickingId], { no_delivery_reason_id: false }],
    kwargs: {},
  });

  // 2. تغيير planning_state إلى scheduled
  await _rpc_call(baseUrl, {
    model: "stock.picking", method: "write",
    args: [[pickingId], { planning_state: "scheduled", delayed_date: false }],
    kwargs: {},
  });
}
// ── جلب الكمية المتوفرة في المستودع ──────────────────────────
async function _rpc_getProductStock(baseUrl, productIds) {
  const locationId = 213;

  // جلب الكميات والـ packaging معاً
  const [quants, packagings, products] = await Promise.all([
    _rpc_call(baseUrl, {
      model: "stock.quant", method: "search_read",
      args: [[["location_id", "=", locationId], ["product_id", "in", productIds]]],
      kwargs: { fields: ["product_id", "quantity", "reserved_quantity"], limit: 500 },
    }),
    _rpc_call(baseUrl, {
      model: "product.packaging", method: "search_read",
      args: [[["product_id", "in", productIds]]],
      kwargs: { fields: ["product_id", "name", "qty"], limit: 500 },
    }),
    _rpc_call(baseUrl, {
      model: "product.product", method: "read",
      args: [productIds, ["id", "packaging_ids"]],
      kwargs: {},
    }),
  ]);

  // بناء map للـ packaging
  const packMap = {};
  (packagings || []).forEach(pk => {
    const pid = Array.isArray(pk.product_id) ? pk.product_id[0] : pk.product_id;
    if (!packMap[pid]) packMap[pid] = [];
    packMap[pid].push({ name: pk.name, qty: pk.qty });
  });

  // بناء نتيجة الكميات
  const result = {};
  (quants || []).forEach(q => {
    const pid  = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
    const free = Math.max(0, (q.quantity || 0) - (q.reserved_quantity || 0));
    const packs = packMap[pid] || [];
    // اختيار أكبر packaging
    const mainPack = packs.sort((a,b) => b.qty - a.qty)[0];
    result[pid] = {
      free,
      packName: mainPack?.name || null,
      packQty:  mainPack?.qty  || 0,
      cartons:  mainPack?.qty > 0 ? Math.floor(free / mainPack.qty) : 0,
      units:    mainPack?.qty > 0 ? Math.round(free % mainPack.qty) : free,
    };
  });

  // المنتجات التي لا توجد في المستودع
  productIds.forEach(pid => {
    if (!result[pid]) {
      const packs   = packMap[pid] || [];
      const mainPack = packs.sort((a,b) => b.qty - a.qty)[0];
      result[pid] = { free: 0, packName: mainPack?.name || null, packQty: mainPack?.qty || 0, cartons: 0, units: 0 };
    }
  });

  return result;
}
// ── جلب بيانات Constat (SKUs + منتجات مخصصة) ─────────────────
async function _rpc_fetchConstatData(baseUrl, pickingIds, customProducts) {
  if (!pickingIds?.length) return { byPicking: {} };
  customProducts = customProducts || [];

  const byPicking = {};
  pickingIds.forEach(pid => { byPicking[pid] = { skuCount: 0, customQtys: {} }; });

  // ── 1. جلب move_lines لكل picking دفعة واحدة ──
  const picks = await _rpc_call(baseUrl, {
    model: "stock.picking", method: "read",
    args: [pickingIds, ["id", "move_lines"]],
    kwargs: {},
  }).catch(() => []);

  const allMoveIds   = [];
  const moveToPicking = {}; // { moveId → pickingId }
  (picks || []).forEach(p => {
    (p.move_lines || []).forEach(mid => {
      allMoveIds.push(mid);
      moveToPicking[mid] = p.id;
    });
  });

  if (!allMoveIds.length) return { byPicking };

  // ── 2. جلب stock.move دفعة واحدة ──
  const moves = await _rpc_call(baseUrl, {
    model: "stock.move", method: "read",
    args: [allMoveIds, ["id", "product_id", "product_uom_qty", "packaging_quantity"]],
    kwargs: {},
  }).catch(() => []);

  // ── 3. جلب _qty_per_box (product.packaging) لكل المنتجات المخصصة ──
  const allCustomPids = customProducts.flatMap(cp =>
    (cp.productIds || []).map(id => parseInt(id, 10))
  );
  const qtyPerBoxMap = {}; // { productId → qtyPerBox }
  if (allCustomPids.length) {
    const pkgs = await _rpc_call(baseUrl, {
      model: "product.packaging", method: "search_read",
      args: [[ ["product_id", "in", allCustomPids] ]],
      kwargs: { fields: ["product_id", "qty"], limit: 300 },
    }).catch(() => []);
    (pkgs || []).forEach(p => {
      const pid = Array.isArray(p.product_id) ? p.product_id[0] : p.product_id;
      if (!qtyPerBoxMap[pid]) qtyPerBoxMap[pid] = p.qty || 1;
    });
  }

  // ── 4. تجميع moves بحسب picking ──
  const movesByPicking = {};
  (moves || []).forEach(m => {
    const pid = moveToPicking[m.id];
    if (!pid) return;
    if (!movesByPicking[pid]) movesByPicking[pid] = [];
    movesByPicking[pid].push({
      productId:        Array.isArray(m.product_id) ? m.product_id[0] : m.product_id,
      qty:              m.product_uom_qty    || 0,
      packagingQty:     m.packaging_quantity || 0,
    });
  });

 // ── 5. حساب SKU + custom qtys لكل picking ──
  Object.entries(movesByPicking).forEach(([pid, lines]) => {
    const numPid = parseInt(pid, 10);

    // SKU = قائمة المنتجات المميزة (نحتفظ بالـ Set لحساب union لاحقاً)
    byPicking[numPid].skuSet   = new Set(lines.map(l => l.productId));
    byPicking[numPid].skuCount = byPicking[numPid].skuSet.size;

    // Custom products
    customProducts.forEach(cp => {
      const cpSet = new Set((cp.productIds || []).map(id => parseInt(id, 10)));
      const label = cp.label || "?";
      const unit  = cp.unit  || "piece";

      lines.forEach(l => {
        if (!cpSet.has(l.productId)) return;
        let qty = l.qty;
        if (unit === "carton") {
          const qpb = qtyPerBoxMap[l.productId] || 0;
          qty = qpb > 0 ? l.qty / qpb : l.qty;
        } else if (unit === "fardeau") {
          qty = l.packagingQty > 0 ? l.qty / l.packagingQty : l.qty;
        }
        byPicking[numPid].customQtys[label] = (byPicking[numPid].customQtys[label] || 0) + qty;
      });
    });
  });

  return { byPicking };
}

// ── جلب زبائن الجولة ─────────────────────────────────────────
async function _rpc_fetchClients(baseUrl, roundId, mode) {
  // نجلب event_ids من planning.planning مباشرة
  const plannings = await _rpc_call(baseUrl, {
    model:  "planning.planning",
    method: "read",
    args:   [[roundId], ["id", "event_ids", "delivery_picking_ids"]],
    kwargs: {},
  });

  const eventIds = plannings?.[0]?.event_ids;
  if (!Array.isArray(eventIds) || !eventIds.length) return [];

  // جلب planning_state للـ pickings لكشف الملغيين
  const canceledPartners = new Set();
  if (mode === "livraison") {
    const delivPickIds = plannings?.[0]?.delivery_picking_ids || [];
    if (delivPickIds.length) {
      try {
        const delivPicks = await _rpc_call(baseUrl, {
          model:  "stock.picking",
          method: "read",
          args:   [delivPickIds, ["id", "partner_id", "planning_state"]],
          kwargs: {},
        });
        (delivPicks || []).forEach(p => {
          if (p.planning_state === "canceled" && p.partner_id?.[0]) {
            canceledPartners.add(p.partner_id[0]);
          }
        });
      } catch(_) {}
    }
  }

  const events = await _rpc_call(baseUrl, {
    model:  "calendar.event",
    method: "read",
    args:   [eventIds, ["id", "partner_customer_id", "visited", "visited_success", "visited_fail", "no_visit", "sequence", "date_visited", "delivery_picking_ids", "delayed_delivery_ids", "order_ids"]],
    kwargs: {},
  });

  if (!Array.isArray(events) || !events.length) return [];

  const clients = events
    .filter(e => Array.isArray(e.partner_customer_id) && e.partner_customer_id[0])
    .map(e => {
      let state;
      if (mode === "livraison") {
        if ((e.order_ids || []).length > 0)                           state = "sold";
        else if ((e.delayed_delivery_ids || []).length)               state = "delayed";
        else if (canceledPartners.has(e.partner_customer_id[0]))      state = "canceled";
        else if (e.visited_success)                                    state = "success";
        else if (e.visited_fail)                                       state = "fail";
        else if (e.no_visit)                                           state = "absent";
        else                                                           state = "pending";
      } else {
        if ((e.order_ids || []).length > 0) state = "sold";
        else if (e.no_visit)             state = "absent";
        else if (e.visited_success) state = "success";
        else if (e.visited_fail)    state = "fail";
        else if (e.visited)         state = "visited";
        else                        state = "pending";
      }
      let visitTime = null;
      if (mode === "livraison") {
        // on résoudra le transfert après — on stocke juste date_visited comme fallback
        visitTime = e.date_visited || null;
      } else {
        if (e.date_visited) {
          const d = new Date(e.date_visited.replace(" ", "T") + "Z");
          visitTime = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" });
        }
      }
      return {
        id:               e.partner_customer_id[0],
        name:             e.partner_customer_id[1],
        sequence:         e.sequence || 0,
        state,
        visitTime,
        deliveryPickings: e.delivery_picking_ids || [],
        orderIds:         e.order_ids || [],
      };
    })
    .sort((a, b) => a.sequence - b.sequence);

  // Pour livraison: remplacer visitTime par date_done du transfert
  if (mode === "livraison") {
    const tzOpts = { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" };
    const toTime = raw => raw ? new Date(raw.replace(" ", "T") + "Z").toLocaleTimeString("fr-FR", tzOpts) : null;

    // جلب date_done للـ pickings
    const allPickingIds = clients.flatMap(c => c.deliveryPickings);
    const doneMap = {};
    if (allPickingIds.length) {
      try {
        const pickings = await _rpc_call(baseUrl, {
          model:  "stock.picking",
          method: "read",
          args:   [allPickingIds, ["id", "date_done"]],
          kwargs: {},
        });
        (pickings || []).forEach(p => { if (p.date_done) doneMap[p.id] = p.date_done; });
      } catch(_) {}
    }

    // جلب date_order للـ sale.orders (حالة sold)
    const allOrderIds = clients.flatMap(c => c.orderIds || []);
    const orderDateMap = {};
    if (allOrderIds.length) {
      try {
        const orders = await _rpc_call(baseUrl, {
          model:  "sale.order",
          method: "read",
          args:   [allOrderIds, ["id", "date_order"]],
          kwargs: {},
        });
        (orders || []).forEach(o => { if (o.date_order) orderDateMap[o.id] = o.date_order; });
      } catch(_) {}
    }

    clients.forEach(c => {
      if (c.state === "sold") {
        const raw = (c.orderIds || []).map(oid => orderDateMap[oid]).find(Boolean);
        c.visitTime = toTime(raw);
      } else {
        const transferDate = c.deliveryPickings.map(pid => doneMap[pid]).find(Boolean);
        c.visitTime = toTime(transferDate || c.visitTime);
      }
    });
  }

  return clients;
}

// ── جلب تنبيهات الكرت (reporté/annulé) ───────────────────────
async function _rpc_fetchRoundAlerts(baseUrl, roundId) {
  try {
    const plan = await _rpc_call(baseUrl, {
      model:  "planning.planning",
      method: "read",
      args:   [[roundId], ["id", "delivery_picking_ids"]],
      kwargs: {},
    });
    const pickIds = plan?.[0]?.delivery_picking_ids || [];
    return _rpc_fetchRoundAlerts_fromPickIds(baseUrl, pickIds);
  } catch(_) { return { hasDelayed: false, hasCanceled: false }; }
}

async function _rpc_fetchRoundAlerts_fromPickIds(baseUrl, pickIds) {
  try {
    if (!pickIds.length) return { hasDelayed: false, hasCanceled: false };
    const picks = await _rpc_call(baseUrl, {
      model:  "stock.picking",
      method: "read",
      args:   [pickIds, ["id", "planning_state"]],
      kwargs: {},
    });
    return {
      hasDelayed:  (picks || []).some(p => p.planning_state === "delayed"),
      hasCanceled: (picks || []).some(p => p.planning_state === "canceled"),
    };
  } catch(_) { return { hasDelayed: false, hasCanceled: false }; }
}

// ── جلب الطلبيات المؤجلة (نفس منطق fetchClients: delayed_delivery_ids) ──
async function _rpc_fetchDelayedOrders(baseUrl, roundId) {
  try {
    const plan = await _rpc_call(baseUrl, {
      model:  "planning.planning",
      method: "read",
      args:   [[roundId], ["id", "event_ids"]],
      kwargs: {},
    });
    const eventIds = plan?.[0]?.event_ids || [];
    return _rpc_fetchDelayedOrders_fromEventIds(baseUrl, eventIds);
  } catch(_) { return []; }
}

async function _rpc_fetchDelayedOrders_fromEventIds(baseUrl, eventIds) {
  try {
    if (!eventIds.length) return [];

    const events = await _rpc_call(baseUrl, {
      model:  "calendar.event",
      method: "read",
      args:   [eventIds, ["id", "delayed_delivery_ids"]],
      kwargs: {},
    });
    const delayIds = [...new Set((events || []).flatMap(e => e.delayed_delivery_ids || []))];
    if (!delayIds.length) return [];

    const delays = await _rpc_call(baseUrl, {
      model:  "stock.picking.delivery_delay",
      method: "read",
      args:   [delayIds, ["id", "picking_id", "partner_id", "no_delivery_reason_id"]],
      kwargs: {},
    });

    // جلب أسعار الـ pickings المرتبطة (amount_total) لعرضها في فقاعة "Reporté"
    const pickIds = [...new Set((delays || []).map(d => d.picking_id?.[0]).filter(Boolean))];
    const amountMap = {};
    if (pickIds.length) {
      try {
        const picks = await _rpc_call(baseUrl, {
          model:  "stock.picking",
          method: "read",
          args:   [pickIds, ["id", "amount_total"]],
          kwargs: {},
        });
        (picks || []).forEach(p => { amountMap[p.id] = p.amount_total || 0; });
      } catch (_) {}
    }

    return (delays || []).map(d => ({
      id:        d.picking_id?.[0] || d.id,
      name:      d.picking_id?.[1] || "",
      partner:   Array.isArray(d.partner_id) ? d.partner_id[1] : "",
      partnerId: Array.isArray(d.partner_id) ? d.partner_id[0] : null,
      origin:    Array.isArray(d.no_delivery_reason_id) ? d.no_delivery_reason_id[1] : "",
      amount:    amountMap[d.picking_id?.[0]] || 0,
    }));
  } catch(_) { return []; }
}

// ── جلب الطلبيات المباعة خلال التورنيه (نفس مصدر fetchClients: order_ids على calendar.event) ──
// مستقل تمامًا عن fetchDelayedOrders/fetchRoundAlerts. يحاول إيجاد stock.picking الحقيقي
// المرتبط بكل sale.order عبر الحقل القياسي picking_ids، وإن لم يوجد يبحث بديلاً عبر
// origin = مرجع الطلبية (نفس فكرة "لا تستخدم id وسيط" المطبّقة في Reports).
async function _rpc_fetchSoldOrders(baseUrl, roundId) {
  try {
    const plan = await _rpc_call(baseUrl, {
      model:  "planning.planning",
      method: "read",
      args:   [[roundId], ["id", "event_ids"]],
      kwargs: {},
    });
    const eventIds = plan?.[0]?.event_ids || [];
    return _rpc_fetchSoldOrders_fromEventIds(baseUrl, eventIds);
  } catch (_) { return []; }
}

async function _rpc_fetchSoldOrders_fromEventIds(baseUrl, eventIds) {
  try {
    if (!eventIds.length) return [];

    const events = await _rpc_call(baseUrl, {
      model:  "calendar.event",
      method: "read",
      args:   [eventIds, ["id", "partner_customer_id", "order_ids"]],
      kwargs: {},
    });
    const soldEvents = (events || []).filter(e => Array.isArray(e.order_ids) && e.order_ids.length);
    if (!soldEvents.length) return [];

    const orderIds = [...new Set(soldEvents.flatMap(e => e.order_ids))];

    // مرجع الطلبية + الشحنات المرتبطة بها (picking_ids قياسي في sale_stock)
    let orders = [];
    try {
      orders = await _rpc_call(baseUrl, {
        model:  "sale.order",
        method: "read",
        args:   [orderIds, ["id", "name", "picking_ids", "amount_total"]],
        kwargs: {},
      });
    } catch (_) {
      orders = await _rpc_call(baseUrl, {
        model:  "sale.order",
        method: "read",
        args:   [orderIds, ["id", "name", "amount_total"]],
        kwargs: {},
      }).catch(() => []);
    }

    const orderMap = {};
    (orders || []).forEach(o => { orderMap[o.id] = o; });

    // أسماء الـ pickings الحقيقية عبر picking_ids
    const linkedPickIds = [...new Set((orders || []).flatMap(o => o.picking_ids || []))];
    const pickNameMap = {};
    if (linkedPickIds.length) {
      try {
        const picks = await _rpc_call(baseUrl, {
          model:  "stock.picking",
          method: "read",
          args:   [linkedPickIds, ["id", "name"]],
          kwargs: {},
        });
        (picks || []).forEach(p => { pickNameMap[p.id] = p.name; });
      } catch (_) {}
    }

    // بديل: طلبيات بلا picking_ids متاح — نبحث عبر origin = اسم الطلبية
    const noPickOrders = (orders || []).filter(o => !Array.isArray(o.picking_ids) || !o.picking_ids.length);
    const originMap = {};
    if (noPickOrders.length) {
      try {
        const names = noPickOrders.map(o => o.name).filter(Boolean);
        if (names.length) {
          const found = await _rpc_call(baseUrl, {
            model:  "stock.picking",
            method: "search_read",
            args:   [[["origin", "in", names]]],
            kwargs: { fields: ["id", "name", "origin"], limit: 2000 },
          });
          (found || []).forEach(p => { if (!originMap[p.origin]) originMap[p.origin] = p; });
        }
      } catch (_) {}
    }

    const result = [];
    soldEvents.forEach(e => {
      const partnerName = Array.isArray(e.partner_customer_id) ? e.partner_customer_id[1] : "";
      (e.order_ids || []).forEach(oid => {
        const o = orderMap[oid];
        if (!o) return;
        let pickId = null, pickName = null;
        if (Array.isArray(o.picking_ids) && o.picking_ids.length) {
          pickId   = o.picking_ids[0];
          pickName = pickNameMap[pickId] || null;
        } else if (originMap[o.name]) {
          pickId   = originMap[o.name].id;
          pickName = originMap[o.name].name;
        }
        result.push({
          id:        pickId,           // معرف stock.picking الحقيقي (null إن لم يوجد)
          name:      pickName,
          orderId:   oid,
          orderRef:  o.name || "",
          partner:   partnerName,
          amount:    o.amount_total || 0,
        });
      });
    });
    return result;
  } catch (_) { return []; }
}

// ── جلب طلبيات الإرجاع/الاسترجاع (Retours) للتورنيه ──
// المصدر الحقيقي (تم التحقق منه عبر console على الرول 431183):
// stock.picking مستقل (غير مدرج داخل delivery_picking_ids)، picking_type_code="incoming"،
// origin = "Retour de <name البيكينج الأصلي>". نربطه بالجولة عبر أسماء pickings الجولة.
async function _rpc_fetchReturnOrders(baseUrl, roundId) {
  try {
    const plan = await _rpc_call(baseUrl, {
      model:  "planning.planning",
      method: "read",
      args:   [[roundId], ["id", "delivery_picking_ids"]],
      kwargs: {},
    });
    const pickIds = plan?.[0]?.delivery_picking_ids || [];
    return _rpc_fetchReturnOrders_fromPickIds(baseUrl, pickIds);
  } catch (_) { return []; }
}

async function _rpc_fetchReturnOrders_fromPickIds(baseUrl, pickIds) {
  try {
    if (!pickIds.length) return [];

    const pickings = await _rpc_call(baseUrl, {
      model:  "stock.picking",
      method: "read",
      args:   [pickIds, ["id", "name"]],
      kwargs: {},
    });
    const names = (pickings || []).map(p => p.name).filter(Boolean);
    if (!names.length) return [];

    const origins = names.map(n => `Retour de ${n}`);
    const returns = await _rpc_call(baseUrl, {
      model:  "stock.picking",
      method: "search_read",
      args:   [[["picking_type_code", "=", "incoming"], ["origin", "in", origins]]],
      kwargs: { fields: ["id", "name", "origin", "partner_id", "amount_total"], limit: 200 },
    });

    return (returns || []).map(r => ({
      id:        r.id,
      name:      r.name || "",
      partner:   Array.isArray(r.partner_id) ? r.partner_id[1] : "",
      partnerId: Array.isArray(r.partner_id) ? r.partner_id[0] : null,
      amount:    r.amount_total || 0,
    }));
  } catch (_) { return []; }
}

// ── نسخة Bulk: تجمع كل الـ roundIds في نداءات RPC موحدة بدل نداء منفصل لكل عامل ──
// هذا هو الفرق الجوهري للأداء مع عدد كبير من العمال (65+): بدل 65×4 نداءات
// متوازية (تصطدم بحد اتصالات المتصفح فتتسلسل فعليًا)، نستخدم ~8 نداءات بالمجموع.
async function _rpc_fetchRoundExtrasBulk(baseUrl, roundIds) {
  const out = {}; // roundId -> { alerts, delayed, sold, returns }
  roundIds.forEach(id => { out[id] = { alerts: { hasDelayed:false, hasCanceled:false }, delayed: [], sold: [], returns: [] }; });
  if (!roundIds.length) return out;

  try {
    // 1) قراءة واحدة لكل الجولات
    const plans = await _rpc_call(baseUrl, {
      model:  "planning.planning",
      method: "read",
      args:   [roundIds, ["id", "delivery_picking_ids", "event_ids"]],
      kwargs: {},
    });

    const pickToRound = {};   // pickId -> roundId
    const eventToRound = {};  // eventId -> roundId
    const allPickIds = [];
    const allEventIds = [];
    (plans || []).forEach(p => {
      (p.delivery_picking_ids || []).forEach(pid => { pickToRound[pid] = p.id; allPickIds.push(pid); });
      (p.event_ids || []).forEach(eid => { eventToRound[eid] = p.id; allEventIds.push(eid); });
    });

    // 2+3+4) Alertes R/A + أسماء الـ pickings (للـ Retours) + الـ events — الثلاثة مستقلة عن بعضها → بالتوازي
    const [picks, pickNames, events] = await Promise.all([
      allPickIds.length ? _rpc_call(baseUrl, {
        model: "stock.picking", method: "read",
        args: [allPickIds, ["id", "planning_state"]], kwargs: {},
      }).catch(() => []) : Promise.resolve([]),
      allPickIds.length ? _rpc_call(baseUrl, {
        model: "stock.picking", method: "read",
        args: [allPickIds, ["id", "name"]], kwargs: {},
      }).catch(() => []) : Promise.resolve([]),
      allEventIds.length ? _rpc_call(baseUrl, {
        model: "calendar.event", method: "read",
        args: [allEventIds, ["id", "partner_customer_id", "order_ids", "delayed_delivery_ids"]], kwargs: {},
      }).catch(() => []) : Promise.resolve([]),
    ]);

    // Alertes R/A
    (picks || []).forEach(pk => {
      const rid = pickToRound[pk.id]; if (!rid) return;
      if (pk.planning_state === "delayed")  out[rid].alerts.hasDelayed  = true;
      if (pk.planning_state === "canceled") out[rid].alerts.hasCanceled = true;
    });

    // Retours — يعتمد على pickNames (سبق جلبه بالتوازي)
    const nameToRound = {};
    (pickNames || []).forEach(p => { if (p.name) nameToRound[`Retour de ${p.name}`] = pickToRound[p.id]; });
    const origins = Object.keys(nameToRound);
    if (origins.length) {
      const returns = await _rpc_call(baseUrl, {
        model: "stock.picking", method: "search_read",
        args: [[["picking_type_code", "=", "incoming"], ["origin", "in", origins]]],
        kwargs: { fields: ["id", "name", "origin", "partner_id", "amount_total"], limit: 2000 },
      }).catch(() => []);
      (returns || []).forEach(r => {
        const rid = nameToRound[r.origin]; if (!rid) return;
        out[rid].returns.push({
          id:        r.id,
          name:      r.name || "",
          partner:   Array.isArray(r.partner_id) ? r.partner_id[1] : "",
          partnerId: Array.isArray(r.partner_id) ? r.partner_id[0] : null,
          amount:    r.amount_total || 0,
        });
      });
    }

    if (allEventIds.length) {
      // 5+6) Reports (delayed) + Ventes (sale.order) — يعتمدان فقط على events → بالتوازي
      const allDelayIds = [...new Set((events || []).flatMap(e => e.delayed_delivery_ids || []))];
      const delayToRound = {};
      (events || []).forEach(e => { const rid = eventToRound[e.id]; (e.delayed_delivery_ids || []).forEach(did => { delayToRound[did] = rid; }); });

      const soldEvents = (events || []).filter(e => Array.isArray(e.order_ids) && e.order_ids.length);
      const orderIds = [...new Set(soldEvents.flatMap(e => e.order_ids))];

      const [delays, ordersRaw] = await Promise.all([
        allDelayIds.length ? _rpc_call(baseUrl, {
          model: "stock.picking.delivery_delay", method: "read",
          args: [allDelayIds, ["id", "picking_id", "partner_id", "no_delivery_reason_id"]], kwargs: {},
        }).catch(() => []) : Promise.resolve([]),
        orderIds.length ? _rpc_call(baseUrl, {
          model: "sale.order", method: "read",
          args: [orderIds, ["id", "name", "picking_ids", "amount_total"]], kwargs: {},
        }).catch(() => []) : Promise.resolve([]),
      ]);

      (delays || []).forEach(d => {
        const rid = delayToRound[d.id]; if (!rid) return;
        out[rid].delayed.push({
          id: d.picking_id?.[0] || d.id, name: d.picking_id?.[1] || "",
          partner: Array.isArray(d.partner_id) ? d.partner_id[1] : "",
          origin: Array.isArray(d.no_delivery_reason_id) ? d.no_delivery_reason_id[1] : "",
        });
      });

      if (soldEvents.length) {
        let orders = ordersRaw;
        if (!Array.isArray(orders) || !orders.length) {
          orders = await _rpc_call(baseUrl, { model: "sale.order", method: "read", args: [orderIds, ["id", "name", "amount_total"]], kwargs: {} }).catch(() => []);
        }
        const orderMap = {}; (orders || []).forEach(o => { orderMap[o.id] = o; });

        const linkedPickIds = [...new Set((orders || []).flatMap(o => o.picking_ids || []))];
        const noPickOrders = (orders || []).filter(o => !Array.isArray(o.picking_ids) || !o.picking_ids.length);
        const names = noPickOrders.map(o => o.name).filter(Boolean);

        // 7+8) أسماء pickings المرتبطة مباشرة + بحث الـ origins للطلبات بدون picking — بالتوازي
        const [picks2, found] = await Promise.all([
          linkedPickIds.length ? _rpc_call(baseUrl, { model: "stock.picking", method: "read", args: [linkedPickIds, ["id", "name"]], kwargs: {} }).catch(() => []) : Promise.resolve([]),
          names.length ? _rpc_call(baseUrl, {
            model: "stock.picking", method: "search_read",
            args: [[["origin", "in", names]]], kwargs: { fields: ["id", "name", "origin"], limit: 2000 },
          }).catch(() => []) : Promise.resolve([]),
        ]);

        const pickNameMap = {};
        (picks2 || []).forEach(p => { pickNameMap[p.id] = p.name; });
        const originMap = {};
        (found || []).forEach(p => { if (!originMap[p.origin]) originMap[p.origin] = p; });

        soldEvents.forEach(e => {
          const rid = eventToRound[e.id]; if (!rid) return;
          const partnerName = Array.isArray(e.partner_customer_id) ? e.partner_customer_id[1] : "";
          (e.order_ids || []).forEach(oid => {
            const o = orderMap[oid]; if (!o) return;
            let pickId = null, pickName = null;
            if (Array.isArray(o.picking_ids) && o.picking_ids.length) {
              pickId = o.picking_ids[0]; pickName = pickNameMap[pickId] || null;
            } else if (originMap[o.name]) {
              pickId = originMap[o.name].id; pickName = originMap[o.name].name;
            }
            out[rid].sold.push({ id: pickId, name: pickName, orderId: oid, orderRef: o.name || "", partner: partnerName, amount: o.amount_total || 0 });
          });
        });
      }
    }
  } catch (_) {}
  return out;
}
// يقرأ planning.planning مرة واحدة فقط (delivery_picking_ids + event_ids) بدل 3 قراءات منفصلة،
// ثم ينفّذ باقي النداءات بالتوازي عبر Promise.all بدل التتابع.
async function _rpc_fetchRoundExtras(baseUrl, roundId) {
  const empty = {
    alerts:  { hasDelayed: false, hasCanceled: false },
    delayed: [],
    sold:    [],
    returns: [],
  };
  try {
    const plan = await _rpc_call(baseUrl, {
      model:  "planning.planning",
      method: "read",
      args:   [[roundId], ["id", "delivery_picking_ids", "event_ids"]],
      kwargs: {},
    });
    const pickIds   = plan?.[0]?.delivery_picking_ids || [];
    const eventIds  = plan?.[0]?.event_ids || [];

    const [alerts, delayed, sold, returns] = await Promise.all([
      _rpc_fetchRoundAlerts_fromPickIds(baseUrl, pickIds),
      _rpc_fetchDelayedOrders_fromEventIds(baseUrl, eventIds),
      _rpc_fetchSoldOrders_fromEventIds(baseUrl, eventIds),
      _rpc_fetchReturnOrders_fromPickIds(baseUrl, pickIds),
    ]);
    return { alerts, delayed, sold, returns };
  } catch (_) { return empty; }
}

async function _rpc_fetchAgentsFromOdoo(baseUrl, workflowNames, uid) {
  console.log("[rpc] fetchAgents workflowNames:", workflowNames, "uid:", uid);

  // 1. جلب uid الحالي مباشرة من Odoo (لا نعتمد على المخزون)
  let freshUid = null;
  try {
    const sessResp = await fetch(`/api/web/session/get_session_info`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(), params: {} }),
    });
    const sessData = await sessResp.json();
    freshUid = sessData?.result?.uid || null;
    console.log("[rpc] fresh session uid:", freshUid);
  } catch (e) {
    console.warn("[rpc] get_session_info failed:", e);
  }

  if (!freshUid) throw new Error("Session Odoo expirée — reconnectez-vous.");

  // 2. جلب warehouse_ids للمستخدم الحالي
  let warehouseIds = [];
  const sessionRows = await _rpc_call(baseUrl, {
    model:  "res.users",
    method: "read",
    args:   [[freshUid], ["warehouse_ids"]],
    kwargs: {},
  });
  warehouseIds = (Array.isArray(sessionRows) && sessionRows[0]?.warehouse_ids) || [];
  console.log("[rpc] current user warehouse_ids:", warehouseIds);

  // 3. جلب IDs الـ workflows بالأسماء المطلوبة
  const wfRows = await _rpc_call(baseUrl, {
    model:  "user.workflow",
    method: "search_read",
    args:   [[["name", "in", workflowNames]]],
    kwargs: { fields: ["id", "name"], limit: 200 },
  });
  console.log("[rpc] user.workflow rows:", wfRows);
  if (!Array.isArray(wfRows) || !wfRows.length) return [];

  const wfIdToName = {};
  wfRows.forEach(w => { wfIdToName[w.id] = w.name; });
  const wfIds = wfRows.map(w => w.id);

  // 4. جلب المستخدمين مع فلتر warehouse + workflow
  const domain = [["workflow_ids", "in", wfIds], ["active", "=", true]];
  if (warehouseIds.length) domain.push(["warehouse_ids", "in", warehouseIds]);

  const rows = await _rpc_call(baseUrl, {
    model:  "res.users",
    method: "search_read",
    args:   [domain],
    // planning_template_ids: many2many (res.users → planning.template) —
    // تأكّد الاسم والنوع فعليًا عبر واجهة Odoo نفسها (وليس تخمينًا). بائع
    // prevente واحد قد يكون له عدة مسارات، لذا نجلب المصفوفة كاملة.
    kwargs: { fields: ["id", "login", "name", "workflow_ids", "planning_template_ids"], limit: 500 },
  });
  console.log("[rpc] res.users rows:", rows);
  if (!Array.isArray(rows)) return [];

  // جلب أسماء المسارات (planning.template لا يُرجع الاسم مباشرة ضمن
  // planning_template_ids لأنه many2many — فقط قائمة IDs).
  const allTemplateIds = [...new Set(rows.flatMap(r => r.planning_template_ids || []))];
  let templateNameById = {};
  if (allTemplateIds.length) {
    try {
      const tplRows = await _rpc_call(baseUrl, {
        model:  "planning.template",
        method: "search_read",
        args:   [[["id", "in", allTemplateIds]]],
        kwargs: { fields: ["id", "name"], limit: 500 },
      });
      console.log("[rpc] planning.template rows:", tplRows);
      (tplRows || []).forEach(t => { templateNameById[t.id] = t.name; });
    } catch (e) {
      console.warn("[rpc] échec chargement planning.template (noms de routes):", e.message);
    }
  }

  return rows.map(r => {
    const routeIds = r.planning_template_ids || [];
    return {
      odooId:      r.id,
      name:        r.login,
      displayName: r.name || r.login,
      workflows:   (r.workflow_ids || []).map(wid => wfIdToName[wid]).filter(Boolean),
      // routeId/routeName: المسار الأول (لتفعيل زر "Route" بالكرت حاليًا).
      // routeIds/routeNames: القائمة الكاملة (لدعم عدة مسارات لاحقًا).
      routeId:     routeIds.length ? routeIds[0] : null,
      routeName:   routeIds.length ? (templateNameById[routeIds[0]] || null) : null,
      routeIds,
      routeNames:  routeIds.map(id => templateNameById[id]).filter(Boolean),
    };
  });
}

// ── Public API ────────────────────────────────────────────────
const rpcController = {
  fetch:           (workers, baseUrl, mode, dateOffset = 0, skipCF = false) => _rpc_triggerFetch(workers, baseUrl, mode, dateOffset, skipCF),
  fetchEMB:        (workers, baseUrl, mode, dateOffset = 0) => _rpc_triggerFetch(workers, baseUrl, mode, dateOffset, false),
  refreshStats:    (workers, baseUrl, mode, dateOffset = 0) => _rpc_refreshStats(workers, baseUrl, mode, dateOffset),
  acceptHorsTournee:  (baseUrl, roundId)                    => _rpc_acceptHorsTournee(baseUrl, roundId),
  openHorsWizard:     (baseUrl, roundId)                    => _rpc_openHorsWizard(baseUrl, roundId),
  fetchHorsClients:   (baseUrl, wizModel, wizardId)         => _rpc_fetchHorsClients(baseUrl, wizModel, wizardId),
  acceptOneHors:      (baseUrl, wizModel, wizardId, lineId, lineModel) => _rpc_acceptOneHors(baseUrl, wizModel, wizardId, lineId, lineModel),
  acceptAllHors:      (baseUrl, wizModel, wizardId)         => _rpc_acceptAllHors(baseUrl, wizModel, wizardId),
  refuseOneHors:      (baseUrl, wizModel, wizardId, lineId, lineModel) => _rpc_refuseOneHors(baseUrl, wizModel, wizardId, lineId, lineModel),
  refuseAllHors:      (baseUrl, wizModel, wizardId)         => _rpc_refuseAllHors(baseUrl, wizModel, wizardId),
  openPlanning:    (baseUrl, roundId)                      => _rpc_openPlanning(baseUrl, roundId),
  closePlanning:   (baseUrl, roundId)                      => _rpc_closePlanning(baseUrl, roundId),
  closeVendorDay:  (baseUrl, roundId)                      => _rpc_closeVendorDay(baseUrl, roundId),
  disableHorsZone: (baseUrl, roundId)                      => _rpc_disableHorsZone(baseUrl, roundId),
  enableHorsZone:  (baseUrl, roundId)                      => _rpc_enableHorsZone(baseUrl, roundId),
  allowHorsZone:   (baseUrl, roundId)                      => _rpc_allowHorsZone(baseUrl, roundId),
  closeAllPlannings: (baseUrl, roundIds)                   => _rpc_closeAllPlannings(baseUrl, roundIds),
  createPayment:   (baseUrl, fields, permission)           => _rpc_createPayment(baseUrl, fields, permission),
  fetchProductList: (baseUrl)                              => _rpc_fetchProductList(baseUrl),
  fetchSellerList: (baseUrl)                               => _rpc_fetchSellerList(baseUrl),
  fetchPricelistList: (baseUrl)                             => _rpc_fetchPricelistList(baseUrl),
  searchProducts:  (baseUrl, query)                        => _rpc_searchProducts(baseUrl, query),
  searchProductsTokenized: (baseUrl, query)                => _rpc_searchProductsTokenized(baseUrl, query),
  searchPartners:  (baseUrl, term, routeIds)                => _rpc_searchPartners(baseUrl, term, routeIds),
  fetchRouteCustomers: (baseUrl, routeId)                   => _rpc_fetchRouteCustomers(baseUrl, routeId),
  resolveRouteByName: (baseUrl, name)                       => _rpc_resolveRouteByName(baseUrl, name),
  searchRoutes: (baseUrl, term)                              => _rpc_searchRoutes(baseUrl, term),
  fetchAllRoutes: (baseUrl)                                  => _rpc_fetchAllRoutes(baseUrl),
  addProductToRound: (baseUrl, planningId, product, qtyCdn, qtyPiece) =>
                     _rpc_addProductToRound(baseUrl, planningId, product, qtyCdn, qtyPiece),
  fetchStockFinal:   (baseUrl, roundId)                    => _rpc_fetchStockFinal(baseUrl, roundId),
  fetchJournalStock: (baseUrl, roundId)                    => _rpc_fetchJournalStock(baseUrl, roundId),
  fetchBonChargement: (baseUrl, roundId)                   => _rpc_fetchBonChargement(baseUrl, roundId),
  fetchPayments:      (baseUrl, planningId)                   => _rpc_fetchPayments(baseUrl, planningId),
  resolveJournalId:   (baseUrl, journalName, companyName)     => _rpc_resolveJournalId(baseUrl, journalName, companyName),
  changePaymentJournal: (baseUrl, paymentId, journalId)       => _rpc_changePaymentJournal(baseUrl, paymentId, journalId),
  changePaymentAmount: (baseUrl, paymentId, newAmount)         => _rpc_changePaymentAmount(baseUrl, paymentId, newAmount),
  changePaymentName:   (baseUrl, paymentId, newName)            => _rpc_changePaymentName(baseUrl, paymentId, newName),
  changePaymentPartner: (baseUrl, paymentId, partnerRef)        => _rpc_changePaymentPartner(baseUrl, paymentId, partnerRef),
  searchClientsByName:(baseUrl, name)                         => _rpc_searchClientsByName(baseUrl, name),
  addClientToRound:   (baseUrl, roundId, partnerRef, mode)    => _rpc_addClientToRound(baseUrl, roundId, partnerRef, mode),
  deleteClientFromRound: (baseUrl, eventIds)                  => _rpc_deleteClientFromRound(baseUrl, eventIds),
  fetchRoundClientsForDelete: (baseUrl, roundId)               => _rpc_fetchRoundClientsForDelete(baseUrl, roundId),
  addClientToRoute:   (baseUrl, routeId, partnerRef, weeks, days) => _rpc_addClientToRoute(baseUrl, routeId, partnerRef, weeks, days),
  updateRouteClientSchedule: (baseUrl, eventIds, weeks, days)     => _rpc_updateRouteClientSchedule(baseUrl, eventIds, weeks, days),
  deleteRouteClients: (baseUrl, eventIds)                         => _rpc_deleteRouteClients(baseUrl, eventIds),
  findClientRoute: (baseUrl, partnerId)                           => _rpc_findClientRoute(baseUrl, partnerId),
  filterRouteClients: (rows, query)                                => _rpc_filterRouteClients(rows, query),
  fetchBLs:        (baseUrl, roundId, mode)                   => _rpc_fetchBLs(baseUrl, roundId, mode),
  fetchPartnersCoords: (baseUrl, partnerIds)                  => _rpc_fetchPartnersCoords(baseUrl, partnerIds),
  fetchPartnersForRouteMap: (baseUrl, partnerIds)              => _rpc_fetchPartnersForRouteMap(baseUrl, partnerIds),
  fetchPartnersCluster: (baseUrl, partnerIds)                 => _rpc_fetchPartnersClusterCategory(baseUrl, partnerIds),
  fetchOrdersVendeur:   (baseUrl, orderIds)                   => _rpc_fetchOrdersVendeur(baseUrl, orderIds),
  fetchPickingsVendeur: (baseUrl, pickingIds)                 => _rpc_fetchPickingsVendeur(baseUrl, pickingIds),
  fetchClients:    (baseUrl, roundId, mode)                   => _rpc_fetchClients(baseUrl, roundId, mode),
  fetchRoundAlerts:(baseUrl, roundId)                         => _rpc_fetchRoundAlerts(baseUrl, roundId),
  fetchDelayedOrders:(baseUrl, roundId)                       => _rpc_fetchDelayedOrders(baseUrl, roundId),
  fetchSoldOrders:  (baseUrl, roundId)                        => _rpc_fetchSoldOrders(baseUrl, roundId),
  fetchReturnOrders:(baseUrl, roundId)                        => _rpc_fetchReturnOrders(baseUrl, roundId),
  fetchRoundExtras:(baseUrl, roundId)                         => _rpc_fetchRoundExtras(baseUrl, roundId),
  fetchRoundExtrasBulk:(baseUrl, roundIds)                    => _rpc_fetchRoundExtrasBulk(baseUrl, roundIds),
  fetchBLLines:        (baseUrl, pickingId)                           => _rpc_fetchBLLines(baseUrl, pickingId),
  fetchAllBLsLines:    (baseUrl, pickingIds)                          => _rpc_fetchAllBLsLines(baseUrl, pickingIds),
  fetchConstatData:    (baseUrl, pickingIds, customProducts)          => _rpc_fetchConstatData(baseUrl, pickingIds, customProducts),
  checkAvailability:   (baseUrl, pickingId)                           => _rpc_checkAvailability(baseUrl, pickingId),
  pickingAction:       (baseUrl, pickingId, method, context)           => _rpc_pickingAction(baseUrl, pickingId, method, context),
  fetchPickingDetail:  (baseUrl, pickingId)                            => _rpc_fetchPickingDetail(baseUrl, pickingId),
  updateMoveQty:       (baseUrl, pickingId, moveId, vals, name) =>
                       _rpc_updateMoveQty(baseUrl, pickingId, moveId, vals, name),
  addBLLine:           (baseUrl, pickingId, productId, qty, cdn, pkgId) => _rpc_addBLLine(baseUrl, pickingId, productId, qty, cdn, pkgId),
  cancelBL:        (baseUrl, pickingId)                       => _rpc_cancelBL(baseUrl, pickingId),
  restoreBL:       (baseUrl, pickingId, permission)          => _rpc_restoreBL(baseUrl, pickingId, permission),
  unlinkBLDelivery:(baseUrl, pickingId)                       => _rpc_unlinkBLDelivery(baseUrl, pickingId),
  searchTournee:   (baseUrl, term, warehouseId)               => _rpc_searchTournee(baseUrl, term, warehouseId),
  searchTourneeForPayment: (baseUrl, term)                    => _rpc_searchTourneeForPayment(baseUrl, term),
  changeBLTournee: (baseUrl, pickingId, newPlanningId)        => _rpc_changeBLTournee(baseUrl, pickingId, newPlanningId),
  changePaymentTournee: (baseUrl, paymentId, newPlanningId)   => _rpc_changePaymentTournee(baseUrl, paymentId, newPlanningId),
  resetDelayedBL:  (baseUrl, pickingId)                     => _rpc_resetDelayedBL(baseUrl, pickingId),
  getProductStock:  (baseUrl, productIds)                => _rpc_getProductStock(baseUrl, productIds),
  fetchAgentsFromOdoo: (baseUrl, workflowNames, uid)    => _rpc_fetchAgentsFromOdoo(baseUrl, workflowNames, uid),
  fetchDailyDistributionReport: (baseUrl, targetDateKey, extraGroupBy) => _rpc_fetchDailyDistributionReport(baseUrl, targetDateKey, extraGroupBy),
  fetchJ1SalesReport: (baseUrl, targetDateKey, extraGroupBy) => _rpc_fetchJ1SalesReport(baseUrl, targetDateKey, extraGroupBy),
  fetchDailyCollectionsReport: (baseUrl, targetDateKey) => _rpc_fetchDailyCollectionsReport(baseUrl, targetDateKey),
  fetchReportRawSources: (baseUrl, theday, lookbackDays) => _rpc_fetchReportRawSources(baseUrl, theday, lookbackDays),
  debugInspectPickingReportFields: (baseUrl) => _rpc_debugInspectPickingReportFields(baseUrl),
  debugInspectPackagingFields: (baseUrl) => _rpc_debugInspectPackagingFields(baseUrl),
  debugInspectRouteFields: (baseUrl) => _rpc_debugInspectRouteFields(baseUrl),
  debugInspectPlanningEventFields: (baseUrl) => _rpc_debugInspectPlanningEventFields(baseUrl),
  abort() { _rpc_aborted = true; },
  debugRpc: (baseUrl, model, method, args, kwargs = {}) => _rpc_call(baseUrl, { model, method, args, kwargs }),
};
