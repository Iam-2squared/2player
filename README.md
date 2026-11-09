# 2player

KGS11th accounts and shared 轟, with two-player flick soccer.

Each team has eight pieces and chooses one of three opening formations. Players
take turns pulling one of their pieces back and releasing it in the opposite
direction; pull distance sets power. The server resolves each shot and its
collisions before the turn changes. Both players agree to the same
stake before a match starts; confirmed results settle once through the shared
wallet ledger.

After login, choose an online opponent or press ランダム to join the waiting
queue. Direct challenges require the recipient's acceptance; random opponents
pair in waiting order. Both paths keep the pregame stake and formation choices
and explicit confirmation before any funds are reserved. Room codes are not
part of the current interface. Presence is maintained by session heartbeats.

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
