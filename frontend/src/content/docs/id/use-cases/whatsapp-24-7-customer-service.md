# Layanan Pelanggan AI 24/7 di WhatsApp

WhatsApp dapat menjadi pintu masuk satu lawan satu tempat pelanggan berbicara dengan Hermes Agent, menanyakan pertanyaan umum, dan menerima draf layanan atau panduan perutean.

Di sini, 24/7 berarti Agent dapat merespons kapan pun layanannya berjalan, modelnya tersedia, dan koneksi kanalnya sehat; ini bukan janji layanan tanpa henti maupun SLA dukungan manusia.

Pesan proaktif WhatsApp tetap dipengaruhi jendela percakapan, templat pesan, dan konfigurasi kanal, sehingga pengingat otomatis harus dirancang secara terpisah dari percakapan yang dimulai pelanggan.

![Mengonfigurasi layanan pelanggan AI 24/7 di WhatsApp](../images/use-case-09-whatsapp-24-7-customer-service.png)

## Ringkasan

**WhatsApp dapat berperan sebagai pintu masuk satu lawan satu antara pelanggan dan Hermes Agent, berguna untuk menjawab pertanyaan yang berulang, menangkap kebutuhan pelanggan, dan menyusun draf respons. Namun "24/7" di sini berarti ia dapat merespons kapan pun layanannya berjalan, modelnya tersedia, dan kanalnya terhubung — ini bukan jaminan layanan tanpa henti maupun SLA dukungan manusia.** Batasan kedua sama pentingnya: pengiriman pesan proaktif di WhatsApp tetap tunduk pada jendela percakapan, templat pesan, dan konfigurasi kanal, sehingga pengingat otomatis harus dirancang terpisah dari percakapan yang dimulai pelanggan alih-alih mengasumsikan Anda dapat mengirim sesuka hati. Bangun dalam empat lapisan, secara berurutan: persona menetapkan suara dan kondisi eskalasi, pengetahuan menangkap FAQ, Skill menambahkan prosedur yang dapat dipakai ulang, dan tugas terjadwal menangani ringkasan terjadwal.

## Untuk siapa ini

Panduan ini ditujukan bagi orang yang ingin menggelar agent dukungan pribadi, asisten informasi produk, atau asisten triase purnajual di WhatsApp.

Ia sangat berguna bagi tim yang membutuhkan bahasa dukungan yang konsisten, FAQ yang dapat dipelihara, lebih sedikit balasan berulang, dan jalur pengalihan yang jelas untuk permintaan yang kompleks.

## Prasyarat

- Hermes Agent LightVela yang sedang berjalan.
  Jika Anda belum membuatnya, mulai dari [Panduan Cepat](../02-quickstart.md).

- Konfigurasi model yang berfungsi atau kredit uji coba yang tersedia.

- Akun WhatsApp yang dapat dipakai dan sudah terhubung dengan mengikuti [Kanal WhatsApp](../configuration/channel-whatsapp.md).

- Material produk, jam layanan, jalur eskalasi, dan detail kontak manusia.

- Definisi yang jelas tentang tindakan yang membutuhkan eksekusi atau konfirmasi manusia.

## Pahami lima lapisan layanan pelanggan 24/7

| Lapisan | Tanggung jawab | Lokasi yang sesuai |
|---|---|---|
| Kepribadian | Peran, suara, prioritas, dan batas layanan | SOUL.md atau [Personality](./im-agent-persona-soul-md.md) |
| Pengetahuan | FAQ produk, kebijakan, jam layanan, dan jalur eskalasi | File referensi di [Cloud Storage](../configuration/files.md) |
| Skill | Penelusuran, penataan, penyusunan draf, dan tindakan konkret lainnya | [Skill](../configuration/skill.md) |
| Memori | Preferensi pelanggan yang sudah dikonfirmasi dan konteks kolaborasi yang tahan lama | [Pengelolaan Memori](../configuration/memory.md) |
| Tugas Terjadwal | Pemeriksaan terjadwal, pengingat internal, dan pemberitahuan proaktif | [Tugas Terjadwal](../configuration/automation.md) |

Jangan memasukkan basis pengetahuan produk yang besar ke dalam kepribadian, dan jangan memperlakukan konten pelanggan yang belum dikonfirmasi sebagai memori jangka panjang.

## Langkah-langkah

### 1. Hubungkan lalu verifikasi percakapan satu lawan satu WhatsApp

Di pengaturan kanal Hermes Agent tujuan, pilih WhatsApp lalu selesaikan otorisasi kode QR dengan mengikuti [Kanal WhatsApp](../configuration/channel-whatsapp.md).

Buka kontak yang sesuai di WhatsApp lalu kirim pesan uji, kemudian pastikan konsol menampilkan kanal tersebut sebagai terhubung dan balasannya tiba secara normal.

Kanal WhatsApp saat ini tidak mendukung chat grup, sehingga alur layanan pelanggan ini dirancang untuk percakapan pelanggan satu lawan satu.

### 2. Tulis arahan kepribadian layanan pelanggan

Gunakan [panduan kepribadian SOUL.md](./im-agent-persona-soul-md.md) untuk menentukan identitas, suara, urutan respons, dan batas eskalasi asisten dukungan tersebut.

Mulai dengan arahan seperti ini:

    Kamu adalah asisten dukungan produk kami.
    Berikan kesimpulan terpenting kepada pelanggan lebih dulu, diikuti langkah-langkah yang diperlukan.
    Jawab hanya dari material produk yang sudah dikonfirmasi, dan sarankan pengalihan ke manusia dengan jelas ketika tidak yakin.
    Jangan menjanjikan pengembalian dana, perubahan harga, pemeriksaan identitas, penghapusan data, atau hasil berisiko tinggi lainnya.
    Sebelum mengirim konten ke sistem eksternal atau melakukan perubahan, jelaskan dampaknya lalu tunggu konfirmasi manusia.

Simpan prinsip layanan yang stabil di dalam kepribadian, dan simpan jawaban produk yang konkret di file referensi yang dapat dipelihara.

### 3. Tata basis pengetahuan dukungan

Siapkan setidaknya kategori berikut:

- FAQ produk dan paket.

- Jam layanan, ekspektasi waktu respons, dan detail kontak manusia.

- Kebijakan pengembalian dana, pembatalan, peningkatan, dan insiden.

- Error umum dan langkah penelusuran masalahnya.

- Permintaan yang membutuhkan pengalihan ke manusia dan informasi yang perlu dikumpulkan sebelum pengalihan.

Pecah materialnya menjadi file topik yang dapat dipelihara lalu taruh di [Cloud Storage](../configuration/files.md).

Uji materialnya dengan prompt berisiko rendah:

    Jawab pertanyaan ini hanya dari material dukungan yang sudah disiapkan.
    Jika materialnya tidak memuat jawaban, sebutkan informasi apa yang tidak tersedia lalu sarankan pengalihan ke manusia.

### 4. Pasang lalu validasi Skill yang diperlukan

Jika Anda memerlukan penelusuran pengetahuan, penataan tiket, pencarian di web, atau penyusunan konten, pilih Skill terpercaya dari [Skills.sh](https://skills.sh/) atau [ClawHub](https://clawhub.ai/).

Sebelum meminta Hermes memasangnya melalui WhatsApp, tanyakan apa yang dibaca Skill tersebut, layanan eksternal mana yang ia panggil, dan apakah ia dapat mengirim pesan proaktif.

Skill berisiko tinggi dapat meminta konfirmasi kedua sebelum instalasi, jadi tinjau panduan izin dan keamanan di [Konfigurasi Skill](../configuration/skill.md).

Setelah instalasi, uji draf, ringkasan, dan penelusuran FAQ sebelum mengizinkan Skill mana pun memproses pengembalian dana, menghapus data, atau mengirim konten pelanggan yang belum ditinjau.

### 5. Atur preferensi pelanggan dan memori yang tahan lama

Hanya informasi yang sudah dikonfirmasi dan berguna untuk layanan mendatang yang sebaiknya disimpan ke memori atau profil pengguna.

Contohnya mencakup preferensi bahasa Inggris yang sudah dikonfirmasi, preferensi balasan yang mengutamakan kesimpulan, atau status kasus dukungan yang sedang berjalan yang sudah diverifikasi pelanggan.

Kata sandi, kode verifikasi, detail pembayaran, informasi identitas lengkap, dan data sensitif yang tidak perlu sebaiknya tidak disimpan sebagai memori jangka panjang.

Minta Hermes dalam percakapan untuk mengingat atau melupakan sebuah preferensi, dan tinjau halaman [Pengelolaan Memori](../configuration/memory.md) di konsol secara berkala.

### 6. Konfigurasikan tugas terjadwal dan pesan proaktif

Kandidat tugas terjadwal yang baik mencakup pengingat tugas internal, pemeriksaan kasus yang belum selesai, dan ringkasan layanan harian.

Konfigurasikan jadwal, jendela waktu aktif, dan metode notifikasinya di [Tugas Terjadwal](../configuration/automation.md).

Pesan proaktif WhatsApp dapat dibatasi oleh jendela percakapan atau templat pesan yang sudah disetujui, jadi jangan mengasumsikan teks biasa selalu dapat terkirim ketika pelanggan belum memulai percakapan.

Pakai nomor uji lebih dulu untuk memastikan pengiriman, kontennya, dan jalur penanganan internal ketika sebuah notifikasi gagal.

### 7. Bangun pengalihan ke manusia

Ketika sebuah permintaan menyangkut pengembalian dana, pembayaran, pemeriksaan identitas, komitmen hukum, keluhan yang tereskalasi, atau material referensi yang tidak tersedia, Agent dukungan sebaiknya berhenti menerka lalu mengalihkan ke manusia.

Pesan pengalihannya sebaiknya memuat fakta yang diketahui, informasi yang tidak tersedia, langkah berikutnya yang disarankan, dan apakah pelanggan perlu mengulang masalahnya.

Tinjau sampel percakapan setiap hari, dengan fokus pada kutipan yang salah, janji berlebihan, penanganan data sensitif, dan pesan proaktif yang berulang.

## Urutan respons dukungan yang dapat dipakai ulang

1. Berikan kesimpulan langsungnya.

2. Kutip material atau langkah yang paling relevan.

3. Jelaskan batasan, biaya, waktu, atau informasi yang dibutuhkan.

4. Nyatakan dengan jelas kapan pengalihan ke manusia diperlukan.

5. Jalankan tindakan eksternal hanya ketika ia diizinkan dan dikonfirmasi.

## FAQ

### Apakah 24/7 berarti WhatsApp akan selalu membalas seketika?

Tidak.

Agent harus berjalan, modelnya harus tersedia, kanal WhatsApp harus tetap terhubung, dan pengiriman proaktif dapat dibatasi oleh jendela percakapan serta templat pesan.

### Bisakah layanan pelanggan WhatsApp menangani chat grup?

Dokumentasi kanal WhatsApp saat ini menyatakan chat grup tidak didukung dan hanya percakapan satu lawan satu yang didukung.

Jika Anda membutuhkan layanan pelanggan grup, pastikan dulu kanal tujuan lain memiliki dokumentasi dukungan grup yang eksplisit alih-alih menyimpulkan dukungan grup dari perilaku satu lawan satu.

### Apakah material dukungan sebaiknya masuk ke memori atau Cloud Storage?

FAQ produk, kebijakan, dan kumpulan referensi yang besar tempatnya di Cloud Storage.

Memori dan profil pengguna lebih cocok untuk sejumlah kecil preferensi pelanggan yang stabil, fakta yang sudah dikonfirmasi, dan konteks kolaborasi yang tahan lama.

### Bisakah sebuah Skill mengirim pesan ke pelanggan secara otomatis?

Hanya ketika kemampuan kanal, otorisasi bisnis, templat pesan, dan aturan tinjauan manusia semuanya eksplisit.

Secara default, biarkan Skill membuat draf atau pengingat internal, lalu minta manusia mengonfirmasi apa yang seharusnya dikirim.

## Langkah berikutnya

- [Kanal WhatsApp](../configuration/channel-whatsapp.md) — Selesaikan koneksi satu lawan satu WhatsApp.

- [Mengubah IM Agent Menjadi Asisten Layanan, Komunitas, atau Pendamping](./im-agent-skill-scenarios.md) — Pilih dan validasi Skill layanan pelanggan.

- [Menentukan Peran, Kepribadian, dan Suara IM Agent](./im-agent-persona-soul-md.md) — Tentukan kepribadian dukungan dan batas perilakunya.

- [Tugas Terjadwal](../configuration/automation.md) — Konfigurasikan pengingat internal dan ringkasan terjadwal.
