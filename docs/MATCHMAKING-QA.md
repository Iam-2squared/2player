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
- Selecting an online opponent, explicit invitation acceptance, each participant's stake/formation, and no reservation until both existing ready confirmations.
- Declines, cancellations, offline/busy targets, unauthorized acceptance, and retired request IDs remaining retired across retry, re-login, and name changes.
- FIFO pairing across different stake choices, older-waiter priority when only the newer participant can create a match, and concurrent direct/random pairing with one active match per member.
- Queue/invitation cancellation at storage and rate limits, stale queue cancellation after matching, shared wallet funding/refunds, RLS/privileges, and exact financial projection reconciliation.

Run the browser UI checks separately:

```sh
MATCHMAKING_BROWSER_ONLY=1 WEBKIT_PATH=/path/to/webkit-wrapper node tests/e2e-matchmaking.cjs
```

The separate browser UI scenarios load the actual app assets but fulfill **every API request locally**. They check the online list and busy state, direct challenge/accept/decline/cancel, three formation choices, FIFO waiting/cancellation, accepted queue preferences restored on a fresh device, delayed snapshots after queue cancellation/account switching, removal of room-code controls, eight-piece slingshot input, refresh, and narrow/desktop layouts. Chromium and WebKit are used; these are engine tests, not physical iPhone tests. The actual browser/API/SQL recovery scenario runs in the API/database suite above.

`APP_ORIGIN=https://…` selects deployed assets while keeping all API requests locally fulfilled:

```sh
MATCHMAKING_BROWSER_ONLY=1 WEBKIT_PATH=/path/to/webkit-wrapper APP_ORIGIN=https://kgs-2player.vercel.app node tests/e2e-matchmaking.cjs
```

Reports are written to `test-results/matchmaking-api-qa.json`, `matchmaking-browser-qa.json`, or `matchmaking-public-qa.json`. On 2026-11-09, the updated local API suite passed 12 actual browser/API/SQL scenarios with 3,915 assertions, including interrupted-poll recovery. The separate Chromium/WebKit browser suite previously passed 77 assertions. No real account, hosted wager, or hosted balance write is part of this verification. The existing financial regression runner remains separately available as `SOCCER_API_ONLY=1 node tests/e2e-soccer.cjs`.

Connection edge cases run with `node tests/e2e-connection.cjs` and `BROWSER=webkit node tests/e2e-connection.cjs`. Both engines passed five scenarios covering recovery, preserved operation errors, coalesced refreshes, deferred presence heartbeats, and obsolete failures. These focused scenarios fulfill API replies locally. `npm test` passed 59 unit tests, including eight connection transport, deadline, and diagnostic privacy tests.

Hosted upstream calls share a 26-second request budget; the browser allows 28 seconds and Vercel allows 30 seconds. Failure logs contain only fixed route/operation labels, status/protocol codes, timing, and failure classes. Request bodies, credentials, account identifiers, and upstream error messages are excluded. Authentication remains fresh and mutations are never automatically replayed.
