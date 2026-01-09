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

  /**
   * API endpoint for customer portal (defaults to /api/stripe/customer_portal)
   */
  customerPortalEndpoint?: string;

  /**
   * Called when loading state changes (start/end of API calls)
   */
  onLoading?: (isLoading: boolean) => void;

  /**
   * Called when an error occurs during checkout or portal access
   */
  onError?: (error: Error) => void;

  /**
   * Called right before redirecting to Stripe (checkout or portal)
   */
  onRedirect?: (url: string) => void;

  /**
   * Called when a plan switch completes successfully.
   * Receives the redirect URL. Component is responsible for showing success UI
   * and redirecting after a delay.
   */
  onPlanChanged?: (redirectUrl: string) => void;
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
  const {
    checkoutEndpoint = "/api/stripe/checkout",
    customerPortalEndpoint = "/api/stripe/customer_portal",
    onLoading,
    onError,
    onRedirect,
    onPlanChanged,
  } = config;

  /**
   * Initiates a Stripe checkout session and redirects the user to the checkout page.
   */
  async function checkout(options: CheckoutOptions): Promise<void> {
    try {
      onLoading?.(true);

      const response = await fetch(checkoutEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(options),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Checkout failed: ${response.status}`);
      }

      const data = await response.json();

      // Smart checkout: already on this plan
      if (data.alreadySubscribed) {
        onLoading?.(false);
        return;
      }

      // Smart checkout: direct upgrade/downgrade (no checkout needed)
      if (data.success && data.redirectUrl) {
        onLoading?.(false);
        if (onPlanChanged) {
          // Let component handle success UI and redirect
          onPlanChanged(data.redirectUrl);
          return;
        }
        // No handler - redirect immediately
        onRedirect?.(data.redirectUrl);
        window.location.href = data.redirectUrl;
        return;
      }

      // Standard checkout: redirect to Stripe
      if (data.url) {
        onRedirect?.(data.url);
        window.location.href = data.url;
        return;
      }

      throw new Error("No checkout URL returned");
    } catch (err) {
      onLoading?.(false);
      const error = err instanceof Error ? err : new Error(String(err));
      onError?.(error);
      throw error;
    }
  }

  /**
   * Opens the Stripe customer portal for the authenticated user.
   */
  async function customerPortal(): Promise<void> {
    try {
      onLoading?.(true);

      const response = await fetch(customerPortalEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Customer portal failed: ${response.status}`
        );
      }

      const data = await response.json();

      if (!data.url) {
        throw new Error("No portal URL returned");
      }

      onRedirect?.(data.url);
      window.location.href = data.url;
    } catch (err) {
      onLoading?.(false);
      const error = err instanceof Error ? err : new Error(String(err));
      onError?.(error);
      throw error;
    }
  }

  return { checkout, customerPortal };
}

/**
 * Default client instance using /api/stripe endpoints.
 *
 * @example
 * ```ts
 * import { checkout, customerPortal } from "stripe-no-webhooks/client";
 *
 * <button onClick={() => checkout({ planName: "pro", interval: "month" })}>
 *   Subscribe to Pro
 * </button>
 *
 * <button onClick={() => customerPortal()}>
 *   Manage Billing
 * </button>
 * ```
 */
export const { checkout, customerPortal } = createCheckoutClient();
