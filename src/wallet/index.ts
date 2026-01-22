import {
  getBalanceWithCurrency,
  atomicAdd,
  atomicConsume,
  getHistory as getCreditHistory,
  checkIdempotencyKey,
} from "../credits/db";
import { CreditError } from "../credits/types";
import type { TransactionSource } from "../credits/types";

// --- Types ---

export type WalletBalance = {
  cents: number;
  formatted: string;
  currency: string;
};

export type WalletEvent = {
  id: string;
  cents: number;
  balanceAfterCents: number;
  type: "add" | "consume" | "adjust" | "revoke";
  source: string;
  sourceId?: string;
  description?: string;
  createdAt: Date;
};

// --- Precision utilities ---

const MILLI_CENTS_PER_CENT = 1000;

export function centsToMilliCents(cents: number): number {
  return Math.round(cents * MILLI_CENTS_PER_CENT);
}

export function milliCentsToCents(milliCents: number): number {
  return milliCents / MILLI_CENTS_PER_CENT;
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf",
  "ugx", "vnd", "vuv", "xaf", "xof", "xpf"
]);

export function formatWalletBalance(milliCents: number, currency: string): string {
  const currencyLower = currency.toLowerCase();
  const cents = milliCentsToCents(milliCents);

  const symbols: Record<string, string> = {
    usd: "$",
    eur: "\u20AC",
    gbp: "\u00A3",
    jpy: "\u00A5",
    krw: "\u20A9",
  };
  const symbol = symbols[currencyLower] || `${currency.toUpperCase()} `;

  if (ZERO_DECIMAL_CURRENCIES.has(currencyLower)) {
    const absValue = Math.abs(Math.round(cents)).toString();
    return cents < 0 ? `-${symbol}${absValue}` : `${symbol}${absValue}`;
  }

  const majorUnits = cents / 100;
  const absValue = Math.abs(majorUnits).toFixed(2);
  return majorUnits < 0 ? `-${symbol}${absValue}` : `${symbol}${absValue}`;
}

// --- Wallet API ---

const WALLET_KEY = "wallet";

export async function getBalance(params: {
  userId: string;
}): Promise<WalletBalance | null> {
  const { userId } = params;
  const result = await getBalanceWithCurrency({ userId, key: WALLET_KEY });

  if (result.balance === 0 && result.currency === null) {
    return null;
  }

  const currency = result.currency || "usd";
  return {
    cents: milliCentsToCents(result.balance),
    formatted: formatWalletBalance(result.balance, currency),
    currency,
  };
}

export async function add(params: {
  userId: string;
  cents: number;
  currency?: string;
  source?: TransactionSource;
  sourceId?: string;
  description?: string;
  idempotencyKey?: string;
}): Promise<{ balance: WalletBalance }> {
  const {
    userId,
    cents,
    currency = "usd",
    source = "manual",
    sourceId,
    description,
    idempotencyKey,
  } = params;

  if (cents <= 0) {
    throw new CreditError("INVALID_AMOUNT", "Amount must be positive");
  }

  // Check for currency mismatch - wallet doesn't support multi-currency
  const existing = await getBalanceWithCurrency({ userId, key: WALLET_KEY });
  if (existing.currency && existing.currency !== currency) {
    throw new CreditError(
      "CURRENCY_MISMATCH",
      `Wallet currency is ${existing.currency}, cannot add ${currency}`,
      { walletCurrency: existing.currency, requestedCurrency: currency }
    );
  }

  const milliCents = centsToMilliCents(cents);
  const newBalanceMilliCents = await atomicAdd(userId, WALLET_KEY, milliCents, {
    transactionType: "grant",
    source,
    sourceId,
    description,
    idempotencyKey,
    currency,
  });

  return {
    balance: {
      cents: milliCentsToCents(newBalanceMilliCents),
      formatted: formatWalletBalance(newBalanceMilliCents, currency),
      currency,
    },
  };
}

export async function consume(params: {
  userId: string;
  cents: number;
  description?: string;
  idempotencyKey?: string;
}): Promise<{ balance: WalletBalance }> {
  const { userId, cents, description, idempotencyKey } = params;

  if (cents <= 0) {
    throw new CreditError("INVALID_AMOUNT", "Amount must be positive");
  }

  if (idempotencyKey) {
    const exists = await checkIdempotencyKey(idempotencyKey);
    if (exists) {
      throw new CreditError("IDEMPOTENCY_CONFLICT", "Operation already processed", { idempotencyKey });
    }
  }

  const milliCents = centsToMilliCents(cents);
  const result = await atomicConsume(userId, WALLET_KEY, milliCents, {
    transactionType: "consume",
    source: "usage",
    description,
    idempotencyKey,
  });

  const { currency } = await getBalanceWithCurrency({ userId, key: WALLET_KEY });
  const curr = currency || "usd";

  return {
    balance: {
      cents: milliCentsToCents(result.newBalance),
      formatted: formatWalletBalance(result.newBalance, curr),
      currency: curr,
    },
  };
}

export async function getHistory(params: {
  userId: string;
  limit?: number;
  offset?: number;
}): Promise<WalletEvent[]> {
  const { userId, limit = 50, offset = 0 } = params;

  const transactions = await getCreditHistory({
    userId,
    key: WALLET_KEY,
    limit,
    offset,
  });

  return transactions.map((tx) => ({
    id: tx.id,
    cents: milliCentsToCents(tx.amount),
    balanceAfterCents: milliCentsToCents(tx.balanceAfter),
    type: tx.transactionType === "grant" ? "add" : tx.transactionType,
    source: tx.source,
    sourceId: tx.sourceId,
    description: tx.description,
    createdAt: tx.createdAt,
  }));
}

export const wallet = {
  getBalance,
  add,
  consume,
  getHistory,
};
