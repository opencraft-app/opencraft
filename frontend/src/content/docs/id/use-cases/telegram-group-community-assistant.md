# Asisten Komunitas AI untuk Grup Telegram

Asisten komunitas AI umumnya perlu menangani empat jenis pekerjaan: menyambut anggota, menjawab pertanyaan umum, merangkum diskusi, dan mengirim pengingat terjadwal.

Namun, dokumentasi kanal Telegram situs internasional LightVela saat ini menyatakan bahwa Telegram untuk sekarang hanya mendukung percakapan satu lawan satu, sehingga halaman ini bukan tutorial koneksi grup yang langsung dapat dijalankan.

Halaman ini mencatat pendekatan rancangan, pemeriksaan pra-peluncuran, dan alternatif saat ini sampai dukungan grup memiliki jalur produk yang terdokumentasi dengan jelas.

## Ringkasan

**Mulailah dari batas kemampuannya: halaman kanal Telegram menyatakan terang-terangan bahwa chat grup saat ini tidak didukung dan hanya percakapan satu lawan satu yang berfungsi, sehingga alur lengkap menambahkan bot ke grup Telegram dan menyambut anggota secara otomatis belum dapat diselesaikan di LightVela hari ini.** Baik mode privasi BotFather maupun menyebut bot dengan @mention di grup tidak menggantikan dukungan grup di tingkat kanal pada LightVela. Jalur yang dapat dikerjakan sekarang: hubungkan percakapan satu lawan satu sesuai panduan kanal, matangkan keempat alur konten — sambutan, FAQ, ringkasan, pengingat — di pesan langsung, lalu selesaikan checklist pra-peluncuran. Dengan begitu, ketika dukungan grup dirilis, Anda hanya mengganti konteks pemicunya; konten dan personanya tidak perlu dikerjakan ulang. Perlakukan halaman ini sebagai panduan rancangan dan persiapan alih-alih panduan implementasi.

## Batas kemampuan saat ini

Catatan kanal pada halaman kanal Telegram saat ini secara eksplisit menyatakan bahwa chat grup untuk sekarang tidak didukung dan hanya percakapan satu lawan satu yang didukung.

Karena itu, LightVela saat ini tidak dapat menyelesaikan alur lengkap menambahkan Bot ke grup Telegram dan menyambut anggota baru secara otomatis melalui halaman ini.

Mode privasi BotFather atau pengaturan @mention grup Telegram tidak menggantikan dukungan LightVela untuk pemrosesan chat grup.

Jika Anda membutuhkan Telegram sekarang, hubungkan percakapan satu lawan satu melalui [Kanal Telegram](../configuration/channel-telegram.md), lalu validasi alur kerja FAQ, ringkasan, dan pengingat di chat pribadi.

![Asisten komunitas AI grup Telegram untuk pesan sambutan, FAQ, ringkasan, dan pengingat](../images/use-case-08-telegram-group-community-assistant.png)

## Untuk siapa ini

Panduan persiapan ini ditujukan bagi orang yang merancang asisten komunitas Telegram atau menata kebutuhan produk dan aturan operasional lebih awal.

Ia juga ditujukan bagi tim yang sudah memvalidasi Skill dan alur kerja konten dalam percakapan satu lawan satu dan sedang menunggu dukungan chat grup.

## Rancang keempat kemampuan asisten komunitas

Sebelum mengonfigurasi kanal, tentukan pemicu, format keluaran, dan perilaku kegagalan untuk setiap kemampuan.

| Kemampuan | Pemicu yang disarankan | Persyaratan keluaran | Perilaku saat gagal |
|---|---|---|---|
| Pesan sambutan | Event anggota baru | Sambutan singkat, aturan komunitas, dan pintu masuk untuk bertanya | Jangan mengulang pesan ketika event-nya terduplikasi atau hilang |
| FAQ | Pertanyaan anggota atau @mention | Pakai hanya material yang sudah dikonfirmasi dan sertakan sumber bila berguna | Alihkan dengan jelas ke manusia atau admin ketika jawabannya tidak tersedia |
| Ringkasan diskusi | Permintaan admin atau waktu terjadwal | Pisahkan kesimpulan, item tindakan, penanggung jawab, dan pertanyaan terbuka | Nyatakan cakupan ringkasannya ketika konteksnya tidak lengkap |
| Pengingat | Waktu terjadwal atau tugas yang dibuat admin | Sertakan waktu, audiens, tujuan, dan cara membatalkan | Beri tahu admin saat gagal alih-alih berulang kali mengirim spam |

## Checklist persiapan

### 1. Tentukan kepribadian Agent dan aturan komunitas

Gunakan [panduan kepribadian SOUL.md](./im-agent-persona-soul-md.md) untuk menentukan peran, suara, batas informasi, dan aturan pengalihan ke manusia bagi asisten tersebut.

Tentukan juga apakah ia boleh berbicara secara proaktif, apakah ia harus disebut dengan mention sebelum membalas, dan bagaimana ia seharusnya menyerahkan konten kontroversial kepada admin.

Jangan memperlakukan arahan kepribadian sebagai pengganti otorisasi platform, privasi, atau batas laju pesan.

### 2. Siapkan FAQ dan material referensi

Tata ringkasan produk, aturan komunitas, jam layanan, kontak admin, dan jalur eskalasi menjadi material referensi yang dapat dipelihara.

Taruh material yang perlu dirujuk dari waktu ke waktu di [Cloud Storage](../configuration/files.md) alih-alih memasukkan kumpulan FAQ yang besar ke dalam memori jangka panjang.

Mulai dengan menguji permintaan ini dalam percakapan satu lawan satu:

    Jawab hanya dari FAQ yang sudah disiapkan. Jika tidak ada material pendukung, katakan bahwa informasinya tidak tersedia dan sarankan pengalihan ke manusia.

### 3. Rancang templat ringkasan dan pengingat

Sebuah ringkasan sebaiknya memisahkan kesimpulan yang sudah dikonfirmasi, item tindakan, penanggung jawab, dan pertanyaan yang belum tuntas.

Sebuah pengingat sebaiknya memuat waktu, audiens, tujuan, dan cara membatalkan, dengan frekuensi yang wajar dan jam tenang.

Validasi alur kerja ini melalui [Otomasi](../configuration/automation.md) di kanal tujuan yang didukung sebelum merencanakan penggelaran grup.

### 4. Pilih Skill yang terpercaya

Jika Anda memerlukan penelusuran referensi, ringkasan diskusi, atau konten terjadwal, pilih Skill dari [Skills.sh](https://skills.sh/) atau [ClawHub](https://clawhub.ai/).

Baca panduan izin dan Skill berisiko tinggi di [Konfigurasi Skill](../configuration/skill.md) sebelum memasang apa pun.

Validasi Skill tersebut dalam percakapan satu lawan satu sebelum mempertimbangkan penggelaran grup apa pun.

## Yang perlu diverifikasi jika dukungan grup tersedia

- Apakah Bot dapat menerima event anggota bergabung serta membedakan anggota, admin, dan identitas anonim.

- Apakah pesan grup hanya terpicu pada @mention atau perintah yang eksplisit.

- Apakah Anda dapat mengonfigurasi daftar grup, anggota, atau admin yang diizinkan.

- Apakah pesan grup masuk ke memori jangka panjang bersama dan bagaimana ia dicegah bocor ke anggota lain.

- Apakah pesan sambutan, FAQ, ringkasan, dan pengingat memiliki batas laju serta deduplikasi yang terpisah.

- Apakah pesan eksternal, perubahan file, saran moderasi, dan tindakan berisiko tinggi lainnya membutuhkan konfirmasi admin.

- Bagaimana seorang admin mengambil alih ketika Bot gagal, layanannya tidak tersedia, atau jawabannya tidak pasti.

## Jalur validasi yang dapat dikerjakan saat ini

Bagi rencananya menjadi dua tahap untuk sekarang.

Pada tahap satu, validasi kepribadian, FAQ, ringkasan, pengingat, dan Skill dalam percakapan satu lawan satu di Telegram.

Pada tahap dua, setelah dokumentasi produk secara eksplisit mendukung grup Telegram, tambahkan langkah nyata untuk Bot bergabung, izin grup, @mention, dan isolasi memori grup.

Jika Anda membutuhkan asisten grup segera, pilih kanal yang dokumentasi produknya saat ini secara eksplisit memastikan dukungan grup lalu ikuti panduan akses dan izin kanal tersebut.

## FAQ

### Bisakah saya menambahkan bot Telegram LightVela ke sebuah grup sekarang?

Tidak, menurut dokumentasi kanal Telegram internasional saat ini.

Cakupan dukungan saat ini tetap percakapan satu lawan satu, dan halaman ini tidak menyediakan langkah penyiapan untuk fitur grup yang belum tersedia.

### Apakah menonaktifkan mode privasi di BotFather akan membuatnya berfungsi?

Belum tentu.

Mode privasi BotFather mengubah cara bot Telegram menerima pesan, tetapi ia tidak menambahkan kemampuan pemrosesan grup yang saat ini belum diekspos LightVela.

### Bisakah saya menyiapkan Skill sambutan, FAQ, dan ringkasan sekarang?

Bisa.

Siapkan material referensinya, validasi keluarannya dalam percakapan satu lawan satu, lalu catat kebutuhan mendatang untuk pemicu, izin, privasi, dan batas laju.

### Bisakah grup WhatsApp dipakai sebagai alternatif?

Dokumentasi kanal WhatsApp saat ini juga menyatakan chat grup tidak didukung dan hanya percakapan satu lawan satu yang didukung.

Jika Anda membutuhkan kemampuan grup segera, rujuk dokumentasi resmi terkini untuk kanal lain alih-alih mengasumsikan dukungan satu lawan satu Telegram atau WhatsApp meluas ke grup.

## Langkah berikutnya

- [Kanal Telegram](../configuration/channel-telegram.md) — Selesaikan penyiapan satu lawan satu Telegram yang saat ini didukung.

- [Mengubah IM Agent Menjadi Asisten Layanan, Komunitas, atau Pendamping](./im-agent-skill-scenarios.md) — Siapkan Skill untuk FAQ, ringkasan, dan pengingat.

- [Menentukan Peran, Kepribadian, dan Suara IM Agent](./im-agent-persona-soul-md.md) — Tentukan suara dan batasan asisten komunitas.

- [Otomasi](../configuration/automation.md) — Validasi pengingat terjadwal di kanal yang didukung.
