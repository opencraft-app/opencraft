import { installAssistantHostExtension } from '../../../../apps/personal-assistant/src/runtime/host-extension.mjs';
import { createWecomAssistantRuntime } from './assistant-runtime.mjs';
installAssistantHostExtension({createRuntime:createWecomAssistantRuntime});
