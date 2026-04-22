import { memo, useMemo } from "react";
import type { ExchangeRecord } from "../../types";
import {
  extractMessages,
  buildResponseMarkdown,
  getCompletionTokens,
  getReasoningText,
} from "../../utils";
import { DetailHeader } from "./DetailHeader";
import { MetaBar } from "./MetaBar";
import { PromptPanel } from "./PromptPanel";
import { ResponsePanel } from "./ResponsePanel";
import { RawJsonViewer } from "./RawJsonViewer";

export const ExchangeDetail = memo(function ExchangeDetail({
  item,
  serial,
  onClose,
}: {
  item: ExchangeRecord;
  serial: number;
  onClose: () => void;
}) {
  const messages = useMemo(
    () => extractMessages(item.requestBody),
    [item.requestBody]
  );

  const completionTokens = getCompletionTokens(item.responseBody);
  const responseMd = buildResponseMarkdown(item.responseBody);
  const reasoningText = getReasoningText(item.responseBody);

  return (
    <div className="flex h-full flex-col">
      <DetailHeader item={item} serial={serial} onClose={onClose} />

      <div className="flex-1 overflow-y-auto">
        <MetaBar item={item} />

        {item.errorMessage && (
          <div className="mx-4 mt-3 rounded bg-error/10 px-3 py-1.5 text-xs text-error">
            {item.errorMessage}
          </div>
        )}

        {/* Prompt + Response side-by-side */}
        <div className="grid gap-0 lg:grid-cols-2">
          <PromptPanel messages={messages} prompt={item.prompt} />
          <ResponsePanel
            responseStatus={item.responseStatus}
            responseBody={item.responseBody}
            reasoningText={reasoningText}
            responseMd={responseMd}
          />
        </div>

        {/* Raw JSON with translation */}
        <RawJsonViewer
          requestBody={item.requestBody}
          translatedRequestBody={item.translatedRequestBody}
          responseBody={item.responseBody}
          translatedResponseBody={item.translatedResponseBody}
        />
      </div>
    </div>
  );
});
