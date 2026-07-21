import type { WebMissionArtifact } from "@morrow/contracts";
import { ArtifactFrame } from "@morrow/ui";
import type { ReactNode } from "react";

type ArtifactHeadingLevel = 2 | 3 | 4 | 5 | 6;
type ArtifactRenderer = (
  artifact: WebMissionArtifact,
  headingLevel: ArtifactHeadingLevel,
) => ReactNode;

const artifactLabels: Record<WebMissionArtifact["kind"], string> = {
  browser_capture: "Browser capture",
  calendar: "Calendar",
  code_diff: "Code diff",
  data: "Data",
  document: "Document",
  email: "Email",
  file: "File",
  other: "Other artifact",
  source: "Source",
};

function artifactLabel(kind: string): string {
  return artifactLabels[kind as WebMissionArtifact["kind"]] ?? "Other artifact";
}

function artifactTitle(title: string): string {
  return title.trim() || "Untitled artifact";
}

function ArtifactMetadata({ artifact }: { artifact: WebMissionArtifact }) {
  return (
    <span>
      {artifactLabel(artifact.kind)} · {artifact.mimeType?.trim() || "Unknown format"} · Version{" "}
      {artifact.version}
    </span>
  );
}

function SafeTextPreview({
  preview,
  title,
}: Pick<WebMissionArtifact, "preview"> & { title: string }) {
  if (!preview?.trim()) {
    return <p className="morrow-artifact-preview__empty">No safe text preview is available.</p>;
  }

  return (
    <pre
      aria-label={`Text preview for ${title}`}
      className="morrow-artifact-preview"
      tabIndex={0}
    >
      {preview}
    </pre>
  );
}

function ArtifactShell({
  artifact,
  headingLevel,
}: {
  artifact: WebMissionArtifact;
  headingLevel: ArtifactHeadingLevel;
}) {
  const title = artifactTitle(artifact.title);

  return (
    <ArtifactFrame
      headingLevel={headingLevel}
      metadata={<ArtifactMetadata artifact={artifact} />}
      title={title}
    >
      <SafeTextPreview preview={artifact.preview} title={title} />
    </ArtifactFrame>
  );
}

function FileArtifact(artifact: WebMissionArtifact, headingLevel: ArtifactHeadingLevel) {
  return <ArtifactShell artifact={artifact} headingLevel={headingLevel} />;
}

function TextArtifact(artifact: WebMissionArtifact, headingLevel: ArtifactHeadingLevel) {
  return <ArtifactShell artifact={artifact} headingLevel={headingLevel} />;
}

function SourceArtifact(artifact: WebMissionArtifact, headingLevel: ArtifactHeadingLevel) {
  return <ArtifactShell artifact={artifact} headingLevel={headingLevel} />;
}

function DiffArtifact(artifact: WebMissionArtifact, headingLevel: ArtifactHeadingLevel) {
  return <ArtifactShell artifact={artifact} headingLevel={headingLevel} />;
}

function MetadataArtifact(artifact: WebMissionArtifact, headingLevel: ArtifactHeadingLevel) {
  return <ArtifactShell artifact={artifact} headingLevel={headingLevel} />;
}

const artifactRenderers: Record<WebMissionArtifact["kind"], ArtifactRenderer> = {
  browser_capture: MetadataArtifact,
  calendar: MetadataArtifact,
  code_diff: DiffArtifact,
  data: MetadataArtifact,
  document: TextArtifact,
  email: MetadataArtifact,
  file: FileArtifact,
  other: MetadataArtifact,
  source: SourceArtifact,
};

function ArtifactView({
  artifact,
  headingLevel,
}: {
  artifact: WebMissionArtifact;
  headingLevel: ArtifactHeadingLevel;
}) {
  const renderer = artifactRenderers[artifact.kind] ?? MetadataArtifact;
  return <>{renderer(artifact, headingLevel)}</>;
}

interface ArtifactListProps {
  artifacts: readonly WebMissionArtifact[];
  emptyMessage: string;
  headingLevel?: ArtifactHeadingLevel;
}

export function ArtifactList({
  artifacts,
  emptyMessage,
  headingLevel = 3,
}: ArtifactListProps) {
  if (artifacts.length === 0) {
    return <p className="morrow-artifact-list__empty">{emptyMessage}</p>;
  }

  return (
    <div className="morrow-artifact-list">
      {artifacts.map((artifact, index) => (
        <ArtifactView
          artifact={artifact}
          headingLevel={headingLevel}
          key={`${artifact.id}:${artifact.version}:${index}`}
        />
      ))}
    </div>
  );
}

export function WorkTab({ artifacts }: { artifacts: readonly WebMissionArtifact[] }) {
  return (
    <section aria-labelledby="mission-work-heading" className="morrow-mission-work">
      <h2 id="mission-work-heading">Work</h2>
      <ArtifactList
        artifacts={artifacts}
        emptyMessage="No mission artifacts are available yet."
        headingLevel={3}
      />
    </section>
  );
}
