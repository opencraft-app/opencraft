# Workbench

## Ringkasan

**My Workbench memungkinkan Anda menggunakan Agent AI untuk membuat, menerbitkan, dan mengelola situs web statis di LightVela. Pilih template awal atau jelaskan situs web dari awal, lalu bekerja sama dengan Agent untuk menyempurnakan dan menerbitkannya.**

![Ringkasan My Workbench](../images/workbench-01.png)

Setelah diterbitkan, Anda dapat melihat alamat publik, memeriksa status saat ini, dan mengelola workbench yang sudah ada dari satu tempat.

Pemberitahuan Beta: My Workbench adalah fitur Beta, sehingga alur pembuatan dan penerbitan dapat berubah seiring perkembangan fitur.

## Fungsi My Workbench

My Workbench menghubungkan chat Agent Anda dengan alur kerja situs web statis yang dikelola.
Anda dapat memulai "worksite" workbench sendiri atau memilih salah satu template yang tersedia, berinteraksi dengan Agent untuk menyempurnakannya, dan melihat pratinjau situs melalui tautan khusus.

![Halaman My Workbench](../images/workbench-02.png)

LightVela mengelola proses hosting, sehingga Anda tidak perlu mengonfigurasi server hosting atau akun cloud terpisah.

## Membuka My Workbench

1. Buka [https://lightvela.ai/agents/](https://lightvela.ai/agents/).
2. Buka My Workbench di navigasi sebelah kiri.

Halaman Workbench menampilkan penggunaan saat ini, template yang tersedia, dan workbench yang sudah ada.

## Memilih Template Awal

Template awal membantu Anda memulai dengan arah yang jelas.
Anda dapat memilih template berdasarkan jenis situs web yang ingin dibuat:

- Clean Utility Dashboard: formulir, pencarian informasi, atau alat internal ringan.
- Data Dashboard: metrik utama, tren, ringkasan bisnis, atau laporan harian.
- Campaign Landing Page: halaman kegiatan, pendaftaran, atau penukaran.
- Personal Showcase: portofolio, halaman pribadi, atau pengenalan layanan.

Pilih template untuk membuka chat Agent dengan permintaan yang sudah disiapkan.

![Template awal](../images/workbench-03.png)

Anda juga dapat memilih opsi kosong dan membiarkan Agent mengklarifikasi kebutuhan bersama Anda langkah demi langkah.

## Membuat Workbench dengan Chat Agent

1. Pilih template awal atau mulai dengan workbench kosong.
2. Jelaskan tujuan, audiens, konten, dan arah visual situs web.
3. Jawab pertanyaan Agent saat Agent mengklarifikasi kebutuhan.
4. Tinjau hasil yang dibuat dan minta Agent melakukan perubahan.
5. Setelah situs web siap, minta Agent menerbitkan versi terbaru.

Alur kerja saat ini menggunakan React, TypeScript, Tailwind CSS, dan library UI umum untuk membuat situs web.

![Membuat Workbench dengan chat Agent](../images/workbench-04.png)

Agent juga diarahkan untuk menjaga konten tetap dapat diedit, menghindari data bisnis contoh yang sudah ditentukan, dan menggunakan penyimpanan lokal browser jika data lokal sementara sesuai untuk digunakan.

## Memeriksa Status Workbench

Setiap workbench memiliki status deployment agar Anda dapat melihat apakah workbench siap dikunjungi.

| Status | Deskripsi |
| --- | --- |
| Building | Situs web sedang dibuat atau disiapkan. |
| Publishing | Versi terbaru sedang diterbitkan. |
| Online | Situs web tersedia di alamat publiknya. |
| Update failed | Pembuatan atau penerbitan terbaru gagal. |
| Offline | Situs web tidak tersedia atau telah dihapus. |

Saat workbench online dan memiliki alamat publik, pilih Visit untuk membukanya.

![Status Workbench dan pratinjau situs web](../images/workbench-05.png)

Jika workbench masih berstatus Building atau Publishing, tunggu proses selesai dan segarkan halaman bila perlu.

## Mengelola Workbench yang Sudah Ada

Daftar workbench yang sudah ada menampilkan nama situs web, alamat publik, tanggal pembuatan, dan status saat ini.

Untuk memperbarui workbench, kembali ke chat Agent dan jelaskan perubahan yang Anda inginkan.
Setelah meninjau perubahan, minta Agent menerbitkan versi yang diperbarui.

Untuk menghapus workbench:

1. Temukan workbench di dalam daftar.
2. Pilih tindakan hapus.
3. Konfirmasikan penghapusan.

Menghapus workbench akan segera membuatnya offline dan menghapus file terkait.
Tindakan ini tidak dapat dibatalkan.

## Kuota dan Batas Hosting Workbench

Batas Workbench bergantung pada paket Anda.

- Paket Launch: dapat membuat 1 workbench.
- Paket tingkat lebih tinggi: dapat membuat hingga 5 workbench.

Jika mencapai batas, hapus workbench yang sudah ada sebelum membuat yang baru atau tingkatkan paket Anda.

## Masalah Umum

| Masalah | Kemungkinan penyebab | Yang harus dilakukan |
| --- | --- | --- |
| Halaman Workbench meminta Anda masuk | Sesi Anda telah berakhir. | Masuk kembali dan buka My Workbench. |
| Anda tidak dapat membuat workbench lain | Anda mungkin telah mencapai batas paket. | Periksa penggunaan atau hapus workbench yang tidak digunakan. |
| Status tetap Building atau Publishing | Deployment masih diproses. | Tunggu sebentar, lalu segarkan halaman. |
| Tindakan Visit tidak tersedia | Workbench belum online. | Tunggu hingga status berubah menjadi Online. |
| Status berubah menjadi Update failed | Pembuatan atau penerbitan terbaru gagal. | Tinjau respons Agent, lakukan perubahan yang diperlukan, lalu coba lagi. |
| Data situs web hilang di browser lain | Data disimpan di penyimpanan lokal browser. | Gunakan layanan backend jika situs memerlukan data bersama atau persisten. |
| Workbench yang dihapus masih muncul di daftar | Penghapusan masih diproses. | Tunggu pembersihan selesai, lalu segarkan halaman. |

## Batasan Saat Ini

My Workbench ditujukan untuk membuat dan menghosting situs web statis melalui chat Agent.
Fitur ini tidak menyediakan penyimpanan sisi server, database terkelola, penanganan formulir persisten, akun bersama, atau layanan backend arbitrer.
Jumlah workbench, traffic, penyimpanan, ukuran paket, dan jumlah file bergantung pada paket aktif Anda.

## FAQ

### Jenis situs web apa yang dapat saya buat?

Anda dapat membuat dashboard, alat internal, halaman kampanye, portofolio, landing page, dan situs web frontend statis lainnya.

### Apakah saya perlu pengalaman coding?

Tidak.
Anda dapat menjelaskan keinginan dalam bahasa alami dan membiarkan Agent memandu kebutuhan, pembuatan, dan penerbitannya.

### Apakah saya dapat memperbarui workbench yang sudah ada?

Ya.
Kembali ke chat Agent, jelaskan perubahan, tinjau hasilnya, lalu minta Agent menerbitkan versi yang diperbarui.

### Apakah situs web saya dapat menyimpan data?

Situs web statis dapat menyimpan data sementara di browser saat ini menggunakan penyimpanan lokal.
LightVela tidak menyediakan penyimpanan persisten sisi server untuk situs Workbench.

### Apakah saya memerlukan akun hosting terpisah?

Tidak.
LightVela menyediakan alur hosting untuk workbench statis Anda.

### Mengapa workbench saya tidak langsung tersedia?

Pembuatan dan penerbitan dapat memerlukan waktu.
Periksa status saat ini dan tunggu hingga berubah menjadi Online sebelum membuka alamat publik.
