/**
 * The one property a screen could quietly lose: that the "New learning object" dialog actually
 * offers video, document, and audio alongside quiz and packaged-module — and that each posts to its
 * own publisher route rather than accidentally reusing another kind's. The API's own validation is
 * authoritative (tests/runtime-api/publisher-media.spec.ts); this pins what the UI wires up.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workspace = readFileSync(new URL('../src/learning-objects.tsx', import.meta.url).pathname, 'utf8');

describe('authoring video, document, and audio learning objects', () => {
  it('offers all three alongside quiz and packaged-module in the create dialog', () => {
    expect(workspace).toContain('<Tabs.Trigger value="video">Add a video</Tabs.Trigger>');
    expect(workspace).toContain('<Tabs.Trigger value="document">Add a document</Tabs.Trigger>');
    expect(workspace).toContain('<Tabs.Trigger value="audio">Add audio</Tabs.Trigger>');
    expect(workspace).toContain('<NewVideoForm repositories={repositories} onCreated={created} />');
    expect(workspace).toContain('<NewDocumentForm repositories={repositories} onCreated={created} />');
    expect(workspace).toContain('<NewAudioForm repositories={repositories} onCreated={created} />');
  });

  it('each form posts to its own kind\'s publisher route, not a shared or mismatched one', () => {
    expect(workspace).toContain("publisher<{ object_id: string }>('learning-objects/videos'");
    expect(workspace).toContain("publisher<{ object_id: string }>('learning-objects/documents/upload'");
    expect(workspace).toContain("publisher<{ object_id: string }>('learning-objects/audio'");
  });

  it('a YouTube video is embedded by id, never by an arbitrary URL', () => {
    expect(workspace).toContain("{ kind: 'youtube', video_id: videoId }");
    expect(workspace).not.toMatch(/kind:\s*'youtube'[^}]*url/);
  });

  it('refuses to submit a document form before a supported file is chosen', () => {
    expect(workspace).toContain("if (!file) return setError('Choose a PowerPoint or Word file first.')");
    expect(workspace).toContain("if (!sourceFormat) return setError('That file type is not supported");
  });
});
