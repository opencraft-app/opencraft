# Menghubungkan AI Agent ke Platform Chat

Sebuah AI agent baru menjadi bagian dari rutinitas Anda ketika Anda dapat menjangkaunya di tempat percakapan sudah berlangsung. Menghubungkan Hermes ke platform chat memberi Anda pintu masuk yang familier untuk pertanyaan, tindak lanjut, dan pembaruan berulang — tanpa harus membuka aplikasi AI terpisah setiap kali.

LightVela membuat satu Hermes Agent berbasis cloud dapat melayani melalui kanal chat yang didukung. Agent yang sama mempertahankan model, Skill, dan memori yang sudah dikonfigurasi sementara Anda memilih platform yang cocok dengan orang dan momen yang ingin Anda dukung.

![Koneksi platform chat LightVela](../images/use-case-messaging-platforms.webp)

## Ringkasan

**Menghubungkan Hermes Agent ke platform chat bersandar pada satu gagasan: kanal adalah pintu masuk, dan Agent-lah yang sebenarnya bekerja. Satu Agent di cloud berbagi model, Skill, dan memori yang sama di setiap kanal terhubung, sehingga tidak perlu bot terpisah per platform.** Alurnya memiliki empat langkah: pastikan kanal tersebut tersedia di region Anda (region global mendukung Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom, dan Lark; region Tiongkok menyasar WeChat, Lark, dan QQ); selesaikan otorisasi di sisi platform untuk memperoleh kredensial; hubungkan di konsol lalu pastikan kanalnya tampil sebagai terhubung; kemudian kirim pesan uji dan pastikan balasannya mendarat di percakapan yang sama dengan tempat Anda mengirim pesan. Kredensial bersifat sensitif — jangan pernah menuliskannya ke konteks jangka panjang atau menempelkannya ke chat.

## Untuk siapa ini

Panduan ini ditujukan bagi siapa pun yang ingin berbicara dengan Hermes dari aplikasi chat alih-alih hanya dari konsol web. Ia juga membantu jika Anda ingin satu asisten tersedia di lebih dari satu tempat — misalnya Telegram untuk pemakaian pribadi dan Discord untuk sebuah komunitas.

Mulai dengan satu kanal. Tambahkan yang lain hanya ketika ia melayani konteks, audiens, atau kebiasaan perangkat yang berbeda.

## Prasyarat

- Akun LightVela dengan Hermes Agent yang sedang berjalan. Pakai [Panduan Cepat](../02-quickstart.md) jika Anda perlu membuatnya.

- Konfigurasi model yang berfungsi atau kredit uji coba, sehingga Hermes dapat membalas setelah kanalnya terhubung.

- Akses ke platform yang ingin Anda hubungkan. Sebagian platform memakai alur otorisasi kode QR, sementara yang lain menuntut bot token atau kredensial platform.

- Pesan uji yang dapat Anda kirim segera setelah penyiapan selesai.

## Langkah / konsep kunci

### 1. Pilih kanal yang cocok dengan percakapannya

Pilih berdasarkan di mana Anda akan benar-benar memakai asisten tersebut, bukan berdasarkan berapa banyak platform yang dapat Anda hubungkan. Telegram, WhatsApp, Discord, Slack, dan WeChat adalah opsi yang umum:

| Kanal | Cocok untuk |
| --- | --- |
| Telegram | Pesan pribadi, rutinitas ringan, dan percakapan langsung |
| WhatsApp | Komunikasi sehari-hari dan notifikasi ketika WhatsApp sudah menjadi default Anda |
| Discord | Komunitas, grup developer, dan ruang diskusi yang tertata |
| Slack | Kolaborasi tim, notifikasi workspace, dan alur kerja kanal |
| WeChat | Percakapan pribadi bagi orang yang memakai WeChat setiap hari |

LightVela juga menyediakan halaman penyiapan untuk kanal lain yang didukung. Halaman Channel di konsol adalah sumber kebenaran untuk apa yang saat ini tersedia bagi Hermes Agent Anda.

### 2. Selesaikan alur koneksi khusus platform

Buka area Channel di konsol, pilih platformnya, lalu ikuti alur otorisasi atau kredensialnya. Pakai panduan yang sesuai alih-alih menyalin kredensial dari platform yang tidak berkaitan:

- [Telegram](../configuration/channel-telegram.md)
- [WhatsApp](../configuration/channel-whatsapp.md)
- [Discord](../configuration/channel-discord.md)
- [Slack](../configuration/channel-slack.md)
- [WeChat](../configuration/channel-wechat.md)

Perlakukan bot token, application ID, dan secret seperti kata sandi. Jangan menempelkannya ke grup chat, dokumen publik, atau pesan kepada orang lain. Jika sebuah kredensial terekspos, ganti kredensial itu di platform yang menerbitkannya sebelum menghubungkan Hermes kembali.

![Halaman koneksi kanal LightVela](../images/use-case-messaging-connection.png)

### 3. Verifikasi koneksinya dengan percakapan sederhana

Setelah konsol menampilkan kanal tersebut sebagai terhubung, temukan bot atau percakapannya di platform itu lalu kirim pesan singkat:

```text
Hai Hermes. Tolong balas dengan menyebut kanal tempat kamu menerima pesan ini.
```

Ini memeriksa jalur lengkapnya: platform dapat mengantarkan pesan, Hermes punya model yang berfungsi, dan balasannya dapat kembali ke tempat yang sama. Jika tidak berhasil, periksa status terhubungnya lebih dulu, lalu pastikan model aktif di [Konfigurasi Model](../configuration/model.md).

### 4. Tentukan apa yang seharusnya tetap dibagikan lintas kanal

Ketika lebih dari satu kanal terhubung ke Hermes Agent yang sama, semuanya adalah pintu berbeda menuju asisten yang sama. Artinya Agent tersebut dapat mempertahankan memori, preferensi kerja, dan Skill terpasang yang sama di seluruh kanal yang didukung.

Gunakan [Pengelolaan Memori](../configuration/memory.md) untuk meninjau konteks jangka panjang yang ingin Anda pertahankan oleh Hermes. Jika satu kanal ditujukan untuk audiens yang berbeda atau membutuhkan peran yang sangat berbeda, pertimbangkan memisahkan kasus penggunaannya alih-alih mencampur ekspektasi yang tak berkaitan ke dalam satu riwayat percakapan.

![Konteks Hermes Agent yang sama dibagikan lintas kanal](../images/use-case-messaging-memory.png)

## FAQ

### Bisakah saya menghubungkan beberapa platform chat ke satu Hermes Agent?

Bisa. Kanal yang didukung dapat mengarah ke Agent yang sama, sehingga Anda dapat menjangkaunya dari lebih dari satu aplikasi chat sambil mempertahankan perilaku terkonfigurasi dan memori yang sama.

### Kanal mana yang sebaiknya saya hubungkan lebih dulu?

Pilih yang sudah paling sering Anda pakai. Asisten pribadi lebih mungkin menjadi berguna ketika pesan pertamanya mudah dikirim. Telegram, WhatsApp, Discord, Slack, dan WeChat masing-masing memiliki panduan penyiapan yang terperinci.

### Mengapa kanalnya tampil terhubung tetapi Hermes tidak membalas?

Kirim pesan uji sederhana, lalu periksa apakah model aktif atau kredit uji coba tersedia. Jika masalahnya berlanjut, hubungkan kanal tersebut kembali lalu pakai [Diagnostik](../configuration/diagnostics.md) untuk meninjau opsi pemeliharaan dan log terbaru.

### Bisakah saya membagikan satu kredensial bot ke beberapa Hermes Agent?

Hindari itu kecuali platform dan alur kerja yang Anda maksudkan jelas mendukungnya. Menjaga satu kredensial terikat pada satu tujuan yang jelas membuat penelusuran masalah dan kontrol akses jauh lebih mudah.

## Langkah berikutnya

- [Konfigurasi Model](../configuration/model.md) — pastikan Hermes punya model yang siap menjawab.

- [Pengelolaan Memori](../configuration/memory.md) — kelola konteks yang dibagikan oleh kanal-kanal terhubung Anda.

- [Otomasi](../configuration/automation.md) — kirimkan pembaruan terjadwal ke kanal terhubung bila sesuai.
