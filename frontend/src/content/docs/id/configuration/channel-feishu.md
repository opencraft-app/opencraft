# Kanal Lark

## Ringkasan

**Kanal Lark cocok untuk lingkungan kerja, mendukung pesan rich text dan @mention bot di obrolan grup, serta dihubungkan dengan cara yang sama seperti WeChat: pilih Lark di bagian Kanal pada konsol, klik untuk memberi otorisasi dan menghasilkan kode QR, lalu pindai dengan Lark untuk mulai berbicara. Anda memerlukan Lark di ponsel (atau sudah masuk di desktop) dan model yang sudah dikonfigurasi (atau cukup kredit model bulanan dari paket Anda). Satu Agent dapat terhubung ke beberapa kanal sekaligus dengan persona dan memori jangka panjang yang sama.**

---

Kanal Lark cocok untuk skenario perkantoran. Kanal ini mendukung pesan rich text dan mention bot di chat grup. Integrasinya memakai otorisasi kode QR, serupa dengan WeChat.

## Yang dibahas di halaman ini

- Membuat kode QR akses Lark di LightVela

- Memindai kode QR tersebut dengan Lark untuk memberi otorisasi

- Mengobrol dengan Hermes Agent di Lark


> 💡 **Prasyarat**
>
> -   Ponsel yang sudah memasang Lark (atau Lark desktop yang sudah login)
>
> -   Menyelesaikan [konfigurasi model](./model.md) (atau memakai 100 kredit uji coba yang termasuk dalam paket Launch)
>

---

## Langkah-langkah

### 1. Masuk ke konsol

Masuk ke LightVela, klik "My Hermes" di kanan atas untuk membuka konsol, lalu temukan tombol "Channel".

### 2. Pilih kanal Lark

Klik dropdown lalu pilih "Lark". Pengantar kanal Lark akan muncul di bawahnya.

### 3. Klik "Authorize Access"

Sebuah kode QR akan muncul di halaman tersebut.

![](../images/lark1.webp)

### 4. Pindai dengan Lark

**Di ponsel:**

1. Buka Lark

2. Ketuk "+" di kanan atas → "Scan"

3. Pindai kode QR di layar komputer Anda

4. Ikuti petunjuk untuk menyelesaikan otorisasi


![](../images/lark2.webp)

### 5. Temukan Hermes Agent di Lark

Setelah pemindaian berhasil:

- Entri "Lark" muncul di daftar "Connected Channels" pada konsol

- Lark otomatis menambahkan bot tersebut ke kontak Anda


Cari di Lark dengan nama aplikasi yang Anda buat.

![](../images/lark3.webp)

Buka jendela percakapan bot tersebut lalu kirim pesan uji:

```
Hello
```

![](../images/lark4.webp)

## Kondisi berhasil

- Entri "Lark" muncul di daftar "Connected Channels" pada konsol

- Bot tersebut dapat ditemukan melalui pencarian Lark

- Mengirim pesan akan mendapat balasan Hermes Agent


---

## Jenis pesan yang didukung

Setelah integrasi, bot Lark mendukung lebih dari teks dasar. Daftar lengkapnya:

| Bot Lark — jenis pesan dan fitur yang didukung | Didukung |
| --- | --- |
| Menerima pesan teks | ✅ Ya |
| Menerima gambar | ✅ Ya |
| Menerima file | ✅ Ya |
| Menerima audio / video | ✅ Ya |
| Membalas dengan pesan teks | ✅ Ya |
| Membalas dengan gambar | ✅ Ya |
| Membalas dengan file | ✅ Ya |
| Membalas dengan audio | ✅ Ya |
| Isi balasan mendukung Markdown | ✅ Ya |
| Mengirim pesan secara proaktif (misalnya pengingat terjadwal) | ✅ Ya |
| Mengoperasikan Lark Docs, Wiki, Drive | ✅ Ya |

> ℹ️ **Kemampuan sebenarnya bergantung pada model**
>
> Tabel di atas hanya mencerminkan apa yang dapat diterima dan dibalas bot Lark pada lapisan kanal. Apakah tugas seperti pemrosesan gambar / file benar-benar berfungsi bergantung pada apakah LLM yang terhubung ke Hermes Agent mendukung kemampuan tersebut.

---

## FAQ

| Gejala | Kemungkinan penyebab | Penyelesaian |
| --- | --- | --- |
| Pemindaian menampilkan "Application not authorized" | Admin tenant membatasi aplikasi pihak ketiga | Minta admin tenant Anda mengizinkan aplikasi tersebut, atau beralih ke tenant pribadi |
| Kontak bot tidak ditemukan | Lark melipat bot secara default | Cari nama aplikasi Hermes Agent dari bagian atas Lark |
| Cara menambahkan bot ke grup | — | Di pengaturan grup, pilih "Add Members", cari bot tersebut lalu tambahkan |
| Kode QR kedaluwarsa | Tidak dipindai dalam masa berlakunya | Tutup dialog tersebut lalu klik "Authorize Access" lagi |
| Tidak ada balasan setelah mengirim pesan | Model belum dikonfigurasi atau kredit uji coba habis | Periksa status "Current Model" |
| Masalah rendering rich text | Lark tidak mendukung sebagian sintaks Markdown | Percakapan teks biasa tidak terpengaruh |

---

## Catatan kanal

- **Jenis pesan**: Teks, rich text, gambar, file, audio, video, dan lainnya — lihat "Jenis pesan yang didukung" di atas

- **Dukungan chat grup**: Bot dapat ditambahkan ke chat grup dan akan merespons ketika disebut dengan @mention

- **Batasan tenant**: Apakah tenant Lark perusahaan mengizinkan bot pihak ketiga bergantung pada kebijakan admin tenant


---

## Langkah berikutnya

- [Konfigurasi Skill](./skill.md) — Perluas kemampuan Hermes Agent
