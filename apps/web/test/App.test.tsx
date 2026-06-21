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
    getProviderStatus: vi.fn(),
    listConversations: vi.fn(),
    listMessages: vi.fn(),
    createConversation: vi.fn(),
    sendMessage: vi.fn(),
    cancelTask: vi.fn(),
    listPresets: vi.fn(),
    listProviders: vi.fn(),
    listModels: vi.fn(),
    listOAuthFindings: vi.fn(),
    listProjectMemory: vi.fn(),
    addMemory: vi.fn(),
    setMemoryEnabled: vi.fn(),
    deleteMemory: vi.fn(),
  }
}));

const PRESETS = [
  { preset: { id: 'balanced', label: 'Balanced', description: 'default', privacyDescription: 'cloud', costDescription: 'moderate' }, available: true, unavailableReason: null, resolved: { providerId: 'openai', model: 'gpt-4o-mini' } },
  { preset: { id: 'private-local', label: 'Private Local', description: 'local', privacyDescription: 'local', costDescription: 'free' }, available: false, unavailableReason: 'Enable Ollama to use Private Local.', resolved: null },
];

const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', kind: 'api-key', configured: true, available: true, endpointType: 'default', endpointHost: 'api.openai.com', authStatus: 'configured', capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: true, customEndpoint: true, local: false }, models: ['gpt-4o-mini'], defaultModel: 'gpt-4o-mini', note: null, setupHint: null },
  { id: 'ollama', label: 'Ollama (local)', kind: 'local', configured: false, available: false, endpointType: 'default', endpointHost: null, authStatus: 'not-applicable', capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: false, customEndpoint: true, local: true }, models: [], defaultModel: 'llama3.1', note: null, setupHint: 'Set OLLAMA_BASE_URL.' },
];

function configureDefaults(providerConfigured = false) {
  (apiClient.getProviderStatus as any).mockResolvedValue({ configured: providerConfigured, provider: providerConfigured ? 'openai' : 'none', model: providerConfigured ? 'gpt-4o-mini' : 'none' });
  (apiClient.listConversations as any).mockResolvedValue([]);
  (apiClient.listMessages as any).mockResolvedValue([]);
  (apiClient.listProjectTasks as any).mockResolvedValue([]);
  (apiClient.listPresets as any).mockResolvedValue(PRESETS);
  (apiClient.listProviders as any).mockResolvedValue(PROVIDERS);
  (apiClient.listModels as any).mockResolvedValue([]);
  (apiClient.listOAuthFindings as any).mockResolvedValue([]);
  (apiClient.listProjectMemory as any).mockResolvedValue([]);
}

describe('Morrow Web App', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configureDefaults(false);
  });

  it('renders the brand and lists projects', async () => {
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Test', workspacePath: '/test/path' }]);
    render(<App />);
    expect(await screen.findByText('Morrow')).toBeDefined();
    expect(await screen.findAllByText(/Test/)).toBeDefined();
  });

  it('shows "No provider configured" when no provider is set', async () => {
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Test', workspacePath: '/test/path' }]);
    render(<App />);
    expect(await screen.findByText(/No provider configured/i)).toBeDefined();
  });

  it('renders presets and warns when an unavailable preset is selected', async () => {
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Test', workspacePath: '/test/path' }]);
    render(<App />);
    const localBtn = await screen.findByRole('radio', { name: /Private Local/i });
    fireEvent.click(localBtn);
    expect(await screen.findByText(/Enable Ollama to use Private Local/i)).toBeDefined();
  });

  it('starts inspection and displays the plan and disclosure', async () => {
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Test', workspacePath: '/test/path' }]);
    (apiClient.startInspectWorkspace as any).mockResolvedValue({ taskId: 't1' });

    let subCallback: any;
    (apiClient.subscribeToTaskEvents as any).mockImplementation((_t: string, _l: number, cb: any) => { subCallback = cb; return () => {}; });
    (apiClient.getTaskAggregate as any).mockResolvedValue({
      task: { id: 't1', status: 'running' },
      plan: [
        { id: 's1', title: 'Validate workspace boundary', status: 'completed' },
        { id: 's2', title: 'Inspect workspace files', status: 'running' },
        { id: 's3', title: 'Verify inspection evidence', status: 'queued' }
      ],
      disclosure: { executionMode: 'deterministic-local', networkAccess: 'disabled', filesystemAccess: 'read-only', modelInvocation: false, shellExecution: false, estimatedCostUsd: '$0.00', workspaceScope: '/test/path', provider: 'deterministic-local' },
      events: [], evidence: [], routing: null
    });
    // The component re-fetches via a second request to /api/tasks/:id
    (global.fetch as any) = vi.fn().mockResolvedValue({ json: async () => ({ toolCalls: [], routing: null }) });

    render(<App />);
    fireEvent.click(await screen.findByText(/Inspect Workspace/i));
    expect(await screen.findByText(/Validate workspace boundary/)).toBeDefined();
    expect(screen.getByText(/Deterministic local/i)).toBeDefined();
    expect(screen.getByText(/Network disabled/i)).toBeDefined();

    expect(subCallback).toBeDefined();
    await act(async () => {
      subCallback({ sequence: 1, type: 'step.completed', payload: {}, id: 'ev1', taskId: 't1', createdAt: new Date().toISOString() });
    });
    await waitFor(() => expect(apiClient.getTaskAggregate).toHaveBeenCalledTimes(2));
  });

  it('displays inspection errors', async () => {
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Test', workspacePath: '/test/path' }]);
    (apiClient.startInspectWorkspace as any).mockRejectedValue(new Error('Test error'));
    render(<App />);
    fireEvent.click(await screen.findByText(/Inspect Workspace/i));
    expect(await screen.findByText(/Test error/)).toBeDefined();
  });

  it('handles project creation errors', async () => {
    (apiClient.listProjects as any).mockResolvedValue([]);
    (apiClient.createProject as any).mockRejectedValue(new Error('Project error'));
    render(<App />);
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'New' } });
    fireEvent.change(screen.getByLabelText(/Workspace Path/i), { target: { value: '/new' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Project/i }));
    expect(await screen.findByText(/Project error/)).toBeDefined();
  });

  it('sends a message and shows the stop control while streaming', async () => {
    configureDefaults(true);
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Test', workspacePath: '/test/path' }]);
    (apiClient.listConversations as any).mockResolvedValue([{ id: 'c1', projectId: 'p1', title: 'Chat', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
    (apiClient.subscribeToTaskEvents as any).mockReturnValue(() => {});
    (apiClient.getTaskAggregate as any).mockResolvedValue({ task: { id: 't9', status: 'running' }, plan: [], events: [], evidence: [], routing: { providerId: 'mock', model: 'mock-model', presetId: 'balanced', privacy: 'cloud', reason: 'mock', fallbackUsed: false, overridden: false } });
    (global.fetch as any) = vi.fn().mockResolvedValue({ json: async () => ({ toolCalls: [], routing: null }) });
    (apiClient.sendMessage as any).mockResolvedValue({
      task: { id: 't9', status: 'queued' },
      userMessage: { id: 'u1', conversationId: 'c1', role: 'user', content: 'Explain repo', streamingState: 'completed' },
      assistantMessage: { id: 'a1', conversationId: 'c1', role: 'assistant', content: '', taskId: 't9', streamingState: 'queued', provider: 'mock', model: 'mock-model' },
      routing: { providerId: 'mock', model: 'mock-model', presetId: 'balanced', privacy: 'cloud', reason: 'mock', fallbackUsed: false, overridden: false }
    });

    render(<App />);
    const input = await screen.findByPlaceholderText(/Ask Morrow/i);
    fireEvent.change(input, { target: { value: 'Explain repo' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }));
    expect(await screen.findByText('Explain repo')).toBeDefined();
    expect(await screen.findByRole('button', { name: /Stop/i })).toBeDefined();
  });

  it('renders the providers settings tab', async () => {
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Test', workspacePath: '/test/path' }]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Settings & Provider/i }));
    expect(await screen.findByText(/Model Providers/i)).toBeDefined();
    expect(await screen.findAllByText(/OpenAI/i)).toBeDefined();
  });
});
