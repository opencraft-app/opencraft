# Mengatur Kepribadian Hermes Agent di WhatsApp

WhatsApp adalah salah satu pintu masuk pesan tempat Hermes Agent dapat tetap berhubungan dengan Anda.
Ia mengantarkan pesannya, sementara peran, suara, batas perilaku, dan konteks tahan lama milik Agent berasal dari konfigurasi LightVela-nya.

Panduan ini menunjukkan cara menghubungkan Hermes Agent ke WhatsApp dan memilih kepribadian yang stabil untuk percakapan pribadi, pengingat, atau pekerjaan satu lawan satu yang berhadapan dengan pelanggan.

![Hermes Agent dengan kepribadian yang khas di WhatsApp](../images/use-case-04-whatsapp-persona-agent.png)

## Ringkasan

**WhatsApp membawa pesannya; peran, nada, batas, dan konteks jangka panjang Agent berasal dari konfigurasinya di LightVela — mengubah pintu masuk tidak mengubah siapa dia.** Hubungkan kanal WhatsApp lebih dulu (beri otorisasi sesuai panduan kanal lalu pastikan konsol menampilkannya sebagai terhubung), kemudian pakai bagian Persona pada halaman pengaturan Agent untuk memilih dan menyuntikkan persona yang sesuai untuk pesan pribadi, pengingat, atau percakapan pelanggan. Jika Agent ini berhadapan dengan pelanggan atau sebuah tim, sebutkan audiensnya secara eksplisit di dalam persona lalu tambahkan nada merek, cakupan yang boleh ia tangani, dan kondisi untuk mengalihkan ke manusia. Setelah terhubung, kirim pesan uji lalu pastikan balasannya mendarat di percakapan yang diharapkan. Jika tidak ada yang datang, periksa apakah modelnya sudah dikonfigurasi, apakah kredit uji coba sudah habis, dan apakah kanalnya tampil sebagai terhubung.

## Untuk siapa ini

Panduan ini ditujukan bagi orang yang ingin Hermes Agent dengan suara yang konsisten dan konteks kerja yang berguna di WhatsApp.
Ia bekerja sangat baik untuk bantuan pribadi, pengingat sehari-hari, penataan informasi, dan skenario satu lawan satu lain yang gaya percakapannya sebaiknya tetap dapat diprediksi.

WhatsApp saat ini terutama ditujukan untuk percakapan satu lawan satu.
Jika Anda belum menghubungkan WhatsApp, mulai dari [Kanal WhatsApp](../configuration/channel-whatsapp.md).

## Prasyarat

- Hermes Agent LightVela yang sedang berjalan.
  Jika Anda belum membuatnya, mulai dari [Panduan Cepat](../02-quickstart.md).

- Konfigurasi model yang berfungsi atau kredit uji coba yang tersedia.
  Jika Hermes belum dapat membalas, selesaikan [Konfigurasi Model](../configuration/model.md).

- Akun WhatsApp yang dapat menerima pesan verifikasi, dengan otorisasi yang sudah diselesaikan melalui [Kanal WhatsApp](../configuration/channel-whatsapp.md).

- Arahan kepribadian yang singkat.
  Tentukan siapa yang dilayani Agent, masalah apa yang ia bantu, bagaimana ia seharusnya terdengar, dan tindakan mana yang selalu membutuhkan konfirmasi Anda.

## Langkah / konsep kunci

### 1. Hubungkan kanal WhatsApp lebih dulu

Buka Hermes Agent tujuan di konsol LightVela, masuk ke "Channels", lalu pilih WhatsApp.
Ikuti [Kanal WhatsApp](../configuration/channel-whatsapp.md) melalui alur otorisasi ponsel, kode verifikasi, atau kode QR, lalu kirim pesan uji.

Pastikan WhatsApp muncul sebagai terhubung di konsol dan Hermes Agent membalas di WhatsApp.
Jika kanalnya belum terhubung, selesaikan masalah otorisasi, model, atau kredit sebelum menyetel kepribadiannya.

### 2. Tulis arahan peran untuk konteks WhatsApp

Percakapan WhatsApp umumnya lebih singkat dan lebih langsung, dan ia dapat mencampur permintaan pribadi serta pekerjaan dalam thread yang sama.
Selain menjelaskan siapa Agent tersebut, definisikan panjang balasannya, perilaku klarifikasinya, dan batasannya terkait tindakan berisiko tinggi.

Mulai dengan arahan peran seperti ini:

```text
Kamu adalah asisten WhatsApp harian saya.
Bantu saya menata to-do, tindak lanjut, dan pesan singkat, tetapi jangan melakukan tindakan eksternal tanpa konfirmasi saya.
Pakai nada yang ringkas, natural, dan ramah secara default. Pakai bagian-bagian singkat ketika penjelasan dibutuhkan alih-alih mengirim satu blok panjang.
Jika permintaan saya kehilangan waktu, orang, atau tujuan, ajukan satu pertanyaan klarifikasi yang paling penting lebih dulu.
```

Jika Agent WhatsApp tersebut melayani pelanggan atau sebuah tim, ganti "saya" dengan audiens yang dimaksud lalu tambahkan suara merek, cakupan yang didukung, dan kondisi untuk menyerahkan sebuah permintaan kepada manusia.

### 3. Pilih lalu suntikkan Soul dari Personality

Buka pengaturan Agent tujuan lalu pilih bagian "Personality".
Anda dapat mengambil Soul secara acak atau memakai tes kepribadian untuk menemukan yang lebih cocok.

Tinjau deskripsi peran, suara, dan perilaku pada kartunya, pilih, lalu klik "Inject soul".
LightVela menuliskan Soul terpilih ke `SOUL.md` milik Hermes Agent saat ini dan menyimpan backup sebelum menggantikan persona sebelumnya.

Hanya satu Soul yang aktif untuk sebuah Agent pada satu waktu.
Jika Anda menyuntikkan yang baru, balasan WhatsApp memakai kepribadian baru itu di percakapan baru, jadi bandingkan peran lama dan barunya sebelum mengonfirmasi.

### 4. Mulai percakapan baru di WhatsApp

Setelah Soul disuntikkan, kirim pesan ini di percakapan WhatsApp:

```text
/new
```

Ini membuat Hermes Agent membaca `SOUL.md` yang baru ketika percakapan baru dimulai.
Jika percakapan lama masih terdengar sama, pastikan `/new` sudah terkirim dengan berhasil sebelum menguji lebih jauh.

Pakai pemeriksaan diri singkat untuk memastikan hasilnya:

```text
Jelaskan siapa yang kamu layani, gaya balasan default kamu, dan apa yang kamu lakukan ketika sebuah permintaan akan mengirim pesan ke luar chat ini.
```

### 5. Kalibrasi ritme WhatsApp dengan pesan nyata

Di WhatsApp, kepribadian yang berguna bukan hanya soal terdengar seperti karakter tertentu.
Ia juga mencakup panjang pesan, pengelompokan, dan kapan mengajukan pertanyaan lanjutan.

Uji dengan tiga jenis pesan:

```text
Ubah konten ini menjadi tiga pesan yang bisa saya kirim ke rekan kerja.
```

```text
Ingatkan saya menindaklanjuti ini besok pukul 15.00, dan beri tahu saya dulu informasi apa yang akan kamu catat.
```

```text
Permintaan ini mungkin memicu tindakan eksternal. Daftarkan risikonya dan apa yang perlu saya konfirmasi lebih dulu.
```

Jika balasannya terlalu panjang, simpan preferensi seperti "jaga balasan default di bawah tiga bagian singkat".
Jika Agent membutuhkan konteks proyek yang stabil, pakai kemampuan [Pengelolaan Memori](../configuration/memory.md) untuk mempertahankan fakta yang seharusnya tetap berguna.

## Jaga kepribadian tetap terpisah dari alur kerja layanan pelanggan

Kepribadian mendefinisikan peran dan suara yang dipakai Agent.
Skill mendefinisikan apakah ia dapat melakukan tugas tertentu.
Otomasi mendefinisikan kapan ia mulai bekerja secara proaktif.
Memori dan profil pengguna mendefinisikan konteks jangka panjang mana yang seharusnya ia pertahankan.

Misalnya, kepribadian layanan pelanggan yang hangat tidak otomatis menyediakan kemampuan pencarian pesanan, penelusuran basis pengetahuan, atau pengembalian dana.
Kemampuan tersebut membutuhkan konfigurasi model, Skill, file referensi, dan batas tindakan yang eksplisit.

Untuk penjelasan yang lebih mendalam tentang batas antara kepribadian, preferensi pengguna, dan memori jangka panjang, baca [Dari Mana Kepribadian Hermes Agent Berasal](../hermes-agent/10-persona-user-memory.md).

## FAQ

### Apakah satu nomor WhatsApp sebaiknya dipetakan ke satu Hermes Agent?

Umumnya, satu nomor WhatsApp sebaiknya terikat pada satu Hermes Agent.
Jika Anda memerlukan beberapa peran yang berbeda, pakai nomor WhatsApp dan instans Hermes Agent yang terpisah alih-alih berulang kali menggantikan satu kepribadian dalam thread yang sama.

### Apakah menyuntikkan Soul baru menghapus riwayat WhatsApp atau memori?

Tidak.
Menyuntikkan Soul baru terutama menggantikan `SOUL.md` Agent saat ini, sementara `/new` memulai percakapan baru.
Memori jangka panjang dan profil pengguna tetap menjadi lapisan konteks yang terpisah, meskipun kepribadian baru dapat mengubah cara Hermes menafsirkan dan memakai konteks tersebut.

### Bisakah saya memakai penyiapan ini di grup WhatsApp?

Dokumentasi WhatsApp saat ini mendefinisikan percakapan satu lawan satu sebagai cakupan yang didukung, sehingga grup bukan bagian dari panduan ini.
Periksa [Kanal WhatsApp](../configuration/channel-whatsapp.md) untuk batasan kanal saat ini.

### Bisakah Agent WhatsApp mengirim pesan secara proaktif?

Pesan proaktif juga tunduk pada aturan templat pesan dan jendela percakapan WhatsApp.
Jika Anda menginginkan pengingat terjadwal, baca [Otomasi](../configuration/automation.md) lalu pastikan metode pengirimannya sesuai dengan batas kanal WhatsApp yang sebenarnya.

## Langkah berikutnya

- [Mengatur Kepribadian Hermes Agent di Telegram](./telegram-persona-agent.md) — Bandingkan penyiapannya dengan kanal pesan internasional lainnya.

- [Menentukan Peran, Kepribadian, dan Suara IM Agent](./im-agent-persona-soul-md.md) — Jaga kepribadian, profil pengguna, memori, dan Skill tetap terpisah.

- [Kanal WhatsApp](../configuration/channel-whatsapp.md) — Ikuti alur otorisasi dan penelusuran masalah WhatsApp secara lengkap.

- [Otomasi](../configuration/automation.md) — Jadwalkan pengingat atau tinjauan yang sudah diuji dalam percakapan.
