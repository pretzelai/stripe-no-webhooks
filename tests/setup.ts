import { Pool, Client } from "pg";
import { runMigrations } from "@pretzelai/stripe-sync-engine";
import StripeMock from "./stripe-mock";
import Stripe from "stripe";

const TEST_DB_URL = "postgres://test:test@localhost:54321/snw_test";
const SCHEMA = "stripe";

let pool: Pool | null = null;
let initialized = false;

/**
 * Initialize test database connection and run migrations.
 * Safe to call multiple times - will only initialize once.
 */
export async function setupTestDb(): Promise<Pool> {
  if (pool && initialized) return pool;

  // Run migrations first
  await runMigrations({
    databaseUrl: TEST_DB_URL,
    schema: SCHEMA,
    logger: { info: () => {}, error: console.error },
  });

  // Create additional tables (credit system)
  const client = new Client({ connectionString: TEST_DB_URL });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.user_stripe_customer_map (
      user_id text PRIMARY KEY,
      stripe_customer_id text UNIQUE NOT NULL,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.credit_balances (
      user_id text NOT NULL,
      key text NOT NULL,
      balance bigint NOT NULL DEFAULT 0,
      currency text,
      updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (user_id, key)
    );
  `);

  // Add currency column if it doesn't exist (for existing test databases)
  await client.query(`
    ALTER TABLE ${SCHEMA}.credit_balances
      ADD COLUMN IF NOT EXISTS currency text;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.credit_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      key text NOT NULL,
      amount bigint NOT NULL,
      balance_after bigint NOT NULL,
      transaction_type text NOT NULL,
      source text NOT NULL,
      source_id text,
      description text,
      metadata jsonb,
      idempotency_key text UNIQUE,
      created_at timestamptz DEFAULT now()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_key_time
      ON ${SCHEMA}.credit_ledger(user_id, key, created_at DESC);
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_credit_ledger_source_id
      ON ${SCHEMA}.credit_ledger(source_id);
  `);

  // Top-up failure tracking for cooldown logic
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.topup_failures (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      payment_method_id TEXT,
      decline_type TEXT NOT NULL,
      decline_code TEXT,
      failure_count INTEGER DEFAULT 1,
      last_failure_at TIMESTAMPTZ DEFAULT NOW(),
      disabled BOOLEAN DEFAULT FALSE,
      PRIMARY KEY (user_id, key)
    );
  `);

  // Usage events table for usage-based billing
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.usage_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      key text NOT NULL,
      amount numeric NOT NULL,
      stripe_meter_event_id text,
      period_start timestamptz NOT NULL,
      period_end timestamptz NOT NULL,
      created_at timestamptz DEFAULT now()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_usage_events_user_key_period
      ON ${SCHEMA}.usage_events(user_id, key, period_start, period_end);
  `);

  await client.end();

  // Create pool for tests
  pool = new Pool({ connectionString: TEST_DB_URL });
  initialized = true;
  return pool;
}

/**
 * Clean up test data between tests.
 * Truncates credit tables but preserves schema.
 */
export async function cleanupTestData(): Promise<void> {
  // Ensure pool is initialized
  if (!pool) {
    await setupTestDb();
  }

  await pool!.query(`
    TRUNCATE ${SCHEMA}.credit_balances, ${SCHEMA}.credit_ledger CASCADE;
  `);
}

/**
 * Close database connection.
 * Call this after all tests.
 */
export async function teardownTestDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    initialized = false;
  }
}

/**
 * Get the test pool. Initializes if needed.
 */
export async function getTestPool(): Promise<Pool> {
  if (!pool) {
    await setupTestDb();
  }
  return pool!;
}

/**
 * Create a Stripe client - mock by default, real if USE_REAL_STRIPE is set.
 */
export function createTestStripe(): Stripe | StripeMock {
  if (process.env.USE_REAL_STRIPE && process.env.STRIPE_SECRET_KEY) {
    return new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return new StripeMock("sk_test_mock");
}

/**
 * Check if we're using real Stripe.
 */
export function isRealStripe(): boolean {
  return !!(process.env.USE_REAL_STRIPE && process.env.STRIPE_SECRET_KEY);
}

// =============================================================================
// Test Data Seeding Helpers
// =============================================================================

export type SeedCustomerParams = {
  id: string;
  metadata?: Record<string, string>;
  email?: string;
  invoiceSettings?: { default_payment_method?: string };
  deleted?: boolean;
};

export type SeedPriceParams = {
  id: string;
  productId: string;
  unitAmount: number;
  currency?: string;
  interval?: "month" | "year";
};

export type SeedSubscriptionParams = {
  id: string;
  customerId: string;
  priceId: string;
  status?: string;
  quantity?: number;
  currentPeriodStart?: number;
  currentPeriodEnd?: number;
  metadata?: Record<string, string>;
};

export type SeedUserMapParams = {
  userId: string;
  stripeCustomerId: string;
};

/**
 * Seed a customer into stripe.customers table.
 */
export async function seedCustomer(params: SeedCustomerParams): Promise<void> {
  if (!pool) await setupTestDb();
  const { id, metadata = {}, email, invoiceSettings, deleted = false } = params;
  await pool!.query(`
    INSERT INTO ${SCHEMA}.customers (id, object, metadata, email, invoice_settings, created, livemode, deleted)
    VALUES ($1, 'customer', $2, $3, $4, extract(epoch from now())::bigint, false, $5)
    ON CONFLICT (id) DO UPDATE SET metadata = $2, email = $3, invoice_settings = $4, deleted = $5
  `, [id, JSON.stringify(metadata), email || null, JSON.stringify(invoiceSettings || {}), deleted]);
}

/**
 * Seed a price into stripe.prices table.
 */
export async function seedPrice(params: SeedPriceParams): Promise<void> {
  if (!pool) await setupTestDb();
  const { id, productId, unitAmount, currency = "usd", interval = "month" } = params;
  await pool!.query(`
    INSERT INTO ${SCHEMA}.prices (id, object, product, unit_amount, currency, type, recurring, active, created, livemode)
    VALUES ($1, 'price', $2, $3, $4, 'recurring', $5, true, extract(epoch from now())::bigint, false)
    ON CONFLICT (id) DO UPDATE SET unit_amount = $3, currency = $4, recurring = $5
  `, [id, productId, unitAmount, currency, JSON.stringify({ interval, interval_count: 1 })]);
}

/**
 * Seed a subscription into stripe.subscriptions and stripe.subscription_items tables.
 */
export async function seedSubscription(params: SeedSubscriptionParams): Promise<void> {
  if (!pool) await setupTestDb();
  const {
    id,
    customerId,
    priceId,
    status = "active",
    quantity = 1,
    currentPeriodStart = Math.floor(Date.now() / 1000),
    currentPeriodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    metadata = {},
  } = params;

  // Build items JSONB to match Stripe's format
  const itemId = `si_${id.replace("sub_", "")}`;
  const items = {
    object: "list",
    data: [
      {
        id: itemId,
        object: "subscription_item",
        price: { id: priceId },
        quantity,
      },
    ],
  };

  await pool!.query(`
    INSERT INTO ${SCHEMA}.subscriptions (id, object, customer, status, current_period_start, current_period_end, cancel_at_period_end, metadata, items, created, livemode)
    VALUES ($1, 'subscription', $2, $3, $4, $5, false, $6, $7, extract(epoch from now())::bigint, false)
    ON CONFLICT (id) DO UPDATE SET status = $3, current_period_start = $4, current_period_end = $5, cancel_at_period_end = false, metadata = $6, items = $7
  `, [id, customerId, status, currentPeriodStart, currentPeriodEnd, JSON.stringify(metadata), JSON.stringify(items)]);

  // Also insert subscription item
  await pool!.query(`
    INSERT INTO ${SCHEMA}.subscription_items (id, object, subscription, price, quantity, created)
    VALUES ($1, 'subscription_item', $2, $3, $4, extract(epoch from now())::bigint)
    ON CONFLICT (id) DO UPDATE SET price = $3, quantity = $4
  `, [itemId, id, priceId, quantity]);
}

/**
 * Seed user -> stripe customer mapping.
 */
export async function seedUserMap(params: SeedUserMapParams): Promise<void> {
  if (!pool) await setupTestDb();
  const { userId, stripeCustomerId } = params;
  await pool!.query(`
    INSERT INTO ${SCHEMA}.user_stripe_customer_map (user_id, stripe_customer_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = $2
  `, [userId, stripeCustomerId]);
}

/**
 * Update subscription quantity (for per-seat billing tests).
 */
export async function updateSubscriptionQuantity(subscriptionId: string, quantity: number): Promise<void> {
  if (!pool) await setupTestDb();
  const itemId = `si_${subscriptionId.replace("sub_", "")}`;
  await pool!.query(`
    UPDATE ${SCHEMA}.subscription_items SET quantity = $1 WHERE id = $2
  `, [quantity, itemId]);
}

/**
 * Get subscription quantity from database.
 */
export async function getSubscriptionQuantity(subscriptionId: string): Promise<number> {
  if (!pool) await setupTestDb();
  const itemId = `si_${subscriptionId.replace("sub_", "")}`;
  const result = await pool!.query(`
    SELECT quantity FROM ${SCHEMA}.subscription_items WHERE id = $1
  `, [itemId]);
  return result.rows[0]?.quantity ?? 1;
}

/**
 * Clean up ALL test data (for full reset between test files).
 */
export async function cleanupAllTestData(): Promise<void> {
  if (!pool) await setupTestDb();
  await pool!.query(`
    TRUNCATE
      ${SCHEMA}.credit_balances,
      ${SCHEMA}.credit_ledger,
      ${SCHEMA}.topup_failures,
      ${SCHEMA}.usage_events,
      ${SCHEMA}.subscription_items,
      ${SCHEMA}.subscriptions,
      ${SCHEMA}.customers,
      ${SCHEMA}.user_stripe_customer_map,
      ${SCHEMA}.prices
    CASCADE
  `);
}

export { TEST_DB_URL, SCHEMA };
