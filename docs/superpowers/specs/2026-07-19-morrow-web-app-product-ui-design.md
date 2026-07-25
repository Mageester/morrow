# Morrow Web App Product and UI Design

**Date:** 2026-07-19  
**Status:** Approved product direction; implementation not started  
**Target:** `morrowproject.getaxiom.ca/app`  
**Repository:** `Mageester/morrow`

## 1. Product definition

Morrow is not a coding-only agent. It is a general autonomous agent for completing complex digital work across software, research, browsers, documents, data, communication, scheduling, business operations, personal work, and team collaboration.

The web application must make that power feel simpler, calmer, and more dependable than competing agent products. The user should interact with one clear identity—**Morrow**—while Morrow may assemble specialized agents, tools, models, local runtimes, and cloud services behind the scenes.

### Core promise

> Morrow is the simplest way to delegate complicated digital work and trust that it will actually get finished.

### Product position

Morrow combines:

- the approachability of a polished consumer AI product;
- the durability and auditability of a professional work system;
- the flexibility of a provider-neutral autonomous agent;
- the privacy and control of a local-first runtime;
- the collaboration model required by individuals and teams.

The web app is not a chat wrapper, a developer dashboard, or a collection of disconnected tools. It is the primary interface for creating, monitoring, steering, reviewing, and sharing missions.

## 2. Goals

The first production-quality web application must:

1. Let a user begin any kind of mission from one universal composer.
2. Make active work understandable at a glance without exposing orchestration noise.
3. Reveal advanced detail only when it is relevant or deliberately requested.
4. Support both personal and shared team workspaces through the same interface.
5. Present Morrow as one central agent while allowing specialists to become visible inside complex missions.
6. Stream durable mission state, activity, approvals, artifacts, blockers, and results from the existing orchestrator.
7. Survive refreshes, temporary disconnections, runtime restarts, and partial synchronization without losing user trust.
8. Provide clear, actionable recovery paths instead of generic errors.
9. Deliver a consistent light-first visual system with an optional global dark mode.
10. Be suitable for paid use: fast, modern, accessible, responsive, secure, and professionally finished.

## 3. Non-goals for the first slice

The first slice will not attempt to ship every future Morrow capability. It will not include:

- a public marketplace for agents, skills, or templates;
- a visual workflow builder;
- a dense enterprise administration console;
- arbitrary custom dashboard widgets;
- full cloud execution infrastructure;
- complete billing and subscription management;
- every possible artifact editor;
- a permanent top-level page for every specialist agent;
- raw logs as the default user experience;
- a separate personal product and team product.

These can be added later without changing the core interaction model.

## 4. Primary product model

### 4.1 Morrow as the central agent

The user delegates work to Morrow. Morrow owns mission coordination and may create a temporary or persistent specialist team when useful.

Specialists can include researchers, developers, analysts, writers, browser operators, reviewers, fact checkers, project managers, or domain-specific agents. They are visible as supporting participants inside a mission, not as the primary navigation model.

This preserves simplicity for ordinary users while retaining deep observability for advanced users.

### 4.2 Missions as the unit of work

A mission is a durable commitment to an outcome. It is independent of any single chat session, model, provider, runtime process, browser tab, or device.

Each mission contains:

- a user-facing objective;
- scope and instructions;
- workspace and ownership;
- plan and milestones;
- current state;
- required capabilities and connections;
- specialist assignments when applicable;
- human decisions and approvals;
- activity events;
- artifacts and evidence;
- blockers and recovery history;
- completion and verification state.

### 4.3 Personal and team workspaces

The same application supports both contexts.

A personal workspace contains private missions, knowledge, connections, preferences, automations, and artifacts.

A team workspace adds shared knowledge, members, roles, shared connections, policies, approvals, mission assignment, review history, and audit records.

Workspace switching must feel as lightweight as switching spaces in Linear or Notion. The visual language and mission experience remain consistent.

## 5. Information architecture

### 5.1 Primary navigation

The default sidebar contains:

- **Home**
- **Missions**
- **Library**
- **Automations**

Below a separator:

- **Workspace**
- **Connections**
- **Settings**

The sidebar also contains:

- Morrow identity and product mark;
- compact workspace switcher;
- account/profile entry;
- collapsed mobile equivalent.

### 5.2 Deliberately contextual surfaces

The following do not receive permanent primary-navigation positions in the first version:

- Agents
- Templates
- Models
- Providers
- Costs
- Logs
- Approvals
- Files
- Code
- Browser sessions

They appear inside a mission, the universal composer, a contextual inspector, Connections, or Settings when relevant.

This prevents the application from turning into a control panel before the user has delegated any work.

## 6. Home experience

Home is the simplest and most important screen.

### 6.1 Universal mission composer

The primary prompt is:

> What should Morrow accomplish?

The composer supports:

- natural-language instructions;
- file attachments;
- connection selection;
- workspace selection;
- optional deadline;
- optional additional instructions;
- optional autonomy preference;
- contextual suggestions based on workspace history and available capabilities.

The default experience should require only the objective and a single **Start mission** action. Advanced controls remain behind progressive disclosure.

The composer must not require the user to choose a task category such as Coding, Research, Browser, or Documents. Morrow determines the needed capabilities.

### 6.2 Home sections

Below the composer, Home shows only high-value sections:

1. **Needs your attention** — approvals, decisions, expired connections, or blocked missions.
2. **Active missions** — compact cards showing objective, current stage, progress, and latest meaningful activity.
3. **Recent results** — completed missions and their primary deliverables.

Empty states should teach the product through a few high-quality examples, not a large template gallery.

## 7. Mission workspace

Every mission uses four primary tabs:

- **Overview**
- **Activity**
- **Work**
- **Result**

A compact mission header remains visible and includes:

- mission title;
- state;
- workspace;
- elapsed time;
- current phase;
- pause/resume or cancel controls when valid;
- overflow menu for secondary actions.

### 7.1 Overview

Overview answers five questions immediately:

1. What is Morrow trying to accomplish?
2. What has already been completed?
3. What is happening now?
4. Does Morrow need anything from the user?
5. What remains before the mission can be considered complete?

It contains:

- concise objective;
- progress through meaningful milestones;
- current step and human-readable description;
- recent meaningful activity;
- blocker or decision card when applicable;
- compact specialist-team summary when applicable;
- evidence and artifact previews;
- confidence or verification state only when grounded in actual evidence.

Progress must never be fabricated from arbitrary percentages. Prefer milestone completion, current phase, and explicit remaining work. Time estimates appear only when supported by reliable task history or deterministic operations.

### 7.2 Activity

Activity is a human-readable, chronological mission history.

Default events summarize meaningful work, for example:

- Reviewed 18 competitor websites.
- Reproduced the authentication failure.
- Created a draft presentation.
- Requested independent source verification.
- Validation failed because PostgreSQL was unavailable.
- Resumed from checkpoint after the local runtime restarted.

Each event can expand to show:

- responsible agent;
- source tool or connection;
- related files and artifacts;
- command or browser details;
- model/provider metadata;
- cost and token data when available;
- raw technical payloads in a dedicated inspector.

The default timeline must never resemble a wall of terminal logs.

### 7.3 Work

Work is adaptive. It renders the appropriate tools and artifacts for the mission rather than forcing every mission into a chat transcript.

Examples:

- software mission: repository, changed files, diffs, commands, tests, preview, pull request;
- research mission: sources, notes, claims, citations, comparisons;
- browser mission: visited pages, screenshots, forms, extracted data;
- data mission: tables, calculations, charts, notebooks, exported files;
- communication mission: email drafts, recipients, attachments, approval state;
- scheduling mission: proposed calendar, conflicts, attendees, confirmations;
- document mission: report, presentation, spreadsheet, version history;
- operations mission: connected systems, actions, exceptions, audit record.

The Work tab uses modular artifact viewers with a consistent frame, toolbar, version history, and download/share actions.

### 7.4 Result

Result is the premium delivery moment.

A completed mission provides:

- plain-language outcome summary;
- primary deliverables;
- verification checklist;
- important changes or decisions;
- unresolved caveats;
- evidence links;
- sharing and export actions;
- next recommended action when appropriate.

Completion states are explicit:

- **Completed and verified**
- **Completed with caveats**
- **Waiting for approval**
- **Blocked**
- **Failed but recoverable**
- **Cancelled**
- **Superseded**

Morrow must not present a mission as successfully completed when required verification failed.

## 8. Visual design system

### 8.1 Direction

The interface is professional, modern, minimal, and calm. It draws inspiration from the restraint and clarity of Claude, Linear, Notion, and high-quality native productivity applications without copying their branding or layouts.

### 8.2 Color and surfaces

Default theme:

- warm off-white application background;
- white primary surfaces;
- subtle neutral borders;
- restrained shadows used only to establish hierarchy;
- Morrow violet as the primary accent;
- semantic colors reserved for success, warning, blocker, and failure states;
- dark text with strong contrast;
- no decorative rainbow gradients.

Dark mode is global and optional. Individual pages do not switch themes independently. Code, terminal, and raw-log viewers may use dark inset surfaces when it materially improves readability, but the overall application remains thematically consistent.

### 8.3 Shape and spacing

- moderate corner radius, not exaggerated pills everywhere;
- generous whitespace around primary decisions;
- denser layouts only inside data-heavy Work views;
- consistent 4/8-pixel spacing rhythm;
- clear typographic hierarchy;
- one dominant action per screen or state;
- stable layouts that do not jump as events stream in.

### 8.4 Motion

Motion communicates causality and state:

- mission creation transitions into active state;
- new meaningful activity enters subtly;
- progress and stage changes animate without distracting;
- inspectors and contextual panels open smoothly;
- completed artifacts settle into the Result view.

Motion must respect `prefers-reduced-motion`. Decorative looping animation is prohibited.

### 8.5 Design-system ownership

Reusable foundations live in `packages/ui` and include:

- tokens;
- typography;
- buttons and inputs;
- navigation;
- cards and lists;
- status indicators;
- composer primitives;
- timeline primitives;
- artifact frames;
- inspectors and drawers;
- dialogs and approval prompts;
- loading, empty, offline, blocked, and error states.

Product-specific composition remains in `apps/web`.

## 9. Interaction principles

### 9.1 One clear next action

Every state exposes the most useful next action without hiding important context.

### 9.2 Progressive disclosure

Common work stays simple. Advanced controls for agents, models, providers, permissions, memory, costs, and raw execution appear only when needed or requested.

### 9.3 Human language first

Morrow describes activity and failure in terms users understand. Technical evidence remains inspectable without becoming the default presentation.

### 9.4 Reversible by default

Where practical, the app supports undo, rollback, restoration, mission restart from checkpoint, and version history.

### 9.5 Honest uncertainty

Morrow distinguishes confirmed facts, inferred conclusions, unresolved questions, and blocked work. It never uses confident language to hide missing evidence.

## 10. Runtime and deployment architecture

### 10.1 Repository boundaries

`Mageester/morrow` contains the actual product application and shared platform code:

```text
apps/web
services/orchestrator
services/runtime
packages/contracts
packages/ui
packages/config
```

`Mageester/morrow-axiom-site` remains responsible for the public marketing site, documentation entry points, downloads, installer assets, and release information.

The product application is not implemented inside the marketing repository.

### 10.2 URL structure

The public domain uses:

```text
morrowproject.getaxiom.ca/             marketing site
morrowproject.getaxiom.ca/app          authenticated product
morrowproject.getaxiom.ca/docs         documentation
morrowproject.getaxiom.ca/install.ps1  Windows installer
```

A reverse proxy or edge routing layer serves the appropriate deployment without breaking existing static routes.

### 10.3 Frontend stack

The selected frontend stack is:

- React;
- TypeScript;
- Vite;
- TanStack Router;
- TanStack Query;
- Radix UI primitives;
- Morrow-owned component and token system;
- Vitest;
- Playwright;
- a component workbench such as Storybook.

Vite is selected because the application is an authenticated product surface and does not require server-rendered SEO. The existing Astro marketing site continues to serve public SEO needs.

### 10.4 Hosted app and local-first runtime

The hosted web application communicates with Morrow through durable mission APIs and an authenticated event stream.

For local execution, the installed Morrow runtime establishes an encrypted outbound connection to a Morrow relay/control plane. The user does not open inbound ports or expose the local orchestrator directly to the public internet.

```text
Hosted web application
        |
        v
Morrow API and secure relay
        ^
        | encrypted outbound session
        |
Local Morrow runtime
```

The mission protocol must be independent of execution location. Future cloud runners can use the same contracts without redesigning the interface.

### 10.5 Data boundaries

The UI must clearly disclose where data and execution live:

- local only;
- Morrow-hosted control plane;
- selected external provider;
- connected third-party service;
- shared team workspace.

Secrets never return to the browser after configuration. The browser receives only connection status and permitted metadata.

## 11. Application data flow

### 11.1 Mission creation

1. User submits an objective and optional context.
2. Client validates basic input and uploads attachments through a scoped artifact endpoint.
3. Server creates a durable mission record and immediately returns its mission ID and initial state.
4. Client navigates to the mission Overview.
5. Orchestrator produces the initial understanding, plan, required capabilities, and any immediate approval or connection needs.
6. Updates stream as typed mission events.

### 11.2 Live updates

The client consumes an ordered event stream with resumable cursors. Events update a normalized client cache but the server remains authoritative.

On reconnect, the client requests:

- current mission snapshot;
- events after the last acknowledged cursor;
- active approval or decision requests;
- artifact changes;
- runtime connectivity state.

The UI displays a subtle synchronization state rather than pretending disconnected data is live.

### 11.3 User decisions

Approval and decision requests are typed objects, not free-form chat interruptions. Each request contains:

- decision needed;
- why it matters;
- Morrow's recommendation;
- available choices;
- consequences;
- whether the mission can continue on unrelated work;
- expiry or retry behavior when relevant.

Responses become durable mission events and are auditable in team workspaces.

## 12. Error and recovery design

The application is designed around explicit operational states.

Required global and mission states include:

- initial loading;
- empty;
- offline;
- reconnecting;
- synchronized;
- partially synchronized;
- local runtime unavailable;
- provider unavailable;
- connection expired;
- waiting for approval;
- blocked by external dependency;
- failed but recoverable;
- failed permanently;
- interrupted and resumed;
- completed but unverified;
- completed and verified;
- cancelled;
- superseded.

### 12.1 Error-card contract

Every actionable error explains:

1. what happened;
2. what work remains safe;
3. what Morrow already attempted;
4. the recommended action;
5. alternative actions when meaningful;
6. how the mission will continue afterward.

Generic messages such as “Something went wrong” may appear only as a last-resort fallback and must include a trace identifier plus a retry or support path.

### 12.2 Recovery stories

After recovery, Morrow displays a concise note:

- what was interrupted;
- why recovery occurred;
- which checkpoint was restored;
- whether any work was replayed;
- whether validation remains trustworthy;
- what happens next.

This turns recovery into a visible product capability rather than a hidden technical event.

## 13. Accessibility and responsive behavior

The first release targets WCAG 2.2 AA for core flows.

Requirements include:

- complete keyboard navigation;
- visible focus states;
- semantic landmarks and headings;
- accessible names for icons and controls;
- screen-reader announcements for meaningful mission-state changes without flooding;
- sufficient contrast in both themes;
- reduced-motion support;
- no information conveyed by color alone;
- touch targets suitable for mobile;
- logical focus restoration after dialogs and drawers.

Desktop is the primary authoring and review surface. Mobile supports mission creation, status checks, approvals, steering, artifact previews, and urgent recovery actions. Data-heavy editing can defer to desktop while remaining readable on mobile.

## 14. Security and privacy requirements

The first slice must include:

- authenticated sessions with secure cookie handling;
- workspace-scoped authorization on every mission and artifact request;
- least-privilege access for team roles;
- short-lived relay credentials;
- device and runtime revocation;
- encrypted transport;
- no provider secrets in browser storage;
- CSRF protection for state-changing requests;
- content security policy;
- attachment type and size validation;
- audit events for approvals, shared actions, and permission changes;
- clear external-data disclosure before sensitive actions;
- secure defaults for local runtime pairing.

Security-sensitive settings must not be hidden merely to preserve visual minimalism. They should be clearly explained at the moment they matter.

## 15. Testing strategy

### 15.1 Contract tests

Validate mission snapshots, events, approvals, artifacts, connection states, workspace roles, and recovery payloads against shared schemas in `packages/contracts`.

### 15.2 Component tests

Cover all interactive primitives and every required state, including keyboard behavior and accessibility semantics.

### 15.3 Visual regression

Capture representative light and dark screens at desktop, tablet, and mobile sizes. Include streaming, loading, empty, approval, blocked, offline, recovery, and completed-result states.

### 15.4 End-to-end tests

The first release must prove:

1. sign in and open personal workspace;
2. create a mission from the universal composer;
3. receive a durable plan and live progress;
4. refresh during execution and recover the exact mission state;
5. disconnect and reconnect without duplicate activity;
6. answer an approval or decision request;
7. inspect adaptive Work artifacts;
8. view a verified Result;
9. switch to a team workspace and respect authorization;
10. use the core flow with keyboard only;
11. complete mobile approval and steering flows;
12. handle local runtime outage and recovery honestly.

### 15.5 Reliability gates

No release is acceptable if it produces:

- duplicate activity events;
- fabricated progress;
- lost mission input after refresh;
- completion without required evidence;
- stale approval prompts;
- cross-workspace data leakage;
- silent runtime disconnection;
- provider secrets in browser-visible payloads;
- unrecoverable navigation after an error.

## 16. First production slice

The first coherent release includes:

- application shell;
- Morrow design tokens and reusable UI foundations;
- light theme and global dark mode;
- authentication shell;
- personal and team workspace switcher;
- universal mission composer;
- real mission creation through shared contracts;
- durable live mission-state streaming;
- Overview, Activity, Work, and Result tabs;
- adaptive artifact frame with initial file, document, source, and code/diff viewers;
- typed approval and user-decision prompts;
- connection and local-runtime status;
- reconnect, recovery, blocked, and error states;
- responsive desktop and mobile layouts;
- `/app` deployment routing;
- contract, component, accessibility, visual-regression, and end-to-end tests.

The first release is successful when a real user can begin a general mission, leave or refresh the app, return to accurate live state, provide needed input, inspect the work, and receive a clear evidence-backed result without understanding Morrow's internal orchestration.

## 17. Acceptance criteria

The design is successfully implemented when:

- a first-time user can begin a mission without documentation;
- no task-type selector is required;
- the main navigation remains within the approved structure;
- advanced controls do not crowd the default experience;
- Morrow remains the primary identity even when specialists are used;
- personal and team missions use one consistent interaction model;
- all mission states are explicit and truthful;
- the app remains usable through refresh, reconnect, and runtime restart;
- every actionable failure provides a next step;
- results include deliverables, evidence, caveats, and verification state;
- light and dark themes are globally consistent;
- desktop and mobile core flows pass automated accessibility and end-to-end checks;
- the product is served at `morrowproject.getaxiom.ca/app` without breaking the existing marketing site, documentation, or installer routes.

## 18. Design decisions locked by this specification

1. Morrow is a general autonomous agent, not a coding-only product.
2. The web app supports both individuals and teams in one product.
3. Morrow is one central agent with contextual visibility into specialists.
4. Missions, not chats or agents, are the primary unit of work.
5. The interface is light-first with an optional global dark mode.
6. The default experience is minimal; complexity is progressively disclosed.
7. The actual application lives in `Mageester/morrow`, not the marketing repository.
8. The product is hosted at `morrowproject.getaxiom.ca/app`.
9. The frontend uses React, TypeScript, Vite, TanStack Router, TanStack Query, Radix primitives, and a Morrow-owned design system.
10. Local runtimes connect outbound through a secure relay rather than exposing inbound ports.
11. Recovery, blocked states, and verification are first-class product surfaces.
12. The first slice must be a real end-to-end mission experience, not a static dashboard demo.
