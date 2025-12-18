import type { PriceInterval } from "./BillingConfig";

export interface CheckoutOptions {
  /**
   * Plan name to checkout (as defined in your billing config)
   */
  planName?: string;

  /**
   * Plan ID to checkout (as defined in your billing config)
   */
  planId?: string;

  /**
   * Billing interval (month, year, etc.)
   */
  interval?: PriceInterval;

  /**
   * Direct Stripe price ID (bypasses billing config lookup)
   */
  priceId?: string;

  /**
   * Quantity of the item (defaults to 1)
   */
  quantity?: number;

  /**
   * Customer email for prefilling checkout
   */
  customerEmail?: string;

  /**
   * Override success URL for this checkout
   */
  successUrl?: string;

  /**
   * Override cancel URL for this checkout
   */
  cancelUrl?: string;

  /**
   * Additional metadata to attach to the session
   */
  metadata?: Record<string, string>;
}

export interface CheckoutClientConfig {
  /**
   * API endpoint for checkout (defaults to /api/stripe/checkout)
   */
  checkoutEndpoint?: string;
}

/**
 * Creates a checkout client for initiating Stripe checkouts from the frontend.
 *
 * @example
 * ```ts
 * import { createCheckoutClient } from "stripe-no-webhooks/client";
 *
 * const { checkout } = createCheckoutClient();
 *
 * // In your component:
 * <button onClick={() => checkout({ planName: "pro", interval: "month" })}>
 *   Subscribe to Pro
 * </button>
 * ```
 */
export function createCheckoutClient(config: CheckoutClientConfig = {}) {
  const { checkoutEndpoint = "/api/stripe/checkout" } = config;

  /**
   * Initiates a Stripe checkout session and redirects the user to the checkout page.
   */
  async function checkout(options: CheckoutOptions): Promise<void> {
    const response = await fetch(checkoutEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(options),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Checkout failed: ${response.status}`);
    }

    const data = await response.json();

    if (!data.url) {
      throw new Error("No checkout URL returned");
    }

    window.location.href = data.url;
  }

  return { checkout };
}

/**
 * Default checkout client instance using /api/stripe/checkout endpoint.
 *
 * @example
 * ```ts
 * import { checkout } from "stripe-no-webhooks/client";
 *
 * <button onClick={() => checkout({ planName: "pro", interval: "month" })}>
 *   Subscribe to Pro
 * </button>
 * ```
 */
export const { checkout } = createCheckoutClient();
