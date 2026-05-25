import { ShieldAlert } from "lucide-react";
import { useSession } from "@/contexts/session-context";
import { useT } from "@/i18n/t";

export function ImpersonationBanner() {
  const { session } = useSession();
  const t = useT();

  if (session.stage !== "authenticated" || !session.impersonated) {
    return null;
  }

  return (
    <div className="sticky top-0 z-[80] border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950 shadow-sm">
      <div className="mx-auto flex max-w-7xl items-center gap-2">
        <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="font-medium">
          {t("运营代登中")}
          <span className="ml-2 font-normal">
            {t("当前页面使用运营代登会话，操作将以目标用户身份执行。")}
          </span>
        </p>
      </div>
    </div>
  );
}
