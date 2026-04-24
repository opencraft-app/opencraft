import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type PropsWithChildren,
} from "react";
import type { AuthSessionSnapshot, CurrentSubscription, InviteCodeValidation, PlanTier, User } from "@/domain/types";
import { useRepositories } from "@/contexts/repository-context";
import { AUTH_UNAUTHORIZED_EVENT } from "@/repositories/http-repositories";

type AuthStage = "anonymous" | "authenticated";

interface LocalSessionState {
  firstBotId: string | null;
  inviteValidation: InviteCodeValidation | null;
  verificationCooldownUntil: number | null;
}

interface SessionState extends LocalSessionState {
  authReady: boolean;
  stage: AuthStage;
  user: User | null;
  currentSubscription: CurrentSubscription | null;
}

type SessionAction =
  | { type: "SET_AUTH_STATE"; payload: AuthSessionSnapshot | null }
  | { type: "SET_AUTH_READY" }
  | { type: "SET_USER"; payload: User }
  | { type: "SET_INVITE_VALIDATION"; payload: InviteCodeValidation | null }
  | { type: "SET_CURRENT_SUBSCRIPTION"; payload: CurrentSubscription | null }
  | { type: "SET_FIRST_BOT"; payload: string | null }
  | { type: "SET_CODE_COOLDOWN"; payload: number | null }
  | { type: "SIGN_OUT" };

const UI_SESSION_STORAGE_KEY = "lightclaw-ui-session-v1";

const defaultLocalSessionState: LocalSessionState = {
  firstBotId: null,
  inviteValidation: null,
  verificationCooldownUntil: null,
};

const defaultSessionState: SessionState = {
  authReady: false,
  stage: "anonymous",
  user: null,
  currentSubscription: null,
  ...defaultLocalSessionState,
};

const sessionReducer = (state: SessionState, action: SessionAction): SessionState => {
  switch (action.type) {
    case "SET_AUTH_STATE":
      return {
        ...state,
        authReady: true,
        stage: action.payload ? "authenticated" : "anonymous",
        user: action.payload?.user ?? null,
        currentSubscription: action.payload?.currentSubscription ?? null,
      };
    case "SET_AUTH_READY":
      return {
        ...state,
        authReady: true,
      };
    case "SET_USER":
      return {
        ...state,
        user: action.payload,
      };
    case "SET_INVITE_VALIDATION":
      return {
        ...state,
        inviteValidation: action.payload,
      };
    case "SET_CURRENT_SUBSCRIPTION":
      return {
        ...state,
        currentSubscription: action.payload,
      };
    case "SET_FIRST_BOT":
      return {
        ...state,
        firstBotId: action.payload,
      };
    case "SET_CODE_COOLDOWN":
      return {
        ...state,
        verificationCooldownUntil: action.payload,
      };
    case "SIGN_OUT":
      return {
        ...defaultSessionState,
        authReady: true,
      };
    default:
      return state;
  }
};

const parseStoredLocalSession = (): LocalSessionState => {
  try {
    const raw = localStorage.getItem(UI_SESSION_STORAGE_KEY);
    if (!raw) {
      return defaultLocalSessionState;
    }

    const parsed = JSON.parse(raw) as Partial<LocalSessionState>;
    return {
      ...defaultLocalSessionState,
      ...parsed,
    };
  } catch {
    return defaultLocalSessionState;
  }
};

const buildInitialSessionState = (): SessionState => ({
  ...defaultSessionState,
  ...parseStoredLocalSession(),
});

interface SessionContextValue {
  session: SessionState;
  authReady: boolean;
  isAuthenticated: boolean;
  planConfirmed: boolean;
  signInWithCode: (input: { phone: string; code: string; inviteCode?: string }) => Promise<void>;
  signInAsGuest: () => Promise<void>;
  sendVerificationCode: (phone: string) => Promise<void>;
  signUpWithCode: (input: {
    name: string;
    phone: string;
    code: string;
    inviteCode?: string;
  }) => Promise<void>;
  validateInviteCode: (code: string) => Promise<InviteCodeValidation>;
  selectPlan: (tier: PlanTier) => Promise<void>;
  updateProfile: (input: { name: string }) => Promise<void>;
  uploadAvatar: (file: File) => Promise<void>;
  deleteAccount: () => Promise<void>;
  setFirstBotId: (botId: string | null) => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export const SessionProvider = ({ children }: PropsWithChildren) => {
  const repositories = useRepositories();
  const [session, dispatch] = useReducer(sessionReducer, undefined, buildInitialSessionState);
  const authRequestVersion = useRef(0);

  useEffect(() => {
    localStorage.setItem(
      UI_SESSION_STORAGE_KEY,
      JSON.stringify({
        firstBotId: session.firstBotId,
        inviteValidation: session.inviteValidation,
        verificationCooldownUntil: session.verificationCooldownUntil,
      } satisfies LocalSessionState),
    );
  }, [session.firstBotId, session.inviteValidation, session.verificationCooldownUntil]);

  useEffect(() => {
    let cancelled = false;
    const requestVersion = ++authRequestVersion.current;

    const hydrateSession = async () => {
      try {
        const currentSession = await repositories.auth.getSession();
        if (!cancelled && requestVersion === authRequestVersion.current) {
          dispatch({ type: "SET_AUTH_STATE", payload: currentSession });
        }
      } catch (error) {
        console.error("Failed to hydrate auth session", error);
        if (!cancelled && requestVersion === authRequestVersion.current) {
          dispatch({ type: "SET_AUTH_STATE", payload: null });
        }
      }
    };

    void hydrateSession();

    return () => {
      cancelled = true;
    };
  }, [repositories.auth]);

  useEffect(() => {
    const handleUnauthorized = () => {
      authRequestVersion.current += 1;
      dispatch({ type: "SIGN_OUT" });
      localStorage.removeItem(UI_SESSION_STORAGE_KEY);
    };

    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => {
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
    };
  }, []);

  const signInWithCode = useCallback<SessionContextValue["signInWithCode"]>(
    async (input) => {
      authRequestVersion.current += 1;
      try {
        const authSession = await repositories.auth.signInWithCode(input);
        dispatch({ type: "SET_AUTH_STATE", payload: authSession });
      } catch (error) {
        dispatch({ type: "SET_AUTH_READY" });
        throw error;
      }
    },
    [repositories.auth],
  );

  const signInAsGuest = useCallback<SessionContextValue["signInAsGuest"]>(
    async () => {
      authRequestVersion.current += 1;
      try {
        const authSession = await repositories.auth.signInAsGuest();
        dispatch({ type: "SET_AUTH_STATE", payload: authSession });
      } catch (error) {
        dispatch({ type: "SET_AUTH_READY" });
        throw error;
      }
    },
    [repositories.auth],
  );

  const sendVerificationCode = useCallback<SessionContextValue["sendVerificationCode"]>(
    async (phone) => {
      const result = await repositories.auth.sendVerificationCode({ phone });
      dispatch({ type: "SET_CODE_COOLDOWN", payload: Date.now() + result.cooldownSeconds * 1000 });
    },
    [repositories.auth],
  );

  const signUpWithCode = useCallback<SessionContextValue["signUpWithCode"]>(
    async (input) => {
      authRequestVersion.current += 1;
      try {
        const authSession = await repositories.auth.signUpWithCode(input);
        dispatch({ type: "SET_AUTH_STATE", payload: authSession });
        dispatch({ type: "SET_INVITE_VALIDATION", payload: null });
        dispatch({ type: "SET_FIRST_BOT", payload: null });
      } catch (error) {
        dispatch({ type: "SET_AUTH_READY" });
        throw error;
      }
    },
    [repositories.auth],
  );

  const validateInviteCode = useCallback<SessionContextValue["validateInviteCode"]>(
    async (code) => {
      const result = await repositories.auth.validateInviteCode(code);
      dispatch({ type: "SET_INVITE_VALIDATION", payload: result });
      return result;
    },
    [repositories.auth],
  );

  const selectPlan = useCallback<SessionContextValue["selectPlan"]>(async (tier) => {
    const currentSubscription = await repositories.plans.updateSubscription(tier);
    dispatch({ type: "SET_CURRENT_SUBSCRIPTION", payload: currentSubscription });
  }, [repositories.plans]);

  const updateProfile = useCallback<SessionContextValue["updateProfile"]>(async (input) => {
    const user = await repositories.auth.updateProfile(input);
    dispatch({ type: "SET_USER", payload: user });
  }, [repositories.auth]);

  const uploadAvatar = useCallback<SessionContextValue["uploadAvatar"]>(async (file) => {
    const user = await repositories.auth.uploadAvatar(file);
    dispatch({ type: "SET_USER", payload: user });
  }, [repositories.auth]);

  const deleteAccount = useCallback<SessionContextValue["deleteAccount"]>(async () => {
    authRequestVersion.current += 1;
    try {
      await repositories.auth.deleteAccount();
    } finally {
      dispatch({ type: "SIGN_OUT" });
      localStorage.removeItem(UI_SESSION_STORAGE_KEY);
    }
  }, [repositories.auth]);

  const setFirstBotId = useCallback<SessionContextValue["setFirstBotId"]>((botId) => {
    dispatch({ type: "SET_FIRST_BOT", payload: botId });
  }, []);

  const signOut = useCallback<SessionContextValue["signOut"]>(async () => {
    authRequestVersion.current += 1;
    try {
      await repositories.auth.signOut();
    } finally {
      dispatch({ type: "SIGN_OUT" });
      localStorage.removeItem(UI_SESSION_STORAGE_KEY);
    }
  }, [repositories.auth]);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      authReady: session.authReady,
      isAuthenticated: session.stage === "authenticated" && Boolean(session.user),
      planConfirmed: session.currentSubscription?.status === "active",
      signInWithCode,
      signInAsGuest,
      sendVerificationCode,
      signUpWithCode,
      validateInviteCode,
      selectPlan,
      updateProfile,
      uploadAvatar,
      deleteAccount,
      setFirstBotId,
      signOut,
    }),
    [
      sendVerificationCode,
      session,
      setFirstBotId,
      signInAsGuest,
      signInWithCode,
      signOut,
      signUpWithCode,
      selectPlan,
      updateProfile,
      uploadAvatar,
      deleteAccount,
      validateInviteCode,
    ],
  );

  return <SessionContext value={value}>{children}</SessionContext>;
};

export const useSession = () => {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("useSession must be used within SessionProvider");
  }
  return context;
};
