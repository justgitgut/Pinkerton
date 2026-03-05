/**
 * background.js — Pinkerton v3.5
 *
 * Service worker for the Pinkerton Chrome extension.
 * Runs persistently in the background (woken by alarms or messages).
 *
 * Responsibilities:
 *   - Schedule and run automatic scans via chrome.alarms
 *   - Fetch browse pages from PinaLove using the site's own AJAX endpoint
 *   - Parse the raw JS response to extract user thumbdata
 *   - Store scan results, activity history, and scan totals in chrome.storage.local
 *   - Respond to messages from popup.js and results.js
 *   - Purge old history data when storage pressure exceeds 90%
 */

/* ─── Constants ─────────────────────────────────────────────────────────────── */

const ALARM_NAME = 'pinalove_auto_scan';
const STORAGE_SCHEMA_VERSION = 6;

/* In-memory scan interval — overwritten from storage on every setupAlarm() call.
   Kept in memory so getAlarmStatus can return it without an extra storage read. */
let SCAN_INTERVAL_MINUTES = 5;

/* Flag set by a stop request so the running scan loop can exit cleanly
   after the current page fetch completes rather than mid-request. */
let _stopRequested = false;

/* How many days of per-user hourly history to retain before pruning. */
const HISTORY_DAYS = 30;
const HISTORY_SLOT_MINUTES = 15;
const HISTORY_SLOTS_PER_DAY = 96;
const HISTORY_PACK_PREFIX = 'p1:';
const MEMBER_FLAG_NEW = 1;
const MEMBER_FLAG_PREMIUM = 2;
const MEMBER_FLAG_VERIFIED = 4;

/* Scan diff bitmask for compact changelog entries [ts, mask]. */
const MEMBER_DIFF_PREMIUM = 1;
const MEMBER_DIFF_NEW = 2;
const MEMBER_DIFF_VERIFIED = 4;
const MEMBER_DIFF_AGE = 8;
const MEMBER_DIFF_LOCATION = 16;
const MEMBER_DIFF_PHOTO = 32;
const MEMBER_LOG_MAX = 10;

/* Base URL for all PinaLove requests. */
const BASE = 'https://www.pinalove.com';

/* How long to wait for a single page fetch before aborting.
 * PinaLove occasionally stalls indefinitely — without this the scan loop
 * would hang forever. An AbortError from the timeout is treated as fatal:
 * scanUntilOffline() discards all partial results rather than storing
 * incomplete data that would falsify the stats. */
const FETCH_TIMEOUT_MS = 15000;

/* ─── Alarm setup ────────────────────────────────────────────────────────────── */

/* Re-register the alarm whenever the extension installs or the browser starts.
   The alarm itself does nothing if autoScanEnabled is false in storage —
   that check happens inside setupAlarm(). */
chrome.runtime.onInstalled.addListener(() => {
  runStorageMigrationIfNeeded()
    .catch(err => console.warn('[Pinkerton] migration failed (install):', err.message))
    .finally(() => setupAlarm());
});
chrome.runtime.onStartup.addListener(() => {
  runStorageMigrationIfNeeded()
    .catch(err => console.warn('[Pinkerton] migration failed (startup):', err.message))
    .finally(() => setupAlarm());
});

/* Compact field schema used in pinalove_profiles.f */
const PROFILE_FIELD_KEY_MAP = {
  'Age': 'a',
  'Gender': 'g',
  'Height': 'h',
  'Weight': 'w',
  'Min. age': 'minA',
  'Max. age': 'maxA',
  'Education': 'edu',
  'City': 'city',
  'Country': 'ctry',
  'Looking for': 'look',
  'Relationship': 'rel',
  'Children': 'child',
  'Religion': 'relig',
};

function packProfileFields(fields = {}) {
  const packed = {};
  for (const [label, val] of Object.entries(fields || {})) {
    if (val == null || val === '') continue;
    packed[PROFILE_FIELD_KEY_MAP[label] || label] = val;
  }
  return packed;
}

/* Normalize to canonical photo ID: YYYY-MM/user/hash-browse */
function canonicalPhotoId(uri) {
  if (!uri || typeof uri !== 'string') return null;
  let path = uri;
  const pIdx = path.indexOf('/p/');
  if (pIdx >= 0) path = path.slice(pIdx + 3);
  path = path
    .replace(/^\/+/, '')
    .replace(/-(big|browse|card|medium)(x\d+)?(\.[a-z]+)?$/, '')
    .replace(/\.(jpg|avif|webp)$/i, '');
  if (!path) return null;
  if (!path.endsWith('-browse')) path += '-browse';
  return path.replace(/\/+$/, '');
}

function memberFlags(isNew, isPremium, isVerified) {
  let f = 0;
  if (isNew) f |= MEMBER_FLAG_NEW;
  if (isPremium) f |= MEMBER_FLAG_PREMIUM;
  if (isVerified) f |= MEMBER_FLAG_VERIFIED;
  return f;
}

function ensureLocationIndex(location, locations, locationToIndex) {
  const loc = (location || '').trim();
  if (!loc) return null;
  if (locationToIndex.has(loc)) return locationToIndex.get(loc);
  const idx = locations.length;
  locations.push(loc);
  locationToIndex.set(loc, idx);
  return idx;
}

function normalizeMemberLog(rawLog = null) {
  if (Array.isArray(rawLog) && rawLog.every(v => Array.isArray(v) && v.length >= 2)) {
    return rawLog
      .map(v => [Number(v[0]) || 0, Number(v[1]) || 0])
      .filter(v => v[0] > 0 && v[1] > 0)
      .slice(-MEMBER_LOG_MAX);
  }

  if (Array.isArray(rawLog)) {
    const out = [];
    for (const item of rawLog) {
      const changes = item?.changes || {};
      let mask = 0;
      if (changes.isPremium)  mask |= MEMBER_DIFF_PREMIUM;
      if (changes.isNew)      mask |= MEMBER_DIFF_NEW;
      if (changes.isVerified) mask |= MEMBER_DIFF_VERIFIED;
      if (changes.age)        mask |= MEMBER_DIFF_AGE;
      if (changes.location)   mask |= MEMBER_DIFF_LOCATION;
      if (changes.photoUrl)   mask |= MEMBER_DIFF_PHOTO;
      const ts = Number(item?.ts) || 0;
      if (ts > 0 && mask > 0) out.push([ts, mask]);
    }
    return out.slice(-MEMBER_LOG_MAX);
  }

  return [];
}

function compactMemberEntry(raw, username, locations, locationToIndex) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const isCompact = ('sc' in src) || ('ls' in src) || ('f' in src) || ('l' in src);

  if (isCompact) {
    const locIdx = (typeof src.l === 'number')
      ? src.l
      : ensureLocationIndex(src.location || '', locations, locationToIndex);
    return {
      a: src.a ?? src.age ?? null,
      l: (typeof locIdx === 'number') ? locIdx : null,
      p: src.p || canonicalPhotoId(src.photoUrl) || '',
      f: Number.isInteger(src.f) ? src.f : memberFlags(src.isNew, src.isPremium, src.isVerified),
      j: src.j ?? src.joinMonth ?? null,
      ls: src.ls ?? src.lastSeen ?? src.sc ?? src.lastScanned ?? 0,
      fs: src.fs ?? src.firstSeen ?? src.sc ?? src.lastScanned ?? 0,
      sc: src.sc ?? src.lastScanned ?? 0,
      g: normalizeMemberLog(src.g ?? src.changelog),
    };
  }

  return {
    a: src.age ?? null,
    l: ensureLocationIndex(src.location || '', locations, locationToIndex),
    p: canonicalPhotoId(src.photoUrl) || '',
    f: memberFlags(!!src.isNew, !!src.isPremium, !!src.isVerified),
    j: src.joinMonth ?? null,
    ls: src.lastSeen ?? src.lastScanned ?? 0,
    fs: src.firstSeen ?? src.lastScanned ?? 0,
    sc: src.lastScanned ?? 0,
    g: normalizeMemberLog(src.changelog),
  };
}

function compactLocationDictionary(members, locations) {
  const used = new Set();
  for (const m of Object.values(members)) {
    if (typeof m?.l === 'number' && m.l >= 0 && m.l < locations.length) used.add(m.l);
  }

  const remap = new Map();
  const compactLocs = [];
  for (let i = 0; i < locations.length; i++) {
    if (!used.has(i)) continue;
    remap.set(i, compactLocs.length);
    compactLocs.push(locations[i]);
  }

  for (const m of Object.values(members)) {
    if (typeof m?.l !== 'number') { m.l = null; continue; }
    m.l = remap.has(m.l) ? remap.get(m.l) : null;
  }

  return compactLocs;
}

function migrateProfileEntry(raw) {
  const old = raw || {};
  const snapshots = Array.isArray(old.snapshots) ? old.snapshots : [];
  const lastSnap = snapshots.filter(s => !s.photoChange).slice(-1)[0] || {};

  const title = old.t ?? old.title ?? lastSnap.title ?? '';
  const bio = old.b ?? old.bio ?? lastSnap.bio ?? '';
  const joinMonth = old.jm ?? old.joinMonth ?? null;

  const packedFields = old.f
    ? old.f
    : packProfileFields(old.fields || lastSnap.fields || {});

  const rawPhotos = Array.isArray(old.p)
    ? old.p
    : (Array.isArray(old.photos) ? old.photos : []);
  const photos = [...new Set(rawPhotos.map(canonicalPhotoId).filter(Boolean))];

  const diffs = Array.isArray(old.d)
    ? old.d
    : (Array.isArray(old.diffs) ? old.diffs : []);

  return { f: packedFields, t: title, b: bio, p: photos, d: diffs, jm: joinMonth };
}

async function runStorageMigrationIfNeeded() {
  return new Promise(resolve => {
    const keys = ['pinalove_schema_version', 'pinalove_members', 'pinalove_member_locations', 'pinalove_profiles', 'pinalove_history'];
    chrome.storage.local.get(keys, data => {
      const current = data.pinalove_schema_version || 0;
      if (current >= STORAGE_SCHEMA_VERSION) return resolve();

      const oldMembers = data.pinalove_members || {};
      const locations = Array.isArray(data.pinalove_member_locations) ? [...data.pinalove_member_locations] : [];
      const locationToIndex = new Map(locations.map((v, i) => [v, i]));
      const members = {};
      for (const [username, raw] of Object.entries(oldMembers)) {
        members[username] = compactMemberEntry(raw, username, locations, locationToIndex);
      }
      const compactLocations = compactLocationDictionary(members, locations);

      const oldProfiles = data.pinalove_profiles || {};
      const newProfiles = {};
      for (const [username, raw] of Object.entries(oldProfiles)) {
        newProfiles[username] = migrateProfileEntry(raw);
      }

      const oldHistory = data.pinalove_history || {};
      const newHistory = {};
      for (const [username, userDays] of Object.entries(oldHistory)) {
        if (!userDays || typeof userDays !== 'object') continue;
        const migratedDays = {};
        for (const [day, dayBuckets] of Object.entries(userDays)) {
          const slots = toQuarterSlots96(dayBuckets);
          if (slots.some(v => v > 0)) migratedDays[day] = encodeQuarterSlots(slots);
        }
        if (Object.keys(migratedDays).length) newHistory[username] = migratedDays;
      }

      chrome.storage.local.set({
        pinalove_members: members,
        pinalove_member_locations: compactLocations,
        pinalove_profiles: newProfiles,
        pinalove_history: newHistory,
        pinalove_schema_version: STORAGE_SCHEMA_VERSION,
      }, () => {
        chrome.storage.local.remove('pinalove_records', () => {
          console.log('[Pinkerton] storage migration complete -> schema', STORAGE_SCHEMA_VERSION);
          resolve();
        });
      });
    });
  });
}

/**
 * Create (or recreate) the periodic scan alarm.
 *
 * Reads autoScanEnabled and scanInterval from storage before acting.
 * If auto-scan is disabled, clears any existing alarm and returns early.
 * If forceInterval is provided (e.g. from setScanInterval), that value
 * takes priority over the stored one.
 *
 * @param {number} [forceInterval] - Override interval in minutes (1-5).
 */
function setupAlarm(forceInterval) {
  /* Normalise the forced value — only treat it as an override if it's a number. */
  const forced = (typeof forceInterval === 'number') ? forceInterval : null;

  chrome.storage.local.get('pinalove_settings', data => {
    const s    = data.pinalove_settings || {};
    /* Clamp interval to [1, 5] minutes. */
    const mins = Math.min(5, Math.max(1, forced ?? s.scanInterval ?? SCAN_INTERVAL_MINUTES));
    SCAN_INTERVAL_MINUTES = mins;

    if (!s.autoScanEnabled) {
      /* User has disabled auto-scan — remove any lingering alarm. */
      chrome.alarms.clear(ALARM_NAME);
      return;
    }

    /* Clear first to avoid duplicate alarms, then recreate with the correct interval. */
    chrome.alarms.clear(ALARM_NAME, () => {
      chrome.alarms.create(ALARM_NAME, {
        delayInMinutes:  mins,
        periodInMinutes: mins,
      });
    });
  });
}

/* Fire a scan whenever our named alarm triggers. */
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) scanAllPinaLoveTabs();
});

/* ─── General helpers ────────────────────────────────────────────────────────── */

/** Simple promise-based delay. Used for polite inter-page fetch spacing. */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Write a progress snapshot to storage so the popup can read it.
 * The popup watches pinalove_scan_progress via chrome.storage.onChanged.
 *
 * Progress object shape:
 *   { type: 'progress'|'done'|'error'|'info', ts, ...fields }
 *
 * @param {object} data - Progress payload (type and any extra fields).
 * @returns {Promise<void>}
 */
function setProgress(data) {
  return new Promise(resolve =>
    chrome.storage.local.set({ pinalove_scan_progress: { ...data, ts: Date.now() } }, resolve)
  );
}

/**
 * Inject content.js into a tab (silently ignoring if already injected),
 * then send it a message and await its response.
 *
 * @param {number} tabId
 * @param {string} action - Message action string.
 * @param {object} [extra] - Additional message fields.
 * @returns {Promise<any>}
 */
async function injectAndSend(tabId, action, extra = {}) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (_) {
    /* Injection fails silently when content.js is already present — that's fine. */
  }
  await sleep(300);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timeout waiting for content script')),
      15000
    );
    chrome.tabs.sendMessage(tabId, { action, ...extra }, res => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!res) reject(new Error('Empty response from content script'));
      else resolve(res);
    });
  });
}

/**
 * Wait for a tab to finish loading (status === 'complete').
 * Falls back after 20 seconds to avoid hanging indefinitely.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError || !tab) { resolve(); return; }
      if (tab.status === 'complete') { resolve(); return; }

      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }, 20000);

      function onUpdated(id, info) {
        if (id === tabId && info.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

/* ─── City normalisation ─────────────────────────────────────────────────────── */

/**
 * Normalise a raw city string from the PinaLove API into a clean,
 * consistently-capitalised key suitable for lookup in PH_CITY_COORDS.
 *
 * Steps:
 *   1. Lower-case and strip trailing suffixes (e.g. " city", " province").
 *   2. Resolve known aliases to a single canonical form (e.g. "qc" -> "Quezon City").
 *   3. Title-case the result.
 *
 * @param {string} raw - Raw city value from the API (e.g. "cebu city", "CDO").
 * @returns {string} Normalised city name, or '' if input is empty.
 */
function normalizeCity(raw) {
  if (!raw) return '';
  let c = raw.trim().toLowerCase();

  /* Strip common geographic suffixes so "Davao City" and "Davao" both normalise to "Davao". */
  const suffixes = [' city', ' municipality', ' province', ' metro'];
  let base = c;
  for (const s of suffixes) {
    if (c.endsWith(s)) { base = c.slice(0, -s.length).trim(); break; }
  }

  /* Alias table: canonical name -> list of alternate spellings / abbreviations. */
  const aliases = {
    'manila':         ['metro manila', 'ncr', 'national capital region'],
    'cebu':           ['cebu city', 'cebu'],
    'davao':          ['davao city'],
    'quezon city':    ['qc', 'quezon'],
    'makati':         ['makati city'],
    'pasig':          ['pasig city'],
    'taguig':         ['taguig city', 'bgc', 'bonifacio global city'],
    'angeles':        ['angeles city', 'pampanga angeles'],
    'bacolod':        ['bacolod city'],
    'iloilo':         ['iloilo city'],
    'cagayan de oro': ['cdo', 'cagayan de oro city'],
    'zamboanga':      ['zamboanga city'],
    'general santos': ['gensan', 'general santos city'],
    'baguio':         ['baguio city'],
  };

  for (const [canonical, alts] of Object.entries(aliases)) {
    if (base === canonical || alts.includes(base) || alts.includes(c)) {
      return canonical.replace(/\b\w/g, l => l.toUpperCase());
    }
  }

  /* No alias match — title-case whatever base we have. */
  return base.replace(/\b\w/g, l => l.toUpperCase());
}

/* ─── Philippine timezone helpers ───────────────────────────────────────────── */

/* PH is UTC+8. We add this offset before calling UTC date methods so that
   "today in Manila" is computed correctly regardless of the machine's locale. */
const PH_OFFSET_MS = 8 * 3600 * 1000;

/**
 * Convert a Unix timestamp to a "YYYY-MM-DD" string in Philippine time.
 * @param {number} ts - Unix timestamp in milliseconds.
 * @returns {string} e.g. "2025-09-14"
 */
function tsToPhDay(ts) {
  const d = new Date(ts + PH_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

/**
 * Return the hour (0-23) of a timestamp in Philippine time.
 * @param {number} ts
 * @returns {number}
 */
function tsToPhHour(ts) { return new Date(ts + PH_OFFSET_MS).getUTCHours(); }

/**
 * Return the 15-minute slot index (0-95) of a timestamp in Philippine time.
 * slot 0 = 00:00-00:14, slot 95 = 23:45-23:59.
 *
 * @param {number} ts
 * @returns {number}
 */
function tsToPhQuarterSlot(ts) {
  const d = new Date(ts + PH_OFFSET_MS);
  return (d.getUTCHours() * 4) + Math.floor(d.getUTCMinutes() / 15);
}

/* ─── History tracking ───────────────────────────────────────────────────────── */

/*
 * History storage format (pinalove_history):
 *   {
 *     [username]: {
 *       "YYYY-MM-DD": "p1:<base64>", // packed 96-slot (15-min) minute buckets
 *       ...
 *     },
 *     ...
 *   }
 *
 * Each scan credits SCAN_INTERVAL_MINUTES to the bucket for the current
 * PH day and 15-minute slot, capped at 15 minutes per slot to prevent over-counting.
 * Day buckets older than HISTORY_DAYS are pruned after every write.
 */

function addLegacyHourToQuarterSlots(slots, hour, minsRaw) {
  const mins = Math.max(0, Math.min(60, Math.round(Number(minsRaw) || 0)));
  if (mins <= 0 || hour < 0 || hour > 23) return;

  const base = Math.floor(mins / 4);
  let rem = mins % 4;
  for (let q = 0; q < 4; q++) {
    const slot = (hour * 4) + q;
    const add = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
    if (add <= 0) continue;
    slots[slot] = Math.min(HISTORY_SLOT_MINUTES, (slots[slot] || 0) + add);
  }
}

function decodePackedQuarterSlots(dayBuckets) {
  if (typeof dayBuckets !== 'string' || !dayBuckets.startsWith(HISTORY_PACK_PREFIX)) return null;
  try {
    const b64 = dayBuckets.slice(HISTORY_PACK_PREFIX.length);
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 255;

    const out = new Array(HISTORY_SLOTS_PER_DAY).fill(0);
    for (let i = 0; i < HISTORY_SLOTS_PER_DAY; i++) {
      const byte = bytes[Math.floor(i / 2)] || 0;
      const nibble = (i % 2 === 0) ? (byte >> 4) : (byte & 0x0f);
      out[i] = Math.min(HISTORY_SLOT_MINUTES, nibble);
    }
    return out;
  } catch {
    return null;
  }
}

function encodeQuarterSlots(slots) {
  const bytes = new Uint8Array(HISTORY_SLOTS_PER_DAY / 2);
  for (let i = 0; i < HISTORY_SLOTS_PER_DAY; i += 2) {
    const hi = Math.max(0, Math.min(HISTORY_SLOT_MINUTES, Math.round(Number(slots[i] || 0))));
    const lo = Math.max(0, Math.min(HISTORY_SLOT_MINUTES, Math.round(Number(slots[i + 1] || 0))));
    bytes[Math.floor(i / 2)] = (hi << 4) | lo;
  }
  let raw = '';
  for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
  return HISTORY_PACK_PREFIX + btoa(raw);
}

/**
 * Normalize any supported day bucket shape into a 96-slot (15-minute) array.
 *
 * @param {any} dayBuckets
 * @returns {number[]}
 */
function toQuarterSlots96(dayBuckets) {
  const packed = decodePackedQuarterSlots(dayBuckets);
  if (packed) return packed;

  const out = new Array(HISTORY_SLOTS_PER_DAY).fill(0);

  if (Array.isArray(dayBuckets)) {
    if (dayBuckets.length >= HISTORY_SLOTS_PER_DAY) {
      for (let slot = 0; slot < Math.min(dayBuckets.length, HISTORY_SLOTS_PER_DAY); slot++) {
        const mins = Math.round(Number(dayBuckets[slot] || 0));
        if (mins > 0) out[slot] = Math.min(HISTORY_SLOT_MINUTES, mins);
      }
    } else {
      for (let h = 0; h < Math.min(dayBuckets.length, 24); h++) {
        addLegacyHourToQuarterSlots(out, h, dayBuckets[h]);
      }
    }
    return out;
  }

  if (!dayBuckets || typeof dayBuckets !== 'object') return out;

  for (const [k, v] of Object.entries(dayBuckets)) {
    const mins = Math.round(Number(v || 0));
    if (mins <= 0) continue;

    if (/^q\d+$/.test(k)) {
      const slot = Number(k.slice(1));
      if (!Number.isInteger(slot) || slot < 0 || slot >= HISTORY_SLOTS_PER_DAY) continue;
      out[slot] = Math.min(HISTORY_SLOT_MINUTES, mins);
      continue;
    }

    const h = Number(k);
    if (Number.isInteger(h) && h >= 0 && h <= 23) {
      addLegacyHourToQuarterSlots(out, h, mins);
    }
  }

  return out;
}

/**
 * Sum total minutes in a day bucket, supporting both array and sparse forms.
 *
 * @param {any} dayBuckets
 * @returns {number}
 */
function sumDayBucketMinutes(dayBuckets) {
  const packed = decodePackedQuarterSlots(dayBuckets);
  if (packed) return packed.reduce((sum, v) => sum + (Number(v) || 0), 0);

  if (Array.isArray(dayBuckets)) {
    return dayBuckets.reduce((sum, v) => sum + (Number(v) || 0), 0);
  }
  if (!dayBuckets || typeof dayBuckets !== 'object') return 0;
  return Object.values(dayBuckets).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

/**
 * Update per-user 15-minute activity history for a completed scan.
 *
 * Credits each online user with scanInterval minutes in today's PH quarter-slot bucket,
 * prunes stale day buckets, then triggers a storage pressure check.
 *
 * @param {number}   scanTs          - Timestamp when the scan started.
 * @param {string[]} onlineUsernames - Usernames seen online during this scan.
 * @returns {Promise<void>}
 */
async function updateHistory(scanTs, onlineUsernames) {
  return new Promise(resolve => {
    chrome.storage.local.get('pinalove_history', data => {
      const history = data.pinalove_history || {};
      const cutoff  = tsToPhDay(scanTs - HISTORY_DAYS * 86400000); // oldest day to keep
      const day     = tsToPhDay(scanTs);
      const slot    = tsToPhQuarterSlot(scanTs);
      const mins    = Math.round(SCAN_INTERVAL_MINUTES);

      /* Increment the 15-minute slot bucket for each online user. */
      for (const username of onlineUsernames) {
        if (!history[username])      history[username] = {};
        const slots = toQuarterSlots96(history[username][day]);
        /* Cap at 15 so a slot never exceeds one 15-minute segment. */
        slots[slot] = Math.min(HISTORY_SLOT_MINUTES, (slots[slot] || 0) + mins);
        history[username][day] = encodeQuarterSlots(slots);
      }

      /* Prune day buckets older than the cutoff date. */
      for (const username of Object.keys(history)) {
        const entry = history[username];
        for (const d of Object.keys(entry).sort()) {
          if (d < cutoff) delete entry[d];
        }
        /* Remove the user entry entirely if no days remain. */
        if (Object.keys(entry).length === 0) delete history[username];
      }

      chrome.storage.local.set({ pinalove_history: history }, () => {
        /* After saving, check if we are approaching the storage quota. */
        runStoragePurgeIfNeeded().then(resolve);
      });
    });
  });
}

/* ─── Storage pressure purge ─────────────────────────────────────────────────── */

/* chrome.storage.local has a 10 MB default quota.
   We monitor usage after every history write and evict the least-active
   users' history when usage exceeds PURGE_HIGH (90%), stopping at PURGE_LOW (80%). */
const STORAGE_QUOTA = 10 * 1024 * 1024; // 10 MB
const PURGE_HIGH    = 0.90;              // start purging above this fraction
const PURGE_LOW     = 0.80;             // stop purging below this fraction

/**
 * Check current storage usage and, if above PURGE_HIGH, iteratively delete
 * history for the least-active users until usage drops below PURGE_LOW.
 *
 * "Least active" is defined as lowest total accumulated minutes across all
 * stored day buckets. Only history data is deleted — records, profiles, and
 * totals are preserved.
 *
 * Emits 'info' progress events so the popup status bar shows purge activity.
 *
 * @returns {Promise<void>}
 */
async function runStoragePurgeIfNeeded() {
  return new Promise(resolve => {
    chrome.storage.local.getBytesInUse(null, bytesUsed => {
      const ratio = bytesUsed / STORAGE_QUOTA;
      if (ratio < PURGE_HIGH) return resolve(); // within limits — nothing to do

      console.log(`[Pinkerton] Storage at ${(ratio*100).toFixed(1)}% — purging least active users`);
      setProgress({ type: 'info', message: `Storage at ${(ratio*100).toFixed(0)}% — purging old history…` });

      chrome.storage.local.get('pinalove_history', data => {
        const history = data.pinalove_history || {};

        /* Score each user by total minutes across all retained days.
           Higher score = more activity = keep longer. */
        const scores = Object.entries(history).map(([username, entry]) => {
          const total = Object.entries(entry)
            .reduce((sum, [, buckets]) => sum + sumDayBucketMinutes(buckets), 0);
          return { username, total };
        });

        /* Sort ascending — least-active users are evicted first. */
        scores.sort((a, b) => a.total - b.total);

        let i = 0;

        /* Recursively evict one user at a time, re-checking storage after each deletion. */
        function purgeNext() {
          if (i >= scores.length) {
            return chrome.storage.local.set({ pinalove_history: history }, resolve);
          }

          /* Wipe all day buckets for this user. */
          const entry = history[scores[i].username];
          for (const k of Object.keys(entry)) delete entry[k];
          i++;

          chrome.storage.local.getBytesInUse(null, bytes => {
            const r = bytes / STORAGE_QUOTA;
            console.log(`[Pinkerton] After purging ${i} users: ${(r*100).toFixed(1)}%`);

            if (r < PURGE_LOW) {
              /* We have freed enough space — save and notify popup. */
              setProgress({ type: 'info', message: `Purged ${i} user histories — storage now at ${(r*100).toFixed(0)}%` });
              chrome.storage.local.set({ pinalove_history: history }, resolve);
            } else {
              purgeNext(); // still too high — evict the next user
            }
          });
        }

        purgeNext();
      });
    });
  });
}

/* ─── Thumbdata parser ───────────────────────────────────────────────────────── */

/*
 * PinaLove's AJAX browse endpoint returns a JS snippet, not JSON. The relevant
 * part looks like:
 *
 *   var thumbdata = {
 *     thumbs: [{username:"Alice", avatar:"/p/...", age:"23", ...}, ...]
 *   };
 *
 * The object uses unquoted keys and may have trailing commas — both invalid JSON.
 * We extract the raw array string, fix those issues with regex, then parse as JSON.
 *
 * A simple lazy regex like /thumbs\s*:\s*(\[[\s\S]*?\])/ fails because *? stops
 * at the first ] it finds, which is inside a nested object, not the array end.
 * Instead we use a bracket-depth counter to correctly locate the matching ].
 */

/**
 * Extract and parse the thumbs array from the raw AJAX response text.
 *
 * @param {string} html - Raw response text from /browse.php.
 * @returns {object[]|null} Array of thumb objects, or null on failure.
 */
function parseThumbdata(html) {
  /* Locate the `thumbs:` key that introduces the array. */
  const start = html.indexOf('thumbs:');
  if (start === -1) {
    console.error('[Pinkerton] thumbdata.thumbs not found in response');
    return null;
  }

  /* Find the opening `[` of the thumbs array. */
  const bracketOpen = html.indexOf('[', start);
  if (bracketOpen === -1) {
    console.error('[Pinkerton] thumbs array open bracket not found');
    return null;
  }

  /* Walk forward tracking nesting depth.
     [ and { increase depth; ] and } decrease it.
     When depth returns to 0 we have found the end of the array. */
  let depth = 0, i = bracketOpen;
  for (; i < html.length; i++) {
    if (html[i] === '[' || html[i] === '{') depth++;
    else if (html[i] === ']' || html[i] === '}') { depth--; if (depth === 0) break; }
  }

  const raw = html.slice(bracketOpen, i + 1);

  try {
    const jsonStr = raw
      /* Remove trailing commas before ] or } — these are invalid in JSON. */
      .replace(/,([\s]*[\]\}])/g, '$1')
      /* Quote unquoted object keys so JSON.parse accepts them. */
      .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');

    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('[Pinkerton] thumbdata parse error:', e.message, raw.slice(0, 200));
    return null;
  }
}

/* ─── Next-page URL parser ───────────────────────────────────────────────────── */

/**
 * Extract the URL for the next browse page from the pagination button in the response.
 *
 * PinaLove renders a "next" button with an onclick href:
 *   onclick='window.location.href="/browse.php?starttime=X&prevtimes=Y,Z"'
 *
 * A disabled next button means we are on the last page.
 *
 * @param {string} html - Raw response text.
 * @returns {string|null} Absolute URL for the next page, or null if last page.
 */
function parseNextUrl(html) {
  /* A "disabled" attribute on the next button means no more pages. */
  if (/nbnav-button next[^>]*disabled/.test(html)) return null;

  /* Primary pattern: double-escaped href (most common in AJAX responses). */
  const m = html.match(/nbnav-button next[\s\S]*?href=\\\"(\/browse\.php[^\"]+)\\\"/);
  if (m) return BASE + m[1];

  /* Fallback: single-quoted href. */
  const m2 = html.match(/nbnav-button next[\s\S]*?href='(\/browse\.php[^']+)'/);
  if (m2) return BASE + m2[1];

  return null;
}

/* ─── Thumb-to-user mapping ──────────────────────────────────────────────────── */

/**
 * Convert a single entry from the thumbdata.thumbs array into our internal user record.
 *
 * API field mappings:
 *   t.username     -> username
 *   t.offline      -> isOnline  (0 or absent = online, 1 = offline)
 *   t.ispop        -> isPremium (paid "popular" badge)
 *   t.newmember    -> isNew     (recently joined)
 *   t.faceverified -> isVerified
 *   t.age          -> age (string parsed to int)
 *   t.city         -> location (passed through normalizeCity)
 *   t.avatar       -> photoUrl base + joinMonth estimate
 *   t.la           -> lastSeen timestamp (parsed from relative string)
 *
 * Photo URL storage:
 *   We store the full base URL (e.g. "https://www.pinalove.com/p/2025-09/Name/hash-browse").
 *   results.js appends size suffixes: "x1.avif" (thumb), "x2.avif" (modal), "-big.jpg" (lightbox).
 *
 * Join month estimate:
 *   Derived from the /p/YYYY-MM/ segment of the avatar path. This is the earliest
 *   *possible* join date — if the user later reuploaded their only photo, the
 *   real join date would be earlier. We prefix the display with a <= sign.
 *
 * Last seen:
 *   t.la looks like "0 second", "3 minute", "2 hour", "5 day".
 *   We parse this into a Unix timestamp by subtracting the duration from now.
 *
 * @param {object} t - Raw thumb entry from the API response.
 * @returns {object} Normalised user record ready for storage and display.
 */
function thumbToUser(t) {
  const username   = t.username || '';
  const isOnline   = t.offline !== 1;
  const isPremium  = !!t.ispop;
  const isNew      = !!t.newmember;
  const isVerified = t.faceverified === 1;
  const age        = t.age ? parseInt(t.age, 10) : null;
  const location   = normalizeCity(t.city || '');
  const profileUrl = username ? `${BASE}/${username}` : null;

  /* Build photo URL — skip the "/i/nophoto" sentinel that means no photo. */
  let photoUrl = null;
  if (t.avatar && t.avatar !== '/i/nophoto' && t.avatar.startsWith('/p/')) {
    photoUrl = BASE + t.avatar;
  }

  /* Extract the earliest possible join month from the avatar path (/p/YYYY-MM/...). */
  let joinMonth = null;
  if (t.avatar && t.avatar.startsWith('/p/')) {
    const m = t.avatar.match(/^\/p\/(\d{4}-\d{2})\//);
    if (m) joinMonth = m[1]; // e.g. "2025-07"
  }

  /* Parse t.la relative time string into a Unix timestamp.
     Possible values: "0 second", "3 minute", "2 hour", "5 day". */
  let lastSeen = null;
  if (t.la) {
    const m = t.la.trim().match(/^(\d+)\s*(second|minute|hour|day)/i);
    if (m) {
      const n    = parseInt(m[1]);
      const unit = m[2].toLowerCase();
      const ms   = { second: 1000, minute: 60000, hour: 3600000, day: 86400000 }[unit] || 0;
      lastSeen   = Date.now() - n * ms;
    }
  }

  return { username, profileUrl, photoUrl, isOnline, isPremium, isNew, isVerified, age, location, joinMonth, lastSeen };
}

/* ─── Browse URL builder ─────────────────────────────────────────────────────── */

/**
 * Build the first-page browse request config from saved scan settings.
 *
 * The PinaLove AJAX endpoint requires a specific request format:
 *   - URL:    /browse.php?=<timestamp>  (timestamp is a cache-buster; the key has no name)
 *   - Method: POST
 *   - Body:   application/x-www-form-urlencoded with all filter parameters
 *
 * IMPORTANT: If filter parameters are placed in the URL query string alongside
 * the timestamp, the server redirects to /verifyprofile (i.e. rejects the request).
 * Filters MUST go in the POST body.
 *
 * @returns {Promise<{url: string, body: string}>}
 */
async function buildScanUrl() {
  return new Promise(resolve => {
    chrome.storage.local.get('pinalove_settings', data => {
      const s       = data.pinalove_settings || {};
      const gender  = s.scanGender || 'f';
      const ageFrom = s.scanAgeMin || 18;
      const ageTo   = s.scanAgeMax || 99;
      const ts      = Date.now(); // cache-buster timestamp

      const params = new URLSearchParams({
        c:         's',
        gender,
        agefrom:   ageFrom,
        ageto:     ageTo,
        country:   0,
        city:      0,
        area:      0,
        distance:  30,
        education: 'ALL',
        ch:        'ALL',
        orderby:   'lastactive',
        online:    'on',
        agerange:  'agerangeoff',
        photo:     'off',
      });

      resolve({ url: `${BASE}/browse.php?=${ts}`, body: params.toString() });
    });
  });
}

/* ─── Page fetcher ───────────────────────────────────────────────────────────── */

/**
 * Fetch one page of browse results from the PinaLove AJAX endpoint.
 *
 * For the first page, nextUrl is null and we call buildScanUrl() which returns
 * a {url, body} config object with filter params in the POST body.
 *
 * For subsequent pages, nextUrl is a plain URL string extracted from the
 * previous response's pagination button. These already embed pagination params
 * (starttime, prevtimes) in the query string and need no POST body.
 *
 * @param {null|string|{url:string,body:string}} nextUrl
 * @returns {Promise<{users: object[], hasOffline: boolean, nextUrl: string|null}>}
 */
async function fetchBrowsePage(nextUrl) {
  const scanConfig = nextUrl || await buildScanUrl();

  /* Distinguish between first-page {url, body} object and plain subsequent-page URL string. */
  const url  = typeof scanConfig === 'string' ? scanConfig : scanConfig.url;
  const body = typeof scanConfig === 'string' ? null       : scanConfig.body;
  console.log('[Pinkerton] fetching:', url);

  /*
   * Wrap the fetch in an AbortController with a hard deadline.
   * PinaLove occasionally stalls indefinitely instead of returning an error —
   * without this the scan loop would hang forever.
   * The abort throws an AbortError which propagates up to scanUntilOffline(),
   * which catches it, writes an 'error' progress event, and breaks out of the
   * loop WITHOUT storing any partial results.
   */
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch(url, {
      method:      'POST',
      credentials: 'include', // send browser's PinaLove session cookies
      signal:      controller.signal,
      headers: {
        'ajaxy':            'true',            // signals the server to return JS data, not HTML
        'accept':           '*/*',
        'content-type':     'application/x-www-form-urlencoded',
        'x-requested-with': 'XMLHttpRequest',  // required for the AJAX endpoint to respond
        'referer':          'https://www.pinalove.com/browse.php',
      },
      ...(body ? { body } : {}),
    });
  } finally {
    /* Always clear the timeout whether the fetch succeeded, failed, or aborted.
       Leaving it running would fire a spurious abort on a future fetch. */
    clearTimeout(timeoutId);
  }

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  const thumbs = parseThumbdata(html);
  if (!thumbs) throw new Error('Could not parse thumbdata from response');

  const users      = thumbs.map(thumbToUser);
  const hasOffline = users.some(u => !u.isOnline); // true = stop scanning further pages
  const nextSt     = parseNextUrl(html);            // null = this is the last page

  return { users, hasOffline, nextUrl: nextSt };
}

/* ─── Main scan loop ─────────────────────────────────────────────────────────── */

/**
 * Scan browse pages sequentially until one of three stop conditions is met:
 *
 *   1. An offline user is found — PinaLove sorts results by last-active, so
 *      once we hit an offline user all remaining pages will also be offline.
 *      No point fetching further.
 *
 *   2. The last page is reached — no next-page link appears in the response.
 *
 *   3. _stopRequested is set to true — user pressed Stop while scan was running.
 *
 * After the loop, deduplicates users across all pages (a user can appear on
 * multiple pages if they went offline between fetches), then persists results.
 *
 * @returns {Promise<void>}
 */
async function scanUntilOffline() {
  const pageResults = [];
  let pageNum    = 0;
  let nextUrl    = null;
  const scanTs   = Date.now();
  _stopRequested = false;

  /*
   * Write an immediate 'scanning' progress event so the popup's watchdog
   * timer is armed from the very first moment, even before the first page
   * fetch completes. Without this, there is a multi-second window at scan
   * start where the popup shows nothing and the watchdog isn't counting —
   * so a freeze in the first fetch could go undetected for WATCHDOG_MS
   * after the *second* write rather than after the *first*.
   */
  await setProgress({ type: 'progress', page: 1, found: 0, total: 0 });

  while (true) {

    /* Check stop flag before each fetch so we can exit cleanly mid-scan. */
    if (_stopRequested) {
      const totalOnline = pageResults.flatMap(r => r.users).filter(u => u.isOnline).length;
      await setProgress({
        type:          'done',
        stoppedReason: 'stopped',
        pages:         pageResults.length,
        onlineCount:   totalOnline,
        total:         pageResults.flatMap(r => r.users).length,
      });
      break;
    }

    pageNum++;
    let data;
    try {
      data = await fetchBrowsePage(nextUrl);
    } catch (err) {
      /*
       * Distinguish a fetch timeout (AbortError) from other network errors.
       * Either way the scan is discarded — partial results would show fewer
       * online users than reality, corrupting the stats and history buckets.
       */
      const isTimeout = err.name === 'AbortError';
      const msg = isTimeout
        ? `Page ${pageNum} timed out after ${FETCH_TIMEOUT_MS / 1000}s — scan discarded`
        : err.message;
      console.error('[Pinkerton] fetch error page', pageNum, msg);
      await setProgress({ type: 'error', message: msg });
      /* Log the failure to pinalove_totals so the dashboard shows a red row.
         We do this even though no user data was saved — the log entry is the
         only record that a scan attempt occurred and why it failed. */
      await storeFailedScan(scanTs, isTimeout ? 'timed out' : msg);
      return; /* return instead of break — skips the storage writes below */
    }

    pageResults.push({ ts: scanTs, page: pageNum, users: data.users });

    /* Report live progress to the popup after each page. */
    const totalOnline = pageResults.flatMap(r => r.users).filter(u => u.isOnline).length;
    const totalUsers  = pageResults.flatMap(r => r.users).length;
    await setProgress({ type: 'progress', page: pageNum, found: totalOnline, total: totalUsers });

    /* Stop condition 1: an offline user appeared on this page. */
    if (data.hasOffline) {
      await setProgress({ type: 'done', stoppedReason: 'offline_found', pages: pageResults.length, onlineCount: totalOnline, total: totalUsers });
      break;
    }

    /* Stop condition 2: no next-page link means this was the final page. */
    if (!data.nextUrl) {
      await setProgress({ type: 'done', stoppedReason: 'last_page', pages: pageResults.length, onlineCount: totalOnline, total: totalUsers });
      break;
    }

    nextUrl = data.nextUrl;
    await sleep(300); // brief pause between pages to avoid hammering the server
  }

  /* Deduplicate users across all fetched pages.
     A user can appear on multiple pages if they went offline mid-scan.
     First occurrence wins for most fields; later occurrences fill in any missing data. */
  const seenMap = new Map();
  for (const rec of pageResults) {
    for (const u of rec.users) {
      if (!u.username) continue;
      if (!seenMap.has(u.username)) {
        seenMap.set(u.username, u);
      } else {
        /* Backfill: prefer richer data from whichever page had it. */
        const e = seenMap.get(u.username);
        if (u.photoUrl && !e.photoUrl) e.photoUrl = u.photoUrl;
        if (u.age      && !e.age)      e.age      = u.age;
        if (u.location && !e.location) e.location = u.location;
      }
    }
  }

  const allOnlineUsers = [...seenMap.values()].filter(u => u.isOnline !== false);
  const allOnline      = allOnlineUsers.map(u => u.username);
  const newCount       = allOnlineUsers.filter(u => u.isNew).length;

  console.log('[Pinkerton] scan done —', allOnline.length, 'online users across', pageResults.length, 'pages');

  /* Persist scan results. Each function is independent so we await them sequentially. */
  await mergeMembersFromScan(scanTs, allOnlineUsers);
  await updateHistory(scanTs, allOnline);
  await storeScanTotal(scanTs, allOnline.length, newCount);
  chrome.storage.local.remove('pinalove_records');
}

/**
 * Entry point for alarm-triggered scans.
 * Wraps scanUntilOffline() so an uncaught error does not crash the service worker.
 */
async function scanAllPinaLoveTabs() {
  try { await scanUntilOffline(); }
  catch (err) { console.warn('[Pinkerton] Auto-scan error:', err.message); }
}

/* ─── Storage writers ────────────────────────────────────────────────────────── */

/**
 * Append a scan total entry and prune entries older than 30 days.
 *
 * pinalove_totals drives the sparklines in both the popup and results page.
 * Format: [{ ts, count, newCount }, ...]
 *
 * @param {number} ts       - Scan start timestamp.
 * @param {number} count    - Number of online users found.
 * @param {number} newCount - Number of new-member users among online users.
 * @returns {Promise<void>}
 */
async function storeScanTotal(ts, count, newCount) {
  return new Promise(resolve => {
    chrome.storage.local.get('pinalove_totals', data => {
      const totals = data.pinalove_totals || [];
      totals.push({ ts, count, newCount: newCount || 0 });

      /* Keep only the last 30 days to bound array growth. */
      const cutoff = ts - 30 * 86400000;
      const pruned = totals.filter(t => t.ts >= cutoff);
      chrome.storage.local.set({ pinalove_totals: pruned }, resolve);
    });
  });
}

/**
 * Append a failed scan entry to pinalove_totals so the dashboard log shows it.
 *
 * Failed entries carry an `error` field with a short reason string, and
 * count/newCount set to null so the popup renders them as red rows rather
 * than green success rows. Sparklines ignore entries where count is null.
 *
 * @param {number} ts     - Scan start timestamp.
 * @param {string} reason - Short human-readable reason (e.g. "timed out", "HTTP 503").
 * @returns {Promise<void>}
 */
async function storeFailedScan(ts, reason) {
  return new Promise(resolve => {
    chrome.storage.local.get('pinalove_totals', data => {
      const totals = data.pinalove_totals || [];
      totals.push({ ts, count: null, newCount: null, error: reason });

      /* Same 30-day pruning as successful scans. */
      const cutoff = ts - 30 * 86400000;
      const pruned = totals.filter(t => t.ts >= cutoff);
      chrome.storage.local.set({ pinalove_totals: pruned }, resolve);
    });
  });
}


/* ─── Members accumulator ────────────────────────────────────────────────────── */

/*
 * pinalove_members is the persistent user database — a flat object keyed by
 * username. Unlike pinalove_records (which holds only the latest scan session),
 * members accumulates every user ever seen and retains them for 30 days after
 * their last-seen timestamp.
 *
 * Structure per user:
 *   {
 *     // Scan-sourced fields (updated on every scan the user appears in)
 *     username, profileUrl, photoUrl, age, location,
 *     isPremium, isNew, isVerified, joinMonth, lastSeen,
 *     firstSeen,    // ts of the very first scan they appeared in
 *     lastScanned,  // ts of the most recent scan that included them
 *
 *     // Profile-endpoint fields (populated on demand when modal is opened)
 *     title, bio, fields, photos, photoStats,
 *
 *     // Diff log — one entry per scan or profile fetch where something changed
 *     changelog: [{ ts, source: 'scan'|'profile', changes: { field: [oldVal, newVal] } }, ...]
 *   }
 *
 * Pruning: users whose lastSeen is older than 30 days are deleted on every
 * merge, keeping storage growth bounded. lastSeen (server-reported activity)
 * is used rather than lastScanned so a user who reappears briefly doesn't
 * reset the clock for an otherwise-inactive user.
 */

/**
 * Merge a completed scan's user list into pinalove_members.
 *
 * For each user:
 *   - First appearance: insert with firstSeen, empty changelog.
 *   - Subsequent appearance: diff scan fields; push changelog entry if changed.
 *   - Always update: lastScanned, lastSeen, and all mutable scan flags.
 *
 * After merging, prune any user whose lastSeen is older than 30 days.
 *
 * @param {number}   scanTs - Scan start timestamp.
 * @param {object[]} users  - Array of user records from thumbToUser().
 * @returns {Promise<void>}
 */
async function mergeMembersFromScan(scanTs, users) {
  return new Promise(resolve => {
    chrome.storage.local.get(['pinalove_members', 'pinalove_member_locations'], data => {
      const members = data.pinalove_members || {};
      let locations = Array.isArray(data.pinalove_member_locations) ? [...data.pinalove_member_locations] : [];
      const locationToIndex = new Map(locations.map((v, i) => [v, i]));
      const cutoff  = Date.now() - 30 * 86400000; // 30-day retention window

      /* Normalize any legacy member entries to compact form before merging. */
      for (const [username, raw] of Object.entries(members)) {
        members[username] = compactMemberEntry(raw, username, locations, locationToIndex);
      }

      for (const u of users) {
        if (!u.username) continue;

        const existing = members[u.username];
        const locIdx = ensureLocationIndex(u.location || '', locations, locationToIndex);
        const newFlags = memberFlags(!!u.isNew, !!u.isPremium, !!u.isVerified);
        const newPhoto = canonicalPhotoId(u.photoUrl) || '';
        const newAge = (u.age == null ? null : u.age);
        const newLastSeen = u.lastSeen ?? scanTs;
        const newJoinMonth = u.joinMonth || null;

        if (!existing) {
          /* New user — insert compact record. */
          members[u.username] = {
            a: newAge,
            l: (typeof locIdx === 'number') ? locIdx : null,
            p: newPhoto,
            f: newFlags,
            j: newJoinMonth,
            ls: newLastSeen,
            fs: scanTs,
            sc: scanTs,
            g: [],
          };
        } else {
          /* Existing user — append compact diff mask when scan fields changed. */
          let mask = 0;
          const prevFlags = Number(existing.f || 0);
          if ((prevFlags & MEMBER_FLAG_PREMIUM) !== (newFlags & MEMBER_FLAG_PREMIUM)) mask |= MEMBER_DIFF_PREMIUM;
          if ((prevFlags & MEMBER_FLAG_NEW) !== (newFlags & MEMBER_FLAG_NEW)) mask |= MEMBER_DIFF_NEW;
          if ((prevFlags & MEMBER_FLAG_VERIFIED) !== (newFlags & MEMBER_FLAG_VERIFIED)) mask |= MEMBER_DIFF_VERIFIED;
          if ((existing.a ?? null) !== newAge) mask |= MEMBER_DIFF_AGE;
          if ((existing.l ?? null) !== ((typeof locIdx === 'number') ? locIdx : null)) mask |= MEMBER_DIFF_LOCATION;
          if ((existing.p || '') !== newPhoto) mask |= MEMBER_DIFF_PHOTO;
          if (mask > 0) {
            existing.g = normalizeMemberLog(existing.g);
            existing.g.push([scanTs, mask]);
            if (existing.g.length > MEMBER_LOG_MAX) {
              existing.g = existing.g.slice(existing.g.length - MEMBER_LOG_MAX);
            }
          }

          existing.f = newFlags;
          existing.sc = scanTs;
          existing.ls = newLastSeen;
          existing.a = newAge;
          existing.p = newPhoto;
          existing.l = (typeof locIdx === 'number') ? locIdx : null;
          if (newJoinMonth && (!existing.j || newJoinMonth < existing.j)) existing.j = newJoinMonth;
          if (!existing.fs) existing.fs = scanTs;
        }
      }

      /* Prune users not seen in 30 days.
         We use lastSeen (server-reported activity time) rather than lastScanned
         so a user who reappears briefly doesn't keep a long-inactive entry alive. */
      for (const username of Object.keys(members)) {
        const m = members[username];
        const age = m.ls ?? m.lastSeen ?? m.sc ?? m.lastScanned ?? 0;
        if (age < cutoff) delete members[username];
      }

      locations = compactLocationDictionary(members, locations);
      chrome.storage.local.set({ pinalove_members: members, pinalove_member_locations: locations }, resolve);
    });
  });
}

/**
 * Remove a deleted user from every storage key.
 * Called when the profile endpoint returns an empty structure (account deleted).
 *
 * @param {string} username - The username to purge.
 * @returns {Promise<void>}
 */
async function pruneDeletedUser(username) {
  if (!username) return;
  return new Promise(resolve => {
    const keys = ['pinalove_members', 'pinalove_profiles', 'pinalove_history', 'pinalove_visited'];
    chrome.storage.local.get(keys, data => {
      const members  = data.pinalove_members  || {};
      const profiles = data.pinalove_profiles || {};
      const history  = data.pinalove_history  || {};
      const visited  = data.pinalove_visited  || {};

      delete members[username];
      delete profiles[username];
      delete history[username];
      delete visited[username];

      chrome.storage.local.set(
        { pinalove_members: members, pinalove_profiles: profiles,
          pinalove_history: history, pinalove_visited: visited },
        resolve
      );
    });
  });
}

/**
 * Merge profile-endpoint data into an existing pinalove_members entry.
 *
 * Called from the fetchProfile message handler after a successful profile fetch.
 * Diffs title, bio, fields, and photos against the stored values and pushes a
 * 'profile' changelog entry if anything changed.
 *
 * If the user doesn't exist in members yet (e.g. profile fetched before first
 * scan stores them), the entry is created with minimal fields.
 *
 * @param {string} username  - The user's username.
 * @param {object} profileData - Parsed profile data from fetchProfile.
 * @returns {Promise<void>}
 */
async function mergeMembersFromProfile(username, profileData) {
  if (!username) return;

  return new Promise(resolve => {
    chrome.storage.local.get(['pinalove_members', 'pinalove_member_locations'], data => {
      const members = data.pinalove_members || {};
      const locations = Array.isArray(data.pinalove_member_locations) ? [...data.pinalove_member_locations] : [];
      const locationToIndex = new Map(locations.map((v, i) => [v, i]));
      const m = members[username];
      if (!m) return resolve();

      const compact = compactMemberEntry(m, username, locations, locationToIndex);

      if (profileData.joinMonth && (!compact.j || profileData.joinMonth < compact.j)) {
        compact.j = profileData.joinMonth;
      }

      members[username] = compact;
      chrome.storage.local.set({ pinalove_members: members }, resolve);
    });
  });
}

/* Session snapshots are represented by member.lastScanned + pinalove_totals.
   We intentionally do not store pinalove_records to reduce storage use. */

/* ─── Message handler ────────────────────────────────────────────────────────── */

/*
 * All communication between popup.js / results.js and this service worker
 * uses chrome.runtime.sendMessage / onMessage.
 *
 * Handled actions:
 *   manualScan      — Immediately start a scan (popup scan button).
 *   fetchProfile    — Fetch and parse a user's profile page.
 *   clearRecords    — Wipe all stored extension data.
 *   getAlarmStatus  — Return current alarm info and interval.
 *   toggleAutoScan  — Enable or disable automatic scheduled scanning.
 *   setScanInterval — Change the repeat interval and persist to settings.
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  /* ── Manual scan trigger ─────────────────────────────────────────────── */
  if (request.action === 'manualScan') {
    /* Write an initial progress state immediately so the popup shows
       "Scanning page 1..." rather than a blank status. */
    chrome.storage.local.set({
      pinalove_scan_progress: { type: 'progress', page: 1, found: 0, total: 0, ts: Date.now() }
    });
    sendResponse({ ok: true, started: true });
    /* Fire-and-forget — errors are written back as 'error' progress entries. */
    scanUntilOffline().catch(err => setProgress({ type: 'error', message: err.message }));
    return true;
  }

  /* ── Profile page fetcher ────────────────────────────────────────────── */
  if (request.action === 'fetchProfile') {
    /* Wrapped in an async IIFE because the onMessage callback cannot itself be async. */
    (async () => {
      /* Append a timestamp to the URL to bust any server-side cache. */
      const url = request.url + '?=' + Date.now();
      try {
        const resp = await fetch(url, {
          method:      'POST',
          credentials: 'include',
          headers: { 'ajaxy': 'true', 'accept': '*/*' }
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = await resp.text();

        /* Unescape backslash sequences embedded in JS string literals
           (e.g. \/ -> /, \n -> newline) using JSON.parse as a safe decoder. */
        function unesc(s) {
          try { return JSON.parse('"' + s + '"'); }
          catch (_) { return s.replace(/\\\//g, '/').replace(/\\/g, ''); }
        }

        /* ── Field extraction ─────────────────────────────────────────────
           Profile fields appear as JS objects: { k: "Age", v: "25" }
           We collect all of them and skip "Last Active" (not useful to us). */
        const fields     = {};
        const pfMatches  = [...html.matchAll(/\{\s*k:\s*"([^"]+)",\s*v:\s*"([^"]+)"\s*\}/g)];
        for (const m of pfMatches) {
          const k = unesc(m[1]), v = unesc(m[2]);
          if (k && v && k !== 'Last Active') fields[k] = v;
        }

        /* ── Headline and bio ─────────────────────────────────────────────
           Both live in the profileData JS block embedded in the page source. */
        const headlineM    = html.match(/headline\s*:\s*"((?:[^"\\]|\\.)*)"/);
        const descriptionM = html.match(/description\s*:\s*"((?:[^"\\]|\\.)*)"/);
        const title        = headlineM    ? unesc(headlineM[1]).trim()    : '';
        const bio          = descriptionM ? unesc(descriptionM[1]).trim() : '';

        /* ── Photo extraction ─────────────────────────────────────────────
           Photos appear as JS objects containing Uri, views, likes, fav.
           We scan for objects that have a "Uri" key and parse the stats
           from the same block. */
        const photoMap = new Map(); // canonical path -> { views, likes, favs }

        /* Normalise any photo URL to a canonical base path (YYYY-MM/user/hash-browse).
           Strips domain prefix and any size suffix variants. */
        function canonicalPath(uri) {
          let path = uri.startsWith('http')
            ? uri.slice(uri.indexOf('/p/') + 3)
            : uri.replace(/^\/p\//, '');
          path = path
            .replace(/-(big|browse|card|medium)(x\d+)?(\.[a-z]+)?$/, '')
            .replace(/\.(jpg|avif|webp)$/, '');
          if (!path.endsWith('-browse')) path += '-browse';
          return path.replace(/\/+$/, '');
        }

        /* Match complete JS objects that contain a "Uri" key. */
        const photoBlockRe = /\{[^{}]*?"Uri"\s*:\s*"([^"]+)"[^{}]*?\}/gs;
        let pbM;
        while ((pbM = photoBlockRe.exec(html)) !== null) {
          const block = pbM[0];
          const uri   = unesc(pbM[1]);
          if (!uri.includes('/p/')) continue;  // skip non-photo URIs
          const path  = canonicalPath(uri);
          if (photoMap.has(path)) continue;    // deduplicate

          const views = parseInt((block.match(/"views"\s*:\s*"?(\d+)"?/) || [])[1] || '0');
          const likes = parseInt((block.match(/"likes"\s*:\s*"?(\d+)"?/) || [])[1] || '0');
          const favs  = parseInt((block.match(/"fav"\s*:\s*"?(\d+)"?/)   || [])[1] || '0');
          photoMap.set(path, { views, likes, favs });
        }

        const photos     = [...photoMap.keys()];
        const photoStats = [...photoMap.values()];

        /* Infer the earliest possible join month from photo path dates (YYYY-MM/...). */
        const allMonths     = photos
          .map(p => { const r = p.match(/^(\d{4}-\d{2})\//); return r ? r[1] : null; })
          .filter(Boolean)
          .sort();
        const earliestMonth = allMonths[0] || null;

        console.log('[PinaLove] fields:', Object.keys(fields).length, 'photos:', photos.length, 'joinMonth:', earliestMonth);

        /* ── Account-state detection ──────────────────────────────────────
           The page embeds JS like: $('#profiledeleted').show();
           We detect which state element is shown and signal the UI.
           visibility_blocked  → profile hidden by user; keep data, just warn.
           blocked / deleted   → prune all stored data for this user. */
        const shownEl = (html.match(/\$\('#(profiledeleted|profileblocked|profilevisibilityblocked)'\)\.show\(\)/) || [])[1];
        if (shownEl === 'profiledeleted' || shownEl === 'profileblocked') {
          sendResponse({ status: shownEl === 'profiledeleted' ? 'deleted' : 'blocked' });
          pruneDeletedUser(request.username)
            .catch(err => console.warn('[Pinkerton] pruneDeletedUser error:', err.message));
          return;
        }
        if (shownEl === 'profilevisibilityblocked') {
          sendResponse({ status: 'visibility_blocked' });
          return;
        }

        sendResponse({ data: { title, bio, fields, photos, photoStats, joinMonth: earliestMonth } });

          /* Keep lightweight metadata in members (joinMonth only). */
          mergeMembersFromProfile(request.username, { joinMonth: earliestMonth })
          .catch(err => console.warn('[Pinkerton] mergeMembersFromProfile error:', err.message));

      } catch (err) {
        console.error('[PinaLove] fetchProfile error:', err.message, err.stack);
        sendResponse({ error: err.message });
      }
    })();
    return true; // keep the message channel open for the async response
  }

  /* ── Clear all data ──────────────────────────────────────────────────── */
  if (request.action === 'clearRecords') {
    chrome.storage.local.set({
      pinalove_members:  {},
      pinalove_member_locations: [],
      pinalove_history:  {},
      pinalove_totals:   [],
      pinalove_profiles: {},
      pinalove_visited:  {},
    }, () => chrome.storage.local.remove('pinalove_records', () => sendResponse({ ok: true })));
    return true;
  }

  /* ── Alarm status query ──────────────────────────────────────────────── */
  if (request.action === 'getAlarmStatus') {
    /* Return the alarm object (contains .scheduledTime for the popup countdown)
       and the in-memory interval (for displaying "every N min"). */
    chrome.alarms.get(ALARM_NAME, alarm =>
      sendResponse({ alarm, intervalMinutes: SCAN_INTERVAL_MINUTES })
    );
    return true;
  }

  /* ── Auto-scan toggle ────────────────────────────────────────────────── */
  if (request.action === 'toggleAutoScan') {
    chrome.storage.local.get('pinalove_settings', data => {
      const s = data.pinalove_settings || {};
      s.autoScanEnabled = !!request.enabled;
      chrome.storage.local.set({ pinalove_settings: s }, () => {
        if (request.enabled) {
          setupAlarm(request.intervalMinutes || SCAN_INTERVAL_MINUTES);
          /* Start an immediate scan so the user sees results right away
             rather than waiting for the first alarm tick. */
          scanUntilOffline().catch(err => setProgress({ type: 'error', message: err.message }));
          sendResponse({ ok: true, enabled: true });
        } else {
          /* Disable: remove the alarm so no further automatic scans fire. */
          chrome.alarms.clear(ALARM_NAME, () => sendResponse({ ok: true, enabled: false }));
        }
      });
    });
    return true;
  }

  /* ── Scan interval change ────────────────────────────────────────────── */
  if (request.action === 'setScanInterval') {
    const mins = Math.min(5, Math.max(1, parseInt(request.minutes) || 5));
    SCAN_INTERVAL_MINUTES = mins; // update in-memory value immediately

    chrome.storage.local.get('pinalove_settings', data => {
      const s = data.pinalove_settings || {};
      s.scanInterval = mins;
      chrome.storage.local.set({ pinalove_settings: s }, () => {
        /* If an alarm is already running, reschedule it with the new interval. */
        chrome.alarms.get(ALARM_NAME, alarm => {
          if (alarm) setupAlarm(mins);
          sendResponse({ ok: true, minutes: mins });
        });
      });
    });
    return true;
  }

});
