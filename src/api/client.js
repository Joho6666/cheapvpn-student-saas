export function createApiClient({ baseUrl, getUserToken, getAdminToken, getUnavailableMessage }) {
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
    try {
      const token = options.admin ? getAdminToken?.() : getUserToken?.();
      const response = await fetch(`${baseUrl}${path}`, {
        method: options.method || "GET",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (options.admin && response.status === 404) {
          const error = new Error("后台服务版本较旧，请重启 npm run server");
          error.status = response.status;
          throw error;
        }
        const error = new Error(data.error?.message || (options.admin ? "后台请求失败" : getUnavailableMessage?.() || "API unavailable"));
        error.status = response.status;
        error.code = data.error?.code || "";
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeout = new Error(options.admin ? "后台请求超时，请检查 API 服务" : getUnavailableMessage?.() || "API request timed out");
        timeout.code = "REQUEST_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally { clearTimeout(timer); }
  }

  return {
    request: (path, options = {}) => request(path, { ...options, admin: false }),
    adminRequest: (path, options = {}) => request(path, { ...options, admin: true }),
  };
}
