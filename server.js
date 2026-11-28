'use strict';

/**
 * Business Quiz — canlı quiz motoru
 * Business Partner AI altyapısındadır.
 *
 * Sıfır bağımlılık. Tek process, bellekte state, diske JSON snapshot.
 * Gerçek zamanlılık polling ile sağlanır (WebSocket yok) — istemci stateless
 * olduğu için kopan telefon sonraki istekte doğru duruma kendiliğinden döner.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;

// Host ekranının tek kilidi. Üretimde eksikse başlamıyoruz: sessizce üretilen
// kısa bir anahtar, yönetici ekranını zayıf bir parolayla açık bırakmak olurdu.
if (!process.env.HOST_KEY && process.env.NODE_ENV === 'production') {
  console.error('[fatal] HOST_KEY tanimlanmadan uretimde baslatilamaz.');
  process.exit(1);
}
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(16).toString('base64url');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SNAPSHOT = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Sonuç ve ara sıralama ekranlarının kendiliğinden ilerleme süreleri.
const REVEAL_MS = Number(process.env.REVEAL_MS) || 6000;
const BOARD_MS = Number(process.env.BOARD_MS) || 7000;

// ------------------------------------------------------------- sorular ----

function loadRounds() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
  // Eski biçim (düz soru dizisi) tek turluk kabul edilir.
  if (Array.isArray(raw)) return [{ name: 'Tur 1', questions: raw }];
  return raw.rounds;
}
const ROUNDS = loadRounds();

// ---------------------------------------------------------------- state ----

let state = null;

function freshState(roundIndex) {
  return {
    pin: String(Math.floor(100000 + Math.random() * 900000)),
    roundIndex: Math.min(Math.max(roundIndex || 0, 0), ROUNDS.length - 1),
    phase: 'lobby', // lobby | question | reveal | scoreboard | final
    qIndex: -1,
    startedAt: null,
    phaseAt: Date.now(),
    players: {},
    leads: [],
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    if (parsed && parsed.players && parsed.pin) {
      if (typeof parsed.roundIndex !== 'number') parsed.roundIndex = 0;
      if (!parsed.phaseAt) parsed.phaseAt = Date.now();
      console.log('[state] snapshot yüklendi, PIN %s, tur %d', parsed.pin, parsed.roundIndex + 1);
      return parsed;
    }
  } catch (_) {
    /* ilk açılış */
  }
  return freshState(0);
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SNAPSHOT, JSON.stringify(state), 'utf8');
    } catch (err) {
      console.error('[state] snapshot yazılamadı:', err.message);
    }
  }, 300);
}

// ------------------------------------------------------------- yardımcı ----

function round() {
  return ROUNDS[state.roundIndex] || ROUNDS[0];
}
function questions() {
  return round().questions;
}
function currentQuestion() {
  return state.qIndex >= 0 ? questions()[state.qIndex] : null;
}
function durationMs() {
  const q = currentQuestion();
  return (q ? q.seconds || 20 : 20) * 1000;
}
function elapsed() {
  return state.startedAt ? Date.now() - state.startedAt : 0;
}
function remainingMs() {
  if (state.phase !== 'question') return 0;
  return Math.max(0, durationMs() - elapsed());
}

function setPhase(p) {
  state.phase = p;
  state.phaseAt = Date.now();
}

function gotoQuestion(i) {
  state.qIndex = i;
  state.startedAt = Date.now();
  setPhase('question');
}

/**
 * Zamanlayıcı yerine her istekte bakılır: süre dolunca sonuç, sonuç bitince
 * ara sıralama, o da bitince sıradaki soru — host hiçbir tuşa basmasa bile
 * oyun kendi kendine akar.
 */
function settlePhase() {
  let guard = 0;
  while (guard++ < 5) {
    const since = Date.now() - (state.phaseAt || 0);
    if (state.phase === 'question' && remainingMs() === 0) {
      setPhase('reveal');
      save();
      continue;
    }
    if (state.phase === 'reveal' && since >= REVEAL_MS) {
      setPhase('scoreboard');
      save();
      continue;
    }
    if (state.phase === 'scoreboard' && since >= BOARD_MS) {
      if (state.qIndex + 1 >= questions().length) setPhase('final');
      else gotoQuestion(state.qIndex + 1);
      save();
      continue;
    }
    break;
  }
}

function leaderboard(limit) {
  const list = Object.values(state.players)
    .map((p) => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'tr'));
  return limit ? list.slice(0, limit) : list;
}

function answerCounts() {
  const q = currentQuestion();
  if (!q) return [];
  const counts = q.choices.map(() => 0);
  for (const p of Object.values(state.players)) {
    const a = p.answers[state.qIndex];
    if (a && typeof a.choice === 'number' && counts[a.choice] !== undefined) counts[a.choice] += 1;
  }
  return counts;
}

function answeredCount() {
  let n = 0;
  for (const p of Object.values(state.players)) if (p.answers[state.qIndex]) n += 1;
  return n;
}

// ------------------------------------------------------------ http yard. ----

function send(res, status, body, headers) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 16 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return reject(new Error('body too large'));
      try { resolve(data ? JSON.parse(data) : {}); } catch (_) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function isHost(url) {
  return url.searchParams.get('key') === HOST_KEY;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': path.extname(full) === '.webp' ? 'public, max-age=3600' : 'no-cache',
    });
    res.end(buf);
  });
}

// -------------------------------------------------------------- handlers ----

async function handleJoin(req, res) {
  const body = await readBody(req);
  const name = String(body.name || '').trim().slice(0, 24);
  if (!name) return send(res, 400, { error: 'İsim gerekli' });
  if (String(body.pin || '') !== state.pin) return send(res, 400, { error: 'PIN hatalı' });

  const id = crypto.randomUUID();
  state.players[id] = { id, name, score: 0, answers: {}, joinedAt: Date.now() };
  save();
  console.log('[join] %s (%d oyuncu)', name, Object.keys(state.players).length);
  return send(res, 200, { playerId: id, name, pin: state.pin });
}

function handlePlayerState(res, url) {
  settlePhase();
  const pid = url.searchParams.get('pid');
  const me = pid ? state.players[pid] : null;

  const out = {
    phase: state.phase,
    qIndex: state.qIndex,
    total: questions().length,
    roundName: round().name,
    playerCount: Object.keys(state.players).length,
    known: Boolean(me),
    pin: state.pin,
  };

  if (me) {
    out.me = { name: me.name, score: me.score };
    const rank = leaderboard().findIndex((p) => p.id === me.id);
    out.me.rank = rank >= 0 ? rank + 1 : null;
  }

  const q = currentQuestion();
  if (q && (state.phase === 'question' || state.phase === 'reveal')) {
    out.question = {
      text: q.text,
      choices: q.choices,
      index: state.qIndex,
      remainingMs: remainingMs(),
      durationMs: durationMs(),
    };
    const a = me ? me.answers[state.qIndex] : null;
    out.answered = Boolean(a);
    if (a) out.myChoice = a.choice;

    if (state.phase === 'reveal') {
      out.correct = q.correct;
      out.counts = answerCounts();
      out.gained = a ? a.points : 0;
      out.wasCorrect = Boolean(a && a.choice === q.correct);
      if (q.note) out.note = q.note;
    }
  }

  if (state.phase === 'scoreboard') {
    out.board = leaderboard(5);
    out.qIndexDone = state.qIndex;
  }

  if (state.phase === 'final') {
    out.podium = leaderboard(5);
    out.leadSubmitted = me ? state.leads.some((l) => l.playerId === me.id) : false;
  }

  return send(res, 200, out);
}

async function handleAnswer(req, res) {
  settlePhase();
  const body = await readBody(req);
  const me = state.players[String(body.playerId || '')];
  if (!me) return send(res, 400, { error: 'Oyuncu bulunamadı' });
  if (state.phase !== 'question') return send(res, 409, { error: 'Soru aktif değil' });
  if (Number(body.qIndex) !== state.qIndex) return send(res, 409, { error: 'Soru değişti' });
  if (me.answers[state.qIndex]) return send(res, 409, { error: 'Zaten cevapladın' });

  const choice = Number(body.choice);
  const q = currentQuestion();
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.choices.length) {
    return send(res, 400, { error: 'Geçersiz şık' });
  }

  const ms = elapsed();
  const ratio = Math.min(1, ms / durationMs());
  const correct = choice === q.correct;
  const points = correct ? Math.round(1000 * (1 - ratio / 2)) : 0;

  me.answers[state.qIndex] = { choice, ms, points };
  me.score += points;
  save();
  return send(res, 200, { ok: true, answered: true });
}

async function handleLead(req, res) {
  const body = await readBody(req);
  const me = state.players[String(body.playerId || '')];
  if (!me) return send(res, 400, { error: 'Oyuncu bulunamadı' });
  if (body.consent !== true) return send(res, 400, { error: 'Onay gerekli' });

  const email = String(body.email || '').trim().slice(0, 120);
  const phone = String(body.phone || '').trim().slice(0, 30);
  if (!email && !phone) return send(res, 400, { error: 'E-posta veya telefon gerekli' });

  state.leads = state.leads.filter((l) => l.playerId !== me.id);
  state.leads.push({
    playerId: me.id, name: me.name, email, phone,
    company: String(body.company || '').trim().slice(0, 80),
    score: me.score, round: round().name, consent: true, at: new Date().toISOString(),
  });
  save();
  console.log('[lead] %s', me.name);
  return send(res, 200, { ok: true });
}

function handleHostState(res) {
  settlePhase();
  const q = currentQuestion();
  const since = Date.now() - (state.phaseAt || 0);
  return send(res, 200, {
    pin: state.pin,
    phase: state.phase,
    qIndex: state.qIndex,
    total: questions().length,
    roundIndex: state.roundIndex,
    roundName: round().name,
    roundCount: ROUNDS.length,
    rounds: ROUNDS.map((r, i) => ({ index: i, name: r.name, count: r.questions.length })),
    playerCount: Object.keys(state.players).length,
    players: Object.values(state.players).map((p) => ({ name: p.name, score: p.score })),
    leaderboard: leaderboard(10),
    leadCount: state.leads.length,
    autoInMs:
      state.phase === 'reveal' ? Math.max(0, REVEAL_MS - since)
      : state.phase === 'scoreboard' ? Math.max(0, BOARD_MS - since)
      : null,
    question: q
      ? {
          text: q.text,
          choices: q.choices,
          correct: state.phase === 'reveal' || state.phase === 'scoreboard' ? q.correct : null,
          note: state.phase === 'reveal' ? q.note || null : null,
          remainingMs: remainingMs(),
          durationMs: durationMs(),
          answered: answeredCount(),
          counts: state.phase === 'reveal' ? answerCounts() : null,
        }
      : null,
  });
}

async function handleHostAction(req, res) {
  const body = await readBody(req);
  const action = String(body.action || '');

  switch (action) {
    /**
     * Host ekranındaki tek butonun eylemi; kararı sunucu verir.
     * seenPhase/seenIndex, host'un BASARKEN gördüğü ekranı bildirir: faz
     * kendiliğinden ilerlediği anda basılan tuş soruyu atlamasın diye,
     * gördüğü ekran bayatsa komut yutulur.
     */
    case 'advance': {
      settlePhase();
      if (String(body.seenPhase || '') !== state.phase || Number(body.seenIndex) !== state.qIndex) break;
      if (state.phase === 'question') { setPhase('reveal'); break; }
      if (state.phase === 'reveal') { setPhase('scoreboard'); break; }
      if (state.phase === 'final') break;
      // lobby veya scoreboard → sıradaki soru
      if (state.qIndex + 1 >= questions().length) setPhase('final');
      else gotoQuestion(state.qIndex + 1);
      break;
    }
    case 'reveal':
      if (state.phase === 'question') setPhase('reveal');
      break;
    // Doğrudan sıradaki soru (prova ve testler için; arayüz advance kullanır).
    case 'next': {
      if (state.qIndex + 1 >= questions().length) setPhase('final');
      else gotoQuestion(state.qIndex + 1);
      break;
    }
    case 'final':
      setPhase('final');
      break;
    case 'reset': {
      const leads = state.leads; // lead'ler korunur
      state = freshState(state.roundIndex);
      state.leads = leads;
      break;
    }
    // Sıradaki tura geçer: yeni PIN, sıfır skor, lead'ler korunur.
    case 'nextRound': {
      const leads = state.leads;
      const next = Math.min(state.roundIndex + 1, ROUNDS.length - 1);
      state = freshState(next);
      state.leads = leads;
      break;
    }
    case 'setRound': {
      const leads = state.leads;
      state = freshState(Number(body.round) || 0);
      state.leads = leads;
      break;
    }
    // Her şeyi siler, lead'ler dahil. Prova sonrası sahneyi temiz bırakmak
    // için. Arayüze bilerek konmadı: yanlışlıkla basılması lead kaybettirir.
    case 'purge':
      state = freshState(state.roundIndex);
      break;
    default:
      return send(res, 400, { error: 'Bilinmeyen eylem' });
  }
  save();
  console.log('[host] %s → tur=%d faz=%s q=%d', action, state.roundIndex, state.phase, state.qIndex);
  return handleHostState(res);
}

function handleLeadsCsv(res) {
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [['isim', 'eposta', 'telefon', 'sirket', 'puan', 'tur', 'onay', 'tarih'].join(',')];
  for (const l of state.leads) {
    rows.push([l.name, l.email, l.phone, l.company, l.score, l.round || '', l.consent ? 'evet' : 'hayir', l.at].map(esc).join(','));
  }
  send(res, 200, '﻿' + rows.join('\r\n'), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="business-quiz-leads.csv"',
  });
}

// ---------------------------------------------------------------- server ----

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p === '/api/join' && req.method === 'POST') return await handleJoin(req, res);
    if (p === '/api/state' && req.method === 'GET') return handlePlayerState(res, url);
    if (p === '/api/answer' && req.method === 'POST') return await handleAnswer(req, res);
    if (p === '/api/lead' && req.method === 'POST') return await handleLead(req, res);
    if (p === '/api/health') return send(res, 200, { ok: true, phase: state.phase });

    if (p.startsWith('/api/host/')) {
      if (!isHost(url)) return send(res, 403, { error: 'Yetkisiz' });
      if (p === '/api/host/state' && req.method === 'GET') return handleHostState(res);
      if (p === '/api/host/action' && req.method === 'POST') return await handleHostAction(req, res);
      if (p === '/api/host/leads.csv' && req.method === 'GET') return handleLeadsCsv(res);
      return send(res, 404, { error: 'not found' });
    }

    if (p === '/host') return serveStatic(res, '/host.html');
    if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    return serveStatic(res, p);
  } catch (err) {
    console.error('[err] %s %s — %s', req.method, p, err.message);
    if (!res.headersSent) send(res, 400, { error: 'Geçersiz istek' });
  }
});

state = loadState();

server.listen(PORT, () => {
  console.log('');
  console.log('  Business Quiz — Business Partner AI altyapısındadır');
  console.log('  ---------------------------------------------------');
  console.log('  Oyuncu : http://localhost:%d/', PORT);
  console.log('  Host   : http://localhost:%d/host?key=%s', PORT, HOST_KEY);
  console.log('  PIN    : %s', state.pin);
  console.log('  Tur    : %d/%d — %s (%d soru)', state.roundIndex + 1, ROUNDS.length, round().name, questions().length);
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SNAPSHOT, JSON.stringify(state), 'utf8');
      console.log('\n[state] kapanışta kaydedildi.');
    } catch (_) {}
    process.exit(0);
  });
}
