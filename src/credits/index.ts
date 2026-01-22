import { Pool } from "pg";
import {
  setPool,
  getBalance,
  getAllBalances,
  hasCredits,
  getHistory,
  unblockAutoTopUp,
  unblockAllAutoTopUps,
  getAutoTopUpStatus,
  atomicBalanceReset,
  type AutoTopUpStatus,
} from "./db";
import {
  consume,
  grant,
  revoke,
  revokeAll,
  revokeAllCreditsForUser,
  setBalance,
} from "./grant";

export { CreditError } from "./types";
export type {
  CreditTransaction,
  ConsumeResult,
  TransactionType,
  TransactionSource,
} from "./types";
export type { AutoTopUpStatus };

export function initCredits(pool: Pool | null, schema = "stripe") {
  setPool(pool, schema);
}

export const credits = {
  getBalance,
  getAllBalances,
  hasCredits,
  consume,
  grant,
  revoke,
  revokeAll,
  revokeAllCreditsForUser,
  setBalance,
  getHistory,
  // Auto top-up management
  getAutoTopUpStatus,
  unblockAutoTopUp,
  unblockAllAutoTopUps,
  // Double-entry balance reset (for renewals with "reset" mode)
  atomicBalanceReset,
};
