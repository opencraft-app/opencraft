

## Ringkasan

**Kurasi memori jangka panjang Hermes Agent bukan soal menyimpan lebih banyak; ia mengikuti empat aturan besi yang menjaga memori tetap "sedikit tetapi presisi":**

1. **Terbatas**: `USER.md` di ~1.375 karakter dan `MEMORY.md` di ~2.200 karakter memaksa keringkasan.
2. **Dibekukan**: tidak ada penulisan ulang di dalam satu sesi, sehingga KV cache dan kestabilan inferensi terlindungi.
3. **Transparan**: setiap penulisan diumumkan (`💾 Memory updated`), dan dapat disetujui, dibatalkan, serta ditinjau dengan `/journey`.
4. **Mengonsolidasi diri**: ketika kapasitas penuh, tidak ada yang dibuang tanpa suara; respons `Memory at 2,100/2,200 chars. Consolidate now...` memaksa agent membuat trade-off melalui tiga operasi atomik `add / replace / remove`.

**Hasilnya**: agent makin memahami Anda seiring waktu tanpa pernah membengkak, dan memori menjadi makin kaya tanpa pernah lepas kendali.

---

## Sebuah miskonsepsi umum

> "Makin banyak yang diingat asisten AI, makin cerdas ia."

Kenyataannya justru sebaliknya. **Mengingat banyak informasi bermutu campur aduk membuat agent makin bodoh** — ia mulai memperlakukan pernyataan Anda yang sesaat, keliru, dan kedaluwarsa sebagai fakta stabil tentang Anda. Sistem memori jangka panjang yang benar-benar berguna selalu **sedikit tetapi presisi**.

Untuk mewujudkannya, Hermes menjawab empat pertanyaan:

- Apa yang layak masuk ke memori jangka panjang? (**gerbang penulisan**)
- Bagaimana fragmen yang masuk menjadi entri yang tersusun baik? (**kurasi**)
- Apa yang terjadi ketika informasi berubah? (**semantik pembaruan**)
- Apa yang terjadi ketika kapasitas penuh? (**konsolidasi yang dipaksakan**)

Bagian berikut menelusuri keempatnya secara berurutan.

---

## 1. Penulisan: agent adalah gerbang pertama

Gerbang pertama Hermes adalah **filter penulisan**. Alih-alih menyimpan setiap kalimat, agent **menilai sendiri** apakah perlu menulis pada empat momen eksplisit:

- **Compression**: saat konteks mendekati batasnya, agent meninjau sesi saat ini lalu menyarikan apa yang layak dipertahankan lintas sesi.
- **Checkpoint**: pada momen seperti menutup sebuah tugas atau berganti topik, ia menata memori.
- **Nudges**: sistem secara berkala menanyai agent, "ada yang layak masuk memori jangka panjang di bagian ini?" sehingga fragmen penting tidak hilang.
- **Instruksi eksplisit pengguna**: "tolong ingat X" ditulis dengan prioritas.

Kriteria penilaiannya biasanya mencakup:

| Dimensi | Makna | Contoh sebaliknya |
|---|---|---|
| Dapat dipakai ulang | Mungkinkah ini berguna di tugas lain nanti? | "Saya mau latte hari ini" |
| Stabilitas | Apakah ini sesaat atau bertahan lama? | "Kepala saya sakit hari ini" |
| Kekhususan | Sikap yang samar, atau fakta yang dapat dipakai ulang? | "Sepertinya saya lebih suka hal yang agak lebih ringkas" |
| Sensitivitas privasi | Email, kata sandi, alamat yang tidak dikonfirmasi eksplisit | Tidak ditulis secara default |

**Hermes Agent yang terlatih baik lebih memilih mengingat terlalu sedikit daripada mengingat secara sembarangan.**

---

## 2. Kurasi: menulis ulang fragmen menjadi entri

Bahkan setelah melewati filter penulisan, informasi yang masuk biasanya masih berupa fragmen. Langkah kedua Hermes adalah **menulis ulang fragmen menjadi entri yang tersusun baik.**

Misalnya, percakapan mentahnya mungkin:

> "Oh iya, API kita itu sudah dialihkan supaya lewat gateway, bukan langsung ke service — itu pekan lalu."

Hermes tidak menyimpannya kata per kata. Ia menulis:

```md
- [~2026-07-24] API Proyek X sekarang melalui gateway, bukan terhubung langsung.
```

Empat hal terjadi di sana:

- **Ekstraksi fakta**: kata pengisi seperti "oh iya" dibuang.
- **Resolusi subjek**: "API kita itu" menjadi "Proyek X".
- **Penambatan waktu**: "pekan lalu" menjadi tanggal perkiraan.
- **Dapat ditemukan kembali**: ditulis sebagai entri terstruktur sehingga FTS5 dapat mencocokkannya nanti (~20ms untuk mencocokkan, ~1ms untuk memberi halaman).

Hanya setelah kurasi terstruktur sebuah entri berpeluang **dipanggil kembali berbulan-bulan kemudian**.

---

## 3. Tiga operasi atomik: add / replace / remove

Setiap modifikasi yang dilakukan Hermes pada `MEMORY.md` harus jatuh ke salah satu dari tiga operasi atomik:

| Operasi | Semantik | Pemicu |
|---|---|---|
| **add** | Menambahkan entri baru | Peristiwa baru, keputusan baru |
| **replace** | **Menimpa** entri lama dengan yang baru | Perubahan status ("API sekarang melalui gateway" menggantikan "API terhubung langsung") |
| **remove** | Penghapusan fisik | Bantahan pengguna, entri kedaluwarsa, entri lama yang tergabung lewat konsolidasi |

**Mengapa operasi yang samar (seperti "perbarui saja kolom terkaitnya") tidak diizinkan?**

Alasan 1: operasi atomik dapat diaudit. Setiap perubahan memori memetakan "entri ini → entri itu", dan itulah yang memungkinkan tinjauan presisi seperti `/memory diff <id>`.

Alasan 2: ia memaksa agent memutuskan secara eksplisit. "Apakah saya menimpa, atau menambahkan?" — pilihan biner itulah tempat trade-off dimulai, dan itu mencegah kepribadian yang terbelah.

Alasan 3: ia menyiapkan fondasi bagi gerbang persetujuan (bagian 7), di mana setiap item yang menunggu dapat disetujui atau ditolak secara mandiri.

---

## 4. Semantik pembaruan: ubah lebih dulu, jangan pernah menambahkan yang sebaliknya

Di sinilah sistem memori sederhana berantakan: **apa yang terjadi ketika informasi berubah?**

Pendekatan naifnya adalah menambahkan entri lagi, yang membuat agent memegang semua ini sekaligus:

- "pengguna menyukai Vue"
- "pengguna kemudian beralih ke React"
- "pengguna kembali ke Vue"

Tiga entri paralel, dan model itu sendiri tidak lagi tahu mana yang harus dipercaya.

Hermes **memperbarui alih-alih menambahkan yang sebaliknya**:

- Kolom preferensi di `USER.md` cenderung **menimpa nilai lama** (`replace`).
- Di `MEMORY.md`, peristiwa historis dipertahankan tetapi **kolom keadaan-saat-ini diperbarui** (`replace`), menyisakan jejak migrasi yang singkat.
- Apa pun yang secara eksplisit dibantah pengguna ("saya tidak pernah seperti itu") akan di-`remove` — **dihapus secara fisik**, bukan dicatat sebagai "pengguna membantah X".

Inti dari semua ini adalah menjaga model dunia agent tetap **konsisten dengan dirinya sendiri**.

---

## 5. Ketika kapasitas penuh: Consolidate now

Hermes menetapkan batas keras **~2.200 karakter** untuk `MEMORY.md`. Saat kapasitasnya terisi, setiap `add` mengembalikan:

```json
{
  "success": false,
  "error": "Memory at 2,100/2,200 chars. Consolidate now...",
  "current_entries": [...],
  "usage": "2,100/2,200"
}
```

**Itu bukan bug, itu desainnya.**

Jika entri terlama dibuang otomatis ketika kapasitas terisi, agent tidak akan pernah belajar membuat trade-off — informasi penting bisa terdepak sementara informasi yang tidak relevan justru bertahan. Hermes melakukan yang sebaliknya: **penulisan ditolak sampai agent membebaskan ruang sendiri.**

Konsolidasi biasanya melibatkan:

- **Agregasi topik**: beberapa entri serupa diringkas oleh LLM menjadi satu memori yang lebih luas.
- **Pengarsipan kedaluwarsa**: "target sprint pekan ini adalah…" di-`remove` setelah tanggalnya lewat.
- **Penurunan bobot berdasarkan frekuensi akses**: entri yang lama tidak dipanggil bergerak ke belakang antrean lalu digabungkan atau dihapus lebih dulu.

Secara bersama-sama, mekanisme ini berarti **komentar sambil lalu Anda dari berbulan-bulan lalu tidak terus mencemari penilaian agent tentang Anda**, sementara informasi yang benar-benar penting justru diperkuat berulang kali.

---

## 6. Loop pembelajaran yang sadar-persetujuan: agent belajar di latar belakang tanpa mengganggu Anda

Hermes punya satu kemampuan tersembunyi lagi: **loop refleksi-diri di latar belakang**. Secara berkala ia:

1. menarik sesi-sesi terbaru;
2. menjalankan model murah (seperti Gemini Flash) di atasnya untuk menyarikan apa yang layak diingat;
3. menghasilkan kandidat entri memori yang ditandai `[auto]`.

Upstream menyebutnya **consent-aware learning loop** — **pembelajaran seharusnya tidak mengganggu pengguna**, tetapi pengguna dapat masuk kapan saja.

Manfaatnya:

- **Biaya turun ke sepertiga atau seperlima**: model murah menangani peninjauan, dengan dampak nyaris nol pada kualitas penangkapan dalam pengujian upstream.
- **Agent tumbuh bahkan saat Anda tidak memakainya** — selama ia tetap online.
- **Tidak mengganggu percakapan di depan**: kandidat entri menunggu Anda di gerbang persetujuan pada bagian berikutnya.

---

## 7. Gerbang persetujuan: bila Anda kurang nyaman agent bertindak sendiri

Sebagian pengguna khawatir: "bagaimana jika agent otomatis menulis sesuatu yang salah ke MEMORY?"

Hermes menawarkan pengalih eksplisit:

```yaml
memory:
  write_approval: true    # aktifkan gerbang persetujuan
```

Dengan itu aktif, **semua** penulisan memori (termasuk yang otomatis dari refleksi latar belakang) ditahan untuk ditinjau. Pengguna menelusurinya dengan:

```
/memory pending           # daftar entri yang menunggu (refleksi latar belakang menandainya [auto])
/memory diff <id>         # periksa perubahan tertentu
/memory approve <id>      # setujui (atau all)
/memory reject <id>       # tolak
```

Skill memiliki `skills.write_approval` terpisah, karena `SKILL.md` bisa panjang dan tidak nyaman ditampilkan inline; Hermes menyediakan `/skills diff <id>` agar Anda dapat membaca unified diff selengkapnya.

Gerbang persetujuan pada dasarnya adalah pemisahan eksplisit antara **pembelajaran otonom agent** dan **kedaulatan pengguna** — agent boleh mengumpulkan pengalaman dengan bebas, tetapi **setiap penulisan ulang atas catatan pengguna sendiri** harus melewati pengguna.

---

## 8. Transparansi: Anda dapat melihat setiap pembaruan memori

Hermes menampilkan aksi memori melalui notifikasi secara real time:

| Pengaturan | Ditampilkan sebagai |
|---|---|
| `off` | Penulisan senyap, tidak ada yang ditampilkan |
| `on` (default) | `💾 Memory updated` |
| `verbose` | `💾 Memory ➕ User prefers terse replies` (dengan pratinjau konten) |

Dari "ada sesuatu yang diingat" sampai "entri persis inilah yang diingat", granularitasnya Anda yang pilih. Tingkat **observabilitas** seperti itu jarang ada di antara AI agent — sebagian besar memperlakukan memori sebagai kotak hitam.

---

## 9. Learning Journey: meninjau bagaimana agent tumbuh

Jika Anda ingin **menengok kembali** apa yang sudah dipelajari agent selama berbulan-bulan, Hermes menyediakan `/journey` (alias `/learning`, `/memory-graph`):

- CLI: `hermes journey` (mendukung replay beranimasi `--play` dan ekspor `--json`)
- TUI: overlay `/journey`
- Desktop: panel interaktif Star Map

Dengan perintah pembersihan yang menyertainya:

```bash
hermes journey list           # daftar semua node
hermes journey delete <node>  # arsipkan sebuah Skill (dapat dipulihkan) atau hapus sebuah memori
hermes journey edit <node>    # buka di $EDITOR
```

Tool ini penting jauh melampaui kebaruannya — ia mengakui sesuatu yang nyata: **cara sebuah agent tumbuh itu sendiri layak ditinjau.**

---

## 10. Mengapa kehematan ini penting dalam praktik

Satukan semua hal di atas dan filosofi memori Hermes bermuara pada **empat aturan besi**:

1. **Terbatas**: batas karakter memaksa keringkasan.
2. **Dibekukan**: tidak ada perubahan di dalam satu sesi, sehingga cache terlindungi.
3. **Transparan**: setiap penulisan terlihat oleh pengguna, dapat disetujui dan dibatalkan.
4. **Mengonsolidasi diri**: penyimpanan yang penuh tidak pernah dibuang tanpa suara; agent dipaksa membuat trade-off.

Ketika memasarkan "memori AI", banyak produk menonjolkan seberapa besar penyimpanan memori yang mereka dukung dan berapa banyak entri yang dapat mereka tampung. Namun dari sudut pandang pengguna, hanya tiga hal yang penting:

1. **Apakah ia mengingat hal-hal yang benar-benar penting?**
2. **Apakah ia segera memperbarui informasi yang sudah tidak berlaku?**
3. **Apakah ia menjadi lebih bertele-tele dan lebih rawan salah karena mengingat setumpuk hal yang tidak relevan?**

**Sistem memori yang dapat menjawab "apa yang seharusnya tidak diingat" adalah sistem memori yang baik.**

---

## 11. Satu hal masih kurang agar ini berjalan dalam praktik

Sebaik apa pun mekanisme memorinya, ada satu prasyarat: **agent harus tetap hidup.**

Jika Anda memasang Hermes di laptop Anda sendiri, ia tertidur setiap kali Anda menutup penutupnya, loop refleksi latar belakang terhenti, dan `nudge_interval` tidak pernah mencapai pemicu berikutnya. Berganti mesin atau memasang ulang OS berarti memindahkan `~/.hermes/` secara manual.

Di sinilah hosting cloud menjadi benar-benar berguna. [**LightVela**](https://lightvela.ai/) adalah **layanan Hermes Agent berbasis cloud**:

- Instans cloud khusus yang online 24×7, dengan `MEMORY.md` / `USER.md` / arsip sesi SQLite berada di sana secara permanen;
- Loop refleksi latar belakang terus berjalan, sehingga agent benar-benar tumbuh bahkan saat Anda tidak memakainya;
- Data hanya tersimpan di server khusus Anda;
- Ponsel, laptop, Telegram, Slack, Lark — setiap kanal menuju agent yang sama dan mengenal Anda.

Hermes membawa filosofi "lebih banyak memori bukan berarti lebih baik" sampai ke kesimpulan logisnya; **LightVela membuat filosofi itu berlaku setiap hari, tepat di samping Anda.** Begitulah janji "makin memahami Anda seiring waktu" benar-benar ditunaikan.

---

## Poin penting

- Sistem memori yang baik = **penulisan yang ketat + kurasi terstruktur + tiga operasi atomik + konsolidasi yang dipaksakan + refleksi latar belakang + gerbang persetujuan + transparansi penuh.**
- Mengingat lebih banyak tidak berarti lebih cerdas; mengenali "apa yang seharusnya tidak diingat" dan dipaksa membuat trade-off justru lebih penting.
- Hermes menyediakan referensi rekayasanya; LightVela bertujuan mengubahnya menjadi pengalaman produk yang benar-benar dapat dijangkau pengguna.
