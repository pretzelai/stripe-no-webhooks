"use client";

/**
 * PricingPage - Auto-fetching pricing component
 *
 * This component fetches plans from your billing.config.ts and renders them.
 * Customize plans in billing.config.ts:
 *
 * @example
 * // billing.config.ts
 * {
 *   name: "Pro",
 *   description: "For growing teams",
 *   price: [{ amount: 2000, currency: "usd", interval: "month" }],
 *
 *   // Billing features with credits, top-ups, and/or usage tracking
 *   features: {
 *     api_calls: {
 *       displayName: "API Calls",
 *       credits: { allocation: 1000 },  // Shows "1,000 API Calls/month"
 *     },
 *     compute: {
 *       displayName: "Compute Hours",
 *       pricePerCredit: 10,  // Shows "Compute Hours at $0.10 each"
 *       trackUsage: true,
 *     },
 *     storage: {
 *       displayName: "Storage GB",
 *       credits: { allocation: 50 },
 *       pricePerCredit: 5,   // Shows "50 Storage GB/month, then $0.05 each"
 *       trackUsage: true,
 *     }
 *   },
 *
 *   // Custom highlights (just text, no tracking)
 *   highlights: [
 *     "Priority support",
 *     "Custom integrations",
 *     "Unlimited exports"
 *   ]
 * }
 *
 * To customize styling, edit the CSS variables in the `styles` const at the bottom.
 */

import { useState, useMemo, useEffect } from "react";
import { createCheckoutClient } from "stripe-no-webhooks/client";
import type { Plan, PriceInterval } from "stripe-no-webhooks";

interface SubscriptionInfo {
  planId: string;
  planName: string;
  interval: PriceInterval;
  status: string;
}

interface PricingPageProps {
  /** Override auto-detected current plan */
  currentPlanId?: string;
  /** Override auto-detected interval */
  currentInterval?: PriceInterval;
  /** Error callback */
  onError?: (error: Error) => void;
  /** Countdown duration in seconds before redirecting after plan switch (default: 5) */
  redirectCountdown?: number;
  /** Custom billing endpoint (default: "/api/stripe/billing") */
  endpoint?: string;
}

const getPlanId = (plan: Plan) =>
  plan.id || plan.name.toLowerCase().replace(/\s+/g, "-");

const getPrice = (plan: Plan, interval: PriceInterval) => {
  if (!plan.price || plan.price.length === 0) return null;
  // Only return exact match - don't fallback
  return plan.price.find((p) => p.interval === interval) ?? null;
};

// Get the intervals a plan supports (excluding one_time)
const getPlanIntervals = (plan: Plan): Set<PriceInterval> => {
  const intervals = new Set<PriceInterval>();
  for (const price of plan.price || []) {
    if (price.interval !== "one_time") {
      intervals.add(price.interval);
    }
  }
  return intervals;
};

// Calculate yearly discount percentage for a plan
const getYearlyDiscount = (plan: Plan): number => {
  const monthly = plan.price?.find((p) => p.interval === "month");
  const yearly = plan.price?.find((p) => p.interval === "year");
  if (!monthly || !yearly || monthly.amount === 0) return 0;
  return Math.round((1 - yearly.amount / (monthly.amount * 12)) * 100);
};

// Normalized feature type for rendering
type NormalizedFeature = {
  allocation?: number;
  displayName?: string;
  onRenewal?: "reset" | "add";
  /** Price per unit in cents (for usage-based billing) */
  pricePerCredit?: number;
  /** Whether usage tracking is enabled */
  trackUsage?: boolean;
};

// Get features from plan that have credit allocations or usage pricing
const getPlanFeatures = (plan: Plan): Record<string, NormalizedFeature> => {
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
};

// Get credit allocation scaled for the interval
// Base allocation is assumed to be monthly:
// - Yearly: 12× monthly
// - Weekly: monthly ÷ 4 (rounded up)
const getScaledAllocation = (allocation: number, interval: PriceInterval): number => {
  if (interval === "year") return allocation * 12;
  if (interval === "week") return Math.ceil(allocation / 4);
  return allocation;
};

function LoadingSkeleton() {
  return (
    <div className="snw-pricing-container">
      <div className="snw-pricing-header">
        <div className="snw-skeleton snw-skeleton-title" />
        <div className="snw-skeleton snw-skeleton-subtitle" />
      </div>
      <div className="snw-pricing-grid">
        {[1, 2, 3].map((i) => (
          <div key={i} className="snw-pricing-card">
            <div className="snw-skeleton snw-skeleton-plan-name" />
            <div className="snw-skeleton snw-skeleton-price" />
            <div className="snw-skeleton snw-skeleton-features" />
            <div className="snw-skeleton snw-skeleton-btn" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="snw-pricing-container">
      <div className="snw-error-state">
        <p className="snw-error-message">{message}</p>
        <button className="snw-plan-btn primary" onClick={onRetry}>
          Try Again
        </button>
      </div>
    </div>
  );
}

export function PricingPage({
  currentPlanId: currentPlanIdProp,
  currentInterval: currentIntervalProp,
  onError,
  redirectCountdown = 5,
  endpoint = "/api/stripe/billing",
}: PricingPageProps) {
  // Data fetching state
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // UI state
  const [loadingPlanId, setLoadingPlanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interval, setInterval] = useState<PriceInterval>(currentIntervalProp || "month");
  const [countdown, setCountdown] = useState<number | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);

  // Fetch billing data on mount
  const fetchBilling = async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        throw new Error("Failed to fetch billing data");
      }
      const data = await res.json();
      setPlans(data.plans || []);
      setSubscription(data.subscription);
      // Update interval from subscription if not overridden by prop
      if (data.subscription?.interval && !currentIntervalProp) {
        setInterval(data.subscription.interval);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      setFetchError(errorMessage);
      onError?.(err instanceof Error ? err : new Error(errorMessage));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBilling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  // Use prop override or auto-detected value
  const currentPlanId = currentPlanIdProp ?? subscription?.planId;

  // Handle countdown and redirect
  useEffect(() => {
    if (countdown === null || !redirectUrl) return;

    if (countdown === 0) {
      window.location.href = redirectUrl;
      return;
    }

    const timer = setTimeout(() => {
      setCountdown(countdown - 1);
    }, 1000);

    return () => clearTimeout(timer);
  }, [countdown, redirectUrl]);

  const { checkout, customerPortal } = useMemo(
    () =>
      createCheckoutClient({
        onLoading: (isLoading) => {
          if (!isLoading) setLoadingPlanId(null);
        },
        onError: (err) => {
          setError(err.message);
          onError?.(err);
        },
        onPlanChanged: (url) => {
          setRedirectUrl(url);
          setCountdown(redirectCountdown);
        },
      }),
    [onError, redirectCountdown]
  );

  const handleCheckout = async (plan: Plan) => {
    setLoadingPlanId(getPlanId(plan));
    setError(null);
    setCountdown(null);
    setRedirectUrl(null);
    await checkout({ planName: plan.name, interval });
  };

  const handleManage = async () => {
    setLoadingPlanId("manage");
    setError(null);
    setCountdown(null);
    setRedirectUrl(null);
    await customerPortal();
  };

  const formatPrice = (amount: number, currency: string) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: 0,
    }).format(amount / 100);
  };

  // Analyze intervals across all plans
  const { showToggle, maxYearlyDiscount, planIntervalMap, defaultInterval } = useMemo(() => {
    const allIntervals = new Set<PriceInterval>();
    const planIntervals: Record<string, Set<PriceInterval>> = {};
    let maxDiscount = 0;

    for (const plan of plans) {
      const planId = getPlanId(plan);
      const intervals = getPlanIntervals(plan);
      planIntervals[planId] = intervals;

      for (const int of intervals) {
        allIntervals.add(int);
      }

      // Calculate yearly discount for this plan
      const discount = getYearlyDiscount(plan);
      if (discount > maxDiscount) maxDiscount = discount;
    }

    const hasMonth = allIntervals.has("month");
    const hasYear = allIntervals.has("year");

    // Determine default interval based on what's available
    let defaultInt: PriceInterval = "month";
    if (!hasMonth && hasYear) defaultInt = "year";

    return {
      showToggle: hasMonth && hasYear,
      maxYearlyDiscount: maxDiscount,
      planIntervalMap: planIntervals,
      defaultInterval: defaultInt,
    };
  }, [plans]);

  // Set interval to default when plans load (if not already set by prop or subscription)
  useEffect(() => {
    if (!currentIntervalProp && !subscription?.interval && plans.length > 0) {
      setInterval(defaultInterval);
    }
  }, [defaultInterval, currentIntervalProp, subscription?.interval, plans.length]);

  // Render loading skeleton
  if (loading) {
    return (
      <>
        <style>{styles}</style>
        <LoadingSkeleton />
      </>
    );
  }

  // Render error state
  if (fetchError) {
    return (
      <>
        <style>{styles}</style>
        <ErrorState message={fetchError} onRetry={fetchBilling} />
      </>
    );
  }

  return (
    <>
      <style>{styles}</style>

      <div className="snw-pricing-container">
        <div className="snw-pricing-header">
          <h1 className="snw-pricing-title">Choose your plan</h1>
          <p className="snw-pricing-subtitle">
            Start free, upgrade when you need more
          </p>
        </div>

        {showToggle && (
          <div className="snw-interval-toggle">
            <button
              className={`snw-interval-btn ${interval === "month" ? "active" : ""}`}
              onClick={() => setInterval("month")}
            >
              Monthly
            </button>
            <button
              className={`snw-interval-btn ${interval === "year" ? "active" : ""}`}
              onClick={() => setInterval("year")}
            >
              Yearly
              {maxYearlyDiscount > 0 && (
                <span className="snw-discount-badge">Save {maxYearlyDiscount}%</span>
              )}
            </button>
          </div>
        )}

        {countdown !== null && (
          <div className="snw-success">
            <span className="snw-success-icon">✓</span>
            <span>Plan updated! Redirecting in {countdown}...</span>
          </div>
        )}

        {error && <div className="snw-error">{error}</div>}

        <div className="snw-pricing-grid">
          {plans.map((plan) => {
            const planId = getPlanId(plan);
            const planIntervals = planIntervalMap[planId] || new Set();
            const supportsInterval = planIntervals.has(interval);
            const price = getPrice(plan, interval);

            // For display: if plan doesn't have the selected interval, show what it does have
            const displayPrice = price || (plan.price?.find((p) => p.interval !== "one_time") ?? null);
            const displayInterval = price?.interval || displayPrice?.interval || interval;

            const isCurrent = currentPlanId === planId;
            const isLoading = loadingPlanId === planId;
            const isManageLoading = loadingPlanId === "manage";
            const isFree = !displayPrice || displayPrice.amount === 0;

            // Plan is unavailable if toggle is showing AND plan doesn't support selected interval AND it's not free
            const isUnavailable = showToggle && !supportsInterval && !isFree;

            return (
              <div
                key={planId}
                className={`snw-pricing-card ${isCurrent ? "current" : ""} ${isUnavailable ? "unavailable" : ""}`}
              >
                {isCurrent && <span className="snw-current-badge">Current Plan</span>}
                <h2 className="snw-plan-name">{plan.name}</h2>
                {plan.description && (
                  <p className="snw-plan-description">{plan.description}</p>
                )}
                <p className={`snw-plan-price ${isUnavailable ? "muted" : ""}`}>
                  {isFree || !displayPrice
                    ? "Free"
                    : formatPrice(displayPrice.amount, displayPrice.currency)}
                  {displayPrice && !isFree && displayPrice.interval !== "one_time" && (
                    <span className="snw-plan-interval">/{displayPrice.interval}</span>
                  )}
                </p>
                {isUnavailable && (
                  <p className="snw-unavailable-note">Only available {displayInterval}ly</p>
                )}

                {(plan.features || plan.wallet || plan.highlights) && (
                  <ul className="snw-plan-features">
                    {/* Credit-based and usage-based features */}
                    {Object.entries(getPlanFeatures(plan)).map(([type, config]) => {
                      const effectiveInterval = supportsInterval ? interval : displayInterval;
                      const intervalLabel = effectiveInterval === "year" ? "year" : "month";
                      const featureName = config.displayName || type;
                      const currency = displayPrice?.currency || "usd";

                      // Format usage price (e.g., "$0.02" for 2 cents)
                      const formatUsagePrice = (cents: number) => {
                        return new Intl.NumberFormat("en-US", {
                          style: "currency",
                          currency: currency.toUpperCase(),
                          minimumFractionDigits: cents < 100 ? 2 : 0,
                          maximumFractionDigits: cents < 100 ? 4 : 2,
                        }).format(cents / 100);
                      };

                      const hasCredits = config.allocation !== undefined;
                      const hasUsage = config.trackUsage && config.pricePerCredit !== undefined;

                      // Build the display text based on what's configured
                      let displayText: string;
                      if (hasCredits && hasUsage) {
                        // Credits + Usage: "1,000 API Calls/month, then $0.02/call"
                        const scaledAllocation = getScaledAllocation(config.allocation!, effectiveInterval);
                        const usagePrice = formatUsagePrice(config.pricePerCredit!);
                        displayText = `${scaledAllocation.toLocaleString()} ${featureName}/${intervalLabel}, then ${usagePrice} each`;
                      } else if (hasCredits) {
                        // Credits only: "1,000 API Calls/month"
                        const scaledAllocation = getScaledAllocation(config.allocation!, effectiveInterval);
                        displayText = `${scaledAllocation.toLocaleString()} ${featureName}${config.onRenewal === "add" ? " (accumulates)" : `/${intervalLabel}`}`;
                      } else {
                        // Usage only: "API Calls at $0.02 each"
                        const usagePrice = formatUsagePrice(config.pricePerCredit!);
                        displayText = `${featureName} at ${usagePrice} each`;
                      }

                      return (
                        <li key={type} className={`snw-plan-feature ${isUnavailable ? "muted" : ""}`}>
                          {displayText}
                        </li>
                      );
                    })}
                    {/* Wallet balance */}
                    {plan.wallet && (() => {
                      const effectiveInterval = supportsInterval ? interval : displayInterval;
                      const scaledCents = getScaledAllocation(plan.wallet.allocation, effectiveInterval);
                      const currency = displayPrice?.currency || "usd";
                      const formattedAmount = formatPrice(scaledCents, currency);
                      const intervalLabel = effectiveInterval === "year" ? "year" : "month";
                      const label = plan.wallet.displayName || "usage credit";

                      return (
                        <li className={`snw-plan-feature ${isUnavailable ? "muted" : ""}`}>
                          {formattedAmount} {label}
                          {plan.wallet.onRenewal === "add" ? " (accumulates)" : `/${intervalLabel}`}
                        </li>
                      );
                    })()}
                    {/* Custom highlights */}
                    {plan.highlights?.map((highlight) => (
                      <li key={highlight} className={`snw-plan-feature ${isUnavailable ? "muted" : ""}`}>
                        {highlight}
                      </li>
                    ))}
                  </ul>
                )}

                {isCurrent ? (
                  <button
                    className="snw-plan-btn secondary"
                    onClick={handleManage}
                    disabled={isManageLoading}
                  >
                    {isManageLoading && <span className="snw-loading-spinner" />}
                    Manage Subscription
                  </button>
                ) : isUnavailable ? (
                  <div className="snw-unavailable-btn-wrapper">
                    <button className="snw-plan-btn disabled" disabled>
                      Not Available
                    </button>
                    <span className="snw-tooltip">{plan.name} is only available with {displayInterval}ly billing</span>
                  </div>
                ) : (
                  <button
                    className="snw-plan-btn primary"
                    onClick={() => handleCheckout(plan)}
                    disabled={isLoading || !!loadingPlanId}
                  >
                    {isLoading && <span className="snw-loading-spinner" />}
                    {isFree ? "Get Started" : currentPlanId ? "Switch Plan" : "Subscribe"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

const styles = `
  /* =================================================================
     CUSTOMIZE YOUR THEME
     Change these variables to match your brand colors and style.
     ================================================================= */
  .snw-pricing-container {
    --snw-primary: #3b82f6;
    --snw-primary-hover: #2563eb;
    --snw-text: #111;
    --snw-text-muted: #666;
    --snw-text-secondary: #374151;
    --snw-border: #e5e7eb;
    --snw-background: white;
    --snw-background-secondary: #f3f4f6;
    --snw-success: #16a34a;
    --snw-success-bg: #f0fdf4;
    --snw-success-border: #bbf7d0;
    --snw-error: #dc2626;
    --snw-error-bg: #fef2f2;
    --snw-error-border: #fecaca;
    --snw-radius: 12px;
    --snw-radius-sm: 8px;
    --snw-font: system-ui, -apple-system, sans-serif;
  }
  /* ================================================================= */

  .snw-pricing-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem 1rem;
    font-family: var(--snw-font);
  }
  .snw-pricing-header {
    text-align: center;
    margin-bottom: 2rem;
  }
  .snw-pricing-title {
    font-size: 2rem;
    font-weight: 700;
    color: var(--snw-text);
    margin: 0 0 0.5rem 0;
  }
  .snw-pricing-subtitle {
    color: var(--snw-text-muted);
    font-size: 1.1rem;
    margin: 0;
  }
  .snw-interval-toggle {
    display: flex;
    justify-content: center;
    gap: 0.5rem;
    margin-bottom: 2rem;
  }
  .snw-interval-btn {
    padding: 0.5rem 1rem;
    border: 1px solid var(--snw-border);
    background: var(--snw-background);
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
    transition: all 0.15s;
  }
  .snw-interval-btn:hover {
    border-color: var(--snw-primary);
  }
  .snw-interval-btn.active {
    background: var(--snw-primary);
    border-color: var(--snw-primary);
    color: white;
  }
  .snw-discount-badge {
    display: inline-block;
    margin-left: 0.5rem;
    padding: 0.2rem 0.5rem;
    background: #10b981;
    color: white;
    font-size: 0.7rem;
    font-weight: 600;
    border-radius: 9999px;
  }
  .snw-interval-btn.active .snw-discount-badge {
    background: white;
    color: var(--snw-primary);
  }
  .snw-pricing-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 1.5rem;
  }
  .snw-pricing-card {
    border: 1px solid var(--snw-border);
    border-radius: var(--snw-radius);
    padding: 1.5rem;
    background: var(--snw-background);
    transition: all 0.2s;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .snw-pricing-card:hover {
    border-color: var(--snw-primary);
    box-shadow: 0 4px 12px color-mix(in srgb, var(--snw-primary) 10%, transparent);
  }
  .snw-pricing-card.current {
    border-color: var(--snw-primary);
    border-width: 2px;
  }
  .snw-pricing-card.unavailable {
    opacity: 0.7;
  }
  .snw-pricing-card.unavailable:hover {
    border-color: var(--snw-border);
    box-shadow: none;
  }
  .snw-plan-price.muted,
  .snw-plan-feature.muted {
    color: var(--snw-text-muted);
  }
  .snw-plan-feature.muted::before {
    color: var(--snw-text-muted);
  }
  .snw-unavailable-note {
    font-size: 0.8rem;
    color: #f59e0b;
    margin: 0.25rem 0 0 0;
  }
  .snw-plan-name {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--snw-text);
    margin: 0 0 0.25rem 0;
  }
  .snw-plan-description {
    color: var(--snw-text-muted);
    font-size: 0.9rem;
    margin: 0 0 1rem 0;
  }
  .snw-plan-price {
    font-size: 2.5rem;
    font-weight: 700;
    color: var(--snw-text);
    margin: 0;
  }
  .snw-plan-interval {
    color: var(--snw-text-muted);
    font-size: 0.9rem;
  }
  .snw-plan-features {
    list-style: none;
    padding: 0;
    margin: 1.5rem 0;
    flex-grow: 1;
  }
  .snw-plan-feature {
    padding: 0.4rem 0;
    color: var(--snw-text-secondary);
    font-size: 0.95rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .snw-plan-feature::before {
    content: "✓";
    color: var(--snw-primary);
    font-weight: bold;
  }
  .snw-plan-btn {
    width: 100%;
    padding: 0.75rem 1rem;
    border: none;
    border-radius: var(--snw-radius-sm);
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }
  .snw-plan-btn:disabled {
    opacity: 0.7;
    cursor: not-allowed;
  }
  .snw-plan-btn.primary {
    background: var(--snw-primary);
    color: white;
  }
  .snw-plan-btn.primary:hover:not(:disabled) {
    background: var(--snw-primary-hover);
  }
  .snw-plan-btn.secondary {
    background: var(--snw-background-secondary);
    color: var(--snw-text-secondary);
  }
  .snw-plan-btn.secondary:hover:not(:disabled) {
    background: var(--snw-border);
  }
  .snw-plan-btn.disabled {
    background: var(--snw-background-secondary);
    color: var(--snw-text-muted);
    cursor: not-allowed;
  }
  .snw-unavailable-btn-wrapper {
    position: relative;
  }
  .snw-tooltip {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    left: 50%;
    transform: translateX(-50%);
    background: #1f2937;
    color: white;
    font-size: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
  }
  .snw-unavailable-btn-wrapper:hover .snw-tooltip {
    opacity: 1;
  }
  .snw-current-badge {
    position: absolute;
    top: -0.65rem;
    left: 1.25rem;
    background: var(--snw-primary);
    color: white;
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }
  .snw-error {
    background: var(--snw-error-bg);
    border: 1px solid var(--snw-error-border);
    color: var(--snw-error);
    padding: 0.75rem 1rem;
    border-radius: var(--snw-radius-sm);
    margin-bottom: 1rem;
    text-align: center;
  }
  .snw-success {
    background: var(--snw-success-bg);
    border: 1px solid var(--snw-success-border);
    color: var(--snw-success);
    padding: 0.75rem 1rem;
    border-radius: var(--snw-radius-sm);
    margin-bottom: 1rem;
    text-align: center;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    animation: snw-fade-in 0.3s ease-out;
  }
  .snw-success-icon {
    width: 20px;
    height: 20px;
    background: var(--snw-success);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 12px;
    flex-shrink: 0;
  }
  @keyframes snw-fade-in {
    from { opacity: 0; transform: translateY(-10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .snw-loading-spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: snw-spin 0.6s linear infinite;
    margin-right: 0.5rem;
  }
  @keyframes snw-spin {
    to { transform: rotate(360deg); }
  }

  /* Skeleton loading styles */
  .snw-skeleton {
    background: linear-gradient(90deg, var(--snw-border) 25%, var(--snw-background-secondary) 50%, var(--snw-border) 75%);
    background-size: 200% 100%;
    animation: snw-shimmer 1.5s infinite;
    border-radius: var(--snw-radius-sm);
  }
  .snw-skeleton-title {
    height: 2rem;
    width: 60%;
    margin: 0 auto 0.5rem;
  }
  .snw-skeleton-subtitle {
    height: 1.1rem;
    width: 40%;
    margin: 0 auto;
  }
  .snw-skeleton-plan-name {
    height: 1.25rem;
    width: 50%;
    margin-bottom: 1rem;
  }
  .snw-skeleton-price {
    height: 2.5rem;
    width: 40%;
    margin-bottom: 1rem;
  }
  .snw-skeleton-features {
    height: 4rem;
    width: 100%;
    margin-bottom: 1rem;
  }
  .snw-skeleton-btn {
    height: 2.75rem;
    width: 100%;
  }
  @keyframes snw-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  /* Error state styles */
  .snw-error-state {
    text-align: center;
    padding: 3rem 1rem;
  }
  .snw-error-message {
    color: var(--snw-error);
    margin-bottom: 1rem;
    font-size: 1rem;
  }
  .snw-error-state .snw-plan-btn {
    width: auto;
    padding: 0.75rem 2rem;
  }

  @media (max-width: 768px) {
    .snw-pricing-grid {
      grid-template-columns: 1fr;
    }
    .snw-pricing-title {
      font-size: 1.5rem;
    }
    .snw-plan-price {
      font-size: 2rem;
    }
  }
`;
