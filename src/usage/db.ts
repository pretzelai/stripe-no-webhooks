import { Pool } from "pg";

let pool: Pool | null = null;
let schema = "stripe";

export function setPool(p: Pool | null, s = "stripe") {
  pool = p;
  schema = s;
}

function ensurePool(): Pool {
  if (!pool) {
    throw new Error("Database pool not initialized. Call setPool() first.");
  }
  return pool;
}

export type UsageEvent = {
  id: string;
  userId: string;
  key: string;
  amount: number;
  stripeMeterEventId: string | null;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
};

export async function insertUsageEvent(params: {
  userId: string;
  key: string;
  amount: number;
  stripeMeterEventId?: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<UsageEvent> {
  const { userId, key, amount, stripeMeterEventId, periodStart, periodEnd } = params;
  const p = ensurePool();

  const result = await p.query(
    `INSERT INTO ${schema}.usage_events
     (user_id, key, amount, stripe_meter_event_id, period_start, period_end)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, key, amount, stripe_meter_event_id, period_start, period_end, created_at`,
    [userId, key, amount, stripeMeterEventId ?? null, periodStart, periodEnd]
  );

  const row = result.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    key: row.key,
    amount: Number(row.amount),
    stripeMeterEventId: row.stripe_meter_event_id,
    periodStart: new Date(row.period_start),
    periodEnd: new Date(row.period_end),
    createdAt: new Date(row.created_at),
  };
}

export type UsageSummary = {
  userId: string;
  key: string;
  totalAmount: number;
  eventCount: number;
  periodStart: Date;
  periodEnd: Date;
};

export async function getUsageSummary(params: {
  userId: string;
  key: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<UsageSummary> {
  const { userId, key, periodStart, periodEnd } = params;
  const p = ensurePool();

  const result = await p.query(
    `SELECT
       COALESCE(SUM(amount), 0) as total_amount,
       COUNT(*) as event_count
     FROM ${schema}.usage_events
     WHERE user_id = $1
       AND key = $2
       AND period_start = $3
       AND period_end = $4`,
    [userId, key, periodStart, periodEnd]
  );

  const row = result.rows[0];
  return {
    userId,
    key,
    totalAmount: Number(row.total_amount),
    eventCount: Number(row.event_count),
    periodStart,
    periodEnd,
  };
}

export async function getUsageHistory(params: {
  userId: string;
  key: string;
  limit?: number;
  offset?: number;
}): Promise<UsageEvent[]> {
  const { userId, key, limit = 50, offset = 0 } = params;
  const p = ensurePool();

  const result = await p.query(
    `SELECT id, user_id, key, amount, stripe_meter_event_id, period_start, period_end, created_at
     FROM ${schema}.usage_events
     WHERE user_id = $1 AND key = $2
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [userId, key, limit, offset]
  );

  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    key: row.key,
    amount: Number(row.amount),
    stripeMeterEventId: row.stripe_meter_event_id,
    periodStart: new Date(row.period_start),
    periodEnd: new Date(row.period_end),
    createdAt: new Date(row.created_at),
  }));
}
