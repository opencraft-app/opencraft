# Pengelolaan Memori

## Ringkasan

**Memori membuat Hermes mengingat hal penting lintas percakapan dan lintas perangkat — preferensi Anda, identitas Anda, hal yang sedang Anda kerjakan, serta pengalaman yang terkumpul dalam kolaborasi jangka panjang. Inilah dasar yang mengubah Hermes dari tanya-jawab sekali pakai menjadi asisten yang makin memahami Anda. Memori tersimpan di dalam Agent dan di luar model, sehingga berganti model tidak membuatnya lupa. Anda dapat meninjau, menyunting, atau membersihkan isi yang terkumpul pada halaman memori dan profil pengguna di konsol, dan semua kanal pesan berbagi satu memori yang sama.**

---

Memori membantu Hermes mempertahankan informasi penting lintas percakapan dan lintas perangkat—preferensi Anda, identitas, pekerjaan yang sedang berjalan, dan pengalaman yang terbentuk melalui kolaborasi jangka panjang. Inilah yang mengubah Hermes dari alat tanya-jawab sekali pakai menjadi asisten jangka panjang yang makin memahami Anda seiring waktu.

![Halaman Memory dan User Profile di konsol LightVela](../images/memory-management-overview-en.png)

LightVela berjalan di cloud, sehingga memori ini disimpan bersama instans Hermes Anda di cloud. Memori tidak hilang saat Anda berganti perangkat atau berpindah antara Telegram, WhatsApp, Discord, Slack, dan WeChat. Jika hari ini Anda memberi tahu Hermes sesuatu di Telegram, besok ia tetap dapat mengingatnya saat Anda melanjutkan percakapan di WhatsApp.

## Yang dibahas di halaman ini

- Masalah yang diselesaikan oleh memori

- Dua jenis memori: memori Agent dan profil pengguna

- Cara melihat memori dan pemakaian kapasitas di konsol

- Cara menyesuaikan batas kapasitas memori

- Cara menambah atau menghapus memori melalui percakapan

- Pertanyaan yang sering diajukan

> 💡 **Memori terbentuk otomatis—Anda tidak perlu mengisinya secara manual**
>
> Anda tidak perlu mengisi formulir memori. Selama percakapan normal, Hermes menentukan sendiri informasi mana yang cukup berguna untuk dipertahankan. Halaman Memory di konsol terutama digunakan untuk **meninjau** apa yang diingat Hermes dan **menyesuaikan kapasitas** bila diperlukan.

---

## Mengapa memori itu penting

Tanpa memori, setiap percakapan dengan asisten AI dimulai dari halaman kosong. Anda harus menjelaskan lagi siapa Anda, apa yang Anda sukai, dan sampai mana percakapan terakhir berhenti. Memori mengatasi masalah itu:

- **Lebih sedikit mengulang diri sendiri**: Beri tahu Hermes sekali saja bahwa Anda tinggal di Singapura dan menyukai ringkasan pagi, maka Anda tidak perlu menyebutkannya setiap kali.

- **Konsisten di semua kanal**: Telegram, WhatsApp, Discord, Slack, dan WeChat berbagi memori yang sama. Saat berpindah kanal, Anda tetap berbicara dengan asisten yang sama dan memahami Anda.

- **Makin baik seiring pemakaian**: Selagi Anda bekerja bersama, Hermes mengingat rutinitas Anda, nama panggilan yang Anda sukai, dan proyek yang sedang aktif, sehingga responsnya makin relevan.

Anggap memori sebagai buku catatan jangka panjang Hermes. Ia tidak menyimpan setiap pesan sepele; ia mempertahankan detail yang kemungkinan berguna nanti.

---

## Dua jenis memori

Halaman Memory di konsol memiliki dua tab, masing-masing dengan tujuan berbeda:

### Memory

Bagian ini memuat **pengalaman dan fakta** yang terbentuk pada Hermes melalui kolaborasi jangka panjang—preferensi yang sudah Anda sampaikan, cara kerja yang disepakati, dan kebutuhan yang berulang seiring waktu. Hermes memelihara konten ini secara otomatis selama percakapan, dan entrinya berkembang selagi Anda terus memakainya.

### User Profile

Ini adalah catatan stabil tentang **siapa Anda**, seperti identitas, lokasi, latar belakang profesional, dan preferensi jangka panjang. Dibandingkan memori umum, profil pengguna bekerja lebih seperti kartu profil permanen yang membantu Hermes cepat memahami konteks dasar Anda di percakapan apa pun.

> ℹ️ **Perbedaannya**
>
> Singkatnya, **profil pengguna** menjawab "Anda ini orang seperti apa?" sedangkan **memori** menjawab "Apa yang sudah terjadi di antara kita, dan apa yang sudah kita sepakati?" Bersama-sama, keduanya membantu Hermes memahami Anda sekaligus riwayat kolaborasi Anda.

---

## Melihat memori dan pemakaian kapasitas

1. Masuk ke LightVela lalu klik "My Hermes" di kanan atas untuk membuka konsol.

2. Temukan "Memory" di navigasi pengaturan lalu buka halaman Memory.

3. Di bagian atas halaman, tinjau **statistik memori**: jumlah karakter yang terpakai saat ini, batas kapasitas, dan persentase pemakaian.

4. Berpindah antara tab "Memory" dan "User Profile" untuk meninjau tiap jenis konten.

Jika salah satu jenis masih kosong, halaman akan menampilkan "No Agent memory" atau "No user profile". Ini biasanya berarti Anda belum cukup lama bekerja dengan Hermes untuk membentuk jenis memori tersebut. Kontennya akan bertambah seiring waktu.

> 💡 **Arti persentase pemakaian**
>
> Memori memiliki batas kapasitas. Saat pemakaian mendekati batas tersebut, Hermes mengutamakan informasi yang lebih penting dan membuang entri yang sudah tidak relevan. Memantau persentasenya membantu Anda memutuskan apakah perlu menambah kapasitas atau menghapus informasi yang tidak lagi diperlukan.

---

## Menyesuaikan batas kapasitas memori

Anda dapat menaikkan batas kapasitas ketika ingin Hermes mempertahankan lebih banyak informasi, atau menurunkannya bila memang sesuai kebutuhan.

- **Memory** dapat diatur dari 500 sampai 4.000 karakter.

- **User Profile** dapat diatur dari 500 sampai 3.000 karakter.

Batas baru berlaku setelah Anda menyimpannya.

> ⚠️ **Menyimpan batas baru akan me-restart gateway sesaat dan dapat memutus percakapan yang sedang berjalan**
>
> Saat Anda menyimpan batas kapasitas baru, gateway Hermes akan restart sesaat untuk menerapkan konfigurasi. Percakapan yang sedang berlangsung bisa terputus sebentar dan akan pulih segera setelahnya. Lakukan perubahan ini pada waktu ketika gangguan singkat tidak mengganggu pekerjaan Anda.

---

## Menambah atau menghapus memori melalui percakapan

Selain meninjau konten di konsol, Anda dapat langsung meminta Hermes mengingat atau melupakan informasi. Cara ini biasanya paling alami untuk memelihara memori dalam pemakaian sehari-hari.

**Minta ia mengingat:**

```
Ingat bahwa saya ingin ringkasan harian pukul 08.00.
```

```
Ingat bahwa saya lebih suka jawaban yang ringkas dan langsung.
```

**Minta ia melupakan:**

```
Saya tidak lagi memerlukan ringkasan harian yang kita bahas. Tolong lupakan preferensi itu.
```

Hermes akan menafsirkan maksud Anda, memperbarui entri memori yang relevan, dan memberi tahu apa yang berubah.

> ℹ️ **Konten memori saat ini dipelihara melalui percakapan**
>
> LightVela memakai model cloud terkelola dan tidak menyediakan operasi sistem file bagi pengguna. Tambah atau hapus konten memori terutama dengan berbicara kepada Hermes; gunakan konsol untuk meninjau konten dan menyesuaikan batas kapasitas.

---

## FAQ

### Mengapa Hermes mengingat sesuatu yang tidak saya minta secara eksplisit untuk disimpan?

Ini memang perilaku yang diharapkan. Hermes otomatis mengidentifikasi informasi yang mungkin berguna dalam jangka panjang, seperti preferensi, identitas, dan kesepakatan kerja Anda. Jika Anda tidak ingin ia menyimpan sesuatu, minta ia melupakan informasi tersebut dalam percakapan.

### Apakah memori tetap ada saat saya berganti perangkat atau kanal?

Ya. Memori disimpan bersama instans cloud dan tidak bergantung pada satu perangkat atau kanal tertentu. Telegram, WhatsApp, Discord, Slack, dan WeChat berbagi memori yang sama.

### Apa yang terjadi ketika memori mencapai kapasitas?

Saat pemakaian mendekati batas, Hermes memprioritaskan informasi yang lebih penting dan perlahan membuang entri yang sudah tidak relevan atau kurang berguna. Jika Anda perlu ia mempertahankan lebih banyak, naikkan batas kapasitas di halaman Memory.

### Mengapa halaman Memory menyatakan tidak ada memori?

Jenis memori tersebut belum mengumpulkan konten apa pun. Lanjutkan bekerja bersama Hermes, atau langsung minta ia mengingat detail penting, maka konten akan mulai muncul.

### Mengapa percakapan saya terhenti setelah saya mengubah batas kapasitas?

Menyimpan batas baru memicu restart gateway singkat, yang dapat memutus percakapan sesaat. Tunggu sebentar, lalu kirim pesan tersebut kembali.

---

## Langkah berikutnya

Memori membantu Hermes mengingat Anda. Selanjutnya, beri ia lebih banyak cara untuk bertindak:

- [Konfigurasi Skill](./skill.md) — Tambahkan kemampuan seperti pencarian cuaca, ringkasan, dan penjelajahan web

- [Tugas Terjadwal](./automation.md) — Biarkan Hermes menjalankan tugas secara proaktif sesuai jadwal

- [Ringkasan Konfigurasi](../05-configuration.md)
