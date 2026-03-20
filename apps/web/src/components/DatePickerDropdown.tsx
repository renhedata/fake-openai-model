import { useCallback, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const p2 = (n: number) => String(n).padStart(2, "0");
const toDateStr = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

export interface DatePickerDropdownProps {
  dateFrom: string;
  dateTo: string;
  setDateFrom: (v: string) => void;
  setDateTo: (v: string) => void;
  presets: { label: string; from: string; to: string }[];
  activePresetLabel: string | null;
  applyPreset: (from: string, to: string) => void;
  clearDateFilter: () => void;
  close: () => void;
  hasDateFilter: boolean;
}

export const DatePickerDropdown = ({
  dateFrom, dateTo, setDateFrom, setDateTo,
  presets, applyPreset, clearDateFilter, close, hasDateFilter,
}: DatePickerDropdownProps) => {
  const today = useMemo(() => new Date(), []);
  const todayStr = useMemo(() => toDateStr(today), [today]);

  const [viewYear, setViewYear] = useState(() => {
    if (dateFrom) { const [y] = dateFrom.split("-"); return Number(y); }
    return today.getFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    if (dateFrom) { const parts = dateFrom.split("-"); return Number(parts[1]) - 1; }
    return today.getMonth();
  });
  const [pickStart, setPickStart] = useState<string | null>(null);
  const [hoverDate, setHoverDate] = useState<string | null>(null);

  const prevMonth = useCallback(() => {
    setViewMonth((m) => { if (m === 0) { setViewYear((y) => y - 1); return 11; } return m - 1; });
  }, []);
  const nextMonth = useCallback(() => {
    setViewMonth((m) => { if (m === 11) { setViewYear((y) => y + 1); return 0; } return m + 1; });
  }, []);

  const calendarDays = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1);
    const startDow = firstDay.getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const cells: { date: string; day: number; inMonth: boolean }[] = [];
    if (startDow > 0) {
      const prevDays = new Date(viewYear, viewMonth, 0).getDate();
      for (let i = startDow - 1; i >= 0; i--) {
        const d = prevDays - i;
        const m = viewMonth === 0 ? 11 : viewMonth - 1;
        const y = viewMonth === 0 ? viewYear - 1 : viewYear;
        cells.push({ date: `${y}-${p2(m + 1)}-${p2(d)}`, day: d, inMonth: false });
      }
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: `${viewYear}-${p2(viewMonth + 1)}-${p2(d)}`, day: d, inMonth: true });
    }
    const remaining = 42 - cells.length;
    for (let d = 1; d <= remaining; d++) {
      const m = viewMonth === 11 ? 0 : viewMonth + 1;
      const y = viewMonth === 11 ? viewYear + 1 : viewYear;
      cells.push({ date: `${y}-${p2(m + 1)}-${p2(d)}`, day: d, inMonth: false });
    }
    return cells;
  }, [viewYear, viewMonth]);

  const handleDayClick = useCallback((dateStr: string) => {
    if (!pickStart) {
      setPickStart(dateStr);
      setDateFrom(dateStr);
      setDateTo(dateStr);
    } else {
      if (dateStr < pickStart) {
        setDateFrom(dateStr);
        setDateTo(pickStart);
      } else {
        setDateFrom(pickStart);
        setDateTo(dateStr);
      }
      setPickStart(null);
      setHoverDate(null);
    }
  }, [pickStart, setDateFrom, setDateTo]);

  const rangeStart = useMemo(() => {
    if (pickStart && hoverDate) return pickStart < hoverDate ? pickStart : hoverDate;
    return dateFrom || null;
  }, [pickStart, hoverDate, dateFrom]);

  const rangeEnd = useMemo(() => {
    if (pickStart && hoverDate) return pickStart > hoverDate ? pickStart : hoverDate;
    return dateTo || null;
  }, [pickStart, hoverDate, dateTo]);

  const isInRange = useCallback((d: string) => !!(rangeStart && rangeEnd && d >= rangeStart && d <= rangeEnd), [rangeStart, rangeEnd]);
  const isRangeStart = useCallback((d: string) => d === rangeStart, [rangeStart]);
  const isRangeEnd = useCallback((d: string) => d === rangeEnd, [rangeEnd]);

  const monthLabel = `${viewYear} 年 ${viewMonth + 1} 月`;
  const formatLabel = (d: string) => { const p = d.split("-"); return `${p[1]}/${p[2]}`; };

  return (
    <div className="absolute left-0 top-full mt-1.5 z-50 rounded-xl border border-base-content/10 bg-base-100 shadow-xl shadow-base-content/5 animate-fade-slide-in w-[300px]">
      {/* presets */}
      <div className="px-3 pt-3 pb-2 border-b border-base-content/5">
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => {
            const isActive = dateFrom === p.from && dateTo === p.to && !pickStart;
            return (
              <button
                key={p.label}
                type="button"
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-all duration-150 ${
                  isActive ? "bg-primary text-primary-content shadow-sm" : "text-base-content/55 hover:bg-base-content/5 hover:text-base-content/80"
                }`}
                onClick={() => {
                  applyPreset(p.from, p.to);
                  setPickStart(null);
                  setHoverDate(null);
                  const [y, m] = p.from.split("-");
                  setViewYear(Number(y));
                  setViewMonth(Number(m) - 1);
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* calendar */}
      <div className="p-3">
        <div className="flex items-center justify-between mb-2">
          <button type="button" className="p-1 rounded-md text-base-content/40 hover:text-base-content/70 hover:bg-base-content/5 transition-colors" onClick={prevMonth}>
            <ChevronLeft size={14} />
          </button>
          <span className="text-xs font-semibold text-base-content/70 select-none">{monthLabel}</span>
          <button type="button" className="p-1 rounded-md text-base-content/40 hover:text-base-content/70 hover:bg-base-content/5 transition-colors" onClick={nextMonth}>
            <ChevronRight size={14} />
          </button>
        </div>

        <div className="grid grid-cols-7 mb-0.5">
          {WEEKDAYS.map((w) => (
            <div key={w} className="text-center text-[9px] font-medium text-base-content/30 py-0.5 select-none">{w}</div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {calendarDays.map((cell, i) => {
            const inRange = isInRange(cell.date);
            const isStart = isRangeStart(cell.date);
            const isEnd = isRangeEnd(cell.date);
            const isToday = cell.date === todayStr;
            const isSingleDay = isStart && isEnd;
            return (
              <div
                key={i}
                className={`relative flex items-center justify-center ${
                  inRange && !isSingleDay
                    ? isStart ? "bg-primary/10 rounded-l-md" : isEnd ? "bg-primary/10 rounded-r-md" : "bg-primary/10"
                    : ""
                }`}
              >
                <button
                  type="button"
                  className={`
                    relative z-10 w-8 h-7 rounded-md text-[11px] font-medium transition-all duration-100 select-none
                    ${!cell.inMonth ? "text-base-content/15" : ""}
                    ${cell.inMonth && !inRange ? "text-base-content/70 hover:bg-base-content/8 hover:text-base-content" : ""}
                    ${inRange && !isStart && !isEnd ? "text-primary/80" : ""}
                    ${(isStart || isEnd) ? "bg-primary text-primary-content shadow-sm" : ""}
                    ${isToday && !isStart && !isEnd ? "ring-1 ring-primary/30 ring-inset" : ""}
                    ${pickStart ? "cursor-crosshair" : "cursor-pointer"}
                  `}
                  onClick={() => handleDayClick(cell.date)}
                  onMouseEnter={() => { if (pickStart) setHoverDate(cell.date); }}
                  onMouseLeave={() => { if (pickStart) setHoverDate(null); }}
                >
                  {cell.day}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* footer */}
      <div className="border-t border-base-content/5 px-3 py-2 flex items-center justify-between">
        {hasDateFilter && !pickStart ? (
          <>
            <button
              type="button"
              className="text-[10px] text-error/60 hover:text-error transition-colors flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-error/5"
              onClick={() => { clearDateFilter(); close(); }}
            >
              <X size={9} /> 清除
            </button>
            <span className="text-[10px] text-base-content/30 tabular-nums">
              {dateFrom && dateTo
                ? dateFrom === dateTo
                  ? formatLabel(dateFrom)
                  : `${formatLabel(dateFrom)} → ${formatLabel(dateTo)}`
                : dateFrom
                  ? `${formatLabel(dateFrom)} 起`
                  : `至 ${formatLabel(dateTo)}`}
            </span>
          </>
        ) : pickStart ? (
          <span className="text-[10px] text-primary/60 animate-live-pulse">点击第二个日期完成选择…</span>
        ) : (
          <span className="text-[10px] text-base-content/25">点击日期开始选择范围</span>
        )}
      </div>
    </div>
  );
};
