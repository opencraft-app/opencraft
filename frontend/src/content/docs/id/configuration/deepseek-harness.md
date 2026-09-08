# DeepSeek Harness

## Ringkasan

**DeepSeek Harness adalah framework AI Agent dengan arsitektur plugin-first yang dapat Anda instal bersama Hermes Agent di LightVela. Halaman Labs mengelola instalasi, status, restart, akses WebUI, kunci penyedia model yang didukung, serta profil dengan SkillHub, tanpa mengubah konfigurasi, kanal, skill, atau memori Hermes yang sudah ada. Untuk pengaturan penyedia model yang digunakan Hermes Agent, lihat [Konfigurasi Model](./model.md).**

![Ikhtisar DeepSeek Harness](../images/deepseek-harness-01.png)

Catatan Beta: DeepSeek Harness adalah fitur Labs dalam akses awal.
Pembaruan berikutnya dapat menimbulkan perubahan kompatibilitas seiring berkembangnya framework upstream dan ekosistem pluginnya.

## Yang Ditambahkan DeepSeek Harness

DeepSeek Harness (DSH) adalah agent harness open-source yang menyediakan lingkungan dan alat yang dibutuhkan model AI untuk mengerjakan tugas nyata.
Di LightVela, DSH berjalan sebagai lingkungan terkelola yang terpisah di samping Hermes Agent, sehingga Anda dapat mengerjakan file proyek, menggunakan alat dan skill, mengelola sesi, serta berinteraksi dengan Agent melalui WebUI.

![Halaman DeepSeek Harness di Labs](../images/deepseek-harness-02.png)

LightVela menyediakan akses terkelola untuk DSH.
Anda tidak perlu memasang paket secara manual, mengonfigurasi alamat server publik, atau menjalankan layanan DSH dari terminal.
Dari halaman DeepSeek Harness di Labs, Anda dapat memasang runtime terkelola, memeriksa apakah statusnya sehat, mengonfigurasi penyedia model yang disetujui, membuka WebUI khusus untuk instance Anda, dan merestart DSH bila diperlukan.

## Memasang DeepSeek Harness

1. Buka [halaman Agent LightVela](https://lightvela.ai/agents/).
2. Di navigasi kiri, buka Labs lalu pilih DeepSeek Harness.
3. Baca catatan Beta lalu pilih Install and try now.
4. Biarkan halaman tetap terbuka selama instalasi berlangsung.
   Instalasi normal biasanya memerlukan sekitar satu hingga tiga menit.

![Memasang DeepSeek Harness](../images/deepseek-harness-03.png)

## Mengonfigurasi Penyedia Model

Setelah DeepSeek Harness terpasang, kartu Model Configuration tersedia di bawah kartu DSH utama.
Untuk situs internasional, daftar penyedia yang saat ini disetujui meliputi:

- DeepSeek
- MiniMax
- MiniMax China
- Moonshot AI
- Moonshot AI China
- OpenRouter
- Anthropic
- Groq
- OpenAI

Untuk menambahkan penyedia:

1. Pilih penyedia dari daftar penyedia.
2. Tempel API key ke kolom API Key.
3. Pilih Save.
4. Pastikan penyedia tersebut muncul di daftar penyedia yang dikonfigurasi.

![Form penyedia model DeepSeek Harness](../images/deepseek-harness-04.png)

Untuk menghapus penyedia, pilih tindakan hapus lalu konfirmasi penghapusan.
Setelah dihapus, Anda dapat menambahkan penyedia yang sama lagi dengan API key baru.

![Penyedia DeepSeek Harness yang dikonfigurasi](../images/deepseek-harness-05.png)

## Membuka WebUI DeepSeek Harness

Saat status layanan menunjukkan running, pilih Access WebUI pada kartu DeepSeek Harness.

![Tombol Access WebUI](../images/deepseek-harness-06.png)

LightVela menyediakan domain akses khusus dan autentikasi identitas bawaan untuk WebUI DeepSeek Harness, sehingga WebUI hanya dapat diakses oleh Anda.
Setelah terautentikasi, Anda dapat membuka WebUI untuk instance Agent saat ini dan memulai pengujian sederhana menggunakan penyedia yang sudah dikonfigurasi.
Jika Anda perlu menguji Hermes Agent yang sudah ada secara terpisah, gunakan [Chat](./agent-chat.md).

![WebUI DeepSeek Harness](../images/deepseek-harness-07.png)

## Memahami Plugin

DeepSeek Harness menggunakan arsitektur plugin-first.
Plugin menyediakan kemampuan atau integrasi untuk profil DSH, seperti katalog skill, konektor pesan, atau komponen runtime lainnya.
Anda dapat mengunjungi Plugin Plaza dengan mengeklik Plugin Plaza di kiri bawah halaman DSH.

### Memasang dan menggunakan plugin

Dari Plugin Plaza, Anda dapat menjelajahi kemampuan tambahan untuk lingkungan DeepSeek Harness, seperti alat browser, memori, tugas terjadwal, peningkatan UI, dan integrasi eksternal.

![Pencarian Plugin Plaza](../images/deepseek-harness-08.png)

Buka plugin untuk meninjau kemampuannya, lalu pasang plugin yang ingin Anda gunakan.
Setelah plugin dipasang, plugin tersebut dapat digunakan langsung di workspace tanpa perlu menyebutkannya secara eksplisit.
Untuk skill Hermes yang dikelola LightVela, lihat [Konfigurasi Skill](./skill.md).

### Menelusuri plugin yang terpasang

Anda dapat melihat daftar plugin di DSH WebUI > Plugin Plaza > Installed.

![Plugin DeepSeek Harness yang terpasang](../images/deepseek-harness-09.png)

## Menggunakan Workspace

Workspace adalah direktori proyek yang digunakan DeepSeek Harness selama sesi Anda.
Dari WebUI, klik ikon Add Workspace untuk membuka direktori workspace.

![Ikon Add Workspace](../images/deepseek-harness-10.png)

Setelah memilih direktori, Anda dapat membuat folder baru atau memilih folder yang sudah ada dari lingkungan DSH yang di-host di cloud, lalu menjadikannya workspace proyek.
Agent kemudian dapat menggunakan file di workspace tersebut untuk memahami proyek, mengedit file, menjalankan perintah, dan menyelesaikan tugas di workspace cloud tersebut.

![Dialog Select Workspace Directory](../images/deepseek-harness-11.png)

Workspace juga membantu mengatur proyek dan sesi.
Sesi yang dibuat untuk sebuah workspace terhubung dengan direktori tersebut, sehingga Anda dapat kembali ke proyek yang sama dan melanjutkan pekerjaan dengan riwayat sesi terkait.
Operasi yang memerlukan izin tambahan tetap mengikuti kebijakan izin DSH yang aktif dan dapat meminta persetujuan Anda di WebUI.
Untuk pengelolaan file LightVela di luar DSH, lihat [Cloud Storage](./files.md).

## Merestart DeepSeek Harness

Gunakan Restart saat DSH sudah terpasang tetapi perlu memuat ulang setelah perubahan konfigurasi, atau perlu dipulihkan dari status yang tidak sehat.
Tindakan restart hanya berlaku untuk layanan DeepSeek Harness.
Hermes Agent terus berjalan secara terpisah.

![Tombol Restart DeepSeek Harness](../images/deepseek-harness-12.png)

## Masalah Umum

| Gejala | Kemungkinan penyebab | Yang harus dilakukan |
| --- | --- | --- |
| Instalasi tidak selesai | Tugas instalasi terkelola tidak berhasil selesai | Tinjau error di halaman, tunggu sebentar, lalu coba lagi dari halaman DeepSeek Harness. |
| WebUI tidak terbuka | Layanan belum siap, atau sesi saat ini tidak memiliki akses ke instance | Pastikan DSH menunjukkan status running, lalu buka kembali WebUI dari halaman Labs saat Anda sudah login. |
| Model tidak dapat menjawab permintaan | Belum ada penyedia yang dikonfigurasi, key tidak valid, atau akun penyedia tidak tersedia | Periksa daftar penyedia yang dikonfigurasi, perbarui API key bila perlu, lalu kirim permintaan sederhana lagi. |
| API key tersimpan tidak terlihat | Ini adalah perilaku yang diharapkan | API key hanya dapat ditulis. Biarkan kolom kosong untuk mempertahankan key tersimpan, atau masukkan key baru untuk menggantinya. |
| Kanal tidak terhubung | Plugin tersedia, tetapi konfigurasi akunnya belum lengkap | Konfigurasikan dan otorisasi kanal di dalam DSH WebUI. |
| DSH tampak tidak sehat setelah perubahan | Layanan mungkin perlu dimuat ulang | Gunakan Restart, tunggu hingga status kembali running, lalu validasi WebUI dan penyedia lagi. |

## Batasan Saat Ini

DeepSeek Harness di LightVela dirancang sebagai kemampuan Labs yang dikelola.
Fitur ini menyediakan instalasi, status, restart, kredensial penyedia yang disetujui, dan akses terkontrol ke WebUI.

Halaman Labs saat ini tidak mendukung instalasi paket arbitrer, unggah plugin khusus, akses port jaringan mentah, endpoint penyedia khusus, protokol penyedia khusus, atau pengeditan parameter model tingkat lanjut.
Batasan ini menjaga instance terkelola tetap dapat diprediksi selama fitur masih dalam Beta.

Gunakan DeepSeek Harness ketika Anda ingin menjelajahi lingkungan Agent berbasis plugin, integrasi SkillHub, dan komponen kanal yang didukung tanpa mengubah pengaturan Hermes Agent yang sudah ada.

## FAQ

### Apakah DeepSeek Harness menggantikan Hermes Agent?

Tidak.
DeepSeek Harness berjalan sebagai layanan terpisah di samping Hermes.
Memori, skill, kanal, dan konfigurasi Hermes yang sudah ada tetap tidak berubah.

### Mengapa saya tidak dapat melihat API key yang tersimpan?

API key hanya dapat ditulis.
Biarkan kolom kosong untuk mempertahankan key yang ada, atau masukkan key baru untuk menggantinya.

### Apakah saya dapat menambahkan penyedia, model, atau Base URL khusus apa pun?

Halaman Labs LightVela saat ini hanya mendukung penyedia yang ditampilkan di pemilihnya.
Untuk konfigurasi model tambahan, termasuk model khusus atau Base URL, Anda dapat mengelolanya langsung dari WebUI DeepSeek Harness.

### Apakah skill DeepSeek Harness sama dengan skill Hermes?

Tidak.
DeepSeek Harness dan Hermes Agent adalah lingkungan yang terpisah.
Memasang DeepSeek Harness tidak otomatis menyalin skill Hermes ke DSH, dan konfigurasi plugin atau skill DSH tidak mengubah pengaturan Hermes Agent.

### Mengapa DeepSeek Harness ditandai Beta?

Ini adalah fitur Labs dalam akses awal.
Pembaruan DSH atau pluginnya dapat menimbulkan perubahan kompatibilitas, jadi validasikan workflow Anda setelah pembaruan.
