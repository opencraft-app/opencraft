

## Ringkasan

**`USER.md` dan `MEMORY.md` adalah dua buku catatan pribadi di balik memori jangka panjang Hermes Agent, dan tiga batasan keras menjelaskan mengapa keduanya tidak dapat digabungkan. Pertama, kapasitasnya independen (`USER.md` sekitar 1.375 karakter / 500 token; `MEMORY.md` sekitar 2.200 karakter / 800 token), sehingga tidak ada yang menggerus yang lain. Kedua, semantik pemuatannya berbeda: keduanya dimuat pada setiap sesi, tetapi perannya benar-benar berlainan — yang satu secara stabil menjelaskan "siapa Anda", yang lain sering mencatat "apa yang sudah kita kerjakan". Ketiga, semantik pembaruannya berbeda: kolom preferensi di `USER.md` umumnya menimpa nilai lama, sementara `MEMORY.md` umumnya menambahkan lalu mengonsolidasikan sesuai kebutuhan. Menggabungkan keduanya menjadi satu `NOTES.md` akan melanggar ketiga batasan itu sekaligus — contoh klasik "tampak lebih sederhana, bekerja lebih buruk".**

---

## Sebuah pertanyaan yang wajar untuk memulai

Di seluruh memori berlapis Hermes, `USER.md` dan `MEMORY.md` hanya berjumlah **~3.575 karakter / ~1.300 token** — sangat berhemat di era context window enam digit.

Karena itu reaksi pertama sebagian besar orang adalah tiga pertanyaan:

- Mengapa tidak digabungkan menjadi satu `NOTES.md`?
- Mengapa tidak diperbesar sampai puluhan kilobyte?
- Mengapa kedua file itu bahkan punya batas berbeda (2.200 vs 1.375)?

Ketiganya mengarah ke jawaban yang sama: **`USER.md` dan `MEMORY.md` adalah dua jenis memori yang berbeda, dan menjejalkannya bersama membuat keduanya memburuk.** Di bawah ini, prinsip desain tersebut dibongkar dalam tiga lapisan.

---

## 1. `USER.md`: profil pengguna yang stabil dan terstruktur

`USER.md` adalah **deskripsi stabil tentang Anda**:

- Identitas: nama, peran, lokasi.
- Preferensi: gaya komunikasi, tech stack yang biasa dipakai.
- Batasan: jadwal, bahasa, topik yang perlu dihindari.
- Gaya kerja: kesimpulan dulu, atau prosesnya dulu.
- Tujuan jangka panjang: apa yang sedang Anda upayakan.

**Karakteristik kuncinya**:

- **Stabil**: diperbarui sekali dalam beberapa hari atau minggu.
- **Terstruktur**: berbagian, berbutir, berbasis kolom.
- **Selalu dimuat**: disuntikkan ke system prompt di awal setiap sesi.
- **Batas keras**: ~1.375 karakter / ~500 token.

Anggap `USER.md` sebagai **catatan tempel di bingkai monitor agent** — isinya tidak banyak, tetapi selalu terlihat dan selalu berguna.

---

## 2. `MEMORY.md`: arsip faktual yang tumbuh dan dipanggil sesuai kebutuhan

`MEMORY.md` menyimpan **apa yang sudah Anda dan agent kerjakan bersama**:

- Status proyek: frontend agent-demo berjalan di port dev lokal.
- Keputusan: pekan lalu bagian hero diubah menjadi gradien beranimasi.
- Peristiwa spesifik: disepakati dengan tim A bahwa X dirilis di Q4.
- Pengetahuan spesifik: API ini melakukan autentikasi melalui SDK internal, bukan endpoint publik.

**Karakteristik kuncinya**:

- **Dinamis**: nyaris setiap sesi bermakna menuliskan satu atau dua entri.
- **Berbutir**: ditambahkan entri per entri agar mudah dipanggil kembali.
- **Selalu dimuat plus pencocokan FTS5 sesuai kebutuhan**: entri umum dimuat setiap sesi, entri historis ditarik masuk lewat pencocokan FTS5.
- **Biasanya 8–15 entri**: target 8–15 entri dengan total ~2.200 karakter / ~800 token.

Anggap `MEMORY.md` sebagai **jurnal di atas meja Anda** — lebih banyak dari catatan tempel, tetapi tetap ditulis hemat agar cepat dibaca sekilas.

---

## 3. "Mengapa tidak digabungkan menjadi satu NOTES.md?" — tiga batasan keras

Selalu ada yang bertanya: keduanya sama-sama Markdown yang dimuat setiap sesi, jadi mengapa tidak digabungkan?

Berikut tiga batasan kerasnya, masing-masing cukup kuat secara mandiri untuk menenggelamkan ide tersebut.

### Batasan 1: kapasitas independen, tanpa saling menggerus

`USER.md` mendapat 500 token, `MEMORY.md` mendapat 800. Setelah digabungkan, satu `NOTES.md` berukuran 1.300 token langsung menghadapi masalah: **ketika memori nyaris penuh, apakah agent menghapus satu baris tentang "siapa penggunanya" demi mencatat satu peristiwa tambahan?**

Jelas ia **tidak seharusnya** melakukan itu — tetapi begitu digabungkan, keputusan itu harus diambil, dan diambil **pada setiap penulisan**. Dengan dipisah, kedua kantong berkembang secara independen: ketika `MEMORY.md` penuh, ia hanya menggerus dirinya sendiri dan tidak pernah mencemari profil.

### Batasan 2: semantik pemuatan yang berbeda

Kedua file itu memang benar **dimuat pada setiap sesi**, tetapi perannya di dalam system prompt benar-benar berbeda:

- Bagian `USER.md` menjawab "**Anda sedang berhadapan dengan siapa**", menetapkan nada agent, tingkat kedetailan, dan asumsi stack.
- Bagian `MEMORY.md` menjawab "**apa yang sudah Anda kerjakan bersama**", memberi agent pegangan faktual.

Jika digabungkan, keduanya akan **saling mengencerkan** — agent tidak lagi dapat cepat membedakan "apakah ini gaya komunikasi yang wajib saya ikuti, atau fakta masa lalu yang seharusnya saya kutip?"

### Batasan 3: semantik pembaruan yang berbeda

- **Kolom preferensi di `USER.md` umumnya menimpa**: ketika pengguna berkata "berhenti merangkum mulai sekarang", baris preferensi terkait langsung ditimpa.
- **`MEMORY.md` umumnya menambahkan lalu mengonsolidasikan sesuai kebutuhan**: peristiwa adalah rangkaian waktu, sehingga riwayat tidak boleh dihapus sembarangan. Ketika kapasitas penuh, respons error berikut memicu konsolidasi aktif:

```json
{
  "success": false,
  "error": "Memory at 2,100/2,200 chars. Consolidate now...",
  "current_entries": [...],
  "usage": "2,100/2,200"
}
```

Setelah digabungkan, `add / replace / remove` semuanya harus hidup berdampingan pada file yang sama, membuat implementasi **dan** model mental pengguna **memburuk sekaligus**.

---

## 4. Sebuah contoh konkret

Misalkan Anda berkata kepada agent:

> "Saya Jasmin, seorang frontend engineer, dan saya menyukai komunikasi yang mengutamakan kesimpulan. Saya sedang mengerjakan situs global untuk agent-demo (sebuah aplikasi AI agent) dengan Next.js. Pekan lalu kami mengubah bagian hero menjadi gradien beranimasi."

Hermes Agent yang terlatih baik akan memecahnya seperti berikut:

**Ditulis ke `USER.md`**:

```md
## Identity
- Name: Jasmin
- Role: Frontend engineer

## Preferences
- Communication style: conclusion first
- Usual stack: Next.js
```

**Ditulis ke `MEMORY.md`**:

```md
- [2026-07-30] agent-demo: bagian hero di situs global diubah menjadi gradien beranimasi.
- Proyek terkait: agent-demo / situs global (region global)
```

Lihat perbedaannya?

- "Anda ini orang seperti apa" masuk ke profil; "apa yang kita kerjakan bersama" masuk ke arsip.
- Yang pertama hanya berubah ketika **Anda** berubah (pekerjaan baru, tim baru); yang kedua tumbuh bersama **setiap hari percakapan**.
- **File yang terpisah itulah yang memungkinkan masing-masing berkembang sendiri.**

---

## 5. Daftar lima hal yang dilewati

Hermes tidak mendorong segalanya ke `USER.md`. Ia memelihara sebuah **daftar hal yang dilewati**:

1. **Suasana hati sesaat**: "kepala saya sakit hari ini" — bukan atribut yang stabil.
2. **Parameter tugas sementara**: "ubah judul ini menjadi X untuk saya" — sekali pakai.
3. **Sikap yang samar**: "sepertinya saya lebih suka hal yang agak lebih ringkas" — kurang dapat dipakai ulang (perjelas dulu, atau lewati).
4. **Apa pun yang dapat disimpulkan dari konteks percakapan yang sedang berjalan** — tidak perlu dipertahankan.
5. **Informasi sensitif** (email, kata sandi, alamat yang tidak dikonfirmasi eksplisit oleh pengguna) — konten terkait privasi tidak ditulis secara default.

Daftar hal yang dilewati itulah yang menjaga `USER.md` tetap "500 token dengan kerapatan tinggi".

---

## 6. Apa artinya ini bagi produk

Bagi sebuah produk agent, pemisahan antara `USER.md` dan `MEMORY.md` bukan sekadar detail rekayasa. Ia menentukan tiga hal:

1. **Apakah Anda dapat menunjukkan kepada pengguna "apa yang saya pikirkan tentang Anda"** — itu memerlukan profil yang stabil, dapat dibaca, dan dapat disunting (semantik `USER.md`).
2. **Apakah agent dapat menghindari amnesia dalam jangka panjang** — itu memerlukan arsip faktual yang tumbuh dan dapat dipanggil kembali (semantik `MEMORY.md`).
3. **Apakah biaya tetap terbatas** — hanya pemuatan berlapis yang dapat sekaligus "tahu siapa Anda" dan menghindari menghabiskan seluruh konteks.

---

## 7. LightVela: menjadikan kedua buku besar ini sebuah produk

Desain memori agent internal LightVela meminjam tepat pemikiran berlapis ini. `USER.md` dan `MEMORY.md` milik Hermes adalah file Markdown yang ditulis untuk developer; LightVela mengubahnya menjadi dua hal yang dapat dioperasikan langsung oleh pengguna biasa:

- **Lapisan profil yang terlihat**: pengguna dapat melihat fakta profil mana yang diingat agent dan berasal dari percakapan yang mana, lalu mengoreksinya dengan satu klik. Profil bukan lagi `USER.md` yang berupa kotak hitam.
- **Lapisan fakta yang dapat ditata**: memori faktual lebih dari sekadar tumpukan entri — ia dapat ditandai berdasarkan proyek, tugas, atau waktu agar lebih mudah dipanggil kembali dan dibersihkan. Dalam skenario tim, memori tim dan memori pribadi dapat dikelola sebagai lapisan terpisah.
- **Jalur terpendek**: jika gagasan memori berlapis ini menarik bagi Anda tetapi Anda enggan menyunting `~/.hermes/USER.md`, memelihara FTS5, dan mem-backup SQLite sendiri, LightVela adalah jalur terpendek menuju gagasan tersebut dalam bentuk produk siap pakai.

Dalam satu baris: **Hermes menyediakan blueprint rekayasa untuk memori berlapis, dan LightVela mengubahnya menjadi pengalaman produk yang dapat dipakai siapa pun.**

---

## Poin penting

- `USER.md`: **profil pengguna** yang stabil dan terstruktur, dimuat setiap sesi (~500 token, 8–15 kolom profil).
- `MEMORY.md`: **arsip faktual** yang tumbuh dan dipanggil sesuai kebutuhan (~800 token, 8–15 entri peristiwa).
- Tiga batasan keras memisahkan keduanya: **kapasitas independen / semantik pemuatan berbeda / semantik pembaruan berbeda.**
- Pelapisan adalah kemampuan fondasional bagi memori agent yang baik, dan titik awal produktisasi memori di LightVela.
