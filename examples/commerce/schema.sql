-- Independent departments share a tenant key and reference one another across schemas.
CREATE SCHEMA identity;
CREATE SCHEMA catalog;
CREATE SCHEMA stock;
CREATE SCHEMA sales;
CREATE SCHEMA billing;
CREATE SCHEMA payments;
CREATE SCHEMA delivery;
CREATE SCHEMA support;
CREATE SCHEMA marketing;
CREATE SCHEMA reporting;

CREATE TABLE identity.tenants (id bigint PRIMARY KEY, name text NOT NULL);
CREATE TABLE identity.accounts (tenant_id bigint REFERENCES identity.tenants, id bigint, email text, PRIMARY KEY (tenant_id, id));
CREATE TABLE identity.roles (id bigint PRIMARY KEY, title text UNIQUE);
CREATE TABLE identity.memberships (tenant_id bigint, account_id bigint, role_id bigint REFERENCES identity.roles, FOREIGN KEY (tenant_id, account_id) REFERENCES identity.accounts);
CREATE TABLE identity.addresses (id bigint PRIMARY KEY, tenant_id bigint, account_id bigint, city text, FOREIGN KEY (tenant_id, account_id) REFERENCES identity.accounts);

CREATE TABLE catalog.brands (id bigint PRIMARY KEY, name text);
CREATE TABLE catalog.categories (id bigint PRIMARY KEY, parent_id bigint REFERENCES catalog.categories);
CREATE TABLE catalog.products (id bigint PRIMARY KEY, brand_id bigint REFERENCES catalog.brands, category_id bigint REFERENCES catalog.categories, title text);
CREATE TABLE catalog.variants (id bigint PRIMARY KEY, product_id bigint REFERENCES catalog.products, sku text UNIQUE);
CREATE TABLE catalog.prices (variant_id bigint REFERENCES catalog.variants, currency text, amount numeric CHECK (amount >= 0), PRIMARY KEY (variant_id, currency));

CREATE TABLE stock.warehouses (id bigint PRIMARY KEY, address_id bigint REFERENCES identity.addresses);
CREATE TABLE stock.bins (id bigint PRIMARY KEY, warehouse_id bigint REFERENCES stock.warehouses);
CREATE TABLE stock.balances (bin_id bigint REFERENCES stock.bins, variant_id bigint REFERENCES catalog.variants, qty integer, PRIMARY KEY (bin_id, variant_id));
CREATE TABLE stock.transfers (id bigint PRIMARY KEY, from_bin bigint REFERENCES stock.bins, to_bin bigint REFERENCES stock.bins);
CREATE TABLE stock.movements (transfer_id bigint REFERENCES stock.transfers, variant_id bigint REFERENCES catalog.variants, qty integer);

CREATE TABLE sales.orders (tenant_id bigint, id bigint, account_id bigint, PRIMARY KEY (tenant_id, id), FOREIGN KEY (tenant_id, account_id) REFERENCES identity.accounts);
CREATE TABLE sales.lines (id bigint PRIMARY KEY, tenant_id bigint, order_id bigint, variant_id bigint REFERENCES catalog.variants, qty integer, FOREIGN KEY (tenant_id, order_id) REFERENCES sales.orders);
CREATE TABLE sales.allocations (line_id bigint REFERENCES sales.lines, bin_id bigint REFERENCES stock.bins, qty integer);
CREATE TABLE sales.returns (id bigint PRIMARY KEY, line_id bigint REFERENCES sales.lines);
CREATE TABLE sales.return_reasons (return_id bigint REFERENCES sales.returns, reason text);

CREATE FUNCTION billing.net(numeric) RETURNS numeric LANGUAGE sql IMMUTABLE RETURN round($1, 2);
CREATE FUNCTION billing.net(integer) RETURNS integer LANGUAGE sql IMMUTABLE RETURN $1;
CREATE TABLE billing.invoices (
  tenant_id bigint, id bigint, order_id bigint, total numeric, paid numeric,
  balance numeric GENERATED ALWAYS AS (total - paid) STORED, "Internal.Note" text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales.orders
);
CREATE INDEX invoice_open_amount ON billing.invoices (billing.net(total)) WHERE paid < total;
CREATE TABLE billing.lines (id bigint PRIMARY KEY, tenant_id bigint, invoice_id bigint, sales_line_id bigint REFERENCES sales.lines, FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing.invoices);
CREATE TABLE billing.credits (id bigint PRIMARY KEY, tenant_id bigint, invoice_id bigint, amount numeric, FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing.invoices);
CREATE TABLE billing.tax_rates (id bigint PRIMARY KEY, rate numeric);
CREATE TABLE billing.tax_lines (line_id bigint REFERENCES billing.lines, rate_id bigint REFERENCES billing.tax_rates, amount numeric);
CREATE FUNCTION billing.invoice_total(bigint, bigint) RETURNS numeric LANGUAGE sql STABLE
RETURN (SELECT billing.net(i.total) FROM billing.invoices AS i WHERE i.tenant_id = $1 AND i.id = $2);

CREATE TABLE payments.providers (id bigint PRIMARY KEY, name text);
CREATE TABLE payments.methods (id bigint PRIMARY KEY, provider_id bigint REFERENCES payments.providers);
CREATE TABLE payments.charges (id bigint PRIMARY KEY, tenant_id bigint, invoice_id bigint, method_id bigint REFERENCES payments.methods, FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing.invoices);
CREATE TABLE payments.attempts (id bigint PRIMARY KEY, charge_id bigint REFERENCES payments.charges, succeeded boolean);
CREATE TABLE payments.refunds (id bigint PRIMARY KEY, charge_id bigint REFERENCES payments.charges, credit_id bigint REFERENCES billing.credits);

CREATE TABLE delivery.carriers (id bigint PRIMARY KEY, name text);
CREATE TABLE delivery.routes (id bigint PRIMARY KEY, carrier_id bigint REFERENCES delivery.carriers);
CREATE TABLE delivery.shipments (id bigint PRIMARY KEY, route_id bigint REFERENCES delivery.routes, address_id bigint REFERENCES identity.addresses);
CREATE TABLE delivery.parcels (id bigint PRIMARY KEY, shipment_id bigint REFERENCES delivery.shipments, line_id bigint REFERENCES sales.lines);
CREATE TABLE delivery.events (id bigint PRIMARY KEY, parcel_id bigint REFERENCES delivery.parcels, occurred_at timestamptz);

CREATE TABLE support.queues (id bigint PRIMARY KEY, name text);
CREATE TABLE support.tickets (id bigint PRIMARY KEY, queue_id bigint REFERENCES support.queues, tenant_id bigint, account_id bigint, FOREIGN KEY (tenant_id, account_id) REFERENCES identity.accounts);
CREATE TABLE support.messages (id bigint PRIMARY KEY, ticket_id bigint REFERENCES support.tickets, body text);
CREATE TABLE support.escalations (ticket_id bigint REFERENCES support.tickets, refund_id bigint REFERENCES payments.refunds);
CREATE TABLE support.shipment_claims (ticket_id bigint REFERENCES support.tickets, parcel_id bigint REFERENCES delivery.parcels);

CREATE TABLE marketing.campaigns (id bigint PRIMARY KEY, name text);
CREATE TABLE marketing.audiences (id bigint PRIMARY KEY, name text);
CREATE TABLE marketing.subscribers (audience_id bigint REFERENCES marketing.audiences, tenant_id bigint, account_id bigint, FOREIGN KEY (tenant_id, account_id) REFERENCES identity.accounts);
CREATE TABLE marketing.mailings (id bigint PRIMARY KEY, campaign_id bigint REFERENCES marketing.campaigns, audience_id bigint REFERENCES marketing.audiences);
CREATE TABLE marketing.redemptions (mailing_id bigint REFERENCES marketing.mailings, tenant_id bigint, order_id bigint, FOREIGN KEY (tenant_id, order_id) REFERENCES sales.orders);

CREATE TABLE reporting.periods (id bigint PRIMARY KEY, starts_on date);
CREATE TABLE reporting.targets (period_id bigint REFERENCES reporting.periods, tenant_id bigint REFERENCES identity.tenants, revenue numeric);
CREATE TABLE reporting.runs (id bigint PRIMARY KEY, period_id bigint REFERENCES reporting.periods);
CREATE TABLE reporting.checkpoints (run_id bigint REFERENCES reporting.runs, finished_at timestamptz);
CREATE TABLE reporting.adjustments (run_id bigint REFERENCES reporting.runs, credit_id bigint REFERENCES billing.credits);
CREATE VIEW reporting.open_invoices AS
  SELECT i.tenant_id, i.id, billing.invoice_total(i.tenant_id, i.id) AS amount
  FROM billing.invoices AS i WHERE i.balance > 0;
CREATE MATERIALIZED VIEW reporting.receivables AS
  SELECT tenant_id, sum(amount) AS outstanding FROM reporting.open_invoices GROUP BY tenant_id;
CREATE FUNCTION reporting.record_credit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO reporting.adjustments (credit_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER credit_added AFTER INSERT ON billing.credits
  FOR EACH ROW EXECUTE FUNCTION reporting.record_credit();

CREATE PROCEDURE reporting.close_run(bigint) LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO reporting.checkpoints(run_id, finished_at) VALUES ($1, CURRENT_TIMESTAMP);
END;
$$;
