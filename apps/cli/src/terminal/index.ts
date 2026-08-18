/**
 * The terminal runtime's public surface.
 *
 * Producers emit `TerminalEvent`s, `reduce` folds them into `TerminalState`,
 * and a surface renders that state. Nothing may reach the screen except through
 * an event — that rule is what let the renderer be replaced wholesale without
 * touching a single producer.
 *
 * See docs/decisions/0003-terminal-runtime.md.
 */
export type {
  TerminalEvent,
  TerminalEventType,
  ActivityKind,
  ApprovalSource,
  SessionMeta,
  GitStateInfo,
  ContextUsageInfo,
  UsageInfo,
  ProcessInfo,
  WorktreeInfo,
  AgentInfo,
  IntegrationInfo,
  ProgressStage,
} from "./events.js";
export {
  reduce,
  initialState,
  type TerminalState,
  type ToolCard,
  type ConversationEntry,
  type ActivityEntry,
  type PatchEntry,
  type RecoveryEntry,
  type RoutingInfo,
  type SessionStatus,
} from "./state.js";

// ── Structured command output ───────────────────────────────────────────────
export { report, reportToLines, ReportBuilder, type Report, type ReportBlock, type Tone } from "./report.js";

// ── The command surface ─────────────────────────────────────────────────────
export {
  BUILTIN_COMMANDS,
  builtinRegistry,
  skillCommands,
  CommandRegistry,
  parseCommandLine,
  tokenize,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type Command,
  type CommandArgs,
  type CommandContext,
  type CommandResult,
  type CommandCategory,
  type SessionInfo,
} from "./commands/index.js";
export { createLineSurface } from "./commands/line-surface.js";

// ── The backend contract ────────────────────────────────────────────────────
export type { SendOptions, SessionBackend, SessionRouting, ApprovalView } from "./session-types.js";

// ── Views still shared with the non-interactive surfaces ────────────────────
export {
  headerLines,
  statsLines,
  toolCardLines,
  patchLines,
  actionLine,
  runningActionLine,
  recoveryEntryLines,
  completionCard,
  currentActionLabel,
  composeFrame,
  statusBar,
  clipToWidth,
  formatElapsed,
  glyphs,
  relativePath,
  stageBanner,
  stageLabel,
  type FrameOptions,
  type Glyphs,
  type StatsOptions,
  type CompletionCardOptions,
} from "./view.js";
export type { Renderer } from "./renderer.js";
export { LineRenderer, type LineRendererOptions } from "./line-renderer.js";
export { mapTaskEvent, type RawTaskEvent } from "./task-event-adapter.js";
export { shouldUseInteractive, resolveUnicodeFlag, type CapabilityInput } from "./capabilities.js";
export { readLineWithCompletion, PROMPT_EXIT, type PromptOptions } from "./prompt.js";
export { clampSelection } from "./select.js";
export {
  buildModelPickerItems,
  filterModelItems,
  renderModelPicker,
  modelDetailLines,
  modelPickerDetail,
  itemReasoning,
  modelPickerLines,
  modelFactsLine,
  formatContextWindow,
  type ModelPickerItem,
  type ModelPickerViewOptions,
  type ModelSelection,
} from "./model-picker.js";
export {
  reasoningOptions,
  renderReasoningPicker,
  reasoningStatusText,
  describeReasoningControl,
  isReasoningCompatible,
  normalizeReasoningForRoute,
  formatBudget,
  UNKNOWN_REASONING,
  type ReasoningOption,
} from "./reasoning.js";
export { approvalDecisionForKey, approvalDecisionLabel, approvalActionsLine, type ApprovalDecision, type ApprovalKey } from "./approvals.js";
export { PasteDecoder, normalizePaste, PASTE_START, PASTE_END, type PasteResult } from "./paste.js";
export { resumeDigestLines, resumeNoticeText, resumeNoticeLines, resumeHasWarnings, type ResumeDigest, type ResumeGitState, type ResumeStaleness } from "./resume.js";
export { interpretError, formatInterpretedError, type InterpretedError } from "./errors.js";

// ── The interactive shell ───────────────────────────────────────────────────
export { startShell, type ShellOptions, type ShellHandle } from "./ink/shell.js";
export {
  applyKey,
  initialEditorState,
  insertPaste,
  layout,
  remember,
  clearText,
  expandPastes,
  type EditorState,
  type EditorAction,
  type KeyPress,
} from "./ink/editor.js";
export { KEY_BINDINGS, type KeyBinding } from "./ink/keymap.js";
