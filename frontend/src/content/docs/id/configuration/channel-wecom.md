# Kanal WeCom

Kanal WeCom memakai akses kode QR dan merupakan kanal yang paling sederhana untuk dikonfigurasi.

## Yang dibahas di halaman ini

- Membuat kode QR akses WeCom di LightVela

- Memindai kode QR tersebut dengan WeCom di ponsel Anda

- Mengobrol dengan Hermes Agent di WeCom


> 💡 **Prasyarat**
>
> -   Ponsel yang sudah memasang WeCom
>
> -   Menyelesaikan [konfigurasi model](./model.md) (atau memakai 100 kredit uji coba yang termasuk dalam paket Launch)
>

---

## Langkah-langkah

### 1. Masuk ke konsol

Masuk ke LightVela, klik "My Hermes" di kanan atas untuk membuka konsol, lalu temukan tombol "Channel".

### 2. Pilih kanal WeCom

Temukan modul WeCom lalu klik "+ Connect".

### 3. Klik "Authorize Access"

Sebuah kode QR akan muncul di halaman tersebut.

![](../images/wecom1-en.webp)

> ⚠️ **Masa berlaku kode QR**
>
> Kode QR akan kedaluwarsa setelah beberapa menit. Jika kedaluwarsa, tutup dialog tersebut lalu klik "Authorize Access" lagi untuk membuat kode QR baru.

### 4. Pindai dengan WeCom di ponsel Anda

1. Buka WeCom di ponsel Anda

2. Ketuk "+" di kanan atas → "Scan"

3. Pindai kode QR di layar komputer Anda


![](../images/wecom2.webp)

4. Ikuti petunjuk di ponsel Anda untuk menyelesaikan otorisasi

![](../images/wecom3.webp)

![](../images/wecom4.webp)

### 5. Mengobrol dengan bot yang sudah dibuat

Setelah pemindaian berhasil:

- Dialog akan tertutup otomatis dan Anda akan diarahkan ke halaman bot yang sudah dibuat

- WeCom otomatis menambahkan bot tersebut ke kontak Anda


Buka jendela percakapan bot tersebut lalu kirim pesan uji:

```
Hello
```

Anda akan menerima balasan Hermes Agent dalam beberapa detik.

![](../images/wecom5-en.webp)

---

## Kondisi berhasil

- Entri "WeCom" muncul di daftar "Connected Channels" pada konsol

- Bot tersebut dapat ditemukan di kontak WeCom Anda

- Mengirim pesan akan mendapat balasan Hermes Agent


---

## Jenis pesan yang didukung

Setelah integrasi, bot WeCom mendukung lebih dari teks dasar. Daftar lengkapnya:

| Bot WeCom — jenis pesan yang didukung | Didukung |
| --- | --- |
| Menerima pesan teks | ✅ Ya |
| Menerima gambar / video | ✅ Ya |
| Menerima file | ✅ Ya |
| Menerima pesan suara | ✅ Ya |
| Membalas dengan pesan teks | ✅ Ya |
| Membalas dengan gambar / video | ✅ Ya |
| Membalas dengan file | ✅ Ya |
| Mengirim pesan secara proaktif (misalnya pengingat terjadwal) | ✅ Ya |

> ℹ️ **Kemampuan sebenarnya bergantung pada model**
>
> Tabel di atas hanya mencerminkan apa yang dapat diterima dan dibalas bot WeCom pada lapisan kanal. Apakah tugas seperti pemrosesan gambar / file benar-benar berfungsi bergantung pada apakah LLM yang terhubung ke Hermes Agent mendukung kemampuan tersebut.

---

## FAQ

| Gejala | Kemungkinan penyebab | Penyelesaian |
| --- | --- | --- |
| WeCom menampilkan "Invalid QR code" setelah pemindaian | Kode QR sudah kedaluwarsa | Tutup dialog tersebut lalu klik "Authorize Access" lagi |
| Tidak ada respons di desktop setelah pemindaian | Keterlambatan jaringan atau otorisasi belum selesai | Segarkan halaman konsol untuk memastikan statusnya; jika belum terhubung, coba lagi |
| Kontak bot tidak ditemukan di WeCom | Pesannya terlipat di bawah "Service Notifications" | Cari "LightVela" atau nama Hermes Agent Anda dari bagian atas WeCom |
| Tidak ada balasan setelah mengirim pesan | Model belum dikonfigurasi atau kredit uji coba habis | Periksa status "Current Model" di kartu "1. Model" |
| Cara memutuskan koneksi | — | Hapus entri tersebut dari daftar "Connected Channels" |
| Apakah satu akun WeCom dapat terhubung ke beberapa instans Hermes Agent | Paket Launch membatasi Anda pada 1 Hermes Agent | Tidak berlaku |

---

## Catatan kanal

- **Jenis pesan**: Teks, gambar, video, file, suara, dan lainnya — lihat "Jenis pesan yang didukung" di atas

- **Dukungan chat grup**: Chat grup belum didukung untuk saat ini; hanya percakapan satu lawan satu yang berfungsi

- **Koneksi terputus**: Periode tanpa respons yang lama biasanya berarti otorisasi sudah dicabut — berikan otorisasi ulang dari konsol


---

## Langkah berikutnya

- [Kanal Lark](./channel-feishu.md) — Skenario perkantoran dengan rich text dan chat grup

- [Konfigurasi Skill](./skill.md) — Perluas kemampuan Hermes Agent
