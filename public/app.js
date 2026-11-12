(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const INITIAL_TEAM = [[320,846],[140,790],[320,790],[500,790],[140,670],[320,670],[500,670],[320,560]];
  const INITIAL = { players: [...INITIAL_TEAM.map(([x,y]) => ({x,y})), ...INITIAL_TEAM.map(([x,y]) => ({x:640-x,y:960-y}))], ball: {x:320,y:480} };
  const MAX_PULL = 180;
  const MAX_WALLET_AMOUNT = 10000000000000;
  const validStake = value => Number.isSafeInteger(value) && value >= 100 && value <= MAX_WALLET_AMOUNT && value % 100 === 0;
  const COLORS = ['#f04d50', '#08b2d4'];
  const VIEWS = ['boot', 'login', 'lobby', 'room', 'game', 'spectate'];
  const STAMPS = Object.freeze(['おつw', 'うっまw', 'お願いします', 'あざした〜w', 'もう一戦しよ']);
  const fmt = value => new Intl.NumberFormat('ja-JP').format(Number(value) || 0);
  const S = {
    user: null, wallet: null, match: null, booting: true,
    lobby: { online: [], queue: null, incoming: [], outgoing: [] }, ranking: [], rankingLoaded: false, rankingAt: 0, rankingTask: null, rankingError: false,
    lobbyGeneration: 0, lobbyRequest: 0, lobbyApplied: 0, lobbyTask: null, heartbeat: null, heartbeatTask: null,
    busy: '', epoch: 0, abort: new AbortController(), poll: null, matchTask: null, matchSnapshot: 0,
    turnClock: null, turnTimer: null, clockStale: true, clockGeneration: 0, expiryRefreshKey: '',
    pending: null, angle: 270, power: 65, piece: 0, animation: null, animationQueue: [], raf: 0,
    cancelOpen: false, offerVersion: '', noticeTimer: null, noticeKind: '',
    dragging: null, displayedRound: null, connectionLost: false,
    social: {viewers:[],stamp:null}, socialTask:null, stampTimer:null, seenStampKey:'', lastStampSent:0,
    liveGames:[], liveGamesAt:0, liveGamesTask:null,
    watch:null, watchTask:null,
  };
  const clockReceipts = new WeakMap();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const text = (id, value) => { const node = $(id); if (node) node.textContent = value == null ? '' : String(value); };
  const show = (id, visible) => { const node = $(id); if (node) node.hidden = !visible; };
  const accountKey = prefix => `2player.${prefix}:${S.user?.id ?? ''}`;
  const sameId = (a, b) => a != null && b != null && String(a) === String(b);
  const myRole = (m = S.match) => sameId(m?.host?.memberId, S.user?.id) ? 'host' : sameId(m?.guest?.memberId, S.user?.id) ? 'guest' : null;
  const ownPlayer = () => S.match?.[myRole()];
  const offeredStake = (match, role) => validStake(match?.[role]?.offer) ? match[role].offer : 0;
  const fundedStake = (match, role) => validStake(match?.[role]?.stake) ? match[role].stake : validStake(match?.stake) ? match.stake : 0;
  const matchPot = match => match?.status === 'waiting'
    ? offeredStake(match, 'host') + offeredStake(match, 'guest')
    : fundedStake(match, 'host') + fundedStake(match, 'guest');
  const seat = () => myRole() === 'guest' ? 1 : 0;
  const isEnded = m => m?.status === 'finished' || m?.status === 'cancelled';
  const canShoot = () => !!S.user && !!S.match && S.match.status === 'playing' && S.match.turn === myRole() && !ownPlayer()?.inputLocked && !S.animation && !S.busy && !S.pending && turnWindowOpen();
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
    const clockGeneration = S.clockGeneration;
    const sessionSignal = S.abort.signal;
    const controller = new AbortController();
    const abort = () => controller.abort();
    let timedOut = false;
    sessionSignal.addEventListener('abort', abort, { once: true });
    if (sessionSignal.aborted) controller.abort();
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 28000);
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
      if (data?.match && typeof data.match === 'object') clockReceipts.set(data.match, clockGeneration);
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

  function notify(message, error = false, sticky = false, kind = '') {
    clearTimeout(S.noticeTimer);
    S.noticeKind = kind;
    text('notice-text', message);
    $('notice').classList.toggle('error', error);
    show('notice', true);
    if (!sticky) S.noticeTimer = setTimeout(() => show('notice', false), 8000);
  }

  function markConnected() {
    S.connectionLost = false;
    if (S.noticeKind !== 'connection') return;
    clearTimeout(S.noticeTimer);
    S.noticeKind = '';
    show('notice', false);
  }

  function setSession(user, wallet) {
    S.epoch += 1;
    S.abort.abort();
    S.abort = new AbortController();
    clearTimeout(S.poll);
    clearTimeout(S.heartbeat);
    clearTimeout(S.turnTimer);
    clearTimeout(S.stampTimer);
    show('pitch-stamp',false);show('spectate-stamp',false);
    stopAnimation();
    S.user = user;
    S.wallet = wallet;
    S.match = null;
    S.watch = null; S.watchTask=null; S.liveGames=[]; S.liveGamesAt=0; S.liveGamesTask=null;
    S.social={viewers:[],stamp:null}; S.socialTask=null;S.seenStampKey='';S.lastStampSent=0;
    S.matchTask = null;
    S.matchSnapshot = 0;
    S.turnClock = null;
    S.turnTimer = null;
    S.clockStale = true;
    S.clockGeneration += 1;
    S.expiryRefreshKey = '';
    S.lobby = { online: [], queue: null, incoming: [], outgoing: [] };
    S.lobbyGeneration += 1;
    S.lobbyRequest = 0;
    S.lobbyApplied = 0;
    S.lobbyTask = null;
    S.heartbeatTask = null;
    S.busy = '';
    S.cancelOpen = false;
    S.dragging = null;
    S.offerVersion = '';
    S.displayedRound = null;
    const saved = user ? readStorage(accountKey('pending')) : null;
    S.pending = saved && typeof saved.path === 'string' && saved.body?.requestId ? saved : null;
    S.ranking = []; S.rankingLoaded = false; S.rankingAt = 0; S.rankingTask = null; S.rankingError = false;
    $('pin').value = '';
    $('login-error').hidden = true;
    markConnected();
  }

  function saveActive(matchId) {
    if (S.user) writeStorage(accountKey('active'), matchId || null);
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
    if (data.lobby && typeof data.lobby === 'object') {
      S.lobby = {
        online: Array.isArray(data.lobby.online) ? data.lobby.online : [],
        queue: data.lobby.queue || null,
        incoming: Array.isArray(data.lobby.incoming) ? data.lobby.incoming : [],
        outgoing: Array.isArray(data.lobby.outgoing) ? data.lobby.outgoing : [],
      };
    }
    if (data.match && !S.watch) applyMatch(data.match, initial);
    render();
  }

  function timestampMicros(value) {
    const base=Date.parse(value||''); if(!Number.isFinite(base))return null;
    const fraction=String(value).match(/\.(\d+)/)?.[1]||'';
    return BigInt(base)*1000n+BigInt((fraction+'000000').slice(3,6));
  }

  function clockNow() {
    return S.turnClock ? S.turnClock.serverAt + Math.max(0, performance.now() - S.turnClock.receivedAt) : null;
  }

  function turnWindowOpen() {
    const now = clockNow();
    return !document.hidden && !S.clockStale && now !== null && now >= S.turnClock.startsAt && now < S.turnClock.deadline;
  }

  function applyTurnClock(match) {
    const startsAt = Date.parse(match.turnStartedAt || '');
    const deadline = Date.parse(match.turnExpiresAt || '');
    const serverAt = Date.parse(match.serverNow || '');
    if (match.status !== 'playing' || ![startsAt, deadline, serverAt].every(Number.isFinite) || deadline <= startsAt) {
      S.turnClock = null;
      S.clockStale = true;
      return;
    }
    const key = `${match.id}:${match.round}:${match.turn}:${startsAt}:${deadline}`;
    // A delayed snapshot of the same turn must never rewind its clock.
    const previousNow = S.turnClock?.key === key ? clockNow() : null;
    S.turnClock = { key, startsAt, deadline, serverAt: Math.max(serverAt, previousNow ?? serverAt), receivedAt: performance.now() };
    S.clockStale = false;
    if (S.expiryRefreshKey !== key) S.expiryRefreshKey = '';
  }

  function scheduleTurnClock() {
    clearTimeout(S.turnTimer);
    S.turnTimer = null;
    if (document.hidden || !S.user || S.match?.status !== 'playing' || !S.turnClock) return;
    const epoch = S.epoch;
    const now = clockNow();
    const until = Math.max(0, (now < S.turnClock.startsAt ? S.turnClock.startsAt : S.turnClock.deadline) - now);
    const delay = Math.min(1000, Math.max(50, until > 0 ? until % 1000 || 1000 : 1000));
    S.turnTimer = setTimeout(() => {
      S.turnTimer = null;
      if (epoch !== S.epoch || document.hidden || S.match?.status !== 'playing' || !S.turnClock) return;
      const expired = clockNow() >= S.turnClock.deadline;
      const processing = !!S.match.host?.inputLocked || !!S.match.guest?.inputLocked;
      if (expired) {
        S.dragging = null;
        if (!S.busy && !processing && S.expiryRefreshKey !== S.turnClock.key) {
          S.expiryRefreshKey = S.turnClock.key;
          void refreshMatch();
        }
      }
      render();
    }, delay);
  }

  function applyMatch(match, initial = false) {
    if (clockReceipts.has(match) && clockReceipts.get(match) !== S.clockGeneration) return;
    const previous = S.match;
    const changed = previous?.id !== match.id;
    if (!changed && previous) {
      const previousUpdated = timestampMicros(previous.updatedAt);
      const nextUpdated = timestampMicros(match.updatedAt);
      if ((previousUpdated !== null && nextUpdated !== null && nextUpdated < previousUpdated) ||
          Number(match.round) < Number(previous.round) || (isEnded(previous) && !isEnded(match))) return;
    }
    S.match = match;
    if (S.pending?.path === 'ready' && S.pending.body?.matchId === match.id &&
        (match.status !== 'waiting' || S.pending.body.expectedHostOffer !== match.host?.offer ||
          S.pending.body.expectedGuestOffer !== match.guest?.offer)) clearPending();
    if (previous && (changed || previous.round !== match.round || previous.turn !== match.turn)) S.dragging = null;
    S.matchSnapshot += 1;
    applyTurnClock(match);
    saveActive(match.id);
    if (changed) {
      S.social={viewers:[],stamp:null}; S.seenStampKey=''; S.socialTask=null;
      S.lobbyGeneration += 1;
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
    const operation = retry ? S.pending : { path, body: { ...body, requestId: newId() }, matchId: S.match?.id || '', createdAt: Date.now() };
    if (!operation) return;
    S.pending = operation;
    writeStorage(accountKey('pending'), operation);
    const generation = ++S.lobbyGeneration;
    S.busy = label;
    render();
    try {
      const data = await request(operation.path, { method: 'POST', body: operation.body, epoch });
      if (epoch !== S.epoch) return;
      clearPending();
      S.busy = '';
      if (generation !== S.lobbyGeneration ||
          (S.match && !isEnded(S.match) && data.match && S.match.id !== data.match.id)) {
        if ('wallet' in data) applyData({ wallet: data.wallet });
        schedulePoll(50);
        return;
      }
      applyData(data);
      markConnected();
      if (operation.path === 'cancel' && data.match?.status === 'cancelled' && data.match.stake == null) {
        S.match = null;
        saveActive(null);
        render();
      }
      schedulePoll(400);
    } catch (error) {
      if (epoch !== S.epoch || error.name === 'AbortError') return;
      S.busy = '';
      if (generation !== S.lobbyGeneration) {
        if (error.status >= 400 && error.status < 500) clearPending();
        schedulePoll(50);
        return;
      }
      if (error.status === 401) {
        setSession(null, null);
        notify('もう一度ログインしてください。', true, true);
      } else if (error.status >= 400 && error.status < 500) {
        clearPending();
        const handoff = operation.path === 'input' && error.status === 409 && ['STALE_INPUT', 'NOT_YOUR_TURN', 'TURN_PENDING'].includes(error.code);
        if (!handoff) notify(error.message, true, true);
        if (S.match) void refreshMatch(); else void refreshLobby();
      } else {
        notify('接続を確認してください。', true, true);
      }
      render();
    } finally {
      if (epoch === S.epoch) { S.busy = ''; render(); }
    }
  }

  async function refreshLobby({ heartbeat = false } = {}) {
    const epoch = S.epoch;
    const generation = S.lobbyGeneration;
    if (!S.user || document.hidden || S.watch) return;
    const active = S.lobbyTask;
    if (active && active.epoch === epoch && active.generation === generation) {
      await active.promise;
      if (!heartbeat || active.heartbeat || epoch !== S.epoch || generation !== S.lobbyGeneration) return;
      // A read does not update presence. Send a due heartbeat after it finishes,
      // while ordinary reads and repeated heartbeats share the same snapshot.
      return refreshLobby({ heartbeat: true });
    }
    const sequence = ++S.lobbyRequest;
    const task = { epoch, generation, heartbeat, promise: null };
    S.lobbyTask = task;
    task.promise = (async () => {
      try {
        const data = await request(heartbeat ? 'lobby/heartbeat' : 'lobby', { epoch, ...(heartbeat ? { method: 'POST', body: {} } : {}) });
        if (epoch !== S.epoch || generation !== S.lobbyGeneration || sequence < S.lobbyApplied) return;
        S.lobbyApplied = sequence;
        applyData(data);
        markConnected();
        if (!S.match && !S.watch){void refreshRanking();void refreshLiveGames();}
      } catch (error) {
        if (generation !== S.lobbyGeneration || sequence < S.lobbyApplied) return;
        handlePollError(error, epoch);
      } finally {
        if (S.lobbyTask === task) S.lobbyTask = null;
      }
    })();
    return task.promise;
  }

  async function refreshRanking(force = false) {
    if (!S.user || document.hidden || (!force && S.rankingAt && Date.now() - S.rankingAt < 20000)) return;
    if (S.rankingTask) return S.rankingTask;
    const epoch = S.epoch;
    const task = (async () => {
      try {
        const data = await request('ranking', { epoch });
        if (epoch !== S.epoch) return;
        S.ranking = Array.isArray(data.ranking) ? data.ranking : [];
        S.rankingLoaded = true; S.rankingError = false; S.rankingAt = Date.now();
      } catch (error) {
        if (epoch !== S.epoch || error.name === 'AbortError') return;
        S.rankingError = true; S.rankingAt = Date.now();
      } finally {
        if (epoch === S.epoch) {
          S.rankingTask = null;
          if (!S.match) render();
        }
      }
    })();
    S.rankingTask = task;
    return task;
  }

  // Stamps are fixed code points, never arbitrary HTML or user-provided text.
  function showStamp(stamp, matchId) {
    if(!stamp || !Number.isSafeInteger(stamp.stampId) || stamp.stampId<1 || stamp.stampId>STAMPS.length)return;
    const key=matchId+':'+stamp.id;
    if(S.seenStampKey===key)return;
    S.seenStampKey=key;
    const prefix=S.watch?'spectate':'pitch';
    clearTimeout(S.stampTimer);
    text(prefix+'-stamp-from',stamp.fromName);
    text(prefix+'-stamp-text',STAMPS[stamp.stampId-1]);
    show('pitch-stamp',false);show('spectate-stamp',false);
    show(prefix+'-stamp',true);
    const epoch=S.epoch;
    S.stampTimer=setTimeout(()=>{if(epoch===S.epoch)show(prefix+'-stamp',false);},2200);
  }
  function processSocial(value,matchId) {
    if(!value || !Array.isArray(value.viewers))return;
    if(!S.watch)S.social={viewers:value.viewers,stamp:value.stamp||null};
    if(value.stamp)showStamp(value.stamp,matchId);
    if(S.watch)renderSpectate();else if(S.match?.id===matchId)render();
  }
  async function refreshSocial() {
    const matchId=S.match?.id,epoch=S.epoch;
    if(!S.user||!matchId||S.watch||S.match.status!=='playing'||document.hidden||S.socialTask)return;
    const task=(async()=>{
      try{
        const data=await request('social/feed?matchId='+encodeURIComponent(matchId),{epoch});
        if(epoch===S.epoch&&!S.watch&&S.match?.id===matchId)processSocial(data.social,matchId);
      }catch(error){if(epoch===S.epoch&&error.status===401)handlePollError(error,epoch);}
      finally{if(S.socialTask===task)S.socialTask=null;}
    })();
    S.socialTask=task;
    return task;
  }
  async function sendStamp(stampId) {
    if(!S.user||S.watch||S.match?.status!=='playing'||
      !Number.isInteger(stampId)||stampId<1||stampId>STAMPS.length||
      S.lastStampSent&&Date.now()-S.lastStampSent<5000)return;
    const epoch=S.epoch,matchId=S.match.id;
    S.lastStampSent=Date.now();
    for(const button of document.querySelectorAll('[data-soccer-stamp]'))button.disabled=true;
    $('stamp-picker').open=false;
    try{
      const data=await request('social/stamp',{method:'POST',body:{matchId,stampId},epoch});
      if(epoch!==S.epoch||S.watch||S.match?.id!==matchId)return;
      processSocial({viewers:S.social.viewers,stamp:data.stamp},matchId);
    }catch(error){
      if(epoch!==S.epoch)return;
      if(error.status===401)handlePollError(error,epoch);
      else notify(error.message||'スタンプを送れませんでした。',true);
    }finally{
      if(epoch===S.epoch)for(const button of document.querySelectorAll('[data-soccer-stamp]'))button.disabled=false;
    }
  }
  async function refreshLiveGames(force=false) {
    if(!S.user||S.watch||S.match||document.hidden||
      (!force&&S.liveGamesAt&&Date.now()-S.liveGamesAt<8000)||S.liveGamesTask)return;
    const epoch=S.epoch;
    const task=(async()=>{
      try{
        const data=await request('watch/games',{epoch});
        if(epoch!==S.epoch||S.watch||S.match)return;
        S.liveGames=Array.isArray(data.games)?data.games:[];
        S.liveGamesAt=Date.now();
        render();
      }catch(error){
        if(epoch===S.epoch&&!S.match&&!S.watch){S.liveGamesAt=Date.now();if(error.status===401)handlePollError(error,epoch);}
      }finally{if(S.liveGamesTask===task)S.liveGamesTask=null;}
    })();
    S.liveGamesTask=task;
    return task;
  }
  async function beginSpectate(matchId) {
    if(!S.user||S.match||S.watch||S.busy||!S.liveGames.some(game=>game.id===matchId))return;
    S.lobbyGeneration+=1;
    S.watch={id:matchId,match:null,afterRound:0,receivedAt:0};
    S.seenStampKey='';
    stopAnimation();
    clearTimeout(S.poll);
    render();
    await refreshSpectate();
    schedulePoll(600);
  }
  async function refreshSpectate() {
    const epoch=S.epoch,watch=S.watch;
    if(!S.user||!watch||document.hidden||S.watchTask)return;
    const task=(async()=>{
      try{
        const data=await request('watch?matchId='+encodeURIComponent(watch.id)+'&afterRound='+watch.afterRound,{epoch});
        if(epoch!==S.epoch||S.watch!==watch)return;
        const first=!watch.match;
        watch.match=data.match;
        watch.receivedAt=performance.now();
        const last=data.match?.lastRound;
        if(last?.round>watch.afterRound){
          watch.afterRound=last.round;
          if(!first&&Array.isArray(last.frames)&&last.frames.length>1)playFrames(last.frames,last.goal);
        }
        processSocial(data.social,watch.id);
        markConnected();
        render();
      }catch(error){
        if(epoch!==S.epoch||S.watch!==watch)return;
        if(error.status===404||error.status===403){
          notify(error.message||'観戦が終了しました。',false);
          void enterLobby();
        }else handlePollError(error,epoch);
      }finally{if(S.watchTask===task)S.watchTask=null;}
    })();
    S.watchTask=task;
    return task;
  }

  async function refreshMatch({ initial = false, matchId = S.match?.id } = {}) {
    const epoch = S.epoch;
    const generation = S.lobbyGeneration;
    if (!S.user || !matchId) return;
    const active = S.matchTask;
    if (active && active.epoch === epoch && active.generation === generation && active.matchId === matchId && active.clockGeneration === S.clockGeneration) {
      active.initial ||= initial;
      return active.promise;
    }
    const observed = S.matchSnapshot;
    const task = { epoch, generation, matchId, initial, clockGeneration: S.clockGeneration, promise: null };
    S.matchTask = task;
    task.promise = (async () => {
      try {
        const data = await request(`match?matchId=${encodeURIComponent(matchId)}`, { epoch });
        if (epoch !== S.epoch || generation !== S.lobbyGeneration || (S.match && S.match.id !== matchId)) return;
        applyData(data, { initial: task.initial });
        markConnected();
        if(S.match?.status==='playing'&&!S.watch)void refreshSocial();
      } catch (error) {
        if (epoch !== S.epoch || generation !== S.lobbyGeneration || observed !== S.matchSnapshot) return;
        if (error.status === 404 || error.status === 403) {
          S.match = null;
          saveActive(null);
          notify(error.message, true, true);
          render();
        } else handlePollError(error, epoch);
      } finally {
        if (S.matchTask === task) S.matchTask = null;
      }
    })();
    return task.promise;
  }

  function handlePollError(error, epoch) {
    if (epoch !== S.epoch || error.name === 'AbortError') return;
    if (error.status === 401) {
      setSession(null, null);
      notify('もう一度ログインしてください。', true, true);
      render();
    } else if (!S.connectionLost) {
      S.connectionLost = true;
      notify('再接続中…', true, true, 'connection');
    }
  }

  function schedulePoll(delay = 1800) {
    clearTimeout(S.poll);
    if (!S.user || document.hidden) return;
    S.poll = setTimeout(async () => {
      const epoch = S.epoch;
      if(!S.busy){
        if(S.watch)await refreshSpectate();
        else if(S.match && !isEnded(S.match))await refreshMatch();
        else if(!S.match)await refreshLobby();
      }
      if(epoch===S.epoch)schedulePoll(S.watch?2000:S.match?1800:2500);
    }, delay);
  }

  function scheduleHeartbeat(delay = 20000) {
    clearTimeout(S.heartbeat);
    if (!S.user || document.hidden) return;
    const epoch = S.epoch;
    S.heartbeat = setTimeout(async () => {
      if (!S.watch&&!S.heartbeatTask) {
        const task = refreshLobby({ heartbeat: true });
        S.heartbeatTask = task;
        await task;
        if (epoch !== S.epoch) return;
        if (S.heartbeatTask === task) S.heartbeatTask = null;
      }
      if (epoch === S.epoch) scheduleHeartbeat();
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
    const active = S.booting ? 'boot' : !S.user ? 'login' : S.watch ? 'spectate' : !match ? 'lobby' : match.status === 'waiting' ? 'room' : 'game';
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
    if (active === 'lobby') renderLobby(blocked);
    if (active === 'room') renderRoom(blocked);
    if (active === 'game') renderGame(blocked);
    if (active === 'spectate') renderSpectate();
    drawCurrent();
    scheduleTurnClock();
  }

  // Queueing and direct invitations carry only a refundable, uncommitted
  // 100-轟 placeholder for backward-compatible DB matchmaking. The actual
  // wager is chosen in the room after an opponent is found and no funds are
  // reserved until both people confirm the displayed offers.
  function preferences() { return { stake: 100 }; }

  function invitationButton(label, attribute, invitationId, path, body, disabled) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'button small secondary';
    button.textContent = label; button.setAttribute(attribute, invitationId); button.disabled = disabled;
    button.addEventListener('click', () => {
      const selected = path === 'challenge/accept' ? preferences() : {};
      if (!selected) return;
      void mutate(path, { ...body, ...selected });
    });
    return button;
  }

  function renderLobby(blocked) {
    const queued = !!S.lobby.queue;
    $('random-button').disabled = blocked || queued || S.lobby.outgoing.length > 0;
    show('random-button', !queued);
    show('queue-wait', queued);
    text('queue-status', Number.isInteger(S.lobby.queue?.position) ? `待機中 · ${S.lobby.queue.position}番目` : '待機中');
    $('queue-cancel').disabled = blocked;
    $('refresh-lobby').disabled = blocked;

    const incoming = $('incoming-challenges'), outgoing = $('outgoing-challenges');
    incoming.replaceChildren(); outgoing.replaceChildren();
    const currentInvites = values => values.filter(value => !value.expiresAt || Date.parse(value.expiresAt) > Date.now());
    for (const invitation of currentInvites(S.lobby.incoming)) {
      const card = document.createElement('article'); card.className = 'invitation-card'; card.dataset.invitation = invitation.id;
      const summary = document.createElement('div'); summary.className = 'invitation-summary';
      const name = document.createElement('strong'); name.textContent = invitation.from?.name || '';
      const amount = document.createElement('span'); amount.textContent = '対戦の申込み';
      summary.append(name, amount);
      const actions = document.createElement('div'); actions.className = 'invitation-actions';
      actions.append(
        invitationButton('対戦', 'data-accept-invitation', invitation.id, 'challenge/accept', { invitationId: invitation.id }, blocked),
        invitationButton('辞退', 'data-decline-invitation', invitation.id, 'challenge/decline', { invitationId: invitation.id }, blocked),
      );
      card.append(summary, actions); incoming.append(card);
    }
    for (const invitation of currentInvites(S.lobby.outgoing)) {
      const card = document.createElement('article'); card.className = 'invitation-card outgoing';
      const summary = document.createElement('div'); summary.className = 'invitation-summary';
      const name = document.createElement('strong'); name.textContent = invitation.to?.name || '';
      const status = document.createElement('span'); status.textContent = '返事待ち';
      summary.append(name, status);
      card.append(summary, invitationButton('取消', 'data-cancel-invitation', invitation.id, 'challenge/cancel', { invitationId: invitation.id }, blocked));
      outgoing.append(card);
    }
    show('challenge-panel', incoming.childElementCount + outgoing.childElementCount > 0);

    const users = [
      { memberId: S.user.id, name: S.user.name, isYou: true },
      ...S.lobby.online.filter(user => user && String(user.memberId).toLowerCase() !== String(S.user.id).toLowerCase()),
    ];
    text('online-count', users.length);
    show('online-empty', users.length === 0);
    const list = $('online-users'); list.replaceChildren();
    for (const user of users) {
      const button = document.createElement(user.isYou ? 'div' : 'button'); button.className = 'online-user';
      if (user.isYou) button.dataset.selfUser = user.memberId;
      else {
        button.type = 'button';
        button.dataset.challengeUser = user.memberId;
        button.disabled = blocked || !!user.busy || S.lobby.outgoing.length > 0;
      }
      const indicator = document.createElement('span'); indicator.className = 'online-dot'; indicator.setAttribute('aria-hidden', 'true');
      const name = document.createElement('strong'); name.textContent = user.name || '';
      const status = document.createElement('span'); status.className = 'online-status'; status.textContent = user.isYou ? '自分' : user.busy ? '対戦中' : '›';
      button.append(indicator, name, status);
      if (!user.isYou) button.addEventListener('click', () => {
        const selected = preferences();
        if (selected) void mutate('challenge', { targetId: user.memberId, ...selected });
      });
      list.append(button);
    }

    const live=$('live-games');live.replaceChildren();
    for(const game of S.liveGames){
      const card=document.createElement('div');card.className='live-game-card';
      const info=document.createElement('div');info.className='live-game-score';
      const names=document.createElement('strong');names.textContent=`${game.host} vs ${game.guest}`;
      const score=document.createElement('small');score.textContent=`${game.scores.host} – ${game.scores.guest} · ${fmt(game.round)}手目`;
      info.append(names,score);
      const button=document.createElement('button');button.type='button';button.className='button secondary small';button.textContent='観戦';button.disabled=blocked;
      button.addEventListener('click',()=>{void beginSpectate(game.id);});
      card.append(info,button);live.append(card);
    }
    show('live-games-empty',S.liveGames.length===0);
    const ranking = $('ranking-users');
    ranking.replaceChildren();
    for (const entry of S.ranking) {
      const row = document.createElement('div');
      row.className = 'ranking-row' + (entry.isYou ? ' ranking-self' : '');
      const place = document.createElement('span'); place.className = 'ranking-place'; place.textContent = String(entry.rank);
      const name = document.createElement('strong'); name.className = 'ranking-name'; name.textContent = entry.name;
      const wins = document.createElement('span'); wins.className = 'ranking-wins'; wins.textContent = `${fmt(entry.wins)}勝`;
      const points = document.createElement('span'); points.className = 'ranking-points'; points.textContent = `${fmt(entry.points)} pt`;
      row.append(place, name, wins, points);
      ranking.append(row);
    }
    text('ranking-empty', S.rankingError && !S.rankingLoaded
      ? 'ランキングを取得できませんでした。更新ボタンで再確認できます。'
      : S.rankingLoaded ? 'まだ勝利記録がありません' : 'ランキングを読み込み中…');
    show('ranking-empty', S.ranking.length === 0);
  }

  function renderRoom(blocked) {
    const match = S.match;
    const role = myRole();
    const own = match[role];
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
    const validOffers = !!match.guest && validStake(match.host?.offer) && validStake(match.guest?.offer);
    const unequalOffers = validOffers && match.host.offer !== match.guest.offer;
    const draftMatchesOffer = validStake(Number($('stake').value)) && Number($('stake').value) === own?.offer;
    text('room-pot', fmt(matchPot(match)));
    text('room-info', '');
    text('ready-hint', own?.ready ? unequalOffers ? '相手の許可待ち' : '相手の準備待ち' : '');
    text('ready-button', S.busy === 'ready' ? '…' : own?.ready ? unequalOffers ? '✓ 許可済み' : '✓ 準備完了' : unequalOffers ? '許可' : '準備完了');
    $('ready-button').setAttribute('aria-label', `${fmt(match.host?.offer)}轟・${fmt(match.guest?.offer)}轟で${unequalOffers ? '許可' : '準備完了'}`);
    $('ready-button').disabled = blocked || !validOffers || !draftMatchesOffer || !!own?.ready;
    $('offer-submit').disabled = blocked;
    $('stake').disabled = blocked;
    $('leave-room').disabled = blocked;
    text('room-expiry', expiryCopy(match));
  }

  function renderGame(blocked) {
    const match = S.match;
    const role = myRole();
    const ended = isEnded(match);
    const animating = !!S.animation;
    const mine = match.turn === role;
    const processing = match.status === 'processing' || !!match.host?.inputLocked || !!match.guest?.inputLocked;
    const ready = !ended && !animating && !processing && turnWindowOpen();
    const remaining = clockNow() === null ? null : Math.max(0, Math.min(60, Math.ceil((S.turnClock.deadline - clockNow()) / 1000)));
    text('turn-name', ready ? match[match.turn]?.name || (mine ? '自分' : '相手') : '');
    text('turn-action', ended ? '終了' : animating ? (S.animation.goal ? 'GOAL' : '● ● ●') : ready ? '攻撃中' : '…');
    $('turn-banner').dataset.team = ready ? match.turn : '';
    text('turn-clock', ended ? '' : remaining === null ? '—' : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`);
    $('turn-clock').setAttribute('aria-label', remaining === null ? '残り時間を確認中' : `残り${remaining}秒`);
    $('turn-clock').classList.toggle('urgent', remaining !== null && remaining <= 10 && !ended);
    text('round-label', `${fmt(Number(match.round) || 1)}手目`);
    $('score-host-team').classList.toggle('is-attacking', ready && match.turn === 'host');
    $('score-guest-team').classList.toggle('is-attacking', ready && match.turn === 'guest');
    text('score-host-name', match.host?.name || '');
    text('score-guest-name', match.guest?.name || '');
    text('score-host', scoreOf('host')); text('score-guest', scoreOf('guest'));
    const watchers=S.social.viewers;
    text('watching-status', watchers.length ? `${watchers.slice(0,3).join('、')}${watchers.length>3?'ほか':''}が観戦中` : '');
    show('watching-status',watchers.length>0);
    show('stamp-control',!ended);
    for(const side of ['host','guest']){
      const count=Number(match[side]?.timeoutStreak??0);
      const label=$('score-'+side+'-timeouts');
      label.hidden=ended||count===0;
      label.textContent=count>0?`時間切れ ${count}/3`:'';
    }
    text('game-pot', fmt(matchPot(match)));
    text('escrow-amount', fmt(ended ? 0 : fundedStake(match, role)));
    text('team-label', '自分');
    $('team-label').classList.toggle('blue', role === 'guest');
    text('lock-input', S.busy === 'input' || animating || processing || (mine && !ready) ? '…' : mine ? '弾く' : '相手の番');
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
    const role = myRole();
    const stake = fundedStake(match, role);
    const opponentStake = fundedStake(match, role === 'host' ? 'guest' : 'host');
    text('result-title', cancelled ? '中止' : draw ? '引き分け' : win ? 'WIN' : 'LOSE');
    text('result-amount', cancelled || draw ? stake ? `${fmt(stake)} 轟返却` : '預かりなし' : win ? `${fmt(matchPot(match))} 轟獲得` : `−${fmt(stake)} 轟`);
    const timeoutLoss=match.reason==='three_timeouts';
    text('result-copy', cancelled || draw ? '全額返却済み'
      : timeoutLoss ? win ? `相手の3回連続時間切れで勝利 · 収支 ＋${fmt(opponentStake)} 轟`
        : '3回連続で時間切れとなったため敗北'
      : win ? `収支 ＋${fmt(opponentStake)} 轟` : '');
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
    if (!$('spectate-view').hidden && S.watch?.match) {
      const state=S.animation ? currentState() : S.watch.match.state;
      drawPitch($('spectate-pitch'),validState(state)?state:INITIAL,0,false);
    }
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
    const activeSeat = !S.animation && !isEnded(S.match) && turnWindowOpen() && !S.match?.host?.inputLocked && !S.match?.guest?.inputLocked
      ? S.match.turn === 'host' ? 0 : 1 : -1;
    state.players.forEach((p, i) => {
      const point = project(p, playerSeat);
      if (Math.floor(i / 8) === activeSeat) {
        ctx.beginPath(); ctx.arc(point.x, point.y, 35, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffffe6'; ctx.lineWidth = 4; ctx.stroke();
      }
      disc(ctx, point, 28, COLORS[Math.floor(i/8)]);
    });
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
    S.lobbyGeneration += 1;
    const leaveMatch=S.watch?.id;
    S.watch=null;S.watchTask=null;
    stopAnimation();
    clearTimeout(S.stampTimer);show('spectate-stamp',false);show('pitch-stamp',false);
    S.match = null;
    S.cancelOpen = false;
    S.rankingAt = 0;
    saveActive(null);
    render();
    if(leaveMatch)void request('watch/leave',{method:'POST',body:{matchId:leaveMatch}}).catch(()=>{});
    await refreshLobby();
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
    // Retired setup operations never held funds. Restore the authoritative
    // match instead of replaying obsolete room or formation choices.
    if (['rooms', 'rooms/join', 'formation'].includes(S.pending?.path)) clearPending();
    await refreshLobby({ heartbeat: true });
    if (epoch !== S.epoch) return;
    if (!S.match && typeof active === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(active)) {
      await refreshMatch({ matchId: active, initial: true });
    }
    if (epoch !== S.epoch) return;
    const url = new URL(location.href);
    if (url.searchParams.has('room')) { url.searchParams.delete('room'); history.replaceState(null, '', url.pathname + url.search + url.hash); }
    scheduleHeartbeat();
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
  $('random-form').addEventListener('submit', event => {
    event.preventDefault();
    const selected = preferences();
    if (selected && !$('random-button').disabled) void mutate('queue', selected);
  });
  $('queue-cancel').addEventListener('click', () => { void mutate('queue/cancel', {}); });
  $('offer-form').addEventListener('submit', event => { event.preventDefault(); if ($('offer-form').reportValidity() && S.match?.status === 'waiting') void mutate('offer', { matchId: S.match.id, stake: Number($('stake').value) }); });
  $('stake').addEventListener('input', () => { if (S.match?.status === 'waiting') renderRoom(!!S.busy || !!S.pending); });
  $('ready-button').addEventListener('click', () => {
    const match = S.match;
    if (match?.status === 'waiting' && !$('ready-button').disabled) void mutate('ready', {
      matchId: match.id, ready: true, expectedHostOffer: match.host.offer, expectedGuestOffer: match.guest.offer,
    });
  });
  $('leave-room').addEventListener('click', () => { if (S.match?.status === 'waiting') void mutate('cancel', { matchId: S.match.id }); });
  $('refresh-lobby').addEventListener('click', () => { void refreshLobby({ heartbeat: true }); void refreshRanking(true); });
  $('retry-action').addEventListener('click', () => { if (S.pending) void mutate(S.pending.path, S.pending.body, { retry: true }); });
  $('aim-angle').addEventListener('input', () => { if (!canShoot()) return; S.angle = Number($('aim-angle').value); updateAimControls(); });
  $('aim-power').addEventListener('input', () => { if (!canShoot()) return; S.power = Number($('aim-power').value); updateAimControls(); });
  $('aim-piece').addEventListener('change',()=>{if(!canShoot())return;S.piece=Number($('aim-piece').value);drawCurrent();});
  $('keyboard-controls').addEventListener('toggle',drawCurrent);
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
    void enterLobby();
  });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(S.poll); clearTimeout(S.heartbeat); clearTimeout(S.turnTimer);
    S.clockGeneration += 1;
    S.clockStale = true;
    if (!document.hidden && S.user) { render(); scheduleHeartbeat(0); schedulePoll(50); }
  });
  window.addEventListener('offline', () => { S.clockGeneration += 1; S.clockStale = true; render(); });
  window.addEventListener('online', () => { if (S.user && !document.hidden) { S.clockGeneration += 1; S.clockStale = true; render(); scheduleHeartbeat(0); schedulePoll(50); } });
  window.addEventListener('pagehide', () => { S.clockGeneration += 1; S.clockStale = true; clearTimeout(S.poll); clearTimeout(S.heartbeat); clearTimeout(S.turnTimer); });
  window.addEventListener('pageshow', event => { if (S.user && !document.hidden) { if (event.persisted) { S.clockGeneration += 1; S.clockStale = true; render(); } scheduleHeartbeat(0); schedulePoll(50); } });
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
