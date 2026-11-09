(function (root, factory) {
  'use strict';
  var physics = factory();
  if (typeof module === 'object' && module.exports) module.exports = physics;
  else root.SoccerPhysics = physics;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 2;
  var TEAM_SIZE = 8;
  var FORMATION_COUNT = 3;
  var WIDTH = 640;
  var HEIGHT = 960;
  var PLAYER_RADIUS = 28;
  var BALL_RADIUS = 14;
  var GOAL_LEFT = 220;
  var GOAL_RIGHT = 420;
  var POST_RADIUS = 8;
  var STEPS_PER_SECOND = 120;
  var FRAME_RATE = 20;
  var MAX_STEPS = STEPS_PER_SECOND * 6;
  var MAX_LAUNCH_SPEED = 1050;
  var MAX_SPEED = 2000;
  var STOP_SPEED = 2;
  var DT = 1 / STEPS_PER_SECOND;
  var EPSILON = 1e-9;
  // Each formation keeps a goalkeeper and seven field pieces. The opposite
  // seat receives exactly the same positions rotated through 180 degrees.
  var FORMATIONS = [
    [[320, 900], [140, 790], [320, 790], [500, 790], [140, 670], [320, 670], [500, 670], [320, 560]],
    [[320, 900], [220, 790], [420, 790], [120, 680], [320, 680], [520, 680], [230, 560], [410, 560]],
    [[320, 900], [190, 800], [450, 800], [200, 680], [440, 680], [160, 560], [320, 560], [480, 560]]
  ];

  function quantize(value) {
    var result = Math.round(value * 1000) / 1000;
    return result === 0 ? 0 : result;
  }

  function readFormations(formations) {
    if (formations === undefined) return [0, 0];
    if (!Array.isArray(formations) || formations.length !== 2 ||
        !Number.isInteger(formations[0]) || formations[0] < 0 || formations[0] >= FORMATION_COUNT ||
        !Number.isInteger(formations[1]) || formations[1] < 0 || formations[1] >= FORMATION_COUNT) {
      throw new RangeError('formations must contain two integers from 0 to 2');
    }
    return [formations[0], formations[1]];
  }

  function initialState(formations) {
    var selected = readFormations(formations);
    var players = [];
    selected.forEach(function (formation, seat) {
      FORMATIONS[formation].forEach(function (point) {
        players.push({ x: seat === 0 ? point[0] : WIDTH - point[0], y: seat === 0 ? point[1] : HEIGHT - point[1] });
      });
    });
    return {
      players: players,
      ball: { x: 320, y: 480 }
    };
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function checkKeys(value, keys, label) {
    if (!isPlainObject(value)) throw new TypeError(label + ' must be an object');
    var actual = Object.keys(value);
    if (actual.length !== keys.length || keys.some(function (key) {
      return !Object.prototype.hasOwnProperty.call(value, key);
    })) throw new TypeError(label + ' has invalid fields');
  }

  function readPoint(point, radius, label, isBall) {
    checkKeys(point, ['x', 'y'], label);
    if (typeof point.x !== 'number' || typeof point.y !== 'number' ||
        !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new TypeError(label + ' coordinates must be finite numbers');
    }
    var minY = isBall ? 0 : radius;
    var maxY = isBall ? HEIGHT : HEIGHT - radius;
    if (point.x < radius || point.x > WIDTH - radius || point.y < minY || point.y > maxY) {
      throw new RangeError(label + ' is outside the pitch');
    }
    if (isBall && (point.y < radius || point.y > HEIGHT - radius) &&
        (point.x < GOAL_LEFT || point.x > GOAL_RIGHT)) {
      throw new RangeError(label + ' is outside the goal mouth');
    }
    return { x: quantize(point.x), y: quantize(point.y) };
  }

  function readState(state) {
    checkKeys(state, ['players', 'ball'], 'state');
    if (!Array.isArray(state.players) || state.players.length !== TEAM_SIZE * 2) {
      throw new TypeError('state.players must contain exactly sixteen pieces');
    }
    return {
      players: Array.from({ length: TEAM_SIZE * 2 }, function (_, index) {
        return readPoint(state.players[index], PLAYER_RADIUS, 'piece ' + index, false);
      }),
      ball: readPoint(state.ball, BALL_RADIUS, 'ball', true)
    };
  }

  function readInputs(inputs) {
    if (!Array.isArray(inputs) || inputs.length !== 2) {
      throw new TypeError('inputs must contain exactly two commands');
    }
    return [0, 1].map(function (index) {
      var input = inputs[index];
      checkKeys(input, ['angle', 'power', 'piece'], 'input ' + index);
      if (!Number.isInteger(input.piece) || input.piece < 0 || input.piece >= TEAM_SIZE) {
        throw new RangeError('piece must be an integer from 0 to 7 for its seat');
      }
      if (!Number.isInteger(input.angle) || input.angle < 0 || input.angle > 359) {
        throw new RangeError('angle must be an integer from 0 to 359');
      }
      if (!Number.isInteger(input.power) || input.power < 0 || input.power > 100) {
        throw new RangeError('power must be an integer from 0 to 100');
      }
      return { angle: input.angle, power: input.power, piece: input.piece };
    });
  }

  function body(point, radius, mass, input) {
    var radians = input ? input.angle * Math.PI / 180 : 0;
    var speed = input ? input.power * MAX_LAUNCH_SPEED / 100 : 0;
    return {
      x: point.x, y: point.y,
      vx: Math.cos(radians) * speed,
      vy: Math.sin(radians) * speed,
      radius: radius, inverseMass: 1 / mass
    };
  }

  function snapshot(bodies) {
    return {
      players: bodies.slice(0, TEAM_SIZE * 2).map(function (disc) {
        return { x: quantize(disc.x), y: quantize(disc.y) };
      }),
      ball: { x: quantize(bodies[TEAM_SIZE * 2].x), y: quantize(bodies[TEAM_SIZE * 2].y) }
    };
  }

  function limitSpeed(disc) {
    var speed = Math.hypot(disc.vx, disc.vy);
    if (speed > MAX_SPEED) {
      disc.vx *= MAX_SPEED / speed;
      disc.vy *= MAX_SPEED / speed;
    }
  }

  // Accumulate contacts together so exchanging the two player seats does not
  // change the outcome of a simultaneous, symmetric contact with the ball.
  function resolveDiscs(bodies) {
    var changes = bodies.map(function () { return { x: 0, y: 0, vx: 0, vy: 0 }; });
    for (var first = 0; first < bodies.length; first += 1) {
      for (var second = first + 1; second < bodies.length; second += 1) {
        var a = bodies[first];
        var b = bodies[second];
        var dx = b.x - a.x;
        var dy = b.y - a.y;
        var distance = Math.hypot(dx, dy);
        var contact = a.radius + b.radius;
        if (distance >= contact) continue;
        // An exact overlap has no physical normal. This fixed vertical normal
        // still gives valid finite results for an externally supplied state.
        var nx = distance > EPSILON ? dx / distance : 0;
        var ny = distance > EPSILON ? dy / distance : (first === 0 ? -1 : 1);
        var inverseMass = a.inverseMass + b.inverseMass;
        var correction = (contact - distance + 0.001) / inverseMass;
        changes[first].x -= nx * correction * a.inverseMass;
        changes[first].y -= ny * correction * a.inverseMass;
        changes[second].x += nx * correction * b.inverseMass;
        changes[second].y += ny * correction * b.inverseMass;

        var approach = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (approach >= 0) continue;
        var restitution = second === TEAM_SIZE * 2 ? 0.92 : 0.88;
        var impulse = -(1 + restitution) * approach / inverseMass;
        changes[first].vx -= nx * impulse * a.inverseMass;
        changes[first].vy -= ny * impulse * a.inverseMass;
        changes[second].vx += nx * impulse * b.inverseMass;
        changes[second].vy += ny * impulse * b.inverseMass;
      }
    }
    bodies.forEach(function (disc, index) {
      var change = changes[index];
      disc.x += change.x;
      disc.y += change.y;
      disc.vx += change.vx;
      disc.vy += change.vy;
      limitSpeed(disc);
    });
  }

  function reflect(disc, nx, ny) {
    var inward = disc.vx * nx + disc.vy * ny;
    if (inward < 0) {
      disc.vx -= 1.84 * inward * nx;
      disc.vy -= 1.84 * inward * ny;
    }
  }

  function resolvePost(disc, x, y) {
    var dx = disc.x - x;
    var dy = disc.y - y;
    var distance = Math.hypot(dx, dy);
    var contact = disc.radius + POST_RADIUS;
    if (distance >= contact) return;
    var nx = distance > EPSILON ? dx / distance : 0;
    var ny = distance > EPSILON ? dy / distance : (y === 0 ? 1 : -1);
    disc.x = x + nx * contact;
    disc.y = y + ny * contact;
    reflect(disc, nx, ny);
  }

  function resolvePitch(disc, isBall) {
    var radius = disc.radius;
    if (disc.x < radius) {
      disc.x = radius;
      reflect(disc, 1, 0);
    } else if (disc.x > WIDTH - radius) {
      disc.x = WIDTH - radius;
      reflect(disc, -1, 0);
    }
    // Players stay in the arena; only the ball can pass through a goal mouth.
    var inMouth = isBall && disc.x > GOAL_LEFT && disc.x < GOAL_RIGHT;
    if (!inMouth && disc.y < radius) {
      disc.y = radius;
      reflect(disc, 0, 1);
    } else if (!inMouth && disc.y > HEIGHT - radius) {
      disc.y = HEIGHT - radius;
      reflect(disc, 0, -1);
    }
    resolvePost(disc, GOAL_LEFT, 0);
    resolvePost(disc, GOAL_RIGHT, 0);
    resolvePost(disc, GOAL_LEFT, HEIGHT);
    resolvePost(disc, GOAL_RIGHT, HEIGHT);
  }

  function slow(disc, isBall) {
    var speed = Math.hypot(disc.vx, disc.vy);
    var nextSpeed = speed * (isBall ? 0.992 : 0.988) - (isBall ? 45 : 70) * DT;
    if (nextSpeed <= STOP_SPEED) {
      disc.vx = 0;
      disc.vy = 0;
    } else {
      disc.vx *= nextSpeed / speed;
      disc.vy *= nextSpeed / speed;
    }
  }

  function simulate(state, inputs, formations) {
    var normalized = readState(state);
    var commands = readInputs(inputs);
    var selected = readFormations(formations);
    var bodies = normalized.players.map(function (point, index) {
      var command = commands[Math.floor(index / TEAM_SIZE)];
      return body(point, PLAYER_RADIUS, 3, command.piece === index % TEAM_SIZE ? command : null);
    });
    bodies.push(body(normalized.ball, BALL_RADIUS, 1, null));
    var frames = [snapshot(bodies)];
    var goal = null;
    for (var step = 1; step <= MAX_STEPS; step += 1) {
      bodies.forEach(function (disc) {
        disc.x += disc.vx * DT;
        disc.y += disc.vy * DT;
      });
      // Three deterministic solver passes separate collisions at walls/posts.
      for (var pass = 0; pass < 3; pass += 1) {
        resolveDiscs(bodies);
        bodies.forEach(function (disc, index) { resolvePitch(disc, index === TEAM_SIZE * 2); });
      }
      var ball = bodies[TEAM_SIZE * 2];
      if (ball.y <= 0) goal = 0;
      else if (ball.y >= HEIGHT) goal = 1;

      bodies.forEach(function (disc, index) { slow(disc, index === TEAM_SIZE * 2); });
      var stopped = bodies.every(function (disc) { return disc.vx === 0 && disc.vy === 0; });
      var terminal = goal !== null || stopped || step === MAX_STEPS;
      if (step % (STEPS_PER_SECOND / FRAME_RATE) === 0 || terminal) frames.push(snapshot(bodies));
      if (terminal) break;
    }
    return { state: goal === null ? snapshot(bodies) : initialState(selected), frames: frames, goal: goal };
  }

  return Object.freeze({
    VERSION: VERSION,
    TEAM_SIZE: TEAM_SIZE,
    FORMATION_COUNT: FORMATION_COUNT,
    WIDTH: WIDTH,
    HEIGHT: HEIGHT,
    PLAYER_RADIUS: PLAYER_RADIUS,
    BALL_RADIUS: BALL_RADIUS,
    GOAL_LEFT: GOAL_LEFT,
    GOAL_RIGHT: GOAL_RIGHT,
    POST_RADIUS: POST_RADIUS,
    FRAME_RATE: FRAME_RATE,
    initialState: initialState,
    simulate: simulate
  });
});
