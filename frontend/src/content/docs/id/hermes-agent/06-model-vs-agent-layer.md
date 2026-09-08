## Ringkasan

**"Otak" sebuah Hermes Agent dapat diganti, tetapi yang diganti hanyalah lapisan model, bukan seluruh Agent. Lapisan model menentukan cara berpikir kali ini — mengurai permintaan, merencanakan langkah, memilih tool yang dipanggil, dan menyusun kalimat jawabannya. Lapisan Agent menjaga pemikiran itu berlanjut sepanjang waktu: identitas (`SOUL.md`), profil pengguna (`USER.md`), fakta lintas sesi (`MEMORY.md` dan `memories/`), metode yang tertangkap (`skills/`), kanal pesan, tugas terjadwal, dan direktori kerja semuanya hidup di luar model. Karena itulah mengganti model tidak menghapusnya. Di LightVela, satu Agent memakai tepat satu model aktif pada satu waktu, dan mengganti model tidak menghapus memori, file cloud storage, skill, maupun pengaturan tugas terjadwal — ia hanya mengubah mesin di balik balasan berikutnya. Jika sebuah Agent terasa seperti orang asing setelah penggantian, penyebabnya nyaris selalu perbedaan perilaku dalam mengikuti instruksi, mengompresi konteks, dan menyusun kalimat pada model baru, bukan memori yang hilang.**

---

## Mengapa pertanyaan ini terus muncul

"Bisakah saya memindahkan Agent saya ke model yang lebih kuat?" adalah salah satu pertanyaan paling umum tentang produk Agent. Pertanyaan lanjutannya langsung menyusul: "Apakah ia masih akan mengingat saya?"

Menanyakan keduanya bersamaan mengungkap miskonsepsi yang tersebar luas — bahwa model dan Agent adalah hal yang sama. Dalam model mental itu, sebuah Agent hanyalah antarmuka chat yang membungkus sebuah LLM, sehingga mengganti model berarti mengganti seluruh asistennya, dan memulai dari awal terasa tak terhindarkan.

Jika itu benar-benar demikian, tidak ada Agent yang bisa memiliki nilai jangka panjang. Konteks proyek yang Anda jelaskan pekan lalu, nada yang Anda setel dengan cermat, alur kerja yang Anda tangkap — semuanya akan ter-reset pada setiap peningkatan teknis. Itu bukan produk yang bisa diandalkan siapa pun.

Hermes Agent dibangun di atas premis sebaliknya: **model adalah komponen yang dapat diganti, dan Agent adalah hal yang bertahan.** Artikel ini membongkar apa arti sebenarnya hal itu dalam praktik.

---

## 1. Pisahkan dulu tiga hal: model, runtime, aset jangka panjang

Sebelum membahas penggantian model, ada gunanya mengenali bahwa sebuah Agent memuat setidaknya tiga lapisan dengan siklus hidup yang sangat berbeda.

| Lapisan | Apa itu | Siklus hidup | Saat model diganti |
|---|---|---|---|
| **Lapisan model** | LLM yang menyediakan reasoning dan generasi | Dapat dikonfigurasi, dapat diganti kapan saja | Diganti |
| **Runtime Agent** | Proses yang menjalankan tool, I/O kanal, dan penjadwalan | Berjalan lama | Tidak berubah |
| **Aset jangka panjang** | `SOUL.md`, `USER.md`, `MEMORY.md`, `memories/`, `skills/`, file direktori kerja | Terkumpul seiring waktu | Tidak berubah |

Sebagian besar orang hanya melihat lapisan pertama dan jendela chat, melewatkan runtime di tengah dan lapisan aset di bawahnya. Padahal kedua lapisan bawah itulah yang membuat sebuah Agent tetap dikenali sebagai "Agent yang sama" setelah berbulan-bulan pemakaian.

Analogi yang berguna: model adalah cara seseorang berpikir saat ini, runtime adalah tubuh dan tangan orang tersebut, dan aset jangka panjang adalah identitas, memori, serta kebiasaan profesionalnya. Mengubah cara seseorang berpikir tidak membuatnya menjadi orang yang berbeda, karena identitas dan memorinya tidak berubah bersamanya.

---

## 2. Lapisan model: bertanggung jawab atas "cara berpikir kali ini"

Di dalam satu pertukaran, lapisan model melakukan lebih dari sekadar menghasilkan teks. Ia menentukan setidaknya empat hal:

1. **Interpretasi** — mengubah pesan Anda menjadi tujuan yang konkret, termasuk batasan yang Anda isyaratkan tetapi tidak Anda sebutkan.
2. **Perencanaan** — menilai berapa langkah yang dibutuhkan pekerjaan tersebut, mana yang lebih dulu, dan apakah riset harus mendahului tindakan.
3. **Keputusan pemanggilan tool** — memutuskan apakah perlu membaca file, mencari di web, atau menjalankan perintah, dan dengan argumen apa.
4. **Ekspresi** — menata hasilnya menjadi bahasa yang mudah dibaca, termasuk seberapa detail yang disertakan dan format apa yang dipakai.

Keempatnya termasuk pada lintasan inferensi *ini*. Semuanya membentuk pengalaman Anda secara langsung, dan itulah sebabnya mengganti model menghasilkan perubahan rasa yang terasa.

Sama pentingnya adalah apa yang **tidak** dimiliki lapisan model:

- Model bukan database Anda. Ia tidak menyimpan preferensi, status proyek, atau kesimpulan masa lalu Anda.
- Model bukan penjadwal. Ia tidak punya pengetahuan bahwa sesuatu harus berjalan setiap pagi pukul tujuh.
- Model bukan pengelola kanal. Ia tidak menentukan percakapan Telegram mana yang menerima balasannya.

Semua kemampuan itu hidup di luar model. Itulah dasar teknis dari "mengganti model bukan mengganti Agent."

---

## 3. Lapisan Agent: bertanggung jawab membuat pemikiran berkelanjutan

Tanggung jawab lapisan Agent terbagi ke dalam lima kelompok, ditata berdasarkan masalah yang diselesaikan masing-masing.

### 3.1 Identitas dan aturan perilaku: `SOUL.md`

`SOUL.md` mendefinisikan siapa Agent ini, dengan nada apa ia bekerja, bagaimana ia menyusun prioritas, dan apa yang tidak akan ia lakukan. Ini adalah kumpulan aturan yang stabil, bukan suasana hati yang diimprovisasi per percakapan.

Setelah model diganti, `SOUL.md` tetap persis di tempatnya. Model baru membaca dan menerapkan aturan yang sama — **ia mungkin mengikutinya lebih longgar atau lebih ketat, tetapi aturannya sendiri tidak berubah**. Pembedaan itu adalah kunci untuk memahami bagian "terasa berbeda" nanti.

### 3.2 Profil pengguna: `USER.md`

`USER.md` memuat informasi stabil tentang Anda: kebiasaan bahasa, ritme komunikasi yang disukai, tool yang rutin Anda pakai, hal-hal yang secara eksplisit perlu dihindari. Ini menyelamatkan Agent dari harus bertanya "Anda mau versi panjang atau pendek?" setiap kali.

### 3.3 Fakta lintas sesi: `MEMORY.md` dan `memories/`

Lapisan ini menyimpan fakta dan kesimpulan yang sudah terjadi dan dinilai layak dipertahankan: nama proyeknya apa, apa yang diputuskan pekan lalu, mengapa sebuah parameter diatur seperti itu. Hermes membangun indeks teks penuh SQLite + FTS5 di atas entri ini lalu memanggil kembali yang cocok ketika Anda mengangkat topik terkait, alih-alih menjejalkan seluruh riwayat ke dalam konteks.

Memory bukan append-only selamanya. Ia dipelihara melalui operasi atomik `add` / `replace` / `remove` dan dapat ditinjau lewat `/memory pending`. Untuk desain lengkapnya, lihat "Mengapa Lebih Banyak Memori Bukan Berarti Lebih Baik: Bagaimana Hermes Agent Menyeleksi, Mengurasi, dan Memperbarui Memori Jangka Panjang."

### 3.4 Metode yang tertangkap: `skills/`

`skills/` menyimpan prosedur standar untuk "ketika situasi X terjadi, lakukan ini." Setiap `SKILL.md` biasanya membawa YAML frontmatter yang mendeklarasikan kondisi pemicunya. Ini adalah memori prosedural, jalur yang terpisah dari Memory deklaratif — lihat "Memory Bukan Skill: Bagaimana Hermes Agent Memisahkan Memori Faktual dan Prosedural."

### 3.5 Konektivitas dan penjadwalan: kanal, tugas terjadwal, direktori kerja

- **Kanal** menentukan dari pintu masuk mana Agent menerima pesan dan ke mana hasilnya dikirimkan.
- **Tugas Terjadwal** menentukan pekerjaan apa yang ia selesaikan ketika Anda tidak menanyakan apa pun.
- **Direktori kerja** menentukan di mana input dan output tugas berada, dan di mana batasnya.

Ketiganya adalah konfigurasi lapisan Agent, independen dari model mana yang sedang aktif.

---

## 4. Mengapa pemisahan itu perlu: empat alasan praktis

Memisahkan model dari Agent bukan kemurnian arsitektural. Ia menghasilkan manfaat konkret.

**Alasan pertama: model membaik jauh lebih cepat daripada aset pribadi terkumpul.** Model yang secara berarti lebih kuat bisa dirilis dalam hitungan bulan, sementara memori bersama, preferensi, dan alur kerja Anda menumpuk perlahan. Jika keduanya terikat, setiap peningkatan akan menghabiskan akumulasi itu — dan pengguna akan menolak melakukan peningkatan.

**Alasan kedua: tugas yang berbeda memerlukan model yang berbeda.** Penyusunan draf cepat dan reasoning berat belum tentu model yang sama. Pemisahan membuat Anda dapat berganti per tugas alih-alih memelihara Agent terpisah, dengan memori terpisah, untuk setiap jenis pekerjaan.

**Alasan ketiga: ketersediaan penyedia tidak pernah dijamin.** Ketika penyedia menerapkan rate limit, bermasalah, atau mengubah kebijakan, Anda perlu segera berpindah ke model terkonfigurasi lain. Jika memori terikat pada model, penggantian itu akan membawa biaya yang tak dapat diterima.

**Alasan keempat: kepemilikan menjadi tak ambigu.** Karena memori dan skill hidup di file serta direktori independen, keduanya adalah **aset Anda** alih-alih pelengkap dari satu model tertentu. Inilah yang pertama-tama membuat frasa "melatih Agent Anda sendiri" menjadi bermakna.

---

## 5. Apa yang sebenarnya terjadi ketika Anda mengganti model di LightVela

Bagian di atas menjelaskan mekanismenya. Bagian ini menjelaskan perilaku produk yang sebenarnya.

**Satu Agent memakai tepat satu model aktif pada satu waktu.** Mengganti berarti memilih model terkonfigurasi mana yang aktif saat ini — ini tidak membuat Agent baru. Anda tidak perlu beberapa Agent hanya untuk memakai beberapa model.

**Mengganti tidak menghapus memori, file cloud storage, skill, maupun pengaturan tugas terjadwal.** Penggantian model hanya mengubah mesin yang dipakai untuk balasan berikutnya. Ia tidak memindahkan riwayat chat, tidak menulis ulang file di cloud storage, dan tidak mengubah konfigurasi skill serta tugas terjadwal.

**Mempersiapkan dan mengonfirmasi penggantian**, mengikuti alur yang terdokumentasi:

1. Pastikan model tujuan sudah dikonfigurasi dan tersedia untuk akun Anda. Jika belum dikonfigurasi, selesaikan konfigurasi model terlebih dahulu.
2. Siapkan pesan uji singkat untuk memastikan model baru membalas normal.
3. Setelah berganti, kirim pesan uji itu di chat lalu pastikan Agent membalas dan konsol menampilkan model yang Anda pilih.
4. Jika balasan pertama setelah penggantian sedikit lambat, tunggu sebentar lalu coba sekali lagi sebelum mengubah apa pun.

**Satu koreksi atas miskonsepsi umum**: konfigurasi sebuah tugas terjadwal terdiri dari nama, jadwal (hari tetap dalam seminggu, interval tetap, atau sekali jalan — pilih salah satu), instruksi tugas, jendela waktu aktif, dan kanal notifikasi. **Tidak ada kolom "sematkan tugas terjadwal ini ke model tertentu".** Jadi saran bahwa Anda harus menelusuri tugas terjadwal Anda lalu menyinkronkan ulang modelnya setelah penggantian tidak berlaku. Yang layak ditinjau setelah penggantian adalah kualitas keluaran tugas, bukan kolom model yang tidak ada.

---

## 6. Mengapa setelahnya "terasa berbeda"

Ini langkah yang paling sering salah didiagnosis sebagai amnesia. Perubahan perilaku dan kehilangan data adalah masalah yang berbeda, dan mencampurnya membawa Anda ke jalur debugging yang salah.

Model memang berbeda pada dimensi-dimensi ini:

| Dimensi | Bagaimana ia tampak | Umumnya disalahartikan sebagai |
|---|---|---|
| Mengikuti instruksi | Menerapkan batasan `SOUL.md` lebih longgar atau lebih ketat | "Kepribadiannya berubah" |
| Kompresi konteks | Lebih sedikit menyodorkan informasi latar belakang | "Ia melupakan apa yang kita bahas" |
| Preferensi panjang jawaban | Menjawab jauh lebih pendek atau lebih panjang | "Ia jadi lebih bodoh / lebih bertele-tele" |
| Kecenderungan pemanggilan tool | Lebih sering atau lebih jarang membaca file atau mencari secara proaktif | "Ia berhenti memakai tool" |
| Gaya bahasa | Pilihan kata, sapaan, dan nada yang berbeda | "Ia menjadi orang lain" |

Ujinya sederhana: **tanyakan fakta yang Anda yakin seharusnya ia ketahui.** Jika sebelumnya Anda memberitahunya nama proyek atau preferensi tertentu, tanyakan persis itu setelah penggantian. Jika ia menjawab dengan benar, lapisan memori utuh dan yang Anda lihat adalah perbedaan gaya. Jika ia benar-benar tidak dapat menjawab, baru periksa apakah file dan entri memorinya masih ada.

Aturan praktis: **ubah satu faktor pada satu waktu, dan uji setelah tiap perubahan.** Mengganti model, menyunting persona, dan menambahkan skill secara bersamaan membuat Anda tidak dapat mengetahui lapisan mana yang menyebabkan masalah.

---

## 7. Kapan mengganti model itu berharga

Memilih berdasarkan kebutuhan lebih berguna daripada mengejar model mana pun yang saat ini disebut paling kuat.

| Kebutuhan Anda | Pendekatan yang disarankan |
|---|---|
| Draf pertama lebih cepat | Pilih model terkonfigurasi yang cocok untuk pekerjaan singkat dan rutin |
| Reasoning atau bantuan kode lebih kuat | Pilih model yang Anda konfigurasikan untuk jenis pekerjaan itu |
| Sebuah penyedia tidak tersedia atau terkena rate limit | Ganti ke model terkonfigurasi lain lalu uji di chat |
| Membandingkan kualitas keluaran | Pakai pesan uji singkat yang sama setelah tiap penggantian, lalu bandingkan |

Jika Agent tidak dapat bekerja setelah penggantian, telusuri masalahnya dengan urutan ini: pastikan kredensial dan pengaturan penyedia model tujuan lengkap → pastikan model tersedia untuk akun Anda dengan kuota memadai → uji dengan model yang sudah pasti berfungsi → jika masih gagal, periksa log terbaru di Diagnostik.

---

## 8. Pendekatan LightVela: model sebagai pilihan, aset tetap milik pengguna

Hermes memisahkan model dari Agent pada tingkat mekanisme, tetapi ia masih menyasar orang yang nyaman mengelola file Markdown dan lingkungan lokal secara langsung. Arah LightVela adalah menjadikan pemisahan itu sebagai pengalaman produk default:

- **Model adalah pengaturan yang dapat diganti**, bukan keputusan sekali jalan yang terkunci saat penyiapan.
- **Memori, skill, cloud storage, dan tugas terjadwal adalah aset pengguna** yang tetap stabil melewati penggantian model, sehingga meningkatkan versi tidak pernah berarti memulai dari awal.
- **Penggantian dapat diverifikasi**: konsol menampilkan model aktif, dan satu pesan uji di chat memastikan penggantiannya berhasil.
- **Kegagalan dapat dilacak**: Diagnostik menyimpan log terbaru, dan itulah cara Anda mengetahui apakah masalahnya ada pada model, konfigurasinya, atau tugas itu sendiri.

Hasilnya, kemajuan model menjangkau Anda secara langsung, sementara apa yang sudah Anda kumpulkan tidak pernah menjadi harga dari kemajuan tersebut.

---

## Poin penting

- Sebuah Agent memiliki setidaknya tiga lapisan: **lapisan model** yang dapat diganti, **runtime** yang berjalan lama, dan **aset jangka panjang** yang terus terkumpul.
- Lapisan model menangani interpretasi, perencanaan, pemanggilan tool, dan ekspresi untuk giliran saat ini. Ia tidak menyimpan preferensi, menjalankan jadwal, atau mengelola kanal.
- `SOUL.md`, `USER.md`, `MEMORY.md`, `memories/`, `skills/`, dan direktori kerja semuanya hidup di luar model, sehingga mengganti model tidak membawanya serta.
- Di LightVela, satu Agent memiliki satu model aktif pada satu waktu; mengganti tidak menghapus memori, cloud storage, skill, maupun tugas terjadwal.
- Tugas Terjadwal tidak memiliki pengaturan "model yang disematkan", sehingga klaim bahwa Anda harus menyinkronkan ulang model tugas terjadwal setelah penggantian tidak akurat.
- Rasa berbeda setelah penggantian biasanya berasal dari perbedaan dalam mengikuti instruksi, mengompresi konteks, dan menyusun kalimat — bukan memori yang hilang. Verifikasi dengan satu fakta yang sudah Anda ketahui.
