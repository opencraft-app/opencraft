## Ringkasan

**Menukar model tidak menjadikan a Hermes Agent melupakan anda, kerana model, persona dan memori adalah tiga lapisan yang disimpan secara berasingan: model mengendalikan penaakulan dan penjanaan, `SOUL.md` mentakrifkan sempadan peranan dan ekspresi, dan `USER.md` tambah lagi `MEMORY.md` (dengan `memories/`) memegang profil pengguna dan fakta sesi silang. hidup LightVela, menukar model hanya menukar enjin di sebalik balasan berikutnya — ia tidak mengosongkan memori, fail storan awan, kemahiran atau tetapan tugas yang dijadualkan dan ia tidak mengalihkan sejarah sembang. Ia mungkin benar-benar "berasa berbeza" selepas itu, tetapi itu datang daripada kecenderungan mengikut arahan, pemampatan konteks, verbositi dan panggilan alat model baharu, bukan daripada kehilangan data. Terdapat satu cara untuk membezakan mereka: tanya tentang fakta yang anda pasti ia patut tahu. Jika ia menjawab, anda melihat perbezaan gaya; jika ia tidak boleh, maka siasat lapisan memori.**

---

## Perkataan berubah — adakah ingatan itu pergi juga?

Selepas menukar model, pengalaman yang paling biasa ialah ini: frasa berubah, panjangnya berubah dan ia tidak lagi memaparkan perkara yang anda bincangkan sebelum ini.

Reaksi pertama hampir semua orang ialah "ia melupakan saya." Reaksi itu adalah semula jadi — dalam kehidupan seharian, apabila seseorang berhenti merujuk sejarah yang dikongsi, kami mengesyaki mereka terlupa.

Di dalam sistem Ejen, analogi itu mengelirukan. **"Tidak menyebutnya" dan "tidak mengetahuinya" adalah perkara yang sama sekali berbeza.** Yang pertama ialah strategi ekspresi; yang kedua tiada data. Mereka berbeza dalam diagnosis, membetulkan kos dan keterukan, dan menggabungkannya bermakna menghabiskan masa untuk membaiki masalah yang tidak wujud.

Artikel ini memisahkan kedua-duanya secara muktamad dan memberi anda ujian yang boleh diambil tindakan.

---

## 1. Lima lapisan: apa yang diganti, apa yang kekal

Pertama, tepat tentang apa yang sebenarnya berubah oleh tindakan "menukar model".

| Lapisan | Tanggungjawab | Di mana ia tinggal | Selepas bertukar |
|---|---|---|---|
| **Model** | Penaakulan, perancangan, keputusan panggilan alat, bahasa | Tetapan boleh dikonfigurasikan | **Diganti** |
| **Persona** | Peranan, nada, keutamaan, had tingkah laku | `SOUL.md` | Dipelihara |
| **Profil pengguna** | Tabiat bahasa, pacing, alatan biasa, perkara yang perlu dielakkan | `USER.md` | Dipelihara |
| **Memori** | Fakta sesi silang, keadaan projek, keputusan lepas | `MEMORY.md`, `memories/` | Dipelihara |
| **Kemahiran** | Prosedur standard yang dicetuskan oleh situasi | `skills/` (setiap satu `SKILL.md`) | Dipelihara |

Perkara utama: **empat lapisan terakhir semuanya berada di luar model.** Apabila model diganti, fail dan direktori tersebut kekal di tempatnya, dan model baharu membaca dan menggunakannya.

Inilah sebabnya mengapa dokumentasi boleh menyatakan dengan jelas bahawa menukar model tidak mengosongkan ingatan Ejen, fail storan awan, kemahiran atau tetapan tugas yang dijadualkan — itu bukan ciri perlindungan yang ditambahkan seseorang, ia adalah akibat semula jadi daripada storan berlapis. Untuk pembahagian kerja penuh, lihat "Bolehkah Hermes Otak Ejen Digantikan? Lapisan Model vs Lapisan Ejen."

---

## 2. Jadi mengapa ia benar-benar terasa berbeza?

Jika data semuanya utuh, mengapa pengalaman berubah? Kerana **konteks yang sama, diserahkan kepada model yang berbeza, akan ditafsir semula.**

Model berbeza mengikut dimensi sebenar ini:

### 2.1 Arahan mengikut

Kekangan dalam `SOUL.md` masih ada, tetapi model baharu mungkin menerapkannya dengan lebih longgar atau lebih ketat. Jika anda menulis "memimpin dengan kesimpulan", sesetengah model mematuhi setiap masa manakala yang lain membinanya berdasarkan soalan yang rumit.

**Muncul sebagai**: personaliti berubah. **Sebenarnya**: peraturan tidak berubah; kepatuhan berubah.

### 2.2 Pemampatan konteks

Semasa mengarang jawapan, Ejen memutuskan berapa banyak latar belakang untuk dipetik. Model menimbang perkara ini secara berbeza: sesetengahnya secara proaktif menyatakan semula "yang anda sebutkan X tadi," yang lain menganggap anda tahu dan terus kepada intipati.

**Muncul sebagai**: ia terlupa apa yang kita bincangkan. **Sebenarnya**: panggil semula berfungsi, ia tidak menyatakannya semula. Ini adalah kes yang paling kerap salah didiagnosis sebagai amnesia.

### 2.3 Keutamaan verbositi

Untuk soalan yang sama, panjang jawapan boleh berbeza beberapa kali ganda antara model.

**Muncul sebagai**: ia menjadi bodoh, atau ia menjadi panjang lebar. **Sebenarnya**: verbositi lalai yang berbeza, boleh laras melalui pilihan dalam `USER.md` atau permintaan eksplisit.

### 2.4 Kecenderungan panggilan alat

Sesetengah model lebih suka membaca fail atau mencari sebelum menjawab; yang lain bersandar pada konteks sedia ada.

**Muncul sebagai**: ia berhenti menggunakan alatan. **Sebenarnya**: ambang berbeza untuk memanggilnya.

### 2.5 Gaya bahasa

Perkataan, bentuk alamat dan nada semuanya boleh berubah.

**Muncul sebagai**: ia menjadi orang lain. **Sebenarnya**: kategori paling permukaan dan paling tidak berbahaya.

Dilihat bersama, kelima-lima ini berkongsi satu sifat: **mereka semua tentang *bagaimana ia menyatakan*, bukan *apa yang diketahuinya*.** Itulah yang menjadi sandaran ujian di bawah.

---

## 3. Satu tindakan menyelesaikannya: tanya tentang fakta yang diketahui

Jangan menilai dengan perasaan. Gunakan ujian deterministik.

**Kaedah**: fikirkan fakta yang anda **pasti** anda memberitahunya secara eksplisit dan itu sepatutnya sudah ada dalam ingatan jangka panjang — nama projek, pilihan bahasa anda, kekangan yang jelas. Selepas bertukar, tanya tentang perkara itu.

**Tafsiran**:

| Keputusan | Kesimpulan | Langkah seterusnya |
|---|---|---|
| Jawapan betul | Lapisan memori utuh; anda melihat perbezaan gaya | Laraskan keutamaan atau gesaan; tinggalkan ingatan |
| Tidak boleh menjawab tetapi mengatakan ia tidak pasti | Mungkin rindu ingat kembali | Ungkapkan semula dan minta sekali lagi untuk memisahkan ingat kembali daripada ketiadaan |
| Menjawab salah atau mencipta sesuatu | Kandungan memori itu sendiri perlu menyemak | Periksa sama ada entri itu wujud atau sudah basi |

Ujian ini berfungsi kerana ia mengalih keluar pembolehubah ungkapan: anda bertanya tentang fakta dengan jawapan yang pasti, jadi tidak kira bagaimana gaya berubah, ketepatan adalah objektif.

---

## 4. Senarai semak pasca suis yang lengkap

Perintah ini meliputi sebahagian besar kes.

1. **Sahkan suis telah berkuat kuasa** — konsol harus menunjukkan model yang anda pilih. Ini menolak "fikir saya bertukar tetapi tidak."
2. **Hantar mesej ujian ringkas** — sahkan model baharu membalas seperti biasa. Jika balasan pertama selepas bertukar perlahan sedikit, tunggu dan cuba semula sekali sebelum menukar apa-apa lagi.
3. **Jalankan ujian fakta yang diketahui** — sahkan lapisan memori menggunakan bahagian 3.
4. **Semak persona masih sepadan dengan jangkaan** — lihat sama ada nada dan had kekal dalam `SOUL.md`. Jika hanyut jelas, jadikan kekangan utama lebih khusus.
5. **Spot-check bahawa kemahiran masih dicetuskan** — cuba satu dalam situasi yang sepadan dan sahkan beban kemahiran.
6. **Semak kualiti output tugas berjadual** — ambil perhatian bahawa anda sedang menyemak **kualiti output**, bukan menyegerakkan medan model. Tugasan Berjadual tidak mempunyai tetapan "model disematkan".
7. **Sahkan fail storan awan adalah utuh** — penukaran tidak akan menulis semula fail tersebut; ini hanya pengesahan.

Langkah 6 patut diberi penekanan, kerana tuntutan yang diedarkan secara meluas mengatakan anda mesti menyegerakkan semula setiap model tugas yang dijadualkan selepas bertukar. Sebenarnya tugas berjadual terdiri daripada nama, jadual (hari bekerja tetap, selang tetap, atau sekali), arahan tugas, tetingkap masa aktif dan saluran pemberitahuan — **tanpa medan model**. Jadi tindakan yang betul ialah menunggu satu larian sebenar dan semak sama ada kualiti output masih memenuhi jangkaan.

---

## 5. Jika ia benar-benar berhenti berfungsi selepas bertukar

Ini adalah kelas masalah yang berbeza — bukan "berasa berbeza" tetapi "tidak berfungsi." Selesaikan masalah dalam susunan ini:

1. **Sahkan konfigurasi model selesai** — kembali ke konfigurasi model dan semak model sasaran, bukti kelayakan dan tetapan pembekal.
2. **Sahkan ketersediaan akaun dan kuota** — sahkan model tersedia untuk akaun anda dan kuota atau baki pihak pembekal adalah mencukupi.
3. **Uji dengan model yang diketahui berfungsi** — ini memisahkan "model ini mempunyai masalah" daripada "keseluruhan laluan mempunyai masalah."
4. **Semak log terbaharu dalam Diagnostik** — jika masih tidak dapat membalas, gunakan log untuk menentukan sama ada isu itu terletak pada model, konfigurasi atau tugas, kemudian tentukan sama ada untuk menetapkan semula konfigurasi model.

Satu prinsip umum perlu diingat: **ubah satu faktor pada satu masa, dan uji selepas setiap perubahan.** Menukar model, mengedit persona dan menambah kemahiran sekaligus menyebabkan anda tidak dapat mengaitkan kegagalan. Semasa menyelesaikan masalah, disiplin ini lebih bernilai daripada perasaan mengkonfigurasi segala-galanya dalam satu laluan.

---

## 6. Apabila menukar adalah berbaloi, dan apabila ia tidak

Penukaran memerlukan kos: anda menyesuaikan semula kepada gaya ekspresi yang berbeza dan mungkin perlu menala semula gesaan. Oleh itu, adalah wajar untuk menjadi jelas tentang motivasi.

**Berbaloi bertukar**:

| Perlu | Pendekatan yang disyorkan |
|---|---|
| Draf pertama yang lebih pantas | Pilih model yang dikonfigurasikan sesuai dengan kerja rutin yang singkat |
| Bantuan penaakulan atau pengekodan yang lebih kukuh | Pilih model yang anda konfigurasikan untuk jenis kerja |
| Pembekal tidak tersedia atau terhad kadar | Tukar kepada model lain yang dikonfigurasikan dan uji dalam sembang |
| Membandingkan kualiti output | Gunakan **mesej ujian **yang sama** selepas setiap suis, kemudian bandingkan |

**Tidak berbaloi untuk bertukar**:

- Kerana satu jawapan mengecewakan anda. Mula-mula semak sama ada gesaan itu cukup khusus atau sama ada `SOUL.md` kekangan adalah cukup konkrit.
- Kerana anda mendengar model lain lebih kuat. Lebih kukuh tidak sama dengan lebih sesuai dengan campuran tugas dan profil kos anda.
- Untuk "menyelesaikan masalah ingatan." Masalah ingatan tidak dapat diselesaikan pada lapisan model; sebaliknya periksa entri memori.

Frasa "mesej ujian yang sama" dalam baris keempat penting: jika anda membandingkan model menggunakan soalan berbeza setiap kali, anda mengukur kesukaran soalan, bukan perbezaan model.

---

## 7. Pendekatan LightVela: menjadikan penukaran operasi berisiko rendah

Hermes mencapai pemisahan lapisan pada tahap mekanisme, tetapi mengurus akses model dan persekitaran masih berada pada pengendali. Arahan LightVela adalah untuk menjadikan penukaran sebagai operasi rutin, berisiko rendah, dan boleh disahkan:

- **Satu Ejen mempunyai satu model aktif pada satu masa** — bertukar bermakna memilih, tanpa memerlukan Ejen berasingan bagi setiap model.
- **Aset kekal stabil merentas suis** — memori, fail storan awan, kemahiran dan tetapan tugas yang dijadualkan tidak terjejas dan sejarah sembang tidak dialihkan.
- **Suis boleh disahkan** — konsol menunjukkan model aktif dan satu mesej ujian mengesahkan kejayaan.
- **Kegagalan boleh dikesan** — Diagnostik menyimpan log terkini untuk memisahkan model, konfigurasi dan isu tugas.
- **Perubahan faktor tunggal digalakkan** — menukar satu perkara pada satu masa dan ujian serta-merta ialah cadangan yang didokumenkan.

---

## Perkara utama

- Model, persona, profil pengguna, ingatan dan kemahiran adalah lima lapisan bebas; pensuisan menggantikan hanya yang pertama.
- Tingkah laku yang didokumenkan: penukaran tidak mengosongkan memori, storan awan, kemahiran atau tugas yang dijadualkan dan tidak mengalihkan sejarah sembang.
- "Rasa berbeza" berasal daripada lima perbezaan lapisan ungkapan: mengikut arahan, pemampatan konteks, verbositi, kecenderungan panggilan alat, gaya bahasa.
- **Menentukan kehilangan ingatan sebenar mengambil satu langkah**: tanya tentang fakta yang diketahui pasti.
- Tugas Berjadual tidak mempunyai medan model yang disematkan; selepas bertukar, semak kualiti keluaran daripada memburu bidang itu.
- Semasa menyelesaikan masalah, pegang pada satu peraturan: tukar satu faktor pada satu masa dan uji serta-merta.


