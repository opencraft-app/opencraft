# Gambaran Keseluruhan Konfigurasi

## Ringkasan

**Konsol Ejen memisahkan Saluran, Model, Kemahiran, dan Tugasan Berjadual ke dalam halaman di bar sisi. Pilih Bot yang dimaksudkan sebelum menukar tetapannya. Sambungkan saluran mesej dari kadnya, pilih model atau gunakan kredit pelan, dan pasang Kemahiran dari Skills.sh atau ClawHub apabila diperlukan. Soul, Memory, Diagnostics, Advanced Settings, dan Labs tersedia di bahagian yang berasingan. Cloud Storage dibuka dari menu pengguna. Apabila Bot dalam talian dan kredit model pelan tersedia atau model dikonfigurasikan, gunakan Daily → Chat untuk menghantar mesej tanpa menyambungkan saluran terlebih dahulu.**

---

Konsol Ejen menyusun tetapan harian dalam halaman bar sisi untuk **Saluran**, **Model**, **Kemahiran**, dan **Tugas Berjadual**. Pilih Bot yang ingin anda konfigurasikan, kemudian buka halaman yang berkaitan. Panduan ini menunjukkan di mana untuk bermula dan bagaimana untuk mengesahkan hasilnya.

## Halaman ini meliputi

- Bagaimana untuk memasuki konsol

- Penukar bot dan maklumat bot yang dipilih

- Di mana untuk mencari Saluran, Model, Kemahiran, dan Penyimpanan Awan

- Keadaan kejayaan selepas konfigurasi

- Operasi biasa seperti mengurus Bot, menukar model, dan menyambungkan pelbagai saluran

---

## Masukkan konsol

Selepas mendaftar masuk, buka [konsol Ejen](/agents/overview/). Pilih Hermes Agent dan Bot yang anda ingin konfigurasikan.


Sembang Web berada di bawah Harian; sambungkan Saluran luaran hanya apabila anda ingin menggunakan aplikasi pesanan.

## Bot dan maklumat Bot yang dipilih

Bahagian atas konsol mengandungi tab Bot untuk Hermes Agent semasa. Tab pertama ialah Bot utama; setiap tab tambahan ialah profil Bot yang berasingan. Pelan anda menentukan jumlah had Bot, termasuk Bot utama. Semasa pelancaran antarabangsa secara berperingkat, entri penciptaan tidak dipaparkan secara lalai. Lihat [Urus Bot](./configuration/bots.md) untuk kaedah penciptaan dan peraturan pewarisan.

Selepas memilih Bot, maklumat asasnya ditunjukkan di bawah:

- Avatar

- Nama (klik nama atau ikon pensel untuk mengedit, kemudian tekan Enter untuk menyimpan)

- Status (● Berjalan / ● Tidak diketahui)

- Masa penciptaan

- Butang Padam (ikon sampah di sebelah kanan)

> ⚠️ **Pemadaman adalah tidak boleh dipulihkan**
>
> Memadam Bot tambahan akan memadamkan profil dan data Bot tersebut secara kekal. Memadam Bot utama akan memadamkan keseluruhan Hermes Agent dan semua data berkaitan, dan hanya dibenarkan selepas Bot lain telah dipadamkan.

---

## Konfigurasikan saluran, model, dan kemahiran

### Saluran

Buka **Saluran** di bar sisi Ejen. Halaman ini menunjukkan kad berasingan untuk Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom, dan Lark. Pilih **+ Sambung** pada saluran yang anda mahu dan ikuti panduannya. WhatsApp, WeChat, WeCom, dan Lark menggunakan pengesahan kod QR; Telegram, Discord, dan Slack menggunakan maklumat kelayakan. QQ menawarkan sambungan kod QR atau ID / Rahsia Apl. Lihat panduan [WhatsApp](./configuration/channel-whatsapp.md) untuk contoh kod QR.

### Model

Buka **Models** untuk menyemak model aktif atau mengkonfigurasi penyedia. Kredit model rancangan boleh digunakan tanpa memasukkan kunci API anda sendiri; anda boleh menambah penyedia bila perlu. Bot menggunakan satu model utama pada satu-satu masa, dan model sandaran yang dikonfigurasi secara berasingan mungkin tersedia. Lihat [Configure Models](./configuration/model.md) dan [Model Switching](./configuration/multiple-models.md).

### Kemahiran

Buka **Skills** untuk mencari kemahiran individu atau melayari **Skill Packages** dari [Skills.sh](https://skills.sh/) dan [ClawHub](https://clawhub.ai/). Pilih **Install**, kemudian sahkan hasilnya di **Installed**. Lihat [Configure Skills](./configuration/skill.md).

## Keadaan kejayaan selepas konfigurasi

Selepas konfigurasi selesai, konsol harus menunjukkan keadaan berikut:

- Senarai "Saluran yang disambungkan" mempunyai sekurang-kurangnya satu rekod (seperti "WeChat")

- "Model semasa" adalah pilihan; tiada konfigurasi diperlukan jika anda menggunakan kredit percubaan Pelancaran

- "Kemahiran yang dipasang" boleh dikonfigurasikan mengikut keperluan dan mungkin kosong

Setelah "Saluran yang disambungkan" mempunyai sekurang-kurangnya satu rekod, anda boleh mencari bot dalam platform pemesejan yang sepadan dan memulakan perbualan. Hermes Agent akan menjana balasan menggunakan model lalai atau kredit percubaan Pelancaran.

---

## Operasi biasa

- **Tukar model:** Buka **Model** untuk Bot yang dipilih dan pilih model yang telah dikonfigurasi yang tersedia. Memori Bot dikekalkan; lihat [Penukaran Model](./configuration/multiple-models.md).
- **Sambungkan pelbagai saluran:** Buka **Saluran** dan gunakan **+ Sambung** pada setiap kad yang diperlukan. Saluran yang disambungkan ke Bot yang sama berkongsi persona dan memori Bot tersebut.
- **Urus Bot:** Pilih tab Bot sebelum menukar tetapan. Apabila penciptaan tersedia, ikuti [Urus Bot](./configuration/bots.md) untuk peraturan menyalin dan memadam.
- **Buka Penyimpanan Awan:** Gunakan **Penyimpanan Awan** dalam menu pengguna dan bukan mencarinya di bar sisi Ejen.

---

## Langkah seterusnya

Konfigurasi terperinci untuk setiap modul:

- [Urus Bot](./configuration/bots.md) — Cipta, salin, tukar, namakan semula, dan padam Bot

- [Konfigurasikan Model](./configuration/model.md) — Sumber model, API Pemerolehan kunci dan panduan pemilihan

- [Konfigurasikan Saluran - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md) / [QQ](./configuration/channel-qq.md) / [WeCom](./configuration/channel-wecom.md) / [Lark](./configuration/channel-feishu.md)

- [Konfigurasikan Kemahiran](./configuration/skill.md) — Penggunaan Skills.sh / ClawHub dan pemasangan kemahiran

Rujukan berkaitan:

- [Konsep Teras](./04-core-concepts.md)

- [Mula Pantas](./02-quickstart.md)
