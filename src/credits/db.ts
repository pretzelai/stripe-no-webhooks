import { Pool, PoolClient } from "pg";
import type {
  CreditTransaction,
  TransactionType,
  TransactionSource,
} from "./types";
import { CreditError } from "./types";

let pool: Pool | null = null;
let schema = "stripe";

export function setPool(p: Pool | null, s = "stripe") {
  pool = p;
  schema = s;
}

function ensurePool(): Pool {
  if (!pool) {
    throw new Error("Database pool not initialized. Call setPool() first.");
  }
  return pool;
}

export async function getBalance(params: {
  userId: string;
  key: string;
}): Promise<number> {
  const { userId, key } = params;
  const p = ensurePool();
  const result = await p.query(
    `SELECT balance FROM ${schema}.credit_balances WHERE user_id = $1 AND key = $2`,
    [userId, key]
  );
  return result.rows.length > 0 ? Number(result.rows[0].balance) : 0;
}

export async function getAllBalances(params: {
  userId: string;
}): Promise<Record<string, number>> {
  const { userId } = params;
  const p = ensurePool();
  const result = await p.query(
    `SELECT key, balance FROM ${schema}.credit_balances WHERE user_id = $1`,
    [userId]
  );
  const balances: Record<string, number> = {};
  for (const row of result.rows) {
    balances[row.key] = Number(row.balance);
  }
  return balances;
}

export async function hasCredits(params: {
  userId: string;
  key: string;
  amount: number;
}): Promise<boolean> {
  const { userId, key, amount } = params;
  const balance = await getBalance({ userId, key });
  return balance >= amount;
}

export async function checkIdempotencyKey(key: string): Promise<boolean> {
  const p = ensurePool();
  const result = await p.query(
    `SELECT 1 FROM ${schema}.credit_ledger WHERE idempotency_key = $1`,
    [key]
  );
  return result.rows.length > 0;
}

export async function checkIdempotencyKeyPrefix(prefix: string): Promise<boolean> {
  const p = ensurePool();
  const result = await p.query(
    `SELECT 1 FROM ${schema}.credit_ledger WHERE idempotency_key LIKE $1 LIMIT 1`,
    [prefix + "%"]
  );
  return result.rows.length > 0;
}

export async function countAutoTopUpsThisMonth(
  userId: string,
  key: string
): Promise<number> {
  const p = ensurePool();
  const result = await p.query(
    `SELECT COUNT(*) FROM ${schema}.credit_ledger
     WHERE user_id = $1
       AND key = $2
       AND source = 'auto_topup'
       AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')`,
    [userId, key]
  );
  return parseInt(result.rows[0].count, 10);
}

type LedgerEntryParams = {
  transactionType: TransactionType;
  source: TransactionSource;
  sourceId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
};

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code: string }).code === "23505"
  );
}

async function writeLedgerEntry(
  client: PoolClient,
  userId: string,
  key: string,
  amount: number,
  balanceAfter: number,
  params: LedgerEntryParams
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO ${schema}.credit_ledger
       (user_id, key, amount, balance_after, transaction_type, source, source_id, description, metadata, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId,
        key,
        amount,
        balanceAfter,
        params.transactionType,
        params.source,
        params.sourceId ?? null,
        params.description ?? null,
        params.metadata ? JSON.stringify(params.metadata) : null,
        params.idempotencyKey ?? null,
      ]
    );
  } catch (error) {
    if (isUniqueViolation(error) && params.idempotencyKey) {
      throw new CreditError(
        "IDEMPOTENCY_CONFLICT",
        "Operation already processed",
        {
          idempotencyKey: params.idempotencyKey,
        }
      );
    }
    throw error;
  }
}

async function ensureBalanceRowExists(
  client: PoolClient,
  userId: string,
  key: string
): Promise<void> {
  await client.query(
    `INSERT INTO ${schema}.credit_balances (user_id, key, balance)
     VALUES ($1, $2, 0)
     ON CONFLICT DO NOTHING`,
    [userId, key]
  );
}

async function getBalanceForUpdate(
  client: PoolClient,
  userId: string,
  key: string
): Promise<number> {
  // Ensure row exists first so FOR UPDATE has something to lock
  await ensureBalanceRowExists(client, userId, key);

  const result = await client.query(
    `SELECT balance FROM ${schema}.credit_balances
     WHERE user_id = $1 AND key = $2
     FOR UPDATE`,
    [userId, key]
  );
  return Number(result.rows[0].balance);
}

async function setBalanceValue(
  client: PoolClient,
  userId: string,
  key: string,
  newBalance: number
): Promise<void> {
  await client.query(
    `UPDATE ${schema}.credit_balances
     SET balance = $3, updated_at = now()
     WHERE user_id = $1 AND key = $2`,
    [userId, key, newBalance]
  );
}

export async function atomicAdd(
  userId: string,
  key: string,
  amount: number,
  params: LedgerEntryParams
): Promise<number> {
  const p = ensurePool();
  const client = await p.connect();

  try {
    await client.query("BEGIN");
    const currentBalance = await getBalanceForUpdate(
      client,
      userId,
      key
    );
    const newBalance = currentBalance + amount;

    await setBalanceValue(client, userId, key, newBalance);
    await writeLedgerEntry(
      client,
      userId,
      key,
      amount,
      newBalance,
      params
    );
    await client.query("COMMIT");

    return newBalance;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function atomicConsume(
  userId: string,
  key: string,
  amount: number,
  params: LedgerEntryParams
): Promise<
  | { success: true; newBalance: number }
  | { success: false; currentBalance: number }
> {
  const p = ensurePool();
  const client = await p.connect();

  try {
    await client.query("BEGIN");
    const currentBalance = await getBalanceForUpdate(
      client,
      userId,
      key
    );

    if (currentBalance < amount) {
      await client.query("ROLLBACK");
      return { success: false, currentBalance };
    }

    const newBalance = currentBalance - amount;
    await setBalanceValue(client, userId, key, newBalance);
    await writeLedgerEntry(
      client,
      userId,
      key,
      -amount,
      newBalance,
      params
    );
    await client.query("COMMIT");

    return { success: true, newBalance };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function atomicRevoke(
  userId: string,
  key: string,
  maxAmount: number,
  params: LedgerEntryParams
): Promise<{ newBalance: number; amountRevoked: number }> {
  const p = ensurePool();
  const client = await p.connect();

  try {
    await client.query("BEGIN");
    const currentBalance = await getBalanceForUpdate(
      client,
      userId,
      key
    );
    const amountRevoked = Math.min(maxAmount, currentBalance);
    const newBalance = currentBalance - amountRevoked;

    if (amountRevoked > 0) {
      await setBalanceValue(client, userId, key, newBalance);
      await writeLedgerEntry(
        client,
        userId,
        key,
        -amountRevoked,
        newBalance,
        params
      );
    }
    await client.query("COMMIT");

    return { newBalance, amountRevoked };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function atomicSet(
  userId: string,
  key: string,
  newBalance: number,
  params: LedgerEntryParams
): Promise<{ previousBalance: number }> {
  const p = ensurePool();
  const client = await p.connect();

  try {
    await client.query("BEGIN");
    const previousBalance = await getBalanceForUpdate(
      client,
      userId,
      key
    );
    const adjustment = newBalance - previousBalance;

    if (adjustment !== 0) {
      await setBalanceValue(client, userId, key, newBalance);
      await writeLedgerEntry(
        client,
        userId,
        key,
        adjustment,
        newBalance,
        params
      );
    }
    await client.query("COMMIT");

    return { previousBalance };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getHistory(params: {
  userId: string;
  key?: string;
  limit?: number;
  offset?: number;
}): Promise<CreditTransaction[]> {
  const { userId, key, limit = 50, offset = 0 } = params;
  const p = ensurePool();

  let query = `
    SELECT id, user_id, key, amount, balance_after,
           transaction_type, source, source_id, description, metadata, created_at
    FROM ${schema}.credit_ledger
    WHERE user_id = $1
  `;
  const queryParams: (string | number)[] = [userId];

  if (key) {
    query += ` AND key = $2`;
    queryParams.push(key);
  }

  query += ` ORDER BY created_at DESC LIMIT $${queryParams.length + 1} OFFSET $${
    queryParams.length + 2
  }`;
  queryParams.push(limit, offset);

  const result = await p.query(query, queryParams);

  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    key: row.key,
    amount: Number(row.amount),
    balanceAfter: Number(row.balance_after),
    transactionType: row.transaction_type as TransactionType,
    source: row.source as TransactionSource,
    sourceId: row.source_id ?? undefined,
    description: row.description ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: new Date(row.created_at),
  }));
}

// "Active" = most recent seat action is 'seat_grant' (not 'seat_revoke')
export async function getActiveSeatUsers(
  subscriptionId: string
): Promise<string[]> {
  const p = ensurePool();
  const result = await p.query(
    `SELECT user_id FROM (
      SELECT DISTINCT ON (user_id) user_id, source
      FROM ${schema}.credit_ledger
      WHERE source_id = $1
        AND source IN ('seat_grant', 'seat_revoke')
      ORDER BY user_id, created_at DESC
    ) active
    WHERE source = 'seat_grant'`,
    [subscriptionId]
  );
  return result.rows.map((row) => row.user_id);
}

export async function getUserSeatSubscription(
  userId: string
): Promise<string | null> {
  const p = ensurePool();
  const result = await p.query(
    `SELECT source_id as subscription_id FROM (
      SELECT DISTINCT ON (user_id) user_id, source, source_id
      FROM ${schema}.credit_ledger
      WHERE user_id = $1
        AND source IN ('seat_grant', 'seat_revoke')
      ORDER BY user_id, created_at DESC
    ) latest
    WHERE source = 'seat_grant'`,
    [userId]
  );
  return result.rows[0]?.subscription_id ?? null;
}

// Returns NET credits from a subscription (grants - revocations), preserving top-ups
export async function getCreditsGrantedBySource(
  userId: string,
  sourceId: string
): Promise<Record<string, number>> {
  const p = ensurePool();
  const result = await p.query(
    `SELECT key, SUM(amount) as net_amount
     FROM ${schema}.credit_ledger
     WHERE user_id = $1
       AND source_id = $2
       AND source IN ('subscription', 'renewal', 'seat_grant', 'plan_change', 'cancellation', 'seat_revoke')
     GROUP BY key
     HAVING SUM(amount) > 0`,
    [userId, sourceId]
  );
  const net: Record<string, number> = {};
  for (const row of result.rows) {
    net[row.key] = Number(row.net_amount);
  }
  return net;
}

// Top-up failure tracking

export type AutoTopUpStatus = {
  userId: string;
  key: string;
  paymentMethodId: string | null;
  declineType: "hard" | "soft";
  declineCode: string | null;
  failureCount: number;
  lastFailureAt: Date;
  disabled: boolean;
};

export async function getAutoTopUpStatus(params: {
  userId: string;
  key: string;
}): Promise<AutoTopUpStatus | null> {
  const { userId, key } = params;
  const p = ensurePool();
  const result = await p.query(
    `SELECT user_id, key, payment_method_id, decline_type, decline_code,
            failure_count, last_failure_at, disabled
     FROM ${schema}.topup_failures
     WHERE user_id = $1 AND key = $2`,
    [userId, key]
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    userId: row.user_id,
    key: row.key,
    paymentMethodId: row.payment_method_id,
    declineType: row.decline_type as "hard" | "soft",
    declineCode: row.decline_code,
    failureCount: row.failure_count,
    lastFailureAt: new Date(row.last_failure_at),
    disabled: row.disabled,
  };
}

export async function recordTopUpFailure(params: {
  userId: string;
  key: string;
  paymentMethodId: string | null;
  declineType: "hard" | "soft";
  declineCode: string | null;
}): Promise<AutoTopUpStatus> {
  const { userId, key, paymentMethodId, declineType, declineCode } =
    params;
  const p = ensurePool();

  const result = await p.query(
    `INSERT INTO ${schema}.topup_failures
       (user_id, key, payment_method_id, decline_type, decline_code, failure_count, last_failure_at, disabled)
     VALUES ($1, $2, $3, $4, $5, 1, NOW(), TRUE)
     ON CONFLICT (user_id, key) DO UPDATE SET
       payment_method_id = $3,
       decline_type = $4,
       decline_code = $5,
       failure_count = ${schema}.topup_failures.failure_count + 1,
       last_failure_at = NOW(),
       disabled = TRUE
     RETURNING user_id, key, payment_method_id, decline_type, decline_code,
               failure_count, last_failure_at, disabled`,
    [userId, key, paymentMethodId, declineType, declineCode]
  );

  const row = result.rows[0];
  return {
    userId: row.user_id,
    key: row.key,
    paymentMethodId: row.payment_method_id,
    declineType: row.decline_type as "hard" | "soft",
    declineCode: row.decline_code,
    failureCount: row.failure_count,
    lastFailureAt: new Date(row.last_failure_at),
    disabled: row.disabled,
  };
}

export async function unblockAutoTopUp(params: {
  userId: string;
  key: string;
}): Promise<void> {
  const { userId, key } = params;
  const p = ensurePool();
  await p.query(
    `DELETE FROM ${schema}.topup_failures WHERE user_id = $1 AND key = $2`,
    [userId, key]
  );
}

export async function unblockAllAutoTopUps(params: {
  userId: string;
}): Promise<void> {
  const { userId } = params;
  const p = ensurePool();
  await p.query(`DELETE FROM ${schema}.topup_failures WHERE user_id = $1`, [
    userId,
  ]);
}
