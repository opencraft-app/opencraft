import { render, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { PublicSiteLocaleBridge } from "./public-site-providers";

describe("PublicSiteLocaleBridge", () => {
  beforeEach(() => {
    document.documentElement.lang = "en-US";
  });

  it("synchronizes the document language with the Spanish route locale", async () => {
    render(
      <PublicSiteLocaleBridge locale="es">
        <div>Contenido</div>
      </PublicSiteLocaleBridge>,
    );

    await waitFor(() => expect(document.documentElement.lang).toBe("es"));
  });
});
