# Cara Membina Pembantu AI Peribadi dengan LightVela

## Ringkasan

**Susunan yang betul untuk membina pembantu AI peribadi bukanlah mengautomasikan semuanya sekaligus. Mulakan dengan membuat awan Hermes Agent boleh dicapai dalam apl sembang yang telah anda gunakan, kemudian lapisan pada memori, kemahiran dan tugasan yang dijadualkan.** Lima blok binaan setiap satu menyelesaikan satu masalah: model menentukan kualiti penaakulan, saluran menentukan di mana anda mencapainya, memori membolehkannya mengekalkan cara anda bekerja, kemahiran memberikannya kaedah yang boleh diguna semula dan tugas berjadual membolehkannya menyelesaikan kerja yang dipersetujui semasa anda tidak hadir. Untuk minggu pertama, lakukan hanya tiga perkara: konfigurasikan satu model, sambungkan satu saluran dan sahkan memori benar-benar berterusan merentas sesi. Setelah laluan itu boleh dipercayai, tambah kemahiran dan tugasan yang dijadualkan — dengan cara ini, apabila sesuatu pecah, anda boleh mengetahui lapisan mana yang menyebabkannya.

![Pembantu AI peribadi dengan LightVela merentasi saluran](../../images/use-case-personal-ai-assistant.webp)

## Untuk siapa ini

Persediaan ini berfungsi dengan baik jika anda mahukan seorang pembantu untuk perancangan harian, penyelidikan susulan, peringatan dan soalan yang mendapat manfaat daripada mengetahui pilihan anda. Anda tidak memerlukan aliran kerja yang rumit. Mulakan dengan satu Hermes Agent dan satu saluran yang anda sudah semak dengan kerap.

Ia amat berguna apabila anda mendapati diri anda mengulangi konteks seperti zon waktu anda, format yang anda sukai untuk ringkasan, projek yang anda sedang kerjakan atau jenis bantuan yang anda inginkan setiap pagi.

## Prasyarat

- Akaun LightVela dan Hermes Agent yang sedang berjalan. Jika anda belum menciptanya lagi, mulakan dengan [Mula Pantas](https://lightvela.ai/docs/quickstart).

- Satu saluran perbualan. Telegram, WhatsApp, Discord, Slack, dan WeChat adalah titik permulaan biasa; pilih yang paling mungkin anda buka setiap hari.

- Konfigurasi model yang berfungsi atau kredit percubaan yang tersedia. Lihat [Konfigurasikan Model](https://lightvela.ai/docs/configuration/model) jika Hermes tidak boleh membalas lagi.

- Idea ringkas tentang perkara yang anda mahukan bantuan dahulu. Satu rutin, seperti merancang hari anda atau mengumpul susulan, sudah memadai.

## Langkah / konsep utama

### 1. Memberi Hermes tempat dalam rutin harian anda

Sambungkan satu saluran pemesejan, kemudian hantar beberapa mesej pertama dari tempat yang sama yang biasa anda aturkan hari anda. Saluran itu bukan sekadar kaedah penyampaian—ialah tabiat yang menjadikan pembantu mudah untuk kembali. Ikuti halaman persediaan untuk [Telegram](https://lightvela.ai/docs/configuration/channel-telegram), [WhatsApp](https://lightvela.ai/docs/configuration/channel-whatsapp), [Discord](https://lightvela.ai/docs/configuration/channel-discord), [Slack](https://lightvela.ai/docs/configuration/channel-slack), atau [WeChat](https://lightvela.ai/docs/configuration/channel-wechat).

![Halaman Saluran dalam konsol LightVela](../../images/personal-ai-assistant-channel.webp)

Mulakan dengan pengenalan yang jelas dan bukannya permintaan yang luas. Contohnya:

```text
I want you to be my personal planning assistant. I am in Singapore time.
Keep daily plans short, call out deadlines first, and ask one follow-up question when something is unclear.
```

### 2. Biarkan ingatan membawa konteks yang berulang

Hermes membina konteks yang berguna dari semasa ke semasa, jadi anda tidak perlu menyatakan semula setiap pilihan dalam setiap perbualan. Beritahu fakta dan pilihan kerja yang sepatutnya kekal berguna: zon waktu anda, cara anda mahu taklimat berstruktur, nama projek penting, atau hari yang anda lebih suka untuk merancang lebih awal.

Anda juga boleh menyatakan permintaan secara langsung:

```text
Remember that I prefer a concise weekday briefing at 8:00 AM,
with meetings, deadlines, and the three most important next actions.
```

Gunakan halaman [Pengurusan Memori](https://lightvela.ai/docs/configuration/memory) untuk menyemak memori dan maklumat profil pengguna yang Hermes telah terkumpul. Ingatan harus mengurangkan pengulangan, bukan menjadi tempat pembuangan untuk setiap butiran yang berlalu.

### 3. Tambahkan kemahiran hanya apabila tugas sebenar memerlukannya

Hermes boleh berbual tanpa kemahiran tambahan. Tambahkan satu apabila anda boleh menamakan kerja praktikal yang sepatutnya membantu, seperti mencari maklumat, mengatur senarai tugasan atau menyediakan laporan berulang. Ini memastikan pembantu mudah difahami dan lebih mudah dipercayai.

![Halaman Kemahiran dalam konsol LightVela](../../images/personal-ai-assistant-skills.webp)

Semak imbas pilihan yang sesuai dalam ClawHub, kemudian gunakan [Konfigurasikan Kemahiran](https://lightvela.ai/docs/configuration/skill) untuk memasangnya. Sebelum anda memasang apa-apa, baca penerangannya dan pilih sumber yang anda percayai.

### 4. Tukar perbualan yang berguna menjadi daftar masuk berulang

Setelah gesaan boleh dipercayai berguna, tentukan sama ada ia harus dijalankan mengikut jadual. Tugasan berjadual mudah boleh meminta Hermes untuk rancangan pagi, semakan akhir hari atau tetapan semula mingguan tanpa anda ingat untuk memulakan perbualan.

Contohnya:

```text
Every weekday at 8:00 AM, prepare a concise plan for today.
Start with deadlines and meetings, then suggest three focused next actions.
```

Tetapkan jadual dan saluran pemberitahuan dalam [Tugas Berjadual](https://lightvela.ai/docs/configuration/automation). Pastikan tugas yang dijadualkan pertama kecil; anda boleh memperhalusi arahan selepas anda melihat beberapa hasil sebenar.

![Halaman Tugas Berjadual dalam konsol LightVela](../../images/personal-ai-assistant-automations.webp)

## Soalan Lazim

### Adakah saya perlu mengkonfigurasi setiap ciri sebelum Hermes berguna?

Tidak. Saluran dan model yang berfungsi sudah cukup untuk bermula. Tambahkan memori, kemahiran dan tugasan berjadual secara beransur-ansur apabila anda menemui tugasan berulang yang patut disimpan.

### Adakah Hermes akan mengingati setiap mesej yang saya hantar?

Tidak. Memori bertujuan untuk maklumat yang kekal berguna merentas perbualan, seperti pilihan, kerja berulang dan konteks yang stabil. Anda boleh meminta Hermes untuk mengingati atau melupakan maklumat apabila diperlukan, kemudian menyemaknya dalam Pengurusan Memori.

### Bolehkah saya menggunakan pembantu yang sama daripada lebih daripada satu saluran?

ya. Berbilang saluran yang disambungkan boleh menghala ke Hermes Agent yang sama, jadi pembantu boleh mengekalkan konteks yang sama semasa anda bergerak antara platform pemesejan yang disokong.

### Apakah yang perlu saya automatikkan dahulu?

Pilih tugasan yang telah anda ulangi pada masa yang boleh diramal. Perancangan pagi, semakan harian pendek atau semakan keutamaan mingguan adalah calon pertama yang baik kerana anda boleh mengetahui dengan cepat sama ada output itu membantu.

## Langkah seterusnya

- [Sembang](https://lightvela.ai/docs/configuration/agent-chat) — bekerja dengan Hermes terus dalam konsol.

- [Pengurusan Memori](https://lightvela.ai/docs/configuration/memory) — semak perkara yang disimpan oleh pembantu anda merentas perbualan.

- [Tugas Berjadual](https://lightvela.ai/docs/configuration/automation) — jadualkan rutin yang terbukti berguna.
