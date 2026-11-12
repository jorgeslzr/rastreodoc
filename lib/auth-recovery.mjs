const AUTH_REQUEST_TIMEOUT_MS = 15000;
const AUTH_UI_TIMEOUT_MS = 20000;

// Bound Auth requests only. Preserve existing signals and behavior for database
// writes, including the separate uncertain-write verification protocols.
export function createAuthFetch(fetchImpl = (input, init) => globalThis.fetch(input, init), timeoutMs = AUTH_REQUEST_TIMEOUT_MS) {
  return (input, init) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(rawUrl, "https://local.invalid").pathname;
    if (!path.startsWith("/auth/v1/")) return fetchImpl(input, init);
    const callerSignal = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : null);
    const deadline = AbortSignal.timeout(timeoutMs);
    let signal = deadline;
    if (callerSignal) {
      // Support the same browsers as the existing timeout-based writes without
      // requiring the newer AbortSignal.any API. Release both listeners at abort.
      const controller = new AbortController();
      const abort = () => {
        callerSignal.removeEventListener("abort", abort);
        deadline.removeEventListener("abort", abort);
        controller.abort(callerSignal.aborted ? callerSignal.reason : deadline.reason);
      };
      if (callerSignal.aborted || deadline.aborted) abort();
      else {
        callerSignal.addEventListener("abort", abort, { once: true });
        deadline.addEventListener("abort", abort, { once: true });
      }
      signal = controller.signal;
    }
    return fetchImpl(input, { ...init, signal });
  };
}

export function authErrorMessage(error, context = "signin") {
  const code = error?.code ?? error?.error_code;
  const status = Number(error?.status);
  if (status === 429 || ["over_request_rate_limit", "over_email_send_rate_limit"].includes(code)) {
    return "Hubo demasiados intentos de acceso. Espera unos minutos antes de volver a intentar.";
  }
  if (status >= 500) return "El servicio de acceso no está disponible en este momento. Vuelve a intentar en unos minutos.";
  if (context === "session") {
    if (["refresh_token_not_found", "refresh_token_already_used", "session_not_found"].includes(code)) {
      return "Tu sesión caducó. Vuelve a iniciar sesión con tu usuario y contraseña.";
    }
    return "No fue posible recuperar tu sesión. Revisa la conexión y pulsa Reintentar sesión, o ingresa con tu usuario y contraseña.";
  }
  if (code === "invalid_credentials" || error?.message?.toLowerCase() === "invalid login credentials") {
    return "Usuario o contraseña incorrectos. Revisa los datos e intenta de nuevo.";
  }
  if (code === "email_not_confirmed") return "Tu cuenta necesita confirmar el correo. Comunícalo al administrador de la oficina.";
  if (code === "user_banned") return "Esta cuenta está deshabilitada. Comunícalo al administrador de la oficina.";
  if (["TimeoutError", "AbortError", "AuthRetryableFetchError"].includes(error?.name)
    || /failed to fetch|fetch failed|network request failed|load failed/i.test(error?.message ?? "")) {
    return "No pudimos comprobar el acceso por un problema de conexión o de tiempo de espera. Revisa tu conexión y vuelve a intentar.";
  }
  return "No fue posible iniciar sesión. Vuelve a intentar; si continúa, comunícalo al administrador de la oficina.";
}

export async function withAuthDeadline(operation, timeoutMs = AUTH_UI_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Authentication did not finish before its deadline.");
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createSessionRecovery({ getSession, onSession, onError, onLoading, timeoutMs = AUTH_UI_TIMEOUT_MS }) {
  let version = 0;
  let disposed = false;
  return {
    async load() {
      if (disposed) return false;
      const request = ++version;
      const current = () => !disposed && version === request;
      onLoading(true);
      onError(null);
      try {
        const result = await withAuthDeadline(getSession, timeoutMs);
        if (!current()) return false;
        if (result.error) throw result.error;
        if (!result.data || result.data.session === undefined) throw new Error("Incomplete session response.");
        onSession(result.data.session);
        return true;
      } catch (error) {
        if (current()) onError(authErrorMessage(error, "session"));
        return false;
      } finally {
        if (current()) onLoading(false);
      }
    },
    accept(session) {
      if (disposed) return;
      version++;
      onSession(session);
      onError(null);
      onLoading(false);
    },
    invalidate() { version++; },
    dispose() { disposed = true; version++; },
  };
}
