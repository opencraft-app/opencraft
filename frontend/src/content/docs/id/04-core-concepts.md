# Konsep Inti

## Ringkasan

**LightVela memiliki empat konsep inti. Hermes Agent adalah entitas percakapan yang berjalan di cloud, dengan lingkungan runtime tersendiri, memori yang bertahan lintas percakapan, dan ketersediaan 24/7. Model adalah model bahasa besar yang dipanggilnya — bisa Model Coding Plan (bulanan), Model API (bayar sesuai pemakaian), atau endpoint kustom yang kompatibel dengan OpenAI. Kanal adalah pintu masuk platform pesan tempat Anda berbicara dengannya; beberapa kanal dapat terhubung ke Agent yang sama dan berbagi satu persona serta memori. Skill adalah paket kemampuan yang dapat dipasang untuk memperluas penanganan tugas tertentu. Alur satu percakapan lengkap: kanal menerima pesan → Agent menentukan perlu memanggil skill atau tidak → memanggil model untuk menghasilkan respons → balasan dikirim kembali melalui kanal yang sama.**

---

LightVela memiliki empat konsep utama: Hermes Agent, model, kanal, dan Skill. Halaman ini menjelaskan peran masing-masing. Untuk langkah konfigurasi detail, lihat halaman konfigurasi terkait.

## Yang dibahas di halaman ini

- Hubungan antara empat konsep utama

- Karakteristik satu instans Hermes Agent

- Posisi dan titik konfigurasi model, kanal, dan Skill

- Alur internal dari satu percakapan lengkap

---

## Hubungan konsep

```
┌──────────────────────────────────────────────────────────────┐
│                         Hermes Agent                         │
│              (Agent yang berjalan di cloud LightVela)         │
└──────────────────────────────────────────────────────────────┘
      │                          │                        │
┌─────┘                          │                        └──────┐
▼                                ▼                               ▼
┌───────┐                   ┌────────┐                   ┌────────┐
│ Model │                   │ Kanal  │                   │ Skill  │
└───────┘                   └────────┘                   └────────┘
 Penyedia model      Telegram/WhatsApp/Discord/Slack/WeChat      SkillHub
```

| Konsep | Peran | Deskripsi |
|---|---|---|
| Hermes Agent | Subjek percakapan | Instans AI Agent itu sendiri |
| Model | Kemampuan bahasa | Large language model yang dipanggil Hermes Agent |
| Kanal | Pintu masuk interaksi | Platform tempat pengguna chat dengan Hermes Agent |
| Skill | Ekstensi kemampuan | Paket kemampuan tambahan yang dapat dipanggil Hermes Agent |

![](./images/3-1.webp)

---

## Hermes Agent

Hermes Agent adalah instans AI Agent di LightVela. Membuat Hermes Agent sama artinya dengan menjalankan satu instans Agent mandiri di cloud.

Hermes Agent memiliki karakteristik berikut:

- **Runtime terisolasi**: Setiap Hermes Agent berjalan di lingkungan khusus yang terpisah dari instans lain

- **Memori berkelanjutan**: Isi percakapan tersimpan lintas sesi, dan Agent dapat memakai konteks sebelumnya saat menjawab

- **Selalu online**: Berjalan 24/7 dan tidak bergantung pada perangkat lokal pengguna

Paket Launch saat ini mendukung pembuatan maksimal 1 instans Hermes Agent.

---

## Model

Model adalah large language model (LLM) yang menggerakkan cara Hermes Agent berpikir dan merespons. LightVela tidak melatih model sendiri. Pengguna memilih cara pemanggilan model di kartu "Model" pada konsol:

| Metode | Mode penagihan | Sumber API Key | Cocok untuk |
|---|---|---|---|
| Model Coding Plan | Bulanan | Penyedia model | Penggunaan intensif |
| Model API | Bayar sesuai pemakaian | Penyedia model | Penggunaan ringan atau uji coba |
| Custom model | Bergantung endpoint | Disediakan pengguna | Menghubungkan model luar negeri atau endpoint kompatibel OpenAI |

Selain itu, paket Launch menyertakan 100 kredit uji coba. Anda bisa langsung chat tanpa konfigurasi apa pun; setelah kredit uji coba habis, Anda dapat mengatur API Key sendiri.

Untuk model yang didukung, cara mendapatkan API Key, dan panduan memilih model, lihat [Ringkasan Konfigurasi](./05-configuration.md#2-model).

> ⚠️ **Hanya satu model yang aktif**
>
> Saat ini, setiap Hermes Agent hanya dapat memiliki satu konfigurasi model aktif. Untuk mengganti model, gunakan "Jadikan default" agar konfigurasi sebelumnya ditimpa.

---

## Kanal

Kanal adalah pintu masuk dari platform chat tempat pengguna berbicara dengan Hermes Agent. LightVela saat ini mendukung kanal berikut:

| Kanal | Cara akses | Cocok untuk |
|---|---|---|
| WeChat | Otorisasi kode QR | Penggunaan pribadi sehari-hari, terutama untuk pengguna di Tiongkok |
| Telegram | Akses Bot Token | Pesan pribadi atau tim, setup sederhana, cocok untuk tugas terjadwal ringan |
| WhatsApp | Akses WhatsApp Business API | Komunikasi pengguna internasional, layanan pelanggan, notifikasi, dan pengingat |
| Discord | Akses Bot Token | Operasi komunitas, komunitas developer, gim, atau grup minat |
| Slack | Akses Bot Token / App Token | Kolaborasi tim, notifikasi workspace, dan workflow berbasis channel |

Untuk WeChat, pilih kanal lalu klik "Izinkan akses" untuk membuat kode QR. Pindai dengan ponsel untuk menyelesaikan otorisasi.

Ringkasan cara akses tiap kanal tersedia di [Ringkasan Konfigurasi](./05-configuration.md#1-kanal).

> 💡 **Beberapa kanal bisa dipakai bersamaan**
>
> Beberapa kanal dapat terhubung ke instans Hermes Agent yang sama dan berbagi memori serta perilaku Agent. Dari kanal mana pun pesan dikirim, target percakapannya tetap Hermes Agent yang sama.

---

## Skill

Skill adalah paket kemampuan tambahan yang dapat dipanggil oleh Hermes Agent. Skill memperluas Hermes Agent di luar percakapan dasar, misalnya untuk menyusun to-do, membuat laporan harian, menjelajah web, membuat gambar, dan lainnya.

Semua Skill berasal dari [SkillHub](https://skillhub.tencent.com), marketplace Skill independen dari Tencent. Di SkillHub, Anda dapat melihat Skill yang tersedia, deskripsi fitur, dan contoh penggunaannya.

Masukkan nama Skill yang tertera di SkillHub ke kartu "3. Skill" pada konsol, lalu klik "Instal Skill" untuk menginstalnya. Anda juga bisa meminta Hermes Agent langsung lewat percakapan untuk menginstal atau menghapus Skill. Lihat [Ringkasan Konfigurasi](./05-configuration.md#3-skill).

> ⚠️ **Periksa keamanan sebelum instalasi**
>
> Skill memiliki izin untuk memanggil kemampuan Hermes Agent saat runtime. Sebelum menginstal Skill, pastikan pembuatnya dapat dipercaya dan utamakan Skill dengan jumlah unduhan tinggi serta rating yang baik.

---

## Alur interaksi

Satu alur percakapan lengkap berjalan seperti ini:

1. Pengguna mengirim pesan ke Hermes Agent melalui kanal, misalnya WeChat

2. Hermes Agent menentukan apakah perlu memanggil Skill berdasarkan isi pesan

3. Model memproses konteks dan menghasilkan respons

4. Respons dikirim kembali ke pengguna lewat kanal asal

---

## Langkah berikutnya

- [Ringkasan Konfigurasi](./05-configuration.md) — Panduan lengkap fitur konsol

- [Panduan Cepat](./02-quickstart.md) — Mulai saat belum ada Hermes Agent yang dibuat
