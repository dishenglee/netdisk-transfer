export {
  TransferService,
  type TransferServiceConfig,
  type TransferServiceOptions,
} from "./transfer-service.js";

export { ResourceTransferRunner } from "./resource-transfer-runner.js";

export type {
  ResourceTransferRecord,
  ResourceTransferUpdate,
  ResourceTransferRepository,
  NetdiskTransferResult,
  NetdiskTransferAdapter,
  ResourceTransferRunnerResult,
} from "./resource-transfer.types.js";

export { QuarkDriveApiClient } from "./quark/quark-drive-api-client.js";
export { QuarkTransferAdapter } from "./quark/quark-transfer.adapter.js";
export { resolveQuarkTransferSettings } from "./quark/quark-transfer-settings.js";

export { BaiduDriveApiClient } from "./baidu/baidu-drive-api-client.js";
export { BaiduTransferAdapter } from "./baidu/baidu-transfer.adapter.js";
export { resolveBaiduTransferSettings } from "./baidu/baidu-transfer-settings.js";

export { UcDriveApiClient } from "./uc/uc-drive-api-client.js";
export { UcTransferAdapter } from "./uc/uc-transfer.adapter.js";
export { resolveUcTransferSettings } from "./uc/uc-transfer-settings.js";

export { XunleiDriveApiClient } from "./xunlei/xunlei-drive-api-client.js";
export { XunleiTransferAdapter } from "./xunlei/xunlei-transfer.adapter.js";
export { resolveXunleiTransferSettings } from "./xunlei/xunlei-transfer-settings.js";

export { ExternalCommandNetdiskTransferAdapter } from "./external-command-netdisk-transfer.adapter.js";

export {
  validateNetdiskCookie,
  writeNetdiskCookieToEnv,
  getNetdiskCookieEnvKey,
  parseNetdiskCookiePlatform,
  getCookieNames,
  type NetdiskCookiePlatform,
  type NetdiskCookieValidationResult,
} from "./netdisk-cookie-manager.js";

export {
  loginQuarkByQrCode,
  type QuarkQrLoginOptions,
  type QuarkQrLoginResult,
} from "./quark/quark-qr-login.js";

export {
  loginBaiduByQrCode,
  type BaiduQrLoginOptions,
  type BaiduQrLoginResult,
} from "./baidu/baidu-qr-login.js";

export {
  loginUcByQrCode,
  type UcQrLoginOptions,
  type UcQrLoginResult,
} from "./uc/uc-qr-login.js";

export {
  loginXunleiByPassword,
  type XunleiPasswordLoginOptions,
  type XunleiPasswordLoginResult,
} from "./xunlei/xunlei-password-login.js";
