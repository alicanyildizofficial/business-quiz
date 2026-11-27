# Business Quiz

Canlı quiz motoru — **The Business Partner AI**. Kahoot'un stand etkinliği için gereken kısmı: oda, PIN, senkron soru, hız bonuslu puanlama, canlı leaderboard, lead toplama.

**Sıfır bağımlılık.** `npm install` yok, build adımı yok, `node_modules` yok. Sadece Node 18+ ve dört dosya.

---

## Neden WebSocket yok

80 katılımcı × saniyede 1 istek = 80 rps. Tek bir Node instance için önemsiz bir yük.

Polling'in asıl kazancı performans değil, **dayanıklılık**: istemci stateless. Telefon kilitlenir, tarayıcı arka plana düşer, 4.5G ile Wi-Fi arasında geçer — hiçbiri önemli değil. Sonraki istekte sunucudaki duruma olduğu gibi döner. WebSocket'te "reconnect state recovery" diye uğraşılan sınıf problem burada hiç doğmuyor.

Süreyi **sunucu** ölçer; istemcinin saatine güvenilmez. Hile ve saat kayması böylece kapanır.

---

## Hızlı başlangıç (yerel)

```bash
HOST_KEY=test node server.js
```

| Ekran | Adres |
|---|---|
| Oyuncu | http://localhost:3000/ |
| Host | http://localhost:3000/host?key=test |

PIN sunucu açılırken konsola yazılır. Host ekranında da büyük puntoyla durur.

### Prova

```bash
HOST_KEY=test node test.js
```

40 kontrol: yetkilendirme, eşzamanlı katılım, doğru cevabın sızmaması, çift cevap reddi, hız bonusu, kopma senaryosu, bayat komut koruması, KVKK onayı, CSV, dizin geçişi. Sunucu ayakta olmalı.

```bash
PLAYERS=50 HOST_KEY=test node test.js   # daha ağır yük
```

---

## Coolify'de yayına alma

Quiz **ayrı bir proje** olarak kurulur; links.business'ın compose'una, env'ine, container'ına dokunulmaz.

1. **Yeni proje** → Coolify'de `business-quiz`.
2. **Kaynak:** bu klasör (Git veya doğrudan Dockerfile). Build pack: **Dockerfile**.
3. **Port:** 3000.
4. **Ortam değişkenleri:**
   | Değişken | Değer |
   |---|---|
   | `HOST_KEY` | Uzun, tahmin edilemez bir dize. **Bu anahtar host ekranının tek kilidi.** |
   | `PORT` | 3000 |
   | `DATA_DIR` | /app/data |
5. **Kalıcı volume:** `/app/data` → oyun snapshot'ı burada. Container yeniden başlasa oyun kaldığı yerden döner.
6. **Bellek limiti: 512 MB.** Aynı sunucuyu production ile paylaştığımız için tek gerçek risk, buradaki olası bir sızıntının host RAM'ini yiyip production container'ını OOM'a sokmasıdır. Limit bunu kapatır.
7. **Domain:** `planpartner.tech`.

### DNS — bugünün tek zamanlama riski

**Cloudflare'e eklemeyin.** Yeni zone açmak nameserver değişikliği demek; yayılması 1–24 saat sürebilir ve etkinlik bugün.

Domain hangi DNS sağlayıcısındaysa orada kalsın, tek bir **A kaydı** sunucunun IP'sine baksın. Coolify Let's Encrypt sertifikasını kendi alır. Yayılma tipik olarak 1–5 dakika.

Böylece links.business zone'undaki rate-limit kuralı (IP başına 10 istek/10 sn, POST `/api/*`) ve Bot Fight Mode devreye hiç girmez — o kurallar zone bazlıdır, `planpartner.tech` ayrı bir zone'dur. Production'ın güvenlik yapılandırmasına dokunmak gerekmez.

> **Etkinlikten sonra iki iş var:**
> 1. A kaydını silin (ya da acele etmeden Cloudflare'e taşıyın). Proxy'siz kayıt, sunucunun gerçek IP'sini gösterir — ve bu, links.business'ın da üzerinde olduğu sunucudur.
> 2. Origin firewall'ın yalnız Cloudflare IP aralıklarına açık olup olmadığını doğrulayın. `CLOUDFLARE_AUDIT_2026-08-27.md` §5.2'de **açık soru** olarak duruyor.

---

## Etkinlik günü

### Hazırlık (açılıştan ~45 dk önce)

- [ ] Host ekranını aç: `https://planpartner.tech/host?key=...` — sekmeyi kapatma, PIN orada.
- [ ] **Mobil veri provası:** en az 2 telefon, **Wi-Fi kapalı**, mümkünse farklı operatörler. Sahada herkes kendi verisinden girecek; ofis Wi-Fi'siyle test gerçeği göstermez.
- [ ] **Kopma provası:** oyun ortasında bir telefonu uçak moduna al, 20 sn bekle, geri aç. Soru ve skor doğru mu?
- [ ] Bir tam oyun oynat, süreyi ölç → standda kaç tur döneceğini bil.
- [ ] Prova bitince **Yeni oyun**'a bas (puanlar sıfırlanır, toplanan lead'ler korunur).
- [ ] QR'ı bastır: `https://planpartner.tech`. Yedek kopya bulundur.
- [ ] Host laptopuna yedek bağlantı (hotspot veya kablo), şarj aleti.

### Akış

Host ekranında **tek buton** her şeyi yönetir. `Boşluk` veya `→` tuşu da aynı işi yapar — laptopa bakmadan ilerletebilirsin.

```
Lobi  →  [Yarışmayı başlat]
Soru  →  [Sonucu göster]        (süre dolunca kendiliğinden de geçer)
Sonuç →  [Sonraki soru]
...12 soru...
Final →  podyum + CSV indir
```

Süre dolup faz kendiliğinden `reveal`'a geçtiği anda basılan tuş **soruyu atlamaz**: host'un baktığı ekran güncel değilse komut sunucuda yutulur.

### Vazgeçme eşiği

Standda ilk turda oyun tutmazsa tartışmadan Kahoot PIN'ine geç. Kararı kimin vereceği önceden belli olsun.

---

## Soruları değiştirme

`questions.json` — 12 soru. Her biri:

```json
{
  "text": "Soru metni",
  "choices": ["A", "B", "C", "D"],
  "correct": 0,
  "seconds": 20,
  "note": "Sonuç ekranında görünen kısa açıklama."
}
```

`correct` sıfırdan başlar. Dört şık olmalı. Değişiklikten sonra container yeniden başlatılır.

---

## Lead'ler

Oyun sonunda isteğe bağlı: e-posta / telefon / şirket. Onay kutusu **işaretsiz gelir** ve işaretlenmeden kayıt yapılmaz — hem arayüzde hem sunucuda kontrol edilir.

İndirme: host ekranında **Lead'leri CSV indir**, ya da

```
https://planpartner.tech/api/host/leads.csv?key=...
```

CSV, Excel'in Türkçe karakterleri doğru açması için BOM ile başlar. Aynı oyuncu formu iki kez gönderirse kayıt güncellenir, kopyalanmaz.

**Etkinlikten sonra:** CSV'yi indir ve güvenli yere al. Veriler container volume'ünde `state.json` içinde duruyor; production veritabanına tek satır yazılmıyor.

---

## Yapmadıklarımız (bilinçli)

Takım modu · resimli/videolu soru · müzik · admin paneli · çoklu eşzamanlı etkinlik · oyuncu hesabı · soru düzenleme arayüzü · yatay ölçekleme.

Tek etkinlik için kapsam bilerek donduruldu. Sahadan çıkan veriyle links.business'a native **"Canlı Quiz & Oylama"** modülü yazılacak; bu kod onun prototipi, olduğu gibi taşınmaz.

---

## Sorun giderme

| Belirti | Bak |
|---|---|
| Host ekranı "anahtar geçersiz" | URL'deki `key`, `HOST_KEY` ile birebir aynı mı |
| Oyuncu "PIN hatalı" diyor | Host ekranındaki güncel PIN mi girildi; **Yeni oyun** PIN'i değiştirir |
| Oyun sıfırlandı, herkes düştü | Container yeniden başladı ve `/app/data` volume'ü bağlı değil |
| Cevaplar sayılmıyor | Soru fazı bitmiş olabilir; host ekranındaki "cevaplayan" sayacına bak |
| Sertifika yok | DNS A kaydı yayıldı mı: `nslookup planpartner.tech` |

Sağlık ucu: `GET /api/health` → `{"ok":true,"phase":"..."}`
