import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const uuidsIn = (text: string) => {
  const uuids = new Set<string>()
  for (const line of text.split('\n')) {
    try {
      const row: unknown = JSON.parse(line)
      if (typeof row === 'object' && row !== null && 'uuid' in row && typeof row.uuid === 'string')
        uuids.add(row.uuid)
    } catch {}
  }
  return uuids
}

export const transcriptHolds = async (
  configDir: string,
  claudeSessionId: string,
  required: readonly string[],
) => {
  const projects = join(configDir, 'projects')
  const dirs = await readdir(projects).catch(() => [])
  for (const dir of dirs) {
    const text = await readFile(join(projects, dir, `${claudeSessionId}.jsonl`), 'utf8').catch(
      () => undefined,
    )
    if (text === undefined) continue
    const found = uuidsIn(text)
    return required.every((uuid) => found.has(uuid))
  }
  return false
}
