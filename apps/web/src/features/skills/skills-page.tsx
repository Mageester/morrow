import { EmptyState, StatusPill } from "@morrow/ui";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { skillQueries, type InstalledSkill } from "../../api/skills.js";
import { useActiveProject } from "../projects/use-active-project.js";

function displayLearnedName(skill: { triggerConditions: string[] }): string {
  const command = skill.triggerConditions[0] ?? "project workflow";
  return `Validate with ${command}`;
}

function InstalledSkillRow({ skill, used }: { skill: InstalledSkill; used: number }) {
  return (
    <li className="morrow-skills__row">
      <details>
        <summary>
          <span className="morrow-skills__identity">
            <strong>{skill.name}</strong>
            <span>{skill.description}</span>
          </span>
          <span className="morrow-skills__meta">
            {used > 0 ? `Used ${used} time${used === 1 ? "" : "s"}` : skill.category}
          </span>
        </summary>
        <div className="morrow-skills__detail">
          <p>Morrow loads this automatically when a request matches its purpose.</p>
          <dl>
            <div><dt>Source</dt><dd>{skill.source}</dd></div>
            <div><dt>Trust</dt><dd>{skill.trustTier}</dd></div>
            <div><dt>Tools</dt><dd>{skill.tools.length ? skill.tools.join(", ") : "No extra tools"}</dd></div>
          </dl>
        </div>
      </details>
    </li>
  );
}

export function SkillsPage() {
  const { activeProject } = useActiveProject();
  const [query, setQuery] = useState("");
  const installed = useQuery(skillQueries.installed());
  const learned = useQuery({ ...skillQueries.learned(activeProject?.id ?? ""), enabled: Boolean(activeProject) });
  const usage = useQuery({ ...skillQueries.usage(activeProject?.id ?? ""), enabled: Boolean(activeProject) });
  const usageById = useMemo(() => new Map((usage.data ?? []).map((item) => [item.skillId, item.count])), [usage.data]);
  const normalizedQuery = query.trim().toLowerCase();
  const installedRows = (installed.data ?? []).filter((skill) =>
    !normalizedQuery || `${skill.name} ${skill.description} ${skill.category}`.toLowerCase().includes(normalizedQuery),
  );
  const learnedRows = (learned.data ?? []).filter((skill) =>
    !normalizedQuery || `${displayLearnedName(skill)} ${skill.steps.join(" ")} ${skill.triggerConditions.join(" ")}`.toLowerCase().includes(normalizedQuery),
  );

  return (
    <section aria-labelledby="skills-heading" className="morrow-page morrow-skills">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Procedural memory</p>
        <h1 id="skills-heading">Skills</h1>
        <p>Morrow learns reusable procedures from verified work and retrieves only the ones relevant to the task.</p>
      </div>

      <label className="morrow-skills__search">
        <Search aria-hidden="true" size={16} />
        <span className="morrow-visually-hidden">Search skills</span>
        <input onChange={(event) => setQuery(event.target.value)} placeholder="Search skills" type="search" value={query} />
      </label>

      {installed.isPending || (activeProject && learned.isPending) ? <p aria-live="polite" role="status">Loading skills…</p> : null}
      {installed.isError || learned.isError ? <p role="alert">Skills could not be loaded.</p> : null}

      {!installed.isPending && !learned.isPending && installedRows.length === 0 && learnedRows.length === 0 ? (
        <EmptyState
          description={normalizedQuery ? "No skill matches this search." : "Morrow learns reusable workflows as you complete and verify substantial work."}
          title={normalizedQuery ? "No matching skills" : "No skills yet"}
        />
      ) : (
        <div className="morrow-skills__sections">
          {learnedRows.length > 0 ? (
            <section aria-labelledby="learned-skills-heading">
              <div className="morrow-section-head">
                <h2 id="learned-skills-heading">Learned here</h2>
                <span>{activeProject?.name}</span>
              </div>
              <ul className="morrow-skills__list">
                {learnedRows.map((skill) => (
                  <li className="morrow-skills__row" key={skill.id}>
                    <details>
                      <summary>
                        <span className="morrow-skills__identity">
                          <strong>{displayLearnedName(skill)}</strong>
                          <span>{skill.state === "active" ? "Verified reusable workflow" : "Learning from successful work"}</span>
                        </span>
                        <span className="morrow-skills__meta">
                          <StatusPill variant={skill.state === "active" ? "success" : skill.state === "candidate" ? "accent" : "neutral"}>{skill.state.replaceAll("_", " ")}</StatusPill>
                          {skill.successCount} verified use{skill.successCount === 1 ? "" : "s"}
                        </span>
                      </summary>
                      <div className="morrow-skills__detail">
                        <h3>Procedure</h3>
                        <ol>{skill.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                        <dl>
                          <div><dt>Version</dt><dd>{skill.version}</dd></div>
                          <div><dt>Evidence</dt><dd>{skill.provenance.length} verified task{skill.provenance.length === 1 ? "" : "s"}</dd></div>
                          <div><dt>Network</dt><dd>{skill.permissions.networkDomains.length ? skill.permissions.networkDomains.join(", ") : "None"}</dd></div>
                          <div><dt>Secrets</dt><dd>{skill.permissions.requiredSecrets.length ? skill.permissions.requiredSecrets.join(", ") : "None"}</dd></div>
                        </dl>
                        {skill.rollbackHistory.length > 0 ? (
                          <div><h3>Recent improvements</h3><ul>{skill.rollbackHistory.map((item) => <li key={`${item.at}-${item.version}`}>{item.reason}</li>)}</ul></div>
                        ) : null}
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {installedRows.length > 0 ? (
            <section aria-labelledby="installed-skills-heading">
              <div className="morrow-section-head"><h2 id="installed-skills-heading">Available</h2></div>
              <ul className="morrow-skills__list">
                {installedRows.map((skill) => <InstalledSkillRow key={skill.id} skill={skill} used={usageById.get(skill.id) ?? 0} />)}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </section>
  );
}
