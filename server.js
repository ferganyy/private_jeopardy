const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const DATA = require('./game-data');
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

const rooms = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const roomCode = () => Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
const cleanName = (v) => String(v || '').trim().slice(0, 18) || 'Player';
const clone = (x) => JSON.parse(JSON.stringify(x));
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

function newRoom(code, hostToken, hostName) {
  const boards = clone(DATA.boards);
  const allKeys = (round) => {
    const keys = [];
    boards[round - 1].categories.forEach((c, ci) => c.clues.forEach((_, qi) => keys.push(`${ci}:${qi}`)));
    return keys;
  };
  const pick = (arr, n) => {
    const pool = [...arr], out = [];
    while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    return out;
  };
  return {
    code, hostToken, phase: 'lobby', round: 1,
    players: [{ token: hostToken, name: hostName, score: 0, connected: false }],
    streams: new Map(), boards,
    used: { 1: [], 2: [] },
    dailyDoubles: { 1: pick(allKeys(1), 1), 2: pick(allKeys(2), 2) },
    selectorToken: hostToken, current: null, quick: null, createdAt: Date.now()
  };
}
function playerByToken(room, token) { return room.players.find(p => p.token === token); }
function connectedPlayers(room) { return room.players.filter(p => p.connected); }
function key(ci, qi) { return `${ci}:${qi}`; }
function publicState(room, viewerToken) {
  const current = room.current ? { ...room.current } : null;
  if (current) { delete current._answer; const maySee = current.status === 'closed' || (current.status === 'revealed' && viewerToken === current.answeringToken); if (!maySee) delete current.answer; }
  const quick = room.quick ? clone(room.quick) : null;
  if (quick && !quick.revealed && room.phase === 'quick') delete quick.answers;
  return {
    code: room.code, phase: room.phase, round: room.round, hostToken: room.hostToken, selectorToken: room.selectorToken,
    players: room.players.map(({ token, name, score, connected }) => ({ token, name, score, connected })),
    board: room.phase === 'board' || room.phase === 'roundBreak' ? { title: room.boards[room.round - 1].title, categories: room.boards[room.round - 1].categories.map(c => ({ name: c.name, clues: c.clues.map(x => ({ value: x.value })) })) } : null,
    used: room.used[room.round], current, quick, viewerToken, serverNow: Date.now()
  };
}
function writeSSE(res, data) { try { res.write(`data: ${JSON.stringify(data)}\n\n`); return true; } catch { return false; } }
function emitRoom(room) {
  for (const [token, set] of room.streams.entries()) {
    for (const res of [...set]) if (!writeSSE(res, publicState(room, token))) set.delete(res);
  }
}
function allResolved(room) {
  if (!room.current) return false;
  const done = new Set([...(room.current.excluded || []), ...(room.current.skipped || [])]);
  const active = connectedPlayers(room);
  return active.length > 0 && active.every(p => done.has(p.token));
}
function boardFinished(room) {
  const total = room.boards[room.round - 1].categories.reduce((n, c) => n + c.clues.length, 0);
  return room.used[room.round].length >= total;
}
function closeClue(room) { room.current = null; if (boardFinished(room)) room.phase = 'roundBreak'; emitRoom(room); }
function revealDeadClue(room) {
  if (!room.current) return;
  room.current.status = 'closed'; room.current.answer = room.current._answer; room.current.deadline = null; emitRoom(room);
}
function handleWrong(room, token, isTimeout = false) {
  const c = room.current; if (!c || c.answeringToken !== token) return;
  const p = playerByToken(room, token); if (!p) return;
  if (c.isDailyDouble) {
    p.score -= c.wager || 0;
    c.status = 'closed'; c.answer = c._answer; c.deadline = null; c.result = isTimeout ? 'timeout' : 'wrong'; emitRoom(room); return;
  }
  p.score -= c.value;
  c.excluded = [...new Set([...(c.excluded || []), token])];
  c.answeringToken = null; c.status = 'open'; c.deadline = null; c.result = isTimeout ? 'timeout' : 'wrong';
  if (allResolved(room)) revealDeadClue(room); else emitRoom(room);
}
function scheduleTimeout(room, token, clueId, deadline) {
  setTimeout(() => {
    const fresh = rooms.get(room.code);
    if (!fresh?.current || fresh.current.id !== clueId || fresh.current.answeringToken !== token || fresh.current.status !== 'answering') return;
    handleWrong(fresh, token, true);
  }, Math.max(0, deadline - Date.now() + 30));
}
function startQuickMoney(room) {
  const ranked = [...room.players].sort((a, b) => b.score - a.score);
  const finalists = ranked.slice(0, 2);
  if (finalists.length < 2) { room.phase = 'gameOver'; return; }
  const lead = Math.max(0, finalists[0].score - finalists[1].score);
  const headStart = Math.min(50, Math.round(lead / 100));
  room.phase = 'quick';
  room.quick = {
    finalists: finalists.map(p => p.token), names: Object.fromEntries(finalists.map(p => [p.token, p.name])),
    scores: { [finalists[0].token]: headStart, [finalists[1].token]: 0 }, headStart,
    index: 0, question: DATA.quickMoney[0].q, locked: {}, revealed: false, answers: null, picks: {}
  };
}

function action(room, token, type, payload = {}) {
  const me = playerByToken(room, token); if (!me) return { ok: false, error: 'Player not in room.' };
  if (type === 'startGame') {
    if (token !== room.hostToken || room.phase !== 'lobby' || room.players.length < 2) return { ok: false };
    room.phase = 'board'; room.round = 1; room.selectorToken = room.players[Math.floor(Math.random() * room.players.length)].token; emitRoom(room); return { ok: true };
  }
  if (type === 'selectClue') {
    if (room.phase !== 'board' || room.current || (token !== room.selectorToken && token !== room.hostToken)) return { ok: false };
    const ci = Number(payload.ci), qi = Number(payload.qi), k = key(ci, qi);
    if (room.used[room.round].includes(k)) return { ok: false };
    const clue = room.boards[room.round - 1]?.categories[ci]?.clues[qi]; if (!clue) return { ok: false };
    room.used[room.round].push(k); const dd = room.dailyDoubles[room.round].includes(k);
    room.current = { id: crypto.randomUUID(), ci, qi, category: room.boards[room.round - 1].categories[ci].name, value: clue.value, question: clue.q, _answer: clue.a,
      status: dd ? 'wager' : 'open', isDailyDouble: dd, answeringToken: dd ? room.selectorToken : null, excluded: [], skipped: [], deadline: null, wager: null };
    emitRoom(room); return { ok: true };
  }
  if (type === 'submitWager') {
    const c = room.current; if (!c || c.status !== 'wager' || token !== c.answeringToken) return { ok: false };
    const max = me.score > 0 ? me.score : Math.abs(me.score);
    const wager = Math.max(0, Math.min(max, Math.floor(Number(payload.wager) || 0)));
    c.wager = wager; c.status = 'answering'; c.deadline = Date.now() + 30000; scheduleTimeout(room, token, c.id, c.deadline); emitRoom(room); return { ok: true };
  }
  if (type === 'buzz') {
    const c = room.current; if (!c || c.status !== 'open' || c.isDailyDouble || c.excluded.includes(token) || c.skipped.includes(token)) return { ok: false };
    c.answeringToken = token; c.status = 'answering'; c.deadline = Date.now() + 30000; c.result = null; scheduleTimeout(room, token, c.id, c.deadline); emitRoom(room); return { ok: true };
  }
  if (type === 'skip') {
    const c = room.current; if (!c || c.status !== 'open' || c.excluded.includes(token)) return { ok: false };
    c.skipped = [...new Set([...c.skipped, token])]; if (allResolved(room)) revealDeadClue(room); else emitRoom(room); return { ok: true };
  }
  if (type === 'showAnswer') {
    const c = room.current; if (!c || c.status !== 'answering' || token !== c.answeringToken) return { ok: false };
    c.status = 'revealed'; c.answer = c._answer; c.deadline = null; emitRoom(room); return { ok: true };
  }
  if (type === 'markAnswer') {
    const c = room.current; if (!c || c.status !== 'revealed' || token !== c.answeringToken) return { ok: false };
    if (payload.correct) { me.score += c.isDailyDouble ? (c.wager || 0) : c.value; room.selectorToken = token; c.status = 'closed'; c.answer = c._answer; c.result = 'correct'; emitRoom(room); }
    else handleWrong(room, token, false);
    return { ok: true };
  }
  if (type === 'continue') {
    const c = room.current; if (!c || c.status !== 'closed' || (token !== room.hostToken && token !== room.selectorToken && token !== c.answeringToken)) return { ok: false };
    closeClue(room); return { ok: true };
  }
  if (type === 'nextRound') {
    if (room.phase !== 'roundBreak' || token !== room.hostToken) return { ok: false };
    if (room.round === 1) { room.round = 2; room.phase = 'board'; room.selectorToken = [...room.players].sort((a,b)=>a.score-b.score)[0].token; }
    else startQuickMoney(room);
    emitRoom(room); return { ok: true };
  }
  if (type === 'quickLock') {
    const q = room.quick; if (room.phase !== 'quick' || !q || q.revealed || !q.finalists.includes(token)) return { ok: false };
    q.locked[token] = true; if (q.finalists.every(t => q.locked[t])) { q.revealed = true; q.answers = DATA.quickMoney[q.index].answers; } emitRoom(room); return { ok: true };
  }
  if (type === 'quickPick') {
    const q = room.quick; if (room.phase !== 'quick' || !q?.revealed || !q.finalists.includes(token) || q.picks[token] != null) return { ok: false };
    const answers = DATA.quickMoney[q.index].answers, i = Number(payload.answerIndex), pts = i >= 0 && answers[i] ? answers[i].points : 0;
    q.picks[token] = i; q.scores[token] += pts; emitRoom(room); return { ok: true };
  }
  if (type === 'quickNext') {
    const q = room.quick; if (room.phase !== 'quick' || !q || token !== room.hostToken || !q.finalists.every(t => q.picks[t] != null)) return { ok: false };
    if (q.index >= DATA.quickMoney.length - 1) room.phase = 'gameOver';
    else { q.index++; q.question = DATA.quickMoney[q.index].q; q.locked = {}; q.revealed = false; q.answers = null; q.picks = {}; }
    emitRoom(room); return { ok: true };
  }
  if (type === 'restart') {
    if (token !== room.hostToken) return { ok: false };
    const fresh = newRoom(room.code, room.hostToken, playerByToken(room, room.hostToken)?.name || 'Host');
    fresh.players = room.players.map(p => ({ ...p, score: 0 })); fresh.streams = room.streams; rooms.set(room.code, fresh); emitRoom(fresh); return { ok: true };
  }
  return { ok: false, error: 'Unknown action.' };
}

function readBody(req) { return new Promise((resolve, reject) => { let raw=''; req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch(e) { reject(e); } }); }); }
function mime(file) { const ext=path.extname(file).toLowerCase(); return ({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'})[ext] || 'application/octet-stream'; }
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { const fallback=path.join(PUBLIC,'index.html'); res.writeHead(200,{'content-type':'text/html; charset=utf-8'}); return fs.createReadStream(fallback).pipe(res); }
    res.writeHead(200, { 'content-type': mime(file), 'cache-control': rel === 'index.html' ? 'no-store' : 'public, max-age=300' }); fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (u.pathname === '/health') return json(res, 200, { ok: true });
  if (u.pathname === '/events' && req.method === 'GET') {
    const code = String(u.searchParams.get('code') || '').toUpperCase(), token = u.searchParams.get('token') || '', room = rooms.get(code), p = room && playerByToken(room, token);
    if (!room || !p) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type':'text/event-stream', 'cache-control':'no-cache, no-transform', 'connection':'keep-alive', 'x-accel-buffering':'no' });
    res.write(': connected\n\n');
    if (!room.streams.has(token)) room.streams.set(token, new Set()); room.streams.get(token).add(res); p.connected = true; writeSSE(res, publicState(room, token)); emitRoom(room);
    const keep = setInterval(()=>{try{res.write(': ping\n\n')}catch{}},20000);
    req.on('close',()=>{clearInterval(keep);const set=room.streams.get(token);set?.delete(res);if(set?.size===0){room.streams.delete(token);p.connected=false;if(room.current?.status==='open'&&allResolved(room))revealDeadClue(room);else emitRoom(room);}}); return;
  }
  if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
    let body; try { body = await readBody(req); } catch { return json(res,400,{ok:false,error:'Invalid JSON.'}); }
    if (u.pathname === '/api/create') {
      const token=String(body.token||crypto.randomUUID()); let code; do code=roomCode(); while(rooms.has(code)); rooms.set(code,newRoom(code,token,cleanName(body.name))); return json(res,200,{ok:true,code});
    }
    if (u.pathname === '/api/join') {
      const code=String(body.code||'').toUpperCase().trim(), token=String(body.token||''), room=rooms.get(code); if(!room)return json(res,404,{ok:false,error:'Room not found.'});
      let p=playerByToken(room,token); if(!p){if(room.phase!=='lobby')return json(res,409,{ok:false,error:'Game already started.'});if(room.players.length>=6)return json(res,409,{ok:false,error:'Room is full.'});p={token,name:cleanName(body.name),score:0,connected:false};room.players.push(p)}else if(body.name)p.name=cleanName(body.name);
      emitRoom(room); return json(res,200,{ok:true,code});
    }
    if (u.pathname === '/api/action') {
      const code=String(body.code||'').toUpperCase(), room=rooms.get(code); if(!room)return json(res,404,{ok:false,error:'Room not found.'}); return json(res,200,action(room,String(body.token||''),String(body.action||''),body.payload||{}));
    }
    return json(res,404,{ok:false});
  }
  if (req.method === 'GET') return serveStatic(req,res,u.pathname);
  res.writeHead(405); res.end('Method not allowed');
});
server.listen(PORT, () => console.log(`Buzz Battle running on http://localhost:${PORT}`));
