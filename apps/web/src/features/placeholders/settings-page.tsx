import { Button } from "@morrow/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleCheckBig,
  LockKeyhole,
  Network,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserCircle,
  Wrench,
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { assistantProfileApi, assistantProfileQueries } from "../../api/assistant-profile.js";
import { ApiClientError } from "../../api/client.js";
import { ProductHeader } from "../../components/product-frame.js";
import { useUserSettings } from "../../state/settings-store.js";
import { useTheme, type ThemePreference } from "../../state/theme.js";
import { McpSettingsSection } from "../mcp/mcp-settings-section.js";

function safeError(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

const PRIVACY_MODE_COPY = {
  local_only: {
    label: "Prefer local providers",
    hint: "Records your preference for local models. It does not block configured cloud providers or tools.",
  },
  controlled_cloud: {
    label: "Cloud providers available",
    hint: "Records that your configured cloud providers are acceptable for ordinary work.",
  },
  custom: {
    label: "Custom preference",
    hint: "Records that you intend to review provider choices per project or task.",
  },
} as const;

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; hint: string }> = [
  { value: "light", label: "Light", hint: "Always use the light theme." },
  { value: "dark", label: "Dark", hint: "Always use the dark theme." },
  { value: "system", label: "System", hint: "Follow your device's appearance." },
];

const CHAPTERS = [
  { id: "appearance", label: "Appearance", detail: "Theme and density", icon: Palette },
  { id: "model", label: "Model behavior", detail: "Defaults and streaming", icon: SlidersHorizontal },
  { id: "privacy", label: "Privacy", detail: "Routing and local data", icon: ShieldCheck },
  { id: "approvals", label: "Approvals", detail: "Control boundaries", icon: CircleCheckBig },
  { id: "personalization", label: "Personalization", detail: "Profile and goals", icon: UserCircle },
  { id: "mcp", label: "MCP Servers", detail: "Tools & data connectors", icon: Network },
  { id: "advanced", label: "Advanced", detail: "Local maintenance", icon: Wrench },
] as const;

type ChapterId = (typeof CHAPTERS)[number]["id"];

function SettingsPageShell({ children, description, title }: { children: ReactNode; description: string; title: string }) {
  return (
    <article aria-labelledby={`settings-${title.toLowerCase().replace(/\s+/g, "-")}`} className="morrow-settings-page">
      <header className="morrow-settings-head">
        <h2 id={`settings-${title.toLowerCase().replace(/\s+/g, "-")}`}>{title}</h2>
        <p>{description}</p>
      </header>
      {children}
    </article>
  );
}

function SettingRow({ children, description, title }: { children: ReactNode; description: string; title: string }) {
  return (
    <div className="morrow-setting-row">
      <div>
        <b>{title}</b>
        <p>{description}</p>
      </div>
      <div className="morrow-setting-row__control">{children}</div>
    </div>
  );
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <label className="morrow-switch" title={label}>
      <input aria-label={label} checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
      <span aria-hidden="true" className="morrow-switch__thumb" />
    </label>
  );
}

function AssistantProfileSection() {
  const queryClient = useQueryClient();
  const profile = useQuery(assistantProfileQueries.get());
  const [goalText, setGoalText] = useState("");
  const update = useMutation({
    mutationFn: assistantProfileApi.update,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["assistant-profile"] }),
  });
  const addGoal = useMutation({
    mutationFn: (text: string) => assistantProfileApi.addGoal(text),
    onSuccess: () => {
      setGoalText("");
      void queryClient.invalidateQueries({ queryKey: ["assistant-profile"] });
    },
  });
  const toggleGoal = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => assistantProfileApi.setGoalEnabled(id, enabled),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["assistant-profile"] }),
  });

  function submitGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (goalText.trim()) addGoal.mutate(goalText.trim());
  }

  if (profile.isPending) return <p aria-live="polite" className="morrow-settings-status" role="status">Loading your assistant profile…</p>;
  if (profile.isError || !profile.data) return <p className="morrow-settings-status" role="alert">Your assistant profile could not be loaded.</p>;
  const data = profile.data;

  return (
    <SettingsPageShell
      description="Shape the assistant that follows you across local projects. Suggestions still require your approval in Memory."
      title="Personalization"
    >
      <p className="morrow-settings-label">Identity</p>
      <SettingRow description="Used in greetings and handoffs across this installation." title="Your display name">
        <input defaultValue={data.displayName ?? ""} onBlur={(event) => update.mutate({ displayName: event.target.value || null })} />
      </SettingRow>
      <SettingRow description="Optional. Leave blank to keep the product name." title="Assistant name">
        <input defaultValue={data.assistantName ?? ""} onBlur={(event) => update.mutate({ assistantName: event.target.value || null })} placeholder="Morrow" />
      </SettingRow>
      <p className="morrow-settings-label">Conversation</p>
      <SettingRow description="How much detail Morrow should use by default." title="Communication style">
        <select onChange={(event) => update.mutate({ commsVerbosity: event.target.value as "concise" | "detailed" })} value={data.commsVerbosity}>
          <option value="concise">Concise</option>
          <option value="detailed">Detailed</option>
        </select>
      </SettingRow>
      <SettingRow description="Choose plain language or a more technical register." title="Technical level">
        <select onChange={(event) => update.mutate({ commsTone: event.target.value as "technical" | "nontechnical" })} value={data.commsTone}>
          <option value="nontechnical">Plain language</option>
          <option value="technical">Technical</option>
        </select>
      </SettingRow>
      <p className="morrow-settings-label">Goals</p>
      <div className="morrow-setting-row morrow-setting-row--stacked">
        <div>
          <b>Assistant goals</b>
          <p>Definitions only. Adding a goal does not schedule or automate it.</p>
        </div>
        <form className="morrow-settings-goal-form" onSubmit={submitGoal}>
          <input aria-label="New goal" onChange={(event) => setGoalText(event.target.value)} placeholder="e.g. Ping me about open PRs" value={goalText} />
          <Button disabled={!goalText.trim() || addGoal.isPending} size="compact" type="submit">Add</Button>
        </form>
        {data.goals.length > 0 ? (
          <ul className="morrow-settings-goals">
            {data.goals.map((goal) => (
              <li key={goal.id}>
                <Switch checked={goal.enabled} label={`Enable goal: ${goal.text}`} onChange={(enabled) => toggleGoal.mutate({ id: goal.id, enabled })} />
                <span>{goal.text}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {update.isError || addGoal.isError ? <p className="morrow-settings-status" role="alert">{safeError(update.error ?? addGoal.error, "That change could not be saved.")}</p> : null}
    </SettingsPageShell>
  );
}

function AssistantPrivacySection({ clearedMessage, clearDrafts }: { clearedMessage: string | null; clearDrafts: () => void }) {
  const queryClient = useQueryClient();
  const profile = useQuery(assistantProfileQueries.get());
  const update = useMutation({
    mutationFn: assistantProfileApi.update,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["assistant-profile"] }),
  });

  return (
    <SettingsPageShell description="Understand what stays local and make provider choices visible before sensitive work leaves this machine." title="Privacy">
      <div className="morrow-settings-assurance">
        <span aria-hidden="true" className="morrow-settings-assurance__shield"><LockKeyhole size={18} /></span>
        <div>
          <b>Local-first by design</b>
          <span>Your project files, Morrow database, and chat history stay on this machine.</span>
        </div>
      </div>
      <p className="morrow-settings-label">Provider preference</p>
      <div className="morrow-settings-disclosure">
        <b>Saved preference, not an enforcement boundary</b>
        <p>This is a saved preference for future routing controls. It does not enforce provider or tool routing today. Choose the provider for each task and review the visible model selection before sending sensitive context.</p>
      </div>
      {profile.isPending ? <p aria-live="polite" className="morrow-settings-status" role="status">Loading provider preference…</p> : null}
      {profile.data ? (
        <div aria-label="Provider privacy preference" className="morrow-settings-radio-list" role="radiogroup">
          {Object.entries(PRIVACY_MODE_COPY).map(([mode, copy]) => (
            <label className="morrow-settings-radio" key={mode}>
              <input
                checked={profile.data.defaultPrivacyMode === mode}
                name="default-privacy-mode"
                onChange={() => update.mutate({ defaultPrivacyMode: mode as keyof typeof PRIVACY_MODE_COPY })}
                type="radio"
              />
              <span><b>{copy.label}</b><small>{copy.hint}</small></span>
            </label>
          ))}
        </div>
      ) : null}
      <p className="morrow-settings-label">Local data</p>
      <SettingRow description="Remove unsent text cached by the chat composer. Saved conversations are unaffected." title="Unsent drafts">
        <Button onClick={clearDrafts} size="compact" variant="secondary"><Trash2 size={14} />Clear drafts</Button>
      </SettingRow>
      {clearedMessage ? <p aria-live="polite" className="morrow-settings-saved"><Check size={14} />{clearedMessage}</p> : null}
    </SettingsPageShell>
  );
}

export function SettingsPage() {
  const { preference, resolvedTheme, setTheme } = useTheme();
  const { settings, updateSettings } = useUserSettings();
  const [chapter, setChapter] = useState<ChapterId>("privacy");
  const [clearedMessage, setClearedMessage] = useState<string | null>(null);

  function clearDrafts() {
    let count = 0;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && (key.startsWith("morrow.draft.") || key.startsWith("morrow.chat.draft."))) {
        localStorage.removeItem(key);
        count++;
      }
    }
    setClearedMessage(`Cleared ${count} draft${count === 1 ? "" : "s"} from local cache.`);
    setTimeout(() => setClearedMessage(null), 4000);
  }

  return (
    <section aria-labelledby="settings-heading" className="morrow-page morrow-settings">
      <ProductHeader description="A quiet control room for how Morrow looks, reasons, remembers, and asks permission." eyebrow="Preferences & configuration" headingId="settings-heading" title="Settings" />
      <div className="morrow-settings-layout">
        <nav aria-label="Settings chapters" className="morrow-settings-book">
          {CHAPTERS.map((item) => {
            const Icon = item.icon;
            return (
              <button aria-current={chapter === item.id ? "true" : undefined} className="morrow-settings-chapter" key={item.id} onClick={() => setChapter(item.id)} type="button">
                <span aria-hidden="true" className="morrow-settings-chapter__icon"><Icon size={14} /></span>
                <span><b>{item.label}</b><small>{item.detail}</small></span>
              </button>
            );
          })}
        </nav>

        {chapter === "appearance" ? (
          <SettingsPageShell description="Keep the same restrained visual rhythm across every part of Morrow." title="Appearance">
            <p className="morrow-settings-label">Theme</p>
            <SettingRow description={preference === "system" ? `Following your device — currently ${resolvedTheme}.` : `Using the ${preference} theme on every page.`} title="Color theme">
              <div aria-label="Theme" className="morrow-theme-choice" role="group">
                {THEME_OPTIONS.map((option) => <button aria-pressed={preference === option.value} className="morrow-theme-choice__option" key={option.value} onClick={() => setTheme(option.value)} title={option.hint} type="button">{option.label}</button>)}
              </div>
            </SettingRow>
            <p className="morrow-settings-label">Layout</p>
            <SettingRow description="Comfortable gives content more room; compact keeps dense work visible." title="Interface density">
              <select aria-label="UI layout density" onChange={(event) => updateSettings({ density: event.target.value as "comfortable" | "compact" })} value={settings.density}>
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
            </SettingRow>
          </SettingsPageShell>
        ) : null}

        {chapter === "model" ? (
          <SettingsPageShell description="Defaults for new conversations. Each composer still shows the active choices before send." title="Model behavior">
            <p className="morrow-settings-label">New conversations</p>
            <SettingRow description="Initial working mode when a chat begins." title="Default chat mode">
              <select aria-label="Default chat mode" onChange={(event) => updateSettings({ defaultMode: event.target.value as "chat" | "build" })} value={settings.defaultMode}>
                <option value="build">Build — trusted workspace</option><option value="chat">Chat — read only</option>
              </select>
            </SettingRow>
            <SettingRow description="Default effort for models that support configurable thinking." title="Default reasoning depth">
              <select aria-label="Default reasoning depth" onChange={(event) => updateSettings({ defaultReasoning: event.target.value as typeof settings.defaultReasoning })} value={settings.defaultReasoning}>
                <option value="auto">Auto</option><option value="off">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">xHigh</option>
              </select>
            </SettingRow>
            <SettingRow description="Follow new output as a response streams." title="Auto-scroll">
              <Switch checked={settings.autoscroll} label="Auto-scroll to bottom during message streaming" onChange={(autoscroll) => updateSettings({ autoscroll })} />
            </SettingRow>
          </SettingsPageShell>
        ) : null}

        {chapter === "privacy" ? <AssistantPrivacySection clearedMessage={clearedMessage} clearDrafts={clearDrafts} /> : null}

        {chapter === "approvals" ? (
          <SettingsPageShell description="Morrow keeps consequential actions visible at the moment they matter." title="Approvals">
            <div className="morrow-settings-assurance"><span aria-hidden="true" className="morrow-settings-assurance__shield"><CircleCheckBig size={18} /></span><div><b>Approvals stay attached to the task</b><span>The composer shows the active workspace posture before a message is sent.</span></div></div>
            <p className="morrow-settings-label">Current boundary</p>
            <SettingRow description="Use Chat for read-only work, or Build to expose workspace-change controls in the composer." title="Choose per conversation"><span className="morrow-settings-value">Visible in chat</span></SettingRow>
            <SettingRow description="Trusted workspace can reduce prompts for ordinary local commands. Sensitive boundaries still remain explicit." title="Workspace trust"><span className="morrow-settings-value">Task scoped</span></SettingRow>
          </SettingsPageShell>
        ) : null}

        {chapter === "personalization" ? <AssistantProfileSection /> : null}

        {chapter === "mcp" ? <McpSettingsSection /> : null}

        {chapter === "advanced" ? (
          <SettingsPageShell description="Small maintenance actions for this local installation." title="Advanced">
            <p className="morrow-settings-label">Local cache</p>
            <SettingRow description="Remove unsent composer drafts without touching saved conversations or memory." title="Clear unsent drafts">
              <Button onClick={clearDrafts} size="compact" variant="secondary"><Trash2 size={14} />Clear drafts</Button>
            </SettingRow>
            {clearedMessage ? <p aria-live="polite" className="morrow-settings-saved"><Check size={14} />{clearedMessage}</p> : null}
          </SettingsPageShell>
        ) : null}
      </div>
      <p className="morrow-premium-principle"><span>Quiet defaults</span><i />Every consequential choice stays visible before it takes effect.</p>
    </section>
  );
}
