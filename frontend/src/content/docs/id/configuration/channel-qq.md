# Kanal QQ

## Ringkasan

**Kanal QQ adalah satu-satunya yang memerlukan pengisian parameter secara manual: buat bot di QQ Open Platform, ambil AppID dan AppSecret-nya, lalu tempelkan ke bagian Kanal pada konsol LightVela. Prosesnya sekitar 5–10 menit. Anda memerlukan akun QQ sebagai administrator bot dan model yang sudah dikonfigurasi (atau cukup kredit model bulanan dari paket Anda). Sebagai perbandingan, WeChat, WeCom, dan Lark semuanya cukup dihubungkan dengan memindai kode QR. Setelah terhubung, Agent di QQ berbagi persona dan memori jangka panjang yang sama dengan kanal lain.**

---

Kanal QQ memerlukan pembuatan bot di QQ Open Platform, lalu memasukkan **AppID** dan **AppSecret** yang dihasilkan ke LightVela. Seluruh prosesnya memakan waktu sekitar 5–10 menit.

## Yang dibahas di halaman ini

- Mendaftar dan membuat bot di QQ Open Platform

- Mendapatkan AppID dan AppSecret

- Memasukkan kredensial tersebut ke LightVela untuk menyelesaikan integrasi

- Mengobrol dengan Hermes Agent di QQ


> 💡 **Prasyarat**
>
> -   Akun QQ (untuk berperan sebagai administrator bot)
>
> -   Menyelesaikan [konfigurasi model](./model.md) (atau memakai 100 kredit uji coba yang termasuk dalam paket Launch)
>

---

## Langkah-langkah

### 1. Masuk ke konsol

Masuk ke LightVela, klik "My Hermes" di kanan atas untuk membuka konsol, lalu temukan tombol "Channel".

### 2. Pilih kanal QQ

Klik dropdown lalu pilih "QQ". Pengantar kanal QQ akan muncul di bawahnya.

![](../images/qq1.webp)

### 3. Daftar di QQ Open Platform

Kunjungi [QQ Open Platform](https://q.qq.com/qqbot/openclaw/) lalu pindai kode QR di halaman tersebut memakai aplikasi QQ di ponsel untuk mendaftar / masuk. Pada kunjungan pertama, pemindaian akan otomatis mendaftarkan dan mengikat akun QQ saat ini ke akun Open Platform.

Setelah memindai di aplikasi QQ ponsel dan memilih **Agree**, pendaftaran selesai dan Anda akan masuk ke halaman konfigurasi bot QQ.

### 4. Buat bot QQ

Di halaman daftar bot pada QQ Open Platform, klik "Create Bot" untuk membuat bot QQ baru.

![](../images/qq2.webp)

### 5. Dapatkan AppID dan AppSecret

Setelah bot dibuat, temukan **AppID** dan **AppSecret** di halaman tersebut. Klik tombol "Copy" di sebelah masing-masing lalu simpan ke file catatan lokal.

![](../images/qq3.webp)

> ⚠️ **AppSecret adalah kredensial sensitif**
>
> -   Untuk alasan keamanan, **AppSecret tidak dapat dilihat lagi dalam bentuk plaintext — melihatnya kembali akan memaksa reset**. Simpan segera saat pertama kali dibuat.
>
> -   Jangan menempelkannya ke grup chat, halaman web publik, atau meng-commit-nya ke repositori Git.
>
> -   Jika bocor, segera reset di QQ Open Platform melalui "Reset Secret", lalu masukkan kembali kredensial baru tersebut ke LightVela.
>

Setelah dibuat, QQ otomatis menambahkan bot tersebut ke daftar pesan Anda dan mengirim pesan sambutan. Pada tahap ini, bot belum terikat ke LightVela; mengirim pesan akan menghasilkan balasan "This bot has gone to Mars, try again later" — ini normal, lanjutkan ke langkah berikutnya.

### 6. Masukkan kredensial di LightVela

Kembali ke kartu "Channel" di konsol, pilih "QQ" dari dropdown, lalu tempel kredensial yang baru Anda salin:

1. **AppID**: tempel AppID yang sudah disalin

2. **AppSecret**: tempel AppSecret yang sudah disalin


![](../images/qq4.webp)

### 7. Klik "Add and Apply"

LightVela memakai kredensial di atas untuk menghubungkan bot di QQ Open Platform. Setelah beberapa puluh detik, halaman akan menampilkan "Saved successfully", dan entri "QQ" muncul di daftar "Connected Channels".

### 8. Temukan Hermes Agent di QQ

Buka QQ, temukan bot yang baru Anda buat, lalu kirim pesan uji:

```
Hello
```

Anda akan menerima balasan Hermes Agent dalam beberapa detik.

![](../images/qq5.webp)

> ✅ **Mention di grup QQ didukung**
>
> Setelah pengikatan QQ berhasil, LightVela mengaktifkan kebijakan chat grup QQ milik Hermes secara default. Tambahkan bot tersebut ke grup QQ, lalu sebut bot itu dengan mention untuk memulai percakapan. Kebijakan defaultnya adalah `open`, yang berarti anggota grup QQ yang memuat bot tersebut dapat menyebutnya dengan mention untuk mengobrol. Pesan grup biasa tanpa mention tidak memicu percakapan.

## Kondisi berhasil

- Bot sudah dibuat di QQ Open Platform

- Entri "QQ" muncul di daftar "Connected Channels" pada konsol

- Bot di QQ membalas dengan benar memakai AI

- Bot membalas di grup QQ ketika disebut dengan mention


---

## Jenis pesan yang didukung

Setelah integrasi, bot QQ mendukung lebih dari teks dasar. Daftar lengkapnya:

| Bot QQ — jenis pesan dan fitur yang didukung | Didukung |
| --- | --- |
| Menerima pesan teks | ✅ Ya |
| Menerima gambar | ✅ Ya |
| Menerima file | ✅ Ya |
| Menerima pesan suara | ✅ Ya |
| Membalas dengan pesan teks | ✅ Ya |
| Membalas dengan gambar | ✅ Ya |
| Membalas dengan file | ✅ Ya |
| Isi balasan mendukung Markdown | ✅ Ya |
| Mengirim pesan secara proaktif (misalnya pengingat terjadwal) | ✅ Ya |
| Mengutip pesan lama | ❌ Belum |

> ℹ️ **Kemampuan sebenarnya bergantung pada model**
>
> Tabel di atas hanya mencerminkan apa yang dapat diterima dan dibalas bot QQ pada lapisan kanal. Apakah tugas seperti pemrosesan gambar / file benar-benar berfungsi bergantung pada apakah LLM yang terhubung ke Hermes Agent mendukung kemampuan tersebut.

---

## FAQ

| Gejala | Kemungkinan penyebab | Penyelesaian |
| --- | --- | --- |
| Bot membalas "My 'soul' is offline, please check your host service deployment" | AppID / AppSecret belum dikonfigurasi di LightVela, atau kredensialnya salah | Salin ulang parameter dari QQ Open Platform, pastikan tidak ada spasi di awal / akhir, lalu masukkan kembali di LightVela |
| Bot membalas "This bot has gone to Mars, try again later" | Bot QQ sudah dibuat tetapi belum terikat ke LightVela | Ikuti halaman ini untuk memasukkan AppID / AppSecret |
| Bot masih tidak membalas setelah semua konfigurasi | Model belum dikonfigurasi atau kredit uji coba habis | Periksa status "Current Model" di kartu "1. Model" |
| AppSecret tidak dapat ditemukan | AppSecret hanya terlihat saat pembuatan | Klik "Reset Secret" di QQ Open Platform untuk membuat nilai baru, lalu masukkan kembali di LightVela |
| AppSecret bocor | — | Buka "Reset Secret" di QQ Open Platform, lalu masukkan AppSecret baru tersebut di LightVela |
| Kode QR kedaluwarsa | Tidak dipindai dalam masa berlakunya | Tutup dialog tersebut lalu klik "Authorize Access" lagi |

---

## Catatan kanal

- **Jenis pesan**: Teks, gambar, file, suara, dan lainnya — lihat "Jenis pesan yang didukung" di atas

- **Dukungan chat grup**: Mention di grup aktif secara default setelah pengikatan. Konsol menerapkan kebijakan `open`, yang mengizinkan anggota grup QQ yang memuat bot tersebut menyebutnya dengan mention untuk mengobrol. Untuk membatasi akses ke grup tertentu saja, ubah konfigurasi instans Hermes ke `allowlist` lalu kelola daftar izinnya di sana; kartu kanal belum menyediakan pengalih ini

- **Pengelolaan kredensial**: AppSecret hanya terlihat dalam bentuk plaintext saat pembuatan; jika hilang atau bocor, kredensial tersebut harus direset


---

## Langkah berikutnya

- [Kanal WeCom](./channel-wecom.md) — Kolaborasi internal perusahaan dan skenario perkantoran

- [Kanal Lark](./channel-feishu.md) — Skenario perkantoran dengan rich text dan chat grup

- [Konfigurasi Skill](./skill.md) — Perluas kemampuan Hermes Agent
