/**
 * 服务版本号。
 *
 * 单独放一个文件，避免 admin.ts 与 app.ts 互相 import 造成循环依赖。
 * 0.2.0：新增观测层 + 管理 API + Web 控制台。
 */
export const SERVER_VERSION = '0.2.0'
