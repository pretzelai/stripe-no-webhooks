import type Stripe from "stripe";
import type { Pool } from "pg";
import type { BillingConfig } from "../BillingConfig";
import type { TaxConfig } from "../types";
import { credits } from "./index";
import * as db from "./db";
import { CreditError } from "./types";

export type TopUpSuccess = {
  success: true;
  balance: number;
  charged: { amountCents: number; currency: string };
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
  creditType: string;
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
    | "user_not_found";
};

export type AutoTopUpFailed = {
  triggered: false;
  reason: "payment_failed" | "payment_requires_action";
  error: string;
};

export type AutoTopUpResult =
  | AutoTopUpTriggered
  | AutoTopUpSkipped
  | AutoTopUpFailed;

export type AutoTopUpFailedReason =
  | "max_per_month_reached"
  | "no_payment_method"
  | "payment_failed"
  | "payment_requires_action"
  | "unexpected_error";

export type TopUpHandler = {
  topUp: (params: TopUpParams) => Promise<TopUpResult>;
  hasPaymentMethod: (userId: string) => Promise<boolean>;
  triggerAutoTopUpIfNeeded: (params: {
    userId: string;
    creditType: string;
    currentBalance: number;
  }) => Promise<AutoTopUpResult>;
  handlePaymentIntentSucceeded: (paymentIntent: Stripe.PaymentIntent) => Promise<void>;
  handleTopUpCheckoutCompleted: (session: Stripe.Checkout.Session) => Promise<void>;
  handleInvoicePaid: (invoice: Stripe.Invoice) => Promise<void>;
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
    creditType: string;
    amount: number;
    newBalance: number;
    source: "topup" | "auto_topup";
    sourceId: string;
  }) => void | Promise<void>;
  onTopUpCompleted?: (params: {
    userId: string;
    creditType: string;
    creditsAdded: number;
    amountCharged: number;
    currency: string;
    newBalance: number;
    sourceId: string;
  }) => void | Promise<void>;
  onAutoTopUpFailed?: (params: {
    userId: string;
    creditType: string;
    reason: AutoTopUpFailedReason;
    error?: string;
  }) => void | Promise<void>;
  onCreditsLow?: (params: {
    userId: string;
    creditType: string;
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
    creditType: string,
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

    const displayName = creditType
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "payment",
      payment_method_types: ["card"],
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
        top_up_credit_type: creditType,
        top_up_amount: String(amount),
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
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
   * Try to create a recovery checkout, returning undefined if it fails.
   * This prevents recovery checkout errors from masking the original payment error.
   */
  async function tryCreateRecoveryCheckout(
    customerId: string,
    creditType: string,
    amount: number,
    totalCents: number,
    currency: string
  ): Promise<string | undefined> {
    try {
      return await createRecoveryCheckout(
        customerId,
        creditType,
        amount,
        totalCents,
        currency
      );
    } catch (err) {
      // Log but don't throw - we still want to return the original error
      console.error("Failed to create recovery checkout:", err);
      return undefined;
    }
  }

  /**
   * B2B Recovery: Create a hosted invoice URL for customers without payment method.
   * The customer can pay via Stripe's hosted invoice page.
   */
  async function createRecoveryInvoice(
    customerId: string,
    creditType: string,
    amount: number,
    totalCents: number,
    currency: string,
    userId: string,
    displayName: string
  ): Promise<string> {
    // Create invoice FIRST, then add items to it (prevents items going to subscription)
    const invoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: "send_invoice",
      days_until_due: 7,
      pending_invoice_items_behavior: "exclude",
      // Enable automatic tax if configured
      ...(tax?.automaticTax && { automatic_tax: { enabled: true } }),
      metadata: {
        top_up_credit_type: creditType,
        top_up_amount: String(amount),
        user_id: userId,
      },
    });

    // Add invoice item to this specific invoice
    // Use unit_amount_decimal + quantity for proper invoice display (e.g., "50 x $0.10")
    const unitAmount = Math.round(totalCents / amount);
    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoice.id,
      unit_amount_decimal: String(unitAmount),
      quantity: amount,
      currency,
      description: `${displayName} (credit top-up)`,
    });

    // Finalize to get hosted URL
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);

    if (!finalizedInvoice.hosted_invoice_url) {
      throw new CreditError("INVOICE_ERROR", "Failed to get invoice URL");
    }

    return finalizedInvoice.hosted_invoice_url;
  }

  /**
   * Try to create a recovery URL, returning undefined if it fails.
   * Uses invoice URL for B2B mode, checkout session for B2C mode.
   */
  async function tryCreateRecoveryUrl(
    customerId: string,
    creditType: string,
    amount: number,
    totalCents: number,
    currency: string,
    userId: string,
    displayName: string
  ): Promise<string | undefined> {
    try {
      if (useInvoices) {
        return await createRecoveryInvoice(
          customerId,
          creditType,
          amount,
          totalCents,
          currency,
          userId,
          displayName
        );
      } else {
        return await createRecoveryCheckout(
          customerId,
          creditType,
          amount,
          totalCents,
          currency
        );
      }
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
    const creditType = invoice.metadata?.top_up_credit_type;
    const amountStr = invoice.metadata?.top_up_amount;
    const userId = invoice.metadata?.user_id;
    const isAuto = invoice.metadata?.top_up_auto === "true";

    if (!creditType || !amountStr || !userId) {
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
        creditType,
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
        newBalance = await credits.getBalance(userId, creditType);
        alreadyGranted = true;
      } else {
        throw grantErr;
      }
    }

    if (!alreadyGranted) {
      await onCreditsGranted?.({
        userId,
        creditType,
        amount,
        newBalance,
        source,
        sourceId: invoice.id,
      });
      await onTopUpCompleted?.({
        userId,
        creditType,
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
    const { userId, creditType, amount, idempotencyKey } = params;

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

    const creditConfig = plan.credits?.[creditType];
    if (!creditConfig?.pricePerCreditCents) {
      return {
        success: false,
        error: {
          code: "TOPUP_NOT_CONFIGURED",
          message: `Top-up not configured for ${creditType}`,
        },
      };
    }

    const {
      pricePerCreditCents,
      minPerPurchase = 1,
      maxPerPurchase,
    } = creditConfig;
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

    const totalCents = amount * pricePerCreditCents;

    // Stripe requires minimum ~50 cents in most currencies, use 60 to be safe with conversion
    const STRIPE_MIN_CENTS = 60;
    if (totalCents < STRIPE_MIN_CENTS) {
      return {
        success: false,
        error: {
          code: "INVALID_AMOUNT",
          message: `Minimum purchase amount is ${STRIPE_MIN_CENTS} cents (${Math.ceil(STRIPE_MIN_CENTS / pricePerCreditCents)} credits at current price)`,
        },
      };
    }
    const currency = subscription.currency;

    // Use configured displayName if available, otherwise construct from ID
    const displayName =
      creditConfig.displayName ||
      creditType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    if (!customer.defaultPaymentMethod) {
      const recoveryUrl = await tryCreateRecoveryUrl(
        customer.id,
        creditType,
        amount,
        totalCents,
        currency,
        userId,
        displayName
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
              top_up_credit_type: creditType,
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
            unit_amount_decimal: String(pricePerCreditCents),
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
            charged: { amountCents: totalCents, currency },
            sourceId: paidInvoice.id,
          };
        }

        // Invoice not paid (unusual status) - void it and offer recovery
        await stripe.invoices.voidInvoice(invoice.id).catch(() => {});
        const recoveryUrl = await tryCreateRecoveryUrl(
          customer.id,
          creditType,
          amount,
          totalCents,
          currency,
          userId,
          displayName
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
              top_up_credit_type: creditType,
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
            charged: { amountCents: totalCents, currency },
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
          creditType,
          amount,
          totalCents,
          currency,
          userId,
          displayName
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
      const isCardError = stripeError.type === "card_error";
      const isInvalidRequest = stripeError.type === "invalid_request_error";
      const errorCode = stripeError.code;
      const message = stripeError.message || "Payment failed";

      // For card errors (declined, insufficient funds), offer recovery
      if (isCardError) {
        const recoveryUrl = await tryCreateRecoveryUrl(
          customer.id,
          creditType,
          amount,
          totalCents,
          currency,
          userId,
          displayName
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

      // Invalid request or other Stripe error - return without recovery URL
      return {
        success: false,
        error: {
          code: isInvalidRequest ? "INVALID_AMOUNT" : "PAYMENT_FAILED",
          message: errorCode ? `${errorCode}: ${message}` : message,
        },
      };
    }
  }

  /** Grant credits from a successful payment. Used by both inline and webhook paths. */
  async function grantCreditsFromPayment(
    paymentIntent: Stripe.PaymentIntent
  ): Promise<number> {
    const creditType = paymentIntent.metadata?.top_up_credit_type;
    const amountStr = paymentIntent.metadata?.top_up_amount;
    const userId = paymentIntent.metadata?.user_id;
    const isAuto = paymentIntent.metadata?.top_up_auto === "true";

    if (!creditType || !amountStr || !userId) {
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
        creditType,
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
        newBalance = await credits.getBalance(userId, creditType);
        alreadyGranted = true;
      } else {
        throw grantErr;
      }
    }

    // Only fire callbacks if this is the first grant (not a duplicate)
    if (!alreadyGranted) {
      await onCreditsGranted?.({
        userId,
        creditType,
        amount,
        newBalance,
        source,
        sourceId: paymentIntent.id,
      });
      await onTopUpCompleted?.({
        userId,
        creditType,
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
    if (!paymentIntent.metadata?.top_up_credit_type) {
      return;
    }
    await grantCreditsFromPayment(paymentIntent);
  }

  async function handleTopUpCheckoutCompleted(
    session: Stripe.Checkout.Session
  ): Promise<void> {
    const creditType = session.metadata?.top_up_credit_type;
    const amountStr = session.metadata?.top_up_amount;
    if (!creditType || !amountStr) return; // Not a top-up checkout

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

    let newBalance: number;
    try {
      // Use same idempotency key format as grantCreditsFromPayment
      // This ensures if both checkout.session.completed AND payment_intent.succeeded
      // fire for the same payment, only one grant occurs
      newBalance = await credits.grant({
        userId,
        creditType,
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
      creditType,
      amount,
      newBalance,
      source: "topup",
      sourceId: paymentIntentId,
    });
    await onTopUpCompleted?.({
      userId,
      creditType,
      creditsAdded: amount,
      amountCharged: session.amount_total ?? 0,
      currency: session.currency ?? "usd",
      newBalance,
      sourceId: paymentIntentId,
    });
  }

  /**
   * Handle invoice.paid webhook for B2B mode top-up invoices.
   * Credits are typically granted inline when invoice.pay() succeeds,
   * but this handles edge cases (async payment, retry after failure).
   */
  async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    // Only process top-up invoices (not subscription invoices)
    if (!invoice.metadata?.top_up_credit_type) {
      return;
    }

    try {
      await grantCreditsFromInvoice(invoice);
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
  async function hasPaymentMethod(userId: string): Promise<boolean> {
    const customer = await getCustomerByUserId(userId);
    return !!customer?.defaultPaymentMethod;
  }

  /**
   * Check if auto top-up should be triggered and execute it if needed.
   * Called after credits are consumed to replenish when balance drops below threshold.
   */
  async function triggerAutoTopUpIfNeeded(params: {
    userId: string;
    creditType: string;
    currentBalance: number;
  }): Promise<AutoTopUpResult> {
    const { userId, creditType, currentBalance } = params;

    const customer = await getCustomerByUserId(userId);
    if (!customer || customer.deleted) {
      return { triggered: false, reason: "user_not_found" };
    }

    const subscription = await getActiveSubscription(customer.id);
    if (!subscription) {
      return { triggered: false, reason: "no_subscription" };
    }

    const plan = billingConfig?.[mode]?.plans?.find((p) =>
      p.price.some((pr) => pr.id === subscription.priceId)
    );
    if (!plan) {
      return { triggered: false, reason: "not_configured" };
    }

    const creditConfig = plan.credits?.[creditType];
    if (!creditConfig?.pricePerCreditCents || !creditConfig.autoTopUp) {
      return { triggered: false, reason: "not_configured" };
    }

    const { pricePerCreditCents } = creditConfig;
    const {
      threshold: balanceThreshold,
      amount: purchaseAmount,
      maxPerMonth = 10,
    } = creditConfig.autoTopUp;

    // Validate config to fail fast with clear errors
    if (
      purchaseAmount <= 0 ||
      balanceThreshold <= 0 ||
      pricePerCreditCents <= 0
    ) {
      console.error(
        `Invalid auto top-up config for ${creditType}: purchaseAmount=${purchaseAmount}, balanceThreshold=${balanceThreshold}, pricePerCreditCents=${pricePerCreditCents}`
      );
      return { triggered: false, reason: "not_configured" };
    }

    if (currentBalance >= balanceThreshold) {
      return { triggered: false, reason: "balance_above_threshold" };
    }

    // Fire onCreditsLow before attempting auto top-up
    await onCreditsLow?.({
      userId,
      creditType,
      balance: currentBalance,
      threshold: balanceThreshold,
    });

    if (!customer.defaultPaymentMethod) {
      await onAutoTopUpFailed?.({
        userId,
        creditType,
        reason: "no_payment_method",
      });
      return { triggered: false, reason: "no_payment_method" };
    }

    const autoTopUpsThisMonth = await db.countAutoTopUpsThisMonth(
      userId,
      creditType
    );
    if (autoTopUpsThisMonth >= maxPerMonth) {
      await onAutoTopUpFailed?.({
        userId,
        creditType,
        reason: "max_per_month_reached",
      });
      return { triggered: false, reason: "max_per_month_reached" };
    }

    const totalCents = purchaseAmount * pricePerCreditCents;
    const currency = subscription.currency;

    // Idempotency key prevents duplicate charges from concurrent triggers.
    // Two concurrent consume() calls that both trigger auto top-up will use
    // the same key (based on current count), and Stripe will dedupe one.
    const now = new Date();
    const yearMonth = `${now.getUTCFullYear()}-${String(
      now.getUTCMonth() + 1
    ).padStart(2, "0")}`;
    const idempotencyKey = `auto_topup_${userId}_${creditType}_${yearMonth}_${
      autoTopUpsThisMonth + 1
    }`;

    // Use configured displayName if available, otherwise construct from ID
    const displayName =
      creditConfig.displayName ||
      creditType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    try {
      if (useInvoices) {
        // B2B MODE: Create invoice (proper receipts, shows in Customer Portal)
        // Create invoice FIRST with pending_invoice_items_behavior: "exclude"
        // to prevent items going to subscription's upcoming invoice
        const invoice = await stripe.invoices.create(
          {
            customer: customer.id,
            auto_advance: false,
            pending_invoice_items_behavior: "exclude",
            // Enable automatic tax if configured
            ...(tax?.automaticTax && { automatic_tax: { enabled: true } }),
            metadata: {
              top_up_credit_type: creditType,
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
            customer: customer.id,
            invoice: invoice.id,
            unit_amount_decimal: String(pricePerCreditCents),
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
          await grantCreditsFromInvoice(paidInvoice);
          return {
            triggered: true,
            status: "succeeded",
            sourceId: paidInvoice.id,
          };
        }

        // Invoice not paid (unusual status) - void it
        await stripe.invoices.voidInvoice(invoice.id).catch(() => {});
        const message = `Invoice status: ${paidInvoice.status}`;
        await onAutoTopUpFailed?.({
          userId,
          creditType,
          reason: "payment_requires_action",
          error: message,
        });
        return {
          triggered: false,
          reason: "payment_requires_action",
          error: message,
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
              top_up_credit_type: creditType,
              top_up_amount: String(purchaseAmount),
              user_id: userId,
              top_up_auto: "true",
            },
          },
          { idempotencyKey }
        );

        if (paymentIntent.status === "succeeded") {
          await grantCreditsFromPayment(paymentIntent); // this call is also idempotent
          return {
            triggered: true,
            status: "succeeded",
            sourceId: paymentIntent.id,
          };
        }

        if (paymentIntent.status === "processing") {
          // Webhook will handle granting credits when payment completes
          return {
            triggered: true,
            status: "pending",
            sourceId: paymentIntent.id,
          };
        }

        // requires_action, requires_payment_method, etc. - user not present to handle
        const message = `Payment requires action: ${paymentIntent.status}`;
        await onAutoTopUpFailed?.({
          userId,
          creditType,
          reason: "payment_requires_action",
          error: message,
        });
        return {
          triggered: false,
          reason: "payment_requires_action",
          error: message,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Payment failed";
      await onAutoTopUpFailed?.({
        userId,
        creditType,
        reason: "payment_failed",
        error: message,
      });
      return {
        triggered: false,
        reason: "payment_failed",
        error: message,
      };
    }
  }

  return {
    topUp,
    hasPaymentMethod,
    triggerAutoTopUpIfNeeded,
    handlePaymentIntentSucceeded,
    handleTopUpCheckoutCompleted,
    handleInvoicePaid,
  };
}
