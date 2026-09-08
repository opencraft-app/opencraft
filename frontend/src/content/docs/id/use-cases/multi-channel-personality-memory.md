# Satu Agent di Telegram dan WhatsApp dengan Persona dan Memori yang Sama

Telegram dan WhatsApp dapat menjadi pintu masuk yang berbeda ke Hermes Agent yang sama.

Ketika kedua kanal terhubung ke Agent yang sama, keduanya dapat berbagi persona, Skill, tugas terjadwal, dan memori jangka panjang di tingkat Agent, sementara tiap kanal mempertahankan otorisasi dan batas pesannya sendiri.

![Satu Agent terhubung ke Telegram dan WhatsApp dengan satu kepribadian dan memori jangka panjang](../images/use-case-07-multi-channel-personality-memory.png)

## Ringkasan

**Telegram dan WhatsApp dapat berperan sebagai dua pintu masuk ke Hermes Agent yang sama. Selama kedua kanal terhubung ke Agent yang sama, keduanya berbagi persona, Skill, tugas terjadwal, dan memori jangka panjang di tingkat Agent, tanpa konfigurasi yang perlu diduplikasi per platform.** Namun "terpadu" memiliki cakupan yang terdefinisi: yang dibagikan adalah aset tingkat Agent, sementara tiap kanal mempertahankan alur otorisasi dan batas pesannya sendiri, sehingga menghubungkan keduanya adalah dua langkah otorisasi yang independen. Cara paling langsung untuk memastikan berbaginya adalah menyatakan sesuatu di satu kanal lalu menanyakannya di kanal lain — jawaban yang benar membuktikan kedua pintu masuk mengarah ke Agent yang sama. Setelah terhubung, pastikan juga balasannya mendarat di percakapan tempat Anda mengirim pesan, bukan percakapan lain.

## Untuk siapa ini

Panduan ini ditujukan bagi orang yang ingin berpindah antar aplikasi pesan sambil mempertahankan satu identitas asisten AI.

Ia berguna ketika Anda berpindah antara Telegram dan WhatsApp, atau ketika Anda ingin mengelola asisten pribadi, mitra riset, atau asisten penyusun draf dukungan dari satu tempat.

## Pahami apa arti "satu Agent"

Satu Agent tidak berarti kedua kanal berbagi setiap bagian transkrip chat yang sedang berlangsung secara real time.

Kedua pintu masuk berbagi konfigurasi tingkat Agent dan konteks tahan lama, sementara tiap percakapan saat ini tetap termasuk pada sesi kanalnya sendiri.

Jika Anda ingin kanal lain mengetahui sebuah fakta yang sudah dikonfirmasi, minta Hermes mengingatnya lalu verifikasi dari pintu masuk yang lain.

Persona, memori jangka panjang, dan Skill termasuk pada lapisan Agent, sementara Bot token, otorisasi kode QR, pintu masuk percakapan, dan format pesan termasuk pada lapisan kanal.

## Prasyarat

- Hermes Agent LightVela yang sedang berjalan.
  Jika Anda belum membuatnya, mulai dari [Panduan Cepat](../02-quickstart.md).

- Konfigurasi model yang berfungsi atau kredit uji coba yang tersedia.

- Akun Telegram dan Bot yang dapat Anda pakai secara normal.

- Akun WhatsApp yang dapat Anda pakai secara normal.

- Pemahaman tentang penyiapan pesan grup Telegram: nonaktifkan Group Privacy di BotFather, tambahkan Bot ke grup, lalu mulai percakapan dengan `@username_bot`.
- Pemahaman bahwa dukungan grup WhatsApp tetap mengikuti dokumentasi kanalnya sendiri.

## Langkah-langkah

### 1. Pilih satu Agent tujuan

Buka konsol LightVela lalu tentukan Hermes Agent tunggal mana yang seharusnya menerima koneksi Telegram sekaligus WhatsApp.

Jangan membuat satu Agent per kanal kecuali Anda memang sengaja menginginkan persona, memori, dan Skill yang berbeda.

### 2. Hubungkan Telegram

Ikuti [Kanal Telegram](../configuration/channel-telegram.md) untuk membuat Bot lalu menempelkan HTTP API token ke pengaturan kanal Telegram untuk Agent tujuan.

Kirim pesan uji di Telegram, pastikan konsol menampilkan kanal tersebut sebagai terhubung, dan pastikan balasannya kembali ke Bot yang diharapkan.

Jika Anda juga menginginkan kepribadian Telegram yang khas, lihat [Mengatur Kepribadian Hermes Agent di Telegram](./telegram-persona-agent.md).

### 3. Hubungkan WhatsApp

Di pengaturan kanal untuk Hermes Agent yang sama, pilih WhatsApp lalu selesaikan otorisasi kode QR dengan mengikuti [Kanal WhatsApp](../configuration/channel-whatsapp.md).

Buka kontak bot yang sesuai di WhatsApp, kirim pesan uji, dan pastikan balasannya kembali secara normal.

Jika Anda juga menginginkan kepribadian WhatsApp yang khas, lihat [Mengatur Kepribadian Hermes Agent di WhatsApp](./whatsapp-persona-agent.md).

### 4. Konfigurasikan satu kepribadian di tingkat Agent

Buka bagian "Personality" pada Agent tujuan lalu pastikan peran, suara, prioritas, dan batas perilaku di SOUL.md bekerja untuk kedua kanal.

Karena kepribadiannya berada di lapisan Agent, Anda tidak perlu mengonfigurasi dua salinan di Telegram dan WhatsApp.

Jika Anda perlu mengubah kepribadiannya, lihat [Menentukan Peran, Kepribadian, dan Suara IM Agent](./im-agent-persona-soul-md.md).

Setelah sebuah perubahan, mulai percakapan baru di tiap kanal lalu jalankan pemeriksaan diri singkat untuk memastikan kepribadian baru tersebut aktif.

### 5. Konfigurasikan memori dan profil pengguna di tingkat Agent

Buka "Memory" di konsol lalu pastikan kapasitas memori Agent dan profil pengguna sesuai dengan alur kerja Anda.

Telegram dan WhatsApp berbagi memori jangka panjang dari Agent cloud yang sama, sehingga Anda tidak perlu memasukkan identitas, bahasa, dan preferensi yang sama dua kali.

Di kanal mana pun, Anda dapat mengirim:

    Ingat bahwa saya ingin setiap briefing harian dimulai dengan kesimpulan lalu memberi tiga poin bukti kunci.

Kemudian berpindah ke kanal lain lalu kirim:

    Pakai format briefing harian yang saya atur sebelumnya dan tunjukkan contoh singkatnya.

Jika kedua kanal berperilaku berbeda, pertama pastikan keduanya terhubung ke Agent yang sama, lalu periksa apakah percakapan saat ini membutuhkan /new.

### 6. Pasang Skill bersama satu kali saja

Skill termasuk pada konfigurasi kemampuan Agent, sehingga Anda tidak perlu satu instalasi untuk Telegram dan satu lagi untuk WhatsApp.

Minta Hermes memasang Skill tersebut melalui percakapan di kanal mana pun, lalu minta ia memperbarui daftar Skill dan validasi Skill itu dengan tugas berisiko rendah.

Lihat [Konfigurasi Skill](../configuration/skill.md) untuk alur terperincinya, dan tinjau sumber Skill, izin, serta ketergantungan layanan eksternalnya sebelum mengonfirmasi instalasi.

### 7. Uji perbedaan yang bersifat khusus kanal

Jalankan prompt yang sama di kedua kanal:

    Jelaskan peranmu saat ini dan bagaimana kamu menangani ketidakpastian.

    Pakai preferensi tersimpan saya untuk mengubah konten ini menjadi tiga poin kunci.

Kemudian uji perilaku yang termasuk pada kanalnya, seperti pesan media, pengingat proaktif, atau bagaimana kontak Bot tersebut tampil.

Kepribadian dan memori jangka panjang seharusnya tetap konsisten, tetapi format pesan, kemampuan media, otorisasi, dan batas pengiriman proaktif dapat berbeda.

## Struktur yang berguna untuk satu Agent dan dua pintu masuk

    Satu Hermes Agent
    ├── satu SOUL.md
    ├── satu memori Agent dan profil pengguna
    ├── satu kumpulan Skill terpasang
    ├── satu kumpulan tugas terjadwal
    ├── pintu masuk Telegram
    └── pintu masuk WhatsApp

Metode notifikasi tugas terjadwal tetap membutuhkan kanal tujuan yang eksplisit.

Jangan mengasumsikan bahwa Agent yang dibagikan membuat setiap pengingat terkirim ke Telegram sekaligus WhatsApp.

## FAQ

### Apakah sesuatu yang saya minta Hermes ingat di Telegram akan muncul di WhatsApp?

Ya, ketika kedua kanal terhubung ke Hermes Agent yang sama dan informasinya tersimpan ke memori Agent atau profil pengguna.

Setiap pesan di percakapan Telegram saat ini tidak otomatis menjadi transkrip WhatsApp yang berlangsung.

### Mengapa kedua kanal tidak terdengar persis sama?

Format pesan kanal, kemampuan media, status sesi, dan keluaran model dapat memengaruhi detailnya.

Pertama pastikan kedua kanal terhubung ke Agent yang sama, lalu kirim /new bila perlu agar SOUL.md yang baru dimuat saat percakapan dimulai.

### Bisakah saya mengonfigurasi kepribadian yang berbeda untuk Telegram dan WhatsApp?

Ketika kedua kanal terhubung ke satu Agent, keduanya memakai kepribadian tingkat Agent yang sama secara default.

Jika Anda memerlukan peran dan memori yang benar-benar berbeda, buat Agent yang berbeda lalu hubungkan kanalnya secara terpisah.

### Bisakah grup WhatsApp berbagi memori dengan Telegram?

Dokumentasi WhatsApp saat ini menyatakan chat grup tidak didukung.
Telegram mendukung pesan grup setelah Anda menonaktifkan Group Privacy, menambahkan Bot ke grup, dan memulai percakapan dengan `@username_bot`.

Berbagi lintas kanal menjaga lapisan Agent tetap konsisten, tetapi ia tidak menambahkan kemampuan chat grup ke kanal mana pun.

### Apakah tugas terjadwal akan mengirim ke kedua kanal secara otomatis?

Tidak.

Ketika Anda membuat atau menyunting tugas terjadwal, pastikan metode notifikasi dan kanal tujuannya, lalu uji hasil pengirimannya secara terpisah.

## Langkah berikutnya

- [Bagaimana Hermes Agent Menghubungkan Beberapa Kanal Pesan](../hermes-agent/07-message-gateway.md) — Pahami hubungan antara kanal, gateway, dan lapisan Agent.

- [Pengelolaan Memori](../configuration/memory.md) — Tinjau pengelolaan memori Agent dan profil pengguna.

- [Kanal Telegram](../configuration/channel-telegram.md) — Selesaikan penyiapan bot Telegram.

- [Kanal WhatsApp](../configuration/channel-whatsapp.md) — Selesaikan otorisasi WhatsApp.

- [Mengubah IM Agent Menjadi Asisten Layanan, Komunitas, atau Pendamping](./im-agent-skill-scenarios.md) — Perluas kepribadian yang konsisten dengan alur kerja yang praktis.
