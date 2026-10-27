import React, { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDownIcon } from "./action-icons";

/** Keep the native selection, keyboard and popup owner; share only the arrow. */
export const NativeSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function NativeSelect(props, ref) {
    const list = props.multiple || (props.size ?? 0) > 1;
    return <span className="ui-native-select" data-list={list || undefined}>
      <select {...props} ref={ref} />
      {list ? null : <ChevronDownIcon size={14} />}
    </span>;
  },
);
