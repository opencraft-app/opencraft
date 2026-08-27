# Kanal WhatsApp

## Ringkasan

**Kanal WhatsApp dihubungkan dengan memindai kode QR, mirip WeChat, sehingga menjadi cara cepat membawa Hermes Agent ke percakapan WhatsApp: pilih WhatsApp di bagian Kanal pada konsol, hasilkan kode QR, lalu pindai dengan WhatsApp di ponsel Anda untuk mulai berbicara. Anda memerlukan ponsel dengan WhatsApp terpasang dan model yang sudah dikonfigurasi (atau cukup kredit model bulanan dari paket Anda). Satu Agent dapat terhubung ke beberapa kanal sekaligus dengan persona dan memori jangka panjang yang sama.**

---

Kanal WhatsApp memakai akses kode QR, serupa dengan WeChat, dan cocok untuk menghubungkan Hermes Agent dengan cepat ke percakapan WhatsApp.

## Yang dibahas di halaman ini

- Memindai kode QR dengan WhatsApp di ponsel Anda untuk memberi otorisasi akses

- Mengobrol dengan Hermes Agent di WhatsApp


> 💡 **Prasyarat**
>
> -   Ponsel yang sudah memasang WhatsApp
>
> -   Menyelesaikan [konfigurasi model](./model.md) (atau memakai 100 kredit uji coba yang termasuk dalam paket Launch)
>

---

## Langkah-langkah

### 1. Masuk ke konsol

Masuk ke LightVela, klik "My Hermes" di kanan atas untuk membuka konsol, lalu temukan tombol "Channel".

### 2. Pilih kanal WhatsApp

Temukan kartu WhatsApp lalu klik "+ Connect".

### 3. Pindai kode QR dengan WhatsApp di ponsel Anda

1. Buka WhatsApp di ponsel Anda

2. Ketuk tombol "Camera" di kanan atas

3. Pindai kode QR di layar komputer Anda

![](../images/whatsapp-1-global-en.webp)

4. Ikuti petunjuk di ponsel Anda untuk menyelesaikan koneksi

### 4. Temukan diri Anda sendiri di WhatsApp

![](../images/whatsapp-2-global.webp)

Mengobrol dengan diri sendiri — itulah bot Anda.

Buka percakapan dengan bot tersebut lalu kirim pesan uji:

```
Hi
```

Anda semestinya menerima balasan Hermes Agent dalam beberapa detik.

![](../images/whatsapp-3-global-en.webp)

---

## Kondisi berhasil

- Daftar "Connected channels" di konsol memuat "WhatsApp"

- Bot terkait dapat ditemukan di kontak WhatsApp

- Hermes Agent membalas setelah Anda mengirim pesan


---

## Jenis pesan yang didukung

Setelah akses berhasil, bot WhatsApp dapat menerima dan membalas pesan teks dasar serta mendukung lebih banyak jenis pesan berikut:

| Jenis pesan yang didukung bot WhatsApp | Didukung |
|---|---|
| Menerima pesan teks | ✅ Didukung |
| Menerima gambar dan video | ✅ Didukung |
| Menerima file | ✅ Didukung |
| Membalas dengan pesan teks | ✅ Didukung |
| Membalas dengan gambar dan video | ✅ Didukung |
| Membalas dengan file | ✅ Didukung |
| Mengirim pesan secara proaktif (seperti pengingat terjadwal) | ✅ Didukung |

> ℹ️ **Kemampuan pemrosesan sebenarnya bergantung pada model**
>
> Tabel di atas hanya menunjukkan jenis pesan yang didukung bot WhatsApp pada lapisan kanal. Apakah gambar, file, dan tugas lain benar-benar dapat diproses juga bergantung pada apakah large language model yang terhubung ke Hermes Agent memiliki kemampuan terkait.

---

## FAQ

| Masalah | Kemungkinan penyebab | Solusi |
|---|---|---|
| Tidak dapat terhubung ke WhatsApp | Format nomor telepon salah, atau konfigurasi WhatsApp Business belum lengkap | Gunakan format internasional lengkap seperti +1 atau +86, dan periksa apakah konfigurasi WhatsApp Business / Meta sudah lengkap |
| Kode verifikasi tidak diterima | Nomor telepon tidak tersedia, keterlambatan jaringan, atau batasan verifikasi WhatsApp | Pastikan nomor telepon tersebut dapat menerima pesan WhatsApp; tunggu beberapa menit lalu coba lagi |
| Kode verifikasi dianggap tidak valid setelah dimasukkan | Kode kedaluwarsa atau dimasukkan dengan salah | Minta kode baru dan pastikan tidak ada spasi tambahan |
| Tidak ada respons di konsol setelah akses | Otorisasi atau konfigurasi belum selesai disinkronkan | Segarkan konsol untuk memastikan status; jika akses belum berhasil, coba lagi |
| Kontak bot tidak dapat ditemukan di WhatsApp | Nomor bot belum disimpan, atau percakapan belum dimulai | Simpan nomor bot tersebut, atau buka percakapan lewat tautan / kode QR yang diberikan konsol |
| Tidak ada balasan setelah mengirim pesan | Model belum dikonfigurasi, kredit uji coba habis, atau kanal WhatsApp belum berhasil terhubung | Periksa status "Current model" di kartu "1. Model" dan pastikan kanal WhatsApp tampil sebagai terhubung |
| Tidak dapat menerima gambar, file, atau pesan suara | Batasan izin media, format, atau kemampuan kanal | Pastikan jenis file tersebut didukung; jika suara tidak dapat dikenali, periksa apakah speech-to-text / pemrosesan media sudah diaktifkan |
| Pesan proaktif gagal terkirim | WhatsApp membatasi pesan proaktif melalui templat pesan dan jendela percakapan | Pastikan pengguna sudah memulai percakapan dengan bot; jika jendela percakapan sudah berakhir, gunakan templat pesan yang sudah disetujui |
| Cara memutuskan tautan | — | Hapus catatan WhatsApp terkait di daftar "Connected channels" |
| Apakah satu nomor WhatsApp yang sama dapat terhubung ke beberapa instans Hermes Agent | Tidak disarankan; satu nomor WhatsApp sebaiknya terikat pada satu Hermes Agent | Jika Anda memerlukan beberapa instans Hermes Agent, gunakan nomor WhatsApp terpisah |

---

## Catatan kanal

- **Jenis pesan**: Mendukung teks, gambar, video, file, pesan suara, dan lainnya. Lihat "Jenis pesan yang didukung" di atas

- **Dukungan chat grup**: Chat grup belum didukung saat ini; hanya percakapan satu lawan satu yang didukung

- **Koneksi terputus**: Tidak ada respons dalam waktu lama dapat menandakan otorisasi sudah dicabut. Kembali ke konsol lalu berikan otorisasi akses lagi

---

## Langkah berikutnya

- [Kanal Discord](./channel-discord.md) — Operasional komunitas dan komunitas developer

- [Kanal Slack](./channel-slack.md) — Kolaborasi tim, notifikasi workspace, dan alur kerja kanal

- [Kanal QQ](./channel-qq.md) — Bot dibuat manual, diintegrasikan via AppID/AppSecret

- [Kanal WeCom](./channel-wecom.md) — Kolaborasi internal perusahaan dan skenario perkantoran

- [Konfigurasi Skill](./skill.md) — Perluas kemampuan Hermes Agent
