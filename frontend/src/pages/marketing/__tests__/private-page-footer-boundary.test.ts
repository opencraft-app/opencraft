import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), "utf8");

const parseSource = (relativePath: string) => {
  const source = readSource(relativePath);
  return ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
};

const getRenderedElementNames = (relativePath: string) => {
  const sourceFile = parseSource(relativePath);
  const names = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      names.add(node.tagName.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return names;
};

const getJsxAttributeInitializer = (
  relativePath: string,
  elementName: string,
  attributeName: string,
): string | undefined => {
  const sourceFile = parseSource(relativePath);
  let initializer: string | undefined;

  const visit = (node: ts.Node): void => {
    if (initializer !== undefined) return;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(sourceFile) === elementName) {
        const attribute = node.attributes.properties.find(
          (property): property is ts.JsxAttribute =>
            ts.isJsxAttribute(property)
            && ts.isIdentifier(property.name)
            && property.name.text === attributeName,
        );
        initializer = attribute?.initializer?.getText(sourceFile);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return initializer;
};

describe("Private page footer boundary", () => {
  it("omits the product footer from every Agents settings page", () => {
    expect(
      getRenderedElementNames("src/pages/marketing/agent-settings-page.tsx"),
    ).not.toContain("ProductFooter");
  });

  it("disables the shared product footer on the account page", () => {
    expect(
      getJsxAttributeInitializer(
        "src/pages/marketing/account-page.tsx",
        "ProductPageShell",
        "footer",
      ),
    ).toBe("{null}");
  });

  it("omits the legal footer from the account orders page", () => {
    expect(
      getRenderedElementNames("src/pages/marketing/account-orders-page.tsx"),
    ).not.toContain("LegalFooter");
  });
});
