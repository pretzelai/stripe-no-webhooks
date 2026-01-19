// app/api/stripe/[...all]/route.ts
import { billing } from "@/lib/billing";

// All config (resolveUser, callbacks, etc.) is in lib/billing.ts
// This handler just exposes the API routes
const handler = billing.createHandler();

export const POST = handler;
export const GET = handler;
