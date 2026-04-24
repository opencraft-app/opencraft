import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StyleLabPage } from "@/pages/style-lab-page";

describe("StyleLabPage", () => {
  it("presents the homepage grammar handbook for app surfaces", () => {
    render(
      <MemoryRouter>
        <StyleLabPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Homepage Grammar" })).toBeInTheDocument();
    expect(screen.getByText("Marketing spirit, app discipline.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "App Mappings" })).toBeInTheDocument();
  });
});
