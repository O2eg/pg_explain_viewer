#!/usr/bin/env bash
# Generate the PostgreSQL format-matrix fixtures: for every PG major version
# and every query shape, capture the same EXPLAIN in TEXT, JSON and YAML into
# test/plans/matrix/pgNN/<shape>.{txt,json,yaml}. The parity test asserts the
# three formats normalize to the same tree through the current pipeline.
#
# Usage:            tools/gen-fixtures.sh            # all versions
#                   VERSIONS="16 18" tools/gen-fixtures.sh
#                   ONLY="triggers wal" tools/gen-fixtures.sh   # shape subset
# Requires: docker + official postgres images (pulled on demand).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=test/plans/matrix
VERSIONS=${VERSIONS:-"12 13 14 15 16 17 18"}

image_for() {
  case "$1" in
    18) echo "postgres:18" ;;
    *)  echo "postgres:$1-bookworm" ;;
  esac
}

CN=pgviz-fixgen

psql_do() { # psql_do <sql...>  (statements; output discarded)
  docker exec -i -u postgres $CN psql -X -q -v ON_ERROR_STOP=1 -d postgres >/dev/null
}

psql_get() { # psql_get <sql string>  (unaligned output to stdout)
  # via stdin, not -c: psql < 15 prints only the LAST statement's result for
  # a multi-statement -c, which would swallow EXPLAIN before a ROLLBACK
  printf '%s\n' "$1" | docker exec -i -u postgres $CN \
    psql -X -q -At -v ON_ERROR_STOP=1 -d postgres
}

setup_db() {
  psql_do <<'SQL'
ALTER SYSTEM SET autovacuum = off;           -- keep stats frozen between runs
SELECT pg_reload_conf();
CREATE SCHEMA viz;
SET search_path = viz;

CREATE TABLE t_orders (id int PRIMARY KEY, customer_id int, amount numeric(10,2),
                       status text, created date);
INSERT INTO t_orders
  SELECT g, g % 1000, (g % 9973)::numeric / 100,
         (ARRAY['new','paid','shipped','void'])[1 + g % 4],
         DATE '2025-01-01' + (g % 365)
  FROM generate_series(1, 200000) g;
CREATE INDEX ON t_orders (customer_id);
CREATE INDEX ON t_orders (created);

CREATE TABLE t_customers (id int PRIMARY KEY, name text, region_id int);
INSERT INTO t_customers SELECT g, 'cust_' || g, g % 50 FROM generate_series(1, 1000) g;

CREATE TABLE t_events (id int, kind int, payload text);
INSERT INTO t_events SELECT g, g % 7, repeat('x', 100) FROM generate_series(1, 50000) g;
CREATE INDEX ON t_events (id);
CREATE INDEX ON t_events (kind);

CREATE TABLE t_audit (id serial, order_id int, note text);
CREATE FUNCTION viz.audit_fn() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN INSERT INTO viz.t_audit(order_id, note) VALUES (NEW.id, 'upd'); RETURN NEW; END $$;
CREATE TRIGGER trg_audit AFTER UPDATE ON t_orders
  FOR EACH ROW EXECUTE FUNCTION viz.audit_fn();

CREATE TABLE t_merge_tgt AS SELECT id, name, region_id FROM t_customers WHERE id <= 500;

-- identifier round-trip shape: quotes and a backslash in the name
CREATE TABLE viz."we""ird\tbl" (id int, val text);
INSERT INTO viz."we""ird\tbl" SELECT g, 'v' || g FROM generate_series(1, 1000) g;

-- postgres_fdw loopback for Foreign Scan shapes
CREATE EXTENSION postgres_fdw;
CREATE SERVER loopback FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (dbname 'postgres', host 'localhost');
CREATE USER MAPPING FOR postgres SERVER loopback OPTIONS (user 'postgres');
CREATE FOREIGN TABLE viz.f_customers (id int, name text, region_id int)
  SERVER loopback OPTIONS (schema_name 'viz', table_name 't_customers');

ANALYZE;
SQL
}

setup_partitions() {
  psql_do <<'SQL'
SET search_path = viz;
CREATE TABLE t_part (id int, val int) PARTITION BY HASH (id);
DO $$ BEGIN
  FOR i IN 0..119 LOOP
    EXECUTE format('CREATE TABLE t_part_%s PARTITION OF t_part
                    FOR VALUES WITH (MODULUS 120, REMAINDER %s)', i, i);
  END LOOP;
END $$;
INSERT INTO t_part SELECT g, g % 100 FROM generate_series(1, 120000) g;
ANALYZE t_part;
SQL
}

# ---- shape list -----------------------------------------------------------
# name|minver|maxver|explain-options|settings (';'-separated, may be empty)|query
SET_PARALLEL="SET parallel_setup_cost=0; SET parallel_tuple_cost=0; SET min_parallel_table_scan_size=0; SET max_parallel_workers_per_gather=2"
SHAPES=(
"basic-join|12|18|ANALYZE, BUFFERS||SELECT c.region_id, count(*), sum(o.amount) FROM viz.t_orders o JOIN viz.t_customers c ON c.id = o.customer_id WHERE o.status = 'paid' GROUP BY c.region_id ORDER BY 3 DESC"
"verbose-join|12|18|ANALYZE, BUFFERS, VERBOSE||SELECT o.id, o.amount, c.name FROM viz.t_orders o JOIN viz.t_customers c ON c.id = o.customer_id WHERE o.created > DATE '2025-06-01' ORDER BY o.amount DESC LIMIT 20"
"explain-only|12|18|COSTS||SELECT * FROM viz.t_orders o JOIN viz.t_customers c ON c.id = o.customer_id WHERE o.amount > 50 ORDER BY o.created"
"nestloop-index|12|18|ANALYZE, BUFFERS|SET enable_hashjoin=off; SET enable_mergejoin=off|SELECT c.name, o.amount FROM viz.t_customers c JOIN viz.t_orders o ON o.customer_id = c.id WHERE c.id IN (7, 42, 99, 123, 555)"
"parallel-workers|12|18|ANALYZE, BUFFERS|$SET_PARALLEL|SELECT status, count(*), sum(amount) FROM viz.t_orders GROUP BY status ORDER BY 3"
"parallel-sort|12|18|ANALYZE, BUFFERS|$SET_PARALLEL; SET work_mem='256kB'|SELECT * FROM viz.t_orders ORDER BY amount DESC LIMIT 100"
"partitioned|12|18|ANALYZE, BUFFERS||SELECT val, count(*) FROM viz.t_part GROUP BY val ORDER BY val LIMIT 10"
"jit|12|18|ANALYZE, BUFFERS|SET jit=on; SET jit_above_cost=0; SET jit_inline_above_cost=0; SET jit_optimize_above_cost=0|SELECT sum(amount * 1.1) FROM viz.t_orders"
"incremental-sort|13|18|ANALYZE, BUFFERS||SELECT * FROM viz.t_orders ORDER BY created, amount LIMIT 50"
"memoize|14|18|ANALYZE, BUFFERS|SET enable_hashjoin=off; SET enable_mergejoin=off|SELECT c.name, o.amount FROM viz.t_orders o JOIN viz.t_customers c ON c.id = o.customer_id WHERE o.created = DATE '2025-03-01'"
"tid-range|14|18|ANALYZE, BUFFERS||SELECT count(*) FROM viz.t_events WHERE ctid >= '(0,1)' AND ctid < '(50,1)'"
"merge|15|18|ANALYZE, BUFFERS||MERGE INTO viz.t_merge_tgt t USING viz.t_customers c ON t.id = c.id WHEN MATCHED THEN UPDATE SET name = c.name WHEN NOT MATCHED THEN INSERT VALUES (c.id, c.name, c.region_id)"
"serialize|17|18|ANALYZE, BUFFERS, SERIALIZE||SELECT * FROM viz.t_orders WHERE customer_id < 100 ORDER BY id LIMIT 500"
"planning-memory|17|18|ANALYZE, BUFFERS, MEMORY||SELECT count(*) FROM viz.t_orders WHERE created BETWEEN DATE '2025-02-01' AND DATE '2025-03-01'"
"disabled-nodes|17|18|ANALYZE, BUFFERS|SET enable_seqscan=off|SELECT count(*) FROM viz.t_events WHERE payload LIKE 'x%'"
"cte-spill|12|18|ANALYZE, BUFFERS|SET work_mem='64kB'|WITH big AS MATERIALIZED (SELECT customer_id, sum(amount) s FROM viz.t_orders GROUP BY customer_id) SELECT (SELECT count(*) FROM big WHERE s > 100), (SELECT max(s) FROM big)"
"recursive-cte|12|18|ANALYZE, BUFFERS||WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 200) SELECT count(*) FROM r JOIN viz.t_customers c ON c.id = r.n"
"window-spill|12|18|ANALYZE, BUFFERS|SET work_mem='64kB'|SELECT id, amount, rank() OVER (PARTITION BY status ORDER BY amount DESC) FROM viz.t_orders WHERE customer_id < 200 ORDER BY 3 LIMIT 20"
"bitmap-heap|12|18|ANALYZE, BUFFERS|SET work_mem='64kB'; SET enable_seqscan=off|SELECT count(*) FROM viz.t_events WHERE kind = 3 OR (id BETWEEN 1000 AND 30000)"
"wal|13|18|ANALYZE, BUFFERS, WAL||INSERT INTO viz.t_events SELECT g, g % 7, 'wal' FROM generate_series(1, 500) g"
"triggers|12|18|ANALYZE, BUFFERS||UPDATE viz.t_orders SET amount = amount + 0.01 WHERE customer_id = 77"
"fdw|12|18|ANALYZE, VERBOSE||SELECT * FROM viz.f_customers WHERE region_id = 3"
"geqo|12|18|ANALYZE, BUFFERS|SET geqo=on; SET geqo_threshold=2; SET geqo_seed=0|SELECT count(*) FROM viz.t_customers a JOIN viz.t_customers b ON b.id = a.id JOIN viz.t_customers c ON c.id = b.id JOIN viz.t_customers d ON d.id = c.id JOIN viz.t_customers e ON e.id = d.id JOIN viz.t_customers f ON f.id = e.id"
"init-subplan|12|18|ANALYZE, BUFFERS||SELECT c.id, (SELECT count(*) FROM viz.t_orders o WHERE o.customer_id = c.id) FROM viz.t_customers c WHERE c.region_id > (SELECT avg(region_id) FROM viz.t_customers) LIMIT 50"
"never-executed|12|18|ANALYZE, BUFFERS||SELECT * FROM (SELECT id FROM viz.t_customers UNION ALL SELECT id FROM viz.t_orders) u LIMIT 3"
"one-time-filter|12|18|ANALYZE, BUFFERS||SELECT * FROM viz.t_customers WHERE now() > TIMESTAMP '2100-01-01'"
"setop|12|18|ANALYZE, BUFFERS||SELECT id FROM viz.t_customers EXCEPT SELECT customer_id FROM viz.t_orders WHERE amount > 90"
"quoted-idents|12|18|ANALYZE, BUFFERS||SELECT * FROM viz.\"we\"\"ird\\tbl\" WHERE val = 'v7'"
"grouping-sets|12|18|ANALYZE, BUFFERS||SELECT status, customer_id % 10 AS grp, count(*) FROM viz.t_orders GROUP BY GROUPING SETS ((status), (grp), ())"
)
# heavy or format-invariant shapes: only oldest + newest version
LIMITED_SHAPES="partitioned geqo"

gen_version() {
  local v=$1 img dir
  img=$(image_for "$v")
  dir=$OUT/pg$v
  echo "=== PG $v ($img) ==="
  docker rm -f $CN >/dev/null 2>&1 || true
  docker run --rm -d --name $CN -e POSTGRES_HOST_AUTH_METHOD=trust "$img" >/dev/null
  for i in $(seq 1 60); do
    if docker exec -u postgres $CN pg_isready -q 2>/dev/null; then break; fi
    sleep 1
    [ "$i" = 60 ] && { echo "PG $v did not become ready"; return 1; }
  done
  sleep 2   # the image restarts once after initdb
  docker exec -u postgres $CN pg_isready -q || sleep 5

  setup_db
  local need_part=0
  if [ "$v" = 12 ] || [ "$v" = 18 ]; then setup_partitions; need_part=1; fi

  # JIT availability differs per image build; probe once
  local jit_ok=1
  if ! psql_get "SET jit=on; SET jit_above_cost=0; EXPLAIN (ANALYZE, FORMAT TEXT) SELECT sum(amount) FROM viz.t_orders" | grep -q '^JIT:'; then
    jit_ok=0
    echo "  (jit not available in this build — skipping jit shape)"
  fi

  mkdir -p "$dir"
  local entry name minv maxv opts settings sql fmt extn prefix cmd
  for entry in "${SHAPES[@]}"; do
    IFS='|' read -r name minv maxv opts settings sql <<<"$entry"
    if [ -n "${ONLY:-}" ]; then
      case " $ONLY " in *" $name "*) : ;; *) continue ;; esac
    fi
    if [ "$v" -lt "$minv" ] || [ "$v" -gt "$maxv" ]; then continue; fi
    case " $LIMITED_SHAPES " in
      *" $name "*) if [ "$v" != 12 ] && [ "$v" != 18 ]; then continue; fi ;;
    esac
    if [ "$name" = partitioned ] && [ "$need_part" = 0 ]; then continue; fi
    if [ "$name" = jit ] && [ "$jit_ok" = 0 ]; then continue; fi
    prefix=""
    [ -n "$settings" ] && prefix="$settings; "
    for fmt in TEXT JSON YAML; do
      case $fmt in TEXT) extn=txt ;; JSON) extn=json ;; YAML) extn=yaml ;; esac
      # DML shapes execute for real; roll them back so the database stays
      # as stable as possible between the three format runs
      case $name in
        merge|triggers|wal) cmd="BEGIN; ${prefix}EXPLAIN ($opts, FORMAT $fmt) $sql; ROLLBACK" ;;
        *)                  cmd="${prefix}EXPLAIN ($opts, FORMAT $fmt) $sql" ;;
      esac
      if ! psql_get "$cmd" > "$dir/$name.$extn"; then
        echo "  FAIL: $name ($fmt)"; rm -f "$dir/$name.$extn"
      fi
    done
    echo "  $name"
  done
  docker rm -f $CN >/dev/null 2>&1 || true
}

for v in $VERSIONS; do
  gen_version "$v" || echo "SKIP pg$v (image unavailable or setup failed)"
done
echo "done -> $OUT"
