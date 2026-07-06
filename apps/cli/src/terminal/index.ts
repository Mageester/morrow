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
  type RoutingInfo,
  type SessionStatus,
} from "./state.js";
export {
  headerLines,
  toolCardLines,
  activityLine,
  activityGroupLine,
  groupActivities,
  type ActivityGroup,
  patchLines,
  completionLines,
  composeFrame,
  statusBar,
  statusBarFields,
  clipToWidth,
  formatElapsed,
  glyphs,
  relativePath,
  stageBanner,
  type FrameOptions,
  type Glyphs,
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
