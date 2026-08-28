# Beberapa Model

## Ringkasan

**Penggantian model dipakai untuk memilih model terkonfigurasi mana yang sedang digunakan Hermes Agent. Ketika sebuah tugas menuntut kecepatan, kemampuan, pertimbangan biaya, atau ketersediaan penyedia yang berbeda, Anda cukup berganti model tanpa membuat Agent baru. Ini dimungkinkan karena persona, memori, skill, dan tugas otomatis semuanya tersimpan di luar model, sehingga berganti model hanya menukar mesin penalaran — tidak ada yang terbawa atau terhapus, dan Agent tetap mengingat Anda. Setiap Agent hanya memiliki satu model aktif pada satu waktu.**

---

Penggantian model memungkinkan Anda memilih model terkonfigurasi mana yang dipakai Hermes Agent untuk pekerjaan berikutnya. Gantilah ketika sebuah tugas membutuhkan keseimbangan kecepatan, kemampuan, biaya, atau ketersediaan penyedia yang berbeda—tanpa harus membuat Agent baru.

## Yang dibahas di halaman ini

- Menyiapkan lebih dari satu model yang dapat dipakai
- Memilih model aktif untuk sebuah Agent
- Memverifikasi perubahan di Chat
- Menangani model yang tidak muncul atau tidak dapat merespons

> **Perlu diketahui:** Satu Agent memakai satu model aktif pada satu waktu. Mengganti model aktif tidak menghapus memori Agent, file Cloud Storage, Skill, maupun otomasinya.

## Sebelum memulai

1. Buka Agent yang ingin Anda perbarui.
2. Pastikan model tujuan sudah dikonfigurasi dan tersedia untuk akun Anda. Jika belum, ikuti [Konfigurasi Model](./model.md) terlebih dahulu.
3. Siapkan satu prompt uji sederhana agar Anda dapat memastikan model baru merespons seperti yang diharapkan.

## Mengganti model aktif

1. Buka **Agents** lalu pilih Agent tersebut.
2. Buka bagian **Models**.
3. Pilih model terkonfigurasi yang ingin dipakai Agent.
4. Simpan atau terapkan perubahan, lalu tunggu sampai Agent selesai memperbarui konfigurasi aktifnya.

![Pemilih penyedia model di konsol LightVela](../images/4-1-en.webp)

Jika ini kali pertama Anda memilih model, gunakan [Konfigurasi Model](./model.md) untuk menambahkan penyedia yang didukung atau custom model sebelum kembali ke halaman ini.

## Memverifikasi perubahan

Buka [Chat Agent](./agent-chat.md) lalu kirim prompt singkat berisiko rendah, misalnya:

```text
Balas dengan nama model saat ini jika tersedia, lalu rangkum kalimat ini dalam satu baris: Penggantian model sudah siap.
```

Pastikan Agent merespons normal dan model yang ditampilkan di konsol Agent adalah model yang Anda pilih. Jika balasan pertama sedikit lebih lama karena Agent sedang memperbarui, tunggu sebentar dan coba sekali lagi sebelum melakukan perubahan lain.

## Memilih waktu yang tepat untuk berganti

| Situasi | Yang perlu dipertimbangkan |
| --- | --- |
| Anda butuh draf pertama yang lebih cepat | Pilih model terkonfigurasi yang cocok untuk tugas singkat dan rutin. |
| Sebuah tugas butuh reasoning atau bantuan kode yang lebih kuat | Pilih model yang sudah Anda konfigurasikan untuk jenis pekerjaan itu. |
| Sebuah penyedia tidak tersedia atau terkena rate limit | Ganti ke model terkonfigurasi lain, lalu uji di Chat. |
| Anda sedang membandingkan kualitas keluaran | Jalankan prompt kecil yang sama setelah tiap penggantian lalu bandingkan hasilnya. |

Penggantian model mengubah mesin yang dipakai untuk respons selanjutnya. Tindakan ini tidak memindahkan riwayat percakapan Anda, tidak menulis ulang file di [File](./files.md), dan tidak mengubah [Skill](./skill.md) serta [Otomasi](./automation.md) Anda.

Jika Anda ingin menjelajahi lingkungan Agent terpisah dengan arsitektur plugin-first di samping Hermes Agent, lihat [DeepSeek Harness](./deepseek-harness.md).

## Jika penggantian tidak berhasil

1. Kembali ke [Konfigurasi Model](./model.md) lalu pastikan model tujuan, kredensial, dan pengaturan penyedia sudah lengkap.
2. Pastikan model tersebut tersedia untuk akun Anda dan kuota atau kredit penyedianya masih cukup.
3. Pilih model yang sudah pasti berfungsi lalu uji di Chat.
4. Jika Agent masih tidak dapat merespons, buka [Diagnostik](./diagnostics.md) dan tinjau log terbaru sebelum mereset konfigurasi modelnya.

> **Tips:** Ubah satu hal pada satu waktu. Menguji setelah tiap penggantian membuat Anda jauh lebih mudah membedakan apakah masalahnya ada pada model, konfigurasinya, atau tugas itu sendiri.

## FAQ

### Mengapa model yang saya inginkan tidak ada di daftar?

Hanya model terkonfigurasi yang dapat dipilih. Tambahkan atau lengkapi model tersebut di [Konfigurasi Model](./model.md), lalu kembali ke bagian Models.

### Apakah mengganti model menghapus memori Agent saya?

Tidak. Model aktifnya berubah, sementara memori dan pengaturan tersimpan milik Agent tetap ada. Anda dapat meninjau memori secara terpisah di [Pengelolaan Memori](./memory.md).

### Bisakah saya kembali ke model sebelumnya jika hasilnya tidak sesuai?

Bisa. Pilih model terkonfigurasi lain, terapkan perubahannya, lalu uji dengan prompt yang sama. Menjaga prompt tetap konsisten memberi Anda perbandingan yang lebih berguna.

## Langkah berikutnya

- Siapkan penyedia tambahan di [Konfigurasi Model](./model.md).
- Gunakan [Chat Agent](./agent-chat.md) untuk membandingkan respons model pada tugas nyata.
- Gunakan [Diagnostik](./diagnostics.md) jika model terkonfigurasi berulang kali gagal dijalankan.
