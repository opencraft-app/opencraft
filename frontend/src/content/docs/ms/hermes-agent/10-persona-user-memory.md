## Ringkasan

**Keperibadian Hermes Keperibadian ejen bukanlah blok tetap salinan aksara. Ia muncul daripada tiga bahagian bekerja bersama: `SOUL.md` menetapkan siapa itu dan cara ia berfungsi — peraturan tingkah laku yang stabil; `USER.md` merekodkan cara anda mahu dilayan — lalai perhubungan; `MEMORY.md` dan `memories/` memegang apa yang anda berdua telah sediakan — bukti sejarah yang dikongsi. Mengekalkan peranan mereka berbeza adalah perkara yang membolehkan Ejen menjadi stabil dan individu pada masa yang sama: persona sahaja menjadikannya sama untuk semua orang, ingatan sahaja membuat tingkah lakunya hanyut tanpa diduga. Mereka tidak boleh menggantikan satu sama lain — persona tidak menyimpan fakta khusus, `USER.md` tidak menyimpan mood sekali sahaja, dan `MEMORY.md` tidak membawa peraturan tingkah laku. Ketiga-tiga kekal pada tempatnya apabila anda menukar model, jadi kestabilan personaliti tidak bergantung pada mana-mana model tertentu.**

---

## Mengapa watak yang sama harus berkelakuan berbeza dengan orang yang berbeza

Bayangkan dua pengguna yang kedua-duanya mengkonfigurasi Ejen mereka sebagai "pembantu penyelidik pesakit."

Yang pertama ialah pengurus produk yang lebih mengutamakan kesimpulan sebelum alasan dan kebanyakannya membincangkan rentak dan keutamaan keluaran. Yang kedua ialah pelajar yang memerlukan derivasi penuh dan kebanyakannya membincangkan konsep dan tugasan.

Jika kedua-dua Ejen mengatakan perkara yang sama, maka "pembantu penyelidik pesakit" tidak pernah benar-benar mendarat — ia kekal sebagai label dan bukannya menjadi cara konkrit untuk bekerjasama.

Sebaliknya, jika pemperibadian bermakna membiarkan tingkah laku hanyut dengan bebas dalam setiap perbualan, Ejen akan kehilangan kebolehramalan: hari ini ketat, esok cuai. Anda tidak boleh bergantung padanya.

**Personaliti perlu memenuhi dua keperluan yang bercanggah sekaligus: stabil dan khusus orang.** Hermes menyelesaikannya dengan membahagikan dua keperluan merentas lapisan, setiap satu dibawa oleh fail yang berbeza.

---

## 1. Tiga bahagian, tiga tanggungjawab

Mulakan dengan gambaran keseluruhan.

| Sekeping | Di mana ia tinggal | Soalan yang dijawabnya | Tukar kekerapan |
|---|---|---|---|
| **Persona** | `SOUL.md` | siapa saya? Apakah prinsip yang saya gunakan? | Sangat rendah; suntingan adalah keputusan yang disengajakan |
| **Keutamaan pengguna** | `USER.md` | Bagaimana anda mahu dilayan? | Rendah; menyesuaikan diri dengan tabiat jangka panjang |
| **Memori jangka panjang** | `MEMORY.md`, `memories/` | Apa yang telah kita sediakan? | Tinggi; entri boleh ditambah kebanyakan sesi |

**Perbezaan dalam kekerapan perubahan** itu adalah salah satu sebab utama untuk memisahkan mereka. Meletakkan buku peraturan yang tidak bergerak selama berbulan-bulan ke dalam fail yang sama seperti senarai fakta yang berkembang setiap hari bermakna bahagian yang stabil dihanyutkan oleh yang tidak menentu. Ini adalah alasan yang sama di sebalik mengekalkan `USER.md` dan `MEMORY.md` berasingan — lihat "Mengapa Hermes Agent Membahagikan Memori kepada Dua: Peranan USER.md dan MEMORY.md."

---

## 2. Persona: peraturan tingkah laku yang stabil

`SOUL.md` ialah buku peraturan Ejen, dan ia biasanya meliputi:

- **Peranan** — perkara yang dimainkan: pembantu penyelidik, rakan kongsi penulis, pembantu tugas komuniti.
- **Nada dan ekspresi** — formal atau santai, sama ada menggunakan analogi, sama ada humor dialu-alukan.
- **Pemesanan keutamaan** — yang menang apabila ketepatan bercanggah dengan kelajuan, atau ringkas dengan kesempurnaan.
- **Had tingkah laku** — perkara yang tidak akan dilakukan, perkara yang tidak akan dikembangkan, tindakan mana yang memerlukan pengesahan terlebih dahulu.

Tiga perkara praktikal semasa menulis persona.

**Pertama, tulis prinsip, bukan fakta.** "Saya bekerja untuk pengurus produk dalam projek demo ejen" tidak termasuk dalam `SOUL.md` — itu adalah fakta, dan ia tergolong dalam `USER.md` atau ingatan. Seseorang harus menyatakan prinsip yang tahan lama seperti "untuk soalan produk, berikan kesimpulan sebelum alasan."

**Kedua, buat had yang cukup konkrit untuk menilai.** "Kekal profesional" tidak boleh dinilai untuk pematuhan. "Jangan tawarkan keputusan perubatan, undang-undang atau pelaburan; berikan maklumat awam dan cadangkan untuk berunding dengan profesional" boleh. Peraturan abstrak menghasilkan pematuhan yang sangat berbeza merentas model.

**Ketiga, nyatakan keutamaan secara jelas untuk konflik.** Peraturan tidak dapat dielakkan bercanggah — ringkas dan kesempurnaan adalah satu pasangan sedemikian. Tanpa pesanan yang jelas, Ejen perlu meneka setiap kali, dan tingkah lakunya menjadi tidak konsisten.

---

## 3. Pilihan pengguna: lalai perhubungan

`USER.md` membawa **maklumat stabil tentang anda**, jadi Ejen tidak perlu bertanya lagi setiap kali. Calon yang baik:

- **Bahasa dan ungkapan** — bahasa mana, sama ada untuk mengekalkan istilah dalam bentuk asalnya, sama ada contoh membantu.
- **Pacing komunikasi** — kesimpulan dahulu, atau laluan penaakulan penuh.
- **Alat dan persekitaran biasa** — timbunan, platform dan gaya kerja yang anda gunakan setiap hari.
- **Perkara eksplisit untuk dielakkan** — arah yang anda tidak mahu disiasat, frasa yang anda tidak mahu digunakan.

Terdapat ujian mudah untuk sama ada sesuatu termasuk dalam `USER.md`: **adakah ia masih benar dalam masa tiga bulan?** "Saya lebih suka jawapan ringkas" mungkin akan, jadi ia sesuai. "Saya tergesa-gesa hari ini" tidak akan — itu adalah konteks sekali sahaja dan harus mengelak.

Ujian ini penting. Menulis mood sekali sahaja ke dalam `USER.md` menjadikan Ejen menganggap keadaan sementara sebagai kekal. Jika anda pernah berkata "singkatkan" semasa tergesa-gesa dan itu mengeras menjadi pilihan jangka panjang, ia akan menahan butiran kemudian apabila anda benar-benar memerlukannya.

---

## 4. Ingatan jangka panjang: bukti sejarah yang dikongsi

`MEMORY.md` dan `memories/` menyimpan **fakta yang telah berlaku dan patut disimpan**: keadaan projek, keputusan yang dibuat, kesimpulan boleh guna semula, sebab parameter ditetapkan seperti sedia ada.

Hubungannya dengan dua yang lain:

- Persona menentukan **prinsip tingkah laku**.
- `USER.md` menentukan **gaya interaksi lalai**.
- Memori menentukan **latar belakang yang anda berdua kongsi**.

Recall adalah atas permintaan: Hermes membina indeks teks penuh SQLite + FTS5 di atas entri dan menarik yang sepadan ke dalam konteks apabila anda membangkitkan topik yang berkaitan, dan bukannya menolak semua sejarah masuk. Penulisan tidak juga dilampirkan tanpa sempadan — ia dikekalkan melalui atomic `add` / `replace` / `remove` operasi dan boleh disemak melalui `/memory pending`. Untuk logik penyusunan penuh, lihat "Mengapa Lebih Banyak Memori Tidak Lebih Baik: Bagaimana Hermes Agent Memilih, Menyusun dan Mengemas kini Memori Jangka Panjang."

**Memori tidak boleh menggantikan persona.** Kesilapan biasa ialah menulis peraturan tingkah laku sebagai entri ingatan, seperti "ingat: sentiasa berikan kesimpulan dahulu." Itu mewujudkan dua masalah: entri mungkin tidak dapat ditarik balik jika pertanyaan tidak sepadan dengannya, dan ia boleh dihapuskan oleh entri kemudian. Peraturan tingkah laku tergolong dalam `SOUL.md`, yang sentiasa bermastautin.

---

## 5. Bagaimana ketiga-tiganya bergabung untuk menghasilkan satu jawapan

Senario konkrit yang mengikat lapisan bersama-sama.

**Persediaan**:

- `SOUL.md`: pembantu penyelidik; kesimpulan sebelum membuat alasan; benderakan ketidakpastian secara eksplisit; jangan mengembangkan nasihat perubatan atau pelaburan.
- `USER.md`: lebih suka bahasa Inggeris; mengekalkan istilah teknikal dalam bentuk asalnya; pastikan jawapan boleh diimbas.
- `MEMORY.md`: sedang bekerja di tapak global untuk projek ejen-demo; minggu lepas memutuskan untuk menukar halaman utama kepada kecerunan animasi; projek berjalan pada Next.js.

**Soalan anda**: "Untuk pendekatan halaman utama semasa, apakah risiko menambah latar belakang video?"

**Apa yang disumbangkan oleh setiap lapisan**:

1. **Memori** membekalkan latar belakang: Ejen mengetahui halaman yang "halaman utama" merujuk dan bahawa ia baru sahaja ditukar kepada kecerunan animasi, jadi ia boleh menganggap latar belakang video sebagai perubahan di atasnya dan bukannya keputusan kosong.
2. **Persona** menentukan struktur: kesimpulan dahulu ("risiko utama ialah prestasi di atas lipatan dan penggunaan data mudah alih"), kemudian alasan, dengan ketidakpastian dibenderakan secara jelas.
3. **`USER.md`** menentukan ungkapan: jawab dalam bahasa Inggeris, kekalkan istilah seperti `LCP` dan `autoplay` seperti sedia ada, dan pastikan panjangnya boleh diimbas.

Keluarkan mana-mana satu lapisan dan hasilnya merosot dengan ketara: tanpa ingatan jawapan tetap generik; tanpa persona struktur merayau-rayau dan ketidakpastian tidak dihalang; tanpa keutamaan bahasa dan panjangnya tidak sesuai dengan cara anda membaca.

---

## 6. Gejala biasa dan di mana masing-masing berada

Dalam amalan, soalan yang paling kerap ialah "ke mana harus pergi maklumat ini?" Jadual di bawah menjawabnya.

| Gejala | Lebih berkemungkinan menyebabkan | Apa yang perlu diubah |
|---|---|---|
| Pendekatan generik yang sama untuk setiap topik | Memori tidak mempunyai latar belakang khusus anda | Tambah entri memori |
| Tingkah laku tidak konsisten, ketat kemudian cuai | Peraturan persona terlalu abstrak, atau tiada keutamaan konflik | Edit `SOUL.md` supaya peraturan boleh dinilai |
| Anda menyatakan semula pilihan setiap kali | Pilihan tidak pernah ditulis kepada `USER.md` | Tambahkannya pada `USER.md` |
| Menganggap keadaan sementara sebagai | Konteks sekali sahaja telah ditulis ke dalam `USER.md` | Buang entri itu; nyatakan dalam perbualan sebaliknya |
| Peraturan terpakai kadangkala tetapi tidak selalu | Peraturan telah disimpan sebagai entri memori | Alihkan ia daripada memori ke `SOUL.md` |
| Nada berubah dengan ketara selepas suis model | Model baharu menggunakan peraturan dengan ketegasan yang berbeza | Jadikan kekangan utama lebih khusus; tinggalkan ingatan |

Baris terakhir patut diberi penekanan: **perubahan nada selepas menukar model bukanlah personaliti yang hilang.** `SOUL.md` masih di tempatnya; kepatuhan berubah. Untuk mengetahui cara membezakannya, lihat "Adakah Menukar Model Membuat Ejen Terlupa? Model Menyahganding, Persona dan Memori."

---

## 7. Pendekatan LightVela: personaliti dan keutamaan sebagai aset yang boleh diurus

Hermes memisahkan tiga lapisan ini dengan jelas, tetapi ia masih menyasarkan orang yang mengedit Markdown secara langsung. LightVela menjalankan model yang dihoskan awan dan tidak mendedahkan operasi sistem fail yang dihadapi pengguna, jadi lapisan ini diselenggara secara berbeza daripada dalam persediaan yang dihoskan sendiri:

- **Persona dikonfigurasikan melalui ciri Persona** — bahagian Persona pada halaman tetapan Ejen menawarkan dua titik masuk, melukis persona secara rawak atau menjawab kuiz pendek. Semak nota peranan, nada dan tingkah laku kad persona, kemudian pilih Inject Persona untuk menerapkannya. Ia menjana dan menyuntik Jiwa tanpa memerlukan anda menyentuh sistem fail awan, walaupun ia bukan editor tujuan umum untuk fail awan sewenang-wenangnya.
- **Memori boleh dilihat dalam konsol** — halaman memori menunjukkan perkara yang telah disimpan oleh Ejen, dengan tab berasingan untuk Memori dan Profil Pengguna, memadankan pemisahan antara fakta dan pilihan yang stabil.
- **Tambahan dan pengalihan keluar berlaku melalui perbualan** — anda tidak perlu "mengisi" memori dengan sengaja. Semasa perbualan biasa Hermes memutuskan perkara yang patut dikekalkan; apabila anda ingin mengingati atau melupakan sesuatu, katakan sahaja dalam sembang.
- **Kapasiti boleh laras** — konsol membolehkan anda menaikkan atau menurunkan had kapasiti memori, menghalang konteks jangka panjang daripada berkembang tanpa terikat.
- **Stabil merentas model** — menukar model tidak mengosongkan ingatan, kemahiran atau tugas yang dijadualkan, jadi kestabilan personaliti tidak bergantung pada model tertentu.
- **Konsisten merentas saluran** — seorang Ejen berkongsi memori dan persona yang sama merentas setiap saluran yang disambungkan; menukar telefon atau saluran tidak akan kehilangannya, dan tiada apa yang memerlukan pendua bagi setiap platform.

---

## Perkara utama

- Personaliti muncul daripada tiga bahagian: `SOUL.md` (peraturan tingkah laku), `USER.md` (gaya interaksi lalai), `MEMORY.md` / `memories/` (latar belakang dikongsi).
- Sebab teras untuk memisahkannya ialah **kekerapan perubahan yang berbeza**: peraturan kekal diam selama berbulan-bulan, ingatan berkembang hampir setiap hari.
- Personas menyatakan prinsip dan bukannya fakta, mengekalkan had yang cukup konkrit untuk menilai, dan mengisytiharkan keutamaan untuk peraturan yang bercanggah.
- Ujian untuk `USER.md` keahlian: **adakah ia masih benar dalam masa tiga bulan?**
- Jangan simpan peraturan tingkah laku sebagai entri ingatan, atau ia akan gagal seketika melalui kesilapan mengingat semula atau hilang.
- Peralihan nada selepas menukar model mencerminkan pematuhan yang berbeza, bukan kehilangan personaliti atau ingatan.


