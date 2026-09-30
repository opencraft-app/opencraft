# Tugas Terjadwal

## Ringkasan

**Tugas Terjadwal membuat Hermes Agent mulai bekerja tanpa prompt manual. Pilih Tugas Agent saat pekerjaan memerlukan penalaran AI, Tugas Notifikasi saat pesan harus dikirim persis seperti ditulis, atau Tugas Skrip saat skrip Bash atau Python harus menjalankan pemeriksaan yang deterministik. Ketiga jenis ini memakai jadwal sekali jalan, berulang, dan interval yang sama, serta periode berlaku dan pengaturan notifikasi yang sama.**

![Halaman Tugas Terjadwal yang menampilkan templat tugas dan tugas saat ini](../../images/st-en-1.webp)

## Memilih Jenis Tugas

Pilih jenis tugas berdasarkan pekerjaan yang harus dilakukan saat jadwal tercapai.

| Jenis tugas | Cocok untuk | Yang Anda isi | Yang dijalankan |
| --- | --- | --- | --- |
| **Tugas Agent** | Ringkasan, riset, analisis, penulisan, atau pekerjaan yang memerlukan interpretasi | Instruksi tugas, serta Skill atau tugas upstream opsional | Hermes Agent memulai tugas berbasis model. |
| **Tugas Notifikasi** | Pengingat dan pesan rutin yang harus tetap sama | Teks notifikasi | Tugas yang dikelola LightVela mengirim teks persis seperti ditulis tanpa memanggil model. |
| **Tugas Skrip** | Pemeriksaan dan otomatisasi deterministik untuk developer | Skrip Bash atau Python | Skrip berjalan tanpa sesi Agent atau panggilan model. Output standar yang tidak kosong dapat dikirim sebagai notifikasi. |

Jenis tugas terpisah dari pola jadwal.
Setiap jenis dapat berjalan sekali, berulang setiap hari, minggu, atau bulan, atau pada interval tetap.

## Sebelum Membuat Tugas

Pastikan Hermes Agent aktif, pilih kanal notifikasi bila diperlukan, dan periksa kode Tugas Skrip sebelum menyimpannya.

![Opsi kanal notifikasi yang menampilkan Telegram dan WeChat](../../images/notification-channels-en.webp)

## Membuat Tugas Agent

Pilih **Tugas Agent** saat Hermes Agent perlu memahami permintaan Anda dan menghasilkan hasil.
Misalnya, Tugas Agent dapat mengumpulkan berita AI harian, memilih item yang paling relevan, lalu menulis briefing singkat.

Atur bidang berikut:

- **Nama**: Beri nama yang mudah dikenali.
- **Jadwal**: Pilih eksekusi sekali, pola berulang, atau interval tetap.
- **Instruksi tugas**: Jelaskan tujuan, cakupan, batasan sumber, dan format hasil.
- **Skill**: Tambahkan Skill yang tersedia bila tugas memerlukan kemampuan tersebut.
- **Tugas upstream**: Opsional, gunakan output selesai terbaru dari Tugas Agent lain sebagai konteks tambahan.
- **Periode berlaku**: Opsional, batasi waktu saat tugas boleh berjalan.
- **Notifikasi**: Opsional, pilih tujuan pengiriman hasil.

Pada waktu yang dijadwalkan, Hermes Agent membuat tugas Agent dan memanggil model yang dipilih.
Hasilnya dapat dikirim ke kanal notifikasi yang dipilih dan dicatat di Eksekusi terbaru. Jika tidak memilih kanal, Anda harus mengonfirmasi penyimpanan lokal sebelum membuat tugas; hasil tidak akan dikirim ke chat.

![Dialog Buat Tugas Terjadwal yang menampilkan jenis Tugas Agent](../../images/st-en-2.webp)

## Membuat Tugas Notifikasi

Pilih **Tugas Notifikasi** untuk pesan yang harus tiba persis seperti Anda menulisnya.
Misalnya, buat pengingat minum setiap hari, pengingat sewa bulanan, atau pemberitahuan singkat untuk tim.

Atur nama tugas, jadwal, isi notifikasi, periode berlaku, dan kanal notifikasi.
Isi notifikasi dapat memuat tanda baca biasa, baris baru, emoji, dan teks multibahasa.

Pada waktu yang dijadwalkan, LightVela mengirim isi notifikasi persis seperti ditulis.
LightVela tidak meminta model untuk menyusun, menulis ulang, merangkum, menerjemahkan, atau menjelaskan pesan.
Karena itu, penggunaan token model untuk tugas ini adalah 0 Token.

Tugas Notifikasi memerlukan setidaknya satu kanal notifikasi sebelum dapat dibuat atau disimpan.
Setiap kanal notifikasi tetap dapat merender baris baru dan karakter sesuai protokol teksnya sendiri.

![Dialog Buat Tugas Terjadwal yang menampilkan jenis Tugas Notifikasi](../../images/st-en-3.webp)

## Membuat Tugas Skrip

Pilih **Tugas Skrip** saat Anda memerlukan alur kerja Bash atau Python yang deterministik.
Misalnya, skrip dapat memeriksa penggunaan disk, memeriksa respons layanan, atau mencetak peringatan hanya ketika ambang batas terlampaui.

Atur nama tugas, jadwal, bahasa skrip, isi skrip, periode berlaku, dan kanal notifikasi.
Sebelum membuat tugas, setujui peringatan keamanan skrip dan pastikan Anda mempercayai kodenya.

Tugas Skrip tidak membuat sesi Agent, tidak memanggil model, tidak memakai prompt, dan tidak menjalankan Skill.
Penggunaan token modelnya adalah 0 Token, tetapi tugas ini tetap memakai sumber daya runtime Agent cloud.

| Hasil skrip | Hasil tugas | Perilaku pengiriman |
| --- | --- | --- |
| Kode keluar `0` dengan output standar tidak kosong | Berhasil | Output standar dikirim persis seperti ditulis ke kanal notifikasi yang dipilih. |
| Kode keluar `0` dengan output standar kosong | Berhasil senyap | Tidak ada notifikasi hasil yang dikirim. |
| Kode keluar bukan `0` | Gagal | Kegagalan dicatat dan mengikuti penanganan kegagalan tugas. |
| Waktu habis atau gagal memulai | Gagal | Jenis kegagalan dicatat dan mengikuti penanganan kegagalan tugas. |

Jangan mengandalkan Tugas Skrip untuk memperbaiki, menjelaskan, atau merangkum kegagalan dengan AI.
Tugas ini tetap deterministik: output kosong tetap senyap, dan skrip yang gagal tidak memicu fallback model.

![Dialog Buat Tugas Terjadwal yang menampilkan jenis Tugas Skrip](../../images/st-en-4.webp)

## Menautkan Tugas Agent Upstream

Gunakan tugas upstream saat satu Tugas Agent perlu menyiapkan konteks untuk Tugas Agent lain.
Tugas downstream menerima output selesai terbaru dari tugas upstream sambil tetap memakai jadwal, instruksi, periode berlaku, dan pengaturan notifikasinya sendiri.

![Dialog Buat Tugas Terjadwal yang menampilkan opsi tugas upstream](../../images/st-en-5.webp)

Beri jeda waktu yang cukup di antara tugas yang bergantung satu sama lain, lalu jelaskan dalam instruksi downstream cara memakai output upstream.
Konteks upstream, eksekusi model, dan Skill hanya berlaku untuk Tugas Agent.

## Mengatur Jadwal dan Aturan Pengiriman Bersama

Ketiga jenis tugas memakai kontrol jadwal dan notifikasi yang sama.

- **Sekali**: Berjalan sekali pada tanggal dan waktu yang dipilih.
- **Berulang**: Berjalan setiap hari, minggu, atau bulan pada waktu yang dipilih.
- **Interval**: Berjalan setiap jumlah menit, jam, atau hari yang dipilih.
- **Periode berlaku**: Batasi waktu saat tugas berulang atau interval boleh berjalan, atau biarkan kosong agar tetap aktif sepanjang waktu.
- **Notifikasi**: Pilih kanal yang menerima output berhasil atau notifikasi tugas.

Mengubah jenis tugas saat membuat tugas tidak menghapus pengaturan bersama ini.
Setelah dibuat, jenis tugas tidak dapat diubah, jadi buat tugas baru bila model eksekusinya perlu berubah.

![Dialog Buat Tugas untuk mengonfigurasi tugas terjadwal](../../images/automation-create-job.webp)

## Menggunakan Templat Tugas

Jika belum yakin cara memulai Tugas Agent, gunakan Area Templat di halaman Tugas Terjadwal.
Pilih kartu seperti Pengingat minum dan obat, Pengingat sewa, Pengingat kurs, atau Ringkasan info saham, lalu tinjau jadwal dan instruksi yang dihasilkan sebelum membuat tugas.

![Area Templat dengan kartu tugas terjadwal siap pakai](../../images/automation-template-area.webp)

Saat membuka templat, dialog Buat Tugas terisi otomatis.
Templat Ringkasan info saham, misalnya, mengisi nama tugas, jadwal harian, dan instruksi informasi pasar yang dapat Anda sesuaikan sebelum menguji atau membuatnya.

<div style={{ maxWidth: "760px" }}>

![Templat Ringkasan info saham terbuka di formulir Buat Tugas](../../images/automation-template-stock-job.webp)

</div>

Buat Tugas Notifikasi atau Tugas Skrip khusus dari dialog Buat, bukan dengan mengubah jenis tugas dari templat.

## Mengelola Tugas Terjadwal

Setelah tugas dibuat, gunakan halaman Tugas Terjadwal untuk meninjau Job Saat Ini, Job Berakhir, dan Eksekusi terbaru.
Tampilan Job Saat Ini dapat memfilter Tugas Agent, Tugas Notifikasi, dan Tugas Skrip.

Di **Eksekusi terbaru**, buka detail eksekusi lalu pilih **Lihat hasil** untuk membaca keluaran Markdown atau **Unduh Markdown** untuk menyimpannya. Beralihlah ke Bot pemilik tugas terlebih dahulu: hasilnya tersimpan dalam catatan eksekusi Bot tersebut dan tidak muncul di chat atau catatan Bot lain. Jika tugas hanya disimpan secara lokal, pilih kanal notifikasi yang terhubung agar hasil berikutnya dikirim.

Job Berakhir mengumpulkan tugas yang selesai, gagal, dan kedaluwarsa.
Tugas yang masih berjalan tetap ada di Job Saat Ini.

<div style={{ maxWidth: "420px" }}>

![Halaman Tugas Terjadwal dengan tab Job Saat Ini, Job Berakhir, dan Eksekusi terbaru](../../images/automation-current-jobs.webp)

</div>

Dari daftar tugas, periksa detail, edit pengaturan yang diizinkan, jeda tugas, atau hapus tugas.
Untuk Tugas Agent yang memiliki dependensi upstream, periksa apakah tugas lain masih memerlukan output selesai terbarunya sebelum menghapusnya.

<div style={{ maxWidth: "520px" }}>

![Kartu tugas terjadwal yang sedang berjalan di Job Saat Ini](../../images/automation-running-job.webp)

</div>

## Memvalidasi Tugas Baru

Setelah membuat atau mengedit tugas, jangan berhenti pada “berhasil disimpan”.

1. Pastikan tugas muncul pada filter jenis tugas yang benar dan statusnya sesuai harapan.
2. Periksa jadwal, periode berlaku, dan pengaturan notifikasi.
3. Jalankan pengujian atau tunggu satu eksekusi nyata, lalu periksa Eksekusi terbaru.
4. Untuk Tugas Agent, periksa bahwa hasil mengikuti instruksi dan memakai output tugas upstream yang dipilih bila dikonfigurasi.
5. Untuk Tugas Notifikasi, periksa bahwa teks yang dikirim sesuai dengan isi yang Anda tulis.
6. Untuk Tugas Skrip, periksa hasil keluar dan apakah output standar dikirim atau tetap senyap dengan benar.

## Penanganan Kegagalan Umum

| Gejala | Kemungkinan penyebab | Penanganan yang disarankan |
| --- | --- | --- |
| Tugas tidak berjalan pada waktu yang diharapkan | Jadwal, periode berlaku, atau status tugas tidak aktif | Periksa jadwal dan periode berlaku, pastikan tugas aktif, lalu periksa Eksekusi terbaru. |
| Hasil Tugas Agent meleset | Instruksi terlalu umum, Skill yang diperlukan tidak tersedia, atau konteks upstream hilang | Nyatakan tujuan, cakupan, format hasil, dan batasan sumber dengan jelas. Periksa Skill dan tugas upstream sebelum eksekusi berikutnya. |
| Tugas Notifikasi berjalan tetapi pesan tidak tiba | Tidak ada kanal notifikasi yang dipilih atau kanal tujuan tidak tersedia | Pilih dan verifikasi kanal notifikasi, lalu uji tugas lagi. |
| Tugas Skrip berjalan tanpa pesan | Skrip keluar dengan sukses tanpa output standar | Ini adalah keberhasilan senyap. Buat skrip mencetak teks yang tepat untuk dikirim saat kondisi terpenuhi. |
| Tugas Skrip gagal | Skrip keluar dengan galat, waktu habis, atau tidak dapat dimulai | Periksa catatan eksekusi, perbaiki skrip tepercaya, lalu uji lagi. Jangan mengharapkan AI memperbaiki atau menjelaskan skrip secara otomatis. |
