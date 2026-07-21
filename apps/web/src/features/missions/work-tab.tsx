import type { WebMissionArtifact } from "@morrow/contracts";
import { ArtifactFrame } from "@morrow/ui";
import type { ReactNode } from "react";

type ArtifactRenderer = (artifact: WebMissionArtifact) => ReactNode;

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

function ArtifactMetadata({ artifact }: { artifact: WebMissionArtifact }) {
  return (
    <span>
      {artifactLabel(artifact.kind)} · {artifact.mimeType?.trim() || "Unknown format"} · Version{" "}
      {artifact.version}
    </span>
  );
}

function SafeTextPreview({ preview }: Pick<WebMissionArtifact, "preview">) {
  if (!preview?.trim()) {
    return <p className="morrow-artifact-preview__empty">No safe text preview is available.</p>;
  }

  return <pre className="morrow-artifact-preview">{preview}</pre>;
}

function ArtifactShell({ artifact }: { artifact: WebMissionArtifact }) {
  return (
    <ArtifactFrame
      headingLevel={3}
      metadata={<ArtifactMetadata artifact={artifact} />}
      title={artifact.title}
    >
      <SafeTextPreview preview={artifact.preview} />
    </ArtifactFrame>
  );
}

function FileArtifact(artifact: WebMissionArtifact) {
  return <ArtifactShell artifact={artifact} />;
}

function TextArtifact(artifact: WebMissionArtifact) {
  return <ArtifactShell artifact={artifact} />;
}

function SourceArtifact(artifact: WebMissionArtifact) {
  return <ArtifactShell artifact={artifact} />;
}

function DiffArtifact(artifact: WebMissionArtifact) {
  return <ArtifactShell artifact={artifact} />;
}

function MetadataArtifact(artifact: WebMissionArtifact) {
  return <ArtifactShell artifact={artifact} />;
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

function ArtifactView({ artifact }: { artifact: WebMissionArtifact }) {
  const renderer = artifactRenderers[artifact.kind] ?? MetadataArtifact;
  return <>{renderer(artifact)}</>;
}

interface ArtifactListProps {
  artifacts: readonly WebMissionArtifact[];
  emptyMessage: string;
}

export function ArtifactList({ artifacts, emptyMessage }: ArtifactListProps) {
  if (artifacts.length === 0) {
    return <p className="morrow-artifact-list__empty">{emptyMessage}</p>;
  }

  return (
    <div className="morrow-artifact-list">
      {artifacts.map((artifact) => (
        <ArtifactView artifact={artifact} key={artifact.id} />
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
      />
    </section>
  );
}
