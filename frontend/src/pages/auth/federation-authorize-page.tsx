import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AuthDialogFrame } from "@/components/site/auth-dialog-frame";
import { LoginModal } from "@/components/site/login-modal";
import { ProductPageShell } from "@/components/site/product-chrome";
import { Button } from "@/components/ui/button";
import { useRepositories } from "@/contexts/repository-context";
import { useSession } from "@/contexts/session-context";
import { useT } from "@/i18n/t";
import { avatarImageUrl } from "@/lib/avatar-image";
import type {
  FederationAuthorizationContext,
  FederationAuthorizationInput,
} from "@/repositories/types";

interface FederationAuthorizePageProps {
  navigate?: (url: string) => void;
}

const readAuthorizationInput = (): FederationAuthorizationInput | null => {
  const query = new URLSearchParams(window.location.search);
  const clientId = query.get("client_id")?.trim() ?? "";
  const redirectUri = query.get("redirect_uri")?.trim() ?? "";
  if (!clientId || !redirectUri) return null;
  return {
    clientId,
    redirectUri,
    state: query.get("state") ?? "",
  };
};

const buildCancellationUrl = (context: FederationAuthorizationContext) => {
  const target = new URL(context.redirectUri);
  target.searchParams.set("error", "access_denied");
  if (context.state) {
    target.searchParams.set("state", context.state);
  }
  return target.toString();
};

export function FederationAuthorizePage({
  navigate = (url) => window.location.assign(url),
}: FederationAuthorizePageProps) {
  const repositories = useRepositories();
  const { authReady } = useSession();
  const t = useT();
  const [input, setInput] = useState<FederationAuthorizationInput | null>();
  const [context, setContext] = useState<FederationAuthorizationContext | null>(null);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [loadingContext, setLoadingContext] = useState(true);
  const [issuingTicket, setIssuingTicket] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInput(readAuthorizationInput());
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (input === undefined) {
      return () => {
        cancelled = true;
      };
    }
    if (!input) {
      setError(t("无法验证授权请求，请返回来源网站重试。"));
      setLoadingContext(false);
      return () => {
        cancelled = true;
      };
    }

    repositories.auth.getFederationAuthorizationContext(input).then((result) => {
      if (!cancelled) setContext(result);
    }).catch(() => {
      if (!cancelled) {
        setError(t("无法验证授权请求，请返回来源网站重试。"));
      }
    }).finally(() => {
      if (!cancelled) setLoadingContext(false);
    });

    return () => {
      cancelled = true;
    };
  }, [input, repositories.auth, t]);

  const cancelAuthorization = useCallback(async () => {
    if (!context) return;
    if (switchingAccount) {
      try {
        await repositories.auth.cancelFederationSwitch();
      } catch {
        // The server-side marker is short-lived; cancellation must still return
        // the browser to the validated relying-party callback.
      }
    }
    navigate(buildCancellationUrl(context));
  }, [context, navigate, repositories.auth, switchingAccount]);

  const enterSwitchMode = async () => {
    setError(null);
    try {
      await repositories.auth.prepareFederationSwitch();
      setSwitchingAccount(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("切换账号失败，请稍后重试。"));
    }
  };

  const returnToCurrentAccount = async () => {
    try {
      await repositories.auth.cancelFederationSwitch();
      setSwitchingAccount(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("切换账号失败，请稍后重试。"));
    }
  };

  const continueAuthorization = async () => {
    if (!context || issuingTicket) return;
    setIssuingTicket(true);
    setError(null);
    try {
      const result = await repositories.auth.issueFederationTicket({
        clientId: context.clientId,
        redirectUri: context.redirectUri,
        state: context.state,
      });
      navigate(result.redirectUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("授权失败，请稍后重试。"));
    } finally {
      setIssuingTicket(false);
    }
  };

  const handleLoginSuccess = useCallback(async () => {
    if (!input) return;
    try {
      const refreshedContext = await repositories.auth.getFederationAuthorizationContext(input);
      setContext(refreshedContext);
      setSwitchingAccount(false);
    } catch {
      setError(t("无法验证授权请求，请返回来源网站重试。"));
    }
  }, [input, repositories.auth, t]);

  const authenticatedUser = context?.currentSession?.user ?? null;
  const showLogin = Boolean(context && authReady && !authenticatedUser);
  const showConfirmation = Boolean(context && authReady && authenticatedUser && !switchingAccount);
  const avatarSrc = avatarImageUrl(authenticatedUser?.avatarUrl ?? null);
  const accountDetail = authenticatedUser?.email ?? authenticatedUser?.phone ?? null;
  const destinationHost = context ? new URL(context.redirectUri).hostname : "";

  return (
    <ProductPageShell>
      <main className="flex min-h-[calc(100vh-7rem)] flex-1 items-center justify-center px-4 py-24">
        {(loadingContext || !authReady) && !error ? (
          <Loader2 className="h-6 w-6 animate-spin text-[var(--text-tertiary)]" aria-label={t("正在加载")} />
        ) : null}
        {error && !context ? (
          <div className="max-w-md text-center">
            <p className="text-sm text-[var(--text-secondary)]">{error}</p>
          </div>
        ) : null}
      </main>

      <LoginModal
        open={showLogin || switchingAccount}
        mode={switchingAccount ? "switch-account" : "login"}
        closeOnSuccess={false}
        onClose={() => void cancelAuthorization()}
        onSuccess={() => void handleLoginSuccess()}
        onReturnToCurrentAccount={switchingAccount ? () => void returnToCurrentAccount() : undefined}
      />

      <AuthDialogFrame
        open={showConfirmation}
        onClose={() => void cancelAuthorization()}
        ariaLabel={t("确认授权登录")}
      >
        <div className="flex flex-col items-center px-9 pb-8 pt-10 text-center">
          <h1 className="text-[28px] font-medium leading-none text-black/90">
            {t("继续访问")} {context?.clientDisplayName}
          </h1>
          <p className="mt-4 text-sm text-black/50">{destinationHost}</p>

          {authenticatedUser ? (
            <div className="mt-7 flex w-full items-center gap-3 rounded-xl border border-black/[0.06] bg-black/[0.018] px-4 py-3 text-left">
              <img
                src={avatarSrc}
                alt={authenticatedUser.name}
                className="h-12 w-12 shrink-0 rounded-full border border-black/[0.06] object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-black/90">{authenticatedUser.name}</p>
                {accountDetail ? (
                  <p className="mt-1 truncate text-xs text-black/45">{accountDetail}</p>
                ) : null}
              </div>
            </div>
          ) : null}

          {error ? <p className="mt-4 text-xs font-medium text-[var(--danger)]">{error}</p> : null}

          <div className="mt-7 flex w-full flex-col gap-3">
            <Button type="button" className="h-12 w-full" onClick={() => void continueAuthorization()} disabled={issuingTicket}>
              {issuingTicket ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {t("继续")}
            </Button>
            <Button type="button" className="w-full" variant="ghost" onClick={() => void enterSwitchMode()}>
              {t("切换其他账号")}
            </Button>
          </div>
        </div>
      </AuthDialogFrame>
    </ProductPageShell>
  );
}
