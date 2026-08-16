export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly details?: unknown) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    credentials: "same-origin",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(String(body.error ?? `HTTP ${response.status}`), response.status, body.details);
  return body as T;
}
