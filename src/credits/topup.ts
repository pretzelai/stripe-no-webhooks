import type Stripe from "stripe";
import type { Pool } from "pg";
import type { BillingConfig, FeatureConfig } from "../BillingConfig";
import { isUsageTrackingEnabled } from "../BillingConfig";
import type { TaxConfig } from "../types";
import { credits } from "./index";
import * as db from "./db";
import { CreditError } from "./types";

// Hard declines: card is unusable, stop immediately
const HARD_DECLINE_CODES = new Set([
  "expired_card",
  "stolen_card",
  "lost_card",
  "pickup_card",
  "fraudulent",
  "invalid_account",
  "restricted_card",
  "invalid_cvc",
  "incorrect_cvc",
  "invalid_number",
  "incorrect_number",
]);

// Soft declines: temporary, might succeed later
const SOFT_DECLINE_CODES = new Set([
  "insufficient_funds",
  "card_velocity_exceeded",
  "withdrawal_count_limit_exceeded",
  "authentication_required",
  "issuer_not_available",
  "processing_error",
  "try_again_later",
  "do_not_honor",
  "generic_decline",
  "call_issuer",
  "duplicate_transaction",
]);

function classifyDeclineCode(code: string | undefined): "hard" | "soft" {
  if (!code) return "soft";
  if (HARD_DECLINE_CODES.has(code)) return "hard";
  // Unknown codes default to soft (allow retry after cooldown)
  return "soft";
}

export type TopUpSuccess = {
  success: true;
  balance: number;
  charged: { amount: number; currency: string };
  sourceId: string; // PaymentIntent ID (B2C) or Invoice ID (B2B)
};

export type TopUpPending = {
  success: true;
  status: "pending";
  sourceId: string; // PaymentIntent ID (B2C) or Invoice ID (B2B)
  /** Credits will be granted when payment succeeds (via webhook) */
  message: string;
};

export type TopUpFailure = {
  success: false;
  error: {
    code:
      | "NO_PAYMENT_METHOD"
      | "PAYMENT_FAILED"
      | "TOPUP_NOT_CONFIGURED"
      | "INVALID_AMOUNT"
      | "NO_SUBSCRIPTION"
      | "USER_NOT_FOUND";
    message: string;
    recoveryUrl?: string;
  };
};

export type TopUpResult = TopUpSuccess | TopUpPending | TopUpFailure;

export type TopUpParams = {
  userId: string;
  key: string;
  amount: number;
  /** Idempotency key to prevent duplicate charges on retry. */
  idempotencyKey?: string;
};

export type AutoTopUpTriggered = {
  triggered: true;
  status: "succeeded" | "pending";
  sourceId: string; // PaymentIntent ID (B2C) or Invoice ID (B2B)
};

export type AutoTopUpSkipped = {
  triggered: false;
  reason:
    | "balance_above_threshold"
    | "not_configured"
    | "max_per_month_reached"
    | "no_payment_method"
    | "no_subscription"
    | "user_not_found"
    | "disabled_hard_decline"
    | "in_cooldown";
  retriesAt?: Date;
};

export type AutoTopUpFailed = {
  triggered: false;
  reason: "payment_failed" | "payment_requires_action";
  error: string;
  declineCode?: string;
  declineType?: "hard" | "soft";
};

export type AutoTopUpResult =
  | AutoTopUpTriggered
  | AutoTopUpSkipped
  | AutoTopUpFailed;

export type AutoTopUpFailedTrigger =
  | "stripe_declined_payment"      // We charged, Stripe said no
  | "waiting_for_retry_cooldown"   // In 24h cooldown, will retry after
  | "blocked_until_card_updated"   // Permanently blocked, needs new card
  | "no_payment_method"            // No card on file
  | "monthly_limit_reached"        // Hit max auto top-ups this month
  | "unexpected_error";            // Unexpected error (network, code bug, etc.)

export type AutoTopUpFailedCallbackParams = {
  userId: string;
  stripeCustomerId: string;
  key: string;

  trigger: AutoTopUpFailedTrigger;
  status: "will_retry" | "action_required";
  nextAttemptAt?: Date;

  failureCount: number;
  stripeDeclineCode?: string;
};

export type TopUpHandler = {
  topUp: (params: TopUpParams) => Promise<TopUpResult>;
  hasPaymentMethod: (params: { userId: string }) => Promise<boolean>;
  triggerAutoTopUpIfNeeded: (params: {
    userId: string;
    key: string;
    currentBalance: number;
  }) => Promise<AutoTopUpResult>;
  handlePaymentIntentSucceeded: (paymentIntent: Stripe.PaymentIntent) => Promise<void>;
  handleTopUpCheckoutCompleted: (session: Stripe.Checkout.Session) => Promise<void>;
  handleInvoicePaid: (invoice: Stripe.Invoice) => Promise<void>;
  handleCustomerUpdated: (customer: Stripe.Customer, previousAttributes?: Partial<Stripe.Customer>) => Promise<void>;
};

export function createTopUpHandler(deps: {
  stripe: Stripe;
  pool: Pool | null;
  schema: string;
  billingConfig?: BillingConfig;
  mode: "test" | "production";
  successUrl: string;
  cancelUrl: string;
  tax?: TaxConfig;
  onCreditsGranted?: (params: {
    userId: string;
    key: string;
    amount: number;
    newBalance: number;
    source: "topup" | "auto_topup";
    sourceId: string;
  }) => void | Promise<void>;
  onTopUpCompleted?: (params: {
    userId: string;
    key: string;
    creditsAdded: number;
    amountCharged: number;
    currency: string;
    newBalance: number;
    sourceId: string;
  }) => void | Promise<void>;
  onAutoTopUpFailed?: (
    params: AutoTopUpFailedCallbackParams
  ) => void | Promise<void>;
  onCreditsLow?: (params: {
    userId: string;
    key: string;
    balance: number;
    threshold: number;
  }) => void | Promise<void>;
}) {
  const {
    stripe,
    pool,
    schema,
    billingConfig,
    mode,
    successUrl,
    cancelUrl,
    tax,
    onCreditsGranted,
    onTopUpCompleted,
    onAutoTopUpFailed,
    onCreditsLow,
  } = deps;

  // B2B mode uses invoices (proper receipts, shows in Customer Portal)
  // B2C mode uses PaymentIntents (cheaper, no extra 0.4-0.5% fee)
  const useInvoices = !!(tax?.automaticTax || tax?.taxIdCollection);

  async function getCustomerByUserId(userId: string): Promise<{
    id: string;
    deleted: boolean;
    defaultPaymentMethod: string | null;
  } | null> {
    if (!pool) return null;
    const result = await pool.query(
      `SELECT c.id, c.deleted, c.invoice_settings->>'default_payment_method' as default_payment_method
       FROM ${schema}.user_stripe_customer_map m
       JOIN ${schema}.customers c ON c.id = m.stripe_customer_id
       WHERE m.user_id = $1`,
      [userId]
    );
    if (!result.rows[0]) return null;
    return {
      id: result.rows[0].id,
      deleted: result.rows[0].deleted ?? false,
      defaultPaymentMethod: result.rows[0].default_payment_method,
    };
  }

  async function getActiveSubscription(
    customerId: string
  ): Promise<{ id: string; priceId: string; currency: string } | null> {
    if (!pool) return null;
    // Include trialing and past_due - these users have a valid plan and should be able to top up
    const result = await pool.query(
      `SELECT s.id, si.price, p.currency
       FROM ${schema}.subscriptions s
       JOIN ${schema}.subscription_items si ON si.subscription = s.id
       JOIN ${schema}.prices p ON p.id = si.price
       WHERE s.customer = $1 AND s.status IN ('active', 'trialing', 'past_due')
       ORDER BY s.created DESC
       LIMIT 1`,
      [customerId]
    );
    if (!result.rows[0]) return null;
    return {
      id: result.rows[0].id,
      priceId: result.rows[0].price,
      currency: result.rows[0].currency,
    };
  }

  async function createRecoveryCheckout(
    customerId: string,
    key: string,
    amount: number,
    totalCents: number,
    currency: string
  ): Promise<string> {
    if (!successUrl || !cancelUrl) {
      throw new CreditError(
        "MISSING_CONFIG",
        "successUrl and cancelUrl are required for recovery checkout. Configure them in createStripeHandler."
      );
    }

    const displayName = key
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "payment",
      payment_method_types: ["card"],
      payment_intent_data: {
        setup_future_usage: "off_session",
      },
      line_items: [
        {
          price_data: {
            currency,
            unit_amount: totalCents,
            product_data: {
              name: `${amount} ${displayName}`,
              description: "Credit top-up",
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        top_up_key: key,
        top_up_amount: String(amount),
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Tax support for B2B mode
      ...(tax?.automaticTax && {
        automatic_tax: { enabled: true },
      }),
      ...(tax?.taxIdCollection && {
        tax_id_collection: { enabled: true },
      }),
      // customer_update is required when automaticTax or taxIdCollection is enabled
      ...((tax?.automaticTax || tax?.taxIdCollection) && {
        customer_update: { address: "auto", name: "auto" },
      }),
    });

    if (!session.url) {
      throw new CreditError(
        "CHECKOUT_ERROR",
        "Failed to create checkout session URL"
      );
    }
    return session.url;
  }

  /**
   * Create a recovery URL for failed top-ups.
   * Always uses Checkout sessions (even for B2B) because:
   * - Checkout saves the new card via setup_future_usage
   * - Checkout has success_url for redirect back to app
   * - Checkout supports automatic_tax for B2B users
   */
  async function tryCreateRecoveryUrl(
    customerId: string,
    key: string,
    amount: number,
    totalCents: number,
    currency: string
  ): Promise<string | undefined> {
    try {
      return await createRecoveryCheckout(
        customerId,
        key,
        amount,
        totalCents,
        currency
      );
    } catch (err) {
      console.error("Failed to create recovery URL:", err);
      return undefined;
    }
  }

  /**
   * Grant credits from a paid invoice. Used for B2B mode.
   * Handles both inline (immediate) and webhook paths with idempotency.
   */
  async function grantCreditsFromInvoice(
    invoice: Stripe.Invoice
  ): Promise<number> {
    const key = invoice.metadata?.top_up_key;
    const amountStr = invoice.metadata?.top_up_amount;
    const userId = invoice.metadata?.user_id;
    const isAuto = invoice.metadata?.top_up_auto === "true";

    if (!key || !amountStr || !userId) {
      throw new CreditError(
        "INVALID_METADATA",
        "Missing top-up metadata on Invoice"
      );
    }

    const amount = parseInt(amountStr, 10);
    if (isNaN(amount) || amount <= 0) {
      throw new CreditError(
        "INVALID_METADATA",
        "Invalid top_up_amount in Invoice metadata"
      );
    }

    const source = isAuto ? "auto_topup" : "topup";
    let newBalance: number;
    let alreadyGranted = false;

    try {
      newBalance = await credits.grant({
        userId,
        key,
        amount,
        source,
        sourceId: invoice.id,
        idempotencyKey: `topup_invoice_${invoice.id}`,
      });
    } catch (grantErr) {
      if (
        grantErr instanceof CreditError &&
        grantErr.code === "IDEMPOTENCY_CONFLICT"
      ) {
        newBalance = await credits.getBalance({ userId, key });
        alreadyGranted = true;
      } else {
        throw grantErr;
      }
    }

    if (!alreadyGranted) {
      await onCreditsGranted?.({
        userId,
        key,
        amount,
        newBalance,
        source,
        sourceId: invoice.id,
      });
      await onTopUpCompleted?.({
        userId,
        key,
        creditsAdded: amount,
        amountCharged: invoice.amount_paid,
        currency: invoice.currency,
        newBalance,
        sourceId: invoice.id,
      });
    }

    return newBalance;
  }

  // for on-demand top-ups
  async function topUp(params: TopUpParams): Promise<TopUpResult> {
    const { userId, key, amount, idempotencyKey } = params;

    // Validate amount is a valid positive integer
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
      return {
        success: false,
        error: {
          code: "INVALID_AMOUNT",
          message: "Amount must be a positive integer",
        },
      };
    }

    const customer = await getCustomerByUserId(userId);
    if (!customer) {
      return {
        success: false,
        error: {
          code: "USER_NOT_FOUND",
          message: "No Stripe customer found for user",
        },
      };
    }
    if (customer.deleted) {
      return {
        success: false,
        error: { code: "USER_NOT_FOUND", message: "Customer has been deleted" },
      };
    }

    const subscription = await getActiveSubscription(customer.id);
    if (!subscription) {
      return {
        success: false,
        error: {
          code: "NO_SUBSCRIPTION",
          message: "No active subscription found",
        },
      };
    }

    const plan = billingConfig?.[mode]?.plans?.find((p) =>
      p.price.some((pr) => pr.id === subscription.priceId)
    );
    if (!plan) {
      return {
        success: false,
        error: {
          code: "TOPUP_NOT_CONFIGURED",
          message: "Could not determine plan from subscription",
        },
      };
    }

    const features = plan.features || {};
    const featureConfig = features[key];
    if (!featureConfig?.pricePerCredit) {
      return {
        success: false,
        error: {
          code: "TOPUP_NOT_CONFIGURED",
          message: `Top-up not configured for ${key}`,
        },
      };
    }

    // Disallow top-ups when usage tracking is enabled
    if (isUsageTrackingEnabled(featureConfig)) {
      return {
        success: false,
        error: {
          code: "TOPUP_NOT_CONFIGURED",
          message: `Top-ups are disabled for ${key} because usage tracking is enabled`,
        },
      };
    }

    const {
      pricePerCredit,
      minPerPurchase = 1,
      maxPerPurchase,
    } = featureConfig;
    if (amount < minPerPurchase) {
      return {
        success: false,
        error: {
          code: "INVALID_AMOUNT",
          message: `Minimum purchase is ${minPerPurchase} credits`,
        },
      };
    }
    if (maxPerPurchase !== undefined && amount > maxPerPurchase) {
      return {
        success: false,
        error: {
          code: "INVALID_AMOUNT",
          message: `Maximum purchase is ${maxPerPurchase} credits`,
        },
      };
    }

    const totalCents = amount * pricePerCredit;

    // Stripe requires minimum ~50 cents in most currencies, use 60 to be safe with conversion
    const STRIPE_MIN_AMOUNT = 60;
    if (totalCents < STRIPE_MIN_AMOUNT) {
      return {
        success: false,
        error: {
          code: "INVALID_AMOUNT",
          message: `Minimum purchase amount is ${STRIPE_MIN_AMOUNT} (${Math.ceil(STRIPE_MIN_AMOUNT / pricePerCredit)} credits at current price)`,
        },
      };
    }
    const currency = subscription.currency;

    // Use configured displayName if available, otherwise construct from ID
    const displayName =
      featureConfig.displayName ||
      key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    if (!customer.defaultPaymentMethod) {
      const recoveryUrl = await tryCreateRecoveryUrl(
        customer.id,
        key,
        amount,
        totalCents,
        currency
      );
      return {
        success: false,
        error: {
          code: "NO_PAYMENT_METHOD",
          message: "No payment method on file",
          recoveryUrl,
        },
      };
    }

    try {
      if (useInvoices) {
        // B2B MODE: Create invoice (proper receipts, shows in Customer Portal)
        // Has additional 0.4-0.5% Stripe Invoicing fee

        // IMPORTANT: Create invoice FIRST, then add items to it.
        // If we create invoice items without specifying an invoice, they get
        // attached to the subscription's upcoming invoice instead of a standalone one.
        // auto_advance: false prevents Stripe from retrying payment if it fails
        // We handle payment explicitly with pay() and recovery flow
        const invoice = await stripe.invoices.create(
          {
            customer: customer.id,
            auto_advance: false,
            // Don't include pending items from subscription
            pending_invoice_items_behavior: "exclude",
            // Enable automatic tax if configured
            ...(tax?.automaticTax && { automatic_tax: { enabled: true } }),
            metadata: {
              top_up_key: key,
              top_up_amount: String(amount),
              user_id: userId,
            },
          },
          idempotencyKey
            ? { idempotencyKey: `${idempotencyKey}_invoice` }
            : undefined
        );

        // Now add the invoice item to this specific invoice
        // Use unit_amount_decimal + quantity for proper invoice display (e.g., "50 x $0.10")
        await stripe.invoiceItems.create(
          {
            customer: customer.id,
            invoice: invoice.id,
            unit_amount_decimal: String(pricePerCredit),
            quantity: amount,
            currency,
            description: `${displayName} (credit top-up)`,
          },
          idempotencyKey
            ? { idempotencyKey: `${idempotencyKey}_item` }
            : undefined
        );

        let paidInvoice: Stripe.Invoice;
        try {
          paidInvoice = await stripe.invoices.pay(
            invoice.id,
            {},
            idempotencyKey
              ? { idempotencyKey: `${idempotencyKey}_pay` }
              : undefined
          );
        } catch (payErr) {
          // Payment failed - void the invoice to prevent it from being paid later
          // (which would grant credits without going through our flow)
          await stripe.invoices.voidInvoice(invoice.id).catch(() => {});
          throw payErr;
        }

        if (paidInvoice.status === "paid") {
          const newBalance = await grantCreditsFromInvoice(paidInvoice);
          return {
            success: true,
            balance: newBalance,
            // Use amount_paid which includes tax for B2B mode
            charged: { amount: paidInvoice.amount_paid, currency },
            sourceId: paidInvoice.id,
          };
        }

        // Invoice not paid (unusual status) - void it and offer recovery
        await stripe.invoices.voidInvoice(invoice.id).catch(() => {});
        const recoveryUrl = await tryCreateRecoveryUrl(
          customer.id,
          key,
          amount,
          totalCents,
          currency
        );
        return {
          success: false,
          error: {
            code: "PAYMENT_FAILED",
            message: `Invoice status: ${paidInvoice.status}`,
            recoveryUrl,
          },
        };
      } else {
        // B2C MODE: Use PaymentIntent directly (cheaper, no Invoicing fee)
        const paymentIntent = await stripe.paymentIntents.create(
          {
            amount: totalCents,
            currency,
            customer: customer.id,
            payment_method: customer.defaultPaymentMethod,
            confirm: true,
            off_session: true,
            metadata: {
              top_up_key: key,
              top_up_amount: String(amount),
              user_id: userId,
            },
          },
          idempotencyKey ? { idempotencyKey } : undefined
        );

        if (paymentIntent.status === "succeeded") {
          const newBalance = await grantCreditsFromPayment(paymentIntent);
          return {
            success: true,
            balance: newBalance,
            charged: { amount: totalCents, currency },
            sourceId: paymentIntent.id,
          };
        }

        if (paymentIntent.status === "processing") {
          return {
            success: true,
            status: "pending",
            sourceId: paymentIntent.id,
            message:
              "Payment is processing. Credits will be added once payment completes.",
          };
        }

        // Payment needs action or failed - offer recovery
        const recoveryUrl = await tryCreateRecoveryUrl(
          customer.id,
          key,
          amount,
          totalCents,
          currency
        );
        return {
          success: false,
          error: {
            code: "PAYMENT_FAILED",
            message: `Payment status: ${paymentIntent.status}`,
            recoveryUrl,
          },
        };
      }
    } catch (err) {
      const stripeError = err as {
        type?: string;
        code?: string;
        message?: string;
      };
      const isDevError =
        stripeError.type === "invalid_request_error" ||
        stripeError.type === "authentication_error";
      const message = stripeError.message || "Payment failed";

      // Dev errors (invalid params, bad API key) - no recovery, fix the code
      if (isDevError) {
        return {
          success: false,
          error: {
            code:
              stripeError.type === "invalid_request_error"
                ? "INVALID_AMOUNT"
                : "PAYMENT_FAILED",
            message,
          },
        };
      }

      // All other errors (card decline, bank failure, network issue, etc.)
      // Offer recovery URL so user can complete purchase with different method
      const recoveryUrl = await tryCreateRecoveryUrl(
        customer.id,
        key,
        amount,
        totalCents,
        currency
      );
      return {
        success: false,
        error: {
          code: "PAYMENT_FAILED",
          message,
          recoveryUrl,
        },
      };
    }
  }

  /** Grant credits from a successful payment. Used by both inline and webhook paths. */
  async function grantCreditsFromPayment(
    paymentIntent: Stripe.PaymentIntent
  ): Promise<number> {
    const key = paymentIntent.metadata?.top_up_key;
    const amountStr = paymentIntent.metadata?.top_up_amount;
    const userId = paymentIntent.metadata?.user_id;
    const isAuto = paymentIntent.metadata?.top_up_auto === "true";

    if (!key || !amountStr || !userId) {
      throw new CreditError(
        "INVALID_METADATA",
        "Missing top-up metadata on PaymentIntent"
      );
    }

    const amount = parseInt(amountStr, 10);
    if (isNaN(amount) || amount <= 0) {
      throw new CreditError(
        "INVALID_METADATA",
        "Invalid top_up_amount in PaymentIntent metadata"
      );
    }

    const source = isAuto ? "auto_topup" : "topup";
    let newBalance: number;
    let alreadyGranted = false;
    try {
      newBalance = await credits.grant({
        userId,
        key,
        amount,
        source,
        sourceId: paymentIntent.id,
        idempotencyKey: `topup_${paymentIntent.id}`,
      });
    } catch (grantErr) {
      // Idempotency conflict = already granted (webhook + inline both fired)
      if (
        grantErr instanceof CreditError &&
        grantErr.code === "IDEMPOTENCY_CONFLICT"
      ) {
        newBalance = await credits.getBalance({ userId, key });
        alreadyGranted = true;
      } else {
        throw grantErr;
      }
    }

    // Only fire callbacks if this is the first grant (not a duplicate)
    if (!alreadyGranted) {
      await onCreditsGranted?.({
        userId,
        key,
        amount,
        newBalance,
        source,
        sourceId: paymentIntent.id,
      });
      await onTopUpCompleted?.({
        userId,
        key,
        creditsAdded: amount,
        amountCharged: paymentIntent.amount,
        currency: paymentIntent.currency,
        newBalance,
        sourceId: paymentIntent.id,
      });
    }

    return newBalance;
  }

  async function handlePaymentIntentSucceeded(
    paymentIntent: Stripe.PaymentIntent
  ): Promise<void> {
    const key = paymentIntent.metadata?.top_up_key;
    const userId = paymentIntent.metadata?.user_id;
    if (!key) {
      return;
    }
    await grantCreditsFromPayment(paymentIntent);

    // Clear any failure record on successful payment
    // This handles the "processing" -> "succeeded" path
    if (userId && key) {
      await db.unblockAutoTopUp({ userId, key });
    }
  }

  async function handleTopUpCheckoutCompleted(
    session: Stripe.Checkout.Session
  ): Promise<void> {
    const key = session.metadata?.top_up_key;
    const amountStr = session.metadata?.top_up_amount;
    if (!key || !amountStr) return; // Not a top-up checkout

    if (session.payment_status !== "paid") {
      console.warn(
        `Top-up checkout ${session.id} has payment_status '${session.payment_status}', skipping`
      );
      return;
    }

    const amount = parseInt(amountStr, 10);
    if (isNaN(amount) || amount <= 0) {
      throw new CreditError(
        "INVALID_METADATA",
        "Invalid top_up_amount in checkout session metadata"
      );
    }

    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id;
    if (!customerId) {
      throw new CreditError(
        "MISSING_CUSTOMER",
        "No customer ID in checkout session"
      );
    }

    // Get user_id from mapping table (canonical source of truth)
    if (!pool) {
      throw new CreditError("NO_DATABASE", "Database connection required");
    }
    const mappingResult = await pool.query(
      `SELECT user_id FROM ${schema}.user_stripe_customer_map WHERE stripe_customer_id = $1`,
      [customerId]
    );
    const userId = mappingResult.rows[0]?.user_id;
    if (!userId) {
      throw new CreditError(
        "MISSING_USER_ID",
        "No user mapping found for customer"
      );
    }

    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? session.id;

    // Update default payment method from the recovery checkout
    // This ensures future charges use the new card the customer just provided
    if (session.payment_intent) {
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent.id
        );
        if (paymentIntent.payment_method) {
          await stripe.customers.update(customerId, {
            invoice_settings: {
              default_payment_method:
                typeof paymentIntent.payment_method === "string"
                  ? paymentIntent.payment_method
                  : paymentIntent.payment_method.id,
            },
          });
        }
      } catch (updateErr) {
        // Log but don't fail - credits should still be granted
        console.error("Failed to update default payment method:", updateErr);
      }
    }

    let newBalance: number;
    try {
      // Use same idempotency key format as grantCreditsFromPayment
      // This ensures if both checkout.session.completed AND payment_intent.succeeded
      // fire for the same payment, only one grant occurs
      newBalance = await credits.grant({
        userId,
        key,
        amount,
        source: "topup",
        sourceId: paymentIntentId,
        idempotencyKey: `topup_${paymentIntentId}`,
      });
    } catch (grantErr) {
      if (
        grantErr instanceof CreditError &&
        grantErr.code === "IDEMPOTENCY_CONFLICT"
      ) {
        return; // Already processed
      }
      throw grantErr;
    }

    await onCreditsGranted?.({
      userId,
      key,
      amount,
      newBalance,
      source: "topup",
      sourceId: paymentIntentId,
    });
    await onTopUpCompleted?.({
      userId,
      key,
      creditsAdded: amount,
      amountCharged: session.amount_total ?? 0,
      currency: session.currency ?? "usd",
      newBalance,
      sourceId: paymentIntentId,
    });

    // Clear any failure record - recovery checkout succeeded
    await db.unblockAutoTopUp({ userId, key });
  }

  /**
   * Handle invoice.paid webhook for B2B mode top-up invoices.
   * Credits are typically granted inline when invoice.pay() succeeds,
   * but this handles edge cases (async payment, retry after failure).
   */
  async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    // Only process top-up invoices (not subscription invoices)
    const key = invoice.metadata?.top_up_key;
    const userId = invoice.metadata?.user_id;
    if (!key) {
      return;
    }

    try {
      await grantCreditsFromInvoice(invoice);

      // Update default payment method from the invoice payment
      // This ensures future charges use the card the customer just paid with
      const customerId =
        typeof invoice.customer === "string"
          ? invoice.customer
          : invoice.customer?.id;

      if (customerId && invoice.payment_intent) {
        try {
          const paymentIntentId =
            typeof invoice.payment_intent === "string"
              ? invoice.payment_intent
              : invoice.payment_intent.id;
          const paymentIntent =
            await stripe.paymentIntents.retrieve(paymentIntentId);

          if (paymentIntent.payment_method) {
            const paymentMethodId =
              typeof paymentIntent.payment_method === "string"
                ? paymentIntent.payment_method
                : paymentIntent.payment_method.id;

            await stripe.customers.update(customerId, {
              invoice_settings: { default_payment_method: paymentMethodId },
            });
          }
        } catch (updateErr) {
          // Log but don't fail - credits should still be granted
          console.error(
            "Failed to update default payment method from invoice:",
            updateErr
          );
        }
      }

      // Clear any failure record on successful payment
      if (userId && key) {
        await db.unblockAutoTopUp({ userId, key });
      }
    } catch (err) {
      // Idempotency conflict = already granted inline, which is expected
      if (err instanceof CreditError && err.code === "IDEMPOTENCY_CONFLICT") {
        return;
      }
      throw err;
    }
  }

  // utility function so that the user can check if their customer has a payment method on file
  // useful for conditionally showing a top-up button
  async function hasPaymentMethod(params: { userId: string }): Promise<boolean> {
    const { userId } = params;
    const customer = await getCustomerByUserId(userId);
    return !!customer?.defaultPaymentMethod;
  }

  /**
   * Check if auto top-up should be triggered and execute it if needed.
   * Called after credits are consumed to replenish when balance drops below threshold.
   *
   * Implements failure tracking with cooldown:
   * - Hard declines (expired, stolen, etc.) disable auto top-up until payment method changes
   * - Soft declines (insufficient funds, etc.) have 24h cooldown before retry
   * - After 3 soft declines, escalates to hard (permanent disable)
   */
  async function triggerAutoTopUpIfNeeded(params: {
    userId: string;
    key: string;
    currentBalance: number;
  }): Promise<AutoTopUpResult> {
    const { userId, key, currentBalance } = params;

    const customer = await getCustomerByUserId(userId);
    if (!customer || customer.deleted) {
      return { triggered: false, reason: "user_not_found" };
    }

    // Capture values for use in nested functions (TypeScript narrowing doesn't flow through)
    const customerId = customer.id;
    const customerDefaultPM = customer.defaultPaymentMethod;

    const subscription = await getActiveSubscription(customerId);
    if (!subscription) {
      return { triggered: false, reason: "no_subscription" };
    }

    const plan = billingConfig?.[mode]?.plans?.find((p) =>
      p.price.some((pr) => pr.id === subscription.priceId)
    );
    if (!plan) {
      return { triggered: false, reason: "not_configured" };
    }

    const features = plan.features || {};
    const featureConfig = features[key];
    if (!featureConfig?.pricePerCredit || !featureConfig.autoTopUp) {
      return { triggered: false, reason: "not_configured" };
    }

    // Disallow auto top-ups when usage tracking is enabled
    if (isUsageTrackingEnabled(featureConfig)) {
      return { triggered: false, reason: "not_configured" };
    }

    const { pricePerCredit } = featureConfig;
    const {
      threshold: balanceThreshold,
      amount: purchaseAmount,
      maxPerMonth = 10,
    } = featureConfig.autoTopUp;

    // Validate config to fail fast with clear errors
    if (
      purchaseAmount <= 0 ||
      balanceThreshold <= 0 ||
      pricePerCredit <= 0
    ) {
      console.error(
        `Invalid auto top-up config for ${key}: purchaseAmount=${purchaseAmount}, balanceThreshold=${balanceThreshold}, pricePerCredit=${pricePerCredit}`
      );
      return { triggered: false, reason: "not_configured" };
    }

    if (currentBalance >= balanceThreshold) {
      return { triggered: false, reason: "balance_above_threshold" };
    }

    // Check for existing failure record (cooldown/disabled)
    const failure = await db.getAutoTopUpStatus({ userId, key });
    if (failure?.disabled) {
      // Hard decline or escalated soft decline (3+ failures) - blocked permanently
      if (failure.declineType === "hard" || failure.failureCount >= 3) {
        await onAutoTopUpFailed?.({
          userId,
          stripeCustomerId: customerId,
          key,
          trigger: "blocked_until_card_updated",
          status: "action_required",
          failureCount: failure.failureCount,
          stripeDeclineCode: failure.declineCode ?? undefined,
        });
        return { triggered: false, reason: "disabled_hard_decline" };
      }

      // Soft decline - check if 24h cooldown has passed
      const COOLDOWN_MS = 24 * 60 * 60 * 1000;
      const cooldownEnd = new Date(failure.lastFailureAt.getTime() + COOLDOWN_MS);
      if (new Date() < cooldownEnd) {
        await onAutoTopUpFailed?.({
          userId,
          stripeCustomerId: customerId,
          key,
          trigger: "waiting_for_retry_cooldown",
          status: "will_retry",
          nextAttemptAt: cooldownEnd,
          failureCount: failure.failureCount,
          stripeDeclineCode: failure.declineCode ?? undefined,
        });
        return {
          triggered: false,
          reason: "in_cooldown",
          retriesAt: cooldownEnd,
        };
      }
    }

    // Fire onCreditsLow before attempting auto top-up
    await onCreditsLow?.({
      userId,
      key,
      balance: currentBalance,
      threshold: balanceThreshold,
    });

    if (!customerDefaultPM) {
      await onAutoTopUpFailed?.({
        userId,
        stripeCustomerId: customerId,
        key,
        trigger: "no_payment_method",
        status: "action_required",
        failureCount: failure?.failureCount ?? 0,
      });
      return { triggered: false, reason: "no_payment_method" };
    }

    const autoTopUpsThisMonth = await db.countAutoTopUpsThisMonth(
      userId,
      key
    );
    if (autoTopUpsThisMonth >= maxPerMonth) {
      await onAutoTopUpFailed?.({
        userId,
        stripeCustomerId: customerId,
        key,
        trigger: "monthly_limit_reached",
        status: "will_retry", // Resets next month
        failureCount: failure?.failureCount ?? 0,
      });
      return { triggered: false, reason: "max_per_month_reached" };
    }

    const totalCents = purchaseAmount * pricePerCredit;
    const currency = subscription.currency;

    // Idempotency key prevents duplicate charges from concurrent triggers.
    // Two concurrent consume() calls that both trigger auto top-up will use
    // the same key (based on current count), and Stripe will dedupe one.
    // Include payment method ID so a new card gets a fresh key after recovery.
    const now = new Date();
    const yearMonth = `${now.getUTCFullYear()}-${String(
      now.getUTCMonth() + 1
    ).padStart(2, "0")}`;
    const pmSuffix = customerDefaultPM.slice(-8);
    const idempotencyKey = `auto_topup_${userId}_${key}_${yearMonth}_${
      autoTopUpsThisMonth + 1
    }_${pmSuffix}`;

    // Use configured displayName if available, otherwise construct from ID
    const displayName =
      featureConfig.displayName ||
      key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    // Helper to record failure and fire callback
    async function handlePaymentFailure(
      declineCode: string | undefined,
      errorMessage: string
    ): Promise<AutoTopUpFailed> {
      const declineType = classifyDeclineCode(declineCode);
      const failureRecord = await db.recordTopUpFailure({
        userId,
        key,
        paymentMethodId: customerDefaultPM,
        declineType,
        declineCode: declineCode ?? null,
      });

      // Determine status: action_required if hard decline or 3+ failures
      const isActionRequired =
        declineType === "hard" || failureRecord.failureCount >= 3;

      // Calculate next retry time for soft declines that haven't escalated
      const COOLDOWN_MS = 24 * 60 * 60 * 1000;
      const nextAttemptAt = !isActionRequired
        ? new Date(failureRecord.lastFailureAt.getTime() + COOLDOWN_MS)
        : undefined;

      await onAutoTopUpFailed?.({
        userId,
        stripeCustomerId: customerId,
        key,
        trigger: "stripe_declined_payment",
        status: isActionRequired ? "action_required" : "will_retry",
        nextAttemptAt,
        failureCount: failureRecord.failureCount,
        stripeDeclineCode: declineCode,
      });

      return {
        triggered: false,
        reason: "payment_failed",
        error: errorMessage,
        declineCode,
        declineType,
      };
    }

    // Helper to handle success
    async function handlePaymentSuccess(): Promise<void> {
      // Clear any existing failure record on success
      if (failure) {
        await db.unblockAutoTopUp({ userId, key });
      }
    }

    try {
      if (useInvoices) {
        // B2B MODE: Create invoice (proper receipts, shows in Customer Portal)
        // Create invoice FIRST with pending_invoice_items_behavior: "exclude"
        // to prevent items going to subscription's upcoming invoice
        const invoice = await stripe.invoices.create(
          {
            customer: customerId,
            auto_advance: false,
            pending_invoice_items_behavior: "exclude",
            // Enable automatic tax if configured
            ...(tax?.automaticTax && { automatic_tax: { enabled: true } }),
            metadata: {
              top_up_key: key,
              top_up_amount: String(purchaseAmount),
              user_id: userId,
              top_up_auto: "true",
            },
          },
          { idempotencyKey: `${idempotencyKey}_invoice` }
        );

        // Add item to this specific invoice
        // Use unit_amount_decimal + quantity for proper invoice display
        await stripe.invoiceItems.create(
          {
            customer: customerId,
            invoice: invoice.id,
            unit_amount_decimal: String(pricePerCredit),
            quantity: purchaseAmount,
            currency,
            description: `${displayName} (auto top-up)`,
          },
          { idempotencyKey: `${idempotencyKey}_item` }
        );

        let paidInvoice: Stripe.Invoice;
        try {
          paidInvoice = await stripe.invoices.pay(
            invoice.id,
            {},
            { idempotencyKey: `${idempotencyKey}_pay` }
          );
        } catch (payErr) {
          // Payment failed - void the invoice to prevent future confusion
          await stripe.invoices.voidInvoice(invoice.id).catch(() => {});
          throw payErr;
        }

        if (paidInvoice.status === "paid") {
          await handlePaymentSuccess();
          await grantCreditsFromInvoice(paidInvoice);
          return {
            triggered: true,
            status: "succeeded",
            sourceId: paidInvoice.id,
          };
        }

        // Invoice not paid (unusual status) - void it
        await stripe.invoices.voidInvoice(invoice.id).catch(() => {});
        return handlePaymentFailure(
          undefined,
          `Invoice status: ${paidInvoice.status}`
        );
      } else {
        // B2C MODE: Use PaymentIntent directly (cheaper, no Invoicing fee)
        const paymentIntent = await stripe.paymentIntents.create(
          {
            amount: totalCents,
            currency,
            customer: customerId,
            payment_method: customerDefaultPM,
            confirm: true,
            off_session: true,
            metadata: {
              top_up_key: key,
              top_up_amount: String(purchaseAmount),
              user_id: userId,
              top_up_auto: "true",
            },
          },
          { idempotencyKey }
        );

        if (paymentIntent.status === "succeeded") {
          await handlePaymentSuccess();
          await grantCreditsFromPayment(paymentIntent); // this call is also idempotent
          return {
            triggered: true,
            status: "succeeded",
            sourceId: paymentIntent.id,
          };
        }

        if (paymentIntent.status === "processing") {
          // Webhook will handle granting credits when payment completes
          // Don't clear failure yet - wait for actual success
          return {
            triggered: true,
            status: "pending",
            sourceId: paymentIntent.id,
          };
        }

        // requires_action, requires_payment_method, etc. - user not present to handle
        const declineCode = paymentIntent.last_payment_error?.decline_code;
        return handlePaymentFailure(
          declineCode ?? undefined,
          `Payment requires action: ${paymentIntent.status}`
        );
      }
    } catch (err) {
      // Extract decline code from Stripe error if available
      // Stripe errors can have decline_code at top level or nested in raw
      const stripeError = err as {
        type?: string;
        code?: string;
        decline_code?: string;
        message?: string;
        raw?: {
          code?: string;
          decline_code?: string;
        };
      };

      // Try multiple locations for the decline code
      const declineCode =
        stripeError.decline_code ??
        stripeError.raw?.decline_code ??
        stripeError.code ??
        stripeError.raw?.code;

      const message = stripeError.message ?? "Payment failed";

      // Log for debugging
      console.error("Auto top-up payment error:", {
        type: stripeError.type,
        code: stripeError.code,
        decline_code: stripeError.decline_code,
        raw_code: stripeError.raw?.code,
        raw_decline_code: stripeError.raw?.decline_code,
        resolved_decline_code: declineCode,
      });

      return handlePaymentFailure(declineCode, message);
    }
  }

  async function handleCustomerUpdated(
    customer: Stripe.Customer,
    previousAttributes?: Partial<Stripe.Customer>
  ): Promise<void> {
    // Only care about payment method changes
    const prevDefaultPM = (
      previousAttributes?.invoice_settings as
        | { default_payment_method?: string | null }
        | undefined
    )?.default_payment_method;

    // If previous attributes don't include invoice_settings, this wasn't a payment method change
    if (prevDefaultPM === undefined) {
      return;
    }

    const newDefaultPM =
      typeof customer.invoice_settings?.default_payment_method === "string"
        ? customer.invoice_settings.default_payment_method
        : customer.invoice_settings?.default_payment_method?.id;

    // No actual change
    if (prevDefaultPM === newDefaultPM) {
      return;
    }

    // Get user_id from customer metadata
    const userId = customer.metadata?.user_id;
    if (!userId) {
      return;
    }

    // Payment method changed - clear all failures for this user
    // (they've taken action to fix their payment method)
    await db.unblockAllAutoTopUps({ userId });
  }

  return {
    topUp,
    hasPaymentMethod,
    triggerAutoTopUpIfNeeded,
    handlePaymentIntentSucceeded,
    handleTopUpCheckoutCompleted,
    handleInvoicePaid,
    handleCustomerUpdated,
  };
}
