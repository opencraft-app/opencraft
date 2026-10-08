import { Fragment, forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import {
  TextInput,
  type TextInputChangeEvent,
  type TextInputProps,
} from "react-native";
import type { NativeRichTextInputHandle } from "./native-rich-text-input";

interface NativeHostHandle {
  focus(): void;
  blur(): void;
}

type NativeInputProps = Omit<TextInputProps, "children" | "value" | "defaultValue" | "onChangeText"> & {
  children: React.ReactNode;
  mostRecentEventCount: number;
  onChange(event: TextInputChangeEvent): void;
  ref: React.Ref<NativeHostHandle>;
};

// RN 0.86.3's Fabric shadow node accepts attributed Text children. The public
// iOS TextInput wrapper drops them, so this adapter forwards them to the same
// native multiline component without adding a second editor or native module.
const nativeModule = require("react-native/Libraries/Components/TextInput/RCTMultilineTextInputNativeComponent") as {
  readonly default: React.ComponentType<NativeInputProps>;
  readonly Commands: {
    focus(ref: NativeHostHandle): void;
    blur(ref: NativeHostHandle): void;
    setTextAndSelection(ref: NativeHostHandle, eventCount: number, value: string | null, start: number, end: number): void;
  };
};
const NativeMultilineInput = nativeModule.default;
const NativeCommands = nativeModule.Commands;
const TextAncestorContext = require("react-native/Libraries/Text/TextAncestorContext").default as React.Context<boolean>;
const TextInputState = require("react-native/Libraries/Components/TextInput/TextInputState").default as {
  currentlyFocusedInput(): NativeHostHandle | null;
  registerInput(ref: NativeHostHandle): void;
  unregisterInput(ref: NativeHostHandle): void;
  focusInput(ref: NativeHostHandle | null): void;
  blurInput(ref: NativeHostHandle | null): void;
};

export const NativeRichTextInput = forwardRef<NativeRichTextInputHandle, TextInputProps>(
  function NativeRichTextInput(props, ref) {
    const { children, value, onChange, onChangeText, onFocus, onBlur, ...rest } = props;
    const nativeRef = useRef<NativeHostHandle | null>(null);
    const plainRef = useRef<TextInput | null>(null);
    const [eventCount, setEventCount] = useState(0);
    const [attributedRevision, setAttributedRevision] = useState(0);
    const eventCountRef = useRef(0);
    const lastNativeText = useRef(value ?? "");
    const rich = children !== null && children !== undefined;

    // The attributed iOS host does not get the public TextInput wrapper's
    // controlled-text synchronization. Restore rejected edits and apply
    // programmatic Composer changes using the latest native event generation.
    useLayoutEffect(() => {
      if (!rich || !nativeRef.current || typeof value !== "string" || lastNativeText.current === value) return;
      NativeCommands.setTextAndSelection(nativeRef.current, eventCountRef.current, value, -1, -1);
      lastNativeText.current = value;
      // The native command temporarily uses default text attributes. Rebuild
      // the child shadow text so Fabric reapplies the Draft's marks.
      setAttributedRevision(revision => revision + 1);
    }, [eventCount, rich, value]);

    useImperativeHandle(ref, () => ({
      focus() {
        if (rich && nativeRef.current) NativeCommands.focus(nativeRef.current);
        else plainRef.current?.focus();
      },
      blur() {
        if (rich && nativeRef.current) NativeCommands.blur(nativeRef.current);
        else plainRef.current?.blur();
      },
      setSelection(start, end) {
        if (rich && nativeRef.current) NativeCommands.setTextAndSelection(nativeRef.current, eventCountRef.current, null, start, end);
        else plainRef.current?.setNativeProps({ selection: { start, end } });
      },
    }), [rich]);

    useLayoutEffect(() => {
      if (!rich || !nativeRef.current) return;
      const input = nativeRef.current;
      TextInputState.registerInput(input);
      return () => {
        TextInputState.unregisterInput(input);
        // Match RN TextInput's unmount path. unregisterInput only removes the
        // host from its Set; it does not clear the focused host or keyboard.
        if (TextInputState.currentlyFocusedInput() === input) {
          TextInputState.blurInput(input);
          NativeCommands.blur(input);
        }
      };
    }, [rich]);

    const handleChange = useCallback((event: TextInputChangeEvent) => {
      if (nativeRef.current) {
        // The parent may publish a new Draft synchronously. Record this native
        // generation first so its controlled write uses the matching count.
        lastNativeText.current = event.nativeEvent.text;
        eventCountRef.current = event.nativeEvent.eventCount;
        setEventCount(event.nativeEvent.eventCount);
      }
      onChange?.(event);
      onChangeText?.(event.nativeEvent.text);
    }, [onChange, onChangeText]);

    if (!rich) return <TextInput {...rest} onBlur={onBlur} onChange={onChange} onChangeText={onChangeText}
      onFocus={onFocus} ref={plainRef} value={value} />;

    // Text inside a native TextInput must become virtual text. Without the
    // ancestor context, RN renders a separate text view and Fabric treats it
    // as an inline attachment instead of editable attributed characters.
    return <TextAncestorContext value={true}>
      <NativeMultilineInput
        {...rest}
        multiline
        mostRecentEventCount={eventCount}
        onBlur={event => { TextInputState.blurInput(nativeRef.current); onBlur?.(event); }}
        onChange={handleChange}
        onFocus={event => { TextInputState.focusInput(nativeRef.current); onFocus?.(event); }}
        ref={nativeRef}
      ><Fragment key={attributedRevision}>{children}</Fragment></NativeMultilineInput>
    </TextAncestorContext>;
  },
);
