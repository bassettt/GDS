// ============================================================
// src/storage.js — GDS Storage (localStorage)
// ============================================================

const KEYS = {
  SETTINGS: "wafa_settings",
};

const DEFAULT_SETTINGS = {
  vendors: []
};

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

function _write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error(`[Storage] write "${key}":`, e);
    return false;
  }
}

const Storage = {
  KEYS,
  DEFAULT_SETTINGS,

  async getSettings() {
    return _read(KEYS.SETTINGS) ?? { ...DEFAULT_SETTINGS };
  },
  saveSettings(s) { return Promise.resolve(_write(KEYS.SETTINGS, s)); },

  async getMany(keys) {
    const result = {};
    for (const k of keys) {
      result[k] = _read(KEYS[k.toUpperCase()] || k, null);
    }
    return result;
  },

  get(key, fallback = null) { return Promise.resolve(_read(key, fallback)); },
  set(key, value)           { return Promise.resolve(_write(key, value)); },
  remove(key)               { try { localStorage.removeItem(key); } catch(_){} return Promise.resolve(); },
};
