

## Ringkasan

**Hermes Penyusunan ingatan jangka panjang ejen bukanlah tentang menyimpan lebih banyak; ia mengikut empat peraturan besi yang mengekalkan ingatan "sedikit tetapi tepat":**

1. **Terhad**: `USER.md` pada ~1,375 aksara dan `MEMORY.md` pada ~2,200 aksara memaksa keringkasan.
2. **Beku**: tiada penulisan semula dalam sesi, melindungi cache KV dan kestabilan inferens.
3. **Telus**: setiap tulisan diumumkan (`💾 Memory updated`), dan boleh diluluskan, dikembalikan dan disemak dengan `/journey`.
4. **Menyatukan diri**: apabila kapasiti penuh tiada apa-apa yang digugurkan secara senyap; tindak balas `Memory at 2,100/2,200 chars. Consolidate now...` memaksa ejen untuk melakukan pertukaran melalui tiga operasi atom `add / replace / remove`.

**Hasilnya**: ejen memahami anda dengan lebih baik dari semasa ke semasa tanpa pernah kembung, dan ingatan bertambah kaya tanpa pernah hilang kawalan.

---

## Salah tanggapan biasa

> "Semakin banyak pembantu AI ingat, semakin bijak ia."

Begitulah sebaliknya. **Mengingati banyak maklumat berkualiti campuran menjadikan ejen bodoh** — ia mula menganggap kenyataan sementara, tersilap dan lapuk anda sebagai fakta yang stabil tentang anda. Sistem ingatan jangka panjang yang benar-benar berguna sentiasa **sedikit tetapi tepat**.

Untuk menyampaikannya, Hermes menjawab empat soalan:

- Apa yang patut dimasukkan ke dalam ingatan jangka panjang? (**pintu tulis**)
- Bagaimanakah serpihan masuk menjadi entri yang terbentuk dengan baik? (**kurasi**)
- Apakah yang berlaku apabila maklumat berubah? (**kemas kini semantik**)
- Apa yang berlaku apabila kapasiti penuh? (**penggabungan paksa**)

Bahagian di bawah berfungsi melalui keempat-empat mengikut urutan.

---

## 1. Penulisan: ejen adalah pintu pertama

Hermes' get pertama ialah **penapis tulis**. Daripada menyimpan setiap ayat, ejen **menilai sendiri** sama ada untuk menulis pada empat detik yang jelas:

- **Mampatan**: apabila konteks menghampiri hadnya, ejen menyemak sesi semasa dan mengekstrak perkara yang patut disimpan merentas sesi.
- **Titik Semak**: pada saat seperti menutup tugas atau menukar topik, ia memerlukan stok memori.
- **Nudges**: sistem secara berkala bertanya kepada ejen, "apa-apa sahaja dalam regangan ini bernilai ingatan jangka panjang?" serpihan yang begitu penting tidak hilang.
- **Arahan pengguna eksplisit**: "sila ingat X" ditulis dengan keutamaan.

Kriteria penghakiman biasanya termasuk:

| Dimensi | Maksudnya | Contoh balas |
|---|---|---|
| Kebolehgunaan semula | Mungkin ini berguna dalam tugasan lain nanti? | "Saya mahu latte hari ini" |
| Kestabilan | Adakah ia sementara atau berpanjangan? | "kepala saya sakit hari ini" |
| Kekhususan | Sikap kabur, atau fakta yang boleh diguna semula? | "Saya rasa saya lebih suka perkara yang lebih ringkas" |
| Kepekaan privasi | E-mel, kata laluan, alamat tidak disahkan secara jelas | Tidak ditulis secara lalai |

**Hermes Agent yang terlatih lebih suka mengingati terlalu sedikit daripada mengingati dengan tidak berhati-hati.**

---

## 2. Curation: menulis semula serpihan ke dalam entri

Walaupun selepas melepasi penapis tulis, maklumat yang masuk biasanya berpecah-belah. Hermes' langkah kedua ialah **menulis semula serpihan ke dalam entri yang dibentuk dengan baik.**

Sebagai contoh, perbualan mentah mungkin:

> "Oh, betul, API kami telah dialihkan untuk melalui pintu masuk dan bukannya memukul perkhidmatan secara langsung — itu minggu lepas."

Hermes tidak menyimpan kata kerja itu. Ia menulis:

```md
- [~2026-07-24] Project X's API now routes through the gateway instead of connecting directly.
```

Empat perkara berlaku di sana:

- **Pengambilan fakta**: perkataan pengisi seperti "oh betul" digugurkan.
- **Penyelesaian subjek**: "yang API milik kami" menjadi "Projek X".
- **Masa berlabuh**: "minggu lepas" menjadi tarikh anggaran.
- **Kebolehdapatan semula**: ditulis sebagai entri berstruktur supaya FTS5 boleh memadankannya kemudian (~20ms untuk dipadankan, ~1ms ke halaman).

Hanya selepas susun atur berstruktur, entri berpeluang **dipaling semula beberapa bulan kemudian**.

---

## 3. Tiga operasi atom: tambah / ganti / buang

Setiap pengubahsuaian Hermes dibuat kepada `MEMORY.md` mesti mendarat pada salah satu daripada tiga operasi atom:

| Operasi | Semantik | Pencetus |
|---|---|---|
| **tambah** | Tambah entri baharu | Acara baharu, keputusan baharu |
| **ganti** | **Tulis ganti** entri lama dengan yang baharu | Perubahan keadaan ("API kini melalui pintu masuk" menggantikan "API bersambung terus") |
| **buang** | Pemadaman fizikal | Penafian pengguna, entri tamat tempoh, entri lama digabungkan dengan penyatuan |

**Mengapakah operasi kabur (seperti "hanya kemas kini medan yang berkaitan") tidak dibenarkan?**

Sebab 1: operasi atom boleh diaudit. Setiap perubahan memori dipetakan kepada "entri ini → entri itu", yang membolehkan semakan yang tepat seperti `/memory diff <id>`.

Sebab 2: ia memaksa ejen membuat keputusan secara eksplisit. "Adakah saya menggantikan, atau menambah?" — pilihan binari adalah tempat pertukaran bermula, dan ia menghalang personaliti berpecah.

Sebab 3: ia meletakkan asas untuk pintu kelulusan (bahagian 7), di mana setiap item yang belum selesai boleh diluluskan atau ditolak secara bebas.

---

## 4. Kemas kini semantik: ubah suai dahulu, jangan tambahkan sebaliknya

Di sinilah sistem ingatan mudah jatuh: **apa yang berlaku apabila maklumat berubah?**

Pendekatan naif ialah menambah entri lain, yang meninggalkan ejen memegang semua ini sekaligus:

- "pengguna lebih suka Vue"
- "pengguna kemudian bertukar kepada React"
- "pengguna kembali ke Vue"

Tiga entri selari, dan model itu sendiri tidak lagi tahu mana yang perlu dipercayai.

Hermes **kemas kini daripada menambahkan sebaliknya**:

- Medan keutamaan dalam `USER.md` cenderung untuk **menimpa nilai lama** (`replace`).
- Dalam `MEMORY.md`, peristiwa bersejarah disimpan tetapi **medan keadaan semasa dikemas kini** (`replace`), meninggalkan kesan penghijrahan yang singkat.
- Apa-apa sahaja yang dinafikan pengguna secara jelas ("Saya tidak pernah seperti itu") ialah `remove`d — **dipadamkan secara fizikal**, tidak direkodkan sebagai "pengguna menafikan X".

Tujuan semua ini adalah untuk mengekalkan model dunia ejen **konsisten diri**.

---

## 5. Apabila kapasiti penuh: Satukan sekarang

Hermes menetapkan siling keras **~2,200 aksara** untuk `MEMORY.md`. Apabila ia diisi, mana-mana `add` kembali:

```json
{
  "success": false,
  "error": "Memory at 2,100/2,200 chars. Consolidate now...",
  "current_entries": [...],
  "usage": "2,100/2,200"
}
```

**Itu bukan pepijat, ia adalah reka bentuk.**

Jika penyertaan tertua digugurkan secara automatik apabila kapasiti diisi, ejen tidak akan pernah belajar untuk membuat pertukaran — maklumat penting mungkin ditendang keluar sementara maklumat yang tidak berkaitan kekal. Hermes melakukan sebaliknya: **tulisan ditolak sehingga ejen mengosongkan ruang itu sendiri.**

Penggabungan biasanya melibatkan:

- **Penggabungan topik**: beberapa entri serupa diringkaskan oleh LLM ke dalam satu ingatan yang lebih luas.
- **Pengarkiban tamat tempoh**: "matlamat pecut minggu ini ialah…" ialah `remove`d selepas tarikh berlalu.
- **Penurunan wajaran kekerapan akses**: entri tidak ditarik balik untuk masa yang lama bergerak ke belakang baris gilir dan digabungkan atau dipadamkan dahulu.

Bersama-sama, mekanisme ini bermakna **komentar anda secara langsung dari beberapa bulan yang lalu tidak terus mencemarkan penilaian ejen tentang anda**, manakala maklumat yang benar-benar penting akan diperkukuh berulang kali.

---

## 6. Gelung pembelajaran yang menyedari persetujuan: ejen belajar di latar belakang tanpa mengganggu anda

Hermes mempunyai satu lagi keupayaan tersembunyi: **gelung refleksi kendiri latar belakang**. Ia secara berkala:

1. menarik sesi terbaharu;
2. menjalankan model murah (seperti Gemini Flash) ke atasnya untuk mengekstrak apa yang patut diingat;
3. menghasilkan entri ingatan calon bertanda `[auto]`.

Huluan memanggil ini sebagai **gelung pembelajaran sedar persetujuan** — **pembelajaran tidak seharusnya mengganggu pengguna**, tetapi pengguna boleh masuk pada bila-bila masa.

Faedahnya:

- **Kos jatuh kepada satu pertiga atau satu perlima**: model murah mengendalikan semakan, dengan hampir tiada kesan ke atas kualiti tangkapan dalam ujian huluan.
- **Ejen berkembang walaupun anda tidak menggunakannya** — selagi ia kekal dalam talian.
- **Tiada gangguan dengan perbualan latar depan**: penyertaan calon menunggu anda di pintu kelulusan di bahagian seterusnya.

---

## 7. Pintu kelulusan: jika anda tidak selesa dengan ejen bertindak sendiri

Sesetengah pengguna bimbang: "bagaimana jika ejen menulis sesuatu yang salah ke dalam MEMORY secara automatik?"

Hermes menawarkan suis eksplisit:

```yaml
memory:
  write_approval: true    # turn on the approval gate
```

Dengan itu, **semua** penulisan memori (termasuk yang automatik daripada pantulan latar belakang) dipentaskan untuk semakan. Pengguna melaluinya dengan:

```
/memory pending           # list pending entries (background reflection marks them [auto])
/memory diff <id>         # inspect a specific change
/memory approve <id>      # approve (or all)
/memory reject <id>       # reject
```

Kemahiran mempunyai `skills.write_approval` yang berasingan, kerana `SKILL.md` boleh menjadi panjang dan janggal untuk dipaparkan sebaris; Hermes menyediakan `/skills diff <id>` supaya anda boleh membaca perbezaan bersatu penuh.

Gerbang kelulusan pada asasnya adalah penyahgandingan eksplisit **pembelajaran autonomi ejen** daripada **kedaulatan pengguna** — ejen boleh mengumpul pengalaman secara bebas, tetapi **setiap penulisan semula rekod pengguna sendiri** perlu melalui pengguna.

---

## 8. Ketelusan: anda boleh melihat setiap kemas kini memori

Hermes memaparkan tindakan memori melalui pemberitahuan dalam masa nyata:

| Tetapan | Dipaparkan sebagai |
|---|---|
| `off` | Tulisan senyap, tiada apa-apa yang ditunjukkan |
| `on` (lalai) | `💾 Memory updated` |
| `verbose` | `💾 Memory ➕ User prefers terse replies` (dengan pratonton kandungan) |

Daripada "sesuatu telah diingati" kepada "entri tepat ini diingati", butiran adalah milik anda untuk memilih. Tahap **kebolehlihatan** itu jarang berlaku dalam kalangan ejen AI — kebanyakannya menganggap ingatan sebagai kotak hitam.

---

## 9. Perjalanan Pembelajaran: mengkaji bagaimana ejen itu berkembang

Jika anda ingin **meninjau kembali** tentang apa yang telah dipelajari oleh ejen selama berbulan-bulan, Hermes menyediakan `/journey` (alias `/learning`, `/memory-graph`):

- CLI: `hermes journey` (menyokong `--play` ulang tayang animasi dan `--json` eksport)
- TUI: tindanan `/journey`
- Desktop: panel interaktif Peta Bintang

Dengan arahan pembersihan yang sepadan:

```bash
hermes journey list           # list all nodes
hermes journey delete <node>  # archive a Skill (recoverable) or delete a memory
hermes journey edit <node>    # open in $EDITOR
```

Alat ini penting jauh melangkaui kebaharuan — alat ini mengakui sesuatu yang nyata: **cara pertumbuhan ejen itu sendiri patut disemak.**

---

## 10. Mengapa sekatan ini penting dalam amalan

Letakkan semua perkara di atas bersama-sama dan Hermes' falsafah ingatan adalah **empat peraturan besi**:

1. **Bounded**: siling aksara memaksa keringkasan.
2. **Beku**: tiada perubahan dalam sesi, melindungi cache.
3. **Telus**: setiap tulisan kelihatan kepada pengguna, boleh diluluskan dan boleh balik.
4. **Menyatukan diri**: kedai penuh tidak pernah digugurkan secara senyap; ejen terpaksa membuat pertukaran.

Apabila memasarkan "memori AI", banyak produk menekankan betapa besarnya stor memori yang mereka sokong dan berapa banyak entri yang boleh mereka simpan. Walau bagaimanapun, dari sudut pandangan pengguna, hanya tiga perkara yang penting:

1. **Adakah ia ingat perkara yang sebenarnya penting?**
2. **Adakah ia mengemas kini maklumat yang tidak lagi disimpan dengan segera?**
3. **Adakah ia akan menjadi lebih bertele-tele dan lebih mudah ralat kerana mengingati timbunan perkara yang tidak berkaitan?**

**Sistem ingatan yang boleh menjawab "apa yang tidak patut diingat" ialah sistem ingatan yang baik.**

---

## 11. Satu perkara yang masih hilang untuk ini berfungsi dalam amalan

Walau bagaimanapun baik mekanisme ingatan, ia mempunyai satu prasyarat: **ejen perlu terus hidup.**

Jika anda memasang Hermes pada komputer riba anda sendiri, ia tidur setiap kali anda menutup penutup, gelung pantulan latar belakang terhenti dan `nudge_interval` tidak pernah mencapai pencetus seterusnya. Menukar mesin atau memasang semula OS bermakna menggerakkan `~/.hermes/` dengan tangan.

Di sinilah pengehosan awan menjadi benar-benar berguna. [**LightVela**](https://lightvela.ai/) ialah **perkhidmatan Hermes Agent dihoskan awan**:

- Contoh awan khusus dalam talian 24×7, dengan `MEMORY.md` / `USER.md` / arkib sesi SQLite yang tinggal di sana secara kekal;
- Gelung pantulan latar belakang terus berjalan, jadi ejen benar-benar berkembang walaupun anda tidak menggunakannya;
- Data kekal hanya pada pelayan khusus anda;
- Telefon, komputer riba, Telegram, Slack, Lark — setiap saluran mencapai ejen yang sama yang mengenali anda.

Hermes mengambil falsafah "lebih banyak ingatan tidak lebih baik" kepada kesimpulan logiknya; **LightVela menjadikan falsafah itu berkuat kuasa setiap hari, betul-betul di sebelah anda.** Begitulah janji untuk memahami anda dengan lebih baik dari semasa ke semasa sebenarnya disampaikan.

---

## Pengambilan utama

- Sistem ingatan yang baik = **tulisan yang ketat + penyusunan berstruktur + tiga operasi atom + penyatuan paksa + pantulan latar belakang + pintu kelulusan + ketelusan penuh.**
- Mengingat lebih tidak bermakna menjadi lebih bijak; mengiktiraf "apa yang tidak patut diingat" dan dipaksa untuk membuat pertukaran adalah lebih penting.
- Hermes menyediakan rujukan kejuruteraan; LightVela bertujuan untuk mengubahnya menjadi pengalaman produk yang boleh dicapai oleh pengguna.
