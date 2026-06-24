import { useState, useEffect } from "react";
import * as I from "../icons";
import { apiClient } from "../api/client";
import type { SkillRecord } from "../api/client";

type TrustTier = "core" | "controlled" | "experimental";

type Skill = SkillRecord;

const TRUST_TIER_LABELS: Record<string, string> = { core: "Core", controlled: "Controlled", experimental: "Experimental" };
const TRUST_TIER_COLORS: Record<string, string> = { core: "var(--green)", controlled: "var(--accent)", experimental: "var(--amber)" };
const VALIDATION_LABELS: Record<string, string> = {
  healthy: "Healthy", warning: "Warning", invalid: "Invalid", incompatible: "Incompatible",
  disabled: "Disabled", unavailable: "Unavailable", permission_blocked: "Permission Blocked"
};
const VALIDATION_COLORS: Record<string, string> = {
  healthy: "var(--green)", warning: "var(--amber)", invalid: "var(--red)", incompatible: "var(--red)",
  disabled: "var(--text-3)", unavailable: "var(--text-3)", permission_blocked: "var(--amber)"
};

export function SkillsControlCenter() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // Filters
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [validationFilter, setValidationFilter] = useState<string>("all");
  const [enabledFilter, setEnabledFilter] = useState<string>("all");
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [skillStates, setSkillStates] = useState<Map<string, boolean>>(new Map());

  // Load skills from backend
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await apiClient.listSkills();
        if (cancelled) return;
        if (data.length > 0) {
          setSkills(data);
          setSkillStates(new Map(data.map(s => [s.id, s.enabled])));
        } else {
          // Backend returned empty — registry unavailable
          setLoadError("The local skill registry has not reported any records. The Skills Control Center is a preview.");
        }
      } catch {
        if (!cancelled) {
          setLoadError("Cannot reach the local skill registry. The Skills Control Center is a preview.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const categories = skills.length > 0 ? [...new Set(skills.map(s => s.category))] : [];
  const trustTiers: TrustTier[] = ["core", "controlled", "experimental"];
  const validationStates: string[] = ["healthy", "warning", "invalid", "incompatible", "disabled", "unavailable", "permission_blocked"];

  const filtered = skills.filter(s => {
    if (search) {
      const q = search.toLowerCase();
      if (!s.name.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q) && !s.id.toLowerCase().includes(q)) return false;
    }
    if (categoryFilter !== "all" && s.category !== categoryFilter) return false;
    if (tierFilter !== "all" && s.trustTier !== tierFilter) return false;
    if (validationFilter !== "all" && s.validation !== validationFilter) return false;
    const enabled = skillStates.get(s.id) ?? s.enabled;
    if (enabledFilter === "enabled" && !enabled) return false;
    if (enabledFilter === "disabled" && enabled) return false;
    return true;
  });

  const toggleSkill = (skillId: string) => {
    setSkillStates(prev => {
      const next = new Map(prev);
      const current = next.get(skillId) ?? true;
      next.set(skillId, !current);
      return next;
    });
  };

  const isEnabled = (skill: Skill) => skillStates.get(skill.id) ?? skill.enabled;

  // ── Unavailable state ─────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div className="topbar"><h1>Skills Control Center (Preview)</h1></div>
        <div className="empty" style={{ minHeight: 300 }}>
          <p className="loading-pulse">Loading skill registry…</p>
        </div>
      </div>
    );
  }

  if (loadError || skills.length === 0) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div className="topbar"><h1>Skills Control Center (Preview)</h1></div>
        <div style={{ flex: 1, overflow: "auto", padding: "0 22px 22px" }}>
          <div className="card" style={{ marginBottom: 20, borderColor: "rgba(240,180,41,0.3)", background: "var(--amber-soft)", maxWidth: 680, margin: "0 auto" }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 15, color: "var(--amber)" }}>Skill Registry Preview</h3>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-2)", lineHeight: 1.6 }}>
              {loadError || "No local skill registry records are available."}
            </p>
            <div style={{ marginTop: 16, padding: "12px 14px", background: "var(--bg-elev)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" }}>
              <h4 style={{ margin: "0 0 8px", fontSize: 12, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>What this means</h4>
              <ul className="bullet-list" style={{ gap: 4 }}>
                <li>No installed, enabled, healthy, or live skills are assumed.</li>
                <li>When available, this screen will display only records returned by the local registry.</li>
              </ul>
            </div>
            <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => {
              setLoading(true); setLoadError("");
              apiClient.listSkills().then(d => {
                setSkills(d); setLoading(false);
              }).catch(() => {
                setLoadError("Cannot reach skill registry.");
                setLoading(false);
              });
            }}>
              <I.IconRefresh className="ico" style={{ width: 14, height: 14 }} /> Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Normal state (skills loaded from backend) ─────────────────────────
  return (
    <div className="skills-cc" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className="topbar">
        <h1>Skills Control Center (Preview)</h1>
        <div className="spacer" />
        <span className="meta-chip" style={{ color: "var(--text-3)", fontSize: 12 }}>
          {skills.length} registry record{skills.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="toolbar" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="search" style={{ flex: "0 0 280px" }}>
          <I.IconSearch className="ico" />
          <input placeholder="Search skills…" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search skills" />
        </div>
        {categories.length > 0 && (
          <label className="select">
            <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} aria-label="Filter by category">
              <option value="all">All Categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        )}
        <label className="select">
          <select value={tierFilter} onChange={e => setTierFilter(e.target.value)} aria-label="Filter by trust tier">
            <option value="all">All Tiers</option>
            {trustTiers.map(t => <option key={t} value={t}>{TRUST_TIER_LABELS[t] || t}</option>)}
          </select>
        </label>
        <label className="select">
          <select value={validationFilter} onChange={e => setValidationFilter(e.target.value)} aria-label="Filter by validation state">
            <option value="all">All States</option>
            {validationStates.map(v => <option key={v} value={v}>{VALIDATION_LABELS[v] || v}</option>)}
          </select>
        </label>
        <label className="select">
          <select value={enabledFilter} onChange={e => setEnabledFilter(e.target.value)} aria-label="Filter by enabled state">
            <option value="all">All</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
      </div>

      <div className="table-wrap">
        {filtered.length === 0 ? (
          <div className="empty" style={{ minHeight: 300 }}>
            <I.IconSearch className="empty-ico" />
            <h3>No skills match</h3>
            <p>Try adjusting your filters.</p>
          </div>
        ) : (
          <div className="skills-grid">
            {filtered.map(skill => (
              <div
                key={skill.id}
                className={`skill-card ${selectedSkill?.id === skill.id ? "selected" : ""} ${isEnabled(skill) ? "enabled" : "disabled"}`}
                onClick={() => setSelectedSkill(selectedSkill?.id === skill.id ? null : skill)}
                role="button" tabIndex={0}
                aria-label={`${skill.name} — ${VALIDATION_LABELS[skill.validation] || skill.validation}`}
                onKeyDown={e => { if (e.key === "Enter") setSelectedSkill(selectedSkill?.id === skill.id ? null : skill); }}
              >
                <div className="skill-card-row">
                  <div className="skill-card-left">
                    <span className="skill-name">{skill.name}</span>
                    <span className="skill-desc">{skill.description}</span>
                  </div>
                  <div className="skill-card-right">
                    <label className="toggle-switch" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={isEnabled(skill)} onChange={() => toggleSkill(skill.id)} aria-label={`Toggle ${skill.name}`} />
                      <span className="toggle-track" />
                    </label>
                  </div>
                </div>
                <div className="skill-card-meta">
                  <span className="skill-tier" style={{ color: TRUST_TIER_COLORS[skill.trustTier] || "var(--text-3)" }}>
                    {TRUST_TIER_LABELS[skill.trustTier] || skill.trustTier}
                  </span>
                  <span className="skill-validation" style={{ color: VALIDATION_COLORS[skill.validation] || "var(--text-3)" }}>
                    <span className="dot" style={{ background: VALIDATION_COLORS[skill.validation] || "var(--text-3)" }} />
                    {VALIDATION_LABELS[skill.validation] || skill.validation}
                  </span>
                  {skill.category && <span className="skill-category-tag">{skill.category}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
