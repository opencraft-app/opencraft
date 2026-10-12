# Mula Pantas

## Ringkasan

**Untuk memulakan perbualan pertama anda dalam LightVela, daftar masuk dan aktifkan pelan, tunggu sehingga Bot anda sedia, kemudian buka Harian → Sembang di Ejen Saya dan hantar mesej. Tiada saluran mesej diperlukan untuk Sembang Web, dan kredit model pelan yang tersedia membolehkan anda mula tanpa menambah kunci API anda sendiri. Jika anda juga ingin menggunakan Bot yang sama dalam WeChat, ikut langkah kod QR di halaman ini kemudian.**

---

Tutorial ini bermula dengan Web Chat, kemudian menunjukkan cara untuk menyambung WeChat jika diperlukan. Benarkan masa tambahan untuk pemeriksaan pelan dan penyediaan Ejen.

## Halaman ini meliputi

- Log masuk ke LightVela

- Mengaktifkan pilihan Pelancaran dan membuka contoh Hermes anda

- Menghantar mesej pertama anda dalam Web Chat

- Menyambung WeChat jika perlu

- Menghantar mesej dalam WeChat dan menerima balasan

> 💡 **Prasyarat**
>
> - Akaun Google atau GitHub
>
> Pelan Pelancaran termasuk 100 kredit percubaan, jadi anda boleh mula bersembang tanpa menyediakan Kunci API model bahasa yang besar terlebih dahulu.

---

## 1. Log masuk ke LightVela

Buka [lightvela.ai](https://lightvela.ai) dan pilih **Log Masuk** di sudut kanan atas. Dalam dialog log masuk, baca dan setujui perjanjian, kemudian pilih **Google** atau **GitHub** dan lengkapkan kebenaran.

![Dialog log masuk LightVela dengan Google dan GitHub](../images/2-1.webp)

---

## 2. Aktifkan pelan Pelancaran

Buka [halaman Langgan](/subscribe), pilih pilihan **100-kredit Pelancaran** dalam siri Pelancaran, dan ikuti kad pelan sehingga semasa pembayaran. Semak harga yang dipaparkan dan tawaran pesanan pertama sebelum mengesahkan.

> ⚠️ **Tawaran pengenalan untuk pengguna baru**
>
> Pengguna baru yang layak boleh mencuba Launch selama 1 bulan. Semak [halaman Langgan](/subscribe/) untuk syarat dan ketersediaan semasa.

---

## 3. Buka Hermes Agent anda

Selepas log masuk dengan Google atau GitHub dan mengaktifkan pelan yang tersedia, buka [konsol Agent](/agents/overview/). Lengkapkan persediaan Bot pertama: masukkan nama yang wajib, tambah penerangan jika perlu, dan laraskan penampilannya. Pilih **Buat** dan tunggu penciptaan serta konfigurasi awal selesai. Selepas konfigurasi selesai, pilih **Mulakan perjalanan**, kemudian buka sembang web untuk Bot itu. Saluran pemesejan adalah pilihan; balasan memerlukan kredit model pelan yang tersedia atau model yang telah dikonfigurasi.

---

## 4. Mulakan perbualan dalam Web Chat

Aponce Bot sudah sedia, buka Harian → Sembang di bar sisi, pilih Perbualan baru, dan hantar “Hi.” Sebuah balasan menamatkan Sembang Web pertama anda; lihat [Sembang](./configuration/agent-chat.md) untuk kawalan perbualan.

## 5. Sambungkan WeChat jika perlu

Buka **Saluran** di bar sisi Ejen. Pada kad **WeChat**, pilih **+ Sambung** dan ikut arahan kod QR. Imbas kod dengan WeChat di telefon anda dan selesaikan pengesahan di sana. Sahkan bahawa WeChat muncul sebagai disambungkan dalam konsol sebelum menghantar mesej. Lihat [Konfigurasikan Saluran - WeChat](./configuration/channel-wechat.md) jika kod tamat tempoh atau sambungan gagal.

---

## 6. Hantar mesej dalam WeChat

Cari akaun bot yang ditambahkan dalam WeChat dan hantar mesej ujian:

```text
Hi
```

![Mesej ujian dan balasan Bot dalam WeChat](../images/2-7.webp)

Anda akan menerima balasan daripada Hermes dalam masa beberapa saat. Hermes kini boleh bersembang melalui WeChat.

> 💡 **Pengebilan mesej**
>
> Secara lalai, panggilan model menggunakan 100 kredit yang disertakan dalam pilihan Pelancaran. Jika kredit habis, anda boleh membeli [pakej kredit](./credits.md) yang layak atau mengkonfigurasi kekunci API anda sendiri dalam **Model**.

---

## Lanjutan: konfigurasikan model anda sendiri (pilihan)

Jika anda memerlukan penyedia tertentu, buka **Models** dalam bar sisi Ejen, pilih penyedia dan model, tambah kunci APInya, dan tetapkan model utama. Lihat [Configure Models](./configuration/model.md).

---

## Soalan Lazim

| Isu | Apa yang perlu diperiksa | Langkah seterusnya |
|---|---|---|
| Pilihan Lancar tidak boleh diaktifkan | Ketersediaan semasa, kelayakan, atau status pembayaran | Semak semula [halaman Langgan](/subscribe) dan mesej pembayaran akhir; elakkan mengulang pesanan yang telah lengkap. |
| Penetapan Ejen mengambil masa lebih lama daripada dijangka | Sama ada konsol masih menunjukkan penyediaan atau ralat | Segarkan tontonan Ejen sekali; jika keadaan tidak berubah, gunakan [Diagnostik](./configuration/diagnostics.md) atau hubungi sokongan. |
| Kod QR WeChat tamat tempoh | Sama ada kebenaran telah selesai di telefon | Buka semula **Saluran** dan mulakan percubaan sambungan baru. |
| Mesej tidak mendapat balasan | Sambungan saluran, status Ejen, dan kredit model | Semak **Saluran** dan **Diagnostik**. Jika kredit telah habis, semak [opsi kredit](./credits.md). |
---

## Langkah seterusnya

- [Konsep Teras](./04-core-concepts.md) — Fahami lima konsep teras: Hermes Agent, Bots, model, saluran, dan kemahiran

- [Gambaran Keseluruhan Konfigurasi](./05-configuration.md) — Struktur konsol keseluruhan

- [Konfigurasikan Kemahiran](./configuration/skill.md) — Pasang Kemahiran dari Skills.sh atau ClawHub
