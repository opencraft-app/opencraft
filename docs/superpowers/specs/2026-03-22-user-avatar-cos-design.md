# User Avatar COS Design

## Goal

Add first-class user avatars to `user-auth` and the frontend settings flow.

The system should:

- initialize avatars from QQ OAuth when available
- store avatars in our own Tencent COS bucket instead of relying on QQ URLs
- allow users to upload and replace avatars from the settings page
- serve avatar reads through `user-auth` as a temporary `302` redirect to a signed COS URL
- keep avatar uploads under `200KB`, with browser-side compression first

## Recommended Design

### Data model

Extend `user-auth` user profile data with:

- `avatar_object_key`: COS object key for the current avatar
- `avatar_source`: `oauth_qq` or `upload`
- `avatar_updated_at`: timestamp for the current avatar asset

Keep `oauth_identities.avatar_url` as the upstream QQ source of truth, but do not expose it directly as the primary frontend avatar URL.

### Backend behavior

- QQ OAuth sign-in:
  - continue reading QQ profile avatar URL
  - if the user has no locally managed avatar, fetch the QQ avatar and persist it to COS
  - write the COS object key into the user profile
- Profile APIs:
  - `GET /auth/profile` returns nickname plus avatar metadata such as `hasAvatar`
  - `PUT /auth/profile` updates nickname only
  - `PUT /auth/profile/avatar` accepts multipart image upload, validates size/type, stores to COS, updates user profile
  - `GET /auth/profile/avatar` returns `302` to a short-lived signed COS URL for the current avatar
- Session APIs:
  - `/auth/session` includes minimal avatar metadata so the app shell can render avatars

### Storage model

- COS bucket: `lightclawuser-1388575217`
- Objects stored under stable prefixes like `avatars/<user_id>/current.jpg`
- COS access stays server-side only
- Frontend never sees COS credentials

### Frontend behavior

- Settings page shows current avatar and nickname editor
- User can choose an image and the browser compresses it to `<=200KB` before upload
- Upload success refreshes local session/profile state
- Header/user menu can display the avatar using `/auth/profile/avatar`

## Why this design

- avoids depending on QQ image URLs for long-term stability
- keeps COS credentials server-side
- makes avatar display a stable product capability
- keeps the first version simple: one current avatar per user, no version history, no background image pipeline

## Explicit Non-Goals

- no multi-size avatar derivations
- no background async media processing pipeline
- no direct browser-to-COS upload
- no signed upload URLs
