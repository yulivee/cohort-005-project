# Knock server integration for Cadence

**Question:** How does the Cadence server integrate with Knock? Covers identifying users, triggering workflows from React Router actions and loaders, idempotency and failure handling, environments and API keys, local development and testing, and pricing limits.

**Researched:** 2026-11-11. **Scope:** server side only: the in-app feed (inbox and toasts) and Web Push. Email stays off Knock. Client feed components are covered only where the server must provide something, such as a signed user token.

**Sources:** Knock docs (docs.knock.app), knock.app/pricing, and the published `@knocklabs/node@1.41.1` tarball (README, `.d.ts` files, `client.js`, CHANGELOG). Claims marked **[unverified]** could not be confirmed in a primary source.

---

## 1. Cadence baseline (from this repo)

- React Router `8.3.0` in framework mode, served by `@react-router/serve`. `@types/node` is `^22` (`package.json`).
- SQLite runs through `better-sqlite3` and Drizzle, and its writes are **synchronous** (for example `db.insert(...).returning().get()` in `app/routes/courses.$slug.purchase.tsx`). A line after the insert therefore runs after the row is committed, unless it sits inside an explicit transaction. No `db.transaction` calls exist today.
- User IDs are autoincrement integers (`users.id` in `app/db/schema.ts`). The session stores `userId: number` (`app/lib/session.ts`). The DevUI switcher posts `userId` to `app/routes/api.switch-user.ts`, which only rewrites the cookie.
- The schema's `UserRole` enum has `student`, `instructor` and `admin`. Team Admin is a `teamMembers.role`, not a user role.
- **No mailer, outbox or notification seam exists.** The only hook is a stub, `if (sendEmail) { // Would send welcome email here }`, in `enrollUser` (`app/routes/courses.$slug.purchase.tsx`). No `process.env` access exists apart from `DISCORD_INVITE_URL`, and there is no `.env` file.
- Tests use Vitest and an in-memory SQLite database built from the real migrations (`app/test/setup.ts`). There is no network mocking set up.

## 2. SDK: `@knocklabs/node`

| Fact | Value | Source |
| --- | --- | --- |
| Package / latest version | `@knocklabs/node` **1.41.1** (npm `time.modified` 2026-11-10) | `npm view @knocklabs/node` |
| Generator | Stainless ("This library is generated with Stainless") | https://github.com/knocklabs/knock-node (README) |
| v1 cutover | `1.0.0` released 2025-05-01. The v0.6.x API shape is obsolete | CHANGELOG.md in the tarball |
| Node support | "Node.js 20 LTS or later" | README §Requirements in the tarball |
| Runtime dependency | `jose` (used for JWT signing) | `npm view ... dependencies` |
| Constructor | `new Knock({ apiKey, maxRetries, timeout, logLevel, logger, fetch, fetchOptions })`. `apiKey` defaults to `process.env.KNOCK_API_KEY` | README; `client.js` |

Method signatures, checked in `resources/*.d.ts` of 1.41.1:

```ts
client.workflows.trigger(key: string, body: WorkflowTriggerParams, options?: RequestOptions)
  // body: { recipients: RecipientRequest[]; actor?; data?; cancellation_key?; tenant?;
  //         settings?: { sandbox_mode?: boolean; skip_delay?: boolean } }
  // -> Promise<{ workflow_run_id: string }>
client.workflows.cancel(key: string, body: { cancellation_key: string; recipients?: ... }) // -> void
client.users.update(userID: string, body: UserUpdateParams)   // identify / upsert
client.users.bulk.identify({ users: [...] })                   // async BulkOperation
client.users.delete(userID) / client.users.merge(userID, ...)
// RecipientRequest = string | InlineIdentifyUserRequest ({ id, name?, email?, avatar?, ... }) | InlineObjectRequest
import { signUserToken } from "@knocklabs/node";              // also re-exported from the package root
signUserToken(userId: string, { signingKey?, expiresInSeconds? = 3600, grants?, shouldGenerateJti? })
```

`UserUpdateParams` reserved fields include `name`, `email`, `avatar`, `locale`, `phone_number`, `timezone`, `created_at`, `channel_data` and `preferences`. Arbitrary extra keys are allowed (`resources/users/users.d.ts`).

**Errors:** all errors subclass `APIError`. They are `BadRequestError` (400), `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404), `UnprocessableEntityError` (422), `RateLimitError` (429) and `InternalServerError` (5xx). `APIConnectionError` covers no response, and `APIConnectionTimeoutError` covers timeouts (README, https://github.com/knocklabs/knock-node).

**Retries:** `maxRetries` defaults to **2**, and the timeout defaults to **60 s**. Both can be set on the client or per request. A request is retried on connection errors, 408, 409, 429 and >=500, or when the server sends `x-should-retry: true`. The backoff is exponential: 0.5 s, then 1 s, capped at 8 s, with up to 25% jitter. The client honours `retry-after` and `retry-after-ms` (`client.js` `shouldRetry`, `calculateDefaultRetryTimeoutMillis`). Worst case for one awaited call with the defaults: 3 attempts × 60 s. Set a short per-call `timeout` inside a request handler.

**Automatic idempotency key:** since **1.17.0** (2025-09-22, CHANGELOG entry "set idempotency key header by default"), the client sends `Idempotency-Key: stainless-node-retry-<uuid4>` on every non-GET request. The key is generated once per call and reused across that call's internal retries (`client.js` `buildHeaders`). SDK-internal retries of a trigger therefore cannot double-send. **Application-level** retries, such as a user re-submitting a form or the app re-running a job, get a new key unless you pass `{ idempotencyKey }` in the request options.

## 3. Identifying users (Cadence user → Knock recipient)

- `id` is the only required property. Knock recommends using your internal user identifier as the `id`. Identify always **upserts and merges**, never replaces, and preferences are deep-merged. https://docs.knock.app/managing-recipients/identifying-recipients
- There are three ways to identify (same source):
  - **Direct:** `PUT /v1/users/{user_id}`, which is `knock.users.update`.
  - **Inline:** a full recipient object passed in a trigger's `recipients` or `actor`.
  - **Bulk:** `POST /v1/users/bulk/identify`, which is `knock.users.bulk.identify` and runs asynchronously.
- Inline recipients "are guaranteed to be identified before the workflow is triggered". https://docs.knock.app/send-notifications/triggering-workflows/api
- When to identify: on signup, and again when profile data such as `name` or `email` changes, often in a deferred backend job. "Alternatively", send the full recipient data with every trigger. https://docs.knock.app/managing-recipients/identifying-recipients
- Knock IDs are strings (`InlineIdentifyUserRequest.id: string`), so map `String(user.id)`.

**Recommendation for Cadence:**

- **Identify inline on every trigger.** Build each recipient as `{ id: String(u.id), name: u.name, email: u.email, avatar: u.avatarUrl ?? undefined }`, and do the same for `actor`. Knock then always holds current data and needs no separate sync path, and reseeded dev databases heal themselves.
- **Also call `users.update` when the user loads the in-app feed** (see §6). The feed client authenticates as a Knock user ID, and a user who has never been a recipient may not exist in Knock yet. **[unverified]** The docs do not say what the feed returns for a user who was never identified. To keep this cheap, call it only when the session user changes, or once per session.
- Do **not** send `email` if you want to be certain Knock can never email. Email is not a configured channel in the workflows, so sending it is harmless, but it is a choice. If you do send `email`, the Knock profile holds the user's address as PII.
- The Cadence role, the Team Admin flag and the team ID can travel as custom properties or as trigger `data`. Use `tenant` only if feeds must be scoped per team. `tenant` scopes in-app feed messages (https://docs.knock.app/send-notifications/triggering-workflows/api).

## 4. Triggering workflows

- Endpoint: `POST /v1/workflows/{key}/trigger` returns **200** with `{ workflow_run_id }`, at **rate-limit tier 5**. "All workflow runs are executed asynchronously." The response tells you the run was accepted, not delivered. https://docs.knock.app/api-reference/workflows/trigger
- Up to **1000 recipients** per trigger, and there is no bulk trigger endpoint. The `data` payload is capped at 10 MB, and string values over 1024 bytes are truncated in logs. Triggering an **Inactive** workflow returns a `workflow_inactive` error. https://docs.knock.app/send-notifications/triggering-workflows/api and https://docs.knock.app/send-notifications/triggering-workflows/overview
- `actor` links the actor to in-app feed messages, and per-recipient `$trigger_data` overrides `data` for that recipient only (api page above).
- The API runs the **last committed** version of a workflow, while the dashboard test runner uses the last *saved* version. https://docs.knock.app/send-notifications/testing-workflows
- Rate limits are per endpoint tier and scoped per environment. The table lists 1, 5, 60, 200 and 1,000 req/s, but the fetched page did not show which tier maps to which value. **[unverified]** Tier 5 is probably 1,000 req/s. https://docs.knock.app/api-reference/overview/rate-limits. Cadence volume is far below either reading.

**Where to call it in React Router:**

- **Actions only, never loaders.** A loader runs on every navigation and revalidation, so a trigger there would fire repeatedly. React Router's model calls loaders after every action. That is framework behaviour, not a Knock source.
- Call the trigger **after** the SQLite write returns. better-sqlite3 is synchronous, so the row is committed once `.get()` or `.run()` returns, unless the code is inside `db.transaction(...)`. In that case trigger after the transaction callback returns.
- **Fire-and-forget versus await:** a trigger failure must never fail the user's action. The enrollment or comment has already been committed.
  - Option A: `void notify(...).catch(log)`. This is non-blocking and acceptable on a long-lived Node server (`react-router-serve`). It would be lost on serverless freeze. A process crash loses the notification.
  - Option B, more robust: an **outbox row** in the same SQLite write, drained by an in-process interval or worker that calls Knock with `idempotencyKey = outbox row id`. This survives restarts and gives exactly-once semantics within Knock's 24 h idempotency window.
  - Recommendation: start with **A behind the wrapper** (§7). Move to B if lost notifications ever matter. The wrapper signature does not change.

## 5. Idempotency, cancellation, failure handling

- **`Idempotency-Key` header:** only `POST /workflows/:key/trigger` accepts it. Keys are up to 255 chars. Within **24 hours** a repeat returns the original response with `idempotent-replayed: true` and `original-x-request-id`. A repeat with **different parameters returns an error**. https://docs.knock.app/api-reference/overview/idempotent-requests
- Derive app-level keys from the domain event, for example `` `lesson-comment:${comment.id}` `` or `` `enrollment:${enrollment.id}` ``. Never derive them from the request. Because a key reused with different params errors, do not reuse a key across different workflows or recipient lists.
- Knock also offers **trigger frequency** ("once per recipient", optionally per tenant) as a workflow-level dedupe. The test runner ignores it. https://docs.knock.app/send-notifications/triggering-workflows/overview
- **Cancellation:** pass `cancellation_key` on trigger, then call `knock.workflows.cancel(key, { cancellation_key, recipients? })`, which returns 204. Only runs paused in a **batch, delay, wait-for-event or fetch-retry** step can be cancelled. You cannot cancel a single channel step. A 204 only means the cancel was queued, and Knock advises against cancelling within ~5 s of the trigger. A cancel can overtake its own trigger. Messages already in a feed must be **archived** instead. https://docs.knock.app/send-notifications/canceling-workflows
- **Failure semantics:**
  - The SDK retries 408, 409, 429, 5xx and connection errors itself (§2).
  - 400, 401, 403, 404 and 422 are not retried. They are bugs or configuration errors, such as a wrong key, the wrong environment, an uncommitted or inactive workflow, or bad data. Log them loudly.
  - Delivery failures after acceptance are visible only in the dashboard: Observability > Runs, a workflow's Runs and Activity tabs, and Observability > API logs. https://docs.knock.app/send-notifications/debugging-workflows
- **Log retention:** 30 days on Free and Starter, 90 days on Enterprise (https://knock.app/pricing). Log `workflow_run_id` in Cadence's own logs to correlate.

## 6. Environments, keys, user tokens

- An account starts with **production** only. "Enabling environments" adds **development** below it.
  - Users, tenants, objects, messages and logs are **isolated per environment and never copied**.
  - Workflows are versioned with commits and promoted development → production.
  - Once environments are enabled, the CLI and Management API default to development. https://docs.knock.app/concepts/environments
- **Keys** are per environment:
  - `sk_…` is the **secret** key. It is server only and can make any request.
  - `pk_…` is the **public** key. It is safe for the client and only identifies the account.

  https://docs.knock.app/developer-tools/api-keys
- **Enhanced security mode:** production "should enable" it before the in-app feed ships. Without it "a request with your public key can act as any user".
  - The signing key is an RS256 private key, found under Platform > API keys and stored by convention in `KNOCK_SIGNING_KEY`.
  - Sign on the server with `signUserToken(userId, { expiresInSeconds })`. The default lifetime is 3600 s. `sub` is the user ID, and grants can narrow scope when used with `explicit_grants`.
  - The docs suggest keeping enhanced security **off in development**.

  https://docs.knock.app/in-app-ui/security-and-authentication
- The in-app feed client needs the public key, the feed **channel ID** and the user ID, plus a user token when enhanced security is on. **[unverified]** The channel ID requirement is standard for Knock's React feed and was not fetched here.

**Proposed env vars:**

| Var | Side | Notes |
| --- | --- | --- |
| `KNOCK_API_KEY` | server | `sk_…`. The SDK reads it by default |
| `KNOCK_SIGNING_KEY` | server | `signUserToken` reads it by default. Required in prod once enhanced security is on |
| `KNOCK_PUBLIC_API_KEY` | server → loader → client | `pk_…`. Pass it through the root loader rather than `VITE_` so one build serves every environment |
| `KNOCK_FEED_CHANNEL_ID` | server → client | in-app feed channel UUID |
| `KNOCK_ENABLED` (optional) | server | `false` swaps in the no-op or recording fake (§7) |

Mint the user token in the **root loader** (or `layout.app.tsx`) from `getCurrentUserId(request)`. Return `{ knockUserId, knockToken }` only when a user is in the session. When DevUI switches users, the cookie changes, the loader re-runs and a new token is minted for the new user. No extra handling is needed beyond keying the client feed provider on `userId`.

## 7. Local development and testing

**Test seam.** No mailer or outbox exists to copy (§1), so create one:

```ts
// app/lib/knock.server.ts  — the only file that imports @knocklabs/node
export type NotificationEvent =
  | { workflow: "lesson-comment-reply"; recipients: KnockUser[]; actor?: KnockUser;
      data: {...}; idempotencyKey: string };
export interface Notifier { trigger(e: NotificationEvent): Promise<void>; identify(u: KnockUser): Promise<void> }
export function createKnockNotifier(client = new Knock({ timeout: 5_000, maxRetries: 2 })): Notifier
export function createRecordingNotifier(): Notifier & { sent: NotificationEvent[] } // tests + KNOCK_ENABLED=false
export const notifier: Notifier = process.env.KNOCK_API_KEY ? createKnockNotifier() : createRecordingNotifier();
```

- Unit and integration tests assert on `recording.sent`, using the existing in-memory DB pattern in `app/test/setup.ts`. No network traffic and no Knock account are needed in CI.
- The wrapper owns: the user-to-recipient mapping (`String(id)`, name, avatar), the idempotency keys, `.catch` and logging, and a typed union of workflow keys and payloads, so a typo in a workflow key is caught by `tsc` instead of a 404 at runtime.

**Knock-side testing options:**

- **Sandbox mode:** the trigger `settings.sandbox_mode` and the per-channel setting render messages without delivering them, and sandboxed messages are not billed. **The in-app channel does not support sandbox mode** (https://docs.knock.app/manage-your-account/knock-plans), so it cannot keep dev feed messages out of the feed. Sandbox mode still helps with push.
- **`settings.skip_delay`** skips delay steps, which helps with batched or digest workflows. Channel conditions are not evaluated in sandbox mode. https://docs.knock.app/send-notifications/testing-workflows
- **The dashboard test runner** and **`knock workflow run`** in the Knock CLI are available. Use the debugger to inspect any run, whether it came from the API or the dashboard (testing and debugging pages above).
- **Usage "may be accrued in any Knock environment"**, so unsandboxed dev triggers, including every in-app message, count against the monthly message quota. https://docs.knock.app/manage-your-account/knock-plans

**DevUI implications:**

- Seeded users get integer IDs `1..n` in seed order (`scripts/seed.ts`), and every developer's database reuses the same IDs. A shared Knock *development* environment would therefore merge every developer's "user 1" into one feed. Options, all **recommendations rather than Knock guidance**:
  1. Each developer uses their own free Knock account. Environments are unlimited on Free (https://knock.app/pricing).
  2. Prefix recipient IDs from an env var, `KNOCK_USER_ID_PREFIX=sandra-` → `sandra-1`. The prefix must be applied in exactly one place in `knock.server.ts`, for both triggers and `signUserToken`.
  3. Default to the recording fake locally, and use a real key only when working on notifications.
- Because identify always merges and the seed reuses IDs, reseeding can leave stale profiles. Identifying inline on every trigger overwrites them.
- Switching users through DevUI needs no Knock call beyond minting the token. If profile data matters for the feed, identify once on switch in `api.switch-user.ts`, via `notifier.identify` and fire-and-forget.
- Keep enhanced security **off** in the development environment, so the public key alone works locally. Turn it on in production.

## 8. Pricing and free-tier limits (https://knock.app/pricing)

- **Free:** $0. It includes **10,000 messages/month**, unlimited stored user profiles (no MAU cap), batching, digests, preferences, in-app feeds, unlimited workflows and channels, and **unlimited isolated environments**. Knock branding is kept and logs are retained for 30 days.
- **Starter:** $250/mo for 50,000 messages, then $0.005 per message. It removes branding and adds email client previews.
- **Enterprise only:** i18n, audit logs, SAML and SCIM, per-tenant branding and preferences, and 90-day log retention.
- A **message** is "a single message delivered to a single user on a single channel". In-app and push each count separately, so one event that goes to the feed and to push costs **2 messages per recipient**. Triggers, bounced or failed messages, preference-suppressed messages and sandboxed messages are **not** billed.
- Exceeding Free with no billing method is not hard-capped: Knock "will contact you" to set one up.

**Design consequences:**

- Fan-out events, such as notifying all students of a course when a lesson is published, multiply quickly. 200 students × (feed + push) = 400 messages per event.
- Prefer Knock **batch or digest** steps, which are free-tier features. Gate push behind user preferences.
- Avoid in-app messages in dev and CI, because in-app cannot be sandboxed. The recording fake makes this the default.

## 9. Recommended wiring (summary)

1. `npm i @knocklabs/node@^1.41`. Node 20+ is required, which the current `@types/node@22` setup suggests is already met.
2. Create `app/lib/knock.server.ts` (§7). It is the only importer of the SDK, exposes a typed `Notifier`, and swaps in a recording fake when `KNOCK_API_KEY` is unset and in Vitest.
3. In each relevant **action**, after the Drizzle write returns, call `void notifier.trigger({ workflow, recipients: [inline users], actor: currentUser, data, idempotencyKey: \`${event}:${rowId}\` })`. Never call it in loaders. Set `timeout: 5000` on the SDK client.
4. In the root or app layout **loader**, mint `signUserToken(String(userId))`, then return `knockUserId`, `knockToken`, `KNOCK_PUBLIC_API_KEY` and `KNOCK_FEED_CHANNEL_ID` to the client.
5. Knock dashboard setup:
   - Enable environments.
   - Keep enhanced security off in development and on in production.
   - Commit workflows in development, then promote them.
   - Add per-channel sandbox for push in dev.
6. Later, if dropped notifications matter, switch `createKnockNotifier` to write an outbox row and drain it with retries, reusing the same idempotency key.

## Open questions

- Does the in-app feed API return an empty feed or an error for a user ID that has never been identified? This decides whether identify-on-session is required. **[unverified]**
- Knock's Web Push channel support and provider setup (VAPID keys, `channel_data` registration) are out of scope here and were not researched.
- Which rate-limit tier value applies to trigger (tier 5)? The table labels were not readable. **[unverified]**
- Should `tenant` map to a Cadence team (Team Admin scope) or a course? The choice affects feed scoping and preference granularity.
- Is sharing one Knock account across course participants or devs expected, or does each developer bring their own? This decides between options 1 and 2 in §7.
