/** Local draft and request state. Server identity and validation remain in the account SDK. */
export type AccountEditorState = {
  readonly baselineName: string;
  readonly name: string;
  readonly phone: string;
  readonly code: string;
  readonly cooldown: number;
  readonly pending: { readonly id: number; readonly kind: "code" | "save"; readonly input: string } | null;
  readonly error: string | null;
};

export type AccountEditorAction =
  | { type: "server-name"; name: string }
  | { type: "name"; value: string }
  | { type: "phone"; value: string }
  | { type: "code"; value: string }
  | { type: "tick" }
  | { type: "request-start"; id: number; kind: "code" | "save"; input: string }
  | { type: "request-success"; id: number; cooldown?: number }
  | { type: "request-failure"; id: number; error: string }
  | { type: "error"; error: string | null };

export function createAccountEditorState(name: string): AccountEditorState {
  return { baselineName: name, name, phone: "", code: "", cooldown: 0, pending: null, error: null };
}

export function accountEditorTransition(state: AccountEditorState, action: AccountEditorAction): AccountEditorState {
  switch (action.type) {
    case "server-name": return {
      ...state, baselineName: action.name,
      name: state.name === state.baselineName ? action.name : state.name,
    };
    case "name": return { ...state, name: action.value, error: null };
    case "phone": return state.phone === action.value ? state : { ...state, phone: action.value, code: "", cooldown: 0, error: null };
    case "code": return { ...state, code: action.value, error: null };
    case "tick": return state.cooldown > 0 ? { ...state, cooldown: state.cooldown - 1 } : state;
    case "request-start": return state.pending ? state : { ...state, pending: { id: action.id, kind: action.kind, input: action.input }, error: null };
    case "request-success":
      if (state.pending?.id !== action.id) return state;
      return { ...state, pending: null, cooldown: state.pending.kind === "code" && state.phone === state.pending.input
        ? Math.max(0, action.cooldown ?? 0) : state.cooldown };
    case "request-failure": return state.pending?.id === action.id ? { ...state, pending: null, error: action.error } : state;
    case "error": return { ...state, error: action.error };
  }
}
