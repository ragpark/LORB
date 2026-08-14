# Enforced anti-requirements

The suite covers all 18 LORB-001 controls: banner ordering (4.3), mock/environment chrome (4.3/3.3), prohibited product and organisation terms (4.1), identity-field leak prevention (11), iframe sandboxing (7.4), origin and source checks (7.6), strict envelope validation (7.6), idempotency and correlation headers (5.1), session-only tokens (6), markup injection prevention (11), safe error copy (8), first skip link (4.1), Radix dialog behaviour (4.1), descriptor verification before embed (7.4), token clearing (6), and prohibited palette checks (4.1).

Each negative-path assertion is designed to fail if its guard is removed. The dialogue uses Radix Dialog, whose modal primitive traps focus, closes on Escape and restores focus.
