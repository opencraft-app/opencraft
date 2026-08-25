# Konfigurasi Model

## Ringkasan

**Mengonfigurasi model tidak wajib: paket Anda sudah menyertakan kredit model bulanan, sehingga setelah membuat Agent dan menghubungkan kanal Anda bisa langsung berbicara, dan baru mengatur model setelah kredit habis. Bagian Model pada konsol menyediakan tiga opsi: Model Coding Plan (bulanan atau tahunan, cocok untuk pemakaian intens), Model API (bayar sesuai pemakaian, cocok untuk pemakaian ringan atau uji coba), dan model kustom (menghubungkan endpoint yang kompatibel dengan OpenAI). Ketiganya memerlukan API key Anda sendiri dari penyedia terkait. Langkahnya: pilih sumber, pilih model, tempelkan API key, lalu jadikan default. Anda dapat berganti model nanti tanpa kehilangan memori. API key adalah kredensial sensitif — jangan dikirim ke grup obrolan atau halaman publik, jangan dimasukkan ke repositori Git, dan segera cabut atau ganti di konsol penyedia jika bocor.**

---

Halaman ini menjelaskan cara mengonfigurasi large language model untuk Hermes Agent, termasuk perbedaan antara tiga metode konfigurasi, cara mendapatkan API Key, langkah konfigurasi di konsol, model yang didukung, dan panduan memilih model.

> 💡 **Konfigurasi bersifat opsional**
>
> Paket Launch menyertakan 100 kredit uji coba. Setelah membuat Hermes Agent dan menghubungkan kanal, Anda bisa langsung mulai mengobrol. Konfigurasikan model setelah kredit tersebut habis.

---

## Yang dibahas di halaman ini

- Perbedaan antara tiga metode konfigurasi (Coding Plan / API / Custom Model)

- Cara mendapatkan API Key

- Langkah konfigurasi di konsol

- Penggantian model

- Model yang didukung

- Panduan memilih model


---

## Tiga metode konfigurasi

Dropdown tingkat pertama pada kartu "Model" di konsol menyediakan tiga opsi:

| Metode | Mode penagihan | Sumber API Key | Kasus penggunaan |
| --- | --- | --- | --- |
| Model Coding Plan | Bulanan / tahunan | Penyedia | Penggunaan intensitas tinggi |
| Model API | Bayar sesuai pemakaian | Penyedia | Penggunaan ringan atau uji coba |
| Custom model | Bergantung pada endpoint | Disediakan pengguna | Menghubungkan model luar negeri atau endpoint yang kompatibel dengan OpenAI |

> ⚠️ **Siapkan API Key Anda sendiri**
>
> Ketiga metode tersebut membutuhkan API Key milik Anda sendiri. Silakan mendaftar ke penyedia terkait dan buat Key terlebih dahulu.

---

## Alur umum mendapatkan API Key

Antarmuka tiap penyedia berbeda, tetapi alurnya umumnya sama:

1. **Kunjungi situs penyedia**: Setelah memilih model di kartu model pada konsol, tautan "Get API KEY" akan muncul di bawahnya. Klik tautan tersebut untuk membuka situs penyedia

2. **Daftar atau masuk**: Sebagian besar platform Tiongkok mendukung login via WeChat atau nomor telepon

3. **Selesaikan verifikasi nama asli**: Penyedia model Tiongkok umumnya mewajibkan verifikasi nama asli sebelum pemanggilan API diizinkan

4. **Buka halaman pengelolaan API Key**: Biasanya berada di "Konsol → API Management / Key Management / Credentials"

5. **Buat Key baru**: Beri nama Key tersebut (misalnya `LightVela`) dan segera salin setelah dibuat. Sebagian besar platform hanya menampilkan Key lengkap satu kali

6. **Kembali ke LightVela dan tempel Key tersebut**


> ⚠️ **API Key adalah kredensial sensitif**
>
> Jangan mengirim Key ke grup chat, memublikasikannya di halaman web, atau meng-commit-nya ke repositori Git. Jika Key bocor, segera cabut atau reset Key tersebut di konsol penyedia.

---

## Konfigurasi di konsol

Masuk ke konsol lalu buka tombol "Model".

### Langkah konfigurasi

1. **Pilih sumber** (dropdown tingkat pertama): Model API / Model Coding Plan / Custom Model

2. **Pilih model spesifik** (dropdown tingkat kedua): Model yang tersedia ditampilkan berdasarkan sumber yang dipilih di atas

3. **Masukkan API Key**: Tempel Key yang sudah Anda peroleh. Ikon mata di sebelah kanan mengatur visibilitas

4. **Klik "Add as default"**

5. Catatan terkait akan muncul di daftar "Current model", menandakan konfigurasi berhasil


![](../images/5-1.webp)

### Kolom tambahan untuk custom model

Saat memilih "Custom Model", biasanya Anda perlu mengisi kolom berikut selain API Key:

- **Base URL**: Alamat API layanan model, misalnya `https://api.openai.com/v1`

- **Model Name**: Pengenal model, misalnya `gpt-4o` atau `claude-3-5-sonnet-20241022`


Kolom yang sebenarnya mengikuti antarmuka konsol.

> 💡 **Cara mengonfigurasi custom model (seperti OpenAI GPT, Google Gemini, dan lainnya)**
>
> Selain model umum yang tercantum di konsol, seperti MiniMax, Kimi, dan Zhipu GLM, pengguna juga dapat mengonfigurasi OpenAI GPT, Google Gemini, Claude, atau model lain yang tidak ada di daftar melalui "Custom Model".

---

## Mengganti model

### Cara mengganti

Jalankan kembali langkah konfigurasi. Aksi "Add as default" yang baru akan menimpa konfigurasi sebelumnya.

> ⚠️ **Hanya satu model yang aktif**
>
> Saat ini, setiap Hermes Agent hanya dapat memiliki satu model aktif. Untuk membandingkan performa model yang berbeda, konfigurasikan dan coba satu per satu.

### Dampak pada memori

Mengganti model tidak memengaruhi memori percakapan. Memori merupakan milik Hermes Agent itu sendiri; model hanya bertanggung jawab menghasilkan balasan.

---

## Model yang didukung

### Model Coding Plan (bulanan)

| Nama | Penyedia |
| --- | --- |
| Zhipu AI (GLM International - Coding Plan) | Zhipu AI |
| Kimi Coding Plan | Moonshot AI |
| Xiaomi Token Plan | Xiaomi |
| Bailian Coding Plan | Alibaba Cloud Bailian |
| Volcano Engine Ark Coding Plan | Volcano Engine (ByteDance) |

### Model API (bayar sesuai pemakaian)

| Nama | Penyedia |
| --- | --- |
| OpenAI | OpenAI |
| Anthropic | Anthropic |
| Google Gemini | Google |
| OpenRouter | OpenRouter |
| DeepSeek | DeepSeek |
| Bailian (Qwen) | Alibaba |
| MiniMax (International) | MiniMax |
| Moonshot AI (Kimi International) | Moonshot |
| Zhipu AI (GLM International) | Zhipu |
| Volcano Engine (Doubao) | ByteDance |
| Xiaomi MiMo | Xiaomi |

### Custom model

Endpoint apa pun yang kompatibel dengan protokol OpenAI Chat Completions dapat dihubungkan, termasuk:

- Model yang di-hosting sendiri: vLLM, Ollama, LM Studio, dan layanan lain yang menyediakan endpoint kompatibel OpenAI

- Platform agregasi: OpenRouter, dan sejenisnya


---

## Panduan memilih model

Arah pemilihan untuk prioritas yang berbeda:

| Prioritas | Arah yang disarankan |
| --- | --- |
| Kuota gratis | Banyak penyedia menawarkan kuota gratis untuk akun baru; mulai dengan uji coba |
| Pemrosesan konteks panjang | Pilih model dengan context window lebih besar (seperti Moonshot AI) |
| Kecepatan respons | Antar penyedia berbeda cukup jauh; andalkan pengalaman aktual |
| Pemahaman bahasa Tiongkok | Model Tiongkok umumnya lebih baik dalam bahasa Tiongkok |
| Penggunaan intensitas tinggi | Pilih Coding Plan bulanan dari penyedia terkait |

Rekomendasi: pakai dulu kredit uji coba paket Launch untuk beberapa percakapan. Setelah memastikan Hermes Agent bekerja normal, tentukan model yang ingin Anda gunakan.

---

## FAQ

| Masalah | Kemungkinan penyebab | Solusi |
| --- | --- | --- |
| "Current model" tetap kosong setelah memasukkan Key | Format Key salah atau mengandung spasi | Salin dan tempel ulang; pastikan tidak ada spasi di awal atau akhir |
| Tidak ada respons dalam waktu lama setelah mengirim pesan | Saldo penyedia tidak cukup atau Key dinonaktifkan | Periksa saldo dan status Key di konsol penyedia |
| Isi balasan berupa karakter acak atau tidak bermakna | Endpoint custom model tidak kompatibel dengan protokol OpenAI | Verifikasi ketersediaan endpoint dengan klien kompatibel OpenAI lain terlebih dahulu |
| "Model response timeout" | Rate limit penyedia atau jaringan tidak stabil | Coba lagi nanti atau ganti ke penyedia lain |
| Tidak yakin dengan Base URL suatu custom model | — | Periksa dokumentasi API layanan terkait; biasanya berformat `https://xxx.com/v1` |

### Error percakapan "HTTP 401:InvalidAuthentication" atau error 401 sejenis

Jika `HTTP 401:InvalidAuthentication` atau error `401 xxx` lain muncul saat percakapan dengan OpenClaw, biasanya penyebabnya salah satu dari berikut:

1. API Key model dikonfigurasi dengan salah;

2. API Key Coding Plan tertukar dengan API Key model biasa;

3. Versi domestik atau internasional dari penyedia model dipilih dengan salah.


Jika ini terjadi, periksa kembali konfigurasi model Anda.

---

## Langkah berikutnya

- [Kanal WeChat](./channel-wechat.md)

- [Kanal Telegram](./channel-telegram.md)

- [Kanal WhatsApp](./channel-whatsapp.md)

- [Kanal Discord](./channel-discord.md)

- [Kanal Slack](./channel-slack.md)

- [Kanal QQ](./channel-qq.md)

- [Kanal WeCom](./channel-wecom.md)

- [Kanal Lark](./channel-feishu.md)

- [Konfigurasi Skill](./skill.md)
