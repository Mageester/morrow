export function DownloadPage() {
  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      {/* Hero */}
      <div style={{ 
        textAlign: "center", padding: "80px 40px 60px",
        background: "linear-gradient(180deg, var(--bg-panel) 0%, var(--bg-content) 100%)",
        borderBottom: "1px solid var(--border)",
      }}>
        <div className="brand-mark-large" style={{ margin: "0 auto 24px" }}>M</div>
        <h1 style={{ fontSize: 36, fontWeight: 650, letterSpacing: "-0.02em", margin: "0 0 12px" }}>
          Install Morrow
        </h1>
        <p style={{ fontSize: 16, color: "var(--text-2)", maxWidth: 520, margin: "0 auto 32px", lineHeight: 1.6 }}>
          Morrow Early Access is distributed as source code. Clone the repository, build, and run — self-hosted, private, and under your control.
        </p>

        {/* Platform cards */}
        <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap", maxWidth: 800, margin: "0 auto" }}>
          {[
            { platform: "Windows", icon: "⊞", desc: "Via Git Bash / WSL", available: true, action: "Build from Source" },
            { platform: "Linux", icon: "🐧", desc: "Native + Docker (planned)", available: true, action: "Build from Source" },
            { platform: "macOS", icon: "🍎", desc: "Via Homebrew or source", available: false, action: "Not Yet Available" },
          ].map(p => (
            <div key={p.platform} className="card" style={{ 
              flex: 1, minWidth: 200, maxWidth: 260, textAlign: "center", padding: "24px 20px",
              opacity: p.available ? 1 : 0.55,
            }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>{p.icon}</div>
              <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>{p.platform}</h3>
              <p style={{ fontSize: 12.5, color: "var(--text-3)", margin: "0 0 16px" }}>{p.desc}</p>
              <span className={`badge ${p.available ? "badge-ok" : "badge-muted"}`} style={{ fontSize: 12 }}>
                {p.action}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Installation */}
      <div style={{ maxWidth: 740, margin: "0 auto", padding: "40px 22px" }}>
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 8px" }}>Installation</h2>
        <p style={{ color: "var(--text-2)", margin: "0 0 24px", fontSize: 14 }}>
          Morrow Early Access is distributed as source code. Clone, build, and start.
        </p>

        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Quick Start (Developer Preview)</h3>
          <pre className="code-block" style={{ margin: 0 }}>
            <code>{`# Clone the repository
git clone https://github.com/Mageester/morrow.git
cd morrow

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Start the orchestrator and web app
pnpm dev`}</code>
          </pre>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Verify Your Installation</h3>
          <pre className="code-block" style={{ margin: 0 }}>
            <code>{`# Run type checking
pnpm check

# Run all tests
pnpm test

# Start just the orchestrator
pnpm --filter @morrow/orchestrator start

# Start just the web app (development)
pnpm --filter @morrow/web dev`}</code>
          </pre>
        </div>

        <div className="card">
          <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Requirements</h3>
          <ul className="bullet-list" style={{ gap: 4 }}>
            <li>Node.js {">="} 22.0.0</li>
            <li>pnpm (installed via <code>corepack enable</code> or <code>npm install -g pnpm</code>)</li>
            <li>Git</li>
            <li>At least one model provider API key (OpenAI, Anthropic, DeepSeek, or OpenRouter)</li>
            <li>Optional: Ollama for fully local, private model inference</li>
          </ul>
        </div>

        {/* Advanced section */}
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: "40px 0 8px" }}>Advanced Installation</h2>
        <p style={{ color: "var(--text-2)", margin: "0 0 24px", fontSize: 14 }}>
          For power users — custom paths, Docker, headless operation, local models.
        </p>

        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Docker (Planned)</h3>
          <p className="muted" style={{ fontSize: 13 }}>
            Containerized deployment is planned for a future release. For now, clone the repository and run directly.
          </p>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Custom Configuration</h3>
          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            Morrow stores configuration in <code>~/.morrow/</code>. The following can be customized:
          </p>
          <ul className="bullet-list" style={{ gap: 4 }}>
            <li>Data directory: set <code>MORROW_HOME</code> to a custom path</li>
            <li>Orchestrator port: default 4317, configurable via environment</li>
            <li>Provider API keys: set as environment variables (<code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, etc.)</li>
            <li>Local models: install Ollama and set <code>OLLAMA_BASE_URL</code></li>
            <li>Browser: Playwright browsers are auto-installed on first use</li>
          </ul>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Release Information</h3>
          <ul className="kv-list" style={{ gap: 8 }}>
            <li><span className="kk">Version</span><span className="vv">0.1.0 (Early Access)</span></li>
            <li><span className="kk">Channel</span><span className="vv">Developer Preview</span></li>
            <li><span className="kk">Release date</span><span className="vv">June 2026</span></li>
            <li><span className="kk">License</span><span className="vv">All rights reserved</span></li>
          </ul>
        </div>

        <div className="card" style={{ borderColor: "rgba(240,180,41,0.3)", background: "var(--amber-soft)" }}>
          <h3 style={{ margin: "0 0 6px", fontSize: 15, color: "var(--amber)" }}>Early Access Limitations</h3>
          <ul className="bullet-list" style={{ gap: 4 }}>
            <li>No automated installer — clone and build from source</li>
            <li>No managed cloud browser support (local Playwright/CDP only)</li>
            <li>Sandboxed plugin runtime hooks are incomplete</li>
            <li>Write and terminal tools gated until safety boundaries ship</li>
            <li>Managed cloud deployment not yet available</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
