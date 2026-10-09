

## Ringkasan

**Memori dan Kemahiran adalah kedua-dua ingatan jangka panjang, tetapi pada asasnya ia berbeza. Memori ialah ingatan deklaratif: ia menyimpan fakta, peristiwa, kesimpulan dan keutamaan sebagai entri pendek, dan dipanggil semula apabila pertanyaan sepadan (`MEMORY.md` + `memories/`). Kemahiran ialah ingatan prosedur: ia menyimpan SOP untuk "apa yang perlu dilakukan apabila situasi X berlaku" sebagai YAML galas pencetus ditambah prosedur, dan dimuatkan dengan keutamaan tinggi apabila senario sepadan (direktori `skills/` + `SKILL.md`). Tiga kekangan keras memisahkannya: pencetus berbeza (padanan pertanyaan lwn padanan senario), bentuk berbeza (entri lwn prosedur langkah demi langkah) dan kadar perubahan berbeza (Memori berubah setiap hari, Kemahiran boleh duduk diam selama berbulan-bulan). Ejen yang berjalan dengan kedua-dua belah kaki memahami anda dan tahu cara bekerja.**

---

## Mengapa kedua-dua konsep ini terus keliru

Jika Hermes Agent mempunyai satu reka bentuk yang sangat mudah disalah baca, ia adalah pemisahan bersih **Memori** dan **Kemahiran**.

Reaksi pertama kebanyakan orang ialah tiga soalan:

- **"Bukankah mereka berdua ingatan jangka panjang? Mengapa berpecah?"**
- **"Kedua-duanya Markdown, jadi mengapa tidak disatukan?"**
- **"Mengingati 'bahagian hadapan ejen-demo berjalan pada port pembangun setempat' dan mengingati 'ringkaskan dahulu, kemudian senaraikan perubahan semasa menulis penerangan PR' — bukankah itu perkara yang sama?"**

Jawapan ringkas: **kerana otak manusia juga membelah mereka.**

---

## 1. Sains kognitif sudah membuat perbezaan ini: deklaratif vs prosedural

Psikologi telah lama membezakan dua jenis ingatan jangka panjang:

| Taip | Definisi | Contoh | Bagaimana ia dipanggil |
|---|---|---|---|
| **Deklaratif** | Fakta yang anda boleh nyatakan | "Saya tinggal di Beijing", "React 18 memperkenalkan pemaparan serentak" | Dengan **dinyatakan** |
| **Prosedur** | Kemahiran yang anda boleh lakukan tetapi mungkin tidak dapat menjelaskan | Menunggang basikal, menaip sentuh, menulis penerangan PR yang tersusun dengan baik | Dengan **dilaksanakan** |

Kedua-dua jenis ingatan ini berbeza dalam **cara ia disimpan, digunakan dan dikemas kini**: ingatan deklaratif boleh diucapkan secara lisan (saluran lisan), manakala ingatan prosedur kebanyakannya dilakukan (saluran motor). Dalam eksperimen psikologi, pesakit yang mengalami kerosakan hippocampal telah mengalami gangguan ingatan deklaratif yang teruk namun masih boleh mempelajari tugas prosedur seperti menulis cermin — **dua laluan bebas, bukan dua ekspresi satu laluan.**

Hermes Pelabuhan ejen yang membezakannya terus ke dalam reka bentuk sistemnya:

- **Memori (`memories/`, `MEMORY.md`)**: ingatan deklaratif ejen.
- **Kemahiran (`skills/`)**: ingatan prosedur ejen.

---

## 2. Ingatan: apa yang ejen boleh nyatakan

Sistem memori menyimpan **fakta, peristiwa, kesimpulan dan keutamaan**:

- "Jasmin sedang mengusahakan tapak global untuk ejen-demo."
- "Minggu lepas bahagian wira telah ditukar kepada kecerunan animasi."
- "Projek berjalan pada Next.js, dengan pelayan pembangun bahagian hadapan pada port pembangun setempat."

Ciri-cirinya:

- **Deklaratif**: wujud sebagai ayat pendek dan entri yang boleh dipetik terus ke dalam gesaan.
- **Dipaling semula atas permintaan**: apabila topik berkaitan muncul, padanan FTS5 menarik masukan yang berkaitan.
- **Meruap**: entri baharu dilampirkan, entri lama ialah `replace`d atau `remove`d.

**Fikirkan Memori sebagai buku nota ejen** — satu terbuka di atas meja, penuh dengan fakta khusus.

---

## 3. Kemahiran: apa yang ejen boleh lakukan

A Skill menyimpan **prosedur standard untuk kelas tugas**. Kemahiran Hermes tipikal ialah `SKILL.md` yang bahagian hadapan YAMLnya mengisytiharkan keadaan pencetus dan set alat yang disandarkan:

```yaml
---
name: pr-description-format
trigger:
  when: "user asks to write a PR description"
fallback_for_toolsets: [git, code-review]
---

# Standard procedure for writing a PR description

1. Summarize the goal of the change in one sentence
2. List the changes (grouped by module)
3. Blast radius
4. Testing status
5. Related issue / rollback plan
```

Ciri-cirinya:

- **Prosedur**: wujud sebagai "bila untuk mencetuskan + cara melakukannya", berhampiran dengan SOP boleh guna semula.
- **Dicetuskan oleh senario**: apabila ejen mengenali situasi yang sepadan, Kemahiran **dimuatkan secara automatik sebagai gesaan keutamaan tinggi** yang membimbing tindakan itu.
- **Relatif stabil**: sebaik sahaja Kemahiran selesai, ia biasanya kekal; apa yang berubah ialah senario dan bahan dalam Memori yang mengikatnya.

**Fikirkan Skill sebagai ingatan otot ejen** — tiada ingatan diperlukan, gerakan itu berlaku begitu sahaja.

Hermes pengguna juga boleh menjalankan `/learn` untuk meminta ejen menyaring "bahagian sesi ini yang patut dikodkan" menjadi `SKILL.md` baharu — sama seperti mentor yang menyampaikan kaedah kepada perantis.

---

## 4. "Mengapa tidak menggabungkan mereka?" - tiga kekangan keras

Seseorang akan bertanya: mereka berdua Markdown, kedua-duanya ingatan jangka panjang, jadi mengapa tidak meletakkannya bersama-sama?

Kerana ia tidak berfungsi. Sebabnya menyerupai tiga kekangan yang memisahkan `USER.md` dan `MEMORY.md`, tetapi ia lebih kuat di sini.

### Kekangan 1: pencetus berbeza

- Memori "**dipaling semula apabila pertanyaan sepadan**" (FTS5 ditambah ringkasan semantik).
- Kemahiran "**dimuatkan apabila senario sepadan**", biasanya dengan pencetus eksplisit (`trigger.when: "user asks to write a PR description"`).

Jika digabungkan, ejen akan kehilangan jejak sama ada ia memetik fakta atau mengikut prosedur.

### Kekangan 2: bentuk yang berbeza

- Memori ialah **ayat pendek, fakta, entri** ("[2026-07-30] ejen-demo frontend local dev port").
- Kemahiran ialah **prosedur, templat, kekangan**, biasanya dengan YAML frontmatter ditambah pesanan "step 1 / 2 / 3".

Dikemas bersama-sama, ejen tidak dapat memberitahu "adakah latar belakang ini, atau sesuatu yang harus saya laksanakan sekarang?"

### Kekangan 3: kadar perubahan yang berbeza

- **Memori berubah setiap hari** (satu sesi boleh menambah satu atau dua entri).
- **Sesuatu Kemahiran boleh tidak berubah selama berbulan-bulan** (SOP untuk perihalan PR tidak memerlukan pengeditan selama setengah tahun).

Menggabungkannya membolehkan entri fakta frekuensi tinggi menghapuskan SOP yang stabil — seperti mengikat perlembagaan dan kalendar meja ke dalam buku nota yang sama.

---

## 5. Senario sebenar: `/learn` dan Memori bekerjasama

Katakan anda memberitahu ejen:

> "Mulai sekarang pasukan kami menulis penerangan PR dalam format ini: ringkasan satu ayat, senarai perubahan, jejari letupan, status ujian. Selain itu, ingat bahawa projek ini dipanggil ejen-demo dan bahagian hadapan berjalan pada port pembangun setempat."

Hermes Agent yang terlatih mengendalikannya seperti berikut:

- **Separuh masa pertama** → laluan `/learn`, menulis **Kemahiran** baharu: `pr-description-format.md`, dicetuskan oleh `user asks to write a PR description`.
- **Separuh masa kedua** → operasi atom `add`, menulis satu entri **Memori**: `- [2026-07-30] agent-demo: frontend dev server on a local dev port`.

Lain kali anda berkata "tulis saya penerangan PR", ejen akan:

1. **Padankan senario dan muatkan Kemahiran**: `pr-description-format.md` memasuki gesaan keutamaan tinggi.
2. **Padankan Memori mengikut pertanyaan**: ia mengetahui projek semasa ialah ejen-demo, berjalan pada port pembangun setempat.
3. **Gabungkan kedua-duanya**: menghasilkan penerangan PR yang mengikut piawaian pasukan dan sesuai dengan projek tertentu.

**Mengingat fakta serta mengingati prosedur adalah yang menjadikan keputusan lebih baik daripada jumlah bahagiannya.**

---

## 6. Himpunan Kemahiran dan fallback_for_toolsets

Hermes menambah dua lapisan organisasi di atas Kemahiran:

- **Himpunan Kemahiran**: Kemahiran berkaitan dibungkus sebagai satu kumpulan. Himpunan "saluran paip keluaran" mungkin mengandungi `pre-release-checklist`, `changelog-format` dan `deploy-rollback`, didayakan, dilumpuhkan atau dikongsi sebagai satu unit.
- **`fallback_for_toolsets`**: Kemahiran boleh mengisytiharkan bahawa ia menyandarkan set alat apabila set alat itu gagal. Contohnya, apabila set alat `git` ralat keluar, Kemahiran dengan langkah pemulihan pangkalan semula manual akan menyala.

Bersama-sama ini menjadikan Kemahiran daripada SOP satu titik kepada **metodologi kerja boleh dikompilasi** — keseluruhan cara kerja yang dibawa oleh pengguna kepada ejen, ditangkap sebagai aset boleh kongsi.

---

## 7. Bukan idea baru, tetapi jarang dilaksanakan dengan baik

Melapisi ingatan fakta dan prosedural telah dibincangkan dalam kalangan AI untuk masa yang lama. Sebenarnya merekayasanya, dan menjadikannya **kelihatan, boleh diedit dan boleh digunakan semula oleh pengguna**, adalah tempat Hermes agak jauh di hadapan — ia memetakan setiap lapisan ke direktori konkrit, medan dan arahan:

| Keupayaan | Bahagian ingatan | Bahagian kemahiran |
|---|---|---|
| Direktori utama | `~/.hermes/memories/` | `~/.hermes/skills/` |
| Kemasukan lapisan gesaan | `MEMORY.md`, `USER.md` | `SKILL.md` dimuatkan pada perlawanan senario |
| Tangkap arahan | `add / replace / remove` (didorong ejen tambah `/memory pending` kelulusan) | `/learn` (didorong ejen tambah `/skills pending` kelulusan) |
| Organisasi | Entri ditambah indeks teks penuh FTS5 | Satu SOP ditambah Bundle dan `fallback_for_toolsets` |
| Kadar perubahan | Harian | Bulan |

Bawa lapisan itu ke dalam konteks produk dan anda mendapat bentuk dengan potensi sebenar:

- **Memori ialah arkib kongsi antara anda dan ejen.**
- **Kemahiran ialah metodologi kerja yang anda bawa kepada ejen.**

Bersama-sama, kedua-duanya menjadikan ejen sebagai rakan kongsi yang **memahami anda dan tahu cara bekerja** — bukan chatbot dengan ingatan yang baik.

---

## 8. LightVela: menukar Memori dan Kemahiran menjadi aset pengguna

Hermes telah menjadikan pembahagian Memori / Kemahiran boleh digunakan dalam istilah kejuruteraan, tetapi ia masih **Markdown untuk pembangun**. Pendekatan LightVela adalah untuk meningkatkan lapisan itu daripada ciri teknikal kepada **aset pengguna**:

- **Pustaka Kemahiran peribadi**: pengguna boleh mengumpul, mengedit dan berkongsi Kemahiran (aliran kerja) mereka sendiri cara mereka mengumpul gesaan dan mengikatnya untuk mencetuskan senario. Corak penulisan anda, semakan SOP dan piawaian terjemahan semuanya boleh menjadi Kemahiran.
- **Pustaka Memori peribadi**: setiap ingatan fakta yang dipegang ejen tentang anda adalah telus, boleh dilihat, boleh diperbetulkan dan boleh dipadam — tidak perlu mengedit `~/.hermes/MEMORY.md`.
- **Penggunaan semula peringkat pasukan**: kedua-dua Kemahiran dan Memori boleh ditangkap pada skop pasukan, jadi penggabung baharu secara automatik mewarisi ingatan bersama dan kaedah kongsi pasukan dan bukannya bergantung pada mulut ke mulut.
- **Laluan terpendek**: jika model "dua kaki" menarik minat anda tetapi anda lebih suka tidak berurusan dengan sandaran Ollama, SSH, systemd dan `~/.hermes/`, LightVela ialah laluan terpendek ke model itu sebagai produk siap.

Dalam erti kata lain, melatih ejen tentang LightVela bermakna **mengumpul dua aset serentak**: Memori tentang anda dan koleksi Kemahiran anda. **Kedua-dua aset tersebut adalah milik anda untuk jangka masa panjang — ia lebih penting daripada model itu sendiri.**

---

## Pengambilan utama

- Memori ≠ Kemahiran. Yang pertama ialah **ingatan deklaratif** (fakta yang boleh dinyatakan), yang kedua ialah **ingatan prosedur** (kaedah yang dapat dilaksanakan).
- Tiga kekangan keras memisahkannya: **cetusan yang berbeza / bentuk yang berbeza / kadar perubahan yang berbeza.**
- Seorang ejen yang matang perlu berjalan dengan kedua-dua belah kaki — mengingati fakta dan kaedah mengingati.
- LightVela menukar kedua-duanya menjadi aset pengguna, jadi "melatih ejen anda sendiri" menjadi pengalaman produk yang boleh anda bina dan bukannya slogan.

---

## Di mana ini meninggalkan kita

Merentasi kategori ini, lima artikel merangkumi asas:

1. Bagaimana Hermes Agent berbeza daripada OpenClaw (**pengumpulan vs sambungan**)
2. Bagaimana Hermes Agent mengingati anda (**empat lapisan memori berstruktur**)
3. Mengapa Hermes Agent membahagikan memori kepada dua (**`USER.md` vs `MEMORY.md`**)
4. Mengapa lebih banyak ingatan tidak lebih baik: bagaimana Hermes Agent menapis, mengatur dan mengemas kini ingatan jangka panjang (**empat peraturan besi**)
5. Ingatan bukan Kemahiran: bagaimana memori fakta dan prosedur berbeza (**berjalan dengan kedua-dua belah kaki**)

**Satu baris untuk ditutup**: parit untuk generasi ejen seterusnya bukanlah saiz model, tetapi sama ada ejen itu benar-benar **mengenai anda** (Memori) dan **mempunyai kaedah** (Kemahiran) — dan sama ada kedua-dua ejen tersebut boleh berjalan dengan pasti dalam jangka panjang bergantung kepada sama ada ia **kekal hidup**. Itulah sebabnya LightVela wujud.
