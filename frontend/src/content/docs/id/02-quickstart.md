# Panduan Cepat

## Ringkasan

**Menjalankan percakapan pertama di LightVela memerlukan sekitar 5 menit: masuk ke LightVela → aktifkan sebuah paket → platform otomatis membuat instance Hermes Agent → konfigurasikan model (atau langsung gunakan kredit model bulanan dari paket Anda) → hubungkan satu kanal pesan → kirim pesan dan terima balasan. Semuanya dilakukan di browser, tanpa perlu membeli server atau melakukan deployment lokal. Jalur tercepat adalah memakai kredit paket bersama kanal WeChat yang cukup dihubungkan dengan memindai kode QR, lalu menambahkan API key model sendiri dan kanal lain sesuai kebutuhan.**

---

Tutorial ini memandu Anda dari proses masuk sampai menerima balasan pertama dari Hermes lewat WeChat. Waktunya sekitar 5 menit.

## Yang dibahas di halaman ini

- Masuk ke LightVela

- Mengaktifkan paket Launch dan membuat instans Hermes

- Menghubungkan kanal Telegram / WhatsApp / Discord / Slack / WeChat

- Mengirim pesan di WeChat dan menerima balasan

> 💡 **Prasyarat**
>
> - Akun Google atau GitHub
>
> Paket Launch menyertakan 100 kredit uji coba, jadi Anda bisa langsung mulai chat tanpa menyiapkan API Key large language model terlebih dahulu.

---

## 1. Masuk ke LightVela

Buka [lightvela.ai](https://lightvela.ai), lalu klik "Masuk" di kanan atas. Di dialog login, pilih Google atau GitHub, setujui perjanjian yang ditampilkan, lalu selesaikan otorisasi.

![](../images/2-1.webp)

---

## 2. Aktifkan paket Launch

Buka [halaman Subscribe](/subscribe), pilih opsi **Launch dengan 100 kredit** dalam seri Launch, lalu ikuti kartu paket sampai selesai. Periksa harga dan promo pesanan pertama sebelum mengonfirmasi.


> ⚠️ **Penawaran awal untuk pengguna baru**
>
> Pengguna baru yang memenuhi syarat dapat mencoba Launch gratis selama 1 bulan. Periksa [halaman Subscribe](/subscribe/) untuk syarat dan ketersediaan terbaru.


---

## 3. Buka Hermes Agent

Setelah paket aktif, buka [konsol Agent](/agents/overview/). LightVela menyiapkan instans cloud untuk paket Anda. Jika konsol meminta Anda membuat Agent, ikuti petunjuk di layar dan tunggu hingga statusnya **Running**. Sidebar kemudian menyediakan **Channels**, **Models**, **Skills**, dan **Scheduled Tasks**. Kredit model paket dapat dipakai tanpa API key sendiri.

---

## 4. Hubungkan WeChat

Buka **Channels** di sidebar Agent. Pada kartu **WeChat**, pilih **+ Connect** dan ikuti petunjuk kode QR. Pindai dengan WeChat di ponsel dan selesaikan otorisasi. Pastikan WeChat ditampilkan sebagai terhubung sebelum mengirim pesan. Lihat [panduan WeChat](./configuration/channel-wechat.md) jika kode kedaluwarsa atau koneksi gagal.

---

## 5. Kirim pesan pertama

Cari akun bot yang sudah ditambahkan di WeChat, lalu kirim pesan uji:

```
Hi
```

![](../images/2-7.webp)

Anda seharusnya menerima balasan dari Hermes dalam beberapa detik. Sekarang Hermes sudah bisa diajak chat lewat WeChat.

> 💡 **Penagihan pesan**
>
> Panggilan model menggunakan 100 kredit dalam opsi Launch secara bawaan. Jika habis, beli [paket kredit](./credits.md) yang memenuhi syarat atau atur API key sendiri di **Models**.

---

## Lanjutan: atur model sendiri (opsional)

Jika Anda memerlukan penyedia tertentu, buka **Models** di sidebar Agent, pilih penyedia dan model, tambahkan API key, lalu tetapkan model utama. Lihat [Konfigurasi Model](./configuration/model.md).

---

## FAQ

| Masalah | Periksa | Tindakan |
|---|---|---|
| Opsi Launch tidak dapat diaktifkan | Ketersediaan, kelayakan promo, dan status pembayaran | Periksa [halaman Subscribe](/subscribe) dan pesan akhir pembayaran; jangan membuat pesanan ganda. |
| Penyiapan Agent lama | Apakah konsol masih melakukan provisioning atau menampilkan error | Muat ulang ringkasan Agent sekali; jika tidak berubah, buka [Diagnostics](./configuration/diagnostics.md) atau hubungi dukungan. |
| Kode QR WeChat kedaluwarsa | Apakah otorisasi selesai di ponsel | Kembali ke **Channels** dan mulai koneksi baru. |
| Pesan tidak dibalas | Koneksi kanal, status Agent, dan kredit model | Periksa **Channels** dan **Diagnostics**. Jika kredit habis, lihat [opsi kredit](./credits.md). |
---

## Langkah berikutnya

- [Konsep Inti](./04-core-concepts.md) — Pahami lima konsep utama: Hermes Agent, Bot, model, kanal, dan Skill

- [Ringkasan Konfigurasi](./05-configuration.md) — Struktur umum konsol

- [Konfigurasi Skill](./configuration/skill.md) — Pasang Skill dari Skills.sh atau ClawHub
