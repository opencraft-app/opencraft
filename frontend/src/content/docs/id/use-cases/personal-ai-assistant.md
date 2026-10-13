# Membangun Asisten AI Pribadi dengan LightVela

## Ringkasan

**Mulai asisten AI pribadi dengan membuat dan memilih satu Bot, lalu menguji balasan di Chat web memakai kredit model yang tersedia atau model yang sudah dikonfigurasi. Hubungkan kanal pesan hanya jika ingin memakai aplikasi tersebut. Selanjutnya, uji preferensi tetap di percakapan baru, tambahkan Skill untuk tugas tertentu, dan jadwalkan tugas setelah prompt-nya berhasil. Memori, Skill, kanal, dan tugas dikelola untuk Bot yang dipilih.**

![Percakapan Web Chat baru di konsol internasional LightVela](../../images/use-case-personal-ai-assistant.webp)

## Untuk siapa ini

Penyiapan ini bekerja baik jika Anda menginginkan satu asisten untuk perencanaan sehari-hari, tindak lanjut riset, pengingat, dan pertanyaan yang lebih baik dijawab dengan mengetahui preferensi Anda. Anda tidak memerlukan alur kerja yang kompleks. Mulailah dengan satu Hermes Agent dan satu kanal yang sudah rutin Anda periksa.

Ia sangat berguna ketika Anda mendapati diri Anda mengulang konteks seperti zona waktu Anda, format yang Anda sukai untuk ringkasan, proyek yang sedang Anda kerjakan, atau jenis bantuan yang Anda inginkan setiap pagi.

## Prasyarat

- Akun LightVela dan Hermes Agent yang sedang berjalan. Jika Anda belum membuatnya, mulai dari [Panduan Cepat](../02-quickstart.md).

- Chat web sudah cukup untuk memulai. Jika lebih suka aplikasi pesan, hubungkan kanal sesuai petunjuk berikut.

- Konfigurasi model yang berfungsi atau kredit uji coba yang tersedia. Lihat [Konfigurasi Model](../configuration/model.md) jika Hermes belum dapat membalas.

- Gambaran singkat tentang apa yang pertama-tama ingin Anda bantu. Satu rutinitas saja, seperti merencanakan hari Anda atau mengumpulkan tindak lanjut, sudah cukup.

## Langkah / konsep kunci

### 1. Beri Hermes tempat dalam rutinitas harian Anda

Pilih avatar Bot yang dituju pada deretan Bot. Pada layar sempit, buka panel navigasi terlebih dahulu. Pastikan namanya sebelum mengubah model, memori, Skill, kanal, atau tugas terjadwal. Chat web dan daftar percakapan mengikuti Bot yang dipilih; Bot tambahan juga dapat memakai Chat web. Chat web tidak memerlukan kanal pesan.

Chat web sudah cukup untuk memulai. Jika lebih suka aplikasi pesan, hubungkan kanal sesuai petunjuk berikut.

Jika ingin memakai aplikasi pesan, hubungkan satu kanal dan pastikan Bot membalas di sana. Ikuti panduan untuk [Telegram](../configuration/channel-telegram.md), [WhatsApp](../configuration/channel-whatsapp.md), [Discord](../configuration/channel-discord.md), [WeChat](../configuration/channel-wechat.md), [Slack](../configuration/channel-slack.md).

![Halaman Channel di konsol LightVela](../../images/personal-ai-assistant-channel.webp)

Mulailah dengan perkenalan yang jelas alih-alih permintaan yang luas. Misalnya:

```text
Saya ingin kamu menjadi asisten perencanaan pribadi saya. Saya memakai waktu Singapura.
Jaga rencana harian tetap singkat, sebut tenggat waktu lebih dulu, dan ajukan satu pertanyaan lanjutan ketika ada yang tidak jelas.
```

### 2. Biarkan memori membawa konteks yang berulang

Hermes membangun konteks yang berguna seiring waktu, sehingga Anda tidak perlu menyatakan ulang setiap preferensi di setiap percakapan. Beri tahu ia fakta dan preferensi kerja yang seharusnya tetap berguna: zona waktu Anda, bagaimana Anda ingin briefing disusun, nama proyek yang penting, atau hari-hari ketika Anda lebih suka merencanakan lebih awal.

Anda juga dapat menyatakan permintaannya secara langsung:

```text
Ingat bahwa saya lebih suka briefing hari kerja yang ringkas pukul 08.00,
berisi rapat, tenggat waktu, dan tiga tindakan berikutnya yang paling penting.
```

Gunakan halaman [Pengelolaan Memori](../configuration/memory.md) untuk meninjau memori dan informasi profil pengguna yang sudah dikumpulkan Hermes. Memori seharusnya mengurangi pengulangan, bukan menjadi tempat penampungan setiap detail yang lewat.

Mengingat preferensi ringkasan hari kerja pukul 08.00 tidak membuat tugas terjadwal. Atur jadwal secara terpisah, periksa eksekusi pertama, dan pastikan hasil terkirim ke kanal notifikasi yang dipilih.

### 3. Tambahkan Skill hanya ketika sebuah tugas nyata membutuhkannya

Hermes dapat mengobrol tanpa Skill tambahan. Tambahkan satu ketika Anda dapat menyebutkan pekerjaan praktis yang seharusnya ia bantu, seperti mencari informasi, menata daftar to-do, atau menyiapkan laporan berulang. Ini menjaga asisten tersebut tetap mudah dipahami dan lebih mudah dipercaya.

![Halaman Skills di konsol LightVela](../../images/personal-ai-assistant-skills.webp)

Telusuri opsi yang sesuai di ClawHub, lalu pakai [Konfigurasi Skill](https://lightvela.ai/docs/configuration/skill) untuk memasangnya. Sebelum memasang apa pun, baca deskripsinya dan pilih sumber yang Anda percayai.

### 4. Ubah percakapan yang berguna menjadi pemeriksaan berkala

Begitu sebuah prompt terbukti berguna secara konsisten, putuskan apakah ia sebaiknya berjalan sesuai jadwal. Tugas Terjadwal sederhana dapat meminta rencana pagi, tinjauan akhir hari, atau reset pekanan kepada Hermes tanpa Anda perlu ingat untuk memulai percakapannya.

Misalnya:

```text
Setiap hari kerja pukul 08.00, siapkan rencana ringkas untuk hari ini.
Mulai dengan tenggat waktu dan rapat, lalu sarankan tiga tindakan berikutnya yang terfokus.
```

Atur jadwal dan kanal notifikasinya di [Tugas Terjadwal](../configuration/automation.md). Jaga tugas terjadwal pertama tetap kecil; Anda dapat memperhalus instruksinya setelah melihat beberapa hasil nyata.

![Templat tugas resmi di halaman Tugas Terjadwal LightVela](../../images/personal-ai-assistant-automations.webp)

## Periksa setiap lapisan

| Lapisan | Pemeriksaan | Batasan |
| --- | --- | --- |
| Bot dan Chat web | Pilih Bot yang dituju dan kirim pesan singkat | Balasan memerlukan Bot daring serta kredit atau konfigurasi model yang dapat digunakan |
| Memori | Sampaikan preferensi tetap, buka percakapan baru, lalu periksa | Percakapan baru tidak menghapus memori jangka panjang |
| Tugas terjadwal | Periksa jadwal, kanal notifikasi, dan hasilnya | Pembuatan atau penyalinan Bot tidak menyalin tugas terjadwal maupun koneksi kanal |

## Verifikasi hasil

Pastikan Chat web membalas sebelum menghubungkan kanal. Uji preferensi yang diingat dalam percakapan baru dan periksa hasil tugas terjadwal pertama. Jika kanal atau tugas gagal, periksa Bot yang dipilih, konfigurasi, dan statusnya sebelum menambah fitur.

## FAQ

### Apakah saya perlu mengonfigurasi setiap fitur sebelum Hermes berguna?

Chat web sudah cukup untuk memulai. Jika lebih suka aplikasi pesan, hubungkan kanal sesuai petunjuk berikut.

### Apakah Hermes akan mengingat setiap pesan yang saya kirim?

Tidak. Memori dimaksudkan untuk informasi yang tetap berguna lintas percakapan, seperti preferensi, pekerjaan berulang, dan konteks yang stabil. Anda dapat meminta Hermes mengingat atau melupakan informasi bila perlu, lalu meninjaunya di Pengelolaan Memori.

### Bisakah saya memakai asisten yang sama dari lebih dari satu kanal?

Ya, jika kanal-kanal tersebut terhubung ke Bot yang sama. Memori jangka panjang dan preferensi dimiliki Bot tersebut. Bot lain punya ruang kerja sendiri: penyalinan hanya memberi salinan awal, bukan sinkronisasi perubahan berikutnya.

### Apa yang sebaiknya saya tugas terjadwalkan lebih dulu?

Pilih tugas yang sudah Anda ulangi pada waktu yang dapat diprediksi. Perencanaan pagi, tinjauan harian singkat, atau pemeriksaan prioritas pekanan adalah kandidat pertama yang baik karena Anda dapat cepat menilai apakah keluarannya membantu.

## Kesimpulan

Fokuskan asisten pertama pada satu rutinitas. Setelah chat, memori, dan tugas terjadwal pertama berfungsi pada Bot yang dipilih, perluas tanggung jawabnya secara bertahap.
