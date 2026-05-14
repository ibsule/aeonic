export interface StorageProvider {
    /**
     * Write a file to storage.
     * @param key   Relative path / filename (e.g. "folder/image.jpg")
     * @param buffer File contents
     * @param mimeType MIME type (e.g. "image/jpeg")
     */
    write(key: string, buffer: Buffer, mimeType: string): Promise<void>
  
    /**
     * Read a file from storage. Returns null if the file does not exist.
     */
    read(key: string): Promise<Buffer | null>
  
    /**
     * Delete a file from storage. Silently succeeds if the file doesn't exist.
     */
    delete(key: string): Promise<void>
  
    /**
     * Check whether a file exists in storage.
     */
    exists(key: string): Promise<boolean>
  
    /**
     * Return the public URL to serve this file directly.
     * For local storage this is the /files/:key API route.
     * For S3 this is the CDN/bucket URL.
     */
    publicUrl(key: string): string
  }