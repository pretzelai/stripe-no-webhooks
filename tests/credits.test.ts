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
        creditType: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });

      const balance = await credits.getBalance("user_1", "api_calls");
      expect(balance).toBe(1000);
    });

    test("grants credits accumulate", async () => {
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 500,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 300,
        source: "topup",
        sourceId: "topup_1",
      });

      const balance = await credits.getBalance("user_1", "api_calls");
      expect(balance).toBe(800);
    });

    test("grants different credit types independently", async () => {
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.grant({
        userId: "user_1",
        creditType: "storage_gb",
        amount: 50,
        source: "subscription",
        sourceId: "sub_123",
      });

      const apiBalance = await credits.getBalance("user_1", "api_calls");
      const storageBalance = await credits.getBalance("user_1", "storage_gb");

      expect(apiBalance).toBe(1000);
      expect(storageBalance).toBe(50);
    });
  });

  describe("consume", () => {
    test("consumes credits when balance is sufficient", async () => {
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });

      const result = await credits.consume({
        userId: "user_1",
        creditType: "api_calls",
        amount: 100,
        description: "API request",
      });

      expect(result.success).toBe(true);
      expect(result.balance).toBe(900);
    });

    test("fails to consume when balance is insufficient", async () => {
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 50,
        source: "subscription",
        sourceId: "sub_123",
      });

      const result = await credits.consume({
        userId: "user_1",
        creditType: "api_calls",
        amount: 100,
        description: "API request",
      });

      expect(result.success).toBe(false);
      expect(result.balance).toBe(50); // Balance unchanged
    });

    test("consumes exact balance successfully", async () => {
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 100,
        source: "subscription",
        sourceId: "sub_123",
      });

      const result = await credits.consume({
        userId: "user_1",
        creditType: "api_calls",
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
        creditType: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });

      const result = await credits.revoke({
        userId: "user_1",
        creditType: "api_calls",
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
        creditType: "api_calls",
        amount: 100,
        source: "subscription",
        sourceId: "sub_123",
      });

      const result = await credits.revoke({
        userId: "user_1",
        creditType: "api_calls",
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
        creditType: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 200,
        source: "topup",
        sourceId: "topup_1",
      });

      // Revoke all credits
      await credits.revokeAll({
        userId: "user_1",
        creditType: "api_calls",
        source: "cancellation",
        sourceId: "sub_123",
      });

      // Should have 0 balance
      const balance = await credits.getBalance("user_1", "api_calls");
      expect(balance).toBe(0);
    });
  });

  describe("setBalance", () => {
    test("sets balance to specific value", async () => {
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 500,
        source: "subscription",
        sourceId: "sub_123",
      });

      await credits.setBalance({
        userId: "user_1",
        creditType: "api_calls",
        balance: 1000,
        reason: "Admin adjustment",
      });

      const balance = await credits.getBalance("user_1", "api_calls");
      expect(balance).toBe(1000);
    });

    test("sets balance from zero", async () => {
      await credits.setBalance({
        userId: "user_1",
        creditType: "api_calls",
        balance: 500,
        reason: "Initial grant",
      });

      const balance = await credits.getBalance("user_1", "api_calls");
      expect(balance).toBe(500);
    });
  });

  describe("getBalance / getAllBalances / hasCredits", () => {
    test("getBalance returns 0 for non-existent user", async () => {
      const balance = await credits.getBalance("nonexistent", "api_calls");
      expect(balance).toBe(0);
    });

    test("getAllBalances returns all credit types", async () => {
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.grant({
        userId: "user_1",
        creditType: "storage_gb",
        amount: 50,
        source: "subscription",
        sourceId: "sub_123",
      });

      const balances = await credits.getAllBalances("user_1");
      expect(balances).toEqual({
        api_calls: 1000,
        storage_gb: 50,
      });
    });

    test("hasCredits returns true when sufficient", async () => {
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 100,
        source: "subscription",
        sourceId: "sub_123",
      });

      const has = await credits.hasCredits("user_1", "api_calls", 50);
      expect(has).toBe(true);
    });

    test("hasCredits returns false when insufficient", async () => {
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 10,
        source: "subscription",
        sourceId: "sub_123",
      });

      const has = await credits.hasCredits("user_1", "api_calls", 50);
      expect(has).toBe(false);
    });
  });

  describe("getHistory", () => {
    test("returns transaction history in reverse chronological order", async () => {
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.consume({
        userId: "user_1",
        creditType: "api_calls",
        amount: 100,
        description: "First request",
      });
      await credits.consume({
        userId: "user_1",
        creditType: "api_calls",
        amount: 50,
        description: "Second request",
      });

      const history = await credits.getHistory("user_1", { creditType: "api_calls" });

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
        creditType: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.grant({
        userId: "user_1",
        creditType: "storage_gb",
        amount: 50,
        source: "subscription",
        sourceId: "sub_123",
      });

      const apiHistory = await credits.getHistory("user_1", { creditType: "api_calls" });
      const storageHistory = await credits.getHistory("user_1", { creditType: "storage_gb" });

      expect(apiHistory.length).toBe(1);
      expect(storageHistory.length).toBe(1);
    });

    test("returns all credit types when not filtered", async () => {
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });
      await credits.grant({
        userId: "user_1",
        creditType: "storage_gb",
        amount: 50,
        source: "subscription",
        sourceId: "sub_123",
      });

      const allHistory = await credits.getHistory("user_1");
      expect(allHistory.length).toBe(2);
    });

    test("respects limit and offset", async () => {
      // Create 5 transactions
      for (let i = 0; i < 5; i++) {
        await credits.grant({
          userId: "user_1",
          creditType: "api_calls",
          amount: 100,
          source: "subscription",
          sourceId: `sub_${i}`,
        });
      }

      const page1 = await credits.getHistory("user_1", { limit: 2 });
      const page2 = await credits.getHistory("user_1", { limit: 2, offset: 2 });

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
          creditType: "api_calls",
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
          creditType: "api_calls",
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
          creditType: "api_calls",
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
          creditType: "api_calls",
          amount: -50,
          source: "cancellation",
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect((error as CreditError).code).toBe("INVALID_AMOUNT");
    });

    test("setBalance throws on negative balance", async () => {
      let error: Error | null = null;
      try {
        await credits.setBalance({
          userId: "user_1",
          creditType: "api_calls",
          balance: -100,
          reason: "Invalid",
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect((error as CreditError).code).toBe("INVALID_AMOUNT");
    });
  });

  // =============================================================================
  // Idempotency Tests
  // =============================================================================

  describe("idempotency", () => {
    test("grant with same idempotency key throws on second call", async () => {
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
        idempotencyKey: "grant_123",
      });

      let error: Error | null = null;
      try {
        await credits.grant({
          userId: "user_1",
          creditType: "api_calls",
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
      expect(await credits.getBalance("user_1", "api_calls")).toBe(1000);
    });

    test("revoke with same idempotency key throws on second call", async () => {
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });

      await credits.revoke({
        userId: "user_1",
        creditType: "api_calls",
        amount: 500,
        source: "cancellation",
        idempotencyKey: "revoke_123",
      });

      let error: Error | null = null;
      try {
        await credits.revoke({
          userId: "user_1",
          creditType: "api_calls",
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
      expect(await credits.getBalance("user_1", "api_calls")).toBe(500);
    });

    test("setBalance with same idempotency key throws on second call", async () => {
      await credits.setBalance({
        userId: "user_1",
        creditType: "api_calls",
        balance: 1000,
        reason: "Admin set",
        idempotencyKey: "set_123",
      });

      let error: Error | null = null;
      try {
        await credits.setBalance({
          userId: "user_1",
          creditType: "api_calls",
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
      expect(await credits.getBalance("user_1", "api_calls")).toBe(1000);
    });

    test("different idempotency keys allow multiple operations", async () => {
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 100,
        source: "subscription",
        sourceId: "sub_123",
        idempotencyKey: "grant_a",
      });

      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 100,
        source: "subscription",
        sourceId: "sub_123",
        idempotencyKey: "grant_b",
      });

      expect(await credits.getBalance("user_1", "api_calls")).toBe(200);
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
            creditType: "api_calls",
            amount: 100,
            source: "subscription",
            sourceId: `sub_${i}`,
          })
        );
      }

      await Promise.all(promises);

      expect(await credits.getBalance("user_1", "api_calls")).toBe(1000);
    });

    test("concurrent consumes respect balance", async () => {
      // Give user 500 credits
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
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
            creditType: "api_calls",
            amount: 100,
          })
        );
      }

      const results = await Promise.all(promises);

      // Only 5 should succeed (500 / 100 = 5)
      const successes = results.filter((r) => r.success).length;
      const failures = results.filter((r) => !r.success).length;

      expect(successes).toBe(5);
      expect(failures).toBe(5);
      expect(await credits.getBalance("user_1", "api_calls")).toBe(0);
    });
  });

  // =============================================================================
  // Data Integrity Tests
  // =============================================================================

  describe("data integrity", () => {
    test("balance never goes negative", async () => {
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 100,
        source: "subscription",
        sourceId: "sub_123",
      });

      // Try to revoke more than available
      const result = await credits.revoke({
        userId: "user_1",
        creditType: "api_calls",
        amount: 500,
        source: "cancellation",
      });

      expect(result.amountRevoked).toBe(100);
      expect(result.balance).toBe(0);
      expect(await credits.getBalance("user_1", "api_calls")).toBe(0);
    });

    test("ledger entries sum to current balance", async () => {
      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 1000,
        source: "subscription",
        sourceId: "sub_123",
      });

      await credits.consume({
        userId: "user_1",
        creditType: "api_calls",
        amount: 300,
      });

      await credits.grant({
        userId: "user_1",
        creditType: "api_calls",
        amount: 200,
        source: "topup",
        sourceId: "topup_1",
      });

      await credits.revoke({
        userId: "user_1",
        creditType: "api_calls",
        amount: 100,
        source: "manual",
      });

      const history = await credits.getHistory("user_1", { creditType: "api_calls" });
      const ledgerSum = history.reduce((sum, tx) => sum + tx.amount, 0);
      const balance = await credits.getBalance("user_1", "api_calls");

      // 1000 - 300 + 200 - 100 = 800
      expect(ledgerSum).toBe(800);
      expect(balance).toBe(800);
    });
  });
});
