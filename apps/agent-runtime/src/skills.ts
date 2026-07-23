import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { schema } from '@hive/db';
import { db } from './db.js';

/**
 * Le skill vivono su database, ma il Claude Agent SDK le legge dal
 * filesystem (`.claude/skills/<nome>/SKILL.md`). Prima di ogni run le
 * scriviamo nella directory di lavoro dell'agente.
 *
 * Rigeneriamo la cartella da zero ogni volta: così una skill disattivata
 * o rinominata sparisce davvero, invece di restare come file orfano.
 */

/** Il frontmatter YAML richiede l'escaping delle stringhe su una riga. */
function yamlString(value: string): string {
  const oneLine = value.replace(/\r?\n/g, ' ').trim();
  return `"${oneLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export async function materializeSkills(agentId: string, workDir: string): Promise<number> {
  const skillsRoot = join(workDir, '.claude', 'skills');

  // Ripulire e ricreare evita skill fantasma dai run precedenti.
  await rm(skillsRoot, { recursive: true, force: true });

  const rows = await db
    .select()
    .from(schema.agentSkills)
    .where(and(eq(schema.agentSkills.agentId, agentId), eq(schema.agentSkills.enabled, true)));

  if (rows.length === 0) return 0;

  await mkdir(skillsRoot, { recursive: true });

  for (const skill of rows) {
    const dir = join(skillsRoot, skill.name);
    await mkdir(dir, { recursive: true });
    const content = [
      '---',
      `name: ${skill.name}`,
      `description: ${yamlString(skill.description)}`,
      '---',
      '',
      skill.body.trim(),
      '',
    ].join('\n');
    await writeFile(join(dir, 'SKILL.md'), content, 'utf8');
  }

  return rows.length;
}
