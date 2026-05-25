const MAX_HEADER_BYTES = 8 * 1024;
const MAX_MESSAGE_BYTES = 256 * 1024;

export function encodeMcpFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
    body,
  ]);
}

export class McpServerFrameReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  findHeaderBoundary() {
    const crlf = this.buffer.indexOf('\r\n\r\n');
    const lf = this.buffer.indexOf('\n\n');
    if (crlf === -1 && lf === -1) return null;
    if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { index: crlf, bytes: 4 };
    return { index: lf, bytes: 2 };
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const messages = [];
    while (this.buffer.length > 0) {
      const boundary = this.findHeaderBoundary();
      if (!boundary) {
        if (this.buffer.length > MAX_HEADER_BYTES) {
          throw new Error('MCP frame header exceeded maximum size.');
        }
        break;
      }

      const headerText = this.buffer.subarray(0, boundary.index).toString('utf8');
      const lengthLine = headerText.split(/\r?\n/).find((line) => /^content-length:/i.test(line));
      if (!lengthLine) throw new Error('MCP frame missing Content-Length header.');

      const length = Number.parseInt(lengthLine.split(':')[1], 10);
      if (!Number.isFinite(length) || length < 0) throw new Error('Invalid MCP Content-Length header.');
      if (length > MAX_MESSAGE_BYTES) throw new Error('MCP message exceeded maximum size.');

      const bodyStart = boundary.index + boundary.bytes;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) break;

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8');
      this.buffer = this.buffer.subarray(bodyEnd);
      messages.push(JSON.parse(body));
    }
    return messages;
  }
}
