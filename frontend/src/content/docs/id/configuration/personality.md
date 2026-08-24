# Soul

## Ringkasan

**Soul menentukan peran, gaya komunikasi, prioritas, dan batas perilaku yang stabil untuk satu Hermes Agent.**

**Di pengaturan Personality Agent, Anda dapat memilih Soul rekomendasi atau mengunggah file Markdown Anda sendiri, lalu menerapkannya ke `SOUL.md` Agent tersebut.**

**Satu Agent hanya dapat memiliki satu Soul aktif pada satu waktu, dan Anda perlu memulai percakapan baru setelah mengubahnya agar aturan baru dimuat.**

![Kartu persona Soul di konsol LightVela](../images/soul-1.png)

## Yang dibahas di halaman ini

- Apa yang dikendalikan Soul
- Memilih dan menyuntikkan Soul rekomendasi
- Mengunggah Soul Anda sendiri
- Memastikan kepribadian baru sudah aktif
- Memisahkan kepribadian, profil pengguna, memori, dan Skill

## Apa yang dikendalikan Soul

Soul adalah konfigurasi persona yang ditulis LightVela ke `SOUL.md` Agent.
Soul menentukan siapa Agent tersebut, cara berkomunikasi secara normal, apa yang diprioritaskan, dan batas perilaku yang harus dipatuhi.

Gunakan Soul untuk aturan yang stabil, seperti “berikan kesimpulan terlebih dahulu”, “nyatakan ketidakpastian dengan jelas”, atau “minta konfirmasi sebelum melakukan tindakan eksternal”.
Jangan gunakan Soul untuk fakta proyek yang terus berubah, permintaan sekali pakai, atau sebagai editor file cloud serbaguna.

Kepribadian berlaku untuk Agent, bukan satu kanal percakapan.
Jika Agent yang sama terhubung ke Telegram dan WhatsApp, percakapan baru di kedua kanal menggunakan Soul aktif yang sama.

## Sebelum memulai

1. Buka Hermes Agent yang ingin Anda atur kepribadiannya.
2. Pastikan Agent memiliki model dan setidaknya satu kanal percakapan yang dapat digunakan untuk memeriksa hasilnya.
3. Tentukan peran, audiens, gaya komunikasi, prioritas, dan tindakan yang selalu membutuhkan konfirmasi.

Deskripsi singkat biasanya sudah cukup.
Contohnya: “Asisten riset yang ringkas, memberikan kesimpulan sebelum bukti, menyebutkan ketidakpastian, dan bertanya sebelum mengirim apa pun ke luar percakapan.”

## Konfigurasikan Soul

### Buka Personality

1. Buka **Agents** di konsol LightVela.
2. Pilih Hermes Agent yang ingin Anda konfigurasi.
3. Buka bagian **Personality** di pengaturan Agent tersebut.

Pengaturan ini hanya berlaku untuk Agent yang sedang dipilih.
Pilih Agent lain terlebih dahulu bila Agent tersebut membutuhkan peran atau gaya komunikasi yang berbeda.

### Pilih Soul

Gunakan **Draw random soul** untuk menjelajahi gaya persona yang tersedia.
Gunakan **Soul personality test** bila Anda ingin mendapatkan rekomendasi berdasarkan preferensi komunikasi dan perilaku Anda.

![Dialog Draw random soul](../images/soul-2.png)

Tinjau peran, gaya komunikasi, deskripsi perilaku, dan batas pada setiap kartu Soul sebelum memilihnya.
Pilih Soul yang sesuai dengan deskripsi yang sudah Anda siapkan, bukan hanya berdasarkan nama atau nadanya.

### Suntikkan Soul

1. Pilih Soul yang ingin digunakan.
2. Pilih **Inject**.
3. Pastikan hasil penyuntikan di bagian Personality.
4. Kembali ke kanal percakapan yang terhubung lalu kirim `/new`.

Saat penyuntikan berhasil, LightVela menulis Soul yang dipilih ke `SOUL.md` Agent saat ini dan membuat cadangan sebelum mengganti persona yang sudah ada.
Percakapan yang sudah berjalan dapat tetap memakai snapshot persona lama, sehingga `/new` memulai percakapan yang membaca Soul terbaru.

### Unggah Soul Anda sendiri

Gunakan opsi ini jika Anda sudah memiliki persona Markdown dan ingin menerapkannya tanpa memilih kartu rekomendasi.

1. Pilih Hermes Agent tujuan di konsol LightVela.
2. Di **Personality**, pilih **Upload personality file**.
3. Pilih file Markdown yang berisi Soul Anda.
4. Tinjau atau edit isinya, lalu pilih **Inject**.
5. Jika Agent sudah memiliki Soul, konfirmasikan bahwa Anda ingin menggantinya.
6. Kembali ke kanal percakapan yang terhubung lalu kirim `/new`.

![Dialog Upload personality file](../images/soul-3.png)

Nama file tidak harus `soul.md`, tetapi ekstensinya harus `.md`, harus menggunakan pengodean UTF-8, dan ukurannya tidak boleh melebihi 20 KB.
LightVela menampilkan isi file sebelum penyuntikan sehingga Anda dapat melakukan pemeriksaan atau pengeditan terakhir.
Saat mengganti Soul yang sudah ada, LightVela mencadangkannya sebelum menulis konten yang diunggah ke `SOUL.md` Agent yang dipilih.

Pengunggahan hanya tersedia ketika Anda telah memilih Agent.
Jika belum ada Agent yang dipilih atau sandbox Agent tidak dapat ditulis dan Anda menerima unduhan `soul.md` dari Soul rekomendasi, file tersebut hanya cadangan lokal.
Mengunduhnya tidak memperbarui Agent dengan sendirinya.

## Simpan setiap jenis konteks di tempat yang tepat

| Simpan di | Gunakan untuk | Contoh |
| --- | --- | --- |
| Personality dan `SOUL.md` | Peran, gaya komunikasi, prioritas, dan batas perilaku yang stabil | “Nyatakan ketidakpastian dengan jelas dan minta konfirmasi sebelum mengirim pesan eksternal.” |
| User Profile | Identitas, lokasi, bahasa, dan preferensi komunikasi pengguna | “Gunakan bahasa Inggris secara default dan tampilkan tenggat waktu terlebih dahulu.” |
| Memory | Fakta, keputusan, dan konteks proyek jangka panjang yang berubah | “Peluncuran proyek saat ini adalah hari Jumat.” |
| Skill | Kemampuan dan prosedur yang dapat digunakan ulang | Riset web, pengelolaan file, atau alur laporan harian |

Gunakan [Pengelolaan Memori](./memory.md) untuk meninjau kapasitas memori dan profil pengguna.
Gunakan [Konfigurasi Skill](./skill.md) ketika Agent memerlukan kemampuan baru, bukan aturan kepribadian baru.
Untuk penjelasan lebih dalam tentang batas ini, lihat [Dari Mana Kepribadian Hermes Agent Berasal](../hermes-agent/10-persona-user-memory.md).

## Pastikan Soul sudah aktif

Setelah mengirim `/new`, uji Agent dengan beberapa permintaan yang menunjukkan perilaku yang dikonfigurasi.

```text
Apa peranmu saat ini, pekerjaan utamamu, dan gaya komunikasi default-mu?
```

```text
Bagaimana kamu merespons ketika tidak yakin tentang sebuah fakta?
```

```text
Jika saya meminta kamu mengirim pesan ke layanan eksternal, apa yang kamu lakukan lebih dulu?
```

Soul baru aktif ketika Agent secara konsisten mengikuti peran, gaya komunikasi, dan batas yang diinginkan dalam percakapan baru.
Untuk panduan khusus kanal, lihat [Cara Menetapkan Peran, Kepribadian, dan Gaya Bicara IM Agent dengan SOUL.md](../use-cases/im-agent-persona-soul-md.md).

## Memecahkan masalah umum

| Masalah | Kemungkinan penyebab | Yang perlu dilakukan |
| --- | --- | --- |
| Balasan masih menggunakan gaya lama | Percakapan dimulai sebelum Soul diubah | Kirim `/new`, lalu uji kembali perilakunya dalam percakapan baru. |
| Soul yang dipilih tidak cocok dengan pekerjaan Agent yang sebenarnya | Kartu dipilih berdasarkan gaya, bukan peran dan batas | Kembali ke Personality, periksa detail kartu, lalu suntikkan Soul yang sesuai dengan deskripsi Agent. |
| Agent melupakan fakta proyek | Fakta yang berubah diletakkan di Personality, bukan Memory | Simpan aturan stabil di `SOUL.md` dan minta Hermes mengingat fakta yang berubah. |
| Agent tidak dapat melakukan tugas yang dibutuhkan | Personality menentukan perilaku, bukan kemampuan | Pasang atau konfigurasikan Skill yang sesuai setelah memeriksa sumber dan izinnya. |
| Konsol mengunduh `soul.md` alih-alih menerapkannya | Tidak ada Agent yang dipilih atau sandbox Agent tidak dapat menulis konfigurasi baru | Pilih Agent target yang sedang berjalan lalu coba lagi. File yang diunduh tidak mengubah Agent. Kirim `/new` hanya setelah konsol mengonfirmasi penyuntikan berhasil. |
| Saya tidak dapat mengunggah Soul sendiri | Tidak ada Agent yang dipilih atau file bukan Markdown UTF-8 yang valid dalam batas 20 KB | Pilih Agent target lalu unggah file `.md` yang memenuhi persyaratan file. |

## FAQ

### Dapatkah satu Agent memiliki beberapa Soul aktif?

Tidak.
Satu Agent hanya memiliki satu Soul aktif pada satu waktu.
Buat Agent terpisah ketika Anda membutuhkan peran yang benar-benar berbeda, alih-alih berulang kali mengganti kepribadian satu Agent.

### Dapatkah saya mengedit `SOUL.md` cloud secara manual?

Penggunaan normal tidak membutuhkan operasi sistem file cloud langsung.
Pengaturan Personality dapat menghasilkan, mengunggah, dan menyuntikkan Soul, tetapi bukan editor serbaguna untuk file cloud apa pun.

### Dapatkah saya mengunggah `SOUL.md` yang sudah ada?

Ya.
Gunakan **Upload personality file** untuk memilih file Markdown UTF-8 hingga 20 KB, tinjau atau edit, lalu suntikkan ke Agent yang dipilih.
Jika Agent sudah memiliki Soul, LightVela meminta konfirmasi dan menyimpan cadangan sebelum menggantinya.

### Apakah mengubah Soul memasang kemampuan baru?

Tidak.
Soul mengubah cara Agent berperilaku, sedangkan Skill menambahkan kemampuan konkret dan prosedur yang dapat digunakan ulang.

### Apakah Soul baru menghapus memori atau riwayat chat?

Tidak.
Menyuntikkan Soul mengganti konfigurasi kepribadian Agent saat ini.
Tindakan ini tidak menghapus memori jangka panjang atau riwayat percakapan yang ada.
