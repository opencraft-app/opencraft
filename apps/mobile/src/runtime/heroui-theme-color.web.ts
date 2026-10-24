import { useCSSVariable } from "uniwind";

// Browser CSS Color 4 values need resolving before HeroUI's colorKit reads them.
const colors = new Map<string, string>();
let context: CanvasRenderingContext2D | null = null;
function browserColor(value: string): string {
  const cached = colors.get(value);
  if (cached) return cached;
  if (typeof document === "undefined") return value;
  if (!CSS.supports("color", value)) throw new Error("Invalid HeroUI theme color");
  if (!context) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    context = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!context) throw new Error("Browser color resolution unavailable");
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  const resolved = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
  if (colors.size >= 128) colors.clear();
  colors.set(value, resolved);
  return resolved;
}

export function useThemeColor(name: string): string;
export function useThemeColor<const T extends string[]>(names: T): { [K in keyof T]: string };
export function useThemeColor(name: string | string[]): string | string[] {
  const values = useCSSVariable((Array.isArray(name) ? name : [name]).map(color => `--color-${color}`));
  const resolved = values.map(value => browserColor(String(value ?? "")));
  return Array.isArray(name) ? resolved : resolved[0];
}
