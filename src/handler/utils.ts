export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}

export function successResponse(
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
