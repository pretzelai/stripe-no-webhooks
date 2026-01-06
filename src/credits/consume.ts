import * as db from "./db";
import type { ConsumeResult } from "./types";
import { CreditError } from "./types";

export async function consume(params: {
  userId: string;
  creditType: string;
  amount: number;
  description?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<ConsumeResult> {
  const { userId, creditType, amount, description, metadata, idempotencyKey } = params;

  if (amount <= 0) {
    throw new CreditError("INVALID_AMOUNT", "Amount must be positive");
  }

  if (idempotencyKey) {
    const exists = await db.checkIdempotencyKey(idempotencyKey);
    if (exists) {
      throw new CreditError("IDEMPOTENCY_CONFLICT", "Operation already processed", { idempotencyKey });
    }
  }

  const result = await db.atomicConsume(userId, creditType, amount, {
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
