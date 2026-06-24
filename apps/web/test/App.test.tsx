import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
];

function mocked(fn: unknown): Mock {
  return fn as unknown as Mock;
}

function defaults(providerConfigured = true) {
  mocked(apiClient.getOnboardingState).mockResolvedValue({ onboarded: true, onboardingStep: null, useCase: 'Software Development', name: 'Alex' });
  mocked(apiClient.listProjects).mockResolvedValue([]);
  mocked(apiClient.saveOnboardingState).mockResolvedValue({ success: true });
  mocked(apiClient.resetOnboardingState).mockResolvedValue({ success: true });
  mocked(apiClient.testProvider).mockResolvedValue({ ok: true, latencyMs: 100 });
  mocked(apiClient.getProviderStatus).mockResolvedValue({ configured: providerConfigured, provider: providerConfigured ? 'openai' : 'none', model: providerConfigured ? 'gpt-4o-mini' : 'none' });
  mocked(apiClient.listProjectTasks).mockResolvedValue([]);
  mocked(apiClient.listConversations).mockResolvedValue([]);
  mocked(apiClient.listMessages).mockResolvedValue([]);
  mocked(apiClient.listPresets).mockResolvedValue(PRESETS);
  mocked(apiClient.listProviders).mockResolvedValue(PROVIDERS);
  mocked(apiClient.listModels).mockResolvedValue([]);
  mocked(apiClient.listOAuthFindings).mockResolvedValue([]);
  mocked(apiClient.listProjectMemory).mockResolvedValue([]);
  mocked(apiClient.subscribeToTaskEvents).mockReturnValue(() => {});
  mocked(apiClient.getTaskAggregate).mockResolvedValue({ task: { id: 't', status: 'running' }, plan: [], events: [], evidence: [], routing: null });
  mocked(apiClient.getHealth).mockResolvedValue({ ok: true, service: 'morrow-orchestrator', apiVersion: 1, mockProvider: false, time: new Date().toISOString() });
  mocked(apiClient.listSkills).mockResolvedValue([]);
}

describe('Morrow Web App (redesigned shell)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaults(true); });

  it('renders the brand and a projects table', async () => {
    mocked(apiClient.listProjects).mockResolvedValue([{ id: 'p1', name: 'Feedback Analysis', workspacePath: '/test/path', createdAt: new Date().toISOString() }]);
    render(<App />);
    expect(await screen.findByText('Morrow')).toBeDefined();
    expect(await screen.findByText('Feedback Analysis')).toBeDefined();
    expect(screen.getAllByText(/Mission/i).length).toBeGreaterThan(0);
  });

  it('shows an empty state with no missions', async () => {
    mocked(apiClient.listProjects).mockResolvedValue([]);
    render(<App />);
    expect(await screen.findByText(/No missions yet/i)).toBeDefined();
  });

  it('opens the New Project modal with workspace inputs', async () => {
    mocked(apiClient.listProjects).mockResolvedValue([]);
    render(<App />);
    fireEvent.click((await screen.findAllByRole('button', { name: /New Project/i }))[0]);
    expect(await screen.findByLabelText(/Name/i)).toBeDefined();
    expect(screen.getByLabelText(/Workspace Path/i)).toBeDefined();
  });

  it('surfaces a project creation error in the modal', async () => {
    mocked(apiClient.listProjects).mockResolvedValue([]);
    mocked(apiClient.createProject).mockRejectedValue(new Error('Project error'));
    render(<App />);
    fireEvent.click((await screen.findAllByRole('button', { name: /New Project/i }))[0]);
    fireEvent.change(await screen.findByLabelText(/Name/i), { target: { value: 'New' } });
    fireEvent.change(screen.getByLabelText(/Workspace Path/i), { target: { value: '/new' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Project/i }));
    expect(await screen.findByText(/Project error/)).toBeDefined();
  });

  it('opens a project conversation and streams on send', async () => {
    mocked(apiClient.listProjects).mockResolvedValue([{ id: 'p1', name: 'Feedback Analysis', workspacePath: '/test/path', createdAt: new Date().toISOString() }]);
    mocked(apiClient.createConversation).mockResolvedValue({ id: 'c1', projectId: 'p1', title: 'Conversation 1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    mocked(apiClient.sendMessage).mockResolvedValue({
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

  it('renders the providers settings tab', async () => {
    mocked(apiClient.listProjects).mockResolvedValue([]);
    render(<App />);
    await screen.findByText(/No missions yet/i);
    fireEvent.click(screen.getByText('Settings', { selector: '.nav-item' }));
    expect(await screen.findByRole('tab', { name: 'Providers' })).toBeDefined();
    expect(await screen.findByText(/Model Providers/i)).toBeDefined();
  });

  it('renders the onboarding landing page when not onboarded', async () => {
    mocked(apiClient.getOnboardingState).mockResolvedValue({ onboarded: false, onboardingStep: 'welcome', useCase: null, name: null });
    render(<App />);
    expect(await screen.findByText('M O R R O W')).toBeDefined();
    expect(screen.getByText('Private intelligence, built around you.')).toBeDefined();
    expect(screen.getByText('Simple Setup')).toBeDefined();
    expect(screen.getByText('Advanced Setup')).toBeDefined();
  });

  it('navigates through the onboarding wizard and verifies system checks', async () => {
    mocked(apiClient.getOnboardingState).mockResolvedValue({ onboarded: false, onboardingStep: 'welcome', useCase: null, name: null });
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
