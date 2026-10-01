export interface StoredObject {
  key: string;
  size: number;
  /**
   * Trusted content checksum reported by the backend (S3 `x-amz-checksum-sha256` when the
   * upload carried one; the local driver hashes the stored file). Absent when the backend
   * cannot vouch for content, in which case callers must read the object back to verify.
   */
  sha256?: string;
}

export interface PutOptions {
  /** Hex SHA-256 of the file; sent as the upload checksum so the backend rejects corruption. */
  sha256?: string;
}

export interface ListedObject extends StoredObject {
  /** Epoch milliseconds; the only way to tell a current archive from an orphaned one. */
  lastModified: number;
}

export interface ObjectStore {
  readonly kind: "s3" | "local" | "none" | "proxy";
  put(key: string, filePath: string, options?: PutOptions): Promise<StoredObject>;
  get(key: string, destPath: string): Promise<void>;
  /** Size and, when the backend can vouch for it, the content checksum. */
  head(key: string): Promise<StoredObject | null>;
  /** Keys under a prefix, so a host can adopt an archive another host wrote. */
  list(prefix: string): Promise<ListedObject[]>;
  delete(key: string): Promise<void>;
}

export interface PackResult {
  sha256: string;
  size: number;
}
