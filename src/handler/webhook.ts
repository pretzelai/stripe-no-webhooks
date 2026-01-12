import type Stripe from "stripe";
import type { StripeSync } from "@pretzelai/stripe-sync-engine";
import type { StripeWebhookCallbacks } from "./types";
import type { CreditLifecycle } from "../credits/lifecycle";
import type { TopUpHandler } from "../credits/topup";
import { getCustomerIdFromSubscription } from "../helpers";

export interface WebhookContext {
  stripe: Stripe;
  stripeWebhookSecret: string;
  sync: StripeSync | null;
  creditLifecycle: CreditLifecycle;
  topUpHandler: TopUpHandler;
  callbacks?: StripeWebhookCallbacks;
}

export async function handleWebhook(
  request: Request,
  ctx: WebhookContext
): Promise<Response> {
  try {
    const body = await request.text();
    const url = new URL(request.url);
    const isLocalhost =
      url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const signature = request.headers.get("stripe-signature");

    let event: Stripe.Event;

    if (isLocalhost) {
      // Skip signature verification on localhost for easier local development
      event = JSON.parse(body) as Stripe.Event;
    } else {
      if (!signature) {
        return new Response("Missing stripe-signature header", { status: 400 });
      }

      try {
        event = ctx.stripe.webhooks.constructEvent(
          body,
          signature,
          ctx.stripeWebhookSecret
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return new Response(
          `Webhook signature verification failed: ${message}`,
          { status: 400 }
        );
      }
    }

    // Sync to database (best-effort, don't block event handling on sync errors)
    if (ctx.sync) {
      const shouldSkipSync =
        // Setup mode checkouts have no line items
        (event.type === "checkout.session.completed" &&
          (event.data.object as { mode?: string }).mode === "setup") ||
        // Upcoming invoices have null IDs
        event.type === "invoice.upcoming";

      if (!shouldSkipSync) {
        try {
          await ctx.sync.processEvent(event);
        } catch (err) {
          // Log sync errors but continue with event handling
          console.error("Stripe sync error (non-fatal):", err);
        }
      }
    }

    // Handle specific events
    await handleEvent(event, ctx);

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return new Response(message, { status: 500 });
  }
}

// Safety net: if customer has multiple active subscriptions, keep highest-value one
async function handleDuplicateSubscriptions(
  ctx: WebhookContext,
  subscription: Stripe.Subscription
): Promise<boolean> {
  const customerId = getCustomerIdFromSubscription(subscription);
  const allSubs = await ctx.stripe.subscriptions.list({
    customer: customerId,
    status: "active",
    limit: 10,
  });
  const activeSubs = allSubs.data.filter(
    (s) => s.status === "active" || s.status === "trialing"
  );

  if (activeSubs.length <= 1) return false;

  // Keep highest-value subscription, cancel others as duplicates
  const sorted = activeSubs.sort((a, b) => {
    const aAmount = a.items.data[0]?.price?.unit_amount ?? 0;
    const bAmount = b.items.data[0]?.price?.unit_amount ?? 0;
    return bAmount - aAmount;
  });
  const toKeep = sorted[0];

  for (const sub of sorted.slice(1)) {
    try {
      await ctx.stripe.subscriptions.update(sub.id, {
        metadata: { cancelled_as_duplicate: "true" },
      });
      await ctx.stripe.subscriptions.cancel(sub.id);
    } catch (err) {
      console.error(`Failed to cancel duplicate subscription ${sub.id}:`, err);
    }
  }

  return subscription.id !== toKeep.id;
}

// Complete upgrade after setup mode checkout collected payment method
async function handleSetupModeUpgrade(
  ctx: WebhookContext,
  session: Stripe.Checkout.Session
): Promise<void> {
  const { metadata } = session;
  if (!metadata) return;

  const subId = metadata.upgrade_subscription_id;
  const itemId = metadata.upgrade_subscription_item_id;
  const newPriceId = metadata.upgrade_to_price_id;
  const disableProration = metadata.upgrade_disable_proration === "true";

  if (!subId || !itemId || !newPriceId) {
    console.error("Missing upgrade metadata in setup session:", metadata);
    return;
  }

  // Extract payment method from the setup intent
  const paymentMethodId = await getPaymentMethodFromSetupIntent(ctx, session);

  // Update the existing subscription with new price
  // This triggers subscription.updated → onSubscriptionPlanChanged for credits
  const updateParams: Stripe.SubscriptionUpdateParams = {
    items: [{ id: itemId, price: newPriceId }],
    proration_behavior: disableProration ? "none" : "create_prorations",
    ...(disableProration && { billing_cycle_anchor: "now" }),
    metadata: {
      upgrade_from_price_id: metadata.upgrade_from_price_id || "",
      upgrade_from_price_amount: metadata.upgrade_from_price_amount || "",
    },
  };

  if (paymentMethodId) {
    updateParams.default_payment_method = paymentMethodId;
  }

  await ctx.stripe.subscriptions.update(subId, updateParams);

  // Set as customer's default payment method for future charges (auto top-up, renewals)
  if (paymentMethodId && session.customer) {
    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer.id;

    await ctx.stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  }
}

async function getPaymentMethodFromSetupIntent(
  ctx: WebhookContext,
  session: Stripe.Checkout.Session
): Promise<string | undefined> {
  const setupIntentId =
    typeof session.setup_intent === "string"
      ? session.setup_intent
      : session.setup_intent?.id;

  if (!setupIntentId) return undefined;

  const setupIntent = await ctx.stripe.setupIntents.retrieve(setupIntentId);
  return typeof setupIntent.payment_method === "string"
    ? setupIntent.payment_method
    : setupIntent.payment_method?.id;
}

// Save payment method as default for future off-session charges (auto top-up, renewals)
async function saveDefaultPaymentMethod(
  ctx: WebhookContext,
  session: Stripe.Checkout.Session
): Promise<void> {
  try {
    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id;

    if (!subscriptionId) return;

    const subscription = await ctx.stripe.subscriptions.retrieve(subscriptionId);
    const paymentMethod = subscription.default_payment_method;
    const customerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id;

    if (paymentMethod && customerId) {
      const paymentMethodId =
        typeof paymentMethod === "string" ? paymentMethod : paymentMethod.id;

      await ctx.stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }
  } catch (err) {
    // Non-fatal - log but don't fail the webhook
    console.error("Failed to set default payment method:", err);
  }
}

async function handleEvent(
  event: Stripe.Event,
  ctx: WebhookContext
): Promise<void> {
  switch (event.type) {
    case "customer.subscription.created": {
      const subscription = event.data.object as Stripe.Subscription;

      // Safety net: if customer has multiple active subscriptions, cancel duplicates
      const shouldSkipCredits = await handleDuplicateSubscriptions(ctx, subscription);
      if (shouldSkipCredits) break;

      // Grant initial credits for the new subscription
      await ctx.creditLifecycle.onSubscriptionCreated(subscription);
      await ctx.callbacks?.onSubscriptionCreated?.(subscription);
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;

      // Skip credit handling for duplicates that were auto-cancelled by our safety net
      if (subscription.metadata?.cancelled_as_duplicate) {
        break;
      }

      // True cancellation - revoke all credits
      await ctx.creditLifecycle.onSubscriptionCancelled(subscription);
      await ctx.callbacks?.onSubscriptionCancelled?.(subscription);
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const prev = event.data.previous_attributes as
        | Partial<Stripe.Subscription>
        | undefined;

      // Handle cancellation via status change (some Stripe configurations use this instead of deleted)
      const statusChangedToCanceled =
        subscription.status === "canceled" &&
        prev?.status &&
        prev.status !== "canceled";

      if (statusChangedToCanceled) {
        await ctx.creditLifecycle.onSubscriptionCancelled(subscription);
        await ctx.callbacks?.onSubscriptionCancelled?.(subscription);
        break;
      }

      // Handle plan change (upgrade or downgrade via direct subscription update)
      // Credit handling is done in onSubscriptionPlanChanged based on metadata:
      // - pending_credit_downgrade: "true" → skip (credits adjusted at renewal)
      // - upgrade_from_price_amount: "0" → Free→Paid (revoke old, grant new)
      // - upgrade_from_price_amount: >0 → Paid→Paid (keep old, grant new)
      if (prev?.items) {
        const oldPriceId = prev.items.data?.[0]?.price?.id;
        const newPriceId = subscription.items.data[0]?.price?.id;
        if (oldPriceId && newPriceId && oldPriceId !== newPriceId) {
          await ctx.creditLifecycle.onSubscriptionPlanChanged(subscription, oldPriceId);
          await ctx.callbacks?.onSubscriptionPlanChanged?.(subscription, oldPriceId);
        }
      }
      break;
    }

    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;

      // Handle both old and new Stripe API versions
      // Old: invoice.subscription
      // New (2025-12-15+): invoice.parent?.subscription_details?.subscription
      const subscriptionId =
        invoice.subscription ??
        (invoice as unknown as { parent?: { subscription_details?: { subscription?: string } } })
          .parent?.subscription_details?.subscription;

      // Handle subscription renewals
      if (
        invoice.billing_reason === "subscription_cycle" &&
        subscriptionId
      ) {
        const subId =
          typeof subscriptionId === "string"
            ? subscriptionId
            : (subscriptionId as { id: string }).id;
        const subscription = await ctx.stripe.subscriptions.retrieve(subId);

        // Check for pending credit downgrade (price already changed, credits deferred to renewal)
        const pendingCreditDowngrade = subscription.metadata?.pending_credit_downgrade;

        if (pendingCreditDowngrade === "true") {
          // Price was already changed at downgrade time, now adjust credits
          const currentPriceId = subscription.items.data[0]?.price?.id;

          // Clear the pending flag
          await ctx.stripe.subscriptions.update(subscription.id, {
            metadata: {
              pending_credit_downgrade: "",
              downgrade_from_price: "",
            },
          });

          // Handle credit changes via onDowngradeApplied
          if (currentPriceId) {
            await ctx.creditLifecycle.onDowngradeApplied(subscription, currentPriceId);
          }
          // Note: Don't call onSubscriptionRenewed since downgrade handles credits differently
          break;
        }

        // Normal renewal (no pending downgrade)
        await ctx.creditLifecycle.onSubscriptionRenewed(
          subscription,
          invoice.id
        );
        await ctx.callbacks?.onSubscriptionRenewed?.(subscription);
      }
      break;
    }

    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;

      // Handle top-up recovery checkout completion
      if (session.metadata?.top_up_credit_type) {
        await ctx.topUpHandler.handleTopUpCheckoutCompleted(session);
      }

      // Handle setup mode upgrade: user upgraded from Free/no-payment-method plan
      // Checkout collected payment method, now update the existing subscription
      if (session.mode === "setup" && session.metadata?.upgrade_subscription_id) {
        await handleSetupModeUpgrade(ctx, session);
        break;
      }

      // For new subscription checkouts, save payment method as customer default
      // This enables auto top-up to work with off-session payments
      if (session.mode === "subscription" && session.subscription) {
        await saveDefaultPaymentMethod(ctx, session);
      }
      break;
    }

    case "payment_intent.succeeded": {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;

      // Handle successful top-up payment
      await ctx.topUpHandler.handlePaymentIntentSucceeded(paymentIntent);
      break;
    }
  }
}
