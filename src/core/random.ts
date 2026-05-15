import { randomBytes } from 'node:crypto';

export interface Random {
  sessionId(): string;
  requestId(): string;
}

export const systemRandom: Random = {
  sessionId: () => `s_${randomBytes(6).toString('hex')}`,
  requestId: () => `r_${randomBytes(8).toString('hex')}`,
};
