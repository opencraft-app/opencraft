

## Ringkasan

**Hermes Agent mengingati anda bukan kerana tetingkap konteks yang lebih besar, tetapi kerana sistem ingatan jangka panjang dengan empat lapisan bekerjasama: `USER.md` (1,375 aksara / kira-kira 500 token) meliputi "siapa anda", `MEMORY.md` (2,200 aksara / kira-kira 800 aksara yang telah kami selesaikan bersama-sama", satu sesi F yang telah kita selesaikan bersama-sama dengan SQL + 800. arkib bermaksud mana-mana ayat boleh diperoleh semula dengan tepat beberapa minggu kemudian, dan Kemahiran merangkumi "bagaimana saya harus mengendalikan tugas seperti ini". Tulisan disusun secara sengaja oleh ejen pada empat saat — Mampatan, Pusat Pemeriksaan, Nudge dan arahan pengguna eksplisit — manakala ingat semula menggabungkan tiga bahagian: pemuatan lalai berstruktur, pemadanan FTS5 tepat dan ringkasan semantik LLM. Itulah yang menukarkan "mengingati anda" daripada konsep kepada kejuruteraan.**

---

## Saat kebanyakan pembantu AI mengecewakan anda

Ia bukan apabila mereka mendapat jawapan yang salah. Ia adalah apabila anda perlu berkata:

> **"Bukankah anda baru sahaja memberitahu saya kali terakhir ini?"**

Tetingkap konteks telah meningkat daripada 8k kepada 200k dan 1M, tetapi mengingati bahawa anda bukanlah masalah memasukkan lebih banyak token: 200k konteks dalam satu sesi menyejat sebaik sesi itu tamat. Untuk membuat ejen mengingati anda jangka panjang, tiga soalan perlu dijawab:

- Apa yang patut ditulis ke dalam ingatan jangka panjang? (Di manakah gerbang tulis?)
- Dalam bentuk apakah ingatan harus disimpan supaya ia masih boleh ditemui beberapa minggu kemudian?
- Apabila tiba masanya untuk mencari sesuatu, adakah ejen bergantung pada persamaan vektor, atau pada sesuatu yang lain?

Hermes menjawab ketiga-tiga dengan sistem ingatan jangka panjang yang penuh. Bahagian di bawah memecahkannya kepada lima lapisan.

---

## 1. Pertama, takrifkan maksud "mengingat".

Dalam istilah manusia, "mengingati anda" mengandungi sekurang-kurangnya tiga perkara:

1. **Mengetahui siapa anda** — nama, peranan, keutamaan, rantai alat biasa.
2. **Mengetahui apa yang telah kita lakukan bersama** — projek yang dibincangkan, kesimpulan yang diberikan, perangkap melanda.
3. **Mengetahui cara berurusan dengan anda** — adakah anda mahukan jawapan ringkas atau terperinci? Kesimpulan dahulu, atau penaakulan dahulu?

Model yang tidak mempunyai apa-apa selain tetingkap konteks yang besar boleh melakukan ketiga-tiga **dalam satu perbualan**, tetapi apabila sesi tamat, mata 1 dan 3 ditetapkan semula.

**Hermes'pendekatan**: tolak ketiga-tiga perkara itu ke dalam lapisan kegigihan yang berasingan, masing-masing mengekalkan cara yang sepatutnya — titik 1 pergi ke `USER.md`, titik 2 pergi ke `MEMORY.md` dan titik 3 dikekalkan bersama oleh medan keutamaan dalam `USER.md` dan pemodelan pengguna Honcho.

---

## 2. Penulisan: ejen mengatur dengan sengaja dan bukannya mencatat segala-galanya

Hermes' ingatan jangka panjang bukan "satu entri setiap ayat". Ejen mengatur dan mengekalkan ingatan pada **empat saat yang jelas**:

| Pencetus | Tujuan |
|---|---|
| **Mampatan** | Apabila konteks menghampiri hadnya, mula-mula ekstrak apa yang patut disimpan untuk jangka panjang daripada sesi semasa, kemudian mampatkan konteks |
| **Titik Semak** | Pada peristiwa penting seperti menyelesaikan subtugas atau menukar topik, rekod dengan sengaja |
| **Syok** | Sistem secara berkala mencucuk ejen: "apa-apa di sini yang patut ditulis untuk ingatan jangka panjang?" Ini menghalang maklumat daripada hilang secara senyap-senyap dalam sesi panjang |
| **Arahan pengguna eksplisit** | Apabila pengguna berkata "ingat bahawa saya menggunakan Y pada projek X", ia diiktiraf sebagai tulis memori keutamaan tinggi |

Perkara utama: **ejen itu sendiri memutuskan sama ada sesuatu memasuki ingatan jangka panjang**, dan bukannya meneruskan segala-galanya. Penapis itu ialah pintu pertama pada kualiti memori — dan perbezaan paling asas daripada sejarah sembang yang menyimpan setiap ayat.

Pengiraan kos konkrit: tanpa penapis itu, pengguna dengan 50 interaksi sehari akan menuangkan kira-kira **18 juta token** perbualan mentah ke dalam ingatan jangka panjang dalam setahun. Pendekatan Hermes' memampatkannya kepada **di bawah 1%** sambil mengekalkan hampir semua fakta utama.

---

## 3. Penyimpanan: empat lapisan, setiap satu dengan tugasnya sendiri

Hermes membahagikan memori jangka panjang kepada empat jenis, setiap satu disimpan di tempat yang berbeza dengan **siling kapasiti eksplisit**:

| Lapisan | Pembawa | Kapasiti biasa | Masa muatkan | Tanggungjawab |
|---|---|---|---|---|
| Profil pengguna | `USER.md` | ~1,375 aksara / ~500 token | Setiap sesi | Siapa anda, peranan, keutamaan, susunan biasa, gaya komunikasi |
| Ingatan fakta | `MEMORY.md` + `memories/` | ~2,200 aksara / ~800 token | Setiap sesi | Peristiwa, keputusan, kesimpulan, fakta untuk digunakan semula merentas sesi |
| Arkib sesi | Indeks teks penuh SQLite + FTS5 | Tiada siling (sejarah bulan) | Dimuatkan apabila pertanyaan sepadan | Mana-mana ayat asal boleh diambil tepat minggu kemudian |
| Ingatan prosedur | `skills/` direktori (`SKILL.md`) | Skala KB setiap fail | Muatan keutamaan tinggi pada padanan senario | "Apa yang perlu saya lakukan dalam situasi ini" (ditutup oleh artikel khusus dalam kategori ini) |

Di luar itu, Hermes juga menyimpan `SOUL.md` — perihalan personaliti ejen itu sendiri. Ia tergolong dalam model kendiri ejen dan bukannya memori pengguna, tetapi bersama-sama dengan memori pengguna ia membentuk asas konteks.

### Mengapa setiap lapisan mempunyai siling keras?

Sesetengah orang bertanya: jika tetingkap konteks sebesar ini, mengapa `USER.md` hanya mendapat 500 token?

Tiga sebab:

1. **Setiap tambahan 1,000 token dalam sistem segera membazir 18 juta token setahun pada 50 panggilan sehari** — tekanan kos yang serius.
2. **Apa-apa sahaja yang dimuatkan pada setiap sesi perlu dipilih dengan teliti** — ia adalah sebahagian daripada gesaan sistem, dan bloat memerah konteks tugas sebenar.
3. **Siling memaksa pertukaran** — apabila kapasiti penuh, tiada apa-apa yang digugurkan secara senyap; ejen **terpaksa untuk menyatukan** (lihat bahagian 5).

Iaitu Hermes' falsafah teras: **"mengingat" bukan "menyimpan", ia "menyimpan selepas pemilihan yang disengajakan".**

### Satu komponen yang anda tidak boleh terlepas pandang: Honcho

Hermes juga membawa masuk komponen yang dipanggil **Honcho** yang melaksanakan **pemodelan pengguna dialektik** — secara ringkasnya, ia terus mengeluarkan kenyataan boleh guna semula tentang pengguna daripada perbualan dan menyuapkannya kembali ke dalam penyelenggaraan `USER.md`.

Keutamaan tersirat yang dikendalikan oleh fail berstruktur dengan buruk (contohnya, "pengguna ini menjadi tidak sabar selepas jam 3 petang", atau "pengguna ini luar biasa sensitif kepada perkataan pengisi") diisi oleh lapisan inferens yang dipacu LLM semata-mata ini.

---

## 4. Ingat: berstruktur, teks penuh dan semantik — tiga kaki

Ingat dalam persediaan RAG tradisional banyak bergantung pada persamaan vektor. Tetapi vektor sahaja mengalami dua masalah yang telah lama wujud: **menjadi penting tidak bermakna serupa dengan pertanyaan** dan **butiran dicairkan dalam keseluruhan petikan.**

Strategi penarikan semula Hermes' kelihatan lebih seperti pengambilan semula hibrid:

| Kaedah mendapatkan semula | Senario pencetus | Kependaman biasa |
|---|---|---|
| **Pemuatan lalai berstruktur** | Setiap perbualan bermula | Hampir sifar (ia adalah sebahagian daripada gesaan sistem) |
| **carian teks penuh FTS5** | Pengguna bertanya tentang fakta khusus: "apakah ralat itu lagi?" | ~20ms untuk dipadankan, ~1ms ke halaman |
| **Ringkasan semantik LLM** | Soalan yang memerlukan penyepaduan berbilang entri | Saat, jalankan pada model murah (seperti Gemini Denyar) |

Ketiga-tiga bekerja bersama-sama itulah yang menjadikan "mengingati anda" lebih daripada "vektor kami serupa" — ia menjadi **"Saya sebenarnya tahu apa yang anda katakan".**

Analogi nota melekit membantu: `USER.md` ialah **nota yang tersangkut pada bezel monitor anda** (kelihatan setiap kali anda mendongak), `MEMORY.md` ialah **jurnal di atas meja anda** (juga kelihatan, dengan lebih banyak bahagian dalam), SQLite+FTS5 ialah **kotak arkib dalam kabinet** (jarang dibuka, tetapi sentiasa dapat ditemui pada saat-saat ingatan) dan Kemahiran (*otot anda sentiasa dapat ditemui) apabila ada masa ingatan**.

---

## 5. Mengemas kini: ingatan masih hidup, bukan lejar

Satu perkara yang sering diabaikan: **memori mesti boleh diubah suai dan boleh guna, bukan hanya boleh ditulis.** Hermes mempunyai tiga strategi yang jelas di sini:

### Strategi 1: mengenai konflik, kemas kini dan bukannya ditambah secara selari

Ini mengelakkan personaliti berpecah — anda tidak boleh "pengguna lebih suka Vue / pengguna bertukar kepada React / pengguna kembali ke Vue" duduk sebelah menyebelah. Hermes menimpa nilai lama untuk medan keutamaan, manakala entri fakta menyimpan sejarah tetapi mengemas kini medan "keadaan semasa".

### Strategi 2: entri yang tidak dirujuk untuk masa yang lama diturunkan wajaran sebagai nilai rendah

`MEMORY.md` mempunyai siling keras (2,200 aksara). Apabila ia penuh, jawapannya ialah:

```json
{
  "success": false,
  "error": "Memory at 2,100/2,200 chars. Consolidate now...",
  "current_entries": [...],
  "usage": "2,100/2,200"
}
```

Itu bukan satu ralat, ia adalah **isyarat pintu**: ejen perlu membuat pertukaran dan menggabungkan atau memadam entri basi, bernilai rendah sebelum ia boleh menulis semula.

### Strategi 3: maklumat yang dinafikan pengguna secara jelas dipadamkan serta-merta

Bukan "rakam sebaliknya", tetapi **pemadaman fizikal** — memastikan model dunia konsisten sendiri.

Dalam erti kata lain, Hermes lebih hampir kepada **mengedit arkib yang masih hidup** daripada menambahkan pada diari.

---

## 6. Satu perkara yang masih hilang untuk ini berfungsi dalam amalan

Walau bagaimanapun baik mekanisme ingatan, ia mempunyai satu prasyarat: **ejen perlu terus hidup.**

Jika anda memasang Hermes pada komputer riba anda sendiri, ia tertidur setiap kali anda menutup penutup, dan gelung pantulan diri latar belakang (dorongan) terhenti. Menukar mesin atau memasang semula OS bermakna memindahkan `~/.hermes/` dengan tangan, dan indeks FTS5 perlu dibina semula dari awal setiap kali.

Di sinilah pengehosan awan menjadi benar-benar berguna. [**LightVela**](https://lightvela.ai/) ialah **perkhidmatan Hermes Agent dihoskan awan**:

- Contoh awan khusus dalam talian 24×7, dengan `MEMORY.md` / `USER.md` / arkib sesi SQLite yang tinggal di sana secara kekal;
- Gelung nudge latar belakang terus berjalan, jadi ejen benar-benar berkembang walaupun anda tidak menggunakannya;
- Data kekal hanya pada pelayan khusus anda;
- Telefon, komputer riba, Telegram, Slack, Lark — setiap saluran mencapai ejen yang sama yang mengenali anda.

Hermes menukar "mengingati anda" menjadi reka bentuk kejuruteraan yang berfungsi; LightVela menjadikan reka bentuk itu berkuat kuasa **setiap hari, betul-betul di sebelah anda.**

---

## Pengambilan utama

- Hermes mengingati anda melalui **kurasi yang disengajakan, storan berlapis, penarikan semula hibrid dan pengemaskinian berterusan** — bukan tetingkap yang lebih besar.
- Setiap lapisan mempunyai kapasiti eksplisit: 500 token untuk `USER.md`, 800 token untuk `MEMORY.md`, tiada siling untuk SQLite dan pemuatan berasaskan senario untuk Kemahiran.
- Sistem ingatan ejen yang baik **mengedit arkib** dan bukannya **melampirkan pada diari** — siling memaksa pertukaran.
- Matlamat LightVela adalah untuk membawa keupayaan ini daripada baris arahan ke dalam produk, supaya diingati adalah pengalaman lalai.
