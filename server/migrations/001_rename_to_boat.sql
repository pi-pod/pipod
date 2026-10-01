-- The hosted VM vendor formerly called Box is now Boat. Every schema object, migration
-- filename and stored identifier that carried the old name is renamed in place.
--
-- It covers a database built by the pre-split chain (self-hosted, adopted through the
-- baseline, and the hosted database, whose own chain runs alongside this one) and one built
-- from the earlier baseline. In the hosted ordering this file sorts right after
-- 001_init.sql: it renames the recorded migration filenames before the runner reaches the
-- renamed files of already-applied migrations, so they are recognised and never replayed.
-- On a fresh database nothing carries the old name and every step below is a no-op.
--
-- The rename rule is the one the source tree used: case-preserving "box" -> "boat"
-- (and plural "boxes" -> "boats") wherever the word starts an identifier or one of its
-- snake/kebab/camel segments. Words that merely end in it (sandbox, outbox) never change.
--
-- Stored data: identifier-like values (no whitespace: host ids `box-<uuid>`, codes such
-- as `box_controller`, provider/vendor values, JSON keys) are renamed. The vendor's own
-- webhook event names became `sandbox.*`. Free-form prose (messages, transcripts) is
-- not rewritten. Encrypted sandbox_host rows bind the old host id in their AAD, so
-- hosts created before this migration cannot be decrypted afterwards and must be
-- recreated.

CREATE FUNCTION pg_temp.boat_name(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(t,
    '(?<![A-Za-z])boxes(?![a-z])', 'boats', 'g'),
    '(?<![A-Za-z])box(?![a-z])', 'boat', 'g'),
    '(?<![A-Z])(?<!Sand)(?<!sand)(?<!Check)(?<!check)(?<!In)(?<!in)(?<!Out)(?<!out)Boxes(?![a-z])', 'Boats', 'g'),
    '(?<![A-Z])(?<!Sand)(?<!sand)(?<!Check)(?<!check)(?<!In)(?<!in)(?<!Out)(?<!out)Box(?![a-z])', 'Boat', 'g'),
    '(?<![A-Z])BOXES(?![A-Z])', 'BOATS', 'g'),
    '(?<![A-Z])BOX(?![A-Z])', 'BOAT', 'g')
$f$;

-- Stored values: only identifier-like tokens; prose is left as written.
CREATE FUNCTION pg_temp.boat_value(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE
    WHEN t ~ '^box\.(ready|error|archived|hydrated|degraded|recovered)$' THEN 'sandbox.' || substr(t, 5)
    WHEN t ~ '^[A-Za-z0-9_.:/@=-]+$' THEN pg_temp.boat_name(t)
    ELSE t END
$f$;

CREATE FUNCTION pg_temp.boat_json(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $f$
BEGIN
  CASE jsonb_typeof(j)
    WHEN 'object' THEN
      RETURN coalesce((SELECT jsonb_object_agg(pg_temp.boat_value(k), pg_temp.boat_json(v)) FROM jsonb_each(j) e(k, v)), '{}'::jsonb);
    WHEN 'array' THEN
      RETURN coalesce((SELECT jsonb_agg(pg_temp.boat_json(v) ORDER BY i) FROM jsonb_array_elements(j) WITH ORDINALITY a(v, i)), '[]'::jsonb);
    WHEN 'string' THEN
      RETURN to_jsonb(pg_temp.boat_value(j #>> '{}'));
    ELSE
      RETURN j;
  END CASE;
END
$f$;

DO $rename$
DECLARE
  old_word constant text := '(?<![A-Za-z])(box|boxes|BOX|BOXES)(?![a-z])|(?<![A-Z])(Box|Boxes)(?![a-z])';
  r record;
  sets text;
  cond text;
  def text;
  acl record;
BEGIN
  -- 1. Recorded migration filenames (the files themselves were renamed in source).
  UPDATE schema_migrations SET name = pg_temp.boat_name(name) WHERE name ~ old_word;

  CREATE TEMP TABLE boat_restore (ord int, stmt text) ON COMMIT DROP;

  -- 2. Foreign keys are dropped while referenced ids change, then re-added (validated).
  FOR r IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public' AND c.contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    INSERT INTO boat_restore VALUES (3, format('ALTER TABLE %I ADD CONSTRAINT %I %s',
      pg_temp.boat_name(r.tbl), pg_temp.boat_name(r.conname), pg_temp.boat_name(r.def)));
  END LOOP;

  -- 3. CHECK constraints and indexes whose definition holds an old-name literal.
  FOR r IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ~ ('''[^'']*(' || old_word || ')')
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    INSERT INTO boat_restore VALUES (1, format('ALTER TABLE %I ADD CONSTRAINT %I %s',
      pg_temp.boat_name(r.tbl), pg_temp.boat_name(r.conname), pg_temp.boat_name(r.def)));
  END LOOP;
  -- An index keeps the column labels it was built with, so indexes over renamed columns
  -- are rebuilt as well (constraint-backed ones through their constraint).
  FOR r IN
    SELECT i.indexrelid::regclass::text AS idx, pg_get_indexdef(i.indexrelid) AS def,
           k.conrelid::regclass::text AS tbl, k.conname, pg_get_constraintdef(k.oid) AS condef
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_constraint k ON k.conindid = i.indexrelid AND k.contype IN ('p', 'u', 'x')
    WHERE n.nspname = 'public' AND (pg_get_indexdef(i.indexrelid) ~ ('''[^'']*(' || old_word || ')')
      OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = i.indexrelid AND a.attname ~ old_word))
  LOOP
    IF r.conname IS NULL THEN
      EXECUTE format('DROP INDEX %s', r.idx);
      INSERT INTO boat_restore VALUES (2, pg_temp.boat_name(r.def));
    ELSE
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
      INSERT INTO boat_restore VALUES (2, format('ALTER TABLE %I ADD CONSTRAINT %I %s',
        pg_temp.boat_name(r.tbl), pg_temp.boat_name(r.conname), pg_temp.boat_name(r.condef)));
    END IF;
  END LOOP;

  -- 4. Column defaults holding an old-name literal.
  FOR r IN
    SELECT c.relname, a.attname, pg_get_expr(d.adbin, d.adrelid) AS expr
    FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE n.nspname = 'public' AND pg_get_expr(d.adbin, d.adrelid) ~ ('''[^'']*(' || old_word || ')')
  LOOP
    INSERT INTO boat_restore VALUES (0, format('ALTER TABLE %I ALTER COLUMN %I SET DEFAULT %s',
      pg_temp.boat_name(r.relname), pg_temp.boat_name(r.attname), pg_temp.boat_name(r.expr)));
  END LOOP;

  -- 5. Stored identifiers. Enabled user triggers (append-only and immutability guards)
  --    are suspended for the rewrite only; disabled ones stay disabled.
  FOR r IN
    SELECT t.tgrelid::regclass::text AS tbl, t.tgname
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgenabled <> 'D'
  LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', r.tbl, r.tgname);
    INSERT INTO boat_restore VALUES (4, format('ALTER TABLE %I ENABLE TRIGGER %I',
      pg_temp.boat_name(r.tbl), pg_temp.boat_name(r.tgname)));
  END LOOP;
  FOR r IN
    SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'schema_migrations'
  LOOP
    SELECT string_agg(format('%1$I = %2$s', a.attname, CASE
             WHEN t.typname = 'jsonb' THEN format('pg_temp.boat_json(%I)', a.attname)
             WHEN t.typname = 'json' THEN format('pg_temp.boat_json(%I::jsonb)::json', a.attname)
             WHEN t.typcategory = 'A' THEN format(
               '(SELECT array_agg(pg_temp.boat_value(e) ORDER BY i) FROM unnest(%1$I) WITH ORDINALITY u(e, i))::%2$s',
               a.attname, format_type(a.atttypid, a.atttypmod))
             ELSE format('pg_temp.boat_value(%I)', a.attname) END), ', '),
           string_agg(format('%I::text ~ %L', a.attname, old_word), ' OR ')
      INTO sets, cond
    FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_type e ON e.oid = t.typelem
    WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      AND (t.typname IN ('text', 'varchar', 'bpchar', 'jsonb', 'json')
           OR (t.typcategory = 'A' AND e.typname IN ('text', 'varchar')));
    IF sets IS NOT NULL THEN
      EXECUTE format('UPDATE %I SET %s WHERE %s', r.relname, sets, cond);
    END IF;
  END LOOP;

  -- 6. Names: columns, relations (tables, sequences, indexes), constraints, triggers.
  FOR r IN
    SELECT c.relname, a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attname ~ old_word
  LOOP
    EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', r.relname, r.attname, pg_temp.boat_name(r.attname));
  END LOOP;
  FOR r IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public' AND c.conrelid <> 0 AND c.conname ~ old_word
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.conname, pg_temp.boat_name(r.conname));
  END LOOP;
  FOR r IN
    SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'i', 'I') AND c.relname ~ old_word
  LOOP
    EXECUTE format('ALTER %s %I RENAME TO %I',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'i' THEN 'INDEX' WHEN 'I' THEN 'INDEX' ELSE 'TABLE' END,
      r.relname, pg_temp.boat_name(r.relname));
  END LOOP;
  FOR r IN
    SELECT t.tgrelid::regclass::text AS tbl, t.tgname FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgname ~ old_word
  LOOP
    EXECUTE format('ALTER TRIGGER %I ON %s RENAME TO %I', r.tgname, r.tbl, pg_temp.boat_name(r.tgname));
  END LOOP;

  -- 7. Functions: names, parameter names and bodies. A parameter rename needs a drop and
  --    re-create; its EXECUTE grants are carried over explicitly.
  FOR r IN
    SELECT p.oid, p.proname, p.proacl, pg_get_function_identity_arguments(p.oid) AS args,
           pg_get_functiondef(p.oid) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
      AND (p.proname ~ old_word OR pg_get_functiondef(p.oid) ~ old_word)
  LOOP
    def := pg_temp.boat_name(r.def);
    IF pg_temp.boat_name(r.args) <> r.args THEN
      EXECUTE format('DROP FUNCTION %I(%s)', r.proname, r.args);
      EXECUTE def;
      IF r.proacl IS NOT NULL THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %I(%s) FROM PUBLIC', pg_temp.boat_name(r.proname), pg_temp.boat_name(r.args));
        FOR acl IN SELECT * FROM aclexplode(r.proacl) LOOP
          EXECUTE format('GRANT EXECUTE ON FUNCTION %I(%s) TO %s', pg_temp.boat_name(r.proname), pg_temp.boat_name(r.args),
            CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE quote_ident(acl.grantee::regrole::text) END);
        END LOOP;
      END IF;
    ELSE
      IF r.proname ~ old_word THEN
        EXECUTE format('ALTER FUNCTION %I(%s) RENAME TO %I', r.proname, r.args, pg_temp.boat_name(r.proname));
      END IF;
      EXECUTE def;
    END IF;
  END LOOP;

  -- 8. Re-create what was set aside, now under the new names, then resume triggers.
  FOR r IN SELECT stmt FROM boat_restore ORDER BY ord LOOP
    EXECUTE r.stmt;
  END LOOP;

  -- 9. Object comments.
  FOR r IN
    SELECT d.objoid::regclass::text AS obj, d.description FROM pg_description d
    JOIN pg_class c ON c.oid = d.objoid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND d.classoid = 'pg_class'::regclass AND d.objsubid = 0
      AND d.description ~ old_word
  LOOP
    EXECUTE format('COMMENT ON TABLE %s IS %L', r.obj, pg_temp.boat_name(r.description));
  END LOOP;
END
$rename$;
