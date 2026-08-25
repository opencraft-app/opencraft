import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHttpRepositories } from "@/repositories/http-repositories";

describe("http auth repository payment methods", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists the signed payment methods", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          total: 1,
          items: [
            {
              contractCode: "contract-1",
              maskedNumber: "555555****4444",
              payerName: "Ada Lovelace",
              type: "CREDIT_CARD",
              isDefault: true,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://api.example.test");

    await expect(repositories.auth.listPaymentMethods()).resolves.toEqual({
      total: 1,
      items: [
        {
          contractCode: "contract-1",
          maskedNumber: "555555****4444",
          payerName: "Ada Lovelace",
          type: "CREDIT_CARD",
          isDefault: true,
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/auth/payment-methods?page=1&pageSize=100",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("creates a hosted sign order with the requested language", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          contractCode: "contract-2",
          redirectUrl: "https://payments.example.test/sign/order-2",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://api.example.test");

    await expect(repositories.auth.createPaymentMethodSignOrder("en")).resolves.toEqual({
      contractCode: "contract-2",
      redirectUrl: "https://payments.example.test/sign/order-2",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/auth/payment-methods/sign-orders",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ languageCode: "en" }),
      }),
    );
  });

  it("sets a payment method as default using an encoded contract code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://api.example.test");

    await expect(repositories.auth.setDefaultPaymentMethod("contract/with?reserved")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/auth/payment-methods/contract%2Fwith%3Freserved/default",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("deletes a non-default payment method using an encoded contract code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const repositories = createHttpRepositories("https://api.example.test");

    await expect(repositories.auth.deletePaymentMethod("contract/with?reserved")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/auth/payment-methods/contract%2Fwith%3Freserved",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
