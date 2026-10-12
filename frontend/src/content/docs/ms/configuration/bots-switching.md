# Menukar Bots

## Ringkasan

**Menukar Bots membolehkan satu Ejen awan LightVela mengandungi pelbagai Bots khusus. Anda boleh mencipta Bots untuk penyelidikan, perancangan, pengekodan, kandungan, sokongan, atau aliran kerja berkala, kemudian menukar antara mereka dari bar avatar Bot.**

**Setiap Bot mempunyai konteks ruang kerja sendiri. Bergantung pada sama ada anda mencipta Bot kosong atau menyalin Bot sedia ada, LightVela menerapkan peraturan pewarisan yang berbeza ke atas tetapan model, memori, kemahiran, personaliti, tugasan berjadual, dan sambungan saluran.**

## Sebelum anda bermula

- Log masuk ke LightVela dan buka Ejen awan yang aktif.
- Untuk membuat Bot tambahan, pastikan pelan semasa anda membenarkan Bot lain dan tiada Bot lain sedang dibuat atau dipadam.
- Jika anda merancang untuk menyambungkan saluran, sediakan kelayakan atau kaedah kebenaran yang diperlukan oleh saluran tersebut.

## Mencipta bot anda

Selepas log masuk dengan Google atau GitHub dan mengaktifkan pelan yang tersedia, buka [konsol Agent](/agents/overview/). Lengkapkan persediaan Bot pertama: masukkan nama yang wajib, tambah penerangan jika perlu, dan laraskan penampilannya. Pilih **Buat** dan tunggu penciptaan serta konfigurasi awal selesai. Selepas konfigurasi selesai, pilih **Mulakan perjalanan**, kemudian buka sembang web untuk Bot itu. Saluran pemesejan adalah pilihan; balasan memerlukan kredit model pelan yang tersedia atau model yang telah dikonfigurasi.

Untuk mencipta Bot seterusnya, pilih **Bot Baharu** jika tersedia dan kuota pelan mencukupi. Isi **Nama** (wajib) dan **Penerangan** (pilihan), kemudian laraskan penampilan jika perlu. Pilihan lalai ialah **Persediaan asas**. Jika ada Bot sumber yang sah, buka **Lanjutan** dan pilih Bot tertentu untuk disalin. Untuk menyalin Bot yang sedang digunakan, buka **Urus Bot → Salin Bot**; borang akan memilih sumber itu terlebih dahulu. Semak sumber, pilih **Buat**, dan tunggu sehingga selesai.

Kawalan tutup dan pilihan salinan lanjutan hanya tersedia apabila ada Bot sumber yang sah. Persediaan pertama tanpa sumber perlu dilengkapkan. Kawalan penampilan mengubah warna, bentuk, dan aksesori, bukan sumber salinan.

Tangkapan skrin di bawah menunjukkan borang penciptaan Bot tambahan dan templat yang disyorkan dalam UI semasa. Kawalan tutup dan bahagian Lanjutan tersedia kerana Ejen ini sudah mempunyai Bot; ini bukan skrin persediaan Bot pertama.

![Borang penciptaan Bot LightVela dengan pemilih avatar, medan nama, medan deskripsi, dan butang Cipta](../../images/bots-switching-create.webp)

![Templat Bot yang disyorkan dalam borang penciptaan Bot tambahan LightVela](../../images/bots-switching-templates.webp)

## Ruang kerja Bot dan tetapan

Pilih avatar Bot yang dikehendaki pada bar Bot. Pada skrin sempit, buka panel navigasi terlebih dahulu. Semak namanya sebelum mengubah model, memori, kemahiran, saluran, atau tugas berjadual. Sembang web dan senarai perbualan mengikut Bot yang dipilih; Bot tambahan juga boleh menggunakan sembang web. Sembang web tidak memerlukan saluran pemesejan.

![Bar avatar Bot LightVela di sebelah navigasi Saluran, Kemahiran dan Tugas Berjadual](../../images/bots-switching-overview.webp)

Mod penciptaan menentukan apa yang diwarisi oleh Bot baru:

| Mod penciptaan | Pewarisan | Bermula secara berasingan |
| --- | --- | --- |
| Persediaan asas | Model utama dan kelayakan penyediaannya, serta kemahiran yang disediakan oleh sistem | Model sandaran, model lain yang dikonfigurasi, personaliti, memori, kemahiran yang dipasang kemudian pada Bot utama, saluran, dan tugas yang dijadualkan |
| Salin Bot | Model, personaliti, kemahiran, keutamaan pengguna, dan memori jangka panjang | Perbualan semasa, sejarah sembang sebelumnya, tugas yang dijadualkan, keadaan masa jalan, dan sambungan saluran |

Semak dialog penciptaan sebelum mengesahkan jika anda perlu mengekalkan tetapan secara berasingan. Anda kemudian boleh menguruskan setiap [memori](./memory.md), [kemahiran](./skill.md), dan [tugas berjadual](./automation.md) Bot secara berdikari.

## Mengapa membangunkan Bot secara berdikari?

Satu Bot boleh mengendalikan banyak tugas, tetapi konteksnya menjadi lebih sukar untuk diurus apabila tanggungjawabnya berkembang. Seorang penyelidik khusus, perancang perjalanan, penganalisis kewangan, atau pemeriksa kualiti boleh mengekalkan set memori, kemahiran, tetapan personaliti, dan tugas berjadual yang lebih fokus.

Bots Bebas juga memudahkan untuk menguji gaya kerja yang berbeza tanpa menukar Bot yang sudah anda gunakan untuk tugas lain.

![Bar avatar Bot LightVela dengan dua Bot dan kawalan Bot baharu](../../images/bots-switching-selector.webp)

Pilih avatar Bot yang dikehendaki pada bar Bot. Pada skrin sempit, buka panel navigasi terlebih dahulu. Semak namanya sebelum mengubah model, memori, kemahiran, saluran, atau tugas berjadual. Sembang web dan senarai perbualan mengikut Bot yang dipilih; Bot tambahan juga boleh menggunakan sembang web. Sembang web tidak memerlukan saluran pemesejan.

## Cara menggunakan pelbagai Bots sekaligus

Anda boleh menyambungkan pelbagai Bots ke saluran mesej yang disokong. Gabungan saluran yang tersedia bergantung kepada wilayah LightVela:

| Versi LightVela | Saluran yang menyokong integrasi Bot berganda |
| --- | --- |
| Versi Global | Telegram, Discord, WeChat, Slack, QQ, WeCom, Lark |

Bot yang berbeza pada instans yang sama boleh menghubungkan akaun WeChat yang berbeza. Setiap Bot mengurus sambungan WeChat sendiri. WhatsApp masih terhad kepada satu Bot yang bersambung bagi setiap instans; Bot lain akan melihat notis pemilikan dan pautan untuk mengurus Bot tersebut.

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
