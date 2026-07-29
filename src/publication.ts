/**
 * Public Publication API.
 *
 * Publication projects trusted personal Knowledge into deterministic public
 * artifacts. Private lineage stays in the local Release Record.
 */
export { buildPublication } from "./publication/build.ts";
export { buildPublicationRun, type PublicationBuildRunResult } from "./publication/workflow.ts";
export {
  type PublicationBuildOptions,
  type PublicationBuildResult,
  type PublicationBundle,
  type PublicationChannel,
  type PublicationManifest,
  type PublicationBuildRecord,
  type PublicKnowledgeEntry,
  type DailyCopilotMigrationManifest,
  type DailyCopilotMigrationEntry,
  type DailyCopilotDisposition,
  type DailyCopilotAttachmentDisposition,
} from "./publication/contracts.ts";
export { inspectPublicationEligibility, inspectPublicText } from "./publication/safety.ts";
