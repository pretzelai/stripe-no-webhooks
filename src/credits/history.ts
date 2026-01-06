import * as db from "./db";
import type { CreditTransaction } from "./types";

export async function getHistory(
  userId: string,
  options?: { creditType?: string; limit?: number; offset?: number }
): Promise<CreditTransaction[]> {
  const { creditType, limit = 50, offset = 0 } = options ?? {};
  return db.getHistory(userId, creditType, limit, offset);
}
