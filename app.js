'use strict';

/* Date Night Decider — version 2.9.1 with Production Audit & Checklist Updates:
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
    "id": "viral-01",
    "title": "Store Aisle Roulette",
    "category": "micro-adventure",
    "budget": "free",
    "location": "out",
    "duration": "20\u201330 min",
    "costEstimate": "$0; optional spending cap of $5",
    "equipment": [
      "A store you are already visiting or household items at home",
      "A phone timer is optional"
    ],
    "mission": "Find unexpected items that match specific prompts, then explain your choices to each other. The fun comes from seeing how well you understand your partner\u2014not from buying things.",
    "howToPlay": [
      "1. Decide who goes first.",
      "2. Read one prompt at a time.",
      "3. Both players have 45 seconds to find an item that fits.",
      "4. Reveal your choices together.",
      "5. Each player gets 30 seconds to explain their choice.",
      "6. Award points using the rules below and play all six rounds."
    ],
    "atHomeAlternative": "Use pantry items, refrigerator contents, books, clothing, or other household objects. For the price prompt, imagine a $3 budget and describe what you would choose.",
    "importantRule": "No purchases are required. Do not open products, disrupt shoppers, or enter restricted areas. Keep the spending cap at $5 combined if you decide to buy anything.",
    "detail": "A retail or pantry scavenger hunt where understanding your partner yields the highest score.",
    "gradient": "linear-gradient(135deg, #31103f, #190a24)"
  },
  {
    "id": "viral-02",
    "title": "Trunk-Side Studio",
    "category": "micro-adventure",
    "budget": "free",
    "location": "out",
    "duration": "30\u201345 min",
    "costEstimate": "$0\u201315",
    "equipment": [
      "Paper, pens or markers, and a flat surface",
      "Optional: a blanket, clipboard, or inexpensive craft supplies"
    ],
    "mission": "Turn a safe, comfortable spot into a tiny outdoor art studio. You will create a mini art gallery for each other using funny, romantic, or completely unexpected prompts.",
    "howToPlay": [
      "1. Pick a safe location away from moving traffic, preferably a park table, picnic area, or your own driveway.",
      "2. Park legally and set up on a table, blanket, or other stable surface. Do not sit inside an open trunk or block traffic.",
      "3. Choose three prompts from the deck.",
      "4. Both players create something for each prompt. Stick figures and terrible drawings are encouraged.",
      "5. Give each creation a title and a 20-second artist statement.",
      "6. Display your creations side by side and vote for the most creative, funniest, and sweetest piece."
    ],
    "atHomeAlternative": "Set up beside a window, on a patio, at a kitchen table, or on the couch with a clipboard.",
    "importantRule": "This is about creative expression, not artistic skill. Keep the location safe and comfortable. If weather, lighting, or the setting is unsuitable, move the studio indoors.",
    "detail": "Turn a safe, comfortable spot into a tiny outdoor art studio and create a mini art gallery for each other.",
    "gradient": "linear-gradient(135deg, #38103f, #230a24)"
  },
  {
    "id": "viral-03",
    "title": "Seven Treasures Exchange",
    "category": "micro-adventure",
    "budget": "free",
    "location": "home",
    "duration": "20\u201340 min",
    "costEstimate": "$0",
    "equipment": [
      "Seven meaningful objects, photographs, or memories per person. Nothing has to be purchased."
    ],
    "mission": "Each partner creates a collection of seven little \u201ctreasures\u201d that tell a story about who they are, where they have been, and what they value. The goal is to discover something new about each other.",
    "howToPlay": [
      "1. Each partner privately chooses one item, photograph, or memory for each prompt below.",
      "2. You have five minutes to gather your choices.",
      "3. Take turns revealing one treasure at a time.",
      "4. Before the explanation, the listening partner may guess why that treasure was chosen.",
      "5. After the explanation, ask one respectful follow-up question.",
      "6. Finish by choosing the treasure you most want to remember from your partner's collection."
    ],
    "atHomeAlternative": "Use photographs on your phone, digital keepsakes, favorite songs, saved messages, or simply describe each memory.",
    "importantRule": "No one has to share anything painful, private, or uncomfortable. A person can replace any prompt with a happy memory or pass without explanation.",
    "detail": "Gather seven meaningful objects, photos, or memories that tell stories about your life and values.",
    "gradient": "linear-gradient(135deg, #40103f, #280a24)"
  },
  {
    "id": "viral-04",
    "title": "Alphabet Culinary Crawl",
    "category": "micro-adventure",
    "budget": "free",
    "location": "home",
    "duration": "30\u201360 min",
    "costEstimate": "$0\u201330+, depending on optional purchases",
    "equipment": [
      "A phone or paper for keeping score",
      "Access to a kitchen or a few shops",
      "A spending limit if you plan to buy food"
    ],
    "mission": "Build a tiny food adventure around three letters of the alphabet. You will hunt for foods, snacks, drinks, or ingredients matching the letters and design a mini menu together.",
    "howToPlay": [
      "1. Use the letters C, M, and S for the first game. For a replay, pick three new letters.",
      "2. Set a combined spending limit before you start. The default is $10, but $0 is fine.",
      "3. For each letter, both players find one food or drink beginning with that letter.",
      "4. You can find items in a pantry, grocery store, market, caf\u00e9 menu, or recipe book.",
      "5. After each letter, choose one item that best fits the round's special prompt.",
      "6. Use your three winning choices to create a pretend restaurant menu with a name and a one-sentence description."
    ],
    "atHomeAlternative": "Use only what is already available at home, look through a grocery flyer, or browse a recipe collection.",
    "importantRule": "Do not exceed the agreed budget. No tasting is required. Respect allergies, dietary needs, and food preferences.",
    "detail": "Build a tiny food adventure and pretend menu around three letters of the alphabet.",
    "gradient": "linear-gradient(135deg, #48103f, #2d0a24)"
  },
  {
    "id": "viral-05",
    "title": "Architectural Fort Cinema",
    "category": "micro-adventure",
    "budget": "free",
    "location": "home",
    "duration": "30\u201360 min",
    "costEstimate": "$0\u201310",
    "equipment": [
      "Blankets, pillows, a couch or chairs",
      "A screen or other way to watch a movie",
      "Snacks are optional"
    ],
    "mission": "Build a miniature cinema that feels different from an ordinary movie night. Your fort needs a theme, an unusual design feature, and a movie chosen using the rules below.",
    "howToPlay": [
      "1. Choose one fort theme from the list.",
      "2. Set a 10-minute building timer.",
      "3. Each partner must add at least two features to the fort.",
      "4. Give the fort a name and create a cinema ticket for each person.",
      "5. Choose a movie using the selection rules.",
      "6. Before watching, each player predicts one thing they expect to happen in the movie."
    ],
    "atHomeAlternative": "A couch corner, blanket canopy, pillows arranged around a laptop, or a simple \u201cfort\u201d made by rearranging cushions all count.",
    "importantRule": "Keep the structure stable and avoid heavy objects or unsafe climbing. Do not block exits or heaters.",
    "detail": "Build a miniature blanket-and-pillow cinema with a fun theme and movie selection rules.",
    "gradient": "linear-gradient(135deg, #50103f, #320a24)"
  },
  {
    "id": "viral-06",
    "title": "Reverse Date Roulette",
    "category": "micro-adventure",
    "budget": "free",
    "location": "home",
    "duration": "20\u201345 min",
    "costEstimate": "$0\u201315",
    "equipment": [
      "This card",
      "A coin or random-number tool",
      "Household items required by the chosen activity"
    ],
    "mission": "Let chance choose a date activity, then give your partner control over one twist. You will each get a turn directing the date, so nobody has to plan the whole thing.",
    "howToPlay": [
      "1. Each partner selects three numbers from the activity list below without telling the other person.",
      "2. Randomly select one of those numbers. Skip if unsuitable.",
      "3. Flip a coin. The winner chooses which partner directs the first round.",
      "4. The director has two minutes to start the activity. The other partner adds one twist from the twist list.",
      "5. Play for 10 minutes, then switch roles and repeat.",
      "6. You can agree to extend the activity if you both want to."
    ],
    "atHomeAlternative": "All activities can be completed at home. Replace any outing or purchase with a free household version.",
    "importantRule": "Both partners can veto an activity without penalty. Chance should make the date easier.",
    "detail": "Let chance select a date activity, then give your partner control over a surprise twist.",
    "gradient": "linear-gradient(135deg, #58103f, #370a24)"
  },
  {
    "id": "viral-07",
    "title": "One Object, Three Uses",
    "category": "micro-adventure",
    "budget": "free",
    "location": "home",
    "duration": "15\u201325 min",
    "costEstimate": "$0",
    "equipment": [
      "One safe household object per round and a timer"
    ],
    "mission": "Turn an ordinary object into three completely different inventions. Creativity, ridiculous explanations, and teamwork matter more than making something physically useful.",
    "howToPlay": [
      "1. Choose a safe object, such as a spoon, empty box, clean sock, paper cup, or wooden spoon.",
      "2. Both players get 60 seconds to invent a new use for it.",
      "3. Each person presents their idea in 20 seconds.",
      "4. Play three rounds with different objects.",
      "5. In the final round, invent one use together and agree on a name for it."
    ],
    "atHomeAlternative": "If you cannot find a suitable object, invent with an imaginary object or use a drawing instead.",
    "importantRule": "Use only safe objects. No sharp tools, hot appliances, or electrical disassembly.",
    "detail": "Turn an ordinary household object into three hilarious new inventions.",
    "gradient": "linear-gradient(135deg, #60103f, #3c0a24)"
  }
],
  'pack-coop': [
  {
    "id": "coop-01",
    "title": "The 20-Minute Build-Off",
    "category": "gaming",
    "budget": "free",
    "location": "home",
    "duration": "25\u201335 min",
    "costEstimate": "$0 if you already own a suitable game",
    "equipment": [
      "A shared sandbox, building, or creative game. A paper-and-pencil version also works."
    ],
    "mission": "Create a build from the same theme under a strict time limit. You can compete individually or collaborate on one creation if the game does not support separate builds.",
    "howToPlay": [
      "1. Select a theme from the deck below.",
      "2. Agree on a safe build area and a 20-minute timer.",
      "3. Both players can gather basic resources for two minutes.",
      "4. Start building when the timer begins. No copying after the first five minutes.",
      "5. When time is up, take a tour of each build and explain your three favorite features.",
      "6. If separate builds aren't allowed, divide into two zones or alternate turns."
    ],
    "atHomeAlternative": "Use blocks, paper, cardboard, or a simple floor plan. Draw the structure from above and label the required features.",
    "importantRule": "Use a game you already own and a mode you can both access. Game purchases and currency are not required.",
    "detail": "Create a build from the same theme under a 20-minute time limit in a game or on paper.",
    "gradient": "linear-gradient(135deg, #064e3b, #022c22)"
  },
  {
    "id": "coop-02",
    "title": "Secret Base Blueprint",
    "category": "gaming",
    "budget": "free",
    "location": "home",
    "duration": "30\u201345 min",
    "costEstimate": "$0 if you already own a suitable game",
    "equipment": [
      "A building, sandbox, survival, or creative game\u2014or paper for a blueprint."
    ],
    "mission": "Design a secret base together, with each person responsible for different areas. Your base must be practical enough to use and ridiculous enough to reflect your personalities.",
    "howToPlay": [
      "1. Choose a suitable location or draw a floor plan on paper.",
      "2. Assign roles: Planner and Builder. Planner directs first phase; builder handles construction.",
      "3. Planner has two minutes to describe the base layout.",
      "4. Build or sketch for 10 minutes.",
      "5. Switch roles. The new planner adds the required upgrades.",
      "6. Finish by giving a guided tour and inventing a secret code name for the base."
    ],
    "atHomeAlternative": "Draw a top-down floor plan and label all six zones. Use arrows to show how people move between them.",
    "importantRule": "Do not destroy another player's build or spend premium resources without agreement.",
    "detail": "Design a secret base together, taking turns as Planner and Builder.",
    "gradient": "linear-gradient(135deg, #065e3b, #023c22)"
  },
  {
    "id": "coop-03",
    "title": "Roles Reversed",
    "category": "gaming",
    "budget": "free",
    "location": "home",
    "duration": "20\u201340 min",
    "costEstimate": "$0 if you already own a suitable game",
    "equipment": [
      "A cooperative or multiplayer game with roles, characters, tasks, or responsibilities that can be exchanged."
    ],
    "mission": "Switch the usual roles so that the less experienced player leads and the more experienced player practices supporting them. The goal is communication and patience.",
    "howToPlay": [
      "1. Choose a level, mission, race, puzzle, or objective you can attempt together.",
      "2. Identify two roles (e.g., navigator/driver, builder/gatherer, healer/explorer).",
      "3. For the first half, the usual leader must take the support role.",
      "4. The other player becomes the decision-maker and chooses the route or next task.",
      "5. Switch roles for the second half.",
      "6. At the end, name one thing your partner did that helped the team."
    ],
    "atHomeAlternative": "Use a paper maze: one person describes directions while the other traces the route, then switch.",
    "importantRule": "Choose a game and difficulty that are enjoyable for both. Do not sabotage each other.",
    "detail": "Switch your usual gaming roles so the less experienced player leads and receives support.",
    "gradient": "linear-gradient(135deg, #066e3b, #024c22)"
  },
  {
    "id": "coop-04",
    "title": "In-Game Scavenger Hunt",
    "category": "gaming",
    "budget": "free",
    "location": "home",
    "duration": "20\u201345 min",
    "costEstimate": "$0 if you already own a suitable game",
    "equipment": [
      "An exploration, sandbox, open-world, or adventure game that you both can play."
    ],
    "mission": "Complete a five-item scavenger hunt before the timer ends. Explore together, communicate, and collect proof of each discovery through a screenshot or in-game visit.",
    "howToPlay": [
      "1. Choose an area where exploration is permitted and reasonably safe in the game.",
      "2. Start a 25-minute timer.",
      "3. Work together to find the five targets below.",
      "4. Split up if allowed and comfortable.",
      "5. Each time you find a target, take a screenshot, mark the location, or bring the item back.",
      "6. Return to the meeting point before time runs out."
    ],
    "atHomeAlternative": "Do a household hunt: find something bright, something unusual, a place with a view, a cozy shelter, and one item chosen by your partner.",
    "importantRule": "Use game features that are available in your version without paid expansions or online requirements.",
    "detail": "Work together to locate five specific targets in an open-world game within 25 minutes.",
    "gradient": "linear-gradient(135deg, #067e3b, #025c22)"
  },
  {
    "id": "coop-05",
    "title": "First-Night Survival",
    "category": "gaming",
    "budget": "free",
    "location": "home",
    "duration": "30\u201360 min",
    "costEstimate": "$0 if you already own a suitable game",
    "equipment": [
      "A survival, crafting, or resource-management game, or household objects for the offline version."
    ],
    "mission": "Imagine arriving in a new world. Establish a basic shelter, organize resources, and prepare for the first major challenge together.",
    "howToPlay": [
      "1. Start a new save or choose an unused area in an existing world.",
      "2. Set a 30-minute objective timer, or use the game's natural day/night cycle.",
      "3. Assign two roles: Scout and Builder.",
      "4. Scout identifies location and gathers resources; builder plans shelter.",
      "5. After 10 minutes, switch roles.",
      "6. Review the checklist and name your base."
    ],
    "atHomeAlternative": "Use cushions, blankets, paper, or blocks to create a small shelter. Collect three categories of safe household objects as resources.",
    "importantRule": "Choose a relaxed difficulty and agree on rules before starting. This is a cooperative mission.",
    "detail": "Survive your first night in a new game save by dividing scout and builder roles.",
    "gradient": "linear-gradient(135deg, #068e3b, #026c22)"
  },
  {
    "id": "coop-06",
    "title": "Build Our Dream Date",
    "category": "gaming",
    "budget": "free",
    "location": "home",
    "duration": "30\u201345 min",
    "costEstimate": "$0 if you already own a suitable game",
    "equipment": [
      "A building, design, sandbox, simulation, or creative game. Paper also works."
    ],
    "mission": "Design the ultimate date location together inside a game (rooftop restaurant, fantasy garden, beach cabin, or city apartment).",
    "howToPlay": [
      "1. Choose a location theme from the list.",
      "2. Set a 25-minute timer.",
      "3. Each person must add at least three features to the design.",
      "4. After 15 minutes, stop and give each other a one-minute tour.",
      "5. Spend final 10 minutes adding partner's requested features.",
      "6. Name the location and write an imaginary listing description."
    ],
    "atHomeAlternative": "Sketch a floor plan, create a mood board using words, or describe the location together and write down three must-have features.",
    "importantRule": "Keep the date location within tools you already have. No premium currency or paid packs required.",
    "detail": "Design the ultimate date location inside a sandbox game or on paper.",
    "gradient": "linear-gradient(135deg, #069e3b, #027c22)"
  },
  {
    "id": "coop-07",
    "title": "Game-to-Real-Life Remix",
    "category": "gaming",
    "budget": "free",
    "location": "home",
    "duration": "20\u201345 min",
    "costEstimate": "$0\u20135",
    "equipment": [
      "Paper and pencils, or optional clean recycled cardboard and safe craft supplies."
    ],
    "mission": "Take a familiar game concept (gadget, creature, power-up) and reinterpret it as an original real-world creation.",
    "howToPlay": [
      "1. Each partner chooses a general game-inspired concept from the prompt deck.",
      "2. Pick one safe item or idea to represent with paper, cardboard, blocks, or a drawing.",
      "3. Set a 10-minute creation timer.",
      "4. Make your own version, or collaborate on one.",
      "5. Give creation an original name, describe what it does, and show how it is used.",
      "6. Select the most useful, imaginative, or amusing creation."
    ],
    "atHomeAlternative": "Draw the idea or describe it verbally. Invent a fake product advertisement without making a physical object.",
    "importantRule": "Do not use sharp tools or hazardous materials. Game names are used only as descriptive references.",
    "detail": "Reinterpret a favorite game mechanic or gadget into a real-world creation or sketch.",
    "gradient": "linear-gradient(135deg, #06ae3b, #028c22)"
  }
],
  'pack-sweet': [
  {
    "id": "sweet-01",
    "title": "Guided Baking Challenge",
    "category": "baking",
    "budget": "paid",
    "location": "home",
    "duration": "45\u201375 min",
    "costEstimate": "$5\u201315 if ingredients must be purchased",
    "equipment": [
      "Mixing bowl, spoon/mixer, baking tray, parchment, measuring cups/scale, cookie ingredients"
    ],
    "mission": "Bake a batch of simple chocolate-chip cookies together. One partner acts as Recipe Reader, and the other as Mixing Lead.",
    "howToPlay": [
      "1. Step 1 \u2014 Read Recipe: Recipe Reader checks ingredients; Mixing Lead measures.",
      "2. Step 2 \u2014 Mix Wet: Preheat oven to 350\u00b0F (175\u00b0C). Mix butter and sugar, then egg and vanilla.",
      "3. Step 3 \u2014 Add Dry: Combine flour, soda, salt. Stir into wet mixture. Fold in chocolate chips.",
      "4. Step 4 \u2014 Shape: Place tablespoon portions on baking tray with space between.",
      "5. Step 5 \u2014 Bake: Bake for 9\u201311 minutes until golden. Cool before eating.",
      "6. Step 6 \u2014 Make It Your Own: Invent a bakery name and choose a signature cookie."
    ],
    "atHomeAlternative": "Use ready-made cookie dough, a boxed mix, or ready-made cookies for decorating.",
    "importantRule": "Check allergies and dietary restrictions. Do not eat raw dough. Use oven mitts for hot trays.",
    "detail": "Bake simple chocolate-chip cookies together with designated reader and mixer roles.",
    "gradient": "linear-gradient(135deg, #4a1525, #831843)"
  },
  {
    "id": "sweet-02",
    "title": "Dessert Board Designers",
    "category": "baking",
    "budget": "paid",
    "location": "home",
    "duration": "20\u201335 min",
    "costEstimate": "$5\u201315 if supplies must be purchased",
    "equipment": [
      "A plate or board and any combination of sweets, fruit, crackers, or other foods"
    ],
    "mission": "Create a dessert board that looks like it belongs in a caf\u00e9. Design small sections and combine them into one shared creation.",
    "howToPlay": [
      "1. Choose up to five available ingredients.",
      "2. Decide which half of the plate or board each person will design.",
      "3. Set an eight-minute timer.",
      "4. Arrange your section around the challenge prompt.",
      "5. Each person gives a 30-second presentation.",
      "6. Work together for 5 minutes to connect the two designs into one board."
    ],
    "atHomeAlternative": "Use crackers, cereal, fruit, pantry snacks, or even non-food objects for a pretend caf\u00e9 display.",
    "importantRule": "Wash hands, use clean utensils, and check allergens. Do not make tasting a condition of winning.",
    "detail": "Design and combine sections of a stylish dessert board using snacks or fruit.",
    "gradient": "linear-gradient(135deg, #5a1525, #931843)"
  },
  {
    "id": "sweet-03",
    "title": "Dessert Decorating Showdown",
    "category": "baking",
    "budget": "paid",
    "location": "home",
    "duration": "20\u201340 min",
    "costEstimate": "$4\u201312 if ingredients must be purchased",
    "equipment": [
      "Cookies, cupcakes, or ready-made dessert; optional icing, sprinkles, fruit, or toppings"
    ],
    "mission": "Turn ordinary desserts into themed creations. Each player decorates one dessert per round and explains the backstory.",
    "howToPlay": [
      "1. Use ready-made cookies, cupcakes, or any available dessert.",
      "2. Choose a theme from the deck.",
      "3. Each player gets 5 minutes to decorate one dessert.",
      "4. Present the result and give it a name.",
      "5. Play two rounds if supplies allow.",
      "6. Vote before revealing whose design is whose for blind judging."
    ],
    "atHomeAlternative": "Decorate crackers, pancakes, toast, fruit, or paper dessert templates.",
    "importantRule": "Check allergies and practice safe food handling. Goal is creativity, not pastry perfection.",
    "detail": "Decorate ready-made treats according to fun imaginative prompts.",
    "gradient": "linear-gradient(135deg, #6a1525, #a31843)"
  },
  {
    "id": "sweet-04",
    "title": "Sweet & Crunchy Mystery Test",
    "category": "baking",
    "budget": "free",
    "location": "home",
    "duration": "15\u201325 min",
    "costEstimate": "$0\u20138",
    "equipment": [
      "3 to 5 familiar snacks or fruits already available, small plates"
    ],
    "mission": "Explore textures, sounds, shapes, or flavors of familiar snacks through a guessing game. No blindfold needed.",
    "howToPlay": [
      "1. Choose 3-5 familiar foods or objects with distinct textures.",
      "2. One partner selects a mystery item and describes it without naming it.",
      "3. Other partner gets up to three guesses.",
      "4. Switch roles after each round.",
      "5. Describe texture, color, shape, packaging, or memory. Do not name.",
      "6. Play 5 rounds or until items are exhausted."
    ],
    "atHomeAlternative": "Use familiar household objects, packaging, or pictures instead of food. Play verbally with imaginary snacks.",
    "importantRule": "No blindfolds needed. Never use allergens or unsafe items. No forced tasting.",
    "detail": "A sensory texture and shape guessing game using familiar snacks or pantry items.",
    "gradient": "linear-gradient(135deg, #7a1525, #b31843)"
  },
  {
    "id": "sweet-05",
    "title": "No-Bake Dessert Build-Off",
    "category": "baking",
    "budget": "paid",
    "location": "home",
    "duration": "20\u201335 min",
    "costEstimate": "$4\u201312 if ingredients must be purchased",
    "equipment": [
      "Ready-to-eat bases (cookies, crackers, yogurt, fruit, pudding); optional toppings; plates/cups"
    ],
    "mission": "Build a creative dessert without using an oven from a small selection of ingredients, then pitch it as a menu item.",
    "howToPlay": [
      "1. Choose up to 5 ingredients you already have or can comfortably buy.",
      "2. Agree on the same base ingredient for both players.",
      "3. Set a 10-minute timer.",
      "4. Create a dessert using selected ingredients.",
      "5. Give it a name, menu description, and suggested occasion.",
      "6. Compare creations and award categories."
    ],
    "atHomeAlternative": "Use pantry ingredients, fruit, cereal, crackers, or draw and describe the dessert.",
    "importantRule": "Use foods meeting dietary needs. Keep portions small and respect allergies.",
    "detail": "Build and pitch a gourmet no-bake dessert using simple pantry ingredients.",
    "gradient": "linear-gradient(135deg, #8a1525, #c31843)"
  },
  {
    "id": "sweet-06",
    "title": "Recreate a Childhood Treat",
    "category": "baking",
    "budget": "free",
    "location": "home",
    "duration": "30\u201360 min",
    "costEstimate": "$0\u201312 depending on ingredients",
    "equipment": [
      "Ingredients for one familiar treat, or a ready-made snack that reminds you of childhood"
    ],
    "mission": "Each partner chooses a treat connected to a childhood memory. Recreate one treat together and share stories.",
    "howToPlay": [
      "1. Privately name a dessert or snack that reminds you of childhood.",
      "2. Explain the memory behind your choice.",
      "3. Choose one treat that fits budget and ingredients.",
      "4. Prepare it together using a trusted recipe or store version.",
      "5. Answer memory prompts while preparing.",
      "6. Give the treat a new name connecting both of you."
    ],
    "atHomeAlternative": "Use a ready-made cookie, cereal, pudding, or fruit. Describe the treat and draw how you remember it.",
    "importantRule": "No need to share painful memories. Avoid unsafe raw ingredients and respect allergies.",
    "detail": "Recreate a childhood favorite treat while sharing fond memories behind it.",
    "gradient": "linear-gradient(135deg, #9a1525, #d31843)"
  },
  {
    "id": "sweet-07",
    "title": "Ice Cream Remix",
    "category": "baking",
    "budget": "free",
    "location": "home",
    "duration": "15\u201325 min",
    "costEstimate": "$0\u201310 depending on ingredients",
    "equipment": [
      "Ice cream or suitable base, small bowls, optional toppings you already own"
    ],
    "mission": "Invent a new dessert combination and give it a menu-worthy name. Make individual versions, then a shared house special.",
    "howToPlay": [
      "1. Choose base: ice cream, frozen yogurt, yogurt, or fruit.",
      "2. Select up to three available toppings.",
      "3. Pick a challenge prompt.",
      "4. Take 5 minutes to arrange or combine ingredients.",
      "5. Give dessert a name, one-line description, and rating.",
      "6. Combine favorite ideas into a shared house special."
    ],
    "atHomeAlternative": "Use yogurt, fruit, cereal, or pudding. Sketch and name your dessert without preparing food.",
    "importantRule": "Check dietary restrictions. Tasting is optional; keep ingredients separate if needed for allergies.",
    "detail": "Remix ice cream or yogurt with custom toppings into a signature house special.",
    "gradient": "linear-gradient(135deg, #aa1525, #e31843)"
  }
],
  'pack-quest': [
  {
    "id": "quest-01",
    "title": "Bookstore Blind Pick",
    "category": "quest",
    "budget": "free",
    "location": "out",
    "duration": "30\u201345 min",
    "costEstimate": "$0\u201315; buying a book is optional",
    "equipment": [
      "Access to a bookstore, library, or existing book collection"
    ],
    "mission": "Choose a book for your partner using clues instead of relying on title or cover alone.",
    "howToPlay": [
      "1. Set a budget before entering ($0 default).",
      "2. Privately select a book candidate based on clue prompts.",
      "3. Do not reveal title or author at first.",
      "4. Describe book using allowed clues.",
      "5. Partner asks up to three questions before guessing.",
      "6. Reveal choices and explain why you selected them."
    ],
    "atHomeAlternative": "Use books you already own, e-books, a library catalog, or descriptions of books you remember.",
    "importantRule": "Do not damage books. Follow store/library rules. Purchasing is optional.",
    "detail": "Select secret book candidates for each other at a bookstore or library using genre clues.",
    "gradient": "linear-gradient(135deg, #1e293b, #0f172a)"
  },
  {
    "id": "quest-02",
    "title": "Coffeehouse Mini-Date",
    "category": "quest",
    "budget": "free",
    "location": "out",
    "duration": "30\u201360 min",
    "costEstimate": "$0\u201320 depending on purchases",
    "equipment": [
      "A caf\u00e9 or comfortable place to sit. Drinks/treats optional."
    ],
    "mission": "Turn a coffee break into a focused mini-date with conversation challenges.",
    "howToPlay": [
      "1. Pick a caf\u00e9, bakery, library caf\u00e9, or public spot.",
      "2. Agree on spending limit ($0 is fine).",
      "3. Take turns choosing conversation prompts.",
      "4. Each person answers for up to 1 minute, followed by 1 follow-up question.",
      "5. Complete at least four prompts.",
      "6. Before leaving, decide on one small idea for a future date."
    ],
    "atHomeAlternative": "Make coffee or tea at home and sit somewhere you don't usually use for meals.",
    "importantRule": "Purchases are optional. Respect other customers' space and noise levels.",
    "detail": "Enjoy a focused coffeehouse conversation break with structured question prompts.",
    "gradient": "linear-gradient(135deg, #2e293b, #1f172a)"
  },
  {
    "id": "quest-03",
    "title": "Local Landmark Photo Hunt",
    "category": "quest",
    "budget": "free",
    "location": "out",
    "duration": "30\u201360 min",
    "costEstimate": "$0",
    "equipment": [
      "A phone camera or camera"
    ],
    "mission": "Collect seven photos that tell the story of a mini-adventure using shapes, colors, and small details.",
    "howToPlay": [
      "1. Choose a safe public route, park, neighborhood, or downtown area.",
      "2. Agree on distance and time limit.",
      "3. Take turns choosing prompts to photograph.",
      "4. Aim for seven photos total.",
      "5. Explain why you chose each subject after taking it.",
      "6. Arrange photos into a mini story at the end."
    ],
    "atHomeAlternative": "Use views from windows, yard, household patterns, plants, or indoor architectural details.",
    "importantRule": "Take photos only where permitted. Do not trespass or photograph strangers inappropriately.",
    "detail": "Embark on a photo scavenger hunt looking for shapes, colors, and subtle details.",
    "gradient": "linear-gradient(135deg, #3e293b, #2f172a)"
  },
  {
    "id": "quest-04",
    "title": "Farmers Market Mission",
    "category": "quest",
    "budget": "free",
    "location": "out",
    "duration": "30\u201345 min",
    "costEstimate": "$0\u201315; purchases optional",
    "equipment": [
      "Access to a farmers market, grocery store, produce stand, or pantry"
    ],
    "mission": "Design a tiny seasonal menu together by identifying ingredients that fit three goals.",
    "howToPlay": [
      "1. Set a combined spending limit before starting.",
      "2. Each partner chooses one prompt from the menu.",
      "3. Find an ingredient fitting each prompt.",
      "4. Compare choices and agree on a three-item menu.",
      "5. Give menu a name and describe the meal or snack.",
      "6. Purchase only items you will realistically use."
    ],
    "atHomeAlternative": "Use a grocery flyer, pantry, refrigerator, or online store listing.",
    "importantRule": "Check dietary restrictions, respect market rules, and don't handle produce excessively.",
    "detail": "Design a pretend seasonal three-course menu at a local farmers market or grocery store.",
    "gradient": "linear-gradient(135deg, #4e293b, #3f172a)"
  },
  {
    "id": "quest-05",
    "title": "Mini-Golf Rule Remix",
    "category": "quest",
    "budget": "paid",
    "location": "out",
    "duration": "45\u201390 min",
    "costEstimate": "$10\u201340 for paid venue; $0 at home",
    "equipment": [
      "A mini-golf course or safe space for a home putting challenge"
    ],
    "mission": "Play mini-golf with silly, fair house rules (commentator, victory pose, pep talk).",
    "howToPlay": [
      "1. Choose a mini-golf course or set up a simple home version.",
      "2. Agree to use three remix rules from the list.",
      "3. Play the course or complete six home holes.",
      "4. Read hole rule at each turn.",
      "5. Track strokes normally or score 1 point per hole.",
      "6. Award most creative shot and sportsmanship."
    ],
    "atHomeAlternative": "Create 6 'holes' using cups on a safe floor with a soft ball and toy club/substitute.",
    "importantRule": "Follow venue rules and never modify a public course or disrupt other players.",
    "detail": "Play a round of mini-golf with playful custom house rules.",
    "gradient": "linear-gradient(135deg, #5e293b, #4f172a)"
  },
  {
    "id": "quest-06",
    "title": "Thrift-Store Style Swap",
    "category": "quest",
    "budget": "free",
    "location": "out",
    "duration": "30\u201345 min",
    "costEstimate": "$0\u201320; purchases optional",
    "equipment": [
      "Access to a thrift store or your own wardrobe"
    ],
    "mission": "Choose a playful outfit or accessory for each other based on a theme.",
    "howToPlay": [
      "1. Agree on combined spending limit ($0 default).",
      "2. Choose one theme from list.",
      "3. Pick up to 3 clothing/accessory options for your partner.",
      "4. Explain how each item fits the theme.",
      "5. Receiver decides whether to try on or rate the ideas.",
      "6. Switch roles for round two."
    ],
    "atHomeAlternative": "Use your own wardrobes, accessories, hats, or imaginary outfit descriptions.",
    "importantRule": "Do not pressure anyone to wear or buy anything. Respect personal comfort boundaries.",
    "detail": "Pick fun theme outfits for each other at a thrift store or from your own closet.",
    "gradient": "linear-gradient(135deg, #6e293b, #5f172a)"
  },
  {
    "id": "quest-07",
    "title": "Try-Something-New Passport",
    "category": "quest",
    "budget": "free",
    "location": "out",
    "duration": "30\u201390 min",
    "costEstimate": "$0\u201325 depending on activity",
    "equipment": [
      "A safe public place, local business, attraction, or home alternative"
    ],
    "mission": "Complete a tiny passport of three discoveries in a place or activity new to at least one of you.",
    "howToPlay": [
      "1. Choose a public place, free attraction, business, library, or park.",
      "2. Agree on travel limit, time, and budget.",
      "3. Select three missions from the passport list.",
      "4. Complete missions by noticing, asking permitted questions, or writing observations.",
      "5. Record one discovery per partner.",
      "6. Decide if it's a place you would return to."
    ],
    "atHomeAlternative": "Explore a part of your home, nearby street, park, or free online museum virtual tour.",
    "importantRule": "Respect local rules and posted access limits. Spending is never required.",
    "detail": "Visit a new local spot and complete three passport discovery missions.",
    "gradient": "linear-gradient(135deg, #7e293b, #6f172a)"
  }
],
  'pack-arcade': [
  {
    "id": "arcade-01",
    "title": "Blind Portrait Battle",
    "category": "arcade",
    "budget": "free",
    "location": "home",
    "duration": "10\u201320 min",
    "costEstimate": "$0",
    "equipment": [
      "Paper and pens/pencils. Digital drawing allowed."
    ],
    "mission": "Draw a portrait of your partner without looking down at the page while drawing.",
    "howToPlay": [
      "1. Sit facing each other.",
      "2. Each player gets one sheet of paper.",
      "3. Look at partner's face, then look away from your page.",
      "4. Set 60-second timer and draw without looking down.",
      "5. Reveal both portraits together.",
      "6. Play three rounds with new prompts."
    ],
    "atHomeAlternative": "Draw in the air with a finger while your partner guesses, or use touchscreen apps.",
    "importantRule": "Keep jokes affectionate. Never criticize partner's physical appearance.",
    "detail": "Draw hilarious portraits of each other without glancing down at the paper.",
    "gradient": "linear-gradient(135deg, #581c87, #3b0764)"
  },
  {
    "id": "arcade-02",
    "title": "Silent Build Challenge",
    "category": "arcade",
    "budget": "free",
    "location": "home",
    "duration": "10\u201320 min",
    "costEstimate": "$0",
    "equipment": [
      "Paper, cups, blocks, pillows, or household objects"
    ],
    "mission": "Build a structure together without speaking, coordinating only through gestures and pointing.",
    "howToPlay": [
      "1. Choose a build theme.",
      "2. Gather up to ten safe objects.",
      "3. Set 3-minute building timer.",
      "4. May not speak, write, or type during build round.",
      "5. Point, demonstrate movements, or hand over materials.",
      "6. Inspect result and explain intended actions."
    ],
    "atHomeAlternative": "Use hand gestures to build an imaginary structure together, adding invisible components.",
    "importantRule": "Use safe materials. Speak immediately if safety requires it.",
    "detail": "Cooperate silently to build structures using gestures and teamwork.",
    "gradient": "linear-gradient(135deg, #681c87, #4b0764)"
  },
  {
    "id": "arcade-03",
    "title": "Paper Airplane Championship",
    "category": "arcade",
    "budget": "free",
    "location": "home",
    "duration": "10\u201320 min",
    "costEstimate": "$0",
    "equipment": [
      "Scrap paper and a safe clear area"
    ],
    "mission": "Create paper airplanes and compete in distance, accuracy, and smooth landing rounds.",
    "howToPlay": [
      "1. Each player gets one sheet of paper.",
      "2. Take two minutes to fold an airplane.",
      "3. Choose a clear area away from faces/breakables.",
      "4. Take one practice throw.",
      "5. Play distance, accuracy, and smooth landing rounds.",
      "6. Refine design and try again if time allows."
    ],
    "atHomeAlternative": "Describe plane designs and predict performance, or use soft lightweight objects.",
    "importantRule": "Only throw in clear areas away from people, pets, or fragile objects.",
    "detail": "Fold and compete with paper airplanes across distance and accuracy trials.",
    "gradient": "linear-gradient(135deg, #781c87, #5b0764)"
  },
  {
    "id": "arcade-04",
    "title": "Couple Trivia Ladder",
    "category": "arcade",
    "budget": "free",
    "location": "home",
    "duration": "15\u201325 min",
    "costEstimate": "$0",
    "equipment": [
      "Questions on this card"
    ],
    "mission": "Climb a trivia ladder of questions from favorites to shared memories and future plans.",
    "howToPlay": [
      "1. Take turns choosing questions from ladder.",
      "2. Listening partner guesses the response before reveal.",
      "3. Answering partner gives real answer and explanation.",
      "4. Award 1 point for close/correct guess.",
      "5. Play at least eight questions equally.",
      "6. Skip any question that feels unhelpful."
    ],
    "atHomeAlternative": "Play verbally while sitting together, walking, or over a phone call.",
    "importantRule": "Preferences change; don't treat wrong guesses as lack of care. Skip sensitive questions.",
    "detail": "Climb a trivia ladder testing how well you know each other's preferences and memories.",
    "gradient": "linear-gradient(135deg, #881c87, #6b0764)"
  },
  {
    "id": "arcade-05",
    "title": "Mystery Object Charades",
    "category": "arcade",
    "budget": "free",
    "location": "home",
    "duration": "10\u201320 min",
    "costEstimate": "$0",
    "equipment": [
      "Household objects or imaginary objects"
    ],
    "mission": "Act out ordinary, ridiculous, or imaginary objects without speaking or making sounds.",
    "howToPlay": [
      "1. Choose five prompts from deck.",
      "2. Actor chooses one prompt secretly.",
      "3. 30 seconds to mime object using gestures only.",
      "4. Guesser gets up to three guesses.",
      "5. Switch roles after each round.",
      "6. Play at least six rounds equally."
    ],
    "atHomeAlternative": "Use imaginary object prompts or mime objects remembered from daily life.",
    "importantRule": "Avoid movements that cause injury. Swap prompts without penalty.",
    "detail": "Mime household or imaginary objects in a fast-paced game of silent charades.",
    "gradient": "linear-gradient(135deg, #981c87, #7b0764)"
  },
  {
    "id": "arcade-06",
    "title": "Five-Minute Pitch Battle",
    "category": "arcade",
    "budget": "free",
    "location": "home",
    "duration": "10\u201320 min",
    "costEstimate": "$0",
    "equipment": [
      "None. Timer is optional."
    ],
    "mission": "Invent a ridiculous product or service and pitch it in 60 seconds like a TV investor pitch.",
    "howToPlay": [
      "1. Select one prompt from pitch deck.",
      "2. Take two minutes to prepare concept.",
      "3. Give 60-second pitch (name, problem, solution, appeal).",
      "4. Listener gets 30 seconds to ask one question.",
      "5. Switch roles for second pitch.",
      "6. Choose a winner or combine into a shared invention."
    ],
    "atHomeAlternative": "Pitch imaginary products verbally, over phone, or write short lines.",
    "importantRule": "Keep ideas playful. Sell the imaginary product without criticizing real habits.",
    "detail": "Pitch ridiculous imaginary products and services to each other in 60 seconds.",
    "gradient": "linear-gradient(135deg, #a81c87, #8b0764)"
  },
  {
    "id": "arcade-07",
    "title": "The Invention Lab",
    "category": "arcade",
    "budget": "free",
    "location": "home",
    "duration": "20\u201330 min",
    "costEstimate": "$0",
    "equipment": [
      "Paper and pencils, or verbal design"
    ],
    "mission": "Work together to design a creative solution to an everyday annoyance or impossible problem.",
    "howToPlay": [
      "1. Choose one problem from challenge list.",
      "2. Spend 2 minutes thinking independently.",
      "3. Share ideas and combine best parts.",
      "4. Spend 10 minutes sketching or describing combined invention.",
      "5. Name it, list three features, explain usage.",
      "6. Present at an imaginary invention fair."
    ],
    "atHomeAlternative": "Describe invention, name components, and demonstrate verbally.",
    "importantRule": "Concept-design only. Do not attempt building devices involving electricity or hazards.",
    "detail": "Collaborate on designing clever conceptual solutions to everyday annoyances.",
    "gradient": "linear-gradient(135deg, #b81c87, #9b0764)"
  }
]
};

let p1Deck = [], p2Deck = [], p1Likes = [], p2Likes = [];
let swipePlayer = 1, swipeIndex = 0, draftItems = [], draftTurn = 1;
let peer = null, conn = null, remoteRoomId = null, myPlayerNum = 1;
let remoteSubmitSent = false;
let remoteFinalVotes = {
  host: null,
  guest: null
};
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

  remoteFinalVotes = {
    host: null,
    guest: null
  };

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

  // Send the exact shortlist to the guest so both players vote on the same options.
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
          // Host records their own vote.
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
          // Guest sends a vote to the host.
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

      // Local, same-device play.
      modal.classList.remove('show');
      window.currentWinner = item;

      showModal(
        'Winner Selected!',
        item.title,
        item.detail
      );
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

  // Both players selected the same idea.
  if (remoteFinalVotes.host === remoteFinalVotes.guest) {
    const winner = finalVotingCandidates.find(
      item => item.id === remoteFinalVotes.host
    );

    if (!winner) return false;

    window.currentWinner = winner;

    const votingModal = getEl('votingModal');

    if (votingModal) {
      votingModal.classList.remove('show');
    }

    sendP2PMessage({
      type: 'CHOOSE_WINNER',
      winnerId: winner.id
    });

    showModal(
      'You Both Chose It!',
      winner.title,
      winner.detail
    );

    return true;
  }

  // Their votes differed. Reopen the vote instead of choosing for them.
  const candidates = [...finalVotingCandidates];
  const wasMutual = finalVotingMutual;

  remoteFinalVotes = {
    host: null,
    guest: null
  };

  showToast(
    'Your votes differed. Please choose again and try to agree.'
  );

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

  if (item.location !== 'out') {
    showToast(
      'This is an at-home date; no map is needed. Check the date instructions.'
    );
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

  showToast(
    `Starting date: ${item.title}! Have a wonderful time.`
  );

  if (item.location === 'out') {
    openCurrentCardMap();
  } else {
    showToast(
      'At-home date selected—no map will be opened.'
    );
  }
}

async function exportBackup() {
  const data = {
    version: '2.9.1',
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

      if (Array.isArray(data.deletedBuiltins)) {
        deletedBuiltins = new Set(
          data.deletedBuiltins.filter(
            id => typeof id === 'string'
          )
        );

        if (!useMemoryFallback && db) {
          await db.deletedBuiltins.clear();

          if (deletedBuiltins.size) {
            await db.deletedBuiltins.bulkPut(
              [...deletedBuiltins].map(id => ({ id }))
            );
          }
        }
      }

      if (Array.isArray(data.selectedCategories)) {
        selectedCategories = [
          ...new Set(
            data.selectedCategories.filter(
              value =>
                typeof value === 'string' &&
                DEFAULT_CATEGORIES.includes(value)
            )
          )
        ];

        if (!useMemoryFallback && db) {
          await db.categories.put({
            id: 'selectedCats',
            values: selectedCategories
          });
        }

        document.querySelectorAll('.category-choice').forEach(input => {
          input.checked = selectedCategories.includes(input.value);
        });
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
    showToast(
      'Invalid date or time format entered. Please use YYYY-MM-DD and HH:MM.'
    );
    return;
  }

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);

  const start = new Date(
    year,
    month - 1,
    day,
    hour,
    minute,
    0,
    0
  );

  if (
    start.getFullYear() !== year ||
    start.getMonth() !== month - 1 ||
    start.getDate() !== day ||
    start.getHours() !== hour ||
    start.getMinutes() !== minute
  ) {
    showToast(
      'That date or time does not exist. Check the day, month, and time.'
    );
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