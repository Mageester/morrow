import { useState, useEffect } from "react";

const RELEASE_MANIFEST_URL = "https://github.com/Mageester/morrow/releases/latest/download/release-manifest.json";

interface Manifest {
  version: string;
  channel: string;
  releasedAt: string;
  artifacts: { platform: string; type: string; filename: string; size: number; sha256: string; url: string }[];
  installInstructions: { windows: string[] };
}

function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [manifestError, setManifestError] = useState("");

  useEffect(() => {
    fetch(RELEASE_MANIFEST_URL)
      .then(r => r.json())
      .then(setManifest)
      .catch(() => setManifestError("Release manifest not yet available — first release coming soon."));
  }, []);

  const windowsArtifact = manifest?.artifacts.find(a => a.platform === "windows-x64");

  return (
    <div style={{ background: "#0b0b0d", color: "#edeef1", fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif', minHeight: "100vh" }}>
      {/* Nav */}
      <nav style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 24px", borderBottom: "1px solid rgba(255,255,255,0.07)", maxWidth: 1200, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(150deg, #5a8dff, #3d7bfd 55%, #7a5cff)", display: "grid", placeItems: "center", color: "#fff", fontWeight: 800, fontSize: 14 }}>M</div>
          <span style={{ fontWeight: 650, fontSize: 16 }}>Morrow</span>
        </div>
        <div style={{ display: "flex", gap: 20, fontSize: 13, color: "#a6a7af" }}>
          <a href="#download" style={{ color: "inherit", textDecoration: "none" }}>Download</a>
          <a href="#setup" style={{ color: "inherit", textDecoration: "none" }}>Setup</a>
          <a href="#docs" style={{ color: "inherit", textDecoration: "none" }}>Docs</a>
          <a href="https://github.com/Mageester/morrow" target="_blank" rel="noopener" style={{ color: "inherit", textDecoration: "none" }}>GitHub</a>
        </div>
      </nav>

      {/* Hero */}
      <section style={{ textAlign: "center", padding: "100px 24px 80px", maxWidth: 720, margin: "0 auto" }}>
        <div style={{ width: 56, height: 56, borderRadius: 14, background: "linear-gradient(150deg, #5a8dff, #3d7bfd 55%, #7a5cff)", display: "grid", placeItems: "center", color: "#fff", fontWeight: 800, fontSize: 28, margin: "0 auto 24px", boxShadow: "0 4px 20px rgba(61,123,253,0.4)" }}>M</div>
        <h1 style={{ fontSize: 44, fontWeight: 650, letterSpacing: "-0.02em", margin: "0 0 16px", lineHeight: 1.15 }}>
          Private intelligence,<br />built around you.
        </h1>
        <p style={{ fontSize: 17, color: "#a6a7af", lineHeight: 1.65, margin: "0 auto 32px", maxWidth: 520 }}>
          Morrow is a self-hosted AI agent that runs locally on your machine. 
          Your code, files, and conversations never leave your control.
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <a href="#download" style={{ background: "#3d7bfd", color: "#fff", border: "none", padding: "14px 28px", borderRadius: 9, fontWeight: 600, fontSize: 15, textDecoration: "none", boxShadow: "0 2px 12px rgba(61,123,253,0.35)" }}>
            Get Morrow Early Access
          </a>
          <a href="https://github.com/Mageester/morrow" target="_blank" rel="noopener" style={{ background: "transparent", color: "#edeef1", border: "1px solid rgba(255,255,255,0.15)", padding: "14px 28px", borderRadius: 9, fontWeight: 500, fontSize: 15, textDecoration: "none" }}>
            View Source
          </a>
        </div>
        <p style={{ marginTop: 16, fontSize: 13, color: "#6d6e78" }}>
          v{manifest?.version || "0.1.0-beta.1"} · Windows Beta · Free during Early Access
        </p>
      </section>

      {/* What Morrow Does */}
      <section style={{ maxWidth: 960, margin: "0 auto", padding: "60px 24px" }}>
        <h2 style={{ textAlign: "center", fontSize: 28, fontWeight: 650, margin: "0 0 40px" }}>What Morrow Can Do</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20 }}>
          {[
            { title: "Code & Develop", desc: "Read, search, and understand codebases. Plan refactors. Review pull requests. Debug issues with full context." },
            { title: "Research & Browse", desc: "Search the web, extract page content, take screenshots. Real Chromium browser automation with audit trails." },
            { title: "Automate Workflows", desc: "Schedule recurring tasks. Chain agents together. Trigger on webhooks. Cron-based unattended execution." },
            { title: "Stay Private", desc: "Everything runs locally. Your API keys never leave your machine. No telemetry. No cloud dependency." },
            { title: "Control Permissions", desc: "Granular tool permissions per agent. Approval gates for dangerous actions. Full audit log of every operation." },
            { title: "Extend with Skills", desc: "55+ built-in skills. Create your own. Community-contributed workflows. Plugins with local manifest lifecycle." },
          ].map(item => (
            <div key={item.title} style={{ background: "#131317", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 11, padding: "22px 20px" }}>
              <h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 600 }}>{item.title}</h3>
              <p style={{ margin: 0, fontSize: 13.5, color: "#a6a7af", lineHeight: 1.55 }}>{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Why Different */}
      <section style={{ maxWidth: 800, margin: "0 auto", padding: "60px 24px" }}>
        <h2 style={{ textAlign: "center", fontSize: 28, fontWeight: 650, margin: "0 0 16px" }}>Why Morrow?</h2>
        <p style={{ textAlign: "center", color: "#a6a7af", fontSize: 15, margin: "0 auto 40px", maxWidth: 560 }}>
          Most AI tools are cloud-hosted black boxes. Morrow is different.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {[
            { left: "Other AI tools", right: "Morrow", items: [
              ["Send your data to the cloud", "All processing stays local"],
              ["Hidden prompts and behavior", "Visible plans, tools, and evidence"],
              ["Limited customization", "Provider, model, and agent configuration"],
              ["Proprietary lock-in", "Self-hosted, bring your own keys"],
              ["Opaque permissions", "Granular per-tool, per-agent permissions"],
            ]},
          ].map(group => (
            <div key={group.left} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: 13.5 }}>
              <div style={{ background: "#17171c", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 9, padding: "14px 16px" }}>
                <div style={{ fontSize: 11, color: "#6d6e78", fontWeight: 600, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>{group.left}</div>
                {group.items.map(([bad, good]) => (
                  <div key={bad} style={{ display: "flex", gap: 8, marginBottom: 8, color: "#a6a7af" }}>
                    <span style={{ color: "#f2555a", fontWeight: 700 }}>✕</span> {bad}
                  </div>
                ))}
              </div>
              <div style={{ background: "rgba(53,208,127,0.06)", border: "1px solid rgba(53,208,127,0.15)", borderRadius: 9, padding: "14px 16px" }}>
                <div style={{ fontSize: 11, color: "#35d07f", fontWeight: 600, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>{group.right}</div>
                {group.items.map(([bad, good]) => (
                  <div key={good} style={{ display: "flex", gap: 8, marginBottom: 8, color: "#edeef1" }}>
                    <span style={{ color: "#35d07f", fontWeight: 700 }}>✓</span> {good}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Download */}
      <section id="download" style={{ maxWidth: 800, margin: "0 auto", padding: "80px 24px" }}>
        <h2 style={{ textAlign: "center", fontSize: 28, fontWeight: 650, margin: "0 0 8px" }}>Download Morrow</h2>
        <p style={{ textAlign: "center", color: "#a6a7af", fontSize: 15, margin: "0 auto 40px", maxWidth: 480 }}>
          Early Access Beta for Windows 10/11 x64
        </p>

        {manifestError && !manifest && (
          <div style={{ textAlign: "center", padding: "32px", background: "rgba(240,180,41,0.1)", border: "1px solid rgba(240,180,41,0.25)", borderRadius: 11, maxWidth: 520, margin: "0 auto" }}>
            <p style={{ color: "#f0b429", fontSize: 14 }}>{manifestError}</p>
            <p style={{ color: "#a6a7af", fontSize: 13, marginTop: 8 }}>
              For now, build from source: <code style={{ background: "#1d1d23", padding: "2px 6px", borderRadius: 4, fontSize: 12 }}>git clone https://github.com/Mageester/morrow.git && cd morrow && pnpm install && pnpm build && pnpm dev</code>
            </p>
          </div>
        )}

        {windowsArtifact && (
          <div style={{ background: "#131317", border: "1px solid rgba(61,123,253,0.2)", borderRadius: 13, padding: "28px 24px", maxWidth: 520, margin: "0 auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <span style={{ fontSize: 28 }}>⊞</span>
              <div>
                <h3 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 600 }}>Windows Portable</h3>
                <p style={{ margin: 0, fontSize: 13, color: "#a6a7af" }}>Extract and run — no installer needed</p>
              </div>
              <span style={{ marginLeft: "auto", background: "rgba(53,208,127,0.12)", color: "#35d07f", padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600 }}>Beta</span>
            </div>
            <div style={{ fontSize: 12.5, color: "#a6a7af", marginBottom: 16, fontFamily: "monospace" }}>
              <div>{windowsArtifact.filename}</div>
              <div>{(windowsArtifact.size / 1024 / 1024).toFixed(1)} MB · SHA-256: <span style={{ fontSize: 11, color: "#6d6e78" }}>{windowsArtifact.sha256.slice(0, 16)}...</span></div>
            </div>
            <a href={windowsArtifact.url} style={{ display: "block", textAlign: "center", background: "#3d7bfd", color: "#fff", padding: "12px 24px", borderRadius: 8, fontWeight: 600, fontSize: 14, textDecoration: "none" }}>
              Download for Windows
            </a>
            <div style={{ marginTop: 12, fontSize: 12, color: "#6d6e78", textAlign: "center" }}>
              Requires Windows 10+ x64 · Node.js 22+ included
            </div>
          </div>
        )}

        {!windowsArtifact && !manifestError && (
          <div style={{ textAlign: "center", padding: "32px", color: "#a6a7af" }}>
            <p>Loading release information...</p>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, maxWidth: 600, margin: "24px auto 0" }}>
          {[
            { platform: "Linux", status: "Build from Source", available: true },
            { platform: "macOS", status: "Not Available", available: false },
            { platform: "Docker", status: "Planned", available: false },
          ].map(p => (
            <div key={p.platform} style={{ background: "#131317", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 9, padding: "16px", textAlign: "center", opacity: p.available ? 1 : 0.5 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{p.platform}</div>
              <div style={{ fontSize: 12, color: p.available ? "#35d07f" : "#6d6e78", marginTop: 4 }}>{p.status}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Setup */}
      <section id="setup" style={{ maxWidth: 800, margin: "0 auto", padding: "60px 24px" }}>
        <h2 style={{ textAlign: "center", fontSize: 28, fontWeight: 650, margin: "0 0 40px" }}>Simple Setup</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 540, margin: "0 auto" }}>
          {[
            { step: "1", title: "Download", desc: "Download the Windows portable package from the link above." },
            { step: "2", title: "Extract", desc: "Extract the zip to a permanent location like %LOCALAPPDATA%\\Morrow." },
            { step: "3", title: "Setup", desc: "Open PowerShell in the extracted folder and run .\\setup.ps1. This creates data directories and a Start Menu shortcut." },
            { step: "4", title: "Launch", desc: "Launch Morrow from the Start Menu or run node morrow.mjs. Your browser opens automatically." },
            { step: "5", title: "Configure", desc: "Follow the onboarding wizard: choose a provider, select a workspace, set permissions, pick skills." },
            { step: "6", title: "Start", desc: "Start your first mission — ask Morrow to inspect your code, research a topic, or automate a task." },
          ].map(item => (
            <div key={item.step} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(61,123,253,0.15)", color: "#3d7bfd", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 14, flex: "none" }}>{item.step}</div>
              <div>
                <h4 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 600 }}>{item.title}</h4>
                <p style={{ margin: 0, fontSize: 13.5, color: "#a6a7af" }}>{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Advanced Setup */}
      <section style={{ maxWidth: 800, margin: "0 auto", padding: "0 24px 60px" }}>
        <h2 style={{ textAlign: "center", fontSize: 22, fontWeight: 650, margin: "0 0 24px" }}>Advanced Setup</h2>
        <div style={{ background: "#131317", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 11, padding: "22px 24px", maxWidth: 600, margin: "0 auto", fontSize: 13.5, color: "#a6a7af", lineHeight: 1.7 }}>
          <p style={{ margin: "0 0 12px" }}>For developers, servers, and custom deployments:</p>
          <ul style={{ paddingLeft: 18, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <li><strong>Build from source:</strong> <code style={{ background: "#1d1d23", padding: "1px 5px", borderRadius: 4, fontSize: 12 }}>git clone</code>, <code style={{ background: "#1d1d23", padding: "1px 5px", borderRadius: 4, fontSize: 12 }}>pnpm install</code>, <code style={{ background: "#1d1d23", padding: "1px 5px", borderRadius: 4, fontSize: 12 }}>pnpm build</code></li>
            <li><strong>Custom port:</strong> Set <code style={{ background: "#1d1d23", padding: "1px 5px", borderRadius: 4, fontSize: 12 }}>MORROW_PORT</code> environment variable</li>
            <li><strong>Custom data directory:</strong> Set <code style={{ background: "#1d1d23", padding: "1px 5px", borderRadius: 4, fontSize: 12 }}>MORROW_HOME</code> environment variable</li>
            <li><strong>Local models:</strong> Install Ollama and set <code style={{ background: "#1d1d23", padding: "1px 5px", borderRadius: 4, fontSize: 12 }}>OLLAMA_BASE_URL</code></li>
            <li><strong>Headless mode:</strong> Set <code style={{ background: "#1d1d23", padding: "1px 5px", borderRadius: 4, fontSize: 12 }}>MORROW_HEADLESS=true</code></li>
            <li><strong>Docker:</strong> Planned for a future release</li>
            <li><strong>Full docs:</strong> <a href="https://github.com/Mageester/morrow" target="_blank" rel="noopener" style={{ color: "#3d7bfd" }}>github.com/Mageester/morrow</a></li>
          </ul>
        </div>
      </section>

      {/* Early Access Warning */}
      <section style={{ maxWidth: 700, margin: "0 auto", padding: "40px 24px 20px" }}>
        <div style={{ background: "rgba(240,180,41,0.08)", border: "1px solid rgba(240,180,41,0.2)", borderRadius: 11, padding: "20px 24px", fontSize: 13, color: "#a6a7af", lineHeight: 1.6 }}>
          <strong style={{ color: "#f0b429", fontSize: 14, display: "block", marginBottom: 8 }}>Early Access</strong>
          Morrow is in active development. Expect breaking changes, bugs, and incomplete features.
          Windows is the primary supported platform. Managed cloud browser, Docker, and macOS support are not yet available.
          Write and terminal tools are gated until safety boundaries are complete. See the repository for current status.
        </div>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: "1px solid rgba(255,255,255,0.07)", padding: "30px 24px", textAlign: "center", fontSize: 12.5, color: "#6d6e78" }}>
        <p style={{ margin: "0 0 6px" }}>Morrow is local-first and self-hosted. No telemetry. No cloud dependency. Your data stays yours.</p>
        <p style={{ margin: 0 }}>
          © 2026 Aidan Magee. <a href="https://github.com/Mageester/morrow" target="_blank" rel="noopener" style={{ color: "#3d7bfd", textDecoration: "none" }}>GitHub</a> · <a href="https://github.com/Mageester/morrow/blob/main/SECURITY.md" target="_blank" rel="noopener" style={{ color: "#3d7bfd", textDecoration: "none" }}>Security</a>
        </p>
      </footer>
    </div>
  );
}

export default App;
