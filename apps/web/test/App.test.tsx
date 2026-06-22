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
  }
}));

const PRESETS = [
  { preset: { id: 'balanced', label: 'Balanced', description: 'default', privacyDescription: 'cloud', costDescription: 'moderate' }, available: true, unavailableReason: null, resolved: { providerId: 'openai', model: 'gpt-4o-mini' } },
];
const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', kind: 'api-key', configured: true, available: true, endpointType: 'default', endpointHost: 'api.openai.com', authStatus: 'configured', capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: true, customEndpoint: true, local: false }, models: ['gpt-4o-mini'], defaultModel: 'gpt-4o-mini', note: null, setupHint: null },
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
  (apiClient.listModels as any).mockResolvedValue([]);
  (apiClient.listOAuthFindings as any).mockResolvedValue([]);
  (apiClient.listProjectMemory as any).mockResolvedValue([]);
  (apiClient.subscribeToTaskEvents as any).mockReturnValue(() => {});
  (apiClient.getTaskAggregate as any).mockResolvedValue({ task: { id: 't', status: 'running' }, plan: [], events: [], evidence: [], routing: null });
  (global.fetch as any) = vi.fn().mockResolvedValue({ json: async () => ({ toolCalls: [], routing: null }) });
}

describe('Morrow Web App (redesigned shell)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaults(true); });

  it('renders the brand and a projects table', async () => {
    (apiClient.listProjects as any).mockResolvedValue([{ id: 'p1', name: 'Feedback Analysis', workspacePath: '/test/path', createdAt: new Date().toISOString() }]);
    render(<App />);
    expect(await screen.findByText('Morrow')).toBeDefined();
    expect(await screen.findByText('Feedback Analysis')).toBeDefined();
    expect(screen.getAllByText(/Projects/i).length).toBeGreaterThan(0);
  });

  it('shows an empty state with no projects', async () => {
    (apiClient.listProjects as any).mockResolvedValue([]);
    render(<App />);
    expect(await screen.findByText(/No projects yet/i)).toBeDefined();
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

  it('renders the providers settings tab', async () => {
    (apiClient.listProjects as any).mockResolvedValue([]);
    render(<App />);
    await screen.findByText(/No projects yet/i);
    fireEvent.click(screen.getByText('Settings', { selector: '.nav-item' }));
    expect(await screen.findByRole('tab', { name: 'Providers' })).toBeDefined();
    expect(await screen.findByText(/Model Providers/i)).toBeDefined();
  });

  it('renders the onboarding landing page when not onboarded', async () => {
    (apiClient.getOnboardingState as any).mockResolvedValue({ onboarded: false, onboardingStep: 'welcome', useCase: null, name: null });
    render(<App />);
    expect(await screen.findByText('M O R R O W')).toBeDefined();
    expect(screen.getByText('Private intelligence, built around you.')).toBeDefined();
  });

  it('navigates through the onboarding wizard and verifies truthful commands', async () => {
    (apiClient.getOnboardingState as any).mockResolvedValue({ onboarded: false, onboardingStep: 'welcome', useCase: null, name: null });
    render(<App />);
    
    // Welcome Page -> Install Page
    fireEvent.click(await screen.findByText('Begin Onboarding'));
    expect(await screen.findByText('Developer Preview Setup')).toBeDefined();
    expect(screen.getByText(/git clone/)).toBeDefined(); // Verifies presence of developer preview setup git clone instruction

    // Install Page -> Profile Page
    fireEvent.click(screen.getByText('Next'));
    expect(await screen.findByText('Profile & Setup')).toBeDefined();
  });
});
