import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ApiError, queryKeys } from "./api";
import "./index.css";

/** A 401 mid-session means the session ended: re-ask "who am I" so guarded pages send the user to sign in. */
const onError = (e: Error) => {
  if (e instanceof ApiError && e.status === 401) void queryClient.invalidateQueries({ queryKey: queryKeys.me });
};

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      // Client errors are answers, not glitches: only network/server failures are retried.
      retry: (count, e) => count < 2 && !(e instanceof ApiError && e.status >= 400 && e.status < 500),
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
