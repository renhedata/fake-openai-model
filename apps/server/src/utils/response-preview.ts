export const extractResponsePreview = (payload: unknown) => {
  if (typeof payload === "string") {
    return payload.slice(0, 300);
  }
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as {
    output_text?: string;
    choices?: Array<{ message?: { content?: string }; text?: string }>;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    error?: { message?: string };
  };
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.slice(0, 300);
  }
  const choiceContent = record.choices?.[0]?.message?.content;
  if (typeof choiceContent === "string" && choiceContent.trim()) {
    return choiceContent.slice(0, 300);
  }
  const choiceText = record.choices?.[0]?.text;
  if (typeof choiceText === "string" && choiceText.trim()) {
    return choiceText.slice(0, 300);
  }
  const outputText = record.output?.[0]?.content?.[0]?.text;
  if (typeof outputText === "string" && outputText.trim()) {
    return outputText.slice(0, 300);
  }
  const errorText = record.error?.message;
  if (typeof errorText === "string" && errorText.trim()) {
    return errorText.slice(0, 300);
  }
  return JSON.stringify(payload).slice(0, 300);
};
