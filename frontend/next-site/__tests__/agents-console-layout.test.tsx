import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AgentsConsoleLayout, resolveAgentsConsoleRoute } from "../agents-console-layout";

const route = vi.hoisted(() => ({ pathname: "/agents/channels" }));
const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0, sections: [] as Array<string | undefined> }));

vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
vi.mock("@next-site/agents-page-client", async () => {
  const { useEffect } = await import("react");
  return {
    AgentsPageClient: ({ sectionId }: { sectionId?: string }) => {
      lifecycle.sections.push(sectionId);
      useEffect(() => {
        lifecycle.mounts += 1;
        return () => { lifecycle.unmounts += 1; };
      }, []);
      return <div data-testid="console" />;
    },
  };
});

afterEach(() => {
  cleanup();
  Object.assign(lifecycle, { mounts: 0, unmounts: 0, sections: [] });
});

it("keeps one console instance while the sidebar switches sections", () => {
  route.pathname = "/agents/channels";
  const view = render(<AgentsConsoleLayout>{null}</AgentsConsoleLayout>);
  for (const pathname of ["/agents/skills/", "/agents/chat", "/agents", "/agents/labs/cloud-desktop"]) {
    route.pathname = pathname;
    view.rerender(<AgentsConsoleLayout>{null}</AgentsConsoleLayout>);
  }
  expect(lifecycle.mounts).toBe(1);
  expect(lifecycle.unmounts).toBe(0);
  expect(lifecycle.sections.at(-1)).toBe("cloud-desktop");
  expect(lifecycle.sections).toContain("chat");
});

it("leaves unknown console URLs to their page", () => {
  route.pathname = "/agents/not-a-section";
  const view = render(<AgentsConsoleLayout><p>not found</p></AgentsConsoleLayout>);
  expect(view.queryByTestId("console")).toBeNull();
  expect(view.getByText("not found")).toBeInTheDocument();
});

it.each([
  ["/agents", {}],
  ["/agents/", {}],
  ["/agents/chat/", { slug: "chat", sectionId: "chat" }],
  ["/agents/channels", { slug: "channels", sectionId: "channel" }],
  ["/agents/labs/deepseek-harness", { slug: "deepseek-harness", sectionId: "deepseek-harness" }],
  ["/agents/labs", null],
  ["/agents/constructor", null],
  ["/agents/chat/extra", null],
  ["/account", null],
])("resolves %s", (pathname, expected) => {
  expect(resolveAgentsConsoleRoute(pathname)).toEqual(expected);
});
