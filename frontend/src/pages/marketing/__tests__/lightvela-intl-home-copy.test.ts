import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const compareFooterCopies = [
  {
    file: "index-fragment.html",
    labels: [
      "Compare",
      "Compare with self-hosting",
      "Compare with Hostinger",
      "Compare with Manus",
      "Compare with ChatGPT",
      "Compare with Genspark",
    ],
  },
  {
    file: "index-fragment.en-US.html",
    labels: [
      "Compare",
      "Compare with self-hosting",
      "Compare with Hostinger",
      "Compare with Manus",
      "Compare with ChatGPT",
      "Compare with Genspark",
    ],
  },
  {
    file: "index-fragment.es.html",
    labels: [
      "Comparar",
      "Comparar con el alojamiento propio",
      "Comparar con Hostinger",
      "Comparar con Manus",
      "Comparar con ChatGPT",
      "Comparar con Genspark",
    ],
  },
  {
    file: "index-fragment.id-ID.html",
    labels: [
      "Perbandingan",
      "Bandingkan dengan self-hosting",
      "Bandingkan dengan Hostinger",
      "Bandingkan dengan Manus",
      "Bandingkan dengan ChatGPT",
      "Bandingkan dengan Genspark",
    ],
  },
  {
    file: "index-fragment.ja-JP.html",
    labels: [
      "比較",
      "ローカル展開との比較",
      "Hostingerと比較して",
      "Manusと比較",
      "ChatGPT と比較して",
      "Gensparkと比較して",
    ],
  },
  {
    file: "index-fragment.ko-KR.html",
    labels: [
      "비교",
      "셀프 호스팅과 비교",
      "Hostinger와 비교",
      "Manus와 비교",
      "ChatGPT와 비교",
      "젠스파크와 비교",
    ],
  },
  {
    file: "index-fragment.zh-CN.html",
    labels: [
      "对比",
      "与本地部署对比",
      "与 Manus 对比",
      "与 AI Chatbot 对比",
    ],
  },
  {
    file: "index-fragment.zh-SG.html",
    labels: [
      "对比",
      "与本地部署对比",
      "与 Hostinger 对比",
      "与 Manus 对比",
      "与 ChatGPT 对比",
      "与 Genspark 对比",
    ],
  },
  {
    file: "index-fragment.zh-Hant.html",
    labels: [
      "對比",
      "與本地部署對比",
      "與 Hostinger 對比",
      "與 Manus 對比",
      "與 ChatGPT 對比",
      "與 Genspark 對比",
    ],
  },
] as const;

const soulStripMemoryCopies = [
  {
    file: "index-fragment.html",
    memoryTitle: "Memory",
    memoryDescription: "Project facts, agreements, and lessons.",
    userTitle: "User Profile",
    userDescription: "Preferences, habits, and communication style.",
  },
  {
    file: "index-fragment.en-US.html",
    memoryTitle: "Memory",
    memoryDescription: "Project facts, agreements, and lessons.",
    userTitle: "User Profile",
    userDescription: "Preferences, habits, and communication style.",
  },
  {
    file: "index-fragment.es.html",
    memoryTitle: "Memoria",
    memoryDescription: "Hechos, acuerdos y aprendizajes del proyecto.",
    userTitle: "Perfil de usuario",
    userDescription: "Preferencias, hábitos y estilo de comunicación.",
  },
  {
    file: "index-fragment.id-ID.html",
    memoryTitle: "Memori",
    memoryDescription: "Fakta proyek, kesepakatan, dan pelajaran.",
    userTitle: "Profil Pengguna",
    userDescription: "Preferensi, kebiasaan, dan gaya komunikasi.",
  },
  {
    file: "index-fragment.ja-JP.html",
    memoryTitle: "記憶",
    memoryDescription: "プロジェクト事実、約束、学び。",
    userTitle: "ユーザープロフィール",
    userDescription: "好み、利用習慣、話し方。",
  },
  {
    file: "index-fragment.ko-KR.html",
    memoryTitle: "기억",
    memoryDescription: "프로젝트 사실, 약속, 배운 점.",
    userTitle: "사용자 프로필",
    userDescription: "선호, 사용 습관, 소통 방식.",
  },
  {
    file: "index-fragment.zh-CN.html",
    memoryTitle: "记忆",
    memoryDescription: "项目事实、工作约定和经验教训。",
    userTitle: "用户画像",
    userDescription: "偏好、使用习惯和沟通方式。",
  },
  {
    file: "index-fragment.zh-SG.html",
    memoryTitle: "记忆",
    memoryDescription: "项目事实、工作约定和经验教训。",
    userTitle: "用户画像",
    userDescription: "偏好、使用习惯和沟通方式。",
  },
  {
    file: "index-fragment.zh-Hant.html",
    memoryTitle: "記憶",
    memoryDescription: "專案事實、工作約定和經驗教訓。",
    userTitle: "使用者畫像",
    userDescription: "偏好、使用習慣和溝通方式。",
  },
] as const;

describe("LightVela international home copy", () => {
  it("uses the localized receipt image for Simplified Chinese while keeping English receipts unchanged", () => {
    const zhFragment = readFileSync(
      join(process.cwd(), "public/lightvela-intl-home/index-fragment.zh-CN.html"),
      "utf8",
    );
    const enFragment = readFileSync(
      join(process.cwd(), "public/lightvela-intl-home/index-fragment.en-US.html"),
      "utf8",
    );

    expect(zhFragment).toContain("/lightvela-intl-home/assets/mock-grocery-receipt-zh-cn.webp");
    expect(zhFragment).not.toContain("/lightvela-intl-home/assets/mock-grocery-receipt.webp\" alt=\"购物收据\"");
    expect(enFragment).toContain("/lightvela-intl-home/assets/mock-grocery-receipt.webp");
    expect(enFragment).not.toContain("mock-grocery-receipt-zh-cn");
  });

  it.each(compareFooterCopies)("$file uses Compare copy in the footer compare column", ({ file, labels }) => {
    const fragment = readFileSync(
      join(process.cwd(), "public/lightvela-intl-home", file),
      "utf8",
    );

    for (const label of labels) {
      expect(fragment).toContain(`>${label}<`);
    }
  });

  it.each(soulStripMemoryCopies)(
    "$file rotates the Skill/Soul strip to the matching Memory/User format",
    ({ file, memoryTitle, memoryDescription, userTitle, userDescription }) => {
      const fragment = readFileSync(
        join(process.cwd(), "public/lightvela-intl-home", file),
        "utf8",
      );
      const document = new DOMParser().parseFromString(fragment, "text/html");
      const primaryCaps = Array.from(
        document.querySelectorAll<HTMLElement>(".soul-strip__half > .soul-strip__cap:not(.soul-strip__cap--secondary)"),
      );
      const secondaryStates = Array.from(document.querySelectorAll<HTMLElement>(".soul-strip__state--secondary"));
      const secondaryIconGroups = Array.from(document.querySelectorAll<HTMLElement>(".soul-strip__icons--secondary"));

      expect(fragment).toContain("soul-strip__state--secondary");
      expect(primaryCaps).toHaveLength(2);
      expect(primaryCaps[0]?.className).toBe("soul-strip__cap");
      expect(primaryCaps[0]?.children[0]?.classList.contains("soul-strip__icons")).toBe(true);
      expect(primaryCaps[0]?.children[1]?.textContent).toBe("Skill");
      expect(primaryCaps[0]?.children[2]?.tagName).toBe("I");
      expect(primaryCaps[0]?.children[3]?.tagName).toBe("B");
      expect(primaryCaps[0]?.querySelector(".soul-strip__copy")).toBeNull();
      expect(primaryCaps[0]?.querySelector(".soul-strip__state")).toBeNull();
      expect(primaryCaps[1]?.className).toBe("soul-strip__cap");
      expect(primaryCaps[1]?.children[0]?.textContent).toBe("Soul");
      expect(primaryCaps[1]?.children[1]?.tagName).toBe("I");
      expect(primaryCaps[1]?.children[2]?.tagName).toBe("B");
      expect(primaryCaps[1]?.children[3]?.classList.contains("soul-strip__icons--soul")).toBe(true);
      expect(primaryCaps[1]?.querySelector("img")?.getAttribute("decoding")).toBe("async");
      expect(primaryCaps[1]?.querySelector(".soul-strip__copy")).toBeNull();
      expect(primaryCaps[1]?.querySelector(".soul-strip__state")).toBeNull();
      expect(secondaryIconGroups).toHaveLength(2);
      expect(secondaryIconGroups[0]?.querySelector(".soul-strip__more")?.textContent).toMatch(/^(?:\.{3}|···)$/);
      expect(secondaryIconGroups[1]?.querySelector(".soul-strip__more")?.textContent).toMatch(/^(?:\.{3}|···)$/);
      expect(Array.from(secondaryIconGroups[0]?.querySelectorAll("use") ?? []).map((icon) => icon.getAttribute("href"))).toEqual([
        "#i-archive",
        "#i-book",
        "#i-clock",
      ]);
      expect(Array.from(secondaryIconGroups[1]?.querySelectorAll("use") ?? []).map((icon) => icon.getAttribute("href"))).toEqual([
        "#i-user",
        "#i-heart",
        "#i-settings",
      ]);
      expect(secondaryStates).toHaveLength(2);
      expect(secondaryStates[0]?.querySelector(".soul-strip__label")?.textContent).toBe(memoryTitle);
      expect(secondaryStates[0]?.querySelector("b")?.textContent).toBe(memoryDescription);
      expect(secondaryStates[0]?.getAttribute("aria-label")).toBe(`${memoryTitle}：${memoryDescription}`);
      expect(secondaryStates[0]?.getAttribute("title")).toBe(`${memoryTitle}：${memoryDescription}`);
      expect(secondaryStates[1]?.querySelector(".soul-strip__label")?.textContent).toBe(userTitle);
      expect(secondaryStates[1]?.querySelector("b")?.textContent).toBe(userDescription);
      expect(secondaryStates[1]?.getAttribute("aria-label")).toBe(`${userTitle}：${userDescription}`);
      expect(secondaryStates[1]?.getAttribute("title")).toBe(`${userTitle}：${userDescription}`);
    },
  );
});
