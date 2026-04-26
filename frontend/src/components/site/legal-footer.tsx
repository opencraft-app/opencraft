import { BEIAN_URL, ICP_LICENSE } from "@/constants/legal";

export const LegalFooter = () => {
  const currentYear = new Date().getFullYear();

  return (
    <footer
      className="border-t border-[var(--lw-border)]"
      style={{ backgroundColor: "var(--lw-bg)" }}
    >
      <div
        className="mx-auto flex flex-col items-center gap-4 px-4 py-6 sm:flex-row sm:justify-between sm:px-6 sm:py-5"
        style={{ maxWidth: "var(--lw-max-content)" }}
      >
        {/* 左侧：版权 + 备案号 */}
        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          © {currentYear} LightVela. All rights reserved.{" "}
          <a
            href={BEIAN_URL}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
            style={{ color: "var(--text-tertiary)" }}
          >
            {ICP_LICENSE}
          </a>
        </p>

        {/* 右侧：法律链接 */}
        <div className="flex items-center gap-4">
          <a
            href="https://cloud.tencent.com/document/product/301/11470"
            target="_blank"
            rel="noreferrer"
            className="text-xs transition-colors duration-200 hover:underline"
            style={{ color: "var(--text-tertiary)" }}
          >
            隐私政策
          </a>
          <span style={{ color: "var(--lw-border)" }}>·</span>
          <a
            href="https://cloud.tencent.com/document/product/301/48034"
            target="_blank"
            rel="noreferrer"
            className="text-xs transition-colors duration-200 hover:underline"
            style={{ color: "var(--text-tertiary)" }}
          >
            服务条款
          </a>
        </div>
      </div>
    </footer>
  );
};
