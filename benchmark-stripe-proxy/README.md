# benchmark-stripe-proxy

Benchmark `StripeProxy` (DB-backed reads) vs the raw Stripe SDK.

## Setup

```bash
./benchmark-stripe-proxy/bootstrap_db.sh
export DATABASE_URL="postgresql://postgres:postgres@localhost:5433/stripe_benchmark"
export STRIPE_SECRET_KEY="sk_test_..."
npx stripe-no-webhooks migrate
npx tsx benchmark-stripe-proxy/seed.ts
```

`seed.ts` creates 100 products/prices/customers/subscriptions in Stripe test mode (idempotent, tagged `metadata.benchmark="true"`), then backfills them into the DB. Refuses live keys.

## Run

```bash
npx tsx benchmark-stripe-proxy/stripe-proxy.ts
```

Prints avg/min/max latency for `list` and `retrieve` across 10 resource types and the overall speedup.

## Files

- `bootstrap_db.sh` — local Postgres via Docker (port 5433)
- `seed.ts` — seed Stripe test mode + backfill
- `stripe-proxy.ts` — the benchmark
