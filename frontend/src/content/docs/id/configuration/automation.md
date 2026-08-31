# Otomasi

## Ringkasan

**Otomasi membuat Hermes Agent menjalankan pekerjaan secara proaktif pada waktu tetap, interval, atau jadwal satu kali, lalu mengirimkan hasilnya ke kanal notifikasi yang dipilih. Anda dapat mulai dari templat, atau menyesuaikan nama, aturan eksekusi, instruksi tugas, periode berlaku, dan pengaturan notifikasi, lalu terus mengelola statusnya dari daftar tugas.**

Saat membuat atau mengedit otomasi, Anda juga dapat menghubungkannya dengan tugas upstream. Eksekusi berikutnya akan memakai output selesai terbaru dari tugas upstream sebagai konteks tambahan. Ini cocok untuk memecah alur berurutan seperti “kumpulkan informasi terlebih dahulu, lalu buat ringkasan” menjadi beberapa langkah.

Otomasi memungkinkan Hermes Agent menjalankan pekerjaan tertentu sesuai jadwal atau kondisi pemicu yang sudah ditetapkan, sehingga Anda tidak perlu mengulang operasi yang sama secara manual. Skenario umumnya mencakup pengingat terjadwal, pembuatan laporan harian, pemantauan berita, dan publikasi konten.

Setiap tugas dapat mengatur penjadwalan dan aturan eksekusi secara fleksibel, sehingga asisten AI Anda dapat terus bekerja secara proaktif.

## Yang Dibahas di Halaman Ini

- Menambahkan otomasi
- Menghubungkan tugas upstream
- Menggunakan templat tugas
- Mengelola otomasi

## Menambahkan Otomasi

- **Nama**: Nama rencana otomasi.
- **Jadwal**: Atur siklus eksekusi tugas. Pilih salah satu dari hari tetap, interval tetap, atau eksekusi satu kali.
- **Instruksi tugas**: Tulis prompt yang digunakan agen untuk menjalankan otomasi.
- **Tugas upstream**: Opsional. Setelah dihubungkan, tugas ini memakai output selesai terbaru dari tugas upstream sebagai konteks saat berjalan.
- **Periode berlaku**: Batasi rentang waktu saat tugas dapat berjalan. Biarkan kosong agar tugas berjalan sepanjang waktu.
- **Notifikasi**: Pengalih opsional untuk memilih kanal yang menerima notifikasi eksekusi tugas.

Untuk membuat job kustom, klik “Buat” alih-alih memulai dari templat, lalu isi formulir kosong dengan jadwal dan instruksi Anda sendiri.

![Dialog Buat Job untuk mengonfigurasi otomasi](../images/automation-create-job.webp)

## Menghubungkan Tugas Upstream

Tugas upstream cocok untuk memecah satu pekerjaan menjadi alur multi-langkah yang stabil:

1. Tugas pertama mengumpulkan atau menghasilkan materi dasar.
2. Tugas kedua terhubung ke tugas pertama, lalu melanjutkan pengorganisasian, penyaringan, atau penulisan ulang berdasarkan output selesai terbarunya.
3. Tugas berikutnya dapat terus terhubung ke langkah sebelumnya untuk membentuk rantai pemrosesan yang jelas.

Contoh umum:

- Mengambil kandidat informasi setiap pagi, lalu tugas downstream membuat laporan harian yang ringkas.
- Merangkum progres proyek mingguan terlebih dahulu, lalu tugas downstream membuat versi untuk tim.
- Merangkum daftar tugas terlebih dahulu, lalu tugas downstream mengurutkannya berdasarkan prioritas dan membuat teks pengingat.

Menghubungkan tugas upstream tidak menyalin atau menggabungkan dua konfigurasi tugas. Tugas saat ini tetap berjalan sesuai jadwal, instruksi tugas, periode berlaku, dan pengaturan notifikasinya sendiri; tugas ini hanya menerima konteks tambahan dari output selesai terbaru tugas upstream. Hermes `context_from` mendukung referensi ke satu atau beberapa ID tugas. Jika halaman produk saat ini hanya menyediakan satu pilihan tugas upstream, ikuti batas yang tersedia di halaman tersebut. Tugas berantai tidak menunggu tugas upstream yang masih berjalan pada tick scheduler yang sama, jadi waktu eksekusi upstream dan downstream perlu dibuat berurutan.

Instruksi tugas tetap perlu menjelaskan cara memakai output upstream. Contohnya: “Berdasarkan kandidat berita dari tugas upstream, simpan hanya lima item yang terkait dengan produk AI Agent dan tulis ringkasan dalam bahasa Mandarin.” Hindari hanya menulis “lanjutkan pemrosesan”, karena tugas downstream akan sulit menentukan apa yang harus diproses.

## Templat Tugas

Jika belum yakin otomasi apa yang perlu dikonfigurasi, gunakan Area Templat di halaman “Otomasi”. Pilih kartu seperti Pengingat minum air & obat, Pengingat sewa, Pengingat kurs target, atau Ringkasan info saham, lalu klik “Aktifkan” untuk meninjau jadwal dan instruksi sebelum membuat job.

![Area Templat dengan kartu otomasi siap pakai](../images/automation-template-area.webp)

Saat membuka templat, formulir Buat Job akan terisi otomatis. Templat Ringkasan info saham, misalnya, mengisi nama job, jadwal harian, dan instruksi ringkasan informasi pasar, sehingga Anda masih dapat mengedit detail sebelum menguji atau membuat job.

<div style={{ maxWidth: "760px" }}>

![Templat Ringkasan info saham terbuka di formulir Buat Job](../images/automation-template-stock-job.webp)

</div>

## Mengelola Otomasi

Setelah otomasi dibuat, Anda dapat melihat tugas yang sudah diaktifkan di halaman “Automations”.

Gunakan tab di atas daftar untuk berpindah antara “Job Saat Ini”, “Eksekusi terbaru”, dan “Job Berakhir”. “Job Berakhir” mengumpulkan tugas yang selesai, gagal, dan kedaluwarsa, sementara tugas yang masih berjalan tetap berada di “Job Saat Ini”.

<div style={{ maxWidth: "420px" }}>

![Halaman Automations dengan tab Job Saat Ini, Eksekusi terbaru, dan Job Berakhir](../images/automation-current-jobs.webp)

</div>

Setelah job mulai berjalan, job tersebut muncul sebagai kartu di “Job Saat Ini” dengan instruksi, jadwal, dan tindakan cepat.

<div style={{ maxWidth: "520px" }}>

![Kartu otomasi yang sedang berjalan di Job Saat Ini](../images/automation-running-job.webp)

</div>

Dari halaman ini, Anda dapat melihat detail otomasi, mengedit tugas, menjedanya, atau menghapusnya sesuai kebutuhan.

Untuk tugas yang saling terhubung, periksa apakah ada tugas downstream yang masih bergantung pada output selesai terbaru tugas upstream sebelum menghapus tugas upstream tersebut.

## Penanganan Kegagalan Umum

| Gejala | Kemungkinan Penyebab | Penanganan yang Disarankan |
|---|---|---|
| Tugas downstream tidak memakai hasil upstream | Tugas upstream belum dihubungkan, tugas upstream belum memiliki output selesai, atau upstream dan downstream berjalan pada tick scheduler yang sama | Pilih ulang tugas upstream, jalankan tugas upstream hingga berhasil sekali, lalu jadwalkan tugas downstream setelahnya |
| Output tidak sesuai harapan | Instruksi tugas terlalu bergantung pada rujukan samar seperti “barusan” atau “konten di atas” | Tulis tujuan, cakupan, format output, dan cara memakai output upstream dengan jelas |
| Rantai tugas makin berantakan | Satu tugas memuat terlalu banyak langkah, atau tanggung jawab upstream dan downstream tidak jelas | Pecah alur agar setiap tugas hanya menangani satu langkah yang jelas |
