import type { LearnedSkill } from "@morrow/contracts";
import { EmptyState } from "@morrow/ui";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { skillQueries, type InstalledSkill } from "../../api/skills.js";
import { ProductHeader } from "../../components/product-frame.js";
import { useActiveProject } from "../projects/use-active-project.js";

function displayLearnedName(skill: { triggerConditions: string[] }): string {
  const command = skill.triggerConditions[0] ?? "project workflow";
  return `Validate with ${command}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "Not yet";
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  } catch {
    return "Not yet";
  }
}

type SkillSelection =
  | { key: string; kind: "learned"; skill: LearnedSkill }
  | { key: string; kind: "installed"; skill: InstalledSkill; used: number };

function SkillRow({ item, selected, onSelect }: { item: SkillSelection; selected: boolean; onSelect: () => void }) {
  const name = item.kind === "learned" ? displayLearnedName(item.skill) : item.skill.name;
  const description = item.kind === "learned"
    ? item.skill.state === "active" ? "Verified reusable workflow" : "Learning from successful work"
    : item.skill.description;
  const state = item.kind === "learned"
    ? item.skill.state === "active" ? "Proven" : item.skill.state.replaceAll("_", " ")
    : item.used > 0 ? `Used ${item.used} time${item.used === 1 ? "" : "s"}` : item.skill.category;

  return (
    <li>
      <button
        aria-current={selected ? "true" : undefined}
        className="morrow-library__row"
        data-lead="signature"
        onClick={onSelect}
        type="button"
      >
        <span aria-hidden="true" className="morrow-editorial-row__signature">{name.slice(0, 1).toUpperCase()}</span>
        <span>
          <b>{name}</b>
          <p>{description}</p>
        </span>
        <span className="morrow-library__scope" data-tone={item.kind === "learned" && item.skill.state === "active" ? "proven" : undefined}>{state}</span>
      </button>
    </li>
  );
}

function SkillDossier({ item }: { item: SkillSelection }) {
  if (item.kind === "installed") {
    return (
      <aside aria-live="polite" className="morrow-dossier" data-selected="true">
        <p className="morrow-dossier__tag">Available skill · {item.skill.trustTier}</p>
        <h2>{item.skill.name}</h2>
        <div className="morrow-dossier__quote">{item.skill.description}</div>
        <dl className="morrow-dossier__facts">
          <div className="morrow-dossier__fact"><dt>Source</dt><dd>{item.skill.source}</dd></div>
          <div className="morrow-dossier__fact"><dt>Trust</dt><dd>{item.skill.trustTier}</dd></div>
          <div className="morrow-dossier__fact"><dt>Tools</dt><dd>{item.skill.tools.length ? item.skill.tools.join(", ") : "No extra tools"}</dd></div>
          <div className="morrow-dossier__fact"><dt>Used here</dt><dd>{item.used} time{item.used === 1 ? "" : "s"}</dd></div>
        </dl>
        <div className="morrow-dossier__trust"><span>✓</span><span>Morrow loads this only when a request matches its declared purpose.</span></div>
      </aside>
    );
  }

  const skill = item.skill;
  return (
    <aside aria-live="polite" className="morrow-dossier" data-selected="true">
      <p className="morrow-dossier__tag">Selected skill · {skill.state === "active" ? "Proven" : skill.state.replaceAll("_", " ")}</p>
      <h2>{displayLearnedName(skill)}</h2>
      <div className="morrow-dossier__metrics">
        <div className="morrow-dossier__metric"><b>{skill.successCount}</b><span>verified uses</span></div>
        <div className="morrow-dossier__metric"><b>{Math.round(skill.confidence * 100)}%</b><span>confidence</span></div>
        <div className="morrow-dossier__metric"><b>{formatDate(skill.lastVerifiedAt)}</b><span>last verified</span></div>
      </div>
      <ol className="morrow-dossier__steps">{skill.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      <dl className="morrow-dossier__facts">
        <div className="morrow-dossier__fact"><dt>Version</dt><dd>{skill.version}</dd></div>
        <div className="morrow-dossier__fact"><dt>Evidence</dt><dd>{skill.provenance.length} verified task{skill.provenance.length === 1 ? "" : "s"}</dd></div>
        <div className="morrow-dossier__fact"><dt>Network</dt><dd>{skill.permissions.networkDomains.length ? skill.permissions.networkDomains.join(", ") : "None"}</dd></div>
        <div className="morrow-dossier__fact"><dt>Secrets</dt><dd>{skill.permissions.requiredSecrets.length ? skill.permissions.requiredSecrets.join(", ") : "None"}</dd></div>
      </dl>
      <div className="morrow-dossier__trust"><span>✓</span><span>Learned from verified Morrow work. Activation remains evidence-gated.</span></div>
    </aside>
  );
}

export function SkillsPage() {
  const { activeProject } = useActiveProject();
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const installed = useQuery(skillQueries.installed());
  const learned = useQuery({ ...skillQueries.learned(activeProject?.id ?? ""), enabled: Boolean(activeProject) });
  const usage = useQuery({ ...skillQueries.usage(activeProject?.id ?? ""), enabled: Boolean(activeProject) });
  const usageById = useMemo(() => new Map((usage.data ?? []).map((item) => [item.skillId, item.count])), [usage.data]);
  const normalizedQuery = query.trim().toLowerCase();
  const installedRows = (installed.data ?? []).filter((skill) => !normalizedQuery || `${skill.name} ${skill.description} ${skill.category}`.toLowerCase().includes(normalizedQuery));
  const learnedRows = (learned.data ?? []).filter((skill) => !normalizedQuery || `${displayLearnedName(skill)} ${skill.steps.join(" ")} ${skill.triggerConditions.join(" ")}`.toLowerCase().includes(normalizedQuery));
  const items: SkillSelection[] = [
    ...learnedRows.map((skill) => ({ key: `learned:${skill.id}`, kind: "learned" as const, skill })),
    ...installedRows.map((skill) => ({ key: `installed:${skill.id}`, kind: "installed" as const, skill, used: usageById.get(skill.id) ?? 0 })),
  ];
  const selected = items.find((item) => item.key === selectedKey) ?? items[0] ?? null;

  return (
    <section aria-labelledby="skills-heading" className="morrow-page morrow-skills">
      <ProductHeader
        action={(
          <label className="morrow-premium-search">
            <Search aria-hidden="true" size={15} />
            <span className="morrow-visually-hidden">Search skills</span>
            <input onChange={(event) => setQuery(event.target.value)} placeholder="Search skills" type="search" value={query} />
          </label>
        )}
        description="The methods Morrow can repeat reliably—proven, inspectable, and under your control."
        eyebrow="Learned capabilities"
        headingId="skills-heading"
        title="Skills"
      />

      {installed.isPending || (activeProject && learned.isPending) ? <p aria-live="polite" role="status">Loading skills…</p> : null}
      {installed.isError || learned.isError ? <p role="alert">Skills could not be loaded.</p> : null}

      {!installed.isPending && !learned.isPending && items.length === 0 ? (
        <EmptyState description={normalizedQuery ? "No skill matches this search." : "Morrow learns reusable workflows as you complete and verify substantial work."} title={normalizedQuery ? "No matching skills" : "No skills yet"} />
      ) : selected ? (
        <>
          <div className="morrow-split-library">
            <section aria-label="Capability cabinet" className="morrow-library">
              {learnedRows.length > 0 ? (
                <>
                  <div className="morrow-section-head morrow-library__heading"><h2>Learned here</h2><span>{activeProject?.name}</span></div>
                  <ul className="morrow-library__list">{items.filter((item) => item.kind === "learned").map((item) => <SkillRow item={item} key={item.key} onSelect={() => setSelectedKey(item.key)} selected={selected.key === item.key} />)}</ul>
                </>
              ) : null}
              {installedRows.length > 0 ? (
                <>
                  <h2 className="morrow-library__group">Capability cabinet</h2>
                  <ul className="morrow-library__list">{items.filter((item) => item.kind === "installed").map((item) => <SkillRow item={item} key={item.key} onSelect={() => setSelectedKey(item.key)} selected={selected.key === item.key} />)}</ul>
                </>
              ) : null}
            </section>
            <SkillDossier item={selected} />
          </div>
          <aside className="morrow-principle"><b>Skills are craftsmanship, not plugin clutter.</b><span>Each capability carries a method, permission boundary, and visible proof.</span></aside>
        </>
      ) : null}
    </section>
  );
}
