# Apa Itu LightVela

## Ringkasan

**LightVela adalah produk hosting Agent berbasis cloud dari tim Tencent Lighthouse, dan produk yang tersedia saat ini adalah Hermes Agent — sebuah AI Agent yang dibangun di atas model bahasa besar. LightVela menangani deployment, operasional, dan ketersediaan 24/7 sepenuhnya di cloud, sehingga Anda tidak perlu menulis file konfigurasi atau masuk ke server: cukup atur semuanya dengan mengeklik pada panel visual, lalu berbicara dengan Agent Anda melalui aplikasi pesan yang sudah Anda gunakan. Agent mengingat Anda lintas percakapan, dan Anda yang menentukan model, alat, serta persona. Paket dan penawaran pengguna baru saat ini dapat dilihat di [halaman Subscribe](/subscribe/).**

---

> Hermes Agent berbasis cloud yang makin memahami Anda seiring waktu.

LightVela adalah produk hosting Agent berbasis cloud dari tim Tencent Lighthouse. Tujuannya sederhana: membantu setiap orang memiliki **pendamping AI yang benar-benar terasa milik sendiri**. Bukan alat yang setiap kali harus diajak berkenalan dari awal, melainkan kehadiran jangka panjang yang **mengenal Anda, mengingat Anda, dan makin memahami kebutuhan Anda seiring waktu**.

Agent Anda tetap online 24/7, berjalan mandiri, dan selalu siap diajak bicara. Anda yang menentukan model, alat, dan personanya.

LightVela menurunkan hambatan konfigurasi lewat konsol visual. Tidak perlu menulis file konfigurasi, tidak perlu masuk ke server, cukup pilih opsi yang tersedia di halaman web.

Produk LightVela saat ini adalah **Hermes Agent**, AI Agent yang didukung large language model. Produk siap pakai lain dapat ditambahkan di masa mendatang. Dokumentasi ini berfokus pada Hermes Agent.

![1.00](../images/1-1.webp)

***

## Untuk siapa

* Pengguna yang ingin memakai AI Agent, tetapi tidak ingin berurusan dengan server, container, autentikasi API, atau infrastruktur terkait

* Pengguna yang lebih nyaman berinteraksi dengan AI lewat aplikasi chat sehari-hari seperti Telegram, WhatsApp, Discord, Slack, atau WeChat, bukan lewat aplikasi terpisah

* Pengguna yang ingin memilih dari beberapa penyedia large language model, termasuk ChatGPT, Claude, Gemini, Deepseek, Qwen, Zhipu, Hunyuan, dan lainnya

* Pengguna yang membutuhkan memori percakapan berkelanjutan, bukan memulai dari nol di setiap obrolan

## Kurang cocok untuk

* Pengguna yang wajib menjalankan semuanya secara lokal tanpa ada data yang keluar dari perangkat

* Pengguna yang perlu melatih atau melakukan fine-tuning pada model dasar

* Developer yang ingin menyematkan Agent ke website atau aplikasi miliknya sendiri

***

## Fitur produk

* **Deployment terkelola penuh**: Cloud menangani penyiapan lingkungan dan pengelolaan runtime secara otomatis. Tidak perlu operasional server, image container, atau pengetahuan infrastruktur

* **Lingkungan cloud khusus**: Setiap instans Hermes Agent memiliki lingkungan cloud sendiri, sumber daya terisolasi, tersedia 24/7, dan tidak bergantung pada perangkat lokal

* **Dukungan multi-model**: Hubungkan model besar arus utama dari Tiongkok, langganan Coding Plan penyedia model, atau endpoint yang kompatibel dengan OpenAI. Lihat [Ringkasan Konfigurasi](./05-configuration.md#2-model)

* **Akses multi-kanal**: Chat dengan Hermes Agent lewat Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom, dan Lark

* **Ekstensi Skill**: Cari dan pasang Skill atau Paket Skill dari [Skills.sh](https://skills.sh/) dan [ClawHub](https://clawhub.ai/) di konsol

* **Siap dipakai**: Paket Launch menyertakan kredit uji coba, sehingga Anda bisa mulai chat setelah aktivasi tanpa perlu mengatur model secara terpisah

* **Penyimpanan cloud khusus**: Data percakapan dan memori disimpan secara terpisah untuk instans Anda

***

## Cara kerjanya

LightVela menjalankan satu instans Hermes Agent khusus untuk setiap pengguna di cloud, lalu menghubungkannya ke platform chat pilihan pengguna melalui lapisan adapter.

```
Pengguna (mengirim pesan di Telegram / WhatsApp / Discord / Slack / WeChat)
      ↓
Instans Hermes Agent khusus milik pengguna di cloud LightVela
      ↓
Memanggil large language model yang dikonfigurasi (GPT / Claude / Gemini / ...)
      ↓
Balasan dikirim kembali lewat kanal asal
```

Satu alur percakapan lengkap membutuhkan tiga konfigurasi:

1. **Model**: Large language model yang dipanggil oleh Hermes Agent. Paket Launch menyertakan kredit uji coba dan bisa langsung digunakan; Anda juga dapat mengatur API Key sendiri

2. **Kanal**: Platform chat yang digunakan untuk berbicara dengan Hermes Agent, seperti Telegram, WhatsApp, Discord, Slack, atau WeChat

3. **Skill** (opsional): Kemampuan tambahan untuk Hermes Agent

![1.00](../images/1-2.webp)

***

## Tentang paket

Satu paket menyediakan satu instans cloud Hermes Agent. Seri Launch mendukung hingga 5 Bot di dalam instans tersebut, sedangkan seri Cruise mendukung hingga 10. Bot adalah profil terpisah, bukan instans Hermes tambahan.

| Opsi paket | Kredit model per bulan | Bot |
|---|---:|---:|
| Launch | 100 | 5 |
| Launch AI | 4.500 | 5 |
| Cruise | 200 | 10 |
| Cruise AI | 10.000 | 10 |

Harga, promo pengguna baru, dan ketersediaan dapat berubah. Periksa [halaman Subscribe](/subscribe) sebelum membeli. Pengguna dengan paket aktif juga dapat membeli [paket kredit model](./credits.md) sekali bayar.
***

## Hubungan dengan Lighthouse (opsional)

Bagi pengguna yang sudah mengenal Tencent Cloud: LightVela dapat dipahami sebagai kemasan siap pakai untuk kemampuan deployment Agent cloud dari Tencent Lighthouse. LightVela menyederhanakan konsep seperti akun Tencent Cloud, pengelolaan sumber daya, dan operasi cloud, lalu menyisakan dua aksi utama: mengatur Agent dan menghubungkannya ke platform chat.

Jika Anda baru mengenal Agent cloud, bagian ini boleh dilewati.

***

## Langkah berikutnya

* **[Panduan Cepat](./02-quickstart.md)** — Selesaikan percakapan pertama Anda dalam 5 menit

* **[Konsep Inti](./04-core-concepts.md)** — Pahami lima konsep utama: Hermes Agent, Bot, model, kanal, dan Skill

* **[Ringkasan Konfigurasi](./05-configuration.md)** — Fitur konsol dan alur konfigurasi
