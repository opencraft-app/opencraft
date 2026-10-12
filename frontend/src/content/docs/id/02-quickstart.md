# Panduan Cepat

## Ringkasan

**Untuk memulai percakapan pertama di LightVela, masuk dan aktifkan paket, tunggu hingga Bot siap, lalu buka Daily → Chat di My Agent dan kirim pesan. Chat di web tidak memerlukan kanal pesan; kredit model paket yang masih tersedia memungkinkan Anda memulai tanpa API key sendiri. Jika ingin memakai Bot yang sama di WeChat, ikuti langkah pemindaian kode QR di bagian berikutnya.**

---

Tutorial ini dimulai dengan Chat web, lalu menjelaskan cara menghubungkan WeChat bila perlu. Sediakan waktu tambahan untuk aktivasi paket dan penyiapan Bot.

## Yang dibahas di halaman ini

- Masuk ke LightVela

- Mengaktifkan paket Launch dan membuat instans Hermes

- Mengirim pesan pertama di Chat web

- Menghubungkan WeChat bila perlu

- Mengirim pesan di WeChat dan menerima balasan

> 💡 **Prasyarat**
>
> - Akun Google atau GitHub
>
> Paket Launch menyertakan 100 kredit uji coba, jadi Anda bisa langsung mulai chat tanpa menyiapkan API Key large language model terlebih dahulu.

---

## 1. Masuk ke LightVela

Buka [lightvela.ai](https://lightvela.ai) dan pilih **Masuk** di sudut kanan atas. Pada dialog masuk, baca dan setujui perjanjian, lalu pilih **Google** atau **GitHub** dan selesaikan otorisasi.

![Dialog masuk LightVela dengan Google dan GitHub](../images/2-1.webp)

---

## 2. Aktifkan paket Launch

Buka [halaman Subscribe](/subscribe), pilih opsi **Launch dengan 100 kredit** dalam seri Launch, lalu ikuti kartu paket sampai selesai. Periksa harga dan promo pesanan pertama sebelum mengonfirmasi.


> ⚠️ **Penawaran awal untuk pengguna baru**
>
> Pengguna baru yang memenuhi syarat dapat mencoba Launch gratis selama 1 bulan. Periksa [halaman Subscribe](/subscribe/) untuk syarat dan ketersediaan terbaru.


---

## 3. Buka Hermes Agent

Setelah masuk dengan Google atau GitHub dan mengaktifkan paket yang tersedia, buka [konsol Agent](/agents/overview/). Selesaikan pengaturan Bot pertama: isi nama yang wajib, tambahkan deskripsi jika perlu, dan atur tampilannya. Pilih **Buat**, lalu tunggu pembuatan dan konfigurasi awal selesai. Setelah konfigurasi selesai, pilih **Mulai perjalanan**, lalu buka Chat web untuk Bot tersebut. Kanal pesan bersifat opsional; balasan memerlukan kredit model paket yang tersedia atau model yang telah dikonfigurasi.

---

## 4. Mulai percakapan di Chat web

Setelah Bot siap, buka Daily → Chat, mulai percakapan baru, dan kirim “Hai.” Balasan pertama menandakan Chat web siap; lihat [Chat](./configuration/agent-chat.md) untuk mengelola percakapan.

## 5. Hubungkan WeChat jika diperlukan

Buka **Channels** di sidebar Agent. Pada kartu **WeChat**, pilih **+ Connect** dan ikuti petunjuk kode QR. Pindai dengan WeChat di ponsel dan selesaikan otorisasi. Pastikan WeChat ditampilkan sebagai terhubung sebelum mengirim pesan. Lihat [panduan WeChat](./configuration/channel-wechat.md) jika kode kedaluwarsa atau koneksi gagal.

---

## 6. Kirim pesan di WeChat

Cari akun bot yang sudah ditambahkan di WeChat, lalu kirim pesan uji:

```text
Hi
```

![Pesan uji dan balasan Bot di WeChat](../images/2-7.webp)

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
