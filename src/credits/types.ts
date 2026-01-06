export type TransactionType = "grant" | "consume" | "revoke" | "adjust";

export type TransactionSource =
  | "subscription"
  | "renewal"
  | "cancellation"
  | "manual"
  | "usage";

export type CreditTransaction = {
  id: string;
  userId: string;
  creditType: string;
  amount: number;
  balanceAfter: number;
  transactionType: TransactionType;
  source: TransactionSource;
  sourceId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
};

export type ConsumeResult =
  | { success: true; balance: number }
  | { success: false; balance: number };

export class CreditError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CreditError";
  }
}
