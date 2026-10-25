DATE NIGHT DECIDER — VERSION 2.9.4

Files
- index.html: app screens, filters, buttons, and dialogs
- styles.css: dark-purple/pink/gold interface, responsive layout, and accessibility rules
- app.js: Matcher, Draft, Surprise, History, Library, demo store, P2P rooms, and backup import/export
- manifest.json: install metadata for the progressive web app
- service-worker.js: offline app-shell caching and update handling
- icon-192.png and icon-512.png: install icons

Core behavior
- Matcher: two players independently like or pass on date ideas, then choose from the final shortlist
- Draft: players take turns eliminating date ideas until one remains
- Surprise: randomly selects from ideas matching the active filters
- History: completed dates and ratings are saved locally when browser storage is available
- Weekly tracker: counts completed dates for the current Sunday-to-Saturday display logic used by the app
- Library: browse the core ideas and any unlocked demo expansion packs
- Filters: nine categories plus free/paid budget filtering
- Multiplayer: live rooms use PeerJS and require both devices to have internet access
- Backup: JSON export/import for app preferences, custom cards, filters, history, and demo unlock flags
- Offline: the service worker caches the core app files; live multiplayer still requires internet

Store status
The expansion store is a local demo only. Displayed prices are examples, no payment is taken, and demo unlocks are stored only on this device. Do not treat them as purchases.

Data and privacy
App data is stored in this browser when persistent storage is available. Live-room data is exchanged with the other participant through the peer-to-peer connection. Export a backup before clearing site data or moving to another device.

Run locally
Serve this folder over localhost or HTTPS (for example, Acode's local server). Service workers and PWA installation do not work when opened directly as a file.
