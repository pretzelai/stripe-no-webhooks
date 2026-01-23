import type Stripe from "stripe";
import type { BillingConfig, Plan } from "../BillingConfig";
import { planHasCredits, isUsageTrackingEnabled } from "../BillingConfig";
import type { HandlerContext, CheckoutRequestBody } from "../types";
import { jsonResponse, errorResponse, successResponse } from "./utils";
import {
  findPlanByPriceId,
  getActiveSubscription,
} from "../helpers";

/**
 * Get all metered price IDs for a plan (features with trackUsage: true)
 */
function getMeteredPriceIds(plan: Plan | null): string[] {
  if (!plan) return [];
  const features = plan.features || {};
  const priceIds: string[] = [];
  for (const feature of Object.values(features)) {
    if (isUsageTrackingEnabled(feature) && feature.meteredPriceId) {
      priceIds.push(feature.meteredPriceId);
    }
  }
  return priceIds;
}

async function hasPaymentMethod(
  stripe: Stripe,
  customerId: string
): Promise<boolean> {
  const customer = await stripe.customers.retrieve(customerId);
  if ("deleted" in customer && customer.deleted) return false;
  return !!(customer as Stripe.Customer).invoice_settings
    ?.default_payment_method;
}

function resolvePriceId(
  body: CheckoutRequestBody,
  billingConfig: BillingConfig | undefined,
  mode: "test" | "production"
): string {
  if (body.priceId) {
    return body.priceId;
  }

  if (!body.interval) {
    throw new Error("interval is required when using planName or planId");
  }

  if (!billingConfig?.[mode]?.plans) {
    throw new Error(
      "billingConfig with plans is required when using planName or planId"
    );
  }

  const plan = body.planName
    ? billingConfig[mode]?.plans?.find((p) => p.name === body.planName)
    : body.planId
    ? billingConfig[mode]?.plans?.find((p) => p.id === body.planId)
    : null;

  if (!plan) {
    const identifier = body.planName || body.planId;
    throw new Error(`Plan not found: ${identifier}`);
  }

  const price = plan.price.find((p) => p.interval === body.interval);
  if (!price) {
    throw new Error(
      `Price with interval "${body.interval}" not found for plan "${plan.name}"`
    );
  }

  if (!price.id) {
    throw new Error(
      `Price ID not set for plan "${plan.name}" with interval "${body.interval}". Run stripe-sync to sync price IDs.`
    );
  }

  return price.id;
}

async function getPriceMode(
  stripe: Stripe,
  priceId: string
): Promise<"payment" | "subscription"> {
  const price = await stripe.prices.retrieve(priceId);
  return price.type === "recurring" ? "subscription" : "payment";
}

// Disable proration when BOTH plans have credits (to prevent gaming)
function shouldDisableProration(
  billingConfig: BillingConfig | undefined,
  mode: "test" | "production",
  oldPriceId: string,
  newPriceId: string
): boolean {
  const oldPlan = findPlanByPriceId(billingConfig, mode, oldPriceId);
  const newPlan = findPlanByPriceId(billingConfig, mode, newPriceId);
  return planHasCredits(oldPlan) && planHasCredits(newPlan);
}

export async function handleCheckout(
  request: Request,
  ctx: HandlerContext
): Promise<Response> {
  try {
    const body: CheckoutRequestBody = await request.json().catch(() => ({}));

    if (!body.priceId && !body.planName && !body.planId) {
      return errorResponse(
        "Provide either priceId, planName+interval, or planId+interval",
        400
      );
    }

    const origin = request.headers.get("origin") || "";
    const successUrl =
      body.successUrl ||
      ctx.defaultSuccessUrl ||
      `${origin}/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = body.cancelUrl || ctx.defaultCancelUrl || `${origin}/`;

    const priceId = resolvePriceId(body, ctx.billingConfig, ctx.mode);
    const priceMode = await getPriceMode(ctx.stripe, priceId);

    // Resolve user from request
    const user = ctx.resolveUser ? await ctx.resolveUser(request) : null;
    if (!user) {
      if (ctx.loginUrl) {
        const loginUrl = new URL(ctx.loginUrl, request.url).href;
        return successResponse(request, { url: loginUrl }, loginUrl);
      }
      return errorResponse(
        "Unauthorized. Configure resolveUser to extract authenticated user.",
        401
      );
    }

    // Resolve org from request (if configured)
    const orgId = ctx.resolveOrg ? await ctx.resolveOrg(request) : null;

    // Determine who gets billed: org or user
    const customerId = await ctx.resolveStripeCustomerId({
      user: orgId ? { id: orgId } : user,
      createIfNotFound: true,
    });

    // Handle existing subscriptions (smart checkout)
    if (customerId && priceMode === "subscription") {
      const currentSub = await getActiveSubscription(ctx.stripe, customerId);

      if (currentSub) {
        const currentPriceId = currentSub.items.data[0]?.price?.id;
        const currentAmount = currentSub.items.data[0]?.price?.unit_amount ?? 0;

        if (currentPriceId === priceId) {
          return jsonResponse({
            success: true,
            alreadySubscribed: true,
            message: "Already on this plan",
          });
        }

        const targetPrice = await ctx.stripe.prices.retrieve(priceId);
        const targetAmount = targetPrice.unit_amount ?? 0;
        const customerHasPaymentMethod = await hasPaymentMethod(
          ctx.stripe,
          customerId
        );

        const isUpgrade = targetAmount > currentAmount;
        const isDowngrade = targetAmount < currentAmount;

        // Downgrade: schedule for period end (credits stay until renewal)
        if (isDowngrade) {
          // Build subscription items - update base price and handle metered prices
          const newPlan = findPlanByPriceId(ctx.billingConfig, ctx.mode, priceId);
          const newMeteredPriceIds = getMeteredPriceIds(newPlan);
          const existingMeteredItems = currentSub.items.data.filter(
            (item) => item.price.recurring?.usage_type === "metered"
          );

          const subscriptionItems: Stripe.SubscriptionUpdateParams.Item[] = [
            { id: currentSub.items.data[0].id, price: priceId },
          ];

          // Remove old metered items
          for (const item of existingMeteredItems) {
            subscriptionItems.push({ id: item.id, deleted: true });
          }

          // Add new metered items for the target plan
          for (const meteredPriceId of newMeteredPriceIds) {
            subscriptionItems.push({ price: meteredPriceId });
          }

          await ctx.stripe.subscriptions.update(currentSub.id, {
            items: subscriptionItems,
            proration_behavior: "none",
            metadata: {
              pending_credit_downgrade: "true",
              downgrade_from_price: currentPriceId,
            },
          });

          const periodEnd = currentSub.current_period_end;
          return successResponse(
            request,
            {
              success: true,
              downgraded: true,
              message: "Plan changed. Credits will adjust at your next billing date.",
              ...(periodEnd && {
                creditAdjustmentAt: new Date(periodEnd * 1000).toISOString(),
              }),
              url: successUrl,
            },
            successUrl
          );
        }

        // Upgrade: apply immediately
        const disableProration = shouldDisableProration(
          ctx.billingConfig,
          ctx.mode,
          currentPriceId,
          priceId
        );

        if (customerHasPaymentMethod && isUpgrade) {
          try {
            // Build subscription items update - include metered prices for usage tracking
            const newPlan = findPlanByPriceId(ctx.billingConfig, ctx.mode, priceId);
            const meteredPriceIds = getMeteredPriceIds(newPlan);
            const existingMeteredItems = currentSub.items.data.filter(
              (item) => item.price.recurring?.usage_type === "metered"
            );

            const subscriptionItems: Stripe.SubscriptionUpdateParams.Item[] = [
              { id: currentSub.items.data[0].id, price: priceId },
            ];

            // Remove old metered items
            for (const item of existingMeteredItems) {
              subscriptionItems.push({ id: item.id, deleted: true });
            }

            // Add new metered items
            for (const meteredPriceId of meteredPriceIds) {
              subscriptionItems.push({ price: meteredPriceId });
            }

            await ctx.stripe.subscriptions.update(currentSub.id, {
              items: subscriptionItems,
              proration_behavior: disableProration
                ? "none"
                : "create_prorations",
              ...(disableProration && { billing_cycle_anchor: "now" }),
              metadata: {
                upgrade_from_price_id: currentPriceId,
                upgrade_from_price_amount: currentAmount.toString(),
              },
            });
          } catch (err) {
            // Payment failed - redirect to portal to fix billing
            console.error("Direct subscription update failed:", err);
            const portal = await ctx.stripe.billingPortal.sessions.create({
              customer: customerId,
              return_url: cancelUrl,
            });
            return successResponse(
              request,
              {
                error: "Payment issue",
                portalUrl: portal.url,
              },
              portal.url
            );
          }

          return successResponse(
            request,
            {
              success: true,
              upgraded: true,
              url: successUrl,
            },
            successUrl
          );
        }

        // No payment method - collect via setup mode checkout
        // Collect metered prices for the new plan to include in metadata
        const setupNewPlan = findPlanByPriceId(ctx.billingConfig, ctx.mode, priceId);
        const setupMeteredPriceIds = getMeteredPriceIds(setupNewPlan);
        const setupExistingMeteredItemIds = currentSub.items.data
          .filter((item) => item.price.recurring?.usage_type === "metered")
          .map((item) => item.id);

        const session = await ctx.stripe.checkout.sessions.create({
          customer: customerId,
          mode: "setup",
          currency: targetPrice.currency,
          success_url: successUrl,
          cancel_url: cancelUrl,

          // Tax configuration (also in setup mode for address collection)
          ...(ctx.tax.billingAddressCollection && {
            billing_address_collection: ctx.tax.billingAddressCollection,
          }),

          ...(ctx.tax.taxIdCollection && {
            tax_id_collection: { enabled: true },
          }),

          ...(ctx.tax.customerUpdate && {
            customer_update: ctx.tax.customerUpdate,
          }),

          metadata: {
            ...body.metadata,
            upgrade_subscription_id: currentSub.id,
            upgrade_subscription_item_id: currentSub.items.data[0].id,
            upgrade_to_price_id: priceId,
            upgrade_from_price_id: currentPriceId,
            upgrade_from_price_amount: currentAmount.toString(),
            upgrade_disable_proration: disableProration ? "true" : "false",
            // Store metered price info for webhook to apply
            upgrade_new_metered_prices: setupMeteredPriceIds.join(","),
            upgrade_old_metered_item_ids: setupExistingMeteredItemIds.join(","),
          },
        });

        if (!session.url) {
          return errorResponse("Failed to create checkout session", 500);
        }
        return successResponse(request, { url: session.url }, session.url);
      }
    }

    // Standard checkout (no existing subscription)
    // Build line items - include base price and any metered prices for usage tracking
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      { price: priceId, quantity: body.quantity ?? 1 },
    ];

    // Add metered prices for features with usage tracking
    if (priceMode === "subscription") {
      const plan = findPlanByPriceId(ctx.billingConfig, ctx.mode, priceId);
      const meteredPriceIds = getMeteredPriceIds(plan);
      for (const meteredPriceId of meteredPriceIds) {
        // Metered prices don't need quantity - they're usage-based
        lineItems.push({ price: meteredPriceId });
      }
    }

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      line_items: lineItems,
      mode: priceMode,
      success_url: successUrl,
      cancel_url: cancelUrl,
      payment_method_collection: "if_required",

      // Tax configuration
      automatic_tax: { enabled: ctx.tax.automaticTax ?? false },

      ...(ctx.tax.billingAddressCollection && {
        billing_address_collection: ctx.tax.billingAddressCollection,
      }),

      ...(ctx.tax.taxIdCollection && {
        tax_id_collection: { enabled: true },
      }),

      ...(ctx.tax.customerUpdate && {
        customer_update: ctx.tax.customerUpdate,
      }),
    };

    if (customerId) {
      sessionParams.customer = customerId;
    }

    // Build metadata
    const sessionMetadata: Record<string, string> = { ...body.metadata };
    if (orgId) {
      sessionMetadata.org_id = orgId;
    }

    // In seat-users mode, store first seat user for auto-granting
    if (ctx.grantTo === "seat-users" && orgId) {
      sessionMetadata.first_seat_user_id = user.id;
    }

    if (Object.keys(sessionMetadata).length > 0) {
      sessionParams.metadata = sessionMetadata;
      if (priceMode === "subscription") {
        sessionParams.subscription_data = { metadata: sessionMetadata };
      }
    }

    const session = await ctx.stripe.checkout.sessions.create(sessionParams);

    if (!session.url) {
      return errorResponse("Failed to create checkout session", 500);
    }
    return successResponse(request, { url: session.url }, session.url);
  } catch (err) {
    console.error("Checkout error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    const status =
      err && typeof err === "object" && "statusCode" in err
        ? (err.statusCode as number)
        : 500;
    return errorResponse(message, status);
  }
}
