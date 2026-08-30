-- What a repository charges another repository's administrator to subscribe to a marketplace-listed
-- object. Informational only: nothing in this platform takes payment or gates access on it. All three
-- columns null means free — the default every object already listed under migration 012 keeps.
alter table learning_object add column marketplace_price_cents integer check (marketplace_price_cents is null or marketplace_price_cents >= 0);
alter table learning_object add column marketplace_currency text check (marketplace_currency is null or marketplace_currency ~ '^[A-Z]{3}$');
alter table learning_object add column marketplace_billing_period text check (marketplace_billing_period is null or marketplace_billing_period in ('one_time', 'month', 'year'));
