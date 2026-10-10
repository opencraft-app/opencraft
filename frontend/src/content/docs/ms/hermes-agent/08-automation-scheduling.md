## Ringkasan

**Hermes Agent boleh menghubungi anda mengikut jadual bukan kerana ia menunggu dalam tetingkap sembang, tetapi kerana tugasan yang dijadualkan menyimpan tiga perkara — bila hendak dijalankan, perkara yang perlu dilakukan dan tempat untuk menghantar hasil — sebagai konfigurasi yang boleh dijadualkan berulang kali. Apabila tiba masanya, penjadual memulakan larian bebas: ia tidak memainkan semula perbualan lama, ia membuat semula kerja daripada arahan tugas dan kemudian menyampaikan output mengikut tetapan pemberitahuan anda. Pada LightVela tugas berjadual terdiri daripada: nama, jadual (hari bekerja tetap, selang tetap, atau sekali — pilih satu), arahan tugas, tetingkap masa aktif dan saluran pemberitahuan. Satu pembetulan kepada tuntutan yang meluas: tiada medan "sematkan tugas ini pada model tertentu", jadi nasihat untuk menyegerakkan semula model tugas berjadual selepas menukar model tidak terpakai. Bahagian yang menentukan kebolehpercayaan ialah arahan tugas — kerana tiada sesiapa yang hadir untuk menjelaskan pada masa jalankan, gesaan mesti membawa matlamat, sempadan dan format outputnya sendiri.**

---

## "Proaktif" tidak bermakna memerhati anda secara kekal

"Beri saya ringkasan berita setiap pagi" terdengar seperti arahan biasa, tetapi ia berbeza secara asas daripada "berikan saya ringkasan berita sekarang."

Yang kedua ialah perbualan: anda hadir, jadi anda boleh membuat susulan, membetulkan dan menambah konteks pada bila-bila masa. Yang pertama ialah **kerja yang mesti dilaksanakan semasa anda tidak hadir**: tiada siapa yang mengesahkan ia faham dengan betul, tiada siapa yang menghentikannya apabila output terlepas tanda, dan tiada siapa yang memberitahunya ke mana hendak menghantar hasil supaya anda benar-benar melihatnya.

Jadi bahagian sukar "proaktif" bukanlah pencetus bermasa — itu adalah bahagian yang mudah. Perkara yang sukar ialah ini: **menulis semula perbualan yang bergantung pada kehadiran anda ke dalam susunan kerja yang berjaya tanpanya.** Artikel ini merangkumi kandungan perintah kerja itu dan cara menulis yang sesuai.

---

## 1. Apakah tugas yang dijadualkan sebenarnya mengandungi

Membuat tugasan berjadual pada LightVela melibatkan medan ini.

| Medan | Soalan yang dijawabnya | Nota |
|---|---|---|
| **Nama** | Apakah nama tugas ini? | Digunakan untuk mengenal pasti dalam senarai; namakannya selepas tindakan, bukan "Tugas 1" |
| **Jadual** | Bilakah ia berjalan? | Hari bekerja tetap, selang tetap atau sekali — pilih satu |
| **Arahan tugas** | Apa yang harus dicapai? | Gesaan Ejen berfungsi dari pada masa jalan |
| **Tetingkap masa aktif** | Pada waktu manakah ia sah? | Mengehadkan bila tugas boleh dijalankan; membiarkannya kosong bermakna sepanjang masa |
| **Saluran pemberitahuan** | Mana pergi hasilnya? | Togol pilihan memilih saluran yang menerima notis pelaksanaan |

**Satu perkara yang patut dinyatakan dengan jelas: tiada medan "model".** Tugasan berjadual tidak disematkan pada model tertentu, jadi nasihat yang biasa diulang bahawa anda mesti menyemak dan menyegerakkan semula setiap model tugas yang dijadualkan selepas menukar model tidak terpakai pada bentuk produk ini. Perkara yang patut disemak selepas suis model ialah output **kualiti**, bukan medan yang tidak wujud. Untuk lapisan di belakang ini, lihat "Bolehkah Otak Hermes Digantikan? Lapisan Model vs Lapisan Ejen."

Juga ambil perhatian bahawa jadual ialah pilihan antara hari bekerja tetap, selang tetap dan sekali — bukan ungkapan cron sewenang-wenangnya. Mengetahui perkara ini terlebih dahulu menjimatkan anda daripada mereka bentuk jadual berbentuk cron dan kemudian mendapati tiada tempat untuk memasukkannya.

---

## 2. Memilih antara tiga jenis jadual

Ketiga-tiga mod ini memenuhi tiga keperluan berbeza, dan memilih yang salah menghasilkan tingkah laku yang tidak sepadan dengan jangkaan anda.

**Hari kerja tetap** sesuai dengan kerja yang terikat dengan irama manusia atau kitaran kerja — meringkaskan kemajuan minggu lalu pada pagi Isnin, peringatan Ahad untuk menyiram tanaman. Ciri penentunya ialah ia **berlabuh pada masa tertentu**, yang sesuai dengan "Saya mahu melihat ini pada masa itu."

**Selang tetap** sesuai dengan kerja di mana masa tidak penting, hanya kekerapan — menyemak sumber maklumat setiap beberapa jam. Ciri penentunya ialah ia **dikira daripada larian sebelumnya**, yang sesuai dengan "Saya mahu ia mengekalkan irama ini."

**Sekali** sesuai dengan acara tunggal, seperti peringatan pada tarikh tertentu. Ia berakhir selepas berjalan, tanpa apa-apa untuk dimatikan selepas itu.

Ujian mudah apabila memilih: **adakah keperluan anda menyebut masa jam?** Jika ya, gunakan hari bekerja tetap. Jika hanya kekerapan, gunakan selang tetap. Jika ia berlaku sekali, gunakan sekali sahaja.

---

## 3. Untuk apa tetingkap masa aktif

Medan ini mudah dilangkau, tetapi ia menyelesaikan kegusaran sebenar: **anda mahu tugasan itu mengekalkan irama, tetapi tidak mengganggu anda pada waktu tertentu.**

Kes klasik ialah tugas selang waktu. Menetapkan "setiap dua jam" tanpa tetingkap aktif bermakna ia berjalan sepanjang masa, termasuk semalaman. Dengan tetingkap aktif, ia hanya berjalan pada waktu yang anda tentukan.

Membiarkannya kosong bermakna operasi berterusan. Oleh itu, jika tugasan berjalan pada masa yang tidak sepatutnya, semak medan ini dahulu.

---

## 4. Apa sebenarnya yang berlaku apabila tiba masanya

Di sinilah salah faham paling kerap berlaku. Ramai orang menganggap tugas berjadual bermaksud "menghantar semula ayat asal anda kepada Ejen," dan andaian itu membawa kepada gesaan yang terlalu bergantung pada konteks.

Perkara yang sebenarnya berlaku: apabila penjadual mencapai masa sasaran, ia **mencetuskan larian Ejen bebas**. Larian itu melengkapkan kerja daripada arahan tugasan dan bukannya memainkan semula perbualan di mana tugas itu dibuat.

Ini mempunyai akibat penting: **arahan tugasan mesti membawa konteksnya sendiri.** Latar belakang yang anda simpan dalam kepala anda semasa membuat tugasan, atau butiran yang anda bincangkan sebelum ini dengan Ejen, tidak semestinya akan digunakan pada masa jalankan melainkan ia telah ditulis ke dalam arahan atau sudah ditangkap dalam ingatan jangka panjang.

Bandingkan dua versi:

- **Bergantung kepada konteks**: "Sediakan ringkasan seperti yang baru anda buat." — Pada masa larian, "baru" tidak wujud lagi.
- **Sendiri**: "Ringkaskan e-mel yang belum dibaca dari 24 jam yang lalu, dikumpulkan mengikut penghantar, paling banyak tiga item bagi setiap kumpulan, simpan hanya mesej yang memerlukan balasan saya; keluarkan senarai bertitik tumpu dengan setiap item pada satu baris."

Yang kedua berjalan dengan pasti tanpa sesiapa yang hadir, kerana matlamat, skop, kriteria penapis dan format output semuanya ada di dalamnya.

---

## 5. Bagaimana untuk menulis arahan tugasan yang tahan

Memandangkan mekanisme di atas, arahan tugas yang boleh dipercayai biasanya mengandungi empat bahagian.

**Pertama, tindakan sasaran yang jelas.** Nyatakan perkara yang perlu *buat*, bukan perkara yang perlu "pantau". Anda tidak boleh menilai sama ada "mengawasi" selesai; anda boleh menilai sama ada "ringkaskan dan senarai" selesai.

**Sempadan skop kedua yang jelas.** Julat masa (24 jam lepas), had volum (paling banyak tiga setiap kumpulan), penapis (hanya yang memerlukan balasan saya). Tanpa sempadan, tugas yang sama boleh menghasilkan output yang sangat berbeza pada hari yang berbeza.

**Ketiga, format output eksplisit.** Senaraikan atau prosa, berkumpulan atau rata, berapa lama setiap item mungkin. Memandangkan anda tidak hadir, anda tidak boleh mengatakan "terlalu lama, pendekkan" pada masa ini.

**Keempat, pengendalian pengecualian eksplisit.** Jika tiada apa-apa yang sepadan, patutkah ia menghantar "tiada apa-apa untuk dikendalikan hari ini" atau berdiam diri? Tanpa ini, anda tidak boleh membezakan "tugas tidak berjalan" daripada "tugasan berlari dan tidak menemui apa-apa."

Perkara keempat ialah yang paling kerap ditinggalkan, dan ia secara langsung mempengaruhi keupayaan anda untuk menilai sama ada tugas itu sihat.

---

## 6. Perintah pelancaran yang disyorkan

Jangan menganggap "buat tugasan" sebagai satu langkah. Pesanan ini menimbulkan kebanyakan masalah lebih awal.

1. **Sahkan secara manual dalam sembang dahulu.** Hantar gesaan yang anda ingin gunakan terus kepada Ejen dan semak output. Ini menala gesaan tanpa menjadualkan cara.
2. **Semak gesaan berdasarkan hasil itu.** Output terlalu panjang, skop terlalu luas, format tidak stabil — betulkan semuanya di sini.
3. **Buat tugasan dan tetapkan jadual.** Gunakan ujian dalam bahagian 2 untuk memilih mod.
4. **Sahkan saluran pemberitahuan menghala ke tempat yang sebenarnya anda baca.** Hasil yang dihantar di tempat yang anda tidak pernah lihat adalah bersamaan dengan tiada hasil.
5. **Tetapkan tetingkap masa aktif jika perlu.** Terutamanya untuk tugasan selang waktu, untuk mengelakkan gangguan semalaman.
6. **Tunggu satu larian sebenar, kemudian semak semula rekod larian.** Ini adalah langkah kritikal — **jangan layan "tugas yang dibuat" sebagai selesai.** Simpanan yang berjaya bermakna konfigurasi disimpan, bukannya output yang betul.
7. **Tapis gesaan sekali lagi berdasarkan larian sebenar pertama itu.** Pelaksanaan sebenar boleh berbeza daripada ujian manual, dan semakan kedua ini biasanya memberikan keuntungan kestabilan terbesar.

Produk ini menyokong melihat butiran tugas, mengedit, menjeda dan memadam daripada senarai tugas, jadi langkah 7 adalah murah. Jika tugasan tidak diperlukan buat sementara waktu, lebih suka menjeda daripada memadam supaya konfigurasi kekal tersedia untuk digunakan semula.

---

## 7. Gejala biasa dan di mana untuk melihat

| Gejala | Lebih berkemungkinan menyebabkan | Tindakan yang dicadangkan |
|---|---|---|
| Tiada apa-apa yang berlaku pada masa yang dijadualkan | Tugasan dijeda, atau masa semasa jatuh di luar tetingkap aktif | Semak status tugas dan tetingkap masa aktif |
| Ia berjalan tetapi tiada keputusan tiba | Saluran pemberitahuan dinyahset, atau dihantar ke tempat yang anda tidak baca | Semak konfigurasi pemberitahuan |
| Panjang output dan format berbeza-beza secara liar | Arahan tidak mempunyai sempadan skop dan format output | Tambah empat elemen daripada bahagian 5 |
| Output sangat berbeza daripada ujian manual | Arahan bergantung pada konteks perbualan dari masa penciptaan | Tulis semula sebagai arahan serba lengkap |
| Tidak dapat memberitahu "tidak lari" daripada "tidak menemui apa-apa" | Arahan kekurangan pengendalian pengecualian | Tambah "hantar nota walaupun tiada apa-apa" |
| Terganggu semalaman | Tugas selang tidak mempunyai tetingkap masa aktif | Tetapkan tetingkap masa aktif |

Prinsip umum semasa menyelesaikan masalah: **mula-mula asingkan "tidak berjalan" daripada "berlari tetapi menghasilkan perkara yang salah."** Yang pertama menunjukkan status tugas, tetingkap aktif dan tetapan pemberitahuan; yang terakhir menunjuk kepada arahan itu sendiri. Ini mempunyai laluan penyelesaian yang berbeza sama sekali, dan menyiasatnya bersama membuang masa.

---

## 8. Pendekatan LightVela: kerja proaktif yang boleh dikonfigurasikan dan boleh disemak

Hermes menyokong kerja berjadual pada tahap mekanisme, tetapi memastikan masa jalan dan penjadualan boleh dipercayai diserahkan kepada pengendali. Arahan LightVela adalah untuk menjadikan ini keupayaan produk yang boleh dikonfigurasikan dan boleh disemak:

- **Templat mengurangkan kos permulaan** — apabila anda tidak pasti perkara yang hendak diautomatikkan, mulakan daripada templat siap sedia dan laraskannya.
- **Kitaran hayat tugas boleh diurus** — lihat butiran, edit, jeda atau padam selepas dibuat, tanpa perlu membina semula tugasan untuk menukar satu syarat.
- **Penghantaran boleh dipilih** — saluran pemberitahuan ialah togol pilihan, jadi keputusan tiba di tempat anda sebenarnya membacanya.
- **Dipisahkan daripada keupayaan lain** — tugas berjadual, model, kemahiran dan storan awan dikonfigurasikan secara bebas dan menukar model tidak mengubah tetapan tugas yang dijadualkan.
- **Kegagalan boleh dikesan** — gabungkan anomali pelaksanaan dengan log terkini dalam Diagnostik untuk mencari punca.

---

## Perkara utama

- Tugas berjadual pada asasnya ialah konfigurasi yang disimpan dan boleh diulang tentang masa untuk dijalankan, perkara yang perlu dilakukan dan tempat untuk dihantar.
- Medan adalah: nama, jadual (hari bekerja tetap / selang tetap / sekali), arahan tugas, tetingkap masa aktif, saluran pemberitahuan.
- **Tiada medan "model"**, jadi "segerakkan semula model tugas berjadual selepas bertukar" adalah tidak tepat; jadual juga bukan ungkapan cron sewenang-wenangnya.
- Pencetus memulakan **larian bebas**, bukan ulang tayang perbualan lama, jadi arahan mestilah serba lengkap.
- Arahan yang boleh dipercayai mengandungi empat bahagian: tindakan sasaran, sempadan skop, format output, pengendalian pengecualian.
- Langkah pelancaran yang menentukan ialah yang terakhir: **tunggu larian sebenar dan semak rekod**, dan bukannya berhenti pada "tugasan dibuat."
