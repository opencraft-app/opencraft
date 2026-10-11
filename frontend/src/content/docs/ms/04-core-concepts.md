# Konsep Teras

## Ringkasan

**LightVela mempunyai lima konsep teras: seorang Hermes Agent adalah instans cloud; Bot adalah profil berasingan di dalamnya; setiap Bot mempunyai tetapan model, saluran pesanan yang disambungkan, dan Kemahiran yang boleh dipasang. Bot boleh mengekalkan persona, memori, dan tugas berjadual secara berasingan. Saluran yang disambungkan ke Bot yang sama berkongsi tingkah lakunya, manakala Bot yang berbeza tidak berkongsi tetapan mereka secara automatik. Apabila mesej tiba melalui saluran, Bot yang dipilih mungkin menggunakan Kemahiran dan model, dan balasan dihantar kembali melalui saluran itu.**

---

LightVela mempunyai lima konsep berkaitan: Hermes Agent, Bot, model, saluran, dan Kemahiran. Halaman ini menjelaskan bagaimana mereka saling berkaitan.

## Halaman ini meliputi

- Hubungan antara lima konsep

- Ciri-ciri contoh Hermes Agent

- Titik masuk kedudukan dan konfigurasi model, saluran dan kemahiran

- Aliran dalaman perbualan yang lengkap

---

## Hubungan konsep

```text
Hermes Agent (cloud instance)
  └─ Bot profiles (main Bot and optional additional Bots)
       ├─ Primary model and optional fallbacks
       ├─ Connected channels
       └─ Skills, Soul, memory, scheduled tasks
```

| Konsep | Peranan | Penerangan |
|---|---|---|
| Hermes Agent | Instans awan | Persekitaran yang menempatkan profil Bot |
| Bot | Profil bebas | Mempunyai model, saluran, Kemahiran, persona, memori, dan tugas berjadual sendiri |
| Model | Kebolehan bahasa | Model bahasa yang digunakan oleh Bot |
| Saluran | Titik masuk interaksi | Platform di mana pengguna bersembang dengan Bot |
| Kemahiran | Sambungan kebolehan | Pakej kebolehan tambahan yang boleh dipanggil oleh Bot |


---

## Hermes Agent

Hermes Agent ialah contoh Ejen AI dalam LightVela. Mencipta Hermes Agent adalah setara dengan memulakan tika Ejen bebas dalam awan.

Hermes Agent mempunyai ciri-ciri berikut:

- **Persekitaran awan khusus**: Setiap Hermes Agent dijalankan dalam persekitarannya sendiri, dengan sumber yang dipisahkan daripada instans lain

- **Memori yang berterusan**: Kandungan perbualan disimpan merentas sesi dan Ejen menggunakan konteks sejarah apabila bertindak balas

- **Sentiasa dalam talian**: Berjalan 24/7 dan tidak bergantung pada peranti setempat pengguna

Pelan Pelancaran semasa menyokong mencipta sehingga 1 tika Hermes Agent.

---

## Bot

Setiap Hermes Agent mempunyai Bot utama dan mungkin menyokong Bot tambahan, bergantung pada had pelan dan ketersediaan. Bot berada dalam instans awan yang sama tetapi menyimpan tetapan dan data mereka secara berasingan. Pilih Bot yang dimaksudkan sebelum menukar model, saluran, Kemahiran, atau memori. Lihat [Urus Bot](./configuration/bots.md).

---

## Model

Model ialah model bahasa besar (LLM) yang memacu pemikiran dan tindak balas Hermes Agent. LightVela tidak melatih model itu sendiri. Sebaliknya, pengguna memilih kaedah panggilan dalam kad "Model" konsol:

| Kaedah | Mod pengebilan | Sumber Kunci API | Kes penggunaan |
|---|---|---|---|
| Pelan Pengekodan Model | Bulanan | Pembekal | Penggunaan frekuensi tinggi |
| API Model | Bayar semasa anda pergi | Pembekal | Penggunaan atau percubaan frekuensi rendah |
| Model tersuai | Bergantung pada titik akhir | Diberikan pengguna | Sambungkan model luar negara atau titik akhir serasi OpenAI |

Selain itu, pelan Pelancaran termasuk 100 kredit percubaan, jadi anda boleh bersembang di luar kotak tanpa sebarang konfigurasi; selepas kredit percubaan habis, anda boleh mengkonfigurasi Kunci API anda sendiri.

Untuk model yang disokong, pemerolehan Kunci API dan panduan pemilihan model, lihat [Konfigurasikan Model](./configuration/model.md).

> Bot menggunakan satu model utama pada satu-satu masa. Model tambahan yang telah dikonfigurasi atau sandaran boleh tersedia; menukar model aktif tidak memerlukan penghapusan konfigurasi sebelumnya. Lihat [Penukaran Model](./configuration/multiple-models.md).

---

## Saluran

Saluran ialah titik masuk platform pemesejan tempat pengguna bersembang dengan Hermes Agent. LightVela kini menyokong saluran berikut:

| Saluran | Kaedah akses | Kes penggunaan |
|---|---|---|
| WeChat | Kebenaran kod QR | Penggunaan peribadi harian, sesuai untuk pengguna di China |
| Telegram | Akses Token Bot | Peringkat individu atau pasukan, persediaan mudah, sesuai untuk automasi ringan |
| WhatsApp | Imbas kod QR | Komunikasi pengguna antarabangsa, khidmat pelanggan, pemberitahuan, dan peringatan |
| Discord | Akses Token Bot | Operasi komuniti, komuniti pembangun, kumpulan permainan atau minat |
| Slack | Akses Token Bot / Token Aplikasi | Kerjasama pasukan, pemberitahuan ruang kerja, dan aliran kerja berasaskan saluran |

Pada kad **WeChat** dalam **Saluran**, pilih **+ Sambung** dan imbas kod QR dengan telefon anda.

Langkah akses terperinci untuk setiap saluran: [Konfigurasikan Saluran - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) [Slack](./configuration/channel-slack.md).

> 💡 **Pelbagai saluran boleh wujud serentak**
>
> Saluran yang disambungkan kepada Bot yang sama berkongsi persona dan ingatan Bot tersebut. Saluran yang disambungkan kepada Bot yang berbeza tidak secara automatik berkongsi tetapan tersebut.

---

## Kemahiran

Kemahiran ialah pakej keupayaan tambahan yang boleh dipanggil oleh Hermes Agent. Mereka melanjutkan Hermes Agent menjangkaui perbualan asas untuk tugasan tertentu seperti mengatur tugasan, menjana laporan harian, menyemak imbas web, menjana imej dan banyak lagi.

Kemahiran tersedia dari [Skills.sh](https://skills.sh/) dan [ClawHub](https://clawhub.ai/). Telusuri sumber-sumber ini di halaman konsol **Skills** dan semak keputusan sebelum memasang.

Buka **Kemahiran** dalam konsol, cari Kemahiran individu atau semak **Pakej Kemahiran**, kemudian pilih **Pasang**. Semak tab **Dipasang** untuk mengesahkan hasilnya. Lihat [Konfigurasikan Kemahiran](./configuration/skill.md).

> ⚠️ **Pemeriksaan keselamatan sebelum pemasangan**
>
> Kemahiran mempunyai kebenaran untuk memanggil Hermes Keupayaan ejen pada masa jalan. Sebelum memasang kemahiran, sahkan bahawa pengarang boleh dipercayai dan lebih suka kemahiran dengan muat turun yang tinggi dan penilaian yang baik.

---

## Aliran interaksi

Aliran perbualan yang lengkap berfungsi seperti berikut:

1. Pengguna menghantar mesej kepada Hermes Agent melalui saluran (seperti WeChat)

2. Hermes Agent menentukan sama ada sesuatu kemahiran perlu dipanggil berdasarkan mesej

3. Model memproses konteks dan menghasilkan tindak balas

4. Respons kembali kepada pengguna melalui saluran asal

---

## Langkah seterusnya

- [Gambaran Keseluruhan Konfigurasi](./05-configuration.md) — Panduan ciri konsol penuh

- [Mula Pantas](./02-quickstart.md) — Bermula apabila tiada Hermes Agent telah dibuat
