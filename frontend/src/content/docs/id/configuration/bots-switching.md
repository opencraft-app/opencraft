# Beralih Antar Bot

## Ringkasan

**Beralih Antar Bot memungkinkan satu Hermes Agent cloud LightVela memiliki beberapa Bot khusus. Anda dapat membuat Bot untuk riset, perencanaan, pemrograman, konten, dukungan, atau alur kerja berulang, lalu beralih di antara Bot tersebut dari menu profil Agent.**

**Setiap Bot memiliki konteks ruang kerja sendiri. Saat membuat Bot kosong atau menggandakan Bot yang sudah ada, LightVela menerapkan aturan pewarisan yang berbeda untuk pengaturan model, memori, Skill, Soul, tugas terjadwal, dan koneksi kanal.**

## Sebelum memulai

- Masuk ke LightVela dan buka Hermes Agent cloud yang aktif.
- Untuk membuat Bot tambahan, pastikan paket Anda masih mengizinkan Bot baru dan tidak ada Bot lain yang sedang dibuat atau dihapus.
- Jika Anda akan menghubungkan kanal, siapkan kredensial atau metode otorisasi yang diperlukan kanal tersebut.

## Membuat Bot

Setelah memilih **Bot Baru**, pilih avatar, masukkan nama dan deskripsi, lalu pilih untuk membuat Bot kosong atau menggandakan Bot yang sudah ada.

Jika Bot lain sudah ada, dialog pembuatan dapat menawarkan **Salin Bot saat ini**, **Salin Bot utama**, atau **Buat kosong**.

Sebagai contoh, untuk membuat Bot Analis Keuangan, Anda dapat memasukkan:

> <strong>Nama:</strong> Alpha Analyst
>
> <strong>Deskripsi:</strong> Alpha Analyst mengkhususkan diri dalam menganalisis laporan perusahaan, berita pasar, kinerja portofolio, valuasi, dan risiko keuangan. Bot ini menghasilkan analisis ringkas berbasis bukti, membedakan fakta dari asumsi dengan jelas, dan tidak menyajikan analisis sebagai nasihat keuangan yang terjamin.

![Formulir pembuatan Bot LightVela dengan pemilih avatar, kolom nama, kolom deskripsi, dan tombol Buat](../../images/bots-switching-create.webp)

Layar pembuatan juga dapat menampilkan template untuk peran tertentu, seperti Manajer Kesehatan, Pemantau Pasar, atau Teman Belajar AI.

![Template pembuatan Bot LightVela, termasuk Manajer Kesehatan, Pemantau Pasar, dan Teman Belajar AI](../../images/bots-switching-templates.webp)

Setelah mengisi detail, konfirmasikan pembuatan dan tunggu Bot baru selesai disediakan.

## Ruang kerja dan pengaturan Bot

Setelah dibuat, Bot membuka ruang kerja pengaturannya sendiri.

Dari tab Bot di halaman Agent utama, Anda dapat memilih Bot dan mengelola pengaturan yang tersedia untuk Bot tersebut, termasuk memori, Skill, Soul, tugas terjadwal, dan kanal yang terhubung.

![Halaman ringkasan Agent LightVela yang menampilkan kartu Bot di bagian My Bots](../../images/bots-switching-overview.webp)

Mode pembuatan menentukan apa yang diwarisi Bot baru:

| Mode pembuatan | Yang diwarisi | Yang dimulai terpisah |
| --- | --- | --- |
| Buat kosong | Model utama dan kredensial penyedianya, serta Skill yang disediakan sistem | Model cadangan, model lain yang telah dikonfigurasi, Soul, memori, Skill yang dipasang kemudian pada Bot utama, kanal, dan tugas terjadwal |
| Salin Bot saat ini atau Salin Bot utama | Model, Soul, Skill, preferensi pengguna, dan memori jangka panjang | Percakapan saat ini, riwayat chat sebelumnya, tugas terjadwal, status runtime, dan koneksi kanal |

Tinjau dialog pembuatan sebelum mengonfirmasi jika Anda perlu memisahkan pengaturan.

Setelah itu, Anda dapat mengelola [memori](./memory.md), [Skill](./skill.md), dan [tugas terjadwal](./automation.md) setiap Bot secara mandiri.

## Mengapa membangun Bot secara mandiri?

Satu Bot dapat menangani banyak tugas, tetapi konteksnya menjadi lebih sulit dikelola saat tanggung jawabnya bertambah.

Bot khusus untuk riset, perencanaan perjalanan, analisis keuangan, atau pemeriksaan kualitas dapat mempertahankan memori, Skill, pengaturan Soul, dan tugas terjadwal yang lebih terfokus.

Bot mandiri juga memudahkan Anda mencoba gaya kerja lain tanpa mengubah Bot yang sudah digunakan untuk tugas lain.

![Menu profil Bot LightVela yang menampilkan beberapa Bot yang dapat dipilih](../../images/bots-switching-selector.webp)

Hasilnya adalah ruang kerja LightVela yang lebih teratur.

Untuk beralih antar-Bot, klik profil Bot aktif di area kiri atas ruang kerja Agent, lalu pilih Bot lain dari menu.

## Menggunakan beberapa Bot sekaligus

Anda dapat menghubungkan beberapa Bot ke kanal pesan yang mendukung integrasi multi-Bot.

Kombinasi kanal yang tersedia bergantung pada wilayah LightVela:

| Versi LightVela | Kanal yang mendukung integrasi multi-Bot |
| --- | --- |
| Versi China | QQ, WeCom, Lark, DingTalk |
| Versi global | Telegram, Discord, Slack, QQ, WeCom, Lark |

Untuk kanal seperti WeChat dan WhatsApp, konfigurasi saat ini dapat mengizinkan hanya satu Bot per instans.

Jika kanal sudah dimiliki Bot lain, LightVela menampilkan pemberitahuan dan menyediakan cara untuk mengelola Bot pemilik kanal tersebut.

![Pemberitahuan LightVela bahwa WeChat sudah digunakan Bot lain dan hanya satu Bot yang dapat terhubung](../../images/bots-switching-wechat.webp)

## Memverifikasi peralihan Bot atau koneksi kanal

Setelah beralih atau menghubungkan Bot, periksa hal berikut:

1. Nama dan avatar Bot aktif berubah menjadi Bot yang Anda pilih.
2. Halaman pengaturan menampilkan ruang kerja dan konfigurasi Bot yang dipilih.
3. Kanal yang terhubung tercantum di bawah Bot yang memiliki koneksi tersebut.
4. Pesan uji singkat sampai ke Bot yang dimaksud dan menerima balasan.

Untuk kanal grup, kirim pesan uji dengan tingkat izin yang telah Anda konfigurasi.

Konfirmasikan apakah Bot hanya dapat membaca konteks grup atau juga dapat membalas.

## Masalah umum

| Masalah | Kemungkinan penyebab | Yang harus dilakukan |
| --- | --- | --- |
| **Bot Baru** tidak tersedia | Paket Anda telah mencapai batas Bot, atau Bot lain masih dibuat atau dihapus | Tunggu operasi saat ini selesai, hapus Bot yang tidak digunakan, atau tingkatkan ke paket dengan batas lebih tinggi |
| Opsi penggandaan tidak tersedia | Tidak ada Bot saat ini atau Bot utama yang valid untuk disalin | Pilih **Buat kosong**, atau kembali ke Bot yang dimaksud sebelum membuka dialog pembuatan |
| Daftar Bot sementara tidak tersedia | Instans Agent berhenti atau permintaan daftar Bot gagal | Mulai atau segarkan Agent, lalu muat ulang halaman pengaturan Bot |
| Kanal sudah terhubung ke Bot lain | Kanal memiliki pembatasan kepemilikan satu Bot | Gunakan pemberitahuan untuk membuka Bot pemilik, atau putuskan lalu hubungkan kembali sesuai halaman konfigurasi kanal |
| Pesan grup tidak menerima balasan | Izin grup Bot atau konfigurasi kanal belum lengkap | Tinjau halaman konfigurasi kanal yang relevan, lalu kirim pesan uji lain |

## Mengobrol dengan Bot di grup

Anda dapat mengundang beberapa Bot ke grup chat yang didukung.

Tergantung tingkat izin yang ditetapkan, Bot dapat membaca konteks grup, menjawab pertanyaan pengguna, atau melakukan keduanya.

Perilaku dan langkah penyiapan grup berbeda menurut platform.

Selesaikan konfigurasi kanal yang relevan sebelum mengundang Bot dan uji Bot dengan penyebutan langsung atau pemicu lain yang didukung platform jika diperlukan.
