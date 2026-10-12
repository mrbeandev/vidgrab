/**
 * Disk-backed output using the Origin Private File System. Nothing is held in memory
 * beyond the current chunk; the final File handle is disk-backed, so `URL.createObjectURL`
 * on it does not copy the data and chrome.downloads streams it from disk.
 */
const DIR = "vidgrab-jobs";

async function dir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

export class OutputFile {
  private writable: FileSystemWritableFileStream | null = null;
  private handle: FileSystemFileHandle | null = null;
  bytes = 0;

  constructor(readonly name: string) {}

  async open(): Promise<void> {
    const d = await dir();
    this.handle = await d.getFileHandle(this.name, { create: true });
    this.writable = await this.handle.createWritable({ keepExistingData: false });
    this.bytes = 0;
  }

  async write(chunk: Uint8Array | ArrayBuffer): Promise<void> {
    if (!this.writable) throw new Error("output not open");
    const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    // FileSystemWritableFileStream wants a plain ArrayBuffer-backed view
    const view = new Uint8Array(u8.buffer as ArrayBuffer, u8.byteOffset, u8.byteLength);
    await this.writable.write(view);
    this.bytes += u8.byteLength;
  }

  /** Overwrite bytes at an absolute position (used to patch the mdat size). Call only as the LAST write. */
  async writeAt(position: number, data: Uint8Array): Promise<void> {
    if (!this.writable) throw new Error("output not open");
    const view = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    await this.writable.write({ type: "write", position, data: view });
  }

  /** Re-open for append after a pause (writable streams can't be kept open indefinitely safely). */
  async reopenAppend(): Promise<void> {
    const d = await dir();
    this.handle = await d.getFileHandle(this.name, { create: true });
    const f = await this.handle.getFile();
    this.writable = await this.handle.createWritable({ keepExistingData: true });
    await this.writable.seek(f.size);
    this.bytes = f.size;
  }

  async close(): Promise<File> {
    if (this.writable) {
      await this.writable.close();
      this.writable = null;
    }
    if (!this.handle) throw new Error("output not open");
    return this.handle.getFile();
  }

  async abort(): Promise<void> {
    try {
      await this.writable?.abort();
    } catch {
      /* ignore */
    }
    this.writable = null;
    await this.remove();
  }

  async remove(): Promise<void> {
    try {
      const d = await dir();
      await d.removeEntry(this.name);
    } catch {
      /* ignore */
    }
    this.handle = null;
  }
}

export async function listTemp(): Promise<{ name: string; size: number }[]> {
  const out: { name: string; size: number }[] = [];
  try {
    const d = await dir();
    // @ts-expect-error – async iterator on FileSystemDirectoryHandle is not in older lib.dom
    for await (const [name, h] of d.entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (h.kind === "file") out.push({ name, size: (await (h as FileSystemFileHandle).getFile()).size });
    }
  } catch {
    /* empty */
  }
  return out;
}

export async function removeTemp(name: string): Promise<void> {
  try {
    await (await dir()).removeEntry(name);
  } catch {
    /* ignore */
  }
}

/** Remove everything from previous sessions (called once at offscreen start-up). */
export async function purgeAll(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(DIR, { recursive: true });
  } catch {
    /* nothing to purge */
  }
}
