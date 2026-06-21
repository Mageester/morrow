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
  VerificationResult
} from "@morrow/contracts";
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
  
  const [activePreset, setActivePreset] = useState<"Balanced" | "Fast" | "Private Local">("Balanced");
  const [providerStatus, setProviderStatus] = useState<{ configured: boolean; provider: string; model: string } | null>(null);

  const [activeTaskId, setActiveTaskId] = useState<string>("");
  const [taskState, setTaskState] = useState<{
    task?: Task;
    plan?: PlanStep[];
    events?: TaskEvent[];
    evidence?: TaskEvidence[];
    disclosure?: ExecutionDisclosure;
    toolCalls?: any[];
    verification?: VerificationResult;
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

  // Load projects & provider status on mount
  useEffect(() => {
    apiClient.listProjects().then(p => {
      setProjects(p);
      if (p.length > 0) setSelectedProjectId(p[0].id);
    }).catch(console.error);

    apiClient.getProviderStatus().then(status => {
      setProviderStatus(status);
    }).catch(console.error);
  }, []);

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
    messageEndRef.current?.scrollIntoView({ behavior: "smooth" });
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
              toolCalls: extra.toolCalls || []
            });
          }).catch(() => {
            setTaskState({
              task: agg.task,
              plan: agg.plan,
              events: agg.events,
              evidence: agg.evidence,
              disclosure: agg.disclosure,
              verification: agg.verification
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

    if (activePreset === "Private Local") {
      setComposerError("Private Local preset is not available (requires a local model provider adapter).");
      return;
    }

    if (providerStatus && !providerStatus.configured) {
      setComposerError("No AI provider configured. Please check your orchestrator environment settings.");
      return;
    }

    const contentToSend = composerPrompt;
    setComposerPrompt("");

    try {
      const res = await apiClient.sendMessage(activeConversationId, contentToSend, activePreset);
      setMessages(prev => [...prev, res.userMessage, res.assistantMessage]);
      setActiveTaskId(res.task.id);
    } catch (err: any) {
      setComposerError(err.message || "Failed to send message");
    }
  };

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
              <div className="project-selection">
                <label htmlFor="project-select-main">Active Project</label>
                <select id="project-select-main" value={selectedProjectId} onChange={e => setSelectedProjectId(e.target.value)}>
                  <option value="">-- Select a project --</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>

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
                      <h2>Morrow Conversations</h2>
                      {providerStatus && (
                        <div className={`provider-indicator ${providerStatus.configured ? "configured" : "unconfigured"}`}>
                          {providerStatus.configured ? (
                            <span>Active Provider: <strong>{providerStatus.provider}</strong> ({providerStatus.model})</span>
                          ) : (
                            <strong>No AI provider configured</strong>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Preset Selector */}
                    <div className="preset-selector">
                      <label>Preset:</label>
                      <div className="preset-options">
                        <button 
                          className={`preset-btn ${activePreset === "Balanced" ? "selected" : ""}`}
                          onClick={() => setActivePreset("Balanced")}
                        >
                          Balanced
                        </button>
                        <button 
                          className={`preset-btn ${activePreset === "Fast" ? "selected" : ""}`}
                          onClick={() => setActivePreset("Fast")}
                        >
                          Fast
                        </button>
                        <div className="preset-btn-wrapper">
                          <button 
                            className={`preset-btn disabled`}
                            disabled
                            aria-disabled="true"
                          >
                            Private Local (Unavailable)
                          </button>
                          <span className="tooltip-text">
                            Unavailable: requires a real local model provider (e.g. Ollama) which is planned for a future milestone.
                          </span>
                        </div>
                      </div>
                    </div>
                  </header>

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
                                <p className="msg-text">{msg.content}</p>
                              ) : msg.streamingState === "queued" ? (
                                <p className="msg-text loading-pulse">Preparing workspace context...</p>
                              ) : msg.streamingState === "streaming" ? (
                                <p className="msg-text loading-pulse">Reading workspace and streaming answer...</p>
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
            <h2>Settings & Provider Configuration</h2>
            
            <div className="card">
              <h3>AI Provider Status</h3>
              <div className="provider-status-grid">
                <div className="status-label">Active Provider:</div>
                <div className="status-val">OpenAI</div>
                
                <div className="status-label">Default Model:</div>
                <div className="status-val">gpt-4o-mini</div>
                
                <div className="status-label">API Key Configured:</div>
                <div className="status-val">
                  {providerStatus?.configured ? (
                    <span className="badge-ok">Configured (Environment)</span>
                  ) : (
                    <span className="badge-err">Not Configured</span>
                  )}
                </div>
              </div>
            </div>

            <div className="card">
              <h3>Setup Instructions</h3>
              <p>Morrow resolves API credentials server-side from environment variables. Credentials never enter SQLite, browser local storage, or telemetry streams.</p>
              <ol className="setup-steps">
                <li>
                  To configure OpenAI, add the following line to your local environment configuration or <code>.env</code> file in the orchestrator directory:
                  <pre><code>OPENAI_API_KEY=sk-proj-...</code></pre>
                </li>
                <li>
                  Restart the orchestrator service to apply the environment changes:
                  <pre><code>pnpm dev</code></pre>
                </li>
                <li>
                  If using a custom OpenAI-compatible server (e.g. local gateway or proxy), you can optionally customize the endpoint by setting:
                  <pre><code>OPENAI_BASE_URL=https://your-custom-gateway.v1</code></pre>
                </li>
              </ol>
            </div>
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
