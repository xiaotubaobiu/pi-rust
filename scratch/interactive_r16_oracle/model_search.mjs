// oracle for model-search.ts
import { getModelSearchText, getModelSelectorSearchText } from "file:///C:/Users/13063/Desktop/code/agent%20work/pi/packages/coding-agent/src/modes/interactive/model-search.ts";
const items = [
  { id: "gpt-5", provider: "openai" },
  { id: "gpt-5", provider: "openai", name: "GPT-5" },
  { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
  { id: "openai/gpt-5", provider: "openrouter" },
  { id: "", provider: "p" },
];
const out = [];
for (const item of items) {
  out.push({ search: getModelSearchText(item), selector: getModelSelectorSearchText(item) });
}
console.log(JSON.stringify(out, null, 2));
