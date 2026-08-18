## Ringkasan

**Kepribadian Hermes Agent bukan blok teks karakter yang tetap. Ia muncul dari tiga bagian yang bekerja bersama: `SOUL.md` menetapkan siapa ia dan bagaimana ia bekerja — aturan perilaku yang stabil; `USER.md` mencatat bagaimana Anda ingin diperlakukan — nilai default dari relasi tersebut; `MEMORY.md` dan `memories/` memegang apa yang sudah Anda berdua bangun — bukti riwayat bersama. Menjaga peran ketiganya tetap terpisah itulah yang memungkinkan sebuah Agent menjadi stabil dan individual sekaligus: persona saja membuatnya identik bagi semua orang, memori saja membuat perilakunya melenceng tak terduga. Ketiganya tidak boleh saling menggantikan — persona tidak menyimpan fakta spesifik, `USER.md` tidak menyimpan suasana hati sesaat, dan `MEMORY.md` tidak membawa aturan perilaku. Ketiganya tetap di tempatnya ketika Anda mengganti model, sehingga kestabilan kepribadian tidak bergantung pada model tertentu.**

---

## Mengapa karakter yang sama seharusnya berperilaku berbeda dengan orang berbeda

Bayangkan dua pengguna yang keduanya mengonfigurasi Agent mereka sebagai "asisten riset yang sabar."

Yang pertama adalah product manager yang lebih suka kesimpulan sebelum penalarannya dan umumnya membahas ritme rilis serta prioritas. Yang kedua adalah mahasiswa yang membutuhkan penurunan lengkap dan umumnya membahas konsep serta tugas kuliah.

Jika kedua Agent itu mengatakan hal yang persis sama, maka "asisten riset yang sabar" sebenarnya tidak pernah terwujud — ia tetap sebuah label alih-alih menjadi cara kerja bersama yang konkret.

Sebaliknya, jika personalisasi berarti membiarkan perilaku melenceng bebas mengikuti setiap percakapan, Agent akan kehilangan sifat dapat diprediksi: cermat hari ini, sembarangan besok. Anda tidak dapat mengandalkannya.

**Kepribadian harus memenuhi dua tuntutan yang saling bertentangan sekaligus: stabil, dan spesifik per orang.** Hermes menyelesaikan ini dengan memecah kedua tuntutan itu ke lapisan-lapisan, masing-masing dibawa oleh file yang berbeda.

---

## 1. Tiga bagian, tiga tanggung jawab

Mulai dari gambaran keseluruhannya.

| Bagian | Tempatnya | Pertanyaan yang dijawabnya | Frekuensi perubahan |
|---|---|---|---|
| **Persona** | `SOUL.md` | Siapa saya? Dengan prinsip apa saya bekerja? | Sangat rendah; penyuntingan adalah keputusan yang disengaja |
| **Preferensi pengguna** | `USER.md` | Bagaimana Anda ingin diperlakukan? | Rendah; menyesuaikan dengan kebiasaan jangka panjang |
| **Memori jangka panjang** | `MEMORY.md`, `memories/` | Apa yang sudah kita bangun? | Tinggi; entri dapat bertambah di sebagian besar sesi |

**Perbedaan frekuensi perubahan** itu adalah salah satu alasan inti untuk memisahkannya. Menaruh buku aturan yang tidak bergerak berbulan-bulan ke dalam file yang sama dengan daftar fakta yang tumbuh harian berarti bagian yang stabil akan terhanyut oleh bagian yang mudah berubah. Ini penalaran yang sama di balik pemisahan `USER.md` dan `MEMORY.md` — lihat "Mengapa Hermes Agent Memecah Memori Menjadi Dua: Peran USER.md dan MEMORY.md."

---

## 2. Persona: aturan perilaku yang stabil

`SOUL.md` adalah buku aturan Agent, dan biasanya ia mencakup:

- **Peran** — apa yang ia perankan: asisten riset, mitra penulisan, asisten jaga komunitas.
- **Nada dan ekspresi** — formal atau santai, apakah memakai analogi, apakah humor diterima.
- **Urutan prioritas** — mana yang menang ketika akurasi berbenturan dengan kecepatan, atau keringkasan dengan kelengkapan.
- **Batas perilaku** — apa yang tidak akan ia lakukan, apa yang tidak akan ia uraikan, tindakan mana yang butuh konfirmasi lebih dulu.

Tiga poin praktis saat menulis persona.

**Pertama, tulis prinsip, bukan fakta.** "Saya bekerja untuk seorang product manager di proyek agent-demo" tidak termasuk di `SOUL.md` — itu fakta, dan tempatnya di `USER.md` atau memori. Persona seharusnya menyatakan prinsip yang tahan lama seperti "untuk pertanyaan produk, berikan kesimpulan sebelum penalarannya."

**Kedua, buat batasannya cukup konkret untuk dinilai.** "Tetap profesional" tidak dapat dievaluasi kepatuhannya. "Jangan menawarkan keputusan medis, hukum, atau investasi; berikan informasi publik lalu sarankan berkonsultasi dengan profesional" bisa. Aturan abstrak menghasilkan kepatuhan yang sangat berbeda antar model.

**Ketiga, nyatakan prioritas secara eksplisit untuk konflik.** Aturan pasti berbenturan — keringkasan dan kelengkapan adalah salah satu pasangannya. Tanpa urutan yang eksplisit, Agent harus menerka setiap kali, dan perilakunya menjadi tidak konsisten.

---

## 3. Preferensi pengguna: nilai default dari relasi

`USER.md` membawa **informasi stabil tentang Anda**, sehingga Agent tidak harus bertanya lagi setiap kali. Kandidat yang baik:

- **Bahasa dan ekspresi** — bahasa apa, apakah terminologi dipertahankan dalam bentuk aslinya, apakah contoh membantu.
- **Ritme komunikasi** — kesimpulan dulu, atau jalur penalaran lengkapnya.
- **Tool dan lingkungan yang biasa dipakai** — stack, platform, dan gaya kerja yang Anda pakai harian.
- **Hal yang secara eksplisit perlu dihindari** — arah yang tidak ingin Anda gali, pilihan kata yang tidak ingin Anda pakai.

Ada uji sederhana untuk menentukan apakah sesuatu termasuk di `USER.md`: **apakah ia masih benar tiga bulan lagi?** "Saya lebih suka jawaban ringkas" mungkin masih benar, jadi ia cocok. "Saya sedang buru-buru hari ini" tidak akan — itu konteks sesaat dan sebaiknya tidak dimasukkan.

Uji ini penting. Menuliskan suasana hati sesaat ke `USER.md` membuat Agent memperlakukan keadaan sementara sebagai permanen. Jika Anda pernah berkata "singkat saja" saat sedang buru-buru lalu itu mengeras menjadi preferensi jangka panjang, ia akan menahan detail nanti ketika Anda benar-benar membutuhkannya.

---

## 4. Memori jangka panjang: bukti riwayat bersama

`MEMORY.md` dan `memories/` menyimpan **fakta yang sudah terjadi dan layak dipertahankan**: status proyek, keputusan yang diambil, kesimpulan yang dapat dipakai ulang, mengapa sebuah parameter diatur seperti itu.

Hubungannya dengan dua yang lain:

- Persona menentukan **prinsip perilaku**.
- `USER.md` menentukan **gaya interaksi default**.
- Memori menentukan **latar belakang yang Anda berdua bagikan**.

Pemanggilan kembali bersifat sesuai kebutuhan: Hermes membangun indeks teks penuh SQLite + FTS5 di atas entri lalu menarik yang cocok ke dalam konteks ketika Anda mengangkat topik terkait, alih-alih mendorong seluruh riwayat masuk. Penulisannya juga bukan penambahan tanpa batas — ia dipelihara melalui operasi atomik `add` / `replace` / `remove` dan dapat ditinjau lewat `/memory pending`. Untuk logika kurasi lengkapnya, lihat "Mengapa Lebih Banyak Memori Bukan Berarti Lebih Baik: Bagaimana Hermes Agent Menyeleksi, Mengurasi, dan Memperbarui Memori Jangka Panjang."

**Memori seharusnya tidak menggantikan persona.** Kesalahan umum adalah menulis aturan perilaku sebagai entri memori, misalnya "ingat: selalu berikan kesimpulan lebih dulu." Itu menciptakan dua masalah: entri tersebut mungkin tidak dipanggil kembali bila kuerinya tidak cocok, dan ia dapat terhanyut oleh entri yang lebih baru. Aturan perilaku tempatnya di `SOUL.md`, yang selalu tinggal di memori aktif.

---

## 5. Bagaimana ketiganya bergabung menghasilkan satu jawaban

Sebuah skenario konkret yang mengikat lapisan-lapisan itu.

**Penyiapan**:

- `SOUL.md`: asisten riset; kesimpulan sebelum penalaran; tandai ketidakpastian secara eksplisit; jangan menguraikan saran medis atau investasi.
- `USER.md`: lebih suka bahasa Inggris; pertahankan istilah teknis dalam bentuk aslinya; jaga jawaban tetap mudah dipindai.
- `MEMORY.md`: saat ini mengerjakan situs global untuk proyek agent-demo; pekan lalu diputuskan mengubah halaman utama menjadi gradien beranimasi; proyeknya berjalan di Next.js.

**Pertanyaan Anda**: "Untuk pendekatan halaman utama saat ini, apa risiko menambahkan latar belakang video?"

**Apa yang disumbangkan tiap lapisan**:

1. **Memori** memasok latar belakang: Agent tahu halaman mana yang dimaksud "halaman utama" dan bahwa ia baru diubah menjadi gradien beranimasi, sehingga ia dapat memperlakukan latar belakang video sebagai perubahan di atas itu alih-alih keputusan dari nol.
2. **Persona** menentukan strukturnya: kesimpulan dulu ("risiko utamanya adalah performa above-the-fold dan pemakaian data seluler"), lalu penalarannya, dengan ketidakpastian ditandai secara eksplisit.
3. **`USER.md`** menentukan ekspresinya: jawab dalam bahasa Inggris, pertahankan istilah seperti `LCP` dan `autoplay` apa adanya, dan jaga panjangnya tetap mudah dipindai.

Hapus salah satu lapisan dan hasilnya menurun secara terlihat: tanpa memori jawabannya tetap generik; tanpa persona strukturnya melenceng dan ketidakpastian tidak ditandai; tanpa preferensi bahasa dan panjangnya tidak sesuai cara Anda membaca.

---

## 6. Gejala umum dan tempat masing-masing seharusnya berada

Dalam praktik pertanyaan paling sering adalah "informasi ini seharusnya ditaruh di mana?" Tabel di bawah menjawabnya.

| Gejala | Penyebab yang lebih mungkin | Apa yang perlu diubah |
|---|---|---|
| Pendekatan generik yang sama untuk setiap topik | Memori kurang latar belakang spesifik Anda | Tambahkan entri memori |
| Perilaku tidak konsisten, cermat lalu sembarangan | Aturan persona terlalu abstrak, atau tanpa prioritas konflik | Sunting `SOUL.md` agar aturannya dapat dinilai |
| Anda menyatakan ulang preferensi setiap kali | Preferensinya belum pernah ditulis ke `USER.md` | Tambahkan ke `USER.md` |
| Memperlakukan keadaan sementara sebagai permanen | Konteks sesaat tertulis ke `USER.md` | Hapus entri itu; nyatakan di dalam percakapan saja |
| Sebuah aturan berlaku kadang-kadang tetapi tidak selalu | Aturannya disimpan sebagai entri memori | Pindahkan dari memori ke `SOUL.md` |
| Nada bergeser jelas setelah penggantian model | Model baru menerapkan aturan dengan tingkat ketegasan berbeda | Buat batasan kuncinya lebih spesifik; jangan sentuh memori |

Baris terakhir patut ditegaskan: **pergeseran nada setelah mengganti model bukan kepribadian yang hilang.** `SOUL.md` masih di tempatnya; kepatuhannya yang berubah. Untuk cara membedakannya, lihat "Apakah Mengganti Model Membuat Agent Lupa? Memisahkan Model, Persona, dan Memori."

---

## 7. Pendekatan LightVela: kepribadian dan preferensi sebagai aset yang dapat dikelola

Hermes memisahkan ketiga lapisan ini dengan jelas, tetapi ia masih menyasar orang yang menyunting Markdown secara langsung. LightVela menjalankan model berbasis cloud dan tidak mengekspos operasi sistem file kepada pengguna, sehingga lapisan ini dipelihara secara berbeda dibandingkan penyiapan yang di-hosting sendiri:

- **Persona dikonfigurasi melalui fitur Persona** — bagian Persona pada halaman pengaturan Agent menawarkan dua pintu masuk, mengambil persona secara acak atau menjawab kuis singkat. Tinjau peran, nada, dan catatan perilaku pada kartu persona, lalu pilih Inject Persona untuk menerapkannya. Fitur ini menghasilkan dan menyuntikkan Soul tanpa menuntut Anda menyentuh sistem file cloud, meskipun ia bukan editor serbaguna untuk file cloud sembarangan.
- **Memori dapat dilihat di konsol** — halaman memori menampilkan apa yang dipertahankan Agent, dengan tab terpisah untuk Memory dan User Profile, sesuai pemisahan antara fakta dan preferensi stabil.
- **Penambahan dan penghapusan terjadi melalui percakapan** — Anda tidak perlu sengaja "mengisi" memori. Selama percakapan normal Hermes memutuskan apa yang layak dipertahankan; ketika Anda ingin ia mengingat atau melupakan sesuatu, cukup katakan di chat.
- **Kapasitas dapat disesuaikan** — konsol memungkinkan Anda menaikkan atau menurunkan batas kapasitas memori, mencegah konteks jangka panjang tumbuh tanpa batas.
- **Stabil lintas model** — mengganti model tidak menghapus memori, skill, maupun otomasi, sehingga kestabilan kepribadian tidak bergantung pada model tertentu.
- **Konsisten lintas kanal** — satu Agent berbagi memori dan persona yang sama di setiap kanal yang terhubung; berganti ponsel atau kanal tidak menghilangkannya, dan tidak ada yang perlu diduplikasi per platform.

---

## Poin penting

- Kepribadian muncul dari tiga bagian: `SOUL.md` (aturan perilaku), `USER.md` (gaya interaksi default), `MEMORY.md` / `memories/` (latar belakang bersama).
- Alasan inti memisahkannya adalah **frekuensi perubahan yang berbeda**: aturan tidak bergerak berbulan-bulan, memori tumbuh nyaris harian.
- Persona menyatakan prinsip alih-alih fakta, menjaga batasannya cukup konkret untuk dinilai, dan mendeklarasikan prioritas bagi aturan yang berbenturan.
- Uji keanggotaan `USER.md`: **apakah ia masih benar tiga bulan lagi?**
- Jangan menyimpan aturan perilaku sebagai entri memori, atau ia akan gagal sesekali karena kegagalan pemanggilan kembali atau terhanyut.
- Pergeseran nada setelah mengganti model mencerminkan kepatuhan yang berbeda, bukan kepribadian atau memori yang hilang.
