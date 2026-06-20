export class Logger {
  private lines: string[] = [];
  log(msg: string): void {
    this.lines.push(msg);
    console.log(msg);
  }
  // Error-level: lands in Workers Logs as an error event (filterable, alertable) instead of
  // blending into the info stream. Use for failures someone should act on, not skips.
  error(msg: string): void {
    this.lines.push(`ERROR: ${msg}`);
    console.error(msg);
  }
  toString(): string {
    return this.lines.join('\n');
  }
}
