  -- ============================================================================
  -- Verification + rollback companion for
  --   supabase/migrations/20261011000000_routine_items_per_alarm.sql
  -- NOT a migration. Never run this whole file at once.
  --   PART A  read-only, before apply.
  --   PART B  read-only, after apply.
  --   PART C  behaviour tests, NON-PRODUCTION database only. C0/C2 read-only
  --           checks; C1 is one DO block that always ends in an exception
  --           (statement is undone); C2 confirms nothing persisted.
  --   PART D  rollback, commented out AND guarded by v_confirm_rollback.
  --
  -- Object names used here are exactly the ones created by the migration:
  --   alarms_id_user_id_key, routine_items_id_user_id_key,
  --   routine_items_alarm_owner_fkey, routine_completions_item_owner_fkey,
  --   routine_items_user_alarm_sort_idx, routine_completions_item_user_idx,
  --   policy "own data" on alarms / routine_items / routine_completions,
  --   comment marker 'mathwake:20261011000000 replaced_fk=<old fk name>'.
  -- Catalog queries use pg_catalog (information_schema hides constraints whose
  -- referenced table, e.g. auth.users, is not owned by the current role).
  -- ============================================================================

  -- ============================================================================
  -- PART A: PRE-APPLY (read-only). STOP if any result differs from the audit.
  -- The migration re-checks all of this and aborts on mismatch; PART A exists
  -- so a mismatch is understood before anyone tries to apply.
  -- ============================================================================

  -- A1. Row counts. Record them; PART B1 must show the same numbers.
  SELECT (SELECT count(*) FROM public.alarms)              AS alarms_rows,
        (SELECT count(*) FROM public.routine_items)       AS routine_items_rows,
        (SELECT count(*) FROM public.routine_completions) AS routine_completions_rows;

  -- A2. Columns. Expect routine_items = {id, user_id, label, sort_order} and
  -- routine_completions = {id, user_id, routine_item_id, completed_date,
  -- completed_at}. No alarm_id / is_active / count. Expect uuid + not_null
  -- true for alarms.id, alarms.user_id, routine_items.id/user_id and
  -- routine_completions.user_id; routine_completions.routine_item_id uuid
  -- (nullable). Migration precondition 1c aborts otherwise.
  SELECT c.relname AS table_name, a.attnum, a.attname AS column_name,
        format_type(a.atttypid, a.atttypmod) AS data_type, a.attnotnull AS not_null,
        pg_get_expr(d.adbin, d.adrelid) AS column_default
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE c.oid IN ('public.alarms'::regclass, 'public.routine_items'::regclass,
                  'public.routine_completions'::regclass)
    AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY c.relname, a.attnum;

  -- A3a. user_id FKs, one row per FK (fk_name NULL = no FK on that column).
  -- Expect 3 rows: fk_columns user_id, referenced_table auth.users,
  -- referenced_columns id, on_delete NO ACTION, on_update NO ACTION,
  -- match_type SIMPLE, deferrable false, validated true.
  -- These NO ACTION FKs mean an auth.users row cannot be deleted while the
  -- user owns alarms / routine items / completions. The migration does not
  -- change this; account deletion remains an open, separate issue.
  WITH target_cols AS (
    SELECT a.attrelid, a.attnum, c.relname AS table_name, a.attname AS column_name,
          a.attnotnull AS column_not_null
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.oid IN ('public.alarms'::regclass, 'public.routine_items'::regclass,
                    'public.routine_completions'::regclass)
      AND a.attname = 'user_id' AND NOT a.attisdropped
  )
  SELECT t.table_name, t.column_name, t.column_not_null,
        f.conname AS fk_name,
        (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
            FROM unnest(f.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = f.conrelid AND a.attnum = k.attnum) AS fk_columns,
        f.confrelid::regclass::text AS referenced_table,
        (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
            FROM unnest(f.confkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = f.confrelid AND a.attnum = k.attnum) AS referenced_columns,
        CASE f.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                            WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_delete,
        CASE f.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                            WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_update,
        CASE f.confmatchtype WHEN 's' THEN 'SIMPLE' WHEN 'f' THEN 'FULL' WHEN 'p' THEN 'PARTIAL' END AS match_type,
        f.condeferrable AS deferrable,
        f.convalidated  AS validated
  FROM target_cols t
  LEFT JOIN pg_constraint f ON f.contype = 'f' AND f.conrelid = t.attrelid AND t.attnum = ANY (f.conkey)
  ORDER BY t.table_name, f.conname NULLS FIRST;

  -- A3b. Every FK from or to the target tables. Expect exactly:
  --   alarms.user_id, routine_items.user_id, routine_completions.user_id
  --     -> auth.users(id) (NO ACTION)
  --   routine_completions(routine_item_id) -> routine_items(id) ON DELETE CASCADE
  --   alarm_logs(alarm_id), attempts(alarm_id) -> alarms(id) ON DELETE SET NULL
  -- Any other row: STOP (the migration rejects unexpected FKs into these tables).
  SELECT c.conrelid::regclass::text  AS from_table,
        c.conname,
        c.confrelid::regclass::text AS to_table,
        pg_get_constraintdef(c.oid) AS definition,
        c.convalidated AS validated
  FROM pg_constraint c
  WHERE c.contype = 'f'
    AND (c.conrelid  IN ('public.alarms'::regclass, 'public.routine_items'::regclass, 'public.routine_completions'::regclass)
      OR c.confrelid IN ('public.alarms'::regclass, 'public.routine_items'::regclass, 'public.routine_completions'::regclass))
  ORDER BY from_table, c.conname;

  -- A4. Policies. Expect exactly one row per table: rls_enabled true,
  -- rls_forced false, "own data", PERMISSIVE, {public}, ALL,
  -- qual (auth.uid() = user_id), with_check NULL.
  SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS rls_forced,
        p.policyname, p.permissive, p.roles, p.cmd, p.qual, p.with_check
  FROM pg_class c
  LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = c.relname
  WHERE c.oid IN ('public.alarms'::regclass, 'public.routine_items'::regclass,
                  'public.routine_completions'::regclass)
  ORDER BY c.relname, p.policyname;

  -- A5. Triggers (expect 0 rows) and indexes (expect only the three PKs).
  SELECT tgrelid::regclass::text AS table_name, tgname
  FROM pg_trigger
  WHERE NOT tgisinternal
    AND tgrelid IN ('public.alarms'::regclass, 'public.routine_items'::regclass,
                    'public.routine_completions'::regclass);
  SELECT tablename, indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename IN ('alarms', 'routine_items', 'routine_completions')
  ORDER BY tablename, indexname;

  -- A6. Target names must be free (expect 0 rows).
  SELECT 'constraint' AS kind, conname::text AS name FROM pg_constraint
  WHERE connamespace = 'public'::regnamespace
    AND conname IN ('alarms_id_user_id_key', 'routine_items_id_user_id_key',
                    'routine_items_alarm_owner_fkey', 'routine_completions_item_owner_fkey')
  UNION ALL
  SELECT 'relation', relname::text FROM pg_class
  WHERE relnamespace = 'public'::regnamespace
    AND relname IN ('alarms_id_user_id_key', 'routine_items_id_user_id_key',
                    'routine_items_user_alarm_sort_idx', 'routine_completions_item_user_idx');

  -- A7. Data checks (expect 0 and 0).
  SELECT (SELECT count(*)
            FROM public.routine_completions rc
            JOIN public.routine_items ri ON ri.id = rc.routine_item_id
          WHERE ri.user_id <> rc.user_id) AS cross_user_completions,
        (SELECT count(*) FROM public.routine_completions WHERE routine_item_id IS NULL)
                                          AS completions_without_item;

  -- ============================================================================
  -- PART B: POST-APPLY (read-only). Every "ok" column must be true.
  -- ============================================================================

  -- B1. Counts equal A1; all existing items global + active.
  SELECT (SELECT count(*) FROM public.alarms)              AS alarms_rows,
        (SELECT count(*) FROM public.routine_items)       AS routine_items_rows,
        (SELECT count(*) FROM public.routine_completions) AS routine_completions_rows,
        (SELECT count(*) FROM public.routine_items WHERE alarm_id IS NOT NULL) AS items_with_alarm,
        (SELECT count(*) FROM public.routine_items WHERE NOT is_active)        AS items_archived;

  -- B2. Schema checklist (mirrors migration postconditions 7b-7f).
  WITH fk AS (
    SELECT c.conname::text AS name, c.conrelid, c.confrelid,
           c.confdeltype::text AS del, c.confupdtype::text AS upd, c.confmatchtype::text AS mt,
           c.condeferrable, c.condeferred, c.convalidated,
           (SELECT array_agg(a.attname::text ORDER BY u.ord)
              FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum) AS cols,
           (SELECT array_agg(a.attname::text ORDER BY u.ord)
              FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = u.attnum) AS refcols
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.conrelid IN ('public.alarms'::regclass, 'public.routine_items'::regclass,
                         'public.routine_completions'::regclass)
  ),
  idx AS (
    SELECT ic.relname::text AS name, i.indrelid, i.indisunique, i.indisprimary, i.indisvalid,
           i.indisready, i.indpred IS NULL AS no_pred, i.indexprs IS NULL AS no_expr, am.amname::text AS am,
           (SELECT array_agg(a.attname::text ORDER BY u.ord)
              FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS u(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum) AS cols
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_am am    ON am.oid = ic.relam
    WHERE i.indrelid IN ('public.alarms'::regclass, 'public.routine_items'::regclass,
                         'public.routine_completions'::regclass)
  ),
  strict_fk AS (
    SELECT * FROM fk
    WHERE mt = 's' AND NOT condeferrable AND NOT condeferred AND convalidated
  )
  SELECT check_name, ok FROM (VALUES
    ('routine_items columns exactly {alarm_id,id,is_active,label,sort_order,user_id}',
    (SELECT array_agg(attname::text ORDER BY attname::text COLLATE "C") FROM pg_attribute
      WHERE attrelid = 'public.routine_items'::regclass AND attnum > 0 AND NOT attisdropped)
      = ARRAY['alarm_id', 'id', 'is_active', 'label', 'sort_order', 'user_id']),
    ('column routine_items.alarm_id uuid NULL, no default',
    EXISTS (SELECT 1 FROM pg_attribute
            WHERE attrelid = 'public.routine_items'::regclass AND attname = 'alarm_id'
              AND atttypid = 'uuid'::regtype AND NOT attnotnull AND NOT atthasdef AND NOT attisdropped)),
    ('column routine_items.is_active boolean NOT NULL DEFAULT true',
    EXISTS (SELECT 1 FROM pg_attribute a
            JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = 'public.routine_items'::regclass AND a.attname = 'is_active'
              AND a.atttypid = 'boolean'::regtype AND a.attnotnull
              AND pg_get_expr(d.adbin, d.adrelid) = 'true')),
    ('unique alarms_id_user_id_key (id, user_id), not deferrable, valid index',
    EXISTS (SELECT 1 FROM pg_constraint c JOIN idx ON idx.name = c.conname::text AND idx.indrelid = c.conrelid
            WHERE c.conrelid = 'public.alarms'::regclass AND c.conname = 'alarms_id_user_id_key'
              AND c.contype = 'u' AND NOT c.condeferrable
              AND idx.indisunique AND idx.indisvalid AND idx.indisready AND idx.no_pred
              AND idx.cols = ARRAY['id', 'user_id'])),
    ('unique routine_items_id_user_id_key (id, user_id), not deferrable, valid index',
    EXISTS (SELECT 1 FROM pg_constraint c JOIN idx ON idx.name = c.conname::text AND idx.indrelid = c.conrelid
            WHERE c.conrelid = 'public.routine_items'::regclass AND c.conname = 'routine_items_id_user_id_key'
              AND c.contype = 'u' AND NOT c.condeferrable
              AND idx.indisunique AND idx.indisvalid AND idx.indisready AND idx.no_pred
              AND idx.cols = ARRAY['id', 'user_id'])),
    ('fk routine_items_alarm_owner_fkey (alarm_id,user_id)->alarms(id,user_id) NO ACTION/NO ACTION SIMPLE, not deferrable, validated',
    EXISTS (SELECT 1 FROM strict_fk
            WHERE name = 'routine_items_alarm_owner_fkey'
              AND conrelid = 'public.routine_items'::regclass AND confrelid = 'public.alarms'::regclass
              AND cols = ARRAY['alarm_id', 'user_id'] AND refcols = ARRAY['id', 'user_id']
              AND del = 'a' AND upd = 'a')),
    ('fk routine_completions_item_owner_fkey (routine_item_id,user_id)->routine_items(id,user_id) NO ACTION/NO ACTION SIMPLE, not deferrable, validated',
    EXISTS (SELECT 1 FROM strict_fk
            WHERE name = 'routine_completions_item_owner_fkey'
              AND conrelid = 'public.routine_completions'::regclass AND confrelid = 'public.routine_items'::regclass
              AND cols = ARRAY['routine_item_id', 'user_id'] AND refcols = ARRAY['id', 'user_id']
              AND del = 'a' AND upd = 'a')),
    ('old single-column FK (routine_item_id) -> routine_items gone',
    NOT EXISTS (SELECT 1 FROM fk
                WHERE conrelid = 'public.routine_completions'::regclass AND cols = ARRAY['routine_item_id'])),
    ('replaced-fk marker comment present',
    EXISTS (SELECT 1 FROM pg_constraint c
            JOIN pg_description d ON d.objoid = c.oid AND d.classoid = 'pg_constraint'::regclass
            WHERE c.conrelid = 'public.routine_completions'::regclass
              AND c.conname = 'routine_completions_item_owner_fkey'
              AND d.description LIKE 'mathwake:20261011000000 replaced_fk=_%')),
    ('user_id -> auth.users(id) NO ACTION/NO ACTION SIMPLE, not deferrable, validated on all 3 tables (account deletion still blocked)',
    (SELECT count(*) FROM strict_fk
      WHERE confrelid = 'auth.users'::regclass AND cols = ARRAY['user_id'] AND refcols = ARRAY['id']
        AND del = 'a' AND upd = 'a') = 3),
    ('FK inventory: routine_items 2, routine_completions 2',
    (SELECT count(*) FROM fk WHERE conrelid = 'public.routine_items'::regclass) = 2
    AND (SELECT count(*) FROM fk WHERE conrelid = 'public.routine_completions'::regclass) = 2),
    ('no CASCADE / SET NULL / SET DEFAULT between routine tables and alarms',
    NOT EXISTS (SELECT 1 FROM fk
                WHERE del IN ('c', 'n', 'd')
                  AND ((conrelid = 'public.routine_items'::regclass AND confrelid = 'public.alarms'::regclass)
                    OR (conrelid = 'public.routine_completions'::regclass AND confrelid = 'public.routine_items'::regclass)))),
    ('index routine_items_user_alarm_sort_idx btree (user_id, alarm_id, sort_order), valid',
    EXISTS (SELECT 1 FROM idx
            WHERE name = 'routine_items_user_alarm_sort_idx' AND indrelid = 'public.routine_items'::regclass
              AND am = 'btree' AND NOT indisunique AND indisvalid AND indisready AND no_pred AND no_expr
              AND cols = ARRAY['user_id', 'alarm_id', 'sort_order'])),
    ('index routine_completions_item_user_idx btree (routine_item_id, user_id), valid',
    EXISTS (SELECT 1 FROM idx
            WHERE name = 'routine_completions_item_user_idx' AND indrelid = 'public.routine_completions'::regclass
              AND am = 'btree' AND NOT indisunique AND indisvalid AND indisready AND no_pred AND no_expr
              AND cols = ARRAY['routine_item_id', 'user_id'])),
    ('index inventory: alarms 2, routine_items 3, routine_completions 2',
    (SELECT count(*) FROM idx WHERE indrelid = 'public.alarms'::regclass) = 2
    AND (SELECT count(*) FROM idx WHERE indrelid = 'public.routine_items'::regclass) = 3
    AND (SELECT count(*) FROM idx WHERE indrelid = 'public.routine_completions'::regclass) = 2),
    ('RLS enabled, FORCE RLS off on all three tables (unchanged)',
    (SELECT count(*) FROM pg_class
      WHERE oid IN ('public.alarms'::regclass, 'public.routine_items'::regclass,
                    'public.routine_completions'::regclass)
        AND relrowsecurity AND NOT relforcerowsecurity) = 3),
    ('exactly one policy per table, "own data", PERMISSIVE, ALL, {public}, USING = WITH CHECK = (auth.uid() = user_id)',
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('alarms', 'routine_items', 'routine_completions')) = 3
    AND (SELECT count(*) FROM pg_policies
          WHERE schemaname = 'public' AND tablename IN ('alarms', 'routine_items', 'routine_completions')
            AND policyname = 'own data' AND permissive = 'PERMISSIVE' AND cmd = 'ALL'
            AND roles = ARRAY['public']::name[]
            AND regexp_replace(qual, '[\s()]', '', 'g') = 'auth.uid=user_id'
            AND regexp_replace(with_check, '[\s()]', '', 'g') = 'auth.uid=user_id') = 3)
  ) AS checks(check_name, ok);

  -- ============================================================================
  -- PART C: BEHAVIOUR TESTS. LOCAL / STAGING / BRANCH DATABASE ONLY.
  --
  -- Prerequisites (manual):
  --   * Migration applied on THAT database; PART B all true.
  --   * Two dedicated, distinct test accounts in auth.users that own NO rows
  --     in alarms / routine_items / routine_completions (C1 refuses
  --     otherwise). Never use real user accounts.
  --   * Put the same two emails in C0/C2 and in v_email_a / v_email_b in C1.
  --   * Set v_confirm_non_production := true after confirming the target.
  --   * Run as the SQL editor default role (postgres). postgres is used only
  --     for the guards (auth.users lookup, ownership check). Every fixture and
  --     every test statement runs as role "authenticated" with
  --     request.jwt.claims for the acting test user; current_user and
  --     auth.uid() are asserted after every identity switch.
  --   * Order: C0 (read-only), then C1 ALONE ("Run selected" on the DO block
  --     only), then C2 (read-only).
  --
  -- Rollback mechanism:
  --   C1 is one DO statement and every path ends in RAISE EXCEPTION (pass,
  --   failed assertion, unexpected error). PostgreSQL undoes all effects of a
  --   failed statement: in autocommit or an implicit multi-statement batch
  --   the transaction is aborted; inside an explicit BEGIN the transaction is
  --   left aborted and COMMIT becomes ROLLBACK; with client per-statement
  --   savepoints (e.g. psql ON_ERROR_ROLLBACK) it is rolled back to the
  --   savepoint taken before the DO. A "BEGIN; DO ...; ROLLBACK;" wrapper
  --   adds nothing (after the error the ROLLBACK is skipped or redundant).
  --   This is PostgreSQL semantics, not proof for a given editor: rollback is
  --   only confirmed when C2, run AFTER C1, returns 2 / 0 / 0 / 0 / 0.
  --   No non-transactional side effects are expected (uuid keys; no triggers
  --   per migration precondition 1i).
  --
  -- How to read the result:
  --   PASS = C1's only error is "MW_TESTS_PASSED: 14/14" AND C2 after C1
  --   returns test_accounts_found 2 and 0 in every other column.
  --   Anything else (including any message starting with "MW_TEST_FAILED")
  --   = FAIL. Every expected rejection is matched on SQLSTATE plus the
  --   constraint name (23503) or the RLS message and table (42501); a
  --   rejection that does not happen, or a different error, fails the run.
  -- ============================================================================

  -- C0 / C2. Rows owned by the test accounts (read-only). Run before C1 and
  -- again after C1. Expect test_accounts_found = 2 and 0 everywhere else.
  WITH t AS (
    SELECT id FROM auth.users
    WHERE email IN ('REPLACE_ME_test_a@example.invalid', 'REPLACE_ME_test_b@example.invalid')
  )
  SELECT (SELECT count(*) FROM t) AS test_accounts_found,
        (SELECT count(*) FROM public.alarms WHERE user_id IN (SELECT id FROM t))              AS test_alarms,
        (SELECT count(*) FROM public.routine_items WHERE user_id IN (SELECT id FROM t))       AS test_routine_items,
        (SELECT count(*) FROM public.routine_completions WHERE user_id IN (SELECT id FROM t)) AS test_routine_completions,
        (SELECT count(*) FROM public.routine_items WHERE label LIKE 'mw-test %')             AS mw_test_labelled_items;

  -- C1. Behaviour tests.
  DO $tests$
  DECLARE
    v_email_a  constant text := 'REPLACE_ME_test_a@example.invalid';
    v_email_b  constant text := 'REPLACE_ME_test_b@example.invalid';
    v_confirm_non_production constant boolean := false;

    v_user_a   uuid;
    v_user_b   uuid;
    v_alarm_a  uuid := gen_random_uuid();
    v_alarm_a2 uuid := gen_random_uuid();
    v_alarm_b  uuid := gen_random_uuid();
    v_item_g   uuid := gen_random_uuid();
    v_item_a   uuid := gen_random_uuid();
    v_item_b   uuid := gen_random_uuid();
    v_rows     bigint;
    v_cons     text;
    v_msg      text;
    v_tbl      text;
    v_passed   integer := 0;
    v_total    constant integer := 14;
  BEGIN
    -- Guards (as postgres) --------------------------------------------------
    IF NOT v_confirm_non_production THEN
      RAISE EXCEPTION 'MW_TEST_FAILED: set v_confirm_non_production := true (non-production database only)';
    END IF;
    IF v_email_a LIKE 'REPLACE_ME%' OR v_email_b LIKE 'REPLACE_ME%' OR v_email_a = v_email_b THEN
      RAISE EXCEPTION 'MW_TEST_FAILED: set two distinct test account emails';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                   JOIN pg_description d ON d.objoid = c.oid AND d.classoid = 'pg_constraint'::regclass
                   WHERE c.conrelid = 'public.routine_completions'::regclass
                     AND c.conname = 'routine_completions_item_owner_fkey'
                     AND d.description LIKE 'mathwake:20261011000000 replaced_fk=_%') THEN
      RAISE EXCEPTION 'MW_TEST_FAILED: migration 20261011000000 is not applied on this database';
    END IF;

    SELECT count(*) INTO v_rows FROM auth.users WHERE email = v_email_a;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'MW_TEST_FAILED: test account A not found (or not unique)'; END IF;
    SELECT count(*) INTO v_rows FROM auth.users WHERE email = v_email_b;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'MW_TEST_FAILED: test account B not found (or not unique)'; END IF;
    SELECT id INTO v_user_a FROM auth.users WHERE email = v_email_a;
    SELECT id INTO v_user_b FROM auth.users WHERE email = v_email_b;
    IF v_user_a = v_user_b THEN RAISE EXCEPTION 'MW_TEST_FAILED: test accounts resolve to the same user'; END IF;

    SELECT (SELECT count(*) FROM public.alarms              WHERE user_id IN (v_user_a, v_user_b))
         + (SELECT count(*) FROM public.routine_items       WHERE user_id IN (v_user_a, v_user_b))
         + (SELECT count(*) FROM public.routine_completions WHERE user_id IN (v_user_a, v_user_b))
      INTO v_rows;
    IF v_rows <> 0 THEN
      RAISE EXCEPTION 'MW_TEST_FAILED: test accounts must own no rows (found %); use dedicated test accounts', v_rows;
    END IF;

    -- From here on everything runs as role authenticated --------------------
    SET LOCAL ROLE authenticated;

    -- Act as user B: create B's fixtures through RLS (no owner bypass).
    PERFORM set_config('request.jwt.claims',
                      json_build_object('sub', v_user_b, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_user_b::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    IF current_user <> 'authenticated' OR auth.uid() IS DISTINCT FROM v_user_b THEN
      RAISE EXCEPTION 'MW_TEST_FAILED: identity switch to B failed (current_user %, auth.uid %)', current_user, auth.uid();
    END IF;
    -- Same column set the app writes in createAlarm (src/lib/alarms.ts).
    INSERT INTO public.alarms (id, user_id, time, days, is_active, is_recurring, difficulty, question_count)
    VALUES (v_alarm_b, v_user_b, '06:00', '{}', true, false, 'mudah', 1);
    INSERT INTO public.routine_items (id, user_id, label, alarm_id)
    VALUES (v_item_b, v_user_b, 'mw-test b', v_alarm_b);

    -- Act as user A for fixtures and all tests.
    PERFORM set_config('request.jwt.claims',
                      json_build_object('sub', v_user_a, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    IF current_user <> 'authenticated' OR auth.uid() IS DISTINCT FROM v_user_a THEN
      RAISE EXCEPTION 'MW_TEST_FAILED: identity switch to A failed (current_user %, auth.uid %)', current_user, auth.uid();
    END IF;
    INSERT INTO public.alarms (id, user_id, time, days, is_active, is_recurring, difficulty, question_count)
    VALUES (v_alarm_a,  v_user_a, '06:00', '{}', true, false, 'mudah', 1),
           (v_alarm_a2, v_user_a, '07:00', '{}', true, false, 'mudah', 1);

    -- T01 OK: global item; defaults alarm_id NULL, is_active true.
    INSERT INTO public.routine_items (id, user_id, label) VALUES (v_item_g, v_user_a, 'mw-test global');
    SELECT count(*) INTO v_rows FROM public.routine_items
    WHERE id = v_item_g AND alarm_id IS NULL AND is_active;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'MW_TEST_FAILED: T01 global item defaults'; END IF;
    v_passed := v_passed + 1;

    -- T02 OK: item linked to own alarm.
    INSERT INTO public.routine_items (id, user_id, label, alarm_id) VALUES (v_item_a, v_user_a, 'mw-test a', v_alarm_a);
    SELECT count(*) INTO v_rows FROM public.routine_items WHERE id = v_item_a AND alarm_id = v_alarm_a;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'MW_TEST_FAILED: T02 per-alarm item not stored'; END IF;
    v_passed := v_passed + 1;

    -- T03 EXPECT 23503 routine_items_alarm_owner_fkey: INSERT linked to B's alarm.
    BEGIN
      INSERT INTO public.routine_items (user_id, label, alarm_id) VALUES (v_user_a, 'mw-test steal', v_alarm_b);
      RAISE EXCEPTION 'MW_TEST_FAILED: T03 cross-user alarm link was accepted';
    EXCEPTION WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS v_cons = CONSTRAINT_NAME;
      IF v_cons IS DISTINCT FROM 'routine_items_alarm_owner_fkey' THEN
        RAISE EXCEPTION 'MW_TEST_FAILED: T03 wrong constraint %', v_cons;
      END IF;
    END;
    v_passed := v_passed + 1;

    -- T04 EXPECT 23503 routine_items_alarm_owner_fkey: UPDATE own item to B's alarm.
    BEGIN
      UPDATE public.routine_items SET alarm_id = v_alarm_b WHERE id = v_item_g;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      RAISE EXCEPTION 'MW_TEST_FAILED: T04 cross-user alarm re-link was not rejected (% rows updated)', v_rows;
    EXCEPTION WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS v_cons = CONSTRAINT_NAME;
      IF v_cons IS DISTINCT FROM 'routine_items_alarm_owner_fkey' THEN
        RAISE EXCEPTION 'MW_TEST_FAILED: T04 wrong constraint %', v_cons;
      END IF;
    END;
    v_passed := v_passed + 1;

    -- T05 EXPECT 42501 RLS WITH CHECK: INSERT row owned by B.
    BEGIN
      INSERT INTO public.routine_items (user_id, label) VALUES (v_user_b, 'mw-test foreign owner');
      RAISE EXCEPTION 'MW_TEST_FAILED: T05 insert for another user was accepted';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_tbl = TABLE_NAME;
      IF v_msg NOT LIKE '%row-level security policy%' OR v_msg NOT LIKE '%routine_items%' THEN
        RAISE EXCEPTION 'MW_TEST_FAILED: T05 unexpected 42501 (table %): %', v_tbl, v_msg;
      END IF;
    END;
    v_passed := v_passed + 1;

    -- T06 EXPECT 42501 RLS WITH CHECK: UPDATE own item's user_id to B.
    BEGIN
      UPDATE public.routine_items SET user_id = v_user_b WHERE id = v_item_g;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      RAISE EXCEPTION 'MW_TEST_FAILED: T06 ownership transfer was not rejected (% rows updated)', v_rows;
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_tbl = TABLE_NAME;
      IF v_msg NOT LIKE '%row-level security policy%' OR v_msg NOT LIKE '%routine_items%' THEN
        RAISE EXCEPTION 'MW_TEST_FAILED: T06 unexpected 42501 (table %): %', v_tbl, v_msg;
      END IF;
    END;
    v_passed := v_passed + 1;

    -- T07 RLS USING: A cannot read, update or delete B's item; B's item is
    -- still intact when checked as B.
    SELECT count(*) INTO v_rows FROM public.routine_items WHERE id = v_item_b;
    IF v_rows <> 0 THEN RAISE EXCEPTION 'MW_TEST_FAILED: T07 user A can read user B item'; END IF;
    UPDATE public.routine_items SET label = 'mw-test hijack' WHERE id = v_item_b;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN RAISE EXCEPTION 'MW_TEST_FAILED: T07 user A updated user B item'; END IF;
    DELETE FROM public.routine_items WHERE id = v_item_b;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN RAISE EXCEPTION 'MW_TEST_FAILED: T07 user A deleted user B item'; END IF;

    PERFORM set_config('request.jwt.claims',
                      json_build_object('sub', v_user_b, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_user_b::text, true);
    IF current_user <> 'authenticated' OR auth.uid() IS DISTINCT FROM v_user_b THEN
      RAISE EXCEPTION 'MW_TEST_FAILED: T07 identity switch to B failed';
    END IF;
    SELECT count(*) INTO v_rows FROM public.routine_items
    WHERE id = v_item_b AND label = 'mw-test b' AND alarm_id = v_alarm_b;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'MW_TEST_FAILED: T07 user B item changed or missing'; END IF;

    PERFORM set_config('request.jwt.claims',
                      json_build_object('sub', v_user_a, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
    IF current_user <> 'authenticated' OR auth.uid() IS DISTINCT FROM v_user_a THEN
      RAISE EXCEPTION 'MW_TEST_FAILED: T07 identity switch back to A failed';
    END IF;
    v_passed := v_passed + 1;

    -- T08 OK: completion on own item.
    INSERT INTO public.routine_completions (user_id, routine_item_id) VALUES (v_user_a, v_item_a);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'MW_TEST_FAILED: T08 completion not inserted'; END IF;
    v_passed := v_passed + 1;

    -- T09 EXPECT 23503 routine_completions_item_owner_fkey: completion on B's item.
    BEGIN
      INSERT INTO public.routine_completions (user_id, routine_item_id) VALUES (v_user_a, v_item_b);
      RAISE EXCEPTION 'MW_TEST_FAILED: T09 completion on another user''s item was accepted';
    EXCEPTION WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS v_cons = CONSTRAINT_NAME;
      IF v_cons IS DISTINCT FROM 'routine_completions_item_owner_fkey' THEN
        RAISE EXCEPTION 'MW_TEST_FAILED: T09 wrong constraint %', v_cons;
      END IF;
    END;
    v_passed := v_passed + 1;

    -- T10 EXPECT 23503 routine_items_alarm_owner_fkey: delete alarm that has items.
    BEGIN
      DELETE FROM public.alarms WHERE id = v_alarm_a;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      RAISE EXCEPTION 'MW_TEST_FAILED: T10 alarm delete was not rejected (% rows deleted)', v_rows;
    EXCEPTION WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS v_cons = CONSTRAINT_NAME;
      IF v_cons IS DISTINCT FROM 'routine_items_alarm_owner_fkey' THEN
        RAISE EXCEPTION 'MW_TEST_FAILED: T10 wrong constraint %', v_cons;
      END IF;
    END;
    SELECT count(*) INTO v_rows FROM public.routine_items WHERE id = v_item_a AND alarm_id = v_alarm_a;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'MW_TEST_FAILED: T10 item lost its alarm link'; END IF;
    v_passed := v_passed + 1;

    -- T11 EXPECT 23503 routine_completions_item_owner_fkey: delete item with history.
    BEGIN
      DELETE FROM public.routine_items WHERE id = v_item_a;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      RAISE EXCEPTION 'MW_TEST_FAILED: T11 item delete was not rejected (% rows deleted)', v_rows;
    EXCEPTION WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS v_cons = CONSTRAINT_NAME;
      IF v_cons IS DISTINCT FROM 'routine_completions_item_owner_fkey' THEN
        RAISE EXCEPTION 'MW_TEST_FAILED: T11 wrong constraint %', v_cons;
      END IF;
    END;
    SELECT count(*) INTO v_rows FROM public.routine_completions WHERE routine_item_id = v_item_a;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'MW_TEST_FAILED: T11 completion history changed'; END IF;
    v_passed := v_passed + 1;

    -- T12 OK: archive item, deactivate alarm; link and history remain.
    UPDATE public.routine_items SET is_active = false WHERE id = v_item_a;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'MW_TEST_FAILED: T12 archived % items, expected 1', v_rows; END IF;
    UPDATE public.alarms SET is_active = false WHERE id = v_alarm_a;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'MW_TEST_FAILED: T12 deactivated % alarms, expected 1', v_rows; END IF;
    SELECT count(*) INTO v_rows FROM public.routine_items
    WHERE id = v_item_a AND alarm_id = v_alarm_a AND NOT is_active;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'MW_TEST_FAILED: T12 archive/deactivate changed the link'; END IF;
    SELECT count(*) INTO v_rows FROM public.routine_completions WHERE routine_item_id = v_item_a;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'MW_TEST_FAILED: T12 completion history changed'; END IF;
    v_passed := v_passed + 1;

    -- T13 OK: alarm without items deletes (current app deleteAlarm path).
    DELETE FROM public.alarms WHERE id = v_alarm_a2;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'MW_TEST_FAILED: T13 deleted % alarms, expected 1', v_rows; END IF;
    v_passed := v_passed + 1;

    -- T14 OK: item without completions deletes.
    DELETE FROM public.routine_items WHERE id = v_item_g;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'MW_TEST_FAILED: T14 deleted % items, expected 1', v_rows; END IF;
    v_passed := v_passed + 1;

    RESET ROLE;

    IF v_passed <> v_total THEN
      RAISE EXCEPTION 'MW_TEST_FAILED: only %/% tests ran', v_passed, v_total;
    END IF;

    -- Always abort: the failed statement undoes every fixture and test write.
    -- Confirm with C2.
    RAISE EXCEPTION 'MW_TESTS_PASSED: %/%', v_passed, v_total;
  END
  $tests$;

  -- C2. Re-run the C0 query above AFTER C1. Expect 2 / 0 / 0 / 0 / 0.
  -- Any non-zero count means C1's writes persisted: STOP and investigate.

  -- ============================================================================
  -- PART D: ROLLBACK (schema only). NEVER part of a normal run.
  -- Two independent safety catches, both must be released on purpose:
  --   1. every line is commented out (running the file or a selection that
  --      includes it executes nothing);
  --   2. after uncommenting, v_confirm_rollback must be set to true, otherwise
  --      the block raises before touching anything.
  -- One DO statement: all-or-nothing. Do not run Part D in production
  -- without a separate review; it also restores ON DELETE CASCADE.
  --
  -- Safety rules:
  --   * Refuses while any routine item is linked to an alarm or archived:
  --     dropping alarm_id / is_active would silently turn per-alarm items into
  --     global ones and resurrect archived items. Those rows need an explicit
  --     product decision first; this script does not decide for you.
  --   * Restores the old CASCADE FK only if the marker comment proves this
  --     migration replaced it, its original name is free, and every completion
  --     still references an existing item. The old FK is added (and validated)
  --     BEFORE the new one is dropped, so there is no window without an FK.
  --   * Restoring CASCADE re-enables "delete item = delete its history". That
  --     is the pre-migration behaviour; rolling back accepts it explicitly.
  --   * No row is deleted or updated. Rows created after the migration stay;
  --     only the two new columns (which then hold only default values) go.
  --   * The explicit WITH CHECK on "own data" is left in place: for an ALL
  --     policy it is equivalent to the original NULL WITH CHECK, and
  --     reverting it would need DROP/CREATE POLICY. Documented, not reverted.
  -- ============================================================================
  -- DO $rollback$
  -- DECLARE
  --   v_confirm_rollback constant boolean := false;
  --   v_marker text;
  --   v_old_fk text;
  --   v_count  bigint;
  -- BEGIN
  --   IF NOT v_confirm_rollback THEN
  --     RAISE EXCEPTION 'rollback refused: set v_confirm_rollback := true deliberately';
  --   END IF;
  --   PERFORM set_config('lock_timeout', '5s', true);
  --   LOCK TABLE public.alarms, public.routine_items, public.routine_completions
  --     IN ACCESS EXCLUSIVE MODE;
  --
  --   SELECT d.description INTO v_marker
  --   FROM pg_constraint c JOIN pg_description d ON d.objoid = c.oid AND d.classoid = 'pg_constraint'::regclass
  --   WHERE c.conrelid = 'public.routine_completions'::regclass
  --     AND c.conname = 'routine_completions_item_owner_fkey';
  --   IF v_marker IS NULL OR v_marker NOT LIKE 'mathwake:20261011000000 replaced_fk=%' THEN
  --     RAISE EXCEPTION 'rollback refused: migration marker not found on routine_completions_item_owner_fkey';
  --   END IF;
  --   v_old_fk := substr(v_marker, length('mathwake:20261011000000 replaced_fk=') + 1);
  --   IF v_old_fk = '' OR EXISTS (SELECT 1 FROM pg_constraint
  --                               WHERE connamespace = 'public'::regnamespace AND conname = v_old_fk) THEN
  --     RAISE EXCEPTION 'rollback refused: original FK name "%" missing or already in use', v_old_fk;
  --   END IF;
  --
  --   SELECT count(*) INTO v_count FROM public.routine_items
  --   WHERE alarm_id IS NOT NULL OR NOT is_active;
  --   IF v_count > 0 THEN
  --     RAISE EXCEPTION 'rollback refused: % routine items are per-alarm or archived; resolve explicitly first', v_count;
  --   END IF;
  --
  --   SELECT count(*) INTO v_count
  --   FROM public.routine_completions rc
  --   WHERE rc.routine_item_id IS NOT NULL
  --     AND NOT EXISTS (SELECT 1 FROM public.routine_items ri WHERE ri.id = rc.routine_item_id);
  --   IF v_count > 0 THEN
  --     RAISE EXCEPTION 'rollback refused: % completions reference missing items', v_count;
  --   END IF;
  --
  --   EXECUTE format(
  --     'ALTER TABLE public.routine_completions ADD CONSTRAINT %I
  --        FOREIGN KEY (routine_item_id) REFERENCES public.routine_items (id) ON DELETE CASCADE',
  --     v_old_fk);
  --   ALTER TABLE public.routine_completions DROP CONSTRAINT routine_completions_item_owner_fkey;
  --   ALTER TABLE public.routine_items       DROP CONSTRAINT routine_items_alarm_owner_fkey;
  --   DROP INDEX public.routine_completions_item_user_idx;
  --   DROP INDEX public.routine_items_user_alarm_sort_idx;
  --   ALTER TABLE public.routine_items DROP CONSTRAINT routine_items_id_user_id_key;
  --   ALTER TABLE public.alarms        DROP CONSTRAINT alarms_id_user_id_key;
  --   ALTER TABLE public.routine_items DROP COLUMN alarm_id, DROP COLUMN is_active;
  --
  --   RAISE NOTICE 'rollback of 20261011000000 done; restored FK %', v_old_fk;
  -- END
  -- $rollback$;
