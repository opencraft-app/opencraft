# Menukar Bots

## Ringkasan

**Menukar Bots membolehkan satu Ejen awan LightVela mengandungi pelbagai Bots khusus. Anda boleh mencipta Bots untuk penyelidikan, perancangan, pengekodan, kandungan, sokongan, atau aliran kerja berkala, kemudian menukar antara mereka dari menu profil Ejen.**

**Setiap Bot mempunyai konteks ruang kerja sendiri. Bergantung pada sama ada anda mencipta Bot kosong atau menyalin Bot sedia ada, LightVela menerapkan peraturan pewarisan yang berbeza ke atas tetapan model, memori, kemahiran, personaliti, tugasan berjadual, dan sambungan saluran.**

## Sebelum anda bermula

- Log masuk ke LightVela dan buka Ejen awan yang aktif.
- Untuk membuat Bot tambahan, pastikan pelan semasa anda membenarkan Bot lain dan tiada Bot lain sedang dibuat atau dipadam.
- Jika anda merancang untuk menyambungkan saluran, sediakan kelayakan atau kaedah kebenaran yang diperlukan oleh saluran tersebut.

## Mencipta bot anda

Selepas memilih **Bot Baru**, pilih avatar, masukkan nama dan penerangan, dan pilih sama ada untuk membuat Bot kosong atau menyalin Bot sedia ada.

Apabila Bot lain sudah wujud, dialog penciptaan boleh menawarkan **Salin semasa**, **Salin Bot utama**, atau **Cipta kosong**.

Sebagai contoh, untuk membuat Bot Penganalisis Kewangan, anda boleh memasukkan:

> <strong>Nama:</strong> Alpha Analyst
>
> <strong>Deskripsi:</strong> Alpha Analyst pakar dalam menganalisis laporan syarikat, berita pasaran, prestasi portfolio, penilaian, dan risiko kewangan. Menghasilkan pandangan yang ringkas dan berasaskan bukti, memisahkan fakta daripada andaian dengan jelas, dan mengelakkan pembentangan analisis sebagai nasihat kewangan yang dijamin.

![Borang penciptaan Bot LightVela dengan pemilih avatar, medan nama, medan deskripsi, dan butang Cipta](../../images/bots-switching-create.webp)

Skrin penciptaan juga mungkin menunjukkan templat untuk peranan tertentu, seperti Pengurus Kesihatan, Pemerhati Pasaran, atau Rakan Kajian AI.

![Templat penciptaan Bot LightVela termasuk Pengurus Kesihatan, Pemerhati Pasaran, dan Rakan Kajian AI](../../images/bots-switching-templates.webp)

Selepas memasukkan butiran, sahkan penciptaan dan tunggu Bot baru selesai disediakan.

## Ruang kerja Bot dan tetapan

Selepas penciptaan, Bot membuka ruang kerja tetapan sendiri. Dari tab Bot di halaman Utama Agen, anda boleh memilih Bot itu dan menguruskan tetapan yang tersedia untuknya, termasuk memori, kemahiran, personaliti, tugas yang dijadualkan, dan saluran yang disambungkan.

![Tinjauan Agen LightVela menunjukkan kad Bot dalam bahagian My Bots](../../images/bots-switching-overview.webp)

Mod penciptaan menentukan apa yang diwarisi oleh Bot baru:

| Mod penciptaan | Pewarisan | Bermula secara berasingan |
| --- | --- | --- |
| Cipta kosong | Model utama dan kelayakan penyediaannya, serta kemahiran yang disediakan oleh sistem | Model sandaran, model lain yang dikonfigurasi, personaliti, memori, kemahiran yang dipasang kemudian pada Bot utama, saluran, dan tugas yang dijadualkan |
| Salin semasa atau Salin Bot utama | Model, personaliti, kemahiran, keutamaan pengguna, dan memori jangka panjang | Perbualan semasa, sejarah sembang sebelumnya, tugas yang dijadualkan, keadaan masa jalan, dan sambungan saluran |

Semak dialog penciptaan sebelum mengesahkan jika anda perlu mengekalkan tetapan secara berasingan. Anda kemudian boleh menguruskan setiap [memori](./memory.md), [kemahiran](./skill.md), dan [tugas berjadual](./automation.md) Bot secara berdikari.

## Mengapa membangunkan Bot secara berdikari?

Satu Bot boleh mengendalikan banyak tugas, tetapi konteksnya menjadi lebih sukar untuk diurus apabila tanggungjawabnya berkembang. Seorang penyelidik khusus, perancang perjalanan, penganalisis kewangan, atau pemeriksa kualiti boleh mengekalkan set memori, kemahiran, tetapan personaliti, dan tugas berjadual yang lebih fokus.

Bots Bebas juga memudahkan untuk menguji gaya kerja yang berbeza tanpa menukar Bot yang sudah anda gunakan untuk tugas lain.

![Menu profil Bot LightVela menunjukkan pelbagai Bot yang boleh dipilih](../../images/bots-switching-selector.webp)

Hasilnya ialah ruang kerja LightVela yang lebih teratur. Untuk bertukar antara Bots, klik profil Bot yang aktif di bahagian kiri atas ruang kerja Ejen, kemudian pilih Bot lain daripada menu.

## Cara menggunakan pelbagai Bots sekaligus

Anda boleh menyambungkan pelbagai Bots ke saluran mesej yang disokong. Gabungan saluran yang tersedia bergantung kepada wilayah LightVela:

| Versi LightVela | Saluran yang menyokong integrasi Bot berganda |
| --- | --- |
| Versi China | QQ, WeCom, Lark, DingTalk |
| Versi Global | Telegram, Discord, Slack, QQ, WeCom, Lark |

Untuk saluran seperti WeChat dan WhatsApp, konfigurasi semasa mungkin membenarkan hanya satu Bot setiap contoh. Jika saluran sudah dimiliki oleh Bot lain, LightVela akan memaparkan notis dan menyediakan cara untuk mengurus Bot yang memilikinya.

![Notis LightVela menunjukkan bahawa WeChat sedang digunakan oleh Bot lain dan hanya satu Bot boleh disambungkan](../../images/bots-switching-wechat.webp)

## Sahkan pertukaran Bot atau sambungan saluran

Selepas menukar atau menyambungkan Bot, periksa perkara berikut:

1. Nama Bot aktif dan avatar bertukar kepada Bot yang anda pilih.
2. Halaman tetapan menunjukkan ruang kerja dan konfigurasi Bot yang dipilih.
3. Saluran yang disambungkan disenaraikan di bawah Bot yang memiliki sambungan.
4. Mesej ujian pendek sampai ke Bot yang dituju dan menerima balasan.

Untuk saluran kumpulan, hantar mesej ujian dengan tahap kebenaran yang anda tetapkan. Sahkan sama ada Bot hanya boleh membaca konteks kumpulan atau juga boleh membalas.

## Isu biasa

| Isu | Sebab yang mungkin | Apa yang perlu dilakukan |
| --- | --- | --- |
| **Bot Baharu** tidak tersedia | Pelan anda telah mencapai had Bot, atau Bot lain masih sedang dicipta atau dipadam | Tunggu operasi semasa selesai, padam Bot yang tidak digunakan, atau naik taraf ke pelan dengan had yang lebih tinggi |
| Pilihan klon tidak tersedia | Tiada Bot utama atau semasa yang sah untuk disalin | Pilih **Cipta Kosong**, atau kembali ke Bot yang dimaksudkan sebelum membuka dialog penciptaan |
| Senarai Bot sementara tidak tersedia | Instans Ejen berhenti atau permintaan senarai Bot gagal | Mulakan semula atau segarkan Ejen, kemudian muat semula halaman tetapan Bot |
| Saluran sudah disambungkan ke Bot lain | Saluran mempunyai sekatan milikan satu-Bot | Gunakan pemberitahuan untuk membuka Bot pemilik, atau putuskan dan sambungkan semula saluran mengikut halaman konfigurasi saluran |
| Mesej kumpulan tidak menerima balasan | Kebenaran kumpulan Bot atau konfigurasi saluran tidak lengkap | Semak halaman konfigurasi saluran yang berkaitan [Telegram](./channel-telegram.md), [Discord](./channel-discord.md), atau yang lain, kemudian hantar mesej ujian lain |

## Berbual dengan Bot anda dalam kumpulan

Anda boleh menjemput beberapa Bot ke dalam sembang kumpulan yang disokong. Bergantung pada tahap kebenaran yang anda tetapkan, Bot mungkin membaca konteks kumpulan, membalas pertanyaan pengguna, atau melakukan kedua-duanya.

Tingkah laku kumpulan dan langkah persediaan berbeza mengikut platform. Ikuti halaman konfigurasi saluran yang berkaitan sebelum menjemput Bot, dan uji Bot dengan sebutan langsung atau pencetus lain yang disokong platform jika perlu.
