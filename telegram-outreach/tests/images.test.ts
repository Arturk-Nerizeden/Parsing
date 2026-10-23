import { describe, expect, it } from 'vitest';
import { checkedPhoto } from '../src/images';

describe('attachment validation', () => {
  it('reads file signatures rather than trusting a JPEG/PNG name or MIME', async () => {
    const jpeg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], 'photo.txt', { type: 'text/plain' });
    expect((await checkedPhoto(jpeg)).type).toBe('image/jpeg');
    const fake = new File([new Uint8Array([0, 0, 0, 0])], 'photo.jpg', { type: 'image/jpeg' });
    await expect(checkedPhoto(fake)).rejects.toThrow(/JPEG или PNG/);
  });

  it('rejects empty and oversized attachments before creating a queue', async () => {
    await expect(checkedPhoto(new File([], 'empty.png', { type: 'image/png' }))).rejects.toThrow(/5 МБ/);
    await expect(checkedPhoto(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' }))).rejects.toThrow(/5 МБ/);
  });
});
