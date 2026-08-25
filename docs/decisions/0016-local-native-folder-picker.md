# ADR 0016: Local native folder picker for project registration

**Status:** Accepted

## Context

The local web app previously required users to type an absolute workspace path
when creating a project. A browser folder picker cannot provide that absolute
path to the local orchestrator, so it cannot safely complete project
registration on its own.

## Decision

The project page exposes a **Choose folder** action backed by a loopback API
route. The orchestrator invokes a platform-native folder dialog using static,
non-shell command arguments, then returns the selected folder path and a
derived display name. The existing project form remains the final registration
step, and manual path entry remains available as a fallback.

The server validates that the dialog result is an accessible directory and
canonicalizes it before returning it. Project creation continues to use the
existing canonicalization and workspace-boundary checks.

## Security and privacy

- The route is protected by the existing local request guard; it accepts no
  caller-provided command, executable, or path argument.
- The picker commands are fixed per supported platform and run without a shell.
- A cancelled dialog returns an empty selection and does not create a project.
- The selected path stays on the local Morrow service boundary. No folder
  contents are uploaded or inspected by the picker.

## Consequences

- Linux uses `zenity`, `kdialog`, or `yad`; Windows uses PowerShell's native
  folder dialog; macOS uses `osascript`. If no supported picker is installed,
  Morrow reports the limitation and preserves manual entry.
- The bridge is intentionally local and synchronous from the user's point of
  view: the form waits while the native dialog is open.
- Automated tests inject the picker runner and do not open a real desktop
  dialog.
