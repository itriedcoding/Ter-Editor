import AdmZip from 'adm-zip';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OPEN_VSX = 'https://open-vsx.org/api';

export interface VsixManifest {
  name?: string;
  displayName?: string;
  publisher?: string;
  version?: string;
  description?: string;
  main?: string;
  activationEvents?: string[];
  contributes?: unknown;
}

export interface InstalledVsix {
  id: string;
  publisher: string;
  name: string;
  version: string;
  path: string;
  manifest: VsixManifest;
}

interface OpenVsxMetadata {
  version?: string;
  files?: { download?: string };
}

/**
 * Downloads an extension from Open VSX, verifies its manifest and installs it
 * into `extensionsRoot/<publisher>.<name>`. Existing versions are replaced
 * atomically so a failed install never leaves a broken directory behind.
 */
export async function installFromOpenVsx(rawId: string, extensionsRoot: string): Promise<InstalledVsix> {
  const dot = rawId.lastIndexOf('.');
  if (dot <= 0) throw new Error(`Extension id "${rawId}" must look like publisher.name`);
  const publisher = rawId.slice(0, dot);
  const name = rawId.slice(dot + 1);

  const metaResponse = await fetch(`${OPEN_VSX}/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!metaResponse.ok) {
    throw new Error(`Open VSX has no extension ${publisher}.${name} (${metaResponse.status})`);
  }
  const metadata = (await metaResponse.json()) as OpenVsxMetadata;
  const downloadUrl = metadata.files?.download;
  if (!downloadUrl) throw new Error(`Open VSX returned no download URL for ${publisher}.${name}`);

  const vsixResponse = await fetch(downloadUrl, { redirect: 'follow' });
  if (!vsixResponse.ok) throw new Error(`Downloading the .vsix failed with ${vsixResponse.status}`);
  const buffer = Buffer.from(await vsixResponse.arrayBuffer());

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ter-ext-'));
  try {
    const vsixPath = path.join(tempDir, 'extension.vsix');
    await fsp.writeFile(vsixPath, buffer);
    const unpacked = path.join(tempDir, 'unpacked');
    new AdmZip(vsixPath).extractAllTo(unpacked, true);

    const extensionRoot = path.join(unpacked, 'extension');
    const manifest = JSON.parse(await fsp.readFile(path.join(extensionRoot, 'package.json'), 'utf8')) as VsixManifest;
    if (!manifest.name || !manifest.publisher || !manifest.version) {
      throw new Error('The .vsix manifest is missing publisher, name or version');
    }

    const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
    const target = path.join(extensionsRoot, id);
    const staging = `${target}.installing-${Date.now()}`;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.cp(extensionRoot, staging, { recursive: true });
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.rename(staging, target);

    return {
      id,
      publisher: manifest.publisher,
      name: manifest.name,
      version: manifest.version,
      path: target,
      manifest,
    };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}
