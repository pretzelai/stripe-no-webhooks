import { describe, it, expect } from "bun:test";
import type { Plan, FeatureConfig } from "../src/BillingConfig";

/**
 * These tests verify the pricing display logic used in PricingPage.tsx.
 * We extract and test the pure functions here since they don't require React.
 */

// Extracted from PricingPage.tsx for testing
type NormalizedFeature = {
  allocation?: number;
  displayName?: string;
  onRenewal?: "reset" | "add";
  pricePerCredit?: number;
  trackUsage?: boolean;
};

function getPlanFeatures(plan: Plan): Record<string, NormalizedFeature> {
  if (!plan.features) return {};

  const features: Record<string, NormalizedFeature> = {};
  for (const [key, config] of Object.entries(plan.features)) {
    const hasCredits = config.credits?.allocation !== undefined;
    const hasUsagePricing = config.trackUsage && config.pricePerCredit !== undefined;

    if (hasCredits || hasUsagePricing) {
      features[key] = {
        allocation: config.credits?.allocation,
        displayName: config.displayName,
        onRenewal: config.credits?.onRenewal,
        pricePerCredit: config.pricePerCredit,
        trackUsage: config.trackUsage,
      };
    }
  }
  return features;
}

function getScaledAllocation(allocation: number, interval: "month" | "year" | "week"): number {
  if (interval === "year") return allocation * 12;
  if (interval === "week") return Math.ceil(allocation / 4);
  return allocation;
}

function formatUsagePrice(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents < 100 ? 2 : 0,
    maximumFractionDigits: cents < 100 ? 4 : 2,
  }).format(cents / 100);
}

function buildFeatureDisplayText(
  config: NormalizedFeature,
  featureName: string,
  interval: "month" | "year",
  currency: string
): string {
  const intervalLabel = interval === "year" ? "year" : "month";
  const hasCredits = config.allocation !== undefined;
  const hasUsage = config.trackUsage && config.pricePerCredit !== undefined;

  if (hasCredits && hasUsage) {
    const scaledAllocation = getScaledAllocation(config.allocation!, interval);
    const usagePrice = formatUsagePrice(config.pricePerCredit!, currency);
    return `${scaledAllocation.toLocaleString()} ${featureName}/${intervalLabel}, then ${usagePrice} each`;
  } else if (hasCredits) {
    const scaledAllocation = getScaledAllocation(config.allocation!, interval);
    return `${scaledAllocation.toLocaleString()} ${featureName}${config.onRenewal === "add" ? " (accumulates)" : `/${intervalLabel}`}`;
  } else {
    const usagePrice = formatUsagePrice(config.pricePerCredit!, currency);
    return `${featureName} at ${usagePrice} each`;
  }
}

describe("Pricing Display Logic", () => {
  describe("getPlanFeatures()", () => {
    it("extracts features with credit allocations", () => {
      const plan: Plan = {
        name: "Pro",
        price: [{ amount: 2000, currency: "usd", interval: "month" }],
        features: {
          api_calls: {
            displayName: "API Calls",
            credits: { allocation: 1000 },
          },
        },
      };

      const features = getPlanFeatures(plan);
      expect(features.api_calls).toBeDefined();
      expect(features.api_calls.allocation).toBe(1000);
      expect(features.api_calls.displayName).toBe("API Calls");
    });

    it("extracts features with usage pricing", () => {
      const plan: Plan = {
        name: "Pay As You Go",
        price: [{ amount: 0, currency: "usd", interval: "month" }],
        features: {
          compute: {
            displayName: "Compute Hours",
            pricePerCredit: 10,
            trackUsage: true,
          },
        },
      };

      const features = getPlanFeatures(plan);
      expect(features.compute).toBeDefined();
      expect(features.compute.pricePerCredit).toBe(10);
      expect(features.compute.trackUsage).toBe(true);
      expect(features.compute.allocation).toBeUndefined();
    });

    it("extracts hybrid features (credits + usage)", () => {
      const plan: Plan = {
        name: "Pro",
        price: [{ amount: 2000, currency: "usd", interval: "month" }],
        features: {
          storage: {
            displayName: "Storage GB",
            credits: { allocation: 50 },
            pricePerCredit: 5,
            trackUsage: true,
          },
        },
      };

      const features = getPlanFeatures(plan);
      expect(features.storage).toBeDefined();
      expect(features.storage.allocation).toBe(50);
      expect(features.storage.pricePerCredit).toBe(5);
      expect(features.storage.trackUsage).toBe(true);
    });

    it("ignores features with only pricePerCredit (no trackUsage)", () => {
      const plan: Plan = {
        name: "Pro",
        price: [{ amount: 2000, currency: "usd", interval: "month" }],
        features: {
          api_calls: {
            displayName: "API Calls",
            pricePerCredit: 2, // Only enables top-ups, not usage display
          },
        },
      };

      const features = getPlanFeatures(plan);
      expect(features.api_calls).toBeUndefined();
    });

    it("returns empty object for plan without features", () => {
      const plan: Plan = {
        name: "Free",
        price: [{ amount: 0, currency: "usd", interval: "month" }],
      };

      const features = getPlanFeatures(plan);
      expect(Object.keys(features).length).toBe(0);
    });

    it("extracts multiple features", () => {
      const plan: Plan = {
        name: "Enterprise",
        price: [{ amount: 10000, currency: "usd", interval: "month" }],
        features: {
          api_calls: {
            displayName: "API Calls",
            credits: { allocation: 10000 },
          },
          compute: {
            displayName: "Compute Hours",
            pricePerCredit: 50,
            trackUsage: true,
          },
          storage: {
            displayName: "Storage GB",
            credits: { allocation: 100 },
            pricePerCredit: 10,
            trackUsage: true,
          },
        },
      };

      const features = getPlanFeatures(plan);
      expect(Object.keys(features).length).toBe(3);
      expect(features.api_calls.allocation).toBe(10000);
      expect(features.compute.pricePerCredit).toBe(50);
      expect(features.storage.allocation).toBe(100);
    });
  });

  describe("getScaledAllocation()", () => {
    it("returns monthly allocation unchanged", () => {
      expect(getScaledAllocation(1000, "month")).toBe(1000);
    });

    it("multiplies by 12 for yearly", () => {
      expect(getScaledAllocation(1000, "year")).toBe(12000);
    });

    it("divides by 4 (rounded up) for weekly", () => {
      expect(getScaledAllocation(1000, "week")).toBe(250);
      expect(getScaledAllocation(100, "week")).toBe(25);
      expect(getScaledAllocation(10, "week")).toBe(3); // ceil(10/4) = 3
    });
  });

  describe("formatUsagePrice()", () => {
    it("formats cents correctly", () => {
      expect(formatUsagePrice(2, "usd")).toBe("$0.02");
      expect(formatUsagePrice(10, "usd")).toBe("$0.10");
      expect(formatUsagePrice(50, "usd")).toBe("$0.50");
    });

    it("formats dollars correctly", () => {
      expect(formatUsagePrice(100, "usd")).toBe("$1");
      expect(formatUsagePrice(500, "usd")).toBe("$5");
      expect(formatUsagePrice(1000, "usd")).toBe("$10");
    });

    it("handles fractional cents", () => {
      expect(formatUsagePrice(0.5, "usd")).toBe("$0.005");
      expect(formatUsagePrice(1.5, "usd")).toBe("$0.015");
    });

    it("handles different currencies", () => {
      expect(formatUsagePrice(100, "eur")).toBe("€1");
      expect(formatUsagePrice(100, "gbp")).toBe("£1");
    });
  });

  describe("buildFeatureDisplayText()", () => {
    describe("Credits Only", () => {
      it("shows allocation with interval", () => {
        const config: NormalizedFeature = {
          allocation: 1000,
          displayName: "API Calls",
        };
        const text = buildFeatureDisplayText(config, "API Calls", "month", "usd");
        expect(text).toBe("1,000 API Calls/month");
      });

      it("shows yearly allocation scaled", () => {
        const config: NormalizedFeature = {
          allocation: 1000,
          displayName: "API Calls",
        };
        const text = buildFeatureDisplayText(config, "API Calls", "year", "usd");
        expect(text).toBe("12,000 API Calls/year");
      });

      it("shows accumulates for onRenewal=add", () => {
        const config: NormalizedFeature = {
          allocation: 1000,
          displayName: "API Calls",
          onRenewal: "add",
        };
        const text = buildFeatureDisplayText(config, "API Calls", "month", "usd");
        expect(text).toBe("1,000 API Calls (accumulates)");
      });
    });

    describe("Usage Only", () => {
      it("shows price per unit", () => {
        const config: NormalizedFeature = {
          pricePerCredit: 2,
          trackUsage: true,
        };
        const text = buildFeatureDisplayText(config, "API Calls", "month", "usd");
        expect(text).toBe("API Calls at $0.02 each");
      });

      it("shows higher price per unit", () => {
        const config: NormalizedFeature = {
          pricePerCredit: 100,
          trackUsage: true,
        };
        const text = buildFeatureDisplayText(config, "Compute Hours", "month", "usd");
        expect(text).toBe("Compute Hours at $1 each");
      });
    });

    describe("Credits + Usage (Hybrid)", () => {
      it("shows allocation then usage price", () => {
        const config: NormalizedFeature = {
          allocation: 1000,
          pricePerCredit: 2,
          trackUsage: true,
        };
        const text = buildFeatureDisplayText(config, "API Calls", "month", "usd");
        expect(text).toBe("1,000 API Calls/month, then $0.02 each");
      });

      it("scales allocation for yearly", () => {
        const config: NormalizedFeature = {
          allocation: 100,
          pricePerCredit: 10,
          trackUsage: true,
        };
        const text = buildFeatureDisplayText(config, "Storage GB", "year", "usd");
        expect(text).toBe("1,200 Storage GB/year, then $0.10 each");
      });
    });
  });

  describe("Real-world Config Examples", () => {
    it("handles pure pay-as-you-go plan", () => {
      const plan: Plan = {
        name: "Pay As You Go",
        price: [{ amount: 0, currency: "usd", interval: "month" }],
        features: {
          api_calls: {
            displayName: "API Calls",
            pricePerCredit: 1,
            trackUsage: true,
          },
        },
      };

      const features = getPlanFeatures(plan);
      const text = buildFeatureDisplayText(
        features.api_calls,
        features.api_calls.displayName || "api_calls",
        "month",
        "usd"
      );
      expect(text).toBe("API Calls at $0.01 each");
    });

    it("handles pro plan with included credits + overage", () => {
      const plan: Plan = {
        name: "Pro",
        price: [{ amount: 2000, currency: "usd", interval: "month" }],
        features: {
          api_calls: {
            displayName: "API Calls",
            credits: { allocation: 10000 },
            pricePerCredit: 1,
            trackUsage: true,
          },
        },
      };

      const features = getPlanFeatures(plan);
      const text = buildFeatureDisplayText(
        features.api_calls,
        features.api_calls.displayName || "api_calls",
        "month",
        "usd"
      );
      expect(text).toBe("10,000 API Calls/month, then $0.01 each");
    });

    it("handles enterprise with accumulating credits", () => {
      const plan: Plan = {
        name: "Enterprise",
        price: [{ amount: 50000, currency: "usd", interval: "month" }],
        features: {
          api_calls: {
            displayName: "API Calls",
            credits: { allocation: 100000, onRenewal: "add" },
          },
        },
      };

      const features = getPlanFeatures(plan);
      const text = buildFeatureDisplayText(
        features.api_calls,
        features.api_calls.displayName || "api_calls",
        "month",
        "usd"
      );
      expect(text).toBe("100,000 API Calls (accumulates)");
    });

    it("handles multiple feature types in one plan", () => {
      const plan: Plan = {
        name: "Pro Plus",
        price: [
          { amount: 4900, currency: "usd", interval: "month" },
          { amount: 49000, currency: "usd", interval: "year" },
        ],
        features: {
          api_calls: {
            displayName: "API Calls",
            credits: { allocation: 5000 },
          },
          compute_hours: {
            displayName: "Compute Hours",
            pricePerCredit: 100,
            trackUsage: true,
          },
          storage_gb: {
            displayName: "Storage",
            credits: { allocation: 10 },
            pricePerCredit: 50,
            trackUsage: true,
          },
        },
      };

      const features = getPlanFeatures(plan);

      // Credits only
      const apiText = buildFeatureDisplayText(
        features.api_calls,
        "API Calls",
        "month",
        "usd"
      );
      expect(apiText).toBe("5,000 API Calls/month");

      // Usage only
      const computeText = buildFeatureDisplayText(
        features.compute_hours,
        "Compute Hours",
        "month",
        "usd"
      );
      expect(computeText).toBe("Compute Hours at $1 each");

      // Hybrid
      const storageText = buildFeatureDisplayText(
        features.storage_gb,
        "Storage",
        "month",
        "usd"
      );
      expect(storageText).toBe("10 Storage/month, then $0.50 each");
    });
  });
});
