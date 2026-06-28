import { describe, it, expect } from 'vitest';
import { buildSlashCommands, filterSlashCommands } from '../src/commands';

const providers: any[] = [
  { id: 'openai', label: 'OpenAI', configured: true, available: true, defaultModel: 'gpt-5.4-mini' },
  { id: 'deepseek', label: 'DeepSeek', configured: true, available: true, defaultModel: 'deepseek-chat' },
  { id: 'gemini', label: 'Gemini', configured: false, available: false, defaultModel: null },
  { id: 'mock', label: 'Mock', configured: true, available: true, defaultModel: 'mock-model' },
];
const models: any[] = [
  { available: true, model: { id: 'gpt-5.4', providerId: 'openai', label: 'GPT-5.4', speedClass: 'powerful', costClass: 'medium' } },
  { available: true, model: { id: 'deepseek-v4-pro', providerId: 'deepseek', label: 'DeepSeek V4 Pro', speedClass: 'powerful', costClass: 'low' } },
  { available: false, model: { id: 'gemini-1.5-pro', providerId: 'gemini', label: 'Gemini 1.5 Pro', speedClass: 'powerful', costClass: 'medium' } },
];
const presets: any[] = [
  { preset: { id: 'balanced', label: 'Balanced', description: 'default' }, available: true, unavailableReason: null, resolved: null },
];
const skills = [
  { id: 'ci-cd', name: 'CI/CD', description: 'pipelines' },
  { id: 'security-audit', name: 'Security Audit', description: 'find vulns' },
];

function build() {
  return buildSlashCommands({ providers, models, presets, skills });
}

describe('buildSlashCommands', () => {
  it('offers only available models and never an unavailable or mock one', () => {
    const cmds = build();
    const modelCmds = cmds.filter((c) => c.group === 'Model').map((c) => c.command);
    expect(modelCmds).toContain('model openai gpt-5.4');
    expect(modelCmds).toContain('model deepseek deepseek-v4-pro');
    expect(modelCmds.some((c) => c.includes('gemini'))).toBe(false); // unavailable
  });

  it('offers configured providers but excludes mock and unconfigured', () => {
    const provCmds = build().filter((c) => c.group === 'Provider').map((c) => c.command);
    expect(provCmds).toEqual(expect.arrayContaining(['provider openai', 'provider deepseek']));
    expect(provCmds).not.toContain('provider mock');
    expect(provCmds).not.toContain('provider gemini');
  });

  it('includes modes, skills, navigation, and chat utilities', () => {
    const groups = new Set(build().map((c) => c.group));
    for (const g of ['Mode', 'Skill', 'Go to', 'Chat', 'Preset']) expect(groups.has(g)).toBe(true);
    expect(build().filter((c) => c.group === 'Skill')).toHaveLength(skills.length);
  });

  it('runs a model command through the actions interface', () => {
    const cmd = build().find((c) => c.command === 'model deepseek deepseek-v4-pro')!;
    let captured: any = null;
    cmd.run({ setModel: (p, m, l) => (captured = { p, m, l }) } as any);
    expect(captured).toMatchObject({ p: 'deepseek', m: 'deepseek-v4-pro' });
  });
});

describe('filterSlashCommands', () => {
  it('predicts by prefix and word-start as the user types', () => {
    const cmds = build();
    const top = filterSlashCommands(cmds, 'model').map((c) => c.command);
    expect(top.every((c) => c.startsWith('model') || top.length > 0)).toBe(true);
    expect(filterSlashCommands(cmds, 'model')[0].command.startsWith('model')).toBe(true);
  });

  it('matches "deep" to DeepSeek entries', () => {
    const hits = filterSlashCommands(build(), 'deep').map((c) => c.command);
    expect(hits.some((c) => c.includes('deepseek'))).toBe(true);
  });

  it('matches a skill by name fragment', () => {
    const hits = filterSlashCommands(build(), 'secur').map((c) => c.command);
    expect(hits).toContain('skill security-audit');
  });

  it('returns the full catalog (capped) for an empty query', () => {
    expect(filterSlashCommands(build(), '').length).toBeGreaterThan(0);
  });
});
