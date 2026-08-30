// routes/sync.js
const express = require("express");
const { db } = require("../lib/firebaseAdmin");
const requireSession = require("../middleware/requireSession");

const router = express.Router();

const AGENTS_PERMISSIONS = [
  "agents.reorder",
  "agents.toggle",
  "agents.editLabels",
  "agents.import",
  "agents.clearAll",
];

function docRef(login) {
  return db.collection("customers").doc(login).collection("settings").doc("main");
}

// يرجع الدور والصلاحيات المحسوبة للجلسة الحالية — تُستدعى مرة واحدة
// بعد نجاح تسجيل الدخول لتعبئة App.permissions في الواجهة.
router.get("/me", requireSession, (req, res) => {
  res.json({
    login: req.login,
    role: req.role,
    permissions: req.permissions,
  });
});

router.get("/vendors", requireSession, async (req, res) => {
  try {
    const snap = await docRef(req.login).get();
    const data = snap.exists ? snap.data() : {};
    res.json({
      vendorOrder: data.vendorOrder || [],
      vendorLabels: data.vendorLabels || {},
      vendorEnabled: data.vendorEnabled || {},
      workflows: data.workflows || [],
      hiddenRoutes: data.hiddenRoutes || [],
      routeFilterFavourites: data.routeFilterFavourites || [],
      filterFavourites: data.filterFavourites || {},
      updated_at: data.updated_at || 0,
    });
  } catch (e) {
    console.error("[sync] GET /vendors failed:", e.message);
    res.status(500).json({ error: "sync_read_failed" });
  }
});

router.post("/vendors", requireSession, async (req, res) => {
  // ⚠️ فرض حقيقي: هذا المسار كان يقبل أي تعديل (ترتيب/تفعيل/labels) من أي
  // مستخدم مسجّل دخوله بغض النظر عن دوره — لأن hasPermission() في الواجهة
  // ليست سوى طبقة UI، وأي مستخدم يقدر يستدعي هذا المسار مباشرة من console
  // متجاوزًا كل فحوصات الواجهة. الفرض الفعلي يجب أن يكون هنا.
  const key = req.headers["x-app-permission"];
  const validKeys = [...AGENTS_PERMISSIONS, "settings.workflows"];
  if (!key || !validKeys.includes(key) || req.permissions[key] !== true) {
    return res.status(403).json({ error: "not_authorized" });
  }

  try {
    const patch = req.body || {};
    const allowedKeys = ["vendorOrder", "vendorLabels", "vendorEnabled", "workflows",
                         "hiddenRoutes", "routeFilterFavourites", "filterFavourites"];
    const clean = {};
    for (const k of allowedKeys) {
      if (patch[k] !== undefined) clean[k] = patch[k];
    }
    clean.updated_at = Date.now();

    await docRef(req.login).set(clean, { merge: true });
    res.json({ ok: true, updated_at: clean.updated_at });
  } catch (e) {
    console.error("[sync] POST /vendors failed:", e.message);
    res.status(500).json({ error: "sync_write_failed" });
  }
});

// /api/sync/report-settings/daily-distribution — تخزين خيار التجميع
// الإضافي (extraGroupBy) لتقرير التوزيع اليومي، لكل مستخدم (login).
function dailyDistribSettingsRef(login) {
  return db.collection("reportSettings").doc("dailyDistribution").collection("users").doc(login);
}

const ALLOWED_EXTRA_GROUPBY = ["product_tmpl_id", "categ_id", null];

router.get("/report-settings/daily-distribution", requireSession, async (req, res) => {
  try {
    const snap = await dailyDistribSettingsRef(req.login).get();
    const data = snap.exists ? snap.data() : {};
    res.json({ extraGroupBy: data.extraGroupBy || null });
  } catch (e) {
    console.error("[sync] GET /report-settings/daily-distribution failed:", e.message);
    res.status(500).json({ error: "sync_read_failed" });
  }
});

router.post("/report-settings/daily-distribution", requireSession, async (req, res) => {
  const extraGroupBy = req.body?.extraGroupBy ?? null;
  if (!ALLOWED_EXTRA_GROUPBY.includes(extraGroupBy)) {
    return res.status(400).json({ error: "invalid_extraGroupBy" });
  }
  try {
    await dailyDistribSettingsRef(req.login).set({
      extraGroupBy,
      updatedAt: Date.now(),
      updatedBy: req.login,
    }, { merge: true });
    res.json({ ok: true, extraGroupBy });
  } catch (e) {
    console.error("[sync] POST /report-settings/daily-distribution failed:", e.message);
    res.status(500).json({ error: "sync_write_failed" });
  }
});

// /api/sync/custom-categories — فئات مخصصة (Custom Categories) لنظام
// Report Builder: كل فئة = مجموعة منتجات (product_tmpl_id) يختارها المستخدم
// يدويًا من Odoo، بأسماء خاصة به. مخزّنة لكل مستخدم على حدة (req.login).
function customCategoriesCol(login) {
  return db.collection("customCategories").doc(login).collection("categories");
}

router.get("/custom-categories", requireSession, async (req, res) => {
  try {
    const snap = await customCategoriesCol(req.login).get();
    const categories = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ categories });
  } catch (e) {
    console.error("[sync] GET /custom-categories failed:", e.message);
    res.status(500).json({ error: "sync_read_failed" });
  }
});

router.post("/custom-categories", requireSession, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const productIds = Array.isArray(req.body?.productIds)
    ? req.body.productIds.map(Number).filter(n => Number.isInteger(n))
    : [];
  if (!name) return res.status(400).json({ error: "name_required" });

  try {
    const now = Date.now();
    const docRef = customCategoriesCol(req.login).doc();
    const data = { name, productIds, createdAt: now, updatedAt: now };
    await docRef.set(data);
    res.json({ id: docRef.id, ...data });
  } catch (e) {
    console.error("[sync] POST /custom-categories failed:", e.message);
    res.status(500).json({ error: "sync_write_failed" });
  }
});

router.put("/custom-categories/:id", requireSession, async (req, res) => {
  try {
    // ⚠️ فرض ملكية: المستند تحت customCategories/{req.login}/categories فهو
    // محصور بصاحبه بحكم المسار نفسه (لا يمكن لمستخدم آخر الوصول لمعرّف فئة
    // مستخدم آخر عبر هذا الراوت لأن customCategoriesCol تُبنى من req.login
    // فقط). نتحقق من الوجود قبل الكتابة لتفادي إنشاء مستند فارغ بالخطأ.
    const ref = customCategoriesCol(req.login).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });

    const patch = { updatedAt: Date.now() };
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || "").trim();
      if (!name) return res.status(400).json({ error: "name_required" });
      patch.name = name;
    }
    if (req.body?.productIds !== undefined) {
      if (!Array.isArray(req.body.productIds)) {
        return res.status(400).json({ error: "invalid_productIds" });
      }
      patch.productIds = req.body.productIds.map(Number).filter(n => Number.isInteger(n));
    }

    await ref.set(patch, { merge: true });
    const updated = await ref.get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (e) {
    console.error("[sync] PUT /custom-categories/:id failed:", e.message);
    res.status(500).json({ error: "sync_write_failed" });
  }
});

router.delete("/custom-categories/:id", requireSession, async (req, res) => {
  try {
    const ref = customCategoriesCol(req.login).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    await ref.delete();
    res.json({ ok: true });
  } catch (e) {
    console.error("[sync] DELETE /custom-categories/:id failed:", e.message);
    res.status(500).json({ error: "sync_write_failed" });
  }
});

// /api/sync/custom-seller-categories — فئات بائعين مخصصة (Custom Seller
// Categories)، بنفس مبدأ customCategories تمامًا لكن كل فئة = مجموعة بائعين
// (res.users id) بدل منتجات. مخزّنة لكل مستخدم على حدة (req.login).
function customSellerCategoriesCol(login) {
  return db.collection("customSellerCategories").doc(login).collection("categories");
}

router.get("/custom-seller-categories", requireSession, async (req, res) => {
  try {
    const snap = await customSellerCategoriesCol(req.login).get();
    const categories = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ categories });
  } catch (e) {
    console.error("[sync] GET /custom-seller-categories failed:", e.message);
    res.status(500).json({ error: "sync_read_failed" });
  }
});

router.post("/custom-seller-categories", requireSession, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const sellerIds = Array.isArray(req.body?.sellerIds)
    ? req.body.sellerIds.map(Number).filter(n => Number.isInteger(n))
    : [];
  if (!name) return res.status(400).json({ error: "name_required" });

  try {
    const now = Date.now();
    const docRef = customSellerCategoriesCol(req.login).doc();
    const data = { name, sellerIds, createdAt: now, updatedAt: now };
    await docRef.set(data);
    res.json({ id: docRef.id, ...data });
  } catch (e) {
    console.error("[sync] POST /custom-seller-categories failed:", e.message);
    res.status(500).json({ error: "sync_write_failed" });
  }
});

router.put("/custom-seller-categories/:id", requireSession, async (req, res) => {
  try {
    // ⚠️ فرض ملكية: نفس منطق customCategories — المسار محصور بـ req.login.
    const ref = customSellerCategoriesCol(req.login).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });

    const patch = { updatedAt: Date.now() };
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || "").trim();
      if (!name) return res.status(400).json({ error: "name_required" });
      patch.name = name;
    }
    if (req.body?.sellerIds !== undefined) {
      if (!Array.isArray(req.body.sellerIds)) {
        return res.status(400).json({ error: "invalid_sellerIds" });
      }
      patch.sellerIds = req.body.sellerIds.map(Number).filter(n => Number.isInteger(n));
    }

    await ref.set(patch, { merge: true });
    const updated = await ref.get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (e) {
    console.error("[sync] PUT /custom-seller-categories/:id failed:", e.message);
    res.status(500).json({ error: "sync_write_failed" });
  }
});

router.delete("/custom-seller-categories/:id", requireSession, async (req, res) => {
  try {
    const ref = customSellerCategoriesCol(req.login).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    await ref.delete();
    res.json({ ok: true });
  } catch (e) {
    console.error("[sync] DELETE /custom-seller-categories/:id failed:", e.message);
    res.status(500).json({ error: "sync_write_failed" });
  }
});

// /api/sync/custom-pricelist-categories — فئات قوائم أسعار مخصصة (Custom
// Pricelist Categories)، بنفس مبدأ customSellerCategories تمامًا لكن كل فئة =
// مجموعة قوائم أسعار (product.pricelist id) بدل بائعين. مخزّنة لكل مستخدم على
// حدة (req.login).
function customPricelistCategoriesCol(login) {
  return db.collection("customPricelistCategories").doc(login).collection("categories");
}

router.get("/custom-pricelist-categories", requireSession, async (req, res) => {
  try {
    const snap = await customPricelistCategoriesCol(req.login).get();
    const categories = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ categories });
  } catch (e) {
    console.error("[sync] GET /custom-pricelist-categories failed:", e.message);
    res.status(500).json({ error: "sync_read_failed" });
  }
});

router.post("/custom-pricelist-categories", requireSession, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const pricelistIds = Array.isArray(req.body?.pricelistIds)
    ? req.body.pricelistIds.map(Number).filter(n => Number.isInteger(n))
    : [];
  if (!name) return res.status(400).json({ error: "name_required" });

  try {
    const now = Date.now();
    const docRef = customPricelistCategoriesCol(req.login).doc();
    const data = { name, pricelistIds, createdAt: now, updatedAt: now };
    await docRef.set(data);
    res.json({ id: docRef.id, ...data });
  } catch (e) {
    console.error("[sync] POST /custom-pricelist-categories failed:", e.message);
    res.status(500).json({ error: "sync_write_failed" });
  }
});

router.put("/custom-pricelist-categories/:id", requireSession, async (req, res) => {
  try {
    // ⚠️ فرض ملكية: نفس منطق customSellerCategories — المسار محصور بـ req.login.
    const ref = customPricelistCategoriesCol(req.login).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });

    const patch = { updatedAt: Date.now() };
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || "").trim();
      if (!name) return res.status(400).json({ error: "name_required" });
      patch.name = name;
    }
    if (req.body?.pricelistIds !== undefined) {
      if (!Array.isArray(req.body.pricelistIds)) {
        return res.status(400).json({ error: "invalid_pricelistIds" });
      }
      patch.pricelistIds = req.body.pricelistIds.map(Number).filter(n => Number.isInteger(n));
    }

    await ref.set(patch, { merge: true });
    const updated = await ref.get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (e) {
    console.error("[sync] PUT /custom-pricelist-categories/:id failed:", e.message);
    res.status(500).json({ error: "sync_write_failed" });
  }
});

router.delete("/custom-pricelist-categories/:id", requireSession, async (req, res) => {
  try {
    const ref = customPricelistCategoriesCol(req.login).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    await ref.delete();
    res.json({ ok: true });
  } catch (e) {
    console.error("[sync] DELETE /custom-pricelist-categories/:id failed:", e.message);
    res.status(500).json({ error: "sync_write_failed" });
  }
});

// /api/sync/custom-report-templates — قوالب Report Builder (Grid حر):
// كل قالب = { name, rows, cols, cellsData, merges, styles, hiddenRows, hiddenCols,
// colWidths, rowHeights, freezeRow, freezeCol, hideGridlines }
// يخزّنه المستخدم لاستعادته لاحقًا. مخزّنة لكل مستخدم على حدة (req.login)،
// بنفس نمط customCategories تمامًا.
// hiddenRows/hiddenCols: مصفوفتا أرقام صفوف/أعمدة (0-based) معلَّمة "مخفي
// عند التقرير فقط" — reportViewer.js يتجاهل رسمها كليًا، بينما تبقى ظاهرة
// (بنمط مميز) داخل مصمم القوالب reportBuilder.js.
function customReportTemplatesCol(login) {
  return db.collection("customReportTemplates").doc(login).collection("templates");
}

router.get("/custom-report-templates", requireSession, async (req, res) => {
  try {
    const snap = await customReportTemplatesCol(req.login).get();
    const templates = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ templates });
  } catch (e) {
    console.error("[sync] GET /custom-report-templates failed:", e.message);
    res.status(500).json({ error: "sync_read_failed" });
  }
});

router.post("/custom-report-templates", requireSession, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name_required" });

  const rows = Number.isInteger(req.body?.rows) ? req.body.rows : 10;
  const cols = Number.isInteger(req.body?.cols) ? req.body.cols : 10;
  const cellsData = (req.body?.cellsData && typeof req.body.cellsData === "object") ? req.body.cellsData : {};
  const merges = Array.isArray(req.body?.merges) ? req.body.merges : [];
  const styles = (req.body?.styles && typeof req.body.styles === "object") ? req.body.styles : {};
  // نسخة Luckysheet الأصلية الكاملة (بكل التنسيقات) لإعادة فتحها في مصمم
  // القوالب لاحقًا بدقة كاملة — منفصلة عن styles (المستعملة من reportViewer.js
  // بصيغة قديمة مختلفة لكل خلية) حتى لا يتعطّل أي منهما.
  const luckysheetNative = (req.body?.luckysheetNative && typeof req.body.luckysheetNative === "object") ? req.body.luckysheetNative : null;
  const hiddenRows = Array.isArray(req.body?.hiddenRows) ? req.body.hiddenRows.filter(Number.isInteger) : [];
  const hiddenCols = Array.isArray(req.body?.hiddenCols) ? req.body.hiddenCols.filter(Number.isInteger) : [];
  const colWidths = (req.body?.colWidths && typeof req.body.colWidths === "object") ? req.body.colWidths : {};
  const rowHeights = (req.body?.rowHeights && typeof req.body.rowHeights === "object") ? req.body.rowHeights : {};
  const freezeRow = !!req.body?.freezeRow;
  const freezeCol = !!req.body?.freezeCol;
  const hideGridlines = !!req.body?.hideGridlines;

  try {
    // منع تكرار اسم القالب لنفس المستخدم (مقارنة case-insensitive بعد trim)
    const existingSnap = await customReportTemplatesCol(req.login).get();
    const nameLower = name.toLowerCase();
    const dup = existingSnap.docs.some(doc => String(doc.data()?.name || "").trim().toLowerCase() === nameLower);
    if (dup) return res.status(409).json({ error: "duplicate_name", message: "يوجد قالب بهذا الاسم مسبقًا" });

    const now = Date.now();
    const docRef = customReportTemplatesCol(req.login).doc();
    const data = { name, rows, cols, cellsData, merges, styles, luckysheetNative, hiddenRows, hiddenCols, colWidths, rowHeights, freezeRow, freezeCol, hideGridlines, createdAt: now, updatedAt: now };
    await docRef.set(data);
    res.json({ id: docRef.id, ...data });
  } catch (e) {
    console.error("[sync] POST /custom-report-templates failed:", e.message);
    res.status(500).json({ error: "sync_write_failed" });
  }
});

router.put("/custom-report-templates/:id", requireSession, async (req, res) => {
  try {
    // ⚠️ فرض ملكية: نفس منطق customCategories — المسار محصور بـ req.login.
    const ref = customReportTemplatesCol(req.login).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });

    const patch = { updatedAt: Date.now() };
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || "").trim();
      if (!name) return res.status(400).json({ error: "name_required" });
      patch.name = name;
    }
    if (Number.isInteger(req.body?.rows)) patch.rows = req.body.rows;
    if (Number.isInteger(req.body?.cols)) patch.cols = req.body.cols;
    if (req.body?.cellsData !== undefined) {
      if (typeof req.body.cellsData !== "object" || req.body.cellsData === null) {
        return res.status(400).json({ error: "invalid_cellsData" });
      }
      patch.cellsData = req.body.cellsData;
    }
    if (req.body?.merges !== undefined) {
      if (!Array.isArray(req.body.merges)) {
        return res.status(400).json({ error: "invalid_merges" });
      }
      patch.merges = req.body.merges;
    }
    if (req.body?.styles !== undefined) {
      if (typeof req.body.styles !== "object" || req.body.styles === null) {
        return res.status(400).json({ error: "invalid_styles" });
      }
      patch.styles = req.body.styles;
    }
    if (req.body?.luckysheetNative !== undefined) {
      patch.luckysheetNative = (req.body.luckysheetNative && typeof req.body.luckysheetNative === "object") ? req.body.luckysheetNative : null;
    }
    if (req.body?.hiddenRows !== undefined) {
      if (!Array.isArray(req.body.hiddenRows)) {
        return res.status(400).json({ error: "invalid_hiddenRows" });
      }
      patch.hiddenRows = req.body.hiddenRows.filter(Number.isInteger);
    }
    if (req.body?.hiddenCols !== undefined) {
      if (!Array.isArray(req.body.hiddenCols)) {
        return res.status(400).json({ error: "invalid_hiddenCols" });
      }
      patch.hiddenCols = req.body.hiddenCols.filter(Number.isInteger);
    }
    if (req.body?.colWidths !== undefined) {
      if (typeof req.body.colWidths !== "object" || req.body.colWidths === null) {
        return res.status(400).json({ error: "invalid_colWidths" });
      }
      patch.colWidths = req.body.colWidths;
    }
    if (req.body?.rowHeights !== undefined) {
      if (typeof req.body.rowHeights !== "object" || req.body.rowHeights === null) {
        return res.status(400).json({ error: "invalid_rowHeights" });
      }
      patch.rowHeights = req.body.rowHeights;
    }
    if (req.body?.freezeRow !== undefined) patch.freezeRow = !!req.body.freezeRow;
    if (req.body?.freezeCol !== undefined) patch.freezeCol = !!req.body.freezeCol;
    if (req.body?.hideGridlines !== undefined) patch.hideGridlines = !!req.body.hideGridlines;

    // ⚠️ set(patch, { merge:true }) كان يدمج بعمق (deep-merge) الحقول
    // المتداخلة (cellsData/styles كـmaps)، فلا يحذف مفاتيح موجودة بالنسخة
    // القديمة وغائبة عن النسخة الجديدة (مثل خلية حُذف محتواها بالواجهة) —
    // تبقى راجعة بقيمتها القديمة بعد إعادة التحميل. update() يستبدل قيمة
    // كل حقل بالكامل (بلا دمج عميق) لأنه مُمرَّر ككائن عادي بدون dot-notation.
    await ref.update(patch);
    const updated = await ref.get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (e) {
    console.error("[sync] PUT /custom-report-templates/:id failed:", e.message);
    res.status(500).json({ error: "sync_write_failed" });
  }
});

router.delete("/custom-report-templates/:id", requireSession, async (req, res) => {
  try {
    const ref = customReportTemplatesCol(req.login).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    await ref.delete();
    res.json({ ok: true });
  } catch (e) {
    console.error("[sync] DELETE /custom-report-templates/:id failed:", e.message);
    res.status(500).json({ error: "sync_write_failed" });
  }
});

module.exports = router;
