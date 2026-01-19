import { Pool } from "pg";
import {
  setPool,
  getBalance,
  getAllBalances,
  hasCredits,
  getHistory,
  clearTopUpFailure,
  clearAllTopUpFailuresForUser,
  getTopUpFailure,
  type TopUpFailureRecord,
} from "./db";
import {
  consume,
  grant,
  revoke,
  revokeAll,
  revokeAllCreditTypesForUser,
  setBalance,
} from "./grant";

export { CreditError } from "./types";
export type {
  CreditTransaction,
  ConsumeResult,
  TransactionType,
  TransactionSource,
} from "./types";
export type { TopUpFailureRecord };

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
  revokeAllCreditTypesForUser,
  setBalance,
  getHistory,
  // Top-up failure management
  resetTopUpFailure: clearTopUpFailure,
  resetAllTopUpFailures: clearAllTopUpFailuresForUser,
  getTopUpFailure,
};
