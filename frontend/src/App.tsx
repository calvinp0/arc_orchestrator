import "./App.css";
import { useState } from "react";
import Settings from "./components/Settings";
import Runs from "./components/Runs";

export default function App() {
  const [tab, setTab] = useState<"runs" | "settings">("runs");
  
  const switchToRuns = () => setTab("runs");
  
  return (
    <div className="app">
      <header className="tabs">
        <button onClick={() => setTab("runs")} className={tab === "runs" ? "active" : ""}>Runs</button>
        <button onClick={() => setTab("settings")} className={tab === "settings" ? "active" : ""}>Settings</button>
      </header>
      <main>{tab === "runs" ? <Runs /> : <Settings onSwitchToRuns={switchToRuns} />}</main>
    </div>
  );
}
