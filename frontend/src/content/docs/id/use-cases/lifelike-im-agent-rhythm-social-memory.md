# Merancang IM Agent yang Lebih Natural

Menjadi lebih hidup tidak berarti membuat Agent menirukan orang nyata; ia berarti memberinya pola yang stabil dan mudah dipahami untuk ekspresi, respons, dan kolaborasi jangka panjang.

Ritme percakapan menentukan kapan ia sebaiknya menjawab singkat, kapan ia sebaiknya menjelaskan lebih banyak, dan kapan ia sebaiknya berhenti lalu menunggu konfirmasi.

Norma grup menentukan bagaimana ia berbicara di ruang bersama, memakai konteks, dan menghormati batasan anggota.

Memori sosial jangka panjang menentukan apakah ia dapat mempertahankan konteks relasi yang sudah dikonfirmasi tanpa mengubah setiap percakapan menjadi catatan permanen.

![Merancang IM Agent yang lebih natural dengan ritme percakapan, norma grup, dan memori sosial](../images/use-case-10-lifelike-im-agent-rhythm-social-memory.png)

## Ringkasan

**"Lebih hidup" tidak berarti menirukan orang nyata. Ia berarti menjaga perilaku yang stabil dan mudah dipahami dalam ekspresi, respons, dan kolaborasi jangka panjang, dan itu bermuara pada tiga hal: ritme percakapan, norma grup, dan memori sosial jangka panjang.** Ritme menentukan kapan ia menjawab singkat, kapan ia menguraikan, dan kapan ia sebaiknya berhenti lalu menunggu konfirmasi. Norma grup menentukan bagaimana ia berbicara di ruang bersama, bagaimana ia mengutip konteks, dan bagaimana ia menghormati batasan anggota. Memori sosial jangka panjang menentukan apakah ia mempertahankan konteks relasi yang sudah dikonfirmasi tanpa mengubah setiap pesan menjadi catatan permanen. Terapkan ini secara berlapis: ritme dan norma adalah aturan tingkat persona yang stabil, sementara memori hanya menyimpan fakta yang sudah dikonfirmasi dan tahan lama. Pakai checklist percakapan natural di panduan ini untuk memverifikasi rancangannya.

## Untuk siapa ini

Panduan ini ditujukan bagi orang yang ingin IM Agent terasa lebih natural dan konsisten sambil tetap transparan dan dapat dikendalikan.

Ia cocok untuk asisten pribadi, mitra belajar, mitra riset, dan tim yang merancang asisten komunitas.

Telegram mendukung pesan grup setelah Anda menonaktifkan Group Privacy di BotFather, menambahkan Bot ke grup, dan menyebutnya dengan `@username_bot`.
Kemampuan grup WhatsApp tetap mengikuti dokumentasi kanalnya sendiri, jadi terapkan norma grup ini pada Telegram setelah penyiapan dan verifikasi dukungan sebelum memakai kanal lain.

## Tentukan apa yang seharusnya tetap stabil

Bagi perilaku tahan lama Agent ke dalam empat lapisan:

| Lapisan | Tanggung jawab | Konfigurasi yang disarankan |
|---|---|---|
| Kepribadian | Peran, suara, prinsip, dan batasan | SOUL.md |
| Preferensi relasi | Nama, bahasa, tingkat kedetailan, dan kebiasaan interaksi | Profil pengguna |
| Memori sosial | Konteks bersama yang sudah dikonfirmasi, latar belakang proyek, dan kesepakatan yang berjalan | Memori |
| Ritme saat ini | Konteks percakapan, panjang, dan urgensi untuk tugas ini | Sesi saat ini dan prompt tugas |

Jangan biarkan satu emosi sesaat atau balasan yang tak sengaja mengubah kepribadian yang tahan lama.

Jangan menyimpan setiap sapaan, setiap pesan anggota grup, atau kesimpulan yang belum dikonfirmasi sebagai memori sosial jangka panjang.

## Langkah-langkah

### 1. Tentukan peran yang natural tanpa penyamaran identitas

Gunakan [panduan kepribadian SOUL.md](./im-agent-persona-soul-md.md) untuk menentukan peran, suara, tingkat inisiatif, dan keterbatasan Agent.

Mulai dengan arahan seperti ini:

    Kamu adalah mitra riset yang stabil, langsung, dan ramah.
    Berikan kesimpulan lebih dulu, lalu tambahkan bukti dan detail sesuai kebutuhan.
    Ketika permintaannya ambigu, ajukan satu pertanyaan klarifikasi yang paling penting.
    Ingat preferensi jangka panjang yang sudah dikonfirmasi, tetapi jangan menyimpan informasi sensitif atau kesimpulan yang belum dikonfirmasi.
    Kamu adalah asisten AI. Jangan mengaku sebagai manusia atau berpura-pura memiliki pengalaman di dunia nyata.

Ini menjaga suaranya tetap koheren tanpa membangun kepercayaan yang menyesatkan melalui identitas fiktif.

### 2. Rancang ritme percakapannya

Mulai dengan aturan seperti berikut:

- Berikan jawaban langsung dalam satu sampai tiga kalimat untuk pertanyaan faktual yang sederhana.

- Nyatakan ulang tujuannya lalu uraikan langkah dan risikonya sebelum menangani tugas yang kompleks.

- Ajukan hanya pertanyaan yang paling penting ketika informasinya tidak tersedia alih-alih mengirim formulir panjang.

- Kurangi panjang responsnya ketika pengguna menyatakan sedang sibuk, terburu-buru, atau hanya menginginkan kesimpulannya.

- Perluas penalarannya ketika pengguna meminta penurunan, tutorial, atau retrospektif.

- Berhenti lalu tunggu konfirmasi sebelum tindakan yang bersifat eksternal, sensitif, atau tak dapat dibalik.

Validasi ritmenya dengan tugas nyata:

    Beri saya tiga tugas terpenting untuk hari ini dalam tiga kalimat.

    Berikan kesimpulannya lebih dulu, lalu jelaskan mengapa kamu mengurutkannya seperti itu.

    Tindakan ini mengubah data eksternal. Beri tahu saya dulu dampaknya dan apa yang perlu dikonfirmasi.

Periksa apakah Agent mengubah panjang responsnya sesuai tugas dan preferensi pengguna sambil mempertahankan prinsip yang sama.

### 3. Taruh preferensi relasi di profil pengguna

Profil pengguna sesuai untuk bahasa, nama, zona waktu, tingkat kedetailan, dan gaya kerja yang umum.

Misalnya, seorang pengguna dapat memberi tahu Hermes:

    Ingat bahwa saya lebih suka balasan yang ringkas, langsung, dan mengutamakan kesimpulan.

Preferensi relasi sebaiknya meningkatkan efisiensi komunikasi, bukan menjadi label kepribadian permanen yang tidak dapat diubah pengguna.

Ketika sebuah preferensi berubah, minta Hermes memperbarui atau melupakannya alih-alih berulang kali menyunting file kepribadian.

### 4. Rancang memori sosial jangka panjang

Kandidat jangka panjang yang baik mencakup konteks proyek yang sudah dikonfirmasi, kesepakatan kolaborasi yang tahan lama, nama panggilan yang stabil, dan preferensi yang berulang kali terverifikasi.

Kandidat jangka panjang yang buruk mencakup kata sandi, kode verifikasi, informasi pembayaran, detail medis, penilaian psikologis yang belum dikonfirmasi, dan obrolan ringan sekali pakai.

Minta Hermes secara eksplisit untuk mengingat atau melupakan sebuah item, lalu tinjau dan bersihkan secara berkala di [Pengelolaan Memori](../configuration/memory.md).

Memori jangka panjang sebaiknya mengurangi pertanyaan yang berulang tanpa mengambil kendali pengguna atas informasi mereka sendiri.

### 5. Siapkan norma grup untuk ruang bersama

Telegram dan WhatsApp saat ini tidak mendukung chat grup, jadi tuliskan norma grup sebagai aturan pra-peluncuran untuk sekarang.

Jika kanal tujuan di masa depan secara eksplisit mendukung grup, tentukan setidaknya:

- Apakah Bot hanya membalas setelah @mention atau perintah yang eksplisit.

- Apakah seorang admin harus memicu pesan sambutan untuk anggota baru.

- Batas frekuensi untuk FAQ, ringkasan, dan pengingat.

- Cara membedakan anggota, admin, dan pesan yang membutuhkan pengalihan ke manusia.

- Apakah pesan anggota masuk ke memori bersama dan bagaimana ia dicegah bocor ke anggota lain.

- Bagaimana sengketa, keluhan, saran moderasi, dan konten sensitif diserahkan kepada admin.

Norma grup termasuk pada aturan kanal dan operasional, dan seharusnya tidak hanya bersandar pada prompt kepribadian.

### 6. Pakai tugas terjadwal untuk mengendalikan ritme proaktif

Pesan proaktif membutuhkan frekuensi, jendela waktu, kanal tujuan, dan cara menjeda yang eksplisit.

Gunakan [Tugas Terjadwal](../configuration/automation.md) untuk pengingat pribadi, ringkasan internal, atau pemeriksaan berkala.

Atur jam tenang untuk setiap tugas terjadwal lalu pastikan kanal tujuannya mendukung metode pengiriman proaktif yang relevan.

Jangan menciptakan rasa pendampingan melalui pesan berfrekuensi tinggi, dan jangan membuat pengingat sulit dihentikan.

## Checklist percakapan natural

- Apakah Agent menjawab pertanyaan sebenarnya dari pengguna lebih dulu?

- Apakah ia menyesuaikan panjangnya dengan kompleksitas tugas?

- Apakah ia mengajukan pertanyaan klarifikasi yang berguna ketika diperlukan?

- Apakah ia mengingat preferensi yang sudah dikonfirmasi alih-alih menerka psikologi pengguna?

- Apakah ia tetap jelas bahwa dirinya AI alih-alih mengisyaratkan identitas nyata atau pengalaman luring?

- Apakah ia menjelaskan dampaknya lalu menunggu konfirmasi sebelum tindakan eksternal?

- Apakah ia menghormati jam tenang, penolakan, dan permintaan untuk melupakan?

## FAQ

### Apakah menjadi lebih hidup berarti menyembunyikan bahwa Agent itu AI?

Tidak.

Bahasa yang natural, ritme yang stabil, dan konteks yang berkelanjutan dapat meningkatkan pengalaman, tetapi Agent seharusnya tidak mengaku sebagai manusia atau mengarang pengalaman di dunia nyata.

### Haruskah saya menyimpan setiap percakapan sebagai memori sosial?

Tidak.

Simpan hanya informasi yang sudah dikonfirmasi dan membantu kolaborasi mendatang, lalu tinjau memori serta profil pengguna secara berkala.

### Bisakah saya memakai norma grup di Telegram dan WhatsApp sekarang?

Dokumentasi saat ini untuk kedua kanal menyatakan chat grup tidak didukung, sehingga bagian norma grup adalah checklist rancangan dan pra-peluncuran.

Nonaktifkan Group Privacy, tambahkan Bot ke grup, lalu validasi kepribadian, ritme, FAQ, dan pengingat dengan menyebutnya melalui `@username_bot`.
Untuk WhatsApp atau kanal lain, pastikan terlebih dahulu cakupan dukungan grup kanal tersebut.

### Mengapa sebagian balasan Agent panjang dan sebagian lainnya singkat?

Panjang respons mencerminkan kompleksitas tugas, prompt saat ini, keluaran model, dan preferensi pengguna.

Atur sebuah preferensi di profil pengguna, atau nyatakan di permintaan saat ini bahwa Anda hanya menginginkan kesimpulannya atau penurunan yang lengkap.

## Langkah berikutnya

- [Menentukan Peran, Kepribadian, dan Suara IM Agent](./im-agent-persona-soul-md.md) — Stabilkan peran, suara, dan batasannya.

- [Pengelolaan Memori](../configuration/memory.md) — Kelola profil pengguna dan memori jangka panjang.

- [Mengubah IM Agent Menjadi Asisten Layanan, Komunitas, atau Pendamping](./im-agent-skill-scenarios.md) — Perluas percakapan natural dengan kemampuan yang konkret.

- [Cara Menggunakan Asisten Komunitas AI Grup Telegram](./telegram-group-community-assistant.md) — Selesaikan penyiapan pesan grup dan terapkan norma grup dalam praktik.
