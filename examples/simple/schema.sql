CREATE SCHEMA ledger;
CREATE TABLE ledger.invoices (id bigint PRIMARY KEY, total numeric, private_note text);
CREATE FUNCTION ledger.invoice_total(bigint) RETURNS numeric LANGUAGE sql STABLE
RETURN (SELECT i.total FROM ledger.invoices AS i WHERE i.id = $1);
CREATE VIEW ledger.invoice_summary AS SELECT ledger.invoice_total(1) AS amount;
