// pages/api/stripe/[...all].ts
import { billing } from "@/lib/billing";
import type { NextApiRequest, NextApiResponse } from "next";

// TODO: Import your auth library
// import { getAuth } from "@clerk/nextjs/server";
// import { getServerSession } from "next-auth";

const handler = billing.createHandler({
  // REQUIRED: Resolve the authenticated user from the request
  resolveUser: async () => {
    // Clerk:
    // const { userId } = getAuth(req);
    // return userId ? { id: userId } : null;

    // NextAuth:
    // const session = await getServerSession(req, res);
    // return session?.user?.id ? { id: session.user.id } : null;

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
    body,
  });

  const response = await handler(request);
  res.status(response.status).send(await response.text());
}
