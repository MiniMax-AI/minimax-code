/**
 * 平台业务拒绝的客户端错误码。后端直接把这些码写进响应的 `errorCode`，界面和文案按码处理。
 * 这些不是模型错误，不放进 `LLM_ERROR_CODES`。
 */

/** 用户被后台限制发消息（只禁发消息，非整号封禁）。不可重试。 */
export const USER_SEND_RESTRICTED_ERROR_CODE = 40320;
