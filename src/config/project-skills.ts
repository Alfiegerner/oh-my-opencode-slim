import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter } from '../utils/frontmatter';

/**
 * Discover valid OpenCode skills that belong to the current project.
 *
 * This intentionally mirrors only the project-local `.opencode/skills`
 * portion of OpenCode's broader skill discovery. Global skills, external
 * compatibility directories, configured extra paths, and URL sources are
 * outside this helper's scope.
 */
export function discoverProjectLocalSkillNames(
  projectDirectory: string,
): string[] {
  const root = path.join(projectDirectory, '.opencode', 'skills');
  const names = new Set<string>();

  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'SKILL.md') {
        continue;
      }

      try {
        const content = fs.readFileSync(entryPath, 'utf-8').replace(/^\uFEFF/, '');
        const name = parseFrontmatter(content).attributes.name?.trim();
        if (name) {
          names.add(name);
        }
      } catch {
        // OpenCode ignores unusable skill files during discovery; keep this
        // opt-in helper non-fatal for unreadable or malformed local files.
      }
    }
  };

  visit(root);
  return [...names].sort((left, right) => left.localeCompare(right));
}
