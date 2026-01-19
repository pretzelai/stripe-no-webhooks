// pages/api/stripe/[...all].ts
import { billing } from "@/lib/billing";
import type { NextApiRequest, NextApiResponse } from "next";

// TODO: Import your auth library - see some examples below
// import { currentUser } from "@clerk/nextjs/server";
// import { auth } from "@/lib/auth";

const handler = billing.createHandler({
  // REQUIRED: Return { id, email?, name? } or null if not authenticated
  // Email/name are used when creating a new Stripe customer
  resolveUser: async (request) => {
    // Clerk (Pages Router - requires clerkMiddleware):
    // const user = await currentUser();
    // if (!user) return null;
    // return { id: user.id, email: user.emailAddresses[0]?.emailAddress, name: user.fullName ?? undefined };

    // Better Auth:
    // const session = await auth.api.getSession({ headers: request.headers });
    // if (!session?.user) return null;
    // return { id: session.user.id, email: session.user.email, name: session.user.name };

    return null; // TODO: Replace with your auth
  },

  // OPTIONAL: Resolve org for team/org billing
  // resolveOrg: async () => {
  //   const session = await getSession(req);
  //   return session.currentOrgId ?? null;
  // },
});

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
  const body = await new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (chunk: string) => (data += chunk));
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
