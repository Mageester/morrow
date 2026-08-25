import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { skillApi, type SkillInstallPlan } from "../../api/skills.js";
import { InstallSkillPanel } from "./install-skill-panel.js";

const PLAN: SkillInstallPlan = {
  id: "release-notes",
  name: "Release Notes",
  version: "1.0.0",
  description: "Draft release notes from a changelog.",
  publisher: "github:acme",
  riskClass: "medium",
  source: "github:acme/skills@main",
  checksum: "a".repeat(64),
  permissions: { tools: [], filesystemScopes: [], networkDomains: [], requiredSecrets: [] },
  files: [{ path: "SKILL.md", bytes: 120 }],
  generatedMetadata: ["manifest.json", "permissions.json"],
  replaces: null,
  warnings: ['Installed from the moving ref "main"; pin a tag or commit for a reproducible install'],
};

function renderPanel() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <InstallSkillPanel />
    </QueryClientProvider>,
  );
}

async function openAndLookUp(source = "acme/skills") {
  const user = userEvent.setup();
  renderPanel();
  await user.click(screen.getByRole("button", { name: /install a skill/i }));
  await user.type(screen.getByLabelText(/source/i), source);
  await user.click(screen.getByRole("button", { name: /look at this skill/i }));
  return user;
}

/**
 * The panel's job is consent, not convenience. What matters is that a person
 * sees what they are agreeing to — provenance, what it asks for, and which
 * metadata Morrow invented — and that looking at a skill never installs one.
 */
describe("InstallSkillPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows provenance and permissions, and installs nothing until asked", async () => {
    const preview = vi.spyOn(skillApi, "preview").mockResolvedValue({ kind: "ready", plan: PLAN, handle: "handle-1" });
    const install = vi.spyOn(skillApi, "install").mockResolvedValue({ id: "release-notes", directory: "/home/skills/release-notes", enabled: false });

    const user = await openAndLookUp();

    await waitFor(() => expect(screen.getByText("github:acme/skills@main")).toBeInTheDocument());
    expect(preview).toHaveBeenCalledWith("acme/skills", { subdir: null, overwrite: false });
    // Reading a source must never be an install.
    expect(install).not.toHaveBeenCalled();
    expect(screen.getByText(/moving ref/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /install release-notes/i }));
    await waitFor(() => expect(install).toHaveBeenCalledWith("handle-1"));
  });

  /**
   * An empty permission list is Morrow's least-privilege default when a bundle
   * ships none, not a vetted claim by its author, and the difference decides
   * how much the list is worth trusting.
   */
  it("says when it invented the permissions rather than reading them", async () => {
    vi.spyOn(skillApi, "preview").mockResolvedValue({ kind: "ready", plan: PLAN, handle: "handle-1" });
    await openAndLookUp();
    await waitFor(() => expect(screen.getByText(/least-privilege default/i)).toBeInTheDocument());
  });

  it("does not let installed read as enabled", async () => {
    vi.spyOn(skillApi, "preview").mockResolvedValue({ kind: "ready", plan: PLAN, handle: "handle-1" });
    vi.spyOn(skillApi, "install").mockResolvedValue({ id: "release-notes", directory: "/home/skills/release-notes", enabled: false });

    const user = await openAndLookUp();
    await waitFor(() => expect(screen.getByRole("button", { name: /install release-notes/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /install release-notes/i }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/stays switched off/i));
  });

  it("offers the choice when a source holds several skills", async () => {
    const preview = vi.spyOn(skillApi, "preview").mockResolvedValue({
      kind: "choices",
      source: "github:acme/skills@HEAD",
      candidates: [
        { subdir: "skills/alpha", id: "alpha", name: "Alpha", description: "One." },
        { subdir: "skills/beta", id: "beta", name: "Beta", description: "Two." },
      ],
    });

    const user = await openAndLookUp();
    await waitFor(() => expect(screen.getByText("Beta")).toBeInTheDocument());

    preview.mockResolvedValue({ kind: "ready", plan: { ...PLAN, id: "beta", name: "Beta" }, handle: "handle-2" });
    await user.click(screen.getByRole("button", { name: /Beta/ }));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith("acme/skills", { subdir: "skills/beta", overwrite: false }));
  });

  it("releases the staged bundle when the install is cancelled", async () => {
    vi.spyOn(skillApi, "preview").mockResolvedValue({ kind: "ready", plan: PLAN, handle: "handle-1" });
    const discard = vi.spyOn(skillApi, "discard").mockResolvedValue(undefined);

    const user = await openAndLookUp();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Cancel$/ })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^Cancel$/ }));

    expect(discard).toHaveBeenCalledWith("handle-1");
  });

  it("reports a refusal from the service instead of failing silently", async () => {
    vi.spyOn(skillApi, "preview").mockRejectedValue(new Error("nope"));
    await openAndLookUp("not-a-source");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be read/i));
  });
});
