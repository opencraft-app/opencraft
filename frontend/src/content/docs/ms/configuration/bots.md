# Urus Bots

## Ringkasan

**Bot adalah profil berdikari di dalam Hermes Agent anda. Bot utama dibuat bersama Ejen, dan setiap Bot tambahan boleh mempunyai tetapan model sendiri, persona, ingatan, Kemahiran, saluran, dan tugas terjadual. Apabila anda membuat Bot, pilih sama ada untuk menyalin Bot sedia ada atau memulakan dengan tetapan Asas. Pelan anda menentukan berapa banyak Bot yang boleh anda buat, termasuk Bot utama.**

> **Ketersediaan di laman antarabangsa**
>
> Penciptaan Bot tambahan diperkenalkan secara berperingkat. Entri **Buat Bot** tidak dipaparkan secara lalai di laman antarabangsa semasa pengenalan ini. Jika entri tidak tersedia, teruskan menggunakan Bot utama.

## Halaman ini meliputi

- Hubungan antara Hermes Agent dan Botnya.
- Mencipta Bot dengan menyalin Bot sedia ada atau menggunakan tetapan Asas.
- Apa yang diwarisi oleh setiap kaedah penciptaan.
- Menukar, menamakan semula, dan memadam Bot.

## Sebelum anda bermula

1. Sahkan bahawa Hermes Agent anda sedang berjalan.
2. Sahkan bahawa pelan anda mempunyai ruang untuk Bot tambahan. Had pelan termasuk Bot utama.
3. Buka **Agents** dan pilih Ejen yang anda ingin uruskan.

## Cipta Bot

Apabila entri penciptaan tersedia:

1. Pilih **Bot Baru**.
2. Masukkan nama Bot tidak melebihi 60 aksara.
3. Pilih kaedah penciptaan.
4. Semak ringkasan pewarisan, kemudian pilih **Sahkan penciptaan**.
5. Tunggu Bot baru selesai penyediaan sebelum mengkonfigurasi atau menggunakannya.

Pilihan salin yang tersedia bergantung pada Bot yang sedang dipilih. Dari Bot utama, konsol menunjukkan **Salin semasa (Bot utama)**. Dari Bot lain, anda boleh memilih **Klon semasa** atau **Klon Bot utama**.

## Pilih kaedah penciptaan

| Kaedah | Warisan | Tidak diwarisi |
| --- | --- | --- |
| Salin semasa, Klon semasa, atau Klon Bot utama | Model, persona, Kemahiran, keutamaan pengguna, dan memori jangka panjang daripada Bot sumber yang dipilih | Perbualan semasa, sejarah sembang, tugas yang dijadualkan, keadaan semasa, dan sambungan saluran |
| Persediaan asas | Model utama semasa Bot dan kelayakan Penyedia, ditambah Kemahiran sistem terbina dalam | Model sandaran, model lain yang dikonfigurasikan, persona, memori, Kemahiran yang dipasang kemudian pada Bot utama, saluran, dan tugas yang dijadualkan |

**Persediaan asas bukanlah Bot kosong.** Ia menyimpan model minimum dan konfigurasi Kemahiran bawaan yang diperlukan untuk memulakan, sambil memisahkan tingkah laku peribadi, memori, dan integrasi.

## Sahkan Bot baru

Selepas penyediaan selesai:

1. Sahkan bahawa tab Bot baru muncul dengan nama yang anda masukkan.
2. Pilih Bot baru dan periksa bahawa model dan Kemahiran sesuai dengan kaedah penciptaan yang anda pilih.
3. Buka halaman konfigurasi yang berkaitan sebelum menambah [Soul](./personality.md), memasang [Skills](./skill.md), menyambungkan saluran, atau membuat [Scheduled Tasks](./automation.md).

## Bekerja dengan Pelbagai Bot

Tab Bot muncul di bahagian atas konsol Ejen. Pilih tab sebelum menukar tetapan model, persona, memori, Kemahiran, saluran, tugas yang dijadualkan, atau diagnostik supaya anda bekerja dengan Bot yang dimaksudkan.

Setiap Bot mempunyai profil dan data sendiri. Perubahan pada satu Bot tidak akan mengemas kini Bot lain secara automatik. Ciri **Sembang** konsol kini hanya tersedia untuk Bot utama, dan penyelenggaraan peringkat Ejen juga harus dilakukan dari Bot utama.

Untuk menamakan semula Bot, pilih Bot tersebut dan sunting nama yang dipaparkan. Nama baharu boleh mengandungi sehingga 60 aksara.

## Padam Bot

- Memadam Bot tambahan akan memadamkan profil dan data Bot tersebut secara kekal.
- Putuskan sambungan saluran yang dimiliki oleh Bot itu sebelum memadamnya.
- Padam semua Bot tambahan sebelum memadam Bot utama.
- Memadam Bot utama akan memadamkan keseluruhan Ejen, termasuk semua perbualan, konfigurasi, Kemahiran yang dipasang, memori, dan data berkaitan.

Pemadaman tidak dapat dibatalkan. Baca mesej pengesahan dengan teliti dan masukkan nama Bot yang diminta sebelum mengesahkan.

## Penyelesaian Masalah

### Mengapa saya tidak boleh mencipta Bot lain?

Entri penciptaan mungkin masih tersembunyi semasa pelancaran antarabangsa, keupayaan multi-Bot mungkin tidak tersedia untuk versi Ejen semasa, Ejen mungkin tidak berjalan, atau pelan anda mungkin telah mencapai had Bot.

### Mengapa Bot yang disalin tiada perbualan, tugasan, atau saluran?

Item ini sengaja tidak disalin. Sambungkan semula saluran dan wujudkan semula tugasan yang dijadualkan untuk Bot baru mengikut keperluan.

### Mengapa tetapan Asas masih menunjukkan model dan Kemahiran?

Tetapan asas mewarisi model utama semasa Bot dan kelayakan Penyedia serta mengekalkan hanya Kemahiran sistem terbina dalam. Ia tidak menyalin model lain, persona, memori, Kemahiran yang dipasang kemudian, saluran, atau tugas berjadual Bot utama.
