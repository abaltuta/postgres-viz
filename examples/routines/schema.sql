CREATE SCHEMA ledger;

CREATE TABLE ledger.accounts (id integer PRIMARY KEY, balance numeric, note text);
CREATE TABLE ledger.entries (account_id integer, amount numeric, memo text);
CREATE TABLE ledger.journal (account_id integer, previous_balance numeric);
CREATE TABLE ledger.pending (delta numeric, private_note text);

CREATE FUNCTION ledger.normalize_delta(input numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$ SELECT round(input, 2) $$;

-- A partial column alias list renames account_id. The trailing amount
-- column keeps its original name inside the correlated lateral subquery.
CREATE FUNCTION ledger.account_deltas(floor_amount numeric)
RETURNS TABLE(account_key integer, delta numeric)
LANGUAGE sql STABLE AS $$
  WITH totals(key, change) AS (
    SELECT a.id, calc.amount
    FROM ledger.accounts AS a
    CROSS JOIN LATERAL (
      SELECT sum(e.amount) AS amount
      FROM ledger.entries AS e(owner)
      WHERE e.owner = a.id
    ) AS calc
  )
  SELECT t.account_key, ledger.normalize_delta(t.change)
  FROM totals AS t(account_key)
  WHERE t.change >= $1
$$;

CREATE PROCEDURE ledger.post_deltas(minimum numeric, destination regclass)
LANGUAGE plpgsql AS $$
DECLARE
  cutoff ALIAS FOR $1;
  pending record;
  previous numeric;
BEGIN
  FOR pending IN
    SELECT d.account_key, d.delta
    FROM ledger.account_deltas(cutoff) AS d(account_key, delta)
  LOOP
    SELECT a.balance INTO STRICT previous
    FROM ledger.accounts AS a WHERE a.id = pending.account_key;
    UPDATE ledger.accounts AS a
      SET balance = a.balance + ledger.normalize_delta(pending.delta)
      WHERE a.id = pending.account_key;
    EXECUTE 'INSERT INTO ledger.journal (account_id, previous_balance) VALUES ($1, $2)'
      USING pending.account_key, previous;
    IF destination IS NOT NULL THEN
      EXECUTE format('INSERT INTO %s VALUES ($1)', destination) USING pending.delta;
    END IF;
  END LOOP;
END
$$;
