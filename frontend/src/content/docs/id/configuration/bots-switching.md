# Beralih Antar Bot

## Ringkasan

**Beralih Antar Bot memungkinkan satu Hermes Agent cloud LightVela memiliki beberapa Bot khusus. Anda dapat membuat Bot untuk riset, perencanaan, pemrograman, konten, dukungan, atau alur kerja berulang, lalu beralih di antara Bot tersebut dari deretan avatar Bot.**

**Setiap Bot memiliki konteks ruang kerja sendiri. Saat membuat Bot kosong atau menggandakan Bot yang sudah ada, LightVela menerapkan aturan pewarisan yang berbeda untuk pengaturan model, memori, Skill, Soul, tugas terjadwal, dan koneksi kanal.**

## Sebelum memulai

- Masuk ke LightVela dan buka Hermes Agent cloud yang aktif.
- Untuk membuat Bot tambahan, pastikan paket Anda masih mengizinkan Bot baru dan tidak ada Bot lain yang sedang dibuat atau dihapus.
- Jika Anda akan menghubungkan kanal, siapkan kredensial atau metode otorisasi yang diperlukan kanal tersebut.

## Membuat Bot

Setelah masuk dengan Google atau GitHub dan mengaktifkan paket yang tersedia, buka [konsol Agent](/agents/overview/). Selesaikan pengaturan Bot pertama: isi nama yang wajib, tambahkan deskripsi jika perlu, dan atur tampilannya. Pilih **Buat**, lalu tunggu pembuatan dan konfigurasi awal selesai. Setelah konfigurasi selesai, pilih **Mulai perjalanan**, lalu buka Chat web untuk Bot tersebut. Kanal pesan bersifat opsional; balasan memerlukan kredit model paket yang tersedia atau model yang telah dikonfigurasi.

Untuk membuat Bot berikutnya, pilih **Bot Baru** jika tombol tersedia dan kuota paket mencukupi. Isi **Nama** (wajib) dan **Deskripsi** (opsional), lalu sesuaikan tampilan jika perlu. Pilihan bawaan adalah **Buat Bot kosong**. Jika ada Bot yang valid untuk disalin, buka **Lanjutan** dan pilih Bot sumber tertentu. Untuk menyalin Bot yang sedang digunakan, buka **Kelola Bot → Salin Bot**; formulir akan memilih sumber itu. Periksa sumber, pilih **Buat**, lalu tunggu hingga selesai.

Tombol tutup dan opsi salin lanjutan hanya tersedia jika ada Bot sumber yang valid. Pengaturan pertama tanpa sumber harus diselesaikan. Kontrol tampilan mengubah warna, bentuk, dan aksesori, bukan memilih sumber salinan.

Tangkapan layar berikut menampilkan formulir pembuatan Bot tambahan dan templat rekomendasi pada UI saat ini. Tombol tutup dan bagian Lanjutan tersedia karena Agent ini sudah memiliki Bot; ini bukan layar pengaturan Bot pertama.

![Formulir pembuatan Bot LightVela dengan pemilih avatar, kolom nama, kolom deskripsi, dan tombol Buat](../../images/bots-switching-create.webp)

![Templat rekomendasi pada formulir pembuatan Bot tambahan LightVela](../../images/bots-switching-templates.webp)

## Ruang kerja dan pengaturan Bot

Pilih avatar Bot yang dituju pada deretan Bot. Pada layar sempit, buka panel navigasi terlebih dahulu. Pastikan namanya sebelum mengubah model, memori, Skill, kanal, atau tugas terjadwal. Chat web dan daftar percakapan mengikuti Bot yang dipilih; Bot tambahan juga dapat memakai Chat web. Chat web tidak memerlukan kanal pesan.

![Deretan avatar Bot LightVela di samping navigasi Kanal, Skill, dan Tugas Terjadwal](../../images/bots-switching-overview.webp)

Mode pembuatan menentukan apa yang diwarisi Bot baru:

| Mode pembuatan | Yang diwarisi | Yang dimulai terpisah |
| --- | --- | --- |
| Buat Bot kosong | Model utama dan kredensial penyedianya, serta Skill yang disediakan sistem | Model cadangan, model lain yang telah dikonfigurasi, Soul, memori, Skill yang dipasang kemudian pada Bot utama, kanal, dan tugas terjadwal |
| Salin Bot | Model, Soul, Skill, preferensi pengguna, dan memori jangka panjang | Percakapan saat ini, riwayat chat sebelumnya, tugas terjadwal, status runtime, dan koneksi kanal |

Tinjau dialog pembuatan sebelum mengonfirmasi jika Anda perlu memisahkan pengaturan.

Setelah itu, Anda dapat mengelola [memori](./memory.md), [Skill](./skill.md), dan [tugas terjadwal](./automation.md) setiap Bot secara mandiri.

## Mengapa membangun Bot secara mandiri?

Satu Bot dapat menangani banyak tugas, tetapi konteksnya menjadi lebih sulit dikelola saat tanggung jawabnya bertambah.

Bot khusus untuk riset, perencanaan perjalanan, analisis keuangan, atau pemeriksaan kualitas dapat mempertahankan memori, Skill, pengaturan Soul, dan tugas terjadwal yang lebih terfokus.

Bot mandiri juga memudahkan Anda mencoba gaya kerja lain tanpa mengubah Bot yang sudah digunakan untuk tugas lain.

![Deretan avatar Bot LightVela dengan dua Bot dan tombol Bot baru](../../images/bots-switching-selector.webp)

Pilih avatar Bot yang dituju pada deretan Bot. Pada layar sempit, buka panel navigasi terlebih dahulu. Pastikan namanya sebelum mengubah model, memori, Skill, kanal, atau tugas terjadwal. Chat web dan daftar percakapan mengikuti Bot yang dipilih; Bot tambahan juga dapat memakai Chat web. Chat web tidak memerlukan kanal pesan.

Untuk beralih antar-Bot, klik profil Bot aktif di area kiri atas ruang kerja Agent, lalu pilih Bot lain dari menu.

## Menggunakan beberapa Bot sekaligus

Anda dapat menghubungkan beberapa Bot ke kanal pesan yang mendukung integrasi multi-Bot.

Kombinasi kanal yang tersedia bergantung pada wilayah LightVela:

| Versi LightVela | Kanal yang mendukung integrasi multi-Bot |
| --- | --- |
| Versi global | Telegram, Discord, WeChat, Slack, QQ, WeCom, Lark |

Bot yang berbeda pada satu instans dapat menghubungkan akun WeChat yang berbeda. Setiap Bot mengelola koneksi WeChat miliknya sendiri. WhatsApp tetap dibatasi ke satu Bot yang terhubung per instans; Bot lain akan melihat pemberitahuan kepemilikan dan tautan untuk mengelolanya.

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
| Opsi penggandaan tidak tersedia | Tidak ada Bot saat ini atau Bot utama yang valid untuk disalin | Pilih **Buat Bot kosong**, atau kembali ke Bot yang dimaksud sebelum membuka dialog pembuatan |
| Daftar Bot sementara tidak tersedia | Instans Agent berhenti atau permintaan daftar Bot gagal | Mulai atau segarkan Agent, lalu muat ulang halaman pengaturan Bot |
| Kanal sudah terhubung ke Bot lain | Kanal memiliki pembatasan kepemilikan satu Bot | Gunakan pemberitahuan untuk membuka Bot pemilik, atau putuskan lalu hubungkan kembali sesuai halaman konfigurasi kanal |
| Pesan grup tidak menerima balasan | Izin grup Bot atau konfigurasi kanal belum lengkap | Tinjau halaman konfigurasi kanal yang relevan, lalu kirim pesan uji lain |

## Mengobrol dengan Bot di grup

Anda dapat mengundang beberapa Bot ke grup chat yang didukung.

Tergantung tingkat izin yang ditetapkan, Bot dapat membaca konteks grup, menjawab pertanyaan pengguna, atau melakukan keduanya.

Perilaku dan langkah penyiapan grup berbeda menurut platform.

Selesaikan konfigurasi kanal yang relevan sebelum mengundang Bot dan uji Bot dengan penyebutan langsung atau pemicu lain yang didukung platform jika diperlukan.
