# Matchmaking verification

`tests/e2e-matchmaking.cjs` covers online presence, named challenges, and the global FIFO queue while preserving the existing eight-piece soccer and shared wallet flow.

Run the actual API/database checks with a loopback PostgreSQL URL supplied privately:

```sh
NODE_ENV=test DATABASE_URL=postgres://…@127.0.0.1:PORT/postgres MATCHMAKING_API_ONLY=1 node tests/e2e-matchmaking.cjs
```

The harness rejects remote database hosts, creates a uniquely named disposable database, applies the actual Target migrations, starts the actual soccer API, and removes only its own database. KGS identities, PINs, session tokens, and RPC credentials are synthetic. Database pool errors are recorded by safe error code; cleanup waits for its connections to close and drops without forcibly terminating an idle pool.

The API/database checks cover:

- Per-session presence, self exclusion, multiple devices, expiry, final-session logout, and revoked-session heartbeat fences.
- Actual browser login, heartbeat and online roster through the local API and fresh SQL database; one interrupted automatic lobby read followed by automatic recovery, preserved wallet/self row, and isolated browser logout. Only the failed read is aborted; successful replies are never mocked in this scenario.
- Selecting an online opponent, explicit invitation acceptance, each participant's stake, and no reservation until both existing ready confirmations.
- Authenticated Vercel rewrite URLs including the exact `path` wildcard capture reach the actual lobby and heartbeat RPCs.
- Actual browser queue/challenge/accept commands contain no formation preference or picker. Every new match receives one shared random formation, retained across retries and funding; legacy preference fields are accepted without controlling the layout. The soccer API suite also verifies rejected manual changes and goals preserve the assignment.
- Declines, cancellations, offline/busy targets, unauthorized acceptance, and retired request IDs remaining retired across retry, re-login, and name changes.
- FIFO pairing across different stake choices, older-waiter priority when only the newer participant can create a match, and concurrent direct/random pairing with one active match per member.
- Queue/invitation cancellation at storage and rate limits, stale queue cancellation after matching, shared wallet funding/refunds, RLS/privileges, and exact financial projection reconciliation.
- The actual browser displays the server-selected attacking player, team emphasis and remaining turn time; an expired server turn reaches the page through its normal automatic poll without changing the stake.

The soccer API/database suite also exercises 520 consecutive shots, exceeding both the former 40-turn draw and the former 256-request limit per player. Local fixture time is advanced to skip replay waits, while separate cases verify that the real replay grace returns `TURN_PENDING`, each turn still receives 60 seconds, and concurrent reads plus a stale shot cannot pass a deadline twice. Timeout catch-up, pending-shot lease recovery, goal-area relocation, untouched ball/financial receipts, and the existing abandoned-match refund are verified at the actual SQL boundary. Per-minute transport rate limits and the shared storage quota remain enforced; the long-game fixture advances only its local rate window.

Run the browser UI checks separately:

```sh
MATCHMAKING_BROWSER_ONLY=1 WEBKIT_PATH=/path/to/webkit-wrapper node tests/e2e-matchmaking.cjs
```

The separate browser UI scenarios load the actual app assets but fulfill **every API request locally**. They check the online list and busy state, direct challenge/accept/decline/cancel, removed formation controls and stake-only command payloads, FIFO waiting/cancellation, accepted queue stake restored on a fresh device, delayed snapshots after queue cancellation/account switching, removal of room-code controls, eight-piece slingshot input, refresh, and narrow/desktop layouts. Chromium and WebKit are used; these are engine tests, not physical iPhone tests. The actual browser/API/SQL recovery and shared-formation scenarios run in the API/database suite above.

`APP_ORIGIN=https://…` selects deployed assets while keeping all API requests locally fulfilled:

```sh
MATCHMAKING_BROWSER_ONLY=1 WEBKIT_PATH=/path/to/webkit-wrapper APP_ORIGIN=https://kgs-2player.vercel.app node tests/e2e-matchmaking.cjs
```

Reports are written to `test-results/matchmaking-api-qa.json`, `matchmaking-browser-qa.json`, or `matchmaking-public-qa.json`. On 2026-11-10, the updated local suite passed 13 actual browser/API/SQL scenarios with 4,349 assertions, including authenticated rewrite captures, interrupted-poll recovery, shared random formation, the live attacker/countdown display, and a server timeout reaching the page. The separate Chromium/WebKit browser suite passed 81 assertions. The existing financial regression runner, `SOCCER_API_ONLY=1 node tests/e2e-soccer.cjs`, also passed 17 API/SQL scenarios with 7,668 assertions, including the long-game, deadline, replay grace, and pending-shot recovery cases above. No real account, hosted wager, or hosted balance write is part of this verification.

Connection edge cases run with `node tests/e2e-connection.cjs` and `BROWSER=webkit node tests/e2e-connection.cjs`. Both engines passed five scenarios covering recovery, preserved operation errors, coalesced refreshes, deferred presence heartbeats, and obsolete failures. These focused scenarios fulfill API replies locally. `npm test` separately covers connection transport, deadline and diagnostic privacy, API validation, and deterministic physics rules.

Hosted upstream calls share a 26-second request budget; the browser allows 28 seconds and Vercel allows 30 seconds. Failure logs contain only fixed route/operation labels, status/protocol codes, timing, and failure classes. Request bodies, credentials, account identifiers, and upstream error messages are excluded. Authentication remains fresh and mutations are never automatically replayed.

Turn-clock UI checks run with `node tests/e2e-turn-clock.cjs` and `BROWSER=webkit node tests/e2e-turn-clock.cjs`. Six cases passed per engine, covering server-clock anchoring, expired/future turns, network receipt fences, stale responses, and ordinary input handoffs without hiding unrelated errors. The final app unit suite passed 71 tests, including 25 physics tests and 100 seeded cleanup cases. The database clock suite passed 261 checks, including 207 JavaScript/SQL placement comparisons; the existing formation suite passed 162 checks and Target's unit suite passed 73 tests.
