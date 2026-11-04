import { open } from 'node:fs/promises';

/** Reverse-read newline-delimited records without loading the complete audit file. */
export async function* readJsonlNewestFirst<T>(path: string): AsyncGenerator<T> {
  let file: Awaited<ReturnType<typeof open>>;
  try { file = await open(path, 'r'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const { size } = await file.stat();
    let offset = size;
    let prefix = Buffer.alloc(0);
    while (offset > 0) {
      const length = Math.min(64 * 1024, offset);
      offset -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(chunk, 0, length, offset);
      if (bytesRead !== length) throw new Error('Short reverse audit read');
      const block = Buffer.concat([chunk, prefix]);
      let end = block.length;
      for (let i = block.length - 1; i >= 0; i--) {
        if (block[i] !== 10) continue;
        const line = block.subarray(i + 1, end);
        end = i;
        if (!line.length) continue;
        try { yield JSON.parse(line.toString('utf8')) as T; } catch {
          // A concurrent writer may leave an incomplete trailing line. Ignore it.
        }
      }
      prefix = block.subarray(0, end);
    }
    if (prefix.length) {
      try { yield JSON.parse(prefix.toString('utf8')) as T; } catch {}
    }
  } finally {
    await file.close();
  }
}
