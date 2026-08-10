import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function runtimeUiFiles(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const path = join(directory, entry);
      return statSync(path).isDirectory() ? runtimeUiFiles(path) : [path];
    })
    .filter((path) => /\.(?:ts|tsx)$/.test(path))
    .filter(
      (path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"),
    );
}

describe("Vela style lint", () => {
  it("keeps every runtime UI file behind the semantic token boundary", () => {
    const runtimeFiles = runtimeUiFiles(join(process.cwd(), "src", "ui"))
      .filter((path) => !path.endsWith("tokens.ts"));
    const forbiddenPatterns = [
      /#[0-9a-f]{3,8}/iu,
      /rgba?\(/u,
      /theme\.colors\./u,
      /theme\.fonts\./u,
      /theme\.radii\./u,
      /(?:theme|velaTheme)\.sizes\./u,
      /semantic\.color\.(?:contentSurface|divider)\b/u,
      /"transparent"/u,
      /theme\.sizes\.(?:header|managementHeader)\b/u,
      /borderRadius\s*:\s*[\d_]+/u,
      /(?:border(?:Top|Right|Bottom|Left)?Width)\s*:\s*[1-9][\d_]*\b/u,
      /\bborder\s*:\s*`?1px\b/u,
      /opacity\s*:\s*0\.[0-9]+\b/u,
      /(?:fontFamily|fontSize|fontWeight|letterSpacing|lineHeight)\s*:/u,
      /(?:color\s*:\s*|color=\{)(?:theme|velaTheme)\.semantic\.color\.(?:contentSurface|navigationSurface|selectionSurface)/u,
      /backgroundColor\s*:\s*(?:theme|velaTheme)\.semantic\.color\.(?:textPrimary|textMuted|textInverse|iconPrimary|iconSecondary|iconMuted)/u,
      /\bsize=\{[^}\n]*\b\d+(?:\.\d+)?\b[^}\n]*\}/u,
      /\bstrokeWidth=\{[^}\n]*\b\d+(?:\.\d+)?\b[^}\n]*\}/u,
      /\bzIndex\s*:\s*[\d_]+/u,
      /shadowOpacity\s*:\s*(?:theme|velaTheme)\.semantic\.elevation\.(?:docked|pane|section)/u,
      /shadows\.(?:soft|surface)\b/u,
      /(?:gap|rowGap|columnGap|margin(?:Top|Right|Bottom|Left|Horizontal|Vertical)?|padding(?:Top|Right|Bottom|Left|Horizontal|Vertical)?)\s*:\s*[1-9][\d_]*(?:\.\d+)?\b/u,
      /resolvedViewportWidth\s*[<>]=?\s*[\d_]+/u,
      /\bwidth\s*[<>]=?\s*[\d_]+/u,
      /const\s+[A-Za-z0-9_]*Breakpoint[A-Za-z0-9_]*\s*=\s*[\d_]+/u,
    ];
    const offenders = runtimeFiles.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return forbiddenPatterns.some((pattern) => pattern.test(source))
        ? [path.replace(`${process.cwd()}/`, "")]
        : [];
    });

    expect(offenders).toEqual([]);
  });

  it("uses icon semantics instead of brand colors for rendered glyphs", () => {
    const offenders = runtimeUiFiles(join(process.cwd(), "src", "ui"))
      .filter((path) => !path.endsWith("tokens.ts"))
      .filter((path) =>
        /color=\{[\s\S]{0,320}?(?:theme|velaTheme)\.semantic\.color\.brandAccent(?:Strong)?/u.test(
          readFileSync(path, "utf8"),
        ),
      )
      .map((path) => path.replace(`${process.cwd()}/src/ui/`, ""));

    expect(offenders).toEqual([]);
  });

  it("reserves brand colors for identity marks and the visual reference lab", () => {
    const offenders = runtimeUiFiles(join(process.cwd(), "src", "ui"))
      .filter((path) => !path.endsWith("tokens.ts"))
      .filter((path) => !path.endsWith("brand-mark.tsx"))
      .filter((path) => !path.endsWith("style-lab-screen.tsx"))
      .filter((path) => /semantic\.color\.brandAccent(?:Strong)?\b/u.test(readFileSync(path, "utf8")))
      .map((path) => path.replace(`${process.cwd()}/src/ui/`, ""));

    expect(offenders).toEqual([]);
  });

  it("keeps repeated management geometry in the management recipe", () => {
    const managementScreens = [
      "agents-screen.tsx",
      "computers-screen.tsx",
      "members-screen.tsx",
      "tasks-screen.tsx",
    ];
    const duplicatedGeometry = [
      /maxWidth\s*:\s*(?:900|960)\b/u,
      /maxHeight\s*:\s*232\b/u,
      /(?:height|width)\s*:\s*(?:40|48|56|64)\b/u,
      /minWidth\s*:\s*240\b/u,
      /mobileSwitcherButton\s*:\s*\{[\s\S]*?minHeight\s*:\s*64\b/u,
      /mobileSwitcherOption\s*:\s*\{[\s\S]*?minHeight\s*:\s*56\b/u,
    ];
    const offenders = managementScreens.flatMap((relativePath) => {
      const source = readFileSync(
        join(process.cwd(), "src", "ui", "screens", relativePath),
        "utf8",
      );
      return duplicatedGeometry.some((pattern) => pattern.test(source))
        ? [relativePath]
        : [];
    });

    expect(offenders).toEqual([]);
  });

  it("reserves pill radius for status, tags and segmented choices", () => {
    const ordinaryActionStyles: Array<[string, string[]]> = [
      [
        "layouts/workspace-shell.tsx",
        [
          "channelMemberAdd",
          "channelMemberConfirmCancel",
          "channelMemberConfirmSubmit",
          "channelMemberRemove",
          "reconnectButton",
          "searchMore",
          "searchSubmit",
        ],
      ],
      ["components/clearable-search-field.tsx", ["clear", "field"]],
      ["components/message-composer.tsx", ["mentionButton", "sendButton"]],
      ["components/message-list.tsx", ["loadOlderButton", "retryButton"]],
      ["components/route-status-screen.tsx", ["action"]],
      ["components/terminal-panel.tsx", ["button", "sendButton"]],
      ["components/terminal-panel.web.tsx", ["button"]],
      ["screens/first-workspace-screen.tsx", ["primaryButton"]],
      [
        "screens/style-lab-screen.tsx",
        ["canvasButton", "previewButton", "scenarioButton"],
      ],
    ];
    const offenders = ordinaryActionStyles.flatMap(([relativePath, names]) => {
      const source = readFileSync(
        join(process.cwd(), "src", "ui", relativePath),
        "utf8",
      );
      return names.flatMap((name) => {
        const block = source.match(
          new RegExp(`\\n  ${name}: \\{([\\s\\S]*?)\\n  \\},`),
        )?.[1];
        return block?.includes("semantic.radius.pill")
          ? [`${relativePath}:${name}`]
          : [];
      });
    });

    expect(offenders).toEqual([]);
  });

  it("allows shadows only on overlays, floating controls and account cards", () => {
    const shadowStyles = runtimeUiFiles(join(process.cwd(), "src", "ui"))
      .filter((path) => !path.endsWith("tokens.ts"))
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return Array.from(
          source.matchAll(/\n  ([A-Za-z0-9_]+): \{([\s\S]*?)\n  \},/gu),
        ).flatMap((match) =>
          /shadow(?:Color|Offset|Opacity|Radius)\s*:/u.test(match[2] ?? "")
            ? [
                `${path.replace(`${process.cwd()}/src/ui/`, "")}:${match[1] ?? "unknown"}`,
              ]
            : [],
        );
      })
      .sort();

    expect(shadowStyles).toEqual([
      "components/message-list.tsx:actionRowOpen",
      "components/message-viewport/message-viewport.tsx:newMessages",
      "layouts/app-frame.tsx:accountPopover",
      "layouts/app-frame.tsx:railTooltip",
      "layouts/workspace-shell.styles.ts:channelMemberConfirmDialog",
    ]);
  });

  it("does not bypass the HeroUI palette with stale literal colors", () => {
    const staleColors = [
      "#0088F8",
      "#006FCE",
      "#FF3B45",
      "#18B76A",
      "#7C3AED",
      "#ECECEE",
      "#6B6B73",
      "#285dff",
      "#172033",
      "#dfe3ec",
      "#765fed",
      "#f7f8fc",
      "#1C2740",
      "#eaf0ff",
      "#bfd0ff",
      "0, 136, 248",
    ];
    const offenders = runtimeUiFiles(join(process.cwd(), "src", "ui"))
      .filter((path) =>
        staleColors.some((color) => readFileSync(path, "utf8").includes(color)),
      )
      .map((path) => path.replace(`${process.cwd()}/`, ""));

    expect(offenders).toEqual([]);
  });

  it("keeps interaction timing, press feedback and hit targets in semantic tokens", () => {
    const forbiddenPatterns = [
      /delayLongPress=\{\d+\}/u,
      /hitSlop=\{\d+\}/u,
      /transform\s*:\s*\[\{\s*scale:\s*0\.[0-9]+\s*\}\]/u,
    ];
    const offenders = runtimeUiFiles(join(process.cwd(), "src", "ui"))
      .filter((path) => !path.endsWith("tokens.ts"))
      .filter((path) => !path.endsWith("style-lab-screen.tsx"))
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return forbiddenPatterns.some((pattern) => pattern.test(source));
      })
      .map((path) => path.replace(`${process.cwd()}/src/ui/`, ""));

    expect(offenders).toEqual([]);
  });

  /**
   * Spacing is a scale and has to stay on the scale. One-off geometry
   * (a panel width, an icon box, a viewport offset) is deliberately *not*
   * covered: forcing it into `recipes` is what turned that namespace into a
   * dictionary of named magic numbers. Component-local dimensions belong in
   * the component; `theme-contract` caps how far `recipes` may still grow.
   */
  it("keeps spacing literals out of production styles", () => {
    const spacingPattern = /\b(?:gap|rowGap|columnGap|margin(?:Bottom|Horizontal|Left|Right|Top|Vertical)?|padding(?:Bottom|Horizontal|Left|Right|Top|Vertical)?)\s*:\s*[1-9][\d_]*(?:\.\d+)?\b/gu;
    const offenders = runtimeUiFiles(join(process.cwd(), "src", "ui"))
      .filter((path) => !path.endsWith("tokens.ts"))
      .filter((path) => !path.endsWith("style-lab-screen.tsx"))
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return Array.from(source.matchAll(spacingPattern)).map(
          (match) =>
            `${path.replace(`${process.cwd()}/src/ui/`, "")}:${match[0]}`,
        );
      });

    expect(offenders).toEqual([]);
  });

  it("does not retain the retired duplicate message presentation in WorkspaceShell", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "ui", "layouts", "workspace-shell.tsx"),
      "utf8",
    );
    const retiredStyles = [
      "attachmentBlock",
      "deliveryStatus",
      "emptyConversation",
      "loadOlderButton",
      "messageAvatar",
      "messageBody",
      "messageQuote",
      "messageScroller",
      "messageText",
      "messages",
      "retryButton",
    ];
    const offenders = retiredStyles.filter((styleName) =>
      new RegExp(`\\n  ${styleName}: \\{`, "u").test(source),
    );

    expect(offenders).toEqual([]);
  });
});
