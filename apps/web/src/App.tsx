import React, { useState, useEffect, useRef, useMemo } from "react";
import { apiClient } from "./api/client";
import type {
  Project, Task, TaskEvent, PlanStep, TaskEvidence, ExecutionDisclosure,
  ConversationMessage, VerificationResult,
  PresetStatus, ProviderStatus, ModelStatus, OAuthFinding, MemoryEntry, RoutingDecision,
  Agent, AgentToolPermission, AgentSkillAccess,
} from "@morrow/contracts";
import { Markdown } from "./Markdown";
import * as I from "./icons";
import "./App.css";
import { OnboardingHub } from "./components/OnboardingWizard";
import { SkillsControlCenter } from "./components/SkillsControlCenter";
import { MissionControl } from "./components/MissionControl";
import { SystemHealth } from "./components/SystemHealth";
import { DownloadPage } from "./components/DownloadPage";
import { ProviderManager, SubscriptionLogin } from "./components/ProviderManager";

type Nav = "missions" | "projects" | "runs" | "agents" | "skills" | "browser" | "files" | "memory" | "automations" | "approvals" | "settings" | "system" | "download" | "help";
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
  const [onboardState, setOnboardState] = useState<{ onboarded: boolean; onboardingStep: string | null; useCase: string | null; name: string | null } | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectMeta, setProjectMeta] = useState<Record<string, ProjectMeta>>({});
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [nav, setNav] = useState<Nav>("projects");
  const [moreOpen, setMoreOpen] = useState(false);
  // On narrow/mobile widths the sidebar is an off-canvas drawer. Without a way to
  // open it the entire navigation was unreachable below 820px.
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
  // Full-autonomy (YOLO): when on, the agent runs commands and writes files
  // without per-action approval prompts. Off by default for safety.
  const [autonomous, setAutonomous] = useState(false);

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
  const chatScrollRef = useRef<HTMLDivElement>(null);
  // Whether the chat is "pinned" to the bottom. Stays true while the user is
  // reading the latest output; flips to false the moment they scroll up so the
  // view stops yanking back down on every streamed token.
  const stickToBottomRef = useRef(true);
  const eventUnsubRef = useRef<(() => void) | null>(null);
  // Highest evidence-stream sequence already folded into a message's content,
  // keyed by taskId. Makes streamed-delta application idempotent so replays
  // (reconnects, reopening a conversation) never double-append the text.
  const appliedDeltaSeqRef = useRef<Map<string, number>>(new Map());

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
    apiClient.getOnboardingState().then(setOnboardState).catch(console.error);
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
    stickToBottomRef.current = true; // opening a conversation lands at the bottom.
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

  // Auto-scroll to the newest message ONLY when the user is already pinned to
  // the bottom. Scrolling the container directly (not scrollIntoView) avoids
  // dragging parent layout, and "auto" avoids the janky animation that fought
  // the user on every streamed delta.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleChatScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 80;
  };

  // Aggregate + SSE for the focused task
  useEffect(() => {
    if (!focusedTaskId) { setTaskState(null); if (eventUnsubRef.current) { eventUnsubRef.current(); eventUnsubRef.current = null; } return; }
    let live = true;
    let unsub: (() => void) | null = null;
    const TERMINAL_STATUS = ["completed", "verified", "failed", "cancelled", "interrupted"];
    const taskId = focusedTaskId;

    // The aggregate endpoint already includes toolCalls + routing; read them
    // directly rather than racing a second fetch whose failure path dropped
    // toolCalls (the cause of the empty tool-call panel).
    const fetchAgg = () =>
      apiClient.getTaskAggregate(taskId).then((agg: any) => {
        if (!live) return null;
        setTaskState({ ...agg, toolCalls: agg.toolCalls ?? [], routing: agg.routing ?? null });
        // Release the composer lock as soon as the focused task is terminal, even
        // if the terminal SSE event was missed (e.g. the run finished before the
        // stream attached). Keeps the input from sticking on "Morrow is working...".
        if (TERMINAL_STATUS.includes(agg?.task?.status)) {
          setActiveTaskId(prev => (prev === taskId ? "" : prev));
        }
        return agg;
      });

    // Fetch the aggregate first, THEN decide. A terminal task needs no live
    // stream — subscribing would only replay its deltas and briefly double the
    // (already-final) message text, so we skip it entirely. For a task that is
    // still streaming we rebuild its message text from a full replay (reset to
    // "" + baseline 0), so reopening a conversation or reconnecting can never
    // double-apply or drop deltas.
    fetchAgg().then((agg: any) => {
      if (!live || !agg) return;
      if (TERMINAL_STATUS.includes(agg?.task?.status)) return;
      appliedDeltaSeqRef.current.set(taskId, 0);
      setMessages(prev => prev.map(m => (m.taskId === taskId ? { ...m, content: "" } : m)));
      unsub = apiClient.subscribeToTaskEvents(taskId, 0, (event) => {
        if (!live) return;
        const isTextDelta = event.type === "evidence.persisted" && !!event.payload.deltaText;
        // Refresh the inspector aggregate only on structural events. Doing it on
        // every streamed token fired one full-aggregate fetch per token, spamming
        // the local server during long answers.
        if (!isTextDelta) fetchAgg();
        if (isTextDelta) {
          const applied = appliedDeltaSeqRef.current.get(taskId) ?? 0;
          if (event.sequence <= applied) return; // already folded in; ignore replay.
          appliedDeltaSeqRef.current.set(taskId, event.sequence);
          const delta = event.payload.deltaText as string;
          setMessages(prev => prev.map(m => m.taskId === taskId ? { ...m, content: m.content + delta, streamingState: "streaming" } : m));
        }
      }, () => {
        if (!live) return;
        if (activeConversationId) apiClient.listMessages(activeConversationId).then(setMessages).catch(() => {});
        if (selectedProjectId) loadProjectMeta(projects);
        // The focused task reached a terminal state (the SSE stream closes on a
        // task.completed/verified/failed/cancelled/interrupted event). Release the
        // composer lock so the user can type the next message; without this the UI
        // stays stuck on "Morrow is working..." after the answer finishes.
        setActiveTaskId(prev => (prev === taskId ? "" : prev));
      });
      eventUnsubRef.current = unsub;
    }).catch(console.error);

    return () => { live = false; if (unsub) unsub(); if (eventUnsubRef.current === unsub) eventUnsubRef.current = null; };
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
    stickToBottomRef.current = true; // sending a message re-pins to the latest.
    try {
      const convId = await ensureConversation();
      const res = await apiClient.sendMessage(convId, content, { preset: activePreset, useMemory: true, mode: "agent", autoApprove: autonomous });
      setMessages(prev => [...prev, res.userMessage, res.assistantMessage]);
      setActiveTaskId(res.task.id);
      setFocusedTaskId(res.task.id);
    } catch (err: any) { setComposerError(err.message || "Failed to send message"); }
  };

  // Zero-setup chat: provision a default scratch workspace + conversation and
  // jump straight into it, no mission/project setup required.
  const handleNewChat = async () => {
    stickToBottomRef.current = true;
    try {
      const qc = await apiClient.quickChat();
      // quickChat may have just created the scratch project. The conversation
      // view only renders once selectedProject resolves from `projects`, so make
      // sure the project is in state before switching to it — otherwise the
      // first-ever New Chat lands on a blank screen.
      let list = projects;
      if (!list.some(p => p.id === qc.projectId)) {
        list = await apiClient.listProjects();
        setProjects(list);
        loadProjectMeta(list);
      }
      setSelectedProjectId(qc.projectId);
      setActiveConversationId(qc.conversationId);
      setNav("projects");
      setView("conversation");
      setActiveTaskId("");
      setFocusedTaskId("");
      const msgs = await apiClient.listMessages(qc.conversationId);
      setMessages(msgs);
    } catch (err: any) { setComposerError(err.message || "Failed to start chat"); }
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
    <button className={`nav-item ${nav === id ? "active" : ""}`} onClick={() => { setNav(id); if (id === "projects") setView("list"); setSidebarOpen(false); }}>
      <Icon className="ico" /> {label}
    </button>
  );
  const Status = ({ s }: { s: string }) => (<span className={`status ${s}`}><span className="dot" />{STATUS_LABEL[s] || s}</span>);

  const focusedTask = taskState?.task;
  const planVerified = focusedTask?.status === "verified";

  const handleResetOnboarding = async () => {
    if (window.confirm("Are you sure you want to reset your onboarding status and rerun setup?")) {
      try {
        await apiClient.resetOnboardingState();
        setOnboardState({ onboarded: false, onboardingStep: "welcome", useCase: null, name: null });
      } catch (e) {
        console.error(e);
      }
    }
  };

  if (onboardState && !onboardState.onboarded) {
    return (
      <OnboardingHub
        state={onboardState}
        providers={providers}
        onRefreshProviders={async () => {
          setProviders(await apiClient.listProviders());
          setProviderStatus(await apiClient.getProviderStatus());
        }}
        onComplete={async (projectId?: string) => {
          setOnboardState({ onboarded: true, onboardingStep: null, useCase: null, name: null });
          const nextProjects = await apiClient.listProjects();
          setProjects(nextProjects);
          await loadProjectMeta(nextProjects);
          if (projectId) {
            setNav("projects");
            await openProject(projectId, true);
          }
        }}
      />
    );
  }

  return (
    <div className={`morrow-app ${inspectorOpen ? "with-inspector" : ""} ${sidebarOpen ? "sidebar-open" : ""}`}>
      {/* Mobile navigation toggle — only visible on narrow widths (see CSS). */}
      <button
        className="nav-toggle"
        aria-label={sidebarOpen ? "Close navigation" : "Open navigation"}
        aria-expanded={sidebarOpen}
        onClick={() => setSidebarOpen(o => !o)}
      >
        <I.IconMore className="ico" />
      </button>
      {/* Backdrop dismisses the drawer on narrow widths. */}
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
      {/* Sidebar */}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand"><div className="brand-mark">M</div><div className="brand-name">Morrow</div></div>
        <nav className="nav">
          <button className="nav-item nav-item--primary" onClick={() => { handleNewChat(); setSidebarOpen(false); }}>
            <I.IconSend className="ico" /><span>New Chat</span>
          </button>
          {/* Core, everyday destinations. */}
          <NavItem id="projects" label="Missions" icon={I.IconRuns} />
          <NavItem id="missions" label="Mission Control" icon={I.IconSend} />
          <NavItem id="agents" label="Agents" icon={I.IconAgents} />
          <NavItem id="skills" label="Skills" icon={I.IconTools} />
          <NavItem id="runs" label="Runs" icon={I.IconRuns} />
          <div className="nav-divider" />
          <NavItem id="settings" label="Settings" icon={I.IconSettings} />
          {/* Secondary + not-yet-built destinations, collapsed by default to keep
              the primary navigation focused. */}
          <button className="nav-item nav-more" onClick={() => setMoreOpen(o => !o)} aria-expanded={moreOpen}>
            <I.IconMore className="ico" /><span>More</span>
            <I.IconChevron className="ico nav-more-chev" style={{ marginLeft: "auto", transform: moreOpen ? "rotate(90deg)" : undefined }} />
          </button>
          {moreOpen && (
            <div className="nav-more-group">
              <NavItem id="browser" label="Browser" icon={I.IconKnowledge} />
              <NavItem id="files" label="Files" icon={I.IconFile} />
              <NavItem id="memory" label="Memory" icon={I.IconKnowledge} />
              <NavItem id="automations" label="Automations" icon={I.IconSettings} />
              <NavItem id="approvals" label="Approvals" icon={I.IconShield} />
              <NavItem id="system" label="System Health" icon={I.IconSettings} />
              <NavItem id="download" label="Install from Source" icon={I.IconHelp} />
              <NavItem id="help" label="Help" icon={I.IconHelp} />
            </div>
          )}
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
        {nav === "projects" && (view === "list" || !selectedProject) && (
          <>
            <div className="topbar">
              <h1>Missions</h1>
              <div className="spacer" />
              <button className="btn btn-primary" onClick={() => setNewProjectOpen(true)}><I.IconPlus className="ico" /> New Project</button>
            </div>
            <div className="toolbar">
              <div className="search">
                <I.IconSearch className="ico" />
                <input placeholder="Search missions…" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search missions" />
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
                <h3>No missions yet</h3>
                <p>Create a mission by pointing Morrow at a local folder. The agent will run within your workspace and report evidence.</p>
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
                <div className="table-footer">{filteredProjects.length} of {projects.length} mission{projects.length === 1 ? "" : "s"}</div>
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
            <div className="chat-scroll" ref={chatScrollRef} onScroll={handleChatScroll}>
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
              <label className="composer-autonomy" title="When on, Morrow runs commands and edits files without asking for approval each time.">
                <input type="checkbox" checked={autonomous} onChange={e => setAutonomous(e.target.checked)} />
                <span>Full autonomy{autonomous ? " — on (no approval prompts)" : ""}</span>
              </label>
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
            onResetOnboarding={handleResetOnboarding}
            onProvidersChanged={async () => {
              setProviders(await apiClient.listProviders());
              setModels(await apiClient.listModels());
              setProviderStatus(await apiClient.getProviderStatus());
            }}
          />
        )}

        {nav === "agents" && (
          <AgentsPanel
            selectedProject={selectedProject}
            projects={projects}
            onNavigateToProject={(id) => { setSelectedProjectId(id); setNav("projects"); setView("list"); }}
          />
        )}

        {nav === "skills" && <SkillsControlCenter />}
        {nav === "missions" && <MissionControl />}
        {nav === "system" && <SystemHealth />}
        {nav === "download" && <DownloadPage />}

        {["browser", "files", "memory", "automations", "approvals", "help"].includes(nav) && (
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
    browser: { title: "Browser", body: "Web automation and research via Playwright/CDP. Real Chromium browser sessions with semantic actions, navigation, downloads, screenshots, and persisted audit records (B15). Open a project and use browser tools from the conversation.", icon: I.IconKnowledge },
    files: { title: "Files", body: "File operations are scoped to your project workspace. Every read and write is logged to the audit trail. Secret files (.env, keys, credentials) are automatically rejected.", icon: I.IconFile },
    memory: { title: "Memory", body: "Deterministic, project-isolated memory. Each entry has a source and timestamp. Memory never crosses projects and can be disabled or deleted. Manage memory from Settings → Data & Memory.", icon: I.IconKnowledge },
    automations: { title: "Automations", body: "Scheduled tasks, cron jobs, and automated workflows are on the roadmap. The cron scheduler foundation is implemented — automations UI is coming in a future release.", icon: I.IconSettings },
    approvals: { title: "Approvals", body: "Approval requests appear when an agent needs to run a command, write a file, or perform an action that requires confirmation. You can approve once, trust the pattern, or deny.", icon: I.IconShield },
    help: { title: "Help", body: "See the README and docs/providers.md for setup, the capability matrix, and manual verification steps. Use the System Health page to diagnose issues.", icon: I.IconHelp },
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
  onResetOnboarding: () => void;
  onProvidersChanged: () => Promise<void>;
}) {
  const { tab, setTab, providers, models, presets, oauthFindings, providerStatus, selectedProject, memoryEntries, onResetOnboarding, onProvidersChanged } = props;
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
              <p className="muted">Paste an API key, save, and test — no PowerShell, no environment variables, no restart. Keys are stored on this machine in Morrow's secrets file (owner-readable) and are never kept in the browser.</p>
              <ProviderManager providers={providers} onChanged={onProvidersChanged} />
            </div>
            <div className="card">
              <h3>Subscription sign-in (Claude / Codex)</h3>
              <p className="muted">Sign in with your Claude or ChatGPT/Codex subscription using the same first-party OAuth flow the official CLIs use. <strong>Read the warning on each card:</strong> this reuses first-party OAuth client ids, may be subject to provider terms of service, and tokens are stored locally on this machine.</p>
              <SubscriptionLogin onConnectionChange={onProvidersChanged} />
              {oauthFindings.filter(f => f.status === "unavailable").map(f => (
                <p key={f.id} className="setup-hint" style={{ marginTop: 10 }}>
                  <strong>{f.label}:</strong> {f.reason}{f.documentationUrl ? <> <a href={f.documentationUrl} target="_blank" rel="noopener noreferrer">Docs ↗</a></> : null}
                </p>
              ))}
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
              <tr><td>search_text</td><td>read-only, bounded</td><td><span className="badge-ok">enabled</span></td></tr>
              <tr><td>search_files</td><td>read-only, bounded</td><td><span className="badge-ok">enabled</span></td></tr>
              <tr><td>git_status</td><td>read-only, bounded</td><td><span className="badge-ok">enabled</span></td></tr>
              <tr><td>git_diff</td><td>read-only, bounded</td><td><span className="badge-ok">enabled</span></td></tr>
              <tr><td>git_log</td><td>read-only, bounded</td><td><span className="badge-ok">enabled</span></td></tr>
              <tr><td>write_file</td><td>requires approval, diff, rollback</td><td><span className="badge-muted">not enabled (future)</span></td></tr>
              <tr><td>run_command</td><td>requires approval, sandbox</td><td><span className="badge-muted">not enabled (future)</span></td></tr>
            </tbody></table>
          </div></div>
        )}

        {tab === "data" && (
          <div className="settings-panel">
            <div className="card"><h3>Project Memory</h3><p className="muted">Deterministic, project-isolated memory for <strong>{selectedProject?.name ?? "the selected project"}</strong>. Each entry has a source and timestamp, can be disabled, and never crosses projects.</p>
              {selectedProject ? (
                <>
                  <div className="memory-add">
                    <input aria-label="New memory" value={props.newMemoryContent} onChange={e => props.setNewMemoryContent(e.target.value)} placeholder="Add a fact Morrow should remember…" />
                    <button className="primary-btn" onClick={props.onAddMemory} disabled={!props.newMemoryContent.trim()}>Add</button>
                  </div>
                  {memoryEntries.length === 0 ? <p className="empty-state">No memory entries yet.</p> : (
                    <ul className="memory-list">{memoryEntries.map(m => (
                      <li key={m.id} className={`memory-item ${m.enabled ? "" : "disabled"}`}>
                        <input type="checkbox" checked={m.enabled} onChange={e => props.onToggleMemory(m.id, e.target.checked)} aria-label="Toggle memory" />
                        <div className="memory-body"><span className="memory-content">{m.content}</span><span className="memory-meta">{m.scope} · {m.source} · {new Date(m.createdAt).toLocaleDateString()}</span></div>
                        <button className="icon-btn" aria-label="Delete memory" onClick={() => props.onDeleteMemory(m.id)}>✕</button>
                      </li>
                    ))}</ul>
                  )}
                </>
              ) : <p className="empty-state">Select a project (from Projects) to manage its memory.</p>}
            </div>
            <div className="card"><h3>Storage</h3><p className="muted">Data is stored locally in SQLite at <span className="codeword">~/.morrow/morrow.db</span>. Project-local <span className="codeword">.morrow</span> remains available for workspace metadata. Test runs use isolated temporary databases.</p></div>
          </div>
        )}

        {tab === "diagnostics" && (
          <div className="settings-panel">
            <div className="card">
              <h3>Diagnostics</h3>
              <ul className="diag-list">
                <li><span className="k">Default provider</span>{providerStatus?.configured ? `${providerStatus.provider} · ${providerStatus.model}` : "none configured"}</li>
                <li><span className="k">Configured providers</span>{providers.filter(p => p.configured).map(p => p.id).join(", ") || "none"}</li>
                <li><span className="k">Available presets</span>{presets.filter(p => p.available).map(p => p.preset.id).join(", ") || "none"}</li>
                <li><span className="k">Known models</span>{models.length}</li>
              </ul>
            </div>
            <div className="card" style={{ marginTop: 16 }}>
              <h3>Onboarding Setup</h3>
              <p className="muted">Reset your onboarding status and rerun the guided Morrow setup wizard at any time.</p>
              <button className="btn" onClick={onResetOnboarding} style={{ marginTop: 10 }}>Rerun Guided Onboarding</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Agents Panel ──────────────────────────────────────────────────────────────
const AGENT_ROLES = ["assistant", "code-reviewer", "researcher", "writer", "architect", "tester", "devops", "security", "custom"] as const;
const ROLE_LABELS: Record<string, string> = {
  assistant: "Assistant", "code-reviewer": "Code Reviewer", researcher: "Researcher",
  writer: "Writer", architect: "Architect", tester: "Tester",
  devops: "DevOps", security: "Security", custom: "Custom",
};
const AVAILABLE_TOOLS = [
  "filesystem-read", "filesystem-write", "command-exec", "search",
  "network", "git-inspection", "vision", "image-gen", "browser", "terminal",
];

interface AgentsPanelProps {
  selectedProject?: Project;
  projects: Project[];
  onNavigateToProject: (id: string) => void;
}

function AgentsPanel({ selectedProject, projects }: AgentsPanelProps) {
  const [projectFilter, setProjectFilter] = useState<string>(selectedProject?.id || "all");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Modal state
  const [showCreate, setShowCreate] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [showPermissions, setShowPermissions] = useState<Agent | null>(null);
  const [showSkills, setShowSkills] = useState<Agent | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formRole, setFormRole] = useState<string>("assistant");
  const [formInstructions, setFormInstructions] = useState("");
  const [formProviderOverride, setFormProviderOverride] = useState("");
  const [formModelOverride, setFormModelOverride] = useState("");
  const [formError, setFormError] = useState("");

  // Permission / skill state
  const [agentPerms, setAgentPerms] = useState<AgentToolPermission[]>([]);
  const [agentSkills, setAgentSkills] = useState<AgentSkillAccess[]>([]);

  const loadAgents = async (projectId: string) => {
    if (!projectId || projectId === "all") { setAgents([]); return; }
    setLoading(true); setError("");
    try {
      const list = await apiClient.listProjectAgents(projectId);
      setAgents(list);
    } catch (e: any) {
      setError(e.message || "Failed to load agents");
    } finally { setLoading(false); }
  };

  useEffect(() => {
    const pid = projectFilter === "all" ? selectedProject?.id ?? "" : projectFilter;
    if (pid) loadAgents(pid);
    else setAgents([]);
  }, [projectFilter]);

  const projectForAgent = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of agents) { map[a.id] = a.projectId; }
    return map;
  }, [agents]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault(); setFormError("");
    const pid = projectFilter === "all" ? selectedProject?.id : projectFilter;
    if (!pid) { setFormError("Select a project first"); return; }
    try {
      const agent = await apiClient.createAgent(pid, {
        name: formName.trim(),
        role: formRole as any,
        instructions: formInstructions.trim() || undefined,
        providerOverride: formProviderOverride.trim() || undefined,
        modelOverride: formModelOverride.trim() || undefined,
      });
      setAgents(prev => [...prev, agent]);
      setShowCreate(false); resetForm();
    } catch (e: any) { setFormError(e.message || "Failed to create agent"); }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault(); setFormError("");
    if (!editingAgent) return;
    const pid = projectForAgent[editingAgent.id];
    if (!pid) { setFormError("Cannot determine project"); return; }
    try {
      const updated = await apiClient.updateAgent(editingAgent.id, pid, {
        name: formName.trim() || undefined,
        role: formRole as any,
        instructions: formInstructions.trim() || null,
        providerOverride: formProviderOverride.trim() || null,
        modelOverride: formModelOverride.trim() || null,
      });
      setAgents(prev => prev.map(a => a.id === updated.id ? updated : a));
      setEditingAgent(null); resetForm();
    } catch (e: any) { setFormError(e.message || "Failed to update agent"); }
  };

  const handleDelete = async (agent: Agent) => {
    if (!window.confirm(`Delete agent "${agent.name}"? This cannot be undone.`)) return;
    const pid = projectForAgent[agent.id];
    if (!pid) return;
    try {
      await apiClient.deleteAgent(agent.id, pid);
      setAgents(prev => prev.filter(a => a.id !== agent.id));
    } catch (e: any) { setError(e.message || "Failed to delete agent"); }
  };

  const handleToggleEnabled = async (agent: Agent) => {
    const pid = projectForAgent[agent.id];
    if (!pid) return;
    try {
      const updated = await apiClient.updateAgent(agent.id, pid, { enabled: !agent.enabled });
      setAgents(prev => prev.map(a => a.id === updated.id ? updated : a));
    } catch (e: any) { setError(e.message || "Failed to toggle agent"); }
  };

  const startEdit = (agent: Agent) => {
    setEditingAgent(agent);
    setFormName(agent.name);
    setFormRole(agent.role);
    setFormInstructions(agent.instructions || "");
    setFormProviderOverride(agent.providerOverride || "");
    setFormModelOverride(agent.modelOverride || "");
    setFormError("");
  };

  const resetForm = () => {
    setFormName(""); setFormRole("assistant"); setFormInstructions("");
    setFormProviderOverride(""); setFormModelOverride(""); setFormError("");
  };

  // ── Permission management ──────────────────────────────────────────────────
  const openPermissions = async (agent: Agent) => {
    setShowPermissions(agent);
    try {
      const perms = await apiClient.listAgentToolPermissions(agent.id);
      setAgentPerms(perms);
    } catch { setAgentPerms([]); }
  };

  const toggleToolPermission = async (toolName: string, effect: "allow" | "deny") => {
    if (!showPermissions) return;
    // Remove existing permission for this tool first, then add the new one
    const existing = agentPerms.find(p => p.toolName === toolName);
    try {
      if (existing && existing.effect === effect) {
        // Toggle off: remove permission
        await apiClient.deleteToolPermission(showPermissions.id, toolName);
        setAgentPerms(prev => prev.filter(p => p.toolName !== toolName));
      } else {
        const perm = await apiClient.upsertToolPermission(showPermissions.id, { toolName, effect, priority: 1 });
        setAgentPerms(prev => [...prev.filter(p => p.toolName !== toolName), perm]);
      }
    } catch (e: any) { setError(e.message || "Failed to set permission"); }
  };

  const getToolEffect = (toolName: string): "allow" | "deny" | "unset" => {
    const p = agentPerms.find(p => p.toolName === toolName);
    return p?.effect || "unset";
  };

  // ── Skill access management ────────────────────────────────────────────────
  const openSkills = async (agent: Agent) => {
    setShowSkills(agent);
    try {
      const skills = await apiClient.listAgentSkillAccess(agent.id);
      setAgentSkills(skills);
    } catch { setAgentSkills([]); }
  };

  const toggleSkillAccess = async (skillId: string) => {
    if (!showSkills) return;
    const existing = agentSkills.find(s => s.skillId === skillId);
    const newAllowed = existing ? !existing.allowed : false;
    try {
      const sa = await apiClient.upsertSkillAccess(showSkills.id, { skillId, allowed: newAllowed });
      setAgentSkills(prev => [...prev.filter(s => s.skillId !== skillId), sa]);
    } catch (e: any) { setError(e.message || "Failed to set skill access"); }
  };

  const isSkillAllowed = (skillId: string): boolean => {
    const s = agentSkills.find(s => s.skillId === skillId);
    return s ? s.allowed : true; // default: allowed
  };

  // ── Skills list ────────────────────────────────────────────────────────────
  const SKILL_LABELS: Record<string, string> = {
    accessibility: "Accessibility", "api-integration": "API Integration",
    "architecture-review": "Architecture Review", "ci-cd": "CI/CD Pipeline",
    "code-refactor": "Code Refactor", "code-review": "Code Review",
    coding: "Coding", "config-management": "Config Management",
    "data-analysis": "Data Analysis", database: "Database",
    "dependency-audit": "Dependency Audit", diagnostics: "Diagnostics",
    documentation: "Documentation", "file-ops": "File Operations",
    "git-inspection": "Git Inspection", "input-validation": "Input Validation",
    linting: "Linting", "migration-planner": "Migration Planner",
    performance: "Performance", "repository-inspection": "Repository Inspection",
    "secrets-scan": "Secrets Scan", "shell-automation": "Shell Automation",
    "task-management": "Task Management", "template-generator": "Template Generator",
    testing: "Testing", "web-search": "Web Search",
  };
  const SKILL_IDS = Object.keys(SKILL_LABELS);

  const pid = projectFilter === "all" ? selectedProject?.id : projectFilter;

  return (
    <div className="agents-panel">
      <div className="topbar">
        <h1>Agents</h1>
        <div className="spacer" />
        <div className="toolbar" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label className="select" style={{ minWidth: 180 }}>
            <select value={projectFilter} onChange={e => setProjectFilter(e.target.value)} aria-label="Filter by project">
              <option value="all">{selectedProject ? selectedProject.name : "All Projects"}</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary" onClick={() => { resetForm(); setShowCreate(true); }} disabled={!pid}>
            <I.IconPlus className="ico" /> New Agent
          </button>
        </div>
      </div>

      {error && <div className="error-message" role="alert" style={{ margin: "10px 22px" }}>{error}</div>}

      {!pid ? (
        <div className="empty">
          <I.IconAgents className="empty-ico" />
          <h3>Select a project</h3>
          <p>Agents are scoped to a project. Select a project above to manage its agent team.</p>
        </div>
      ) : loading ? (
        <div className="empty"><p>Loading agents...</p></div>
      ) : agents.length === 0 ? (
        <div className="empty">
          <I.IconAgents className="empty-ico" />
          <h3>No agents yet</h3>
          <p>Create named agents with specific roles, tool permissions, and skill access. Agents can be assigned to tasks for focused work.</p>
          <button className="btn btn-primary" onClick={() => { resetForm(); setShowCreate(true); }}><I.IconPlus className="ico" /> New Agent</button>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="ptable">
            <colgroup><col className="c-name" /><col className="c-role" /><col className="c-tools" /><col className="c-skills" /><col className="c-status" /><col className="c-menu" /></colgroup>
            <thead><tr><th>Name</th><th>Role</th><th>Tool Permissions</th><th>Skills</th><th>Status</th><th /></tr></thead>
            <tbody>
              {agents.map(agent => (
                <tr key={agent.id}>
                  <td>
                    <div className="cell-name">
                      <I.IconAgentFace className="file-ico" />
                      <div>
                        <div className="name-main">{agent.name}</div>
                        {agent.instructions && <div className="name-sub" style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agent.instructions}</div>}
                      </div>
                    </div>
                  </td>
                  <td><span className="cap">{ROLE_LABELS[agent.role] || agent.role}</span></td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => openPermissions(agent)}>
                      {(agentPerms.length > 0 && showPermissions?.id === agent.id) ? `${agentPerms.length} rules` : "Configure"}
                    </button>
                  </td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => openSkills(agent)}>
                      {(agentSkills.length > 0 && showSkills?.id === agent.id) ? `${agentSkills.length} rules` : "Configure"}
                    </button>
                  </td>
                  <td>
                    <span className={`status ${agent.enabled ? "completed" : "draft"}`}>
                      <span className="dot" />{agent.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => handleToggleEnabled(agent)}>{agent.enabled ? "Disable" : "Enable"}</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => startEdit(agent)}>Edit</button>
                      <button className="btn btn-ghost btn-sm" style={{ color: "var(--red)" }} onClick={() => handleDelete(agent)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Agent Modal */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={handleCreate} style={{ maxWidth: 520 }}>
            <h2>New Agent</h2>
            {formError && <div className="error-message" role="alert">{formError}</div>}
            <div className="field">
              <label>Name</label>
              <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="Backend Engineer" required autoFocus />
            </div>
            <div className="field">
              <label>Role</label>
              <select value={formRole} onChange={e => setFormRole(e.target.value)} style={{ background: "var(--bg-panel)", border: "1px solid var(--border-2)", color: "var(--text)", padding: 9, borderRadius: "var(--radius-sm)", width: "100%" }}>
                {AGENT_ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Instructions (system prompt)</label>
              <textarea value={formInstructions} onChange={e => setFormInstructions(e.target.value)} placeholder="You are a backend engineer focused on API design and database performance..." rows={3} style={{ width: "100%", background: "var(--bg-panel)", border: "1px solid var(--border-2)", color: "var(--text)", padding: 9, borderRadius: "var(--radius-sm)", resize: "vertical" }} />
            </div>
            <div className="field">
              <label>Provider Override (optional)</label>
              <input value={formProviderOverride} onChange={e => setFormProviderOverride(e.target.value)} placeholder="anthropic, openai, deepseek..." />
            </div>
            <div className="field">
              <label>Model Override (optional)</label>
              <input value={formModelOverride} onChange={e => setFormModelOverride(e.target.value)} placeholder="claude-sonnet-4, gpt-5.4..." />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!formName.trim()}>Create Agent</button>
            </div>
          </form>
        </div>
      )}

      {/* Edit Agent Modal */}
      {editingAgent && (
        <div className="modal-overlay" onClick={() => { setEditingAgent(null); resetForm(); }}>
          <form className="modal" onClick={e => e.stopPropagation()} onSubmit={handleUpdate} style={{ maxWidth: 520 }}>
            <h2>Edit Agent</h2>
            {formError && <div className="error-message" role="alert">{formError}</div>}
            <div className="field">
              <label>Name</label>
              <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="Backend Engineer" required autoFocus />
            </div>
            <div className="field">
              <label>Role</label>
              <select value={formRole} onChange={e => setFormRole(e.target.value)} style={{ background: "var(--bg-panel)", border: "1px solid var(--border-2)", color: "var(--text)", padding: 9, borderRadius: "var(--radius-sm)", width: "100%" }}>
                {AGENT_ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Instructions (system prompt)</label>
              <textarea value={formInstructions} onChange={e => setFormInstructions(e.target.value)} rows={3} style={{ width: "100%", background: "var(--bg-panel)", border: "1px solid var(--border-2)", color: "var(--text)", padding: 9, borderRadius: "var(--radius-sm)", resize: "vertical" }} />
            </div>
            <div className="field">
              <label>Provider Override</label>
              <input value={formProviderOverride} onChange={e => setFormProviderOverride(e.target.value)} placeholder="Leave empty to use project default" />
            </div>
            <div className="field">
              <label>Model Override</label>
              <input value={formModelOverride} onChange={e => setFormModelOverride(e.target.value)} placeholder="Leave empty to use project default" />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => { setEditingAgent(null); resetForm(); }}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!formName.trim()}>Save</button>
            </div>
          </form>
        </div>
      )}

      {/* Tool Permissions Modal */}
      {showPermissions && (
        <div className="modal-overlay" onClick={() => setShowPermissions(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 600, maxHeight: "80vh", overflow: "auto" }}>
            <h2>Tool Permissions: {showPermissions.name}</h2>
            <p className="muted" style={{ marginBottom: 16 }}>Set per-tool allow/deny rules. Deny overrides allow at the same priority level.</p>
            <table className="perm-table" style={{ width: "100%" }}>
              <thead><tr><th>Tool</th><th style={{ textAlign: "center" }}>Allow</th><th style={{ textAlign: "center" }}>Deny</th><th style={{ textAlign: "center" }}>Unset</th></tr></thead>
              <tbody>
                {AVAILABLE_TOOLS.map(tool => {
                  const effect = getToolEffect(tool);
                  return (
                    <tr key={tool}>
                      <td><code>{tool}</code></td>
                      <td style={{ textAlign: "center" }}>
                        <input type="radio" name={`perm-${tool}`} checked={effect === "allow"} onChange={() => toggleToolPermission(tool, "allow")} />
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <input type="radio" name={`perm-${tool}`} checked={effect === "deny"} onChange={() => toggleToolPermission(tool, "deny")} />
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <input type="radio" name={`perm-${tool}`} checked={effect === "unset"} onChange={() => {
                          if (effect !== "unset") apiClient.deleteToolPermission(showPermissions.id, tool).then(() => {
                            setAgentPerms(prev => prev.filter(p => p.toolName !== tool));
                          }).catch(console.error);
                        }} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button type="button" className="btn btn-primary" onClick={() => setShowPermissions(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Skill Access Modal */}
      {showSkills && (
        <div className="modal-overlay" onClick={() => setShowSkills(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 600, maxHeight: "80vh", overflow: "auto" }}>
            <h2>Skill Access: {showSkills.name}</h2>
            <p className="muted" style={{ marginBottom: 16 }}>Toggle which skills this agent is allowed to use. Disabled skills are hidden from the agent's skill list.</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
              {SKILL_IDS.map(skillId => (
                <div key={skillId} className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px" }}>
                  <span style={{ fontSize: 13 }}>{SKILL_LABELS[skillId] || skillId}</span>
                  <label className="toggle-label" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input type="checkbox" checked={isSkillAllowed(skillId)} onChange={() => toggleSkillAccess(skillId)} />
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{isSkillAllowed(skillId) ? "on" : "off"}</span>
                  </label>
                </div>
              ))}
            </div>
            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button type="button" className="btn btn-primary" onClick={() => setShowSkills(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
