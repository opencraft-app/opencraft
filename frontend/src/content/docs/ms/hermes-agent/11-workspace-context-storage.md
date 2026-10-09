## Ringkasan

**A Hermes Fail ejen bukanlah satu folder yang tidak kemas. Mereka berada di tiga tempat dengan tanggungjawab yang berbeza. Direktori kerja menyimpan input, output dan pelaksanaan alat tugas semasa, dan ia mempunyai sempadan sebenar — alatan tidak boleh merayau melepasi ruang kerja ke laluan sistem sewenang-wenangnya. Fail konteks (`SOUL.md`, `USER.md`, `MEMORY.md`) bukan lampiran biasa; ia adalah perjanjian jangka panjang yang membentuk cara Ejen memahami hubungan dan kerja. Storan awan ialah ruang kerja fail Ejen untuk bahan tugasan dan output: muat naik dan muat turun fail tunggal menyokong sehingga 1 GB, memadamkan hanya salinan yang dihoskan dalam storan awan Ejen itu dan tidak sekali-kali menyentuh fail asal pada komputer anda, dan satu fail Ejen tidak tersedia secara automatik kepada Ejen lain. Nilai praktikal untuk memisahkan ketiga-tiganya ialah anda sentiasa tahu di mana dokumen berada, siapa yang boleh membacanya dan berapa lama dokumen itu berterusan — yang menyimpan rahsia daripada konteks jangka panjang dan mengekalkan bahan penting daripada wujud hanya dalam satu log sembang.**

---

## Tempat fail disiarkan menentukan sama ada Ejen boleh menyambung dari tempat ia berhenti

Bayangkan kegagalan biasa. Anda menampal ringkasan projek ke dalam sembang, minta Ejen mengekstrak perkara utama, dan ia berfungsi dengan baik. Tiga hari kemudian anda kembali: "berdasarkan ringkasan itu, draf jadual." Jadual yang dihasilkannya jelas tidak sepadan — kerana ringkasan itu hanya pernah wujud dalam perbualan tiga hari lalu, bukan di mana-mana lokasi yang boleh diambil semula dengan pasti.

Sekarang bayangkan kegagalan kedua. Untuk membantu Ejen "mengingat" persediaan pelayan anda, anda menulis blok konfigurasi yang mengandungi kunci rahsia ke dalam fail konteks jangka panjang. Sejak itu, blok itu dibaca sebagai latar belakang dalam setiap sesi. Ini bukan penggunaan memori yang dimaksudkan; ia adalah pendedahan jangka panjang data sensitif yang tidak diperlukan.

Kedua-duanya menunjukkan isu yang sama: **di mana fail hidup bukanlah keutamaan kekemasan. Ia menentukan sama ada bahan boleh diperoleh semula dengan pasti, siapa yang membacanya dan berapa lama ia berterusan.** Artikel ini membentangkan tiga lokasi dan sempadan setiap satu.

---

## 1. Tiga lokasi, tiga tanggungjawab

Mulakan dengan gambaran keseluruhan.

| Lokasi | Apa yang dipegangnya | Siapa yang membacanya | Kitaran hayat |
|---|---|---|---|
| **Direktori kerja** | Input tugas semasa, output, artifak pelaksanaan alatan | Alat dan pelaksanaan semasa tugasan ini | Berskop tugas, jangka hayat |
| **Fail konteks** | `SOUL.md`, `USER.md`, `MEMORY.md` | Perjanjian jangka panjang dibaca setiap sesi | Jangka panjang, diselenggara secara aktif |
| **Storan awan** | Bahan tugasan, dokumen rujukan, output yang patut disimpan | Anda atau Ejen, atas permintaan | Jangka panjang; boleh dimuat turun, boleh dinamakan semula, boleh dipadam |

Pasangan yang paling kerap keliru ialah **fail konteks dan storan awan**. Kedua-duanya berterusan, tetapi ia dibaca dengan cara yang sama sekali berbeza: fail konteks ialah latar belakang pemastautin untuk setiap sesi, manakala fail storan awan adalah bahan yang diambil apabila diperlukan dan tidak pernah disuntik secara automatik ke dalam setiap perbualan.

Perbezaan itu secara langsung menentukan cara maklumat sensitif harus dikendalikan — diliputi di bawah.

---

## 2. Direktori kerja: di mana kerja berlaku, dan di mana sempadan terletak

Direktori kerja menyediakan input, output dan pelaksanaan alat tugas semasa. Ia mempunyai dua sifat yang menentukan.

**Pertama, ia adalah tapak kerja.** Membaca fail, menulis fail, menjalankan arahan dan menghasilkan artifak semuanya berlaku di sini. Ejen yang benar-benar boleh meneruskan kerja memerlukan keadaan pertengahan untuk kekal di sini dan bukannya bermula dari awal setiap kali.

**Kedua, ia mempunyai sempadan yang jelas.** Alat tidak boleh melepasi ruang kerja ke laluan sistem sewenang-wenangnya. Sekatan itu bukanlah keupayaan yang hilang; ia adalah prasyarat yang menjadikan fail membaca/menulis boleh digunakan dan dikawal. Ejen dengan baca/tulis tanpa had merentas keseluruhan sistem fail mengubah sebarang salah sangka kepada hasil yang berpotensi tidak dapat dipulihkan.

Memahami sempadan ini mempunyai akibat praktikal: apabila anda mahu Ejen memproses dokumen, letakkan dokumen itu di tempat yang boleh diakses daripada mengharapkannya memburu direktori sewenang-wenangnya pada mesin anda.

---

## 3. Fail konteks: bukan lampiran, tetapi perjanjian jangka panjang

Ketiga-tiga fail ini sering disalah anggap sebagai "bahan yang saya muat naik ke Ejen." Peranan mereka berbeza sama sekali — mereka menentukan cara Ejen memahami hubungan ini dan kerja ini.

| Fail | Peranan utama | Kandungan biasa |
|---|---|---|
| `SOUL.md` | Peranan, nada, had tingkah laku | Kesimpulan sebelum membuat penaakulan; tiada nasihat pelaburan |
| `USER.md` | Keutamaan dan profil pengguna yang stabil | Lebih suka bahasa Inggeris; kekalkan terminologi sebagaimana adanya |
| `MEMORY.md` | Fakta sesi silang, keadaan projek, keputusan | Nama projek; keputusan minggu lepas |

Tiga cara ia berbeza daripada bahan yang dimuat naik:

**Perbezaan satu: masa baca.** Fail konteks ialah latar belakang pemastautin yang digunakan setiap sesi; fail storan awan diambil hanya apabila diperlukan.

**Perbezaan dua: bentuk kandungan.** Fail konteks sesuai dengan peraturan, keutamaan dan entri fakta yang stabil — bukan blok besar bahan mentah. Menolak ringkas sepuluh muka surat ke dalam `MEMORY.md` hanya membebankan setiap sesi berikutnya.

**Perbezaan tiga: keperluan kepekaan.** Kerana mereka adalah pemastautin, **jangan tulis kata laluan, kunci atau maklumat sensitif yang tidak diperlukan ke dalam fail konteks jangka panjang.** Apabila Ejen mesti mengendalikan konfigurasi sensitif, sediakannya melalui laluan terkawal dan bersihkan selepas itu daripada meninggalkannya di latar belakang selama-lamanya.

Perkara ketiga itu ialah satu-satunya peraturan praktikal yang paling penting dalam artikel ini.

Untuk cara ketiga-tiga fail konteks membentuk gelagat secara bersama, lihat "Dari Mana Hermes Personaliti Ejen Berasal: Persona, Keutamaan dan Memori Jangka Panjang."

---

## 4. Storan awan: ruang kerja fail Ejen

Storan awan diletakkan sebagai ruang kerja fail Ejen: simpan bahan tugasan di satu tempat, muat naik dan susun fail atau muat turun perkara yang anda perlukan secara setempat — semuanya daripada konsol.

### 4.1 Bila hendak menggunakannya

Gunakan storan awan pada bila-bila masa Ejen memerlukan bahan rujukan, dokumen kerja atau tempat yang jelas untuk menyimpan output — dan bukannya bergantung pada tampalan sekali sahaja ke dalam sembang. Dua corak biasa:

- **Muat naik dahulu, kemudian proses** — muat naik ringkasan projek, kemudian minta Ejen mengekstrak perkara utama. Bahan tetap tersedia untuk rujukan kemudian.
- **Buat folder untuk kerja berulang** — berikan folder kerja yang sedang berjalan dan simpannya, jadi output mempunyai rumah yang stabil.

### 4.2 Had konkrit yang patut diketahui

Ini adalah fakta yang perlu ditetapkan sebelum anda bergantung padanya:

- **Muat naik dan muat turun fail tunggal menyokong sehingga 1 GB.** Apa-apa yang lebih besar memerlukan pemisahan atau pemampatan terlebih dahulu.
- **Pemadaman hanya mengalih keluar salinan yang dihoskan dalam storan awan Ejen itu**, bukan fail asal pada komputer anda. Walaupun begitu, muat turun apa sahaja yang anda masih perlukan sebelum memadam — salinan yang dihoskan hilang setelah dialih keluar.
- **Fail Satu Ejen tidak tersedia secara automatik kepada Ejen lain.** Memindahkan bahan antara Ejen memerlukan tindakan yang jelas; jangan menganggap kawasan fail kongsi.
- **Pastikan halaman dibuka semasa memuat naik**, tunggu sehingga selesai, dan sahkan fail muncul dalam folder semasa sebelum melakukan perkara lain.

### 4.3 Struktur folder tidak perlu rumit

Cadangan praktikal: hierarki kompleks biasanya tidak diperlukan. Tiga folder — bahan, sedang berjalan, selesai — mengendalikan kebanyakan situasi. Tambahkan kedalaman hanya apabila ia benar-benar meningkatkan kepantasan anda mencari sesuatu.

Satu ujian untuk sama ada struktur itu sihat: **adakah nama folder menjelaskan tugas mana yang dimiliki oleh bahan tersebut?** Jika anda perlu membuka folder untuk mengingati kandungan di dalamnya, nama itu telah gagal — dan Ejen bergantung pada nama yang sama untuk menilai bahan yang digunakan.

---

## 5. Di manakah dokumen ini harus pergi? Jalan keputusan

Menghadapi dokumen tertentu, selesaikan soalan ini mengikut urutan.

**Soalan satu: adakah ini peraturan, keutamaan atau entri fakta?**
Ya → fail konteks. Peraturan kepada `SOUL.md`, keutamaan kepada `USER.md`, fakta kepada `MEMORY.md`. Simpan kesimpulan suling, bukan teks sumber mentah.

**Soalan dua: adakah ia bahan atau keluaran berbaloi untuk disimpan dan mungkin dirujuk berulang kali?**
Ya → storan awan. Muat naiknya ke dalam folder yang sesuai dengan nama yang menerangkan tujuannya.

**Soalan tiga: adakah ia hanya menjalankan satu tugasan ini?**
Ya → mengendalikannya dalam direktori kerja; tiada pengekalan jangka panjang diperlukan.

**Soalan empat: adakah ia mengandungi kata laluan, kunci atau maklumat peribadi yang sensitif?**
Ya → **jauhkan ia daripada fail konteks jangka panjang.** Sediakannya melalui laluan terkawal dan bersihkan apabila tugasan tamat.

Nilai laluan ini mengubah "jatuhkannya ke mana-mana" menjadi pilihan yang munasabah. Kebanyakan geseran sehari-hari datang daripada mencantumkan soalan satu dan dua — menolak bahan pukal ke dalam fail konteks atau meninggalkan bahan yang patut dikekalkan dalam log sembang.

---

## 6. Gejala biasa dan di mana untuk melihat

| Gejala | Lebih berkemungkinan menyebabkan | Tindakan yang dicadangkan |
|---|---|---|
| Ejen tidak dapat mencari bahan yang anda kongsi sebelum | Ia hanya wujud dalam sejarah sembang, tidak pernah berterusan | Muat naik ke storan awan, kemudian rujuk |
| Muat naik atau muat turun gagal | Fail melebihi 1 GB, atau anda meninggalkan halaman pada pertengahan muat naik | Semak saiz; muat naik semula dan pastikan halaman dibuka |
| Fail "hilang" selepas berpindah ke Ejen lain | Fail tergolong dalam storan Ejen asal dan tidak dikongsi | Muat turun daripada yang asal, kemudian muat naik ke yang baharu |
| Bimbang memadam fail awan juga memadam fail tempatan | Salah faham memadam skop | Pemadaman hanya menjejaskan salinan yang dihoskan, bukan asal tempatan anda |
| Setiap sesi terasa berat dan perlahan | Bahan mentah pukal telah ditolak ke dalam fail konteks jangka panjang | Alihkannya keluar daripada fail konteks ke storan awan |
| Bimbang pendedahan jangka panjang rahsia | Kunci atau kata laluan telah ditulis ke dalam fail konteks | Keluarkan mereka dengan serta-merta; menyediakan melalui laluan terkawal sebaliknya |

Dua baris terakhir ialah dua muka kesilapan yang sama: **melakukan fail konteks sebagai gudang dokumen.** Ujian ini mudah — jika sekeping kandungan tidak perlu dibaca dalam setiap sesi, ia tidak termasuk dalam fail konteks.

---

## 7. Pendekatan LightVela: menjadikan lokasi kelihatan dan boleh dikawal

Hermes membezakan direktori kerja daripada fail konteks di peringkat mekanisme, tetapi pengehosan dan mendapatkan semula bahan masih diatur oleh pengendali. Arahan LightVela adalah untuk menjadikan ruang kerja fail sebagai keupayaan produk yang boleh dilihat dan boleh dikawal:

- **Ruang kerja fail yang disatukan** — muat naik, buat, susun, muat turun, namakan semula dan padam daripada konsol tanpa meninggalkan produk.
- **Sempadan eksplisit** — direktori kerja dihadkan dan alatan tidak sampai melepasi ruang kerja ke laluan sistem sewenang-wenangnya.
- **Kosongkan pemadaman semantik** — pemadaman hanya mengalih keluar salinan yang dihoskan dalam storan Ejen itu, meninggalkan asal tempatan tidak disentuh dan menggesa anda untuk memuat turun dahulu.
- **Pengasingan antara Ejen** — kawasan fail berasingan bagi setiap Ejen, jadi bahan tidak bocor di tempat yang tidak sepatutnya dikongsi.
- **Dipisahkan daripada keupayaan lain** — menukar model tidak menulis semula fail dalam storan awan.

---

## Perkara utama

- Tiga lokasi, tiga peranan: **direktori kerja** (tapak kerja terhad), **fail konteks** (perjanjian jangka panjang pemastautin), **storan awan** (bahan dan output diambil atas permintaan).
- Fail konteks dan storan awan berbeza dalam masa baca: yang pertama adalah pemastautin setiap sesi, yang kedua adalah atas permintaan.
- Fakta storan awan: **1 GB** had muat naik/muat turun setiap fail; memadam hanya mengeluarkan salinan yang dihoskan; **fail satu Ejen tidak tersedia secara automatik kepada yang lain**.
- Struktur folder kekal mudah — bahan / dalam proses / siap biasanya cukup, dengan nama yang menerangkan tujuan.
- Satu peraturan yang perlu dipegang: **jangan sekali-kali menulis kata laluan, kunci atau maklumat sensitif yang tidak diperlukan ke dalam fail konteks jangka panjang.**
- Apabila sesi terasa berat atau perlahan, mula-mula semak sama ada bahan pukal telah ditolak ke dalam fail konteks.


