# 2player

KGS11th accounts and shared 轟, with two-player flick soccer.

Each team has eight pieces and chooses one of three opening formations. Players
take turns pulling one of their pieces back and releasing it in the opposite
direction; pull distance sets power. The server resolves each shot and its
collisions before the turn changes. Both players agree to the same
stake before a match starts; confirmed results settle once through the shared
wallet ledger.

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
the external-site link. See `docs/QA.md` for the isolated API/database and browser
checks; public-asset checks intercept every API request.
