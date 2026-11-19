import { evaluateButlerCase } from "./butler-session.mjs";
process.once("message", async (options) => {
  try {
    const evidence = await evaluateButlerCase(options);
    process.send({ state: evidence.state }, () => process.disconnect());
  } catch (error) {
    process.send({ state: "failed", error: error.message }, () => process.disconnect());
    process.exitCode = 1;
  }
});
