import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"
import { createRoot } from "react-dom/client"

import { App } from "./app"
import { TooltipProvider } from "./components/ui/tooltip"
import "./index.css"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
