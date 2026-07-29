export type PublicationChannel = "personal-github" | "daily-copilot";

export interface PublicationBuildOptions {
  channel: PublicationChannel;
  knowledgeIds?: string[];
  dailyCopilotMigration?: DailyCopilotMigrationManifest;
}

export interface PublicKnowledgeEntry {
  public_id: string;
  title: string;
  type: string;
  category: string;
  product_type: string;
  summary: string;
  tags: string[];
  questions_answered: string[];
  applicability: string;
  boundary: string;
  use_when: string;
  use_inputs: string[];
  use_outputs: string[];
  use_steps: string[];
  use_checks: string[];
  use_stop_conditions: string[];
  valid_from: string;
  temporal_state: string;
  content_markdown: string;
  content_hash: string;
}

export interface PublicationBundle {
  schema_version: "ikb-personal-publication.v1";
  entries: PublicKnowledgeEntry[];
}

export interface PublicationManifestEntry {
  public_id: string;
  title: string;
  category: string;
  tags: string[];
  path: string;
  content_hash: string;
  legacy_id?: number;
  attachment_disposition?: DailyCopilotAttachmentDisposition;
}

export interface PublicationManifest {
  schema_version: "ikb-personal-publication-manifest.v1" | "ikb-daily-copilot-manifest.v1";
  channel: PublicationChannel;
  bundle_hash: string;
  entries: PublicationManifestEntry[];
  expected_legacy_ids?: number[];
  omitted_legacy_ids?: number[];
  categories?: DailyCopilotCategory[];
  migration_hash?: string;
}

export type DailyCopilotDisposition = "publish" | "skip" | "private_rewrite";
export type DailyCopilotAttachmentDisposition = "none" | "removed_unlicensed";

export interface DailyCopilotMigrationEntry {
  legacy_id: number;
  disposition: DailyCopilotDisposition;
  knowledge_id?: string;
  title?: string;
  category?: string;
  attachment_disposition: DailyCopilotAttachmentDisposition;
  reason_code: string;
}

export interface DailyCopilotMigrationManifest {
  schema_version: "ikb-daily-copilot-migration.v1";
  source_snapshot: string;
  expected_legacy_ids: number[];
  category_order: string[];
  category_icons: Record<string, string>;
  entries: DailyCopilotMigrationEntry[];
}

export interface DailyCopilotCategory {
  name: string;
  icon: string;
}

export interface DailyCopilotPublicMapping {
  legacy_id: number;
  public_id: string;
  title?: string;
  category?: string;
  attachment_disposition: DailyCopilotAttachmentDisposition;
  reason_code: string;
}

export interface PublicationBuildRecord {
  schemaVersion: "ikb-publication-build-record.v1";
  releaseId: string;
  channel: PublicationChannel;
  state: "built";
  bundleHash: string;
  outputHash: string;
  knowledge: Array<{
    publicId: string;
    knowledgeId: string;
    knowledgePath: string;
    sourceRefs: string[];
    compilationRef: string;
  }>;
  builtAt: string;
}

export interface PublicationBuildResult {
  releaseId: string;
  channel: PublicationChannel;
  releaseDir: string;
  bundlePath: string;
  outputDir: string;
  buildRecordPath: string;
  bundleHash: string;
  outputHash: string;
  entryCount: number;
  reused: boolean;
}
