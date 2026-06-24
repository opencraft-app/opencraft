"use client";

import {
  QueryClient,
  QueryClientProvider,
  type QueryClientProviderProps,
} from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

export interface VelaQueryProviderProps {
  children: ReactNode;
  queryClient?: QueryClient;
}

export function VelaQueryProvider({
  children,
  queryClient,
}: VelaQueryProviderProps) {
  const [ownedQueryClient] = useState(
    () =>
      queryClient ??
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            staleTime: 1_500,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={ownedQueryClient}>
      {children}
    </QueryClientProvider>
  );
}

export type VelaQueryClientProviderProps = QueryClientProviderProps;

