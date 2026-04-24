"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { ADMIN_SESSION_SENTINEL } from "@/lib/admin-session-constants";

interface AuthContextType {
  isAuthenticated: boolean;
  login: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    setIsAuthenticated(sessionStorage.getItem(ADMIN_SESSION_SENTINEL) === "1");
  }, []);

  const login = () => {
    sessionStorage.setItem(ADMIN_SESSION_SENTINEL, "1");
    setIsAuthenticated(true);
    router.push("/dashboard");
  };

  const logout = async () => {
    sessionStorage.removeItem(ADMIN_SESSION_SENTINEL);
    setIsAuthenticated(false);
    try {
      await fetch("/admin/gateway/api/session/logout", {
        method: "POST",
        cache: "no-store",
      });
    } catch (error) {
      console.error("gateway-dashboard logout error:", error);
    }
    router.push("/login");
  };

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
