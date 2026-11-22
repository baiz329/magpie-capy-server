/**
 * minimal 变体按账号降级门控（H-13(1)）。
 *
 * 一个账号的 403 降级只记在该账号名下，不拖累其它账号。
 * configuredVariant 为 default/off 时全账号默认不发 minimal。
 */
export class MinimalVariantGate {
  private readonly unsupported = new Map<string, boolean>();

  constructor(private readonly disabledByDefault: boolean) {}

  isUnsupported(key: string): boolean {
    return this.unsupported.get(key) ?? this.disabledByDefault;
  }

  markUnsupported(key: string): void {
    this.unsupported.set(key, true);
  }
}
