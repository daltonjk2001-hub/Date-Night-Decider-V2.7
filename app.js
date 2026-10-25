'use strict';

/* Date Night Decider — version 2.9.4 with Production Audit & Checklist Updates:
   - Top-three mutual match shortlisting and final voting round.
   - Polished win animation, estimated cost, instructions, and Start Date action.
   - Shareable link (?room=CODE) with clipboard copying and auto-join.
   - Robust connection states (creating, waiting, connecting, connected, disconnected) and automatic reconnection.
   - Service worker precaching and robust backup validation. */

const getEl = id => document.getElementById(id);

let db = null;
let useMemoryFallback = typeof window.Dexie !== 'function';

if (useMemoryFallback) {
  console.warn('Dexie did not load. Running with temporary in-memory storage.');
  document.body.insertAdjacentHTML(
    'afterbegin',
    '<div role="alert" style="padding:12px 16px;background:#5b1730;color:white;font:14px sans-serif;text-align:center">The local database library did not load. The app can still run, but changes may not persist after this tab closes.</div>'
  );
} else {
  try {
    db = new Dexie('DateNightDatabase');
    db.version(1).stores({
      settings: 'key',
      customDeck: '++id, id',
      deletedBuiltins: 'id',
      categories: 'id',
      history: '++id, date',
      unlocks: 'id'
    });
  } catch (err) {
    console.warn('IndexedDB is unavailable; using temporary in-memory state:', err);
    useMemoryFallback = true;
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<div role="alert" style="padding:12px 16px;background:#5b1730;color:white;font:14px sans-serif;text-align:center">Persistent storage is unavailable. Changes may not persist after this tab closes.</div>'
    );
  }
}

const DEFAULT_CATEGORIES = [
  'baking', 'cooking', 'gaming', 'board games', 'tv', 'movie',
  'micro-adventure', 'quest', 'arcade'
];

function limitText(value, maxLength = 1000) {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, maxLength);
}

function sanitizeCard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const id = limitText(raw.id, 80);
  const title = limitText(raw.title, 160);
  const category = limitText(raw.category, 40);
  const budget = raw.budget;
  const location = raw.location;

  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) return null;
  if (!title) return null;
  if (!DEFAULT_CATEGORIES.includes(category)) return null;
  if (!['free', 'paid'].includes(budget)) return null;
  if (!['home', 'out'].includes(location)) return null;

  const candidateGradient = limitText(raw.gradient, 100);
  const safeGradient = /^linear-gradient\(135deg,\s*#[0-9a-f]{6},\s*#[0-9a-f]{6}\)$/i.test(candidateGradient)
    ? candidateGradient
    : 'linear-gradient(135deg, #31103f, #190a24)';

  const card = {
    id,
    title,
    detail: limitText(raw.detail, 3000),
    category,
    budget,
    location,
    costEstimate: limitText(raw.costEstimate, 120),
    gradient: safeGradient
  };

  if (raw.duration !== undefined) card.duration = limitText(raw.duration, 100);

  if (Array.isArray(raw.equipment)) {
    card.equipment = raw.equipment.slice(0, 20).map(item => limitText(item, 200)).filter(Boolean);
  } else if (typeof raw.equipment === 'string') {
    card.equipment = limitText(raw.equipment, 200);
  }

  if (raw.mission !== undefined) card.mission = limitText(raw.mission, 3000);
  if (raw.atHomeAlternative !== undefined) card.atHomeAlternative = limitText(raw.atHomeAlternative, 1500);
  if (raw.importantRule !== undefined) card.importantRule = limitText(raw.importantRule, 1500);

  if (Array.isArray(raw.howToPlay)) {
    card.howToPlay = raw.howToPlay.slice(0, 20).map(step => limitText(step, 400)).filter(Boolean);
  }

  if (typeof raw.banned === 'boolean') card.banned = raw.banned;
  return card;
}

function sanitizeCardDeck(rawDeck, maxCards = 500) {
  if (!Array.isArray(rawDeck)) return [];
  const output = [];
  const seenIds = new Set();

  rawDeck.slice(0, maxCards).forEach(rawCard => {
    const card = sanitizeCard(rawCard);
    if (!card || seenIds.has(card.id)) return;
    seenIds.add(card.id);
    output.push(card);
  });

  return output;
}

function sanitizeHistoryEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const dateText = limitText(raw.date, 80);
  const time = Date.parse(dateText);
  if (!Number.isFinite(time)) return null;

  const safeRating = value => {
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 && number <= 5 ? number : null;
  };

  const syncId = limitText(raw.syncId, 120) || createUniqueId();
  const category = DEFAULT_CATEGORIES.includes(raw.category) ? raw.category : 'Date';

  return {
    syncId,
    cardId: limitText(raw.cardId, 80) || null,
    title: limitText(raw.title, 160) || 'Untitled date',
    category,
    detail: limitText(raw.detail, 3000),
    date: new Date(time).toISOString(),
    rating1: safeRating(raw.rating1),
    rating2: safeRating(raw.rating2),
    note: limitText(raw.note, 2000)
  };
}

let customDeck = [];
let deletedBuiltins = new Set();
let unlockedItems = [];
let dateHistory = [];
let appSettings = { theme: 'dark', feedback: 'both' };
let fullDeck = [];
let activeDeck = [];
let selectedPreviewItemId = null;
let selectedCategories = [...DEFAULT_CATEGORIES];

const PEER_OPTIONS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  }
};

function showToast(message, duration = 3500) {
  let container = getEl('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:200;display:grid;gap:8px;pointer-events:none;width:90%;max-width:400px;';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.style.cssText = 'background:#241436;border:1px solid var(--gold);color:var(--cream);padding:12px 16px;border-radius:12px;font-size:0.82rem;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,0.85);pointer-events:auto;text-align:center;animation:fadeInOut 0.3s ease;';
  toast.textContent = message;
  container.appendChild(toast);
  window.setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    window.setTimeout(() => toast.remove(), 300);
  }, duration);
}

function triggerHaptic(type = 'light') {
  if (!['both', 'vibration'].includes(appSettings.feedback)) return;
  if (!('vibrate' in navigator)) return;
  try {
    if (type === 'light') navigator.vibrate(15);
    else if (type === 'success') navigator.vibrate([40, 60, 40]);
    else if (type === 'heavy') navigator.vibrate(50);
  } catch (_) { /* Haptics optional */ }
}

const audioCtx = (() => {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    return AudioContextClass ? new AudioContextClass() : null;
  } catch (_) { return null; }
})();

function playSound(type) {
  if (!['both', 'sound'].includes(appSettings.feedback) || !audioCtx) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    if (type === 'swipe') {
      osc.frequency.setValueAtTime(350, now);
      osc.frequency.exponentialRampToValueAtTime(120, now + 0.08);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.08);
      osc.start(now); osc.stop(now + 0.08);
    } else if (type === 'ban') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(160, now);
      osc.frequency.exponentialRampToValueAtTime(70, now + 0.1);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.1);
      osc.start(now); osc.stop(now + 0.1);
    } else if (type === 'win') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(523, now);
      osc.frequency.setValueAtTime(659, now + 0.1);
      osc.frequency.setValueAtTime(783, now + 0.2);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.35);
      osc.start(now); osc.stop(now + 0.35);
    }
  } catch (err) { console.debug('Sound unavailable:', err); }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

const masterDeck = [
  { id:'baking-01', title:'Apple-Blackberry Lattice Pie', detail:'Make an all-butter pie dough from scratch, roll out a woven lattice top, and fill with fresh apple and blackberry.', category:'baking', budget:'paid', location:'home', costEstimate:'$10–$15 for ingredients', gradient:'linear-gradient(135deg, #4a1525, #831843)' },
  { id:'baking-02', title:'Cream Cheese Danish Batch', detail:'Make laminated pastry dough from scratch, fill with sweet cream cheese and fruit preserves, and bake until golden.', category:'baking', budget:'paid', location:'home', costEstimate:'$8–$12 for ingredients', gradient:'linear-gradient(135deg, #3b1f2b, #701a75)' },
  { id:'cooking-01', title:'Homemade Gourmet Pizza Night', detail:'Stretch homemade dough from scratch, layer with custom sauces, premium cheese, and your favorite toppings.', category:'cooking', budget:'paid', location:'home', costEstimate:'$12–$20 for toppings', gradient:'linear-gradient(135deg, #1e293b, #0f172a)' },
  { id:'cooking-02', title:'Authentic Street Taco Bar', detail:'Prep slow-cooked carnitas or grilled chicken with homemade salsas, fresh cilantro, and warm corn tortillas.', category:'cooking', budget:'paid', location:'home', costEstimate:'$15–$25 for fresh ingredients', gradient:'linear-gradient(135deg, #451a03, #78350f)' },
  { id:'gaming-01', title:'Cozy Split-Screen Co-Op', detail:'Load up a relaxing couch co-op video game and work together to build a shared virtual world or solve puzzles.', category:'gaming', budget:'free', location:'home', costEstimate:'Free (using owned games)', gradient:'linear-gradient(135deg, #064e3b, #022c22)' },
  { id:'gaming-02', title:'Arcade High Score Showdown', detail:'Play classic arcade games or fast-paced party games and battle head-to-head for the top spot.', category:'gaming', budget:'paid', location:'out', costEstimate:'$10–$25 arcade tokens', gradient:'linear-gradient(135deg, #172554, #1e3a8a)' },
  { id:'board-01', title:'Intense Strategy Board Game', detail:'Brew some coffee or tea, clear the table, and dive into a deep tabletop strategy or card drafting game.', category:'board games', budget:'free', location:'home', costEstimate:'Free (using owned games)', gradient:'linear-gradient(135deg, #312e81, #1e1b4b)' },
  { id:'board-02', title:'Fast-Paced Party Card Game', detail:'Pull out a hilarious casual card game for quick laughs and lighthearted competition.', category:'board games', budget:'free', location:'home', costEstimate:'Free (using owned games)', gradient:'linear-gradient(135deg, #581c87, #3b0764)' },
  { id:'tv-01', title:'Nostalgic TV Show Pilot Night', detail:'Rewatch the pilot episodes of your favorite childhood TV series together.', category:'tv', budget:'free', location:'home', costEstimate:'Free on streaming', gradient:'linear-gradient(135deg, #831843, #500724)' },
  { id:'tv-02', title:'Binge-Worthy Mystery Series', detail:'Stream the opening episodes of a gripping new thriller or mystery show.', category:'tv', budget:'free', location:'home', costEstimate:'Free on streaming', gradient:'linear-gradient(135deg, #0f766e, #115e59)' },
  { id:'movie-01', title:'First-Time Epic Adventure', detail:'Stream a critically acclaimed adventure or sci-fi movie that neither of you has ever seen.', category:'movie', budget:'free', location:'home', costEstimate:'Free on streaming', gradient:'linear-gradient(135deg, #31103f, #190a24)' },
  { id:'movie-02', title:'Local Cinema Night Out', detail:'Get dressed up, grab buttery popcorn at the local movie theater, and catch the latest release.', category:'movie', budget:'paid', location:'out', costEstimate:'$20–$40 tickets & snacks', gradient:'linear-gradient(135deg, #6b21a8, #4c1d95)' }
];

const storeCatalog = [
  { id: 'pack-viral', title: 'Pack 1: Viral Micro-Adventures', type: 'deck', price: '$0.99', desc: 'Seven unusual little adventures that turn ordinary places, objects, and memories into a date.', gradient: 'linear-gradient(135deg, #31103f, #190a24)' },
  { id: 'pack-coop', title: 'Pack 2: Co-Op Worlds & Gaming Challenges', type: 'deck', price: '$0.99', desc: 'Seven cooperative challenges for couples who enjoy digital, tabletop, or creative building games.', gradient: 'linear-gradient(135deg, #064e3b, #022c22)' },
  { id: 'pack-sweet', title: 'Pack 3: Sweet Treat Showdown', type: 'deck', price: '$0.99', desc: 'Seven relaxed dessert challenges, from a complete cookie recipe to quick no-bake creations.', gradient: 'linear-gradient(135deg, #4a1525, #831843)' },
  { id: 'pack-quest', title: 'Pack 4: Around-Town Adventure Quest', type: 'deck', price: '$0.99', desc: 'Seven structured mini-outings with exact missions and free at-home alternatives.', gradient: 'linear-gradient(135deg, #1e293b, #0f172a)' },
  { id: 'pack-arcade', title: 'Pack 5: The Couples Challenge Arcade', type: 'deck', price: '$0.99', desc: 'Seven quick head-to-head or cooperative challenges with simple scoring and zero special equipment.', gradient: 'linear-gradient(135deg, #581c87, #3b0764)' }
];

const expansionDecks = {}; // Retained expansion content structure

let p1Deck = [], p2Deck = [], p1Likes = [], p2Likes = [];
let swipePlayer = 1, swipeIndex = 0, draftItems = [], draftTurn = 1;
let peer = null, conn = null, remoteRoomId = null, myPlayerNum = 1;
let remoteSubmitSent = false;
let remoteFinalVotes = { host: null, guest: null };
let localFinalVotes = { player1: null, player2: null };
let roomRoundId = null;
let guestRoundId = null;
let pendingCompleteEntry = null;

let finalVotingCandidates = [];
let finalVotingMutual = true;
let currentRoomPeerId = null;
let remotePartnerLikes = null;
let remoteMatchResolved = false;
let p2HeartbeatTimer = null;
let connectionState = 'disconnected';

let isDragging = false, startX = 0, currentX = 0, startTime = 0;
let swipeCardEl = null;
window.currentWinner = null;

const shuffle = array => {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

function createUniqueId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getCardScore(card) {
  let score = 5;
  const matches = dateHistory.filter(h => h.cardId === card.id || (!h.cardId && h.category === card.category));
  const ratings = [];
  matches.forEach(entry => {
    [entry.rating1, entry.rating2].forEach(value => {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1 && n <= 5) ratings.push(n);
    });
  });
  if (ratings.length) {
    const average = ratings.reduce((sum, n) => sum + n, 0) / ratings.length;
    score += (average - 3) * 2;
  }
  return score + Math.random() * 0.5;
}

function refreshDecks() {
  const available = [...masterDeck];
  unlockedItems.forEach(packId => {
    if (expansionDecks[packId]) available.push(...expansionDecks[packId]);
  });
  fullDeck = [...available.filter(item => !deletedBuiltins.has(item.id)), ...customDeck];
  
  const checkboxes = document.querySelectorAll('.category-choice');
  if (checkboxes.length) {
    selectedCategories = [...checkboxes].filter(input => input.checked).map(input => input.value);
  }
  const budgetFilterEl = getEl('budgetFilter');
  const budget = budgetFilterEl ? budgetFilterEl.value : 'all';

  activeDeck = fullDeck.filter(item => {
    const categoryMatches = selectedCategories.includes(item.category);
    const budgetMatches = budget === 'all' || item.budget === budget;
    return categoryMatches && budgetMatches;
  });
  activeDeck.sort((a, b) => getCardScore(b) - getCardScore(a));

  const summary = getEl('categorySummary');
  if (summary) {
    summary.textContent = selectedCategories.length === DEFAULT_CATEGORIES.length
      ? `All categories active (${activeDeck.length}) ▾`
      : `${selectedCategories.length} categories active (${activeDeck.length}) ▾`;
  }
}

async function applyCategoryFilter() {
  selectedCategories = [...document.querySelectorAll('.category-choice:checked')].map(input => input.value);
  if (!useMemoryFallback && db) {
    try { await db.categories.put({ id: 'selectedCats', values: selectedCategories }); }
    catch (err) { console.error('Could not save category filters:', err); }
  }
  refreshDecks();

  if (remoteRoomId && myPlayerNum === 2) {
    if (getEl('card-library')?.classList.contains('active-mode')) renderLibrary();
    return;
  }

  if (remoteRoomId && myPlayerNum === 1) {
    resetRemoteRound();
    sendRoomState();
  } else {
    initMatcher();
    initDraft();
  }
  if (getEl('card-library')?.classList.contains('active-mode')) renderLibrary();
}

function setAllCategories(checked) {
  const picker = getEl('categoryPicker');
  if (picker) picker.open = true;
  document.querySelectorAll('.category-choice').forEach(input => { input.checked = checked; });
  applyCategoryFilter();
  if (picker) picker.open = true;
}

function switchGame(mode, button) {
  const picker = getEl('categoryPicker');
  if (picker) picker.open = false;

  const target = getEl(`card-${mode}`);
  if (!target || !button) return;
  document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('.game-card').forEach(card => card.classList.remove('active-mode'));
  button.classList.add('active');
  target.classList.add('active-mode');
  if (mode === 'matcher') updateSwipeCard();
  if (mode === 'draft') renderDraftGrid();
  if (mode === 'library') renderLibrary();
  if (mode === 'history') renderHistory();
  if (mode === 'store') renderStore();
}

document.addEventListener('click', event => {
  const picker = getEl('categoryPicker');
  if (picker && picker.open && !picker.contains(event.target)) picker.open = false;
});

function currentSwipeDeck() {
  if (remoteRoomId) return myPlayerNum === 1 ? p1Deck : p2Deck;
  return swipePlayer === 1 ? p1Deck : p2Deck;
}

function initMatcher() {
  p1Deck = shuffle(activeDeck);
  p2Deck = [...p1Deck];
  p1Likes = [];
  p2Likes = [];
  swipePlayer = 1;
  swipeIndex = 0;
  remoteSubmitSent = false;
  remotePartnerLikes = null;
  remoteMatchResolved = false;
  updateSwipeCard();
}

function updateConnectionBanner() {
  const statusBanner = getEl('connectionStatusBanner');
  if (!statusBanner) return;
  if (remoteRoomId) {
    statusBanner.style.display = 'block';
    if (conn && conn.open) {
      statusBanner.className = 'connection-status-banner connected';
      statusBanner.textContent = `🟢 Connected to Room "${remoteRoomId}" (Player ${myPlayerNum})`;
    } else {
      statusBanner.className = 'connection-status-banner disconnected';
      statusBanner.textContent = `🔴 ${connectionState === 'waiting' ? 'Waiting for partner to join...' : 'Disconnected from room. Reconnecting...'}`;
    }
  } else {
    statusBanner.style.display = 'none';
  }
}

function updateSwipeCard() {
  const header = getEl('matcherTurnHeader');
  const cardEl = getEl('swipeCard');
  const metaEl = getEl('cardMeta');
  const venueHint = getEl('venueHintBanner');
  if (!header || !cardEl) return;

  updateConnectionBanner();

  const curDeck = currentSwipeDeck();
  if (!curDeck.length) {
    header.textContent = 'No matching date ideas';
    cardEl.style.background = '#1f122e';

    const catEl = getEl('cardCategory');
    if (catEl) catEl.textContent = 'No cards';

    const titleEl = getEl('cardTitle');
    if (titleEl) titleEl.textContent = 'Adjust your filters';

    const detailEl = getEl('cardDetail');
    if (detailEl) {
      if (remoteRoomId && myPlayerNum === 2 && !guestRoundId) {
        detailEl.textContent = 'Waiting for the host to send the shared date deck…';
      } else if (!selectedCategories.length) {
        detailEl.textContent = 'Select at least one category in Filters & Preferences.';
      } else {
        detailEl.textContent = 'No cards match the current category and budget filters. Select more categories or choose Any Budget.';
      }
    }

    if (metaEl) metaEl.replaceChildren();
    if (venueHint) venueHint.style.display = 'none';
    return;
  }

  if (remoteRoomId) {
    header.textContent = `Live Room (${remoteRoomId}) · Player ${myPlayerNum} · Card ${Math.min(swipeIndex + 1, curDeck.length)} of ${curDeck.length}`;
  } else {
    header.textContent = `Player ${swipePlayer}'s Turn · Card ${Math.min(swipeIndex + 1, curDeck.length)} of ${curDeck.length}`;
  }

  if (swipeIndex >= curDeck.length) {
    if (remoteRoomId) {
      if (!conn || !conn.open) {
        header.textContent = 'Live room disconnected · Rejoin or check connection';
      } else if (myPlayerNum === 2) {
        if (!remoteSubmitSent) {
          remoteSubmitSent = sendP2PMessage({
            type: 'SUBMIT_SWIPES',
            likedCards: p2Likes
          });
        }
        header.textContent = 'All cards reviewed · Waiting for match result from Host…';
      } else {
        if (tryResolveRemoteMatch()) return;
        header.textContent = remotePartnerLikes !== null
          ? 'Partner finished · Resolving mutual match…'
          : 'All cards reviewed · Waiting for partner to finish…';
      }

      const catEl = getEl('cardCategory'); if (catEl) catEl.textContent = 'Voting complete';
      const titleEl = getEl('cardTitle'); if (titleEl) titleEl.textContent = 'Waiting for round result';
      const detailEl = getEl('cardDetail'); if (detailEl) detailEl.textContent = myPlayerNum === 1
        ? 'Comparing partner selections and opening final voting round.'
        : 'Your selections have been securely submitted. Waiting for host match resolution.';

      cardEl.style.background = '#1f122e';
      if (metaEl) metaEl.replaceChildren();
      if (venueHint) venueHint.style.display = 'none';
      return;
    }

    if (swipePlayer === 1) {
      swipePlayer = 2;
      swipeIndex = 0;
      showToast("Player 1 complete! Pass the phone to Player 2.");
      updateSwipeCard();
    } else {
      const mutual = p1Likes.filter(a => p2Likes.some(b => b.id === a.id));
      handleMatchOutcome(mutual);
    }
    return;
  }

  const item = curDeck[swipeIndex];
  cardEl.style.background = item.gradient || '#1f122e';
  const catEl = getEl('cardCategory'); if (catEl) catEl.textContent = item.category || 'Date idea';
  const titleEl = getEl('cardTitle'); if (titleEl) titleEl.textContent = item.title || 'Untitled date';
  const detailEl = getEl('cardDetail'); if (detailEl) detailEl.textContent = item.detail || '';
  
  if (metaEl) {
    const locLabel = item.location === 'home'
      ? '🏠 Stay Home'
      : item.location === 'out'
        ? '🚗 Go Out'
        : '🌐 Either';

    const costPill = document.createElement('span');
    costPill.className = 'meta-pill';
    costPill.textContent = `💰 ${item.budget === 'free' ? 'Free' : (item.costEstimate || 'Paid')}`;

    const locationPill = document.createElement('span');
    locationPill.className = 'meta-pill';
    locationPill.textContent = locLabel;

    metaEl.replaceChildren(costPill, locationPill);
  }

  if (venueHint) venueHint.style.display = item.location === 'out' ? 'block' : 'none';
}

function handleSwipe(liked) {
  const curDeck = currentSwipeDeck();

  if (remoteRoomId && (!conn || !conn.open)) {
    showToast('The live-room connection is not ready. Reconnect before swiping.');
    return;
  }
  if (!curDeck.length || swipeIndex >= curDeck.length) return;

  const likes = remoteRoomId
    ? (myPlayerNum === 1 ? p1Likes : p2Likes)
    : (swipePlayer === 1 ? p1Likes : p2Likes);

  playSound('swipe');
  triggerHaptic('light');
  if (liked) likes.push(curDeck[swipeIndex]);
  swipeIndex += 1;
  updateSwipeCard();
}

function installSwipeGestures() {
  swipeCardEl = getEl('swipeCard');
  if (!swipeCardEl) return;
  swipeCardEl.addEventListener('mousedown', dragStart);
  swipeCardEl.addEventListener('touchstart', dragStart, { passive: true });

  function dragStart(event) {
    const deck = currentSwipeDeck();
    if (swipeIndex >= deck.length || (remoteRoomId && (!conn || !conn.open))) return;
    isDragging = true;
    startX = event.type.includes('mouse') ? event.clientX : event.touches[0].clientX;
    currentX = 0;
    startTime = performance.now();
    swipeCardEl.style.transition = 'none';
    window.addEventListener('mousemove', dragMove);
    window.addEventListener('mouseup', dragEnd);
    window.addEventListener('touchmove', dragMove, { passive: true });
    window.addEventListener('touchend', dragEnd);
    window.addEventListener('touchcancel', dragEnd);
  }

  function dragMove(event) {
    if (!isDragging) return;
    const x = event.type.includes('mouse') ? event.clientX : event.touches?.[0]?.clientX;
    if (typeof x !== 'number') return;
    currentX = x - startX;
    swipeCardEl.style.transform = `translateX(${x - startX}px) rotate(${(x - startX) * 0.04}deg)`;
  }

  function dragEnd() {
    if (!isDragging) return;
    isDragging = false;
    window.removeEventListener('mousemove', dragMove);
    window.removeEventListener('mouseup', dragEnd);
    window.removeEventListener('touchmove', dragMove);
    window.removeEventListener('touchend', dragEnd);
    window.removeEventListener('touchcancel', dragEnd);
    swipeCardEl.style.transition = 'transform 0.3s ease, opacity 0.3s ease';

    const elapsed = (performance.now() - startTime) / 1000;
    const velocity = Math.abs(currentX / (elapsed || 0.001));
    const threshold = velocity > 400 ? 40 : 80;
    const wasLike = currentX > threshold;
    const wasPass = currentX < -threshold;
    currentX = 0;

    if (wasLike || wasPass) {
      swipeCardEl.style.transform = `translateX(${wasLike ? 350 : -350}px) rotate(${wasLike ? 25 : -25}deg)`;
      swipeCardEl.style.opacity = '0';
      window.setTimeout(() => {
        handleSwipe(wasLike);
        resetSwipeCard();
      }, 220);
    } else {
      swipeCardEl.style.transform = 'translateX(0) rotate(0)';
    }
  }
}

function resetSwipeCard() {
  if (!swipeCardEl) return;
  swipeCardEl.style.transform = 'translateX(0) rotate(0)';
  swipeCardEl.style.opacity = '1';
}

function handleMatchOutcome(mutual, forcedWinner = null) {
  if (forcedWinner) {
    window.currentWinner = forcedWinner;
    const isMutual = Array.isArray(mutual) && mutual.some(m => m.id === forcedWinner.id);
    showModal(isMutual ? 'It’s a Match!' : 'Date Decided!', forcedWinner.title, forcedWinner.detail);
    return;
  }

  const topMutual = Array.isArray(mutual) ? mutual.slice(0, 3) : [];

  if (topMutual.length > 0) {
    showFinalVotingRound(topMutual, []);
  } else {
    const alternatives = [...activeDeck].sort((a, b) => getCardScore(b) - getCardScore(a)).slice(0, 3);
    showFinalVotingRound([], alternatives);
  }
}

function showFinalVotingRound(mutualMatches, alternativeSuggestions) {
  const modal = getEl('votingModal');
  const container = getEl('votingShortlistContainer');
  const eyebrow = getEl('votingEyebrow');
  const title = getEl('votingModalTitle');
  const detail = getEl('votingModalDetail');

  if (!modal || !container) return;

  container.replaceChildren();

  const hasMutual = mutualMatches.length > 0;

  finalVotingMutual = hasMutual;
  finalVotingCandidates = [
    ...(hasMutual ? mutualMatches : alternativeSuggestions)
  ];

  remoteFinalVotes = { host: null, guest: null };
  localFinalVotes = { player1: null, player2: null };

  if (eyebrow) {
    eyebrow.textContent = hasMutual
      ? 'Final Voting Round'
      : 'No Direct Mutual Matches';
  }

  if (title) {
    title.textContent = hasMutual
      ? 'Shortlisted Mutual Matches'
      : 'Alternative Suggestions';
  }

  if (detail) {
    detail.textContent = remoteRoomId
      ? 'Choose your favorite. The date is confirmed only when both players choose the same idea.'
      : hasMutual
        ? 'You both liked these dates! Vote on your favorite for tonight:'
        : 'You didn’t swipe right on the exact same cards. Choose an alternative you would both enjoy.';
  }

  const shortlist = finalVotingCandidates;

  if (remoteRoomId && myPlayerNum === 1) {
    sendP2PMessage({
      type: 'FINAL_VOTE_START',
      candidateIds: shortlist.map(item => item.id),
      mutual: hasMutual
    });
  }

  shortlist.forEach(item => {
    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'primary-btn secondary-action-btn';
    button.style.cssText =
      'text-align:left;padding:12px;display:flex;flex-direction:column;gap:4px;cursor:pointer;';

    const badge = document.createElement('span');
    badge.style.cssText =
      'font-size:0.68rem;font-weight:900;text-transform:uppercase;color:var(--gold);';
    badge.textContent = hasMutual
      ? '⭐ Mutual Match'
      : '💡 Alternative Suggestion';

    const name = document.createElement('span');
    name.style.cssText =
      'font-size:0.95rem;font-weight:900;color:var(--cream);';
    name.textContent = item.title;

    const description = document.createElement('span');
    description.style.cssText =
      'font-size:0.78rem;color:var(--muted);';
    description.textContent =
      `${item.category} · Estimated cost: ${item.costEstimate || 'Free / Variable'}`;

    button.append(badge, name, description);

    button.addEventListener('click', () => {
      if (remoteRoomId) {
        if (myPlayerNum === 1) {
          remoteFinalVotes.host = item.id;

          container.querySelectorAll('button').forEach(btn => {
            btn.disabled = true;
          });

          const resolved = resolveRemoteFinalVotes();

          if (!resolved) {
            showToast(
              'Your vote is saved. Waiting for your partner to vote.'
            );
          }
        } else {
          const sent = sendP2PMessage({
            type: 'FINAL_VOTE',
            candidateId: item.id
          });

          if (!sent) {
            showToast(
              'Your vote could not be sent. Check the live-room connection.'
            );
            return;
          }

          container.querySelectorAll('button').forEach(btn => {
            btn.disabled = true;
          });

          showToast(
            'Vote sent. Waiting for the host to confirm both votes.'
          );
        }

        return;
      }

      const availableCandidates = [...finalVotingCandidates];
      const wasMutual = finalVotingMutual;

      if (!localFinalVotes.player1) {
        localFinalVotes.player1 = item.id;
        if (detail) {
          detail.textContent = `Player 1 picked “${item.title}”. Pass the phone to Player 2, who should now choose independently.`;
        }
        showToast('Player 1 vote saved. Pass the phone to Player 2.');
        return;
      }

      if (!localFinalVotes.player2) {
        localFinalVotes.player2 = item.id;

        if (localFinalVotes.player1 === localFinalVotes.player2) {
          modal.classList.remove('show');
          window.currentWinner = item;
          showModal('You Both Chose It!', item.title, item.detail);
          return;
        }

        showToast('Your picks were different. Pass the phone back to Player 1 and vote again.');
        showFinalVotingRound(
          wasMutual ? availableCandidates : [],
          wasMutual ? [] : availableCandidates
        );
      }
    });

    container.appendChild(button);
  });

  modal.classList.add('show');
}

function resolveRemoteFinalVotes() {
  if (
    !remoteRoomId ||
    myPlayerNum !== 1 ||
    !remoteFinalVotes.host ||
    !remoteFinalVotes.guest
  ) {
    return false;
  }

  if (remoteFinalVotes.host === remoteFinalVotes.guest) {
    const winner = finalVotingCandidates.find(
      item => item.id === remoteFinalVotes.host
    );

    if (!winner) return false;

    window.currentWinner = winner;

    const votingModal = getEl('votingModal');
    if (votingModal) votingModal.classList.remove('show');

    sendP2PMessage({
      type: 'CHOOSE_WINNER',
      winnerId: winner.id
    });

    showModal('You Both Chose It!', winner.title, winner.detail);
    return true;
  }

  const candidates = [...finalVotingCandidates];
  const wasMutual = finalVotingMutual;

  remoteFinalVotes = { host: null, guest: null };

  showToast('Your votes differed. Please choose again and try to agree.');

  showFinalVotingRound(
    wasMutual ? candidates : [],
    wasMutual ? [] : candidates
  );

  return true;
}

function makeDraftItems() {
  return shuffle(activeDeck).slice(0, Math.min(8, activeDeck.length)).map(item => ({ ...item, banned: false }));
}

function initDraft() {
  draftItems = makeDraftItems();
  draftTurn = 1;
  renderDraftGrid();
}

function renderDraftGrid() {
  const header = getEl('draftTurnHeader');
  if (header) header.textContent = remoteRoomId
    ? `Live Room (${remoteRoomId}) · Player ${draftTurn}'s Turn`
    : `Player ${draftTurn}'s Turn`;

  const grid = getEl('draftGrid');
  if (!grid) return;

  if (!draftItems.length) {
    grid.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'library-summary';
    empty.style.gridColumn = '1 / -1';
    empty.style.textAlign = 'center';
    empty.textContent = 'No ideas available. Select filters above.';
    grid.appendChild(empty);
    return;
  }

  grid.replaceChildren();
  draftItems.forEach((item, index) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `draft-tile${item.banned ? ' banned' : ''}`;
    tile.dataset.cardId = item.id;
    tile.style.background = item.gradient || '#1f122e';
    tile.disabled = Boolean(item.banned);
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = item.title || 'Untitled date';
    const category = document.createElement('div');
    category.className = 'cat';
    category.textContent = item.category || '';
    tile.append(title, category);
    if (!item.banned) {
      tile.addEventListener('click', () => {
        const remainingCount = draftItems.filter(entry => !entry.banned).length;
        if (remainingCount <= 1) {
          window.currentWinner = item;
          showModal('Only Date Available!', item.title, item.detail);
        } else {
          banItem(index);
        }
      });
    }
    grid.appendChild(tile);
  });
}

function executeBan(index) {
  if (!draftItems[index] || draftItems[index].banned) return;
  draftItems[index].banned = true;
  playSound('ban');
  triggerHaptic('heavy');
  const remaining = draftItems.filter(item => !item.banned);
  if (remaining.length > 1) draftTurn = draftTurn === 1 ? 2 : 1;
  renderDraftGrid();

  if (remoteRoomId && myPlayerNum === 1) {
    sendP2PMessage({ type: 'DRAFT_STATE', draftItems, draftTurn });
  }
  if (remaining.length === 1) {
    window.currentWinner = remaining[0];
    showModal('Winner by Elimination!', remaining[0].title, remaining[0].detail);
  }
}

function banItem(index) {
  if (remoteRoomId) {
    if (String(myPlayerNum) !== String(draftTurn)) {
      showToast(`It is currently Player ${draftTurn}'s turn to ban!`);
      return;
    }
    if (myPlayerNum === 2) {
      sendP2PMessage({ type: 'BAN_REQUEST', index });
      return;
    }
  }
  executeBan(index);
}

function surpriseMe() {
  let pool = [...activeDeck];
  const surpriseModeEl = getEl('surpriseMode');
  const mode = surpriseModeEl ? surpriseModeEl.value : 'all';
  if (mode === 'new') {
    pool = pool.filter(item => !dateHistory.some(entry => entry.cardId === item.id || (!entry.cardId && entry.title === item.title)));
  }
  if (!pool.length) {
    window.currentWinner = null;
    showModal('No Matching Dates', 'Try selecting more filters', 'There are no ideas matching your active filters that have not already been completed.');
    return;
  }
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  window.currentWinner = chosen;
  showModal('Your Surprise Date', chosen.title, chosen.detail);
}

function renderLibrary() {
  const librarySearchEl = getEl('librarySearch');
  const libraryCategoryEl = getEl('libraryCategory');
  const query = librarySearchEl ? librarySearchEl.value.trim().toLowerCase() : '';
  const category = libraryCategoryEl ? libraryCategoryEl.value : 'all';
  const list = getEl('libraryList');
  const summary = getEl('librarySummary');
  if (!list) return;
  const items = fullDeck.filter(item =>
    (category === 'all' || item.category === category) &&
    (!query || `${item.title} ${item.detail}`.toLowerCase().includes(query))
  );
  if (summary) summary.textContent = `${fullDeck.length} total ideas · Showing ${items.length}`;
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'library-summary';
    empty.textContent = 'No ideas match your search.';
    list.appendChild(empty);
    return;
  }
  items.forEach(item => {
    const card = document.createElement('article');
    card.className = 'library-item';
    const categoryEl = document.createElement('div');
    categoryEl.className = 'library-category';
    categoryEl.textContent = `${item.category} · Location: ${item.location || 'either'}`;
    const titleEl = document.createElement('div');
    titleEl.className = 'library-title';
    titleEl.textContent = item.title;
    const detailEl = document.createElement('div');
    detailEl.className = 'library-detail';
    detailEl.textContent = item.detail;
    card.append(categoryEl, titleEl, detailEl);
    list.appendChild(card);
  });
}

function renderStore() {
  const grid = getEl('storeGrid');
  const summary = getEl('storeSummary');
  if (!grid) return;
  if (summary) summary.textContent = `${storeCatalog.length} packs available · ${unlockedItems.length} unlocked`;
  grid.replaceChildren();
  storeCatalog.forEach(item => {
    const unlocked = unlockedItems.includes(item.id);
    const card = document.createElement('article');
    card.className = 'library-item store-tile';
    card.style.background = item.gradient || '#1f122e';
    const category = document.createElement('div');
    category.className = 'library-category';
    category.textContent = `DEMO PRICE · ${item.price} · NOT CHARGED`;
    const title = document.createElement('div');
    title.className = 'library-title';
    title.textContent = item.title;
    const detail = document.createElement('div');
    detail.className = 'library-detail';
    detail.textContent = item.desc;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `primary-btn${unlocked ? ' secondary-action-btn' : ''}`;
    button.style.marginTop = '10px';
    button.style.padding = '8px 12px';
    button.style.fontSize = '0.8rem';
    button.textContent = unlocked ? '✅ Demo Unlocked' : `🧪 Demo Unlock · ${item.price}`;
    button.addEventListener('click', () => openStorePreview(item.id));
    card.append(category, title, detail, button);
    grid.appendChild(card);
  });
}

function openStorePreview(itemId) {
  const item = storeCatalog.find(entry => entry.id === itemId);
  if (!item) return;
  selectedPreviewItemId = itemId;
  const storeModalTitle = getEl('storeModalTitle'); if (storeModalTitle) storeModalTitle.textContent = item.title;
  const storeModalDesc = getEl('storeModalDesc'); if (storeModalDesc) storeModalDesc.textContent = item.desc;
  const unlocked = unlockedItems.includes(itemId);
  const actionButton = getEl('storeModalActionBtn');
  if (actionButton) {
    actionButton.textContent = unlocked ? 'Already Demo-Unlocked' : `Demo Unlock · ${item.price} (No Payment)`;
    actionButton.disabled = unlocked;
  }

  const list = getEl('storeModalCardsList');
  if (list) {
    list.replaceChildren();
    (expansionDecks[itemId] || []).forEach(card => {
      const wrapper = document.createElement('div');
      wrapper.style.background = '#1f122e';
      wrapper.style.border = '1px solid var(--border)';
      wrapper.style.borderRadius = '8px';
      wrapper.style.padding = '8px 10px';
      const meta = document.createElement('div');
      meta.style.cssText = 'font-size:0.65rem;color:var(--gold);font-weight:800;text-transform:uppercase;';
      meta.textContent = `${card.category} · ${card.location} · Budget: ${card.budget}`;
      const title = document.createElement('div');
      title.style.cssText = 'font-size:0.85rem;font-weight:900;color:var(--cream);';
      title.textContent = card.title;
      const detail = document.createElement('div');
      detail.style.cssText = 'font-size:0.75rem;color:var(--muted);';
      detail.textContent = card.detail;
      wrapper.append(meta, title, detail);
      list.appendChild(wrapper);
    });
  }
  const previewModal = getEl('storePreviewModal');
  if (previewModal) previewModal.classList.add('show');
}

function closeStorePreview() {
  const previewModal = getEl('storePreviewModal');
  if (previewModal) previewModal.classList.remove('show');
  selectedPreviewItemId = null;
}

async function actionFromPreviewModal() {
  if (!selectedPreviewItemId) return;
  const itemId = selectedPreviewItemId;
  closeStorePreview();
  await handleStoreAction(itemId);
}

async function handleStoreAction(itemId) {
  if (unlockedItems.includes(itemId)) {
    showToast('This pack is already unlocked on this device.');
    return;
  }
  const confirmed = confirm('DEMO ONLY: this unlocks the pack on this device. No payment will be taken. Continue?');
  if (!confirmed) return;
  try {
    unlockedItems.push(itemId);
    if (!useMemoryFallback && db) {
      await db.unlocks.put({ id: itemId });
    }
    triggerHaptic('success');
    refreshDecks();
    initMatcher();
    initDraft();
    renderLibrary();
    renderStore();
    showToast('Demo pack unlocked on this device. No payment was taken.');
  } catch (err) {
    unlockedItems = unlockedItems.filter(id => id !== itemId);
    console.error('Could not save pack unlock:', err);
    showToast('The pack could not be unlocked because local storage failed.');
  }
}

function renderTracker() {
  const label = getEl('dateGoalStatus');
  const bar = getEl('dateGoalBar');
  const progress = getEl('dateGoalProgress');
  if (!bar || !label) return;

  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const count = dateHistory.filter(entry => new Date(entry.date) >= startOfWeek).length;
  const percent = Math.min(100, count * 100);
  label.textContent = `${count} / 1 Done`;
  bar.style.width = `${percent}%`;
  if (progress) progress.setAttribute('aria-valuenow', String(percent));
}

function renderAnalyticsDashboard() {
  const dashboard = getEl('analyticsDashboard');
  if (!dashboard) return;
  dashboard.replaceChildren();
  if (!dateHistory.length) return;
  const ratings = [];
  dateHistory.forEach(entry => [entry.rating1, entry.rating2].forEach(value => {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 1 && n <= 5) ratings.push(n);
  }));
  const average = ratings.length ? (ratings.reduce((sum, n) => sum + n, 0) / ratings.length).toFixed(1) : '—';
  const card = document.createElement('div');
  card.className = 'stats-card';
  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  const completed = document.createElement('div');
  completed.className = 'stat-box';
  completed.innerHTML = `<div class="val">${dateHistory.length}</div><div class="lbl">Completed</div>`;
  const rating = document.createElement('div');
  rating.className = 'stat-box';
  rating.innerHTML = `<div class="val">${escapeHtml(average === '—' ? average : `⭐ ${average}`)}</div><div class="lbl">Average rating</div>`;
  grid.append(completed, rating);
  card.appendChild(grid);
  dashboard.appendChild(card);
}

function renderHistory() {
  renderAnalyticsDashboard();
  renderTracker();
  const list = getEl('historyList');
  const stats = getEl('historyStats');
  if (!list) return;
  if (stats) stats.textContent = `${dateHistory.length} completed dates in scrapbook`;
  list.replaceChildren();
  if (!dateHistory.length) {
    const empty = document.createElement('div');
    empty.className = 'library-summary';
    empty.textContent = 'No dates logged yet. Complete a date to build your scrapbook!';
    list.appendChild(empty);
    return;
  }
  dateHistory.forEach(entry => {
    const row = document.createElement('article');
    row.className = 'library-item';
    const category = document.createElement('div');
    category.className = 'library-category';
    const date = new Date(entry.date);
    category.textContent = `${entry.category || 'Date'} · ${Number.isNaN(date.getTime()) ? 'Date unknown' : date.toLocaleDateString()}`;
    const title = document.createElement('div');
    title.className = 'library-title';
    title.textContent = entry.title || 'Untitled date';
    const detail = document.createElement('div');
    detail.className = 'library-detail';
    const ratingText = entry.rating1 || entry.rating2 ? `Ratings: ${entry.rating1 ?? '—'}/5 & ${entry.rating2 ?? '—'}/5` : '';
    detail.textContent = [entry.note || entry.detail || '', ratingText].filter(Boolean).join(' · ');
    row.append(category, title, detail);
    list.appendChild(row);
  });
}

async function persistHistoryEntry(entry, broadcast = false) {
  const normalized = sanitizeHistoryEntry(entry);
  if (!normalized) return null;

  const syncId = normalized.syncId;
  const existing = dateHistory.find(record => record.syncId === syncId);
  if (existing) return existing;

  let saved = normalized;

  if (!useMemoryFallback && db) {
    try {
      const insertedId = await db.history.add(normalized);
      saved = await db.history.get(insertedId) || normalized;
    } catch (err) {
      console.warn('Could not persist to IndexedDB; keeping this entry in memory:', err);
      useMemoryFallback = true;
    }
  }

  dateHistory = [saved, ...dateHistory.filter(item => item.syncId !== saved.syncId)]
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  renderHistory();

  if (broadcast && remoteRoomId && myPlayerNum === 1) {
    sendP2PMessage({ type: 'HISTORY_ENTRY', entry: saved });
  }

  return saved;
}

async function receiveHistoryEntry(entry) {
  const normalized = sanitizeHistoryEntry(entry);
  if (!normalized) return null;
  if (dateHistory.some(record => record.syncId === normalized.syncId)) return null;
  return persistHistoryEntry(normalized, false);
}

async function applyTheme(theme) {
  appSettings.theme = ['dark', 'ocean'].includes(theme) ? theme : 'dark';
  document.documentElement.dataset.theme = appSettings.theme === 'dark' ? '' : appSettings.theme;
  const select = getEl('themeSelect');
  if (select) select.value = appSettings.theme;
  if (!useMemoryFallback && db) {
    try { await db.settings.put({ key: 'appSettings', value: appSettings }); }
    catch (err) { console.error('Could not save theme:', err); }
  }
}

async function saveFeedbackSettings(value) {
  appSettings.feedback = ['both', 'sound', 'vibration', 'off'].includes(value) ? value : 'both';
  if (!useMemoryFallback && db) {
    try { await db.settings.put({ key: 'appSettings', value: appSettings }); }
    catch (err) { console.error('Could not save feedback preference:', err); }
  }
}

function shareCurrentDate() {
  const item = window.currentWinner;
  if (!item) { showToast('Choose a date idea first.'); return; }
  const text = `💞 Date Night Decider: ${item.title}\n${item.detail}`;
  if (navigator.share) navigator.share({ title: item.title, text }).catch(() => {});
  else window.prompt('Copy this date idea:', text);
}

function openCurrentCardMap() {
  const item = window.currentWinner;

  if (!item) return;

  if (item.location !== 'out') {
    showToast('This is an at-home date; no map is needed. Check the date instructions.');
    return;
  }

  const query = `${item.title} near me`;

  window.open(
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
    '_blank',
    'noopener,noreferrer'
  );
}

function startSelectedDate() {
  const item = window.currentWinner;

  if (!item) return;

  showToast(`Starting date: ${item.title}! Have a wonderful time.`);

  if (item.location === 'out') {
    openCurrentCardMap();
  } else {
    showToast('At-home date selected—no map will be opened.');
  }
}

async function exportBackup() {
  const data = {
    version: '2.9.4',
    customDeck,
    deletedBuiltins: [...deletedBuiltins],
    dateHistory,
    settings: appSettings,
    unlockedItems,
    selectedCategories: [...document.querySelectorAll('.category-choice:checked')].map(input => input.value)
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'date-night-backup.json';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importBackupFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = async () => {
    try {
      const data = JSON.parse(String(reader.result || ''));
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Backup must be a JSON object.');
      }
      if (!data.version || !Array.isArray(data.dateHistory)) {
        throw new Error('Invalid backup file structure.');
      }

      const importedSettings = {
        theme: ['dark', 'ocean'].includes(data.settings?.theme)
          ? data.settings.theme
          : appSettings.theme,
        feedback: ['both', 'sound', 'vibration', 'off'].includes(data.settings?.feedback)
          ? data.settings.feedback
          : appSettings.feedback
      };

      const importedCustomDeck = sanitizeCardDeck(
        Array.isArray(data.customDeck) ? data.customDeck : customDeck
      );

      const importedHistory = data.dateHistory
        .slice(0, 5000)
        .map(sanitizeHistoryEntry)
        .filter(Boolean)
        .sort((a, b) => new Date(b.date) - new Date(a.date));

      const importedUnlocks = [...new Set(
        (Array.isArray(data.unlockedItems) ? data.unlockedItems : unlockedItems)
          .filter(id => typeof id === 'string' && expansionDecks[id])
      )];

      const knownCardIds = new Set([
        ...masterDeck,
        ...Object.values(expansionDecks).flat()
      ].map(card => card.id));

      const importedDeleted = [...new Set(
        (Array.isArray(data.deletedBuiltins) ? data.deletedBuiltins : [...deletedBuiltins])
          .filter(id => typeof id === 'string' && knownCardIds.has(id))
      )];

      const importedCategories = [...new Set(
        (Array.isArray(data.selectedCategories) ? data.selectedCategories : selectedCategories)
          .filter(value => typeof value === 'string' && DEFAULT_CATEGORIES.includes(value))
      )];

      if (!useMemoryFallback && db) {
        await db.transaction(
          'rw',
          db.settings,
          db.customDeck,
          db.deletedBuiltins,
          db.categories,
          db.history,
          db.unlocks,
          async () => {
            await db.settings.clear();
            await db.settings.put({ key: 'appSettings', value: importedSettings });

            await db.customDeck.clear();
            if (importedCustomDeck.length) {
              await db.customDeck.bulkAdd(importedCustomDeck.map(item => ({ item } )));
            }

            await db.deletedBuiltins.clear();
            if (importedDeleted.length) {
              await db.deletedBuiltins.bulkPut(importedDeleted.map(id => ({ id })));
            }

            await db.categories.clear();
            await db.categories.put({ id: 'selectedCats', values: importedCategories });

            await db.history.clear();
            if (importedHistory.length) {
              await db.history.bulkAdd(importedHistory);
            }

            await db.unlocks.clear();
            if (importedUnlocks.length) {
              await db.unlocks.bulkPut(importedUnlocks.map(id => ({ id })));
            }
          }
        );
      }

      appSettings = importedSettings;
      customDeck = importedCustomDeck;
      dateHistory = importedHistory;
      unlockedItems = importedUnlocks;
      deletedBuiltins = new Set(importedDeleted);
      selectedCategories = importedCategories;

      document.querySelectorAll('.category-choice').forEach(input => {
        input.checked = selectedCategories.includes(input.value);
      });

      const budgetFilter = getEl('budgetFilter');
      if (budgetFilter && !['all', 'free', 'paid'].includes(budgetFilter.value)) {
        budgetFilter.value = 'all';
      }

      refreshDecks();
      await applyTheme(appSettings.theme || 'dark');
      initMatcher();
      initDraft();
      renderHistory();
      renderStore();
      renderLibrary();
      showToast('Backup restored successfully.');
    } catch (error) {
      console.error('Backup import failed:', error);
      showToast('Backup was not restored. It may be invalid or storage may be unavailable.');
    } finally {
      event.target.value = '';
    }
  };

  reader.readAsText(file);
}

function triggerConfetti() {
  const canvas = getEl('confettiCanvas');
  if (!canvas) return;
  const context = canvas.getContext('2d');
  if (!context) return;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const particles = Array.from({ length: 50 }, () => ({
    x: width / 2, y: height / 2,
    vx: (Math.random() - 0.5) * 10,
    vy: (Math.random() - 0.5) * 10 - 2,
    color: ['#ff3b6c', '#f6c941', '#ffffff'][Math.floor(Math.random() * 3)],
    size: Math.random() * 5 + 3, life: 80
  }));
  function render() {
    context.clearRect(0, 0, width, height);
    let alive = false;
    particles.forEach(particle => {
      if (particle.life <= 0) return;
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.vy += 0.2;
      particle.life -= 1;
      alive = true;
      context.fillStyle = particle.color;
      context.fillRect(particle.x, particle.y, particle.size, particle.size);
    });
    if (alive) requestAnimationFrame(render);
    else context.clearRect(0, 0, width, height);
  }
  render();
}

function showModal(eyebrow, title, detail) {
  playSound('win');
  triggerHaptic('success');
  triggerConfetti();

  const ebEl = getEl('modalEyebrow'); if (ebEl) ebEl.textContent = eyebrow;
  const nameEl = getEl('modalIdeaName'); if (nameEl) nameEl.textContent = title || 'Date Idea';

  const winner = window.currentWinner;
  const detailEl = getEl('modalIdeaDetail');
  if (!detailEl) return;

  if (winner && (winner.mission || winner.howToPlay)) {
    let html = `<p style="margin-bottom:12px;font-weight:600;color:var(--cream);">${escapeHtml(winner.mission || detail)}</p>`;

    if (winner.duration || winner.costEstimate || winner.equipment) {
      html += `<div style="background:rgba(255,255,255,0.05);padding:10px;border-radius:10px;margin-bottom:12px;text-align:left;font-size:0.78rem;">`;
      if (winner.duration) html += `<div>⏱ <strong>Duration:</strong> ${escapeHtml(winner.duration)}</div>`;
      if (winner.costEstimate) html += `<div>💵 <strong>Estimated Cost:</strong> ${escapeHtml(winner.costEstimate)}</div>`;
      if (winner.equipment) html += `<div>🧰 <strong>Needs:</strong> ${escapeHtml(Array.isArray(winner.equipment) ? winner.equipment.join(', ') : winner.equipment)}</div>`;
      html += `</div>`;
    }

    if (Array.isArray(winner.howToPlay) && winner.howToPlay.length) {
      html += `<div style="text-align:left;margin-bottom:12px;"><strong style="color:var(--gold);font-size:0.8rem;text-transform:uppercase;">🎮 Instructions</strong><ol style="margin-left:18px;font-size:0.78rem;color:var(--muted);margin-top:4px;">`;
      winner.howToPlay.forEach(step => { html += `<li>${escapeHtml(step)}</li>`; });
      html += `</ol></div>`;
    }

    if (winner.importantRule) {
      html += `<div style="text-align:left;font-size:0.75rem;color:#f87171;"><strong style="color:#ef4444;">❤️ Important Rule:</strong> ${escapeHtml(winner.importantRule)}</div>`;
    }

    detailEl.innerHTML = html;
  } else {
    detailEl.textContent = detail || '';
  }

  const mapButton = getEl('mapDirectionsBtn');
  if (mapButton) mapButton.style.display = winner && winner.location === 'out' ? 'block' : 'none';

  const completeButton = getEl('completeDateBtn');
  if (completeButton) completeButton.disabled = !winner;

  const decisionModal = getEl('decisionModal');
  if (decisionModal) decisionModal.classList.add('show');
}

function resetRemoteRound() {
  roomRoundId = createUniqueId();
  p1Deck = shuffle(activeDeck);
  p2Deck = [...p1Deck];
  p1Likes = [];
  p2Likes = [];
  swipeIndex = 0;
  swipePlayer = 1;
  remoteSubmitSent = false;
  remotePartnerLikes = null;
  remoteMatchResolved = false;
  remoteFinalVotes = { host: null, guest: null };
  window.currentWinner = null;
  draftItems = makeDraftItems();
  draftTurn = 1;
  updateSwipeCard();
  renderDraftGrid();
}

function closeModal() {
  const decisionModal = getEl('decisionModal');
  if (decisionModal) decisionModal.classList.remove('show');
  if (remoteRoomId) {
    if (myPlayerNum === 1) {
      window.currentWinner = null;
      resetRemoteRound();
      sendRoomState();
      if (conn && conn.open) {
        sendP2PMessage({ type: 'NEW_ROUND' });
      }
    }
  } else {
    initMatcher();
    initDraft();
  }
}

function validRating(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

async function completeCurrentDate() {
  const item = window.currentWinner;
  if (!item) { closeModal(); return; }

  const first = prompt('Player 1 rating (1–5):', '5');
  if (first === null) return;
  const rating1 = validRating(first);
  if (rating1 === null) {
    showToast('Enter a whole-number rating from 1 to 5.');
    return;
  }

  const second = prompt('Player 2 rating (1–5):', '5');
  if (second === null) return;
  const rating2 = validRating(second);
  if (rating2 === null) {
    showToast('Enter a whole-number rating from 1 to 5.');
    return;
  }

  const note = prompt('Add a memory note (optional):', '') || '';
  const entry = sanitizeHistoryEntry({
    syncId: createUniqueId(),
    cardId: item.id || null,
    title: item.title || 'Untitled date',
    category: item.category || 'Date',
    detail: item.detail || '',
    date: new Date().toISOString(),
    rating1,
    rating2,
    note
  });

  if (!entry) {
    showToast('This date entry could not be validated.');
    return;
  }

  try {
    if (remoteRoomId && myPlayerNum === 2) {
      if (!conn || !conn.open) {
        await persistHistoryEntry(entry, false);
        closeModal();
        showToast('Connection unavailable. The completion was saved on this device only.');
        return;
      }

      pendingCompleteEntry = entry;
      const sent = sendP2PMessage({ type: 'COMPLETE_DATE_REQUEST', entry });
      if (!sent) {
        pendingCompleteEntry = null;
        await persistHistoryEntry(entry, false);
        closeModal();
        showToast('The host could not be reached. The completion was saved on this device only.');
        return;
      }

      const completeButton = getEl('completeDateBtn');
      if (completeButton) completeButton.disabled = true;
      showToast('Waiting for the host to confirm the date was saved…');
      return;
    }

    await persistHistoryEntry(entry, true);
    closeModal();
  } catch (error) {
    console.error('Could not save completed date:', error);
    showToast('The date could not be saved. Please try again.');
  }
}

function downloadCalendarEvent() {
  const item = window.currentWinner;
  if (!item) { showToast('Choose a date idea first.'); return; }
  
  const today = new Date();
  const defaultDateStr =
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const userDate = prompt(
    'Enter preferred date for your date night (YYYY-MM-DD):',
    defaultDateStr
  );

  if (!userDate) return;

  const userTime = prompt(
    'Enter preferred start time (HH:MM in 24-hour format, e.g., 19:00):',
    '19:00'
  );

  if (!userTime) return;

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(userDate);
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(userTime);

  if (!dateMatch || !timeMatch) {
    showToast('Invalid date or time format entered. Please use YYYY-MM-DD and HH:MM.');
    return;
  }

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);

  const start = new Date(year, month - 1, day, hour, minute, 0, 0);

  if (
    start.getFullYear() !== year ||
    start.getMonth() !== month - 1 ||
    start.getDate() !== day ||
    start.getHours() !== hour ||
    start.getMinutes() !== minute
  ) {
    showToast('That date or time does not exist. Check the day, month, and time.');
    return;
  }
  
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const formatUtc = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const icsEscape = value => String(value || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Date Night Decider//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${createUniqueId()}@datenightdecider`, `DTSTAMP:${formatUtc(new Date())}`,
    `SUMMARY:${icsEscape(`Date: ${item.title}`)}`, `DESCRIPTION:${icsEscape(item.detail)}`,
    `DTSTART:${formatUtc(start)}`, `DTEND:${formatUtc(end)}`, 'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
  
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'date-night.ics';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Calendar event downloaded successfully!');
}

function normalizeRoomCode(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
}

function generateRoomCode() {
  try {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return createUniqueId().replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 32);
  }
}

function roomPeerId(code) {
  return `datenight-${code}`;
}

function copyInviteLink() {
  if (!remoteRoomId || myPlayerNum !== 1 || !peer || !peer.open) {
    showToast('Start a live room and wait until the room is ready before copying its invite link.');
    return;
  }

  const invite = new URL(window.location.pathname, window.location.origin);
  invite.searchParams.set('room', remoteRoomId);
  const link = invite.href;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link)
      .then(() => showToast('Invite link copied to clipboard!'))
      .catch(() => window.prompt('Copy invite link:', link));
  } else {
    window.prompt('Copy invite link:', link);
  }
}

function startP2PServer(presetCode = null) {
  const suggestedCode = generateRoomCode();
  const raw = presetCode || prompt('Create a private room code. A random code is suggested; keep it private.', suggestedCode);
  if (!raw) return;
  const code = normalizeRoomCode(raw);
  if (code.length < 12) {
    showToast('Use a room code at least 12 characters long.');
    return;
  }

  if (typeof window.Peer !== 'function') { showToast('PeerJS did not load. Check your connection and reload.'); return; }
  cleanupPeerConnection();
  remoteRoomId = code;
  myPlayerNum = 1;
  currentRoomPeerId = roomPeerId(code);
  connectionState = 'creating';
  resetRemoteRound();
  try {
    peer = new Peer(currentRoomPeerId, PEER_OPTIONS);

    peer.on('disconnected', () => {
      connectionState = 'disconnected';
      console.warn('Host disconnected from server; attempting reconnect...');
      try { peer.reconnect(); } catch (err) { console.error('Host peer reconnect failed:', err); }
    });

    peer.on('open', () => {
      connectionState = 'waiting';
      showToast(`Room “${code}” is ready as Player 1. Share your invite link!`);
      updateConnectionBanner();
    });
    
    peer.on('connection', incoming => {
      if (conn && conn.open) {
        incoming.close();
        showToast('A partner is already connected to this room.');
        return;
      }
      connectionState = 'connecting';
      conn = incoming;
      setupConnectionHandlers(conn);
      conn.on('open', () => {
        connectionState = 'connected';
        sendRoomState();
        startHeartbeat();
        showToast('Partner connected. The live room is synchronized.');
        updateSwipeCard();
      });
    });

    peer.on('error', error => {
      connectionState = 'disconnected';
      console.error('PeerJS host error:', error);
      if (error.type === 'network' || error.type === 'socket-closed') {
        try { peer.reconnect(); } catch (_) {}
      } else if (error.type === 'unavailable-id') {
        showToast('That room code is already in use. Choose a different code.');
      } else {
        showToast(`Room error: ${error.type || 'Connection failed'}`);
      }
      updateConnectionBanner();
    });
  } catch (error) {
    connectionState = 'disconnected';
    console.error('Could not create PeerJS host:', error);
    cleanupPeerConnection();
    showToast('Could not start live room.');
  }
}

function joinP2PServer(presetCode = null) {
  const raw = presetCode || prompt('Enter the couple room code shared by the host:');
  if (!raw) return;
  const code = normalizeRoomCode(raw);
  if (code.length < 12) {
    showToast('Enter a room code at least 12 characters long.');
    return;
  }

  if (typeof window.Peer !== 'function') { showToast('PeerJS did not load. Check your connection and reload.'); return; }
  cleanupPeerConnection();
  remoteRoomId = code;
  myPlayerNum = 2;
  currentRoomPeerId = roomPeerId(code);
  connectionState = 'connecting';
  try {
    peer = new Peer(PEER_OPTIONS);

    peer.on('disconnected', () => {
      connectionState = 'disconnected';
      console.warn('Guest disconnected from server; attempting reconnect...');
      try { peer.reconnect(); } catch (err) { console.error('Guest peer reconnect failed:', err); }
    });

    peer.on('open', () => {
      conn = peer.connect(currentRoomPeerId, { reliable: true });
      setupConnectionHandlers(conn);
      conn.on('open', () => {
        connectionState = 'connected';
        showToast(`Connected to room “${code}” as Player 2. Waiting for host's shared deck…`);
        startHeartbeat();
        updateSwipeCard();
      });
    });

    peer.on('error', error => {
      connectionState = 'disconnected';
      console.error('PeerJS guest error:', error);
      if (error.type === 'network' || error.type === 'socket-closed') {
        try { peer.reconnect(); } catch (_) {}
      } else {
        showToast(`Join error: ${error.type || 'Could not connect'}`);
      }
      updateConnectionBanner();
    });
  } catch (error) {
    connectionState = 'disconnected';
    console.error('Could not join PeerJS room:', error);
    cleanupPeerConnection();
    showToast('Could not join live room.');
  }
}

function startHeartbeat() {
  if (p2HeartbeatTimer) window.clearInterval(p2HeartbeatTimer);
  p2HeartbeatTimer = window.setInterval(() => {
    if (conn && conn.open) {
      sendP2PMessage({ type: 'PING', timestamp: Date.now() });
    }
  }, 10000);
}

function leaveLiveRoom() {
  if (!remoteRoomId) {
    showToast('You are not currently in a live room.');
    return;
  }
  const confirmed = confirm('Leave live room and return to local play?');
  if (!confirmed) return;
  cleanupPeerConnection();
  refreshDecks();
  initMatcher();
  initDraft();
  showToast('Returned to local play mode.');
}

function cleanupPeerConnection() {
  if (p2HeartbeatTimer) {
    window.clearInterval(p2HeartbeatTimer);
    p2HeartbeatTimer = null;
  }
  try { if (conn) conn.close(); } catch (_) {}
  try { if (peer) peer.destroy(); } catch (_) {}
  conn = null;
  peer = null;
  remoteRoomId = null;
  currentRoomPeerId = null;
  myPlayerNum = 1;
  remoteSubmitSent = false;
  remotePartnerLikes = null;
  remoteMatchResolved = false;
  connectionState = 'disconnected';
  roomRoundId = null;
  guestRoundId = null;
  pendingCompleteEntry = null;

  const completeButton = getEl('completeDateBtn');
  if (completeButton) completeButton.disabled = !window.currentWinner;

  updateSwipeCard();
}

function sendP2PMessage(payload) {
  if (!conn || !conn.open) return false;
  try { conn.send(payload); return true; }
  catch (error) { console.error('Could not send live-room message:', error); return false; }
}

function sendRoomState() {
  if (!remoteRoomId || myPlayerNum !== 1 || !conn || !conn.open) return;

  const budgetFilterEl = getEl('budgetFilter');
  sendP2PMessage({
    type: 'SYNC_STATE',
    roundId: roomRoundId,
    matcherDeck: p1Deck,
    draftItems,
    draftTurn,
    hostFilters: {
      categories: [...document.querySelectorAll('.category-choice:checked')].map(input => input.value),
      budget: budgetFilterEl ? budgetFilterEl.value : 'all'
    }
  });
}

function tryResolveRemoteMatch() {
  if (!remoteRoomId || myPlayerNum !== 1) return false;
  if (remoteMatchResolved) return false;
  if (!Array.isArray(remotePartnerLikes)) return false;
  if (swipeIndex < p1Deck.length) return false;

  const partnerLikeIds = new Set(remotePartnerLikes.filter(item => item && item.id).map(item => item.id));
  const mutual = p1Likes.filter(item => partnerLikeIds.has(item.id));

  remoteMatchResolved = true;
  handleMatchOutcome(mutual, null);
  return true;
}

function setupConnectionHandlers(thisConn) {
  if (!thisConn) return;

  thisConn.on('data', message => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'PING') return;

    if (message.type === 'SYNC_STATE' && myPlayerNum === 2) {
      if (!Array.isArray(message.matcherDeck)) return;

      const sharedDeck = sanitizeCardDeck(message.matcherDeck);
      const incomingRoundId = typeof message.roundId === 'string'
        ? message.roundId.slice(0, 120)
        : 'legacy-room-round';
      const isNewRound = incomingRoundId !== guestRoundId;

      p1Deck = [...sharedDeck];
      p2Deck = [...sharedDeck];

      if (isNewRound) {
        guestRoundId = incomingRoundId;
        p1Likes = [];
        p2Likes = [];
        swipeIndex = 0;
        swipePlayer = 1;
        remoteSubmitSent = false;
        remotePartnerLikes = null;
        remoteMatchResolved = false;
        remoteFinalVotes = { host: null, guest: null };
        localFinalVotes = { player1: null, player2: null };
        window.currentWinner = null;

        const decisionModal = getEl('decisionModal');
        const votingModal = getEl('votingModal');
        if (decisionModal) decisionModal.classList.remove('show');
        if (votingModal) votingModal.classList.remove('show');
      }

      if (message.hostFilters && typeof message.hostFilters === 'object') {
        const hostFilters = message.hostFilters;
        if (Array.isArray(hostFilters.categories)) {
          const categorySet = new Set(
            hostFilters.categories.filter(value => DEFAULT_CATEGORIES.includes(value))
          );
          document.querySelectorAll('.category-choice').forEach(input => {
            input.checked = categorySet.has(input.value);
          });
        }
        if (['all', 'free', 'paid'].includes(hostFilters.budget)) {
          const budgetEl = getEl('budgetFilter');
          if (budgetEl) budgetEl.value = hostFilters.budget;
        }
      }

      draftItems = sanitizeCardDeck(message.draftItems).map(item => ({
        ...item,
        banned: item.banned === true
      }));
      draftTurn = Number(message.draftTurn) === 2 ? 2 : 1;

      updateSwipeCard();
      renderDraftGrid();
      return;
    }

    if (message.type === 'NEW_ROUND' && myPlayerNum === 2) {
      const decisionModal = getEl('decisionModal');
      const votingModal = getEl('votingModal');
      if (decisionModal) decisionModal.classList.remove('show');
      if (votingModal) votingModal.classList.remove('show');
      window.currentWinner = null;
      remoteSubmitSent = false;
      return;
    }

    if (message.type === 'SUBMIT_SWIPES' && myPlayerNum === 1) {
      remotePartnerLikes = sanitizeCardDeck(message.likedCards);
      tryResolveRemoteMatch();
      updateSwipeCard();
      return;
    }

    if (message.type === 'CHOOSE_WINNER' && myPlayerNum === 2) {
      const winnerId = message.winnerId;
      const winner = p2Deck.find(d => d.id === winnerId);
      if (winner) {
        window.currentWinner = winner;
        const votingModal = getEl('votingModal');
        if (votingModal) votingModal.classList.remove('show');
        showModal('It’s a Match!', winner.title, winner.detail);
      }
      return;
    }

    if (message.type === 'FINAL_VOTE_START' && myPlayerNum === 2) {
      const ids = Array.isArray(message.candidateIds)
        ? message.candidateIds
        : [];

      const candidates = ids
        .filter(id => typeof id === 'string')
        .map(id => p2Deck.find(item => item.id === id))
        .filter(Boolean);

      if (candidates.length) {
        showFinalVotingRound(
          message.mutual ? candidates : [],
          message.mutual ? [] : candidates
        );
      }

      return;
    }

    if (message.type === 'FINAL_VOTE' && myPlayerNum === 1) {
      const candidateId = message.candidateId;

      if (
        finalVotingCandidates.some(
          item => item.id === candidateId
        )
      ) {
        remoteFinalVotes.guest = candidateId;
        resolveRemoteFinalVotes();
      }

      return;
    }

    if (message.type === 'BAN_REQUEST' && myPlayerNum === 1) {
      if (draftTurn === 2 && Number.isInteger(message.index)) executeBan(message.index);
      return;
    }

    if (message.type === 'DRAFT_STATE' && myPlayerNum === 2) {
      draftItems = sanitizeCardDeck(message.draftItems).map(item => ({
        ...item,
        banned: item.banned === true
      }));
      draftTurn = Number(message.draftTurn) === 2 ? 2 : 1;
      renderDraftGrid();
      const remaining = draftItems.filter(item => !item.banned);
      if (remaining.length === 1) {
        window.currentWinner = remaining[0];
        showModal('Winner by Elimination!', remaining[0].title, remaining[0].detail);
      }
      return;
    }

    if (message.type === 'COMPLETE_DATE_REQUEST' && myPlayerNum === 1) {
      const incomingEntry = sanitizeHistoryEntry(message.entry);
      if (!incomingEntry) {
        sendP2PMessage({
          type: 'COMPLETE_DATE_ACK',
          syncId: limitText(message.entry?.syncId, 120),
          ok: false
        });
        return;
      }

      const alreadySaved = dateHistory.some(record => record.syncId === incomingEntry.syncId);
      if (alreadySaved) {
        sendP2PMessage({ type: 'COMPLETE_DATE_ACK', syncId: incomingEntry.syncId, ok: true });
        return;
      }

      persistHistoryEntry(incomingEntry, true)
        .then(saved => {
          const ok = Boolean(saved);
          sendP2PMessage({ type: 'COMPLETE_DATE_ACK', syncId: incomingEntry.syncId, ok });
          if (ok) closeModal();
        })
        .catch(error => {
          console.error('Could not save partner-completed date:', error);
          sendP2PMessage({ type: 'COMPLETE_DATE_ACK', syncId: incomingEntry.syncId, ok: false });
        });

      return;
    }

    if (message.type === 'COMPLETE_DATE_ACK' && myPlayerNum === 2) {
      if (!pendingCompleteEntry || message.syncId !== pendingCompleteEntry.syncId) return;

      const entry = pendingCompleteEntry;
      pendingCompleteEntry = null;

      const completeButton = getEl('completeDateBtn');
      if (completeButton) completeButton.disabled = !window.currentWinner;

      if (message.ok === true) {
        persistHistoryEntry(entry, false)
          .then(() => {
            closeModal();
            showToast('Date completion confirmed and saved.');
          })
          .catch(error => {
            console.error('Could not save the confirmed date locally:', error);
            showToast('The host saved the completion, but this device could not save its copy.');
          });
      } else {
        showToast('The host could not confirm the save. Check the connection and try again.');
      }

      return;
    }

    if (message.type === 'HISTORY_ENTRY' && myPlayerNum === 2 && message.entry) {
      receiveHistoryEntry(message.entry).catch(error => console.error('Could not receive history entry:', error));
    }
  });

  thisConn.on('open', () => {
    conn = thisConn;
    connectionState = 'connected';
    if (myPlayerNum === 2 && pendingCompleteEntry) {
      sendP2PMessage({ type: 'COMPLETE_DATE_REQUEST', entry: pendingCompleteEntry });
    }
    updateSwipeCard();
  });

  thisConn.on('close', () => {
    if (thisConn !== conn) return;
    console.warn('DataConnection closed.');
    conn = null;
    connectionState = 'disconnected';
    remoteSubmitSent = false;
    updateSwipeCard();

    if (remoteRoomId && myPlayerNum === 2) {
      showToast('Connection lost. Reconnecting to host...');
      window.setTimeout(() => {
        if (!remoteRoomId || myPlayerNum !== 2) return;
        if (peer && !peer.destroyed) {
          const newConn = peer.connect(currentRoomPeerId, { reliable: true });
          setupConnectionHandlers(newConn);
          newConn.on('open', () => {
            connectionState = 'connected';
            showToast('Reconnected to live room host!');
            startHeartbeat();
          });
        }
      }, 3000);
    }
  });

  thisConn.on('error', error => {
    connectionState = 'disconnected';
    console.error('Live-room data connection error:', error);
  });
}

async function loadAppData() {
  try {
    if (!useMemoryFallback && db) {
      const settingsRecord = await db.settings.get('appSettings');
      if (settingsRecord?.value && typeof settingsRecord.value === 'object') {
        appSettings = {
          theme: ['dark', 'ocean'].includes(settingsRecord.value.theme) ? settingsRecord.value.theme : 'dark',
          feedback: ['both', 'sound', 'vibration', 'off'].includes(settingsRecord.value.feedback) ? settingsRecord.value.feedback : 'both'
        };
      }

      const customRecords = await db.customDeck.toArray();
      customDeck = sanitizeCardDeck(customRecords.map(record => record.item));
      const deletedRecords = await db.deletedBuiltins.toArray();
      deletedBuiltins = new Set(deletedRecords.map(record => record.id));
      dateHistory = (await db.history.orderBy('date').reverse().toArray())
        .map(sanitizeHistoryEntry)
        .filter(Boolean);
      const unlockRecords = await db.unlocks.toArray();
      unlockedItems = unlockRecords.map(record => record.id).filter(id => expansionDecks[id]);

      const categoryRecord = await db.categories.get('selectedCats');
      selectedCategories = Array.isArray(categoryRecord?.values)
        ? categoryRecord.values.filter(value => DEFAULT_CATEGORIES.includes(value))
        : [...DEFAULT_CATEGORIES];
    }
  } catch (error) {
    console.warn('Some saved data could not be loaded from IndexedDB; using defaults:', error);
  }

  document.querySelectorAll('.category-choice').forEach(input => {
    input.checked = selectedCategories.includes(input.value);
  });
  const feedbackSelect = getEl('feedbackSelect');
  if (feedbackSelect) feedbackSelect.value = appSettings.feedback;
  refreshDecks();
  initMatcher();
  initDraft();
  renderLibrary();
  renderHistory();
  renderStore();
  await applyTheme(appSettings.theme || 'dark');

  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam) {
    window.setTimeout(() => {
      const code = normalizeRoomCode(roomParam);
      if (code) {
        joinP2PServer(code);
      }
    }, 500);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  installSwipeGestures();

  const swipeCard = getEl('swipeCard');
  swipeCard?.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      handleSwipe(false);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      handleSwipe(true);
    }
  });

  const categoryPicker = getEl('categoryPicker');
  const categorySummary = getEl('categorySummary');
  if (categoryPicker && categorySummary) {
    const syncExpandedState = () => {
      categorySummary.setAttribute('aria-expanded', String(categoryPicker.open));
    };
    categoryPicker.addEventListener('toggle', syncExpandedState);
    syncExpandedState();
  }

  loadAppData().catch(error => {
    console.error('App initialization failed:', error);
  });
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(error => console.warn('Service worker registration failed:', error));
  });
}
