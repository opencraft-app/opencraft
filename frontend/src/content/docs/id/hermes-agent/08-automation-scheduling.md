## Ringkasan

**Hermes Agent dapat menjangkau Anda sesuai jadwal bukan karena ia menunggu di jendela chat, melainkan karena sebuah tugas terjadwal menyimpan tiga hal — kapan dijalankan, apa yang dilakukan, dan ke mana hasilnya dikirim — sebagai konfigurasi yang dapat dijadwalkan berulang kali. Ketika waktunya tiba, penjadwal memulai eksekusi yang independen: ia tidak memutar ulang percakapan lama, ia mengerjakan ulang pekerjaannya dari instruksi tugas lalu mengantarkan keluarannya sesuai pengaturan notifikasi Anda. Di LightVela sebuah tugas terjadwal terdiri dari: nama, jadwal (hari tetap dalam seminggu, interval tetap, atau sekali jalan — pilih salah satu), instruksi tugas, jendela waktu aktif, dan kanal notifikasi. Satu koreksi atas klaim yang tersebar luas: tidak ada kolom "sematkan tugas ini ke model tertentu", sehingga saran untuk menyinkronkan ulang model tugas terjadwal setelah mengganti model tidak berlaku. Bagian yang menentukan keandalan adalah instruksi tugasnya — karena tidak ada yang hadir untuk memperjelas saat eksekusi, prompt tersebut harus membawa sendiri tujuan, batasan, dan format keluarannya.**

---

## "Proaktif" tidak berarti mengawasi Anda terus-menerus

"Beri saya ringkasan berita setiap pagi" terdengar seperti instruksi biasa, tetapi ia berbeda secara fundamental dari "beri saya ringkasan berita sekarang."

Yang kedua adalah percakapan: Anda hadir, sehingga Anda dapat menindaklanjuti, mengoreksi, dan menambah konteks kapan saja. Yang pertama adalah **pekerjaan yang harus dijalankan selama Anda tidak ada**: tidak ada yang mengonfirmasi bahwa ia memahaminya dengan benar, tidak ada yang menghentikannya ketika keluarannya melenceng, dan tidak ada yang memberitahunya ke mana mengirimkan hasil agar Anda benar-benar melihatnya.

Jadi bagian sulit dari "proaktif" bukan pemicu terjadwalnya — itu bagian yang mudah. Bagian sulitnya adalah: **menulis ulang percakapan yang bergantung pada kehadiran Anda menjadi perintah kerja yang berhasil tanpa kehadiran itu.** Artikel ini membahas apa yang dimuat perintah kerja tersebut dan bagaimana menulisnya agar bertahan.

---

## 1. Apa yang sebenarnya dimuat sebuah tugas terjadwal

Membuat tugas terjadwal di LightVela melibatkan kolom-kolom berikut.

| Kolom | Pertanyaan yang dijawabnya | Catatan |
|---|---|---|
| **Nama** | Tugas ini disebut apa? | Dipakai untuk mengenalinya di daftar; beri nama sesuai tindakannya, bukan "Tugas 1" |
| **Jadwal** | Kapan ia berjalan? | Hari tetap dalam seminggu, interval tetap, atau sekali jalan — pilih salah satu |
| **Instruksi tugas** | Apa yang harus dicapai? | Prompt yang dipakai Agent saat eksekusi |
| **Jendela waktu aktif** | Pada jam berapa ia berlaku? | Membatasi kapan tugas boleh berjalan; membiarkannya kosong berarti sepanjang waktu |
| **Kanal notifikasi** | Ke mana hasilnya pergi? | Pengalih opsional untuk memilih kanal mana yang menerima notifikasi eksekusi |

**Satu poin yang patut disampaikan terang-terangan: tidak ada kolom "model".** Sebuah tugas terjadwal tidak disematkan ke model tertentu, sehingga saran yang sering diulang bahwa Anda harus meninjau dan menyinkronkan ulang model setiap tugas terjadwal setelah mengganti model tidak berlaku untuk bentuk produk ini. Yang layak ditinjau setelah penggantian model adalah **kualitas** keluaran, bukan kolom yang tidak ada. Untuk pelapisan di baliknya, lihat "Bisakah Otak Hermes Agent Diganti? Lapisan Model vs Lapisan Agent."

Perhatikan juga bahwa jadwalnya adalah pilihan di antara hari tetap dalam seminggu, interval tetap, dan sekali jalan — bukan ekspresi cron sembarang. Mengetahui ini sejak awal menyelamatkan Anda dari merancang jadwal berbentuk cron lalu mendapati tidak ada tempat untuk memasukkannya.

---

## 2. Memilih di antara tiga jenis jadwal

Ketiga mode melayani tiga kebutuhan berbeda, dan memilih yang salah menghasilkan perilaku yang tidak sesuai ekspektasi Anda.

**Hari tetap dalam seminggu** cocok untuk pekerjaan yang terikat ritme manusia atau siklus kerja — merangkum kemajuan pekan lalu pada Senin pagi, pengingat menyiram tanaman pada Minggu. Ciri khasnya adalah ia **ditambatkan ke waktu tertentu**, yang cocok untuk "saya ingin melihat ini pada momen itu."

**Interval tetap** cocok untuk pekerjaan yang waktunya tidak penting, hanya frekuensinya — memeriksa sumber informasi setiap beberapa jam. Ciri khasnya adalah ia **berhitung dari eksekusi sebelumnya**, yang cocok untuk "saya ingin ia menjaga irama ini."

**Sekali jalan** cocok untuk peristiwa tunggal, seperti pengingat pada tanggal tertentu. Ia berakhir setelah berjalan, tanpa ada yang perlu dimatikan setelahnya.

Uji sederhana saat memilih: **apakah kebutuhan Anda menyebut waktu jam?** Jika ya, pakai hari tetap dalam seminggu. Jika hanya frekuensi, pakai interval tetap. Jika terjadi sekali, pakai sekali jalan.

---

## 3. Untuk apa jendela waktu aktif

Kolom ini mudah dilewati, tetapi ia menyelesaikan gangguan yang nyata: **Anda ingin tugasnya menjaga irama, tetapi tidak mengganggu Anda pada jam-jam tertentu.**

Kasus klasiknya adalah tugas berinterval. Menetapkan "setiap dua jam" tanpa jendela aktif berarti ia berjalan sepanjang waktu, termasuk sepanjang malam. Dengan jendela aktif, ia hanya berjalan selama jam yang Anda tentukan.

Membiarkannya kosong berarti operasi berkelanjutan. Jadi jika sebuah tugas berjalan pada waktu yang seharusnya tidak, periksa kolom ini lebih dulu.

---

## 4. Apa yang sebenarnya terjadi ketika waktunya tiba

Di sinilah kesalahpahaman paling umum. Banyak orang mengira tugas terjadwal berarti "mengirim ulang kalimat asli Anda ke Agent", dan asumsi itu menghasilkan prompt yang terlalu bersandar pada konteks.

Yang sebenarnya terjadi: ketika penjadwal mencapai waktu targetnya, ia **memicu eksekusi Agent yang independen**. Eksekusi itu menyelesaikan pekerjaannya dari instruksi tugas alih-alih memutar ulang percakapan tempat tugas itu dibuat.

Ini punya konsekuensi penting: **instruksi tugas harus membawa konteksnya sendiri.** Latar belakang yang Anda pegang di kepala saat membuat tugas, atau detail yang Anda bahas sebelumnya dengan Agent, tidak selalu akan diterapkan saat eksekusi kecuali hal itu sudah dituliskan ke dalam instruksinya atau sudah tertangkap di memori jangka panjang.

Bandingkan dua versi:

- **Bergantung konteks**: "Susun ringkasan seperti yang baru kamu buat." — Saat eksekusi, "yang baru" itu sudah tidak ada.
- **Berdiri sendiri**: "Rangkum email yang belum dibaca dari 24 jam terakhir, dikelompokkan per pengirim, maksimal tiga item per kelompok, hanya menyimpan pesan yang butuh balasan saya; keluarkan sebagai daftar berbutir dengan satu item per baris."

Yang kedua berjalan andal tanpa ada yang hadir, karena tujuan, cakupan, kriteria filter, dan format keluarannya semuanya ada di dalamnya.

---

## 5. Cara menulis instruksi tugas yang bertahan

Mengingat mekanisme di atas, instruksi tugas yang andal biasanya memuat empat bagian.

**Pertama, tindakan target yang eksplisit.** Nyatakan apa yang harus *dilakukan*, bukan apa yang harus "diperhatikan". Anda tidak dapat menilai apakah "memperhatikan" sudah selesai; Anda dapat menilai apakah "merangkum dan mendaftarkan" sudah selesai.

**Kedua, batas cakupan yang eksplisit.** Rentang waktu (24 jam terakhir), batas volume (maksimal tiga per kelompok), filter (hanya yang butuh balasan saya). Tanpa batasan, tugas yang sama dapat menghasilkan keluaran yang sangat berbeda pada hari yang berbeda.

**Ketiga, format keluaran yang eksplisit.** Daftar atau prosa, dikelompokkan atau rata, seberapa panjang tiap item boleh. Karena Anda tidak hadir, Anda tidak dapat berkata "terlalu panjang, pendekkan" pada saat itu.

**Keempat, penanganan pengecualian yang eksplisit.** Jika tidak ada yang cocok, apakah ia harus mengirim "tidak ada yang perlu ditangani hari ini" atau diam saja? Tanpa ini, Anda tidak dapat membedakan "tugasnya tidak berjalan" dari "tugasnya berjalan dan tidak menemukan apa pun."

Poin keempat adalah yang paling sering diabaikan, dan ia langsung memengaruhi kemampuan Anda menilai apakah sebuah tugas sehat.

---

## 6. Urutan penggelaran yang disarankan

Jangan memperlakukan "buat tugasnya" sebagai satu langkah tunggal. Urutan ini memunculkan sebagian besar masalah lebih awal.

1. **Verifikasi manual di chat lebih dulu.** Kirim prompt yang ingin Anda pakai langsung ke Agent lalu periksa keluarannya. Ini menyetel prompt tanpa penjadwalan yang menghalangi.
2. **Revisi prompt berdasarkan hasil itu.** Keluaran terlalu panjang, cakupan terlalu luas, format tidak stabil — perbaiki semuanya di sini.
3. **Buat tugasnya lalu atur jadwalnya.** Pakai uji di bagian 2 untuk memilih modenya.
4. **Pastikan kanal notifikasi mengarah ke tempat yang benar-benar Anda baca.** Hasil yang diantarkan ke tempat yang tidak pernah Anda lihat setara dengan tidak ada hasil.
5. **Atur jendela waktu aktif bila perlu.** Terutama untuk tugas berinterval, guna menghindari gangguan sepanjang malam.
6. **Tunggu satu eksekusi nyata, lalu tinjau catatan eksekusinya.** Ini langkah kritisnya — **jangan memperlakukan "tugas sudah dibuat" sebagai selesai.** Penyimpanan yang berhasil berarti konfigurasinya tersimpan, bukan bahwa keluarannya benar.
7. **Perhalus prompt sekali lagi berdasarkan eksekusi nyata pertama itu.** Eksekusi nyata dapat berbeda dari pengujian manual, dan revisi kedua ini biasanya memberi peningkatan kestabilan paling besar.

Produk ini mendukung melihat detail tugas, menyunting, menjeda, dan menghapus dari daftar tugas, sehingga langkah 7 murah. Jika sebuah tugas sementara tidak diperlukan, utamakan menjedanya daripada menghapusnya agar konfigurasinya tetap tersedia untuk dipakai ulang.

---

## 7. Gejala umum dan tempat mencarinya

| Gejala | Penyebab yang lebih mungkin | Tindakan yang disarankan |
|---|---|---|
| Tidak ada apa pun terjadi pada waktu terjadwal | Tugas dijeda, atau waktu saat ini di luar jendela aktif | Periksa status tugas dan jendela waktu aktif |
| Ia berjalan tetapi tidak ada hasil yang datang | Kanal notifikasi belum diatur, atau mengantar ke tempat yang tidak Anda baca | Periksa konfigurasi notifikasi |
| Panjang dan format keluaran sangat bervariasi | Instruksi kurang batas cakupan dan format keluaran | Tambahkan empat elemen dari bagian 5 |
| Keluaran sangat berbeda dari pengujian manual | Instruksi bersandar pada konteks percakapan saat pembuatan | Tulis ulang sebagai instruksi yang berdiri sendiri |
| Tidak dapat membedakan "tidak berjalan" dari "tidak menemukan apa pun" | Instruksi kurang penanganan pengecualian | Tambahkan "kirim catatan bahkan ketika tidak ada apa pun" |
| Terganggu sepanjang malam | Tugas berinterval tidak punya jendela waktu aktif | Atur jendela waktu aktif |

Prinsip umum saat menelusuri masalah: **pisahkan dulu "tidak berjalan" dari "berjalan tetapi menghasilkan hal yang salah."** Yang pertama mengarah ke status tugas, jendela aktif, dan pengaturan notifikasi; yang kedua mengarah ke instruksinya sendiri. Keduanya punya jalur penyelesaian yang sama sekali berbeda, dan menyelidikinya bersamaan membuang waktu.

---

## 8. Pendekatan LightVela: pekerjaan proaktif yang dapat dikonfigurasi dan ditinjau

Hermes mendukung pekerjaan terjadwal pada tingkat mekanisme, tetapi menjaga runtime dan penjadwalannya tetap andal diserahkan kepada operatornya. Arah LightVela adalah menjadikan ini kemampuan produk yang dapat dikonfigurasi dan ditinjau:

- **Templat menurunkan biaya awal** — ketika Anda belum yakin apa yang perlu ditugas terjadwalkan, mulai dari templat siap pakai lalu sesuaikan.
- **Siklus hidup tugas dapat dikelola** — lihat detail, sunting, jeda, atau hapus setelah pembuatan, tanpa perlu membangun ulang tugas hanya untuk mengubah satu kondisi.
- **Pengiriman dapat dipilih** — kanal notifikasi berupa pengalih opsional, sehingga hasil mendarat di tempat yang benar-benar Anda baca.
- **Terpisah dari kemampuan lain** — tugas terjadwal, model, skill, dan cloud storage dikonfigurasi secara independen, dan mengganti model tidak mengubah pengaturan tugas terjadwal.
- **Kegagalan dapat dilacak** — gabungkan anomali eksekusi dengan log terbaru di Diagnostik untuk menemukan penyebabnya.

---

## Poin penting

- Sebuah tugas terjadwal pada dasarnya adalah konfigurasi tersimpan dan dapat diulang tentang kapan dijalankan, apa yang dilakukan, dan ke mana diantarkan.
- Kolomnya adalah: nama, jadwal (hari tetap dalam seminggu / interval tetap / sekali jalan), instruksi tugas, jendela waktu aktif, kanal notifikasi.
- **Tidak ada kolom "model"**, sehingga "sinkronkan ulang model tugas terjadwal setelah penggantian" tidak akurat; jadwalnya juga bukan ekspresi cron sembarang.
- Pemicunya memulai **eksekusi yang independen**, bukan pemutaran ulang percakapan lama, sehingga instruksinya harus berdiri sendiri.
- Instruksi yang andal memuat empat bagian: tindakan target, batas cakupan, format keluaran, penanganan pengecualian.
- Langkah penggelaran yang menentukan adalah yang terakhir: **tunggu eksekusi nyata lalu tinjau catatannya**, alih-alih berhenti di "tugas sudah dibuat."
