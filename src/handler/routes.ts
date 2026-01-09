import type Stripe from "stripe";
import type { BillingConfig } from "../BillingConfig";
import type {
  HandlerContext,
  CheckoutRequestBody,
  CustomerPortalRequestBody,
} from "./types";
import {
  planHasCredits,
  findPlanByPriceId,
  getActiveSubscription,
} from "../helpers";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}

function successResponse(
  request: Request,
  data: Record<string, unknown>,
  redirectUrl: string
): Response {
  const acceptHeader = request.headers.get("accept") || "";
  if (acceptHeader.includes("application/json")) {
    return jsonResponse({ ...data, redirectUrl });
  }
  return Response.redirect(redirectUrl, 303);
}

async function hasPaymentMethod(
  stripe: Stripe,
  customerId: string
): Promise<boolean> {
  const customer = await stripe.customers.retrieve(customerId);
  if ("deleted" in customer && customer.deleted) return false;
  return !!(customer as Stripe.Customer).invoice_settings?.default_payment_method;
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
        const customerHasPaymentMethod = await hasPaymentMethod(ctx.stripe, customerId);

        const isUpgrade = targetAmount > currentAmount;
        const isDowngrade = targetAmount < currentAmount;

        // Downgrade: schedule for period end (credits stay until renewal)
        if (isDowngrade) {
          await ctx.stripe.subscriptions.update(currentSub.id, {
            items: [{ id: currentSub.items.data[0].id, price: priceId }],
            proration_behavior: "none",
            metadata: {
              pending_credit_downgrade: "true",
              downgrade_from_price: currentPriceId,
            },
          });

          const periodEnd = currentSub.current_period_end;
          return successResponse(request, {
            success: true,
            scheduled: true,
            message: "Downgrade scheduled for end of current billing period",
            ...(periodEnd && { effectiveAt: new Date(periodEnd * 1000).toISOString() }),
            url: successUrl,
          }, successUrl);
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
            await ctx.stripe.subscriptions.update(currentSub.id, {
              items: [{ id: currentSub.items.data[0].id, price: priceId }],
              proration_behavior: disableProration ? "none" : "create_prorations",
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
            return successResponse(request, {
              error: "Payment issue",
              portalUrl: portal.url,
            }, portal.url);
          }

          return successResponse(request, {
            success: true,
            upgraded: true,
            url: successUrl,
          }, successUrl);
        }

        // No payment method - collect via setup mode checkout
        const session = await ctx.stripe.checkout.sessions.create({
          customer: customerId,
          mode: "setup",
          currency: targetPrice.currency,
          success_url: successUrl,
          cancel_url: cancelUrl,
          metadata: {
            ...body.metadata,
            upgrade_subscription_id: currentSub.id,
            upgrade_subscription_item_id: currentSub.items.data[0].id,
            upgrade_to_price_id: priceId,
            upgrade_from_price_id: currentPriceId,
            upgrade_from_price_amount: currentAmount.toString(),
            upgrade_disable_proration: disableProration ? "true" : "false",
          },
        });

        if (!session.url) {
          return errorResponse("Failed to create checkout session", 500);
        }
        return successResponse(request, { url: session.url }, session.url);
      }
    }

    // Standard checkout (no existing subscription)
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      line_items: [{ price: priceId, quantity: body.quantity ?? 1 }],
      mode: priceMode,
      success_url: successUrl,
      cancel_url: cancelUrl,
      automatic_tax: { enabled: ctx.automaticTax },
      payment_method_collection: "if_required",
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

export async function handleCustomerPortal(
  request: Request,
  ctx: HandlerContext
): Promise<Response> {
  try {
    const body: CustomerPortalRequestBody = await request.json().catch(() => ({}));

    const user = ctx.resolveUser ? await ctx.resolveUser(request) : null;
    if (!user) {
      return errorResponse(
        "Unauthorized. Configure resolveUser to extract authenticated user.",
        401
      );
    }

    const orgId = ctx.resolveOrg ? await ctx.resolveOrg(request) : null;

    const customerId = await ctx.resolveStripeCustomerId({
      user: orgId ? { id: orgId } : user,
      createIfNotFound: false,
    });

    if (!customerId) {
      return errorResponse("No billing account found for this user.", 404);
    }

    const origin = request.headers.get("origin") || "";
    const returnUrl = body.returnUrl || `${origin}/`;

    const session = await ctx.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return successResponse(request, { url: session.url }, session.url);
  } catch (err) {
    console.error("Customer portal error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    const status =
      err && typeof err === "object" && "statusCode" in err
        ? (err.statusCode as number)
        : 500;
    return errorResponse(message, status);
  }
}
