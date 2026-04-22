import { memo } from "react";
import { CheckCircle2, Loader2, X, XCircle } from "lucide-react";
import { Badge } from "../Atoms";
import type { ExchangeRecord } from "../../types";

export const DetailHeader = memo(function DetailHeader({
  item,
  serial,
  onClose,
}: {
  item: ExchangeRecord;
  serial: number;
  onClose: () => void;
}) {
  const statusVariant =
    item.responseStatus === "success"
      ? "success"
      : item.responseStatus === "error"
        ? "error"
        : "warning";

  return (
    <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-base-content/5 bg-base-200/95 backdrop-blur px-4 py-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="mono text-[11px] text-base-content/30 select-none">
          #{serial}
        </span>
        <Badge variant={statusVariant}>
          {item.responseStatus === "success" ? (
            <CheckCircle2 size={9} />
          ) : item.responseStatus === "error" ? (
            <XCircle size={9} />
          ) : (
            <Loader2 size={9} className="animate-spin" />
          )}
          {item.responseStatus}
        </Badge>
        <span className="mono text-[11px] text-base-content/50 truncate">
          {item.model}
        </span>
      </div>
      <button
        className="btn btn-ghost btn-sm btn-circle h-6 w-6 min-h-0 shrink-0 transition-colors"
        onClick={onClose}
        type="button"
        title="关闭 (Esc)"
      >
        <X size={14} />
      </button>
    </div>
  );
});
