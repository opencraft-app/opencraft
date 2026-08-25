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

![](./images/2-1.webp)

---

## 2. Aktifkan paket Launch

Kembali ke halaman utama, klik "Buat sekarang" untuk masuk ke halaman paket, pilih "Launch", lalu klik "Aktifkan sekarang".

![](./images/2-2.webp)

> ⚠️ **Launch memiliki uji coba gratis 14 hari untuk pengguna baru setelah penagihan dimulai**
>
> LightVela berencana masuk beta publik dan mulai menagih pada 18 Agustus 2026 (Waktu Singapura). Setelah penagihan dimulai, pengguna baru dapat mencoba Launch gratis selama 14 hari. Lihat [Paket](./plans.md) untuk ringkasan paket dan manfaat terbaru.

Setelah aktivasi berhasil, navigasi atas akan menampilkan "Hermes Saya" dan halaman otomatis diarahkan ke konsol. Untuk detail paket, lihat [Apa Itu LightVela - Tentang paket](./01-overview.md#tentang-paket).

---

## 3. Buat instans Hermes

Saat masuk ke konsol, halaman menampilkan keadaan kosong karena belum ada Hermes yang dibuat.

![](./images/20260424-113103-70fi.webp)

Klik "Buat sekarang". Halaman akan menampilkan animasi persiapan Hermes. Tunggu sekitar belasan detik.

![](./images/20260424-113120-qvlx.webp)

Setelah proses selesai, bagian atas konsol menampilkan kartu informasi dasar Hermes, statusnya ● Berjalan, dan tiga tombol konfigurasi untuk model, kanal, dan Skill muncul di bawahnya.

![](./images/2-5.webp)

> 💡 **Mengganti nama Hermes**
>
> Klik nama atau ikon pensil di sebelahnya, masukkan nama baru, lalu tekan Enter untuk menyimpan. Nama ini hanya dipakai sebagai penanda dan tidak memengaruhi perilaku Agent.

---

## 4. Hubungkan kanal WeChat

Masuk ke tombol "Kanal", pilih "WeChat" dari dropdown, lalu klik "Izinkan akses". Kode QR akan muncul.

![](./images/2-6.webp)

Gunakan fitur "Pindai" di WeChat pada ponsel Anda untuk memindai kode QR, lalu ikuti instruksi di ponsel sampai otorisasi selesai. Setelah berhasil, dialog akan tertutup otomatis, catatan "WeChat" muncul di area "Kanal terhubung", dan akun bot otomatis ditambahkan ke kontak WeChat Anda.

> ⚠️ **Setelah memindai**
>
> Setelah pemindaian, WeChat akan meminta Anda menambahkan akun bot. Setelah ditambahkan, chat dengan akun tersebut sama dengan chat dengan Hermes.

Untuk detail lebih lanjut, lihat [Ringkasan Konfigurasi](./05-configuration.md#1-kanal).

---

## 5. Kirim pesan pertama

Cari akun bot yang sudah ditambahkan di WeChat, lalu kirim pesan uji:

```
Hi
```

![](./images/2-7.webp)

Anda seharusnya menerima balasan dari Hermes dalam beberapa detik. Sekarang Hermes sudah bisa diajak chat lewat WeChat.

> 💡 **Penagihan pesan**
>
> Secara default, panggilan model memakai 100 kredit uji coba yang termasuk dalam paket Launch, jadi tidak perlu konfigurasi tambahan. Setelah kredit habis, atur API Key Anda sendiri di kartu "1. Model". Lihat [Ringkasan Konfigurasi](./05-configuration.md#2-model).

---

## Lanjutan: atur model sendiri (opsional)

Jika Anda perlu memakai model dari penyedia tertentu, atau ingin terus memakai Hermes setelah kredit habis, buka kartu "1. Model" di konsol, pilih sumber dan model, masukkan API Key, lalu klik "Jadikan default". Lihat [Ringkasan Konfigurasi](./05-configuration.md#2-model) untuk alur lengkapnya.

---

## FAQ

| Masalah | Kemungkinan penyebab | Solusi |
|---|---|---|
| Tidak bisa mengaktifkan paket Launch | Promo atau alur pembayaran saat ini belum tersedia | Periksa [halaman Subscribe](/subscribe) dan ikuti pembaruan resmi |
| Pembuatan Hermes tertahan lama di halaman transisi | Inisialisasi cloud lambat atau jaringan tidak stabil | Muat ulang halaman; jika belum ada respons setelah 1 menit, klik "+ Buat Hermes" lagi |
| Tidak ada respons di konsol setelah memindai kode QR WeChat | Kode QR sudah kedaluwarsa | Tutup dialog, lalu klik "Izinkan akses" lagi untuk membuat kode QR baru |
| Tidak ada balasan setelah mengirim pesan | Kredit uji coba habis atau kanal belum terhubung | Periksa status "Kanal terhubung"; atur API Key sendiri setelah kredit habis |
| Kontak bot hilang dari WeChat | Otorisasi dicabut atau akses terputus | Kembali ke konsol dan lakukan otorisasi ulang di kartu "Kanal" |

---

## Langkah berikutnya

- [Konsep Inti](./04-core-concepts.md) — Pahami empat konsep utama: Hermes, model, kanal, dan Skill

- [Ringkasan Konfigurasi](./05-configuration.md) — Struktur umum konsol

- [Ringkasan Konfigurasi](./05-configuration.md#3-skill) — Perluas kemampuan Hermes lewat SkillHub
