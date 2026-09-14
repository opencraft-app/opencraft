# Mengatur Tugas Notifikasi di LightVela

Tugas notifikasi adalah penerapan sederhana untuk Agent yang dihosting di cloud karena dapat mengirim pesan tetap sesuai jadwal tanpa memanggil model AI.
Gunakan ketika Anda membutuhkan pengingat yang tiba pada waktu yang tepat, melalui kanal yang tepat, dengan kata-kata persis seperti yang Anda berikan.
Pengguna memakainya untuk pengingat minum air dan obat, serta pengingat tagihan dan perpanjangan langganan.

## Masalah umum yang dapat diselesaikan notifikasi

Kita biasanya tidak melupakan tugas penting karena tidak peduli.
Beberapa tindakan kecil tetapi penting mudah terlewat ketika pekerjaan sedang sibuk.

- Anda lupa minum air saat sesi kerja panjang.
- Obat diminum lebih lambat dari rencana.
- Perpanjangan langganan tenggelam di kotak masuk.
- Tagihan baru diingat setelah tanggal jatuh temponya.

Di LightVela, Anda dapat mengonfigurasi tugas Notifikasi dengan pesan, jadwal, jendela waktu efektif, dan kanal pengiriman.
Pesan dikirim persis seperti yang ditulis tanpa memanggil model, sehingga tidak mengonsumsi token model.
Dokumentasi [Tugas Terjadwal](https://lightvela.ai/docs/configuration/automation?from=social_x) menjelaskan pilihan penjadwalan dan notifikasi yang tersedia.

## Kasus 1: Pengingat kesehatan harian

Setiap hari pukul 10.30 dan 15.30, tugas Notifikasi mengirim pengingat singkat yang sama.

Pesan:

> Saatnya minum segelas air dan beristirahat sebentar.

![Mengedit tugas notifikasi berulang untuk pengingat kesehatan harian](../images/scheduled-task-notifications-1.png)

Kuncinya adalah membuat pesan singkat dan dapat ditindaklanjuti.
Karena tidak diteruskan ke model, notifikasi tidak akan ditulis ulang atau diberi konteks tambahan.

## Kasus 2: Pengingat pembayaran bulanan

Pada hari pertama setiap bulan, tugas Notifikasi mengingatkan Anda untuk meninjau pembayaran mendatang.

Pesan:

> Pemeriksaan pembayaran bulanan: tinjau sewa, tagihan utilitas, dan langganan yang jatuh tempo minggu ini.

![Mengedit tugas notifikasi bulanan untuk pengingat pembayaran](../images/scheduled-task-notifications-2.png)

Notifikasi membuat setiap pembayaran tetap terlihat sebelum tenggat waktunya.
Jika tagihan memiliki tanggal jatuh tempo berbeda, buat tugas terpisah agar setiap pengingat tiba saat berguna.

## Memperbarui saya langsung di IM

LightVela memungkinkan Anda menghubungkan Agent ke WhatsApp, Telegram, WeChat, Discord, dan lainnya.
Anda dapat menghubungkan satu atau beberapa kanal pada saat yang sama.
Di Tugas Terjadwal, Anda dapat mengaktifkan setiap kanal yang dikonfigurasi untuk menentukan tempat pengiriman notifikasi.

![Notifikasi terjadwal dikirim langsung di Telegram](../images/scheduled-task-notifications-3.png)

Setelah diaktifkan, Hermes akan mengirim notifikasi persis seperti yang ditulis langsung ke IM Anda.
Anda tidak perlu membuka LightVela atau aplikasi lain untuk memeriksa pengingat.

## Mengelola beberapa tugas

Anda dapat membuat sebanyak mungkin tugas terjadwal yang dibutuhkan.
Setelah membuatnya, Anda dapat mengedit isi dan jadwalnya, menjedakannya, serta menelusuri eksekusi sebelumnya.
Dengan LightVela, Hermes Agent pribadi Anda dapat menjaga rutinitas penting tetap sesuai jadwal saat Anda fokus pada pekerjaan lain.

![Daftar tugas saat ini dengan tugas notifikasi](../images/scheduled-task-notifications-4.png)
