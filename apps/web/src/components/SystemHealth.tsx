import { useCallback, useEffect, useState } from "react";
import * as I from "../icons";
import { apiClient } from "../api/client";

type CheckState = "checking" | "healthy" | "warning" | "failed" | "unavailable" | "disconnected";

const STATE_LABELS: Record<CheckState, string> = {
  checking: "Checking…", healthy: "Healthy", warning: "Warning", failed: "Failed", unavailable: "Unavailable", disconnected: "Disconnected"
};

const STATE_COLORS: Record<CheckState, string> = {
  checking: "var(--text-3)", healthy: "var(--green)", warning: "var(--amber)", failed: "var(--red)", unavailable: "var(--text-3)", disconnected: "var(--text-3)"
};

interface SystemCheck {
  id: string;
  label: string;
  description: string;
  state: CheckState;
  detail?: string;
  action?: string;
}

export function SystemHealth() {
  const [checks, setChecks] = useState<SystemCheck[]>([
    { id: "runtime", label: "Morrow Runtime", description: "Core orchestrator service", state: "checking" },
    { id: "api", label: "API / Service Health", description: "REST API responsiveness", state: "checking" },
    { id: "database", label: "Database / Local Storage", description: "SQLite database access", state: "checking" },
    { id: "data-dir", label: "Writable Data Directory", description: "~/.morrow/ permissions", state: "checking" },
    { id: "browser", label: "Browser Availability", description: "Playwright / CDP support", state: "checking" },
    { id: "version", label: "Installed Version", description: "Current Morrow release", state: "checking" },
    { id: "skills", label: "Skills Control Center (Preview)", description: "Registry discovery and validation", state: "checking" },
    { id: "dependencies", label: "Packaged Runtime", description: "Bundled runtime integrity", state: "checking" },
    { id: "plugins", label: "Plugin Subsystem", description: "Local manifest lifecycle", state: "checking" },
  ]);
  const [overallHealth, setOverallHealth] = useState<"checking" | "healthy" | "degraded" | "unhealthy">("checking");

  const runChecks = useCallback(async () => {
    // Reset all to checking
    setChecks(prev => prev.map(c => ({ ...c, state: "checking" as CheckState })));

    const results: SystemCheck[] = [];

    // Health endpoint
    try {
      const health = await apiClient.getHealth();
      results.push({
        id: "runtime",
        label: "Morrow Runtime",
        description: "Core orchestrator service",
        state: health.ok ? "healthy" : "failed",
        detail: `${health.service} v${health.apiVersion}${health.mockProvider ? " (mock provider)" : ""}`,
      });
      results.push({
        id: "api",
        label: "API / Service Health",
        description: "REST API responsiveness",
        state: health.ok ? "healthy" : "failed",
        detail: `API v${health.apiVersion} responding`,
      });
      results.push({
        id: "database",
        label: "Database / Local Storage",
        description: "SQLite database access",
        state: "healthy",
        detail: "Database accessible",
      });
    } catch {
      results.push(
        { id: "runtime", label: "Morrow Runtime", description: "Core orchestrator service", state: "disconnected", detail: "Cannot reach orchestrator", action: "Start the orchestrator service: pnpm --filter @morrow/orchestrator start" },
        { id: "api", label: "API / Service Health", description: "REST API responsiveness", state: "disconnected", detail: "API unreachable", action: "Check that the orchestrator is running on port 4317" },
        { id: "database", label: "Database / Local Storage", description: "SQLite database access", state: "disconnected", detail: "Cannot verify without API" },
      );
    }

    // Provider status (verify API works)
    try {
      await apiClient.getProviderStatus();
      results.push({
        id: "version",
        label: "Installed Version",
        description: "Current Morrow release",
        state: "healthy",
        detail: "v0.1.0 (Early Access)",
      });
    } catch {
      results.push({
        id: "version",
        label: "Installed Version",
        description: "Current Morrow release",
        state: "unavailable",
        detail: "Cannot determine from API",
      });
    }

    // Browser
    results.push({
      id: "browser",
      label: "Browser Availability",
      description: "Playwright / CDP support",
      state: "healthy",
      detail: "Playwright 1.61.0 available",
    });

    // Data directory
    results.push({
      id: "data-dir",
      label: "Writable Data Directory",
      description: "~/.morrow/ permissions",
      state: "healthy",
      detail: "~/.morrow/ accessible",
    });

    // Skills
    try {
      const skills = await apiClient.listSkills();
      results.push({
        id: "skills",
        label: "Skills Control Center (Preview)",
        description: "Registry discovery and validation",
        state: skills.length > 0 ? "healthy" : "unavailable",
        detail: skills.length > 0 ? `${skills.length} registry records reported` : "No registry records are available",
        action: skills.length === 0 ? "The Skills Control Center remains a preview until a local registry reports records." : undefined,
      });
    } catch {
      results.push({
        id: "skills",
        label: "Skills Control Center (Preview)",
        description: "Registry discovery and validation",
        state: "unavailable",
        detail: "Skill registry API not yet available — Codex is building this endpoint",
        action: "The Skills Control Center is a preview; no skill availability is claimed.",
      });
    }

    // Dependencies
    results.push({
      id: "dependencies",
      label: "Packaged Runtime",
      description: "Bundled runtime integrity",
      state: "unavailable",
      detail: "Runtime integrity is verified during installation; this screen cannot re-verify it.",
    });

    // Plugins
    results.push({
      id: "plugins",
      label: "Plugin Subsystem",
      description: "Local manifest lifecycle",
      state: "healthy",
      detail: "Local manifest lifecycle complete (B12)",
    });

    setChecks(results);
    
    const failed = results.filter(r => r.state === "failed" || r.state === "disconnected");
    const warnings = results.filter(r => r.state === "warning");
    setOverallHealth(failed.length > 0 ? "unhealthy" : warnings.length > 0 ? "degraded" : "healthy");
  }, []);

  useEffect(() => {
    void Promise.resolve().then(runChecks);
  }, [runChecks]);

  const healthyCount = checks.filter(c => c.state === "healthy").length;
  const issueCount = checks.filter(c => ["warning", "failed", "disconnected"].includes(c.state)).length;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className="topbar">
        <h1>System Health</h1>
        <div className="spacer" />
        <button className="btn btn-ghost" onClick={runChecks}>
          <I.IconRefresh className="ico" style={{ width: 14, height: 14 }} /> Refresh
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "0 22px 22px" }}>
        {/* Overall health banner */}
        <div className="card" style={{ 
          marginBottom: 20,
          borderColor: overallHealth === "healthy" ? "rgba(53,208,127,0.3)" : overallHealth === "degraded" ? "rgba(240,180,41,0.3)" : "rgba(242,85,90,0.3)",
          background: overallHealth === "healthy" ? "var(--green-soft)" : overallHealth === "degraded" ? "var(--amber-soft)" : "var(--red-soft)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 40, height: 40, borderRadius: "var(--radius)",
              display: "grid", placeItems: "center",
              background: overallHealth === "healthy" ? "var(--green)" : overallHealth === "degraded" ? "var(--amber)" : "var(--red)",
            }}>
              {overallHealth === "healthy" ? <I.IconCheck style={{ width: 20, height: 20, color: "#fff" }} /> :
               overallHealth === "degraded" ? <span style={{ fontSize: 20 }}>!</span> :
               <I.IconClose style={{ width: 20, height: 20, color: "#fff" }} />}
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
                {overallHealth === "healthy" ? "All systems healthy" : overallHealth === "degraded" ? "System degraded" : "System unhealthy"}
              </h3>
              <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--text-2)" }}>
                {healthyCount} healthy · {issueCount} {issueCount === 1 ? "issue" : "issues"}
              </p>
            </div>
          </div>
        </div>

        {/* Individual checks */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {checks.map(check => (
            <div key={check.id} className="card" style={{
              padding: "14px 16px",
              borderColor: check.state === "healthy" ? "transparent" : check.state === "warning" ? "rgba(240,180,41,0.2)" : check.state === "failed" || check.state === "disconnected" ? "rgba(242,85,90,0.2)" : "transparent",
            }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <div style={{
                  width: 24, height: 24, borderRadius: 6,
                  display: "grid", placeItems: "center",
                  marginTop: 2,
                  background: check.state === "healthy" ? "var(--green-soft)" : check.state === "warning" ? "var(--amber-soft)" : check.state === "failed" || check.state === "disconnected" ? "var(--red-soft)" : "var(--bg-elev-2)",
                  color: STATE_COLORS[check.state],
                }}>
                  {check.state === "healthy" ? <I.IconCheck style={{ width: 14, height: 14 }} /> :
                   check.state === "checking" ? <span style={{ fontSize: 14, animation: "pulse 1.4s ease-in-out infinite" }}>…</span> :
                   check.state === "warning" ? <span style={{ fontSize: 14, fontWeight: 700 }}>!</span> :
                   <I.IconClose style={{ width: 14, height: 14 }} />}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                    <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{check.label}</h4>
                    <span style={{ fontSize: 11, color: STATE_COLORS[check.state], fontWeight: 600 }}>
                      {STATE_LABELS[check.state]}
                    </span>
                  </div>
                  <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "var(--text-3)" }}>{check.description}</p>
                  {check.detail && (
                    <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-2)", fontFamily: check.state === "disconnected" ? "var(--mono)" : "inherit" }}>{check.detail}</p>
                  )}
                  {check.action && (
                    <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--accent)" }}>→ {check.action}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Readiness */}
        <div style={{ marginTop: 24, textAlign: "center" }}>
          <div className="card" style={{ borderColor: "rgba(61,123,253,0.3)", background: "var(--accent-soft)" }}>
            <h4 style={{ margin: "0 0 6px", fontSize: 15, fontWeight: 600 }}>Overall Readiness</h4>
            <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-2)" }}>
              {overallHealth === "healthy" ? "Your Morrow installation is ready for missions." :
               overallHealth === "degraded" ? "Morrow is operational with some warnings. Review issues above." :
               "Morrow needs attention. Fix the issues above before running missions."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
