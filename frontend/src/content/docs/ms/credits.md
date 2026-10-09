# Kredit

## Ringkasan

**Kredit model mengukur penggunaan panggilan model, termasuk input dan output. Launch, Launch AI, Cruise, dan Cruise AI masing-masing termasuk 100, 4,500, 200, dan 10,000 kredit sebulan. Pengguna dengan pelan aktif juga boleh membeli pek kredit sekali sahaja; kredit tersebut tamat tempoh sebulan selepas penghantaran dan tidak diperbaharui secara automatik. Perbualan dan tugas Ejen yang disokong model menggunakan kredit, manakala Notifikasi dan Tugas Skrip tidak menggunakan panggilan model. Jika kredit habis, anda boleh membeli pek yang layak, menunggu peruntukan pelan seterusnya, atau mengkonfigurasi kunci model anda sendiri API.**

---

Kredit model ialah unit LightVela digunakan untuk mengukur penggunaan model oleh Hermes Agent. Setiap pelan termasuk peruntukan kredit bulanan. Setiap kali Ejen anda memanggil model bahasa semasa perbualan atau tugasan, kredit akan ditolak mengikut penggunaan. Halaman ini menerangkan tentang kredit, cara ia diperuntukkan dan digunakan, dan cara ia berkaitan dengan rancangan.

## Perkara yang dilindungi oleh halaman ini

- Apakah maksud kredit model dan cara ia ditukar

- Bagaimana rancangan memperuntukkan kredit setiap bulan

- Cara kredit digunakan dan cara ia berkaitan dengan token

- Bagaimana kredit berkaitan dengan rancangan dan model

---

## Apakah kredit model?

Model mengukur kredit untuk panggilan ke model bahasa. Perbualan, [Tugas Ejen](./configuration/automation.md) yang disokong model, dan Kemahiran yang memanggil model menggunakan kredit; Pemberitahuan dan Tugas Skrip tidak memanggil model.

Anggaran penukaran ialah **1 kredit ≈ 10,000 token**. Token ialah unit asas teks yang diproses oleh model. Kedua-dua input—kandungan yang anda hantar kepada Ejen anda—dan output—tindak balas yang dijananya—dikira dalam penggunaan.

> ℹ️ Peraturan penukaran dan pengukuran tepat yang ditunjukkan oleh platform adalah berwibawa. Kos setiap token mungkin berbeza antara model.

---

## Bagaimana kredit diperuntukkan

Kredit **diperuntukkan setiap bulan dengan pelan**, dan amaun bulanan berbeza mengikut peringkat:

| Pelan | Kredit model bulanan |
|---|---:|
| Pelancaran | 100 |
| Pelayaran | 200 |
| Pelancaran AI | 4,500 |
| Pelayaran AI | 10,000 |

Lihat [Pelan](./plans.md) untuk sumber yang sepadan dan [halaman Langgan](/subscribe) untuk ketersediaan semasa dan harga.

## Pek kredit tambahan

Pengguna dengan pelan aktif boleh membeli pek kredit model sekali sahaja di [halaman Langgan](/subscribe#subscribe-credits). Setiap pek sah untuk satu bulan dari tarikh penghantaran dan tidak diperbaharui secara automatik. Kredit dengan tarikh tamat lebih awal digunakan terlebih dahulu; apabila tarikh sama, kredit yang lebih lama digunakan terlebih dahulu. Semak halaman pembayaran untuk harga semasa dan denominasi yang tersedia.

---

## Cara kredit digunakan

Kredit digunakan dalam situasi berikut kerana setiap satu memerlukan Hermes untuk memanggil model bahasa:

- **Bercakap dengan Ejen anda** — Mesej melalui Telegram, WhatsApp, Discord, Slack, WeChat atau saluran lain yang disokong

- **Menjalankan Tugas Ejen** — Membenarkan Ejen anda menjalankan [tugas berjadual](./configuration/automation.md) yang disokong oleh model

- **Menggunakan kemahiran** — Membenarkan kemahiran memanggil model untuk penaakulan semasa pelaksanaan

Penggunaan bergantung pada panjang perbualan dan model yang dipilih. Kandungan yang lebih panjang dan lebih banyak konteks biasanya menggunakan lebih banyak token dan oleh itu lebih banyak kredit. Memilih model yang lebih menjimatkan dan mengekalkan konteks fokus boleh mengurangkan penggunaan. Lihat [Konfigurasikan Model](./configuration/model.md).

---

## Bagaimana kredit berkaitan dengan pelan dan model

- **Terikat pada pelan**: Kredit adalah sebahagian daripada sumber pelan dan diperuntukkan pada kitaran bulanannya. Sebarang cara yang tersedia pada masa ini untuk mendapatkan atau menambah kredit ditunjukkan pada [halaman Langgan](/subscribe) dan dikawal oleh peraturan terkini platform.

- **Bergantung pada model**: Model boleh mempunyai kos setiap token yang berbeza, jadi perbualan yang sama mungkin menggunakan bilangan kredit yang berbeza dengan model yang berbeza.

- **Kitaran peruntukan**: Kredit diperuntukkan setiap bulan. Pertukaran dan tamat tempoh mengikut peraturan semasa platform.

Jika anda menggunakan semua kredit untuk tempoh semasa, ciri Ejen yang bergantung pada panggilan model menjadi terhad sehingga peruntukan baharu tersedia atau platform menawarkan pilihan lain.

---

## Soalan Lazim

### Bagaimanakah kredit berkaitan dengan pelan?

Kredit diberikan setiap bulan mengikut pelan. Pelanggan aktif juga boleh membeli pek kredit sekali sahaja. Semak [halaman Langgan](/subscribe) untuk pilihan dan harga yang tersedia.

### Berapa lama tempoh satu kredit?

Satu kredit adalah kira-kira 10,000 token. Bilangan pusingan perbualan yang disokong ini bergantung pada panjang setiap input dan output dan pada model yang dipilih, jadi tiada penukaran tetap kepada mesej. Perbualan yang lebih panjang biasanya menggunakan kredit dengan lebih cepat.

### Adakah semua model menggunakan kredit pada kadar yang sama?

Tidak. Model mempunyai kos setiap token yang berbeza, jadi tugas yang sama mungkin menggunakan bilangan kredit yang berbeza bergantung pada model. Pilih model yang sesuai dengan keperluan anda di bawah [Konfigurasikan Model](./configuration/model.md).

### Bolehkah saya meneruskan selepas menggunakan semua kredit saya?

Anda boleh membeli pek kredit sekali sahaja yang layak, menunggu agihan pelan seterusnya, atau mengkonfigurasi kunci API model anda sendiri. Ciri-ciri yang disokong model adalah terhad apabila tiada kredit yang boleh digunakan atau kunci tersedia.

---

## Langkah seterusnya

- [Pelan](./plans.md) — Bandingkan sumber dan peruntukan kredit mengikut peringkat

- [Konfigurasikan Model](./configuration/model.md) — Pilih model yang lebih menjimatkan atau lebih berkebolehan

- [Aktifkan Hermes Instance Pertama Anda](./create-first-hermes.md) — Pergi daripada pengaktifan pelan kepada Ejen yang sedang berjalan

- [Konsep Teras](./04-core-concepts.md) — Fahami Hermes, model, saluran dan kemahiran
