import * as db from "./db";

export async function getBalance(
  userId: string,
  creditType: string
): Promise<number> {
  return db.getBalance(userId, creditType);
}

export async function getAllBalances(
  userId: string
): Promise<Record<string, number>> {
  return db.getAllBalances(userId);
}

export async function hasCredits(
  userId: string,
  creditType: string,
  amount: number
): Promise<boolean> {
  const balance = await db.getBalance(userId, creditType);
  return balance >= amount;
}
