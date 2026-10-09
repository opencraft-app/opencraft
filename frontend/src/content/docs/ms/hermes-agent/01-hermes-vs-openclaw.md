

## Ringkasan

**Perbezaan asas antara Hermes Agent dan OpenClaw ialah "pengumpulan" berbanding "sambungan": Hermes, dibina oleh Nous Research, ialah ejen yang berkembang sendiri yang direka untuk memahami anda dengan lebih baik dari semasa ke semasa. Ia menganggap ingatan jangka panjang (`USER.md` / `MEMORY.md` / SQLite+FTS5 / Kemahiran) sebagai warganegara kelas pertama, dan ejen itu sendiri memutuskan perkara yang perlu diingat dan bila untuk mempromosikan sesuatu menjadi Kemahiran. OpenClaw, diketuai oleh Peter Steinberger, ialah ejen tempatan pertama dan gerbang automasi yang direka untuk "menyambungkan segala-galanya": 25+ model dan 20+ platform pemesejan boleh dipalamkan, manakala Skills ditulis tangan oleh pengguna dan diedarkan melalui ClawHub. Memilih Hermes bermakna memilih rakan sejawat yang semakin kuat dari semasa ke semasa; memilih OpenClaw bermakna memilih meja kawalan yang boleh menyambung ke apa-apa sahaja.**

---

## Mengapa kedua-dua ejen sumber terbuka ini terus dibandingkan

Dalam landskap ejen AI sumber terbuka 2026, kedua-dua nama ini hampir mustahil untuk dielakkan. Kedua-duanya mengiklankan "pengintegrasian sembang yang diutamakan tempatan, boleh dihoskan sendiri, merentas platform", kedua-duanya menggelarkan diri mereka sebagai rangka kerja ejen tujuan umum, dan sekali imbas, halaman utama mereka kelihatan seperti produk bersaing.

Tetapi selepas seminggu penggunaan sebenar, dua soalan mula mengganggu anda:

- Mengapakah OpenClaw masih "bermula dari sifar setiap kali" walaupun selepas anda memasang berpuluh-puluh pemalam, manakala Hermes memaparkan nama projek minggu lepas dengan sendirinya selepas hanya dua hari?
- Mengapakah OpenClaw mendedahkan 138 kelemahan dalam 63 hari (7 daripadanya kritikal), manakala halaman nasihat keselamatan Hermes' hampir kosong?

Jawapannya: **mereka sebenarnya menjawab dua soalan yang sama sekali berbeza.**

- OpenClaw jawapan: "Bagaimanakah saya boleh menyambungkan seorang ejen ke setiap saluran dalam hidup saya?"
- Hermes Agent menjawab: "Bagaimanakah saya boleh membuat ejen yang lebih memahami saya seiring dengan berlalunya masa?"

Bahagian di bawah menelusuri perbezaan itu merentas enam dimensi: **kedudukan, seni bina, ingatan, Kemahiran, evolusi diri dan keselamatan.**

---

## 1. Kedudukan: Gelung Pembelajaran Dahulu vs Satah Kawalan Dahulu

| Dimensi | Hermes Agent | OpenClaw |
|---|---|---|
| Dibina oleh | Penyelidikan Nous | Peter Steinberger (pemaju bebas, Austria) |
| Kedudukan | Ejen AI yang berkembang sendiri | Ejen dan platform automasi tempatan pertama |
| Falsafah teras | Gelung Pembelajaran Pertama | Pesawat Kawalan Dahulu |
| Parit | "Pengumpulan" — lebih kuat lagi anda menggunakannya | "Sambungan" — dipalamkan ke dalam apa sahaja |
| Dalam satu baris | Menyelesaikan masalah **pengumpulan** | Menyelesaikan masalah **sambungan** |

Hermes mengambil namanya daripada tuhan utusan Yunani, membayangkan peranannya sebagai "pembawa mesej antara anda dan maklumat" yang terus memerhati, merakam dan berkembang bagi pihak anda. OpenClaw mengambil jalan lain: ia menjadikan dirinya sebagai **gerbang pusat** di mana 20+ platform pemesejan dan 25+ model boleh dilampirkan, dan kemudian meninggalkan **anda, manusia**, untuk menentukan setiap peraturan, setiap Kemahiran dan setiap pencetus.

Seseorang mahu menjadi rakan sejawat anda; yang lain mahu menjadi meja kawalan anda. Itulah perpecahan yang paling asas.

---

## 2. Seni bina: bersepadu vs berbentuk get laluan

**OpenClaw ialah struktur empat peringkat berbentuk pintu masuk:**

```
Gateway → Agent → Skills → Memory
```

Nilai kejuruteraan terasnya terletak di Gerbang: sama ada pengguna tiba dari WhatsApp, Telegram, Slack, Discord atau e-mel, semuanya menumpu ke sesi ejen yang sama. Pesawat kawalan bersih, dan kebenaran, pengauditan dan penghalaan semuanya hidup dalam lapisan get laluan.

**Hermes Agent ialah struktur bersepadu**: inferens model, pelaksanaan terminal, operasi fail, automasi penyemak imbas, pengambilan semula web, memori jangka panjang, tugas berjadual dan pemesejan berbilang platform terbina dalam sebagai modul **proses yang sama**. Ia berkelakuan kurang seperti penghala mesej dan lebih seperti pembantu yang mengembara bersama anda — satu dengan otak, tangan dan buku nota.

Akibatnya: **jika anda ingin menyambung lebih banyak platform, OpenClaw adalah lebih baik; jika anda mahu ejen itu sendiri menjadi lebih kuat, Hermes adalah lebih baik.**

---

## 3. Memori: dua fail Markdown statik lwn empat lapisan berstruktur

Di sinilah perbezaannya paling dramatik.

Memori ### OpenClaw: dua fail Markdown statik

- `MEMORY.md` menyimpan "fakta yang berterusan".
- `memory/YYYY-MM-DD.md` menyimpan "konteks perbualan hari itu".

Reka bentuknya terkawal dan sangat mesra editor teks. Tetapi ia mempunyai dua had terbina dalam:

1. Hanya **dua hari terakhir** log dimuatkan secara automatik; kenangan terdahulu memerlukan pengguna mencari secara manual.
2. Memori sepenuhnya **diformatkan manusia** teks percuma — ejen tidak mengambil bahagian dalam memutuskan perkara yang patut diingat.

### Hermes Memori ejen: empat lapisan bekerjasama

| Lapisan | Pembawa | Peranan |
|---|---|---|
| Memori segera | `MEMORY.md` + `USER.md` | "Bekukan" ke dalam gesaan sistem pada permulaan setiap sesi |
| Arkib sesi | Carian teks penuh SQLite + FTS5 + ringkasan LLM | Menyimpan setiap sesi; boleh diperoleh semula minggu kemudian |
| Kemahiran | `SKILL.md` fail | "bagaimana untuk melakukannya" ejen terkumpul sendiri |
| Pembekal luar | Honcho, Mem0, Supermemory, dsb. | Graf pengetahuan tambahan, carian semantik, profil pengguna |

Tindakan paling penting merentas empat lapisan tersebut ialah: **ejen itu sendiri memutuskan perkara yang masuk ke dalam `MEMORY.md`, perkara yang masuk ke dalam `USER.md` dan perkara yang dinaikkan pangkat menjadi Kemahiran.** Itulah asas fizikal untuk "memahami anda dengan lebih baik dari semasa ke semasa".

Artikel lain dalam kategori ini menggali pembahagian kerja antara `MEMORY.md` dan `USER.md`, strategi kemas kini mereka, dan perbezaan antara Kemahiran dan Ingatan.

---

## 4. Kemahiran: ditulis oleh manusia vs ditulis oleh ejen

Kemahiran ialah prosedur operasi boleh guna semula. Kedua-dua rangka kerja mempunyainya, tetapi ia diperoleh dengan cara yang sama sekali berbeza:

| Perbandingan | Hermes Agent | OpenClaw |
|---|---|---|
| Siapa yang menulisnya | Ejen **menyulingnya secara automatik** selepas menyelesaikan tugas yang rumit | Pengguna menulis Markdown dengan tangan |
| Pencetus | 5+ panggilan alat, pemulihan yang berjaya selepas ralat, dsb. | Dicipta dengan sengaja oleh pengguna |
| Pengoptimuman kendiri | Gelung refleksi kira-kira setiap 15 tugasan menulis semula Kemahiran lama | Tiada pengoptimuman automatik |
| Standard terbuka | Serasi dengan [agentskills.io](https://agentskills.io) | Diedarkan melalui pasaran ClawHub |
| Semakan keselamatan | Pengimbasan terbina dalam (suntikan segera, bukti kelayakan, risiko rantaian bekalan) | Audit Snyk pernah menandakan 1,467 daripada 5,700 kemahiran sebagai mencurigakan |

Dalam satu baris: **Kemahiran dalam Hermes ialah ingatan otot ejen; Kemahiran dalam OpenClaw ialah manual pengendalian yang diserahkan oleh pengguna kepada ejen.**

---

## 5. Evolusi kendiri: gelung Hermes paling sukar untuk diganti

Hermes Agent mempunyai tiga laluan pembelajaran terbina dalam yang bercantum antara satu sama lain:

1. **Laluan memori**: sesi mendarat di SQLite dan menjadi FTS5-boleh dicari selepas ringkasan.
2. **Laluan kemahiran**: selepas tugas yang rumit, Kemahiran berstruktur ditulis secara automatik (langkah, perangkap, kaedah pengesahan).
3. **Latihan latihan**: rekod panggilan alat setiap hari boleh berfungsi sebagai data latihan untuk model generasi seterusnya.

Pengguna Reddit telah melaporkan peningkatan kecekapan yang ketara pada tugasan penyelidikan berulang selepas Hermes mencipta tiga dokumen Kemahiran secara automatik dalam masa dua jam.

OpenClaw **tidak mempunyai** gelung ini. Ia berkelakuan lebih seperti penghala dan penjadual untuk ejen, dan evolusinya datang daripada **pengguna dan komuniti** menambahkan Kemahiran, memasang pemalam dan perkhidmatan pendawaian.

Kedua-dua laluan sememangnya lebih baik, tetapi anda harus tahu apa yang anda pilih: satu membenarkan **ejen berkembang dengan sendirinya**, satu lagi mempunyai **manusia mengajar ejen untuk berkembang**.

---

## 6. Keselamatan: kotak pasir secara lalai lwn dibuka secara lalai

| Dimensi | Hermes Agent | OpenClaw |
|---|---|---|
| Kotak pasir lalai | Akar kontena baca sahaja + penurunan keupayaan | Tiada |
| Keizinan | Gerbang kelulusan dihidupkan secara lalai | Pengesahan gateway dimatikan secara lalai |
| Pertahanan suntikan | Imbasan suntikan segera / kebocoran kelayakan terbina dalam | Tiada pengimbasan terbina dalam |
| Kerentanan yang diketahui | Perlindungan berlapis sebagai standard | 138 kelemahan didedahkan dalam 63 hari, 7 kritikal |

**Hermes' pendirian keselamatan adalah "dihalang secara lalai, longgar hanya apabila anda menyatakannya secara eksplisit"; OpenClaw adalah "buka secara lalai, ketatkan sendiri".** Yang pertama lebih mesra kepada individu yang sensitif privasi; yang kedua adalah lebih fleksibel untuk kawalan tersuai dalam rangkaian korporat.

---

## 7. Jadi yang manakah patut anda pilih?

**Keutamaan Hermes Agent jika anda:**

- Mahukan pembantu jangka panjang yang lebih memahami anda lebih banyak anda bercakap dengannya.
- Akan menggunakannya untuk pengurusan pengetahuan peribadi, penyelidikan jangka panjang atau penjejakan silang sesi.
- Nak kurangkan penggunaan token (ajar agen sekali, bukan setiap kali).

**Keutamaan OpenClaw jika anda:**

- Terutamanya perlu menyambung lebih banyak saluran dan lebih banyak alatan.
- Mempunyai kerjasama pasukan yang konkrit dan keperluan audit berpusat.
- Telah mengumpul banyak Kemahiran dan bot di dalam ekosistem OpenClaw.

---

## 8. Jika anda mahu Hermes tanpa membinanya sendiri

Tiga perkara Hermes Agent terbaik — ingatan jangka panjang, Kemahiran yang berkembang sendiri, akses berbilang platform — semuanya terletak pada premis fizikal yang sama: **ia perlu kekal dalam talian, mempunyai storan sendiri dan milik anda sahaja.**

Ini bermakna penggunaan yang ideal ialah **contoh awan yang tidak pernah menjadi luar talian**: ia tidak tidur sebentar apabila penutup komputer riba anda ditutup, `nudge_interval` menyala dengan pasti dan setiap terminal yang anda buka mencapai `~/.hermes/` yang sama.

Itulah yang dilakukan oleh [**LightVela**](https://lightvela.ai/). LightVela ialah **perkhidmatan Hermes Agent dihoskan awan** yang menguruskan segala-galanya di atas yang anda akan kendalikan sendiri:

- Aktifkan contoh awan khusus dalam satu klik, tanpa kehabisan bateri atau memori tempatan anda;
- Hermes Agent tulen di dalam, dengan `MEMORY.md` / `USER.md` / Kemahiran menggunakan mekanisme huluan asal;
- Dalam talian 24×7, jadi telefon, komputer riba, Telegram, Lark dan mana-mana saluran lain semuanya mencapai ejen yang sama yang mengenali anda;
- Data perbualan kekal pada pelayan khusus anda dan tidak dikongsi dengan pihak ketiga.

**Jika keupayaan yang berkembang sendiri di atas menarik minat anda tetapi anda lebih suka tidak menghabiskan hujung minggu pada Ollama, SSH, systemd dan strategi sandaran, LightVela kemungkinan besar adalah laluan terpendek anda.**

---

## Pengambilan utama

- Hermes dan OpenClaw kedua-duanya sangat baik; ia hanya memberikan masalah yang berbeza: **Hermes menjadikan AI berkembang, OpenClaw menjadikan AI menyambung.**
- Perbezaan paling dramatik ialah ingatan: dua fail Markdown statik untuk OpenClaw, empat lapisan berstruktur serta keputusan pihak ejen untuk Hermes.
- Kemahiran berpecah mengikut "ditulis oleh ejen" lwn "ditulis oleh pengguna"; keselamatan berpecah sepanjang "kotak pasir secara lalai" lwn "dibuka secara lalai".
- Pilih OpenClaw untuk menyambungkan segala-galanya; pilih Hermes untuk mempunyai ejen yang lebih memahami anda dari semasa ke semasa — dan gunakan LightVela jika anda mahukannya tanpa kerja pengehosan sendiri.
