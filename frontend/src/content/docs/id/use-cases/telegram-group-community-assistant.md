# Cara Menggunakan Asisten Komunitas AI Grup Telegram: Tanya Jawab, Ringkasan, dan Pengingat

## Ringkasan

**LightVela mendukung pesan grup Telegram setelah Anda menonaktifkan Group Privacy untuk Bot di BotFather, menambahkan Bot ke grup, lalu memulai percakapan dengan menyebutnya melalui `@username_bot`.**
Panduan ini menjelaskan penyiapan yang telah diverifikasi serta penggunaan Hermes Agent yang sama untuk tanya jawab, ringkasan, dan draf pengingat di grup.
Panduan ini tidak menganggap event anggota bergabung, sambutan otomatis, atau balasan pasif tanpa penyebutan Bot sebagai fitur yang sudah dikonfigurasi.

![Asisten komunitas AI grup Telegram untuk tanya jawab, ringkasan, dan pengingat](../images/use-case-08-telegram-group-community-assistant.png)

## Sebelum memulai

Hubungkan Bot Telegram ke Hermes Agent melalui [Kanal Telegram](../configuration/channel-telegram.md).
Anda juga perlu memiliki izin untuk menambahkan Bot tersebut ke grup Telegram yang akan digunakan.

## Mengaktifkan pesan grup Telegram

### 1. Pilih Bot di BotFather

1. Buka `@BotFather` di Telegram.
2. Kirim `/mybots`.
3. Pilih Bot yang sudah terhubung ke Hermes Agent Anda.

### 2. Nonaktifkan Group Privacy

1. Buka "Bot Settings".
2. Pilih "Group Privacy".
3. Pilih "Turn off" atau "Disable privacy mode".

Pengaturan ini memungkinkan Bot menerima pesan grup yang menyebutnya.

### 3. Tambahkan Bot ke grup Telegram

1. Buka grup Telegram yang ingin digunakan.
2. Pilih "Add Members" atau tindakan pengelolaan grup yang setara.
3. Cari Bot berdasarkan username-nya lalu tambahkan ke grup.

### 4. Sebut Bot untuk menguji pesan grup

Kirim pesan uji yang menyebut Bot, misalnya `@username_bot rangkum diskusi sejauh ini`.

Hasil yang diharapkan adalah Hermes Agent membalas di grup yang sama.

## Cakupan pesan yang telah diverifikasi

| Interaksi | Cakupan dokumentasi saat ini | Cara memverifikasi |
|---|---|---|
| Percakapan grup | Didukung setelah Bot ditambahkan ke grup, Group Privacy dinonaktifkan, dan pesan menyebut Bot | Kirim `@username_bot halo` di grup dan pastikan balasan muncul di sana |
| Percakapan pribadi | Didukung melalui Bot Telegram yang terhubung | Kirim pesan di chat pribadi Bot dan pastikan ada balasan |
| Sambutan otomatis saat anggota bergabung atau balasan pasif | Belum ditetapkan oleh panduan ini | Uji perilaku tersebut secara terpisah sebelum memasukkannya ke alur operasional |

## Menggunakan Bot sebagai asisten komunitas

Setelah uji grup berhasil, tentukan peran dan batas informasi melalui [panduan kepribadian SOUL.md](./im-agent-persona-soul-md.md).
Gunakan prompt grup yang jelas agar anggota mengetahui kapan mereka meminta Agent untuk menjawab.

| Alur kerja | Contoh prompt grup | Hasil yang perlu diperiksa |
|---|---|---|
| FAQ | `@username_bot jawab hanya dari FAQ yang sudah disiapkan` | Jawaban memakai materi yang disiapkan atau meminta pengalihan ke manusia |
| Ringkasan diskusi | `@username_bot rangkum keputusan, tindakan, penanggung jawab, dan pertanyaan terbuka` | Balasan memisahkan keputusan yang telah dikonfirmasi dari hal yang belum selesai |
| Draf pengingat | `@username_bot buat draf pengingat berisi waktu, audiens, tujuan, dan cara membatalkan` | Tinjau draf sebelum memakai tugas terjadwal untuk mengirimnya |

Untuk pengambilan referensi, ringkasan, atau konten terjadwal, pilih Skill tepercaya dan tinjau izinnya di [Konfigurasi Skill](../configuration/skill.md).
Validasi tugas terjadwal secara terpisah di kanal tujuan yang didukung sebelum mengandalkannya untuk pesan terjadwal.

## Batas keamanan dan operasional

Menonaktifkan Group Privacy membuka jalur pengiriman pesan grup Telegram.
Hal itu tidak menggantikan aturan grup, perlindungan informasi sensitif, atau konfirmasi sebelum tindakan eksternal berisiko tinggi.
Gunakan [panduan batas keamanan Telegram dan WhatsApp](./telegram-whatsapp-safety-boundaries.md) saat menentukan siapa yang dapat meminta Agent melakukan tindakan sensitif.

## FAQ

### Bisakah saya menambahkan Bot Telegram LightVela ke grup sekarang?

Bisa.
Nonaktifkan Group Privacy di BotFather, tambahkan Bot ke grup, lalu sebut Bot dengan `@username_bot` untuk memulai percakapan.

### Apakah menonaktifkan Group Privacy membuat Bot membalas di grup?

Itu adalah bagian wajib dari alur penyiapan yang didokumentasikan.
Setelah menonaktifkannya, tambahkan Bot ke grup dan kirim pesan uji yang menyebutnya.

### Apakah panduan ini mengonfigurasi sambutan otomatis untuk anggota baru?

Tidak.
Panduan ini mendokumentasikan percakapan grup yang dimulai dengan menyebut Bot.
Uji event anggota bergabung dan alur sambutan otomatis secara terpisah sebelum menjanjikannya kepada komunitas.

### Bisakah grup WhatsApp digunakan sebagai alternatif?

Dokumentasi kanal WhatsApp saat ini masih menyatakan bahwa chat grup tidak didukung.
Jangan menganggap dukungan pesan grup Telegram juga berlaku untuk WhatsApp.

## Langkah berikutnya

- [Kanal Telegram](../configuration/channel-telegram.md) - Hubungkan Bot dan ulangi langkah penyiapan pesan grup.

- [Mengubah IM Agent Menjadi Asisten Layanan, Komunitas, atau Pendamping](./im-agent-skill-scenarios.md) - Siapkan Skill dan konten untuk tanya jawab serta ringkasan di grup.

- [Menentukan Peran, Kepribadian, dan Suara IM Agent](./im-agent-persona-soul-md.md) - Tentukan peran dan batas asisten.
