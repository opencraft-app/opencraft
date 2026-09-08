## Ringkasan

**Satu Agent dapat muncul di beberapa aplikasi pesan karena aplikasi tersebut hanyalah pintu masuk — Agent-lah yang sebenarnya bekerja. Gateway pesan melakukan tiga tugas: menormalkan pesan yang berbeda secara struktural dari Telegram, WhatsApp, Discord, Slack, WeChat, dan lainnya menjadi satu format permintaan; merutekan setiap permintaan ke Agent yang sama berdasarkan konfigurasi koneksi Anda, alih-alih mengkloning kepribadian dan memori per platform; lalu setelah eksekusi mengantarkan hasilnya kembali ke percakapan persis tempat ia berasal. Karena identitas (`SOUL.md`), memori (`USER.md`, `MEMORY.md`), skill (`skills/`), dan tugas terjadwal semuanya hidup di luar lapisan kanal, sesuatu yang Anda sebutkan di Telegram tetap diketahui saat Anda menindaklanjutinya di WhatsApp. Namun terpadu tidak berarti tanpa batas: setiap kanal memiliki alur otorisasi, format pesan, dan batas pengiriman sendiri, kumpulan kanal yang didukung berbeda antara region global dan Tiongkok, dan setelah menghubungkan kanal baru Anda harus mengirim pesan uji untuk memastikan balasan mendarat di percakapan yang diharapkan.**

---

## Skenario yang diselesaikannya

Bayangkan satu hari pemakaian. Di Telegram Anda meminta Agent merangkum posisi sebuah proyek. Saat keluar tengah hari, Anda menindaklanjutinya di WhatsApp: "apa risiko pada opsi kedua yang kamu sebutkan?" Malamnya Anda memintanya memposting kesimpulan tersebut ke channel Slack atau Discord tim.

Jika ketiga interaksi itu berperilaku seperti tiga bot yang tak berhubungan, akses multi-platform tidak akan berharga — Anda akan menjelaskan ulang konteksnya setiap kali. Bentuk yang berguna itu berbeda: tiga pintu masuk, satu asisten.

Kesulitan di sini umumnya disalahpahami sebagai "mengintegrasikan beberapa API lagi." Integrasi API hanyalah pekerjaan di permukaan. Masalah sesungguhnya adalah: **membuat setiap pintu masuk mengarah ke identitas dan konteks yang sama, tanpa melanggar aturan milik masing-masing platform.** Gateway pesan adalah lapisan yang menyelesaikan ketegangan itu.

---

## 1. Pertama, sebuah koreksi: kanal bukan Agent

Pembedaan ini adalah prasyarat bagi semua hal lainnya.

| Konsep | Apa itu | Kardinalitas |
|---|---|---|
| **Kanal** | Pintu masuk untuk pesan, misalnya Telegram, WhatsApp, Discord, Slack, WeChat | Satu Agent dapat menghubungkan banyak |
| **Agent** | Subjek kerja yang bertahan, memegang identitas, memori, skill, tugas | Dibagikan oleh banyak kanal |

Orang secara naluriah memperlakukan "bot Telegram saya" sebagai entitas mandiri, yang secara alami memunculkan pertanyaan "jadi apakah bot WhatsApp saya itu bot yang berbeda?" Begitu kanal dipahami sebagai pintu masuk, bukan subjek, pertanyaan itu larut sendiri.

Jalur lengkapnya tampak seperti ini:

```text
Aplikasi pesan (banyak pintu masuk)
    ↓  pesan asli platform
Gateway pesan (normalkan / rutekan / antarkan)
    ↓  permintaan terpadu
Hermes Agent yang sama
    ↓
inferensi model + eksekusi tool + pemanggilan memori + pemuatan skill
    ↓  hasil eksekusi
Gateway pesan
    ↓  dikirim dalam format platform
Percakapan asal di kanal asal
```

Perhatikan langkah terakhir itu — *percakapan asal di kanal asal*. Itu bukan catatan kaki; itu salah satu masalah inti yang harus dituntaskan gateway dengan tepat, dibahas di bawah.

---

## 2. Tugas gateway satu: menerima dan menormalkan

Platform berbeda di nyaris setiap dimensi:

- **Pengenal pengguna berbeda** — ID numerik, nomor telepon, atau username internal platform.
- **Pengenal percakapan berbeda** — pesan langsung, grup, channel, dan thread masing-masing direpresentasikan berbeda.
- **Struktur pesan berbeda** — teks, gambar, suara, file, balasan berkutipan, dan reaksi semuanya punya desain kolomnya sendiri.
- **Model event berbeda** — sebagian mendorong lewat webhook, sebagian butuh koneksi persisten atau polling.

Jika Agent menghadapi perbedaan ini secara langsung, percabangan khusus platform akan menyebar ke intinya, dan setiap platform baru berarti menyentuh logika inti. Normalisasi mengurung perbedaan itu di gateway: pesan asli platform menjadi satu permintaan yang seragam, sehingga Agent hanya perlu memahami satu bentuk input.

Manfaat praktisnya: **menambahkan kanal seharusnya tidak menuntut perubahan pada logika identitas, memori, atau skill.** Agent peduli pada apa yang ditanyakan, bukan tata letak kolom aplikasi mana yang membawanya.

---

## 3. Tugas gateway dua: merutekan ke Agent yang sama

Inilah langkah yang membuat "satu kepribadian lintas platform" menjadi mungkin.

Begitu sebuah permintaan dinormalkan, gateway memakai **konfigurasi koneksi** Anda untuk menentukan permintaan itu milik Agent yang mana, lalu menyerahkan permintaan tersebut kepada Agent itu. Ia tidak memunculkan kepribadian atau penyimpanan memori baru hanya karena pesannya datang dari platform yang baru dihubungkan.

Ini penting karena ia menentukan apakah aset jangka panjang dibagikan atau terfragmentasi:

| Aset | Tempatnya | Perilaku lintas kanal |
|---|---|---|
| Identitas dan aturan perilaku | `SOUL.md` | Satu salinan, dibagikan semua kanal |
| Profil pengguna | `USER.md` | Satu salinan, dibagikan semua kanal |
| Fakta lintas sesi | `MEMORY.md` / `memories/` | Satu salinan, dibagikan semua kanal |
| Metode yang tertangkap | `skills/` | Satu salinan, dibagikan semua kanal |
| Tugas Terjadwal | Konfigurasi lapisan Agent | Terpisah dari kanal; target pengiriman dapat dikonfigurasi |

Karena semuanya berada di luar lapisan kanal, "ia masih tahu nama proyek yang saya sebutkan di Telegram" bukan fitur sinkronisasi yang harus dibangun seseorang — itu konsekuensi alami dari hanya adanya satu salinan.

Ini logika pemisahan yang sama dengan "mengganti model tidak menghilangkan memori": **pisahkan lapisan akses yang mudah berubah dari lapisan aset yang stabil.** Untuk versi argumen ini di sisi model, lihat "Bisakah Otak Hermes Agent Diganti? Lapisan Model vs Lapisan Agent."

---

## 4. Tugas gateway tiga: mengantar kembali ke tempat yang benar

Begitu Agent selesai, gateway mengirimkan hasilnya kembali. "Mengirimkannya kembali" lebih sulit dari kedengarannya, karena ia harus menjawab tiga pertanyaan dengan benar sekaligus:

1. **Platform mana** — pesan dari Telegram harus kembali ke Telegram, bukan WhatsApp.
2. **Percakapan mana** — di satu platform Anda mungkin punya pesan langsung plus beberapa grup dan channel. Membalas ke percakapan yang salah bukan sekadar memalukan; dalam konteks grup, itu dapat membocorkan informasi.
3. **Format mana** — platform berbeda dalam batas panjang pesan, dukungan Markdown, cara gambar dan file dikirim, serta ada tidaknya balasan berkutipan. Konten yang sama memerlukan penyajian berbeda per platform.

Poin kedua patut ditegaskan. **Target pengiriman yang salah adalah kelas masalah paling berat dalam penyiapan multi-kanal**: konten privat diposting ke grup, atau kesimpulan satu tim dikirim ke channel tim lain. Justru itulah sebabnya setiap kanal yang baru dihubungkan sebaiknya diverifikasi dulu dengan pesan uji di percakapan yang aman.

---

## 5. Terpadu tidak berarti tanpa batas

"Satu Agent, banyak pintu masuk" mudah dibaca berlebihan sebagai "semua platform berperilaku identik." Kenyataannya setiap kanal mempertahankan batasannya sendiri, dan berbagi satu Agent tidak menghapusnya.

### 5.1 Otorisasinya berbeda

Setiap platform punya alur koneksi dan bentuk kredensial sendiri: sebagian menuntut pembuatan bot di developer portal lalu menyalin token, sebagian menuntut pemindaian kode QR, sebagian menuntut AppID dan AppSecret. Dengan kata lain, **menghubungkan setiap kanal adalah langkah otorisasi yang independen** — satu penyiapan tidak mencakup semuanya.

### 5.2 Kanal yang didukung berbeda per region

Ini jebakan yang mudah ditemui saat membaca dokumentasi: region global dan Tiongkok pada LightVela tidak mendukung kumpulan kanal yang sama. Urutan kanal global adalah Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom, Lark. Region Tiongkok mendukung WeChat, QQ, WeCom, Lark, dan DingTalk.

Jadi ketika Anda melihat klaim seperti "Telegram didukung", pastikan itu berlaku untuk region yang mana alih-alih mengasumsikannya berlaku lintas region.

### 5.3 Konteks grup berbeda dari pesan langsung

Dalam pesan langsung Agent menghadapi satu orang; di grup ia menghadapi banyak. Grup menambah pertanyaan: kapan ia harus merespons, kapan harus diam, konten apa yang tidak pantas diuraikan secara publik, dan siapa yang boleh memicu tindakan sensitif. Ini termasuk aturan perilaku dan desain izin — gateway tidak dapat memutuskannya secara otomatis.

### 5.4 Kemampuan pengirimannya berbeda

Batas panjang pesan, dukungan rich text, pengiriman file, dan kemampuan mengutip pesan tertentu semuanya membentuk keluarannya. Balasan panjang yang tampil bersih di Discord mungkin perlu dipecah atau disederhanakan di tempat lain.

---

## 6. Urutan praktis untuk menghubungkan kanal baru

Mengubah prinsip di atas menjadi langkah, urutan ini menghindari sebagian besar masalah.

1. **Pastikan dukungan regional** — verifikasi kanal tersebut tersedia di region Anda, sehingga Anda tidak mengikuti dokumentasi yang ditulis untuk region lain.
2. **Selesaikan otorisasi di sisi platform** — ikuti panduan kanal tersebut untuk membuat bot atau memberi akses lalu memperoleh kredensialnya. Kredensial bersifat sensitif: jangan pernah menuliskannya ke file konteks jangka panjang atau menempelkannya ke chat.
3. **Hubungkan di sisi produk** — masukkan kredensialnya, simpan, lalu pastikan statusnya tampil sebagai terhubung.
4. **Kirim pesan uji** — pakai percakapan yang aman (pesan langsung atau grup uji) lalu pastikan Agent membalas.
5. **Verifikasi target pengiriman** — periksa secara khusus bahwa balasannya mendarat di **percakapan yang sama dengan tempat Anda mengirim pesan**, bukan percakapan lain.
6. **Verifikasi memori bersama** — tanyakan sesuatu yang Anda sampaikan kepadanya di kanal berbeda. Jawaban yang benar membuktikan kanal ini benar-benar mengarah ke Agent yang sama.
7. **Baru setelah itu tambahkan akses grup** — setelah pesan langsung lolos, bergabunglah ke grup lalu pastikan batas respons di dalam grup berperilaku seperti yang diharapkan.

Langkah 6 adalah yang paling sering dilewati orang, dan ia membawa nilai paling besar: itu cara paling langsung untuk memastikan kanal-kanal benar-benar berbagi satu Agent.

---

## 7. Gejala umum dan cara membacanya

| Gejala | Penyebab yang lebih mungkin | Tindakan yang disarankan |
|---|---|---|
| Tidak ada balasan sama sekali di kanal baru | Otorisasi belum lengkap atau kredensial salah | Periksa status koneksi dan kredensial, ulangi otorisasi |
| Balasan muncul di percakapan berbeda | Resolusi target pengiriman atau error konfigurasi | Berhenti memakainya di grup; pindah ke pesan langsung untuk mengisolasi |
| Membalas, tetapi "tidak mengenal saya" | Kemungkinan terhubung ke Agent yang berbeda | Verifikasi dengan fakta yang sudah diketahui lalu periksa koneksi itu mengarah ke Agent mana |
| Grup diam, pesan langsung normal | Aturan pemicu atau izin di dalam grup | Tinjau aturan respons grup dan izin yang dibutuhkan |
| Balasan panjang terpotong atau formatnya rusak | Batas pengiriman platform | Sesuaikan panjang dan format keluaran untuk platform tersebut |

Baris ketiga patut diperhatikan: **"tidak mengenal saya" di sini bermakna berbeda dibandingkan setelah penggantian model.** Setelah mengganti model, itu biasanya perbedaan gaya; pada kanal yang baru dihubungkan, itu lebih mungkin berarti kanal ini tidak mengarah ke Agent yang Anda asumsikan. Diagnostiknya sama — tanyakan satu fakta yang Anda yakin seharusnya ia ketahui.

---

## 8. Pendekatan LightVela: kanal sebagai pintu masuk yang dapat dipasang-lepas

Hermes memisahkan kanal dari Agent pada tingkat mekanisme, tetapi menghubungkan setiap platform tetap berarti menangani kredensial, callback, dan runtime sendiri. Arah LightVela adalah menjadikan lapisan itu sebagai pintu masuk yang terproduktisasi dan dapat dipasang-lepas:

- **Kanal adalah pengaturan** — hubungkan atau lepaskan di bawah satu Agent, tanpa perlu membuat Agent terpisah per platform.
- **Aset dibagikan secara default** — satu kepribadian, memori, kumpulan skill, dan kumpulan tugas terjadwal; kanal baru langsung memakainya kembali, tanpa ada yang perlu dimigrasikan.
- **Status koneksi terlihat** — konsol menampilkan apakah sebuah kanal terhubung, memudahkan Anda membedakan "belum pernah berhasil terhubung" dari "terhubung tetapi tidak membalas."
- **Perbedaan regional bersifat eksplisit** — region global dan Tiongkok masing-masing mencantumkan kanal yang didukungnya, mencegah kekeliruan lintas region.
- **Masalah dapat dilacak** — log terbaru di Diagnostik membantu memisahkan masalah otorisasi dari masalah pengiriman dan masalah tugas.

---

## Poin penting

- Kanal adalah pintu masuk; Agent adalah subjeknya. Banyak kanal berbagi satu Agent alih-alih satu bot per platform.
- Gateway melakukan tiga hal: **menormalkan** perbedaan platform, **merutekan** ke Agent yang sama, dan **mengantarkan** kembali ke percakapan asal.
- Identitas, memori, skill, dan tugas terjadwal hidup di luar lapisan kanal, sehingga kesinambungan lintas kanal adalah konsekuensi arsitektural, bukan fitur sinkronisasi tambahan.
- Terpadu tidak berarti tanpa batas: otorisasi, dukungan regional, konteks grup, dan batas pengiriman berbeda per kanal.
- Setelah menghubungkan sebuah kanal, verifikasi dua hal: bahwa balasan mendarat di percakapan yang diharapkan, dan bahwa ia benar-benar berbagi memori yang sama.
