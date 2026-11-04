const positiveNumber = (name, raw) => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
};

export function handsResources(environment = process.env) {
  const cpus = positiveNumber('OPENCRAFT_HANDS_CPUS', environment.OPENCRAFT_HANDS_CPUS ?? '4');
  const memoryBytes = positiveNumber('OPENCRAFT_HANDS_MEMORY_BYTES', environment.OPENCRAFT_HANDS_MEMORY_BYTES ?? String(8 * 1024 ** 3));
  if (!Number.isSafeInteger(memoryBytes)) throw new Error('OPENCRAFT_HANDS_MEMORY_BYTES must be a positive integer');
  const cpuMillis = cpus * 1000;
  if (!Number.isSafeInteger(cpuMillis)) throw new Error('OPENCRAFT_HANDS_CPUS must resolve to whole millicpus');
  return Object.freeze({ cpuMillis, memoryBytes });
}
