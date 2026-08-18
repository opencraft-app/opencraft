## Ringkasan

**File milik Hermes Agent bukan satu folder yang berantakan. File tersebut termasuk di tiga tempat dengan tanggung jawab yang berbeda. Direktori kerja memegang input, output, dan eksekusi tool untuk tugas saat ini, dan ia memiliki batas yang nyata — tool tidak dapat berkeliaran melampaui workspace ke jalur sistem sembarangan. File konteks (`SOUL.md`, `USER.md`, `MEMORY.md`) bukan lampiran biasa; keduanya adalah kesepakatan jangka panjang yang membentuk cara Agent memahami relasi dan pekerjaannya. Cloud storage adalah ruang kerja file milik Agent untuk material dan output tugas: unggah dan unduh per file mendukung hingga 1 GB, menghapus hanya mengeluarkan salinan yang di-hosting di cloud storage Agent tersebut dan tidak pernah menyentuh file asli di komputer Anda, dan file satu Agent tidak otomatis tersedia untuk Agent lain. Nilai praktis dari memisahkan ketiganya adalah Anda selalu tahu di mana sebuah dokumen berada, siapa yang dapat membacanya, dan berapa lama ia bertahan — yang menjaga rahasia tetap keluar dari konteks jangka panjang dan menjaga material penting tidak hanya ada di dalam satu log chat.**

---

## Tempat file berada menentukan apakah Agent dapat melanjutkan dari tempat ia berhenti

Bayangkan kegagalan yang umum. Anda menempelkan ringkasan proyek ke dalam chat, meminta Agent menyarikan poin kuncinya, dan ia bekerja dengan baik. Tiga hari kemudian Anda kembali: "berdasarkan ringkasan itu, susun jadwalnya." Jadwal yang ia hasilkan jelas tidak sesuai — karena ringkasan tersebut hanya pernah ada di dalam percakapan tiga hari lalu, bukan di lokasi yang dapat diambil kembali secara andal.

Sekarang bayangkan kegagalan kedua. Untuk membantu Agent "mengingat" penyiapan server Anda, Anda menuliskan blok konfigurasi yang memuat kunci rahasia ke dalam file konteks jangka panjang. Sejak itu, blok tersebut dibaca sebagai latar belakang di setiap sesi. Ini bukan pemakaian memori yang dimaksudkan; ini paparan data sensitif jangka panjang yang tidak perlu.

Keduanya mengarah ke persoalan yang sama: **tempat sebuah file berada bukan soal preferensi kerapian. Ia menentukan apakah material dapat diambil dengan andal, siapa yang membacanya, dan berapa lama ia bertahan.** Artikel ini menjabarkan ketiga lokasi tersebut dan batas masing-masing.

---

## 1. Tiga lokasi, tiga tanggung jawab

Mulai dari gambaran keseluruhannya.

| Lokasi | Apa yang dimuatnya | Siapa yang membacanya | Siklus hidup |
|---|---|---|---|
| **Direktori kerja** | Input tugas saat ini, output, artefak eksekusi tool | Tool dan eksekusi selama tugas ini | Bercakupan tugas, berumur lebih pendek |
| **File konteks** | `SOUL.md`, `USER.md`, `MEMORY.md` | Kesepakatan jangka panjang yang dibaca setiap sesi | Jangka panjang, dipelihara aktif |
| **Cloud storage** | Material tugas, dokumen referensi, output yang layak disimpan | Anda atau Agent, sesuai kebutuhan | Jangka panjang; dapat diunduh, diganti nama, dihapus |

Pasangan yang paling sering tertukar adalah **file konteks dan cloud storage**. Keduanya bertahan, tetapi keduanya dibaca dengan cara yang sama sekali berbeda: file konteks adalah latar belakang yang tinggal di memori aktif untuk setiap sesi, sementara file cloud storage adalah material yang diambil ketika dibutuhkan dan tidak pernah otomatis disuntikkan ke setiap percakapan.

Pembedaan itu langsung menentukan bagaimana informasi sensitif seharusnya ditangani — dibahas di bawah.

---

## 2. Direktori kerja: tempat pekerjaan terjadi, dan tempat batasnya berada

Direktori kerja melayani input, output, dan eksekusi tool untuk tugas saat ini. Ia punya dua sifat penentu.

**Pertama, ia adalah lokasi kerja.** Membaca file, menulis file, menjalankan perintah, dan menghasilkan artefak semuanya terjadi di sini. Agent yang benar-benar dapat melanjutkan pekerjaan memerlukan status perantara yang bertahan di sini alih-alih memulai dari nol setiap kali.

**Kedua, ia punya batas yang jelas.** Tool tidak dapat menjangkau melampaui workspace ke jalur sistem sembarangan. Pembatasan itu bukan kemampuan yang hilang; itu prasyarat yang membuat baca/tulis file sekaligus dapat dipakai dan dapat dikendalikan. Agent dengan baca/tulis tanpa batas di seluruh sistem file mengubah satu kesalahan penilaian menjadi hasil yang berpotensi tak dapat dibalik.

Memahami batas ini punya konsekuensi praktis: ketika Anda ingin Agent memproses sebuah dokumen, taruh dokumen tersebut di tempat yang dapat ia akses alih-alih mengharapkannya menelusuri direktori sembarangan di mesin Anda.

---

## 3. File konteks: bukan lampiran, melainkan kesepakatan jangka panjang

Ketiga file ini sering disalahpahami sebagai "material yang saya unggah ke Agent." Perannya sama sekali berbeda — ketiganya menentukan bagaimana Agent memahami relasi ini dan pekerjaan ini.

| File | Peran utama | Konten tipikal |
|---|---|---|
| `SOUL.md` | Peran, nada, batas perilaku | Kesimpulan sebelum penalaran; tidak ada saran investasi |
| `USER.md` | Preferensi dan profil pengguna yang stabil | Lebih suka bahasa Inggris; pertahankan terminologi apa adanya |
| `MEMORY.md` | Fakta lintas sesi, status proyek, keputusan | Nama proyek; keputusan pekan lalu |

Tiga cara ketiganya berbeda dari material yang diunggah:

**Perbedaan satu: waktu pembacaan.** File konteks adalah latar belakang yang tinggal di memori aktif dan dipakai setiap sesi; file cloud storage diambil hanya ketika dibutuhkan.

**Perbedaan dua: bentuk konten.** File konteks cocok untuk aturan, preferensi, dan entri fakta yang stabil — bukan blok besar material mentah. Mendorong ringkasan sepuluh halaman ke `MEMORY.md` hanya membebani setiap sesi berikutnya.

**Perbedaan tiga: tuntutan sensitivitas.** Karena ketiganya tinggal di memori aktif, **jangan menuliskan kata sandi, kunci, atau informasi sensitif yang tidak perlu ke dalam file konteks jangka panjang.** Ketika Agent harus menangani konfigurasi sensitif, sediakan melalui jalur terkendali lalu bersihkan setelahnya alih-alih meninggalkannya di latar belakang tanpa batas waktu.

Poin ketiga itu adalah aturan praktis paling penting di artikel ini.

Untuk bagaimana ketiga file konteks itu bersama-sama membentuk perilaku, lihat "Dari Mana Kepribadian Hermes Agent Berasal: Persona, Preferensi, dan Memori Jangka Panjang."

---

## 4. Cloud storage: ruang kerja file milik Agent

Cloud storage diposisikan sebagai ruang kerja file milik Agent: simpan material tugas di satu tempat, unggah dan tata file, atau unduh yang Anda perlukan secara lokal — semuanya dari konsol.

### 4.1 Kapan memakainya

Pakai cloud storage kapan pun Agent membutuhkan material referensi, dokumen kerja, atau tempat yang jelas untuk menyimpan output — alih-alih bersandar pada penempelan sekali pakai ke chat. Dua pola tipikal:

- **Unggah dulu, lalu proses** — unggah ringkasan proyek, lalu minta Agent menyarikan poin kuncinya. Materialnya tetap tersedia untuk referensi nanti.
- **Buat folder untuk pekerjaan yang berulang** — beri folder untuk pekerjaan yang sedang berjalan lalu pelihara, sehingga output punya rumah yang stabil.

### 4.2 Batasan konkret yang perlu diketahui

Ini fakta yang perlu Anda tetapkan sebelum mengandalkannya:

- **Unggah dan unduh per file mendukung hingga 1 GB.** Apa pun yang lebih besar perlu dipecah atau dikompresi lebih dulu.
- **Menghapus hanya mengeluarkan salinan yang di-hosting di cloud storage Agent tersebut**, tidak pernah file asli di komputer Anda. Meski begitu, unduh apa pun yang mungkin masih Anda perlukan sebelum menghapus — salinan yang di-hosting hilang begitu dikeluarkan.
- **File satu Agent tidak otomatis tersedia untuk Agent lain.** Memindahkan material antar Agent memerlukan tindakan eksplisit; jangan mengasumsikan adanya area file bersama.
- **Biarkan halaman tetap terbuka saat mengunggah**, tunggu sampai selesai, dan pastikan file tersebut muncul di folder saat ini sebelum melakukan apa pun.

### 4.3 Struktur folder tidak perlu rumit

Rekomendasi praktis: hierarki kompleks biasanya tidak perlu. Tiga folder — material, sedang berjalan, selesai — menangani sebagian besar situasi. Tambahkan kedalaman hanya ketika itu benar-benar mempercepat Anda menemukan sesuatu.

Satu uji untuk menilai apakah sebuah struktur sehat: **apakah nama folder memperjelas material itu termasuk tugas yang mana?** Jika Anda harus membuka sebuah folder untuk mengingat isinya, namanya sudah gagal — dan Agent bersandar pada nama yang sama itu untuk menilai material tersebut untuk apa.

---

## 5. Dokumen ini seharusnya ke mana? Sebuah jalur keputusan

Menghadapi dokumen tertentu, telusuri pertanyaan berikut secara berurutan.

**Pertanyaan satu: apakah ia sebuah aturan, preferensi, atau entri fakta?**
Ya → file konteks. Aturan ke `SOUL.md`, preferensi ke `USER.md`, fakta ke `MEMORY.md`. Simpan kesimpulan yang sudah disarikan, bukan teks sumber mentahnya.

**Pertanyaan dua: apakah ia material atau output yang layak disimpan dan mungkin akan dirujuk berulang kali?**
Ya → cloud storage. Unggah ke folder yang sesuai dengan nama yang menjelaskan tujuannya.

**Pertanyaan tiga: apakah ia hanya melayani satu tugas ini?**
Ya → tangani di direktori kerja; tidak perlu penyimpanan jangka panjang.

**Pertanyaan empat: apakah ia memuat kata sandi, kunci, atau informasi pribadi yang sensitif?**
Ya → **jauhkan dari file konteks jangka panjang.** Sediakan melalui jalur terkendali lalu bersihkan ketika tugasnya berakhir.

Nilai jalur ini adalah mengubah "taruh di mana saja" menjadi pilihan yang beralasan. Sebagian besar hambatan sehari-hari berasal dari mencampurkan pertanyaan satu dan dua — mendorong material dalam jumlah besar ke file konteks, atau meninggalkan material yang layak disimpan di dalam log chat.

---

## 6. Gejala umum dan tempat mencarinya

| Gejala | Penyebab yang lebih mungkin | Tindakan yang disarankan |
|---|---|---|
| Agent tidak dapat menemukan material yang Anda bagikan sebelumnya | Ia hanya ada di riwayat chat, tidak pernah dipertahankan | Unggah ke cloud storage, lalu rujuk |
| Unggah atau unduh gagal | File melebihi 1 GB, atau Anda meninggalkan halaman di tengah unggahan | Periksa ukurannya; unggah ulang lalu biarkan halaman terbuka |
| File "hilang" setelah pindah ke Agent lain | File milik penyimpanan Agent asalnya dan tidak dibagikan | Unduh dari yang asal, lalu unggah ke yang baru |
| Khawatir menghapus file cloud juga menghapus yang lokal | Salah paham soal cakupan penghapusan | Menghapus hanya memengaruhi salinan yang di-hosting, bukan file asli lokal Anda |
| Setiap sesi terasa berat dan lambat | Material mentah dalam jumlah besar didorong ke file konteks jangka panjang | Pindahkan keluar dari file konteks ke cloud storage |
| Khawatir soal paparan rahasia jangka panjang | Kunci atau kata sandi tertulis ke file konteks | Segera hapus; sediakan lewat jalur terkendali sebagai gantinya |

Dua baris terakhir adalah dua sisi dari kesalahan yang sama: **memperlakukan file konteks sebagai gudang dokumen.** Ujinya sederhana — jika sebuah konten tidak perlu dibaca di setiap sesi, ia tidak termasuk di file konteks.

---

## 7. Pendekatan LightVela: membuat lokasi terlihat dan terkendali

Hermes membedakan direktori kerja dari file konteks pada tingkat mekanisme, tetapi meng-hosting dan mengambil material tetap diatur oleh operatornya. Arah LightVela adalah menjadikan ruang kerja file sebagai kemampuan produk yang terlihat dan terkendali:

- **Ruang kerja file yang terkonsolidasi** — unggah, buat, tata, unduh, ganti nama, dan hapus dari konsol tanpa meninggalkan produk.
- **Batas yang eksplisit** — direktori kerja punya batas, dan tool tidak menjangkau melampaui workspace ke jalur sistem sembarangan.
- **Semantik penghapusan yang jelas** — menghapus hanya mengeluarkan salinan yang di-hosting di penyimpanan Agent tersebut, membiarkan file asli lokal tak tersentuh, dan meminta Anda mengunduh lebih dulu.
- **Isolasi antar Agent** — area file terpisah per Agent, sehingga material tidak bocor ke tempat yang seharusnya tidak dibagikan.
- **Terpisah dari kemampuan lain** — mengganti model tidak menulis ulang file di cloud storage.

---

## Poin penting

- Tiga lokasi, tiga peran: **direktori kerja** (lokasi kerja yang berbatas), **file konteks** (kesepakatan jangka panjang yang tinggal di memori aktif), **cloud storage** (material dan output yang diambil sesuai kebutuhan).
- File konteks dan cloud storage berbeda dalam waktu pembacaan: yang pertama tinggal di memori aktif setiap sesi, yang kedua sesuai kebutuhan.
- Fakta cloud storage: batas unggah/unduh **1 GB** per file; menghapus hanya mengeluarkan salinan yang di-hosting; **file satu Agent tidak otomatis tersedia untuk Agent lain**.
- Struktur folder tetap sederhana — material / sedang berjalan / selesai biasanya sudah cukup, dengan nama yang menjelaskan tujuannya.
- Satu aturan yang harus dipegang: **jangan pernah menuliskan kata sandi, kunci, atau informasi sensitif yang tidak perlu ke dalam file konteks jangka panjang.**
- Ketika sesi terasa berat atau lambat, periksa dulu apakah material dalam jumlah besar didorong ke file konteks.
