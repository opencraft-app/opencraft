import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * Test-only execution of r3562 function bodies, not a second semantic rewrite.
 * Bundle initialization, application selectors, React/Motion and presentation
 * are injected explicitly. No Vela scroll/follow/virtualizer implementation is
 * imported by the reference endpoint. Each extracted body is fingerprinted.
 */
export function createCodexScrollReferenceModules(root: string) {
  const fingerprints: Record<string, string> = {};
  const functions = (file: string, names: readonly string[]) => {
    const source = readFileSync(join(root, file), "utf8");
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    return names
      .map((name) => {
        const node = ast.statements.find(
          (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) &&
            statement.name?.text === name,
        );
        if (node === undefined)
          throw new Error(`Missing reference function: ${file}#${name}`);
        const body = source.slice(node.getStart(ast), node.end);
        fingerprints[`${file}#${name}`] = createHash("sha256")
          .update(body)
          .digest("hex");
        return body;
      })
      .join("\n");
  };
  const lazy = "lazy/app-initial/";
  const modules = new Map<string, string>();
  const id = (name: string) => `virtual:codex-scroll-${name}`;
  modules.set(
    id("common"),
    `
    import * as React from "react";
    import * as compiler from "react/compiler-runtime";
    export { React, compiler };
    export const ScrollContext = React.createContext(null);
    export const RowContext = React.createContext(null);
    export const ResizeContext = React.createContext(null);
    const __read_memoCacheHelper = () => compiler;
    const __read_reactHooks__unt_o6qq = () => React;
    const __read_reactClientInternals__ont_o6a9 = () => React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const __read_reactDefaultExports = () => React;
    const __read_reactMemoCache__QIr_2d89t = () => compiler;
    const __read_resizeObserverContext = () => ResizeContext;
    export const resizeObserverCallbacksKey = Symbol("reference.resize.callbacks");
    export const resizeObserverLastEntryKey = Symbol("reference.resize.last");
    ${functions("features/shared/use-latest-callback.ts", ["int", "useLatestCallback__gh_o6fc"])}
    ${functions("modules/auto-import-v12/react-exports-o-khw.js", ["cancelStableCallback"])}
    ${functions("shared/use-resize-observer.ts", ["useResizeObserver__zM_2d7fc"])}
    ${functions("modules/ui-islands-v17-composer-layout/handle-tab-drop-move.js", ["registerResizeObserverCallback", "removeResizeObserverCallback"])}
    ${functions("shared/create-reactive-store-00144.ts", ["extractElementSize"])}
    ${functions("editor/create-diff-scroll-adjuster-00148.ts", ["ph"])}
    ${functions(lazy + "async-to-generator.js", ["getScrollOffset", "setInvertedScrollPosition"])}
    export { useLatestCallback__gh_o6fc as useLatestCallback, useResizeObserver__zM_2d7fc as useResizeObserver, extractElementSize, ph, getScrollOffset, setInvertedScrollPosition };
  `,
  );
  modules.set(
    id("geometry"),
    `
    ${functions(lazy + "thread-virtualizer-D5BSbZuA.js", ["t", "n", "r", "i", "a", "o", "s"])}
    const c = 280;
    export { t as build, n as range, r as reconcileRange, i as compensate, a as target };
  `,
  );
  modules.set(
    id("list"),
    `
    import { React as X, compiler as Xe, ScrollContext, useLatestCallback as w, extractElementSize as ce, ph as m } from "${id("common")}";
    import * as Qe from "react/jsx-runtime";
    import * as Ze from "react-dom";
    import { build as Ee, range as Se, reconcileRange as xe, compensate as Ce, target as Te } from "${id("geometry")}";
    const be = () => X.useContext(ScrollContext), a = () => 1;
    const ne = (...values) => values.filter(Boolean).join(" ");
    const $e = 12, et = 800, tt = 2, nt = 10, rt = {};
    ${functions(lazy + "open-sources-side-panel-tab-CfgjOF5O.js", ["Ie", "Le", "Re", "ze", "Be", "Ve", "He", "Ue", "We", "Ge", "Ke", "qe", "Je", "Ye"])}
    const it = X.memo(Le);
    export { Ie as ReferenceVirtualizedTurns };
  `,
  );
  modules.set(
    id("layout"),
    `
    import { React as y, compiler as _e, ScrollContext, useLatestCallback as c, useResizeObserver as a, extractElementSize as ie, getScrollOffset as u, setInvertedScrollPosition as p } from "${id("common")}";
    import * as b from "react/jsx-runtime";
    import { motion as ne, useTransform as o } from "motion/react";
    const le = y.createContext(null), l = (...values) => values.filter(Boolean).join(" ");
    const ue = ScrollContext.Provider, se = { timelineScroll: {} }, ee = () => null, oe = "reference-content-width";
    const ve = 260, ye = 64, be = 8, xe = 1000, x = 16, Se = 1, S = 2;
    ${functions(lazy + "thread-scroll-layout-xQ2_L08y.js", ["v", "de", "fe", "pe", "me", "he", "ge"])}
    export { v as ReferenceScrollLayout };
  `,
  );
  modules.set(
    id("response"),
    `
    import { React as vO, compiler as gO, ScrollContext, RowContext, useLatestCallback as Y, getScrollOffset as Qs, ph as xi } from "${id("common")}";
    import * as yO from "react/jsx-runtime";
    import { motion as Iu, animate as Zi, useMotionValue as Kr } from "motion/react";
    import { ReferenceVirtualizedTurns as Um } from "${id("list")}";
    const TD = "viewport", ku = null, EO = null;
    const cache = new Map();
    const store = { get: (_, key) => cache.get(key), set: (_, key, value) => cache.set(key, value) };
    const jf = () => store, ce = () => 1, Jm = () => vO.useContext(ScrollContext);
    const X = () => null, _O = { default: (entries, predicate) => entries.findLast(predicate) };
    const lg = entry => entry.type === "turn", Al = entry => entry.type === "history-gap";
    const XD = props => { const Row = vO.useContext(RowContext); return yO.jsx(Row, props); };
    const bO = 2 / 3, xO = 240, SO = 1, CD = 300;
    const CO = Array.from({ length: 101 }, (_, index) => index / 100);
    const wO = { type: "spring", bounce: 0, duration: 0.5 }, TO = vO.createContext(null);
    ${functions(lazy + "local-conversation-thread-CShhuS2f.js", ["oO", "sO", "cO", "lO", "uO", "dO", "mO", "fO", "pO", "DD", "OD", "jD", "kD", "AD", "hO", "SD"])}
    export { oO as ReferenceResponse, SD as referencePlacementSnapshot };
  `,
  );
  return { modules, fingerprints };
}
