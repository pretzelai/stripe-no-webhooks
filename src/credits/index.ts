import { Pool } from "pg";
import { setPool } from "./db";
import { getBalance, getAllBalances, hasCredits } from "./balance";
import { consume } from "./consume";
import {
  grant,
  revoke,
  revokeAll,
  revokeAllCreditTypesForUser,
  setBalance,
} from "./grant";
import { getHistory } from "./history";

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
