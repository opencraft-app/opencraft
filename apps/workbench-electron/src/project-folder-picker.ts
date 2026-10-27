import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface ProjectFolderDialog {
  open(): Promise<{ canceled: boolean; filePaths: string[] }>;
}

/** Picker owns only a transient path selection, never the product catalog. */
export class ProjectFolderPicker {
  private flight: Promise<string | null> | null = null;
  constructor(private readonly dialog: ProjectFolderDialog) {}

  pick(): Promise<string | null> {
    if (this.flight) return this.flight;
    this.flight = (async () => {
      const result = await this.dialog.open();
      if (result.canceled || !result.filePaths.length) return null;
      const path = result.filePaths[0]!;
      if (!isAbsolute(path) || !(await stat(path)).isDirectory()) throw new Error("Select a valid project directory");
      return resolve(path);
    })().finally(() => { this.flight = null; });
    return this.flight;
  }
}
