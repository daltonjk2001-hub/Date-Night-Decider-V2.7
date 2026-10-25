'use strict';

/* Date Night Decider — version 2.7.2 with robust defensive wrappers,
   graceful storage fallbacks, and bulletproof P2P connection handling. */

// Safe DOM helper to prevent null-reference runtime exceptions
const getEl = id => document.getElementById(id);

if (typeof Dexie === 'undefined') {
  document.body.insertAdjacentHTML('afterbegin', '<div style="padding:16px;background:#5b1730;color:white;font:16px sans-serif">Date Night Decider could not load its database library. Check your internet connection and reload.</div>');
  throw new Error('Dexie.js failed to load.');
}

// Resilient IndexedDB initialization with in-memory fallback flag
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
  { id:'baking-01', title:'Apple-Blackberry Lattice Pie', detail:'Make an all-butter pie dough from scratch, roll out a woven lattice top, and fill with fresh apple and blackberry.', category:'baking', budget:'paid', location:'home', gradient:'linear-gradient(135deg, #4a1525, #831843)' },
  { id:'baking-02', title:'Cream Cheese Danish Batch', detail:'Make laminated pastry dough from scratch, fill with sweet cream cheese and fruit preserves, and bake until golden.', category:'baking', budget:'paid', location:'home', gradient:'linear-gradient(135deg, #3b1f2b, #701a75)' },
  { id:'cooking-01', title:'Homemade Gourmet Pizza Night', detail:'Stretch homemade dough from scratch, layer with custom sauces, premium cheese, and your favorite toppings.', category:'cooking', budget:'paid', location:'home', gradient:'linear-gradient(135deg, #1e293b, #0f172a)' },
  { id:'cooking-02', title:'Authentic Street Taco Bar', detail:'Prep slow-cooked carnitas or grilled chicken with homemade salsas, fresh cilantro, and warm corn tortillas.', category:'cooking', budget:'paid', location:'home', gradient:'linear-gradient(135deg, #451a03, #78350f)' },
  { id:'gaming-01', title:'Cozy Split-Screen Co-Op', detail:'Load up a relaxing couch co-op video game and work together to build a shared virtual world or solve puzzles.', category:'gaming', budget:'free', location:'home', gradient:'linear-gradient(135deg, #064e3b, #022c22)' },
  { id:'gaming-02', title:'Arcade High Score Showdown', detail:'Play classic arcade games or fast-paced party games and battle head-to-head for the top spot.', category:'gaming', budget:'paid', location:'out', gradient:'linear-gradient(135deg, #172554, #1e3a8a)' },
  { id:'board-01', title:'Intense Strategy Board Game', detail:'Brew some coffee or tea, clear the table, and dive into a deep tabletop strategy or card drafting game.', category:'board games', budget:'free', location:'home', gradient:'linear-gradient(135deg, #312e81, #1e1b4b)' },
  { id:'board-02', title:'Fast-Paced Party Card Game', detail:'Pull out a hilarious casual card game for quick laughs and lighthearted competition.', category:'board games', budget:'free', location:'home', gradient:'linear-gradient(135deg, #581c87, #3b0764)' },
  { id:'tv-01', title:'Nostalgic TV Show Pilot Night', detail:'Rewatch the pilot episodes of your favorite childhood TV series together.', category:'tv', budget:'free', location:'home', gradient:'linear-gradient(135deg, #831843, #500724)' },
  { id:'tv-02', title:'Binge-Worthy Mystery Series', detail:'Stream the opening episodes of a gripping new thriller or mystery show.', category:'tv', budget:'free', location:'home', gradient:'linear-gradient(135deg, #0f766e, #115e59)' },
  { id:'movie-01', title:'First-Time Epic Adventure', detail:'Stream a critically acclaimed adventure or sci-fi movie that neither of you has ever seen.', category:'movie', budget:'free', location:'home', gradient:'linear-gradient(135deg, #31103f, #190a24)' },
  { id:'movie-02', title:'Local Cinema Night Out', detail:'Get dressed up, grab buttery popcorn at the local movie theater, and catch the latest release.', category:'movie', budget:'paid', location:'out', gradient:'linear-gradient(135deg, #6b21a8, #4c1d95)' }
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
      promptDeck: [
        { title: 'Round 1 — Their Favorite Color', text: 'Find something in your partner\'s favorite color. Explain why they would choose it for themselves.' },
        { title: 'Round 2 — The Funniest Find', text: 'Find an item with the funniest name, strangest packaging, or most ridiculous description. Make your partner laugh.' },
        { title: 'Round 3 — The $3 Date', text: 'Find an item priced at $3 or less that could make a date more fun. Explain the date you would build around it.' },
        { title: 'Round 4 — A Memory in an Item', text: 'Find something that reminds you of childhood, a meaningful memory, or a special moment. Tell the story.' },
        { title: 'Round 5 — The Dream-Date Object', text: 'Choose an object that could inspire an unusual date. Pitch the idea in 30 seconds.' },
        { title: 'Round 6 — The Mystery Pick', text: 'Choose something you think your partner has never tried or noticed. Partner gets one guess.' },
        { title: 'Bonus Round — Same Wavelength', text: 'Choose an item representing your ideal cozy night together without discussing it first.' }
      ],
      scoring: ['1 point for completing a prompt.', '1 bonus point when partner correctly guesses reasoning.', '1 bonus point for selecting the same or similar items.', 'Highest points wins; bonus round breaks ties.'],
      atHomeAlternative: 'Use pantry items, refrigerator contents, books, clothing, or other household objects.',
      importantRule: 'No purchases required. Do not open products or disrupt shoppers. Spending cap is $5 combined.',
      detail: 'A retail or pantry scavenger hunt where understanding your partner yields the highest score.',
      gradient: 'linear-gradient(135deg, #31103f, #190a24)'
    },
    {
      id: 'viral-02', title: 'Trunk-Side Studio', category: 'micro-adventure', budget: 'free', location: 'out', duration: '30–45 min',
      costEstimate: '$0–15', equipment: ['Paper', 'Pens or markers', 'Flat surface', 'Optional: blanket, clipboard, craft supplies'],
      mission: 'Turn a safe, comfortable spot into a tiny outdoor art studio and create a mini gallery for each other.',
      howToPlay: ['Pick a safe location away from moving traffic.', 'Set up on a table, blanket, or stable surface.', 'Select three prompts from the deck.', 'Both players create drawings (stick figures encouraged).', 'Present creations with a title and 20s statement.', 'Vote for gallery awards.'],
      promptDeck: [
        { title: 'Prompt 1 — Us as Cartoon Characters', text: 'Draw yourselves as animated characters with one exaggerated feature.' },
        { title: 'Prompt 2 — Our Dream Destination', text: 'Draw a place you would love to visit with an activity and food included.' },
        { title: 'Prompt 3 — The World\'s Worst Superhero', text: 'Invent a superhero based on your partner with a ridiculous power and hero name.' },
        { title: 'Prompt 4 — Our Relationship as a Weather Forecast', text: 'Draw a weather map representing your relationship today and explain the forecast.' },
        { title: 'Prompt 5 — The Perfect Tiny House', text: 'Design a tiny house with three must-have features and one absurd luxury.' },
        { title: 'Prompt 6 — Our Future Mascot', text: 'Invent a couple mascot creature with a name, personality, and special ability.' }
      ],
      scoring: ['Vote for Most Creative.', 'Vote for Funniest Result.', 'Vote for Most Romantic or Meaningful.'],
      atHomeAlternative: 'Set up beside a window, on a patio, at a kitchen table, or on the couch with clipboards.',
      importantRule: 'Focus on expression over skill. Keep the location safe and comfortable.',
      detail: 'Create a pop-up art gallery using playful prompts and hilarious artist statements.',
      gradient: 'linear-gradient(135deg, #38103f, #230a24)'
    },
    {
      id: 'viral-03', title: 'Seven Treasures Exchange', category: 'micro-adventure', budget: 'free', location: 'either', duration: '20–40 min',
      costEstimate: '$0', equipment: ['Seven meaningful objects, photographs, or memories per person'],
      mission: 'Gather seven small items or memories that tell a story about who you are and what you value.',
      howToPlay: ['Privately choose one item per prompt.', 'Gather choices in 5 minutes.', 'Take turns revealing one treasure at a time.', 'Partner guesses reasoning before explanation.', 'Ask one respectful follow-up question.', 'Select favorite treasure.'],
      promptDeck: [
        { title: 'Treasure 1 — A Piece of Childhood', text: 'Choose something that reminds you of when you were younger.' },
        { title: 'Treasure 2 — A Personal Victory', text: 'Choose something connected to a moment you were proud of yourself.' },
        { title: 'Treasure 3 — A Comfort Item', text: 'Choose something that helps you feel calm, safe, or at home.' },
        { title: 'Treasure 4 — A Person Who Shaped You', text: 'Choose an object or photograph connected to an influential figure.' },
        { title: 'Treasure 5 — A Hidden Interest', text: 'Choose something representing a hobby or dream your partner may not fully know.' },
        { title: 'Treasure 6 — A Relationship Memory', text: 'Choose something that reminds you of an important moment together.' },
        { title: 'Treasure 7 — A Future Treasure', text: 'Choose or describe something you would love to experience together.' }
      ],
      scoring: ['1 bonus point for guessing 3+ treasure meanings correctly.', 'Stories are the main event.'],
      atHomeAlternative: 'Use phone photographs, digital keepsakes, songs, saved messages, or verbal descriptions.',
      importantRule: 'No one has to share anything painful or uncomfortable. Pass without explanation.',
      detail: 'Share seven meaningful keepsakes or digital memories to deepen personal connection.',
      gradient: 'linear-gradient(135deg, #4a1525, #831843)'
    },
    {
      id: 'viral-04', title: 'Alphabet Culinary Crawl', category: 'cooking', budget: 'paid', location: 'either', duration: '30–60 min',
      costEstimate: '$0–30+', equipment: ['Phone or paper for notes', 'Access to kitchen or shops', 'Spending limit'],
      mission: 'Build a food mini-adventure around three letters of the alphabet and design a menu.',
      howToPlay: ['Use letters C, M, and S.', 'Set a combined spending limit ($0 default).', 'Find foods/drinks beginning with each letter.', 'Match special prompt per round.', 'Design a pretend restaurant menu.'],
      promptDeck: [
        { title: 'C — Comfort Food', text: 'Find a food beginning with C for rainy or stressful days (e.g., crackers, chili, cookies).' },
        { title: 'M — Memory Food', text: 'Find a food beginning with M tied to childhood or tradition (e.g., muffins, mango).' },
        { title: 'S — Surprise Food', text: 'Find an unexpected S food for your dream menu (e.g., strawberries, soup).' },
        { title: 'Bonus — Secret Menu', text: 'Choose a 4th letter together and invent a secret item.' }
      ],
      scoring: ['1 point per completed letter mission.', '1 bonus point for best menu name.', '1 bonus point for best explanation.', 'Winner names the restaurant.'],
      atHomeAlternative: 'Explore pantry contents, grocery flyers, or recipe collections.',
      importantRule: 'Do not exceed agreed budget. No tasting is required. Respect dietary needs.',
      detail: 'Hunt for alphabet-themed foods to construct a humorous menu.',
      gradient: 'linear-gradient(135deg, #451a03, #78350f)'
    },
    {
      id: 'viral-05', title: 'Architectural Fort Cinema', category: 'movie', budget: 'free', location: 'home', duration: '30–60 min',
      costEstimate: '$0–10', equipment: ['Blankets', 'Pillows', 'Couch/Chairs', 'Screen for watching'],
      mission: 'Construct a themed blanket fort cinema and watch a movie selected by house rules.',
      howToPlay: ['Select a fort theme.', 'Build for 10 minutes (add 2+ features each).', 'Name fort and create tickets.', 'Select movie using coin toss trial rules.', 'Predict one movie plot point before watching.'],
      promptDeck: [
        { title: 'Theme 1 — Secret Agent Hideout', text: 'Secret entrance, code word, snack stash.' },
        { title: 'Theme 2 — Luxury Movie Palace', text: 'Maximum comfort seating with pillow concierge service.' },
        { title: 'Theme 3 — Space Station Cinema', text: 'Spaceship seating, captain\'s seat, pre-credits mission.' },
        { title: 'Theme 4 — Cozy Rainy-Day Cabin', text: 'Cabin feel with real getaway features.' },
        { title: 'Theme 5 — Tiny Fantasy Kingdom', text: 'Kingdom name, royal snacks, silly cinema laws.' }
      ],
      scoring: ['Vote for Best Fort Feature.', 'Vote for Best Movie Prediction.', 'Vote for Most Convincing Fort Name.'],
      atHomeAlternative: 'Rearrange couch cushions or create a simple blanket canopy over a laptop.',
      importantRule: 'Keep structures stable. Never block exits, cover heaters, or place blankets near flames.',
      detail: 'Build an architectural blanket hideaway for an elevated film screening.',
      gradient: 'linear-gradient(135deg, #831843, #500724)'
    },
    {
      id: 'viral-06', title: 'Reverse Date Roulette', category: 'micro-adventure', budget: 'free', location: 'home', duration: '20–45 min',
      costEstimate: '$0–15', equipment: ['Coin or random number tool', 'Household items'],
      mission: 'Let random chance choose an activity, then let your partner add a rule twist.',
      howToPlay: ['Select numbers 1-12 privately.', 'Randomly select one number.', 'Flip coin for director role.', 'Director starts; partner adds a twist.', 'Play 10 min, then switch roles.'],
      promptDeck: [
        { title: 'Activity Deck', text: '1: Drawing Duel, 2: Pantry Picnic, 3: Song Memory Swap, 4: Dream Trip Planning, 5: Scavenger Hunt, 6: Movie Pitch, 7: Compliment Ping-Pong, 8: Obstacle Course, 9: Mystery Playlist, 10: Build Something Tiny, 11: Memory Lane Quiz, 12: Cozy Reset.' },
        { title: 'Twist Deck', text: '5-minute prep limit, Everything sitting down, Include an item you own, Give activity a silly name, Team challenge mode, Add tiny award ceremony.' }
      ],
      scoring: ['No overall winner. Award partner "Best Twist" at the end.'],
      atHomeAlternative: 'All activities fully playable at home using standard household items.',
      importantRule: 'Both partners hold veto power without penalty.',
      detail: 'Combine random mini-activities with partner-chosen rule twists.',
      gradient: 'linear-gradient(135deg, #1f122e, #3b1f2b)'
    },
    {
      id: 'viral-07', title: 'One Object, Three Uses', category: 'arcade', budget: 'free', location: 'home', duration: '15–25 min',
      costEstimate: '$0', equipment: ['One household object (spoon, box, sock, cup)', 'Timer'],
      mission: 'Reinvent an ordinary household object into three distinct inventions.',
      howToPlay: ['Choose a safe object.', '60 seconds to invent a new use.', 'Present pitch in 20 seconds.', 'Play 3 rounds with different objects.', 'Create a joint signature invention.'],
      promptDeck: [
        { title: 'Round 1 — Solve an Annoyance', text: 'Solve an everyday hassle like tangled cables or lost keys.' },
        { title: 'Round 2 — Make Life Ridiculous', text: 'Completely unnecessary invention designed purely for humor.' },
        { title: 'Round 3 — Save the World', text: 'Help with an imaginary emergency like giant bubble invasions.' },
        { title: 'Final Round — Signature Invention', text: 'Combine best ideas into one item with product name, slogan, and ad.' }
      ],
      scoring: ['1 point for most original idea per round.', '1 point for funniest explanation.', '1 shared point for combined final invention.'],
      atHomeAlternative: 'Use imaginary objects or simple drawings if no physical object is nearby.',
      importantRule: 'Use safe objects only. No sharp tools, hot appliances, or glass.',
      detail: 'Compete to create the funniest alternative uses for basic household items.',
      gradient: 'linear-gradient(135deg, #581c87, #3b0764)'
    }
  ],
  'pack-coop': [
    {
      id: 'coop-01', title: 'The 20-Minute Build-Off', category: 'gaming', budget: 'free', location: 'home', duration: '25–35 min',
      costEstimate: '$0 (with existing game)', equipment: ['Sandbox/Building video game or paper/pencils'],
      mission: 'Create sandbox structures based on a shared theme within a 20-minute timer.',
      howToPlay: ['Select build theme.', 'Gather resources for 2 minutes.', 'Build for 20 minutes.', 'Give a tour and explain 3 favorite features.', 'Score structures.'],
      promptDeck: [
        { title: 'Theme 1 — Coziest Cabin', text: 'Sleeping area, food prep, light source, custom decoration.' },
        { title: 'Theme 2 — Over-the-Top Pet House', text: 'Bed, feeding zone, play area, absurd luxury feature.' },
        { title: 'Theme 3 — Tiny Dream Home', text: 'Living space, private retreat, hangout area, real-life wish feature.' },
        { title: 'Theme 4 — Secret Base', text: 'Hidden entrance, supply storage, meeting room, secret feature.' },
        { title: 'Theme 5 — Worst Tourist Attraction', text: 'Intentionally awful attraction with a 20-second sales pitch.' }
      ],
      scoring: ['1 point for meeting theme.', '1 point for best detail.', '1 point for creativity.', '1 point for presentation.'],
      atHomeAlternative: 'Draw top-down floor plans on grid paper and label key features.',
      importantRule: 'Use games already owned. No new purchases required.',
      detail: 'A timed creative building competition in video games or on paper.',
      gradient: 'linear-gradient(135deg, #064e3b, #022c22)'
    },
    {
      id: 'coop-02', title: 'Secret Base Blueprint', category: 'gaming', budget: 'free', location: 'home', duration: '30–45 min',
      costEstimate: '$0', equipment: ['Creative/survival game or paper'],
      mission: 'Co-design a secret base by alternating roles between Planner and Builder.',
      howToPlay: ['Assign roles: Planner & Builder.', 'Planner briefs layout in 2 minutes.', 'Build/draw for 10 minutes.', 'Switch roles and add upgrades.', 'Tour base and reveal secret features.'],
      promptDeck: [
        { title: 'Zone 1 — Entrance', text: 'Recognizable yet hidden or protected entry.' },
        { title: 'Zone 2 — Supply Room', text: 'Organized storage for 3 supply categories.' },
        { title: 'Zone 3 — Shared Hangout', text: 'Comfortable meeting area both partners enjoy.' },
        { title: 'Zone 4 — Emergency Exit', text: 'Safe escape route or alternate path.' },
        { title: 'Zone 5 — Secret Room', text: 'Hidden feature added without partner knowing until tour.' },
        { title: 'Zone 6 — Ridiculous Upgrade', text: 'Impractical luxury (indoor waterfall, trophy hall).' }
      ],
      scoring: ['1 point per completed zone (up to 6).', '1 bonus point for best secret room feature.'],
      atHomeAlternative: 'Draw top-down architectural blueprints on paper with movement arrows.',
      importantRule: 'Never destroy partner structures or spend premium resources.',
      detail: 'A collaborative base-building challenge with role-switching and secret reveals.',
      gradient: 'linear-gradient(135deg, #047857, #064e3b)'
    },
    {
      id: 'coop-03', title: 'Roles Reversed', category: 'gaming', budget: 'free', location: 'home', duration: '20–40 min',
      costEstimate: '$0', equipment: ['Co-op game with clear roles or paper mazes'],
      mission: 'Swap typical gaming responsibilities so the novice leads and the veteran supports.',
      howToPlay: ['Select co-op mission or level.', 'Identify lead vs support roles.', 'Experienced player takes support role for first half.', 'Novice makes tactical decisions.', 'Switch roles for second half.'],
      promptDeck: [
        { title: 'Mission 1 — Navigator Takes Charge', text: 'Usual navigator makes route decisions.' },
        { title: 'Mission 2 — The New Captain', text: 'Novice makes major decisions; veteran advises only when asked.' },
        { title: 'Mission 3 — Support Specialist', text: 'Veteran focuses purely on buffing and resourcing.' },
        { title: 'Mission 4 — Teacher Becomes Student', text: 'Veteran follows novice directions for 5 minutes without taking over.' },
        { title: 'Mission 5 — No-Backseat Round', text: 'Independent decision-making with post-round debrief.' }
      ],
      scoring: ['1 point for completing objective.', '1 point for clear communication.', '1 point for dual leadership.'],
      atHomeAlternative: 'Complete blindfolded paper mazes with verbal direction.',
      importantRule: 'Maintain patience. Veteran must not sabotage or take over control.',
      detail: 'A co-op game session focused on role swapping, patience, and communication.',
      gradient: 'linear-gradient(135deg, #0f766e, #115e59)'
    },
    {
      id: 'coop-04', title: 'In-Game Scavenger Hunt', category: 'gaming', budget: 'free', location: 'home', duration: '20–45 min',
      costEstimate: '$0', equipment: ['Open-world/exploration video game'],
      mission: 'Locate five specific in-game items or locations within a 25-minute timer.',
      howToPlay: ['Choose safe exploration zone.', 'Set 25-minute countdown timer.', 'Work together to locate targets.', 'Capture screenshots or bring items to base.', 'Return before time expires.'],
      promptDeck: [
        { title: 'Target 1 — Something Bright', text: 'Unusual or vibrant colored object or landmark.' },
        { title: 'Target 2 — Something Rare', text: 'Item or creature not seen every session.' },
        { title: 'Target 3 — Place with a View', text: 'High point or scenic overlook.' },
        { title: 'Target 4 — Safe Shelter', text: 'Location where team can pause safely.' },
        { title: 'Target 5 — Partner Pick', text: 'Target selected by your partner.' }
      ],
      scoring: ['1 point per target found (5 max).', '1 bonus point for completing before timer ends.'],
      atHomeAlternative: 'Perform a household hunt for bright, rare, or scenic items.',
      importantRule: 'Use base game features only. Paid expansions not required.',
      detail: 'Explore virtual worlds together to find five specified landmarks or secrets.',
      gradient: 'linear-gradient(135deg, #172554, #1e3a8a)'
    },
    {
      id: 'coop-05', title: 'First-Night Survival', category: 'gaming', budget: 'free', location: 'home', duration: '30–60 min',
      costEstimate: '$0', equipment: ['Survival/crafting game or household cushions'],
      mission: 'Establish a safe home base and gather core resources before night falls.',
      howToPlay: ['Start new world/save.', 'Set 30-minute timer.', 'Assign Scout & Builder roles.', 'Scout gathers resources; Builder plans shelter.', 'Switch roles after 10 min.', 'Name base.'],
      promptDeck: [
        { title: 'Objective 1 — Find Home Base', text: 'Select protected ground near resources.' },
        { title: 'Objective 2 — Gather 3 Resources', text: 'Collect building materials, food, and fuel.' },
        { title: 'Objective 3 — Establish Shelter', text: 'Construct entry, rest zone, and storage space.' },
        { title: 'Objective 4 — Survival Plan', text: 'Identify main hazard and counter-strategy.' },
        { title: 'Objective 5 — Shared Goal', text: 'Set next major milestone objective.' }
      ],
      scoring: ['Team Victory earned when all 5 survival objectives are completed.'],
      atHomeAlternative: 'Build a living-room blanket fort and collect 3 resource categories.',
      importantRule: 'Play on relaxed difficulty to keep the experience stress-free.',
      detail: 'Survive the first night in a crafting game by coordinating resource gathering.',
      gradient: 'linear-gradient(135deg, #1e1b4b, #312e81)'
    },
    {
      id: 'coop-06', title: 'Build Our Dream Date', category: 'gaming', budget: 'free', location: 'home', duration: '30–45 min',
      costEstimate: '$0', equipment: ['Creative sandbox game or paper sketches'],
      mission: 'Construct the ultimate virtual date location inside a video game.',
      howToPlay: ['Choose location theme.', 'Set 25-minute build timer.', 'Each player adds 3+ key features.', 'Give 1-minute mid-build tour at 15m.', 'Add partner-requested details.', 'Write virtual listing.'],
      promptDeck: [
        { title: 'Theme 1 — Rainy-Day Retreat', text: 'Relaxation spot, warm drinks, view window.' },
        { title: 'Theme 2 — Rooftop Under Stars', text: 'Viewing area, cozy seating, mood lighting.' },
        { title: 'Theme 3 — Fantasy Garden', text: 'Nature path, quiet nook, magical detail.' },
        { title: 'Theme 4 — Beachside Escape', text: 'Shoreline seating, dining spot, privacy feature.' },
        { title: 'Theme 5 — Dream Home Date Room', text: 'Custom feature for each partner plus shared spot.' }
      ],
      scoring: ['Rate partner design 1-5 for comfort, creativity, and personal touches.'],
      atHomeAlternative: 'Sketch floor plans and mood boards together on paper.',
      importantRule: 'Do not buy premium cosmetic packs or microtransactions.',
      detail: 'Design and build your dream date getaway spot inside a sandbox game.',
      gradient: 'linear-gradient(135deg, #31103f, #190a24)'
    },
    {
      id: 'coop-07', title: 'Game-to-Real-Life Remix', category: 'arcade', budget: 'free', location: 'home', duration: '20–45 min',
      costEstimate: '$0–5', equipment: ['Paper', 'Pencils', 'Recycled cardboard/craft supplies (optional)'],
      mission: 'Translate a video game mechanic or concept into a physical creation.',
      howToPlay: ['Select prompt concept.', 'Pick safe construction materials.', 'Set 10-minute build timer.', 'Craft individual or joint model.', 'Present name, function, and demonstration.'],
      promptDeck: [
        { title: 'Prompt 1 — Helpful Gadget', text: 'Real-world tool solving an everyday hassle.' },
        { title: 'Prompt 2 — Friendly Creature', text: 'Original companion with a special ability.' },
        { title: 'Prompt 3 — Portable Base', text: 'Model of compact travel shelter with storage.' },
        { title: 'Prompt 4 — Real-Life Power-Up', text: 'Fictional power-up for chores or daily tasks.' },
        { title: 'Prompt 5 — Quest Object', text: 'Item initiating a 3-step real life quest.' }
      ],
      scoring: ['1 point for clear utility.', '1 point for originality.', '1 point for presentation.'],
      atHomeAlternative: 'Draw conceptual designs or pitch ideas verbally without physical crafting.',
      importantRule: 'Avoid sharp tools or unsafe materials.',
      detail: 'Turn digital game power-ups, gadgets, and companions into physical crafts.',
      gradient: 'linear-gradient(135deg, #3b0764, #581c87)'
    }
  ],
  'pack-sweet': [
    {
      id: 'sweet-01', title: 'Guided Baking Challenge', category: 'baking', budget: 'paid', location: 'home', duration: '45–75 min',
      costEstimate: '$5–15', equipment: ['Mixing bowl', 'Baking tray', 'Cookie ingredients'],
      mission: 'Bake chocolate-chip cookies with one partner acting as Reader and the other as Lead.',
      howToPlay: ['Assign Recipe Reader & Mixing Lead.', 'Reader checks equipment; Lead measures ingredients.', 'Mix wet ingredients (butter, sugar, egg, vanilla).', 'Combine dry ingredients (flour, baking soda, salt) and fold chips.', 'Bake at 350°F (175°C) for 9-11 mins.', 'Invent bakery name while cooling.'],
      promptDeck: [
        { title: 'Recipe', text: '1/2 cup butter, 3/4 cup sugar, 1 egg, 1 tsp vanilla, 1.5 cups flour, 1/2 tsp baking soda, 1/4 tsp salt, 1/2 cup chocolate chips.' }
      ],
      scoring: ['Award Teamwork Award.', 'Award Best Appearance.', 'Award Creative Bakery Name.'],
      atHomeAlternative: 'Use store-bought cookie dough or boxed mix for easy decorating.',
      importantRule: 'Check dietary restrictions. Never consume raw dough.',
      detail: 'A co-op baking session complete with official bakery naming and team awards.',
      gradient: 'linear-gradient(135deg, #4a1525, #831843)'
    },
    {
      id: 'sweet-02', title: 'Dessert Board Designers', category: 'baking', budget: 'paid', location: 'home', duration: '20–35 min',
      costEstimate: '$5–15', equipment: ['Large plate or cutting board', 'Sweets/fruit/crackers'],
      mission: 'Design a café-style dessert board by styling individual halves and combining them.',
      howToPlay: ['Select up to 5 available ingredients.', 'Divide board into two halves.', 'Set 8-minute timer to style section.', 'Present 30-second statement.', 'Connect sections into one board.'],
      promptDeck: [
        { title: 'Prompt 1 — Color Story', text: 'Emphasize one dominant color palette.' },
        { title: 'Prompt 2 — Sweet & Crunchy', text: 'Pair smooth/soft items with crunch.' },
        { title: 'Prompt 3 — Childhood Favorites', text: 'Feature treats enjoyed growing up.' },
        { title: 'Prompt 4 — Fancy Café on a Budget', text: 'Elevate simple snacks through spacing and styling.' },
        { title: 'Prompt 5 — Surprise Centerpiece', text: 'Place centerpiece item partner must guess.' }
      ],
      scoring: ['Score final board 1-5 for presentation, harmony, and creativity.'],
      atHomeAlternative: 'Style pantry snacks, crackers, or fruit on regular dinner plates.',
      importantRule: 'Wash hands thoroughly. Tasting is optional.',
      detail: 'Design half a dessert charcuterie board, then merge into a master presentation.',
      gradient: 'linear-gradient(135deg, #701a75, #4a1525)'
    },
    {
      id: 'sweet-03', title: 'Dessert Decorating Showdown', category: 'baking', budget: 'paid', location: 'home', duration: '20–40 min',
      costEstimate: '$4–12', equipment: ['Ready-made cookies/cupcakes', 'Icing/toppings'],
      mission: 'Transform ordinary store-bought desserts into themed artistic masterpieces.',
      howToPlay: ['Use ready-made baked goods.', 'Pick theme from prompt deck.', 'Set 5-minute decorating timer per round.', 'Present creation with title.', 'Conduct optional blind vote.'],
      promptDeck: [
        { title: 'Theme 1 — Tiny Vacation', text: 'Inspired by beach, mountain, or city getaway.' },
        { title: 'Theme 2 — Monster Bakery', text: 'Friendly monster with name and backstory.' },
        { title: 'Theme 3 — Partner\'s Personality', text: 'Represent partner using shapes and colors.' },
        { title: 'Theme 4 — Dream Dessert', text: 'Ideal celebration dessert.' },
        { title: 'Theme 5 — Ridiculous Mascot', text: 'Mascot for imaginary sports team or band.' }
      ],
      scoring: ['1 point for theme accuracy.', '1 point for originality.', '1 point for presentation.'],
      atHomeAlternative: 'Decorate pancakes, toast, fruit slices, or paper templates.',
      importantRule: 'Focus on fun and creativity over professional pastry standards.',
      detail: 'Decorate store-bought cupcakes or cookies according to themed story prompts.',
      gradient: 'linear-gradient(135deg, #831843, #500724)'
    },
    {
      id: 'sweet-04', title: 'Sweet & Crunchy Mystery Test', category: 'cooking', budget: 'free', location: 'home', duration: '15–25 min',
      costEstimate: '$0–8', equipment: ['3-5 familiar snacks or items', 'Small plates'],
      mission: 'Guess mystery snacks using texture, shape, sound, and memory clues without blindfolds.',
      howToPlay: ['Gather 3-5 familiar items.', 'Describing player picks mystery item.', 'Give clues without naming item.', 'Listening player gets 3 guesses.', 'Switch roles per round.'],
      promptDeck: [
        { title: 'Round 1 — Texture Clue', text: 'Describe using two texture terms (e.g., crispy, smooth).' },
        { title: 'Round 2 — Shape Clue', text: 'Describe physical geometry without naming food.' },
        { title: 'Round 3 — Memory Clue', text: 'Describe a memory or context where item appears.' },
        { title: 'Round 4 — Three-Word Challenge', text: 'Describe using exactly three words.' },
        { title: 'Round 5 — Sound Clue', text: 'Make packaging sound tap without opening.' }
      ],
      scoring: ['3 points for 1st guess success.', '2 points for 2nd guess.', '1 point for 3rd guess.'],
      atHomeAlternative: 'Use household items, packaging, or imaginary verbal descriptions.',
      importantRule: 'No blindfolds or forced tasting. Check for food allergies first.',
      detail: 'A blindfold-free sensory guessing game based on sound, texture, and memory clues.',
      gradient: 'linear-gradient(135deg, #9f1239, #831843)'
    },
    {
      id: 'sweet-05', title: 'No-Bake Dessert Build-Off', category: 'baking', budget: 'paid', location: 'home', duration: '20–35 min',
      costEstimate: '$4–12', equipment: ['Dessert bases (cookies, yogurt, pudding)', 'Toppings', 'Cups'],
      mission: 'Construct a multi-layer dessert menu entry without using an oven.',
      howToPlay: ['Select up to 5 ingredients.', 'Agree on identical base item.', 'Set 10-minute assembly timer.', 'Create dessert in glass or cup.', 'Present menu description and occasion.', 'Judge entries.'],
      promptDeck: [
        { title: 'Prompt 1 — Cozy Night In', text: 'Dessert tailored for rainy movie night.' },
        { title: 'Prompt 2 — Vacation in a Cup', text: 'Inspired by dream travel destination.' },
        { title: 'Prompt 3 — Sweet & Crunchy', text: 'Combine distinct contrasting textures.' },
        { title: 'Prompt 4 — Fancy Restaurant', text: 'Elevate visual plating to look high-end.' },
        { title: 'Prompt 5 — Signature Creation', text: 'Custom dessert for shared anniversary.' }
      ],
      scoring: ['Vote for Best Name.', 'Vote for Most Creative Combo.', 'Vote for Best Plating.'],
      atHomeAlternative: 'Assemble fruit, cereal, and pantry items, or draw parfait concepts.',
      importantRule: 'Keep portions small and respect dietary preferences.',
      detail: 'Layer no-bake treats into parfait glasses and pitch them as luxury menu items.',
      gradient: 'linear-gradient(135deg, #701a75, #31103f)'
    },
    {
      id: 'sweet-06', title: 'Recreate a Childhood Treat', category: 'cooking', budget: 'free', location: 'home', duration: '30–60 min',
      costEstimate: '$0–12', equipment: ['Childhood snack ingredients or pre-made treats'],
      mission: 'Prepare or enjoy a favorite childhood treat while sharing memories.',
      howToPlay: ['Name childhood favorite privately.', 'Share underlying childhood memory.', 'Prepare or unwrap selected treat.', 'Answer reflection prompts while eating.', 'Give treat a new relationship name.'],
      promptDeck: [
        { title: 'Prompt 1 — First Memory', text: 'Earliest memory connected to this treat.' },
        { title: 'Prompt 2 — The Person', text: 'Who made or shared this treat with you?' },
        { title: 'Prompt 3 — The Occasion', text: 'Holidays, weekends, or ordinary days?' },
        { title: 'Prompt 4 — Modern Upgrade', text: 'What would you modify today?' },
        { title: 'Prompt 5 — Our Version', text: 'What twist makes it belong to your relationship?' }
      ],
      scoring: ['1 point for most vivid memory story.', '1 point for best relationship twist.'],
      atHomeAlternative: 'Unwrap pre-packaged nostalgia snacks or draw childhood treats.',
      importantRule: 'No need to share painful memories. Keep conversations warm.',
      detail: 'Recreate nostalgia snacks from childhood and share the memories behind them.',
      gradient: 'linear-gradient(135deg, #831843, #4a1525)'
    },
    {
      id: 'sweet-07', title: 'Ice Cream Remix', category: 'baking', budget: 'free', location: 'home', duration: '15–25 min',
      costEstimate: '$0–10', equipment: ['Ice cream/yogurt/fruit base', 'Toppings', 'Bowls'],
      mission: 'Craft custom sundae combinations and invent a joint "House Special."',
      howToPlay: ['Choose base (ice cream, yogurt, fruit).', 'Select up to 3 toppings.', 'Pick challenge prompt.', 'Arrange ingredients in 5 minutes.', 'Pitch creation with menu name.', 'Combine ideas into House Special.'],
      promptDeck: [
        { title: 'Prompt 1 — Sweet-and-Salty', text: 'Pair sweet base with crunchy salty topping.' },
        { title: 'Prompt 2 — Vacation Flavor', text: 'Inspired by exotic travel locale.' },
        { title: 'Prompt 3 — Childhood Combo', text: 'Reminiscent of childhood ice cream trucks.' },
        { title: 'Prompt 4 — Unexpected Pair', text: 'Two items not normally combined.' },
        { title: 'Prompt 5 — Restaurant Signature', text: 'Flagship menu dessert.' }
      ],
      scoring: ['1 point for Best Name.', '1 point for Creative Arrangement.', '1 point for Backstory.'],
      atHomeAlternative: 'Mix yogurt, fruit, and cereal, or sketch sundae menus on paper.',
      importantRule: 'Check allergy labels carefully. Tasting optional.',
      detail: 'Mix and match ice cream bases and toppings to create signature menu sundaes.',
      gradient: 'linear-gradient(135deg, #500724, #831843)'
    }
  ],
  'pack-quest': [
    {
      id: 'quest-01', title: 'Bookstore Blind Pick', category: 'quest', budget: 'free', location: 'out', duration: '30–45 min',
      costEstimate: '$0–15', equipment: ['Access to bookstore, library, or home bookshelf'],
      mission: 'Select a secret book for your partner using genre and mood clues instead of covers.',
      howToPlay: ['Set spending budget ($0 default).', 'Privately pick book candidate.', 'Keep title/author hidden.', 'Describe book using prompt clues.', 'Partner gets 3 questions to guess.'],
      promptDeck: [
        { title: 'Prompt 1 — Mood Match', text: 'Fits partner preferred mood (cozy, funny, adventurous).' },
        { title: 'Prompt 2 — Unexpected Genre', text: 'Genre partner doesn\'t usually read.' },
        { title: 'Prompt 3 — First-Page Hook', text: 'Summarize opening page paragraph without title.' },
        { title: 'Prompt 4 — Cover Without Cover', text: 'Describe visual art palette and design.' },
        { title: 'Prompt 5 — Future Conversation', text: 'Book sparking interesting future debates.' }
      ],
      scoring: ['1 point for guessing mood/genre correctly.', '1 point for thoughtful pitch.'],
      atHomeAlternative: 'Use home bookshelves, e-books, or online library catalogs.',
      importantRule: 'Never mark/damage books. Purchasing is optional.',
      detail: 'Browse a bookstore or library to select hidden mystery reads for each other.',
      gradient: 'linear-gradient(135deg, #1e293b, #0f172a)'
    },
    {
      id: 'quest-02', title: 'Coffeehouse Mini-Date', category: 'quest', budget: 'free', location: 'out', duration: '30–60 min',
      costEstimate: '$0–20', equipment: ['Café, bakery, park bench, or home coffee nook'],
      mission: 'Transform a coffee break into a structured conversation mini-date.',
      howToPlay: ['Pick café or comfortable seating spot.', 'Agree on spending budget ($0 allowed).', 'Take turns picking conversation prompts.', 'Answer for 1 minute; partner asks follow-up.', 'Complete 4+ prompts.'],
      promptDeck: [
        { title: 'Prompt 1 — Ideal Slow Morning', text: 'Describe perfect morning from waking to lunch.' },
        { title: 'Prompt 2 — Tiny Luxury', text: 'Inexpensive or free item making ordinary days special.' },
        { title: 'Prompt 3 — Shared Tradition', text: 'New small tradition to initiate together.' },
        { title: 'Prompt 4 — Unexpected Skill', text: 'Skill to learn together as beginners.' },
        { title: 'Prompt 5 — Memory Rewind', text: 'Ordinary moment you\'d happily re-live.' },
        { title: 'Prompt 6 — Next Adventure', text: 'Nearby low-cost activity to explore next.' }
      ],
      scoring: ['Select favorite answer heard.', 'Commit to planning one future outing idea.'],
      atHomeAlternative: 'Brew coffee or tea at home and sit in a non-standard relaxing location.',
      importantRule: 'Respect café space and volume levels. Purchases optional.',
      detail: 'Turn a coffee outing into an engaging conversation game with structured prompts.',
      gradient: 'linear-gradient(135deg, #334155, #1e293b)'
    },
    {
      id: 'quest-03', title: 'Local Landmark Photo Hunt', category: 'quest', budget: 'free', location: 'out', duration: '30–60 min',
      costEstimate: '$0', equipment: ['Phone camera'],
      mission: 'Capture seven story-driven photos highlighting small local architectural details.',
      howToPlay: ['Select public route or park.', 'Agree on travel radius and duration.', 'Take turns choosing photo prompts.', 'Collect 7 photos matching prompts.', 'Explain subject selection post-shot.', 'Review photo story gallery.'],
      promptDeck: [
        { title: 'Photo 1 — Feels Like Us', text: 'Detail or scene reminding you of relationship.' },
        { title: 'Photo 2 — Perfect Circle', text: 'Circular shape in nature or architecture.' },
        { title: 'Photo 3 — Hidden Pattern', text: 'Repeating lines, bricks, or foliage.' },
        { title: 'Photo 4 — Place for a Pause', text: 'Bench or peaceful corner ideal for sitting.' },
        { title: 'Photo 5 — Surprisingly Colorful', text: 'Vibrant detail usually walked past.' },
        { title: 'Photo 6 — Future Adventure Clue', text: 'Something sparking curiosity for next date.' },
        { title: 'Photo 7 — Closing Shot', text: 'Final shot capturing overall outing mood.' }
      ],
      scoring: ['Pick Most Meaningful Photo.', 'Pick Most Surprising Detail.', 'Pick Best Closing Shot.'],
      atHomeAlternative: 'Photograph window views, household textures, yard plants, and interior shapes.',
      importantRule: 'Respect private property and public safety rules.',
      detail: 'Take a photographic walking tour to capture artistic details and relationship symbols.',
      gradient: 'linear-gradient(135deg, #0f172a, #1e293b)'
    },
    {
      id: 'quest-04', title: 'Farmers Market Mission', category: 'quest', budget: 'free', location: 'out', duration: '30–45 min',
      costEstimate: '$0–15', equipment: ['Access to market, grocery store, or pantry'],
      mission: 'Design a seasonal 3-ingredient mini menu by exploring local produce stalls.',
      howToPlay: ['Set spending cap ($0 default).', 'Pick market prompt candidates.', 'Find matching ingredients.', 'Compare selections and agree on 3 items.', 'Draft restaurant menu title and description.'],
      promptDeck: [
        { title: 'Mission 1 — Seasonal Pick', text: 'Interesting seasonal fruit or vegetable.' },
        { title: 'Mission 2 — Under $3 Item', text: 'Budget-friendly fresh ingredient.' },
        { title: 'Mission 3 — Partner\'s Pick', text: 'Ingredient partner loves or wants to try.' },
        { title: 'Mission 4 — Three-Ingredient Meal', text: 'Items forming cohesive snack plate.' },
        { title: 'Mission 5 — Unexpected Pairing', text: 'Two ingredients not normally combined.' }
      ],
      scoring: ['1 point per completed mission.', '1 point for staying within budget.', '1 point for creative menu name.'],
      atHomeAlternative: 'Inspect home pantry/fridge or browse online grocery flyers.',
      importantRule: 'Never handle produce inappropriately. Buying optional.',
      detail: 'Explore a local market to curate a 3-ingredient seasonal menu concept.',
      gradient: 'linear-gradient(135deg, #164e63, #083344)'
    },
    {
      id: 'quest-05', title: 'Mini-Golf Rule Remix', category: 'arcade', budget: 'paid', location: 'either', duration: '45–90 min',
      costEstimate: '$10–40 (paid venue) / $0 (home)', equipment: ['Mini-golf course or home putting setup'],
      mission: 'Play mini-golf using playful house rules that inject humor into every hole.',
      howToPlay: ['Choose mini-golf course or floor setup.', 'Select 3 remix rules.', 'Play 6-18 holes reading assigned rule per hole.', 'Track strokes normally.', 'Award sportsmanship honors.'],
      promptDeck: [
        { title: 'Rule 1 — The Commentator', text: 'Give dramatic 10s sports commentary before shot.' },
        { title: 'Rule 2 — Course Designer', text: 'Partner names hole and invents fictional backstory.' },
        { title: 'Rule 3 — Victory Pose', text: 'Hold harmless 3-second victory pose post-hole.' },
        { title: 'Rule 4 — Gentle Pep Talk', text: 'Sincere or funny pep talk before partner shot.' },
        { title: 'Rule 5 — The Prediction', text: 'Predict stroke count exactly for bonus point.' },
        { title: 'Rule 6 — Highlight Reel', text: 'Describe shot as a famous classic replay.' }
      ],
      scoring: ['Standard course score plus bonus points for exact stroke predictions.'],
      atHomeAlternative: 'Set up 6 floor "holes" using plastic cups and soft balls.',
      importantRule: 'Follow course safety rules. Never disrupt other players.',
      detail: 'Play mini-golf with comedic sports commentary, victory poses, and course lore.',
      gradient: 'linear-gradient(135deg, #1e3a8a, #172554)'
    },
    {
      id: 'quest-06', title: 'Thrift-Store Style Swap', category: 'quest', budget: 'free', location: 'out', duration: '30–45 min',
      costEstimate: '$0–20', equipment: ['Thrift store access or personal wardrobe'],
      mission: 'Curate themed outfits or accessory combos for each other within budget.',
      howToPlay: ['Agree on budget ($0 default).', 'Select style theme.', 'Pick up to 3 clothing items for partner.', 'Explain thematic connection.', 'Partner rates ideas or tries items on.'],
      promptDeck: [
        { title: 'Theme 1 — Main Character Energy', text: 'Protagonist outfit for ordinary day.' },
        { title: 'Theme 2 — Dream Vacation', text: 'Attire for partner top travel destination.' },
        { title: 'Theme 3 — Different Decade', text: 'Retro look from partner favorite decade.' },
        { title: 'Theme 4 — Cozy & Confident', text: 'Comfortable outfit boosting confidence.' },
        { title: 'Theme 5 — Ridiculous Red-Carpet', text: 'Dramatic gala outfit for imaginary event.' }
      ],
      scoring: ['1 point for meeting theme.', '1 point for originality.', '1 point for presentation.'],
      atHomeAlternative: 'Rummage through existing closets or describe imaginary outfits.',
      importantRule: 'Never pressure partner to model or purchase uncomfortable items.',
      detail: 'Curate funny or stylish outfits for each other at a thrift store or from your closet.',
      gradient: 'linear-gradient(135deg, #31103f, #190a24)'
    },
    {
      id: 'quest-07', title: 'Try-Something-New Passport', category: 'quest', budget: 'free', location: 'out', duration: '30–90 min',
      costEstimate: '$0–25', equipment: ['Public park, museum, new local spot, or home'],
      mission: 'Collect three discovery "stamps" while exploring a place new to at least one of you.',
      howToPlay: ['Choose unfamiliar venue/park/neighborhood.', 'Agree on budget and time.', 'Select 3 passport missions.', 'Complete missions by observation or note-taking.', 'Decide whether to return.'],
      promptDeck: [
        { title: 'Mission 1 — Detail You Missed', text: 'Architectural feature or sign never noticed.' },
        { title: 'Mission 2 — Free Discovery', text: 'Interesting detail costing zero money.' },
        { title: 'Mission 3 — Local Story', text: 'Infer or read posted historical facts.' },
        { title: 'Mission 4 — Partner\'s Favorite', text: 'Partner highlights favorite spot element.' },
        { title: 'Mission 5 — New-to-Us Moment', text: 'Try permitted new action together.' },
        { title: 'Mission 6 — Future Visit', text: 'Identify reason for returning later.' },
        { title: 'Mission 7 — Memory Token', text: 'Take photo or write phrase as keepsake.' }
      ],
      scoring: ['Earn 1 stamp per completed mission. 3 stamps complete passport.'],
      atHomeAlternative: 'Explore a new neighborhood street or take a free virtual museum tour.',
      importantRule: 'Respect venue guidelines and posted property limits.',
      detail: 'Explore a new local venue or park while completing observation passport missions.',
      gradient: 'linear-gradient(135deg, #0f172a, #334155)'
    }
  ],
  'pack-arcade': [
    {
      id: 'arcade-01', title: 'Blind Portrait Battle', category: 'arcade', budget: 'free', location: 'home', duration: '10–20 min',
      costEstimate: '$0', equipment: ['Paper', 'Pens/Pencils'],
      mission: 'Draw portraits of each other without looking down at the paper page while drawing.',
      howToPlay: ['Sit facing each other.', 'Look exclusively at partner face.', 'Set 60-second timer.', 'Draw portrait without glancing down.', 'Reveal drawings together.', 'Play 3 rounds.'],
      promptDeck: [
        { title: 'Round 1 — Classic Portrait', text: 'Single continuous line without lifting pen.' },
        { title: 'Round 2 — Superhero Version', text: 'Draw partner as superhero with exaggerated feature.' },
        { title: 'Round 3 — Cartoon Mood', text: 'Express sleepiness, excitement, or confusion.' },
        { title: 'Bonus Round — Couple Portrait', text: 'Draw both of you together in one scene blind.' }
      ],
      scoring: ['Award Funniest Result.', 'Award Most Recognizable Detail.', 'Award Best Effort.'],
      atHomeAlternative: 'Draw in the air with fingers or use digital touchscreen apps.',
      importantRule: 'Keep drawings affectionate. Never criticize partner appearance.',
      detail: 'Draw blind contour portraits of each other without looking at the paper.',
      gradient: 'linear-gradient(135deg, #581c87, #3b0764)'
    },
    {
      id: 'arcade-02', title: 'Silent Build Challenge', category: 'arcade', budget: 'free', location: 'home', duration: '10–20 min',
      costEstimate: '$0', equipment: ['Cups', 'Blocks', 'Pillows', 'Household objects'],
      mission: 'Co-construct a physical structure without speaking or writing instructions.',
      howToPlay: ['Choose build theme.', 'Gather up to 10 safe objects.', 'Set 3-minute timer.', 'Build without speaking, typing, or writing.', 'Coordinate purely via gestures.', 'Debrief intentions.'],
      promptDeck: [
        { title: 'Theme 1 — Tallest Safe Tower', text: 'Self-standing structure for 5+ seconds.' },
        { title: 'Theme 2 — Tiny House', text: 'Mini house with entry and resting area.' },
        { title: 'Theme 3 — The Bridge', text: 'Bridge spanning two surfaces standing 5s.' },
        { title: 'Theme 4 — Secret Symbol', text: 'Symbol representing relationship.' },
        { title: 'Theme 5 — Mystery Object', text: 'Recreate daily object partner must guess.' }
      ],
      scoring: ['1 point for meeting theme.', '1 point for silent teamwork.', '1 point for creativity.'],
      atHomeAlternative: 'Use hand gestures to build an invisible imaginary structure together.',
      importantRule: 'Use safe materials. Break silence immediately if safety requires.',
      detail: 'Build physical towers or bridges together in complete silence using gestures.',
      gradient: 'linear-gradient(135deg, #3b0764, #1e1b4b)'
    },
    {
      id: 'arcade-03', title: 'Paper Airplane Championship', category: 'arcade', budget: 'free', location: 'home', duration: '10–20 min',
      costEstimate: '$0', equipment: ['Scrap paper', 'Safe clear room'],
      mission: 'Fold paper airplanes and test them in distance, accuracy, and smooth landing rounds.',
      howToPlay: ['Fold plane in 2 minutes.', 'Select clear throwing area.', 'Take 1 practice throw.', 'Compete across 3 distance/accuracy rounds.', 'Refine design for rematch.'],
      promptDeck: [
        { title: 'Round 1 — Distance', text: 'Plane traveling farthest in clear area wins.' },
        { title: 'Round 2 — Accuracy', text: 'Target box on floor. Most accurate landing wins.' },
        { title: 'Round 3 — Smooth Landing', text: 'Closest gentle landing to marked target.' },
        { title: 'Bonus Round — Design Story', text: 'Give plane name and 15s aerodynamic pitch.' }
      ],
      scoring: ['1 point per round win.', '1 bonus point for best plane name.'],
      atHomeAlternative: 'Describe imaginary plane designs and predict flight performance.',
      importantRule: 'Throw planes only in clear areas away from faces, pets, and glass.',
      detail: 'Fold paper airplanes to compete in distance, target accuracy, and smooth landings.',
      gradient: 'linear-gradient(135deg, #172554, #1e3a8a)'
    },
    {
      id: 'arcade-04', title: 'Couple Trivia Ladder', category: 'arcade', budget: 'free', location: 'home', duration: '15–25 min',
      costEstimate: '$0', equipment: ['Questions on this card'],
      mission: 'Climb a ladder of relationship questions from simple favorites to future plans.',
      howToPlay: ['Take turns selecting ladder questions.', 'Partner guesses answer before reveal.', 'Answering player reveals real preference.', 'Award point if guess was close.', 'Play 8+ questions.'],
      promptDeck: [
        { title: 'Level 1 — Favorites', text: '1. Go-to repeat snack? 2. Mood-boosting weather? 3. Quiet night or active day? 4. Favorite movie genre?' },
        { title: 'Level 2 — Everyday Life', text: '5. Small thing improving day? 6. Chore to make easier? 7. Free hour activity? 8. Inexpensive treat?' },
        { title: 'Level 3 — Memories', text: '9. Memory making you smile? 10. First impression of partner? 11. Place to re-visit? 12. Fond ordinary moment?' },
        { title: 'Level 4 — Future Ideas', text: '13. Skill to learn together? 14. Next date to try? 15. New tradition to start? 16. Ideal low-stress weekend?' }
      ],
      scoring: ['1 point per close guess.', '1 bonus point for asking thoughtful follow-up questions.'],
      atHomeAlternative: 'Play verbally on the couch, during a walk, or over a phone call.',
      importantRule: 'Preferences change. Never treat wrong guesses as lack of caring.',
      detail: 'Test how well you know each other across a 4-level question ladder.',
      gradient: 'linear-gradient(135deg, #312e81, #581c87)'
    },
    {
      id: 'arcade-05', title: 'Mystery Object Charades', category: 'arcade', budget: 'free', location: 'home', duration: '10–20 min',
      costEstimate: '$0', equipment: ['Household items or imagination'],
      mission: 'Mime household or imaginary objects using gestures without making sounds.',
      howToPlay: ['Select 5 prompts.', 'Acting player miming object in 30 seconds.', 'No speaking or noise allowed.', 'Guessing player gets 3 guesses.', 'Switch roles across 6 rounds.'],
      promptDeck: [
        { title: 'Prompt 1 — Household Helper', text: 'Vacuum, broom, or laundry basket.' },
        { title: 'Prompt 2 — Kitchen Mystery', text: 'Whisk, toaster, spoon, or measuring cup.' },
        { title: 'Prompt 3 — Travel Essential', text: 'Suitcase, umbrella, camera, or neck pillow.' },
        { title: 'Prompt 4 — Ridiculous Invention', text: 'Self-folding laundry machine or sock finder.' },
        { title: 'Prompt 5 — Impossible Object', text: 'Cloud collector or portable sunset.' },
        { title: 'Prompt 6 — Partner\'s Daily Life', text: 'Item partner uses daily.' },
        { title: 'Prompt 7 — Mystery Upgrade', text: 'Ordinary object with imaginary superpower.' }
      ],
      scoring: ['3 points for 1st guess.', '2 points for 2nd guess.', '1 point for 3rd guess.'],
      atHomeAlternative: 'Mime objects remembered from past vacations or imaginary sci-fi tools.',
      importantRule: 'Avoid erratic movements that risk injury or property damage.',
      detail: 'Act out everyday tools, absurd gadgets, and imaginary powers in a silent race.',
      gradient: 'linear-gradient(135deg, #4c1d95, #31103f)'
    },
    {
      id: 'arcade-06', title: 'Five-Minute Pitch Battle', category: 'arcade', budget: 'free', location: 'home', duration: '10–20 min',
      costEstimate: '$0', equipment: ['Timer (optional)'],
      mission: 'Invent absurd products or services and pitch them to your partner as investors.',
      howToPlay: ['Select prompt from deck.', 'Take 2 minutes to organize thoughts.', 'Give 60-second sales pitch.', 'Listener asks 1 question in 30s.', 'Switch roles and compare pitches.'],
      promptDeck: [
        { title: 'Prompt 1 — Laundry Miracle', text: 'Product making laundry instant or magical.' },
        { title: 'Prompt 2 — Lazy-Day Service', text: 'Service removing all effort from relaxing.' },
        { title: 'Prompt 3 — Least Necessary App', text: 'App rating pillows or naming clouds.' },
        { title: 'Prompt 4 — Pet\'s Dream Product', text: 'Item for overly demanding pet.' },
        { title: 'Prompt 5 — Ultimate Couple Gadget', text: 'Gadget solving date planning hassles.' },
        { title: 'Prompt 6 — Useless Luxury', text: 'Absurd luxury item everyone suddenly wants.' }
      ],
      scoring: ['1 point for memorable name.', '1 point for creativity.', '1 point for sales delivery.'],
      atHomeAlternative: 'Pitch inventions verbally without writing anything down.',
      importantRule: 'Keep pitches fun and affectionate. Never criticize real habits.',
      detail: 'Pitch ridiculous startup ideas and useless luxury items to each other in 60 seconds.',
      gradient: 'linear-gradient(135deg, #831843, #581c87)'
    },
    {
      id: 'arcade-07', title: 'The Invention Lab', category: 'arcade', budget: 'free', location: 'home', duration: '20–30 min',
      costEstimate: '$0', equipment: ['Paper & Pencils or cardboard scraps'],
      mission: 'Co-invent a solution to an everyday annoyance and present it at an Invention Fair.',
      howToPlay: ['Pick problem prompt.', 'Take 2 minutes to brainstorm individually.', 'Combine best ideas together.', 'Sketch or describe invention in 10 mins.', 'List 3 key features.', 'Present at Invention Fair.'],
      promptDeck: [
        { title: 'Challenge 1 — Lost-Item Problem', text: 'Find missing keys, remotes, or chargers.' },
        { title: 'Challenge 2 — Chore Helper', text: 'Make ordinary chores faster and fun.' },
        { title: 'Challenge 3 — Time-Saver', text: 'Cut task duration in half.' },
        { title: 'Challenge 4 — Cozy Upgrade', text: 'Improve blanket forts, snacks, or lighting.' },
        { title: 'Challenge 5 — Communication Tool', text: 'Playful way to share plans and reminders.' },
        { title: 'Challenge 6 — Impossible Problem', text: 'Store sunshine in jars or turn rain into dates.' }
      ],
      scoring: ['1 point for solving problem.', '1 point for originality.', '1 point for presentation.'],
      atHomeAlternative: 'Verbally describe invention features without drawing.',
      importantRule: 'Conceptual design challenge only. Never disassemble real appliances.',
      detail: 'Collaborate to design, sketch, and pitch creative solutions to minor hassles.',
      gradient: 'linear-gradient(135deg, #1e1b4b, #31103f)'
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
  document.querySelectorAll('.category-choice').forEach(input => { input.checked = checked; });
  applyCategoryFilter();
}

function switchGame(mode, button) {
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

function updateSwipeCard() {
  const header = getEl('matcherTurnHeader');
  const cardEl = getEl('swipeCard');
  const metaEl = getEl('cardMeta');
  const venueHint = getEl('venueHintBanner');
  const statusBanner = getEl('connectionStatusBanner');
  if (!header || !cardEl) return;

  if (statusBanner) {
    if (remoteRoomId) {
      statusBanner.style.display = 'block';
      if (conn && conn.open) {
        statusBanner.className = 'connection-status-banner connected';
        statusBanner.textContent = `🟢 Connected to Room "${remoteRoomId}" (Player ${myPlayerNum})`;
      } else {
        statusBanner.className = 'connection-status-banner disconnected';
        statusBanner.textContent = `🔴 Disconnected from Room "${remoteRoomId}". Waiting to reconnect...`;
      }
    } else {
      statusBanner.style.display = 'none';
    }
  }

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
        header.textContent = 'Live room disconnected · Rejoin or click Leave Room';
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
        ? 'Comparing partner selections and resolving the definitive winning card.'
        : 'Your selections have been securely submitted. Waiting for host match resolution.';

      cardEl.style.background = '#1f122e';
      if (metaEl) metaEl.innerHTML = '';
      if (venueHint) venueHint.style.display = 'none';
      return;
    }

    if (swipePlayer === 1) {
      swipePlayer = 2;
      swipeIndex = 0;
      alert("Player 1 complete! Pass the phone to Player 2.");
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
    metaEl.innerHTML = `<span class="meta-pill">💰 ${item.budget === 'free' ? 'Free' : 'Costs Money / Ingredients'}</span><span class="meta-pill">${locLabel}</span>`;
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
    swipeCardEl.style.transform = `translateX(${currentX}px) rotate(${currentX * 0.04}deg)`;
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
  grid.replaceChildren();
  if (!draftItems.length) {
    const empty = document.createElement('div');
    empty.className = 'library-summary';
    empty.style.gridColumn = '1 / -1';
    empty.style.textAlign = 'center';
    empty.textContent = 'No ideas available. Select filters above.';
    grid.appendChild(empty);
    return;
  }

  draftItems.forEach((item, index) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `draft-tile${item.banned ? ' banned' : ''}`;
    tile.style.background = item.gradient || '#1f122e';
    tile.disabled = Boolean(item.banned);
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = item.title || 'Untitled date';
    const category = document.createElement('div');
    category.className = 'cat';
    category.textContent = item.category || '';
    tile.append(title, category);
    if (!item.banned) tile.addEventListener('click', () => {
      const remainingCount = draftItems.filter(entry => !entry.banned).length;
      if (remainingCount <= 1) {
        window.currentWinner = item;
        showModal('Only Date Available!', item.title, item.detail);
      } else {
        banItem(index);
      }
    });
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
      alert(`It is currently Player ${draftTurn}'s turn to ban!`);
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
  if (summary) summary.textContent = `${storeCatalog.length} packs available · ${unlockedItems.length} demo-unlocked`;
  grid.replaceChildren();
  storeCatalog.forEach(item => {
    const unlocked = unlockedItems.includes(item.id);
    const card = document.createElement('article');
    card.className = 'library-item store-tile';
    card.style.background = item.gradient || '#1f122e';
    const category = document.createElement('div');
    category.className = 'library-category';
    category.textContent = `EXPANSION PACK · ${item.price} (demo)`;
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
    button.textContent = unlocked ? '✅ Unlocked (View)' : '🔍 Preview & Demo Unlock';
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
    actionButton.textContent = unlocked ? 'Already Unlocked' : `Demo Unlock · ${item.price}`;
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
    alert('This pack is already demo-unlocked on this device.');
    return;
  }
  const confirmed = confirm('Demo unlock only: no payment will be charged. Unlock this pack on this device?');
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
    alert('Demo pack unlocked on this device. No payment was processed.');
  } catch (err) {
    unlockedItems = unlockedItems.filter(id => id !== itemId);
    console.error('Could not save pack unlock:', err);
    alert('The pack could not be unlocked because local storage failed.');
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
  if (!item) { alert('Choose a date idea first.'); return; }
  const text = `💞 Date Night Decider: ${item.title}\n${item.detail}`;
  if (navigator.share) navigator.share({ title: item.title, text }).catch(() => {});
  else window.prompt('Copy this date idea:', text);
}

function openCurrentCardMap() {
  const item = window.currentWinner;
  if (!item) return;
  const queryByCategory = {
    movie: 'movie theaters near me',
    gaming: item.title.toLowerCase().includes('arcade') ? 'arcades near me' : `${item.title} near me`,
    cooking: item.title.toLowerCase().includes('crawl') ? 'restaurants near me' : `${item.title} near me`,
    baking: `bakeries or cooking classes near me`,
    'board games': 'board game cafes near me',
    tv: `${item.title} near me`,
    'micro-adventure': 'parks or shops near me',
    quest: 'local landmarks or parks near me',
    arcade: 'game rooms or arcades near me'
  };
  const query = item.location === 'out' ? (queryByCategory[item.category] || `${item.title} near me`) : `${item.title} near me`;
  window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`, '_blank', 'noopener,noreferrer');
}

async function exportBackup() {
  const data = {
    version: '2.7.2',
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
      if (Array.isArray(data.deletedBuiltins)) {
        const ids = data.deletedBuiltins.filter(id => typeof id === 'string');
        deletedBuiltins = new Set(ids);
        if (!useMemoryFallback && db) {
          await db.deletedBuiltins.clear();
          if (ids.length) await db.deletedBuiltins.bulkAdd(ids.map(id => ({ id })));
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
      if (Array.isArray(data.selectedCategories)) {
        selectedCategories = data.selectedCategories.filter(value => DEFAULT_CATEGORIES.includes(value));
        if (!useMemoryFallback && db) await db.categories.put({ id: 'selectedCats', values: selectedCategories });
        document.querySelectorAll('.category-choice').forEach(input => { input.checked = selectedCategories.includes(input.value); });
      }

      refreshDecks();
      await applyTheme(appSettings.theme || 'dark');
      const feedback = getEl('feedbackSelect');
      if (feedback) feedback.value = appSettings.feedback;
      initMatcher();
      initDraft();
      renderHistory();
      renderStore();
      renderLibrary();
      alert('Backup restored successfully.');
    } catch (error) {
      console.error('Backup import failed:', error);
      alert('The backup file could not be imported.');
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
      if (winner.costEstimate) html += `<div>💵 <strong>Cost:</strong> ${escapeHtml(winner.costEstimate)}</div>`;
      if (winner.equipment) html += `<div>🧰 <strong>Needs:</strong> ${escapeHtml(Array.isArray(winner.equipment) ? winner.equipment.join(', ') : winner.equipment)}</div>`;
      html += `</div>`;
    }

    if (Array.isArray(winner.howToPlay) && winner.howToPlay.length) {
      html += `<div style="text-align:left;margin-bottom:12px;"><strong style="color:var(--gold);font-size:0.8rem;text-transform:uppercase;">🎮 How to Play</strong><ol style="margin-left:18px;font-size:0.78rem;color:var(--muted);margin-top:4px;">`;
      winner.howToPlay.forEach(step => { html += `<li>${escapeHtml(step)}</li>`; });
      html += `</ol></div>`;
    }

    if (Array.isArray(winner.promptDeck) && winner.promptDeck.length) {
      html += `<div style="text-align:left;margin-bottom:12px;"><strong style="color:var(--gold);font-size:0.8rem;text-transform:uppercase;">🎲 Prompt Deck</strong><div style="display:grid;gap:6px;margin-top:4px;max-height:160px;overflow-y:auto;padding-right:4px;">`;
      winner.promptDeck.forEach(p => {
        html += `<div style="background:#1f122e;border:1px solid var(--border);padding:8px;border-radius:8px;font-size:0.75rem;"><strong style="color:var(--cream);">${escapeHtml(p.title)}</strong><br/><span style="color:var(--muted);">${escapeHtml(p.text)}</span></div>`;
      });
      html += `</div></div>`;
    }

    if (Array.isArray(winner.scoring) && winner.scoring.length) {
      html += `<div style="text-align:left;margin-bottom:12px;"><strong style="color:var(--gold);font-size:0.8rem;text-transform:uppercase;">🏆 Scoring</strong><ul style="margin-left:18px;font-size:0.78rem;color:var(--muted);margin-top:4px;">`;
      winner.scoring.forEach(s => { html += `<li>${escapeHtml(s)}</li>`; });
      html += `</ul></div>`;
    }

    if (winner.atHomeAlternative) {
      html += `<div style="text-align:left;margin-bottom:12px;font-size:0.78rem;background:rgba(246,201,65,0.08);padding:8px;border-radius:8px;border:1px solid var(--border);"><strong style="color:var(--gold);">🏠 At-Home Alternative:</strong> <span style="color:var(--muted);">${escapeHtml(winner.atHomeAlternative)}</span></div>`;
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
      resetRemoteRound();
      sendRoomState();
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
  if (rating1 === null) { alert('Enter a whole-number rating from 1 to 5.'); return; }
  const second = prompt('Player 2 rating (1–5):', '5');
  if (second === null) return;
  const rating2 = validRating(second);
  if (rating2 === null) { alert('Enter a whole-number rating from 1 to 5.'); return; }
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
    alert('The date could not be saved.');
  }
}

function downloadCalendarEvent() {
  const item = window.currentWinner;
  if (!item) { alert('Choose a date idea first.'); return; }
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

function startP2PServer() {
  const raw = prompt('Create a room code using letters, numbers, or hyphens (at least 4 characters):');
  if (!raw) return;
  const code = normalizeRoomCode(raw);
  if (code.length < 4) { alert('Use a room code at least 4 characters long.'); return; }
  if (typeof window.Peer !== 'function') { alert('PeerJS did not load. Check your connection and reload.'); return; }
  cleanupPeerConnection();
  remoteRoomId = code;
  myPlayerNum = 1;
  currentRoomPeerId = roomPeerId(code);
  resetRemoteRound();
  try {
    peer = new Peer(currentRoomPeerId, PEER_OPTIONS);
    
    const timeoutHandle = window.setTimeout(() => {
      if (!conn || !conn.open) {
        console.warn('Host connection timeout waiting for partner.');
      }
    }, 15000);

    peer.on('open', () => {
      alert(`Room “${code}” is ready as Player 1. On the other device, choose Join Live Room.`);
    });
    peer.on('connection', incoming => {
      window.clearTimeout(timeoutHandle);
      if (conn && conn.open) conn.close();
      conn = incoming;
      setupConnectionHandlers(conn);
      conn.on('open', () => {
        resetRemoteRound();
        sendRoomState();
        startHeartbeat();
        alert('Partner connected. The live room is synchronized.');
        updateSwipeCard();
      });
    });
    peer.on('error', error => {
      console.error('PeerJS host error:', error);
      if (error.type === 'unavailable-id') alert('That room code is already in use. Choose a different code.');
      else alert(`Could not host live room (${error.type || 'connection error'}).`);
    });
  } catch (error) {
    console.error('Could not create PeerJS host:', error);
    cleanupPeerConnection();
    alert('Could not start live room.');
  }
}

function joinP2PServer() {
  const raw = prompt('Enter the couple room code shared by the host:');
  if (!raw) return;
  const code = normalizeRoomCode(raw);
  if (code.length < 4) { alert('Enter a valid room code at least 4 characters long.'); return; }
  if (typeof window.Peer !== 'function') { alert('PeerJS did not load. Check your connection and reload.'); return; }
  cleanupPeerConnection();
  remoteRoomId = code;
  myPlayerNum = 2;
  currentRoomPeerId = roomPeerId(code);
  try {
    peer = new Peer(PEER_OPTIONS);
    peer.on('open', () => {
      conn = peer.connect(currentRoomPeerId, { reliable: true });
      setupConnectionHandlers(conn);
      conn.on('open', () => {
        alert(`Connected to room “${code}” as Player 2. Waiting for host's shared deck…`);
        startHeartbeat();
        updateSwipeCard();
      });
      conn.on('error', error => {
        console.error('PeerJS guest connection error:', error);
        alert('Could not connect. Make sure host room is open.');
      });
    });
    peer.on('error', error => {
      console.error('PeerJS guest error:', error);
      alert('Could not join room.');
    });
  } catch (error) {
    console.error('Could not join PeerJS room:', error);
    cleanupPeerConnection();
    alert('Could not join live room.');
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
    alert('You are not currently in a live room.');
    return;
  }
  const confirmed = confirm('Leave live room and return to local play?');
  if (!confirmed) return;
  cleanupPeerConnection();
  refreshDecks();
  initMatcher();
  initDraft();
  alert('Returned to local play mode.');
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

  let chosenWinner = null;
  if (mutual.length > 0) {
    chosenWinner = mutual[0];
  } else {
    const pool = [...p1Deck];
    pool.sort((a, b) => getCardScore(b) - getCardScore(a));
    chosenWinner = pool[0] || null;
  }

  if (!sendP2PMessage({ type: 'MATCH_RESULTS', mutual, winnerCardId: chosenWinner ? chosenWinner.id : null })) {
    return false;
  }

  remoteMatchResolved = true;
  handleMatchOutcome(mutual, chosenWinner);
  return true;
}

function setupConnectionHandlers(connection) {
  if (!connection) return;
  connection.on('data', message => {
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

    if (message.type === 'SUBMIT_SWIPES' && myPlayerNum === 1) {
      remotePartnerLikes = Array.isArray(message.likedCards) ? message.likedCards.filter(item => item && item.id) : [];
      tryResolveRemoteMatch();
      updateSwipeCard();
      return;
    }

    if (message.type === 'MATCH_RESULTS' && myPlayerNum === 2) {
      const mutual = Array.isArray(message.mutual) ? message.mutual : [];
      const winnerId = message.winnerCardId;
      let winner = mutual.find(m => m.id === winnerId);
      if (!winner && winnerId) {
        winner = p2Deck.find(d => d.id === winnerId);
      }
      if (!winner && mutual.length > 0) winner = mutual[0];
      handleMatchOutcome(mutual, winner);
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

  connection.on('open', () => {
    updateSwipeCard();
  });

  connection.on('close', () => {
    if (connection !== conn) return;
    conn = null;
    remoteSubmitSent = false;
    updateSwipeCard();
    const header = getEl('matcherTurnHeader');
    if (header) header.textContent = 'Live room disconnected · Rejoin or click Leave Room';
  });

  connection.on('error', error => console.error('Live-room data connection error:', error));
}

function handleMatchOutcome(mutual, forcedWinner = null) {
  if (forcedWinner) {
    window.currentWinner = forcedWinner;
    const isMutual = Array.isArray(mutual) && mutual.some(m => m.id === forcedWinner.id);
    showModal(isMutual ? 'It’s a Match!' : 'Date Decided!', forcedWinner.title, forcedWinner.detail);
    return;
  }
  if (Array.isArray(mutual) && mutual.length > 0) {
    window.currentWinner = mutual[0];
    showModal('It’s a Match!', window.currentWinner.title, window.currentWinner.detail);
  } else {
    window.currentWinner = null;
    showModal('No Direct Matches', 'Try Draft Mode!', 'You and your partner liked different ideas. Try Elimination Draft or start another Matcher round.');
  }
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
