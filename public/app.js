(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const FORMATIONS = [
    [[320,900],[140,790],[320,790],[500,790],[140,670],[320,670],[500,670],[320,560]],
    [[320,900],[220,790],[420,790],[120,680],[320,680],[520,680],[230,560],[410,560]],
    [[320,900],[190,800],[450,800],[200,680],[440,680],[160,560],[320,560],[480,560]],
  ];
  const INITIAL = { players: [...FORMATIONS[0].map(([x,y]) => ({x,y})), ...FORMATIONS[0].map(([x,y]) => ({x:640-x,y:960-y}))], ball: {x:320,y:480} };
  const MAX_PULL = 180;
  const COLORS = ['#f04d50', '#08b2d4'];
  const VIEWS = ['boot', 'login', 'lobby', 'room', 'game'];
  const fmt = value => new Intl.NumberFormat('ja-JP').format(Number(value) || 0);
  const S = {
    user: null, wallet: null, match: null, rooms: [], booting: true,
    busy: '', epoch: 0, abort: new AbortController(), poll: null,
    pending: null, angle: 270, power: 65, piece: 0, animation: null, animationQueue: [], raf: 0,
    cancelOpen: false, offerVersion: '', noticeTimer: null,
    dragging: null, displayedRound: null, connectionLost: false,
  };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const text = (id, value) => { const node = $(id); if (node) node.textContent = value == null ? '' : String(value); };
  const show = (id, visible) => { const node = $(id); if (node) node.hidden = !visible; };
  const accountKey = prefix => `2player.${prefix}:${S.user?.id ?? ''}`;
  const sameId = (a, b) => a != null && b != null && String(a) === String(b);
  const myRole = (m = S.match) => sameId(m?.host?.memberId, S.user?.id) ? 'host' : sameId(m?.guest?.memberId, S.user?.id) ? 'guest' : null;
  const ownPlayer = () => S.match?.[myRole()];
  const seat = () => myRole() === 'guest' ? 1 : 0;
  const isEnded = m => m?.status === 'finished' || m?.status === 'cancelled';
  const canShoot = () => !!S.user && !!S.match && S.match.status === 'playing' && S.match.turn === myRole() && !ownPlayer()?.inputLocked && !S.animation && !S.busy && !S.pending;
  const readStorage = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
  const writeStorage = (key, value) => { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch { /* Cookies still keep the signed-in session usable. */ } };
  const newId = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };

  class ApiError extends Error {
    constructor(message, code, status) { super(message); this.code = code; this.status = status; }
  }

  async function request(path, { method = 'GET', body, epoch = S.epoch } = {}) {
    const sessionSignal = S.abort.signal;
    const controller = new AbortController();
    const abort = () => controller.abort();
    let timedOut = false;
    sessionSignal.addEventListener('abort', abort, { once: true });
    if (sessionSignal.aborted) controller.abort();
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    try {
      const response = await fetch(`/api/${path}`, {
        method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let data;
      try { data = await response.json(); }
      catch { throw new ApiError('通信の結果を確認できませんでした。もう一度お試しください。', 'INVALID_RESPONSE', response.status); }
      if (epoch !== S.epoch) throw new DOMException('Stale session', 'AbortError');
      if (!response.ok || data.ok === false) {
        const error = data.error;
        throw new ApiError(typeof error === 'string' ? error : error?.message || '操作を完了できませんでした。', error?.code || 'REQUEST_FAILED', response.status);
      }
      return data;
    } catch (error) {
      if (timedOut) throw new ApiError('接続に時間がかかっています。接続を確認してもう一度お試しください。', 'REQUEST_TIMEOUT', 0);
      throw error;
    } finally {
      clearTimeout(timeout);
      sessionSignal.removeEventListener('abort', abort);
    }
  }

  function notify(message, error = false, sticky = false) {
    clearTimeout(S.noticeTimer);
    text('notice-text', message);
    $('notice').classList.toggle('error', error);
    show('notice', true);
    if (!sticky) S.noticeTimer = setTimeout(() => show('notice', false), 8000);
  }

  function setSession(user, wallet) {
    S.epoch += 1;
    S.abort.abort();
    S.abort = new AbortController();
    clearTimeout(S.poll);
    stopAnimation();
    S.user = user;
    S.wallet = wallet;
    S.match = null;
    S.rooms = [];
    S.busy = '';
    S.cancelOpen = false;
    S.dragging = null;
    S.offerVersion = '';
    S.displayedRound = null;
    const saved = user ? readStorage(accountKey('pending')) : null;
    S.pending = saved && typeof saved.path === 'string' && saved.body?.requestId ? saved : null;
    $('pin').value = '';
    $('login-error').hidden = true;
    S.connectionLost = false;
  }

  function saveActive(code) {
    if (S.user) writeStorage(accountKey('active'), code || null);
  }

  function scoreOf(role, m = S.match) {
    if (Array.isArray(m?.scores)) return Number(m.scores[role === 'host' ? 0 : 1]) || 0;
    return Number(m?.scores?.[role] ?? m?.[`${role}Score`] ?? 0) || 0;
  }

  function applyData(data, { initial = false } = {}) {
    if ('wallet' in data) {
      let current = false;
      try { current = S.wallet?.walletRevision != null && data.wallet?.walletRevision != null && BigInt(data.wallet.walletRevision) < BigInt(S.wallet.walletRevision); }
      catch { /* Revisions from older sessions can be absent. */ }
      if (!current) S.wallet = data.wallet;
    }
    if (Array.isArray(data.rooms)) S.rooms = data.rooms;
    if (data.match) applyMatch(data.match, initial);
    render();
  }

  function timestampMicros(value) {
    const base=Date.parse(value||''); if(!Number.isFinite(base))return null;
    const fraction=String(value).match(/\.(\d+)/)?.[1]||'';
    return BigInt(base)*1000n+BigInt((fraction+'000000').slice(3,6));
  }

  function applyMatch(match, initial = false) {
    const previous = S.match;
    const changed = previous?.id !== match.id;
    if (!changed && previous) {
      const previousUpdated = timestampMicros(previous.updatedAt);
      const nextUpdated = timestampMicros(match.updatedAt);
      if ((previousUpdated !== null && nextUpdated !== null && nextUpdated < previousUpdated) ||
          Number(match.round) < Number(previous.round) || (isEnded(previous) && !isEnded(match))) return;
    }
    S.match = match;
    saveActive(match.code);
    if (changed) {
      stopAnimation();
      S.dragging = null;
      S.cancelOpen = false;
      S.offerVersion = '';
      S.angle = 270;
      S.power = 65;
      S.piece = 0;
      updateAimControls();
    }
    const lastRound = match.lastRound;
    const resolvedRound = Number(typeof lastRound === 'object' ? lastRound?.round : lastRound);
    const frames = lastRound?.frames || match.frames;
    if (!changed && !initial && resolvedRound > Number(S.displayedRound || 0) && Array.isArray(frames) && frames.length > 1) {
      S.displayedRound = resolvedRound;
      if (S.animation) S.animationQueue.push({ frames, goal: lastRound?.goal });
      else playFrames(frames, lastRound?.goal);
    } else if (changed || initial) {
      S.displayedRound = resolvedRound || 0;
    }
    if (previous?.turn !== match.turn && match.status === 'playing' && !S.animation && !changed) {
      S.angle = 270;
      updateAimControls();
    }
  }

  function clearPending() {
    S.pending = null;
    if (S.user) writeStorage(accountKey('pending'), null);
  }

  async function mutate(path, body, { label = path, retry = false } = {}) {
    if (!S.user || S.busy || (S.pending && !retry)) return;
    const epoch = S.epoch;
    const operation = retry ? S.pending : { path, body: { ...body, requestId: newId() }, code: S.match?.code || '', createdAt: Date.now() };
    if (!operation) return;
    S.pending = operation;
    writeStorage(accountKey('pending'), operation);
    S.busy = label;
    render();
    try {
      const data = await request(operation.path, { method: 'POST', body: operation.body, epoch });
      if (epoch !== S.epoch) return;
      clearPending();
      S.busy = '';
      applyData(data);
      if (operation.path === 'rooms' || operation.path === 'rooms/join') {
        const url = new URL(location.href);
        url.searchParams.delete('room');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
      schedulePoll(400);
    } catch (error) {
      if (epoch !== S.epoch || error.name === 'AbortError') return;
      S.busy = '';
      if (error.status === 401) {
        setSession(null, null);
        notify('もう一度ログインしてください。', true, true);
      } else if (error.status >= 400 && error.status < 500) {
        clearPending();
        notify(error.message, true, true);
        if (S.match) void refreshMatch();
      } else {
        notify('接続を確認してください。', true, true);
      }
      render();
    } finally {
      if (epoch === S.epoch) { S.busy = ''; render(); }
    }
  }

  async function refreshRooms() {
    const epoch = S.epoch;
    if (!S.user) return;
    try {
      const data = await request('rooms', { epoch });
      if (epoch !== S.epoch) return;
      applyData(data);
      S.connectionLost = false;
    } catch (error) { handlePollError(error, epoch); }
  }

  async function refreshMatch({ initial = false, code = S.match?.code } = {}) {
    const epoch = S.epoch;
    if (!S.user || !code) return;
    try {
      const data = await request(`match?code=${encodeURIComponent(code)}`, { epoch });
      if (epoch !== S.epoch) return;
      const reconnected = S.connectionLost;
      S.connectionLost = false;
      applyData(data, { initial });
      if (reconnected) notify('再接続しました。');
    } catch (error) {
      if (epoch !== S.epoch) return;
      if (error.status === 404 || error.status === 403) {
        S.match = null;
        saveActive(null);
        notify(error.message, true, true);
        render();
      } else handlePollError(error, epoch);
    }
  }

  function handlePollError(error, epoch) {
    if (epoch !== S.epoch || error.name === 'AbortError') return;
    if (error.status === 401) {
      setSession(null, null);
      notify('もう一度ログインしてください。', true, true);
      render();
    } else if (!S.connectionLost) {
      S.connectionLost = true;
      notify('再接続中…', true, true);
    }
  }

  function schedulePoll(delay = 1800) {
    clearTimeout(S.poll);
    if (!S.user) return;
    S.poll = setTimeout(async () => {
      if (S.match && !isEnded(S.match)) await refreshMatch();
      else if (!S.match) await refreshRooms();
      schedulePoll(document.hidden ? 6000 : 1800);
    }, delay);
  }

  function expiryCopy(match) {
    const expiry = Date.parse(match?.expiresAt || '');
    if (!Number.isFinite(expiry)) return '10分無操作で返却';
    const minutes = Math.max(0, Math.ceil((expiry - Date.now()) / 60000));
    return minutes ? `${minutes}分で自動中止・返却` : '…';
  }

  function render() {
    const match = S.match;
    const active = S.booting ? 'boot' : !S.user ? 'login' : !match ? 'lobby' : match.status === 'waiting' ? 'room' : 'game';
    for (const view of VIEWS) show(`${view}-view`, active === view);
    show('account', !!S.user && !S.booting);
    if (S.user) {
      text('account-name', S.user.name || `出席番号 ${S.user.attendanceNo}`);
      text('wallet-balance', fmt(S.wallet?.balance));
    }
    $('logout-button').disabled = !!S.busy;
    show('retry-notice', !!S.pending && !S.busy);
    $('retry-action').disabled = !!S.busy;
    const blocked = !!S.busy || !!S.pending;
    $('create-room').disabled = blocked;
    $('join-room').disabled = blocked;
    text('create-room', S.busy === 'rooms' ? '部屋をつくっています…' : '部屋をつくる');
    text('join-room', S.busy === 'rooms/join' ? '部屋を確認しています…' : '参加する');
    if (active === 'lobby') renderRooms();
    if (active === 'room') renderRoom(blocked);
    if (active === 'game') renderGame(blocked);
    drawCurrent();
  }

  function renderRooms() {
    const list = $('rooms-list');
    list.replaceChildren();
    const rooms = S.rooms.filter(m => m && m.code && !isEnded(m));
    show('active-rooms', rooms.length > 0);
    for (const room of rooms) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'room-item';
      button.disabled = !!S.busy;
      const code = document.createElement('strong'); code.textContent = room.code;
      const names = document.createElement('span'); names.textContent = [room.host?.name, room.guest?.name || '相手を待っています'].filter(Boolean).join(' / ');
      const status = document.createElement('span'); status.className = 'room-item-state'; status.textContent = room.status === 'waiting' ? '待機中 →' : '対戦に戻る →';
      button.append(code, names, status);
      button.addEventListener('click', () => { void refreshMatch({ code: room.code, initial: true }); });
      list.append(button);
    }
  }

  function drawFormationChoices() {
    FORMATIONS.forEach((formation, index) => {
      const ctx = $('formation-canvas-' + index).getContext('2d');
      ctx.fillStyle = '#4fa83b'; ctx.fillRect(0,0,160,120);
      ctx.strokeStyle = '#ffffffa8'; ctx.lineWidth = 1.5;
      ctx.strokeRect(5,5,150,110); ctx.strokeRect(48,80,64,35);
      ctx.beginPath(); ctx.arc(80,5,22,0,Math.PI); ctx.stroke();
      formation.forEach(([x,y]) => {
        ctx.beginPath(); ctx.arc(x/4,(y-480)/4,5,0,Math.PI*2);
        ctx.fillStyle = COLORS[seat()]; ctx.fill(); ctx.strokeStyle = '#172a2d'; ctx.lineWidth=1.7; ctx.stroke();
      });
      const button = $('formation-' + index);
      button.setAttribute('aria-pressed', String(Number(ownPlayer()?.formation || 0) === index));
      button.disabled = !!S.busy || !!S.pending;
    });
  }

  function renderRoom(blocked) {
    const match = S.match;
    const role = myRole();
    const own = match[role];
    text('room-code', match.code);
    for (const playerRole of ['host', 'guest']) {
      const player = match[playerRole];
      text(`${playerRole}-name`, player ? `${player.name}${playerRole === role ? ' · 自分' : ''}` : '参加待ち');
      text(`${playerRole}-state`, !player ? '' : player.ready ? '✓' : '待機中');
      text(`${playerRole}-offer`, player ? `${fmt(player.offer)} 轟` : '—');
    }
    const offerVersion = `${match.id}:${own?.offer}`;
    if (S.offerVersion !== offerVersion && document.activeElement !== $('stake')) {
      $('stake').value = own?.offer || 100;
      S.offerVersion = offerVersion;
    }
    const equalOffers = !!match.guest && Number(match.host?.offer) === Number(match.guest?.offer);
    text('room-pot', fmt((Number(own?.offer) || 0) * 2));
    text('room-info', match.guest && !equalOffers ? '賭け額を合わせてください' : '');
    text('ready-hint', own?.ready ? '相手の準備待ち' : '同額・両者の準備完了で開始');
    text('ready-button', S.busy === 'ready' ? '…' : own?.ready ? '✓ 準備完了' : '準備完了');
    $('ready-button').disabled = blocked || !equalOffers || !!own?.ready;
    $('offer-submit').disabled = blocked;
    $('stake').disabled = blocked;
    $('leave-room').disabled = blocked;
    text('room-expiry', expiryCopy(match));
    drawFormationChoices();
  }

  function renderGame(blocked) {
    const match = S.match;
    const role = myRole();
    const ended = isEnded(match);
    const animating = !!S.animation;
    const mine = match.turn === role;
    const processing = match.status === 'processing' || !!match.host?.inputLocked || !!match.guest?.inputLocked;
    text('turn-title', ended ? '終了' : animating ? (S.animation.goal ? 'GOAL' : '● ● ●') : processing ? '…' : mine ? '自分の番' : '相手の番');
    text('round-label', `${Math.min(Number(match.round) || 1, 40)} / 40`);
    text('score-host-name', match.host?.name || '');
    text('score-guest-name', match.guest?.name || '');
    text('score-host', scoreOf('host')); text('score-guest', scoreOf('guest'));
    text('game-pot', fmt((Number(match.stake) || 0) * 2));
    text('escrow-amount', fmt(ended ? 0 : match.stake));
    text('team-label', '自分');
    $('team-label').classList.toggle('blue', role === 'guest');
    text('lock-input', S.busy === 'input' || animating || processing ? '…' : mine ? '弾く' : '相手の番');
    $('lock-input').disabled = !canShoot();
    $('aim-angle').disabled = !canShoot(); $('aim-power').disabled = !canShoot(); $('aim-piece').disabled = !canShoot();
    $('pitch').setAttribute('aria-disabled', String(!canShoot()));
    $('cancel-button').disabled = blocked; $('confirm-cancel').disabled = blocked;
    show('keyboard-controls', !ended); show('result-panel', ended && !animating); show('cancel-button', !ended);
    const opponentCancelled = !!match[role === 'host' ? 'guest' : 'host']?.cancelRequested;
    const ownCancelled = !!match[role]?.cancelRequested;
    show('cancel-panel', !ended && (S.cancelOpen || opponentCancelled || ownCancelled));
    text('cancel-title', opponentCancelled ? '相手が中止を希望' : ownCancelled ? '相手の同意待ち' : '中止しますか？');
    text('cancel-copy', '両者の同意で全額返却。');
    show('confirm-cancel', !ownCancelled); show('dismiss-cancel', !opponentCancelled && !ownCancelled);
    if (ended && !animating) renderResult();
  }

  function renderResult() {
    const match = S.match;
    const cancelled = match.status === 'cancelled';
    const draw = !cancelled && (!match.winner || match.winner === 'draw');
    const win = !draw && !cancelled && (match.winner === myRole() || sameId(match.winner, S.user?.id));
    const stake = Number(match.stake) || 0;
    text('result-title', cancelled ? '中止' : draw ? '引き分け' : win ? 'WIN' : 'LOSE');
    text('result-amount', cancelled || draw ? stake ? `${fmt(stake)} 轟返却` : '預かりなし' : win ? `${fmt(stake * 2)} 轟獲得` : `−${fmt(stake)} 轟`);
    text('result-copy', cancelled || draw ? '全額返却済み' : win ? `収支 ＋${fmt(stake)} 轟` : '');
    text('result-balance', fmt(S.wallet?.balance));
    $('rematch-button').disabled = !!S.busy || !!S.pending;
  }

  function updateAimControls() {
    $('aim-angle').value = S.angle; $('aim-power').value = S.power; $('aim-piece').value = S.piece;
    text('angle-output', `${S.angle}°`); text('power-output', `${S.power}%`);
    drawCurrent();
  }

  function stopAnimation() {
    cancelAnimationFrame(S.raf);
    S.animation = null;
    S.animationQueue = [];
  }

  function playFrames(frames, goal) {
    if (reducedMotion.matches) return;
    S.animation = { frames, goal, started: performance.now(), index: 0, fraction: 0 };
    const tick = now => {
      if (!S.animation) return;
      const index = Math.floor((now - S.animation.started) / 50);
      if (index >= S.animation.frames.length) {
        S.animation = null;
        const next = S.animationQueue.shift();
        if (next) {
          playFrames(next.frames, next.goal);
          render();
          return;
        }
        S.angle = 270;
        updateAimControls();
        render();
        return;
      }
      S.animation.index = index;
      S.animation.fraction = ((now - S.animation.started) / 50) - index;
      drawCurrent();
      S.raf = requestAnimationFrame(tick);
    };
    S.raf = requestAnimationFrame(tick);
  }

  function validState(value) {
    return value && Array.isArray(value.players) && value.players.length === 16 && value.players.every(p => Number.isFinite(p?.x) && Number.isFinite(p?.y)) && Number.isFinite(value.ball?.x) && Number.isFinite(value.ball?.y);
  }

  function currentState() {
    const state = S.animation ? S.animation.frames[S.animation.index] : S.match?.state;
    if (S.animation && validState(state)) {
      const next = S.animation.frames[S.animation.index + 1];
      if (validState(next)) {
        // Only interpolate published positions for drawing; game outcomes remain server-owned.
        const blend = (a, b) => ({ x: a.x + (b.x - a.x) * S.animation.fraction, y: a.y + (b.y - a.y) * S.animation.fraction });
        return { players: state.players.map((p, i) => blend(p, next.players[i])), ball: blend(state.ball, next.ball) };
      }
    }
    return validState(state) ? state : INITIAL;
  }

  function project(point, playerSeat = seat()) {
    return playerSeat === 1 ? { x: 640 - point.x, y: 960 - point.y } : point;
  }

  function drawCurrent() {
    if (!$('game-view').hidden) drawPitch($('pitch'), currentState(), seat(), canShoot());
  }

  function polygon(ctx, points, fill, stroke, width = 3) {
    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
  }

  function disc(ctx, point, radius, color) {
    ctx.beginPath(); ctx.ellipse(point.x + 7, point.y + 11, radius + 2, radius, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#1b5b3270'; ctx.fill();
    ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#101f25'; ctx.lineWidth = 6; ctx.stroke();
    ctx.beginPath(); ctx.arc(point.x - 5, point.y - 6, radius - 9, Math.PI * 1.13, Math.PI * 1.72);
    ctx.strokeStyle = '#ffffff66'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.stroke();
  }

  function football(ctx, point) {
    const { x, y } = point;
    ctx.beginPath(); ctx.ellipse(x + 5, y + 8, 15, 13, 0, 0, Math.PI * 2); ctx.fillStyle = '#235f3990'; ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.clip();
    const pentagon = (cx, cy, radius, offset) => Array.from({ length: 5 }, (_, i) => [cx + Math.cos(offset + i * Math.PI * 2 / 5) * radius, cy + Math.sin(offset + i * Math.PI * 2 / 5) * radius]);
    polygon(ctx, pentagon(x, y, 6.5, -Math.PI / 2), '#17272a');
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + i * Math.PI * 2 / 5;
      const bx = x + Math.cos(a) * 16;
      const by = y + Math.sin(a) * 16;
      polygon(ctx, pentagon(bx, by, 5, a), '#17272a');
      ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * 6, y + Math.sin(a) * 6); ctx.lineTo(bx, by); ctx.lineWidth = 1; ctx.strokeStyle = '#17272a'; ctx.stroke();
    }
    ctx.restore();
    ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.strokeStyle = '#142327'; ctx.lineWidth = 3; ctx.stroke();
  }

  function drawPitch(canvas, state, playerSeat, aiming = false) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, 640, 960);
    ctx.fillStyle = '#51ae3c'; ctx.fillRect(0, 0, 640, 960);
    ctx.fillStyle = '#4ba438';
    for (let y = 80; y < 960; y += 160) ctx.fillRect(0, y, 640, 80);
    ctx.strokeStyle = '#ffffffbd'; ctx.lineWidth = 6; ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    ctx.strokeRect(22, 22, 596, 916);
    ctx.beginPath(); ctx.moveTo(22, 480); ctx.lineTo(618, 480); ctx.stroke();
    ctx.beginPath(); ctx.arc(320, 480, 99, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(320, 480, 6, 0, Math.PI * 2); ctx.fillStyle = '#ffffffc9'; ctx.fill();
    ctx.strokeRect(151, 22, 338, 154); ctx.strokeRect(151, 784, 338, 154);
    ctx.strokeRect(224, 22, 192, 64); ctx.strokeRect(224, 874, 192, 64);
    for (const y of [127, 833]) { ctx.beginPath(); ctx.arc(320, y, 4, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = '#ffffff70'; ctx.lineWidth = 2;
    for (let x = 232; x < 420; x += 23) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 20); ctx.moveTo(x, 940); ctx.lineTo(x, 960); ctx.stroke();
    }
    for (const y of [7, 15, 945, 953]) { ctx.beginPath(); ctx.moveTo(220, y); ctx.lineTo(420, y); ctx.stroke(); }
    ctx.strokeStyle = '#12252a'; ctx.lineWidth = 14;
    ctx.beginPath(); ctx.moveTo(216, 0); ctx.lineTo(216, 23); ctx.lineTo(424, 23); ctx.lineTo(424, 0); ctx.moveTo(216, 960); ctx.lineTo(216, 937); ctx.lineTo(424, 937); ctx.lineTo(424, 960); ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(216, 0); ctx.lineTo(216, 23); ctx.lineTo(424, 23); ctx.lineTo(424, 0); ctx.moveTo(216, 960); ctx.lineTo(216, 937); ctx.lineTo(424, 937); ctx.lineTo(424, 960); ctx.stroke();
    const own = project(state.players[playerSeat * 8 + S.piece], playerSeat);
    if (aiming && (S.dragging || $('keyboard-controls').open)) {
      const radians = S.angle * Math.PI / 180;
      const length = 35 + S.power * 1.5;
      const target = {x:own.x + Math.cos(radians)*length,y:own.y + Math.sin(radians)*length};
      if (S.dragging?.pull) {
        const pull = S.dragging.pull;
        const sideX = Math.cos(radians + Math.PI/2)*17;
        const sideY = Math.sin(radians + Math.PI/2)*17;
        ctx.beginPath(); ctx.moveTo(own.x+sideX,own.y+sideY); ctx.lineTo(pull.x,pull.y); ctx.lineTo(own.x-sideX,own.y-sideY);
        ctx.strokeStyle = '#18352870'; ctx.lineWidth=9; ctx.lineJoin='round'; ctx.stroke();
        ctx.strokeStyle = '#ffffffc9'; ctx.lineWidth=4; ctx.stroke();
        ctx.globalAlpha=.45; disc(ctx,pull,28,COLORS[playerSeat]); ctx.globalAlpha=1;
      }
      ctx.beginPath(); ctx.moveTo(own.x,own.y); ctx.lineTo(target.x,target.y);
      ctx.strokeStyle='#16352955'; ctx.lineWidth=10; ctx.lineCap='round'; ctx.stroke();
      ctx.strokeStyle='#fff'; ctx.lineWidth=4; ctx.stroke();
      polygon(ctx,[[target.x+Math.cos(radians)*10,target.y+Math.sin(radians)*10],[target.x+Math.cos(radians+2.35)*14,target.y+Math.sin(radians+2.35)*14],[target.x+Math.cos(radians-2.35)*14,target.y+Math.sin(radians-2.35)*14]],'#fff');
    }
    if (S.animation && canvas.id === 'pitch' && !reducedMotion.matches) {
      for (let back = 4; back >= 1; back--) {
        const frame = S.animation.frames[S.animation.index - back];
        if (!validState(frame)) continue;
        ctx.globalAlpha = (5 - back) * .045;
        frame.players.forEach((p, i) => { const point = project(p, playerSeat); ctx.beginPath(); ctx.arc(point.x, point.y, 27, 0, Math.PI * 2); ctx.fillStyle = COLORS[Math.floor(i/8)]; ctx.fill(); });
        const ball = project(frame.ball, playerSeat); ctx.beginPath(); ctx.arc(ball.x, ball.y, 13, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    state.players.forEach((p, i) => disc(ctx, project(p, playerSeat), 28, COLORS[Math.floor(i/8)]));
    if (aiming) {
      ctx.strokeStyle='#ffffffa8'; ctx.lineWidth=2;
      for(let i=0;i<8;i++) {
        const point=project(state.players[playerSeat*8+i],playerSeat);
        ctx.beginPath(); ctx.arc(point.x,point.y,34,0,Math.PI*2); ctx.stroke();
      }
    }
    football(ctx, project(state.ball, playerSeat));

  }

  function pointerPosition(event) {
    const rect = $('pitch').getBoundingClientRect();
    return {x:(event.clientX-rect.left)*640/rect.width,y:(event.clientY-rect.top)*960/rect.height};
  }

  function aimFromPointer(event) {
    if (!canShoot() || !S.dragging || S.dragging.id !== event.pointerId) return;
    const pointer = pointerPosition(event);
    const center = S.dragging.center;
    const dx = center.x-pointer.x, dy = center.y-pointer.y;
    const distance = Math.hypot(dx,dy);
    S.dragging.distance=distance;
    if(distance>0) S.angle=Math.round((Math.atan2(dy,dx)*180/Math.PI+360)%360)%360;
    S.power=Math.round(Math.min(1,distance/MAX_PULL)*100);
    const ratio=distance>MAX_PULL?MAX_PULL/distance:1;
    S.dragging.pull={x:center.x-dx*ratio,y:center.y-dy*ratio};
    updateAimControls();
  }

  function shoot() {
    if (!canShoot()) return;
    void mutate('input',{matchId:S.match.id,round:S.match.round,version:2,piece:S.piece,angle:(S.angle+(seat()===1?180:0))%360,power:S.power});
  }

  async function enterLobby() {
    stopAnimation();
    S.match = null;
    S.cancelOpen = false;
    saveActive(null);
    render();
    await refreshRooms();
    schedulePoll();
  }

  async function login(event) {
    event.preventDefault();
    if (S.busy) return;
    const attendanceNo = Number($('attendance').value);
    const pin = $('pin').value;
    if (!/^\d{4}$/.test(pin) || !([99, ...Array.from({ length: 40 }, (_, i) => i + 1)].includes(attendanceNo))) return;
    S.busy = 'login';
    $('login-submit').disabled = true;
    text('login-submit', '…');
    show('login-error', false);
    const epoch = S.epoch;
    try {
      const data = await request('login', { method: 'POST', body: { attendanceNo, pin }, epoch });
      if (epoch !== S.epoch) return;
      setSession(data.user, data.wallet);
      S.booting = false;
      render();
      await restoreRoom();
      schedulePoll();
    } catch (error) {
      if (epoch !== S.epoch || error.name === 'AbortError') return;
      text('login-error', error instanceof ApiError ? error.message : '接続できませんでした。もう一度お試しください。');
      show('login-error', true);
      $('pin').value = '';
      $('pin').focus();
    } finally {
      if (!S.user || S.busy === 'login') S.busy = '';
      $('login-submit').disabled = false;
      text('login-submit', 'ログイン');
      render();
    }
  }

  async function restoreRoom() {
    const epoch = S.epoch;
    const active = readStorage(accountKey('active'));
    if (typeof active === 'string' && active.length <= 16) await refreshMatch({ code: active, initial: true });
    if (epoch !== S.epoch) return;
    await refreshRooms();
    if (epoch !== S.epoch) return;
    if (!S.match && S.rooms.length) {
      const room = S.rooms.find(m => !isEnded(m) && m.code);
      if (room) await refreshMatch({ code: room.code, initial: true });
    }
    if (epoch !== S.epoch) return;
    const invite = new URL(location.href).searchParams.get('room');
    if (invite && !S.match) {
      $('join-code').value = invite.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    }
    render();
  }

  $('login-form').addEventListener('submit', login);
  $('pin').addEventListener('input', () => { $('pin').value = $('pin').value.replace(/[^0-9]/g, '').slice(0, 4); });
  for (const number of [...Array.from({ length: 40 }, (_, i) => i + 1), 99]) {
    const option = document.createElement('option'); option.value = number; option.textContent = `${number} 番`; $('attendance').append(option);
  }
  $('logout-button').addEventListener('click', async () => {
    if (S.busy) return;
    S.booting = true;
    setSession(null, null);
    render();
    try { await request('logout', { method: 'POST', body: {} }); }
    catch { notify('ログアウトの確認ができませんでした。接続を確認してください。', true, true); }
    S.booting = false;
    render();
  });
  $('notice-close').addEventListener('click', () => show('notice', false));
  $('create-form').addEventListener('submit', event => { event.preventDefault(); if ($('create-form').reportValidity()) void mutate('rooms', { stake: Number($('create-stake').value) }); });
  $('join-form').addEventListener('submit', event => { event.preventDefault(); if ($('join-form').reportValidity()) void mutate('rooms/join', { code: $('join-code').value.toUpperCase().trim() }); });
  $('join-code').addEventListener('input', () => { $('join-code').value = $('join-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); });
  $('offer-form').addEventListener('submit', event => { event.preventDefault(); if ($('offer-form').reportValidity() && S.match?.status === 'waiting') void mutate('offer', { matchId: S.match.id, stake: Number($('stake').value) }); });
  $('ready-button').addEventListener('click', () => { if (S.match && !$('ready-button').disabled) void mutate('ready', { matchId: S.match.id, ready: true }); });
  $('leave-room').addEventListener('click', () => { if (S.match?.status === 'waiting') void mutate('cancel', { matchId: S.match.id }); });
  $('refresh-rooms').addEventListener('click', () => { void refreshRooms(); });
  $('retry-action').addEventListener('click', () => { if (S.pending) void mutate(S.pending.path, S.pending.body, { retry: true }); });
  $('copy-invite').addEventListener('click', async () => {
    if (!S.match) return;
    const code = S.match.code;
    const url = new URL('/', location.origin); url.searchParams.set('room', code);
    try { await navigator.clipboard.writeText(url.href); notify('コピーしました'); }
    catch { notify(`招待コード: ${code}`, false, true); }
  });
  $('aim-angle').addEventListener('input', () => { if (!canShoot()) return; S.angle = Number($('aim-angle').value); updateAimControls(); });
  $('aim-power').addEventListener('input', () => { if (!canShoot()) return; S.power = Number($('aim-power').value); updateAimControls(); });
  $('aim-piece').addEventListener('change',()=>{if(!canShoot())return;S.piece=Number($('aim-piece').value);drawCurrent();});
  $('keyboard-controls').addEventListener('toggle',drawCurrent);
  for(let formation=0;formation<3;formation++) {
    $('formation-'+formation).addEventListener('click',()=>{
      if(S.match?.status==='waiting' && Number(ownPlayer()?.formation||0)!==formation) void mutate('formation',{matchId:S.match.id,formation});
    });
  }
  $('lock-input').addEventListener('click',shoot);
  $('pitch').addEventListener('pointerdown',event=>{
    if(!canShoot() || S.dragging || (event.button!==0 && event.pointerType==='mouse'))return;
    const pointer=pointerPosition(event);
    const players=currentState().players;
    let piece=-1,nearest=Infinity,center;
    for(let i=0;i<8;i++) {
      const point=project(players[seat()*8+i]);
      const distance=Math.hypot(pointer.x-point.x,pointer.y-point.y);
      if(distance<=28 && distance<nearest){piece=i;nearest=distance;center=point;}
    }
    if(piece<0)return;
    S.piece=piece;
    S.dragging={id:event.pointerId,x:event.clientX,y:event.clientY,center,pull:center,distance:0,moved:false};
    S.power=0;
    $('pitch').setPointerCapture(event.pointerId);
    updateAimControls();
  });
  $('pitch').addEventListener('pointermove',event=>{
    if(S.dragging?.id!==event.pointerId)return;
    if(Math.hypot(event.clientX-S.dragging.x,event.clientY-S.dragging.y)>=8)S.dragging.moved=true;
    aimFromPointer(event);
  });
  const stopDrag=event=>{if(S.dragging?.id===event.pointerId){S.dragging=null;drawCurrent();}};
  $('pitch').addEventListener('pointerup',event=>{
    if(S.dragging?.id!==event.pointerId)return;
    aimFromPointer(event);
    const moved=S.dragging.moved || Math.hypot(event.clientX-S.dragging.x,event.clientY-S.dragging.y)>=8;
    const enoughPull=S.dragging.distance>=8;
    S.dragging=null;
    drawCurrent();
    if(moved && enoughPull)shoot();
  });
  $('pitch').addEventListener('pointercancel',stopDrag);
  $('pitch').addEventListener('lostpointercapture',stopDrag);
  $('pitch').addEventListener('keydown', event => {
    if (!canShoot()) return;
    const step = event.shiftKey ? 15 : 5;
    if (event.key === 'ArrowLeft') S.angle = (S.angle - step + 360) % 360;
    else if (event.key === 'ArrowRight') S.angle = (S.angle + step) % 360;
    else if (event.key === 'ArrowUp') S.power = Math.min(100, S.power + 5);
    else if (event.key === 'ArrowDown') S.power = Math.max(0, S.power - 5);
    else return;
    event.preventDefault(); updateAimControls();
  });
  $('cancel-button').addEventListener('click', () => { S.cancelOpen = !S.cancelOpen; render(); });
  $('dismiss-cancel').addEventListener('click', () => { S.cancelOpen = false; render(); });
  $('confirm-cancel').addEventListener('click', () => { if (S.match && !isEnded(S.match)) void mutate('cancel', { matchId: S.match.id }); });
  $('back-lobby').addEventListener('click', () => { void enterLobby(); });
  $('rematch-button').addEventListener('click', () => {
    if (!S.match || S.busy || S.pending || !isEnded(S.match)) return;
    const stake = Number(S.match.stake) || 100;
    void mutate('rooms', { stake });
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.user) schedulePoll(50); });
  window.addEventListener('online', () => { if (S.user) schedulePoll(50); });
  const motionChanged = () => { if (reducedMotion.matches && S.animation) { stopAnimation(); render(); } };
  if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', motionChanged);
  else reducedMotion.addListener(motionChanged);
  window.addEventListener('storage', event => {
    if (!S.user) return;
    if (event.key === accountKey('pending') && !S.busy) {
      const pending = readStorage(accountKey('pending'));
      S.pending = pending?.body?.requestId ? pending : null;
      render();
    }
    if (event.key === accountKey('active')) schedulePoll(50);
  });

  updateAimControls();
  render();
  (async () => {
    try {
      const data = await request('session');
      setSession(data.user, data.wallet);
      S.booting = false;
      render();
      if (S.user) { await restoreRoom(); schedulePoll(); }
    } catch (error) {
      if (error.name !== 'AbortError') {
        S.booting = false;
        notify('接続できませんでした。接続を確認してからログインしてください。', true, true);
        render();
      }
    }
  })();
})();
