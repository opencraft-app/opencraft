import { Outlet } from "react-router-dom";

export const AppShellLayout = () => {
  return (
    <div className="flex min-h-dvh flex-col bg-white text-[var(--text-primary)]">
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
};
