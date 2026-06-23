import { useCallback, useState } from "react";

export interface ControllableStateOptions<T> {
  defaultValue: T;
  value?: T;
  onChange?: (value: T) => void;
}

export function useControllableState<T>({
  defaultValue,
  onChange,
  value,
}: ControllableStateOptions<T>): [T, (nextValue: T | ((current: T) => T)) => void] {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const isControlled = value !== undefined;
  const currentValue = isControlled ? value : uncontrolledValue;

  const setValue = useCallback(
    (nextValue: T | ((current: T) => T)) => {
      const resolvedValue =
        typeof nextValue === "function"
          ? (nextValue as (current: T) => T)(currentValue)
          : nextValue;
      if (!isControlled) setUncontrolledValue(resolvedValue);
      onChange?.(resolvedValue);
    },
    [currentValue, isControlled, onChange],
  );

  return [currentValue, setValue];
}

