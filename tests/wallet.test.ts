import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { Pool } from "pg";
import { setupTestDb, cleanupTestData, teardownTestDb } from "./setup";
import { initCredits } from "../src/credits";
import {
  wallet,
  getBalance,
  add,
  consume,
  getHistory,
  centsToMicroCents,
  microCentsToCents,
  formatWalletBalance,
} from "../src/wallet";
import type { WalletBalance, WalletEvent } from "../src/wallet";
import { CreditError } from "../src/credits/types";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
  initCredits(pool, "stripe");
});

beforeEach(async () => {
  await cleanupTestData();
});

afterAll(async () => {
  await teardownTestDb();
});

describe("Wallet", () => {
  describe("add", () => {
    test("adds cents to wallet", async () => {
      const result = await wallet.add({
        userId: "user_1",
        cents: 1000,
        currency: "usd",
        source: "manual",
      });

      expect(result.balance.cents).toBe(1000);
      expect(result.balance.currency).toBe("usd");
      expect(result.balance.formatted).toBe("$10.00");
    });

    test("adds accumulate", async () => {
      await wallet.add({ userId: "user_1", cents: 500, currency: "usd" });
      const result = await wallet.add({ userId: "user_1", cents: 300, currency: "usd" });

      expect(result.balance.cents).toBe(800);
      expect(result.balance.formatted).toBe("$8.00");
    });

    test("throws on zero amount", async () => {
      let error: Error | null = null;
      try {
        await wallet.add({ userId: "user_1", cents: 0, currency: "usd" });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect(error).toBeInstanceOf(CreditError);
      expect((error as CreditError).code).toBe("INVALID_AMOUNT");
    });

    test("throws on negative amount", async () => {
      let error: Error | null = null;
      try {
        await wallet.add({ userId: "user_1", cents: -100, currency: "usd" });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect((error as CreditError).code).toBe("INVALID_AMOUNT");
    });

    test("throws on currency mismatch", async () => {
      await wallet.add({ userId: "user_1", cents: 100, currency: "usd" });

      let error: Error | null = null;
      try {
        await wallet.add({ userId: "user_1", cents: 100, currency: "eur" });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect((error as CreditError).code).toBe("CURRENCY_MISMATCH");
      expect((error as CreditError).details?.walletCurrency).toBe("usd");
      expect((error as CreditError).details?.requestedCurrency).toBe("eur");
    });

    test("defaults currency to usd", async () => {
      const result = await wallet.add({ userId: "user_1", cents: 100 });
      expect(result.balance.currency).toBe("usd");
    });
  });

  describe("consume", () => {
    test("consumes from wallet", async () => {
      await wallet.add({ userId: "user_1", cents: 1000, currency: "usd" });
      const result = await wallet.consume({ userId: "user_1", cents: 300 });

      expect(result.balance.cents).toBe(700);
      expect(result.balance.formatted).toBe("$7.00");
    });

    test("can consume entire balance", async () => {
      await wallet.add({ userId: "user_1", cents: 500, currency: "usd" });
      const result = await wallet.consume({ userId: "user_1", cents: 500 });

      expect(result.balance.cents).toBe(0);
    });

    test("allows negative balance", async () => {
      await wallet.add({ userId: "user_1", cents: 300, currency: "usd" });
      const result = await wallet.consume({ userId: "user_1", cents: 500 });

      expect(result.balance.cents).toBe(-200);
      expect(result.balance.formatted).toBe("-$2.00");
    });

    test("allows consume on empty wallet (creates negative balance)", async () => {
      const result = await wallet.consume({ userId: "user_1", cents: 100 });

      expect(result.balance.cents).toBe(-100);
      expect(result.balance.currency).toBe("usd");
    });

    test("throws on zero amount", async () => {
      let error: Error | null = null;
      try {
        await wallet.consume({ userId: "user_1", cents: 0 });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect((error as CreditError).code).toBe("INVALID_AMOUNT");
    });

    test("throws on negative amount", async () => {
      let error: Error | null = null;
      try {
        await wallet.consume({ userId: "user_1", cents: -50 });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect((error as CreditError).code).toBe("INVALID_AMOUNT");
    });
  });

  describe("getBalance", () => {
    test("returns null for unfunded wallet", async () => {
      const balance = await wallet.getBalance({ userId: "user_1" });
      expect(balance).toBeNull();
    });

    test("returns balance after add", async () => {
      await wallet.add({ userId: "user_1", cents: 847, currency: "usd" });
      const balance = await wallet.getBalance({ userId: "user_1" });

      expect(balance).not.toBeNull();
      expect(balance!.cents).toBe(847);
      expect(balance!.formatted).toBe("$8.47");
      expect(balance!.currency).toBe("usd");
    });

    test("returns negative balance", async () => {
      await wallet.add({ userId: "user_1", cents: 100, currency: "usd" });
      await wallet.consume({ userId: "user_1", cents: 300 });
      const balance = await wallet.getBalance({ userId: "user_1" });

      expect(balance).not.toBeNull();
      expect(balance!.cents).toBe(-200);
      expect(balance!.formatted).toBe("-$2.00");
    });

    test("returns zero balance (not null) after consuming all", async () => {
      await wallet.add({ userId: "user_1", cents: 100, currency: "usd" });
      await wallet.consume({ userId: "user_1", cents: 100 });
      const balance = await wallet.getBalance({ userId: "user_1" });

      expect(balance).not.toBeNull();
      expect(balance!.cents).toBe(0);
    });
  });

  describe("getHistory", () => {
    test("returns empty array for new user", async () => {
      const history = await wallet.getHistory({ userId: "user_1" });
      expect(history).toEqual([]);
    });

    test("records add transactions", async () => {
      await wallet.add({
        userId: "user_1",
        cents: 500,
        currency: "usd",
        description: "Top up",
      });

      const history = await wallet.getHistory({ userId: "user_1" });

      expect(history.length).toBe(1);
      expect(history[0].type).toBe("add");
      expect(history[0].cents).toBe(500);
      expect(history[0].balanceAfterCents).toBe(500);
      expect(history[0].description).toBe("Top up");
    });

    test("records consume transactions", async () => {
      await wallet.add({ userId: "user_1", cents: 1000, currency: "usd" });
      await wallet.consume({ userId: "user_1", cents: 300, description: "API usage" });

      const history = await wallet.getHistory({ userId: "user_1" });

      expect(history.length).toBe(2);
      expect(history[0].type).toBe("consume");
      expect(history[0].cents).toBe(-300);
      expect(history[0].balanceAfterCents).toBe(700);
      expect(history[0].description).toBe("API usage");
    });

    test("respects limit and offset", async () => {
      for (let i = 0; i < 5; i++) {
        await wallet.add({ userId: "user_1", cents: 100, currency: "usd" });
      }

      const page1 = await wallet.getHistory({ userId: "user_1", limit: 2 });
      const page2 = await wallet.getHistory({ userId: "user_1", limit: 2, offset: 2 });

      expect(page1.length).toBe(2);
      expect(page2.length).toBe(2);
    });
  });

  describe("idempotency", () => {
    test("add with same idempotency key throws on second call", async () => {
      await wallet.add({
        userId: "user_1",
        cents: 500,
        currency: "usd",
        idempotencyKey: "add_123",
      });

      let error: Error | null = null;
      try {
        await wallet.add({
          userId: "user_1",
          cents: 500,
          currency: "usd",
          idempotencyKey: "add_123",
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect((error as CreditError).code).toBe("IDEMPOTENCY_CONFLICT");

      const balance = await wallet.getBalance({ userId: "user_1" });
      expect(balance!.cents).toBe(500);
    });

    test("consume with same idempotency key throws on second call", async () => {
      await wallet.add({ userId: "user_1", cents: 1000, currency: "usd" });
      await wallet.consume({
        userId: "user_1",
        cents: 300,
        idempotencyKey: "consume_123",
      });

      let error: Error | null = null;
      try {
        await wallet.consume({
          userId: "user_1",
          cents: 300,
          idempotencyKey: "consume_123",
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
      expect((error as CreditError).code).toBe("IDEMPOTENCY_CONFLICT");

      const balance = await wallet.getBalance({ userId: "user_1" });
      expect(balance!.cents).toBe(700);
    });

    test("different idempotency keys allow multiple operations", async () => {
      await wallet.add({ userId: "user_1", cents: 100, idempotencyKey: "add_1" });
      await wallet.add({ userId: "user_1", cents: 100, idempotencyKey: "add_2" });

      const balance = await wallet.getBalance({ userId: "user_1" });
      expect(balance!.cents).toBe(200);
    });
  });

  describe("precision", () => {
    test("stores micro-cents internally", async () => {
      await wallet.add({ userId: "user_1", cents: 1, currency: "usd" });

      const result = await pool.query(
        "SELECT balance FROM stripe.credit_balances WHERE user_id = $1 AND key = $2",
        ["user_1", "wallet"]
      );

      // 1 cent = 1,000,000 micro-cents
      expect(Number(result.rows[0].balance)).toBe(1000000);
    });

    test("handles sub-cent precision in display", async () => {
      // 1,500,000 micro-cents = 1.5 cents = $0.015
      await pool.query(
        "INSERT INTO stripe.credit_balances (user_id, key, balance, currency) VALUES ($1, $2, $3, $4)",
        ["user_1", "wallet", 1500000, "usd"]
      );

      const balance = await wallet.getBalance({ userId: "user_1" });

      expect(balance!.cents).toBe(1.5);
      expect(balance!.formatted).toBe("$0.015");
    });
  });

  describe("currency formatting", () => {
    test("formats USD correctly", async () => {
      await wallet.add({ userId: "user_1", cents: 1234, currency: "usd" });
      const balance = await wallet.getBalance({ userId: "user_1" });
      expect(balance!.formatted).toBe("$12.34");
    });

    test("formats EUR correctly", async () => {
      await wallet.add({ userId: "user_1", cents: 1234, currency: "eur" });
      const balance = await wallet.getBalance({ userId: "user_1" });
      expect(balance!.formatted).toBe("\u20AC12.34");
    });

    test("formats GBP correctly", async () => {
      await wallet.add({ userId: "user_1", cents: 1234, currency: "gbp" });
      const balance = await wallet.getBalance({ userId: "user_1" });
      expect(balance!.formatted).toBe("\u00A312.34");
    });

    test("formats JPY (zero-decimal) correctly", async () => {
      await wallet.add({ userId: "user_1", cents: 1234, currency: "jpy" });
      const balance = await wallet.getBalance({ userId: "user_1" });
      expect(balance!.formatted).toBe("\u00A51234");
    });

    test("formats KRW (zero-decimal) correctly", async () => {
      await wallet.add({ userId: "user_1", cents: 5000, currency: "krw" });
      const balance = await wallet.getBalance({ userId: "user_1" });
      expect(balance!.formatted).toBe("\u20A95000");
    });

    test("formats unknown currency with code prefix", async () => {
      await wallet.add({ userId: "user_1", cents: 1234, currency: "abc" });
      const balance = await wallet.getBalance({ userId: "user_1" });
      expect(balance!.formatted).toBe("ABC 12.34");
    });

    test("formats negative amounts correctly", async () => {
      await wallet.add({ userId: "user_1", cents: 100, currency: "usd" });
      await wallet.consume({ userId: "user_1", cents: 300 });
      const balance = await wallet.getBalance({ userId: "user_1" });
      expect(balance!.formatted).toBe("-$2.00");
    });
  });

  describe("precision utilities", () => {
    test("centsToMicroCents converts correctly", () => {
      // 1 cent = 1,000,000 micro-cents
      expect(centsToMicroCents(1)).toBe(1000000);
      expect(centsToMicroCents(0.5)).toBe(500000);
      expect(centsToMicroCents(100)).toBe(100000000);
    });

    test("microCentsToCents converts correctly", () => {
      expect(microCentsToCents(1000000)).toBe(1);
      expect(microCentsToCents(500000)).toBe(0.5);
      expect(microCentsToCents(100000000)).toBe(100);
    });

    test("centsToMicroCents rounds to avoid floating point issues", () => {
      // 0.000001 cents = 1 micro-cent
      expect(centsToMicroCents(0.000001)).toBe(1);
      expect(centsToMicroCents(0.0000001)).toBe(0);
      expect(centsToMicroCents(0.0000005)).toBe(1);
    });

    test("formatWalletBalance handles various inputs", () => {
      // $100 = 10000 cents = 10,000,000,000 micro-cents
      expect(formatWalletBalance(10000000000, "usd")).toBe("$100.00");
      expect(formatWalletBalance(-5000000000, "usd")).toBe("-$50.00");
      expect(formatWalletBalance(0, "usd")).toBe("$0.00");
      // JPY: 100 yen = 100 cents = 100,000,000 micro-cents
      expect(formatWalletBalance(100000000, "jpy")).toBe("\u00A5100");
      expect(formatWalletBalance(-50000000, "jpy")).toBe("-\u00A550");
    });
  });

  describe("isolation", () => {
    test("different users have independent wallets", async () => {
      await wallet.add({ userId: "user_1", cents: 1000, currency: "usd" });
      await wallet.add({ userId: "user_2", cents: 500, currency: "usd" });

      const balance1 = await wallet.getBalance({ userId: "user_1" });
      const balance2 = await wallet.getBalance({ userId: "user_2" });

      expect(balance1!.cents).toBe(1000);
      expect(balance2!.cents).toBe(500);
    });

    test("wallet consume doesn't affect other user", async () => {
      await wallet.add({ userId: "user_1", cents: 1000, currency: "usd" });
      await wallet.add({ userId: "user_2", cents: 1000, currency: "usd" });
      await wallet.consume({ userId: "user_1", cents: 300 });

      const balance1 = await wallet.getBalance({ userId: "user_1" });
      const balance2 = await wallet.getBalance({ userId: "user_2" });

      expect(balance1!.cents).toBe(700);
      expect(balance2!.cents).toBe(1000);
    });
  });

  describe("concurrent operations", () => {
    test("handles concurrent adds correctly", async () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(wallet.add({
          userId: "user_1",
          cents: 100,
          currency: "usd",
          idempotencyKey: `concurrent_add_${i}`,
        }));
      }

      await Promise.all(promises);
      const balance = await wallet.getBalance({ userId: "user_1" });
      expect(balance!.cents).toBe(1000);
    });

    test("handles concurrent consumes correctly", async () => {
      await wallet.add({ userId: "user_1", cents: 1000, currency: "usd" });

      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(wallet.consume({
          userId: "user_1",
          cents: 100,
          idempotencyKey: `concurrent_consume_${i}`,
        }));
      }

      await Promise.all(promises);
      const balance = await wallet.getBalance({ userId: "user_1" });
      expect(balance!.cents).toBe(500);
    });
  });

  // =============================================================================
  // Double-Entry Balance Reset Tests (for wallet renewal with "reset" mode)
  // =============================================================================

  describe("double-entry balance reset", () => {
    // Note: atomicBalanceReset is used internally by lifecycle hooks for wallet renewal
    // We test it here using the credits module directly with wallet key

    test("reset with positive balance: writes revoke then grant entries in correct order", async () => {
      const { credits } = await import("../src/credits");

      // Setup: user has $3.50 in wallet (350 cents = 350,000,000 micro-cents)
      await wallet.add({ userId: "user_1", cents: 500, currency: "usd" });
      await wallet.consume({ userId: "user_1", cents: 150 });

      const balanceBefore = await wallet.getBalance({ userId: "user_1" });
      expect(balanceBefore!.cents).toBe(350);

      // Reset to $5.00 (500 cents = 500,000,000 micro-cents)
      const newAllocationMicroCents = 500 * 1000000;
      await credits.atomicBalanceReset("user_1", "wallet", newAllocationMicroCents, {
        source: "renewal",
        sourceId: "sub_123",
        currency: "usd",
        expireDescription: "Monthly wallet balance expired",
        grantDescription: "Monthly wallet allocation",
      });

      // Check final balance
      const balanceAfter = await wallet.getBalance({ userId: "user_1" });
      expect(balanceAfter!.cents).toBe(500);

      // Check ledger entries via wallet history
      const history = await wallet.getHistory({ userId: "user_1" });

      // Should have 4 entries: add, consume, revoke, grant
      expect(history.length).toBe(4);

      // Most recent first (newest = grant)
      expect(history[0].type).toBe("add"); // grant shows as "add" in wallet history
      expect(history[0].cents).toBe(500);
      expect(history[0].balanceAfterCents).toBe(500);
      expect(history[0].description).toBe("Monthly wallet allocation");

      // Second = revoke (expiring old balance)
      expect(history[1].type).toBe("revoke");
      expect(history[1].cents).toBe(-350);
      expect(history[1].balanceAfterCents).toBe(0);
      expect(history[1].description).toBe("Monthly wallet balance expired");

      // Array order verifies correct chronological order (ORDER BY created_at DESC)
    });

    test("reset with negative balance: writes adjust then grant entries", async () => {
      const { credits } = await import("../src/credits");

      // Setup: user has -$2.00 in wallet (debt)
      await wallet.add({ userId: "user_1", cents: 100, currency: "usd" });
      await wallet.consume({ userId: "user_1", cents: 300 });

      const balanceBefore = await wallet.getBalance({ userId: "user_1" });
      expect(balanceBefore!.cents).toBe(-200);

      // Reset to $5.00
      const newAllocationMicroCents = 500 * 1000000;
      await credits.atomicBalanceReset("user_1", "wallet", newAllocationMicroCents, {
        source: "renewal",
        sourceId: "sub_123",
        currency: "usd",
        forgivenDescription: "Negative balance forgiven",
        grantDescription: "Monthly wallet allocation",
      });

      // Check final balance
      const balanceAfter = await wallet.getBalance({ userId: "user_1" });
      expect(balanceAfter!.cents).toBe(500);

      // Check ledger entries
      const history = await wallet.getHistory({ userId: "user_1" });
      expect(history.length).toBe(4);

      // Most recent = grant
      expect(history[0].type).toBe("add");
      expect(history[0].cents).toBe(500);

      // Second = adjust (forgiveness - positive amount to get to 0)
      expect(history[1].type).toBe("adjust");
      expect(history[1].cents).toBe(200);
      expect(history[1].balanceAfterCents).toBe(0);
      expect(history[1].description).toBe("Negative balance forgiven");
    });

    test("reset with zero balance: only writes grant entry", async () => {
      const { credits } = await import("../src/credits");

      // Setup: user has $0.00 in wallet
      await wallet.add({ userId: "user_1", cents: 100, currency: "usd" });
      await wallet.consume({ userId: "user_1", cents: 100 });

      const balanceBefore = await wallet.getBalance({ userId: "user_1" });
      expect(balanceBefore!.cents).toBe(0);

      // Reset to $5.00
      const newAllocationMicroCents = 500 * 1000000;
      await credits.atomicBalanceReset("user_1", "wallet", newAllocationMicroCents, {
        source: "renewal",
        sourceId: "sub_123",
        currency: "usd",
        grantDescription: "Monthly wallet allocation",
      });

      // Check final balance
      const balanceAfter = await wallet.getBalance({ userId: "user_1" });
      expect(balanceAfter!.cents).toBe(500);

      // Check ledger entries - only 3: original add, consume, new grant (no revoke needed)
      const history = await wallet.getHistory({ userId: "user_1" });
      expect(history.length).toBe(3);

      expect(history[0].type).toBe("add");
      expect(history[0].cents).toBe(500);
    });

    test("reset to zero allocation: only expires, no grant", async () => {
      const { credits } = await import("../src/credits");

      // Setup: user has $3.00 in wallet
      await wallet.add({ userId: "user_1", cents: 300, currency: "usd" });

      // Reset to $0 (cancellation)
      await credits.atomicBalanceReset("user_1", "wallet", 0, {
        source: "cancellation",
        sourceId: "sub_123",
        currency: "usd",
        expireDescription: "Wallet revoked on cancellation",
      });

      // Check final balance
      const balanceAfter = await wallet.getBalance({ userId: "user_1" });
      expect(balanceAfter!.cents).toBe(0);

      // Check ledger - only 2 entries: original add, revoke (no new grant)
      const history = await wallet.getHistory({ userId: "user_1" });
      expect(history.length).toBe(2);

      expect(history[0].type).toBe("revoke");
      expect(history[0].cents).toBe(-300);
      expect(history[0].balanceAfterCents).toBe(0);
    });
  });

  describe("namespace export", () => {
    test("wallet object exports all functions", () => {
      expect(typeof wallet.getBalance).toBe("function");
      expect(typeof wallet.add).toBe("function");
      expect(typeof wallet.consume).toBe("function");
      expect(typeof wallet.getHistory).toBe("function");
    });

    test("individual exports work", async () => {
      await add({ userId: "user_1", cents: 100, currency: "usd" });
      const balance = await getBalance({ userId: "user_1" });
      expect(balance!.cents).toBe(100);

      await consume({ userId: "user_1", cents: 50 });
      const history = await getHistory({ userId: "user_1" });
      expect(history.length).toBe(2);
    });
  });
});
