import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    getOnboardingState: vi.fn(),
    saveOnboardingState: vi.fn(),
    resetOnboardingState: vi.fn(),
    testProvider: vi.fn(),
    getHealth: vi.fn(),
    listSkills: vi.fn(),
    validateSkill: vi.fn(),
    runSkillDoctor: vi.fn(),
  }
}));

const PRESETS = [
  { preset: { id: 'balanced', label: 'Balanced', description: 'default', privacyDescription: 'cloud', costDescription: 'moderate' }, available: true, unavailableReason: null, resolved: { providerId: 'openai', model: 'gpt-4o-mini' } },
];
const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', kind: 'api-key', configured: true, available: true, endpointType: 'default', endpointHost: 'api.openai.com', authStatus: 'configured', capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: true, customEndpoint: true, local: false }, models: ['gpt-4o-mini'], defaultModel: 'gpt-4o-mini', note: null, setupHint: null },
  { id: 'gemini', label: 'Gemini', kind: 'api-key', configured: false, available: false, endpointType: 'default', endpointHost: 'generativelanguage.googleapis.com', authStatus: 'missing', capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: true, customEndpoint: false, local: false }, models: ['gemini-1.5-pro'], defaultModel: null, note: null, setupHint: null },
];
const MODELS = [
  { available: true, model: { id: 'gpt-4o-mini', providerId: 'openai', label: 'GPT-4o mini', speedClass: 'fast', costClass: 'low' } },
  { available: false, model: { id: 'gemini-1.5-pro', providerId: 'gemini', label: 'Gemini 1.5 Pro', speedClass: 'powerful', costClass: 'medium' } },
];

function defaults(providerConfigured = true) {
  (apiClient.getOnboardingState as any).mockResolvedValue({ onboarded: true, onboardingStep: null, useCase: 'Software Development', name: 'Alex' });
  (apiClient.listProjects as any).mockResolvedValue([]);
  (apiClient.saveOnboardingState as any).mockResolvedValue({ success: true });
  (apiClient.resetOnboardingState as any).mockResolvedValue({ success: true });
  (apiClient.testProvider as any).mockResolvedValue({ ok: true, latencyMs: 100 });
  (apiClient.getProviderStatus as any).mockResolvedValue({ configured: providerConfigured, provider: providerConfigured ? 'openai' : 'none', model: providerConfigured ? 'gpt-4o-mini' : 'none' });
  (apiClient.listProjectTasks as any).mockResolvedValue([]);
  (apiClient.listConversations as any).mockResolvedValue([]);
  (apiClient.listMessages as any).mockResolvedValue([]);
  (apiClient.listPresets as any).mockResolvedValue(PRESETS);
  (apiClient.listProviders as any).mockResolvedValue(PROVIDERS);
  (apiClient.listModels as any).mockResolvedValue(MODELS);
  (apiClient.listOAuthFindings as any).mockResolvedValue([]);
  (apiClient.listProjectMemory as any).mockResolvedValue([]);
  (apiClient.subscribeToTaskEvents as any).mockReturnValue(() => {});
  (apiClient.getTaskAggregate as any).mockResolvedValue({ task: { id: 't', status: 'running' }, plan: [], events: [], evidence: [], routing: null });
  (apiClient.getHealth as any).mockResolvedValue({ ok: true, service: 'morrow-orchestrator', apiVersion: 1, mockProvider: false, time: new Date().toISOString() });
  (apiClient.listSkills as any).mockResolvedValue([]);
  (global.fetch as any) = vi.fn().mockResolvedValue({ json: async () => ({ toolCalls: [], routing: null }) });
}

describe('Morrow Web App (redesigned shell)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaults(true); });

  it('renders the brand and a projects table', async () => {
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Feedback Analysis', workspacePath: '/test/path', createdAt: new Date().toISOString() }]);
    render(<App />);
    expect(await screen.findByText('Morrow')).toBeDefined();
    expect(await screen.findByText('Feedback Analysis')).toBeDefined();
    expect(screen.getAllByText(/Mission/i).length).toBeGreaterThan(0);
  });

  it('shows an empty state with no missions', async () => {
    (apiClient.listProjects as any).mockResolvedValue([]);
    render(<App />);
    expect(await screen.findByText(/No missions yet/i)).toBeDefined();
  });

  it('opens the New Project modal with workspace inputs', async () => {
    (apiClient.listProjects as any).mockResolvedValue([]);
    render(<App />);
    fireEvent.click((await screen.findAllByRole('button', { name: /New Project/i }))[0]);
    expect(await screen.findByLabelText(/Name/i)).toBeDefined();
    expect(screen.getByLabelText(/Workspace Path/i)).toBeDefined();
  });

  it('surfaces a project creation error in the modal', async () => {
    (apiClient.listProjects as any).mockResolvedValue([]);
    (apiClient.createProject as any).mockRejectedValue(new Error('Project error'));
    render(<App />);
    fireEvent.click((await screen.findAllByRole('button', { name: /New Project/i }))[0]);
    fireEvent.change(await screen.findByLabelText(/Name/i), { target: { value: 'New' } });
    fireEvent.change(screen.getByLabelText(/Workspace Path/i), { target: { value: '/new' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Project/i }));
    expect(await screen.findByText(/Project error/)).toBeDefined();
  });

  it('opens a project conversation and streams on send', async () => {
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Feedback Analysis', workspacePath: '/test/path', createdAt: new Date().toISOString() }]);
    (apiClient.createConversation as any).mockResolvedValue({ id: 'c1', projectId: 'p1', title: 'Conversation 1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    (apiClient.sendMessage as any).mockResolvedValue({
      task: { id: 't9', status: 'queued' },
      userMessage: { id: 'u1', conversationId: 'c1', role: 'user', content: 'Explain repo', streamingState: 'completed' },
      assistantMessage: { id: 'a1', conversationId: 'c1', role: 'assistant', content: '', taskId: 't9', streamingState: 'queued', provider: 'mock', model: 'mock-model' },
      routing: { providerId: 'mock', model: 'mock-model', presetId: 'balanced', privacy: 'cloud', reason: 'mock', fallbackUsed: false, overridden: false }
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Open project/i }));
    const input = await screen.findByPlaceholderText(/Message Morrow/i);
    fireEvent.change(input, { target: { value: 'Explain repo' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    expect(await screen.findByText('Explain repo')).toBeDefined();
    expect(await screen.findByRole('button', { name: /Stop/i })).toBeDefined();
  });

  it('lazy-loads slash skills and keeps help useful if that load fails', async () => {
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Feedback Analysis', workspacePath: '/test/path', createdAt: new Date().toISOString() }]);
    (apiClient.listSkills as any).mockRejectedValue(new Error('skills unavailable'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Open project/i }));
    expect(apiClient.listSkills).not.toHaveBeenCalled();

    const input = await screen.findByPlaceholderText(/Message Morrow/i);
    fireEvent.change(input, { target: { value: '/' } });
    await waitFor(() => expect(apiClient.listSkills).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('option', { name: /\/help/i })).toBeDefined();
  });

  it('handles slash keyboard, mouse, outside-click, deletion, and request overrides', async () => {
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Feedback Analysis', workspacePath: '/test/path', createdAt: new Date().toISOString() }]);
    (apiClient.createConversation as any).mockResolvedValue({ id: 'c1', projectId: 'p1', title: 'Conversation 1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    (apiClient.sendMessage as any).mockResolvedValue({
      task: { id: 't9', status: 'queued' },
      userMessage: { id: 'u1', conversationId: 'c1', role: 'user', content: 'Use override', streamingState: 'completed' },
      assistantMessage: { id: 'a1', conversationId: 'c1', role: 'assistant', content: '', taskId: 't9', streamingState: 'queued', provider: 'openai', model: 'gpt-4o-mini' },
      routing: { providerId: 'openai', model: 'gpt-4o-mini', presetId: 'balanced', privacy: 'cloud', reason: 'override', fallbackUsed: false, overridden: true }
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Open project/i }));
    const input = await screen.findByPlaceholderText(/Message Morrow/i);

    fireEvent.change(input, { target: { value: '/model' } });
    expect(await screen.findByRole('listbox', { name: /Commands/i })).toBeDefined();
    expect(screen.queryByText(/Gemini 1.5 Pro/i)).toBeNull();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(await screen.findByText(/Model set: OpenAI · GPT-4o mini/i)).toBeDefined();
    expect(document.querySelector('.composer-chip.accent')?.textContent).toContain('gpt-4o-mini');

    fireEvent.change(input, { target: { value: '/read' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: /\/read-only/i }));
    await waitFor(() => expect(document.querySelector('.composer-chip')?.textContent).toContain('Read-only'));

    fireEvent.change(input, { target: { value: '/help' } });
    expect(await screen.findByRole('listbox', { name: /Commands/i })).toBeDefined();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole('listbox', { name: /Commands/i })).toBeNull());

    fireEvent.change(input, { target: { value: '/' } });
    expect(await screen.findByRole('listbox', { name: /Commands/i })).toBeDefined();
    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(screen.queryByRole('listbox', { name: /Commands/i })).toBeNull());

    fireEvent.change(input, { target: { value: '/plan' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox', { name: /Commands/i })).toBeNull());
    fireEvent.change(input, { target: { value: 'Use override' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => expect(apiClient.sendMessage).toHaveBeenCalled());
    expect((apiClient.sendMessage as any).mock.calls[0][2]).toMatchObject({
      providerId: 'openai',
      model: 'gpt-4o-mini',
      mode: 'inspect',
    });
  });

  it('renders the providers settings tab', async () => {
    (apiClient.listProjects as any).mockResolvedValue([]);
    render(<App />);
    await screen.findByText(/No missions yet/i);
    fireEvent.click(screen.getByText('Settings', { selector: '.nav-item' }));
    expect(await screen.findByRole('tab', { name: 'Providers' })).toBeDefined();
    expect(await screen.findByText(/Model Providers/i)).toBeDefined();
  });

  it('renders the onboarding landing page when not onboarded', async () => {
    (apiClient.getOnboardingState as any).mockResolvedValue({ onboarded: false, onboardingStep: 'welcome', useCase: null, name: null });
    render(<App />);
    expect(await screen.findByText('M O R R O W')).toBeDefined();
    expect(screen.getByText('Private intelligence, built around you.')).toBeDefined();
    expect(screen.getByText('Simple Setup')).toBeDefined();
    expect(screen.getByText('Advanced Setup')).toBeDefined();
  });

  it('navigates through the onboarding wizard and verifies system checks', async () => {
    (apiClient.getOnboardingState as any).mockResolvedValue({ onboarded: false, onboardingStep: 'welcome', useCase: null, name: null });
    render(<App />);
    
    // Welcome Page -> System Check
    fireEvent.click(await screen.findByText('Simple Setup'));
    expect(await screen.findByRole('heading', { name: 'System Check' })).toBeDefined();
    expect(screen.getByText(/Verifying your Morrow installation/)).toBeDefined();

    // System Check -> Provider
    fireEvent.click(screen.getByText('Next'));
    expect(await screen.findByRole('heading', { name: 'Connect a Model Provider' })).toBeDefined();
    expect(screen.getByText(/Bring Your Own Key/)).toBeDefined();
  });
});
