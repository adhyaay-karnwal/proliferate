# Actions Framework

> Server-side integration proxy that lets sandbox agents interact with external services (Sentry, Linear, etc.) without ever seeing OAuth tokens.

## Overview

The Actions Framework is a **server-side proxy layer** between sandbox agents and external APIs. Instead of injecting integration tokens directly into sandbox environments (security risk), agents make HTTP requests to the Gateway, which resolves tokens server-side, calls the external API, and returns results — with full audit logging, risk-based approval flows, and rate limiting.

```
┌────────────────────────┐
│  Agent (OpenCode)      │
│  inside Sandbox        │
│                        │
│  POST /actions/invoke  │
│  { integration, action,│
│    params }            │
└──────────┬─────────────┘
           │ HTTP (sandbox token)
           ▼
┌──────────────────────────────────────────────────────────────┐
│                    Gateway (Express)                         │
│  apps/gateway/src/api/proliferate/http/actions.ts            │
│                                                              │
│  1. Validate sandbox auth + rate limit                       │
│  2. Look up adapter (sentry/linear) from registry            │
│  3. Find integration connection from session_connections     │
│  4. Create action_invocations row (risk-based status)        │
│  5. Risk policy:                                             │
│     ┌─────────┬────────────────────────────────────┐        │
│     │ read    │ Auto-approve → execute immediately  │        │
│     │ write   │ Pending → broadcast WS → wait       │        │
│     │ danger  │ Immediately denied                   │        │
│     └─────────┴────────────────────────────────────┘        │
│  6. Token resolved server-side via Nango/GitHub App          │
│  7. Adapter calls external API → result stored (redacted)    │
└──────────┬──────────────────────────┬────────────────────────┘
           │                          │
           │ HTTP response            │ WebSocket broadcast
           │ (read: result)           │ (write: action_approval_request)
           │ (write: 202 Accepted)    │
           ▼                          ▼
     Agent polls for           ┌──────────────────────────┐
     status via GET            │  Browser UI              │
     /invocations/:id          │  ActionApprovalBanner    │
                               │                          │
                               │  [Approve] [Deny]        │
                               │  5-minute countdown      │
                               └──────────┬───────────────┘
                                          │ POST /invocations/:id/approve
                                          │ (user token, admin role)
                                          ▼
                               Gateway executes action →
                               broadcasts action_completed →
                               agent sees completed status
```

---

## Entities

### Action Invocation (`action_invocations` table)

The core record. Every time an agent asks to interact with an external service, an invocation is created — regardless of whether it gets approved, denied, or auto-executed.

**Schema** (`packages/db/src/schema/schema.ts:1093-1145`):

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID (PK) | Unique invocation ID |
| `sessionId` | UUID (FK → sessions) | Which sandbox session initiated this |
| `organizationId` | text (FK → organization) | Org that owns the session |
| `integrationId` | UUID (FK → integrations, nullable) | Which integration record (SET NULL on delete) |
| `integration` | text | Integration name string (`sentry`, `linear`) |
| `action` | text | Action name within the integration (`list_issues`, `create_issue`) |
| `riskLevel` | text | `read` / `write` / `danger` |
| `params` | JSONB | Original action parameters (unredacted — needed for replay after approval) |
| `status` | text | Lifecycle state (see below) |
| `result` | JSONB | Execution result (redacted + truncated to 10KB) |
| `error` | text | Error message if failed |
| `durationMs` | integer | Execution duration |
| `approvedBy` | text | User ID who approved/denied |
| `approvedAt` | timestamp | When approved |
| `completedAt` | timestamp | When terminal state reached |
| `expiresAt` | timestamp | Approval deadline (5 minutes for writes) |
| `createdAt` | timestamp | When invocation was created |

**Indexes:**
- `idx_action_invocations_session` — Fast lookup by session
- `idx_action_invocations_org_created` — Audit queries by org + time
- `idx_action_invocations_status_expires` — Sweeper cleanup (pending + expired)

**Foreign keys** — All cascade on delete (session/org), except `integrationId` which sets null.

### Status Lifecycle

```
         ┌──────────┐
         │ (invoke) │
         └────┬─────┘
              │
    ┌─────────┼──────────┐
    │         │          │
    ▼         ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐
│ denied │ │approved│ │pending │
│(danger)│ │ (read) │ │(write) │
└────────┘ └───┬────┘ └───┬────┘
               │          │
               ▼          ├────────────────┐
          ┌──────────┐    │                │
          │executing │    ▼                ▼
          └────┬─────┘ ┌────────┐    ┌─────────┐
               │       │approved│    │ expired │ (5 min timeout)
          ┌────┴────┐  └───┬────┘    └─────────┘
          │         │      │              │
          ▼         ▼      ▼              ▼
     ┌─────────┐ ┌──────┐ ┌──────────┐  ┌──────┐
     │completed│ │failed│ │executing │  │denied│ (user)
     └─────────┘ └──────┘ └────┬─────┘  └──────┘
                               │
                          ┌────┴────┐
                          │         │
                          ▼         ▼
                     ┌─────────┐ ┌──────┐
                     │completed│ │failed│
                     └─────────┘ └──────┘
```

### Action Adapter

An adapter translates generic `(action, params, token)` calls into specific external API requests.

**Interface** (`packages/services/src/actions/adapters/types.ts`):

```typescript
interface ActionAdapter {
  integration: string;                    // 'sentry', 'linear'
  actions: ActionDefinition[];            // declared capabilities
  execute(action: string, params: Record<string, unknown>, token: string): Promise<unknown>;
}

interface ActionDefinition {
  name: string;                           // 'list_issues', 'create_issue'
  description: string;
  riskLevel: 'read' | 'write' | 'danger';
  params: ActionParam[];                  // typed parameter specs
}

interface ActionParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object';
  required: boolean;
  description: string;
}
```

### Session Connection (`session_connections` table)

Links a session to the integrations it has access to. Created when a session is started. This is how the actions framework knows which integrations an agent can use.

**Schema** (`packages/db/src/schema/schema.ts:648-677`):

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID (PK) | Connection record ID |
| `sessionId` | UUID (FK → sessions) | Session that has this integration |
| `integrationId` | UUID (FK → integrations) | Which integration is connected |
| `createdAt` | timestamp | When connected |

Unique constraint on `(sessionId, integrationId)`.

---

## Code Paths (Layer by Layer)

### Layer 1: Database (`packages/services/src/actions/db.ts`)

Raw Drizzle queries against `action_invocations`. Every function is a thin wrapper over a single query.

| Function | What it does |
|----------|-------------|
| `createInvocation(input)` | INSERT → returning row |
| `getInvocation(id, orgId)` | SELECT by ID + org (security-scoped) |
| `getInvocationById(id)` | SELECT by ID only (internal use) |
| `updateInvocationStatus(id, status, data?)` | UPDATE status + optional fields → returning |
| `listBySession(sessionId)` | SELECT all for session, ORDER BY createdAt DESC |
| `listPendingBySession(sessionId)` | SELECT where status='pending' for session |
| `expirePendingInvocations(now)` | UPDATE pending → expired where expiresAt <= now |

### Layer 2: Service (`packages/services/src/actions/service.ts`)

Business logic with risk-based policy, validation, redaction. Sits between gateway HTTP and DB.

| Function | Behavior |
|----------|----------|
| `invokeAction(input)` | Creates invocation. Danger → denied. Read → approved. Write → pending (5 min expiry). |
| `markExecuting(id)` | Sets status to 'executing' (called before adapter.execute) |
| `markCompleted(id, result, durationMs)` | Redacts sensitive keys, truncates to 10KB, sets completed |
| `markFailed(id, error, durationMs?)` | Records error + completion time |
| `approveAction(id, orgId, userId)` | Validates pending + not expired + org match → sets approved |
| `denyAction(id, orgId, userId)` | Validates pending + org match → sets denied |
| `getActionStatus(id, orgId)` | Single lookup (org-scoped) |
| `listSessionActions(sessionId)` | All invocations for session (any status) |
| `listPendingActions(sessionId)` | Only pending invocations |
| `expireStaleInvocations()` | Marks overdue pendings as expired (called by sweeper) |

**Error classes:** `ActionNotFoundError`, `ActionExpiredError`, `ActionConflictError`

**Security features:**
- Sensitive keys redacted from stored results: `token`, `secret`, `password`, `authorization`, `api_key`, `apikey`
- Results truncated to 10KB max before DB storage
- Params stored unredacted (needed for execution replay after user approval)

### Layer 3: Adapter Registry (`packages/services/src/actions/adapters/`)

Central `Map<string, ActionAdapter>` mapping integration names to adapters.

**`adapters/index.ts`:**
```
registry: Map<string, ActionAdapter>
  "sentry" → sentryAdapter
  "linear" → linearAdapter
```

| Function | Description |
|----------|-------------|
| `getAdapter(integration)` | Look up adapter by name |
| `listAdapters()` | Return all adapter summaries |

**Currently registered adapters:**

**Sentry** (`adapters/sentry.ts`) — REST API (`https://sentry.io/api/0`):
| Action | Risk | What it does |
|--------|------|-------------|
| `list_issues` | read | GET `/projects/{org}/{project}/issues/` |
| `get_issue` | read | GET `/issues/{id}/` |
| `list_issue_events` | read | GET `/issues/{id}/events/` |
| `get_event` | read | GET `/issues/{id}/events/{event_id}/` |
| `update_issue` | write | PUT `/issues/{id}/` (status, assignedTo) |

**Linear** (`adapters/linear.ts`) — GraphQL API (`https://api.linear.app/graphql`):
| Action | Risk | What it does |
|--------|------|-------------|
| `list_issues` | read | Query `issues` with team/project filter |
| `get_issue` | read | Query `issue` by ID with comments |
| `create_issue` | write | Mutation `issueCreate` |
| `update_issue` | write | Mutation `issueUpdate` |
| `add_comment` | write | Mutation `commentCreate` |

Both adapters: 30-second timeout (`AbortSignal.timeout(30_000)`), proper error handling with status codes.

### Layer 4: Gateway HTTP API (`apps/gateway/src/api/proliferate/http/actions.ts`)

Express router mounted at `/:proliferateSessionId/actions`. This is the entry point for both sandbox agents and browser clients.

| Endpoint | Auth | Caller | What it does |
|----------|------|--------|-------------|
| `GET /available` | sandbox OR user | Both | Lists integrations + actions available for this session |
| `POST /invoke` | sandbox ONLY | Agent | Invokes an action (risk-based policy applied) |
| `GET /invocations/:id` | sandbox OR user | Both | Polls invocation status |
| `POST /invocations/:id/approve` | user ONLY (admin) | Browser | Approves a pending write action |
| `POST /invocations/:id/deny` | user ONLY (admin) | Browser | Denies a pending write action |
| `GET /invocations` | sandbox OR user | Both | Lists all invocations for session |

**Rate limiting** (in-memory, per session):
- 60 invocations per minute per session
- 10 max pending approvals per session
- Counters auto-cleaned after window expires

**Invoke flow (POST /invoke) in detail:**
1. Verify sandbox auth (`req.auth.source === "sandbox"`)
2. Check rate limit (60/min/session)
3. Validate adapter exists + action exists in adapter
4. Find session connection matching integration
5. Look up session → get `organizationId`
6. If write: check pending count < 10
7. Call `actions.invokeAction()` → creates DB row
8. **If read (auto-approved):** mark executing → resolve token via `integrations.getToken()` → `adapter.execute()` → mark completed → return result
9. **If write (pending):** broadcast `action_approval_request` via WS hub → return 202
10. **If danger:** return 403 with denied invocation

**Approve flow (POST /approve) in detail:**
1. Verify user auth + admin/owner role in org
2. `actions.approveAction()` → validates pending + not expired + org
3. Mark executing → resolve token → `adapter.execute()` → mark completed
4. Broadcast `action_completed` via WS hub → return result
5. On failure: mark failed → broadcast `action_completed` with error

### Layer 5: Token Resolution (`packages/services/src/integrations/tokens.ts`)

Resolves OAuth tokens for integrations. Tokens never leave the server.

```typescript
async function getToken(integration: IntegrationForToken): Promise<string>
```

Two providers:
- **`nango`**: Fetches OAuth access token from Nango API (`@nangohq/node`)
- **`github-app`**: Gets GitHub App installation token

The gateway calls this during action execution, passing the integration metadata from the `session_connections` join with `integrations` table.

### Layer 6: WebSocket Messages (`packages/shared/src/index.ts:389-445`)

Three message types flow from Gateway → Browser over WebSocket:

```typescript
// Sent when a write action is invoked and needs approval
interface ActionApprovalRequestMessage {
  type: "action_approval_request";
  payload: {
    invocationId: string;
    integration: string;       // 'sentry', 'linear'
    action: string;            // 'create_issue', etc.
    riskLevel: string;
    params: unknown;
    expiresAt: string;         // ISO timestamp (now + 5 min)
  };
}

// Sent when a user denies an action
interface ActionApprovalResultMessage {
  type: "action_approval_result";
  payload: {
    invocationId: string;
    status: "approved" | "denied";
    approvedBy?: string;
  };
}

// Sent when action execution finishes (after approval or on failure)
interface ActionCompletedMessage {
  type: "action_completed";
  payload: {
    invocationId: string;
    status: "completed" | "failed";
    result?: unknown;
    error?: string;
  };
}
```

All three are part of the `ServerMessage` union type and handled by the WS message router.

### Layer 7: Frontend UI

**State management** — in `useSessionWebSocket` hook (`apps/web/src/components/coding-session/runtime/use-session-websocket.ts`):

```typescript
const [pendingApprovals, setPendingApprovals] = useState<
  ActionApprovalRequestMessage["payload"][]
>([]);
```

**WS message handling** — in `handleServerMessage` (`runtime/message-handlers.ts`):
- `action_approval_request` → append to `pendingApprovals` array
- `action_approval_result` / `action_completed` → remove from `pendingApprovals` by `invocationId`

**UI component** — `ActionApprovalBanner` (`apps/web/src/components/coding-session/action-approval-banner.tsx`):

Renders as a floating overlay at the bottom of the chat area (positioned `absolute bottom-20` in `coding-session.tsx`). Shows only when `pendingApprovals.length > 0`.

Each pending action renders an `ApprovalCard`:
- Shield icon + `{integration}/{action}` label + risk level badge
- Parameters preview (key-value formatted, truncated)
- Countdown timer (5-minute expiry, updates every second)
- **Approve** / **Deny** buttons
- Error display if HTTP call fails
- Buttons disabled when loading or expired

Approve/Deny actions call the Gateway directly via `fetch`:
```
POST ${GATEWAY_URL}/proliferate/${sessionId}/actions/invocations/${invocationId}/approve
POST ${GATEWAY_URL}/proliferate/${sessionId}/actions/invocations/${invocationId}/deny
Authorization: Bearer ${userToken}
```

**Wiring in `coding-session.tsx`:**
```typescript
{pendingApprovals.length > 0 && (
  <div className="absolute bottom-20 left-0 right-0 z-10">
    <ActionApprovalBanner
      sessionId={sessionId}
      token={wsToken}
      pendingApprovals={pendingApprovals}
    />
  </div>
)}
```

`pendingApprovals` is also passed to `SessionPanelProps` / `RightPanel` for potential right-panel rendering.

### Layer 8: Worker Sweeper (`apps/worker/src/sweepers/index.ts`)

Background interval (every 60 seconds) that marks stale pending invocations as expired:

```typescript
const SWEEP_INTERVAL_MS = 60_000;

setInterval(async () => {
  const expired = await actions.expireStaleInvocations();
  // logs count if > 0
}, SWEEP_INTERVAL_MS);
```

Started/stopped with the worker process lifecycle (`startActionExpirySweeper` / `stopActionExpirySweeper`).

---

## Full Data Flow: Write Action (End-to-End)

This is the most complex flow — reads are simpler (skip steps 7-13).

```
 1. Agent calls POST /proliferate/{sessionId}/actions/invoke
    Body: { integration: "linear", action: "create_issue", params: {...} }
    Auth: Bearer {sandbox_token}

 2. Gateway validates: sandbox auth, rate limit (60/min), adapter exists,
    action exists, session connection active, pending count < 10

 3. Service creates action_invocations row:
    status='pending', expiresAt=now+5min, params stored unredacted

 4. Gateway broadcasts via WS hub:
    { type: "action_approval_request", payload: { invocationId, ... } }

 5. Gateway returns HTTP 202:
    { invocation: {..., status: 'pending'}, message: "Action requires approval" }

 6. Browser receives WS message → adds to pendingApprovals state

 7. ActionApprovalBanner renders with countdown timer, Approve/Deny buttons

 8. User clicks Approve → POST /invocations/{id}/approve
    Auth: Bearer {user_token}

 9. Gateway validates: user auth, admin/owner role, org membership

10. Service approveAction(): checks pending + not expired + org match
    Sets approvedBy, approvedAt

11. Gateway: markExecuting() → resolves token via Nango →
    adapter.execute("create_issue", params, token) → Linear GraphQL API

12. Service markCompleted(): redacts sensitive keys, truncates result,
    stores duration

13. Gateway broadcasts WS: { type: "action_completed", payload: {...} }

14. Browser removes from pendingApprovals, agent sees completed status
```

**Meanwhile (parallel):**
- Agent can poll `GET /invocations/{id}` to check status
- Worker sweeper runs every 60s, marks overdue pendings as 'expired'
- If user doesn't respond within 5 min, invocation expires

---

## Complete File Reference

### Database
| File | What |
|------|------|
| `packages/db/src/schema/schema.ts:1093-1145` | `action_invocations` table definition |
| `packages/db/src/schema/schema.ts:648-677` | `session_connections` table definition |

### Services (Business Logic)
| File | What |
|------|------|
| `packages/services/src/actions/index.ts` | Module exports |
| `packages/services/src/actions/service.ts` | Core business logic (invoke, approve, deny, expire) |
| `packages/services/src/actions/db.ts` | Raw Drizzle queries |
| `packages/services/src/actions/adapters/types.ts` | ActionAdapter interface |
| `packages/services/src/actions/adapters/index.ts` | Adapter registry |
| `packages/services/src/actions/adapters/sentry.ts` | Sentry REST adapter |
| `packages/services/src/actions/adapters/linear.ts` | Linear GraphQL adapter |
| `packages/services/src/integrations/tokens.ts` | Token resolution (Nango/GitHub App) |
| `packages/services/src/sessions/db.ts:403` | `listSessionConnections()` |

### Gateway (HTTP API)
| File | What |
|------|------|
| `apps/gateway/src/api/proliferate/http/actions.ts` | 6 HTTP endpoints (invoke, approve, deny, list, status, available) |
| `apps/gateway/src/api/proliferate/http/index.ts:33` | Router mounting at `/:sessionId/actions` |

### Shared Types
| File | What |
|------|------|
| `packages/shared/src/index.ts:389-445` | WS message types (ActionApprovalRequest, ActionApprovalResult, ActionCompleted) |

### Frontend
| File | What |
|------|------|
| `apps/web/src/components/coding-session/action-approval-banner.tsx` | Approval UI (banner + cards + countdown) |
| `apps/web/src/components/coding-session/runtime/use-session-websocket.ts` | `pendingApprovals` state + WS routing |
| `apps/web/src/components/coding-session/runtime/message-handlers.ts:358-374` | WS message → state updates |
| `apps/web/src/components/coding-session/coding-session.tsx:191-198` | Banner mounting in session view |

### Worker
| File | What |
|------|------|
| `apps/worker/src/sweepers/index.ts` | Expiry sweeper (60s interval) |

---

## Prerequisites: Subsystems & Concepts to Understand

To deeply comprehend the Actions Framework, you need familiarity with these subsystems and technologies:

### 1. Gateway Architecture
- **What:** Express HTTP server + WebSocket hub, the real-time backbone
- **Why:** Actions HTTP endpoints live here. WS broadcasts drive the approval flow.
- **Key concepts:** Hub/session model, `broadcastMessage()`, auth middleware (sandbox vs user tokens)
- **Files:** `apps/gateway/src/hub/`, `apps/gateway/src/middleware/`, `apps/gateway/src/api/`

### 2. Integrations System
- **What:** How external services (Sentry, Linear, GitHub) are connected to orgs
- **Why:** Actions need an active integration + its token to execute
- **Key concepts:** `integrations` table, `session_connections` join table, Nango OAuth, GitHub App installation tokens
- **Files:** `packages/services/src/integrations/`, `packages/db/src/schema/schema.ts` (integrations + session_connections tables)

### 3. Nango (OAuth Token Management)
- **What:** Third-party service that handles OAuth flows and stores/refreshes tokens
- **Why:** Actions resolve integration tokens through Nango's API (`@nangohq/node`)
- **Key concepts:** Connection IDs, integration IDs (provider names), `nango.getConnection()` → `credentials.access_token`
- **Docs:** https://docs.nango.dev

### 4. Session Model
- **What:** Active sandbox instances tied to configurations/orgs
- **Why:** Invocations are scoped to sessions, auth is scoped to session's org, sandbox tokens are session-specific
- **Key concepts:** Session lifecycle (create/running/paused), org ownership, sandbox tokens vs user tokens
- **Files:** `packages/services/src/sessions/`

### 5. Gateway Auth Middleware
- **What:** Express middleware that validates Bearer tokens and sets `req.auth`
- **Why:** Actions endpoints have dual auth: sandbox agents (can invoke/poll) vs users (can approve/deny, need admin role)
- **Key concepts:** `req.auth.source` ('sandbox' | 'user'), `req.auth.orgId`, `req.auth.userId`, admin/owner role check
- **Files:** `apps/gateway/src/middleware/`

### 6. WebSocket Protocol (`@proliferate/gateway-clients`)
- **What:** Client library for connecting to Gateway WebSocket
- **Why:** Action approval messages flow over WS; frontend uses `createSyncClient` to receive them
- **Key concepts:** `ServerMessage` union type, event-driven `onEvent` handler, message routing
- **Files:** `packages/gateway-clients/`, `packages/shared/src/index.ts` (ServerMessage type)

### 7. Drizzle ORM
- **What:** TypeScript ORM used for all DB operations
- **Why:** All actions DB queries use Drizzle's query builder
- **Key concepts:** `pgTable` schema definition, `select/insert/update/delete` builders, `returning()`, `InferSelectModel<>`, migrations
- **Files:** `packages/db/`, `packages/services/src/actions/db.ts`

### 8. BullMQ / Worker Process
- **What:** Background job processing system
- **Why:** The action expiry sweeper runs as an interval timer in the worker process (not a BullMQ job itself, but lives alongside them)
- **Key concepts:** Worker lifecycle (start/stop), sweeper pattern (setInterval), graceful shutdown
- **Files:** `apps/worker/src/sweepers/`, `apps/worker/src/index.ts`

### 9. Organization / RBAC Model
- **What:** Org membership with roles (owner/admin/member)
- **Why:** Approve/deny requires admin or owner role; all queries are org-scoped for security
- **Key concepts:** `orgs.getUserRole()`, org-scoped DB queries, admin-only mutations
- **Files:** `packages/services/src/orgs/`

### 10. React State Patterns (Frontend)
- **What:** How the coding session UI manages real-time state
- **Why:** Pending approvals are React state driven by WebSocket events
- **Key concepts:** `useState` for `pendingApprovals[]`, WS message → dispatcher pattern, conditional rendering
- **Files:** `apps/web/src/components/coding-session/runtime/`
