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
  amount: number;
  formatted: string;
  currency: string;
};

export type WalletEvent = {
  id: string;
  amount: number;
  balanceAfter: number;
  type: "add" | "consume" | "adjust" | "revoke";
  source: string;
  sourceId?: string;
  description?: string;
  createdAt: Date;
};

// --- Precision utilities ---
// Micro-cents: 1,000,000 per cent = $0.00000001 minimum resolution
// Supports AI token pricing like $0.05 per 1M tokens

const MICRO_CENTS_PER_CENT = 1_000_000;

export function centsToMicroCents(cents: number): number {
  return Math.round(cents * MICRO_CENTS_PER_CENT);
}

export function microCentsToCents(microCents: number): number {
  return microCents / MICRO_CENTS_PER_CENT;
}

// Legacy aliases for backwards compatibility
export const centsToMilliCents = centsToMicroCents;
export const milliCentsToCents = microCentsToCents;

const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf",
  "ugx", "vnd", "vuv", "xaf", "xof", "xpf"
]);

export function formatWalletBalance(microCents: number, currency: string): string {
  const currencyLower = currency.toLowerCase();
  const cents = microCentsToCents(microCents);

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

  // Smart formatting: show minimum decimals needed (up to 8 for micro-cent precision)
  const dollars = cents / 100;
  const absDollars = Math.abs(dollars);

  let decimals = 2;
  for (const d of [2, 3, 4, 5, 6, 7, 8]) {
    const rounded = parseFloat(absDollars.toFixed(d));
    if (Math.abs(rounded - absDollars) < 1e-9) {
      decimals = d;
      break;
    }
    decimals = 8;
  }

  const absValue = absDollars.toFixed(decimals);
  return dollars < 0 ? `-${symbol}${absValue}` : `${symbol}${absValue}`;
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
    amount: microCentsToCents(result.balance),
    formatted: formatWalletBalance(result.balance, currency),
    currency,
  };
}

export async function add(params: {
  userId: string;
  amount: number;
  currency?: string;
  source?: TransactionSource;
  sourceId?: string;
  description?: string;
  idempotencyKey?: string;
}): Promise<{ balance: WalletBalance }> {
  const {
    userId,
    amount,
    currency = "usd",
    source = "manual",
    sourceId,
    description,
    idempotencyKey,
  } = params;

  if (amount <= 0) {
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

  const microCents = centsToMicroCents(amount);
  const newBalanceMicroCents = await atomicAdd(userId, WALLET_KEY, microCents, {
    transactionType: "grant",
    source,
    sourceId,
    description,
    idempotencyKey,
    currency,
  });

  return {
    balance: {
      amount: microCentsToCents(newBalanceMicroCents),
      formatted: formatWalletBalance(newBalanceMicroCents, currency),
      currency,
    },
  };
}

export async function consume(params: {
  userId: string;
  amount: number;
  description?: string;
  idempotencyKey?: string;
}): Promise<{ balance: WalletBalance }> {
  const { userId, amount, description, idempotencyKey } = params;

  if (amount <= 0) {
    throw new CreditError("INVALID_AMOUNT", "Amount must be positive");
  }

  if (idempotencyKey) {
    const exists = await checkIdempotencyKey(idempotencyKey);
    if (exists) {
      throw new CreditError("IDEMPOTENCY_CONFLICT", "Operation already processed", { idempotencyKey });
    }
  }

  const microCents = centsToMicroCents(amount);
  const result = await atomicConsume(userId, WALLET_KEY, microCents, {
    transactionType: "consume",
    source: "usage",
    description,
    idempotencyKey,
  });

  const { currency } = await getBalanceWithCurrency({ userId, key: WALLET_KEY });
  const curr = currency || "usd";

  return {
    balance: {
      amount: microCentsToCents(result.newBalance),
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
    amount: microCentsToCents(tx.amount),
    balanceAfter: microCentsToCents(tx.balanceAfter),
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
