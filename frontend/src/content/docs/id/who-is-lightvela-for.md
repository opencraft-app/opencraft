# Untuk Siapa LightVela?

LightVela adalah produk Agent berbasis cloud dari tim Tencent Cloud Lighthouse. Produk ini ditujukan untuk **pengguna yang ingin punya pendamping AI pribadi yang selalu online, memahami konteks percakapan, dan makin membantu dari waktu ke waktu, tanpa perlu mengurus server, container, atau autentikasi API sendiri**. LightVela menangani deployment, operasional, dan ketersediaan 24/7 di cloud. Anda cukup mengatur Agent lewat konsol web, lalu berbicara dengan Hermes Agent melalui Telegram, WhatsApp, Discord, Slack, atau WeChat.

Jika Anda baru mulai mengenal produk ini, buka dulu [Apa Itu LightVela](./01-overview.md).

***

## Cocok untuk siapa

LightVela terutama cocok untuk:

* **Pengguna yang ingin AI Agent tanpa setup teknis**
  Anda tidak perlu memahami server, Docker, reverse proxy, atau autentikasi API. Setelah mengaktifkan paket yang tersedia, LightVela akan mengonfigurasi dan mengelola runtime cloud melalui konsol visual.

* **Pengguna yang ingin AI hadir di aplikasi chat yang sudah dipakai**
  Hermes terhubung ke Telegram, WhatsApp, Discord, Slack, dan WeChat melalui [kanal](./04-core-concepts.md). Anda bisa berbicara dengan Agent di tempat percakapan sehari-hari berlangsung, tanpa perlu berpindah ke aplikasi terpisah.

* **Pengguna yang ingin bebas memilih model bahasa**
  LightVela dapat terhubung ke ChatGPT, Claude, Gemini, DeepSeek, Qwen, Zhipu, Hunyuan, serta endpoint lain yang kompatibel dengan OpenAI. Lihat [Konfigurasi Model](./configuration/model.md) untuk detail pengaturan.

* **Pengguna yang membutuhkan memori lintas percakapan**
  Berbeda dari chatbot dasar, Hermes dapat menyimpan konteks percakapan dan memori jangka panjang lintas sesi, sehingga Anda tidak perlu memperkenalkan diri dari awal setiap kali berbicara.

* **Pengguna yang membutuhkan Agent mandiri dan tersedia 24/7**
  Setiap instans Hermes berjalan di lingkungan cloud yang terisolasi dan tetap tersedia tanpa bergantung pada apakah perangkat lokal Anda sedang online.

***

## Skenario penggunaan umum

LightVela cocok digunakan untuk:

* **Asisten AI pribadi** untuk pengingat, merapikan informasi, dan menjawab pertanyaan saat dibutuhkan. Lihat [Membangun Asisten AI Pribadi dengan LightVela](./use-cases/personal-ai-assistant.md).

* **Titik percakapan yang selalu tersedia** dengan menghubungkan Agent ke Telegram, WhatsApp, Discord, Slack, atau WeChat.

* **Tugas harian terjadwal** yang berjalan otomatis dan merangkum informasi yang penting bagi Anda.

* **Memori jangka panjang dan pengelolaan pengetahuan pribadi**, dengan Agent yang semakin berguna seiring penggunaan.

***

## Prasyarat

Sebelum mulai, siapkan:

* Akun Google atau GitHub untuk masuk ke LightVela. Situs internasional tidak memerlukan verifikasi nama asli China.

* Paket yang tersedia dan sudah diaktifkan dari halaman [Paket](/subscribe). Setelah beta publik dan penagihan dimulai, pengguna baru dapat mencoba Launch gratis selama 14 hari.

* Setidaknya satu akun aplikasi chat yang didukung, seperti Telegram, WhatsApp, Discord, Slack, atau WeChat.

Anda tidak memerlukan server sendiri atau pengalaman operasional.

***

## Jika masih ragu

LightVela mungkin kurang sesuai jika Anda membutuhkan deployment yang sepenuhnya lokal dan data tidak pernah keluar dari perangkat, ingin melatih atau melakukan fine-tuning foundation model, atau perlu menanamkan Agent langsung ke situs web maupun aplikasi milik sendiri.

***

## Langkah berikutnya

* **[Panduan Cepat](./02-quickstart.md)** — Selesaikan percakapan pertama dalam sekitar lima menit.

* **[Konsep Inti](./04-core-concepts.md)** — Pahami Hermes, model, kanal, dan Skill.
