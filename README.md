# PinaLove Online Counter — Chrome Extension

A browser extension that counts online users on **pinalove.com**, with per-page tracking and session totals across paginated results.

---

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer Mode** (toggle in the top-right)
3. Click **Load unpacked**
4. Select the `pinalove-counter/` folder
5. The extension icon appears in your toolbar

---

## Usage

1. Navigate to **pinalove.com** (log in first so profiles are visible)
2. Click the extension icon in the toolbar
3. Press **Scan Page** — the popup shows:
   - Online users detected on the current page
   - Current page number
   - Total profiles visible on the page
   - Cumulative session totals (pages scanned, total online, total profiles seen)
   - A per-page log
4. Navigate to the **next page** (pagination), then press **Scan Page** again
5. Session totals accumulate across all pages you scan
6. Press **Reset** to clear the session data

---

## How it detects "online" users

`content.js` searches the DOM for common CSS selectors used to indicate online status:

```
.online-badge, .is-online, .user-online, .online,
[data-online="true"], .status-online, .icon-online,
.member-online, .profile-online, .dot-online
```

It also counts any element whose visible text is exactly `"Online"` (case-insensitive).

### Customising selectors

If PinaLove updates its markup, open `content.js` and edit the `ONLINE_SELECTORS` array at the top:

```js
const ONLINE_SELECTORS = [
  '.your-selector-here',
  // ...
];
```

You can find the correct selector by:
1. Right-clicking an online badge on pinalove.com → **Inspect**
2. Noting the class name or attribute on that element
3. Adding it to `ONLINE_SELECTORS`

---

## File structure

```
pinalove-counter/
├── manifest.json   — Extension metadata & permissions
├── content.js      — DOM scraper injected into pinalove.com pages
├── popup.html      — Extension popup UI
├── popup.js        — Popup logic, session storage
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Notes

- Session data is stored in `chrome.storage.local` and persists between browser sessions until you click **Reset**.
- The extension only runs on `pinalove.com` pages (declared in `host_permissions`).
- No data is sent to any external server — everything stays local.
