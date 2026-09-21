# Kanal Slack

## Ringkasan

**Kanal Slack dihubungkan dengan bot token dan app token, cocok untuk membawa Hermes Agent ke kanal tim, pesan pribadi, dan notifikasi tugas otomatis: buat aplikasi di konsol manajemen aplikasi Slack, atur izinnya, ambil kedua token tersebut, lalu tempelkan ke bagian Kanal pada konsol LightVela. Anda memerlukan workspace Slack tempat Anda dapat memasang aplikasi dan model yang sudah dikonfigurasi (atau cukup kredit model bulanan dari paket Anda). Kedua token adalah kredensial sensitif — jangan dibagikan secara publik. Setelah terhubung, Agent di Slack berbagi persona dan memori jangka panjang yang sama dengan kanal lain.**

---

Slack memakai Bot Token dan App Token untuk menghubungkan Hermes Agent ke channel tim, pesan langsung, dan notifikasi tugas otomatis.

## Yang dibahas di halaman ini

- Membuat aplikasi Slack serta mengonfigurasi Socket Mode, izin, dan event

- Mengikat Slack Bot Token dan App Token di LightVela

- Mengobrol dengan Hermes Agent melalui channel Slack dan pesan langsung

> 💡 **Sebelum memulai**
>
> - Anda sudah memiliki Hermes Agent dengan model yang berfungsi dan dikonfigurasi di [Konfigurasi Model](./model.md)
>
> - Anda memiliki workspace Slack dan izin untuk membuat serta memasang aplikasi
>
> - Jika pemasangan aplikasi memerlukan persetujuan administrator, hubungi administrator workspace Anda
>
> - Siapkan tempat yang aman untuk menyimpan kedua token tersebut secara sementara
>
> Bot Token dan App Token adalah kredensial sensitif. Jika sebuah token terekspos, cabut token tersebut di Slack lalu buat penggantinya.

---

## Langkah-langkah

### 1. Buka pengaturan kanal Slack di LightVela

Masuk ke situs internasional LightVela, buka **My Hermes → Channel**, temukan kartu **Slack**, lalu klik **+ Connect**. Anda akan kembali ke halaman ini dengan dua kredensial:

- **Slack Bot Token**: dimulai dengan `xoxb-`.
- **Slack App Token**: dimulai dengan `xapp-`.

### 2. Buat aplikasi Slack

1. Buka [Slack API Apps](https://api.slack.com/apps) lalu masuk.
2. Klik **Create New App**.

![Membuat app baru dari Slack API Apps](../images/slack-create-app.png)

3. Pilih **From scratch**.

![Memilih From scratch untuk membuat app Slack](../images/slack-create-from-scratch.png)

4. Masukkan nama aplikasi seperti `Hermes Agent`.
5. Pilih workspace tempat Hermes Agent akan berjalan, lalu klik **Create App**.

![Memberi nama app Slack dan memilih workspace](../images/slack-select-workspace.png)

Jika workspace tersebut tidak muncul, pastikan akun Slack saat ini memang termasuk di dalamnya dan dapat membuat aplikasi.

### 3. Buat App Token

App Token membangun koneksi WebSocket Socket Mode. Token ini wajib menyertakan scope `connections:write`.

1. Di sidebar app Slack, buka **Settings → Basic Information**.

![Membuka Basic Information di app Slack](../images/slack-basic-information.png)

2. Gulir sampai **App-Level Tokens** lalu klik **Generate Token and Scopes**.

![Membuat app-level token](../images/slack-generate-app-token.png)

3. Masukkan nama token yang mudah dikenali, misalnya `HermesSocket`.
4. Klik **Add Scope**.

![Menambahkan scope ke App Token](../images/slack-add-connection-scope.png)

5. Cari lalu pilih `connections:write`.

![Memilih scope connections write](../images/slack-select-connections-write.png)

6. Pastikan scope tersebut sudah tercantum, lalu klik **Generate**.

![Membuat App Token dengan connections write](../images/slack-generate-token.png)

7. Salin token `xapp-...` yang dihasilkan lalu simpan dengan aman. Klik **Done** setelah menyalinnya.

![Menyalin Slack App Token](../images/slack-copy-app-token.png)

Jangan menempelkan App Token ke kolom Bot Token. Client Secret atau Signing Secret bukan pengganti token ini.

### 4. Konfigurasikan Socket Mode, izin, dan event

#### 4.1 Aktifkan Socket Mode

1. Buka **Settings → Socket Mode**.
2. Aktifkan **Enable Socket Mode**.

![Mengaktifkan Slack Socket Mode](../images/slack-enable-socket-mode.png)

Socket Mode mengirim event Slack ke Hermes Agent melalui WebSocket. Penyiapan ini tidak memerlukan Request URL pada Event Subscriptions maupun OAuth Redirect URL.

#### 4.2 Tambahkan Bot Token Scopes

1. Buka **Features → OAuth & Permissions**.
2. Gulir sampai **Scopes → Bot Token Scopes**.
3. Klik **Add an OAuth Scope**.

![Menambahkan bot scope di OAuth and Permissions](../images/slack-add-oauth-scope.png)

Tambahkan scope sesuai mode interaksi yang Anda butuhkan:

| Scope | Dibutuhkan untuk | Tujuan |
|---|---|---|
| `app_mentions:read` | Pemakaian di channel | Menerima pesan yang menyebut bot |
| `channels:read` | Channel publik | Membaca informasi dasar channel publik |
| `channels:history` | Channel publik | Membaca pesan di channel publik yang sudah diikuti bot |
| `chat:write` | Semua balasan | Mengirim pesan sebagai bot |
| `im:read` | Pesan langsung | Membaca informasi percakapan pesan langsung |
| `im:history` | Pesan langsung | Membaca pesan langsung yang dikirim ke bot |
| `im:write` | Pesan langsung | Membuka atau mengelola percakapan pesan langsung |
| `groups:read` | Channel privat (opsional) | Membaca informasi channel privat |
| `groups:history` | Channel privat (opsional) | Membaca pesan di channel privat yang sudah diikuti bot |

![Meninjau Slack Bot Token Scopes](../images/slack-bot-token-scopes.png)

Tambahkan dua scope `groups:*` hanya ketika akses channel privat memang diperlukan. Aplikasi tersebut tetap harus diundang ke setiap channel tujuan.

#### 4.3 Aktifkan pesan langsung di App Home

Jika pengguna perlu dapat mengirim pesan langsung ke Hermes Agent:

1. Buka **Features → App Home**.
2. Gulir sampai **Show Tabs**.
3. Aktifkan **Messages Tab**.
4. Aktifkan opsi yang mengizinkan pengguna mengirim pesan dari tab Messages.

Jika Anda hanya memakai mention di channel, Anda dapat melewati bagian ini serta mengabaikan scope `im:*` dan event `message.im`.

#### 4.4 Berlangganan bot events

1. Buka **Features → Event Subscriptions**.
2. Aktifkan **Enable Events**.
3. Di bawah **Subscribe to bot events**, klik **Add Bot User Event**.
4. Tambahkan `app_mention` untuk mention di channel.
5. Tambahkan `message.im` jika pesan langsung diaktifkan.
6. Klik **Save Changes**.

![Mengonfigurasi langganan event bot Slack](../images/slack-event-subscriptions.png)

> Jika Anda mengubah scope atau event setelah pemasangan, kembali ke **OAuth & Permissions** lalu klik **Reinstall to Workspace**. Izin baru belum berlaku sampai aplikasi tersebut dipasang ulang.

### 5. Pasang aplikasi lalu salin Bot Token

1. Kembali ke **Features → OAuth & Permissions**.
2. Klik **Install to Workspace**. Jika aplikasi sudah terpasang, klik **Reinstall to Workspace**.

![Memasang app Slack ke workspace](../images/slack-install-workspace.png)

3. Tinjau izin yang diminta lalu klik **Allow**.

![Mengotorisasi izin app Slack](../images/slack-authorize-workspace.png)

4. Setelah Slack kembali ke **OAuth & Permissions**, temukan **OAuth Tokens for Your Workspace**.
5. Salin **Bot User OAuth Token** yang dimulai dengan `xoxb-`.

![Menyalin Slack Bot User OAuth Token](../images/slack-copy-bot-token.png)

Jangan memakai Signing Secret, Client Secret, Verification Token, atau User OAuth Token `xoxp-...`. LightVela membutuhkan satu App Token `xapp-...` dan satu Bot Token `xoxb-...`.

### 6. Ikat Slack di LightVela

1. Kembali ke **My Hermes → Channel → Slack**.
2. Tempel token `xoxb-...` ke **Slack Bot Token**.
3. Tempel token `xapp-...` ke **Slack App Token**.
4. Pastikan kedua token berada di kolom yang benar, lalu kirim koneksinya.
5. Tunggu sampai kartu Slack tampil sebagai terhubung.

### 7. Uji Hermes Agent di Slack

#### 7.1 Uji mention di channel

1. Buka channel Slack tempat Anda ingin memakai Hermes Agent.
2. Undang aplikasi tersebut:

```text
/invite @Hermes Agent
```

3. Kirim pesan yang menyebut bot tersebut:

```text
@Hermes Agent Rangkum poin-poin penting yang dibahas di channel ini hari ini.
```

Bot hanya menerima pesan channel setelah ia bergabung ke channel tersebut.

#### 7.2 Uji pesan langsung

1. Buka aplikasi baru tersebut dari bagian **Apps** di Slack.
2. Pilih tab **Messages**.
3. Kirim pesan singkat seperti `Hello`.

![Menguji pesan langsung di Slack App Home](../images/slack-direct-message-test.png)

---

## Kondisi berhasil

Penyiapan selesai ketika semua pemeriksaan yang relevan lulus:

- Kartu Slack di LightVela tampil sebagai terhubung.
- Aplikasi Slack sudah terpasang di workspace tujuan.
- Hermes Agent membalas mention di channel yang sudah diikuti aplikasi tersebut.
- Ketika App Home dan izin IM diaktifkan, Hermes Agent membalas pesan langsung.

---

## Jenis pesan yang didukung

Setelah Slack terhubung, kanal ini mendukung skenario pesan berikut:

| Jenis pesan Slack | Didukung |
|---|---|
| Menerima mention teks di channel | ✅ Didukung |
| Menerima teks pesan langsung di App Home | ✅ Didukung |
| Membalas dengan teks di channel dan pesan langsung | ✅ Didukung |
| Mengirim pesan proaktif, seperti notifikasi tugas otomatis | ✅ Didukung |

> ℹ️ **Penanganan tugas sebenarnya bergantung pada model**
>
> Tabel ini menjelaskan dukungan pesan pada level kanal Slack. Perangkuman, penerjemahan, dan tugas lain tetap bergantung pada model yang dikonfigurasi serta Skill yang terpasang.

---

## FAQ

| Masalah | Kemungkinan penyebab | Penyelesaian |
|---|---|---|
| App Token ditolak | Jenis token salah atau `connections:write` belum ada | Buat token `xapp-...` baru di **Basic Information → App-Level Tokens** |
| Bot Token ditolak | User OAuth Token atau kredensial lain yang tersalin | Salin Bot User OAuth Token `xoxb-...` dari **OAuth & Permissions** |
| Event Subscriptions meminta Request URL | Socket Mode dinonaktifkan | Aktifkan **Settings → Socket Mode**, lalu kembali ke Event Subscriptions |
| Mention di channel tidak diterima | Aplikasi belum ada di channel, scope belum lengkap, atau `app_mention` belum ada | Undang aplikasi tersebut, tambahkan scope channel dan `app_mention`, lalu pasang ulang aplikasinya |
| Pesan langsung tidak diterima | Messages Tab dinonaktifkan, scope IM belum ada, atau `message.im` belum ada | Aktifkan Messages Tab, tambahkan `im:*` dan `message.im`, lalu pasang ulang aplikasinya |
| Izin baru tidak berfungsi | Aplikasi belum dipasang ulang setelah perubahan | Klik **Reinstall to Workspace** di **OAuth & Permissions** |
| Kanal terhubung tetapi tidak ada balasan | Model tidak tersedia, kredit tidak cukup, atau ada masalah status Agent | Periksa [Konfigurasi Model](./model.md), status instans, dan kredit yang tersedia |

---

## Langkah berikutnya

- [Kanal Telegram](./channel-telegram.md) — Percakapan pribadi dan notifikasi grup

- [Kanal WhatsApp](./channel-whatsapp.md) — Komunikasi pengguna internasional dan layanan pelanggan

- [Kanal Discord](./channel-discord.md) — Operasional komunitas dan komunitas developer

- [Tugas Terjadwal](./automation.md) — Kirim pengingat terjadwal dan hasil tugas ke Slack

- [Konfigurasi Skill](./skill.md) — Perluas kemampuan Hermes Agent
