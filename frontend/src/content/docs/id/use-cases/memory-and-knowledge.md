# Mengelola Memori Jangka Panjang dan Pengetahuan Pribadi

Pengetahuan yang berguna hadir dalam dua bentuk yang sangat berbeda. Sebagian informasi seharusnya tetap stabil karena ia menggambarkan Anda dan cara Anda bekerja; informasi lain termasuk di dokumen, catatan, dan material proyek yang berubah seiring waktu. Memperlakukan keduanya sebagai hal yang sama membuat asisten menjadi kurang berguna.

LightVela memberi Hermes Agent memori jangka panjang sekaligus penyimpanan file cloud. Memori membantunya mempertahankan konteks yang tahan lama lintas percakapan; Cloud Storage memberi Anda tempat untuk menyimpan material kerja dan file referensi. Dipakai bersama, keduanya membuat AI agent pribadi lebih mudah diberi arahan, ditinjau ulang, dan diperbaiki.

![Memori Agent LightVela dan pengetahuan pribadi](../images/use-case-agent-memory.webp)

## Ringkasan

**Pengetahuan pribadi hadir dalam dua bentuk yang harus dikelola secara terpisah: informasi stabil tentang siapa Anda dan bagaimana Anda bekerja termasuk di memori jangka panjang, sementara dokumen, catatan, dan material proyek yang terus berkembang termasuk di cloud storage.** Mengelola keduanya sebagai satu hal membuat Anda kehilangan kestabilan dan kemudahan penemuan sekaligus. Di LightVela, memori mempertahankan konteks lintas percakapan — halaman memori di konsol menampilkan apa yang sudah dipertahankan melalui tab Memory dan User Profile yang terpisah serta memungkinkan Anda menyesuaikan batas kapasitasnya, sementara penambahan dan penghapusan terutama terjadi melalui percakapan dengan Hermes. Cloud storage adalah ruang kerja filenya, mendukung unggah, buat, tata, unduh, ganti nama, dan hapus, dengan batas 1 GB per file. Satu aturan yang harus dipegang: jangan pernah menuliskan kata sandi, kunci, atau data sensitif yang tidak perlu ke dalam memori jangka panjang.

## Untuk siapa ini

Pola ini ditujukan bagi orang yang ingin asistennya memahami preferensi dan pekerjaan berulang mereka tanpa memintanya menghafalkan setiap dokumen. Ia berguna untuk proyek yang sedang berjalan, riset pribadi, catatan pembelajaran, pekerjaan klien, dan alur kerja apa pun yang konteksnya berulang seiring waktu.

Tujuannya bukan menciptakan arsip yang sempurna, melainkan membuat konteks yang penting mudah ditemukan dan menjaga Hermes tetap sejalan dengan bagian-bagian yang seharusnya bertahan.

## Prasyarat

- Hermes Agent yang sedang berjalan dan cara untuk mengobrol dengannya melalui konsol atau kanal terhubung.

- Pemahaman dasar tentang dua tempat informasi dapat berada: [Pengelolaan Memori](../configuration/memory.md) untuk konteks jangka panjang, dan [Cloud Storage](../configuration/files.md) untuk file dan folder.

- Sekumpulan kecil material yang benar-benar Anda kunjungi kembali, alih-alih tumpukan tanpa filter dari setiap file yang Anda miliki.

- Batas privasi yang jelas tentang apa yang ingin Anda pertahankan atau tinjau oleh Hermes.

## Langkah / konsep kunci

### 1. Pisahkan konteks yang stabil dari material referensi

Taruh fakta yang seharusnya membentuk percakapan berikutnya ke dalam memori: gaya penulisan yang Anda sukai, zona waktu, peran yang sedang Anda jalani, tujuan yang berulang, atau aturan tentang bagaimana Anda ingin sebuah proyek ditangani. Simpan material yang terus berubah — arahan, catatan rapat, draf, dan file riset — di Cloud Storage.

Misalnya, Anda dapat memberi tahu Hermes:

```text
Ingat bahwa saya lebih suka catatan riset memisahkan fakta, asumsi,
dan pertanyaan terbuka. Pakai struktur itu setiap kali kita meninjau sebuah proyek.
```

Intinya bukan membuat Hermes menyimpan setiap dokumen sumber sebagai memori, melainkan memberinya cara yang tahan lama untuk memahami bagaimana Anda ingin dokumen tersebut ditangani.

### 2. Tata file yang Anda perkirakan akan dikunjungi kembali

Buat struktur folder kecil di Cloud Storage yang sesuai dengan pekerjaan nyata Anda. Pakai nama yang bermakna dan simpan material yang berkaitan secara berdekatan, misalnya satu folder per klien, proyek, kursus, atau pertanyaan riset.

Ketika Anda ingin bantuan untuk sebuah file, beri tahu Hermes apa yang Anda coba lakukan lalu tunjukkan material yang relevan. Misalnya:

```text
Bantu saya bersiap untuk tinjauan proyek ini. Pakai arahan terbaru dan
catatan rapat saya, lalu daftarkan keputusan dan pertanyaan yang belum tuntas.
```

![Folder Cloud Storage dengan file proyek](../images/use-case-memory-knowledge-storage.png)

### 3. Tinjau memori alih-alih mengasumsikannya benar selamanya

Buka Pengelolaan Memori secara berkala untuk meninjau tab Memory dan User Profile. Profil pengguna adalah gambaran stabil tentang siapa Anda; memori memuat pengalaman berguna dan konteks kerja dari kolaborasi Anda dengan Hermes.

Jika sebuah preferensi berubah, nyatakan dengan jelas dalam percakapan:

```text
Saya tidak lagi menginginkan pembaruan pekanan yang panjang. Tolong lupakan preferensi itu
dan jaga ringkasan pekanan tetap lima poin.
```

Memori bekerja paling baik ketika ia tetap terkini. Hapus atau koreksi konteks yang akan menuntun Hermes ke arah yang salah alih-alih menambahkan instruksi kedua yang bertentangan.

### 4. Ubah pengetahuan yang sudah ditinjau menjadi percakapan kerja

Gunakan halaman [Chat](../configuration/agent-chat.md) atau kanal terhubung untuk mengubah dokumen dan memori menjadi langkah berikutnya yang konkret. Minta sebuah perbandingan, kerangka, kumpulan pertanyaan terbuka, atau rekap untuk rapat tertentu. Makin spesifik hasil langsungnya, makin mudah memastikan Hermes memegang konteks yang tepat.

Jika peninjauan Anda mengikuti ritme berulang, sebuah [Tugas Terjadwal](../configuration/automation.md) dapat mengingatkan Anda untuk mengunjungi kembali sebuah folder atau menyiapkan rekap berkala. Mulai dari pengingat atau ringkasan sederhana alih-alih memberikan tugas yang luas dan terbuka.

![Percakapan Hermes Agent memakai pengetahuan proyek yang tertata](../images/use-case-memory-knowledge-automation.png)

## FAQ

### Apa perbedaan antara memori dan Cloud Storage?

Memori adalah konteks tahan lama yang membantu Hermes memahami Anda dan kolaborasi Anda yang sedang berjalan. Cloud Storage adalah untuk file dan folder yang Anda kelola. Memori sebaiknya menangkap aturan dan preferensi yang penting; file sebaiknya menyimpan material yang mendasarinya.

### Apakah Hermes otomatis memperlakukan setiap file sebagai memori jangka panjang?

Tidak. Jaga pembedaannya tetap sengaja. Pakai Pengelolaan Memori untuk konteks yang bertahan, dan pakai Cloud Storage untuk menata material yang ingin Anda rujuk selama pekerjaan tertentu.

### Bisakah saya meminta Hermes melupakan sesuatu?

Bisa. Beri tahu Hermes apa yang seharusnya tidak lagi dipertahankan, lalu tinjau memori atau informasi profil pengguna yang relevan jika Anda ingin memastikan perubahannya.

### Apa yang sebaiknya saya taruh di memori lebih dulu?

Mulai dengan preferensi yang mengubah kualitas nyaris setiap percakapan: zona waktu, gaya komunikasi, peran, prioritas aktif, dan format yang Anda sukai untuk pekerjaan berulang.

## Langkah berikutnya

- [Pengelolaan Memori](../configuration/memory.md) — tinjau konteks jangka panjang dan kapasitasnya.

- [Cloud Storage](../configuration/files.md) — jaga dokumen di balik pekerjaan Anda tetap tertata.

- [Chat](../configuration/agent-chat.md) — manfaatkan memori dan material proyek dalam percakapan yang terfokus.
