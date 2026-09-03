# Kanal Telegram

## Ringkasan

**Kanal Telegram dihubungkan dengan bot token, sehingga menjadi cara cepat membawa Hermes Agent ke pesan pribadi atau grup Telegram: buat bot melalui BotFather di Telegram, salin bot token-nya, lalu tempelkan ke bagian Kanal pada konsol LightVela. Anda memerlukan akun Telegram dan model yang sudah dikonfigurasi (atau cukup kredit model bulanan dari paket Anda). Bot token adalah kredensial sensitif — jangan dibagikan secara publik. Setelah terhubung, Agent di Telegram berbagi persona dan memori jangka panjang yang sama dengan kanal lain.**

---

Kanal Telegram memakai akses Bot Token dan cocok untuk menghubungkan Hermes Agent dengan cepat ke chat pribadi atau grup Telegram.

## Yang dibahas di halaman ini

- Memberi otorisasi akses dengan memindai kode atau membuka tautan di Telegram pada ponsel Anda

- Mengobrol dengan Hermes Agent di Telegram


> 💡 **Prasyarat**
>
> -   Ponsel yang sudah memasang Telegram
>
> -   Menyelesaikan [konfigurasi model](./model.md) (atau memakai 100 kredit uji coba yang termasuk dalam paket Launch)
>

---

## Langkah-langkah

### 1. Masuk ke konsol

Masuk ke LightVela, klik "My Hermes" di kanan atas untuk membuka konsol, lalu temukan tombol "Channel".

### 2. Pilih kanal Telegram

Temukan kartu Telegram lalu klik "+ Connect".

### 3. Buka Telegram

1. Buka aplikasi Telegram di ponsel Anda

2. Cari @BotFather lalu buka percakapannya

<img src="../images/telegram-botfather-2-global.webp" alt="" width="360" />

3. Kirim `/start`

4. Kirim `/newbot`

5. Masukkan nama untuk Agent Anda: username harus unik dan diakhiri dengan "bot"

6. Salin HTTP API token:

![](../images/telegram-botfather-3-global.webp)


### 4. Tempel HTTP API token ke Telegram

Tempel HTTP API token tersebut ke kolom token.

<img src="../images/telegram-botfather-4-global.webp" alt="" width="360" />

> ⚠️ **Jaga keamanan token Anda**
>
> Simpan token dengan aman. Siapa pun yang memperoleh token tersebut dapat mengambil kendali atas bot Anda!

### 5. Mengobrol dengan bot baru di Telegram

Klik tautan yang diberikan BotFather lalu mulai berinteraksi dengan bot tersebut.

![](../images/telegram-botfather-5-global.webp)

Buka percakapan dengan bot tersebut lalu kirim pesan uji:

```
Hi
```

Anda semestinya menerima balasan Hermes Agent dalam beberapa detik.

<img src="../images/telegram-botfather-6-global-en.webp" alt="" width="360" />

### 6. Opsional: Aktifkan pesan grup di BotFather

Selesaikan langkah 6 dan 7 hanya jika Anda ingin menggunakan Bot di grup.
Pesan langsung sudah dapat digunakan setelah langkah 5.

1. Buka `@BotFather` di Telegram.
2. Kirim `/mybots`.
3. Pilih Bot yang sudah terhubung ke Hermes Agent Anda.
4. Buka "Bot Settings".
5. Pilih "Group Privacy".
6. Pilih "Turn off" atau "Disable privacy mode".

### 7. Opsional: Tambahkan dan uji Bot di grup

1. Buka grup Telegram yang ingin digunakan.
2. Pilih "Add Members" atau tindakan pengelolaan grup yang setara.
3. Cari Bot berdasarkan username-nya lalu tambahkan ke grup.
4. Sebut Bot dengan `@username_bot` lalu kirim pesan uji.

Setelah Group Privacy dinonaktifkan, bot dapat menerima dan membalas pesan grup yang menyebutnya.

---

## Kondisi berhasil

- Daftar "Connected channels" di konsol memuat "Telegram"

- Bot terkait dapat ditemukan di kontak Telegram

- Hermes Agent membalas setelah Anda mengirim pesan

- Hermes Agent membalas setelah Anda menyebut bot dan mengirim pesan di grup tempat bot telah ditambahkan


---

## Jenis pesan yang didukung

Setelah akses berhasil, bot Telegram dapat menerima dan membalas pesan teks dasar serta mendukung lebih banyak jenis pesan berikut:

| Jenis pesan yang didukung bot Telegram | Didukung |
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
> Tabel di atas hanya menunjukkan jenis pesan yang didukung bot Telegram pada lapisan kanal. Apakah gambar, file, dan tugas lain benar-benar dapat diproses juga bergantung pada apakah large language model yang terhubung ke Hermes Agent memiliki kemampuan terkait.

---

## FAQ

| Masalah | Kemungkinan penyebab | Solusi |
|---|---|---|
| BotFather tidak dapat membuat bot | Nama bot atau username tidak memenuhi ketentuan Telegram | Nama tampilan boleh apa saja, tetapi username harus diakhiri `bot`, misalnya `my_hermes_bot` |
| BotFather tidak mengembalikan HTTP API token | Alur pembuatan belum selesai | Kembali ke percakapan BotFather, jalankan `/newbot` lagi, lalu ikuti petunjuk untuk mengatur nama dan username |
| Token dianggap tidak valid setelah ditempel | Token tidak lengkap atau mengandung spasi / baris baru tambahan | Salin ulang HTTP API token secara lengkap dari BotFather lalu tempel ke kolom token |
| Tidak ada respons setelah mengklik akses | Keterlambatan jaringan atau otorisasi belum selesai | Segarkan konsol untuk memastikan status; jika akses belum berhasil, coba lagi |
| Bot tidak dapat ditemukan di Telegram | Anda belum mengklik tautan dari BotFather, atau belum memulai percakapan | Klik tautan yang diberikan BotFather, lalu klik Start di halaman bot |
| Tidak ada balasan setelah mengirim pesan | Model belum dikonfigurasi, kredit uji coba habis, atau bot belum berhasil terhubung | Periksa status "Current model" di kartu "1. Model" dan pastikan kanal Telegram tampil sebagai terhubung |
| Bot tidak dapat menerima pesan grup | Group Privacy masih aktif, bot belum ditambahkan ke grup, atau pesan tidak menyebut bot | Di BotFather, kirim `/mybots`, pilih bot, lalu buka "Bot Settings" → "Group Privacy" dan nonaktifkan privacy mode. Tambahkan bot ke grup dan kirim pesan uji dengan `@username_bot` |
| Cara memutuskan tautan | — | Hapus catatan Telegram terkait di daftar "Connected channels" |
| Apakah satu bot Telegram yang sama dapat terhubung ke beberapa instans Hermes Agent | Tidak disarankan; satu Bot Token sebaiknya terikat pada satu Hermes Agent | Jika Anda memerlukan beberapa instans Hermes Agent, buat bot Telegram terpisah |

---

## Catatan kanal

- **Jenis pesan**: Mendukung teks, gambar, video, file, pesan suara, dan lainnya. Lihat "Jenis pesan yang didukung" di atas

- **Dukungan chat grup**: Pesan grup didukung setelah Anda menonaktifkan Group Privacy di BotFather, menambahkan bot ke grup, dan memulai percakapan dengan `@username_bot`

- **Koneksi terputus**: Tidak ada respons dalam waktu lama dapat menandakan otorisasi sudah dicabut. Kembali ke konsol lalu berikan otorisasi akses lagi

---

## Langkah berikutnya

- [Kanal WhatsApp](./channel-whatsapp.md) — Komunikasi pengguna internasional dan layanan pelanggan

- [Kanal Discord](./channel-discord.md) — Operasional komunitas dan komunitas developer

- [Kanal Slack](./channel-slack.md) — Kolaborasi tim, notifikasi workspace, dan alur kerja kanal

- [Kanal QQ](./channel-qq.md) — Bot dibuat manual, diintegrasikan via AppID/AppSecret

- [Konfigurasi Skill](./skill.md) — Perluas kemampuan Hermes Agent
