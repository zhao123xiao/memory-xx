import { PROJECTION_FRONTMATTER_KEY_ORDER } from "../constants";
import type { ProjectionFrontmatterMap, ProjectionFrontmatterScalar, ProjectionFrontmatterValue } from "../types";

export interface FrontmatterSerializeOptions {
  readonly keyOrder?: readonly string[];
}

function isScalar(value: ProjectionFrontmatterValue): value is ProjectionFrontmatterScalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isFrontmatterMap(value: ProjectionFrontmatterValue): value is ProjectionFrontmatterMap {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializeScalar(value: ProjectionFrontmatterScalar): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value.length === 0) {
    return "''";
  }

  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "''")}'`;
}

function orderKeys(record: ProjectionFrontmatterMap, preferredOrder: readonly string[]): readonly string[] {
  const keys = Object.keys(record).filter((key) => record[key] !== undefined);
  const preferred = preferredOrder.filter((key) => keys.includes(key));
  const remainder = keys.filter((key) => !preferred.includes(key)).sort((left, right) => left.localeCompare(right));
  return [...preferred, ...remainder];
}

function renderYamlValue(value: ProjectionFrontmatterValue, indent: number): string[] {
  const padding = " ".repeat(indent);

  if (isScalar(value)) {
    return [serializeScalar(value)];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return ["[]"];
    }

    return value.flatMap((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return [`${padding}- ${serializeScalar(entry as ProjectionFrontmatterScalar)}`];
      }

      const childLines = renderYamlObject(entry, indent + 2);
      return [`${padding}- ${childLines[0]}`, ...childLines.slice(1)];
    });
  }

  if (isFrontmatterMap(value)) {
    return renderYamlObject(value, indent);
  }

  return ["[]"];
}

function renderYamlObject(value: ProjectionFrontmatterMap, indent: number): string[] {
  const padding = " ".repeat(indent);
  const orderedKeys = orderKeys(value, []);

  return orderedKeys.flatMap((key) => {
    const entry = value[key];

    if (entry === undefined) {
      return [];
    }

    const renderedValue = renderYamlValue(entry, indent + 2);
    if (renderedValue.length === 1 && !renderedValue[0].startsWith(`${" ".repeat(indent + 2)}- `)) {
      return [`${padding}${key}: ${renderedValue[0]}`];
    }

    return [`${padding}${key}:`, ...renderedValue];
  });
}

export function serializeFrontmatter(
  frontmatter: ProjectionFrontmatterMap,
  options: FrontmatterSerializeOptions = {}
): string {
  const orderedKeys = orderKeys(frontmatter, options.keyOrder ?? PROJECTION_FRONTMATTER_KEY_ORDER);
  const lines = orderedKeys.flatMap((key) => {
    const value = frontmatter[key];

    if (value === undefined) {
      return [];
    }

    const renderedValue = renderYamlValue(value, 2);
    if (renderedValue.length === 1 && !renderedValue[0].startsWith("  - ")) {
      return [`${key}: ${renderedValue[0]}`];
    }

    return [`${key}:`, ...renderedValue];
  });

  return ["---", ...lines, "---"].join("\n");
}
