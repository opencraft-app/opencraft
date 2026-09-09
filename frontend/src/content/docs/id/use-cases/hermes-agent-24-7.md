# Menjaga Hermes Agent Online 24/7

Sebuah asisten paling membantu ketika ia tersedia saat pertanyaannya datang — bukan hanya ketika laptop Anda terbuka. Itu penting untuk balasan cepat dari ponsel, briefing terjadwal yang seharusnya tiba sebelum jam kerja, atau tindak lanjut yang ingin Anda periksa setelah hari yang panjang.

Hermes Agent adalah AI agent berbasis cloud di LightVela. Begitu model dan kanal percakapannya dikonfigurasi, ia dapat tetap tersedia secara independen dari perangkat lokal Anda, dengan memori dan perilaku yang sama di mana pun Anda mengirim pesan kepadanya.

![Hermes Agent yang online di konsol LightVela](../images/use-case-hermes-online.webp)

## Ringkasan

**Hermes Agent tetap tersedia sepanjang waktu karena ia berjalan di instans cloud alih-alih mesin lokal Anda. Begitu sebuah model dan setidaknya satu kanal dikonfigurasi, ia memakai memori dan perilaku yang sama tidak peduli dari pintu masuk mana Anda mengirim pesan.** Tiga hal harus tersedia untuk ketersediaan jangka panjang yang sesungguhnya: model terkonfigurasi dengan kuota akun yang dapat dipakai (kredit uji coba yang habis menyebabkan tidak-membalas tanpa suara), setidaknya satu kanal yang tampil sebagai terhubung, dan tugas terjadwal untuk menangani pekerjaan terjadwal saat Anda tidak ada. Jangan menilai ketersediaan dari status konsol saja — kirim pesan nyata melalui kanal yang sebenarnya. Ketika ada yang bermasalah, lihat dan ekspor log terbaru di Diagnostik (rentang 1, 3, 6, 12, atau 24 jam yang dapat dipilih) untuk menemukan penyebabnya.

## Untuk siapa ini

Pakai pola ini jika Anda menginginkan asisten yang dapat Anda jangkau dari ponsel, kanal tim, atau konsol tanpa harus membiarkan komputer tetap menyala. Ia juga cocok untuk rutinitas terjadwal seperti briefing harian, pengingat, atau pemeriksaan status berkala.

Online tidak sama dengan tanpa pengawasan. Anda tetap perlu memilih Skill yang terpercaya, meninjau instruksi berulang, dan memastikan model serta kanalnya terus bekerja seperti yang diharapkan.

## Prasyarat

- Hermes Agent yang sedang berjalan di konsol LightVela Anda. [Panduan Cepat](../02-quickstart.md) membahas penyiapan akun dan pembuatan pertama.

- Konfigurasi model yang berfungsi atau kredit uji coba yang tersedia. Hermes memerlukan model sebelum dapat menghasilkan balasan.

- Setidaknya satu kanal terhubung, seperti Telegram, WhatsApp, Discord, Slack, atau WeChat, sehingga Anda punya cara praktis untuk menjangkaunya.

- Tugas berulang yang opsional jika Anda ingin Hermes melakukan lebih dari menunggu pesan.

## Langkah / konsep kunci

### 1. Buat Agent dapat dijangkau dari kanal yang benar-benar Anda pakai

Pilih satu kanal sebagai cara default Anda menghubungi Hermes. Untuk pemakaian pribadi, pilihan terbaik biasanya aplikasi yang sudah Anda periksa beberapa kali sehari. Hubungkan, kirim pesan uji singkat, dan pastikan Hermes membalas sebelum menambahkan penyiapan lain.

Instruksi terperinci tersedia untuk [Telegram](../configuration/channel-telegram.md), [WhatsApp](../configuration/channel-whatsapp.md), [Discord](../configuration/channel-discord.md), [Slack](../configuration/channel-slack.md), dan [WeChat](../configuration/channel-wechat.md).

![Hermes Agent yang berjalan dengan kanal terhubung](../images/use-case-hermes-online-channel.png)

### 2. Jaga konfigurasi kerjanya tetap sederhana dan terlihat

Bagian yang penting adalah model aktif, kanal terhubung, Skill terpasang, dan memori. Anda tidak perlu sering mengubahnya, tetapi berguna untuk tahu di mana semuanya berada ketika sebuah balasan tidak datang atau sebuah tugas membutuhkan kemampuan baru.

Gunakan [Konfigurasi Model](../configuration/model.md) untuk memastikan model aktif, dan catat situasi penyedia atau kredit uji coba Anda. Jika Anda memasang Skill, tambahkan hanya yang dibutuhkan untuk alur kerja nyata lalu tinjau di [Konfigurasi Skill](../configuration/skill.md).

### 3. Pakai memori agar asistennya berkesinambungan

Asisten yang selalu aktif menjadi lebih berguna ketika ia tidak memulai dari nol. Beri tahu Hermes preferensi dan konteks kerja yang ingin Anda bawa ke percakapan berikutnya, lalu tinjau dari waktu ke waktu di [Pengelolaan Memori](../configuration/memory.md).

Misalnya:

```text
Ingat bahwa saya lebih suka pembaruan dalam bentuk poin-poin dan bahwa pekerjaan
mendesak sebaiknya ditandai dengan jelas.
```

Ini membuat pesan yang dikirim dari perangkat atau kanal lain yang didukung dapat melanjutkan relasi kerja yang sama alih-alih memulai dari halaman kosong.

### 4. Tambahkan tugas terjadwal ketika ketersediaan seharusnya berujung pada tindakan

Hermes yang online dapat menunggu pesan Anda, tetapi tugas terjadwal kecil membuatnya dapat memulai rutinitas yang sudah diketahui pada waktu yang tepat. Mulai dengan satu tugas yang punya kondisi keberhasilan yang jelas:

```text
Setiap hari kerja pukul 08.30, siapkan briefing singkat berisi prioritas
kalender hari ini, tindak lanjut yang masih terbuka, dan tindakan pertama yang perlu diambil.
```

Buat jadwalnya di [Tugas Terjadwal](../configuration/automation.md), pilih kanal notifikasi bila sesuai, lalu periksa beberapa eksekusi pertama. Jika hasilnya terlalu luas, buat instruksinya lebih spesifik alih-alih langsung menambahkan tugas terjadwal lain.

![Eksekusi tugas terjadwal terbaru dari sebuah Hermes Agent](../images/use-case-hermes-online-automation.png)

## FAQ

### Apakah Hermes memerlukan laptop saya tetap menyala?

Tidak. Hermes berjalan di lingkungan cloud LightVela, sehingga Anda dapat menutup perangkat lokal setelah Agent dan kanalnya dikonfigurasi.

### Mengapa Hermes online tetapi tidak membalas?

Pertama pastikan koneksi kanal dan status model aktif atau kredit uji coba Anda. Jika Anda baru mengubah konfigurasi, biarkan pembaruannya selesai, lalu kirim pesan uji sederhana lagi. Halaman [Diagnostik](../configuration/diagnostics.md) dapat membantu dengan pemeliharaan dan log terbaru.

### Bisakah saya menghubungkan lebih dari satu kanal?

Bisa. Kanal yang didukung dapat mengarah ke Hermes Agent yang sama. Semuanya berbagi perilaku dan memori Agent yang sama, jadi pilih satu kanal default lalu tambahkan yang lain hanya ketika mereka menjawab kebutuhan akses yang nyata.

### Apakah Agent 24/7 aman untuk ditugas terjadwalkan?

Pakai hanya instruksi yang cakupannya jelas dan Skill yang terpercaya. Mulai dengan rutinitas yang bersifat baca-saja atau berisiko rendah, tinjau keluarannya, dan hindari memberi tugas terjadwal wewenang untuk melakukan tindakan yang tidak ingin Anda ulangi secara otomatis.

## Langkah berikutnya

- [Tugas Terjadwal](../configuration/automation.md) — jadwalkan pekerjaan yang seharusnya terjadi tanpa prompt manual.

- [Pengelolaan Memori](../configuration/memory.md) — jaga preferensi yang berguna tetap tersedia lintas percakapan.

- [Diagnostik](../configuration/diagnostics.md) — selidiki masalah kanal atau model ketika Hermes tidak merespons.
