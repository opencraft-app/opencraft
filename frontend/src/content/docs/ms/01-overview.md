# Apakah itu LightVela

## Ringkasan

**LightVela adalah produk ejen AI awan daripada pasukan Tencent Lighthouse. Penolong AI peribadi yang anda cipta pada masa ini berjalan di Hermes Agent. LightVela menguruskan penyebaran, operasi, dan masa berfungsi 24/7 dalam awan, jadi anda tidak pernah menulis fail konfigurasi atau SSH ke dalam pelayan: anda sediakan semuanya dengan menunjuk dan klik di panel visual, kemudian bersembang dengan Bot anda secara terus di Daily → Chat atau sambungkan aplikasi mesej yang anda gunakan. Ia mengingati anda di seluruh perbualan, dan anda memilih model, alat, dan persona. Pelan semasa dan tawaran pengenalan disenaraikan di [halaman Langgan](/subscribe/).**

---

> Hermes Agent dihoskan awan yang memahami anda dengan lebih baik dari semasa ke semasa.

LightVela adalah produk ejen AI awan dari pasukan Tencent Lighthouse. Ia direka untuk membolehkan semua orang memiliki **rakan AI yang benar-benar milik mereka**—bukan alat yang meminta anda memperkenalkan diri setiap kali, tetapi suatu kehadiran jangka panjang yang **mengenali anda, mengingati anda, dan memahami anda dengan lebih baik dari masa ke masa**.

Ejen anda kekal dalam talian 24/7, berjalan secara bebas dan sentiasa bersedia untuk bersembang. Anda tentukan model, alatan dan personanya.

Kami menurunkan halangan konfigurasi melalui konsol visual: tiada fail konfigurasi, tiada log masuk pelayan, hanya pilih pilihan pada halaman web untuk melengkapkan persediaan.

Pembantu AI peribadi yang anda cipta sekarang dijalankan pada Hermes Agent. Dokumentasi ini menerangkan cara untuk mengkonfigurasi model, alat, persona, dan saluran sembang mereka.

![1.00](../images/1-1.webp)

***

## Untuk siapa

* Pengguna yang ingin menggunakan Ejen AI tetapi tidak mempunyai pengetahuan teknikal tentang pelayan, bekas, pengesahan API dan infrastruktur berkaitan

* Pengguna yang lebih suka berinteraksi dengan AI melalui platform pemesejan setiap hari (Telegram / WhatsApp / Discord / Slack / WeChat) dan bukannya aplikasi kendiri

* Pengguna yang ingin memilih daripada berbilang penyedia model bahasa besar (termasuk ChatGPT, Claude, Gemini, Deepseek, Qwen, Zhipu, Hunyuan dan banyak lagi)

* Pengguna yang memerlukan ingatan berterusan merentas perbualan dan bukannya bermula dari awal setiap kali

## Tidak sesuai untuk

* Pengguna yang memerlukan pelaksanaan setempat sepenuhnya tanpa data meninggalkan peranti mereka

* Pengguna yang perlu melatih atau memperhalusi model asas

* Pembangun yang perlu menyepadukan Ejen ke dalam laman web atau aplikasi mereka sendiri

***

## Ciri-ciri produk

* **Kerahan terurus sepenuhnya**: Awan secara automatik mengendalikan persediaan persekitaran dan pengurusan masa jalan. Tiada operasi pelayan, imej kontena atau pengetahuan infrastruktur diperlukan

* **Persekitaran awan khusus**: Setiap instans Hermes Agent mempunyai persekitaran awan sendiri, pengasingan sumber, ketersediaan 24/7, dan tidak bergantung pada peranti tempatan

* **Sokongan berbilang model**: Sambung ke model bahasa besar Cina arus perdana, langganan Pelan Pengekodan pembekal atau mana-mana titik akhir yang serasi dengan OpenAI. Lihat [Konfigurasikan Model](./configuration/model.md)

* **Akses berbilang saluran**: Sembang dengan Hermes Agent melalui Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom dan Lark

* **Sambungan kemahiran**: Cari dan pasang Kemahiran atau Pakej Kemahiran dari [Skills.sh](https://skills.sh/) dan [ClawHub](https://clawhub.ai/) dalam konsol

* **Sedia untuk digunakan**: Pelan Pelancaran termasuk kredit percubaan, jadi anda boleh mula bersembang selepas pengaktifan tanpa mengkonfigurasi model secara berasingan

* **Storan awan khusus**: Data perbualan dan memori disimpan secara berasingan

***

## Cara ia berfungsi

LightVela menjalankan Hermes Agent di awan. Anda boleh menghantar mesej dari Web Chat atau menyambungkan platform mesej luaran apabila diperlukan.

```
User (sends a message in Web Chat or a connected messaging app)
      ↓
User-dedicated Hermes Agent instance in the LightVela cloud
      ↓
Calls the configured large language model (GPT / Claude / Gemin / ...)
      ↓
Response returns to the same conversation entry point
```

Perbualan dalam Web Chat tidak memerlukan saluran luaran:

1. **Model**: Model bahasa besar yang dipanggil oleh Hermes Agent. Pelan Pelancaran termasuk kredit percubaan dan boleh digunakan secara langsung; anda juga boleh mengkonfigurasi Kunci API anda sendiri

2. **Titik masuk sembang**: Gunakan Daily → Chat dalam My Agent untuk bercakap dengan Bot yang dipilih. Konfigurasikan saluran hanya apabila anda ingin menggunakan Telegram, WhatsApp, Discord, WeChat, atau aplikasi mesej lain

3. **Kemahiran** (pilihan): Keupayaan tambahan untuk Hermes Agent

![1.00](../images/1-2.webp)

***

## Mengenai rancangan

Satu pelan menyediakan satu Hermes contoh cloud Ejen. Siri Launch menyokong sehingga 5 Bot di dalam contoh itu; siri Cruise menyokong sehingga 10. Bot adalah profil yang berasingan, bukan Hermes contoh tambahan.

| Pilihan pelan | Kredit model sebulan | Bot |
|---|---:|---:|
| Pelancaran | 100 | 5 |
| Pelancaran AI | 4,500 | 5 |
| Menjelajah | 200 | 10 |
| Menjelajah AI | 10,000 | 10 |

Harga, tawaran pengenalan, dan ketersediaan boleh berubah. Semak [halaman Langgan](/subscribe) sebelum membuat pesanan; pelanggan aktif juga boleh membeli [pakej kredit model sekali sahaja](./credits.md).
***

## Hubungan dengan Lighthouse (pilihan)

Untuk pengguna yang biasa dengan Tencent Cloud: LightVela boleh difahamkan sebagai pembungkusan sedia untuk digunakan keupayaan penggunaan Ejen awan Tencent Lighthouse. LightVela mengalih keluar konsep seperti akaun Tencent Cloud, pengurusan sumber dan operasi sumber awan, meninggalkan hanya dua tindakan teras: mengkonfigurasi Ejen dan menyambungkannya ke platform pemesejan.

Jika anda baru menggunakan Ejen awan, anda boleh melangkau bahagian ini.

***

## Langkah seterusnya

* **[Quickstart](./02-quickstart.md)** — Lengkapkan perbualan pertama anda dalam masa 5 minit

* **[Konsep Teras](./04-core-concepts.md)** — Fahami lima konsep teras: Hermes Agent, Bot, model, saluran, dan kemahiran

* **[Gambaran Keseluruhan Konfigurasi](./05-configuration.md)** — Ciri konsol dan aliran konfigurasi
