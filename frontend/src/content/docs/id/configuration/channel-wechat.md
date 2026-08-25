# Kanal WeChat

## Ringkasan

**Kanal WeChat dihubungkan dengan memindai kode QR dan merupakan yang paling sederhana di antara semua kanal: pilih WeChat di bagian Kanal pada konsol, klik untuk memberi otorisasi dan menghasilkan kode QR, lalu pindai dengan WeChat di ponsel Anda untuk mulai berbicara. Anda hanya memerlukan dua hal — ponsel dengan WeChat terpasang, dan model yang sudah dikonfigurasi (atau cukup kredit model bulanan dari paket Anda). Satu Agent dapat terhubung ke beberapa kanal sekaligus, dan semuanya berbagi persona serta memori jangka panjang yang sama.**

---

Kanal WeChat memakai akses kode QR dan merupakan kanal yang paling sederhana untuk dikonfigurasi.

## Yang dibahas di halaman ini

- Membuat kode QR akses WeChat di LightVela

- Memindai kode QR tersebut dengan WeChat di ponsel Anda

- Mengobrol dengan Hermes Agent di WeChat


> 💡 **Prasyarat**
>
> -   Ponsel yang sudah memasang WeChat
>
> -   Menyelesaikan [konfigurasi model](./model.md) (atau memakai 100 kredit uji coba yang termasuk dalam paket Launch)
>

---

## Langkah-langkah

### 1. Masuk ke konsol

Masuk ke LightVela, klik "My Hermes" di kanan atas untuk membuka konsol, lalu temukan tombol "Channel".

### 2. Pilih kanal WeChat

Klik dropdown lalu pilih "WeChat". Pengantar kanal WeChat dan tautan "View Details" akan muncul di bawahnya.

### 3. Klik "Authorize Access"

Sebuah kode QR akan muncul di halaman tersebut.

![](../images/20260424-142558-0pl3.webp)

> ⚠️ **Masa berlaku kode QR**
>
> Kode QR akan kedaluwarsa setelah beberapa menit. Jika kedaluwarsa, tutup dialog tersebut lalu klik "Authorize Access" lagi untuk membuat kode QR baru.

### 4. Pindai dengan WeChat di ponsel Anda

1. Buka WeChat di ponsel Anda

2. Ketuk "+" di kanan atas → "Scan"

3. Pindai kode QR di layar komputer Anda

4. Ikuti petunjuk di ponsel Anda untuk menyelesaikan otorisasi


### 5. Temukan Hermes Agent di WeChat

Setelah pemindaian berhasil:

- Dialog akan tertutup otomatis, dan catatan "WeChat" ditambahkan ke daftar "Connected channels" di konsol

- WeChat otomatis menambahkan akun bot tersebut


Buka percakapan dengan bot itu lalu kirim pesan uji:

```
Hi
```

Anda semestinya menerima balasan Hermes Agent dalam beberapa detik.

![](../images/6.1-2.webp)

---

## Kondisi berhasil

- Daftar "Connected channels" di konsol memuat "WeChat"

- Bot terkait dapat ditemukan di kontak WeChat

- Hermes Agent membalas setelah Anda mengirim pesan


---

## Jenis pesan yang didukung

Setelah akses berhasil, bot WeChat dapat menerima dan membalas pesan teks dasar serta mendukung lebih banyak jenis pesan berikut:

| Jenis pesan yang didukung bot WeChat | Didukung |
|---|---|
| Menerima pesan teks | ✅ Didukung |
| Menerima gambar dan video | ✅ Didukung |
| Menerima file | ✅ Didukung |
| Menerima pesan suara | ✅ Didukung |
| Membalas dengan pesan teks | ✅ Didukung |
| Membalas dengan gambar dan video | ✅ Didukung |
| Membalas dengan file | ✅ Didukung |
| Mengirim pesan secara proaktif (seperti pengingat terjadwal) | ✅ Didukung |

> ℹ️ **Kemampuan pemrosesan sebenarnya bergantung pada model**
>
> Tabel di atas hanya menunjukkan jenis pesan yang didukung bot WeChat pada lapisan kanal. Apakah gambar, file, dan tugas lain benar-benar dapat diproses juga bergantung pada apakah large language model yang terhubung ke Hermes Agent memiliki kemampuan terkait.

---

## FAQ

| Masalah | Kemungkinan penyebab | Solusi |
|---|---|---|
| WeChat menampilkan "invalid QR code" setelah pemindaian | Kode QR sudah kedaluwarsa | Tutup dialog tersebut lalu klik "Authorize Access" lagi |
| Tidak ada respons di komputer setelah pemindaian | Keterlambatan jaringan atau otorisasi belum selesai | Segarkan konsol untuk memastikan status; jika akses belum berhasil, coba lagi |
| Kontak bot tidak dapat ditemukan di WeChat | Pesannya terlipat ke dalam "Service Notifications" | Cari "LightVela" atau nama Hermes Agent tersebut di bagian atas WeChat |
| Tidak ada balasan setelah mengirim pesan | Model belum dikonfigurasi atau kredit uji coba sudah habis | Periksa status "Current model" di kartu "1. Model" |
| Cara memutuskan tautan | — | Hapus catatan terkait di daftar "Connected channels" |
| Apakah satu akun WeChat yang sama dapat terhubung ke beberapa instans Hermes Agent | Batas paket Launch adalah 1 Hermes Agent | Tidak berlaku |

---

## Catatan kanal

- **Jenis pesan**: Mendukung teks, gambar, video, file, pesan suara, dan lainnya. Lihat "Jenis pesan yang didukung" di atas

- **Dukungan chat grup**: Chat grup belum didukung saat ini; hanya percakapan satu lawan satu yang didukung

- **Koneksi terputus**: Tidak ada respons dalam waktu lama dapat menandakan otorisasi sudah dicabut. Kembali ke konsol lalu berikan otorisasi akses lagi


---

## Langkah berikutnya

- [Kanal Telegram](./channel-telegram.md) — Notifikasi ringan dan komunikasi lintas platform

- [Kanal WhatsApp](./channel-whatsapp.md) — Komunikasi pengguna internasional dan layanan pelanggan

- [Kanal Discord](./channel-discord.md) — Operasional komunitas dan komunitas developer

- [Kanal Slack](./channel-slack.md) — Kolaborasi tim, notifikasi workspace, dan alur kerja kanal

- [Konfigurasi Skill](./skill.md) — Perluas kemampuan Hermes Agent
