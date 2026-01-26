import type Stripe from "stripe";
import type { Pool } from "pg";
import type { BillingConfig, WalletConfig } from "../BillingConfig";
import type { TaxConfig } from "../types";
import * as walletModule from "./index";
import * as db from "../credits/db";
import { CreditError } from "../credits/types";

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

function classifyDeclineCode(code: string | undefined): "hard" | "soft" {
  if (!code) return "soft";
  if (HARD_DECLINE_CODES.has(code)) return "hard";
  return "soft";
}

export type WalletTopUpSuccess = {
  success: true;
  balance: walletModule.WalletBalance;
  charged: { amount: number; currency: string };
  sourceId: string;
};

export type WalletTopUpPending = {
  success: true;
  status: "pending";
  sourceId: string;
  message: string;
};

export type WalletTopUpFailure = {
  success: false;
  error: {
    code:
      | "NO_PAYMENT_METHOD"
      | "PAYMENT_FAILED"
      | "WALLET_NOT_CONFIGURED"
      | "INVALID_AMOUNT"
      | "NO_SUBSCRIPTION"
      | "USER_NOT_FOUND";
    message: string;
    recoveryUrl?: string;
  };
};

export type WalletTopUpResult = WalletTopUpSuccess | WalletTopUpPending | WalletTopUpFailure;

export type WalletTopUpParams = {
  userId: string;
  /** Amount to add in cents */
  amount: number;
  /** Optional idempotency key to prevent duplicate charges on retry */
  idempotencyKey?: string;
};

export type WalletAutoTopUpTriggered = {
  triggered: true;
  status: "succeeded" | "pending";
  sourceId: string;
};

export type WalletAutoTopUpSkipped = {
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

export type WalletAutoTopUpFailed = {
  triggered: false;
  reason: "payment_failed" | "payment_requires_action";
  error: string;
  declineCode?: string;
  declineType?: "hard" | "soft";
};

export type WalletAutoTopUpResult =
  | WalletAutoTopUpTriggered
  | WalletAutoTopUpSkipped
  | WalletAutoTopUpFailed;

export type WalletAutoTopUpFailedTrigger =
  | "stripe_declined_payment"
  | "waiting_for_retry_cooldown"
  | "blocked_until_card_updated"
  | "no_payment_method"
  | "monthly_limit_reached"
  | "unexpected_error";

export type WalletAutoTopUpFailedCallbackParams = {
  userId: string;
  stripeCustomerId: string;
  trigger: WalletAutoTopUpFailedTrigger;
  status: "will_retry" | "action_required";
  nextAttemptAt?: Date;
  failureCount: number;
  stripeDeclineCode?: string;
};

export type WalletTopUpHandler = {
  topUp: (params: WalletTopUpParams) => Promise<WalletTopUpResult>;
  triggerAutoTopUpIfNeeded: (params: {
    userId: string;
    currentBalance: number;
  }) => Promise<WalletAutoTopUpResult>;
  handlePaymentIntentSucceeded: (paymentIntent: Stripe.PaymentIntent) => Promise<void>;
  handleTopUpCheckoutCompleted: (session: Stripe.Checkout.Session) => Promise<void>;
  handleInvoicePaid: (invoice: Stripe.Invoice) => Promise<void>;
  handleCustomerUpdated: (
    customer: Stripe.Customer,
    previousAttributes?: Partial<Stripe.Customer>
  ) => Promise<void>;
};

const WALLET_KEY = "wallet";

export function createWalletTopUpHandler(deps: {
  stripe: Stripe;
  pool: Pool | null;
  schema: string;
  billingConfig?: BillingConfig;
  mode: "test" | "production";
  successUrl: string;
  cancelUrl: string;
  tax?: TaxConfig;
  onWalletTopUpCompleted?: (params: {
    userId: string;
    amountAdded: number;
    amountCharged: number;
    currency: string;
    newBalance: walletModule.WalletBalance;
    sourceId: string;
  }) => void | Promise<void>;
  onWalletAutoTopUpFailed?: (params: WalletAutoTopUpFailedCallbackParams) => void | Promise<void>;
  onWalletLow?: (params: {
    userId: string;
    balance: number;
    threshold: number;
  }) => void | Promise<void>;
}): WalletTopUpHandler {
  const {
    stripe,
    pool,
    schema,
    billingConfig,
    mode,
    successUrl,
    cancelUrl,
    tax,
    onWalletTopUpCompleted,
    onWalletAutoTopUpFailed,
    onWalletLow,
  } = deps;

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

  function getWalletConfig(priceId: string): WalletConfig | null {
    const plan = billingConfig?.[mode]?.plans?.find((p) =>
      p.price.some((pr) => pr.id === priceId)
    );
    return plan?.wallet ?? null;
  }

  async function createRecoveryCheckout(
    customerId: string,
    amountCents: number,
    currency: string
  ): Promise<string> {
    if (!successUrl || !cancelUrl) {
      throw new CreditError(
        "MISSING_CONFIG",
        "successUrl and cancelUrl are required for recovery checkout"
      );
    }

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
            unit_amount: amountCents,
            product_data: {
              name: `Wallet top-up`,
              description: `Add ${walletModule.formatWalletBalance(walletModule.centsToMicroCents(amountCents), currency)} to wallet`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        wallet_top_up: "true",
        wallet_top_up_amount: String(amountCents),
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
      ...(tax?.automaticTax && { automatic_tax: { enabled: true } }),
      ...(tax?.taxIdCollection && { tax_id_collection: { enabled: true } }),
      ...((tax?.automaticTax || tax?.taxIdCollection) && {
        customer_update: { address: "auto", name: "auto" },
      }),
    });

    if (!session.url) {
      throw new CreditError("CHECKOUT_ERROR", "Failed to create checkout session URL");
    }
    return session.url;
  }

  async function tryCreateRecoveryUrl(
    customerId: string,
    amountCents: number,
    currency: string
  ): Promise<string | undefined> {
    try {
      return await createRecoveryCheckout(customerId, amountCents, currency);
    } catch (err) {
      console.error("Failed to create wallet recovery URL:", err);
      return undefined;
    }
  }

  async function addWalletFromPayment(
    paymentIntent: Stripe.PaymentIntent,
    isAuto: boolean
  ): Promise<walletModule.WalletBalance> {
    const amountStr = paymentIntent.metadata?.wallet_top_up_amount;
    const userId = paymentIntent.metadata?.user_id;

    if (!amountStr || !userId) {
      throw new CreditError("INVALID_METADATA", "Missing wallet top-up metadata on PaymentIntent");
    }

    const amountCents = parseInt(amountStr, 10);
    if (isNaN(amountCents) || amountCents <= 0) {
      throw new CreditError("INVALID_METADATA", "Invalid wallet_top_up_amount in PaymentIntent metadata");
    }

    const source = isAuto ? "auto_topup" : "topup";
    let result: { balance: walletModule.WalletBalance };

    try {
      result = await walletModule.add({
        userId,
        amount: amountCents,
        currency: paymentIntent.currency,
        source,
        sourceId: paymentIntent.id,
        idempotencyKey: `wallet_topup_${paymentIntent.id}`,
      });
    } catch (err) {
      if (err instanceof CreditError && err.code === "IDEMPOTENCY_CONFLICT") {
        // Already processed - return current balance without firing callback
        const balance = await walletModule.getBalance({ userId });
        if (!balance) {
          throw new CreditError("WALLET_ERROR", "Wallet not found after idempotent add");
        }
        return balance;
      }
      throw err;
    }

    await onWalletTopUpCompleted?.({
      userId,
      amountAdded: amountCents,
      amountCharged: paymentIntent.amount,
      currency: paymentIntent.currency,
      newBalance: result.balance,
      sourceId: paymentIntent.id,
    });

    return result.balance;
  }

  async function addWalletFromInvoice(invoice: Stripe.Invoice): Promise<walletModule.WalletBalance> {
    const amountStr = invoice.metadata?.wallet_top_up_amount;
    const userId = invoice.metadata?.user_id;
    const isAuto = invoice.metadata?.wallet_top_up_auto === "true";

    if (!amountStr || !userId) {
      throw new CreditError("INVALID_METADATA", "Missing wallet top-up metadata on Invoice");
    }

    const amountCents = parseInt(amountStr, 10);
    if (isNaN(amountCents) || amountCents <= 0) {
      throw new CreditError("INVALID_METADATA", "Invalid wallet_top_up_amount in Invoice metadata");
    }

    const source = isAuto ? "auto_topup" : "topup";
    let result: { balance: walletModule.WalletBalance };

    try {
      result = await walletModule.add({
        userId,
        amount: amountCents,
        currency: invoice.currency,
        source,
        sourceId: invoice.id,
        idempotencyKey: `wallet_topup_invoice_${invoice.id}`,
      });
    } catch (err) {
      if (err instanceof CreditError && err.code === "IDEMPOTENCY_CONFLICT") {
        const balance = await walletModule.getBalance({ userId });
        if (!balance) {
          throw new CreditError("WALLET_ERROR", "Wallet not found after idempotent add");
        }
        return balance;
      }
      throw err;
    }

    await onWalletTopUpCompleted?.({
      userId,
      amountAdded: amountCents,
      amountCharged: invoice.amount_paid,
      currency: invoice.currency,
      newBalance: result.balance,
      sourceId: invoice.id,
    });

    return result.balance;
  }

  async function topUp(params: WalletTopUpParams): Promise<WalletTopUpResult> {
    const { userId, amount: amountCents, idempotencyKey } = params;

    // Validate amount is a valid integer (Stripe requires integer cents)
    if (!Number.isFinite(amountCents) || !Number.isInteger(amountCents) || amountCents <= 0) {
      return {
        success: false,
        error: {
          code: "INVALID_AMOUNT",
          message: "Amount must be a positive integer (cents)",
        },
      };
    }

    const customer = await getCustomerByUserId(userId);
    if (!customer) {
      return {
        success: false,
        error: { code: "USER_NOT_FOUND", message: "No Stripe customer found for user" },
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
        error: { code: "NO_SUBSCRIPTION", message: "No active subscription found" },
      };
    }

    const walletConfig = getWalletConfig(subscription.priceId);
    if (!walletConfig) {
      return {
        success: false,
        error: { code: "WALLET_NOT_CONFIGURED", message: "Wallet not configured for this plan" },
      };
    }

    // Validate amount constraints
    const minAmount = walletConfig.minPerPurchase ?? 50; // Stripe minimum ~50 cents
    const maxAmount = walletConfig.maxPerPurchase;

    if (amountCents < minAmount) {
      return {
        success: false,
        error: {
          code: "INVALID_AMOUNT",
          message: `Minimum top-up is ${walletModule.formatWalletBalance(walletModule.centsToMicroCents(minAmount), subscription.currency)}`,
        },
      };
    }
    if (maxAmount !== undefined && amountCents > maxAmount) {
      return {
        success: false,
        error: {
          code: "INVALID_AMOUNT",
          message: `Maximum top-up is ${walletModule.formatWalletBalance(walletModule.centsToMicroCents(maxAmount), subscription.currency)}`,
        },
      };
    }

    const currency = subscription.currency;

    if (!customer.defaultPaymentMethod) {
      const recoveryUrl = await tryCreateRecoveryUrl(customer.id, amountCents, currency);
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
        // B2B mode: use invoices
        const invoice = await stripe.invoices.create(
          {
            customer: customer.id,
            auto_advance: false,
            pending_invoice_items_behavior: "exclude",
            ...(tax?.automaticTax && { automatic_tax: { enabled: true } }),
            metadata: {
              wallet_top_up: "true",
              wallet_top_up_amount: String(amountCents),
              user_id: userId,
            },
          },
          idempotencyKey ? { idempotencyKey: `${idempotencyKey}_invoice` } : undefined
        );

        await stripe.invoiceItems.create(
          {
            customer: customer.id,
            invoice: invoice.id,
            amount: amountCents,
            currency,
            description: "Wallet top-up",
          },
          idempotencyKey ? { idempotencyKey: `${idempotencyKey}_item` } : undefined
        );

        let paidInvoice: Stripe.Invoice;
        try {
          paidInvoice = await stripe.invoices.pay(
            invoice.id,
            {},
            idempotencyKey ? { idempotencyKey: `${idempotencyKey}_pay` } : undefined
          );
        } catch (payErr) {
          await stripe.invoices.voidInvoice(invoice.id).catch(() => {});
          throw payErr;
        }

        if (paidInvoice.status === "paid") {
          const newBalance = await addWalletFromInvoice(paidInvoice);
          return {
            success: true,
            balance: newBalance,
            charged: { amount: paidInvoice.amount_paid, currency },
            sourceId: paidInvoice.id,
          };
        }

        await stripe.invoices.voidInvoice(invoice.id).catch(() => {});
        const recoveryUrl = await tryCreateRecoveryUrl(customer.id, amountCents, currency);
        return {
          success: false,
          error: {
            code: "PAYMENT_FAILED",
            message: `Invoice status: ${paidInvoice.status}`,
            recoveryUrl,
          },
        };
      } else {
        // B2C mode: use PaymentIntent directly
        const paymentIntent = await stripe.paymentIntents.create(
          {
            amount: amountCents,
            currency,
            customer: customer.id,
            payment_method: customer.defaultPaymentMethod,
            confirm: true,
            off_session: true,
            metadata: {
              wallet_top_up: "true",
              wallet_top_up_amount: String(amountCents),
              user_id: userId,
            },
          },
          idempotencyKey ? { idempotencyKey } : undefined
        );

        if (paymentIntent.status === "succeeded") {
          const newBalance = await addWalletFromPayment(paymentIntent, false);
          return {
            success: true,
            balance: newBalance,
            charged: { amount: amountCents, currency },
            sourceId: paymentIntent.id,
          };
        }

        if (paymentIntent.status === "processing") {
          return {
            success: true,
            status: "pending",
            sourceId: paymentIntent.id,
            message: "Payment is processing. Wallet will be updated when payment completes.",
          };
        }

        const recoveryUrl = await tryCreateRecoveryUrl(customer.id, amountCents, currency);
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
      const stripeError = err as { type?: string; message?: string };
      const isDevError =
        stripeError.type === "invalid_request_error" ||
        stripeError.type === "authentication_error";
      const message = stripeError.message || "Payment failed";

      if (isDevError) {
        return {
          success: false,
          error: { code: "PAYMENT_FAILED", message },
        };
      }

      const recoveryUrl = await tryCreateRecoveryUrl(customer.id, amountCents, currency);
      return {
        success: false,
        error: { code: "PAYMENT_FAILED", message, recoveryUrl },
      };
    }
  }

  async function triggerAutoTopUpIfNeeded(params: {
    userId: string;
    currentBalance: number;
  }): Promise<WalletAutoTopUpResult> {
    const { userId, currentBalance } = params;

    const customer = await getCustomerByUserId(userId);
    if (!customer || customer.deleted) {
      return { triggered: false, reason: "user_not_found" };
    }

    const customerId = customer.id;
    const customerDefaultPM = customer.defaultPaymentMethod;

    const subscription = await getActiveSubscription(customerId);
    if (!subscription) {
      return { triggered: false, reason: "no_subscription" };
    }

    const walletConfig = getWalletConfig(subscription.priceId);
    if (!walletConfig?.autoTopUp) {
      return { triggered: false, reason: "not_configured" };
    }

    const { threshold, amount: purchaseAmount, maxPerMonth = 10 } = walletConfig.autoTopUp;

    // Validate config to fail fast with clear errors
    if (purchaseAmount <= 0 || threshold <= 0) {
      console.error(
        `Invalid wallet auto top-up config: purchaseAmount=${purchaseAmount}, threshold=${threshold}`
      );
      return { triggered: false, reason: "not_configured" };
    }

    if (currentBalance >= threshold) {
      return { triggered: false, reason: "balance_above_threshold" };
    }

    // Check for existing failure record
    const failure = await db.getAutoTopUpStatus({ userId, key: WALLET_KEY });
    if (failure?.disabled) {
      if (failure.declineType === "hard" || failure.failureCount >= 3) {
        await onWalletAutoTopUpFailed?.({
          userId,
          stripeCustomerId: customerId,
          trigger: "blocked_until_card_updated",
          status: "action_required",
          failureCount: failure.failureCount,
          stripeDeclineCode: failure.declineCode ?? undefined,
        });
        return { triggered: false, reason: "disabled_hard_decline" };
      }

      const COOLDOWN_MS = 24 * 60 * 60 * 1000;
      const cooldownEnd = new Date(failure.lastFailureAt.getTime() + COOLDOWN_MS);
      if (new Date() < cooldownEnd) {
        await onWalletAutoTopUpFailed?.({
          userId,
          stripeCustomerId: customerId,
          trigger: "waiting_for_retry_cooldown",
          status: "will_retry",
          nextAttemptAt: cooldownEnd,
          failureCount: failure.failureCount,
          stripeDeclineCode: failure.declineCode ?? undefined,
        });
        return { triggered: false, reason: "in_cooldown", retriesAt: cooldownEnd };
      }
    }

    // Fire low balance callback
    await onWalletLow?.({
      userId,
      balance: currentBalance,
      threshold,
    });

    if (!customerDefaultPM) {
      await onWalletAutoTopUpFailed?.({
        userId,
        stripeCustomerId: customerId,
        trigger: "no_payment_method",
        status: "action_required",
        failureCount: failure?.failureCount ?? 0,
      });
      return { triggered: false, reason: "no_payment_method" };
    }

    const autoTopUpsThisMonth = await db.countAutoTopUpsThisMonth(userId, WALLET_KEY);
    if (autoTopUpsThisMonth >= maxPerMonth) {
      await onWalletAutoTopUpFailed?.({
        userId,
        stripeCustomerId: customerId,
        trigger: "monthly_limit_reached",
        status: "will_retry",
        failureCount: failure?.failureCount ?? 0,
      });
      return { triggered: false, reason: "max_per_month_reached" };
    }

    const currency = subscription.currency;

    const now = new Date();
    const yearMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const pmSuffix = customerDefaultPM.slice(-8);
    const idempotencyKey = `wallet_auto_topup_${userId}_${yearMonth}_${autoTopUpsThisMonth + 1}_${pmSuffix}`;

    async function handlePaymentFailure(
      declineCode: string | undefined,
      errorMessage: string
    ): Promise<WalletAutoTopUpFailed> {
      const declineType = classifyDeclineCode(declineCode);
      const failureRecord = await db.recordTopUpFailure({
        userId,
        key: WALLET_KEY,
        paymentMethodId: customerDefaultPM!,
        declineType,
        declineCode: declineCode ?? null,
      });

      const isActionRequired = declineType === "hard" || failureRecord.failureCount >= 3;
      const COOLDOWN_MS = 24 * 60 * 60 * 1000;
      const nextAttemptAt = !isActionRequired
        ? new Date(failureRecord.lastFailureAt.getTime() + COOLDOWN_MS)
        : undefined;

      await onWalletAutoTopUpFailed?.({
        userId,
        stripeCustomerId: customerId,
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

    async function handlePaymentSuccess(): Promise<void> {
      if (failure) {
        await db.unblockAutoTopUp({ userId, key: WALLET_KEY });
      }
    }

    try {
      if (useInvoices) {
        const invoice = await stripe.invoices.create(
          {
            customer: customerId,
            auto_advance: false,
            pending_invoice_items_behavior: "exclude",
            ...(tax?.automaticTax && { automatic_tax: { enabled: true } }),
            metadata: {
              wallet_top_up: "true",
              wallet_top_up_amount: String(purchaseAmount),
              wallet_top_up_auto: "true",
              user_id: userId,
            },
          },
          { idempotencyKey: `${idempotencyKey}_invoice` }
        );

        await stripe.invoiceItems.create(
          {
            customer: customerId,
            invoice: invoice.id,
            amount: purchaseAmount,
            currency,
            description: "Wallet auto top-up",
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
          await stripe.invoices.voidInvoice(invoice.id).catch(() => {});
          throw payErr;
        }

        if (paidInvoice.status === "paid") {
          await handlePaymentSuccess();
          await addWalletFromInvoice(paidInvoice);
          return { triggered: true, status: "succeeded", sourceId: paidInvoice.id };
        }

        await stripe.invoices.voidInvoice(invoice.id).catch(() => {});
        return handlePaymentFailure(undefined, `Invoice status: ${paidInvoice.status}`);
      } else {
        const paymentIntent = await stripe.paymentIntents.create(
          {
            amount: purchaseAmount,
            currency,
            customer: customerId,
            payment_method: customerDefaultPM,
            confirm: true,
            off_session: true,
            metadata: {
              wallet_top_up: "true",
              wallet_top_up_amount: String(purchaseAmount),
              wallet_top_up_auto: "true",
              user_id: userId,
            },
          },
          { idempotencyKey }
        );

        if (paymentIntent.status === "succeeded") {
          await handlePaymentSuccess();
          await addWalletFromPayment(paymentIntent, true);
          return { triggered: true, status: "succeeded", sourceId: paymentIntent.id };
        }

        if (paymentIntent.status === "processing") {
          return { triggered: true, status: "pending", sourceId: paymentIntent.id };
        }

        const declineCode = paymentIntent.last_payment_error?.decline_code;
        return handlePaymentFailure(declineCode ?? undefined, `Payment requires action: ${paymentIntent.status}`);
      }
    } catch (err) {
      const stripeError = err as {
        decline_code?: string;
        raw?: { decline_code?: string; code?: string };
        code?: string;
        message?: string;
      };

      const declineCode =
        stripeError.decline_code ??
        stripeError.raw?.decline_code ??
        stripeError.code ??
        stripeError.raw?.code;

      return handlePaymentFailure(declineCode, stripeError.message ?? "Payment failed");
    }
  }

  async function handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    if (!paymentIntent.metadata?.wallet_top_up) {
      return;
    }
    const isAuto = paymentIntent.metadata?.wallet_top_up_auto === "true";
    await addWalletFromPayment(paymentIntent, isAuto);

    const userId = paymentIntent.metadata?.user_id;
    if (userId) {
      await db.unblockAutoTopUp({ userId, key: WALLET_KEY });
    }
  }

  async function handleTopUpCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    if (!session.metadata?.wallet_top_up) {
      return;
    }

    const amountStr = session.metadata?.wallet_top_up_amount;
    if (!amountStr || session.payment_status !== "paid") {
      return;
    }

    const amountCents = parseInt(amountStr, 10);
    if (isNaN(amountCents) || amountCents <= 0) {
      throw new CreditError("INVALID_METADATA", "Invalid wallet_top_up_amount in checkout session");
    }

    const customerId =
      typeof session.customer === "string" ? session.customer : session.customer?.id;
    if (!customerId) {
      throw new CreditError("MISSING_CUSTOMER", "No customer ID in checkout session");
    }

    if (!pool) {
      throw new CreditError("NO_DATABASE", "Database connection required");
    }

    const mappingResult = await pool.query(
      `SELECT user_id FROM ${schema}.user_stripe_customer_map WHERE stripe_customer_id = $1`,
      [customerId]
    );
    const userId = mappingResult.rows[0]?.user_id;
    if (!userId) {
      throw new CreditError("MISSING_USER_ID", "No user mapping found for customer");
    }

    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? session.id;

    // Update default payment method
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
        console.error("Failed to update default payment method:", updateErr);
      }
    }

    try {
      const result = await walletModule.add({
        userId,
        amount: amountCents,
        currency: session.currency ?? "usd",
        source: "topup",
        sourceId: paymentIntentId,
        idempotencyKey: `wallet_topup_${paymentIntentId}`,
      });

      await onWalletTopUpCompleted?.({
        userId,
        amountAdded: amountCents,
        amountCharged: session.amount_total ?? amountCents,
        currency: session.currency ?? "usd",
        newBalance: result.balance,
        sourceId: paymentIntentId,
      });
    } catch (err) {
      if (err instanceof CreditError && err.code === "IDEMPOTENCY_CONFLICT") {
        return;
      }
      throw err;
    }

    await db.unblockAutoTopUp({ userId, key: WALLET_KEY });
  }

  async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    if (!invoice.metadata?.wallet_top_up) {
      return;
    }

    try {
      await addWalletFromInvoice(invoice);

      const customerId =
        typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      const userId = invoice.metadata?.user_id;

      if (customerId && invoice.payment_intent) {
        try {
          const paymentIntentId =
            typeof invoice.payment_intent === "string"
              ? invoice.payment_intent
              : invoice.payment_intent.id;
          const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

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
          console.error("Failed to update default payment method from invoice:", updateErr);
        }
      }

      if (userId) {
        await db.unblockAutoTopUp({ userId, key: WALLET_KEY });
      }
    } catch (err) {
      if (err instanceof CreditError && err.code === "IDEMPOTENCY_CONFLICT") {
        return;
      }
      throw err;
    }
  }

  async function handleCustomerUpdated(
    customer: Stripe.Customer,
    previousAttributes?: Partial<Stripe.Customer>
  ): Promise<void> {
    // Check if payment method changed
    const prevDefault = previousAttributes?.invoice_settings?.default_payment_method;
    const newDefault = customer.invoice_settings?.default_payment_method;

    if (!prevDefault || prevDefault === newDefault) {
      return;
    }

    // Payment method changed - clear any wallet auto-top-up failures
    if (!pool) return;

    const mappingResult = await pool.query(
      `SELECT user_id FROM ${schema}.user_stripe_customer_map WHERE stripe_customer_id = $1`,
      [customer.id]
    );
    const userId = mappingResult.rows[0]?.user_id;
    if (!userId) return;

    await db.unblockAutoTopUp({ userId, key: WALLET_KEY });
  }

  return {
    topUp,
    triggerAutoTopUpIfNeeded,
    handlePaymentIntentSucceeded,
    handleTopUpCheckoutCompleted,
    handleInvoicePaid,
    handleCustomerUpdated,
  };
}
