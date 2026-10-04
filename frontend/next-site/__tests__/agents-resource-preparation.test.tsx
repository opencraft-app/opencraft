import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsPageClient } from "../agents-page-client";

const state = vi.hoisted(() => ({ authReady:true, authenticated:true, global:false, botsReady:false }));
vi.mock("next/navigation", () => ({ usePathname:()=>"/agents/chat" }));
vi.mock("@/contexts/session-context", () => ({ useSession:()=>({authReady:state.authReady,isAuthenticated:state.authenticated}) }));
vi.mock("@/contexts/agent-context", () => ({ useOpenClaw:()=>({
  bots:state.botsReady?[{id:"confirmed-bot"}]:[], botsLoading:!state.botsReady, hasResolvedBots:state.botsReady,
  hasResolvedPasses:true,isSubscribed:true,latestPass:{},passesLoading:false,passesError:false,botsError:false,
}) }));
vi.mock("@/lib/region", () => ({ get isGlobal(){return state.global;} }));
vi.mock("@/lib/app-navigation", () => ({ useAppNavigate:()=>vi.fn(), useAppSearchParams:()=>[new URLSearchParams(), vi.fn()] }));
vi.mock("@/i18n/t", () => ({ useT:()=>((key:string)=>key) }));
vi.mock("react-i18next", () => ({ useTranslation:()=>({i18n:{language:"zh-CN"}}) }));
vi.mock("../next-app-navigation", () => ({ NextAppNavigationProvider:({children}:{children:ReactNode})=>children }));
vi.mock("@/observability/rum-user-bridge", () => ({ RumUserBridge:()=>null }));
vi.mock("@/theme/theme-style", () => ({ ThemeStyleInjector:()=>null }));
vi.mock("@/components/site/product-chrome", () => ({ ProductReturnHomeHeader:()=>null }));
vi.mock("@/components/site/legal-footer", () => ({ LegalFooter:()=>null }));
vi.mock("@/components/site/login-modal", () => ({ LoginModal:()=>null }));
vi.mock("@/components/site/agent-sidebar", () => ({
  AgentSidebarToggle:()=>null, useAgentSidebarCollapse:()=>({collapsed:false,toggle:vi.fn(),transitionReady:true}),
  AgentSidebar:({children}:{children:ReactNode})=>children,
}));
vi.mock("@/pages/marketing/agent-settings-page", () => ({ AgentSettingsPage:()=> <div data-testid="settings-page" /> }));

const scripts = () => document.head.querySelectorAll<HTMLScriptElement>("script[data-opencraft-embedded-workbench]");
beforeEach(()=>{
  Object.assign(state,{authReady:true,authenticated:true,global:false,botsReady:false});
  localStorage.setItem("lightvela:console-show-enabled:v1","0");
  vi.stubEnv("NEXT_PUBLIC_OPENCRAFT_EMBED_SCRIPT_URL","/__opencraft/embedded-workbench.js");
});
afterEach(()=>{
  cleanup();
  for(const script of scripts()) script.dispatchEvent(new Event("error"));
  vi.unstubAllEnvs();
});

it("prepares domestic Chat resources while the real Bot gate still withholds the settings page", async()=>{
  const view=render(<AgentsPageClient sectionId="chat" />);
  await waitFor(()=>expect(scripts()).toHaveLength(1));
  expect(screen.queryByTestId("settings-page")).toBeNull();
  expect(document.querySelector("opencraft-embedded-workbench")).toBeNull();
  state.botsReady=true;
  view.rerender(<AgentsPageClient sectionId="chat" />);
  await screen.findByTestId("settings-page");
  expect(scripts()).toHaveLength(1);
});

it.each(["auth-restoring","anonymous","international","non-chat"])("does not speculate for %s", async kind=>{
  if(kind==="auth-restoring")state.authReady=false;
  if(kind==="anonymous")state.authenticated=false;
  if(kind==="international")state.global=true;
  render(<AgentsPageClient sectionId={kind==="non-chat"?"settings":"chat"} />);
  expect(scripts()).toHaveLength(0);
});

it("starts code preparation after authentication restores without opening the Bot gate", async () => {
  state.authReady = false;
  const view = render(<AgentsPageClient sectionId="chat" />);
  expect(scripts()).toHaveLength(0);
  state.authReady = true;
  view.rerender(<AgentsPageClient sectionId="chat" />);
  await waitFor(() => expect(scripts()).toHaveLength(1));
  expect(screen.queryByTestId("settings-page")).toBeNull();
  expect(document.querySelector("opencraft-embedded-workbench")).toBeNull();
});

it("starts code preparation when navigating into Chat and reuses the in-flight loader", async () => {
  const view = render(<AgentsPageClient sectionId="settings" />);
  expect(scripts()).toHaveLength(0);
  view.rerender(<AgentsPageClient sectionId="chat" />);
  await waitFor(() => expect(scripts()).toHaveLength(1));
  view.rerender(<AgentsPageClient sectionId="settings" />);
  view.rerender(<AgentsPageClient sectionId="chat" />);
  expect(scripts()).toHaveLength(1);
  expect(screen.queryByTestId("settings-page")).toBeNull();
});
