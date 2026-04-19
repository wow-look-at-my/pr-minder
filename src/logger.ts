export class Logger {
  private lines: string[] = [];
  log(msg: string): void {
    this.lines.push(msg);
    console.log(msg);
  }
  toString(): string {
    return this.lines.join('\n');
  }
}
