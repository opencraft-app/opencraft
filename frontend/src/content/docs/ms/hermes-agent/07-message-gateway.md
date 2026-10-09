## Ringkasan

**Satu Ejen boleh muncul merentas beberapa apl pemesejan kerana apl tersebut hanyalah titik masuk — Ejen ialah perkara yang benar-benar berfungsi. Gerbang mesej melakukan tiga kerja: ia menormalkan mesej berbeza dari segi struktur daripada Telegram, WhatsApp, Discord, Slack, WeChat dan lain-lain ke dalam satu format permintaan; ia mengarahkan setiap permintaan kepada Ejen yang sama berdasarkan konfigurasi sambungan anda, bukannya mengklon personaliti dan memori setiap platform; dan selepas pelaksanaan ia menyampaikan hasil kembali ke perbualan yang tepat ia datang. Oleh kerana identiti (`SOUL.md`), ingatan (`USER.md`, `MEMORY.md`), kemahiran (`skills/`), dan tugasan berjadual semuanya berada di luar lapisan saluran, sesuatu yang anda nyatakan pada Telegram masih diketahui apabila anda membuat susulan pada WhatsApp. Tetapi bersatu tidak bermakna tidak terhad: setiap saluran mempunyai aliran kebenaran sendiri, format mesej dan had penghantaran, set saluran yang disokong berbeza antara wilayah global dan China, dan selepas menyambungkan saluran baharu, anda mesti menghantar mesej ujian untuk mengesahkan balasan tiba dalam perbualan yang dijangkakan.**

---

## Senario yang diselesaikan ini

Gambar sehari penggunaan. Pada Telegram anda meminta Ejen anda meringkaskan kedudukan projek. Menuju keluar pada tengah hari, anda membuat susulan pada WhatsApp: "apakah risiko dalam pilihan kedua yang anda nyatakan?" Pada waktu petang anda memintanya menyiarkan kesimpulan dalam pasukan Slack atau Discord saluran.

Jika ketiga-tiga interaksi tersebut berkelakuan seperti tiga bot yang tidak berkaitan, akses berbilang platform akan menjadi tidak bernilai — anda akan menerangkan semula konteks setiap kali. Bentuk yang berguna adalah berbeza: tiga pintu masuk, satu pembantu.

Kesukaran di sini lazimnya disalah baca sebagai "menyepadukan beberapa lagi API." API penyepaduan hanyalah kerja peringkat permukaan. Masalah sebenar ialah ini: **jadikan setiap titik masuk menyelesaikan kepada identiti dan konteks yang sama, tanpa melanggar peraturan setiap platform sendiri.** Gerbang mesej ialah lapisan yang menyelesaikan ketegangan itu.

---

## 1. Pertama, pembetulan: saluran bukan Ejen

Perbezaan ini adalah prasyarat untuk segala-galanya.

| Konsep | Apa itu | Kardinaliti |
|---|---|---|
| **Saluran** | Titik masuk untuk mesej, mis. Telegram, WhatsApp, Discord, Slack, WeChat | Satu Ejen boleh menghubungkan banyak |
| **Ejen** | Subjek kerja yang gigih memegang identiti, ingatan, kemahiran, tugas | Dikongsi oleh banyak saluran |

Orang secara naluri menganggap "bot Telegram saya" sebagai entiti kendiri, yang secara semula jadi menimbulkan persoalan "jadi adakah bot WhatsApp saya berbeza?" Setelah saluran difahami sebagai pintu masuk dan bukannya subjek, soalan itu terlerai.

Laluan penuh kelihatan seperti ini:

```text
Messaging apps (multiple entry points)
    ↓  platform-native messages
Message gateway (normalise / route / deliver)
    ↓  unified request
The same Hermes Agent
    ↓
model inference + tool execution + memory recall + skill loading
    ↓  execution result
Message gateway
    ↓  delivered in platform format
Original conversation on the original channel
```

Ambil perhatian bahawa langkah terakhir — *perbualan asal pada saluran asal*. Itu bukan nota kaki; ia adalah salah satu masalah teras yang mesti diselesaikan dengan betul, dibincangkan di bawah.

---

## 2. Tugas gerbang satu: terima dan normalisasi

Platform berbeza sepanjang hampir setiap dimensi:

- **Pengecam pengguna yang berbeza** — ID berangka, nombor telefon atau nama pengguna dalaman platform.
- **Pengecam perbualan yang berbeza** — mesej langsung, kumpulan, saluran dan urutan masing-masing diwakili secara berbeza.
- **Struktur mesej yang berbeza** — teks, imej, suara, fail, balasan yang dipetik dan reaksi semuanya mempunyai reka bentuk medan mereka sendiri.
- **Model acara yang berbeza** — sesetengah menolak melalui webhooks, yang lain memerlukan sambungan berterusan atau tinjauan pendapat.

Jika Ejen menghadapi perbezaan ini secara langsung, percabangan khusus platform akan merebak melalui terasnya, dan setiap platform baharu bermakna menyentuh logik teras. Normalisasi mengehadkan perbezaan tersebut pada get laluan: mesej asli platform menjadi satu permintaan seragam, jadi Ejen hanya perlu memahami satu bentuk input.

Hasil praktikal: **menambah saluran tidak sepatutnya memerlukan penukaran identiti, ingatan atau logik kemahiran.** Ejen mengambil berat tentang perkara yang diminta, bukan reka letak medan apl yang membawanya.

---

## 3. Gerbang kerja dua: laluan ke Ejen yang sama

Ini adalah langkah yang memungkinkan "satu personaliti merentas platform".

Setelah permintaan dinormalkan, get laluan menggunakan **konfigurasi sambungan** anda untuk menentukan Ejen miliknya, kemudian menyerahkan permintaan itu kepada Ejen tersebut. Ia tidak menghasilkan personaliti baharu atau stor memori hanya kerana mesej itu tiba daripada platform yang baru disambungkan.

Perkara ini penting kerana ia menentukan sama ada aset jangka panjang dikongsi atau dipecahkan:

| Aset | Di mana ia tinggal | Tingkah laku merentas saluran |
|---|---|---|
| Identiti dan peraturan tingkah laku | `SOUL.md` | Satu salinan, dikongsi oleh semua saluran |
| Profil pengguna | `USER.md` | Satu salinan, dikongsi oleh semua saluran |
| Fakta sesi silang | `MEMORY.md` / `memories/` | Satu salinan, dikongsi oleh semua saluran |
| Kaedah yang ditangkap | `skills/` | Satu salinan, dikongsi oleh semua saluran |
| Tugas Berjadual | Konfigurasi lapisan ejen | Dipisahkan daripada saluran; sasaran penghantaran boleh dikonfigurasikan |

Kerana semua ini berada di luar lapisan saluran, "ia masih mengetahui nama projek yang saya nyatakan pada Telegram" bukanlah ciri penyegerakan yang perlu dibina oleh seseorang — ia adalah akibat semula jadi kerana hanya terdapat satu salinan.

Ini adalah logik penyahgandingan yang sama seperti "menukar model tidak kehilangan ingatan": **pisahkan lapisan akses meruap daripada lapisan aset stabil.** Untuk versi sisi model hujah ini, lihat "Bolehkah Otak Hermes Digantikan? Lapisan Model vs Lapisan Ejen."

---

## 4. Tugas gerbang tiga: hantar kembali ke tempat yang betul

Sebaik sahaja Ejen selesai, pintu masuk menghantar keputusan kembali. "Menghantarnya kembali" adalah lebih sukar daripada yang dikatakan, kerana ia mesti menjawab tiga soalan dengan betul sekaligus:

1. **Platform yang mana** — mesej daripada Telegram mesti kembali ke Telegram, bukan WhatsApp.
2. **Perbualan yang mana** — pada satu platform anda mungkin mempunyai mesej langsung serta beberapa kumpulan dan saluran. Membalas perbualan yang salah bukan semata-mata janggal; dalam konteks kumpulan ia boleh membocorkan maklumat.
3. **Format yang mana** — platform berbeza pada had panjang mesej, sokongan Markdown, cara imej dan fail dihantar dan sama ada balasan yang dipetik wujud. Kandungan yang sama memerlukan pembentangan yang berbeza setiap platform.

Perkara kedua patut diberi penekanan. **Sasaran penghantaran yang salah ialah kelas masalah dengan keterukan tertinggi dalam persediaan berbilang saluran**: kandungan peribadi disiarkan ke kumpulan, atau kesimpulan satu pasukan dihantar ke saluran pasukan lain. Itulah sebabnya setiap saluran yang baru disambungkan harus disahkan dengan mesej ujian dalam perbualan yang selamat terlebih dahulu.

---

## 5. Bersatu bukan bererti tidak terbatas

"Satu Ejen, banyak pintu masuk" mudah dibaca secara berlebihan kerana "semua platform berkelakuan sama." Pada hakikatnya setiap saluran mengekalkan kekangannya sendiri, dan berkongsi Ejen tidak mengalih keluarnya.

### 5.1 Keizinan berbeza

Setiap platform mempunyai aliran sambungan dan bentuk bukti kelayakannya sendiri: sesetengahnya memerlukan pembuatan bot dalam portal pembangun dan menyalin token, sesetengahnya memerlukan pengimbasan kod QR, sesetengahnya memerlukan AppID dan AppSecret. Dalam erti kata lain, **menyambungkan setiap saluran ialah langkah kebenaran bebas** — satu persediaan tidak meliputi kesemuanya.

### 5.2 Saluran yang disokong berbeza mengikut wilayah

Ini adalah perangkap mudah apabila membaca dokumentasi: Wilayah global dan China LightVela tidak menyokong set saluran yang sama. Urutan saluran global ialah Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom, Lark. Rantau China menyokong WeChat, QQ, WeCom, Lark dan DingTalk.

Oleh itu, apabila anda melihat tuntutan seperti "Telegram disokong," sahkan kawasan mana yang digunakan untuknya dan bukannya menganggap ia merentasi.

### 5.3 Konteks kumpulan berbeza daripada mesej langsung

Dalam mesej langsung, Ejen berhadapan dengan satu orang; dalam kumpulan ia menghadapi ramai. Kumpulan menambah soalan: bila ia harus bertindak balas, bila ia harus berdiam diri, apakah kandungan yang tidak sesuai untuk dikembangkan secara terbuka dan siapa yang dibenarkan untuk mencetuskan tindakan sensitif. Ini tergolong dalam peraturan tingkah laku dan reka bentuk kebenaran — gerbang tidak boleh memutuskannya secara automatik.

### 5.4 Keupayaan penghantaran berbeza

Had panjang mesej, sokongan teks kaya, penghantaran fail dan keupayaan untuk memetik mesej tertentu semuanya membentuk output. Balasan panjang yang dipaparkan dengan jelas dalam Discord mungkin perlu dipecah atau dipermudahkan di tempat lain.

---

## 6. Pesanan praktikal untuk menyambung saluran baharu

Mengubah prinsip di atas menjadi langkah, perintah ini mengelakkan kebanyakan masalah.

1. **Sahkan sokongan serantau** — sahkan saluran tersedia di rantau anda, jadi anda tidak mengikuti dokumentasi yang ditulis untuk yang lain.
2. **Keizinan sisi platform yang lengkap** — ikut panduan saluran itu untuk membuat bot atau memberikan akses dan mendapatkan bukti kelayakan. Bukti kelayakan adalah sensitif: jangan sekali-kali menulisnya ke dalam fail konteks jangka panjang atau menampalnya ke dalam sembang.
3. **Sambung pada bahagian produk** — masukkan bukti kelayakan, simpan dan sahkan status menunjukkan sebagai disambungkan.
4. **Hantar mesej ujian** — gunakan perbualan selamat (mesej langsung atau kumpulan ujian) dan sahkan balasan Ejen.
5. **Sahkan sasaran penghantaran** — semak secara khusus sama ada balasan mendarat dalam **perbualan yang sama yang anda hantar mesej**, bukan satu lagi.
6. **Sahkan memori kongsi** — tanya tentang sesuatu yang anda beritahu pada saluran lain. Jawapan yang betul membuktikan saluran ini benar-benar menuju ke Ejen yang sama.
7. **Kemudian baru tambah akses kumpulan** — selepas mesej langsung menyemak, sertai kumpulan dan sahkan sempadan respons dalam kumpulan berkelakuan seperti yang diharapkan.

Langkah 6 ialah yang paling ramai orang langkau dan ia membawa nilai paling tinggi: ia adalah cara paling langsung untuk mengesahkan bahawa saluran benar-benar berkongsi satu Ejen.

---

## 7. Gejala biasa dan cara membacanya

| Gejala | Lebih berkemungkinan menyebabkan | Tindakan yang dicadangkan |
|---|---|---|
| Tiada balasan langsung pada saluran baharu | Keizinan tidak lengkap atau bukti kelayakan salah | Semak status sambungan dan bukti kelayakan, buat semula kebenaran |
| Balasan muncul dalam perbualan lain | Peleraian sasaran penghantaran atau ralat konfigurasi | Berhenti menggunakannya dalam kumpulan; beralih ke mengarahkan mesej untuk mengasingkan |
| Balasan, tetapi "tidak mengenali saya" | Mungkin disambungkan kepada Ejen lain | Sahkan dengan fakta yang diketahui dan semak Ejen mana yang dituju oleh sambungan |
| Kumpulan senyap, mesej langsung baik | Peraturan atau kebenaran pencetus dalam kumpulan | Semak peraturan respons kumpulan dan kebenaran yang diperlukan |
| Balasan panjang dipotong atau salah format | Had penghantaran platform | Laraskan panjang output dan pemformatan untuk platform tersebut |

Baris tiga patut diberi perhatian: **"tidak mengenali saya" bermaksud sesuatu yang berbeza di sini berbanding selepas menukar model.** Selepas menukar model, ini biasanya perbezaan gaya; pada saluran yang baru disambungkan ia lebih berkemungkinan bermakna saluran ini tidak menghala ke Ejen yang anda anggap. Diagnostik adalah sama — tanya tentang satu fakta yang anda pasti ia patut tahu.

---

## 8. Pendekatan LightVela: saluran sebagai titik masuk boleh pasang

Hermes memisahkan saluran daripada Ejen pada peringkat mekanisme, tetapi menyambungkan setiap platform masih bermakna mengendalikan bukti kelayakan, panggilan balik dan masa jalan sendiri. Arah LightVela adalah untuk menjadikan lapisan itu sebagai titik masuk yang terhasil dan boleh dipasang:

- **Saluran ialah tetapan** — sambungkan atau putuskan sambungannya di bawah satu Ejen, tanpa perlu membuat Ejen berasingan bagi setiap platform.
- **Aset dikongsi secara lalai** — satu personaliti, ingatan, set kemahiran dan set tugas berjadual; saluran baharu menggunakannya semula dengan serta-merta, tanpa apa-apa untuk berhijrah.
- **Keadaan sambungan kelihatan** — konsol menunjukkan sama ada saluran disambungkan, menjadikannya mudah untuk membezakan "tidak pernah berjaya disambungkan" daripada "disambungkan tetapi tidak membalas."
- **Perbezaan serantau adalah jelas** — rantau global dan China masing-masing menyenaraikan saluran yang disokong mereka sendiri, menghalang kesilapan merentas wilayah.
- **Masalah boleh dikesan** — log terkini dalam Diagnostik membantu memisahkan isu kebenaran daripada isu penghantaran daripada isu tugas.

---

## Perkara utama

- Saluran adalah pintu masuk; Ejen adalah subjek. Banyak saluran berkongsi satu Ejen dan bukannya satu bot setiap platform.
- Gerbang melakukan tiga perkara: **menormalkan** perbezaan platform, **laluan** ke Ejen yang sama dan **menghantar** kembali ke perbualan asal.
- Identiti, ingatan, kemahiran dan tugas berjadual berada di luar lapisan saluran, jadi kesinambungan merentas saluran ialah akibat seni bina, bukan ciri penyegerakan tambahan.
- Bersatu tidak bermakna tidak terhad: kebenaran, sokongan serantau, konteks kumpulan dan had penghantaran berbeza setiap saluran.
- Selepas menyambungkan saluran, sahkan dua perkara: yang membalas tiba dalam perbualan yang dijangkakan dan yang benar-benar berkongsi memori yang sama.
