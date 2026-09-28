# Kredit

## Ringkasan

**Kredit model mengukur pemakaian panggilan model, termasuk input dan output. Launch, Launch AI, Cruise, dan Cruise AI masing-masing menyediakan 100, 4.500, 200, dan 10.000 kredit per bulan. Pengguna dengan paket aktif juga dapat membeli paket kredit satu kali; kredit tersebut berlaku satu bulan setelah diterima dan tidak diperpanjang otomatis. Percakapan dan Agent Task yang memanggil model memakai kredit, sedangkan Notification Task dan Script Task tidak. Jika kredit habis, beli paket yang memenuhi syarat, tunggu alokasi berikutnya, atau gunakan API key model Anda sendiri.**

---

Kredit model adalah satuan yang digunakan LightVela untuk mengukur penggunaan model oleh Hermes Agent. Setiap paket menyertakan alokasi kredit bulanan. Setiap kali Agent Anda memanggil language model selama percakapan atau tugas, kredit akan dikurangi sesuai penggunaan. Halaman ini menjelaskan apa itu kredit, bagaimana kredit dialokasikan dan dikonsumsi, serta bagaimana kredit berkaitan dengan paket.

## Yang dibahas di halaman ini

- Apa arti kredit model dan bagaimana konversinya

- Bagaimana paket mengalokasikan kredit setiap bulan

- Bagaimana kredit dikonsumsi dan hubungannya dengan token

- Bagaimana kredit berkaitan dengan paket dan model

---

## Apa itu kredit model?

Kredit model mengukur panggilan ke model bahasa. Percakapan, [Agent Task](./configuration/automation.md) yang memanggil model, dan Skill yang memakai model mengonsumsi kredit; Notification Task dan Script Task tidak memanggil model.

Konversi perkiraannya adalah **1 kredit ≈ 10.000 token**. Token adalah satuan dasar teks yang diproses oleh model. Baik input—konten yang Anda kirim ke Agent Anda—maupun output—balasan yang dihasilkannya—dihitung sebagai penggunaan.

> ℹ️ Aturan konversi dan pengukuran yang persis ditampilkan oleh platform bersifat mengikat. Biaya per token dapat berbeda antar model.

---

## Bagaimana kredit dialokasikan

Kredit **dialokasikan setiap bulan bersama paket**, dan jumlah bulanannya berbeda untuk setiap tingkat:

| Paket | Kredit model per bulan |
|---|---:|
| Launch | 100 |
| Cruise | 200 |
| Launch AI | 4.500 |
| Cruise AI | 10.000 |

Lihat [Paket](./plans.md) untuk sumber daya masing-masing dan [halaman Subscribe](/subscribe) untuk ketersediaan serta harga terkini.

## Paket kredit tambahan

Pengguna dengan paket aktif dapat membeli paket kredit model sekali bayar di [halaman Subscribe](/subscribe#subscribe-credits). Paket berlaku satu bulan sejak kredit diterima dan tidak diperpanjang otomatis. Kredit dengan tanggal kedaluwarsa lebih awal dipakai lebih dulu; jika tanggalnya sama, kredit yang lebih lama dipakai lebih dulu. Harga dan denominasi terkini ditampilkan saat pembayaran.

---

## Bagaimana kredit dikonsumsi

Kredit dikonsumsi dalam situasi berikut karena masing-masing membutuhkan Hermes untuk memanggil language model:

- **Mengobrol dengan Agent Anda** — Mengirim pesan melalui Telegram, WhatsApp, Discord, Slack, WeChat, atau kanal lain yang didukung

- **Menjalankan Agent Task** — Agent menjalankan [tugas terjadwal](./configuration/automation.md) yang memanggil model

- **Menggunakan Skill** — Mengizinkan Skill memanggil model untuk melakukan reasoning saat eksekusi

Penggunaan bergantung pada panjang percakapan dan model yang dipilih. Konten yang lebih panjang dan konteks yang lebih banyak umumnya memakai lebih banyak token sehingga lebih banyak kredit. Memilih model yang lebih ekonomis dan menjaga konteks tetap fokus dapat mengurangi penggunaan. Lihat [Konfigurasi Model](./configuration/model.md).

---

## Bagaimana kredit berkaitan dengan paket dan model

- **Terikat pada paket**: Kredit adalah bagian dari sumber daya paket dan dialokasikan sesuai siklus bulanannya. Cara mendapatkan atau menambah kredit yang saat ini tersedia ditampilkan di [halaman Subscribe](/subscribe) dan mengikuti aturan platform terbaru.

- **Bergantung pada model**: Model dapat memiliki biaya per token yang berbeda, sehingga percakapan yang sama dapat mengonsumsi jumlah kredit yang berbeda dengan model yang berbeda.

- **Siklus alokasi**: Kredit dialokasikan setiap bulan. Rollover dan masa berlaku mengikuti aturan platform saat ini.

Jika Anda menghabiskan seluruh kredit periode saat ini, fitur Agent yang bergantung pada pemanggilan model akan dibatasi sampai alokasi baru tersedia atau platform menawarkan opsi lain.

---

## FAQ

### Bagaimana hubungan kredit dengan paket?

Kredit dialokasikan tiap bulan bersama paket. Pelanggan dengan paket aktif juga dapat membeli paket kredit sekali bayar. Lihat [halaman Subscribe](/subscribe) untuk opsi dan harga saat ini.

### Berapa lama satu kredit bertahan?

Satu kredit setara dengan sekitar 10.000 token. Jumlah giliran percakapan yang didukung bergantung pada panjang tiap input dan output serta model yang dipilih, sehingga tidak ada konversi tetap ke jumlah pesan. Percakapan yang lebih panjang biasanya menghabiskan kredit lebih cepat.

### Apakah semua model mengonsumsi kredit dengan tingkat yang sama?

Tidak. Model memiliki biaya per token yang berbeda, sehingga tugas yang sama dapat mengonsumsi jumlah kredit yang berbeda tergantung modelnya. Pilih model yang sesuai kebutuhan Anda di [Konfigurasi Model](./configuration/model.md).

### Bisakah saya melanjutkan setelah kredit saya habis?

Anda dapat membeli paket kredit yang memenuhi syarat, menunggu alokasi berikutnya, atau mengatur API key model sendiri. Fitur yang memanggil model dibatasi jika tidak ada kredit atau key yang dapat digunakan.

---

## Langkah berikutnya

- [Paket](./plans.md) — Bandingkan sumber daya dan alokasi kredit tiap tingkat

- [Konfigurasi Model](./configuration/model.md) — Pilih model yang lebih ekonomis atau lebih andal

- [Aktifkan Instans Hermes Pertama Anda](./create-first-hermes.md) — Dari aktivasi paket sampai Agent berjalan

- [Konsep Inti](./04-core-concepts.md) — Pahami Hermes, model, kanal, dan Skill
