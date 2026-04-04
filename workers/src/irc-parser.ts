/**
 * IRC message parser and builder.
 * Mirrors plum's &'parse() and &'build() functions.
 */

export interface IrcMessage {
  tags?: Map<string, string>;
  prefix?: string;
  command: string;
  params: string[];
}

function assertSafeIrcField(value: string, fieldName: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`unsafe IRC ${fieldName}`);
  }
}

/**
 * Parse a raw IRC message line into structured form.
 * Supports IRCv3 message tags.
 */
export function parse(line: string): IrcMessage {
  let pos = 0;
  let tags: Map<string, string> | undefined;
  let prefix: string | undefined;

  // Strip trailing \r\n
  line = line.replace(/\r?\n$/, "");

  // Parse IRCv3 tags: @key=value;key2=value2
  if (line[pos] === "@") {
    const spaceIdx = line.indexOf(" ", pos);
    if (spaceIdx === -1) {
      return { command: "", params: [] };
    }
    const tagStr = line.substring(pos + 1, spaceIdx);
    tags = new Map();
    for (const part of tagStr.split(";")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) {
        tags.set(part, "");
      } else {
        tags.set(part.substring(0, eqIdx), part.substring(eqIdx + 1));
      }
    }
    pos = spaceIdx + 1;
    while (line[pos] === " ") pos++;
  }

  // Parse prefix: :nick!user@host
  if (line[pos] === ":") {
    const spaceIdx = line.indexOf(" ", pos);
    if (spaceIdx === -1) {
      return { tags, command: "", params: [] };
    }
    prefix = line.substring(pos + 1, spaceIdx);
    pos = spaceIdx + 1;
    while (line[pos] === " ") pos++;
  }

  // Parse command
  const rest = line.substring(pos);
  const parts = rest.split(" ");
  const command = parts[0].toUpperCase();
  const params: string[] = [];

  // Parse parameters
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].startsWith(":")) {
      // Trailing parameter — join remaining parts
      params.push(parts.slice(i).join(" ").substring(1));
      break;
    }
    if (parts[i] !== "") {
      params.push(parts[i]);
    }
  }

  return { tags, prefix, command, params };
}

/**
 * Build a raw IRC message string from structured form.
 */
export function build(msg: IrcMessage): string {
  const parts: string[] = [];

  if (msg.tags && msg.tags.size > 0) {
    const tagParts: string[] = [];
    for (const [k, v] of msg.tags) {
      assertSafeIrcField(k, "tag key");
      assertSafeIrcField(v, "tag value");
      tagParts.push(v ? `${k}=${v}` : k);
    }
    parts.push("@" + tagParts.join(";"));
  }

  if (msg.prefix) {
    assertSafeIrcField(msg.prefix, "prefix");
    parts.push(":" + msg.prefix);
  }

  assertSafeIrcField(msg.command, "command");
  parts.push(msg.command);

  for (let i = 0; i < msg.params.length; i++) {
    assertSafeIrcField(msg.params[i], "param");
    const isLast = i === msg.params.length - 1;
    if (isLast && (msg.params[i] === "" || msg.params[i].includes(" ") || msg.params[i].startsWith(":"))) {
      parts.push(":" + msg.params[i]);
    } else {
      parts.push(msg.params[i]);
    }
  }

  return parts.join(" ");
}

/**
 * Extract nickname from a prefix string (nick!user@host → nick).
 */
export function extractNick(prefix: string): string {
  const bangIdx = prefix.indexOf("!");
  return bangIdx === -1 ? prefix : prefix.substring(0, bangIdx);
}

/**
 * Check if a target is a channel name.
 */
export function isChannel(target: string): boolean {
  return target.startsWith("#") || target.startsWith("&") || target.startsWith("+") || target.startsWith("!");
}
