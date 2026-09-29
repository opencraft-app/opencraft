## stage
Android internal APK built and verified; ready for handoff without deployment.

## verified
- Expo prebuild generates the ignored Android project with application ID `dev.vela.workbench`, version code 1, and Gradle release signing with the generated development key.
- `expo config`, build matrix validation, Bash syntax, YAML parse, and Expo workspace TypeScript check pass.
- Android SDK platform 36, build-tools 36.0.0, NDK 27.1.12297006 and 27.0.12077973, and CMake 3.22.1 are installed locally.
- Tencent and Aliyun Maven mirrors respond for the required Kotlin artifacts; local Gradle init script enables them explicitly.
- Final Gradle `assembleRelease`, APK signature verification, SHA-256 check, package metadata, and offline bundle inspection passed.

## unverified
- Physical device installation and behavior.
- Physical Android device behavior and native LightVela login backend.
- Standalone GitHub Actions execution; its workflow is nested in mono2 until the OpenCraft subtree is mirrored.

## discard
- First Gradle cache is contaminated by Maven Central 429 responses; do not use it as evidence of source failure.
- The initial NDK error came from the missing second NDK version used by Unistyles.

## restore
- Task Pack: `docs/context/tasks/2026-09-29-opencraft-android-internal-apk.md`.
- Build script: `opencraft/apps/workbench-expo/scripts/build-android-apk.sh`.
- Current build uses `GRADLE_USER_HOME=/data/.cache/opencraft-gradle-cn` and `OPENCRAFT_ANDROID_USE_CN_MIRRORS=1`.
- Other agents' pre-existing edits to `opencraft/package.json` and `package-lock.json` must be preserved.

## next_action
Hand off `opencraft/apps/workbench-expo/release/OpenCraft-android-internal.apk` for device installation and keep external login validation explicit.
