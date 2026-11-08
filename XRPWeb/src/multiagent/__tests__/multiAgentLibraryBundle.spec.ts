import { describe, expect, it } from 'vitest';
import {
  MULTI_AGENT_LIBRARY_FILES,
  MULTI_AGENT_LIBRARY_MANIFEST,
  programUsesTeamCommunication,
} from '../runtime/multiAgentLibraryBundle';

describe('optional native communication library bundle', () => {
  it('includes the Python adapter but never an architecture-specific binary', () => {
    const files = MULTI_AGENT_LIBRARY_FILES;
    expect(files.find((file) => file.path.endsWith('/native_codec.py'))?.content)
      .toContain('class NativeCodecBackend');
    expect(files.some((file) => file.path.endsWith('.mpy'))).toBe(false);
    expect(new Set(files.map((file) => file.path)).size).toBe(files.length);
  });

  it('keeps native loading explicit and installs a node with the optional backend', () => {
    const init = MULTI_AGENT_LIBRARY_FILES.find((file) => file.path.endsWith('/__init__.py'))!;
    const node = MULTI_AGENT_LIBRARY_FILES.find((file) => file.path.endsWith('/node.py'))!;
    expect(init.content).not.toContain('native_codec');
    expect(init.content).not.toContain('xrp_comm_native');
    expect(node.content).toContain('codec_backend=None');
    expect(MULTI_AGENT_LIBRARY_MANIFEST.path).toMatch(/\.xrp-bundle-[a-f0-9]{8}$/);
  });

  it('recognizes the explicit native example as a normal team program', () => {
    expect(programUsesTeamCommunication('from MultiAgentLib.native_codec import NativeCodecBackend')).toBe(true);
    expect(programUsesTeamCommunication('print("hello")')).toBe(false);
  });
});
