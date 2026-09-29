# Konsep Inti

## Ringkasan

**LightVela memiliki lima konsep inti: Hermes Agent adalah instans cloud; Bot adalah profil terpisah di dalamnya; setiap Bot memiliki pengaturan model, kanal pesan, dan Skill, serta dapat menyimpan persona, memori, dan tugas terjadwal sendiri. Kanal milik Bot yang sama berbagi perilakunya, sedangkan pengaturan antar-Bot tidak otomatis sama. Pesan masuk melalui kanal, Bot tujuan dapat memakai Skill dan model, lalu membalas lewat kanal asal.**

---

Lima konsep LightVela adalah Hermes Agent, Bot, model, kanal, dan Skill. Halaman ini menjelaskan hubungan di antaranya.

## Yang dibahas di halaman ini

- Hubungan antara lima konsep

- Karakteristik satu instans Hermes Agent

- Posisi dan titik konfigurasi model, kanal, dan Skill

- Alur internal dari satu percakapan lengkap

---

## Hubungan konsep

```text
Hermes Agent (cloud instance)
  └─ Bot profiles (main Bot and optional additional Bots)
       ├─ Primary model and optional fallbacks
       ├─ Connected channels
       └─ Skills, Soul, memory, scheduled tasks
```

| Konsep | Peran | Deskripsi |
|---|---|---|
| Hermes Agent | Subjek percakapan | Instans AI Agent itu sendiri |
| Bot | Profil terpisah | Memiliki model, kanal, Skill, persona, memori, dan tugas terjadwal sendiri |
| Model | Kemampuan bahasa | Large language model yang dipanggil Hermes Agent |
| Kanal | Pintu masuk interaksi | Platform tempat pengguna chat dengan Hermes Agent |
| Skill | Ekstensi kemampuan | Paket kemampuan tambahan yang dapat dipanggil Hermes Agent |


---

## Hermes Agent

Hermes Agent adalah instans AI Agent di LightVela. Membuat Hermes Agent sama artinya dengan menjalankan satu instans Agent mandiri di cloud.

Hermes Agent memiliki karakteristik berikut:

- **Lingkungan cloud khusus**: Setiap Hermes Agent berjalan di lingkungannya sendiri, dengan sumber daya terpisah dari instans lain

- **Memori berkelanjutan**: Isi percakapan tersimpan lintas sesi, dan Agent dapat memakai konteks sebelumnya saat menjawab

- **Selalu online**: Berjalan 24/7 dan tidak bergantung pada perangkat lokal pengguna

Paket Launch saat ini mendukung pembuatan maksimal 1 instans Hermes Agent.

---

## Bot

Setiap Hermes Agent memiliki Bot utama dan, bergantung pada kuota paket serta ketersediaan, dapat memiliki Bot tambahan. Semua Bot berada dalam instans cloud yang sama, tetapi pengaturan dan datanya terpisah. Pilih Bot tujuan sebelum mengubah model, kanal, Skill, atau memori. Lihat [cara beralih antar-Bot](./configuration/bots-switching.md).

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

> Setiap Bot memakai satu model utama pada satu waktu. Model lain atau fallback dapat dikonfigurasi; berpindah model aktif tidak perlu menghapus pengaturan sebelumnya. Lihat [Penggantian Model](./configuration/multiple-models.md).

---

## Kanal

Kanal adalah pintu masuk dari platform chat tempat pengguna berbicara dengan Hermes Agent. LightVela saat ini mendukung kanal berikut:

| Kanal | Cara akses | Cocok untuk |
|---|---|---|
Pada kartu **WeChat** di **Channels**, pilih **+ Connect** lalu pindai kode QR dengan ponsel.
| Telegram | Akses Bot Token | Pesan pribadi atau tim, setup sederhana, cocok untuk tugas terjadwal ringan |
| WhatsApp | Pindai kode QR dengan WhatsApp | Komunikasi pengguna internasional, layanan pelanggan, notifikasi, dan pengingat |
| Discord | Akses Bot Token | Operasi komunitas, komunitas developer, gim, atau grup minat |
| Slack | Akses Bot Token / App Token | Kolaborasi tim, notifikasi workspace, dan workflow berbasis channel |

Untuk WeChat, pilih kanal lalu klik "Izinkan akses" untuk membuat kode QR. Pindai dengan ponsel untuk menyelesaikan otorisasi.

Ringkasan cara akses tiap kanal tersedia di [Ringkasan Konfigurasi](./05-configuration.md#1-kanal).

> 💡 **Beberapa kanal bisa dipakai bersamaan**
>
> Kanal yang terhubung ke Bot yang sama berbagi persona dan memorinya. Pengaturan Bot lain tidak otomatis ikut berubah.

---

## Skill

Skill adalah paket kemampuan tambahan yang dapat dipanggil oleh Hermes Agent. Skill memperluas Hermes Agent di luar percakapan dasar, misalnya untuk menyusun to-do, membuat laporan harian, menjelajah web, membuat gambar, dan lainnya.

Skill di situs internasional tersedia dari [Skills.sh](https://skills.sh/) dan [ClawHub](https://clawhub.ai/). Jelajahi sumber tersebut di halaman **Skills** pada konsol dan periksa deskripsinya sebelum memasang.

Buka **Skills** di konsol, cari Skill atau jelajahi **Skill Packages**, lalu pilih **Install**. Periksa hasilnya di tab **Installed**. Lihat [Konfigurasi Skill](./configuration/skill.md).

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
