import "./App.css";
import { useEffect, useState } from "react";
import Settings from "./components/Settings";
import Runs from "./components/Runs";
import { shouldUseCompactLayout } from "./lib/layout";

export default function App() {
  const [tab, setTab] = useState<"runs" | "settings">("runs");
  const [isCompact, setIsCompact] = useState(() =>
    typeof window !== "undefined" ? shouldUseCompactLayout(window.innerWidth, window.innerHeight) : false,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleResize = () => {
      const next = shouldUseCompactLayout(window.innerWidth, window.innerHeight);
      setIsCompact((prev) => (prev === next ? prev : next));
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const switchToRuns = () => setTab("runs");

  return (
    <div className={`app${isCompact ? " compact" : ""}`}>
      <header className="tabs">
        <button onClick={() => setTab("runs")} className={tab === "runs" ? "active" : ""}>Runs</button>
        <button onClick={() => setTab("settings")} className={tab === "settings" ? "active" : ""}>Settings</button>
      </header>
      <main>{tab === "runs" ? <Runs /> : <Settings onSwitchToRuns={switchToRuns} />}</main>
    </div>
  );
}
