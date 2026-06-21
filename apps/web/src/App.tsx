import React, { useState, useEffect, useRef } from "react";
import { apiClient } from "./api/client";
import type {
  Project,
  Task,
  TaskEvent,
  PlanStep,
  TaskEvidence,
  ExecutionDisclosure,
  Conversation,
  ConversationMessage,
  VerificationResult,
  PresetStatus,
  ProviderStatus,
  ModelStatus,
  OAuthFinding,
  MemoryEntry,
  RoutingDecision
} from "@morrow/contracts";
import { Markdown } from "./Markdown";
import "./App.css";

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>("");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  
  const [newProjectName, setNewProjectName] = useState("");
  const [newWorkspacePath, setNewWorkspacePath] = useState("");
  const [projectError, setProjectError] = useState("");
  
  const [composerPrompt, setComposerPrompt] = useState("");
  const [composerError, setComposerError] = useState("");
  
  const [activePreset, setActivePreset] = useState<string>("balanced");
  const [providerStatus, setProviderStatus] = useState<{ configured: boolean; provider: string; model: string } | null>(null);
  const [presets, setPresets] = useState<PresetStatus[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [models, setModels] = useState<ModelStatus[]>([]);
  const [oauthFindings, setOauthFindings] = useState<OAuthFinding[]>([]);
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([]);
  const [newMemoryContent, setNewMemoryContent] = useState("");
  const [useMemory, setUseMemory] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [overrideProviderId, setOverrideProviderId] = useState("");
  const [overrideModel, setOverrideModel] = useState("");
  const [settingsTab, setSettingsTab] = useState<"providers" | "models" | "presets" | "privacy" | "permissions" | "data" | "diagnostics">("providers");

  const [activeTaskId, setActiveTaskId] = useState<string>("");
  const [taskState, setTaskState] = useState<{
    task?: Task;
    plan?: PlanStep[];
    events?: TaskEvent[];
    evidence?: TaskEvidence[];
    disclosure?: ExecutionDisclosure;
    toolCalls?: any[];
    verification?: VerificationResult;
    routing?: RoutingDecision | null;
  } | null>(null);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskError, setTaskError] = useState("");

  const [activeNav, setActiveNav] = useState<"conversations" | "projects" | "settings">("conversations");
  const messageEndRef = useRef<HTMLDivElement>(null);
  const eventUnsubRef = useRef<(() => void) | null>(null);

  const refreshTasks = () => {
    if (selectedProjectId) {
      apiClient.listProjectTasks(selectedProjectId).then(setTasks).catch(console.error);
    }
  };

  // Load projects, provider status, presets, providers, and models on mount
  useEffect(() => {
    apiClient.listProjects().then(p => {
      setProjects(p);
      if (p.length > 0) setSelectedProjectId(p[0].id);
    }).catch(console.error);

    apiClient.getProviderStatus().then(status => {
      setProviderStatus(status);
    }).catch(console.error);

    apiClient.listPresets?.().then(setPresets).catch(console.error);
    apiClient.listProviders?.().then(setProviders).catch(console.error);
    apiClient.listModels?.().then(setModels).catch(console.error);
    apiClient.listOAuthFindings?.().then(setOauthFindings).catch(console.error);
  }, []);

  // Load memory when the project changes
  useEffect(() => {
    if (selectedProjectId && apiClient.listProjectMemory) {
      apiClient.listProjectMemory(selectedProjectId).then(setMemoryEntries).catch(console.error);
    } else {
      setMemoryEntries([]);
    }
  }, [selectedProjectId]);

  // Load conversations & tasks when project changes
  useEffect(() => {
    if (selectedProjectId) {
      apiClient.listConversations(selectedProjectId).then(c => {
        setConversations(c);
        if (c.length > 0) {
          setActiveConversationId(c[0].id);
        } else {
          setActiveConversationId("");
          setMessages([]);
        }
      }).catch(console.error);

      apiClient.listProjectTasks(selectedProjectId).then(setTasks).catch(console.error);
    } else {
      setConversations([]);
      setActiveConversationId("");
      setMessages([]);
      setTasks([]);
    }
  }, [selectedProjectId]);

  // Load messages when conversation changes
  useEffect(() => {
    if (activeConversationId) {
      apiClient.listMessages(activeConversationId).then(m => {
        setMessages(m);
        // If the latest message was running/queued but got interrupted, the recovery system already transitioned it.
        // If there's currently a running task associated with the latest assistant message, we reconnect the stream!
        const lastMsg = m.at(-1);
        if (lastMsg && lastMsg.role === "assistant" && lastMsg.taskId && ["queued", "streaming"].includes(lastMsg.streamingState)) {
          setActiveTaskId(lastMsg.taskId);
        } else {
          setActiveTaskId("");
        }
      }).catch(console.error);
    } else {
      setMessages([]);
      setActiveTaskId("");
    }
  }, [activeConversationId]);

  // Scroll to bottom when messages load/change
  useEffect(() => {
    messageEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [messages]);

  // Handle active task subscription
  useEffect(() => {
    if (!activeTaskId) {
      setTaskState(null);
      if (eventUnsubRef.current) {
        eventUnsubRef.current();
        eventUnsubRef.current = null;
      }
      return;
    }

    let isSubscribed = true;
    const fetchAggregate = () => {
      apiClient.getTaskAggregate(activeTaskId).then(agg => {
        if (!isSubscribed) return;
        
        // Fetch custom tool call records from database for inspector
        fetch(`${import.meta.env.VITE_API_BASE_URL ?? ""}/api/tasks/${activeTaskId}`)
          .then(res => res.json())
          .then((extra: any) => {
            if (!isSubscribed) return;
            // Get tool calls from task state or aggregate
            setTaskState({
              task: agg.task,
              plan: agg.plan,
              events: agg.events,
              evidence: agg.evidence,
              disclosure: agg.disclosure,
              verification: agg.verification,
              toolCalls: extra.toolCalls || [],
              routing: extra.routing ?? null
            });
          }).catch(() => {
            setTaskState({
              task: agg.task,
              plan: agg.plan,
              events: agg.events,
              evidence: agg.evidence,
              disclosure: agg.disclosure,
              verification: agg.verification,
              routing: (agg as any).routing ?? null
            });
          });
      }).catch(console.error);
    };

    fetchAggregate();

    // Subscribe to SSE task events
    const unsub = apiClient.subscribeToTaskEvents(activeTaskId, 0, (event) => {
      if (!isSubscribed) return;
      
      // Update state for live changes
      fetchAggregate();

      // If it's a streaming content delta event
      if (event.type === "evidence.persisted" && event.payload.deltaText) {
        setMessages(prev => {
          return prev.map(msg => {
            if (msg.taskId === activeTaskId) {
              return {
                ...msg,
                content: msg.content + (event.payload.deltaText as string),
                streamingState: "streaming"
              };
            }
            return msg;
          });
        });
      }
    }, () => {
      // Completed, cancelled, failed or interrupted
      if (!isSubscribed) return;
      refreshTasks();
      if (activeConversationId) {
        apiClient.listMessages(activeConversationId).then(setMessages);
      }
    });

    eventUnsubRef.current = unsub;

    return () => {
      isSubscribed = false;
      unsub();
      if (eventUnsubRef.current === unsub) {
        eventUnsubRef.current = null;
      }
    };
  }, [activeTaskId, activeConversationId]);

  const handleStartInspection = async () => {
    if (!selectedProjectId) return;
    setTaskError("");
    try {
      const res = await apiClient.startInspectWorkspace(selectedProjectId);
      setActiveTaskId(res.taskId);
      refreshTasks();
    } catch (err: any) {
      setTaskError(err.message || "Failed to start workspace inspection");
    }
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setProjectError("");
    try {
      const p = await apiClient.createProject(newProjectName, newWorkspacePath);
      setProjects([...projects, p]);
      setSelectedProjectId(p.id);
      setNewProjectName("");
      setNewWorkspacePath("");
      setActiveNav("conversations");
    } catch (err: any) {
      setProjectError(err.message || "Failed to create project");
    }
  };

  const handleCreateConversation = async () => {
    if (!selectedProjectId) return;
    try {
      const c = await apiClient.createConversation(selectedProjectId, `Conversation ${conversations.length + 1}`);
      setConversations([c, ...conversations]);
      setActiveConversationId(c.id);
      setActiveNav("conversations");
    } catch (err: any) {
      console.error(err);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeConversationId || !composerPrompt.trim()) return;
    setComposerError("");

    const presetStatus = presets.find(p => p.preset.id === activePreset);
    const usingOverride = advancedOpen && !!overrideProviderId;
    // Pre-block only when we are confident nothing can run; otherwise defer to the
    // server, which is the source of truth and returns a precise reason.
    if (!usingOverride && presetStatus && !presetStatus.available && !providerStatus?.configured) {
      setComposerError(presetStatus.unavailableReason || "This preset is not available.");
      return;
    }

    const contentToSend = composerPrompt;
    setComposerPrompt("");

    try {
      const res = await apiClient.sendMessage(activeConversationId, contentToSend, {
        preset: activePreset,
        ...(usingOverride ? { providerId: overrideProviderId } : {}),
        ...(advancedOpen && overrideModel ? { model: overrideModel } : {}),
        useMemory
      });
      setMessages(prev => [...prev, res.userMessage, res.assistantMessage]);
      setActiveTaskId(res.task.id);
    } catch (err: any) {
      setComposerError(err.message || "Failed to send message");
    }
  };

  const handleAddMemory = async () => {
    if (!selectedProjectId || !newMemoryContent.trim() || !apiClient.addMemory) return;
    try {
      const entry = await apiClient.addMemory(selectedProjectId, "project", newMemoryContent.trim());
      setMemoryEntries(prev => [...prev, entry]);
      setNewMemoryContent("");
    } catch (err) {
      console.error("Failed to add memory", err);
    }
  };

  const handleToggleMemory = async (id: string, enabled: boolean) => {
    try {
      const updated = await apiClient.setMemoryEnabled(id, enabled);
      setMemoryEntries(prev => prev.map(m => (m.id === id ? updated : m)));
    } catch (err) {
      console.error("Failed to toggle memory", err);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    try {
      await apiClient.deleteMemory(id);
      setMemoryEntries(prev => prev.filter(m => m.id !== id));
    } catch (err) {
      console.error("Failed to delete memory", err);
    }
  };

  const activePresetStatus = presets.find(p => p.preset.id === activePreset);
  const activeConversation = conversations.find(c => c.id === activeConversationId);
  const latestAssistant = [...messages].reverse().find(m => m.role === "assistant" && (m.provider || m.model));
  const activeProviderLabel = latestAssistant?.provider || activePresetStatus?.resolved?.providerId || providerStatus?.provider || "—";
  const activeModelLabel = latestAssistant?.model || activePresetStatus?.resolved?.model || providerStatus?.model || "—";

  const handleStopStreaming = async () => {
    if (!activeTaskId) return;
    try {
      await apiClient.cancelTask(activeTaskId);
      if (activeConversationId) {
        const refreshed = await apiClient.listMessages(activeConversationId);
        setMessages(refreshed);
      }
      refreshTasks();
    } catch (err: any) {
      console.error("Failed to cancel task", err);
    }
  };

  const selectedProject = projects.find(p => p.id === selectedProjectId);

  const getStatusLabel = (status: string) => {
    switch (status) {
      case "queued": return "Queued";
      case "running": return "Running";
      case "completed": return "Completed";
      case "verified": return "Verified";
      case "failed": return "Failed";
      case "cancelled": return "Cancelled";
      case "interrupted": return "Interrupted";
      default: return status;
    }
  };

  return (
    <div className="morrow-app">
      {/* Left Navigation */}
      <nav className="left-nav" aria-label="Main Navigation">
        <div className="brand">Morrow</div>
        
        <div className="project-selector-wrapper">
          <label htmlFor="project-select">Active Project</label>
          <select 
            id="project-select" 
            value={selectedProjectId} 
            onChange={e => setSelectedProjectId(e.target.value)}
          >
            <option value="">-- Select --</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <ul className="nav-links">
          <li>
            <button className="nav-btn disabled" disabled aria-disabled="true">
              Today <span className="Planned-tag">(Planned)</span>
            </button>
          </li>
          <li>
            <button 
              className={`nav-btn ${activeNav === "conversations" ? "active" : ""}`}
              onClick={() => setActiveNav("conversations")}
              disabled={!selectedProjectId}
            >
              Conversations
            </button>
          </li>
          <li>
            <button 
              className={`nav-btn ${activeNav === "projects" ? "active" : ""}`}
              onClick={() => setActiveNav("projects")}
            >
              Projects Configuration
            </button>
          </li>
          <li>
            <button 
              className={`nav-btn ${activeNav === "settings" ? "active" : ""}`}
              onClick={() => setActiveNav("settings")}
            >
              Settings & Provider
            </button>
          </li>
        </ul>

        {selectedProjectId && activeNav === "conversations" && (
          <div className="sidebar-chat-controls">
            <button className="action-btn" onClick={handleCreateConversation}>
              + New Conversation
            </button>
            <div className="conversations-list" role="listbox" aria-label="Conversations List">
              {conversations.map(c => (
                <button
                  key={c.id}
                  className={`conversation-item ${activeConversationId === c.id ? "selected" : ""}`}
                  onClick={() => setActiveConversationId(c.id)}
                  role="option"
                  aria-selected={activeConversationId === c.id}
                >
                  <span className="chat-icon">💬</span>
                  <span className="chat-title">{c.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </nav>

      {/* Main Canvas */}
      <main className="main-canvas" aria-live="polite">
        {activeNav === "conversations" && (
          <>
            <div className="project-controls card">
              {projects.length === 0 && (
              <div className="welcome-block">
                <h2>Welcome to Morrow</h2>
                <p className="muted">Create a local project to start a conversation. Morrow inspects only the workspace you point it at, with read-only tools.</p>
              </div>
              )}

              <form onSubmit={handleCreateProject} className="new-project-form" aria-labelledby="create-project-heading">
                <h3 id="create-project-heading">Create Project</h3>
                {projectError && <div className="error-message" role="alert">{projectError}</div>}
                <div className="form-group">
                  <label htmlFor="new-project-name">Name</label>
                  <input 
                    id="new-project-name" 
                    value={newProjectName} 
                    onChange={e => setNewProjectName(e.target.value)} 
                    required 
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="new-workspace-path">Workspace Path</label>
                  <input 
                    id="new-workspace-path" 
                    value={newWorkspacePath} 
                    onChange={e => setNewWorkspacePath(e.target.value)} 
                    required 
                  />
                </div>
                <button type="submit" className="primary-btn">Create Project</button>
              </form>
            </div>

            {selectedProject && (
              <>
                <div className="workspace-area">
                  <div className="workspace-header">
                    <h3>{selectedProject?.name} Workspace</h3>
                    <p className="path-display" title={selectedProject?.workspacePath}>
                      Path: <span className="path-truncate">{selectedProject?.workspacePath.split(/[/\\]/).pop()}</span>
                    </p>
                  </div>

                  <div className="task-submission">
                    {taskError && <div className="error-message" role="alert">{taskError}</div>}
                    <button onClick={handleStartInspection} className="action-btn">Inspect Workspace</button>
                    {activeTaskId && (
                      <button onClick={() => setActiveTaskId("")} className="secondary-btn">Clear Selection</button>
                    )}
                  </div>

                  <div className="task-history">
                    <h3>Task History</h3>
                    {tasks.length === 0 ? (
                      <p className="empty-state">No tasks yet. Start an inspection.</p>
                    ) : (
                      <ul className="task-list" role="listbox">
                        {tasks.map(t => (
                          <li 
                            key={t.id} 
                            className={`task-item ${activeTaskId === t.id ? "selected" : ""}`}
                            role="option"
                            aria-selected={activeTaskId === t.id}
                            tabIndex={0}
                            onClick={() => setActiveTaskId(t.id)}
                            onKeyDown={e => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setActiveTaskId(t.id);
                              }
                            }}
                          >
                            <div className="task-item-header">
                              <span className="task-kind">{t.kind === "agent_chat" ? "Agent Chat" : "Inspect Workspace"}</span>
                              <span className={`task-badge ${t.status}`}>{getStatusLabel(t.status)}</span>
                            </div>
                            <div className="task-item-meta">
                              {new Date(t.createdAt).toLocaleString()}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                <div className="agent-conversation-section card" style={{ marginTop: "2rem" }}>
                  <header className="canvas-header">
                    <div className="header-info">
                      <h2>{activeConversation?.title || "Conversation"}</h2>
                      <div className="header-meta">
                        <span className="meta-chip">{selectedProject?.name}</span>
                        <span className="meta-chip">{activePresetStatus?.preset.label ?? activePreset}</span>
                        <span className={`meta-chip provider-chip ${providerStatus?.configured ? "ok" : "warn"}`}>
                          {providerStatus?.configured ? `${activeProviderLabel} · ${activeModelLabel}` : "No provider configured"}
                        </span>
                      </div>
                    </div>

                    {/* Dynamic preset selector driven by live availability */}
                    <div className="preset-selector">
                      <div className="preset-options" role="radiogroup" aria-label="Preset">
                        {presets.map(ps => (
                          <button
                            key={ps.preset.id}
                            className={`preset-btn ${activePreset === ps.preset.id ? "selected" : ""} ${!ps.available ? "unavailable" : ""}`}
                            onClick={() => setActivePreset(ps.preset.id)}
                            title={ps.available ? ps.preset.description : ps.unavailableReason || ""}
                            role="radio"
                            aria-checked={activePreset === ps.preset.id}
                          >
                            {ps.preset.label}
                            {!ps.available && <span className="unavail-dot" aria-hidden="true"> •</span>}
                          </button>
                        ))}
                      </div>
                      <button type="button" className="link-btn" onClick={() => setAdvancedOpen(o => !o)} aria-expanded={advancedOpen}>
                        {advancedOpen ? "Hide advanced" : "Advanced"}
                      </button>
                    </div>
                  </header>

                  {activePresetStatus && !activePresetStatus.available && !(advancedOpen && overrideProviderId) && (
                    <div className="preset-warning" role="status">{activePresetStatus.unavailableReason}</div>
                  )}

                  {advancedOpen && (
                    <div className="advanced-override">
                      <div className="override-row">
                        <label htmlFor="ov-provider">Provider override</label>
                        <select id="ov-provider" value={overrideProviderId} onChange={e => setOverrideProviderId(e.target.value)}>
                          <option value="">Use preset routing</option>
                          {providers.filter(p => p.configured).map(p => (
                            <option key={p.id} value={p.id}>{p.label}</option>
                          ))}
                        </select>
                      </div>
                      <div className="override-row">
                        <label htmlFor="ov-model">Model override</label>
                        <input id="ov-model" value={overrideModel} onChange={e => setOverrideModel(e.target.value)} placeholder="(optional model id)" />
                      </div>
                      <label className="memory-toggle">
                        <input type="checkbox" checked={useMemory} onChange={e => setUseMemory(e.target.checked)} /> Use project memory
                      </label>
                    </div>
                  )}

                  {/* Conversation Feed */}
                  <div className="chat-container">
                    {!activeConversationId ? (
                      <div className="chat-empty">
                        <p>Select a project and start a conversation to ask Morrow to understand your project.</p>
                      </div>
                    ) : messages.length === 0 ? (
                      <div className="chat-empty">
                        <p>Ask a project-related question, such as: <em>"Summarize the architecture of this project."</em></p>
                      </div>
                    ) : (
                      <div className="message-history">
                        {messages.map(msg => (
                          <div key={msg.id} className={`message-bubble ${msg.role}`}>
                            <div className="message-header">
                              <span className="role-label">{msg.role === "user" ? "You" : "Morrow"}</span>
                              {msg.role === "assistant" && msg.streamingState && msg.streamingState !== "completed" && (
                                <span className={`streaming-state ${msg.streamingState}`}>
                                  {getStatusLabel(msg.streamingState)}
                                </span>
                              )}
                            </div>
                            <div className="message-content">
                              {msg.content ? (
                                msg.role === "assistant" ? (
                                  <div className="msg-text"><Markdown source={msg.content} /></div>
                                ) : (
                                  <p className="msg-text">{msg.content}</p>
                                )
                              ) : msg.streamingState === "queued" ? (
                                <p className="msg-text loading-pulse">Preparing workspace context…</p>
                              ) : msg.streamingState === "streaming" ? (
                                <p className="msg-text loading-pulse">Reading workspace and streaming answer…</p>
                              ) : msg.streamingState === "failed" ? (
                                <p className="msg-text muted">No response (the run failed).</p>
                              ) : msg.streamingState === "interrupted" ? (
                                <p className="msg-text muted">Interrupted before completion.</p>
                              ) : (
                                <p className="msg-text muted">[No response content]</p>
                              )}
                            </div>
                          </div>
                        ))}
                        <div ref={messageEndRef} />
                      </div>
                    )}
                  </div>

                  {/* Composer */}
                  {activeConversationId && (
                    <form onSubmit={handleSendMessage} className="composer-form">
                      {composerError && <div className="composer-error" role="alert">{composerError}</div>}
                      
                      <div className="composer-row">
                        <input
                          className="composer-input"
                          value={composerPrompt}
                          onChange={e => setComposerPrompt(e.target.value)}
                          placeholder={activeTaskId ? "Morrow is executing tools..." : "Ask Morrow to understand the project..."}
                          disabled={!!activeTaskId}
                          required
                        />
                        {activeTaskId ? (
                          <button type="button" className="stop-btn" onClick={handleStopStreaming}>
                            ⏹ Stop
                          </button>
                        ) : (
                          <button type="submit" className="primary-btn" disabled={!selectedProjectId}>
                            Send
                          </button>
                        )}
                      </div>
                    </form>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {activeNav === "projects" && (
          <div className="project-config-view">
            <h2>Projects Configuration</h2>
            
            <div className="project-controls card">
              <form onSubmit={handleCreateProject} className="new-project-form">
                <h3>Create New Local Project</h3>
                {projectError && <div className="error-message" role="alert">{projectError}</div>}
                <div className="form-group">
                  <label htmlFor="new-project-name">Project Name</label>
                  <input 
                    id="new-project-name" 
                    value={newProjectName} 
                    onChange={e => setNewProjectName(e.target.value)} 
                    required 
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="new-workspace-path">Local Workspace Directory Path</label>
                  <input 
                    id="new-workspace-path" 
                    value={newWorkspacePath} 
                    onChange={e => setNewWorkspacePath(e.target.value)} 
                    required 
                  />
                </div>
                <button type="submit" className="primary-btn">Create Project</button>
              </form>
            </div>

            <div className="active-projects-list card">
              <h3>Configured Projects</h3>
              <ul>
                {projects.map(p => (
                  <li key={p.id} className="project-config-item">
                    <strong>{p.name}</strong>
                    <span className="project-path">{p.workspacePath}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {activeNav === "settings" && (
          <div className="settings-view">
            <h2>Settings</h2>
            <div className="settings-tabs" role="tablist" aria-label="Settings sections">
              {([
                ["providers", "Providers"],
                ["models", "Models"],
                ["presets", "Presets"],
                ["privacy", "Privacy"],
                ["permissions", "Tool Permissions"],
                ["data", "Data & Memory"],
                ["diagnostics", "Diagnostics"]
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={settingsTab === key}
                  className={`settings-tab ${settingsTab === key ? "active" : ""}`}
                  onClick={() => setSettingsTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            {settingsTab === "providers" && (
              <div className="settings-panel">
                <div className="card">
                  <h3>Model Providers</h3>
                  <p className="muted">Secrets are resolved server-side from environment variables and never reach the browser. Status shows only whether a provider is configured and which host it targets.</p>
                  <div className="provider-grid">
                    {providers.map(p => (
                      <div key={p.id} className={`provider-card ${p.configured ? "ok" : ""}`}>
                        <div className="provider-card-head">
                          <strong>{p.label}</strong>
                          <span className={`badge ${p.configured ? "badge-ok" : "badge-muted"}`}>
                            {p.configured ? "Configured" : "Not configured"}
                          </span>
                        </div>
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
                          {p.capabilities.customEndpoint && <span className="cap">custom endpoint</span>}
                        </div>
                        {!p.configured && p.setupHint && <p className="setup-hint">{p.setupHint}</p>}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="card">
                  <h3>API Key Setup</h3>
                  <p className="muted">Add keys to the orchestrator environment (e.g. a local <code>.env</code>), then restart it. Keys are never entered in the browser.</p>
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
                  <p className="muted">Morrow only labels a flow "OAuth" when it is an officially supported third-party integration. Current findings:</p>
                  <ul className="oauth-list">
                    {oauthFindings.map(f => (
                      <li key={f.id} className="oauth-item">
                        <div className="oauth-head"><strong>{f.label}</strong><span className="badge badge-muted">{f.status}</span></div>
                        <p className="oauth-reason">{f.reason}</p>
                        <p className="oauth-rec">{f.recommendation}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {settingsTab === "models" && (
              <div className="settings-panel">
                <div className="card">
                  <h3>Model Registry</h3>
                  <p className="muted">Built-in known models. Model IDs are configurable; availability follows configured providers. Context windows are shown only where well documented.</p>
                  <table className="model-table">
                    <thead><tr><th>Model</th><th>Provider</th><th>Context</th><th>Speed</th><th>Cost</th><th>Privacy</th><th>Status</th></tr></thead>
                    <tbody>
                      {models.map(({ model, available }) => (
                        <tr key={model.id} className={available ? "" : "row-muted"}>
                          <td>{model.label}</td>
                          <td>{model.providerId}</td>
                          <td>{model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k` : "—"}</td>
                          <td>{model.speedClass}</td>
                          <td>{model.costClass}</td>
                          <td>{model.privacy}</td>
                          <td>{available ? <span className="badge-ok">available</span> : <span className="badge-muted">needs provider</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {settingsTab === "presets" && (
              <div className="settings-panel">
                <div className="card">
                  <h3>Presets</h3>
                  <p className="muted">Each preset is a routing policy with concrete budgets. Unavailable presets explain why.</p>
                  <div className="preset-grid">
                    {presets.map(ps => (
                      <div key={ps.preset.id} className={`preset-card ${ps.available ? "" : "unavailable"}`}>
                        <div className="preset-card-head">
                          <strong>{ps.preset.label}</strong>
                          {ps.available
                            ? <span className="badge-ok">{ps.resolved?.providerId} · {ps.resolved?.model}</span>
                            : <span className="badge-muted">unavailable</span>}
                        </div>
                        <p className="preset-desc">{ps.preset.description}</p>
                        <div className="preset-meta">
                          <span>{ps.preset.privacyDescription}</span>
                          <span>{ps.preset.costDescription}</span>
                        </div>
                        {!ps.available && ps.unavailableReason && <p className="preset-reason">{ps.unavailableReason}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {settingsTab === "privacy" && (
              <div className="settings-panel">
                <div className="card">
                  <h3>Privacy</h3>
                  <ul className="bullet-list">
                    <li>Morrow is local-first: projects, conversations, and memory are stored in a local SQLite database.</li>
                    <li>API keys live only in the orchestrator environment, never in the database, browser, logs, or task events.</li>
                    <li>Hosted providers receive your prompt and any file content the agent reads. The active provider and model are always disclosed per run.</li>
                    <li>The <strong>Private Local</strong> preset routes only to local providers (Ollama); nothing leaves your machine.</li>
                    <li>Default tools are read-only and scoped to the project workspace. Secret files (.env, keys, credentials) are rejected.</li>
                  </ul>
                </div>
              </div>
            )}

            {settingsTab === "permissions" && (
              <div className="settings-panel">
                <div className="card">
                  <h3>Tool Permissions</h3>
                  <p className="muted">The alpha tool profile is read-only and enforced by a shared containment layer.</p>
                  <table className="perm-table">
                    <thead><tr><th>Tool</th><th>Access</th><th>Status</th></tr></thead>
                    <tbody>
                      <tr><td>inspect_workspace</td><td>read-only</td><td><span className="badge-ok">enabled</span></td></tr>
                      <tr><td>list_files</td><td>read-only</td><td><span className="badge-ok">enabled</span></td></tr>
                      <tr><td>read_file</td><td>read-only, bounded</td><td><span className="badge-ok">enabled</span></td></tr>
                      <tr><td>write_file</td><td>requires approval, diff, rollback</td><td><span className="badge-muted">not enabled (future)</span></td></tr>
                      <tr><td>run_command</td><td>requires approval, sandbox</td><td><span className="badge-muted">not enabled (future)</span></td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {settingsTab === "data" && (
              <div className="settings-panel">
                <div className="card">
                  <h3>Project Memory</h3>
                  <p className="muted">Deterministic, user-controlled memory for <strong>{selectedProject?.name ?? "the selected project"}</strong>. Each entry has a source and timestamp, can be disabled, and never crosses projects.</p>
                  {selectedProjectId ? (
                    <>
                      <div className="memory-add">
                        <input
                          aria-label="New memory"
                          value={newMemoryContent}
                          onChange={e => setNewMemoryContent(e.target.value)}
                          placeholder="Add a fact Morrow should remember for this project…"
                        />
                        <button className="primary-btn" onClick={handleAddMemory} disabled={!newMemoryContent.trim()}>Add</button>
                      </div>
                      {memoryEntries.length === 0 ? (
                        <p className="empty-state">No memory entries yet.</p>
                      ) : (
                        <ul className="memory-list">
                          {memoryEntries.map(m => (
                            <li key={m.id} className={`memory-item ${m.enabled ? "" : "disabled"}`}>
                              <label className="memory-toggle">
                                <input type="checkbox" checked={m.enabled} onChange={e => handleToggleMemory(m.id, e.target.checked)} />
                              </label>
                              <div className="memory-body">
                                <span className="memory-content">{m.content}</span>
                                <span className="memory-meta">{m.scope} · {m.source} · {new Date(m.createdAt).toLocaleDateString()}</span>
                              </div>
                              <button className="icon-btn" aria-label="Delete memory" onClick={() => handleDeleteMemory(m.id)}>✕</button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <p className="empty-state">Select a project to manage its memory.</p>
                  )}
                </div>
                <div className="card">
                  <h3>Storage</h3>
                  <p className="muted">Data is stored locally in SQLite at <code>.morrow/morrow.db</code> within the project directory. Test runs use isolated temporary databases.</p>
                </div>
              </div>
            )}

            {settingsTab === "diagnostics" && (
              <div className="settings-panel">
                <div className="card">
                  <h3>Diagnostics</h3>
                  <ul className="diag-list">
                    <li><span className="k">Default provider summary</span>{providerStatus?.configured ? `${providerStatus.provider} · ${providerStatus.model}` : "none configured"}</li>
                    <li><span className="k">Configured providers</span>{providers.filter(p => p.configured).map(p => p.id).join(", ") || "none"}</li>
                    <li><span className="k">Available presets</span>{presets.filter(p => p.available).map(p => p.preset.id).join(", ") || "none"}</li>
                    <li><span className="k">Known models</span>{models.length}</li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Right Contextual Inspector */}
      <aside className="right-inspector" aria-label="Task Inspector">
        {!taskState ? (
          <div className="inspector-empty">
            <p>Submit a request to inspect plans, tool calls, and evidence access boundaries live.</p>
          </div>
        ) : (
          <div className="inspector-content">
            <header className="inspector-header">
              <h3>Task Inspector</h3>
              <span className={`task-badge ${taskState.task?.status}`}>
                {getStatusLabel(taskState.task?.status || "queued")}
              </span>
            </header>

            {taskState.task?.status === "failed" && (
              <div className="error-message" role="alert">Task failed. Review execution activity.</div>
            )}

            <section className="inspector-section plan-section">
              <h4>Execution Plan</h4>
              <ol className="plan-steps">
                {taskState.plan?.map(step => (
                  <li key={step.id} className={`plan-step ${step.status}`}>
                    <div className="step-header">
                      <span className="step-title">{step.title}</span>
                      <span className="step-status">{step.status}</span>
                    </div>
                    <div className="step-desc">{step.description}</div>
                  </li>
                ))}
              </ol>
            </section>

            {taskState.verification && (
              <section className="inspector-section verification-section">
                <h4>Verification</h4>
                <div className={`verification-box ${taskState.verification.status}`}>
                  <p className="v-status">{taskState.verification.status}</p>
                  <p className="v-summary">{taskState.verification.summary}</p>
                  <div className="v-details">
                    <p>Entries: {taskState.verification.details?.resultCount as number}</p>
                    <p>Inaccessible: {taskState.verification.details?.inaccessibleEntryCount as number}</p>
                    <p>Depth truncated: {(taskState.verification.details?.depthTruncated as boolean) ? "Yes" : "No"}</p>
                    <p>Count truncated: {(taskState.verification.details?.countTruncated as boolean) ? "Yes" : "No"}</p>
                  </div>
                </div>
              </section>
            )}

            {taskState.routing && (
              <section className="inspector-section routing-section">
                <h4>Provider Routing</h4>
                <ul className="disclosure-list">
                  <li><span className="label">Provider:</span> {taskState.routing.providerId}</li>
                  <li><span className="label">Model:</span> {taskState.routing.model}</li>
                  <li><span className="label">Preset:</span> {taskState.routing.presetId}</li>
                  <li><span className="label">Privacy:</span> {taskState.routing.privacy}</li>
                  <li><span className="label">Decision:</span> {taskState.routing.reason}</li>
                  {taskState.routing.fallbackUsed && <li className="routing-flag">Fallback used</li>}
                  {taskState.routing.overridden && <li className="routing-flag">Manual override</li>}
                </ul>
              </section>
            )}

            {taskState.disclosure && (
              <section className="inspector-section disclosure-section">
                <h4>Execution Disclosure</h4>
                <ul className="disclosure-list">
                  <li><span className="label">Mode:</span> {taskState.disclosure.executionMode === "agent-interactive" ? "Agent interactive" : "Deterministic local"}</li>
                  <li><span className="label">Provider:</span> {taskState.disclosure.provider}</li>
                  <li><span className="label">Network:</span> {taskState.disclosure.networkAccess === "enabled" ? "Network enabled" : "Network disabled"}</li>
                  <li><span className="label">Filesystem:</span> {taskState.disclosure.filesystemAccess === "read-only" ? "Read-only" : "Read-write"}</li>
                  <li><span className="label">Model:</span> {taskState.disclosure.modelInvocation ? "Model invocation enabled" : "No model invoked"}</li>
                  <li><span className="label">Shell:</span> No shell execution</li>
                  <li><span className="label">Workspace Scope:</span> <span className="scope-path">{taskState.disclosure.workspaceScope.split(/[/\\]/).pop()}</span></li>
                </ul>
              </section>
            )}

            {taskState.toolCalls && taskState.toolCalls.length > 0 && (
              <section className="inspector-section tool-calls-section">
                <h4>Tool Call History ({taskState.toolCalls.length})</h4>
                <ul className="tool-calls-list">
                  {taskState.toolCalls.map(tc => (
                    <li key={tc.id} className={`tool-call-item ${tc.status}`}>
                      <div className="tc-header">
                        <strong>{tc.toolName}</strong>
                        <span className={`tc-badge ${tc.status}`}>{tc.status}</span>
                      </div>
                      <div className="tc-meta">
                        Args: <code>{tc.argsJson}</code>
                      </div>
                      {tc.errorMessage && (
                        <div className="tc-error">
                          Error: {tc.errorMessage}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {taskState.evidence && taskState.evidence.length > 0 && (
              <section className="inspector-section evidence-section">
                <h4>Files Read ({taskState.evidence.length})</h4>
                <ul className="evidence-list">
                  {taskState.evidence.map(ev => (
                    <li key={ev.id} className="evidence-item" title={ev.path}>
                      📄 {ev.path}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="inspector-section activity-section">
              <h4>Live Activity</h4>
              <ul className="activity-list">
                {taskState.events?.slice(-6).map(event => (
                  <li key={event.id} className="activity-item">
                    <span className="activity-seq">{event.sequence}</span>
                    <span className="activity-type">{event.type}</span>
                    <span className="activity-time">{new Date(event.createdAt).toLocaleTimeString()}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
