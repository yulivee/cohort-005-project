# Knock + Web Push for Cadence

**Researched:** 2026-11-11.
**Question:** How can Knock deliver Web Push (browser notifications) to Cadence users? Cadence is a React Router + React 19 web app with no native app, no service worker and no web app manifest yet.
**Scope:** Planning only. Every claim cites a primary source fetched on the date above. Claims marked **(unverified)** could not be confirmed against a fetched primary source.

## TL;DR

- **Knock has no native Web Push / VAPID channel.** Knock's own tutorial says: "Knock does not have a first-party web push channel. Instead, you'll use FCM to send messages to a user's browser" ([Knock FCM web push tutorial](https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm)). Knock's changelog (Sep 10 to Nov 10, 2026) does not mention any new web push provider ([knock.app/changelog](https://knock.app/changelog)).
- **FCM is the only Knock-documented path to browser push.** Knock's push providers are APNs, FCM, Expo, Amazon SNS and OneSignal ([push overview](https://docs.knock.app/integrations/push/overview)). Only FCM is documented for web ([FCM provider](https://docs.knock.app/integrations/push/firebase), [knock.app/channels/push FAQ](https://knock.app/channels/push)). OneSignal supports web push on its own side, but Knock's OneSignal page does not mention web.
- **Device tokens are registered as channel data.** The endpoint is `PUT /v1/users/{user_id}/channel_data/{channel_id}` with `{ "data": { "tokens": [...] } }` ([API ref](https://docs.knock.app/api-reference/users/set_channel_data)). From the browser, use `knock.user.setChannelData({ channelId, channelData: { tokens: [fcmToken] } })` ([tutorial](https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm)). Each set **overwrites** the existing data, so Cadence must merge tokens across devices itself ([setting channel data](https://docs.knock.app/managing-recipients/setting-channel-data)).
- **Knock can remove dead tokens automatically.** When a send bounces with `message.bounced`, Knock can remove the invalid token. This works for FCM, but not for OneSignal in `external_id` mode ([token deregistration](https://docs.knock.app/integrations/push/token-deregistration)).
- **Cadence must add:** a service worker (`firebase-messaging-sw.js`), a Firebase project with a VAPID key pair (generated in the Firebase console), HTTPS, a web app manifest with `display: standalone` (needed for iOS), and a permission prompt triggered by a click ([Firebase web client](https://firebase.google.com/docs/cloud-messaging/js/client), [WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API)).
- **iOS/iPadOS 16.4+ only works after the user adds Cadence to the Home Screen** and the manifest has `display` set to `standalone` or `fullscreen`. Safari tabs on iOS cannot request push permission at all ([WebKit blog](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [OneSignal iOS](https://documentation.onesignal.com/docs/en/web-push-for-ios)). macOS Safari 16 (Ventura+) supports standard Web Push ([WebKit "Meet Web Push"](https://webkit.org/blog/12945/meet-web-push/)).
- **Plans:** Knock's pricing lists "Unlimited delivery channels" on all plans (Free: 10k messages/month; Starter: $250/month + usage). The pricing page says nothing about push-specific gating ([knock.app/pricing](https://knock.app/pricing)).
- **Risk flag:** Firebase now marks `getToken()` (the call Knock's tutorial uses) as deprecated in favour of Firebase Installation IDs ([Firebase web client](https://firebase.google.com/docs/cloud-messaging/js/client)). It is not documented whether Knock's FCM provider accepts Installation IDs as `tokens`.

## 1. Does Knock support browser Web Push natively?

**No, not natively.** It works through a push provider, and in practice that provider is FCM.

- Knock's tutorial says verbatim: "Knock does not have a first-party web push channel. Instead, you'll use FCM to send messages to a user's browser." ([source](https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm))
- Knock's channel types are email, in-app feed, in-app guide, push, SMS, chat and webhook. None of them is a dedicated web or browser channel ([Knock channels concept](https://docs.knock.app/concepts/channels)).
- None of the changelog entries from Sep 10 to Nov 10, 2026 mentions web push, VAPID or a new push provider ([changelog](https://knock.app/changelog)).

How each push provider handles browser push:

| Provider | Browser push via Knock? | Source |
|---|---|---|
| **FCM** | **Yes.** It is documented for Android, iOS and web. Knock tells you to "synchronize your users device tokens retrieved from the FCM SDK in either Android, iOS, or Web". The `webpush` override key is supported. | [FCM provider](https://docs.knock.app/integrations/push/firebase), [push FAQ](https://knock.app/channels/push) |
| **OneSignal** | **Not documented by Knock.** Knock's OneSignal page covers mobile only. OneSignal itself supports web push, including Safari and iOS 16.4+ ([OneSignal web setup](https://documentation.onesignal.com/docs/en/web-push-setup)). In `external_id` mode, Knock sends the Knock user ID as OneSignal's `external_id` ([Knock OneSignal](https://docs.knock.app/integrations/push/one-signal)). Because OneSignal merges a user's subscriptions, web included, under one External ID ([OneSignal users](https://documentation.onesignal.com/docs/en/users)), it should reach web subscriptions too. **(unverified: no source confirms the end-to-end web path through Knock)** | as cited |
| **APNs** | No browser push documented. Safari Web Push uses the standard W3C Push API with VAPID, not APNs provider credentials ([WebKit](https://webkit.org/blog/12945/meet-web-push/)). | [push overview](https://docs.knock.app/integrations/push/overview) |
| **Expo** | No. It is for React Native and Expo apps. | [push overview](https://docs.knock.app/integrations/push/overview) |
| **Amazon SNS** | Not documented for web. | [push overview](https://docs.knock.app/integrations/push/overview) |

There is an inconsistency in Knock's docs. The push overview labels FCM "(Android)" ([overview](https://docs.knock.app/integrations/push/overview)), while the FCM provider page and the tutorial explicitly cover web. Treat the FCM provider page and the tutorial as authoritative.

For a provider Knock does not support, Knock says to contact support@knock.app ([overview](https://docs.knock.app/integrations/push/overview)).

## 2. Registering device tokens and channel data with Knock

### Configuring the provider in Knock

FCM needs your Firebase **Project ID** and the full **Service Account JSON**, entered per environment in the FCM channel settings ([FCM provider](https://docs.knock.app/integrations/push/firebase)). The VAPID key is not entered in Knock. It lives in the Firebase project (see section 3).

### Channel data shape

- **REST:** `PUT /v1/users/{user_id}/channel_data/{channel_id}` with body `{ "data": { "tokens": ["push_token_1"] } }`. This call "Updates or creates channel data", and it creates the user if they don't exist yet ([API ref](https://docs.knock.app/api-reference/users/set_channel_data)).
- **Push providers (APNs, FCM, Expo)** accept either `tokens: string[]` or `devices: PushDevice[]`, where `PushDevice` is `{ token, locale?, timezone? }` ([setting channel data](https://docs.knock.app/managing-recipients/setting-channel-data), [device metadata](https://docs.knock.app/integrations/push/device-metadata)). Whichever you set, both formats come back when you read the data ([device metadata](https://docs.knock.app/integrations/push/device-metadata)).
- **OneSignal (`player_id` mode)** takes `{ player_ids: string[] }`. `player_id` mode is "deprecated by OneSignal". In the recommended `external_id` mode no channel data is needed, because Knock sends its user ID as `external_id` ([Knock OneSignal](https://docs.knock.app/integrations/push/one-signal), [setting channel data](https://docs.knock.app/managing-recipients/setting-channel-data)). Device metadata is not available for OneSignal ([device metadata](https://docs.knock.app/integrations/push/device-metadata)).
- **Overwrite semantics:** "the channel data will always be overwritten with each `set` call" ([setting channel data](https://docs.knock.app/managing-recipients/setting-channel-data)). Knock's tutorial adds that tokens are per device, so when you add a browser token you should keep the user's other tokens rather than overwrite them ([tutorial](https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm)). In practice that means read, then merge, then set.
- **Fan-out:** "Knock will generate and try to deliver a notification for each unique token" ([FCM provider](https://docs.knock.app/integrations/push/firebase)).

### Client SDK

- `@knocklabs/client` exposes `user.getChannelData(params)` and `user.setChannelData({ channelId, channelData })` ([knocklabs/javascript source](https://raw.githubusercontent.com/knocklabs/javascript/main/packages/client/src/clients/users/index.ts)).
- The tutorial calls these from React through `useKnockClient()`: `knock.user.setChannelData({ channelId: KNOCK_FCM_CHANNEL_ID, channelData: { tokens: [firebaseToken] } })`. To unsubscribe it sets `tokens: []` ([tutorial](https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm)).
- **Auth:** "Production environments should enable enhanced security mode". In that mode, client calls with the public API key must carry a user token (a JWT with a `sub` claim, signed RS256 by your backend). Setting channel data is one of the user-level actions a client is allowed to perform ([security & authentication](https://docs.knock.app/in-app-ui/security-and-authentication)). Cadence will need this signed token for the in-app feed anyway.
- Knock's documented client SDK list for push (Swift, Kotlin, React Native, Expo, Flutter) has no web push helper ([knock.app/channels/push](https://knock.app/channels/push)). On the web, Cadence calls the Firebase SDK itself and then calls `setChannelData`.

### Token invalidation and removal

- Token deregistration is opt-in and set per environment, in channel settings under Advanced. When a token is invalid or expired, the message bounces and Knock emits `message.bounced`. Knock then "removes invalid tokens (and devices, when using device metadata)" ([token deregistration](https://docs.knock.app/integrations/push/token-deregistration)).
- It is supported for APNs, FCM, Expo, SNS, and OneSignal in `player_id` mode. It is **not** supported for OneSignal in `external_id` mode ([token deregistration](https://docs.knock.app/integrations/push/token-deregistration), [Knock OneSignal](https://docs.knock.app/integrations/push/one-signal)).
- Knock's pages disagree on the default. The FCM page says deregistration is off by default ([FCM provider](https://docs.knock.app/integrations/push/firebase)). The deregistration page says it is on by default when you create a channel ([token deregistration](https://docs.knock.app/integrations/push/token-deregistration)). **Check the toggle in the dashboard.**
- Bounced-token events can also be observed through outbound webhooks ([token deregistration](https://docs.knock.app/integrations/push/token-deregistration)).
- On the browser side, `pushsubscriptionchange` fires when a subscription is invalidated or about to expire, so Cadence should re-register then ([MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API), [W3C Push API](https://www.w3.org/TR/push-api/)). Firebase's `onRegistered` callback also fires on `pushsubscriptionchange` ([Firebase web client](https://firebase.google.com/docs/cloud-messaging/js/client)).
- A user can only revoke browser permission in the browser's UI. Cadence's "turn off" control should clear the token in Knock ([tutorial](https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm)).

## 3. What Cadence must add on its side

### Service worker

- **FCM:** "FCM requires a `firebase-messaging-sw.js` file". To start, an empty file at the domain root is enough ([Firebase web client](https://firebase.google.com/docs/cloud-messaging/js/client)). Background messages are customised with `onBackgroundMessage` in that file ([Firebase receive](https://firebase.google.com/docs/cloud-messaging/js/receive)).
- Knock's tutorial puts the worker at `public/firebase-messaging-sw.js`. The worker loads the Firebase compat scripts via `importScripts`, calls `firebase.initializeApp(config)` and `firebase.messaging()`, and is registered with scope `/`. The worker may need the Firebase config hard-coded, because it cannot read the app's build-time environment variables ([tutorial](https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm)). In React Router this maps to a static file under `public/`. **(inference: adapted from the tutorial's Next.js setup)**
- **OneSignal:** uses `OneSignalSDKWorker.js` (the file can be renamed). It should sit in its own subdirectory, e.g. `/push/onesignal/`, on the same origin. "Only one service worker can be active at a given scope." To merge it with an existing worker, `importScripts` the OneSignal script ([OneSignal service worker](https://documentation.onesignal.com/docs/en/onesignal-service-worker)).
- **General:** a page must have an active service worker to receive push ([MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)). On mobile, use `ServiceWorkerRegistration.showNotification()`, because the `Notification()` constructor throws on most mobile browsers ([MDN Using Notifications](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API)).

### VAPID keys

- **What they are:** `applicationServerKey` is an ECDSA P-256 public key. When it is set, every push must be authenticated with VAPID (a JWT signed with the matching private key) ([MDN PushManager.subscribe](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe), [W3C Push API](https://www.w3.org/TR/push-api/), which references RFC 8292).
- **With FCM:** generate the key pair in the Firebase console under Project settings > Cloud Messaging > Web configuration > Web Push certificates > "Generate Key Pair". An owner can also import an existing pair, base64url-encoded ([Firebase web client](https://firebase.google.com/docs/cloud-messaging/js/client)). **Firebase holds the private key.** Cadence ships only the public key to the browser. Knock never sees VAPID keys; it holds only the FCM service account ([FCM provider](https://docs.knock.app/integrations/push/firebase)).
- **With OneSignal:** OneSignal's setup page does not mention VAPID. The assumption is that OneSignal manages the keys **(unverified)** ([OneSignal web setup](https://documentation.onesignal.com/docs/en/web-push-setup)).
- **Firebase API change:** Firebase now marks the registration-token method (`getToken`) as "deprecated… will be removed in a future release" and recommends Firebase Installation IDs. With those, the VAPID key goes to `register()` and the ID arrives via `onRegistered`. Firebase also says not to mix the two APIs ([Firebase web client](https://firebase.google.com/docs/cloud-messaging/js/client)). Knock's tutorial still uses `getToken(messaging, { vapidKey, serviceWorkerRegistration })` ([tutorial](https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm)). Whether Knock's FCM provider can send to an Installation ID is **not documented**. See Open questions.

### Web app manifest

- **Required for iOS/iPadOS push:** the manifest's `display` must be `standalone` or `fullscreen`, and the user must add the site to the Home Screen ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)). On iOS 26+, a site added to the Home Screen opens as a web app by default, but the manifest still supplies the name, icons and start URL ([OneSignal iOS](https://documentation.onesignal.com/docs/en/web-push-for-ios)).
- The FCM web docs say nothing about a manifest or `gcm_sender_id` ([Firebase web client](https://firebase.google.com/docs/cloud-messaging/js/client)).

### HTTPS

- "The FCM SDK is supported only in pages served over HTTPS" ([Firebase web client](https://firebase.google.com/docs/cloud-messaging/js/client)).
- `PushManager` is `[SecureContext]`, and `subscribe()` rejects for non-https scopes ([W3C Push API](https://www.w3.org/TR/push-api/)). `Notification.requestPermission()` also requires a secure context ([MDN requestPermission](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static)).
- OneSignal lists HTTPS as a prerequisite ([OneSignal web setup](https://documentation.onesignal.com/docs/en/web-push-setup)).
- Notification click links must be HTTPS ([Firebase receive](https://firebase.google.com/docs/cloud-messaging/js/receive)).

### Permission prompt UX

- Request permission only in response to a user gesture, such as a button click. Firefox has enforced this since v72, and "Safari has done it for some time" ([MDN Using Notifications](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API), [MDN PushManager.subscribe](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe)). On iOS, a request that runs on page load or after a timer is not shown at all ([OneSignal iOS](https://documentation.onesignal.com/docs/en/web-push-for-ios)).
- Before prompting, feature-detect and check `Notification.permission`. If the user has denied, don't keep asking ([MDN requestPermission](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static)). On iOS, "Don't Allow" is final for that web app ([OneSignal iOS](https://documentation.onesignal.com/docs/en/web-push-for-ios)).
- Use a soft pre-prompt (an in-app explainer) before the native dialog ([OneSignal web setup](https://documentation.onesignal.com/docs/en/web-push-setup)).
- Use `userVisibleOnly: true`. Chrome and Edge reject subscriptions without it ([MDN PushManager.subscribe](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe)). Safari revokes subscriptions that receive silent pushes ([WebKit "Meet Web Push"](https://webkit.org/blog/12945/meet-web-push/)).
- Permission cannot be requested from cross-origin iframes in Chrome or Firefox ([MDN requestPermission](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static)).

## 4. Browser support and platform limits

- **Overall:** MDN lists the Push API as Baseline "Widely available… across browsers since March 2023" ([MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)). Firefox applies a quota to push messages that do not show a notification. Chrome has no such limit ([MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)).
- **macOS Safari:** Safari 16 on macOS Ventura+ uses standard Web Push. No Apple Developer Program membership is needed. If the server restricts push endpoints, allow `*.push.apple.com` ([WebKit "Meet Web Push"](https://webkit.org/blog/12945/meet-web-push/)).
- **iOS/iPadOS 16.4+:**
  - Push works only for Home Screen web apps with `display: standalone` or `fullscreen`.
  - Permission must be requested "in response to direct user interaction".
  - Push uses the standard Push, Notifications and Service Worker APIs. No Apple Developer account is needed.
  - Allow `*.push.apple.com` if push endpoints are restricted.
  - The Badging API is available.
  - Source: [WebKit 13878](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
  - A Safari, Chrome, Edge or Firefox tab on iOS cannot request permission, and iOS has no `beforeinstallprompt`, so Cadence must show its own "Share > Add to Home Screen" instructions ([OneSignal iOS](https://documentation.onesignal.com/docs/en/web-push-for-ios)).
- **Apple developer docs:** the "Sending web push notifications in web apps and browsers" page at developer.apple.com could not be fetched (it renders client-side). The WebKit blog posts above are the Apple-owned primary source instead.
- **FCM on Safari:** the FCM web SDK works "in browsers that support the Push API" ([Firebase web client](https://firebase.google.com/docs/cloud-messaging/js/client)). The fetched Firebase pages do not explicitly list Safari or iOS. Knock's tutorial does handle the iOS Home Screen case with an `isPWA()` check, which implies the FCM path works there ([tutorial](https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm)). **(Safari via FCM: unverified in the Firebase docs fetched)**

## 5. Knock plan and pricing gates

- **Free:** $0, up to 10,000 messages/month. **Starter:** $250/month + usage, 50,000 messages included, $0.005 per extra message. **Enterprise:** custom pricing ([knock.app/pricing](https://knock.app/pricing)).
- All plans list "Unlimited delivery channels" and unlimited environments ([knock.app/pricing](https://knock.app/pricing)).
- The pricing page does not mention push at all, so there is no stated push gate. **Confirm with Knock that push and FCM are available on Free (unverified).**
- FCM and OneSignal also have their own pricing, which is outside Knock and was not researched here.

## 6. Implications and recommendation for Cadence

**Recommendation: use Knock's FCM channel for Web Push.**

- It is the only browser-push path Knock documents end to end, with a tutorial ([tutorial](https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm)).
- Token deregistration works with it ([token deregistration](https://docs.knock.app/integrations/push/token-deregistration)).
- It supports the `devices` format with per-device locale and timezone ([device metadata](https://docs.knock.app/integrations/push/device-metadata)).
- It keeps the option of a future native app on the same channel, since FCM covers Android, iOS and web ([FCM provider](https://docs.knock.app/integrations/push/firebase)).

FCM vs OneSignal:

| | FCM via Knock | OneSignal via Knock |
|---|---|---|
| Web documented by Knock | Yes | No (unverified path) |
| Channel data | `tokens`/`devices`, which Cadence must merge per user | None in `external_id` mode |
| Token deregistration | Yes | Not in `external_id` mode |
| Service worker | `firebase-messaging-sw.js` at root | `OneSignalSDKWorker.js`, recommended in its own subfolder |
| Permission UI | Cadence builds it | OneSignal prompts (slidedown/pre-prompt) available |
| VAPID | Generated or imported in the Firebase console | Not documented (assumed managed) |
| Extra vendor | Google Firebase project | OneSignal account, plus OneSignal's own user model |

OneSignal is attractive because it handles the prompt UI and token bookkeeping for you. The trade-offs are an undocumented web path through Knock, no Knock-side deregistration in the recommended mode, and two places that model the user.

Further implications:

- **iOS reach is limited.** Push reaches iPhone and iPad users only after they install Cadence to the Home Screen. Cadence needs a manifest, icons and an install-instructions flow. Treat in-app notifications as the primary channel and Web Push as an enhancement.
- **Enhanced security mode** must be on in production. Cadence's server must mint Knock user JWTs, which are needed for the in-app feed anyway ([security](https://docs.knock.app/in-app-ui/security-and-authentication)).
- **Token merging** must be done in Cadence, because channel-data sets overwrite. A read-merge-write in the browser can race between two tabs or devices. Consider doing the merge server-side.
- **Deprecated `getToken()`:** Knock's tutorial relies on it. Plan an isolated token-acquisition module so it can be swapped for Installation IDs.

## What Cadence must add (checklist)

- [ ] Firebase project. Generate a Web Push certificate (VAPID key pair) in Cloud Messaging > Web configuration. Note the public key ([Firebase](https://firebase.google.com/docs/cloud-messaging/js/client)).
- [ ] Knock FCM push channel, configured per environment with the Firebase Project ID and the Service Account JSON. Turn on token deregistration and verify the toggle ([Knock FCM](https://docs.knock.app/integrations/push/firebase), [deregistration](https://docs.knock.app/integrations/push/token-deregistration)).
- [ ] `public/firebase-messaging-sw.js` with a hard-coded Firebase config and an `onBackgroundMessage` handler. Register it at scope `/` ([tutorial](https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm), [Firebase receive](https://firebase.google.com/docs/cloud-messaging/js/receive)).
- [ ] Web app manifest (`display: standalone`, name, icons, `start_url`) linked from the root layout ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)).
- [ ] HTTPS in every environment where push is tested. localhost is a secure context for development ([W3C Push API](https://www.w3.org/TR/push-api/)).
- [ ] Permission UX:
  - [ ] An "Enable notifications" button, with a pre-prompt explaining the value.
  - [ ] Feature detection, plus checks for `Notification.permission`.
  - [ ] Handling for `denied`.
  - [ ] Install-to-Home-Screen instructions for iOS.
  - Sources: [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API), [OneSignal iOS](https://documentation.onesignal.com/docs/en/web-push-for-ios).
- [ ] Token registration: get the FCM token and merge it into the user's existing Knock FCM channel data (`tokens` or `devices`) via `knock.user.setChannelData`, or via the server with `PUT /v1/users/{id}/channel_data/{channel_id}` ([API ref](https://docs.knock.app/api-reference/users/set_channel_data)).
- [ ] Re-register on `pushsubscriptionchange` / `onRegistered`. On user opt-out or logout, remove that device's token ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Push_API), [Firebase](https://firebase.google.com/docs/cloud-messaging/js/client)).
- [ ] Knock enhanced security mode, with server-signed user tokens ([security](https://docs.knock.app/in-app-ui/security-and-authentication)).
- [ ] A push step in Knock workflows. Use the `webpush` override for icon, badge and link, with HTTPS `fcm_options.link` targets ([Knock FCM](https://docs.knock.app/integrations/push/firebase), [Firebase receive](https://firebase.google.com/docs/cloud-messaging/js/receive)).
- [ ] If Cadence restricts outbound endpoints or CSP, allow FCM and `*.push.apple.com` ([WebKit](https://webkit.org/blog/12945/meet-web-push/)).

## Open questions

1. **Installation IDs:** Does Knock's FCM provider accept Firebase Installation IDs as `tokens`, now that Firebase deprecates `getToken()`? If not, what is Knock's migration plan? Ask Knock support.
2. **Deregistration default:** Is token deregistration on or off by default for a new FCM channel? Knock's docs contradict each other.
3. **OneSignal web through Knock:** Does Knock's OneSignal `external_id` mode deliver to OneSignal *web* subscriptions? Knock does not document it.
4. **Plan gating:** Is the push channel (FCM) available on Knock's Free plan? Pricing is silent on push.
5. **Product:** Are iOS users who won't install to the Home Screen acceptable as in-app-only? What share of Cadence traffic is iOS Safari?
6. **Multi-device and logout:** What happens to a shared browser's token when a different user logs in? Where should token merging live, client or server?
7. **Existing workers:** Will Cadence later need its own PWA service worker (offline, caching)? If so, plan how it coexists with `firebase-messaging-sw.js` at root scope.
8. **Overwrite semantics of the REST `PUT`:** the API reference does not state them. The "setting channel data" guide says sets overwrite. Verify in a dev environment.

## Sources

Knock
- https://docs.knock.app/integrations/push/overview
- https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm
- https://docs.knock.app/integrations/push/firebase
- https://docs.knock.app/integrations/push/one-signal
- https://docs.knock.app/integrations/push/token-deregistration
- https://docs.knock.app/integrations/push/device-metadata
- https://docs.knock.app/managing-recipients/setting-channel-data
- https://docs.knock.app/api-reference/users/set_channel_data
- https://docs.knock.app/in-app-ui/security-and-authentication
- https://docs.knock.app/concepts/channels
- https://raw.githubusercontent.com/knocklabs/javascript/main/packages/client/src/clients/users/index.ts
- https://knock.app/channels/push
- https://knock.app/pricing
- https://knock.app/changelog

Web platform / browsers
- https://www.w3.org/TR/push-api/ (W3C Working Draft, 11 November 2026)
- https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe
- https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static
- https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API
- https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- https://webkit.org/blog/12945/meet-web-push/
- https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers (could not be fetched; content rendered client-side; not relied on)

Firebase
- https://firebase.google.com/docs/cloud-messaging/js/client
- https://firebase.google.com/docs/cloud-messaging/js/receive

OneSignal
- https://documentation.onesignal.com/docs/en/web-push-setup
- https://documentation.onesignal.com/docs/en/onesignal-service-worker
- https://documentation.onesignal.com/docs/en/web-push-for-ios
- https://documentation.onesignal.com/docs/en/users
