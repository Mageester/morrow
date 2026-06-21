import React, { useState, useEffect, useRef, useMemo } from "react";
import { apiClient } from "./api/client";
import type {
  Project, Task, TaskEvent, PlanStep, TaskEvidence, ExecutionDisclosure,
  ConversationMessage, VerificationResult,
  PresetStatus, ProviderStatus, ModelStatus, OAuthFinding, MemoryEntry, RoutingDecision
} from "@morrow/contracts";
import { Markdown } from "./Markdown";
import * as I from "./icons";
import "./App.css";

type Nav = "projects" | "runs" | "agents" | "knowledge" | "mcp" | "tools" | "stores" | "audit" | "settings" | "billing" | "help";
type SettingsTab = "providers" | "models" | "presets" | "privacy" | "permissions" | "data" | "diagnostics";
type InspTab = "overview" | "files" | "notes" | "settings";

interface ProjectMeta { status: string; agent: string; updatedAt: string; latestTaskId: string | null; }

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued", running: "Running", completed: "Completed", verified: "Verified",
  failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted", draft: "Draft"
};

function fmtTime(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtRelative(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return fmtTime(iso);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function fmtBytes(n?: number) {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function humanizeEvent(ev: TaskEvent): { label: string; desc?: string } | null {
  const p: any = ev.payload || {};
  switch (ev.type) {
    case "task.created": return { label: "Run started" };
    case "task.running": return null;
    case "plan.created": return { label: "Plan created", desc: p.stepCount ? `${p.stepCount} steps` : undefined };
    case "workspace.inspected": return { label: "Inspected workspace", desc: p.resultCount !== undefined ? `${p.resultCount} entries` : undefined };
    case "evidence.persisted": return p.path ? { label: `Read ${p.path}`, desc: p.size ? fmtBytes(p.size) : undefined } : null;
    case "verification.completed":
    case "task.verified": return { label: "Verified", desc: "Deterministic inspection verified" };
    case "task.completed": return { label: "Completed" };
    case "task.failed": return { label: "Failed", desc: p.message };
    case "task.cancelled": return { label: "Cancelled" };
    case "task.interrupted": return { label: "Interrupted" };
    case "step.started": return null;
    case "step.completed": return null;
    default: return null;
  }
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectMeta, setProjectMeta] = useState<Record<string, ProjectMeta>>({});
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [nav, setNav] = useState<Nav>("projects");
  const [view, setView] = useState<"list" | "conversation">("list");
  const [inspTab, setInspTab] = useState<InspTab>("overview");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newWorkspacePath, setNewWorkspacePath] = useState("");
  const [projectError, setProjectError] = useState("");

  const [activeConversationId, setActiveConversationId] = useState<string>("");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [composerPrompt, setComposerPrompt] = useState("");
  const [composerError, setComposerError] = useState("");
  const [taskError, setTaskError] = useState("");

  const [activePreset, setActivePreset] = useState<string>("balanced");
  const [providerStatus, setProviderStatus] = useState<{ configured: boolean; provider: string; model: string } | null>(null);
  const [presets, setPresets] = useState<PresetStatus[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [models, setModels] = useState<ModelStatus[]>([]);
  const [oauthFindings, setOauthFindings] = useState<OAuthFinding[]>([]);
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([]);
  const [newMemoryContent, setNewMemoryContent] = useState("");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("providers");

  const [focusedTaskId, setFocusedTaskId] = useState<string>("");
  const [activeTaskId, setActiveTaskId] = useState<string>("");
  const [taskState, setTaskState] = useState<{
    task?: Task; plan?: PlanStep[]; events?: TaskEvent[]; evidence?: TaskEvidence[];
    disclosure?: ExecutionDisclosure; toolCalls?: any[]; verification?: VerificationResult; routing?: RoutingDecision | null;
  } | null>(null);

  const messageEndRef = useRef<HTMLDivElement>(null);
  const eventUnsubRef = useRef<(() => void) | null>(null);

  // ── Loaders ────────────────────────────────────────────────────────────────
  const loadProjectMeta = async (list: Project[]) => {
    const entries = await Promise.all(list.map(async (p) => {
      try {
        const tasks = await apiClient.listProjectTasks(p.id);
        const sorted = [...tasks].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        const latest = sorted[0];
        const meta: ProjectMeta = latest
          ? { status: latest.status, agent: latest.kind === "agent_chat" ? "Assistant" : "Inspector", updatedAt: latest.updatedAt, latestTaskId: latest.id }
          : { status: "draft", agent: "—", updatedAt: p.createdAt, latestTaskId: null };
        return [p.id, meta] as const;
      } catch {
        return [p.id, { status: "draft", agent: "—", updatedAt: p.createdAt, latestTaskId: null }] as const;
      }
    }));
    setProjectMeta(Object.fromEntries(entries));
  };

  useEffect(() => {
    apiClient.listProjects().then(p => { setProjects(p); loadProjectMeta(p); }).catch(console.error);
    apiClient.getProviderStatus().then(setProviderStatus).catch(console.error);
    apiClient.listPresets?.().then(setPresets).catch(console.error);
    apiClient.listProviders?.().then(setProviders).catch(console.error);
    apiClient.listModels?.().then(setModels).catch(console.error);
    apiClient.listOAuthFindings?.().then(setOauthFindings).catch(console.error);
  }, []);

  useEffect(() => {
    if (selectedProjectId && apiClient.listProjectMemory) {
      apiClient.listProjectMemory(selectedProjectId).then(setMemoryEntries).catch(console.error);
    } else setMemoryEntries([]);
  }, [selectedProjectId]);

  // Load conversation + messages for the selected project
  const openProject = async (projectId: string, asConversation: boolean) => {
    setSelectedProjectId(projectId);
    setInspTab("overview");
    if (asConversation) setView("conversation");
    const meta = projectMeta[projectId];
    setFocusedTaskId(meta?.latestTaskId || "");
    try {
      const convs = await apiClient.listConversations(projectId);
      const conv = convs[0];
      if (conv) {
        setActiveConversationId(conv.id);
        const msgs = await apiClient.listMessages(conv.id);
        setMessages(msgs);
        const last = msgs.at(-1);
        if (last && last.role === "assistant" && last.taskId && ["queued", "streaming"].includes(last.streamingState)) {
          setActiveTaskId(last.taskId);
          setFocusedTaskId(last.taskId);
        } else setActiveTaskId("");
      } else {
        setActiveConversationId("");
        setMessages([]);
        setActiveTaskId("");
      }
    } catch (e) { console.error(e); }
  };

  useEffect(() => { messageEndRef.current?.scrollIntoView?.({ behavior: "smooth" }); }, [messages]);

  // Aggregate + SSE for the focused task
  useEffect(() => {
    if (!focusedTaskId) { setTaskState(null); if (eventUnsubRef.current) { eventUnsubRef.current(); eventUnsubRef.current = null; } return; }
    let live = true;
    const fetchAgg = () => {
      apiClient.getTaskAggregate(focusedTaskId).then(agg => {
        if (!live) return;
        fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/tasks/${focusedTaskId}`)
          .then(r => r.json())
          .then((extra: any) => { if (live) setTaskState({ ...agg, toolCalls: extra.toolCalls || [], routing: extra.routing ?? null }); })
          .catch(() => { if (live) setTaskState({ ...agg, routing: (agg as any).routing ?? null }); });
      }).catch(console.error);
    };
    fetchAgg();
    const unsub = apiClient.subscribeToTaskEvents(focusedTaskId, 0, (event) => {
      if (!live) return;
      fetchAgg();
      if (event.type === "evidence.persisted" && event.payload.deltaText) {
        setMessages(prev => prev.map(m => m.taskId === focusedTaskId ? { ...m, content: m.content + (event.payload.deltaText as string), streamingState: "streaming" } : m));
      }
    }, () => {
      if (!live) return;
      if (activeConversationId) apiClient.listMessages(activeConversationId).then(setMessages).catch(() => {});
      if (selectedProjectId) loadProjectMeta(projects);
    });
    eventUnsubRef.current = unsub;
    return () => { live = false; unsub(); if (eventUnsubRef.current === unsub) eventUnsubRef.current = null; };
  }, [focusedTaskId, activeConversationId]); // eslint-disable-line

  // ── Actions ─────────────────────────────────────────────────────────────────
  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setProjectError("");
    try {
      const p = await apiClient.createProject(newProjectName, newWorkspacePath);
      const next = [...projects, p];
      setProjects(next);
      await loadProjectMeta(next);
      setNewProjectName(""); setNewWorkspacePath(""); setNewProjectOpen(false);
      setNav("projects");
      await openProject(p.id, true);
    } catch (err: any) { setProjectError(err.message || "Failed to create project"); }
  };

  const ensureConversation = async (): Promise<string> => {
    if (activeConversationId) return activeConversationId;
    const c = await apiClient.createConversation(selectedProjectId, "Conversation 1");
    setActiveConversationId(c.id);
    return c.id;
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProjectId || !composerPrompt.trim()) return;
    setComposerError("");
    const ps = presets.find(p => p.preset.id === activePreset);
    if (ps && !ps.available && !providerStatus?.configured) { setComposerError(ps.unavailableReason || "This preset is unavailable."); return; }
    const content = composerPrompt; setComposerPrompt("");
    try {
      const convId = await ensureConversation();
      const res = await apiClient.sendMessage(convId, content, { preset: activePreset, useMemory: true });
      setMessages(prev => [...prev, res.userMessage, res.assistantMessage]);
      setActiveTaskId(res.task.id);
      setFocusedTaskId(res.task.id);
    } catch (err: any) { setComposerError(err.message || "Failed to send message"); }
  };

  const handleStop = async () => {
    if (!activeTaskId) return;
    try {
      await apiClient.cancelTask(activeTaskId);
      if (activeConversationId) setMessages(await apiClient.listMessages(activeConversationId));
      loadProjectMeta(projects);
    } catch (err) { console.error(err); }
  };

  const handleInspect = async () => {
    if (!selectedProjectId) return;
    setTaskError("");
    try {
      const res = await apiClient.startInspectWorkspace(selectedProjectId);
      setActiveTaskId(""); setFocusedTaskId(res.taskId);
      loadProjectMeta(projects);
    } catch (err: any) { setTaskError(err.message || "Failed to start inspection"); }
  };

  const handleAddMemory = async () => {
    if (!selectedProjectId || !newMemoryContent.trim() || !apiClient.addMemory) return;
    try { const m = await apiClient.addMemory(selectedProjectId, "project", newMemoryContent.trim()); setMemoryEntries(p => [...p, m]); setNewMemoryContent(""); } catch (e) { console.error(e); }
  };
  const handleToggleMemory = async (id: string, enabled: boolean) => { try { const u = await apiClient.setMemoryEnabled(id, enabled); setMemoryEntries(p => p.map(m => m.id === id ? u : m)); } catch (e) { console.error(e); } };
  const handleDeleteMemory = async (id: string) => { try { await apiClient.deleteMemory(id); setMemoryEntries(p => p.filter(m => m.id !== id)); } catch (e) { console.error(e); } };

  // ── Derived ──────────────────────────────────────────────────────────────────
  const selectedProject = projects.find(p => p.id === selectedProjectId);
  const activePresetStatus = presets.find(p => p.preset.id === activePreset);
  const latestAssistant = [...messages].reverse().find(m => m.role === "assistant" && (m.provider || m.model));
  const providerLabel = latestAssistant?.provider || activePresetStatus?.resolved?.providerId || providerStatus?.provider || "—";
  const modelLabel = latestAssistant?.model || activePresetStatus?.resolved?.model || providerStatus?.model || "—";

  const filteredProjects = useMemo(() => {
    return projects.filter(p => {
      const m = projectMeta[p.id];
      if (search && !p.name.toLowerCase().includes(search.toLowerCase()) && !p.workspacePath.toLowerCase().includes(search.toLowerCase())) return false;
      if (statusFilter !== "all" && (m?.status || "draft") !== statusFilter) return false;
      return true;
    }).sort((a, b) => ((projectMeta[a.id]?.updatedAt || a.createdAt) < (projectMeta[b.id]?.updatedAt || b.createdAt) ? 1 : -1));
  }, [projects, projectMeta, search, statusFilter]);

  const inspectorOpen = nav === "projects" && !!selectedProjectId;

  // ── Render helpers ────────────────────────────────────────────────────────────
  const NavItem = ({ id, label, icon: Icon }: { id: Nav; label: string; icon: (p: any) => React.ReactElement }) => (
    <button className={`nav-item ${nav === id ? "active" : ""}`} onClick={() => { setNav(id); if (id === "projects") setView("list"); }}>
      <Icon className="ico" /> {label}
    </button>
  );
  const Status = ({ s }: { s: string }) => (<span className={`status ${s}`}><span className="dot" />{STATUS_LABEL[s] || s}</span>);

  const focusedTask = taskState?.task;
  const planVerified = focusedTask?.status === "verified";

  return (
    <div className={`morrow-app ${inspectorOpen ? "with-inspector" : ""}`}>
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">M</div><div className="brand-name">Morrow</div></div>
        <nav className="nav">
          <NavItem id="projects" label="Projects" icon={I.IconProjects} />
          <NavItem id="agents" label="Agents" icon={I.IconAgents} />
          <NavItem id="knowledge" label="Knowledge" icon={I.IconKnowledge} />
          <NavItem id="mcp" label="MCP Servers" icon={I.IconMcp} />
          <NavItem id="tools" label="Tools" icon={I.IconTools} />
          <NavItem id="stores" label="Stores" icon={I.IconStores} />
          <NavItem id="runs" label="Runs" icon={I.IconRuns} />
          <NavItem id="audit" label="Audit Log" icon={I.IconAudit} />
          <div className="nav-divider" />
          <NavItem id="settings" label="Settings" icon={I.IconSettings} />
          <NavItem id="billing" label="Billing" icon={I.IconBilling} />
          <NavItem id="help" label="Help" icon={I.IconHelp} />
        </nav>
        <div className="nav-spacer" />
        <div className="account">
          <div className="avatar">KT</div>
          <div className="account-meta"><div className="account-name">Local Workspace</div><div className="account-sub">Private · on this machine</div></div>
          <I.IconChevron className="chev ico" />
        </div>
      </aside>

      {/* Content */}
      <div className="content">
        {nav === "projects" && view === "list" && (
          <>
            <div className="topbar">
              <h1>Projects</h1>
              <div className="spacer" />
              <button className="btn btn-primary" onClick={() => setNewProjectOpen(true)}><I.IconPlus className="ico" /> New Project</button>
            </div>
            <div className="toolbar">
              <div className="search">
                <I.IconSearch className="ico" />
                <input placeholder="Search projects…" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search projects" />
                <span className="kbd">⌘K</span>
              </div>
              <label className="select">
                <I.IconFilter className="ico" style={{ width: 14, height: 14 }} />
                <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label="Filter by status">
                  <option value="all">All Statuses</option>
                  <option value="running">Running</option>
                  <option value="completed">Completed</option>
                  <option value="verified">Verified</option>
                  <option value="failed">Failed</option>
                  <option value="draft">Draft</option>
                </select>
              </label>
            </div>
            {projects.length === 0 ? (
              <div className="empty">
                <I.IconProjects className="empty-ico" />
                <h3>No projects yet</h3>
                <p>Create a local project pointed at a folder. Morrow runs a read-only agent over the workspace you choose.</p>
                <button className="btn btn-primary" onClick={() => setNewProjectOpen(true)}><I.IconPlus className="ico" /> New Project</button>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="ptable">
                  <colgroup><col className="c-name" /><col className="c-agent" /><col className="c-status" /><col className="c-updated" /><col className="c-menu" /></colgroup>
                  <thead><tr><th>Name</th><th>Agent</th><th>Status</th><th><span className="sort">Updated <I.IconChevron className="ico" style={{ width: 13, height: 13 }} /></span></th><th /></tr></thead>
                  <tbody>
                    {filteredProjects.map(p => {
                      const m = projectMeta[p.id] || { status: "draft", agent: "—", updatedAt: p.createdAt, latestTaskId: null };
                      return (
                        <tr key={p.id} className={selectedProjectId === p.id ? "selected" : ""} onClick={() => openProject(p.id, false)} onDoubleClick={() => openProject(p.id, true)}>
                          <td>
                            <div className="cell-name">
                              <I.IconFile className="file-ico" />
                              <div><div className="name-main">{p.name}</div><div className="name-sub">{p.workspacePath}</div></div>
                            </div>
                          </td>
                          <td className="cell-agent">{m.agent}</td>
                          <td><Status s={m.status} /></td>
                          <td className="cell-updated">{fmtRelative(m.updatedAt)}</td>
                          <td><button className="row-menu" aria-label="Open project" onClick={(e) => { e.stopPropagation(); openProject(p.id, true); }}><I.IconMore className="ico" style={{ width: 16, height: 16 }} /></button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="table-footer">{filteredProjects.length} of {projects.length} project{projects.length === 1 ? "" : "s"}</div>
              </div>
            )}
          </>
        )}

        {nav === "projects" && view === "conversation" && selectedProject && (
          <div className="convo">
            <div className="convo-head">
              <button className="back" onClick={() => setView("list")} aria-label="Back to projects"><I.IconBack className="ico" style={{ width: 16, height: 16 }} /></button>
              <div className="workspace-header">
                <h3>{selectedProject.name} Workspace</h3>
                <p className="path-display">Path: <span className="path-truncate">{selectedProject.workspacePath}</span></p>
              </div>
              <div className="convo-head-meta">
                <span className={`meta-chip ${providerStatus?.configured ? "ok" : "warn"}`}>{providerStatus?.configured ? `${providerLabel} · ${modelLabel}` : "No provider"}</span>
                <button className="btn btn-ghost" onClick={handleInspect}>Inspect workspace</button>
              </div>
            </div>
            <div className="conv-sub-toolbar">
              {presets.map(ps => (
                <button key={ps.preset.id} className={`preset-chip ${activePreset === ps.preset.id ? "selected" : ""} ${!ps.available ? "unavailable" : ""}`} onClick={() => setActivePreset(ps.preset.id)} title={ps.available ? ps.preset.description : ps.unavailableReason || ""}>{ps.preset.label}</button>
              ))}
            </div>
            {taskError && <div className="error-message" role="alert" style={{ margin: "10px 22px 0" }}>{taskError}</div>}
            <div className="chat-scroll">
              {messages.length === 0 ? (
                <div className="chat-empty">
                  <I.IconAgentFace className="empty-ico" />
                  <p>Ask Morrow about this project, e.g. <em>"Summarize the architecture of this project."</em></p>
                </div>
              ) : (
                <div className="message-history">
                  {messages.map(msg => (
                    <div key={msg.id} className={`message-bubble ${msg.role}`}>
                      <div className="who">{msg.role === "user" ? "You" : "M"}</div>
                      <div className="msg-main">
                        <div className="message-header">
                          <span className="role-label">{msg.role === "user" ? "You" : "Morrow"}</span>
                          {msg.role === "assistant" && msg.streamingState && msg.streamingState !== "completed" && (
                            <span className={`streaming-state ${msg.streamingState}`}>{STATUS_LABEL[msg.streamingState] || msg.streamingState}</span>
                          )}
                        </div>
                        {msg.content ? (
                          msg.role === "assistant" ? <div className="msg-text"><Markdown source={msg.content} /></div> : <p className="msg-text">{msg.content}</p>
                        ) : msg.streamingState === "queued" ? <p className="msg-text loading-pulse">Preparing workspace context…</p>
                          : msg.streamingState === "streaming" ? <p className="msg-text loading-pulse">Reading workspace and streaming answer…</p>
                          : msg.streamingState === "failed" ? <p className="msg-text muted">No response (the run failed).</p>
                          : msg.streamingState === "interrupted" ? <p className="msg-text muted">Interrupted before completion.</p>
                          : <p className="msg-text muted">[No response content]</p>}
                      </div>
                    </div>
                  ))}
                  <div ref={messageEndRef} />
                </div>
              )}
            </div>
            <form className="composer composer-form" onSubmit={handleSendMessage}>
              {composerError && <div className="composer-error" role="alert">{composerError}</div>}
              <div className="composer-box">
                <textarea
                  className="composer-input" rows={1}
                  value={composerPrompt}
                  onChange={e => setComposerPrompt(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement)?.requestSubmit(); } }}
                  placeholder={activeTaskId ? "Morrow is working…" : "Message Morrow…"}
                  disabled={!!activeTaskId}
                />
                {activeTaskId
                  ? <button type="button" className="stop-btn" onClick={handleStop}>Stop</button>
                  : <button type="submit" className="send-btn" aria-label="Send" disabled={!composerPrompt.trim()}><I.IconSend className="ico" style={{ width: 17, height: 17 }} /></button>}
              </div>
            </form>
          </div>
        )}

        {nav === "runs" && (
          <RunsView projects={projects} projectMeta={projectMeta} onOpen={(id) => { setNav("projects"); openProject(id, false); }} />
        )}

        {nav === "settings" && (
          <SettingsView
            tab={settingsTab} setTab={setSettingsTab}
            providers={providers} models={models} presets={presets} oauthFindings={oauthFindings}
            providerStatus={providerStatus}
            selectedProject={selectedProject} memoryEntries={memoryEntries}
            newMemoryContent={newMemoryContent} setNewMemoryContent={setNewMemoryContent}
            onAddMemory={handleAddMemory} onToggleMemory={handleToggleMemory} onDeleteMemory={handleDeleteMemory}
          />
        )}

        {["agents", "knowledge", "mcp", "tools", "stores", "audit", "billing", "help"].includes(nav) && (
          <PlaceholderView nav={nav} />
        )}
      </div>

      {/* Inspector */}
      {inspectorOpen && selectedProject && (
        <aside className="inspector" aria-label="Project inspector">
          <div className="insp-head">
            <div className="insp-title-row">
              <h3 className="insp-title">{selectedProject.name}</h3>
              <div className="insp-actions">
                <button aria-label="Pin"><I.IconPin className="ico" /></button>
                <button aria-label="More"><I.IconMore className="ico" /></button>
                <button aria-label="Close inspector" onClick={() => setSelectedProjectId("")}><I.IconClose className="ico" /></button>
              </div>
            </div>
            <div className="insp-sub">
              <Status s={taskState?.task?.status || projectMeta[selectedProject.id]?.status || "draft"} />
              <span className="agent-tag"><I.IconAgentFace className="ico" />{projectMeta[selectedProject.id]?.agent || "Assistant"}</span>
            </div>
          </div>
          <div className="insp-tabs">
            {(["overview", "files", "notes", "settings"] as InspTab[]).map(t => (
              <button key={t} className={`insp-tab ${inspTab === t ? "active" : ""}`} onClick={() => setInspTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
            ))}
          </div>

          <div className="insp-body">
            {inspTab === "overview" && (!taskState ? (
              <div className="insp-empty">No run yet. Open the project and ask the agent, or run a workspace inspection.</div>
            ) : (
              <>
                <Timeline events={taskState.events || []} running={taskState.task?.status === "running"} />
                {taskState.plan && taskState.plan.length > 0 && (
                  <div className="insp-block plan-section">
                    <h4>Plan ({taskState.plan.length} steps)</h4>
                    <ol className="plan-steps">
                      {taskState.plan.map((s, i) => (
                        <li key={s.id} className={`plan-step ${s.status}`}>
                          <span className="num">{i + 1}</span>
                          <div className="step-body"><div className="step-title">{s.title}</div><div className="step-desc">{s.description}</div></div>
                          <span className={`step-mark ${s.status === "completed" ? "" : s.status === "running" ? "" : s.status === "failed" ? "" : "pending"}`}>
                            {s.status === "completed" ? <I.IconCheck className="ico" /> : <I.IconCircle className="ico" />}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {taskState.routing && (
                  <div className="insp-block routing-section">
                    <h4>Provider routing</h4>
                    <ul className="kv-list">
                      <li><span className="kk">Provider</span><span className="vv">{taskState.routing.providerId}</span></li>
                      <li><span className="kk">Model</span><span className="vv">{taskState.routing.model}</span></li>
                      <li><span className="kk">Preset</span><span className="vv">{taskState.routing.presetId}</span></li>
                      {taskState.routing.fallbackUsed && <li><span className="kk">Note</span><span className="vv flag">fallback used</span></li>}
                    </ul>
                  </div>
                )}
                <div className="insp-block privacy-section">
                  <div className="insp-card">
                    <div className="privacy-head"><I.IconShield className="ico" /> Privacy</div>
                    <div className="privacy-body">
                      {taskState.disclosure?.networkAccess === "disabled" || taskState.routing?.privacy === "local-only"
                        ? "All data is processed locally on this machine. No data is sent to external services."
                        : "This run may send your prompt and selected file contents to the disclosed provider. Local data stays on this machine."}
                      <br /><span className="link">Learn about privacy ↗</span>
                    </div>
                  </div>
                </div>
                {taskState.disclosure && (
                  <div className="insp-block disclosure-section">
                    <h4>Execution disclosure</h4>
                    <ul className="kv-list">
                      <li><span className="kk">Mode</span><span className="vv">{taskState.disclosure.executionMode === "agent-interactive" ? "Agent interactive" : "Deterministic local"}</span></li>
                      <li><span className="kk">Network</span><span className="vv">{taskState.disclosure.networkAccess === "enabled" ? "Network enabled" : "Network disabled"}</span></li>
                      <li><span className="kk">Filesystem</span><span className="vv">Read-only</span></li>
                      <li><span className="kk">Model</span><span className="vv">{taskState.disclosure.modelInvocation ? "Model invocation enabled" : "No model invoked"}</span></li>
                      <li><span className="kk">Shell</span><span className="vv">No shell execution</span></li>
                      <li><span className="kk">Cost</span><span className="vv">{taskState.disclosure.estimatedCostUsd}</span></li>
                    </ul>
                  </div>
                )}
                {taskState.evidence && taskState.evidence.length > 0 && (
                  <div className="insp-block evidence-section">
                    <h4>Evidence ({taskState.evidence.length})</h4>
                    <ul className="evidence-list">
                      {taskState.evidence.map(ev => (
                        <li key={ev.id} className="evidence-item">
                          <I.IconFile className="file-ico" />
                          <span className="ev-name" title={ev.path}>{ev.path}</span>
                          <span className="ev-size">{fmtBytes((ev.metadata as any)?.size)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {taskState.toolCalls && taskState.toolCalls.length > 0 && (
                  <div className="insp-block tools-section">
                    <h4>Tool calls ({taskState.toolCalls.length})</h4>
                    <ul className="kv-list">
                      {taskState.toolCalls.map((tc: any) => (
                        <li key={tc.id}><span className="kk">{tc.toolName}</span><span className={`vv ${tc.status === "failed" ? "flag" : ""}`}>{tc.status}</span></li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="insp-block verification-section">
                  <h4>Verification</h4>
                  {taskState.verification ? (
                    <div className="verify-row">
                      <div className="verify-state verified"><I.IconCheck className="ico" /> Verified</div>
                    </div>
                  ) : (
                    <>
                      <div className="verify-row">
                        <div className="verify-state pending"><I.IconCircle className="ico" /> {planVerified ? "Verified" : "Pending"}</div>
                        <button className="btn" onClick={handleInspect}>Run inspection</button>
                      </div>
                      <div className="verify-sub">Run a deterministic workspace inspection to produce a verified result.</div>
                    </>
                  )}
                  {taskState.verification && <p className="verify-sub">{taskState.verification.summary}</p>}
                </div>
              </>
            ))}

            {inspTab === "files" && (
              <div className="insp-block">
                <h4>Files accessed</h4>
                {taskState?.evidence && taskState.evidence.length > 0 ? (
                  <ul className="evidence-list">{taskState.evidence.map(ev => (
                    <li key={ev.id} className="evidence-item"><I.IconFile className="file-ico" /><span className="ev-name">{ev.path}</span><span className="ev-size">{fmtBytes((ev.metadata as any)?.size)}</span></li>
                  ))}</ul>
                ) : <div className="insp-empty">No files have been read in this run.</div>}
              </div>
            )}
            {inspTab === "notes" && (
              <div className="insp-block">
                <h4>Project memory</h4>
                {memoryEntries.length === 0 ? <div className="insp-empty">No memory yet. Add notes in Settings → Data &amp; Memory.</div> : (
                  <ul className="memory-list">{memoryEntries.map(m => (
                    <li key={m.id} className={`memory-item ${m.enabled ? "" : "disabled"}`}><div className="memory-body"><span className="memory-content">{m.content}</span><span className="memory-meta">{m.scope} · {m.source}</span></div></li>
                  ))}</ul>
                )}
              </div>
            )}
            {inspTab === "settings" && (
              <div className="insp-block">
                <h4>Project</h4>
                <ul className="kv-list">
                  <li><span className="kk">Name</span><span className="vv">{selectedProject.name}</span></li>
                  <li><span className="kk">Workspace</span><span className="vv" style={{ wordBreak: "break-all" }}>{selectedProject.workspacePath}</span></li>
                  <li><span className="kk">Created</span><span className="vv">{new Date(selectedProject.createdAt).toLocaleString()}</span></li>
                </ul>
                <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => openProject(selectedProject.id, true)}>Open conversation</button>
              </div>
            )}
          </div>
        </aside>
      )}

      {/* New Project modal */}
      {newProjectOpen && (
        <div className="modal-overlay" onClick={() => setNewProjectOpen(false)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={handleCreateProject}>
            <h2>New Project</h2>
            <p className="modal-sub">Point Morrow at a local folder. Tools are read-only and scoped to this workspace.</p>
            {projectError && <div className="error-message" role="alert">{projectError}</div>}
            <div className="field">
              <label htmlFor="new-project-name">Name</label>
              <input id="new-project-name" value={newProjectName} onChange={e => setNewProjectName(e.target.value)} placeholder="Customer Feedback Analysis" required autoFocus />
            </div>
            <div className="field">
              <label htmlFor="new-workspace-path">Workspace Path</label>
              <input id="new-workspace-path" value={newWorkspacePath} onChange={e => setNewWorkspacePath(e.target.value)} placeholder="C:\\Users\\you\\projects\\repo" required />
              <span className="hint">An existing local directory. Morrow never leaves this folder.</span>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setNewProjectOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Create Project</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// ── Timeline ───────────────────────────────────────────────────────────────────
function Timeline({ events, running }: { events: TaskEvent[]; running: boolean }) {
  const items = events.map(ev => ({ ev, h: humanizeEvent(ev) })).filter(x => x.h) as { ev: TaskEvent; h: { label: string; desc?: string } }[];
  const shown = items.slice(-7);
  return (
    <div className="insp-block">
      <h4>Task Timeline</h4>
      {shown.length === 0 ? <div className="insp-empty">No activity yet.</div> : (
        <div className="timeline">
          {shown.map(({ ev, h }) => (
            <div key={ev.id} className="tl-item">
              <span className="tl-time">{fmtTime(ev.createdAt)}</span>
              <span className="tl-rail"><span className="tl-dot" /><span className="tl-line" /></span>
              <div className="tl-body"><span className="tl-label">{h.label}</span>{h.desc && <span className="tl-desc">{h.desc}</span>}</div>
            </div>
          ))}
          {running && (
            <div className="tl-item muted">
              <span className="tl-time">—</span>
              <span className="tl-rail"><span className="tl-dot" /><span className="tl-line" /></span>
              <div className="tl-body"><span className="tl-label">In progress…</span><span className="tl-desc">Streaming and reading the workspace</span></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Runs view ──────────────────────────────────────────────────────────────────
function RunsView({ projects, projectMeta, onOpen }: { projects: Project[]; projectMeta: Record<string, ProjectMeta>; onOpen: (id: string) => void }) {
  const rows = projects.filter(p => projectMeta[p.id]?.latestTaskId).sort((a, b) => ((projectMeta[a.id]?.updatedAt || "") < (projectMeta[b.id]?.updatedAt || "") ? 1 : -1));
  return (
    <>
      <div className="topbar"><h1>Runs</h1></div>
      {rows.length === 0 ? (
        <div className="empty"><I.IconRuns className="empty-ico" /><h3>No runs yet</h3><p>Runs appear here once you ask an agent or inspect a workspace.</p></div>
      ) : (
        <div className="table-wrap">
          <table className="ptable">
            <thead><tr><th>Project</th><th>Agent</th><th>Status</th><th>Updated</th></tr></thead>
            <tbody>{rows.map(p => { const m = projectMeta[p.id]!; return (
              <tr key={p.id} onClick={() => onOpen(p.id)}>
                <td><div className="cell-name"><I.IconRuns className="file-ico" /><div className="name-main">{p.name}</div></div></td>
                <td className="cell-agent">{m.agent}</td>
                <td><span className={`status ${m.status}`}><span className="dot" />{STATUS_LABEL[m.status] || m.status}</span></td>
                <td className="cell-updated">{fmtRelative(m.updatedAt)}</td>
              </tr>
            ); })}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ── Placeholder views ──────────────────────────────────────────────────────────
function PlaceholderView({ nav }: { nav: string }) {
  const copy: Record<string, { title: string; body: string; icon: (p: any) => React.ReactElement }> = {
    agents: { title: "Agents", body: "Named agents with their own role, tools, and memory are on the roadmap. Today, presets act as agent profiles — configure them in Settings → Presets.", icon: I.IconAgents },
    knowledge: { title: "Knowledge", body: "Project knowledge and document stores will live here. The deterministic memory foundation is available in Settings → Data & Memory.", icon: I.IconKnowledge },
    mcp: { title: "MCP Servers", body: "Model Context Protocol server connections will be managed here once the tool runtime is opened beyond the read-only workspace tools.", icon: I.IconMcp },
    tools: { title: "Tools", body: "The alpha ships read-only workspace tools (inspect, list, read) behind a shared containment layer. Write and terminal tools are gated until their safety boundaries ship.", icon: I.IconTools },
    stores: { title: "Stores", body: "Local data stores and connectors will appear here. All data is currently kept in a local SQLite database.", icon: I.IconStores },
    audit: { title: "Audit Log", body: "A full audit trail of tool calls and external data flow will live here. Per-run evidence and disclosures are already visible in the inspector.", icon: I.IconAudit },
    billing: { title: "Billing", body: "Morrow is local-first and self-hosted. There is nothing to bill — you bring your own provider keys.", icon: I.IconBilling },
    help: { title: "Help", body: "See the README and docs/providers.md for setup, the capability matrix, and manual verification steps.", icon: I.IconHelp },
  };
  const c = copy[nav] || copy.help;
  return (
    <div className="placeholder-view">
      <div className="topbar"><h1>{c.title}</h1></div>
      <div className="empty"><c.icon className="empty-ico" /><h3>{c.title}</h3><p>{c.body}</p></div>
    </div>
  );
}

// ── Settings view ──────────────────────────────────────────────────────────────
function SettingsView(props: {
  tab: SettingsTab; setTab: (t: SettingsTab) => void;
  providers: ProviderStatus[]; models: ModelStatus[]; presets: PresetStatus[]; oauthFindings: OAuthFinding[];
  providerStatus: { configured: boolean; provider: string; model: string } | null;
  selectedProject?: Project; memoryEntries: MemoryEntry[];
  newMemoryContent: string; setNewMemoryContent: (s: string) => void;
  onAddMemory: () => void; onToggleMemory: (id: string, e: boolean) => void; onDeleteMemory: (id: string) => void;
}) {
  const { tab, setTab, providers, models, presets, oauthFindings, providerStatus, selectedProject, memoryEntries } = props;
  return (
    <div className="placeholder-view">
      <div className="topbar"><h1>Settings</h1></div>
      <div className="settings">
        <div className="settings-tabs" role="tablist">
          {([["providers", "Providers"], ["models", "Models"], ["presets", "Presets"], ["privacy", "Privacy"], ["permissions", "Tool Permissions"], ["data", "Data & Memory"], ["diagnostics", "Diagnostics"]] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`settings-tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>

        {tab === "providers" && (
          <div className="settings-panel">
            <div className="card">
              <h3>Model Providers</h3>
              <p className="muted">Secrets are resolved server-side from environment variables and never reach the browser. Status shows only whether a provider is configured and which host it targets.</p>
              <div className="provider-grid">
                {providers.map(p => (
                  <div key={p.id} className={`provider-card ${p.configured ? "ok" : ""}`}>
                    <div className="provider-card-head"><strong>{p.label}</strong><span className={`badge ${p.configured ? "badge-ok" : "badge-muted"}`}>{p.configured ? "Configured" : "Not configured"}</span></div>
                    <div className="provider-card-meta">
                      <span className="kv"><span className="k">Kind</span>{p.kind}</span>
                      <span className="kv"><span className="k">Endpoint</span>{p.endpointHost ?? p.endpointType}</span>
                      <span className="kv"><span className="k">Auth</span>{p.authStatus}</span>
                    </div>
                    <div className="cap-row">
                      {p.capabilities.toolCalls && <span className="cap">tools</span>}
                      {p.capabilities.vision && <span className="cap">vision</span>}
                      {p.capabilities.systemMessages && <span className="cap">system</span>}
                      {p.capabilities.local && <span className="cap local">local</span>}
                    </div>
                    {!p.configured && p.setupHint && <p className="setup-hint">{p.setupHint}</p>}
                  </div>
                ))}
              </div>
            </div>
            <div className="card">
              <h3>API Key Setup</h3>
              <p className="muted">Add keys to the orchestrator environment, then restart it. Keys are never entered in the browser.</p>
              <pre className="code-block"><code>{`OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
OPENROUTER_API_KEY=...
DEEPSEEK_API_KEY=...
# Local, fully private (opt-in):
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1`}</code></pre>
            </div>
            <div className="card">
              <h3>Subscription OAuth (Codex / Claude / Gemini)</h3>
              <p className="muted">Morrow only labels a flow "OAuth" when it is an officially supported third-party integration.</p>
              <ul className="oauth-list">
                {oauthFindings.map(f => (
                  <li key={f.id} className="oauth-item"><div className="oauth-head"><strong>{f.label}</strong><span className="badge badge-muted">{f.status}</span></div><p className="oauth-reason">{f.reason}</p><p className="oauth-rec">{f.recommendation}</p></li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {tab === "models" && (
          <div className="settings-panel"><div className="card"><h3>Model Registry</h3><p className="muted">Built-in known models. IDs are configurable; availability follows configured providers. Context windows are shown only where well documented.</p>
            <table className="model-table"><thead><tr><th>Model</th><th>Provider</th><th>Context</th><th>Speed</th><th>Cost</th><th>Privacy</th><th>Status</th></tr></thead>
              <tbody>{models.map(({ model, available }) => (
                <tr key={model.id} className={available ? "" : "row-muted"}><td>{model.label}</td><td>{model.providerId}</td><td>{model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k` : "—"}</td><td>{model.speedClass}</td><td>{model.costClass}</td><td>{model.privacy}</td><td>{available ? <span className="badge-ok">available</span> : <span className="badge-muted">needs provider</span>}</td></tr>
              ))}</tbody></table>
          </div></div>
        )}

        {tab === "presets" && (
          <div className="settings-panel"><div className="card"><h3>Presets</h3><p className="muted">Each preset is a routing policy with concrete budgets. Unavailable presets explain why.</p>
            <div className="preset-grid">{presets.map(ps => (
              <div key={ps.preset.id} className={`preset-card ${ps.available ? "" : "unavailable"}`}>
                <div className="preset-card-head"><strong>{ps.preset.label}</strong>{ps.available ? <span className="badge-ok">{ps.resolved?.providerId} · {ps.resolved?.model}</span> : <span className="badge-muted">unavailable</span>}</div>
                <p className="preset-desc">{ps.preset.description}</p>
                <div className="preset-meta"><span>{ps.preset.privacyDescription}</span><span>{ps.preset.costDescription}</span></div>
                {!ps.available && ps.unavailableReason && <p className="preset-reason">{ps.unavailableReason}</p>}
              </div>
            ))}</div>
          </div></div>
        )}

        {tab === "privacy" && (
          <div className="settings-panel"><div className="card"><h3>Privacy</h3><ul className="bullet-list">
            <li>Morrow is local-first: projects, conversations, and memory live in a local SQLite database.</li>
            <li>API keys live only in the orchestrator environment, never in the database, browser, logs, or task events.</li>
            <li>Hosted providers receive your prompt and any file content the agent reads. The active provider and model are disclosed per run.</li>
            <li>The <strong>Private Local</strong> preset routes only to local providers (Ollama); nothing leaves your machine.</li>
            <li>Default tools are read-only and scoped to the project workspace. Secret files (.env, keys, credentials) are rejected.</li>
          </ul></div></div>
        )}

        {tab === "permissions" && (
          <div className="settings-panel"><div className="card"><h3>Tool Permissions</h3><p className="muted">The alpha tool profile is read-only and enforced by a shared containment layer.</p>
            <table className="perm-table"><thead><tr><th>Tool</th><th>Access</th><th>Status</th></tr></thead><tbody>
              <tr><td>inspect_workspace</td><td>read-only</td><td><span className="badge-ok">enabled</span></td></tr>
              <tr><td>list_files</td><td>read-only</td><td><span className="badge-ok">enabled</span></td></tr>
              <tr><td>read_file</td><td>read-only, bounded</td><td><span className="badge-ok">enabled</span></td></tr>
              <tr><td>write_file</td><td>requires approval, diff, rollback</td><td><span className="badge-muted">not enabled (future)</span></td></tr>
              <tr><td>run_command</td><td>requires approval, sandbox</td><td><span className="badge-muted">not enabled (future)</span></td></tr>
            </tbody></table>
          </div></div>
        )}

        {tab === "data" && (
          <div className="settings-panel">
            <div className="card"><h3>Project Memory</h3><p className="muted">Deterministic, project-isolated memory for <strong>{selectedProject?.name ?? "the selected project"}</strong>. Each entry has a source and timestamp, can be disabled, and never crosses projects.</p>
              {selectedProject ? (<>
                <div className="memory-add"><input aria-label="New memory" value={props.newMemoryContent} onChange={e => props.setNewMemoryContent(e.target.value)} placeholder="Add a fact Morrow should remember…" /><button className="primary-btn" onClick={props.onAddMemory} disabled={!props.newMemoryContent.trim()}>Add</button></div>
                {memoryEntries.length === 0 ? <p className="empty-state">No memory entries yet.</p> : (
                  <ul className="memory-list">{memoryEntries.map(m => (
                    <li key={m.id} className={`memory-item ${m.enabled ? "" : "disabled"}`}>
                      <input type="checkbox" checked={m.enabled} onChange={e => props.onToggleMemory(m.id, e.target.checked)} aria-label="Toggle memory" />
                      <div className="memory-body"><span className="memory-content">{m.content}</span><span className="memory-meta">{m.scope} · {m.source} · {new Date(m.createdAt).toLocaleDateString()}</span></div>
                      <button className="icon-btn" aria-label="Delete memory" onClick={() => props.onDeleteMemory(m.id)}>✕</button>
                    </li>
                  ))}</ul>
                )}
              </>) : <p className="empty-state">Select a project (from Projects) to manage its memory.</p>}
            </div>
            <div className="card"><h3>Storage</h3><p className="muted">Data is stored locally in SQLite at <span className="codeword">.morrow/morrow.db</span>. Test runs use isolated temporary databases.</p></div>
          </div>
        )}

        {tab === "diagnostics" && (
          <div className="settings-panel"><div className="card"><h3>Diagnostics</h3><ul className="diag-list">
            <li><span className="k">Default provider</span>{providerStatus?.configured ? `${providerStatus.provider} · ${providerStatus.model}` : "none configured"}</li>
            <li><span className="k">Configured providers</span>{providers.filter(p => p.configured).map(p => p.id).join(", ") || "none"}</li>
            <li><span className="k">Available presets</span>{presets.filter(p => p.available).map(p => p.preset.id).join(", ") || "none"}</li>
            <li><span className="k">Known models</span>{models.length}</li>
          </ul></div></div>
        )}
      </div>
    </div>
  );
}
