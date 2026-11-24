// 可预期的停止。调用方应原样展示 message，不要再包一层猜测。
export class Stop extends Error {
  constructor(message, code = 'STOP') {
    super(message);
    this.name = 'Stop';
    this.code = code;
  }
}

export class Invariant extends Stop {
  constructor(message) {
    super(message, 'INVARIANT');
    this.name = 'Invariant';
  }
}
