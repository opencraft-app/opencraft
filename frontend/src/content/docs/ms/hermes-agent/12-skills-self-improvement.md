## Ringkasan

**Ejen menjadi lebih baik dengan penggunaan bukan kerana ia secara misteri menaik taraf dirinya di latar belakang, tetapi kerana dua jenis perkara dikekalkan dalam cara berstruktur: fakta stabil menjadi Memori, dan kaedah boleh guna semula ditangkap sebagai Kemahiran, kemudian dimuat semula apabila situasi sepadan. Memori memberitahunya apa yang berlaku — dipanggil semula apabila pertanyaan sepadan. Kemahiran memberitahunya apa yang perlu dilakukan pada masa akan datang — dimuatkan apabila situasi sepadan. Pencetus, bentuk dan kadar perubahan semuanya berbeza, itulah sebabnya ia tidak boleh digabungkan. Hermes menyediakan `/learn` supaya Ejen boleh menyaring prosedur yang terbukti daripada sesi semasa kepada `SKILL.md`, dengan `/skills pending` untuk semakan, jadi pembaikan diri tidak pernah menjadi pengubahsuaian diri tanpa had. Kemahiran yang baik mesti menyatakan empat perkara: bila untuk menggunakannya, langkah yang mana yang perlu diikuti, rupa kejayaan dan sempadan mana yang tidak boleh dilalui. Perkara yang penting bukanlah jumlah yang anda tangkap, tetapi ia kekal boleh disemak, boleh digunakan semula dan boleh dikemas kini apabila produk berubah.**

---

## Pengalaman yang tidak boleh digunakan semula hanyalah perbualan

Fikirkan kembali sesi yang berjalan dengan lancar. Anda dan Ejen anda menyahpepijat masalah bersama-sama, atau menghasilkan set nota keluaran yang benar-benar bagus. Sepanjang perjalanan anda membetulkannya tiga atau empat kali: sempitkan skop, pastikan format konsisten, jangan sekali-kali melangkau satu semakan itu. Hasilnya memang mantap.

Seminggu kemudian, tugas yang sama tiba. Jika pembetulan tersebut hanya terdapat dalam log sembang minggu lepas, anda akan mendapati diri anda mengatakan perkara yang sama sekali lagi — **penalaan tidak pernah menjadi aset, hanya perbelanjaan sekali sahaja.**

Itulah persoalan sebenar di sebalik "menjadi lebih baik dengan penggunaan." Ia bukan tentang Ejen menjadi lebih bijak secara misteri. Ia mengenai **apa yang telah terbukti dikekalkan dalam bentuk berstruktur.** Perkara yang anda simpan, cara anda menyimpannya, dan tempat tinggalnya menentukan sama ada pengumpulan adalah nyata atau sama ada setiap sesi dimulakan semula.

---

## 1. Dua jenis pengumpulan, tidak boleh digabungkan

Seorang Ejen mengumpul dua perkara yang pada asasnya berbeza.

| Pengumpulan | Apa yang disimpannya | Bagaimana ia digunakan | Kadar perubahan |
|---|---|---|---|
| **Memori** | Fakta, keutamaan, kesimpulan, sejarah | Dipanggil semula apabila berkaitan dengan soalan semasa | Tinggi; entri boleh ditambah kebanyakan sesi |
| **Kemahiran** | Situasi, langkah, sempadan, semakan | Dimuatkan dan dilaksanakan apabila situasi sepadan | Rendah; mungkin tidak berubah selama berbulan-bulan |

Sepasang contoh yang dipadankan:

- "Pengguna ini lebih suka kesimpulan dahulu" → **Memori**. Ia adalah fakta tentang anda.
- "Sebelum menulis nota keluaran, sahkan nombor versi dan setiap pautan selesai" → **Kemahiran**. Ia adalah prosedur untuk dijalankan setiap kali tugas seperti itu muncul.

Ia tidak boleh digabungkan, atas sekurang-kurangnya tiga sebab: **cetusan berbeza** (padanan pertanyaan lwn padanan situasi), **borang berbeza** (entri pendek lwn langkah tersusun) dan **kadar perubahan berbeza** (harian lwn bulanan). Mencampurkan prosedur yang stabil ke dalam senarai fakta yang berpusing tinggi membersihkan bahagian yang stabil. Untuk hujah penuh, lihat "Memori Bukan Kemahiran: Bagaimana Hermes Agent Memisahkan Ingatan Fakta dan Prosedur."

Perbezaan ini mempunyai hasil praktikal serta-merta: **apabila anda mendapati diri anda membetulkan jenis tingkah laku yang sama berulang kali, apa yang anda perlukan ialah Kemahiran, bukan fakta lain dalam ingatan.**

---

## 2. Apakah rupa Kemahiran

Dalam Hermes Kemahiran lazimnya ialah `SKILL.md` dengan frontmatter YAML mengisytiharkan pencetus dan butiran sokongannya. Secara kasar:

```yaml
---
name: release-note-format
trigger:
  when: "user asks to write release notes"
---

# Standard procedure for release notes

1. Confirm the version number and release date
2. Group entries as Added / Fixed / Changed
3. Verify every external link resolves
4. Check for internal project names or ports; replace with placeholders
5. Confirm length fits the publishing channel's limits
```

`trigger` ialah perkara yang penting: ini bermakna anda tidak menggunakan Kemahiran secara manual. Apabila situasi sepadan dikenali, Kemahiran dimuatkan secara automatik sebagai panduan arahan keutamaan tinggi yang dijalankan.

Hermes menambah dua lapisan organisasi:

- **Skill Bundle** — Pakej berkaitan Kemahiran untuk mendayakan, melumpuhkan atau berkongsi sebagai kumpulan. Himpunan "saluran paip keluaran" mungkin mengandungi semakan prakeluaran, format log perubahan dan langkah gulung semula.
- **`fallback_for_toolsets`** — Kemahiran boleh mengisytiharkan dirinya sebagai sandaran apabila panggilan set alat gagal, jadi laluan kegagalan juga mempunyai prosedur yang ditetapkan.

Bersama-sama ini menjadikan Kemahiran daripada SOP terpencil menjadi metodologi kerja yang boleh digubah.

---

## 3. `/learn`: menjadikan satu larian yang berjaya menjadi kaedah

Menangkap Kemahiran tidak memerlukan meninggalkan perbualan untuk menulis fail. Hermes menyediakan `/learn`, yang membolehkan Ejen menyaring prosedur yang patut disimpan daripada sesi semasa kepada `SKILL.md` baharu.

Nilai reka bentuk ini ialah **penangkapan berlaku semasa ingatan paling segar**. Sejurus selepas kerjasama yang berjaya, anda dan Ejen mengetahui langkah mana yang penting dan pembetulan mana yang penting. Tuliskannya seminggu kemudian dan butirannya sudah hilang.

Tetapi penyulingan automatik menimbulkan masalah yang mesti ditangani: **jika Ejen boleh menambah peraturan tingkah laku pada dirinya sendiri sesuka hati, tingkah lakunya menjadi tidak dapat diramalkan.** Hermes mengendalikan perkara ini dengan langkah semakan — periksa Kemahiran yang belum selesai melalui `/skills pending` dan tentukan sama ada untuk menerima pakainya. Ini mencerminkan `/memory pending` pada bahagian memori.

**Pembaikan diri bukanlah pengubahsuaian diri tanpa had.** Jalan yang boleh dipercayai ialah kaedah baharu mula-mula menjadi **peraturan boleh disemak**, berkuat kuasa hanya selepas pengesahan. Itulah yang menjadikan pertumbuhan keupayaan boleh dijelaskan, boleh digunakan semula dan boleh dibetulkan.

---

## 4. Empat perkara yang mesti dinyatakan oleh Kemahiran yang baik

Inilah yang membezakan Kemahiran yang berguna daripada yang berbahaya. Abaikan mana-mana daripada empat dan Kemahiran akan tersasar dalam latihan.

**Pertama, masa untuk menggunakannya.** Situasi pencetus mestilah khusus. "Apabila mengendalikan dokumen" terlalu luas dan akan dimuatkan dalam konteks yang bukan miliknya; "apabila pengguna meminta nota keluaran" adalah cukup khusus. Kemahiran yang terlalu luas adalah lebih teruk daripada tiada Kemahiran, kerana ia mengganggu tugas yang tidak berkaitan.

**Kedua, langkah mana yang perlu diikuti.** Langkah mesti dipesan dan boleh dilaksanakan. "Beri perhatian kepada kualiti" bukanlah satu langkah; "sahkan setiap pautan luaran diselesaikan" adalah. Ujian: bolehkah orang lain mengikuti Kemahiran ini dan menghasilkan keputusan yang konsisten secara meluas?

**Ketiga, rupa kejayaan.** Tanpa kriteria kejayaan, Ejen tidak boleh menyemak sendiri dan anda tidak boleh menilai sama ada larian boleh diterima. Jadikan ia boleh disahkan, contohnya "semua tiga kumpulan hadir, setiap satu dengan sekurang-kurangnya satu entri atau nota eksplisit bahawa kumpulan itu kosong."

**Keempat, sempadan mana yang tidak boleh dilalui.** Nyatakan larangan secara eksplisit, seperti "tiada nama projek dalaman sebenar atau port dalam contoh." Sempadan adalah bahagian yang paling kerap ditinggalkan dalam Kemahiran dan sumber insiden yang paling biasa.

Kemahiran dengan keempat-empatnya berkongsi satu sifat: **mereka membaca dengan baik kepada manusia dan kepada Ejen.** Kerana anda boleh memahami apa yang dilakukannya, anda boleh membetulkannya dengan tepat apabila ia salah — yang merupakan prasyarat untuk boleh dibetulkan sama sekali.

---

## 5. Tiga peringkat yang membuat pengumpulan membuahkan hasil

Tangkapan bukan satu tindakan; ia adalah satu proses yang teratur. Melangkau peringkat merendahkan kualiti.

**Tahap satu: buktikan prosedur dalam kerja sebenar terlebih dahulu.** Jangan tulis Kemahiran daripada imaginasi. Prosedur yang tidak pernah bertentangan dengan tugas sebenar hanya akan mengukuhkan kesilapan apabila ditangkap. Lakukan sekali, dan perhatikan pembetulan di sepanjang jalan.

**Peringkat dua: tangkap langkah yang stabil dan boleh diguna semula.** Perhatikan kedua-dua kelayakan — **stabil** (ia tidak akan berubah minggu depan) dan **boleh guna semula** (ia terpakai di luar satu kes tepi ini). Prosedur sekali sahaja tidak berbaloi untuk ditangkap; penyelenggaraan akan menelan kos lebih daripada yang dipulangkan.

**Peringkat tiga: kemas kini Kemahiran apabila produk, alatan atau dasar berubah.** Ini ialah peringkat yang paling kerap dilangkau. Kemahiran yang ditulis enam bulan lalu yang merujuk kepada titik masuk yang dipindahkan atau had yang telah dilaraskan akan terus mengeluarkan panduan yang sudah lapuk. **Menggunakan semula pengalaman lapuk selama-lamanya adalah lebih berbahaya daripada tidak mempunyai pengalaman**, kerana ia membawa kredibiliti telah "terbukti".

Tabiat penyelenggaraan praktikal: apabila anda mendapati diri anda berulang kali membetulkan output Kemahiran dengan tangan, ia telah tamat tempoh. Kemas kini dan bukannya menyelesaikannya.

---

## 6. Perangkap biasa

| Perangkap | Masalahnya | Lakukan ini sebaliknya |
|---|---|---|
| Menyimpan peraturan tingkah laku sebagai entri Memori | Mungkin tidak dipanggil semula apabila pertanyaan terlepas, dan hilang oleh entri kemudian | Peraturan kepada `SOUL.md`, prosedur kepada Kemahiran |
| Menulis pencetus luas "untuk menutup lebih banyak" | Dimuat semasa tugas yang tidak berkaitan dan mengganggu | Sempit kepada situasi tertentu |
| Langkah tanpa sempadan | Langkah berjalan dengan betul tetapi mungkin membocorkan butiran dalaman atau melebihi had | Tambah larangan yang jelas |
| Menangkap banyak Kemahiran tetapi tidak pernah mencantas | Kemahiran Tamat Tempoh terus mengeluarkan panduan yang salah | Semakan secara berkala; kemas kini tentang perubahan |
| Menjangkakan peningkatan autonomi tanpa semakan | Tingkah laku menjadi tidak dapat diramalkan dan sukar untuk didiagnosis | Mengamalkan melalui `/skills pending` |
| Menangkap prosedur sekali sahaja | Kos penyelenggaraan melebihi manfaat | Tangkap hanya prosedur yang stabil dan boleh diguna semula |

Baris empat patut diberi penekanan: **nilai pustaka Skill tidak berkadar dengan saiznya.** Satu Skill yang tamat tempoh boleh menelan belanja lebih daripada sepuluh yang baik untuk dipulangkan, kerana ia dimuatkan secara automatik dan kelihatan boleh dipercayai.

---

## 7. Pendekatan LightVela: kaedah sebagai aset pengguna juga

Hermes telah menjadikan Memory / Skill split engineering-ready, tetapi ia masih menyasarkan orang yang mengedit Markdown secara langsung. LightVela menjalankan model yang dihoskan awan dan tidak mendedahkan operasi sistem fail yang dihadapi pengguna, jadi kedua-dua jenis pengumpulan berfungsi seperti ini:

- **Kemahiran datang dari pasaran awam** — setiap kemahiran berasal dari Skills.sh dan ClawHub, pasaran kemahiran yang dikongsi oleh OpenClaw dan Hermes, jadi anda tidak menulisnya dari awal. 
- **Pasang dan urus Kemahiran di konsol** — semak Kemahiran atau Pakej Kemahiran dari Skills.sh dan ClawHub, pasangkannya, dan periksa tab Dipasang. Pemasangan berasaskan perbualan masih merupakan pilihan lain; sahkan hasil sebelum digunakan. 
- **Memori boleh dilihat di konsol** — halaman memori menunjukkan apa yang telah disimpan oleh Ejen dan membolehkan anda menyesuaikan had kapasiti; penambahan dan penghapusan berlaku melalui perbualan. 
- **Stabil merentas model dan saluran** — menukar model tidak akan menghapus kemahiran atau tugas yang dijadualkan, dan setiap saluran yang disambungkan berkongsi kemahiran dan memori yang sama. 
- **Kegagalan boleh dijejak** — apabila kemahiran berkelakuan tidak baik, lihat dan eksport log terkini dalam Diagnostik (boleh dipilih 1, 3, 6, 12, atau 24 jam) untuk mengesan masalah.

Dalam erti kata lain, menggunakan Ejen pada LightVela bermakna mengumpul dua perkara: Memori tentang anda dan satu set Kemahiran yang telah dipasang dan disahkan. **Kedua-duanya melayani anda lebih lama daripada model tertentu.**

---

## Perkara utama

- Menjadi lebih baik dengan penggunaan datang daripada pengumpulan berstruktur, bukan peningkatan diri secara misteri.
- Dua jenis mesti kekal berbeza: **Memori** menyimpan fakta (dipanggil semula pada padanan pertanyaan), **Kemahiran** kaedah stor (dimuatkan pada padanan situasi).
- Apabila anda terus membetulkan tingkah laku yang sama, tangkap Kemahiran daripada menambah fakta lain.
- `/learn` menangkap kaedah semasa butiran masih segar; `/skills pending` menyediakan ulasan, jadi **pembaikan diri bukanlah pengubahsuaian diri tanpa had**.
- Kemahiran bunyi menyatakan empat perkara: **bila menggunakannya, langkah-langkah, kriteria kejayaan dan sempadan**.
- Tangkapan dijalankan dalam tiga peringkat: buktikan dalam kerja sebenar → tangkap langkah boleh guna semula yang stabil → kemas kini tentang perubahan. **Skil yang tamat tempoh adalah lebih berbahaya daripada tiada.**


