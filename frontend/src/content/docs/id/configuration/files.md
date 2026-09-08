# File

## Ringkasan

**Penyimpanan cloud adalah ruang kerja berkas Hermes Agent. Anda dapat menyimpan materi tugas di satu tempat, mengunggah dan merapikan berkas, atau mengunduh yang diperlukan ke perangkat lokal, semuanya tanpa keluar dari LightVela. Kapasitasnya ditentukan paket — Launch menyediakan 50G penyimpanan cloud khusus dan Cruise lebih besar. Berkas yang dibaca dan ditulis Agent saat menjalankan tugas juga tersimpan di sini, sehingga tempat ini sekaligus menjadi pustaka dokumen Anda dan direktori kerja Agent.**

---

Cloud Storage adalah ruang kerja file untuk Hermes Agent Anda. Gunakan fitur ini untuk menyimpan file yang dibutuhkan Agent di satu tempat, lalu unggah, tata, unduh, atau hapus file tersebut dari konsol Agent tanpa harus meninggalkan LightVela.

## Yang dibahas di halaman ini

- Membuka Cloud Storage milik Agent Anda
- Mengunggah, membuat, dan menata file serta folder
- Mengunduh, mengganti nama, dan menghapus file
- Memastikan ruang kerja siap dipakai Agent Anda

> **Perlu diketahui:** Cloud Storage terikat pada Agent yang dipilih. Buka Agent yang sama setiap kali Anda ingin mengelola file yang dapat digunakannya.

## Kapan memakai Cloud Storage

Cloud Storage berguna ketika Agent membutuhkan bahan referensi, dokumen kerja, atau tempat yang rapi untuk menyimpan file yang dibuat selama sebuah tugas. Misalnya, Anda dapat mengunggah ringkasan proyek sebelum meminta Agent merangkumnya, atau membuat folder untuk memisahkan pekerjaan yang berulang.

Ini berbeda dari konteks yang disimpan Agent. Untuk mengelola apa yang diingat Agent lintas percakapan, lihat [Pengelolaan Memori](./memory.md).

## Sebelum memulai

1. Pastikan Anda dapat membuka Agent yang ingin Anda kerjakan.
2. Siapkan file yang ingin Anda tambahkan. Unggahan dan unduhan per file mendukung ukuran hingga 1 GB.
3. Tentukan struktur folder yang sederhana jika Anda menambahkan beberapa file yang saling berkaitan.

## Membuka Cloud Storage

1. Buka **Agents** lalu pilih Agent yang filenya ingin Anda kelola.
2. Buka bagian **Cloud Storage** atau **Files** miliknya.
3. Tunggu daftar file selesai dimuat sebelum memulai unggahan atau tindakan folder.

![Daftar file Cloud Storage di konsol LightVela](../images/cloud-storage-overview-en.png)

Jika daftar tidak dimuat, segarkan halaman lalu coba lagi. Jika masalahnya berlanjut, gunakan [Diagnostik](./diagnostics.md) untuk meninjau log Agent terbaru sebelum melakukan perubahan yang lebih besar.

## Mengunggah file dan membuat folder

### Mengunggah file

1. Pilih **Upload**.
2. Pilih satu atau beberapa file dari komputer Anda.
3. Biarkan halaman tetap terbuka sampai unggahan selesai, lalu pastikan file tersebut muncul di folder saat ini.

Gunakan nama yang jelas agar Anda dan Agent dapat mengenali file tersebut nanti. Jika sebuah file terlalu besar, kecilkan hingga di bawah 1 GB atau pecah file tersebut sebelum diunggah.

### Membuat folder atau file

1. Di folder tempat Anda ingin menaruh item baru, pilih **New folder** atau **New file**.
2. Masukkan nama yang deskriptif.
3. Konfirmasi tindakan tersebut, lalu buka item baru untuk melanjutkan pekerjaan.

Struktur yang ringkas biasanya sudah cukup: satu folder untuk bahan sumber, satu untuk pekerjaan yang sedang berjalan, dan satu untuk file yang sudah selesai. Hindari folder bertingkat terlalu dalam kecuali struktur itu memang membuat proyek lebih mudah dijelajahi.

## Mengelola file yang sudah ada

Pilih sebuah file atau folder untuk memakai tindakan yang tersedia di daftar file:

- **Open** sebuah folder untuk menjelajahi isinya.
- **Download** sebuah file ketika Anda perlu salinan lokal.
- **Rename** sebuah item agar tujuannya lebih jelas.
- **Delete** file atau folder yang tidak lagi Anda perlukan.

> **Perhatian:** Menghapus sebuah item akan mengeluarkannya dari Cloud Storage Agent ini. Unduh dulu apa pun yang mungkin Anda perlukan nanti sebelum menghapusnya.

Jika Anda memakai tool yang membuat file tersembunyi, aktifkan tampilan file tersembunyi hanya saat Anda perlu memeriksanya. Membiarkan tampilan itu nonaktif membuat pengelolaan file sehari-hari lebih mudah.

## Memverifikasi ruang kerja

Cloud Storage siap Anda gunakan ketika:

- file atau folder muncul di lokasi yang diharapkan;
- Anda dapat membuka atau mengunduh file tersebut dengan berhasil; dan
- nama folder memperjelas bahan mana yang termasuk dalam tugas saat ini.

Sekarang Anda dapat kembali ke [Chat Agent](./agent-chat.md) dan memberi tahu Agent apa yang ingin Anda lakukan dengan file tersebut. Untuk pekerjaan yang berulang, gabungkan instruksi yang sama dengan [Tugas Terjadwal](./automation.md) atau [Skill](./skill.md).

## FAQ

### Mengapa saya tidak bisa mengunggah atau mengunduh file?

Periksa dulu bahwa ukuran file tidak lebih dari 1 GB dan koneksi Anda stabil. Segarkan tampilan Cloud Storage, lalu ulangi tindakan tersebut. Jika masih gagal, kumpulkan informasi terbaru di [Diagnostik](./diagnostics.md).

### Bisakah saya memakai file satu Agent untuk Agent lain?

Cloud Storage dikelola dari konsol Agent yang dipilih. Buka Agent yang ingin Anda gunakan lalu tambahkan file di sana agar ruang kerjanya tetap jelas dan terarah.

### Apakah menghapus file juga menghapusnya dari komputer saya?

Tidak. Menghapus dari Cloud Storage hanya mengeluarkan salinan yang dikelola untuk Agent tersebut. Tindakan ini tidak menghapus file asli di komputer Anda.

## Langkah berikutnya

- Gunakan [Chat Agent](./agent-chat.md) untuk mengerjakan file yang sudah Anda siapkan.
- Tinjau [Pengelolaan Memori](./memory.md) ketika Agent perlu mempertahankan konteks, bukan hanya file.
- Gunakan [Diagnostik](./diagnostics.md) jika tindakan penyimpanan berulang kali gagal.
