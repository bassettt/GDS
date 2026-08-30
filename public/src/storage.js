// ============================================================
// src/storage.js — PWA Storage (localStorage)
// replaces chrome.storage.local with synchronous localStorage
// wrapped in async API to keep callers compatible
// ============================================================

const KEYS = {
  SETTINGS:     "wafa_settings",
  VENDOR_LINKS: "wafa_vendorLinks",
  VENDOR_STATS: "wafa_vendorStats",
  VENDOR_REFS:  "wafa_vendorRefs",
  ROUND_STATUS: "wafa_roundStatus",
  ODOO_STATE:   "wafa_odooState",
  USER_STATUS:  "wafa_userStatus",
};

const DEFAULT_SETTINGS = {
  baseUrlPayment: "",
  maxTabs: 3, stealthMode: true, fontSize: 11,
  cardWidth: 380, cardHeight: 160, cardScale: 100,
  cardSize: 80, cols: 0, colsFullpage: 0, iconCols: 0,
  payShortcuts: [],
  pmRoutes: [],
  cardLayouts: {}, cardHeights: {},
  vendors: [],
  autoFetchEnabled: false,
  autoFetchInterval: 5,
  autoFetchPauseBackground: false,
  filterFavourites: {},
};

// ── Helpers ──────────────────────────────────────────────────
function _read(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[Storage] read "${key}":`, e);
    return fallback;
  }
}

const VENDOR_STATS_RETENTION_DAYS = 30;

// يحذف مفاتيح التواريخ الأقدم من مدة الاحتفاظ من كائن vendorStats {dateKey: {...}}
function _pruneVendorStats(stats) {
  if (!stats || typeof stats !== "object") return stats;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - VENDOR_STATS_RETENTION_DAYS);
  const cutoffKey = cutoff.toISOString().slice(0, 10); // "YYYY-MM-DD"
  for (const dateKey of Object.keys(stats)) {
    if (dateKey < cutoffKey) delete stats[dateKey];
  }
  return stats;
}

function _write(key, value) {
  try {
    if (key === KEYS.VENDOR_STATS) value = _pruneVendorStats(value);
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error(`[Storage] write "${key}":`, e);
    return false;
  }
}

// ── Public API (async-compatible wrappers) ───────────────────
const Storage = {
  KEYS,
  DEFAULT_SETTINGS,

  // Settings
  async getSettings() {
    return _read(KEYS.SETTINGS) ?? { ...DEFAULT_SETTINGS };
  },
  saveSettings(s)             { return Promise.resolve(_write(KEYS.SETTINGS, s)); },
  async updateSettings(patch) {
    const cur = await Storage.getSettings();
    return _write(KEYS.SETTINGS, { ...cur, ...patch });
  },

  // Vendor data
  getVendorLinks()   { return Promise.resolve(_read(KEYS.VENDOR_LINKS, {})); },
  saveVendorLinks(v) { return Promise.resolve(_write(KEYS.VENDOR_LINKS, v)); },
  getVendorStats()   { return Promise.resolve(_read(KEYS.VENDOR_STATS, {})); },
  saveVendorStats(v) { return Promise.resolve(_write(KEYS.VENDOR_STATS, v)); },
  getVendorRefs()    { return Promise.resolve(_read(KEYS.VENDOR_REFS,  {})); },
  saveVendorRefs(v)  { return Promise.resolve(_write(KEYS.VENDOR_REFS,  v)); },
 getRoundStatus()   { return Promise.resolve(_read(KEYS.ROUND_STATUS, {})); },
  saveRoundStatus(v) { return Promise.resolve(_write(KEYS.ROUND_STATUS, v)); },
  getOdooState()     { return Promise.resolve(_read(KEYS.ODOO_STATE,  {})); },
  saveOdooState(v)   { return Promise.resolve(_write(KEYS.ODOO_STATE,  v)); },
  getUserStatus()    { return Promise.resolve(_read(KEYS.USER_STATUS, {})); },
  saveUserStatus(v)  { return Promise.resolve(_write(KEYS.USER_STATUS, v)); },

  // Bulk read
  async getMany(keys) {
    const result = {};
    const keyMap = {
      settings:    KEYS.SETTINGS,
      vendorLinks: KEYS.VENDOR_LINKS,
      vendorStats: KEYS.VENDOR_STATS,
      vendorRefs:  KEYS.VENDOR_REFS,
      roundStatus: KEYS.ROUND_STATUS,
    };
    for (const k of keys) {
      const storageKey = keyMap[k] || k;
      result[k] = _read(storageKey, null);
    }
    return result;
  },

  // Bulk write
  async setMany(obj) {
    const keyMap = {
      settings:    KEYS.SETTINGS,
      vendorLinks: KEYS.VENDOR_LINKS,
      vendorStats: KEYS.VENDOR_STATS,
      vendorRefs:  KEYS.VENDOR_REFS,
      roundStatus: KEYS.ROUND_STATUS,
    };
    let ok = true;
    for (const [k, v] of Object.entries(obj)) {
      const storageKey = keyMap[k] || k;
      if (!_write(storageKey, v)) ok = false;
    }
    return ok;
  },

  // Generic get/set for extra keys
  get(key, fallback = null)  { return Promise.resolve(_read(key, fallback)); },
  set(key, value)            { return Promise.resolve(_write(key, value)); },
  remove(key)                { try { localStorage.removeItem(key); } catch(_){} return Promise.resolve(); },

  // Clear daily data
  async clearDailyData() {
    const today = new Date().toISOString().slice(0, 10);
    const cur = await Storage.getMany(["vendorLinks","vendorStats","vendorRefs","roundStatus"]);
    const links  = cur.vendorLinks  || {};
    const stats  = cur.vendorStats  || {};
    const refs   = cur.vendorRefs   || {};
    const status = cur.roundStatus  || {};
    delete links[today];
    delete stats[today];
    delete refs[today];
    delete status[today];
    return Storage.setMany({ vendorLinks: links, vendorStats: stats, vendorRefs: refs, roundStatus: status });
  },
};
