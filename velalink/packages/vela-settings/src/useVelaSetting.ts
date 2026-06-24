import React from "react";

import type { VelaSetting, VelaSettingState, VelaSettingStatus } from "./setting";

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

export function useVelaSetting<T>(setting: VelaSetting<T>): VelaSettingState<T> {
  const [value, setValueState] = React.useState<T | undefined>();
  const [status, setStatus] = React.useState<VelaSettingStatus>("loading");
  const [error, setError] = React.useState<Error | null>(null);

  const reload = React.useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const loaded = await setting.load();
      setValueState(loaded);
      setStatus("ready");
    } catch (loadError) {
      setError(toError(loadError));
      setStatus("error");
    }
  }, [setting]);

  React.useEffect(() => {
    let active = true;

    setStatus("loading");
    setError(null);
    Promise.resolve()
      .then(() => setting.load())
      .then((loaded) => {
        if (!active) {
          return;
        }
        setValueState(loaded);
        setStatus("ready");
      })
      .catch((loadError) => {
        if (!active) {
          return;
        }
        setError(toError(loadError));
        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, [setting]);

  const setValue = React.useCallback(
    async (nextValue: T) => {
      if (!setting.save) {
        setError(new Error(`Setting ${setting.id} is readonly`));
        setStatus("error");
        return;
      }

      setValueState(nextValue);
      setError(null);
      setStatus("saving");

      try {
        await setting.save(nextValue);
        setStatus("ready");
      } catch (saveError) {
        setError(toError(saveError));
        setStatus("error");
      }
    },
    [setting],
  );

  return {
    canSave: Boolean(setting.save),
    error,
    isLoading: status === "loading",
    isSaving: status === "saving",
    reload,
    setValue,
    status,
    value,
  };
}

