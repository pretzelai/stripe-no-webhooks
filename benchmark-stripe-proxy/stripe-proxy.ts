/**
 * Benchmark: stripe-no-webhooks (DB-backed proxy) vs Raw Stripe API
 *
 * This is an end-to-end benchmark that requires:
 * - STRIPE_SECRET_KEY: A real Stripe secret key
 * - DATABASE_URL: A PostgreSQL database with synced Stripe data
 *
 * Run with: npx tsx benchmark-stripe-proxy/stripe-proxy.ts
 */

import RawStripe from "stripe";
import { StripeProxy } from "../src/stripe-proxy";

const ITERATIONS = 5;
const LIMIT = 100;

async function measure(
  name: string,
  fn: () => Promise<unknown>,
  iterations = ITERATIONS,
): Promise<{
  name: string;
  avg: number;
  min: number;
  max: number;
  times: number[];
}> {
  const times: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    const end = performance.now();
    times.push(end - start);
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  return { name, avg, min, max, times };
}

function formatMs(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

function printResults(
  label: string,
  dbResult: Awaited<ReturnType<typeof measure>>,
  apiResult: Awaited<ReturnType<typeof measure>>,
): number {
  const speedup = apiResult.avg / dbResult.avg;

  console.log(`\n📊 ${label}`);
  console.log(
    `   stripe-no-webhooks:      avg=${formatMs(dbResult.avg)} min=${formatMs(dbResult.min)} max=${formatMs(dbResult.max)}`,
  );
  console.log(
    `   Raw Stripe API:          avg=${formatMs(apiResult.avg)} min=${formatMs(apiResult.min)} max=${formatMs(apiResult.max)}`,
  );
  console.log(`   Speedup: ${speedup.toFixed(1)}x faster`);

  return speedup;
}

async function runBenchmark() {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("❌ STRIPE_SECRET_KEY environment variable is required");
    console.log("\nUsage:");
    console.log(
      "  STRIPE_SECRET_KEY=sk_test_... DATABASE_URL=postgres://... npx tsx benchmark-stripe-proxy/stripe-proxy.ts",
    );
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL environment variable is required");
    console.log("\nUsage:");
    console.log(
      "  STRIPE_SECRET_KEY=sk_test_... DATABASE_URL=postgres://... npx tsx benchmark-stripe-proxy/stripe-proxy.ts",
    );
    process.exit(1);
  }

  console.log("\n" + "=".repeat(60));
  console.log("🚀 stripe-no-webhooks Benchmark");
  console.log("=".repeat(60));
  console.log(`   Iterations per test: ${ITERATIONS}`);

  const proxyStripe = new StripeProxy(process.env.STRIPE_SECRET_KEY);
  const rawStripe = new RawStripe(process.env.STRIPE_SECRET_KEY);

  if (!proxyStripe.hasDatabase) {
    console.error("❌ stripe-no-webhooks could not connect to database");
    process.exit(1);
  }

  console.log("\n📦 Fetching test data IDs...");

  let testProductId: string | undefined;
  let testCustomerId: string | undefined;
  let testPriceId: string | undefined;

  const products = await rawStripe.products.list({ limit: 1 });
  if (products.data.length > 0) {
    testProductId = products.data[0].id;
    console.log(`   Product: ${testProductId}`);
  }

  const customers = await rawStripe.customers.list({ limit: 1 });
  if (customers.data.length > 0) {
    testCustomerId = customers.data[0].id;
    console.log(`   Customer: ${testCustomerId}`);
  }

  const prices = await rawStripe.prices.list({ limit: 1 });
  if (prices.data.length > 0) {
    testPriceId = prices.data[0].id;
    console.log(`   Price: ${testPriceId}`);
  }

  const speedups: number[] = [];

  {
    const dbResult = await measure("proxy", () =>
      proxyStripe.products.list({ limit: LIMIT }),
    );
    const apiResult = await measure("raw", () =>
      rawStripe.products.list({ limit: LIMIT }),
    );
    speedups.push(
      printResults(`products.list({ limit: ${LIMIT} })`, dbResult, apiResult),
    );
  }

  if (testProductId) {
    const dbResult = await measure("proxy", () =>
      proxyStripe.products.retrieve(testProductId!),
    );
    const apiResult = await measure("raw", () =>
      rawStripe.products.retrieve(testProductId!),
    );
    speedups.push(
      printResults(`products.retrieve("${testProductId}")`, dbResult, apiResult),
    );
  }

  {
    const dbResult = await measure("proxy", () =>
      proxyStripe.customers.list({ limit: LIMIT }),
    );
    const apiResult = await measure("raw", () =>
      rawStripe.customers.list({ limit: LIMIT }),
    );
    speedups.push(
      printResults(`customers.list({ limit: ${LIMIT} })`, dbResult, apiResult),
    );
  }

  if (testCustomerId) {
    const dbResult = await measure("proxy", () =>
      proxyStripe.customers.retrieve(testCustomerId!),
    );
    const apiResult = await measure("raw", () =>
      rawStripe.customers.retrieve(testCustomerId!),
    );
    speedups.push(
      printResults(
        `customers.retrieve("${testCustomerId}")`,
        dbResult,
        apiResult,
      ),
    );
  }

  {
    const dbResult = await measure("proxy", () =>
      proxyStripe.prices.list({ limit: LIMIT }),
    );
    const apiResult = await measure("raw", () =>
      rawStripe.prices.list({ limit: LIMIT }),
    );
    speedups.push(
      printResults(`prices.list({ limit: ${LIMIT} })`, dbResult, apiResult),
    );
  }

  if (testPriceId) {
    const dbResult = await measure("proxy", () =>
      proxyStripe.prices.retrieve(testPriceId!),
    );
    const apiResult = await measure("raw", () =>
      rawStripe.prices.retrieve(testPriceId!),
    );
    speedups.push(
      printResults(`prices.retrieve("${testPriceId}")`, dbResult, apiResult),
    );
  }

  if (testProductId) {
    const dbResult = await measure("proxy", () =>
      proxyStripe.prices.list({ product: testProductId!, limit: LIMIT }),
    );
    const apiResult = await measure("raw", () =>
      rawStripe.prices.list({ product: testProductId!, limit: LIMIT }),
    );
    speedups.push(
      printResults(
        `prices.list({ product: "${testProductId}" })`,
        dbResult,
        apiResult,
      ),
    );
  }

  {
    const dbResult = await measure("proxy", () =>
      proxyStripe.subscriptions.list({ limit: LIMIT }),
    );
    const apiResult = await measure("raw", () =>
      rawStripe.subscriptions.list({ limit: LIMIT }),
    );
    speedups.push(
      printResults(
        `subscriptions.list({ limit: ${LIMIT} })`,
        dbResult,
        apiResult,
      ),
    );
  }

  {
    const dbResult = await measure("proxy", () =>
      proxyStripe.invoices.list({ limit: LIMIT }),
    );
    const apiResult = await measure("raw", () =>
      rawStripe.invoices.list({ limit: LIMIT }),
    );
    speedups.push(
      printResults(`invoices.list({ limit: ${LIMIT} })`, dbResult, apiResult),
    );
  }

  {
    const dbResult = await measure("proxy", () =>
      proxyStripe.charges.list({ limit: LIMIT }),
    );
    const apiResult = await measure("raw", () =>
      rawStripe.charges.list({ limit: LIMIT }),
    );
    speedups.push(
      printResults(`charges.list({ limit: ${LIMIT} })`, dbResult, apiResult),
    );
  }

  console.log("\n" + "=".repeat(60));
  console.log("📈 Summary: 10 sequential list calls");
  console.log("=".repeat(60));

  {
    const dbResult = await measure(
      "proxy",
      async () => {
        await proxyStripe.products.list({ limit: LIMIT });
        await proxyStripe.prices.list({ limit: LIMIT });
        await proxyStripe.customers.list({ limit: LIMIT });
        await proxyStripe.subscriptions.list({ limit: LIMIT });
        await proxyStripe.invoices.list({ limit: LIMIT });
        await proxyStripe.charges.list({ limit: LIMIT });
        await proxyStripe.paymentIntents.list({ limit: LIMIT });
        await proxyStripe.paymentMethods.list({ limit: LIMIT });
        await proxyStripe.refunds.list({ limit: LIMIT });
        await proxyStripe.disputes.list({ limit: LIMIT });
      },
      3,
    );

    const apiResult = await measure(
      "raw",
      async () => {
        await rawStripe.products.list({ limit: LIMIT });
        await rawStripe.prices.list({ limit: LIMIT });
        await rawStripe.customers.list({ limit: LIMIT });
        await rawStripe.subscriptions.list({ limit: LIMIT });
        await rawStripe.invoices.list({ limit: LIMIT });
        await rawStripe.charges.list({ limit: LIMIT });
        await rawStripe.paymentIntents.list({ limit: LIMIT });
        await rawStripe.paymentMethods.list({ limit: LIMIT });
        await rawStripe.refunds.list({ limit: LIMIT });
        await rawStripe.disputes.list({ limit: LIMIT });
      },
      3,
    );

    const summarySpeedup = printResults(
      "10 sequential list calls",
      dbResult,
      apiResult,
    );
    speedups.push(summarySpeedup);
  }

  const avgSpeedup = speedups.reduce((a, b) => a + b, 0) / speedups.length;

  console.log("\n" + "=".repeat(60));
  console.log(`🏆 Average speedup: ${avgSpeedup.toFixed(1)}x faster`);
  console.log("=".repeat(60) + "\n");

  await proxyStripe.close();
}

runBenchmark().catch(console.error);
