# KUSO Game

KGS11th accounts and shared 轟, with two-player flick soccer.

Each team has eight pieces and chooses one of three opening formations. Players
take turns pulling one of their pieces back and releasing it in the opposite
direction; pull distance sets power. The server resolves each shot and its
collisions before the turn changes. Both players approve the displayed stake
amounts before a match starts; the two amounts can differ. A change clears both
approvals. Confirmed results settle once through the shared wallet ledger: the
winner receives both stakes, while a draw or cancellation returns each player's
own stake.

Stakes start at 100轟 in 100轟 increments, with no separate game limit.
Both players must have enough available funds and settlement headroom within
the shared wallet's existing 10,000,000,000,000轟 representation limit.

The KUSO Game home is a two-column catalog of square illustrated game tiles: 2player, TEN LINK, GRAPH ROCKET, and 射法投射. The 2player tile opens a focused online-opponent list at /?game=2player; the soccer ranking is shown beneath online opponents; the spectator list remains hidden, not deleted. TEN LINK keeps its existing game and leaderboard. GRAPH ROCKET is a local solo math puzzle: enter an origin-passing y=f(x) and launch along the graph in the first quadrant (0–10 on both axes) to destroy bases and incoming objects. Four one-shot levels with quadratic, cubic and quartic solutions. Every target must be hit on the same trajectory; failed attempts restart the current stage. Sparse axes display 1 and 10 without gridlines. Safe expression parsing supports arithmetic, powers, implicit multiplication and common functions. No wallet or database changes.
New soccer matches use named challenges and explicit acceptance only. The
legacy random queue endpoint returns 410; old cancellation remains available
for cleanup. Direct invitations and the existing soccer flow are unchanged.
The standalone TEN LINK puzzle uses a 5×5 number board, 60-second rounds,
vertical/horizontal/diagonal paths totaling ten and gold links for bonus
points. Logged-in users receive a server-signed seed; the server replays submitted moves and stores one best score per KGS account in the separate Target solo ranking. Offline or unauthenticated games remain local practice. No wallet API is used. Existing local scores are not imported.

During matches, players can send one of eight preset short text stamps (including the three newest options) to the court center. The fixed-code messages are also visible to spectators. Five-second cooldown and short-lived storage remain in effect. No sticker images are loaded for these messages.

The ranking counts +1 win per completed 3-goal victory. Winning 3:0 gives
+3 points, 3:1 gives +2 and 3:2 gives +1; losses, draws, and cancellations
give zero wins/points, never penalties. Rankings use settled Target records
rather than browser scores, with total points first and wins as the tie-breaker.
Expired shot/replay details are pruned 24 hours after settlement; minimal
final-score summaries and permanent wallet receipts remain intact.
Room codes are not part of the interface. Presence is session-based.

Link the Vercel project, provision the required keys listed in `.env.example`,
then configure a gitignored `.env.local` for development. Secrets are server-only;
the KGS identity bridge has its own dedicated service credential. Allow the local
origin explicitly when developing. `npm ci`, `npm run build`, and `npm run dev`
build and start the app. `npm test` runs focused unit tests. Integration tests use
only disposable loopback databases and synthetic identities.

No PIN, session token, integration secret, or database credential is included
in the browser assets or repository.

The database migrations and ledger contract are maintained in the sibling Target
repository (`docs/two-player-soccer.md`). KGS11th provides the account bridge and
the external-site link. See `docs/MATCHMAKING-QA.md` for the current integration
and browser checks, and `docs/QA.md` for the original soccer verification.
`npm run test:e2e` runs matchmaking checks; `npm run test:e2e:soccer` retains the
isolated soccer API/ledger regression suite. Public-asset browser checks
intercept every API request.

### 射法投射 and stage progress

射法投射 is a landscape-only 60-second local arcade game. A three-second countdown precedes play. A randomly selected side launches one fixed-size target per second along a constant-gravity trajectory with varying angles and apex heights. Gold targets at 15, 30 and 45 seconds are worth five points; others are worth one. Drag the left side and independently press FIRE on the right, including during a two-finger gesture (240 ms minimum interval). Each shot adds brief visual recoil. Page zoom gestures are suppressed across the game catalog. A hit breaks the target into falling fragments. Portrait and background visibility pause gameplay. No wallet or ranking API is used. GRAPH ROCKET stage selection unlocks each following level after clearing its predecessor, with highest cleared stage stored locally in this browser. No previous progress can be reconstructed because older versions did not store it.

射法投射 displays its independent KGS-account best-score ranking in portrait. Rotate to landscape to start a ranked run; rotate back during play to pause. Logged-in runs use a signed seeded target schedule and server-side shot replay. Offline or unauthenticated runs remain practice only. Scores from older versions cannot be imported. No wallet changes.

### Graphwar / Color?

Graphwar auto-joins a shared 2000 × 1000 world with center axes, portrait horizontal scrolling, local-origin graph equations, and 25-second rotating turns. Implicit curves (for example x²+y²=300x) use a bounded numerical contour approximation; explicit functions support left/right. Obstacles shrink on impact. Players respawn after each surviving participant's next turn, or immediately if alone. Presence expires after 45 seconds; the next request resets an empty world. Server-side resolution uses atomic revision comparison, with visible-client polling every 2.5 seconds. Maximum 41 players and 128 obstacles; joins attempt a nonoverlapping obstacle between players if space permits. No wallets or rankings affected.

Color? is a 50-correct-answer time attack with randomized independent word and ink, three-second countdown, incorrect-answer shake and retry, and a separate fastest-time leaderboard. Ranked runs use signed question seeds and server-measured elapsed time; network overhead is included and automated input cannot be fully ruled out. Unauthenticated/offline runs are practice only. No wallet changes.

Color? shows the next four words in a receding vertical queue. Correct answers advance the queue, wrong answers leave it unchanged, and FINISH moves into the foreground after question 50. The timer stops at the last correct answer; the finish animation does not delay submission.

### ROOFTOP DUEL

Named invitations in a separate lobby, landscape-only readiness, three-second countdown, best of three. Both players start in cover; peek in three directions and see all enemy lanes. Mirrored left/right and matching up are the only hit combinations. Server-accepted first hit wins the round; a 10-round magazine reloads automatically after 1.5 seconds, with a 120 ms minimum shot interval (actual cadence depends on latency). Brief recoil and colored shot traces indicate the lane. Hold FIRE or tap repeatedly. Match polling every 450 ms, lobby 1800 ms. Presence expiry 45 seconds; no stake, wallet, or existing ranking changes. Browser orientation is checked client-side, not a trusted competitive signal. No real-world weapon simulation.

### TRACE / SUBMARINE

TRACE: four courses, five distinct problems, initial three-second countdown and 30 seconds per drawing. Axes and endpoints only; finger/mouse strokes, undo/clear, score and correct curve overlay after submission. Server computes symmetric sampled curve coverage and precision (distance tolerance 1.25 graph units), harmonic mean, and stores best five-question mean per course. Signed checkpoints and elapsed-time guard do not prevent automated drawing or replay/fork within the accepted time window; offline practice does not rank. SUBMARINE: named invitations in separate lobby, 5×10 square board, straight nonoverlapping 2/3/4/5-cell ships, randomized first turn, target select then cannon fire, hit retains turn/time, miss or 60-second timeout switches, 14 unique hits wins. Opponent fleet never sent; only shot outcomes. Server-authoritative CAS, 700ms match polling, 45s presence expiry. No wallet or existing game changes.
