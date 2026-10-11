

## Ringkasan

**`USER.md` dan `MEMORY.md` ialah dua buku nota peribadi di belakang Hermes ingatan jangka panjang ejen, dan tiga kekangan keras menjelaskan mengapa ia tidak boleh digabungkan. Pertama, kapasiti adalah bebas (`USER.md` ialah kira-kira 1,375 aksara / 500 token; `MEMORY.md` ialah kira-kira 2,200 aksara / 800 token), jadi kedua-duanya tidak memerah yang lain. Kedua, memuatkan semantik berbeza: kedua-duanya memuatkan pada setiap sesi, tetapi peranannya berbeza sama sekali — satu secara stabil menerangkan "siapa anda", yang satu lagi kerap merekodkan "apa yang telah kami lakukan". Ketiga, kemas kini semantik berbeza: medan keutamaan dalam `USER.md` kebanyakannya menulis ganti nilai lama, manakala `MEMORY.md` kebanyakannya ditambah dan disatukan atas permintaan. Menggabungkannya menjadi satu `NOTES.md` akan memecahkan ketiga-tiga kekangan sekaligus — kes buku teks "kelihatan lebih mudah, berfungsi lebih teruk".**

---

## Soalan yang adil untuk dimulakan

Merentasi Hermes' memori berlapis, `USER.md` dan `MEMORY.md` menambah hanya **~3,575 aksara / ~1,300 token** — sangat terkawal dalam era tetingkap konteks enam angka.

Jadi reaksi pertama kebanyakan orang ialah tiga soalan:

- Mengapa tidak menggabungkannya menjadi satu `NOTES.md`?
- Mengapa tidak skala sehingga puluhan kilobait?
- Mengapakah kedua-dua fail mempunyai siling yang berbeza (2,200 vs 1,375)?

Ketiga-tiga menunjuk kepada jawapan yang sama: **`USER.md` dan `MEMORY.md` ialah dua jenis memori yang berbeza, dan pembungkusan mereka bersama-sama menjadikan kedua-duanya lebih teruk.** Di bawah, prinsip reka bentuk itu dibongkar dalam tiga lapisan.

---

## 1. `USER.md`: profil pengguna yang stabil dan berstruktur

`USER.md` ialah **keterangan yang stabil tentang anda**:

- Identiti: nama, peranan, lokasi.
- Keutamaan: gaya komunikasi, susunan teknologi biasa.
- Kekangan: jadual, bahasa, topik yang perlu dielakkan.
- Gaya kerja: kesimpulan dahulu, atau proses dahulu.
- Matlamat jangka panjang: apa yang anda sedang usahakan.

**Ciri-ciri utama**nya:

- **Stabil**: dikemas kini sekali setiap beberapa hari atau minggu.
- **Berstruktur**: terbahagi, diperincikan, berdasarkan medan.
- **Sentiasa dimuatkan**: disuntik ke dalam gesaan sistem pada permulaan setiap sesi.
- **Siling keras**: ~1,375 aksara / ~500 token.

Anggap `USER.md` sebagai **nota melekit pada bezel monitor ejen** — tidak banyak padanya, tetapi sentiasa kelihatan dan sentiasa berguna.

---

## 2. `MEMORY.md`: arkib fakta atas permintaan yang semakin berkembang

`MEMORY.md` menyimpan **apa yang anda dan ejen telah lakukan bersama**:

- Keadaan projek: bahagian hadapan ejen-demo berjalan pada port pembangun tempatan.
- Keputusan: minggu lepas bahagian wira telah ditukar kepada kecerunan animasi.
- Acara khusus: bersetuju dengan pasukan A bahawa X dihantar pada Q4.
- Pengetahuan khusus: API ini mengesahkan melalui SDK dalaman dan bukannya titik akhir awam.

**Ciri-ciri utama**nya:

- **Dinamik**: hampir setiap sesi substantif menulis satu atau dua entri.
- **Beritem**: menambahkan entri demi entri untuk memudahkan ingatan.
- **Sentiasa dimuatkan serta padanan FTS5 atas permintaan**: entri biasa dimuatkan setiap sesi, entri sejarah ditarik masuk oleh perlawanan FTS5.
- **Biasanya 8–15 entri**: sasaran 8–15 entri berjumlah ~2,200 aksara / ~800 token.

Fikirkan `MEMORY.md` sebagai **jurnal di atas meja anda** — lebih daripada nota melekit, tetapi masih ditulis dengan jarang supaya ia kekal pantas untuk meluncur.

---

## 3. "Mengapa tidak menggabungkannya menjadi satu NOTES.md?" - tiga kekangan keras

Seseorang akan sentiasa bertanya: kedua-duanya Markdown dimuatkan pada setiap sesi, jadi mengapa tidak menggabungkannya?

Berikut ialah tiga kekangan yang sukar, masing-masing cukup kuat untuk menenggelamkan idea.

### Kekangan 1: kapasiti bebas, tiada saling memerah

`USER.md` mendapat 500 token, `MEMORY.md` mendapat 800. Selepas bergabung, satu 1,300-token `NOTES.md` serta-merta menghadapi masalah: **apabila memori hampir penuh, adakah ejen memadamkan baris tentang "siapa pengguna" untuk merekodkan satu lagi peristiwa?**

Jelas sekali ia **tidak sepatutnya** — tetapi setelah digabungkan, keputusan itu perlu dibuat dan dibuat **pada setiap penulisan**. Diasingkan, kedua-dua kolam berkembang secara bebas: apabila `MEMORY.md` terisi ia hanya memerah dirinya sendiri dan tidak sekali-kali mencemarkan profil.

### Kekangan 2: semantik pemuatan yang berbeza

Kedua-dua fail benar-benar **dimuatkan pada setiap sesi**, tetapi peranannya dalam gesaan sistem adalah berbeza sama sekali:

- Bahagian `USER.md` menjawab "**dengan siapa anda berurusan**", menetapkan nada ejen, tahap perincian dan andaian timbunan.
- Bahagian `MEMORY.md` menjawab "**apa yang telah anda lakukan bersama**", memberikan ejen pengendalian fakta.

Jika digabungkan, kedua-duanya akan **mencairkan satu sama lain** — ejen tidak lagi dapat memberitahu dengan cepat "adakah ini gaya komunikasi yang mesti saya ikuti, atau fakta masa lalu yang harus saya nyatakan?"

### Kekangan 3: semantik kemas kini yang berbeza

- **Medan keutamaan dalam `USER.md` kebanyakannya ditulis ganti**: apabila pengguna berkata "berhenti meringkaskan dari sekarang", baris keutamaan yang berkaitan ditimpa terus.
- **`MEMORY.md` kebanyakannya ditambah dan disatukan atas permintaan**: acara ialah siri masa, jadi sejarah tidak boleh dipadamkan begitu sahaja. Apabila kapasiti penuh, tindak balas ralat berikut mencetuskan penyatuan aktif:

```json
{
  "success": false,
  "error": "Memory at 2,100/2,200 chars. Consolidate now...",
  "current_entries": [...],
  "usage": "2,100/2,200"
}
```

Selepas bergabung, `add / replace / remove` semuanya perlu wujud bersama pada fail yang sama, menjadikan kedua-dua pelaksanaan dan model mental pengguna **lebih teruk pada masa yang sama**.

---

## 4. Contoh konkrit

Katakan anda memberitahu ejen:

> "Saya Jasmin, seorang jurutera bahagian hadapan, dan saya suka komunikasi yang mengutamakan kesimpulan. Saya sedang mengusahakan tapak global untuk ejen-demo (apl ejen AI) dengan Next.js. Minggu lepas kami menukar bahagian wira kepada kecerunan animasi."

Hermes Agent yang terlatih membahagikannya seperti berikut:

**Ditulis kepada `USER.md`**:

```md
## Identity
- Name: Jasmin
- Role: Frontend engineer

## Preferences
- Communication style: conclusion first
- Usual stack: Next.js
```

**Ditulis kepada `MEMORY.md`**:

```md
- [2026-07-30] agent-demo: hero section on the global site changed to an animated gradient.
- Related project: agent-demo / global site (global region)
```

Nampak perbezaannya?

- "Anda jenis apa" masuk ke dalam profil; "apa yang kita lakukan bersama" masuk ke dalam arkib.
- Yang pertama hanya berubah apabila **anda** bertukar (pekerjaan baharu, pasukan baharu); yang kedua berkembang dengan **setiap hari perbualan**.
- **Fail berasingan ialah perkara yang membolehkan setiap satu berkembang dengan sendirinya.**

---

## 5. Senarai langkau lima perkara

Hermes tidak menolak segala-galanya ke dalam `USER.md`. Ia menyimpan **senarai langkau**:

1. **Perasaan sekali sahaja**: "kepala saya sakit hari ini" — bukan sifat yang stabil.
2. **Parameter tugas sementara**: "tukar tajuk ini kepada X untuk saya" — boleh guna.
3. **Sikap kabur**: "Saya rasa saya lebih suka perkara yang sedikit lebih ringkas" — tidak cukup boleh digunakan semula (sama ada melayakkannya atau melangkaunya).
4. **Apa-apa sahaja yang boleh disimpulkan daripada konteks perbualan langsung** — tidak perlu berterusan.
5. **Maklumat sensitif** (e-mel, kata laluan, alamat yang tidak disahkan secara jelas oleh pengguna) — kandungan berkaitan privasi tidak ditulis secara lalai.

Senarai langkau itulah yang mengekalkan `USER.md` pada "500 token dan kepadatan tinggi".

---

## 6. Apakah maksud ini untuk produk

Untuk produk ejen, pemisahan antara `USER.md` dan `MEMORY.md` bukan sekadar perincian kejuruteraan. Ia menentukan tiga perkara:

1. **Sama ada anda boleh menunjukkan kepada pengguna "apa yang saya fikir tentang anda"** — yang memerlukan profil yang stabil, boleh dibaca dan boleh diedit (semantik `USER.md`).
2. **Sama ada ejen boleh mengelakkan amnesia dalam jangka masa panjang** — yang memerlukan arkib fakta yang boleh dipanggil semula (semantik `MEMORY.md`).
3. **Sama ada kos kekal terhad** — hanya pemuatan berlapis yang boleh "mengetahui siapa anda" dan mengelak daripada membakar keseluruhan konteks.

---

## 7. LightVela: menukar dua lejar ini menjadi produk

Reka bentuk memori ejen dalaman LightVela meminjam pemikiran berlapis ini. Hermes' `USER.md` dan `MEMORY.md` ialah fail Markdown yang ditulis untuk pembangun; LightVela mengubahnya menjadi dua perkara yang boleh dikendalikan secara langsung oleh pengguna biasa:

- **Lapisan profil yang boleh dilihat**: pengguna boleh melihat fakta profil yang diingati oleh ejen dan perbualan yang mana setiap satu berasal, dan membetulkannya dalam satu klik. Profil bukan lagi kotak hitam `USER.md`.
- **Lapisan fakta yang boleh diatur**: memori fakta adalah lebih daripada timbunan entri — ia boleh ditandakan mengikut projek, tugasan atau masa untuk mengingati dan membersihkan lebih mudah. Dalam senario pasukan, ingatan pasukan dan ingatan peribadi boleh diuruskan sebagai lapisan berasingan.
- **Laluan terpendek**: jika idea memori berlapis menarik minat anda tetapi anda lebih suka tidak mengedit `~/.hermes/USER.md`, mengekalkan FTS5 dan menyandarkan SQLite sendiri, LightVela ialah laluan terpendek ke idea itu sebagai produk siap.

Dalam satu baris: **Hermes menyediakan pelan tindakan kejuruteraan untuk memori berlapis, dan LightVela mengubahnya menjadi pengalaman produk yang boleh digunakan oleh sesiapa sahaja.**

---

## Pengambilan utama

- `USER.md`: **profil pengguna** yang stabil dan berstruktur dimuatkan setiap sesi (~500 token, 8–15 medan profil).
- `MEMORY.md`: **arkib fakta** atas permintaan yang semakin berkembang (~800 token, 8–15 penyertaan acara).
- Tiga kekangan keras memisahkan mereka: **kapasiti bebas / semantik pemuatan berbeza / semantik kemas kini berbeza.**
- Lapisan ialah keupayaan asas untuk ingatan ejen yang baik, dan titik permulaan untuk menghasilkan ingatan pada LightVela.
