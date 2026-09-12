type ClerkUser = {
  id: string;
  public_metadata?: Record<string, unknown>;
};

const CLERK_API_BASE = "https://api.clerk.com/v1";

async function clerkRequest<T>(
  path: string,
  secretKey: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${CLERK_API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/json",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as T & {
    errors?: Array<{ long_message?: string; message?: string }>;
  };
  if (!response.ok) {
    const message = body.errors?.[0]?.long_message ?? body.errors?.[0]?.message;
    throw new Error(message ?? `Clerk admin setup failed (${response.status})`);
  }
  return body;
}

export async function ensureAdminAccount(): Promise<"created" | "updated"> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!email || !password || !secretKey) {
    throw new Error(
      "ADMIN_EMAIL, ADMIN_PASSWORD, and CLERK_SECRET_KEY are required",
    );
  }

  const users = await clerkRequest<ClerkUser[]>(
    `/users?email_address=${encodeURIComponent(email)}&limit=1`,
    secretKey,
  );
  const existing = users[0];
  const publicMetadata = {
    ...(existing?.public_metadata ?? {}),
    role: "owner",
  };

  if (!existing) {
    await clerkRequest<ClerkUser>("/users", secretKey, {
      method: "POST",
      body: JSON.stringify({
        email_address: [email],
        password,
        public_metadata: publicMetadata,
      }),
    });
    return "created";
  }

  await clerkRequest<ClerkUser>(`/users/${encodeURIComponent(existing.id)}`, secretKey, {
    method: "PATCH",
    body: JSON.stringify({
      password,
      public_metadata: publicMetadata,
    }),
  });
  return "updated";
}