# Batas Keamanan untuk Agent Telegram dan WhatsApp

Setelah menghubungkan Agent ke Telegram atau WhatsApp, keamanan bergantung tidak hanya pada modelnya tetapi juga pada kredensial kanal, cakupan percakapan, kebijakan memori, dan aturan tindakan eksternal.

Batas yang jelas seharusnya memberi tahu Anda siapa yang dapat menemukan Agent tersebut, pesan mana yang diproses, konten apa yang tidak boleh dikirim, dan tindakan mana yang membutuhkan konfirmasi.

Telegram mendukung pesan grup setelah Anda menonaktifkan Group Privacy di BotFather, menambahkan Bot ke grup, dan memulai percakapan dengan `@username_bot`.
Dukungan grup WhatsApp tetap mengikuti dokumentasi kanalnya sendiri.

![Merancang otorisasi, aturan grup, dan batas tindakan sensitif untuk Agent Telegram dan WhatsApp](../images/use-case-11-telegram-whatsapp-safety-boundaries.png)

## Ringkasan

**Batas keamanan sebuah Agent tidak ditentukan oleh modelnya saja. Ia dibangun dari empat lapisan: kredensial kanal, cakupan percakapan, kebijakan memori, dan aturan untuk tindakan eksternal.** Batas yang jelas membuat Anda dapat menjawab empat pertanyaan secara definitif — siapa yang dapat menjangkau Agent ini, pesan mana yang diproses, konten apa yang tidak boleh dikirim, dan tindakan mana yang membutuhkan konfirmasi lebih dulu. Praktik kuncinya: kredensial bersifat sensitif dan tidak boleh masuk ke konteks jangka panjang atau ditempelkan ke chat; kebijakan memori harus menghindari mengubah data sensitif menjadi catatan permanen; dan apa pun yang mengirim ke luar atau tak dapat dibalik membutuhkan langkah konfirmasi. Telegram mendukung pesan grup setelah Anda menonaktifkan Group Privacy di BotFather, menambahkan Bot ke grup, dan memulai percakapan dengan `@username_bot`. Selesaikan checklist keamanan sebelum ditayangkan.

## Untuk siapa ini

Panduan ini ditujukan bagi pengguna individu, pemimpin tim dukungan, dan administrator tim yang menghubungkan IM Agent ke pekerjaan sehari-hari.

Ia berguna bagi tim yang ingin menentukan cakupan otorisasi, batas data, dan prosedur tindakan berisiko tinggi sebelum menghubungkan Bot atau akun WhatsApp.

## Empat lapisan batas keamanan

| Lapisan | Pertanyaan yang dijawab | Kontrol yang tipikal |
|---|---|---|
| Otorisasi | Siapa yang dapat terhubung ke dan memakai Agent ini? | Bot token, akun terotorisasi via kode QR, catatan koneksi, izin akun |
| Percakapan | Percakapan mana yang diproses dan dijawab? | Cakupan chat pribadi, Group Privacy Telegram dan pemicu @mention, cakupan yang diizinkan |
| Data | Konten mana yang boleh dibaca atau dipertahankan? | Penyuntingan data sensitif, Cloud Storage, memori, profil pengguna, kebijakan penghapusan |
| Tindakan | Tindakan mana yang dapat berjalan otomatis? | Hak akses minimum, konfirmasi manusia, jejak audit, pengalihan ke manusia |

Mulai dari cakupan terkecil yang masih berguna lalu perluas izinnya hanya ketika pemakaian nyata membutuhkannya.

## Langkah-langkah

### 1. Pastikan target otorisasi untuk setiap kanal

Telegram terhubung melalui Bot Token, sementara WhatsApp terhubung melalui otorisasi kode QR.

Sebelum menghubungkan, pastikan hubungan antara Bot, akun WhatsApp, dan Hermes Agent tujuan, lalu masukkan kredensial hanya di pengaturan kanal LightVela yang sesuai.

Bot Token Telegram, sesi login WhatsApp, kode verifikasi, dan kredensial lain tidak boleh dikirim di chat biasa atau dituliskan ke dokumen, tiket, maupun repositori.

Bot Telegram atau nomor WhatsApp yang sama umumnya sebaiknya tidak diikat ke beberapa Hermes Agent, agar orang dapat mengetahui Agent mana yang menerima sebuah pesan.

Setelah terhubung, kirim pesan uji berisiko rendah, pastikan balasannya kembali ke kontak yang diharapkan, lalu tinjau daftar kanal terhubung di konsol.

### 2. Batasi cakupan kanal sesuai kemampuan saat ini

Telegram mendukung pesan grup.
Nonaktifkan Group Privacy di BotFather, tambahkan Bot ke grup, lalu mulai percakapan dengan `@username_bot`.
WhatsApp tetap mengikuti cakupan dukungan grup dalam dokumentasi kanalnya sendiri.

Jangan menyimpulkan dukungan grup LightVela dari pengaturan privasi BotFather Telegram atau dari kenyataan bahwa WhatsApp sendiri dapat membuat grup.

Jika kanal tujuan nantinya menambahkan dukungan grup, tentukan dulu grup, admin, anggota, perilaku @mention, dan batas laju pesan yang diizinkan.

Sebelum peluncuran grup, pastikan juga apakah pesan anggota masuk ke memori bersama dan bagaimana informasi satu anggota dicegah agar tidak ditampilkan kepada anggota lain.

### 3. Tetapkan batas konten pesan

Jangan mengirim kata sandi, API key, access token, kode verifikasi, informasi pembayaran, detail identitas lengkap, detail medis, atau data privasi pelanggan yang tidak perlu kepada Agent.

Jika sebuah kasus bisnis nyata memang harus dibahas, hapus nama, nomor telepon, alamat, nomor pesanan, dan informasi lain yang dapat mengidentifikasi seseorang atau organisasi.

Pakai aturan yang lebih ketat di kanal yang melibatkan banyak orang dan kolaborasi eksternal karena pesannya dapat terlihat oleh lebih banyak anggota, diteruskan, atau dipertahankan lebih lama.

### 4. Jaga memori dan file dalam cakupan seminimal yang diperlukan

Taruh aturan peran, suara, dan batasan yang stabil di [konfigurasi kepribadian SOUL.md](./im-agent-persona-soul-md.md).

Pelihara preferensi yang sudah dikonfirmasi dan konteks kolaborasi yang tahan lama melalui [Pengelolaan Memori](../configuration/memory.md).

Simpan material produk, FAQ dukungan, dan file referensi yang besar di [Cloud Storage](../configuration/files.md) alih-alih memasukkan setiap pesan chat mentah ke dalam memori jangka panjang.

Tinjau memori, profil pengguna, dan Cloud Storage secara berkala, lalu hapus informasi yang tidak lagi diperlukan atau yang seharusnya tidak dipertahankan.

### 5. Tetapkan ambang konfirmasi untuk tindakan sensitif

Tindakan yang normalnya membutuhkan konfirmasi manusia mencakup:

- Mengirim pesan eksternal atau memublikasikan konten.

- Mengubah pesanan, harga, langganan, izin, atau detail akun.

- Pengembalian dana, pembayaran, pemeriksaan identitas, atau komitmen hukum.

- Menghapus file, memori, data pengguna, atau data tak dapat dibalik lainnya.

- Menjalankan perintah yang memengaruhi lingkungan produksi atau sistem pihak ketiga.

Agent dapat membaca material, menata risiko, dan menyusun usulan lebih dulu, tetapi ia sebaiknya menjelaskan dampak, target, dan dapat-tidaknya dibalik sebelum eksekusi lalu menunggu konfirmasi yang eksplisit.

Jangan memperlakukan pertanyaan pengguna sebagai otorisasi untuk mengeksekusi sebuah tindakan.

### 6. Tambahkan batasan untuk Skill dan otomasi

Sebelum memasang Skill, pastikan sumbernya, izinnya, API eksternalnya, akses filenya, dan kemampuan pesan proaktifnya.

Uji Skill baru dalam percakapan satu lawan satu dengan material berisiko rendah sebelum memperluas pemakaiannya.

Setiap otomasi membutuhkan jadwal, jendela waktu aktif, metode notifikasi, kanal tujuan, dan cara menjeda yang eksplisit.

Untuk pesan proaktif WhatsApp, perhitungkan juga jendela percakapan dan templat pesan alih-alih mengasumsikan teks biasa akan selalu terkirim.

### 7. Rancang kegagalan dan pengalihan ke manusia

Ketika Agent tidak yakin, tidak dapat mengutip materialnya, menerima konten sensitif, menemukan otorisasi yang tidak jelas, atau menghadapi keluhan, ia sebaiknya menghentikan eksekusi otomatis lalu mengalihkan ke manusia.

Catatan pengalihannya sebaiknya memuat pemicunya, konten yang sudah diproses, tindakan yang belum selesai, dan langkah berikutnya yang disarankan.

Jika kredensial mungkin sudah terekspos, hentikan pemakaian kanal yang terdampak lalu cabut, reset, atau otorisasikan kembali melalui prosedur platformnya.

## Checklist keamanan pra-peluncuran

- Apakah setiap Bot Telegram atau akun WhatsApp dipetakan ke satu Agent yang jelas?

- Sudahkah Anda memastikan kredensial tidak muncul di chat, dokumen, kode, atau log?

- Sudahkah Anda menonaktifkan Group Privacy, menambahkan Bot ke grup, dan memverifikasi pesan grup Telegram dengan `@username_bot`?

- Sudahkah Anda menentukan apa yang boleh dipertahankan memori, file mana yang boleh diakses, dan bagaimana penghapusan bekerja?

- Apakah tindakan sensitif, pesan eksternal, dan perubahan tak dapat dibalik membutuhkan konfirmasi?

- Apakah Skill dan otomasi memiliki hak akses minimum, kanal tujuan yang eksplisit, dan cara menjeda?

- Apakah Anda memiliki prosedur untuk kredensial yang terekspos, pesan yang salah kirim, dan pengalihan ke manusia?

## FAQ

### Bisakah Telegram dan WhatsApp memakai kebijakan keamanan yang sama?

Keduanya dapat berbagi prinsipnya, tetapi perbedaan kanal tetap penting.

Keduanya sebaiknya melindungi kredensial, membatasi konten sensitif, dan mewajibkan konfirmasi untuk tindakan berisiko tinggi, sementara otorisasi, batas pesan proaktif, dan format pesan harus diverifikasi secara terpisah.

### Apakah menonaktifkan mode privasi Bot Telegram membuat pemakaian di grup menjadi aman?

Belum tentu.

Mode privasi mengubah cara Bot menerima pesan, tetapi ia tidak menggantikan dukungan LightVela untuk pemrosesan grup yang saat ini belum diekspos.

### Bisakah Agent menghapus memori atau file secara otomatis?

Penghapusan, penimpaan, dan tindakan tak dapat dibalik lainnya sebaiknya membutuhkan konfirmasi dan penjelasan tentang target serta dampaknya.

Bahkan permintaan melupakan yang disampaikan lewat percakapan pun sebaiknya mengidentifikasi informasi yang dimaksud dengan jelas alih-alih ditafsirkan sebagai permintaan penghapusan massal.

### Bisakah Agent layanan pelanggan langsung menerbitkan pengembalian dana atau mengubah pesanan?

Secara default sebaiknya tidak.

Kecuali izin sistem, orang yang mengotorisasi, alur konfirmasi, dan persyaratan auditnya eksplisit, biarkan Agent menyusun rekomendasi lalu menyerahkan kasusnya kepada manusia.

### Bagaimana jika saya tidak tahu apakah suatu informasi bersifat sensitif?

Sunting dulu bagian sensitifnya, atau jangan kirim.

Pakai data fiktif untuk meminta templat, alur kerja, atau saran keamanan alih-alih mengirimkan kredensial nyata atau data privasi pelanggan.

## Langkah berikutnya

- [Kanal Telegram](../configuration/channel-telegram.md) — Tinjau penyiapan bot Telegram dan cakupan pesan saat ini.

- [Kanal WhatsApp](../configuration/channel-whatsapp.md) — Tinjau otorisasi WhatsApp dan batas pesan proaktifnya.

- [Satu Agent di Telegram dan WhatsApp dengan Persona dan Memori yang Sama](./multi-channel-personality-memory.md) — Pahami batasan konfigurasi Agent yang dibagikan.

- [Konfigurasi Skill](../configuration/skill.md) — Tinjau izin Skill dan permintaan konfirmasi instalasi berisiko tinggi.
