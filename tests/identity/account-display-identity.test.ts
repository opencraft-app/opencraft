import assert from "node:assert/strict";
import test from "node:test";
import { maskAccountDisplayIdentity } from "../../plugins/builtin-agents/src/codex-accounts/identity.js";

test("account display masks mailbox and private domain in email-based labels", () => {
  for (const [input, expected] of [
    ["person@example.com", "p***on@e***.com"],
    ["a@b.co", "***a@***.co"],
    ["staff+alias@private.example.org", "s***as@p***.e***.org"],
    ["Team <person@example.com>", "Team <p***on@e***.com>"],
    ["person@example.com / other@example.com", "p***on@e***.com / o***er@e***.com"],
    ["用户@企业.中国", "***用户@企***.中国"],
    ["hello@localhost", "h***lo@l***"],
    ["错误：person@example.com", "错误：p***on@e***.com"],
    ["ab@example.com", "***ab@e***.com"],
    ["abc@example.com", "***bc@e***.com"],
    ["abcd@example.com", "a***cd@e***.com"],
    ["用户甲乙@example.com", "用***甲乙@e***.com"],
    ["Work account", "Work account"],
    ["", ""],
  ]) assert.equal(maskAccountDisplayIdentity(input!), expected);
});
