

## Ringkasan

**Memory dan Skill keduanya adalah memori jangka panjang, tetapi keduanya berbeda secara fundamental. Memory adalah memori deklaratif: ia menyimpan fakta, peristiwa, kesimpulan, dan preferensi sebagai entri singkat, lalu dipanggil kembali ketika sebuah kueri cocok (`MEMORY.md` + `memories/`). Skill adalah memori prosedural: ia menyimpan SOP untuk "apa yang harus dilakukan ketika situasi X terjadi" sebagai YAML bermuatan pemicu plus sebuah prosedur, lalu dimuat dengan prioritas tinggi ketika skenarionya cocok (direktori `skills/` + `SKILL.md`). Tiga batasan keras memisahkan keduanya: pemicu yang berbeda (kecocokan kueri vs kecocokan skenario), bentuk yang berbeda (entri vs prosedur langkah demi langkah), dan laju perubahan yang berbeda (Memory berubah setiap hari, Skill bisa tidak bergerak berbulan-bulan). Agent yang berjalan dengan kedua kaki sekaligus memahami Anda dan tahu cara bekerja.**

---

## Mengapa kedua konsep ini terus tertukar

Jika ada satu rancangan Hermes Agent yang sangat mudah disalahpahami, itu adalah pemisahan bersih antara **Memory** dan **Skill**.

Reaksi pertama sebagian besar orang adalah tiga pertanyaan:

- **"Bukankah keduanya memori jangka panjang? Kenapa dipisah?"**
- **"Keduanya Markdown, jadi kenapa tidak disatukan?"**
- **"Mengingat 'frontend agent-demo berjalan di port dev lokal' dan mengingat 'rangkum dulu, lalu daftarkan perubahannya saat menulis deskripsi PR' — bukankah itu sama saja?"**

Jawaban singkatnya: **karena otak manusia pun memisahkannya.**

---

## 1. Ilmu kognitif sudah membuat pembedaan ini: deklaratif vs prosedural

Psikologi sejak lama membedakan dua jenis memori jangka panjang:

| Jenis | Definisi | Contoh | Cara dipanggil |
|---|---|---|---|
| **Deklaratif** | Fakta yang dapat Anda nyatakan | "Saya tinggal di Beijing", "React 18 memperkenalkan concurrent rendering" | Dengan **dinyatakan** |
| **Prosedural** | Keterampilan yang dapat Anda lakukan tetapi mungkin tak dapat Anda jelaskan | Bersepeda, mengetik tanpa melihat, menulis deskripsi PR yang tersusun baik | Dengan **dijalankan** |

Kedua jenis memori ini berbeda dalam **cara disimpan, dipanggil, dan diperbarui**: memori deklaratif dapat diverbalkan (kanal verbal), sementara memori prosedural umumnya diperagakan (kanal motorik). Dalam eksperimen psikologi, pasien dengan kerusakan hipokampus mengalami gangguan berat pada memori deklaratif namun tetap dapat mempelajari tugas prosedural seperti menulis cermin — **dua jalur independen, bukan dua ekspresi dari satu jalur.**

Hermes Agent memindahkan pembedaan itu langsung ke dalam desain sistemnya:

- **Memory (`memories/`, `MEMORY.md`)**: memori deklaratif milik agent.
- **Skill (`skills/`)**: memori prosedural milik agent.

---

## 2. Memory: apa yang dapat dinyatakan agent

Sistem memori menyimpan **fakta, peristiwa, kesimpulan, dan preferensi**:

- "Jasmin sedang mengerjakan situs global untuk agent-demo."
- "Pekan lalu bagian hero diubah menjadi gradien beranimasi."
- "Proyeknya berjalan di Next.js, dengan dev server frontend di port dev lokal."

Karakteristiknya:

- **Deklaratif**: ada sebagai kalimat singkat dan entri yang dapat dikutip langsung ke dalam sebuah prompt.
- **Dipanggil sesuai kebutuhan**: ketika topik terkait muncul, pencocokan FTS5 menarik masuk entri yang relevan.
- **Mudah berubah**: entri baru ditambahkan, yang lama di-`replace` atau di-`remove`.

**Anggap Memory sebagai buku catatan agent** — yang terbuka di atas meja, penuh fakta spesifik.

---

## 3. Skill: apa yang dapat dilakukan agent

Sebuah Skill menyimpan **prosedur standar untuk satu kelas tugas**. Skill Hermes yang tipikal adalah `SKILL.md` yang YAML frontmatter-nya mendeklarasikan kondisi pemicu dan toolset yang ia dukung sebagai cadangan:

```yaml
---
name: pr-description-format
trigger:
  when: "user asks to write a PR description"
fallback_for_toolsets: [git, code-review]
---

# Prosedur standar untuk menulis deskripsi PR

1. Rangkum tujuan perubahan dalam satu kalimat
2. Daftarkan perubahannya (dikelompokkan per modul)
3. Radius dampak
4. Status pengujian
5. Issue terkait / rencana rollback
```

Karakteristiknya:

- **Prosedural**: ada sebagai "kapan dipicu + bagaimana melakukannya", dekat dengan SOP yang dapat dipakai ulang.
- **Dipicu oleh skenario**: ketika agent mengenali situasi yang cocok, Skill tersebut **dimuat otomatis sebagai prompt berprioritas tinggi** yang memandu tindakan itu.
- **Relatif stabil**: begitu sebuah Skill mengendap, ia biasanya tinggal di tempat; yang berubah adalah skenario dan material di Memory yang terikat padanya.

**Anggap Skill sebagai memori otot agent** — tidak perlu diingat kembali, gerakannya begitu saja terjadi.

Pengguna Hermes juga dapat menjalankan `/learn` agar agent menyarikan "bagian dari sesi ini yang layak dikodifikasi" menjadi `SKILL.md` baru — mirip mentor yang mewariskan sebuah metode kepada muridnya.

---

## 4. "Mengapa tidak digabungkan?" — tiga batasan keras

Seseorang akan bertanya: keduanya Markdown, keduanya memori jangka panjang, jadi mengapa tidak disatukan?

Karena itu tidak berhasil. Alasannya mirip tiga batasan yang memisahkan `USER.md` dan `MEMORY.md`, tetapi di sini bahkan lebih kuat.

### Batasan 1: pemicu yang berbeda

- Memory "**dipanggil kembali ketika sebuah kueri cocok**" (FTS5 plus ringkasan semantik).
- Skill "**dimuat ketika sebuah skenario cocok**", biasanya dengan pemicu eksplisit (`trigger.when: "user asks to write a PR description"`).

Jika digabungkan, agent akan kehilangan jejak apakah ia sedang mengutip sebuah fakta atau mengikuti sebuah prosedur.

### Batasan 2: bentuk yang berbeda

- Memory berupa **kalimat singkat, fakta, entri** ("[2026-07-30] port dev lokal frontend agent-demo").
- Skill berupa **prosedur, templat, batasan**, biasanya dengan YAML frontmatter plus urutan "langkah 1 / 2 / 3".

Jika dijejalkan bersama, agent tidak dapat membedakan "apakah ini latar belakang, atau sesuatu yang seharusnya saya jalankan sekarang?"

### Batasan 3: laju perubahan yang berbeda

- **Memory berubah setiap hari** (satu sesi saja bisa menambahkan satu atau dua entri).
- **Sebuah Skill bisa tidak berubah berbulan-bulan** (SOP untuk deskripsi PR tidak perlu disunting selama setengah tahun).

Menyatukannya membuat entri faktual berfrekuensi tinggi menghanyutkan SOP yang stabil — seperti menjilid konstitusi dan kalender meja ke dalam buku catatan yang sama.

---

## 5. Skenario nyata: `/learn` dan Memory bekerja bersama

Misalkan Anda berkata kepada agent:

> "Mulai sekarang tim kami menulis deskripsi PR dalam format ini: ringkasan satu kalimat, daftar perubahan, radius dampak, status pengujian. Ingat juga bahwa proyek ini bernama agent-demo dan frontend-nya berjalan di port dev lokal."

Hermes Agent yang terlatih baik menanganinya seperti berikut:

- **Paruh pertama** → jalur `/learn`, menulis **Skill** baru: `pr-description-format.md`, dipicu oleh `user asks to write a PR description`.
- **Paruh kedua** → operasi atomik `add`, menulis satu entri **Memory**: `- [2026-07-30] agent-demo: dev server frontend di port dev lokal`.

Lain kali Anda berkata "tulis deskripsi PR untuk saya", agent akan:

1. **Mencocokkan skenario lalu memuat Skill**: `pr-description-format.md` masuk ke prompt berprioritas tinggi.
2. **Mencocokkan Memory lewat kueri**: ia tahu proyek saat ini adalah agent-demo, berjalan di port dev lokal.
3. **Menggabungkan keduanya**: menghasilkan deskripsi PR yang mengikuti standar tim dan sesuai dengan proyek spesifiknya.

**Mengingat fakta plus mengingat prosedur itulah yang membuat hasilnya lebih baik daripada jumlah bagian-bagiannya.**

---

## 6. Skill Bundle dan fallback_for_toolsets

Hermes menambahkan dua lapisan pengorganisasian di atas Skill:

- **Skill Bundle**: Skill yang berkaitan dipaketkan sebagai satu grup. Bundle "release pipeline" mungkin memuat `pre-release-checklist`, `changelog-format`, dan `deploy-rollback`, yang diaktifkan, dinonaktifkan, atau dibagikan sebagai satu kesatuan.
- **`fallback_for_toolsets`**: sebuah Skill dapat mendeklarasikan bahwa ia menjadi cadangan bagi suatu toolset ketika toolset tersebut gagal. Misalnya, ketika toolset `git` bermasalah, Skill dengan langkah pemulihan rebase manual akan menyala.

Bersama-sama, keduanya mengubah Skill dari SOP satu titik menjadi **metodologi kerja yang dapat dikomposisi** — cara kerja utuh yang dibawa pengguna kepada agent, ditangkap sebagai aset yang dapat dibagikan.

---

## 7. Bukan ide baru, tetapi jarang diimplementasikan dengan benar

Pelapisan memori faktual dan prosedural sudah lama dibahas di kalangan AI. Benar-benar merekayasanya, dan membuatnya **terlihat, dapat disunting, serta dapat dipakai ulang oleh pengguna**, adalah tempat Hermes relatif jauh di depan — ia memetakan setiap lapisan ke direktori, kolom, dan perintah yang konkret:

| Kemampuan | Sisi Memory | Sisi Skill |
|---|---|---|
| Direktori utama | `~/.hermes/memories/` | `~/.hermes/skills/` |
| Pintu masuk lapisan prompt | `MEMORY.md`, `USER.md` | `SKILL.md` dimuat saat skenario cocok |
| Perintah penangkapan | `add / replace / remove` (digerakkan agent plus persetujuan `/memory pending`) | `/learn` (digerakkan agent plus persetujuan `/skills pending`) |
| Pengorganisasian | Entri plus indeks teks penuh FTS5 | Satu SOP plus Bundle dan `fallback_for_toolsets` |
| Laju perubahan | Harian | Bulanan |

Bawa pelapisan itu ke konteks produk dan Anda mendapat bentuk dengan potensi nyata:

- **Memory adalah arsip bersama antara Anda dan agent.**
- **Skill adalah metodologi kerja yang Anda bawa kepada agent.**

Bersama-sama, keduanya menjadikan agent sebagai mitra yang **memahami Anda dan tahu cara bekerja** — bukan chatbot dengan memori yang lumayan.

---

## 8. LightVela: menjadikan Memory dan Skill sebagai aset pengguna

Hermes sudah membuat pemisahan Memory / Skill dapat dipakai dalam istilah rekayasa, tetapi ia masih berupa **Markdown untuk developer**. Pendekatan LightVela adalah mengangkat lapisan itu dari fitur teknis menjadi **aset pengguna**:

- **Perpustakaan Skill pribadi**: pengguna dapat mengumpulkan, menyunting, dan membagikan Skill (alur kerja) mereka sendiri sebagaimana mereka mengumpulkan prompt, lalu mengikatnya ke skenario pemicu. Pola penulisan Anda, SOP tinjauan, dan standar penerjemahan semuanya dapat menjadi Skill.
- **Perpustakaan Memory pribadi**: setiap memori faktual yang dipegang agent tentang Anda bersifat transparan, dapat dilihat, dikoreksi, dan dihapus — tanpa perlu menyunting `~/.hermes/MEMORY.md`.
- **Pemakaian ulang tingkat tim**: Skill dan Memory keduanya dapat ditangkap pada cakupan tim, sehingga anggota baru otomatis mewarisi memori bersama dan metode bersama tim alih-alih bergantung pada cerita mulut ke mulut.
- **Jalur terpendek**: jika model "dua kaki" ini menarik bagi Anda tetapi Anda enggan berurusan dengan Ollama, SSH, systemd, dan backup `~/.hermes/`, LightVela adalah jalur terpendek menuju model tersebut dalam bentuk produk siap pakai.

Dengan kata lain, melatih agent di LightVela berarti **mengumpulkan dua aset sekaligus**: Memory tentang Anda, dan koleksi Skill Anda. **Kedua aset itulah yang menjadi milik Anda dalam jangka panjang — keduanya lebih penting daripada modelnya sendiri.**

---

## Poin penting

- Memory ≠ Skill. Yang pertama adalah **memori deklaratif** (fakta yang dapat dinyatakan), yang kedua adalah **memori prosedural** (metode yang diperagakan).
- Tiga batasan keras memisahkan keduanya: **pemicu berbeda / bentuk berbeda / laju perubahan berbeda.**
- Agent yang matang harus berjalan dengan kedua kaki — mengingat fakta dan mengingat metode.
- LightVela mengubah keduanya menjadi aset pengguna, sehingga "melatih agent Anda sendiri" menjadi pengalaman produk yang dapat Anda bangun di atasnya, bukan sekadar slogan.

---

## Di mana ini menempatkan kita

Di seluruh kategori ini, lima artikel mencakup keseluruhan bahasannya:

1. Bagaimana Hermes Agent berbeda dari OpenClaw (**akumulasi vs koneksi**)
2. Bagaimana Hermes Agent mengingat Anda (**empat lapisan memori terstruktur**)
3. Mengapa Hermes Agent memecah memori menjadi dua (**`USER.md` vs `MEMORY.md`**)
4. Mengapa lebih banyak memori bukan berarti lebih baik: bagaimana Hermes Agent memfilter, mengurasi, dan memperbarui memori jangka panjang (**empat aturan besi**)
5. Memory bukan Skill: bagaimana memori faktual dan prosedural berbeda (**berjalan dengan kedua kaki**)

**Satu baris untuk menutup**: benteng bagi agent generasi berikutnya bukan ukuran model, melainkan apakah sebuah agent benar-benar **mengenal Anda** (Memory) dan **memiliki metode** (Skill) — dan apakah keduanya dapat berjalan andal dalam jangka panjang bermuara pada apakah ia **tetap hidup**. Justru itulah alasan LightVela ada.
