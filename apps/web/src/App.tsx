import React, { useState, useEffect } from 'react';
import { apiClient } from './api/client';
import type { Project, Task, TaskEvent, PlanStep, TaskEvidence, ExecutionDisclosure, VerificationResult } from '@morrow/contracts';
import './App.css';

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  
  const [newProjectName, setNewProjectName] = useState('');
  const [newWorkspacePath, setNewWorkspacePath] = useState('');
  const [projectError, setProjectError] = useState('');
  const [taskError, setTaskError] = useState('');

  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string>('');
  const [taskState, setTaskState] = useState<{
    task?: Task;
    plan?: PlanStep[];
    events?: TaskEvent[];
    evidence?: TaskEvidence[];
    disclosure?: ExecutionDisclosure;
    verification?: VerificationResult;
  } | null>(null);

  const [activeNav, setActiveNav] = useState('projects');

  useEffect(() => {
    apiClient.listProjects().then(p => {
      setProjects(p);
      if (p.length > 0 && !selectedProjectId) setSelectedProjectId(p[0].id);
    }).catch(console.error);
  }, []);

  const refreshTasks = (projectId: string) => {
    apiClient.listProjectTasks(projectId).then(t => {
      setTasks(t);
      // We don't automatically select the first task to allow the user to see the 'ready' state
    }).catch(console.error);
  };

  useEffect(() => {
    if (selectedProjectId) {
      refreshTasks(selectedProjectId);
    } else {
      setTasks([]);
      setActiveTaskId('');
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (!activeTaskId) {
      setTaskState(null);
      return;
    }
    let unsub: () => void = () => {};
    let isSubscribed = true;

    const loadAgg = async () => {
      try {
        const agg = await apiClient.getTaskAggregate(activeTaskId);
        if (!isSubscribed) return;
        setTaskState(agg);
        
        if (["queued", "running"].includes(agg.task.status)) {
          const lastSeq = agg.events.length > 0 ? agg.events[agg.events.length - 1].sequence : 0;
          unsub = apiClient.subscribeToTaskEvents(activeTaskId, lastSeq, (event) => {
            if (!isSubscribed) return;
            setTaskState(prev => {
              if (!prev) return prev;
              const hasEvent = prev.events?.some(e => e.id === event.id);
              if (hasEvent) return prev;
              return {
                ...prev,
                events: [...(prev.events || []), event].sort((a, b) => a.sequence - b.sequence)
              };
            });
            // Refresh aggregate on status changes
            if (["step.started", "step.completed", "task.verified", "task.failed"].includes(event.type)) {
              apiClient.getTaskAggregate(activeTaskId).then(newAgg => {
                if (isSubscribed) setTaskState(newAgg);
              });
            }
          }, () => {
            apiClient.getTaskAggregate(activeTaskId).then(newAgg => {
              if (isSubscribed) {
                setTaskState(newAgg);
                refreshTasks(selectedProjectId); // Refresh list to get updated status
              }
            });
          });
        }
      } catch (err) {
        console.error(err);
      }
    };
    loadAgg();

    return () => {
      isSubscribed = false;
      unsub();
    };
  }, [activeTaskId, selectedProjectId]);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setProjectError('');
    try {
      const p = await apiClient.createProject(newProjectName, newWorkspacePath);
      setProjects([...projects, p]);
      setSelectedProjectId(p.id);
      setNewProjectName('');
      setNewWorkspacePath('');
    } catch (err: any) {
      setProjectError(err.message || 'Failed to create project');
    }
  };

  const handleStartInspection = async () => {
    if (!selectedProjectId) return;
    setTaskError('');
    try {
      const { taskId } = await apiClient.startInspectWorkspace(selectedProjectId);
      // Immediately add the new task to the local list as queued so we can show it
      const newTask: Task = {
        version: 1,
        id: taskId,
        projectId: selectedProjectId,
        kind: 'inspect_workspace',
        status: 'queued',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      setTasks(prev => [newTask, ...prev]);
      setActiveTaskId(taskId);
    } catch (err: any) {
      setTaskError(err.message || 'Failed to start task');
    }
  };

  const selectedProject = projects.find(p => p.id === selectedProjectId);

  const getTaskStatusLabel = (status: Task['status']) => {
    switch (status) {
      case 'queued': return 'Queued';
      case 'running': return 'Running';
      case 'verified': return 'Verified';
      case 'failed': return 'Failed';
      case 'interrupted': return 'Interrupted';
      default: return status;
    }
  };

  return (
    <div className="morrow-app">
      <nav className="left-nav" aria-label="Main Navigation">
        <div className="brand">Morrow</div>
        <ul className="nav-links">
          <li><button className="nav-btn disabled" disabled aria-disabled="true">Today <span className="sr-only">(Planned)</span></button></li>
          <li><button className="nav-btn disabled" disabled aria-disabled="true">Conversations <span className="sr-only">(Planned)</span></button></li>
          <li><button className={`nav-btn ${activeNav === 'projects' ? 'active' : ''}`} onClick={() => setActiveNav('projects')}>Projects</button></li>
          <li><button className="nav-btn disabled" disabled aria-disabled="true">Agents <span className="sr-only">(Planned)</span></button></li>
          <li><button className="nav-btn disabled" disabled aria-disabled="true">Automations <span className="sr-only">(Planned)</span></button></li>
        </ul>
      </nav>

      <main className="main-canvas" aria-live="polite">
        <header className="canvas-header">
          <h2>Projects</h2>
        </header>

        <div className="project-controls">
          <div className="project-selection">
            <label htmlFor="project-select">Active Project</label>
            <select id="project-select" value={selectedProjectId} onChange={e => setSelectedProjectId(e.target.value)}>
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
              <input id="new-project-name" value={newProjectName} onChange={e => setNewProjectName(e.target.value)} required />
            </div>
            <div className="form-group">
              <label htmlFor="new-workspace-path">Workspace Path</label>
              <input id="new-workspace-path" value={newWorkspacePath} onChange={e => setNewWorkspacePath(e.target.value)} required />
            </div>
            <button type="submit" className="primary-btn">Create Project</button>
          </form>
        </div>

        {selectedProject && (
          <div className="workspace-area">
            <div className="workspace-header">
              <h3>{selectedProject.name} Workspace</h3>
              <p className="path-display" title={selectedProject.workspacePath}>
                Path: <span className="path-truncate">{selectedProject.workspacePath.split(/[/\\]/).pop()}</span>
              </p>
            </div>

            <div className="task-submission">
              {taskError && <div className="error-message" role="alert">{taskError}</div>}
              <button onClick={handleStartInspection} className="action-btn">Inspect Workspace</button>
              {activeTaskId && (
                <button onClick={() => setActiveTaskId('')} className="secondary-btn">Clear Selection</button>
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
                      className={`task-item ${activeTaskId === t.id ? 'selected' : ''}`}
                      role="option"
                      aria-selected={activeTaskId === t.id}
                      tabIndex={0}
                      onClick={() => setActiveTaskId(t.id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setActiveTaskId(t.id);
                        }
                      }}
                    >
                      <div className="task-item-header">
                        <span className="task-kind">Inspect Workspace</span>
                        <span className={`task-badge ${t.status}`}>{getTaskStatusLabel(t.status)}</span>
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
        )}
      </main>

      <aside className="right-inspector" aria-label="Task Inspector">
        {!activeTaskId ? (
          <div className="inspector-empty">
            <p>Select a task to view execution details.</p>
          </div>
        ) : !taskState ? (
          <div className="inspector-loading">Loading task details...</div>
        ) : (
          <div className="inspector-content">
            <header className="inspector-header">
              <h3>Task Details</h3>
              <span className={`task-badge ${taskState.task?.status}`}>{getTaskStatusLabel(taskState.task?.status || 'queued')}</span>
            </header>

            <section className="inspector-section disclosure-section">
              <h4>Execution Disclosure</h4>
              <ul className="disclosure-list">
                <li><span className="label">Mode:</span> Deterministic local</li>
                <li><span className="label">Network:</span> Network disabled</li>
                <li><span className="label">Filesystem:</span> Read-only filesystem</li>
                <li><span className="label">Model:</span> No model invoked</li>
                <li><span className="label">Shell:</span> No shell execution</li>
                <li><span className="label">Cost:</span> Estimated cost: $0.00</li>
              </ul>
            </section>

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
                    <p>Depth truncated: {(taskState.verification.details?.depthTruncated as boolean) ? 'Yes' : 'No'}</p>
                    <p>Count truncated: {(taskState.verification.details?.countTruncated as boolean) ? 'Yes' : 'No'}</p>
                  </div>
                </div>
              </section>
            )}

            <section className="inspector-section activity-section">
              <h4>Live Activity</h4>
              <ul className="activity-list">
                {taskState.events?.map(event => (
                  <li key={event.id} className="activity-item">
                    <span className="activity-seq">{event.sequence}</span>
                    <span className="activity-type">{event.type}</span>
                    <span className="activity-time">{new Date(event.createdAt).toLocaleTimeString()}</span>
                  </li>
                ))}
              </ul>
            </section>

            {taskState.evidence && taskState.evidence.length > 0 && (
              <section className="inspector-section evidence-section">
                <h4>Files Accessed ({taskState.evidence.length})</h4>
                <ul className="evidence-list">
                  {taskState.evidence.map(ev => (
                    <li key={ev.id} className="evidence-item" title={ev.path}>
                      {ev.path}
                    </li>
                  ))}
                </ul>
              </section>
            )}

          </div>
        )}
      </aside>
    </div>
  );
}
