import { useState } from "react";
import * as I from "../icons";
import { apiClient } from "../api/client";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function MissionControl() {
  const [goal, setGoal] = useState("");
  const [projectName, setProjectName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleCreateAndStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim() || !projectName.trim() || !workspacePath.trim()) return;
    setCreating(true);
    setError("");

    try {
      // 1. Create project
      const project = await apiClient.createProject(projectName, workspacePath);

      // 2. Create conversation
      const conv = await apiClient.createConversation(project.id, "Mission: " + goal.trim().slice(0, 60));

      // 3. Send the first message to start a real agent task
      await apiClient.sendMessage(conv.id, goal.trim(), { useMemory: true });
      setSubmitted(true);
    } catch (err: unknown) {
      setError(errorMessage(err, "Failed to start mission"));
    } finally {
      setCreating(false);
    }
  };

  // ── After submission — direct user to the conversation ────────────────
  if (submitted) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div className="topbar"><h1>Mission Started</h1></div>
        <div style={{ flex: 1, overflow: "auto", padding: "0 22px 22px", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="card" style={{ maxWidth: 520, textAlign: "center", padding: "32px 24px" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
            <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>Mission Submitted</h3>
            <p style={{ color: "var(--text-2)", fontSize: 14, margin: "0 0 20px", lineHeight: 1.6 }}>
              Your mission has been submitted to the agent. The agent will plan, execute, and verify — all visible in the conversation view.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button className="btn" onClick={() => { setSubmitted(false); setGoal(""); setProjectName(""); setWorkspacePath(""); }}>
                New Mission
              </button>
              <a href="/" className="btn btn-primary" style={{ textDecoration: "none" }} onClick={(e) => {
                e.preventDefault();
                // Navigate to projects view — the user can click the project to see the conversation
                window.location.href = "/";
              }}>
                View in Dashboard
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Mission creation form ─────────────────────────────────────────────
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className="topbar">
        <h1>New Mission</h1>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "0 22px" }}>
        <div style={{ maxWidth: 680, margin: "0 auto", paddingTop: 32 }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <I.IconAgentFace style={{ width: 44, height: 44, color: "var(--accent)", margin: "0 auto 14px", display: "block" }} />
            <h2 style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 600 }}>Start a Mission</h2>
            <p style={{ color: "var(--text-2)", fontSize: 14, maxWidth: 480, margin: "0 auto" }}>
              Describe what you want Morrow to accomplish. A real agent task will be created with planning, tool execution, evidence, and verification.
            </p>
          </div>

          <form onSubmit={handleCreateAndStart}>
            {error && <div className="error-message">{error}</div>}
            
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="mission-goal">What do you want to accomplish?</label>
                <textarea
                  id="mission-goal"
                  value={goal}
                  onChange={e => setGoal(e.target.value)}
                  placeholder="e.g., 'Summarize the architecture of this project' or 'Find and fix type errors in the web app'"
                  rows={4}
                  style={{ width: "100%", background: "var(--bg-elev)", border: "1px solid var(--border-2)", color: "var(--text)", padding: "12px 14px", borderRadius: "var(--radius-sm)", fontSize: 14, resize: "vertical", fontFamily: "inherit", lineHeight: 1.6 }}
                  required
                />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
              <div className="card">
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Project Name</label>
                  <input value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="My Project" required />
                </div>
              </div>
              <div className="card">
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Workspace Path</label>
                  <input value={workspacePath} onChange={e => setWorkspacePath(e.target.value)} placeholder="C:\Users\you\projects\repo" required />
                  <span className="hint">An existing directory. Morrow will only read/write within this path.</span>
                </div>
              </div>
            </div>

            <button type="submit" className="btn btn-primary btn-large" style={{ width: "100%", justifyContent: "center", padding: "14px" }} disabled={!goal.trim() || !projectName.trim() || !workspacePath.trim() || creating}>
              {creating ? "Creating project and starting agent…" : "Start Mission"}
            </button>
          </form>

          <div style={{ marginTop: 40, textAlign: "center", borderTop: "1px solid var(--border)", paddingTop: 28 }}>
            <p style={{ color: "var(--text-3)", fontSize: 13, margin: 0 }}>
              After starting a mission, visit the Missions view to inspect the agent's plan, tool calls, evidence, and verification.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
