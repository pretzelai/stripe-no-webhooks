import * as db from "./db";
import type { TransactionSource, ConsumeResult } from "./types";
import { CreditError } from "./types";

export async function consume(params: {
  userId: string;
  key: string;
  amount: number;
  description?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<ConsumeResult> {
  const { userId, key, amount, description, metadata, idempotencyKey } = params;

  if (amount <= 0) {
    throw new CreditError("INVALID_AMOUNT", "Amount must be positive");
  }

  if (idempotencyKey) {
    const exists = await db.checkIdempotencyKey(idempotencyKey);
    if (exists) {
      throw new CreditError("IDEMPOTENCY_CONFLICT", "Operation already processed", { idempotencyKey });
    }
  }

  const result = await db.atomicConsume(userId, key, amount, {
    transactionType: "consume",
    source: "usage",
    description,
    metadata,
    idempotencyKey,
  });

  if (result.success === false) {
    return { success: false, balance: result.currentBalance };
  }

  return { success: true, balance: result.newBalance };
}

export async function grant(params: {
  userId: string;
  key: string;
  amount: number;
  source?: TransactionSource;
  sourceId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<number> {
  const {
    userId,
    key,
    amount,
    source = "manual",
    sourceId,
    description,
    metadata,
    idempotencyKey,
  } = params;

  if (amount <= 0) {
    throw new CreditError("INVALID_AMOUNT", "Amount must be positive");
  }

  if (idempotencyKey) {
    const exists = await db.checkIdempotencyKey(idempotencyKey);
    if (exists) {
      throw new CreditError(
        "IDEMPOTENCY_CONFLICT",
        "Operation already processed",
        { idempotencyKey }
      );
    }
  }

  return db.atomicAdd(userId, key, amount, {
    transactionType: "grant",
    source,
    sourceId,
    description,
    metadata,
    idempotencyKey,
  });
}

export async function revoke(params: {
  userId: string;
  key: string;
  amount: number;
  source?: TransactionSource;
  sourceId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<{ balance: number; amountRevoked: number }> {
  const {
    userId,
    key,
    amount,
    source = "manual",
    sourceId,
    description,
    metadata,
    idempotencyKey,
  } = params;

  if (amount <= 0) {
    throw new CreditError("INVALID_AMOUNT", "Amount must be positive");
  }

  if (idempotencyKey) {
    const exists = await db.checkIdempotencyKey(idempotencyKey);
    if (exists) {
      throw new CreditError(
        "IDEMPOTENCY_CONFLICT",
        "Operation already processed",
        { idempotencyKey }
      );
    }
  }

  const result = await db.atomicRevoke(userId, key, amount, {
    transactionType: "revoke",
    source,
    sourceId,
    description,
    metadata,
    idempotencyKey,
  });

  return { balance: result.newBalance, amountRevoked: result.amountRevoked };
}

export async function revokeAll(params: {
  userId: string;
  key: string;
  source?: TransactionSource;
  sourceId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ previousBalance: number; amountRevoked: number }> {
  const currentBalance = await db.getBalance({ userId: params.userId, key: params.key });

  if (currentBalance === 0) {
    return { previousBalance: 0, amountRevoked: 0 };
  }

  // Pass a large amount - atomicRevoke will cap it to actual balance
  const result = await revoke({ ...params, amount: currentBalance });
  // Calculate actual previousBalance from result
  const previousBalance = result.balance + result.amountRevoked;
  return {
    previousBalance,
    amountRevoked: result.amountRevoked,
  };
}

export async function revokeAllCreditsForUser(params: {
  userId: string;
  source?: TransactionSource;
  description?: string;
  metadata?: Record<string, unknown>;
}): Promise<
  Record<string, { previousBalance: number; amountRevoked: number }>
> {
  const allBalances = await db.getAllBalances({ userId: params.userId });
  const results: Record<
    string,
    { previousBalance: number; amountRevoked: number }
  > = {};

  for (const [key, balance] of Object.entries(allBalances)) {
    if (balance > 0) {
      const result = await revoke({
        userId: params.userId,
        key,
        amount: balance,
        source: params.source,
        description: params.description,
        metadata: params.metadata,
      });
      results[key] = {
        previousBalance: balance,
        amountRevoked: result.amountRevoked,
      };
    }
  }

  return results;
}

export async function setBalance(params: {
  userId: string;
  key: string;
  balance: number;
  reason?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<{ balance: number; previousBalance: number }> {
  const { userId, key, balance, reason, metadata, idempotencyKey } =
    params;

  if (balance < 0) {
    throw new CreditError("INVALID_AMOUNT", "Balance cannot be negative");
  }

  if (idempotencyKey) {
    const exists = await db.checkIdempotencyKey(idempotencyKey);
    if (exists) {
      throw new CreditError(
        "IDEMPOTENCY_CONFLICT",
        "Operation already processed",
        { idempotencyKey }
      );
    }
  }

  const result = await db.atomicSet(userId, key, balance, {
    transactionType: "adjust",
    source: "manual",
    description: reason,
    metadata,
    idempotencyKey,
  });

  return { balance, previousBalance: result.previousBalance };
}
