import { useState, useEffect } from "react";
import type { ProviderStatus } from "@morrow/contracts";
import { apiClient } from "../api/client";

// ── Types ─────────────────────────────────────────────────────────────────
type SetupRoute = "simple" | "advanced" | null;
type PermissionPreset = "safe" | "balanced" | "autonomous";

interface OnboardingHubProps {
  state: { onboarded: boolean; onboardingStep: string | null; useCase: string | null; name: string | null };
  providers: ProviderStatus[];
  onRefreshProviders: () => Promise<void>;
  onComplete: (projectId?: string) => void;
}

// ── Skill packs ───────────────────────────────────────────────────────────
const SKILL_PACKS = [
  { id: "dev", name: "Software Development", desc: "Coding, reviews, testing, debugging, git, refactoring", skills: ["coding", "code-review", "testing", "debugging", "git-inspection", "repository-inspection", "diagnostics", "linting", "documentation"] },
  { id: "browser", name: "Browser & Research", desc: "Web automation, search, academic papers, data extraction", skills: ["browser-automation", "browser-audit", "web-search", "arxiv"] },
  { id: "web", name: "Website Building", desc: "Astro sites, HTML/CSS prototyping, design systems, PDFs", skills: ["astro-site-dev", "claude-design", "popular-web-designs", "pdf-generation"] },
  { id: "files", name: "Files & Documents", desc: "File operations, OCR, templates, validation", skills: ["file-ops", "input-validation", "template-generator", "ocr"] },
  { id: "writing", name: "Writing & Content", desc: "Text humanization, PowerPoint, presentations", skills: ["humanizer", "powerpoint"] },
  { id: "security", name: "Security & Auditing", desc: "Secrets scanning, dependency audits, architecture review", skills: ["secrets-scan", "dependency-audit", "architecture-review", "config-management"] },
  { id: "productivity", name: "Personal Productivity", desc: "Obsidian notes, task management, email", skills: ["obsidian", "task-management", "file-ops"] },
];

export function OnboardingHub({ state, providers, onRefreshProviders, onComplete }: OnboardingHubProps) {
  const [step, setStep] = useState(0);
  const [route, setRoute] = useState<SetupRoute>(null);
  
  // Profile
  const name = state.name || "";
  const useCase = state.useCase || "";
  
  // Provider
  const [activeProv, setActiveProv] = useState("");
  const [testStatus, setTestStatus] = useState<{ status: "idle" | "testing" | "success" | "error"; message?: string; latencyMs?: number }>({ status: "idle" });
  
  // Permission
  const [permissionPreset, setPermissionPreset] = useState<PermissionPreset>("balanced");
  
  // Workspace
  const [projectName, setProjectName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [projectError, setProjectError] = useState("");
  const [projectSuccess, setProjectSuccess] = useState(false);
  const [createdProjectId, setCreatedProjectId] = useState<string>("");
  
  // Skills
  const [enabledPacks, setEnabledPacks] = useState<Set<string>>(new Set(["dev", "browser", "files"]));

  // Health checks
  const [healthOk, setHealthOk] = useState<boolean | null>(null);

  useEffect(() => {
    apiClient.getHealth().then(h => setHealthOk(h.ok)).catch(() => setHealthOk(false));
  }, []);

  const saveStep = (stepName: string) => {
    apiClient.saveOnboardingState({
      onboardingStep: stepName,
      name: name || undefined,
      useCase: useCase || undefined,
    }).catch(() => {});
  };

  const nextStep = () => {
    const stepNames = ["welcome", "system-check", "provider", "permissions", "workspace", "skills", "readiness"];
    saveStep(stepNames[step] || "welcome");
    setStep(s => s + 1);
  };
  const prevStep = () => setStep(s => Math.max(0, s - 1));

  const handleTestProvider = async (providerId: string) => {
    setTestStatus({ status: "testing" });
    try {
      const result = await apiClient.testProvider(providerId);
      if (result.ok) {
        setTestStatus({ status: "success", message: `Reachable! Latency: ${result.latencyMs}ms`, latencyMs: result.latencyMs });
        await onRefreshProviders();
      } else {
        setTestStatus({ status: "error", message: result.detail || "Connection failed" });
      }
    } catch (e: any) {
      setTestStatus({ status: "error", message: e.message || "Failed to test connection." });
    }
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setProjectError("");
    try {
      const p = await apiClient.createProject(projectName, workspacePath);
      setCreatedProjectId(p.id);
      setProjectSuccess(true);
    } catch (err: any) {
      setProjectError(err.message || "Failed to create project");
    }
  };

  const handleComplete = async () => {
    try {
      await apiClient.saveOnboardingState({ onboarded: true, onboardingStep: null, name, useCase });
      onComplete(createdProjectId);
    } catch { onComplete(createdProjectId); }
  };

  const togglePack = (packId: string) => {
    setEnabledPacks(prev => {
      const next = new Set(prev);
      if (next.has(packId)) next.delete(packId); else next.add(packId);
      return next;
    });
  };

  // ── Render steps ────────────────────────────────────────────────────────

  // Step 0: Welcome + Route Selection
  if (step === 0) {
    return (
      <div className="onboard-landing">
        <div className="brand-header">
          <div className="brand-mark-large">M</div>
          <h2>M O R R O W</h2>
          <div className="horizon-line" />
        </div>
        <h1>Private intelligence, built around you.</h1>
        <p className="onboard-desc">
          Morrow is a self-hosted AI agent that runs locally on your machine. 
          Your code, files, and conversations never leave your control.
        </p>
        <div style={{ display: "flex", gap: 16, marginBottom: 40, maxWidth: 600 }}>
          {/* Simple Setup */}
          <button
            className="card"
            onClick={() => { setRoute("simple"); nextStep(); }}
            style={{ flex: 1, cursor: "pointer", textAlign: "left", border: "1px solid var(--accent)", background: "var(--accent-soft)", padding: "24px 20px", borderRadius: "var(--radius-lg)" }}
          >
            <div style={{ fontSize: 24, marginBottom: 12 }}>🚀</div>
            <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 600, color: "var(--accent)" }}>Simple Setup</h3>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
              Quick start for normal users. Guided onboarding, sensible defaults, one-click provider setup.
            </p>
          </button>
          {/* Advanced Setup */}
          <button
            className="card"
            onClick={() => { setRoute("advanced"); nextStep(); }}
            style={{ flex: 1, cursor: "pointer", textAlign: "left", border: "1px solid var(--border-2)", padding: "24px 20px", borderRadius: "var(--radius-lg)" }}
          >
            <div style={{ fontSize: 24, marginBottom: 12 }}>⚙️</div>
            <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 600 }}>Advanced Setup</h3>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
              For developers, servers, Docker, custom endpoints, local models, security policies.
            </p>
          </button>
        </div>
        <div className="landing-principles">
          <div className="principle">
            <strong>Local Control</strong>
            <span>Your codebase never leaves your local containment boundaries.</span>
          </div>
          <div className="principle">
            <strong>Visible Execution</strong>
            <span>Every plan, tool call, and file access is inspectable and auditable.</span>
          </div>
        </div>
      </div>
    );
  }

  // Wizard steps
  const stepsList = [
    { num: 1, label: "System Check" },
    { num: 2, label: "Provider" },
    { num: 3, label: "Permissions" },
    { num: 4, label: "Workspace" },
    { num: 5, label: "Skills" },
    { num: 6, label: "Ready" },
  ];

  return (
    <div className="onboard-wizard-container">
      {/* Sidebar */}
      <div className="onboard-wizard-sidebar">
        <div className="brand" style={{ padding: "0 0 20px" }}>
          <div className="brand-mark">M</div>
          <div className="brand-name">Morrow</div>
        </div>
        <span style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          {route === "simple" ? "Simple Setup" : "Advanced Setup"}
        </span>
        <ul className="onboard-wizard-steps">
          {stepsList.map(s => {
            const isActive = step === s.num;
            const isCompleted = step > s.num;
            return (
              <li key={s.num} className={`onboard-wizard-step ${isActive ? "active" : ""} ${isCompleted ? "completed" : ""}`}>
                <span className="onboard-wizard-step-num">{isCompleted ? "✓" : s.num}</span>
                <span>{s.label}</span>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Content */}
      <div className="onboard-wizard-content">
        {/* Step 1: System Check */}
        {step === 1 && (
          <div>
            <h1>System Check</h1>
            <p className="subtitle">Verifying your Morrow installation before proceeding.</p>
            
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { id: "runtime", label: "Morrow Runtime", desc: "Core orchestrator service" },
                { id: "api", label: "API / Service Health", desc: "REST API responsiveness" },
                { id: "db", label: "Database", desc: "SQLite storage access" },
                { id: "data", label: "Data Directory", desc: "~/.morrow/ writable" },
                { id: "browser", label: "Browser Engine", desc: "Playwright / CDP support" },
                { id: "deps", label: "Dependencies", desc: "Node, pnpm, git" },
              ].map(item => {
                const isOk = healthOk !== false;
                return (
                  <div key={item.id} className="card" style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
                    <div style={{
                      width: 20, height: 20, borderRadius: 6,
                      display: "grid", placeItems: "center",
                      background: healthOk === null ? "var(--bg-elev-2)" : isOk ? "var(--green-soft)" : "var(--red-soft)",
                      color: healthOk === null ? "var(--text-3)" : isOk ? "var(--green)" : "var(--red)",
                    }}>
                      {healthOk === null ? "…" : isOk ? "✓" : "✕"}
                    </div>
                    <div style={{ flex: 1 }}>
                      <strong style={{ fontSize: 13 }}>{item.label}</strong>
                      <p style={{ margin: 0, fontSize: 12, color: "var(--text-3)" }}>{item.desc}</p>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, color: healthOk === null ? "var(--text-3)" : isOk ? "var(--green)" : "var(--red)" }}>
                      {healthOk === null ? "Checking…" : isOk ? "Healthy" : "Unavailable"}
                    </span>
                  </div>
                );
              })}
            </div>

            {healthOk === false && (
              <div className="card" style={{ marginTop: 16, borderColor: "rgba(240,180,41,0.3)", background: "var(--amber-soft)" }}>
                <strong style={{ color: "var(--amber)" }}>Orchestrator not detected</strong>
                <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-2)" }}>
                  The Morrow orchestrator service isn't running. Start it with:
                </p>
                <pre className="code-block" style={{ marginTop: 10 }}><code>pnpm --filter @morrow/orchestrator start</code></pre>
                <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-3)" }}>
                  You can continue setup and start the service later.
                </p>
              </div>
            )}

            {route === "advanced" && (
              <div className="card" style={{ marginTop: 16 }}>
                <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>Advanced: Custom Configuration</h4>
                <p className="muted" style={{ fontSize: 12 }}>
                  For Docker, custom ports, remote hosts, and headless operation — see the 
                  <span style={{ color: "var(--accent)", cursor: "pointer" }}> advanced installation docs</span>.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Step 2: Provider Setup */}
        {step === 2 && (
          <div>
            <h1>Connect a Model Provider</h1>
            <p className="subtitle">
              Morrow connects directly to model endpoints. Your API keys stay on your machine — never in the browser, database, or logs.
            </p>

            {route === "simple" ? (
              <>
                <div className="card alert-warn" style={{ marginBottom: 16, borderLeft: "4px solid var(--amber)", padding: 12, background: "var(--bg-panel)" }}>
                  <strong>Bring Your Own Key</strong>
                  <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
                    Consumer subscriptions (ChatGPT Plus, Claude Pro) are NOT API credits. Create API keys at each provider's developer console.
                  </p>
                </div>
                <div className="provider-grid">
                  {providers.filter(p => ["openai", "anthropic", "deepseek", "openrouter"].includes(p.id)).map(p => {
                    const isSelected = activeProv === p.id;
                    return (
                      <div key={p.id} 
                        className={`provider-card ${p.configured ? "ok" : ""} ${isSelected ? "selected" : ""}`}
                        style={{ cursor: "pointer", border: isSelected ? "1px solid var(--accent)" : undefined }}
                        onClick={() => { setActiveProv(p.id); setTestStatus({ status: "idle" }); }}
                      >
                        <div className="provider-card-head">
                          <strong>{p.label}</strong>
                          <span className={`badge ${p.configured ? "badge-ok" : "badge-muted"}`}>
                            {p.configured ? "Configured" : "Not configured"}
                          </span>
                        </div>
                        <div className="cap-row">
                          {p.capabilities.toolCalls && <span className="cap">tools</span>}
                          {p.capabilities.vision && <span className="cap">vision</span>}
                          {p.capabilities.local && <span className="cap local">local</span>}
                        </div>
                        {isSelected && (
                          <div className="provider-test-area" onClick={e => e.stopPropagation()} style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                            <p className="muted" style={{ fontSize: 11.5 }}>
                              Set <code style={{ fontSize: 11 }}>{p.id.toUpperCase()}_API_KEY</code> in your environment:
                            </p>
                            <pre className="code-block" style={{ marginTop: 8, padding: "8px 10px" }}>
                              <code style={{ fontSize: 11.5 }}>{p.id.toUpperCase()}_API_KEY=sk-...</code>
                            </pre>
                            <button type="button" className="btn btn-primary" style={{ marginTop: 10, width: "100%", justifyContent: "center" }}
                              onClick={() => handleTestProvider(p.id)} disabled={testStatus.status === "testing"}>
                              {testStatus.status === "testing" ? "Testing…" : "Test Connection"}
                            </button>
                            {testStatus.message && (
                              <div className={`test-result-msg ${testStatus.status}`} style={{ marginTop: 8, fontSize: 12 }}>
                                {testStatus.message}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Local option */}
                <div className="card" style={{ marginTop: 16 }}>
                  <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>
                    <span className="cap local" style={{ marginRight: 8 }}>local</span> 
                    Use a Local Model
                  </h4>
                  <p className="muted" style={{ fontSize: 12.5 }}>
                    Install <span className="codeword">ollama</span> and run a local model. Your data never leaves your machine. 
                    Set <code>OLLAMA_BASE_URL</code> if not running on the default port.
                  </p>
                </div>
              </>
            ) : (
              /* Advanced provider setup */
              <div>
                <p className="muted">All available providers. Configure any provider by setting its environment variable.</p>
                <div className="provider-grid" style={{ marginTop: 12 }}>
                  {providers.map(p => (
                    <div key={p.id} className={`provider-card ${p.configured ? "ok" : ""}`}>
                      <div className="provider-card-head">
                        <strong>{p.label}</strong>
                        <span className={`badge ${p.configured ? "badge-ok" : "badge-muted"}`}>
                          {p.configured ? "Configured" : p.authStatus}
                        </span>
                      </div>
                      <div className="provider-card-meta">
                        <span className="kv"><span className="k">Kind</span>{p.kind}</span>
                        <span className="kv"><span className="k">Endpoint</span>{p.endpointHost ?? p.endpointType}</span>
                      </div>
                      <div className="cap-row">
                        {p.capabilities.toolCalls && <span className="cap">tools</span>}
                        {p.capabilities.vision && <span className="cap">vision</span>}
                        {p.capabilities.streaming && <span className="cap">streaming</span>}
                        {p.capabilities.local && <span className="cap local">local</span>}
                      </div>
                      {p.setupHint && <p className="setup-hint">{p.setupHint}</p>}
                      <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }}
                        onClick={() => { setActiveProv(p.id); handleTestProvider(p.id); }}>
                        Test
                      </button>
                      {activeProv === p.id && testStatus.message && (
                        <div className={`test-result-msg ${testStatus.status}`} style={{ fontSize: 12, marginTop: 6 }}>
                          {testStatus.message}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 3: Permission Presets */}
        {step === 3 && (
          <div>
            <h1>Choose Your Permission Mode</h1>
            <p className="subtitle">This controls what Morrow can do without asking. You can customize individual permissions later.</p>
            
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {([
                { id: "safe", title: "Safe", desc: "Read and research automatically. Ask before modifying files, running commands, or external communication.", icon: "🛡️", color: "var(--green)" },
                { id: "balanced", title: "Balanced", desc: "Normal local development — read and write files freely. Ask before destructive actions, external calls, or security-sensitive operations.", icon: "⚖️", color: "var(--accent)" },
                { id: "autonomous", title: "Autonomous", desc: "Full execution within approved workspace boundaries. Only high-risk actions (secrets, destructive git, deployments) require approval.", icon: "🤖", color: "var(--amber)" },
              ] as const).map(mode => {
                const isSelected = permissionPreset === mode.id;
                return (
                  <button
                    key={mode.id}
                    className="card"
                    onClick={() => setPermissionPreset(mode.id)}
                    style={{
                      cursor: "pointer", textAlign: "left", padding: "18px 20px",
                      border: isSelected ? `1px solid ${mode.color}` : "1px solid var(--border)",
                      background: isSelected ? `color-mix(in srgb, ${mode.color} 8%, var(--bg-panel))` : "var(--bg-panel)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                      <span style={{ fontSize: 24 }}>{mode.icon}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <strong style={{ fontSize: 15, color: isSelected ? mode.color : "var(--text)" }}>{mode.title}</strong>
                          {isSelected && <span className="badge" style={{ color: mode.color, background: "transparent", border: `1px solid ${mode.color}33` }}>Selected</span>}
                        </div>
                        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>{mode.desc}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {route === "advanced" && (
              <div className="card" style={{ marginTop: 16 }}>
                <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>Advanced: Custom Permissions</h4>
                <p className="muted" style={{ fontSize: 12.5 }}>
                  You can customize individual tool permissions per agent from Settings → Permissions after setup.
                  Each permission can be set to Allow, Ask, or Deny.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Step 4: Workspace */}
        {step === 4 && (
          <div>
            <h1>Select Your Workspace</h1>
            <p className="subtitle">Point Morrow at a project folder. All file operations will be scoped inside this directory.</p>
            
            <form onSubmit={handleCreateProject} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {projectError && <div className="error-message">{projectError}</div>}
              {projectSuccess && (
                <div className="badge-ok" style={{ padding: 10, borderRadius: 6, fontWeight: 600, background: "var(--green-soft)", color: "var(--green)" }}>
                  ✓ Workspace registered successfully!
                </div>
              )}
              <div className="field">
                <label>Project Name</label>
                <input value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="My Project" required />
              </div>
              <div className="field">
                <label>Local Directory Path</label>
                <input value={workspacePath} onChange={e => setWorkspacePath(e.target.value)} placeholder={route === "simple" ? "C:\\Users\\you\\projects\\my-project" : "C:\\Users\\you\\projects\\repo"} required />
                <span className="hint">An existing local directory. Morrow will never read or write outside this path.</span>
              </div>
              <button type="submit" className="btn btn-primary" style={{ alignSelf: "flex-start" }} disabled={projectSuccess}>
                Register Workspace
              </button>
            </form>

            <div className="card" style={{ marginTop: 20, borderColor: "rgba(61,123,253,0.2)", background: "var(--accent-soft)" }}>
              <strong style={{ fontSize: 13 }}>Workspace Protection</strong>
              <ul className="bullet-list" style={{ marginTop: 8, gap: 4 }}>
                <li>All file reads and writes are confined to this directory.</li>
                <li>Secret files (.env, keys, credentials) are automatically rejected.</li>
                <li>Symlinks are resolved and validated — no traversal escapes.</li>
                <li>Every file access is logged to the audit trail.</li>
              </ul>
            </div>
          </div>
        )}

        {/* Step 5: Skills Packs */}
        {step === 5 && (
          <div>
            <h1>Choose Your Skills</h1>
            <p className="subtitle">Skills give Morrow domain-specific capabilities. You can add or remove skills anytime.</p>
            
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {SKILL_PACKS.map(pack => {
                const isEnabled = enabledPacks.has(pack.id);
                return (
                  <button
                    key={pack.id}
                    className="card"
                    onClick={() => togglePack(pack.id)}
                    style={{
                      cursor: "pointer", textAlign: "left", padding: "16px 18px",
                      border: isEnabled ? "1px solid var(--accent)" : "1px solid var(--border)",
                      background: isEnabled ? "var(--accent-soft)" : "var(--bg-panel)",
                      display: "flex", alignItems: "center", gap: 14,
                    }}
                  >
                    <input 
                      type="checkbox" 
                      checked={isEnabled} 
                      onChange={() => togglePack(pack.id)}
                      style={{ width: 18, height: 18, accentColor: "var(--accent)", cursor: "pointer" }}
                    />
                    <div style={{ flex: 1 }}>
                      <strong style={{ fontSize: 14 }}>{pack.name}</strong>
                      <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-3)" }}>{pack.desc}</p>
                      <div className="cap-row" style={{ marginTop: 6 }}>
                        {pack.skills.slice(0, 4).map(s => <span key={s} className="cap" style={{ fontSize: 10 }}>{s}</span>)}
                        {pack.skills.length > 4 && <span className="cap" style={{ fontSize: 10 }}>+{pack.skills.length - 4} more</span>}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <p style={{ marginTop: 16, fontSize: 12, color: "var(--text-3)", textAlign: "center" }}>
              You can manage all {enabledPacks.size > 0 ? `${[...enabledPacks].reduce((sum, id) => sum + (SKILL_PACKS.find(p => p.id === id)?.skills.length || 0), 0)}` : "0"} enabled skills in the Skills Control Center after setup.
            </p>
          </div>
        )}

        {/* Step 6: Final Readiness */}
        {step === 6 && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
            <h2>You're Ready</h2>
            <p className="subtitle" style={{ marginBottom: 32 }}>Morrow is configured and ready for your first mission.</p>
            
            <div className="card" style={{ maxWidth: 480, margin: "0 auto 24px", textAlign: "left" }}>
              <h4 style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Setup Summary</h4>
              <ul className="kv-list" style={{ gap: 8 }}>
                <li><span className="kk">Runtime</span><span className="vv" style={{ color: healthOk ? "var(--green)" : "var(--amber)" }}>{healthOk ? "Connected" : "Pending"}</span></li>
                <li><span className="kk">Provider</span><span className="vv">{testStatus.status === "success" ? `${activeProv} — Verified` : providers.filter(p => p.configured).length > 0 ? "Configured" : "Not configured yet"}</span></li>
                <li><span className="kk">Workspace</span><span className="vv">{projectSuccess ? projectName : "Not set"}</span></li>
                <li><span className="kk">Permissions</span><span className="vv" style={{ textTransform: "capitalize" }}>{permissionPreset}</span></li>
                <li><span className="kk">Skills</span><span className="vv">{enabledPacks.size} pack{enabledPacks.size !== 1 ? "s" : ""} enabled</span></li>
              </ul>
            </div>

            <button className="btn btn-primary btn-large" onClick={handleComplete} style={{ minWidth: 280 }}>
              Start Your First Mission
            </button>
            <p style={{ marginTop: 12, fontSize: 12, color: "var(--text-3)" }}>
              You can change any of these settings later in Settings.
            </p>
          </div>
        )}

        {/* Navigation buttons */}
        <div className="onboard-wizard-actions">
          {step > 1 && step < 6 && (
            <button className="btn btn-ghost" onClick={prevStep}>Back</button>
          )}
          {step === 1 && (
            <button className="btn btn-ghost" onClick={prevStep}>Back</button>
          )}
          {step < 6 && (
            <button className="btn btn-primary" onClick={nextStep}>
              {step === 2 ? "Skip for now" : "Next"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
