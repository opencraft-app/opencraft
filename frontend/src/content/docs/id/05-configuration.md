# Ringkasan Konfigurasi

## Ringkasan

**Konsol Agent menampilkan halaman Channels, Models, Skills, dan Scheduled Tasks secara terpisah di sidebar. Pilih Bot yang benar sebelum mengubah pengaturannya. Hubungkan kanal dari kartunya, pilih model atau gunakan kredit paket, lalu pasang Skill dari Skills.sh atau ClawHub saat dibutuhkan. Soul, Memory, Diagnostics, Advanced Settings, dan Labs ada di bagian lain; Cloud Storage dibuka dari menu pengguna.**

---

Konsol Agent mengatur konfigurasi harian dalam halaman sidebar **Channels**, **Models**, **Skills**, dan **Scheduled Tasks**. Pilih Bot yang akan diatur, lalu buka halaman terkait. Panduan ini menjelaskan titik masuk dan cara memeriksa hasilnya.

## Yang dibahas di halaman ini

- Cara masuk ke konsol

- Pemilih Bot dan informasi Bot yang dipilih

- Lokasi Channels, Models, Skills, dan Cloud Storage

- Kondisi berhasil setelah konfigurasi

- Operasi umum seperti mengelola Bot, mengganti model, dan menghubungkan beberapa kanal

---

## Masuk ke konsol

Setelah masuk, buka [konsol Agent](/agents/overview/) dan pilih Hermes Agent serta Bot yang ingin diatur.

---

## Bot dan informasi Bot yang dipilih

Bagian atas konsol berisi tab Bot untuk Hermes Agent saat ini. Tab pertama adalah Bot utama, sedangkan setiap tab tambahan adalah profil Bot terpisah. Paket Anda menentukan jumlah total Bot, termasuk Bot utama. Selama peluncuran internasional bertahap, pintu masuk pembuatan tidak ditampilkan secara default.

Setelah memilih Bot, informasi dasarnya ditampilkan di bawah:

- Avatar

- Nama. Klik nama atau ikon pensil untuk mengedit, lalu tekan Enter untuk menyimpan

- Status (● Berjalan / ● Tidak diketahui)

- Waktu pembuatan

- Tombol hapus, berupa ikon tempat sampah di sebelah kanan

> ⚠️ **Penghapusan tidak bisa dibatalkan**
>
> Menghapus Bot tambahan akan menghapus profil dan data Bot tersebut secara permanen. Menghapus Bot utama akan menghapus seluruh Hermes Agent beserta semua data terkait dan hanya dapat dilakukan setelah Bot lain dihapus.

---

## Atur kanal, model, dan Skill

### Channels

Buka **Channels** di sidebar Agent. Halaman ini menampilkan kartu Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom, dan Lark. Pilih **+ Connect** pada kanal yang diinginkan. WhatsApp, WeChat, WeCom, dan Lark memakai otorisasi kode QR; Telegram, Discord, dan Slack memakai kredensial. QQ menyediakan kode QR atau App ID / Secret. Lihat [panduan WhatsApp](./configuration/channel-whatsapp.md).

### Models

Buka **Models** untuk melihat model aktif atau mengatur penyedia. Kredit model dalam paket dapat dipakai tanpa API key sendiri; tambahkan penyedia bila diperlukan. Setiap Bot memakai satu model utama pada satu waktu dan dapat memiliki model fallback yang dikonfigurasi terpisah. Lihat [Konfigurasi Model](./configuration/model.md) dan [Penggantian Model](./configuration/multiple-models.md).

### Skills

Buka **Skills** untuk mencari Skill atau menjelajahi **Skill Packages** dari [Skills.sh](https://skills.sh/) dan [ClawHub](https://clawhub.ai/). Pilih **Install**, lalu periksa hasilnya di **Installed**. Lihat [Konfigurasi Skill](./configuration/skill.md).

## Kondisi berhasil setelah konfigurasi

Setelah konfigurasi selesai, konsol seharusnya menampilkan kondisi berikut:

- Daftar "Kanal terhubung" memiliki setidaknya satu catatan, misalnya "WeChat"

- "Model saat ini" bersifat opsional; jika memakai kredit uji coba Launch, tidak ada konfigurasi model yang wajib dilakukan

- "Skill terpasang" dapat diatur sesuai kebutuhan dan boleh kosong

Begitu "Kanal terhubung" memiliki setidaknya satu catatan, Anda bisa menemukan bot di platform chat terkait dan mulai berbicara. Hermes Agent akan menghasilkan balasan memakai model default atau kredit uji coba Launch.

---

## Operasi umum

- **Ganti model:** Buka **Models** pada Bot yang dipilih dan pilih model tersedia yang sudah dikonfigurasi. Memori Bot tetap ada; lihat [Penggantian Model](./configuration/multiple-models.md).
- **Hubungkan beberapa kanal:** Buka **Channels** dan pilih **+ Connect** pada setiap kartu yang diperlukan. Kanal milik Bot yang sama berbagi persona dan memorinya.
- **Kelola Bot:** Pilih tab Bot sebelum mengubah pengaturan. Jika pembuatan tersedia, ikuti [Kelola Bot](./configuration/bots-switching.md).
- **Buka Cloud Storage:** Gunakan **Cloud Storage** di menu pengguna, bukan sidebar Agent.

---

## Langkah berikutnya

Konfigurasi detail untuk tiap modul:

- Model — Sumber model, cara mendapatkan API Key, dan panduan memilih model

- Kanal — WeChat, Telegram, WhatsApp, Discord, Slack, QQ, WeCom, dan Lark

- Skill — Penggunaan Skills.sh / ClawHub dan instalasi Skill

Referensi terkait:

- [Konsep Inti](./04-core-concepts.md)

- [Panduan Cepat](./02-quickstart.md)
