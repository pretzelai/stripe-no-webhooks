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
    this._idCounter = 1;
  }

  // Seed data for testing
  _seedProducts(products) {
    this._products = products;
  }

  _seedPrices(prices) {
    this._prices = prices;
  }

  _seedWebhookEndpoints(endpoints) {
    this._webhookEndpoints = endpoints;
  }

  _generateId(prefix) {
    return `${prefix}_mock_${this._idCounter++}`;
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
          created: Math.floor(Date.now() / 1000),
          updated: Math.floor(Date.now() / 1000),
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
          recurring: params.recurring || null,
          created: Math.floor(Date.now() / 1000),
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
          created: Math.floor(Date.now() / 1000),
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
}

// Export as both default and named to work with:
// Stripe = require("stripe").default || require("stripe")
module.exports = StripeMock;
module.exports.default = StripeMock;
