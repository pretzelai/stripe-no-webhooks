import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { Pool } from "pg";
import {
  setupTestDb,
  cleanupTestData,
  teardownTestDb,
} from "./setup";
import { initCredits, credits } from "../src/credits";
import { CreditError } from "../src/credits/types";

let pool: Pool;

// Initialize once before any tests run
beforeAll(async () => {
  pool = await setupTestDb();
  initCredits(pool, "stripe");
});

// Clean up data between tests
beforeEach(async () => {
  await cleanupTestData();
});

// Close connection after all tests
afterAll(async () => {
  await teardownTestDb();
});

describe("Credit System", () => {
  describe("grant", () => {
    test("grants credits to a user", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });

      const balance = await credits.getBalance({ userId: "user_1", key: "api_calls" });
      expect(balance).toBe(1000);
    });

    test("grants credits accumulate", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 500,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 300,
        source: "topup",
        sourceId: "topup_1",
      });

      const balance = await credits.getBalance({ userId: "user_1", key: "api_calls" });
      expect(balance).toBe(800);
    });

    test("grants different credit types independently", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.grant({
        userId: "user_1",
        key: "storage_gb",
        amount: 50,
        source: "subscription",
        sourceId: "sub_123",
      });

      const apiBalance = await credits.getBalance({ userId: "user_1", key: "api_calls" });
      const storageBalance = await credits.getBalance({ userId: "user_1", key: "storage_gb" });

      expect(apiBalance).toBe(1000);
      expect(storageBalance).toBe(50);
    });
  });

  describe("consume", () => {
    test("consumes credits when balance is sufficient", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });

      const result = await credits.consume({
        userId: "user_1",
        key: "api_calls",
        amount: 100,
        description: "API request",
      });

      expect(result.success).toBe(true);
      expect(result.balance).toBe(900);
    });

    test("consumes even when balance is insufficient (allows negative)", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 50,
        source: "subscription",
        sourceId: "sub_123",
      });

      const result = await credits.consume({
        userId: "user_1",
        key: "api_calls",
        amount: 100,
        description: "API request",
      });

      expect(result.success).toBe(true);
      expect(result.balance).toBe(-50); // Balance can go negative
    });

    test("consumes exact balance successfully", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 100,
        source: "subscription",
        sourceId: "sub_123",
      });

      const result = await credits.consume({
        userId: "user_1",
        key: "api_calls",
        amount: 100,
      });

      expect(result.success).toBe(true);
      expect(result.balance).toBe(0);
    });
  });

  describe("revoke", () => {
    test("revokes credits up to available balance", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });

      const result = await credits.revoke({
        userId: "user_1",
        key: "api_calls",
        amount: 500,
        source: "cancellation",
        sourceId: "sub_123",
      });

      expect(result.amountRevoked).toBe(500);
      expect(result.balance).toBe(500);
    });

    test("revokes only available balance when requested more", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 100,
        source: "subscription",
        sourceId: "sub_123",
      });

      const result = await credits.revoke({
        userId: "user_1",
        key: "api_calls",
        amount: 500,
        source: "cancellation",
        sourceId: "sub_123",
      });

      expect(result.amountRevoked).toBe(100);
      expect(result.balance).toBe(0);
    });
  });

  describe("revokeAll", () => {
    test("revokes all credits of a specific type for a user", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 200,
        source: "topup",
        sourceId: "topup_1",
      });

      // Revoke all credits
      await credits.revokeAll({
        userId: "user_1",
        key: "api_calls",
        source: "cancellation",
        sourceId: "sub_123",
      });

      // Should have 0 balance
      const balance = await credits.getBalance({ userId: "user_1", key: "api_calls" });
      expect(balance).toBe(0);
    });
  });

  describe("setBalance", () => {
    test("sets balance to specific value", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 500,
        source: "subscription",
        sourceId: "sub_123",
      });

      await credits.setBalance({
        userId: "user_1",
        key: "api_calls",
        balance: 1000,
        reason: "Admin adjustment",
      });

      const balance = await credits.getBalance({ userId: "user_1", key: "api_calls" });
      expect(balance).toBe(1000);
    });

    test("sets balance from zero", async () => {
      await credits.setBalance({
        userId: "user_1",
        key: "api_calls",
        balance: 500,
        reason: "Initial grant",
      });

      const balance = await credits.getBalance({ userId: "user_1", key: "api_calls" });
      expect(balance).toBe(500);
    });
  });

  describe("getBalance / getAllBalances / hasCredits", () => {
    test("getBalance returns 0 for non-existent user", async () => {
      const balance = await credits.getBalance({ userId: "nonexistent", key: "api_calls" });
      expect(balance).toBe(0);
    });

    test("getAllBalances returns all credit types", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.grant({
        userId: "user_1",
        key: "storage_gb",
        amount: 50,
        source: "subscription",
        sourceId: "sub_123",
      });

      const balances = await credits.getAllBalances({ userId: "user_1" });
      expect(balances).toEqual({
        api_calls: 1000,
        storage_gb: 50,
      });
    });

    test("hasCredits returns true when sufficient", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 100,
        source: "subscription",
        sourceId: "sub_123",
      });

      const has = await credits.hasCredits({ userId: "user_1", key: "api_calls", amount: 50 });
      expect(has).toBe(true);
    });

    test("hasCredits returns false when insufficient", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 10,
        source: "subscription",
        sourceId: "sub_123",
      });

      const has = await credits.hasCredits({ userId: "user_1", key: "api_calls", amount: 50 });
      expect(has).toBe(false);
    });
  });

  describe("getHistory", () => {
    test("returns transaction history in reverse chronological order", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.consume({
        userId: "user_1",
        key: "api_calls",
        amount: 100,
        description: "First request",
      });
      await credits.consume({
        userId: "user_1",
        key: "api_calls",
        amount: 50,
        description: "Second request",
      });

      const history = await credits.getHistory({ userId: "user_1", key: "api_calls" });

      expect(history.length).toBe(3);
      // Most recent first
      expect(history[0].amount).toBe(-50);
      expect(history[0].transactionType).toBe("consume");
      expect(history[1].amount).toBe(-100);
      expect(history[2].amount).toBe(1000);
      expect(history[2].transactionType).toBe("grant");
    });

    test("filters by credit type", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.grant({
        userId: "user_1",
        key: "storage_gb",
        amount: 50,
        source: "subscription",
        sourceId: "sub_123",
      });

      const apiHistory = await credits.getHistory({ userId: "user_1", key: "api_calls" });
      const storageHistory = await credits.getHistory({ userId: "user_1", key: "storage_gb" });

      expect(apiHistory.length).toBe(1);
      expect(storageHistory.length).toBe(1);
    });

    test("returns all credit types when not filtered", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.grant({
        userId: "user_1",
        key: "storage_gb",
        amount: 50,
        source: "subscription",
        sourceId: "sub_123",
      });

      const allHistory = await credits.getHistory({ userId: "user_1" });
      expect(allHistory.length).toBe(2);
    });

    test("respects limit and offset", async () => {
      // Create 5 transactions
      for (let i = 0; i < 5; i++) {
        await credits.grant({
          userId: "user_1",
          key: "api_calls",
          amount: 100,
          source: "subscription",
          sourceId: `sub_${i}`,
        });
      }

      const page1 = await credits.getHistory({ userId: "user_1", limit: 2 });
      const page2 = await credits.getHistory({ userId: "user_1", limit: 2, offset: 2 });

      expect(page1.length).toBe(2);
      expect(page2.length).toBe(2);
    });
  });

  // =============================================================================
  // Input Validation Tests
  // =============================================================================

  describe("input validation", () => {
    test("grant throws on zero amount", async () => {
      let error: Error | null = null;
      try {
        await credits.grant({
          userId: "user_1",
          key: "api_calls",
          amount: 0,
          source: "subscription",
          sourceId: "sub_123",
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect(error).toBeInstanceOf(CreditError);
      expect((error as CreditError).code).toBe("INVALID_AMOUNT");
    });

    test("grant throws on negative amount", async () => {
      let error: Error | null = null;
      try {
        await credits.grant({
          userId: "user_1",
          key: "api_calls",
          amount: -100,
          source: "subscription",
          sourceId: "sub_123",
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect((error as CreditError).code).toBe("INVALID_AMOUNT");
    });

    test("revoke throws on zero amount", async () => {
      let error: Error | null = null;
      try {
        await credits.revoke({
          userId: "user_1",
          key: "api_calls",
          amount: 0,
          source: "cancellation",
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect((error as CreditError).code).toBe("INVALID_AMOUNT");
    });

    test("revoke throws on negative amount", async () => {
      let error: Error | null = null;
      try {
        await credits.revoke({
          userId: "user_1",
          key: "api_calls",
          amount: -50,
          source: "cancellation",
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect((error as CreditError).code).toBe("INVALID_AMOUNT");
    });

    test("setBalance allows negative balance (for debt/adjustments)", async () => {
      const result = await credits.setBalance({
        userId: "user_1",
        key: "api_calls",
        balance: -100,
        reason: "Debt adjustment",
      });

      expect(result.balance).toBe(-100);
      expect(result.previousBalance).toBe(0);
    });
  });

  // =============================================================================
  // Idempotency Tests
  // =============================================================================

  describe("idempotency", () => {
    test("grant with same idempotency key throws on second call", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
        idempotencyKey: "grant_123",
      });

      let error: Error | null = null;
      try {
        await credits.grant({
          userId: "user_1",
          key: "api_calls",
          amount: 1000,
          source: "subscription",
          sourceId: "sub_123",
          idempotencyKey: "grant_123",
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect((error as CreditError).code).toBe("IDEMPOTENCY_CONFLICT");

      // Balance should only reflect first grant
      expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);
    });

    test("revoke with same idempotency key throws on second call", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });

      await credits.revoke({
        userId: "user_1",
        key: "api_calls",
        amount: 500,
        source: "cancellation",
        idempotencyKey: "revoke_123",
      });

      let error: Error | null = null;
      try {
        await credits.revoke({
          userId: "user_1",
          key: "api_calls",
          amount: 500,
          source: "cancellation",
          idempotencyKey: "revoke_123",
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect((error as CreditError).code).toBe("IDEMPOTENCY_CONFLICT");

      // Balance should only reflect first revoke
      expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(500);
    });

    test("setBalance with same idempotency key throws on second call", async () => {
      await credits.setBalance({
        userId: "user_1",
        key: "api_calls",
        balance: 1000,
        reason: "Admin set",
        idempotencyKey: "set_123",
      });

      let error: Error | null = null;
      try {
        await credits.setBalance({
          userId: "user_1",
          key: "api_calls",
          balance: 2000,
          reason: "Admin set again",
          idempotencyKey: "set_123",
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect((error as CreditError).code).toBe("IDEMPOTENCY_CONFLICT");

      // Balance should be from first call
      expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);
    });

    test("different idempotency keys allow multiple operations", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 100,
        source: "subscription",
        sourceId: "sub_123",
        idempotencyKey: "grant_a",
      });

      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 100,
        source: "subscription",
        sourceId: "sub_123",
        idempotencyKey: "grant_b",
      });

      expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(200);
    });
  });

  // =============================================================================
  // Concurrency Tests
  // =============================================================================

  describe("concurrency", () => {
    test("concurrent grants are all applied correctly", async () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          credits.grant({
            userId: "user_1",
            key: "api_calls",
            amount: 100,
            source: "subscription",
            sourceId: `sub_${i}`,
          })
        );
      }

      await Promise.all(promises);

      expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);
    });

    test("concurrent consumes respect balance", async () => {
      // Give user 500 credits
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 500,
        source: "subscription",
        sourceId: "sub_123",
      });

      // Try to consume 100 credits 10 times concurrently (total 1000)
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          credits.consume({
            userId: "user_1",
            key: "api_calls",
            amount: 100,
          })
        );
      }

      const results = await Promise.all(promises);

      // All 10 should succeed (balance can go negative)
      const successes = results.filter((r) => r.success).length;
      expect(successes).toBe(10);
      // Final balance: 500 - 1000 = -500
      expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(-500);
    });
  });

  // =============================================================================
  // Double-Entry Balance Reset Tests (atomicBalanceReset)
  // =============================================================================

  describe("atomicBalanceReset", () => {
    test("reset with positive balance: writes revoke then grant entries", async () => {
      // Setup: user has 300 credits
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 500,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.consume({
        userId: "user_1",
        key: "api_calls",
        amount: 200,
      });

      // Balance should be 300
      expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(300);

      // Reset to 1000
      const result = await credits.atomicBalanceReset("user_1", "api_calls", 1000, {
        source: "renewal",
        sourceId: "sub_123",
        expireDescription: "Monthly credits expired",
        grantDescription: "Monthly credits allocation",
      });

      // Check return values
      expect(result.previousBalance).toBe(300);
      expect(result.expired).toBe(300);
      expect(result.forgiven).toBe(0);

      // Check final balance
      expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);

      // Check ledger entries - should have 4 entries: grant, consume, revoke, grant
      const history = await credits.getHistory({ userId: "user_1", key: "api_calls" });
      expect(history.length).toBe(4);

      // Most recent first (newest = grant for new allocation)
      expect(history[0].transactionType).toBe("grant");
      expect(history[0].amount).toBe(1000);
      expect(history[0].balanceAfter).toBe(1000);
      expect(history[0].description).toBe("Monthly credits allocation");

      // Second most recent (revoke for expired balance)
      expect(history[1].transactionType).toBe("revoke");
      expect(history[1].amount).toBe(-300);
      expect(history[1].balanceAfter).toBe(0);
      expect(history[1].description).toBe("Monthly credits expired");
    });

    test("reset with negative balance: writes adjust then grant entries", async () => {
      // Setup: user has -200 credits (debt)
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 100,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.consume({
        userId: "user_1",
        key: "api_calls",
        amount: 300,
      });

      // Balance should be -200
      expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(-200);

      // Reset to 1000
      const result = await credits.atomicBalanceReset("user_1", "api_calls", 1000, {
        source: "renewal",
        sourceId: "sub_123",
        forgivenDescription: "Negative balance forgiven",
        grantDescription: "Monthly credits allocation",
      });

      // Check return values
      expect(result.previousBalance).toBe(-200);
      expect(result.expired).toBe(0);
      expect(result.forgiven).toBe(200);

      // Check final balance
      expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);

      // Check ledger entries
      const history = await credits.getHistory({ userId: "user_1", key: "api_calls" });
      expect(history.length).toBe(4);

      // Most recent = grant
      expect(history[0].transactionType).toBe("grant");
      expect(history[0].amount).toBe(1000);
      expect(history[0].balanceAfter).toBe(1000);

      // Second = adjust (forgiveness)
      expect(history[1].transactionType).toBe("adjust");
      expect(history[1].amount).toBe(200); // positive - adding to get to 0
      expect(history[1].balanceAfter).toBe(0);
      expect(history[1].description).toBe("Negative balance forgiven");
    });

    test("reset with zero balance: writes only grant entry", async () => {
      // Setup: user has 0 credits
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 100,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.consume({
        userId: "user_1",
        key: "api_calls",
        amount: 100,
      });

      // Balance should be 0
      expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(0);

      // Reset to 1000
      const result = await credits.atomicBalanceReset("user_1", "api_calls", 1000, {
        source: "renewal",
        sourceId: "sub_123",
        grantDescription: "Monthly credits allocation",
      });

      // Check return values
      expect(result.previousBalance).toBe(0);
      expect(result.expired).toBe(0);
      expect(result.forgiven).toBe(0);

      // Check final balance
      expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(1000);

      // Check ledger entries - only 3: original grant, consume, new grant (no revoke/adjust needed)
      const history = await credits.getHistory({ userId: "user_1", key: "api_calls" });
      expect(history.length).toBe(3);

      // Most recent = grant
      expect(history[0].transactionType).toBe("grant");
      expect(history[0].amount).toBe(1000);
    });

    test("reset with zero allocation: only expires/forgives, no grant", async () => {
      // Setup: user has 500 credits
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 500,
        source: "subscription",
        sourceId: "sub_123",
      });

      // Reset to 0 (cancellation scenario)
      const result = await credits.atomicBalanceReset("user_1", "api_calls", 0, {
        source: "cancellation",
        sourceId: "sub_123",
        expireDescription: "Credits revoked on cancellation",
      });

      // Check return values
      expect(result.previousBalance).toBe(500);
      expect(result.expired).toBe(500);
      expect(result.forgiven).toBe(0);

      // Check final balance
      expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(0);

      // Check ledger - only 2 entries: original grant, revoke (no new grant since allocation is 0)
      const history = await credits.getHistory({ userId: "user_1", key: "api_calls" });
      expect(history.length).toBe(2);

      expect(history[0].transactionType).toBe("revoke");
      expect(history[0].amount).toBe(-500);
      expect(history[0].balanceAfter).toBe(0);
    });

    test("ledger entries are in correct chronological order", async () => {
      // Setup: user has 100 credits
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 100,
        source: "subscription",
        sourceId: "sub_123",
      });

      // Reset to 500
      await credits.atomicBalanceReset("user_1", "api_calls", 500, {
        source: "renewal",
        sourceId: "sub_123",
      });

      const history = await credits.getHistory({ userId: "user_1", key: "api_calls" });

      // Verify order: grant (newest) -> revoke -> original grant (oldest)
      // When sorted by created_at DESC, the GRANT should come AFTER the REVOKE
      // because we write revoke first, then grant
      expect(history[0].transactionType).toBe("grant");
      expect(history[0].amount).toBe(500);
      expect(history[1].transactionType).toBe("revoke");
      expect(history[1].amount).toBe(-100);
      expect(history[2].transactionType).toBe("grant");
      expect(history[2].amount).toBe(100);

      // Array order verifies correct chronological order (ORDER BY created_at DESC)
    });

    test("idempotency prevents duplicate reset", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 100,
        source: "subscription",
        sourceId: "sub_123",
      });

      // First reset
      await credits.atomicBalanceReset("user_1", "api_calls", 500, {
        source: "renewal",
        sourceId: "sub_123",
        idempotencyKey: "renewal_123",
      });

      expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(500);

      // Second reset with same idempotency key should fail
      let error: Error | null = null;
      try {
        await credits.atomicBalanceReset("user_1", "api_calls", 1000, {
          source: "renewal",
          sourceId: "sub_123",
          idempotencyKey: "renewal_123",
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      // Balance should still be 500 from first reset
      expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(500);
    });
  });

  // =============================================================================
  // Data Integrity Tests
  // =============================================================================

  describe("data integrity", () => {
    test("revoke only takes from positive balance", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 100,
        source: "subscription",
        sourceId: "sub_123",
      });

      // Try to revoke more than available
      const result = await credits.revoke({
        userId: "user_1",
        key: "api_calls",
        amount: 500,
        source: "cancellation",
      });

      // Revoke is capped at current balance
      expect(result.amountRevoked).toBe(100);
      expect(result.balance).toBe(0);
      expect(await credits.getBalance({ userId: "user_1", key: "api_calls" })).toBe(0);
    });

    test("ledger entries sum to current balance", async () => {
      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });

      await credits.consume({
        userId: "user_1",
        key: "api_calls",
        amount: 300,
      });

      await credits.grant({
        userId: "user_1",
        key: "api_calls",
        amount: 200,
        source: "topup",
        sourceId: "topup_1",
      });

      await credits.revoke({
        userId: "user_1",
        key: "api_calls",
        amount: 100,
        source: "manual",
      });

      const history = await credits.getHistory({ userId: "user_1", key: "api_calls" });
      const ledgerSum = history.reduce((sum, tx) => sum + tx.amount, 0);
      const balance = await credits.getBalance({ userId: "user_1", key: "api_calls" });

      // 1000 - 300 + 200 - 100 = 800
      expect(ledgerSum).toBe(800);
      expect(balance).toBe(800);
    });
  });
});
