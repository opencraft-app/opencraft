## Ringkasan

**Sebuah Agent menjadi lebih baik seiring pemakaian bukan karena ia secara misterius meningkatkan dirinya di latar belakang, melainkan karena dua jenis hal dipertahankan secara terstruktur: fakta yang stabil menjadi Memory, dan metode yang dapat dipakai ulang ditangkap sebagai Skill, lalu dimuat kembali ketika situasinya cocok. Memory membuatnya tahu apa yang sudah terjadi — dipanggil kembali ketika sebuah kueri cocok. Skill membuatnya tahu apa yang harus dilakukan lain kali — dimuat ketika sebuah situasi cocok. Pemicu, bentuk, dan laju perubahannya semuanya berbeda, dan itulah sebabnya keduanya tidak dapat digabungkan. Hermes menyediakan `/learn` agar Agent dapat menyarikan prosedur yang sudah terbukti dari sesi saat ini menjadi sebuah `SKILL.md`, dengan `/skills pending` untuk peninjauan, sehingga perbaikan diri tidak pernah menjadi modifikasi diri tanpa batas. Skill yang baik harus menyatakan empat hal: kapan memakainya, langkah mana yang diikuti, seperti apa keberhasilannya, dan batas mana yang tidak boleh dilanggar. Yang penting bukan seberapa banyak yang Anda tangkap, melainkan bahwa ia tetap dapat ditinjau, dipakai ulang, dan diperbarui ketika produknya berubah.**

---

## Pengalaman yang tidak dapat dipakai ulang hanyalah sebuah percakapan

Ingat kembali sesi yang berjalan luar biasa baik. Anda dan Agent Anda men-debug sebuah masalah bersama, atau menghasilkan rangkaian release notes yang benar-benar bagus. Sepanjang jalan Anda mengoreksinya tiga atau empat kali: persempit cakupannya, jaga formatnya konsisten, jangan pernah melewatkan satu pemeriksaan itu. Hasilnya solid.

Sepekan kemudian, tugas jenis yang sama datang. Jika koreksi tersebut hanya hidup di log chat pekan lalu, Anda akan menyadari diri Anda mengatakan hal yang sama lagi — **penyetelan itu tidak pernah menjadi aset, hanya pengeluaran sekali pakai.**

Itulah pertanyaan sebenarnya di balik "menjadi lebih baik seiring pemakaian." Ia bukan tentang Agent yang menjadi lebih cerdas secara misterius. Ia tentang **apa yang sudah terbukti dipertahankan dalam bentuk terstruktur.** Apa yang Anda simpan, bagaimana Anda menyimpannya, dan di mana ia berada menentukan apakah akumulasinya nyata atau apakah setiap sesi memulai dari awal.

---

## 1. Dua jenis akumulasi, jangan dicampur

Sebuah Agent mengumpulkan dua hal yang secara fundamental berbeda.

| Akumulasi | Apa yang disimpannya | Cara ia dipakai | Laju perubahan |
|---|---|---|---|
| **Memory** | Fakta, preferensi, kesimpulan, riwayat | Dipanggil kembali ketika relevan dengan pertanyaan saat ini | Tinggi; entri dapat bertambah di sebagian besar sesi |
| **Skill** | Situasi, langkah, batas, pemeriksaan | Dimuat dan dijalankan ketika sebuah situasi cocok | Rendah; dapat tidak berubah berbulan-bulan |

Sepasang contoh yang berpadanan:

- "Pengguna ini lebih suka kesimpulan lebih dulu" → **Memory**. Itu fakta tentang Anda.
- "Sebelum menulis release notes, verifikasi nomor versinya dan bahwa setiap tautan dapat dibuka" → **Skill**. Itu prosedur yang dijalankan kapan pun tugas jenis itu muncul.

Keduanya tidak dapat digabungkan, setidaknya karena tiga alasan: **pemicu berbeda** (kecocokan kueri vs kecocokan situasi), **bentuk berbeda** (entri singkat vs langkah terurut), dan **laju perubahan berbeda** (harian vs bulanan). Mencampur prosedur yang stabil ke dalam daftar fakta bergejolak tinggi akan menghanyutkan bagian yang stabil. Untuk argumen lengkapnya, lihat "Memory Bukan Skill: Bagaimana Hermes Agent Memisahkan Memori Faktual dan Prosedural."

Pembedaan ini punya manfaat praktis langsung: **ketika Anda mendapati diri Anda mengoreksi jenis perilaku yang sama berulang kali, yang Anda butuhkan adalah Skill, bukan fakta lain di memori.**

---

## 2. Seperti apa bentuk sebuah Skill

Di Hermes sebuah Skill biasanya berupa `SKILL.md` dengan YAML frontmatter yang mendeklarasikan pemicu dan detail pendukungnya. Kira-kira:

```yaml
---
name: release-note-format
trigger:
  when: "user asks to write release notes"
---

# Prosedur standar untuk release notes

1. Konfirmasi nomor versi dan tanggal rilis
2. Kelompokkan entri sebagai Added / Fixed / Changed
3. Verifikasi setiap tautan eksternal dapat dibuka
4. Periksa nama proyek internal atau port; ganti dengan placeholder
5. Konfirmasi panjangnya sesuai batas kanal publikasi
```

`trigger` itulah yang penting: ia berarti Anda tidak memanggil Skill tersebut secara manual. Ketika situasi yang cocok dikenali, Skill tersebut dimuat otomatis sebagai instruksi berprioritas tinggi yang memandu eksekusi itu.

Hermes menambahkan dua lapisan pengorganisasian:

- **Skill Bundle** — paketkan Skill yang berkaitan untuk diaktifkan, dinonaktifkan, atau dibagikan sebagai satu grup. Bundle "release pipeline" mungkin memuat pemeriksaan pra-rilis, format changelog, dan langkah rollback.
- **`fallback_for_toolsets`** — sebuah Skill dapat mendeklarasikan dirinya sebagai cadangan ketika pemanggilan toolset tertentu gagal, sehingga jalur kegagalan pun punya prosedur yang terdefinisi.

Bersama-sama, keduanya mengubah Skill dari SOP terisolasi menjadi metodologi kerja yang dapat dikomposisi.

---

## 3. `/learn`: mengubah satu eksekusi yang berhasil menjadi sebuah metode

Menangkap sebuah Skill tidak menuntut Anda meninggalkan percakapan untuk menulis file. Hermes menyediakan `/learn`, yang membuat Agent dapat menyarikan prosedur yang layak disimpan dari sesi saat ini menjadi `SKILL.md` baru.

Nilai desain ini adalah **penangkapan terjadi saat ingatan paling segar**. Tepat setelah kolaborasi yang berhasil, Anda dan Agent sama-sama tahu langkah mana yang penting dan koreksi mana yang esensial. Tuliskan sepekan kemudian dan detailnya sudah hilang.

Namun penyarian otomatis menciptakan masalah yang harus ditangani: **jika sebuah Agent dapat menambahkan aturan perilaku kepada dirinya sendiri sesuka hati, perilakunya menjadi tak dapat diprediksi.** Hermes menanganinya dengan langkah peninjauan — periksa Skill yang menunggu lewat `/skills pending` lalu putuskan apakah akan mengadopsinya. Ini mencerminkan `/memory pending` di sisi memori.

**Perbaikan diri bukan modifikasi diri tanpa batas.** Jalur yang andal adalah metode baru lebih dulu menjadi **aturan yang dapat ditinjau**, lalu berlaku hanya setelah konfirmasi. Itulah yang membuat pertumbuhan kemampuan dapat dijelaskan, dipakai ulang, dan dikoreksi.

---

## 4. Empat hal yang harus dinyatakan Skill yang baik

Inilah yang membedakan Skill yang berguna dari yang merugikan. Abaikan salah satu dari keempatnya dan Skill tersebut akan salah menyala dalam praktik.

**Pertama, kapan memakainya.** Situasi pemicu harus spesifik. "Ketika menangani dokumen" terlalu luas dan akan dimuat di konteks yang bukan tempatnya; "ketika pengguna meminta release notes" cukup spesifik. Skill yang terlalu luas lebih buruk daripada tidak ada Skill, karena ia mengganggu tugas yang tak berkaitan.

**Kedua, langkah mana yang diikuti.** Langkahnya harus terurut dan dapat dijalankan. "Perhatikan kualitasnya" bukan langkah; "verifikasi setiap tautan eksternal dapat dibuka" adalah langkah. Ujinya: bisakah orang lain mengikuti Skill ini lalu menghasilkan hasil yang secara garis besar konsisten?

**Ketiga, seperti apa keberhasilannya.** Tanpa kriteria keberhasilan, Agent tidak dapat memeriksa dirinya sendiri dan Anda tidak dapat menilai apakah sebuah eksekusi dapat diterima. Buat ia dapat diverifikasi, misalnya "ketiga kelompok ada, masing-masing dengan setidaknya satu entri atau catatan eksplisit bahwa kelompoknya kosong."

**Keempat, batas mana yang tidak boleh dilanggar.** Nyatakan larangan secara eksplisit, seperti "tidak ada nama proyek internal atau port yang sebenarnya di dalam contoh." Batas adalah bagian Skill yang paling sering diabaikan dan sumber insiden yang paling umum.

Skill dengan keempatnya berbagi satu ciri: **ia terbaca sama baiknya oleh manusia maupun oleh Agent.** Karena Anda dapat memahami apa yang ia lakukan, Anda dapat mengoreksinya secara presisi ketika ia salah — dan itu prasyarat agar ia dapat dikoreksi sama sekali.

---

## 5. Tiga tahap yang membuat akumulasi berbuah

Penangkapan bukan tindakan tunggal; ia proses yang terurut. Melewati satu tahap menurunkan kualitasnya.

**Tahap satu: buktikan prosedurnya di pekerjaan nyata lebih dulu.** Jangan menulis Skill dari imajinasi. Prosedur yang belum pernah dijalankan terhadap tugas nyata hanya akan mengukuhkan kesalahan ketika ditangkap. Lakukan sekali, dan catat koreksi sepanjang jalannya.

**Tahap dua: tangkap langkah yang stabil dan dapat dipakai ulang.** Perhatikan kedua kualifikasinya — **stabil** (ia tidak akan berubah pekan depan) dan **dapat dipakai ulang** (ia berlaku melampaui satu kasus tepi ini). Prosedur sekali pakai tidak layak ditangkap; pemeliharaannya akan menghabiskan lebih banyak daripada hasilnya.

**Tahap tiga: perbarui Skill ketika produk, tool, atau kebijakan berubah.** Ini tahap yang paling sering dilewati. Skill yang ditulis enam bulan lalu yang merujuk pintu masuk yang sudah dipindahkan atau batas yang sejak itu disesuaikan akan terus mengeluarkan panduan yang kedaluwarsa. **Memakai ulang pengalaman kedaluwarsa tanpa batas lebih berbahaya daripada tidak punya sama sekali**, karena ia membawa kredibilitas karena pernah "terbukti."

Kebiasaan pemeliharaan yang praktis: ketika Anda mendapati diri Anda berulang kali mengoreksi keluaran sebuah Skill secara manual, ia sudah kedaluwarsa. Perbarui ia alih-alih mengakalinya.

---

## 6. Jebakan umum

| Jebakan | Masalahnya | Lakukan ini sebagai gantinya |
|---|---|---|
| Menyimpan aturan perilaku sebagai entri Memory | Mungkin tidak dipanggil kembali saat kueri tidak cocok, dan terhanyut oleh entri yang lebih baru | Aturan ke `SOUL.md`, prosedur ke Skill |
| Menulis pemicu yang luas "agar mencakup lebih banyak" | Dimuat selama tugas yang tak berkaitan lalu mengganggu | Persempit ke situasi yang spesifik |
| Langkah tanpa batas | Langkahnya berjalan benar tetapi dapat membocorkan detail internal atau melampaui batas | Tambahkan larangan yang eksplisit |
| Menangkap banyak Skill tetapi tidak pernah memangkasnya | Skill kedaluwarsa terus mengeluarkan panduan yang salah | Tinjau secara berkala; perbarui saat ada perubahan |
| Mengharapkan perbaikan otonom tanpa peninjauan | Perilaku menjadi tak dapat diprediksi dan sulit didiagnosis | Adopsi lewat `/skills pending` |
| Menangkap prosedur sekali pakai | Biaya pemeliharaan melebihi manfaatnya | Tangkap hanya prosedur yang stabil dan dapat dipakai ulang |

Baris keempat patut ditegaskan: **nilai sebuah perpustakaan Skill tidak sebanding dengan ukurannya.** Satu Skill yang kedaluwarsa dapat merugikan lebih banyak daripada manfaat sepuluh Skill yang baik, karena ia dimuat otomatis dan tampak kredibel.

---

## 7. Pendekatan LightVela: metode sebagai aset pengguna juga

Hermes sudah membuat pemisahan Memory / Skill siap secara rekayasa, tetapi ia masih menyasar orang yang menyunting Markdown secara langsung. LightVela menjalankan model berbasis cloud dan tidak mengekspos operasi sistem file kepada pengguna, sehingga kedua jenis akumulasi itu bekerja seperti ini:

- **Skill berasal dari marketplace publik** — setiap skill berasal dari Skills.sh dan ClawHub, marketplace skill yang digunakan bersama oleh OpenClaw dan Hermes, sehingga Anda tidak menulisnya dari nol.
- **Pasang dan hapus melalui percakapan** — beri tahu Hermes skill mana yang ingin dipasang lalu ia menanganinya; penghapusan bekerja dengan cara yang sama. Verifikasi ketersediaannya di chat setelahnya. Instalasi lewat panel konsol akan segera tersedia.
- **Memori dapat dilihat di konsol** — halaman memori menampilkan apa yang dipertahankan Agent dan memungkinkan Anda menyesuaikan batas kapasitasnya; penambahan dan penghapusan terjadi melalui percakapan.
- **Stabil lintas model dan kanal** — mengganti model tidak menghapus skill maupun otomasi, dan setiap kanal yang terhubung berbagi skill serta memori yang sama.
- **Kegagalan dapat dilacak** — ketika sebuah skill berperilaku salah, lihat dan ekspor log terbaru di Diagnostik (rentang 1, 3, 6, 12, atau 24 jam yang dapat dipilih) untuk menemukan masalahnya.

Dengan kata lain, memakai Agent di LightVela berarti mengumpulkan dua hal: sebuah Memory tentang Anda, dan sekumpulan Skill yang sudah terpasang dan terverifikasi. **Keduanya melayani Anda lebih lama daripada model mana pun.**

---

## Poin penting

- Menjadi lebih baik seiring pemakaian berasal dari akumulasi terstruktur, bukan peningkatan diri yang misterius.
- Dua jenis harus tetap terpisah: **Memory** menyimpan fakta (dipanggil pada kecocokan kueri), **Skill** menyimpan metode (dimuat pada kecocokan situasi).
- Ketika Anda terus mengoreksi perilaku yang sama, tangkap sebuah Skill alih-alih menambahkan fakta lagi.
- `/learn` menangkap metode saat detailnya masih segar; `/skills pending` menyediakan peninjauan, sehingga **perbaikan diri bukan modifikasi diri tanpa batas**.
- Skill yang baik menyatakan empat hal: **kapan memakainya, langkahnya, kriteria keberhasilannya, dan batasnya**.
- Penangkapan berjalan dalam tiga tahap: buktikan di pekerjaan nyata → tangkap langkah stabil yang dapat dipakai ulang → perbarui saat ada perubahan. **Skill yang kedaluwarsa lebih berbahaya daripada tidak ada.**
