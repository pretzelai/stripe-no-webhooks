import type { HandlerContext, CustomerPortalRequestBody } from "../types";
import { errorResponse, successResponse } from "./utils";

export async function handleCustomerPortal(
  request: Request,
  ctx: HandlerContext
): Promise<Response> {
  try {
    const body: CustomerPortalRequestBody = await request
      .json()
      .catch(() => ({}));

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
