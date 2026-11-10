-- ============================================================================
-- MathWake 20261011000000: routine items per alarm
-- STATUS: REVIEWED DRAFT. NOT APPROVED FOR EXECUTION.
-- Before applying: run PART A of
--   supabase/audit/20261011000000_routine_items_per_alarm.verify.sql
-- After applying: run PART B (and PART C on a non-production database only).
--
-- Object names (must match the verify file):
--   columns      routine_items.alarm_id  uuid NULL, no default
--                routine_items.is_active boolean NOT NULL DEFAULT true
--   unique       alarms_id_user_id_key            alarms (id, user_id)
--   unique       routine_items_id_user_id_key     routine_items (id, user_id)
--   fk           routine_items_alarm_owner_fkey
--                  routine_items (alarm_id, user_id) -> alarms (id, user_id)
--   fk           routine_completions_item_owner_fkey
--                  routine_completions (routine_item_id, user_id)
--                  -> routine_items (id, user_id)
--                both: ON UPDATE NO ACTION, ON DELETE NO ACTION, MATCH SIMPLE,
--                NOT DEFERRABLE, validated
--   dropped fk   the single existing FK routine_completions (routine_item_id)
--                  -> routine_items (id) ON DELETE CASCADE (name read from the
--                  catalog, recorded in the comment on the new FK)
--   index        routine_items_user_alarm_sort_idx
--                  btree routine_items (user_id, alarm_id, sort_order)
--   index        routine_completions_item_user_idx
--                  btree routine_completions (routine_item_id, user_id)
--   policy       "own data" on alarms, routine_items, routine_completions:
--                  PERMISSIVE, {public}, ALL,
--                  USING and WITH CHECK (auth.uid() = user_id)
--   comment      on routine_completions_item_owner_fkey:
--                  'mathwake:20261011000000 replaced_fk=<old fk name>'
--
-- Design:
--   * Routine items can belong to one alarm (alarm_id). Existing rows have no
--     alarm and stay global (alarm_id NULL) and active (is_active TRUE via
--     the column default). No backfill, no deletes, no row updates.
--   * Same-owner linking is enforced by composite FKs. A single-column FK
--     would not be enough: FK checks bypass RLS, so a user could reference
--     another user's alarm/item. The composite FK requires the referenced
--     row to have the same user_id, and RLS WITH CHECK pins user_id to
--     auth.uid(). MATCH SIMPLE: a NULL alarm_id (global item) or NULL
--     routine_item_id is not checked; user_id is uuid NOT NULL on alarms,
--     routine_items and routine_completions (precondition 1c), so a non-NULL
--     alarm_id / routine_item_id is always checked.
--   * Deleting an alarm that still has routine items fails (23503).
--     Deleting a routine item that has completions fails (23503); archive it
--     with is_active = false. No CASCADE / SET NULL on either relation.
--   * Deactivating an alarm (alarms.is_active = false) does not touch items.
--   * RLS stays enabled. The existing "own data" policies are altered in
--     place to an explicit WITH CHECK identical to USING. For an ALL policy
--     with NULL WITH CHECK, PostgreSQL already applies USING to new rows, so
--     the effective rule is unchanged; it is now explicit and verifiable.
--     No policy is added. Roles stay {public} (out of scope).
--
-- ACCOUNT DELETION IS NOT SOLVED BY THIS MIGRATION.
--   alarms.user_id, routine_items.user_id and routine_completions.user_id
--   reference auth.users(id) ON DELETE NO ACTION (audited; precondition 1h
--   aborts if that differs; not changed here). Consequences:
--   * Already today: deleting an auth.users row (dashboard, admin API) fails
--     with 23503 while that user owns any alarm, routine item or completion.
--   * Added by this migration: user data can only be removed bottom-up
--     (routine_completions, then routine_items, then alarms); deleting
--     completions deliberately destroys history, which is a product/privacy
--     decision that is NOT made here.
--   * Changing the auth.users FKs to CASCADE would interact with the new
--     NO ACTION FKs and needs its own analysis and tests. Whether a cascade
--     from auth.users succeeds through routine_items_alarm_owner_fkey and
--     routine_completions_item_owner_fkey depends on the firing order of
--     the cascaded RI triggers; it is NOT assumed to work.
--   * Open decision (product/privacy): on account deletion, keep, anonymise
--     or delete alarms, routine items and completion history.
--
-- Atomicity and locking:
--   * Everything is one DO statement, so it commits or fails as a whole in
--     any runner (single implicit transaction; any RAISE rolls back all DDL).
--   * lock_timeout is 5s for every lock wait in this statement; if any lock
--     cannot be acquired in time the migration aborts with no changes.
--   * BLOCKING OPERATIONS (concurrent traffic waits until commit):
--       - LOCK TABLE alarms, routine_items, routine_completions IN ACCESS
--         EXCLUSIVE MODE: blocks ALL reads and writes on these three tables,
--         and inserts/updates of alarm_logs.alarm_id / attempts.alarm_id
--         (their FK checks need a key-share lock on alarms rows).
--       - ADD CONSTRAINT ... UNIQUE: builds an index (scans the table).
--       - ADD CONSTRAINT ... FOREIGN KEY: validates by scanning the table.
--       - CREATE INDEX (not CONCURRENTLY; CONCURRENTLY is impossible inside
--         a transaction): scans the table.
--     With the audited row counts (0) these are near-instant, but the locks
--     are held until commit. Run in a low-traffic window.
--   * No statement_timeout is set: setting it inside a running statement
--     does not limit that statement. Set it in the session beforehand if a
--     hard cap is wanted.
--   * The new completions FK is created and validated BEFORE the old CASCADE
--     FK is dropped; both happen in the same transaction under the lock.
-- ============================================================================

DO $migration$
DECLARE
  v_table          text;
  v_old_fk         name;
  v_count          bigint;
  v_any            bigint;
  v_exact          bigint;
  v_cols           text[];
  v_pol            record;
  v_spec           record;
  v_rows_alarms    bigint;
  v_rows_items     bigint;
  v_rows_compl     bigint;

  -- Counts FKs on table $1 whose ordered column list is $3 (v_any), and
  -- those that additionally reference $2 ($4 ordered columns) with delete
  -- action $5, update action $6, MATCH SIMPLE, NOT DEFERRABLE, validated,
  -- and (when $7 is not NULL) are named $7 (v_exact).
  c_fk_check CONSTANT text := $sql$
    SELECT count(*) FILTER (WHERE k.cols = $3),
           count(*) FILTER (WHERE k.cols = $3
                              AND c.confrelid = $2
                              AND k.refcols = $4
                              AND c.confdeltype::text = $5
                              AND c.confupdtype::text = $6
                              AND c.confmatchtype::text = 's'
                              AND NOT c.condeferrable
                              AND NOT c.condeferred
                              AND c.convalidated
                              AND ($7::text IS NULL OR c.conname::text = $7))
    FROM pg_constraint c
    CROSS JOIN LATERAL (
      SELECT (SELECT array_agg(a.attname::text ORDER BY u.ord)
                FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum) AS cols,
             (SELECT array_agg(a.attname::text ORDER BY u.ord)
                FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = u.attnum) AS refcols
    ) AS k
    WHERE c.contype = 'f' AND c.conrelid = $1
  $sql$;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regclass('public.alarms') IS NULL
     OR to_regclass('public.routine_items') IS NULL
     OR to_regclass('public.routine_completions') IS NULL
     OR to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'precondition: public.alarms / routine_items / routine_completions and auth.users must exist';
  END IF;

  LOCK TABLE public.alarms, public.routine_items, public.routine_completions
    IN ACCESS EXCLUSIVE MODE;

  SELECT count(*) INTO v_rows_alarms FROM public.alarms;
  SELECT count(*) INTO v_rows_items  FROM public.routine_items;
  SELECT count(*) INTO v_rows_compl  FROM public.routine_completions;

  -- --------------------------------------------------------------------------
  -- 1. Preconditions: stop on any difference from the audited schema/data.
  -- --------------------------------------------------------------------------

  -- 1a. Ordinary tables, RLS enabled, FORCE RLS off (audited).
  FOREACH v_table IN ARRAY ARRAY['alarms', 'routine_items', 'routine_completions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class
                   WHERE oid = ('public.' || v_table)::regclass
                     AND relkind = 'r' AND relrowsecurity AND NOT relforcerowsecurity) THEN
      RAISE EXCEPTION 'precondition: public.% must be a table with RLS enabled and FORCE RLS off', v_table;
    END IF;
  END LOOP;

  -- 1b. Exact column sets of the routine tables (no alarm_id/is_active/count).
  SELECT array_agg(attname::text ORDER BY attname::text COLLATE "C") INTO v_cols
  FROM pg_attribute
  WHERE attrelid = 'public.routine_items'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM ARRAY['id', 'label', 'sort_order', 'user_id'] THEN
    RAISE EXCEPTION 'precondition: routine_items columns are %, expected {id,label,sort_order,user_id}', v_cols;
  END IF;

  SELECT array_agg(attname::text ORDER BY attname::text COLLATE "C") INTO v_cols
  FROM pg_attribute
  WHERE attrelid = 'public.routine_completions'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM ARRAY['completed_at', 'completed_date', 'id', 'routine_item_id', 'user_id'] THEN
    RAISE EXCEPTION 'precondition: routine_completions columns are %, expected {completed_at,completed_date,id,routine_item_id,user_id}', v_cols;
  END IF;

  -- 1c. Key columns, checked one by one: type uuid, and NOT NULL where the
  --     design requires it. user_id NOT NULL on all three tables: every
  --     alarm/item/completion has an owner, so the (id, user_id) keys are
  --     total and the MATCH SIMPLE composite FKs are always checked.
  --     routine_completions.routine_item_id stays nullable (audited).
  FOR v_spec IN
    SELECT * FROM (VALUES
      ('public.alarms',              'id',              true),
      ('public.alarms',              'user_id',         true),
      ('public.routine_items',       'id',              true),
      ('public.routine_items',       'user_id',         true),
      ('public.routine_completions', 'routine_item_id', false),
      ('public.routine_completions', 'user_id',         true)
    ) AS s(tbl, col, must_be_not_null)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                   WHERE attrelid = v_spec.tbl::regclass
                     AND attname = v_spec.col
                     AND attnum > 0 AND NOT attisdropped
                     AND atttypid = 'uuid'::regtype
                     AND (attnotnull OR NOT v_spec.must_be_not_null)) THEN
      RAISE EXCEPTION 'precondition: %.% must be uuid%', v_spec.tbl, v_spec.col,
        CASE WHEN v_spec.must_be_not_null THEN ' NOT NULL' ELSE '' END;
    END IF;
  END LOOP;

  -- 1d. Primary key exactly (id) on all three tables.
  FOREACH v_table IN ARRAY ARRAY['alarms', 'routine_items', 'routine_completions'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = ('public.' || v_table)::regclass AND contype = 'p'
        AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                            WHERE attrelid = ('public.' || v_table)::regclass AND attname = 'id')]
    ) THEN
      RAISE EXCEPTION 'precondition: public.% has no PRIMARY KEY (id)', v_table;
    END IF;
  END LOOP;

  -- 1e. Indexes: only the primary-key index on each table (audited).
  SELECT count(*) INTO v_count
  FROM pg_index i
  WHERE i.indrelid IN ('public.alarms'::regclass, 'public.routine_items'::regclass,
                       'public.routine_completions'::regclass)
    AND NOT i.indisprimary;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'precondition: % non-primary-key index(es) exist on target tables; audit expected none', v_count;
  END IF;

  -- 1f. Target object names are free.
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE connamespace = 'public'::regnamespace
               AND conname IN ('alarms_id_user_id_key', 'routine_items_id_user_id_key',
                               'routine_items_alarm_owner_fkey', 'routine_completions_item_owner_fkey'))
     OR to_regclass('public.alarms_id_user_id_key') IS NOT NULL
     OR to_regclass('public.routine_items_id_user_id_key') IS NOT NULL
     OR to_regclass('public.routine_items_user_alarm_sort_idx') IS NOT NULL
     OR to_regclass('public.routine_completions_item_user_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition: a target constraint or index name is already in use';
  END IF;

  -- 1g. FK inventory of the routine tables: routine_items has exactly 1 FK
  --     (user_id), routine_completions exactly 2 (user_id, routine_item_id).
  --     Nothing else references routine_items/routine_completions; FKs into
  --     alarms come only from alarm_logs / attempts.
  IF (SELECT count(*) FROM pg_constraint
      WHERE contype = 'f' AND conrelid = 'public.routine_items'::regclass) <> 1
     OR (SELECT count(*) FROM pg_constraint
         WHERE contype = 'f' AND conrelid = 'public.routine_completions'::regclass) <> 2 THEN
    RAISE EXCEPTION 'precondition: unexpected FK count on routine_items (expected 1) / routine_completions (expected 2)';
  END IF;

  SELECT min(conname::text) INTO v_old_fk
  FROM pg_constraint
  WHERE contype = 'f'
    AND conrelid  = 'public.routine_completions'::regclass
    AND confrelid = 'public.routine_items'::regclass;
  IF v_old_fk IS NULL
     OR (SELECT count(*) FROM pg_constraint
         WHERE contype = 'f' AND confrelid IN ('public.routine_items'::regclass,
                                               'public.routine_completions'::regclass)) <> 1 THEN
    RAISE EXCEPTION 'precondition: expected exactly one FK referencing routine_items/routine_completions (routine_completions -> routine_items)';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint c
             WHERE c.contype = 'f' AND c.confrelid = 'public.alarms'::regclass
               AND c.conrelid NOT IN (SELECT oid FROM pg_class
                                      WHERE relnamespace = 'public'::regnamespace
                                        AND relname IN ('alarm_logs', 'attempts'))) THEN
    RAISE EXCEPTION 'precondition: unexpected FK referencing alarms';
  END IF;

  -- 1h. Exact definitions of the FKs this migration depends on:
  --     old FK: (routine_item_id) -> routine_items(id) CASCADE / NO ACTION;
  --     user_id FKs: (user_id) -> auth.users(id) NO ACTION / NO ACTION.
  --     All MATCH SIMPLE, NOT DEFERRABLE, validated. The auth.users FKs are
  --     not changed; they are checked so the account-deletion notes hold.
  FOR v_spec IN
    SELECT * FROM (VALUES
      ('public.routine_completions', 'public.routine_items', ARRAY['routine_item_id'], ARRAY['id'], 'c', 'a', v_old_fk::text),
      ('public.alarms',              'auth.users',           ARRAY['user_id'],         ARRAY['id'], 'a', 'a', NULL),
      ('public.routine_items',       'auth.users',           ARRAY['user_id'],         ARRAY['id'], 'a', 'a', NULL),
      ('public.routine_completions', 'auth.users',           ARRAY['user_id'],         ARRAY['id'], 'a', 'a', NULL)
    ) AS s(from_tbl, to_tbl, cols, refcols, del_action, upd_action, fk_name)
  LOOP
    EXECUTE c_fk_check INTO v_any, v_exact
      USING v_spec.from_tbl::regclass, v_spec.to_tbl::regclass, v_spec.cols, v_spec.refcols,
            v_spec.del_action, v_spec.upd_action, v_spec.fk_name;
    IF v_any <> 1 OR v_exact <> 1 THEN
      RAISE EXCEPTION 'precondition: FK %(%) -> %(%) must exist exactly once with ON DELETE %, ON UPDATE %, MATCH SIMPLE, NOT DEFERRABLE, validated (found % on these columns, % exact)',
        v_spec.from_tbl, v_spec.cols, v_spec.to_tbl, v_spec.refcols, v_spec.del_action, v_spec.upd_action, v_any, v_exact;
    END IF;
  END LOOP;

  -- 1i. No user triggers on the target tables.
  IF EXISTS (SELECT 1 FROM pg_trigger
             WHERE NOT tgisinternal
               AND tgrelid IN ('public.alarms'::regclass, 'public.routine_items'::regclass,
                               'public.routine_completions'::regclass)) THEN
    RAISE EXCEPTION 'precondition: unexpected trigger on target tables';
  END IF;

  -- 1j. Exactly one policy per table: "own data", PERMISSIVE, {public}, ALL,
  --     USING (auth.uid() = user_id), WITH CHECK NULL.
  FOREACH v_table IN ARRAY ARRAY['alarms', 'routine_items', 'routine_completions'] LOOP
    SELECT count(*) INTO v_count FROM pg_policies
    WHERE schemaname = 'public' AND tablename = v_table;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'precondition: public.% must have exactly one policy, found %', v_table, v_count;
    END IF;
    SELECT * INTO v_pol FROM pg_policies WHERE schemaname = 'public' AND tablename = v_table;
    IF v_pol.policyname <> 'own data'
       OR v_pol.permissive <> 'PERMISSIVE'
       OR v_pol.roles <> ARRAY['public']::name[]
       OR v_pol.cmd <> 'ALL'
       OR regexp_replace(coalesce(v_pol.qual, ''), '[\s()]', '', 'g') <> 'auth.uid=user_id'
       OR v_pol.with_check IS NOT NULL THEN
      RAISE EXCEPTION 'precondition: policy on public.% differs from audited "own data" (name %, cmd %, roles %, qual %, with_check %)',
        v_table, v_pol.policyname, v_pol.cmd, v_pol.roles, v_pol.qual, v_pol.with_check;
    END IF;
  END LOOP;

  -- 1k. Data: no completion references another user's item (would also make
  --     the new FK fail validation; checked first for a clear message).
  SELECT count(*) INTO v_count
  FROM public.routine_completions rc
  JOIN public.routine_items ri ON ri.id = rc.routine_item_id
  WHERE ri.user_id <> rc.user_id;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'precondition: % routine_completions reference another user''s item', v_count;
  END IF;

  -- --------------------------------------------------------------------------
  -- 2. Columns. Existing rows: alarm_id NULL (global), is_active TRUE.
  --    Constant default: metadata-only, no table rewrite.
  -- --------------------------------------------------------------------------
  ALTER TABLE public.routine_items
    ADD COLUMN alarm_id  uuid    NULL,
    ADD COLUMN is_active boolean NOT NULL DEFAULT true;

  COMMENT ON COLUMN public.routine_items.alarm_id IS
    'NULL = global routine item. Otherwise the owning alarm of the same user (routine_items_alarm_owner_fkey).';
  COMMENT ON COLUMN public.routine_items.is_active IS
    'Archive flag. Items with completions cannot be deleted; set false instead.';

  -- --------------------------------------------------------------------------
  -- 3. Unique keys required as targets of the composite FKs (PostgreSQL
  --    requires a unique constraint/index on exactly the referenced columns).
  -- --------------------------------------------------------------------------
  ALTER TABLE public.alarms
    ADD CONSTRAINT alarms_id_user_id_key UNIQUE (id, user_id);
  ALTER TABLE public.routine_items
    ADD CONSTRAINT routine_items_id_user_id_key UNIQUE (id, user_id);

  -- --------------------------------------------------------------------------
  -- 4. Ownership FKs (validated immediately; no NOT VALID).
  --    The new completions FK exists before the old CASCADE FK is dropped.
  -- --------------------------------------------------------------------------
  ALTER TABLE public.routine_items
    ADD CONSTRAINT routine_items_alarm_owner_fkey
      FOREIGN KEY (alarm_id, user_id) REFERENCES public.alarms (id, user_id)
      MATCH SIMPLE ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE;

  ALTER TABLE public.routine_completions
    ADD CONSTRAINT routine_completions_item_owner_fkey
      FOREIGN KEY (routine_item_id, user_id) REFERENCES public.routine_items (id, user_id)
      MATCH SIMPLE ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE;

  EXECUTE format('ALTER TABLE public.routine_completions DROP CONSTRAINT %I', v_old_fk);

  EXECUTE format(
    'COMMENT ON CONSTRAINT routine_completions_item_owner_fkey ON public.routine_completions IS %L',
    'mathwake:20261011000000 replaced_fk=' || v_old_fk);

  -- --------------------------------------------------------------------------
  -- 5. Indexes. The UNIQUE constraints above bring their own indexes.
  --    routine_items_user_alarm_sort_idx: app query (user_id, order by
  --      sort_order, later alarm_id filter) and the FK check on alarm delete.
  --    routine_completions_item_user_idx: FK check on item delete/update.
  -- --------------------------------------------------------------------------
  CREATE INDEX routine_items_user_alarm_sort_idx
    ON public.routine_items USING btree (user_id, alarm_id, sort_order);
  CREATE INDEX routine_completions_item_user_idx
    ON public.routine_completions USING btree (routine_item_id, user_id);

  -- --------------------------------------------------------------------------
  -- 6. RLS: explicit WITH CHECK on the existing policies (no new policy).
  -- --------------------------------------------------------------------------
  ALTER POLICY "own data" ON public.alarms
    USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  ALTER POLICY "own data" ON public.routine_items
    USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  ALTER POLICY "own data" ON public.routine_completions
    USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

  -- --------------------------------------------------------------------------
  -- 7. Postconditions. Any failure rolls back the whole migration.
  -- --------------------------------------------------------------------------

  -- 7a. Row counts unchanged; existing items global and active.
  IF (SELECT count(*) FROM public.alarms) <> v_rows_alarms
     OR (SELECT count(*) FROM public.routine_items) <> v_rows_items
     OR (SELECT count(*) FROM public.routine_completions) <> v_rows_compl THEN
    RAISE EXCEPTION 'postcondition: row counts changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.routine_items WHERE alarm_id IS NOT NULL OR NOT is_active) THEN
    RAISE EXCEPTION 'postcondition: existing routine_items are not all global and active';
  END IF;

  -- 7b. New columns exactly as specified.
  SELECT array_agg(attname::text ORDER BY attname::text COLLATE "C") INTO v_cols
  FROM pg_attribute
  WHERE attrelid = 'public.routine_items'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM ARRAY['alarm_id', 'id', 'is_active', 'label', 'sort_order', 'user_id'] THEN
    RAISE EXCEPTION 'postcondition: routine_items columns are %', v_cols;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                 WHERE a.attrelid = 'public.routine_items'::regclass AND a.attname = 'alarm_id'
                   AND a.atttypid = 'uuid'::regtype AND NOT a.attnotnull AND NOT a.atthasdef)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a
                    JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                    WHERE a.attrelid = 'public.routine_items'::regclass AND a.attname = 'is_active'
                      AND a.atttypid = 'boolean'::regtype AND a.attnotnull
                      AND pg_get_expr(d.adbin, d.adrelid) = 'true') THEN
    RAISE EXCEPTION 'postcondition: alarm_id / is_active column definition mismatch';
  END IF;

  -- 7c. Unique constraints: exact ordered columns, not deferrable, backed by
  --     a valid unique btree index.
  IF (SELECT count(*)
      FROM pg_constraint c
      JOIN pg_index i ON i.indexrelid = c.conindid
      WHERE c.contype = 'u' AND NOT c.condeferrable AND c.convalidated
        AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL
        AND ((c.conname = 'alarms_id_user_id_key' AND c.conrelid = 'public.alarms'::regclass)
          OR (c.conname = 'routine_items_id_user_id_key' AND c.conrelid = 'public.routine_items'::regclass))
        AND (SELECT array_agg(a.attname::text ORDER BY u.ord)
               FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum)
            = ARRAY['id', 'user_id']) <> 2 THEN
    RAISE EXCEPTION 'postcondition: unique constraints (id, user_id) missing or wrong';
  END IF;

  -- 7d. FKs: new ones exact; old CASCADE FK gone; auth.users FKs unchanged;
  --     FK inventory exactly 2 on each routine table.
  FOR v_spec IN
    SELECT * FROM (VALUES
      ('public.routine_items',       'public.alarms',        ARRAY['alarm_id', 'user_id'],        ARRAY['id', 'user_id'], 'a', 'a', 'routine_items_alarm_owner_fkey'),
      ('public.routine_completions', 'public.routine_items', ARRAY['routine_item_id', 'user_id'], ARRAY['id', 'user_id'], 'a', 'a', 'routine_completions_item_owner_fkey'),
      ('public.alarms',              'auth.users',           ARRAY['user_id'],                    ARRAY['id'],            'a', 'a', NULL),
      ('public.routine_items',       'auth.users',           ARRAY['user_id'],                    ARRAY['id'],            'a', 'a', NULL),
      ('public.routine_completions', 'auth.users',           ARRAY['user_id'],                    ARRAY['id'],            'a', 'a', NULL)
    ) AS s(from_tbl, to_tbl, cols, refcols, del_action, upd_action, fk_name)
  LOOP
    EXECUTE c_fk_check INTO v_any, v_exact
      USING v_spec.from_tbl::regclass, v_spec.to_tbl::regclass, v_spec.cols, v_spec.refcols,
            v_spec.del_action, v_spec.upd_action, v_spec.fk_name;
    IF v_any <> 1 OR v_exact <> 1 THEN
      RAISE EXCEPTION 'postcondition: FK %(%) -> %(%) not exactly as specified (found % on these columns, % exact)',
        v_spec.from_tbl, v_spec.cols, v_spec.to_tbl, v_spec.refcols, v_any, v_exact;
    END IF;
  END LOOP;

  EXECUTE c_fk_check INTO v_any, v_exact
    USING 'public.routine_completions'::regclass, 'public.routine_items'::regclass,
          ARRAY['routine_item_id'], ARRAY['id'], 'c', 'a', NULL::text;
  IF v_any <> 0
     OR EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.routine_completions'::regclass AND conname = v_old_fk) THEN
    RAISE EXCEPTION 'postcondition: old FK % (routine_item_id) still present', v_old_fk;
  END IF;

  IF (SELECT count(*) FROM pg_constraint
      WHERE contype = 'f' AND conrelid = 'public.routine_items'::regclass) <> 2
     OR (SELECT count(*) FROM pg_constraint
         WHERE contype = 'f' AND conrelid = 'public.routine_completions'::regclass) <> 2 THEN
    RAISE EXCEPTION 'postcondition: unexpected FK count on routine_items / routine_completions (expected 2 each)';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                 JOIN pg_description d ON d.objoid = c.oid AND d.classoid = 'pg_constraint'::regclass
                 WHERE c.conrelid = 'public.routine_completions'::regclass
                   AND c.conname = 'routine_completions_item_owner_fkey'
                   AND d.description = 'mathwake:20261011000000 replaced_fk=' || v_old_fk) THEN
    RAISE EXCEPTION 'postcondition: replaced-FK marker comment missing';
  END IF;

  -- 7e. Indexes: exactly the expected set per table; new ones valid,
  --     non-unique, btree, no predicate/expression, exact column order.
  IF (SELECT count(*) FROM pg_index WHERE indrelid = 'public.alarms'::regclass) <> 2
     OR (SELECT count(*) FROM pg_index WHERE indrelid = 'public.routine_items'::regclass) <> 3
     OR (SELECT count(*) FROM pg_index WHERE indrelid = 'public.routine_completions'::regclass) <> 2 THEN
    RAISE EXCEPTION 'postcondition: unexpected index count (expected alarms 2, routine_items 3, routine_completions 2)';
  END IF;

  FOR v_spec IN
    SELECT * FROM (VALUES
      ('public.routine_items_user_alarm_sort_idx', 'public.routine_items',       ARRAY['user_id', 'alarm_id', 'sort_order']),
      ('public.routine_completions_item_user_idx', 'public.routine_completions', ARRAY['routine_item_id', 'user_id'])
    ) AS s(idx, tbl, cols)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_am am    ON am.oid = ic.relam
      WHERE i.indexrelid = to_regclass(v_spec.idx)
        AND i.indrelid = v_spec.tbl::regclass
        AND am.amname = 'btree'
        AND NOT i.indisunique AND i.indisvalid AND i.indisready
        AND i.indpred IS NULL AND i.indexprs IS NULL
        AND (SELECT array_agg(a.attname::text ORDER BY u.ord)
               FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS u(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum) = v_spec.cols
    ) THEN
      RAISE EXCEPTION 'postcondition: index % missing or not exactly btree (%)', v_spec.idx, v_spec.cols;
    END IF;
  END LOOP;

  -- 7f. RLS still enabled (FORCE unchanged); exactly one "own data" policy
  --     per table with explicit WITH CHECK identical to USING.
  IF (SELECT count(*) FROM pg_class
      WHERE oid IN ('public.alarms'::regclass, 'public.routine_items'::regclass,
                    'public.routine_completions'::regclass)
        AND relrowsecurity AND NOT relforcerowsecurity) <> 3 THEN
    RAISE EXCEPTION 'postcondition: RLS state changed';
  END IF;
  FOREACH v_table IN ARRAY ARRAY['alarms', 'routine_items', 'routine_completions'] LOOP
    SELECT count(*) INTO v_count FROM pg_policies
    WHERE schemaname = 'public' AND tablename = v_table;
    SELECT * INTO v_pol FROM pg_policies WHERE schemaname = 'public' AND tablename = v_table;
    IF v_count <> 1
       OR v_pol.policyname <> 'own data'
       OR v_pol.permissive <> 'PERMISSIVE'
       OR v_pol.roles <> ARRAY['public']::name[]
       OR v_pol.cmd <> 'ALL'
       OR regexp_replace(coalesce(v_pol.qual, ''), '[\s()]', '', 'g') <> 'auth.uid=user_id'
       OR regexp_replace(coalesce(v_pol.with_check, ''), '[\s()]', '', 'g') <> 'auth.uid=user_id' THEN
      RAISE EXCEPTION 'postcondition: policy on public.% not as expected', v_table;
    END IF;
  END LOOP;

  RAISE NOTICE 'mathwake 20261011000000 applied; replaced FK %', v_old_fk;
END
$migration$;
