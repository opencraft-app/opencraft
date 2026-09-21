import { ShellCommandClassifierService } from "./hypernode/shell-command-classifier.js";
const classifier = new ShellCommandClassifierService({});
/** Presentation classification only, never authorization of shell execution. */
export function classifyDshCommand(command: string, cwd: string) {
  return classifier.classify(command, { cwd });
}
