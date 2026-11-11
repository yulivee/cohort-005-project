# Knock in-app feed: prebuilt React components vs. custom UI

Research for issue #2, which is part of map #1. The question is what Knock's in-app feed gives a React Router 8 + React 19 + Tailwind v4 + shadcn/radix app like Cadence. It covers prebuilt components versus hooks or a headless client, real-time delivery, item states, unread counts, theming, user-token auth, and SSR.

Researched on 2026-11-11. Sources are Knock's official docs (docs.knock.app) and the published npm packages. I unpacked the packages and read their type definitions and built source. Facts that come from the package source rather than the docs are marked **[src]**.

## TL;DR

- **Recommendation: a custom UI on the `@knocklabs/react` hooks, with `sonner` for toasts.** The prebuilt components work, but they bring their own design system (Telegraph), their own CSS, and their own icon set. They don't match shadcn, and Tailwind utilities can't override them reliably. The hooks give us everything the components use: a feed client, a reactive store, and real-time events.
- Knock ships **no toast component**. Its toast guide builds toasts from the feed's real-time event, so we use the `sonner` we already have.
- **Turn on enhanced security mode**, and have the server sign a short-lived RS256 user token with `@knocklabs/node`'s `signUserToken`. Without it, anyone holding the public key can read any user's feed.
- **SSR caveat:** the provider creates the client and opens the socket during render, not in an effect **[src]**. Gate it with `enabled={isHydrated}` so the server never connects to Knock.

## Packages (current versions on npm as of 2026-11-11)

| Package | Version | Role |
| --- | --- | --- |
| `@knocklabs/react` | 0.15.1 | Prebuilt components (feed, popover, bell, Slack/Teams, guides) plus everything from `react-core` re-exported, and `dist/index.css` |
| `@knocklabs/react-core` | 0.17.1 | Headless providers and hooks. Peer dependency is `react ^17 \|\| ^18 \|\| ^19`; dependencies include `swr`, `date-fns`, and `@tanstack/react-store` |
| `@knocklabs/client` | 0.23.1 | Framework-agnostic JS client, including `Feed` and the real-time socket (Phoenix channels, `phoenix@1.8.9`) |
| `@knocklabs/node` | 1.41.1 | Server SDK for triggering workflows and `signUserToken` (uses `jose`) |

Source: `npm view <pkg>`.

- `@knocklabs/react` has `next` and `@tanstack/react-router` as **optional** peer dependencies. Its `./next` and `./tanstack` subpath exports contain only `KnockGuideLocationSensor`, which belongs to the Guides product, not the feed. There is no React Router-specific export, and we don't need one. **[src]**
- `@knocklabs/react` depends on `lucide-react ^0.544.0`, Radix dialog and hover-card, `@popperjs/core`, and about ten `@telegraph/*` packages. Cadence already has `lucide-react ^0.563.0`, so the prebuilt path installs a second copy of lucide plus the Telegraph design system. **[src]**
- The old `@knocklabs/react-notification-feed` package is superseded, and its repo has been archived since January 2024. ([React overview](https://docs.knock.app/in-app-ui/react/overview))
- If we install only `@knocklabs/react-core` plus `@knocklabs/client`, we get all the hooks without Telegraph or the CSS. **[src]**

## What is prebuilt

`@knocklabs/react` exports the following feed components ([feed docs](https://docs.knock.app/in-app-ui/react/feed); `dist/types/index.d.ts` **[src]**): `NotificationIconButton` (bell plus badge), `UnseenBadge`, `NotificationFeedPopover`, `NotificationFeed` (full list with filter header), `NotificationFeedContainer`, `NotificationFeedHeader`, `NotificationCell`, `Avatar`, `EmptyFeed`, and `MarkAsRead`.

Customization points:

- **Cells and header:** `NotificationFeed` accepts `renderItem`, `renderHeader`, `onNotificationClick`, `onNotificationButtonClick`, and `initialFilterStatus` (`FilterStatus.Unread`, and so on). `NotificationCell` takes a custom `avatar` and `children`.
- **Popover:** `NotificationFeedPopover` takes `buttonRef`, `isVisible`, `onClose`, `onOpen`, and `onNotificationClick`.
- **Badge:** `NotificationIconButton` takes `badgeCountType`, which is `"unseen"` by default or `"unread"`.
- **Navigation:** clicking a cell redirects to the template's `action_url` by default, and `onNotificationClick` overrides that. For us, that means calling React Router's `navigate` instead of a full page load.
- **Other:** Slack and Teams components, Guides (`Banner`, `Card`, `Modal`), and the preferences hook `usePreferences`. These are not relevant to this ticket.

**Toasts:** "there are no out-of-the-box toast components in `@knocklabs/react`". The guide calls `useKnockFeed()` to get `feedClient` and subscribes to `"items.received.realtime"`. It notes that one event can carry more than one item, renders `item.blocks[0].rendered`, and optionally calls `markAsSeen(items)`. Its example uses `react-hot-toast`, and `sonner` works the same way. ([Toasts guide](https://docs.knock.app/in-app-ui/react/toasts))

## Headless and hook API (custom UI path)

These come from the `react-core` types **[src]** and the [headless feed guide](https://docs.knock.app/in-app-ui/react/headless/feed).

- **`KnockProvider` props:** `apiKey`, `user: { id, ...props }` (`userId` is deprecated), `userToken`, `onUserTokenExpiring`, `timeBeforeExpirationInMs`, `i18n`, `logLevel`, `host`, `branch`, and `enabled` (default `true`). With `enabled: false`, children render but the client stays idle: no identify call, no API calls, and no websocket.
- **`KnockFeedProvider` props:** `feedId` (the in-app channel ID), `colorMode`, and `defaultFeedOptions: FeedClientOptions`. `useKnockFeed()` returns `{ knock, feedClient, useFeedStore, colorMode }`.
  - The [feed docs](https://docs.knock.app/in-app-ui/react/feed) say to pass `userToken` to `KnockFeedProvider`, but the current types accept it **only on `KnockProvider`**. The types are authoritative.
- **Lower-level hooks:**
  - `useKnockClient()`
  - `useAuthenticatedKnockClient(apiKey, user, userToken?, options)`
  - `useNotifications(knock, feedChannelId, options?)`, which returns a `Feed` and has already called `listenForUpdates()`
  - `useNotificationStore(feedClient, selector?)`, which returns a TanStack Store snapshot
  - `useFeedSettings(feedClient)` and `useKnockAuthState`
- **Store shape (`FeedStoreState`):** `items: FeedItem[]`, `metadata: { total_count, unread_count, unseen_count }`, `pageInfo`, `loading`, and `networkStatus`.
- **`FeedItem` fields:** `id`, `blocks` (`markdown`/`text` with a pre-rendered HTML `rendered` field, or `button_set`), `actors`, `data` (the workflow's trigger data), `inserted_at`, `read_at`, `seen_at`, `interacted_at`, `clicked_at`, `link_clicked_at`, `archived_at`, `tenant`, and `source`.
  - `mode` is `"compact"` by default, which leaves out `activities` and nested data and keeps at most one actor. Use `"rich"` for the full payload.
- **`Feed` methods:**
  - Fetching: `fetch`, `fetchNextPage` (cursor pagination)
  - Seen and read: `markAsSeen`, `markAllAsSeen`, `markAsUnseen`, `markAsRead`, `markAllAsRead`, `markAsUnread`
  - Interaction: `markAsInteracted(items, metadata?)`
  - Archiving: `markAsArchived`, `markAllAsArchived`, `markAllReadAsArchived`, `markAsUnarchived`
  - Events: `on` / `off`
  - Lifecycle: `teardown`, `dispose`
  - All mutations update the store optimistically, then call the API. ([Feed client](https://docs.knock.app/in-app-ui/javascript/sdk/feed-client))
- **`FeedClientOptions`** (for scoping the feed): `page_size`, `status` (`unread|read|unseen|seen|all`), `archived` (`include|exclude|only`), `source` (a workflow key), `tenant`, `has_tenant`, `workflow_categories`, `trigger_data`, `inserted_at_date_range`, and `mode`. **[src]**

The headless guide warns that a custom UI must handle state transitions itself. The prebuilt popover does this for you: it calls `markAllAsSeen()` when opened if `unseen_count > 0`, and marks items as read on click. ([Headless feed](https://docs.knock.app/in-app-ui/react/headless/feed))

## Real-time delivery

- **Transport:** a websocket using Phoenix channels. `useNotifications` calls `feed.listenForUpdates()`, which joins the user's feed channel. ([Feed client](https://docs.knock.app/in-app-ui/javascript/sdk/feed-client); `socket-manager.mjs` **[src]**)
- **Events:** `items.received.realtime`, `items.received.page`, `items.(un)seen`, `items.(un)read`, `items.(un)archived`, and the bulk events `items.all_*`. Wildcards are `items.*` and `items.received.*`.
- **Reconnects:** the socket reconnects with exponential backoff and jitter (capped at 10 minutes). By default it disconnects when the page is hidden (`disconnectOnPageHidden`, default `true`). **[src]**
- **Opt-in feed options:**
  - `auto_manage_socket_connection` (plus `_delay`, default 2000 ms) to drop sockets for inactive tabs
  - `__experimentalCrossBrowserUpdates`, which uses BroadcastChannel to sync state across one user's tabs

  ([Feed docs](https://docs.knock.app/in-app-ui/react/feed))
- **Polling:** none is needed.

## Read, seen, archived, and counts

These come from [message statuses](https://docs.knock.app/send-notifications/message-statuses.md) and the [in-app feed channel](https://docs.knock.app/integrations/in-app/feeds.md).

| Status | Meaning |
| --- | --- |
| **Seen** (`seen_at`) | The item was shown in the feed at least once. By default it is set when the feed opens, which resets the badge. |
| **Read** (`read_at`) | The user opened or clicked the item, or used "mark all as read". |
| **Interacted** | The user clicked the cell. |
| **Link clicked** | The user clicked a link in the item. |
| **Archived** | The user dismissed the item with the "x". |

- Engagement statuses are not exclusive: an item can have several at once.
- Archived items disappear from the default feed and can be fetched with `archived: "only"`.
- **Counts:** `metadata.unseen_count` and `metadata.unread_count`. The badge uses **unseen by default** "to reduce noise", and `unread` is optional.
- **Content is immutable:** a sent message can't be edited. To correct one, archive it and trigger the workflow again.
- **Body and links:** the template editor offers Standard, Single-action, and Multi-action variants (up to two buttons, each with its own action URL). The action URL can be a Liquid variable, which is how we'll build deep links.

## Theming and styling (Tailwind v4 / shadcn fit)

- **Prebuilt CSS:** you must `import "@knocklabs/react/dist/index.css"` (about 67 kB minified). You can theme it with about 100 `--rnf-*` CSS variables, plus `--knock-*` and about 250 `--tgph-*` Telegraph tokens on `:root`. Light and dark mode come only through the `colorMode` prop. The other option is to drop Knock's CSS and restyle the `rnf-` classes yourself. ([Feed docs](https://docs.knock.app/in-app-ui/react/feed); `dist/index.css` **[src]**)
- **Tailwind v4 conflict:** the stylesheet is **not in a CSS `@layer`** **[src]**. Tailwind v4 puts utilities in `@layer utilities`, and unlayered CSS always beats layered CSS. So a `className="..."` we add to a Knock element loses to Knock's own rules unless we use `!` (important) everywhere or import Knock's CSS into a layer ourselves.
- **No global resets:** Knock's CSS has no bare element selectors, so it won't damage the rest of the app **[src]**. The look, though, is Knock's: Telegraph buttons, a Popper-based popover, and its own icons. It doesn't follow shadcn's Popover, Button, or ScrollArea or our CSS variables. Dark mode would need us to sync `colorMode` with Cadence's theme by hand.
- **No shadcn registry:** Knock offers no shadcn components or registry. It does publish blog tutorials that pair its hooks with shadcn/ui, which is the custom-UI pattern this note recommends.
- **Rendered HTML:** `blocks[].rendered` is HTML generated by Knock from our own templates. Rendering it means `dangerouslySetInnerHTML`, and Knock's own examples do this. Since we write the templates, it's low risk, but it's still a trust boundary. The alternative is to render from `item.data` with our own JSX.

## User token auth (enhanced security mode)

From [Security & authentication](https://docs.knock.app/in-app-ui/security-and-authentication):

- **When it's off (the default):** the public API key alone is accepted, and "a request with your public key can act as any user". Knock says to enable it before production. A separate development environment can keep it off.
- **Signing:** the server signs an **RS256 JWT** with the environment's private signing key (`KNOCK_SIGNING_KEY`, use the base64 form if you hit key-format errors).
  - `sub` (the user ID) is required, and `iat` and `exp` are recommended.
  - Optional `grants` and `explicit_grants` can scope the token to tenants or objects.
- **Helper:** `signUserToken(userId, { expiresInSeconds })` from `@knocklabs/node` (default 3600 s). Signing happens locally with no network call.
- **Passing it:** pass the token as `userToken` on `KnockProvider`. Pass `onUserTokenExpiring` to fetch a fresh token before expiry. Calling `authenticate` with a new token restarts the socket.
- **For Cadence:** sign the token in the root (or layout) `loader` for the session user and return it with the user. It must be re-signed when the DevUI switches user, because the provider tears down and reconnects when `user.id` or `userToken` changes **[src]**. A refresh endpoint (a resource route returning a fresh token) backs `onUserTokenExpiring`. Alternatively, match `exp` to the session lifetime, as the docs suggest.

## SSR caveats (React Router 8 SSR)

- Knock's docs say nothing about SSR, React Router, or `"use client"`. The ESM entry starts with `"use client"`, which only matters for RSC; React Router's framework mode ignores it. **[src]**
- Importing on the server is safe. The client guards every `window`/`document` access. **[src]**
- **However, rendering on the server has side effects.** `useAuthenticatedKnockClient` builds the Knock client and calls `authenticate` inside `useMemo`. `useNotifications` calls `feeds.initialize(...).listenForUpdates()` inside a `useState` initializer, and when the client is authenticated, that calls `socket.connect()`. So all of this runs **during render, including on the server** **[src]**. Node 22+ has a global `WebSocket`, so an SSR render could open a Knock socket from the server that is never torn down, because effects don't run on the server.
  - **Mitigation:** pass `enabled={isHydrated}` to `KnockProvider` (for example, with a `useHydrated()` hook that is `false` on the server and during the first client render), or mount the Knock subtree client-only.
- **No data during SSR:** feed data is fetched only on the client, so server HTML shows an empty bell and badge, which fill in after hydration. If a correct first-paint count matters, the root loader can fetch `unseen_count` server-side through the Knock REST feed API with the secret key and seed the badge. That's an optional nicety.

## Prebuilt vs. custom: assessment for Cadence

| | Prebuilt (`@knocklabs/react` components) | Custom (`react-core` hooks + shadcn + sonner) |
| --- | --- | --- |
| Effort | Lowest: bell, popover, and feed in about 30 lines | Moderate: bell + `Popover` + list + cell + mark-seen/read/archive wiring |
| Visual fit | Knock or Telegraph look, unlayered CSS, `--rnf-*` vars | Native shadcn/Tailwind, follows our theme and dark mode |
| Dependencies | Telegraph (about 10 packages), Popper, second lucide copy | `@knocklabs/react-core` + `@knocklabs/client` only |
| Toasts | Not provided either way | `items.received.realtime` → `sonner` |
| State logic | Built-in (seen on open, read on click, archive "x") | We call `markAllAsSeen`, `markAsRead`, `markAsArchived` |
| Real-time, counts, auth | Same | Same, from the same provider |

**Answer:** use the **custom UI on `@knocklabs/react-core`'s hooks**. It means less than a day of extra work, and in return it fits our design system, avoids the CSS layer conflict, and keeps Telegraph out of the bundle. A prebuilt `NotificationFeedPopover` is still a reasonable throwaway in the prototype ticket, as a behaviour reference.

## Open questions raised

1. **Badge semantics:** do we count `unseen` (Knock's default, cleared on open) or `unread` (persists until clicked)?
2. **Body rendering:** do we render Knock's `blocks[].rendered` HTML or our own JSX from `item.data` (structured, type-safe, deep links in code)? This affects how the templates are written.
3. **Token lifetime:** do we sign per request in the root loader (simple, re-signs on DevUI switch) or match the session lifetime and refresh through a resource route?
4. **Feed scope:** one feed channel for all roles, or filtered views (for example `workflow_categories` per role, or a `tenant` per Team)?
5. **First-paint count:** is an SSR-seeded `unseen_count` worth a server-side Knock API call per page load?
6. **Environments:** does local dev use a Knock development environment with enhanced security off, or exercise token signing locally too?

## Sources

- Knock docs: [React overview](https://docs.knock.app/in-app-ui/react/overview), [Feed components](https://docs.knock.app/in-app-ui/react/feed), [Toasts](https://docs.knock.app/in-app-ui/react/toasts), [Headless feed](https://docs.knock.app/in-app-ui/react/headless/feed), [JS feed client](https://docs.knock.app/in-app-ui/javascript/sdk/feed-client), [Security & authentication](https://docs.knock.app/in-app-ui/security-and-authentication), [Message statuses](https://docs.knock.app/send-notifications/message-statuses.md), [In-app feed channel](https://docs.knock.app/integrations/in-app/feeds.md), [llms.txt index](https://docs.knock.app/llms.txt)
- npm packages, inspected via `npm view` and `npm pack`: [`@knocklabs/react@0.15.1`](https://www.npmjs.com/package/@knocklabs/react), [`@knocklabs/react-core@0.17.1`](https://www.npmjs.com/package/@knocklabs/react-core), [`@knocklabs/client@0.23.1`](https://www.npmjs.com/package/@knocklabs/client), [`@knocklabs/node@1.41.1`](https://www.npmjs.com/package/@knocklabs/node). Files read: `dist/types/**` and `dist/esm/modules/{core,feed}/**` (`useAuthenticatedKnockClient`, `useNotifications`, `KnockFeedProvider`), `dist/esm/clients/feed/{feed,socket-manager}.mjs`, `dist/esm/api.mjs`, and `dist/index.css`.
