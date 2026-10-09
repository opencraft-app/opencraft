export interface LayoutBox {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

export interface FloatingHeaderLayoutSample {
  content: LayoutBox;
  expectedHeaderHeight?: number;
  header: LayoutBox;
  overlays?: LayoutBox[];
  placement: "before" | "inside";
  stage: LayoutBox;
}

const tolerance = 1;

export function validateFloatingHeaderLayout(
  sample: FloatingHeaderLayoutSample,
): string[] {
  const errors: string[] = [];
  const expectedHeight = sample.expectedHeaderHeight ?? 52;
  if (
    sample.header.left <= sample.stage.left + tolerance ||
    sample.header.right >= sample.stage.right - tolerance
  ) {
    errors.push("header is not horizontally inset");
  }
  if (Math.abs(sample.header.height - expectedHeight) > tolerance) {
    errors.push("header height changed");
  }
  if (sample.content.top < sample.header.bottom - tolerance) {
    errors.push("content overlaps header");
  }
  if (sample.overlays?.some(overlay => overlay.top < sample.header.bottom - tolerance)) {
    errors.push("top overlay overlaps header");
  }
  if (
    sample.placement === "inside" &&
    (sample.header.top <= sample.stage.top + tolerance ||
      sample.header.bottom > sample.stage.bottom + tolerance)
  ) {
    errors.push("header is not inset inside stage");
  }
  if (
    sample.placement === "before" &&
    sample.header.bottom > sample.stage.top + tolerance
  ) {
    errors.push("header overlaps following stage");
  }
  return errors;
}

export function validateStableLayoutBox(before: LayoutBox, after: LayoutBox): string[] {
  const errors: string[] = [];
  if (Math.abs(before.top - after.top) > tolerance) errors.push("stage top changed");
  if (Math.abs(before.height - after.height) > tolerance) errors.push("stage height changed");
  return errors;
}
