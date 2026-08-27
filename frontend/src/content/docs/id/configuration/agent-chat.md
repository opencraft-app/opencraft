# Chat Agent

## Ringkasan

**Halaman Percakapan adalah jendela obrolan bawaan di konsol LightVela yang memungkinkan Anda berbicara langsung dengan Hermes Agent tanpa menghubungkan kanal eksternal — praktis untuk memastikan Agent bekerja tepat setelah model dikonfigurasi. Halaman ini memakai Agent, persona, dan memori jangka panjang yang sama dengan kanal pesan eksternal, sehingga preferensi yang Anda sebutkan di sini juga berlaku di kanal lain, dan sebaliknya.**

---

Buka halaman "Chat" untuk berinteraksi dengan Hermes Agent Anda melalui jendela percakapan.

> ℹ️ **Perlu diketahui**
>
> Panduan antarmuka AgentChat saat ini masih sebagian besar berbahasa Tiongkok; pelokalan penuh sedang dikerjakan.

![Halaman Chat di konsol LightVela](../images/chat-overview-en.png)

---

## Memori percakapan

Hermes Agent dapat berkembang dan menyesuaikan diri sendiri seiring percakapan berlanjut. Pelajari memori Agent Anda lebih lanjut dengan membuka halaman "Memory".

![](../images/agentchat-2-global-en.webp)

### Cara kerja memori

Hermes Agent membangun memori jangka panjang secara otomatis melalui dua mekanisme:

- **Kompresi konteks**: menyaring informasi kunci dari percakapan panjang menjadi memori yang bertahan lama.

- **Simpul memori penting**: secara otomatis menangkap preferensi pribadi, kebiasaan penggunaan, dan informasi terkait proyek yang layak dipakai ulang nanti.

### Cara memori disimpan

Memori dipertahankan ke dalam dua jenis dokumen:

- `MEMORY.md`: informasi proyek, lingkungan runtime, dan konvensi kolaborasi

- `USER.md`: preferensi pribadi, kebiasaan penggunaan, dan gaya komunikasi pengguna

Hanya konten yang bernilai jangka panjang yang dipertahankan, sehingga Hermes Agent dapat memberikan balasan yang koheren dan personal pada percakapan berikutnya.

---
