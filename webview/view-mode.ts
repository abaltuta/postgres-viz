export type IsolatedViewKind = "focus" | "calltree" | "radial";

export interface IsolatedViewPayload {
  mode: IsolatedViewKind;
  rootId: string;
}

export type ActiveViewMode<Matrix, View extends IsolatedViewPayload> =
  | typeof BASE_ACTIVE_MODE
  | { kind: "matrix"; matrix: Matrix }
  | { kind: "isolated"; view: View };

export type LeaveMode = "none" | "matrix" | "isolated";

export const BASE_ACTIVE_MODE = { kind: "base" } as const;

type CurrentMode = Pick<ActiveViewMode<unknown, IsolatedViewPayload>, "kind">;

export function transitionActiveMode<Matrix>(
  current: CurrentMode,
  event: { type: "enter-matrix"; matrix: Matrix },
): { state: { kind: "matrix"; matrix: Matrix }; leave: LeaveMode };
export function transitionActiveMode<View extends IsolatedViewPayload>(
  current: CurrentMode,
  event: { type: "enter-isolated"; view: View },
): { state: { kind: "isolated"; view: View }; leave: LeaveMode };
export function transitionActiveMode(
  current: CurrentMode,
  event: { type: "exit" },
): { state: typeof BASE_ACTIVE_MODE; leave: LeaveMode };
export function transitionActiveMode(
  current: CurrentMode,
  event:
    | { type: "enter-matrix"; matrix: unknown }
    | { type: "enter-isolated"; view: IsolatedViewPayload }
    | { type: "exit" },
): {
  state:
    | typeof BASE_ACTIVE_MODE
    | { kind: "matrix"; matrix: unknown }
    | { kind: "isolated"; view: IsolatedViewPayload };
  leave: LeaveMode;
} {
  const leave: LeaveMode = current.kind === "base" ? "none" : current.kind;
  if (event.type === "exit") return { state: BASE_ACTIVE_MODE, leave };
  if (event.type === "enter-matrix") {
    return {
      state: { kind: "matrix", matrix: event.matrix },
      leave: current.kind === "matrix" ? "none" : leave,
    };
  }
  return {
    state: { kind: "isolated", view: event.view },
    leave,
  };
}
