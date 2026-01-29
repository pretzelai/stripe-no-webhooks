import { Billing } from "stripe-no-webhooks";
import billingConfig from "../billing.config";
import type { Stripe } from "stripe";

// TODO: Import your auth library - see some examples below
// import { currentUser } from "@clerk/nextjs/server";
// import { auth as betterAuth } from "@/lib/auth";
// import { headers } from "next/headers";

// Initialize once, use everywhere
export const billing = new Billing({
  billingConfig,

  // Keys and database URL are read from environment variables by default:
  // - STRIPE_SECRET_KEY
  // - STRIPE_WEBHOOK_SECRET
  // - DATABASE_URL

  // REQUIRED: URLs for checkout redirects
  successUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
  cancelUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",

  // OPTIONAL: URL to redirect to when resolveUser returns null (user not logged in).
  loginUrl: "/login",

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

  // OPTIONAL: Add callbacks for subscription/credit events
  // See full list of callbacks in docs/reference.md
  callbacks: {
    onSubscriptionCreated: async (subscription: Stripe.Subscription) => {
      console.log("New subscription:", subscription.id);
    },
    onSubscriptionCancelled: async (subscription: Stripe.Subscription) => {
      console.log("Subscription cancelled:", subscription.id);
    },
    onCreditsGranted: ({ userId, key, amount }) => {
      console.log(`Granted ${amount} ${key} to ${userId}`);
    },
  },

  // OPTIONAL: Resolve org for team/org billing
  // resolveOrg: async () => {
  //   const session = await getSession();
  //   return session.currentOrgId ?? null;
  // },

  // OPTIONAL: Tax configuration for B2B billing
  // tax: {
  //   automaticTax: true,
  //   billingAddressCollection: "required",
  //   taxIdCollection: true,
  // },
});
