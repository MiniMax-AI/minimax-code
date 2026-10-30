/**
 * Product rollout policy; unknown environments fail closed, independent of user preferences.
 *
 * Source provenance is currently disabled in every environment (including
 * Electron internal, Web/Native non-production, and Cloud LOCAL/TEST) while we
 * investigate runtime main-thread stalls suspected to be triggered by the
 * provenance pipeline. Callers keep passing their build identity so the
 * previous per-environment policy can be restored by reverting this function.
 */
export function resolveSourceProvenanceEnabled(_input: {
  platform?: string;
  internalBuild?: boolean;
  insideBuild?: boolean;
  /** Renderer MODE for Web/Native; INFRA_ENV for Cloud Runtime. */
  environment?: string;
}): boolean {
  return false;
}

/**
 * Remove only our managed citation sections, including older Apollo snapshots.
 * Ordinary citation guidance and user-authored headings without protocol markers stay intact.
 * Run before prompt ranges are assembled; never rewrite stored messages or tool output.
 */
export function omitManagedSourceCitationInstructions(prompt: string): string {
  // Stop at the managed block's own terminator, not the next heading: injected
  // cron/memory instructions may follow it without a Markdown heading.
  return prompt
    .replace(
      /^#{2,4} MCP\/App citation examples\r?\n\r?\n```\r?\n[\s\S]*?^```\r?\n\s*/gm,
      (section) => (section.includes('#mavis-source=') ? '' : section),
    )
    .replace(
      /^#{2,4} Citations\r?\n(?:[ \t]*\r?\n)*Cite every used result where it supports the answer\.[\s\S]*?^Do not cite unused calls or unsupported claims, invent metadata, output bare parenthesized links, or add trailing source\/reference lists\.\r?\n*/gm,
      (section) => (section.includes('Citation candidate') ? '' : section),
    );
}

/** Provide ordinary references for built-in prompts while the source protocol is disabled. */
export function restoreLegacyFileReferenceInstructions(prompt: string): string {
  const toolAnchors = [
    '- Independent tool calls can run in parallel in one response.',
    "- Issue independent tool calls together when safe. Run dependent calls or conflicting writes sequentially, and follow each tool's concurrency restrictions.",
    // On a PTC Turn the V2 templates replace the first anchor with this pointer to the
    // "Tool calls in this turn" section. Without it the file-reference rule and the
    // References section would silently disappear from PTC prompts.
    '- Tool selection for this turn is described in "Tool calls in this turn".',
  ];
  const toolAnchor = toolAnchors.find((anchor) => prompt.includes(anchor));
  if (!toolAnchor) return prompt;
  const fileReference = "- Reference code as `file_path:line_number` — it's clickable.";
  const migratedFileReference =
    '- Reference code as `file_path:line_number` so it is clickable. Place references near the relevant claim; group them only when there are many files.';
  const references = [
    '- Cite sources where they support the answer, using exact source URLs or supplied links.',
    '- Place references near the relevant claim; group them only when there are many files.',
    '- Cite only sources you used; do not invent sources or links.',
  ].join('\n');

  const legacyRules = [
    '- When referencing code, use `file_path:line_number` format.',
    '- When citing one or two files, place one or two `file_path:line_number` references in the relevant conclusion sentence. Use a separate evidence list only when there are many references.',
    fileReference,
    "- Reference code as `file_path:line_number` — it's clickable in the TUI.",
  ];
  const result = legacyRules
    .reduce(
      (text, rule) => text.replaceAll(`${rule}\r\n`, '').replaceAll(`${rule}\n`, ''),
      prompt.replace(
        migratedFileReference,
        '- Place references near the relevant claim; group them only when there are many files.',
      ),
    )
    .replace(toolAnchor, `${toolAnchor}\n${fileReference}`);
  if (result.includes(references)) return result;
  const communicationHeading = /^(#{1,2}) Communication & Delivery\r?$/m.exec(result);
  if (communicationHeading) {
    const level = communicationHeading[1]!;
    const start = communicationHeading.index + communicationHeading[0].length;
    // Optional feature sections must keep their opening Handlebars directive.
    const nextSection = new RegExp(`^(?:#{1,${level.length}} |\\{\\{[#/])`, 'm').exec(
      result.slice(start),
    );
    const end = nextSection ? start + nextSection.index : result.length;
    return `${result.slice(0, end).trimEnd()}\n\n${level}# References\n${references}\n\n${result.slice(end)}`;
  }
  const deliveryHeading = /^(#{2,4}) (?:Media Output|Deliverable Files)\r?$/m;
  if (deliveryHeading.test(result)) {
    return result.replace(
      deliveryHeading,
      (heading, level: string) => `${level} References\n${references}\n\n${heading}`,
    );
  }
  return `${result.trimEnd()}\n\n## References\n${references}`;
}
