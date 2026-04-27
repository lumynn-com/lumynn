export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: HeadersInit = {
    ...(init?.body ? { "content-type": "application/json" } : {}),
    ...(init?.headers ?? {})
  };

  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? "Request failed");
  }
  return payload as T;
}
