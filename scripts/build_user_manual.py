#!/usr/bin/env python3
"""
Build a highly detailed, professionally formatted Morrow user manual PDF.

Source of truth: Morrow repository docs/ + README.md (beta.31).
Renderer: ReportLab Platypus (flowables + custom theme).

Run:
    python scripts/build_user_manual.py
Output:
    docs/morrow-user-manual.pdf
"""
import os
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch, mm
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.styles import ListStyle
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle,
    PageBreak, NextPageTemplate, KeepTogether, HRFlowable, ListFlowable,
    ListItem, Preformatted, FrameBreak,
)
from reportlab.platypus.tableofcontents import TableOfContents

# ---------------------------------------------------------------------------
# Theme
# ---------------------------------------------------------------------------
NAVY = colors.HexColor("#10243f")
NAVY2 = colors.HexColor("#1b3a63")
ACCENT = colors.HexColor("#2f6fb0")
ACCENT_LT = colors.HexColor("#e8f1fa")
SLATE = colors.HexColor("#475569")
INK = colors.HexColor("#1f2933")
CODE_BG = colors.HexColor("#0f172a")
CODE_FG = colors.HexColor("#e2e8f0")
GREY_BG = colors.HexColor("#f1f5f9")
WARN_BG = colors.HexColor("#fff7ed")
WARN_BD = colors.HexColor("#f59e0b")
OK_BG = colors.HexColor("#ecfdf5")
OK_BD = colors.HexColor("#10b981")
PRIV_BG = colors.HexColor("#fef2f2")
PRIV_BD = colors.HexColor("#ef4444")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE_DIR, "docs", "morrow-user-manual.pdf")
VERSION = "0.1.0-beta.31"
DATE = "July 2026"

# ---------------------------------------------------------------------------
# Styles
# ---------------------------------------------------------------------------
ss = getSampleStyleSheet()

H1 = ParagraphStyle("H1", parent=ss["Heading1"], fontName="Helvetica-Bold",
                    fontSize=18, textColor=NAVY, spaceBefore=4, spaceAfter=10,
                    leading=22)
H2 = ParagraphStyle("H2", parent=ss["Heading2"], fontName="Helvetica-Bold",
                    fontSize=13.5, textColor=NAVY2, spaceBefore=14, spaceAfter=6,
                    leading=17)
H3 = ParagraphStyle("H3", parent=ss["Heading3"], fontName="Helvetica-Bold",
                    fontSize=11, textColor=ACCENT, spaceBefore=9, spaceAfter=4,
                    leading=14)
BODY = ParagraphStyle("BODY", parent=ss["BodyText"], fontName="Helvetica",
                      fontSize=9.7, textColor=INK, leading=14.2, spaceAfter=6,
                      alignment=TA_JUSTIFY, firstLineIndent=0)
BODY_L = ParagraphStyle("BODY_L", parent=BODY, alignment=TA_LEFT)
BODY_SM = ParagraphStyle("BODY_SM", parent=BODY, fontSize=8.6, leading=12,
                         textColor=SLATE)
LEAD = ParagraphStyle("LEAD", parent=BODY, fontSize=10.5, leading=15.5,
                      textColor=INK, spaceAfter=8)
BULLET = ParagraphStyle("BULLET", parent=BODY, spaceAfter=2, alignment=TA_LEFT)
TOC_H = ParagraphStyle("TOC_H", parent=H1, fontSize=20, alignment=TA_CENTER,
                       textColor=NAVY, spaceAfter=4)
COVER_T = ParagraphStyle("COVER_T", parent=ss["Title"], fontName="Helvetica-Bold",
                         fontSize=30, textColor=NAVY, alignment=TA_CENTER,
                         leading=36, spaceAfter=6)
COVER_S = ParagraphStyle("COVER_S", parent=ss["Title"], fontName="Helvetica",
                         fontSize=14, textColor=SLATE, alignment=TA_CENTER,
                         leading=20)
CODE = ParagraphStyle("CODE", fontName="Courier", fontSize=8.3, textColor=CODE_FG,
                      leading=11, backColor=CODE_BG, borderPadding=(8, 8, 8, 8),
                      leftIndent=2, rightIndent=2, spaceBefore=2, spaceAfter=8)
CAPTION = ParagraphStyle("CAPTION", parent=BODY_SM, alignment=TA_CENTER,
                         textColor=SLATE, spaceBefore=2, spaceAfter=10)
TH = ParagraphStyle("TH", fontName="Helvetica-Bold", fontSize=8.7, textColor=colors.white,
                    leading=11, alignment=TA_LEFT)
TD = ParagraphStyle("TD", fontName="Helvetica", fontSize=8.7, textColor=INK,
                    leading=11.5, alignment=TA_LEFT)
TD_C = ParagraphStyle("TD_C", parent=TD, alignment=TA_CENTER)


def P(t, s=BODY):
    return Paragraph(t, s)


def code_block(text):
    # Preserve indentation; strip a single common leading newline
    if text.startswith("\n"):
        text = text[1:]
    return Preformatted(text.rstrip("\n"), CODE)


def bullets(items, style=BULLET):
    flow = []
    for it in items:
        flow.append(ListItem(Paragraph(it, style), leftIndent=6, value="•"))
    return ListFlowable(flow, bulletType="bullet", start="•", leftIndent=14,
                        bulletColor=ACCENT, spaceBefore=2, spaceAfter=6)


def numbered(items, style=BULLET):
    flow = []
    for it in items:
        flow.append(ListItem(Paragraph(it, style), leftIndent=6))
    return ListFlowable(flow, bulletType="1", leftIndent=16, spaceBefore=2,
                        spaceAfter=6)


def callout(title, body, bg, bd, icon="•"):
    head = Paragraph(f'<font color="{bd.hexval()}"><b>{icon} {title}</b></font>',
                     ParagraphStyle("cx", parent=BODY, fontSize=9.5, leading=12,
                                    spaceAfter=2))
    b = Paragraph(body, ParagraphStyle("cb", parent=BODY, fontSize=9, leading=12.5,
                                       alignment=TA_LEFT, spaceAfter=0))
    t = Table([[head], [b]], colWidths=[6.9 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LINEBEFORE", (0, 0), (0, -1), 3, bd),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, 0), 7),
        ("BOTTOMPADDING", (0, -1), (-1, -1), 8),
        ("TOPPADDING", (0, 1), (-1, 1), 0),
    ]))
    return KeepTogether([t, Spacer(1, 8)])


def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def table(data, col_widths, header=True, align_center_cols=None):
    align_center_cols = align_center_cols or []
    rows = []
    for r, row in enumerate(data):
        style_row = []
        cells = []
        for c, cell in enumerate(row):
            txt = _esc(cell)
            s = TH if (header and r == 0) else (TD_C if c in align_center_cols else TD)
            cells.append(Paragraph(txt, s))
        rows.append(cells)
    t = Table(rows, colWidths=col_widths, repeatRows=1 if header else 0)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
    ]
    if header:
        style += [
            ("BACKGROUND", (0, 0), (-1, 0), NAVY2),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1),
             [colors.white, GREY_BG]),
            ("LINEBELOW", (0, 0), (-1, 0), 1, NAVY),
        ]
    t.setStyle(TableStyle(style))
    return t


# ---------------------------------------------------------------------------
# Document with TOC + page furniture
# ---------------------------------------------------------------------------
class Manual(BaseDocTemplate):
    def __init__(self, filename, **kw):
        super().__init__(filename, **kw)
        self.toc_entries = []
        w, h = LETTER
        margin = 0.85 * inch
        frame = Frame(margin, margin, w - 2 * margin, h - 2 * margin - 0.35 * inch,
                      id="body", topPadding=6, bottomPadding=6)
        cover = Frame(margin, margin, w - 2 * margin, h - 2 * margin,
                      id="cover", topPadding=6, bottomPadding=6)
        self.addPageTemplates([
            PageTemplate(id="cover", frames=[cover]),
            PageTemplate(id="body", frames=[frame], onPage=self.decor),
        ])

    def afterFlowable(self, flowable):
        if isinstance(flowable, TOCHeading):
            self.notify("TOCEntry", (flowable._toc_level, flowable._toc_text,
                                     self.page))

    def decor(self, canvas, doc):
        canvas.saveState()
        w, h = LETTER
        # header rule (skip first body page handled by TOC template swap)
        if doc.page > 2:
            canvas.setStrokeColor(colors.HexColor("#d7dee8"))
            canvas.setLineWidth(0.5)
            canvas.line(0.85 * inch, h - 0.7 * inch, w - 0.85 * inch, h - 0.7 * inch)
            canvas.setFont("Helvetica", 7.5)
            canvas.setFillColor(SLATE)
            canvas.drawString(0.85 * inch, h - 0.62 * inch,
                              "Morrow — User Manual")
            canvas.drawRightString(w - 0.85 * inch, h - 0.62 * inch,
                                   f"v{VERSION} · {DATE}")
        # footer
        canvas.setStrokeColor(colors.HexColor("#d7dee8"))
        canvas.setLineWidth(0.5)
        canvas.line(0.85 * inch, 0.6 * inch, w - 0.85 * inch, 0.6 * inch)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(SLATE)
        canvas.drawString(0.85 * inch, 0.45 * inch,
                          "© 2026 Aidan Magee · All rights reserved")
        canvas.drawCentredString(w / 2, 0.45 * inch, "Private Intelligence, Built Around You")
        canvas.drawRightString(w - 0.85 * inch, 0.45 * inch, f"Page {doc.page}")
        canvas.restoreState()


def make_toc(story):
    story.append(NextPageTemplate("body"))
    story.append(PageBreak())
    story.append(P("Table of Contents", TOC_H))
    story.append(HRFlowable(width="40%", thickness=1.2, color=ACCENT,
                            spaceBefore=2, spaceAfter=14, hAlign="CENTER"))
    toc = TableOfContents()
    toc.levelStyles = [
        ParagraphStyle("t1", fontName="Helvetica-Bold", fontSize=10.5,
                       textColor=NAVY, leading=18, leftIndent=4),
        ParagraphStyle("t2", fontName="Helvetica", fontSize=9.3, textColor=INK,
                       leading=15, leftIndent=20),
        ParagraphStyle("t3", fontName="Helvetica", fontSize=8.6, textColor=SLATE,
                       leading=13, leftIndent=36),
    ]
    story.append(toc)
    story.append(PageBreak())


# Helper to emit a heading that also registers a TOC entry.
_TOC_LEVEL_STYLE = {0: H1, 1: H2, 2: H3}


class TOCHeading(Paragraph):
    """A heading Paragraph flagged for TOC registration (see Manual.afterFlowable)."""
    def __init__(self, text, level):
        super().__init__(text, _TOC_LEVEL_STYLE[level])
        self._toc_text = text
        self._toc_level = level

    def draw(self):
        super().draw()
        self.canv.bookmarkPage(self._toc_text[:40] + str(id(self)))


def H(text, level):
    """Append a heading that registers in the TOC."""
    story.append(TOCHeading(text, level))


# ---------------------------------------------------------------------------
# Build story
# ---------------------------------------------------------------------------
story = []

# ===== COVER ============================================================
story.append(Spacer(1, 1.1 * inch))
story.append(P("MORROW", COVER_T))
story.append(HRFlowable(width="55%", thickness=2, color=ACCENT,
                        spaceBefore=8, spaceAfter=14, hAlign="CENTER"))
story.append(P("Complete User Manual", COVER_S))
story.append(P("Private intelligence, built around you.", COVER_S))
story.append(Spacer(1, 0.3 * inch))
story.append(P(f"Version {VERSION}", ParagraphStyle("v", parent=COVER_S,
              fontSize=12, textColor=NAVY)))
story.append(P(DATE, ParagraphStyle("d", parent=COVER_S, fontSize=10,
              textColor=SLATE)))
story.append(Spacer(1, 0.7 * inch))

cover_meta = Table([
    ["Product", "Morrow — local-first personal AI agent"],
    ["Status", "Early Access (Windows 10/11 x64; Linux source build)"],
    ["Owner", "Aidan Magee — aidan@getaxiom.ca"],
    ["Organization", "Axiom International · getaxiom.ca"],
    ["Website", "https://morrowproject.getaxiom.ca"],
], colWidths=[1.5 * inch, 4.4 * inch])
cover_meta.setStyle(TableStyle([
    ("FONTSIZE", (0, 0), (-1, -1), 9.2),
    ("TEXTCOLOR", (0, 0), (0, -1), NAVY2),
    ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
    ("FONTNAME", (1, 0), (1, -1), "Helvetica"),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("TOPPADDING", (0, 0), (-1, -1), 5),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ("LINEBELOW", (0, 0), (-1, -1), 0.4, colors.HexColor("#d7dee8")),
]))
story.append(cover_meta)
story.append(Spacer(1, 0.6 * inch))
story.append(P("This manual documents the product as verified in the repository at "
               "the beta.31 release. Feature claims are backed by tests or documented "
               "evidence; known limitations are called out explicitly.",
               ParagraphStyle("disc", parent=BODY_SM, alignment=TA_CENTER,
                              fontSize=8.3)))
story.append(NextPageTemplate("body"))
story.append(PageBreak())

# ===== TOC ==============================================================
make_toc(story)

# ===== 1. INTRODUCTION ==================================================
H("1. Introduction", 0)
story.append(P("Morrow is a self-hosted, deeply customizable personal AI agent. It is "
               "local-first, provider-neutral, and built around you: conversations, "
               "project state, memory, provider credentials, logs, and diagnostics "
               "remain on your machine unless a tool or configured model provider is "
               "explicitly used. Morrow is designed for visible execution, explicit "
               "permissions, and persistent memory — and it grades its own work "
               "honestly rather than asking you to trust a model's self-assessment.",
               LEAD))

H("1.1 What Morrow is for", 1)
story.append(P("Morrow helps you run accountable work through a supervised agent. A "
               "<b>mission</b> defines success up front, executes under supervision, "
               "records what happened, verifies the outcome with concrete evidence, "
               "obtains an independent review, and grades itself honestly. Every part "
               "of it is durable — a service restart never loses the objective, "
               "criteria, evidence, checkpoints, failures, or reviewer verdict.", BODY))
story.append(bullets([
    "Natural chat with project-aware memory.",
    "Terminal, filesystem, browser, web, vision, voice, and coding tools.",
    "Local and cloud model providers with intelligent routing.",
    "Persistent named agents with separate roles, memory, tools, and permissions.",
    "Scheduled tasks, triggers, webhooks, and messaging integrations.",
    "Skills, plugins, MCP servers, and Hermes-compatible imports.",
    "Detailed privacy, cost, execution, and verification records.",
]))

H("1.2 Product principles", 1)
story.append(table([
    ["Principle", "What it means in practice"],
    ["Simple by default, powerful by choice",
     "New users get polished presets; advanced users can customize models, tools, memory, agents, permissions, workflows, and interface behavior."],
    ["Local-first and provider-neutral",
     "You own your data and can choose local models, cloud models, or a controlled mix."],
    ["Visible execution",
     "Plans, tool calls, files, costs, external data sharing, and agent activity are inspectable."],
    ["Reliable autonomy",
     "Long-running tasks persist, recover, retry safely, and verify their own results."],
    ["Reversible actions",
     "File changes, configuration, memory, and automations support history and rollback."],
    ["Proof over claims",
     "Morrow publishes repeatable parity and performance tests instead of relying on marketing language."],
], [2.1 * inch, 4.8 * inch]))
story.append(Spacer(1, 6))
story.append(callout("Status note", "Morrow v0.1.0-beta.31 is an Early Access release. "
               "Windows 10/11 x64 is supported; Linux is source-build only; macOS is "
               "planned. Some capabilities (write tools, subscription OAuth for some "
               "providers, live model discovery) are intentionally gated. See "
               "Section 12 for the full list of current limitations.", WARN_BG, WARN_BD,
               icon="!"))

# ===== 2. ARCHITECTURE OVERVIEW =========================================
H("2. Architecture overview", 0)
story.append(P("Morrow is a monorepo (pnpm workspaces + Turbo) with a clear separation "
               "between the client surfaces, the orchestrator that owns tasks and "
               "execution, and the provider/runtime boundary. The browser client is "
               "never trusted with provider secrets, and models are never trusted to "
               "grant themselves permissions.", BODY))

H("2.1 System view", 1)
story.append(P("Web / Desktop / CLI / Messaging clients talk to the Morrow Application "
               "API, which fronts the Orchestrator. The Orchestrator owns the task "
               "planner, persistent named agents, the model router, the memory "
               "service, the scheduler, and tool-permission decisions. Below it, the "
               "Tool Runtime executes filesystem, terminal, browser, web, and "
               "extension actions.", BODY))
arch = code_block("""Web / Desktop / CLI / Messaging
              |
              v
      Morrow Application API
              |
      +-------+--------+
      v                v
 Orchestrator       Event stream
      |
      +-- Task planner and checkpoints
      +-- Persistent named agents
      +-- Model router
      +-- Memory service
      +-- Scheduler
      +-- Tool permission decisions
              |
              v
         Tool Runtime
      +-- Filesystem
      +-- Terminal
      +-- Browser
      +-- Web and APIs
      +-- Extension adapters""")
story.append(arch)

H("2.2 Repository map", 1)
story.append(table([
    ["Path", "Role"],
    ["apps/web", "Primary product interface: navigation, conversation, projects, settings, customization studio."],
    ["apps/cli", "The `morrow` CLI plus interactive terminal / TUI (Mission Control)."],
    ["services/orchestrator", "Tasks, plans, agents, scheduling, provider runtime, persistence (SQLite)."],
    ["services/runtime", "Model execution and tool invocation behind explicit contracts (scaffold)."],
    ["packages/contracts", "Canonical Zod schemas / protocol types shared across packages."],
    ["packages/hermes-compat", "Narrow compatibility layer for importing supported Hermes config, skills, memory, sessions."],
    ["packages/ui, packages/config", "Design system / shared config (README-only scaffolds in beta.31)."],
    ["apps/desktop", "Native desktop shell (scaffold)."],
], [2.2 * inch, 4.7 * inch]))

H("2.3 Trust boundaries", 1)
story.append(bullets([
    "The browser client is not trusted with provider secrets.",
    "Models are not trusted to grant themselves permissions.",
    "Tool results are treated as untrusted input.",
    "Extensions run with declared capabilities only.",
    "External model providers receive only the context selected for that request.",
    "Provider credentials and tool authority do not live in the web client.",
]))

# ===== 3. INSTALLATION ==================================================
H("3. Installation", 0)
story.append(P("The Windows installer bundles its own Node.js runtime, so Git, Node.js, "
               "and pnpm are not required for the Windows install. It verifies the "
               "artifact's SHA-256 checksum, stages and validates the package, "
               "preserves existing user data during upgrades, adds `morrow` to your "
               "user PATH, and starts the loopback service. It does not open a browser.",
               BODY))

H("3.1 Windows quick install", 1)
story.append(code_block("""# In PowerShell:
iex (irm https://morrowproject.getaxiom.ca/install.ps1)

# After install, open a NEW PowerShell window:
morrow            # opens the terminal agent shell
morrow onboard    # guided provider setup"""))
story.append(P("Provider credentials are saved in Morrow's local owner-readable secrets "
               "file and are not written to task events, reports, diagnostic exports, "
               "or browser storage.", BODY_SM))

H("3.2 Verify or troubleshoot", 1)
story.append(code_block("""morrow --version
morrow status
morrow doctor            # consumer-readable health checks
morrow doctor --json     # one stable JSON document for automation
morrow doctor --export   # redacted diagnostic bundle"""))
story.append(callout("Unicode in PowerShell", "If PowerShell shows broken Unicode "
               "glyphs, use Windows Terminal with a UTF-8 profile and rerun "
               "`morrow doctor`. Plain-text and redirected output remain available when "
               "terminal capabilities are limited.", ACCENT_LT, ACCENT))

H("3.3 Upgrade and rollback", 1)
story.append(P("Rerun the quick-install command to upgrade. The installer replaces only "
               "the application tree under <font face='Courier'>%LOCALAPPDATA%\\Morrow\\app</font>; "
               "conversations, memory, configuration, provider credentials, logs, cache, "
               "and backups are preserved. The previous application tree remains available "
               "until the new service passes an identity-checked health probe, and a failed "
               "activation is rolled back.", BODY))

H("3.4 Uninstall", 1)
story.append(code_block("""morrow uninstall                 # interactive; keeps local data
morrow uninstall --yes --keep-data
morrow uninstall --yes --purge-data   # PERMANENTLY deletes all local data"""))
story.append(callout("Destructive", "`--purge-data` permanently deletes local "
               "conversations, memory, project state, configuration, provider credentials, "
               "backups, logs, and cache. It cannot be undone.", PRIV_BG, PRIV_BD, icon="✕"))

H("3.5 Linux source build", 1)
story.append(P("Linux is source-build only; macOS is not supported in beta.31. Requirements: "
               "Node.js 22+ and pnpm 10.x.", BODY_SM))
story.append(code_block("""git clone https://github.com/Mageester/morrow.git
cd morrow
pnpm install
pnpm check
pnpm test
pnpm build
pnpm --filter @morrow/cli morrow"""))

# ===== 4. FIRST RUN & ONBOARDING ========================================
H("4. First run and onboarding", 0)
story.append(P("On a fresh install the fastest path is the guided onboarding, which "
               "connects a provider and creates your first project workspace. You can "
               "use either the CLI or the web interface.", BODY))
story.append(numbered([
    "Run <font face='Courier'>morrow onboard</font> (CLI) or open the Onboarding Wizard in the web app.",
    "Connect at least one model provider: paste an API key (app) or run <font face='Courier'>morrow providers configure &lt;provider&gt; --key &lt;KEY&gt;</font> (CLI).",
    "Pick a default model and, optionally, a preset such as Balanced or Private Local.",
    "Create a project pointed at a workspace (folder / repository) path.",
    "Open a conversation and send your first message.",
]))
H("4.1 Surfaces at a glance", 1)
story.append(table([
    ["Surface", "Entry point", "Notes"],
    ["CLI / TUI", "morrow <command>; interactive terminal", "Mission Control is the primary live task surface."],
    ["Web", "apps/web (React/Vite)", "MissionControl, OnboardingWizard, ProviderManager, SkillsControlCenter, SystemHealth."],
    ["Backend", "services/orchestrator", "Fastify server, default 127.0.0.1:4317. CLI/web are clients of its HTTP + SSE API."],
], [1.7 * inch, 2.5 * inch, 2.7 * inch], align_center_cols=[]))

# ===== 5. THE COMMAND LINE ==============================================
H("5. The command line", 0)
story.append(P("The <font face='Courier'>morrow</font> CLI is the most direct way to "
               "interact with the agent. The commands below are the ones you will use "
               "day to day.", BODY))

H("5.1 Core commands", 1)
story.append(table([
    ["Command", "Purpose"],
    ["morrow", "Open the interactive terminal agent shell."],
    ["morrow onboard", "Guided provider + project setup."],
    ["morrow status", "Show service / environment health."],
    ["morrow doctor [--json|--export]", "Consumer-readable (or machine-readable) diagnostics."],
    ["morrow providers configure <p> --key <K> [--url <u>] [--model <m>]", "Add/telemetry-free configure a provider credential."],
    ["morrow providers test <p>", "Verify a provider connection."],
    ["morrow providers remove <p>", "Delete a stored credential."],
    ["morrow providers", "List configured providers and status."],
    ["morrow mission \"<objective>\"", "Start an accountable mission (see Section 6)."],
    ["morrow mission list|show|result|criteria|evidence|failures|checkpoints [id]", "Inspect missions."],
    ["morrow update", "Check for a newer version (pre-release aware)."],
    ["morrow uninstall", "Remove the application (keeps or purges data)."],
], [3.4 * inch, 3.5 * inch]))

H("5.2 Mission Control (interactive)", 1)
story.append(P("Inside the interactive shell, <font face='Courier'>morrow mission</font> "
               "opens the primary Mission Control session — the same live task surface "
               "as chat/fix, with streaming events, approvals, and Ctrl+C cancellation. "
               "The following slash commands are available:", BODY))
story.append(table([
    ["Command", "What it shows"],
    ["/model", "Interactive model picker with live status / context."],
    ["/status", "Premium live-status experience (current request vs cumulative session)."],
    ["/context", "Canonical context / token usage (agrees with /status)."],
    ["/output", "Rendered task output."],
    ["/diff", "Change applied to files (GET /api/tasks/:id/diff)."],
    ["/undo", "Roll back the change (GET /api/tasks/:id/undo)."],
    ["/tree", "Persisted task / subagent tree (GET /api/tasks/:id/tree)."],
    ["/result", "Mission aggregate: status, provider/model, plan, files, evidence, approvals, next safe action."],
    ["/criteria /evidence /failures /checkpoints", "Mission detail views."],
    ["/panic", "Stop all running work."],
], [2.0 * inch, 4.9 * inch]))

H("5.3 Model picker and live status (beta.30+)", 1)
story.append(P("Beta.30 added an interactive <font face='Courier'>/model</font> picker with "
               "honest live status/context, and a normalized reasoning-effort control that "
               "is wired through to the provider request. The picker groups models by "
               "provider, tags the provider default, honestly marks unconfigured rows, and "
               "exposes a detail panel (endpoint, context window, usable input, output "
               "reserve, tool/vision support, pricing, configuration state). The live "
               "status distinguishes the <b>current request</b> from the <b>cumulative "
               "session</b> and never fabricates a cost split it cannot prove.", BODY))

# ===== 6. MISSIONS (ACCOUNTABLE WORK) ===================================
H("6. Missions — accountable work", 0)
story.append(P("A <b>mission</b> is Morrow's unit of accountable work. Instead of trusting "
               "that an agent finished, a mission defines success up front, executes under "
               "supervision, records what happened, verifies the outcome with concrete "
               "evidence, obtains an independent review, and grades itself honestly.", BODY))
story.append(code_block("""# From inside a repository (or with a selected project):
morrow mission "Find and fix the most important runtime bugs in this project.
Preserve intended behaviour and prove the repaired application works." """))

H("6.1 Mission lifecycle", 1)
story.append(numbered([
    "Morrow drafts measurable <b>success criteria</b> and shows you the mission contract.",
    "It waits for approval (or auto-approves in autonomous / --yes / yolo runs, still displaying and persisting the contract).",
    "It takes a <b>checkpoint</b> before making changes.",
    "It <b>executes</b> the work with the agent.",
    "It <b>verifies</b> each criterion with real evidence (command exit code, HTTP probe, bounded diff check, …).",
    "It sends the result to an <b>independent reviewer</b> (a separate execution).",
    "It <b>grades</b> the mission honestly and prints the result.",
]))

H("6.2 Success criteria", 1)
story.append(P("Criteria are measurable and testable. Vague ones (“make it better”, "
               "“ensure quality”) are rejected and rewritten into observable outcomes. "
               "Each criterion has a stable id, description, state, a verification "
               "strategy, references to the evidence that proves it, optional "
               "failure/waiver reasons, and timestamps.", BODY))
story.append(table([
    ["State", "Meaning"],
    ["proposed → approved → in_progress → verified", "The healthy progression of a criterion."],
    ["failed / waived / unverified", "Reached when a criterion cannot be proven or is explicitly waived."],
], [3.0 * inch, 3.9 * inch]))
story.append(P("Verification kinds: command, test, build, typecheck, lint, runtime, http, "
               "browser, diff, review, manual, artifact.", BODY_SM))

H("6.3 Evidence ledger", 1)
story.append(P("A criterion becomes <b>verified</b> only when it is connected to evidence "
               "whose status is <font face='Courier'>passed</font> — never because an agent "
               "said so. Evidence records the type, a concise summary, the command and exit "
               "code (when applicable), a reference to the full output, and the status "
               "(passed / failed / inconclusive). A command that passes for one criterion "
               "does not silently prove another — evidence is explicitly linked to the "
               "criterion it verifies. The ledger is persisted and viewable after the "
               "mission completes.", BODY))

H("6.4 Checkpoints and rollback", 1)
story.append(P("Before risky changes Morrow captures a <b>checkpoint</b> that snapshots the "
               "exact content of the affected files (git HEAD is recorded for reference). "
               "<b>Rollback</b> restores only those captured files — it never blanket-resets "
               "the working tree and never touches unrelated pre-existing work. Rollback "
               "explains what it will change, fails safely if a needed snapshot is missing, "
               "and works after a service restart because snapshots live on disk.", BODY))

H("6.5 Independent review and honest grading", 1)
story.append(P("After primary verification the mission transitions to <i>reviewing</i> and a "
               "<b>separate</b> reviewer execution runs with isolated instructions — given "
               "the objective, approved criteria, the diff, the evidence ledger, and "
               "unresolved failures, but <b>not</b> the implementing agent's narrative. "
               "Verdicts: <b>approved</b>, <b>approved_with_risks</b>, "
               "<b>revisions_required</b>, <b>insufficient_evidence</b> (which can never "
               "become a full success).", BODY))
story.append(table([
    ["Final status", "Condition"],
    ["completed", "All criteria verified and the reviewer approved."],
    ["completed_with_reservations", "All accounted for, but something was waived or a risk was flagged (or no independent approval on record)."],
    ["partially_completed", "Some criteria failed or remain unverified."],
    ["blocked", "Safe automated recovery was exhausted / no criteria could be set."],
    ["failed", "Nothing could be proven."],
    ["cancelled", "Cancelled by the user."],
], [2.4 * inch, 4.5 * inch]))

H("6.6 Durability and resume", 1)
story.append(P("Mission state is stored in SQLite (missions, mission_criteria, "
               "mission_evidence, mission_failures, mission_checkpoints, mission_reviews, "
               "and an append-only mission_events timeline). A restart reconstructs the "
               "mission entirely from persistence — <font face='Courier'>morrow mission "
               "show</font> and the slash commands work across restarts. Only concise "
               "decisions, actions, evidence, and summaries are stored; raw model reasoning "
               "is never persisted or displayed.", BODY))

H("6.7 Failure intelligence", 1)
story.append(P("Every meaningful failure is persisted with a category (patch-context "
               "mismatch, test/build failure, provider failure, timeout, …) and a normalized "
               "signature that collapses volatile detail so repeats are detected. Recovery "
               "escalates deterministically, and the same failed operation is never repeated "
               "forever. When safe automated options are exhausted, the mission escalates to "
               "<b>blocked</b> rather than spinning.", BODY))

# ===== 7. PROVIDERS, PRESETS, ROUTING ===================================
H("7. Providers, presets, and routing", 0)
story.append(P("Morrow runs every model provider through one provider-neutral runtime. "
               "All adapters normalize to the same streaming chunk shape and the same typed "
               "error classification (auth, rate_limit, timeout, network, cancelled, "
               "invalid_request, provider).", BODY))

H("7.1 Capability matrix", 1)
story.append(table([
    ["Provider", "Kind", "Stream", "Tools", "Vision", "Local"],
    ["OpenAI", "api-key", "yes", "yes", "yes", "—"],
    ["Anthropic", "api-key", "yes", "yes", "yes", "—"],
    ["Google Gemini", "api-key", "yes", "yes", "yes", "—"],
    ["OpenRouter", "api-key", "yes", "yes", "yes", "—"],
    ["DeepSeek", "api-key", "yes", "yes", "no", "—"],
    ["OpenAI-compatible", "api-key", "yes", "yes", "no", "—"],
    ["Ollama", "local", "yes", "yes", "no", "yes"],
], [1.9 * inch, 1.4 * inch, 1.0 * inch, 1.0 * inch, 1.0 * inch, 1.0 * inch],
   align_center_cols=[1, 2, 3, 4, 5]))

H("7.2 Configuring a provider", 1)
story.append(P("There are three ways to give Morrow a provider credential. None require "
               "PowerShell, manually setting environment variables, or restarting the "
               "service.", BODY))
story.append(numbered([
    "<b>In the app (recommended).</b> Settings → Providers → Configure. Paste the API key, optionally set a custom endpoint and default model, then Save. The key is sent once to the local orchestrator, persisted to the secrets file, and applied immediately. Test connection verifies it.",
    "<b>From the CLI.</b> <font face='Courier'>morrow providers configure &lt;provider&gt; --key &lt;KEY&gt;</font> (optionally <font face='Courier'>--url</font> and <font face='Courier'>--model</font>). Same running-service endpoint, so it also takes effect with no restart.",
    "<b>Pre-seeded environment.</b> Env vars set in the shell before the service starts are honored. A shell-set variable takes precedence over a saved one; the app and CLI warn you when that shadowing happens.",
]))
story.append(callout("Where keys live", "Keys are stored server-side in the owner-readable "
               "secrets file and never reach the browser (no localStorage), the database, "
               "logs, errors, or task events. Provider status exposes only `configured`, the "
               "default model, and the endpoint <i>host</i>.", OK_BG, OK_BD, icon="✓"))

H("7.3 Credential reference", 1)
story.append(table([
    ["Provider", "API key env", "Base URL env", "Default endpoint"],
    ["OpenAI", "OPENAI_API_KEY", "OPENAI_BASE_URL", "https://api.openai.com/v1"],
    ["Anthropic", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "https://api.anthropic.com"],
    ["Gemini", "GEMINI_API_KEY / GOOGLE_API_KEY", "GEMINI_BASE_URL", "generativelanguage.googleapis.com"],
    ["OpenRouter", "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"],
    ["DeepSeek", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"],
    ["OpenAI-compatible", "OPENAI_COMPAT_API_KEY (opt)", "OPENAI_COMPAT_BASE_URL (req)", "— (OPENAI_COMPAT_MODEL)"],
    ["Ollama (local)", "—", "OLLAMA_BASE_URL (req to enable)", "http://127.0.0.1:11434/v1"],
], [1.6 * inch, 2.0 * inch, 1.7 * inch, 2.0 * inch]))

H("7.4 Presets", 1)
story.append(P("Each preset is a routing policy with concrete budgets. The router picks the "
               "first configured provider in <font face='Courier'>providerOrder</font>, "
               "resolves a model preference, and reports the decision (including fallbacks "
               "and the candidates considered).", BODY))
story.append(table([
    ["Preset", "Provider order (first few)", "Privacy", "Notes"],
    ["Best Quality", "anthropic → openai → gemini", "cloud", "Frontier models, quality first"],
    ["Balanced", "openai → anthropic → gemini", "cloud", "Sensible default"],
    ["Fast", "openai → gemini → deepseek", "cloud", "Low latency"],
    ["Cheap", "deepseek → gemini → openai", "cloud", "Lowest hosted cost"],
    ["Coding", "anthropic → openai → deepseek", "cloud", "Low temperature, more tool turns"],
    ["Research", "gemini → anthropic → openai", "cloud", "Large-context synthesis"],
    ["Private Local", "ollama", "local-only", "Never leaves the machine; requires Ollama"],
], [1.4 * inch, 2.5 * inch, 1.0 * inch, 2.4 * inch], align_center_cols=[2]))
story.append(callout("Local-only guarantee", "`Private Local` is local-only: it will not "
               "route to a hosted provider, even on an explicit override.", OK_BG, OK_BD,
               icon="✓"))

H("7.5 Honest OAuth findings", 1)
story.append(P("Morrow does <b>not</b> reverse-engineer private authentication, read browser "
               "cookies, or reuse an existing browser session. Subscription sign-in goes "
               "through each provider's real OAuth endpoints using the same first-party "
               "OAuth client ids and PKCE flow the official CLIs use, behind an explicit "
               "security/ToS warning, with tokens stored locally.", BODY))
story.append(table([
    ["Flow", "Status", "Finding"],
    ["Codex / ChatGPT (OpenAI)", "Available", "Subscription sign-in via the Codex CLI's first-party OAuth client + PKCE. Tokens target OpenAI's Codex backend. Stored locally."],
    ["Claude (Anthropic)", "Available", "Subscription sign-in via Claude Code's first-party OAuth client + PKCE. Subscription inference is for Anthropic's own tools and may be rejected. Stored locally."],
    ["Gemini (Google)", "Unavailable", "Documented Generative Language API uses API keys; Google OAuth applies to Cloud/Vertex, not consumer-subscription third-party sign-in."],
], [2.0 * inch, 1.1 * inch, 3.8 * inch], align_center_cols=[1]))

# ===== 8. TOOLS & EXECUTION =============================================
H("8. Tools and execution", 0)
story.append(P("Morrow exposes tools behind explicit, inspectable boundaries. Read-only "
               "tools run behind a shared containment layer; write and terminal tools are "
               "gated behind approval; the browser is connected progressively and only after "
               "a durable approval for the exact origin.", BODY))

H("8.1 Read-only tools and containment", 1)
story.append(P("The read-only tools — <font face='Courier'>inspect_workspace</font>, "
               "<font face='Courier'>list_files</font>, <font face='Courier'>read_file</font>, "
               "<font face='Courier'>search_files</font> — sit behind a shared containment "
               "layer that rejects path traversal, symlink escapes, secrets, and binary "
               "files, enforces byte and depth limits, and records evidence for every read.",
               BODY))
story.append(callout("Inspect workspace is deterministic", "The Inspect-workspace task has "
               "no network access, no model invocation, and no shell execution. It operates "
               "entirely locally and predictably. If the orchestrator restarts while tasks "
               "run, interrupted tasks are recovered and transitioned to a safe "
               "`interrupted` state.", ACCENT_LT, ACCENT))

H("8.2 Write and terminal tools", 1)
story.append(P("Write and terminal tools are intentionally not enabled by default in "
               "beta.31; the architecture and UI are sketched but gated until their full "
               "safety boundaries are implemented. When enabled, a proposed command or patch "
               "creates a pending approval record and the task waits "
               "(<font face='Courier'>waiting_for_approval</font>). Categorically-dangerous "
               "actions are blocked <b>before</b> an approval is even created — YOLO cannot "
               "bypass this.", BODY))

H("8.3 Browser and vision (beta.31)", 1)
story.append(P("Beta.31 connects Morrow's hardened Playwright controller to the durable "
               "agent runtime. Browser tools are exposed progressively for browser/frontend "
               "requests so unrelated coding turns do not pay the context cost.", BODY))
story.append(bullets([
    "<font face='Courier'>browser_open</font> creates a task-scoped session only after a durable approval for the exact HTTP(S) origin.",
    "Snapshot, console, click, fill, key, select, viewport, screenshot, download, and close use the approved session; the session closes on every task exit path.",
    "Screenshots/downloads live under <font face='Courier'>MORROW_HOME/artifacts/browser/&lt;task-id&gt;</font>; screenshot evidence records route, viewport, byte size, SHA-256, and whether vision attachment was allowed.",
    "PNG bytes are attached ephemerally only when the selected model has positive vision metadata; base64 is never stored in conversation text, tool output, events, or audit records.",
    "A frontend change requires an approved navigation, explicit DOM snapshot, console/page-error inspection, at least one interaction, and vision-attached screenshots at 1440×900, 768×1024, and 390×844.",
]))
story.append(callout("Browser safety", "URL credentials and non-HTTP(S) schemes are "
               "rejected. Credential, token, secret, payment, purchase, transfer, destructive "
               "account, release, deploy, publish, and push interactions are categorically "
               "blocked from autonomous browser actions. Upload/download containment rejects "
               "symlink escapes.", PRIV_BG, PRIV_BD, icon="✕"))

H("8.4 Approval and cancellation", 1)
story.append(bullets([
    "Approval: agent proposes a command/patch → a pending approval record is created → user approves/denies → the saved tool call resumes.",
    "Cancellation: <font face='Courier'>POST /api/tasks/:id/cancel</font> aborts the AbortController, propagates to descendants, and flips queued/running work to <font face='Courier'>cancelled</font>.",
    "Duplicate cancellation is idempotent; already-terminal tasks return a structured 409; a late approval cannot revive cancelled work.",
    "Windows command cancellation uses <font face='Courier'>taskkill /F /T /PID</font> and is verified with a parent/child/grandchild process tree plus an unrelated survivor process.",
    "<font face='Courier'>/panic</font> stops all running work.",
]))

# ===== 9. PRIVACY & SECURITY ============================================
H("9. Privacy and security", 0)
story.append(P("Privacy is a user-visible product behavior, not only a backend policy. For "
               "every model request or tool action, Morrow can explain which model/service "
               "is involved, whether it is local or remote, what conversation content is "
               "included, which files and memories are included, which credentials are used "
               "(without exposing their values), which network destinations are permitted, "
               "and what will be retained afterward.", BODY))

H("9.1 Privacy modes", 1)
story.append(table([
    ["Mode", "Behavior"],
    ["Local only", "Local storage + local inference. No external providers, tools, or telemetry. Network-deny tests must pass."],
    ["Controlled cloud", "User-approved providers; request-by-request context disclosure; external destinations recorded; provider fallback cannot silently change privacy behavior."],
    ["Custom", "Per-project / per-agent rules, domain allowlists, model restrictions, retention controls, explicit exceptions."],
], [1.5 * inch, 5.4 * inch]))

H("9.2 Required safeguards", 1)
story.append(bullets([
    "No silent telemetry.",
    "No secret values in prompts or logs.",
    "No cross-project memory retrieval.",
    "No external provider fallback without disclosure.",
    "No plugin or skill access beyond declared capabilities.",
    "Automatic memory stores concise normalized conclusions and evidence references — never raw chain-of-thought; secret-like and prompt-poisoned candidates are rejected before admission.",
    "Automatically learned skills are project-scoped, need two distinct successful mission observations, and cannot request network access or secrets; invalid bundles are quarantined.",
    "Complete deletion for user-requested local data removal.",
    "Provider continuation fields needed for protocol correctness are access-restricted with task state, excluded from public events, logs, summaries, search, exports, and APIs, and never presented as model reasoning.",
]))

H("9.3 Data categories and retention", 1)
story.append(P("Data categories: conversation data, personal memory, project memory, agent "
               "memory, files/repository content, credentials and secret handles, tool "
               "outputs, usage and cost records, and execution history. Each requires an "
               "explicit scope and retention rule.", BODY))
story.append(P("Mission continuity retention: structured checkpoints contain concise "
               "decisions and execution facts, never hidden chain-of-thought. Full raw "
               "conversation, tool, and event records remain authoritative and are not "
               "destroyed by provider compaction. Deleting a task cascades its execution "
               "segments, provider turns, checkpoints, private continuation rows, and "
               "canonical answer.", BODY))

# ===== 10. MEMORY & CONTEXT =============================================
H("10. Memory and context management", 0)
H("10.1 Memory service", 1)
story.append(P("Morrow uses a deterministic, project-isolated, user-controlled SQLite "
               "memory layer — no hidden capture, no cross-project leakage. Automatic memory "
               "retrieval increments a local usage counter so influence remains auditable, "
               "and is limited to the current project/conversation scope. Expired, stale, "
               "invalidated, retired, disabled, and candidate records are excluded.", BODY))
story.append(P("In beta.31, automatic Cortex memory builds/refreshes at mission creation, "
               "captures only deterministic repository facts and evidence-backed mission "
               "learnings, and injects ranked active memory into later matching work without "
               "manual save/refresh/index commands.", BODY))

H("10.2 Context management", 1)
story.append(P("Agent model requests pass through the local context manager before provider "
               "execution. The manager resolves model-aware budgets, counts tokens with exact "
               "offline tokenizers where available (labeled conservative estimates elsewhere), "
               "preserves system instructions and tool-call groups, compacts older eligible "
               "history into redacted persisted summaries, and refuses provider calls when the "
               "minimum viable prompt cannot fit.", BODY))
story.append(P("Durable mission execution is segmented without replacing the task, mission, "
               "event, provider, or execution-kernel boundaries. Migration 32 adds execution "
               "segments, discrete provider turns, structured checkpoints, private provider "
               "continuations, and canonical task answers. A checkpoint, compaction, route "
               "change, restart, or turn-budget rollover cannot mark a task or mission "
               "complete.", BODY))

H("10.3 Symbol index", 1)
story.append(P("Project code intelligence uses a local symbol index rather than sending whole "
               "repositories to a model. The orchestrator scans only inside the registered "
               "project root, applies .gitignore / .morrowignore / dependency-build-cache "
               "ignores and secret-like path denial, then persists symbol metadata and parser "
               "diagnostics in SQLite. TS/JS/TSX/JSX symbols are extracted with the TypeScript "
               "compiler API; agent access is read-only through concise symbol locations.", BODY))

# ===== 11. TROUBLESHOOTING ==============================================
H("11. Troubleshooting and support", 0)
H("11.1 First-line diagnostics", 1)
story.append(code_block("""morrow --version
morrow status
morrow doctor          # consumer-readable
morrow doctor --json   # automation
morrow doctor --export # redacted diagnostic bundle"""))
story.append(P("<font face='Courier'>morrow doctor</font> does not start the service "
               "implicitly. A stopped or unhealthy service is reported with remediation and a "
               "non-zero exit code. JSON mode writes one stable JSON document to stdout. "
               "Diagnostic exports redact secret fields, credential-shaped values, and the "
               "user-home prefix.", BODY_SM))

H("11.2 Common situations", 1)
story.append(table([
    ["Situation", "What to do"],
    ["Broken Unicode glyphs in PowerShell", "Use Windows Terminal with a UTF-8 profile; rerun `morrow doctor`."],
    ["Health-failure rollback concern", "The installer performs an atomic, data-preserving swap; a corrupt package rolls back with data intact (covered by tests)."],
    ["Stuck task / cancellation", "Use /panic to stop all, or POST /api/tasks/:id/cancel. Late approvals cannot revive cancelled work."],
    ["Restart mid-task", "Recovery transitions running→interrupted and re-dispatches orphaned queued tasks; `morrow mission show` works across restarts."],
    ["Need a support bundle", "Use `morrow doctor --export` for a redacted diagnostic bundle (logs + versions + task state)."],
], [2.4 * inch, 4.5 * inch]))

H("11.3 Crash recovery", 1)
story.append(P("On boot, the orchestrator recovers running tasks (running→interrupted), "
               "interrupts streaming/queued messages, and emits a recovery signal. Startup "
               "reconciliation re-dispatches orphaned queued tasks, clears partial pre-running "
               "artifacts, and cancels queued children whose parent is already terminal. "
               "Recovery re-dispatch and subagent child re-dispatch are covered by tests.", BODY))

# ===== 12. KNOWN LIMITATIONS & ROADMAP ==================================
H("12. Known limitations and roadmap", 0)
H("12.1 Current alpha / beta limitations", 1)
story.append(bullets([
    "Live model discovery is not implemented; the model registry is built-in plus user-configurable model ids.",
    "Write and terminal tools are intentionally not enabled until full safety boundaries ship.",
    "Subscription sign-in is implemented for Claude (Anthropic) and Codex/ChatGPT (OpenAI) via first-party OAuth + PKCE, behind an explicit security/ToS warning; tokens stored locally; Gemini stays API-key only.",
    "macOS is not supported in beta.31; Linux is source-build only.",
    "Cost (spentUsd) is populated only when the provider reports usage priced by Morrow.",
    "browser and manual criteria require external observation and are not auto-verified; they stay unverified unless evidence is attached.",
]))
story.append(callout("Honest gaps (from verified testing)", "Known remaining engineering "
               "gaps include: no continuous onboarding→first-task thread yet proven; "
               "cancel/restart continuity needs interface-level acceptance; mid-stream "
               "reconnect/dedup after recovery; approval-after-restart path uses a direct "
               "status reset; no baseline-regression auto-block on writes; and apply-update "
               "automation is partial for the packaged build.", WARN_BG, WARN_BD, icon="!"))

H("12.2 Roadmap stages", 1)
story.append(P("Morrow's first milestone is a narrow, reliable vertical slice: open the web "
               "interface; create a project and submit a task; produce a visible plan; "
               "execute one safe tool inside a scoped workspace; stream progress and evidence; "
               "persist the task across a restart; and display model, cost, files, permissions, "
               "and external data sharing. Broad integrations are added only after this slice "
               "is reliable.", BODY))
story.append(table([
    ["Stage", "Focus"],
    ["Initial vertical slice", "Project → task → visible plan → one scoped tool → streaming → persistence → evidence."],
    ["Multi-provider alpha", "Provider-neutral runtime, presets/routing, read-only tools, truthful execution, project-isolated memory."],
    ["Durable autonomy (beta.31)", "Mission continuity across context limits, browser/vision, Cortex memory, model-truth, restart recovery, extended workloads."],
    ["Planned", "Desktop/web/CLI/remote experiences, write+terminal tools with safety boundaries, live model discovery, macOS."],
], [2.2 * inch, 4.7 * inch]))

# ===== 13. GLOSSARY & LEGAL =============================================
H("13. Glossary", 0)
story.append(table([
    ["Term", "Meaning"],
    ["Mission", "Morrow's unit of accountable work: defined success, supervised execution, evidence, review, honest grade."],
    ["Preset", "A routing policy (e.g. Balanced) that resolves a provider+model and discloses the decision."],
    ["Checkpoint", "A snapshot of affected file content taken before risky changes; the basis for rollback."],
    ["Evidence ledger", "The persisted set of verified evidence linked to mission criteria."],
    ["Containment layer", "Shared guard around read-only tools: rejects traversal, symlinks, secrets, binaries; enforces limits."],
    ["Cortex memory", "Automatic, project-scoped memory built from deterministic facts and evidence-backed learnings."],
    ["MORROW_HOME", "Local data root (Windows: %LOCALAPPDATA%\\Morrow\\data; Linux/macOS: ~/.morrow)."],
], [1.7 * inch, 5.2 * inch]))

H("13.1 Ownership and licensing", 1)
story.append(P("Copyright © 2026 Aidan Magee. All rights reserved. No open-source license has "
               "been granted at this stage. Licensing will be decided before a public release.",
               BODY))
H("13.2 Reporting issues", 1)
story.append(P("When reporting a problem, include the output of <font face='Courier'>morrow "
               "doctor --export</font> (which redacts secrets and your home prefix) along with "
               "the affected project and a description of what you expected versus what "
               "happened. Never paste API keys or credentials into issue reports.", BODY))

story.append(Spacer(1, 10))
story.append(HRFlowable(width="100%", thickness=0.6, color=colors.HexColor("#d7dee8"),
                        spaceBefore=4, spaceAfter=8))
story.append(P("End of manual — Morrow " + VERSION + ". This document reflects the product as "
               "verified in the repository at the beta.31 release. Capability claims are backed "
               "by tests or documented evidence; limitations are called out explicitly.",
               ParagraphStyle("end", parent=BODY_SM, alignment=TA_CENTER)))


# ---------------------------------------------------------------------------
# MultiBuild + TOC population
# ---------------------------------------------------------------------------
def build():
    doc = Manual(OUT, pagesize=LETTER,
                 leftMargin=0.85 * inch, rightMargin=0.85 * inch,
                 topMargin=0.85 * inch, bottomMargin=0.85 * inch,
                 title="Morrow User Manual", author="Aidan Magee",
                 subject=f"Morrow {VERSION} user manual")
    # First pass to collect TOC, then real build
    doc.multiBuild(story)
    print(f"Wrote {OUT}")
    from pypdf import PdfReader
    print("pages:", len(PdfReader(OUT).pages))


if __name__ == "__main__":
    build()
