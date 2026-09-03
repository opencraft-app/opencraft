# Menentukan Peran, Kepribadian, dan Suara IM Agent

Sebuah IM Agent tidak terasa seperti orang yang sama hanya karena ia terhubung ke Telegram atau WhatsApp.
Aturan peran yang stabil, suara, batas perilaku, dan konteks tahan lama semuanya membentuk bagaimana ia berperilaku lintas skenario pesan.

Di runtime Hermes Agent, `SOUL.md` adalah file inti yang membawa persona Agent.
LightVela menghasilkan dan menyuntikkan Soul melalui fitur Personality, sehingga Anda tidak perlu mengoperasikan sistem file cloud secara langsung.

![Menentukan peran, kepribadian, dan suara IM Agent dengan SOUL.md](../images/use-case-05-im-agent-persona-soul-md.png)

## Ringkasan

**Apakah sebuah IM Agent terasa seperti "orang yang sama" bergantung pada personanya, bukan pada kanal mana ia berjalan. `SOUL.md` membawa peran, nada, prioritas, perilaku, dan batasnya, dan ia adalah file persona inti di runtime Hermes.** Di LightVela Anda tidak pernah menyentuh sistem file cloud secara langsung — bagian Persona pada halaman pengaturan Agent menawarkan dua pintu masuk, mengambil persona secara acak atau menjawab kuis singkat. Tinjau peran, nada, dan catatan perilaku pada kartu persona, lalu pilih Inject Persona untuk menerapkannya. Tulis prinsip yang dapat dinilai alih-alih fakta spesifik: "mulai dengan kesimpulan", "nyatakan ketidakpastian secara eksplisit", dan "konfirmasi sebelum mengirim pesan eksternal" adalah aturan persona, sementara nama proyek dan port termasuk di memori jangka panjang. Setelah menyuntikkan, verifikasi nada dan batasnya dengan satu percakapan nyata.

## Untuk siapa ini

Panduan ini ditujukan bagi orang yang ingin memberi IM Agent sebuah peran yang stabil, seperti asisten pribadi, mitra riset, pendamping belajar, atau asisten komunikasi pelanggan sehari-hari.
Jika Anda belum memilih kanal pesan, mulai dari [Menghubungkan AI Agent ke Platform Chat](./chinese-messaging-channels.md).

## Pahami tiga lapisan konteks lebih dulu

### `SOUL.md`: siapa Agent tersebut dan bagaimana ia bekerja

`SOUL.md` paling cocok untuk aturan persona yang stabil, termasuk peran, suara, prioritas, perilaku, dan batasan.
Aturan seperti "berikan kesimpulan lebih dulu", "nyatakan ketidakpastian dengan jelas", dan "tanya sebelum mengirim pesan eksternal" tempatnya di sini.

### Profil pengguna: siapa Anda dan bagaimana Anda ingin diperlakukan

Profil pengguna paling cocok untuk bahasa, zona waktu, identitas, latar belakang, dan preferensi komunikasi Anda.
Misalnya, "saya di Singapura", "pakai bahasa Inggris secara default", dan "tampilkan tenggat waktu lebih dulu" umumnya adalah preferensi pengguna, bukan aturan identitas Agent.

### Memori jangka panjang: apa yang sudah Anda bangun bersama

Memori jangka panjang paling cocok untuk status proyek, keputusan, dan konteks yang dapat dipakai ulang dari pekerjaan bersama Anda.
Ia tumbuh melalui percakapan yang berlanjut dan dapat ditinjau atau dikelola kapasitasnya di [Pengelolaan Memori](../configuration/memory.md).

Mencampur ketiganya membuat identitas Agent, preferensi pengguna, dan konteks proyek sementara saling mengganggu.
Menjaganya tetap terpisah membuat kepribadiannya tetap stabil sementara percakapannya menyesuaikan diri dengan pengguna dan pekerjaan yang sebenarnya.

## Prasyarat

- Hermes Agent LightVela yang sedang berjalan.
  Jika Anda belum membuatnya, mulai dari [Panduan Cepat](../02-quickstart.md).

- Model yang sudah dikonfigurasi dan setidaknya satu kanal percakapan yang tersedia.

- Arahan persona yang singkat.
  Tentukan siapa yang dilayani Agent, apa yang terutama ia lakukan, bagaimana ia seharusnya terdengar, dan tindakan mana yang selalu membutuhkan konfirmasi.

## Langkah / konsep kunci

### 1. Tentukan tujuan persona dengan lima pertanyaan

Sebelum memilih Soul, jawab lima pertanyaan berikut:

- Siapa Agent tersebut?

- Siapa yang terutama ia bantu?

- Bagaimana ia seharusnya terdengar secara normal?

- Apa yang seharusnya ia lakukan ketika informasinya tidak pasti?

- Tindakan eksternal mana yang membutuhkan konfirmasi lebih dulu?

Ubah jawabannya menjadi arahan perencanaan seperti ini:

```text
Peran: Asisten riset untuk proyek pribadi
Audiens: Pengguna yang ingin kesimpulan andal dengan cepat
Suara: Ringkas, profesional, ramah, kesimpulan dulu, bukti kemudian
Perilaku: Uraikan pertanyaan, tandai ketidakpastian, dan ajukan hanya satu pertanyaan kunci bila perlu
Batasan: Jangan pernah mengirim pesan eksternal, mengubah file, atau melakukan tindakan berisiko tinggi tanpa konfirmasi
```

Templat ini membantu Anda memilih dan mengalibrasi sebuah persona.
Ia tidak berarti LightVela mengekspos editor serbaguna untuk file cloud sembarangan.

### 2. Buka Personality di pengaturan Agent

Di konsol LightVela, buka pengaturan Hermes Agent tujuan lalu pilih "Personality".
Situs internasional menyediakan pintu masuk "Draw random soul" sekaligus "Soul personality test".

Pakai pengambilan acak untuk menjelajahi gaya peran yang berbeda.
Pakai tes kepribadian ketika Anda menginginkan Soul yang lebih cocok dengan preferensi komunikasi dan perilaku Anda.

Tinjau deskripsi peran, suara, dan perilaku pada setiap kartu, lalu pilih yang paling cocok dengan arahan perencanaan Anda.

### 3. Suntikkan Soul terpilih ke `SOUL.md`

Pilih Soul tersebut lalu klik "Inject soul".
LightVela menuliskan Soul terpilih ke `SOUL.md` milik Hermes Agent saat ini dan menyimpan backup sebelum menggantikan file yang sudah ada.

Hanya satu kepribadian yang aktif untuk sebuah Agent pada satu waktu.
Jika Anda ingin berganti peran, tinjau batasan pada kartu barunya sebelum menyuntikkannya lagi.

Setelah penyuntikan berhasil, kembali ke kanal IM Anda lalu kirim:

```text
/new
```

Hermes Agent membaca `SOUL.md` yang baru ketika sebuah percakapan baru dimulai.
Ini penting karena percakapan yang sudah ada mungkin masih memegang snapshot persona sebelumnya.

### 4. Tambahkan preferensi pengguna dan fakta tahan lama melalui percakapan

Jangan menaruh setiap informasi ke dalam `SOUL.md`.
Jaga persona yang stabil tetap singkat, dan biarkan profil pengguna serta memori jangka panjang menangani preferensi pribadi dan fakta proyek.

Misalnya, beri tahu Hermes:

```text
Ingat bahwa saya memakai waktu Singapura dan ingin rencana hari kerja yang ringkas pukul 08.00, dengan tenggat waktu didaftarkan lebih dulu.
```

Atau:

```text
Lupakan preferensi pengingat Jumat malam yang saya sebutkan sebelumnya. Jangan jadwalkan lagi.
```

Hermes menangani permintaan mengingat dan melupakan melalui percakapan.
Gunakan [Pengelolaan Memori](../configuration/memory.md) untuk meninjau konten dan kapasitas Memory serta User Profile.

### 5. Pasang Skill hanya untuk pekerjaan nyata

Kepribadian mendefinisikan bagaimana Agent bekerja, tetapi ia tidak otomatis menambahkan kemampuan eksternal.
Jika Anda ingin ia menjelajahi web, menata material, mencari informasi, atau melakukan tugas konkret lain, pasang Skill yang sesuai dan periksa sumber serta izinnya lebih dulu.

Mulai dari [Konfigurasi Skill](../configuration/skill.md).
Skill dan kepribadian sebaiknya saling memperkuat, bukan memakai Skill berisiko tinggi untuk menutupi batas persona yang tidak jelas.

## Verifikasi bahwa kepribadiannya aktif

Setelah memulai percakapan baru, lakukan lebih dari meminta perkenalan diri.
Uji setidaknya empat kasus berikut:

```text
Apa peranmu saat ini, pekerjaan utamamu, dan suara default-mu?
```

```text
Bagaimana kamu merespons ketika kamu tidak yakin tentang sebuah fakta?
```

```text
Jika saya memintamu mengirim pesan ke layanan eksternal, apa yang kamu lakukan lebih dulu?
```

```text
Ubah material ini menjadi kesimpulan, bukti, dan pertanyaan yang masih perlu dikonfirmasi.
```

Periksa apakah Agent mempertahankan peran, suara, dan batas keamanannya, dan apakah ia masih dapat memakai konteks yang relevan dari profil pengguna serta memori jangka panjang.
Jika perilakunya tidak stabil, sederhanakan aturan personanya sebelum memilih atau menyuntikkan Soul lain.

## FAQ

### Apakah saya perlu menyunting `SOUL.md` di cloud secara manual?

Umumnya tidak.
Pintu masuk Personality di LightVela menghasilkan dan menyuntikkan Soul tersebut, sehingga pemakaian normal tidak menuntut operasi sistem file cloud secara langsung.

### Apakah mengubah `SOUL.md` memengaruhi setiap kanal pesan?

Ia memengaruhi perilaku tingkat Agent untuk Hermes Agent yang sama.
Jika Agent tersebut terhubung ke Telegram dan WhatsApp, kedua kanal memakai kepribadian itu di percakapan baru, sementara tiap kanal tetap memiliki otorisasi, format pesan, dan batas kemampuannya sendiri.

### Bisakah `SOUL.md` menggantikan memori?

Tidak.
`SOUL.md` sebaiknya menggambarkan identitas dan aturan perilaku yang stabil, sementara memori sebaiknya mempertahankan fakta yang berubah, konteks proyek, dan pengalaman bersama.

### Bisakah satu Agent memiliki beberapa kepribadian aktif sekaligus?

Saat ini, satu Agent memiliki satu kepribadian aktif pada satu waktu.
Jika Anda memerlukan peran yang benar-benar berbeda, buat Agent terpisah alih-alih berulang kali menimpa Soul pada satu Agent.

### Kapan saya sebaiknya mengirim `/new`?

Kirim `/new` di kanal IM setelah menyuntikkan kepribadian baru.
Ini memperjelas bahwa Soul yang baru seharusnya dimuat selama inisialisasi percakapan.

## Langkah berikutnya

- [Mengatur Kepribadian Hermes Agent di Telegram](./telegram-persona-agent.md) — Terapkan kepribadian pada percakapan pribadi dan pesan grup Telegram setelah penyiapan Group Privacy.

- [Mengatur Kepribadian Hermes Agent di WhatsApp](./whatsapp-persona-agent.md) — Terapkan kepribadiannya pada percakapan satu lawan satu di WhatsApp.

- [Dari Mana Kepribadian Hermes Agent Berasal](../hermes-agent/10-persona-user-memory.md) — Pahami Persona, preferensi pengguna, dan memori jangka panjang secara lebih mendalam.

- [Cloud Storage](../configuration/files.md) — Kelola material referensi dan file kerja yang dapat dipakai Agent.
