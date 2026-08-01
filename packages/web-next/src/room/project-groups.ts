export interface ProjectGroup<T> {
  project?: string;
  items: T[];
}

/** Groups stay name-addressable because Codor intentionally has no empty project records. */
export function groupByProject<T extends { project?: string }>(items: T[]): ProjectGroup<T>[] {
  const byProject = new Map<string | undefined, T[]>();
  for (const item of items) {
    const group = byProject.get(item.project) ?? [];
    group.push(item);
    byProject.set(item.project, group);
  }
  return [...byProject.entries()]
    .map(([project, grouped]) => ({ project, items: grouped }))
    .sort((left, right) => {
      if (left.project === undefined) return 1;
      if (right.project === undefined) return -1;
      return left.project.localeCompare(right.project);
    });
}
