// Claude Code 트랜스크립트(.jsonl)에서 토큰 사용량만 증분으로 읽는다.
// 훅 입력에는 토큰 정보가 없기 때문에 transcript_path 를 따라가야 한다.
// 대화 내용은 저장하지 않고 message.usage 숫자만 합산한다.
import fs from 'node:fs';
import path from 'node:path';

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// 훅 페이로드가 임의의 파일을 읽게 만들 수 없도록 ~/.claude 아래 .jsonl 만 허용
export function isAllowedTranscript(file, claudeDir) {
  if (typeof file !== 'string' || !file.endsWith('.jsonl')) return false;
  const rf = real(file);
  const rd = real(claudeDir);
  if (!rf || !rd) return false;
  return norm(rf).startsWith(norm(rd) + path.sep);
}

const EMPTY = () => ({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0, messages: 0, total: 0 });

export class TokenTracker {
  constructor(claudeDir) {
    this.dir = claudeDir;
    this.sessions = new Map();
  }

  forget(sessionId) {
    this.sessions.delete(sessionId);
  }

  update(sessionId, file) {
    if (!isAllowedTranscript(file, this.dir)) return this.totals(sessionId);
    let st = this.sessions.get(sessionId);
    if (!st || st.file !== file) {
      st = { file, offset: 0, carry: Buffer.alloc(0), byId: new Map() };
      this.sessions.set(sessionId, st);
    }
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return this.totals(sessionId);
    }
    if (size < st.offset) {
      st.offset = 0;
      st.carry = Buffer.alloc(0);
      st.byId.clear();
    }
    if (size === st.offset) return this.totals(sessionId);

    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const CHUNK = 4 * 1024 * 1024;
      while (st.offset < size) {
        const len = Math.min(CHUNK, size - st.offset);
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, st.offset);
        if (n <= 0) break;
        st.offset += n;
        this.#consume(st, Buffer.concat([st.carry, buf.subarray(0, n)]));
      }
    } catch {
      // 읽기 실패는 조용히 무시 (다음 이벤트에서 다시 시도)
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return this.totals(sessionId);
  }

  #consume(st, data) {
    const lastNl = data.lastIndexOf(0x0a);
    if (lastNl === -1) {
      st.carry = data;
      return;
    }
    const complete = data.subarray(0, lastNl).toString('utf8');
    st.carry = Buffer.from(data.subarray(lastNl + 1));
    for (const line of complete.split('\n')) {
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj?.type !== 'assistant') continue;
      const usage = obj.message?.usage;
      if (!usage) continue;
      // 같은 응답이 스트리밍 도중 여러 줄로 기록되므로 id 별 최대 output 만 유지
      const id = obj.message.id || obj.requestId || obj.uuid;
      if (!id) continue;
      const prev = st.byId.get(id);
      if (!prev || (usage.output_tokens || 0) >= (prev.output_tokens || 0)) {
        st.byId.set(id, {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
          cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        });
      }
    }
  }

  totals(sessionId) {
    const t = EMPTY();
    const st = this.sessions.get(sessionId);
    if (!st) return t;
    for (const u of st.byId.values()) {
      t.input += u.input_tokens;
      t.output += u.output_tokens;
      t.cacheCreate += u.cache_creation_input_tokens;
      t.cacheRead += u.cache_read_input_tokens;
      t.messages++;
    }
    // total = 새로 처리된 토큰(캐시 읽기는 제외)
    t.total = t.input + t.output + t.cacheCreate;
    return t;
  }

  sum(sessionIds) {
    const t = EMPTY();
    for (const id of sessionIds) {
      const x = this.totals(id);
      for (const k of Object.keys(t)) t[k] += x[k];
    }
    return t;
  }
}
