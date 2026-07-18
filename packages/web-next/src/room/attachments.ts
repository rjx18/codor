// Client half of message attachments (richard #425): upload a file to the room's
// authenticated endpoint before it rides the post frame, and build served URLs for
// rendering. Kept in web-next (not @legacy/api) so the whole feature is one batch.

export interface UploadedAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

/** Upload one file as a raw binary body; the server issues its id and metadata. */
export async function uploadAttachment(room: string, token: string, file: File): Promise<UploadedAttachment> {
  const res = await fetch(
    `/api/rooms/${encodeURIComponent(room)}/attachments?name=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': file.type || 'application/octet-stream' },
      body: file,
    },
  );
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `upload failed (${String(res.status)})`);
  }
  return res.json() as Promise<UploadedAttachment>;
}

/** Served URL for an attachment. The token rides the query string because an
 *  <img>/<a> cannot send an Authorization header (the server accepts either). */
export const attachmentUrl = (room: string, id: string, token: string): string =>
  `/api/rooms/${encodeURIComponent(room)}/attachments/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;

// Mirrors the server's inline-render set: raster images only. Scriptable image
// types (svg) are served as downloads, so rendering them as <img> would break.
export const isImageAttachment = (mime: string): boolean =>
  /^image\/(png|jpe?g|gif|webp|avif)$/.test(mime);

export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
