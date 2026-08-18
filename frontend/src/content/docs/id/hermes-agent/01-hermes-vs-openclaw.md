

## Ringkasan

**Perbedaan mendasar antara Hermes Agent dan OpenClaw adalah "akumulasi" versus "koneksi": Hermes, yang dibangun oleh Nous Research, adalah agent yang berkembang sendiri dan dirancang untuk makin memahami Anda seiring waktu. Hermes memperlakukan memori jangka panjang (`USER.md` / `MEMORY.md` / SQLite+FTS5 / Skill) sebagai warga kelas satu, dan agent itu sendiri yang memutuskan apa yang perlu diingat dan kapan sesuatu dinaikkan menjadi Skill. OpenClaw, yang dipimpin Peter Steinberger, adalah agent local-first sekaligus gateway otomasi yang dirancang untuk "menghubungkan segalanya": 25+ model dan 20+ platform pesan dapat dipasang, sementara Skill ditulis tangan oleh pengguna dan didistribusikan melalui ClawHub. Memilih Hermes berarti memilih mitra yang makin kuat seiring waktu; memilih OpenClaw berarti memilih meja kendali yang dapat terhubung ke apa pun.**

---

## Mengapa dua agent open-source ini terus dibandingkan

Dalam lanskap AI agent open-source 2026, dua nama ini nyaris tidak mungkin dihindari. Keduanya mengiklankan "local-first, dapat di-hosting sendiri, integrasi chat lintas platform", keduanya menyebut diri sebagai framework agent serbaguna, dan pada pandangan pertama halaman utama mereka tampak seperti produk yang bersaing.

Namun setelah sepekan pemakaian nyata, dua pertanyaan mulai mengganggu:

- Mengapa OpenClaw tetap "mulai dari nol setiap kali" bahkan setelah Anda memasang puluhan plugin, sementara Hermes menyebut sendiri nama proyek pekan lalu hanya setelah dua hari?
- Mengapa OpenClaw mengungkap 138 kerentanan dalam 63 hari (7 di antaranya kritis), sementara halaman security advisory Hermes hampir kosong?

Jawabannya: **keduanya sebenarnya menjawab dua pertanyaan yang sama sekali berbeda.**

- OpenClaw menjawab: "Bagaimana saya menghubungkan satu agent ke setiap kanal dalam hidup saya?"
- Hermes Agent menjawab: "Bagaimana saya membuat agent yang makin memahami saya seiring waktu?"

Bagian berikut menelusuri perbedaan itu dari enam dimensi: **positioning, arsitektur, memori, Skill, evolusi diri, dan keamanan.**

---

## 1. Positioning: Learning Loop First vs Control Plane First

| Dimensi | Hermes Agent | OpenClaw |
|---|---|---|
| Dibangun oleh | Nous Research | Peter Steinberger (developer independen, Austria) |
| Positioning | AI agent yang berkembang sendiri | Platform agent dan otomasi local-first |
| Filosofi inti | Learning Loop First | Control Plane First |
| Keunggulan bertahan | "Akumulasi" — makin kuat makin sering dipakai | "Koneksi" — dapat dipasang ke apa pun |
| Dalam satu baris | Menyelesaikan masalah **akumulasi** | Menyelesaikan masalah **koneksi** |

Hermes mengambil namanya dari dewa pembawa pesan Yunani, mengisyaratkan perannya sebagai "pembawa pesan antara Anda dan informasi" yang terus mengamati, mencatat, dan berkembang untuk Anda. OpenClaw mengambil jalan lain: ia menjadikan dirinya **gateway pusat** tempat 20+ platform pesan dan 25+ model dapat dipasang, lalu menyerahkan kepada **Anda, manusianya**, untuk mendefinisikan setiap aturan, setiap Skill, dan setiap pemicu.

Yang satu ingin menjadi mitra Anda; yang lain ingin menjadi meja kendali Anda. Itulah pemisahan paling mendasar.

---

## 2. Arsitektur: terintegrasi vs berbentuk gateway

**OpenClaw memakai struktur empat tahap berbentuk gateway:**

```
Gateway → Agent → Skills → Memory
```

Nilai rekayasa intinya ada di Gateway: entah pengguna datang dari WhatsApp, Telegram, Slack, Discord, atau email, semuanya bermuara ke sesi agent yang sama. Control plane-nya bersih, dan izin, audit, serta routing semuanya berada di lapisan gateway.

**Hermes Agent memakai struktur terintegrasi**: inferensi model, eksekusi terminal, operasi file, otomasi browser, pencarian web, memori jangka panjang, tugas terjadwal, dan pesan lintas platform dibangun sebagai modul dari **proses yang sama**. Perilakunya lebih mirip asisten yang ikut bepergian bersama Anda — lengkap dengan otak, tangan, dan buku catatan — dibandingkan sebuah router pesan.

Konsekuensinya: **jika Anda ingin menghubungkan lebih banyak platform, OpenClaw lebih unggul; jika Anda ingin agent itu sendiri yang makin kuat, Hermes lebih unggul.**

---

## 3. Memori: dua file Markdown statis vs empat lapisan terstruktur

Di sinilah perbedaannya paling dramatis.

### Memori OpenClaw: dua file Markdown statis

- `MEMORY.md` menyimpan "fakta permanen".
- `memory/YYYY-MM-DD.md` menyimpan "konteks percakapan hari itu".

Desainnya ringkas dan sangat bersahabat dengan editor teks. Namun ada dua batas bawaan:

1. Hanya log **dua hari terakhir** yang dimuat otomatis; memori yang lebih lama harus dicari manual oleh pengguna.
2. Memori seluruhnya berupa teks bebas **berformat manusia** — agent tidak ikut memutuskan apa yang layak diingat.

### Memori Hermes Agent: empat lapisan yang saling bekerja sama

| Lapisan | Wadah | Peran |
|---|---|---|
| Memori prompt | `MEMORY.md` + `USER.md` | "Dibekukan" ke dalam system prompt di awal setiap sesi |
| Arsip sesi | SQLite + pencarian teks penuh FTS5 + ringkasan LLM | Menyimpan setiap sesi; dapat ditemukan berminggu-minggu kemudian |
| Skill | File `SKILL.md` | "Cara mengerjakannya" yang dikumpulkan agent sendiri |
| Penyedia eksternal | Honcho, Mem0, Supermemory, dan lainnya | Melengkapi knowledge graph, pencarian semantik, profil pengguna |

Tindakan terpenting di keempat lapisan itu adalah: **agent itu sendiri yang memutuskan apa yang masuk ke `MEMORY.md`, apa yang masuk ke `USER.md`, dan apa yang dinaikkan menjadi Skill.** Itulah dasar fisik dari "makin memahami Anda seiring waktu".

Artikel lain di kategori ini membahas lebih dalam pembagian tugas antara `MEMORY.md` dan `USER.md`, strategi pembaruannya, serta perbedaan antara Skill dan Memory.

---

## 4. Skill: ditulis manusia vs ditulis agent

Skill adalah prosedur kerja yang dapat dipakai ulang. Kedua framework memilikinya, tetapi cara memperolehnya benar-benar berbeda:

| Perbandingan | Hermes Agent | OpenClaw |
|---|---|---|
| Siapa yang menulis | Agent **menyarikannya otomatis** setelah menyelesaikan tugas kompleks | Pengguna menulis Markdown secara manual |
| Pemicu | 5+ pemanggilan tool, pemulihan berhasil setelah error, dan sebagainya | Dibuat secara sengaja oleh pengguna |
| Optimasi diri | Loop refleksi kira-kira setiap 15 tugas menulis ulang Skill lama | Tidak ada optimasi otomatis |
| Standar terbuka | Kompatibel dengan [agentskills.io](https://agentskills.io) | Didistribusikan melalui marketplace ClawHub |
| Tinjauan keamanan | Pemindaian bawaan (prompt injection, kredensial, risiko supply chain) | Audit Snyk pernah menandai 1.467 dari 5.700 skill sebagai mencurigakan |

Dalam satu baris: **Skill di Hermes adalah memori otot milik agent; Skill di OpenClaw adalah buku panduan operasi yang diserahkan pengguna kepada agent.**

---

## 5. Evolusi diri: loop yang paling sulit digantikan pada Hermes

Hermes Agent memiliki tiga jalur pembelajaran bawaan yang saling terkait:

1. **Jalur memori**: sesi tersimpan ke SQLite lalu dapat dicari lewat FTS5 setelah diringkas.
2. **Jalur Skill**: setelah tugas kompleks, sebuah Skill terstruktur ditulis otomatis (langkah, jebakan, cara verifikasi).
3. **Jalur pelatihan**: catatan pemanggilan tool sehari-hari sendiri dapat menjadi data pelatihan untuk model generasi berikutnya.

Pengguna Reddit melaporkan lonjakan efisiensi yang terlihat pada tugas riset berulang setelah Hermes otomatis membuat tiga dokumen Skill dalam dua jam.

OpenClaw **tidak memiliki** loop ini. Perilakunya lebih mirip router dan penjadwal bagi agent, dan evolusinya datang dari **pengguna serta komunitas** yang menambahkan Skill, memasang plugin, dan menyambungkan layanan.

Tidak ada jalur yang secara inheren lebih baik, tetapi Anda perlu tahu apa yang Anda pilih: yang satu membiarkan **agent tumbuh sendiri**, yang lain mengandalkan **manusia mengajari agent untuk tumbuh**.

---

## 6. Keamanan: sandbox secara default vs terbuka secara default

| Dimensi | Hermes Agent | OpenClaw |
|---|---|---|
| Sandbox default | Root container read-only + pelepasan capability | Tidak ada |
| Otorisasi | Gerbang persetujuan aktif secara default | Autentikasi gateway nonaktif secara default |
| Pertahanan injeksi | Pemindaian prompt-injection / kebocoran kredensial bawaan | Tidak ada pemindaian bawaan |
| Kerentanan yang diketahui | Perlindungan berlapis sebagai standar | 138 kerentanan diungkap dalam 63 hari, 7 kritis |

**Sikap keamanan Hermes adalah "ketat secara default, dilonggarkan hanya bila Anda menyatakannya secara eksplisit"; sikap OpenClaw adalah "terbuka secara default, perketat sendiri".** Yang pertama lebih bersahabat bagi individu yang sensitif terhadap privasi; yang kedua lebih fleksibel untuk kontrol kustom di dalam jaringan perusahaan.

---

## 7. Jadi, mana yang sebaiknya Anda pilih?

**Utamakan Hermes Agent jika Anda:**

- Menginginkan asisten jangka panjang yang makin memahami Anda seiring makin banyak percakapan.
- Akan memakainya untuk pengelolaan pengetahuan pribadi, riset jangka panjang, atau pelacakan lintas sesi.
- Ingin menekan konsumsi token (ajari agent sekali saja, bukan setiap kali).

**Utamakan OpenClaw jika Anda:**

- Terutama perlu menghubungkan lebih banyak kanal dan lebih banyak tool.
- Memiliki kebutuhan konkret untuk kolaborasi tim dan audit terpusat.
- Sudah mengumpulkan banyak Skill dan bot di dalam ekosistem OpenClaw.

---

## 8. Jika Anda menginginkan Hermes tanpa membangunnya sendiri

Tiga hal yang paling dikuasai Hermes Agent — memori jangka panjang, Skill yang berkembang sendiri, akses lintas platform — semuanya bersandar pada premis fisik yang sama: **ia harus tetap online, memiliki penyimpanan sendiri, dan hanya milik Anda.**

Artinya, deployment ideal adalah **instans cloud yang tidak pernah offline**: ia tidak tertidur saat penutup laptop Anda ditutup, `nudge_interval` berjalan andal, dan setiap terminal yang Anda buka menuju `~/.hermes/` yang sama.

Itulah yang dilakukan [**LightVela**](https://lightvela.ai/). LightVela adalah **layanan Hermes Agent berbasis cloud** yang menangani semua hal di atas yang seharusnya Anda kerjakan sendiri:

- Aktifkan instans cloud khusus dengan satu klik, tanpa menguras baterai atau memori lokal Anda;
- Hermes Agent asli di dalamnya, dengan `MEMORY.md` / `USER.md` / Skill memakai mekanisme upstream orisinal;
- Online 24×7, sehingga ponsel, laptop, Telegram, Lark, dan kanal lain semuanya menuju agent yang sama dan mengenal Anda;
- Data percakapan tetap berada di server khusus Anda dan tidak dibagikan ke pihak ketiga.

**Jika kemampuan berkembang sendiri di atas menarik bagi Anda tetapi Anda enggan menghabiskan akhir pekan untuk Ollama, SSH, systemd, dan strategi backup, LightVela sangat mungkin menjadi jalur terpendek Anda.**

---

## Poin penting

- Hermes dan OpenClaw keduanya sangat baik; keduanya hanya melayani masalah berbeda: **Hermes membuat AI tumbuh, OpenClaw membuat AI terhubung.**
- Perbedaan paling dramatis ada pada memori: dua file Markdown statis untuk OpenClaw, empat lapisan terstruktur plus keputusan di sisi agent untuk Hermes.
- Skill terbelah antara "ditulis agent" dan "ditulis pengguna"; keamanan terbelah antara "sandbox secara default" dan "terbuka secara default".
- Pilih OpenClaw untuk menghubungkan segalanya; pilih Hermes untuk memiliki agent yang makin memahami Anda seiring waktu — dan pakai LightVela jika Anda menginginkannya tanpa kerja hosting sendiri.
