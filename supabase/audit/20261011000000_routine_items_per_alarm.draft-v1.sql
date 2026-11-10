-- ============================================================================
-- STATUS: DRAFT — UNTUK REVIEW, BELUM DISETUJUI UNTUK DIJALANKAN.
-- JANGAN jalankan file ini ke database produksi sebelum persetujuan eksplisit.
--
-- Tujuan: rutinitas per alarm tanpa merusak data lama.
--   1. routine_items.alarm_id UUID NULL  -> NULL = item global lama,
--      terisi = item milik satu alarm. Tanpa default, tanpa backfill:
--      semua baris lama otomatis menjadi global.
--   2. routine_items.is_active BOOLEAN NOT NULL DEFAULT TRUE -> semua baris
--      lama otomatis aktif (perilaku hari ini), baris baru default aktif.
--
-- Yang TIDAK dilakukan file ini: menghapus/mengubah data lama, drop
-- tabel/kolom, menonaktifkan RLS, memberikan akses service-role ke app.
--
-- Urutan baca/eksekusi: LANGKAH 0 (read-only, wajib pertama) -> 1 -> 2 ->
-- 3 -> 4. Setiap langkah punya aturan BERHENTI bila output tak sesuai.
-- ============================================================================

-- ============================================================================
-- LANGKAH 0 — VERIFIKASI READ-ONLY (jalankan dan review output dulu)
-- BERHENTI bila: (a) jumlah baris routine_* = 0 padahal seharusnya ada data
-- (mungkin salah database/proyek); (b) FK completions->items beraksi CASCADE
-- (lihat kolom on_delete) -> strategi hapus di file ini tetap aman karena app
-- tidak pernah hard-delete item yang punya riwayat, TETAPI catat temuan ini
-- dan konfirmasi ulang sebelum lanjut.
-- ============================================================================

-- 0a. Blast radius: berapa baris yang disentuh DDL (DDL tidak mengubah isi,
-- hanya menambah kolom, tetapi angka ini wajib dicatat sebelum/sesudah).
SELECT (SELECT count(*) FROM public.routine_items) AS routine_items_rows,
       (SELECT count(*) FROM public.routine_completions) AS routine_completions_rows,
       (SELECT count(*) FROM public.alarms) AS alarms_rows;

-- 0b. FK aktual + aksi hapus/update-nya (tak terlihat dari API publik).
SELECT c.conname AS fk_name,
       tbl.relname AS from_table,
       col.attname AS from_column,
       ftbl.relname AS to_table,
       fcol.attname AS to_column,
       CASE c.confdeltype
         WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
         WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
         WHEN 'd' THEN 'SET DEFAULT' END AS on_delete,
       CASE c.confupdtype
         WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
         WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
         WHEN 'd' THEN 'SET DEFAULT' END AS on_update
FROM pg_constraint c
JOIN pg_class tbl ON tbl.oid = c.conrelid
JOIN pg_namespace sch ON sch.oid = tbl.relnamespace
JOIN pg_attribute col ON col.attrelid = c.conrelid AND col.attnum = ANY (c.conkey)
LEFT JOIN pg_class ftbl ON ftbl.oid = c.confrelid
LEFT JOIN pg_namespace fsch ON fsch.oid = ftbl.relnamespace
LEFT JOIN pg_attribute fcol ON fcol.attrelid = c.confrelid AND fcol.attnum = ANY (c.confkey)
WHERE c.contype = 'f'
  AND sch.nspname = 'public'
  AND tbl.relname IN ('routine_items', 'routine_completions', 'attempts', 'alarm_logs', 'alarms')
ORDER BY tbl.relname, col.attname;

-- 0c. Grants eksisting per tabel rutinitas.
SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('routine_items', 'routine_completions')
ORDER BY table_name, grantee, privilege_type;

-- 0d. Policies RLS eksisting per tabel rutinitas.
SELECT tablename, policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('routine_items', 'routine_completions')
ORDER BY tablename, policyname;

-- ============================================================================
-- LANGKAH 1 — KOLOM BARU (transaksional; tidak menyentuh isi baris lama)
-- Strategi FK: ON DELETE SET NULL (BUKAN cascade). Alasan: saat alarm
-- dihapus, itemnya menjadi global-nonaktif (app mengarsipkan dulu via
-- is_active=false sebelum delete alarm), sehingga TIDAK ADA baris
-- routine_completions yang kehilangan rujukan karena migrasi ini.
-- BERHENTI bila: statement gagal (mis. kolom sudah ada dengan tipe
-- berbeda -> selidiki dulu, jangan DROP).
-- ============================================================================
BEGIN;

ALTER TABLE public.routine_items
  ADD COLUMN IF NOT EXISTS alarm_id UUID
    REFERENCES public.alarms(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

COMMIT;

-- ============================================================================
-- LANGKAH 2 — INDEKS (mendukung filter per-alarm + urutan)
-- BERHENTI bila: gagal (tidak memengaruhi kebenaran, hanya performa).
-- Komposit (user_id, alarm_id) sengaja ditunda: RLS sudah memfilter user_id,
-- satu indeks alarm_id cukup untuk kebutuhan saat ini.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_routine_items_alarm_id
  ON public.routine_items(alarm_id);

-- ============================================================================
-- LANGKAH 3 — POLICY BERSYARAT (hanya dibuat bila belum ada yang setara)
-- Aturan: JANGAN buat policy baru sebelum memeriksa yang lama (lihat 0d).
-- Blok DO di bawah memeriksa pg_policies dulu dan membuat policy HANYA bila
-- belum ada policy cmd='ALL' di tabel tersebut. Policy lama tidak diubah,
-- tidak diketatkan, tidak dilonggarkan (policy Postgres bersifat OR).
-- Keputusan yang harus diambil saat review 0d SEBELUM menjalankan blok ini:
--   (a) Belum ada policy apa pun -> blok membuat owner-policy (intended).
--   (b) Ada policy SELECT-only -> blok menambahkan owner-policy ALL; efek
--       bersih: SELECT tetap, tulis owner dibuka (intended, tercatat).
--   (c) Sudah ada policy ALL -> blok dilewati total. WAJIB periksa kolom
--       with_check-nya: bila tidak membatasi alarm_id ke alarm milik
--       sendiri, JANGAN lanjutkan otomatis; eskalsi (pengetatan policy
--       eksisting di luar cakupan file ini).
--   (d) Ada policy LEBIH LONGGAR dari owner-only (mis. USING(true)/publik)
--       -> JANGAN jalankan; eskalsi audit akses dulu.
-- BERHENTI pada (c)-tanpa-batas-alarm dan (d).
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'routine_items'
      AND cmd = 'ALL'
  ) THEN
    CREATE POLICY routine_items_owner_all
      ON public.routine_items
      FOR ALL TO authenticated
      USING (auth.uid() = user_id)
      WITH CHECK (
        auth.uid() = user_id
        AND (
          alarm_id IS NULL OR EXISTS (
            SELECT 1 FROM public.alarms a
            WHERE a.id = alarm_id AND a.user_id = auth.uid()
          )
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'routine_completions'
      AND cmd = 'ALL'
  ) THEN
    CREATE POLICY routine_completions_owner_all
      ON public.routine_completions
      FOR ALL TO authenticated
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END
$$;

-- ============================================================================
-- LANGKAH 4 — VERIFIKASI PASCA (wajib; bandingkan dengan LANGKAH 0)
-- BERHENTI / ROLLBACK bila: jumlah baris berubah, atau kolom bertipe salah.
-- ============================================================================
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'routine_items'
  AND column_name IN ('alarm_id', 'is_active', 'id', 'user_id', 'label', 'sort_order', 'count')
ORDER BY column_name;

SELECT (SELECT count(*) FROM public.routine_items) AS routine_items_rows,
       (SELECT count(*) FROM public.routine_completions) AS routine_completions_rows,
       (SELECT count(*) FROM public.routine_items WHERE alarm_id IS NOT NULL) AS items_with_alarm,
       (SELECT count(*) FROM public.routine_items WHERE is_active IS DISTINCT FROM TRUE) AS items_not_active;

-- ============================================================================
-- ROLLBACK (berurutan; hanya sebelum tulis B3 masuk)
-- Kehilangan: assignment per-alarm yang dibuat SETELAH migrasi. Data lama
-- utuh karena migrasi tidak mengubah/menghapus isi baris lama.
-- ============================================================================
-- DROP POLICY IF EXISTS routine_items_owner_all ON public.routine_items;
-- DROP POLICY IF EXISTS routine_completions_owner_all ON public.routine_completions;
-- DROP INDEX IF EXISTS public.idx_routine_items_alarm_id;
-- ALTER TABLE public.routine_items
--   DROP COLUMN IF EXISTS alarm_id,
--   DROP COLUMN IF EXISTS is_active;
