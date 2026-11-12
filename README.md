# 2player

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

The lobby now shows only ランダム, the online-member list, and the points
ranking. No stake input is shown until an opponent has been paired. The queue
and direct invitations use a temporary 100-轟 placeholder that never reserves
funds; both players select their own real stakes in the matched room and must
explicitly confirm the two displayed amounts before funding. Direct challenges
still require acceptance and random pairing still uses arrival order.

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
