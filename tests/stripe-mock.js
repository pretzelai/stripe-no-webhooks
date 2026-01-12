/**
 * Mock Stripe client for testing.
 * Works with: Stripe = require("stripe").default || require("stripe")
 */

class StripeMock {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this._products = [];
    this._prices = [];
    this._webhookEndpoints = [];
    this._customers = [];
    this._subscriptions = [];
    this._invoices = [];
    this._idCounter = 1;
  }

  // Seed data for testing (replaces existing)
  _seedProducts(products) {
    this._products = products;
  }

  _seedPrices(prices) {
    this._prices = prices;
  }

  _seedWebhookEndpoints(endpoints) {
    this._webhookEndpoints = endpoints;
  }

  _seedCustomers(customers) {
    this._customers = customers;
  }

  _seedSubscriptions(subscriptions) {
    this._subscriptions = subscriptions;
  }

  // Add single items (appends to existing)
  _addCustomer(customer) {
    this._customers.push(customer);
  }

  _addPrice(price) {
    this._prices.push(price);
  }

  _addSubscription(subscription) {
    this._subscriptions.push(subscription);
  }

  _generateId(prefix) {
    return `${prefix}_mock_${this._idCounter++}`;
  }

  _now() {
    return Math.floor(Date.now() / 1000);
  }

  get products() {
    const self = this;
    return {
      async list(params = {}) {
        let data = self._products;
        if (params.active !== undefined) {
          data = data.filter((p) => p.active === params.active);
        }
        if (params.limit) {
          data = data.slice(0, params.limit);
        }
        return { data };
      },
      async create(params) {
        const product = {
          id: self._generateId("prod"),
          object: "product",
          active: true,
          name: params.name,
          description: params.description || null,
          metadata: params.metadata || {},
          created: self._now(),
          updated: self._now(),
        };
        self._products.push(product);
        return product;
      },
      async retrieve(id) {
        const product = self._products.find((p) => p.id === id);
        if (!product) {
          const error = new Error(`No such product: ${id}`);
          error.type = "StripeInvalidRequestError";
          throw error;
        }
        return product;
      },
      async update(id, params) {
        const product = self._products.find((p) => p.id === id);
        if (!product) {
          const error = new Error(`No such product: ${id}`);
          error.type = "StripeInvalidRequestError";
          throw error;
        }
        Object.assign(product, params);
        return product;
      },
    };
  }

  get prices() {
    const self = this;
    return {
      async list(params = {}) {
        let data = self._prices;
        if (params.active !== undefined) {
          data = data.filter((p) => p.active === params.active);
        }
        if (params.product) {
          data = data.filter((p) => {
            const productId =
              typeof p.product === "string" ? p.product : p.product.id;
            return productId === params.product;
          });
        }
        if (params.limit) {
          data = data.slice(0, params.limit);
        }
        return { data };
      },
      async create(params) {
        const price = {
          id: self._generateId("price"),
          object: "price",
          active: true,
          product: params.product,
          unit_amount: params.unit_amount,
          currency: params.currency,
          type: params.recurring ? "recurring" : "one_time",
          recurring: params.recurring || null,
          metadata: params.metadata || {},
          created: self._now(),
        };
        self._prices.push(price);
        return price;
      },
      async retrieve(id) {
        const price = self._prices.find((p) => p.id === id);
        if (!price) {
          const error = new Error(`No such price: ${id}`);
          error.type = "StripeInvalidRequestError";
          throw error;
        }
        return price;
      },
    };
  }

  get webhookEndpoints() {
    const self = this;
    return {
      async list(params = {}) {
        let data = self._webhookEndpoints;
        if (params.limit) {
          data = data.slice(0, params.limit);
        }
        return { data };
      },
      async create(params) {
        const endpoint = {
          id: self._generateId("we"),
          object: "webhook_endpoint",
          url: params.url,
          enabled_events: params.enabled_events,
          description: params.description || null,
          secret: `whsec_mock_${Math.random().toString(36).substring(2)}`,
          status: "enabled",
          created: self._now(),
        };
        self._webhookEndpoints.push(endpoint);
        return endpoint;
      },
      async del(id) {
        const index = self._webhookEndpoints.findIndex((e) => e.id === id);
        if (index === -1) {
          const error = new Error(`No such webhook endpoint: ${id}`);
          error.type = "StripeInvalidRequestError";
          throw error;
        }
        self._webhookEndpoints.splice(index, 1);
        return { id, object: "webhook_endpoint", deleted: true };
      },
    };
  }

  get customers() {
    const self = this;
    return {
      async list(params = {}) {
        let data = self._customers;
        if (params.email) {
          data = data.filter((c) => c.email === params.email);
        }
        if (params.limit) {
          data = data.slice(0, params.limit);
        }
        return { data };
      },
      async create(params) {
        const customer = {
          id: self._generateId("cus"),
          object: "customer",
          email: params.email || null,
          name: params.name || null,
          metadata: params.metadata || {},
          invoice_settings: {
            default_payment_method: null,
          },
          created: self._now(),
        };
        self._customers.push(customer);
        return customer;
      },
      async retrieve(id) {
        const customer = self._customers.find((c) => c.id === id);
        if (!customer) {
          const error = new Error(`No such customer: ${id}`);
          error.type = "StripeInvalidRequestError";
          throw error;
        }
        return customer;
      },
      async update(id, params) {
        const customer = self._customers.find((c) => c.id === id);
        if (!customer) {
          const error = new Error(`No such customer: ${id}`);
          error.type = "StripeInvalidRequestError";
          throw error;
        }
        if (params.metadata) {
          customer.metadata = { ...customer.metadata, ...params.metadata };
        }
        if (params.email) customer.email = params.email;
        if (params.name) customer.name = params.name;
        if (params.invoice_settings) {
          customer.invoice_settings = {
            ...customer.invoice_settings,
            ...params.invoice_settings,
          };
        }
        return customer;
      },
    };
  }

  get subscriptions() {
    const self = this;
    return {
      async list(params = {}) {
        let data = self._subscriptions;
        if (params.customer) {
          data = data.filter((s) => s.customer === params.customer);
        }
        if (params.status) {
          if (params.status === "all") {
            // Return all
          } else {
            data = data.filter((s) => s.status === params.status);
          }
        } else {
          // Default: exclude canceled
          data = data.filter((s) => s.status !== "canceled");
        }
        if (params.limit) {
          data = data.slice(0, params.limit);
        }
        return { data };
      },
      async create(params) {
        const now = self._now();
        const priceId = params.items[0].price;
        const price = self._prices.find((p) => p.id === priceId);

        // Calculate period based on price interval
        let periodEnd = now + 30 * 24 * 60 * 60; // Default 30 days
        if (price?.recurring?.interval === "year") {
          periodEnd = now + 365 * 24 * 60 * 60;
        }

        const subscription = {
          id: self._generateId("sub"),
          object: "subscription",
          customer: params.customer,
          status: "active",
          current_period_start: now,
          current_period_end: periodEnd,
          items: {
            object: "list",
            data: [
              {
                id: self._generateId("si"),
                object: "subscription_item",
                price: price || { id: priceId, unit_amount: 0 },
                quantity: params.items[0].quantity || 1,
              },
            ],
          },
          metadata: params.metadata || {},
          created: now,
          cancel_at_period_end: false,
        };
        self._subscriptions.push(subscription);

        // Create an invoice for the subscription
        const invoice = self._createInvoice(subscription, price);
        self._invoices.push(invoice);

        return subscription;
      },
      async retrieve(id) {
        const subscription = self._subscriptions.find((s) => s.id === id);
        if (!subscription) {
          const error = new Error(`No such subscription: ${id}`);
          error.type = "StripeInvalidRequestError";
          throw error;
        }
        return subscription;
      },
      async update(id, params) {
        const subscription = self._subscriptions.find((s) => s.id === id);
        if (!subscription) {
          const error = new Error(`No such subscription: ${id}`);
          error.type = "StripeInvalidRequestError";
          throw error;
        }

        if (params.items) {
          const itemUpdate = params.items[0];
          if (itemUpdate.price) {
            const newPriceId = itemUpdate.price;
            const newPrice = self._prices.find((p) => p.id === newPriceId);
            subscription.items.data[0].price = newPrice || { id: newPriceId };
          }
          if (itemUpdate.id) {
            subscription.items.data[0].id = itemUpdate.id;
          }
          if (itemUpdate.quantity !== undefined) {
            subscription.items.data[0].quantity = itemUpdate.quantity;
          }
        }

        if (params.metadata) {
          subscription.metadata = { ...subscription.metadata, ...params.metadata };
        }

        if (params.cancel_at_period_end !== undefined) {
          subscription.cancel_at_period_end = params.cancel_at_period_end;
        }

        if (params.proration_behavior) {
          // Store for reference but mock doesn't calculate prorations
          subscription._proration_behavior = params.proration_behavior;
        }

        if (params.billing_cycle_anchor === "now") {
          const now = self._now();
          subscription.current_period_start = now;
          // Recalculate period end based on price interval
          const price = subscription.items.data[0].price;
          if (price?.recurring?.interval === "year") {
            subscription.current_period_end = now + 365 * 24 * 60 * 60;
          } else {
            subscription.current_period_end = now + 30 * 24 * 60 * 60;
          }
        }

        return subscription;
      },
      async cancel(id) {
        const subscription = self._subscriptions.find((s) => s.id === id);
        if (!subscription) {
          const error = new Error(`No such subscription: ${id}`);
          error.type = "StripeInvalidRequestError";
          throw error;
        }
        subscription.status = "canceled";
        subscription.canceled_at = self._now();
        return subscription;
      },
    };
  }

  get invoices() {
    const self = this;
    return {
      async list(params = {}) {
        let data = self._invoices;
        if (params.subscription) {
          data = data.filter((i) => i.subscription === params.subscription);
        }
        if (params.customer) {
          data = data.filter((i) => i.customer === params.customer);
        }
        if (params.limit) {
          data = data.slice(0, params.limit);
        }
        return { data };
      },
      async retrieve(id) {
        const invoice = self._invoices.find((i) => i.id === id);
        if (!invoice) {
          const error = new Error(`No such invoice: ${id}`);
          error.type = "StripeInvalidRequestError";
          throw error;
        }
        return invoice;
      },
    };
  }

  // Internal helper to create invoice from subscription
  _createInvoice(subscription, price) {
    const now = this._now();
    return {
      id: this._generateId("in"),
      object: "invoice",
      customer: subscription.customer,
      subscription: subscription.id,
      status: "paid",
      paid: true,
      amount_paid: price?.unit_amount || 0,
      currency: price?.currency || "usd",
      lines: {
        object: "list",
        data: [
          {
            id: this._generateId("il"),
            object: "line_item",
            price: price,
            quantity: 1,
            period: {
              start: subscription.current_period_start,
              end: subscription.current_period_end,
            },
          },
        ],
      },
      period_start: subscription.current_period_start,
      period_end: subscription.current_period_end,
      billing_reason: "subscription_create",
      created: now,
    };
  }

  /**
   * Simulate a subscription renewal (creates new invoice, advances period)
   */
  _simulateRenewal(subscriptionId) {
    const subscription = this._subscriptions.find((s) => s.id === subscriptionId);
    if (!subscription || subscription.status !== "active") {
      return null;
    }

    const price = subscription.items.data[0].price;
    const oldPeriodEnd = subscription.current_period_end;

    // Advance period
    subscription.current_period_start = oldPeriodEnd;
    if (price?.recurring?.interval === "year") {
      subscription.current_period_end = oldPeriodEnd + 365 * 24 * 60 * 60;
    } else {
      subscription.current_period_end = oldPeriodEnd + 30 * 24 * 60 * 60;
    }

    // Create renewal invoice
    const invoice = {
      id: this._generateId("in"),
      object: "invoice",
      customer: subscription.customer,
      subscription: subscription.id,
      status: "paid",
      paid: true,
      amount_paid: price?.unit_amount || 0,
      currency: price?.currency || "usd",
      lines: {
        object: "list",
        data: [
          {
            id: this._generateId("il"),
            object: "line_item",
            price: price,
            quantity: 1,
            period: {
              start: subscription.current_period_start,
              end: subscription.current_period_end,
            },
          },
        ],
      },
      period_start: subscription.current_period_start,
      period_end: subscription.current_period_end,
      billing_reason: "subscription_cycle",
      created: this._now(),
    };
    this._invoices.push(invoice);

    return invoice;
  }

  /**
   * Build a webhook event object (for testing webhook handlers)
   */
  _buildEvent(type, data) {
    return {
      id: this._generateId("evt"),
      object: "event",
      type,
      data: { object: data },
      created: this._now(),
      livemode: false,
    };
  }

  // Billing portal (stub)
  get billingPortal() {
    const self = this;
    return {
      sessions: {
        async create(params) {
          return {
            id: self._generateId("bps"),
            object: "billing_portal.session",
            customer: params.customer,
            return_url: params.return_url,
            url: `https://billing.stripe.com/session/mock_${self._idCounter}`,
            created: self._now(),
          };
        },
      },
    };
  }

  // Checkout (stub)
  get checkout() {
    const self = this;
    return {
      sessions: {
        async create(params) {
          const session = {
            id: self._generateId("cs"),
            object: "checkout.session",
            customer: params.customer,
            mode: params.mode,
            success_url: params.success_url,
            cancel_url: params.cancel_url,
            url: `https://checkout.stripe.com/pay/mock_${self._idCounter}`,
            metadata: params.metadata || {},
            payment_status: "unpaid",
            payment_intent: null,
            amount_total: 0,
            currency: "usd",
            created: self._now(),
          };

          // Calculate amount from line items if present
          if (params.line_items) {
            for (const item of params.line_items) {
              if (item.price_data) {
                session.amount_total += item.price_data.unit_amount * (item.quantity || 1);
                session.currency = item.price_data.currency || "usd";
              }
            }
          }

          self._checkoutSessions = self._checkoutSessions || [];
          self._checkoutSessions.push(session);
          return session;
        },
        async retrieve(id) {
          const session = (self._checkoutSessions || []).find(s => s.id === id);
          if (!session) {
            const error = new Error(`No such checkout session: ${id}`);
            error.type = "StripeInvalidRequestError";
            throw error;
          }
          return session;
        },
      },
    };
  }

  // Payment Intents
  get paymentIntents() {
    const self = this;
    self._paymentIntents = self._paymentIntents || [];
    self._idempotencyKeys = self._idempotencyKeys || {};

    return {
      async create(params, options) {
        // Handle idempotency
        if (options?.idempotencyKey) {
          const existing = self._idempotencyKeys[options.idempotencyKey];
          if (existing) {
            return existing;
          }
        }

        const paymentIntent = {
          id: self._generateId("pi"),
          object: "payment_intent",
          amount: params.amount,
          currency: params.currency,
          customer: params.customer,
          payment_method: params.payment_method,
          status: params.confirm ? "succeeded" : "requires_confirmation",
          metadata: params.metadata || {},
          created: self._now(),
          off_session: params.off_session || false,
        };

        // Simulate payment failure if payment method starts with "pm_fail"
        if (params.payment_method?.startsWith("pm_fail")) {
          paymentIntent.status = "requires_payment_method";
        }

        // Simulate requires_action if payment method starts with "pm_action"
        if (params.payment_method?.startsWith("pm_action")) {
          paymentIntent.status = "requires_action";
        }

        self._paymentIntents.push(paymentIntent);

        if (options?.idempotencyKey) {
          self._idempotencyKeys[options.idempotencyKey] = paymentIntent;
        }

        return paymentIntent;
      },
      async retrieve(id) {
        const pi = self._paymentIntents.find(p => p.id === id);
        if (!pi) {
          const error = new Error(`No such payment intent: ${id}`);
          error.type = "StripeInvalidRequestError";
          throw error;
        }
        return pi;
      },
      async confirm(id) {
        const pi = self._paymentIntents.find(p => p.id === id);
        if (!pi) {
          const error = new Error(`No such payment intent: ${id}`);
          error.type = "StripeInvalidRequestError";
          throw error;
        }
        pi.status = "succeeded";
        return pi;
      },
    };
  }

  /**
   * Simulate completing a checkout session (for testing webhook handlers)
   */
  _completeCheckoutSession(sessionId, paymentIntentId) {
    const session = (this._checkoutSessions || []).find(s => s.id === sessionId);
    if (session) {
      session.payment_status = "paid";
      session.payment_intent = paymentIntentId || this._generateId("pi");
    }
    return session;
  }

  /**
   * Get a payment intent by ID (for testing)
   */
  _getPaymentIntent(id) {
    return (this._paymentIntents || []).find(p => p.id === id);
  }

  /**
   * Mark a payment intent as succeeded (for testing webhook handlers)
   */
  _succeedPaymentIntent(id) {
    const pi = (this._paymentIntents || []).find(p => p.id === id);
    if (pi) {
      pi.status = "succeeded";
    }
    return pi;
  }
}

// Export as both default and named to work with:
// Stripe = require("stripe").default || require("stripe")
module.exports = StripeMock;
module.exports.default = StripeMock;
