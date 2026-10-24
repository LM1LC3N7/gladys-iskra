// -----------------------------------------------------------------------------
// The state kept in /data (the only writable place of the container): the
// guards of the consumption indexes, the meters seen and their features, the
// pause after a 429/5xx, the refused login (8 bits of a salted hash, never
// the password) and the time of the last read, so that a restart never
// forgets a jump the user has not accepted nor reads too soon. A small JSON
// file, written through a temporary file and a rename, one save after the
// other. Failures are logged, never fatal. Taken from gladys-energieleser /
// gladys-zeversolar (approved).
// -----------------------------------------------------------------------------

import { readFileSync, statSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';

export const DEFAULT_STATE_FILE = '/data/iskra-state.json';
/** A larger file is not ours: ignored (read bounded). */
const MAX_STATE_BYTES = 256 * 1024;

export function createFileStore(file = DEFAULT_STATE_FILE) {
  /** The saves one after the other: two never share the temporary file. */
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, file);
  };
  return {
    load() {
      try {
        if (statSync(file).size > MAX_STATE_BYTES) {
          return {};
        }
        const data = JSON.parse(readFileSync(file, 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      } catch {
        return {};
      }
    },
    save(data) {
      const job = queue.then(
        () => write(data),
        () => write(data),
      );
      queue = job.catch(() => {});
      return job;
    },
  };
}

/** The same in memory (tests). */
export function createMemoryStore(initial = {}) {
  let data = structuredClone(initial);
  return {
    load: () => structuredClone(data),
    async save(next) {
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
  };
}
