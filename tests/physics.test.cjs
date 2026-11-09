'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const physics = require('../public/physics.js');
const REST = Object.freeze({ angle: 0, power: 0, piece: 0 });
const shot = (angle, power = 100, piece = 7) => ({ angle, power, piece });

function flip(state) {
  const rotate = point => ({ x: 640 - point.x, y: 960 - point.y });
  return {
    players: [...state.players.slice(8).map(rotate), ...state.players.slice(0, 8).map(rotate)],
    ball: rotate(state.ball)
  };
}

function isolatedState() {
  const row = [60, 140, 220, 420, 500, 580];
  return {
    players: [
      ...row.map(x => ({ x, y: 860 })), { x: 60, y: 760 }, { x: 320, y: 600 },
      ...row.map(x => ({ x, y: 200 })), { x: 60, y: 300 }, { x: 320, y: 350 }
    ],
    ball: { x: 320, y: 480 }
  };
}

function goalState() {
  const state = isolatedState();
  state.players[7] = { x: 320, y: 110 };
  state.players[15] = { x: 500, y: 500 };
  state.ball = { x: 320, y: 35 };
  return state;
}

function closePoint(actual, expected) {
  assert.ok(Math.abs(actual.x - expected.x) < 0.0011, `${actual.x} != ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < 0.0011, `${actual.y} != ${expected.y}`);
}

function assertFrame(frame, isGoalEntry = false) {
  assert.deepEqual(Object.keys(frame).sort(), ['ball', 'players']);
  assert.equal(frame.players.length, 16);
  for (const point of [...frame.players, frame.ball]) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.ok(Math.abs(point.x * 1000 - Math.round(point.x * 1000)) < 1e-6);
    assert.ok(Math.abs(point.y * 1000 - Math.round(point.y * 1000)) < 1e-6);
  }
  for (const player of frame.players) {
    assert.ok(player.x >= 28 && player.x <= 612);
    assert.ok(player.y >= 28 && player.y <= 932);
  }
  assert.ok(frame.ball.x >= 14 && frame.ball.x <= 626);
  if (!isGoalEntry) assert.ok(frame.ball.y >= 0 && frame.ball.y <= 960);
}

function assertSeparated(state) {
  for (let a = 0; a < state.players.length; a++) {
    for (let b = a + 1; b < state.players.length; b++) {
      assert.ok(Math.hypot(state.players[a].x - state.players[b].x, state.players[a].y - state.players[b].y) >= 56);
    }
    assert.ok(Math.hypot(state.players[a].x - state.ball.x, state.players[a].y - state.ball.y) >= 42);
  }
}

test('version 2 creates fresh sixteen-piece state with eight pieces per seat', () => {
  assert.equal(physics.VERSION, 2);
  const state = physics.initialState();
  assertFrame(state);
  assert.deepEqual(state.ball, { x: 320, y: 480 });
  assert.equal(state.players.length, 16);
  assert.ok(state.players.slice(0, 8).every(point => point.y > 480));
  assert.ok(state.players.slice(8).every(point => point.y < 480));
  assert.deepEqual(state, physics.initialState([0, 0]));
  const originalX = state.players[0].x;
  state.players[0].x = 100;
  assert.equal(physics.initialState().players[0].x, originalX);
});

test('three distinct balanced formations include a goalkeeper and no initial overlaps', () => {
  const formations = [0, 1, 2].map(value => physics.initialState([value, value]));
  assert.equal(new Set(formations.map(state => JSON.stringify(state.players.slice(0, 8)))).size, 3);
  for (const state of formations) {
    assertFrame(state);
    assertSeparated(state);
    assert.deepEqual(flip(state), state);
    assert.deepEqual(state.players[0], { x: 320, y: 900 });
    assert.deepEqual(state.players[8], { x: 320, y: 60 });
  }
  for (let host = 0; host < 3; host++) {
    for (let guest = 0; guest < 3; guest++) {
      assert.deepEqual(flip(physics.initialState([host, guest])), physics.initialState([guest, host]));
    }
  }
});

test('a stationary shot rests without introducing movement for every formation', () => {
  for (const formations of [[0, 0], [1, 2], [2, 1]]) {
    const state = physics.initialState(formations);
    const result = physics.simulate(state, [REST, REST], formations);
    assert.equal(result.goal, null);
    assert.deepEqual(result.state, state);
    for (const frame of result.frames) assert.deepEqual(frame, state);
  }
});

test('each seat launches its selected own piece rather than a fixed player', () => {
  for (const [seat, piece, angle] of [[0, 1, 180], [0, 6, 0], [1, 1, 0], [1, 6, 180]]) {
    const state = physics.initialState();
    const inputs = [REST, REST];
    inputs[seat] = shot(angle, 10, piece);
    const result = physics.simulate(state, inputs);
    const activeIndex = seat * 8 + piece;
    assert.equal(result.goal, null);
    assert.notDeepEqual(result.state.players[activeIndex], state.players[activeIndex]);
    for (let index = 0; index < 16; index++) {
      if (index !== activeIndex) assert.deepEqual(result.state.players[index], state.players[index]);
    }
    assert.deepEqual(result.state.ball, state.ball);
  }
});

test('one selected flick transfers momentum to ball and passive opposing pieces', () => {
  const before = isolatedState();
  const result = physics.simulate(before, [shot(270), REST]);
  assert.ok(result.frames.some(frame => frame.ball.y < before.ball.y - 20));
  assert.ok(result.frames.some(frame => frame.players[15].y < before.players[15].y - 20));
  assert.ok(result.frames.some(frame => frame.players[7].y < before.players[7].y));
  assert.deepEqual(before, isolatedState());
});

test('selected player can bump an opponent without touching the ball', () => {
  const state = isolatedState();
  state.players[15] = { x: 320, y: 480 };
  state.ball = { x: 100, y: 480 };
  const result = physics.simulate(state, [shot(270), REST]);
  assert.equal(result.goal, null);
  assert.ok(result.state.players[15].y < 300);
  assert.deepEqual(result.state.ball, state.ball);
});

test('both scoring seats map correctly and goal reset retains selected formations', () => {
  const formations = [1, 2];
  const host = physics.simulate(goalState(), [shot(270, 60), REST], formations);
  const guest = physics.simulate(flip(goalState()), [REST, shot(90, 60)], formations);
  assert.equal(host.goal, 0);
  assert.equal(guest.goal, 1);
  assert.ok(host.frames.at(-1).ball.y <= 0);
  assert.ok(guest.frames.at(-1).ball.y >= 960);
  assert.deepEqual(host.state, physics.initialState(formations));
  assert.deepEqual(guest.state, physics.initialState(formations));
});

test('solid end walls bounce the ball and posts obstruct mouth edges', () => {
  for (const x of [100, 220, 420, 540]) {
    const state = isolatedState();
    state.players[7] = { x, y: 110 };
    state.players[15] = { x: 500, y: 700 };
    state.ball = { x, y: 40 };
    const result = physics.simulate(state, [shot(270, 70), REST]);
    assert.equal(result.goal, null, `x=${x}`);
    assert.ok(result.frames.every(frame => frame.ball.y >= 14));
    const closest = Math.min(...result.frames.map(frame => frame.ball.y));
    assert.ok(result.state.ball.y > closest + 0.5);
    if (x === 220 || x === 420) assert.ok(closest >= 22);
  }
});

test('seat exchange and rotation preserve selected-piece trajectories', () => {
  for (const [angle, piece] of [[0, 1], [45, 4], [90, 2], [142, 5], [180, 6], [268, 7], [270, 7], [315, 3]]) {
    const formations = [1, 2];
    const state = physics.initialState(formations);
    const first = physics.simulate(state, [shot(angle, 89, piece), REST], formations);
    const second = physics.simulate(flip(state), [REST, shot((angle + 180) % 360, 89, piece)], [2, 1]);
    assert.equal(first.frames.length, second.frames.length);
    assert.equal(second.goal, first.goal === null ? null : 1 - first.goal);
    for (let i = 0; i < first.frames.length; i++) {
      const expected = flip(first.frames[i]);
      for (let index = 0; index < 16; index++) closePoint(second.frames[i].players[index], expected.players[index]);
      closePoint(second.frames[i].ball, expected.ball);
    }
  }
});

test('symmetric opposing selected-piece contacts do not favor either seat', () => {
  const result = physics.simulate(physics.initialState(), [shot(270), shot(90)]);
  assert.equal(result.goal, null);
  assert.equal(result.state.ball.x, 320);
  assert.equal(result.state.ball.y, 480);
  const expected = flip(result.state);
  for (let index = 0; index < 16; index++) closePoint(result.state.players[index], expected.players[index]);
});

test('locked commands are independent of delayed or reordered delivery', () => {
  const state = physics.initialState([1, 2]);
  const command = Object.freeze(shot(268, 89, 6));
  const expected = physics.simulate(state, [command, REST], [1, 2]);
  const delivered = new Map([[1, REST], [0, command]]);
  for (let deliveryDelay = 0; deliveryDelay < 5; deliveryDelay++) {
    assert.deepEqual(physics.simulate(state, [delivered.get(0), delivered.get(1)], [1, 2]), expected);
  }
  assert.deepEqual(
    physics.simulate(expected.state, [REST, shot(88, 89, 5)], [1, 2]),
    physics.simulate(JSON.parse(JSON.stringify(expected.state)), [REST, shot(88, 89, 5)], [1, 2])
  );
});

test('browser and Node match without wall clocks or randomness', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/physics.js'), 'utf8');
  const noClock = () => { throw new Error('wall clock used'); };
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => { throw new Error('randomness used'); };
  const context = vm.createContext({ Date: noClock, performance: { now: noClock }, Math: deterministicMath });
  vm.runInContext(source, context);
  const browser = vm.runInContext('SoccerPhysics.simulate(SoccerPhysics.initialState([1,2]), [{angle:268,power:89,piece:6},{angle:0,power:0,piece:0}], [1,2])', context);
  assert.deepEqual(JSON.parse(JSON.stringify(browser)), physics.simulate(physics.initialState([1, 2]), [shot(268, 89, 6), REST], [1, 2]));
});

test('snapshots, initial positions, commands, and formations remain independent', () => {
  const formations = [1, 2];
  const state = physics.initialState(formations);
  const inputs = [shot(270, 40, 7), { ...REST }];
  const serialized = JSON.stringify({ state, inputs, formations });
  const result = physics.simulate(state, inputs, formations);
  assert.equal(JSON.stringify({ state, inputs, formations }), serialized);
  const finalX = result.state.players[0].x;
  result.frames[0].players[0].x = 1;
  assert.equal(result.state.players[0].x, finalX);
  assert.equal(result.frames[1].players[0].x, state.players[0].x);
});

test('valid overlapping selected players stay finite without exploding', () => {
  const state = isolatedState();
  state.players[7] = { x: 320, y: 480 };
  state.players[15] = { x: 320, y: 480 };
  const result = physics.simulate(state, [shot(0), shot(180)]);
  result.frames.forEach((frame, index) => assertFrame(frame, result.goal !== null && index === result.frames.length - 1));
  assert.ok(result.frames.length <= 121);
});

test('seeded alternating piece selections retain bounded and compact frames', () => {
  let seed = 912412;
  const random = max => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  const formations = [1, 2];
  let state = physics.initialState(formations);
  for (let turn = 0; turn < 120; turn++) {
    const inputs = [REST, REST];
    inputs[turn % 2] = shot(random(360), random(101), random(8));
    const result = physics.simulate(state, inputs, formations);
    assert.ok(result.frames.length >= 2 && result.frames.length <= 121);
    assert.ok(Buffer.byteLength(JSON.stringify(result.frames)) <= 110 * 1024);
    result.frames.forEach((frame, index) => assertFrame(frame, result.goal !== null && index === result.frames.length - 1));
    assertFrame(result.state);
    if (result.goal === null) assert.deepEqual(result.frames.at(-1), result.state);
    state = result.state;
  }
});

test('state coordinates are normalized to thousandths', () => {
  const state = physics.initialState();
  state.players[0].x = 320.1234567;
  const result = physics.simulate(state, [REST, REST]);
  assert.equal(result.state.players[0].x, 320.123);
});

test('malformed states and nonfinite coordinates are rejected', () => {
  const invalid = [null, {}, { ...physics.initialState(), extra: true }];
  for (const coordinate of [NaN, Infinity, -Infinity, '320', null]) {
    const state = physics.initialState();
    state.ball.x = coordinate;
    invalid.push(state);
  }
  for (const position of [{ x: 27, y: 500 }, { x: 613, y: 500 }, { x: 320, y: 933 }]) {
    const state = physics.initialState();
    state.players[0] = position;
    invalid.push(state);
  }
  for (const size of [0, 2, 8, 15, 17]) invalid.push({ players: Array.from({ length: size }, () => ({ x: 320, y: 480 })), ball: { x: 320, y: 480 } });
  invalid.push({ players: physics.initialState().players, ball: { x: 100, y: 1 } });
  for (const state of invalid) assert.throws(() => physics.simulate(state, [REST, REST]));
});

test('piece selection cannot address an opponent or an absent piece', () => {
  for (const piece of [-1, 8, 15, 16, 1.5, NaN, Infinity, '1', null, undefined]) {
    assert.throws(() => physics.simulate(physics.initialState(), [{ angle: 270, power: 80, piece }, REST]));
    assert.throws(() => physics.simulate(physics.initialState(), [REST, { angle: 90, power: 80, piece }]));
  }
  assert.throws(() => physics.simulate(physics.initialState(), [{ angle: 270, power: 80 }, REST]));
});

test('commands require exact finite integer angle and power bounds', () => {
  const invalid = [
    null, [], [REST], new Array(2), [REST, null],
    [shot(-1), REST], [shot(360), REST], [shot(1.5), REST],
    [shot(NaN), REST], [shot(Infinity), REST], [shot('90'), REST],
    [shot(90, -1), REST], [shot(90, 101), REST], [shot(90, 1.5), REST],
    [shot(90, NaN), REST], [{ angle: 90, power: 10, piece: 0, velocity: 1000 }, REST]
  ];
  for (const inputs of invalid) assert.throws(() => physics.simulate(physics.initialState(), inputs));
});

test('formation selection requires two valid integer formation IDs', () => {
  for (const formations of [null, [], [0], [0, 0, 0], [-1, 0], [0, 3], [1.5, 0], ['1', 0], [NaN, 0], new Array(2)]) {
    assert.throws(() => physics.initialState(formations));
    assert.throws(() => physics.simulate(physics.initialState(), [REST, REST], formations));
  }
});
