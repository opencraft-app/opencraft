# Diagnostik

Diagnostik membantu Anda menyelidiki Agent yang tidak berperilaku seperti yang diharapkan. Dari satu tempat, Anda dapat meninjau log Hermes Agent terbaru, mengekspornya untuk dibagikan, mereset konfigurasi model, atau memasang ulang Agent tanpa menghapus datanya.

## Yang dibahas di halaman ini

- Melihat dan mengekspor log terbaru
- Mereset konfigurasi model yang rusak
- Memasang ulang Agent tanpa menghapus datanya
- Mengetahui kapan memakai opsi pemulihan dan kapan meminta bantuan

> **Gunakan Diagnostik dengan hati-hati:** Mulailah dari log dan tindakan teraman yang paling kecil dampaknya. Mereset konfigurasi atau memasang ulang Agent sebaiknya disimpan untuk masalah yang terus berulang.

## Sebelum memulai

1. Buka Agent yang sedang bermasalah.
2. Catat apa yang terjadi, kapan mulai terjadi, dan apakah masalahnya memengaruhi Chat, kanal yang terhubung, atau satu tugas tertentu.
3. Jika model yang gagal, tinjau dulu pengaturan saat ini di [Konfigurasi Model](./model.md) sebelum mereset apa pun.

## Membuka Diagnostik

1. Buka **Agents** lalu pilih Agent yang terdampak.
2. Buka bagian **Diagnostics**.
3. Pilih rentang waktu untuk log terbaru: 1, 3, 6, 12, atau 24 jam.
4. Pilih **Refresh** untuk memuat log.

![Diagnostik di konsol LightVela](../images/diagnostics-overview-en.png)

Mulailah dari periode terpendek yang masih berguna. Jendela log yang lebih sempit memudahkan Anda menghubungkan sebuah error dengan tindakan yang memicunya.

## Meninjau dan mengekspor log

Gunakan keluaran log untuk memastikan apakah Agent memang berjalan dan untuk mengidentifikasi waktu terjadinya kegagalan. Anda dapat mengekspor rentang log saat ini sebagai file ketika perlu menyimpan catatan atau membagikannya ke kontak dukungan Anda.

Saat melaporkan masalah, sertakan:

- perkiraan waktu kejadian;
- apa yang Anda minta untuk dikerjakan Agent;
- rentang log yang dipilih; dan
- pesan error yang relevan, tanpa menyertakan rahasia atau API key.

## Memperbaiki konfigurasi model

Jika Agent tidak dapat menggunakan model yang dikonfigurasi dan masalahnya tetap ada setelah Anda memeriksa penyedia, pilihan model, dan kredensial, pilih **Reset model configuration** di Diagnostik.

Tindakan ini memulihkan konfigurasi model Hermes Agent sehingga Anda dapat mengaturnya kembali. Setelah selesai:

1. Kembali ke [Konfigurasi Model](./model.md).
2. Tambahkan atau pilih model yang ingin Anda gunakan.
3. Kirim pesan uji singkat di [Chat Agent](./agent-chat.md).

> **Perhatian:** Reset konfigurasi model hanya ketika Anda siap mengonfigurasi model yang berfungsi lagi. Ini bukan langkah pertama untuk masalah penyedia atau jaringan yang bersifat sementara.

## Memasang ulang Agent tanpa menghapus data

Untuk masalah yang tetap berlanjut setelah Anda meninjau log dan pengaturan model, Diagnostik menyediakan **Reinstall Agent (keep data)**. Tindakan ini memulai proses pemasangan ulang Hermes Agent sambil mempertahankan datanya.

1. Baca deskripsi tindakan di Diagnostik.
2. Mulai pemasangan ulang dan biarkan halaman tetap terbuka selama statusnya berubah.
3. Setelah selesai, muat ulang konsol Agent.
4. Uji satu tugas sederhana di Chat, lalu periksa Cloud Storage dan pengaturan yang biasa Anda pakai.

![Dialog konfirmasi pemasangan ulang Agent](../images/diagnostics-reinstall-en.webp)

Agent dapat sesaat tidak tersedia selama pemeliharaan. Hindari memulai tindakan perbaikan lain saat pemasangan ulang masih berlangsung.

## Backup dan pemulihan, bila tersedia

Sebagian akun menampilkan panel **Backup & Recovery** di Diagnostik. Jika panel tersebut tersedia untuk Anda, ikuti instruksi yang ditampilkan di konsol Anda untuk membuat backup atau memulihkan paket backup Hermes yang kompatibel. Jangan berasumsi opsi ini tersedia untuk setiap Agent atau setiap akun.

Sebelum memulihkan, simpan salinan file apa pun yang tidak dapat Anda gantikan. [File](./files.md) adalah tempat yang baik untuk meninjau file Agent saat ini terlebih dahulu.

## Memverifikasi perbaikan

Masalah kemungkinan sudah teratasi ketika:

- log terbaru dimuat tanpa kegagalan yang berulang;
- Agent dapat merespons uji sederhana di Chat; dan
- model serta file yang Anda harapkan tersedia kembali.

Jika error yang sama muncul lagi, ekspor log yang relevan dan catat waktu kemunculan berikutnya sebelum meningkatkan laporan ke tingkat berikutnya.

## FAQ

### Rentang log mana yang sebaiknya saya pilih?

Pilih rentang terpendek yang sudah mencakup masalahnya. Gunakan rentang yang lebih panjang hanya jika masalah mulai terjadi lebih awal atau muncul sesekali.

### Apakah pemasangan ulang akan menghapus data Agent saya?

Tindakan di Diagnostik diberi label **Reinstall Agent (keep data)** dan dirancang untuk mempertahankan data. Meski begitu, hindari mengganggu proses pemeliharaan dan verifikasi Agent setelah proses selesai.

### Haruskah saya mereset konfigurasi model untuk setiap error model?

Tidak. Periksa dulu [Konfigurasi Model](./model.md) untuk model dan kredensial yang dipilih, lalu pastikan penyedia memang tersedia. Reset hanya ketika konfigurasinya sendiri perlu dibangun kembali.

## Langkah berikutnya

- Kembali ke [Chat Agent](./agent-chat.md) untuk menguji Agent yang sudah diperbaiki.
- Tinjau [Konfigurasi Model](./model.md) atau [Beberapa Model](./multiple-models.md) untuk masalah terkait model.
- Periksa [File](./files.md) jika ada tugas yang bergantung pada file yang hilang atau tidak dapat diakses.
