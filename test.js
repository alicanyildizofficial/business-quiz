'use strict';

/**
 * Tam oyun provası — sunucu ayaktayken çalıştır:
 *   node server.js            (ayrı pencerede, HOST_KEY=test ile)
 *   HOST_KEY=test node test.js
 *
 * Planın §4 kabul kriterlerini otomatik kontrol eder.
 */

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const KEY = process.env.HOST_KEY || 'test';
const PLAYERS = Number(process.env.PLAYERS) || 20;

let pass = 0;
let fail = 0;

let quietFails = 0;
function check2(cond, msg) {
  if (!cond) { quietFails++; if (quietFails < 5) console.log('  ✗ ' + msg); }
}

function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}

const api = async (p, opts) => {
  const res = await fetch(BASE + p, opts);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = text; }
  return { status: res.status, body };
};
const host = (p, opts) => api(p + (p.includes('?') ? '&' : '?') + 'key=' + KEY, opts);
const post = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  console.log('\nBusiness Quiz — tam oyun provası (%d oyuncu)\n', PLAYERS);

  // --- hazırlık -------------------------------------------------------
  await host('/api/host/action', post({ action: 'reset' }));
  let h = (await host('/api/host/state')).body;
  const pin = h.pin;
  // reset leadleri bilerek korur (etkinlikte birden fazla tur dönecek),
  // bu yüzden lead sayımı mutlak değil fark olarak doğrulanır.
  const leadBase = h.leadCount;
  console.log('PIN: %s · %d soru\n', pin, h.total);

  console.log('1) Yetkilendirme');
  check('host state anahtarsız reddediliyor', (await api('/api/host/state')).status === 403);
  check('yanlış anahtar reddediliyor', (await api('/api/host/state?key=yanlis')).status === 403);
  check('doğru anahtar kabul ediliyor', (await host('/api/host/state')).status === 200);

  console.log('\n2) Katılım');
  check('yanlış PIN reddediliyor', (await api('/api/join', post({ pin: '000000', name: 'X' }))).status === 400);
  check('isimsiz katılım reddediliyor', (await api('/api/join', post({ pin, name: '  ' }))).status === 400);

  const ids = [];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: PLAYERS }, async (_, i) => {
      const r = await api('/api/join', post({ pin, name: 'Oyuncu' + (i + 1) }));
      if (r.status === 200) ids.push(r.body.playerId);
    })
  );
  check(PLAYERS + ' oyuncu katıldı', ids.length === PLAYERS, ids.length + ' katıldı');
  check('eşzamanlı katılım < 2 sn', Date.now() - t0 < 2000, (Date.now() - t0) + 'ms');

  h = (await host('/api/host/state')).body;
  check('host oyuncu sayısını doğru görüyor', h.playerCount === PLAYERS, String(h.playerCount));

  console.log('\n3) Lobide soru sızmıyor');
  let ps = (await api('/api/state?pid=' + ids[0])).body;
  check('lobide soru gönderilmiyor', ps.question === undefined);
  check('oyuncu tanınıyor', ps.known === true);

  console.log('\n4) Oyun akışı');
  await host('/api/host/action', post({ action: 'next' })); // ilk soru
  ps = (await api('/api/state?pid=' + ids[0])).body;
  check('soru fazına geçildi', ps.phase === 'question');
  check('şıklar geldi', ps.question && ps.question.choices.length === 4);
  check('DOĞRU CEVAP SIZMIYOR', ps.correct === undefined);

  // Herkes cevaplasın: yarısı doğru, yarısı yanlış
  const q0 = (await host('/api/host/state')).body.question;
  const qfile = JSON.parse(require('fs').readFileSync(__dirname + '/questions.json', 'utf8'));
  const firstRound = Array.isArray(qfile) ? qfile : qfile.rounds[0].questions;
  const correctIdx = firstRound[0].correct;
  await Promise.all(
    ids.map((id, i) =>
      api('/api/answer', post({ playerId: id, qIndex: 0, choice: i % 2 === 0 ? correctIdx : (correctIdx + 1) % 4 }))
    )
  );

  h = (await host('/api/host/state')).body;
  check('tüm cevaplar sayıldı', h.question.answered === PLAYERS, String(h.question.answered));

  const dup = await api('/api/answer', post({ playerId: ids[0], qIndex: 0, choice: 0 }));
  check('ikinci cevap reddediliyor', dup.status === 409);
  const bad = await api('/api/answer', post({ playerId: ids[1], qIndex: 5, choice: 0 }));
  check('yanlış soru indeksi reddediliyor', bad.status === 409);
  const noplayer = await api('/api/answer', post({ playerId: 'sahte', qIndex: 0, choice: 0 }));
  check('bilinmeyen oyuncu reddediliyor', noplayer.status === 400);

  console.log('\n5) Sonuç ekranı');
  await host('/api/host/action', post({ action: 'reveal' }));
  ps = (await api('/api/state?pid=' + ids[0])).body;
  check('reveal fazında doğru cevap geliyor', ps.correct === correctIdx);
  check('doğru cevaplayan puan aldı', ps.gained > 0, 'puan=' + ps.gained);
  check('hız bonusu çalışıyor (puan < 1000)', ps.gained <= 1000 && ps.gained > 500, String(ps.gained));

  const wrong = (await api('/api/state?pid=' + ids[1])).body;
  check('yanlış cevaplayan 0 puan aldı', wrong.gained === 0);

  h = (await host('/api/host/state')).body;
  const sum = h.question.counts.reduce((a, b) => a + b, 0);
  check('cevap dağılımı tutarlı', sum === PLAYERS, sum + '/' + PLAYERS);
  check('leaderboard sıralı', h.leaderboard.every((p, i, a) => i === 0 || a[i - 1].score >= p.score));

  console.log('\n6) Kopma simülasyonu');
  // "Telefon uykuda" — hiçbir istek atmayan oyuncu sonraki soruyu kaçırır,
  // ama geri döndüğünde doğru duruma düşmeli.
  await host('/api/host/action', post({ action: 'next' }));
  const back = (await api('/api/state?pid=' + ids[2])).body;
  check('dönen oyuncu doğru soruda', back.qIndex === 1 && back.phase === 'question');
  check('dönen oyuncunun skoru korundu', back.me.score > 0, 'skor=' + back.me.score);
  check('sırası hesaplanıyor', typeof back.me.rank === 'number');

  console.log('\n6b) Bayat komut koruması (soru atlama)');
  {
    let st = (await host('/api/host/state')).body;
    const idx = st.qIndex;
    // Host "question" ekranına bakarken basıyor → reveal olmalı
    await host('/api/host/action', post({ action: 'advance', seenPhase: 'question', seenIndex: idx }));
    st = (await host('/api/host/state')).body;
    check('güncel komut reveal yapıyor', st.phase === 'reveal' && st.qIndex === idx, st.phase + '/' + st.qIndex);

    // Aynı tuş yine, ama host hâlâ "question" gördüğünü sanıyor (bayat komut)
    await host('/api/host/action', post({ action: 'advance', seenPhase: 'question', seenIndex: idx }));
    st = (await host('/api/host/state')).body;
    check('BAYAT KOMUT SORUYU ATLAMIYOR', st.phase === 'reveal' && st.qIndex === idx, st.phase + '/' + st.qIndex);

    // Host artık reveal gördüğünü bildiriyor → ara sıralamaya geçmeli
    await host('/api/host/action', post({ action: 'advance', seenPhase: 'reveal', seenIndex: idx }));
    st = (await host('/api/host/state')).body;
    check('reveal sonrası ara sıralama geliyor', st.phase === 'scoreboard', st.phase);

    // Ara sıralamadan sonra sıradaki soru
    await host('/api/host/action', post({ action: 'advance', seenPhase: 'scoreboard', seenIndex: idx }));
    st = (await host('/api/host/state')).body;
    check('ara sıralamadan sonraki soruya geçiliyor', st.qIndex === idx + 1, 'q=' + st.qIndex);
  }

  console.log('\n7) Sona kadar');
  let guard = 0;
  while (guard++ < 40) {
    const st = (await host('/api/host/state')).body;
    if (st.phase === 'final') break;
    await host('/api/host/action', post({ action: st.phase === 'question' ? 'reveal' : 'next' }));
    await new Promise((r) => setTimeout(r, 60));
  }
  h = (await host('/api/host/state')).body;
  check('final fazına ulaşıldı', h.phase === 'final');
  check('podyum dolu', h.leaderboard.length > 0);

  console.log('\n8) Lead + KVKK');
  const noConsent = await api('/api/lead', post({ playerId: ids[0], email: 'a@b.com', consent: false }));
  check('onaysız lead reddediliyor', noConsent.status === 400);
  const empty = await api('/api/lead', post({ playerId: ids[0], consent: true }));
  check('boş lead reddediliyor', empty.status === 400);
  const ok = await api('/api/lead', post({ playerId: ids[0], email: 'test@ornek.com', company: 'Örnek A.Ş.', consent: true }));
  check('geçerli lead kabul ediliyor', ok.status === 200);
  await api('/api/lead', post({ playerId: ids[1], phone: '05551112233', consent: true }));
  await api('/api/lead', post({ playerId: ids[0], email: 'yeni@ornek.com', consent: true }));

  h = (await host('/api/host/state')).body;
  check('aynı oyuncu lead kopyalamıyor', h.leadCount - leadBase === 2, 'fark=' + (h.leadCount - leadBase));
  check('önceki turun leadleri korundu', h.leadCount >= leadBase);

  const csv = await host('/api/host/leads.csv');
  check('CSV indiriliyor', typeof csv.body === 'string' && csv.body.includes('yeni@ornek.com'));
  // fetch().text() BOM'u spec gereği kırpar; ham baytlara bakmak gerekir.
  const rawCsv = new Uint8Array(
    await (await fetch(BASE + '/api/host/leads.csv?key=' + KEY)).arrayBuffer()
  ).slice(0, 3);
  check(
    'CSV Excel için BOM taşıyor',
    rawCsv[0] === 0xef && rawCsv[1] === 0xbb && rawCsv[2] === 0xbf,
    Array.from(rawCsv).map((b) => b.toString(16)).join(' ')
  );

  console.log('\n9) Soru havuzu');
  {
    // Şikayet buydu: doğru cevap her soruda aynı şıkta çıkıyordu.
    const spread = [0, 0, 0, 0];
    let total = 0;
    let worstRun = 0;
    for (const r of qfile.rounds) {
      let run = 0;
      let prev = -1;
      for (const q of r.questions) {
        check2(q.choices.length === 4, '4 şık değil: ' + q.text);
        check2(new Set(q.choices).size === 4, 'tekrarlı şık: ' + q.text);
        check2(q.correct >= 0 && q.correct < 4, 'geçersiz correct: ' + q.text);
        spread[q.correct]++;
        total++;
        run = q.correct === prev ? run + 1 : 1;
        prev = q.correct;
        if (run > worstRun) worstRun = run;
      }
    }
    check('soru havuzu tutarlı (4 benzersiz şık, geçerli indeks)', quietFails === 0, quietFails + ' sorun');
    check(
      'DOĞRU CEVAPLAR TEK ŞIKTA YIĞILMIYOR',
      Math.max.apply(null, spread) <= Math.ceil(total / 4),
      JSON.stringify(spread)
    );
    check('her şık en az bir kez doğru', spread.every((n) => n > 0), JSON.stringify(spread));
    check('aynı konum 3 soru üst üste tekrarlamıyor', worstRun < 3, 'en uzun seri=' + worstRun);
  }

  console.log('\n10) Güvenlik');
  check('dizin dışına çıkılamıyor', (await api('/../server.js')).status === 404);
  check('bilinmeyen api 404', (await api('/api/yok')).status === 404);

  console.log('\n%s  %d geçti, %d kaldı\n', fail === 0 ? 'TAMAMI GEÇTİ' : 'BAŞARISIZ', pass, fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\nProva çöktü:', e.message);
  console.error('Sunucu ayakta mı?  HOST_KEY=test node server.js');
  process.exit(1);
});
