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

  useEffect(() => {
    apiClient.listProjects().then(p => {
      setProjects(p);
      if (p.length > 0 && !selectedProjectId) setSelectedProjectId(p[0].id);
    }).catch(console.error);
  }, []);

  useEffect(() => {
    if (selectedProjectId) {
      apiClient.listProjectTasks(selectedProjectId).then(t => {
        setTasks(t);
        if (t.length > 0) setActiveTaskId(t[0].id);
      }).catch(console.error);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (!activeTaskId) {
      setTaskState(null);
      return;
    }
    let unsub: () => void = () => {};
    let isSubscribed = true;

    apiClient.getTaskAggregate(activeTaskId).then(agg => {
      if (!isSubscribed) return;
      setTaskState(agg);
      
      if (["queued", "running"].includes(agg.task.status)) {
        let lastSeq = agg.events.length > 0 ? agg.events[agg.events.length - 1].sequence : 0;
        unsub = apiClient.subscribeToTaskEvents(activeTaskId, lastSeq, (event) => {
          setTaskState(prev => {
            if (!prev) return prev;
            return {
              ...prev,
              events: [...(prev.events || []), event]
            };
          });
          // Refresh aggregate to get latest plan/evidence states
          apiClient.getTaskAggregate(activeTaskId).then(newAgg => {
            if (isSubscribed) setTaskState(newAgg);
          });
        }, () => {
          apiClient.getTaskAggregate(activeTaskId).then(newAgg => {
            if (isSubscribed) setTaskState(newAgg);
          });
        });
      }
    });

    return () => {
      isSubscribed = false;
      unsub();
    };
  }, [activeTaskId]);

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
      setProjectError(err.message);
    }
  };

  const handleStartInspection = async () => {
    if (!selectedProjectId) return;
    try {
      const { taskId } = await apiClient.startInspectWorkspace(selectedProjectId);
      setActiveTaskId(taskId);
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="container">
      <header>
        <h1>Morrow Workspace Inspector</h1>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <h2>Projects</h2>
          <select value={selectedProjectId} onChange={e => setSelectedProjectId(e.target.value)}>
            <option value="">Select a project...</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name} ({p.workspacePath})</option>
            ))}
          </select>

          <form onSubmit={handleCreateProject} className="new-project-form">
            <h3>New Project</h3>
            {projectError && <div className="error">{projectError}</div>}
            <input placeholder="Name" value={newProjectName} onChange={e => setNewProjectName(e.target.value)} required />
            <input placeholder="Workspace Absolute Path" value={newWorkspacePath} onChange={e => setNewWorkspacePath(e.target.value)} required />
            <button type="submit">Create</button>
          </form>

          {selectedProjectId && (
            <div className="task-actions">
              <button onClick={handleStartInspection} className="primary-btn">Start Inspect Workspace</button>
              
              <h3>History</h3>
              <ul className="task-list">
                {tasks.map(t => (
                  <li key={t.id} className={activeTaskId === t.id ? 'active' : ''} onClick={() => setActiveTaskId(t.id)}>
                    {new Date(t.createdAt).toLocaleString()} - {t.status}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        <main className="content">
          {!taskState ? (
            <div className="empty-state">Select or create a project to inspect a workspace.</div>
          ) : (
            <div className="task-details">
              <h2>Task: {taskState.task?.id} <span className={`badge ${taskState.task?.status}`}>{taskState.task?.status}</span></h2>
              
              <div className="grid-2">
                <div className="panel">
                  <h3>Plan (Exactly 3 Steps)</h3>
                  <ul className="plan-list">
                    {taskState.plan?.map(s => (
                      <li key={s.id}>
                        <strong>{s.title}</strong>
                        <span className={`badge ${s.status}`}>{s.status}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="panel">
                  <h3>Execution Disclosure</h3>
                  {taskState.disclosure ? (
                    <div className="disclosure-grid">
                      <div><strong>Mode:</strong> {taskState.disclosure.executionMode}</div>
                      <div><strong>Provider:</strong> {taskState.disclosure.provider}</div>
                      <div><strong>Network:</strong> {taskState.disclosure.networkAccess}</div>
                      <div><strong>Filesystem:</strong> {taskState.disclosure.filesystemAccess}</div>
                      <div><strong>Model Invoked:</strong> {taskState.disclosure.modelInvocation ? "Yes" : "No"}</div>
                      <div><strong>Shell Execution:</strong> {taskState.disclosure.shellExecution ? "Yes" : "No"}</div>
                      <div><strong>Est. Cost:</strong> {taskState.disclosure.estimatedCostUsd}</div>
                      <div><strong>Scope:</strong> {taskState.disclosure.workspaceScope}</div>
                    </div>
                  ) : (
                    <em>Waiting for disclosure...</em>
                  )}
                </div>
              </div>

              <div className="panel mt-2">
                <h3>Verification Result</h3>
                {taskState.verification ? (
                  <div>
                    <p><strong>Status:</strong> {taskState.verification.status}</p>
                    <p><strong>Summary:</strong> {taskState.verification.summary}</p>
                    <p><strong>Truncated:</strong> {taskState.verification.truncated ? "Yes" : "No"}</p>
                  </div>
                ) : (
                  <em>Waiting for verification...</em>
                )}
              </div>

              <div className="panel mt-2">
                <h3>Event Timeline</h3>
                <ul className="event-list">
                  {taskState.events?.map(e => (
                    <li key={e.id}><strong>{e.sequence}. {e.type}</strong> <span className="time">{new Date(e.createdAt).toLocaleTimeString()}</span></li>
                  ))}
                </ul>
              </div>

              <div className="panel mt-2">
                <h3>Evidence Files ({taskState.evidence?.length || 0})</h3>
                <ul className="evidence-list">
                  {taskState.evidence?.map(ev => (
                    <li key={ev.id}>{ev.path}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
