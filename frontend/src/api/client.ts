import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api";

// Read by LoginPage after a successful login so a forced-logout mid-task
// (expired session) returns the user to what they were doing instead of
// dumping them back on the dashboard with no memory of where they were.
export const POST_LOGIN_REDIRECT_KEY = "rcrm_post_login_redirect";

export const TOKEN_KEYS = { access: "rcrm_access_token", refresh: "rcrm_refresh_token" } as const;

export function getTokens() {
  return {
    access: localStorage.getItem(TOKEN_KEYS.access),
    refresh: localStorage.getItem(TOKEN_KEYS.refresh),
  };
}

export function setTokens(access: string, refresh: string) {
  localStorage.setItem(TOKEN_KEYS.access, access);
  localStorage.setItem(TOKEN_KEYS.refresh, refresh);
}

export function clearTokens() {
  localStorage.removeItem(TOKEN_KEYS.access);
  localStorage.removeItem(TOKEN_KEYS.refresh);
}

export const api = axios.create({ baseURL: BASE_URL });

api.interceptors.request.use((config) => {
  const { access } = getTokens();
  if (access) config.headers.Authorization = `Bearer ${access}`;
  return config;
});

let refreshing: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const { refresh } = getTokens();
  if (!refresh) return null;
  try {
    // Raw axios: must not go through the interceptors.
    const res = await axios.post(`${BASE_URL}/auth/refresh`, { refresh_token: refresh });
    setTokens(res.data.access_token, res.data.refresh_token);
    return res.data.access_token as string;
  } catch {
    clearTokens();
    return null;
  }
}

api.interceptors.response.use(undefined, async (error: AxiosError) => {
  const original = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
  const isAuthCall = original?.url?.includes("/auth/login") || original?.url?.includes("/auth/refresh");

  if (error.response?.status === 401 && original && !original._retried && !isAuthCall) {
    refreshing = refreshing ?? refreshAccessToken();
    const newAccess = await refreshing;
    refreshing = null;
    if (newAccess) {
      original._retried = true;
      original.headers.Authorization = `Bearer ${newAccess}`;
      return api(original);
    }
    // Session is gone for good: land back on the login screen, but remember
    // where the user was so a re-login doesn't strand them on the dashboard
    // in the middle of, say, mapping an import.
    if (window.location.pathname !== "/login") {
      sessionStorage.setItem(
        POST_LOGIN_REDIRECT_KEY,
        window.location.pathname + window.location.search,
      );
      window.location.assign("/login");
    }
  }
  return Promise.reject(error);
});

/** Extracts the server's error message for display, distinguishing "your
 * network is down" and "the server didn't respond in time" from an actual
 * application error -- previously all three rendered the same generic
 * sentence, which is the wrong troubleshooting hint for the first two. */
export function errorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined;
    if (data?.error) return data.error;
    if (err.code === "ECONNABORTED") return "The request timed out. Please try again.";
    if (!err.response) return "Network error — check your connection and try again.";
    if (err.response.status >= 500) return "Server error. Please try again in a moment.";
  }
  return "Something went wrong. Please try again.";
}
