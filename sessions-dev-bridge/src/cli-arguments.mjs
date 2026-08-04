import { resolve } from 'node:path';

export function parseArguments(args) {
  const remaining = [...args];
  const command = remaining.shift();
  if (command === 'enroll') {
    let deviceLabel = `${process.env.COMPUTERNAME || process.env.HOSTNAME || 'developer device'}`;
    let sawDeviceLabel = false;
    while (remaining.length) {
      const flag = remaining.shift();
      if (flag === '--device-label' && hasOptionValue(remaining) && !sawDeviceLabel) {
        sawDeviceLabel = true;
        deviceLabel = remaining.shift();
      } else throw usage();
    }
    return { command, deviceLabel };
  }
  if (command === 'pull') {
    let sessionId;
    let target;
    let checkout = process.cwd();
    let sawSession = false;
    let sawTarget = false;
    let sawCheckout = false;
    while (remaining.length) {
      const flag = remaining.shift();
      if (flag === '--session' && hasOptionValue(remaining) && !sawSession) {
        sawSession = true;
        sessionId = remaining.shift();
      } else if (flag === '--target' && hasOptionValue(remaining) && !sawTarget) {
        sawTarget = true;
        target = remaining.shift();
      } else if (flag === '--checkout' && hasOptionValue(remaining) && !sawCheckout) {
        sawCheckout = true;
        checkout = resolve(remaining.shift());
      } else throw usage();
    }
    if (!sessionId || !target) throw usage();
    return { command, sessionId, target, checkout };
  }
  throw usage();
}

function hasOptionValue(remaining) {
  return remaining.length > 0 && !remaining[0].startsWith('--');
}

function usage() {
  return new Error('usage: sessions-dev-bridge enroll [--device-label <label>] | sessions-dev-bridge pull --session <id> --target local|pr-<number> [--checkout <path>]');
}
