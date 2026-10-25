'use strict';

/* Date Night Decider — version 2.9.0 with Production Audit & Checklist Updates:
   - Top-three mutual match shortlisting and final voting round.
   - Polished win animation, estimated cost, instructions, and Start Date action.
   - Shareable link (?room=CODE) with clipboard copying and auto-join.
   - Robust connection states (creating, waiting, connecting, connected, disconnected) and automatic reconnection.
   - Service worker precaching and robust backup validation. */

const getEl = id => document.getElementById(id);

if (typeof Dexie === 'undefined') {
  document.body.insertAdjacentHTML('afterbegin', '<div style="padding:16px;background:#5b1730;color:white;font:16px sans-serif">Date Night Decider could not load its local database library. Check your connection or cache settings and reload.</div>');
  throw new Error('Dexie.js failed to load.');
}

let db = null;
let useMemoryFallback = false;
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
  console.warn('IndexedDB unavailable, falling back to memory state:', err);
  useMemoryFallback = true;
}

const DEFAULT_CATEGORIES = [
  'baking', 'cooking', 'gaming', 'board games', 'tv', 'movie',
  'micro-adventure', 'quest', 'arcade'
];
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

const expansionDecks = {
  'pack-viral': [
    {
      id: 'viral-01', title: 'Store Aisle Roulette', category: 'micro-adventure', budget: 'free', location: 'out', duration: '20–30 min',
      costEstimate: '$0; optional spending cap of $5', equipment: ['Store or household items', 'Phone timer (optional)'],
      mission: 'Find unexpected items matching specific prompts, then explain your choices. Focus on understanding your partner.',
      howToPlay: ['Decide who goes first.', 'Read one prompt at a time.', '45 seconds to find an item.', 'Reveal together and explain in 30s.', 'Score points across six rounds.'],
      atHomeAlternative: 'Use pantry items, refrigerator contents, books, clothing, or other household objects.',
      importantRule: 'No purchases required. Do not open products or disrupt shoppers. Spending cap is $5 combined.',
      detail: 'A retail or pantry scavenger hunt where understanding your partner yields the highest score.',
      gradient: 'linear-gradient(135deg, #31103f, #190a24)'
    },
    {
      id: 'viral-02', title: 'Trunk-Side Studio', category: 'micro-adventure', budget: 'free', location: 'out', duration: '30–45 min',
      costEstimate: '$0–15', equipment: ['Paper', 'Pens or markers', 'Flat surface'],
      mission: 'Turn a safe, comfortable spot into a tiny outdoor art studio and create a mini gallery for each other.',
      howToPlay: ['Pick a safe location.', 'Set up stable surface.', 'Both players create drawings.', 'Present creations with a title.'],
      atHomeAlternative: 'Set up beside a window or on the kitchen table.',
      importantRule: 'Focus on expression over skill.',
      detail: 'Create a pop-up art gallery using playful prompts and hilarious artist statements.',
      gradient: 'linear-gradient(135deg, #38103f, #230a24)'
    }
  ],
  'pack-coop': [
    {
      id: 'coop-01', title: 'The 20-Minute Build-Off', category: 'gaming', budget: 'free', location: 'home', duration: '25–35 min',
      costEstimate: 'Free (using owned games)', equipment: ['Sandbox/Building video game or paper/pencils'],
      mission: 'Create sandbox structures based on a shared theme within a 20-minute timer.',
      howToPlay: ['Select build theme.', 'Gather resources for 2 minutes.', 'Build for 20 minutes.', 'Give a tour and explain 3 favorite features.'],
      atHomeAlternative: 'Draw top-down floor plans on grid paper and label key features.',
      importantRule: 'Use games already owned. No new purchases required.',
      detail: 'A timed creative building competition in video games or on paper.',
      gradient: 'linear-gradient(135deg, #064e3b, #022c22)'
    }
  ],
  'pack-sweet': [
    {
      id: 'sweet-01', title: 'Guided Baking Challenge', category: 'baking', budget: 'paid', location: 'home', duration: '45–75 min',
      costEstimate: '$5–15', equipment: ['Mixing bowl', 'Baking tray', 'Cookie ingredients'],
      mission: 'Bake chocolate-chip cookies with one partner acting as Reader and the other as Lead.',
      howToPlay: ['Assign Recipe Reader & Mixing Lead.', 'Reader checks equipment; Lead measures ingredients.', 'Bake at 350°F (175°C) for 9-11 mins.'],
      atHomeAlternative: 'Use store-bought cookie dough or boxed mix for easy decorating.',
      importantRule: 'Check dietary restrictions. Never consume raw dough.',
      detail: 'A co-op baking session complete with official bakery naming and team awards.',
      gradient: 'linear-gradient(135deg, #4a1525, #831843)'
    }
  ],
  'pack-quest': [
    {
      id: 'quest-01', title: 'Bookstore Blind Pick', category: 'quest', budget: 'free', location: 'out', duration: '30–45 min',
      costEstimate: '$0–15', equipment: ['Access to bookstore, library, or home bookshelf'],
      mission: 'Select a secret book for your partner using genre and mood clues instead of covers.',
      howToPlay: ['Set spending budget ($0 default).', 'Privately pick book candidate.', 'Describe book using prompt clues.'],
      atHomeAlternative: 'Use home bookshelves, e-books, or online library catalogs.',
      importantRule: 'Never mark/damage books. Purchasing is optional.',
      detail: 'Browse a bookstore or library to select hidden mystery reads for each other.',
      gradient: 'linear-gradient(135deg, #1e293b, #0f172a)'
    }
  ],
  'pack-arcade': [
    {
      id: 'arcade-01', title: 'Blind Portrait Battle', category: 'arcade', budget: 'free', location: 'home', duration: '10–20 min',
      costEstimate: 'Free', equipment: ['Paper', 'Pens/Pencils'],
      mission: 'Draw portraits of each other without looking down at the paper page while drawing.',
      howToPlay: ['Sit facing each other.', 'Look exclusively at partner face.', 'Set 60-second timer.', 'Draw portrait without glancing down.'],
      atHomeAlternative: 'Draw in the air with fingers or use digital touchscreen apps.',
      importantRule: 'Keep drawings affectionate. Never criticize partner appearance.',
      detail: 'Draw blind contour portraits of each other without looking at the paper.',
      gradient: 'linear-gradient(135deg, #581c87, #3b0764)'
    }
  ]
};

let p1Deck = [], p2Deck = [], p1Likes = [], p2Likes = [];
let swipePlayer = 1, swipeIndex = 0, draftItems = [], draftTurn = 1;
let peer = null, conn = null, remoteRoomId = null, myPlayerNum = 1;
let remoteSubmitSent = false;
let currentRoomPeerId = null;
let remotePartnerLikes = null;
let remoteMatchResolved = false;
let p2HeartbeatTimer = null;
let connectionState = 'disconnected'; // 'creating', 'waiting', 'connecting', 'connected', 'disconnected'

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

/* MATCHER */
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
    header.textContent = 'No ideas available';
    cardEl.style.background = '#1f122e';
    const catEl = getEl('cardCategory'); if (catEl) catEl.textContent = 'Empty';
    const titleEl = getEl('cardTitle'); if (titleEl) titleEl.textContent = 'Select filters above';
    const detailEl = getEl('cardDetail'); if (detailEl) detailEl.textContent = 'Choose at least one category and matching filter to view date ideas.';
    if (metaEl) metaEl.innerHTML = '';
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
      if (metaEl) metaEl.innerHTML = '';
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
    const locLabel = item.location === 'home' ? '🏠 Stay Home' : item.location === 'out' ? '🚗 Go Out' : '🌐 Either';
    metaEl.innerHTML = `<span class="meta-pill">💰 ${item.budget === 'free' ? 'Free' : (item.costEstimate || 'Paid')}</span><span class="meta-pill">${locLabel}</span>`;
  }
  if (venueHint) venueHint.style.display = item.location === 'out' ? 'block' : 'none';
}

function handleSwipe(liked) {
  const curDeck = currentSwipeDeck();
  if (swipeIndex >= curDeck.length) return;
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

/* FINAL VOTING ROUND & MATCH SHORTLISTING */
function handleMatchOutcome(mutual, forcedWinner = null) {
  if (forcedWinner) {
    window.currentWinner = forcedWinner;
    const isMutual = Array.isArray(mutual) && mutual.some(m => m.id === forcedWinner.id);
    showModal(isMutual ? 'It’s a Match!' : 'Date Decided!', forcedWinner.title, forcedWinner.detail);
    return;
  }

  // Gather top mutual matches (up to 3)
  const topMutual = Array.isArray(mutual) ? mutual.slice(0, 3) : [];

  if (topMutual.length > 0) {
    // If we have mutual matches, present a final voting round shortlist
    showFinalVotingRound(topMutual, []);
  } else {
    // Fallback: No direct mutual matches. Pick top alternative suggestions (unliked or highest scored)
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
  if (eyebrow) eyebrow.textContent = hasMutual ? 'Final Voting Round' : 'No Direct Mutual Matches';
  if (title) title.textContent = hasMutual ? 'Shortlisted Mutual Matches' : 'Alternative Suggestions';
  if (detail) detail.textContent = hasMutual
    ? 'You both liked these dates! Vote on your favorite for tonight:'
    : 'You didn’t swipe right on the exact same cards. Here are top-rated alternatives tailored for you:';

  const shortlist = hasMutual ? mutualMatches : alternativeSuggestions;

  shortlist.forEach(item => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary-btn secondary-action-btn';
    btn.style.cssText = 'text-align:left;padding:12px;display:flex;flex-direction:column;gap:4px;cursor:pointer;';
    
    const badge = document.createElement('span');
    badge.style.cssText = 'font-size:0.68rem;font-weight:900;text-transform:uppercase;color:var(--gold);';
    badge.textContent = hasMutual ? '⭐ Mutual Match' : '💡 Alternative Suggestion';

    const t = document.createElement('span');
    t.style.cssText = 'font-size:0.95rem;font-weight:900;color:var(--cream);';
    t.textContent = item.title;

    const d = document.createElement('span');
    d.style.cssText = 'font-size:0.78rem;color:var(--muted);';
    d.textContent = `${item.category} · Estimated cost: ${item.costEstimate || 'Free / Variable'}`;

    btn.append(badge, t, d);
    btn.addEventListener('click', () => {
      modal.classList.remove('show');
      if (remoteRoomId && myPlayerNum === 1) {
        sendP2PMessage({ type: 'CHOOSE_WINNER', winnerId: item.id });
      } else if (remoteRoomId && myPlayerNum === 2) {
        sendP2PMessage({ type: 'VOTE_CANDIDATE', candidateId: item.id });
        showToast('Vote submitted! Waiting for host confirmation.');
        return;
      }
      window.currentWinner = item;
      showModal('Winner Selected!', item.title, item.detail);
    });
    container.appendChild(btn);
  });

  modal.classList.add('show');
}

/* DRAFT */
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

/* SURPRISE */
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

/* LIBRARY */
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

/* STORE */
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
    category.textContent = `EXPANSION PACK · ${item.price}`;
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
    button.textContent = unlocked ? '✅ Unlocked (View)' : `🛒 Unlock Pack · ${item.price}`;
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
    actionButton.textContent = unlocked ? 'Already Unlocked' : `Unlock Pack · ${item.price}`;
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
  const confirmed = confirm('Unlock this expansion pack on this device?');
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
    showToast('Expansion pack unlocked successfully.');
  } catch (err) {
    unlockedItems = unlockedItems.filter(id => id !== itemId);
    console.error('Could not save pack unlock:', err);
    showToast('The pack could not be unlocked because local storage failed.');
  }
}

/* HISTORY & ANALYTICS */
function renderTracker() {
  const label = getEl('dateGoalStatus');
  const bar = getEl('dateGoalBar');
  if (!bar || !label) return;
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const count = dateHistory.filter(entry => new Date(entry.date) >= startOfWeek).length;
  label.textContent = `${count} / 1 Done`;
  bar.style.width = `${Math.min(100, count * 100)}%`;
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
  if (!entry || typeof entry !== 'object') return null;
  const syncId = entry.syncId || createUniqueId();
  const existing = dateHistory.find(record => record.syncId && record.syncId === syncId);
  if (existing) return existing;

  const { id: ignoredDatabaseId, ...record } = entry;
  const toSave = { ...record, syncId };
  
  let saved = toSave;
  if (!useMemoryFallback && db) {
    try {
      const insertedId = await db.history.add(toSave);
      saved = await db.history.get(insertedId) || toSave;
    } catch (err) {
      console.warn('Could not persist to IndexedDB, saving in memory:', err);
    }
  }

  dateHistory = [saved, ...dateHistory.filter(item => item.syncId !== saved.syncId)].sort((a, b) => new Date(b.date) - new Date(a.date));
  renderHistory();
  if (broadcast && remoteRoomId && myPlayerNum === 1) {
    sendP2PMessage({ type: 'HISTORY_ENTRY', entry: saved });
  }
  return saved;
}

async function receiveHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return;
  if (entry.syncId && dateHistory.some(record => record.syncId === entry.syncId)) return;
  const { id: ignoredDatabaseId, ...record } = entry;
  let saved = record;
  if (!useMemoryFallback && db) {
    try {
      const insertedId = await db.history.add(record);
      saved = await db.history.get(insertedId) || record;
    } catch (err) {
      console.warn('Could not receive history entry into DB:', err);
    }
  }
  dateHistory = [saved, ...dateHistory].sort((a, b) => new Date(b.date) - new Date(a.date));
  renderHistory();
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
  const query = item.location === 'out' ? `${item.title} near me` : `${item.title} near me`;
  window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`, '_blank', 'noopener,noreferrer');
}

function startSelectedDate() {
  const item = window.currentWinner;
  if (!item) return;
  showToast(`Starting date: ${item.title}! Have a wonderful time.`);
  openCurrentCardMap();
}

async function exportBackup() {
  const data = {
    version: '2.9.0',
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
      if (!data || typeof data !== 'object') throw new Error('Backup must be a JSON object.');
      if (!data.version || !Array.isArray(data.dateHistory)) {
        throw new Error('Invalid backup file structure.');
      }

      if (data.settings && typeof data.settings === 'object') {
        appSettings = {
          theme: ['dark', 'ocean'].includes(data.settings.theme) ? data.settings.theme : 'dark',
          feedback: ['both', 'sound', 'vibration', 'off'].includes(data.settings.feedback) ? data.settings.feedback : 'both'
        };
        if (!useMemoryFallback && db) await db.settings.put({ key: 'appSettings', value: appSettings });
      }
      if (Array.isArray(data.customDeck)) {
        customDeck = data.customDeck.filter(item => item && typeof item === 'object' && item.id && item.title);
        if (!useMemoryFallback && db) {
          await db.customDeck.clear();
          await db.customDeck.bulkAdd(customDeck.map(item => ({ item })));
        }
      }
      if (Array.isArray(data.dateHistory)) {
        const sanitized = data.dateHistory.filter(entry => entry && typeof entry === 'object').map(({ id, ...entry }) => entry);
        if (!useMemoryFallback && db) {
          await db.history.clear();
          if (sanitized.length) await db.history.bulkAdd(sanitized);
          dateHistory = await db.history.orderBy('date').reverse().toArray();
        } else {
          dateHistory = sanitized;
        }
      }
      if (Array.isArray(data.unlockedItems)) {
        const ids = data.unlockedItems.filter(id => typeof id === 'string' && expansionDecks[id]);
        unlockedItems = ids;
        if (!useMemoryFallback && db) {
          await db.unlocks.clear();
          if (ids.length) await db.unlocks.bulkAdd(ids.map(id => ({ id })));
        }
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
      showToast('The backup file is invalid or corrupted.');
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
  p1Deck = shuffle(activeDeck);
  p2Deck = [...p1Deck];
  p1Likes = [];
  p2Likes = [];
  swipeIndex = 0;
  swipePlayer = 1;
  remoteSubmitSent = false;
  remotePartnerLikes = null;
  remoteMatchResolved = false;
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
  if (rating1 === null) { showToast('Enter a whole-number rating from 1 to 5.'); return; }
  const second = prompt('Player 2 rating (1–5):', '5');
  if (second === null) return;
  const rating2 = validRating(second);
  if (rating2 === null) { showToast('Enter a whole-number rating from 1 to 5.'); return; }
  const note = prompt('Add a memory note (optional):', '') || '';
  const entry = {
    syncId: createUniqueId(),
    cardId: item.id || null,
    title: item.title || 'Untitled date',
    category: item.category || 'Date',
    detail: item.detail || '',
    date: new Date().toISOString(),
    rating1,
    rating2,
    note
  };

  try {
    if (remoteRoomId && conn && conn.open && myPlayerNum === 2) {
      sendP2PMessage({ type: 'COMPLETE_DATE_REQUEST', entry });
      closeModal();
      return;
    }
    await persistHistoryEntry(entry, true);
    closeModal();
  } catch (error) {
    console.error('Could not save completed date:', error);
    showToast('The date could not be saved.');
  }
}

function downloadCalendarEvent() {
  const item = window.currentWinner;
  if (!item) { showToast('Choose a date idea first.'); return; }
  const start = new Date();
  start.setHours(19, 0, 0, 0);
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
}

function normalizeRoomCode(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
}

function roomPeerId(code) {
  return `datenight-${code}`;
}

function copyInviteLink() {
  if (!remoteRoomId) {
    const code = prompt('Enter a room code to generate a shareable link:');
    if (!code) return;
    remoteRoomId = normalizeRoomCode(code);
  }
  const link = `${window.location.origin}${window.location.pathname}?room=${remoteRoomId}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(() => {
      showToast('Invite link copied to clipboard!');
    }).catch(() => {
      prompt('Copy invite link:', link);
    });
  } else {
    prompt('Copy invite link:', link);
  }
}

function startP2PServer(presetCode = null) {
  const raw = presetCode || prompt('Create a room code using letters, numbers, or hyphens (at least 4 characters):');
  if (!raw) return;
  const code = normalizeRoomCode(raw);
  if (code.length < 4) { showToast('Use a room code at least 4 characters long.'); return; }
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
      connectionState = 'connecting';
      if (conn && conn.open) conn.close();
      conn = incoming;
      setupConnectionHandlers(conn);
      conn.on('open', () => {
        connectionState = 'connected';
        resetRemoteRound();
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
  if (code.length < 4) { showToast('Enter a valid room code at least 4 characters long.'); return; }
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
  updateSwipeCard();
}

function sendP2PMessage(payload) {
  if (!conn || !conn.open) return false;
  try { conn.send(payload); return true; }
  catch (error) { console.error('Could not send live-room message:', error); return false; }
}

function sendRoomState() {
  if (!remoteRoomId || myPlayerNum !== 1) return;
  const budgetFilterEl = getEl('budgetFilter');
  sendP2PMessage({
    type: 'SYNC_STATE',
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
      const sharedDeck = Array.isArray(message.matcherDeck) ? message.matcherDeck : [];
      p1Deck = [...sharedDeck];
      p2Deck = [...sharedDeck];
      p1Likes = [];
      p2Likes = [];
      swipeIndex = 0;
      swipePlayer = 1;
      remoteSubmitSent = false;
      remotePartnerLikes = null;
      remoteMatchResolved = false;
      
      if (message.hostFilters && typeof message.hostFilters === 'object') {
        const hf = message.hostFilters;
        if (Array.isArray(hf.categories)) {
          document.querySelectorAll('.category-choice').forEach(input => {
            input.checked = hf.categories.includes(input.value);
          });
        }
        if (hf.budget) {
          const bEl = getEl('budgetFilter');
          if (bEl) bEl.value = hf.budget;
        }
      }

      draftItems = Array.isArray(message.draftItems) ? message.draftItems.map(item => ({ ...item })) : [];
      draftTurn = Number(message.draftTurn) === 2 ? 2 : 1;
      window.currentWinner = null;
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
      remotePartnerLikes = Array.isArray(message.likedCards) ? message.likedCards.filter(item => item && item.id) : [];
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

    if (message.type === 'VOTE_CANDIDATE' && myPlayerNum === 1) {
      const candidateId = message.candidateId;
      const winner = p1Deck.find(d => d.id === candidateId);
      if (winner) {
        window.currentWinner = winner;
        sendP2PMessage({ type: 'CHOOSE_WINNER', winnerId: winner.id });
        const votingModal = getEl('votingModal');
        if (votingModal) votingModal.classList.remove('show');
        showModal('It’s a Match!', winner.title, winner.detail);
      }
      return;
    }

    if (message.type === 'BAN_REQUEST' && myPlayerNum === 1) {
      if (draftTurn === 2 && Number.isInteger(message.index)) executeBan(message.index);
      return;
    }

    if (message.type === 'DRAFT_STATE' && myPlayerNum === 2) {
      draftItems = Array.isArray(message.draftItems) ? message.draftItems.map(item => ({ ...item })) : [];
      draftTurn = Number(message.draftTurn) === 2 ? 2 : 1;
      renderDraftGrid();
      const remaining = draftItems.filter(item => !item.banned);
      if (remaining.length === 1) {
        window.currentWinner = remaining[0];
        showModal('Winner by Elimination!', remaining[0].title, remaining[0].detail);
      }
      return;
    }

    if (message.type === 'COMPLETE_DATE_REQUEST' && myPlayerNum === 1 && message.entry) {
      persistHistoryEntry(message.entry, true)
        .then(() => closeModal())
        .catch(error => { console.error('Could not save partner-completed date:', error); });
      return;
    }

    if (message.type === 'HISTORY_ENTRY' && myPlayerNum === 2 && message.entry) {
      receiveHistoryEntry(message.entry).catch(error => console.error('Could not receive history entry:', error));
    }
  });

  thisConn.on('open', () => {
    conn = thisConn;
    connectionState = 'connected';
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
      customDeck = customRecords.map(record => record.item).filter(item => item && typeof item === 'object');
      const deletedRecords = await db.deletedBuiltins.toArray();
      deletedBuiltins = new Set(deletedRecords.map(record => record.id));
      dateHistory = await db.history.orderBy('date').reverse().toArray();
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

  // Check URL query parameters for auto-joining room
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
  loadAppData().catch(error => {
    console.error('App initialization failed:', error);
  });
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(error => console.warn('Service worker registration failed:', error));
  });
}
