# Konfigurasi Skill

## Ringkasan

**Skill adalah paket kemampuan tambahan yang dapat dipanggil Hermes, memperluas kemampuannya di luar percakapan dasar ke tugas konkret seperti merapikan daftar tugas, membuat laporan harian, menjelajah web, mencari berita, dan menghasilkan gambar. Semuanya berasal dari Skills.sh dan ClawHub, pasar skill yang dipakai bersama oleh OpenClaw dan Hermes. Skill bersifat opsional: Agent tidak memasang skill apa pun secara bawaan dan tetap dapat berbicara normal, sehingga sebaiknya pasang skill hanya setelah Anda menemukan batas kemampuannya. Ada dua cara memasang — cari berdasarkan nama di bagian Skill pada konsol, atau langsung minta Agent memasangnya lewat percakapan. Skill yang sudah terpasang dapat dihapus dari konsol.**

---

Skill adalah paket kemampuan tambahan yang dapat dipanggil Hermes. Skill memperluas penanganan tugas konkret di luar percakapan dasar, seperti menyusun to-do secara otomatis, membuat laporan harian, menjelajahi halaman web, mencari berita, menghasilkan gambar, dan lainnya.

Semua Skill berasal dari [**Skills.sh**](https://skills.sh/) dan [**ClawHub**](https://clawhub.ai/) — marketplace Skill yang digunakan bersama oleh OpenClaw dan Hermes.

## Yang dibahas di halaman ini

- Hubungan antara Hermes dan Skill

- Dua metode instalasi: instalasi lewat konsol dan instalasi lewat percakapan

- Contoh penggunaan Skill

- Menghapus Skill yang sudah terpasang

- FAQ


> 💡 **Skill bersifat opsional**
>
> Hermes tidak memasang Skill apa pun secara default. Hermes tetap dapat mengobrol normal tanpa Skill terpasang. Skill hanya dipakai untuk memperluas kemampuan tugas tertentu. Kami menyarankan Anda memasangnya sesuai kebutuhan setelah Anda menemukan batas kemampuan saat pemakaian.

---

## Posisi Skill

Jika Hermes yang dikombinasikan dengan large model memberi pengguna asisten AI yang cerdas, maka Skill adalah "tangan dan kakinya". Skill dapat memperluas lebih jauh batas kemampuan Hermes yang sudah berjalan.

Anda dapat menganggap Skill sebagai "aplikasi" untuk Hermes:

- Kemampuan percakapan dasar = sistem operasi

- Skill = aplikasi yang dipasang sesuai kebutuhan


Setiap Skill berfokus pada satu tugas, misalnya:

- Menjelajahi halaman web dan mencari informasi memakai browser

- Menyusun to-do harian secara otomatis

- Mengirim ringkasan berita terjadwal

- Menghasilkan gambar dari deskripsi

- Mencari informasi saham dan reksa dana secara real time

- Merapikan catatan percakapan menjadi catatan terstruktur


Hermes secara otomatis menentukan apakah perlu memanggil Skill terkait berdasarkan konteks percakapan. Pengguna tidak perlu menyebutkannya secara khusus.

---

---

## Metode 1: Instalasi melalui panel konsol (segera tersedia)

Konsol LightVela menyediakan pintu masuk konfigurasi Skill visual di tombol "Skills". Anda dapat memasukkan nama Skill yang Anda temukan di Skills.sh atau ClawHub lalu memasangnya dengan cepat.

### 1. Masuk ke konsol LightVela

Masuk ke LightVela, klik "My AI Partners" di kanan atas untuk membuka konsol, lalu temukan tombol "Skills".

### 2. Cari dan pasang

Masukkan nama Skill yang sudah Anda catat di kotak pencarian (misalnya `gmail`) lalu klik tombol **+**.

![](../images/clawhub-install-global-en.webp)

### 3. Pastikan ketersediaannya dalam percakapan

Kembali ke kanal yang terhubung (Telegram / WhatsApp / Discord / Slack / WeChat). Minta Hermes memperbarui daftar Skill-nya terlebih dahulu, lalu periksa Skill yang saat ini tersedia:

```
Tolong perbarui daftar Skill kamu
```

```
Skill apa saja yang saat ini tersedia?
```

Jika Skill yang baru dipasang muncul di daftar, Anda dapat mulai memakainya dalam percakapan.

---

## Metode 2: Instalasi langsung melalui percakapan

Selain memakai panel konsol, Anda juga dapat meminta Hermes memasang Skill langsung melalui percakapan. Skill yang ingin dipasang tetap harus terdaftar di Skills.sh atau ClawHub.

### 1. Pastikan kanal percakapan tersedia

Pastikan dulu Hermes terhubung ke setidaknya satu kanal (Telegram / WhatsApp / Discord / Slack / WeChat) dan saat ini dapat mengobrol dengan normal.

### 2. Beri tahu Hermes Skill mana yang ingin dipasang

Gunakan perintah di bawah sebagai acuan. Beri tahu Hermes Skill apa yang ingin Anda pasang dan ganti `[nama skill]` dengan nama sebenarnya dari Skills.sh atau ClawHub:

```
Tolong pasang sebuah Skill dari Skills.sh atau ClawHub. Namanya [nama skill]
```

Misalnya, untuk memasang `mcd` (asisten McDonald's):

```
Tolong pasang sebuah Skill dari Skills.sh atau ClawHub. Namanya mcd
```

Jika semuanya berjalan lancar, Hermes akan langsung menyelesaikan instalasi dan memberi tahu hasilnya.

> ⚠️ **Konfirmasi kedua untuk Skill berisiko tinggi**
>
> Jika Skill yang dipilih ditandai berisiko tinggi di Skills.sh atau ClawHub (mungkin memuat perilaku yang tidak aman), Hermes akan mengingatkan Anda dan meminta konfirmasi kedua sebelum instalasi. Pastikan Anda benar-benar memahami perilaku Skill tersebut sebelum memutuskan untuk melanjutkan. Jika Anda belum yakin, lanjutkan dengan hati-hati.

### 3. Verifikasi hasil instalasi

Anda dapat meminta Hermes menunjukkan cara memakai Skill tersebut untuk memastikan instalasinya berhasil:

```
Tolong tunjukkan cara memakainya
```

Atau sebutkan nama Skill-nya secara eksplisit:

```
Tolong tunjukkan cara memakai mcd
```

---

## Contoh penggunaan Skill

Dengan contoh Skill operasi browser `agent-browser`, setelah instalasi Anda dapat meminta Hermes menjalankan tugas berikut.

> ℹ️ **Catatan**
>
> Contoh berikut memakai kanal WeChat. Telegram, WhatsApp, Discord, dan Slack bekerja dengan cara yang sama.

### Skenario 1: Menjelajahi halaman web

```
Pakai browser untuk membuka Baidu lalu beri tahu saya apa isi halamannya
```

Hermes akan membuka halaman tersebut dan mengembalikan isinya dalam bentuk teks.

### Skenario 2: Mencari informasi melalui browser

```
Pakai browser untuk mencari 5 berita paling populer hari ini
```

### Skenario 3: Tugas kompleks dengan banyak langkah

```
Pakai browser untuk mencari di ClawHub dan temukan Skill email yang saat ini paling banyak dipasang
```

Tugas ini mencakup beberapa langkah seperti membuka halaman web, menunggu halaman dimuat, memasukkan konten, dan mengklik tombol. Tugasnya relatif kompleks. Hermes akan menyelesaikan langkah-langkah tersebut dan mengembalikan hasilnya.

![](../images/clawhub-browser-example-global-en.webp)

---

## Menghapus Skill yang sudah terpasang

Jika Anda tidak lagi memakai Skill yang terpasang, Anda dapat meminta Hermes menghapusnya melalui percakapan.

### 1. Lihat Skill yang saat ini terpasang

```
Skill apa saja yang saat ini kamu pasang?
```

### 2. Minta penghapusan Skill tertentu

Temukan Skill yang ingin Anda hapus lalu kirim perintah penghapusan:

```
Tolong hapus Skill email
```

Jika semuanya berjalan lancar, Hermes akan menyelesaikan penghapusan dan memberi tahu hasilnya.

> ℹ️ **Kemungkinan ada konfirmasi kedua**
>
> Tergantung model yang dipakai atau pengaturan kepribadian Hermes, ia mungkin mengingatkan Anda untuk berhati-hati saat menghapus. Balas dengan konfirmasi sesuai kebutuhan Anda yang sebenarnya.

### 3. Verifikasi hasil penghapusan

Periksa kembali Skill yang saat ini terpasang lalu pastikan Skill tujuan sudah hilang dari daftar:

```
Periksa lagi Skill apa saja yang saat ini kamu pasang
```

> ℹ️ **Saat ini hanya penghapusan lewat percakapan yang didukung**
>
> LightVela memakai mode cloud terkelola dan tidak menyediakan operasi sistem file bagi pengguna. Skill hanya dapat dihapus melalui percakapan dengan Hermes.

---

## Kondisi berhasil

- Skill tujuan muncul di daftar "Installed skills" pada konsol

- Ketika Anda membuat permintaan terkait dalam percakapan, Hermes dapat mengenali dan memanggil Skill tersebut dengan benar

- Skill dapat dihapus dengan normal melalui percakapan


---

## Tips keamanan instalasi

Skill memiliki izin untuk memanggil kemampuan Hermes saat runtime dan dapat melibatkan:

- Pemanggilan API eksternal (mengonsumsi kuota terkait)

- Pembacaan atau pengiriman isi percakapan

- Menjalankan operasi terjadwal

Sebelum instalasi, pastikan pembuat Skill dapat dipercaya. Kami menyarankan:

- Utamakan Skill yang sudah terverifikasi resmi di Skills.sh atau ClawHub

- Utamakan Skill dengan jumlah unduhan tinggi dan ulasan yang baik

- Baca dengan cermat penjelasan izin di deskripsi Skill

- Tetap berhati-hati dengan Skill yang deskripsinya tidak jelas atau pembuatnya tidak dikenal


---

## FAQ

### Skill tidak dapat ditemukan

**Kemungkinan penyebab**: Nama salah tulis, atau Skill sudah dihapus dari Skills.sh atau ClawHub.

**Solusi**: Buka [**Skills.sh**](https://skills.sh/) atau [**ClawHub**](https://clawhub.ai/) untuk memastikan nama Skill yang tepat dan status terkininya.

### Instalasi berhasil tetapi tidak berfungsi dalam percakapan

**Kemungkinan penyebab**: Model tidak mengenali bahwa Skill tersebut perlu dipakai, atau daftar Skill belum disegarkan.

**Solusi**:

1. Kirim "Tolong perbarui daftar Skill kamu" dalam percakapan

2. Gunakan instruksi yang lebih jelas, seperti "Pakai Skill XX untuk menyelesaikan YY"


### Instalasi menampilkan "rate limit triggered, please try again later"

**Kemungkinan penyebab**: Skills.sh dan ClawHub menerapkan rate limit API untuk menjaga kestabilan layanan.

**Solusi**: Tunggu beberapa saat lalu coba lagi. Kami menyarankan untuk menghindari jam sibuk.

### Pemanggilan Skill terus gagal

**Kemungkinan penyebab**:

- Layanan eksternal yang dibutuhkan Skill sementara tidak tersedia

- Versi Skill sudah kedaluwarsa

- Model terkait tidak mendukung kemampuan yang dibutuhkan Skill, seperti tool calling


**Solusi**:

- Periksa komentar dan informasi versi terbaru Skill tersebut di Skills.sh atau ClawHub

- Coba ganti ke model yang mendukung tool calling

- Jika masalahnya berlanjut, hubungi pembuat Skill


### Terlalu banyak Skill terpasang membuat Hermes merespons lambat

**Kemungkinan penyebab**: Makin banyak Skill, makin berat beban pengambilan keputusan Agent.

**Solusi**: Simpan hanya Skill yang sering dipakai lalu hapus Skill yang sudah tidak Anda gunakan.

### Cara mengembangkan Skill

Lihat dokumentasi developer Skills.sh dan ClawHub (jika tersedia).

---

## Langkah berikutnya

Konfigurasi dasar LightVela sudah selesai. Anda dapat merujuk ke:

- [Ringkasan Konfigurasi](../05-configuration.md)

- [Konsep Inti](../04-core-concepts.md)

- [Panduan Cepat](../02-quickstart.md)
