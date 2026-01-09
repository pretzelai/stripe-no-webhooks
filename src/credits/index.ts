import { Pool } from "pg";
import {
  setPool,
  getBalance,
  getAllBalances,
  hasCredits,
  getHistory,
} from "./db";
import { consume } from "./consume";
import {
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
};
