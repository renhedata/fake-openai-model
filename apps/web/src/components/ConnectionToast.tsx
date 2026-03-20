import { useEffect, useState } from "react";

export const ConnectionToast = ({ connected }: { connected: boolean }) => {
  const [show, setShow] = useState(false);
  const [wasConnected, setWasConnected] = useState(true);

  useEffect(() => {
    if (!connected && wasConnected) {
      setShow(true);
    } else if (connected && !wasConnected) {
      setShow(true);
      const t = setTimeout(() => setShow(false), 2500);
      return () => clearTimeout(t);
    }
    setWasConnected(connected);
  }, [connected, wasConnected]);

  if (!show) return null;

  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] animate-toast-in">
      <div className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur-sm ${
        connected
          ? "border-success/30 bg-success/10 text-success"
          : "border-error/30 bg-error/10 text-error"
      }`}>
        <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-success" : "bg-error animate-live-pulse"}`} />
        {connected ? "已重新连接" : "连接已断开，正在重连…"}
      </div>
    </div>
  );
};
