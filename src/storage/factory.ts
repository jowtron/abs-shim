import type { Env } from '../types';
import type { StorageAdapter } from './adapter';
import { PublicUrlAdapter } from './public-url';
import { PcloudOAuthAdapter, type PcloudConfig, type PcloudProfile } from './pcloud';
import { S3Adapter, type S3Config } from './s3';
import { WebDAVAdapter, type WebDAVConfig } from './webdav';

// Build the right adapter for a given library_folders row. Caller passes
// the row directly (already loaded for routing); we fetch the oauth_profile
// only when the provider needs one.
//
// Config-loading rules:
//   - 'public_url' provider: prefer config_json.baseUrl, fall back to the
//     legacy filedn_base_url column for back-compat with the seed.
//   - 'pcloud_oauth': config_json.rootPath plus profile_id pointing at an
//     oauth_profiles row.

export type FolderRow = {
  id: string;
  library_id: string;
  filedn_base_url: string;       // legacy
  added_at: number;
  provider: string;
  config_json: string;
  profile_id: string | null;
};

export type OAuthProfileRow = {
  id: string;
  provider: string;
  access_token: string;
  refresh_token: string | null;
  api_host: string | null;
  account_label: string | null;
  scope: string | null;
  created_at: number;
  last_verified_at: number | null;
};

// `originUrl` is needed by adapters that mint URLs pointing back at this
// Worker (WebDAV proxy). It defaults to the configured workers.dev origin
// when called outside a request — for routes that have a request, prefer
// passing `c.req.url` so dev/Tailscale environments work too.
export async function getAdapter(
  env: Env,
  folder: FolderRow,
  originUrl?: string,
): Promise<StorageAdapter> {
  const config = parseConfig(folder.config_json);

  switch (folder.provider) {
    case 'public_url': {
      const baseUrl = (config['baseUrl'] as string | undefined) ?? folder.filedn_base_url;
      if (!baseUrl) throw new Error(`Folder ${folder.id} has no baseUrl configured`);
      return new PublicUrlAdapter({ baseUrl });
    }
    case 'pcloud_oauth': {
      if (!folder.profile_id) {
        throw new Error(`Folder ${folder.id} declares pcloud_oauth but has no profile_id`);
      }
      const profileRow = await env.DB.prepare(
        'SELECT * FROM oauth_profiles WHERE id = ?',
      ).bind(folder.profile_id).first<OAuthProfileRow>();
      if (!profileRow) {
        throw new Error(`Folder ${folder.id} references missing oauth_profile ${folder.profile_id}`);
      }
      const apiHost = profileRow.api_host ?? 'api.pcloud.com';
      const profile: PcloudProfile = { accessToken: profileRow.access_token, apiHost };
      const pcloudConfig: PcloudConfig = {
        rootPath: (config['rootPath'] as string | undefined) ?? '/',
      };
      return new PcloudOAuthAdapter(profile, pcloudConfig);
    }
    case 's3': {
      const s3Config: S3Config = {
        endpoint: String(config['endpoint'] ?? ''),
        bucket: String(config['bucket'] ?? ''),
        region: String(config['region'] ?? 'auto'),
        prefix: String(config['prefix'] ?? ''),
      };
      const accessKeyId = String(config['accessKeyId'] ?? '');
      const secretAccessKey = String(config['secretAccessKey'] ?? '');
      if (!s3Config.endpoint || !s3Config.bucket || !accessKeyId || !secretAccessKey) {
        throw new Error(`S3 folder ${folder.id} missing endpoint/bucket/accessKeyId/secretAccessKey`);
      }
      return new S3Adapter(s3Config, { accessKeyId, secretAccessKey, region: s3Config.region });
    }
    case 'webdav': {
      const davConfig: WebDAVConfig = {
        baseUrl: String(config['baseUrl'] ?? ''),
        username: String(config['username'] ?? ''),
        password: String(config['password'] ?? ''),
        rootPath: String(config['rootPath'] ?? ''),
      };
      if (!davConfig.baseUrl) {
        throw new Error(`WebDAV folder ${folder.id} missing baseUrl`);
      }
      // Fallback origin when this is invoked outside a request context (e.g.
      // a scheduled scan). In production we always have a request URL, so
      // the fallback is best-effort — proxy URLs minted with it would only
      // resolve if the worker is actually deployed at this hostname.
      const origin = originUrl ? new URL(originUrl).origin : (env.PUBLIC_ORIGIN ?? 'https://example.workers.dev');
      return new WebDAVAdapter(env, folder.id, origin, davConfig);
    }
    default:
      throw new Error(`Unknown storage provider: ${folder.provider}`);
  }
}

function parseConfig(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}
