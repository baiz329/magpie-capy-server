import type { LogFields, LoggerPort } from "../../ports/platform.ts";
import { redact, redactFields } from "../../observability/redact.ts";

export class ConsoleLogger implements LoggerPort {
  private readonly prefix: string;

  constructor(prefix = "capy") {
    this.prefix = prefix;
  }

  event(name: string, fields?: LogFields): void {
    this.write("info", name, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  private write(level: "info" | "warn", message: string, fields?: LogFields): void {
    const payload = {
      level,
      at: new Date().toISOString(),
      plugin: this.prefix,
      event: redact(message),
      ...(fields ? redactFields(fields) : {}),
    };
    try {
      console.error(JSON.stringify(payload));
    } catch {
      // 日志不能影响请求。
    }
  }
}
