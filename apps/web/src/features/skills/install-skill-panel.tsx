import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Plus, X } from "lucide-react";
import { useState } from "react";
import { ApiClientError } from "../../api/client.js";
import { skillApi, type SkillInstallPlan, type SkillInstallPreview } from "../../api/skills.js";

/**
 * Installing a skill from the Skills page.
 *
 * A skill is instructions Morrow will follow, so this is closer to granting a
 * capability than to adding a file, and the panel is built around making that
 * legible rather than quick. Looking and installing are two steps: the service
 * fetches, normalizes and stages the bundle and reports what it found, and
 * only then is there something to say yes to. What lands is that staged
 * bundle, so the summary below describes the actual bytes rather than a
 * re-fetch that could differ.
 *
 * Installing does not enable. The panel says so rather than leaving someone to
 * discover it, because "installed" reading as "running" is the assumption that
 * makes a skill store dangerous.
 */

function Permissions({ plan }: { plan: SkillInstallPlan }) {
  const rows: Array<[string, string[]]> = [
    ["Tools", plan.permissions.tools],
    ["Filesystem", plan.permissions.filesystemScopes],
    ["Network", plan.permissions.networkDomains],
    ["Secrets", plan.permissions.requiredSecrets],
  ];
  const asksForNothing = rows.every(([, values]) => values.length === 0);
  return (
    <>
      <dl className="morrow-dossier__facts">
        {rows.map(([label, values]) => (
          <div className="morrow-dossier__fact" key={label}>
            <dt>{label}</dt>
            <dd>{values.length ? values.join(", ") : "None"}</dd>
          </div>
        ))}
      </dl>
      {asksForNothing && plan.generatedMetadata.includes("permissions.json") ? (
        // Never let an empty permission list read as a vetted claim by the author.
        <p className="morrow-hint">
          This bundle declared no permissions, so Morrow applied its own least-privilege default.
        </p>
      ) : null}
    </>
  );
}

export function InstallSkillPanel() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<SkillInstallPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<{ key: string; id: string; enabled: boolean } | null>(null);

  const reset = (): void => {
    setPreview(null);
    setError(null);
    setInstalled(null);
  };

  const look = useMutation({
    mutationFn: (input: { source: string; subdir?: string | null; overwrite?: boolean }) =>
      skillApi.preview(input.source, { subdir: input.subdir ?? null, overwrite: input.overwrite ?? false }),
    onSuccess: (result) => { setPreview(result); setError(null); setInstalled(null); },
    onError: (cause: unknown) => {
      setPreview(null);
      setError(cause instanceof ApiClientError ? cause.message : "That source could not be read.");
    },
  });

  const apply = useMutation({
    mutationFn: (handle: string) => skillApi.install(handle),
    onSuccess: (result) => {
      setPreview(null);
      setError(null);
      setInstalled({ key: result.key, id: result.id, enabled: result.enabled });
      setSource("");
      void queryClient.invalidateQueries({ queryKey: ["skills", "installed"] });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiClientError ? cause.message : "That skill could not be installed.");
    },
  });

  /**
   * Enabling is offered, never assumed. The button is a second deliberate act
   * and reports the state the service actually recorded.
   */
  const enable = useMutation({
    mutationFn: (key: string) => skillApi.setEnabled(key, true),
    onSuccess: (result) => {
      setInstalled({ key: result.key, id: result.id, enabled: result.enabled });
      void queryClient.invalidateQueries({ queryKey: ["skills", "installed"] });
      void queryClient.invalidateQueries({ queryKey: ["skills", "status"] });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiClientError ? cause.message : "That skill could not be enabled.");
    },
  });

  const cancel = (): void => {
    // Release the staged bundle rather than leaving it for the service to age out.
    if (preview?.kind === "ready") void skillApi.discard(preview.handle).catch(() => {});
    reset();
  };

  if (!open) {
    return (
      <div className="morrow-section-head">
        <button className="morrow-button" onClick={() => setOpen(true)} type="button">
          <Plus aria-hidden="true" size={15} />
          Install a skill
        </button>
      </div>
    );
  }

  return (
    <section aria-labelledby="install-skill-heading" className="morrow-panel">
      <div className="morrow-section-head">
        <h2 id="install-skill-heading">Install a skill</h2>
        <button aria-label="Close" className="morrow-button" onClick={() => { cancel(); setOpen(false); }} type="button">
          <X aria-hidden="true" size={15} />
        </button>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (source.trim()) look.mutate({ source: source.trim() });
        }}
      >
        <label className="morrow-field">
          <span>Source</span>
          <input
            autoComplete="off"
            onChange={(event) => { setSource(event.target.value); reset(); }}
            placeholder="owner/repo, a github.com URL, or a folder path"
            type="text"
            value={source}
          />
        </label>
        <p className="morrow-hint">
          A GitHub repository (<code>owner/repo</code>, or <code>owner/repo@v1.2</code> to pin a tag),
          a link copied from GitHub, or a path to a folder or <code>.tar.gz</code> on this machine.
        </p>
        <button className="morrow-button" disabled={!source.trim() || look.isPending} type="submit">
          <Download aria-hidden="true" size={15} />
          {look.isPending ? "Reading…" : "Look at this skill"}
        </button>
      </form>

      {error ? <p role="alert">{error}</p> : null}
      {installed ? (
        installed.enabled ? (
          <p role="status">
            <strong>{installed.id}</strong> is installed and enabled.
          </p>
        ) : (
          <div role="status">
            <p>
              Installed <strong>{installed.id}</strong>. It stays switched off until you enable it.
            </p>
            <button
              className="morrow-button"
              disabled={enable.isPending}
              onClick={() => enable.mutate(installed.key)}
              type="button"
            >
              {enable.isPending ? "Enabling…" : "Enable now"}
            </button>
          </div>
        )
      ) : null}

      {preview?.kind === "choices" ? (
        <div>
          <p>{preview.source} holds {preview.candidates.length} skills. Choose one:</p>
          <ul className="morrow-library__list">
            {preview.candidates.map((candidate) => (
              <li key={candidate.subdir}>
                <button
                  className="morrow-library__row"
                  disabled={look.isPending}
                  onClick={() => look.mutate({ source: source.trim(), subdir: candidate.subdir })}
                  type="button"
                >
                  <span>{candidate.name}</span>
                  <span>{candidate.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview?.kind === "ready" ? (
        <div>
          <h3>{preview.plan.name}</h3>
          <dl className="morrow-dossier__facts">
            <div className="morrow-dossier__fact"><dt>Id</dt><dd>{preview.plan.id}</dd></div>
            <div className="morrow-dossier__fact"><dt>Version</dt><dd>{preview.plan.version}</dd></div>
            <div className="morrow-dossier__fact"><dt>From</dt><dd>{preview.plan.source}</dd></div>
            <div className="morrow-dossier__fact"><dt>Publisher</dt><dd>{preview.plan.publisher}</dd></div>
            <div className="morrow-dossier__fact"><dt>Risk</dt><dd>{preview.plan.riskClass}</dd></div>
            <div className="morrow-dossier__fact"><dt>Files</dt><dd>{preview.plan.files.length}</dd></div>
          </dl>
          {preview.plan.description ? <p>{preview.plan.description}</p> : null}

          <h4>What it asks for</h4>
          <Permissions plan={preview.plan} />

          {preview.plan.replaces ? (
            <p role="alert">This replaces the installed version {preview.plan.replaces}.</p>
          ) : null}
          {preview.plan.warnings.length > 0 ? (
            <ul aria-label="Warnings">
              {preview.plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          ) : null}

          <div className="morrow-actions">
            <button
              className="morrow-button morrow-button--primary"
              disabled={apply.isPending}
              onClick={() => apply.mutate(preview.handle)}
              type="button"
            >
              {apply.isPending ? "Installing…" : `Install ${preview.plan.id}`}
            </button>
            <button className="morrow-button" onClick={cancel} type="button">Cancel</button>
          </div>
          <p className="morrow-hint">Installing does not switch it on — you enable it afterwards.</p>
        </div>
      ) : null}
    </section>
  );
}
