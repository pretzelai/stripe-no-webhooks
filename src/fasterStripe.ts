import Stripe from "stripe";
import { Pool, PoolConfig } from "pg";

// ============================================================================
// Types
// ============================================================================

export interface FasterStripeConfig extends Stripe.StripeConfig {
  /**
   * PostgreSQL connection string or pool config
   * Falls back to DATABASE_URL environment variable
   */
  databaseUrl?: string | PoolConfig;

  /**
   * Database schema name (defaults to 'stripe')
   */
  schema?: string;
}

interface CreatedFilter {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

interface BaseListParams {
  limit?: number;
  starting_after?: string;
  ending_before?: string;
  created?: number | CreatedFilter;
}

// ============================================================================
// SQL Query Builder Helpers
// ============================================================================

function buildCreatedFilter(
  created: number | CreatedFilter | undefined,
  params: unknown[],
  paramIndex: number
): { sql: string; params: unknown[]; nextIndex: number } {
  if (created === undefined) {
    return { sql: "", params: [], nextIndex: paramIndex };
  }

  const conditions: string[] = [];
  const newParams: unknown[] = [];
  let idx = paramIndex;

  if (typeof created === "number") {
    conditions.push(`created = $${idx}`);
    newParams.push(created);
    idx++;
  } else {
    if (created.gt !== undefined) {
      conditions.push(`created > $${idx}`);
      newParams.push(created.gt);
      idx++;
    }
    if (created.gte !== undefined) {
      conditions.push(`created >= $${idx}`);
      newParams.push(created.gte);
      idx++;
    }
    if (created.lt !== undefined) {
      conditions.push(`created < $${idx}`);
      newParams.push(created.lt);
      idx++;
    }
    if (created.lte !== undefined) {
      conditions.push(`created <= $${idx}`);
      newParams.push(created.lte);
      idx++;
    }
  }

  return {
    sql: conditions.length > 0 ? conditions.join(" AND ") : "",
    params: newParams,
    nextIndex: idx,
  };
}

function buildPaginationFilter(
  startingAfter: string | undefined,
  endingBefore: string | undefined,
  params: unknown[],
  paramIndex: number
): { sql: string; params: unknown[]; nextIndex: number; orderDesc: boolean } {
  let idx = paramIndex;
  const newParams: unknown[] = [];
  let sql = "";
  let orderDesc = true; // Default: ORDER BY id DESC (most recent first)

  if (startingAfter) {
    sql = `id < $${idx}`;
    newParams.push(startingAfter);
    idx++;
    orderDesc = true;
  } else if (endingBefore) {
    sql = `id > $${idx}`;
    newParams.push(endingBefore);
    idx++;
    orderDesc = false;
  }

  return { sql, params: newParams, nextIndex: idx, orderDesc };
}

// ============================================================================
// Resource Proxy Factory
// ============================================================================

type ResourceConfig = {
  tableName: string;
  filterMappings?: Record<string, string>; // Stripe param -> DB column
  defaultFilters?: Record<string, unknown>;
};

function createResourceProxy<
  TResource,
  TListParams extends BaseListParams,
  TCreateParams,
  TUpdateParams
>(
  pool: Pool | null,
  schema: string,
  stripeResource: {
    list: (params?: TListParams) => Stripe.ApiListPromise<TResource>;
    retrieve: (
      id: string,
      params?: Stripe.RequestOptions
    ) => Promise<Stripe.Response<TResource>>;
    create?: (params: TCreateParams) => Promise<Stripe.Response<TResource>>;
    update?: (
      id: string,
      params: TUpdateParams
    ) => Promise<Stripe.Response<TResource>>;
    del?: (id: string) => Promise<Stripe.Response<unknown>>;
  },
  config: ResourceConfig
): {
  list: (params?: TListParams) => Promise<Stripe.ApiList<TResource>>;
  retrieve: (
    id: string,
    params?: Stripe.RequestOptions
  ) => Promise<Stripe.Response<TResource>>;
  create?: (params: TCreateParams) => Promise<Stripe.Response<TResource>>;
  update?: (
    id: string,
    params: TUpdateParams
  ) => Promise<Stripe.Response<TResource>>;
  del?: typeof stripeResource.del;
} {
  const { tableName, filterMappings = {}, defaultFilters = {} } = config;

  async function listFromDb(
    params: TListParams | undefined
  ): Promise<Stripe.ApiList<TResource> | null> {
    if (!pool) return null;

    try {
      const limit = Math.min(params?.limit ?? 10, 100);
      const conditions: string[] = [];
      const queryParams: unknown[] = [];
      let paramIdx = 1;

      // Apply default filters
      for (const [column, value] of Object.entries(defaultFilters)) {
        conditions.push(`${column} = $${paramIdx}`);
        queryParams.push(value);
        paramIdx++;
      }

      // Apply created filter
      const createdResult = buildCreatedFilter(
        params?.created,
        queryParams,
        paramIdx
      );
      if (createdResult.sql) {
        conditions.push(createdResult.sql);
        queryParams.push(...createdResult.params);
        paramIdx = createdResult.nextIndex;
      }

      // Apply pagination
      const paginationResult = buildPaginationFilter(
        params?.starting_after,
        params?.ending_before,
        queryParams,
        paramIdx
      );
      if (paginationResult.sql) {
        conditions.push(paginationResult.sql);
        queryParams.push(...paginationResult.params);
        paramIdx = paginationResult.nextIndex;
      }

      // Apply resource-specific filters from mappings
      if (params) {
        for (const [stripeParam, dbColumn] of Object.entries(filterMappings)) {
          const value = (params as Record<string, unknown>)[stripeParam];
          if (value !== undefined) {
            conditions.push(`${dbColumn} = $${paramIdx}`);
            queryParams.push(value);
            paramIdx++;
          }
        }
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const orderDirection = paginationResult.orderDesc ? "DESC" : "ASC";

      // Fetch limit + 1 to determine if there are more results
      const query = `
        SELECT * FROM ${schema}.${tableName}
        ${whereClause}
        ORDER BY id ${orderDirection}
        LIMIT $${paramIdx}
      `;
      queryParams.push(limit + 1);

      const result = await pool.query(query, queryParams);

      const hasMore = result.rows.length > limit;
      const data = hasMore ? result.rows.slice(0, limit) : result.rows;

      // If we used ending_before, reverse the results to maintain correct order
      if (params?.ending_before) {
        data.reverse();
      }

      return {
        object: "list",
        data: data as TResource[],
        has_more: hasMore,
        url: `/v1/${tableName}`,
      };
    } catch (error) {
      console.warn(
        `FasterStripe: DB query failed for ${tableName}.list, falling back to Stripe API:`,
        error
      );
      return null;
    }
  }

  async function retrieveFromDb(id: string): Promise<TResource | null> {
    if (!pool) return null;

    try {
      const query = `SELECT * FROM ${schema}.${tableName} WHERE id = $1`;
      const result = await pool.query(query, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0] as TResource;
    } catch (error) {
      console.warn(
        `FasterStripe: DB query failed for ${tableName}.retrieve, falling back to Stripe API:`,
        error
      );
      return null;
    }
  }

  const proxy: ReturnType<
    typeof createResourceProxy<
      TResource,
      TListParams,
      TCreateParams,
      TUpdateParams
    >
  > = {
    async list(params?: TListParams): Promise<Stripe.ApiList<TResource>> {
      const dbResult = await listFromDb(params);
      if (dbResult) {
        return dbResult;
      }
      return stripeResource.list(params);
    },

    async retrieve(
      id: string,
      params?: Stripe.RequestOptions
    ): Promise<Stripe.Response<TResource>> {
      const dbResult = await retrieveFromDb(id);
      if (dbResult) {
        // Add lastResponse stub for compatibility
        return Object.assign(dbResult, {
          lastResponse: {
            headers: {},
            requestId: "db-cache",
            statusCode: 200,
          },
        }) as Stripe.Response<TResource>;
      }
      return stripeResource.retrieve(id, params);
    },
  };

  // Pass through write operations directly to Stripe
  if (stripeResource.create) {
    proxy.create = stripeResource.create.bind(stripeResource);
  }
  if (stripeResource.update) {
    proxy.update = stripeResource.update.bind(stripeResource);
  }
  if (stripeResource.del) {
    proxy.del = stripeResource.del.bind(stripeResource);
  }

  return proxy;
}

// ============================================================================
// FasterStripe Class
// ============================================================================

class FasterStripe {
  private stripe: Stripe;
  private pool: Pool | null = null;
  private schema: string;

  // Resource proxies
  public products: ReturnType<
    typeof createResourceProxy<
      Stripe.Product,
      Stripe.ProductListParams,
      Stripe.ProductCreateParams,
      Stripe.ProductUpdateParams
    >
  >;

  public prices: ReturnType<
    typeof createResourceProxy<
      Stripe.Price,
      Stripe.PriceListParams,
      Stripe.PriceCreateParams,
      Stripe.PriceUpdateParams
    >
  >;

  public customers: ReturnType<
    typeof createResourceProxy<
      Stripe.Customer,
      Stripe.CustomerListParams,
      Stripe.CustomerCreateParams,
      Stripe.CustomerUpdateParams
    >
  >;

  public subscriptions: ReturnType<
    typeof createResourceProxy<
      Stripe.Subscription,
      Stripe.SubscriptionListParams,
      Stripe.SubscriptionCreateParams,
      Stripe.SubscriptionUpdateParams
    >
  >;

  public invoices: ReturnType<
    typeof createResourceProxy<
      Stripe.Invoice,
      Stripe.InvoiceListParams,
      Stripe.InvoiceCreateParams,
      Stripe.InvoiceUpdateParams
    >
  >;

  public charges: ReturnType<
    typeof createResourceProxy<
      Stripe.Charge,
      Stripe.ChargeListParams,
      Stripe.ChargeCreateParams,
      Stripe.ChargeUpdateParams
    >
  >;

  public paymentIntents: ReturnType<
    typeof createResourceProxy<
      Stripe.PaymentIntent,
      Stripe.PaymentIntentListParams,
      Stripe.PaymentIntentCreateParams,
      Stripe.PaymentIntentUpdateParams
    >
  >;

  public paymentMethods: ReturnType<
    typeof createResourceProxy<
      Stripe.PaymentMethod,
      Stripe.PaymentMethodListParams,
      Stripe.PaymentMethodCreateParams,
      Stripe.PaymentMethodUpdateParams
    >
  >;

  public setupIntents: ReturnType<
    typeof createResourceProxy<
      Stripe.SetupIntent,
      Stripe.SetupIntentListParams,
      Stripe.SetupIntentCreateParams,
      Stripe.SetupIntentUpdateParams
    >
  >;

  public plans: ReturnType<
    typeof createResourceProxy<
      Stripe.Plan,
      Stripe.PlanListParams,
      Stripe.PlanCreateParams,
      Stripe.PlanUpdateParams
    >
  >;

  public coupons: ReturnType<
    typeof createResourceProxy<
      Stripe.Coupon,
      Stripe.CouponListParams,
      Stripe.CouponCreateParams,
      Stripe.CouponUpdateParams
    >
  >;

  public refunds: ReturnType<
    typeof createResourceProxy<
      Stripe.Refund,
      Stripe.RefundListParams,
      Stripe.RefundCreateParams,
      Stripe.RefundUpdateParams
    >
  >;

  public disputes: ReturnType<
    typeof createResourceProxy<
      Stripe.Dispute,
      Stripe.DisputeListParams,
      never,
      Stripe.DisputeUpdateParams
    >
  >;

  // Pass-through resources (no DB caching)
  public checkout: Stripe["checkout"];
  public billingPortal: Stripe["billingPortal"];
  public webhooks: Stripe["webhooks"];
  public webhookEndpoints: Stripe["webhookEndpoints"];

  /**
   * Create a new FasterStripe instance.
   *
   * @param apiKey - Stripe secret key. If not provided, reads from STRIPE_SECRET_KEY env var.
   * @param config - Optional configuration (extends Stripe.StripeConfig with databaseUrl and schema)
   *
   * @example
   * // Exact same as official Stripe SDK
   * const stripe = new Stripe('sk_test_...');
   * const stripe = new Stripe('sk_test_...', { apiVersion: '2023-10-16' });
   *
   * // Bonus: auto-read from env
   * const stripe = new Stripe(); // reads STRIPE_SECRET_KEY
   */
  constructor(apiKey?: string, config?: FasterStripeConfig) {
    const stripeSecretKey = apiKey ?? process.env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey) {
      throw new Error(
        "Stripe secret key is required. Pass it as first argument or set STRIPE_SECRET_KEY env var."
      );
    }

    // Extract our custom config options
    const { databaseUrl, schema, ...stripeConfig } = config ?? {};

    this.stripe = new Stripe(stripeSecretKey, stripeConfig);
    this.schema = schema ?? "stripe";

    // Initialize database pool
    const dbUrl = databaseUrl ?? process.env.DATABASE_URL;
    if (dbUrl) {
      try {
        this.pool =
          typeof dbUrl === "string"
            ? new Pool({ connectionString: dbUrl })
            : new Pool(dbUrl);
      } catch (error) {
        console.warn(
          "FasterStripe: Failed to initialize database pool, falling back to Stripe API only:",
          error
        );
      }
    }

    // Initialize resource proxies
    this.products = createResourceProxy<
      Stripe.Product,
      Stripe.ProductListParams,
      Stripe.ProductCreateParams,
      Stripe.ProductUpdateParams
    >(this.pool, this.schema, this.stripe.products as any, {
      tableName: "products",
      filterMappings: {
        active: "active",
      },
    });

    this.prices = createResourceProxy<
      Stripe.Price,
      Stripe.PriceListParams,
      Stripe.PriceCreateParams,
      Stripe.PriceUpdateParams
    >(this.pool, this.schema, this.stripe.prices as any, {
      tableName: "prices",
      filterMappings: {
        active: "active",
        product: "product",
        currency: "currency",
        type: "type",
      },
    });

    this.customers = createResourceProxy<
      Stripe.Customer,
      Stripe.CustomerListParams,
      Stripe.CustomerCreateParams,
      Stripe.CustomerUpdateParams
    >(this.pool, this.schema, this.stripe.customers as any, {
      tableName: "customers",
      filterMappings: {
        email: "email",
      },
      defaultFilters: {
        deleted: false,
      },
    });

    this.subscriptions = createResourceProxy<
      Stripe.Subscription,
      Stripe.SubscriptionListParams,
      Stripe.SubscriptionCreateParams,
      Stripe.SubscriptionUpdateParams
    >(this.pool, this.schema, this.stripe.subscriptions as any, {
      tableName: "subscriptions",
      filterMappings: {
        customer: "customer",
        price: "plan",
        status: "status",
      },
    });

    this.invoices = createResourceProxy<
      Stripe.Invoice,
      Stripe.InvoiceListParams,
      Stripe.InvoiceCreateParams,
      Stripe.InvoiceUpdateParams
    >(this.pool, this.schema, this.stripe.invoices as any, {
      tableName: "invoices",
      filterMappings: {
        customer: "customer",
        subscription: "subscription",
        status: "status",
      },
    });

    this.charges = createResourceProxy<
      Stripe.Charge,
      Stripe.ChargeListParams,
      Stripe.ChargeCreateParams,
      Stripe.ChargeUpdateParams
    >(this.pool, this.schema, this.stripe.charges as any, {
      tableName: "charges",
      filterMappings: {
        customer: "customer",
        payment_intent: "payment_intent",
      },
    });

    this.paymentIntents = createResourceProxy<
      Stripe.PaymentIntent,
      Stripe.PaymentIntentListParams,
      Stripe.PaymentIntentCreateParams,
      Stripe.PaymentIntentUpdateParams
    >(this.pool, this.schema, this.stripe.paymentIntents as any, {
      tableName: "payment_intents",
      filterMappings: {
        customer: "customer",
      },
    });

    this.paymentMethods = createResourceProxy<
      Stripe.PaymentMethod,
      Stripe.PaymentMethodListParams,
      Stripe.PaymentMethodCreateParams,
      Stripe.PaymentMethodUpdateParams
    >(this.pool, this.schema, this.stripe.paymentMethods as any, {
      tableName: "payment_methods",
      filterMappings: {
        customer: "customer",
        type: "type",
      },
    });

    this.setupIntents = createResourceProxy<
      Stripe.SetupIntent,
      Stripe.SetupIntentListParams,
      Stripe.SetupIntentCreateParams,
      Stripe.SetupIntentUpdateParams
    >(this.pool, this.schema, this.stripe.setupIntents as any, {
      tableName: "setup_intents",
      filterMappings: {
        customer: "customer",
        payment_method: "payment_method",
      },
    });

    this.plans = createResourceProxy<
      Stripe.Plan,
      Stripe.PlanListParams,
      Stripe.PlanCreateParams,
      Stripe.PlanUpdateParams
    >(this.pool, this.schema, this.stripe.plans as any, {
      tableName: "plans",
      filterMappings: {
        active: "active",
        product: "product",
      },
    });

    this.coupons = createResourceProxy<
      Stripe.Coupon,
      Stripe.CouponListParams,
      Stripe.CouponCreateParams,
      Stripe.CouponUpdateParams
    >(this.pool, this.schema, this.stripe.coupons as any, {
      tableName: "coupons",
    });

    this.refunds = createResourceProxy<
      Stripe.Refund,
      Stripe.RefundListParams,
      Stripe.RefundCreateParams,
      Stripe.RefundUpdateParams
    >(this.pool, this.schema, this.stripe.refunds as any, {
      tableName: "refunds",
      filterMappings: {
        charge: "charge",
        payment_intent: "payment_intent",
      },
    });

    this.disputes = createResourceProxy<
      Stripe.Dispute,
      Stripe.DisputeListParams,
      never,
      Stripe.DisputeUpdateParams
    >(this.pool, this.schema, this.stripe.disputes as any, {
      tableName: "disputes",
      filterMappings: {
        charge: "charge",
        payment_intent: "payment_intent",
      },
    });

    // Pass-through resources that don't benefit from DB caching
    this.checkout = this.stripe.checkout;
    this.billingPortal = this.stripe.billingPortal;
    this.webhooks = this.stripe.webhooks;
    this.webhookEndpoints = this.stripe.webhookEndpoints;
  }

  /**
   * Get the underlying Stripe instance for operations not covered by FasterStripe
   */
  get raw(): Stripe {
    return this.stripe;
  }

  /**
   * Check if database connection is available
   */
  get hasDatabase(): boolean {
    return this.pool !== null;
  }

  /**
   * Close the database pool connection
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

// Named export for explicit imports
export { FasterStripe };

// Default export for drop-in replacement compatibility
export default FasterStripe;
