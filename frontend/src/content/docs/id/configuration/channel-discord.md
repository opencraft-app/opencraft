# Kanal Discord

## Ringkasan

**Kanal Discord dihubungkan melalui otorisasi bot, cocok untuk membawa Hermes Agent ke server Discord guna menjawab pertanyaan, membantu, atau menggerakkan interaksi komunitas: buat aplikasi dan bot di portal pengembang Discord, ambil kredensialnya, tempelkan ke bagian Kanal pada konsol LightVela, lalu undang bot ke server tujuan. Anda memerlukan server Discord tempat Anda memiliki hak admin dan model yang sudah dikonfigurasi (atau cukup kredit model bulanan dari paket Anda). Setelah terhubung, Agent di Discord berbagi persona dan memori jangka panjang yang sama dengan kanal lain.**

---

Kanal Discord memakai akses otorisasi Bot dan cocok untuk menghubungkan Hermes Agent ke sebuah server Discord, sehingga tersedia kemampuan tanya-jawab, asisten, atau interaksi komunitas di dalam channel.

## Yang dibahas di halaman ini

- Membuka tautan undangan di Discord dan menyelesaikan otorisasi

- Mengobrol dengan Hermes Agent di server atau channel Discord


> 💡 **Prasyarat**
>
> -   Akun Discord yang dapat digunakan untuk masuk
>
> -   Server Discord tempat Anda dapat menambahkan bot
>
> -   Menyelesaikan [konfigurasi model](./model.md) (atau memakai 100 kredit uji coba yang termasuk dalam paket Launch)
>

---

## Langkah-langkah

### 1. Masuk ke konsol

Masuk ke LightVela, klik "My Hermes" di kanan atas untuk membuka konsol, lalu temukan tombol "Channel".

### 2. Pilih kanal Discord

Temukan kartu Discord lalu klik "+ Connect".

### 3. Buka Discord lalu masuk ke Developer Portal

Pilih server tempat Anda ingin menambahkan bot, lalu buka [Developer Portal](https://discord.com/developers/home):

1. Klik Applications

![](../images/discord-1-global.webp)

2. Klik New Application di kanan atas

3. Beri nama Application Anda

4. Tambahkan bot ke application Anda lalu buat bot token. Token tersebut dipakai untuk mengautentikasi koneksi antara Hermes Agent dan server Discord Anda.

![](../images/discord-2-global.webp)

5. Tempel token tersebut ke kartu Discord.

![](../images/discord-3-global-en.webp)

### 4. Buka halaman Bot di Developer Portal

Di halaman Bot, gulir ke bawah sampai Privileged Gateway Intents lalu aktifkan:

- **Message Content Intent**: wajib, dipakai untuk membaca isi pesan

- **Server Members Intent**: disarankan, dipakai untuk daftar role dan pencocokan nama dengan ID

- **Presence Intent**: opsional, hanya dipakai untuk pembaruan status

![](../images/discord-4-global.webp)

Setelah mengaktifkannya, klik Save Changes di bagian bawah.

### 5. Buka halaman OAuth2 di Developer Portal

Konfigurasikan izin bot: klik OAuth2 di sidebar kiri, lalu pilih OAuth2 URL Generator. Atur Scopes terlebih dahulu; mengikuti prinsip hak akses minimum, utamakan `bot` dan `applications.commands`.

![](../images/discord-5-global.webp)

Lanjutkan menggulir ke bawah untuk mengatur Bot Permissions, lalu pilih:

- View Channels

- Send Messages

- Read Message History

- Embed Links

- Attach Files

- Add Reactions (opsional)

![](../images/discord-6-global.webp)

### 6. Salin lalu buka tautan undangan

Salin Invite Link yang dihasilkan, buka tautan tersebut di browser Anda, lalu undang bot ke server Discord Anda (memerlukan izin admin server). Setelah mengklik Continue dan memberikan otorisasi, bot akan diundang ke server tersebut.

![](../images/discord-7-global.webp)

### 7. Mengobrol dengan bot baru di Discord

Sekarang Anda dapat mulai berinteraksi dengan bot tersebut. Buka percakapan dengan bot itu lalu kirim pesan uji:

```
Hi
```

![](../images/discord-chat-global.webp)

Anda semestinya menerima balasan Hermes Agent dalam beberapa detik.

---

## Kondisi berhasil

- Daftar "Connected channels" di konsol memuat "Discord"

- Bot terkait dapat ditemukan di kontak Discord

- Hermes Agent membalas setelah Anda mengirim pesan


---

## Jenis pesan yang didukung

Setelah akses berhasil, bot Discord dapat menerima dan membalas pesan teks dasar serta mendukung lebih banyak jenis pesan berikut:

| Jenis pesan yang didukung bot Discord | Didukung |
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
> Tabel di atas hanya menunjukkan jenis pesan yang didukung bot Discord pada lapisan kanal. Apakah gambar, file, dan tugas lain benar-benar dapat diproses juga bergantung pada apakah large language model yang terhubung ke Hermes Agent memiliki kemampuan terkait.

---

## FAQ

| Masalah | Kemungkinan penyebab | Solusi |
|---|---|---|
| Tidak dapat membuat Discord Bot | Belum masuk ke Discord Developer Portal, atau alur pembuatan application belum selesai | Masuk ke Discord Developer Portal, buat Application, lalu tambahkan Bot |
| Bot Token tidak dapat ditemukan | Token belum dibuat atau belum disalin secara lengkap | Di halaman Bot, klik Reset Token / Copy Token, lalu tempel token lengkap ke kolom token |
| Token dianggap tidak valid setelah ditempel | Token tidak lengkap atau mengandung spasi / baris baru tambahan | Salin ulang Bot Token secara lengkap lalu pastikan tidak ada spasi tambahan |
| Bot tidak dapat diundang ke server | Konfigurasi OAuth2 URL salah, atau akun Anda tidak punya izin admin server | Di OAuth2 URL Generator, pilih scope `bot`, lalu pastikan Anda punya hak admin di server tersebut |
| Bot tidak muncul di server setelah diundang | Undangan belum selesai, atau bot tidak online | Buka kembali tautan undangan untuk memastikan otorisasi berhasil; segarkan daftar anggota server Discord |
| Tidak ada balasan setelah mengirim pesan | Model belum dikonfigurasi, kredit uji coba habis, atau kanal Discord belum berhasil terhubung | Periksa status "Current model" di kartu "1. Model" dan pastikan kanal Discord tampil sebagai terhubung |
| Bot tidak dapat membaca isi pesan | Message Content Intent belum diaktifkan | Aktifkan Message Content Intent di pengaturan Bot pada Discord Developer Portal |
| Bot tidak punya izin membalas di sebuah channel | Izin channel tidak memadai | Pastikan bot memiliki View Channels, Send Messages, Read Message History, dan izin lain yang diperlukan |
| Bot tidak dapat menerima pesan langsung | Batasan izin DM atau pengaturan privasi pengguna | Pastikan bot mengizinkan DM, lalu periksa pengaturan privasi Discord pengguna tersebut |
| Cara memutuskan tautan | — | Hapus catatan Discord terkait di daftar "Connected channels" |
| Apakah satu Discord Bot yang sama dapat terhubung ke beberapa instans Hermes Agent | Tidak disarankan; satu Bot Token sebaiknya terikat pada satu Hermes Agent | Jika Anda memerlukan beberapa instans Hermes Agent, buat Discord Bot terpisah |

---

## Catatan kanal

- **Jenis pesan**: Mendukung teks, gambar, video, file, pesan suara, dan lainnya. Lihat "Jenis pesan yang didukung" di atas

- **Dukungan chat grup**: Chat grup belum didukung saat ini; hanya percakapan satu lawan satu yang didukung

- **Koneksi terputus**: Tidak ada respons dalam waktu lama dapat menandakan otorisasi sudah dicabut. Kembali ke konsol lalu berikan otorisasi akses lagi

---

## Langkah berikutnya

- [Kanal Slack](./channel-slack.md) — Kolaborasi tim, notifikasi workspace, dan alur kerja kanal

- [Kanal QQ](./channel-qq.md) — Bot dibuat manual, diintegrasikan via AppID/AppSecret

- [Kanal WeCom](./channel-wecom.md) — Kolaborasi internal perusahaan dan skenario perkantoran

- [Kanal Lark](./channel-feishu.md) — Skenario perkantoran dengan rich text dan chat grup

- [Konfigurasi Skill](./skill.md) — Perluas kemampuan Hermes Agent
