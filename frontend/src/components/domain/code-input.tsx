import { useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  length?: number;
}

const normalizeCode = (value: string, length: number) => value.replace(/[^0-9]/g, "").slice(0, length);

export const CodeInput = ({ value, onChange, length = 6 }: CodeInputProps) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  const normalizedValue = useMemo(() => normalizeCode(value, length), [length, value]);
  const digits = useMemo(() => normalizedValue.split(""), [normalizedValue]);
  const activeIndex = Math.min(digits.length, length - 1);

  return (
    <div
      className="relative"
      role="group"
      aria-label="Verification code input"
      onClick={() => inputRef.current?.focus()}
    >
      <Input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="Verification code"
        value={normalizedValue}
        onChange={(event) => onChange(normalizeCode(event.target.value, length))}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        className="absolute inset-0 z-10 h-full w-full text-transparent caret-transparent selection:bg-transparent selection:text-transparent opacity-0"
      />

      <div className="flex gap-2">
        {Array.from({ length }, (_, index) => {
          const digit = digits[index] ?? "";
          const isActive = isFocused && index === activeIndex;

          return (
            <Input
              key={index}
              readOnly
              tabIndex={-1}
              aria-label={`Digit ${index + 1}`}
              value={digit}
              className={cn(
                "pointer-events-none h-11 w-11 text-center text-base [text-security:none]",
                isActive && "border-[var(--text-primary)] shadow-[0_0_0_1px_var(--text-primary)]",
              )}
            />
          );
        })}
      </div>
    </div>
  );
};
