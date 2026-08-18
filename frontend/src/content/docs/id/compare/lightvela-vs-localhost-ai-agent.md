# LightVela vs Agent yang Dihosting Sendiri: Mana yang Lebih Sesuai?

![Penyiapan cloud LightVela dibandingkan dengan menjalankan Hermes secara lokal](../images/lightvela-vs-self-hosted-hermes.webp)

## Ringkasan

**LightVela lebih sesuai ketika Anda menginginkan Hermes Agent yang selalu aktif tanpa memelihara komputer di bawahnya.** Menjalankan Hermes di komputer Anda sendiri adalah pilihan yang lebih baik ketika Anda menginginkan kendali langsung atas runtime, tool, pembaruan, dan lingkungan lokalnya. Jawaban yang tepat bergantung pada apakah Anda ingin mengoperasikan penyiapannya atau sekadar memakai Agent-nya.

Hermes dapat berjalan secara lokal di macOS, Windows, Linux, WSL2, dan lainnya. Installer resminya menyiapkan runtime lalu membuat Anda dapat memilih penyedia model, tool, dan gateway pesan sendiri. [Panduan instalasi Hermes](https://hermes-agent.nousresearch.com/docs/getting-started/installation) membuat jalur itu cukup mudah didekati.

> **Mudah didekati tidak sama dengan tak terlihat.** Agent lokal memberi Anda kendali, tetapi ia juga memberi Anda tanggung jawab menjaga lingkungannya tetap siap.

## Sekilas perbandingan

| Yang penting bagi Anda | Menjalankan Hermes di komputer Anda | Memakai LightVela |
| - | - | - |
| **Di mana Hermes berjalan** | Mesin Anda sendiri | Runtime cloud khusus |
| **Kendali sehari-hari** | Anda memilih penyiapan dan lingkungan lokalnya | Anda mengelola Agent melalui konsol yang di-hosting |
| **Ketersediaan** | Anda menjaga komputer dan prosesnya tetap tersedia | Dirancang untuk tetap online secara independen dari perangkat lokal Anda |
| **Tanggung jawab penyiapan** | Anda mengonfigurasi runtime, model, tool, dan kanalnya | Lingkungan Agent intinya di-hosting untuk Anda |
| **Paling sesuai untuk** | Pembangun yang menikmati memiliki stack-nya | Orang yang ingin memakai Hermes tanpa mengoperasikan stack-nya |

## Apa yang berubah dalam pemakaian sehari-hari

Jalur lokal memuaskan ketika Anda senang mengetahui persis di mana segala sesuatu berada.

Anda memasang Hermes, memilih penyedia model, mengaktifkan tool, lalu menambahkan gateway ketika Anda menginginkan akses pesan. Panduan cepat Hermes sendiri menyarankan agar satu percakapan bersih berfungsi lebih dulu sebelum menumpuk gateway, Skill, suara, atau routing — saran yang wajar untuk penyiapan yang dikelola sendiri. [Panduan cepat Hermes](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart/) juga menunjukkan bahwa instalasi lokal dapat berkembang menjadi bot atau alur kerja yang selalu aktif.

Fleksibilitas itu memang intinya. Anda dapat bereksperimen dengan lingkungan Anda sendiri, memilih bagaimana pembaruan terjadi, dan membangun di sekitar mesin yang sudah Anda pakai.

Konsekuensinya muncul kemudian, pada momen-momen biasa:

- **Ketersediaan:** Komputer Anda perlu tetap tersedia agar Agent-nya tetap tersedia.
- **Pemeliharaan:** Anda adalah orang yang menyadari ketika sebuah pengaturan model, tool, gateway, atau pembaruan membutuhkan perhatian.
- **Cakupan:** "Satu hal lagi saja" dapat perlahan mengubah penyiapan pribadi menjadi sesuatu yang harus Anda pelihara.

Itu bukan alasan untuk menghindari hosting sendiri. Ia sekadar pekerjaan yang Anda terima.

## Di mana LightVela lebih sesuai

LightVela lebih masuk akal ketika tujuan Anda adalah memiliki Hermes Agent yang bekerja untuk Anda, bukan mengoperasikan mesin di bawahnya.

LightVela menjalankan instans Hermes Agent khusus di cloud. Agent tersebut tetap online secara independen dari perangkat lokal Anda, sementara Anda mengelola bagian praktisnya — [model](https://lightvela.ai/docs/configuration/model), [kanal](https://lightvela.ai/docs/configuration), dan [Skill](https://lightvela.ai/docs/configuration/skill) — dari konsol. [Ringkasan LightVela](https://lightvela.ai/docs/overview) menjelaskan model hosting-nya, termasuk runtime terisolasi dan akses multi-kanal.

Itu mengubah rasa memakai Hermes. Anda dapat menghubungkan Agent ke kanal tempat Anda sudah berbicara — seperti [Telegram](https://lightvela.ai/docs/configuration/channel-telegram), [WhatsApp](https://lightvela.ai/docs/configuration/channel-whatsapp), [Discord](https://lightvela.ai/docs/configuration/channel-discord), atau [Slack](https://lightvela.ai/docs/configuration/channel-slack) — lalu terus memakainya bahkan ketika laptop Anda tertutup. Anda tetap membuat pilihan yang bermakna, tetapi Anda tidak perlu mengubah komputer pribadi menjadi tempat ketersediaannya dipelihara.

Bagi banyak orang, pembedaan yang membantu itu sederhana:

> **LightVela memberi Anda lebih sedikit penyiapan untuk dikendalikan. Hosting sendiri memberi Anda lebih banyak kendali atas penyiapannya.**

Jika Anda terutama ingin mengonfigurasi Agent lalu kembali ke pekerjaan Anda, konsol yang di-hosting biasanya titik awal yang lebih nyaman. Anda tetap dapat mengonfigurasi model, kanal, dan Skill di satu tempat melalui [ringkasan konfigurasi LightVela](https://lightvela.ai/docs/configuration).

## Di mana menjalankan Hermes di komputer sendiri lebih sesuai

Pilih penyiapan lokal ketika membangun dan mengendalikan runtime adalah bagian dari proyeknya — mungkin untuk alur kerja desktop, home lab, atau eksperimen model secara langsung.

Anda akan memiliki tanggung jawab atas pembaruan, kredensial, dan ketersediaan. "Di komputer saya" juga tidak membuat setiap model, tool browser, atau layanan terhubung menjadi lokal, jadi bersikaplah presisi tentang apa yang sebenarnya Anda kendalikan.

## Mana yang sebaiknya Anda pilih?

Pilih LightVela jika:

- **Anda menginginkan ketersediaan:** Anda ingin Hermes siap tanpa membiarkan komputer Anda bertanggung jawab atasnya.
- **Anda lebih suka konfigurasi:** Anda lebih memilih mengonfigurasi Agent daripada memelihara runtime-nya.
- **Anda menginginkan satu konsol:** Anda menginginkan tempat yang jelas untuk mengelola model, kanal, dan Skill.
- **Anda sudah memakai aplikasi pesan:** Anda menginginkan Agent yang selalu aktif dan cocok dengan kanal yang sudah Anda pakai.

Pilih Hermes di komputer Anda sendiri jika:

- **Anda menikmati membangun:** Anda menyukai penyiapan yang mengutamakan terminal dan eksperimen langsung.
- **Anda menginginkan kepemilikan:** Anda ingin menyetel runtime di sekitar lingkungan pribadi Anda.
- **Anda menerima pemeliharaannya:** Anda nyaman menangani konfigurasi model, pembaruan, tool, dan ketersediaan.

Tidak perlu berpura-pura satu jawaban lebih baik secara universal. Mulailah dari pertanyaan di balik pertanyaannya: **apakah saya ingin menjalankan infrastruktur, atau saya ingin Agent yang siap ketika saya membutuhkannya?**
