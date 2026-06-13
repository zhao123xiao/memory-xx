import { ProjectionView, type ProjectionSortableItem } from "../types";

type Comparator<TItem> = (left: TItem, right: TItem) => number;

function compareNullableNumber(left: number | undefined, right: number | undefined, direction: "asc" | "desc"): number {
  if (left === undefined && right === undefined) {
    return 0;
  }

  if (left === undefined) {
    return 1;
  }

  if (right === undefined) {
    return -1;
  }

  return direction === "asc" ? left - right : right - left;
}

function toTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function compareNullableDate(left: string | undefined, right: string | undefined, direction: "asc" | "desc"): number {
  return compareNullableNumber(toTimestamp(left), toTimestamp(right), direction);
}

function compareNullableString(left: string | undefined, right: string | undefined, direction: "asc" | "desc"): number {
  if (!left && !right) {
    return 0;
  }

  if (!left) {
    return 1;
  }

  if (!right) {
    return -1;
  }

  return direction === "asc" ? left.localeCompare(right) : right.localeCompare(left);
}

function compareStableId(left: ProjectionSortableItem, right: ProjectionSortableItem): number {
  return left.stableId.localeCompare(right.stableId);
}

function chainComparators<TItem>(...comparators: readonly Comparator<TItem>[]): Comparator<TItem> {
  return (left, right) => {
    for (const comparator of comparators) {
      const result = comparator(left, right);
      if (result !== 0) {
        return result;
      }
    }

    return 0;
  };
}

const VIEW_SORTERS: Readonly<Record<ProjectionView, Comparator<ProjectionSortableItem>>> = {
  [ProjectionView.Overview]: chainComparators(
    (left, right) => compareNullableNumber(left.weight, right.weight, "desc"),
    (left, right) => compareNullableDate(left.updatedAt, right.updatedAt, "desc"),
    compareStableId
  ),
  [ProjectionView.Decisions]: chainComparators(
    (left, right) => compareNullableDate(left.decisionDate, right.decisionDate, "desc"),
    compareStableId
  ),
  [ProjectionView.Projects]: chainComparators(
    (left, right) => compareNullableString(left.projectKey ?? left.title, right.projectKey ?? right.title, "asc"),
    (left, right) => compareNullableDate(left.updatedAt, right.updatedAt, "desc"),
    compareStableId
  ),
  [ProjectionView.Todos]: chainComparators(
    (left, right) => compareNullableNumber(left.statePriority, right.statePriority, "asc"),
    (left, right) => compareNullableDate(left.dueDate, right.dueDate, "asc"),
    (left, right) => compareNullableDate(left.updatedAt, right.updatedAt, "desc"),
    compareStableId
  ),
  [ProjectionView.Daily]: chainComparators(
    (left, right) => compareNullableDate(left.occurredAt, right.occurredAt, "asc"),
    compareStableId
  ),
  [ProjectionView.Governance]: chainComparators(
    (left, right) => compareNullableString(left.queue, right.queue, "asc"),
    (left, right) => compareNullableDate(left.submittedAt, right.submittedAt, "asc"),
    compareStableId
  ),
  [ProjectionView.Archive]: chainComparators(
    (left, right) => compareNullableString(left.archiveBucket, right.archiveBucket, "desc"),
    (left, right) => compareNullableDate(left.archivedAt, right.archivedAt, "desc"),
    compareStableId
  )
};

export function compareProjectionItems(view: ProjectionView, left: ProjectionSortableItem, right: ProjectionSortableItem): number {
  return VIEW_SORTERS[view](left, right);
}

export function sortProjectionItems<TItem extends ProjectionSortableItem>(
  view: ProjectionView,
  items: readonly TItem[]
): TItem[] {
  return [...items].sort((left, right) => compareProjectionItems(view, left, right));
}
