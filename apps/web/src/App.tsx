import React, { useEffect, useMemo, useState } from 'react';
import { apiClient } from './api/client';
import type { ExecutionDisclosure, PlanStep, Project, Task, TaskEvent, TaskEvidence, VerificationResult } from '@morrow/contracts';
import './App.css';

type TaskAggregate = { task?: Task; plan?: PlanStep[]; events?: TaskEvent[]; evidence?: TaskEvidence[]; disclosure?: ExecutionDisclosure; verification?: VerificationResult };
const terminal = new Set(['verified', 'failed', 'interrupted']);
const nav = [['◷', 'Today'], ['◌', 'Conversations'], ['▣', 'Projects'], ['◎', 'Agents'], ['↻', 'Automations'], ['⚙', 'Settings']] as const;

function statusLabel(status: Task['status']) { return status[0]!.toUpperCase() + status.slice(1); }
function compactPath(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path; }
function relativeTime(value?: string) { if (!value) return '—'; const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000)); return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m ago` : new Date(value).toLocaleDateString(); }

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTaskId, setActiveTaskId] = useState('');
  const [taskState, setTaskState] = useState<TaskAggregate | null>(null);
  const [projectError, setProjectError] = useState('');
  const [taskError, setTaskError] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [newWorkspacePath, setNewWorkspacePath] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(true);

  useEffect(() => {
    apiClient.listProjects().then((items) => {
      setProjects(items); setSelectedProjectId((current) => current || items[0]?.id || '');
    }).catch(() => setProjectError('Projects could not be loaded.')).finally(() => setLoadingProjects(false));
  }, []);

  const refreshTasks = (projectId: string) => apiClient.listProjectTasks(projectId).then(setTasks).catch(() => setTaskError('Task history could not be loaded.'));
  useEffect(() => {
    if (!selectedProjectId) { setTasks([]); setActiveTaskId(''); return; }
    refreshTasks(selectedProjectId);
  }, [selectedProjectId]);

  useEffect(() => {
    if (!activeTaskId) { setTaskState(null); return; }
    let subscribed = true;
    let unsubscribe = () => {};
    const load = async () => {
      try {
        const aggregate = await apiClient.getTaskAggregate(activeTaskId);
        if (!subscribed) return;
        setTaskState(aggregate);
        if (aggregate.task && !terminal.has(aggregate.task.status)) {
          const after = aggregate.events?.at(-1)?.sequence ?? 0;
          unsubscribe = apiClient.subscribeToTaskEvents(activeTaskId, after, (event) => {
            if (!subscribed) return;
            setTaskState((current) => current ? { ...current, events: [...(current.events ?? []), event].filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index).sort((a, b) => a.sequence - b.sequence) } : current);
            if (['step.started', 'step.completed', 'task.verified', 'task.failed', 'task.interrupted'].includes(event.type)) {
              apiClient.getTaskAggregate(activeTaskId).then((next) => {
                if (!subscribed) return;
                setTaskState(next);
                if (next.task && terminal.has(next.task.status)) setTasks((items) => items.map((item) => item.id === next.task?.id ? next.task : item));
              });
              if (['task.verified', 'task.failed', 'task.interrupted'].includes(event.type)) refreshTasks(selectedProjectId);
            }
          }, () => {
            apiClient.getTaskAggregate(activeTaskId).then((next) => { if (subscribed) { setTaskState(next); if (next.task) setTasks((items) => items.map((item) => item.id === next.task?.id ? next.task : item)); refreshTasks(selectedProjectId); } });
          });
        }
      } catch { if (subscribed) setTaskError('Task details could not be loaded.'); }
    };
    load();
    return () => { subscribed = false; unsubscribe(); };
  }, [activeTaskId, selectedProjectId]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const selectedTask = taskState?.task;
  const latestTask = taskState?.task?.projectId === selectedProjectId ? taskState.task : tasks.at(0);
  const projectRows = useMemo(() => projects.map((project) => ({ project, selected: project.id === selectedProjectId })), [projects, selectedProjectId]);

  async function createProject(event: React.FormEvent) {
    event.preventDefault(); setProjectError('');
    try {
      const project = await apiClient.createProject(newProjectName, newWorkspacePath);
      setProjects((items) => [...items, project]); setSelectedProjectId(project.id); setNewProjectName(''); setNewWorkspacePath(''); setCreateOpen(false);
    } catch (error) { setProjectError(error instanceof Error ? error.message : 'Project could not be created.'); }
  }
  async function startInspection() {
    if (!selectedProjectId) return;
    setTaskError('');
    try {
      const { taskId } = await apiClient.startInspectWorkspace(selectedProjectId);
      const now = new Date().toISOString();
      setTasks((items) => [{ version: 1, id: taskId, projectId: selectedProjectId, kind: 'inspect_workspace', status: 'queued', createdAt: now, updatedAt: now }, ...items]);
      setActiveTaskId(taskId); setInspectorOpen(true);
    } catch (error) { setTaskError(error instanceof Error ? error.message : 'Inspection could not start.'); }
  }

  return <div className="app-shell">
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="brand-lockup"><span className="brand-mark" aria-hidden="true">M</span><span>Morrow</span></div>
      <nav className="nav-list">
        {nav.map(([icon, label]) => <button key={label} className={`nav-item ${label === 'Projects' ? 'active' : 'planned'}`} disabled={label !== 'Projects'} aria-current={label === 'Projects' ? 'page' : undefined}>
          <span aria-hidden="true">{icon}</span><span>{label}</span>{label !== 'Projects' && <small>Planned</small>}
        </button>)}
      </nav>
      <div className="sidebar-footer"><span className="local-dot" aria-hidden="true" />Local workspace</div>
    </aside>

    <section className="workspace">
      <header className="topbar">
        <div><p className="crumb">Workspace / Projects</p><h1>Projects</h1></div>
        <div className="topbar-actions"><span className="local-status"><span className="local-dot" />Local</span><button className="inspector-toggle" onClick={() => setInspectorOpen((open) => !open)} aria-expanded={inspectorOpen}>Inspector</button><button className="primary-action" onClick={() => setCreateOpen(true)}>+ New project</button></div>
      </header>
      <main className="project-workspace" aria-live="polite">
        {projectError && <div className="inline-error" role="alert">{projectError}</div>}
        {taskError && <div className="inline-error" role="alert">{taskError}</div>}
        <section className="project-table-wrap" aria-label="Projects">
          <div className="table-toolbar"><span>{projects.length} project{projects.length === 1 ? '' : 's'}</span><span>{selectedProject ? `Selected: ${selectedProject.name}` : 'Choose a project'}</span></div>
          {loadingProjects ? <div className="table-state">Loading projects…</div> : projects.length === 0 ? <div className="table-state empty"><strong>No projects yet</strong><span>Create a local workspace project to start a deterministic inspection.</span><button className="secondary-action" onClick={() => setCreateOpen(true)}>Create project</button></div> : <div className="project-table" role="table" aria-label="Project list">
            <div className="project-row header" role="row"><span>Name</span><span>Workspace</span><span>Latest task</span><span>Activity</span><span>Tasks</span></div>
            {projectRows.map(({ project, selected }) => <button key={project.id} className={`project-row ${selected ? 'selected' : ''}`} role="row" onClick={() => { setSelectedProjectId(project.id); setInspectorOpen(true); }}>
              <span className="project-name"><b>{project.name}</b><small>Local project</small></span><span className="workspace-cell" title={project.workspacePath}>{compactPath(project.workspacePath)}</span><span>{selected && latestTask ? <StatusChip status={latestTask.status} /> : <span className="muted">—</span>}</span><span className="muted">{selected && latestTask ? relativeTime(latestTask.updatedAt) : '—'}</span><span className="muted">{selected ? tasks.length : '—'}</span>
            </button>)}
          </div>}
        </section>
        {selectedProject && <section className="task-panel"><div className="task-panel-head"><div><p className="eyebrow">{compactPath(selectedProject.workspacePath)}</p><h2>{selectedProject.name}</h2></div><button className="primary-action" onClick={startInspection}>Inspect workspace</button></div>
          {tasks.length === 0 ? <div className="task-empty">No inspections recorded. Run a read-only workspace inspection when ready.</div> : <div className="task-list" role="listbox" aria-label="Project tasks">{tasks.map((task) => { const currentTask = task.id === activeTaskId && taskState?.task ? taskState.task : task; return <button key={task.id} className={`task-row ${activeTaskId === task.id ? 'selected' : ''}`} role="option" aria-selected={activeTaskId === task.id} onClick={() => { setActiveTaskId(task.id); setInspectorOpen(true); }}><span className="task-glyph" aria-hidden="true">⌁</span><span><b>Inspect workspace</b><small>{new Date(task.createdAt).toLocaleString()}</small></span><StatusChip status={currentTask.status} /><span className="task-chevron">›</span></button>; })}</div>}
        </section>}
      </main>
    </section>

    <aside className={`inspector ${inspectorOpen ? 'open' : ''}`} aria-label="Contextual inspector">
      <div className="inspector-bar"><div><p className="eyebrow">Inspector</p><h2>{selectedTask ? 'Task details' : selectedProject ? selectedProject.name : 'No selection'}</h2></div><button className="close-inspector" onClick={() => setInspectorOpen(false)} aria-label="Close inspector">×</button></div>
      {!selectedTask ? <div className="inspector-state">Select an inspection to view plans, evidence, and verification.</div> : <Inspector aggregate={taskState!} />}
    </aside>

    {createOpen && <div className="modal-backdrop" role="presentation"><form className="create-modal" onSubmit={createProject} aria-labelledby="create-project-title"><div className="modal-head"><div><p className="eyebrow">New local project</p><h2 id="create-project-title">Create project</h2></div><button type="button" className="close-inspector" onClick={() => setCreateOpen(false)} aria-label="Close create project">×</button></div><label>Name<input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} required autoFocus /></label><label>Workspace path<input value={newWorkspacePath} onChange={(event) => setNewWorkspacePath(event.target.value)} required /></label><p className="form-note">Morrow resolves this path locally before creating the project.</p><div className="modal-actions"><button type="button" className="secondary-action" onClick={() => setCreateOpen(false)}>Cancel</button><button className="primary-action" type="submit">Create project</button></div></form></div>}
  </div>;
}

function StatusChip({ status }: { status: Task['status'] }) { return <span className={`status-chip ${status}`}><i aria-hidden="true" />{statusLabel(status)}</span>; }

function Inspector({ aggregate }: { aggregate: TaskAggregate }) {
  const { task, plan = [], events = [], evidence = [], disclosure, verification } = aggregate;
  if (!task) return null;
  return <div className="inspector-scroll"><div className="status-overview"><StatusChip status={task.status} /><span>{task.kind === 'inspect_workspace' ? 'Read-only local inspection' : task.kind}</span></div>
    {task.status === 'failed' && <div className="inline-error" role="alert">Task failed. Review execution activity.</div>}
    <InspectorSection title="Plan"><ol className="step-list">{plan.map((step) => <li key={step.id} className={step.status}><span>{step.position}</span><div><b>{step.title}</b><small>{step.description}</small></div><em>{step.status}</em></li>)}</ol></InspectorSection>
    <InspectorSection title="Privacy & execution">{disclosure ? <dl className="detail-grid"><dt>Mode</dt><dd>Deterministic local</dd><dt>Network</dt><dd>Network disabled</dd><dt>Filesystem</dt><dd>Read-only filesystem</dd><dt>Model</dt><dd>No model invoked</dd><dt>Shell</dt><dd>No shell execution</dd><dt>Cost</dt><dd>Estimated cost: zero</dd></dl> : <p className="muted">Disclosure appears when execution begins.</p>}</InspectorSection>
    <InspectorSection title={`Activity · ${events.length}`}><ul className="event-list">{events.slice(-8).map((event) => <li key={event.id}><span>{event.sequence}</span><div><b>{event.type}</b><small>{new Date(event.createdAt).toLocaleTimeString()}</small></div></li>)}</ul></InspectorSection>
    <InspectorSection title={`Evidence · ${evidence.length}`}>{evidence.length ? <ul className="evidence-list">{evidence.map((item) => <li key={item.id}><span>⌁</span>{item.path}</li>)}</ul> : <p className="muted">No workspace entries recorded.</p>}</InspectorSection>
    <InspectorSection title="Verification">{verification ? <div className="verification"><StatusChip status={verification.status as Task['status']} /><p>{verification.summary}</p><small>{String(verification.details.resultCount ?? 0)} entries · {Boolean(verification.details.depthTruncated || verification.details.countTruncated) ? 'truncated' : 'complete'}</small></div> : <p className="muted">Verification pending.</p>}</InspectorSection>
  </div>;
}
function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) { return <section className="inspector-section"><h3>{title}</h3>{children}</section>; }
