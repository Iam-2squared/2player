# Soccer verification

Run `NODE_ENV=test DATABASE_URL=postgres://…@127.0.0.1:PORT/postgres npm run test:e2e` after project bootstrap and the local PostgreSQL service are ready. `TARGET_SOURCE_ROOT` can identify the checkout containing the Target migrations. The harness rejects remote database hosts, creates a uniquely named disposable database, applies the actual Target migrations, starts the actual soccer API, and deletes its database when complete. Its local app process uses independently generated `TWO_PLAYER_DATABASE_URL`, `TWO_PLAYER_RPC_SECRET`, `TWO_PLAYER_COOKIE_SECRET`, and `TWO_PLAYER_KGS_INTEGRATION_SECRET` values.

Identity is a loopback KGS bridge with synthetic names, account numbers, and four digit PINs. It implements the actual `/api/integrations/two-player/login`, `verify`, and `logout` contract. It never uses a pupil account, photo, hosted login, hosted wager, or hosted database. The browser cookie contexts are independent. Server credentials and opaque identity tokens are generated per run and excluded from the report.

Results are recorded in `test-results/soccer-qa.json`. `SOCCER_API_ONLY=1` writes `soccer-v2-api-qa.json`; `SOCCER_BROWSER_ONLY=1` writes `soccer-browser-qa.json`; `APP_ORIGIN` writes `soccer-public-qa.json`. API/database scenarios run against the genuine API and local PostgreSQL. Browser layout/interaction scenarios use the real public assets and explicitly fulfill every API request with local synthetic data. Screenshots use only that fixture. `APP_ORIGIN=https://…` with browser-only mode tests deployed assets with every API request still intercepted locally. `CHROMIUM_PATH` and `WEBKIT_PATH` can select installed browser executables; this environment's existing WebKit wrapper is `/workspace/scratch/webkit-runtime/pw-run.sh`.

## Coverage

- Independent KGS login cookies, four digit PIN fields, logout, and session refresh.
- Stake agreement, insufficient balances, simultaneous funding and exact escrow conservation.
- Alternating turns, rejection of the inactive player, immutable accepted shots, input retries, delayed/reordered delivery, concurrent resolution and deterministic simulation.
- Version 2 with eight pieces per side, own-team piece bounds, three formation choices, all nine formation pairs, confirmation invalidation after a formation change, and retained formations after a goal.
- Win, draw, cancellation, timeout, exactly once settlement/refunds, and compatibility with existing wallet/gacha ledgers.
- Reconnect, refresh, account switches, stale responses, Chromium and WebKit, 320 pixel portrait and narrow landscape layouts, canvas and keyboard controls.
- Slingshot input from owned pieces only: opposite-pull launch, distance-based power, guest rotation, one launch per release, and no launch on taps, pointer cancellation, lost capture, return to center or processing-locked input.
- Result storage reservation/release, refunds at the storage cap, lease expiry and recovery, 500 profile allocation cap, and the reviewed read-only SQL postflight.

## Evidence

On 2026-11-09, the fresh Version 2 API/database suite passed 14 scenarios and 3,067 assertions. This includes the original financial cases and all nine formation pairs. Scoring cases seed an isolated sixteen-piece near-goal state inside the disposable fixture; the actual server computes every goal and settlement. No client-supplied outcome is accepted.

The revised minimal Version 2 UI then passed Chromium and WebKit with 123 assertions across two browser scenarios. Both browsers verified all eight owned selections, the three formation choices, slingshot direction and power, guest rotation, input locking, cancellation, refresh and a deliberately delayed old-account response after switching accounts. Representative images are `test-results/{chromium,webkit}-{login-320,lobby-320,lobby-desktop,room-320,game-320,game-desktop,game-landscape,guest-slingshot-320}.png`.

A conservative 121-frame Version 2 fixture measured 111,326 bytes as actual PostgreSQL JSONB and 64,493 bytes as UTF-8 JSON, below the 360,448-byte frame limit and 393,216-byte result reservation.

The fixed simulation outcome depends on stored shot input and state; arrival order and retries cannot grant another shot or settlement. The suite verifies independent cookie contexts and concurrent database calls. It does not establish a 40 person production load guarantee. No hosted writes are part of this suite.
