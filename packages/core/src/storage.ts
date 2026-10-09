import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 附件文件的存取。先实现本地卷（FLOWER_STORAGE_DIR）；S3 兼容存储以后按同一接口实现。 */
export type FileStorage = { put(key: string, bytes: Uint8Array): Promise<void>; get(key: string): Promise<Uint8Array | null> };

/** 键固定为 `{orgId}/{attachmentId}.{ext}`，校验后再拼路径，杜绝 `..` 之类的路径穿越。 */
const KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;

export function createLocalStorage(dir: string): FileStorage {
  const file = (key: string) => {
    if (!KEY.test(key)) throw new Error(`非法的存储键：${key}`);
    return path.join(dir, key);
  };
  return {
    async put(key, bytes) {
      const p = file(key);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, bytes);
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(file(key)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
  };
}
