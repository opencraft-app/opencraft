# Mengatur Kepribadian Hermes Agent di Telegram

Telegram adalah tempat Anda berbicara dengan Hermes Agent.
Kepribadian, gaya kerja, dan batasan Agent berasal dari persona serta konteks tahan lama milik Agent, bukan dari bot Telegram itu sendiri.

Panduan ini menunjukkan cara menghubungkan Hermes Agent ke Telegram dan memakai fitur kepribadian LightVela untuk memberinya peran, suara, dan kumpulan batas perilaku yang stabil.

![Hermes Agent dengan kepribadian yang khas di Telegram](../images/use-case-03-telegram-persona-agent.png)

## Ringkasan

**Telegram hanyalah pintu masuk. Yang menentukan bagaimana Agent berbicara, bagaimana ia bekerja, dan apa yang tidak akan ia lakukan adalah persona dan konteks jangka panjangnya.** Alurnya terbagi dua bagian: pertama hubungkan Hermes Agent ke Telegram mengikuti panduan kanal (buat bot dengan BotFather untuk memperoleh token, hubungkan di konsol, lalu pastikan tampil sebagai terhubung), kemudian pakai bagian Persona pada halaman pengaturan Agent untuk memilih peran, nada, dan kumpulan batas yang stabil lalu menyuntikkannya. Jaga ketiga lapisan tetap terpisah: persona memegang prinsip perilaku yang tahan lama, preferensi pengguna memegang bagaimana Anda ingin diperlakukan, dan memori jangka panjang memegang fakta yang sudah dikonfirmasi serta latar belakang proyek. Perhatikan bahwa kanal Telegram saat ini hanya mendukung percakapan satu lawan satu, bukan chat grup.

## Untuk siapa ini

Panduan ini ditujukan bagi orang yang ingin Hermes Agent dengan kepribadian yang konsisten di Telegram dalam jangka panjang.
Ia bekerja baik untuk asisten pribadi, mitra riset, pendamping belajar, atau asisten sehari-hari apa pun yang seharusnya berkomunikasi dengan cara yang dapat diprediksi.

Telegram saat ini terutama ditujukan untuk percakapan satu lawan satu.
Jika Anda perlu menghubungkan Telegram, mulai dari [Kanal Telegram](../configuration/channel-telegram.md).

## Prasyarat

- Hermes Agent LightVela yang sedang berjalan.
  Jika Anda belum membuatnya, mulai dari [Panduan Cepat](../02-quickstart.md).

- Konfigurasi model yang berfungsi atau kredit uji coba yang tersedia.
  Jika Hermes belum dapat membalas, selesaikan [Konfigurasi Model](../configuration/model.md).

- Akun Telegram dan Bot yang sudah terhubung dengan mengikuti [Kanal Telegram](../configuration/channel-telegram.md).

- Gambaran awal tentang peran yang Anda inginkan dari Agent tersebut.
  Bisa berupa asisten riset yang ringkas, mitra belajar yang sabar, atau asisten pengingat yang berorientasi eksekusi.

## Langkah / konsep kunci

### 1. Hubungkan Hermes Agent ke Telegram

Buka Hermes Agent tujuan di konsol LightVela, masuk ke "Channels", lalu pilih Telegram.
Ikuti [Kanal Telegram](../configuration/channel-telegram.md) untuk membuat Bot, menempelkan HTTP API token, dan mengirim pesan uji.

Pastikan Telegram muncul sebagai terhubung di konsol dan Bot tersebut menerima balasan Hermes Agent.
Verifikasi kanalnya lebih dulu agar masalah yang muncul nanti lebih mudah dibedakan dari persoalan konfigurasi kepribadian.

### 2. Jelaskan bagaimana Anda ingin Agent bekerja

Kepribadian yang khas lebih dari sekadar nama atau slogan.
Sebelum mengonfigurasinya, tuliskan peran, suara, gaya kerja, dan batasan yang ingin Anda jaga tetap stabil.

Pakai arahan singkat seperti ini sebagai titik awal:

```text
Kamu adalah asisten riset saya. Bantu saya menguraikan pertanyaan, membandingkan sumber yang andal, dan menulis kesimpulan yang jelas.
Berikan kesimpulan lebih dulu, lalu bukti kuncinya. Nyatakan ketidakpastian alih-alih menyajikan dugaan sebagai fakta.
Pakai nada yang profesional, langsung, dan ramah. Jangan berlebihan menggemaskan, dan jangan mengarang kepastian.
Minta konfirmasi sebelum mengirim pesan, mengubah file, atau melakukan tindakan eksternal lainnya.
```

Arahan ini membantu Anda memilih Soul yang sesuai dan memberi Anda kalimat untuk memperhalus perilaku Agent setelah Telegram terhubung.

### 3. Pilih lalu suntikkan Soul dari Personality

Buka pengaturan Agent tujuan lalu pilih bagian "Personality".
Anda dapat memilih "Draw random soul" atau "Soul personality test", lalu meninjau deskripsi pada setiap kartu.

Pilih Soul yang paling cocok dengan perannya lalu klik "Inject soul".
LightVela menuliskan persona terpilih ke `SOUL.md` milik Hermes Agent saat ini dan menyimpan backup sebelum menggantikan konfigurasi yang sudah ada.

Jika Agent tersebut sudah memiliki Soul lain, menyuntikkan yang baru akan menggantikan persona yang sedang aktif.
Tinjau peran, suara, dan batasan pada kartunya sebelum mengonfirmasi penggantian.

### 4. Mulai percakapan baru di Telegram

Setelah Soul disuntikkan, kembali ke chat Telegram lalu kirim:

```text
/new
```

Hermes Agent membaca `SOUL.md` yang baru ketika sebuah percakapan baru dimulai.
Jika Anda melanjutkan percakapan lama tanpa mengirim `/new`, percakapan itu mungkin masih memakai snapshot persona sebelumnya.

Begitu percakapan baru dimulai, minta pemeriksaan diri secara singkat:

```text
Dalam tiga kalimat, jelaskan peranmu saat ini, apa yang bisa kamu bantu, dan apa yang tidak akan kamu lakukan untuk saya.
```

### 5. Kalibrasi suaranya dengan tugas nyata

Jangan menilai kepribadiannya hanya dengan bertanya "Kamu siapa?".
Pakai beberapa tugas yang benar-benar akan Anda kirim dalam kehidupan sehari-hari, misalnya:

```text
Ubah material riset ini menjadi kesimpulan, bukti, dan pertanyaan yang masih perlu dikonfirmasi.
```

```text
Saya punya tiga tenggat waktu hari ini. Urutkan berdasarkan risiko, lalu beri saya rencana yang ringkas.
```

```text
Permintaan ini akan mengirim konten ke layanan eksternal. Apa yang akan kamu lakukan lebih dulu?
```

Periksa apakah Agent mempertahankan suara yang diharapkan, menandai ketidakpastian, dan menghormati batasan terkait tindakan eksternal.
Jika sesuatu merupakan preferensi khusus pengguna, seperti bahasa, zona waktu, atau format briefing Anda, minta Hermes mengingatnya alih-alih mengubah setiap preferensi menjadi aturan persona.

## Bagaimana kepribadian, preferensi pengguna, dan memori bekerja bersama

`SOUL.md` paling cocok untuk peran, suara, prioritas, dan batas perilaku Agent yang stabil.
Profil pengguna paling cocok untuk identitas, bahasa, zona waktu, dan preferensi komunikasi Anda.
Memori jangka panjang paling cocok untuk fakta yang sudah mapan, status proyek, dan konteks yang dapat dipakai ulang dari pekerjaan bersama Anda.

Untuk penjelasan yang lebih mendalam, baca [Dari Mana Kepribadian Hermes Agent Berasal](../hermes-agent/10-persona-user-memory.md) dan [Pengelolaan Memori](../configuration/memory.md).

## FAQ

### Apakah bot Telegram punya kepribadiannya sendiri?

Kepribadian tersebut termasuk pada Hermes Agent yang terhubung ke Telegram, bukan pada token BotFather.
Jika Hermes Agent yang sama terhubung ke kanal lain yang didukung, kanal-kanal itu memakai persona tingkat Agent dan konteks tahan lama yang sama.

### Apakah `/new` menghapus memori?

Tidak.
`/new` memulai percakapan baru agar `SOUL.md` yang baru dimuat saat sesi dimulai.
Ia tidak menghapus memori jangka panjang maupun profil pengguna milik Agent.

### Bisakah saya menambahkan bot Telegram ke sebuah grup?

Dokumentasi Telegram saat ini memperlakukan percakapan satu lawan satu sebagai mode utama yang didukung, dan perilaku di grup juga dipengaruhi konfigurasi kanal serta pengaturan privasi.
Jangan memakai panduan ini sebagai penyiapan chat grup; periksa [Kanal Telegram](../configuration/channel-telegram.md) untuk cakupan dukungan saat ini.

### Apakah mengganti model membuat Agent kehilangan kepribadiannya?

Umumnya tidak.
Model, persona Agent, dan memori jangka panjang adalah lapisan konfigurasi yang terpisah, meskipun mengganti model dapat mengubah reasoning, pemakaian tool, dan detail kecil pada gaya responsnya.

## Langkah berikutnya

- [Mengatur Kepribadian Hermes Agent di WhatsApp](./whatsapp-persona-agent.md) — Terapkan kepribadian Agent yang sama pada percakapan satu lawan satu di WhatsApp.

- [Menentukan Peran, Kepribadian, dan Suara IM Agent](./im-agent-persona-soul-md.md) — Pahami batas antara Soul, kepribadian, dan memori jangka panjang.

- [Kanal Telegram](../configuration/channel-telegram.md) — Ikuti alur koneksi bot Telegram secara lengkap.

- [Konfigurasi Skill](../configuration/skill.md) — Perluas kepribadian yang stabil dengan kemampuan tugas yang praktis.
