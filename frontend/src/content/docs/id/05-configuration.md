# Ringkasan Konfigurasi

## Ringkasan

**Seluruh konfigurasi LightVela terpusat di konsol "My Hermes", yang dibuka dari sudut kanan atas setelah Anda masuk. Tab instance Hermes Agent berada di bagian atas, dan di bawahnya terdapat tiga tombol konfigurasi: Model (pilih Model Coding Plan bulanan, Model API sesuai pemakaian, atau endpoint kustom yang kompatibel dengan OpenAI), Kanal (pintu masuk tiap platform pesan — sebagian dihubungkan dengan kode QR, sebagian memerlukan token atau AppID), dan Skill (memasang paket kemampuan yang dapat dipakai ulang). Selain ketiganya, konsol juga menyediakan Percakapan, Tugas Otomatis, manajemen memori, penyimpanan cloud, penggantian model, dan pusat diagnostik. Setelah tiga konfigurasi dasar selesai, Agent siap dipakai di kanal pesan Anda.**

---

Semua konfigurasi LightVela dipusatkan di konsol "My Hermes" dan terbagi ke tiga tombol konfigurasi:

1. Model

2. Kanal

3. Skill

Halaman ini memperkenalkan struktur umum konsol dan fungsi tiap tombol. Untuk langkah operasional detail, lihat subhalaman terkait.

## Yang dibahas di halaman ini

- Cara masuk ke konsol

- Tombol informasi instans Hermes Agent

- Fungsi dan pintu masuk dari tiga tombol konfigurasi

- Kondisi berhasil setelah konfigurasi

- Operasi umum seperti mengganti model, menghubungkan beberapa kanal, dan membuat ulang Hermes Agent

---

## Masuk ke konsol

Setelah masuk, klik "Hermes Saya" di kanan atas untuk membuka konsol. Di bagian atas halaman tersedia tombol "Kembali ke Beranda".

---

## Informasi instans Hermes Agent

Bagian atas konsol berisi tab Hermes Agent. Setiap tab mewakili satu instans Hermes Agent. Paket Launch hanya mendukung 1 instans. Tombol "+ Create" di kanan akan nonaktif setelah batas instans tercapai.

Setelah memilih Hermes Agent, informasi dasarnya ditampilkan di bawah:

- Avatar

- Nama. Klik nama atau ikon pensil untuk mengedit, lalu tekan Enter untuk menyimpan

- Status (● Berjalan / ● Tidak diketahui)

- Waktu pembuatan

- Tombol hapus, berupa ikon tempat sampah di sebelah kanan

> ⚠️ **Penghapusan tidak bisa dibatalkan**
>
> Mengklik ikon tempat sampah akan menghapus instans Hermes Agent secara permanen, termasuk seluruh memori percakapan, kanal yang terhubung, dan Skill yang terpasang. Jika kuota paket Launch masih memungkinkan, Anda dapat membuat Hermes Agent baru setelahnya.

---

## Tiga tombol konfigurasi

Tiga tombol disusun dari kiri ke kanan. Urutan konfigurasi yang disarankan adalah 1 → 2 → 3.

### 1. Kanal

![](./images/4-2.webp)

**Tujuan**: Menghubungkan Hermes Agent ke platform chat dan menyediakan pintu masuk percakapan bagi pengguna.

**Cara akses per kanal**:

| Kanal | Cara akses | Syarat |
|---|---|---|
| WeChat | Otorisasi kode QR | Ponsel yang sudah memasang WeChat |
| Telegram | Akses Bot Token | Membuat Telegram Bot melalui BotFather dan mendapatkan Bot Token |
| WhatsApp | Akses WhatsApp Business API | Akun developer Meta, WhatsApp Business Account, dan setup dasar Cloud API |
| Discord | Akses Bot Token | Membuat Application di Discord Developer Portal, menambahkan Bot, lalu mengundangnya ke server |
| Slack | Akses Bot Token / App Token | Membuat Slack App, mengaktifkan Socket Mode, dan mendapatkan token Bot/App |
| QQ | Akses AppID / AppSecret | Akun QQ; buat bot di QQ Open Platform dan dapatkan AppID / AppSecret |
| WeCom | Otorisasi kode QR | Ponsel yang sudah memasang WeCom |
| Lark | Otorisasi kode QR | Ponsel yang sudah memasang Lark, atau desktop Lark yang sudah login |

**Yang tersedia di tombol ini**: Dropdown kanal, tombol "Izinkan akses", pengantar kanal terpilih beserta tautan "Lihat detail", dan daftar "Kanal terhubung".

Gunakan tabel di atas sebagai ringkasan cara akses tiap kanal yang saat ini didukung.

---

### 2. Model

![](./images/4-1.webp)

**Tujuan**: Mengatur large language model untuk Hermes Agent. Paket Launch menyertakan 100 kredit uji coba, jadi Anda bisa melewati langkah ini pada awal penggunaan dan mengatur model setelah kredit habis.

**Yang tersedia di tombol ini**: Dropdown sumber (Model Coding Plan / Model API / Custom Model), dropdown model, input API Key, pengantar penyedia, tautan untuk mendapatkan API Key, dan daftar "Model saat ini".

> ⚠️ **Hanya satu model yang aktif**
>
> Saat ini, setiap Hermes Agent hanya dapat memiliki satu konfigurasi model aktif. Aksi "Jadikan default" yang baru akan menimpa konfigurasi yang sudah ada.

Untuk ringkasan alur model, lanjutkan dengan bagian ini.

---

### 3. Skill

![](./images/4-3.webp)

**Tujuan**: Memperluas kemampuan Hermes Agent, misalnya menyusun to-do, membuat laporan harian, dan mencari informasi di web.

**Yang tersedia di tombol ini**: Kotak pencarian nama Skill, tombol "Instal Skill", tautan "Buka SkillHub", dan daftar "Skill terpasang". Sebelum instalasi, pastikan nama Skill yang tepat di [SkillHub](https://skillhub.tencent.com).

> ⚠️ **Instal hanya Skill yang tepercaya**
>
> Skill memiliki izin untuk memanggil kemampuan Hermes Agent saat runtime. Instal hanya Skill dari sumber yang Anda percaya.

Untuk memakai fitur ini, masukkan nama Skill yang tepat dari SkillHub lalu ikuti instruksi di konsol.

---

## Kondisi berhasil setelah konfigurasi

Setelah konfigurasi selesai, konsol seharusnya menampilkan kondisi berikut:

- Daftar "Kanal terhubung" memiliki setidaknya satu catatan, misalnya "WeChat"

- "Model saat ini" bersifat opsional; jika memakai kredit uji coba Launch, tidak ada konfigurasi model yang wajib dilakukan

- "Skill terpasang" dapat diatur sesuai kebutuhan dan boleh kosong

Begitu "Kanal terhubung" memiliki setidaknya satu catatan, Anda bisa menemukan bot di platform chat terkait dan mulai berbicara. Hermes Agent akan menghasilkan balasan memakai model default atau kredit uji coba Launch.

---

## Operasi umum

### Mengganti model

Di tombol "Model", pilih kembali sumber dan model, masukkan API Key, lalu klik "Jadikan default". Konfigurasi baru akan menimpa konfigurasi sebelumnya. Mengganti model tidak memengaruhi memori percakapan.

### Menghubungkan beberapa kanal

Di tombol "Kanal", pilih opsi dropdown satu per satu lalu klik "Izinkan akses". Beberapa kanal akan mengarah ke Hermes Agent yang sama dan berbagi memori serta perilaku Agent.

### Membuat ulang Hermes Agent

Klik ikon tempat sampah di sisi kanan informasi dasar untuk menghapus Hermes Agent saat ini, lalu klik "+ Buat Hermes Agent" untuk membuatnya lagi. **Seluruh memori percakapan akan hilang**.

---

## Langkah berikutnya

Konfigurasi detail untuk tiap modul:

- Model — Sumber model, cara mendapatkan API Key, dan panduan memilih model

- Kanal — WeChat, Telegram, WhatsApp, Discord, Slack, QQ, WeCom, dan Lark

- Skill — Penggunaan SkillHub dan instalasi Skill

Referensi terkait:

- [Konsep Inti](./04-core-concepts.md)

- [Panduan Cepat](./02-quickstart.md)
