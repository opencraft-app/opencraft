"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  error: Error;
  reset?: () => void;
}

export function AuthErrorPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center space-y-4 max-w-md px-4">
        <AlertTriangle className="mx-auto h-12 w-12 text-destructive" />
        <h1 className="text-2xl font-bold text-foreground">Configuration Error</h1>
        <p className="text-muted-foreground">
          Admin Token is invalid or expired. Check the <code className="text-sm bg-muted px-1 py-0.5 rounded">ADMIN_TOKEN</code> environment variable and restart the dashboard.
        </p>
      </div>
    </div>
  );
}

export function ErrorDisplay({ error, reset }: ErrorBoundaryProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 space-y-4">
      <AlertTriangle className="h-8 w-8 text-destructive" />
      <p className="text-muted-foreground">{error.message}</p>
      {reset && (
        <Button variant="outline" onClick={reset}>
          Try Again
        </Button>
      )}
    </div>
  );
}
