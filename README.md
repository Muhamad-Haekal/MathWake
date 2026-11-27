<div align="center">

<img src="docs/images/logo.png" alt="Logo MathWake" width="120">

# MathWake

**Aplikasi alarm yang baru berhenti setelah penggunanya menyelesaikan tantangan matematika.**

![React Native](https://img.shields.io/badge/React_Native-20232A?style=flat-square&logo=react&logoColor=61DAFB)
![Expo](https://img.shields.io/badge/Expo-000020?style=flat-square&logo=expo&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Kotlin](https://img.shields.io/badge/Kotlin-7F52FF?style=flat-square&logo=kotlin&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=flat-square&logo=supabase&logoColor=white)
![Lisensi MIT](https://img.shields.io/badge/Lisensi-MIT-informational?style=flat-square)

<br>

<a href="https://expo.dev/accounts/nextherinn/projects/MathWake/builds/eba85465-81a0-4561-a815-14f9e6f5167a"><img src="https://img.shields.io/badge/PASANG_DEMO-FF6B00?style=for-the-badge&logo=expo&logoColor=white" alt="Pasang Demo"></a>
&nbsp;
<a href="https://github.com/Muhamad-Haekal/MathWake"><img src="https://img.shields.io/badge/SOURCE_CODE-181717?style=for-the-badge&logo=github&logoColor=white" alt="Source Code"></a>

<sub>Karya untuk Traspac Competition 2027</sub>

</div>

---

<div align="center">

<a href="#tentang"><img src="https://img.shields.io/badge/Tentang-30363D?style=flat-square" alt="Tentang"></a>
<a href="#cara-kerja"><img src="https://img.shields.io/badge/Cara_Kerja-30363D?style=flat-square" alt="Cara Kerja"></a>
<a href="#tampilan-aplikasi"><img src="https://img.shields.io/badge/Tampilan-30363D?style=flat-square" alt="Tampilan"></a>
<a href="#fitur"><img src="https://img.shields.io/badge/Fitur-30363D?style=flat-square" alt="Fitur"></a>
<a href="#memasang-dan-mencoba-demo"><img src="https://img.shields.io/badge/Pasang_dan_Coba-30363D?style=flat-square" alt="Pasang dan Coba"></a>
<a href="#teknologi"><img src="https://img.shields.io/badge/Teknologi-30363D?style=flat-square" alt="Teknologi"></a>
<a href="#status-pengembangan"><img src="https://img.shields.io/badge/Status-30363D?style=flat-square" alt="Status"></a>
<a href="#istilah"><img src="https://img.shields.io/badge/Istilah-30363D?style=flat-square" alt="Istilah"></a>
<a href="#tanya-jawab"><img src="https://img.shields.io/badge/FAQ-30363D?style=flat-square" alt="FAQ"></a>

</div>

---

## Tentang

Alarm biasa mudah dimatikan: satu sentuhan, lalu pengguna kembali tidur. MathWake mengubah hal itu. Alarm hanya berhenti setelah pengguna menyelesaikan tantangan matematika, sehingga pengguna benar-benar terjaga sebelum alarm diam.

Pengguna dapat memilih tiga tingkat kesulitan (Mudah, Sedang, Sulit) dari **1.250 soal**. Selain alarm, MathWake menyediakan Snooze, Timer, Stopwatch, dan Statistik aktivitas.

## Cara kerja

1. Pengguna membuka MathWake, lalu login atau membuat akun.
2. Pengguna membuat alarm, menentukan waktu, dan memilih tingkat kesulitan.
3. Saat waktunya tiba, alarm berbunyi dan layar Reminder terbuka secara otomatis.
4. Pengguna mengerjakan tantangan matematika.
5. Jika jawaban salah, kesempatan menjawab dibatasi.
6. Alarm berhenti setelah tantangan diselesaikan.

```mermaid
flowchart TD
    A([Buka MathWake]) --> B[Login atau Register]
    B --> C[Buat alarm: waktu dan tingkat kesulitan]
    C --> D[Simpan alarm]
    D --> E{{Waktu alarm tiba}}
    E --> F[Alarm berbunyi, Reminder terbuka otomatis]
    F --> G[Kerjakan tantangan matematika]
    G --> H{Jawaban benar?}
    H -- Ya --> I([Alarm berhenti])
    H -- Tidak --> J[Kesempatan menjawab berkurang]
    J --> G
```

## Tampilan aplikasi

<table>
  <tr>
    <td align="center" width="33%">
      <img src="docs/images/Dashboard.jpeg" alt="Dashboard MathWake" width="220"><br>
      <sub><b>Dashboard</b><br>Halaman utama aplikasi</sub>
    </td>
    <td align="center" width="33%">
      <img src="docs/images/Edit%20Alarm.jpeg" alt="Layar edit alarm MathWake" width="220"><br>
      <sub><b>Edit Alarm</b><br>Atur waktu alarm</sub>
    </td>
    <td align="center" width="33%">
      <img src="docs/images/Form%20Tantangan.jpeg" alt="Form tantangan matematika MathWake" width="220"><br>
      <sub><b>Form Tantangan</b><br>Tantangan matematika</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%">
      <img src="docs/images/Reminder.jpeg" alt="Layar Reminder MathWake" width="220"><br>
      <sub><b>Reminder</b><br>Terbuka otomatis saat alarm berbunyi</sub>
    </td>
    <td align="center" width="33%">
      <img src="docs/images/Timer.jpeg" alt="Layar Timer MathWake" width="220"><br>
      <sub><b>Timer</b><br>Hitung mundur</sub>
    </td>
    <td align="center" width="33%">
      <img src="docs/images/Stopwatch.jpeg" alt="Layar Stopwatch MathWake" width="220"><br>
      <sub><b>Stopwatch</b><br>Pengukur durasi</sub>
    </td>
  </tr>
</table>

## Fitur

| Fitur | Keterangan |
|---|---|
| Login dan Register | Akun wajib; data alarm dan statistik tersimpan per pengguna |
| Alarm | Atur waktu alarm sesuai kebutuhan |
| Tantangan matematika | Tiga tingkat kesulitan: Mudah, Sedang, Sulit (1.250 soal) |
| Batas kesempatan menjawab | Jawaban salah dibatasi agar tidak dapat ditebak terus-menerus |
| Stop alarm | Hanya dapat dilakukan setelah tantangan diselesaikan |
| Snooze | Menunda alarm sementara |
| Reminder otomatis | Layar tantangan terbuka sendiri saat alarm berbunyi |
| Statistik | Ringkasan aktivitas berdasarkan data penggunaan nyata |
| Timer | Hitung mundur |
| Stopwatch | Pengukur durasi |

## Memasang dan mencoba demo

**Yang dibutuhkan:** HP Android dan koneksi internet. Tidak perlu akun khusus; buat akun sendiri di dalam aplikasi.

> Disarankan memakai Android. Alarm native dikembangkan dan diuji di Android, sedangkan iPhone belum diuji.

### Memasang

1. Buka link demo di HP Android:

   <a href="https://expo.dev/accounts/nextherinn/projects/MathWake/builds/eba85465-81a0-4561-a815-14f9e6f5167a"><img src="https://img.shields.io/badge/BUKA_LINK_DEMO-FF6B00?style=for-the-badge&logo=expo&logoColor=white" alt="Buka link demo"></a>

2. Ikuti tombol pemasangan pada halaman tersebut untuk mengunduh dan memasang aplikasi.
3. Jika Android meminta izin memasang aplikasi dari luar Play Store, izinkan.
4. Buka MathWake. Jika aplikasi meminta izin, misalnya notifikasi, izinkan agar alarm dapat berbunyi tepat waktu.

### Mencoba

1. Buat akun melalui halaman Register, lalu masuk.
2. Buat alarm dengan waktu beberapa menit dari sekarang.
3. Pilih tingkat kesulitan matematika, lalu simpan alarm.
4. Tunggu alarm berbunyi dan amati apakah layar Reminder terbuka otomatis.
5. Kerjakan tantangan. Coba menjawab dengan benar maupun salah untuk melihat batas kesempatan.
6. Selesaikan tantangan untuk menghentikan alarm.
7. Coba juga Snooze, Timer, Stopwatch, dan Statistik.

## Teknologi

| Teknologi | Peran |
|---|---|
| React Native dan Expo | Pengembangan aplikasi mobile |
| TypeScript | Bahasa utama aplikasi |
| Kotlin | Integrasi alarm native di Android |
| Supabase | Backend untuk akun, login, dan penyimpanan data |

## Status pengembangan

| Status | Cakupan |
|---|---|
| Selesai | Login/Register, Alarm, Tantangan matematika, Batas kesempatan menjawab, Stop alarm, Snooze, Reminder otomatis, Statistik, Timer, Stopwatch |
| Sudah diuji | Android: alarm, Reminder otomatis, dan Statistik |
| Belum dilakukan | Pengujian di iPhone |

## Istilah

| Istilah | Arti |
|---|---|
| Expo | Alat untuk membuat dan menguji aplikasi mobile |
| Build | Hasil kemasan aplikasi yang siap dipasang di HP |
| Backend | Sisi server yang menyimpan akun dan data |
| Supabase | Layanan backend yang dipakai MathWake |
| Native | Kode yang berjalan langsung di sistem Android |
| Kotlin | Bahasa pemrograman untuk pengembangan Android |

## Tanya jawab

**Apakah perlu akun?**
Ya. Buat akun sendiri melalui halaman Register.

**Apakah bisa dipakai di iPhone?**
Belum diuji. Untuk saat ini gunakan Android.

**Bagaimana jika jawaban salah?**
Kesempatan menjawab dibatasi, sehingga jawaban tidak dapat ditebak terus-menerus.

## Pembuat dan lisensi

Dibuat oleh [Muhamad Haekal](https://github.com/Muhamad-Haekal).
Dilisensikan di bawah [MIT](LICENSE).
