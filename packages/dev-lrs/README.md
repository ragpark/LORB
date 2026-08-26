# Development learning record store

Accepts xAPI statements so the evidence forwarder has somewhere real to deliver to during local
development, and so a developer can see what was actually sent.

- `PUT /statements?statementId=…` — the idempotent form the forwarder uses. A repeat of the same
  statement id is accepted and has no second effect, which is the contract a real learning record
  store offers.
- `POST /statements` — accepted for convenience.
- `GET /statements` — everything received, for inspection.

Statements are kept in memory and lost on restart. Point `LRS_ENDPOINT` at the real learning record
store in every environment that is not somebody's laptop; production configuration additionally
requires credentials for it.
