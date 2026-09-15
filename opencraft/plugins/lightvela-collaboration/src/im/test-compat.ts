import assert from "node:assert/strict";
import { describe as nodeDescribe, it as nodeIt } from "node:test";
import { inspect } from "node:util";

const asymmetricKind = Symbol("asymmetric-kind");

type Asymmetric =
  | { [asymmetricKind]: "any"; constructor: Function }
  | { [asymmetricKind]: "object-containing"; value: Record<string, unknown> }
  | { [asymmetricKind]: "string-containing"; value: string };

type MockFunction<T extends (...args: any[]) => any> = T & {
  mock: { calls: Array<Parameters<T>> };
};

type Matcher = {
  not: Matcher;
  rejects: PromiseMatcher;
  resolves: PromiseMatcher;
  toBe(expected: unknown): void;
  toBeUndefined(): void;
  toEqual(expected: unknown): void;
  toHaveBeenCalled(): void;
  toHaveBeenCalledTimes(expected: number): void;
  toHaveBeenCalledWith(...expected: unknown[]): void;
  toHaveBeenNthCalledWith(call: number, ...expected: unknown[]): void;
  toHaveLength(expected: number): void;
  toMatchObject(expected: Record<string, unknown>): void;
  toThrow(expected?: string | RegExp | Function): void;
};

type PromiseMatcher = {
  toBe(expected: unknown): Promise<void>;
  toEqual(expected: unknown): Promise<void>;
  toMatchObject(expected: Record<string, unknown>): Promise<void>;
  toThrow(expected?: string | RegExp | Function): Promise<void>;
};

type ExpectFunction = ((actual: unknown) => Matcher) & {
  any(constructor: Function): Asymmetric;
  objectContaining(value: Record<string, unknown>): Asymmetric;
  stringContaining(value: string): Asymmetric;
};

function mockFn<T extends (...args: any[]) => any>(implementation?: T): MockFunction<T> {
  const calls: Array<Parameters<T>> = [];
  const mock = ((...args: Parameters<T>) => {
    calls.push(args);
    return implementation?.(...args);
  }) as MockFunction<T>;
  mock.mock = { calls };
  return mock;
}

function isAsymmetric(value: unknown): value is Asymmetric {
  return typeof value === "object" && value !== null && asymmetricKind in value;
}

function matches(actual: unknown, expected: unknown, partial = false): boolean {
  if (isAsymmetric(expected)) {
    if (expected[asymmetricKind] === "any") {
      if (expected.constructor === String) return typeof actual === "string";
      if (expected.constructor === Number) return typeof actual === "number";
      if (expected.constructor === Boolean) return typeof actual === "boolean";
      if (expected.constructor === Function) return typeof actual === "function";
      return typeof actual === "object" && actual instanceof expected.constructor;
    }
    if (expected[asymmetricKind] === "string-containing") {
      return typeof actual === "string" && actual.includes(expected.value);
    }
    return matches(actual, expected.value, true);
  }

  if (Object.is(actual, expected)) return true;
  if (actual instanceof Date && expected instanceof Date) {
    return actual.getTime() === expected.getTime();
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
    if (actual.length !== expected.length) return false;
    return expected.every((value, index) => matches(actual[index], value));
  }
  if (
    typeof actual === "object" &&
    actual !== null &&
    typeof expected === "object" &&
    expected !== null
  ) {
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    const expectedKeys = Object.keys(expectedRecord);
    if (!partial && Object.keys(actualRecord).length !== expectedKeys.length) return false;
    return expectedKeys.every(
      (key) => key in actualRecord && matches(actualRecord[key], expectedRecord[key], partial),
    );
  }
  return false;
}

function mockCalls(actual: unknown): unknown[][] {
  const calls = (actual as { mock?: { calls?: unknown[][] } })?.mock?.calls;
  assert.ok(Array.isArray(calls), "expected a function created by jest.fn()");
  return calls;
}

function format(value: unknown): string {
  return inspect(value, { depth: 6, sorted: true });
}

function verify(condition: boolean, inverted: boolean, message: string): void {
  if (inverted ? condition : !condition) throw new assert.AssertionError({ message });
}

function thrownValue(actual: unknown): unknown {
  if (typeof actual !== "function") return actual;
  try {
    actual();
  } catch (error) {
    return error;
  }
  return undefined;
}

function createMatchers(actual: unknown, inverted = false): Matcher {
  const matcher = {
    get not() {
      return createMatchers(actual, !inverted);
    },
    get rejects() {
      return promiseMatchers(actual, "rejects");
    },
    get resolves() {
      return promiseMatchers(actual, "resolves");
    },
    toBe(expected: unknown) {
      verify(Object.is(actual, expected), inverted, `expected ${format(actual)} to be ${format(expected)}`);
    },
    toBeUndefined() {
      verify(actual === undefined, inverted, `expected ${format(actual)} to be undefined`);
    },
    toEqual(expected: unknown) {
      verify(matches(actual, expected), inverted, `expected ${format(actual)} to equal ${format(expected)}`);
    },
    toHaveBeenCalled() {
      verify(mockCalls(actual).length > 0, inverted, "expected mock to have been called");
    },
    toHaveBeenCalledTimes(expected: number) {
      const count = mockCalls(actual).length;
      verify(count === expected, inverted, `expected mock call count ${count} to be ${expected}`);
    },
    toHaveBeenCalledWith(...expected: unknown[]) {
      const calls = mockCalls(actual);
      verify(
        calls.some((call) => matches(call, expected)),
        inverted,
        `expected a mock call matching ${format(expected)}; received ${format(calls)}`,
      );
    },
    toHaveBeenNthCalledWith(call: number, ...expected: unknown[]) {
      const calls = mockCalls(actual);
      verify(
        matches(calls[call - 1], expected),
        inverted,
        `expected mock call ${call} to match ${format(expected)}; received ${format(calls[call - 1])}`,
      );
    },
    toHaveLength(expected: number) {
      const length = (actual as { length?: unknown })?.length;
      verify(length === expected, inverted, `expected length ${format(length)} to be ${expected}`);
    },
    toMatchObject(expected: Record<string, unknown>) {
      verify(
        matches(actual, expected, true),
        inverted,
        `expected ${format(actual)} to match ${format(expected)}`,
      );
    },
    toThrow(expected?: string | RegExp | Function) {
      const error = thrownValue(actual);
      let condition = error !== undefined;
      if (condition && typeof expected === "string") {
        condition = String((error as Error)?.message ?? error).includes(expected);
      } else if (condition && expected instanceof RegExp) {
        condition = expected.test(String((error as Error)?.message ?? error));
      } else if (condition && typeof expected === "function") {
        condition = error instanceof expected;
      }
      verify(condition, inverted, `expected ${format(error)} to be a matching thrown error`);
    },
  } satisfies Matcher;
  return matcher;
}

function promiseMatchers(actual: unknown, mode: "rejects" | "resolves"): PromiseMatcher {
  const settle = async (): Promise<unknown> => {
    if (mode === "resolves") return await actual;
    try {
      await actual;
    } catch (error) {
      return error;
    }
    throw new assert.AssertionError({ message: "expected promise to reject" });
  };
  return {
    async toBe(expected) {
      createMatchers(await settle()).toBe(expected);
    },
    async toEqual(expected) {
      createMatchers(await settle()).toEqual(expected);
    },
    async toMatchObject(expected) {
      createMatchers(await settle()).toMatchObject(expected);
    },
    async toThrow(expected) {
      createMatchers(await settle()).toThrow(expected);
    },
  };
}

const expectFunction = ((actual: unknown) => createMatchers(actual)) as ExpectFunction;
expectFunction.any = (constructor) => ({ [asymmetricKind]: "any", constructor });
expectFunction.objectContaining = (value) => ({
  [asymmetricKind]: "object-containing",
  value,
});
expectFunction.stringContaining = (value) => ({
  [asymmetricKind]: "string-containing",
  value,
});

Object.assign(globalThis, {
  describe: nodeDescribe,
  expect: expectFunction,
  it: nodeIt,
  jest: { fn: mockFn },
});

declare global {
  var describe: typeof nodeDescribe;
  var expect: ExpectFunction;
  var it: typeof nodeIt;
  var jest: {
    fn: <T extends (...args: any[]) => any>(implementation?: T) => any;
  };
}

export {};
