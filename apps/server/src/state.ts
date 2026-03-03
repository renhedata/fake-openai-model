export type PromptRecord = {
  id: string;
  content: string;
  promptTokens: number;
  createdAt: string;
};

export type PromptStats = {
  totalPrompts: number;
  totalPromptTokens: number;
};

const capturedPrompts: PromptRecord[] = [];
const listeners = new Set<(latest: PromptRecord, items: PromptRecord[], stats: PromptStats) => void>();

const estimatePromptTokens = (value: string) => Math.max(1, Math.ceil(value.length / 4));

export const addPrompt = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const latest: PromptRecord = {
    id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    content: trimmed,
    promptTokens: estimatePromptTokens(trimmed),
    createdAt: new Date().toISOString()
  };

  capturedPrompts.unshift(latest);
  if (capturedPrompts.length > 100) {
    capturedPrompts.length = 100;
  }
  const snapshot = [...capturedPrompts];
  const stats = getPromptStats();
  listeners.forEach((listener) => listener(latest, snapshot, stats));
  return latest;
};

export const getPrompts = () => capturedPrompts;

export const getPromptStats = (): PromptStats => ({
  totalPrompts: capturedPrompts.length,
  totalPromptTokens: capturedPrompts.reduce((sum, item) => sum + item.promptTokens, 0)
});

export const subscribePromptAdded = (listener: (latest: PromptRecord, items: PromptRecord[], stats: PromptStats) => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
