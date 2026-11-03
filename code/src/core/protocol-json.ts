export type ProtocolJson = null | boolean | number | string | ProtocolJson[] | { [key: string]: ProtocolJson };
/** 外部协议失败只给受控原因；JSON语法值再由调用方验证领域字段。 */
export function decodeJson(text: string): ProtocolJson {
  // SAFETY: 不传reviver的原生JSON.parse只产生JSON语法值；这里不声称它已经符合业务schema。
  try { return JSON.parse(text) as ProtocolJson; }
  catch { throw new Error('协议或配置不是合法JSON（未输出原文）'); }
}
