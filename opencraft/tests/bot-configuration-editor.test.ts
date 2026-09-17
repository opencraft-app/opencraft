import assert from "node:assert/strict";
import test from "node:test";

import {
  botConfigurationHeaderState,
  botConfigurationControlState,
} from "../apps/workbench-web/src/components/bot-configuration-controls";

test("Bot model editor stays writable while the model catalog is loading", () => {
  assert.deepEqual(botConfigurationControlState({
    optionsLoading: true,
    busy: false,
    provider: "lightvela-custom-111-1yq8src",
    model: "deepseek-v4-flash-0731",
    hasProviderCatalog: false,
    hasModelCatalog: false,
  }), {
    providerControl: "input",
    modelControl: "input",
    inputsDisabled: false,
    saveDisabled: false,
  });
});

test("Bot model editor switches to catalog selects only after options settle", () => {
  assert.deepEqual(botConfigurationControlState({
    optionsLoading: false,
    busy: false,
    provider: "111",
    model: "deepseek-v4-flash-0731",
    hasProviderCatalog: true,
    hasModelCatalog: true,
  }), {
    providerControl: "select",
    modelControl: "select",
    inputsDisabled: false,
    saveDisabled: false,
  });
});

test("Bot model editor stays quiet while configuration and options are loading", () => {
  assert.equal(botConfigurationHeaderState({
    configurationLoading: true,
    optionsLoading: true,
    optionsError: null,
  }), "loading");
});

test("Bot model editor offers an icon retry only after catalog failure", () => {
  assert.equal(botConfigurationHeaderState({
    configurationLoading: false,
    optionsLoading: false,
    optionsError: "model.options timed out",
  }), "retry");
});
