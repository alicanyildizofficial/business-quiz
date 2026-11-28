'use strict';

const GLYPHS = ['▲', '◆', '●', '■'];
const $ = (id) => document.getElementById(id);

const KEY = new URLSearchParams(location.search).get('key') || '';
if (!KEY) {
  document.body.innerHTML =
    '<div class="wrap"><h1>Host anahtarı eksik</h1>' +
    '<p class="lead">Bu sayfayı <code>/host?key=...</code> adresiyle aç.</p></div>';
  throw new Error('no key');
}

let lastQIndex = -1;
let lastPhase = null;
let localDeadline = 0;
let localDuration = 20000;
let knownPlayers = -1;
let confettiAt = null;

function show(name) {
  for (const el of document.querySelectorAll('.screen')) el.classList.remove('active');
  $('h-' + name).classList.add('active');
}

async function action(name, extra) {
  const res = await fetch('/api/host/action?key=' + encodeURIComponent(KEY), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action: name }, extra || {})),
  });
  if (res.ok) render(await res.json());
}

// Tek buton akışı yönetir; kararı sunucu verir (bayat komut soruyu atlamaz).
$('h-main').addEventListener('click', () => {
  action('advance', { seenPhase: lastPhase, seenIndex: lastQIndex });
});
$('h-reset').addEventListener('click', () => {
  if (confirm('Bu turu baştan başlatalım mı? Puanlar sıfırlanır, PIN değişir, leadler korunur.')) {
    lastQIndex = -1; knownPlayers = -1; confettiAt = null;
    action('reset');
  }
});
$('h-next-round').addEventListener('click', () => {
  if (confirm('Sonraki tura geçilsin mi? Yeni PIN üretilir, puanlar sıfırlanır, leadler korunur.')) {
    lastQIndex = -1; knownPlayers = -1; confettiAt = null;
    action('nextRound');
  }
});
$('h-csv').addEventListener('click', () => {
  location.href = '/api/host/leads.csv?key=' + encodeURIComponent(KEY);
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space' || e.code === 'ArrowRight' || e.code === 'Enter') {
    e.preventDefault();
    $('h-main').click();
  }
});

function tickTimer() {
  if (!localDeadline) return;
  const left = Math.max(0, localDeadline - Date.now());
  $('h-left').textContent = String(Math.ceil(left / 1000));
  $('h-fill').style.width = (left / localDuration) * 100 + '%';
}
setInterval(tickTimer, 100);

function renderChoices(q, reveal) {
  const box = $('h-choices');
  const counts = q.counts || [];
  box.innerHTML = '';
  q.choices.forEach((text, i) => {
    const d = document.createElement('div');
    d.className = 'host-choice';
    d.dataset.i = String(i);
    const g = document.createElement('span'); g.className = 'g'; g.textContent = GLYPHS[i];
    const t = document.createElement('span'); t.textContent = text;
    d.append(g, t);
    if (reveal) {
      const c = document.createElement('span');
      c.className = 'cnt';
      c.textContent = (counts[i] || 0) + ' kişi';
      d.appendChild(c);
      if (i === q.correct) d.classList.add('right'); else d.classList.add('dim');
    }
    box.appendChild(d);
  });
}

function fillRank(ul, list, offset) {
  const off = offset || 0;
  ul.innerHTML = '';
  list.forEach((p, i) => {
    const li = document.createElement('li');
    if (off === 0 && i === 0) li.classList.add('gold');
    const pos = document.createElement('span'); pos.className = 'pos'; pos.textContent = off + i + 1;
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name;
    const sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = p.score;
    li.append(pos, nm, sc);
    ul.appendChild(li);
  });
}

function autoText(ms) {
  if (ms == null) return '';
  return 'Sıradaki ekran <b>' + Math.ceil(ms / 1000) + '</b> sn içinde — beklemeden geçmek için boşluğa bas.';
}

function render(s) {
  $('h-players').textContent = s.playerCount;
  $('h-leads').textContent = s.leadCount;
  $('h-answered').textContent = s.question ? s.question.answered : 0;
  $('h-pos').textContent = s.qIndex >= 0 ? (s.qIndex + 1) + '/' + s.total : '—';
  $('h-round').textContent = (s.roundIndex + 1) + '/' + s.roundCount;

  if (s.phase === 'lobby') {
    $('h-pin').textContent = s.pin;
    $('h-url').textContent = location.host;
    $('h-roundname').textContent = s.roundName + ' · Oyun PIN kodu';
    if (s.playerCount !== knownPlayers) {
      knownPlayers = s.playerCount;
      const box = $('h-joined');
      box.innerHTML = '';
      for (const p of s.players.slice(-40)) {
        const c = document.createElement('span');
        c.className = 'chip';
        c.textContent = p.name;
        box.appendChild(c);
      }
    }
    $('h-main').textContent = s.playerCount ? 'Yarışmayı başlat' : 'Başlat';
    $('h-main').disabled = s.playerCount === 0;
    show('lobby');
  } else if (s.phase === 'question' && s.question) {
    if (s.qIndex !== lastQIndex || lastPhase !== 'question') {
      $('h-qtext').textContent = s.question.text;
      $('h-note').textContent = '';
      $('h-auto').innerHTML = '';
      renderChoices(s.question, false);
    }
    localDuration = s.question.durationMs;
    localDeadline = Date.now() + s.question.remainingMs;
    document.querySelector('.host-timer').style.visibility = 'visible';
    tickTimer();
    $('h-main').textContent = 'Sonucu göster';
    $('h-main').disabled = false;
    show('question');
  } else if (s.phase === 'reveal' && s.question) {
    localDeadline = 0;
    document.querySelector('.host-timer').style.visibility = 'hidden';
    $('h-qtext').textContent = s.question.text;
    renderChoices(s.question, true);
    $('h-note').textContent = s.question.note || '';
    $('h-auto').innerHTML = autoText(s.autoInMs);
    $('h-main').textContent = 'Sıralamayı göster';
    $('h-main').disabled = false;
    show('question');
  } else if (s.phase === 'scoreboard') {
    fillRank($('h-boardlist'), s.leaderboard);
    $('h-auto2').innerHTML = autoText(s.autoInMs);
    $('h-main').textContent = s.qIndex + 1 >= s.total ? 'Yarışmayı bitir' : 'Sonraki soru';
    $('h-main').disabled = false;
    show('board');
  } else if (s.phase === 'final') {
    const pod = s.leaderboard || [];
    for (let i = 0; i < 3; i++) {
      const p = pod[i];
      $('hpod' + (i + 1) + '-name').textContent = p ? p.name : '—';
      $('hpod' + (i + 1) + '-score').textContent = p ? p.score + ' puan' : '';
    }
    fillRank($('h-rest'), pod.slice(3), 3);
    if (confettiAt !== s.roundIndex) {
      confettiAt = s.roundIndex;
      if (window.confettiBurst) {
        window.confettiBurst(200);
        setTimeout(() => window.confettiBurst(140), 700);
      }
    }
    $('h-main').textContent = 'Bitti';
    $('h-main').disabled = true;
    show('final');
  }

  lastQIndex = s.qIndex;
  lastPhase = s.phase;
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const res = await fetch('/api/host/state?key=' + encodeURIComponent(KEY), { cache: 'no-store' });
    if (res.ok) render(await res.json());
    else if (res.status === 403) document.body.innerHTML = '<div class="wrap"><h1>Anahtar geçersiz</h1></div>';
  } catch (_) { /* yeniden dener */ }
  polling = false;
}

setInterval(poll, 1000);
poll();
