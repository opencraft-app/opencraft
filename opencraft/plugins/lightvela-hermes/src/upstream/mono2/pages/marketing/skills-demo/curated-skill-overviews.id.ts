// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type { CuratedSkillOverview } from "./curated-skill-overviews";

/**
 * 精选 Skill 概览 · 印尼语（id-ID）
 * ──────────────────────────────────────────────
 * 与 `curated-skill-overviews.zh.ts` 结构一致，以中文版为翻译源（其条目最全）。
 *
 * 增量策略：本文件允许只覆盖部分 Skill。`getCuratedSkillOverview()` 对
 * 未收录的 rawId 会回退英文版，因此可以分批补充而不影响页面可用性。
 *
 * 术语约定（与 src/i18n/generated/id-ID.json 保持一致）：
 *   Agent / Skill / Hermes / LightVela / Persona / Markdown 等专有名词保留原文；
 *   credit → kredit；memory → memori；workflow → alur kerja。
 */

type BulletPair = [string, string];

const bullets = (rows: BulletPair[]) => rows.map(([title, description]) => ({ title, description }));

const makeOverview = (
  overview: [string, string],
  whoShouldUse: BulletPair[],
  problemsItSolves: BulletPair[],
  keyCapabilities: BulletPair[],
  basicUsage: string,
  examplePrompt: string,
): CuratedSkillOverview => ({
  overview,
  whoShouldUse: bullets(whoShouldUse),
  problemsItSolves: bullets(problemsItSolves),
  keyCapabilities: bullets(keyCapabilities),
  basicUsage,
  examplePrompt,
});

export const CURATED_SKILL_OVERVIEWS_ID: Readonly<Record<string, CuratedSkillOverview>> = {
  "mattpocock/skills/teach": makeOverview(
    [
      "Teach mengubah satu topik menjadi ruang kerja pembelajaran yang terus bertumbuh, dengan pelajaran singkat dan mandiri yang berlanjut antar-sesi.",
      "Berikan alasan belajar, topik, serta preferensi atau batasan. Skill ini mendasarkan pelajaran pada sumber tepercaya, menambahkan sitasi, dan memakai latihan mengingat agar kemajuan tidak dimulai ulang setiap kali.",
    ],
    [["Pembelajar jangka panjang", "Menginginkan kursus yang berlanjut di beberapa sesi, bukan penjelasan satu kali."], ["Anggota tim baru", "Memerlukan cara terstruktur untuk mempelajari codebase, framework, proses, atau domain."], ["Pembelajar yang suka praktik", "Menginginkan pelajaran singkat, praktik, dan catatan atas penguasaan yang telah dibuktikan."]],
    [["Belajar yang terpencar", "Menyimpan misi, sumber, pelajaran, dan catatan pembelajaran dalam satu ruang kerja."], ["Penjelasan tanpa dasar", "Mendorong penggunaan sumber tepercaya dan sitasi sebelum pelajaran ditulis."], ["Lancar tetapi tidak melekat", "Menggunakan latihan mengingat, jeda, dan umpan balik untuk membantu retensi jangka panjang."]],
    [["Ruang kerja berkelanjutan", "Memelihara misi, sumber, pelajaran, referensi, dan catatan pembelajaran antar-sesi."], ["Pelajaran berbasis sumber", "Menyusun pelajaran dari sumber yang diteliti dan menghubungkan klaim kembali ke sumbernya."], ["Praktik interaktif", "Menggunakan kuis atau langkah dunia nyata dengan umpan balik agar pembelajaran lebih tahan lama."], ["Progres adaptif", "Memakai misi dan catatan pembelajaran untuk memilih pelajaran berikutnya dengan tingkat tantangan yang tepat."]],
    "Jalankan Teach dalam ruang kerja belajar khusus, jelaskan apa yang ingin dipelajari dan alasannya, lalu lanjutkan dengan prompt seperti pelajaran berikutnya. Pisahkan ruang kerja ini dari repositori produk agar kursus dapat berkembang dengan aman.",
    "Ajari saya dasar-dasar codebase ini melalui beberapa pelajaran singkat. Mulailah dengan mewawancarai misi saya, kumpulkan sumber tepercaya, dan jangan tulis pelajaran pertama sebelum sumber dicatat.",
  ),
  "mattpocock/skills/grill-me": makeOverview(
    [
      "Grill Me mengubah rencana atau desain awal menjadi wawancara terfokus yang mengungkap asumsi, keputusan yang belum ada, dan risiko sebelum implementasi.",
      "Berikan rencana, desain, atau ide lalu minta untuk ditanya secara mendalam. Pertanyaannya bertujuan menajamkan pemikiran Anda, bukan menggantikan keputusan Anda, jadi jawab setiap pertanyaan dan gunakan celah yang ditemukan untuk memperbaiki rencana.",
    ],
    [["Pembuat produk", "Ingin menguji ketahanan sebuah ide sebelum berinvestasi pada implementasi."], ["Peninjau desain dan arsitektur", "Memerlukan cara terstruktur untuk menemukan keputusan yang hilang dan kasus tepi."], ["Tim yang menyiapkan eksekusi", "Menginginkan pemahaman bersama sebelum rencana menjadi pekerjaan."]],
    [["Asumsi yang tidak diucapkan", "Memunculkan keputusan yang tersirat dalam rencana saat ini."], ["Penemuan terlambat", "Menemukan kasus tepi dan pertanyaan yang belum terjawab sebelum menjadi pengerjaan ulang mahal."], ["Kepercayaan diri semu", "Membuat rencana layak disetujui melalui jawaban jelas, bukan hanya momentum."]],
    [["Pertanyaan sistematis", "Mewawancarai rencana pada dimensi produk, desain, dan implementasi yang penting."], ["Kedalaman pohon keputusan", "Mengikuti jawaban ke cabang relevan berikutnya, bukan berhenti pada pertanyaan permukaan."], ["Kesadaran codebase", "Dapat menggunakan konteks kode yang tersedia untuk menjawab pertanyaan dan mengurangi bolak-balik."], ["Validasi pra-pengembangan", "Menciptakan pemahaman bersama yang lebih jelas sebelum implementasi dimulai."]],
    "Panggil Grill Me dengan rencana atau desain yang ingin diasah. Jawab pertanyaan secara langsung, catat keputusan yang berubah, dan revisi rencana sebelum meminta implementasi.",
    "Grill saya tentang rencana ini. Ajukan satu pertanyaan terfokus setiap kali, ikuti jawaban penting ke cabang keputusan berikutnya, dan teruskan sampai cakupan, risiko, dan kriteria penerimaan jelas.",
  ),
  "flowkit-labs/skills/reddit-automation": makeOverview(
    [
      "Reddit Automation membantu menemukan diskusi Reddit tempat produk benar-benar dapat membantu dan menyusun balasan yang berguna untuk ditinjau manusia.",
      "Berikan konteks produk, audiens, dan apa yang dapat Anda tawarkan secara jujur. Skill ini berfokus pada sejumlah kecil utas relevan, mengharuskan pengungkapan afiliasi secara transparan, dan mempertahankan keputusan akhir untuk meninjau serta memposting pada pengguna.",
    ],
    [["Pendiri dan pemasar", "Ingin menemukan percakapan Reddit yang relevan tanpa menjadikan outreach sebagai spam."], ["Developer advocate", "Memerlukan cara yang dapat diulang untuk menemukan pertanyaan yang layak dijawab dengan baik."], ["Tim yang berorientasi komunitas", "Ingin partisipasi produk tetap jujur, membantu, dan dapat ditinjau."]],
    [["Menemukan utas yang tepat", "Menyaring komunitas luas menjadi percakapan tempat produk benar-benar dapat menjawab pertanyaan."], ["Promosi bernilai rendah", "Menjaga alur kerja tetap berpusat pada kontribusi nyata dan pengungkapan yang jelas."], ["Beban menyusun balasan", "Mengubah utas relevan menjadi draf balasan berguna yang dapat ditinjau sebelum diposting."]],
    [["Penemuan peluang", "Menemukan pertanyaan dan diskusi Reddit terbaru yang sesuai dengan konteks produk."], ["Penyusunan balasan yang membantu", "Membuat balasan yang menjawab pertanyaan sebelum menyebut produk jika relevan."], ["Partisipasi transparan", "Mendorong pengungkapan afiliasi secara jujur dan menghindari promosi tersembunyi."], ["Gerbang tinjauan manusia", "Menjaga pengguna tetap mengendalikan apa yang diposting dan di mana."]],
    "Berikan konteks produk, komunitas atau ruang masalah yang ingin dicari, serta rentang waktu. Tinjau setiap utas dan draf yang disarankan, ungkapkan afiliasi Anda, dan posting hanya ketika balasan benar-benar membantu.",
    "Temukan utas Reddit minggu ini tempat produk kami benar-benar dapat membantu. Untuk setiap kandidat, jelaskan relevansinya, susun balasan berguna dengan pengungkapan afiliasi yang transparan, dan tunggu tinjauan saya sebelum apa pun diposting.",
  ),
  "charon-fan/agent-playbook/self-improving-agent": makeOverview(
    [
      "Self-Improving Agent membantu Agent belajar dari hasil eksekusi skill, kesalahan, dan umpan balik, sehingga alur kerja berulang dapat terus membaik.",
      "Berikan konteks eksekusi kali ini, hasilnya, serta koreksi yang perlu dilakukan. Informasi itu akan dirapikan menjadi panduan terverifikasi yang bisa dipakai ulang, bukan diam-diam mengubah perilaku.",
    ],
    [
      ["Pembangun Agent", "Ingin alur kerja yang dapat dipakai ulang terus belajar dari hasil eksekusi nyata."],
      ["Pemelihara alur kerja", "Perlu melacak kesalahan umum dan perbaikan skill di berbagai eksekusi."],
      ["Tim yang butuh umpan balik tertutup", "Ingin koreksi dan pola keberhasilan tetap berguna pada eksekusi berikutnya."],
    ],
    [
      ["Kesalahan berulang terus", "Mencatat kesalahan berharga dan pola koreksi agar tidak hilang setelah eksekusi berakhir."],
      ["Pengalaman terlupakan", "Menghubungkan riwayat eksekusi yang relevan ke penggunaan skill selanjutnya."],
      ["Saran belum terverifikasi", "Mendorong verifikasi dan pemeriksaan sebelum perbaikan dipakai ulang."],
    ],
    [
      ["Memori eksekusi", "Merapikan pengalaman skill yang selesai, gagal, maupun dikoreksi."],
      ["Hook siklus hidup", "Mendukung pembelajaran seputar peristiwa mulai, selesai, dan error pada skill."],
      ["Koreksi mandiri", "Mengubah umpan balik menjadi kandidat perbaikan yang dapat diperiksa."],
      ["Evolusi yang terlacak", "Menjaga kaitan antara perubahan dengan pengalaman eksekusi dan konteks skill yang melahirkannya."],
    ],
    "Pasang dan aktifkan alur kerja ini, lalu lanjutkan memakai skill harian Anda. Ketika eksekusi berhasil, gagal, atau perlu dikoreksi, berikan hasil dan umpan baliknya agar Agent dapat menilai perbaikan untuk eksekusi berikutnya.",
    "Tinjau eksekusi skill yang gagal ini, temukan pengalaman yang dapat dipakai ulang, jelaskan cara memverifikasinya, dan ajukan perbaikan dengan cakupan yang jelas untuk eksekusi berikutnya.",
  ),
  "vercel-labs/skills/find-skills": makeOverview(
    [
      "Find Skills membantu Agent menemukan skill khusus yang tepat ketika kemampuan tertentu belum tersedia di lingkungan saat ini.",
      "Setelah Anda menjelaskan tugas, bidang, atau kemampuan yang kurang, skill ini akan menelusuri ekosistem skill dan mengembalikan kandidat yang relevan atau perintah pemasangannya, tanpa mengharuskan Anda tahu ID skill yang persis.",
    ],
    [
      ["Pengguna baru", "Belum familier dengan nama-nama di marketplace skill namun ingin menemukan skill yang berguna."],
      ["Agent dengan kemampuan terbatas", "Perlu menemukan kemampuan yang belum terpasang di lingkungan saat ini."],
      ["Pemelihara skill", "Perlu cara yang konsisten untuk membandingkan dan merekomendasikan skill yang tersedia."],
    ],
    [
      ["Tidak tahu nama skill-nya", "Menelusuri berdasarkan pekerjaan yang ingin diselesaikan, bukan hanya judul yang persis."],
      ["Kandidat terlalu banyak", "Menyaring hasil marketplace yang luas menjadi daftar kandidat yang lebih berguna."],
      ["Proses pencarian manual", "Membuat jalur dari permintaan tugas ke kandidat pemasangan menjadi lebih langsung."],
    ],
    [
      ["Pencarian berbasis tugas", "Menemukan skill berdasarkan deskripsi tugas, bidang, atau kemampuan."],
      ["Sinyal marketplace", "Membandingkan hasil dengan mempertimbangkan sinyal seperti jumlah pemasangan, bintang, dan reputasi sumber."],
      ["Panduan pemasangan", "Mengembalikan identitas skill beserta perintah yang dibutuhkan untuk menambahkannya."],
      ["Alur pencarian yang dapat dipakai ulang", "Setiap kali tugas baru membutuhkan skill, proses yang sama dapat dipakai untuk menemukan kandidatnya."],
    ],
    "Beri tahu Agent apa yang perlu Anda selesaikan, lalu tambahkan bidang atau batasannya. Setelah melihat kandidat hasilnya, pasang skill yang paling sesuai dengan tugas Anda.",
    "Temukan skill yang dapat membandingkan halaman harga pesaing, mengambil perubahan penting, dan menghasilkan ringkasan mingguan.",
  ),
  "steipete/clawdis/weather": makeOverview(
    [
      "Weather membantu Agent menjawab pertanyaan tentang cuaca terkini dan prakiraan untuk lokasi tertentu, cocok untuk perjalanan, penjadwalan, atau perencanaan aktivitas luar ruang.",
      "Berikan kota, wilayah, bandara, atau koordinat, lalu sebutkan rentang waktu yang Anda perhatikan. Skill ini akan membantu mengembalikan kondisi terkini, suhu, dan informasi curah hujan, beserta konteks prakiraan yang tersedia.",
    ],
    [
      ["Pelancong", "Butuh acuan cuaca sebelum memilih tanggal, rute, atau aktivitas."],
      ["Perencana jadwal", "Ingin memperoleh prakiraan lokal dengan cepat dalam satu percakapan."],
      ["Agent yang menangani tugas berbasis lokasi", "Perlu menjadikan pencarian cuaca sebagai satu langkah dalam alur perjalanan atau pengingat."],
    ],
    [
      ["Harus cek cuaca terpisah", "Menjawab pertanyaan prakiraan tanpa berpindah ke tool cuaca lain."],
      ["Lokasi tidak jelas", "Mengurangi kekeliruan antar-lokasi bernama sama melalui masukan lokasi yang lebih presisi."],
      ["Perencanaan tanpa konteks cuaca", "Mengaitkan kondisi cuaca dengan tanggal, aktivitas, atau keputusan perjalanan."],
    ],
    [
      ["Cuaca terkini", "Mengembalikan kondisi cuaca saat ini untuk lokasi yang ditentukan."],
      ["Curah hujan dan suhu", "Menonjolkan kondisi nyata yang memengaruhi pilihan pakaian dan rencana."],
      ["Konteks prakiraan", "Memberikan tren cuaca mendatang bila rentang waktunya mendukung."],
      ["Pengenalan lokasi", "Mendukung penanda lokasi umum seperti kota, bandara, dan koordinat."],
    ],
    "Sebutkan lokasinya beserta tanggal atau rentang waktunya, lalu tanyakan informasi cuaca yang relevan dengan rencana Anda. Untuk perjalanan, Anda dapat menambahkan aktivitas atau rutenya.",
    "Bagaimana cuaca di Kyoto dari Jumat sampai Minggu? Sore hari mana yang paling cocok untuk jalan-jalan di luar ruangan?",
  ),
  "juliusbrussee/caveman/caveman": makeOverview(
    [
      "Caveman adalah mode komunikasi ringkas yang memangkas kalimat pengisi namun tetap mempertahankan inti teknis yang dibutuhkan agar jawaban dapat dijalankan.",
      "Skill ini dapat dipakai bersama permintaan Agent biasa, dan tingkat pemadatannya bisa ditentukan. Keluarannya lebih singkat, tetapi berusaha mempertahankan detail penting dan blok kode.",
    ],
    [
      ["Pembaca teknis", "Ingin langsung mendapat jawaban sekaligus mempertahankan detail kunci untuk implementasi."],
      ["Alur kerja yang sensitif terhadap konteks", "Perlu menekan konsumsi konteks dan perhatian membaca pada setiap balasan."],
      ["Tim yang memindai informasi dengan cepat", "Lebih menyukai kabar, keputusan, dan langkah berikutnya yang singkat."],
    ],
    [
      ["Balasan terlalu bertele-tele", "Memangkas pembukaan, penjelasan berulang, dan frasa bernilai rendah."],
      ["Keputusan terkubur", "Menempatkan jawaban inti dan langkah berikutnya lebih dekat ke awal."],
      ["Detail teknis hilang", "Mempertahankan kode dan konteks implementasi penting saat teks dipadatkan."],
    ],
    [
      ["Tingkat pemadatan", "Mendukung kendali panjang balasan dengan intensitas berbeda."],
      ["Konten teknis dipertahankan", "Memangkas kalimat pengisi namun mempertahankan blok kode dan informasi teknis inti."],
      ["Berlaku selama sesi", "Gaya komunikasi ringkas yang dipilih dapat dipertahankan selama satu sesi."],
      ["Pengecualian keamanan", "Menghindari pemadatan konteks berlebihan saat menemui ambiguitas atau isu keamanan."],
    ],
    "Setelah dipasang, sebutkan gaya balasan atau tingkat pemadatan yang Anda inginkan sesuai kebutuhan. Lanjutkan memakai prompt biasa, dan skill ini akan mengarahkan Agent memberi jawaban yang ringkas namun lengkap pada informasi yang perlu.",
    "Pakai Caveman level 4: jelaskan penyebab kegagalan deployment, akar masalah yang paling mungkin, dan tiga perintah yang harus dijalankan selanjutnya.",
  ),
  "mattpocock/skills/to-issues": makeOverview(
    [
      "To Issues mengubah rencana, spesifikasi, atau PRD menjadi sekumpulan issue yang dapat dikerjakan secara mandiri, serta menata pekerjaan di sekitar irisan vertikal.",
      "Berikan rencana aslinya beserta konteks repositori atau pengelola issue. Skill ini akan membantu memisahkan cakupan, kriteria penerimaan, keterkaitan, dan konteks yang memadai.",
    ],
    [
      ["Manajer produk", "Perlu rencana implementasi yang bisa langsung masuk ke pengelolaan issue."],
      ["Pemimpin engineering", "Ingin memecah pekerjaan menjadi irisan yang koheren, bukan daftar tugas yang kabur."],
      ["Tim pengiriman", "Perlu batasan, keterkaitan, dan kriteria penyelesaian yang jelas."],
    ],
    [
      ["Rencana terlalu kasar", "Memecah pekerjaan yang luas menjadi irisan kecil yang dapat ditinjau dan dikirimkan."],
      ["Keterkaitan tersembunyi", "Memperjelas urutan tugas dan hubungan yang saling memblokir."],
      ["Cakupan issue tidak jelas", "Melengkapi konteks dan kriteria penerimaan agar setiap issue punya garis selesai yang dapat dinilai."],
    ],
    [
      ["Pengumpulan konteks", "Memahami pekerjaan lewat rencana dan konteks proyek terlebih dahulu, baru memecahnya."],
      ["Irisan vertikal", "Menata tugas menjadi irisan koheren yang mampu memberi hasil nyata."],
      ["Definisi issue", "Menghasilkan deskripsi, kriteria penerimaan, dan keterkaitan yang siap dipakai."],
      ["Konfirmasi manual", "Menampilkan pilihan granularitas dan keterkaitan untuk ditinjau manusia sebelum dipublikasikan."],
    ],
    "Berikan rencana, PRD, atau spesifikasi, lalu sebutkan repositori atau pengelola tempat issue akan dibuat. Periksa hasil pemecahan dan keterkaitannya sebelum dipublikasikan.",
    "Pecah PRD yang sudah disetujui ini menjadi issue berupa irisan vertikal. Setiap issue harus dapat ditinjau secara mandiri, memuat kriteria penerimaan, dan tampilkan keterkaitannya sebelum dipublikasikan.",
  ),
  "roin-orca/skills/simple": makeOverview(
    [
      "Simple adalah proses curah gagasan ringan untuk memperjelas tujuan, membandingkan opsi implementasi, dan mencatat arah yang telah disetujui sebelum menulis kode.",
      "Berikan idenya, konteks pengguna, batasan, serta informasi kode atau produk yang sudah ada. Skill ini akan mengajukan pertanyaan penting, membandingkan dua opsi yang layak beserta untung-ruginya, lalu menyusun catatan keputusan singkat.",
    ],
    [
      ["Pembangun tahap awal", "Punya ide nyata, tetapi perlu memperjelas dulu apa yang paling layak dibangun."],
      ["Tim produk dan engineering", "Ingin membangun pemahaman bersama sebelum memilih arah implementasi."],
      ["Developer yang ingin menekan pekerjaan ulang", "Cenderung menjalankan proses penemuan singkat sebelum mengubah kode."],
    ],
    [
      ["Implementasi terlalu dini", "Menunda penulisan kode sebelum masalah dan hasilnya dipahami."],
      ["Kebutuhan tersembunyi", "Menemukan batasan dan kasus tepi lebih awal melalui pertanyaan terarah."],
      ["Arah melenceng", "Mencatat arah yang disetujui agar implementasi mengikuti keputusan bersama."],
    ],
    [
      ["Penemuan terfokus", "Mengganti wawancara tanpa batas dengan sedikit pertanyaan bernilai tinggi."],
      ["Perbandingan opsi", "Menyajikan dua opsi yang layak beserta untung-rugi yang jelas."],
      ["Ambang konfirmasi", "Menuntut pilihan arah yang tegas sebelum masuk ke implementasi."],
      ["Catatan keputusan", "Menyimpan cakupan terpilih dan alasannya untuk dipakai pada pembangunan selanjutnya."],
    ],
    "Jelaskan idenya, target penggunanya, dan batasan yang sudah diketahui. Jawab pertanyaan pentingnya, bandingkan opsinya, lalu tetapkan satu arah sebelum meminta implementasi.",
    "Tangani ide fitur ini dengan Simple. Ajukan maksimal tiga pertanyaan klarifikasi, berikan dua opsi implementasi beserta untung-ruginya, dan jangan menulis kode sebelum saya mengonfirmasi.",
  ),
  "gracefullight/stock-checker/stock-analysis": makeOverview(
    [
      "Stock Analysis membantu Agent menelaah saham AS, aset kripto, dan portofolio melalui proses analisis pasar yang dapat diulang.",
      "Berikan kode saham, posisi kepemilikan, pertanyaan risiko, atau horizon investasi. Masukan itu akan dirapikan menjadi arah penilaian beli, tahan, atau jual yang berdasar, sekaligus memuat sinyal dan risiko terkait.",
    ],
    [
      ["Penganalisis investasi", "Perlu analisis awal terstruktur atas saham, aset kripto, atau portofolio."],
      ["Pemelihara portofolio", "Ingin memeriksa risiko pasar secara berkala tanpa merancang ulang alur analisisnya setiap kali."],
      ["Penyiap keputusan", "Perlu meninjau sinyal, asumsi, dan risiko dengan cepat sebelum mengambil keputusan."],
    ],
    [
      ["Sinyal tersebar", "Menyatukan konteks teknis, portofolio, dan pasar dalam satu kali telaah."],
      ["Risiko tidak jelas", "Menonjolkan risiko seperti laporan keuangan, perubahan industri, dan kondisi pasar secara keseluruhan."],
      ["Tinjauan tidak konsisten", "Membandingkan kinerja aset antarwaktu dengan dimensi yang seragam."],
    ],
    [
      ["Analisis aset multidimensi", "Menelaah aset dari berbagai dimensi pasar."],
      ["Memanfaatkan konteks", "Menjelaskan hasil analisis dengan mempertimbangkan posisi kepemilikan dan konteks pasar."],
      ["Kesimpulan berarah", "Menghasilkan penilaian arah yang disertai alasan pendukung."],
      ["Pemeriksaan berulang", "Mendukung telaah berkala atas portofolio dan daftar pantauan."],
    ],
    "Berikan aset atau portofolionya, keputusan yang sedang dipertimbangkan, serta batasan seperti selera risiko atau horizon investasi.",
    "Analisis kinerja investasi NVDA untuk jangka menengah, mencakup valuasi, laporan keuangan terkini, risiko industri, lalu berikan penilaian beli, tahan, atau jual.",
  ),
  "molezzz/openclaw-stock-skill/akshare-stock": makeOverview(
    [
      "AKShare Stock adalah skill analisis saham A-share Tiongkok yang menjawab pertanyaan dalam bahasa alami berdasarkan data pasar AKShare.",
      "Berikan kode saham A-share, indeks, sektor, atau pertanyaan pasar. Skill ini dapat merapikan data waktu nyata maupun terkini, indikator teknis, fundamental, perubahan sektor, dan konteks pasar yang relevan.",
    ],
    [
      ["Investor saham A-share", "Perlu melakukan tinjauan atas satu saham maupun pasar secara umum."],
      ["Peneliti pasar", "Perlu konteks sektor, aliran dana, atau teknikal untuk menopang alur risetnya."],
      ["Penyiap transaksi", "Perlu penilaian saham A-share yang ringkas sebelum menelusuri lebih jauh."],
    ],
    [
      ["Data pasar tersebar", "Memusatkan data harga, sinyal teknis, fundamental, dan sektor."],
      ["Kurang konteks pasar Tiongkok", "Menggabungkan konsep pasar Tiongkok seperti sektor, aliran dana, dan hari perdagangan."],
      ["Hasil sulit dibaca", "Merapikan analisis yang cukup rinci menjadi ringkasan yang padat."],
    ],
    [
      ["Pengambilan data A-share", "Menelusuri informasi saham A-share dan pasar terkait."],
      ["Perutean pertanyaan", "Meneruskan berbagai pertanyaan pasar ke langkah data dan analisis yang sesuai."],
      ["Ringkasan sinyal", "Merangkum sinyal teknis, fundamental, dan sektor."],
      ["Kueri bahasa alami", "Menangani pertanyaan saham dan pasar dalam bahasa alami sehari-hari."],
    ],
    "Sebutkan saham A-share, indeks, atau sektornya, lalu jelaskan apakah Anda ingin menilai momentum, fundamental, aliran dana, atau risiko.",
    "Analisis 600519, rangkum pergerakan harga terkini, valuasi, aliran dana, posisi sektor, dan risiko utamanya.",
  ),
  "anthropics/financial-services-plugins/earnings-analysis": makeOverview(
    [
      "Earnings Analysis dipakai untuk merapikan laporan keuangan perusahaan menjadi pembaruan riset saham yang terstruktur.",
      "Berikan perusahaannya, periode laporan, data kinerja, ekspektasi sebelumnya, dan pandangan investasi Anda. Skill ini akan merapikan kinerja, bagian yang melampaui atau di bawah ekspektasi, perubahan panduan, serta dampaknya.",
    ],
    [
      ["Penganalisis laporan keuangan", "Perlu menelaah kinerja kuartalan perusahaan yang diikuti."],
      ["Tim riset", "Ingin membandingkan kinerja terhadap ekspektasi dan periode sebelumnya dengan cara yang konsisten."],
      ["Pengambil keputusan investasi", "Perlu pembaruan yang jelas sebelum menyesuaikan pandangan atau modelnya."],
    ],
    [
      ["Informasi laporan sangat padat", "Merapikan materi kinerja yang panjang menjadi pembaruan yang terfokus."],
      ["Selisih mudah terlewat", "Memisahkan hasil aktual, ekspektasi, dan panduan sebelumnya."],
      ["Dampak tidak jelas", "Menghubungkan perubahan kinerja dengan pandangan investasi semula dan pertanyaan lanjutannya."],
    ],
    [
      ["Perapian kinerja", "Menata data keuangan dan operasional kuartalan."],
      ["Pembandingan ekspektasi", "Membandingkan kinerja, panduan, dan hasil periode sebelumnya."],
      ["Identifikasi poin penting", "Menunjukkan pendorong utama, risiko, dan pertanyaan yang masih perlu dikonfirmasi."],
      ["Struktur tetap", "Menghasilkan pembaruan laporan keuangan dengan struktur yang dapat diulang."],
    ],
    "Berikan laporan keuangan atau data kuncinya, lalu lengkapi dengan ekspektasi pasar dan pandangan investasi sebelumnya bila ada.",
    "Susun pembaruan laporan keuangan berdasarkan hasil Q2 ini dan konsensus pasar, jelaskan bagian yang melampaui ekspektasi, perubahan panduan, serta faktor yang berpotensi mengubah pandangan investasi.",
  ),
  "okx/agent-skills/okx-sentiment-tracker": makeOverview(
    [
      "OKX Sentiment Tracker membantu Agent memantau berita, sentimen, sinyal sosial, dan peristiwa makro pada topik pasar kripto tertentu.",
      "Berikan token, pasangan dagang, rentang waktu, dan peristiwa yang Anda perhatikan. Skill ini akan merapikan berbagai jenis sinyal untuk membantu menilai perubahan sentimen dan kemungkinan dampaknya.",
    ],
    [
      ["Peneliti aset kripto", "Perlu melacak sentimen pasar dan berita penting."],
      ["Penyiap transaksi", "Ingin memasukkan konteks sentimen ke dalam pemeriksaan sebelum bertransaksi."],
      ["Pemantau risiko", "Perlu terus mengikuti peristiwa yang dapat mengubah penilaian pasar."],
    ],
    [
      ["Terlalu banyak derau informasi", "Menempatkan berita, sinyal sosial, dan makro dalam satu kerangka analisis."],
      ["Perubahan sentimen sulit dilacak", "Membandingkan arah sentimen dan pendorongnya antarperiode."],
      ["Dampak peristiwa tidak jelas", "Menjelaskan aset dan risiko yang berpotensi terdampak oleh suatu peristiwa."],
    ],
    [
      ["Sentimen multisumber", "Merapikan sinyal sentimen dari berita, media sosial, dan pasar."],
      ["Jendela waktu", "Mengamati perubahan berdasarkan rentang waktu yang ditentukan."],
      ["Pengaitan peristiwa", "Menghubungkan peristiwa makro dan industri dengan asetnya."],
      ["Ringkasan risiko", "Menghasilkan risiko utama yang menopang penilaian selanjutnya."],
    ],
    "Berikan token atau pasangan dagangnya, rentang waktu, serta peristiwa atau indikator yang ingin Anda pantau, lalu minta Agent merangkum sentimen dan risikonya.",
    "Lacak sentimen pasar BTC pekan ini, himpun berita, sinyal sosial, dan peristiwa makro, lalu sebutkan kemungkinan perubahan risikonya.",
  ),
  "phuryn/pm-skills/sentiment-analysis": makeOverview(
    [
      "Sentiment Analysis membantu Agent mengenali sentimen dan tema dari umpan balik pelanggan, ulasan, atau teks survei.",
      "Berikan teks aslinya, konteks sampelnya, dan dimensi yang ingin Anda perhatikan. Skill ini akan merapikan sentimen keseluruhan, sebaran tema, umpan balik representatif, dan hal yang perlu ditindaklanjuti.",
    ],
    [
      ["Manajer produk", "Perlu memahami sikap pengguna terhadap sebuah fitur atau produk."],
      ["Tim pengalaman pelanggan", "Ingin menemukan masalah utama dari umpan balik yang sangat banyak."],
      ["Analis riset", "Perlu ringkasan sentimen dan tema yang dapat dilacak."],
    ],
    [
      ["Jumlah umpan balik terlalu besar", "Memadatkan teks yang banyak menjadi pola yang dapat dibaca."],
      ["Tema terabaikan", "Memperhatikan arah sentimen sekaligus tema umpan baliknya."],
      ["Kurang petunjuk tindakan", "Menghubungkan umpan balik negatif atau yang sering muncul dengan pertanyaan lanjutannya."],
    ],
    [
      ["Klasifikasi sentimen", "Mengenali ungkapan positif, negatif, dan netral."],
      ["Ekstraksi tema", "Menyimpulkan tema dan pola utama dalam umpan balik."],
      ["Sampel representatif", "Menyimpan contoh umpan balik yang dapat menjelaskan kesimpulannya."],
      ["Saran tindakan", "Menunjukkan umpan balik yang layak ditelusuri atau ditangani lebih lanjut."],
    ],
    "Berikan teks umpan baliknya, kelompok pengguna atau rentang waktunya, lalu jelaskan cara pengelompokan dan format keluaran yang Anda butuhkan.",
    "Analisis kumpulan umpan balik pelanggan ini, kelompokkan menurut sentimen dan tema, lalu sebutkan tiga masalah teratas, kutipan aslinya, dan saran tindakan produknya.",
  ),
  "personamanagmentlayer/pcl/finance-expert": makeOverview(
    [
      "Finance Expert membantu Agent melakukan analisis terstruktur untuk perencanaan keuangan pribadi, anggaran, tabungan, dan pertanyaan investasi.",
      "Berikan pendapatan, pengeluaran, aset, utang, tujuan, dan selera risiko Anda. Skill ini akan merapikan kondisi keuangan, opsi yang layak, asumsinya, dan risiko yang perlu diperhatikan.",
    ],
    [
      ["Pengguna keuangan pribadi", "Ingin merapikan pendapatan, pengeluaran, dan tujuannya menjadi sebuah rencana."],
      ["Pemelihara anggaran", "Perlu terus memeriksa arus kas dan kemajuan tabungan."],
      ["Penyiap keputusan", "Ingin membandingkan opsi sebelum mengambil keputusan keuangan besar."],
    ],
    [
      ["Informasi keuangan tersebar", "Menempatkan anggaran, aset, dan utang dalam satu tampilan."],
      ["Tujuan sulit dijalankan", "Memecah tujuan jangka panjang menjadi langkah yang dapat dikerjakan."],
      ["Risiko terabaikan", "Memperjelas asumsi, batasan, dan hal yang perlu dikonfirmasi kepada profesional."],
    ],
    [
      ["Perapian anggaran", "Menata pendapatan, pengeluaran, dan arus kas."],
      ["Perencanaan tujuan", "Membandingkan jalur untuk tujuan menabung, melunasi utang, atau berinvestasi."],
      ["Perbandingan skenario", "Menjelaskan dampak dari berbagai opsi secara terstruktur."],
      ["Peringatan risiko", "Menunjukkan ketidakpastian dan bagian yang perlu diverifikasi lebih lanjut."],
    ],
    "Berikan data keuangan, tujuan, jangka waktu, dan selera risiko Anda, lalu jelaskan persoalan spesifik yang ingin diselesaikan.",
    "Berdasarkan pendapatan, pengeluaran tetap, utang, dan target tabungan enam bulan saya, bandingkan dua opsi anggaran dan jelaskan risikonya.",
  ),
  "coreyhaines31/marketingskills/content-strategy": makeOverview(
    [
      "Content Strategy membantu Agent merencanakan strategi konten bertolak dari tujuan bisnis, audiens, dan kanal.",
      "Berikan konteks brand, audiens sasaran, tujuan konten, aset yang sudah ada, dan kanal publikasinya. Skill ini akan membantu membentuk arah tema, pilar konten, prioritas, dan cara pengukurannya.",
    ],
    [
      ["Penanggung jawab konten", "Perlu menghubungkan pekerjaan konten dengan tujuan bisnis."],
      ["Tim pemasaran", "Ingin merencanakan tema dan ritme konten lintas kanal."],
      ["Pembangun brand", "Perlu audiens, nada, dan arah konten yang konsisten."],
    ],
    [
      ["Konten tanpa arah", "Bertolak dari tujuan dan audiens, bukan mendaftar topik secara acak."],
      ["Publikasi berulang antarkanal", "Menyesuaikan rencana konten menurut fungsi masing-masing kanal."],
      ["Hasil sulit diukur", "Menghubungkan tema konten dengan tujuan dan metrik yang dapat diamati."],
    ],
    [
      ["Penetapan audiens", "Memperjelas audiens sasaran, kebutuhannya, dan tahap pengambilan keputusannya."],
      ["Pilar konten", "Membangun struktur tema dan rubrik yang berkelanjutan."],
      ["Perencanaan kanal", "Menyusun format konten yang sesuai untuk setiap kanal."],
      ["Perancangan metrik", "Mengusulkan cara pengukuran yang terkait dengan tujuan bisnis."],
    ],
    "Berikan brand, audiens, tujuan bisnis, kanal, dan aset konten yang sudah ada, lalu minta Agent membentuk strategi kontennya.",
    "Susun strategi konten untuk produk AI yang menyasar UKM, mencakup audiens, pilar konten, prioritas kanal, dan metrik pengukurannya.",
  ),
  "coreyhaines31/marketingskills/social-content": makeOverview(
    [
      "Social Content membantu Agent merencanakan dan menulis konten media sosial yang sesuai untuk masing-masing platform.",
      "Berikan temanya, audiens, nada brand, platform, materi, dan tujuan tindakannya. Skill ini akan menghasilkan salinan yang sesuai platform, saran publikasi, dan varian konten yang dapat dipakai ulang.",
    ],
    [
      ["Pengelola media sosial", "Perlu terus memproduksi konten untuk berbagai platform."],
      ["Tim brand", "Ingin menjaga konsistensi nada brand dan tema visualnya."],
      ["Wirausaha pemasaran", "Perlu mengubah ide menjadi konten sosial siap tayang dengan cepat."],
    ],
    [
      ["Sulit menyesuaikan platform", "Menyesuaikan panjang dan gaya penyampaian menurut karakter platform."],
      ["Produksi konten lambat", "Menghasilkan beberapa versi yang dapat disunting dari satu tema."],
      ["Nada brand tidak konsisten", "Terus merujuk audiens dan arah brand selama proses pembuatan."],
    ],
    [
      ["Varian platform", "Menyesuaikan struktur konten untuk tiap platform sosial."],
      ["Nada brand", "Memakai nada, kosakata, dan ungkapan terlarang yang telah ditetapkan."],
      ["Ajakan bertindak", "Menyertakan CTA yang sesuai dengan tujuannya."],
      ["Draf massal", "Menghasilkan sekumpulan draf yang dapat disunting dari tema yang sama."],
    ],
    "Sebutkan temanya, platformnya, audiensnya, nada brand, dan tindakan yang Anda harapkan dari pengguna, lalu minta konten dibuat atau ditulis ulang.",
    "Tulis tiga unggahan untuk LinkedIn dan tiga untuk X tentang pembaruan produk pekan ini, dengan nada profesional dan jelas, tanpa melebih-lebihkan fiturnya.",
  ),
  "composiohq/awesome-claude-skills/content-research-writer": makeOverview(
    [
      "Content Research Writer membantu Agent meneliti sebuah topik dan merapikan materinya menjadi draf konten yang terstruktur.",
      "Berikan topiknya, pembaca sasaran, sumber referensi, kata kunci, dan format kontennya. Skill ini akan membantu menata fakta, sudut pandang, struktur, dan kebutuhan sitasinya.",
    ],
    [
      ["Peneliti konten", "Perlu merapikan beberapa sumber dan sudut pandang sebelum menulis."],
      ["Penulis blog", "Ingin cepat membentuk draf yang tepercaya dari materi riset."],
      ["Tim konten pemasaran", "Perlu menyelesaikan konten yang memadukan kata kunci dan tujuan audiensnya."],
    ],
    [
      ["Riset dan penulisan terputus", "Menempatkan perapian materi dan penyusunan struktur konten dalam satu alur kerja."],
      ["Sumber sulit dikelola", "Memperjelas sumber referensi dan fakta yang perlu diverifikasi."],
      ["Draf kurang berorientasi pembaca", "Menata penyampaian di sekitar pertanyaan pembaca dan tujuan kontennya."],
    ],
    [
      ["Perapian materi", "Menghimpun sumber, fakta, sudut pandang, dan informasi yang masih perlu diverifikasi."],
      ["Perancangan struktur", "Merencanakan lapisan konten sesuai pembaca dan formatnya."],
      ["Pemaduan kata kunci", "Menyertakan kata kunci tanpa mengorbankan keterbacaan."],
      ["Pembuatan draf", "Menghasilkan draf konten bergaya riset yang dapat terus disunting."],
    ],
    "Berikan topiknya, pembacanya, materi referensinya, kata kunci, dan format sasarannya, lalu jelaskan fakta atau sudut pandang apa yang Anda butuhkan.",
    "Teliti kriteria pemilihan perangkat lunak kerja jarak jauh, tulis artikel perbandingan untuk tim rintisan berdasarkan sumber-sumber ini, dan tandai fakta yang perlu diverifikasi.",
  ),
  "googleworkspace/cli/persona-content-creator": makeOverview(
    [
      "Persona Content Creator membantu Agent membuat materi pemasaran atau konten sesuai persona brand dan audiens yang ditentukan.",
      "Berikan persona brand, audiens, tema, kanal, dan kebutuhan nadanya. Skill ini akan menghasilkan draf konten beserta versi yang dapat disesuaikan, dengan tetap menjaga konsistensi personanya.",
    ],
    [
      ["Tim konten brand", "Perlu figur brand dan gaya penyampaian yang seragam."],
      ["Pengelola pemasaran", "Ingin cepat menghasilkan konten sesuai audiens dan kanalnya."],
      ["Tim yang butuh komunikasi berpersona", "Perlu menjaga beberapa keluaran konten tetap memakai persona yang sama."],
    ],
    [
      ["Penyampaian brand tidak konsisten", "Menjaga persona, nada, dan nilai tetap konsisten di berbagai konten."],
      ["Kurang cocok dengan audiens", "Menyesuaikan konten ke konteks audiens sasaran."],
      ["Biaya revisi tinggi", "Cepat menghasilkan versi yang dapat disunting dari kebutuhan persona yang terstruktur."],
    ],
    [
      ["Penetapan persona", "Menghasilkan konten berdasarkan persona brand dan kebutuhan nadanya."],
      ["Penyesuaian audiens", "Mempertimbangkan kebutuhan, tingkat pengetahuan, dan situasi pemakaian audiens."],
      ["Varian kanal", "Menyesuaikan format konten untuk masing-masing kanal publikasi."],
      ["Draf konten", "Menghasilkan konten pemasaran dan media sosial yang dapat terus disunting."],
    ],
    "Berikan persona brand, audiens, tema, kanal, nada, dan ungkapan terlarang, lalu sebutkan format konten yang Anda butuhkan.",
    "Sebagai konsultan produk yang membumi dan bersahabat, tulis email perkenalan produk untuk tim yang baru mulai memakai AI Agent.",
  ),
  "resciencelab/opc-skills/seo-geo": makeOverview(
    [
      "SEO GEO membantu Agent mengoptimalkan keterlihatan konten di mesin pencari maupun pencarian generatif.",
      "Berikan halamannya, tema, audiens sasaran, kata kunci, dan konten pesaing. Skill ini akan membantu memeriksa maksud pencarian, struktur, entitas, dan peluang sitasi, lalu mengusulkan perbaikan yang dapat dijalankan.",
    ],
    [
      ["Pengelola SEO", "Perlu meningkatkan keterlihatan halaman di hasil pencarian."],
      ["Tim konten", "Ingin membuat konten lebih mudah ditemukan dan dikutip oleh jawaban AI."],
      ["Penanggung jawab situs", "Perlu memeriksa struktur halaman dan cakupan temanya secara sistematis."],
    ],
    [
      ["Maksud pencarian tidak jelas", "Menyelaraskan konten dengan persoalan yang benar-benar ingin dipecahkan pengguna."],
      ["Struktur halaman lemah", "Menemukan celah pada judul, entitas, tautan internal, atau strukturnya."],
      ["Paparan di pencarian generatif kurang", "Mengusulkan perbaikan konten yang cocok untuk pengambilan dan sitasi oleh AI."],
    ],
    [
      ["Kata kunci dan maksud", "Menganalisis hubungan antara tema, kata kunci, dan maksud pencarian."],
      ["Pemeriksaan struktur halaman", "Memeriksa judul, paragraf, entitas, dan struktur tautannya."],
      ["Saran GEO", "Mengusulkan perbaikan agar konten lebih mudah dipahami dan dikutip pencarian generatif."],
      ["Daftar optimasi", "Menghasilkan daftar perubahan yang dapat dijalankan menurut prioritas."],
    ],
    "Berikan halaman sasaran, tema, kata kunci, audiens, dan konten pesaingnya, lalu jelaskan apakah Anda ingin mengoptimalkan performa pencarian biasa atau pencarian generatif.",
    "Telaah SEO dan GEO dokumentasi AI Agent ini, tunjukkan perbaikan pada maksud pencarian, struktur, entitas, tautan internal, dan konten yang layak dikutip.",
  ),
  "mattpocock/skills/edit-article": makeOverview(
    [
      "Edit Article membantu Agent menelaah dan memperbaiki struktur, kejelasan, nada, serta keterbacaan sebuah artikel.",
      "Berikan teks aslinya, pembaca sasaran, kanal publikasi, dan kebutuhan penyuntingannya. Skill ini akan menunjukkan masalahnya lalu menghasilkan versi revisi yang mempertahankan maksud aslinya atau saran perbaikan yang konkret.",
    ],
    [
      ["Editor dan penulis", "Perlu memperbaiki artikel pada tataran struktur maupun bahasa."],
      ["Tim pemasaran", "Ingin membuat konten lebih jelas dan lebih sesuai dengan nada brand."],
      ["Penulis teknis", "Perlu meningkatkan keterbacaan tanpa mengorbankan ketepatan."],
    ],
    [
      ["Struktur artikel longgar", "Menata ulang konten agar pembaca lebih mudah mengikutinya."],
      ["Penyampaian kurang jelas", "Mengurangi ambiguitas, pengulangan, dan kerumitan yang tidak perlu."],
      ["Nada tidak sesuai", "Menyesuaikan nada artikel menurut pembaca dan kanalnya."],
    ],
    [
      ["Telaah struktur", "Memeriksa pembuka, urutan paragraf, dan lapisan informasinya."],
      ["Penyuntingan bahasa", "Memperbaiki kejelasan, ketepatan, dan keterbacaan."],
      ["Penyesuaian nada", "Menyesuaikan penyampaian menurut brand, pembaca, dan kanalnya."],
      ["Penjelasan revisi", "Menjelaskan perubahan utama beserta alasannya agar mudah ditinjau manusia."],
    ],
    "Tempelkan artikelnya lalu sebutkan pembaca sasaran, kanal, nada, serta fakta atau pandangan yang tidak boleh diubah.",
    "Sunting pengumuman produk ini agar lebih jelas, ringkas, dan cocok dibaca tim teknis, dengan mempertahankan semua fakta dan nomor versinya.",
  ),
  "karpathy/nanochat/read-arxiv-paper": makeOverview(
    [
      "Read Arxiv Paper membantu Agent membaca dan menjelaskan makalah arXiv, menyaring masalah, metode, hasil, dan keterbatasannya.",
      "Berikan tautan makalah, PDF, atau judulnya, lalu jelaskan latar pengetahuan Anda dan hal yang Anda perhatikan. Skill ini akan merapikan kontribusi riset, detail teknis, dan kesimpulan yang dapat diverifikasi.",
    ],
    [
      ["Peneliti", "Perlu cepat menilai apakah sebuah makalah layak dibaca lebih dalam."],
      ["Pelajar dan mahasiswa", "Ingin memperoleh penjelasan makalah yang sesuai dengan latar belakangnya."],
      ["Pengambil keputusan teknis", "Perlu memahami metode riset dan keterbatasan praktisnya."],
    ],
    [
      ["Membaca makalah menyita waktu", "Menyaring struktur dan kontribusi intinya lebih dulu, baru menentukan arah pendalamannya."],
      ["Istilah teknis sangat padat", "Menjelaskan konsep kunci sesuai latar belakang pembacanya."],
      ["Kesimpulan digeneralisasi berlebihan", "Mempertahankan pengaturan eksperimen, keterbatasan, dan ketidakpastiannya."],
    ],
    [
      ["Ekstraksi struktur makalah", "Mengenali masalah, metode, eksperimen, hasil, dan keterbatasannya."],
      ["Penjelasan konsep", "Menjelaskan istilah dan metode dengan cara yang sesuai latar pembaca."],
      ["Ringkasan hasil", "Menyaring temuan dan bukti yang dapat ditopang."],
      ["Pembacaan kritis", "Menunjukkan asumsi, keterbatasan, dan bagian yang perlu diverifikasi lebih lanjut."],
    ],
    "Berikan tautan atau berkas makalahnya, lalu jelaskan latar belakang Anda, tujuan membaca, dan pertanyaan yang paling Anda perhatikan.",
    "Baca makalah ini, jelaskan dulu masalah intinya dengan bahasa non-teknis, lalu rangkum metode, hasil eksperimen, keterbatasan, dan bagian mana yang sebaiknya saya baca dengan saksama.",
  ),
  "googleworkspace/cli/persona-researcher": makeOverview(
    [
      "Persona Researcher membantu Agent menghimpun, membandingkan, dan merangkum materi sesuai persona peneliti yang ditentukan.",
      "Berikan pertanyaan risetnya, audiens sasaran, cakupan sumber, batas waktu, dan format keluarannya. Skill ini akan merapikan temuan kunci, bukti, informasi yang saling bertentangan, dan pertanyaan lanjutannya.",
    ],
    [
      ["Tim riset", "Perlu alur riset materi yang dapat diulang."],
      ["Praktisi produk dan pasar", "Ingin cepat memperoleh ringkasan riset berdasarkan pertanyaan yang jelas."],
      ["Tim yang butuh riset berpersona", "Perlu hasil riset yang sesuai dengan persona dan standar profesional tertentu."],
    ],
    [
      ["Cakupan riset melebar", "Menyempitkan cakupan bertolak dari pertanyaan, batasan, dan kriteria sumbernya."],
      ["Bukti sulit dilacak", "Mengaitkan temuan dengan sumber dan dasar penilaiannya."],
      ["Hasil kurang fokus", "Menata kesimpulan di sekitar pembaca sasaran dan persoalan keputusannya."],
    ],
    [
      ["Persona peneliti", "Menjalankan riset mengikuti persona dan standar yang ditentukan."],
      ["Perapian sumber", "Mencatat sumber, fakta kunci, dan keterkaitan buktinya."],
      ["Analisis pembanding", "Menata perbedaan antar-sudut pandang, opsi, atau pesaing."],
      ["Keluaran riset", "Menghasilkan ringkasan, tabel, atau laporan yang berorientasi keputusan."],
    ],
    "Jelaskan pertanyaan risetnya, personanya, cakupan sumber, batas waktu, pembaca sasaran, dan format keluarannya.",
    "Sebagai peneliti produk, teliti tiga alat basis pengetahuan tim, bandingkan harga, kemampuan kolaborasi, integrasi, dan tim yang cocok memakainya, lalu sebutkan sumbernya.",
  ),
  "nexscope-ai/amazon-skills/amazon-product-research": makeOverview(
    [
      "Amazon Product Research membantu Agent meneliti produk Amazon, persaingan pasar, dan peluang produknya.",
      "Berikan kata kunci, kategori, pasar sasaran, anggaran, atau batasan produknya. Skill ini akan merapikan pesaing, harga, ulasan, sinyal permintaan, dan peluang yang perlu divalidasi.",
    ],
    [
      ["Penjual e-commerce", "Perlu memahami pasar dan persaingan sebelum memilih produk."],
      ["Peneliti produk", "Ingin membandingkan produk, ulasan, dan peluang pasarnya."],
      ["Perencana brand", "Perlu sinyal pasar untuk menopang penilaian arah produk."],
    ],
    [
      ["Informasi pesaing tersebar", "Menyatukan produk, harga, ulasan, dan konteks peringkatnya."],
      ["Sulit menilai permintaan", "Menggali kebutuhan pengguna dari ulasan dan sinyal pasar."],
      ["Dasar pemilihan produk kurang", "Menghasilkan peluang, risiko, dan saran validasi langkah berikutnya."],
    ],
    [
      ["Penemuan produk", "Mencari produk berdasarkan kata kunci, kategori, atau pasarnya."],
      ["Perbandingan pesaing", "Membandingkan harga, ulasan, posisi, dan karakter produknya."],
      ["Analisis ulasan", "Menyaring kebutuhan, keluhan, dan peluang perbaikan dari ulasan."],
      ["Penyaringan peluang", "Mengusulkan arah kandidat dengan mempertimbangkan batasan, sinyal, dan risikonya."],
    ],
    "Berikan pasar sasaran, kategori, kata kunci, anggaran, dan batasan produknya, lalu jelaskan dimensi pesaing yang ingin Anda bandingkan.",
    "Teliti pasar power station portabel untuk luar ruang di situs Amerika Serikat, bandingkan harga, keluhan pada ulasan, perbedaan fitur sepuluh produk teratas, dan peluang yang cocok untuk dimasuki.",
  ),
  "coreyhaines31/marketingskills/customer-research": makeOverview(
    [
      "Customer Research membantu Agent merencanakan dan merapikan riset pelanggan untuk memahami kebutuhan, perilaku, dan keputusan pembelian pengguna.",
      "Berikan tujuan risetnya, pelanggan sasaran, umpan balik yang sudah ada, materi wawancara, atau data survei. Skill ini akan membantu merancang pertanyaan, menyimpulkan tema, dan mengusulkan wawasan pelanggan yang dapat diverifikasi.",
    ],
    [
      ["Manajer produk", "Perlu bukti dari pelanggan untuk menopang prioritas produk."],
      ["Peneliti pengguna", "Ingin cepat merencanakan riset dan merapikan materi wawancara."],
      ["Tim pemasaran", "Perlu memahami kebutuhan, hambatan, dan motivasi pembelian pelanggan."],
    ],
    [
      ["Tujuan riset kabur", "Mengubah persoalan bisnis menjadi pertanyaan riset yang dapat diselidiki."],
      ["Materi wawancara sulit dirapikan", "Mengenali tema dan pola dari umpan balik aslinya."],
      ["Wawasan tidak dapat ditindaklanjuti", "Menghubungkan temuan dengan keputusan dan validasi lanjutannya."],
    ],
    [
      ["Perancangan riset", "Menetapkan tujuan, sampel, pertanyaan, dan metodenya."],
      ["Analisis wawancara", "Merapikan umpan balik, tema, dan bukti representatifnya."],
      ["Penyaringan kebutuhan", "Mengenali tujuan pengguna, keluhan, dan pola perilakunya."],
      ["Validasi wawasan", "Mengusulkan hipotesis dan tindakan yang perlu diverifikasi lebih lanjut."],
    ],
    "Jelaskan tujuan risetnya, kelompok pelanggan, materi yang sudah ada, waktu, dan konteks keputusannya, lalu minta rencana riset atau analisisnya.",
    "Berdasarkan wawancara pelanggan ini, simpulkan kebutuhan utama, hambatan, dan pemicu pembeliannya, lalu ajukan tiga hipotesis yang perlu divalidasi lebih lanjut.",
  ),
  "firecrawl/firecrawl-workflows/firecrawl-market-research": makeOverview(
    [
      "Firecrawl Market Research membantu Agent menjalankan riset pasar terstruktur memakai materi dari halaman web.",
      "Berikan pertanyaan pasarnya, industri sasaran, pesaing, wilayah, dan rentang waktunya. Skill ini akan membantu menghimpun informasi web, membandingkan pelaku pasar, dan merapikan ringkasan pasar bersumber.",
    ],
    [
      ["Peneliti pasar", "Perlu cepat membangun gambaran pasar dari berbagai sumber web."],
      ["Tim strategi dan produk", "Ingin memahami pasar, persaingan, dan trennya."],
      ["Analis bisnis", "Perlu hasil riset yang ditopang sumber."],
    ],
    [
      ["Materi web tersebar", "Menghimpun dan menata banyak sumber dalam satu alur riset."],
      ["Lanskap persaingan tidak jelas", "Membandingkan pelaku pasar dengan dimensi yang seragam."],
      ["Hasil riset tanpa sumber", "Menyimpan rujukan web agar mudah diperiksa ulang."],
    ],
    [
      ["Riset web", "Menghimpun informasi pasar dan persaingan dari halaman web publik."],
      ["Perbandingan pesaing", "Menata perusahaan, produk, dan posisinya dengan dimensi yang seragam."],
      ["Ekstraksi tren", "Mengenali perubahan dan sinyal pasar dalam rentang waktu tertentu."],
      ["Pencatatan sumber", "Menyimpan sumber dan informasi yang masih perlu diverifikasi di dalam ringkasan."],
    ],
    "Jelaskan pertanyaan pasarnya, industri, wilayah, pesaing, dan rentang waktunya, lalu berikan situs atau sumber yang perlu diakses secara khusus.",
    "Teliti pasar perangkat lunak layanan pelanggan AI di Asia Tenggara, bandingkan penyedia utama, harga, pelanggan sasaran, dan perubahan produk terkini, serta sertakan sumber untuk setiap temuan.",
  ),
  "firecrawl/firecrawl-workflows/firecrawl-deep-research": makeOverview(
    [
      "Firecrawl Deep Research membantu Agent melakukan riset web berulang dan perapian bukti untuk persoalan yang kompleks.",
      "Berikan pertanyaan risetnya, cakupan, batas waktu, kriteria sumber tepercaya, dan format keluarannya. Skill ini akan membantu memecah pertanyaan, mencari materi, membandingkan silang, dan menghasilkan laporan yang berdasar.",
    ],
    [
      ["Peneliti mendalam", "Perlu menyelidiki topik kompleks dari berbagai sumber."],
      ["Tim strategi", "Ingin memperoleh bukti sistematis sebelum keputusan besar."],
      ["Penulis yang butuh verifikasi fakta", "Perlu memisahkan informasi tepercaya, pandangan yang bertentangan, dan hal yang masih perlu dikonfirmasi."],
    ],
    [
      ["Persoalan terlalu kompleks", "Memecah persoalan besar menjadi subpertanyaan yang dapat diteliti bertahap."],
      ["Sumber saling bertentangan", "Membandingkan berbagai sumber dan menandai ketidaksesuaiannya."],
      ["Riset sulit diperiksa ulang", "Menyimpan rantai bukti, sumber, dan ketidakpastiannya."],
    ],
    [
      ["Pemecahan pertanyaan", "Membagi persoalan kompleks menjadi subpertanyaan yang dapat diteliti."],
      ["Penelusuran berulang", "Terus mencari informasi yang masih menjadi celah berdasarkan temuan yang sudah ada."],
      ["Verifikasi silang bukti", "Membandingkan kualitas sumber, waktu, dan kesimpulannya."],
      ["Laporan riset", "Menyusun laporan lengkap beserta sumber, keterbatasan, dan kesimpulannya."],
    ],
    "Jelaskan pertanyaan risetnya, cakupan, tenggat waktu, preferensi sumber, dan format akhirnya, lalu sebutkan kesimpulan mana yang paling penting.",
    "Lakukan riset mendalam atas pasar kredit karbon global, mencakup standar utama, perubahan harga, tren regulasi, dan risikonya, kutip sumber tepercaya, dan pisahkan fakta dari simpulan.",
  ),
  "anthropics/skills/pdf": makeOverview(
    [
      "PDF membantu Agent membaca, menganalisis, mengekstrak, dan menghasilkan dokumen PDF.",
      "Berikan berkas PDF beserta tugas yang ingin diselesaikan, misalnya mengekstrak tabel, merangkum isi, menelaah format, atau menghasilkan dokumen baru. Skill ini akan mengolah isi dan struktur dokumennya sesuai tugas tersebut.",
    ],
    [
      ["Pengolah dokumen", "Perlu mengekstrak informasi dari PDF atau merapikan isinya."],
      ["Tim riset dan operasional", "Ingin membaca laporan, tabel, atau kontrak secara massal."],
      ["Pengguna yang perlu menghasilkan dokumen", "Ingin mengeluarkan konten terstruktur menjadi PDF."],
    ],
    [
      ["Informasi PDF sulit dipakai ulang", "Mengubah teks, tabel, dan struktur dokumen menjadi konten yang dapat diolah."],
      ["Membaca dokumen panjang menyita waktu", "Cepat menemukan poin penting dan menghasilkan ringkasannya."],
      ["Keluaran dokumen tidak konsisten", "Menghasilkan atau merapikan PDF sesuai struktur yang ditentukan."],
    ],
    [
      ["Ekstraksi teks", "Membaca teks dan struktur di dalam PDF."],
      ["Pengolahan tabel", "Mengekstrak dan merapikan informasi tabel dalam dokumen."],
      ["Analisis konten", "Merangkum, membandingkan, atau menelaah isi PDF."],
      ["Keluaran PDF", "Menghasilkan dokumen PDF dari masukan yang terstruktur."],
    ],
    "Unggah PDF-nya lalu jelaskan tujuannya, misalnya merangkum, mengekstrak tabel, membandingkan dokumen, atau menghasilkan PDF baru.",
    "Baca PDF ini, ekstrak semua tabelnya menjadi Markdown, lalu rangkum kesimpulan utama dan angka yang masih perlu dikonfirmasi.",
  ),
  "coreyhaines31/marketingskills/image": makeOverview(
    [
      "Image membantu Agent merencanakan dan menghasilkan arahan visual yang cocok untuk kebutuhan pemasaran, produk, atau konten.",
      "Berikan tujuan pemakaian, audiens, gaya brand, elemen gambar, ukuran, dan batasannya. Skill ini akan membantu membentuk prompt gambar, komposisi, dan arahan visual yang jelas.",
    ],
    [
      ["Tim desain dan pemasaran", "Perlu cepat memperjelas arahan visual sebuah gambar."],
      ["Kreator konten", "Ingin mengubah gagasan tertulis menjadi prompt gambar yang dapat dijalankan."],
      ["Tim produk", "Perlu menyiapkan aset visual pendukung untuk halaman atau fitur."],
    ],
    [
      ["Kebutuhan visual masih kabur", "Merapikan tujuan dan gagasan menjadi persyaratan gambar yang konkret."],
      ["Gaya brand tidak konsisten", "Mempertahankan warna, nada, dan aturan visual di dalam prompt-nya."],
      ["Hasil menyimpang dari tujuan", "Menetapkan komposisi, subjek, ukuran, dan batasannya lebih dahulu."],
    ],
    [
      ["Perencanaan prompt", "Mengubah gagasan tertulis menjadi prompt gambar yang jelas."],
      ["Perancangan komposisi", "Menetapkan subjek, lapisan, ruang kosong, dan arah pandangnya."],
      ["Penyesuaian brand", "Menggabungkan warna, gaya, dan konteks pemakaian brand."],
      ["Spesifikasi keluaran", "Menentukan ukuran, rasio, format, dan elemen yang tidak boleh muncul."],
    ],
    "Jelaskan tujuan gambarnya, audiens, gaya brand, subjek, komposisi, ukuran, dan elemen yang dilarang.",
    "Buat gambar banner untuk sebuah pasar skill AI, sisakan ruang untuk judul di sisi kiri, tempatkan perangkat pencarian 3D abstrak di sisi kanan, dengan tampilan bersih, modern, dan tanpa teks.",
  ),
  "github/awesome-copilot/prd": makeOverview(
    [
      "PRD membantu Agent merapikan gagasan produk menjadi dokumen kebutuhan produk yang terstruktur dan siap dikirimkan.",
      "Berikan masalah pengguna, tujuan, cakupan, alur, batasan, dan indikator keberhasilannya. Skill ini akan membantu membentuk kebutuhan, batas cakupan, kondisi tak wajar, dan kriteria penerimaannya.",
    ],
    [
      ["Manajer produk", "Perlu cepat membangun PRD yang lengkap dari sebuah gagasan."],
      ["Tim engineering dan desain", "Ingin memperoleh latar dan cakupan produk yang jelas sebelum pengembangan."],
      ["Pemimpin proyek", "Perlu memperjelas tujuan, risiko, dan kriteria penerimaannya."],
    ],
    [
      ["Gagasan belum terstruktur", "Merapikan masukan yang tersebar menjadi dokumen kebutuhan yang dapat ditinjau."],
      ["Cakupan terus melebar", "Memperjelas tujuan, hal yang bukan tujuan, dan batasnya."],
      ["Kriteria penerimaan tidak ada", "Mengubah kebutuhan menjadi hasil yang dapat diverifikasi."],
    ],
    [
      ["Definisi masalah", "Memperjelas pengguna, masalah, dan tujuan bisnisnya."],
      ["Uraian alur", "Merapikan alur utama, kondisi tak wajar, dan batasnya."],
      ["Pengelolaan cakupan", "Memisahkan tujuan, hal yang bukan tujuan, dan pekerjaan lanjutannya."],
      ["Kriteria penerimaan", "Menghasilkan kriteria yang dapat diperiksa bersama oleh produk, desain, dan engineering."],
    ],
    "Berikan masalah pengguna, tujuan, cakupan, batasan, dan indikator keberhasilannya, lalu jelaskan alur pengguna yang perlu dicakup.",
    "Tulis PRD untuk fitur pemeriksaan konektivitas model di dalam produk, mencakup masalah pengguna, alur, kebutuhan API, kondisi galat, risiko, dan kriteria penerimaannya.",
  ),
  "google-labs-code/stitch-skills/enhance-prompt": makeOverview(
    [
      "Enhance Prompt merapikan gagasan UI yang masih kasar menjadi prompt desain yang lebih jelas dan cocok untuk Stitch.",
      "Berikan gagasan antarmukanya, tujuan pengguna, arah brand, dan batasannya. Skill ini akan melengkapi detail yang belum ada seperti platform, tata letak, komponen, warna, dan interaksinya, lalu menghasilkan prompt yang terstruktur.",
    ],
    [
      ["Perancang gagasan antarmuka", "Berangkat dari gagasan yang masih kabur dan perlu prompt yang lebih lengkap."],
      ["Pengguna design system", "Ingin prompt-nya tetap sejalan dengan DESIGN.md yang sudah ada."],
      ["Tim yang perlu memperbaiki hasil generasi", "Ingin memperbaiki uraian desain yang lemah sebelum menghasilkan ulang."],
    ],
    [
      ["Kebutuhan UI masih kabur", "Melengkapi detail platform, halaman, tata letak, dan komponennya."],
      ["Gaya antarhalaman tidak konsisten", "Merujuk konteks design system bila tersedia."],
      ["Hasil generasi kurang memuaskan", "Memperbaiki uraian desain dan interaksinya lebih dulu, baru menghasilkan ulang."],
    ],
    [
      ["Pengenalan celah", "Menemukan informasi yang belum ada di dalam prompt UI yang masih kasar."],
      ["Pelengkapan terstruktur", "Menambahkan panduan tata letak, komponen, warna, dan gaya visual."],
      ["Penyelarasan design system", "Membaca DESIGN.md agar antarhalaman tetap konsisten."],
      ["Keluaran prompt Stitch", "Menghasilkan prompt yang terfokus dan cocok dipakai di Stitch."],
    ],
    "Uraikan antarmukanya, pengguna sasaran, tugas intinya, platform, arah brand, dan konteks design system yang sudah ada.",
    "Perbaiki prompt Stitch ini: saya butuh dasbor untuk memantau kebugaran, mendukung desktop dan seluler, terasa memotivasi tetapi tidak kekanak-kanakan.",
  ),
  "github/awesome-copilot/documentation-writer": makeOverview(
    [
      "Documentation Writer memakai kerangka Diataxis untuk membantu Agent membuat dokumentasi perangkat lunak, mencakup tutorial, panduan langkah, referensi, dan penjelasan.",
      "Berikan latar fiturnya, pembaca, contoh, dan tujuan dokumentasinya. Skill ini akan membantu memilih jenis dokumen, merencanakan strukturnya, dan menghasilkan Markdown dengan istilah yang konsisten.",
    ],
    [
      ["Penulis dokumentasi perangkat lunak", "Perlu menulis dan memelihara dokumentasi untuk pengguna atau developer."],
      ["Tim teknis", "Perlu menilai apakah yang dibutuhkan tutorial, panduan, referensi, atau penjelasan."],
      ["Pemelihara dokumentasi", "Ingin membangun proses yang terstruktur sebelum menulis secara lengkap."],
    ],
    [
      ["Jenis dokumen tercampur", "Memilih jenis Diataxis yang sesuai dengan tugas pembacanya."],
      ["Struktur tidak jelas", "Memperjelas pembaca dan tujuannya sebelum menyusun kerangka."],
      ["Istilah tidak konsisten", "Mengarahkan keseragaman gaya, istilah, contoh, dan langkah pemeriksaannya."],
    ],
    [
      ["Klasifikasi dokumen", "Menilai jenis dokumen menurut kerangka Diataxis."],
      ["Pengumpulan konteks", "Merapikan pembaca, tugas, dan latar produknya."],
      ["Perencanaan kerangka", "Mengusulkan struktur yang sesuai sebelum menulis lengkap."],
      ["Keluaran Markdown", "Menghasilkan dokumen Markdown yang berorientasi pembaca."],
    ],
    "Jelaskan fiturnya, pembaca sasaran, jenis dokumen yang dibutuhkan, contoh yang tersedia, dan tugas yang akhirnya harus dituntaskan pembaca.",
    "Tulis panduan konfigurasi pemeriksaan konektivitas model untuk developer, mencakup prasyarat, langkah, hasil yang diharapkan, dan penelusuran masalahnya.",
  ),
  "wshobson/agents/data-storytelling": makeOverview(
    [
      "Data Storytelling membantu Agent mengubah data dan hasil analisis menjadi cerita yang mudah dipahami dan mendukung tindakan.",
      "Berikan datanya, audiens, konteks keputusan, dan pertanyaan intinya. Skill ini akan membantu memilih struktur cerita, pesan utama, cara pemberian anotasi, dan arahan visualisasinya.",
    ],
    [
      ["Analis data", "Perlu menjelaskan hasil analisis kepada manajemen atau audiens non-teknis."],
      ["Pemimpin bisnis", "Perlu tinjauan kuartalan, pembaruan investasi, atau laporan keputusan."],
      ["Pemilik data yang kesulitan menyampaikannya", "Ingin mengubah angka menjadi pesan dan arahan visual yang jelas."],
    ],
    [
      ["Data tanpa benang merah", "Menghubungkan bukti dengan narasi dan keputusan yang jelas."],
      ["Grafik kelebihan informasi", "Memakai penekanan dan anotasi agar pembaca melihat hal penting lebih dulu."],
      ["Ketidakpastian tidak jelas", "Mengarahkan pemakaian rentang, asumsi, dan keterbatasan secara bertanggung jawab."],
    ],
    [
      ["Struktur cerita", "Membangun struktur narasi seperti masalah-solusi atau tren."],
      ["Penyaringan pesan", "Memilih pesan inti dan bukti pendukungnya."],
      ["Saran visual", "Mengusulkan arahan grafik dan anotasi agar penyampaiannya jernih."],
      ["Penyesuaian audiens", "Menyesuaikan untuk konteks manajemen, laporan, atau dasbor."],
    ],
    "Berikan data atau hasil analisisnya, audiens, keputusan yang ingin ditopang, serta format grafik, laporan, atau presentasi yang dibutuhkan.",
    "Ubah data retensi kuartalan ini menjadi narasi untuk manajemen, tonjolkan tren utama, kemungkinan penyebabnya, dan ketidakpastiannya, lalu usulkan dua langkah berikutnya.",
  ),
  "find-skill-skillhub": makeOverview(
    [
      "find skill membantu Agent menemukan, mencari, dan merekomendasikan skill di SkillHub yang cocok untuk tugas yang sedang dikerjakan.",
      "Berikan tujuan tugasnya, bidangnya, kata kunci, atau kategori skill-nya. Skill ini akan mengembalikan kandidat yang relevan berdasarkan daftar skill SkillHub, sehingga pengguna dapat menemukan kemampuan yang bisa dipasang mulai dari kebutuhannya.",
    ],
    [
      ["Pengguna umum", "Belum mengenal nama skill-nya, tetapi ingin menemukan kemampuan yang tepat lewat uraian tugas."],
      ["Pemelihara skill", "Perlu menelusuri skill SkillHub berdasarkan kata kunci atau kategori."],
      ["Pengguna Agent", "Ingin cepat melengkapi kemampuan yang belum ada sebelum menjalankan tugas baru."],
    ],
    [
      ["Tidak tahu ID skill-nya", "Memungkinkan pencarian dimulai dari uraian tugas dan kemampuannya."],
      ["Kandidat sulit dibandingkan", "Mengumpulkan skill yang relevan ke dalam satu kelompok hasil."],
      ["Proses penemuan berulang", "Mengurangi penelusuran manual dengan cara pencarian yang dapat dipakai ulang."],
    ],
    [
      ["Pencarian kata kunci", "Menelusuri kandidat berdasarkan tugas, bidang, atau uraian skill-nya."],
      ["Penyaringan kategori", "Mempersempit hasil dengan memakai kategori utama SkillHub."],
      ["Pencarian gabungan", "Memakai kata kunci dan kategori sekaligus untuk menemukan skill."],
      ["Petunjuk pemasangan", "Mengembalikan identitas skill-nya agar mudah ditinjau dan dipasang."],
    ],
    "Jelaskan tugas yang ingin Anda selesaikan, bidang terkait, atau kata kuncinya, lalu minta Agent mencari kandidat skill di SkillHub.",
    "Cari skill di SkillHub yang bisa membaca PDF, mengekstrak tabel, dan menghasilkan ringkasan, lalu tampilkan kandidat yang paling relevan.",
  ),
  "image-prompt-skill": makeOverview(
    [
      "Master Prompt membantu Agent menghasilkan prompt terstruktur untuk pembuatan gambar dan video.",
      "Berikan gagasan tertulis, gambar atau video acuan, platform sasaran, gaya visual, dan persyaratan tampilannya. Skill ini akan menata subjek, komposisi, gaya, dan tata bahasa khas platformnya, lalu menghasilkan prompt yang dapat langsung dipakai.",
    ],
    [
      ["Kreator konten visual", "Perlu mengubah gagasan yang masih kabur menjadi prompt yang dapat dijalankan."],
      ["Tim desain dan pemasaran", "Ingin cepat menyiapkan prompt gambar atau video untuk berbagai platform."],
      ["Pengguna yang menulis ulang dari acuan", "Ingin menyaring arahan dari aset visual yang sudah ada lalu menyesuaikannya."],
    ],
    [
      ["Gagasan tidak bisa langsung dihasilkan", "Merapikan gagasan berbahasa alami menjadi prompt yang lebih lengkap."],
      ["Tata bahasa platform berbeda-beda", "Menyesuaikan cara penyampaian menurut platform gambar atau video sasarannya."],
      ["Gaya sulit ditiru ulang", "Mencatat gaya visual, komposisi, pencahayaan, dan titik fokusnya."],
    ],
    [
      ["Prompt gambar", "Menghasilkan isi prompt untuk teks-ke-gambar maupun gambar-ke-gambar."],
      ["Prompt video", "Merapikan kebutuhan gerak dan pengambilan gambar untuk teks-ke-video atau gambar-ke-video."],
      ["Analisis aset acuan", "Menyaring arahan visual yang dapat dipakai ulang dari gambar atau video."],
      ["Pemeriksaan gaya dan keamanan", "Memeriksa persyaratan gaya serta batasan generasi yang jelas tidak layak."],
    ],
    "Jelaskan tujuan kreatifnya, subjek, gaya, komposisi, ukuran, platform, dan elemen yang tidak Anda inginkan; Anda juga dapat melampirkan aset acuan.",
    "Buat prompt gambar untuk poster acara peluncuran produk teknologi, dengan nuansa teknologi berwarna biru, subjek di sisi kanan, ruang kosong di sisi kiri, tanpa teks dan tanpa watermark.",
  ),
  "poster": makeOverview(
    [
      "Skill Desain Poster membantu Agent membangun satu kesatuan konsep desain untuk poster dan visual brand, lalu menghasilkan karya poster SVG yang siap dirender.",
      "Berikan temanya, audiens, isi teks, ukuran, warna brand, dan preferensi visualnya. Skill ini akan merapikan filosofi desain, tata letak, dan aturan estetikanya terlebih dahulu, baru menghasilkan poster yang siap dirender.",
    ],
    [
      ["Tim brand dan pemasaran", "Perlu membuat visual yang sistematis untuk acara, produk, atau brand."],
      ["Desainer", "Ingin cepat menjajaki arahan poster minimalis dan tata letaknya."],
      ["Kreator konten", "Ingin mengubah tema dan salinan teks menjadi karya visual yang siap diserahkan."],
    ],
    [
      ["Arahan visual tidak seragam", "Menetapkan konsep desainnya lebih dulu, lalu membuat tata letak dan elemennya mengikuti aturan yang sama."],
      ["Menata letak poster menyita waktu", "Menata tema, salinan teks, dan batasan visualnya menjadi rencana yang dapat dijalankan."],
      ["Hanya dapat uraian tanpa karya", "Langsung menghasilkan artefak poster SVG yang dapat dirender."],
    ],
    [
      ["Filosofi desain", "Membangun aturan estetika dan visual yang jelas di sekitar temanya."],
      ["Perencanaan tata letak", "Menata judul, isi, ruang kosong, dan hierarki visualnya."],
      ["Visual brand", "Merancang dengan menggabungkan warna brand, gaya, dan konteks pemakaiannya."],
      ["Pembuatan SVG", "Menghasilkan poster SVG yang dapat terus dirender atau disesuaikan."],
    ],
    "Berikan tema poster, salinan teks, ukuran, warna brand, audiens, dan gaya visual yang Anda inginkan, lalu minta Agent mengajukan konsep desainnya sebelum menghasilkan karyanya.",
    "Rancang poster minimalis untuk acara peluncuran produk AI, gunakan biru tua dan putih, tonjolkan tanggal dan nama acaranya, lalu hasilkan SVG yang siap dirender.",
  ),
  "valuation-analysis": makeOverview(
    [
      "Sistem Analisis Investasi Nilai Saham membantu Agent menganalisis nilai investasi saham A-share dan Hong Kong memakai kerangka value investing.",
      "Berikan kode atau nama sahamnya, industri yang Anda perhatikan, dan tujuan analisisnya. Skill ini akan merapikan kesimpulan analisis di sekitar keunggulan bertahan, kesehatan keuangan, valuasi DCF, manajemen, dan struktur industrinya untuk Anda nilai lebih lanjut.",
    ],
    [
      ["Investor jangka panjang", "Perlu memeriksa kualitas perusahaan dan valuasinya secara sistematis."],
      ["Peneliti", "Ingin membandingkan saham dan industri dengan kerangka yang seragam."],
      ["Penyiap keputusan investasi", "Perlu melihat asumsi kunci dan risikonya sebelum mengambil kesimpulan."],
    ],
    [
      ["Dimensi analisis tersebar", "Menempatkan keunggulan bersaing, keuangan, valuasi, dan industri dalam satu kerangka."],
      ["Valuasi tanpa asumsi", "Memperjelas masukan model, asumsi, dan ketidakpastiannya."],
      ["Kesimpulan sulit diperiksa ulang", "Menghubungkan kesimpulan dengan data, metode, dan risikonya."],
    ],
    [
      ["Analisis keunggulan bertahan", "Menilai keunggulan bersaing dan keberlanjutannya."],
      ["Pemeriksaan kesehatan keuangan", "Memeriksa profitabilitas, arus kas, dan kualitas akuntansinya."],
      ["Valuasi DCF", "Memperkirakan rentang nilai intrinsik berdasarkan asumsi masukannya."],
      ["Perapian keputusan investasi", "Menggabungkan perusahaan, industri, valuasi, dan risiko menjadi ringkasan riset."],
    ],
    "Berikan kode atau nama sahamnya, pasarnya, rentang waktu analisis, dan fokus perhatian Anda; perlu diingat ini adalah acuan riset, bukan keputusan investasi otomatis.",
    "Analisis keunggulan bertahan perusahaan A-share ini, kesehatan keuangan tiga tahun terakhir, dan valuasi DCF-nya, lalu sebutkan asumsi kunci, risiko, dan data yang masih perlu diverifikasi.",
  ),
  "financial-report-analysis": makeOverview(
    [
      "Analisis Laporan Keuangan membantu Agent membaca neraca, laporan laba rugi, dan laporan arus kas perusahaan terbuka, lalu menyusun analisis keuangan yang terstruktur.",
      "Berikan berkas laporan keuangan, tangkapan layar, atau datanya, serta jelaskan perusahaan, periode, dan pertanyaan yang Anda perhatikan. Skill ini akan mengekstrak indikator kunci lalu merapikan perubahan, kejanggalan, dan hal yang masih perlu diverifikasi.",
    ],
    [
      ["Peneliti investasi", "Perlu cepat memahami perubahan operasional dan keuangan dalam laporan."],
      ["Tim keuangan dan bisnis", "Ingin merapikan angka laporan menjadi laporan yang mudah dibaca."],
      ["Manajer", "Perlu mengenali risiko dan sinyal operasional dari laporan keuangannya."],
    ],
    [
      ["Informasi laporan tersebar", "Menempatkan ketiga laporan utama dalam satu alur analisis."],
      ["Perubahan sulit ditemukan", "Membandingkan data antarperiode dan menunjukkan fluktuasi yang janggal."],
      ["Angka tanpa penjelasan", "Menghubungkan perubahan indikator dengan kemungkinan penyebab bisnis dan hal yang perlu diverifikasi."],
    ],
    [
      ["Pembacaan laporan", "Mengenali isi neraca, laporan laba rugi, dan laporan arus kas."],
      ["Ekstraksi indikator", "Merapikan indikator kunci seperti pendapatan, laba, arus kas, dan kemampuan membayar utang."],
      ["Perbandingan tren", "Membandingkan perubahan antarperiode dan menonjolkan perbedaan yang penting."],
      ["Pembuatan laporan", "Menyusun laporan keuangan berisi kesimpulan, risiko, dan hal yang perlu dikonfirmasi."],
    ],
    "Unggah laporan keuangannya atau tempelkan datanya, lalu lengkapi nama perusahaan, periode laporan, dan indikator yang ingin Anda analisis secara khusus.",
    "Analisis ketiga laporan keuangan perusahaan ini, sebutkan dulu perubahan indikator kuncinya, lalu jelaskan kualitas laba, risiko arus kas, dan angka yang perlu dicocokkan.",
  ),
  "stock-selecter": makeOverview(
    [
      "Penyaring Saham membantu Agent menyaring saham memakai berbagai strategi, cocok untuk mencari kumpulan kandidat yang memenuhi syarat.",
      "Berikan cakupan pasarnya, strategi penyaringan, ambang indikator, dan cara pengurutan hasilnya. Skill ini mendukung strategi tunggal maupun gabungan, dan dapat merapikan hasilnya menurut skor, ROE, rasio dividen, dan kriteria lain.",
    ],
    [
      ["Peneliti pemilihan saham", "Perlu mencari kandidat saham menurut strategi yang jelas."],
      ["Pembelajar kuantitatif", "Ingin membandingkan hasil dari berbagai syarat penyaringan."],
      ["Pemelihara portofolio", "Perlu menyaring ulang secara berkala dengan aturan yang seragam."],
    ],
    [
      ["Cakupan kandidat terlalu luas", "Cepat mempersempit kumpulan saham memakai indikator dan strateginya."],
      ["Strategi sulit digabungkan", "Mendukung irisan, gabungan, atau kombinasi dari beberapa strategi."],
      ["Hasil tanpa urutan", "Menyusun kandidat menurut skor atau indikator yang Anda tentukan."],
    ],
    [
      ["Penyaringan strategi", "Mendukung strategi seperti ROE, MACD, dividen tinggi, valuasi rendah, dan tren."],
      ["Syarat gabungan", "Menggabungkan beberapa strategi untuk penyaringan irisan, gabungan, atau menyeluruh."],
      ["Pengurutan hasil", "Mengurutkan menurut dimensi seperti skor, ROE, atau rasio dividen."],
      ["Pengenalan batas", "Memisahkan tugas penyaringan saham dari analisis saham tunggal, pengecekan harga, dan tugas lainnya."],
    ],
    "Jelaskan pasarnya, strategi penyaringan, syarat indikator, cara penggabungan, dan kebutuhan pengurutannya; bila ingin menganalisis satu saham, sebutkan sebagai tugas terpisah.",
    "Saring saham A-share dengan ROE tinggi, valuasi rendah, dan tren naik yang baru terbentuk, lalu tampilkan syarat penyaringan, hasilnya, dan dasar pengurutannya.",
  ),
  "xiaohongshu-content-tools": makeOverview(
    [
      "Asisten Wawasan Data dan Analisis Pesaing Xiaohongshu membantu Agent melakukan analisis operasional melalui data konten dan akun di Xiaohongshu.",
      "Berikan kata kunci, tautan catatan atau komentar, cakupan kreator, dan tujuan analisisnya. Skill ini akan membantu menggali konten berperforma tinggi, membandingkan pesaing, menyaring KOL, dan merapikan sinyal trennya.",
    ],
    [
      ["Pengelola akun Xiaohongshu", "Perlu memakai data untuk menemukan topik dan peluang konten."],
      ["Tim pemasaran brand", "Ingin membandingkan konten dan performa akun pesaing."],
      ["Peneliti kreator dan KOL", "Perlu menyaring akun atau karya yang sesuai dengan kriterianya."],
    ],
    [
      ["Pemilihan topik bergantung firasat", "Mencari sinyal konten dari kata kunci dan catatan berperforma tinggi."],
      ["Pesaing sulit dibandingkan", "Menempatkan catatan, komentar, dan informasi kreator pada dimensi yang seragam."],
      ["Perubahan tren tidak kentara", "Menghimpun data untuk membantu mengenali tema populer dan perubahannya."],
    ],
    [
      ["Pencarian kata kunci", "Mencari konten dan tema terkait di Xiaohongshu."],
      ["Analisis catatan dan komentar", "Merapikan performa catatan, komentar, dan umpan balik penggunanya."],
      ["Perbandingan pesaing", "Membandingkan akun, karya, dan arah konten pesaing."],
      ["Penyaringan KOL", "Mencari akun yang sesuai berdasarkan tujuan dan kriteria datanya."],
    ],
    "Berikan kata kunci, industri sasaran, akun pesaing, atau tautan kontennya, lalu jelaskan apakah Anda ingin menganalisis topik, pesaing, KOL, atau tren.",
    "Analisis catatan populer tentang perlengkapan berkemah di Xiaohongshu belakangan ini, saring kebutuhan yang sering muncul, perbedaan konten pesaing, dan topik yang cocok ditindaklanjuti brand.",
  ),
  "quant-backtest-strategy": makeOverview(
    [
      "Mesin Strategi Backtest Kuantitatif A-share membantu Agent menjalankan backtest historis, analisis sinyal, dan perapian hasil untuk strategi kuantitatif.",
      "Berikan cakupan sahamnya, aturan strategi, periode backtest, sumber data, dan parameter risikonya. Skill ini dapat mengeluarkan indikator backtest, catatan transaksi, grafik, atau berkas hasil, tetapi bukan berarti melakukan pemesanan otomatis di pasar riil.",
    ],
    [
      ["Pembelajar kuantitatif", "Perlu memahami performa strategi memakai data historis."],
      ["Investor perorangan", "Ingin memverifikasi aturan dan risikonya sebelum mengambil keputusan."],
      ["Analis data Python", "Perlu menjalankan strategi secara massal atau mengekspor data risetnya."],
    ],
    [
      ["Strategi tidak dapat diverifikasi", "Menguji aturan dan parameternya pada rentang waktu historis."],
      ["Hasil sulit dibandingkan", "Menyeragamkan keluaran imbal hasil, penurunan maksimum, dan statistik transaksinya."],
      ["Risiko mudah terabaikan", "Menampilkan keterbatasan backtest, cakupan data, dan kemungkinan risiko overfitting."],
    ],
    [
      ["Backtest historis", "Menjalankan strategi seperti MA, RSI, dan MACD pada periode dan aset yang ditentukan."],
      ["Sinyal teknis", "Mengenali titik beli-jual dan kondisi teknis terkait."],
      ["Analisis risiko", "Merapikan informasi risiko seperti penurunan nilai, posisi, serta batas rugi dan ambil untung."],
      ["Ekspor hasil", "Menghasilkan catatan transaksi, grafik, atau hasil riset dalam Excel."],
    ],
    "Jelaskan cakupan asetnya, aturan strategi, periodenya, sumber data, dan parameter risikonya, serta pastikan lebih dulu bahwa ini hanya backtest tanpa pemesanan di pasar riil.",
    "Backtest strategi rata-rata bergerak 20/60 hari pada data harian Kweichow Moutai lima tahun terakhir, keluarkan imbal hasil, penurunan maksimum, jumlah transaksi, dan catatan setiap transaksinya.",
  ),
  "topnews": makeOverview(
    [
      "Asisten AI Sentimen Saham membantu Agent menghimpun data pasar waktu nyata, berita keuangan, dan informasi aliran dana menjadi ringkasan kondisi pasar hari itu.",
      "Berikan pasar, industri, saham, atau rentang waktunya. Skill ini akan merapikan pergerakan harga, berita singkat, berita makro dan internasional, dana northbound, margin trading, dan sinyal lainnya, lalu menandai dasar penilaian cenderung naik, cenderung turun, atau bergerak menyamping.",
    ],
    [
      ["Investor", "Perlu cepat memahami latar pasar sebelum mulai bertransaksi."],
      ["Peneliti", "Ingin mengamati pergerakan harga, berita, dan sinyal dana secara bersamaan."],
      ["Pemantau risiko", "Perlu terus mengikuti perubahan kebijakan, situasi internasional, dan sentimen."],
    ],
    [
      ["Sumber informasi tersebar", "Menempatkan pergerakan harga, berita, makro, dan aliran dana dalam satu ringkasan."],
      ["Dampak berita tidak jelas", "Menjelaskan pasar atau aset yang berpotensi terpengaruh sebuah peristiwa."],
      ["Belum ada penilaian harian", "Merapikan dasar penilaian pasar cenderung naik, turun, atau menyamping dari sinyal multidimensi."],
    ],
    [
      ["Data pasar waktu nyata", "Melihat data saham AS, kontrak berjangka, dan pasar terkait."],
      ["Berita keuangan singkat", "Menghimpun berita keuangan seperti Cailianshe dan mengelompokkan sentimennya."],
      ["Pengamatan aliran dana", "Merapikan sinyal seperti dana northbound dan margin trading."],
      ["Kesimpulan pasar", "Menggabungkan informasinya menjadi ringkasan kondisi dan risiko hari itu."],
    ],
    "Jelaskan pasar, industri, saham, atau tanggal yang ingin Anda pantau, lalu minta Agent memisahkan data waktu nyata, fakta berita, dan kesimpulan yang bersifat dugaan.",
    "Rangkum berita utama pasar A-share hari ini, dana northbound, dan performa industrinya, nilai apakah pasar cenderung naik, turun, atau menyamping, lalu sebutkan dasar penilaiannya.",
  ),
  "unclecheng-reduce-ai-perception-v2": makeOverview(
    [
      "Alat Penghilang Kesan AI membantu Agent mendeteksi dan mengurangi jejak tulisan AI yang kentara di dalam teks, sehingga penyampaiannya lebih mendekati tulisan manusia yang wajar.",
      "Berikan teks aslinya, pembaca sasaran, konteks pemakaian, dan nada yang ingin Anda pertahankan. Skill ini akan menangani frasa klise, kata sambung yang mekanis, struktur yang berlebihan, objektivitas yang palsu, dan penutup yang seperti rumus, sambil berusaha mempertahankan maksud aslinya.",
    ],
    [
      ["Editor konten", "Perlu membuat draf hasil mesin terasa lebih wajar."],
      ["Penulis pemasaran dan media sosial", "Ingin memperbaiki penyampaian tanpa mengorbankan ketepatan informasinya."],
      ["Pengguna yang perlu menulis ulang", "Ingin mengurangi nada yang terasa seperti templat tanpa mengubah faktanya."],
    ],
    [
      ["Teks terlalu seperti templat", "Mengenali ungkapan khas AI dan struktur yang berulang."],
      ["Nada terasa tidak wajar", "Membuat kalimatnya lebih sesuai dengan pembaca dan konteksnya."],
      ["Penulisan ulang mengubah maksud", "Mengutamakan pemeliharaan fakta, pandangan, dan informasi kuncinya."],
    ],
    [
      ["Deteksi jejak", "Mengenali kata yang terlalu sering muncul, kata sambung mekanis, dan hiasan yang berlebihan."],
      ["Penulisan ulang yang wajar", "Menyesuaikan pola kalimat, ritme, dan cara penyampaiannya."],
      ["Pemeliharaan gaya", "Mengendalikan nada sesuai pembaca dan konteksnya."],
      ["Pemeliharaan fakta", "Mempertahankan fakta dan pandangan utama teks asli saat menyuntingnya."],
    ],
    "Tempelkan teks aslinya, jelaskan pembaca sasaran, konteks publikasi, nadanya, serta fakta atau pandangan yang tidak boleh diubah, lalu minta Agent menulis ulang dan menandai perubahan utamanya.",
    "Ubah perkenalan produk ini agar lebih terasa ditulis penulis profesional, kurangi ungkapan yang seperti templat, dan pertahankan semua fakta, angka, serta nama produknya.",
  ),
  "douyin-copy-extract": makeOverview(
    [
      "Ekstraksi Naskah Douyin Sekali Klik membantu Agent merapikan judul, deskripsi, dan naskah narasi dari tautan video pendek yang bersifat publik.",
      "Berikan tautan berbagi publik dari Douyin, Kuaishou, Xiaohongshu, atau WeChat Channels, lalu pilih versi asli, versi yang dioptimalkan untuk dibacakan, atau versi ringkas. Skill ini juga dapat menandai kata sensitif dan memperkirakan durasi narasinya.",
    ],
    [
      ["Pengelola video pendek", "Perlu cepat memakai ulang atau meneliti naskah video yang sudah ada."],
      ["Peneliti konten", "Ingin mengekstrak judul, deskripsi, dan struktur narasinya."],
      ["Editor skrip video", "Perlu merapikan narasi asli menjadi versi yang lebih mudah dipakai."],
    ],
    [
      ["Merapikan naskah menyita waktu", "Mengekstrak isi teksnya secara terpusat dari halaman berbagi publik."],
      ["Narasi sulit dipakai langsung", "Menyediakan versi yang dioptimalkan untuk dibacakan."],
      ["Skrip terlalu panjang atau berisiko", "Menyediakan hasil ringkas, penanda kata sensitif, dan acuan durasinya."],
    ],
    [
      ["Ekstraksi dari tautan", "Membaca informasi naskah dari tautan berbagi video pendek yang publik."],
      ["Keluaran multiversi", "Menyediakan versi asli, versi untuk dibacakan, dan versi ringkas sekaligus."],
      ["Penanda kata sensitif", "Menunjukkan ungkapan yang mungkin perlu diperiksa manusia."],
      ["Acuan durasi", "Memperkirakan waktu narasi berdasarkan panjang naskahnya."],
    ],
    "Tempelkan tautan berbagi video pendek yang dapat diakses publik, lalu jelaskan apakah Anda butuh naskah asli, versi bacaan, versi ringkas, atau semuanya.",
    "Ekstrak judul, deskripsi, dan naskah narasi video Douyin ini, lalu berikan satu versi ringkas yang lebih cocok untuk narasi 60 detik.",
  ),
  "g113593": makeOverview(
    [
      "Asisten Penulisan Novel Fanqie membantu Agent menulis novel daring panjang bab demi bab, cocok untuk genre misteri, roman, fantasi, fiksi ilmiah, dan sejarah.",
      "Berikan genrenya, latar dunia, penokohan, sasaran bab, dan jalan cerita yang sudah ada. Skill ini akan menghasilkan draf bab yang dapat terus disunting, dengan memperhatikan panjang bab, ritme emosi, titik puncak, dan ketegangan di akhir bab.",
    ],
    [
      ["Penulis novel daring", "Perlu terus menulis dan memelihara jalan cerita bab panjang."],
      ["Perencana novel", "Ingin menjaga penokohan, latar dunia, dan sasaran bab tetap konsisten."],
      ["Editor konten", "Perlu memeriksa ritme bab, ketegangan, dan daya tariknya bagi pembaca."],
    ],
    [
      ["Cerita panjang mudah kehilangan benang merah", "Terus merujuk penokohan dan tatanan ceritanya saat menulis bab baru."],
      ["Bab kehilangan ritme", "Menata sebaran emosi, konflik, dan titik puncaknya."],
      ["Akhir bab tak memancing lanjut membaca", "Menempatkan kail ketegangan di akhir yang terkait dengan jalan cerita berikutnya."],
    ],
    [
      ["Penulisan bab", "Menghasilkan konten sepanjang yang disepakati sesuai genre dan sasaran babnya."],
      ["Kesinambungan cerita", "Melanjutkan tulisan dengan mempertimbangkan cerita, tokoh, dan latar dunia yang sudah ada."],
      ["Ritme emosi", "Menata konflik, tarik-menarik, dan titik puncak babnya."],
      ["Akhir yang menggantung", "Meninggalkan kail yang jelas untuk bab berikutnya tanpa membocorkan terlalu banyak."],
    ],
    "Berikan genre, latar dunia, penokohan, ringkasan cerita sebelumnya, dan sasaran bab ini; sepakati dulu arah babnya, baru minta Agent menghasilkan drafnya.",
    "Tulis bab keenam berdasarkan latar dunia dan ringkasan lima bab sebelumnya, panjangnya sekitar 2.400 kata, perkuat konflik antartokoh, dan tinggalkan ketegangan baru di akhirnya.",
  ),
  "weixin-article-writer": makeOverview(
    [
      "Alat Penulisan WeChat Official Account membantu Agent menulis artikel keuangan dan investasi untuk akun resmi, dengan menekankan fakta, disiplin dalam menyimpulkan, dan kenyamanan membaca di perangkat seluler.",
      "Berikan topiknya, materi, data, pembaca sasaran, dan fokus artikelnya. Skill ini akan menelaah topiknya lebih dulu, lalu menyusun artikel analisis dengan kepadatan informasi yang tinggi sambil berusaha mengurangi jejak tulisan AI.",
    ],
    [
      ["Penulis konten keuangan", "Perlu menghasilkan artikel akun resmi yang profesional secara konsisten."],
      ["Tim riset dan investasi", "Ingin mengubah data dan pandangannya menjadi artikel untuk publik."],
      ["Pengelola akun resmi", "Perlu menyeimbangkan fakta, keterbacaan, dan kenyamanan membaca di ponsel."],
    ],
    [
      ["Topik mudah kehilangan fokus", "Memeriksa nilai topik, cakupan, dan materi yang tersedia lebih dahulu."],
      ["Fakta dan dugaan tercampur", "Memisahkan fakta yang diketahui, analisis, dan penilaian yang masih belum pasti."],
      ["Artikel panjang tidak nyaman di ponsel", "Memperbaiki pengalaman membaca dengan struktur yang jelas dan paragraf yang lebih pendek."],
    ],
    [
      ["Telaah topik", "Menilai apakah tema, materi, dan pembaca sasarannya sudah selaras."],
      ["Narasi keuangan", "Menyusun analisis yang mandiri dan rasional memakai data dan bukti."],
      ["Disiplin menyimpulkan", "Memisahkan fakta, dugaan, dan hal yang masih perlu diverifikasi."],
      ["Tata letak seluler", "Menghasilkan struktur dan paragraf yang nyaman dibaca di akun resmi."],
    ],
    "Berikan temanya, materi, data, pembaca sasaran, dan pandangan intinya; minta Agent memeriksa materi dan argumennya lebih dulu, baru menghasilkan draf artikelnya.",
    "Tulis artikel keuangan untuk akun resmi berdasarkan materi ini, maksimal 2.500 kata, dengan nada rasional dan terkendali, pisahkan fakta dari dugaan, dan buat nyaman dibaca di ponsel.",
  ),
  "lingyi-wx-viral-script-generator": makeOverview(
    [
      "Pembuat Naskah Viral WeChat Channels membantu Agent menghasilkan naskah narasi untuk WeChat Channels berdasarkan tujuan kreatif dan topiknya.",
      "Berikan tujuan pembuatannya, industri, audiens sasaran, dan topiknya; bila informasinya belum lengkap, Anda dapat melengkapinya lewat pertanyaan lanjutan atau meminta draf percobaan dari informasi yang ada. Keluarannya ditata menurut Hook, bagian tengah, CTA, dan penanda ritmenya.",
    ],
    [
      ["Kreator WeChat Channels", "Perlu cepat menyusun naskah narasi yang siap direkam."],
      ["Praktisi pemasaran brand", "Ingin menguji berbagai topik seputar industri dan audiensnya."],
      ["Tim video pendek", "Perlu draf naskah yang dapat disunting dan dipakai ulang."],
    ],
    [
      ["Topik sulit dibuka", "Memakai Hook di bagian awal untuk membangun alasan menonton."],
      ["Ritme naskah longgar", "Menata konten menurut informasi bagian tengah dan ritmenya."],
      ["Tidak ada arahan bertindak", "Menambahkan CTA di bagian akhir yang selaras dengan tujuannya."],
    ],
    [
      ["Pembuatan naskah", "Menghasilkan draf narasi berdasarkan tujuan, industri, audiens, dan topiknya."],
      ["Perancangan Hook", "Menyediakan pintu masuk perhatian yang jelas di bagian awal."],
      ["Penanda ritme", "Menandai laju penyampaian konten dan ritme narasinya."],
      ["Keluaran CTA", "Merancang arahan bertindak di akhir yang berpusat pada tujuan kreatifnya."],
    ],
    "Berikan tujuan pembuatannya, industri, audiens, dan topiknya; kalau untuk sementara Anda hanya punya satu gagasan, Anda juga bisa meminta Agent melengkapi arah naskahnya.",
    "Tulis naskah narasi 60 detik untuk WeChat Channels yang menyasar pekerja pemula, bertema cara memakai AI untuk merapikan catatan rapat, lengkap dengan Hook yang kuat, tiga poin utama, dan CTA yang terasa wajar.",
  ),
  "govwriter-pro": makeOverview(
    [
      "Lingxi untuk Penulisan Dokumen Resmi membantu Agent menyusun atau menata ulang dokumen resmi pemerintahan, lalu mengeluarkannya sebagai berkas Word yang mengikuti format dokumen resmi instansi.",
      "Berikan temanya, kerangka, materi teks asli, materi terdahulu, dan jenis dokumen yang diminta. Skill ini mendukung penataan ulang dari konten yang sudah ada maupun pembuatan draf dari tema dan materinya, serta menangani formatnya menurut GB/T 9704-2012.",
    ],
    [
      ["Pegawai instansi pemerintah dan lembaga publik", "Perlu menyusun atau merapikan materi dokumen resmi."],
      ["Editor dokumen resmi", "Ingin menata ulang materinya menjadi naskah yang sesuai standar."],
      ["Staf administrasi", "Perlu mengeluarkan naskah final menjadi berkas Word."],
    ],
    [
      ["Materi belum terstruktur", "Merapikan tema, kerangka, dan materi yang ada menjadi naskah resmi."],
      ["Jenis dokumen dan nada tidak sesuai", "Menyesuaikan struktur konten menurut jenis dokumennya, seperti pemberitahuan atau laporan."],
      ["Standar tata letak sulit dikendalikan", "Menangani format dokumen Word sesuai standar yang berlaku."],
    ],
    [
      ["Mode penyuntingan", "Menata ulang dan menghaluskan naskah berdasarkan materi teks aslinya."],
      ["Mode penulisan", "Menghasilkan draf dari tema, kerangka, dan materi terdahulu."],
      ["Standar dokumen resmi", "Menata konten menurut ketentuan penulisan dokumen resmi instansi."],
      ["Keluaran Word", "Menghasilkan dokumen yang mengikuti GB/T 9704-2012."],
    ],
    "Jelaskan jenis dokumennya, tema, kerangka, materi teks asli, dan persyaratan formatnya, pilih mode penulisan atau penyuntingan, lalu periksa fakta dan tata letaknya secara manual sebelum diekspor.",
    "Tata ulang materi rapat ini menjadi pemberitahuan resmi, pertahankan fakta dan waktunya, lengkapi strukturnya, lalu keluarkan dokumen Word yang sesuai format dokumen resmi.",
  ),
  "tencent-docs": makeOverview(
    [
      "Tencent Docs membantu Agent membuat, membaca, menyunting, dan mengelola Tencent Docs beserta berkas kolaborasi daring lainnya.",
      "Berikan nama dokumen, tautan, ruang kerja, berkas, atau tindakan yang ingin diselesaikan. Skill ini mendukung alur pengelolaan umum untuk dokumen, spreadsheet, presentasi, peta pikiran, diagram alur, dan basis pengetahuan.",
    ],
    [
      ["Pengguna perkantoran sehari-hari", "Perlu menangani Tencent Docs dan berkas awan langsung dari percakapan."],
      ["Kolaborator tim", "Ingin mengelola dokumen bersama, ruang kerja, dan foldernya secara terpusat."],
      ["Pemelihara basis pengetahuan", "Perlu mencari, membaca, dan merapikan konten pengetahuan daring."],
    ],
    [
      ["Terlalu sering berpindah dokumen", "Membuat, membaca, dan menyunting dokumen daring dalam satu alur kerja."],
      ["Struktur berkas berantakan", "Mengelola ruang kerja, simpul, folder, dan perpindahan berkasnya."],
      ["Materi lokal sulit dibawa ke awan", "Mendukung impor berkas, HTML, atau dokumen ke awan."],
    ],
    [
      ["Dokumen daring", "Membuat, membaca, dan menyunting Tencent Docs."],
      ["Beragam jenis berkas", "Menangani spreadsheet, presentasi, peta pikiran, dan diagram alur."],
      ["Pengelolaan ruang kerja", "Membuat ruang basis pengetahuan serta mengelola simpul dan foldernya."],
      ["Pengelolaan berkas", "Mengganti nama, memindahkan, menyalin, menghapus, mengimpor, dan mengekspor berkas."],
    ],
    "Jelaskan dokumen atau ruang kerja yang ingin dioperasikan, tindakan sasarannya, dan konteks izinnya; bila perlu sertakan tautan Tencent Docs atau isi berkasnya.",
    "Buat laporan mingguan proyek baru di ruang Tencent Docs saya, berisi kemajuan pekan ini, risiko, rencana pekan depan, dan penanggung jawabnya, lalu beri tahu tautan dokumennya.",
  ),
  "pdf-image-text-extractor": makeOverview(
    [
      "Ekstraksi Teks dari PDF dan Gambar membantu Agent mengenali serta mengekstrak teks dari gambar atau PDF, lalu menghasilkan keluaran terstruktur yang dapat disunting.",
      "Unggah gambar atau PDF-nya, lalu jelaskan apakah Anda perlu mempertahankan urutan halaman, struktur tabel, paragraf, atau format aslinya. Skill ini akan mengenali apakah dokumennya memuat teks lalu mengembalikan hasil ekstraksinya.",
    ],
    [
      ["Pengolah dokumen", "Perlu mengubah hasil pindai atau isi gambar menjadi teks."],
      ["Tim riset dan operasional", "Ingin mengekstrak teks dari laporan dan materi secara massal."],
      ["Pengguna yang butuh OCR", "Ingin terus menyunting, mencari, atau merapikan isi gambar dan PDF."],
    ],
    [
      ["Hasil pindai tidak dapat disunting", "Mengubah teks di dalam gambar dan PDF menjadi teks yang dapat diolah."],
      ["Informasi format hilang", "Berusaha mempertahankan halaman, paragraf, dan strukturnya."],
      ["Isi dokumen sulit dicari", "Menghasilkan teks yang dapat terus ditelusuri dan dirapikan."],
    ],
    [
      ["OCR gambar", "Mengenali teks pada format gambar yang umum."],
      ["Ekstraksi PDF", "Membaca isi teks pada halaman PDF."],
      ["Pemeliharaan struktur", "Merapikan hasilnya menurut halaman dan struktur aslinya."],
      ["Keluaran siap sunting", "Menghasilkan teks yang mudah disalin, dicari, dan diolah lebih lanjut."],
    ],
    "Unggah gambar atau PDF-nya, lalu jelaskan apakah Anda butuh teks murni, tata letak yang dipertahankan, ekstraksi tabel, atau keluaran per halaman.",
    "Ekstrak semua teks dari PDF hasil pindai ini, rapikan menurut nomor halaman, pertahankan judul dan struktur tabelnya, lalu tandai area yang tidak dapat dikenali.",
  ),
  "pptx-generator": makeOverview(
    [
      "PPT Generator membantu Agent menghasilkan PowerPoint PPTX yang standar dan dapat disunting berdasarkan tema dan kontennya.",
      "Berikan temanya, audiens sasaran, jumlah halaman, materi konten, palet warna, dan data grafiknya. Skill ini akan menata strukturnya menurut jenis slide, serta mendukung konten berupa grafik, tabel, garis waktu, dan gambar.",
    ],
    [
      ["Praktisi pelaporan dan operasional", "Perlu cepat merapikan materi menjadi presentasi yang dapat disunting."],
      ["Tim produk dan penjualan", "Ingin menghasilkan presentasi berstruktur jelas sesuai audiensnya."],
      ["Praktisi pelatihan dan pendidikan", "Perlu mengubah materi kursus atau proposal menjadi PPT."],
    ],
    [
      ["Materi sulit dipecah jadi halaman", "Memecah teks panjang dan poin-poinnya menjadi struktur slide yang wajar."],
      ["Format visual tidak seragam", "Menjaga palet warna dan tata letak tetap konsisten di seluruh presentasi."],
      ["Membuat grafik menyita waktu", "Menghasilkan halaman grafik, tabel, dan garis waktu dari datanya."],
    ],
    [
      ["Struktur slide", "Mendukung berbagai jenis slide yang umum dipakai."],
      ["Palet tema", "Membangun visual yang seragam dari palet bawaan atau warna brand yang ditentukan."],
      ["Halaman data", "Menghasilkan grafik, tabel, dan garis waktu."],
      ["Keluaran PPTX", "Menghasilkan berkas PowerPoint yang dapat terus disunting."],
    ],
    "Berikan temanya, audiens, jumlah halaman, konten, palet warna, dan materinya, lalu jelaskan halaman mana yang perlu grafik, tabel, atau garis waktu.",
    "Ubah tinjauan bisnis kuartalan ini menjadi PPT 10 halaman untuk manajemen, gunakan palet biru tua, lengkapi dengan grafik tren, halaman risiko, garis waktu, dan rencana kuartal berikutnya.",
  ),
  "gongwenformat-pro": makeOverview(
    [
      "Penata Format Dokumen Resmi membantu Agent mengubah konten Markdown, TXT, atau DOCX menjadi dokumen Word resmi yang mengikuti GB/T 9704-2012.",
      "Berikan teks atau berkas aslinya, lalu jelaskan jenis dokumen, judul, nomor surat, penandatangan, dan kebutuhan tata letaknya. Skill ini akan merapikan tata letaknya sesuai format dokumen resmi agar mudah diekspor dan diperiksa manusia.",
    ],
    [
      ["Staf perkantoran instansi", "Perlu menata materi menjadi dokumen resmi."],
      ["Staf administrasi dan kesekretariatan", "Ingin mengurangi pekerjaan menyetel format di Word."],
      ["Tim yang butuh dokumen berstandar", "Ingin menyeragamkan judul, isi, catatan penerbitan, dan format halamannya."],
    ],
    [
      ["Konten dan tata letak terpisah", "Mengubah materi yang sudah ada langsung menjadi dokumen berstandar."],
      ["Format mudah salah", "Menangani ukuran huruf, jarak, dan struktur halaman sesuai standar."],
      ["Menata format berulang menyita waktu", "Menyediakan alur penataan yang dapat dipakai ulang untuk jenis dokumen yang umum."],
    ],
    [
      ["Konversi format", "Mengubah Markdown, TXT, atau DOCX menjadi Word."],
      ["Tata letak dokumen resmi", "Menangani struktur judul, isi, nomor surat, dan catatan penerbitannya."],
      ["Penyesuaian jenis dokumen", "Mendukung konteks seperti pemberitahuan, permohonan arahan, laporan, surat, dan catatan rapat."],
      ["Keluaran berstandar", "Menghasilkan dokumen sesuai GB/T 9704-2012 untuk diperiksa manusia."],
    ],
    "Unggah atau tempelkan teks aslinya, jelaskan jenis dokumen dan persyaratan tata letak resminya, lalu setelah dihasilkan periksa nama khusus, tanggal, nomor halaman, dan tata letaknya.",
    "Tata materi rapat Markdown ini menjadi catatan rapat resmi dalam Word dengan format dokumen resmi standar, pertahankan seluruh fakta dan informasi pembicaranya.",
  ),
  "meeting-notes-assistant": makeOverview(
    [
      "Meeting Notes Assistant membantu Agent merapikan rekaman rapat atau hasil transkripsinya menjadi catatan rapat yang terstruktur.",
      "Berikan audio, teks transkripsi, atau materi rapatnya, lalu jelaskan waktu rapat, pesertanya, dan format keluarannya. Skill ini akan menyaring agenda, kesimpulan, tugas, penanggung jawab, dan kata kuncinya, serta mendukung keluaran Word, PDF, atau email.",
    ],
    [
      ["Penyelenggara rapat", "Perlu cepat menyusun catatan yang siap dibagikan setelah rapat."],
      ["Pemimpin proyek", "Ingin memperjelas kesimpulan, tugas, dan penanggung jawabnya."],
      ["Tim yang perlu menjaga privasi", "Cenderung memakai transkripsi lokal untuk mengurangi pengiriman audio ke luar."],
    ],
    [
      ["Rekaman sulit dirapikan", "Menyaring catatan yang mudah dibaca dari audio atau transkripsinya."],
      ["Tugas mudah terlewat", "Mendaftarkan butir tindakan, penanggung jawab, dan tenggatnya secara terpisah."],
      ["Kesimpulan rapat sulit dilacak", "Menata diskusi, kesimpulan, dan tindak lanjutnya menurut agenda."],
    ],
    [
      ["Transkripsi lokal", "Memakai Whisper lokal untuk mengubah audio rapat menjadi teks."],
      ["Penstrukturan catatan", "Merapikan waktu, agenda, kesimpulan, tugas, dan kata kuncinya."],
      ["Action Items", "Menyaring tugas, penanggung jawab, dan langkah berikutnya."],
      ["Keluaran multiformat", "Menghasilkan catatan rapat dalam bentuk Word, PDF, atau email."],
    ],
    "Unggah audio rapat atau teks transkripsinya, lengkapi nama rapat, waktu, peserta, dan format keluarannya, lalu periksa transkripsi dan daftar tugasnya sebelum dikirim.",
    "Rapikan rekaman rapat ini menjadi catatan rapat, daftarkan kesimpulan dan tugas menurut agenda, tandai penanggung jawab dan tenggat setiap butirnya, lalu keluarkan dalam format email.",
  ),
  "bid-tender-master": makeOverview(
    [
      "Master Dokumen Tender membantu Agent menghasilkan draf dokumen penawaran berdasarkan nama proyek, anggaran, dan informasi industrinya.",
      "Berikan nama proyek, anggaran, jenis pengadaan, kriteria penilaian, profil perusahaan, dan templat yang tersedia. Skill ini akan menata materinya menurut pengadaan barang, proyek jasa, atau pekerjaan konstruksi, serta mengingatkan konsistensi penawaran harga dan risiko diskualifikasi.",
    ],
    [
      ["Tim tender", "Perlu cepat membangun draf dokumen penawaran yang lengkap."],
      ["Praktisi penjualan dan bisnis", "Ingin merapikan materi penawaran sesuai persyaratan proyeknya."],
      ["Pemimpin proyek", "Perlu memeriksa anggaran, butir tanggapan, dan risikonya."],
    ],
    [
      ["Materi tender tersebar", "Menata persyaratan proyek, anggaran, dan profil perusahaan ke dalam satu dokumen."],
      ["Menyusun dokumen menyita waktu", "Menghasilkan draf penawaran yang dapat disunting menurut industri dan templatnya."],
      ["Risiko diskualifikasi sulit terdeteksi", "Mengingatkan masalah format, tanggapan, dan penawaran harga sebelum diserahkan."],
    ],
    [
      ["Penyesuaian industri", "Mencakup konteks pengadaan barang, proyek jasa, dan pekerjaan konstruksi."],
      ["Pembuatan bertahap", "Menata dokumen penawaran yang panjang secara bertahap."],
      ["Konsistensi penawaran harga", "Memeriksa apakah anggaran dan harga di dalam dokumennya sudah konsisten."],
      ["Pemeriksaan risiko mandiri", "Mengingatkan masalah materi dan format yang berpotensi menyebabkan diskualifikasi."],
    ],
    "Berikan nama proyek, anggaran, industri, persyaratan tender, materi perusahaan, dan templatnya; hasilkan drafnya lebih dulu, lalu minta tenaga profesional memeriksanya butir demi butir.",
    "Hasilkan draf dokumen penawaran berdasarkan persyaratan tender proyek pengadaan jasa ini dan profil perusahaannya, seragamkan penawaran harganya, lalu sebutkan materi yang belum ada dan kemungkinan risiko diskualifikasinya.",
  ),
  "k12-smart-teacher": makeOverview(
    [
      "Guru Pintar K12 menyediakan dukungan pemeriksaan tugas, analisis soal yang salah, dan pembuatan latihan untuk konteks belajar sekolah dasar, menengah pertama, dan menengah atas, mencakup mata pelajaran seperti Bahasa, Matematika, Bahasa Inggris, Fisika, Kimia, Biologi, Sejarah, Geografi, dan Kewarganegaraan.",
      "Berikan jenjangnya, mata pelajaran, materi tugas atau soal yang salah, serta tingkat kesulitan dan bentuk latihan yang diinginkan. Skill ini dapat mengeluarkan umpan balik pemeriksaan, analisis titik lemah, dan latihan tiga tingkat berupa dasar, lanjutan, dan tantangan, dengan dukungan format Markdown atau JSON.",
    ],
    [
      ["Siswa dan orang tua", "Perlu memahami soal yang salah dan mendapat latihan yang tepat sasaran."],
      ["Guru sekolah dasar dan menengah", "Ingin mengurangi pemeriksaan berulang dan cepat membuat latihan berjenjang."],
      ["Tim bimbingan dan produk pendidikan", "Perlu alur bimbingan yang mencakup berbagai jenjang dan mata pelajaran."],
    ],
    [
      ["Pemeriksaan berulang menyita waktu", "Merapikan hasil tugas dan memberi umpan balik pemeriksaan yang jelas."],
      ["Penyebab kesalahan tidak jelas", "Menyimpulkan titik lemah pengetahuan dari kesalahan yang terjadi."],
      ["Tingkat kesulitan latihan tidak cocok", "Menghasilkan latihan menurut tingkat dasar, lanjutan, dan tantangan."],
    ],
    [
      ["Pemeriksaan tugas", "Memeriksa tugas serta menjelaskan kesalahan dan arah perbaikannya."],
      ["Analisis soal yang salah", "Menyimpulkan jenis kesalahan dan materi yang perlu diulang."],
      ["Latihan berjenjang", "Menghasilkan latihan tiga tingkat: dasar, lanjutan, dan tantangan."],
      ["Dukungan multimata pelajaran", "Mencakup beberapa jenjang dan mata pelajaran utama sekolah menengah."],
    ],
    "Berikan jenjang, mata pelajaran, isi tugas atau soal yang salah, lalu jelaskan apakah Anda butuh pemeriksaan, analisis, atau latihan pada tingkat tertentu.",
    "Analisis tugas Matematika sekolah menengah pertama ini, sebutkan penyebab setiap soal yang salah, lalu hasilkan tiga kelompok latihan serupa untuk tingkat dasar, lanjutan, dan tantangan.",
  ),
  "interview-simulator": makeOverview(
    [
      "Interview Simulator membantu Agent menyimulasikan wawancara untuk berbagai posisi dan tingkat pengalaman, menyediakan pertanyaan teknis, perilaku, dan studi kasus yang disesuaikan, sekaligus memberi umpan balik dan penilaian.",
      "Berikan posisi sasaran, tingkat pengalaman, CV atau latar belakang, jenis wawancara, dan arah yang ingin Anda latih secara khusus. Skill ini akan menata pertanyaan simulasinya, membantu Anda menjawab satu per satu, lalu menelaah performanya.",
    ],
    [
      ["Pencari kerja", "Perlu berlatih wawancara untuk posisi yang disasar."],
      ["Lulusan baru dan pengalih karier", "Ingin membiasakan diri dengan pertanyaan teknis, perilaku, dan studi kasus."],
      ["Tim rekrutmen dan pelatihan", "Perlu menyediakan latihan terstruktur bagi kandidat atau karyawan."],
    ],
    [
      ["Latihan kurang terasa nyata", "Menata wawancara simulasi menurut posisi dan tingkat pengalamannya."],
      ["Pertanyaan terlalu umum", "Menyediakan pertanyaan yang disesuaikan dengan posisi sasarannya."],
      ["Jawaban tanpa umpan balik", "Menopang penelaahan dengan penilaian dan saran yang konkret."],
    ],
    [
      ["Penyesuaian posisi", "Menghasilkan pertanyaan berdasarkan posisi sasaran dan tingkat pengalamannya."],
      ["Beragam jenis wawancara", "Mencakup pertanyaan teknis, perilaku, dan studi kasus."],
      ["Tanya jawab simulasi", "Melatih jawaban satu per satu mengikuti ritme wawancara."],
      ["Umpan balik dan penilaian", "Merangkum kelebihan dan arah perbaikan dari performa jawabannya."],
    ],
    "Jelaskan posisi sasaran, tingkat pengalaman, CV atau latar belakang Anda, serta jenis wawancara yang ingin dilatih, lalu mulai simulasinya satu per satu.",
    "Simulasikan wawancara untuk frontend engineer dengan pengalaman 3 tahun, ajukan pertanyaan teknis dahulu lalu pertanyaan perilaku, dan setelah setiap jawaban berikan penilaian serta saran perbaikannya.",
  ),
  "academic-learning-assistant": makeOverview(
    [
      "Pembuat Pakar Mata Pelajaran adalah asisten belajar personal untuk konteks sekolah, universitas, dan pelatihan vokasi, dengan dukungan penjelasan materi, pemeriksaan tugas, dan bimbingan pada titik lemah.",
      "Berikan jenjang belajar, mata pelajaran, tujuan belajar, buku ajar atau soalnya, serta soal yang pernah salah dan preferensi belajar Anda. Dari situ skill ini dapat menata jalur belajar, menjelaskan materi, membuat latihan, dan memberi saran pengulangan.",
    ],
    [
      ["Siswa sekolah dan mahasiswa", "Perlu penjelasan mata pelajaran dan dukungan tugas secara berkelanjutan."],
      ["Orang tua dan guru", "Ingin mengetahui titik lemah belajarnya dan menyiapkan bimbingannya."],
      ["Pembelajar vokasi", "Perlu jalur belajar yang disesuaikan dengan tujuan dan kemampuan dasarnya."],
    ],
    [
      ["Rencana belajar sulit disusun", "Merapikan jalur belajar yang dapat dijalankan sesuai tujuan dan kemampuan dasarnya."],
      ["Terhenti saat menemui soal yang salah", "Menjelaskan materinya dan menyiapkan latihan di sekitar titik lemahnya."],
      ["Bimbingan kurang personal", "Menyesuaikan penjelasan dengan jenjang, mata pelajaran, dan preferensinya."],
    ],
    [
      ["Jalur personal", "Menata materi belajar menurut tujuan, kemampuan dasar, dan kemajuannya."],
      ["Masukan multimodal", "Mendukung materi belajar berupa teks, gambar, dan suara."],
      ["Dukungan tugas dan soal salah", "Menjelaskan soalnya dan menyimpulkan bagian yang perlu diperkuat."],
      ["Bimbingan mata pelajaran", "Mencakup pembelajaran materi di berbagai jenjang dan mata pelajaran."],
    ],
    "Berikan jenjang belajar, mata pelajaran, tujuan, buku ajar atau soalnya, lalu jelaskan kemampuan dasar Anda saat ini dan bagian yang ingin diperbaiki.",
    "Saya sedang menyiapkan ujian Biologi sekolah menengah atas; susun jalur belajar berdasarkan soal yang salah ini dan waktu belajar saya, jelaskan dulu materi yang masih lemah, lalu berikan latihannya.",
  ),
  "subject-hyn": makeOverview(
    [
      "Asisten Proposal Penelitian membantu guru menulis, menyunting, dan menyempurnakan dokumen pengajuan serta penilaian proposal penelitian, sekaligus merapikan struktur dan penyampaian yang dibutuhkan.",
      "Berikan tema penelitiannya, objek kajian, draf pengajuan yang sudah ada, persyaratan sekolah, dan bagian yang perlu diperbaiki secara khusus. Skill ini akan membantu memeriksa struktur, memperkuat argumentasi, dan menyelaraskan materi pengajuannya; hasil akhirnya tetap perlu diperiksa manusia.",
    ],
    [
      ["Guru sekolah dasar dan menengah", "Perlu menyiapkan materi pengajuan dan penilaian proposal penelitian."],
      ["Ketua kelompok kajian pengajaran", "Ingin menyeragamkan struktur dan penyampaian materi pengajuannya."],
      ["Peneliti pendidikan", "Perlu merapikan pertanyaan penelitian, metode, dan alur pengajuannya."],
    ],
    [
      ["Struktur pengajuan belum lengkap", "Memeriksa bagian yang wajib ada dan cara penataannya di dalam pengajuan."],
      ["Nilai penelitian tidak tersampaikan", "Membantu menyatakan masalah, tujuan, dan maknanya dengan lebih jelas."],
      ["Bahasa pengajuan belum baku", "Menyeragamkan istilah, nada, dan penyampaian materinya."],
    ],
    [
      ["Penilaian pengajuan", "Memeriksa draf pengajuan dari sisi struktur dan isinya."],
      ["Penyempurnaan materi", "Menyunting tujuan penelitian, metode, dan argumentasinya sesuai persyaratan."],
      ["Struktur pengajuan", "Merapikan latar belakang, masalah, tujuan, dan rencana penelitiannya."],
      ["Penyampaian baku", "Membuat materinya lebih sesuai dengan gaya formal konteks pengajuan penelitian."],
    ],
    "Berikan tema penelitian, objek kajian, draf pengajuan, dan persyaratannya, lalu tunjukkan bagian mana yang ingin diperbaiki lebih dahulu.",
    "Berdasarkan draf pengajuan penelitian sekolah ini, periksa apakah masalah, tujuan, dan metode penelitiannya sudah selaras, lengkapi argumentasinya, lalu tulis ulang mengikuti struktur dokumen pengajuan.",
  ),
  "academic-paper-writing-assistant": makeOverview(
    [
      "Asisten Penulisan Karya Akademik membantu pengguna menata penulisan makalah empiris atau studi kasus kualitatif, dimulai dari kerangka dan materi penelitiannya.",
      "Berikan pertanyaan penelitian, kerangka makalah, data, metode penelitian, materi kasus, dan bahan pustakanya. Skill ini dapat membantu membangun struktur makalah, merapikan analisis dan penyajian grafiknya, serta menghasilkan draf yang dapat terus disunting.",
    ],
    [
      ["Mahasiswa", "Perlu melanjutkan penulisan makalah kuliah atau tugas akhir dari kerangka penelitiannya."],
      ["Peneliti dan asisten dosen", "Ingin merapikan struktur argumentasi riset empiris atau studi kasus."],
      ["Pembelajar analisis data", "Perlu menata data, metode, dan hasilnya menjadi isi makalah."],
    ],
    [
      ["Punya kerangka tetapi sulit mulai menulis", "Mengembangkan pertanyaan penelitian dan kerangkanya menjadi draf bab yang dapat disunting."],
      ["Metode dan hasil sulit disampaikan", "Merapikan cara penulisan data, statistik, dan analisisnya."],
      ["Argumentasi kasus tidak menyambung", "Menata materi riset kualitatif memakai kerangka argumentasi dan buktinya."],
    ],
    [
      ["Pengembangan kerangka", "Menata draf makalah berdasarkan pertanyaan penelitian dan kerangkanya."],
      ["Struktur makalah empiris", "Merapikan konten terkait data, statistik, regresi, dan grafiknya."],
      ["Struktur studi kasus kualitatif", "Menata bab di sekitar pohon argumentasi, kerangka analisis, dan buktinya."],
      ["Perapian pustaka", "Menyempurnakan latar dan argumentasi penelitian dengan bahan pustaka yang diberikan."],
    ],
    "Berikan pertanyaan penelitian, kerangka makalah, data atau materi kasus, metode penelitian, dan pustakanya, lalu jelaskan format sasaran dan cakupan babnya.",
    "Susun bab metode dan hasil penelitian berdasarkan kerangka riset dan hasil regresi ini, pertahankan semua datanya, jangan mengarang kesimpulan statistik, dan sebutkan bagian yang perlu saya konfirmasi.",
  ),
  "novel-evaluator": makeOverview(
    [
      "Sistem Penilaian Novel menilai sebuah novel secara terukur dari enam dimensi: alur, penokohan, gaya bahasa, latar dunia, emosi, dan kebaruan.",
      "Berikan naskah lengkap, bab, sinopsis, atau kerangka novelnya, lalu jelaskan jenis pembaca dan tujuan penilaian yang Anda perhatikan. Skill ini akan mengeluarkan skor per dimensi, kelebihan, masalah, dan umpan balik yang dapat dipakai untuk merevisi.",
    ],
    [
      ["Penulis novel", "Perlu memperoleh umpan balik terstruktur dan fokus revisi atas karyanya."],
      ["Editor dan tim konten", "Ingin membandingkan dan menilai naskah memakai dimensi yang seragam."],
      ["Pembelajar penulisan", "Perlu memahami performa sebuah karya pada berbagai dimensi."],
    ],
    [
      ["Umpan balik terlalu subjektif", "Menata dasar penilaian memakai enam dimensi yang tetap."],
      ["Letak masalah tidak jelas", "Memeriksa alur, penokohan, dan penyampaiannya secara terpisah."],
      ["Prioritas revisi belum jelas", "Merapikan arah perbaikan lanjutan berdasarkan skor dan umpan baliknya."],
    ],
    [
      ["Skor enam dimensi", "Menilai dari alur, penokohan, gaya bahasa, latar dunia, emosi, dan kebaruan."],
      ["Umpan balik terstruktur", "Mendaftarkan performa, masalah, dan dasarnya menurut dimensinya."],
      ["Penilaian menyeluruh", "Menghimpun kelebihan karya dan kekurangan yang memengaruhi pengalaman membaca."],
      ["Saran revisi", "Mengubah penilaiannya menjadi arah perbaikan penulisan yang dapat dijalankan."],
    ],
    "Berikan naskah lengkap, bab, sinopsis, atau kerangka novelnya, lalu jelaskan apakah Anda ingin menekankan penilaian menyeluruh, penokohan, perkembangan alur, atau dimensi lain.",
    "Nilai lima bab pertama novel ini dari enam dimensi, berikan skor setiap dimensi, tiga kelebihan yang paling menonjol, dan tiga masalah yang perlu diperbaiki lebih dahulu.",
  ),
  "ecommerce-product-selector": makeOverview(
    [
      "Pemilihan Produk E-commerce membantu Agent menyaring produk berpotensi berdasarkan platform dan sinyal pasarnya, dengan dukungan platform seperti Taobao, JD.com, Pinduoduo, Douyin, dan Amazon.",
      "Berikan platform sasaran, kategori, anggaran, kebutuhan pengguna, situasi persaingan, atau syarat penyaringannya. Skill ini akan merapikan produk kandidat, dimensi pembanding, dan dasar pemilihannya, sehingga Anda memperoleh daftar produk yang dapat diverifikasi lebih lanjut.",
    ],
    [
      ["Penjual e-commerce", "Perlu menemukan kandidat yang layak diteliti dari cakupan produk yang luas."],
      ["Tim brand dan pengadaan", "Ingin merencanakan pemilihan produk dengan memadukan data dan situasi persaingannya."],
      ["Pengelola operasional e-commerce", "Perlu cepat membandingkan peluang produk menurut platform dan kategorinya."],
    ],
    [
      ["Produk kandidat terlalu banyak", "Mempersempit cakupan pemilihan menurut platform, kategori, dan syaratnya."],
      ["Pemilihan produk bergantung intuisi", "Merapikan sinyal pasar dan dimensi pembanding menjadi dasar yang dapat diperiksa ulang."],
      ["Informasi pesaing tersebar", "Menempatkan kandidat, pesaing, dan kebutuhan pengguna dalam satu alur analisis."],
    ],
    [
      ["Pemilihan lintas platform", "Mendukung platform seperti Taobao, JD.com, Pinduoduo, Douyin, dan Amazon."],
      ["Penyaringan kandidat", "Menyaring produk menurut kategori, anggaran, dan kebutuhannya."],
      ["Perbandingan pesaing", "Merapikan informasi harga, posisi produk, dan persaingan pasarnya."],
      ["Perapian peluang", "Menghasilkan daftar kandidat, alasannya, dan hipotesis yang perlu diverifikasi lebih lanjut."],
    ],
    "Jelaskan platform sasaran, kategori, anggaran, kelompok pengguna, dan syarat penyaringannya, lalu minta Agent menghasilkan produk kandidat beserta penjelasan dasar pengurutannya.",
    "Saring peralatan dapur kecil untuk penyewa muda di e-commerce Douyin, dengan anggaran 100 sampai 300 yuan, lalu bandingkan kebutuhan, persaingan, dan potensi keunggulan jualnya.",
  ),
  "tencent-news": makeOverview(
    [
      "Tencent News membantu Agent mencari informasi berita 7×24, mencakup informasi dalam negeri Tiongkok, isu internasional, berita waktu nyata, dan berita bidang tertentu.",
      "Berikan kata kunci, bidang yang diperhatikan, rentang waktu, atau format laporan harian/pagi yang dibutuhkan. Skill ini akan merapikan berita terkait, isu hangat, cuaca, dan informasi lainnya menjadi ringkasan yang nyaman dibaca.",
    ],
    [
      ["Pemantau informasi", "Perlu cepat memahami perubahan isu hangat dalam dan luar negeri."],
      ["Peneliti industri", "Ingin terus mencari berita terkait menurut bidangnya."],
      ["Pengguna perkantoran sehari-hari", "Perlu merapikan berita menjadi laporan pagi, laporan sore, atau ringkasan tematik."],
    ],
    [
      ["Mencari berita menyita waktu", "Cepat menemukan informasi terkait dari kata kunci dan bidangnya."],
      ["Informasi isu hangat tersebar", "Merapikan berita waktu nyata beserta latar terkaitnya menjadi satu kesatuan."],
      ["Informasi sulit dibaca berkelanjutan", "Memadatkan informasinya dalam bentuk laporan pagi, laporan sore, atau tematik."],
    ],
    [
      ["Pencarian berita", "Mencari berita hangat dan informasi bidang tertentu berdasarkan kata kunci."],
      ["Rentang waktu", "Melihat konten waktu nyata, hari ini, atau periode yang ditentukan."],
      ["Ringkasan informasi", "Merapikan beberapa berita terkait menjadi ringkasan yang mudah dibaca."],
      ["Keluaran gaya langganan", "Menghasilkan format laporan pagi, laporan sore, atau pemantauan berkelanjutan."],
    ],
    "Jelaskan tema, wilayah, rentang waktu, dan bentuk keluaran yang Anda perhatikan, lalu minta Agent memisahkan fakta berita, sumbernya, dan kesimpulan yang bersifat dugaan.",
    "Rapikan isu hangat dalam dan luar negeri terkait industri kecerdasan buatan hari ini, kelompokkan menurut kebijakan, produk, dan pendanaan, lalu buat satu laporan pagi yang ringkas beserta sumbernya.",
  ),
  "weather": makeOverview(
    [
      "Weather membantu Agent memeriksa cuaca terkini dan prakiraan cuaca untuk lokasi tertentu, tanpa memerlukan kunci API.",
      "Berikan kota, wilayah, atau koordinatnya, lalu jelaskan apakah Anda ingin cuaca terkini, prakiraan beberapa hari ke depan, atau waktu perjalanan. Skill ini akan mengembalikan informasi cuaca yang sesuai dengan lokasi dan rentang waktunya untuk membantu Anda merencanakan perjalanan.",
    ],
    [
      ["Pengguna sehari-hari", "Perlu cepat mengetahui cuaca di kotanya atau di tempat tujuan."],
      ["Perencana perjalanan", "Ingin menyusun rute dan aktivitas berdasarkan prakiraannya."],
      ["Alur kerja yang butuh informasi cuaca", "Ingin menjadikan pencarian cuaca sebagai satu langkah dalam pengingat atau rencana."],
    ],
    [
      ["Cek cuaca harus berpindah tool", "Memperoleh kondisi terkini dan prakiraannya langsung di dalam percakapan."],
      ["Rencana tanpa acuan cuaca", "Menggabungkan lokasi, waktu, dan informasi cuacanya."],
      ["Cakupan pencarian tidak jelas", "Menegaskan lokasi sasaran melalui kota, wilayah, atau koordinatnya."],
    ],
    [
      ["Cuaca terkini", "Memeriksa kondisi cuaca waktu nyata pada lokasi yang ditentukan."],
      ["Prakiraan cuaca", "Memperoleh informasi prakiraan dalam rentang waktu sasarannya."],
      ["Pengenalan lokasi", "Mendukung masukan umum seperti kota, wilayah, dan koordinat."],
      ["Acuan perjalanan", "Memakai hasil cuacanya untuk perjalanan, aktivitas luar ruang, dan penyusunan jadwal."],
    ],
    "Jelaskan kota atau lokasinya, tanggal, dan rentang waktunya, lalu beri tahu Agent apakah Anda butuh cuaca terkini, prakiraan, atau saran perjalanan.",
    "Cek cuaca Shanghai untuk besok dan hari berikutnya, beri tahu kondisi curah hujannya, lalu sarankan rentang waktu yang cocok untuk aktivitas luar ruang di akhir pekan.",
  ),
};
