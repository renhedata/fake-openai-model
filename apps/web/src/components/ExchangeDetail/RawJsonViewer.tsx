import { memo } from "react";
import { CopyButton } from "../Atoms";
import { safeStringify } from "../../utils";

const JsonBlock = memo(function JsonBlock({
  title,
  label,
  data,
}: {
  title: string;
  label?: string;
  data: unknown;
}) {
  return (
    <div className="flex flex-col min-h-0 min-w-0">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-base-content/30">
        <span>{title}</span>
        {label && (
          <span className="rounded bg-primary/10 px-1 py-0 text-[9px] text-primary/60">
            {label}
          </span>
        )}
        <CopyButton text={safeStringify(data)} />
      </div>
      <pre className="flex-1 overflow-auto rounded-lg bg-base-300 p-3 text-[11px] text-base-content/60 mono leading-relaxed max-w-full whitespace-pre-wrap break-words">
        {safeStringify(data)}
      </pre>
    </div>
  );
});

export const RawJsonViewer = memo(function RawJsonViewer({
  requestBody,
  translatedRequestBody,
  responseBody,
  translatedResponseBody,
}: {
  requestBody: unknown;
  translatedRequestBody?: unknown;
  responseBody?: unknown;
  translatedResponseBody?: unknown;
}) {
  const hasTranslation = !!translatedRequestBody || !!translatedResponseBody;

  return (
    <details className="border-t border-base-content/5">
      <summary className="cursor-pointer px-4 py-2 text-[11px] text-base-content/30 hover:text-base-content/50 select-none transition-colors flex items-center gap-2">
        查看原始请求 / 响应 JSON
        {hasTranslation && (
          <span className="rounded bg-primary/10 px-1.5 py-0 text-[9px] text-primary/70">
            含翻译
          </span>
        )}
      </summary>

      <div className="p-4 space-y-4">
        {/* Request section */}
        <div
          className="grid gap-4 min-w-0"
          style={{
            gridTemplateColumns: !!translatedRequestBody ? "1fr 1fr" : "1fr",
          }}
        >
          <JsonBlock title="原始请求" data={requestBody} />
          {!!translatedRequestBody && (
            <JsonBlock
              title="翻译后请求"
              label="Claude"
              data={translatedRequestBody}
            />
          )}
        </div>

        {/* Response section */}
        <div
          className="grid gap-4 min-w-0"
          style={{
            gridTemplateColumns: !!translatedResponseBody ? "1fr 1fr" : "1fr",
          }}
        >
          <JsonBlock title="原始响应" data={responseBody} />
          {!!translatedResponseBody && (
            <JsonBlock
              title="翻译后响应"
              label="OpenAI"
              data={translatedResponseBody}
            />
          )}
        </div>
      </div>
    </details>
  );
});
