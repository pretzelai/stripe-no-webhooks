import type Stripe from "stripe";
import type { Pool } from "pg";
import type { BillingConfig, OnDemandTopUp } from "../BillingConfig";
import { credits } from "./index";
import { CreditError } from "./types";

export type TopUpSuccess = {
  success: true;
  balance: number;
  charged: { amountCents: number; currency: string };
  paymentIntentId: string;
};

export type TopUpPending = {
  success: true;
  status: "pending";
  paymentIntentId: string;
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

export function createTopUpHandler(deps: {
  stripe: Stripe;
  pool: Pool | null;
  schema: string;
  billingConfig?: BillingConfig;
  mode: "test" | "production";
  successUrl: string;
  cancelUrl: string;
  onCreditsGranted?: (params: {
    userId: string;
    creditType: string;
    amount: number;
    newBalance: number;
    source: "topup";
    sourceId: string;
  }) => void | Promise<void>;
  onTopUpCompleted?: (params: {
    userId: string;
    creditType: string;
    creditsAdded: number;
    amountCharged: number;
    currency: string;
    newBalance: number;
    paymentIntentId: string;
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
    onCreditsGranted,
    onTopUpCompleted,
  } = deps;

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

    const topUpConfig = plan.credits?.[creditType]?.topUp;
    if (!topUpConfig || topUpConfig.mode !== "on_demand") {
      return {
        success: false,
        error: {
          code: "TOPUP_NOT_CONFIGURED",
          message: `On-demand top-up not configured for ${creditType}`,
        },
      };
    }

    const {
      pricePerCreditCents,
      minPerPurchase = 1,
      maxPerPurchase,
    } = topUpConfig as OnDemandTopUp;
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
    const currency = subscription.currency;

    if (!customer.defaultPaymentMethod) {
      const recoveryUrl = await createRecoveryCheckout(
        customer.id,
        creditType,
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

      // If succeeded immediately, grant credits now (webhook will be idempotent)
      // we do still use the webhook to grant credits for slower resolving payment intents
      if (paymentIntent.status === "succeeded") {
        const newBalance = await grantCreditsFromPayment(paymentIntent);
        return {
          success: true,
          balance: newBalance,
          charged: { amountCents: totalCents, currency },
          paymentIntentId: paymentIntent.id,
        };
      }

      // Note that only async payment methods ever enter the processing state, cards never do
      if (paymentIntent.status === "processing") {
        return {
          success: true,
          status: "pending",
          paymentIntentId: paymentIntent.id,
          message:
            "Payment is processing. Credits will be added once payment completes.",
        };
      }

      // Payment needs action or failed
      const recoveryUrl = await createRecoveryCheckout(
        customer.id,
        creditType,
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
    } catch (err) {
      const recoveryUrl = await createRecoveryCheckout(
        customer.id,
        creditType,
        amount,
        totalCents,
        currency
      );
      const message = err instanceof Error ? err.message : "Payment failed";
      return {
        success: false,
        error: { code: "PAYMENT_FAILED", message, recoveryUrl },
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

    let newBalance: number;
    let alreadyGranted = false;
    try {
      newBalance = await credits.grant({
        userId,
        creditType,
        amount,
        source: "topup",
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
        source: "topup",
        sourceId: paymentIntent.id,
      });
      await onTopUpCompleted?.({
        userId,
        creditType,
        creditsAdded: amount,
        amountCharged: paymentIntent.amount,
        currency: paymentIntent.currency,
        newBalance,
        paymentIntentId: paymentIntent.id,
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
      paymentIntentId,
    });
  }

  // utility function so that the user can check if their customer has a payment method on file
  // useful for conditionally showing a top-up button
  async function hasPaymentMethod(userId: string): Promise<boolean> {
    const customer = await getCustomerByUserId(userId);
    return !!customer?.defaultPaymentMethod;
  }

  return {
    topUp,
    hasPaymentMethod,
    handlePaymentIntentSucceeded,
    handleTopUpCheckoutCompleted,
  };
}
