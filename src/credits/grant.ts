import * as db from "./db";
import type { TransactionSource } from "./types";
import { CreditError } from "./types";

export async function grant(params: {
  userId: string;
  creditType: string;
  amount: number;
  source?: TransactionSource;
  sourceId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<number> {
  const {
    userId,
    creditType,
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

  return db.atomicAdd(userId, creditType, amount, {
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
  creditType: string;
  amount: number;
  source?: "manual";
  sourceId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<{ balance: number; amountRevoked: number }> {
  const {
    userId,
    creditType,
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

  const result = await db.atomicRevoke(userId, creditType, amount, {
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
  creditType: string;
  source?: "manual";
  description?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ previousBalance: number; amountRevoked: number }> {
  const currentBalance = await db.getBalance(params.userId, params.creditType);

  if (currentBalance === 0) {
    return { previousBalance: 0, amountRevoked: 0 };
  }

  const result = await revoke({ ...params, amount: currentBalance });
  return {
    previousBalance: currentBalance,
    amountRevoked: result.amountRevoked,
  };
}

export async function revokeAllCreditTypesForUser(params: {
  userId: string;
  source?: "manual";
  description?: string;
  metadata?: Record<string, unknown>;
}): Promise<
  Record<string, { previousBalance: number; amountRevoked: number }>
> {
  const allBalances = await db.getAllBalances(params.userId);
  const results: Record<
    string,
    { previousBalance: number; amountRevoked: number }
  > = {};

  for (const [creditType, balance] of Object.entries(allBalances)) {
    if (balance > 0) {
      const result = await revoke({
        userId: params.userId,
        creditType,
        amount: balance,
        source: params.source,
        description: params.description,
        metadata: params.metadata,
      });
      results[creditType] = {
        previousBalance: balance,
        amountRevoked: result.amountRevoked,
      };
    }
  }

  return results;
}

export async function setBalance(params: {
  userId: string;
  creditType: string;
  balance: number;
  reason?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<{ balance: number; previousBalance: number }> {
  const { userId, creditType, balance, reason, metadata, idempotencyKey } =
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

  const result = await db.atomicSet(userId, creditType, balance, {
    transactionType: "adjust",
    source: "manual",
    description: reason,
    metadata,
    idempotencyKey,
  });

  return { balance, previousBalance: result.previousBalance };
}
