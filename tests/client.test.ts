import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createCheckoutClient } from "../src/client";

// Mock window.location for redirect tests
const mockLocation = {
  href: "",
};

// @ts-ignore - global mock
globalThis.window = { location: mockLocation } as any;

describe("Checkout Client", () => {
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    mockLocation.href = "";
    fetchMock = mock(() => Promise.resolve(new Response()));
    // @ts-ignore
    globalThis.fetch = fetchMock;
  });

  describe("createCheckoutClient", () => {
    it("creates client with default config", () => {
      const client = createCheckoutClient();

      expect(client.checkout).toBeDefined();
      expect(typeof client.checkout).toBe("function");
      expect(client.customerPortal).toBeDefined();
      expect(typeof client.customerPortal).toBe("function");
    });

    it("creates client with custom endpoints", () => {
      const client = createCheckoutClient({
        checkoutEndpoint: "/custom/checkout",
        customerPortalEndpoint: "/custom/portal",
      });

      expect(client.checkout).toBeDefined();
      expect(client.customerPortal).toBeDefined();
    });
  });

  describe("checkout", () => {
    it("calls correct endpoint with plan options", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ url: "https://checkout.stripe.com/test" }), {
            status: 200,
          })
        )
      );

      const { checkout } = createCheckoutClient();

      await checkout({ planName: "Pro", interval: "month" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/stripe/checkout");
      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(options.body);
      expect(body.planName).toBe("Pro");
      expect(body.interval).toBe("month");
    });

    it("redirects to checkout URL on success", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ url: "https://checkout.stripe.com/pay/test123" }), {
            status: 200,
          })
        )
      );

      const { checkout } = createCheckoutClient();
      await checkout({ planName: "Pro", interval: "month" });

      expect(mockLocation.href).toBe("https://checkout.stripe.com/pay/test123");
    });

    it("calls onLoading callback", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ url: "https://checkout.stripe.com/test" }), {
            status: 200,
          })
        )
      );

      const loadingStates: boolean[] = [];
      const { checkout } = createCheckoutClient({
        onLoading: (isLoading) => loadingStates.push(isLoading),
      });

      await checkout({ planName: "Pro", interval: "month" });

      expect(loadingStates[0]).toBe(true);
      // Note: onLoading(false) is not called on success with redirect
    });

    it("calls onRedirect callback before redirect", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ url: "https://checkout.stripe.com/redirect" }), {
            status: 200,
          })
        )
      );

      let redirectUrl = "";
      const { checkout } = createCheckoutClient({
        onRedirect: (url) => {
          redirectUrl = url;
        },
      });

      await checkout({ planName: "Pro", interval: "month" });

      expect(redirectUrl).toBe("https://checkout.stripe.com/redirect");
    });

    it("handles alreadySubscribed response", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ success: true, alreadySubscribed: true, message: "Already on this plan" }),
            { status: 200 }
          )
        )
      );

      const loadingStates: boolean[] = [];
      const { checkout } = createCheckoutClient({
        onLoading: (isLoading) => loadingStates.push(isLoading),
      });

      await checkout({ planName: "Pro", interval: "month" });

      // Should not redirect
      expect(mockLocation.href).toBe("");
      // Should call onLoading(false)
      expect(loadingStates).toContain(false);
    });

    it("handles direct upgrade response with onPlanChanged", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ success: true, redirectUrl: "https://app.com/success" }),
            { status: 200 }
          )
        )
      );

      let planChangedUrl = "";
      const { checkout } = createCheckoutClient({
        onPlanChanged: (url) => {
          planChangedUrl = url;
        },
      });

      await checkout({ planName: "Enterprise", interval: "month" });

      expect(planChangedUrl).toBe("https://app.com/success");
      // Should not redirect when onPlanChanged is provided
      expect(mockLocation.href).toBe("");
    });

    it("redirects on upgrade when no onPlanChanged callback", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ success: true, redirectUrl: "https://app.com/upgraded" }),
            { status: 200 }
          )
        )
      );

      const { checkout } = createCheckoutClient();

      await checkout({ planName: "Enterprise", interval: "month" });

      expect(mockLocation.href).toBe("https://app.com/upgraded");
    });

    it("throws error on HTTP error response", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "Invalid plan" }), { status: 400 })
        )
      );

      let caughtError: Error | null = null;
      const { checkout } = createCheckoutClient({
        onError: (err) => {
          caughtError = err;
        },
      });

      try {
        await checkout({ planName: "Invalid", interval: "month" });
      } catch (err) {
        // Expected
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError!.message).toBe("Invalid plan");
    });

    it("throws error when no URL returned", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true }), { status: 200 })
        )
      );

      let caughtError: Error | null = null;
      const { checkout } = createCheckoutClient({
        onError: (err) => {
          caughtError = err;
        },
      });

      try {
        await checkout({ planName: "Pro", interval: "month" });
      } catch (err) {
        // Expected
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError!.message).toBe("No checkout URL returned");
    });

    it("uses custom checkout endpoint", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ url: "https://checkout.stripe.com/test" }), {
            status: 200,
          })
        )
      );

      const { checkout } = createCheckoutClient({
        checkoutEndpoint: "/custom/billing/checkout",
      });

      await checkout({ planName: "Pro", interval: "month" });

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("/custom/billing/checkout");
    });

    it("passes all checkout options", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ url: "https://checkout.stripe.com/test" }), {
            status: 200,
          })
        )
      );

      const { checkout } = createCheckoutClient();

      await checkout({
        planId: "pro_plan",
        interval: "year",
        priceId: "price_123",
        quantity: 5,
        successUrl: "https://custom.com/success",
        cancelUrl: "https://custom.com/cancel",
        metadata: { campaign: "summer_sale" },
      });

      const [, options] = fetchMock.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(body.planId).toBe("pro_plan");
      expect(body.interval).toBe("year");
      expect(body.priceId).toBe("price_123");
      expect(body.quantity).toBe(5);
      expect(body.successUrl).toBe("https://custom.com/success");
      expect(body.cancelUrl).toBe("https://custom.com/cancel");
      expect(body.metadata.campaign).toBe("summer_sale");
    });
  });

  describe("customerPortal", () => {
    it("calls correct endpoint", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ url: "https://billing.stripe.com/portal" }), {
            status: 200,
          })
        )
      );

      const { customerPortal } = createCheckoutClient();

      await customerPortal();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/stripe/customer_portal");
      expect(options.method).toBe("POST");
    });

    it("redirects to portal URL", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ url: "https://billing.stripe.com/session/abc" }), {
            status: 200,
          })
        )
      );

      const { customerPortal } = createCheckoutClient();

      await customerPortal();

      expect(mockLocation.href).toBe("https://billing.stripe.com/session/abc");
    });

    it("calls onLoading callback", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ url: "https://billing.stripe.com/portal" }), {
            status: 200,
          })
        )
      );

      const loadingStates: boolean[] = [];
      const { customerPortal } = createCheckoutClient({
        onLoading: (isLoading) => loadingStates.push(isLoading),
      });

      await customerPortal();

      expect(loadingStates[0]).toBe(true);
    });

    it("calls onRedirect callback", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ url: "https://billing.stripe.com/redirect" }), {
            status: 200,
          })
        )
      );

      let redirectUrl = "";
      const { customerPortal } = createCheckoutClient({
        onRedirect: (url) => {
          redirectUrl = url;
        },
      });

      await customerPortal();

      expect(redirectUrl).toBe("https://billing.stripe.com/redirect");
    });

    it("throws error on HTTP error response", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
        )
      );

      let caughtError: Error | null = null;
      const { customerPortal } = createCheckoutClient({
        onError: (err) => {
          caughtError = err;
        },
      });

      try {
        await customerPortal();
      } catch (err) {
        // Expected
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError!.message).toBe("Unauthorized");
    });

    it("throws error when no portal URL returned", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true }), { status: 200 })
        )
      );

      let caughtError: Error | null = null;
      const { customerPortal } = createCheckoutClient({
        onError: (err) => {
          caughtError = err;
        },
      });

      try {
        await customerPortal();
      } catch (err) {
        // Expected
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError!.message).toBe("No portal URL returned");
    });

    it("uses custom portal endpoint", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ url: "https://billing.stripe.com/portal" }), {
            status: 200,
          })
        )
      );

      const { customerPortal } = createCheckoutClient({
        customerPortalEndpoint: "/custom/billing/portal",
      });

      await customerPortal();

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("/custom/billing/portal");
    });
  });

  describe("Error Handling", () => {
    it("handles fetch network errors", async () => {
      fetchMock.mockImplementation(() => Promise.reject(new Error("Network error")));

      let caughtError: Error | null = null;
      let loadingFalse = false;
      const { checkout } = createCheckoutClient({
        onError: (err) => {
          caughtError = err;
        },
        onLoading: (isLoading) => {
          if (!isLoading) loadingFalse = true;
        },
      });

      try {
        await checkout({ planName: "Pro", interval: "month" });
      } catch (err) {
        // Expected
      }

      expect(caughtError!.message).toBe("Network error");
      expect(loadingFalse).toBe(true);
    });

    it("handles non-JSON error responses", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response("Internal Server Error", { status: 500 })
        )
      );

      let caughtError: Error | null = null;
      const { checkout } = createCheckoutClient({
        onError: (err) => {
          caughtError = err;
        },
      });

      try {
        await checkout({ planName: "Pro", interval: "month" });
      } catch (err) {
        // Expected
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError!.message).toContain("Checkout failed: 500");
    });

    it("converts non-Error exceptions to Error", async () => {
      fetchMock.mockImplementation(() => Promise.reject("String error"));

      let caughtError: Error | null = null;
      const { checkout } = createCheckoutClient({
        onError: (err) => {
          caughtError = err;
        },
      });

      try {
        await checkout({ planName: "Pro", interval: "month" });
      } catch (err) {
        // Expected
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError!.message).toBe("String error");
    });
  });
});

describe("Default Exports", () => {
  it("exports default checkout and customerPortal functions", async () => {
    // Import the default exports
    const { checkout, customerPortal } = await import("../src/client");

    expect(typeof checkout).toBe("function");
    expect(typeof customerPortal).toBe("function");
  });
});
