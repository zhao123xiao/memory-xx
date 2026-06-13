import type { ProjectionDocumentSection, ProjectionFrontmatterMap } from "../types";
import { serializeFrontmatter } from "./frontmatter";

export interface MarkdownDocumentInput {
  readonly frontmatter: ProjectionFrontmatterMap;
  readonly title: string;
  readonly summary?: string;
  readonly sections?: readonly ProjectionDocumentSection[];
}

function normalizeBody(body: string | readonly string[]): string {
  if (typeof body === "string") {
    return body.trim();
  }

  return body.join("\n").trim();
}

export function renderMarkdownDocument(input: MarkdownDocumentInput): string {
  const blocks: string[] = [serializeFrontmatter(input.frontmatter), `# ${input.title.trim()}`];

  if (input.summary?.trim()) {
    blocks.push(input.summary.trim());
  }

  for (const section of input.sections ?? []) {
    const sectionBlocks: string[] = [];
    const headingLevel = section.level ?? 2;

    if (section.heading) {
      sectionBlocks.push(`${"#".repeat(headingLevel)} ${section.heading.trim()}`);
    }

    const body = normalizeBody(section.body);
    if (body) {
      sectionBlocks.push(body);
    }

    if (sectionBlocks.length > 0) {
      blocks.push(sectionBlocks.join("\n\n"));
    }
  }

  return `${blocks.join("\n\n").replace(/\r\n/g, "\n").trimEnd()}\n`;
}
