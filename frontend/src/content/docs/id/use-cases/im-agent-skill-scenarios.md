# Mengubah IM Agent Menjadi Asisten Layanan, Komunitas, atau Pendamping

Skill memperluas apa yang dapat dilakukan Hermes Agent, sementara SOUL.md mendefinisikan peran, suara, dan batas perilakunya yang stabil.

Bersama-sama, keduanya dapat membuat IM Agent yang sama lebih sesuai untuk dukungan pelanggan, operasional komunitas, atau pendampingan pribadi jangka panjang.

![Mengubah IM Agent menjadi asisten layanan, komunitas, atau pendamping dengan Skill](../images/use-case-06-im-agent-skill-scenarios.png)

## Ringkasan

**Mengubah satu IM Agent menjadi agent dukungan, asisten komunitas, atau pendamping AI bermuara pada pembagian antara Skill dan persona: Skill memperluas apa yang dapat ia lakukan, sementara `SOUL.md` mendefinisikan siapa dia dan dalam batas apa ia bertindak.** Keduanya diperlukan — Skill tanpa persona menghasilkan jawaban yang tidak konsisten, dan persona tanpa Skill kekurangan metode yang dapat dipakai ulang. Di LightVela, Skill berasal dari marketplace publik Skills.sh dan ClawHub; saat ini Anda memasang atau menghapusnya dengan memberi tahu Hermes dalam percakapan (instalasi lewat panel konsol akan segera tersedia), lalu memastikan ketersediaannya di chat. Ketiga skenario tersebut berbeda terutama pada rancangan batasnya: dukungan membutuhkan kondisi eskalasi yang eksplisit, asisten komunitas perlu tahu kapan harus diam, dan pemakaian sebagai pendamping membutuhkan topik terlarang yang jelas. Selesaikan checklist keamanan sebelum ditayangkan.

## Untuk siapa ini

Panduan ini ditujukan bagi orang yang sudah menghubungkan Telegram, WhatsApp, atau kanal pesan lain dan ingin memakai Agent untuk alur kerja yang konkret.

Ia sangat berguna bagi pemimpin tim dukungan, pengelola komunitas, dan individu yang menginginkan pendamping AI yang dapat bekerja bersama mereka dalam jangka panjang.

## Prasyarat

- Hermes Agent LightVela yang sedang berjalan.
  Jika Anda belum membuatnya, mulai dari [Panduan Cepat](../02-quickstart.md).

- Kanal pesan yang sudah dapat menangani percakapan normal.
  Anda dapat mulai dari [Mengatur Kepribadian Hermes Agent di Telegram](./telegram-persona-agent.md) atau [Mengatur Kepribadian Hermes Agent di WhatsApp](./whatsapp-persona-agent.md).

- Definisi awal tentang alur kerja tujuan, tindakan yang diizinkan, dan situasi yang membutuhkan pengalihan ke manusia.

- Skill terpercaya yang dipilih dari [Skills.sh](https://skills.sh/) atau [ClawHub](https://clawhub.ai/).

## Pahami batas antara Skill dan kepribadian

Skill adalah paket kemampuan yang dapat dipanggil, seperti penjelajahan web, penataan konten, ringkasan harian, atau alur kerja khusus.

SOUL.md lebih cocok untuk menggambarkan siapa Agent tersebut, bagaimana ia berbicara, bagaimana ia mengambil keputusan, dan tindakan mana yang membutuhkan konfirmasi.

Profil pengguna dan memori jangka panjang adalah untuk identitas, preferensi, fakta yang sudah dikonfirmasi, dan konteks Anda yang sedang berjalan.

Jangan menaruh skrip pelanggan, aturan grup, dan izin berisiko tinggi ke dalam satu deskripsi kepribadian yang tak terbedakan.

## Langkah-langkah

### 1. Tentukan skenario utama Agent

Skenario yang berbeda membutuhkan kombinasi Skill dan batas keamanan yang berbeda.

| Skenario | Tujuan utama | Arah Skill | Batas yang harus ditentukan lebih dulu |
|---|---|---|---|
| Layanan pelanggan | Menjawab pertanyaan umum dan merutekan permintaan kompleks | Penelusuran pengetahuan, penataan tiket, pencarian pesanan | Eskalasikan ketidakpastian dan jangan pernah menjanjikan pengembalian dana atau mengubah pesanan tanpa otorisasi |
| Asisten komunitas | Menyambut anggota, menjawab FAQ, merangkum diskusi | Penelusuran konten, ringkasan, pengingat terjadwal | Hindari spam, lindungi informasi anggota, dan jangan mengambil keputusan moderasi bagi admin |
| Pendamping AI | Menawarkan pendampingan, pengingat, dan kolaborasi jangka panjang yang konsisten | Penataan memori, penjadwalan, penyusunan konten | Hormati penolakan dan privasi, hindari perilaku yang membangun ketergantungan, dan nyatakan ketidakpastian |

Mulai dengan satu skenario utama alih-alih memasang banyak Skill sekaligus.

### 2. Siapkan material referensi dan arahan kepribadian

Untuk layanan pelanggan, siapkan FAQ produk, jam layanan, jalur eskalasi, dan detail kontak manusia.

Untuk operasional komunitas, siapkan pesan sambutan, pertanyaan yang sering diajukan, aturan komunitas, dan format ringkasan.

Untuk pendamping AI, tuliskan nama yang disukai, suara, tingkat inisiatif, dan topik yang seharusnya tetap di luar cakupan.

Taruh material referensi yang perlu dirujuk Hermes di [Cloud Storage](../configuration/files.md), dan taruh aturan kepribadian yang stabil ke dalam SOUL.md melalui [Menentukan Peran, Kepribadian, dan Suara IM Agent](./im-agent-persona-soul-md.md).

### 3. Pilih lalu pasang sebuah Skill

LightVela saat ini mendukung meminta Hermes memasang Skill dari Skills.sh atau ClawHub melalui percakapan.

Kirim permintaan seperti ini di kanal terhubung:

    Tolong pasang sebuah Skill yang sesuai untuk menata FAQ layanan pelanggan dari Skills.sh atau ClawHub, dan jelaskan dulu izin apa yang ia butuhkan.

Jika Anda sudah tahu nama Skill-nya, sebutkan secara eksplisit:

    Tolong pasang [nama skill]. Beri tahu saya dulu apa yang akan ia baca, layanan eksternal mana yang akan ia panggil, dan apakah ia dapat mengirim pesan proaktif.

Pintu masuk instalasi Skill visual di konsol masih bergantung pada status halaman saat ini, jadi lihat [Konfigurasi Skill](../configuration/skill.md) untuk alur instalasi yang didukung.

Skill berisiko tinggi dapat meminta konfirmasi kedua sebelum instalasi.

Sebelum mengonfirmasi, tinjau sumber Skill, izinnya, pemanggilan API eksternalnya, dan perilaku proaktifnya.

### 4. Validasi Skill untuk skenarionya

Uji Skill baru dalam percakapan satu lawan satu sebelum memaparkannya ke audiens yang besar.

Untuk layanan pelanggan, mulai dengan:

    Jawab pertanyaan ini memakai FAQ yang sudah disiapkan. Jika materialnya tidak memuat jawaban, katakan dengan jelas dan sarankan pengalihan ke manusia.

Untuk asisten komunitas, mulai dengan:

    Rangkum diskusi ini dalam maksimal lima poin dan daftarkan pertanyaan yang masih belum ada kesimpulannya.

Untuk pendamping AI, mulai dengan:

    Pakai suara yang sudah saya konfigurasikan untuk memberi saya check-in singkat hari ini, dan jelaskan detail mana yang akan dipertahankan sebagai memori jangka panjang.

Periksa apakah Agent memanggil Skill yang diharapkan, memakai material referensi yang tepat, dan berhenti untuk menjelaskan keterbatasan ketika ia tidak yakin.

### 5. Pakai otomasi untuk pekerjaan yang berulang

Pesan sambutan, FAQ, ringkasan, dan pengingat dapat memakai pemicu yang berbeda.

Gunakan [Otomasi](../configuration/automation.md) untuk pekerjaan yang seharusnya berjalan pada waktu tetap, seperti mengirim ringkasan komunitas harian atau mengingatkan tim dukungan tentang kasus yang belum selesai.

Pastikan metode notifikasi dan kanal tujuan untuk setiap otomasi alih-alih mengasumsikan setiap kanal dapat menerima jenis pesan proaktif yang sama.

## Rekomendasi per skenario

### Asisten layanan pelanggan

Biarkan Skill menelusuri informasi, menata konteks, dan menyusun draf balasan, sementara SOUL.md menjaga Agent tetap profesional, jelas, dan terukur.

Untuk pengembalian dana, perubahan harga, pemeriksaan identitas, penghapusan data, dan tindakan berisiko tinggi lainnya, wajibkan Agent menjelaskan dampaknya lalu menunggu konfirmasi manusia.

Ketika material referensinya tidak lengkap, pengguna sedang mengeskalasi, atau permintaannya di luar cakupan yang diotorisasi, alihkan alih-alih menerka.

### Asisten komunitas

Biarkan Skill menelusuri FAQ, menyarikan poin diskusi, dan menyusun draf pengingat, sementara arahan kepribadian menjaga Agent tetap sejalan dengan nada komunitas dan aturan admin.

Akses grup, pemicu @mention, izin, dan pengiriman pesan bergantung pada kanalnya, jadi baca dokumentasi kanal yang relevan sebelum mengonfigurasi alur kerjanya.

Jika kanal tujuan saat ini tidak mendukung chat grup, validasi Skill dan alur kerja kontennya dalam percakapan satu lawan satu alih-alih memperlakukan artikel ini sebagai penyiapan chat grup yang langsung tayang.

### Pendamping AI

Pakai SOUL.md untuk gaya pendampingan yang stabil, dan pakai memori serta profil pengguna untuk preferensi yang sudah dikonfirmasi dan konteks jangka panjang.

Pengingat proaktif sebaiknya memiliki frekuensi, cara menjeda, dan jam tenang yang jelas, sehingga inisiatif tidak menjadi pengiriman pesan tanpa batas.

Jika Anda ingin Hermes mempertahankan sebuah preferensi, minta ia mengingat preferensi itu dalam percakapan; jika Anda tidak lagi ingin itu dipertahankan, minta ia melupakannya.

## Checklist keamanan

- Pastikan sumber Skill, izin, dan ketergantungan layanan eksternalnya sebelum instalasi.

- Pakai percakapan satu lawan satu dan material berisiko rendah selama pengujian.

- Wajibkan konfirmasi sebelum mengirim pesan eksternal, mengubah pesanan, menghapus file, atau melakukan tindakan tak dapat dibalik lainnya.

- Siapkan jalur pengalihan ke manusia untuk alur kerja layanan pelanggan dan komunitas.

- Tinjau memori, profil pengguna, dan Cloud Storage secara berkala, lalu hapus informasi yang tidak lagi diperlukan.

## FAQ

### Apakah memasang Skill otomatis mengubah kepribadian Agent?

Tidak.

Skill terutama memperluas apa yang dapat dilakukan Agent, sementara kepribadiannya didefinisikan oleh SOUL.md dan konfigurasi terkait.

Instruksi dan keluaran Skill dapat memengaruhi gaya satu tugas, tetapi keduanya seharusnya tidak menggantikan definisi peran dan batas Anda yang stabil.

### Bisakah Skill layanan pelanggan memproses pengembalian dana secara langsung?

Pertimbangkan tindakan semacam itu hanya ketika izin sistem, aturan bisnis, dan persyaratan konfirmasi manusia semuanya eksplisit.

Secara default, biarkan Agent mencari kebijakannya, menyusun rekomendasi, lalu menunggu konfirmasi sebelum eksekusi.

### Bisakah asisten komunitas langsung bergabung ke grup Telegram?

Dokumentasi Telegram LightVela saat ini masih memperlakukan percakapan satu lawan satu sebagai cakupan yang didukung, jadi baca [Asisten Komunitas AI untuk Grup Telegram](./telegram-group-community-assistant.md) sebelum merencanakan alur kerja grup.

### Haruskah saya menaruh semua material referensi ke dalam memori?

Tidak.

Memori jangka panjang adalah untuk sejumlah kecil konteks yang stabil, sementara FAQ produk, aturan komunitas, dan kumpulan referensi yang besar lebih baik ditaruh di [Cloud Storage](../configuration/files.md) atau dibaca sesuai kebutuhan oleh sebuah Skill.

## Langkah berikutnya

- [Konfigurasi Skill](../configuration/skill.md) — Tinjau instalasi, validasi, dan panduan keamanan Skill.

- [Menentukan Peran, Kepribadian, dan Suara IM Agent](./im-agent-persona-soul-md.md) — Rancang persona yang stabil dan batas perilakunya.

- [Satu Agent di Telegram dan WhatsApp dengan Persona dan Memori yang Sama](./multi-channel-personality-memory.md) — Perluas kemampuan Agent yang sama ke beberapa pintu masuk.

- [Asisten Komunitas AI untuk Grup Telegram](./telegram-group-community-assistant.md) — Tinjau batas dukungan chat grup saat ini dan checklist persiapannya.
