## Ringkasan

**A Hermes "Otak" Ejen boleh diganti, tetapi yang diganti hanyalah lapisan model, bukan keseluruhan Ejen. Lapisan model menentukan cara berfikir kali ini — menghuraikan permintaan, merancang langkah, memilih alat yang hendak dipanggil dan mengutarakan jawapan. Lapisan Ejen mengekalkan pemikiran itu dari semasa ke semasa: identiti (`SOUL.md`), profil pengguna (`USER.md`), fakta sesi silang (`MEMORY.md` dan `memories/`), kaedah yang ditangkap (`skills/`), saluran pemesejan, tugas berjadual dan direktori kerja semuanya berada di luar model. Itulah sebabnya menukar model tidak memadamkannya. Pada LightVela, seorang Ejen menggunakan betul-betul satu model aktif pada satu masa dan menukar model tidak mengosongkan memori, fail storan awan, kemahiran atau tetapan tugas berjadual — ia hanya menukar enjin di belakang balasan akan datang. Jika Ejen berasa seperti orang asing selepas bertukar, puncanya hampir selalu berbeza mengikut arahan, pemampatan konteks dan tingkah laku frasa dalam model baharu, bukan hilang ingatan.**

---

## Mengapa soalan ini terus timbul

"Bolehkah saya memindahkan Ejen saya kepada model yang lebih kukuh?" adalah salah satu soalan yang paling biasa orang tanya tentang produk Ejen. Susulan tiba serta-merta: "Adakah ia masih ingat saya?"

Meminta kedua-duanya bersama-sama mendedahkan salah tanggapan yang meluas — bahawa model dan Ejen adalah perkara yang sama. Dalam model mental itu, Ejen hanyalah antara muka sembang yang dililitkan pada LLM, jadi menggantikan model bermakna menggantikan keseluruhan pembantu, dan memulakan semula terasa tidak dapat dielakkan.

Jika itu benar, tiada Ejen boleh memegang nilai jangka panjang. Konteks projek yang anda jelaskan minggu lepas, nada yang anda tala dengan teliti, aliran kerja yang anda rakam — semuanya akan ditetapkan semula dengan setiap peningkatan teknikal. Itu bukan produk yang boleh dipercayai oleh sesiapa sahaja.

Hermes Agent dibina pada premis bertentangan: **model ialah komponen yang boleh diganti, dan Ejen ialah perkara yang berterusan.** Artikel ini membongkar maksud sebenarnya dalam amalan.

---

## 1. Asingkan tiga perkara dahulu: model, masa jalan, aset jangka panjang

Sebelum membincangkan penukaran model, ia membantu untuk mengenali bahawa Ejen mengandungi sekurang-kurangnya tiga lapisan dengan kitaran hayat yang sangat berbeza.

| Lapisan | Apa itu | Kitaran hayat | Hidupkan suis model |
|---|---|---|---|
| **Lapisan model** | LLM menyediakan penaakulan dan penjanaan | Boleh dikonfigurasikan, boleh diganti pada bila-bila masa | Digantikan |
| **Waktu jalan ejen** | Alat yang menjalankan proses, saluran I/O dan penjadualan | Lama berjalan | Tidak berubah |
| **Aset jangka panjang** | `SOUL.md`, `USER.md`, `MEMORY.md`, `memories/`, `skills/`, fail direktori berfungsi | Terkumpul dari semasa ke semasa | Tidak berubah |

Kebanyakan orang hanya melihat lapisan pertama dan tetingkap sembang, kehilangan masa jalan di tengah dan lapisan aset di bawah. Namun kedua-dua lapisan bawah itulah yang menjadikan Ejen dikenali sebagai "yang sama" selama beberapa bulan penggunaan.

Analogi yang berguna: model ialah cara seseorang berfikir sekarang, masa jalan ialah badan dan tangan orang itu, dan aset jangka panjang ialah identiti, ingatan dan tabiat profesional mereka. Mengubah cara seseorang berfikir tidak menjadikan mereka orang yang berbeza, kerana identiti dan ingatan tidak berubah dengannya.

---

## 2. Lapisan model: bertanggungjawab untuk "bagaimana berfikir kali ini"

Dalam satu pertukaran, lapisan model melakukan lebih daripada menghasilkan teks. Ia memutuskan sekurang-kurangnya empat perkara:

1. **Tafsiran** — menukar mesej anda kepada matlamat konkrit, termasuk kekangan yang anda tersiratkan tetapi tidak dinyatakan.
2. **Perancangan** — menilai berapa banyak langkah yang diperlukan oleh kerja, yang didahulukan, dan sama ada penyelidikan mesti mendahului tindakan.
3. **Keputusan panggilan alat** — memutuskan sama ada untuk membaca fail, mencari di web atau menjalankan arahan dan dengan hujah yang mana.
4. **Ungkapan** — menyusun hasil ke dalam bahasa yang boleh dibaca, termasuk jumlah butiran yang perlu disertakan dan format yang hendak digunakan.

Keempat-empatnya tergolong dalam *pas inferens* ini. Mereka membentuk pengalaman segera anda secara langsung, itulah sebabnya menukar model menghasilkan perubahan yang ketara dalam rasa.

Sama pentingnya ialah apa yang **tidak** dimiliki oleh lapisan model:

- Model bukan pangkalan data anda. Ia tidak menyimpan pilihan anda, keadaan projek atau kesimpulan masa lalu.
- Model bukan penjadual. Ia tidak mempunyai pengetahuan bahawa sesuatu mesti berjalan setiap pagi pada pukul tujuh.
- Model bukan pengurus saluran. Ia tidak menentukan Telegram perbualan yang akan dipulangkan.

Kesemua keupayaan tersebut hidup di luar model. Itulah asas teknikal untuk "menukar model tidak menukar Ejen."

---

## 3. Lapisan Ejen: bertanggungjawab untuk menjadikan pemikiran berterusan

Tanggungjawab lapisan Ejen dibahagikan kepada lima kumpulan, disusun mengikut masalah yang diselesaikan setiap satu.

### 3.1 Identiti dan peraturan tingkah laku: `SOUL.md`

`SOUL.md` mentakrifkan siapa Ejen ini, dalam nada apa ia berfungsi, cara ia memberi keutamaan dan perkara yang tidak akan dilakukannya. Ia adalah set peraturan yang stabil, bukan mood yang diubah suai setiap perbualan.

Selepas suis model, `SOUL.md` masih berada di tempatnya. Model baharu membaca dan menggunakan peraturan yang sama — **ia mungkin mengikutinya dengan lebih longgar atau lebih ketat, tetapi peraturan itu sendiri tidak berubah**. Perbezaan itu adalah kunci untuk memahami bahagian "rasanya berbeza" kemudian.

### 3.2 Profil pengguna: `USER.md`

`USER.md` menyimpan maklumat yang stabil tentang anda: tabiat bahasa, kadar komunikasi yang diutamakan, alatan yang anda gunakan dengan kerap, perkara yang jelas untuk dielakkan. Ia menyelamatkan Ejen daripada bertanya "adakah anda mahu versi panjang atau pendek?" setiap masa.

### 3.3 Fakta sesi silang: `MEMORY.md` dan `memories/`

Lapisan ini menyimpan fakta dan kesimpulan yang telah berlaku dan dinilai berbaloi untuk disimpan: apa nama projek itu, apa yang diputuskan minggu lepas, mengapa parameter ditetapkan seperti itu. Hermes membina indeks teks penuh SQLite + FTS5 di atas entri ini dan mengingat kembali yang sepadan apabila anda membangkitkan topik berkaitan, dan bukannya memasukkan sejarah penuh ke dalam konteks.

Ingatan bukan hanya untuk selama-lamanya. Ia dikekalkan melalui operasi atom `add` / `replace` / `remove` atom dan boleh disemak melalui `/memory pending`. Untuk reka bentuk penuh, lihat "Mengapa Lebih Banyak Memori Tidak Lebih Baik: Bagaimana Hermes Agent Memilih, Memilih dan Mengemas kini Memori Jangka Panjang."

### 3.4 Kaedah yang ditangkap: `skills/`

`skills/` menyimpan prosedur standard untuk "apabila situasi X berlaku, lakukan ini." Setiap `SKILL.md` biasanya membawa bahan hadapan YAML yang mengisytiharkan syarat pencetusnya. Ini ialah ingatan prosedural, laluan berasingan daripada Ingatan deklaratif — lihat "Memori Bukan Kemahiran: Bagaimana Hermes Agent Memisahkan Ingatan Fakta dan Prosedur."

### 3.5 Kesambungan dan penjadualan: saluran, tugas berjadual, direktori kerja

- **Saluran** menentukan titik masuk mana Ejen menerima mesej dan dari mana keputusan dihantar.
- **Tugas Berjadual** tentukan kerja yang disiapkan apabila anda tidak bertanya apa-apa.
- **Direktori kerja** menentukan tempat input dan output tugasan hidup, dan tempat sempadan itu terletak.

Ketiga-tiga adalah konfigurasi lapisan Ejen, bebas daripada model yang sedang aktif.

---

## 4. Mengapa penyahgandingan perlu: empat sebab praktikal

Mengasingkan model daripada Ejen bukanlah kemurnian seni bina. Ia menghasilkan faedah konkrit.

**Sebab satu: model bertambah baik jauh lebih pantas daripada aset peribadi terkumpul.** Model yang lebih bermakna mungkin dihantar dalam masa beberapa bulan, manakala memori, pilihan dan aliran kerja anda yang dikongsi akan terkumpul perlahan-lahan. Jika kedua-duanya digandingkan, setiap peningkatan akan menyebabkan anda terkumpul - dan pengguna hanya akan menolak untuk menaik taraf.

**Sebab dua: tugasan yang berbeza memerlukan model yang berbeza.** Penggubalan pantas dan penaakulan berat tidak semestinya model yang sama. Penyahgandingan membolehkan anda menukar setiap tugas dan bukannya mengekalkan Ejen yang berasingan, dengan memori yang berasingan, untuk setiap jenis kerja.

**Sebab ketiga: ketersediaan pembekal tidak pernah dijamin.** Apabila kadar-had pembekal, ralat atau perubahan dasar, anda perlu beralih kepada model dikonfigurasikan lain dengan segera. Jika ingatan terikat pada model, suis itu akan membawa kos yang tidak boleh diterima.

**Sebab empat: pemilikan menjadi tidak jelas.** Oleh kerana memori dan kemahiran hidup dalam fail dan direktori bebas, ia adalah **aset anda** dan bukannya aksesori bagi satu model tertentu. Inilah yang menjadikan frasa "melatih Ejen anda sendiri" bermakna pada mulanya.

---

## 5. Apakah yang sebenarnya berlaku apabila anda menghidupkan model LightVela

Bahagian di atas menerangkan mekanisme. Yang ini menerangkan tingkah laku produk sebenar.

**Satu Ejen menggunakan tepat satu model aktif pada satu masa.** Penukaran bermakna memilih model yang dikonfigurasikan yang sedang aktif — ia tidak mencipta Ejen baharu. Anda tidak perlu berbilang Ejen hanya untuk menggunakan berbilang model.

**Penukaran tidak mengosongkan memori, fail storan awan, kemahiran atau tetapan tugas berjadual.** Suis model menukar hanya enjin yang digunakan untuk balasan berikutnya. Ia tidak mengalihkan sejarah sembang, menulis semula fail dalam storan awan, atau mengubah kemahiran dan konfigurasi tugas yang dijadualkan.

**Bersedia untuk dan mengesahkan suis**, mengikut aliran yang didokumenkan:

1. Sahkan model sasaran telah dikonfigurasikan dan tersedia untuk akaun anda. Jika ia belum dikonfigurasikan lagi, lengkapkan konfigurasi model dahulu.
2. Sediakan mesej ujian ringkas untuk mengesahkan balasan model baharu seperti biasa.
3. Selepas bertukar, hantar mesej ujian itu dalam sembang dan sahkan kedua-duanya bahawa Ejen membalas dan bahawa konsol menunjukkan model yang anda pilih.
4. Jika balasan pertama selepas bertukar perlahan sedikit, tunggu sebentar dan cuba semula sekali sebelum menukar apa-apa lagi.

**Satu pembetulan kepada salah tanggapan biasa**: konfigurasi tugas berjadual terdiri daripada nama, jadual (hari bekerja tetap, selang tetap atau sekali — pilih satu), arahan tugas, tetingkap masa aktif dan saluran pemberitahuan. **Tiada medan "sematkan tugas berjadual ini kepada model tertentu".** Jadi nasihat bahawa anda mesti menjalani tugas berjadual anda dan menyegerakkan semula model mereka selepas bertukar tidak terpakai. Apa yang patut disemak selepas suis ialah kualiti output tugas, bukan medan model yang tidak wujud.

---

## 6. Mengapa ia "berasa berbeza" selepas itu

Ini adalah langkah yang paling kerap salah didiagnosis sebagai amnesia. Perubahan dalam tingkah laku dan kehilangan data adalah masalah yang berbeza, dan mengelirukan mereka menghantar anda ke laluan penyahpepijatan yang salah.

Model benar-benar berbeza sepanjang dimensi ini:

| Dimensi | Bagaimana ia muncul | Biasa salah baca sebagai |
|---|---|---|
| Arahan berikutan | Menggunakan `SOUL.md` kekangan dengan lebih longgar atau ketat | "Peribadinya berubah" |
| Pemampatan konteks | Sukarelawan kurang maklumat latar belakang | "Ia lupa apa yang kita bincangkan" |
| Keutamaan verbositi | Jawapan nyata lebih pendek atau lebih panjang | "Ia menjadi bodoh / lebih bertele-tele" |
| Kecenderungan panggilan alat | Membaca fail atau mencari secara proaktif lebih kurang kerap | "Ia berhenti menggunakan alatan" |
| Gaya bahasa | Perkataan, alamat dan nada yang berbeza | "Ia menjadi orang lain" |

Ujian ini mudah: **tanya tentang fakta yang anda pasti ia patut tahu.** Jika anda memberitahunya nama atau keutamaan projek tertentu sebelum ini, tanyakan perkara itu dengan tepat selepas bertukar. Jika ia menjawab dengan betul, lapisan memori adalah utuh dan anda melihat perbezaan gaya. Jika ia benar-benar tidak dapat menjawab, kemudian periksa sama ada fail memori dan entri masih ada.

Peraturan praktikal: **ubah satu faktor pada satu masa dan uji selepas setiap perubahan.** Menukar model, mengedit persona dan menambahkan kemahiran bersama-sama menyebabkan anda tidak dapat mengetahui lapisan mana yang menyebabkan masalah.

---

## 7. Apabila menukar model adalah berbaloi

Memilih mengikut keperluan adalah lebih berguna daripada mengejar mana-mana model yang pada masa ini dipanggil paling kuat.

| Keperluan anda | Pendekatan yang disyorkan |
|---|---|
| Draf pertama yang lebih pantas | Pilih model yang dikonfigurasikan sesuai dengan kerja rutin yang singkat |
| Bantuan penaakulan atau pengekodan yang lebih kukuh | Pilih model yang anda konfigurasikan untuk jenis kerja |
| Pembekal tidak tersedia atau terhad kadar | Tukar kepada model lain yang dikonfigurasikan dan uji dalam sembang |
| Membandingkan kualiti output | Gunakan mesej ujian pendek yang sama selepas setiap suis, kemudian bandingkan |

Jika Ejen tidak dapat berfungsi selepas bertukar, selesaikan masalah dalam susunan ini: sahkan kelayakan model sasaran dan tetapan pembekal lengkap → sahkan model tersedia untuk akaun anda dengan kuota yang mencukupi → ujian dengan model yang diketahui berfungsi → jika masih gagal, semak log terkini dalam Diagnostik.

---

## 8. Pendekatan LightVela: model sebagai pilihan, aset disimpan oleh pengguna

Hermes memisahkan model daripada Ejen pada peringkat mekanisme, tetapi ia masih menyasarkan orang yang selesa menguruskan fail Markdown dan persekitaran setempat secara langsung. Arahan LightVela adalah untuk menjadikan penyahgandingan itu sebagai pengalaman produk lalai:

- **Model ialah tetapan boleh tukar**, bukan keputusan sekali sahaja yang dikunci semasa persediaan.
- **Memori, kemahiran, storan awan dan tugasan berjadual ialah aset pengguna** yang kekal stabil merentas suis model, jadi menaik taraf tidak bermakna bermula semula.
- **Suis boleh disahkan**: konsol menunjukkan model aktif dan satu mesej ujian dalam sembang mengesahkan suis berfungsi.
- **Kegagalan boleh dikesan**: Diagnostik menyimpan log terkini, iaitu cara anda mengetahui sama ada masalah terletak pada model, konfigurasi atau tugas itu sendiri.

Hasilnya ialah kemajuan model sampai kepada anda secara langsung, manakala apa yang telah anda kumpulkan tidak pernah menjadi harga kemajuan itu.

---

## Perkara utama

- Ejen mempunyai sekurang-kurangnya tiga lapisan: **lapisan model** yang boleh diganti, **masa jalan** yang lama dan **aset jangka panjang** yang terkumpul secara berterusan.
- Lapisan model mengendalikan tafsiran, perancangan, panggilan alat dan ungkapan untuk giliran semasa. Ia tidak menyimpan pilihan, menjalankan jadual atau mengurus saluran.
- `SOUL.md`, `USER.md`, `MEMORY.md`, `memories/`, `skills/`, dan direktori kerja semuanya berada di luar model, jadi menukar model tidak membawanya bersama.
- Pada LightVela, satu Ejen mempunyai satu model aktif pada satu masa; penukaran tidak mengosongkan memori, storan awan, kemahiran atau tugas yang dijadualkan.
- Tugasan Berjadual tidak mempunyai tetapan "model disematkan", jadi dakwaan bahawa anda mesti menyegerakkan semula model tugasan berjadual selepas bertukar adalah tidak tepat.
- Perasaan berbeza selepas suis biasanya datang daripada perbezaan mengikut arahan, pemampatan konteks dan frasa — ingatan tidak hilang. Sahkan dengan satu fakta yang diketahui.


