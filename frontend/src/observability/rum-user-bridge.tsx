import { useEffect } from "react";
import { useSession } from "@/contexts/session-context";
import { initAegis, setAegisUser } from "@/observability/aegis";

export const RumUserBridge = () => {
  const { isAuthenticated, session } = useSession();
  const userId = isAuthenticated ? session.user?.id : null;

  useEffect(() => {
    void initAegis();
  }, []);

  useEffect(() => {
    setAegisUser(userId);
  }, [userId]);

  return null;
};
