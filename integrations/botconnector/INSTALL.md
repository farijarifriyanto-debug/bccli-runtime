# BCCLI — instalasi pengguna (npm)

BCCLI adalah **satu aplikasi CLI**. Pengguna tidak perlu membuat launcher sendiri, menginstal versi kedua, mengunduh arsip GitHub, atau menggunakan folder terisolasi. Folder terisolasi hanya dipakai pengembang untuk menguji paket tanpa mengganggu instalasi yang sudah ada.

## Instalasi normal (Windows, Linux, macOS)

Pastikan Node.js versi yang kompatibel dan `npm` telah terpasang. Gunakan Node.js 22.23.4 atau lebih baru pada lini 22 untuk Windows; pada lini Windows Node.js 24, gunakan 24.22.1 atau lebih baru. Engine mengharuskan Node.js >=22. Jika memakai NVM, pilih versi Node.js yang akan digunakan sebelum instalasi karena setiap versi NVM menyimpan paket globalnya secara terpisah.

```sh
npm install -g @botconnector/bccli
bccli
```

Perintah yang sama memperbarui versi global yang sudah ada **pada prefix npm aktif**. Setelah instalasi tidak ada langkah `--prefix`, symlink manual, atau perintah `bccli-preview` / `bccli-legacy`.

```sh
bccli --version
bccli auth status
bccli --choose
```

`bccli` langsung membuka chat menggunakan provider dan model aktif jika kredensial sudah tersedia. `--choose` hanya untuk mengganti provider/model. Model saat ini diperiksa terhadap daftar model provider.

## Autentikasi pertama kali

**Windows:** BCCLI menerima API key BotConnector Cloud langsung dari terminal saat pertama dijalankan. Pilih BotConnector Cloud pada menu `bccli` atau gunakan `bccli --choose`; untuk mengganti key, pilih `1!`. Alternatifnya, jalankan `bccli provider add botconnector`. Input key disembunyikan dan disimpan terenkripsi dengan Windows DPAPI. Pada menu, katalog model diperiksa sebelum key baru ditulis. Key lama tetap aman jika validasi gagal. Credential `bc-cloud` lama tetap menjadi fallback tanpa migrasi otomatis.

**Linux/macOS:** untuk Cloud, gunakan `BOTCONNECTOR_API_KEY` sebagai variabel lingkungan. Persistensi terenkripsi lintas platform belum didukung.

Provider pihak ketiga tersedia dalam menu. Penyimpanan API key melalui menu didukung di Windows (DPAPI). Pada Linux/macOS, gunakan variabel lingkungan provider seperti `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, atau `XAI_API_KEY`. Jangan menaruh API key dalam repository, tangkapan layar, atau log.

## Versi dan batasan rilis

- Versi yang dibangun dan diuji CI dibaca dari satu berkas: `integrations/botconnector/release/VERSION`. Untuk memotong rilis berikutnya, ubah berkas itu satu baris dan tambahkan `integrations/botconnector/release/NOTES-<versi>.md`. Tidak ada versi lain yang ditulis di skrip rilis atau workflow.
- Periksa tag distribusi sebelum memasang: `npm view @botconnector/bccli dist-tags`.
- `latest` menunjuk ke rilis stabil; pasang tanpa tag: `npm install -g @botconnector/bccli`.
- Ini CLI dengan engine bawaan yang diverifikasi; paket legacy 0.4.17 dipin integritasnya sebagai lapisan kompatibilitas SDK, bukan aplikasi kedua.
- Uninstall standar: `npm uninstall -g @botconnector/bccli`.
- Dependensi `@qwen-code/qwen-code` adalah engine internal BCCLI yang dibundel, bukan aplikasi BCCLI kedua. Lisensi dan atribusi upstream tetap dipertahankan.

Paket dan checksum resmi: https://github.com/farijarifriyanto-debug/bccli-runtime/releases
