

## Ringkasan

**Hermes Agent mengingat Anda bukan karena context window yang lebih besar, melainkan karena sistem memori jangka panjang dengan empat lapisan yang saling bekerja sama: `USER.md` (1.375 karakter / sekitar 500 token) mencakup "siapa Anda", `MEMORY.md` (2.200 karakter / sekitar 800 token) mencakup "apa yang sudah kita kerjakan bersama", arsip sesi SQLite + FTS5 membuat kalimat apa pun dapat ditemukan secara presisi berminggu-minggu kemudian, dan Skill mencakup "bagaimana saya seharusnya menangani jenis tugas ini". Penulisan diatur secara sengaja oleh agent pada empat momen — Compression, Checkpoint, Nudge, dan instruksi eksplisit pengguna — sementara pemanggilan kembali menggabungkan tiga kaki: pemuatan default terstruktur, pencocokan persis FTS5, dan perangkuman semantik LLM. Itulah yang mengubah "mengingat Anda" dari konsep menjadi rekayasa.**

---

## Momen ketika sebagian besar asisten AI mengecewakan Anda

Bukan saat mereka menjawab salah. Tetapi saat Anda harus berkata:

> **"Bukankah ini baru saja saya sampaikan sebelumnya?"**

Context window sudah melonjak dari 8k ke 200k dan 1M, tetapi mengingat Anda sejak awal bukan soal menjejalkan lebih banyak token: konteks 200k di dalam satu sesi menguap begitu sesi tersebut berakhir. Agar sebuah agent mengingat Anda dalam jangka panjang, tiga pertanyaan harus dijawab:

- Apa yang layak dituliskan ke memori jangka panjang? (Di mana gerbang penulisannya?)
- Dalam bentuk apa memori harus disimpan agar tetap dapat ditemukan berminggu-minggu kemudian?
- Saat waktunya menemukan sesuatu, apakah agent bergantung pada kemiripan vektor, atau pada hal lain?

Hermes menjawab ketiganya dengan sistem memori jangka panjang yang utuh. Bagian berikut memecahnya ke dalam lima lapisan.

---

## 1. Pertama, definisikan apa arti "mengingat"

Dalam istilah manusia, "mengingat Anda" memuat setidaknya tiga hal:

1. **Mengetahui siapa Anda** — nama, peran, preferensi, toolchain yang biasa dipakai.
2. **Mengetahui apa yang sudah kita kerjakan bersama** — proyek yang dibahas, kesimpulan yang diberikan, jebakan yang dialami.
3. **Mengetahui cara memperlakukan Anda** — apakah Anda ingin jawaban singkat atau rinci? Kesimpulan dulu, atau penalaran dulu?

Model yang hanya bermodal context window besar dapat melakukan ketiganya **di dalam satu percakapan**, tetapi begitu sesi berakhir, poin 1 dan 3 ter-reset.

**Pendekatan Hermes**: dorong ketiga hal itu ke lapisan persistensi terpisah, masing-masing dipelihara sebagaimana mestinya — poin 1 masuk ke `USER.md`, poin 2 masuk ke `MEMORY.md`, dan poin 3 dipelihara bersama oleh kolom preferensi di `USER.md` dan pemodelan pengguna oleh Honcho.

---

## 2. Penulisan: agent mengatur secara sengaja, bukan mencatat semuanya

Memori jangka panjang Hermes bukan "satu entri per kalimat". Agent mengatur dan mempertahankan memori pada **empat momen eksplisit**:

| Pemicu | Tujuan |
|---|---|
| **Compression** | Ketika konteks mendekati batasnya, sarikan dulu apa yang layak disimpan jangka panjang dari sesi saat ini, baru kompres konteksnya |
| **Checkpoint** | Pada tonggak seperti menyelesaikan subtugas atau berganti topik, catat secara sengaja |
| **Nudge** | Sistem secara berkala menyentil agent: "ada yang layak dituliskan ke memori jangka panjang di sini?" Ini mencegah informasi hilang tanpa suara di dalam sesi panjang |
| **Instruksi eksplisit pengguna** | Ketika pengguna berkata "ingat bahwa saya memakai Y di proyek X", itu dikenali sebagai penulisan memori berprioritas tinggi |

Poin kuncinya: **agent itu sendiri yang memutuskan apakah sesuatu masuk ke memori jangka panjang**, bukan mempertahankan semuanya. Filter itu adalah gerbang pertama bagi kualitas memori — dan perbedaan paling mendasar dari riwayat chat yang menyimpan setiap kalimat.

Sebuah perhitungan biaya konkret: tanpa filter tersebut, pengguna dengan 50 interaksi per hari akan menuangkan sekitar **18 juta token** percakapan mentah ke memori jangka panjang dalam setahun. Pendekatan Hermes memadatkannya menjadi **di bawah 1%** sambil mempertahankan nyaris seluruh fakta kunci.

---

## 3. Penyimpanan: empat lapisan, masing-masing dengan tugasnya

Hermes memecah memori jangka panjang ke dalam empat jenis, masing-masing disimpan di tempat berbeda dengan **batas kapasitas eksplisit**:

| Lapisan | Wadah | Kapasitas tipikal | Waktu pemuatan | Tanggung jawab |
|---|---|---|---|---|
| Profil pengguna | `USER.md` | ~1.375 karakter / ~500 token | Setiap sesi | Siapa Anda, peran, preferensi, stack yang biasa dipakai, gaya komunikasi |
| Memori faktual | `MEMORY.md` + `memories/` | ~2.200 karakter / ~800 token | Setiap sesi | Peristiwa, keputusan, kesimpulan, fakta untuk dipakai ulang lintas sesi |
| Arsip sesi | SQLite + indeks teks penuh FTS5 | Tanpa batas (riwayat berbulan-bulan) | Dimuat ketika sebuah kueri cocok | Kalimat asli apa pun dapat ditemukan secara presisi berminggu-minggu kemudian |
| Memori prosedural | Direktori `skills/` (`SKILL.md`) | Skala KB per file | Pemuatan prioritas tinggi saat skenario cocok | "Apa yang harus saya lakukan dalam situasi ini" (dibahas artikel khusus di kategori ini) |

Selain itu, Hermes juga menyimpan `SOUL.md` — deskripsi kepribadian agent itu sendiri. File ini termasuk model-diri agent, bukan memori pengguna, tetapi bersama memori pengguna ia membentuk fondasi konteks.

### Mengapa setiap lapisan memiliki batas keras?

Sebagian orang bertanya: jika context window sudah sebesar ini, mengapa `USER.md` hanya mendapat 500 token?

Tiga alasan:

1. **Setiap tambahan 1.000 token di system prompt memboroskan 18 juta token setahun pada 50 pemanggilan per hari** — tekanan biaya yang serius.
2. **Apa pun yang dimuat pada setiap sesi harus dipilih dengan cermat** — ia bagian dari system prompt, dan pembengkakan akan menggusur konteks tugas yang sebenarnya.
3. **Batas memaksa adanya trade-off** — ketika kapasitas penuh, tidak ada yang dibuang tanpa suara; agent **dipaksa untuk mengonsolidasikan** (lihat bagian 5).

Itulah filosofi inti Hermes: **"mengingat" bukan "menyimpan", melainkan "menyimpan setelah dipilih dengan sengaja".**

### Satu komponen yang tidak boleh Anda abaikan: Honcho

Hermes juga menyertakan komponen bernama **Honcho** yang melakukan **pemodelan pengguna dialektis** — dalam bahasa sederhana, ia terus menyarikan pernyataan yang dapat dipakai ulang tentang pengguna dari percakapan lalu mengumpankannya kembali ke pemeliharaan `USER.md`.

Preferensi implisit yang sulit ditangani file terstruktur (misalnya, "pengguna ini mudah tidak sabar setelah jam 3 sore", atau "pengguna ini luar biasa sensitif terhadap kata pengisi") diisi oleh lapisan inferensi yang murni digerakkan LLM ini.

---

## 4. Pemanggilan kembali: terstruktur, teks penuh, dan semantik — tiga kaki

Pemanggilan kembali pada penyiapan RAG tradisional sangat bergantung pada kemiripan vektor. Namun vektor saja menghadapi dua masalah lama: **menjadi penting tidak berarti mirip dengan kuerinya**, dan **detail menjadi encer di dalam satu bagian teks utuh.**

Strategi pemanggilan kembali Hermes lebih mirip pencarian hibrida:

| Metode pencarian | Skenario pemicu | Latensi tipikal |
|---|---|---|
| **Pemuatan default terstruktur** | Setiap awal percakapan | Nyaris nol (ia bagian dari system prompt) |
| **Pencarian teks penuh FTS5** | Pengguna menanyakan fakta tertentu: "error itu apa tadi?" | ~20ms untuk mencocokkan, ~1ms untuk memberi halaman |
| **Perangkuman semantik LLM** | Pertanyaan yang menuntut penggabungan beberapa entri | Hitungan detik, dijalankan pada model murah (seperti Gemini Flash) |

Ketiganya bekerja bersama itulah yang membuat "mengingat Anda" lebih dari sekadar "vektor kami mirip" — ia menjadi **"saya benar-benar tahu apa yang Anda katakan".**

Analogi catatan tempel membantu: `USER.md` adalah **catatan yang ditempel di bingkai monitor Anda** (terlihat setiap kali Anda menengadah), `MEMORY.md` adalah **jurnal di atas meja Anda** (juga terlihat, dengan isi lebih banyak), SQLite+FTS5 adalah **kotak arsip di dalam lemari** (jarang dibuka, tetapi selalu dapat ditemukan), dan Skill adalah **memori otot** (tubuh Anda tahu apa yang harus dilakukan ketika saatnya datang).

---

## 5. Pembaruan: memori itu hidup, bukan buku besar

Satu hal yang sering terabaikan: **memori harus dapat diubah dan dibuang, bukan hanya ditulis.** Hermes memiliki tiga strategi eksplisit di sini:

### Strategi 1: saat terjadi konflik, perbarui alih-alih menambahkan secara paralel

Ini mencegah kepribadian yang terbelah — Anda tidak boleh memiliki "pengguna menyukai Vue / pengguna beralih ke React / pengguna kembali ke Vue" berdiri berdampingan. Hermes menimpa nilai lama untuk kolom preferensi, sementara entri faktual menyimpan riwayat tetapi memperbarui kolom "keadaan saat ini".

### Strategi 2: entri yang lama tidak dirujuk diturunkan bobotnya sebagai bernilai rendah

`MEMORY.md` punya batas keras (2.200 karakter). Ketika penuh, responsnya adalah:

```json
{
  "success": false,
  "error": "Memory at 2,100/2,200 chars. Consolidate now...",
  "current_entries": [...],
  "usage": "2,100/2,200"
}
```

Itu bukan error, melainkan **sinyal gerbang**: agent harus membuat trade-off dan menggabungkan atau menghapus entri lama bernilai rendah sebelum dapat menulis lagi.

### Strategi 3: informasi yang secara eksplisit dibantah pengguna langsung dihapus

Bukan "catat sebaliknya", melainkan **penghapusan fisik** — menjaga model dunia tetap konsisten dengan dirinya sendiri.

Dengan kata lain, Hermes lebih dekat ke **menyunting arsip yang hidup** dibandingkan menambahkan catatan ke buku harian.

---

## 6. Satu hal masih kurang agar ini berjalan dalam praktik

Sebaik apa pun mekanisme memorinya, ada satu prasyarat: **agent harus tetap hidup.**

Jika Anda memasang Hermes di laptop Anda sendiri, ia tertidur setiap kali Anda menutup penutupnya, dan loop refleksi-diri di latar belakang (nudge) terhenti. Berganti mesin atau memasang ulang OS berarti memindahkan `~/.hermes/` secara manual, dan indeks FTS5 harus dibangun ulang dari awal setiap kali.

Di sinilah hosting cloud menjadi benar-benar berguna. [**LightVela**](https://lightvela.ai/) adalah **layanan Hermes Agent berbasis cloud**:

- Instans cloud khusus yang online 24×7, dengan `MEMORY.md` / `USER.md` / arsip sesi SQLite berada di sana secara permanen;
- Loop nudge di latar belakang terus berjalan, sehingga agent benar-benar tumbuh bahkan saat Anda tidak memakainya;
- Data hanya tersimpan di server khusus Anda;
- Ponsel, laptop, Telegram, Slack, Lark — setiap kanal menuju agent yang sama dan mengenal Anda.

Hermes mengubah "mengingat Anda" menjadi rancangan rekayasa yang berfungsi; LightVela membuat rancangan itu berlaku **setiap hari, tepat di samping Anda.**

---

## Poin penting

- Hermes mengingat Anda melalui **kurasi yang sengaja, penyimpanan berlapis, pemanggilan kembali hibrida, dan pembaruan berkelanjutan** — bukan lewat window yang lebih besar.
- Setiap lapisan memiliki kapasitas eksplisit: 500 token untuk `USER.md`, 800 token untuk `MEMORY.md`, tanpa batas untuk SQLite, dan pemuatan berbasis skenario untuk Skill.
- Sistem memori agent yang baik **menyunting arsip** alih-alih **menambahkan catatan ke buku harian** — batas kapasitas memaksa trade-off.
- Tujuan LightVela adalah membawa kemampuan ini dari command line ke dalam sebuah produk, sehingga dikenali menjadi pengalaman default.
