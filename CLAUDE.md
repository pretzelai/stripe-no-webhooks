# Claude Code Instructions

## Project Overview

A Stripe billing library that handles subscriptions without requiring webhook setup. Includes a credit system for tracking consumable units.

## Code Style

### Comments

- Add JSDoc comments only for public-facing types/functions that users will read
- Internal comments only when something tricky needs explanation
- Write self-explanatory code; avoid redundant comments
- No inline comments restating what code obviously does

### TypeScript

- Use strict TypeScript
- Prefer type inference where obvious
- Use discriminated unions for result types (success/error patterns)

## Project Structure

```
src/
├── index.ts           # Main exports
├── handler.ts         # Stripe handler (checkout, webhook, portal)
├── BillingConfig.ts   # Config types (plans, prices, credits)
├── client.ts          # Frontend client
├── utils.ts           # Utilities
└── credits/           # Credit system
    ├── index.ts       # Credits API export
    ├── types.ts       # Credit types
    ├── db.ts          # Database operations
    ├── balance.ts     # getBalance, getAllBalances, hasCredits
    ├── consume.ts     # consume
    ├── grant.ts       # grant, revoke, setBalance
    └── history.ts     # getHistory
```

## Database

- Uses PostgreSQL via `pg` library
- Schema name: `stripe` (configurable)
- Migrations in `bin/commands/migrate.js`

## Testing

Run type check (excluding templates):

```bash
npx tsc --noEmit --skipLibCheck src/credits/*.ts src/index.ts src/handler.ts src/BillingConfig.ts src/utils.ts
```
