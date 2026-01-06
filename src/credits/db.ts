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

export async function getBalance(
  userId: string,
  creditType: string
): Promise<number> {
  const p = ensurePool();
  const result = await p.query(
    `SELECT balance FROM ${schema}.credit_balances WHERE user_id = $1 AND credit_type_id = $2`,
    [userId, creditType]
  );
  return result.rows.length > 0 ? Number(result.rows[0].balance) : 0;
}

export async function getAllBalances(
  userId: string
): Promise<Record<string, number>> {
  const p = ensurePool();
  const result = await p.query(
    `SELECT credit_type_id, balance FROM ${schema}.credit_balances WHERE user_id = $1`,
    [userId]
  );
  const balances: Record<string, number> = {};
  for (const row of result.rows) {
    balances[row.credit_type_id] = Number(row.balance);
  }
  return balances;
}

export async function checkIdempotencyKey(key: string): Promise<boolean> {
  const p = ensurePool();
  const result = await p.query(
    `SELECT 1 FROM ${schema}.credit_ledger WHERE idempotency_key = $1`,
    [key]
  );
  return result.rows.length > 0;
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
  creditType: string,
  amount: number,
  balanceAfter: number,
  params: LedgerEntryParams
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO ${schema}.credit_ledger
       (user_id, credit_type_id, amount, balance_after, transaction_type, source, source_id, description, metadata, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId,
        creditType,
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
  creditType: string
): Promise<void> {
  await client.query(
    `INSERT INTO ${schema}.credit_balances (user_id, credit_type_id, balance)
     VALUES ($1, $2, 0)
     ON CONFLICT DO NOTHING`,
    [userId, creditType]
  );
}

/*
  Retrieves the credit balance for a user and credit type,
  locking the row with FOR UPDATE to prevent race conditions
  during a transaction.
*/
async function getBalanceForUpdate(
  client: PoolClient,
  userId: string,
  creditType: string
): Promise<number> {
  // Ensure row exists first so FOR UPDATE has something to lock
  await ensureBalanceRowExists(client, userId, creditType);

  const result = await client.query(
    `SELECT balance FROM ${schema}.credit_balances
     WHERE user_id = $1 AND credit_type_id = $2
     FOR UPDATE`,
    [userId, creditType]
  );
  return Number(result.rows[0].balance);
}

async function setBalanceValue(
  client: PoolClient,
  userId: string,
  creditType: string,
  newBalance: number
): Promise<void> {
  await client.query(
    `UPDATE ${schema}.credit_balances
     SET balance = $3, updated_at = now()
     WHERE user_id = $1 AND credit_type_id = $2`,
    [userId, creditType, newBalance]
  );
}

export async function atomicAdd(
  userId: string,
  creditType: string,
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
      creditType
    );
    const newBalance = currentBalance + amount;

    await setBalanceValue(client, userId, creditType, newBalance);
    await writeLedgerEntry(
      client,
      userId,
      creditType,
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
  creditType: string,
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
      creditType
    );

    if (currentBalance < amount) {
      await client.query("ROLLBACK");
      return { success: false, currentBalance };
    }

    const newBalance = currentBalance - amount;
    await setBalanceValue(client, userId, creditType, newBalance);
    await writeLedgerEntry(
      client,
      userId,
      creditType,
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
  creditType: string,
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
      creditType
    );
    const amountRevoked = Math.min(maxAmount, currentBalance);
    const newBalance = currentBalance - amountRevoked;

    if (amountRevoked > 0) {
      await setBalanceValue(client, userId, creditType, newBalance);
      await writeLedgerEntry(
        client,
        userId,
        creditType,
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
  creditType: string,
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
      creditType
    );
    const adjustment = newBalance - previousBalance;

    if (adjustment !== 0) {
      await setBalanceValue(client, userId, creditType, newBalance);
      await writeLedgerEntry(
        client,
        userId,
        creditType,
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

export async function getHistory(
  userId: string,
  creditType?: string,
  limit = 50,
  offset = 0
): Promise<CreditTransaction[]> {
  const p = ensurePool();

  let query = `
    SELECT id, user_id, credit_type_id, amount, balance_after,
           transaction_type, source, source_id, description, metadata, created_at
    FROM ${schema}.credit_ledger
    WHERE user_id = $1
  `;
  const params: (string | number)[] = [userId];

  if (creditType) {
    query += ` AND credit_type_id = $2`;
    params.push(creditType);
  }

  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${
    params.length + 2
  }`;
  params.push(limit, offset);

  const result = await p.query(query, params);

  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    creditType: row.credit_type_id,
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
