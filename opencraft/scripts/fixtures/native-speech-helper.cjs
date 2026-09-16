#!/usr/bin/env node
// Deliberately synthetic OS boundary for desktop integration QA. Never records.
const readline = require("node:readline");
const write = event => process.stdout.write(JSON.stringify(event) + "\n");
let meter, sequence = 0;
let transcriptSequence = 0;
const transcript = (utteranceId, phase, text) => write({ type: "utterance", utteranceId, sequence: ++transcriptSequence, phase, text });
if (process.argv.includes("--probe")) {
  write({ supported: true, available: true, authorization: "authorized", language: process.argv.at(-1),
    supportsOnDeviceRecognition: process.argv.at(-1).startsWith("en"),
    devices: [{ id: "fixture-a", name: "Synthetic microphone A" }, { id: "fixture-b", name: "Synthetic microphone B" }] });
  process.exit(0);
}
readline.createInterface({ input: process.stdin }).on("line", line => {
  const event = JSON.parse(line);
  if (event.type === "start") {
    write({ type: "status", phase: "listening", onDevice: event.language.startsWith("en") });
    transcript("first", "partial", "可被修订的临时结果");
    transcript("first", "final", "Native fixture");
    transcript("second", "partial", "第二片段猜测");
    transcript("second", "partial", "改变后的猜测");
    meter = setInterval(() => write({ type: "level", level: (sequence++ % 9 + 1) / 10 }), 50);
  } else if (event.type === "stop") {
    clearInterval(meter); write({ type: "status", phase: "transcribing" });
    setTimeout(() => { transcript("second", "final", "transcript"); transcript("second", "final", "transcript"); write({ type: "end" }); process.exit(0); }, 200);
  } else if (event.type === "cancel") {
    clearInterval(meter);
    transcript("second", "final", "Late canceled native speech"); write({ type: "end" }); process.exit(0);
  }
});
