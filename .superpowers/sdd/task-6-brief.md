### Task 6: Scaffold the React Application, Router, API Client, and Theme

**Files:**
- Create app foundation files listed under Product Application.
- Modify: `pnpm-lock.yaml`
- Test: `apps/web/src/app/app-shell.test.tsx`, `apps/web/src/api/client.test.ts`

**Interfaces:**
- Produces typed `api.get`, `api.post`, `missionQueries`, `ThemeProvider`, `RuntimeStatusProvider`, and TanStack routes.
- Base path is `/app/` in development and production.

- [ ] **Step 1: Create the package and install dependencies**

```bash
mkdir -p apps/web/src/{api,app,state,features/home,features/missions,features/library,features/placeholders,styles} apps/web/e2e
pnpm --filter @morrow/web add react react-dom @morrow/contracts@workspace:* @morrow/ui@workspace:* @tanstack/react-query @tanstack/react-router @tanstack/router-vite-plugin zod lucide-react
pnpm --filter @morrow/web add -D vite typescript vitest jsdom @vitejs/plugin-react @testing-library/react @testing-library/jest-dom @testing-library/user-event @types/react @types/react-dom playwright
```

Set Vite `base: "/app/"`, dev port `4318`, and proxy `/api` to `http://127.0.0.1:4317`.

- [ ] **Step 2: Write failing shell and API tests**

Prove that the shell renders the approved navigation, the active route has `aria-current="page"`, theme persists only the non-sensitive string `morrow-theme`, and a structured API error becomes an `ApiClientError` containing `code`, `message`, and HTTP status.

- [ ] **Step 3: Implement the typed API client**

```ts
export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly traceId: string | null,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function request<T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiClientError(
      response.status,
      body?.error?.code ?? "HTTP_ERROR",
      body?.error?.message ?? "The request could not be completed.",
      response.headers.get("x-trace-id"),
    );
  }
  return schema.parse(body);
}
```

Do not store tokens or provider configuration in localStorage. Theme is the only persisted browser preference in this slice.

- [ ] **Step 4: Implement route structure**

Routes:

```text
/app/                         Home
/app/missions                 Mission list
/app/missions/$missionId      Mission workspace
/app/library                  Library
/app/automations              Coming-soon shell
/app/workspace                Coming-soon shell
/app/connections              Existing provider/connection status shell
/app/settings                 Theme and interface settings
```

- [ ] **Step 5: Run web checks and tests**

```bash
pnpm --filter @morrow/web test
pnpm --filter @morrow/web check
pnpm --filter @morrow/web build
```

Expected: PASS and `apps/web/dist/index.html` exists.

- [ ] **Step 6: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): scaffold Morrow application shell"
```

---

