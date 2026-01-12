// app/api/stripe/[...all]/route.ts
import { billing } from "@/lib/billing";
import type { Stripe } from "stripe";

// TODO: Import your auth library
// import { auth } from "@clerk/nextjs/server";
// import { getServerSession } from "next-auth";

export const POST = billing.createHandler({
  // REQUIRED: Resolve the authenticated user from the request
  resolveUser: async () => {
    // Clerk:
    // const { userId } = await auth();
    // return userId ? { id: userId } : null;

    // NextAuth:
    // const session = await getServerSession();
    // return session?.user?.id ? { id: session.user.id } : null;

    return null; // TODO: Replace with your auth
  },

  // OPTIONAL: Resolve org for team/org billing
  // resolveOrg: async () => {
  //   const session = await getSession();
  //   return session.currentOrgId ?? null;
  // },

  callbacks: {
    onSubscriptionCreated: async (subscription: Stripe.Subscription) => {
      console.log("New subscription:", subscription.id);
    },
    onSubscriptionCancelled: async (subscription: Stripe.Subscription) => {
      console.log("Subscription cancelled:", subscription.id);
    },
  },
});
