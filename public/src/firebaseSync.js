// ============================================================
// src/firebaseSync.js — Vendors settings sync (via server /api/sync/*)
// لا يتصل بـ Firestore من المتصفح إطلاقًا. السيرفر (Admin SDK) وحده
// يتحدث مع Firestore، ويعرف هوية المستخدم من كوكي app_session.
// نفس الواجهة العامة القديمة (الأسماء والمعاملات) للحفاظ على توافق app.js.
// ============================================================

const FirebaseSync = (() => {

  const SYNC_URL = "/api/sync/vendors";
  const META_KEY = "wafa_settings_meta";
  const DEVICE_ID_KEY = "wafa_device_id";

  // هذه المفاتيح تبقى في localStorage فقط — لا تُرسل أبداً للسيرفر
  const LOCAL_ONLY_KEYS = ["vendors"];

  // ── Device identity ────────────────────────────────────────
  function getDeviceId() {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = "dev_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  }

  function getDeviceType() {
    const ua = (navigator.userAgent || "").toLowerCase();
    const uaMobile = /android|iphone|ipad|ipod|mobile/.test(ua);
    const smallScreen = Math.min(window.innerWidth || 9999, window.innerHeight || 9999) <= 480;
    return (uaMobile || smallScreen) ? "mobile" : "desktop";
  }

  // ── UI indicator (#fsIndicator / #fsLabel) ─────────────────────
  function _setIndicator(state, label) {
    const el = document.getElementById("fsIndicator");
    const lbl = document.getElementById("fsLabel");
    if (!el) return;
    el.classList.remove("fs-indicator--idle", "fs-indicator--syncing", "fs-indicator--synced", "fs-indicator--error");
    el.classList.add("fs-indicator--" + state);
    if (lbl) lbl.textContent = label;
    if (state === "synced") {
      const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      el.title = "Dernière synchro : " + t;
    } else if (state === "error") {
      el.title = "Erreur de synchronisation — hors-ligne ?";
    } else if (state === "syncing") {
      el.title = "Synchronisation en cours…";
    }
  }

  // ── Local sync metadata ────────────────────────────────────
  function getLocalMeta() {
    try {
      return JSON.parse(localStorage.getItem(META_KEY)) || { updated_at: 0, updated_by_device: null };
    } catch (_) {
      return { updated_at: 0, updated_by_device: null };
    }
  }

  function setLocalMeta(meta) {
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (_) {}
  }

  // ── Split / merge (نفس شكل البيانات القديم) ───────────────────
  function splitSettings(settings) {
    const shared = {};
    if (Array.isArray(settings?.vendors)) {
      shared.vendorOrder   = settings.vendors.map(v => v.workerId).filter(Boolean);
      shared.vendorLabels  = Object.fromEntries(
        settings.vendors.filter(v => v.workerId && v.label).map(v => [v.workerId, v.label])
      );
      shared.vendorEnabled = Object.fromEntries(
        settings.vendors.filter(v => v.workerId).map(v => [v.workerId, v.enabled ?? true])
      );
    }
    if (Array.isArray(settings?.workflows)) {
      shared.workflows = settings.workflows;
    }
    if (Array.isArray(settings?.hiddenRoutes)) {
      shared.hiddenRoutes = settings.hiddenRoutes;
    }
    if (Array.isArray(settings?.routeFilterFavourites)) {
      shared.routeFilterFavourites = settings.routeFilterFavourites;
    }
    if (settings?.filterFavourites && typeof settings.filterFavourites === "object") {
      shared.filterFavourites = settings.filterFavourites;
    }
    return { shared, display: {} };
  }

  function mergeSettings(shared, display) {
    const cleanShared  = { ...(shared  || {}) };
    const cleanDisplay = { ...(display || {}) };
    LOCAL_ONLY_KEYS.forEach(k => { delete cleanShared[k]; delete cleanDisplay[k]; });
    return { ...cleanShared, ...cleanDisplay };
  }

  // ── Remote read ─────────────────────────────────────────────
  async function fetchRemoteDoc() {
    try {
      const res = await fetch(SYNC_URL, { credentials: "include" });
      if (!res.ok) return null;
      const data = await res.json();
      // شكل يشبه القديم: { shared: {...}, updated_at }
      return {
        shared: {
          vendorOrder: data.vendorOrder,
          vendorLabels: data.vendorLabels,
          vendorEnabled: data.vendorEnabled,
          workflows: data.workflows,
          hiddenRoutes: data.hiddenRoutes,
          routeFilterFavourites: data.routeFilterFavourites,
          filterFavourites: data.filterFavourites,
        },
        updated_at: data.updated_at || 0,
      };
    } catch (e) {
      console.error("[FirebaseSync] fetchRemoteDoc failed:", e);
      return null;
    }
  }

  // ── Remote write (merge على السيرفر) ───────────────────────────
  async function pushSharedUpdate(sharedPatch, permission) {
    _setIndicator("syncing", "Sync…");
    const device = getDeviceId();
    try {
      const headers = { "Content-Type": "application/json" };
      if (permission) headers["X-App-Permission"] = permission;
      const res = await fetch(SYNC_URL, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(sharedPatch),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      setLocalMeta({ updated_at: data.updated_at || Date.now(), updated_by_device: device });
      _setIndicator("synced", "Sync ✓");
      return true;
    } catch (e) {
      console.error("[FirebaseSync] pushSharedUpdate failed:", e);
      _setIndicator("error", "Erreur");
      return false;
    }
  }

  // ── Route-specific settings (hiddenRoutes, routeFilterFavourites) ──────
  // يستخدم permission "settings.workflows" الموجودة أصلاً — لتجنب الحاجة لإضافة
  // permission جديدة على السيرفر. hiddenRoutes وrouteFilterFavourites تُعامَل
  // كإعدادات مشتركة مثل workflows تمامًا.
  async function pushRouteSettings(patch) {
    return pushSharedUpdate(patch, "settings.workflows");
  }

  // لا يوجد display block بعد الآن (كان لكل جهاز) — يبقى للتوافق فقط، بلا تأثير.
  async function pushDisplayUpdate() {
    return true;
  }

  // One round-trip write of shared (vendors) — التوافق مع الاستدعاء القديم.
  async function pushFullUpdate(settings) {
    const { shared } = splitSettings(settings);
    if (!Object.keys(shared).length) return true;
    return pushSharedUpdate(shared, "settings.workflows");
  }

  // لا يوجد display block بعد الآن — يعيد الإعدادات كما هي.
  function applyDeviceDisplay(settings) {
    return settings;
  }

  // ── Applique un document distant (vendors + workflows) au local ──
  async function _applyRemote(remote) {
    const current = await Storage.getSettings();
    const newSettings = { ...current };

    const vendorOrder   = remote.shared?.vendorOrder;
    const vendorLabels  = remote.shared?.vendorLabels  || {};
    const vendorEnabled = remote.shared?.vendorEnabled || {};
    const workflows     = remote.shared?.workflows;
    const hiddenRoutes  = remote.shared?.hiddenRoutes;

    if (Array.isArray(vendorOrder))       newSettings.vendorOrder   = vendorOrder;
    if (vendorLabels  && typeof vendorLabels  === "object") newSettings.vendorLabels  = vendorLabels;
    if (vendorEnabled && typeof vendorEnabled === "object") newSettings.vendorEnabled = vendorEnabled;
    if (Array.isArray(workflows)) newSettings.workflows = workflows;
    if (Array.isArray(hiddenRoutes)) newSettings.hiddenRoutes = hiddenRoutes;

    const routeFilterFavourites = remote.shared?.routeFilterFavourites;
    if (Array.isArray(routeFilterFavourites)) newSettings.routeFilterFavourites = routeFilterFavourites;

    const filterFavourites = remote.shared?.filterFavourites;
    if (filterFavourites && typeof filterFavourites === "object") newSettings.filterFavourites = filterFavourites;

    if (Array.isArray(vendorOrder) && vendorOrder.length && Array.isArray(current.vendors) && current.vendors.length) {
      const applySync  = v => ({
        ...v,
        label:   vendorLabels[v.workerId]  ?? v.label,
        enabled: vendorEnabled[v.workerId] ?? v.enabled,
      });
      const vendorsMap = new Map(current.vendors.map(v => [v.workerId, v]));
      const ordered    = vendorOrder.map(id => vendorsMap.get(id)).filter(Boolean).map(applySync);
      const remaining  = current.vendors.filter(v => !vendorOrder.includes(v.workerId)).map(applySync);
      newSettings.vendors = [...ordered, ...remaining];
    }

    await Storage.saveSettings(newSettings);
    return newSettings;
  }

  // ── Startup sync: pull remote if newer than local ─────────────
  // ملاحظة: لم تعد تُستدعى تلقائيًا عند الإقلاع — فقط عند طلب صريح
  // (زر "تحميل من السحابة") عبر pullNow().
  async function syncOnStartup() {
    _setIndicator("syncing", "Sync…");
    const remote = await fetchRemoteDoc();
    if (!remote) {
      _setIndicator("error", "Hors-ligne");
      return; // offline / غير مصادَق / أول تشغيل — أبقِ المحلي كما هو
    }

    const local = getLocalMeta();
    const remoteUpdatedAt = remote.updated_at || 0;

    if (remoteUpdatedAt <= (local.updated_at || 0)) {
      _setIndicator("synced", "Sync ✓");
      return; // local already current
    }

    await _applyRemote(remote);
    setLocalMeta({ updated_at: remoteUpdatedAt, updated_by_device: null });
    _setIndicator("synced", "Sync ✓");
  }

  // ── Pull manuel forcé — زر "تحميل من السحابة" ───────────────────
  // على عكس syncOnStartup، يطبّق دائمًا محتوى السحابة عند الضغط على الزر
  // بغض النظر عن الطابع الزمني المحلي.
  async function pullNow() {
    _setIndicator("syncing", "Sync…");
    const remote = await fetchRemoteDoc();
    if (!remote) {
      _setIndicator("error", "Hors-ligne");
      return false;
    }
    await _applyRemote(remote);
    setLocalMeta({ updated_at: remote.updated_at || Date.now(), updated_by_device: null });
    _setIndicator("synced", "Sync ✓");
    return true;
  }

  return {
    getDeviceId, getDeviceType,
    splitSettings, mergeSettings,
    fetchRemoteDoc, pushSharedUpdate, pushDisplayUpdate, pushFullUpdate,
    pushRouteSettings,
    applyDeviceDisplay, syncOnStartup, pullNow,
    getLocalMeta, setLocalMeta,
  };
})();
