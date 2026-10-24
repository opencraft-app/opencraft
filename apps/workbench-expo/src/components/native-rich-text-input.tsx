import { forwardRef, useImperativeHandle, useRef } from "react";
import { TextInput, type TextInputProps } from "react-native";

export interface NativeRichTextInputHandle {
  focus(): void;
  blur(): void;
  setSelection(start: number, end: number): void;
}

/** Other platforms keep the controlled text projection and its format preview. */
export const NativeRichTextInput = forwardRef<NativeRichTextInputHandle, TextInputProps>(
  function NativeRichTextInput({ children: _children, ...props }, ref) {
    const input = useRef<TextInput>(null);
    useImperativeHandle(ref, () => ({
      focus: () => input.current?.focus(),
      blur: () => input.current?.blur(),
      setSelection: (start, end) => input.current?.setNativeProps({ selection: { start, end } }),
    }), []);
    return <TextInput {...props} ref={input} />;
  },
);
