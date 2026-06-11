export class ApiClientError extends Error {
  readonly status: number;
  readonly details: unknown;
  readonly network: boolean;

  constructor(message: string, options: { status?: number; details?: unknown; network?: boolean } = {}) {
    super(message);
    this.name = "ApiClientError";
    this.status = options.status ?? 0;
    this.details = options.details;
    this.network = Boolean(options.network);
  }
}

export function isNetworkError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError && error.network;
}

export function isHttpError(error: unknown, status?: number): error is ApiClientError {
  return error instanceof ApiClientError && !error.network && (status === undefined || error.status === status);
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: HeadersInit = {
    ...(init?.body ? { "content-type": "application/json" } : {}),
    ...(init?.headers ?? {})
  };

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: "include",
      headers
    });
  } catch (error) {
    throw new ApiClientError(error instanceof Error ? error.message : "Network request failed", {
      network: true,
      details: error
    });
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiClientError(payload.error ?? "Request failed", {
      status: response.status,
      details: payload
    });
  }
  return payload as T;
}
