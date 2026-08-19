# Membangun Asisten AI Pribadi dengan LightVela

Sebagian besar percakapan AI berguna untuk satu jawaban, lalu menghilang ke tab berikutnya. Sebuah asisten pribadi menjadi berguna ketika ia dapat tetap tersedia di tempat Anda sudah biasa berkirim pesan, mengingat cara Anda bekerja, dan mengambil alih beberapa tugas yang berulang.

LightVela adalah platform AI agent pribadi berbasis cloud: sebuah Hermes Agent dapat terus bekerja dengan model, kanal, memori, Skill, dan otomasi pilihan Anda. Panduan ini menunjukkan cara mengubah kumpulan komponen tersebut menjadi asisten yang sudah terasa berguna sejak pekan pertama, tanpa berusaha mengotomasikan segalanya sekaligus.

![Asisten AI pribadi dengan LightVela di berbagai kanal](../images/use-case-personal-ai-assistant.webp)

## Ringkasan

**Urutan yang tepat untuk membangun asisten AI pribadi bukan mengotomasikan semuanya sekaligus. Mulailah dengan membuat Hermes Agent di cloud dapat dijangkau di aplikasi chat yang sudah Anda pakai, lalu tambahkan memori, Skill, dan otomasi secara berlapis.** Lima komponen masing-masing menyelesaikan satu masalah: model menentukan kualitas reasoning, kanal menentukan di mana Anda menjangkaunya, memori membuatnya dapat mempertahankan cara Anda bekerja, Skill memberinya metode yang dapat dipakai ulang, dan otomasi membuatnya menyelesaikan pekerjaan yang disepakati saat Anda tidak hadir. Untuk pekan pertama, lakukan hanya tiga hal: konfigurasikan satu model, hubungkan satu kanal, dan pastikan memorinya benar-benar bertahan lintas sesi. Begitu jalur itu andal, tambahkan Skill dan otomasi — dengan cara ini, ketika ada yang bermasalah, Anda dapat mengetahui lapisan mana penyebabnya.

## Untuk siapa ini

Penyiapan ini bekerja baik jika Anda menginginkan satu asisten untuk perencanaan sehari-hari, tindak lanjut riset, pengingat, dan pertanyaan yang lebih baik dijawab dengan mengetahui preferensi Anda. Anda tidak memerlukan alur kerja yang kompleks. Mulailah dengan satu Hermes Agent dan satu kanal yang sudah rutin Anda periksa.

Ia sangat berguna ketika Anda mendapati diri Anda mengulang konteks seperti zona waktu Anda, format yang Anda sukai untuk ringkasan, proyek yang sedang Anda kerjakan, atau jenis bantuan yang Anda inginkan setiap pagi.

## Prasyarat

- Akun LightVela dan Hermes Agent yang sedang berjalan. Jika Anda belum membuatnya, mulai dari [Panduan Cepat](https://lightvela.ai/docs/quickstart).

- Satu kanal percakapan. Telegram, WhatsApp, Discord, Slack, dan WeChat adalah titik awal yang umum; pilih yang paling mungkin Anda buka setiap hari.

- Konfigurasi model yang berfungsi atau kredit uji coba yang tersedia. Lihat [Konfigurasi Model](https://lightvela.ai/docs/configuration/model) jika Hermes belum dapat membalas.

- Gambaran singkat tentang apa yang pertama-tama ingin Anda bantu. Satu rutinitas saja, seperti merencanakan hari Anda atau mengumpulkan tindak lanjut, sudah cukup.

## Langkah / konsep kunci

### 1. Beri Hermes tempat dalam rutinitas harian Anda

Hubungkan satu kanal pesan, lalu kirim beberapa pesan pertama dari tempat yang biasa Anda pakai untuk menata hari Anda. Kanal bukan sekadar metode pengiriman — ia adalah kebiasaan yang membuat asisten tersebut mudah untuk kembali dipakai. Ikuti halaman penyiapan untuk [Telegram](https://lightvela.ai/docs/configuration/channel-telegram), [WhatsApp](https://lightvela.ai/docs/configuration/channel-whatsapp), [Discord](https://lightvela.ai/docs/configuration/channel-discord), [Slack](https://lightvela.ai/docs/configuration/channel-slack), atau [WeChat](https://lightvela.ai/docs/configuration/channel-wechat).

![Halaman Channel di konsol LightVela](../images/personal-ai-assistant-channel.webp)

Mulailah dengan perkenalan yang jelas alih-alih permintaan yang luas. Misalnya:

```text
Saya ingin kamu menjadi asisten perencanaan pribadi saya. Saya memakai waktu Singapura.
Jaga rencana harian tetap singkat, sebut tenggat waktu lebih dulu, dan ajukan satu pertanyaan lanjutan ketika ada yang tidak jelas.
```

### 2. Biarkan memori membawa konteks yang berulang

Hermes membangun konteks yang berguna seiring waktu, sehingga Anda tidak perlu menyatakan ulang setiap preferensi di setiap percakapan. Beri tahu ia fakta dan preferensi kerja yang seharusnya tetap berguna: zona waktu Anda, bagaimana Anda ingin briefing disusun, nama proyek yang penting, atau hari-hari ketika Anda lebih suka merencanakan lebih awal.

Anda juga dapat menyatakan permintaannya secara langsung:

```text
Ingat bahwa saya lebih suka briefing hari kerja yang ringkas pukul 08.00,
berisi rapat, tenggat waktu, dan tiga tindakan berikutnya yang paling penting.
```

Gunakan halaman [Pengelolaan Memori](https://lightvela.ai/docs/configuration/memory) untuk meninjau memori dan informasi profil pengguna yang sudah dikumpulkan Hermes. Memori seharusnya mengurangi pengulangan, bukan menjadi tempat penampungan setiap detail yang lewat.

### 3. Tambahkan Skill hanya ketika sebuah tugas nyata membutuhkannya

Hermes dapat mengobrol tanpa Skill tambahan. Tambahkan satu ketika Anda dapat menyebutkan pekerjaan praktis yang seharusnya ia bantu, seperti mencari informasi, menata daftar to-do, atau menyiapkan laporan berulang. Ini menjaga asisten tersebut tetap mudah dipahami dan lebih mudah dipercaya.

![Halaman Skills di konsol LightVela](../images/personal-ai-assistant-skills.webp)

Telusuri opsi yang sesuai di ClawHub, lalu pakai [Konfigurasi Skill](https://lightvela.ai/docs/configuration/skill) untuk memasangnya. Sebelum memasang apa pun, baca deskripsinya dan pilih sumber yang Anda percayai.

### 4. Ubah percakapan yang berguna menjadi pemeriksaan berkala

Begitu sebuah prompt terbukti berguna secara konsisten, putuskan apakah ia sebaiknya berjalan sesuai jadwal. Otomasi sederhana dapat meminta rencana pagi, tinjauan akhir hari, atau reset pekanan kepada Hermes tanpa Anda perlu ingat untuk memulai percakapannya.

Misalnya:

```text
Setiap hari kerja pukul 08.00, siapkan rencana ringkas untuk hari ini.
Mulai dengan tenggat waktu dan rapat, lalu sarankan tiga tindakan berikutnya yang terfokus.
```

Atur jadwal dan kanal notifikasinya di [Otomasi](https://lightvela.ai/docs/configuration/automation). Jaga otomasi pertama tetap kecil; Anda dapat memperhalus instruksinya setelah melihat beberapa hasil nyata.

![Halaman Automations di konsol LightVela](../images/personal-ai-assistant-automations.webp)

## FAQ

### Apakah saya perlu mengonfigurasi setiap fitur sebelum Hermes berguna?

Tidak. Satu kanal dan satu model yang berfungsi sudah cukup untuk memulai. Tambahkan memori, Skill, dan otomasi secara bertahap sambil Anda menemukan tugas berulang mana yang layak dipertahankan.

### Apakah Hermes akan mengingat setiap pesan yang saya kirim?

Tidak. Memori dimaksudkan untuk informasi yang tetap berguna lintas percakapan, seperti preferensi, pekerjaan berulang, dan konteks yang stabil. Anda dapat meminta Hermes mengingat atau melupakan informasi bila perlu, lalu meninjaunya di Pengelolaan Memori.

### Bisakah saya memakai asisten yang sama dari lebih dari satu kanal?

Bisa. Beberapa kanal terhubung dapat mengarah ke Hermes Agent yang sama, sehingga asisten tersebut dapat mempertahankan konteks yang sama saat Anda berpindah antar platform pesan yang didukung.

### Apa yang sebaiknya saya otomasikan lebih dulu?

Pilih tugas yang sudah Anda ulangi pada waktu yang dapat diprediksi. Perencanaan pagi, tinjauan harian singkat, atau pemeriksaan prioritas pekanan adalah kandidat pertama yang baik karena Anda dapat cepat menilai apakah keluarannya membantu.

## Langkah berikutnya

- [Chat](https://lightvela.ai/docs/configuration/agent-chat) — bekerja dengan Hermes langsung di konsol.

- [Pengelolaan Memori](https://lightvela.ai/docs/configuration/memory) — tinjau apa yang dipertahankan asisten Anda lintas percakapan.

- [Otomasi](https://lightvela.ai/docs/configuration/automation) — jadwalkan rutinitas yang terbukti berguna.
