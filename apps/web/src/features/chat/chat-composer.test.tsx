import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatComposer,
  type ChatComposerSubmission,
} from "./chat-composer.js";
import { loadChatDraft, saveChatDraft } from "./draft-store.js";

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

describe("ChatComposer", () => {
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

    await user.click(screen.getByRole("button", { name: "Build Auto" }));
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
    expect(textbox).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    fireEvent.keyDown(textbox, { key: "Enter" });
    fireEvent.submit(textbox.closest("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop generation" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
    expect(screen.getByLabelText("Model route")).toBeDisabled();
  });
});
