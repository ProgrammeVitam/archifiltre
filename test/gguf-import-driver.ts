/**
 * Driver: verify custom .gguf import / listing / removal + custom-model resolution.
 * Creates a tiny fake GGUF, imports it into the real models dir, checks it's a first-class
 * model, then removes it (cleaning up after itself). Run: bun run test/gguf-import-driver.ts
 */
import { writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  importModel,
  removeModel,
  listCustomModels,
  isModelDownloaded,
  modelPath,
  isCustomModel,
} from '@extensions/ai-describe/local-llm.ts';

let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));

async function main() {
  const src = join(tmpdir(), 'gguf-import-driver-src.gguf');
  const badMagic = join(tmpdir(), 'gguf-import-driver-bad.gguf');
  const notGguf = join(tmpdir(), 'gguf-import-driver.txt');
  // A minimal valid-looking GGUF is just the ASCII magic "GGUF" + padding.
  await writeFile(src, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(2048)]));
  await writeFile(badMagic, Buffer.concat([Buffer.from('NOPE'), Buffer.alloc(64)]));
  await writeFile(notGguf, Buffer.from('hello'));

  let importedId: string | null = null;
  try {
    let threw = false;
    try {
      await importModel(notGguf);
    } catch {
      threw = true;
    }
    ok(threw, 'a non-.gguf file is rejected');

    threw = false;
    try {
      await importModel(badMagic);
    } catch {
      threw = true;
    }
    ok(threw, 'a .gguf with bad magic bytes is rejected');

    const r = await importModel(src);
    importedId = r.id;
    ok(isCustomModel(r.id), 'import returns a custom: id');
    ok(r.custom === true && r.downloaded === true, 'entry flagged custom + downloaded');
    ok(await isModelDownloaded(r.id), 'imported model reports downloaded');
    ok((await stat(modelPath(r.id))).isFile(), 'the file exists at modelPath()');

    const list = await listCustomModels();
    ok(list.some((m) => m.id === r.id), 'listCustomModels() includes the import');

    await removeModel(r.id);
    importedId = null;
    ok(!(await isModelDownloaded(r.id)), 'after removeModel → not downloaded');
    ok(!(await listCustomModels()).some((m) => m.id === r.id), 'after removeModel → not listed');
  } finally {
    if (importedId) await removeModel(importedId).catch(() => {});
    await rm(src, { force: true });
    await rm(badMagic, { force: true });
    await rm(notGguf, { force: true });
  }
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
