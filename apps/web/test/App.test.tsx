import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
  }
}));

describe('Morrow Web App', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders correctly and lists projects', async () => {
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Test', workspacePath: '/test' }]);
    (apiClient.listProjectTasks as any).mockResolvedValue([]);
    
    render(<App />);
    expect(await screen.findByText(/Morrow Workspace Inspector/)).toBeDefined();
    expect(await screen.findByText(/Test \(\/test\)/)).toBeDefined();
  });

  it('starts inspection and displays three-step plan', async () => {
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Test', workspacePath: '/test' }]);
    (apiClient.listProjectTasks as any).mockResolvedValue([]);
    (apiClient.startInspectWorkspace as any).mockResolvedValue({ taskId: 't1' });
    
    // Mock the aggregate to show 3 steps and disclosure
    (apiClient.getTaskAggregate as any).mockResolvedValue({
      task: { id: 't1', status: 'verified' },
      plan: [
        { id: 's1', title: 'Validate workspace boundary', status: 'completed' },
        { id: 's2', title: 'Inspect workspace files', status: 'completed' },
        { id: 's3', title: 'Verify inspection evidence', status: 'completed' }
      ],
      disclosure: {
        executionMode: 'deterministic-local',
        networkAccess: 'disabled',
        filesystemAccess: 'read-only',
        modelInvocation: false,
        shellExecution: false,
        estimatedCostUsd: '$0.00'
      },
      events: []
    });

    render(<App />);
    
    const startBtn = await screen.findByText(/Start Inspect Workspace/i);
    fireEvent.click(startBtn);

    expect(await screen.findByText(/Validate workspace boundary/)).toBeDefined();
    expect(screen.getByText(/deterministic-local/)).toBeDefined();
    expect(screen.getByText(/disabled/)).toBeDefined();
    
    // Verify no fake claims
    expect(screen.queryByText(/fake/i)).toBeNull();
    expect(screen.queryByText(/model/i)).toBeDefined();
    expect(screen.queryByText(/tokens/i)).toBeNull();
  });
});
