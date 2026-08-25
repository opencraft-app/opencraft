# Pengaturan Lanjutan

## Ringkasan

**Pengaturan Lanjutan memungkinkan Anda mengatur cara Hermes Agent mengelola memori dan konteks percakapan.**
Anda dapat mengelola memori jangka panjang, profil pengguna, dan kompresi otomatis untuk percakapan panjang, lalu menentukan kapan kompresi dimulai, berapa banyak konten terbaru yang dipertahankan, serta berapa pesan terbaru yang selalu utuh.
Setelah pengaturan berhasil disimpan, LightVela memulai ulang Gateway dan membaca kembali konfigurasi untuk memastikan nilai baru sudah berlaku.

![Pengaturan Lanjutan di konsol LightVela](../images/setting-1-en.png)

## Yang dibahas di halaman ini

- Mengelola memori jangka panjang dan profil pengguna.
- Mengelola kompresi otomatis untuk percakapan panjang.
- Menetapkan ambang kompresi, rasio konten yang dipertahankan, dan jumlah pesan terbaru yang dilindungi.
- Mengembalikan nilai default untuk grup Memori atau Manajemen Konteks.

## Sebelum memulai

1. Pastikan Agent tujuan sedang berjalan.
2. Buka **Agents** lalu pilih Agent yang ingin Anda konfigurasi.
3. Buka **Advanced Settings**.

Saat Agent tidak berjalan, Anda dapat melihat nilainya saat ini tetapi tidak dapat mengubahnya.

## Pengaturan yang tersedia

| Grup | Pengaturan | Fungsi |
| --- | --- | --- |
| Memori | Memori Jangka Panjang | Memungkinkan Agent membaca dan memperbarui memori jangka panjang dalam percakapan berikutnya. |
| Memori | Profil Pengguna | Memungkinkan Agent mencatat dan menggunakan preferensi, gaya komunikasi, dan kebiasaan Anda. |
| Manajemen Konteks | Kompresi Otomatis | Meringkas konten lama ketika percakapan panjang mendekati batas konteks. |
| Manajemen Konteks | Ambang Kompresi | Menetapkan rasio penggunaan konteks yang memulai kompresi, dari 0 hingga 1. |
| Manajemen Konteks | Rasio Retensi Kompresi | Menetapkan jumlah teks percakapan terbaru yang dipertahankan setelah kompresi, dari 0.1 hingga 0.8. |
| Manajemen Konteks | Pesan Terbaru yang Dilindungi | Menetapkan jumlah pesan terbaru yang tetap utuh saat kompresi, dengan minimum 1. |

## Mengubah pengaturan

### Pengaturan sakelar

1. Pilih sakelar di samping Memori Jangka Panjang, Profil Pengguna, atau Kompresi Otomatis.
2. Baca pesan konfirmasi lalu konfirmasikan perubahan.
3. Tunggu hingga penyimpanan selesai.

Menonaktifkan Memori Jangka Panjang atau Profil Pengguna tidak menghapus konten yang sudah ada.
Menonaktifkan Kompresi Otomatis mempertahankan nilai kompresi yang ada, tetapi menghentikan peringkasan otomatis untuk konten percakapan lama.

### Pengaturan angka

1. Pilih tombol edit di samping nilai yang ingin Anda ubah.
2. Masukkan nilai dalam rentang yang diizinkan.
3. Pilih Simpan atau tekan Enter untuk menyimpan nilai.
4. Pilih Batal atau tekan Escape untuk membatalkan perubahan.

Anda hanya dapat mengubah ambang kompresi, rasio retensi, dan jumlah pesan yang dilindungi saat Kompresi Otomatis aktif.

## Mengembalikan nilai default

Pengaturan Lanjutan menyediakan **Restore defaults** secara terpisah untuk grup **Memori** dan **Manajemen Konteks**.

1. Pada grup yang ingin direset, pilih **Restore defaults**.
2. Baca pesan konfirmasi.
3. Konfirmasikan pemulihan.

Mengembalikan nilai default hanya menghapus nilai khusus dari grup yang dipilih dan mengembalikan grup tersebut ke nilai default Hermes Agent.
Tindakan ini tidak memengaruhi grup lain atau menghapus memori Agent yang sudah ada.

## Memastikan perubahan berlaku

Setelah penyimpanan atau pemulihan berhasil, halaman menampilkan nilai yang dibaca kembali dari Agent.
Setelah mengubah kompresi otomatis, lanjutkan percakapan yang lebih panjang untuk memastikan Agent mengikuti aturan manajemen konteks yang baru.
Setelah mengubah pengaturan memori, amati percakapan berikutnya untuk memastikan Agent menggunakan memori dan preferensi seperti yang diharapkan.

## FAQ

### Mengapa saya tidak dapat mengubah pengaturan?

Pastikan terlebih dahulu bahwa Agent sedang berjalan.
Kontrol juga sementara tidak tersedia saat LightVela membaca konfigurasi, menyimpan perubahan, atau mengembalikan nilai default.

### Mengapa sebuah pengaturan menyatakan versi Agent saya tidak mendukungnya?

Versi yang sedang berjalan pada Agent tersebut belum mendukung pengaturan ini.
Gunakan pengaturan yang tersedia, atau periksa halaman ini lagi setelah Agent diperbarui.

### Mengapa angka yang saya masukkan tidak dapat disimpan?

Ambang kompresi harus berada dari 0 hingga 1.
Rasio retensi kompresi harus berada dari 0.1 hingga 0.8.
Jumlah pesan terbaru yang dilindungi harus berupa bilangan bulat minimal 1.

### Mengapa pengaturan kompresi lain tidak dapat diedit setelah Kompresi Otomatis dinonaktifkan?

Nilai tersebut hanya berlaku saat Kompresi Otomatis aktif.
Aktifkan kembali Kompresi Otomatis sebelum mengubahnya.

### Apa yang harus dilakukan jika penyimpanan melaporkan kegagalan restart atau verifikasi?

Konfigurasi mungkin sudah ditulis, tetapi proses restart Gateway atau pembacaan ulang konfigurasi belum selesai.
Segarkan halaman untuk memeriksa nilai yang ditampilkan, lalu tentukan apakah perlu mencoba lagi.
