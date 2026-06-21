import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import App from '../src/App';
import { apiClient } from '../src/api/client';

vi.mock('../src/api/client', () => ({
  apiClient: {
    listProjects: vi.fn(),
    createProject: vi.fn(),
    listProjectTasks: vi.fn(),
    startInspectWorkspace: vi.fn(),
    getTaskAggregate: vi.fn(),
    subscribeToTaskEvents: vi.fn(),
    getProviderStatus: vi.fn().mockResolvedValue({ configured: false, provider: 'none', model: 'none' }),
    listConversations: vi.fn().mockResolvedValue([]),
    listMessages: vi.fn().mockResolvedValue([]),
    createConversation: vi.fn(),
    sendMessage: vi.fn(),
    cancelTask: vi.fn().mockResolvedValue(undefined),
  }
}));

describe('Morrow Web App', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (apiClient.getProviderStatus as any).mockResolvedValue({ configured: false, provider: 'none', model: 'none' });
    (apiClient.listConversations as any).mockResolvedValue([]);
    (apiClient.listMessages as any).mockResolvedValue([]);
  });

  it('renders correctly and lists projects', async () => {
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Test', workspacePath: '/test/path' }]);
    (apiClient.listProjectTasks as any).mockResolvedValue([]);
    
    render(<App />);
    expect(await screen.findByText(/Morrow/)).toBeDefined();
    
    // Check that it shows in the dropdown
    expect(await screen.findAllByText(/Test/)).toBeDefined();
  });

  it('starts inspection and displays three-step plan', async () => {
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Test', workspacePath: '/test/path' }]);
    (apiClient.listProjectTasks as any).mockResolvedValue([]);
    (apiClient.startInspectWorkspace as any).mockResolvedValue({ taskId: 't1' });
    
    let subCallback: any;
    (apiClient.subscribeToTaskEvents as any).mockImplementation((tid: string, lseq: number, cb: any) => {
      subCallback = cb;
      return () => {};
    });

    (apiClient.getTaskAggregate as any).mockResolvedValue({
      task: { id: 't1', status: 'running' },
      plan: [
        { id: 's1', title: 'Validate workspace boundary', status: 'completed' },
        { id: 's2', title: 'Inspect workspace files', status: 'running' },
        { id: 's3', title: 'Verify inspection evidence', status: 'queued' }
      ],
      disclosure: {
        executionMode: 'deterministic-local',
        networkAccess: 'disabled',
        filesystemAccess: 'read-only',
        modelInvocation: false,
        shellExecution: false,
        estimatedCostUsd: '$0.00',
        workspaceScope: '/test/path',
        provider: 'none'
      },
      events: []
    });

    render(<App />);
    
    // Select project manually since we aren't testing the auto-select specifically here if it fails
    // actually, it should auto-select the first project.
    
    const startBtn = await screen.findByText(/Inspect Workspace/i);
    fireEvent.click(startBtn);

    // Initial state has 'running' step
    expect(await screen.findByText(/Validate workspace boundary/)).toBeDefined();
    expect(screen.getByText(/Deterministic local/i)).toBeDefined();
    expect(screen.getByText(/Network disabled/i)).toBeDefined();
    
    // Trigger an SSE event
    expect(subCallback).toBeDefined();
    await act(async () => {
      subCallback({ sequence: 1, type: 'step.completed', payload: {}, id: 'ev1', taskId: 't1', createdAt: new Date().toISOString() });
    });
    await waitFor(() => expect(apiClient.getTaskAggregate).toHaveBeenCalledTimes(2));
  });

  it('handles and displays errors correctly', async () => {
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Test', workspacePath: '/test/path' }]);
    (apiClient.listProjectTasks as any).mockResolvedValue([]);
    (apiClient.startInspectWorkspace as any).mockRejectedValue(new Error('Test error'));
    
    render(<App />);
    
    const startBtn = await screen.findByText(/Inspect Workspace/i);
    fireEvent.click(startBtn);
    
    expect(await screen.findByText(/Test error/)).toBeDefined();
  });
  
  it('handles project creation error', async () => {
    (apiClient.listProjects as any).mockResolvedValue([]);
    (apiClient.createProject as any).mockRejectedValue(new Error('Project error'));
    
    render(<App />);
    
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'New' } });
    fireEvent.change(screen.getByLabelText(/Workspace Path/i), { target: { value: '/new' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Project/i }));
    
    expect(await screen.findByText(/Project error/)).toBeDefined();
  });
});
