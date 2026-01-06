/**
 * Helper functions for the sync command.
 * Extracted for testability.
 */

/**
 * Builds a lookup map of Stripe products by name (case-insensitive)
 * @param {Array} stripeProducts - Array of Stripe product objects
 * @returns {Object} Map of lowercase product name to product object
 */
function buildProductsByNameMap(stripeProducts) {
  const map = {};
  for (const product of stripeProducts) {
    const key = product.name.toLowerCase().trim();
    if (!map[key]) {
      map[key] = product;
    }
  }
  return map;
}

/**
 * Builds a lookup map of Stripe prices by composite key
 * Key format: productId:amount:currency:interval
 * @param {Array} stripePrices - Array of Stripe price objects
 * @returns {Object} Map of composite key to price object
 */
function buildPricesByKeyMap(stripePrices) {
  const map = {};
  for (const price of stripePrices) {
    const productId =
      typeof price.product === "string" ? price.product : price.product.id;
    const interval = price.recurring?.interval || "one_time";
    const key = `${productId}:${price.unit_amount}:${price.currency}:${interval}`;
    if (!map[key]) {
      map[key] = price;
    }
  }
  return map;
}

/**
 * Finds a matching product by name (case-insensitive)
 * @param {Object} productsByName - Map of lowercase product names to products
 * @param {string} planName - Name of the plan to match
 * @returns {Object|null} Matching product or null
 */
function findMatchingProduct(productsByName, planName) {
  const key = planName.toLowerCase().trim();
  return productsByName[key] || null;
}

/**
 * Generates a price key for matching
 * @param {string} productId - Stripe product ID
 * @param {number} amount - Price amount in cents
 * @param {string} currency - Currency code
 * @param {string} interval - Price interval (month, year, one_time, etc.)
 * @returns {string} Composite key
 */
function generatePriceKey(productId, amount, currency, interval) {
  return `${productId}:${amount}:${currency.toLowerCase()}:${interval || "one_time"}`;
}

/**
 * Finds a matching price by product, amount, currency, and interval
 * @param {Object} pricesByKey - Map of composite keys to prices
 * @param {string} productId - Stripe product ID
 * @param {Object} localPrice - Local price object with amount, currency, interval
 * @returns {Object|null} Matching price or null
 */
function findMatchingPrice(pricesByKey, productId, localPrice) {
  const key = generatePriceKey(
    productId,
    localPrice.amount,
    localPrice.currency,
    localPrice.interval
  );
  return pricesByKey[key] || null;
}

/**
 * Processes sync for a single plan
 * @param {Object} plan - Local plan object
 * @param {Object} productsByName - Map of Stripe products by name
 * @param {Object} pricesByKey - Map of Stripe prices by key
 * @param {Object} stripeApi - Stripe API interface with products.create and prices.create
 * @returns {Object} Result with updated plan, counts, and any errors
 */
async function syncPlan(plan, productsByName, pricesByKey, stripeApi) {
  const result = {
    plan: { ...plan },
    productMatched: false,
    productCreated: false,
    pricesMatched: 0,
    pricesCreated: 0,
    errors: [],
  };

  let productId = plan.id;

  // Handle product sync
  if (!productId) {
    const existingProduct = findMatchingProduct(productsByName, plan.name);

    if (existingProduct) {
      productId = existingProduct.id;
      result.plan.id = productId;
      result.productMatched = true;
    } else {
      try {
        const newProduct = await stripeApi.products.create({
          name: plan.name,
          description: plan.description || undefined,
        });
        productId = newProduct.id;
        result.plan.id = productId;
        result.productCreated = true;
        // Add to map for price matching
        const nameKey = plan.name.toLowerCase().trim();
        productsByName[nameKey] = newProduct;
      } catch (error) {
        result.errors.push(`Failed to create product "${plan.name}": ${error.message}`);
        return result;
      }
    }
  }

  // Handle price sync
  if (plan.price && plan.price.length > 0) {
    result.plan.price = [];

    for (const price of plan.price) {
      const updatedPrice = { ...price };

      if (!price.id) {
        const existingPrice = findMatchingPrice(pricesByKey, productId, price);

        if (existingPrice) {
          updatedPrice.id = existingPrice.id;
          result.pricesMatched++;
        } else {
          try {
            const priceParams = {
              product: productId,
              unit_amount: price.amount,
              currency: price.currency.toLowerCase(),
            };

            if (price.interval && price.interval !== "one_time") {
              priceParams.recurring = {
                interval: price.interval,
              };
            }

            const newPrice = await stripeApi.prices.create(priceParams);
            updatedPrice.id = newPrice.id;
            result.pricesCreated++;

            // Add to map
            const priceKey = generatePriceKey(
              productId,
              price.amount,
              price.currency,
              price.interval
            );
            pricesByKey[priceKey] = newPrice;
          } catch (error) {
            result.errors.push(
              `Failed to create price ${price.amount} ${price.currency}/${price.interval}: ${error.message}`
            );
          }
        }
      }

      result.plan.price.push(updatedPrice);
    }
  }

  return result;
}

module.exports = {
  buildProductsByNameMap,
  buildPricesByKeyMap,
  findMatchingProduct,
  findMatchingPrice,
  generatePriceKey,
  syncPlan,
};
