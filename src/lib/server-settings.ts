// Static-ish ABS server settings shape. Most fields are unused server-config
// concepts (file watcher, scanner, backup paths) that don't apply to a
// serverless shim — we return values that make clients render correctly
// without enabling features the shim doesn't have.

export const SERVER_VERSION = '2.34.0';

export function serverSettings() {
  return {
    id: 'server-settings',
    scannerFindCovers: false,
    scannerCoverProvider: 'google',
    scannerParseSubtitle: false,
    scannerPreferMatchedMetadata: false,
    scannerDisableWatcher: false,
    storeCoverWithItem: false,
    storeMetadataWithItem: false,
    metadataFileFormat: 'json',
    rateLimitLoginRequests: 10,
    rateLimitLoginWindow: 600000,
    allowIframe: false,
    backupPath: '/metadata/backups',
    backupSchedule: false,
    backupsToKeep: 2,
    maxBackupSize: 1,
    loggerDailyLogsToKeep: 7,
    loggerScannerLogsToKeep: 2,
    homeBookshelfView: 1,
    bookshelfView: 1,
    podcastEpisodeSchedule: '0 * * * *',
    sortingIgnorePrefix: false,
    sortingPrefixes: ['the', 'a'],
    chromecastEnabled: false,
    dateFormat: 'MM/dd/yyyy',
    timeFormat: 'HH:mm',
    language: 'en-us',
    allowedOrigins: [] as string[],
    logLevel: 2,
    version: SERVER_VERSION,
    buildNumber: 1,
    authLoginCustomMessage: null,
    authActiveAuthMethods: ['local'],
    authOpenIDIssuerURL: null,
    authOpenIDAuthorizationURL: null,
    authOpenIDTokenURL: null,
    authOpenIDUserInfoURL: null,
    authOpenIDJwksURL: null,
    authOpenIDLogoutURL: null,
    authOpenIDTokenSigningAlgorithm: 'RS256',
    authOpenIDButtonText: 'Login with OpenId',
    authOpenIDAutoLaunch: false,
    authOpenIDAutoRegister: false,
    authOpenIDMatchExistingBy: null,
  };
}
