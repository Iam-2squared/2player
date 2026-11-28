# Soccer physics contract, version 2

The server runs one flick to completion with `require('../public/physics.js')`.
The UMD module also exposes `globalThis.SoccerPhysics`; browsers display the
server's returned frames and never decide collisions, goals, or winners.

```js
const { VERSION, initialState, simulate } = require('./public/physics.js');
const formations = [0, 2]; // host formation, guest formation
const result = simulate(initialState(formations), [
  { piece: 7, angle: 270, power: 89 }, // active host, seat 0
  { piece: 0, angle: 0, power: 0 }     // passive guest, seat 1
], formations);
// VERSION === 2; result: { state, frames, goal: 0 | 1 | null }
```

Play alternates between seats. Each seat owns eight circular pieces, including
one goalkeeper. The API supplies the active seat's immutable command and a
zero-power command for the other seat. `piece` is a seat-local integer from
0 through 7; the engine maps it to `seat * 8 + piece`. Selecting piece 8 or
passing a global opponent index is invalid. Only the chosen piece receives the
initial launch; collisions can move any piece and the ball.

The API owns turn authorization, formation selection and locking, scores,
first-to-three victory, timeouts, and settlement. The engine runs exactly one
shot and cannot access a clock, network latency, random number generator, or
client-reported winner. The same locked commands in seat order always produce
identical server frames. Version 2 rejects the old two-piece version-1 shape;
previous resolved match records must stay historical and must not be replayed
with this engine.

Every state and frame contains positions only:

```js
{
  players: [/* host pieces 0..7, then guest pieces 0..7: 16 {x,y} objects */],
  ball: { x: 320, y: 480 }
}
```

`initialState(formations)` accepts exactly two formation IDs from 0 through 2;
its default is `[0,0]`. Each layout has eight pieces and no initial overlaps.
Piece 0 is the goalkeeper. Host coordinates below are ordered by piece index;
guest coordinates preserve that order and rotate each point by 180 degrees:
`x = 640 - hostX`, `y = 960 - hostY`.

```text
0: (320,900) (140,790) (320,790) (500,790) (140,670) (320,670) (500,670) (320,560)
1: (320,900) (220,790) (420,790) (120,680) (320,680) (520,680) (230,560) (410,560)
2: (320,900) (190,800) (450,800) (200,680) (440,680) (160,560) (320,560) (480,560)
```

The pitch measures 640 by 960. Positive x points right; positive y points down.
An angle is an integer from 0 through 359 degrees: 0 right, 90 down, 180 left,
270 up. Power is an integer from 0 through 100. A slingshot UI starts on an
owned piece, aims opposite the pull vector, and maps pull distance to power;
only the resulting integer command reaches the engine.

Seat 0 starts at the bottom and scores in the top goal; seat 1 starts at the
top and scores in the bottom goal. Goal mouths span x=220 through x=420 at y=0
and y=960, with radius-8 posts at their endpoints. Piece discs have radius 28
and mass 3. The ball has radius 14 and mass 1. Only the ball can enter a goal;
pieces collide with the end walls. No formation has a built-in speed or power
advantage; both seats use mirrored positions and the same physical constants.

A shot launches the selected piece, which can transfer momentum to other
pieces and the ball. Fixed steps run at 120 Hz for at most 720 steps (six
simulated seconds), with circle contacts, bounded impulses, wall and post
bounces, drag, and rolling friction. Three contact passes use accumulated
impulses to keep symmetric contacts symmetric. All motion rests between turns;
velocities are never serialized or carried into the next shot. The six-second
cap also discards any residual velocity.

`frames` starts with the normalized initial position and samples every six
physics steps (20 Hz). Its final frame always contains the terminal position,
including a goal entry, even if that step falls between regular samples. Treat
successive frames as 50 ms apart for playback; that final short interval may
also be displayed for 50 ms. A result contains at most 121 frames. Even a
conservative 121-frame payload with all 17 positions at three decimal places
uses 56,024 bytes of JSON. Database JSONB storage has additional overhead and
must use the version-2 result limits rather than version-1 limits. Frames and
returned state are independent objects. All serialized coordinates are rounded
to 0.001 and negative zero is removed.

A ball crossing y=0 scores for seat 0, and crossing y=960 scores for seat 1.
When `goal` is non-null, `frames` retains the goal entry and `state` is a fresh
kickoff state using the optional third `formations` argument. The server must
pass the match's two locked formation IDs so goals retain the chosen layouts.
Otherwise, `state` equals the final frame. Clients must use `goal`, rather than
infer a score from rounded frame coordinates, and wait for queued server frame
playback to finish before enabling the next flick.

The engine copies and validates all inputs before simulation. It rejects
unknown state/point/command fields, missing pieces, non-numeric or nonfinite
coordinates, out-of-bounds positions, and noninteger or out-of-range commands
and formations. Piece centers must stay inside radius-inset pitch bounds. Ball
centers must stay inside the side walls and y=0..960; the strips beyond the end
walls are valid only within a goal mouth. Overlapping pieces remain safe and
are separated by the contact solver. Persist only server-generated resting
states.

Run `node --test tests/physics.test.cjs` for formation counts and ownership,
deterministic trajectories, mirror symmetry, goal mapping and layout resets,
wall/post collisions, knockback, browser parity, strict validation, immutable
inputs, bounded payloads, and seeded multi-turn checks.
