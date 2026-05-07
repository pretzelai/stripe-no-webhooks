/**
 * Seed Stripe test mode with benchmark data, then backfill into the local DB.
 *
 * Creates 100 products + prices + customers + subscriptions (which produce
 * invoices + charges + payment intents as a side effect), all tagged with
 * `metadata.benchmark = "true"` so the script is idempotent: subsequent runs
 * detect existing rows and top up only what's missing.
 *
 * Requirements:
 * - STRIPE_SECRET_KEY: a sk_test_... key (the script refuses live keys)
 * - DATABASE_URL: a PostgreSQL connection string with the `stripe` schema migrated
 *
 * Run: npx tsx benchmark-stripe-proxy/seed.ts
 */

import Stripe from "stripe";
import { backfill } from "../bin/commands/backfill.js";

const TARGET_COUNT = 100;
const CONCURRENCY = 10;
const METADATA_KEY = "benchmark";
const METADATA_VALUE = "true";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ ${name} environment variable is required`);
    process.exit(1);
  }
  return v;
}

async function inBatches<T>(
  items: T[],
  size: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    await Promise.all(batch.map((item, j) => fn(item, i + j)));
  }
}

async function countByMetadata(
  iter: AsyncIterable<{ id: string }>,
): Promise<number> {
  let count = 0;
  for await (const _ of iter) {
    count++;
    if (count >= TARGET_COUNT) return count;
  }
  return count;
}

function benchmarkQuery(extra = ""): string {
  const base = `metadata['${METADATA_KEY}']:'${METADATA_VALUE}'`;
  return extra ? `${base} AND ${extra}` : base;
}

async function seedProducts(stripe: Stripe): Promise<void> {
  const existing = await countByMetadata(
    stripe.products.search({ query: benchmarkQuery(), limit: 100 }),
  );
  const missing = TARGET_COUNT - existing;
  if (missing <= 0) {
    console.log(`✅ Products: ${existing} already exist, skipping`);
    return;
  }

  console.log(`📦 Creating ${missing} products (${existing} already exist)...`);
  const indices = Array.from({ length: missing }, (_, i) => existing + i);

  await inBatches(indices, CONCURRENCY, async (idx) => {
    const product = await stripe.products.create({
      name: `Benchmark Product ${idx}`,
      description: `Seeded for benchmark testing (${idx})`,
      metadata: { [METADATA_KEY]: METADATA_VALUE, index: String(idx) },
    });
    await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: 1000 + idx,
      recurring: { interval: "month" },
      metadata: { [METADATA_KEY]: METADATA_VALUE, index: String(idx) },
    });
  });

  console.log(`✅ Products + prices: created ${missing}`);
}

async function seedCustomers(stripe: Stripe): Promise<string[]> {
  const existingIds: string[] = [];
  for await (const c of stripe.customers.search({
    query: benchmarkQuery(),
    limit: 100,
  })) {
    existingIds.push(c.id);
    if (existingIds.length >= TARGET_COUNT) break;
  }

  const missing = TARGET_COUNT - existingIds.length;
  if (missing <= 0) {
    console.log(`✅ Customers: ${existingIds.length} already exist, skipping`);
    return existingIds.slice(0, TARGET_COUNT);
  }

  console.log(
    `👥 Creating ${missing} customers with attached payment methods (${existingIds.length} already exist)...`,
  );
  const indices = Array.from({ length: missing }, (_, i) => existingIds.length + i);
  const newIds: string[] = new Array(missing);

  await inBatches(indices, CONCURRENCY, async (idx, arrPos) => {
    const customer = await stripe.customers.create({
      email: `benchmark+${idx}@example.com`,
      name: `Benchmark Customer ${idx}`,
      metadata: { [METADATA_KEY]: METADATA_VALUE, index: String(idx) },
    });

    const pm = await stripe.paymentMethods.create({
      type: "card",
      card: { token: "tok_visa" },
    });
    await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: pm.id },
    });

    newIds[arrPos - existingIds.length] = customer.id;
  });

  console.log(`✅ Customers: created ${missing}`);
  return [...existingIds, ...newIds];
}

async function getBenchmarkPriceIds(stripe: Stripe): Promise<string[]> {
  const ids: string[] = [];
  for await (const p of stripe.prices.search({
    query: benchmarkQuery("active:'true'"),
    limit: 100,
  })) {
    ids.push(p.id);
    if (ids.length >= TARGET_COUNT) break;
  }
  return ids;
}

async function seedSubscriptions(
  stripe: Stripe,
  customerIds: string[],
  priceIds: string[],
): Promise<void> {
  const existing = await countByMetadata(
    stripe.subscriptions.search({ query: benchmarkQuery(), limit: 100 }),
  );
  const missing = TARGET_COUNT - existing;
  if (missing <= 0) {
    console.log(`✅ Subscriptions: ${existing} already exist, skipping`);
    return;
  }

  console.log(
    `📅 Creating ${missing} subscriptions (${existing} already exist)...`,
  );
  const indices = Array.from({ length: missing }, (_, i) => existing + i);

  await inBatches(indices, CONCURRENCY, async (idx) => {
    const customerId = customerIds[idx % customerIds.length];
    const priceId = priceIds[idx % priceIds.length];
    if (!customerId || !priceId) return;
    await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      metadata: { [METADATA_KEY]: METADATA_VALUE, index: String(idx) },
    });
  });

  console.log(`✅ Subscriptions: created ${missing}`);
}

async function main() {
  const stripeSecretKey = requireEnv("STRIPE_SECRET_KEY");
  requireEnv("DATABASE_URL");

  if (!stripeSecretKey.startsWith("sk_test_") && !stripeSecretKey.startsWith("rk_test_")) {
    console.error(
      "❌ Refusing to seed against a non-test Stripe key. Use sk_test_... only.",
    );
    process.exit(1);
  }

  const stripe = new Stripe(stripeSecretKey);

  console.log("=".repeat(60));
  console.log(`🌱 Seeding ${TARGET_COUNT} of each resource (idempotent)`);
  console.log("=".repeat(60));

  const startSeed = Date.now();

  await seedProducts(stripe);
  const priceIds = await getBenchmarkPriceIds(stripe);
  if (priceIds.length === 0) {
    console.error("❌ No benchmark prices found after product seed");
    process.exit(1);
  }

  const customerIds = await seedCustomers(stripe);
  await seedSubscriptions(stripe, customerIds, priceIds);

  const seedElapsed = ((Date.now() - startSeed) / 1000).toFixed(1);
  console.log(`\n⏱️  Stripe seed completed in ${seedElapsed}s`);

  console.log("\n" + "=".repeat(60));
  console.log("🔄 Backfilling Stripe data into local DB");
  console.log("=".repeat(60) + "\n");

  const result = await backfill("all", { exitOnError: false });
  if (!result?.success) {
    console.error("❌ Backfill failed:", result?.error);
    process.exit(1);
  }

  console.log("\n✅ Seed + backfill complete. You can now run:");
  console.log("   npx tsx benchmark-stripe-proxy/stripe-proxy.ts\n");
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
