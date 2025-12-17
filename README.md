# 1. Create Stripe schema and tables

Option 1: run this command
```
npx stripe-no-webhooks migrate postgresql://postgres.[USER]:[PASSWORD]@[DB_URL]/postgres
```

Option 2: copy `stripe_schema.sql` and run the query