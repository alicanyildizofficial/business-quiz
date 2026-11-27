'use strict';

const GLYPHS = ['▲', '◆', '●', '■']; // ▲ ◆ ● ■
const $ = (id) => document.getElementById(id);

let playerId = localStorage.getItem('bq_player') || null;
let lastPhase = null;
let lastQIndex = -1;
let answering = false;

// Sunucudan gelen kalan süreyi istemcide yumuşatmak için
let localDeadline = 0;
let localDuration = 20000;

function show(name) {
  for (const el of document.querySelectorAll('.screen')) el.classList.remove('active');
  const target = $('s-' + name);
  if (target) target.classList.add('active');
}

// ------------------------------------------------------------- katılım ----

async function join() {
  const pin = $('pin').value.replace(/\D/g, '');
  const name = $('name').value.trim();
  const err = $('join-err');
  err.textContent = '';

  if (pin.length !== 6) { err.textContent = 'PIN 6 haneli olmalı.'; return; }
  if (!name) { err.textContent = 'Bir ad yaz.'; return; }

  const btn = $('join-btn');
  btn.disabled = true;
  btn.textContent = 'Katılıyor…';

  try {
    const res = await fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Katılamadık');
    playerId = data.playerId;
    localStorage.setItem('bq_player', playerId);
    localStorage.setItem('bq_name', data.name);
    poll();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Katıl';
  }
}

$('join-btn').addEventListener('click', join);
$('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
$('pin').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  if (e.target.value.length === 6) $('name').focus();
});

// --------------------------------------------------------------- cevap ----

async function answer(choice) {
  if (answering) return;
  answering = true;

  // İyimser arayüz: beklemeden geri bildirim ver.
  for (const b of document.querySelectorAll('#q-choices .choice')) {
    b.disabled = true;
    if (Number(b.dataset.i) === choice) b.classList.add('picked');
    else b.classList.add('dim');
  }

  try {
    await fetch('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, qIndex: lastQIndex, choice }),
    });
  } catch (_) {
    /* poll bir sonraki turda düzeltir */
  }
  answering = false;
  poll();
}

function renderChoices(choices, myChoice, correct) {
  const box = $('q-choices');
  box.innerHTML = '';
  choices.forEach((text, i) => {
    const b = document.createElement('button');
    b.className = 'choice';
    b.dataset.i = String(i);
    b.innerHTML = '<span class="glyph">' + GLYPHS[i] + '</span><span></span>';
    b.lastChild.textContent = text;

    if (correct != null) {
      b.disabled = true;
      if (i === correct) b.classList.add('right');
      else b.classList.add('dim');
      if (i === myChoice) b.classList.add('picked');
    } else if (myChoice != null) {
      b.disabled = true;
      if (i === myChoice) b.classList.add('picked');
      else b.classList.add('dim');
    } else {
      b.addEventListener('click', () => answer(i));
    }
    box.appendChild(b);
  });
}

// ---------------------------------------------------------------- timer ----

function tickTimer() {
  if (!localDeadline) return;
  const left = Math.max(0, localDeadline - Date.now());
  $('q-left').textContent = String(Math.ceil(left / 1000));
  $('q-fill').style.width = (left / localDuration) * 100 + '%';
}
setInterval(tickTimer, 100);

// --------------------------------------------------------------- render ----

function render(s) {
  // Sunucu sıfırlandıysa oyuncu kimliği geçersizdir.
  if (playerId && s.known === false) {
    localStorage.removeItem('bq_player');
    playerId = null;
    show('join');
    $('join-err').textContent = 'Oyun yeniden başlatıldı, tekrar katıl.';
    return;
  }
  if (!playerId) { show('join'); return; }

  const me = s.me || { score: 0, rank: null };
  const rank = me.rank ? '#' + me.rank : '-';

  if (s.phase === 'lobby') {
    $('lobby-name').textContent = (localStorage.getItem('bq_name') || '') + ', seni listeye aldık.';
    $('lobby-count').textContent = s.playerCount;
    show('lobby');
  } else if (s.phase === 'question' && s.question) {
    const changed = s.qIndex !== lastQIndex || lastPhase !== 'question';
    lastQIndex = s.qIndex;

    localDuration = s.question.durationMs;
    localDeadline = Date.now() + s.question.remainingMs;

    if (s.answered) {
      $('w-score').textContent = me.score;
      $('w-rank').textContent = rank;
      show('waiting');
    } else {
      if (changed) {
        $('q-text').textContent = s.question.text;
        $('q-pos').textContent = 'Soru ' + (s.qIndex + 1) + '/' + s.total;
        renderChoices(s.question.choices, null, null);
      }
      tickTimer();
      show('question');
    }
  } else if (s.phase === 'reveal' && s.question) {
    lastQIndex = s.qIndex;
    localDeadline = 0;

    const ok = s.wasCorrect;
    const v = $('r-verdict');
    v.textContent = s.answered ? (ok ? 'Doğru' : 'Yanlış') : 'Cevap yok';
    v.className = 'verdict ' + (ok ? 'ok' : 'no');
    $('r-gained').textContent = ok ? '+' + s.gained : '+0';
    $('r-correct').textContent = 'Doğru cevap: ' + s.question.choices[s.correct];
    $('r-score').textContent = me.score;
    $('r-rank').textContent = rank;
    $('r-note').textContent = s.note || '';
    show('reveal');
  } else if (s.phase === 'final') {
    $('f-score').textContent = me.score;
    $('f-rank').textContent = rank;

    const ul = $('f-podium');
    ul.innerHTML = '';
    (s.podium || []).forEach((p, i) => {
      const li = document.createElement('li');
      if (i === 0) li.classList.add('gold');
      if (p.name === localStorage.getItem('bq_name')) li.classList.add('me');
      const pos = document.createElement('span'); pos.className = 'pos'; pos.textContent = i + 1;
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name;
      const sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = p.score;
      li.append(pos, nm, sc);
      ul.appendChild(li);
    });

    if (s.leadSubmitted) {
      $('lead-card').style.display = 'none';
      $('lead-done').style.display = 'block';
    }
    show('final');
  }

  lastPhase = s.phase;
}

// ----------------------------------------------------------------- lead ----

$('lead-btn').addEventListener('click', async () => {
  const err = $('lead-err');
  err.textContent = '';
  const email = $('l-email').value.trim();
  const phone = $('l-phone').value.trim();

  if (!email && !phone) { err.textContent = 'E-posta ya da telefon yaz.'; return; }
  if (!$('l-consent').checked) { err.textContent = 'Devam etmek için onay kutusunu işaretle.'; return; }

  const btn = $('lead-btn');
  btn.disabled = true;
  btn.textContent = 'Gönderiliyor…';
  try {
    const res = await fetch('/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId, email, phone,
        company: $('l-company').value.trim(),
        consent: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gönderilemedi');
    $('lead-card').style.display = 'none';
    $('lead-done').style.display = 'block';
  } catch (e) {
    err.textContent = e.message;
    btn.disabled = false;
    btn.textContent = 'Gönder';
  }
});

// ----------------------------------------------------------------- poll ----

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const res = await fetch('/api/state?pid=' + encodeURIComponent(playerId || ''), { cache: 'no-store' });
    if (res.ok) render(await res.json());
  } catch (_) {
    /* ağ kesintisi: bir sonraki tur yeniden dener */
  }
  polling = false;
}

setInterval(poll, 1000);
// Telefon uykudan dönünce beklemeden tazele
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

if (playerId) poll(); else show('join');
