# Local Development

## Testing in a Next.js app

`npm link` doesn't work well with Next.js and subpath exports (e.g., `stripe-no-webhooks/client`). Use `npm pack` instead:

```bash
# 1. Build and pack the library
cd /path/to/stripe-no-webhooks
npm run build && npm pack

# 2. Install the tarball in your test app
cd /path/to/your-test-app
npm install ../stripe-no-webhooks/stripe-no-webhooks-0.0.9.tgz
```

To test changes, repeat both steps (rebuild, repack, reinstall).

## CLI testing

```bash
cd /path/to/your-test-app
stripe-no-webhooks config
```
