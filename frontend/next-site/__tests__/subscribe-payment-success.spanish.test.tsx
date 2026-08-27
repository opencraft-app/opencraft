import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Bundle } from "@/domain/types";
import { LocaleOverrideProvider } from "@/i18n/t";
import { CreditCardConfirmOrderModal } from "@next-site/subscribe-page";

const rawBundle: Bundle = {
  bundle_id: "bundle_cruise_ai_01",
  bundle_name: "Cruise",
  description: [],
  bundle_state: "ONLINE",
  bundle_type: "ai",
  agent_quota: 1,
  credit: 10_000,
  price: null,
  time_span: 1,
  time_unit: "m",
  bundle_sales_available_count: 100,
  bundle_sales_total_count: 100,
  bundle_sales_state: "AVAILABLE",
};

describe("CreditCardConfirmOrderModal Spanish success state", () => {
  it("renders translated success copy, interpolation, and close controls", () => {
    const onCancel = vi.fn();

    render(
      <LocaleOverrideProvider locale="es">
        <CreditCardConfirmOrderModal
          plan={{
            id: "cruise",
            name: "Cruise",
            price: "$7.50",
            description: "",
            features: [],
            ctaLabel: "",
            ctaStyle: "primary",
            maxBots: 1,
            raw: rawBundle,
          }}
          billingPeriodLabel="/ mes"
          demoMode
          onCancel={onCancel}
          onPay={vi.fn()}
        />
      </LocaleOverrideProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pagar $7.50" }));

    expect(screen.getByRole("heading", { name: "Pago realizado" })).toBeInTheDocument();
    expect(screen.getByText("Te has suscrito al plan «Cruise».")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Cerrar" })).toHaveLength(2);
  });
});
