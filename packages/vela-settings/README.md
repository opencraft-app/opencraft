# vela-settings

`vela-settings` is the small settings model for Vela apps.

The core idea is intentionally plain: a setting is an object with `load`, `save`,
and a `control` hint. The package does not know whether a value comes from local
JSON, a host bridge, velad, or TanStack Query.

```ts
import type { VelaSetting } from "./src";

export const themeSetting: VelaSetting<string> = {
  id: "appearance.theme",
  title: "Theme",
  description: "Choose the app appearance",
  control: "select",
  options: [
    { label: "Light", value: "light" },
    { label: "Dark", value: "dark" },
  ],
  load: () => "light",
  save: async (value) => {
    // Write to local JSON, host API, velad, or any app-owned storage.
  },
};
```

## Rules for future agents

- Keep this package dependency-light.
- Do not import Electron, velad clients, TanStack Query, app shells, or CSS here.
- Put concrete persistence in the app-level `load` and `save` functions.
- Use namespaced ids such as `appearance.theme`, `runtime.defaultBackend`, or
  `chat.defaultModel`.
- Keep simple settings immediate-save.
- Do not add form, dirty state, apply, or cancel behavior until a real multi-field
  setting needs it.

## Mental model

```text
VelaSetting
  id/title/description/control/options
  load()
  save()

App setting object
  decides where load/save read and write

UI row
  calls useVelaSetting(setting)
  renders the requested control
```

