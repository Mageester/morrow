/**
 * The terminal runtime: a single event-driven pipeline that owns all visible
 * output —
 *
 *   producers → TerminalEvent → reduce() → TerminalState → views → Renderer
 *
 * See docs/decisions/0003-terminal-runtime.md for the renderer decision.
 */
export type { TerminalEvent, TerminalEventType, ActivityKind, ApprovalSource, SessionMeta } from "./events.js";
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
  patchLines,
  completionLines,
  composeFrame,
  clipToWidth,
  formatElapsed,
  glyphs,
  type FrameOptions,
  type Glyphs,
} from "./view.js";
export type { Renderer } from "./renderer.js";
export { LineRenderer, type LineRendererOptions } from "./line-renderer.js";
export { InteractiveRenderer, nodeTermIO, type TermIO, type InteractiveOptions } from "./runtime.js";
export { mapTaskEvent, type RawTaskEvent } from "./task-event-adapter.js";
export { shouldUseInteractive, resolveUnicodeFlag, type CapabilityInput } from "./capabilities.js";
