// pages/api/stripe/[...all].ts
import { billing } from "@/lib/billing";
import type { NextApiRequest, NextApiResponse } from "next";

// All config (resolveUser, callbacks, etc.) is in lib/billing.ts
// This handler just exposes the API routes
const handler = billing.createHandler();

// Disable body parsing, we need the raw body for webhook verification
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function stripeHandler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Convert NextApiRequest to Request for the handler
  // bodyParser is disabled, so we read the raw body for webhook signature verification
  const body = await new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
  });

  const request = new Request(`https://${req.headers.host}${req.url}`, {
    method: req.method || "POST",
    headers: new Headers(req.headers as Record<string, string>),
    ...(req.method !== "GET" && { body }),
  });

  const response = await handler(request);
  res.status(response.status).send(await response.text());
}
