// content.js — PinaLove Counter v2.6
// Re-register listener on every injection (safe — Chrome deduplicates per page load)
// Remove any previous listener to avoid doubles on re-injection
if (window.__pinaloveListener) {
  chrome.runtime.onMessage.removeListener(window.__pinaloveListener);
}

  // ─── Scraping ───────────────────────────────────────────────────────────────

  function scrapeAll() {
    const cards = document.querySelectorAll('div.thumbcontain[id^="br-"]');
    const users = Array.from(cards).map(parseCard).filter(Boolean);
    const { currentPage, totalPages } = getPageInfo();
    return {
      users,
      onlineCount: users.filter(u => u.isOnline).length,
      hasOffline:  users.some(u => !u.isOnline),
      hasNextPage: hasNextPage(),
      currentPage,
      totalPages,
      url:   window.location.href,
      title: document.title,
    };
  }

  function parseCard(card) {
    const username = card.id.replace(/^br-/, '');
    const anchor = card.querySelector('a.pr');
    const profileUrl = anchor
      ? (anchor.href.startsWith('http') ? anchor.href : location.origin + anchor.getAttribute('href'))
      : null;
    const isOnline  = !!card.querySelector('.pusername img[src*="online"]');
    const isPremium = !!card.querySelector('.ppop');   // <div class="ppop">Premium</div>
    const isNew     = !!card.querySelector('.pnew');   // <div class="pnew">New</div>
    const smtext    = card.querySelector('span.smtext');
    let age = null, location_ = null;
    if (smtext) {
      const parts = smtext.textContent.split(',').map(s => s.trim());
      const n = parseInt(parts[0], 10);
      if (!isNaN(n) && n >= 18 && n <= 99) age = n;
      if (parts[1]) location_ = parts[1];
    }
    const isVerified = !!card.querySelector('img.fvbrowse, img[src*="verified"]');

    // Photo: extract x3 jpg from img.pthumb srcset — confirmed working format
    // srcset: "/path/filex1.jpg, /path/filex2.jpg 2x, /path/filex3.jpg 3x"
    let photoUrl = null;
    const thumb = card.querySelector('img.pthumb');
    if (thumb) {
      const srcset = thumb.getAttribute('srcset') || '';
      const parts = srcset.split(',').map(s => s.trim());
      for (const part of parts) {
        const url = part.split(' ')[0];
        if (url.includes('x3.')) {
          photoUrl = url.startsWith('http') ? url : location.origin + url;
          break;
        }
      }
      // Fallback to src if no x3 found
      if (!photoUrl && thumb.src) photoUrl = thumb.src;
    }

    return { username, profileUrl, photoUrl, isOnline, isPremium, isNew, age, location: location_, isVerified };
  }

  function getPageInfo() {
    return { currentPage: null, totalPages: null };
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────

  function hasNextPage() {
    const btn = document.querySelector('button.nbnav-button.next');
    return !!btn && !btn.disabled;
  }

  function goToNextPage() {
    // PinaLove ONLY: button.nbnav-button.next with onclick="window.location.href='/browse.php?...'"
    const pinaNext = document.querySelector('button.nbnav-button.next');
    console.log('[PinaLove] goToNextPage — button found:', !!pinaNext, 'disabled:', pinaNext?.disabled);
    if (pinaNext && !pinaNext.disabled) {
      const onclick = pinaNext.getAttribute('onclick') || '';
      console.log('[PinaLove] onclick attr:', onclick);
      // HTML-decoded variant: &quot; becomes "
      const decoded = onclick.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      const match = decoded.match(/window\.location\.href="([^"]+)"/) ||
                    decoded.match(/window\.location\.href='([^']+)'/);
      if (match) {
        console.log('[PinaLove] navigating to:', match[1]);
        window.location.href = match[1];
        return true;
      }
      console.warn('[PinaLove] could not extract URL from onclick:', decoded);
    }
    return false;
  }

  // ─── Page hiding ─────────────────────────────────────────────────────────────

  function applyVisibilityFilters(filters) {
    const cards = document.querySelectorAll('div.thumbcontain[id^="br-"]');
    let shown = 0, hidden = 0;
    cards.forEach(card => {
      const u = parseCard(card);
      let visible = true;
      if ( u.isOnline && !filters.online)  visible = false;
      if (!u.isOnline && !filters.offline) visible = false;
      if (filters.only_new      && !u.isNew)      visible = false;
      if (filters.only_premium  && !u.isPremium)  visible = false;
      if (filters.only_verified && !u.isVerified) visible = false;
      if (filters.has_age       && u.age == null) visible = false;
      if (filters.ageMin != null && u.age != null && u.age < filters.ageMin) visible = false;
      if (filters.ageMax != null && u.age != null && u.age > filters.ageMax) visible = false;
      card.style.display = visible ? '' : 'none';
      if (visible) shown++; else hidden++;
    });
    return { shown, hidden };
  }

  function clearVisibilityFilters() {
    document.querySelectorAll('div.thumbcontain[id^="br-"]').forEach(c => { c.style.display = ''; });
  }

  // ─── Message listener ────────────────────────────────────────────────────────

  window.__pinaloveListener = (request, sender, sendResponse) => {
    try {
      if (request.action === 'scanFull' || request.action === 'countOnline') {
        sendResponse(scrapeAll());
      } else if (request.action === 'goNextPage') {
        sendResponse({ ok: goToNextPage() });
      } else if (request.action === 'applyFilters') {
        sendResponse(applyVisibilityFilters(request.filters));
      } else if (request.action === 'clearFilters') {
        clearVisibilityFilters();
        sendResponse({ ok: true });
      } else if (request.action === 'debug') {
        const cards = document.querySelectorAll('div.thumbcontain[id^="br-"]');
        sendResponse({
          url: window.location.href,
          cardCount: cards.length,
          cardSelectorUsed: 'div.thumbcontain[id^="br-"]',
          parsedSample: Array.from(cards).slice(0, 3).map(parseCard),
          sampleCardHtml: cards[0] ? cards[0].outerHTML.substring(0, 2000) : '(none)',
          hasNextPage: hasNextPage(),
          allClassNames: [], greenElements: [],
        });
      } else {
        sendResponse(null);
      }
    } catch (err) {
      sendResponse({ error: err.message });
    }
    return false;
  };

  chrome.runtime.onMessage.addListener(window.__pinaloveListener);
  console.log('[PinaLove] ready — cards:', document.querySelectorAll('div.thumbcontain[id^="br-"]').length, '| next page:', hasNextPage());