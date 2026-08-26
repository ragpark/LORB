# Observability

The platform exposes its own signals rather than relying on the hosting platform's log stream to be
scraped. Three of them: structured logs, Prometheus metrics, and a correlation identifier that ties
the two together and follows a request across services.

## Correlation

Every request gets an `X-Correlation-ID`: the client's if it sent a usable one, otherwise a fresh
UUID. It is echoed on the response, written to every log line for that request, and carried in the
launch descriptor, so a learner's whole session — launch, state writes, evidence — shares one
identifier. `traceparent` is echoed unchanged when present, so a W3C trace context passes through.

When a user reports a failure, the correlation id from the error response is the only thing you need:

```sh
# logs
… | jq 'select(.correlation_id == "…")'

# the attempt it belongs to
psql "$DATABASE_URL" -c "select * from attempt where correlation_id = '…'"

# the evidence it produced
psql "$DATABASE_URL" -c "select statement_id, status, last_error from evidence_outbox where correlation_id = '…'"
```

## Logs

JSON, one object per line, with `service`, `environment` and `version` on every record. Set the level
with `LOG_LEVEL`.

Redaction happens in the serialiser, not at the call site — a redaction that depends on every caller
remembering it is a redaction that will leak. Authorization headers, cookies, idempotency keys,
descriptors, tokens, and the two fields that carry whatever a learner typed (`state_payload` and an
evidence `payload`) are replaced with `[redacted]` wherever they appear.

Request URLs are not logged; the matched route is. A path carries operational identifiers, which are
ours, but a query string carries a caller's own parameters, which are not.

```json
{"level":"info","time":"…","service":"lorb-runtime","environment":"production","version":"a1b2c3d",
 "correlation_id":"…","method":"POST","route":"/api/v1/runtime/launches","status":201,"duration_ms":38,"msg":"request"}
```

## Metrics

Prometheus text format at `/metrics`, plus Node process and heap defaults under the `lorb_` prefix.
Route labels come from the matched route, never the raw URL, so no series is created per attempt
identifier — an unbounded label set is how a metrics endpoint becomes an outage.

| Metric | Labels | What it tells you |
| --- | --- | --- |
| `lorb_http_requests_total` | `method`, `route`, `status` | The service-level view of every surface |
| `lorb_http_request_duration_seconds` | `method`, `route` | Latency histogram; the launch route is the one with a target |
| `lorb_launches_total` | `outcome`, `source` | `issued`, `replayed`, `rejected`, `unauthenticated`, `not_found`, by `consumer` or `smart-link` |
| `lorb_attempt_transitions_total` | `to`, `outcome` | Lifecycle movement; a rising `conflict` count means clients racing |
| `lorb_evidence_statements_total` | `outcome` | `accepted`, `duplicate`, `invalid`, `actor_mismatch`, `attempt_mismatch`, `unauthenticated` |
| `lorb_evidence_forwarded_total` | `outcome` | `delivered`, `retry`, `rejected`, `exhausted` |
| `lorb_evidence_delivery_seconds` | — | Acceptance to delivery. The evidence-freshness signal |
| `lorb_smart_link_redemptions_total` | `outcome` | `redeemed`, `not_found`, `unavailable` |

## What to alert on

Alert on the things a learner or a teacher would notice, not on every metric that exists.

| Alert | Condition | Why it matters |
| --- | --- | --- |
| Launches failing | `rate(lorb_launches_total{outcome="rejected"}[5m]) / rate(lorb_launches_total[5m]) > 0.02` for 10m | Learners cannot start work |
| Launch latency | p95 of `lorb_http_request_duration_seconds{route="/api/v1/runtime/launches"}` > 400ms for 15m | The activity feels broken before it fails |
| Evidence not delivering | `rate(lorb_evidence_forwarded_total{outcome="delivered"}[15m]) == 0` while acceptances are non-zero | Achievement is accumulating undelivered |
| Evidence stale | p99 of `lorb_evidence_delivery_seconds` > 300 for 15m | The backlog is growing faster than it drains |
| Dead letters | any increase in `lorb_evidence_forwarded_total{outcome="rejected"}` | A statement will never arrive without intervention |
| Replica not ready | `/ready` non-200 on any replica for 5m | It is serving or about to serve without its store |
| Actor mismatch | any `lorb_evidence_statements_total{outcome="actor_mismatch"}` | A player tried to speak for a pseudonym that is not its own |
| Auth failures | sustained rise in `lorb_launches_total{outcome="unauthenticated"}` | Provider misconfiguration, or someone probing |

The last two are the security signals. `actor_mismatch` should be flat at zero in a healthy system:
it means a request presented a valid descriptor and a statement about a different learner.

## Probes

| Probe | Path | Checks |
| --- | --- | --- |
| Liveness | `/health` | Nothing. Deliberately: a failing database must not get the process restarted |
| Readiness | `/ready` | Database reachable, persistence is Postgres, signing key identified |

Wire liveness to `/health` and readiness to `/ready`. Wiring liveness to `/ready` turns a database
blip into a rolling restart of the whole fleet at exactly the moment the database is least able to
cope with a fleet of reconnects.

## Worker health

The forwarder writes a heartbeat with each pass, so a readiness check or an operator can see it is
alive without reading logs:

```sh
psql "$DATABASE_URL" -c "select worker, instance, last_seen_at, detail from worker_heartbeat"
```

`detail` carries the last pass's summary: how many statements were claimed, forwarded, retried and
dead-lettered.

## Service level objectives

Targets to hold the platform to. Each maps to a signal above, so none of them is aspirational.

| Objective | Target | Signal |
| --- | --- | --- |
| Launch availability | ≥ 99.95% monthly | `lorb_launches_total` non-error ratio |
| Launch latency | p95 ≤ 400ms, p99 ≤ 750ms | `lorb_http_request_duration_seconds` |
| Evidence delivery | 99% within 5s | `lorb_evidence_delivery_seconds` |
| Evidence durability | ≥ 99.9% of accepted statements delivered | delivered ÷ accepted, over a month |
| Attempt loss | < 0.1% of started attempts ending without a terminal state | `lorb_attempt_transitions_total` |
