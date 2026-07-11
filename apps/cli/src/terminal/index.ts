/**
 * The terminal runtime: a single event-driven pipeline that owns all visible
 * output —
 *
 *   producers → TerminalEvent → reduce() → TerminalState → views → Renderer
 *
 * See docs/decisions/0003-terminal-runtime.md for the renderer decision.
 */
export type { TerminalEvent, TerminalEventType, ActivityKind, ApprovalSource, SessionMeta, GitStateInfo, ContextUsageInfo, ProcessInfo, WorktreeInfo, AgentInfo, IntegrationInfo, ProgressStage } from "./events.js";
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
export {
  headerLines,
  statsLines,
  toolCardLines,
  activityLine,
  activityGroupLine,
  groupActivities,
  type ActivityGroup,
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
  type FrameOptions,
  type Glyphs,
  type StatsOptions,
  type CompletionCardOptions,
} from "./view.js";
export type { Renderer } from "./renderer.js";
export { LineRenderer, type LineRendererOptions } from "./line-renderer.js";
export { InteractiveRenderer, nodeTermIO, type TermIO, type InteractiveOptions } from "./runtime.js";
export { mapTaskEvent, type RawTaskEvent } from "./task-event-adapter.js";
export { shouldUseInteractive, resolveUnicodeFlag, type CapabilityInput } from "./capabilities.js";
export { SLASH_COMMANDS, type SlashCommand } from "./commands.js";
export { filterCommands, matchScore, renderMenu, clampSelection } from "./completion.js";
export { readLineWithCompletion, PROMPT_EXIT, type PromptOptions } from "./prompt.js";
export { composeApp, welcomeLines, type AppFrame, type AppFrameOptions, type AppFrameContext } from "./app-view.js";
export { modelPickerLines, modelFactsLine, formatContextWindow, type ModelSelection } from "./model-picker.js";
export { approvalDecisionForKey, approvalDecisionLabel, approvalActionsLine, type ApprovalDecision, type ApprovalKey } from "./approvals.js";
export { activityDetailLines, activityGroupSummary, agentDetailLine } from "./activity-view.js";
export { stageLabel } from "./view.js";
export { PasteDecoder, normalizePaste, PASTE_START, PASTE_END, type PasteResult } from "./paste.js";
export { insertPaste } from "./input-state.js";
export { resumeDigestLines, resumeNoticeText, resumeNoticeLines, resumeHasWarnings, type ResumeDigest, type ResumeGitState, type ResumeStaleness } from "./resume.js";
export { interpretError, formatInterpretedError, type InterpretedError } from "./errors.js";
