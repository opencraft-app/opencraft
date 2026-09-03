import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import BrandIconsSection from "../BrandIconsSection";
import CtaSection from "../CtaSection";
import FeatureSection, { CardsSection } from "../FeatureSection";
import HeroSection from "../HeroSection";
import ProcessSection from "../ProcessSection";

class IntersectionObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function renderedImages(Component: () => React.ReactNode): HTMLImageElement[] {
  const { container } = render(<>{Component()}</>);
  return Array.from(container.querySelectorAll("img"));
}

function uniqueSources(images: readonly HTMLImageElement[]): string[] {
  return [...new Set(images.map((image) => image.getAttribute("src") ?? ""))];
}

function expectAllLazy(images: readonly HTMLImageElement[]): void {
  expect(images.length).toBeGreaterThan(0);
  for (const image of images) {
    expect(image).toHaveAttribute("loading", "lazy");
  }
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("homepage image loading", () => {
  it("keeps the four hero images eager", () => {
    const images = renderedImages(() => <HeroSection />);

    expect(uniqueSources(images)).toHaveLength(4);
    for (const image of images) {
      expect(image).not.toHaveAttribute("loading", "lazy");
    }
  });

  it("loads the brand strip lazily", () => {
    const images = renderedImages(() => <BrandIconsSection />);

    expect(uniqueSources(images)).toHaveLength(1);
    expectAllLazy(images);
  });

  it("loads all 18 unique marquee icons lazily", () => {
    const images = renderedImages(() => <FeatureSection />);

    expect(uniqueSources(images)).toHaveLength(18);
    expectAllLazy(images);
  });

  it("loads all 12 unique cloud-native card images lazily", () => {
    const images = renderedImages(() => <CardsSection />);

    expect(uniqueSources(images)).toHaveLength(12);
    expectAllLazy(images);
  });

  it("loads all seven unique process images lazily across desktop and mobile", () => {
    const images = renderedImages(() => <ProcessSection />);

    expect(uniqueSources(images)).toHaveLength(7);
    expect(images).toHaveLength(10);
    expectAllLazy(images);
  });

  it("loads both CTA images lazily", () => {
    const images = renderedImages(() => <CtaSection />);

    expect(uniqueSources(images)).toHaveLength(2);
    expectAllLazy(images);
  });
});
