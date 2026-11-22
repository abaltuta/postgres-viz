CREATE TABLE customers (
  id bigint PRIMARY KEY,
  name text NOT NULL,
  email text,
  updated_at timestamptz
);

CREATE TABLE "Parent.Key" (a int, b int, PRIMARY KEY (b,a));
CREATE TABLE "Child.Key" (x int, y int, unused text,
  CONSTRAINT "Composite FK" FOREIGN KEY (x,y) REFERENCES "Parent.Key"(b,a));
CREATE FUNCTION child_sum() RETURNS bigint LANGUAGE sql AS
  $$ SELECT sum(x) FROM public."Child.Key" $$;
CREATE FUNCTION child_sum(int) RETURNS int LANGUAGE sql AS $$ SELECT $1 $$;
CREATE FUNCTION ambiguous_sum_call() RETURNS bigint LANGUAGE sql AS $$ SELECT child_sum() $$;
CREATE VIEW child_summary AS SELECT child_sum() AS total;

-- Hasura-style generic trigger fn: writes a column of whatever table the
-- trigger is attached to, with no table name anywhere in the body
CREATE FUNCTION set_current_timestamp_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _new record;
BEGIN
  _new := NEW;
  _new."updated_at" = NOW();
  RETURN _new;
END $$;

CREATE TRIGGER customers_set_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_current_timestamp_updated_at();

CREATE TABLE orders (
  id bigint PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers(id),
  total numeric NOT NULL DEFAULT 0,
  vat numeric GENERATED ALWAYS AS (total * 0.19) STORED,
  created_at timestamptz DEFAULT now()
);

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA helpers;

CREATE FUNCTION helpers.default_email() RETURNS text STABLE LANGUAGE sql
  AS $$ SELECT 'default@example.test' $$;

CREATE FUNCTION helpers.default_customer_id_floor() RETURNS bigint LANGUAGE sql BEGIN ATOMIC
  SELECT coalesce(max(id), 0) FROM public.customers;
END;

CREATE TABLE defaulted_accounts (
  id bigint PRIMARY KEY,
  email text DEFAULT helpers.default_email(),
  customer_id_floor bigint DEFAULT helpers.default_customer_id_floor(),
  external_id uuid DEFAULT gen_random_uuid()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  table_name text,
  payload jsonb
);

CREATE VIEW customer_orders AS
  SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id;

CREATE MATERIALIZED VIEW order_stats AS
  SELECT customer_id, sum(total) AS sum_total FROM orders GROUP BY customer_id;

CREATE TABLE rule_source (
  id bigint PRIMARY KEY,
  note text
);

CREATE TABLE rule_target (
  id bigint PRIMARY KEY
);

CREATE FUNCTION rule_note() RETURNS text LANGUAGE sql AS $$ SELECT 'from rule' $$;

CREATE RULE rule_target_insert AS ON INSERT TO rule_target DO ALSO
  INSERT INTO rule_source (id, note) SELECT NEW.id, rule_note();

CREATE VIEW rule_view AS SELECT id FROM rule_target;

CREATE RULE rule_view_insert AS ON INSERT TO rule_view DO INSTEAD
  INSERT INTO rule_source (id, note) SELECT NEW.id, rule_note();

CREATE FUNCTION notify_stats() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('stats', '');
END $$;

CREATE FUNCTION log_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_count int;
BEGIN
  SELECT count(*) INTO order_count FROM orders o WHERE o.customer_id = NEW.customer_id;
  INSERT INTO audit_log (table_name, payload) VALUES ('orders', to_jsonb(NEW));
  UPDATE customers SET name = name WHERE id = NEW.customer_id;
  PERFORM notify_stats();
  RETURN NEW;
END $$;

CREATE TRIGGER orders_audit
  AFTER INSERT OR UPDATE OF total ON orders
  FOR EACH ROW EXECUTE FUNCTION log_order();

CREATE FUNCTION total_for(cid bigint) RETURNS numeric LANGUAGE sql BEGIN ATOMIC
  SELECT coalesce(sum(total), 0) FROM orders WHERE customer_id = cid;
END;

-- constraints: CHECK calling a function, on top of the PK/UNIQUE/FK above
CREATE FUNCTION non_negative(n numeric) RETURNS boolean IMMUTABLE LANGUAGE sql
  AS 'SELECT n >= 0';
ALTER TABLE orders ADD CONSTRAINT total_non_negative CHECK (non_negative(total));

-- plain index (multi-column) — PK/UNIQUE-backed indexes must NOT reappear
CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at);

CREATE TABLE index_cover (
  id bigint PRIMARY KEY,
  lookup text,
  payload text
);

CREATE INDEX index_cover_lookup_idx ON index_cover (lookup) INCLUDE (payload);
CREATE UNIQUE INDEX index_cover_payload_idx ON index_cover (payload);
CREATE TABLE payload_refs (payload text REFERENCES index_cover (payload));

-- alias gauntlet: CTE with column-list rename, named CTE outputs, derived-table
-- alias, and a correlated subquery referencing both
CREATE FUNCTION alias_gauntlet() RETURNS SETOF text LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  WITH recent(cid, amount) AS (
    SELECT o.customer_id, o.total FROM orders o
  ),
  named AS (
    SELECT c.email AS contact FROM customers c
  )
  SELECT n.contact
  FROM named n
  JOIN (SELECT r.cid FROM recent r WHERE r.amount > 10) rc ON rc.cid > 0
  WHERE EXISTS (
    SELECT 1 FROM customers cc WHERE cc.id = rc.cid AND cc.name <> n.contact
  );
END $$;

-- same alias bound to different tables in sibling subquery scopes
CREATE FUNCTION collision_check() RETURNS int LANGUAGE plpgsql AS $$
DECLARE x int;
BEGIN
  SELECT count(*) INTO x FROM (
    SELECT t.total FROM orders t
  ) a JOIN (
    SELECT t.email FROM customers t
  ) b ON true;
  RETURN x;
END $$;

-- aliased UPDATE target
CREATE FUNCTION touch_customer(cid bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE customers AS tgt SET email = tgt.name WHERE tgt.id = cid;
END $$;

-- ── shapes lifted from real BPO/EOR payroll migrations ──
CREATE SCHEMA payroll;

CREATE TABLE payroll.paycode (
  id bigint PRIMARY KEY,
  paycode_type text NOT NULL,
  currency text NOT NULL,
  exclude_from_validation boolean DEFAULT false
);

CREATE TABLE payroll.report_entry (
  id bigint PRIMARY KEY,
  payroll_report_id uuid NOT NULL,
  employee_id bigint NOT NULL,
  payroll_paycode_id bigint REFERENCES payroll.paycode (id),
  amount numeric NOT NULL
);

CREATE TABLE payroll.employee_totals (
  payroll_report_id uuid,
  employee_id bigint,
  paycode_type text,
  computed_total numeric
);

CREATE TABLE payroll.payrun (
  id bigint PRIMARY KEY,
  recurring_id bigint,
  cutoff_date date,
  finalized_at timestamptz
);

CREATE TABLE payroll.instruction (
  id bigint PRIMARY KEY,
  recurring_payrun_id bigint,
  status text,
  proration boolean
);

-- BEFORE trigger that SELECTs and mutates NEW — this MODIFIES the row, it
-- must NOT count as the function writing the table (it issues no DML)
CREATE FUNCTION payroll.enforce_proration() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE supports boolean;
BEGIN
  SELECT i.status IS NOT NULL INTO supports
  FROM payroll.instruction i WHERE i.id = NEW.id;
  IF NOT supports AND NEW.proration = true THEN
    NEW.proration := false;
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER enforce_proration_trigger BEFORE INSERT OR UPDATE ON payroll.instruction
  FOR EACH ROW EXECUTE FUNCTION payroll.enforce_proration();

CREATE FUNCTION payroll.entry_amount(entry payroll.report_entry)
  RETURNS numeric IMMUTABLE LANGUAGE sql AS 'SELECT entry.amount';

-- modeled on payroll.calculate_report_submitted_employee_totals: old-style
-- LANGUAGE sql, a data-modifying CTE, aggregation, and a CTE re-read by alias
CREATE FUNCTION payroll.recalculate_totals(report_id uuid) RETURNS void LANGUAGE sql AS $fn$
WITH deleted AS (
  DELETE FROM payroll.employee_totals
  WHERE payroll_report_id = report_id
  RETURNING employee_id
),
computed AS (
  SELECT
    e.payroll_report_id,
    e.employee_id,
    p.paycode_type,
    SUM(payroll.entry_amount(e)) AS computed_total
  FROM payroll.report_entry e
  JOIN payroll.paycode p ON e.payroll_paycode_id = p.id
  WHERE e.payroll_report_id = report_id
    AND p.exclude_from_validation = FALSE
  GROUP BY e.payroll_report_id, e.employee_id, p.paycode_type
)
INSERT INTO payroll.employee_totals (payroll_report_id, employee_id, paycode_type, computed_total)
SELECT t.payroll_report_id, t.employee_id, t.paycode_type, COALESCE(t.computed_total, 0)
FROM computed t;
$fn$;

-- modeled on payroll.payrun_instruction_update_status: composite-type parameter
-- (Hasura computed-field style), EXISTS subquery, CASE over param fields
CREATE FUNCTION payroll.payrun_status(payrun payroll.payrun)
  RETURNS text STABLE LANGUAGE plpgsql AS $fn$
DECLARE
  cutoff date := payrun.cutoff_date;
  needs_review boolean;
BEGIN
  needs_review := EXISTS (
    SELECT 1
    FROM payroll.instruction i
    WHERE i.recurring_payrun_id = payrun.recurring_id
      AND i.status = 'NEEDS_REVIEW'
  );
  RETURN (
    SELECT CASE
      WHEN needs_review AND CURRENT_DATE > cutoff THEN 'OVERDUE'
      WHEN NOT needs_review AND (CURRENT_DATE > cutoff OR payrun.finalized_at IS NOT NULL)
        THEN 'COMPLETED'
      ELSE 'IN_PROGRESS'
    END
  );
END $fn$;
