/**
 * popup.js — Pinkerton v3.0
 *
 * Controls the extension popup UI (popup.html).
 * The popup is a short-lived page — it is destroyed and recreated each time
 * the user opens or closes it. All persistent state lives in chrome.storage.local.
 *
 * Responsibilities:
 *   - Load and display the latest scan stats (online count, new, premium, verified)
 *   - Render a today-in-PH sparkline from the pinalove_totals array
 *   - Show the scan log (last 40 entries)
 *   - Display storage usage bar
 *   - Wire up scan controls (manual scan, auto-scan toggle, rate buttons)
 *   - Listen to storage changes for live updates while popup is open
 */

/* ─── Shorthand ──────────────────────────────────────────────────────────────── */

const $ = id => document.getElementById(id);

/* ─── State ──────────────────────────────────────────────────────────────────── */

/* PH is UTC+8 — used when bucketing totals into "today in Manila". */
const PH_OFFSET_MS = 8 * 3600 * 1000;

/* All-time members database — populated by loadAll(). Used for New/Premium/Verified totals. */
let members  = {};

/* Array of { ts, count, newCount } — one entry per completed scan. */
let totals   = [];

/* Auto-scan enabled flag — mirrors pinalove_settings.autoScanEnabled in storage. */
let autoEnabled = false;

/* Scan interval in minutes — mirrors pinalove_settings.scanInterval. */
let scanInterval = 5;

/* Scan filter params — mirrors pinalove_settings.scanGender/scanAgeMin/scanAgeMax. */
let scanGender = 'f';
let scanAgeMin = 18;
let scanAgeMax = 99;

/* User's own height (cm) and weight (kg) — used for size comparisons in profiles. */
let myHeight = null;
let myWeight = null;

/* setInterval handle for the countdown timer displayed when auto-scan is on. */
let countdownInterval = null;

function decodeMembersMap(rawMembers = {}, memberLocations = []) {
  const out = {};
  for (const [username, raw] of Object.entries(rawMembers || {})) {
    const e = raw && typeof raw === 'object' ? raw : {};
    const isCompact = ('sc' in e) || ('ls' in e) || ('f' in e) || ('l' in e);
    if (!isCompact) {
      out[username] = {
        isNew: !!e.isNew,
        isPremium: !!e.isPremium,
        isVerified: !!e.isVerified,
      };
      continue;
    }
    const flags = Number(e.f || 0);
    out[username] = {
      isNew: !!(flags & 1),
      isPremium: !!(flags & 2),
      isVerified: !!(flags & 4),
    };
  }
  return out;
}

/*
 * Watchdog timer handle.
 *
 * When a scan is in progress we expect progress updates every few seconds
 * (one per page fetch). If no update arrives within WATCHDOG_MS milliseconds
 * we assume the service worker crashed, the fetch timed out, or something else
 * went silently wrong — and we reset the UI back to idle so the user isn't
 * left staring at a frozen "Scanning…" message forever.
 *
 * The watchdog is armed by setScanningState(true) and disarmed by
 * setScanningState(false) or any progress / done / error event.
 */
let watchdogTimer    = null;
const WATCHDOG_MS    = 30000; /* 30 seconds without a progress update = frozen */

/* ─── Boot ───────────────────────────────────────────────────────────────────── */

/* IIFE so we can use await at top level without polluting the global scope. */
(async () => {

  /* Ensure at least one PinaLove tab is open, because the background script
     needs an active session (cookies) to make authenticated requests.
     If no tab exists, silently open one. */
  chrome.tabs.query({ url: ['*://pinalove.com/*', '*://www.pinalove.com/*'] }, tabs => {
    if (!tabs.length) chrome.tabs.create({ url: 'https://www.pinalove.com/browse.php' });
  });

  await loadAll();
  updateRateUI();
  renderDashboard();

  /* Query the background for the current alarm state.
     We use the alarm's .scheduledTime to drive the countdown display.
     Only update scanInterval from the alarm response if we didn't already
     load a value from storage — prevents the service worker's in-memory
     default (5) from overwriting a user-configured value on popup open. */
  chrome.runtime.sendMessage({ action: 'getAlarmStatus' }, res => {
    if (res && res.alarm) {
      showCountdown(res.alarm);
    }
    if (res?.intervalMinutes && !scanInterval) {
      scanInterval = res.intervalMinutes;
      updateRateUI();
    }
  });

  /*
   * Restore scanning state if a scan was already running when the popup opened
   * (e.g. user opened popup mid-auto-scan). We check the last 60 seconds —
   * a multi-page scan can legitimately take longer than 10s, so 10s was too
   * tight and caused the progress bar to silently not appear for live scans.
   *
   * The watchdog inside setScanningState(true) ensures that if the scan
   * actually is frozen, the UI will self-correct within WATCHDOG_MS anyway.
   */
  chrome.storage.local.get('pinalove_scan_progress', data => {
    const prog = data.pinalove_scan_progress;
    if (prog && prog.ts && prog.ts > Date.now() - 60000 && prog.type === 'progress') {
      setScanningState(true);
      updateProgress(prog);
    }
  });

  bindEvents();
})();

/* ─── Storage ────────────────────────────────────────────────────────────────── */

/**
 * Load all popup-relevant data from storage in a single read.
 *
 * Populates: members, totals, scanInterval, scanGender, scanAgeMin, scanAgeMax, autoEnabled.
 *
 * @returns {Promise<void>}
 */
function loadAll() {
  return new Promise(resolve => {
    chrome.storage.local.get(
      ['pinalove_members', 'pinalove_member_locations', 'pinalove_totals', 'pinalove_settings'],
      data => {
        members = decodeMembersMap(data.pinalove_members || {}, data.pinalove_member_locations || []);
        totals  = data.pinalove_totals  || [];

        /* Apply saved settings — only override defaults if a value was actually stored. */
        if (data.pinalove_settings?.scanInterval) scanInterval = data.pinalove_settings.scanInterval;
        if (data.pinalove_settings?.scanGender)   scanGender   = data.pinalove_settings.scanGender;
        if (data.pinalove_settings?.scanAgeMin)   scanAgeMin   = data.pinalove_settings.scanAgeMin;
        if (data.pinalove_settings?.scanAgeMax)   scanAgeMax   = data.pinalove_settings.scanAgeMax;
        if (data.pinalove_settings?.myHeight)     myHeight     = data.pinalove_settings.myHeight;
        if (data.pinalove_settings?.myWeight)     myWeight     = data.pinalove_settings.myWeight;
        autoEnabled = !!data.pinalove_settings?.autoScanEnabled;

        resolve();
      }
    );
  });
}

/* ─── Dashboard ──────────────────────────────────────────────────────────────── */

/**
 * Re-render all dashboard sections.
 * Called once on load and after any data change.
 */
function renderDashboard() {
  renderStats();
  renderSparkline();
  renderLog();
  renderStorage();
}

/**
 * Update the four headline stat numbers (online, new, premium, verified).
 * Displays '—' if no scan data is available yet.
 */
function renderStats() {
  /* Online = count from the latest successful scan entry in pinalove_totals. */
  const latestOk = [...totals].reverse().find(t => t && t.count !== null && t.count !== undefined);
  $('d-online').textContent = latestOk ? latestOk.count : '—';

  /* New/Premium/Verified = totals across all members ever seen (not just this scan).
     These reflect the full accumulated database, not just who is online right now. */
  const memberList = Object.values(members);
  const hasMembers = memberList.length > 0;
  $('d-new').textContent      = hasMembers ? memberList.filter(u => u.isNew).length      : '—';
  $('d-premium').textContent  = hasMembers ? memberList.filter(u => u.isPremium).length  : '—';
  $('d-verified').textContent = hasMembers ? memberList.filter(u => u.isVerified).length : '—';
}

/* ─── Shared sparkline SVG builder ──────────────────────────────────────────── */

/**
 * Build an SVG bar-chart sparkline suitable for embedding inline.
 *
 * The chart has two series: a primary (teal) and an optional secondary (magenta)
 * overlay, both scaled to the same max value. A labelled time axis is drawn below.
 *
 * @param {number[]} primary   - Main data series (one value per time slot).
 * @param {number[]} secondary - Optional overlay series, same length as primary.
 * @param {object}   opts      - Rendering options:
 *   @param {number}   opts.vw         - ViewBox width (default 340).
 *   @param {number}   opts.h          - Chart area height in px (default 56).
 *   @param {number}   opts.ah         - Axis area height in px (default 18).
 *   @param {number}   opts.interval   - Minutes per slot (default 5); drives axis labels.
 *   @param {string}   opts.color1     - Primary bar fill colour.
 *   @param {string}   opts.color2     - Secondary bar fill colour.
 *   @param {number}   opts.labelEvery - Label every N hours on the axis (default 3).
 *   @param {Function} opts.tip        - fn(i, v1, v2) -> tooltip string for slot i.
 * @returns {string} SVG markup string.
 */
function buildSparkSVG(primary, secondary = [], opts = {}) {
  const VW         = opts.vw         ?? 340;
  const H          = opts.h          ?? 56;
  const AH         = opts.ah         ?? 18;
  const interval   = opts.interval   ?? 5;
  const col1       = opts.color1     ?? 'rgba(0,201,167,0.65)';
  const col2       = opts.color2     ?? 'rgba(255,45,155,0.85)';
  const bgSeries   = opts.bgSeries   ?? [];
  const bgSecondary = opts.bgSecondary ?? [];
  const bgColor    = opts.bgColor    ?? 'rgba(140,150,170,0.35)';
  const bgColor2   = opts.bgColor2   ?? 'rgba(170,170,180,0.42)';
  const labelEvery = opts.labelEvery ?? 3;
  const numBars    = primary.length;
  const max        = Math.max(...primary, ...secondary, ...bgSeries, ...bgSecondary, 1); // avoid division by zero
  /* Bar width: fill available space evenly, with a 1px gap if bars are wide enough. */
  const barW       = Math.max(1, Math.round(VW / numBars) - (VW / numBars > 2 ? 1 : 0));

  /* Build one <g> per time slot containing a primary rect and optional secondary rect. */
  const bars = primary.map((v, i) => {
    const vb  = bgSeries[i] || 0;
    const bgH = vb > 0 ? Math.max(1, Math.round((vb / max) * H)) : 0;
    const vb2 = bgSecondary[i] || 0;
    const bgH2 = vb2 > 0 ? Math.max(1, Math.round((vb2 / max) * H)) : 0;
    const bH  = Math.max(v > 0 ? 2 : 0, Math.round((v / max) * H)); // min 2px if non-zero
    const v2  = secondary[i] || 0;
    const nH  = v2 > 0 ? Math.max(1, Math.round((v2 / max) * H)) : 0;
    const x   = Math.round((i / numBars) * VW);

    /* Default tooltip: HH:MM in PH time. Caller can override with opts.tip. */
    const tip = opts.tip ? opts.tip(i, v, v2) : (() => {
      const phMin = i * interval;
      const hh = String(Math.floor(phMin / 60)).padStart(2, '0');
      const mm = String(phMin % 60).padStart(2, '0');
      return `${hh}:${mm}`;
    })();

    return `<g>
      ${bgH ? `<rect x="${x}" y="${H-bgH}" width="${barW}" height="${bgH}" rx="1" fill="${bgColor}"><title>${tip}</title></rect>` : ''}
      ${bgH2 ? `<rect x="${x}" y="${H-bgH2}" width="${barW}" height="${bgH2}" rx="1" fill="${bgColor2}"><title>${tip}</title></rect>` : ''}
      <rect x="${x}" y="${H-bH}" width="${barW}" height="${bH}" rx="1"
        fill="${col1}" opacity="${v > 0 ? 1 : 0.1}"><title>${tip}</title></rect>
      ${nH ? `<rect x="${x}" y="${H-nH}" width="${barW}" height="${nH}" rx="1" fill="${col2}"><title>${tip}</title></rect>` : ''}
    </g>`;
  }).join('');

  /* Build tick marks and hour labels along the time axis.
     Ticks every 30 min; labels every labelEvery hours. */
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

/**
 * Render the today-in-PH activity sparkline into #sparkContainer.
 *
 * Reads from pinalove_totals and buckets each scan entry into a time slot
 * based on its timestamp offset from the start of today (PH midnight).
 * Primary series = total online count; secondary = new-member count.
 */
function renderSparkline() {
  const container = $('sparkContainer');
  const interval  = scanInterval || 5;
  const numBars   = Math.round(1440 / interval); // one bar per scan interval across 24h

  /* Compute the Unix timestamp for midnight of today in PH time.
     We shift to UTC+8, zero out hours/minutes/seconds, then shift back. */
  const todayPhMs = (() => {
    const d = new Date(Date.now() + PH_OFFSET_MS);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime() - PH_OFFSET_MS;
  })();
  const prevDayPhMs = todayPhMs - 86400000;

  const prevPrimary = new Array(numBars).fill(0);
  const prevSecondary = new Array(numBars).fill(0);
  const primary   = new Array(numBars).fill(0);
  const secondary = new Array(numBars).fill(0);
  let hasCurrent = false;
  let hasPrev = false;

  /* Place each scan total into its time slot.
     max() prevents shorter overlapping scans from overwriting a larger count. */
  for (const { ts, count, newCount, error } of totals) {
    if (error || count === null) continue; // skip failed scan entries
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
    container.innerHTML = '<span style="font-size:10px;color:var(--muted)">No data yet for today</span>';
    return;
  }

  container.innerHTML = buildSparkSVG(primary, secondary, {
    vw: 340, h: 56, ah: 18, interval,
    bgSeries: prevPrimary,
    bgSecondary: prevSecondary,
    bgColor: 'rgba(130,140,160,0.42)',
    bgColor2: 'rgba(150,150,170,0.55)',
    tip: (i, v, v2) => {
      const phMin = i * interval;
      const hh = String(Math.floor(phMin / 60)).padStart(2, '0');
      const mm = String(phMin % 60).padStart(2, '0');
      return `${hh}:${mm} PH — ${v} online, ${v2} new`;
    }
  });
}

/**
 * Render the storage usage bar and label (#storageVal, #storageBarFill).
 * Uses chrome.storage.local.getBytesInUse to get actual usage.
 * Bar colour shifts from teal (low) through gold to magenta (high).
 */
function renderStorage() {
  if (!chrome.storage.local.getBytesInUse) return;
  chrome.storage.local.getBytesInUse(null, used => {
    const quota  = chrome.storage.local.QUOTA_BYTES || 10485760; // 10 MB default
    const pct    = Math.min(100, (used / quota) * 100);
    const usedKb = (used / 1024).toFixed(1);
    const quotaMb = (quota / 1048576).toFixed(0);

    const el   = $('storageVal');
    const fill = $('storageBarFill');
    if (el)   el.textContent = `${usedKb} KB / ${quotaMb} MB`;
    if (fill) {
      fill.style.width = pct + '%';
      fill.style.background = pct > 80
        ? 'var(--magenta)'
        : pct > 50
          ? 'linear-gradient(90deg,var(--gold),var(--magenta))'
          : 'linear-gradient(90deg,var(--cyan),var(--teal))';
    }
  });
}

/**
 * Render the scan history log (#logRows).
 * Shows the most recent 40 scan entries from pinalove_totals, newest first.
 * Each row shows the date/time and badge counts.
 */
function renderLog() {
  $('logCount').textContent = `${totals.length} scan${totals.length !== 1 ? 's' : ''}`;

  const rowsEl = $('logRows');
  if (!totals.length) {
    rowsEl.innerHTML = '<div class="log-empty">No scans yet</div>';
    return;
  }

  rowsEl.innerHTML = [...totals].reverse().slice(0, 40).map(t => {
    const dt      = new Date(t.ts);
    const timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = dt.toLocaleDateString([], { month: 'short', day: 'numeric' });

    /* Failed scans have a non-null error field and null count — render as a red row. */
    if (t.error) {
      return `<div class="log-row err">
        <span class="log-time">${dateStr} ${timeStr}</span>
        <div class="log-badges"><span class="lb r">✕ ${t.error}</span></div>
      </div>`;
    }

    return `<div class="log-row">
      <span class="log-time">${dateStr} ${timeStr}</span>
      <div class="log-badges">
        <span class="lb g">${t.count} online</span>
        ${t.newCount ? `<span class="lb y">+${t.newCount} new</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

/* ─── Settings UI sync ───────────────────────────────────────────────────────── */

/**
 * Sync the rate display and +/- button states to the current scanInterval value.
 * Called after scanInterval changes, either from user input or storage load.
 */
function updateRateUI() {
  $('rateVal').textContent   = scanInterval;
  $('rateDown').disabled     = scanInterval <= 1;
  $('rateUp').disabled       = scanInterval >= 5;
}

/* ─── Status / progress ──────────────────────────────────────────────────────── */

/**
 * Update the status message bar with text and a colour type class.
 *
 * @param {string} msg  - Status text to display.
 * @param {string} type - CSS class: 'info' | 'ok' | 'err'.
 */
function setStatus(msg, type = 'info') {
  const el = $('statusMsg');
  el.textContent = msg;
  el.className   = `status ${type}`;
}

/**
 * Show or hide the progress bar area (#progressWrap).
 *
 * When activating (active = true):
 *   - Shows the progress bar
 *   - Arms the watchdog timer: if no progress update arrives within
 *     WATCHDOG_MS ms we assume the scan froze and reset the UI to idle.
 *
 * When deactivating (active = false):
 *   - Hides the progress bar and clears its text
 *   - Disarms the watchdog (scan completed normally)
 *
 * @param {boolean} active
 */
function setScanningState(active) {
  $('progressWrap').style.display = active ? 'block' : 'none';
  if (!active) $('progressText').textContent = '';

  /* Disarm any existing watchdog whenever state changes. */
  clearTimeout(watchdogTimer);
  watchdogTimer = null;

  if (active) {
    /* Arm: if nothing updates us within WATCHDOG_MS, declare the scan frozen. */
    watchdogTimer = setTimeout(() => {
      console.warn('[Pinkerton] Watchdog: no scan progress for', WATCHDOG_MS / 1000, 's — resetting UI');
      setStatus('⚠ Scan timed out or froze — will retry on next interval', 'err');
      setScanningState(false);

      /* Restart the countdown if auto-scan is still configured. */
      if (autoEnabled) {
        chrome.runtime.sendMessage({ action: 'getAlarmStatus' }, res => {
          if (res?.alarm) showCountdown(res.alarm);
        });
      }
    }, WATCHDOG_MS);
  }
}

/**
 * Handle a progress event object from pinalove_scan_progress storage.
 *
 * Event types:
 *   progress — update page counter and status bar; pets the watchdog
 *              so it knows the scan is still alive
 *   done     — show final count and reason; stop progress bar; refresh countdown
 *   info     — display an informational message (e.g. storage purge notification)
 *   error    — show error message and hide progress bar
 *
 * @param {object} prog - Progress event from storage.
 */
function updateProgress(prog) {
  if (prog.type === 'progress') {
    $('progressText').textContent = `Page ${prog.page} · ${prog.found} online found`;
    setStatus(`Scanning page ${prog.page}…`, 'info');

    /*
     * While a scan is active, replace the countdown number with "scanning"
     * so the user doesn't see a stale 0:00 and think the extension froze.
     * The countdown resumes once the scan completes and we get a 'done' event.
     */
    clearInterval(countdownInterval);
    $('countdownVal').textContent = 'scanning…';
    $('countdown').style.display = 'block';

    /*
     * Pet the watchdog: the scan is clearly still alive, so reset the
     * timeout back to the full WATCHDOG_MS from now.
     * We do this by briefly disabling and re-enabling the scanning state
     * without touching the progress bar visibility.
     */
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      console.warn('[Pinkerton] Watchdog: no scan progress for', WATCHDOG_MS / 1000, 's — resetting UI');
      setStatus('⚠ Scan timed out or froze — will retry on next interval', 'err');
      setScanningState(false);
      if (autoEnabled) {
        chrome.runtime.sendMessage({ action: 'getAlarmStatus' }, res => {
          if (res?.alarm) showCountdown(res.alarm);
        });
      }
    }, WATCHDOG_MS);

  } else if (prog.type === 'done') {
    const reason = { last_page: 'all pages done', stopped: 'stopped' }[prog.stoppedReason] || '';
    setStatus(`✓ ${prog.onlineCount} online · ${prog.pages} pages · ${reason}`, 'ok');
    setScanningState(false); /* also disarms the watchdog */

    /*
     * Refresh the countdown.
     * After a scan completes, Chrome reschedules the alarm for the next interval.
     * We fetch the updated alarm object to display accurate time-to-next-scan.
     * If the message fails (service worker restarted), we fall back to a
     * periodic poll so the countdown is never permanently stuck.
     */
    if (autoEnabled) {
      chrome.runtime.sendMessage({ action: 'getAlarmStatus' }, res => {
        if (res?.alarm) {
          showCountdown(res.alarm);
        } else {
          /* Background didn't respond — poll until the alarm reappears. */
          scheduleCountdownPoll();
        }
      });
    }

  } else if (prog.type === 'info') {
    /* Informational events (e.g. storage purge start/complete) are shown briefly. */
    setStatus('ℹ ' + prog.message, 'info');

  } else if (prog.type === 'error') {
    setStatus('⚠ ' + prog.message, 'err');
    setScanningState(false); /* also disarms the watchdog */

    /* Same countdown recovery as done. */
    if (autoEnabled) {
      chrome.runtime.sendMessage({ action: 'getAlarmStatus' }, res => {
        if (res?.alarm) showCountdown(res.alarm);
        else scheduleCountdownPoll();
      });
    }
  }
}

/**
 * Start the countdown timer display, ticking down to the next scheduled scan.
 *
 * Displays MM:SS remaining in #countdownVal. Clears any existing interval
 * first to avoid duplicate tickers. Hides the countdown if rem reaches 0
 * (the alarm will fire and a new one will be set shortly after).
 *
 * @param {chrome.alarms.Alarm} alarm - Alarm object with .scheduledTime in ms.
 */
function showCountdown(alarm) {
  $('countdown').style.display = 'block';
  clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    const rem = Math.max(0, alarm.scheduledTime - Date.now());
    const m   = Math.floor(rem / 60000);
    const s   = Math.floor((rem % 60000) / 1000);
    $('countdownVal').textContent = `${m}:${s.toString().padStart(2, '0')}`;

    if (rem <= 0) {
      /*
       * Alarm has fired. Stop this ticker and start polling for the
       * rescheduled alarm. Chrome creates a new alarm immediately after
       * the old one fires (for periodic alarms), but there is a brief
       * gap where getAlarmStatus returns nothing. scheduleCountdownPoll
       * retries until it finds the new alarm object.
       *
       * Without this, the countdown permanently shows 0:00 for the
       * entire duration of the scan and the subsequent interval.
       */
      clearInterval(countdownInterval);
      if (autoEnabled) scheduleCountdownPoll();
    }
  }, 1000);
}

/*
 * How many ms between countdown poll attempts when the alarm is temporarily
 * unavailable (e.g. right after service worker restart).
 */
const COUNTDOWN_POLL_MS = 3000;

/**
 * Poll for the alarm object every COUNTDOWN_POLL_MS until it appears.
 *
 * Chrome's service worker can restart between a scan completing and the
 * alarm being rescheduled. During that gap getAlarmStatus returns no alarm.
 * We retry a few times so the countdown always resumes once the alarm exists.
 *
 * Gives up after 5 attempts to avoid polling indefinitely.
 */
function scheduleCountdownPoll(attempt = 0) {
  if (attempt >= 5) return; /* give up after 5 × 3s = 15 seconds */
  setTimeout(() => {
    chrome.runtime.sendMessage({ action: 'getAlarmStatus' }, res => {
      if (res?.alarm) {
        showCountdown(res.alarm);
      } else {
        scheduleCountdownPoll(attempt + 1);
      }
    });
  }, COUNTDOWN_POLL_MS);
}

/* ─── Events ─────────────────────────────────────────────────────────────────── */

/**
 * Bind all UI event listeners.
 * Called once after the DOM and initial data are ready.
 */
function bindEvents() {

  /* ── Tab switching ────────────────────────────────────────────────────
     All tabs and panels are wired with data-tab attributes.
     Clicking a tab activates it and its matching panel. */
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  /* ── Auto-scan toggle handler ─────────────────────────────────────────
     Shared logic for enabling/disabling auto-scan from the button. */
  function handleAutoToggle(enabled) {
    autoEnabled = enabled;
    updateAutoScanBtn(enabled);
    chrome.runtime.sendMessage({ action: 'toggleAutoScan', enabled }, () => {
      if (enabled) {
        setStatus(`Auto-scan ON — every ${scanInterval} min`, 'ok');
        $('countdown').style.display = 'block';
        /* Fetch the alarm object so we can start the countdown display. */
        chrome.runtime.sendMessage({ action: 'getAlarmStatus' }, res => {
          if (res?.alarm) showCountdown(res.alarm);
        });
      } else {
        setStatus('Auto-scan OFF', 'info');
        $('countdown').style.display = 'none';
        clearInterval(countdownInterval);
      }
    });
  }

  /* ── Open results tab ─────────────────────────────────────────────────
     Focuses an existing results tab if one is open, otherwise creates one. */
  $('openResultsBtn').addEventListener('click', () => {
    const url = chrome.runtime.getURL('results.html');
    chrome.tabs.query({ url }, tabs => {
      if (tabs.length) {
        chrome.tabs.update(tabs[0].id, { active: true });
      } else {
        chrome.tabs.create({ url });
      }
    });
  });

  /* ── Clear data ───────────────────────────────────────────────────────
     Confirms before wiping everything; resets all in-memory state too. */
  $('clearBtn').addEventListener('click', () => {
    if (!confirm('Delete ALL scan data, history and cache? This cannot be undone.')) return;
    chrome.runtime.sendMessage({ action: 'clearRecords' }, () => {
      members = {}; totals = [];
      renderDashboard();
      renderStorage();
      setStatus('All data cleared.', 'info');
    });
  });

  /* ── Scan rate +/- buttons ────────────────────────────────────────────
     Rate is clamped to [1, 5] minutes and persisted to storage. */
  function setRate(mins) {
    scanInterval = Math.min(5, Math.max(1, mins));
    updateRateUI();
    chrome.runtime.sendMessage({ action: 'setScanInterval', minutes: scanInterval });
  }
  $('rateDown').addEventListener('click', () => setRate(scanInterval - 1));
  $('rateUp').addEventListener('click',   () => setRate(scanInterval + 1));

  /* ── Auto-scan button visual state ───────────────────────────────────
     Toggles button label and colour class; also locks/unlocks scan params
     while a scan is running (to avoid mid-scan setting changes). */
  function updateAutoScanBtn(enabled) {
    const btn = $('autoScanBtn');
    if (!btn) return;
    if (enabled) {
      btn.textContent = '⏹ Stop Scanning';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-danger');
    } else {
      btn.textContent = '▶ Start Automatic Scanning';
      btn.classList.remove('btn-danger');
      btn.classList.add('btn-primary');
    }
    /* Disable scan parameter controls while auto-scan is running. */
    const lockIds = ['scanGender', 'scanAgeMin', 'scanAgeMax', 'clearBtn', 'rateDown', 'rateUp'];
    lockIds.forEach(id => { const el = $(id); if (el) el.disabled = enabled; });
  }

  /* Apply button state on load based on the persisted autoEnabled flag. */
  updateAutoScanBtn(autoEnabled);

  $('autoScanBtn').addEventListener('click', () => {
    const enabling = !autoEnabled;
    handleAutoToggle(enabling);

    /*
     * When starting auto-scan, arm the progress UI immediately.
     *
     * The background fires an immediate scanUntilOffline() but the first
     * progress storage write takes ~1-2 seconds to arrive. Without this,
     * the popup shows nothing until that first write, which looks like a
     * freeze. Setting scanning state here also arms the watchdog so if
     * the immediate scan silently fails (service worker killed, fetch error
     * not caught), the UI resets after WATCHDOG_MS rather than hanging forever.
     */
    if (enabling) {
      setScanningState(true);
      setStatus('Starting scan…', 'info');
    }
  });

  /* ── Scan parameter controls ──────────────────────────────────────────
     Gender, min age, max age. Persisted together under pinalove_settings. */
  function saveScanParams() {
    chrome.storage.local.get('pinalove_settings', data => {
      const s = data.pinalove_settings || {};
      s.scanGender = scanGender;
      s.scanAgeMin = scanAgeMin;
      s.scanAgeMax = scanAgeMax;
      chrome.storage.local.set({ pinalove_settings: s });
    });
  }

  function initScanParamUI() {
    const gEl   = $('scanGender');
    const minEl = $('scanAgeMin');
    const maxEl = $('scanAgeMax');

    /* Initialise input values from loaded settings; register change handlers. */
    if (gEl) {
      gEl.value = scanGender;
      gEl.addEventListener('change', () => { scanGender = gEl.value; saveScanParams(); });
    }
    if (minEl) {
      /* Show blank instead of "18" (the default minimum age) to reduce visual clutter. */
      minEl.value = scanAgeMin === 18 ? '' : scanAgeMin;
      minEl.addEventListener('change', () => { scanAgeMin = parseInt(minEl.value) || 18; saveScanParams(); });
    }
    if (maxEl) {
      /* Show blank instead of "99" (the default maximum age). */
      maxEl.value = scanAgeMax === 99 ? '' : scanAgeMax;
      maxEl.addEventListener('change', () => { scanAgeMax = parseInt(maxEl.value) || 99; saveScanParams(); });
    }
  }
  initScanParamUI();

  /* ── User profile metrics (height/weight for comparisons) ────────────
     Optional fields used to display relative size comparisons in profile modals. */
  function saveUserProfileMetrics() {
    chrome.storage.local.get('pinalove_settings', data => {
      const s = data.pinalove_settings || {};
      s.myHeight = myHeight;
      s.myWeight = myWeight;
      chrome.storage.local.set({ pinalove_settings: s });
    });
  }

  function initUserProfileUI() {
    const heightEl = $('myHeight');
    const weightEl = $('myWeight');

    if (heightEl) {
      heightEl.value = myHeight || '';
      heightEl.addEventListener('change', () => {
        myHeight = parseInt(heightEl.value) || null;
        saveUserProfileMetrics();
      });
    }
    if (weightEl) {
      weightEl.value = myWeight || '';
      weightEl.addEventListener('change', () => {
        myWeight = parseInt(weightEl.value) || null;
        saveUserProfileMetrics();
      });
    }
  }
  initUserProfileUI();

  /* ── Live storage change listener ────────────────────────────────────
     While the popup is open, keep the UI in sync with background changes.

     We track lastProgressTs to deduplicate rapid storage writes — the background
     may write progress very quickly and we only want to process each unique
     timestamp once. */
  let lastProgressTs = 0;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    /* Progress updates — scan page counter and status bar. */
    if (changes.pinalove_scan_progress) {
      const prog = changes.pinalove_scan_progress.newValue;
      if (prog?.ts && prog.ts > lastProgressTs && prog.ts > Date.now() - 60000) {
        lastProgressTs = prog.ts;
        updateProgress(prog);
      }
    }

    /* Members database updated — re-render New/Premium/Verified totals. */
    if (changes.pinalove_members || changes.pinalove_member_locations) {
      chrome.storage.local.get(['pinalove_members', 'pinalove_member_locations'], data => {
        members = decodeMembersMap(data.pinalove_members || {}, data.pinalove_member_locations || []);
        renderStats();
      });
    }

    /* Settings change — re-render sparkline if interval changed. */
    if (changes.pinalove_settings) {
      const s = changes.pinalove_settings.newValue;
      if (s?.scanInterval) { scanInterval = s.scanInterval; renderSparkline(); }
    }

    /* New totals entry (appended after each scan) — re-render sparkline. */
    if (changes.pinalove_totals) {
      totals = changes.pinalove_totals.newValue || [];
      renderStats();
      renderSparkline();
    }
  });
}
