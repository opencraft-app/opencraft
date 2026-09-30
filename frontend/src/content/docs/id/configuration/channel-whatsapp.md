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

Masuk ke LightVela, buka Agent yang dituju, lalu pilih **Channels** di sidebar.

### 2. Pilih kanal WhatsApp

Temukan kartu WhatsApp lalu klik "+ Connect".

Dalam satu instance LightVela, WhatsApp hanya dapat terhubung ke satu Bot dalam satu waktu. Jika sudah terhubung ke Bot lain, buka Bot tersebut dari pemberitahuan dan putuskan WhatsApp sebelum menghubungkannya di sini.

### 3. Pindai kode QR di WhatsApp

Gunakan WhatsApp di ponsel untuk memindai kode yang ditampilkan LightVela, lalu ikuti petunjuk di WhatsApp untuk mengotorisasi sesi tertaut. Jika kode kedaluwarsa, buat kode baru dari kartu WhatsApp. Kembali ke **Channels** dan pastikan WhatsApp ditampilkan sebagai terhubung.

### 4. Temukan diri Anda sendiri di WhatsApp

![](../../images/whatsapp-2-global.webp)

Mengobrol dengan diri sendiri — itulah bot Anda.

Buka percakapan dengan bot tersebut lalu kirim pesan uji:

```
Hi
```

Anda semestinya menerima balasan Hermes Agent dalam beberapa detik.

![](../../images/whatsapp-3-global-en.webp)

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

| Masalah | Periksa | Tindakan |
|---|---|---|
| Kode QR gagal dipindai atau kedaluwarsa | Koneksi ponsel dan kode saat ini | Buat kode baru dari kartu WhatsApp dan ikuti petunjuk terbaru di aplikasinya. |
| Koneksi tidak muncul | Apakah otorisasi selesai di ponsel | Kembali ke **Channels**, muat ulang sekali, lalu hubungkan kembali jika masih terputus. |
| Pesan tidak dibalas | Status Agent, kanal, dan kredit model | Periksa **Channels** dan [Diagnostics](./diagnostics.md); lihat [opsi kredit](../credits.md) jika perlu. |
| Pesan terjadwal tidak tiba | Koneksi kanal dan hasil tugas | Periksa eksekusi terakhir di [Scheduled Tasks](./automation.md) dan tujuan notifikasinya. |
| WhatsApp dimiliki Bot lain | Satu instans hanya mengizinkan satu Bot terhubung ke WhatsApp | Putuskan dari Bot sebelumnya sebelum menghubungkan Bot lain. |

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
