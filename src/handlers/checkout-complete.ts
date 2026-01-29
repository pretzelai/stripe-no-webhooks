import type { HandlerContext } from "../types";
import { generateLoadingPage } from "./loading-page";

/**
 * Handle the checkout-complete redirect.
 * Serves a loading page that polls for subscription status before redirecting to success URL.
 */
export async function handleCheckoutComplete(
  request: Request,
  ctx: HandlerContext
): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");
  const redirectUrl =
    url.searchParams.get("redirect") || ctx.defaultSuccessUrl || "/";

  if (!sessionId) {
    return Response.redirect(redirectUrl, 302);
  }

  // Build the status endpoint URL (same path base as this request)
  const pathParts = url.pathname.split("/");
  pathParts[pathParts.length - 1] = "checkout-status";
  const statusEndpoint = `${url.origin}${pathParts.join("/")}`;

  const html = generateLoadingPage(
    sessionId,
    redirectUrl,
    ctx.webhookWaitTimeout || 30000,
    statusEndpoint
  );

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}
