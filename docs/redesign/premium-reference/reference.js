const screens = {
  home: { label: "Home", icon: "⌂" },
  projects: { label: "Projects", icon: "□" },
  skills: { label: "Skills", icon: "✧" },
  memory: { label: "Memory", icon: "◉" },
  history: { label: "History", icon: "↺" },
  connections: { label: "Connections", icon: "⌁" },
  settings: { label: "Settings", icon: "⚙" },
};

const selectedScreen = new URLSearchParams(location.search).get("screen") || "home";
const activeScreen = selectedScreen === "chat" ? "home" : selectedScreen;

function nav() {
  return Object.entries(screens).map(([key, item]) => `
    <a class="${key === activeScreen ? "active" : ""}" href="?screen=${key}">
      <span class="nav-icon">${item.icon}</span>${item.label}
    </a>`).join("");
}

function shell(content, title, pageClass = "") {
  return `<div class="app">
    <aside class="rail shell">
      <div class="brand"><span class="brand-mark">✦</span>Morrow</div>
      <button class="new-chat" type="button">＋ New conversation</button>
      <nav class="nav" aria-label="Primary">${nav()}</nav>
      <div class="runtime"><span class="status-dot"></span><b>Local Morrow</b><small>Private runtime online</small></div>
    </aside>
    <section class="workspace shell">
      <header class="topbar"><span>Morrow / <strong>${title}</strong></span><span class="command">⌘ K &nbsp; Search or command</span></header>
      <main class="page ${pageClass}">${content}</main>
    </section>
  </div>`;
}

function principle(title, body) {
  return `<div class="principle"><b>${title}</b><span>${body}</span></div>`;
}

function home() {
  return shell(`<div class="home">
    <section class="home-hero">
      <div class="eyebrow">Good afternoon, Aidan</div>
      <h1 class="display">What should we move forward?</h1>
      <p class="subtitle">Start with an outcome. Morrow will shape the work around you.</p>
      <div class="composer"><textarea aria-label="Ask Morrow">Ask Morrow to build, investigate, plan, or take action…</textarea><div class="composer-bar"><span class="chip">＋ Attach</span><span class="chip">◌ Private</span><span class="chip">⌁ DeepSeek V3.1</span><button class="send" aria-label="Send" type="button">↑</button></div></div>
      <div class="suggestions"><span class="suggestion">Finish something in progress</span><span class="suggestion">Research a decision</span><span class="suggestion">Build from a brief</span></div>
    </section>
    <div class="section-head"><h2>Continue your work</h2><span>View all projects →</span></div>
    <div class="continuity">
      <article class="work-card featured"><label>Last active · 8 min ago</label><h3>Morrow launch</h3><p>Verification pass in progress</p><div class="work-foot"><span>3 agents</span><span>Open →</span></div></article>
      <article class="work-card"><label>Yesterday</label><h3>Market intelligence</h3><p>Competitive synthesis ready</p><div class="work-foot"><span>14 sources</span><span>Open →</span></div></article>
      <article class="work-card"><label>Monday</label><h3>Private assistant</h3><p>Memory architecture review</p><div class="work-foot"><span>2 decisions</span><span>Open →</span></div></article>
    </div>
    <div class="notice"><span class="notice-glyph">✦</span><div><b>Morrow noticed one unfinished thread</b><span>The launch brief is waiting on three verification checks.</span></div><span class="review">Review →</span></div>
  </div>`, "Home");
}

function chat() {
  return shell(`<div class="chat-layout">
    <section class="conversation">
      <div class="conversation-scroll"><div class="conversation-inner"><div class="chat-date">Today · 12:42 PM</div><div class="user-message">Turn the research into a launch brief and flag anything we still need to verify.</div><div class="assistant-message"><div class="assistant-mark">✦</div><div class="response"><h2>Your launch brief is ready.</h2><p>I consolidated the market research, separated verified claims from assumptions, and shaped the result into a concise brief your team can act on.</p><ul class="response-list"><li>Positioning is anchored to private, local-first execution.</li><li>Three claims need live evidence before publication.</li><li>The release sequence now has clear owners and rollback points.</li></ul><div class="artifact"><div class="artifact-icon">◇</div><div><b>Morrow launch brief</b><small>Document · 8 sections · Updated now</small></div><span class="artifact-open">Open ↗</span></div></div></div></div></div>
      <div class="composer-dock"><div class="composer"><textarea aria-label="Message">Ask Morrow to build, research, or act…</textarea><div class="composer-bar"><span class="chip">＋ Attach</span><span class="chip">◌ Private</span><span class="chip">⌁ DeepSeek V3.1</span><button class="send" aria-label="Send" type="button">↑</button></div></div></div>
    </section>
    <aside class="activity"><div class="activity-head"><b>Live work</b><span class="live">Active</span></div>${activity("Research synthesized", "Reviewed 14 local sources and grouped evidence by claim.", "Completed · 12:39 PM")}${activity("Brief composed", "Drafted the launch narrative and evidence notes.", "Completed · 12:41 PM")}${activity("Verification pass", "Checking claims against their original sources.", "Running now")}${activity("Final handoff", "Waiting for verification to finish.", "Queued", true)}<div class="run-context"><div class="eyebrow">Run context</div><h3>Launch strategy</h3><p>Private project · Local memory enabled</p><div class="metrics"><div class="metric"><b>14</b><span>sources</span></div><div class="metric"><b>$0.18</b><span>run cost</span></div></div></div></aside>
  </div>`, "Launch strategy · Product", "chat-page");
}

function activity(title, body, time, queued = false) {
  return `<div class="activity-stage ${queued ? "queued" : ""}"><span class="activity-node"></span><b>${title}</b><p>${body}</p><time>${time}</time></div>`;
}

function projects() {
  return shell(`${hero("Your work", "Projects", "Living contexts for everything Morrow helps you accomplish.", "＋ New project")}
    <section class="feature-project"><div class="feature-meta">Continue where you left off</div><h2>Morrow launch</h2><p>Positioning, release evidence, and the final product narrative—all held together in one private context.</p><div class="feature-foot"><span>3 agents</span><span>14 sources</span><span>Updated 8 minutes ago</span><span class="open">Open project →</span></div></section>
    <div class="section-head"><h2>Project index</h2><span>4 active · 2 archived</span></div>
    <div class="editorial-index">${projectRow("M", "Market intelligence", "Research workspace", "Competitors, pricing, and evidence", "Yesterday")}${projectRow("P", "Private assistant", "Product development", "Memory, teams, and safety", "Monday")}${projectRow("S", "Saviz website", "Commercial site", "Copy, design, and launch", "Aug 4")}</div>
    ${principle("Projects as a private atelier, not a file manager.", "One cinematic continuation surface, followed by a precise editorial index. No card grid, fake analytics, or admin-dashboard feeling.")}`, "Projects");
}

function hero(eyebrow, title, subtitle, action) {
  return `<div class="page-hero"><div><div class="eyebrow">${eyebrow}</div><h1 class="display">${title}</h1><p class="subtitle">${subtitle}</p></div>${action ? `<button class="primary" type="button">${action}</button>` : ""}</div>`;
}

function projectRow(letter, name, kind, purpose, time) {
  return `<div class="editorial-row"><span class="signature">${letter}</span><div><b>${name}</b><small>${kind}</small></div><span class="purpose">${purpose}</span><span class="time">${time}</span><span>→</span></div>`;
}

function memory() {
  return shell(`${heroSearch("Private knowledge", "Memory", "What Morrow remembers, why it matters, and exactly where it applies.", "⌕  Search your memory…")}
    <div class="split-library"><section class="library"><div class="filters"><span class="filter active">All memory</span><span class="filter">This project</span><span class="filter">Preferences</span><span class="filter">Decisions</span></div><div class="group-label">Today</div>${memoryRow("◌", "Evidence before completion claims", "Always distinguish locally verified results from live-provider and release evidence.", "Global", true)}${memoryRow("◇", "Morrow product identity", "A private AI agent application—not an operating system or generic dashboard.", "Morrow")}<div class="group-label">Earlier this week</div>${memoryRow("✦", "Visual quality preference", "Match the onboarding’s restrained, expensive visual language across the product.", "Global")}${memoryRow("□", "Release verification routine", "Validate tests, build, package identity, and the exact served UI before claiming release.", "Morrow")}</section>
    <aside class="dossier"><div class="dossier-tag">Selected memory · Decision</div><h2>Evidence before completion claims</h2><div class="quote">“Separate deterministic local results from live-provider, browser, network, billing, release, and user-visible-flow evidence.”</div><div>${fact("Scope", "Across all projects")}${fact("Remembered", "Today, 12:38 PM")}${fact("Source", "Conversation")}${fact("Used", "6 times")}</div><div class="trust"><span>✓</span><span>Approved memory. You control whether Morrow keeps, edits, or forgets it.</span></div><div class="actions"><button class="secondary">Edit</button><button class="secondary">Change scope</button><button class="secondary">•••</button></div></aside></div>
    ${principle("Memory as a curated private library.", "Every item is readable, traceable, scoped, and editable. The interface makes trust feel luxurious instead of technical.")}`, "Memory");
}

function heroSearch(eyebrow, title, subtitle, value) {
  return `<div class="page-hero"><div><div class="eyebrow">${eyebrow}</div><h1 class="display">${title}</h1><p class="subtitle">${subtitle}</p></div><input class="search" aria-label="Search" value="${value}" /></div>`;
}

function memoryRow(glyph, title, body, scope, selected = false) {
  return `<div class="library-row ${selected ? "selected" : ""}"><span class="library-glyph">${glyph}</span><div><b>${title}</b><p>${body}</p></div><span class="scope">${scope}</span></div>`;
}
function fact(label, value) { return `<div class="fact"><span>${label}</span><b>${value}</b></div>`; }

function skills() {
  return shell(`${hero("Learned capabilities", "Skills", "The methods Morrow can repeat reliably—proven, inspectable, and under your control.", "＋ Add skill")}
    <div class="split-library"><section class="library"><div class="section-head" style="padding:0 18px"><h2>Capability cabinet</h2><span>7 active</span></div>${skillRow("R", "Research and verify", "Evidence-backed investigation", "Proven", true)}${skillRow("B", "Build release brief", "Product handoff and rollback", "Proven")}${skillRow("V", "Visual QA pass", "Rendered interface inspection", "Active")}${skillRow("C", "Competitive synthesis", "Claims, sources, and gaps", "Active")}</section>
    <aside class="dossier"><div class="dossier-tag">Selected skill · Proven</div><h2>Research and verify</h2><p class="subtitle">Investigates a question across trusted sources, distinguishes evidence from inference, and returns a concise answer with visible provenance.</p><div class="metrics" style="grid-template-columns:repeat(3,1fr);margin:22px 0"><div class="metric"><b>12</b><span>successful runs</span></div><div class="metric"><b>94%</b><span>verification score</span></div><div class="metric"><b>Aug 11</b><span>last improved</span></div></div><div class="quote"><div>1 · Frame the claim and required evidence</div><div>2 · Gather authoritative sources</div><div>3 · Cross-check conflicts and uncertainty</div><div>4 · Deliver findings with provenance</div></div><div class="trust"><span>✓</span><span>Learned from two approved Morrow missions.</span></div><div class="actions"><button class="primary">Use skill</button><button class="secondary">Edit method</button><button class="secondary">View evidence</button></div></aside></div>
    ${principle("Skills as craftsmanship, not plugins.", "Each capability has a method, provenance, and proof. Morrow feels like it becomes more accomplished—not merely more installed.")}`, "Skills");
}

function skillRow(letter, title, body, state, selected = false) {
  return `<div class="library-row ${selected ? "selected" : ""}" style="grid-template-columns:42px 1fr auto"><span class="signature">${letter}</span><div><b>${title}</b><p>${body}</p></div><span class="scope" style="color:var(--green)">${state}</span></div>`;
}

function history() {
  return shell(`${heroSearch("Your chronicle", "History", "Outcomes, decisions, and unfinished work—remembered in context.", "⌕  Search conversations and results…")}
    <div class="chronicle"><section class="day"><div class="date-label">Today</div>${historyEntry("Completed work", "Morrow launch", "12:42 PM", "Launch brief prepared and verified", "Consolidated the product narrative, separated assumptions from evidence, and produced a release-ready handoff.", "1 document · 14 sources · 3 decisions", true)}${historyEntry("Conversation", "Market intelligence", "10:18 AM", "Compared local-first agent products", "Positioning gaps, pricing signals, and evidence quality.", "Continue", false)}</section><section class="day"><div class="date-label">Yesterday</div>${historyEntry("Decision", "Private assistant", "4:26 PM", "Memory remains approval-controlled", "Automatic capture may suggest candidates, but permanent activation stays visible and reversible.", "2 related conversations · 1 memory", false)}</section><section class="day"><div class="date-label">Monday</div>${historyEntry("Artifact", "Saviz website", "3:02 PM", "Commercial site launch package", "Ten routes, verification evidence, and deployment notes.", "Open artifact", false)}</section></div>
    ${principle("History as a chronicle of outcomes.", "Lead with what was accomplished, decided, or left unfinished. Conversations remain available, but transcripts no longer define the experience.")}`, "History");
}

function historyEntry(kind, project, time, title, body, result, featured) {
  return `<article class="history-entry ${featured ? "featured" : ""}"><div class="entry-top"><span class="kind">${kind}</span><span class="entry-project">${project}</span><time class="entry-time">${time}</time></div><h2>${title}</h2><p>${body}</p><div class="result"><span>${result}</span><span class="resume">${featured ? "Open result" : "Review"} →</span></div></article>`;
}

function connections() {
  return shell(`${hero("Models & access", "Connections", "Choose where Morrow thinks. Connected providers stay compact; detail appears only when you ask for it.", "＋ Add provider")}
    <div class="section-head"><h2>Connected providers</h2><span>3 ready</span></div><div class="provider-list">${providerRow("D", "DeepSeek", "Cloud model provider", "DeepSeek V3.1", "Healthy", "2 min ago")}${providerRow("O", "OpenCode Zen", "60 models available", "LongCat 2.0 Free", "Connected", "12:17 PM", true)}${providerRow("O", "OpenRouter", "Model gateway", "Auto routing", "Healthy", "4 min ago")}</div>
    <div class="provider-detail"><div><span class="field-label">OpenCode Zen</span><h3>Provider settings</h3><p>Credentials are stored locally and never displayed again. Test or replace the connection only when needed.</p></div><div><span class="field-label">Active model</span><div class="select-control"><span>LongCat 2.0 Free</span><span>⌄</span></div></div><div class="detail-actions"><button class="secondary">Test connection</button><button class="secondary">Replace credential</button><button class="secondary">••• More</button></div></div>
    <div class="section-head"><h2>Discover providers</h2><input class="search" aria-label="Search providers" value="Search 27 available providers" /></div><div class="catalog"><div class="catalog-card"><b>OpenAI</b><span>Subscription sign-in · Frontier models</span></div><div class="catalog-card"><b>Anthropic</b><span>Subscription sign-in · Claude models</span></div><div class="catalog-card"><b>Ollama</b><span>Local · Runs on this machine</span></div></div>
    ${principle("A provider command center, not a settings document.", "Dense, scannable rows; progressive detail; calm maintenance controls; destructive actions hidden behind deliberate intent.")}`, "Connections");
}

function providerRow(letter, name, description, model, state, checked, selected = false) {
  return `<div class="provider-row ${selected ? "selected" : ""}"><div class="provider-id"><span class="provider-logo">${letter}</span><div><b>${name}</b><small>${description}</small></div></div><div><b>${model}</b><small>Active model</small></div><div><span class="healthy">${state}</span><small>${checked}</small></div><button class="secondary">${selected ? "Close" : "Manage"}</button></div>`;
}

function settings() {
  return shell(`${hero("Your Morrow", "Settings", "Clear control over how Morrow looks, thinks, remembers, and acts.", "")}
    <div class="settings-layout"><nav class="settings-book">${chapter("A", "Appearance", "Theme and motion")}${chapter("M", "Model behavior", "Reasoning and defaults")}${chapter("◌", "Privacy", "Data and boundaries", true)}${chapter("✓", "Approvals", "Actions and permissions")}${chapter("✦", "Personalization", "Name and preferences")}${chapter("↗", "Advanced", "Runtime and diagnostics")}</nav><section class="settings-page"><div class="settings-head"><h2>Privacy</h2><p>Choose what Morrow may remember and where your requests may travel.</p></div><div class="assurance"><span class="shield">◉</span><div><b>Your local runtime is protected</b><span>Credentials, project files, and approved memory remain on this machine unless you deliberately use a cloud provider.</span></div></div><div class="settings-section-label">Memory</div>${setting("Automatic memory suggestions", "Morrow may propose useful facts. Nothing becomes permanent without your control.", "toggle")}${setting("Default memory scope", "New memories begin inside the current project.", "Current project⌄")}<div class="settings-section-label">Provider preference</div>${setting("Preferred privacy level", "A visible preference for future routing; provider and tool choices remain explicit.", "Prefer local⌄")}${setting("Show external-data confirmation", "Confirm before content is sent to a cloud model for the first time in a project.", "toggle")}</section></div>
    ${principle("Settings as a calm control book.", "One chapter at a time, short truthful explanations, and progressive disclosure for advanced controls. No endless wall of forms.")}`, "Settings");
}

function chapter(icon, title, subtitle, active = false) {
  return `<div class="chapter ${active ? "active" : ""}"><span class="chapter-icon">${icon}</span><div><b>${title}</b><small>${subtitle}</small></div></div>`;
}
function setting(title, body, value) {
  return `<div class="setting-row"><div><b>${title}</b><p>${body}</p></div>${value === "toggle" ? '<span class="toggle"></span>' : `<span class="value">${value}</span>`}</div>`;
}

const renderers = { home, chat, projects, memory, skills, history, connections, settings };
document.getElementById("app").innerHTML = (renderers[selectedScreen] || home)();
document.title = `${selectedScreen[0].toUpperCase()}${selectedScreen.slice(1)} · Morrow Premium Reference`;
