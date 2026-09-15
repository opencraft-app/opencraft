export function parseCommand(command: string | string[]): any[];
export function tokenizeShellWords(source: string): string[];
export function isSmallFormattingCommand(tokens: string[]): boolean;
export class ShellCommandClassifierService {
  constructor(ctx: object);
  parse(command: string | string[]): any[];
  classify(command: string | string[], options?: { cwd?: string }): any[];
}
