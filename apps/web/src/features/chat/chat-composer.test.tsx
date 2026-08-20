import { fireEvent, render as baseRender, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatComposer,
  type ChatComposerSubmission,
} from "./chat-composer.js";
import { loadChatDraft, saveChatDraft } from "./draft-store.js";

// The composer embeds the context meter, which reads task usage through React
// Query. Every case here renders the composer directly, so the provider is
// supplied once at the render boundary rather than threaded through ~18 call
// sites. rerender() is wrapped too, or a rerender would drop the provider.
function render(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (node: ReactNode) => <QueryClientProvider client={client}>{node}</QueryClientProvider>;
  const result = baseRender(wrap(ui));
  return { ...result, rerender: (next: ReactNode) => result.rerender(wrap(next)) };
}

const scope = { projectId: "project-1", conversationId: "conversation-1" };
const projects = [
  { id: "project-1", name: "Morrow" },
  { id: "project-2", name: "Personal" },
];
const routes = [
  { id: "balanced", label: "Balanced route", preset: "balanced" as const },
  {
    id: "openrouter:model-a",
    label: "Model A via OpenRouter",
    providerId: "openrouter" as const,
    model: "vendor/model-a",
  },
];

beforeEach(() => localStorage.clear());

/**
 * Secondary controls now live behind the composer's two popovers. The controls
 * themselves are unchanged — these helpers just open the surface they moved to,
 * so every assertion below still covers the same behaviour.
 */
async function openThinking(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^Thinking · / }));
}

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Workspace and message settings" }));
}

describe("ChatComposer", () => {
  it("defaults a fresh install to Build with a trusted workspace", async () => {
    const user = userEvent.setup();
    render(<ChatComposer draftScope={scope} onSubmit={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Build" })).toHaveAttribute("aria-pressed", "true");
    await openSettings(user);
    expect(screen.getByRole("checkbox", { name: "Trusted workspace" })).toBeChecked();
    expect(screen.getByText("Ordinary workspace actions can continue without stopping; other actions still ask.")).toBeVisible();
  });

  it("keeps the controlled reasoning toggle available while a task is running", async () => {
    const user = userEvent.setup();
    function Parent() {
      const [showReasoning, setShowReasoning] = useState(false);
      return (
        <ChatComposer
          activeTaskId="task-1"
          draftScope={scope}
          onShowReasoningChange={setShowReasoning}
          onSubmit={vi.fn()}
          showReasoning={showReasoning}
        />
      );
    }
    render(<Parent />);

    await openThinking(user);
    const toggle = screen.getByRole("checkbox", { name: "Show thinking" });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    await user.click(toggle);
    expect(toggle).toBeChecked();
  });

  it("supports native fast typing, editing, selection, clipboard-shaped input, and stable parent rerenders", async () => {
    const user = userEvent.setup();
    let rerenderParent!: () => void;
    function Parent() {
      const [, setTick] = useState(0);
      rerenderParent = () => setTick((value) => value + 1);
      return <ChatComposer autoFocus draftScope={scope} onSubmit={vi.fn()} />;
    }
    render(<Parent />);

    const textbox = screen.getByRole("textbox", { name: "Message Morrow" }) as HTMLTextAreaElement;
    await waitFor(() => expect(textbox).toHaveFocus());
    await user.type(textbox, "Fast https://example.test `code()` 😀");
    textbox.setSelectionRange(5, 25, "forward");
    const sameNode = textbox;
    rerenderParent();

    expect(screen.getByRole("textbox", { name: "Message Morrow" })).toBe(sameNode);
    expect(textbox.selectionStart).toBe(5);
    expect(textbox.selectionEnd).toBe(25);

    fireEvent.input(textbox, { target: { value: "line one\nline two\n貼り付け 😀" } });
    expect(textbox).toHaveValue("line one\nline two\n貼り付け 😀");
    expect(loadChatDraft(scope)).toBe("line one\nline two\n貼り付け 😀");
  });

  it("does not submit Enter during composition and uses Shift+Enter as a newline", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue({ accepted: true });
    render(<ChatComposer draftScope={scope} onSubmit={onSubmit} />);
    const textbox = screen.getByRole("textbox", { name: "Message Morrow" });

    await user.type(textbox, "こんにちは");
    fireEvent.compositionStart(textbox);
    fireEvent.keyDown(textbox, { key: "Enter", isComposing: true });
    fireEvent.compositionEnd(textbox);
    expect(onSubmit).not.toHaveBeenCalled();

    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(textbox).toHaveValue("こんにちは\n");
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit a compatibility Enter with keyCode 229 after compositionend", () => {
    const onSubmit = vi.fn().mockResolvedValue({ accepted: true });
    render(<ChatComposer draftScope={scope} onSubmit={onSubmit} />);
    const textbox = screen.getByRole("textbox", { name: "Message Morrow" });
    fireEvent.input(textbox, { target: { value: "変換中" } });
    fireEvent.compositionStart(textbox);
    fireEvent.compositionEnd(textbox);
    fireEvent.keyDown(textbox, { key: "Enter", keyCode: 229, which: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("leaves native editing, selection, clipboard, undo, and redo shortcuts untouched", () => {
    render(<ChatComposer draftScope={scope} onSubmit={vi.fn()} />);
    const textbox = screen.getByRole("textbox", { name: "Message Morrow" });

    for (const key of ["Backspace", "ArrowLeft", "ArrowRight", "Home", "End"]) {
      expect(fireEvent.keyDown(textbox, { key })).toBe(true);
    }
    for (const key of ["a", "c", "x", "v", "z", "y"]) {
      expect(fireEvent.keyDown(textbox, { ctrlKey: true, key })).toBe(true);
    }
    expect(fireEvent.paste(textbox)).toBe(true);
  });

  it("keeps send disabled for whitespace-only text", () => {
    render(<ChatComposer draftScope={scope} onSubmit={vi.fn()} />);
    const textbox = screen.getByRole("textbox", { name: "Message Morrow" });
    fireEvent.input(textbox, { target: { value: "  \n  " } });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("keeps the primary send action after the scrollable secondary controls", () => {
    const { container } = render(<ChatComposer draftScope={scope} onSubmit={vi.fn()} />);

    const toolbar = container.querySelector(".morrow-chat-composer__toolbar");
    expect(toolbar).not.toBeNull();
    expect(toolbar?.lastElementChild).toHaveClass("morrow-chat-composer__send");
  });

  it("keeps the toolbar action lane explicit for contained desktop layouts", () => {
    const { container } = render(<ChatComposer draftScope={scope} onSubmit={vi.fn()} />);
    const toolbar = container.querySelector(".morrow-chat-composer__toolbar");
    const send = container.querySelector(".morrow-chat-composer__send");
    expect(toolbar).toBeInTheDocument();
    expect(send).toBeInTheDocument();
    expect(send?.parentElement).toBe(toolbar);
  });

  it("never focuses a disabled textarea and focuses it only after re-enable", async () => {
    const { rerender } = render(
      <ChatComposer autoFocus disabled draftScope={scope} onSubmit={vi.fn()} />,
    );
    const textbox = screen.getByRole("textbox", { name: "Message Morrow" });
    expect(textbox).toBeDisabled();
    expect(textbox).not.toHaveFocus();

    rerender(<ChatComposer autoFocus draftScope={scope} onSubmit={vi.fn()} />);
    await waitFor(() => expect(textbox).toHaveFocus());
  });

  it("maps modes and real route/project selections into the submission callback", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue({ accepted: false });
    const onProjectChange = vi.fn();
    render(
      <ChatComposer
        draftScope={scope}
        modelRoutes={routes}
        onProjectChange={onProjectChange}
        onSubmit={onSubmit}
        projectId="project-1"
        projects={projects}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Model route"), "openrouter:model-a");
    await user.selectOptions(screen.getByLabelText("Project"), "project-2");
    expect(onProjectChange).toHaveBeenCalledWith("project-2");
    await user.type(screen.getByRole("textbox", { name: "Message Morrow" }), "Ship it");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSubmit).toHaveBeenCalledWith({
      autoApprove: true,
      content: "Ship it",
      conversationId: "conversation-1",
      mode: "agent",
      model: "vendor/model-a",
      projectId: "project-1",
      providerId: "openrouter",
    } satisfies ChatComposerSubmission);
  });

  it("animates a capability-aware reasoning slider and submits its normalized selection", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue({ accepted: true });
    const onReasoningConfigChange = vi.fn();
    const deepSeekRoute = {
      id: "deepseek:v4-pro",
      label: "DeepSeek V4 Pro",
      providerId: "deepseek" as const,
      model: "deepseek-v4-pro",
      reasoning: {
        control: "effort" as const,
        efforts: ["low", "high", "xhigh", "max"] as ("low" | "medium" | "high" | "xhigh" | "max")[],
        budgets: [],
        source: "provider-metadata" as const,
        supportsOff: true,
        wire: "deepseek-thinking" as const,
      },
    };
    function Parent() {
      const [reasoningConfig, setReasoningConfig] = useState<import("@morrow/contracts").ReasoningConfiguration>({ mode: "auto" });
      return (
        <ChatComposer
          draftScope={scope}
          modelRoutes={[...routes, deepSeekRoute]}
          onReasoningConfigChange={(config) => {
            onReasoningConfigChange(config);
            setReasoningConfig(config);
          }}
          onSubmit={onSubmit}
          reasoningConfig={reasoningConfig}
        />
      );
    }
    render(<Parent />);

    await user.selectOptions(screen.getByLabelText("Model route"), "deepseek:v4-pro");
    await openThinking(user);
    const slider = screen.getByRole("slider", { name: "Reasoning effort" });
    expect(slider).toHaveAttribute("aria-valuetext", "Auto");
    expect(slider).toHaveAttribute("data-value", "auto");
    expect(slider).toHaveAttribute("data-adjustable", "true");
    expect(screen.getByText("Auto", { selector: '[aria-live="polite"]' })).toBeVisible();
    fireEvent.change(slider, { target: { value: "3" } });
    expect(onReasoningConfigChange).toHaveBeenCalledWith({ mode: "effort", effort: "high" });
    expect(slider).toHaveAttribute("data-value", "high");
    expect(screen.getByText("High", { selector: '[aria-live="polite"]' })).toBeVisible();

    await user.type(screen.getByRole("textbox", { name: "Message Morrow" }), "Use DeepSeek");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      reasoning: { mode: "effort", effort: "high" },
    } satisfies Partial<ChatComposerSubmission>));
  });

  it("offers only the modes the selected exact route supports, with the provider's own labels", async () => {
    const user = userEvent.setup();
    // Two Gemini models on the same provider with genuinely different level
    // sets (verified live: 3.7 Flash rejects MINIMAL, 3.5 Flash accepts it).
    const geminiRoute = (id: string, model: string, ids: string[]) => ({
      id,
      label: model,
      providerId: "gemini" as const,
      model,
      reasoning: {
        control: "effort" as const,
        efforts: ids,
        modes: ids.map((mode) => ({ id: mode, label: `Thinking: ${mode}` })),
        budgets: [],
        source: "provider-catalog" as const,
        wire: "gemini-thinking-level" as const,
      },
    });
    const flash37 = geminiRoute("gemini:3.7-flash", "gemini-3.7-flash", ["low", "medium", "high"]);
    const flash35 = geminiRoute("gemini:3.5-flash", "gemini-3.5-flash", ["minimal", "low", "medium", "high"]);

    const onReasoningConfigChange = vi.fn();
    function Parent() {
      const [reasoningConfig, setReasoningConfig] = useState<import("@morrow/contracts").ReasoningConfiguration>({ mode: "auto" });
      return (
        <ChatComposer
          draftScope={scope}
          modelRoutes={[...routes, flash37, flash35]}
          onReasoningConfigChange={(config) => {
            onReasoningConfigChange(config);
            setReasoningConfig(config);
          }}
          onSubmit={vi.fn()}
          reasoningConfig={reasoningConfig}
        />
      );
    }
    render(<Parent />);

    await user.selectOptions(screen.getByLabelText("Model route"), "gemini:3.7-flash");
    await openThinking(user);
    const slider = screen.getByRole("slider", { name: "Reasoning effort" });
    // Auto + exactly three provider modes: "minimal" is a real Gemini level,
    // but not on this model, so it must not be offered here.
    expect(slider).toHaveAttribute("max", "3");
    fireEvent.change(slider, { target: { value: "1" } });
    expect(onReasoningConfigChange).toHaveBeenLastCalledWith({ mode: "effort", effort: "low" });
    // The provider's own label is rendered, not a title-cased id.
    expect(slider).toHaveAttribute("aria-valuetext", "Thinking: low");

    // Switching to the sibling model widens the offer to four, with no change
    // to this component: the route reports its own set.
    await user.selectOptions(screen.getByLabelText("Model route"), "gemini:3.5-flash");
    await openThinking(user);
    const wider = screen.getByRole("slider", { name: "Reasoning effort" });
    expect(wider).toHaveAttribute("max", "4");
    fireEvent.change(wider, { target: { value: "1" } });
    expect(onReasoningConfigChange).toHaveBeenLastCalledWith({ mode: "effort", effort: "minimal" });
    expect(wider).toHaveAttribute("aria-valuetext", "Thinking: minimal");
  });

  it("keeps reasoning at Auto when the route capability is unknown", async () => {
    const user = userEvent.setup();
    const unknownRoute = {
      id: "unknown:route",
      label: "Unknown route",
      providerId: "openrouter" as const,
      model: "vendor/unknown",
      reasoning: {
        control: "unknown" as const,
        efforts: [],
        budgets: [],
        source: "unknown" as const,
      },
    };

    render(<ChatComposer draftScope={scope} modelRoutes={[...routes, unknownRoute]} onReasoningConfigChange={vi.fn()} onSubmit={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText("Model route"), "unknown:route");
    await openThinking(user);

    const slider = screen.getByRole("slider", { name: "Reasoning effort" });
    expect(slider).toHaveAttribute("aria-valuetext", "Auto");
    expect(slider).toHaveAttribute("data-value", "auto");
    expect(slider).toHaveAttribute("data-adjustable", "false");
  });

  it("preserves an explicit supervised Build preference across composer remounts", async () => {
    const user = userEvent.setup();
    const first = render(<ChatComposer draftScope={scope} onSubmit={vi.fn()} />);

    await openSettings(user);
    await user.click(screen.getByRole("checkbox", { name: "Trusted workspace" }));
    first.unmount();

    render(<ChatComposer draftScope={scope} onSubmit={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Build" })).toHaveAttribute("aria-pressed", "true");
    await openSettings(user);
    expect(screen.getByRole("checkbox", { name: "Trusted workspace" })).not.toBeChecked();
    expect(screen.getByText("Morrow will ask before workspace changes and commands.")).toBeVisible();
  });

  it("preserves an explicit Chat preference across composer remounts", async () => {
    const user = userEvent.setup();
    const first = render(<ChatComposer draftScope={scope} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Chat" }));
    first.unmount();

    render(<ChatComposer draftScope={scope} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true");
    await openSettings(user);
    expect(screen.queryByRole("checkbox", { name: "Trusted workspace" })).not.toBeInTheDocument();
  });

  it("clears draft only after acceptance and blocks rapid duplicate sends", async () => {
    const user = userEvent.setup();
    let accept!: (value: { accepted: true }) => void;
    const onSubmit = vi.fn(() => new Promise<{ accepted: true }>((resolve) => { accept = resolve; }));
    render(<ChatComposer draftScope={scope} onSubmit={onSubmit} />);
    const textbox = screen.getByRole("textbox", { name: "Message Morrow" });
    await user.type(textbox, "Keep until accepted");

    fireEvent.keyDown(textbox, { key: "Enter" });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(textbox).toHaveValue("Keep until accepted");
    expect(screen.getByRole("button", { name: "Sending message" })).toBeDisabled();

    accept({ accepted: true });
    await waitFor(() => expect(textbox).toHaveValue(""));
    expect(textbox).toHaveFocus();
    expect(loadChatDraft(scope)).toBe("");
  });

  it("retains exact draft and selection on rejection or error with an actionable status", async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn()
      .mockResolvedValueOnce({ accepted: false, error: "Connect a model and try again." })
      .mockRejectedValueOnce(new Error("network detail"));
    render(<ChatComposer draftScope={scope} onSubmit={onSubmit} />);
    const textbox = screen.getByRole("textbox", { name: "Message Morrow" }) as HTMLTextAreaElement;
    await user.type(textbox, "Preserve   this exactly");
    textbox.setSelectionRange(3, 11);

    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connect a model and try again.");
    expect(textbox).toHaveValue("Preserve   this exactly");
    expect(textbox.selectionStart).toBe(3);
    expect(textbox.selectionEnd).toBe(11);
    expect(textbox).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Message was not accepted. Try again.");
    expect(textbox).toHaveValue("Preserve   this exactly");
    expect(textbox).toHaveFocus();
    expect(textbox.selectionStart).toBe(3);
    expect(textbox.selectionEnd).toBe(11);
  });

  it("restores and switches scoped drafts without replacing the textarea", async () => {
    const other = { projectId: "project-1", conversationId: "conversation-2" };
    saveChatDraft(scope, "first conversation");
    saveChatDraft(other, "second conversation");
    const { rerender } = render(<ChatComposer draftScope={scope} onSubmit={vi.fn()} />);
    const textbox = screen.getByRole("textbox", { name: "Message Morrow" });
    expect(textbox).toHaveValue("first conversation");

    rerender(<ChatComposer draftScope={other} onSubmit={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: "Message Morrow" })).toBe(textbox);
    await waitFor(() => expect(textbox).toHaveValue("second conversation"));
  });

  it("commits the new scope together with its DOM draft and resets selection safely", () => {
    const other = { projectId: "project-1", conversationId: "conversation-2" };
    saveChatDraft(scope, "first conversation");
    saveChatDraft(other, "second");
    const { rerender } = render(<ChatComposer autoFocus draftScope={scope} onSubmit={vi.fn()} />);
    const textbox = screen.getByRole("textbox", { name: "Message Morrow" }) as HTMLTextAreaElement;
    textbox.focus();
    textbox.setSelectionRange(2, 10);

    rerender(<ChatComposer autoFocus draftScope={other} onSubmit={vi.fn()} />);
    expect(textbox).toHaveValue("second");
    expect(textbox.selectionStart).toBe(6);
    expect(textbox.selectionEnd).toBe(6);

    fireEvent.input(textbox, { target: { value: "second edited" } });
    expect(loadChatDraft(scope)).toBe("first conversation");
    expect(loadChatDraft(other)).toBe("second edited");
  });

  it("owns delayed outcomes by submitted scope and never publishes them into a new scope", async () => {
    const other = { projectId: "project-2", conversationId: "conversation-2" };
    saveChatDraft(other, "other draft");
    let resolve!: (value: { accepted: boolean; error?: string }) => void;
    const onSubmit = vi.fn(() => new Promise<{ accepted: boolean; error?: string }>((done) => { resolve = done; }));
    const { rerender } = render(<ChatComposer draftScope={scope} onSubmit={onSubmit} />);
    const textbox = screen.getByRole("textbox", { name: "Message Morrow" }) as HTMLTextAreaElement;
    fireEvent.input(textbox, { target: { value: "submitted draft" } });
    fireEvent.keyDown(textbox, { key: "Enter" });

    rerender(<ChatComposer autoFocus draftScope={other} onSubmit={onSubmit} />);
    expect(textbox).toHaveValue("other draft");
    textbox.setSelectionRange(1, 3);
    resolve({ accepted: true });

    await waitFor(() => expect(loadChatDraft(scope)).toBe(""));
    expect(loadChatDraft(other)).toBe("other draft");
    expect(textbox).toHaveValue("other draft");
    expect(textbox.selectionStart).toBe(1);
    expect(textbox.selectionEnd).toBe(3);
    expect(screen.queryByText("Message accepted.")).not.toBeInTheDocument();
  });

  it("hides late rejection from the new scope while retaining the submitted draft", async () => {
    const other = { projectId: "project-2" };
    saveChatDraft(other, "new scope");
    let reject!: (error: Error) => void;
    const onSubmit = vi.fn(() => new Promise<{ accepted: boolean }>((_resolve, fail) => { reject = fail; }));
    const { rerender } = render(<ChatComposer draftScope={scope} onSubmit={onSubmit} />);
    const textbox = screen.getByRole("textbox", { name: "Message Morrow" });
    fireEvent.input(textbox, { target: { value: "retry me" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    rerender(<ChatComposer draftScope={other} onSubmit={onSubmit} />);
    reject(new Error("offline"));

    await waitFor(() => expect(textbox).not.toBeDisabled());
    expect(loadChatDraft(scope)).toBe("retry me");
    expect(textbox).toHaveValue("new scope");
    expect(screen.queryByText("Message was not accepted. Try again.")).not.toBeInTheDocument();
  });

  it("shows the 32,000-character boundary without truncating over-limit input", () => {
    render(<ChatComposer draftScope={scope} onSubmit={vi.fn()} />);
    const textbox = screen.getByRole("textbox", { name: "Message Morrow" });
    fireEvent.input(textbox, { target: { value: "x".repeat(32_001) } });

    expect(textbox).toHaveValue("x".repeat(32_001));
    expect(textbox).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("32,001 / 32,000 characters")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("1 character over the limit");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("autosizes to a cap and then enables internal scrolling", () => {
    render(<ChatComposer draftScope={scope} onSubmit={vi.fn()} />);
    const textbox = screen.getByRole("textbox", { name: "Message Morrow" }) as HTMLTextAreaElement;
    Object.defineProperty(textbox, "scrollHeight", { configurable: true, value: 420 });
    fireEvent.input(textbox, { target: { value: "many\nlines" } });
    expect(textbox.style.height).toBe("192px");
    expect(textbox.style.overflowY).toBe("auto");
  });

  it("only shows stop and attachment affordances when they are actionable", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<ChatComposer draftScope={scope} onSubmit={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Stop generation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /attach/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Attachments are unavailable/)).toBeVisible();

    rerender(
      <ChatComposer
        activeTaskId="task-1"
        draftScope={scope}
        onStop={onStop}
        onSubmit={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Stop generation" }));
    expect(onStop).toHaveBeenCalledWith("task-1");
  });

  it("blocks every submit path while a task is active and leaves only Stop actionable", () => {
    const onSubmit = vi.fn().mockResolvedValue({ accepted: true });
    const onStop = vi.fn().mockResolvedValue(undefined);
    render(
      <ChatComposer
        activeTaskId="task-1"
        draftScope={scope}
        onStop={onStop}
        onSubmit={onSubmit}
      />,
    );
    const textbox = screen.getByRole("textbox", { name: "Message Morrow" });
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    fireEvent.keyDown(textbox, { key: "Enter" });
    fireEvent.submit(textbox.closest("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop generation" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Chat" })).toBeDisabled();
    expect(screen.getByLabelText("Model route")).toBeDisabled();
  });

  it("allows typing and queueing a message while a task is active", async () => {
    const user = userEvent.setup();
    const onQueueMessage = vi.fn();
    const onSubmit = vi.fn();
    render(
      <ChatComposer
        activeTaskId="task-1"
        draftScope={scope}
        onQueueMessage={onQueueMessage}
        onSubmit={onSubmit}
      />,
    );
    const textbox = screen.getByRole("textbox", { name: "Message Morrow" });
    expect(textbox).toBeEnabled();
    await user.type(textbox, "Queue this follow-up message");
    const queueBtn = screen.getByRole("button", { name: "Queue message" });
    expect(queueBtn).toBeEnabled();
    await user.click(queueBtn);
    expect(onQueueMessage).toHaveBeenCalledTimes(1);
    expect(onQueueMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "Queue this follow-up message" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps CapabilityStatus enabled and inspectable during task execution", () => {
    render(
      <ChatComposer
        activeTaskId="task-1"
        contextTaskId="task-1"
        draftScope={scope}
        onSubmit={vi.fn()}
      />,
    );
    const capabilityBtn = screen.getByTitle("Capability & context status");
    expect(capabilityBtn).toBeEnabled();
  });
});

/**
 * Regression: a model chosen inside a conversation used to live only in
 * component state, so any remount — navigating away and back, a reload, a task
 * finishing — silently reverted the picker to "Auto — recommended" or to a
 * stale route. The choice is now durable per conversation.
 */
describe("ChatComposer model selection persistence", () => {
  const catalogue = {
    models: [{
      model: {
        version: 1 as const,
        id: "vendor/model-a",
        canonicalId: "vendor/model-a",
        aliases: [],
        providerId: "openrouter" as const,
        label: "Model A",
        contextWindow: 128_000,
        maxOutputTokens: null,
        pricing: null,
        tokenUsage: false,
        streamingUsage: false,
        capabilities: { streaming: true, toolCalls: true, vision: false },
        speedClass: "balanced" as const,
        costClass: "medium" as const,
        privacy: "remote" as const,
        builtIn: true,
      },
      available: true,
      availabilityReason: null,
    }],
    presets: [],
  };

  it("keeps the chosen model across a remount and offers it again", async () => {
    const user = userEvent.setup();
    const view = render(<ChatComposer draftScope={scope} modelCatalogue={catalogue} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Auto — recommended/ }));
    await user.click(await screen.findByRole("button", { name: /Model A/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Model A/ })).toBeVisible());

    view.unmount();
    render(<ChatComposer draftScope={scope} modelCatalogue={catalogue} onSubmit={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Model A/ })).toBeVisible();
  });

  it("forgets the choice only when the reader picks Auto again", async () => {
    const user = userEvent.setup();
    const view = render(<ChatComposer draftScope={scope} modelCatalogue={catalogue} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Auto — recommended/ }));
    await user.click(await screen.findByRole("button", { name: /Model A/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Model A/ })).toBeVisible());

    await user.click(screen.getByRole("button", { name: /Model A/ }));
    await user.click(await screen.findByRole("button", { name: /Auto — recommended/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Auto — recommended/ })).toBeVisible());

    view.unmount();
    render(<ChatComposer draftScope={scope} modelCatalogue={catalogue} onSubmit={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Auto — recommended/ })).toBeVisible();
  });
});
