/* 
  results.js — Pinkerton v3.1
  
  Dashboard page for browsing, filtering, and analyzing PinaLove members and their online activity.
  Displays grid/table views of profiles, member history, per-user analytics, and photo galleries.
  All data is retrieved from chrome.storage.local and displayed with lazy loading.
*/

/* Utility: shorthand for document.getElementById() */
const $ = id => document.getElementById(id);

/* Philippine timezone offset: UTC+8 hours (used throughout for all time calculations) */
const PH_OFFSET_MS = 8 * 3600 * 1000;
const HISTORY_PACK_PREFIX = 'p1:';
const MEMBER_BASE_URL = 'https://www.pinalove.com';

/* 
  =====================================================
  GLOBAL STATE — Core data structures
  =====================================================
*/

/* Flat array of all member profiles cached from the extension (pinalove_members storage) */
let allUsers      = [];

/* Filtered/sorted subset of allUsers based on active filters (search, age, location, type) */
let filteredUsers = [];

/* 
  Per-user activity history keyed by username
  Format: { username: { "YYYY-MM-DD": {"q0":m0,...} } } (legacy hourly formats also supported)
  Quarter-slot data is aggregated to hourly when rendering existing charts.
*/
let history       = {};

/* 
  Per-user profile snapshots and change diffs, keyed by username
  Format: { username: { snapshots:[...], photos:[...], diffs:[...] } }
  Stores photo URLs, field values, bio, and timestamped changes
*/
let profiles      = {};

/* 
  Global activity log: array of scan timestamps with online/new counts
  Format: [{ts: timestamp, count: online_count, newCount: new_count}, ...]
  Used to render header sparkline showing per-scan activity
*/
let totals        = [];

/* Scan interval in minutes (loaded from settings, default 5) */
let scanInterval  = 5;

/* User's own height (cm) and weight (kg) — loaded from settings for profile comparisons */
let myHeight      = null;
let myWeight      = null;

/* 
  Timestamp of the most recent successful scan session
  Used to determine which users were "online now" (comparing to user.lastScanned)
*/
let latestScanTs  = 0;

/* Enable migration counters via ?debug=1 or ?debugHistory=1 (or #debug). */
const DEBUG_HISTORY = /(?:[?&]debug=1\b|[?&]debugHistory=1\b)/i.test(location.search) || /debug(?:history)?/i.test(location.hash);

/* Compact storage schema for profile fields in pinalove_profiles. */
const FIELD_KEY_MAP = {
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
const FIELD_LABEL_FROM_KEY = Object.fromEntries(Object.entries(FIELD_KEY_MAP).map(([k, v]) => [v, k]));

function packProfileFields(fields = {}) {
  const packed = {};
  for (const [label, val] of Object.entries(fields || {})) {
    if (val == null || val === '') continue;
    packed[FIELD_KEY_MAP[label] || label] = val;
  }
  return packed;
}

function unpackProfileFields(packed = {}) {
  const fields = {};
  for (const [k, v] of Object.entries(packed || {})) {
    fields[FIELD_LABEL_FROM_KEY[k] || k] = v;
  }
  return fields;
}

function decodeProfileEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    return { fields: {}, bio: '', title: '', photos: [], diffs: [], joinMonth: null };
  }
  return {
    fields: raw.fields ? { ...raw.fields } : unpackProfileFields(raw.f || {}),
    bio: raw.bio ?? raw.b ?? '',
    title: raw.title ?? raw.t ?? '',
    photos: Array.isArray(raw.photos) ? raw.photos : (Array.isArray(raw.p) ? raw.p : []),
    diffs: Array.isArray(raw.diffs) ? raw.diffs : (Array.isArray(raw.d) ? raw.d : []),
    joinMonth: raw.joinMonth ?? raw.jm ?? null,
  };
}

function encodeProfileEntry(entry) {
  return {
    f: packProfileFields(entry.fields || {}),
    t: entry.title || '',
    b: entry.bio || '',
    p: (entry.photos || []).map(stripPhotoUrl).filter(Boolean),
    d: entry.diffs || [],
    jm: entry.joinMonth || null,
  };
}

function decodeProfilesMap(rawAll) {
  const out = {};
  for (const [username, raw] of Object.entries(rawAll || {})) out[username] = decodeProfileEntry(raw);
  return out;
}

function decodeMemberEntry(username, raw, locations = []) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const isCompact = ('sc' in entry) || ('ls' in entry) || ('f' in entry) || ('l' in entry);
  if (!isCompact) {
    return {
      username,
      age: entry.age ?? null,
      location: entry.location || '',
      photoUrl: entry.photoUrl || '',
      isNew: !!entry.isNew,
      isPremium: !!entry.isPremium,
      isVerified: !!entry.isVerified,
      joinMonth: entry.joinMonth ?? null,
      lastSeen: entry.lastSeen ?? 0,
      firstSeen: entry.firstSeen ?? 0,
      lastScanned: entry.lastScanned ?? 0,
      profileUrl: `${MEMBER_BASE_URL}/${username}`,
    };
  }

  const flags = Number(entry.f || 0);
  const locIdx = Number.isInteger(entry.l) ? entry.l : null;
  return {
    username,
    age: entry.a ?? null,
    location: (locIdx != null && locIdx >= 0 && locIdx < locations.length) ? (locations[locIdx] || '') : '',
    photoUrl: entry.p || '',
    isNew: !!(flags & 1),
    isPremium: !!(flags & 2),
    isVerified: !!(flags & 4),
    joinMonth: entry.j ?? null,
    lastSeen: entry.ls ?? 0,
    firstSeen: entry.fs ?? 0,
    lastScanned: entry.sc ?? 0,
    profileUrl: `${MEMBER_BASE_URL}/${username}`,
  };
}

/* Lazy loading: current batch index for grid/table rendering */
let lazyIndex  = 0;

/* Number of cards/rows to render per batch (prevents UI freezing on large datasets) */
const LAZY_BATCH = 60;

/* IntersectionObserver for lazy-loading more items as user scrolls */
let lazyObserver = null;

/* Current view mode: "grid" (cards) or "table" (rows) */
let viewMode    = 'grid';

function fmtVisited(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

 // username → timestamp visited
let searchQuery = '';
let sortKey     = 'last_seen_desc';
let locationFilter = '';
let radiusKm       = 0;    // 0 = exact match only
let typeFilters = { new: false, premium: false, verified: false };
let ageMin = null, ageMax = null;

// ─── Philippine time helpers ──────────────────────────────────────────────────

/* Current time in milliseconds, adjusted to Philippine timezone */
function phNow() { return Date.now() + PH_OFFSET_MS; }

/* Convert millisecond timestamp to "YYYY-MM-DD" date string (Philippine time) */
function tsToPhDay(ts) {
  const d = new Date(ts + PH_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

/* Extract hour (0-23) from timestamp in Philippine time */
function tsToPhHour(ts) {
  return new Date(ts + PH_OFFSET_MS).getUTCHours();
}

/* Get current hour in Philippine timezone (0-23) */
function phHourNow() { return tsToPhHour(Date.now()); }

/* 
  =====================================================
  INITIALIZATION
  =====================================================
*/

/* Initial page load: bind events and load all data from storage */
document.addEventListener('DOMContentLoaded', () => { bindEvents(); loadData(); });

/* 
  =====================================================
  DATA LOADING & MANAGEMENT
  =====================================================
*/

/* 
  Load all extension data from chrome.storage.local and populate the dashboard.
  Retrieves members, history, profiles, settings, and visits from storage,
  then renders the main view with applied filters.
*/
function loadData() {
  chrome.storage.local.get(['pinalove_members','pinalove_member_locations','pinalove_filters','pinalove_history','pinalove_profiles','pinalove_totals','pinalove_settings','pinalove_visited'], data => {
    /* Restore active filters from storage (age range, sort, type filters) */
    if (data.pinalove_filters) {
      const f = data.pinalove_filters;
      if (f.ageMin) ageMin = f.ageMin;
      if (f.ageMax) ageMax = f.ageMax;
      if (f.sort)   sortKey = f.sort;
      if (f.typeFilters) Object.assign(typeFilters, f.typeFilters);
    }
    history  = data.pinalove_history  || {};
    renderHistoryDebugBadge();
    if (data.pinalove_settings?.scanInterval) scanInterval = data.pinalove_settings.scanInterval;
    if (data.pinalove_settings?.myHeight)     myHeight     = data.pinalove_settings.myHeight;
    if (data.pinalove_settings?.myWeight)     myWeight     = data.pinalove_settings.myWeight;
    profiles = decodeProfilesMap(data.pinalove_profiles || {});
    totals   = data.pinalove_totals   || [];
    buildAllUsers(data.pinalove_members || {}, data.pinalove_member_locations || [], data.pinalove_visited || {});
    populateLocations();
    syncFilterUI();
    applyAndRender();
    renderHeaderSparkline();
    /* Show debug bar only when no member data exists yet. */
    const hasData = Object.keys(data.pinalove_members || {}).length > 0;
    if (!hasData) { const b = $('debugBar'); if (b) b.style.display='block'; }
  });
}

/* Build compact counts to verify sparse-history migration status at a glance. */
function getHistoryBucketStats(hist) {
  const users = Object.keys(hist || {}).length;
  let days = 0;
  let packedDays = 0;
  let sparseDays = 0;
  let quarterDays = 0;
  let hourSparseDays = 0;
  let legacyDays = 0;
  let unknownDays = 0;

  for (const userDays of Object.values(hist || {})) {
    if (!userDays || typeof userDays !== 'object') continue;
    for (const dayBuckets of Object.values(userDays)) {
      days++;
      if (typeof dayBuckets === 'string' && dayBuckets.startsWith(HISTORY_PACK_PREFIX)) packedDays++;
      else if (Array.isArray(dayBuckets)) legacyDays++;
      else if (dayBuckets && typeof dayBuckets === 'object') {
        sparseDays++;
        const keys = Object.keys(dayBuckets);
        if (keys.some(k => /^q\d+$/.test(k))) quarterDays++;
        else hourSparseDays++;
      }
      else unknownDays++;
    }
  }

  return { users, days, packedDays, sparseDays, quarterDays, hourSparseDays, legacyDays, unknownDays };
}

function renderHistoryDebugBadge() {
  const badge = $('historyDebugBadge');
  if (!badge) return;

  if (!DEBUG_HISTORY) {
    badge.style.display = 'none';
    return;
  }

  const s = getHistoryBucketStats(history);
  badge.style.display = 'inline-flex';
  badge.textContent = `history u:${s.users} d:${s.days} packed:${s.packedDays} q15:${s.quarterDays} sparseHr:${s.hourSparseDays} legacy:${s.legacyDays}${s.unknownDays ? ` unknown:${s.unknownDays}` : ''}`;
}

/**
 * Build the main allUsers array from stored member data.
 * 
 * All members are included. isOnline is true if the user's lastScanned timestamp
 * matches latestScanTs (meaning they appeared in the most recent scan).
 * visitedAt is injected from the visited map (tracks which profiles user has clicked).
 *
 * @param {object} members    - pinalove_members object keyed by username
 * @param {object} visitedMap - pinalove_visited map of username → unix timestamp when clicked
 */
function buildAllUsers(members, memberLocations = [], visitedMap = {}) {
  /* Derive latest scan ts directly from member.lastScanned (no pinalove_records). */
  latestScanTs = Object.values(members || {}).reduce((mx, raw) => {
    const sc = (raw && typeof raw === 'object') ? (raw.sc ?? raw.lastScanned ?? 0) : 0;
    return Math.max(mx, sc || 0);
  }, 0);

  allUsers = Object.entries(members || {}).map(([username, raw]) => {
    const u = decodeMemberEntry(username, raw, memberLocations);
    return ({
    ...u,
    isOnline:  latestScanTs > 0 && u.lastScanned === latestScanTs,
    visitedAt: visitedMap[u.username] || null,
    });
  });
}

/* 
  Populate the location dropdown with all unique cities from member profiles,
  sorted alphabetically. Pre-selects the current locationFilter if set.
*/
function populateLocations() {
  const sel = $('locationSelect'); if (!sel) return;
  const locs = [...new Set(allUsers.map(u=>(u.location||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  sel.innerHTML = '<option value="">All locations</option>';
  locs.forEach(loc => { const o=document.createElement('option'); o.value=loc; o.textContent=loc; if(loc===locationFilter) o.selected=true; sel.appendChild(o); });
}

/*
  =====================================================
  ACTIVITY HISTORY HELPERS
  =====================================================
  
  These functions extract and format per-user online session data.
  Activity may be stored in 15-minute slots (q0..q95) or legacy hourly buckets.
*/

/*
  Get 30-day daily activity totals for a user in Philippine time.
  Returns array of {date: "YYYY-MM-DD", minutes: total_minutes} for last 30 days.
*/
function getDailyMinutesPH(username) {
  const userHist = history[username] || {};
  const result = [];
  const nowPh = phNow();
  for (let d=29; d>=0; d--) {
    const day     = tsToPhDay(nowPh - d*86400000);
    const buckets = getDayBuckets96(userHist[day]);
    const minutes = buckets.reduce((s, m) => s + (m || 0), 0);
    result.push({ date: day, minutes: Math.round(minutes) });
  }
  return result;
}

/* Normalize one day bucket to a 96-slot (15-minute) array, supporting legacy formats. */
function getDayBuckets96(dayBuckets) {
  const out = new Array(96).fill(0);

  if (typeof dayBuckets === 'string' && dayBuckets.startsWith(HISTORY_PACK_PREFIX)) {
    try {
      const raw = atob(dayBuckets.slice(HISTORY_PACK_PREFIX.length));
      for (let i = 0; i < 96; i++) {
        const byte = raw.charCodeAt(Math.floor(i / 2)) || 0;
        const nibble = (i % 2 === 0) ? (byte >> 4) : (byte & 0x0f);
        out[i] = Math.min(15, nibble);
      }
      return out;
    } catch {
      return out;
    }
  }

  if (Array.isArray(dayBuckets)) {
    if (dayBuckets.length >= 96) {
      for (let slot = 0; slot < 96; slot++) {
        out[slot] = Number(dayBuckets[slot] || 0);
      }
    } else {
      for (let h = 0; h < 24; h++) {
        const mins = Number(dayBuckets[h] || 0);
        if (!mins) continue;
        const base = Math.floor(mins / 4);
        let rem = mins % 4;
        for (let q = 0; q < 4; q++) {
          out[(h * 4) + q] = base + (rem > 0 ? 1 : 0);
          if (rem > 0) rem--;
        }
      }
    }
    for (let i = 0; i < 96; i++) out[i] = Math.round(out[i]);
    return out;
  }
  if (!dayBuckets || typeof dayBuckets !== 'object') return out;
  for (const [k, v] of Object.entries(dayBuckets)) {
    const mins = Number(v || 0);
    if (/^q\d+$/.test(k)) {
      const slot = Number(k.slice(1));
      if (!Number.isInteger(slot) || slot < 0 || slot > 95) continue;
      out[slot] += mins;
      continue;
    }
    const h = Number(k);
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    const base = Math.floor(mins / 4);
    let rem = mins % 4;
    for (let q = 0; q < 4; q++) {
      out[(h * 4) + q] += base + (rem > 0 ? 1 : 0);
      if (rem > 0) rem--;
    }
  }
  for (let i = 0; i < 96; i++) out[i] = Math.round(out[i]);
  return out;
}

/*
  Get 15-minute activity pattern across all days.
  Returns array of 96 values (one per quarter-hour) summing total online minutes.
*/
function getHourlyPatternPH(username) {
  const userHist = history[username] || {};
  const totals = new Array(96).fill(0);
  for (const buckets of Object.values(userHist)) {
    const dayBuckets = getDayBuckets96(buckets);
    for (let i = 0; i < 96; i++) totals[i] += (dayBuckets[i] || 0);
  }
  return totals;
}

/* Format minute value as "45m" or "2h 30m" */
function fmtMinutes(m) { if(m<60) return `${m}m`; return `${Math.floor(m/60)}h ${m%60}m`; }

/* Sum all online minutes for a user across the last 30 days */
function totalMinutes(username) { return getDailyMinutesPH(username).reduce((s,d)=>s+d.minutes,0); }

/*
  =====================================================
  SPARKLINE SVG GENERATION
  =====================================================
  
  Utility to build responsive bar charts (sparklines) showing activity over time.
  Used for header stats, user profiles, and per-day details.
*/

/*
  Build a flexible bar chart SVG with optional overlay series.
  
  Parameters:
    primary   : number[] — main bar heights (online counts or minutes)
    secondary : number[] — optional overlay bars (e.g., new user counts)
    opts      : {
      vw        : viewBox width in pixels (default 340)
      h         : chart height (default 56)
      ah        : axis/label height (default 18)
      interval  : minutes per time slot (default 5)
      color1    : primary bar fill color (default teal)
      color2    : secondary bar fill color (default magenta)
      labelEvery: label every N hours (default 3)
      tip       : function(i, v1, v2) → tooltip text for bar
    }
    
  Returns: SVG markup string ready to inject into DOM
*/
// ─── Shared sparkline SVG builder ────────────────────────────────────────────
function buildSparkSVG(primary, secondary = [], opts = {}) {
  const VW       = opts.vw       ?? 340;
  const H        = opts.h        ?? 56;
  const AH       = opts.ah       ?? 18;
  const interval = opts.interval ?? 5;
  const col1     = opts.color1   ?? 'rgba(0,201,167,0.65)';
  const col2     = opts.color2   ?? 'rgba(255,45,155,0.85)';
  const bgSeries = opts.bgSeries ?? [];
  const bgSecondary = opts.bgSecondary ?? [];
  const bgCol    = opts.bgColor  ?? 'rgba(140,150,170,0.35)';
  const bgCol2   = opts.bgColor2 ?? 'rgba(170,170,180,0.42)';
  const labelEvery = opts.labelEvery ?? 3;
  const numBars  = primary.length;
  const max      = Math.max(...primary, ...secondary, ...bgSeries, ...bgSecondary, 1);
  const barW     = Math.max(1, Math.round(VW / numBars) - (VW / numBars > 2 ? 1 : 0));

  /* Build bars: previous-day (grey) in back, then current-day primary, then secondary overlay. */
  const bars = primary.map((v, i) => {
    const vb  = bgSeries[i] || 0;
    const bgH = vb > 0 ? Math.max(1, Math.round((vb / max) * H)) : 0;
    const vb2 = bgSecondary[i] || 0;
    const bgH2 = vb2 > 0 ? Math.max(1, Math.round((vb2 / max) * H)) : 0;
    const bH  = Math.max(v > 0 ? 2 : 0, Math.round((v / max) * H));
    const v2  = secondary[i] || 0;
    const nH  = v2 > 0 ? Math.max(1, Math.round((v2 / max) * H)) : 0;
    const x   = Math.round((i / numBars) * VW);
    const tip = opts.tip ? opts.tip(i, v, v2) : (() => {
      const phMin = i * interval;
      const hh = String(Math.floor(phMin / 60)).padStart(2,'0');
      const mm = String(phMin % 60).padStart(2,'0');
      return `${hh}:${mm}`;
    })();
    return `<g>
      ${bgH ? `<rect x="${x}" y="${H-bgH}" width="${barW}" height="${bgH}" rx="1" fill="${bgCol}"><title>${tip}</title></rect>` : ''}
      ${bgH2 ? `<rect x="${x}" y="${H-bgH2}" width="${barW}" height="${bgH2}" rx="1" fill="${bgCol2}"><title>${tip}</title></rect>` : ''}
      <rect x="${x}" y="${H-bH}" width="${barW}" height="${bH}" rx="1"
        fill="${col1}" opacity="${v>0?1:0.1}"><title>${tip}</title></rect>
      ${nH ? `<rect x="${x}" y="${H-nH}" width="${barW}" height="${nH}" rx="1" fill="${col2}"><title>${tip}</title></rect>` : ''}
    </g>`;
  }).join('');

  /* Build time axis: hour marks at 0, 3, 6, 9, 12, 15, 18, 21, 24 */
  const axisMarks = [];
  for (let m = 0; m <= 1440; m += 30) {
    const h      = m / 60;
    const isHour = m % 60 === 0;
    const x      = Math.round((m / 1440) * VW);
    const tickH  = isHour ? 5 : 3;
    const anchor = h === 0 ? 'start' : h === 24 ? 'end' : 'middle';
    const labeled = isHour && h % labelEvery === 0;
    axisMarks.push(`<g transform="translate(${x},0)">
      <line x1="0" y1="0" x2="0" y2="${tickH}" stroke="#4a4a6a" stroke-width="1"/>
      ${labeled ? `<text x="0" y="${AH-4}" text-anchor="${anchor}" font-size="${AH > 12 ? 10 : 7}" font-family="DM Mono,monospace" fill="#7a7a9a">${h}</text>` : ''}
    </g>`);
  }

  return `<svg width="100%" viewBox="0 0 ${VW} ${H+AH}" preserveAspectRatio="xMidYMid meet" style="display:block;overflow:visible">
    <line x1="0" y1="${H}" x2="${VW}" y2="${H}" stroke="#252538" stroke-width="1"/>
    ${bars}
    <g transform="translate(0,${H})">${axisMarks.join('')}</g>
  </svg>`;
}

/* 
  Expand hourly buckets (hour 0-23 with minute totals) into finer-grained time slots.
  Used to display activity at the scan interval granularity (e.g., 5-minute slots).
  
  Returns array of (1440 / interval) values, spreading each hour's minutes evenly across its slots.
*/
function expandHourlyToSlots(hours, interval) {
  const numBars = Math.round(1440 / interval);
  const buckets = new Array(numBars).fill(0);
  hours.forEach((mins, h) => {
    if (!mins) return;
    const startSlot   = Math.round((h * 60) / interval);
    const endSlot     = Math.round(((h + 1) * 60) / interval);
    const slotsInHour = endSlot - startSlot || 1;
    const minsPerSlot = mins / slotsInHour;
    for (let s = startSlot; s < endSlot && s < numBars; s++) buckets[s] = minsPerSlot;
  });
  return buckets;
}

/*
  Render the top-of-page sparkline showing today's scan activity (Philippine time).
  Displays peak online count and new user count per hour, 0h–23h left to right.
  Clicking on this chart opens the 30-day activity modal.
*/
function renderHeaderSparkline() {
  const svgEl = $('headerSparkSvg');
  if (!svgEl) return;

  const interval  = scanInterval || 5;
  const numBars   = Math.round(1440 / interval);
  const todayPhMs = (() => {
    const d = new Date(Date.now() + PH_OFFSET_MS);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime() - PH_OFFSET_MS;
  })();
  const prevDayPhMs = todayPhMs - 86400000;

  /* Populate sparkline bins with peak counts: previous day (grey) + current day (color). */
  const prevPrimary = new Array(numBars).fill(0);
  const prevSecondary = new Array(numBars).fill(0);
  const primary = new Array(numBars).fill(0);
  const secondary = new Array(numBars).fill(0);
  let hasCurrent = false;
  let hasPrev = false;
  for (const { ts, count, newCount } of totals) {
    const todayOffset = ts - todayPhMs;
    if (todayOffset >= 0 && todayOffset < 86400000) {
      const slot = Math.floor(todayOffset / (interval * 60000));
      if (slot >= 0 && slot < numBars) {
        primary[slot]   = Math.max(primary[slot],   count    || 0);
        secondary[slot] = Math.max(secondary[slot], newCount || 0);
        hasCurrent = true;
      }
      continue;
    }

    const prevOffset = ts - prevDayPhMs;
    if (prevOffset >= 0 && prevOffset < 86400000) {
      const slot = Math.floor(prevOffset / (interval * 60000));
      if (slot >= 0 && slot < numBars) {
        prevPrimary[slot] = Math.max(prevPrimary[slot], count || 0);
        prevSecondary[slot] = Math.max(prevSecondary[slot], newCount || 0);
        hasPrev = true;
      }
    }
  }

  if (!hasCurrent && !hasPrev) {
    svgEl.innerHTML = '<text x="0" y="14" font-size="9" fill="var(--muted)">no scans today</text>';
    return;
  }

  svgEl.innerHTML = buildSparkSVG(primary, secondary, {
    vw: 600, h: 56, ah: 18, interval,
    bgSeries: prevPrimary,
    bgSecondary: prevSecondary,
    bgColor: 'rgba(130,140,160,0.42)',
    bgColor2: 'rgba(150,150,170,0.55)',
    tip: (i, v, v2) => {
      const phMin = i * interval;
      const hh = String(Math.floor(phMin/60)).padStart(2,'0');
      const mm = String(phMin%60).padStart(2,'0');
      return `${hh}:${mm} PH — ${v} online, ${v2} new`;
    }
  });
}

/*
  =====================================================
  ACTIVITY ANALYTICS MODALS
  =====================================================
  
  Modal dialogs showing detailed activity analysis: 30-day overview,
  daily breakdowns, and per-user session history.
*/

/*
  Open modal showing the last 30 days of activity totals (not per-user, but site-wide).
  Displays peak online/new counts per day with clickable date selection for hourly detail view.
*/
function openTotalsActivityModal() {
  // Build 30-day data from totals — peak online+new per day
  const byDayPH = {};
  for (const { ts, count, newCount } of totals) {
    const day = tsToPhDay(ts);
    if (!byDayPH[day]) byDayPH[day] = { count: 0, newCount: 0 };
    byDayPH[day].count    = Math.max(byDayPH[day].count,    count    || 0);
    byDayPH[day].newCount = Math.max(byDayPH[day].newCount, newCount || 0);
  }
  const nowPh = phNow();
  const days = [];
  for (let d=29; d>=0; d--) {
    const date = tsToPhDay(nowPh - d*86400000);
    const info = byDayPH[date] || { count: 0, newCount: 0 };
    days.push({ date, count: info.count, newCount: info.newCount });
  }
  const todayStr = tsToPhDay(nowPh);
  let selectedDay = todayStr;

  // ── daily detail: per-scan sparkline for a given day ──────────────────
  const VW=560, H=80, AH=22;
  function buildDailyDetail(dateStr) {
    // Collect all scan totals for this day, sorted by ts
    const scans = totals
      .filter(r => tsToPhDay(r.ts) === dateStr)
      .sort((a,b)=>a.ts-b.ts);
    if (!scans.length) {
      return `<div style="color:var(--muted);font-size:11px;padding:8px 0">No data for ${dateStr}</div>`;
    }
    const maxC = Math.max(...scans.map(s=>s.count||0), 1);
    const dayStart = new Date(dateStr + 'T00:00:00+08:00').getTime();
    const dayMs = 86400000;
    const bars = scans.map(s => {
      const frac = Math.min(1, Math.max(0, (s.ts - dayStart) / dayMs));
      const x    = Math.round(frac * VW);
      const bH   = Math.max(2, Math.round(((s.count||0)/maxC)*H));
      const bHN  = Math.max(s.newCount>0?1:0, Math.round(((s.newCount||0)/maxC)*H));
      return `<g>
        <rect x="${x}" y="${H-bH}" width="4" height="${bH}" rx="1" fill="rgba(0,201,167,0.7)">
          <title>${new Date(s.ts).toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'})}: ${s.count} online</title>
        </rect>
        ${bHN?`<rect x="${x}" y="${H-bHN}" width="4" height="${bHN}" rx="1" fill="rgba(255,45,155,0.85)"/>`:''}</g>`;
    }).join('');
    const hourMarks = [0,3,6,9,12,15,18,21,24].map(h => {
      const x = Math.round((h/24)*VW);
      const anchor = h===0?'start':h===24?'end':'middle';
      return `<g transform="translate(${x},0)">
        <line x1="0" y1="0" x2="0" y2="5" stroke="#4a4a6a" stroke-width="1"/>
        <text x="0" y="14" text-anchor="${anchor}" font-size="10" font-family="DM Mono,monospace" fill="#7a7a9a">${h}</text>
      </g>`;
    }).join('');
    return `<svg width="100%" viewBox="0 0 ${VW} ${H+AH+2}" preserveAspectRatio="xMidYMid meet" style="display:block;overflow:visible">
      <line x1="0" y1="${H}" x2="${VW}" y2="${H}" stroke="#252538" stroke-width="1"/>
      ${bars}
      <g transform="translate(0,${H})">${hourMarks}</g>
    </svg>`;
  }

  // ── 30-day bar chart ──────────────────────────────────────────────────
  const VW30=560, H30=56, BAR_AH=22;
  const maxDay = Math.max(...days.map(d=>d.count), 1);
  const bw30   = Math.max(2, Math.floor(VW30/days.length)-2);

  function buildDayBars(selDate) {
    return days.map((d,i) => {
      const bH   = Math.max(d.count>0?2:0, Math.round((d.count/maxDay)*H30));
      const bHN  = Math.max(d.newCount>0?1:0, Math.round((d.newCount/maxDay)*H30));
      const x    = Math.round((i/days.length)*VW30);
      const sel  = d.date===selDate;
      const fill = sel ? 'rgba(255,45,155,0.9)' : 'rgba(0,201,167,0.7)';
      const isFirst = i===0 || d.date.slice(5,7)!==days[i-1]?.date.slice(5,7);
      const label = isFirst ? d.date.slice(5) : d.date.slice(8);
      return `<g class="day-bar-g" data-date="${d.date}" style="cursor:pointer">
        <rect class="day-rect" x="${x}" y="${H30-bH}" width="${bw30}" height="${bH}" rx="1"
          fill="${fill}" opacity="${d.count>0?1:0.15}">
          <title>${d.date}: ${d.count} online, ${d.newCount} new</title>
        </rect>
        ${bHN?`<rect x="${x}" y="${H30-bHN}" width="${bw30}" height="${bHN}" rx="1" fill="rgba(255,45,155,0.85)" pointer-events="none"/>`:'' }
        <rect x="${x}" y="0" width="${Math.max(bw30,8)}" height="${H30}" fill="transparent"/>
        <g transform="translate(${x+bw30/2},${H30+4})">
          <text transform="rotate(-45)" text-anchor="end" font-size="7" font-family="DM Mono,monospace"
            fill="${sel?'rgba(255,45,155,0.9)':'#4a4a6a'}">${label}</text>
        </g>
      </g>`;
    }).join('');
  }

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal act-modal">
      <button class="modal-close">&#x2715;</button>
      <div class="modal-header">
        <div style="font-family:var(--disp);font-size:17px;font-weight:700;color:var(--cyan)">Overall 30-day Activity</div>
      </div>
      <div class="modal-section">
        <div class="modal-section-title" id="totDailyTitle">Detail: ${todayStr} (PH time)</div>
        <div id="totDailyPlot"></div>
      </div>
      <div class="modal-section">
        <div class="modal-section-title">30-day overview — click to inspect</div>
        <svg id="totDaysSvg" width="100%"
          viewBox="0 0 ${VW30} ${H30+BAR_AH}"
          style="overflow:visible;display:block;cursor:pointer">
          ${buildDayBars(todayStr)}
        </svg>
      </div>
      <div style="margin-top:8px;display:flex;gap:12px;font-size:10px;color:var(--muted)">
        <span><span style="display:inline-block;width:10px;height:10px;background:rgba(0,201,167,0.55);border-radius:2px;vertical-align:middle;margin-right:4px"></span>Online users</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:rgba(255,45,155,0.85);border-radius:2px;vertical-align:middle;margin-right:4px"></span>New users</span>
      </div>
    </div>`;

  modal.querySelector('.modal-close').addEventListener('click', ()=>modal.remove());
  modal.addEventListener('click', e=>{ if(e.target===modal) modal.remove(); });

  function selectDay(dateStr) {
    selectedDay = dateStr;
    modal.querySelectorAll('.day-rect').forEach(r => {
      const d = r.parentElement.dataset.date;
      r.setAttribute('fill', d===dateStr ? 'rgba(255,45,155,0.9)' : 'rgba(0,201,167,0.7)');
    });
    modal.querySelectorAll('.day-bar-g text').forEach(t => {
      const d = t.closest('.day-bar-g').dataset.date;
      t.setAttribute('fill', d===dateStr ? 'rgba(255,45,155,0.9)' : '#4a4a6a');
    });
    modal.querySelector('#totDailyTitle').textContent = `Detail: ${dateStr} (PH time)`;
    modal.querySelector('#totDailyPlot').innerHTML = buildDailyDetail(dateStr);
  }

  modal.querySelector('#totDaysSvg').addEventListener('click', e => {
    const g = e.target.closest('.day-bar-g');
    if (g) selectDay(g.dataset.date);
  });

  selectDay(todayStr);
  document.body.appendChild(modal);
}

// ─── Filter + sort ────────────────────────────────────────────────────────────

// ─── Geocoding + haversine (static table, no API) ────────────────────────────

/*
  =====================================================
  FILTER STATE & GEOLOCATION
  =====================================================

  Store filter selections and location data for radius-based geographic filtering.
  Includes coordinates for Philippine cities + select international cities.
*/

/* Current search text filter (filters on username via substring match) — DECLARED ABOVE */
/* searchQuery is already declared at top of file */

/* Current sort key: 'last_seen_desc', 'name_asc', 'online_time_desc', etc. — DECLARED ABOVE */
/* sortKey is already declared at top of file */

/* Currently selected city for geographic filtering — DECLARED ABOVE */
/* locationFilter is already declared at top of file */

/* Radius in km from selected city (0 = exact match only) — DECLARED ABOVE */
/* radiusKm is already declared at top of file */

/* Type filter flags: which user badges to match — DECLARED ABOVE */
/* typeFilters is already declared at top of file */

/* Age range filter (null = no filter) — DECLARED ABOVE */
/* ageMin and ageMax are already declared at top of file */

/*
  Coordinate table for geographic filtering via haversine distance calculation.
  Includes Philippine cities (by far the majority) plus select international hubs.
  Used for radius-based location searches.
*/
const PH_CITY_COORDS = {
  "Angeles": {lat:15.145,lng:120.5887},
  "Antipolo": {lat:14.6286,lng:121.176},
  "Bacolod": {lat:10.677,lng:122.956},
  "Bacoor": {lat:14.458,lng:120.958},
  "Bago": {lat:10.5369,lng:122.8383},
  "Baguio": {lat:16.4023,lng:120.596},
  "Bais": {lat:9.5906,lng:123.1215},
  "Batac": {lat:18.0551,lng:120.5651},
  "Batangas City": {lat:13.7565,lng:121.0583},
  "Bayugan": {lat:8.7108,lng:125.7686},
  "Binan": {lat:14.3397,lng:121.0803},
  "Bislig": {lat:8.2078,lng:126.3267},
  "Bogo": {lat:11.053,lng:124.006},
  "Boracay": {lat:11.9674,lng:121.9248},
  "Borongan": {lat:11.6076,lng:125.4319},
  "Butuan": {lat:8.949,lng:125.5436},
  "Cabadbaran": {lat:9.1236,lng:125.535},
  "Cabanatuan": {lat:15.4864,lng:120.9716},
  "Cadiz": {lat:11.2333,lng:123.3},
  "Cagayan de Oro": {lat:8.4542,lng:124.6319},
  "Calamba": {lat:14.2113,lng:121.1653},
  "Calbayog": {lat:12.0647,lng:124.5975},
  "Caloocan": {lat:14.6576,lng:120.967},
  "Canlaon": {lat:10.3886,lng:123.1981},
  "Carcar": {lat:10.106,lng:123.6397},
  "Catbalogan": {lat:11.7756,lng:124.8858},
  "Cauayan": {lat:16.9208,lng:121.7727},
  "Cavite City": {lat:14.4791,lng:120.897},
  "Cebu": {lat:10.3157,lng:123.8854},
  "Cebu City": {lat:10.3157,lng:123.8854},
  "Cotabato City": {lat:7.2236,lng:124.2461},
  "Dagupan": {lat:16.043,lng:120.333},
  "Danao": {lat:10.5205,lng:124.0266},
  "Dapitan": {lat:8.6556,lng:123.4244},
  "Dasmarinas": {lat:14.3294,lng:120.9367},
  "Davao": {lat:7.1907,lng:125.4553},
  "Davao City": {lat:7.1907,lng:125.4553},
  "Digos": {lat:6.7497,lng:125.3572},
  "Dipolog": {lat:8.5897,lng:123.3417},
  "Dumaguete": {lat:9.3068,lng:123.3068},
  "El Salvador": {lat:8.5614,lng:124.5208},
  "General Santos": {lat:6.1128,lng:125.1717},
  "General Trias": {lat:14.386,lng:120.8808},
  "Gingoog": {lat:8.8222,lng:125.1106},
  "Ilagan": {lat:17.1486,lng:121.889},
  "Iligan": {lat:8.228,lng:124.2452},
  "Iloilo": {lat:10.7202,lng:122.5621},
  "Iloilo City": {lat:10.7202,lng:122.5621},
  "Imus": {lat:14.4297,lng:120.9367},
  "Iriga": {lat:13.4234,lng:123.4094},
  "Island Garden City of Samal": {lat:7.0556,lng:125.7264},
  "Kabankalan": {lat:9.9897,lng:122.8138},
  "Kalibo": {lat:11.7038,lng:122.3647},
  "Kidapawan": {lat:7.0083,lng:125.0894},
  "Koronadal": {lat:6.5033,lng:124.8467},
  "Laoag": {lat:18.1977,lng:120.5936},
  "Lapu-Lapu": {lat:10.3103,lng:123.9494},
  "Las Pinas": {lat:14.4453,lng:120.983},
  "Legazpi": {lat:13.1391,lng:123.7438},
  "Lipa": {lat:13.9411,lng:121.1628},
  "Lucena": {lat:13.9373,lng:121.6175},
  "Maasin": {lat:10.1311,lng:124.8456},
  "Makati": {lat:14.5547,lng:121.0244},
  "Malabon": {lat:14.6625,lng:120.9567},
  "Malaybalay": {lat:8.1575,lng:125.1278},
  "Mandaluyong": {lat:14.5794,lng:121.0359},
  "Mandaue": {lat:10.3236,lng:123.9223},
  "Manila": {lat:14.5995,lng:120.9842},
  "Maramag": {lat:7.7611,lng:125.0108},
  "Marawi": {lat:8.0,lng:124.2833},
  "Marikina": {lat:14.6507,lng:121.1029},
  "Mati": {lat:6.9533,lng:126.2197},
  "Muntinlupa": {lat:14.4081,lng:121.0415},
  "Naga": {lat:13.6192,lng:123.1814},
  "Navotas": {lat:14.6669,lng:120.9427},
  "Olongapo": {lat:14.8326,lng:120.2828},
  "Ormoc": {lat:11.005,lng:124.6076},
  "Oroquieta": {lat:8.4853,lng:123.8056},
  "Ozamiz": {lat:8.15,lng:123.85},
  "Pagadian": {lat:7.8278,lng:123.4358},
  "Panabo": {lat:7.3092,lng:125.6839},
  "Paranaque": {lat:14.4793,lng:121.0198},
  "Pasay": {lat:14.5378,lng:121.0014},
  "Pasig": {lat:14.5764,lng:121.0851},
  "Passi": {lat:11.1044,lng:122.6406},
  "Pateros": {lat:14.545,lng:121.0681},
  "Quezon City": {lat:14.676,lng:121.0437},
  "Roxas City": {lat:11.5858,lng:122.7511},
  "Sagay": {lat:11.0833,lng:123.4167},
  "San Carlos": {lat:15.9268,lng:120.353},
  "San Fernando": {lat:15.0286,lng:120.6899},
  "San Jose": {lat:15.7944,lng:121.0946},
  "San Juan": {lat:14.6019,lng:121.0355},
  "San Pablo": {lat:14.069,lng:121.3248},
  "Santa Rosa": {lat:14.3122,lng:121.1114},
  "Silay": {lat:10.8003,lng:122.9739},
  "Sorsogon City": {lat:12.9742,lng:124.0069},
  "Surigao City": {lat:9.7833,lng:125.5},
  "Tacloban": {lat:11.2543,lng:125.0},
  "Tacurong": {lat:6.6928,lng:124.6769},
  "Tagbilaran": {lat:9.65,lng:123.85},
  "Taguig": {lat:14.5243,lng:121.0792},
  "Tagum": {lat:7.4478,lng:125.8078},
  "Talisay": {lat:10.2447,lng:123.8494},
  "Tanauan": {lat:14.085,lng:121.1504},
  "Tandag": {lat:9.0772,lng:126.1978},
  "Tangub": {lat:8.0642,lng:123.7492},
  "Tarlac City": {lat:15.4755,lng:120.596},
  "Toledo": {lat:10.3774,lng:123.638},
  "Trece Martires": {lat:14.2806,lng:120.8614},
  "Tuguegarao": {lat:17.6132,lng:121.727},
  "Urdaneta": {lat:15.976,lng:120.571},
  "Valencia": {lat:7.9047,lng:125.0936},
  "Valenzuela": {lat:14.7011,lng:120.983},
  "Victorias": {lat:10.9003,lng:123.0728},
  "Vigan": {lat:17.5747,lng:120.3869},
  "Zamboanga": {lat:6.9214,lng:122.079},
  "Zamboanga City": {lat:6.9214,lng:122.079},
  "Abu Dhabi": {lat:24.4539,lng:54.3773},
  "Alabel": {lat:6.0972,lng:125.1597},
  "Alaminos": {lat:16.1553,lng:119.9797},
  "Balanga": {lat:14.6761,lng:120.5364},
  "Bangkok": {lat:13.7563,lng:100.5018},
  "Bayawan": {lat:9.3667,lng:122.8},
  "Baybay": {lat:10.6833,lng:124.8},
  "Calapan": {lat:13.4119,lng:121.1803},
  "Candon": {lat:17.1944,lng:120.4483},
  "Carmen": {lat:9.8333,lng:124.1833},
  "City of Isabela": {lat:6.7058,lng:121.9706},
  "Cotabato": {lat:7.2236,lng:124.2461},
  "Dinalupihan": {lat:14.8731,lng:120.4622},
  "Doha": {lat:25.2854,lng:51.531},
  "Dubai": {lat:25.2048,lng:55.2708},
  "Escalante": {lat:10.8383,lng:123.5025},
  "Gapan": {lat:15.3069,lng:120.9469},
  "Guihulngan": {lat:10.1167,lng:123.2667},
  "Himamaylan": {lat:10.1,lng:122.8667},
  "Hong Kong": {lat:22.3193,lng:114.1694},
  "Ipil": {lat:7.7833,lng:122.5833},
  "Kuala Lumpur": {lat:3.139,lng:101.6869},
  "La Carlota": {lat:10.4225,lng:122.9231},
  "Lamitan": {lat:6.6544,lng:122.1303},
  "Ligao": {lat:13.2208,lng:123.5225},
  "London": {lat:51.5074,lng:-0.1278},
  "Masbate City": {lat:12.3667,lng:123.6167},
  "Meycauayan": {lat:14.7353,lng:120.9608},
  "Midsayap": {lat:7.1833,lng:124.5333},
  "Naga City": {lat:13.6192,lng:123.1814},
  "Nasipit": {lat:8.9667,lng:125.35},
  "Naval": {lat:11.5667,lng:124.4},
  "Palayan": {lat:15.5406,lng:121.0839},
  "Puerto Princesa": {lat:9.7392,lng:118.7353},
  "Riyadh": {lat:24.7136,lng:46.6753},
  "Samal": {lat:14.7667,lng:120.5431},
  "San Fernando City": {lat:16.6159,lng:120.3166},
  "San Jose del Monte": {lat:14.8137,lng:121.0453},
  "Santiago": {lat:16.6875,lng:121.5503},
  "Seoul": {lat:37.5665,lng:126.978},
  "Singapore": {lat:1.3521,lng:103.8198},
  "Sipalay": {lat:9.7553,lng:122.4022},
  "Sydney": {lat:-33.8688,lng:151.2093},
  "Tabaco": {lat:13.3583,lng:123.7333},
  "Tabuk": {lat:17.4189,lng:121.4442},
  "Tanjay": {lat:9.5167,lng:123.1583},
  "Tayabas": {lat:14.0225,lng:121.5925},
  "Tokyo": {lat:35.6762,lng:139.6503},
  "Wao": {lat:7.6417,lng:124.7297},
};

/* 
  Haversine distance formula: calculate great-circle distance in kilometers
  between two lat/lng pairs using spherical law of cosines.
*/
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* 
  Look up city coordinates by name.
  Performs direct lookup first, then case-insensitive fallback.
  Returns {lat, lng} or null if not found.
*/
function cityCoords(name) {
  if (!name) return null;
  /* Direct lookup first */
  if (PH_CITY_COORDS[name]) return PH_CITY_COORDS[name];
  /* Case-insensitive fallback */
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(PH_CITY_COORDS)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/* Cache for selected location's coordinates (used for radius filtering) */
let selectedCityCoords = null;

/* 
  Update the cached coordinates for the currently selected location.
  Called when location filter changes, then triggers applyAndRender().
*/
function updateSelectedCityCoords() {
  selectedCityCoords = locationFilter ? cityCoords(locationFilter) : null;
  applyAndRender();
}

/*
  =====================================================
  FILTERING & SORTING LOGIC
  =====================================================
  
  Apply all active filters (search, age, location, type, sorted by selected key)
  and return the filtered/sorted subset of allUsers.
*/

/*
  Compute the filtered user set based on all active filter constraints.
  
  Returns a new allUsers subset. Multiple filters are AND'd together:
  - Type filters (new/premium/verified): when any is active, ONLY show those flags
  - Age range: users outside [ageMin, ageMax] excluded
  - Location: exact match OR within radius if radius > 0
  - Search: substring match on username (case-insensitive)
  - Sort: applied as final step by active sortKey
*/
function computeFiltered() {
  const anyTypeActive = Object.values(typeFilters).some(Boolean);
  let r = allUsers.filter(u => {
    if (anyTypeActive) {
      /*
        Type filter logic: if ANY badge type is activated, then ALL active types are required
        and ALL inactive types must NOT be present. This creates an AND condition.
      */
      if (typeFilters.new      && !u.isNew)      return false;
      if (typeFilters.premium  && !u.isPremium)  return false;
      if (typeFilters.verified && !u.isVerified) return false;
      if (!typeFilters.new      && u.isNew)      return false;
      if (!typeFilters.premium  && u.isPremium)  return false;
      if (!typeFilters.verified && u.isVerified) return false;
    }
    if (ageMin!=null && u.age!=null && u.age < ageMin) return false;
    if (ageMax!=null && u.age!=null && u.age > ageMax) return false;
    if (locationFilter) {
      const uLoc = (u.location||'').trim();
      if (radiusKm === 0 || !selectedCityCoords) {
        /*
          Exact match: location must match selected city name exactly
        */
        if (uLoc !== locationFilter) return false;
      } else {
        /*
          Radius match: include users within radiusKm of selected city
        */
        const uCoords = cityCoords(uLoc);
        if (!uCoords) return false; /* city not in table — exclude from radius filter */
        const dist = haversineKm(selectedCityCoords.lat, selectedCityCoords.lng, uCoords.lat, uCoords.lng);
        if (dist > radiusKm) return false;
      }
    }
    return true;
  });
  
  if (searchQuery) { 
    const q=searchQuery.toLowerCase(); 
    r=r.filter(u=>(u.username||'').toLowerCase().includes(q)); 
  }
  
  /* Sort by active key */
  const lastSeenTs = u => u.lastSeen || 0;
  const joinTs = u => {
    /* joinMonth from scan record ("2025-07") or stored profile */
    const jm = u.joinMonth || (profiles[u.username]||{}).joinMonth || null;
    if (!jm) return Infinity; /* unknown → push to end on asc, start on desc */
    const [y,m] = jm.split('-');
    return new Date(+y, +m-1).getTime();
  };

  switch (sortKey) {
    case 'name_asc':         r.sort((a,b)=>(a.username||'').localeCompare(b.username||'')); break;
    case 'name_desc':        r.sort((a,b)=>(b.username||'').localeCompare(a.username||'')); break;
    case 'join_asc':         r.sort((a,b)=>joinTs(a)-joinTs(b)); break;
    case 'join_desc':        r.sort((a,b)=>joinTs(b)-joinTs(a)); break;
    case 'online_time_desc': r.sort((a,b)=>totalMinutes(b.username)-totalMinutes(a.username)); break;
    case 'online_time_asc':  r.sort((a,b)=>totalMinutes(a.username)-totalMinutes(b.username)); break;
    case 'last_seen_desc':   r.sort((a,b)=>lastSeenTs(b)-lastSeenTs(a)); break;
    case 'last_seen_asc':    r.sort((a,b)=>lastSeenTs(a)-lastSeenTs(b)); break;
    case 'age_asc':          r.sort((a,b)=>(a.age??999)-(b.age??999)); break;
    case 'age_desc':         r.sort((a,b)=>(b.age??-1)-(a.age??-1)); break;
    default:                 r.sort((a,b)=>lastSeenTs(b)-lastSeenTs(a)); break; /* default: last_seen_desc */
  }
  return r;
}

/* Apply filters, sort, and reset lazy index to 0 (re-render from start) */
function applyAndRender() { filteredUsers=computeFiltered(); lazyIndex=0; render(); }

/* Persist current filter selections to storage */
function saveFilters() { chrome.storage.local.set({pinalove_filters:{ageMin,ageMax,sort:sortKey,typeFilters}}); }

/* Persist current filter selections to storage */
function saveFilters() { chrome.storage.local.set({pinalove_filters:{ageMin,ageMax,sort:sortKey,typeFilters}}); }

/*
  =====================================================
  MAIN RENDERING — Grid/Table Views
  =====================================================
  
  Large-scale rendering with lazy loading to prevent UI freezing.
  Handles both grid (card) and table (row) view modes.
  Uses IntersectionObserver to load more items as user scrolls.
*/

/*
  Main render function: builds grid or table container and initiates first batch render.
  
  Sorts cards/rows into 3 groups:
  - Header: count pills (online now, new, premium, verified, total filtered)
  - Main content: grid of cards or table of rows (lazy-loaded)
  - Empty state: shown if no data or no matches
*/
function render() {
  const main = $('mainContent');

  /* 
    Header pills show aggregate stats across ALL members:
    - Online: users seen in the most recent scan (isOnline flag)
    - New: total members flagged as new by PinaLove
    - Premium: total members flagged as premium
    - Verified: total members flagged as verified
  */
  const onlineCount   = allUsers.filter(u => u.isOnline).length;
  const newCount      = allUsers.filter(u => u.isNew).length;
  const premiumCount  = allUsers.filter(u => u.isPremium).length;
  const verifiedCount = allUsers.filter(u => u.isVerified).length;
  $('hOnline').textContent   = onlineCount;
  $('hNew').textContent      = newCount;
  $('hPremium').textContent  = premiumCount;
  $('hVerified').textContent = verifiedCount;
  $('resultCount').innerHTML = `<strong>${filteredUsers.length}</strong> of ${allUsers.length}`;

  if (!allUsers.length) {
    main.innerHTML = `<div class="empty"><div class="empty-icon">📭</div><div class="empty-text">No scan data yet</div><div class="empty-sub">Run a scan from the extension popup first</div></div>`;
    return;
  }
  if (!filteredUsers.length) {
    main.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><div class="empty-text">No users match the current filters</div></div>`;
    return;
  }

  /* Disconnect old observer before rebuilding */
  if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }

  if (viewMode === 'grid') {
    /* Grid view: creates lazy-loadable card grid + sentinel for intersection detection */
    main.innerHTML = `<div class="grid" id="lazyGrid"></div><div class="lazy-sentinel" id="lazySentinel"><span class="lazy-spinner">…</span></div>`;
    lazyIndex = 0;
    renderLazyBatch();
    setupLazyObserver();
  } else {
    /* Table view: creates lazy-loadable row table + sentinel */
    main.innerHTML = `<div class="table-wrap"><table class="user-table" id="lazyTable">
      <thead><tr><th></th><th>Username</th><th>Age</th><th>Location</th><th>Joined</th><th>Type</th><th>Today (PH)</th><th>30d online</th></tr></thead>
      <tbody id="lazyTableBody"></tbody>
    </table></div><div class="lazy-sentinel" id="lazySentinel"><span class="lazy-spinner">…</span></div>`;
    lazyIndex = 0;
    renderLazyTableBatch();
    setupLazyObserver();
  }
}

/*
  Render next batch of grid cards (LAZY_BATCH at a time).
  Appends card divs to main grid container.
  Re-wires event handlers and applies visited badges.
  Hides sentinel when done loading.
*/
function renderLazyBatch() {
  const grid = $('lazyGrid');
  if (!grid) return;
  const end = Math.min(lazyIndex + LAZY_BATCH, filteredUsers.length);
  const frag = document.createDocumentFragment();
  for (let i = lazyIndex; i < end; i++) {
    const div = document.createElement('div');
    div.innerHTML = renderCard(filteredUsers[i]);
    const card = div.firstElementChild;
    frag.appendChild(card);
  }
  grid.appendChild(frag);
  lazyIndex = end;

  /* Wire click handlers for profile modal (whole card) and external link (username <a>) */
  grid.querySelectorAll('.profile-trigger:not([data-wired])').forEach(el => {
    el.setAttribute('data-wired', '1');
    const wu = allUsers.find(u => u.username === el.dataset.username);
    if (wu?.visitedAt) applyVisitedBadge(wu.username);
    el.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      e.preventDefault(); e.stopPropagation();
      const u   = allUsers.find(u => u.username === el.dataset.username);
      const idx = filteredUsers.findIndex(u => u.username === el.dataset.username);
      openProfileModal(el.dataset.username, el.dataset.url, u, idx);
    });
  });

  /* Hide sentinel when all items loaded */
  const sentinel = $('lazySentinel');
  if (sentinel) sentinel.style.display = lazyIndex >= filteredUsers.length ? 'none' : 'flex';
}

/*
  Render next batch of table rows (LAZY_BATCH at a time).
  Similar to renderLazyBatch but for table view mode.
*/
function renderLazyTableBatch() {
  const tbody = $('lazyTableBody');
  if (!tbody) return;
  const end  = Math.min(lazyIndex + LAZY_BATCH, filteredUsers.length);
  const frag = document.createDocumentFragment();
  for (let i = lazyIndex; i < end; i++) {
    const u     = filteredUsers[i];
    const href  = u.profileUrl || '#';
    const thumb = u.photoUrl
      ? `<div style="cursor:pointer"><img src="${thumbPhotoUrl(u.photoUrl)}" style="width:34px;height:38px;object-fit:cover;border-radius:4px;display:block" loading="lazy"></div>`
      : `<div style="width:34px;height:38px;border-radius:4px;background:var(--surf2);display:flex;align-items:center;justify-content:center;font-size:15px">👤</div>`;
    const name   = `<a href="${href}" target="_blank" class="user-link" onclick="event.stopPropagation()">${esc(u.username||'?')}</a>`;
    const extras = [u.isNew?'✨':'', u.isPremium?'👑':'', u.isVerified?'✅':''].filter(Boolean).join(' ');
    const tot    = totalMinutes(u.username);
    const jmCell = (() => {
      const jm = u.joinMonth || (profiles[u.username]||{}).joinMonth || null;
      if (!jm) return `<td style="color:var(--muted2);font-size:10px">—</td>`;
      const [y, mo] = jm.split('-');
      const lbl = '\u2264\u202f' + new Date(+y, +mo-1).toLocaleDateString('en-US', {month:'short', year:'numeric'});
      return `<td style="color:${joinColor(jm)};font-size:10px;white-space:nowrap;font-weight:600">${lbl}</td>`;
    })();
    const tr = document.createElement('tr');
    tr.dataset.username = u.username;
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
      <td style="width:42px;padding:4px 6px">${thumb}</td>
      <td>${name}</td>
      <td>${u.age ?? '—'}</td>
      <td style="color:var(--muted2)">${esc(u.location||'—')}</td>
      ${jmCell}
      <td>${extras||'—'}</td>
      <td><div class="table-spark-wrap">${renderSparkline(u.username)}</div></td>
      <td style="color:var(--muted2);font-size:10px;white-space:nowrap">${tot ? fmtMinutes(tot) : '—'}</td>`;
    if (u.visitedAt) tr.classList.add('visited');
    tr.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      const usr = allUsers.find(x => x.username === u.username);
      const idx = filteredUsers.findIndex(x => x.username === u.username);
      openProfileModal(u.username, href, usr, idx);
    });
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  lazyIndex = end;
  const sentinel = $('lazySentinel');
  if (sentinel) sentinel.style.display = lazyIndex >= filteredUsers.length ? 'none' : 'flex';
}

/*
  Set up IntersectionObserver to detect when sentinel element becomes visible.
  When visible, renders next batch of items (and moves sentinel further down).
*/
function setupLazyObserver() {
  const sentinel = $('lazySentinel');
  if (!sentinel) return;
  lazyObserver = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && lazyIndex < filteredUsers.length) {
      viewMode === 'grid' ? renderLazyBatch() : renderLazyTableBatch();
    }
  }, { rootMargin: '200px' });
  lazyObserver.observe(sentinel);
}

/*
  =====================================================
  GRID CARD RENDERING
  =====================================================
  
  Mini sparklines and card templates for grid view.
  Each card shows user profile thumbnail, metadata, and 24h activity sparkline.
*/

/*
  Render a compact 24h activity sparkline for a profile card (grid view).
  Shows activity for today in PH time, with hours 0-23 left to right.
  Uses fixed pixel width (not %) to avoid layout thrashing in table cells.
*/
function renderSparkline(username) {
  const todayPH  = tsToPhDay(Date.now());
  const slots15  = getDayBuckets96((history[username] || {})[todayPH]);
  const hasData  = slots15.some(m => m > 0);
  if (!hasData) return `<div class="spark-empty">no activity today</div>`;

  const interval = 15;
  const primary  = slots15;

  /* Fixed dimensions to prevent layout shifts */
  const VW = 120, H = 28, AH = 10;
  const numBars = primary.length;
  const max     = Math.max(...primary, 1);
  const barW    = Math.max(1, Math.round(VW / numBars) - (VW / numBars > 2 ? 1 : 0));
  const bars = primary.map((v, i) => {
    const bH    = Math.max(v > 0 ? 2 : 0, Math.round((v / max) * H));
    const x     = Math.round((i / numBars) * VW);
    const phMin = i * interval;
    const hh    = String(Math.floor(phMin / 60)).padStart(2, '0');
    const mm    = String(phMin % 60).padStart(2, '0');
    return `<rect x="${x}" y="${H-bH}" width="${barW}" height="${bH}" rx="1" fill="var(--teal)" opacity="${v>0?0.8:0.1}"><title>${hh}:${mm} PH — ${fmtMinutes(Math.round(v))}</title></rect>`;
  }).join('');
  const axis = [0,12,24].map(h => {
    const x = Math.round((h/24)*VW), anchor = h===0?'start':h===24?'end':'middle';
    return `<g transform="translate(${x},0)"><line x1="0" y1="0" x2="0" y2="3" stroke="#4a4a6a" stroke-width="1"/><text x="0" y="9" text-anchor="${anchor}" font-size="6" font-family="DM Mono,monospace" fill="#7a7a9a">${h}</text></g>`;
  }).join('');
  return `<svg class="sparkline-svg" width="${VW}" height="${H+AH}" viewBox="0 0 ${VW} ${H+AH}" style="overflow:visible"><line x1="0" y1="${H}" x2="${VW}" y2="${H}" stroke="#252538" stroke-width="1"/>${bars}<g transform="translate(0,${H})">${axis}</g></svg>`;
}

/*
  Map join date age (months) to a color gradient: fresh (green) → old (red).
  Used in profile cards and tables to visually show profile age.
*/
function joinColor(jm) {
  if (!jm) return 'var(--muted2)';
  const [y, m] = jm.split('-');
  const ageMs  = Date.now() - new Date(+y, +m - 1).getTime();
  const months = ageMs / (1000 * 60 * 60 * 24 * 30.44);
  /* 0 months = green #00e676, 24 months = red #ff3d3d */
  const t = Math.min(1, Math.max(0, months / 24));
  const r = Math.round(t * 255);
  const g = Math.round((1 - t) * 200 + 50);
  return `rgb(${r},${g},30)`;
}

/*
  Render a single user profile card for grid view.
  Includes: thumbnail photo, name link, metadata (age/location), join date, and 24h sparkline.
  
  Returns: HTML string for a .user-card div (styled in popup.html or results.html)
*/
function renderCard(u) {
  const href    = u.profileUrl||'#';
  const nameTxt = esc(u.username||'?');
  const photo   = u.photoUrl ? `<img src="${thumbPhotoUrl(u.photoUrl)}" alt="${nameTxt}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : '';
  const ph      = `<div class="card-photo-placeholder" style="${u.photoUrl?'display:none':''}">👤</div>`;
  const meta    = [u.age?`${u.age}`:null, u.location?esc(u.location):null].filter(Boolean).join(', ');
  const jm      = u.joinMonth || (profiles[u.username]||{}).joinMonth || null;
  const joinLbl = jm ? (() => { const [y,m] = jm.split('-'); return '\u2264\u202f'+new Date(+y,+m-1).toLocaleDateString('en-US',{month:'short',year:'numeric'}); })() : null;
  const spark   = renderSparkline(u.username);

  return `<div class="user-card profile-trigger" data-username="${u.username}" data-url="${href}" style="cursor:pointer">
    <div class="card-photo-wrap">
      ${photo}${ph}
      ${u.isVerified ? `<span class="card-tag verified" title="Verified">✓</span>` : ''}
      ${u.isPremium  ? `<span class="card-tag premium"  title="Premium">👑</span>` : ''}
      ${u.isNew      ? `<span class="card-tag new"      title="New">NEW</span>`    : ''}
    </div>
    <div class="card-body">
      <div class="card-name"><a href="${href}" target="_blank" class="user-link" onclick="event.stopPropagation()">${nameTxt}</a></div>
      ${meta ? `<div class="card-meta">${meta}</div>` : ''}
      ${joinLbl ? `<div class="card-join" style="color:${joinColor(jm)}">Joined ${joinLbl}</div>` : ''}
      <div class="card-spark-row">${spark}</div>
    </div>
  </div>`;
}



/*
  Wire click handlers on profile triggers to open modal.
  Used primarily after dynamically inserting profile cards.
*/
function wireProfileTriggers(container) {
  container.querySelectorAll('.profile-trigger').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const u   = allUsers.find(u=>u.username===el.dataset.username);
      const idx = filteredUsers.findIndex(u=>u.username===el.dataset.username);
      openProfileModal(el.dataset.username, el.dataset.url, u, idx);
    });
  });
}

/*
  Request full profile data from the extension background worker.
  Sends a message asking for profile fetch via background script,
  which opens a tab, scrapes the profile page, and returns the data.
*/
function fetchProfileViaTab(profileUrl) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'fetchProfile', url: profileUrl, username: profileUrl.split('/').pop() }, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.status) return reject(new Error('PROFILE_STATUS:' + res.status)); // deleted | blocked | visibility_blocked
      if (!res || res.error) return reject(new Error(res?.error || 'No response'));
      resolve(res.data);
    });
  });
}

/*
  Render a large status banner into a modal body element.
  icon     — large emoji or symbol
  message  — headline text
  sub      — smaller detail line (optional)
  color    — CSS color for the icon and headline
*/
function renderStatusBanner(bodyEl, icon, message, sub, color) {
  bodyEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;min-height:180px">
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center;padding:24px">
        <div style="font-size:64px;line-height:1">${icon}</div>
        <div style="font-size:22px;font-weight:700;color:${color}">${message}</div>
        ${sub ? `<div id="pfStatusSub" style="font-size:14px;color:var(--muted2)">${sub}</div>` : ''}
      </div>
    </div>`;
}

/*
  Show a big visibility-blocked notice. No auto-advance, no countdown.
*/
function showVisibilityBlockedMessage(modal) {
  renderStatusBanner(
    modal.querySelector('#profileModalBody'),
    '🙈',
    'Profile hidden',
    'This user has made their profile invisible.',
    'var(--muted2)'
  );
}

/*
  Handle a prunable profile state (deleted or blocked):
  shows a big icon + message + live 5-second countdown, removes the user
  from the live list, then auto-advances to the next profile or closes.
*/
function pruneAndAdvance(modal, username, userIndex, icon, headline) {
  const bodyEl = modal.querySelector('#profileModalBody');
  renderStatusBanner(bodyEl, icon, headline, 'Moving to next profile in <strong>5</strong>s…', 'var(--coral)');

  const delIdx = allUsers.findIndex(x => x.username === username);
  if (delIdx !== -1) { allUsers.splice(delIdx, 1); applyAndRender(); }

  let remaining = 4;
  const ticker = setInterval(() => {
    if (!modal.isConnected) { clearInterval(ticker); return; }
    const subEl = modal.querySelector('#pfStatusSub');
    if (remaining <= 0) {
      clearInterval(ticker);
      if (userIndex < filteredUsers.length) {
        const next = filteredUsers[userIndex];
        openProfileModal(next.username, next.profileUrl || '#', next, userIndex, modal);
      } else {
        modal.remove();
      }
      return;
    }
    if (subEl) subEl.innerHTML = `Moving to next profile in <strong>${remaining}</strong>s…`;
    remaining--;
  }, 1000);
}

/*
  =====================================================
  SIZE COMPARISON VISUALIZATION
  =====================================================
  
  Display two silhouette icons scaled relative to height and weight comparison.
  Shows viewer's profile vs the profile being viewed.
*/

/*
  Build an SVG figure icon scaled to given dimensions.
  Renders as a simple torso+head silhouette.
  
  @param {number} w - width in pixels
  @param {number} h - height in pixels
  @param {string} label - text label below icon
  @param {string} color - SVG fill color
  @returns {string} SVG markup
*/
function buildSilhouetteIcon(w, h, color, gender='neutral', metrics=null) {
  /* Human-like pictogram silhouette — female gets an hourglass dress shape,
     male gets broad shoulders and straight torso. All curves are smooth
     Bezier so the figures read as people, not robots. */
  const f = gender === 'female';
  const cx = w / 2;

  /* Head */
  const headR = h * 0.08;
  const headCY = headR + 1;

  /* Neck overlaps head slightly so it looks connected */
  const neckHW = f ? w * 0.05 : w * 0.065;
  const neckTop = headCY + headR * 0.85;
  const shoulderY = neckTop + h * 0.04;
  const shoulderHW = f ? w * 0.23 : w * 0.32;

  /* Arms — gentle quadratic curves hanging from shoulders */
  const armStartY = shoulderY + h * 0.02;
  const armEndY   = f ? h * 0.46 : h * 0.58;
  const armBend   = f ? w * 0.08 : w * 0.085;
  let armStroke  = f ? h * 0.024 : h * 0.048;

  let bodyPath, legs;

  if (f) {
    /* ── Female: waist depends on BMI with +20% adjusted reported weight.
       If adjusted BMI indicates obesity (>=30), remove the waist taper. ── */
    const hCm = Number(metrics?.heightCm || 0);
    const wKg = Number(metrics?.weightKg || 0);
    const hM = hCm > 0 ? hCm / 100 : 0;
    const bmiAdj = (hM > 0 && wKg > 0) ? ((wKg * 1.2) / (hM * hM)) : null;
    /* 0 for BMI<=25, 1 for BMI>=30 (linear transition in between). */
    const obeseBlend = bmiAdj == null ? 0 : Math.min(1, Math.max(0, (bmiAdj - 25) / 5));

    const waistY  = h * 0.36;
    const shoulderHW = w * (0.23 + obeseBlend * 0.01);
    const waistHW = w * (0.13 + obeseBlend * 0.11); /* obese => ~shoulder width (no waist) */
    const hemY    = h * 0.68;
    const hemHW   = w * (0.34 + obeseBlend * 0.05);

    /* Female limb thickness grows with adjusted BMI. */
    armStroke = h * (0.024 + obeseBlend * 0.032);

    bodyPath = `
      M ${cx - neckHW} ${neckTop}
      L ${cx - neckHW} ${shoulderY}
      Q ${cx - shoulderHW} ${shoulderY}, ${cx - shoulderHW} ${shoulderY + h * 0.04}
      C ${cx - shoulderHW} ${waistY - h*0.06}, ${cx - waistHW} ${waistY - h*0.02}, ${cx - waistHW} ${waistY}
      C ${cx - waistHW} ${waistY + h*0.06}, ${cx - hemHW} ${hemY - h*0.06}, ${cx - hemHW} ${hemY}
      L ${cx + hemHW} ${hemY}
      C ${cx + hemHW} ${hemY - h*0.06}, ${cx + waistHW} ${waistY + h*0.06}, ${cx + waistHW} ${waistY}
      C ${cx + waistHW} ${waistY - h*0.02}, ${cx + shoulderHW} ${waistY - h*0.06}, ${cx + shoulderHW} ${shoulderY + h * 0.04}
      Q ${cx + shoulderHW} ${shoulderY}, ${cx + neckHW} ${shoulderY}
      L ${cx + neckHW} ${neckTop}
      Z`;

    const legTopY = hemY - h * 0.03;
    const legBotY = h - 1;
    const legW    = w * (0.09 + obeseBlend * 0.104);
    const legSep  = w * 0.08;
    legs = `
      <rect x="${cx - legSep/2 - legW}" y="${legTopY}" width="${legW}" height="${legBotY - legTopY}" rx="${legW/3}" fill="${color}"/>
      <rect x="${cx + legSep/2}"        y="${legTopY}" width="${legW}" height="${legBotY - legTopY}" rx="${legW/3}" fill="${color}"/>`;

  } else {
    /* ── Male: narrower build than before, still masculine proportions ── */
    const waistY  = h * 0.41;
    const shoulderHW = w * 0.27;
    const waistHW = w * 0.20;
    const hipY    = h * 0.56;
    const hipHW   = w * 0.19;

    bodyPath = `
      M ${cx - neckHW} ${neckTop}
      L ${cx - neckHW} ${shoulderY}
      Q ${cx - shoulderHW} ${shoulderY}, ${cx - shoulderHW} ${shoulderY + h * 0.04}
      C ${cx - shoulderHW} ${waistY - h*0.06}, ${cx - waistHW} ${waistY - h*0.02}, ${cx - waistHW} ${waistY}
      L ${cx - hipHW} ${hipY}
      L ${cx + hipHW} ${hipY}
      L ${cx + waistHW} ${waistY}
      C ${cx + waistHW} ${waistY - h*0.02}, ${cx + shoulderHW} ${waistY - h*0.06}, ${cx + shoulderHW} ${shoulderY + h * 0.04}
      Q ${cx + shoulderHW} ${shoulderY}, ${cx + neckHW} ${shoulderY}
      L ${cx + neckHW} ${neckTop}
      Z`;

    const legTopY = hipY - h * 0.01;
    const legBotY = h - 1;
    const legW    = w * 0.14;
    const legSep  = w * 0.04;
    legs = `
      <rect x="${cx - legSep/2 - legW}" y="${legTopY}" width="${legW}" height="${legBotY - legTopY}" rx="${legW/3}" fill="${color}"/>
      <rect x="${cx + legSep/2}"        y="${legTopY}" width="${legW}" height="${legBotY - legTopY}" rx="${legW/3}" fill="${color}"/>`;
  }

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;flex-shrink:0">
    <circle cx="${cx}" cy="${headCY}" r="${headR}" fill="${color}"/>
    <path d="${bodyPath}" fill="${color}"/>
    <path d="M ${cx - shoulderHW} ${armStartY} Q ${cx - shoulderHW - armBend} ${(armStartY + armEndY) / 2}, ${cx - shoulderHW - armBend * 0.3} ${armEndY}" stroke="${color}" stroke-width="${armStroke}" stroke-linecap="round" fill="none"/>
    <path d="M ${cx + shoulderHW} ${armStartY} Q ${cx + shoulderHW + armBend} ${(armStartY + armEndY) / 2}, ${cx + shoulderHW + armBend * 0.3} ${armEndY}" stroke="${color}" stroke-width="${armStroke}" stroke-linecap="round" fill="none"/>
    ${legs}
  </svg>`;
}

/*
  Render size comparison silhouettes for display near avatar.
  Shows two realistic silhouettes scaled relative to height and weight.
  
  @param {object} entry - profile data with fields
  @param {string} username - profile username
  @returns {string} HTML for silhouette row, or empty string if comparison unavailable
*/
function renderSizeComparison(entry, username) {
  /* Extract height/weight from entry.fields (stored as strings like "149cm / 4 ft 10 in" or "49kg / 108lbs") */
  const fields = entry.fields || {};
  
  /* Extract metric values using regex: match number + cm/kg */
  const heightStr = fields['Height'] || '';
  const weightStr = fields['Weight'] || '';
  
  const heightMatch = heightStr.match(/(\d+(?:\.\d+)?)\s*cm/i);
  const weightMatch = weightStr.match(/(\d+(?:\.\d+)?)\s*kg/i);
  
  const profileHeight = heightMatch ? parseFloat(heightMatch[1]) : null;
  const profileWeight = weightMatch ? parseFloat(weightMatch[1]) : null;
  
  if (!myHeight || !myWeight || !profileHeight || !profileWeight) {
    return ''; /* Skip comparison if either party is missing metrics */
  }
  
  /* Calculate height difference */
  const heightDiff = profileHeight - myHeight;
  const heightDiffText = heightDiff > 0 
    ? `+${Math.round(heightDiff)}cm` 
    : `${Math.round(heightDiff)}cm`;
  
  /* Scale figures primarily by height so visual difference follows actual height delta. */
  const baseSize = 80;
  const baseWidth = Math.round(baseSize * 0.6);
  const heightRatio = profileHeight / myHeight;
  const weightRatio = profileWeight / myWeight;
  const clampedHeightRatio = Math.min(2.0, Math.max(0.55, heightRatio));
  const clampedWeightRatio = Math.min(1.5, Math.max(0.7, weightRatio));
  
  const myFigW = baseWidth;
  const myFigH = baseSize;
  const userFigH = Math.round(baseSize * clampedHeightRatio);
  /* Keep width mostly tied to height, with a smaller weight influence. */
  const userWidthRatio = (clampedHeightRatio * 0.8) + (clampedWeightRatio * 0.2);
  const userFigW = Math.round(baseWidth * userWidthRatio);
  
  return `<div style="display:flex;flex-direction:column;align-items:center;gap:1px;margin:0">
    <div style="font-size:10px;color:var(--muted2);font-weight:500">${heightDiffText}</div>
    <div style="display:flex;gap:0;align-items:flex-end;margin:0;line-height:0">
      ${buildSilhouetteIcon(userFigW, userFigH, 'rgba(255,45,155,0.6)', 'female', { heightCm: profileHeight, weightKg: profileWeight })}
      <div style="margin-left:-14px">${buildSilhouetteIcon(myFigW, myFigH, 'rgba(0,229,255,0.6)', 'male', { heightCm: myHeight, weightKg: myWeight })}</div>
    </div>
  </div>`;
}

// ─── Profile modal ────────────────────────────────────────────────────────────


function applyVisitedBadge(username) {
  const userObj = allUsers.find(x => x.username === username);
  const ts = userObj?.visitedAt;
  if (!ts) return;
  document.querySelectorAll(`.profile-trigger[data-username="${CSS.escape(username)}"]`).forEach(el => {
    const card = el.closest('.user-card');
    if (!card) return;
    let badge = card.querySelector('.visited-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'visited-badge';
      card.querySelector('.card-photo-wrap').appendChild(badge);
    }
    badge.textContent = '🔍 ' + fmtVisited(ts);
  });
}

async function openProfileModal(username, profileUrl, u, userIndex, existingModal) {
  // Mark as visited with timestamp directly on user object
  const visitedTs = Date.now();
  const liveUser = allUsers.find(x => x.username === username);
  if (liveUser) liveUser.visitedAt = visitedTs;
  // Persist: build visited map from allUsers
  const visitedObj = {};
  allUsers.forEach(x => { if (x.visitedAt) visitedObj[x.username] = x.visitedAt; });
  chrome.storage.local.set({ pinalove_visited: visitedObj });
  applyVisitedBadge(username);
  // Also mark table rows
  document.querySelectorAll(`tr[data-username="${CSS.escape(username)}"]`).forEach(tr => tr.classList.add('visited'));
  const badges = [
    u?.isNew      ? `<span class="pf-badge new" title="New">✨</span>`          : '',
    u?.isPremium  ? `<span class="pf-badge premium" title="Premium">👑</span>`  : '',
    u?.isVerified ? `<span class="pf-badge verified" title="Verified">✅</span>` : '',
  ].filter(Boolean).join('');

  // ── If reusing an existing modal, just update its internals ──────────
  if (existingModal) {
    const modal = existingModal;

    // Update identity block
    modal.querySelector('.pf-avatar-wrap').innerHTML = u?.photoUrl
      ? `<img src="${thumbPhotoUrl(u.photoUrl)}" class="pf-avatar">`
      : `<div class="pf-avatar-ph">&#x1F464;</div>`;
    modal.querySelector('.pf-username').innerHTML =
      `<a href="${profileUrl}" target="_blank" class="user-link">${esc(username)}</a>`;
    const visitedLabel = u?.visitedAt ? '🔍 ' + fmtVisited(u.visitedAt) : '';
    modal.querySelector('.pf-usermeta').textContent =
      [u?.age ? u.age+' yr' : '', u?.location, visitedLabel].filter(Boolean).join(' · ');
    // Badges now inline with username
    modal.querySelector('.pf-username').innerHTML =
      `<a href="${profileUrl}" target="_blank" class="user-link">${esc(username)}</a>${badges ? ' '+badges : ''}`;

    // Update nav button states
    modal.querySelector('.pf-prev-btn').disabled = userIndex <= 0;
    modal.querySelector('.pf-next-btn').disabled = userIndex >= filteredUsers.length-1;

    // Re-wire nav buttons
    const prevBtn = modal.querySelector('.pf-prev-btn');
    const nextBtn = modal.querySelector('.pf-next-btn');
    const histBtn = modal.querySelector('.history-modal-btn');
    prevBtn.replaceWith(prevBtn.cloneNode(true));
    nextBtn.replaceWith(nextBtn.cloneNode(true));
    histBtn.replaceWith(histBtn.cloneNode(true));
    modal.querySelector('.pf-prev-btn').addEventListener('click', () => {
      if (userIndex > 0) { const p = filteredUsers[userIndex-1]; openProfileModal(p.username, p.profileUrl||'#', p, userIndex-1, modal); }
    });
    modal.querySelector('.pf-next-btn').addEventListener('click', () => {
      if (userIndex < filteredUsers.length-1) { const n = filteredUsers[userIndex+1]; openProfileModal(n.username, n.profileUrl||'#', n, userIndex+1, modal); }
    });
    modal.querySelector('.history-modal-btn').addEventListener('click', () => { modal.remove(); openHistoryModal(username); });

    // Update bio block (will be filled in after profile fetch)
    const bioEl = modal.querySelector('#pfHeaderBio');
    if (bioEl) bioEl.innerHTML = '<div class="pf-bio-placeholder">Loading…</div>';
    // Update sparkline
    renderUserSparklineInto(username, modal.querySelector('#pfSparkContainer'));

    // Reset body to loading
    modal.querySelector('#profileModalBody').innerHTML = '<div class="pf-body-cols" style="align-items:center;justify-content:center"><div class="profile-loading">Loading profile…</div></div>';

    try {
      const data   = await fetchProfileViaTab(profileUrl);
      const parsed = { ...data, ts: Date.now() };
      if (!parsed.joinMonth && u?.joinMonth) parsed.joinMonth = u.joinMonth;
      await saveProfileSnapshot(username, parsed);
      renderProfileBody(username, parsed, modal.querySelector('#profileModalBody'));
    } catch(err) {
      const status = err.message.startsWith('PROFILE_STATUS:') ? err.message.slice(15) : null;
      if (status === 'deleted' || status === 'blocked') {
        pruneAndAdvance(modal, username, userIndex,
          status === 'deleted' ? '🗑️' : '🚫',
          status === 'deleted' ? 'This account has been deleted.' : 'This account has been blocked.');
      } else if (status === 'visibility_blocked') {
        showVisibilityBlockedMessage(modal);
      } else {
        modal.querySelector('#profileModalBody').innerHTML =
          `<div class="pf-body-cols" style="align-items:center;justify-content:center"><div class="profile-loading" style="color:var(--coral)">Failed to load: ${err.message}</div></div>`;
      }
    }
    return;
  }

  // ── First open: create the modal DOM ─────────────────────────────────
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal profile-modal">
      <div class="pf-header">

        <!-- LEFT 1/5: avatar + identity -->
        <div class="pf-header-identity">
          <div class="pf-avatar-wrap">
            ${u?.photoUrl
              ? `<img src="${thumbPhotoUrl(u.photoUrl)}" class="pf-avatar">`
              : `<div class="pf-avatar-ph">&#x1F464;</div>`}
          </div>
          <div id="pfSizeComparison" class="pf-size-icons-row"></div>
          <div class="pf-identity-text">
            <div class="pf-username"><a href="${profileUrl}" target="_blank" class="user-link">${esc(username)}</a>${badges ? ' '+badges : ''}</div>
            <div class="pf-usermeta">${[u?.age ? u.age+' yr' : '', u?.location].filter(Boolean).join(' \u00b7 ')}</div>
          </div>
        </div>

        <!-- CENTER 1/3: headline + description -->
        <div class="pf-header-bio">
          <div class="pf-header-bio-inner" id="pfHeaderBio">
            <div class="pf-bio-placeholder">Loading…</div>
          </div>
        </div>

        <!-- RIGHT: nav + close + history + sparkline -->
        <div class="pf-header-controls">
          <div class="pf-ctrl-top-row">
            <button class="pf-ctrl-btn-close modal-close" title="Close">&#x2715;</button>
          </div>
          <div class="pf-ctrl-center-row">
            <button class="pf-ctrl-btn history-modal-btn">&#x1F4CA; Monthly Activity</button>
          </div>
          <div class="pf-spark-label">24h activity</div>
          <div id="pfSparkContainer"></div>
        </div>
      </div>

      <div class="profile-body" id="profileModalBody">
        <div class="pf-body-cols" style="align-items:center;justify-content:center"><div class="profile-loading">Loading profile…</div></div>
      </div>
      <div class="pf-nav-btns">
        <button class="pf-ctrl-btn pf-prev-btn" ${userIndex<=0?'disabled':''}>&#x2039; Prev Profile</button>
        <button class="pf-ctrl-btn pf-next-btn" ${userIndex>=filteredUsers.length-1?'disabled':''}>Next Profile &#x203A;</button>
      </div>
    </div>`;

  modal.querySelector('.modal-close').addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    modal.remove();
  });
  modal.addEventListener('click', e=>{ if(e.target===modal) modal.remove(); });
  modal.querySelector('.history-modal-btn').addEventListener('click', ()=>{ modal.remove(); openHistoryModal(username); });

  modal.querySelector('.pf-prev-btn').addEventListener('click', () => {
    if (userIndex > 0) { const p = filteredUsers[userIndex-1]; openProfileModal(p.username, p.profileUrl||'#', p, userIndex-1, modal); }
  });
  modal.querySelector('.pf-next-btn').addEventListener('click', () => {
    if (userIndex < filteredUsers.length-1) { const n = filteredUsers[userIndex+1]; openProfileModal(n.username, n.profileUrl||'#', n, userIndex+1, modal); }
  });

  document.body.appendChild(modal);

  // Render 24h sparkline in header
  renderUserSparklineInto(username, modal.querySelector('#pfSparkContainer'));

  try {
    const data   = await fetchProfileViaTab(profileUrl);
    // Merge joinMonth from browse scan (u.joinMonth) as fallback if profile fetch didn't find one
    const parsed = { ...data, ts: Date.now() };
    if (!parsed.joinMonth && u?.joinMonth) parsed.joinMonth = u.joinMonth;
    await saveProfileSnapshot(username, parsed);
    renderProfileBody(username, parsed, modal.querySelector('#profileModalBody'));
  } catch(err) {
    const status = err.message.startsWith('PROFILE_STATUS:') ? err.message.slice(15) : null;
    if (status === 'deleted' || status === 'blocked') {
      pruneAndAdvance(modal, username, userIndex,
        status === 'deleted' ? '🗑️' : '🚫',
        status === 'deleted' ? 'This account has been deleted.' : 'This account has been blocked.');
    } else if (status === 'visibility_blocked') {
      showVisibilityBlockedMessage(modal);
    } else {
      modal.querySelector('#profileModalBody').innerHTML =
        `<div class="pf-body-cols" style="align-items:center;justify-content:center"><div class="profile-loading" style="color:var(--coral)">Failed to load: ${err.message}</div></div>`;
    }
  }
}

// ─── Profile snapshot save ────────────────────────────────────────────────────

/*
  =====================================================
  PHOTO URL HELPERS
  =====================================================
  
  PinaLove photo URLs follow a pattern:
    https://www.pinalove.com/p/<YYYY-MM>/<Name>/<hash>-<suffix>.<ext>
    
  Suffixes: -browse (for profiles), -big (for lightbox), x1/x2/x3 (size variants)
  We store the canonical base (hash-browse) to avoid duplication.
*/

/* Photo URL prefix used on PinaLove site */
const PHOTO_PREFIX = 'https://www.pinalove.com/p';

/* 
  Strip a photo URL to its canonical base form (hash-browse).
  Used before storing to avoid duplicate entries for different size variants.
*/
function stripPhotoUrl(url) {
  return photoBase(url);
}

/*
  Extract the base path (hash-browse) from any photo URL or stored format.
  Handles:
    - Full URLs with domain prefix
    - Relative paths (/p/...)
    - Size suffixes (-browse, -big, x1, x2, x3)
  Returns canonical form: hash-browse
*/
function photoBase(path) {
  if (!path) return '';
  let s = path;
  /* Remove domain prefix */
  if (s.startsWith(PHOTO_PREFIX + '/')) s = s.slice(PHOTO_PREFIX.length + 1);
  else if (s.startsWith('https://www.pinalove.com/p/')) s = s.slice('https://www.pinalove.com/p/'.length);
  else if (s.startsWith('/p/')) s = s.slice(3);
  /* Remove size suffix: any of -browse, -big, x1, x2, x3, .jpg */
  s = s.replace(/(-browse|-big)?(x3)?(\.jpg)$/, '');
  /* Ensure -browse is present (canonical base ends in -browse) */
  if (!s.endsWith('-browse')) s = s.replace(/-$/, '') + '-browse';
  return s;
}

/* Generate small thumbnail URL (browse x1 in AVIF format) */
function thumbPhotoUrl(path) {
  if (!path) return '';
  return `${PHOTO_PREFIX}/${photoBase(path)}x1.avif`;
}

/* Generate medium photo URL for profile modal (browse x2 in AVIF format) */
function expandPhotoUrl(path) {
  if (!path) return '';
  return `${PHOTO_PREFIX}/${photoBase(path)}x2.avif`;
}

/* Generate full-scale photo URL for lightbox gallery (big JPG format) */
function fullPhotoUrl(path) {
  if (!path) return '';
  const base = photoBase(path).replace(/-browse$/, '');
  return `${PHOTO_PREFIX}/${base}-big.jpg`;
}

/*
  =====================================================
  PROFILE SNAPSHOT & CHANGE TRACKING
  =====================================================
  
  Store complete profile snapshots with field values, photos, and timestamped diffs.
  Tracks changes over time: who changed what and when.
  Photos are kept forever; diffs are capped at 50 to avoid bloat.
*/

/*
  Save/update a profile snapshot in storage, tracking any changes since last snapshot.
  
  Stores:
    - Latest field values (age, gender, location, etc.)
    - Full photo list (never deletes, only adds)
    - Photo stats (views, likes, favorites)
    - Timestamped diffs of field changes
    - Join month (keep earliest known date)
*/
async function saveProfileSnapshot(username, parsed) {
  return new Promise(resolve => {
    chrome.storage.local.get('pinalove_profiles', data => {
      const all = decodeProfilesMap(data.pinalove_profiles || {});

      /* Strip photo URLs to canonical form before storing */
      const incomingPhotos = (parsed.photos || []).map(stripPhotoUrl).filter(Boolean);

      /*
        Bootstrap entry format: migrate old snapshots-array format to new flat structure.
        Old format: { snapshots: [...] }
        New format: { fields: {...}, bio: '', title: '', photos: [...], diffs: [...] }
      */
      if (!all[username] || Array.isArray(all[username].snapshots)) {
        const old = all[username];
        const lastSnap = (old?.snapshots || []).filter(s => !s.photoChange).slice(-1)[0];
        all[username] = {
          fields:     lastSnap?.fields || {},
          bio:        lastSnap?.bio    || '',
          title:      lastSnap?.title  || '',
          photos:     (old?.photos || old?.p || []).map(stripPhotoUrl).filter(Boolean),
          diffs:      [],
          joinMonth:  null,
        };
      }
      const entry = all[username];

      /* Document all field changes (excluding photo changes) */
      const newFields = parsed.fields || {};
      const newBio    = parsed.bio    || '';
      const newTitle  = parsed.title  || '';
      const isFirst   = !entry.fields || Object.keys(entry.fields).length === 0;

      if (!isFirst) {
        const changes = {};
        const allKeys = new Set([...Object.keys(entry.fields), ...Object.keys(newFields)]);
        for (const k of allKeys) {
          const from = entry.fields[k] || '', to = newFields[k] || '';
          if (from !== to) changes[k] = { from, to };
        }
        if ((entry.bio || '') !== newBio) changes['__bio__'] = { from: entry.bio || '', to: newBio };
        if ((entry.title || '') !== newTitle) changes['__title__'] = { from: entry.title || '', to: newTitle };
        if (Object.keys(changes).length > 0) {
          entry.diffs.push({ ts: parsed.ts, changes });
        }
      }

      /* Always update to latest field values */
      entry.fields = newFields;
      entry.bio    = newBio;
      entry.title  = newTitle;

      /* Update joinMonth — keep the earliest known value */
      if (parsed.joinMonth) {
        if (!entry.joinMonth || parsed.joinMonth < entry.joinMonth) {
          entry.joinMonth = parsed.joinMonth;
        }
      }

      /* Track photo additions/removals as separate diffs */
      const prevSet = new Set(entry.photos);
      const currSet = new Set(incomingPhotos);
      const added   = incomingPhotos.filter(p => !prevSet.has(p));
      const removed = [...prevSet].filter(p => !currSet.has(p));

      if (!isFirst && (added.length || removed.length)) {
        entry.diffs.push({ ts: parsed.ts, photos: { added, removed } });
      }

      /* Keep only canonical IDs for the latest fetched photo list.
         Full URLs/stats are fetched on demand when opening the modal. */
      entry.photos = incomingPhotos;

      // Cap diffs only — photos are kept forever
      if (entry.diffs.length > 50) entry.diffs.splice(0, entry.diffs.length - 50);

      const encodedAll = Object.fromEntries(Object.entries(all).map(([u, e]) => [u, encodeProfileEntry(e)]));
      chrome.storage.local.set({ pinalove_profiles: encodedAll }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[Pinkerton] profiles quota:', chrome.runtime.lastError.message);
          // trim diffs only
          for (const u of Object.keys(all)) if (all[u].diffs) all[u].diffs = all[u].diffs.slice(-20);
          const trimmed = Object.fromEntries(Object.entries(all).map(([u, e]) => [u, encodeProfileEntry(e)]));
          chrome.storage.local.set({ pinalove_profiles: trimmed }, () => resolve());
          return;
        }
        profiles = all;
        resolve();
      });
    });
  });
}

// ─── Profile body render ──────────────────────────────────────────────────────

function renderUserSparklineInto(username, container) {
  const slots15 = getDayBuckets96((history[username] || {})[tsToPhDay(Date.now())]);
  const hasData = slots15.some(m => m > 0);
  if (!hasData) { container.innerHTML = '<span style="font-size:9px;color:var(--muted)">no data yet</span>'; return; }

  const interval = 15;
  const primary  = slots15;

  container.innerHTML = buildSparkSVG(primary, [], {
    vw: 220, h: 32, ah: 10, interval,
    color1: 'rgba(0,201,167,0.7)',
    labelEvery: 6,
    tip: (i, v) => {
      const phMin = i * interval;
      const hh = String(Math.floor(phMin/60)).padStart(2,'0');
      const mm = String(phMin%60).padStart(2,'0');
      return `${hh}:${mm} — ${Math.round(v)} min`;
    }
  });
}

function renderProfileBody(username, parsed, container) {
  const entry = profiles[username] || { fields:{}, bio:'', title:'', photos:[], diffs:[] };

  /* Prefer freshly fetched photos for rendering; fall back to stored canonical IDs. */
  const freshPhotoIds = (parsed?.photos || []).map(stripPhotoUrl).filter(Boolean);
  const canonicalPhotos = freshPhotoIds.length ? freshPhotoIds : (entry.photos || []);
  const allPhotos     = canonicalPhotos.map(expandPhotoUrl);
  const allPhotosFull = canonicalPhotos.map(fullPhotoUrl);

  // Index freshly fetched stats by canonical path
  const freshStatsByPath = {};
  if (parsed?.photos && parsed?.photoStats) {
    parsed.photos.forEach((p, i) => {
      const key = stripPhotoUrl(p) || p;
      if (parsed.photoStats[i]) freshStatsByPath[key] = parsed.photoStats[i];
    });
  }
  const allStats = canonicalPhotos.map(p => freshStatsByPath[p] || null);

  const fields  = entry.fields || {};
  // Ordered field rows for the info table
  // Build ordered single-row field table
  const knownKeys = new Set(['Age','Gender','Height','Weight','Min. age','Max. age',
    'Education','City','Country','Looking for','Relationship','Children','Religion']);
  const extraFields = Object.entries(fields).filter(([k]) => !knownKeys.has(k));

  function frow1(label, val) {
    return val ? `<tr><td class="pf-tkey">${esc(label)}</td><td class="pf-tval">${esc(val)}</td></tr>` : '';
  }

  // Age range combined: "25–50" if both present, else individual
  const ageRange = (fields['Min. age'] && fields['Max. age'])
    ? `${fields['Min. age']}–${fields['Max. age']}`
    : (fields['Min. age'] || fields['Max. age'] || '');

  // Join date from earliest photo URL month — prefix with ≤ since photos may predate account
  const joinDisplay = entry.joinMonth
    ? (() => { const [y,m] = entry.joinMonth.split('-'); return `\u2264\u202f${new Date(+y,+m-1).toLocaleDateString('en-US',{month:'short',year:'numeric'})}`; })()
    : '';

  const fieldRows = [
    frow1('Age',          fields['Age'] || ''),
    frow1('Gender',       fields['Gender'] || ''),
    frow1('Height',       fields['Height'] || ''),
    frow1('Weight',       fields['Weight'] || ''),
    frow1('Age range',    ageRange),
    frow1('Education',    fields['Education'] || ''),
    frow1('City',         fields['City'] || ''),
    frow1('Country',      fields['Country'] || ''),
    frow1('Joined',       joinDisplay),
    frow1('Looking for',  fields['Looking for'] || ''),
    frow1('Relationship', fields['Relationship'] || ''),
    frow1('Children',     fields['Children'] || ''),
    frow1('Religion',     fields['Religion'] || ''),
    ...extraFields.map(([k,v]) => frow1(k, v)),
  ].filter(Boolean).join('');

  // Change log
  const diffs = entry.diffs || [];
  let changelogHtml = '';
  if (!diffs.length) {
    changelogHtml = `<div class="clog-no-history">First snapshot — no changes yet</div>`;
  } else {
    changelogHtml = [...diffs].reverse().map(d => {
      const tsStr = new Date(d.ts).toLocaleDateString('en-PH', {timeZone:'Asia/Manila'}) + ' ' +
                    new Date(d.ts).toLocaleTimeString('en-PH', {timeZone:'Asia/Manila', hour:'2-digit', minute:'2-digit'});
      if (d.photos) {
        const addedThumbs   = (d.photos.added   || []).map(p => `<img src="${thumbPhotoUrl(p)}" style="width:44px;height:49px;object-fit:cover;border-radius:3px" onerror="this.style.display='none'">`).join('');
        const removedThumbs = (d.photos.removed || []).map(p => `<img src="${thumbPhotoUrl(p)}" style="width:44px;height:49px;object-fit:cover;border-radius:3px;opacity:.4" onerror="this.style.display='none'">`).join('');
        return `<div class="clog-entry">
          <div class="clog-ts">📷 ${tsStr}</div>
          ${d.photos.added?.length   ? `<div class="clog-photo-line added">+${d.photos.added.length} added<div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:3px">${addedThumbs}</div></div>` : ''}
          ${d.photos.removed?.length ? `<div class="clog-photo-line removed">−${d.photos.removed.length} removed<div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:3px">${removedThumbs}</div></div>` : ''}
        </div>`;
      }
      const rows = Object.entries(d.changes || {}).map(([k, {from, to}]) => {
        const label = k === '__bio__' ? 'bio' : k === '__title__' ? 'title' : k;
        return `<div class="clog-row"><span class="clog-key">${esc(label)}:</span><span class="clog-old">${esc(from||'—')}</span> → <span class="clog-new-val">${esc(to||'—')}</span></div>`;
      }).join('');
      return `<div class="clog-entry">
        <div class="clog-ts">${tsStr}</div>
        <div class="clog-diff">${rows}</div>
      </div>`;
    }).join('');
  }

  const photoGrid = allPhotos.length
    ? `<div class="pf-photo-grid">${allPhotos.map((url, i) => {
        const s = allStats[i];
        const statsHtml = s
          ? `<div class="photo-stats-overlay">
               ${s.views ? `<span class="pso pso-views" title="Views">👁 ${s.views}</span>` : ''}
               ${s.likes ? `<span class="pso pso-likes" title="Likes">♥ ${s.likes}</span>` : ''}
               ${s.favs  ? `<span class="pso pso-favs"  title="Favourited">★ ${s.favs}</span>`  : ''}
             </div>` : '';
        return `<div class="photo-thumb-wrap" data-idx="${i}">
          <img src="${url}" class="gallery-thumb-lg" data-idx="${i}" loading="lazy" onerror="this.parentElement&&(this.style.display='none')">
          ${statsHtml}
        </div>`;
      }).join('')}</div>`
    : '<div class="pf-no-photos">No photos yet</div>';

  // Populate headline+bio in the header bio block
  const bioEl = container.closest('.modal')?.querySelector('#pfHeaderBio');
  if (bioEl) {
    bioEl.innerHTML = (entry.title || entry.bio)
      ? `${entry.title ? `<div class="pf-hdr-headline">${esc(entry.title)}</div>` : ''}
         ${entry.bio   ? `<div class="pf-hdr-bio">${esc(entry.bio)}</div>` : ''}`
      : '<div class="pf-bio-placeholder" style="color:var(--muted)">No description</div>';
  }

  // Populate size comparison if user profile metrics are available
  const sizeCompEl = container.closest('.modal')?.querySelector('#pfSizeComparison');
  if (sizeCompEl) {
    sizeCompEl.innerHTML = renderSizeComparison(entry, username) || '';
  }

  container.innerHTML = `
    <div class="pf-body-cols">

      <!-- LEFT 1/5: fields + diff log -->
      <div class="pf-col-left">
        ${fieldRows   ? `<table class="pf-field-table">${fieldRows}</table>` : ''}
        <div class="pf-section-head">Change log <span class="pf-count">${diffs.length}</span></div>
        <div class="pf-changelog">${changelogHtml}</div>
      </div>

      <!-- RIGHT 4/5: photos -->
      <div class="pf-col-right">
        ${photoGrid}
      </div>

    </div>`;

  container.querySelectorAll('.photo-thumb-wrap').forEach(wrap => {
    wrap.addEventListener('click', () => openLightbox(allPhotosFull, allStats, parseInt(wrap.dataset.idx)));
  });
}

/*
  =====================================================
  LIGHTBOX GALLERY VIEWER
  =====================================================
  
  Full-screen modal for browsing profile photos with photo stats overlay (views/likes/favs).
  Uses arrow keys and mouse buttons for navigation; ESC to close.
  Supports both 3-arg (photos, stats, startIdx) and legacy 2-arg (photos, startIdx) signatures.
*/

/*
  Open a full-screen lightbox gallery viewer for browsing an array of photos.
  
  Parameters:
    photos   : string[] — array of full-size photo URLs (usually from fullPhotoUrl())
    stats    : object[] — optional photo stats array [{views, likes, favs}, ...] or number (legacy startIdx)
    startIdx : number — which photo to display first (defaults to 0)
    
  Supports:
    - Keyboard navigation: Arrow Left/Right, Escape to close
    - Mouse: Next/Prev buttons, close button, or click overlay
    - Stats overlay: Shows views, likes, favorites for each photo if provided
    - Circular navigation: Wraps around at start/end
    
  Returns: nothing (appends overlay div to document.body)
*/
function openLightbox(photos, stats, startIdx) {
  /* Support legacy call signature openLightbox(photos, startIdx) */
  if (typeof stats === 'number') { startIdx = stats; stats = []; }
  stats = stats || [];
  let idx = startIdx;

  /*
    Build the stats overlay HTML for a given photo index (views/likes/favorites).
    Returns empty string if no stats available for that index.
  */
  function statsHtml(i) {
    const s = stats[i];
    if (!s) return '';
    const parts = [];
    if (s.views) parts.push(`<span class="lb-stat">👁 ${s.views}</span>`);
    if (s.likes) parts.push(`<span class="lb-stat">♥ ${s.likes}</span>`);
    if (s.favs)  parts.push(`<span class="lb-stat">★ ${s.favs}</span>`);
    return parts.length ? `<div class="lb-stats-row">${parts.join('')}</div>` : '';
  }

  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.innerHTML = `
    <div class="lb-close-row">
      <button class="lb-close">✕ Close</button>
    </div>
    <div class="lb-body">
      <button class="lb-nav lb-prev" ${photos.length<=1?'disabled':''}>‹</button>
      <div class="lb-img-area">
        <img class="lb-img" src="${photos[idx]}">
      </div>
      <button class="lb-nav lb-next" ${photos.length<=1?'disabled':''}>›</button>
    </div>
    <div class="lb-bottom-row">
      <span class="lb-counter">${idx+1} / ${photos.length}</span>
      <div class="lb-stats-wrap">${statsHtml(idx)}</div>
    </div>`;

  const img      = overlay.querySelector('.lb-img');
  const counter  = overlay.querySelector('.lb-counter');
  const statsWrap = overlay.querySelector('.lb-stats-wrap');

  function show(i) {
    idx = (i + photos.length) % photos.length;
    img.style.opacity = '0';
    img.src = photos[idx];
    img.onload = () => { img.style.opacity = '1'; };
    counter.textContent = `${idx+1} / ${photos.length}`;
    statsWrap.innerHTML = statsHtml(idx);
  }

  overlay.querySelector('.lb-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.lb-prev').addEventListener('click', e => { e.stopPropagation(); show(idx-1); });
  overlay.querySelector('.lb-next').addEventListener('click', e => { e.stopPropagation(); show(idx+1); });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  function onKey(e) {
    if (e.key==='ArrowLeft')  show(idx-1);
    if (e.key==='ArrowRight') show(idx+1);
    if (e.key==='Escape')     { overlay.remove(); document.removeEventListener('keydown',onKey); }
  }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('remove', () => document.removeEventListener('keydown', onKey));

  document.body.appendChild(overlay);
}

// ─── History modal (per-user) ─────────────────────────────────────────────────

function openHistoryModal(username) {
  const days  = getDailyMinutesPH(username);
  const total = days.reduce((s,d)=>s+d.minutes,0);
  const u     = allUsers.find(u=>u.username===username)||{};
  const userHist = history[username] || {};
  const todayStr = tsToPhDay(Date.now());
  let selectedDay = todayStr;

  // ── Daily detail sparkline (interval-aware) ───────────────────────────
  function buildDailyDetail(dateStr) {
    const buckets = getDayBuckets96(userHist[dateStr]);
    const hasData = buckets.some(m => m > 0);

    if (!hasData) return '<div style="color:var(--muted);font-size:11px;padding:8px 0">No data for this day</div>';

    const interval = 15;
    const numBars  = 96;
    const barBuckets = buckets;

    const maxVal = Math.max(...barBuckets, 1);
    const VW = 560; const H = 60; const AH = 18;
    const bw = Math.max(1, Math.round(VW / numBars) - (VW / numBars > 2 ? 1 : 0));

    const bars = barBuckets.map((v, i) => {
      const bH = Math.max(v>0?2:0, Math.round((v/maxVal)*H));
      const x  = Math.round((i/numBars)*VW);
      return `<rect x="${x}" y="${H-bH}" width="${bw}" height="${bH}" rx="1" fill="rgba(0,201,167,0.7)" opacity="${v>0?1:0.1}"/>`;
    }).join('');

    const axisMarks = [];
    for (let m = 0; m <= 1440; m += 30) {
      const h = m / 60;
      const isHour = m % 60 === 0;
      const x = Math.round((m / 1440) * VW);
      const tickH = isHour ? 5 : 3;
      const labeled = isHour && h % 3 === 0;
      const anchor = h === 0 ? 'start' : h === 24 ? 'end' : 'middle';
      axisMarks.push(`<g transform="translate(${x},0)">
        <line x1="0" y1="0" x2="0" y2="${tickH}" stroke="#4a4a6a" stroke-width="1"/>
        ${labeled ? `<text x="0" y="14" text-anchor="${anchor}" font-size="10" font-family="DM Mono,monospace" fill="#7a7a9a">${h}</text>` : ''}
      </g>`);
    }

    return `<svg width="100%" viewBox="0 0 ${VW} ${H+AH+2}" preserveAspectRatio="xMidYMid meet" style="display:block;overflow:visible">
      <line x1="0" y1="${H}" x2="${VW}" y2="${H}" stroke="#252538" stroke-width="1"/>
      ${bars}
      <g transform="translate(0,${H})">${axisMarks.join('')}</g>
    </svg>`;
  }

  // ── 30-day bar chart — one bar per day, date labels below ────────────
  const VW30 = 560; const H30 = 56; const BAR_AH = 22;
  const maxDay = Math.max(...days.map(d=>d.minutes), 1);
  const totalBars = days.length; // 30
  const bw30 = Math.max(2, Math.floor(VW30 / totalBars) - 2);

  function buildDayBars(selDate) {
    return days.map((d, i) => {
      const bH   = Math.max(d.minutes>0 ? 2 : 0, Math.round((d.minutes/maxDay)*H30));
      const x    = Math.round((i / totalBars) * VW30);
      const fill = d.date === selDate ? 'rgba(255,45,155,0.9)' : 'rgba(0,201,167,0.7)';
      // Date label: show day number, rotate -45deg for readability
      const label = d.date.slice(8); // "01"–"31"
      const isFirst = i === 0 || d.date.slice(5,7) !== days[i-1]?.date.slice(5,7);
      const labelStr = isFirst ? d.date.slice(5) : label; // "MM-DD" on month boundary, else "DD"
      return `<g class="day-bar-g" data-date="${d.date}" data-idx="${i}" style="cursor:pointer">
        <rect class="day-rect" x="${x}" y="${H30-bH}" width="${bw30}" height="${bH}" rx="1"
          fill="${fill}" opacity="${d.minutes>0?1:0.15}">
          <title>${d.date}: ${fmtMinutes(d.minutes)}</title>
        </rect>
        <rect x="${x}" y="0" width="${Math.max(bw30,8)}" height="${H30}" fill="transparent"/>
        <g transform="translate(${x+bw30/2},${H30+4})">
          <text transform="rotate(-45)" text-anchor="end" font-size="7" font-family="DM Mono,monospace"
            fill="${d.date === selDate ? 'rgba(255,45,155,0.9)' : '#4a4a6a'}">${labelStr}</text>
        </g>
      </g>`;
    }).join('');
  }

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal act-modal">
      <button class="modal-close">&#x2715;</button>
      <div class="modal-header">
        <div class="modal-user">
          ${u.photoUrl?`<img src="${thumbPhotoUrl(u.photoUrl)}" class="modal-photo">`:'<div class="modal-photo-ph">&#x1F464;</div>'}
          <div>
            <div class="modal-name"><a href="${u.profileUrl||'#'}" target="_blank" class="user-link">${esc(username)}</a></div>
            <div class="modal-meta">${[u.age,u.location].filter(Boolean).join(' · ')} · ${fmtMinutes(total)} in 30d</div>
          </div>
        </div>
      </div>

      <!-- TOP: daily detail -->
      <div class="modal-section">
        <div class="modal-section-title" id="actDailyTitle">Detail: ${todayStr} (PH time)</div>
        <div id="actDailyPlot"></div>
      </div>

      <!-- BOTTOM: 30-day overview -->
      <div class="modal-section">
        <div class="modal-section-title">30-day overview &mdash; click to inspect</div>
        <svg id="actDaysSvg" width="100%"
          viewBox="0 0 ${VW30} ${H30+BAR_AH}"
          style="overflow:visible;display:block;cursor:pointer">
          ${buildDayBars(todayStr)}
        </svg>
      </div>
    </div>`;

  modal.querySelector('.modal-close').addEventListener('click', ()=>modal.remove());
  modal.addEventListener('click', e=>{ if(e.target===modal) modal.remove(); });

  function selectDay(dateStr) {
    selectedDay = dateStr;
    // Recolor bars
    modal.querySelectorAll('.day-rect').forEach(r => {
      const d = r.parentElement.dataset.date;
      r.setAttribute('fill', d === dateStr ? 'rgba(255,45,155,0.9)' : 'rgba(0,201,167,0.7)');
    });
    // Recolor labels
    modal.querySelectorAll('.day-bar-g text').forEach(t => {
      const d = t.closest('.day-bar-g').dataset.date;
      t.setAttribute('fill', d === dateStr ? 'rgba(255,45,155,0.9)' : '#4a4a6a');
    });
    modal.querySelector('#actDailyTitle').textContent = `Detail: ${dateStr} (PH time)`;
    modal.querySelector('#actDailyPlot').innerHTML = buildDailyDetail(dateStr);
  }

  modal.querySelector('#actDaysSvg').addEventListener('click', e => {
    const g = e.target.closest('.day-bar-g');
    if (g) selectDay(g.dataset.date);
  });

  document.body.appendChild(modal);
  selectDay(todayStr);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function syncFilterUI() {
  ['new','premium','verified'].forEach(key => {
    const el = document.querySelector(`[data-filter="${key}"]`);
    if (el) el.classList.toggle('active', !!typeFilters[key]);
  });
  if (ageMin) $('ageMin').value = ageMin;
  if (ageMax) $('ageMax').value = ageMax;
  $('sortSelect').value = sortKey;
}

/* Escape HTML special characters to prevent XSS injection */
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/*
  =====================================================
  EVENT BINDING & UI INTERACTIVITY
  =====================================================
  
  Attach all event listeners to filter controls, view toggles, and storage watchers.
  Responds to user interactions: filtering, sorting, searching, and view mode changes.
*/

/*
  Bind all UI event handlers for the dashboard.
  Sets up listeners for:
    - Type filter pills (new/premium/verified toggles)
    - Age range sliders
    - Location dropdown + radius slider
    - Sort select
    - Search box
    - View mode buttons (grid/table toggle)
    - Reset filters button
    - Header sparkline click (shows 30-day modal)
    - Storage change listener (syncs when background scan completes)
*/
function bindEvents() {
  /* Type filter pills: toggle flags when clicked, re-render immediately */
  document.querySelectorAll('[data-filter]').forEach(pill => {
    pill.addEventListener('click', () => {
      const key = pill.dataset.filter; if (!(key in typeFilters)) return;
      typeFilters[key] = !typeFilters[key]; pill.classList.toggle('active', typeFilters[key]);
      saveFilters(); applyAndRender();
    });
  });

  /* Age range inputs: update filter when values change */
  ['ageMin','ageMax'].forEach(id => {
    $(id).addEventListener('change', () => {
      ageMin = parseInt($('ageMin').value,10)||null;
      ageMax = parseInt($('ageMax').value,10)||null;
      saveFilters(); applyAndRender();
    });
  });

  /* Location dropdown: update selected city and show/hide radius slider accordingly */
  $('locationSelect').addEventListener('change', e => {
    locationFilter = e.target.value;
    const row = $('radiusRow');
    if (locationFilter) {
      row.style.display = '';
    } else {
      row.style.display = 'none';
      radiusKm = 0;
      const sl = $('radiusSlider'); if (sl) sl.value = 0;
      $('radiusLabel') && ($('radiusLabel').textContent = 'exact');
    }
    updateSelectedCityCoords();
  });

  /* Radius slider: update distance threshold and re-filter */
  $('radiusSlider').addEventListener('input', e => {
    radiusKm = parseInt(e.target.value, 10);
    $('radiusLabel').textContent = radiusKm === 0 ? 'exact' : `${radiusKm} km`;
    updateSelectedCityCoords();
  });

  /* Sort dropdown: change sort order and re-render */
  $('sortSelect').addEventListener('change', e => { 
    sortKey=e.target.value; 
    saveFilters(); 
    applyAndRender(); 
  });

  /* Search input: live filter by username as user types */
  $('searchInput').addEventListener('input', e => {
    searchQuery = e.target.value.trim();
    $('searchClear').style.display = searchQuery ? 'block' : 'none';
    applyAndRender();
  });

  /* Clear search button: reset search and focus input */
  $('searchClear').addEventListener('click', () => {
    $('searchInput').value = '';
    searchQuery = '';
    $('searchClear').style.display = 'none';
    applyAndRender();
    $('searchInput').focus();
  });

  /* Grid/Table view mode toggle */
  $('gridViewBtn').addEventListener('click', () => { 
    viewMode='grid'; 
    $('gridViewBtn').classList.add('active'); 
    $('tableViewBtn').classList.remove('active'); 
    render(); 
  });
  $('tableViewBtn').addEventListener('click', () => { 
    viewMode='table'; 
    $('tableViewBtn').classList.add('active'); 
    $('gridViewBtn').classList.remove('active'); 
    render(); 
  });

  /* Reset all filters to defaults */
  $('resetFilters').addEventListener('click', () => {
    typeFilters={new:false,premium:false,verified:false}; 
    ageMin=null; ageMax=null;
    locationFilter=''; 
    searchQuery=''; 
    radiusKm=0; 
    selectedCityCoords=null;
    const row = $('radiusRow'); if (row) { row.style.display='none'; }
    const slider = $('radiusSlider'); if (slider) { slider.value=0; }
    $('radiusLabel') && ($('radiusLabel').textContent='exact');
    $('ageMin').value=''; 
    $('ageMax').value=''; 
    $('searchInput').value='';
    $('sortSelect').value='last_seen_desc'; 
    $('locationSelect').value='';
    sortKey='last_seen_desc'; 
    syncFilterUI(); 
    saveFilters(); 
    applyAndRender();
  });

  /* Refresh button: re-load all data from storage */
  $('refreshBtn').addEventListener('click', loadData);

  /* Header sparkline click: open 30-day activity modal */
  $('headerSparkWrap').addEventListener('click', openTotalsActivityModal);

  /*
    Listen for storage changes from background script (via chrome.storage.local.set).
    When scan completes, updates are written to storage and we react here.
    Rebuilds user list if members/records changed, or just re-renders if only history/settings changed.
  */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let needRebuild = false;

    if (changes.pinalove_history)  { history  = changes.pinalove_history.newValue  || {}; needRebuild = true; renderHistoryDebugBadge(); }
    if (changes.pinalove_profiles) { profiles = decodeProfilesMap(changes.pinalove_profiles.newValue || {}); }
    if (changes.pinalove_settings) {
      const s = changes.pinalove_settings.newValue;
      if (s?.scanInterval) { scanInterval = s.scanInterval; renderHeaderSparkline(); }
    }
    if (changes.pinalove_totals) {
      totals = changes.pinalove_totals.newValue || [];
      renderHeaderSparkline();
    }

    /* pinalove_members is the primary data source — rebuild when it changes. */
    if (changes.pinalove_members || changes.pinalove_member_locations || changes.pinalove_visited) {
      chrome.storage.local.get(['pinalove_members', 'pinalove_member_locations', 'pinalove_visited'], d => {
        buildAllUsers(d.pinalove_members || {}, d.pinalove_member_locations || [], d.pinalove_visited || {});
        populateLocations();
        applyAndRender();
        renderHeaderSparkline();
      });
    } else if (needRebuild) {
      applyAndRender();
      renderHeaderSparkline();
    }
  });
}
