// Valid object types for CLI
// Note: These map to StripeSync.syncBackfill() object types
// Some names differ slightly (checkout_session -> checkout_sessions)
const SYNC_OBJECTS = [
  "all",
  "charge",
  "checkout_session",
  "credit_note",
  "customer",
  "dispute",
  "invoice",
  "payment_intent",
  "payment_method",
  "plan",
  "price",
  "product",
  "refund",
  "setup_intent",
  "subscription",
  "subscription_schedule",
];

// Required tables for migration check
const REQUIRED_TABLES = [
  "customers",
  "products",
  "prices",
  "subscriptions",
  "invoices",
];

module.exports = {
  SYNC_OBJECTS,
  REQUIRED_TABLES,
};
