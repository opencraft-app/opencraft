## Ringkasan

**Mengganti model tidak membuat Hermes Agent melupakan Anda, karena model, persona, dan memori adalah tiga lapisan yang disimpan terpisah: model menangani reasoning dan generasi, `SOUL.md` mendefinisikan peran dan batas ekspresi, dan `USER.md` plus `MEMORY.md` (dengan `memories/`) memegang profil pengguna serta fakta lintas sesi. Di LightVela, mengganti model hanya mengubah mesin di balik balasan berikutnya — ia tidak menghapus memori, file cloud storage, skill, maupun pengaturan tugas terjadwal, dan ia tidak memindahkan riwayat chat. Setelahnya mungkin memang "terasa berbeda", tetapi itu berasal dari kecenderungan model baru dalam mengikuti instruksi, mengompresi konteks, panjang jawaban, dan pemanggilan tool, bukan dari kehilangan data. Ada tepat satu cara untuk membedakannya: tanyakan fakta yang Anda yakin seharusnya ia ketahui. Jika ia menjawab, yang Anda lihat adalah perbedaan gaya; jika ia tidak bisa, baru selidiki lapisan memorinya.**

---

## Pilihan katanya berubah — apakah memorinya ikut hilang?

Setelah mengganti model, pengalaman yang paling umum adalah ini: pilihan katanya berubah, panjangnya berubah, dan ia tidak lagi mengangkat hal-hal yang sudah Anda bahas sebelumnya.

Reaksi pertama nyaris semua orang adalah "ia melupakan saya." Reaksi itu wajar — dalam kehidupan sehari-hari, ketika seseorang berhenti merujuk riwayat bersama, kita memang menduga ia lupa.

Namun di dalam sistem Agent, analogi itu menyesatkan. **"Tidak menyebutkannya" dan "tidak mengetahuinya" adalah dua hal yang sama sekali berbeda.** Yang pertama adalah strategi ekspresi; yang kedua adalah data yang hilang. Keduanya berbeda dalam diagnosis, biaya perbaikan, dan tingkat keparahan, dan mencampurnya berarti membuang waktu memperbaiki masalah yang tidak ada.

Artikel ini memisahkan keduanya secara definitif lalu memberi Anda uji yang dapat dijalankan.

---

## 1. Lima lapisan: apa yang diganti, apa yang tetap

Pertama, jelaskan dengan presisi apa yang sebenarnya diubah oleh tindakan "mengganti model".

| Lapisan | Tanggung jawab | Tempatnya | Setelah penggantian |
|---|---|---|---|
| **Model** | Reasoning, perencanaan, keputusan pemanggilan tool, bahasa | Pengaturan yang dapat dikonfigurasi | **Diganti** |
| **Persona** | Peran, nada, prioritas, batas perilaku | `SOUL.md` | Dipertahankan |
| **Profil pengguna** | Kebiasaan bahasa, ritme, tool yang biasa dipakai, hal yang dihindari | `USER.md` | Dipertahankan |
| **Memori** | Fakta lintas sesi, status proyek, keputusan masa lalu | `MEMORY.md`, `memories/` | Dipertahankan |
| **Skill** | Prosedur standar yang dipicu situasi | `skills/` (tiap `SKILL.md`) | Dipertahankan |

Poin kuncinya: **keempat lapisan terakhir semuanya hidup di luar model.** Ketika model diganti, file dan direktori itu tetap persis di tempatnya, dan model baru membaca serta menerapkannya.

Inilah sebabnya dokumentasi dapat menyatakan terang-terangan bahwa mengganti model tidak menghapus memori Agent, file cloud storage, skill, maupun pengaturan tugas terjadwal — itu bukan fitur pelindung yang ditambahkan seseorang, itu konsekuensi alami dari penyimpanan berlapis. Untuk pembagian tugas selengkapnya, lihat "Bisakah Otak Hermes Agent Diganti? Lapisan Model vs Lapisan Agent."

---

## 2. Jadi mengapa ia memang terasa berbeda?

Jika datanya semua utuh, mengapa pengalamannya berubah? Karena **konteks yang sama, diserahkan ke model yang berbeda, akan ditafsirkan ulang.**

Model berbeda pada dimensi-dimensi nyata berikut:

### 2.1 Mengikuti instruksi

Batasan di `SOUL.md` masih ada, tetapi model baru mungkin menerapkannya lebih longgar atau lebih ketat. Jika Anda menulis "mulai dengan kesimpulannya", sebagian model mematuhinya setiap kali sementara yang lain membangun menuju kesimpulan pada pertanyaan kompleks.

**Tampak sebagai**: kepribadiannya berubah. **Sebenarnya**: aturannya tidak berubah; kepatuhannya berubah.

### 2.2 Kompresi konteks

Saat menyusun jawaban, Agent memutuskan berapa banyak latar belakang yang dikutip. Model menimbangnya berbeda: sebagian secara proaktif menyatakan ulang "Anda menyebut X sebelumnya", yang lain mengasumsikan Anda sudah tahu lalu langsung ke intinya.

**Tampak sebagai**: ia melupakan apa yang kita bahas. **Sebenarnya**: pemanggilan kembali berfungsi, ia hanya tidak menyatakannya ulang. Inilah kasus yang paling sering salah didiagnosis sebagai amnesia.

### 2.3 Preferensi panjang jawaban

Untuk pertanyaan yang sama, panjang jawaban dapat berbeda berkali-kali lipat antar model.

**Tampak sebagai**: ia jadi lebih bodoh, atau jadi bertele-tele. **Sebenarnya**: panjang default yang berbeda, dapat disesuaikan lewat preferensi di `USER.md` atau permintaan eksplisit.

### 2.4 Kecenderungan pemanggilan tool

Sebagian model lebih suka membaca file atau mencari sebelum menjawab; yang lain bersandar pada konteks yang ada.

**Tampak sebagai**: ia berhenti memakai tool. **Sebenarnya**: ambang pemanggilannya berbeda.

### 2.5 Gaya bahasa

Pilihan kata, bentuk sapaan, dan nada semuanya dapat bergeser.

**Tampak sebagai**: ia menjadi orang lain. **Sebenarnya**: kategori yang paling permukaan dan paling tidak berbahaya.

Dilihat bersama-sama, kelimanya berbagi satu ciri: **semuanya tentang *cara ia berekspresi*, bukan *apa yang ia ketahui*.** Justru itulah yang diandalkan uji di bawah ini.

---

## 3. Satu tindakan menyelesaikannya: tanyakan fakta yang sudah diketahui

Jangan menilai dari rasa. Pakai uji yang deterministik.

**Metode**: pikirkan fakta yang Anda **yakin** sudah Anda sampaikan secara eksplisit dan seharusnya sudah ada di memori jangka panjang — nama proyek, preferensi bahasa Anda, sebuah batasan eksplisit. Setelah penggantian, tanyakan persis itu.

**Interpretasi**:

| Hasil | Kesimpulan | Langkah berikutnya |
|---|---|---|
| Menjawab dengan benar | Lapisan memori utuh; yang Anda lihat perbedaan gaya | Sesuaikan preferensi atau prompting; jangan sentuh memori |
| Tidak dapat menjawab tetapi mengatakan ia tidak yakin | Kemungkinan kegagalan pemanggilan kembali | Ubah kalimatnya lalu tanya lagi untuk memisahkan pemanggilan dari ketiadaan |
| Menjawab salah atau mengarang sesuatu | Konten memorinya sendiri perlu diperiksa | Periksa apakah entrinya ada atau sudah kedaluwarsa |

Uji ini berhasil karena ia menghapus variabel ekspresi: Anda menanyakan fakta dengan jawaban yang pasti, sehingga bagaimanapun gayanya berubah, kebenarannya tetap objektif.

---

## 4. Checklist lengkap pasca-penggantian

Urutan ini mencakup sebagian besar kasus.

1. **Pastikan penggantiannya berlaku** — konsol seharusnya menampilkan model yang Anda pilih. Ini menyingkirkan "merasa sudah berganti tetapi belum."
2. **Kirim pesan uji singkat** — pastikan model baru membalas normal. Jika balasan pertama setelah penggantian sedikit lambat, tunggu lalu coba sekali lagi sebelum mengubah apa pun.
3. **Jalankan uji fakta yang sudah diketahui** — verifikasi lapisan memori memakai bagian 3.
4. **Periksa persona masih sesuai ekspektasi** — cermati apakah nada dan batasannya tetap di dalam `SOUL.md`. Jika pergeserannya jelas, buat batasan kuncinya lebih spesifik.
5. **Cek sampel bahwa sebuah skill masih terpicu** — coba satu pada situasi yang cocok lalu pastikan skill tersebut dimuat.
6. **Tinjau kualitas keluaran tugas terjadwal** — perhatikan bahwa Anda meninjau **kualitas keluaran**, bukan menyinkronkan kolom model. Tugas Terjadwal tidak punya pengaturan "model yang disematkan".
7. **Pastikan file cloud storage utuh** — penggantian tidak menulis ulangnya; ini hanya verifikasi.

Langkah 6 patut ditegaskan, karena klaim yang tersebar luas mengatakan Anda harus menyinkronkan ulang model setiap tugas terjadwal setelah penggantian. Kenyataannya sebuah tugas terjadwal terdiri dari nama, jadwal (hari tetap dalam seminggu, interval tetap, atau sekali jalan), instruksi tugas, jendela waktu aktif, dan kanal notifikasi — **tanpa kolom model**. Jadi tindakan yang benar adalah menunggu satu eksekusi nyata lalu memeriksa apakah kualitas keluarannya masih memenuhi ekspektasi.

---

## 5. Jika ia benar-benar berhenti bekerja setelah penggantian

Ini kelas masalah yang berbeda — bukan "terasa berbeda" melainkan "tidak berfungsi". Telusuri dengan urutan ini:

1. **Pastikan konfigurasi model lengkap** — kembali ke konfigurasi model lalu periksa model tujuan, kredensial, dan pengaturan penyedianya.
2. **Pastikan ketersediaan akun dan kuota** — verifikasi model tersedia untuk akun Anda dan kuota atau saldo di sisi penyedia memadai.
3. **Uji dengan model yang sudah pasti berfungsi** — ini memisahkan "model ini bermasalah" dari "seluruh jalurnya bermasalah".
4. **Periksa log terbaru di Diagnostik** — jika ia masih tidak dapat membalas, pakai lognya untuk menentukan apakah masalahnya ada pada model, konfigurasinya, atau tugasnya, lalu putuskan apakah perlu mereset konfigurasi modelnya.

Satu prinsip umum patut diingat: **ubah satu faktor pada satu waktu, dan uji setelah tiap perubahan.** Mengganti model, menyunting persona, dan menambahkan skill sekaligus membuat Anda tidak dapat mengaitkan sebuah kegagalan dengan penyebabnya. Selama penelusuran masalah, disiplin ini jauh lebih bernilai daripada rasa puas karena mengonfigurasi segalanya dalam satu lintasan.

---

## 6. Kapan penggantian itu berharga, dan kapan tidak

Penggantian punya biaya: Anda beradaptasi ulang dengan gaya ekspresi yang berbeda dan mungkin perlu menyetel ulang prompt. Jadi ada gunanya memperjelas motivasinya.

**Berharga untuk berganti**:

| Kebutuhan | Pendekatan yang disarankan |
|---|---|
| Draf pertama lebih cepat | Pilih model terkonfigurasi yang cocok untuk pekerjaan singkat dan rutin |
| Reasoning atau bantuan kode lebih kuat | Pilih model yang Anda konfigurasikan untuk jenis pekerjaan itu |
| Sebuah penyedia tidak tersedia atau terkena rate limit | Ganti ke model terkonfigurasi lain lalu uji di chat |
| Membandingkan kualitas keluaran | Pakai pesan uji **yang sama** setelah tiap penggantian, lalu bandingkan |

**Tidak berharga untuk berganti**:

- Karena satu jawaban mengecewakan Anda. Periksa dulu apakah prompt-nya cukup spesifik, atau apakah batasan `SOUL.md` cukup konkret.
- Karena Anda mendengar model lain lebih kuat. Lebih kuat tidak sama dengan lebih cocok untuk bauran tugas dan profil biaya Anda.
- Untuk "memperbaiki masalah memori". Masalah memori tidak dapat diselesaikan di lapisan model; periksa entri memorinya.

Frasa "pesan uji yang sama" di baris keempat itu penting: jika Anda membandingkan model memakai pertanyaan berbeda setiap kali, yang Anda ukur adalah tingkat kesulitan pertanyaan, bukan perbedaan modelnya.

---

## 7. Pendekatan LightVela: menjadikan penggantian sebagai operasi berisiko rendah

Hermes mewujudkan pemisahan lapisan pada tingkat mekanisme, tetapi mengelola akses model dan lingkungan tetap menjadi tanggung jawab operatornya. Arah LightVela adalah menjadikan penggantian sebagai operasi rutin, berisiko rendah, dan dapat diverifikasi:

- **Satu Agent punya satu model aktif pada satu waktu** — mengganti berarti memilih, tanpa perlu Agent terpisah per model.
- **Aset tetap stabil melewati penggantian** — memori, file cloud storage, skill, dan pengaturan tugas terjadwal tidak terpengaruh, dan riwayat chat tidak dipindahkan.
- **Penggantian dapat diverifikasi** — konsol menampilkan model aktif, dan satu pesan uji memastikan keberhasilannya.
- **Kegagalan dapat dilokalisasi** — Diagnostik menyimpan log terbaru untuk memisahkan masalah model, konfigurasi, dan tugas.
- **Perubahan satu faktor dianjurkan** — mengubah satu hal pada satu waktu lalu segera menguji adalah rekomendasi yang terdokumentasi.

---

## Poin penting

- Model, persona, profil pengguna, memori, dan skill adalah lima lapisan independen; penggantian hanya mengganti yang pertama.
- Perilaku yang terdokumentasi: penggantian tidak menghapus memori, cloud storage, skill, maupun tugas terjadwal, dan tidak memindahkan riwayat chat.
- "Terasa berbeda" berasal dari lima perbedaan di lapisan ekspresi: mengikuti instruksi, kompresi konteks, panjang jawaban, kecenderungan pemanggilan tool, gaya bahasa.
- **Menentukan kehilangan memori yang nyata cukup satu langkah**: tanyakan satu fakta pasti yang sudah diketahui.
- Tugas Terjadwal tidak punya kolom model yang disematkan; setelah penggantian, tinjau kualitas keluaran alih-alih mencari kolom tersebut.
- Selama menelusuri masalah, pegang satu aturan: ubah satu faktor pada satu waktu lalu segera uji.
