import { Bot } from "lucide-react";
import openai from "@lobehub/icons-static-svg/icons/openai.svg?url";
import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg?url";
import claude from "@lobehub/icons-static-svg/icons/claude.svg?url";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek.svg?url";
import google from "@lobehub/icons-static-svg/icons/google.svg?url";
import gemini from "@lobehub/icons-static-svg/icons/gemini.svg?url";
import ollama from "@lobehub/icons-static-svg/icons/ollama.svg?url";
import qwen from "@lobehub/icons-static-svg/icons/qwen.svg?url";
import { presentationBrand } from "./brand-presentation";

const assets = { openai, anthropic, claude, deepseek, google, gemini, ollama, qwen };
/** Decorative brand only. Never used to choose an endpoint or model ID. */
export function BrandIcon({ id, model = false }: { id: string; model?: boolean }) {
  const brand = presentationBrand(id, model);
  if (!brand) return <Bot size={18} aria-hidden="true" />;
  return <span aria-hidden="true" className="agent-brand-icon" style={{
    maskImage: `url("${assets[brand]}")`, WebkitMaskImage: `url("${assets[brand]}")`,
  }} />;
}
