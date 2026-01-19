// app/api/stripe/[...all]/route.ts
import { billing } from "@/lib/billing";

// TODO: Import your auth library - see some examples below
// import { auth, currentUser } from "@clerk/nextjs/server";
// import { auth as betterAuth } from "@/lib/auth";
// import { headers } from "next/headers";

export const POST = billing.createHandler({
  // REQUIRED: Return { id, email?, name? } or null if not authenticated
  // Email/name are used when creating a new Stripe customer
  resolveUser: async () => {
    // Clerk (requires clerkMiddleware in middleware.ts):
    // const user = await currentUser();
    // if (!user) return null;
    // return { id: user.id, email: user.emailAddresses[0]?.emailAddress, name: user.fullName ?? undefined };

    // Better Auth:
    // const session = await betterAuth.api.getSession({ headers: await headers() });
    // if (!session?.user) return null;
    // return { id: session.user.id, email: session.user.email, name: session.user.name };

    return null; // TODO: Replace with your auth
  },

  // OPTIONAL: Redirect to login page when user is not authenticated
  // Useful if you are using PricingPage
  // loginUrl: "/sign-in",

  // OPTIONAL: Resolve org for team/org billing
  // resolveOrg: async () => {
  //   const session = await getSession();
  //   return session.currentOrgId ?? null;
  // },
});
