# Kredit

## Ringkasan

**Kredit model adalah satuan yang dipakai LightVela untuk menghitung konsumsi pemanggilan model oleh Hermes Agent, dengan input maupun output ikut dihitung. Kredit diberikan bersama paket setiap bulan, tidak dijual terpisah, dan direset tiap siklus bulanan: Launch mencakup 100 kredit per bulan, sedangkan Cruise menyediakan kuota lebih besar. Kredit terpakai saat Agent berbicara dengan Anda, menjalankan tugas otomatis, atau menjalankan skill — semuanya pada dasarnya memanggil model — dan percakapan yang lebih panjang dengan konteks lebih besar menghabiskannya lebih cepat. Jika kredit habis di tengah siklus, fitur yang bergantung pada model menjadi terbatas hingga alokasi berikutnya, atau Anda dapat beralih ke API key model sendiri di pengaturan model.**

---

Kredit model adalah satuan yang digunakan LightVela untuk mengukur penggunaan model oleh Hermes Agent. Setiap paket menyertakan alokasi kredit bulanan. Setiap kali Agent Anda memanggil language model selama percakapan atau tugas, kredit akan dikurangi sesuai penggunaan. Halaman ini menjelaskan apa itu kredit, bagaimana kredit dialokasikan dan dikonsumsi, serta bagaimana kredit berkaitan dengan paket.

## Yang dibahas di halaman ini

- Apa arti kredit model dan bagaimana konversinya

- Bagaimana paket mengalokasikan kredit setiap bulan

- Bagaimana kredit dikonsumsi dan hubungannya dengan token

- Bagaimana kredit berkaitan dengan paket dan model

---

## Apa itu kredit model?

Kredit model adalah **satuan pengukuran** untuk pemanggilan language model oleh Hermes Agent. Setiap kali Agent Anda membalas dalam percakapan, menjalankan [tugas terjadwal](./configuration/automation.md), atau menggunakan Skill, ia mengirim permintaan ke model yang mendasarinya. Token yang digunakan oleh permintaan tersebut dikonversi menjadi kredit.

Konversi perkiraannya adalah **1 kredit ≈ 10.000 token**. Token adalah satuan dasar teks yang diproses oleh model. Baik input—konten yang Anda kirim ke Agent Anda—maupun output—balasan yang dihasilkannya—dihitung sebagai penggunaan.

> ℹ️ Aturan konversi dan pengukuran yang persis ditampilkan oleh platform bersifat mengikat. Biaya per token dapat berbeda antar model.

---

## Bagaimana kredit dialokasikan

Kredit **dialokasikan setiap bulan bersama paket**, dan jumlah bulanannya berbeda untuk setiap tingkat:

| Paket | Kredit model (alokasi standar) |
|---|---|
| Launch | 100 kredit / bulan |
| Cruise | 200 kredit / bulan |

Beberapa paket dapat menawarkan **alokasi kredit yang lebih besar**. Periksa kartu paket di [halaman Subscribe](/subscribe) untuk opsi yang saat ini tersedia, dan lihat [Paket](./plans.md) untuk struktur sumber daya dan kredit tiap tingkat.

---

## Bagaimana kredit dikonsumsi

Kredit dikonsumsi dalam situasi berikut karena masing-masing membutuhkan Hermes untuk memanggil language model:

- **Mengobrol dengan Agent Anda** — Mengirim pesan melalui Telegram, WhatsApp, Discord, Slack, WeChat, atau kanal lain yang didukung

- **Menjalankan tugas terjadwal** — Membiarkan Agent Anda mengeksekusi [tugas terjadwal](./configuration/automation.md)

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

Kredit adalah sumber daya yang termasuk dalam paket dan dialokasikan setiap bulan. Ketersediaan saat ini dan harga mendatang untuk opsi kredit berbeda ditampilkan di [halaman Subscribe](/subscribe).

### Berapa lama satu kredit bertahan?

Satu kredit setara dengan sekitar 10.000 token. Jumlah giliran percakapan yang didukung bergantung pada panjang tiap input dan output serta model yang dipilih, sehingga tidak ada konversi tetap ke jumlah pesan. Percakapan yang lebih panjang biasanya menghabiskan kredit lebih cepat.

### Apakah semua model mengonsumsi kredit dengan tingkat yang sama?

Tidak. Model memiliki biaya per token yang berbeda, sehingga tugas yang sama dapat mengonsumsi jumlah kredit yang berbeda tergantung modelnya. Pilih model yang sesuai kebutuhan Anda di [Konfigurasi Model](./configuration/model.md).

### Bisakah saya melanjutkan setelah kredit saya habis?

Fitur yang membutuhkan pemanggilan model akan dibatasi setelah alokasi habis. Kapan alokasi baru tersedia, atau apakah opsi lain ditawarkan, bergantung pada aturan platform saat ini.

---

## Langkah berikutnya

- [Paket](./plans.md) — Bandingkan sumber daya dan alokasi kredit tiap tingkat

- [Konfigurasi Model](./configuration/model.md) — Pilih model yang lebih ekonomis atau lebih andal

- [Aktifkan Instans Hermes Pertama Anda](./create-first-hermes.md) — Dari aktivasi paket sampai Agent berjalan

- [Konsep Inti](./04-core-concepts.md) — Pahami Hermes, model, kanal, dan Skill
