# Membuat Ringkasan Harian dengan Hermes Agent

Bagian yang berguna dari sebuah ringkasan harian bukanlah panjangnya, melainkan bahwa ia memberi Anda konteks yang tepat sebelum Anda harus menanyakannya: apa yang berubah, apa yang butuh perhatian, dan apa yang bisa menunggu.

Hermes dapat mengubah peninjauan yang berulang menjadi rutinitas asisten AI harian. LightVela menyediakan Agent yang di-hosting di cloud, kanal untuk pengiriman, Skill opsional untuk informasi yang Anda butuhkan, dan otomasi untuk penjadwalannya. Anda yang menentukan apa yang dihitung sebagai "ringkasan berguna hari ini".

![Ringkasan harian yang dikirim oleh Hermes Agent](../images/use-case-daily-summaries.webp)

## Ringkasan

**Sebuah ringkasan harian mendapatkan nilainya bukan dari panjangnya, melainkan dari menyerahkan konteks yang tepat kepada Anda sebelum Anda bertanya, dan cara mencapainya adalah mengubah peninjauan manual menjadi otomasi tersimpan.** Anda memerlukan empat hal: Hermes Agent di cloud dengan model yang sudah dikonfigurasi, kanal terhubung untuk menerima hasilnya, Skill opsional untuk mengumpulkan informasi, dan sebuah otomasi (kolomnya adalah nama, jadwal, instruksi tugas, jendela waktu aktif, dan kanal notifikasi). Keberhasilan bergantung pada instruksi tugasnya: karena tidak ada yang hadir untuk memperjelas saat eksekusi, prompt tersebut harus membawa sendiri tujuannya, batas cakupannya (rentang waktu dan batas jumlah item), format keluarannya, dan apa yang harus dilakukan ketika tidak ada yang perlu dilaporkan. Uji prompt-nya secara manual di chat lebih dulu, lalu buat otomasinya, dan tinjau keluarannya setelah eksekusi nyata pertamanya.

## Untuk siapa ini

Kasus penggunaan ini ditujukan bagi orang yang rutin memindai pembaruan dari proyek, catatan, file, atau percakapan berulang dan menginginkan titik awal yang lebih singkat. Ia dapat cocok untuk briefing pagi pribadi, rekap proyek harian, log pembelajaran, atau daftar tindak lanjut yang terfokus.

Ringkasan pertama yang terbaik memiliki tujuan yang sempit. "Rangkum semuanya" biasanya terlalu luas; "soroti perubahan, keputusan, hambatan, dan tindakan berikutnya untuk proyek ini" jauh lebih mudah dinilai dan diperbaiki.

## Prasyarat

- Hermes Agent yang sedang berjalan dan kanal terhubung tempat Anda ingin menerima ringkasannya.

- Konfigurasi model yang berfungsi atau kredit uji coba. Lihat [Konfigurasi Model](../configuration/model.md) jika Hermes tidak dapat merespons.

- Sumber konteks yang jelas. Ini bisa berupa material yang Anda tempelkan ke sebuah percakapan, file yang Anda kelola di Cloud Storage, atau informasi yang dapat diakses oleh Skill yang relevan dan terpercaya.

- Jadwal otomasi opsional jika Anda ingin ringkasannya berjalan tanpa prompt manual.

## Langkah / konsep kunci

### 1. Tentukan satu keputusan yang seharusnya dibantu oleh ringkasan ini

Mulailah dengan menyebutkan momen yang didukung ringkasan tersebut. Misalnya: memutuskan apa yang dikerjakan lebih dulu, memeriksa apakah sebuah proyek terhambat, atau menyusul ketertinggalan setelah sehari tidak hadir.

Beri Hermes instruksi yang mendefinisikan sumber sekaligus bentuk keluarannya:

```text
Ketika saya membagikan pembaruan proyek, rangkum dalam empat bagian:
apa yang berubah, keputusan yang diambil, hambatan, dan tiga tindakan berikutnya.
Jaga di bawah 250 kata dan tandai apa pun yang bersifat mendesak.
```

Ini mengubah permintaan umum menjadi format yang dapat diulang sehingga Anda bisa membandingkannya dari hari ke hari.

### 2. Buat material sumbernya bersifat sengaja

Hermes hanya dapat merangkum informasi yang dapat ia terima atau akses melalui kemampuan yang Anda konfigurasikan. Untuk alur kerja manual, tempelkan atau teruskan pembaruan yang relevan ke dalam percakapan Anda. Untuk pekerjaan berbasis file, tata materialnya di [Cloud Storage](../configuration/files.md) lalu beri tahu Hermes dokumen atau folder mana yang penting untuk peninjauan saat ini.

Jika Anda memerlukan sumber data eksternal, pilih Skill yang sesuai dari sumber terpercaya dan pastikan perilakunya sebelum memakainya. [Konfigurasi Skill](../configuration/skill.md) menjelaskan cara Skill memperluas Hermes melampaui percakapan biasa.

![Sumber Cloud Storage untuk ringkasan harian](../images/use-case-daily-summary-storage.png)

### 3. Uji keluarannya dalam percakapan normal lebih dulu

Sebelum menjadwalkan apa pun, minta ringkasan tersebut kepada Hermes secara manual. Periksa apakah bagian-bagiannya berguna, apakah nadanya cukup ringkas, dan apakah ada detail penting yang terlewat.

Penyempurnaan yang berguna mencakup:

```text
Tempatkan tenggat waktu di awal.
```

```text
Jangan mengulang pekerjaan yang sudah selesai kecuali ia memengaruhi tindakan berikutnya.
```

```text
Akhiri dengan satu pertanyaan yang perlu saya jawab sebelum besok.
```

Halaman [Chat](../configuration/agent-chat.md) adalah tempat yang baik untuk mengiterasi instruksinya sebelum mengubahnya menjadi tugas berulang.

### 4. Jadwalkan versi yang sudah terbukti berhasil

Ketika prompt manual menghasilkan hasil yang Anda percayai, buat sebuah otomasi. Beri ia waktu yang spesifik dan instruksi yang eksplisit, lalu pilih kanal notifikasi terhubung jika Anda ingin hasilnya dikirim ke sana.

```text
Setiap hari kerja pukul 18.00, siapkan ringkasan proyek harian dari
pembaruan yang saya bagikan hari ini. Sertakan perubahan, hambatan, dan tiga
tindakan berikutnya yang paling penting. Kirim sebagai poin-poin yang ringkas.
```

Siapkan ini di [Otomasi](../configuration/automation.md). Tinjau beberapa eksekusi pertama lalu sesuaikan kalimatnya jika ringkasannya terlalu luas, terlalu panjang, atau kehilangan konteks yang tepat.

![Otomasi ringkasan harian yang terjadwal](../images/use-case-daily-summary-automation.png)

## FAQ

### Bisakah Hermes merangkum informasi apa pun secara otomatis?

Hanya informasi yang dapat diterima Hermes dalam percakapan, diakses melalui file dan Skill yang sudah Anda konfigurasikan, atau diperoleh melalui alur kerja yang Anda siapkan. Jaga sumbernya tetap eksplisit dan pakai Skill terpercaya untuk akses eksternal apa pun.

### Mengapa ringkasan saya terlalu generik?

Instruksinya kemungkinan terlalu luas. Sebutkan audiens, sumber, rentang waktu, dan bagian keluarannya. Meminta keputusan, hambatan, dan tindakan berikutnya biasanya menghasilkan hasil yang lebih dapat ditindaklanjuti dibandingkan meminta rekap umum.

### Haruskah saya langsung menjadwalkan ringkasannya?

Tidak. Uji prompt-nya secara manual lebih dulu. Begitu Anda dapat mengenali hasil yang baik, menjadwalkannya menghemat waktu tanpa mengunci format yang tidak membantu.

### Bagaimana jika ringkasannya tidak datang?

Periksa status otomasi dan kanal notifikasinya, lalu pastikan Hermes masih dapat membalas dalam percakapan normal. Bila perlu, tinjau [Diagnostik](../configuration/diagnostics.md) sebelum membuat tugas lain.

## Langkah berikutnya

- [Cloud Storage](../configuration/files.md) — tata file yang mendukung peninjauan yang dapat diulang.

- [Konfigurasi Skill](../configuration/skill.md) — tambahkan kemampuan terpercaya ketika ringkasan Anda membutuhkan sumber informasi tertentu.

- [Otomasi](../configuration/automation.md) — kirimkan ringkasan yang sudah Anda uji sesuai jadwal.
