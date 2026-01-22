export type TransactionType = "grant" | "consume" | "revoke" | "adjust";

export type TransactionSource =
  | "subscription"
  | "renewal"
  | "cancellation"
  | "topup"
  | "auto_topup"
  | "manual"
  | "usage"
  | "seat_grant"
  | "seat_revoke"
  | "plan_change";

export type CreditTransaction = {
  id: string;
  userId: string;
  key: string;
  amount: number;
  balanceAfter: number;
  transactionType: TransactionType;
  source: TransactionSource;
  sourceId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
};

export type ConsumeResult = { success: true; balance: number };

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
